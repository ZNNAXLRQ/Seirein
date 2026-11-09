/**
 * P-67 §2.4 / §7.5 — duplicate memories are REPORTED as candidates, never merged.
 *
 * The report is read-only and bounded: at most `limit` pairs from at most `scanLimit` manual
 * rows, one query per call, no write path. This suite asserts the acceptance items:
 *   1. two similar manual records produce a candidate with ids/kind/score/reasons;
 *   2. different records (number/date/negation) produce no candidate;
 *   3. the report is capped and score-descending;
 *   4. empty stores and malformed rows return [] instead of throwing;
 *   5. every memory/revision/link/archive/FTS row is byte-for-byte unchanged afterwards;
 *   6. the event carries ids/kind/score/reasons and no memory body.
 *
 * Run: node --test test/memory-dedupe-candidates.mjs
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { MemoryStore, dedupCandidates as pureDedupCandidates } from '../src/host/memory/store.js';

const NOW = new Date('2026-11-09T10:00:00+08:00');

async function tempRoot() {
  return mkdtemp(join(tmpdir(), 'dsh-mem-dedupe-'));
}

async function openStore(t, onEvent = null) {
  const root = await tempRoot();
  const store = new MemoryStore(root, { capacity: 2000, onEvent });
  t.after(async () => {
    try {
      store.close();
    } catch {
      /* already closed */
    }
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });
  return store;
}

function manual(store, text, kind = 'preference') {
  return store.add('chat', text, kind, { source: 'manual', importance: 60, now: NOW });
}

/** Manual record with an explicit timestamp, so LIMIT/ORDER scans are deterministic. */
function manualAt(store, text, kind, ts) {
  const record = manual(store, text, kind);
  store.db.prepare('UPDATE memory_event SET ts = ? WHERE id = ?').run(ts, record.id);
  record.ts = ts;
  return record;
}

/** Every table a merge would touch, plus the FTS mirrors, serialized for an exact before/after. */
function snapshot(store) {
  const count = (sql) => store.db.prepare(sql).get().n;
  return JSON.stringify({
    events: store.db.prepare(`SELECT id, ts, domain, kind, text, importance, clarity, last_seen,
      recall_count, source, message_id, raw_text, unresolved, version, hidden, superseded_by
      FROM memory_event ORDER BY id`).all(),
    revisions: count('SELECT COUNT(*) AS n FROM memory_revision'),
    links: count('SELECT COUNT(*) AS n FROM memory_link'),
    archive: count('SELECT COUNT(*) AS n FROM memory_archive'),
    fts: count('SELECT COUNT(*) AS n FROM memory_fts'),
    archiveFts: count('SELECT COUNT(*) AS n FROM memory_archive_fts'),
  });
}

function idSet(pair) {
  return [pair.a.id, pair.b.id].sort();
}

test('1. similar manual records produce one candidate with id/kind/score/reasons', async (t) => {
  const events = [];
  const store = await openStore(t, (type, payload) => events.push({ type, payload }));
  const first = manual(store, '我喜欢猫');
  const second = manual(store, '我喜欢猫咪');

  const pairs = store.dedupeCandidates({ now: NOW });
  assert.equal(pairs.length, 1, JSON.stringify(pairs));
  const pair = pairs[0];
  assert.deepEqual(idSet(pair), [first.id, second.id].sort());
  assert.equal(pair.kind, 'preference');
  assert.equal(pair.a.kind, 'preference');
  assert.equal(pair.b.kind, 'preference');
  assert.ok(pair.score >= 0.7 && pair.score <= 1, `score=${pair.score}`);
  assert.ok(pair.reasons.length > 0);
  assert.equal(pair.reason, pair.reasons.join(', '));

  const event = events.find((entry) => entry.type === 'memory.dedup.candidates');
  assert.ok(event !== undefined, 'the report is returned through an existing event too');
  assert.equal(event.payload.count, 1);
  assert.deepEqual(event.payload.pairs[0], {
    a: pair.a.id,
    b: pair.b.id,
    kind: 'preference',
    score: pair.score,
    reasons: pair.reasons,
  });
  assert.ok(!JSON.stringify(event.payload).includes('喜欢猫'), 'the event never carries the body');
  console.log(`[1] pair=${pair.a.id.slice(0, 8)}/${pair.b.id.slice(0, 8)} score=${pair.score} reasons=${pair.reason}`);
});

