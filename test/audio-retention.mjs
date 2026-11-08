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
 *  6. startup cleanup drops expired clips and is idempotent;
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
import { mkdtemp, readFile, readdir, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import {
  DEFAULT_RETENTION_LIMITS,
  RETENTION_SAMPLE_RATE,
  createAudioRetention,
  encodeWav16,
  retentionReasonOf,
  retentionVerdictOf,
} from '../src/host/hearing/audio-retention.js';
import { createHearingSettingsActions } from '../src/host/hearing/settings-actions.js';
import { startHearing } from '../src/host/hearing/hearing.js';

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
  assert.equal(item.utteranceId, 1);
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
    utteranceId: 1,
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

test('6) 启动清理：过期片段被删除，cleanupOnce 幂等', async (t) => {
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
  assert.equal(again.skipped, true, 'startup cleanup runs once per store');

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
