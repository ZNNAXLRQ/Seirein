/**
 * P-127 P0: a failed `session_search` is a failure, never a history hit.
 *
 * The wrapper projects `isError:true` (and a rejected search body) as
 * `queried:false / reason:'error' / evidenceType:'none'`, keeps the error text as error
 * information only (no `hits`), and a same-condition repeat says the last query failed instead
 * of reusing it as `evidenceType:history`.
 *
 * Run: node --test test/session-search-error.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cleanupRoot } from './helpers/cleanup.mjs';
import {
  runSessionSearch,
  sessionSearchFailureResult,
  toolFailureInfo,
  toolResultText,
} from '../src/host/session/delivery/dispatch.js';
import { apply } from '../src/host/index.js';

/** Mount the real plugin against a fake context and capture every listener it registers. */
function mount(root, config = {}) {
  const tools = new Map();
  const disposers = [];
  const listeners = new Map();
  const effect = (fn) => {
    const value = fn();
    if (typeof value === 'function') disposers.push(value);
    return value;
  };
  const ctx = {
    effect,
    on(name, handler) {
      const list = listeners.get(name) ?? [];
      list.push(handler);
      listeners.set(name, list);
      return () => {
        const index = list.indexOf(handler);
        if (index >= 0) list.splice(index, 1);
      };
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    inject: (_deps, register) => {
      register({
        effect,
        systemPrompt: { section: () => () => {} },
        webServer: { register: () => () => {} },
      });
    },
  };
  apply(ctx, { root, enabled: true, ...config });
  return {
    listeners,
    tools,
    disposers,
    sessionSearchBudget: () => {
      const list = listeners.get('tools/execute') ?? [];
      assert.equal(list.length, 1, 'exactly one tools/execute wrapper');
      return list[0];
    },
  };
}

const settle = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

/** An in-scope `session_search` exec; `events` feeds the session's own log for turn identity. */
function execFor(cwd, {
  signal = new AbortController().signal,
  arguments: args = { query: 'storage' },
  id = 's-session-search-error',
  events = [],
} = {}) {
  return {
    name: 'session_search',
    arguments: args,
    signal,
    agent: { session: { id, header: { cwd }, ownEvents: () => events } },
  };
}

async function readEvents(root) {
  const text = await readFile(join(root, 'data', 'events.jsonl'), 'utf8').catch(() => '');
  if (text.trim().length === 0) return [];
  return text.trim().split('\n')
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((row) => row !== null);
}

async function waitForEvent(root, type, ms = 500) {
  const deadline = Date.now() + ms;
  for (;;) {
    const hit = (await readEvents(root)).find((row) => row.type === type);
    if (hit !== undefined) return hit;
    if (Date.now() >= deadline) return null;
    await settle(10);
  }
}

async function eventsOf(root, type) {
  return (await readEvents(root)).filter((row) => row.type === type);
}

// ---------------------------------------------------------------------------
// 1. The adapter turns a rejected search body into a failure result + event
// ---------------------------------------------------------------------------

test('1. a rejected search body is a failure result, not a thrown error or a hit', async () => {
  const emitted = [];
  const log = { emit(type, payload) { emitted.push({ type, payload }); } };
  const error = Object.assign(new Error('session history storage is unavailable'), {
    name: 'SessionQueryError',
    code: 'SESSION_QUERY_PERSISTENCE_FAILED',
  });
  const result = await runSessionSearch({
    budgetMs: 2_000,
    query: 'OBS 场景 浏览器',
    log,
    search: async () => { throw error; },
  });

  assert.equal(result.ok, false);
  assert.equal(result.queried, false, 'a failed query did not complete');
  assert.equal(result.reason, 'error');
  assert.equal(result.evidenceType, 'none', 'a failure is never history evidence');
  assert.deepEqual(result.hits, [], 'the failure is not projected into a hit');
  assert.equal(result.errorName, 'SessionQueryError');
  assert.equal(result.errorCode, 'SESSION_QUERY_PERSISTENCE_FAILED');
  assert.match(result.error, /session history storage is unavailable/u, 'the error text is kept');
  assert.match(result.notice, /失败不能当作「没有记录」/u);
  assert.deepEqual(emitted, [{
    type: 'session_search.error',
    payload: { name: 'SessionQueryError', code: 'SESSION_QUERY_PERSISTENCE_FAILED' },
  }], 'the error event names only name/code');
  console.log(`[1] queried=${result.queried} reason=${result.reason} evidenceType=${result.evidenceType} hits=${result.hits.length} name=${result.errorName}`);
});

// ---------------------------------------------------------------------------
// 2. An `isError:true` tool result is annotated as a failure, never as a hit
// ---------------------------------------------------------------------------

test('2. an isError result is projected as reason error and keeps its error text', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-search-error-iserror-'));
  const app = mount(root);
  t.after(() => cleanupRoot(root, app.disposers));

  const original = {
    isError: true,
    errorName: 'SessionQueryError',
    errorCode: 'SESSION_QUERY_PERSISTENCE_FAILED',
    value: 'Error: session history storage is unavailable',
    content: [{ type: 'text', text: 'Error: session history storage is unavailable' }],
  };
  const exec = execFor(join(root, 'workspace'), { arguments: { query: 'OBS 场景 浏览器' } });
  const outcome = await app.sessionSearchBudget()(exec, async () => original);

  assert.notEqual(outcome, original, 'the error result is not returned by identity');
  assert.match(outcome.value, /^session_search failed=true/u);
  assert.match(outcome.value, /queried=false/u);
  assert.match(outcome.value, /reason=error/u);
  assert.match(outcome.value, /evidenceType=none/u);
  assert.match(outcome.value, /name=SessionQueryError/u);
  assert.match(outcome.value, /code=SESSION_QUERY_PERSISTENCE_FAILED/u);
  assert.match(outcome.value, /session history storage is unavailable/u, 'the error text survives');
  assert.match(outcome.value, /失败不能当作「没有记录」/u);
  assert.doesNotMatch(outcome.value, /evidenceType=history/u, 'a failure is never labelled history');
  assert.doesNotMatch(outcome.value, /Session search results/u, 'no fake hit text is invented');
  assert.equal(exec.signal.aborted, false, 'the caller signal is restored');

  const event = await waitForEvent(root, 'session_search.error');
  assert.notEqual(event, null, 'session_search.error is logged');
  assert.deepEqual(event.payload, {
    name: 'SessionQueryError',
    code: 'SESSION_QUERY_PERSISTENCE_FAILED',
    scope: 'assistant',
  });
  console.log(`[2] head=${outcome.value.split('\n')[0]} event=${event.payload.name}/${event.payload.code}`);
});

