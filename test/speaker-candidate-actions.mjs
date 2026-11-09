/**
 * Speaker-candidate actions — the safe seam between the candidate cache and the template builder.
 *
 * Acceptance items mirrored below:
 *   1. `list()` exposes exactly the eight safe fields; embedding / audioPath / root never leak;
 *   2. `audio()` returns WAV base64 within the 1 MiB cap, with `audio-missing` for a missing file;
 *   3. an over-cap file is refused without base64 and without a path, including the exact boundary;
 *   4. `remove()` / `clear()` delegate to the store and report counts + audio deletion without
 *      echoing the removed row;
 *   5. `preview()` builds a consistent template from decoded embeddings, returns evidence/dimension
 *      and omits the vector by default; an explicit host opt-in may return it as plain numbers;
 *   6. an inconsistent set is refused with `minPairCosine`/`outlierIds`, one candidate is allowed
 *      as `low-sample`, and no success writes the store or the audio files;
 *   7. empty/duplicate/too-many/bad ids and a missing or corrupt embedding return explicit reasons;
 *   8. list/audio/preview are read-only: the metadata and audio bytes are unchanged afterwards.
 *
 * No model, network, speaker library, `self`, GUI or Host is involved.
 *
 * Run: node --test test/speaker-candidate-actions.mjs
 */
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import test from 'node:test';

import {
  SPEAKER_CANDIDATE_MAX_AUDIO_BYTES,
  SPEAKER_CANDIDATE_PREVIEW_MAX_IDS,
  SPEAKER_CANDIDATE_SAFE_VIEW_FIELDS,
  createSpeakerCandidateActions,
} from '../src/host/hearing/speaker-candidate-actions.js';
import { createSpeakerCandidatesStore } from '../src/host/hearing/speaker-candidates.js';
import { buildSpeakerTemplate } from '../src/host/hearing/speaker-template.js';

const T0 = Date.parse('2026-11-10T00:00:00.000Z');
const TOLERANCE = 1e-6;

function close(actual, expected, message, tolerance = TOLERANCE) {
  assert.ok(
    Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance,
    `${message}: expected ${expected}, got ${actual}`,
  );
}

function unit(values) {
  let sum = 0;
  for (const value of values) sum += value * value;
  const scale = 1 / Math.sqrt(sum);
  return values.map((value) => value * scale);
}

function vectorClose(actual, expected, message, tolerance = TOLERANCE) {
  assert.equal(actual.length, expected.length, `${message}: length`);
  for (let index = 0; index < expected.length; index += 1) {
    close(actual[index], expected[index], `${message}[${index}]`, tolerance);
  }
}

/** Every string reachable from a result; used to prove no absolute path crossed the seam. */
function stringsOf(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) {
    for (const entry of value) stringsOf(entry, out);
  } else if (value !== null && typeof value === 'object') {
    for (const entry of Object.values(value)) stringsOf(entry, out);
  }
  return out;
}

function assertNoPathLeak(value, root, label) {
  for (const entry of stringsOf(value)) {
    assert.ok(!entry.includes(root), `${label}: result leaked the store root: ${entry}`);
  }
}

/** A content snapshot of the temp root, so a read can prove it wrote nothing. */
function snapshotTree(root) {
  const entries = new Map();
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        entries.set(`${relative(root, path)}/`, 'dir');
        walk(path);
      } else if (entry.isFile()) {
        entries.set(relative(root, path), readFileSync(path).toString('base64'));
      }
    }
  };
  walk(root);
  return entries;
}

/** One temp root, a real file-backed candidate store, and the actions over it. */
function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'seirein-speaker-candidate-actions-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const audioDir = join(root, 'audio');
  mkdirSync(audioDir, { recursive: true });
  let now = T0;
  let audioSeq = 0;
  let utteranceSeq = 0;
  const store = createSpeakerCandidatesStore({ root, clock: () => new Date(now) });
  const actions = createSpeakerCandidateActions({ store });

  const audioFile = (bytes = 400, fill = 0x5a) => {
    audioSeq += 1;
    const path = join(audioDir, `clip-${audioSeq}.wav`);
    writeFileSync(path, Buffer.alloc(bytes, fill));
    return path;
  };

  const add = ({
    embedding = new Float32Array([1, 0, 0]),
    durationMs = 1000,
    audioPath = null,
    utteranceId = null,
    text = '',
  } = {}) => {
    utteranceSeq += 1;
    const result = store.add({
      utteranceId: utteranceId ?? `utt-${utteranceSeq}`,
      embedding,
      durationMs,
      audioPath: audioPath ?? audioFile(),
      text,
    });
    assert.equal(result.ok, true, `candidate add failed: ${result.reason ?? ''}`);
    return result.candidate;
  };

  return {
    root,
    audioDir,
    store,
    actions,
    add,
    audioFile,
    advance: (ms) => { now += ms; },
  };
}

