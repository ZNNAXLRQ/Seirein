/**
 * P-127: a failed `subagent` / `subagent_fork` *launch* is observable without changing the tool.
 *
 * The plugin registers a second `tools/execute` wrapper next to the `session_search` budget. When
 * the framework returns `isError:true`, it emits `subagent.error {name, code, depth?}` from
 * `toolFailureInfo` (including the Harness `error.info.name/code` shape), then returns the original
 * result object by identity. Successful, empty and unrelated results emit nothing, and the
 * `subagent-settled` path (a child that started and then failed) is not wired here.
 *
 * Run: node --test test/subagent-error.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cleanupRoot } from './helpers/cleanup.mjs';
import {
  createSubagentFailure,
  toolFailureInfo,
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
  const wrapperNamed = (name) => {
    const list = listeners.get('tools/execute') ?? [];
    assert.equal(list.length, 2, 'exactly two tools/execute wrappers (session_search + subagent)');
    const wrapper = list.find((handler) => handler.name === name);
    assert.equal(typeof wrapper, 'function', `the ${name} wrapper is registered`);
    return wrapper;
  };
  return {
    listeners,
    tools,
    disposers,
    sessionSearchBudget: () => wrapperNamed('sessionSearchBudget'),
    subagentFailure: () => wrapperNamed('subagentFailure'),
  };
}

const settle = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

/** A delegation-tool exec whose caller depth comes from the header and/or the live option. */
function execFor(name, {
  arguments: args = {},
  cwd = '',
  depth = 0,
  optionDepth = undefined,
  id = 's-subagent-error',
} = {}) {
  return {
    name,
    arguments: args,
    signal: new AbortController().signal,
    agent: {
      session: { id, header: { cwd, delegationDepth: depth }, ownEvents: () => [] },
      ...(optionDepth === undefined ? {} : { options: { subagentDepth: optionDepth } }),
    },
  };
}

/** A Harness `toolErrorResult`: name/code live in `error.info`, never at the top level. */
function harnessFailure({ message, name, code, content = [] }) {
  return {
    isError: true,
    error: { message, info: { name, code } },
    value: `Error: ${message}`,
    content: content.length > 0 ? content : [{ type: 'text', text: `Error: ${message}` }],
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
// 1. toolFailureInfo reads the Harness `error.info` shape without changing precedence
// ---------------------------------------------------------------------------

test('1. toolFailureInfo falls back to error.info.name/code and keeps top-level priority', () => {
  const info = toolFailureInfo({
    isError: true,
    error: { message: 'subagent depth exceeded', info: { name: 'SubagentError', code: 'MAX_DEPTH' } },
  });
  assert.deepEqual(info, {
    name: 'SubagentError',
    code: 'MAX_DEPTH',
    message: 'subagent depth exceeded',
  }, 'name/code come from error.info');

  const topLevel = toolFailureInfo({
    errorName: 'TopLevelError',
    errorCode: 'TOP_LEVEL_CODE',
    error: { message: 'top-level wins', info: { name: 'InfoError', code: 'INFO_CODE' } },
  });
  assert.deepEqual(topLevel, {
    name: 'TopLevelError',
    code: 'TOP_LEVEL_CODE',
    message: 'top-level wins',
  }, 'the pre-existing fields keep their priority');
  console.log(`[1] name=${info.name} code=${info.code} top=${topLevel.name}/${topLevel.code}`);
});

// ---------------------------------------------------------------------------
// 2. A failed `subagent` launch emits only machine fields and keeps result identity
// ---------------------------------------------------------------------------

test('2. subagent isError emits subagent.error and returns the same object', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-subagent-error-'));
  const app = mount(root);
  t.after(() => cleanupRoot(root, app.disposers));

  const original = harnessFailure({
    message: 'subagent depth 3 exceeds maxDepth 2',
    name: 'SubagentError',
    code: 'MAX_DEPTH',
  });
  const exec = execFor('subagent', { arguments: { prompt: 'do work' }, cwd: join(root, 'workspace'), depth: 2 });
  const outcome = await app.subagentFailure()(exec, async () => original);

  assert.equal(outcome, original, 'the framework result is returned by identity');
  const event = await waitForEvent(root, 'subagent.error');
  assert.notEqual(event, null, 'subagent.error is logged');
  assert.deepEqual(event.payload, {
    name: 'SubagentError',
    code: 'MAX_DEPTH',
    depth: 2,
  }, 'only name/code/depth are carried; no message, args or nested result');
  assert.equal(Object.hasOwn(event.payload, 'message'), false);
  console.log(`[2] identity preserved name=${event.payload.name} code=${event.payload.code} depth=${event.payload.depth}`);
});

// ---------------------------------------------------------------------------
// 3. `subagent_fork` is watched too, and the live depth may deepen the header
// ---------------------------------------------------------------------------

test('3. subagent_fork isError emits subagent.error with the deeper live depth', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-subagent-fork-error-'));
  const app = mount(root);
  t.after(() => cleanupRoot(root, app.disposers));

  const original = harnessFailure({
    message: 'route not allowed',
    name: 'SubagentRouteError',
    code: 'ROUTE_FORBIDDEN',
  });
  const exec = execFor('subagent_fork', {
    arguments: { prompt: 'fork work' },
    cwd: join(root, 'workspace'),
    depth: 1,
    optionDepth: 3,
  });
  const outcome = await app.subagentFailure()(exec, async () => original);

  assert.equal(outcome, original, 'subagent_fork result identity is preserved');
  const event = await waitForEvent(root, 'subagent.error');
  assert.notEqual(event, null, 'subagent.error is logged for subagent_fork');
  assert.deepEqual(event.payload, {
    name: 'SubagentRouteError',
    code: 'ROUTE_FORBIDDEN',
    depth: 3,
  }, 'the persisted header cannot lower the live delegation depth');
  console.log(`[3] identity preserved name=${event.payload.name} code=${event.payload.code} depth=${event.payload.depth}`);
});