// ---------------------------------------------------------------------------
// 3. A same-condition repeat of a failure says the last query failed
// ---------------------------------------------------------------------------

test('3. a same-condition repeat of a failure never reads as history', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-search-error-reuse-'));
  const app = mount(root);
  t.after(() => cleanupRoot(root, app.disposers));

  const events = [{ data: { turn: 21 } }];
  const error = {
    isError: true,
    value: 'Error: session history storage is unavailable',
    content: [],
  };
  let nextCalls = 0;
  const body = async () => {
    nextCalls += 1;
    return error;
  };
  const exec = execFor(join(root, 'workspace'), {
    arguments: { query: 'OBS 场景 浏览器' },
    events,
  });

  const first = await app.sessionSearchBudget()(exec, body);
  assert.match(first.value, /failed=true/u);
  const second = await app.sessionSearchBudget()(exec, body);
  assert.equal(nextCalls, 1, 'the failed condition is not fired again');
  assert.match(second.value, /^session_search evidence: queried=false, reason=error, evidenceType=none, count=2$/mu);
  assert.match(second.value, /上次查询失败（reason=error）/u);
  assert.match(second.value, /本轮未重试/u);
  assert.match(second.value, /session history storage is unavailable/u, 'the cached error text is kept');
  assert.doesNotMatch(second.value, /evidenceType=history/u, 'a reused failure is never history');
  assert.doesNotMatch(second.value, /复用上次结果/u, 'the old generic reuse wording is gone for failures');

  await settle();
  const dedup = await eventsOf(root, 'session_search.dedup');
  assert.equal(dedup.length, 1, 'the repeat is still a dedup observation');
  assert.equal(dedup[0].payload.count, 2);
  console.log(`[3] nextCalls=${nextCalls} head=${second.value.split('\n')[0]}`);
});