/** A candidate-shaped row for a test double that bypasses store normalization. */
function fakeRow(overrides = {}) {
  return {
    id: 'spc-1',
    utteranceId: 'utt-fake',
    embedding: '',
    durationMs: 1000,
    at: new Date(T0).toISOString(),
    source: 'mic',
    quality: 'ok',
    text: '',
    audioPath: '',
    status: 'pending',
    speakerId: null,
    groupId: null,
    ...overrides,
  };
}

function fakeStore(rows, root) {
  return {
    file: join(root, 'data', 'speaker-candidates.json'),
    list: () => rows,
    remove: () => ({ ok: false, reason: 'not-found' }),
    clear: () => ({ ok: true, removed: 0, audioDeleted: 0, audioFailed: 0 }),
  };
}

// ---------------------------------------------------------------------------
// 1. Safe list view
// ---------------------------------------------------------------------------

test('1. list 只返回八字段安全视图，不泄 embedding/audioPath/根路径', (t) => {
  const { actions, add, root } = setup(t);
  const first = add({ text: ' 你好 ', durationMs: 1200 });
  const second = add({ embedding: new Float32Array([0.9, 0.1, 0]), durationMs: 2400 });

  const result = actions.list();
  assert.equal(result.ok, true);
  assert.equal(result.count, 2);
  assert.equal(result.candidates.length, 2);
  assert.deepEqual(
    result.candidates.map((candidate) => candidate.id),
    [first.id, second.id],
    'oldest-first order from the store',
  );

  const expectedKeys = [...SPEAKER_CANDIDATE_SAFE_VIEW_FIELDS].sort();
  for (const view of result.candidates) {
    assert.deepEqual(Object.keys(view).sort(), expectedKeys, 'exactly the safe fields');
    assert.equal(view.audioAvailable, true);
    assert.equal('embedding' in view, false);
    assert.equal('audioPath' in view, false);
    assert.equal('source' in view, false);
    assert.equal('quality' in view, false);
    assert.equal('status' in view, false);
  }
  assert.equal(result.candidates[0].text, '你好');
  assert.equal(result.candidates[0].durationMs, 1200);
  assert.equal(result.candidates[0].groupId, null);
  assert.equal(result.candidates[0].speakerId, null);
  assert.match(result.candidates[0].at, /^\d{4}-\d{2}-\d{2}T/u);

  assertNoPathLeak(result, root, 'list');
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(first.embedding), false, 'base64 embedding must not leak');

  // Missing audio is visible as a boolean, never as a path or an exception.
  unlinkSync(first.audioPath);
  const afterMissing = actions.list();
  assert.equal(afterMissing.candidates[0].id, first.id);
  assert.equal(afterMissing.candidates[0].audioAvailable, false);
  assertNoPathLeak(afterMissing, root, 'list after missing audio');
});

// ---------------------------------------------------------------------------
// 2. Audio read
// ---------------------------------------------------------------------------

test('2. audio 返回 WAV base64；缺失/不存在/坏 id 有明确 reason 且不泄路径', (t) => {
  const { actions, add, root, audioDir } = setup(t);
  const bytes = Buffer.concat([Buffer.alloc(44, 0x52), Buffer.alloc(64, 0x7f)]);
  const path = join(audioDir, 'known.wav');
  writeFileSync(path, bytes);
  const candidate = add({ audioPath: path });

  const result = actions.audio(candidate.id);
  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result).sort(), ['base64', 'bytes', 'mime', 'ok']);
  assert.equal(result.mime, 'audio/wav');
  assert.equal(result.bytes, bytes.length);
  assert.deepEqual(Buffer.from(result.base64, 'base64'), bytes);
  assert.equal('audioPath' in result, false);
  assertNoPathLeak(result, root, 'audio');
  assert.equal(JSON.stringify(result).includes(bytes.toString('base64')), true);

  unlinkSync(path);
  const missing = actions.audio(candidate.id);
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'audio-missing');
  assertNoPathLeak(missing, root, 'audio missing');

  const notFound = actions.audio('spc-999');
  assert.equal(notFound.ok, false);
  assert.equal(notFound.reason, 'not-found');
  assertNoPathLeak(notFound, root, 'audio not found');

  for (const bad of ['', '   ', null, undefined]) {
    const rejected = actions.audio(bad);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.reason, 'id-required');
  }
});

