/**
 * Speaker enrollment stage 1 — the file-backed enrollment state (pure module).
 *
 * The list mirrors the acceptance items:
 *   1. missing file → default state, reading creates nothing;
 *   2. samples are de-duplicated per speaker (same ref, and same timestamp for a no-ref sample);
 *   3. confirm below 3000 ms is refused with `insufficient-samples`; the entry stays pending;
 *   4. confirm is the explicit user action that sets confirmed/confirmedAt and getConfirmedSelf();
 *   5. reject is a tombstone: no confirmed view, selfId cleared, later samples refused;
 *   6. a failed atomic write leaves the old file byte-identical and no temp file behind;
 *   7. bad JSON/version/structure → default state + ONE corrupt event per identical content;
 *   8. a new store instance over the same root sees the same state (restart);
 *   9. stats returns sample count, total duration and source distribution;
 *  10. removeSample removes one row; removeEntry removes the entry;
 *  11. multiple speakerIds stay isolated;
 *  12. mergeSamples adds valid rows in one write and reports duplicates/invalid rows.
 *
 * There is deliberately no microphone, embedding, model, ASR or identity verdict here.
 *
 * Run: node --test test/speaker-enrollment.mjs
 */
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  ENROLLMENT_STATUS,
  MIN_CONFIRM_TOTAL_MS,
  SPEAKER_ENROLLMENT_PATH,
  createSpeakerEnrollmentState,
  createSpeakerEnrollmentStore,
} from '../src/host/hearing/speaker-enrollment.js';

const T0 = '2026-11-08T09:00:00+08:00';
const T1 = '2026-11-08T09:05:00+08:00';
const T2 = '2026-11-08T09:10:00+08:00';

const iso = (value) => new Date(value).toISOString();

