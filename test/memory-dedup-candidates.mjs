/**
 * P-67 stage 1 — semantic duplicate CANDIDATES (report only, never merge).
 *
 * The list mirrors the acceptance items:
 *   1. identical text → exactly one candidate pair;
 *   2. punctuation / whitespace / filler differences only → candidate;
 *   3. a different number or date (周三 vs 周四, 3 vs 4) → NOT a candidate;
 *   4. a different negation (喜欢 vs 不喜欢) → NOT a candidate;
 *   5. same derived subject + same kind + high similarity → candidate, reasons name both;
 *   6. `limit` caps the report and pairs come back score-descending;
 *   7. no write: a read-only store proxy is untouched and every table/FTS row is unchanged;
 *   8. smoke: `memory-normalize` still works and its canonical body is what dedup compares.
 *
 * Run: node --test test/memory-dedup-candidates.mjs
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { MemoryStore } from '../src/host/memory/store.js';
import { normalizeForMemory } from '../src/host/memory/memory-normalize.js';
import {
  DEDUP_DEFAULTS,
  dedupCandidates,
  dedupSimilarity,
  normalizeForDedup,
} from '../src/host/memory/dedup-candidates.js';

const NOW = new Date('2026-11-08T10:00:00+08:00');

async function tempRoot() {
  return mkdtemp(join(tmpdir(), 'dsh-mem-dedup-'));
}

async function cleanup(root, memory) {
  try {
    memory.close();
  } catch {
    /* already closed */
  }
  await rm(root, { recursive: true, force: true }).catch(() => {});
}

function entry(id, text, kind = 'fact') {
  return Object.freeze({ id, text, kind });
}

/** Store rows are passed as-is: dedup only reads id/text/kind (plus the extras it ignores). */
function storeEntries(memory) {
  return memory.db
    .prepare(`SELECT id, ts, domain, kind, text, clarity, recall_count AS recallCount
      FROM memory_event ORDER BY ts, id`)
    .all();
}

/** Every table a merge would touch (plus the FTS mirror), serialized for an exact before/after. */
function snapshot(memory) {
  const count = (sql) => memory.db.prepare(sql).get().n;
  return JSON.stringify({
    events: memory.db
      .prepare(`SELECT id, ts, domain, kind, text, clarity, recall_count, message_id, raw_text,
        version, updated_at, hidden, superseded_by FROM memory_event ORDER BY id`)
      .all(),
    revisions: count('SELECT COUNT(*) AS n FROM memory_revision'),
    links: count('SELECT COUNT(*) AS n FROM memory_link'),
    archive: count('SELECT COUNT(*) AS n FROM memory_archive'),
    fts: count('SELECT COUNT(*) AS n FROM memory_fts'),
    archiveFts: count('SELECT COUNT(*) AS n FROM memory_archive_fts'),
  });
}

test('1. identical text → exactly one pair, score 1', () => {
  const pairs = dedupCandidates(
    [entry('a', '我今天去了公园'), entry('b', '我今天去了公园')],
    { now: NOW },
  );
  assert.equal(pairs.length, 1);
  assert.deepEqual(pairs[0].a, { id: 'a', text: '我今天去了公园' });
  assert.deepEqual(pairs[0].b, { id: 'b', text: '我今天去了公园' });
  assert.equal(pairs[0].score, 1);
  assert.deepEqual(pairs[0].reasons, ['normalized-equal']);
  console.log('[identical]', JSON.stringify(pairs[0]));
});

test('2. punctuation / whitespace / fillers only → candidate', () => {
  const left = normalizeForDedup('我喜欢猫。', { now: NOW });
  const right = normalizeForDedup(' 我 喜欢猫啊！ ', { now: NOW });
  assert.equal(left.key, '我喜欢猫');
  assert.equal(right.key, '我喜欢猫');
  assert.equal(left.key, right.key);

  const pairs = dedupCandidates(
    [entry('p1', '我喜欢猫。'), entry('p2', ' 我 喜欢猫啊！ ')],
    { now: NOW },
  );
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].score, 1);
  assert.deepEqual(pairs[0].reasons, ['normalized-equal']);
  console.log(`[punctuation] key="${left.key}" score=${pairs[0].score} reasons=${pairs[0].reasons.join(',')}`);
});

