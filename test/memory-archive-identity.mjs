/**
 * Gap 2: archiving keeps message identity, and a replayed message id stays a no-op even after
 * its row moved to the archive.
 *
 * The archive only ever received the old fact columns, so after compaction a replay looked new:
 * `deduped:false`, pressure grew, and the archived message was written back into the active
 * table. These tests pin both halves: the metadata columns (with additive migration) and the
 * idempotency check that spans active + archive.
 *
 * Run: node --test test/memory-archive-identity.mjs
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { MemoryStore } from '../src/host/memory/store.js';

async function tempRoot() {
  return mkdtemp(join(tmpdir(), 'dsh-mem-archive-'));
}

async function cleanup(root, memory) {
  try {
    memory.close();
  } catch {
    /* already closed */
  }
  await rm(root, { recursive: true, force: true }).catch(() => {});
}

test('archived message keeps id/session/turn/role; replaying it is deduped and costs no pressure', async (t) => {
  const root = await tempRoot();
  const memory = new MemoryStore(root, { capacity: 2 });
  t.after(() => cleanup(root, memory));
  memory.open();

  const archived = memory.addMessage({
    role: 'user',
    sessionId: 'session-arch',
    turnId: 42,
    messageId: 'arch-1',
    ts: '2026-11-01T09:00:00.000Z',
    text: '这条消息先入库，然后会被强制归档',
  });
  assert.equal(archived.deduped, false);
  // A stronger record keeps the table over target without becoming the archive candidate.
  memory.addMessage({
    role: 'assistant',
    sessionId: 'session-arch',
    turnId: 42,
    messageId: 'arch-2',
    ts: '2026-11-01T09:00:01.000Z',
    text: '这条更重要的回答留在活跃库',
    importance: 100,
  });
  memory.db.prepare("UPDATE memory_event SET clarity = 'trace' WHERE message_id = 'arch-1'").run();

  const compacted = memory.compact({ targetRatio: 0.85 });
  assert.equal(compacted.moved, 1, 'the trace row is archived');
  assert.equal(memory.usage().records, 1);
  assert.equal(memory.usage().archived, 1);

  const [row] = memory.listArchive({ limit: 5 });
  assert.equal(row.id, archived.record.id);
  assert.equal(row.messageId, 'arch-1', 'message_id survives archiving');
  assert.equal(row.sessionId, 'session-arch', 'session_id survives archiving');
  assert.equal(row.turnId, 42, 'turn_id survives archiving');
  assert.equal(row.role, 'user', 'role survives archiving');
  assert.equal(row.truncated, 0);

  const pressureBefore = memory.policyState().pendingPressure;
  const replay = memory.addMessage({
    role: 'user',
    sessionId: 'session-arch',
    turnId: 42,
    messageId: 'arch-1',
    ts: '2026-11-01T09:00:00.000Z',
    text: '这条消息先入库，然后会被强制归档',
  });
  assert.equal(replay.deduped, true, 'the archived id is recognised as a replay');
  assert.equal(replay.record, null);
  assert.equal(replay.archived, true, 'the replay is attributed to the archive');
  assert.equal(memory.policyState().pendingPressure, pressureBefore, 'a replay charges no pressure');
  assert.equal(memory.usage().records, 1, 'nothing was written back into the active table');
  assert.equal(memory.usage().archived, 1, 'the archive still holds exactly one row');
  assert.equal(
    memory.db.prepare("SELECT COUNT(*) AS c FROM memory_event WHERE message_id = 'arch-1'").get().c,
    0,
    'the archived message did not return to the active table',
  );

  console.log(
    `[archive] moved=${compacted.moved} archived.messageId=${row.messageId} replay.deduped=${replay.deduped} `
      + `pressure=${pressureBefore}->${memory.policyState().pendingPressure} active=${memory.usage().records}`,
  );
});

test('a legacy archive table is migrated with ALTER TABLE, additively', async (t) => {
  const root = await tempRoot();
  t.after(() => rm(root, { recursive: true, force: true }).catch(() => {}));
  const dir = join(root, 'memory');
  await mkdir(dir, { recursive: true });
  // A database written before the identity columns existed.
  const legacy = new DatabaseSync(join(dir, 'memory.db'));
  legacy.exec(`CREATE TABLE memory_archive (
    id TEXT PRIMARY KEY,
    ts TEXT NOT NULL,
    domain TEXT NOT NULL,
    kind TEXT NOT NULL,
    text TEXT NOT NULL,
    importance INTEGER NOT NULL,
    clarity TEXT NOT NULL,
    archived_at TEXT NOT NULL,
    reason TEXT NOT NULL
  )`);
  legacy.prepare(`INSERT INTO memory_archive (id, ts, domain, kind, text, importance, clarity, archived_at, reason)
    VALUES ('legacy-1', '2026-01-01T00:00:00.000Z', 'chat', 'event', '旧库归档行', 50, 'trace',
      '2026-01-02T00:00:00.000Z', 'capacity')`).run();
  legacy.close();

  const memory = new MemoryStore(root, { capacity: 2000 });
  t.after(() => cleanup(root, memory));
  memory.open();
  const columns = new Set(memory.db.prepare('PRAGMA table_info(memory_archive)').all().map((row) => row.name));
  for (const name of ['message_id', 'session_id', 'turn_id', 'role', 'truncated']) {
    assert.ok(columns.has(name), `migration added ${name}`);
  }
  assert.equal(memory.listArchive({ limit: 5 })[0].text, '旧库归档行', 'the legacy row is preserved');

  console.log(`[archive-migrate] columns=${[...columns].join(',')}`);
});