/** Root removed after the test; a read-only enrollment file is made deletable first. */
function tempRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'seirein-speaker-enrollment-'));
  t.after(() => {
    try {
      chmodSync(join(root, SPEAKER_ENROLLMENT_PATH), 0o666);
    } catch {
      /* no file was written */
    }
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function collectingLog() {
  const events = [];
  return {
    events,
    emit(event, payload) {
      events.push({ event, ...payload });
      return Promise.resolve();
    },
    of(event) {
      return events.filter((item) => item.event === event);
    },
  };
}

/** A settable injected clock, so every stored timestamp is checkable. */
function makeClock(start) {
  let current = start;
  const clock = () => new Date(current);
  clock.set = (value) => {
    current = value;
  };
  return clock;
}

const dataFile = (root) => join(root, SPEAKER_ENROLLMENT_PATH);
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const tempFiles = (dir) => readdirSync(dir).filter((name) => name.endsWith('.tmp'));

/** One mic sample object for mergeSamples. */
function sample(ref, durationMs, extra = {}) {
  return { sampleRef: ref, durationMs, source: 'mic', ...extra };
}

// ---------------------------------------------------------------------------
// 1. Empty
// ---------------------------------------------------------------------------

test('1. 空文件 → 默认结构，读取不创建文件', (t) => {
  const root = tempRoot(t);
  const log = collectingLog();
  const store = createSpeakerEnrollmentStore({ root, log });

  assert.equal(store.file, dataFile(root));
  assert.equal(existsSync(store.file), false);
  assert.deepEqual(store.read(), createSpeakerEnrollmentState());
  assert.equal(existsSync(store.file), false, 'reading never creates the file');
  assert.deepEqual(store.list(), []);
  assert.equal(store.getConfirmedSelf(), null);
  assert.deepEqual(store.stats({ speakerId: 'nobody' }), {
    speakerId: 'nobody',
    found: false,
    label: '',
    status: null,
    sampleCount: 0,
    totalDurationMs: 0,
    sources: { mic: 0, loopback: 0 },
  });
  assert.deepEqual(log.events, [], 'reading a missing file is not corruption');

  console.log(`[1] file=${store.file} exists=${existsSync(store.file)} events=${log.events.length}`);
});

// ---------------------------------------------------------------------------
// 2. De-duplication
// ---------------------------------------------------------------------------

test('2. 添加样本去重：同 ref、同时间不重复；不同 ref 同时间保留', (t) => {
  const root = tempRoot(t);
  const log = collectingLog();
  const clock = makeClock(T0);
  const store = createSpeakerEnrollmentStore({ root, clock, log });

  const first = store.beginSample({
    speakerId: 'self',
    label: '我',
    durationMs: 1200,
    source: 'mic',
    sampleRef: 'clip-1',
  });
  assert.equal(first.ok, true);
  assert.equal(first.added, true);
  assert.equal(first.sample.id, 'smp-1');
  assert.equal(first.sample.sampleId, 'clip-1');
  assert.equal(first.sample.at, iso(T0));

  clock.set(T1);
  const repeatedRef = store.beginSample({
    speakerId: 'self',
    durationMs: 1200,
    source: 'mic',
    sampleRef: 'clip-1',
  });
  assert.equal(repeatedRef.ok, true);
  assert.equal(repeatedRef.added, false);
  assert.equal(repeatedRef.duplicate, true);
  assert.equal(repeatedRef.reason, 'duplicate-sample');

  clock.set(T2);
  const noRef = store.beginSample({ speakerId: 'self', durationMs: 500, source: 'mic' });
  assert.equal(noRef.added, true, 'a no-ref sample is keyed by its timestamp');
  const noRefAgain = store.beginSample({ speakerId: 'self', durationMs: 500, source: 'mic' });
  assert.equal(noRefAgain.added, false, 'the same timestamp is the same no-ref sample');
  assert.equal(noRefAgain.duplicate, true);

  const differentRef = store.beginSample({
    speakerId: 'self',
    durationMs: 700,
    source: 'mic',
    sampleRef: 'clip-2',
  });
  assert.equal(differentRef.added, true, 'a different ref at the same timestamp is distinct');

  const stats = store.stats({ speakerId: 'self' });
  assert.equal(stats.sampleCount, 3);
  assert.equal(stats.totalDurationMs, 2400);
  assert.equal(log.of('speaker.enroll.sample').length, 3, 'only real additions emit sample');

  console.log(`[2] added=3 deduped=2 count=${stats.sampleCount} total=${stats.totalDurationMs} events=${log.of('speaker.enroll.sample').length}`);
});

// ---------------------------------------------------------------------------
// 3. Insufficient samples
// ---------------------------------------------------------------------------

test('3. 样本不足（<3000ms）confirm 返回 insufficient-samples，保持 pending', (t) => {
  const root = tempRoot(t);
  const log = collectingLog();
  const store = createSpeakerEnrollmentStore({ root, log });
  store.beginSample({ speakerId: 'self', durationMs: 1000, source: 'mic', sampleRef: 'a' });
  store.beginSample({ speakerId: 'self', durationMs: 1500, source: 'mic', sampleRef: 'b' });

  const refused = store.confirm({ speakerId: 'self' });
  assert.deepEqual(refused, {
    ok: false,
    reason: 'insufficient-samples',
    sampleCount: 2,
    totalDurationMs: 2500,
    requiredMs: MIN_CONFIRM_TOTAL_MS,
  });
  const [entry] = store.list();
  assert.equal(entry.status, ENROLLMENT_STATUS.PENDING);
  assert.equal(entry.confirmedAt, null);
  assert.equal(store.getConfirmedSelf(), null, 'no automatic self confirmation');
  assert.equal(log.of('speaker.enroll.confirmed').length, 0);

  // Exactly the minimum is enough.
  store.beginSample({ speakerId: 'self', durationMs: 500, source: 'mic', sampleRef: 'c' });
  const accepted = store.confirm({ speakerId: 'self' });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.totalDurationMs, 3000);

  console.log(`[3] refused=${refused.reason} total=${refused.totalDurationMs}/${refused.requiredMs} then=${accepted.ok} total=${accepted.totalDurationMs}`);
});

// ---------------------------------------------------------------------------
// 4. Confirm
// ---------------------------------------------------------------------------

test('4. confirm 后 confirmed/confirmedAt 正确，getConfirmedSelf 可见；确认后拒收新样本', (t) => {
  const root = tempRoot(t);
  const clock = makeClock(T0);
  const log = collectingLog();
  const store = createSpeakerEnrollmentStore({ root, clock, log });
  store.beginSample({
    speakerId: 'self',
    label: '我',
    durationMs: 3000,
    source: 'mic',
    sampleRef: 'voice-1',
  });

  clock.set(T1);
  const confirmed = store.confirm({ speakerId: 'self' });
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.entry.status, ENROLLMENT_STATUS.CONFIRMED);
  assert.equal(confirmed.entry.confirmedAt, iso(T1));
  assert.equal(confirmed.entry.label, '我');
  assert.equal(store.read().selfId, 'self');

  const self = store.getConfirmedSelf();
  assert.equal(self.speakerId, 'self');
  assert.equal(self.status, ENROLLMENT_STATUS.CONFIRMED);
  assert.equal(store.list({ status: 'confirmed' }).length, 1);
  assert.equal(store.list({ status: 'pending' }).length, 0);
  assert.equal(log.of('speaker.enroll.confirmed').length, 1);

  const late = store.beginSample({ speakerId: 'self', durationMs: 1000, source: 'mic', sampleRef: 'late' });
  assert.deepEqual(late, { ok: false, reason: 'already-confirmed' });

  console.log(`[4] status=${self.status} confirmedAt=${self.confirmedAt} selfId=${store.read().selfId} late=${late.reason}`);
});

