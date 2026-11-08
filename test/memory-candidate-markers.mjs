/**
 * P-52 marker layer: candidate (prepared, not adopted) vs delivered (actually in the request).
 *
 * The gap this suite pins: `memory.recall` reports found/injected and `memory.injection` counts
 * delivered kinds, but neither says WHICH prepared item was adopted. The aggregate pair
 * `memory.item.candidate {turn, items}` / `memory.item.delivered {turn, items, adoptRate}` fills
 * exactly that gap — one line per injection, never one per item, metadata only (no body):
 *
 *     candidate ∪ delivered = prepared      (disjoint, ranked 1..n in budget order)
 *     adoptRate = delivered / prepared      (0 when nothing was prepared)
 *     delivered.length = memory.recall.records
 *
 * The old events are untouched: the new pair is an aggregate view emitted beside them, and a
 * plain recall miss writes neither line (the same quiet-recall rule `memory.assembly` follows).
 *
 * Run: node --test test/memory-candidate-markers.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { composeInjectionBlock } from '../src/host/memory/memory-injection.js';
import {
  MEMORY_ITEM_CANDIDATE_EVENT,
  MEMORY_ITEM_DELIVERED_EVENT,
  composeMemoryItemMarkers,
  memoryAdoptRate,
} from '../src/host/memory/markers.js';
import { prepareMemoryInjection } from '../src/host/memory/pre-step.js';

const TS = '2026-11-01T00:00:00.000Z';

/** One recall row in the shape the store hands to the assembly (score included). */
function row(id, text, extra = {}) {
  return {
    id,
    ts: TS,
    role: 'user',
    text,
    source: 'auto',
    importance: 60,
    clarity: 'clear',
    kind: 'hit',
    score: 4.25,
    ...extra,
  };
}

/** In-memory stand-in for the host event log; `emit` resolves immediately, like the real one. */
function eventLog() {
  const events = [];
  return {
    events,
    types: () => events.map((entry) => entry.type),
    rows: (type) => events.filter((entry) => entry.type === type),
    async emit(type, payload) {
      events.push({ type, payload });
      return { type, payload };
    },
  };
}

/** The three-row block this suite reuses: the record cap adopts the first two. */
function blockOf(rows, limits = { maxRecords: 2, maxChars: 1200 }) {
  return composeInjectionBlock({ matched: rows, limits });
}

/**
 * A fixed-layer scenario with a measurable candidate: three 400-char fixed rows spend the shared
 * budget first, so the third fixed row is dropped whole (fixed rows are never compressed) while
 * the small relevance row still fits. Prepared 4 → delivered 3 / candidate 1 (adoptRate 0.75).
 */
const FIXED_BODY = '固'.repeat(400);
function fixedBudgetScenario() {
  const fixed = [1, 2, 3].map((index) => row(`fixed-${index}`, FIXED_BODY, { source: 'manual', importance: 90, kind: 'fact' }));
  const matched = [row('m-a', 'BODYA 周末去看展')];
  const reference = composeInjectionBlock({ fixed, matched });
  return { fixed, matched, reference };
}

