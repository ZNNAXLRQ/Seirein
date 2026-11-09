/**
 * Speaker daily candidates — stage 4 cache (pure Node module).
 *
 * Acceptance items mirrored below:
 *   1. admission is mic-only, 800–15000 ms, quality `ok`; loopback/short/long/low-quality rejected;
 *   2. `utteranceId` de-duplication keeps the first row and does not delete the duplicate's audio;
 *   3. the persisted candidate shape is exactly the contract; audio is never copied or read;
 *   4. bounds: 40 rows / 300 s / 64 MiB / 7 days, oldest-first, audio removed on eviction;
 *   5. expiry is applied by add/list/groups/prune and removes audio after the metadata write;
 *   6. remove(id) / clear() unlink audio best-effort and empty the metadata;
 *   7. groups() uses cosine >= 0.72 complete-link, reports candidates/average/range, never identity;
 *   8. bad embeddings (base64/NaN/truncated/zero) and bad JSON are tolerated, never thrown;
 *   9. embedding serialization round-trips and is validated.
 *
 * No model, network, speaker template, speaker library or identity assignment is involved.
 *
 * Run: node --test test/speaker-candidates.mjs
 */
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  DEFAULT_SPEAKER_CANDIDATE_LIMITS,
  SPEAKER_CANDIDATES_VERSION,
  SPEAKER_CANDIDATE_GROUP_THRESHOLD,
  cosineSimilarity,
  createSpeakerCandidatesStore,
  decodeEmbedding,
  encodeEmbedding,
} from '../src/host/hearing/speaker-candidates.js';

