/**
 * Audio retention — opt-in, short-lived diagnosis clips (default OFF).
 *
 * The feature answers one question the text row cannot: was a strange trigger a device problem, an
 * acoustic echo, or an ASR hallucination? It must never become a recorder, so the suite pins:
 *  1. the switch off ⇒ zero files, zero index, zero retained rows — including a capture session
 *     built with the switch explicitly off;
 *  2. switch on ⇒ one suspicious fragment writes exactly one 16 kHz mono 16-bit WAV plus one index
 *     entry carrying time / utteranceId / rms / vad / text / reason / bytes, and one
 *     `hearing.audio.retained { utteranceId, bytes, reason }` row;
 *  3. over the cap ⇒ FIFO, oldest first, and one `hearing.audio.pruned { count }` debug row;
 *  4. `deleteOne` / `deleteAll` really remove the audio; a file deleted outside the store stays
 *     listed as `missing`; `exportPath` returns a path (never audio through an event);
 *  5. the privacy lock refuses the write (no file, no entry, no row);
 *  6. expiry is a throttled lazy pass, not a one-shot: a clip older than `maxAgeMs` is deleted (and
 *     its `.wav` removed, plus one pruned row) on the next `retain()` / `list()` / `exportPath()`
 *     once `cleanupIntervalMs` has passed, and not before; a restart (a new store on the same root)
 *     cleans on its first read, and `cleanupOnce()` is repeatable but throttled;
 *  7. the settings actions: the switch persists and follows live, `list` has no audio bytes,
 *     `delete` takes `{id}` or `{all}`, `export` returns the file path.
 *
 * No microphone, ffmpeg, sherpa model or real thread: the child process, the streaming recognizer,
 * the VAD and the worker are fakes (same harness as `noise-shadow.mjs`).
 *
 * Run: node --test test/audio-retention.mjs
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_RETENTION_LIMITS,
  RETENTION_CLEANUP_INTERVAL_MS,
  RETENTION_SAMPLE_RATE,
  createAudioRetention,
  encodeWav16,
  retentionReasonOf,
  retentionVerdictOf,
} from '../src/host/hearing/audio-retention.js';
import { createHearingSettingsActions } from '../src/host/hearing/settings-actions.js';
import { parseUtteranceId, startHearing } from '../src/host/hearing/hearing.js';
import { cleanupRoot } from './helpers/cleanup.mjs';

const SAMPLE_RATE = RETENTION_SAMPLE_RATE;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until `predicate()` is true; a missed deadline fails the test instead of hanging it. */
async function until(predicate, timeoutMs = 3000) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('timed out waiting for the delivery');
    await delay(5);
  }
}

/** ffmpeg stand-in: the test writes PCM into `stdout` and the hearing loop treats it as capture. */
class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.killed = false;
  }

  kill() {
    this.killed = true;
  }
}

/** A 440 Hz tone at -12 dBFS: loud enough to pass the RMS gate. */
function tone(ms) {
  const samples = new Int16Array(Math.round((SAMPLE_RATE * ms) / 1000));
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = Math.round(Math.sin((2 * Math.PI * 440 * index) / SAMPLE_RATE) * 0.25 * 32767);
  }
  const buffer = Buffer.alloc(samples.length * 2);
  for (let index = 0; index < samples.length; index += 1) buffer.writeInt16LE(samples[index], index * 2);
  return buffer;
}

/** Exactly `ms` of silence, as Int16 (the store's own input type). */
function pcm(ms) {
  return new Int16Array(Math.round((SAMPLE_RATE * ms) / 1000));
}

/** Streaming pass: the endpoint fires at the end of the constructed clip. */
function fakeStreaming({ endpointAtSamples, text }) {
  return {
    createStream: () => ({
      samples: 0,
      acceptWaveform({ samples }) {
        this.samples += samples.length;
      },
    }),
    isReady: () => false,
    decode: () => {},
    getResult: (stream) => ({ text: stream.samples > 0 ? text : '' }),
    isEndpoint: (stream) => stream.samples >= endpointAtSamples,
    reset(stream) {
      stream.samples = 0;
    },
  };
}

/** Fake Silero detector: one 30 ms "speech" range on a 600 ms clip ⇒ ratio 0.05 (real VAD shape). */
function fakeVad({ segments = [{ startMs: 100, endMs: 130 }] } = {}) {
  let fedSamples = 0;
  const pending = [];
  const queue = segments.map((segment) => ({ ...segment }));
  return {
    acceptWaveform(samples) {
      fedSamples += samples.length;
      const fedMs = (fedSamples * 1000) / SAMPLE_RATE;
      while (queue.length > 0 && queue[0].endMs <= fedMs) {
        const segment = queue.shift();
        const start = Math.round((segment.startMs * SAMPLE_RATE) / 1000);
        const length = Math.max(0, Math.round(((segment.endMs - segment.startMs) * SAMPLE_RATE) / 1000));
        pending.push({ start, samples: new Float32Array(length) });
      }
    },
    isEmpty: () => pending.length === 0,
    front: () => pending[0],
    pop: () => {
      pending.shift();
    },
    isDetected: () => false,
    reset: () => {
      pending.length = 0;
      queue.length = 0;
      fedSamples = 0;
    },
  };
}