// ---------------------------------------------------------------------------
// 3. Audio cap
// ---------------------------------------------------------------------------

test('3. audio 严格限制 1 MiB：恰好上限可读，超 1 字节拒绝且无 base64', (t) => {
  const { actions, add, root } = setup(t);
  const atLimit = add({
    audioPath: null,
  });
  // Replace the helper's small clip with an exactly-at-cap file to test the boundary.
  writeFileSync(atLimit.audioPath, Buffer.alloc(SPEAKER_CANDIDATE_MAX_AUDIO_BYTES, 0x11));
  const accepted = actions.audio(atLimit.id);
  assert.equal(accepted.ok, true);
  assert.equal(accepted.bytes, SPEAKER_CANDIDATE_MAX_AUDIO_BYTES);
  assert.equal(Buffer.from(accepted.base64, 'base64').length, SPEAKER_CANDIDATE_MAX_AUDIO_BYTES);

  const overPath = join(root, 'over.wav');
  writeFileSync(overPath, Buffer.alloc(SPEAKER_CANDIDATE_MAX_AUDIO_BYTES + 1, 0x22));
  const over = add({ audioPath: overPath });
  const rejected = actions.audio(over.id);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, 'audio-too-large');
  assert.equal(rejected.bytes, SPEAKER_CANDIDATE_MAX_AUDIO_BYTES + 1);
  assert.equal(rejected.maxBytes, SPEAKER_CANDIDATE_MAX_AUDIO_BYTES);
  assert.equal('base64' in rejected, false);
  assertNoPathLeak(rejected, root, 'audio too large');
});

// ---------------------------------------------------------------------------
// 4. remove
// ---------------------------------------------------------------------------

test('4. remove 委托 store，返回删除计数/音频结果且不回显行', (t) => {
  const { actions, add, store, root } = setup(t);
  const first = add();
  const second = add();
  assert.equal(existsSync(first.audioPath), true);

  const removed = actions.remove(first.id);
  assert.equal(removed.ok, true);
  assert.deepEqual(Object.keys(removed).sort(), [
    'audioDeleted',
    'audioFailed',
    'id',
    'ok',
    'removed',
  ]);
  assert.equal(removed.id, first.id);
  assert.equal(removed.removed, 1);
  assert.equal(removed.audioDeleted, true);
  assert.equal(removed.audioFailed, false);
  assert.equal(existsSync(first.audioPath), false, 'audio file unlinked');
  assert.equal('candidate' in removed, false);
  assert.equal('audioPath' in removed, false);
  assertNoPathLeak(removed, root, 'remove');
  assert.deepEqual(store.list().map((candidate) => candidate.id), [second.id]);

  const again = actions.remove(first.id);
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'not-found');
  for (const bad of ['', null]) {
    const rejected = actions.remove(bad);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.reason, 'id-required');
  }

  // A metadata row whose audio is already gone is still removable; the failure is reported.
  const missingAudio = add();
  unlinkSync(missingAudio.audioPath);
  const afterMissing = actions.remove(missingAudio.id);
  assert.equal(afterMissing.ok, true);
  assert.equal(afterMissing.removed, 1);
  assert.equal(afterMissing.audioDeleted, false);
  assert.equal(afterMissing.audioFailed, true);
  assert.deepEqual(store.list().map((candidate) => candidate.id), [second.id]);
});

// ---------------------------------------------------------------------------
// 5. clear
// ---------------------------------------------------------------------------

test('5. clear 委托 store，清空元数据并删除音频', (t) => {
  const { actions, add, store, root } = setup(t);
  const first = add();
  const second = add();
  const filesBefore = [first.audioPath, second.audioPath];
  for (const path of filesBefore) assert.equal(existsSync(path), true);

  const cleared = actions.clear();
  assert.equal(cleared.ok, true);
  assert.deepEqual(Object.keys(cleared).sort(), ['audioDeleted', 'audioFailed', 'ok', 'removed']);
  assert.equal(cleared.removed, 2);
  assert.equal(cleared.audioDeleted, 2);
  assert.equal(cleared.audioFailed, 0);
  assertNoPathLeak(cleared, root, 'clear');
  for (const path of filesBefore) assert.equal(existsSync(path), false, 'audio file unlinked');
  assert.deepEqual(store.list(), []);

  const empty = actions.clear();
  assert.equal(empty.ok, true);
  assert.equal(empty.removed, 0);
  assert.equal(empty.audioDeleted, 0);
});

