/**
 * R07 regression: compact only ever archives records that already reached `trace`, FTS5
 * delete/update triggers keep the external-content index honest, and a failed compact rolls
 * back without a half-move.
 *
 * Run: node --test test/memory-fix-r07.mjs
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { MemoryStore } from '../src/host/memory/store.js';

const ftsRows = (memory, query) =>
  memory.db.prepare('SELECT rowid FROM memory_fts WHERE memory_fts MATCH ?').all(`"${query}"`);

const integrity = (memory) => memory.ftsConsistent('memory_fts');

const setClarity = (memory, id, clarity) =>
  memory.db.prepare('UPDATE memory_event SET clarity = ? WHERE id = ?').run(clarity, id);

/** A temp root that is removed after the test; the DB must be closed first on Windows. */
async function tempRoot() {
  return mkdtemp(join(tmpdir(), 'dsh-r07-'));
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

/** Fill the table with `count` records of rising importance; returns their ids. */
function fill(memory, prefix, count) {
  const ids = [];
  for (let index = 0; index < count; index += 1) {
    ids.push(memory.add('chat', `${prefix} ${index}`, 'fact', { importance: (index + 1) * 10 }).id);
  }
  return ids;
}

test('a) with enough trace records compact moves exactly before - target', async () => {
  const root = await tempRoot();
  const memory = new MemoryStore(root, { capacity: 10 });
  try {
    const ids = fill(memory, '精确搬运记录', 10);
    memory.db.exec("UPDATE memory_event SET clarity = 'trace'");

    const result = memory.compact({ targetRatio: 0.85 });
    assert.equal(result.before, 10);
    assert.equal(result.target, 8);
    assert.equal(result.after, 8);
    assert.equal(result.moved, 2, 'moved exactly count - target');
    assert.equal(result.moved, result.before - result.after, 'moved equals before - after');
    assert.equal(result.limitedBy, null, 'target was reached, so nothing limited the pass');

    const archived = memory.listArchive({ limit: 10 });
    assert.equal(archived.length, 2);
    const archivedIds = new Set(archived.map((row) => row.id));
    assert.deepEqual([...archivedIds].sort(), [ids[0], ids[1]].sort(), 'weakest trace rows go first');
    assert.equal(memory.usage().records, 8);
  } finally {
    await cleanup(root, memory);
  }
});

test('a2) maintain() at 100% archives only trace rows the fade pass produced', async () => {
  const root = await tempRoot();
  const memory = new MemoryStore(root, { capacity: 10 });
  try {
    const ids = fill(memory, '档位测试记录', 10);
    // Simulate the fade pass having already walked the five weakest rows down to trace.
    for (const id of ids.slice(0, 5)) setClarity(memory, id, 'trace');

    const result = memory.maintain({ lastBand: 2 });
    assert.equal(result.band, 3);
    assert.equal(result.before.records, 10);
    assert.equal(result.moved, 2, 'maintenance compaction also stops at the target');
    assert.equal(result.after.records, 8);
    assert.equal(result.before.records - result.after.records, result.moved);
  } finally {
    await cleanup(root, memory);
  }
});

test('b) only vivid/clear/fuzzy: compact moves nothing and leaves clarity untouched', async () => {
  const root = await tempRoot();
  const memory = new MemoryStore(root, { capacity: 10 });
  try {
    const ids = fill(memory, '尚未遗忘记录', 10);
    for (const id of ids.slice(0, 4)) setClarity(memory, id, 'fuzzy');
    for (const id of ids.slice(4, 7)) setClarity(memory, id, 'clear');
    const clarityBefore = memory.clarityCounts();
    assert.deepEqual(clarityBefore, { vivid: 3, clear: 3, fuzzy: 4, trace: 0 });

    const result = memory.compact({ targetRatio: 0.85 });
    assert.equal(result.target, 8, 'over capacity, so the target is below the current count');
    assert.equal(result.moved, 0, 'no trace record may be archived');
    assert.equal(result.before, 10);
    assert.equal(result.after, 10, 'the table keeps its rows');
    assert.equal(result.limitedBy, 'trace', 'the shortfall is reported, not forced');
    assert.deepEqual(memory.clarityCounts(), clarityBefore, 'no clarity was demoted either');
    assert.equal(memory.usage().records, 10);
    assert.equal(memory.usage().archived, 0);
  } finally {
    await cleanup(root, memory);
  }
});

test('c) 2 trace + 8 clear: only the trace rows move, limitedBy trace when the target needs more', async () => {
  const root = await tempRoot();
  const memory = new MemoryStore(root, { capacity: 10 });
  try {
    const ids = fill(memory, '混合清晰度记录', 10);
    for (const id of ids) setClarity(memory, id, 'clear');
    setClarity(memory, ids[0], 'trace');
    setClarity(memory, ids[1], 'trace');

    // targetRatio 0.5 → target 5, so five rows must go but only two have reached trace.
    const result = memory.compact({ targetRatio: 0.5 });
    assert.equal(result.target, 5);
    assert.equal(result.moved, 2, 'only the two trace rows are eligible');
    assert.equal(result.after, 8, 'the eight clear rows stay');
    assert.equal(result.limitedBy, 'trace');
    assert.ok(result.moved < result.before - result.target, 'the pass stops short of the target');

    const archived = memory.listArchive({ limit: 10 });
    assert.deepEqual(archived.map((row) => row.id).sort(), [ids[0], ids[1]].sort());
    assert.ok(archived.every((row) => row.clarity === 'trace'));
    assert.deepEqual(memory.clarityCounts(), { vivid: 0, clear: 8, fuzzy: 0, trace: 0 });
  } finally {
    await cleanup(root, memory);
  }
});

test('e) deleting a memory removes it from memory_fts', async () => {
  const root = await tempRoot();
  const memory = new MemoryStore(root, { capacity: 50 });
  try {
    const doomed = memory.add('chat', '删除探针独特档案词甲', 'fact', { importance: 80 }).id;
    const keeper = memory.add('chat', '保留探针独特档案词乙', 'fact', { importance: 80 }).id;
    assert.equal(ftsRows(memory, '删除探针独特档案词甲').length, 1);

    memory.db.prepare('DELETE FROM memory_event WHERE id = ?').run(doomed);

    assert.equal(ftsRows(memory, '删除探针独特档案词甲').length, 0, 'stale FTS row is gone');
    assert.equal(ftsRows(memory, '保留探针独特档案词乙').length, 1, 'unrelated row survives');
    // Normal recall may still surface the keeper through overlapping 3-char terms, but the
    // deleted record itself must never come back.
    assert.ok(
      memory.search({ query: '删除探针独特档案词甲' }).hits.every((hit) => hit.id !== doomed),
      'deleted record is not recalled',
    );
    assert.equal(memory.search({ query: '保留探针独特档案词乙' }).hits[0]?.id, keeper);
    assert.equal(integrity(memory), true, 'index stays consistent after DELETE');
  } finally {
    await cleanup(root, memory);
  }
});

test('f) updating memory text reindexes new text and drops old text', async () => {
  const root = await tempRoot();
  const memory = new MemoryStore(root, { capacity: 50 });
  try {
    const id = memory.add('chat', '更新前旧版档案词', 'fact', { importance: 60 }).id;
    memory.db.prepare('UPDATE memory_event SET text = ? WHERE id = ?').run('更新后新版档案词', id);

    assert.equal(ftsRows(memory, '更新后新版档案词').length, 1, 'new text is searchable');
    assert.equal(ftsRows(memory, '更新前旧版档案词').length, 0, 'old text is not searchable');
    assert.equal(memory.search({ query: '更新后新版档案词' }).hits[0]?.id, id);
    assert.equal(integrity(memory), true, 'index stays consistent after UPDATE');
  } finally {
    await cleanup(root, memory);
  }
});

test('g) a failing compact rolls back, leaving count and rows untouched', async () => {
  const root = await tempRoot();
  const memory = new MemoryStore(root, { capacity: 10 });
  try {
    const ids = fill(memory, '回滚测试记录', 10);
    memory.db.exec("UPDATE memory_event SET clarity = 'trace'");

    // Fail on the *second* archived row so the first archive/delete pair has already happened
    // inside the transaction when the abort is raised.
    memory.db.exec(`CREATE TRIGGER fail_archive_second BEFORE INSERT ON memory_archive
      WHEN new.id = '${ids[1]}' BEGIN
        SELECT RAISE(ABORT, 'injected compact failure');
      END`);

    assert.throws(() => memory.compact({ targetRatio: 0.85 }), /injected compact failure/);
    assert.equal(memory.usage().records, 10, 'every row is back after ROLLBACK');
    assert.equal(memory.usage().archived, 0, 'no half-archived rows');
    assert.equal(memory.db.prepare('SELECT COUNT(*) AS c FROM memory_event WHERE id = ?').get(ids[0]).c, 1);

    // Recovery: once the injected fault is gone the same pass completes exactly once.
    memory.db.exec('DROP TRIGGER fail_archive_second');
    const retried = memory.compact({ targetRatio: 0.85 });
    assert.equal(retried.moved, 2);
    assert.equal(retried.after, 8);
    assert.equal(memory.usage().archived, 2);
  } finally {
    await cleanup(root, memory);
  }
});

test('h) deleting an archived row removes it from memory_archive_fts', async () => {
  const root = await tempRoot();
  const memory = new MemoryStore(root, { capacity: 10 });
  try {
    const probe = memory.add('chat', '归档删除探针独特词丁', 'fact', { importance: 10 }).id;
    for (let index = 0; index < 9; index += 1) {
      memory.add('chat', `归档陪衬记录 ${index}`, 'fact', { importance: 50 + index });
    }
    // Only a trace row is eligible, so this probe is the one the pass forgets.
    setClarity(memory, probe, 'trace');
    const moved = memory.compact({ targetRatio: 0.9 });
    assert.equal(moved.moved, 1, 'only the overflow is archived');

    const archived = memory.listArchive({ limit: 10 });
    assert.equal(archived.length, 1);
    const target = archived[0];
    assert.equal(target.text, '归档删除探针独特词丁');
    assert.equal(memory.searchArchive('归档删除探针').length, 1, 'archive search sees it');

    memory.deleteArchived([target.id]);
    assert.equal(memory.searchArchive('归档删除探针').length, 0, 'no stale archive FTS row');
    assert.equal(
      memory.db
        .prepare('SELECT rowid FROM memory_archive_fts WHERE memory_archive_fts MATCH ?')
        .all('"归档删除探针"').length,
      0,
    );
    assert.equal(memory.ftsConsistent('memory_archive_fts'), true);
  } finally {
    await cleanup(root, memory);
  }
});

test('i) startup repair fixes a stale index and PRAGMA integrity_check is ok', async () => {
  const root = await tempRoot();
  const legacy = new MemoryStore(root, { capacity: 50 });
  let id;
  try {
    id = legacy.add('chat', '遗留旧版独特档案词丙', 'fact', { importance: 70 }).id;
    // Simulate a database written before the delete trigger existed.
    legacy.db.exec('DROP TRIGGER memory_ad');
    legacy.db.prepare('DELETE FROM memory_event WHERE id = ?').run(id);
    assert.equal(integrity(legacy), false, 'probe sees the stale index');
  } finally {
    legacy.close();
  }

  const repaired = new MemoryStore(root, { capacity: 50 });
  try {
    repaired.open();
    assert.ok(repaired.ftsRepair, 'startup verification ran');
    assert.ok(
      repaired.ftsRepair.rebuilt.some((entry) => entry.table === 'memory_fts'),
      'memory_fts was rebuilt once',
    );
    assert.equal(integrity(repaired), true, 'FTS5 index matches its content table');
    assert.equal(ftsRows(repaired, '遗留旧版独特档案词丙').length, 0, 'stale index row is gone');

    const rows = repaired.db.prepare('PRAGMA integrity_check').all();
    assert.deepEqual(
      rows.map((row) => row.integrity_check),
      ['ok'],
    );

    // A healthy reopen must not rebuild again.
    repaired.close();
    const again = new MemoryStore(root, { capacity: 50 });
    try {
      again.open();
      assert.deepEqual(again.ftsRepair.rebuilt, [], 'clean database skips the rebuild');
    } finally {
      again.close();
    }
  } finally {
    repaired.close();
    await cleanup(root);
  }
});