/** Worker stand-in that echoes the utterance identity back with one `s0` piece id. */
function fakeWorker(text) {
  const worker = new EventEmitter();
  worker.messages = [];
  worker.unref = () => {};
  worker.terminate = () => {
    worker.emit('exit', null);
  };
  worker.postMessage = (message) => {
    worker.messages.push(message);
    const utteranceId = message.utteranceId ?? null;
    setImmediate(() => worker.emit('message', {
      type: 'result',
      id: message.id,
      utteranceId,
      segmentIds: utteranceId === null ? ['s0'] : [`${utteranceId}:s0`],
      text,
    }));
  };
  return worker;
}

/** Push one constructed clip through endpoint → worker decode → delivery. */
async function runClip({
  ms = 600, streamingText = '', workerText = '', vad = true, extra = {},
}) {
  const child = new FakeChild();
  const updates = [];
  const events = [];
  const clip = tone(ms);
  const hearing = startHearing({
    ffmpegPath: 'ffmpeg-not-used',
    modelDir: 'models-not-used',
    finalModelDir: '',
    device: 'fake-device',
    recognizer: fakeStreaming({ endpointAtSamples: clip.length / 2, text: streamingText }),
    asrWorkerFactory: () => fakeWorker(workerText),
    spawnProcess: () => child,
    ...(vad ? { vadFactory: () => fakeVad() } : {}),
    ...extra,
    onUpdate: (event) => updates.push(event),
    onEvent: (type, payload) => events.push({ type, payload }),
  });
  child.stdout.write(clip);
  await until(() => updates.some((event) => typeof event.final === 'string'));
  await delay(5);
  await hearing.retention?.flush?.();
  return { hearing, updates, events, clip };
}

const ofType = (events, type) => events.filter((event) => event.type === type);
const tmp = () => mkdtemp(join(tmpdir(), 'seirein-retention-'));

/** A fresh directory that is removed after the test (clip files are the point of the suite). */
async function tempDir(t) {
  const dir = await tmp();
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

/**
 * A store on an injected fake clock: `advance(ms)` moves time forward with no real waiting, so the
 * lazy-expiry interval is exercised deterministically. Returns the store, its emitted rows and a
 * clock handle the test reads as `clock.now`.
 */
function fakeStore(dir, { start = 1_000_000, limits = {}, cleanupIntervalMs = 30 * 1000 } = {}) {
  const clock = { now: start };
  const events = [];
  const store = createAudioRetention({
    dir,
    enabled: true,
    now: () => clock.now,
    cleanupIntervalMs,
    limits,
    emit: (type, payload) => events.push({ type, payload }),
  });
  return { store, clock, events, advance: (ms) => { clock.now += ms; } };
}

test('1) 默认关闭：关闭时不写任何音频、索引或事件', async (t) => {
  // Store level: the switch off is a refusal, not a silent write.
  const dir = await tempDir(t);
  const store = createAudioRetention({ dir, enabled: false });
  const refused = await store.retain({ utteranceId: 1, samples: pcm(200), reason: 'noise' });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'DISABLED');
  await store.flush();
  assert.equal(existsSync(join(dir, 'index.json')), false, 'no index is created');
  assert.deepEqual((await readdirSafe(dir)).filter((name) => name.endsWith('.wav')), []);

  // Capture level: a suspect clip with the setting persisted as `false` keeps nothing.
  const root = await tempDir(t);
  const { hearing, events } = await runClip({
    ms: 600,
    streamingText: 'The.',
    workerText: 'The.',
    extra: { retentionRoot: root, audioRetention: false },
  });
  assert.equal(ofType(events, 'hearing.audio.retained').length, 0, 'no retained row');
  assert.equal(existsSync(join(root, 'cache', 'retention')), false, 'no store directory at all');
  assert.equal(hearing.retention.isEnabled(), false);
  hearing.stop();
});