// ---------------------------------------------------------------------------
// 5. Reject
// ---------------------------------------------------------------------------

test('5. reject 后不出现在 confirmed/self；新样本不能复活', (t) => {
  const root = tempRoot(t);
  const log = collectingLog();
  const store = createSpeakerEnrollmentStore({ root, log });
  store.beginSample({ speakerId: 'self', durationMs: 3000, source: 'mic', sampleRef: 'a' });
  assert.equal(store.confirm({ speakerId: 'self' }).ok, true);

  const rejected = store.reject({ speakerId: 'self' });
  assert.equal(rejected.ok, true);
  assert.equal(rejected.entry.status, ENROLLMENT_STATUS.REJECTED);
  assert.equal(rejected.entry.confirmedAt, null);
  assert.equal(store.read().selfId, '');
  assert.equal(store.getConfirmedSelf(), null);
  assert.deepEqual(store.list({ status: 'confirmed' }), []);
  assert.equal(store.list({ status: 'rejected' }).length, 1);
  assert.deepEqual(store.list(), [], 'reject 后默认列表不出现（tombstone 只能显式查询）');

  const revived = store.beginSample({ speakerId: 'self', durationMs: 3000, source: 'mic', sampleRef: 'b' });
  assert.deepEqual(revived, { ok: false, reason: 'rejected' });
  assert.deepEqual(store.confirm({ speakerId: 'self' }), { ok: false, reason: 'rejected' });
  assert.equal(log.of('speaker.enroll.rejected').length, 1);

  console.log(`[5] status=${rejected.entry.status} selfId=${JSON.stringify(store.read().selfId)} revived=${revived.reason}`);
});

// ---------------------------------------------------------------------------
// 6. Atomic write failure
// ---------------------------------------------------------------------------

