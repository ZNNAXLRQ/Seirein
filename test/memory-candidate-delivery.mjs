/**
 * P-52: extraction candidate vs actual delivery vs long-term persistence.
 *
 * The state machine is deliberately three separate facts:
 *   candidate  — extracted, NOT in `memory_event`, invisible to search/recall/brief, not counted
 *                as delivered anywhere;
 *   delivered  — one turn actually put it in front of the model (event `memory.delivered`), at
 *                most once per memory, so a replay in the same turn is a no-op;
 *   persisted  — only a delivered candidate may be written to long-term memory
 *                (`memory.persisted`); then and only then can recall see it.
 *
 * Undelivered candidates expire after 24 h via `pruneCandidates()` (also called by `maintain()`);
 * delivered/persisted rows are never removed by that rule. None of this changes recall selection,
 * its budgets/thresholds, or the capacity/fade lifecycle.
 *
 * Run: node --test test/memory-candidate-delivery.mjs
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { CANDIDATE_TTL_MS, MemoryStore } from '../src/host/memory/store.js';

async function tempRoot(prefix = 'dsh-mem-candidate-') {
  return mkdtemp(join(tmpdir(), prefix));
}

async function cleanup(root, memory) {
  try {
    memory.close();
  } catch {
    /* already closed */
  }
  await rm(root, { recursive: true, force: true }).catch(() => {});
}

function eventLog() {
  const events = [];
  return {
    events,
    types: () => events.map((entry) => entry.type),
    matching: (type) => events.filter((entry) => entry.type === type),
    onEvent(type, payload) {
      events.push({ type, payload });
    },
  };
}

test('1) an extraction candidate stays candidate and is invisible to every read path', async (t) => {
  const root = await tempRoot();
  const log = eventLog();
  const memory = new MemoryStore(root, { capacity: 5000, onEvent: log.onEvent });
  t.after(() => cleanup(root, memory));

  const staged = memory.stageCandidate({
    id: 'cand-1',
    text: '我下周三要去上海出差',
    source: 'auto',
    reason: 'extracted',
  });
  assert.equal(staged.created, true);
  assert.equal(staged.state, 'candidate');
  assert.equal(memory.candidateState('cand-1'), 'candidate');

  // The candidate event is the only thing it produced.
  assert.deepEqual(log.matching('memory.candidate').map((entry) => entry.payload), [
    { id: 'cand-1', source: 'auto', reason: 'extracted' },
  ]);
  assert.equal(log.matching('memory.delivered').length, 0);
  assert.equal(log.matching('memory.persisted').length, 0);

  // Not delivered, not long-term, not capacity.
  assert.deepEqual(memory.deliveryStats(), { candidate: 1, delivered: 0, persisted: 0, total: 1 });
  assert.equal(memory.usage().records, 0, 'a candidate costs no capacity');
  assert.equal(memory.getActiveById('cand-1'), null, 'a candidate is not an active memory');
  assert.equal(memory.search({ query: '上海' }).hits.length, 0, 'search never sees a candidate');
  assert.equal(memory.recall({ query: '上海' }).hits.length, 0, 'recall never sees a candidate');
  assert.equal(memory.brief({ query: '上海' }).matched.length, 0, 'brief never sees a candidate');
});

test('2) delivery moves exactly the candidate to delivered, once, with one event', async (t) => {
  const root = await tempRoot();
  const log = eventLog();
  const memory = new MemoryStore(root, { capacity: 5000, onEvent: log.onEvent });
  t.after(() => cleanup(root, memory));

  memory.stageCandidate({ id: 'cand-a', text: '明天下午三点开会' });
  memory.stageCandidate({ id: 'cand-b', text: '周五交报告' });
  const first = memory.deliverCandidates(['cand-a'], { turn: 7 });
  assert.deepEqual(first, { delivered: ['cand-a'], count: 1 });
  assert.equal(memory.candidateState('cand-a'), 'delivered');
  assert.equal(memory.candidateState('cand-b'), 'candidate');
  assert.deepEqual(log.matching('memory.delivered').map((entry) => entry.payload), [
    { id: 'cand-a', turn: 7, count: 1 },
  ]);
  assert.deepEqual(memory.deliveryStats(), { candidate: 1, delivered: 1, persisted: 0, total: 2 });

  // Same turn again (and a different turn, and an unknown id) is a no-op: one delivery per memory.
  assert.deepEqual(memory.deliverCandidates(['cand-a'], { turn: 7 }), { delivered: [], count: 0 });
  assert.deepEqual(memory.deliverCandidates(['cand-a'], { turn: 8 }), { delivered: [], count: 0 });
  assert.deepEqual(memory.deliverCandidates(['missing'], { turn: 7 }), { delivered: [], count: 0 });
  assert.equal(log.matching('memory.delivered').length, 1, 'a replay emits no second delivered event');
  assert.deepEqual(memory.deliveryStats(), { candidate: 1, delivered: 1, persisted: 0, total: 2 });
});