test('2) 开启后：可疑片段写入 1 个 WAV + 1 条完整索引 + retained 事件', async (t) => {
  const root = await tempDir(t);
  const { hearing, updates, events } = await runClip({
    ms: 600,
    streamingText: 'The.',
    workerText: 'The.',
    extra: { retentionRoot: root, audioRetention: true },
  });
  // Delivery is unchanged: the suspect is kept, not filtered.
  assert.equal(updates.filter((event) => typeof event.final === 'string')[0].final, 'The.');

  const listed = await hearing.retention.list();
  assert.equal(listed.ok, true);
  assert.equal(listed.count, 1, 'exactly one suspicious clip kept');
  assert.equal(listed.missing, 0);
  const [item] = listed.items;
  assert.equal(item.reason, 'noise', 'forced-segment + short-latin is the "noise" hypothesis');
  assert.deepEqual(item.suspects, ['short-latin']);
  assert.equal(parseUtteranceId(item.utteranceId).seq, 1);
  assert.equal(item.durationMs, 600);
  assert.ok(item.bytes > 44, 'header + PCM');
  assert.ok(Number.isFinite(item.rmsDb) && item.rmsDb < 0, 'rms is measured, not guessed');
  assert.equal(item.vadRatio, 0.05, 'the real Silero ratio is recorded');
  assert.equal(item.vadSource, 'silero');
  assert.equal(item.text, 'The.');
  assert.equal(item.source, 'mic');
  assert.equal(item.device, 'fake-device');
  assert.ok(Number.isFinite(Date.parse(item.createdAt)), 'a real timestamp');
  assert.equal(item.file, `${item.id}.wav`, 'one file per entry, no path traversal');
  assert.ok(item.path.startsWith(join(root, 'cache', 'retention')), 'stored under cache/retention');

  // The WAV is really playable 16 kHz mono 16-bit PCM.
  const bytes = await readFile(item.path);
  assert.equal(bytes.length, item.bytes);
  assert.equal(bytes.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.equal(bytes.subarray(8, 12).toString('ascii'), 'WAVE');
  assert.equal(bytes.readUInt16LE(20), 1, 'PCM format');
  assert.equal(bytes.readUInt16LE(22), 1, 'mono');
  assert.equal(bytes.readUInt32LE(24), 16000, '16 kHz');
  assert.equal(bytes.readUInt16LE(34), 16, '16-bit samples');
  assert.equal(bytes.readUInt32LE(40), bytes.length - 44, 'data chunk length');

  // The index on disk is the same entry (fields, not just an in-memory list).
  const raw = JSON.parse(await readFile(join(root, 'cache', 'retention', 'index.json'), 'utf8'));
  assert.equal(raw.version, 1);
  assert.equal(raw.items.length, 1);
  const entry = raw.items[0];
  for (const key of ['createdAt', 'utteranceId', 'rmsDb', 'vadRatio', 'text', 'reason', 'bytes']) {
    assert.ok(Object.hasOwn(entry, key), `index entry has ${key}`);
  }

  const retained = ofType(events, 'hearing.audio.retained');
  assert.equal(retained.length, 1);
  assert.deepEqual(retained[0].payload, {
    utteranceId: item.utteranceId,
    bytes: item.bytes,
    reason: 'noise',
  });
  hearing.stop();
});

test('3) 超过上限：先到先删（FIFO），并写一条 pruned debug 行', async (t) => {
  const dir = await tempDir(t);
  const events = [];
  const store = createAudioRetention({
    dir,
    enabled: true,
    limits: { maxClips: 2 },
    emit: (type, payload) => events.push({ type, payload }),
  });
  const kept = [];
  for (let index = 1; index <= 3; index += 1) {
    const result = await store.retain({ utteranceId: index, samples: pcm(100), reason: 'noise' });
    assert.equal(result.ok, true);
    kept.push(result);
    await store.flush();
  }
  const listed = await store.list();
  assert.equal(listed.count, 2, 'the cap holds');
  assert.deepEqual(listed.items.map((item) => item.utteranceId), [2, 3], 'the oldest went first');
  assert.equal(existsSync(kept[0].path), false, 'clip 1 was deleted');
  assert.equal(existsSync(kept[1].path), true);
  assert.equal(existsSync(kept[2].path), true);

  const pruned = ofType(events, 'hearing.audio.pruned');
  assert.equal(pruned.length, 1, 'one prune row for the FIFO deletion');
  assert.equal(pruned[0].payload.level, 'debug');
  assert.equal(pruned[0].payload.count, 1);

  // A byte cap is enforced by the same FIFO rule (one clip is already over the cap ⇒ refused).
  const tiny = createAudioRetention({ dir: await tempDir(t), enabled: true, limits: { maxBytes: 100 } });
  const refused = await tiny.retain({ utteranceId: 9, samples: pcm(200), reason: 'noise' });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'OVER_LIMIT');
  await tiny.flush();
  assert.equal((await tiny.list()).count, 0, 'an over-cap clip is not left behind');
});

test('4) 动作：delete 单条/all、export 返回路径、缺失文件在 list 中标记 missing', async (t) => {
  const dir = await tempDir(t);
  const store = createAudioRetention({ dir, enabled: true });
  const first = await store.retain({ utteranceId: 1, samples: pcm(100), reason: 'echo' });
  const second = await store.retain({ utteranceId: 2, samples: pcm(100), reason: 'low-evidence' });
  await store.flush();

  // The player path is a path; audio never travels through an event or an action payload.
  const exported = await store.exportPath(second.id);
  assert.equal(exported.ok, true);
  assert.equal(exported.path, second.path);
  assert.equal(Object.hasOwn(exported, 'samples'), false);

  // A file removed outside the store is reported, not silently forgotten.
  await unlink(first.path);
  const listed = await store.list();
  assert.equal(listed.missing, 1);
  assert.equal(listed.items.find((item) => item.id === first.id).missing, true);
  assert.equal(listed.items.find((item) => item.id === second.id).missing, false);

  assert.equal((await store.deleteOne('no-such-id')).code, 'NOT_FOUND');
  const one = await store.deleteOne(first.id);
  assert.equal(one.ok, true);
  assert.equal(one.removed, 1);
  assert.equal((await store.list()).count, 1);

  const all = await store.deleteAll();
  assert.equal(all.ok, true);
  assert.equal(all.removed, 1);
  assert.equal((await store.list()).count, 0);
  assert.deepEqual((await readdirSafe(dir)).filter((name) => name.endsWith('.wav')), []);
  assert.equal((await store.exportPath(second.id)).code, 'NOT_FOUND');
});