test('6. 原子写失败：旧文件逐字节不变，无临时文件残留', (t) => {
  const root = tempRoot(t);
  const store = createSpeakerEnrollmentStore({ root });
  store.beginSample({ speakerId: 'self', durationMs: 1200, source: 'mic', sampleRef: 'a' });
  const dataDir = join(root, 'data');
  const oldText = readFileSync(store.file, 'utf8');

  // Windows: chmod 0444 sets the read-only attribute; replacing the target then fails (EPERM).
  chmodSync(store.file, 0o444);
  const nextState = store.read();
  nextState.entries[0].label = '改过';
  assert.throws(() => store.write(nextState), /EPERM|EACCES|permission/i);
  assert.equal(readFileSync(store.file, 'utf8'), oldText, 'the published file is untouched');
  assert.deepEqual(tempFiles(dataDir), [], 'the temp file is cleaned up after a failed rename');
  chmodSync(store.file, 0o666);

  // A malformed state is refused before any file operation.
  assert.throws(() => store.write({ version: 1 }), TypeError);
  assert.throws(() => store.write({ version: 2, entries: [] }), TypeError);
  assert.equal(readFileSync(store.file, 'utf8'), oldText);
  assert.deepEqual(tempFiles(dataDir), []);

  // Once writable again the same call succeeds, so nothing was corrupted by the failures.
  const recovered = store.write(store.read());
  assert.equal(recovered.updatedAt.length > 0, true);
  assert.equal(readJson(store.file).version, 1);

  console.log(`[6] old-bytes=${oldText.length} tmp-after-failure=${tempFiles(dataDir).length} recovered=${JSON.stringify(recovered.entries[0].label)}`);
});

// ---------------------------------------------------------------------------
// 7. Corruption
// ---------------------------------------------------------------------------

test('7. 坏 JSON/版本/结构 → 回退默认并只记一次 corrupt', (t) => {
  const root = tempRoot(t);
  const log = collectingLog();
  const store = createSpeakerEnrollmentStore({ root, log });
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });

  const badJson = '{ 不是 json';
  writeFileSync(store.file, badJson, 'utf8');
  assert.deepEqual(store.read(), createSpeakerEnrollmentState());
  assert.equal(log.of('speaker.enroll.corrupt').length, 1);
  assert.equal(log.of('speaker.enroll.corrupt')[0].file, store.file);
  assert.ok(log.of('speaker.enroll.corrupt')[0].error.length > 0);

  assert.deepEqual(store.read(), createSpeakerEnrollmentState());
  assert.equal(log.of('speaker.enroll.corrupt').length, 1, 'identical corrupt content is reported once');

  writeFileSync(store.file, '{"version":2,"entries":[]}', 'utf8');
  assert.deepEqual(store.read(), createSpeakerEnrollmentState());
  assert.equal(log.of('speaker.enroll.corrupt').length, 2, 'a different bad version is a new event');

  writeFileSync(store.file, '{"version":1,"entries":[{"speakerId":"self","samples":{}}]}', 'utf8');
  assert.deepEqual(store.read(), createSpeakerEnrollmentState());
  assert.equal(log.of('speaker.enroll.corrupt').length, 3, 'bad entry structure is corrupt');

  // A successful write resets the guard, so the same corrupt content can be reported again later.
  store.write(createSpeakerEnrollmentState());
  assert.equal(log.of('speaker.enroll.corrupt').length, 3);
  writeFileSync(store.file, badJson, 'utf8');
  assert.deepEqual(store.read(), createSpeakerEnrollmentState());
  assert.equal(log.of('speaker.enroll.corrupt').length, 4);

  console.log(`[7] corrupt-events=${JSON.stringify(log.of('speaker.enroll.corrupt').map((item) => item.error))}`);
});

// ---------------------------------------------------------------------------
// 8. Restart
// ---------------------------------------------------------------------------

