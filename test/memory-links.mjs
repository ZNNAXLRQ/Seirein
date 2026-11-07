/**
 * Memory correction phase 3: explicit one-hop links assist recall.
 *
 * `memory_link` is a separate table (`turn` / `referent` / `correction`). It is not FTS content
 * and not counted by `usage()`. Recall keeps the existing direct-hit selection, then follows ONE
 * link from each direct hit, dedupes, and spends the same context quota and 1200-character hard
 * cap. Linked rows are marked `kind: 'link'`, are never a match themselves, and never receive
 * `restore()` feedback.
 *
 * The list mirrors the acceptance items:
 *   1. a same-turn user/assistant couple is written as a `turn` link and expands from the hit;
 *   2. a stage-2 pronoun expansion writes `referent` only when a basis record exists;
 *   3. a correction writes `correction` (target → revision) and never re-adds the corrected text;
 *   4. only one hop is followed (a link of a link is not expanded);
 *   5. the block stays <=1200 chars / <=6 rows and records `char-budget` when a link does not fit;
 *   6. linked rows are delivered but never trigger `restore()`;
 *   7. hidden / superseded / archived / other-domain rows are never linked into the block;
 *   8. 1000 records + 100 links: recall p95 does not regress against links disabled;
 *   9. the link table is outside FTS and outside capacity pressure;
 *  10. correcting a basis retires the dependent `referent` edge (stale) and flags the dependent
 *      `unresolved=1` — the old name is not batch-renamed, it just stops being mixed with the new;
 *  11. the basis is the record the normalizer resolved the pronoun from, not the earliest record
 *      that merely contains the name (chit-chat first, introduction second);
 *  12. the pair/neighbour fallback honours the domain filter exactly like the link query;
 *  13. the pair/neighbour fallback honours the asked time window exactly like the link query.
 *  14. a stale referent dependency (纠正「团子」→「豆豆」) is delivered with `unresolved=1` and the
 *      `[待核验]` marker, never as a bare confirmed original;
 *  15. a stale dependency reached through the ±window neighbour expansion is flagged the same way;
 *  16. the C2 injection block renders the marker in front of that body;
 *  17. a healthy row keeps `unresolved=0` / `staleLink=false` and no marker (regression);
 *  18. the same-turn `pair` expansion applies the identical rule (one shared delivery path).
 *
 * Run: node --test test/memory-links.mjs
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  composeInjectionBlock,
  createAutoMemoryRecorder,
  deliveredRecallRows,
} from '../src/host/index.js';
import {
  MEMORY_ASSEMBLY,
  MEMORY_LINK_CONFIDENCE,
  MemoryStore,
} from '../src/host/memory/store.js';

async function tempRoot(prefix = 'dsh-mem-links-') {
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
    onEvent(type, payload) {
      events.push({ type, payload });
    },
  };
}

const linkRows = (memory) => memory.db
  .prepare('SELECT from_id AS fromId, to_id AS toId, kind, confidence FROM memory_link')
  .all();

const rowOf = (memory, id) => memory.db
  .prepare('SELECT id, text, kind, importance, clarity, recall_count, hidden, superseded_by FROM memory_event WHERE id = ?')
  .get(id);

const addAt = (memory, { sessionId, turnId = 1, role = 'user', messageId, ts, text, domain = 'chat', importance = 60, clarity = 'fuzzy' }) => memory
  .addMessage({ role, sessionId, turnId, messageId, ts, text, domain, importance, clarity });

/**
 * The reported P1 repro: a normalized dependent ("团子最近不爱吃饭", raw "她最近不爱吃饭") linked to
 * the introduction it was expanded from, then the introduction is corrected 团子 → 豆豆. The
 * dependent is NOT renamed; its `referent` edge is retired and it is flagged `unresolved=1`.
 */
const seedStaleReferent = (memory, sessionId, { dependentTurn = 2 } = {}) => {
  const intro = addAt(memory, {
    sessionId, turnId: 1, messageId: `${sessionId}-intro`,
    ts: '2026-11-01T00:00:00.000Z', text: '我养了一只猫，叫团子',
  }).record;
  const dependent = memory.addMessage({
    role: 'user', sessionId, turnId: dependentTurn, messageId: `${sessionId}-dependent`,
    ts: '2026-11-01T00:05:00.000Z', text: '团子最近不爱吃饭', rawText: '她最近不爱吃饭', unresolved: 1,
  }).record;
  assert.ok(intro !== null && dependent !== null, 'the repro seeded both records');
  assert.equal(memory.addLink(dependent.id, intro.id, 'referent'), true);
  const corrected = memory.correct({
    targetId: intro.id, expectedVersion: 1, expectedText: '团子', replacement: '豆豆',
  });
  return { intro, dependent, corrected };
};