test('1) candidate + delivered split: two marks, correct adoptRate, metadata only', () => {
  const rows = [row('m-a', 'BODYA 周末去看展'), row('m-b', 'BODYB 周六下午修车'), row('m-c', 'BODYC 被预算裁掉')];
  const block = blockOf(rows);
  assert.equal(block.prepared.length, 3, 'the prepared set is what the budget saw');
  assert.deepEqual(block.injectedIds, ['m-a', 'm-b']);

  const marks = composeMemoryItemMarkers({
    turn: 3,
    prepared: block.prepared,
    deliveredIds: block.injectedIds,
  });
  assert.equal(marks.turn, 3);
  assert.equal(marks.prepared, 3);
  assert.deepEqual(marks.delivered.map((item) => item.id), ['m-a', 'm-b']);
  assert.deepEqual(marks.candidate.map((item) => item.id), ['m-c'], 'only the un-adopted row is a candidate');
  assert.deepEqual(marks.delivered.map((item) => item.rank), [1, 2], 'rank is the prepared order');
  assert.deepEqual(marks.candidate.map((item) => item.rank), [3]);
  assert.equal(marks.adoptRate, 0.667, '2 of 3 prepared rows were adopted');

  // Disjoint and complete: nothing is both marks, nothing is lost.
  const ids = [...marks.candidate, ...marks.delivered].map((item) => item.id).sort();
  assert.deepEqual(ids, ['m-a', 'm-b', 'm-c']);
  for (const item of [...marks.candidate, ...marks.delivered]) {
    assert.deepEqual(Object.keys(item), ['id', 'kind', 'source', 'rank', 'score', 'chars'],
      'the marked item is metadata only, in a stable field order');
    assert.equal(item.source, 'auto');
    assert.equal(item.score, 4.25);
    assert.ok(item.chars > 0, 'the charged line width is reported');
  }
  const dumped = JSON.stringify({ candidate: marks.candidate, delivered: marks.delivered });
  for (const marker of ['BODYA', 'BODYB', 'BODYC']) {
    assert.ok(!dumped.includes(marker), `the body ${marker} must never reach the marker view`);
  }
  console.log(`[1] prepared=3 delivered=${marks.delivered.length} candidate=${marks.candidate.length} `
    + `adoptRate=${marks.adoptRate} chars=${marks.delivered.map((item) => item.chars).join(',')}`);
});

test('2) one injection → exactly one candidate line and one delivered line', async () => {
  const { fixed, matched } = fixedBudgetScenario();
  const log = eventLog();
  const result = await prepareMemoryInjection({
    memory: {
      fixedMemories: () => fixed.map((item) => ({ ...item })),
      recall: () => ({ hits: matched.map((item) => ({ ...item })), mode: 'keyword' }),
      listArchive: () => [],
      restore: () => {},
    },
    log,
    sessionId: 'marker-session',
    turn: 7,
    query: '周末的安排',
  });
  assert.equal(result.injected, true);
  assert.deepEqual(result.injectedIds, ['fixed-1', 'fixed-2', 'm-a'], 'the third fixed row cannot fit');

  const candidateRows = log.rows(MEMORY_ITEM_CANDIDATE_EVENT);
  const deliveredRows = log.rows(MEMORY_ITEM_DELIVERED_EVENT);
  assert.equal(candidateRows.length, 1, 'one candidate line per injection, not one per item');
  assert.equal(deliveredRows.length, 1, 'one delivered line per injection');
  assert.deepEqual(Object.keys(candidateRows[0].payload), ['turn', 'items']);
  assert.deepEqual(Object.keys(deliveredRows[0].payload), ['turn', 'items', 'adoptRate']);
  assert.equal(candidateRows[0].payload.turn, 7);
  assert.equal(deliveredRows[0].payload.turn, 7);
  assert.equal(deliveredRows[0].payload.adoptRate, 0.75, '3 of 4 prepared rows were adopted');
  assert.deepEqual(candidateRows[0].payload.items.map((item) => item.id), ['fixed-3']);
  assert.equal(candidateRows[0].payload.items[0].kind, 'fixed', 'a fixed row that lost the budget reads as fixed');
  assert.equal(candidateRows[0].payload.items[0].rank, 3, 'rank is its prepared position, not its split index');
  assert.deepEqual(deliveredRows[0].payload.items.map((item) => item.id), ['fixed-1', 'fixed-2', 'm-a']);
  assert.deepEqual(deliveredRows[0].payload.items.map((item) => item.rank), [1, 2, 4]);
  const dumped = JSON.stringify([candidateRows[0].payload, deliveredRows[0].payload]);
  assert.ok(!dumped.includes('BODYA'), 'no relevance-row body in the emitted markers');
  assert.ok(!dumped.includes('固'.repeat(40)), 'no fixed-row body in the emitted markers');
  console.log(`[2] events=${log.types().join(',')} adoptRate=${deliveredRows[0].payload.adoptRate}`);
});

