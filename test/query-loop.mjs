/**
 * P-127 `session_search` semantics: "not queried" is not "no memory", a present-tense row is not
 * history, and the same condition is not fired twice in one turn.
 *
 * The adapter (`runSessionSearch`) carries `queried` / `reason` / `evidenceType`; the production
 * wrapper (`createSessionSearchBudget` on `tools/execute`) turns those into model-facing lines and
 * reuses a same-turn, same-condition result with one `session_search.dedup {query, count}` event.
 * The 8 s budget and the workspace scope gate are untouched by this layer.
 *
 * Run: node --test test/query-loop.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cleanupRoot } from './helpers/cleanup.mjs';
import {
  SESSION_SEARCH_DEDUP_MS,
  createSessionQueryLedger,
  queryEvidenceType,
  runSessionSearch,
  sessionSearchSemanticsText,
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
  arguments: args = { query: 'budget' },
  id = 's-query-loop',
  events = [],
} = {}) {
  return {
    name: 'session_search',
    arguments: args,
    signal,
    agent: { session: { id, header: { cwd }, ownEvents: () => events } },
  };
}

const HIT = {
  isError: false,
  value: 'Session search results (1):\n\n1. Session s-1 — note\n   Best match: seq 4 | user/message',
  content: [{ type: 'text', text: 'Session search results (1)' }],
};

const EMPTY = { isError: false, value: 'No prior session matches found.', content: [] };

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

/** Every event of one type, in file order. */
async function eventsOf(root, type) {
  return (await readEvents(root)).filter((row) => row.type === type);
}

// ---------------------------------------------------------------------------
// 1. Not queried is not "no memory": a reused run is `queried:false`, an empty run is not
// ---------------------------------------------------------------------------

test('1. a reused result is marked queried:false and never reads as "no memory"', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-query-loop-noquery-'));
  const app = mount(root);
  t.after(() => cleanupRoot(root, app.disposers));

  // An empty *queried* run says exactly that: the query ran, nothing matched.
  const empty = await runSessionSearch({
    budgetMs: 2_000,
    query: '昨天提过的那件事',
    search: async () => ({ hits: [], scanned: 4 }),
  });
  assert.equal(empty.queried, true, 'an empty run still queried');
  assert.equal(empty.reason, 'empty');
  assert.equal(empty.evidenceType, 'none');

  // A same-condition repeat is not a second query; it reuses the first result.
  const args = { query: '昨天提过的那件事', event_time_from: '2026-11-01', event_time_to: '2026-11-07' };
  const exec = execFor(join(root, 'workspace'), { arguments: args });
  let nextCalls = 0;
  const body = async () => {
    nextCalls += 1;
    return EMPTY;
  };
  const first = await app.sessionSearchBudget()(exec, body);
  // A non-today empty result stays the framework result, so the empty-scope hint is not invented.
  assert.equal(first, EMPTY, 'a non-today empty result is returned by identity');
  const second = await app.sessionSearchBudget()(exec, body);

  assert.equal(nextCalls, 1, 'the repeat never ran the search again');
  assert.match(second.value, /^session_search evidence: queried=false, reason=reuse/u);
  assert.match(second.value, /range=2026-11-01\.\.2026-11-07/u, 'the reused condition stays visible');
  assert.match(second.value, /没有重复查询/u, 'the model is told the run was reused');
  assert.match(second.value, /不能单独当作「没有记录」/u, 'a reuse is not evidence of no memory');
  assert.match(second.value, /No prior session matches found\./u, 'the reused result body is kept');
  assert.match(
    sessionSearchSemanticsText({ queried: false, reason: 'reuse', query: 'x', count: 2 }),
    /^session_search evidence: queried=false, reason=reuse, evidenceType=none, count=2$/mu,
    'the model-facing line is a stable, parseable shape',
  );

  const dedup = await waitForEvent(root, 'session_search.dedup');
  assert.deepEqual(dedup.payload, { query: '昨天提过的那件事', count: 2 });
  console.log(`[1] empty.queried=${empty.queried} empty.evidenceType=${empty.evidenceType} reuse.head=${second.value.split('\n')[0]} nextCalls=${nextCalls}`);
});

// ---------------------------------------------------------------------------
// 2. A past-record hit is history evidence
// ---------------------------------------------------------------------------