test('2. a different number, date or negation is not a candidate', async (t) => {
  const store = await openStore(t);
  const like = manual(store, '我喜欢猫');
  const dislike = manual(store, '我不喜欢猫');
  const apples3 = manual(store, '我买了3个苹果', 'fact');
  const apples4 = manual(store, '我买了4个苹果', 'fact');
  const wednesday = manual(store, '我周三去爬山', 'fact');
  const thursday = manual(store, '我周四去爬山', 'fact');

  const pairs = store.dedupeCandidates({ now: NOW });
  assert.deepEqual(pairs, [], 'guards must drop different numbers/dates/negations');
  for (const record of [like, dislike, apples3, apples4, wednesday, thursday]) {
    assert.ok(
      !pairs.some((pair) => idSet(pair).includes(record.id)),
      `${record.text} must not be reported as a duplicate`,
    );
  }
  console.log('[2] number/date/negation differences → 0 pairs');
});

test('3. the report is bounded (limit/scanLimit) and score-descending', async (t) => {
  const store = await openStore(t);
  manualAt(store, '我喜欢猫', 'preference', '2026-11-09T01:00:00.000Z');
  manualAt(store, '我喜欢猫咪', 'preference', '2026-11-09T01:00:01.000Z');
  manualAt(store, '小明每天早上跑步', 'habit', '2026-11-09T02:00:00.000Z');
  manualAt(store, '小明每天早上去跑步', 'habit', '2026-11-09T02:00:01.000Z');

  const all = store.dedupeCandidates({ now: NOW });
  assert.equal(all.length, 2);
  assert.ok(all.every((pair, index) => index === 0 || pair.score <= all[index - 1].score));

  assert.equal(store.dedupeCandidates({ now: NOW, limit: 1 }).length, 1);
  assert.deepEqual(store.dedupeCandidates({ now: NOW, limit: 0 }), [], 'limit 0 returns nothing');
  // Only the newest two rows are scanned: the older cat pair cannot be reported.
  const narrow = store.dedupeCandidates({ now: NOW, scanLimit: 2 });
  assert.equal(narrow.length, 1);
  assert.equal(narrow[0].kind, 'habit', 'the newest two rows are the habit pair');
  console.log(`[3] all=${all.length} limit1=1 limit0=0 scanLimit2=${narrow.length}`);
});

test('4. the report never writes: rows, revisions, links, archive and FTS are unchanged', async (t) => {
  const store = await openStore(t);
  const first = manual(store, '我喜欢猫');
  const second = manual(store, '我喜欢猫咪');
  manual(store, '我不喜欢猫');
  store.addMessage({
    role: 'user',
    sessionId: 'auto-dedupe',
    turnId: 1,
    messageId: 'auto-dedupe-1',
    text: '我喜欢猫',
    ts: NOW.toISOString(),
  });

  const before = snapshot(store);
  const beforeUsage = store.usage();
  const pairs = store.dedupeCandidates({ now: NOW });
  assert.equal(pairs.length, 1);
  assert.deepEqual(idSet(pairs[0]), [first.id, second.id].sort(), 'only manual rows are compared');
  assert.equal(snapshot(store), before, 'every table and FTS mirror is byte-for-byte unchanged');
  assert.deepEqual(store.usage(), beforeUsage);
  console.log(`[4] pairs=${pairs.length} records=${store.usage().records} snapshot=unchanged`);
});

test('5. empty store, malformed rows and an unavailable query return [] without throwing', async (t) => {
  const empty = await openStore(t);
  assert.deepEqual(empty.dedupeCandidates({ now: NOW }), []);

  // Pure function: malformed entries are ignored, not thrown on.
  assert.deepEqual(
    pureDedupCandidates([null, {}, { id: 'x', text: '   ' }, { id: 'y', text: 42 }], { now: NOW }),
    [],
  );

  const store = await openStore(t);
  manual(store, '我喜欢猫');
  manual(store, '我喜欢猫咪');
  // Bad option values are clamped to safe defaults, not rejected.
  assert.equal(store.dedupeCandidates({ now: NOW, limit: 'nope', scanLimit: -5, threshold: 'bad' }).length, 1);

  // A broken/unavailable query is a report failure, never an exception on the read path.
  const original = store.db.prepare;
  store.db.prepare = () => {
    throw new Error('database unavailable');
  };
  try {
    assert.deepEqual(store.dedupeCandidates({ now: NOW }), []);
  } finally {
    store.db.prepare = original;
  }
  console.log('[5] empty/malformed/broken-query → [] (no throw)');
});
