/**
 * Memory correction phase 1: one correction merges back into the original record.
 *
 * A correction is a LOCAL fragment replacement, never "store the wrong saying + store the
 * correction as a second memory". The target keeps its id, `raw_text` keeps the pre-rewrite
 * body, `version` increments, one bounded `memory_revision` row is written, an optional
 * `extraText` becomes one separate event record, and a correction message that was already
 * auto-recorded is marked `superseded_by` so retrieval stops returning the contradictory text.
 *
 * Run: node --test test/memory-correct.mjs
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { apply } from '../src/host/index.js';
import { MEMORY_REVISION_LIMIT, MemoryStore } from '../src/host/memory/store.js';

const { DatabaseSync } = await import('node:sqlite');

async function tempRoot() {
  return mkdtemp(join(tmpdir(), 'dsh-mem-correct-'));
}

async function cleanup(root, ...stores) {
  for (const store of stores) {
    try {
      store.close();
    } catch {
      /* already closed */
    }
  }
  await rm(root, { recursive: true, force: true }).catch(() => {});
}

const rowOf = (store, id) =>
  store.db.prepare('SELECT id, text, raw_text, version, updated_at, unresolved, superseded_by, importance, clarity, recall_count, hidden, message_id FROM memory_event WHERE id = ?').get(id);
const recordCount = (store) => store.db.prepare('SELECT COUNT(*) AS c FROM memory_event').get().c;
const revisionRows = (store, id) => store.db.prepare('SELECT * FROM memory_revision WHERE memory_id = ? ORDER BY rowid ASC').all(id);
const operationIds = (store, id) =>
  store.db.prepare('SELECT operation_id FROM memory_revision WHERE memory_id = ? ORDER BY rowid ASC').all(id)
    .map((row) => row.operation_id);
const archiveRow = (store, id) => store.db.prepare('SELECT * FROM memory_archive WHERE id = ?').get(id);
const ftsIds = (store, term) =>
  store.db.prepare('SELECT rowid FROM memory_fts WHERE memory_fts MATCH ?').all(`"${term}"`).map((row) => row.rowid);
const creditOf = (store, id) =>
  store.db
    .prepare('SELECT pressure_contribution AS contribution, pressure_epoch AS epoch FROM memory_event WHERE id = ?')
    .get(id);

/**
 * `count` auto message records with explicit, strictly increasing timestamps, so the pressure
 * consumption order `(ts, id)` is the insertion order and not a same-millisecond UUID tie.
 */
function seedMessageRecords(store, tag, count, { day = 5, hour = 0 } = {}) {
  const ids = [];
  for (let index = 0; index < count; index += 1) {
    const record = store.addMessage({
      role: 'user',
      sessionId: `s-${tag}`,
      turnId: index + 1,
      messageId: `${tag}-${index}`,
      ts: `2026-11-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:${String(index).padStart(2, '0')}.000Z`,
      text: `${tag} 记录 ${index}`,
    }).record;
    assert.ok(record !== null, `seed row ${index} was stored`);
    ids.push(record.id);
  }
  return ids;
}

