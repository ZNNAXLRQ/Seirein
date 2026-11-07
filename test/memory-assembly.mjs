/**
 * Recall assembly (2026-11-05): a direct hit is chosen before any context is expanded.
 *
 * The bug this suite pins: the old loop expanded hit #1's whole neighbourhood, then hit #2,
 * then cut at six rows — so a turn with ten neighbours could occupy every slot while a second,
 * older but independently relevant hit vanished. The new order is
 *   candidates → ranked independent hits → one explicit link hop → same-turn pairs → ±window
 *   neighbours,
 * with 6 rows / 1200 characters (labels included) as the hard block budget and 2/3 of the
 * characters reserved for direct hits.
 *
 * Run: node --test test/memory-assembly.mjs
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { composeInjectionBlock, deliveredRecallRows } from '../src/host/index.js';
import { MEMORY_ASSEMBLY, MemoryStore } from '../src/host/memory/store.js';

async function tempRoot(prefix = 'dsh-mem-assembly-') {
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

const DROP_REASONS = new Set(['rank', 'duplicate', 'record-budget', 'char-budget']);

/** `memory.assembly` payloads captured from the store's host-log hook. */
function eventLog() {
  const events = [];
  return {
    events,
    onEvent(type, payload) {
      events.push({ type, payload });
    },
  };
}

/** Accept the row, fail with a readable dump when it is missing. */
function rowFor(recalled, messageId, label) {
  const row = recalled.hits.find((hit) => hit.messageId === messageId);
  assert.ok(
    row !== undefined,
    `${label}: ${messageId} must be in the block (got ${JSON.stringify(
      recalled.hits.map((hit) => `${hit.messageId}:${hit.kind}${hit.skippedByBudget ? ':skipped' : ''}`),
    )})`,
  );
  return row;
}

const charsOf = (hits) => hits.reduce((total, hit) => total + String(hit.text ?? '').length, 0);

test('1) a ten-neighbour hit cannot push a second, older direct hit out of the block', async (t) => {
  const root = await tempRoot();
  const memory = new MemoryStore(root, { capacity: 5000 });
  t.after(() => cleanup(root, memory));

  const add = (sessionId, turnId, role, text, key = '') => memory.addMessage({
    role,
    sessionId,
    turnId,
    messageId: `${sessionId}-${turnId}-${role}${key}`,
    ts: new Date(Date.parse('2026-10-01T00:00:00.000Z') + turnId * 60_000).toISOString(),
    text,
  });

  // First direct hit: turn 5 of "storm", surrounded by ten unrelated messages in turns 3–7.
  add('storm', 5, 'user', '部署方案要用蓝绿发布，这是本次讨论的关键结论。');
  add('storm', 5, 'assistant', '好的，部署方案采用蓝绿发布。');
  for (const [turn, count] of [[3, 2], [4, 3], [6, 3], [7, 2]]) {
    for (let index = 0; index < count; index += 1) {
      add('storm', turn, index % 2 === 0 ? 'user' : 'assistant', `第${turn}轮的闲聊第${index}句，与问题无关。`, `-${index}`);
    }
  }
  // Second direct hit: an older record in another session, deliberately the "second" of two.
  add('old', 1, 'user', '更早以前我们讨论过旧方案的部署方案，是手工发布。');

  const recalled = memory.recall({ query: '部署方案', budgetChars: 1200, maxRecords: 6, window: 2 });
  const ids = recalled.hits.map((hit) => hit.messageId);
  const old = rowFor(recalled, 'old-1-user', 'the older independent hit');

  assert.equal(old.kind, 'hit', 'the older record is a direct hit, not a neighbour');
  assert.ok(ids.indexOf('old-1-user') < recalled.hits.length, 'it survived the six-row cap');
  assert.equal(
    recalled.assembly.hits,
    2,
    `both direct hits are selected (assembly=${JSON.stringify(recalled.assembly.counts ?? recalled.assembly)})`,
  );
  assert.ok(recalled.hits.length <= 6, `rows<=6 (${recalled.hits.length})`);
  assert.ok(recalled.assembly.chars <= 1200, `chars<=1200 (${recalled.assembly.chars})`);
  assert.equal(recalled.assembly.dropped.every((entry) => DROP_REASONS.has(entry.reason)), true);
  // Grouped output: the storm group stays together, then the old hit's own group.
  assert.ok(['hit', 'pair', 'neighbor'].includes(recalled.hits[0].kind));
  console.log(
    `[1] rows=${recalled.hits.length} chars=${recalled.assembly.chars} ` +
      `kinds=${recalled.hits.map((hit) => `${hit.messageId}:${hit.kind}`).join(', ')}`,
  );
  console.log('[1] before fix this block held six "storm" neighbours; the "old" hit was absent');
  console.log('[1] stage 3: the storm turn link and the old hit share the bounded context quota');
});

test('2) six rows / 1200 chars are hard caps and the soft quotas can borrow (5 hits + 1 neighbour)', async (t) => {
  const root = await tempRoot();
  const log = eventLog();
  const memory = new MemoryStore(root, { capacity: 5000, onEvent: log.onEvent });
  t.after(() => cleanup(root, memory));

  const now = Date.now();
  const base = now - 10 * 60_000;
  const add = (sessionId, turnId, role, text, offsetMs, importance = 60) => memory.addMessage({
    role,
    sessionId,
    turnId,
    messageId: `${sessionId}-${turnId}-${role}`,
    ts: new Date(base + offsetMs).toISOString(),
    text,
    importance,
  });

  // Five independent hits (different sessions/turns); the FIRST-ranked one owns the only
  // neighbour, so context is scarce and the row quota has to borrow for the fifth hit.
  for (let index = 1; index <= 5; index += 1) {
    add(
      `hit-${index}`, 1, 'user',
      `部署方案第${index}版：这是第${index}条独立的相关记录。`,
      index * 1000,
      index === 1 ? 95 : 60,
    );
  }
  add('hit-1', 2, 'user', '这一轮只是邻居：在部署方案之后随口提了一句天气。', 700);

  const recalled = memory.recall({ query: '部署方案', budgetChars: 1200, maxRecords: 6 });
  const kinds = recalled.hits.reduce((counts, hit) => {
    counts[hit.kind] = (counts[hit.kind] ?? 0) + 1;
    return counts;
  }, {});

  assert.ok(recalled.hits.length <= MEMORY_ASSEMBLY.maxRecords, `rows<=6 (${recalled.hits.length})`);
  assert.equal(recalled.assembly.hits, 5, `5 direct hits were borrowed into the slots (${JSON.stringify(kinds)})`);
  assert.equal(recalled.assembly.neighbors, 1, 'one neighbour is enough context');
  assert.equal(recalled.assembly.chars <= MEMORY_ASSEMBLY.maxChars, true, 'labels count against 1200');
  assert.ok(charsOf(recalled.hits) <= MEMORY_ASSEMBLY.maxChars);
  assert.equal(recalled.assembly.rowLimit, 6);
  assert.equal(recalled.assembly.charLimit, 1200);
  assert.equal(kinds.pair ?? 0, 0, 'no pairs exist in these single-message turns');

  const event = log.events.find((entry) => entry.type === 'memory.assembly');
  assert.ok(event !== undefined, 'memory.assembly is emitted once per recall');
  for (const key of ['hits', 'pairs', 'neighbors', 'dropped', 'chars']) {
    assert.equal(typeof event.payload[key], 'number', `event carries ${key}`);
  }
  assert.equal(event.payload.hits, recalled.assembly.hits);
  console.log(
    `[2] rows=${recalled.hits.length} kinds=${JSON.stringify(kinds)} chars=${recalled.assembly.chars} ` +
      `event=${JSON.stringify(event.payload)}`,
  );
});

