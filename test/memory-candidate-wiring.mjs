/**
 * P-52 wiring: the candidate three-state ledger is driven by the ONE place memory enters a turn.
 *
 * `prepareMemoryInjection` decides which rows the block renders; `createMemoryPreStep` appends the
 * block to the `agent/pre-step` decision and only the observable `user/message` write of that
 * block means "the model saw it". At that point — and only then — the host hands exactly the
 * rendered ids to `deliverCandidates`, which the store makes idempotent (a replay moves nothing
 * and emits no second `memory.delivered`). After delivery, the long-term rule decides whether a
 * delivered candidate is written to `memory_event`: only an explicitly retained record
 * (`source === 'manual'`, the >= 50 manual band) is persisted; automatic extraction stays
 * `delivered` and expires with the 24 h candidate TTL.
 *
 * The store owns `memory.candidate` / `memory.delivered` / `memory.persisted`; the host adds no
 * second event. Recall selection, its budgets and its thresholds are untouched — the rows below
 * only stand in for what a retrieval lane would hand to the assembly.
 *
 * Run: node --test test/memory-candidate-wiring.mjs
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { candidatePersistsLongTerm, createMemoryPreStep } from '../src/host/index.js';
import { MemoryStore } from '../src/host/memory/store.js';

async function tempRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mem-candidate-wiring-'));
  t.after(() => rm(root, { recursive: true, force: true }).catch(() => {}));
  return root;
}

function cleanup(store) {
  try {
    store.close();
  } catch {
    /* already closed */
  }
}

/** In-memory stand-in for `data/events.jsonl`; the store's own hook feeds it. */
function eventLog() {
  const events = [];
  return {
    events,
    onEvent(type, payload) {
      events.push({ type, payload });
    },
    matching: (type) => events.filter((entry) => entry.type === type),
    async emit() {
      /* the host's own event log is not under test here */
    },
  };
}

/** One genuine user message, the shape `agent/pre-step` claims and the harness logs. */
function userMessage(text, id = 'u-wire') {
  return { id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] };
}

const nextFor = (messages) => async () => ({ kind: 'enter', messages: [...messages] });

function agentFor(sessionId = 'wire-session') {
  return {
    id: `agent-${sessionId}`,
    session: { id: sessionId, header: { cwd: 'C:/workspace' } },
  };
}

function preStepPayload({ agent, turn = 1, messages }) {
  return { agent, turn, step: 1, signal: new AbortController().signal, messages };
}

/**
 * The real store owns the ledger. Only `recall` is stubbed: candidates are invisible to the real
 * read paths by design, so the rows here stand in for what a retrieval lane would hand over.
 */
function hookedMemory(store, recallRows) {
  return {
    fixedMemories: () => [],
    recall: () => ({
      hits: recallRows.map((row) => ({ ...row })),
      mode: 'keyword',
      roles: ['user', 'assistant'],
      window: 1,
      from: null,
      to: null,
      relaxed: false,
    }),
    listArchive: () => [],
    restore: () => {},
    deliverCandidates: (ids, options) => store.deliverCandidates(ids, options),
    persistCandidate: (id, options) => store.persistCandidate(id, options),
    candidateState: (id) => store.candidateState(id),
    deliveryStats: () => store.deliveryStats(),
  };
}

function recallRow(id, text, { source = 'auto', importance = 30, skippedByBudget = false } = {}) {
  return {
    id,
    ts: '2026-11-01T00:00:00.000Z',
    role: 'user',
    text,
    source,
    importance,
    clarity: 'clear',
    skippedByBudget,
  };
}

function deliveryRow(store, id) {
  const row = store.db
    .prepare('SELECT delivery_count, delivered_turn FROM memory_candidate WHERE id = ?')
    .get(id);
  return row === undefined ? null : { count: Number(row.delivery_count), turn: row.delivered_turn };
}

function preStep({ store, recallRows, log }) {
  return createMemoryPreStep({
    memory: hookedMemory(store, recallRows),
    log,
    inScope: () => true,
    isSubagent: () => false,
    featureEnabled: () => true,
  });
}

function seed(store, entries) {
  for (const [id, text, source] of entries) {
    store.stageCandidate({ id, text, source: source ?? 'auto', reason: 'extracted' });
  }
}

// 1 ---------------------------------------------------------------------------

