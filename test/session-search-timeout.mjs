/**
 * P-112 `session_search` degradation: a run that outlives its budget returns partial rows with an
 * explicit `reason:'timeout'` (never a silent empty result), and a today-only range with no hit
 * says that today has no records while earlier days were not queried.
 *
 * Run: node --test test/session-search-timeout.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SESSION_SEARCH_BUDGET_MS,
  isTodayOnlyRange,
  runSessionSearch,
  sessionSearchBudgetMs,
  sessionSearchTimeoutResult,
} from '../src/host/session/delivery/dispatch.js';

/** A log fake that records every emitted event, like the host log service. */
function eventLog() {
  const rows = [];
  return { rows, async emit(type, payload) { rows.push({ type, payload }); } };
}

/** Local `YYYY-MM-DD` of a date: the range shape the model writes for "today". */
function dayKey(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// ---------------------------------------------------------------------------
// 1. Over budget: partial rows + explicit timeout, never a silent empty result
// ---------------------------------------------------------------------------

test('1. a search over budget degrades to partial rows with reason timeout', async () => {
  const log = eventLog();
  const result = await runSessionSearch({
    budgetMs: 60,
    log,
    // The run reports what it already scanned, then never settles: exactly a stuck scan.
    search: async ({ onProgress }) => {
      onProgress({ scanned: 3, hits: [{ id: 's-1', title: '已扫描到的会话' }] });
      return new Promise(() => {});
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.partial, true, 'a timeout is never a silent empty result');
  assert.equal(result.reason, 'timeout');
  assert.equal(result.truncated, true);
  assert.equal(result.scanned, 3, 'the scanned count of the partial run survives');
  assert.equal(result.hits.length, 1, 'rows already found are returned, not dropped');
  assert.ok(result.elapsedMs >= 50, `measured elapsed ${result.elapsedMs} ms is a real budget overrun`);
  assert.match(result.notice, /部分结果/u);
  assert.deepEqual(log.rows.map((row) => row.type), ['session_search.timeout']);
  assert.deepEqual(log.rows[0].payload, { elapsedMs: result.elapsedMs, scanned: 3 });
  console.log(`[1] partial=${result.partial} reason=${result.reason} elapsedMs=${result.elapsedMs} scanned=${result.scanned} hits=${result.hits.length}`);
});

// ---------------------------------------------------------------------------
// 2. Within budget: no degradation fields at all (regression)
// ---------------------------------------------------------------------------

test('2. a normal query keeps its rows and order and has no partial field', async () => {
  const log = eventLog();
  const rows = [{ id: 'a', at: '2026-11-07T10:00:00+08:00' }, { id: 'b', at: '2026-11-07T09:00:00+08:00' }, { id: 'c', at: '2026-11-07T08:00:00+08:00' }];
  const result = await runSessionSearch({
    budgetMs: 2_000,
    log,
    range: { from: dayKey(new Date()), to: dayKey(new Date()) },
    search: async () => ({ hits: rows, scanned: 2 }),
  });
  assert.equal('partial' in result, false, 'a completed search carries no partial flag');
  assert.equal('truncated' in result, false);
  assert.equal('notice' in result, false);
  assert.equal(result.ok, true);
  assert.equal(result.scanned, 2);
  assert.deepEqual(result.hits, rows, 'hit order is the search order, unchanged');
  assert.equal(result.hits[0], rows[0], 'the returned array is the search result itself');
  assert.equal(log.rows.length, 0, 'a completed search emits no degradation event');
  console.log(`[2] partial=${'partial' in result} hits=${result.hits.map((row) => row.id).join(',')} events=${log.rows.length}`);
});

// ---------------------------------------------------------------------------
// 3. Today-only range with no hit: coverage hint + suggestEarliest
// ---------------------------------------------------------------------------

test('3. a today-only miss says earlier days were not queried and suggests the earliest record', async () => {
  const log = eventLog();
  const range = { from: dayKey(new Date()), to: dayKey(new Date()) };
  const result = await runSessionSearch({
    budgetMs: 2_000,
    log,
    range,
    search: async () => ({ hits: [], scanned: 5, earliest: '2026-10-20T09:00:00+08:00' }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.hits.length, 0);
  assert.equal(result.emptyScope, true);
  assert.match(result.notice, /今天没有记录/u);
  assert.match(result.notice, /更早的记录未纳入本次查询/u);
  assert.equal(result.suggestEarliest, '2026-10-20T09:00:00+08:00', 'the session earliest record is surfaced');
  assert.match(result.notice, /2026-10-20T09:00:00\+08:00/u);
  assert.deepEqual(log.rows, [{ type: 'session_search.empty-scope', payload: { range } }]);
  // The same coverage decision, independently: an exclusive next-midnight end is still today only.
  const now = new Date(2026, 10, 7, 15, 0, 0);
  assert.equal(isTodayOnlyRange({ from: '2026-11-07', to: '2026-11-07' }, now), true);
  assert.equal(isTodayOnlyRange({ from: '2026-11-07', to: new Date(2026, 10, 8) }, now), true);
  assert.equal(isTodayOnlyRange({ from: '2026-11-06', to: '2026-11-07' }, now), false);
  assert.equal(isTodayOnlyRange({ from: '2026-11-07' }, now), false);
  console.log(`[3] emptyScope=${result.emptyScope} suggestEarliest=${result.suggestEarliest} range=${result.range.from}..${result.range.to}`);
});

// ---------------------------------------------------------------------------
// 4. A hit suppresses the empty-scope notice (regression)
// ---------------------------------------------------------------------------

test('4. a hit in a today-only range carries no coverage notice', async () => {
  const log = eventLog();
  const range = { from: dayKey(new Date()), to: dayKey(new Date()) };
  const result = await runSessionSearch({
    budgetMs: 2_000,
    log,
    range,
    search: async () => ({ hits: [{ id: 'today-1' }], scanned: 1, earliest: '2026-10-20T09:00:00+08:00' }),
  });
  assert.equal('emptyScope' in result, false);
  assert.equal('notice' in result, false);
  assert.equal('suggestEarliest' in result, false);
  assert.deepEqual(result.hits, [{ id: 'today-1' }]);
  assert.equal(log.rows.length, 0, 'no empty-scope event when something was found');
  console.log(`[4] hits=${result.hits.length} emptyScope=${'emptyScope' in result} events=${log.rows.length}`);
});

// ---------------------------------------------------------------------------
// 5. Budget configuration: 8 s default, explicit option and plugin config both win
// ---------------------------------------------------------------------------

test('5. the budget defaults to 8 s and is configurable', () => {
  assert.equal(SESSION_SEARCH_BUDGET_MS, 8_000);
  assert.equal(sessionSearchBudgetMs(), 8_000);
  assert.equal(sessionSearchBudgetMs({ budgetMs: 1_500 }), 1_500);
  assert.equal(sessionSearchBudgetMs({ config: { sessionSearchBudgetMs: 3_000 } }), 3_000);
  assert.equal(sessionSearchBudgetMs({ config: { sessionSearch: { budgetMs: 4_000 } } }), 4_000);
  assert.equal(sessionSearchBudgetMs({ budgetMs: 500, config: { sessionSearchBudgetMs: 3_000 } }), 500);
  assert.equal(sessionSearchBudgetMs({ budgetMs: -1, config: { sessionSearchBudgetMs: 0 } }), 8_000);
  const degraded = sessionSearchTimeoutResult({ elapsedMs: 8_010, scanned: 12, budgetMs: 8_000 });
  assert.equal(degraded.partial, true);
  assert.equal(degraded.reason, 'timeout');
  assert.equal(degraded.truncated, true);
  assert.equal(degraded.elapsedMs, 8_010);
  assert.equal(degraded.scanned, 12);
  console.log(`[5] default=${SESSION_SEARCH_BUDGET_MS} override=${sessionSearchBudgetMs({ config: { sessionSearch: { budgetMs: 4000 } } })}`);
});

// ---------------------------------------------------------------------------
// 6. Diagnostics are off the return path: a log that never settles cannot hold the result
// ---------------------------------------------------------------------------

/** Wait for fire-and-forget diagnostics to be delivered. */
const settle = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

/** Guard one search, so a blocked return fails the test instead of hanging the suite. */
async function searchOrFail(pending, ms = 500) {
  let timer;
  try {
    return await Promise.race([
      pending,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`runSessionSearch did not return within ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test('6. a hanging log never holds the timeout result', async () => {
  const rows = [];
  const log = {
    // Record the event asynchronously (after the result is back), then never answer the caller.
    emit(type, payload) {
      setTimeout(() => rows.push({ type, payload }), 0);
      return new Promise(() => {});
    },
  };
  const startedAt = performance.now();
  const result = await searchOrFail(runSessionSearch({
    budgetMs: 20,
    log,
    search: async ({ onProgress }) => {
      onProgress({ scanned: 2, hits: [{ id: 'p-1' }] });
      return new Promise(() => {});
    },
  }));
  const returnMs = performance.now() - startedAt;
  assert.equal(result.ok, true);
  assert.equal(result.partial, true);
  assert.equal(result.reason, 'timeout');
  assert.equal(result.scanned, 2);
  assert.deepEqual(result.hits, [{ id: 'p-1' }]);
  assert.ok(returnMs < 60, `returned in ${returnMs.toFixed(1)} ms, not blocked by the hanging log`);
  assert.ok(result.elapsedMs < 60, `measured elapsed ${result.elapsedMs} ms stays near the 20 ms budget`);
  await settle();
  assert.deepEqual(rows.map((row) => row.type), ['session_search.timeout'], 'the event is still emitted asynchronously');
  assert.deepEqual(rows[0].payload, { elapsedMs: result.elapsedMs, scanned: 2 }, 'the event payload is unchanged');
  console.log(`[6] returnMs=${returnMs.toFixed(1)}<60 elapsedMs=${result.elapsedMs} event=${rows[0].type}`);
});

// ---------------------------------------------------------------------------
// 7. The empty-scope hint is off the return path too
// ---------------------------------------------------------------------------

test('7. a hanging log never holds the empty-scope result', async () => {
  const rows = [];
  const log = {
    emit(type, payload) {
      setTimeout(() => rows.push({ type, payload }), 0);
      return new Promise(() => {});
    },
  };
  const range = { from: dayKey(new Date()), to: dayKey(new Date()) };
  const startedAt = performance.now();
  const result = await searchOrFail(runSessionSearch({
    budgetMs: 2_000,
    log,
    range,
    search: async () => ({ hits: [], scanned: 4, earliest: '2026-10-20T09:00:00+08:00' }),
  }));
  const returnMs = performance.now() - startedAt;
  assert.equal(result.ok, true);
  assert.equal(result.emptyScope, true);
  assert.match(result.notice, /今天没有记录/u);
  assert.ok(returnMs < 60, `returned in ${returnMs.toFixed(1)} ms, not blocked by the hanging log`);
  await settle();
  assert.deepEqual(rows, [{ type: 'session_search.empty-scope', payload: { range } }]);
  console.log(`[7] returnMs=${returnMs.toFixed(1)}<60 emptyScope=true event=${rows[0].type}`);
});

// ---------------------------------------------------------------------------
// 8. A log that throws (sync) or rejects (async) never touches the result
// ---------------------------------------------------------------------------

test('8. a throwing or rejecting log never fails the search', async () => {
  const boom = { emit() { throw new Error('log unavailable'); } };
  const timeoutResult = await searchOrFail(runSessionSearch({
    budgetMs: 20,
    log: boom,
    search: async ({ onProgress }) => {
      onProgress({ scanned: 1, hits: [{ id: 't-1' }] });
      return new Promise(() => {});
    },
  }));
  assert.equal(timeoutResult.partial, true);
  assert.deepEqual(timeoutResult.hits, [{ id: 't-1' }]);

  const rejected = { emit() { return Promise.reject(new Error('log rejected')); } };
  const empty = await searchOrFail(runSessionSearch({
    budgetMs: 2_000,
    log: rejected,
    range: { from: dayKey(new Date()), to: dayKey(new Date()) },
    search: async () => ({ hits: [], scanned: 1 }),
  }));
  assert.equal(empty.ok, true);
  assert.equal(empty.emptyScope, true);
  assert.match(empty.notice, /今天没有记录/u);
  await settle();
  console.log(`[8] timeoutPartial=${timeoutResult.partial} emptyScope=${empty.emptyScope} result unaffected`);
});

// ---------------------------------------------------------------------------
// 9. A non-today empty result names its actual window instead of "no memory"
// ---------------------------------------------------------------------------

test('9. a non-today miss names the window and never claims "memory has nothing"', async () => {
  const log = eventLog();
  const range = { from: '2026-11-01', to: '2026-11-07' };
  const result = await runSessionSearch({
    budgetMs: 2_000,
    log,
    range,
    search: async () => ({ hits: [], scanned: 2 }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.queried, true);
  assert.equal(result.reason, 'empty');
  assert.equal(result.evidenceType, 'none');
  assert.equal(result.hits.length, 0);
  assert.equal(result.coverage, true, 'a non-today miss carries the coverage marker');
  assert.equal('emptyScope' in result, false, 'it is not called a today-only miss');
  assert.deepEqual(result.range, range, 'the actual query window is returned');
  assert.match(result.notice, /本轮只查了 2026-11-01–2026-11-07/u);
  assert.match(result.notice, /不能据此断言没有发生/u);
  assert.doesNotMatch(result.notice, /今天没有记录/u, 'a non-today window is not described as today');
  assert.doesNotMatch(result.notice, /^记忆里没有/u);
  assert.deepEqual(log.rows, [{ type: 'session_search.empty-coverage', payload: { range } }]);
  console.log(`[9] reason=${result.reason} evidenceType=${result.evidenceType} range=${result.range.from}..${result.range.to} coverage=${result.coverage}`);
});

// ---------------------------------------------------------------------------
// 10. An empty result without any time range is also bounded by what was scanned
// ---------------------------------------------------------------------------

test('10. an unbounded empty result states that no time range was set', async () => {
  const log = eventLog();
  const result = await runSessionSearch({
    budgetMs: 2_000,
    log,
    search: async () => ({ hits: [], scanned: 7 }),
  });
  assert.equal(result.reason, 'empty');
  assert.equal(result.evidenceType, 'none');
  assert.equal(result.coverage, true);
  assert.match(result.notice, /本轮查询没有限定时间范围/u);
  assert.match(result.notice, /不能据此断言没有发生/u);
  assert.match(result.notice, /不等于「记忆里没有」/u);
  assert.deepEqual(log.rows, [{ type: 'session_search.empty-coverage', payload: { range: {} } }]);
  console.log(`[10] reason=${result.reason} coverage=${result.coverage} notice=${result.notice.split('。')[0]}`);
});