const T0 = Date.parse('2026-11-10T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

const CANDIDATE_KEYS = [
  'id',
  'utteranceId',
  'speakerId',
  'embedding',
  'durationMs',
  'at',
  'source',
  'quality',
  'text',
  'audioPath',
  'status',
  'groupId',
].sort();

/** One temp root, one injected clock and a helper that writes real (dummy) audio files. */
function setup(t, { limits = null, log = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'seirein-speaker-candidates-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const audioDir = join(root, 'audio');
  mkdirSync(audioDir, { recursive: true });
  let now = T0;
  let seq = 0;
  const clock = () => new Date(now);
  const store = createSpeakerCandidatesStore({ root, clock, limits, log });
  const audio = (bytes = 400) => {
    seq += 1;
    const path = join(audioDir, `clip-${seq}.wav`);
    writeFileSync(path, Buffer.alloc(bytes, 0x5a));
    return path;
  };
  return {
    root,
    audioDir,
    store,
    file: store.file,
    audio,
    advance: (ms) => { now += ms; },
    now: () => now,
  };
}

function candidateInput(audioPath, overrides = {}) {
  return {
    utteranceId: 'u1',
    embedding: new Float32Array([1, 0, 0]),
    durationMs: 1000,
    audioPath,
    ...overrides,
  };
}

function readMeta(store) {
  return JSON.parse(readFileSync(store.file, 'utf8'));
}

function writeMeta(store, value) {
  mkdirSync(dirname(store.file), { recursive: true });
  writeFileSync(store.file, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/** A metadata row with a deliberately encoded bad vector. */
function badEmbedding(base, id, utteranceId, embedding) {
  return { ...base, id, utteranceId, embedding };
}

// ---------------------------------------------------------------------------
// 1. Admission
// ---------------------------------------------------------------------------

test('1. add 只接受 mic / 800–15000ms / quality ok', (t) => {
  const { store, file, audio } = setup(t);
  const path = audio();

  const rejected = [
    [{ source: 'loopback' }, 'invalid-source'],
    [{ source: 'MIC' }, 'invalid-source'],
    [{ source: '' }, 'invalid-source'],
    [{ quality: 'short' }, 'invalid-quality'],
    [{ quality: 'quiet' }, 'invalid-quality'],
    [{ durationMs: 799 }, 'too-short'],
    [{ durationMs: 0 }, 'too-short'],
    [{ durationMs: 15001 }, 'too-long'],
    [{ durationMs: Number.NaN }, 'invalid-duration'],
    [{ durationMs: undefined }, 'invalid-duration'],
    [{ embedding: [] }, 'invalid-embedding'],
    [{ embedding: [1, Number.NaN] }, 'invalid-embedding'],
    [{ embedding: [0, 0] }, 'invalid-embedding'],
    [{ embedding: 'AAAA' }, 'invalid-embedding'],
    [{ embedding: { 0: 1, length: 1 } }, 'invalid-embedding'],
    [{ audioPath: '' }, 'audio-path-required'],
    [{ utteranceId: '   ' }, 'utterance-id-required'],
  ];
  for (const [overrides, reason] of rejected) {
    const result = store.add(candidateInput(path, overrides));
    assert.equal(result.ok, false, `expected rejection for ${JSON.stringify(overrides)}`);
    assert.equal(result.reason, reason, `reason for ${JSON.stringify(overrides)}`);
  }
  assert.deepEqual(store.list(), []);
  assert.equal(existsSync(file), false, 'rejected adds must not create metadata');

  // Inclusive duration boundaries; omitted source/quality default to mic/ok.
  assert.equal(store.add(candidateInput(audio(), { durationMs: 800 })).ok, true);
  assert.equal(store.add(candidateInput(audio(), { durationMs: 15000, utteranceId: 'u2' })).ok, true);
  const defaults = store.add(candidateInput(audio(), { utteranceId: 'u3' }));
  assert.equal(defaults.ok, true);
  assert.equal(defaults.candidate.source, 'mic');
  assert.equal(defaults.candidate.quality, 'ok');
  assert.equal(defaults.candidate.status, 'pending');
  assert.equal(store.list().length, 3);
});

// ---------------------------------------------------------------------------
// 2. Utterance de-duplication
// ---------------------------------------------------------------------------

test('2. utteranceId 去重：保留第一条，不删重复调用的音频', (t) => {
  const { store, audio } = setup(t);
  const firstPath = audio();
  const duplicatePath = audio();
  const first = store.add(candidateInput(firstPath, { text: ' first ' }));
  assert.equal(first.ok, true);

  const duplicate = store.add(candidateInput(duplicatePath, { text: 'second' }));
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.added, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.reason, 'duplicate-utterance');
  assert.equal(duplicate.candidate.id, first.candidate.id);
  assert.equal(duplicate.candidate.text, 'first');

  assert.equal(store.list().length, 1);
  assert.equal(existsSync(firstPath), true);
  assert.equal(existsSync(duplicatePath), true, 'a duplicate add owns its own audio, not the cache');
});

// ---------------------------------------------------------------------------
// 3. Persisted shape, no audio copy, restart
// ---------------------------------------------------------------------------

test('3. 候选字段/持久化形状正确，音频不复制，重启可读', (t) => {
  const { root, store, file, audio } = setup(t);
  const audioPath = audio(777);
  const before = readFileSync(audioPath);
  const at = new Date(T0 + 1234).toISOString();
  const added = store.add(candidateInput(audioPath, {
    durationMs: 1234,
    at,
    text: '  你好  ',
    speakerId: null,
  }));
  assert.equal(added.ok, true);
  assert.equal(added.added, true);
  assert.deepEqual(Object.keys(added.candidate).sort(), CANDIDATE_KEYS);
  assert.equal(added.candidate.id, 'spc-1');
  assert.equal(added.candidate.utteranceId, 'u1');
  assert.equal(added.candidate.speakerId, null);
  assert.equal(added.candidate.durationMs, 1234);
  assert.equal(added.candidate.at, at);
  assert.equal(added.candidate.source, 'mic');
  assert.equal(added.candidate.quality, 'ok');
  assert.equal(added.candidate.text, '你好');
  assert.equal(added.candidate.audioPath, audioPath);
  assert.equal(added.candidate.status, 'pending');
  assert.equal(added.candidate.groupId, null);

  const vector = decodeEmbedding(added.candidate.embedding);
  assert.ok(vector instanceof Float32Array);
  assert.deepEqual([...vector], [...new Float32Array([1, 0, 0])].map((value) => Math.fround(value)));

  const persisted = readMeta(store);
  assert.deepEqual(Object.keys(persisted), ['version', 'updatedAt', 'candidates']);
  assert.equal(persisted.version, SPEAKER_CANDIDATES_VERSION);
  assert.match(persisted.updatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
  assert.deepEqual(persisted.candidates, [added.candidate]);

  // The module never opens, copies or rewrites the caller's audio.
  assert.deepEqual(readFileSync(audioPath), before);
  assert.deepEqual(readdirSync(join(root, 'audio')), ['clip-1.wav']);
  assert.deepEqual(readdirSync(dirname(file)), ['speaker-candidates.json'], 'atomic writes leave no temp file');

  const status = store.status();
  assert.equal(status.file, file);
  assert.equal(status.count, 1);
  assert.equal(status.totalDurationMs, 1234);
  assert.equal(status.totalBytes, 777);
  assert.equal(status.oldestAt, at);
  assert.equal(status.newestAt, at);
  assert.equal(status.pending, 1);
  assert.equal(status.expired, 0);
  assert.equal(status.withinLimits, true);
  assert.equal(status.groupCount, 0);
  assert.deepEqual(status.limits, { ...DEFAULT_SPEAKER_CANDIDATE_LIMITS });

  const restarted = createSpeakerCandidatesStore({ root });
  assert.deepEqual(restarted.list(), [added.candidate]);

  // list() returns independent clones.
  const copy = restarted.list()[0];
  copy.text = 'mutated';
  copy.embedding = 'broken';
  assert.equal(restarted.list()[0].text, '你好');
  assert.equal(restarted.list()[0].embedding, added.candidate.embedding);
});

// ---------------------------------------------------------------------------
// 4. Bounds
// ---------------------------------------------------------------------------

test('4a. 条数上限 40 的默认值与最旧淘汰', (t) => {
  assert.equal(DEFAULT_SPEAKER_CANDIDATE_LIMITS.maxCandidates, 40);
  assert.equal(DEFAULT_SPEAKER_CANDIDATE_LIMITS.maxTotalDurationMs, 300000);
  assert.equal(DEFAULT_SPEAKER_CANDIDATE_LIMITS.maxTotalBytes, 64 * 1024 * 1024);
  assert.equal(DEFAULT_SPEAKER_CANDIDATE_LIMITS.maxAgeMs, 7 * DAY);

  const { store, audio, advance } = setup(t, { limits: { maxCandidates: 2 } });
  const firstPath = audio();
  const secondPath = audio();
  const thirdPath = audio();
  const first = store.add(candidateInput(firstPath));
  advance(1000);
  const second = store.add(candidateInput(secondPath, { utteranceId: 'u2' }));
  advance(1000);
  const third = store.add(candidateInput(thirdPath, { utteranceId: 'u3' }));

  assert.equal(first.added, true);
  assert.equal(second.added, true);
  assert.equal(third.ok, true);
  assert.equal(third.added, true);
  assert.equal(third.pruned, 1);
  assert.deepEqual(third.removedIds, [first.candidate.id]);
  assert.equal(third.audioDeleted, 1);
  assert.equal(existsSync(firstPath), false, 'evicted audio must be removed');
  assert.equal(existsSync(secondPath), true);
  assert.equal(existsSync(thirdPath), true);
  assert.deepEqual(store.list().map((row) => row.id), [second.candidate.id, third.candidate.id]);
  assert.equal(store.status().totalBytes, 800);
});

test('4b. 总时长上限：最旧淘汰并删音频', (t) => {
  const { store, audio, advance } = setup(t, { limits: { maxTotalDurationMs: 5000 } });
  const firstPath = audio();
  const secondPath = audio();
  store.add(candidateInput(firstPath, { durationMs: 3000 }));
  advance(1000);
  const second = store.add(candidateInput(secondPath, { durationMs: 3000, utteranceId: 'u2' }));

  assert.equal(second.pruned, 1);
  assert.equal(existsSync(firstPath), false);
  assert.equal(existsSync(secondPath), true);
  assert.equal(store.list().length, 1);
  assert.equal(store.status().totalDurationMs, 3000);
});

test('4c. 总字节上限：按音频大小剪裁最旧条目', (t) => {
  const { store, audio, advance } = setup(t, { limits: { maxTotalBytes: 1000 } });
  const firstPath = audio(400);
  const secondPath = audio(400);
  const thirdPath = audio(400);
  store.add(candidateInput(firstPath));
  advance(1000);
  store.add(candidateInput(secondPath, { utteranceId: 'u2' }));
  advance(1000);
  const third = store.add(candidateInput(thirdPath, { utteranceId: 'u3' }));

  assert.equal(third.pruned, 1);
  assert.equal(third.audioDeleted, 1);
  assert.equal(existsSync(firstPath), false);
  assert.equal(existsSync(secondPath), true);
  assert.equal(existsSync(thirdPath), true);
  assert.equal(store.status().totalBytes, 800);
});

test('4d. 单条自身超过上限时拒绝，不建立元数据', (t) => {
  const bytesLimited = setup(t, { limits: { maxTotalBytes: 300 } });
  const bytePath = bytesLimited.audio(400);
  const tooManyBytes = bytesLimited.store.add(candidateInput(bytePath));
  assert.equal(tooManyBytes.ok, false);
  assert.equal(tooManyBytes.reason, 'over-limit');
  assert.equal(existsSync(bytesLimited.file), false);
  assert.equal(existsSync(bytePath), true, 'a rejected add never deletes caller audio');

  const durationLimited = setup(t, { limits: { maxTotalDurationMs: 1000 } });
  const durationPath = durationLimited.audio();
  const tooLong = durationLimited.store.add(candidateInput(durationPath, { durationMs: 15000 }));
  assert.equal(tooLong.ok, false);
  assert.equal(tooLong.reason, 'over-limit');
  assert.equal(existsSync(durationLimited.file), false);
  assert.equal(existsSync(durationPath), true);
});

// ---------------------------------------------------------------------------
// 5. Seven-day expiry
// ---------------------------------------------------------------------------

test('5. 7 天过期：status 只报告，prune/list/add 删除元数据与音频', (t) => {
  const exact = setup(t);
  const exactPath = exact.audio();
  exact.store.add(candidateInput(exactPath));
  exact.advance(7 * DAY);
  assert.equal(exact.store.prune().removed, 0, 'exactly 7 days is still inside the window');
  exact.advance(1);
  const pruned = exact.store.prune();
  assert.equal(pruned.removed, 1);
  assert.equal(pruned.expired, 1);
  assert.equal(pruned.audioDeleted, 1);
  assert.equal(existsSync(exactPath), false);
  assert.deepEqual(exact.store.list(), []);

  const listed = setup(t);
  const listedPath = listed.audio();
  listed.store.add(candidateInput(listedPath));
  listed.advance(8 * DAY);
  const status = listed.store.status();
  assert.equal(status.count, 1);
  assert.equal(status.expired, 1);
  assert.equal(status.withinLimits, false);
  assert.equal(existsSync(listedPath), true, 'status is read-only');
  assert.deepEqual(listed.store.list(), []);
  assert.equal(existsSync(listedPath), false, 'list() applies expiry and removes audio');

  const added = setup(t);
  const oldPath = added.audio();
  added.store.add(candidateInput(oldPath));
  added.advance(8 * DAY);
  const fresh = added.store.add(candidateInput(added.audio(), { utteranceId: 'u2' }));
  assert.equal(fresh.ok, true);
  assert.equal(fresh.pruned, 1);
  assert.equal(existsSync(oldPath), false);
  assert.equal(added.store.list().length, 1);

  const stale = setup(t);
  stale.advance(8 * DAY);
  const stalePath = stale.audio();
  const tooOld = stale.store.add(candidateInput(stalePath, { at: T0 }));
  assert.equal(tooOld.ok, false);
  assert.equal(tooOld.reason, 'too-old');
  assert.equal(existsSync(stalePath), true, 'a rejected stale row never loses its caller audio');
  assert.deepEqual(stale.store.list(), []);
});

// ---------------------------------------------------------------------------
// 6. remove / clear
// ---------------------------------------------------------------------------

test('6. remove(id) 删除候选与音频，未知 id / 缺失音频容错', (t) => {
  const { root, store, audio } = setup(t);
  const path = audio();
  const added = store.add(candidateInput(path));
  assert.equal(added.ok, true);

  const removed = store.remove(added.candidate.id);
  assert.equal(removed.ok, true);
  assert.equal(removed.candidate.id, added.candidate.id);
  assert.equal(removed.audioDeleted, true);
  assert.equal(existsSync(path), false);
  assert.deepEqual(store.list(), []);
  assert.deepEqual(store.remove(added.candidate.id), { ok: false, reason: 'not-found' });
  assert.deepEqual(store.remove(''), { ok: false, reason: 'id-required' });

  const missingPath = join(root, 'audio', 'missing.wav');
  const missing = store.add(candidateInput(missingPath, { utteranceId: 'u2' }));
  assert.equal(missing.ok, true);
  const removedMissing = store.remove(missing.candidate.id);
  assert.equal(removedMissing.ok, true);
  assert.equal(removedMissing.audioDeleted, false);
  assert.equal(removedMissing.audioFailed, true);
  assert.equal(existsSync(missingPath), false);
});

test('7. clear() 删除全部音频并清空元数据', (t) => {
  const { root, store, audio } = setup(t);
  const firstPath = audio();
  const secondPath = audio();
  store.add(candidateInput(firstPath));
  store.add(candidateInput(secondPath, { utteranceId: 'u2' }));

  const cleared = store.clear();
  assert.equal(cleared.ok, true);
  assert.equal(cleared.removed, 2);
  assert.equal(cleared.audioDeleted, 2);
  assert.equal(existsSync(firstPath), false);
  assert.equal(existsSync(secondPath), false);
  assert.deepEqual(store.list(), []);
  const persisted = readMeta(store);
  assert.equal(persisted.version, SPEAKER_CANDIDATES_VERSION);
  assert.deepEqual(persisted.candidates, []);

  const again = store.clear();
  assert.deepEqual(again, { ok: true, removed: 0, audioDeleted: 0, audioFailed: 0 });

  const missing = store.add(candidateInput(join(root, 'audio', 'never-written.wav'), { utteranceId: 'u3' }));
  assert.equal(missing.ok, true);
  const clearedMissing = store.clear();
  assert.equal(clearedMissing.ok, true);
  assert.equal(clearedMissing.removed, 1);
  assert.equal(clearedMissing.audioDeleted, 0);
  assert.equal(clearedMissing.audioFailed, 1);
});

// ---------------------------------------------------------------------------
// 8. Clustering
// ---------------------------------------------------------------------------

test('8. groups 按余弦 >=0.72 完整链接分组，报告候选/平均时长/时间范围，不分配身份', (t) => {
  const { store, audio } = setup(t);
  const add = (utteranceId, embedding, durationMs, offsetMs) => store.add(candidateInput(audio(), {
    utteranceId,
    embedding: new Float32Array(embedding),
    durationMs,
    at: T0 + offsetMs,
  }));
  const u1 = add('u1', [1, 0, 0], 1000, 0);
  const u2 = add('u2', [0.8, 0.6, 0], 3000, 1000);
  const u3 = add('u3', [0.6, 0.8, 0], 2000, 2000);
  const u4 = add('u4', [0, 1, 0], 4000, 3000);
  for (const result of [u1, u2, u3, u4]) assert.equal(result.ok, true);

  const groups = store.groups();
  assert.equal(groups.length, 2);
  const [first, second] = groups;
  assert.equal(first.groupId, 'group-1');
  assert.equal(first.size, 2);
  assert.deepEqual(first.candidateIds, [u1.candidate.id, u2.candidate.id]);
  assert.deepEqual(first.candidates.map((row) => row.id), [u1.candidate.id, u2.candidate.id]);
  assert.equal(first.totalDurationMs, 4000);
  assert.equal(first.averageDurationMs, 2000);
  assert.equal(first.from, new Date(T0).toISOString());
  assert.equal(first.to, new Date(T0 + 1000).toISOString());

  assert.equal(second.groupId, 'group-2');
  assert.equal(second.size, 2);
  // u3 cannot join u1/u2 (0.6 < 0.72 against u1), but u4 is 0.8 against u3.
  assert.deepEqual(second.candidateIds, [u3.candidate.id, u4.candidate.id]);
  assert.equal(second.averageDurationMs, 3000);
  assert.equal(second.from, new Date(T0 + 2000).toISOString());
  assert.equal(second.to, new Date(T0 + 3000).toISOString());

  for (const group of groups) {
    for (const row of group.candidates) {
      assert.equal(row.speakerId, null, 'grouping must never assign an identity');
      assert.equal(row.groupId, group.groupId);
    }
  }

  // groupId is persisted, but not speakerId.
  const listed = store.list();
  assert.deepEqual(listed.map((row) => row.groupId), ['group-1', 'group-1', 'group-2', 'group-2']);
  assert.deepEqual(listed.map((row) => row.speakerId), [null, null, null, null]);
  assert.equal(store.status().groupCount, 2);

  const strict = store.groups({ threshold: 0.99 });
  assert.equal(strict.length, 4, 'a high threshold splits each pair');
  assert.deepEqual(strict.map((group) => group.size), [1, 1, 1, 1]);
});

// ---------------------------------------------------------------------------
// 9. Corruption tolerance
// ---------------------------------------------------------------------------

test('9. 坏 embedding 行被跳过，groups/list 不抛错，后续写回自愈', (t) => {
  const { store, audio } = setup(t);
  const valid = store.add(candidateInput(audio()));
  assert.equal(valid.ok, true);
  const base = readMeta(store).candidates[0];

  const nanBytes = Buffer.alloc(4);
  nanBytes.writeFloatLE(Number.NaN, 0);
  const truncated = Buffer.from([1, 2]).toString('base64');
  const zero = Buffer.alloc(8).toString('base64');
  writeMeta(store, {
    version: SPEAKER_CANDIDATES_VERSION,
    updatedAt: new Date(T0).toISOString(),
    candidates: [
      base,
      badEmbedding(base, 'spc-2', 'u2', '!!!!'),
      badEmbedding(base, 'spc-3', 'u3', nanBytes.toString('base64')),
      badEmbedding(base, 'spc-4', 'u4', truncated),
      badEmbedding(base, 'spc-5', 'u5', zero),
      badEmbedding(base, 'spc-6', 'u6', 42),
    ],
  });

  const list = store.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, valid.candidate.id);
  const groups = store.groups();
  assert.equal(groups.length, 1);
  assert.equal(groups[0].size, 1);

  // groups() persists groupId through save(), which writes only normalized rows.
  const healed = readMeta(store);
  assert.equal(healed.candidates.length, 1);
  assert.equal(healed.candidates[0].id, valid.candidate.id);
  assert.equal(healed.candidates[0].groupId, 'group-1');
});

test('10. 坏 JSON / 错误版本 / 非对象根容错，下一次写回自愈', (t) => {
  const events = [];
  const { store, file, audio } = setup(t, { log: { emit: (event) => events.push(event) } });

  writeMeta(store, '{ this is not json');
  assert.deepEqual(store.list(), []);
  assert.deepEqual(store.list(), []);
  assert.equal(store.status().count, 0);
  assert.equal(existsSync(file), true, 'reading never deletes the corrupt file');
  assert.equal(events.filter((event) => event === 'speaker.candidates.corrupt').length, 1,
    'identical corruption is reported once');

  const recovered = store.add(candidateInput(audio()));
  assert.equal(recovered.ok, true);
  assert.equal(readMeta(store).candidates.length, 1);

  writeMeta(store, JSON.stringify({ version: 2, candidates: [] }));
  assert.deepEqual(store.list(), []);
  assert.equal(store.add(candidateInput(audio(), { utteranceId: 'u2' })).ok, true);
  assert.equal(readMeta(store).candidates.length, 1);

  writeMeta(store, JSON.stringify([]));
  assert.deepEqual(store.list(), []);
  assert.equal(store.add(candidateInput(audio(), { utteranceId: 'u3' })).ok, true);
  assert.equal(readMeta(store).candidates.length, 1);
});

// ---------------------------------------------------------------------------
// 11. Embedding helpers
// ---------------------------------------------------------------------------

test('11. embedding base64 可校验、可往返，坏向量为 null', () => {
  const original = new Float32Array([0.25, -0.5, 1.5]);
  const encoded = encodeEmbedding(original);
  assert.equal(typeof encoded, 'string');
  assert.equal(encodeEmbedding(new Float32Array([1, 0, 0])), 'AACAPwAAAAAAAAAA');
  const decoded = decodeEmbedding(encoded);
  assert.ok(decoded instanceof Float32Array);
  assert.deepEqual([...decoded], [...original]);

  assert.equal(encodeEmbedding([]), null);
  assert.equal(encodeEmbedding([1, Number.NaN]), null);
  assert.equal(encodeEmbedding([0, 0]), null);
  assert.equal(encodeEmbedding('AAAA'), null);
  assert.equal(decodeEmbedding(''), null);
  assert.equal(decodeEmbedding('!!!!'), null);
  assert.equal(decodeEmbedding('AACAPw'), null, 'base64 must be padded');
  assert.equal(decodeEmbedding('AQID'), null, '3 decoded bytes are not one float');
  const one = decodeEmbedding('AACAPw==');
  assert.ok(one instanceof Float32Array);
  assert.equal(one.length, 1);
  assert.equal(one[0], 1);
  assert.equal(decodeEmbedding(Buffer.alloc(8).toString('base64')), null, 'zero vector');
  assert.equal(decodeEmbedding(42), null);

  assert.equal(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([1, 0])), 1);
  assert.equal(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([0, 1])), 0);
  assert.equal(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([1])), 0);
  assert.equal(cosineSimilarity(null, new Float32Array([1])), 0);
});

test('12. 默认分组阈值是 0.72', () => {
  assert.equal(SPEAKER_CANDIDATE_GROUP_THRESHOLD, 0.72);
});