test('5) 隐私期间不写：写入即拒绝，且不在会话层产生事件', async (t) => {
  // Store level: the refusal happens at write time, not at the switch read.
  const dir = await tempDir(t);
  const store = createAudioRetention({ dir, enabled: true, isPrivacy: () => true });
  const refused = await store.retain({ utteranceId: 1, samples: pcm(200), reason: 'noise' });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'PRIVACY');
  await store.flush();
  assert.equal(existsSync(join(dir, 'index.json')), false);
  assert.deepEqual((await readdirSafe(dir)).filter((name) => name.endsWith('.wav')), []);

  // The lock lifts: the same store accepts the next clip.
  store.configure({ isPrivacy: () => false });
  assert.equal((await store.retain({ utteranceId: 2, samples: pcm(200), reason: 'noise' })).ok, true);
  await store.flush();
  assert.equal((await store.list()).count, 1);

  // Capture level: the host hands `vision.mode === 'privacy'` as a probe.
  const root = await tempDir(t);
  const { hearing, events } = await runClip({
    ms: 600,
    streamingText: 'The.',
    workerText: 'The.',
    extra: { retentionRoot: root, audioRetention: true, isPrivacy: () => true },
  });
  assert.equal(ofType(events, 'hearing.audio.retained').length, 0);
  assert.equal((await hearing.retention.list()).count, 0);
  hearing.stop();
});

test('6) 启动清理：过期片段被删除，cleanupOnce 在节流窗口内幂等', async (t) => {
  const dir = await tempDir(t);
  const oldAt = Date.now() - 10 * 60 * 60 * 1000;
  const old = createAudioRetention({
    dir,
    enabled: true,
    now: () => oldAt,
    limits: { maxAgeMs: 60 * 60 * 1000 },
  });
  const one = await old.retain({ utteranceId: 1, samples: pcm(100), reason: 'noise' });
  const two = await old.retain({ utteranceId: 2, samples: pcm(100), reason: 'noise' });
  await old.flush();
  assert.equal((await old.list()).count, 2);

  // A later boot: one hour lifetime, both clips are ten hours old.
  const fresh = createAudioRetention({ dir, enabled: false, limits: { maxAgeMs: 60 * 60 * 1000 } });
  const cleaned = await fresh.cleanupOnce();
  assert.equal(cleaned.ok, true);
  assert.equal(cleaned.removed, 2);
  assert.equal((await fresh.list()).count, 0);
  assert.equal(existsSync(one.path), false);
  assert.equal(existsSync(two.path), false);
  const again = await fresh.cleanupOnce();
  assert.equal(again.skipped, true, 'inside the throttle window: a cheap skipped answer');

  // A fresh clip survives a boot cleanup, and the defaults are the documented caps.
  const currentDir = await tempDir(t);
  const current = createAudioRetention({ dir: currentDir, enabled: true });
  const kept = await current.retain({ utteranceId: 3, samples: pcm(100), reason: 'noise' });
  await current.flush();
  const freshAgain = createAudioRetention({ dir: currentDir, enabled: false });
  assert.equal((await freshAgain.cleanupOnce()).removed, 0);
  assert.equal((await freshAgain.list()).count, 1);
  assert.equal(DEFAULT_RETENTION_LIMITS.maxClips, 20);
  assert.equal(DEFAULT_RETENTION_LIMITS.maxDurationMs, 300000);
  assert.equal(DEFAULT_RETENTION_LIMITS.maxBytes, 50 * 1024 * 1024);
  assert.equal(existsSync(kept.path), true);
});

test('9) 惰性清理：超过 maxAgeMs 后 list() 删除条目、文件并写 pruned 事件', async (t) => {
  const dir = await tempDir(t);
  const { store, events, advance } = fakeStore(dir, { limits: { maxAgeMs: 60 * 1000 } });
  const kept = await store.retain({ utteranceId: 1, samples: pcm(100), reason: 'noise' });
  await store.flush();
  assert.equal(kept.ok, true);
  assert.equal(existsSync(kept.path), true);
  assert.equal((await store.list()).count, 1, 'fresh: listed');

  advance(61 * 1000);
  const listed = await store.list();
  assert.equal(listed.count, 0, 'an expired clip is not listed');
  assert.deepEqual(listed.items, []);
  assert.equal(listed.missing, 0);
  assert.equal(existsSync(kept.path), false, 'the expired .wav is deleted');
  const pruned = ofType(events, 'hearing.audio.pruned');
  assert.equal(pruned.length, 1, 'one prune row for the lazy pass');
  assert.equal(pruned[0].payload.level, 'debug');
  assert.equal(pruned[0].payload.count, 1);
  const raw = JSON.parse(await readFile(join(dir, 'index.json'), 'utf8'));
  assert.deepEqual(raw.items, [], 'the index on disk was saved without it');
  console.log(`[retention-lazy 9] listAfterExpiry count=${listed.count} fileExists=${existsSync(kept.path)} `
    + `pruned=${pruned.length} count=${pruned[0].payload.count}`);
});