test('3) a long record keeps the tail evidence (negation, date, condition), not a head prefix', async (t) => {
  const root = await tempRoot();
  const memory = new MemoryStore(root, { capacity: 5000 });
  t.after(() => cleanup(root, memory));

  const evidence = '但注意：并不是周四发布，部署方案只在 2026-11-07 且灰度通过后才生效。';
  const body = `${'背景说明，'.repeat(400)}${evidence}`;
  assert.ok(body.length > 2000);
  assert.equal(body.endsWith(evidence), true);

  memory.addMessage({
    role: 'user',
    sessionId: 'long', turnId: 1, messageId: 'long-1',
    ts: '2026-10-30T09:00:00.000Z', text: body,
  });
  // A first-ranked shorter hit, so the long body is not the only candidate for the budget.
  memory.addMessage({
    role: 'user',
    sessionId: 'short', turnId: 1, messageId: 'short-1',
    ts: '2026-10-30T10:00:00.000Z', text: '部署方案先按老流程走，细节稍后补充。',
  });

  const recalled = memory.recall({ query: '部署方案', budgetChars: 1200, maxRecords: 6 });
  const long = rowFor(recalled, 'long-1', 'the long record');
  assert.equal(long.kind, 'hit');
  assert.ok(long.text.includes('并不是周四'), 'the negation survives the snippet');
  assert.ok(long.text.includes('2026-11-07'), 'the date survives the snippet');
  assert.ok(long.text.includes('灰度通过'), 'the condition survives the snippet');
  assert.equal(long.containsEvidence, true);
  assert.equal(long.displayEnd, body.length, 'the delivered window ends at the tail evidence');
  assert.ok(long.displayStart > 0, 'the generic head was skipped');
  assert.ok(long.text.length <= 400, `the snippet stays within the per-row budget (${long.text.length})`);
  console.log(
    `[3] tail evidence kept: containsEvidence=${long.containsEvidence} chars=${long.text.length} ` +
      `window=${long.displayStart}..${long.displayEnd}`,
  );
});

test('4) char-budget drops are not reinforced; a delivered neighbour is reinforced once, not twice', async (t) => {
  const root = await tempRoot();
  const memory = new MemoryStore(root, { capacity: 5000 });
  t.after(() => cleanup(root, memory));

  const body = (label) => `月光方案${label}：${'填充说明，'.repeat(160)}`;
  const add = (sessionId, turnId, role, text) => memory.addMessage({
    role, sessionId, turnId, messageId: `${sessionId}-${turnId}-${role}`,
    ts: new Date(Date.parse('2026-11-04T10:00:00.000Z') + turnId * 60_000 + sessionId.length).toISOString(),
    text, importance: 60, clarity: 'fuzzy',
  });

  add('p', 1, 'user', body('第一条'));
  add('p', 1, 'assistant', '好的，这是同一轮的答复，不含查询词。');
  add('p', 2, 'user', `第二轮是邻居，没有查询词：${'闲聊，'.repeat(40)}`);
  add('q', 1, 'user', body('第二条'));
  add('r', 1, 'user', body('第三条'));

  const recalled = memory.recall({ query: '月光', budgetChars: 600, maxRecords: 6 });
  const skipped = recalled.hits.filter((hit) => hit.skippedByBudget === true);
  // Every row whose body was delivered (the stage-3 `turn` link replaces the old pair row here).
  const delivered = recalled.hits.filter(
    (hit) => hit.skippedByBudget !== true && String(hit.text ?? '').trim().length > 0,
  );
  // The subset allowed to collect recall feedback: a `link` row is context, never a match.
  const reinforced = deliveredRecallRows(recalled.hits);
  assert.equal(recalled.hits.length, 5, `three hits + link + neighbour (${recalled.hits.length})`);
  assert.equal(skipped.length, 2, 'two direct hits lost the character budget');
  assert.equal(skipped.every((hit) => hit.text === '' && hit.containsEvidence === false), true);
  assert.equal(
    recalled.assembly.dropped.filter((entry) => entry.reason === 'char-budget').length,
    2,
    `dropped reasons = ${JSON.stringify(recalled.assembly.dropped)}`,
  );
  assert.equal(delivered.length, 3, 'the link and the neighbour were delivered, the two hits were not');
  assert.equal(delivered.filter((hit) => hit.kind === 'link').length, 1, 'the turn link is marked link');
  assert.equal(reinforced.length, 2, 'the link is delivered but excluded from reinforcement');
  const neighbour = recalled.hits.find((hit) => hit.kind === 'neighbor');
  assert.ok(neighbour !== undefined, 'the neighbour is marked as such');
  assert.equal(neighbour.skippedByBudget, false);

  // recall() itself never reinforces: the delivery path owns that decision.
  const read = memory.db.prepare('SELECT id, clarity, importance, recall_count FROM memory_event WHERE id = ?');
  const before = recalled.hits.map((hit) => ({ ...read.get(hit.id) }));
  assert.equal(before.every((row) => row.recall_count === 0), true, 'recall wrote no feedback');
  assert.equal(before.every((row) => row.importance === 60 && row.clarity === 'fuzzy'), true);

  memory.restore(reinforced.map((hit) => hit.id));
  const after = new Map(recalled.hits.map((hit) => [hit.id, { ...read.get(hit.id) }]));
  for (const hit of recalled.hits) {
    const row = after.get(hit.id);
    if (hit.skippedByBudget === true || hit.kind === 'link') {
      assert.equal(row.importance, 60, `not reinforced: ${hit.id}`);
      assert.equal(row.clarity, 'fuzzy', `not reinforced: ${hit.id}`);
      assert.equal(row.recall_count, 0, 'no recall credit for a dropped or linked row');
    } else {
      assert.equal(row.importance, 62, `delivered ${hit.id} is reinforced exactly once`);
      assert.equal(row.recall_count, 1, 'exactly one recall credit');
    }
  }
  assert.equal(
    recalled.hits.filter((hit) => hit.id === neighbour.id).length,
    1,
    'the neighbour appears once, so it cannot be reinforced twice',
  );
  console.log(
    `[4] rows=${recalled.hits.length} delivered=${delivered.length} skipped=${skipped.length} ` +
      `neighbour=${neighbour.messageId} importance(neighbour)=${after.get(neighbour.id).importance}`,
  );
});