test('8. 重启（新 store 实例读同一文件）状态保持', (t) => {
  const root = tempRoot(t);
  const clock = makeClock(T0);
  const first = createSpeakerEnrollmentStore({ root, clock });
  first.beginSample({ speakerId: 'self', label: '我', durationMs: 1500, source: 'mic', sampleRef: 'a' });
  first.beginSample({ speakerId: 'self', durationMs: 1500, source: 'mic', sampleRef: 'b' });
  assert.equal(first.confirm({ speakerId: 'self' }).ok, true);

  const second = createSpeakerEnrollmentStore({ root, clock });
  const state = second.read();
  assert.equal(state.selfId, 'self');
  assert.equal(state.entries.length, 1);
  assert.equal(state.entries[0].status, ENROLLMENT_STATUS.CONFIRMED);
  assert.equal(state.entries[0].samples.length, 2);
  assert.equal(second.getConfirmedSelf().speakerId, 'self');
  assert.equal(second.stats({ speakerId: 'self' }).totalDurationMs, 3000);

  console.log(`[8] restart selfId=${state.selfId} status=${state.entries[0].status} samples=${state.entries[0].samples.length} total=${second.stats({ speakerId: 'self' }).totalDurationMs}`);
});

// ---------------------------------------------------------------------------
// 9. Stats
// ---------------------------------------------------------------------------

test('9. stats：样本数 / 总时长 / 来源分布正确', (t) => {
  const root = tempRoot(t);
  const clock = makeClock(T0);
  const store = createSpeakerEnrollmentStore({ root, clock });
  store.beginSample({ speakerId: 'self', label: '我', durationMs: 1000, source: 'mic', sampleRef: 'm1' });
  clock.set(T1);
  store.beginSample({ speakerId: 'self', durationMs: 2000, source: 'mic', sampleRef: 'm2' });
  clock.set(T2);
  store.beginSample({ speakerId: 'self', durationMs: 500, source: 'loopback', sampleRef: 'l1' });

  assert.deepEqual(store.stats({ speakerId: 'self' }), {
    speakerId: 'self',
    found: true,
    label: '我',
    status: ENROLLMENT_STATUS.PENDING,
    sampleCount: 3,
    totalDurationMs: 3500,
    sources: { mic: 2, loopback: 1 },
  });
  const missing = store.stats({ speakerId: 'other' });
  assert.equal(missing.found, false);
  assert.equal(missing.sampleCount, 0);

  console.log(`[9] count=${3} total=${3500} sources=${JSON.stringify({ mic: 2, loopback: 1 })} missingFound=${missing.found}`);
});

// ---------------------------------------------------------------------------
// 10. Remove
// ---------------------------------------------------------------------------

test('10. 删除样本/条目：按 id 或 ref 删除，removeEntry 清空条目', (t) => {
  const root = tempRoot(t);
  const log = collectingLog();
  const store = createSpeakerEnrollmentStore({ root, log });
  const first = store.beginSample({ speakerId: 'self', durationMs: 1000, source: 'mic', sampleRef: 'clip-a' });
  store.beginSample({ speakerId: 'self', durationMs: 2000, source: 'mic', sampleRef: 'clip-b' });

  const byId = store.removeSample({ speakerId: 'self', sampleId: first.sample.id });
  assert.equal(byId.ok, true);
  assert.equal(byId.entry.samples.length, 1);
  const byRef = store.removeSample({ speakerId: 'self', sampleId: 'clip-b' });
  assert.equal(byRef.ok, true);
  assert.equal(byRef.entry.samples.length, 0);
  assert.equal(store.stats({ speakerId: 'self' }).totalDurationMs, 0);

  assert.deepEqual(store.removeSample({ speakerId: 'self', sampleId: 'missing' }), {
    ok: false,
    reason: 'sample-not-found',
  });
  const removed = store.removeEntry({ speakerId: 'self' });
  assert.equal(removed.ok, true);
  assert.deepEqual(store.list(), []);
  assert.equal(store.getConfirmedSelf(), null);
  assert.equal(log.of('speaker.enroll.removed').length, 3, 'two samples + one entry');

  console.log(`[10] afterSamples=${byRef.entry.samples.length} removedEntry=${removed.ok} list=${store.list().length} removedEvents=${log.of('speaker.enroll.removed').length}`);
});