test('1) same-turn pair: the hit expands to its assistant reply as a `turn` link', async (t) => {
  const root = await tempRoot();
  const log = eventLog();
  const memory = new MemoryStore(root, { capacity: 5000, onEvent: log.onEvent });
  t.after(() => cleanup(root, memory));

  const base = Date.parse('2026-11-01T10:00:00.000Z');
  const user = addAt(memory, {
    sessionId: 'turn-pair', turnId: 7, messageId: 'turn-pair-u',
    ts: new Date(base).toISOString(), text: '周末去看樱花，记得带相机。',
  }).record;
  const assistant = addAt(memory, {
    sessionId: 'turn-pair', turnId: 7, role: 'assistant', messageId: 'turn-pair-a',
    ts: new Date(base + 1000).toISOString(), text: '好的，我把相机和电池都放进包里了。',
  }).record;
  assert.ok(user !== null && assistant !== null, 'both sides of the turn were stored');

  const edges = linkRows(memory).filter((edge) => edge.kind === 'turn');
  assert.deepEqual(
    edges.map((edge) => `${edge.fromId}>${edge.toId}:${edge.confidence}`).sort(),
    [
      `${assistant.id}>${user.id}:1`,
      `${user.id}>${assistant.id}:1`,
    ].sort(),
    'the turn pair is linked in both directions',
  );

  const recalled = memory.recall({ query: '樱花', budgetChars: 1200, maxRecords: 6 });
  assert.equal(recalled.hits.length, 2, `hit + linked reply (${recalled.hits.length})`);
  const hit = recalled.hits.find((row) => row.id === user.id);
  const linked = recalled.hits.find((row) => row.id === assistant.id);
  assert.equal(hit.kind, 'hit', 'the matched row stays a direct hit');
  assert.equal(linked.kind, 'link', 'the reply is a link row, not a pair');
  assert.equal(linked.linkKind, 'turn');
  assert.equal(linked.group, user.id, 'the link row points back at its source hit');
  assert.equal(hit.delivered, true, 'the source hit really delivered its body');
  assert.equal(linked.delivered, true, 'the link row really delivered its body');
  assert.equal(recalled.assembly.links, 1);
  assert.equal(recalled.assembly.pairs, 0, 'the link pass won the slot, so no duplicate pair');
  assert.equal(recalled.assembly.delivered, 2, 'both rows are counted as delivered');
  assert.equal(recalled.assembly.chars <= MEMORY_ASSEMBLY.maxChars, true);
  const expanded = log.events.filter((entry) => entry.type === 'memory.link.expanded');
  assert.equal(expanded.length, 1, 'one expansion event');
  assert.deepEqual(expanded[0].payload, { from: user.id, kind: 'turn', added: 1 });
  console.log(
    `[1] edge=turn x2 rows=${recalled.hits.length} link=${linked.messageId} ` +
      `chars=${recalled.assembly.chars} event=${JSON.stringify(expanded[0].payload)}`,
  );
});

test('2) referent: a pronoun expansion links the expanded sentence to its basis record', async (t) => {
  const root = await tempRoot();
  const memory = new MemoryStore(root, { capacity: 5000 });
  t.after(() => cleanup(root, memory));

  const intro = addAt(memory, {
    sessionId: 'ref', turnId: 1, messageId: 'ref-intro',
    ts: '2026-11-01T00:00:00.000Z', text: '我养了一只猫，叫团子',
  }).record;
  assert.ok(intro !== null);

  const context = (sessionId) => {
    if (sessionId !== 'ref') return { previous: [], records: [] };
    const rows = memory.messageRecords({ sessionId: 'ref', limit: 4 });
    return { previous: rows.map((row) => row.text).reverse(), records: rows };
  };
  const recorder = createAutoMemoryRecorder({
    memory,
    settings: { enabled: true, minChars: 1, maxChars: 400, includeReply: false },
    contextOf: context,
  });
  await recorder.handle({ id: 'ref' }, {
    type: 'user/message',
    time: Date.parse('2026-11-02T00:00:00.000Z'),
    data: {
      id: 'ref-expanded', role: 'user', source: { kind: 'user' },
      content: [{ type: 'text', text: '她最近不爱吃饭' }],
    },
  });
  const expanded = memory.db
    .prepare("SELECT id, text FROM memory_event WHERE message_id = 'ref-expanded'")
    .get();
  assert.equal(expanded.text, '团子最近不爱吃饭', 'stage 2 replaced the pronoun');
  const edges = linkRows(memory).filter((edge) => edge.kind === 'referent');
  assert.equal(edges.length, 1, 'exactly one referent edge');
  assert.equal(edges[0].fromId, expanded.id, 'from the expanded record');
  assert.equal(edges[0].toId, intro.id, 'to the record that introduced 团子');
  assert.equal(edges[0].confidence, MEMORY_LINK_CONFIDENCE.referent);

  const recalled = memory.recall({ query: '不爱吃饭', budgetChars: 1200, maxRecords: 6 });
  assert.equal(recalled.hits.length, 2, `expanded sentence + basis (${recalled.hits.length})`);
  const basis = recalled.hits.find((row) => row.id === intro.id);
  assert.equal(basis.kind, 'link');
  assert.equal(basis.linkKind, 'referent');
  assert.equal(basis.delivered, true, 'the referent basis was delivered, not just a candidate');
  assert.equal(recalled.assembly.links, 1);
  assert.equal(recalled.assembly.delivered, 2);

  // No basis record → no guessing and no link.
  await recorder.handle({ id: 'ref-empty' }, {
    type: 'user/message',
    time: Date.parse('2026-11-03T00:00:00.000Z'),
    data: {
      id: 'ref-no-basis', role: 'user', source: { kind: 'user' },
      content: [{ type: 'text', text: '她最近不爱吃饭' }],
    },
  });
  const unresolved = memory.db
    .prepare("SELECT text, unresolved FROM memory_event WHERE message_id = 'ref-no-basis'")
    .get();
  assert.equal(unresolved.unresolved, 1, 'the pronoun stays unresolved');
  assert.equal(
    linkRows(memory).filter((edge) => edge.kind === 'referent').length,
    1,
    'no basis record means no referent link',
  );
  console.log(
    `[2] referent ${expanded.id}>${intro.id} conf=${edges[0].confidence} ` +
      `linkRow=${basis.kind} no-basis links=${linkRows(memory).filter((edge) => edge.kind === 'referent').length}`,
  );
});