test('5) a context question raises the context share; a fact question keeps direct hits first', async (t) => {
  const root = await tempRoot();
  const memory = new MemoryStore(root, { capacity: 5000 });
  t.after(() => cleanup(root, memory));

  const now = Date.now();
  const seed = () => {
    for (let index = 1; index <= 6; index += 1) {
      const turnId = 1;
      memory.addMessage({
        role: 'user', sessionId: `ctx-${index}`, turnId, messageId: `ctx-${index}-u`,
        ts: new Date(now - index * 60_000).toISOString(),
        text: `部署方案第${index}轮：用户描述需求。`,
      });
      memory.addMessage({
        role: 'assistant', sessionId: `ctx-${index}`, turnId, messageId: `ctx-${index}-a`,
        ts: new Date(now - index * 60_000 + 1000).toISOString(),
        text: `部署方案第${index}轮：助手给出回答。`,
      });
    }
  };
  seed();

  // Same candidate pool; only the question type differs.
  const contextual = memory.recall({ query: '刚才那段对话前后说了什么', budgetChars: 1200, maxRecords: 6 });
  const factual = memory.recall({ query: '部署方案', budgetChars: 1200, maxRecords: 6 });

  const share = (recalled) => recalled.assembly.links + recalled.assembly.pairs + recalled.assembly.neighbors;
  assert.equal(contextual.assembly.contextual, true, 'the context question is recognised');
  assert.equal(factual.assembly.contextual, false, 'the fact question is not');
  assert.equal(contextual.assembly.hits + share(contextual), 6);
  assert.equal(factual.assembly.hits + share(factual), 6);
  assert.ok(
    share(contextual) > share(factual),
    `context share rises (contextual=${share(contextual)}, factual=${share(factual)})`,
  );
  assert.ok(
    contextual.assembly.hits < factual.assembly.hits,
    `fewer direct hits are forced in (contextual=${contextual.assembly.hits}, factual=${factual.assembly.hits})`,
  );
  // Stage 3: a recorded user/assistant couple is an explicit `turn` link, so same-turn context is
  // counted as `link` before the legacy pair pass gets a chance to duplicate it.
  assert.equal(
    contextual.assembly.links > 0 && factual.assembly.links > 0,
    true,
    'same-turn links fill the context share in both modes',
  );
  console.log(
    `[5] contextual: hits=${contextual.assembly.hits} links=${contextual.assembly.links} ` +
      `pairs=${contextual.assembly.pairs} neighbors=${contextual.assembly.neighbors}; factual: ` +
      `hits=${factual.assembly.hits} links=${factual.assembly.links} ` +
      `pairs=${factual.assembly.pairs} neighbors=${factual.assembly.neighbors}`,
  );
});

test('6) retrieval stays fast on a populated store and context chars are reported', async (t) => {
  const root = await tempRoot('dsh-mem-assembly-perf-');
  const memory = new MemoryStore(root, { capacity: 20_000 });
  t.after(() => cleanup(root, memory));

  const base = Date.parse('2026-11-01T00:00:00.000Z');
  let seq = 0;
  for (let session = 0; session < 40; session += 1) {
    for (let turnId = 0; turnId < 6; turnId += 1) {
      seq += 1;
      memory.addMessage({
        role: 'user', sessionId: `perf-${session}`, turnId, messageId: `perf-${session}-${turnId}-u`,
        ts: new Date(base + seq * 60_000).toISOString(),
        text: `第${session}段第${turnId}轮：${session === 0 && turnId === 0 ? '部署方案' : '日常闲聊'}的内容，附带一些填充说明。`,
      });
      memory.addMessage({
        role: 'assistant', sessionId: `perf-${session}`, turnId, messageId: `perf-${session}-${turnId}-a`,
        ts: new Date(base + seq * 60_000 + 1000).toISOString(),
        text: `第${session}段第${turnId}轮的回答：${session === 0 && turnId === 0 ? '部署方案' : '嗯嗯'}，同样带填充。`,
      });
    }
  }

  const clock = () => Number(process.hrtime.bigint()) / 1e6;
  const runs = [];
  let last = null;
  for (let index = 0; index < 15; index += 1) {
    const start = clock();
    last = memory.recall({ query: '部署方案', budgetChars: 1200, maxRecords: 6 });
    runs.push(clock() - start);
  }
  runs.sort((left, right) => left - right);
  const median = Math.round(runs[Math.floor(runs.length / 2)] * 100) / 100;
  const chars = charsOf(last.hits);
  assert.ok(median < 50, `median recall stays well under 50ms (${median}ms)`);
  assert.ok(last.hits.length <= 6);
  assert.equal(last.assembly.chars >= chars, true, 'the event chars include the per-row labels');
  console.log(
    `[6] 480 rows: median=${median}ms min=${Math.round(runs[0] * 100) / 100}ms ` +
      `max=${Math.round(runs[runs.length - 1] * 100) / 100}ms rows=${last.hits.length} ` +
      `bodyChars=${chars} assemblyChars=${last.assembly.chars}`,
  );
  console.log('[6] pre-change baseline (same seed, HEAD store): median≈0.34ms, 4 rows, 88 body chars');
});
/**
 * Recall assembly, (pass 2, same day): the 1200-character block budget is a hard cap.
 *
 * The bug this pins: `place()` spent `shown.text.length + labelChars` without checking the cap,
 * and a `budgetOverflow` snippet (the whole evidence phrase preserved past its per-row window)
 * let `used` jump past 1200 — a reproduction measured 1491 chars on a 1200 budget. The fix prices
 * every row before placing it (label included), gives a row whose window is too small one
 * compressed retry inside the room that is left, and records `char-budget` in `dropped` when even
 * that does not fit. `assembly.chars` can never exceed `assembly.charLimit`.
 */