test('10) 惰性清理：超过 maxAgeMs 后 exportPath() 先清理并返回 NOT_FOUND', async (t) => {
  const dir = await tempDir(t);
  const { store, events, advance } = fakeStore(dir, { limits: { maxAgeMs: 60 * 1000 } });
  const kept = await store.retain({ utteranceId: 2, samples: pcm(100), reason: 'echo' });
  await store.flush();
  const fresh = await store.exportPath(kept.id);
  assert.equal(fresh.ok, true, 'playable while fresh');
  assert.equal(fresh.path, kept.path);

  advance(2 * 60 * 1000);
  const exported = await store.exportPath(kept.id);
  assert.equal(exported.ok, false);
  assert.equal(exported.code, 'NOT_FOUND', 'an expired clip is gone, not merely MISSING');
  assert.equal(existsSync(kept.path), false, 'the cleanup ran before the lookup');
  const pruned = ofType(events, 'hearing.audio.pruned');
  assert.equal(pruned.at(-1).payload.count, 1);
  assert.equal((await store.list()).count, 0);
  console.log(`[retention-lazy 10] exportFresh=${fresh.ok} exportExpired=${exported.code} `
    + `fileExists=${existsSync(kept.path)} pruned=${pruned.at(-1).payload.count}`);
});

test('11) 惰性清理：写入触发清理，按 cleanupIntervalMs 节流（窗口内不重复，窗口外再清）', async (t) => {
  const dir = await tempDir(t);
  const { store, events, advance } = fakeStore(dir, {
    limits: { maxAgeMs: 60 * 1000 },
    cleanupIntervalMs: 30 * 1000,
  });
  const first = await store.retain({ utteranceId: 1, samples: pcm(100), reason: 'noise' });
  await store.flush();

  // t+40 s: the window is open again, but clip 1 (40 s) is not old enough to expire.
  advance(40 * 1000);
  await store.retain({ utteranceId: 2, samples: pcm(100), reason: 'noise' });
  await store.flush();
  assert.equal(existsSync(first.path), true);
  assert.equal(ofType(events, 'hearing.audio.pruned').length, 0);

  // t+60 s: clip 1 is now past maxAgeMs, but only 20 s since the last pass ⇒ no cleanup at all.
  advance(20 * 1000);
  await store.retain({ utteranceId: 3, samples: pcm(100), reason: 'noise' });
  await store.flush();
  assert.equal(ofType(events, 'hearing.audio.pruned').length, 0, 'inside the window: no second pass');
  assert.equal(existsSync(first.path), true, 'expired by age, still here until the window opens');
  assert.equal((await store.list()).count, 3, 'list() is inside the same window, so it does not clean');

  // t+80 s: 40 s since the last pass ⇒ the write expires clip 1 and nothing else.
  advance(20 * 1000);
  await store.retain({ utteranceId: 4, samples: pcm(100), reason: 'noise' });
  await store.flush();
  const pruned = ofType(events, 'hearing.audio.pruned');
  assert.equal(pruned.length, 1, 'exactly one lazy pass went out');
  assert.equal(pruned[0].payload.count, 1, 'only the expired clip went');
  assert.equal(existsSync(first.path), false);
  const listed = await store.list();
  assert.deepEqual(listed.items.map((item) => item.utteranceId), [2, 3, 4]);
  console.log(`[retention-lazy 11] inWindowPruned=0 outOfWindowPruned=${pruned[0].payload.count} `
    + `kept=${JSON.stringify(listed.items.map((item) => item.utteranceId))}`);
});

test('12) 重启采集：同一 root 的新 store 首次 list 即清掉旧过期条目；cleanupOnce 可重复但受节流', async (t) => {
  const dir = await tempDir(t);
  const first = fakeStore(dir, { limits: { maxAgeMs: 60 * 1000 } });
  const one = await first.store.retain({ utteranceId: 1, samples: pcm(100), reason: 'noise' });
  const two = await first.store.retain({ utteranceId: 2, samples: pcm(100), reason: 'noise' });
  await first.store.flush();
  assert.equal((await first.store.list()).count, 2);

  // A new hearing session opens a new store on the same root, two hours later. There is no capture
  // hook and no cleanupOnce() call: the first read must be the cleanup.
  const restarted = fakeStore(dir, {
    start: first.clock.now + 2 * 60 * 60 * 1000,
    limits: { maxAgeMs: 60 * 1000 },
  });
  const listed = await restarted.store.list();
  assert.equal(listed.count, 0);
  assert.equal(existsSync(one.path), false);
  assert.equal(existsSync(two.path), false);
  assert.equal(ofType(restarted.events, 'hearing.audio.pruned')[0].payload.count, 2);

  // cleanupOnce() is no longer a one-shot flag: throttled inside the window, real once it opens.
  const kept = await restarted.store.retain({ utteranceId: 3, samples: pcm(100), reason: 'noise' });
  await restarted.store.flush();
  assert.equal((await restarted.store.cleanupOnce()).skipped, true, 'inside the window');
  assert.equal(existsSync(kept.path), true);
  restarted.advance(61 * 1000);
  const forced = await restarted.store.cleanupOnce();
  assert.equal(forced.skipped, undefined, 'the window is open: it really cleans');
  assert.equal(forced.removed, 1);
  assert.equal(existsSync(kept.path), false);
  assert.equal((await restarted.store.list()).count, 0);
  console.log(`[retention-lazy 12] restartList=0 restartPruned=${ofType(restarted.events, 'hearing.audio.pruned')[0].payload.count} `
    + `firstCleanupSkipped=true secondCleanupRemoved=${forced.removed}`);
});