// ---------------------------------------------------------------------------
// 6. preview: consistent / injected builder / vector opt-in
// ---------------------------------------------------------------------------

test('6. preview 一致集合返回证据与维度，默认不返回向量且不写库', (t) => {
  const { actions, add, root } = setup(t);
  const first = add({ embedding: new Float32Array([1, 0, 0]), durationMs: 1000 });
  const second = add({ embedding: new Float32Array([0.8, 0.6, 0]), durationMs: 3000 });
  const before = snapshotTree(root);

  const result = actions.preview([first.id, second.id, second.id]);
  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result).sort(), [
    'confidence',
    'dimension',
    'minPairCosine',
    'ok',
    'sampleCount',
    'totalDurationMs',
  ]);
  assert.equal(result.sampleCount, 2, 'duplicate ids are de-duplicated');
  assert.equal(result.totalDurationMs, 4000);
  assert.equal(result.dimension, 3);
  assert.equal(result.confidence, 'ok');
  close(result.minPairCosine, 0.8, 'pair cosine');
  assert.equal('vector' in result, false, 'embedding/template vector is not a UI field');
  assert.equal(JSON.stringify(result).includes(first.embedding), false);
  assertNoPathLeak(result, root, 'preview');
  assert.deepEqual(snapshotTree(root), before, 'preview must not write metadata or audio');

  // Explicit host-only opt-in returns a plain copy, never the internal Float32Array.
  const withVector = actions.preview([first.id, second.id], { includeVector: true });
  assert.equal(withVector.ok, true);
  assert.ok(Array.isArray(withVector.vector));
  assert.equal(withVector.vector.length, 3);
  close(Math.sqrt(withVector.vector.reduce((sum, value) => sum + value * value, 0)), 1, 'unit norm');
  vectorClose(withVector.vector, unit([0.85, 0.45, 0]), 'duration-weighted unit vector');
  assert.deepEqual(snapshotTree(root), before, 'the opt-in must still not write');

  // The injected builder receives fresh Float32Arrays and only the fields it needs.
  const calls = [];
  const spy = createSpeakerCandidateActions({
    store: {
      file: join(root, 'data', 'speaker-candidates.json'),
      list: () => [
        { ...fakeRow({ id: first.id, embedding: first.embedding }) },
        { ...fakeRow({ id: second.id, embedding: second.embedding }) },
      ],
      remove: () => ({ ok: false, reason: 'not-found' }),
      clear: () => ({ ok: true, removed: 0, audioDeleted: 0, audioFailed: 0 }),
    },
    buildTemplate: (candidates, options) => {
      calls.push({ candidates, options });
      return buildSpeakerTemplate(candidates, options);
    },
  });
  const spied = spy.preview([first.id, second.id], { threshold: 0.5 });
  assert.equal(spied.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.threshold, 0.5);
  assert.equal(calls[0].candidates.length, 2);
  for (const entry of calls[0].candidates) {
    assert.ok(entry.embedding instanceof Float32Array);
    assert.deepEqual(Object.keys(entry).sort(), ['durationMs', 'embedding', 'id']);
  }
});

// ---------------------------------------------------------------------------
// 7. preview: inconsistent / low sample / threshold
// ---------------------------------------------------------------------------

test('7. preview 不一致拒绝并给 minPairCosine/outlierIds；低样本允许', (t) => {
  const { actions, add } = setup(t);
  const positive = add({ embedding: new Float32Array([1, 0, 0]) });
  const negative = add({ embedding: new Float32Array([-1, 0, 0]) });

  const inconsistent = actions.preview([positive.id, negative.id]);
  assert.equal(inconsistent.ok, false);
  assert.equal(inconsistent.reason, 'inconsistent');
  close(inconsistent.minPairCosine, -1, 'opposite pair cosine');
  assert.deepEqual(inconsistent.outlierIds, [positive.id, negative.id]);
  assert.equal(inconsistent.sampleCount, 2);
  assert.equal(inconsistent.totalDurationMs, 2000);
  assert.equal(inconsistent.dimension, 3);
  assert.equal('vector' in inconsistent, false);

  // The floor is forwarded to the template builder: a pair below 0.72 but not opposite is
  // refused by default and accepted once the caller lowers the floor.
  const mixed = add({ embedding: new Float32Array([0.6, 0.8, 0]) });
  const defaultReject = actions.preview([positive.id, mixed.id]);
  assert.equal(defaultReject.ok, false);
  assert.equal(defaultReject.reason, 'inconsistent');
  close(defaultReject.minPairCosine, 0.6, 'default floor cosine');

  const permissive = actions.preview([positive.id, mixed.id], { threshold: 0.5 });
  assert.equal(permissive.ok, true);
  assert.equal(permissive.confidence, 'ok');
  close(permissive.minPairCosine, 0.6, 'permissive floor cosine');

  const lone = actions.preview([positive.id]);
  assert.equal(lone.ok, true);
  assert.equal(lone.sampleCount, 1);
  assert.equal(lone.totalDurationMs, 1000);
  assert.equal(lone.minPairCosine, 1);
  assert.equal(lone.confidence, 'low-sample');
  assert.equal(lone.dimension, 3);
  assert.equal('vector' in lone, false);
});