/** The whole point: whatever the shape, the reported width never exceeds the reported limit. */
function assertHardCap(recalled, label) {
  const { assembly } = recalled;
  assert.equal(
    assembly.chars <= assembly.charLimit,
    true,
    `${label}: chars<=charLimit (${assembly.chars} > ${assembly.charLimit})`,
  );
  assert.equal(
    assembly.charLimit <= MEMORY_ASSEMBLY.maxChars,
    true,
    `${label}: the limit itself never passes the contract (${assembly.charLimit})`,
  );
  const spent = recalled.hits
    .filter((hit) => hit.skippedByBudget !== true)
    .reduce((total, hit) => total + String(hit.text ?? '').length + MEMORY_ASSEMBLY.labelChars, 0);
  assert.equal(assembly.chars >= spent, true, `${label}: chars counts labels and bodies (${spent})`);
  return assembly;
}

/** Body chars plus one label per delivered row — what `assembly.chars` must equal exactly. */
const labelledChars = (hits) => hits.reduce(
  (total, hit) => total + String(hit.text ?? '').length + MEMORY_ASSEMBLY.labelChars,
  0,
);

const lastEvent = (log, type) => log.events.filter((entry) => entry.type === type).at(-1)?.payload ?? null;

/** The drops the character budget caused, as opposed to ranking or duplicate losses. */
const charBudgetDrops = (assembly) => assembly.dropped.filter((entry) => entry.reason === 'char-budget');

const addAt = (memory, { sessionId, turnId = 1, role = 'user', messageId, ts, text, importance = 60 }) => memory
  .addMessage({ role, sessionId, turnId, messageId, ts, text, importance });

test('7) a 2000-char hit is compressed with its evidence; what cannot fit is skipped and dropped', async (t) => {
  const root = await tempRoot();
  const log = eventLog();
  const memory = new MemoryStore(root, { capacity: 5000, onEvent: log.onEvent });
  t.after(() => cleanup(root, memory));

  // Four long hits, together four times the block budget: delivered rows must be clipped around
  // the evidence (never a head prefix), and the surplus row may not overspend to stay visible.
  const evidence = (index) => `但注意：并不是周四发布，部署方案第${index}版只在 2026-11-07 且灰度通过后才生效。`;
  const body = (index) => `${'背景说明，'.repeat(400)}${evidence(index)}`;
  for (let index = 1; index <= 4; index += 1) {
    assert.ok(body(index).length > 2000, 'each seeded body is longer than the whole block');
    addAt(memory, {
      sessionId: `long-${index}`, turnId: 1, messageId: `long-${index}-1`,
      ts: new Date(Date.parse('2026-11-04T10:00:00.000Z') + index * 60_000).toISOString(),
      text: body(index),
    });
  }

  const recalled = memory.recall({ query: '部署方案', budgetChars: 1200, maxRecords: 6 });
  const assembly = assertHardCap(recalled, 'long hits');
  assert.equal(assembly.charLimit, 1200);
  const delivered = deliveredRecallRows(recalled.hits);
  const skipped = recalled.hits.filter((hit) => hit.skippedByBudget === true);
  assert.ok(delivered.length >= 1, 'at least one long hit is delivered compressed');
  assert.ok(skipped.length >= 1, 'the surplus long hit is skipped, not allowed to overspend');
  for (const hit of delivered) {
    assert.equal(hit.containsEvidence, true, `delivered ${hit.messageId} keeps the query words`);
    assert.ok(hit.text.includes('部署方案'), `delivered ${hit.messageId} carries the evidence word`);
    assert.ok(
      hit.text.length <= MEMORY_ASSEMBLY.maxChars,
      `delivered row stays inside the block (${hit.text.length})`,
    );
  }
  for (const hit of skipped) {
    assert.equal(hit.text, '', 'a skipped row delivers no fake evidence');
    assert.equal(hit.containsEvidence, false);
    assert.ok(
      assembly.dropped.some((entry) => entry.id === hit.id && entry.reason === 'char-budget'),
      `skipped ${hit.messageId} is recorded as char-budget in dropped`,
    );
  }
  const event = lastEvent(log, 'memory.assembly');
  assert.ok(event !== null, 'memory.assembly is emitted');
  assert.equal(event.charLimit, 1200);
  assert.equal(event.chars, assembly.chars);
  assert.equal(event.skippedByChars, charBudgetDrops(assembly).length);
  assert.ok(
    event.truncatedRows >= delivered.length,
    `every 2000-char body was truncated (${event.truncatedRows})`,
  );
  console.log(
    `[7] long hits: chars=${assembly.chars}/${assembly.charLimit} delivered=${delivered.length} ` +
      `skippedByChars=${event.skippedByChars} truncatedRows=${event.truncatedRows} ` +
      `dropped=${JSON.stringify(assembly.dropped.map((entry) => `${entry.messageId}:${entry.reason}`))} ` +
      `bodyChars=${charsOf(recalled.hits)}`,
  );
});

test('8) an overflowed snippet cannot push the block past 1200 (the 1324-char reproduction)', async (t) => {
  const root = await tempRoot();
  const log = eventLog();
  const memory = new MemoryStore(root, { capacity: 5000, onEvent: log.onEvent });
  t.after(() => cleanup(root, memory));

  // One 600-char evidence phrase, longer than any per-row window. On the pre-fix store the
  // reserved pass placed it, then the borrow pass placed a second copy and `used` reached 1915:
  // `budgetOverflow` skipped the price check entirely. The phrase is also longer than the direct
  // hits' reserved share, so this pins the second chance: skipped under the soft split, rescued
  // (compressed into exactly what is left) by the borrow pass, and still inside 1200.
  const token = 'deploywindow'.repeat(75);
  const filler = '填充。'.repeat(300);
  const base = Date.parse('2026-11-01T00:00:00.000Z');
  addAt(memory, {
    sessionId: 'oa', turnId: 1, messageId: 'oa-1-user',
    ts: new Date(base + 60_000).toISOString(), text: `${token}${filler}`,
  });
  addAt(memory, {
    sessionId: 'oa', turnId: 1, role: 'assistant', messageId: 'oa-1-assistant',
    ts: new Date(base + 61_000).toISOString(), text: `好的，${token.slice(0, 40)}`,
  });
  addAt(memory, {
    sessionId: 'ob', turnId: 1, messageId: 'ob-1-user',
    ts: new Date(base + 120_000).toISOString(), text: `${token}${filler}`,
  });

  const recalled = memory.recall({ query: token, budgetChars: 1200, maxRecords: 6 });
  const assembly = assertHardCap(recalled, 'overflow snippet');
  // `assembly.chars` prices every delivered body, including a stage-3 link row.
  const delivered = recalled.hits.filter(
    (hit) => hit.skippedByBudget !== true && String(hit.text ?? '').trim().length > 0,
  );
  const skipped = recalled.hits.filter((hit) => hit.skippedByBudget === true);
  assert.ok(delivered.length >= 1, 'the first overflow phrase is still delivered whole');
  const rescued = delivered.find((hit) => hit.budgetOverflow === true);
  assert.ok(rescued !== undefined, 'the row that spent past its per-row window is flagged');
  assert.equal(rescued.text, token, 'the whole evidence phrase survives the compressed retry');
  assert.ok(
    rescued.text.length > MEMORY_ASSEMBLY.maxChars / 4,
    `the phrase is a real overflow (${rescued.text.length})`,
  );
  assert.ok(skipped.length >= 1, 'the phrase that no longer fits is skipped instead of overspending');
  assert.ok(
    assembly.dropped.some((entry) => entry.reason === 'char-budget'),
    `dropped records char-budget: ${JSON.stringify(assembly.dropped)}`,
  );
  assert.equal(assembly.chars, labelledChars(delivered), 'chars = delivered bodies + one label each');
  const event = lastEvent(log, 'memory.assembly');
  assert.equal(event.chars, assembly.chars);
  assert.equal(event.charLimit, 1200);
  assert.ok(event.skippedByChars >= 1, `event counts the char-budget skip (${event.skippedByChars})`);
  console.log(
    `[8] overflow phrase: chars=${assembly.chars}/${assembly.charLimit} delivered=${delivered.length} ` +
      `skippedByChars=${event.skippedByChars} truncatedRows=${event.truncatedRows} ` +
      `dropped=${JSON.stringify(assembly.dropped.map((entry) => `${entry.messageId}:${entry.reason}`))}`,
  );
});