test('2. a past-record hit carries evidenceType history', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-query-loop-history-'));
  const app = mount(root);
  t.after(() => cleanupRoot(root, app.disposers));

  const rows = [{ id: 'a', at: '2026-11-06T10:00:00+08:00' }];
  const result = await runSessionSearch({
    budgetMs: 2_000,
    query: '上周我们聊过什么',
    search: async () => ({ hits: rows, scanned: 3 }),
  });
  assert.equal(result.queried, true);
  assert.equal(result.reason, 'hit');
  assert.equal(result.evidenceType, 'history');
  assert.deepEqual(result.hits, rows, 'hit order is unchanged');

  // The production wrapper keeps a plain history hit by identity (no annotation needed).
  const exec = execFor(join(root, 'workspace'), { arguments: { query: '上周我们聊过什么' } });
  const outcome = await app.sessionSearchBudget()(exec, async () => HIT);
  assert.equal(outcome, HIT, 'a history hit is the framework result itself');
  console.log(`[2] queried=${result.queried} reason=${result.reason} evidenceType=${result.evidenceType} identity=${outcome === HIT}`);
});

// ---------------------------------------------------------------------------
// 3. A present-tense question only proves the present, never the past
// ---------------------------------------------------------------------------

test('3. a current-state hit is marked current-state and says it cannot prove the past', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-query-loop-current-'));
  const app = mount(root);
  t.after(() => cleanupRoot(root, app.disposers));

  assert.equal(queryEvidenceType({ query: '我现在在做什么', hits: [{ id: 'x' }] }), 'current-state');
  assert.equal(queryEvidenceType({ query: '上周我在做什么', hits: [{ id: 'x' }] }), 'history');
  assert.equal(queryEvidenceType({ query: '现在在做什么', hits: [] }), 'none');
  assert.equal(queryEvidenceType({ query: '状态如何', hits: [{ id: 'status', currentState: true }] }), 'current-state');

  const adapter = await runSessionSearch({
    budgetMs: 2_000,
    query: '我现在在做什么',
    search: async () => ({ hits: [{ id: 'status' }], scanned: 1 }),
  });
  assert.equal(adapter.evidenceType, 'current-state');
  assert.equal(adapter.reason, 'hit');

  const exec = execFor(join(root, 'workspace'), { arguments: { query: '我现在在做什么' } });
  const outcome = await app.sessionSearchBudget()(exec, async () => HIT);
  assert.notEqual(outcome, HIT, 'the model-facing result is annotated, not replaced');
  assert.match(outcome.value, /Session search results \(1\)/u, 'the framework result is still there');
  assert.match(outcome.value, /evidenceType=current-state/u);
  assert.match(outcome.value, /只能说明现在，不能证明过去发生过什么/u);
  console.log(`[3] adapter.evidenceType=${adapter.evidenceType} annotated=${outcome.value.includes('不能证明过去发生过什么')}`);
});

// ---------------------------------------------------------------------------
// 4. Same turn + same condition: one execution, a counted dedup event, a new turn re-queries
// ---------------------------------------------------------------------------

test('4. a same-turn repeat runs once and the dedup event counts the repeats', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-query-loop-dedup-'));
  const app = mount(root);
  t.after(() => cleanupRoot(root, app.disposers));

  const events = [{ data: { turn: 7 } }];
  const exec = execFor(join(root, 'workspace'), { arguments: { query: '预算' }, events });
  let nextCalls = 0;
  const body = async () => {
    nextCalls += 1;
    return HIT;
  };

  const first = await app.sessionSearchBudget()(exec, body);
  const second = await app.sessionSearchBudget()(exec, body);
  const third = await app.sessionSearchBudget()(exec, body);
  assert.equal(first, HIT, 'the first call runs and keeps identity');
  assert.equal(nextCalls, 1, 'repeats in the same turn never reach the framework body');
  assert.match(second.value, /queried=false/u);
  assert.match(third.value, /count=3/u);

  await settle();
  // 首轮曾因日志落盘顺序失败，已改为与顺序无关：按 query 分组计数，不依赖事件行先后。
  const dedupCounts = new Map();
  for (const row of await eventsOf(root, 'session_search.dedup')) {
    const list = dedupCounts.get(row.payload.query) ?? [];
    list.push(row.payload.count);
    dedupCounts.set(row.payload.query, list);
  }
  assert.deepEqual(
    [...dedupCounts].map(([query, counts]) => [query, [...counts].sort((a, b) => a - b)]),
    [['预算', [2, 3]]],
    'the query group holds exactly the counts 2 and 3, whatever the log order',
  );
  // Independent count check: sorted counts must run 2, 3, … with no gap, duplicate or reset.
  const counts = (dedupCounts.get('预算') ?? []).sort((a, b) => a - b);
  assert.deepEqual(counts, counts.map((_count, index) => index + 2), 'the per-turn count increments 2, 3, …');

  // A different query is a different condition: it runs.
  const other = execFor(join(root, 'workspace'), { arguments: { query: '别的' }, events });
  await app.sessionSearchBudget()(other, body);
  assert.equal(nextCalls, 2);

  // The next turn is a new boundary: the same query runs again.
  events.push({ data: { turn: 8 } });
  const nextTurn = await app.sessionSearchBudget()(exec, body);
  assert.equal(nextCalls, 3, 'a new turn re-queries');
  assert.equal(nextTurn, HIT);
  await settle();
  assert.equal((await eventsOf(root, 'session_search.dedup')).length, 2, 'no dedup event for a new turn');
  console.log(`[4] nextCalls=${nextCalls} dedup=${JSON.stringify((await eventsOf(root, 'session_search.dedup')).map((row) => row.payload))}`);
});