test('13) 未过期条目不受惰性清理影响', async (t) => {
  const dir = await tempDir(t);
  const { store, events, advance } = fakeStore(dir, {
    limits: { maxAgeMs: 60 * 1000 },
    cleanupIntervalMs: 10 * 1000,
  });
  const old = await store.retain({ utteranceId: 1, samples: pcm(100), reason: 'noise' });
  await store.flush();
  advance(50 * 1000); // past the throttle window, still inside maxAgeMs
  const fresh = await store.retain({ utteranceId: 2, samples: pcm(100), reason: 'echo' });
  await store.flush();
  assert.equal(ofType(events, 'hearing.audio.pruned').length, 0, 'nothing expired ⇒ nothing pruned');

  const listed = await store.list();
  assert.equal(listed.count, 2);
  assert.deepEqual(listed.items.map((item) => item.utteranceId), [1, 2]);
  assert.equal(listed.missing, 0);
  assert.equal(existsSync(old.path), true);
  assert.equal(existsSync(fresh.path), true);
  assert.equal((await store.exportPath(fresh.id)).ok, true);
  assert.equal(RETENTION_CLEANUP_INTERVAL_MS, 30 * 1000, 'the default lazy interval is 30 s');
  console.log(`[retention-lazy 13] count=${listed.count} pruned=${ofType(events, 'hearing.audio.pruned').length} `
    + `defaultIntervalMs=${RETENTION_CLEANUP_INTERVAL_MS}`);
});

test('7) 设置动作：开关持久化并即时生效，list 不含音频，delete/export 可用', async (t) => {
  const dir = await tempDir(t);
  const store = createAudioRetention({ dir, enabled: false });
  let saved = null;
  const services = {
    retentionStore: store,
    storedVoice: () => ({ speakerShadow: true }),
    writeSettings: (patch) => {
      saved = patch;
    },
    log: { emit: async () => {} },
  };
  const handler = createHearingSettingsActions(services);

  const on = await handler({ action: 'voice.audioRetention', enabled: true });
  assert.equal(on.ok, true);
  assert.equal(on.enabled, true);
  assert.deepEqual(saved, { voice: { speakerShadow: true, audioRetention: true } }, 'other voice keys kept');
  assert.equal(store.isEnabled(), true, 'the live store follows the switch without a restart');
  assert.equal(on.limits.maxClips, 20);

  const off = await handler({ action: 'voice.audioRetention', enabled: false });
  assert.equal(off.enabled, false);
  assert.equal(store.isEnabled(), false);
  await handler({ action: 'voice.audioRetention', enabled: true });

  const clip = await store.retain({ utteranceId: 7, samples: pcm(200), reason: 'low-evidence' });
  await store.flush();
  const listed = await handler({ action: 'audio.retention.list' });
  assert.equal(listed.ok, true);
  assert.equal(listed.count, 1);
  assert.equal(listed.items[0].utteranceId, 7);
  assert.equal(Object.hasOwn(listed.items[0], 'samples'), false, 'entries carry no audio');
  assert.equal(Object.hasOwn(listed.items[0], 'wav'), false);

  const exported = await handler({ action: 'audio.retention.export', id: clip.id });
  assert.equal(exported.ok, true);
  assert.equal(existsSync(exported.path), true, 'the settings page can play the file at this path');

  const single = await handler({ action: 'audio.retention.delete', id: clip.id });
  assert.equal(single.ok, true);
  assert.equal((await handler({ action: 'audio.retention.list' })).count, 0);

  await store.retain({ utteranceId: 8, samples: pcm(100), reason: 'echo' });
  await store.retain({ utteranceId: 9, samples: pcm(100), reason: 'noise' });
  await store.flush();
  const all = await handler({ action: 'audio.retention.delete', all: true });
  assert.equal(all.ok, true);
  assert.equal(all.removed, 2);
  assert.equal((await handler({ action: 'audio.retention.list' })).count, 0);

  // No store wired: the actions answer a code instead of throwing.
  const unwired = createHearingSettingsActions({ ...services, retentionStore: null });
  assert.equal((await unwired({ action: 'audio.retention.list' })).code, 'AUDIO_RETENTION_UNAVAILABLE');
  assert.equal((await unwired({ action: 'audio.retention.export', id: 'x' })).code, 'AUDIO_RETENTION_UNAVAILABLE');
});

// ---------------------------------------------------------------------------
// Host wiring: mount the real plugin entry with a recording hearing stub.
//
// `index.js` imports `./hearing/hearing.js` by URL; this suite's top-level import already put the
// real module at that URL. A resolve hook rewrites ONLY index.js's specifier to a query URL, so
// index.js links a stub capture lane while the capture-level tests above keep the real one.
// ---------------------------------------------------------------------------

const retentionHost = { starts: [], sessions: [] };
globalThis.__retentionHostTest = retentionHost;

const HOST_INDEX_URL = new URL('../src/host/index.js', import.meta.url).href;
const HEARING_URL = new URL('../src/host/hearing/hearing.js', import.meta.url).href;
const HEARING_STUB_URL = `${HEARING_URL}?retention-host-stub`;