test('3) correction: target → revision is written, and the corrected text is not re-added', async (t) => {
  const root = await tempRoot();
  const memory = new MemoryStore(root, { capacity: 5000 });
  t.after(() => cleanup(root, memory));

  const target = addAt(memory, {
    sessionId: 'corr', turnId: 1, messageId: 'corr-target',
    ts: '2026-11-01T00:00:00.000Z', text: '原定星期五下午三点开会',
  }).record;
  addAt(memory, {
    sessionId: 'corr', turnId: 2, messageId: 'corr-source',
    ts: '2026-11-02T00:00:00.000Z', text: '不是星期五，是星期四',
  });
  const result = memory.correct({
    targetId: target.id,
    expectedVersion: 1,
    expectedText: '星期五',
    replacement: '星期四',
    sourceMessageId: 'corr-source',
  });
  assert.equal(result.ok, true);
  assert.ok(result.revisionId.length > 0, 'a revision was written');

  const edges = linkRows(memory).filter((edge) => edge.kind === 'correction');
  assert.equal(edges.length, 1, 'one correction edge');
  assert.equal(edges[0].fromId, target.id, 'the modified record is the source of the edge');
  assert.equal(edges[0].toId, result.revisionId, 'the revision is the destination');
  assert.equal(edges[0].confidence, MEMORY_LINK_CONFIDENCE.correction);

  const recalled = memory.recall({ query: '星期四', budgetChars: 1200, maxRecords: 6 });
  assert.equal(recalled.hits.length, 1, `only the corrected record (${recalled.hits.length})`);
  assert.equal(recalled.hits[0].id, target.id);
  assert.equal(recalled.assembly.links, 0, 'a revision id is not an active memory row, so nothing is added');
  assert.equal(
    recalled.hits.filter((row) => row.text.includes('星期四')).length,
    1,
    'the corrected text is not duplicated',
  );
  console.log(
    `[3] correction ${target.id}>${result.revisionId} rows=${recalled.hits.length} ` +
      `links=${recalled.assembly.links} text=${recalled.hits[0].text}`,
  );
});

test('4) one hop only: a link of a link is never expanded', async (t) => {
  const root = await tempRoot();
  const log = eventLog();
  const memory = new MemoryStore(root, { capacity: 5000, onEvent: log.onEvent });
  t.after(() => cleanup(root, memory));

  const a = addAt(memory, {
    sessionId: 'chain-a', turnId: 1, messageId: 'chain-a',
    ts: '2026-11-01T00:00:00.000Z', text: '暗号是蓝鸟，这件事团子知道。',
  }).record;
  const b = addAt(memory, {
    sessionId: 'chain-b', turnId: 1, messageId: 'chain-b',
    ts: '2026-11-02T00:00:00.000Z', text: '团子最近不爱吃饭。',
  }).record;
  const c = addAt(memory, {
    sessionId: 'chain-c', turnId: 1, messageId: 'chain-c',
    ts: '2026-11-03T00:00:00.000Z', text: '团子喜欢晒太阳。',
  }).record;
  assert.equal(memory.addLink(a.id, b.id, 'referent'), true);
  assert.equal(memory.addLink(b.id, c.id, 'referent'), true);

  const recalled = memory.recall({ query: '蓝鸟', budgetChars: 1200, maxRecords: 6 });
  const ids = recalled.hits.map((row) => row.id);
  assert.deepEqual(ids.sort(), [a.id, b.id].sort(), 'A hit + its one-hop B, never C');
  assert.equal(ids.includes(c.id), false, 'the second hop is not followed');
  assert.equal(recalled.hits.find((row) => row.id === b.id).kind, 'link');
  assert.equal(recalled.hits.find((row) => row.id === b.id).linkKind, 'referent');
  const expanded = log.events.filter((entry) => entry.type === 'memory.link.expanded');
  assert.deepEqual(expanded.map((entry) => entry.payload), [{ from: a.id, kind: 'referent', added: 1 }]);
  console.log(`[4] chain a->b->c rows=${recalled.hits.length} ids=${ids.length} expanded=${expanded.length} cPresent=false`);
});

test('5) budget: a link that does not fit is dropped with `char-budget`, block stays <=1200/6', async (t) => {
  const root = await tempRoot();
  const log = eventLog();
  const memory = new MemoryStore(root, { capacity: 5000, onEvent: log.onEvent });
  t.after(() => cleanup(root, memory));

  // Three direct hits own the 2/3 hit share and two links compete for the reserved 1/3: the first
  // link fits, the second has no room left and must be reported instead of overspending.
  const filler = '补充说明，'.repeat(160);
  const hits = [];
  const targets = [];
  for (let index = 1; index <= 3; index += 1) {
    hits.push(addAt(memory, {
      sessionId: `budget-hit-${index}`, turnId: 1, messageId: `budget-hit-${index}`,
      ts: `2026-11-01T0${index}:00:00.000Z`, text: `预算词记录第${index}条：${filler}`,
    }).record);
    targets.push(addAt(memory, {
      sessionId: `budget-link-${index}`, turnId: 1, messageId: `budget-link-${index}`,
      ts: `2026-11-02T0${index}:00:00.000Z`, text: `另一段记录${index}：${filler}`,
    }).record);
    memory.addLink(hits[index - 1].id, targets[index - 1].id, 'referent');
  }

  const recalled = memory.recall({ query: '预算词', budgetChars: 1200, maxRecords: 6 });
  const { assembly } = recalled;
  assert.equal(recalled.hits.length <= MEMORY_ASSEMBLY.maxRecords, true, `rows<=6 (${recalled.hits.length})`);
  assert.equal(assembly.chars <= MEMORY_ASSEMBLY.maxChars, true, `chars<=1200 (${assembly.chars})`);
  assert.equal(assembly.charLimit, MEMORY_ASSEMBLY.maxChars);
  assert.equal(assembly.links, 1, 'only the link that fits is delivered');
  const droppedLink = assembly.dropped.find((entry) => entry.reason === 'char-budget'
    && targets.some((target) => target.id === entry.id));
  assert.ok(droppedLink !== undefined, `dropped records char-budget: ${JSON.stringify(assembly.dropped)}`);
  assert.equal(
    recalled.hits.some((row) => row.id === droppedLink.id),
    false,
    'the dropped link row is not in the block',
  );
  assert.equal(
    log.events.filter((entry) => entry.type === 'memory.link.expanded').length,
    1,
    'only the delivered link emits an expansion event',
  );
  console.log(
    `[5] rows=${recalled.hits.length} chars=${assembly.chars}/${assembly.charLimit} ` +
      `links=${assembly.links} dropped=${JSON.stringify(assembly.dropped.map((entry) => `${entry.messageId}:${entry.reason}`))}`,
  );
});