test('3) nothing adopted → delivered items 0 and adoptRate 0 (pure and real path)', async () => {
  const rows = [row('m-a', 'BODYA 还没交付'), row('m-b', 'BODYB 也还没交付')];
  const block = composeInjectionBlock({ matched: rows });
  const pure = composeMemoryItemMarkers({ turn: 1, prepared: block.prepared, deliveredIds: [] });
  assert.deepEqual(pure.delivered, []);
  assert.equal(pure.candidate.length, 2);
  assert.equal(pure.adoptRate, 0);

  // A zero-character budget prepares the rows but adopts none: the status block is what enters
  // the request, so the pair is still emitted — candidate 2 / delivered 0 / adoptRate 0.
  const log = eventLog();
  const result = await prepareMemoryInjection({
    memory: {
      fixedMemories: () => [],
      recall: () => ({ hits: rows.map((item) => ({ ...item })), mode: 'keyword' }),
      listArchive: () => [],
      restore: () => {},
    },
    log,
    sessionId: 'marker-no-adopt',
    turn: 2,
    query: '周末的安排',
    limits: { maxChars: 0 },
  });
  assert.equal(result.injected, false);
  assert.equal(result.status, true, 'the status note is what reached the request');
  const delivered = log.rows(MEMORY_ITEM_DELIVERED_EVENT);
  assert.equal(delivered.length, 1);
  assert.deepEqual(delivered[0].payload.items, []);
  assert.equal(delivered[0].payload.adoptRate, 0);
  assert.equal(log.rows(MEMORY_ITEM_CANDIDATE_EVENT)[0].payload.items.length, 2);
  console.log('[3] prepared=2 → delivered items 0, adoptRate 0 (status path still marks the pair)');
});

test('4) duplicate ids collapse and markers are stable and rank-ordered', () => {
  const prepared = [
    { row: row('same', 'BODY 第一条'), kind: 'hit', chars: 40 },
    { row: row('same', 'BODY 重复出现'), kind: 'hit', chars: 40 },
    { row: { messageId: 'msg-only', ts: TS, role: 'user', text: 'BODY 只有 messageId', kind: 'pair' }, chars: 30 },
    { row: row('m-c', 'BODY 最后一条'), kind: 'neighbor', chars: 20 },
  ];
  const first = composeMemoryItemMarkers({ turn: 5, prepared, deliveredIds: ['same', 'same', 'm-c'] });
  const second = composeMemoryItemMarkers({ turn: 5, prepared, deliveredIds: ['same', 'same', 'm-c'] });
  assert.deepEqual(first, second, 'the same input yields the same marks');
  assert.deepEqual(first.delivered.map((item) => item.id), ['same', 'm-c'], 'the duplicate id marks one item');
  assert.deepEqual(first.candidate.map((item) => item.id), ['msg-only']);
  assert.deepEqual(first.delivered.map((item) => item.rank), [1, 3], 'rank keeps the prepared position');
  assert.deepEqual(first.candidate.map((item) => item.rank), [2]);
  assert.equal(first.delivered[0].kind, 'hit');
  assert.equal(first.candidate[0].kind, 'pair', 'a message-level row keeps its lane kind');
  assert.equal(first.candidate[0].id, 'msg-only', 'messageId is the stable id fallback');
  assert.equal('entityKey' in first.delivered[0], false, 'no entity key is invented');

  const withEntity = composeMemoryItemMarkers({
    prepared: [{ row: row('entity-1', 'BODY', { entityKey: 'person:lin' }), chars: 10 }],
    deliveredIds: ['entity-1'],
  });
  assert.equal(withEntity.delivered[0].entityKey, 'person:lin', 'an existing entity key is passed through');

  assert.equal(memoryAdoptRate(0, 0), 0, 'nothing prepared adopts nothing');
  assert.equal(memoryAdoptRate(0, 4), 0);
  assert.equal(memoryAdoptRate(2, 3), 0.667);
  assert.equal(memoryAdoptRate(3, 3), 1);
  assert.equal(memoryAdoptRate(9, 3), 1, 'the ratio never exceeds 1');
  console.log(`[4] dup collapsed, ranks=${first.delivered.map((item) => item.rank).join('/')}, `
    + `adoptRate(2/3)=${memoryAdoptRate(2, 3)}`);
});