test('9) many medium hits stop at 1200 chars and every shortfall is a char-budget drop', async (t) => {
  const root = await tempRoot();
  const log = eventLog();
  const memory = new MemoryStore(root, { capacity: 5000, onEvent: log.onEvent });
  t.after(() => cleanup(root, memory));

  const base = Date.parse('2026-11-02T00:00:00.000Z');
  const body = (index) => `部署方案记录第${index}条：${'补充说明，'.repeat(68)}`;
  for (let index = 1; index <= 5; index += 1) {
    assert.ok(body(index).length > 330 && body(index).length <= 400, 'each medium body fits one row');
    addAt(memory, {
      sessionId: `mid-${index}`, turnId: 1, messageId: `mid-${index}-1`,
      ts: new Date(base + index * 60_000).toISOString(), text: body(index),
    });
  }

  const recalled = memory.recall({ query: '部署方案', budgetChars: 1200, maxRecords: 6 });
  const assembly = assertHardCap(recalled, 'medium hits');
  assert.equal(assembly.charLimit, 1200);
  const delivered = deliveredRecallRows(recalled.hits);
  assert.ok(assembly.chars > 0);
  assert.equal(
    delivered.length + assembly.dropped.length,
    5,
    `five hits in, five accounted for (${JSON.stringify(assembly.dropped)})`,
  );
  assert.ok(
    assembly.dropped.some((entry) => entry.reason === 'char-budget'),
    `the tail of the list is cut for characters (${JSON.stringify(assembly.dropped)})`,
  );
  assert.equal(assembly.dropped.every((entry) => DROP_REASONS.has(entry.reason)), true);
  assert.ok(charsOf(recalled.hits) <= assembly.chars, 'body chars are inside the reported total');
  const event = lastEvent(log, 'memory.assembly');
  assert.equal(event.chars, assembly.chars);
  assert.equal(event.charLimit, 1200);
  assert.equal(event.skippedByChars, charBudgetDrops(assembly).length);
  console.log(
    `[9] medium hits: chars=${assembly.chars}/${assembly.charLimit} delivered=${delivered.length} ` +
      `skippedByChars=${event.skippedByChars} truncatedRows=${event.truncatedRows} ` +
      `dropped=${JSON.stringify(assembly.dropped.map((entry) => `${entry.messageId}:${entry.reason}`))}`,
  );
});

test('10) the hard assertion holds for every budget / display shape (chars <= charLimit)', async (t) => {
  const root = await tempRoot();
  const log = eventLog();
  const memory = new MemoryStore(root, { capacity: 5000, onEvent: log.onEvent });
  t.after(() => cleanup(root, memory));

  const base = Date.parse('2026-11-03T00:00:00.000Z');
  const token = 'deploywindow'.repeat(50);
  const seed = [
    ['s1', `部署方案：${'背景说明，'.repeat(120)}但注意：并不是周四发布，只在 2026-11-07 且灰度通过后才生效。`],
    ['s2', `部署方案：${'补充说明，'.repeat(60)}`],
    ['s3', `${token}${'填充。'.repeat(200)}`],
    ['s4', '部署方案先按老流程走，细节稍后补充。'],
    ['s5', `部署方案：${'背景说明，'.repeat(300)}`],
  ];
  let seq = 0;
  for (const [sessionId, text] of seed) {
    seq += 1;
    addAt(memory, {
      sessionId, turnId: 1, messageId: `${sessionId}-1-u`,
      ts: new Date(base + seq * 60_000).toISOString(), text,
    });
    seq += 1;
    addAt(memory, {
      sessionId, turnId: 1, role: 'assistant', messageId: `${sessionId}-1-a`,
      ts: new Date(base + seq * 60_000 + 1000).toISOString(), text: `${text.slice(0, 30)}……答复`,
    });
  }

  const shapes = [];
  for (const budgetChars of [0, 120, 300, 600, 1200, 5000]) {
    for (const displayChars of [3, 50, 400]) {
      for (const query of ['部署方案', token]) {
        shapes.push({ budgetChars, displayChars, query });
      }
    }
  }

  let widest = { chars: 0, limit: 0 };
  for (const shape of shapes) {
    const recalled = memory.recall({
      query: shape.query,
      budgetChars: shape.budgetChars,
      maxRecords: 6,
      displayChars: shape.displayChars,
    });
    const assembly = assertHardCap(
      recalled,
      `budget=${shape.budgetChars} display=${shape.displayChars} query=${shape.query.slice(0, 6)}`,
    );
    assert.equal(
      assembly.charLimit,
      Math.min(MEMORY_ASSEMBLY.maxChars, Math.max(0, Math.floor(shape.budgetChars))),
      'charLimit is the requested budget clamped to the contract',
    );
    if (assembly.chars > widest.chars) {
      widest = { ...shape, chars: assembly.chars, limit: assembly.charLimit };
    }
  }
  const event = lastEvent(log, 'memory.assembly');
  assert.ok(event !== null);
  for (const key of ['chars', 'charLimit', 'truncatedRows', 'skippedByChars']) {
    assert.equal(typeof event[key], 'number', `event carries numeric ${key}`);
  }
  console.log(
    `[10] ${shapes.length} shapes: widest chars=${widest.chars}/limit=${widest.limit} ` +
      `(budget=${widest.budgetChars} display=${widest.displayChars}) ` +
      `lastEvent={chars:${event.chars},charLimit:${event.charLimit},` +
      `truncatedRows:${event.truncatedRows},skippedByChars:${event.skippedByChars}}`,
  );
});