test('6) no reinforcement: a linked row is delivered but never sent to restore()', async (t) => {
  const root = await tempRoot();
  const memory = new MemoryStore(root, { capacity: 5000 });
  t.after(() => cleanup(root, memory));

  const base = Date.parse('2026-11-01T00:00:00.000Z');
  const hit = addAt(memory, {
    sessionId: 'nores', turnId: 1, messageId: 'nores-u',
    ts: new Date(base).toISOString(), text: '会议改到周四下午。',
  }).record;
  const linked = addAt(memory, {
    sessionId: 'nores', turnId: 1, role: 'assistant', messageId: 'nores-a',
    ts: new Date(base + 1000).toISOString(), text: '收到，我记下了。',
  }).record;

  let restoreCalls = 0;
  let restoredIds = [];
  const realRestore = memory.restore.bind(memory);
  memory.restore = (ids) => {
    restoreCalls += 1;
    restoredIds = [...ids];
    return realRestore(ids);
  };

  const recalled = memory.recall({ query: '会议', budgetChars: 1200, maxRecords: 6 });
  assert.equal(restoreCalls, 0, 'recall() itself never reinforces');
  const delivered = recalled.hits.filter(
    (row) => row.skippedByBudget !== true && String(row.text ?? '').trim().length > 0,
  );
  assert.equal(delivered.length, 2, 'both the hit and the link were delivered');
  const restorable = deliveredRecallRows(recalled.hits);
  assert.deepEqual(restorable.map((row) => row.id), [hit.id], 'only the direct hit is restorable');

  // The injection path uses `matchedIds` for feedback; the link is in `injectedIds` but not there.
  const composed = composeInjectionBlock({
    matched: recalled.hits,
    limits: { ...MEMORY_ASSEMBLY },
  });
  assert.equal(composed.injectedIds.includes(linked.id), true, 'the link body reaches the model');
  assert.equal(composed.matchedIds.includes(linked.id), false, 'the link is not a match to reinforce');
  assert.equal(composed.matchedIds.includes(hit.id), true);

  memory.restore(composed.matchedIds);
  assert.equal(restoreCalls, 1);
  assert.deepEqual(restoredIds, [hit.id], 'restore called with the direct hit only');
  const hitRow = rowOf(memory, hit.id);
  const linkedRow = rowOf(memory, linked.id);
  assert.equal(hitRow.importance, 62, 'the direct hit is reinforced');
  assert.equal(hitRow.recall_count, 1);
  assert.equal(linkedRow.importance, 60, 'the linked row keeps its importance');
  assert.equal(linkedRow.clarity, 'fuzzy', 'the linked row keeps its clarity');
  assert.equal(linkedRow.recall_count, 0, 'the linked row collected no recall credit');
  console.log(
    `[6] delivered=${delivered.map((row) => row.kind).join(',')} restoreCalls=${restoreCalls} ` +
      `restored=[${restoredIds.length}] linkImportance=${linkedRow.importance} linkRecalls=${linkedRow.recall_count}`,
  );
});