const HEARING_STUB_SOURCE = `
const state = globalThis.__retentionHostTest;
export const modelReady = () => true;
export const finalModelReady = () => true;
export const isLoopbackDevice = (name) => /CABLE|Stereo Mix|Virtual/i.test(String(name));
export const selectMicrophoneDevice = (devices, requested) => ({
  device: requested || devices[0] || '', loopback: false, error: '',
});
export const listDevices = async () => ['Fake Mic'];
export const startHearing = (options) => {
  state.starts.push(options);
  let settle;
  const done = new Promise((resolve) => { settle = resolve; });
  const session = {
    device: options.device,
    stats: () => ({ rmsDb: -20, peakDb: -10 }),
    stop() { settle(); },
    done,
  };
  state.sessions.push(session);
  return session;
};
export const watchHearingExit = () => {};
export const annotateTranscript = (text) => text;
export const joinDetailFields = () => ({});
export const mergeJoinFallback = () => ({});
export const offlineLimitedNote = () => '';
export const truncationNotice = () => '';
`;

let hostApply = null;

/** Import index.js once, with only its hearing specifier redirected to the stub. */
async function loadHostApply() {
  if (hostApply !== null) return hostApply;
  const hook = registerHooks({
    resolve(specifier, context, next) {
      if (specifier === './hearing/hearing.js'
        && String(context.parentURL ?? '').split('?')[0] === HOST_INDEX_URL) {
        return { url: HEARING_STUB_URL, shortCircuit: true };
      }
      return next(specifier, context);
    },
    load(url, context, next) {
      if (url === HEARING_STUB_URL) {
        return { format: 'module', shortCircuit: true, source: HEARING_STUB_SOURCE };
      }
      return next(url, context);
    },
  });
  try {
    hostApply = (await import('../src/host/index.js')).apply;
  } finally {
    hook.deregister();
  }
  return hostApply;
}

/** Mount the plugin against a fake Cordis context (same shape as `speaker-host-wiring.mjs`). */
async function mountHost(t) {
  const apply = await loadHostApply();
  const root = await mkdtemp(join(tmpdir(), 'seirein-retention-host-'));
  await mkdir(join(root, 'data'), { recursive: true });
  await mkdir(join(root, 'workspace'), { recursive: true });
  await writeFile(join(root, 'data', 'features.json'), JSON.stringify({
    hearing: true, ambient: false, voice: false, vision: false,
    subtitle: false, avatar: false, memory: false, fastpath: false,
  }));
  await writeFile(join(root, 'data', 'settings.json'), JSON.stringify({
    langs: { speech: 'zh', subtitle: 'zh' },
    autoMemory: { enabled: false },
    voice: {},
  }));

  retentionHost.starts = [];
  retentionHost.sessions = [];

  const tools = new Map();
  const routes = new Map();
  const disposers = [];
  const effect = (fn) => {
    const cleanup = fn();
    if (typeof cleanup === 'function') disposers.push(cleanup);
    return cleanup;
  };
  const scope = {
    effect,
    on: () => () => {},
    systemPrompt: { section: () => () => {} },
    webServer: {
      register(route) {
        routes.set(route.path, route.handler);
        return () => routes.delete(route.path);
      },
    },
  };
  apply({
    effect,
    on: () => () => {},
    get: () => undefined,
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    inject: (_dependencies, registerScope) => registerScope(scope),
  }, { root, enabled: true, ffmpegPath: process.execPath, asrMergeWindowMs: 10 });

  const listen = tools.get('assistant_listen');
  assert.ok(listen !== undefined, 'assistant_listen is registered');

  const action = async (body) => {
    const handler = routes.get('/assistant/action');
    assert.equal(typeof handler, 'function', 'the action route is registered');
    const { Readable } = await import('node:stream');
    let result;
    await handler(
      Object.assign(Readable.from([JSON.stringify(body)]), { method: 'POST' }),
      { writeHead() {}, end(value) { result = value; } },
    );
    return JSON.parse(result);
  };
  const status = async () => {
    const handler = routes.get('/assistant/status');
    assert.equal(typeof handler, 'function', 'the status route is registered');
    let result = '';
    await handler({ method: 'GET', url: '/assistant/status' }, {
      writeHead() {},
      end(value) { result = value; },
    });
    return JSON.parse(result);
  };
  const start = async () => listen.execute({ action: 'start' }, {});

  t.after(async () => {
    for (const session of retentionHost.sessions) session.stop();
    await cleanupRoot(root, disposers);
  });

  return { root, action, status, start };
}

