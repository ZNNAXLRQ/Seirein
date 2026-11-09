/**
 * P-112 production wiring: the plugin cannot register or shadow the Harness `session_search`, but
 * the framework's `tools/execute` around-dispatch waterfall lets it run that tool under
 * `runSessionSearch`. These tests mount the real plugin, capture the listener it registers, and
 * call it exactly as the Harness pipeline does.
 *
 * The wrapper is scoped to the assistant workspace: only a session whose own cwd is the configured
 * workspace scope is budgeted. Another workspace (a coding agent, for example) is passed through
 * untouched — no budget, no signal rewrite and no `session_search.*` event.
 *
 * Run: node --test test/session-search-host.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cleanupRoot } from './helpers/cleanup.mjs';
import { apply } from '../src/host/index.js';

/** Local `YYYY-MM-DD` of a date: what the model writes for "today". */
function dayKey(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

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
    /** The two wrappers this plugin owns; the Harness can also have its own on this event. */
    sessionSearchBudget: () => {
      const list = listeners.get('tools/execute') ?? [];
      assert.equal(list.length, 2, 'exactly two tools/execute wrappers (session_search + subagent)');
      const wrapper = list.find((handler) => handler.name === 'sessionSearchBudget');
      assert.equal(typeof wrapper, 'function', 'the session_search budget wrapper is registered');
      return wrapper;
    },
  };
}

const settle = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

/** A `session_search` exec carrying a session whose own cwd is `cwd`. */
function execFor(cwd, { signal = new AbortController().signal, arguments: args = { query: 'budget' } } = {}) {
  return {
    name: 'session_search',
    arguments: args,
    signal,
    agent: { session: { header: { cwd } } },
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
        return null; // a reader can catch a line mid-append; the next poll sees it whole
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

/** The search events a call produced: exactly what the gate promises not to create outside scope. */
async function sessionSearchEvents(root) {
  return (await readEvents(root)).filter((row) => row.type.startsWith('session_search.'));
}

// ---------------------------------------------------------------------------
// 1. The production listener exists and a normal in-scope search keeps its exact result
// ---------------------------------------------------------------------------

test('1. the plugin registers a tools/execute wrapper and an in-scope search is returned by identity', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-search-host-normal-'));
  const app = mount(root);
  t.after(() => cleanupRoot(root, app.disposers));

  const original = {
    isError: false,
    value: 'Session search results (1):\n\n1. Session s-1 — note\n   Best match: seq 4 | user/message | current',
    content: [{ type: 'text', text: 'Session search results (1)' }],
  };
  const exec = execFor(join(root, 'workspace'), { arguments: { query: 'budget' } });
  const outcome = await app.sessionSearchBudget()(exec, async () => original);

  assert.equal(outcome, original, 'a completed search is the framework result itself');
  assert.equal(exec.signal.aborted, false, 'the caller signal is restored and not aborted');
  assert.equal((await sessionSearchEvents(root)).length, 0);
  console.log('[1] in-scope normal result identity preserved; query=none, budgetApplied but not hit');
});

// ---------------------------------------------------------------------------
// 2. In scope, over budget: partial marker + notice, timeout event carries scope
// ---------------------------------------------------------------------------

test('2. an in-scope hung session_search degrades to a partial notice and aborts the framework body', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-search-host-timeout-'));
  const app = mount(root, { sessionSearchBudgetMs: 25 });
  t.after(() => cleanupRoot(root, app.disposers));

  const upstream = new AbortController();
  const exec = execFor(join(root, 'workspace'), { signal: upstream.signal, arguments: { query: 'slow' } });
  let bodyAborted = false;
  const outcome = await app.sessionSearchBudget()(exec, () => new Promise((_resolve, reject) => {
    exec.signal.addEventListener('abort', () => {
      bodyAborted = true;
      reject(new Error('body aborted'));
    }, { once: true });
  }));

  assert.equal(outcome.isError, undefined, 'a timeout is a successful degraded result, not a tool failure');
  assert.match(outcome.value, /^session_search partial: true/u);
  assert.match(outcome.value, /reason=timeout/u);
  assert.match(outcome.value, /budgetMs=25/u);
  assert.match(outcome.value, /部分结果/u, 'the notice says rows are partial');
  await settle(10);
  assert.equal(bodyAborted, true, 'the framework body sees the budget abort');
  assert.equal(exec.signal, upstream.signal, 'the upstream signal is restored once the body is quiet');

  const event = await waitForEvent(root, 'session_search.timeout');
  assert.ok(event !== undefined, 'session_search.timeout is logged');
  assert.deepEqual(Object.keys(event.payload).sort(), ['elapsedMs', 'scanned', 'scope']);
  assert.equal(event.payload.scope, 'assistant', 'the timeout event names its scope');
  assert.equal(event.payload.scanned, 0, 'the framework body exposes no scanned count through this seam');
  assert.equal(typeof event.payload.elapsedMs, 'number');
  console.log(`[2] intervened=true partial=${outcome.value.split('\n')[0]} elapsedMs=${event.payload.elapsedMs} scanned=${event.payload.scanned} scope=${event.payload.scope}`);
});

// ---------------------------------------------------------------------------
// 3. In scope, today-only empty result: coverage notice + event with scope
// ---------------------------------------------------------------------------