test('3. a different number/date is never a candidate', () => {
  const wed = normalizeForDedup('我周三去爬山', { now: NOW });
  const thu = normalizeForDedup('我周四去爬山', { now: NOW });
  assert.notDeepEqual(wed.numbers, thu.numbers);

  assert.deepEqual(
    dedupCandidates([entry('d1', '我周三去爬山'), entry('d2', '我周四去爬山')], { now: NOW }),
    [],
    '周三 and 周四 are different days, not duplicates',
  );
  assert.deepEqual(
    dedupCandidates([entry('n1', '我买了3个苹果'), entry('n2', '我买了4个苹果')], { now: NOW }),
    [],
    'a different quantity is not a duplicate',
  );
  // Relative dates are made absolute by memory-normalize BEFORE comparison, so a real duplicate
  // written two ways is still one body.
  const relative = normalizeForDedup('明天去公园', { now: NOW });
  const absolute = normalizeForDedup('2026-11-09去公园', { now: NOW });
  assert.equal(relative.key, absolute.key);
  assert.equal(
    dedupCandidates([entry('r1', '明天去公园'), entry('r2', '2026-11-09去公园')], { now: NOW }).length,
    1,
    'the same day written relatively and absolutely is one body',
  );
  console.log(`[number] 周三=${JSON.stringify(wed.numbers)} 周四=${JSON.stringify(thu.numbers)} pairs=0`);
});

test('4. a different negation is never a candidate', () => {
  const like = normalizeForDedup('我喜欢猫', { now: NOW });
  const dislike = normalizeForDedup('我不喜欢猫', { now: NOW });
  assert.deepEqual(like.negations, []);
  assert.deepEqual(dislike.negations, ['不']);

  assert.deepEqual(
    dedupCandidates([entry('g1', '我喜欢猫'), entry('g2', '我不喜欢猫')], { now: NOW }),
    [],
  );
  console.log(`[negation] like=${JSON.stringify(like.negations)} dislike=${JSON.stringify(dislike.negations)} pairs=0`);
});

test('5. same subject + same kind + high similarity → candidate, reasons name both', () => {
  const left = normalizeForDedup('小明每天早上跑步', { now: NOW });
  const right = normalizeForDedup('小明每天早上去跑步', { now: NOW });
  assert.equal(left.subject, '小明');
  assert.equal(right.subject, '小明');
  const similarity = dedupSimilarity(left.key, right.key);
  assert.ok(similarity >= DEDUP_DEFAULTS.subjectKindThreshold && similarity < DEDUP_DEFAULTS.threshold);

  const pairs = dedupCandidates(
    [entry('s1', '小明每天早上跑步', 'habit'), entry('s2', '小明每天早上去跑步', 'habit')],
    { now: NOW },
  );
  assert.equal(pairs.length, 1);
  assert.ok(pairs[0].score > DEDUP_DEFAULTS.subjectKindThreshold && pairs[0].score < DEDUP_DEFAULTS.threshold);
  assert.ok(pairs[0].reasons.includes('same-subject'), `reasons: ${pairs[0].reasons}`);
  assert.ok(pairs[0].reasons.includes('same-kind'), `reasons: ${pairs[0].reasons}`);

  // The same two bodies with a different `kind` fall below the plain Jaccard threshold, so the
  // subject+kind rule is what made them a candidate.
  assert.deepEqual(
    dedupCandidates(
      [entry('s1', '小明每天早上跑步', 'habit'), entry('s2', '小明每天早上去跑步', 'event')],
      { now: NOW },
    ),
    [],
  );

  // A different subject is a different fact: these two clear the 0.75 Jaccard bar on wording,
  // yet the subject guard drops them (otherwise “小明” and “小红” would look like one memory).
  const other = '小明每天早上坚持跑步锻炼身体真的很有用';
  const otherSubject = '小红每天早上坚持跑步锻炼身体真的很有用';
  assert.ok(
    dedupSimilarity(normalizeForDedup(other, { now: NOW }).key, normalizeForDedup(otherSubject, { now: NOW }).key)
      >= DEDUP_DEFAULTS.threshold,
  );
  assert.deepEqual(
    dedupCandidates([entry('x1', other, 'habit'), entry('x2', otherSubject, 'habit')], { now: NOW }),
    [],
    'different subjects must not be reported as duplicates',
  );
  console.log(
    `[subject-kind] subject=${left.subject} similarity=${similarity.toFixed(4)} score=${pairs[0].score.toFixed(4)} reasons=${pairs[0].reasons.join(',')}`,
  );
});