// ---------------------------------------------------------------------------
// 11. Isolation
// ---------------------------------------------------------------------------

test('11. 多个 speakerId 隔离：确认/拒绝/样本互不影响', (t) => {
  const root = tempRoot(t);
  const log = collectingLog();
  const store = createSpeakerEnrollmentStore({ root, log });
  store.beginSample({ speakerId: 'alice', label: '我', durationMs: 3000, source: 'mic', sampleRef: 'shared' });
  store.beginSample({ speakerId: 'bob', label: '他', durationMs: 1500, source: 'mic', sampleRef: 'shared' });
  assert.equal(store.stats({ speakerId: 'alice' }).sampleCount, 1, 'same ref is allowed across speakers');
  assert.equal(store.stats({ speakerId: 'bob' }).sampleCount, 1);

  assert.equal(store.confirm({ speakerId: 'alice' }).ok, true);
  assert.equal(store.getConfirmedSelf().speakerId, 'alice');
  assert.equal(store.stats({ speakerId: 'bob' }).status, ENROLLMENT_STATUS.PENDING);
  assert.deepEqual(store.confirm({ speakerId: 'bob' }), {
    ok: false,
    reason: 'insufficient-samples',
    sampleCount: 1,
    totalDurationMs: 1500,
    requiredMs: MIN_CONFIRM_TOTAL_MS,
  });

  assert.equal(store.reject({ speakerId: 'bob' }).ok, true);
  assert.equal(store.getConfirmedSelf().speakerId, 'alice', 'rejecting another speaker keeps self');
  assert.equal(store.stats({ speakerId: 'alice' }).status, ENROLLMENT_STATUS.CONFIRMED);
  assert.equal(store.list({ status: 'rejected' }).length, 1);

  store.removeEntry({ speakerId: 'bob' });
  assert.equal(store.list().length, 1);
  assert.equal(store.getConfirmedSelf().speakerId, 'alice');

  console.log(`[11] self=${store.getConfirmedSelf().speakerId} aliceStatus=${store.stats({ speakerId: 'alice' }).status} bob=${store.stats({ speakerId: 'bob' }).found} list=${store.list().length}`);
});

// ---------------------------------------------------------------------------
// 12. Batch merge
// ---------------------------------------------------------------------------

test('12. mergeSamples 批量：一次写入，报告 added/skipped/duplicates/invalid', (t) => {
  const root = tempRoot(t);
  const clock = makeClock(T0);
  const log = collectingLog();
  const store = createSpeakerEnrollmentStore({ root, clock, log });

  const merged = store.mergeSamples({
    speakerId: 'self',
    samples: [
      sample('m1', 1000),
      sample('m1', 1000), // duplicate ref
      sample('m2', 2000, { source: 'loopback' }),
      { durationMs: -5, source: 'mic' }, // invalid duration
      { durationMs: 500, source: 'speaker' }, // invalid source
    ],
  });
  assert.equal(merged.ok, true);
  assert.equal(merged.added, 2);
  assert.equal(merged.skipped, 3);
  assert.equal(merged.duplicates, 1);
  assert.equal(merged.invalid, 2);
  assert.equal(merged.samples.length, 2);
  assert.equal(store.stats({ speakerId: 'self' }).totalDurationMs, 3000);
  assert.equal(log.of('speaker.enroll.sample').length, 2);

  // A second batch with only invalid/duplicate rows performs no write and adds nothing.
  const noop = store.mergeSamples({ speakerId: 'self', samples: [sample('m1', 1000), { durationMs: 0 }] });
  assert.equal(noop.added, 0);
  assert.equal(store.stats({ speakerId: 'self' }).sampleCount, 2);

  console.log(`[12] added=${merged.added} skipped=${merged.skipped} duplicates=${merged.duplicates} invalid=${merged.invalid} total=${store.stats({ speakerId: 'self' }).totalDurationMs}`);
});
