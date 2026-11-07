/**
 * R08 regression: the archive search must answer short queries through LIKE instead of a
 * trigram MATCH that silently returns zero rows, fall back to LIKE once when FTS misses a row
 * that LIKE can find, escape LIKE wildcards, and never let a budget be exceeded by one long
 * first record.
 *
 * Run: node --test test/memory-archive-search.mjs
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { MemoryStore } from '../src/host/memory/store.js';

/** A temp root with an open store; the DB must be closed before removal on Windows. */
async function tempStore(options = { capacity: 50 }) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-r08-'));
  const memory = new MemoryStore(root, options);
  memory.open();
  return { root, memory };
}

async function cleanup(root, memory) {
  memory.close();
  await rm(root, { recursive: true, force: true }).catch(() => {});
}

let archiveSeq = 0;

/** Insert one archived row directly; the archive triggers keep memory_archive_fts in sync. */
function archive(memory, text) {
  const id = randomUUID();
  const at = new Date(Date.UTC(2026, 0, 1, 0, 0, archiveSeq++)).toISOString();
  memory.db
    .prepare(`INSERT INTO memory_archive
      (id, ts, domain, kind, text, importance, clarity, archived_at, reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, at, 'chat', 'fact', text, 50, 'trace', at, 'test');
  return id;
}

/** Independent LIKE reference: the result an unindexed scan would produce. */
function likeIds(memory, query) {
  const escaped = query.replace(/[\\%_]/gu, '\\$&');
  return memory.db
    .prepare(`SELECT id FROM memory_archive WHERE text LIKE ? ESCAPE '\\'
      ORDER BY archived_at DESC`)
    .all(`%${escaped}%`)
    .map((row) => row.id);
}

test('a) two-character queries take the LIKE path and return every match', async () => {
  const { root, memory } = await tempStore();
  try {
    const first = archive(memory, '我喜欢看动画电影');
    const second = archive(memory, '这部动画片很好看');
    archive(memory, '今天的工作记录');
    const literal = archive(memory, '百分比符号 %_ 测试');

    const hits = memory.searchArchive('动画');
    assert.equal(hits.length, 2, 'both rows containing 动画 are found');
    assert.deepEqual(new Set(hits.map((row) => row.id)), new Set([first, second]));
    assert.equal(memory.listArchive({ query: '动画' }).length, 2, 'listArchive uses the same path');

    const escaped = memory.searchArchive('%_');
    assert.equal(escaped.length, 1, 'LIKE wildcards in the query are escaped');
    assert.equal(escaped[0].id, literal);
    assert.equal(memory.listArchive({ query: '%_' }).length, 1);
  } finally {
    await cleanup(root, memory);
  }
});

test('b) three-plus-character queries use FTS and agree with LIKE', async () => {
  const { root, memory } = await tempStore();
  try {
    const first = archive(memory, '周末一起看动画电影');
    const second = archive(memory, '动画电影推荐清单');
    archive(memory, '今天的工作记录');

    const direct = memory.db
      .prepare('SELECT COUNT(*) AS c FROM memory_archive_fts WHERE memory_archive_fts MATCH ?')
      .get('"动画电影"').c;
    assert.equal(direct, 2, 'the trigram index serves the 4-character query');

    const hits = memory.searchArchive('动画电影');
    assert.deepEqual(hits.map((row) => row.id).sort(), likeIds(memory, '动画电影').sort());
    assert.deepEqual(new Set(hits.map((row) => row.id)), new Set([first, second]));
    assert.ok(
      hits.every((row) => row.fallback === undefined),
      'a successful FTS hit is not marked as a fallback',
    );
    assert.deepEqual(
      memory.listArchive({ query: '动画电影' }).map((row) => row.id).sort(),
      likeIds(memory, '动画电影').sort(),
    );
  } finally {
    await cleanup(root, memory);
  }
});

test('c) one oversize landmark record is truncated to a small budget', async () => {
  const { root, memory } = await tempStore();
  try {
    memory.add('chat', '长'.repeat(10000), 'fact', { importance: 100 });

    // `landmarkMemories` is the on-demand brief layer (never resident); the budget trim lives there.
    const rows = memory.landmarkMemories({ budgetChars: 50 });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].truncated, true, 'the record is marked as truncated');
    assert.equal(rows[0].text.length, 50, 'exactly the requested budget is kept');
    assert.ok(
      rows.reduce((sum, row) => sum + row.text.length, 0) <= 50,
      'the total never exceeds the budget',
    );
  } finally {
    await cleanup(root, memory);
  }
});

test('d) multiple records are cut at the budget without overshoot', async () => {
  const { root, memory } = await tempStore();
  try {
    memory.add('chat', 'a'.repeat(10), 'fact', { importance: 100 });
    memory.add('chat', 'b'.repeat(20), 'fact', { importance: 99 });
    memory.add('chat', 'c'.repeat(10), 'fact', { importance: 98 });

    const rows = memory.landmarkMemories({ budgetChars: 25 });
    const total = rows.reduce((sum, row) => sum + row.text.length, 0);
    assert.equal(rows.length, 2, 'the second record is cut, the third no longer fits');
    assert.equal(rows[0].text.length, 10);
    assert.equal(rows[0].truncated, undefined);
    assert.equal(rows[1].text, 'b'.repeat(15), 'the crossing record is cut to the remaining budget');
    assert.equal(rows[1].truncated, true);
    assert.equal(total, 25, 'the budget is spent exactly');
  } finally {
    await cleanup(root, memory);
  }
});

test('e) an empty FTS result falls back to LIKE once and marks the fallback', async () => {
  const { root, memory } = await tempStore();
  try {
    const id = archive(memory, '秋天去看枫叶动画电影');
    const rowid = memory.db.prepare('SELECT rowid FROM memory_archive WHERE id = ?').get(id).rowid;
    // Simulate a stale index: the row is in the table but the FTS entry is missing.
    memory.db.prepare('DELETE FROM memory_archive_fts WHERE rowid = ?').run(rowid);
    assert.equal(
      memory.db
        .prepare('SELECT COUNT(*) AS c FROM memory_archive_fts WHERE memory_archive_fts MATCH ?')
        .get('"枫叶动画电影"').c,
      0,
      'the index really misses the row',
    );

    const hits = memory.searchArchive('枫叶动画电影');
    assert.equal(hits.length, 1, 'LIKE found the row the index missed');
    assert.equal(hits[0].id, id);
    assert.equal(hits[0].fallback, 'like');

    const listed = memory.listArchive({ query: '枫叶动画电影' });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].fallback, 'like');
  } finally {
    await cleanup(root, memory);
  }
});