test('1) the block renders 2 candidates → both delivered, one event each', async (t) => {
  const root = await tempRoot(t);
  const log = eventLog();
  const store = new MemoryStore(root, { capacity: 5000, onEvent: log.onEvent });
  t.after(() => cleanup(store));
  seed(store, [['cand-a', '周末去看展'], ['cand-b', '周六下午修车'], ['cand-c', '没有被召回']]);

  const prep = preStep({
    store,
    log,
    recallRows: [recallRow('cand-a', '周末去看展'), recallRow('cand-b', '周六下午修车')],
  });
  const agent = agentFor();
  const payload = preStepPayload({ agent, messages: [userMessage('周末的安排')] });
  const decision = await prep.handle(payload, nextFor(payload.messages));

  assert.equal(decision.messages.length, 2, 'one reference block is appended');
  const injected = decision.messages.at(-1);
  assert.equal(injected.source.kind, 'assistant-memory');
  // A decision the host may still drop is not a delivery yet.
  assert.deepEqual(store.deliveryStats(), { candidate: 3, delivered: 0, persisted: 0, total: 3 });

  await prep.observe({ id: agent.session.id }, { type: 'user/message', data: injected });

  assert.deepEqual(store.deliveryStats(), { candidate: 1, delivered: 2, persisted: 0, total: 3 });
  assert.equal(store.candidateState('cand-a'), 'delivered');
  assert.equal(store.candidateState('cand-b'), 'delivered');
  assert.equal(store.candidateState('cand-c'), 'candidate');
  const events = log.matching('memory.delivered');
  assert.equal(events.length, 2, 'exactly one delivery event per delivered candidate');
  assert.deepEqual(events.map((entry) => entry.payload), [
    { id: 'cand-a', turn: 1, count: 1 },
    { id: 'cand-b', turn: 1, count: 1 },
  ]);
  assert.deepEqual(deliveryRow(store, 'cand-a'), { count: 1, turn: '1' });
  assert.deepEqual(deliveryRow(store, 'cand-b'), { count: 1, turn: '1' });
  assert.equal(log.matching('memory.persisted').length, 0, 'delivery alone never persists');
  console.log('[1] injected 2/3 → delivered=2, events=2, cand-c stays candidate');
});

// 2 ---------------------------------------------------------------------------

test('2) a replay inside the same turn delivers once (delivery_count stays 1)', async (t) => {
  const root = await tempRoot(t);
  const log = eventLog();
  const store = new MemoryStore(root, { capacity: 5000, onEvent: log.onEvent });
  t.after(() => cleanup(store));
  seed(store, [['cand-a', '周末去看展'], ['cand-b', '周六下午修车']]);

  const prep = preStep({
    store,
    log,
    recallRows: [recallRow('cand-a', '周末去看展'), recallRow('cand-b', '周六下午修车')],
  });
  const agent = agentFor();
  const payload = preStepPayload({ agent, messages: [userMessage('周末的安排')] });
  const first = await prep.handle(payload, nextFor(payload.messages));
  const second = await prep.handle(payload, nextFor(payload.messages));

  assert.equal(first.messages.length, 2, 'the first call injects');
  assert.equal(second.messages.length, 1, 'the dedup key refuses a second block in the same turn');
  const injected = first.messages.at(-1);
  await prep.observe({ id: agent.session.id }, { type: 'user/message', data: injected });
  await prep.observe({ id: agent.session.id }, { type: 'user/message', data: injected });
  assert.equal(log.matching('memory.delivered').length, 2, 'a replayed event delivers nothing new');
  assert.deepEqual(store.deliveryStats(), { candidate: 0, delivered: 2, persisted: 0, total: 2 });

  // A rebuilt agent (new instance) may inject again in the same turn; the store still refuses to
  // count the same memory twice — one memory, one turn, one delivery.
  const retryAgent = agentFor();
  const retryPayload = preStepPayload({ agent: retryAgent, messages: [userMessage('周末的安排')] });
  const retry = await prep.handle(retryPayload, nextFor(retryPayload.messages));
  assert.equal(retry.messages.length, 2, 'a rebuilt agent obtains its own block');
  await prep.observe({ id: retryAgent.session.id }, { type: 'user/message', data: retry.messages.at(-1) });

  assert.equal(log.matching('memory.delivered').length, 2, 'no second delivery event');
  assert.deepEqual(store.deliveryStats(), { candidate: 0, delivered: 2, persisted: 0, total: 2 });
  assert.deepEqual(deliveryRow(store, 'cand-a'), { count: 1, turn: '1' });
  assert.deepEqual(deliveryRow(store, 'cand-b'), { count: 1, turn: '1' });
  console.log('[2] handle×2 + observe×2 + rebuilt retry → delivery_count=1, events=2');
});

// 3 ---------------------------------------------------------------------------

