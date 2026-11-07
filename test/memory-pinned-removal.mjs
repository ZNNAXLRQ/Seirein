/**
 * Task A: the retired `pinned` column.
 *
 * `pinned` was a "never fade / never archive" flag that no code path ever set, so the column is
 * deleted from the schema and from the fade/compact queries. These tests pin both halves:
 *   1. a database this build writes has no such column, and a row carrying a stale `pinned`
 *      property inserts cleanly (the property is simply ignored);
 *   2. a database written by an older build loses the column on open, and its rows are NOT
 *      migrated: `importance` and `clarity` stay exactly as written (single-developer store,
 *      verified empty, so the defensive importance≥80 / trace→clear translation was deleted) and
 *      no `memory.pinned.migrated` event is emitted — ever;
 *   3. when the SQLite build cannot drop a column the failure is reported once as
 *      `memory.pinned.retire-failed` and the legacy column stays behind, unread.
 *
 * Run: node --test test/memory-pinned-removal.mjs
 */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { MemoryStore } from '../src/host/memory/store.js';

async function tempRoot() {
  return mkdtemp(join(tmpdir(), 'dsh-pin-removal-'));
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

function eventLog() {
  const events = [];
  return {
    events,
    onEvent(type, payload) {
      events.push({ type, payload });
    },
  };
}

const columnsOf = (memory, table = 'memory_event') =>
  memory.db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);

const pinnedEvents = (log) => log.events.filter((entry) => String(entry.type).startsWith('memory.pinned'));

/** A real legacy database: the base columns plus the retired `pinned` flag. */
async function legacyRoot(rows) {
  const root = await tempRoot();
  const dir = join(root, 'memory');
  mkdirSync(dir, { recursive: true });
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
  const insert = db.prepare(`INSERT INTO memory_event
    (id, ts, domain, kind, text, importance, clarity, last_seen, recall_count, pinned, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const row of rows) {
    insert.run(row.id, row.ts, 'chat', 'fact', row.text, row.importance, row.clarity,
      row.ts, 0, row.pinned, 'manual');
  }
  db.close();
  return root;
}

test('1) a database this build writes has no pinned column, and a stale pinned property is ignored', async () => {
  const root = await tempRoot();
  let memory = new MemoryStore(root, { capacity: 4 });
  memory.open();
  try {
    assert.equal(columnsOf(memory).includes('pinned'), false, 'the column is gone from the schema');
    memory.add('chat', '第一版没有保护列的记忆', 'fact');
    // The old INSERT carried `row.pinned`; a caller still passing it must not fail or write it.
    memory.insert({ id: 'stale-pinned', domain: 'chat', text: '旧调用方传入 pinned 字段', pinned: 1 });
    const stored = memory.db.prepare('SELECT * FROM memory_event WHERE id = ?').get('stale-pinned');
    assert.ok(stored !== undefined, 'the row landed');
    assert.equal(Object.hasOwn(stored, 'pinned'), false, 'no pinned column materialised');

    // No `pinned = 0` branch may remain: a trace row is archiveable and a vivid row is demotable.
    for (const label of ['甲', '乙', '丙']) memory.add('chat', `普通记录 ${label}`, 'fact', { importance: 10 });
    memory.db.exec("UPDATE memory_event SET clarity = 'trace'");
    const compacted = memory.compact({ targetRatio: 0.5 });
    assert.equal(compacted.moved, 3, 'nothing protects a trace row from compaction');
    const faded = memory.fadePass();
    assert.equal(faded.considered, 0, 'every remaining row is trace, so a pass finds no work');

    memory.close();
    memory = new MemoryStore(root, { capacity: 4 });
    memory.open();
    assert.equal(columnsOf(memory).includes('pinned'), false, 'reopening does not recreate it');
  } finally {
    await cleanup(root, memory);
  }
});

test('2) a legacy database loses the column and no row is migrated', async () => {
  const root = await legacyRoot([
    { id: 'was-pinned-trace', ts: '2026-10-01T00:00:00.000Z', text: '曾带旧标记的模糊记录', importance: 30, clarity: 'trace', pinned: 1 },
    { id: 'was-pinned-important', ts: '2026-10-02T00:00:00.000Z', text: '曾带旧标记的重要记录', importance: 95, clarity: 'vivid', pinned: 1 },
    { id: 'loose', ts: '2026-10-03T00:00:00.000Z', text: '没有旧标记的记录', importance: 40, clarity: 'clear', pinned: 0 },
  ]);
  const log = eventLog();
  let memory = new MemoryStore(root, { capacity: 50, onEvent: log.onEvent });
  memory.open();
  try {
    assert.equal(columnsOf(memory).includes('pinned'), false, 'the legacy column was dropped');
    // The deleted migration used to raise importance to >=80 and lift a trace row to clear.
    const rows = memory.db
      .prepare('SELECT id, importance, clarity FROM memory_event ORDER BY id')
      .all()
      .map((row) => [row.id, row.importance, row.clarity]);
    assert.deepEqual(rows, [
      ['loose', 40, 'clear'],
      ['was-pinned-important', 95, 'vivid'],
      ['was-pinned-trace', 30, 'trace'],
    ], 'importance and clarity are exactly what the old build wrote');
    assert.deepEqual(pinnedEvents(log), [], 'neither memory.pinned.migrated nor retire-failed is emitted');

    // The store stays usable on the cleaned database.
    memory.add('chat', '清理后新增的探针甲乙丙', 'fact');
    const found = memory.search({ query: '清理后新增的探针甲乙丙' });
    assert.ok(
      found.hits.some((hit) => hit.text === '清理后新增的探针甲乙丙'),
      'the store still searches after the column was dropped',
    );
    memory.close();

    // Reopening is a no-op: the column is gone and no event is recorded a second time.
    memory = new MemoryStore(root, { capacity: 50, onEvent: log.onEvent });
    memory.open();
    assert.equal(columnsOf(memory).includes('pinned'), false);
    assert.deepEqual(pinnedEvents(log), [], 'reopen emits nothing');
  } finally {
    await cleanup(root, memory);
  }
});

test('3) a column that cannot be dropped is reported once and left unread', () => {
  const log = eventLog();
  const memory = new MemoryStore(tmpdir(), { onEvent: log.onEvent });
  const refusal = new Error('this SQLite build cannot drop a column');
  const fakeDb = {
    prepare: () => ({ all: () => [{ name: 'pinned' }] }),
    exec: () => {
      throw refusal;
    },
  };
  assert.deepEqual(memory.retirePinnedColumn(fakeDb), { dropped: false });
  assert.equal(log.events.length, 1, 'exactly one failure event');
  assert.equal(log.events[0].type, 'memory.pinned.retire-failed');
  assert.match(log.events[0].payload.error, /cannot drop a column/u);
});