test('7) boundaries: hidden / superseded / archived / other-domain rows are never linked in', async (t) => {
  const root = await tempRoot();
  const memory = new MemoryStore(root, { capacity: 5000 });
  t.after(() => cleanup(root, memory));

  const hit = addAt(memory, {
    sessionId: 'bound', turnId: 1, messageId: 'bound-hit',
    ts: '2026-11-01T00:00:00.000Z', text: '边界暗号只在这条记录里。',
  }).record;
  const hidden = addAt(memory, {
    sessionId: 'b-hidden', turnId: 1, messageId: 'b-hidden',
    ts: '2026-11-01T01:00:00.000Z', text: '隐藏记录，不含暗号。',
  }).record;
  const superseded = addAt(memory, {
    sessionId: 'b-super', turnId: 1, messageId: 'b-super',
    ts: '2026-11-01T02:00:00.000Z', text: '废弃记录，不含暗号。',
  }).record;
  const work = addAt(memory, {
    sessionId: 'b-work', turnId: 1, messageId: 'b-work', domain: 'work',
    ts: '2026-11-01T03:00:00.000Z', text: '工作域记录，不含暗号。',
  }).record;
  const valid = addAt(memory, {
    sessionId: 'b-valid', turnId: 1, messageId: 'b-valid',
    ts: '2026-11-01T04:00:00.000Z', text: '有效邻居记录。',
  }).record;
  memory.db.prepare('UPDATE memory_event SET hidden = 1 WHERE id = ?').run(hidden.id);
  memory.db.prepare('UPDATE memory_event SET superseded_by = ? WHERE id = ?').run(hit.id, superseded.id);
  memory.db.prepare(`INSERT INTO memory_archive
    (id, ts, domain, kind, text, importance, clarity, archived_at, reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('b-archived', '2026-11-01T05:00:00.000Z', 'chat', 'event', '归档记录，不含暗号。', 60, 'trace',
      '2026-11-02T00:00:00.000Z', 'faded');
  for (const target of [hidden, superseded, work, valid]) {
    assert.equal(memory.addLink(hit.id, target.id, 'referent'), true);
  }
  assert.equal(memory.addLink(hit.id, 'b-archived', 'referent'), true);

  const recalled = memory.recall({
    query: '边界暗号', domains: ['chat'], budgetChars: 1200, maxRecords: 6,
  });
  const ids = recalled.hits.map((row) => row.id);
  assert.deepEqual(ids.sort(), [hit.id, valid.id].sort(), `only the active chat row is linked (${ids.length})`);
  for (const excluded of [hidden.id, superseded.id, work.id, 'b-archived']) {
    assert.equal(ids.includes(excluded), false, `${excluded} must not be injected`);
  }
  assert.equal(recalled.hits.find((row) => row.id === valid.id).kind, 'link');
  assert.equal(recalled.assembly.links, 1);
  console.log(
    `[7] hidden=0 superseded=0 archived=0 otherDomain=0 valid=1 rows=${recalled.hits.length} ` +
      `chars=${recalled.assembly.chars}`,
  );
});

test('8) performance: 1000 records + 100 links do not regress p95 against links disabled', async (t) => {
  const root = await tempRoot('dsh-mem-links-perf-');
  const memory = new MemoryStore(root, { capacity: 20_000 });
  t.after(() => cleanup(root, memory));

  const base = Date.parse('2026-11-01T00:00:00.000Z');
  const matching = [];
  const targets = [];
  for (let index = 0; index < 1000; index += 1) {
    const text = index % 5 === 0
      ? `部署方案记录第${index}条：这是相关的填充说明。`
      : `日常闲聊第${index}条：与问题无关的填充说明。`;
    const record = addAt(memory, {
      sessionId: `perf-${index}`, turnId: 1, messageId: `perf-${index}`,
      ts: new Date(base + index * 60_000).toISOString(), text,
    }).record;
    if (index % 5 === 0) matching.push(record);
    else if (targets.length < 100 && index % 5 === 1) targets.push(record);
  }
  assert.equal(memory.db.prepare('SELECT COUNT(*) AS c FROM memory_event').get().c, 1000);
  let links = 0;
  for (let index = 0; index < 100; index += 1) {
    const from = matching[index % matching.length];
    const to = targets[index % targets.length];
    if (memory.addLink(from.id, to.id, 'referent')) links += 1;
  }
  assert.equal(links, 100, '100 distinct links were written');

  const clock = () => Number(process.hrtime.bigint()) / 1e6;
  const measure = (followLinks) => {
    for (let warm = 0; warm < 5; warm += 1) {
      memory.recall({ query: '部署方案', budgetChars: 1200, maxRecords: 6, links: followLinks });
    }
    const runs = [];
    let last = null;
    for (let index = 0; index < 40; index += 1) {
      const started = clock();
      last = memory.recall({ query: '部署方案', budgetChars: 1200, maxRecords: 6, links: followLinks });
      runs.push(clock() - started);
    }
    runs.sort((left, right) => left - right);
    const at = (ratio) => runs[Math.max(0, Math.ceil(runs.length * ratio) - 1)];
    return { p50: at(0.5), p95: at(0.95), max: runs[runs.length - 1], last, runs };
  };

  const without = measure(false);
  const withLinks = measure(true);
  assert.equal(without.last.assembly.links, 0, 'the baseline follows no links');
  assert.ok(withLinks.last.assembly.links >= 1, 'the linked run really expanded a row');
  assert.equal(withLinks.last.assembly.chars <= MEMORY_ASSEMBLY.maxChars, true);
  // A link costs one indexed lookup per direct hit (<=4). Anything beyond a small constant factor
  // would mean the expansion leaked into the scoring/FTS path.
  assert.ok(
    withLinks.p95 <= without.p95 * 2 + 5,
    `p95 regression (links=${withLinks.p95.toFixed(2)}ms, off=${without.p95.toFixed(2)}ms)`,
  );
  const round = (value) => Math.round(value * 100) / 100;
  console.log(
    `[8] 1000 rows / 100 links: off p50=${round(without.p50)}ms p95=${round(without.p95)}ms ` +
      `max=${round(without.max)}ms; on p50=${round(withLinks.p50)}ms ` +
      `p95=${round(withLinks.p95)}ms max=${round(withLinks.max)}ms; ` +
      `rows=${withLinks.last.hits.length} chars=${withLinks.last.assembly.chars} links=${withLinks.last.assembly.links}`,
  );
});

test('9) the link table is outside FTS and outside capacity pressure', async (t) => {
  const root = await tempRoot();
  const memory = new MemoryStore(root, { capacity: 5000 });
  t.after(() => cleanup(root, memory));

  const a = addAt(memory, {
    sessionId: 'inv-a', turnId: 1, messageId: 'inv-a',
    ts: '2026-11-01T00:00:00.000Z', text: '链接表不占容量。',
  }).record;
  const b = addAt(memory, {
    sessionId: 'inv-b', turnId: 1, messageId: 'inv-b',
    ts: '2026-11-02T00:00:00.000Z', text: '它也不进全文索引。',
  }).record;
  const usageBefore = memory.usage();
  const pendingBefore = memory.policyState().pendingPressure;
  assert.equal(memory.addLink(a.id, b.id, 'referent'), true);
  assert.equal(memory.addLink(a.id, b.id, 'referent'), false, 'the same edge is idempotent');
  assert.equal(memory.addLink(a.id, b.id, 'not-a-kind'), false, 'an unknown kind is rejected');
  assert.equal(memory.linksFrom(a.id).length, 1);
  const usageAfter = memory.usage();
  assert.deepEqual(
    { records: usageAfter.records, chars: usageAfter.chars },
    { records: usageBefore.records, chars: usageBefore.chars },
    'links add no record and no stored characters',
  );
  assert.equal(memory.policyState().pendingPressure, pendingBefore, 'links charge no pressure');
  const tables = memory.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'memory_link%'")
    .all()
    .map((row) => row.name);
  assert.deepEqual(tables.sort(), ['memory_link'], 'no memory_link FTS shadow table exists');
  const fts = memory.db.prepare('SELECT COUNT(*) AS c FROM memory_link').get().c;
  assert.equal(fts, 1);
  console.log(
    `[9] linkRows=1 duplicatesIgnored=1 usage=${usageAfter.records}/${usageAfter.chars} ` +
      `pending=${memory.policyState().pendingPressure} tables=${tables.join(',')}`,
  );
});

test('10) a corrected basis retires the dependent `referent` edge: stale=1, dependent unresolved=1', async (t) => {
  const root = await tempRoot();
  const log = eventLog();
  const memory = new MemoryStore(root, { capacity: 5000, onEvent: log.onEvent });
  t.after(() => cleanup(root, memory));

  const intro = addAt(memory, {
    sessionId: 'basis-session', turnId: 1, messageId: 'basis-intro',
    ts: '2026-11-01T00:00:00.000Z', text: '我养了一只猫，叫团子',
  }).record;
  const dependent = addAt(memory, {
    sessionId: 'dep-session', turnId: 1, messageId: 'basis-dep',
    ts: '2026-11-02T00:00:00.000Z', text: '团子最近不爱吃饭',
  }).record;
  assert.equal(memory.addLink(dependent.id, intro.id, 'referent'), true);
  const edgeBefore = memory.linksFrom(dependent.id).find((row) => row.kind === 'referent');
  assert.equal(edgeBefore.toVersion, 1, 'the edge records the basis version it was built on');
  assert.equal(edgeBefore.stale, 0);
  assert.deepEqual(
    memory.linkedRecords(dependent.id).map((row) => row.id),
    [intro.id],
    'before the correction the edge really expands',
  );

  const corrected = memory.correct({
    targetId: intro.id,
    expectedVersion: 1,
    expectedText: '团子',
    replacement: '豆豆',
  });
  assert.equal(corrected.ok, true);
  assert.deepEqual(corrected.staleLinkIds, [dependent.id], 'the correction reports the retired edge');

  const edgeAfter = memory.linksFrom(dependent.id).find((row) => row.kind === 'referent');
  assert.equal(edgeAfter.stale, 1, 'the dependent edge is stale');
  assert.equal(edgeAfter.toVersion, 1, 'to_version is the version it was written against');
  assert.deepEqual(memory.linkedRecords(dependent.id), [], 'recall no longer follows a stale edge');
  const dependentRow = memory.db
    .prepare('SELECT text, unresolved FROM memory_event WHERE id = ?')
    .get(dependent.id);
  assert.equal(dependentRow.unresolved, 1, 'the dependent record is flagged unresolved');
  assert.equal(dependentRow.text, '团子最近不爱吃饭', 'the dependent wording is NOT renamed to 豆豆');

  const staleEvents = log.events.filter((entry) => entry.type === 'memory.link.stale');
  assert.deepEqual(
    staleEvents.map((entry) => entry.payload),
    [{ from: dependent.id, to: intro.id, reason: 'referent-corrected' }],
    'one memory.link.stale event per retired edge',
  );

  // Old name and corrected name never arrive together: the query for the new name returns only
  // the corrected introduction, and the query for the old name no longer drags the new wording in.
  const fresh = memory.recall({ query: '豆豆', budgetChars: 1200, maxRecords: 6 });
  assert.deepEqual(fresh.hits.map((row) => row.id), [intro.id], 'new name -> the corrected basis only');
  assert.equal(fresh.hits.some((row) => String(row.text).includes('团子')), false);
  const stale = memory.recall({ query: '团子', budgetChars: 1200, maxRecords: 6 });
  assert.deepEqual(stale.hits.map((row) => row.id), [dependent.id], 'old name -> the dependent only');
  assert.equal(
    stale.hits.some((row) => String(row.text).includes('豆豆')),
    false,
    'the corrected name is not injected next to the stale dependency',
  );
  console.log(
    `[10] stale=${edgeAfter.stale} to_id=${edgeAfter.toId === intro.id} dependents=${corrected.staleLinkIds.length} ` +
      `unresolved=${dependentRow.unresolved} text="${dependentRow.text}" ` +
      `recall(豆豆)=${fresh.hits.length}row recall(团子)=${stale.hits.length}row ` +
      `event=${JSON.stringify(staleEvents[0]?.payload)}`,
  );
});

test('11) the `referent` edge points at the introduction the normalizer resolved, not at earlier chit-chat', async (t) => {
  const root = await tempRoot();
  const memory = new MemoryStore(root, { capacity: 5000 });
  t.after(() => cleanup(root, memory));

  // Chit-chat mentions the word first, the introduction comes second: only the introduction is
  // the basis of the pronoun, and the link must say so.
  const chitchat = addAt(memory, {
    sessionId: 'pick', turnId: 1, messageId: 'pick-chitchat',
    ts: '2026-11-01T10:00:00.000Z', text: '团子这个名字真可爱',
  }).record;
  const intro = addAt(memory, {
    sessionId: 'pick', turnId: 1, messageId: 'pick-intro',
    ts: '2026-11-01T10:05:00.000Z', text: '我养了一只猫，叫团子',
  }).record;
  assert.ok(chitchat !== null && intro !== null);

  const context = () => {
    const rows = memory.messageRecords({ sessionId: 'pick', limit: 4 });
    return { previous: rows.map((row) => row.text).reverse(), records: rows };
  };
  const recorder = createAutoMemoryRecorder({
    memory,
    settings: { enabled: true, minChars: 1, maxChars: 400, includeReply: false },
    contextOf: context,
  });
  await recorder.handle({ id: 'pick' }, {
    type: 'user/message',
    time: Date.parse('2026-11-01T10:10:00.000Z'),
    data: {
      id: 'pick-pronoun', role: 'user', source: { kind: 'user' },
      content: [{ type: 'text', text: '她不爱吃饭' }],
    },
  });
  const expanded = memory.db
    .prepare("SELECT id, text FROM memory_event WHERE message_id = 'pick-pronoun'")
    .get();
  assert.equal(expanded.text, '团子不爱吃饭', 'the pronoun was expanded from the introduction');
  const edges = linkRows(memory).filter((edge) => edge.kind === 'referent');
  assert.equal(edges.length, 1, 'exactly one referent edge');
  assert.equal(edges[0].fromId, expanded.id);
  assert.equal(edges[0].toId, intro.id, 'the edge points at the introduction');
  assert.notEqual(edges[0].toId, chitchat.id, 'the earlier chit-chat is not the basis');
  console.log(
    `[11] to_id=intro:${edges[0].toId === intro.id} chitchat:${edges[0].toId === chitchat.id} ` +
      `text="${expanded.text}" edges=${edges.length}`,
  );
});

test('12) the pair/neighbour fallback never bypasses the domain filter', async (t) => {
  const root = await tempRoot();
  const memory = new MemoryStore(root, { capacity: 5000 });
  t.after(() => cleanup(root, memory));

  const hit = addAt(memory, {
    sessionId: 'scope', turnId: 3, messageId: 'scope-chat',
    ts: '2026-11-01T10:00:00.000Z', text: '作用域暗号只写在闲聊这条里',
  }).record;
  const sameTurn = addAt(memory, {
    sessionId: 'scope', turnId: 3, role: 'assistant', domain: 'work', messageId: 'scope-work-pair',
    ts: '2026-11-01T10:00:01.000Z', text: '工作域的同轮回复不该被带进来',
  }).record;
  const neighbour = addAt(memory, {
    sessionId: 'scope', turnId: 4, domain: 'work', messageId: 'scope-work-neighbour',
    ts: '2026-11-01T10:05:00.000Z', text: '工作域的相邻轮也不该被带进来',
  }).record;

  const recalled = memory.recall({ query: '作用域暗号', domains: ['chat'], budgetChars: 1200, maxRecords: 6 });
  const ids = recalled.hits.map((row) => row.id);
  assert.deepEqual(ids, [hit.id], `only the chat row (${ids.length})`);
  assert.equal(ids.includes(sameTurn.id), false, 'the work pair is filtered out');
  assert.equal(ids.includes(neighbour.id), false, 'the work neighbour is filtered out');
  assert.equal(recalled.assembly.pairs, 0);
  assert.equal(recalled.assembly.neighbors, 0);
  assert.equal(recalled.hits.every((row) => row.domain === 'chat'), true, 'no other domain leaked in');
  console.log(
    `[12] domain=chat hits=${recalled.hits.length} ids=${ids.length} ` +
      `pairs=${recalled.assembly.pairs} neighbors=${recalled.assembly.neighbors} ` +
      `domains=${recalled.hits.map((row) => row.domain).join(',')}`,
  );
});

test('13) the pair/neighbour fallback never bypasses the asked time window', async (t) => {
  const root = await tempRoot();
  const memory = new MemoryStore(root, { capacity: 5000 });
  t.after(() => cleanup(root, memory));

  const now = new Date('2026-11-06T12:00:00.000Z'); // "刚才" = [11:00Z, 12:00Z)
  // The turn started before the window and the reply landed inside it: only the reply is in scope.
  const userBefore = addAt(memory, {
    sessionId: 'win', turnId: 5, messageId: 'win-user',
    ts: '2026-11-06T10:45:00.000Z', text: '部署方案要改',
  }).record;
  const replyInside = addAt(memory, {
    sessionId: 'win', turnId: 5, role: 'assistant', messageId: 'win-reply',
    ts: '2026-11-06T11:30:00.000Z', text: '刚才的部署方案我已经改好了',
  }).record;
  const neighbourBefore = addAt(memory, {
    sessionId: 'win', turnId: 4, messageId: 'win-neighbour',
    ts: '2026-11-06T10:00:00.000Z', text: '更早提过的部署方案背景',
  }).record;

  const recalled = memory.recall({ query: '刚才的部署方案', now, budgetChars: 1200, maxRecords: 6 });
  const ids = recalled.hits.map((row) => row.id);
  assert.deepEqual(ids, [replyInside.id], `only the in-window row (${ids.length})`);
  for (const outside of [userBefore.id, neighbourBefore.id]) {
    assert.equal(ids.includes(outside), false, `${outside} is outside the asked window`);
  }
  assert.equal(recalled.assembly.pairs, 0);
  assert.equal(recalled.assembly.neighbors, 0);
  assert.equal(recalled.range, '刚才');
  console.log(
    `[13] range=${recalled.range} from=${recalled.from} to=${recalled.to} hits=${recalled.hits.length} ` +
      `pairs=${recalled.assembly.pairs} neighbors=${recalled.assembly.neighbors} outsideExcluded=2`,
  );
});

test('14) a stale referent dependency is flagged on the delivered hit, never passed off as a confirmed original', async (t) => {
  const root = await tempRoot();
  const memory = new MemoryStore(root, { capacity: 5000 });
  t.after(() => cleanup(root, memory));

  const { dependent, corrected } = seedStaleReferent(memory, 'stale-repro');
  assert.equal(corrected.ok, true);
  assert.deepEqual(corrected.staleLinkIds, [dependent.id], 'the correction retired the dependent edge');

  // Query the OLD name: the stale dependent is the direct hit and the corrected basis arrives as a
  // neighbour — exactly the reported repro (命中「团子最近不爱吃饭」, 邻轮「…叫豆豆」).
  const recalled = memory.recall({ query: '团子', budgetChars: 1200, maxRecords: 6 });
  const hit = recalled.hits.find((row) => row.id === dependent.id);
  assert.ok(hit !== undefined, 'the stale dependent is still delivered (evidence is not hidden)');
  assert.equal(hit.kind, 'hit');
  assert.equal(hit.unresolved, 1, 'the recall row carries unresolved=1');
  assert.equal(hit.staleLink, true, 'the row knows its referent edge is stale');
  assert.ok(hit.text.includes('团子最近不爱吃饭'), 'the stored wording is delivered, not silently renamed');
  assert.ok(hit.text.includes('[待核验]'), 'it is marked as pending verification');
  assert.equal(
    recalled.hits.some((row) => String(row.text).includes('团子最近不爱吃饭') && !String(row.text).includes('[待核验]')),
    false,
    'no path delivers the stale expansion as a bare, confirmed original',
  );
  // The corrected basis may appear as context, but only as the corrected text.
  const neighbour = recalled.hits.find((row) => row.kind === 'neighbor');
  if (neighbour !== undefined) assert.ok(neighbour.text.includes('豆豆'));
  console.log(
    `[14] hit=${hit.kind} unresolved=${hit.unresolved} staleLink=${hit.staleLink} ` +
      `text="${hit.text}" correctedText=${corrected.text} neighbours=${recalled.assembly.neighbors}`,
  );
});

test('15) a stale dependency reached through the neighbour expansion is flagged the same way', async (t) => {
  const root = await tempRoot();
  const memory = new MemoryStore(root, { capacity: 5000 });
  t.after(() => cleanup(root, memory));

  const { intro, dependent } = seedStaleReferent(memory, 'stale-neighbour');

  // Query the NEW name: only the corrected basis is a hit, so the stale dependent can only enter
  // through the ±window neighbour expansion — the path that used to repackage it as a plain original.
  const recalled = memory.recall({ query: '豆豆', budgetChars: 1200, maxRecords: 6 });
  const hit = recalled.hits.find((row) => row.id === intro.id);
  const neighbour = recalled.hits.find((row) => row.id === dependent.id);
  assert.ok(hit !== undefined && hit.kind === 'hit', 'the corrected basis is the direct hit');
  assert.ok(neighbour !== undefined, 'the dependent arrives as context');
  assert.equal(neighbour.kind, 'neighbor', 'it came through the neighbour pass');
  assert.equal(recalled.assembly.neighbors, 1);
  assert.equal(neighbour.unresolved, 1, 'the neighbour row is flagged unresolved, not a confirmed fact');
  assert.equal(neighbour.staleLink, true);
  assert.ok(neighbour.text.includes('[待核验]'), 'the neighbour body carries the marker too');
  assert.equal(
    recalled.hits.filter((row) => String(row.text).includes('团子最近不爱吃饭')
      && !String(row.text).includes('[待核验]')).length,
    0,
    'the neighbour expansion cannot re-wrap the stale dependency as confirmed',
  );
  console.log(
    `[15] hit=${hit.kind} neighbour=${neighbour.kind} unresolved=${neighbour.unresolved} ` +
      `staleLink=${neighbour.staleLink} text="${neighbour.text}" neighbors=${recalled.assembly.neighbors}`,
  );
});

test('16) the C2 injection block renders the [待核验] marker in front of the stale body', async (t) => {
  const root = await tempRoot();
  const memory = new MemoryStore(root, { capacity: 5000 });
  t.after(() => cleanup(root, memory));

  const { dependent } = seedStaleReferent(memory, 'stale-injection');
  const recalled = memory.recall({ query: '豆豆', budgetChars: 1200, maxRecords: 6 });
  const composed = composeInjectionBlock({ matched: recalled.hits, limits: { ...MEMORY_ASSEMBLY } });
  assert.ok(composed.text.includes('[待核验]'), `the block carries the marker:\n${composed.text}`);
  const line = composed.text.split('\n').find((entry) => entry.includes('团子最近不爱吃饭'));
  assert.ok(line !== undefined, `the stale body reached the block:\n${composed.text}`);
  assert.ok(line.includes('[待核验]'), `the marker is in front of that exact line: ${line}`);
  assert.equal(composed.injectedIds.includes(dependent.id), true, 'the flagged body was really injected');
  console.log(`[16] injected=${composed.injectedIds.length} line="${line}" chars=${composed.injectedChars}`);
});

test('17) a healthy row keeps unresolved=0 / staleLink=false and no verification marker', async (t) => {
  const root = await tempRoot();
  const memory = new MemoryStore(root, { capacity: 5000 });
  t.after(() => cleanup(root, memory));

  const basis = addAt(memory, {
    sessionId: 'healthy', turnId: 1, messageId: 'healthy-basis',
    ts: '2026-11-01T00:00:00.000Z', text: '我养了一只猫，叫团子',
  }).record;
  const dependent = addAt(memory, {
    sessionId: 'healthy', turnId: 2, messageId: 'healthy-dependent',
    ts: '2026-11-01T00:05:00.000Z', text: '团子最近不爱吃饭',
  }).record;
  assert.ok(basis !== null && dependent !== null);
  assert.equal(memory.addLink(dependent.id, basis.id, 'referent'), true);

  const recalled = memory.recall({ query: '团子', budgetChars: 1200, maxRecords: 6 });
  assert.ok(recalled.hits.length >= 2, `hit + healthy link (${recalled.hits.length})`);
  for (const row of recalled.hits) {
    assert.equal(row.unresolved, 0, `${row.id} is not unresolved`);
    assert.equal(row.staleLink, false, `${row.id} has no stale referent edge`);
    assert.equal(String(row.text).includes('[待核验]'), false, `${row.id} carries no marker`);
  }
  const composed = composeInjectionBlock({ matched: recalled.hits, limits: { ...MEMORY_ASSEMBLY } });
  assert.equal(composed.text.includes('[待核验]'), false, 'the C2 block stays clean without a stale dependency');
  console.log(
    `[17] rows=${recalled.hits.length} unresolved=[${recalled.hits.map((row) => row.unresolved).join(',')}] ` +
      `staleLink=[${recalled.hits.map((row) => row.staleLink).join(',')}] marker=false`,
  );
});

test('18) the same-turn `pair` expansion applies the identical stale-dependency rule', async (t) => {
  const root = await tempRoot();
  const memory = new MemoryStore(root, { capacity: 5000 });
  t.after(() => cleanup(root, memory));

  // Same turn: a query for the new name hits the corrected basis, and its stale dependency can
  // only be reached through the same-turn pairing pass (not the ±window neighbour pass).
  const { intro, dependent } = seedStaleReferent(memory, 'stale-pair', { dependentTurn: 1 });
  const recalled = memory.recall({ query: '豆豆', budgetChars: 1200, maxRecords: 6 });
  const hit = recalled.hits.find((row) => row.id === intro.id);
  const pair = recalled.hits.find((row) => row.id === dependent.id);
  assert.ok(hit !== undefined && hit.kind === 'hit');
  assert.ok(pair !== undefined, 'the dependent arrives as same-turn context');
  assert.equal(pair.kind, 'pair', 'it came through the pair pass');
  assert.equal(pair.delivered, true, 'the pair row really delivered its body');
  assert.equal(recalled.assembly.pairs, 1);
  assert.equal(recalled.assembly.neighbors, 0);
  assert.equal(recalled.assembly.delivered, 2);
  assert.equal(pair.unresolved, 1);
  assert.equal(pair.staleLink, true);
  assert.ok(pair.text.includes('[待核验]'));
  console.log(
    `[18] hit=${hit.kind} pair=${pair.kind} unresolved=${pair.unresolved} ` +
      `staleLink=${pair.staleLink} text="${pair.text}" pairs=${recalled.assembly.pairs}`,
  );
});