/**
 * Recall assembly, D2 data layer (2026-11-06): the block now explains itself.
 *
 * The tool projection could already see rows, but not WHY a row was there nor whether its body was
 * really handed over. `recall()` now puts `kind` (`hit`/`link`/`pair`/`neighbor`/`upcoming`) and
 * `delivered` on every row, and adds the tallies under `assembly` (`hits`, `links`, `pairs`,
 * `neighbors`, `upcoming`, `delivered`, `skippedByBudget`, `chars`, `limit`).
 *
 * The delivery flag is not a second calculation: it is written by the same `place()` map that
 * already decided `skippedByBudget`, so `delivered === (skippedByBudget !== true)` by construction
 * and the rows that claim delivery are exactly the trimmed list C2 receives (`skippedByBudget
 * !== true`, non-empty body). C2 still re-prices its own rendered frame downstream — that second
 * budget is unchanged — so an injected id is always a delivered one, never the reverse.
 *
 * Nothing here changes ranking, the 6-row / 1200-character budget, or reinforcement:
 *   11. a pure-hit block: every row is `kind:'hit'` and delivered;
 *   12. a link supplement: the linked row is `kind:'link'` and delivered next to its source hit;
 *   13. same-turn context is `kind:'pair'`, ±window context is `kind:'neighbor'`;
 *   14. a due convention is `kind:'upcoming'` and delivered;
 *   15. a row the character budget refuses is `delivered:false` / `skippedByBudget:true`;
 *   16. `rows.filter(delivered).length === assembly.delivered` for every shape, and the delivered
 *       set is what the injection block is allowed to spend.
 */

/** The same filter C2 uses to pick candidates: a skipped row is metadata only, never a body. */
const injectableRows = (hits) => hits.filter(
  (row) => row.skippedByBudget !== true && String(row.text ?? '').trim().length > 0,
);

/**
 * The D2 delivery contract of one recall: every row carries `kind`/`delivered`, the tallies agree
 * with the rows, and the character cap is the one the block was measured against.
 */
function assertDeliveryContract(recalled, label) {
  const { assembly } = recalled;
  const delivered = recalled.hits.filter((row) => row.delivered === true);
  for (const row of recalled.hits) {
    assert.equal(typeof row.kind, 'string', `${label}: ${row.messageId} carries kind`);
    assert.equal(typeof row.delivered, 'boolean', `${label}: ${row.messageId} carries delivered`);
    assert.equal(row.delivered, row.skippedByBudget !== true, `${label}: ${row.messageId} delivered XOR skipped`);
    if (row.delivered) assert.ok(String(row.text ?? '').trim().length > 0, `${label}: ${row.id} delivered a body`);
  }
  assert.equal(delivered.length, assembly.delivered, `${label}: assembly.delivered matches the rows`);
  assert.equal(assembly.limit, assembly.charLimit, `${label}: limit is the character cap in force`);
  assert.ok(assembly.chars <= assembly.limit, `${label}: chars<=limit`);
  assert.equal(
    assembly.skippedByBudget,
    assembly.dropped.filter((entry) => entry.reason === 'char-budget').length,
    `${label}: skippedByBudget counts the char-budget drops`,
  );
  for (const key of ['hits', 'links', 'pairs', 'neighbors', 'upcoming']) {
    assert.equal(typeof assembly[key], 'number', `${label}: assembly.${key} is numeric`);
  }
  assert.equal(
    assembly.hits + assembly.links + assembly.pairs + assembly.neighbors + assembly.upcoming,
    delivered.length,
    `${label}: every delivered row is counted under exactly one kind`,
  );
  return delivered;
}

test('11) pure hits: every row is kind=hit and delivered, and assembly counts them', async (t) => {
  const root = await tempRoot();
  const memory = new MemoryStore(root, { capacity: 5000 });
  t.after(() => cleanup(root, memory));

  // One message per session/turn, short, no dated wording: nothing but direct hits can exist.
  for (const index of [1, 2, 3]) {
    addAt(memory, {
      sessionId: `pure-${index}`, turnId: 1, messageId: `pure-${index}`,
      ts: new Date(Date.parse('2026-11-01T00:00:00.000Z') + index * 60_000).toISOString(),
      text: `纯命中探针第${index}条：只谈纯命中探针。`,
    });
  }

  const recalled = memory.recall({ query: '纯命中探针', budgetChars: 1200, maxRecords: 6 });
  const delivered = assertDeliveryContract(recalled, 'pure hits');
  assert.equal(recalled.hits.length, 3, `three independent hits (${recalled.hits.length})`);
  assert.equal(recalled.assembly.hits, 3);
  assert.deepEqual(
    [recalled.assembly.links, recalled.assembly.pairs, recalled.assembly.neighbors, recalled.assembly.upcoming],
    [0, 0, 0, 0],
  );
  assert.equal(delivered.length, recalled.hits.length, 'every hit won a slot and a body');
  assert.equal(recalled.assembly.skippedByBudget, 0);
  for (const row of recalled.hits) {
    assert.equal(row.kind, 'hit', `${row.messageId} is a direct hit`);
    assert.equal(row.delivered, true);
    assert.equal(row.skippedByBudget, false);
  }
  assert.equal(recalled.assembly.delivered, recalled.hits.length);
  assert.equal(recalled.assembly.limit, 1200);
  console.log(
    `[11] rows=${recalled.hits.length} kinds=${recalled.hits.map((row) => row.kind).join(',')} ` +
      `delivered=${recalled.assembly.delivered} assembly=${JSON.stringify({
        hits: recalled.assembly.hits, links: recalled.assembly.links, pairs: recalled.assembly.pairs,
        neighbors: recalled.assembly.neighbors, upcoming: recalled.assembly.upcoming,
        delivered: recalled.assembly.delivered, skippedByBudget: recalled.assembly.skippedByBudget,
        chars: recalled.assembly.chars, limit: recalled.assembly.limit,
      })}`,
  );
});