test('3) candidates the block does not render stay candidate', async (t) => {
  const root = await tempRoot(t);
  const log = eventLog();
  const store = new MemoryStore(root, { capacity: 5000, onEvent: log.onEvent });
  t.after(() => cleanup(store));
  seed(store, [
    ['cand-shown', '周四的评审会'],
    ['cand-budget', '被检索预算丢掉的一条'],
    ['cand-never', '根本没有被召回'],
  ]);

  const prep = preStep({
    store,
    log,
    recallRows: [
      recallRow('cand-shown', '周四的评审会'),
      // Found at retrieval level but carrying no body: the assembly filters it out.
      recallRow('cand-budget', '', { skippedByBudget: true }),
    ],
  });
  const agent = agentFor();
  const payload = preStepPayload({ agent, messages: [userMessage('评审会')] });
  const decision = await prep.handle(payload, nextFor(payload.messages));
  const injected = decision.messages.at(-1);
  assert.ok(injected.content[0].text.includes('周四的评审会'), 'the delivered row is in the block');
  assert.ok(!injected.content[0].text.includes('被检索预算丢掉的一条'), 'the skipped row is not');

  await prep.observe({ id: agent.session.id }, { type: 'user/message', data: injected });

  assert.deepEqual(store.deliveryStats(), { candidate: 2, delivered: 1, persisted: 0, total: 3 });
  assert.equal(store.candidateState('cand-shown'), 'delivered');
  assert.equal(store.candidateState('cand-budget'), 'candidate', 'found but not injected stays candidate');
  assert.equal(store.candidateState('cand-never'), 'candidate', 'never recalled stays candidate');
  assert.deepEqual(log.matching('memory.delivered').map((entry) => entry.payload), [
    { id: 'cand-shown', turn: 1, count: 1 },
  ]);
  console.log('[3] shown→delivered; budget-skipped and never-recalled stay candidate');
});

// 4 ---------------------------------------------------------------------------

test('4) only an explicitly retained (manual) candidate becomes long-term memory', async (t) => {
  const root = await tempRoot(t);
  const log = eventLog();
  const store = new MemoryStore(root, { capacity: 5000, onEvent: log.onEvent });
  t.after(() => cleanup(store));
  seed(store, [
    ['cand-manual', 'I prefer oolong tea without sugar', 'manual'],
    ['cand-auto', '周五下班后打羽毛球', 'auto'],
  ]);

  // The policy is a pure predicate: delivery is never retention by itself.
  assert.equal(candidatePersistsLongTerm({ source: 'auto', importance: 95 }), false);
  assert.equal(candidatePersistsLongTerm({ source: 'manual', importance: 30 }), false);
  assert.equal(candidatePersistsLongTerm({ source: 'manual', importance: 60 }), true);

  const prep = preStep({
    store,
    log,
    recallRows: [
      recallRow('cand-manual', 'I prefer oolong tea without sugar', { source: 'manual', importance: 60 }),
      recallRow('cand-auto', '周五下班后打羽毛球', { source: 'auto', importance: 60 }),
    ],
  });
  const agent = agentFor();
  const payload = preStepPayload({ agent, messages: [userMessage('乌龙茶')] });
  const decision = await prep.handle(payload, nextFor(payload.messages));
  await prep.observe({ id: agent.session.id }, { type: 'user/message', data: decision.messages.at(-1) });

  // Both were delivered; only the manual one was promoted.
  assert.deepEqual(store.deliveryStats(), { candidate: 0, delivered: 1, persisted: 1, total: 2 });
  assert.equal(store.candidateState('cand-manual'), 'persisted');
  assert.equal(store.candidateState('cand-auto'), 'delivered');
  assert.deepEqual(log.matching('memory.persisted').map((entry) => entry.payload), [{ id: 'cand-manual' }]);

  // The persisted candidate is a real long-term record: recall can see its body and only it.
  const found = store.recall({ query: 'oolong tea' });
  assert.ok(found.hits.length >= 1, 'the persisted candidate is recallable');
  assert.ok(found.hits.some((hit) => hit.text.includes('oolong tea')));
  assert.equal(store.usage().records, 1, 'exactly one row entered memory_event');
  assert.equal(store.recall({ query: '羽毛球' }).hits.length, 0, 'the auto candidate never became long-term');
  console.log('[4] manual→persisted+recallable, auto→delivered only');
});

// 5 ---------------------------------------------------------------------------

test('5) an unconfirmed block (never logged) delivers nothing', async (t) => {
  const root = await tempRoot(t);
  const log = eventLog();
  const store = new MemoryStore(root, { capacity: 5000, onEvent: log.onEvent });
  t.after(() => cleanup(store));
  seed(store, [['cand-x', '下周一的航班']]);

  const prep = preStep({ store, log, recallRows: [recallRow('cand-x', '下周一的航班')] });
  const agent = agentFor();
  const payload = preStepPayload({ agent, messages: [userMessage('航班')] });
  const decision = await prep.handle(payload, nextFor(payload.messages));
  const injected = decision.messages.at(-1);

  // The turn ends without the host ever logging the injected message (replaced/cancelled turn).
  await prep.observe({ id: agent.session.id }, { type: 'turn/end', data: { turn: 1 } });
  await prep.observe({ id: agent.session.id }, { type: 'user/message', data: injected });

  assert.deepEqual(store.deliveryStats(), { candidate: 1, delivered: 0, persisted: 0, total: 1 });
  assert.equal(store.candidateState('cand-x'), 'candidate');
  assert.equal(log.matching('memory.delivered').length, 0);
  console.log('[5] turn ended before the write → candidate stays candidate, no event');
});