/** A real legacy database (base columns only) so the ALTER migration itself is under test. */
async function legacyRoot() {
  const root = await tempRoot();
  const dir = join(root, 'memory');
  await mkdir(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, 'memory.db'));
  db.exec(`CREATE TABLE memory_event (
    id TEXT PRIMARY KEY,
    ts TEXT NOT NULL,
    domain TEXT NOT NULL,
    kind TEXT NOT NULL,
    text TEXT NOT NULL,
    importance INTEGER NOT NULL DEFAULT 50,
    clarity TEXT NOT NULL DEFAULT 'vivid',
    last_seen TEXT,
    recall_count INTEGER NOT NULL DEFAULT 0,
    pinned INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL DEFAULT ''
  )`);
  db.prepare(`INSERT INTO memory_event
    (id, ts, domain, kind, text, importance, clarity, last_seen, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('legacy-1', '2026-11-01T00:00:00.000Z', 'chat', 'fact', '原定星期五下午三点开会', 60, 'clear', '2026-11-01T00:00:00.000Z', 'manual');
  db.close();
  return root;
}

/** Mount the real plugin and expose its tools (same fake context as the other memory tests). */
function mount(root) {
  const tools = new Map();
  const cleanups = [];
  const effect = (fn) => {
    const value = fn();
    if (typeof value === 'function') cleanups.push(value);
    return value;
  };
  const ctx = {
    effect,
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
        webServer: {
          register() {
            return () => {};
          },
        },
      });
    },
  };
  apply(ctx, { root, enabled: true });
  const call = async (name, args = {}, exec = {}) => {
    const tool = tools.get(name);
    assert.ok(tool !== undefined, `tool registered: ${name}`);
    return tool.execute(args, exec);
  };
  return {
    call,
    tools,
    close: () => {
      for (const fn of cleanups.reverse()) fn();
    },
  };
}

test('1) unique hit + matching version + present fragment: local replace, record count unchanged, FTS moves', async (t) => {
  const root = await legacyRoot();
  const events = [];
  const store = new MemoryStore(root, {
    capacity: 2000,
    onEvent: (type, payload) => events.push({ type, payload }),
  });
  t.after(() => cleanup(root, store));
  store.open();

  // The incremental ALTER loop really ran: NOT NULL columns keep their defaults on an old row.
  const columns = new Set(store.db.prepare('PRAGMA table_info(memory_event)').all().map((row) => row.name));
  for (const name of ['raw_text', 'version', 'updated_at', 'unresolved', 'superseded_by']) {
    assert.ok(columns.has(name), `old database gained ${name}`);
  }
  assert.equal(rowOf(store, 'legacy-1').version, 1, 'legacy row defaults to version 1');
  assert.equal(rowOf(store, 'legacy-1').unresolved, 0, 'legacy row defaults to unresolved 0');
  assert.equal(recordCount(store), 1);

  const target = rowOf(store, 'legacy-1');
  const rowid = store.db.prepare('SELECT rowid FROM memory_event WHERE id = ?').get('legacy-1').rowid;
  assert.ok(ftsIds(store, '星期五下午').includes(rowid), 'the old fragment is in FTS before the correction');
  const pendingBefore = store.policyState().pendingPressure;

  const result = store.correct({
    targetId: 'legacy-1',
    expectedVersion: 1,
    expectedText: '星期五',
    replacement: '星期四',
    sourceMessageId: 'msg-1',
  });

  assert.equal(result.ok, true);
  assert.equal(result.version, 2);
  assert.equal(result.id, 'legacy-1');
  assert.equal(result.from, '星期五');
  assert.equal(result.to, '星期四');
  assert.equal(recordCount(store), 1, 'the correction did not create a second record');
  const after = rowOf(store, 'legacy-1');
  assert.equal(after.version, 2);
  assert.equal(after.raw_text, target.text, 'raw_text keeps the pre-rewrite body');
  assert.ok(after.text.includes('星期四'));
  assert.ok(!after.text.includes('星期五'));
  assert.equal(revisionRows(store, 'legacy-1').length, 1);
  assert.ok(ftsIds(store, '星期四下午').includes(rowid), 'the new fragment is searchable through FTS');
  assert.ok(!ftsIds(store, '星期五下午').includes(rowid), 'the replaced fragment is no longer in this row of FTS');
  assert.equal(store.policyState().pendingPressure, pendingBefore, 'UPDATE costs no pressure');
  const event = events.find((entry) => entry.type === 'memory.corrected');
  assert.ok(event !== undefined, 'memory.corrected is emitted');
  assert.deepEqual(
    { id: event.payload.id, version: event.payload.version, from: event.payload.from, to: event.payload.to, sourceMessageId: event.payload.sourceMessageId },
    { id: 'legacy-1', version: 2, from: '星期五', to: '星期四', sourceMessageId: 'msg-1' },
    'the event records fragments only',
  );
  assert.ok(!JSON.stringify(event.payload).includes('原定'), 'the full body never enters the event');
  console.log(`[1] records=${recordCount(store)} version=${after.version} raw_text=kept fts(old)=absent fts(new)=present pressure=${pendingBefore} event=fragments-only`);
});

test('2) stale expectedVersion: version-conflict with text and version untouched', async (t) => {
  const root = await tempRoot();
  const store = new MemoryStore(root, { capacity: 2000 });
  t.after(() => cleanup(root, store));
  const record = store.add('chat', '原定星期五下午三点开会', 'fact', { importance: 60 });

  const result = store.correct({
    targetId: record.id,
    expectedVersion: 2,
    expectedText: '星期五',
    replacement: '星期四',
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'version-conflict');
  assert.equal(result.currentVersion, 1);
  const after = rowOf(store, record.id);
  assert.equal(after.text, '原定星期五下午三点开会');
  assert.equal(after.version, 1);
  assert.equal(after.raw_text, null);
  assert.equal(revisionRows(store, record.id).length, 0);
  console.log(`[2] error=${result.error} currentVersion=${result.currentVersion} text/version unchanged revisions=0`);
});

test('3) missing or duplicated expectedText: fragment-mismatch, nothing written', async (t) => {
  const root = await tempRoot();
  const store = new MemoryStore(root, { capacity: 2000 });
  t.after(() => cleanup(root, store));
  const simple = store.add('chat', '原定星期五下午三点开会', 'fact', { importance: 60 });
  const repeated = store.add('chat', '星期五和星期五都要开会', 'fact', { importance: 60 });

  const missing = store.correct({
    targetId: simple.id,
    expectedVersion: 1,
    expectedText: '星期六',
    replacement: '星期日',
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.error, 'fragment-mismatch');

  const duplicated = store.correct({
    targetId: repeated.id,
    expectedVersion: 1,
    expectedText: '星期五',
    replacement: '星期四',
  });
  assert.equal(duplicated.ok, false);
  assert.equal(duplicated.error, 'fragment-mismatch');

  // No targetId and two records carry the fragment: ambiguous, neither may be touched.
  const firstAmbiguous = store.add('chat', '黄桃罐头买两瓶', 'fact', { importance: 50 });
  const secondAmbiguous = store.add('chat', '黄桃酸奶也要', 'fact', { importance: 50 });
  const ambiguous = store.correct({
    expectedVersion: 1,
    expectedText: '黄桃',
    replacement: '水蜜桃',
  });
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.error, 'needs-target');
  assert.equal(ambiguous.candidates.length, 2);
  assert.equal(rowOf(store, firstAmbiguous.id).text, '黄桃罐头买两瓶');
  assert.equal(rowOf(store, secondAmbiguous.id).text, '黄桃酸奶也要');
  assert.equal(revisionRows(store, firstAmbiguous.id).length, 0);
  assert.equal(revisionRows(store, secondAmbiguous.id).length, 0);

  assert.equal(rowOf(store, simple.id).text, '原定星期五下午三点开会');
  assert.equal(rowOf(store, repeated.id).text, '星期五和星期五都要开会');
  assert.equal(rowOf(store, repeated.id).version, 1);
  assert.equal(revisionRows(store, simple.id).length, 0);
  assert.equal(revisionRows(store, repeated.id).length, 0);
  console.log(`[3] missing=${missing.error} duplicated=${duplicated.error} ambiguous=${ambiguous.error}/${ambiguous.candidates.length} candidates; all versions=1 revisions=0`);
});

test('4) same sourceMessageId twice: second is idempotent and adds no revision', async (t) => {
  const root = await tempRoot();
  const store = new MemoryStore(root, { capacity: 2000 });
  t.after(() => cleanup(root, store));
  const record = store.add('chat', '原定星期五下午三点开会', 'fact', { importance: 60 });

  const first = store.correct({
    targetId: record.id,
    expectedVersion: 1,
    expectedText: '星期五',
    replacement: '星期四',
    sourceMessageId: 'idem-4',
  });
  assert.equal(first.ok, true);
  assert.equal(first.idempotent, false);
  const textAfterFirst = rowOf(store, record.id).text;
  const revisionsAfterFirst = revisionRows(store, record.id).length;

  // The retry still carries the version the caller fetched before the first success.
  const second = store.correct({
    targetId: record.id,
    expectedVersion: 1,
    expectedText: '星期五',
    replacement: '星期四',
    sourceMessageId: 'idem-4',
  });
  assert.equal(second.ok, true);
  assert.equal(second.idempotent, true);
  assert.equal(second.id, record.id);
  assert.equal(second.version, 2);
  assert.equal(rowOf(store, record.id).text, textAfterFirst);
  assert.equal(rowOf(store, record.id).version, 2);
  assert.equal(revisionRows(store, record.id).length, revisionsAfterFirst);
  assert.equal(recordCount(store), 1);
  console.log(`[4] first:idempotent=${first.idempotent} second:idempotent=${second.idempotent} version=${second.version} records=${recordCount(store)} revisions=${revisionsAfterFirst}`);
});

test('5) correction + extraText: target edited, one new record, delayed auto write suppressed', async (t) => {
  const root = await tempRoot();
  const seed = new MemoryStore(root, { capacity: 2000 });
  const record = seed.add('chat', '原定星期五下午三点开会', 'fact', { importance: 60 });
  seed.close();

  const app = mount(root);
  t.after(() => app.close());
  let captured = null;
  const original = MemoryStore.prototype.correct;
  MemoryStore.prototype.correct = function patched(...args) {
    captured = this;
    return original.apply(this, args);
  };
  t.after(() => {
    MemoryStore.prototype.correct = original;
  });

  const value = await app.call('assistant_memory_correct', {
    // No targetId: expectedText resolves the unique active record.
    expectedVersion: 1,
    expectedText: '星期五',
    replacement: '星期四',
    sourceMessageId: 'corr-5',
    extraText: '明天要买猫粮',
  });

  assert.equal(value.ok, true, value.error);
  assert.equal(value.version, 2);
  assert.ok(value.extraId.length > 0, 'the extra content became a separate record');
  assert.ok(captured !== null, 'the tool reached the store');
  assert.equal(recordCount(captured), 2, 'target + one extra record, no duplicate correction statement');
  const target = rowOf(captured, record.id);
  assert.equal(target.version, 2);
  assert.ok(target.text.includes('星期四'));
  const extra = captured.db.prepare('SELECT kind, importance, text, source FROM memory_event WHERE id = ?').get(value.extraId);
  assert.equal(extra.kind, 'event');
  assert.equal(extra.importance, 30);
  assert.equal(extra.text, '明天要买猫粮');
  assert.equal(extra.source, 'correction');

  // The correction message itself was not stored before the tool ran. The delayed recorder write
  // must not add the contradictory sentence afterwards.
  const delayed = captured.addMessage({
    role: 'user',
    sessionId: 's-5',
    turnId: 5,
    messageId: 'corr-5',
    text: '不是星期五是星期四。另外明天要买猫粮。',
  });
  assert.equal(delayed.deduped, true);
  assert.equal(delayed.skipped, 'superseded');
  assert.equal(recordCount(captured), 2, 'still target + extra only');
  console.log(`[5] records=${recordCount(captured)} targetVersion=${target.version} extra=${extra.kind}/${extra.importance} delayed=${delayed.skipped}`);
});

test('6) already-recorded pure correction: superseded_by target, hidden and refunded', async (t) => {
  const root = await tempRoot();
  const store = new MemoryStore(root, { capacity: 2000 });
  t.after(() => cleanup(root, store));
  const auto = store.addMessage({
    role: 'user',
    sessionId: 's-6',
    turnId: 6,
    messageId: 'corr-6',
    text: '不是星期五是星期四，你记错了',
  }).record;
  const target = store.add('chat', '原定星期五下午三点开会', 'fact', { importance: 60 });
  const pendingBefore = store.policyState().pendingPressure;
  const activeBefore = store.usage().records;

  const result = store.correct({
    targetId: target.id,
    expectedVersion: 1,
    expectedText: '星期五',
    replacement: '星期四',
    sourceMessageId: 'corr-6',
  });
  assert.equal(result.ok, true);
  assert.equal(result.supersededId, auto.id);
  const autoRow = rowOf(store, auto.id);
  assert.equal(autoRow.superseded_by, target.id);
  assert.equal(autoRow.hidden, 1, 'the merged correction row is marked hidden');
  assert.equal(autoRow.clarity, 'trace', 'and is already at the end of the fade path');
  assert.equal(recordCount(store), 2, 'the raw audit row survives in the active table');
  assert.equal(store.usage().records, activeBefore - 1, 'but hidden rows no longer occupy active capacity');
  assert.equal(store.policyState().pendingPressure, pendingBefore - 1, 'hiding the merged statement refunds its credit');

  const recalled = store.recall({ query: '不是星期五是星期四' });
  assert.ok(!recalled.hits.some((hit) => hit.id === auto.id), 'retrieval no longer returns the superseded statement');
  const searched = store.search({ query: '不是星期五是星期四' });
  assert.ok(!searched.hits.some((hit) => hit.id === auto.id), 'search no longer returns the superseded statement');
  console.log(`[6] superseded=${autoRow.superseded_by === target.id} hidden=${autoRow.hidden} clarity=${autoRow.clarity} active ${activeBefore}->${store.usage().records} pressure ${pendingBefore}->${store.policyState().pendingPressure} raw=${recordCount(store)}`);
});

test('7) injected failure mid-transaction: text, version, revision and supersede all roll back', async (t) => {
  const root = await tempRoot();
  const store = new MemoryStore(root, { capacity: 2000 });
  t.after(() => cleanup(root, store));
  const auto = store.addMessage({
    role: 'user',
    sessionId: 's-7',
    turnId: 7,
    messageId: 'corr-7',
    text: '不是星期五是星期四，你记错了',
  }).record;
  const target = store.add('chat', '原定星期五下午三点开会', 'fact', { importance: 60 });
  const before = rowOf(store, target.id);
  const pendingBefore = store.policyState().pendingPressure;
  const rowid = store.db.prepare('SELECT rowid FROM memory_event WHERE id = ?').get(target.id).rowid;

  const originalInsert = store.insert;
  store.insert = () => {
    throw new Error('injected failure after update/revision/supersede');
  };
  try {
    assert.throws(
      () => store.correct({
        targetId: target.id,
        expectedVersion: 1,
        expectedText: '星期五',
        replacement: '星期四',
        sourceMessageId: 'corr-7',
        extraText: '明天要买猫粮',
      }),
      /injected failure/,
    );
  } finally {
    store.insert = originalInsert;
  }

  const after = rowOf(store, target.id);
  assert.equal(after.text, before.text);
  assert.equal(after.version, 1);
  assert.equal(after.raw_text, null);
  assert.equal(after.superseded_by, null);
  assert.equal(rowOf(store, auto.id).superseded_by, null);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS c FROM memory_revision WHERE memory_id = ?').get(target.id).c, 0);
  assert.equal(recordCount(store), 2, 'the extra record did not survive');
  assert.equal(store.policyState().pendingPressure, pendingBefore, 'in-memory pressure also rolled back');
  assert.ok(ftsIds(store, '星期五下午').includes(rowid), 'old fragment still indexed');
  assert.ok(!ftsIds(store, '星期四下午').includes(rowid), 'no half-applied index entry');
  console.log(`[7] text/version/revision/supersede unchanged version=${after.version} revisions=0 records=2 pressure=${pendingBefore}`);
});

test('8) pressure and reinforcement are untouched by a correction', async (t) => {
  const root = await tempRoot();
  const store = new MemoryStore(root, { capacity: 2000 });
  t.after(() => cleanup(root, store));
  const record = store.add('chat', '原定星期五下午三点开会', 'fact', { importance: 60 });
  const before = store.db.prepare('SELECT importance, clarity, recall_count, last_seen, unresolved FROM memory_event WHERE id = ?').get(record.id);
  const pendingBefore = store.policyState().pendingPressure;

  const result = store.correct({
    targetId: record.id,
    expectedVersion: 1,
    expectedText: '星期五',
    replacement: '星期四',
    sourceMessageId: 'msg-8',
  });
  assert.equal(result.ok, true);
  const after = store.db.prepare('SELECT importance, clarity, recall_count, last_seen, unresolved FROM memory_event WHERE id = ?').get(record.id);
  assert.equal(store.policyState().pendingPressure, pendingBefore);
  assert.deepEqual({ ...after }, { ...before }, 'no importance/clarity/recall/last_seen change');
  console.log(`[8] pressure=${pendingBefore}->${store.policyState().pendingPressure} importance=${after.importance} clarity=${after.clarity} recall=${after.recall_count}`);
});

test('9) revertCorrection restores before_text, bumps version and appends history', async (t) => {
  const root = await tempRoot();
  const store = new MemoryStore(root, { capacity: 2000 });
  t.after(() => cleanup(root, store));
  const record = store.add('chat', '原定星期五下午三点开会', 'fact', { importance: 60 });
  const corrected = store.correct({
    targetId: record.id,
    expectedVersion: 1,
    expectedText: '星期五',
    replacement: '星期四',
    sourceMessageId: 'revert-9',
  });
  assert.equal(corrected.ok, true);
  const firstRevision = store.revisions(record.id)[0];
  assert.equal(firstRevision.beforeText, '原定星期五下午三点开会');
  assert.equal(firstRevision.afterText, '原定星期四下午三点开会');

  const reverted = store.revertCorrection(record.id, firstRevision.id);
  assert.equal(reverted.ok, true);
  assert.equal(reverted.version, 3);
  assert.equal(rowOf(store, record.id).text, '原定星期五下午三点开会');
  assert.equal(rowOf(store, record.id).version, 3);

  const history = store.revisions(record.id);
  assert.equal(history.length, 2, 'revert is appended, never rewritten');
  assert.equal(history[0].beforeText, '原定星期四下午三点开会');
  assert.equal(history[0].afterText, '原定星期五下午三点开会');
  assert.equal(history[0].sourceMessageId, null);
  assert.equal(history[1].sourceMessageId, 'revert-9');
  console.log(`[9] version=${reverted.version} text=restored revisions=${history.length} latest=${history[0].beforeText}→${history[0].afterText}`);
});

test('10) revision cap keeps only the newest N entries per record', async (t) => {
  const root = await tempRoot();
  const store = new MemoryStore(root, { capacity: 2000 });
  t.after(() => cleanup(root, store));
  const record = store.add('chat', '标记甲', 'fact', { importance: 60 });
  assert.equal(MEMORY_REVISION_LIMIT, 10);

  for (let index = 1; index <= 12; index += 1) {
    const expectedText = index % 2 === 1 ? '标记甲' : '标记乙';
    const replacement = index % 2 === 1 ? '标记乙' : '标记甲';
    const result = store.correct({
      targetId: record.id,
      expectedVersion: index,
      expectedText,
      replacement,
      sourceMessageId: `cap-${index}`,
    });
    assert.equal(result.ok, true, `correction ${index} failed: ${result.error}`);
  }

  const history = store.revisions(record.id, { limit: 100 });
  assert.equal(history.length, MEMORY_REVISION_LIMIT, 'only the newest 10 revisions remain');
  const sources = new Set(history.map((revision) => revision.sourceMessageId));
  assert.ok(!sources.has('cap-1'), 'oldest revision was trimmed');
  assert.ok(!sources.has('cap-2'), 'second oldest revision was trimmed');
  assert.ok(sources.has('cap-3'), 'the retained window starts at revision 3');
  assert.ok(sources.has('cap-12'), 'the newest revision is retained');
  assert.equal(rowOf(store, record.id).version, 13);
  assert.equal(recordCount(store), 1);
  console.log(`[10] version=${rowOf(store, record.id).version} revisions=${history.length} retained=${[...sources].sort((a, b) => Number(a.slice(4)) - Number(b.slice(4))).join(',')}`);
});

test('11) one source message, two different corrections: both apply; only an exact retry is idempotent', async (t) => {
  const root = await tempRoot();
  const store = new MemoryStore(root, { capacity: 2000 });
  t.after(() => cleanup(root, store));
  const record = store.add('chat', '数学作业周五交，英语作业周一交', 'fact', { importance: 60 });

  const first = store.correct({
    targetId: record.id,
    expectedVersion: 1,
    expectedText: '周五',
    replacement: '周四',
    sourceMessageId: 'same-source-11',
  });
  assert.equal(first.ok, true, first.error);
  assert.equal(first.idempotent, false);

  const second = store.correct({
    targetId: record.id,
    expectedVersion: 2,
    expectedText: '周一',
    replacement: '周二',
    sourceMessageId: 'same-source-11',
  });
  assert.equal(second.ok, true, second.error);
  assert.equal(second.idempotent, false, 'a different correction from the same message is not idempotent');
  assert.equal(second.version, 3);
  assert.equal(rowOf(store, record.id).text, '数学作业周四交，英语作业周二交');

  const ops = operationIds(store, record.id);
  assert.equal(ops.length, 2, 'two distinct operations were written');
  assert.equal(new Set(ops).size, 2, 'their operation ids differ');
  assert.ok(ops.every((id) => typeof id === 'string' && id.length > 0), 'every revision stores its operation id');

  const retry = store.correct({
    targetId: record.id,
    expectedVersion: 2,
    expectedText: '周一',
    replacement: '周二',
    sourceMessageId: 'same-source-11',
  });
  assert.equal(retry.ok, true, retry.error);
  assert.equal(retry.idempotent, true, 'the exact same operation is idempotent');
  assert.equal(retry.version, 3);
  assert.equal(revisionRows(store, record.id).length, 2, 'the retry added no revision');
  console.log(`[11] first.idempotent=${first.idempotent} second.idempotent=${second.idempotent} retry.idempotent=${retry.idempotent} version=${retry.version} ops=${ops.length}/${new Set(ops).size} revisions=${revisionRows(store, record.id).length}`);
});

test('12) host injects the current user message id; with no session it reports no-source', async (t) => {
  const root = await tempRoot();
  const seed = new MemoryStore(root, { capacity: 2000 });
  const math = seed.add('chat', '数学作业周五交', 'fact', { importance: 60 });
  const english = seed.add('chat', '英语作业周一交', 'fact', { importance: 60 });
  seed.close();

  let captured = null;
  const original = MemoryStore.prototype.correct;
  MemoryStore.prototype.correct = function patched(...args) {
    captured = this;
    return original.apply(this, args);
  };
  t.after(() => {
    MemoryStore.prototype.correct = original;
  });
  const app = mount(root);
  t.after(() => app.close());

  const exec = {
    agent: {
      session: {
        header: { cwd: join(root, 'workspace') },
        deriveMessages: () => [
          { id: 'previous-msg', role: 'user', source: { kind: 'user' } },
          { id: 'cur-msg-12', role: 'user', source: { kind: 'user' } },
          { id: 'runtime-context-12', role: 'user', source: { kind: 'runtime-context' } },
        ],
      },
    },
  };
  const injected = await app.call('assistant_memory_correct', {
    targetId: math.id,
    expectedVersion: 1,
    expectedText: '周五',
    replacement: '周四',
  }, exec);
  assert.equal(injected.ok, true, injected.error);
  assert.equal(injected.sourceMerged, true);
  assert.equal(injected.mergeReason, '');
  assert.equal(injected.sourceMessageId, 'cur-msg-12', 'the current genuine user message id was injected');
  assert.ok(captured !== null, 'the tool reached the store');
  const storedSource = captured.db
    .prepare('SELECT source_message_id FROM memory_revision WHERE memory_id = ? ORDER BY rowid DESC LIMIT 1')
    .get(math.id);
  assert.equal(storedSource.source_message_id, 'cur-msg-12', 'the revision records the injected source');

  const orphan = await app.call('assistant_memory_correct', {
    targetId: english.id,
    expectedVersion: 1,
    expectedText: '周一',
    replacement: '周二',
  }, {});
  assert.equal(orphan.ok, true, orphan.error);
  assert.equal(orphan.sourceMerged, false);
  assert.equal(orphan.mergeReason, 'no-source');
  assert.equal(orphan.sourceMessageId, '');
  console.log(`[12] injected source=${injected.sourceMessageId} sourceMerged=${injected.sourceMerged} | no-session sourceMerged=${orphan.sourceMerged} mergeReason=${orphan.mergeReason}`);
});

test('13) merging a pure correction shrinks active records and refunds its pressure', async (t) => {
  const root = await tempRoot();
  const store = new MemoryStore(root, { capacity: 2000 });
  t.after(() => cleanup(root, store));
  const auto = store.addMessage({
    role: 'user',
    sessionId: 's-13',
    turnId: 13,
    messageId: 'corr-13',
    text: '不是星期五是星期四，你记错了',
  }).record;
  const target = store.add('chat', '原定星期五下午三点开会', 'fact', { importance: 60 });
  const activeBefore = store.usage().records;
  const pendingBefore = store.policyState().pendingPressure;

  const result = store.correct({
    targetId: target.id,
    expectedVersion: 1,
    expectedText: '星期五',
    replacement: '星期四',
    sourceMessageId: 'corr-13',
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.supersededId, auto.id);
  const activeAfter = store.usage().records;
  const pendingAfter = store.policyState().pendingPressure;
  assert.equal(activeBefore, 2);
  assert.equal(activeAfter, 1, 'the pure correction row no longer counts as active capacity');
  assert.equal(pendingBefore, 2);
  assert.equal(pendingAfter, 1, 'exactly the hidden row contribution was refunded');
  assert.equal(store.policyState().pendingPressure, pendingAfter);
  const hidden = rowOf(store, auto.id);
  assert.equal(hidden.hidden, 1);
  assert.equal(hidden.superseded_by, target.id);
  console.log(`[13] usage.records ${activeBefore}->${activeAfter} pendingPressure ${pendingBefore}->${pendingAfter} hidden=${hidden.hidden} superseded_by=${hidden.superseded_by === target.id}`);
});

test('14) mixed message: target edited, one new record, pure correction part gone (net +1)', async (t) => {
  const root = await tempRoot();
  const store = new MemoryStore(root, { capacity: 2000 });
  t.after(() => cleanup(root, store));
  const auto = store.addMessage({
    role: 'user',
    sessionId: 's-14',
    turnId: 14,
    messageId: 'corr-14',
    text: '不是星期五是星期四。另外明天要买猫粮。',
  }).record;
  const target = store.add('chat', '原定星期五下午三点开会', 'fact', { importance: 60 });
  const activeBefore = store.usage().records;
  const pendingBefore = store.policyState().pendingPressure;

  const result = store.correct({
    targetId: target.id,
    expectedVersion: 1,
    expectedText: '星期五',
    replacement: '星期四',
    sourceMessageId: 'corr-14',
    extraText: '明天要买猫粮',
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(rowOf(store, target.id).text, '原定星期四下午三点开会');
  assert.equal(rowOf(store, auto.id).hidden, 1, 'the mixed correction row is no longer active');
  assert.equal(rowOf(store, result.extraId).text, '明天要买猫粮');
  assert.equal(store.usage().records, 2, 'target + the one genuinely new record');
  assert.equal(recordCount(store), 3, 'one hidden audit row keeps the raw count at three');
  // Before the merge: target + the original message record = 2. After: target + extra = 2;
  // the hidden correction row is replaced by the new-content record, so the target gained one.
  const netOverTarget = store.usage().records - (activeBefore - 1);
  assert.equal(netOverTarget, 1);
  const searched = store.search({ query: '不是星期五是星期四' });
  assert.ok(!searched.hits.some((hit) => hit.id === auto.id), 'the pure correction text is not searchable');
  console.log(`[14] active ${activeBefore}->${store.usage().records} raw=${recordCount(store)} pending ${pendingBefore}->${store.policyState().pendingPressure} extra=${result.extraId.length > 0} netOverTarget=${netOverTarget}`);
});

test('15) compact archives a hidden row with its flag; archive search hides it unless includeHidden', async (t) => {
  const root = await tempRoot();
  const store = new MemoryStore(root, { capacity: 10 });
  t.after(() => cleanup(root, store));
  const auto = store.addMessage({
    role: 'user',
    sessionId: 's-15',
    turnId: 15,
    messageId: 'corr-15',
    text: '不是星期五是星期四，你记错了',
  }).record;
  const target = store.add('chat', '原定星期五下午三点开会', 'fact', { importance: 60 });
  const corrected = store.correct({
    targetId: target.id,
    expectedVersion: 1,
    expectedText: '星期五',
    replacement: '星期四',
    sourceMessageId: 'corr-15',
  });
  assert.equal(corrected.ok, true, corrected.error);
  assert.equal(rowOf(store, auto.id).hidden, 1);
  for (let index = 0; index < 9; index += 1) {
    store.insert({
      id: `trace-15-${index}`,
      ts: `2026-11-05T00:00:0${index}.000Z`,
      domain: 'chat',
      kind: 'fact',
      text: `待归档记录${index}`,
      importance: 10,
      clarity: 'trace',
      source: 'test',
    });
  }
  const activeBefore = store.usage().records;
  assert.equal(activeBefore, 10, 'target + nine visible trace rows; the hidden row is not counted');

  const compacted = store.compact({ targetRatio: 0.85 });
  assert.equal(store.usage().records, 8);
  const archived = archiveRow(store, auto.id);
  assert.ok(archived !== undefined, 'the hidden row was archived by compact');
  assert.equal(archived.hidden, 1, 'the hidden flag survived the move');
  assert.equal(archived.superseded_by, target.id, 'the superseded target survived the move');
  assert.equal(compacted.after, 8);
  assert.ok(compacted.moved >= 3, 'hidden row plus two visible trace rows were moved');

  const hiddenSearch = store.searchArchive('不是星期五是星期四');
  assert.equal(hiddenSearch.length, 0, 'hidden archive rows are excluded by default');
  const visibleSearch = store.searchArchive('不是星期五是星期四', 5, { includeHidden: true });
  assert.ok(visibleSearch.some((row) => row.id === auto.id), 'includeHidden exposes the audit row');
  const listed = store.listArchive({ query: '不是星期五是星期四' });
  assert.equal(listed.length, 0, 'default listArchive excludes hidden rows');
  const listedHidden = store.listArchive({ query: '不是星期五是星期四', includeHidden: true });
  assert.ok(listedHidden.some((row) => row.id === auto.id));
  console.log(`[15] active ${activeBefore}->${store.usage().records} moved=${compacted.moved} archivedHidden=${archived.hidden} search.default=${hiddenSearch.length} search.includeHidden=${visibleSearch.length} list.default=${listed.length}`);
});

test('16) revertCorrection restores the hidden correction row and its pressure', async (t) => {
  const root = await tempRoot();
  const store = new MemoryStore(root, { capacity: 2000 });
  t.after(() => cleanup(root, store));
  const auto = store.addMessage({
    role: 'user',
    sessionId: 's-16',
    turnId: 16,
    messageId: 'corr-16',
    text: '不是星期五是星期四，你记错了',
  }).record;
  const target = store.add('chat', '原定星期五下午三点开会', 'fact', { importance: 60 });
  const pendingBefore = store.policyState().pendingPressure;
  const corrected = store.correct({
    targetId: target.id,
    expectedVersion: 1,
    expectedText: '星期五',
    replacement: '星期四',
    sourceMessageId: 'corr-16',
  });
  assert.equal(corrected.ok, true, corrected.error);
  assert.equal(store.usage().records, 1, 'hidden after the merge');
  assert.equal(store.policyState().pendingPressure, pendingBefore - 1);

  const reverted = store.revertCorrection(target.id, corrected.revisionId);
  assert.equal(reverted.ok, true, reverted.error);
  assert.equal(reverted.restoredId, auto.id, 'the merged source row is the one restored');
  const restored = rowOf(store, auto.id);
  assert.equal(restored.hidden, 0, 'the row is active again');
  assert.equal(restored.superseded_by, null);
  assert.equal(restored.clarity, 'vivid');
  assert.equal(rowOf(store, target.id).text, '原定星期五下午三点开会');
  assert.equal(store.usage().records, 2);
  assert.equal(store.policyState().pendingPressure, pendingBefore, 'the restored row charges its credit again');
  console.log(`[16] restored=${reverted.restoredId === auto.id} hidden ${1}->${restored.hidden} active=1->${store.usage().records} pending ${pendingBefore - 1}->${store.policyState().pendingPressure} revisionVersion=${reverted.version}`);
});

test('17) P2-1 same replacement on two different targets: both apply and neither is idempotent', async (t) => {
  const root = await tempRoot();
  const store = new MemoryStore(root, { capacity: 2000 });
  t.after(() => cleanup(root, store));
  const firstTarget = store.add('chat', '甲乙丙丁戊', 'fact', { importance: 60 });

  // No targetId: the unique match is the first target. Its correction removes the fragment.
  const first = store.correct({
    expectedVersion: 1,
    expectedText: '甲乙丙',
    replacement: '丁戊己',
    sourceMessageId: 'collide-17',
  });
  assert.equal(first.ok, true, first.error);
  assert.equal(first.idempotent, false);
  assert.equal(first.id, firstTarget.id);
  assert.equal(rowOf(store, firstTarget.id).text, '丁戊己丁戊');

  // A second record now owns the only occurrence of the same fragment. The operation key must
  // contain this resolved id, otherwise this call returns idempotent:true and never updates it.
  const secondTarget = store.add('chat', '甲乙丙庚辛', 'fact', { importance: 60 });
  const second = store.correct({
    expectedVersion: 1,
    expectedText: '甲乙丙',
    replacement: '丁戊己',
    sourceMessageId: 'collide-17',
  });
  assert.equal(second.ok, true, second.error);
  assert.equal(second.idempotent, false, 'a different target is a different operation');
  assert.equal(second.id, secondTarget.id);
  assert.notEqual(second.id, first.id);
  assert.equal(rowOf(store, secondTarget.id).text, '丁戊己庚辛');
  assert.equal(rowOf(store, firstTarget.id).text, '丁戊己丁戊', 'the first target is not edited again');
  assert.equal(recordCount(store), 2);
  assert.equal(revisionRows(store, firstTarget.id).length, 1);
  assert.equal(revisionRows(store, secondTarget.id).length, 1);
  const ops = [...operationIds(store, firstTarget.id), ...operationIds(store, secondTarget.id)];
  assert.equal(new Set(ops).size, 2, 'the two operations carry different ids');
  console.log(`[17] A=${first.id.slice(0, 8)} v1→${first.version} idempotent=${first.idempotent} | B=${second.id.slice(0, 8)} v1→${second.version} idempotent=${second.idempotent} ops=${new Set(ops).size} records=${recordCount(store)}`);
});

test('18) P2-1 unresolved target: needs-target with candidates, nothing modified', async (t) => {
  const root = await tempRoot();
  const store = new MemoryStore(root, { capacity: 2000 });
  t.after(() => cleanup(root, store));
  const first = store.add('chat', '黄桃罐头买两瓶', 'fact', { importance: 50 });
  const second = store.add('chat', '黄桃酸奶也要', 'fact', { importance: 50 });
  const before = {
    records: recordCount(store),
    first: { ...rowOf(store, first.id) },
    second: { ...rowOf(store, second.id) },
  };

  const ambiguous = store.correct({
    expectedVersion: 1,
    expectedText: '黄桃',
    replacement: '水蜜桃',
  });
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.error, 'needs-target');
  assert.equal(ambiguous.candidates.length, 2);
  assert.equal(ambiguous.idempotent, false);

  const missing = store.correct({
    expectedVersion: 1,
    expectedText: '根本不存在的片段',
    replacement: '替换',
  });
  assert.equal(missing.error, 'needs-target');
  assert.equal(missing.candidates.length, 0, 'an empty hit is still reported through needs-target');

  const unknownId = store.correct({
    targetId: 'no-such-record',
    expectedVersion: 1,
    expectedText: '黄桃',
    replacement: '水蜜桃',
  });
  assert.equal(unknownId.error, 'needs-target');
  assert.equal(unknownId.candidates.length, 0);

  assert.equal(recordCount(store), before.records, 'no record was added');
  assert.deepEqual({ ...rowOf(store, first.id) }, before.first, 'first target untouched');
  assert.deepEqual({ ...rowOf(store, second.id) }, before.second, 'second target untouched');
  assert.equal(revisionRows(store, first.id).length, 0);
  assert.equal(revisionRows(store, second.id).length, 0);
  console.log(`[18] ambiguous=${ambiguous.error}/${ambiguous.candidates.length} missing=${missing.error}/${missing.candidates.length} unknownId=${unknownId.error}/${unknownId.candidates.length} records=${recordCount(store)} revisions=0`);
});

test('19) P2-1 target version changed: the redo is a new operation and applies on the new version', async (t) => {
  const root = await tempRoot();
  const store = new MemoryStore(root, { capacity: 2000 });
  t.after(() => cleanup(root, store));
  const record = store.add('chat', '星期五下午三点开会', 'fact', { importance: 60 });

  const first = store.correct({
    targetId: record.id,
    expectedVersion: 1,
    expectedText: '星期五',
    replacement: '星期四',
    sourceMessageId: 'version-19',
  });
  assert.equal(first.ok, true, first.error);
  assert.equal(first.version, 2);

  // Undo the first edit: the text (and thereby the same replacement) becomes applicable again,
  // while the record's version has moved from 1 to 3.
  const reverted = store.revertCorrection(record.id, first.revisionId);
  assert.equal(reverted.ok, true, reverted.error);
  assert.equal(reverted.version, 3);
  assert.equal(rowOf(store, record.id).text, '星期五下午三点开会');

  const redo = store.correct({
    targetId: record.id,
    expectedVersion: 3,
    expectedText: '星期五',
    replacement: '星期四',
    sourceMessageId: 'version-19',
  });
  assert.equal(redo.ok, true, redo.error);
  assert.equal(redo.idempotent, false, 'a new target version is a new operation, not a retry');
  assert.equal(redo.version, 4);
  assert.equal(rowOf(store, record.id).text, '星期四下午三点开会');

  const history = store.revisions(record.id, { limit: 100 });
  assert.equal(history.length, 3, 'first correction + revert + redo');
  assert.ok(history.some((revision) => revision.id === first.revisionId), 'the old revision is retained');
  const ops = operationIds(store, record.id).filter(Boolean);
  assert.equal(ops.length, 2, 'two applied operations');
  assert.notEqual(ops[0], ops[1], 'the redo got a new operation id');
  console.log(`[19] first v1→2 idempotent=${first.idempotent} revert v${reverted.version} redo v3→${redo.version} idempotent=${redo.idempotent} revisions=${history.length} ops=${ops.length}/${new Set(ops).size}`);
});

test('20) P2-2 old-cycle message after maintain release: merge leaves pendingPressure unchanged', async (t) => {
  const root = await tempRoot();
  let store = new MemoryStore(root, { capacity: 1000 });
  t.after(() => cleanup(root, store));
  const auto = store.addMessage({
    role: 'user',
    sessionId: 's-20',
    turnId: 20,
    messageId: 'corr-20',
    text: '不是星期五是星期四，你记错了',
  }).record;
  const target = store.add('chat', '原定星期五下午三点开会', 'fact', { importance: 60 });
  assert.equal(store.policyState().pendingPressure, 2);
  assert.equal(store.pressureEpoch, 0);

  // Tiny table: the release line ends the first pressure cycle and retires its contributions.
  const released = store.maintain();
  assert.equal(released.pendingPressure, 0);
  const epochAfterRelease = store.pressureEpoch;
  assert.equal(epochAfterRelease, 1);

  // The epoch is durable, not an in-memory accident.
  store.close();
  store = new MemoryStore(root, { capacity: 1000 });
  store.open();
  assert.equal(store.pressureEpoch, epochAfterRelease, 'the epoch survives a restart');
  assert.equal(store.policyState().pendingPressure, 0);

  // A new cycle builds its own balance.
  for (let index = 0; index < 3; index += 1) store.add('chat', `新周期记录${index}`, 'fact', { importance: 40 });
  const pendingBefore = store.policyState().pendingPressure;
  assert.equal(pendingBefore, 3);

  const stale = store.withdrawPressureForMessage('corr-20');
  assert.equal(stale.withdrawn, false, 'an old-cycle contribution is not refundable');
  assert.equal(stale.reason, 'stale-epoch');
  assert.equal(store.policyState().pendingPressure, 3, 'the new cycle keeps its balance');

  const corrected = store.correct({
    targetId: target.id,
    expectedVersion: 1,
    expectedText: '星期五',
    replacement: '星期四',
    sourceMessageId: 'corr-20',
  });
  assert.equal(corrected.ok, true, corrected.error);
  assert.equal(corrected.supersededId, auto.id);
  assert.equal(store.policyState().pendingPressure, pendingBefore, 'merging the old message deducts nothing from the new cycle');
  console.log(`[20] release pending 2→0 epoch=${epochAfterRelease} persist=ok newCyclePending=${pendingBefore} withdraw=${stale.withdrawn}/${stale.reason} afterMerge=${store.policyState().pendingPressure}`);
});

test('21) P2-2 same cycle: one refund only, repeated withdrawal is consumed and replay adds nothing', async (t) => {
  const root = await tempRoot();
  const store = new MemoryStore(root, { capacity: 2000 });
  t.after(() => cleanup(root, store));
  const auto = store.addMessage({
    role: 'user',
    sessionId: 's-21',
    turnId: 21,
    messageId: 'corr-21',
    text: '不是星期五是星期四，你记错了',
  }).record;
  const target = store.add('chat', '原定星期五下午三点开会', 'fact', { importance: 60 });
  assert.equal(store.policyState().pendingPressure, 2);
  assert.equal(store.pressureEpoch, 0);

  const first = store.withdrawPressureForMessage('corr-21');
  assert.equal(first.withdrawn, true);
  assert.equal(first.contribution, 1);
  assert.equal(first.epoch, 0);
  assert.equal(store.policyState().pendingPressure, 1, 'exactly the one contribution is refunded');

  const repeated = store.withdrawPressureForMessage('corr-21');
  assert.equal(repeated.withdrawn, false);
  assert.equal(repeated.reason, 'already-consumed');
  assert.equal(store.policyState().pendingPressure, 1, 'the second withdrawal changes nothing');

  // The correction still merges (hides the auto row), but its refund was already spent above.
  const corrected = store.correct({
    targetId: target.id,
    expectedVersion: 1,
    expectedText: '星期五',
    replacement: '星期四',
    sourceMessageId: 'corr-21',
  });
  assert.equal(corrected.ok, true, corrected.error);
  assert.equal(corrected.supersededId, auto.id);
  assert.equal(store.policyState().pendingPressure, 1, 'the merge does not deduct a second time');
  console.log(`[21] epoch=${first.epoch} pending 2→${first.pendingPressure} repeat=${repeated.withdrawn}/${repeated.reason} afterMerge=${store.policyState().pendingPressure}`);
});

// ---------------------------------------------------------------------------------------------
// P2-2 same-cycle gap: a decay charge must consume the per-row contributions it pays for, not
// only the aggregate `pendingPressure`; otherwise an already-spent credit stays refundable.
// ---------------------------------------------------------------------------------------------

test('22) P2-2 complete consumption: a fade spends every credit, so no old message is refundable', async (t) => {
  const root = await tempRoot();
  const store = new MemoryStore(root, { capacity: 10, pressureThreshold: 9 });
  t.after(() => cleanup(root, store));
  const ids = seedMessageRecords(store, 'p22', 9);
  assert.equal(store.policyState().pendingPressure, 9);
  assert.equal(store.pressureEpoch, 0);
  const creditsBefore = ids.map((id) => creditOf(store, id));
  assert.deepEqual(creditsBefore.map((row) => row.contribution), Array(9).fill(1));
  assert.ok(creditsBefore.every((row) => row.epoch === 0));

  const result = store.maintain();
  assert.ok(result.faded > 0, 'the 90% crossing really demoted rows');
  assert.equal(result.pendingPressure, 0, 'pending 9 → 0');
  assert.equal(store.pressureEpoch, 0, '0.90 > 0.85: the crossing is charged, not released');
  const creditsAfter = ids.map((id) => creditOf(store, id));
  assert.deepEqual(creditsAfter.map((row) => row.contribution), Array(9).fill(0), 'every row contribution 1 → 0');
  assert.ok(creditsAfter.every((row) => row.epoch === 0), 'the rows keep their cycle');

  for (const messageId of ['p22-0', 'p22-4', 'p22-8']) {
    const withdrawn = store.withdrawPressureForMessage(messageId);
    assert.equal(withdrawn.withdrawn, false, `${messageId} has nothing left to refund`);
    assert.equal(withdrawn.reason, 'already-consumed');
    assert.equal(store.policyState().pendingPressure, 0, 'the spent credit is not refunded again');
  }
  console.log(
    `[22] faded=${result.faded} pending 9→${result.pendingPressure} epoch=${store.pressureEpoch} ` +
      `contributions before=[${creditsBefore.map((row) => row.contribution).join(',')}] ` +
      `after=[${creditsAfter.map((row) => row.contribution).join(',')}] withdraw=already-consumed pending=0`,
  );
});

test('23) P2-2 partial consumption: the row the charge only reaches keeps its remainder', async (t) => {
  const root = await tempRoot();
  const store = new MemoryStore(root, { capacity: 10, pressureThreshold: 9 });
  t.after(() => cleanup(root, store));
  const filler = seedMessageRecords(store, 'p23-fill', 9);
  assert.equal(store.maintain().pendingPressure, 0, 'the first cycle is fully spent');
  assert.ok(filler.every((id) => creditOf(store, id).contribution === 0));

  // Three records bank three credits; the oldest owns two of them and the newest owns none, so
  // the next charge of two stops exactly at the oldest row's boundary.
  const [oldestId, nextId, lastId] = seedMessageRecords(store, 'p23-credit', 3, { day: 6 });
  assert.equal(store.policyState().pendingPressure, 3);
  store.db.prepare('UPDATE memory_event SET pressure_contribution = 2 WHERE id = ?').run(oldestId);
  store.db.prepare('UPDATE memory_event SET pressure_contribution = 0 WHERE id = ?').run(lastId);
  store.setPressureThreshold(2);

  const result = store.maintain();
  assert.ok(result.faded > 0);
  assert.equal(result.pendingPressure, 1, 'pending 3 - 2 = 1');
  assert.equal(creditOf(store, oldestId).contribution, 0, 'the oldest row is fully consumed');
  assert.equal(creditOf(store, nextId).contribution, 1, 'the next row is untouched because the charge stopped inside the oldest');
  assert.equal(creditOf(store, lastId).contribution, 0, 'the row that owned no credit stays at zero');
  const afterFade = [oldestId, nextId, lastId].map((id) => creditOf(store, id).contribution);

  const spent = store.withdrawPressureForMessage('p23-credit-0');
  assert.equal(spent.withdrawn, false, 'the fully consumed old row cannot be refunded');
  assert.equal(spent.reason, 'already-consumed');
  const refunded = store.withdrawPressureForMessage('p23-credit-1');
  assert.equal(refunded.withdrawn, true, 'the surviving remainder is still refundable');
  assert.equal(refunded.contribution, 1);
  assert.equal(store.policyState().pendingPressure, 0, 'only the remaining 1 is refunded');
  console.log(
    `[23] pending 3→${result.pendingPressure} contributions after fade=[${afterFade.join(',')}] ` +
      `withdraw(old)=${spent.reason} withdraw(next)=${refunded.withdrawn}/${refunded.contribution} pending=0`,
  );
});

test('24) P2-2 restart: contributions stay consumed and the withdraw decision is unchanged', async (t) => {
  const root = await tempRoot();
  let store = new MemoryStore(root, { capacity: 10, pressureThreshold: 9 });
  t.after(() => cleanup(root, store));
  seedMessageRecords(store, 'p24-fill', 9);
  assert.equal(store.maintain().pendingPressure, 0);
  const [oldestId, nextId, lastId] = seedMessageRecords(store, 'p24-credit', 3, { day: 6 });
  store.db.prepare('UPDATE memory_event SET pressure_contribution = 2 WHERE id = ?').run(oldestId);
  store.db.prepare('UPDATE memory_event SET pressure_contribution = 0 WHERE id = ?').run(lastId);
  store.setPressureThreshold(2);
  assert.equal(store.maintain().pendingPressure, 1);
  const before = { pending: store.policyState().pendingPressure, credits: [oldestId, nextId, lastId].map((id) => creditOf(store, id)) };
  assert.equal(before.pending, 1);
  assert.deepEqual(before.credits.map((row) => row.contribution), [0, 1, 0]);
  const preRestart = store.withdrawPressureForMessage('p24-credit-0');
  assert.equal(preRestart.withdrawn, false);
  assert.equal(preRestart.reason, 'already-consumed');

  store.close();
  store = new MemoryStore(root, { capacity: 10 });
  const after = { pending: store.policyState().pendingPressure, credits: [oldestId, nextId, lastId].map((id) => creditOf(store, id)) };
  assert.equal(after.pending, 1, 'pending survives the restart');
  assert.deepEqual(after.credits.map((row) => row.contribution), [0, 1, 0], 'contributions survive the restart, no backfill');
  assert.deepEqual(after.credits.map((row) => row.epoch), before.credits.map((row) => row.epoch), 'the cycle is stable');

  const postRestart = store.withdrawPressureForMessage('p24-credit-0');
  assert.equal(postRestart.withdrawn, false);
  assert.equal(postRestart.reason, 'already-consumed', 'same decision after the restart');
  const refunded = store.withdrawPressureForMessage('p24-credit-1');
  assert.equal(refunded.withdrawn, true);
  assert.equal(refunded.contribution, 1);
  assert.equal(store.policyState().pendingPressure, 0);
  console.log(
    `[24] pending before/after restart=${before.pending}/${after.pending} ` +
      `contributions=[${after.credits.map((row) => row.contribution).join(',')}] ` +
      `pre=${preRestart.reason} post=${postRestart.reason} refund=${refunded.contribution} pending=0`,
  );
});

test('25) P2-2 rollback: a failure while settling restores pending and every contribution', async (t) => {
  const root = await tempRoot();
  const store = new MemoryStore(root, { capacity: 10, pressureThreshold: 9 });
  t.after(() => cleanup(root, store));
  const ids = seedMessageRecords(store, 'p25', 9);
  const clarityBefore = store.clarityCounts();
  const original = store.setPendingPressure;
  store.setPendingPressure = () => {
    throw new Error('injected settle failure');
  };
  try {
    assert.throws(() => store.maintain(), /injected settle failure/);
  } finally {
    store.setPendingPressure = original;
  }

  assert.equal(store.policyState().pendingPressure, 9, 'pending is back to 9');
  const restored = ids.map((id) => creditOf(store, id).contribution);
  assert.deepEqual(restored, Array(9).fill(1), 'every contribution is back to 1');
  assert.deepEqual(store.clarityCounts(), clarityBefore, 'the fade pass rolled back with the charge');

  const retried = store.maintain();
  assert.equal(retried.pendingPressure, 0, 'the retry charges exactly once');
  assert.ok(ids.every((id) => creditOf(store, id).contribution === 0));
  console.log(`[25] after rollback pending=9 contributions=[${restored.join(',')}] retried pending=${retried.pendingPressure} contributions=0`);
});

test('26) P2-2 a memory added after the fade keeps its new credit and refunds normally', async (t) => {
  const root = await tempRoot();
  const store = new MemoryStore(root, { capacity: 10, pressureThreshold: 9 });
  t.after(() => cleanup(root, store));
  const oldIds = seedMessageRecords(store, 'p26-old', 9);
  assert.equal(store.maintain().pendingPressure, 0);
  assert.ok(oldIds.every((id) => creditOf(store, id).contribution === 0));

  const [newId] = seedMessageRecords(store, 'p26-new', 1, { day: 7 });
  assert.equal(store.policyState().pendingPressure, 1, 'the new addition banks one fresh credit');
  assert.equal(creditOf(store, newId).contribution, 1);
  assert.ok(oldIds.every((id) => creditOf(store, id).contribution === 0), 'the earlier fade did not come back');

  const withdrawn = store.withdrawPressureForMessage('p26-new-0');
  assert.equal(withdrawn.withdrawn, true);
  assert.equal(withdrawn.contribution, 1);
  assert.equal(store.policyState().pendingPressure, 0);
  assert.equal(creditOf(store, newId).contribution, 0, 'the refund consumes the fresh credit');
  console.log(
    `[26] pending after fade=0 new pending=1 freshContribution=${withdrawn.contribution} ` +
      `oldContributions=[${oldIds.map((id) => creditOf(store, id).contribution).join(',')}] ` +
      `withdrawn=${withdrawn.withdrawn} pending=0`,
  );
});

// ---------------------------------------------------------------------------------------------
// Cross-version reconciliation: the old build released `pendingPressure` without retiring the
// per-row contributions, so a later merge refunded a credit the current balance never held.
// `open()` now trims the excess once, without changing the counter or inventing a contribution.
// ---------------------------------------------------------------------------------------------

const pressureEvents = (events, type = 'memory.pressure.reconciled') => events.filter((entry) => entry.type === type);

/** Rewrite only the durable counter, exactly like the old build leaving its rows behind. */
const leaveLegacyPending = (store) =>
  store.db.prepare(`UPDATE memory_meta SET value = '0' WHERE key = 'policy.pendingPressure'`).run();

test('27) legacy orphan credit: load trims it to the pending balance without touching the counter', async (t) => {
  const root = await tempRoot();
  let store = new MemoryStore(root, { capacity: 1000 });
  const auto = store.addMessage({
    role: 'user',
    sessionId: 's-27',
    turnId: 27,
    messageId: 'corr-27',
    text: '不是星期五是星期四，你记错了',
  }).record;
  assert.equal(store.policyState().pendingPressure, 1);
  assert.equal(creditOf(store, auto.id).contribution, 1);
  const epoch = store.pressureEpoch;
  leaveLegacyPending(store);
  store.close();

  const events = [];
  const onEvent = (type, payload) => events.push({ type, payload });
  store = new MemoryStore(root, { capacity: 1000, onEvent });
  t.after(() => cleanup(root, store));
  store.open();

  const credit = creditOf(store, auto.id);
  assert.equal(credit.contribution, 0, 'the orphan contribution is trimmed to zero');
  assert.equal(credit.epoch, epoch, 'the row keeps its cycle');
  assert.equal(store.policyState().pendingPressure, 0, 'pendingPressure is never raised by the correction');
  const reconciled = pressureEvents(events);
  assert.equal(reconciled.length, 1, 'one reconciliation event');
  assert.deepEqual(reconciled[0].payload, { creditsBefore: 1, creditsAfter: 0, pendingPressure: 0 });
  console.log(
    `[27] epoch=${epoch} contribution 1→${credit.contribution} pending 0→${store.policyState().pendingPressure} ` +
      `credits ${reconciled[0].payload.creditsBefore}→${reconciled[0].payload.creditsAfter} events=${reconciled.length}`,
  );
});

test('28) reconciled old message: the later merge reports already-consumed and keeps the new credit', async (t) => {
  const root = await tempRoot();
  let store = new MemoryStore(root, { capacity: 1000 });
  const target = store.add('chat', '原定星期五下午三点开会', 'fact', { importance: 60 });
  const auto = store.addMessage({
    role: 'user',
    sessionId: 's-28',
    turnId: 28,
    messageId: 'corr-28',
    text: '不是星期五是星期四，你记错了',
  }).record;
  assert.equal(store.policyState().pendingPressure, 2);
  leaveLegacyPending(store);
  store.close();

  const events = [];
  const onEvent = (type, payload) => events.push({ type, payload });
  store = new MemoryStore(root, { capacity: 1000, onEvent });
  t.after(() => cleanup(root, store));
  store.open();
  assert.equal(pressureEvents(events)[0].payload.creditsBefore, 2, 'both legacy rows are reconciled');
  assert.equal(store.policyState().pendingPressure, 0);
  assert.equal(creditOf(store, auto.id).contribution, 0);

  // One fresh addition after the correction: a new cycle of exactly one refundable credit.
  const [fresh] = seedMessageRecords(store, 'p28-new', 1, { day: 8 });
  assert.equal(store.policyState().pendingPressure, 1, 'the new record banks one credit');
  assert.equal(creditOf(store, fresh).contribution, 1);

  const withdrawn = store.withdrawPressureForMessage('corr-28');
  assert.equal(withdrawn.withdrawn, false, 'the old row has nothing left to refund');
  assert.equal(withdrawn.reason, 'already-consumed');
  assert.equal(store.policyState().pendingPressure, 1, 'the merge cannot deduct the new credit');

  const corrected = store.correct({
    targetId: target.id,
    expectedVersion: 1,
    expectedText: '星期五',
    replacement: '星期四',
    sourceMessageId: 'corr-28',
  });
  assert.equal(corrected.ok, true, corrected.error);
  assert.equal(corrected.supersededId, auto.id, 'the old message still merges');
  assert.equal(store.policyState().pendingPressure, 1, 'pending stays 1 after the real merge');
  assert.equal(creditOf(store, fresh).contribution, 1, 'the fresh credit is untouched');
  console.log(
    `[28] credits 2→0 pending=0 newCredit=1 withdraw=${withdrawn.withdrawn}/${withdrawn.reason} ` +
      `merged=${corrected.supersededId === auto.id} afterMerge pending=${store.policyState().pendingPressure} fresh=${creditOf(store, fresh).contribution}`,
  );
});

test('29) consistent store: credits equal pending, so load changes nothing and emits nothing', async (t) => {
  const root = await tempRoot();
  let store = new MemoryStore(root, { capacity: 1000 });
  const auto = store.addMessage({
    role: 'user',
    sessionId: 's-29',
    turnId: 29,
    messageId: 'corr-29',
    text: '不是星期五是星期四，你记错了',
  }).record;
  assert.equal(store.policyState().pendingPressure, 1);
  store.close();

  const events = [];
  const onEvent = (type, payload) => events.push({ type, payload });
  store = new MemoryStore(root, { capacity: 1000, onEvent });
  t.after(() => cleanup(root, store));
  store.open();
  assert.equal(creditOf(store, auto.id).contribution, 1, 'the balanced credit is left alone');
  assert.equal(store.policyState().pendingPressure, 1);
  assert.equal(pressureEvents(events).length, 0, 'nothing was corrected, so no event');
  console.log(
    `[29] credits=1 pending=1 contribution=${creditOf(store, auto.id).contribution} reconciledEvents=0`,
  );
});

test('30) idempotent: a second open after reconciliation writes nothing and emits nothing', async (t) => {
  const root = await tempRoot();
  let store = new MemoryStore(root, { capacity: 1000 });
  const auto = store.addMessage({
    role: 'user',
    sessionId: 's-30',
    turnId: 30,
    messageId: 'corr-30',
    text: '不是星期五是星期四，你记错了',
  }).record;
  leaveLegacyPending(store);
  store.close();

  const firstEvents = [];
  store = new MemoryStore(root, { capacity: 1000, onEvent: (type, payload) => firstEvents.push({ type, payload }) });
  store.open();
  assert.equal(pressureEvents(firstEvents).length, 1, 'the first open reconciles');
  assert.equal(creditOf(store, auto.id).contribution, 0);
  const pendingAfterFirst = store.policyState().pendingPressure;
  store.close();

  const secondEvents = [];
  store = new MemoryStore(root, { capacity: 1000, onEvent: (type, payload) => secondEvents.push({ type, payload }) });
  t.after(() => cleanup(root, store));
  store.open();
  assert.equal(creditOf(store, auto.id).contribution, 0, 'the already-trimmed row is unchanged');
  assert.equal(store.policyState().pendingPressure, pendingAfterFirst, 'the counter is unchanged');
  assert.equal(pressureEvents(secondEvents).length, 0, 'the second open emits no reconciliation event');
  console.log(
    `[30] firstEvents=${pressureEvents(firstEvents).length} secondEvents=${pressureEvents(secondEvents).length} ` +
      `contribution=${creditOf(store, auto.id).contribution} pending=${store.policyState().pendingPressure}`,
  );
});

test('31) transactional: a mid-write failure rolls every row back and startup continues', async (t) => {
  const root = await tempRoot();
  let store = new MemoryStore(root, { capacity: 1000 });
  const ids = seedMessageRecords(store, 'p31', 3);
  assert.equal(store.policyState().pendingPressure, 3);
  leaveLegacyPending(store);
  store.close();

  const events = [];
  const onEvent = (type, payload) => events.push({ type, payload });
  store = new MemoryStore(root, { capacity: 1000, onEvent });
  t.after(() => cleanup(root, store));
  const apply = store.applyPressureCredit;
  let calls = 0;
  store.applyPressureCredit = function injected(...args) {
    calls += 1;
    if (calls === 2) throw new Error('injected reconcile failure');
    return apply.apply(this, args);
  };

  assert.doesNotThrow(() => store.open(), 'a failed correction must not block startup');
  assert.equal(calls, 2, 'the first row was trimmed before the failure');
  const rolledBack = ids.map((id) => creditOf(store, id).contribution);
  assert.deepEqual(rolledBack, [1, 1, 1], 'the first write rolled back too');
  assert.equal(store.policyState().pendingPressure, 0, 'the counter is untouched');
  assert.equal(pressureEvents(events).length, 0, 'a rollback emits no reconciliation event');
  assert.equal(pressureEvents(events, 'memory.pressure.reconcile-failed').length, 1, 'the failure is logged');

  // Startup continued: the store is usable and a later attempt reconciles normally.
  store.applyPressureCredit = apply;
  const retried = store.reconcilePressureCredits();
  assert.equal(retried.reconciled, true);
  assert.deepEqual(ids.map((id) => creditOf(store, id).contribution), [0, 0, 0]);
  assert.equal(store.policyState().pendingPressure, 0);
  console.log(
    `[31] injectedBeforeCommit=${calls} rollback=[${rolledBack.join(',')}] pending=0 ` +
      `failedLogged=${pressureEvents(events, 'memory.pressure.reconcile-failed').length} ` +
      `retryCredits=${retried.creditsBefore}→${retried.creditsAfter} reconciledEvents=${pressureEvents(events).length}`,
  );
});