// ---------------------------------------------------------------------------
// 5. A ledger also works without turn identity (time window) and a different range is new
// ---------------------------------------------------------------------------

test('5. without a turn the window decides reuse, and a changed range never reuses', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-query-loop-window-'));
  const app = mount(root, { search: {} });
  t.after(() => cleanupRoot(root, app.disposers));

  let now = 1_000;
  const ledger = createSessionQueryLedger({ clock: () => now, windowMs: 30_000 });
  const first = ledger.begin({ sessionId: 's', query: 'Q', range: { from: '2026-11-01' } });
  assert.equal(first.reused, false);
  ledger.complete(first, { value: 'cached' }, { evidenceType: 'history' });

  now += 5_000;
  const repeat = ledger.begin({ sessionId: 's', query: '  q ', range: { from: '2026-11-01' } });
  assert.equal(repeat.reused, true, 'case and spacing fold into the same condition');
  assert.equal(repeat.count, 2);
  assert.equal(repeat.evidenceType, 'history');

  now += SESSION_SEARCH_DEDUP_MS + 1;
  assert.equal(ledger.begin({ sessionId: 's', query: 'Q', range: { from: '2026-11-01' } }).reused, false, 'the window expires');
  const otherRange = ledger.begin({ sessionId: 's', query: 'Q', range: { from: '2026-10-01' } });
  assert.equal(otherRange.reused, false, 'a different range is a different condition');

  // The wrapper still runs both calls through the same real gate.
  const exec = execFor(join(root, 'workspace'), { arguments: { query: 'window' } });
  let nextCalls = 0;
  const body = async () => {
    nextCalls += 1;
    return HIT;
  };
  await app.sessionSearchBudget()(exec, body);
  await app.sessionSearchBudget()(exec, body);
  assert.equal(nextCalls, 1, 'the mounted wrapper deduplicates too');
  console.log(`[5] fold=true windowExpires=true rangeChange=true nextCalls=${nextCalls}`);
});

// ---------------------------------------------------------------------------
// 6. Scope and budget are untouched (regression)
// ---------------------------------------------------------------------------

test('6. out-of-scope calls never deduplicate, and a timeout is reused instead of retried', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-query-loop-scope-'));
  const app = mount(root, { sessionSearchBudgetMs: 25 });
  t.after(() => cleanupRoot(root, app.disposers));

  // Out of scope: two identical calls both run, nothing logged, caller signal untouched.
  const upstream = new AbortController();
  const outExec = execFor(join(root, 'default-workspace'), { signal: upstream.signal, arguments: { query: 'code' } });
  let outCalls = 0;
  const outBody = async () => {
    outCalls += 1;
    await settle(50); // longer than the 25 ms budget on purpose
    return HIT;
  };
  const startedAt = performance.now();
  const outFirst = await app.sessionSearchBudget()(outExec, outBody);
  const outSecond = await app.sessionSearchBudget()(outExec, outBody);
  const elapsedMs = performance.now() - startedAt;
  assert.equal(outFirst, HIT);
  assert.equal(outSecond, HIT);
  assert.equal(outCalls, 2, 'out-of-scope repeats still run');
  assert.ok(elapsedMs >= 95, `both 50 ms bodies ran to completion (${elapsedMs.toFixed(1)} ms)`);
  assert.equal(outExec.signal, upstream.signal, 'the caller signal is not replaced');
  assert.equal(upstream.signal.aborted, false);

  // In scope, over budget: the partial result is reused, so the stuck shot is not fired again.
  const inExec = execFor(join(root, 'workspace'), { arguments: { query: 'slow' } });
  let nextCalls = 0;
  const hanging = () => new Promise(() => { nextCalls += 1; });
  const timedOut = await app.sessionSearchBudget()(inExec, hanging);
  assert.match(timedOut.value, /^session_search partial: true/u, 'the 8 s budget rule is unchanged');
  const reuse = await app.sessionSearchBudget()(inExec, hanging);
  assert.match(reuse.value, /^session_search evidence: queried=false, reason=reuse/u);
  assert.equal(nextCalls, 1, 'a timed-out query is not retried');

  await settle();
  assert.equal((await eventsOf(root, 'session_search.dedup')).length, 1);
  assert.equal((await eventsOf(root, 'session_search.timeout')).length, 1);
  console.log(`[6] outCalls=${outCalls} outEvents=0 timeoutPartial=true timeoutNextCalls=${nextCalls} dedup=1`);
});