test('6. limit caps the report; pairs are score-descending', () => {
  const list = [
    entry('c1', '今天下雨了'),
    entry('c2', '今天下雨了。'),
    entry('c3', '我喜欢猫'),
    entry('c4', '我喜欢猫咪'),
    entry('c5', '小明每天早上跑步', 'habit'),
    entry('c6', '小明每天早上去跑步', 'habit'),
  ];
  const all = dedupCandidates(list, { now: NOW });
  assert.equal(all.length, 3);
  assert.ok(all.every((pair, index) => index === 0 || pair.score <= all[index - 1].score), 'score descending');
  assert.deepEqual(all.map((pair) => pair.a.id), ['c1', 'c3', 'c5']);

  const capped = dedupCandidates(list, { now: NOW, limit: 2 });
  assert.equal(capped.length, 2);
  assert.equal(capped[0].score, 1);
  assert.equal(capped[1].score, 0.75);
  assert.deepEqual(capped.map((pair) => pair.a.id), ['c1', 'c3']);

  // A throwing FTS probe is ignored: reporting still works and nothing is written anywhere.
  const unprobed = dedupCandidates(list, {
    now: NOW,
    ftsQuery: () => {
      throw new Error('FTS unavailable');
    },
  });
  assert.deepEqual(unprobed, all);
  console.log(`[limit] all=${all.map((p) => p.score.toFixed(2)).join(',')} capped=${capped.length}`);
});

test('7. read-only store: no row, revision, link, archive or FTS change', async (t) => {
  const root = await tempRoot();
  const memory = new MemoryStore(root, { capacity: 2000 });
  t.after(() => cleanup(root, memory));

  const bodies = ['我喜欢猫', '我喜欢猫咪', '今天下雨了'];
  bodies.forEach((text, index) => {
    const stored = memory.addMessage({
      role: 'user',
      sessionId: 'dedup',
      turnId: index + 1,
      messageId: `dedup-${index + 1}`,
      text,
    });
    assert.equal(stored.deduped, false, `seed ${index} stored`);
  });
  assert.equal(storeEntries(memory).length, 3);

  // Any accidental write THROWS here; reads (search/open/db getters) pass through.
  const mutators = new Set([
    'add', 'addMessage', 'insert', 'insertLink', 'addLink', 'correct', 'update', 'setClarity',
    'reinforce', 'fade', 'compact', 'archive', 'deleteArchived', 'persistCandidate',
  ]);
  const readOnly = new Proxy(memory, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && mutators.has(prop)) {
        return () => {
          throw new Error(`dedup wrote through read-only store: ${prop}`);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  const before = snapshot(memory);
  const seeds = storeEntries(memory).filter((row) => row.text === '我喜欢猫');
  assert.equal(seeds.length, 1);

  const pairs = dedupCandidates(seeds, {
    now: NOW,
    // Read-only FTS widening: the second near-duplicate is NOT in the seed list.
    ftsQuery: (text) => readOnly.search({ query: text, limit: 5 }).hits,
  });
  assert.equal(pairs.length, 1, `pairs: ${JSON.stringify(pairs)}`);
  assert.equal(pairs[0].b.text, '我喜欢猫咪');
  assert.ok(pairs[0].reasons.includes('fts-expanded'), `reasons: ${pairs[0].reasons}`);

  assert.equal(snapshot(memory), before, 'every table and the FTS mirror are byte-for-byte unchanged');
  assert.equal(memory.usage().records, 3);
  console.log(`[read-only] pairs=${pairs.length} reasons=${pairs[0].reasons.join(',')} records=${memory.usage().records}`);
});

test('8. smoke: memory-normalize still canonicalizes and dedup reuses it', () => {
  const normalized = normalizeForMemory('明天去公园', { now: NOW });
  assert.equal(normalized.text, '2026-11-09去公园');
  assert.deepEqual(normalized.changes, ['time']);
  assert.equal(normalized.unresolved, 0);

  const viaDedup = normalizeForDedup('明天去公园', { now: NOW });
  assert.equal(viaDedup.text, '2026-11-09去公园');
  assert.equal(viaDedup.key, '20261109去公园');

  // Non-memory-shape input is ignored, not thrown on.
  assert.deepEqual(dedupCandidates([], { now: NOW }), []);
  assert.deepEqual(dedupCandidates([null, {}, { id: 'x', text: '   ' }], { now: NOW }), []);
  console.log(`[smoke] normalize="${normalized.text}" changes=${normalized.changes.join(',')}`);
});