test('12) a link supplement: the linked row is kind=link and delivered beside its hit', async (t) => {
  const root = await tempRoot();
  const memory = new MemoryStore(root, { capacity: 5000 });
  t.after(() => cleanup(root, memory));

  const hit = addAt(memory, {
    sessionId: 'd2-link', turnId: 7, messageId: 'd2-link-u',
    ts: '2026-11-02T00:00:00.000Z', text: '链接交付探针：周末去看樱花。',
  }).record;
  const reply = addAt(memory, {
    sessionId: 'd2-link', turnId: 7, role: 'assistant', messageId: 'd2-link-a',
    ts: '2026-11-02T00:00:01.000Z', text: '好的，相机已经放进包里。',
  }).record;
  assert.ok(hit !== null && reply !== null);

  const recalled = memory.recall({ query: '樱花', budgetChars: 1200, maxRecords: 6 });
  const delivered = assertDeliveryContract(recalled, 'link supplement');
  const hitRow = recalled.hits.find((row) => row.id === hit.id);
  const linkRow = recalled.hits.find((row) => row.id === reply.id);
  assert.ok(hitRow !== undefined && hitRow.kind === 'hit');
  assert.ok(linkRow !== undefined, `the linked reply is in the block (${JSON.stringify(recalled.hits.map((row) => row.kind))})`);
  assert.equal(linkRow.kind, 'link', 'the reply is a link row, never a hit');
  assert.equal(linkRow.delivered, true, 'the link row really delivered its body');
  assert.equal(hitRow.delivered, true);
  assert.equal(recalled.assembly.links, 1);
  assert.equal(recalled.assembly.hits, 1);
  assert.equal(recalled.assembly.delivered, 2);
  assert.deepEqual(delivered.map((row) => row.id).sort(), [hit.id, reply.id].sort());
  console.log(
    `[12] rows=${recalled.hits.map((row) => `${row.kind}:${row.delivered}`).join(',')} ` +
      `links=${recalled.assembly.links} delivered=${recalled.assembly.delivered} ` +
      `skippedByBudget=${recalled.assembly.skippedByBudget}`,
  );
});

test('13) same-turn context is kind=pair, ±window context is kind=neighbor, both delivered', async (t) => {
  const root = await tempRoot();
  const memory = new MemoryStore(root, { capacity: 5000 });
  t.after(() => cleanup(root, memory));

  const hit = addAt(memory, {
    sessionId: 'd2-pn', turnId: 1, messageId: 'd2-pn-hit',
    ts: '2026-11-03T00:00:00.000Z', text: '配对邻居探针：命中句包含配对邻居词。',
  }).record;
  const pair = addAt(memory, {
    sessionId: 'd2-pn', turnId: 1, messageId: 'd2-pn-pair',
    ts: '2026-11-03T00:00:01.000Z', text: '同一轮里的另一句，不带任何关键词。',
  }).record;
  const neighbour = addAt(memory, {
    sessionId: 'd2-pn', turnId: 2, messageId: 'd2-pn-neighbor',
    ts: '2026-11-03T00:01:00.000Z', text: '下一轮的一句，同样不带关键词。',
  }).record;
  assert.ok(hit !== null && pair !== null && neighbour !== null);

  const recalled = memory.recall({ query: '配对邻居词', budgetChars: 1200, maxRecords: 6 });
  assertDeliveryContract(recalled, 'pair + neighbour');
  const rowOfMessage = (messageId) => recalled.hits.find((row) => row.messageId === messageId);
  assert.equal(rowOfMessage('d2-pn-hit').kind, 'hit');
  assert.equal(rowOfMessage('d2-pn-pair').kind, 'pair', 'the same-turn second line is a pair');
  assert.equal(rowOfMessage('d2-pn-neighbor').kind, 'neighbor', 'the adjacent-turn line is a neighbor');
  for (const row of recalled.hits) assert.equal(row.delivered, true, `${row.messageId} delivered`);
  assert.equal(recalled.assembly.pairs, 1);
  assert.equal(recalled.assembly.neighbors, 1);
  assert.equal(recalled.assembly.delivered, 3);
  console.log(
    `[13] kinds=${recalled.hits.map((row) => `${row.kind}:${row.delivered}`).join(',')} ` +
      `pairs=${recalled.assembly.pairs} neighbors=${recalled.assembly.neighbors} ` +
      `delivered=${recalled.assembly.delivered}`,
  );
});

test('14) a due convention is kind=upcoming and delivered, without displacing the direct hit', async (t) => {
  const root = await tempRoot();
  const memory = new MemoryStore(root, { capacity: 5000 });
  t.after(() => cleanup(root, memory));

  const now = new Date(2026, 10, 6, 13, 0, 0); // 2026-11-06, a Friday
  const hit = addAt(memory, {
    sessionId: 'd2-code', turnId: 1, messageId: 'd2-code-hit',
    ts: '2026-11-05T00:00:00.000Z', text: 'TypeScript 编译报错先看 tsconfig 的 target',
  }).record;
  const convention = addAt(memory, {
    sessionId: 'd2-date', turnId: 1, messageId: 'd2-date-today',
    ts: '2026-10-01T00:00:00.000Z', text: '我们说好 2026-11-06 一起看动画',
  }).record;
  assert.ok(hit !== null && convention !== null);

  const recalled = memory.recall({
    query: 'TypeScript 编译报错怎么修', now, budgetChars: 1200, maxRecords: 6,
  });
  assertDeliveryContract(recalled, 'upcoming convention');
  const hitRow = recalled.hits.find((row) => row.id === hit.id);
  const upcomingRow = recalled.hits.find((row) => row.id === convention.id);
  assert.ok(hitRow !== undefined && hitRow.kind === 'hit', 'the direct hit still leads');
  assert.ok(upcomingRow !== undefined, `the due convention entered (${JSON.stringify(recalled.hits.map((row) => row.kind))})`);
  assert.equal(upcomingRow.kind, 'upcoming', 'the supplement is marked upcoming');
  assert.equal(upcomingRow.delivered, true, 'the supplement really delivered its body');
  assert.equal(recalled.assembly.upcoming, 1);
  assert.equal(recalled.assembly.hits, 1, 'the supplement never takes a hit slot');
  assert.equal(recalled.assembly.delivered, 2);
  assert.equal(upcomingRow.upcomingLevel, 'today', 'the row knows why it was added');
  console.log(
    `[14] now=2026-11-06 rows=${recalled.hits.map((row) => `${row.messageId}:${row.kind}:${row.delivered}`).join(',')} ` +
      `upcoming=${recalled.assembly.upcoming} delivered=${recalled.assembly.delivered}`,
  );
});