test('8) Host 接线：动作可用、开关持久化并即时生效、list/删除/试听、隐私拒绝', async (t) => {
  const app = await mountHost(t);

  // 1. Boot: the actions exist before any capture and report an empty store (no directory yet).
  let listed = await app.action({ action: 'audio.retention.list' });
  assert.equal(listed.ok, true, listed.error);
  assert.equal(listed.count, 0);
  assert.deepEqual(listed.items, []);
  assert.equal(existsSync(join(app.root, 'cache', 'retention')), false, 'list does not create the store');
  assert.equal((await app.status()).retention.enabled, false, 'default OFF is projected to the card');
  assert.equal(listed.limits.maxClips, 20);

  // 2. Switch: persisted to settings.json and applied to the Host store immediately.
  const on = await app.action({ action: 'voice.audioRetention', enabled: true });
  assert.equal(on.ok, true);
  assert.equal(on.enabled, true);
  assert.equal(on.limits.maxClips, 20);
  const saved = JSON.parse(await readFile(join(app.root, 'data', 'settings.json'), 'utf8'));
  assert.equal(saved.voice.audioRetention, true, 'voice.audioRetention is persisted');
  assert.equal((await app.status()).retention.enabled, true, 'status follows the persisted switch');

  // 3. Capture: startHearing receives the Host store, its root and the privacy probe.
  const started = await app.start();
  assert.equal(started.ok, true, started.error);
  const options = retentionHost.starts.at(-1);
  assert.equal(options.retentionRoot, app.root);
  assert.equal(typeof options.isPrivacy, 'function');
  assert.equal(options.isPrivacy(), false);
  const store = options.audioRetention;
  assert.equal(store.isEnabled(), true, 'the live store follows the switch without a restart');

  // A suspicious final reaching the same store is exactly what the actions must list.
  const kept = await store.retain({ utteranceId: 41, samples: pcm(200), reason: 'noise' });
  assert.equal(kept.ok, true);
  await store.flush();
  listed = await app.action({ action: 'audio.retention.list' });
  assert.equal(listed.count, 1, 'the action reads the store the capture lane borrowed');
  assert.equal(listed.items[0].utteranceId, 41);
  assert.equal(listed.items[0].reason, 'noise');
  assert.equal(Object.hasOwn(listed.items[0], 'samples'), false, 'list never carries audio');

  // 4. Preview returns a path only; delete one / all work through the actions.
  const exported = await app.action({ action: 'audio.retention.export', id: listed.items[0].id });
  assert.equal(exported.ok, true);
  assert.equal(existsSync(exported.path), true, 'the path is playable');
  const single = await app.action({ action: 'audio.retention.delete', id: listed.items[0].id });
  assert.equal(single.ok, true);
  assert.equal((await app.action({ action: 'audio.retention.list' })).count, 0);

  await store.retain({ utteranceId: 42, samples: pcm(100), reason: 'echo' });
  await store.retain({ utteranceId: 43, samples: pcm(100), reason: 'low-evidence' });
  await store.flush();
  const all = await app.action({ action: 'audio.retention.delete', all: true });
  assert.equal(all.ok, true);
  assert.equal(all.removed, 2);
  assert.equal((await app.action({ action: 'audio.retention.list' })).count, 0);

  // 5. Privacy: the probe reaches `vision.mode`, and the same store refuses the write.
  const privacy = await app.action({ action: 'privacy.toggle' });
  assert.equal(privacy.ok, true, privacy.error);
  assert.equal(options.isPrivacy(), true, 'privacy is read through the Host vision mode');
  const refused = await store.retain({ utteranceId: 44, samples: pcm(200), reason: 'noise' });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'PRIVACY');
  await store.flush();
  assert.equal((await app.action({ action: 'audio.retention.list' })).count, 0);
  await app.action({ action: 'privacy.toggle' });

  // 6. Switch off: further writes are refused, nothing is deleted behind the user's back.
  const off = await app.action({ action: 'voice.audioRetention', enabled: false });
  assert.equal(off.enabled, false);
  assert.equal(store.isEnabled(), false);
  const disabled = await store.retain({ utteranceId: 45, samples: pcm(100), reason: 'noise' });
  assert.equal(disabled.code, 'DISABLED');

  console.log(`[retention-host 8] bootList=0 defaultOff=${(await app.status()).retention.enabled === false} `
    + `saved=${saved.voice.audioRetention} wiring=store/root/privacy kept=1 export=${exported.ok} `
    + `deleteOne=0 deleteAll=${all.removed} privacy=${refused.code} off=${disabled.code}`);
});

test('0) 纯函数：理由判定与 WAV 编码', () => {
  assert.equal(retentionReasonOf({ text: 'The.', durationMs: 600, delivered: true }), 'noise');
  assert.equal(
    retentionReasonOf({ text: '你好', durationMs: 600, vadSpeechRatio: 0, delivered: true }),
    'low-evidence',
  );
  assert.equal(
    retentionReasonOf({ text: '好', durationMs: 600, vadSpeechRatio: 0, delivered: true }),
    '',
    'a protected short answer is not retained as a hallucination',
  );
  assert.equal(
    retentionReasonOf({ text: '你好', durationMs: 600, echo: { drop: true }, delivered: false }),
    'echo',
  );
  assert.equal(retentionReasonOf({ text: '。', durationMs: 600, delivered: false }), '', 'punctuation-only is not kept');
  assert.equal(retentionReasonOf({ text: '你好', durationMs: 600, delivered: false }), 'filtered');
  assert.deepEqual(
    retentionVerdictOf({ text: 'The.', durationMs: 3500, delivered: true }).suspects,
    ['short-latin', 'forced-segment'],
  );
  const wav = encodeWav16(new Int16Array([0, 32767, -32768]));
  assert.equal(wav.length, 44 + 6);
  assert.equal(wav.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.equal(wav.readUInt32LE(40), 6);
  assert.equal(encodeWav16(new Int16Array(0)), null);
});

async function readdirSafe(dir) {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}