// ---------------------------------------------------------------------------
// 4. Success, empty and unrelated results never emit
// ---------------------------------------------------------------------------

test('4. successful, empty and unrelated results emit nothing and keep identity', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-subagent-error-silent-'));
  const app = mount(root);
  t.after(() => cleanupRoot(root, app.disposers));

  const wrapper = app.subagentFailure();
  const cwd = join(root, 'workspace');
  const normal = { isError: false, value: 'subagent started', content: [] };
  const empty = {};
  const unrelated = harnessFailure({ message: 'web failed', name: 'WebError', code: 'WEB_FAILED' });

  assert.equal(await wrapper(execFor('subagent', { cwd }), async () => normal), normal);
  assert.equal(await wrapper(execFor('subagent', { cwd }), async () => empty), empty);
  assert.equal(await wrapper(execFor('subagent', { cwd }), async () => null), null);
  assert.equal(await wrapper(execFor('subagent_fork', { cwd }), async () => undefined), undefined);
  assert.equal(await wrapper(execFor('web_search', { cwd }), async () => unrelated), unrelated);

  await settle(100);
  assert.deepEqual(await eventsOf(root, 'subagent.error'), [], 'no event for a non-failure');
  console.log('[4] normal/empty/null/unrelated results: identity kept, zero subagent.error');
});

// ---------------------------------------------------------------------------
// 5. A throwing, rejecting or hanging log never changes or delays the result
// ---------------------------------------------------------------------------

test('5. a throwing, rejecting or hanging log never blocks the failure result', async () => {
  const original = harnessFailure({ message: 'no route', name: 'SubagentError', code: 'NO_ROUTE' });

  const throwing = createSubagentFailure({ log: { emit() { throw new Error('log unavailable'); } } });
  assert.equal(await throwing(execFor('subagent'), async () => original), original);

  const rejecting = createSubagentFailure({
    log: { emit() { return Promise.reject(new Error('log rejected')); } },
  });
  assert.equal(await rejecting(execFor('subagent'), async () => original), original);

  const rows = [];
  let release;
  const hanging = createSubagentFailure({
    log: {
      emit(type, payload) {
        rows.push({ type, payload });
        return new Promise((resolve) => { release = resolve; });
      },
    },
  });
  const startedAt = performance.now();
  const outcome = await hanging(execFor('subagent'), async () => original);
  const returnMs = performance.now() - startedAt;
  assert.equal(outcome, original, 'a hanging log never replaces the result');
  assert.ok(returnMs < 60, `returned in ${returnMs.toFixed(1)} ms, not blocked by the hanging log`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, 'subagent.error');
  release?.();
  await settle();
  console.log(`[5] returnMs=${returnMs.toFixed(1)}<60 event=${rows[0].type} identity preserved`);
});