// ---------------------------------------------------------------------------
// 8. preview: id validation and missing/corrupt embedding
// ---------------------------------------------------------------------------

test('8. preview 校验 ids：空/非数组/坏 id/超 20/不存在均有明确 reason', (t) => {
  const { actions, add } = setup(t);
  const candidate = add();

  const cases = [
    [[], 'no-ids'],
    [null, 'invalid-ids'],
    ['spc-1', 'invalid-ids'],
    [[''], 'invalid-id'],
    [['   '], 'invalid-id'],
    [[1], 'invalid-id'],
    [[null], 'invalid-id'],
    [Array.from({ length: SPEAKER_CANDIDATE_PREVIEW_MAX_IDS + 1 }, (_, index) => `spc-${index + 1}`), 'too-many-ids'],
  ];
  for (const [input, reason] of cases) {
    const rejected = actions.preview(input);
    assert.equal(rejected.ok, false, `expected rejection for ${JSON.stringify(input)}`);
    assert.equal(rejected.reason, reason);
  }
  assert.equal(actions.preview(Array.from(
    { length: SPEAKER_CANDIDATE_PREVIEW_MAX_IDS },
    (_, index) => `spc-${index + 1}`,
  )).reason, 'candidate-not-found', 'exactly 20 unique ids is allowed past validation');

  const notFound = actions.preview(['spc-999']);
  assert.equal(notFound.ok, false);
  assert.equal(notFound.reason, 'candidate-not-found');
  assert.equal(notFound.id, 'spc-999');

  // Duplicate ids collapse before the cap and before the builder sees them.
  const duplicate = actions.preview([candidate.id, candidate.id]);
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.sampleCount, 1);
});

test('8b. preview 对缺失/损坏 embedding 返回 missing-embedding / invalid-embedding', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'seirein-speaker-candidate-actions-fake-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const missing = createSpeakerCandidateActions({
    store: fakeStore([fakeRow({ embedding: '' })], root),
  });
  const missingResult = missing.preview(['spc-1']);
  assert.equal(missingResult.ok, false);
  assert.equal(missingResult.reason, 'missing-embedding');
  assert.equal(missingResult.id, 'spc-1');

  const corrupt = createSpeakerCandidateActions({
    store: fakeStore([fakeRow({ embedding: 'not-base64!!' })], root),
  });
  const corruptResult = corrupt.preview(['spc-1']);
  assert.equal(corruptResult.ok, false);
  assert.equal(corruptResult.reason, 'invalid-embedding');
  assert.equal(corruptResult.id, 'spc-1');
});

// ---------------------------------------------------------------------------
// 9. Read-only guarantee for every read action
// ---------------------------------------------------------------------------

test('9. list/audio/preview 只读：元数据与音频字节均不变', (t) => {
  const { actions, add, root, store } = setup(t);
  const candidate = add({ text: '只读检查' });
  const before = snapshotTree(root);
  const metadataBefore = readFileSync(store.file, 'utf8');
  const audioBefore = readFileSync(candidate.audioPath);

  assert.equal(actions.list().ok, true);
  assert.equal(actions.audio(candidate.id).ok, true);
  assert.equal(actions.preview([candidate.id]).ok, true);

  assert.equal(readFileSync(store.file, 'utf8'), metadataBefore);
  assert.deepEqual(readFileSync(candidate.audioPath), audioBefore);
  assert.deepEqual(snapshotTree(root), before);
  assert.equal(statSync(candidate.audioPath).size, audioBefore.length);
});