test('5) everything adopted → candidate [] and adoptRate 1', () => {
  const rows = [row('m-a', 'BODYA'), row('m-b', 'BODYB')];
  const block = composeInjectionBlock({ matched: rows });
  const marks = composeMemoryItemMarkers({ prepared: block.prepared, deliveredIds: block.injectedIds });
  assert.deepEqual(marks.candidate, []);
  assert.equal(marks.delivered.length, 2);
  assert.equal(marks.adoptRate, 1);
  assert.deepEqual(marks.delivered.map((item) => item.id), ['m-a', 'm-b']);
  console.log('[5] prepared=2 delivered=2 candidate=0 adoptRate=1');
});

test('6) old events unchanged; the new pair is additive and reconcilable', async () => {
  const { fixed, matched, reference } = fixedBudgetScenario();
  const log = eventLog();
  const result = await prepareMemoryInjection({
    memory: {
      fixedMemories: () => fixed.map((item) => ({ ...item })),
      recall: () => ({ hits: matched.map((item) => ({ ...item })), mode: 'keyword' }),
      listArchive: () => [],
      restore: () => {},
    },
    log,
    sessionId: 'marker-reconcile',
    turn: 9,
    query: '周末的安排',
  });
  // Same content, same budget, same rendered ids as the block alone: markers changed nothing.
  assert.equal(result.text, reference.text);
  assert.deepEqual(result.injectedIds, reference.injectedIds);

  // The old events still fire in their old order and keep their old shape; the aggregate pair is
  // appended after them, exactly once.
  assert.deepEqual(log.types(), [
    'memory.budget.overflow',
    'memory.injection',
    'memory.recall',
    MEMORY_ITEM_CANDIDATE_EVENT,
    MEMORY_ITEM_DELIVERED_EVENT,
  ]);
  const recall = log.rows('memory.recall')[0].payload;
  const injection = log.rows('memory.injection')[0].payload;
  assert.equal(recall.injected, true);
  assert.equal(recall.hits, 4, 'recall still counts every prepared row (fixed + relevance)');
  assert.equal(recall.records, 3, 'records still counts the adopted rows only');
  assert.equal(recall.fixedRecords, 2);
  assert.equal(injection.hits, 1);
  assert.equal(injection.skippedByChars, 1);

  // The reconciliation the marker layer exists for.
  const delivered = log.rows(MEMORY_ITEM_DELIVERED_EVENT)[0].payload;
  const candidate = log.rows(MEMORY_ITEM_CANDIDATE_EVENT)[0].payload;
  assert.equal(delivered.items.length, recall.records, 'delivered items = memory.recall.records');
  assert.equal(candidate.items.length + delivered.items.length, reference.prepared.length,
    'candidate + delivered = the prepared set');
  assert.equal(delivered.adoptRate, memoryAdoptRate(delivered.items.length, reference.prepared.length));
  console.log(`[6] events=${log.types().length}, prepared=${reference.prepared.length}, `
    + `delivered=${delivered.items.length}=recall.records, adoptRate=${delivered.adoptRate}`);
});

test('7) a quiet recall (nothing prepared) writes no marker line', async () => {
  const log = eventLog();
  const result = await prepareMemoryInjection({
    memory: {
      fixedMemories: () => [],
      recall: () => ({ hits: [], mode: 'keyword' }),
      listArchive: () => [],
      restore: () => {},
    },
    log,
    sessionId: 'marker-miss',
    turn: 4,
    query: '没有这条记忆',
  });
  assert.equal(result.injected, false);
  assert.equal(log.rows('memory.recall').length, 1, 'the miss is still observable on the old event');
  assert.equal(log.rows(MEMORY_ITEM_CANDIDATE_EVENT).length, 0);
  assert.equal(log.rows(MEMORY_ITEM_DELIVERED_EVENT).length, 0);
  console.log(`[7] miss → ${log.types().join(',') || '(no event)'} (no item marks)`);
});
