/**
 * `MemoryStore.migrate()` must close every legacy database it probes.
 *
 * The bug: `profile.db` matches DOMAIN_RE, so migrate opened it as an old memory store and ran a
 * `memory_event` query that threw. The catch branch skipped `old.close()`, leaking the
 * DatabaseSync handle; on Windows deleting the memory directory then failed with
 * `EBUSY memory\profile.db`.
 *
 * This test plants both files (a non-memory profile.db + a genuine old chat.db), runs migrate,
 * verifies the real data landed, then deletes the memory directory: a leaked handle makes the
 * removal throw, so success is the proof that both handles were closed.
 *
 * Run: node --test test/memory-migrate-handle.mjs
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { MemoryStore } from '../src/host/memory/store.js';

const { DatabaseSync } = await import('node:sqlite');

test('migrate closes the non-memory profile.db handle and still imports real old databases', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-migrate-handle-'));
  const dir = join(root, 'memory');
  await mkdir(dir, { recursive: true });
  t.after(async () => {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });

  // 1) A domain-shaped file that is NOT a memory database: profile.db matches DOMAIN_RE.
  const profile = new DatabaseSync(join(dir, 'profile.db'));
  profile.exec('CREATE TABLE profile (id TEXT PRIMARY KEY, name TEXT NOT NULL)');
  profile.prepare('INSERT INTO profile (id, name) VALUES (?, ?)').run('p-1', 'seirein');
  profile.close();

  // 2) A genuine old per-domain memory database with one row.
  const oldChat = new DatabaseSync(join(dir, 'chat.db'));
  oldChat.exec(`CREATE TABLE memory_event (
    id TEXT PRIMARY KEY, ts TEXT NOT NULL, domain TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL
  )`);
  oldChat
    .prepare('INSERT INTO memory_event (id, ts, domain, kind, text) VALUES (?, ?, ?, ?, ?)')
    .run('old-1', '2026-01-01T00:00:00.000Z', 'chat', 'fact', '旧库里的记忆：用户喜欢冰美式');
  oldChat.close();

  const store = new MemoryStore(root);
  store.open(); // opens memory.db and runs migrate()

  // The real old database was imported into the new store (rows are null-prototype objects).
  const stats = store.stats();
  assert.equal(stats.length, 1, 'one migrated domain');
  assert.equal(stats[0].domain, 'chat');
  assert.equal(stats[0].c, 1, 'the genuine old row was migrated');
  assert.equal(existsSync(join(dir, 'chat.db')), false, 'the old database file was renamed');
  assert.equal(existsSync(join(dir, 'chat.db.migrated')), true, 'the old database is kept as .migrated');
  // The non-memory database is skipped untouched — never renamed, never half-imported.
  assert.equal(existsSync(join(dir, 'profile.db')), true, 'profile.db is left in place');
  assert.equal(existsSync(join(dir, 'profile.db.migrated')), false);

  // The leak proof: on Windows an open DatabaseSync keeps profile.db locked, so this recursive
  // removal throws EBUSY. With both legacy handles closed it must simply succeed.
  store.close();
  await rm(dir, { recursive: true });
  await rm(root, { recursive: true, force: true });
});

test('a locked/corrupt legacy file is skipped without leaking or breaking the open', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-migrate-corrupt-'));
  const dir = join(root, 'memory');
  await mkdir(dir, { recursive: true });
  t.after(async () => {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });

  // A file with the right name but no SQLite header: `new DatabaseSync` or the probe throws.
  const { writeFile } = await import('node:fs/promises');
  await writeFile(join(dir, 'work.db'), 'not a sqlite database', 'utf8');

  const store = new MemoryStore(root);
  store.open(); // must not throw; the bad file is left alone
  assert.deepEqual(store.stats(), [], 'no bogus rows were imported');
  assert.equal(existsSync(join(dir, 'work.db')), true, 'the unreadable file is preserved');

  store.close();
  await rm(dir, { recursive: true });
  await rm(root, { recursive: true, force: true });
});