// ---------------------------------------------------------------------------
// 6. The `subagent-settled` (child ran, then failed) path is not wired
// ---------------------------------------------------------------------------

test('6. the child-settled failure path is not wired into tools/execute', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-subagent-settled-'));
  const app = mount(root);
  t.after(() => cleanupRoot(root, app.disposers));

  assert.equal(app.listeners.has('subagent-settled'), false, 'no subagent-settled listener is installed');
  assert.equal((app.listeners.get('tools/execute') ?? []).length, 2, 'only the two launch wrappers are registered');
  console.log('[6] subagent-settled listener absent; tools/execute wrappers=2');
});

// ---------------------------------------------------------------------------
// 7. Existing session_search error projection keeps working with error.info
// ---------------------------------------------------------------------------

test('7. session_search still projects a Harness error.info failure', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-search-error-info-'));
  const app = mount(root);
  t.after(() => cleanupRoot(root, app.disposers));

  const original = harnessFailure({
    message: 'session history storage is unavailable',
    name: 'SessionQueryError',
    code: 'SESSION_QUERY_PERSISTENCE_FAILED',
  });
  const exec = execFor('session_search', {
    arguments: { query: 'OBS 场景 浏览器' },
    cwd: join(root, 'workspace'),
  });
  const outcome = await app.sessionSearchBudget()(exec, async () => original);

  assert.notEqual(outcome, original, 'the search failure is annotated, never a hit');
  assert.match(outcome.value, /^session_search failed=true/u);
  assert.match(outcome.value, /queried=false/u);
  assert.match(outcome.value, /reason=error/u);
  assert.match(outcome.value, /evidenceType=none/u);
  assert.match(outcome.value, /name=SessionQueryError/u, 'name comes from error.info');
  assert.match(outcome.value, /code=SESSION_QUERY_PERSISTENCE_FAILED/u, 'code comes from error.info');
  assert.match(outcome.value, /session history storage is unavailable/u);
  assert.doesNotMatch(outcome.value, /evidenceType=history/u, 'a failure is never labelled history');
  assert.doesNotMatch(outcome.value, /Session search results/u, 'no hit text is invented');
  assert.equal(Object.hasOwn(outcome, 'hits'), false, 'a failure result is not returned as a hit row');

  const event = await waitForEvent(root, 'session_search.error');
  assert.notEqual(event, null, 'session_search.error is logged');
  assert.deepEqual(event.payload, {
    name: 'SessionQueryError',
    code: 'SESSION_QUERY_PERSISTENCE_FAILED',
    scope: 'assistant',
  });
  console.log(`[7] head=${outcome.value.split('\n')[0]} event=${event.payload.name}/${event.payload.code}`);
});

// ---------------------------------------------------------------------------
// 8. A caller with no explicit depth omits the optional depth field
// ---------------------------------------------------------------------------

test('8. an exec without an explicit delegation depth omits depth', async () => {
  const rows = [];
  const wrapper = createSubagentFailure({
    log: { emit(type, payload) { rows.push({ type, payload }); } },
  });
  const original = harnessFailure({ message: 'no route', name: 'SubagentError', code: 'NO_ROUTE' });
  const outcome = await wrapper({ name: 'subagent' }, async () => original);

  assert.equal(outcome, original, 'the result identity is preserved');
  assert.deepEqual(rows, [{
    type: 'subagent.error',
    payload: { name: 'SubagentError', code: 'NO_ROUTE' },
  }], 'depth is omitted when the caller carries no explicit depth');
  console.log('[8] depth omitted; payload keys=' + Object.keys(rows[0].payload).join(','));
});