test('3. an in-scope today-only empty result keeps the coverage notice and the scoped empty-scope event', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-search-host-empty-'));
  const app = mount(root);
  t.after(() => cleanupRoot(root, app.disposers));

  const today = dayKey(new Date());
  const empty = { isError: false, value: 'No prior session matches found.', content: [] };
  const exec = execFor(join(root, 'workspace'), {
    arguments: { query: 'yesterday', event_time_from: today, event_time_to: today },
  });
  const outcome = await app.sessionSearchBudget()(exec, async () => empty);

  assert.match(outcome.value, /^No prior session matches found\./u, 'the framework result is kept');
  assert.match(outcome.value, /今天没有记录/u);
  assert.match(outcome.value, /更早的记录未纳入本次查询/u);

  const event = await waitForEvent(root, 'session_search.empty-scope');
  assert.ok(event !== undefined, 'session_search.empty-scope is logged');
  assert.deepEqual(event.payload, { range: { from: today, to: today }, scope: 'assistant' });
  console.log(`[3] intervened=true emptyScope notice appended; range=${today}..${today} scope=${event.payload.scope} events=${(await sessionSearchEvents(root)).length}`);
});

// ---------------------------------------------------------------------------
// 4. The wrapper is scoped to session_search only (regression)
// ---------------------------------------------------------------------------

test('4. another tool call passes through untouched and logs nothing', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-search-host-other-'));
  const app = mount(root);
  t.after(() => cleanupRoot(root, app.disposers));

  const original = { isError: false, value: 'ok', content: [] };
  const outcome = await app.sessionSearchBudget()(
    { name: 'assistant_recall', arguments: { query: 'x' }, signal: new AbortController().signal },
    async () => original,
  );
  assert.equal(outcome, original);
  assert.equal((await sessionSearchEvents(root)).length, 0);
  console.log('[4] non-session_search call untouched; session_search events=0');
});

// ---------------------------------------------------------------------------
// 5. Outside the assistant scope: next() once, no budget, no signal change, no event
// ---------------------------------------------------------------------------

test('5. a coding-workspace session is passed through: no budget, no abort, no events', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-search-host-outscope-'));
  // A 25 ms budget: if the gate failed, this body would time out instead of returning identity.
  const app = mount(root, { sessionSearchBudgetMs: 25 });
  t.after(() => cleanupRoot(root, app.disposers));

  const upstream = new AbortController();
  const original = { isError: false, value: 'framework result', content: [] };
  const exec = execFor(join(root, 'default-workspace'), { signal: upstream.signal, arguments: { query: 'code' } });
  let nextCalls = 0;
  let bodyAborted = false;
  exec.signal.addEventListener('abort', () => { bodyAborted = true; }, { once: true });

  const startedAt = performance.now();
  const outcome = await app.sessionSearchBudget()(exec, async () => {
    nextCalls += 1;
    await settle(50); // longer than the 25 ms budget
    return original;
  });
  const elapsedMs = performance.now() - startedAt;

  assert.equal(outcome, original, 'the framework result is returned by identity, not a timeout result');
  assert.equal(nextCalls, 1, 'next() is called exactly once');
  assert.ok(elapsedMs >= 45, `the 50 ms body ran to completion (${elapsedMs.toFixed(1)} ms)`);
  assert.ok(elapsedMs < 1_000, `the call is not held by an 8 s budget (${elapsedMs.toFixed(1)} ms)`);
  assert.equal(exec.signal, upstream.signal, 'the caller signal is not replaced');
  assert.equal(upstream.signal.aborted, false, 'the caller signal is not aborted');
  assert.equal(bodyAborted, false, 'the framework body never sees a budget abort');

  const events = await sessionSearchEvents(root);
  assert.equal(events.length, 0, 'an out-of-scope call produces no session_search.* event');
  assert.equal((await readEvents(root)).some((row) => row.type === 'dispatch.session-search.skip'), false);
  console.log(`[5] intervened=false nextCalls=${nextCalls} elapsedMs=${elapsedMs.toFixed(1)} aborted=${bodyAborted} events=${events.length}`);
});

// ---------------------------------------------------------------------------
// 6. Unknown cwd: treat as outside the scope, pass through, record one debug line
// ---------------------------------------------------------------------------

test('6. a session without a readable cwd is passed through with a debug log', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-search-host-nocwd-'));
  const app = mount(root, { sessionSearchBudgetMs: 25 });
  t.after(() => cleanupRoot(root, app.disposers));

  const upstream = new AbortController();
  const original = { isError: false, value: 'framework result', content: [] };
  const exec = {
    name: 'session_search',
    arguments: { query: 'who am i' },
    signal: upstream.signal,
    // A session whose directory is not readable: no header cwd and no working-directory service.
    agent: { session: { header: {} } },
  };
  let nextCalls = 0;

  const startedAt = performance.now();
  const outcome = await app.sessionSearchBudget()(exec, async () => {
    nextCalls += 1;
    await settle(50); // longer than the 25 ms budget
    return original;
  });
  const elapsedMs = performance.now() - startedAt;

  assert.equal(outcome, original, 'an unjudged call is never budgeted');
  assert.equal(nextCalls, 1, 'next() is called exactly once');
  assert.ok(elapsedMs >= 45, `the 50 ms body ran to completion (${elapsedMs.toFixed(1)} ms)`);
  assert.equal(exec.signal, upstream.signal, 'the caller signal is not replaced');
  assert.equal(upstream.signal.aborted, false, 'the caller signal is not aborted');

  const searchEvents = await sessionSearchEvents(root);
  assert.equal(searchEvents.length, 0, 'no session_search.* event for an unknown owner');
  const debug = await waitForEvent(root, 'dispatch.session-search.skip');
  assert.ok(debug !== undefined, 'the unknown-cwd verdict is recorded');
  assert.deepEqual(debug.payload, { level: 'debug', reason: 'cwd-unknown' });
  console.log(`[6] intervened=false nextCalls=${nextCalls} elapsedMs=${elapsedMs.toFixed(1)} debug=${debug.payload.reason} searchEvents=${searchEvents.length}`);
});