test('15) a row the character budget refuses is delivered:false + skippedByBudget:true', async (t) => {
  const root = await tempRoot();
  const log = eventLog();
  const memory = new MemoryStore(root, { capacity: 5000, onEvent: log.onEvent });
  t.after(() => cleanup(root, memory));

  const base = Date.parse('2026-11-04T00:00:00.000Z');
  const body = (index) => `交付预算裁剪测试第${index}条：${'补充说明，'.repeat(68)}`;
  for (let index = 1; index <= 5; index += 1) {
    addAt(memory, {
      sessionId: `d2-mid-${index}`, turnId: 1, messageId: `d2-mid-${index}-1`,
      ts: new Date(base + index * 60_000).toISOString(), text: body(index),
    });
  }

  const recalled = memory.recall({ query: '交付预算裁剪测试', budgetChars: 600, maxRecords: 6 });
  const delivered = assertDeliveryContract(recalled, 'char-budget trim');
  const refused = recalled.hits.filter((row) => row.skippedByBudget === true);
  assert.ok(delivered.length >= 1, `at least one row fits (${delivered.length})`);
  assert.ok(refused.length >= 1, `the surplus rows are refused (${refused.length})`);
  for (const row of refused) {
    assert.equal(row.delivered, false, `${row.messageId} was not delivered`);
    assert.equal(row.kind, 'hit', 'it is still a candidate hit, not context');
    assert.equal(row.text, '', 'a refused row delivers no fake body');
    assert.equal(
      recalled.assembly.dropped.some((entry) => entry.id === row.id && entry.reason === 'char-budget'),
      true,
      `${row.messageId} is recorded as char-budget in dropped`,
    );
  }
  assert.ok(recalled.assembly.skippedByBudget > 0, `assembly counts the cut (${recalled.assembly.skippedByBudget})`);
  assert.equal(
    recalled.assembly.delivered,
    recalled.hits.length - refused.length,
    'delivered is the rows that kept a body, not the candidates',
  );
  assert.equal(recalled.assembly.hits, delivered.length);
  assert.equal(recalled.assembly.chars, recalled.assembly.limit, 'the block spent its 600-char budget');
  assert.equal(recalled.assembly.limit, 600);
  const event = lastEvent(log, 'memory.assembly');
  assert.equal(event.skippedByChars, recalled.assembly.skippedByBudget, 'the event agrees with the block');
  assert.equal(event.charLimit, recalled.assembly.limit);
  console.log(
    `[15] rows=${recalled.hits.length} delivered=${recalled.assembly.delivered} ` +
      `refused=${refused.length} skippedByBudget=${recalled.assembly.skippedByBudget} ` +
      `chars=${recalled.assembly.chars}/${recalled.assembly.limit} ` +
      `dropped=${JSON.stringify(recalled.assembly.dropped.map((entry) => `${entry.messageId}:${entry.reason}`))}`,
  );
});

test('16) delivered rows === assembly.delivered for every shape, and C2 only spends delivered rows', async (t) => {
  const root = await tempRoot();
  const memory = new MemoryStore(root, { capacity: 5000 });
  t.after(() => cleanup(root, memory));

  // A short mixed block: a hit with a turn link, a pair + neighbour, and a due convention.
  addAt(memory, {
    sessionId: 'd2-mix-link', turnId: 1, messageId: 'd2-mix-link-u',
    ts: '2026-11-04T00:00:00.000Z', text: '交付一致性探针：部署方案要按蓝绿发布。',
  });
  addAt(memory, {
    sessionId: 'd2-mix-link', turnId: 1, role: 'assistant', messageId: 'd2-mix-link-a',
    ts: '2026-11-04T00:00:01.000Z', text: '好的，我记下了。',
  });
  addAt(memory, {
    sessionId: 'd2-mix-pn', turnId: 1, messageId: 'd2-mix-pn-u',
    ts: '2026-11-04T00:01:00.000Z', text: '交付一致性探针：部署方案的配对句。',
  });
  addAt(memory, {
    sessionId: 'd2-mix-pn', turnId: 1, messageId: 'd2-mix-pn-pair',
    ts: '2026-11-04T00:01:01.000Z', text: '同一轮的另一句，不带关键词。',
  });
  addAt(memory, {
    sessionId: 'd2-mix-pn', turnId: 2, messageId: 'd2-mix-pn-neighbor',
    ts: '2026-11-04T00:02:00.000Z', text: '邻轮的一句，不带关键词。',
  });
  addAt(memory, {
    sessionId: 'd2-mix-date', turnId: 1, messageId: 'd2-mix-date',
    ts: '2026-10-01T00:00:00.000Z', text: '我们说好 2026-11-06 一起看动画',
  });

  const shapes = [
    { label: 'roomy', options: { query: '部署方案', budgetChars: 1200, maxRecords: 6 } },
    { label: 'tight', options: { query: '部署方案', budgetChars: 60, maxRecords: 6 } },
    { label: 'row-cap', options: { query: '交付一致性探针', budgetChars: 1200, maxRecords: 2 } },
    {
      label: 'upcoming',
      options: { query: 'TypeScript 编译报错怎么修', budgetChars: 1200, maxRecords: 6, now: new Date(2026, 10, 6, 13, 0, 0) },
    },
  ];
  const roomy = [];
  for (const shape of shapes) {
    const recalled = memory.recall(shape.options);
    const delivered = assertDeliveryContract(recalled, shape.label);
    // The C2 filter and the delivered flag are the same trimmed list: C2 can never receive a
    // candidate the store refused, and its `injectedIds` are a subset of the delivered set.
    const candidates = injectableRows(recalled.hits);
    assert.deepEqual(
      candidates.map((row) => row.id),
      delivered.map((row) => row.id),
      `${shape.label}: C2 candidates are exactly the delivered rows`,
    );
    const composed = composeInjectionBlock({ matched: candidates, limits: { ...MEMORY_ASSEMBLY } });
    assert.ok(
      composed.injectedIds.length <= delivered.length,
      `${shape.label}: injected ${composed.injectedIds.length} <= delivered ${delivered.length}`,
    );
    for (const id of composed.injectedIds) {
      assert.ok(delivered.some((row) => row.id === id), `${shape.label}: injected id ${id} was delivered`);
    }
    if (shape.label === 'roomy') roomy.push({ recalled, composed, delivered });
    console.log(
      `[16] ${shape.label}: rows=${recalled.hits.length} delivered=${recalled.assembly.delivered} ` +
        `skippedByBudget=${recalled.assembly.skippedByBudget} injected=${composed.injectedIds.length} ` +
        `(assembly.delivered === rows.filter(delivered).length)`,
    );
  }
  // A block that fits comfortably is injected exactly as recall delivered it: no extra second cut
  // hides behind the delivery flag. (Only a tight block can lose one more row to C2's own render
  // frame; that downstream budget is unchanged and never injects an undelivered row.)
  assert.equal(roomy.length, 1);
  const [{ recalled, composed, delivered }] = roomy;
  assert.equal(composed.injectedIds.length, delivered.length, 'the roomy block is injected whole');
  assert.equal(recalled.assembly.delivered, recalled.hits.filter((row) => row.delivered === true).length);
  console.log(
    `[16] roomy consistency: delivered=${delivered.length} injected=${composed.injectedIds.length} ` +
      `kinds=${JSON.stringify(recalled.assembly.hits)}+${JSON.stringify(recalled.assembly.links)}+` +
      `${JSON.stringify(recalled.assembly.pairs)}+${JSON.stringify(recalled.assembly.neighbors)}`,
  );
});