// ---------------------------------------------------------------------------
// 7. A late result from a superseded slot never overwrites the current cache
// ---------------------------------------------------------------------------

test('7. a late result from an older slot is dropped and reported as stale', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-query-loop-stale-'));
  const app = mount(root);
  t.after(() => cleanupRoot(root, app.disposers));

  const query = '同条件迟到';
  const events = [{ data: { turn: 7 } }];
  const firstBody = { isError: false, value: 'first-turn-result', content: [] };
  const secondBody = { isError: false, value: 'second-turn-result', content: [] };
  let releaseFirst;
  const pending = new Promise((resolve) => { releaseFirst = resolve; });

  // Turn 7 begins but does not complete yet.
  const firstCall = app.sessionSearchBudget()(
    execFor(join(root, 'workspace'), { arguments: { query }, events }),
    () => pending,
  );

  // Turn 8 opens a new slot and completes it while turn 7 is still in flight.
  events.push({ data: { turn: 8 } });
  const second = await app.sessionSearchBudget()(
    execFor(join(root, 'workspace'), { arguments: { query }, events }),
    async () => secondBody,
  );
  assert.equal(second, secondBody, 'the new slot keeps the framework result by identity');

  // Turn 7 finishes late: its own caller keeps its result, but the cache must not take it.
  releaseFirst(firstBody);
  const late = await firstCall;
  assert.equal(late, firstBody, 'the late caller still receives its own result');

  // Turn 8 repeats: reuse must return the turn-8 result, never the late turn-7 one.
  let reuseRan = false;
  const third = await app.sessionSearchBudget()(
    execFor(join(root, 'workspace'), { arguments: { query }, events }),
    async () => {
      reuseRan = true;
      return { isError: false, value: 'unexpected-refresh', content: [] };
    },
  );
  assert.equal(reuseRan, false, 'the current slot is reused instead of re-running');
  assert.match(third.value, /queried=false/u);
  assert.match(third.value, /second-turn-result/u, 'the cache still holds the turn-8 result');
  assert.doesNotMatch(third.value, /first-turn-result/u, 'the late turn-7 result never entered the cache');

  const stale = await waitForEvent(root, 'session_search.cache.stale');
  assert.notEqual(stale, null, 'the dropped late result is reported');
  assert.equal(stale.payload.query, query);
  assert.equal(stale.payload.slot, 1, 'the late call names its own superseded slot');
  assert.equal(stale.payload.current, 2, 'the report names the slot that owns the cache now');
  await settle();
  assert.equal((await eventsOf(root, 'session_search.cache.stale')).length, 1, 'exactly one stale event');
  console.log(`[7] lateReturn=own reuseBody=second-turn-result stale=${JSON.stringify(stale.payload)}`);
});

// ---------------------------------------------------------------------------
// 8. A changed turn is a new slot: the previous turn's result is never reused (regression)
// ---------------------------------------------------------------------------

test('8. a changed turn opens a new slot and never reuses the previous turn', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-query-loop-newturn-'));
  const app = mount(root);
  t.after(() => cleanupRoot(root, app.disposers));

  const query = '跨轮不复用';
  const events = [{ data: { turn: 7 } }];
  const bodies = [
    { isError: false, value: 'turn-seven-result', content: [] },
    { isError: false, value: 'turn-eight-result', content: [] },
  ];
  let calls = 0;
  const body = async () => bodies[calls++];

  const first = await app.sessionSearchBudget()(
    execFor(join(root, 'workspace'), { arguments: { query }, events }),
    body,
  );
  assert.equal(first, bodies[0], 'the first turn runs the body');

  events.push({ data: { turn: 8 } });
  const second = await app.sessionSearchBudget()(
    execFor(join(root, 'workspace'), { arguments: { query }, events }),
    body,
  );
  assert.equal(second, bodies[1], 'the new turn runs again instead of reusing');
  assert.equal(calls, 2, 'the same condition in a new turn is a new query');

  // The ledger-level proof: a changed turn returns a non-reused slot with no stored outcome.
  const ledger = createSessionQueryLedger({ clock: () => 1_000, windowMs: 30_000 });
  const oldSlot = ledger.begin({ sessionId: 's', query, turn: 7 });
  assert.equal(ledger.complete(oldSlot, { value: 'old' }, { evidenceType: 'history' }), true);
  const newSlot = ledger.begin({ sessionId: 's', query, turn: 8 });
  assert.equal(newSlot.reused, false, 'a changed turn is never a reuse');
  assert.equal(newSlot.outcome, undefined, 'the old turn outcome is not carried over');
  assert.notEqual(newSlot.slot, oldSlot.slot, 'the new turn owns a new generation');
  console.log(`[8] calls=${calls} reused=${newSlot.reused} slots=${oldSlot.slot}->${newSlot.slot} second=${second.value}`);
});