// ---------------------------------------------------------------------------
// 4. A rejecting body never escapes the wrapper as a throw
// ---------------------------------------------------------------------------

test('4. a rejecting body returns a failure result instead of throwing', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-search-error-reject-'));
  const app = mount(root);
  t.after(() => cleanupRoot(root, app.disposers));

  const exec = execFor(join(root, 'workspace'), { arguments: { query: 'storage down' } });
  const error = Object.assign(new Error('session history storage is unavailable'), {
    name: 'SessionQueryError',
    code: 'SESSION_QUERY_PERSISTENCE_FAILED',
  });
  let calls = 0;
  const outcome = await app.sessionSearchBudget()(exec, async () => {
    calls += 1;
    throw error;
  });

  assert.equal(calls, 1);
  assert.equal(outcome.isError, undefined, 'the wrapper does not rethrow the tool failure');
  assert.match(outcome.value, /failed=true/u);
  assert.match(outcome.value, /reason=error/u);
  assert.match(outcome.value, /session history storage is unavailable/u);
  const event = await waitForEvent(root, 'session_search.error');
  assert.deepEqual(event.payload, {
    name: 'SessionQueryError',
    code: 'SESSION_QUERY_PERSISTENCE_FAILED',
    scope: 'assistant',
  });
  console.log(`[4] calls=${calls} head=${outcome.value.split('\n')[0]}`);
});

// ---------------------------------------------------------------------------
// 5. The failure projection is tool-agnostic and accepts content-only text
// ---------------------------------------------------------------------------

test('5. toolFailureInfo/toolResultText accept a generic isError result', () => {
  const result = {
    isError: true,
    errorName: 'SubagentError',
    errorCode: 'SUBAGENT_FAILED',
    content: [{ type: 'text', text: 'subagent run failed: storage unavailable' }],
  };
  assert.equal(toolResultText(result), 'subagent run failed: storage unavailable');
  const info = toolFailureInfo(result);
  assert.deepEqual(info, {
    name: 'SubagentError',
    code: 'SUBAGENT_FAILED',
    message: 'subagent run failed: storage unavailable',
  });
  const projected = sessionSearchFailureResult(info);
  assert.equal(projected.queried, false);
  assert.equal(projected.reason, 'error');
  assert.equal(projected.evidenceType, 'none');
  assert.deepEqual(projected.hits, []);
  assert.match(projected.error, /subagent run failed/u);
  console.log(`[5] name=${info.name} code=${info.code} evidenceType=${projected.evidenceType} hits=${projected.hits.length}`);
});

// ---------------------------------------------------------------------------
// 6. Diagnostics stay off the return path for a failure too
// ---------------------------------------------------------------------------

test('6. a hanging or throwing log never holds or fails the failure result', async () => {
  const rows = [];
  const log = {
    emit(type, payload) {
      setTimeout(() => rows.push({ type, payload }), 0);
      return new Promise(() => {});
    },
  };
  const startedAt = performance.now();
  const result = await runSessionSearch({
    budgetMs: 2_000,
    log,
    search: async () => { throw new Error('storage unavailable'); },
  });
  const returnMs = performance.now() - startedAt;
  assert.equal(result.reason, 'error');
  assert.ok(returnMs < 60, `returned in ${returnMs.toFixed(1)} ms, not blocked by the hanging log`);
  await settle();
  assert.deepEqual(rows.map((row) => row.type), ['session_search.error']);

  const boom = { emit() { throw new Error('log unavailable'); } };
  const thrown = await runSessionSearch({
    budgetMs: 2_000,
    log: boom,
    search: async () => { throw new Error('storage unavailable'); },
  });
  assert.equal(thrown.reason, 'error');
  assert.match(thrown.error, /storage unavailable/u);
  console.log(`[6] returnMs=${returnMs.toFixed(1)}<60 reason=${result.reason} event=${rows[0].type}`);
});