test('3) only a delivered candidate may be persisted; persistence is the long-term write', async (t) => {
  const root = await tempRoot();
  const log = eventLog();
  const memory = new MemoryStore(root, { capacity: 5000, onEvent: log.onEvent });
  t.after(() => cleanup(root, memory));

  memory.stageCandidate({ id: 'cand-p', text: 'I prefer oolong tea without sugar' });
  const refused = memory.persistCandidate('cand-p');
  assert.equal(refused.persisted, false);
  assert.equal(refused.reason, 'not-delivered');
  assert.equal(memory.candidateState('cand-p'), 'candidate');
  assert.equal(log.matching('memory.persisted').length, 0, 'an undelivered candidate is never persisted');

  memory.deliverCandidates(['cand-p'], { turn: 3 });
  const written = memory.persistCandidate('cand-p', { domain: 'chat', kind: 'event' });
  assert.equal(written.persisted, true);
  assert.equal(written.deduped, false);
  assert.equal(memory.candidateState('cand-p'), 'persisted');
  assert.deepEqual(log.matching('memory.persisted').map((entry) => entry.payload), [{ id: 'cand-p' }]);
  assert.deepEqual(memory.deliveryStats(), { candidate: 0, delivered: 0, persisted: 1, total: 1 });

  // It is now a real memory: active by id, recallable, and the only row charged to capacity.
  const active = memory.getActiveById(written.memoryId);
  assert.equal(active.text, 'I prefer oolong tea without sugar');
  assert.equal(memory.usage().records, 1);
  assert.ok(memory.recall({ query: 'oolong tea' }).hits.length >= 1, 'a persisted memory is recallable');

  // Re-persisting is idempotent: no second event, no second row.
  const again = memory.persistCandidate('cand-p');
  assert.deepEqual(again, { persisted: true, deduped: true, memoryId: written.memoryId });
  assert.equal(log.matching('memory.persisted').length, 1);
  assert.equal(memory.usage().records, 1);
});

test('4) expired candidates are pruned; delivered/persisted rows survive', async (t) => {
  const root = await tempRoot();
  const log = eventLog();
  const memory = new MemoryStore(root, { capacity: 5000, onEvent: log.onEvent });
  t.after(() => cleanup(root, memory));

  const now = Date.parse('2026-11-07T10:00:00.000Z');
  const old = new Date(now - CANDIDATE_TTL_MS - 60_000).toISOString();
  const fresh = new Date(now).toISOString();

  memory.stageCandidate({ id: 'old-candidate', text: '八折券', ts: old });
  memory.stageCandidate({ id: 'old-delivered', text: '已交付的候选', ts: old });
  memory.stageCandidate({ id: 'old-persisted', text: '已写入的候选', ts: old });
  memory.deliverCandidates(['old-delivered'], { turn: 1 });
  memory.deliverCandidates(['old-persisted'], { turn: 2 });
  const kept = memory.persistCandidate('old-persisted', { kind: 'event' });
  memory.stageCandidate({ id: 'fresh-candidate', text: '还没交付', ts: fresh });

  const pruned = memory.pruneCandidates({ now: new Date(now) });
  assert.deepEqual(pruned, { removed: 1, ids: ['old-candidate'] });
  assert.equal(memory.candidateState('old-candidate'), null, 'only the expired candidate is gone');
  assert.equal(memory.candidateState('old-delivered'), 'delivered');
  assert.equal(memory.candidateState('old-persisted'), 'persisted');
  assert.equal(memory.candidateState('fresh-candidate'), 'candidate');
  assert.deepEqual(memory.deliveryStats(), { candidate: 1, delivered: 1, persisted: 1, total: 3 });
  assert.ok(memory.getActiveById(kept.memoryId), 'the persisted long-term row is untouched');
  assert.deepEqual(log.matching('memory.candidate.expired').map((entry) => entry.payload), [
    { ids: ['old-candidate'], count: 1, maxAgeMs: CANDIDATE_TTL_MS },
  ]);

  // The maintenance path runs the same rule (real clock): an old candidate is collected.
  memory.stageCandidate({
    id: 'old-maintained',
    text: '维护时清理',
    ts: new Date(Date.now() - CANDIDATE_TTL_MS - 60_000).toISOString(),
  });
  const maintained = memory.maintain();
  assert.equal(memory.candidateState('old-maintained'), null, 'maintain() prunes expired candidates');
  assert.equal(maintained.candidatesPruned >= 1, true);
  assert.equal(memory.getActiveById(kept.memoryId).id, kept.memoryId);
});
