/**
 * VAD shadow (round 1) — measurement only, zero delivery change.
 *
 * The VAD is a fake detector in these tests (no microphone, ffmpeg, sherpa model or thread): what
 * is pinned is the shadow contract, not Silero's accuracy:
 *  1. a fake VAD with a known speech range produces one `hearing.vad.shadow` row with every
 *     documented field, and the delivered finals are exactly what they were before;
 *  2. a VAD range that contradicts the energy meter is recorded as `agree: false`;
 *  3. a repeated utterance within 30 s writes one row plus one `hearing.vad.shadow.suppressed`,
 *     and both utterances are still delivered;
 *  4. a missing model writes exactly one `hearing.vad.unavailable` and delivery continues;
 *  5. the synchronous fallback keeps its event log empty (the existing contract);
 *  6. the two shadows never impersonate each other: the noise row's `vadSpeechRatio` is the same
 *     Silero number the VAD row reports, and the energy meter is recorded under its own name.
 *  7. the detector is handed an owned copy, never a foreign buffer;
 *  8. the stream is re-cut into fixed 512-sample windows: a 1000-sample chunk feeds exactly one
 *     window and keeps 488 samples for the next call, and 320 samples feed nothing yet;
 *  9. with a real `silero_vad.onnx` and a speech fixture, a 16000-sample capture chunk (the shape
 *     that used to starve the detector) still measures speech — skipped when either file is absent;
 * 10. samples that never form a window write one throttled `hearing.vad.window-starved`;
 * 12. the real fixture measures the same speech at 16000 / 1280 / 320-sample chunks: the capture
 *     block size is not a factor;
 * 13. the new signal diagnostics tell silence from speech (`zeroRatio`, `maxSilenceRun`, peak/rms);
 * 14. `threshold` is configurable (0.3 / 0.5) and the row records exactly the value the detector
 *     was built with; an invalid value falls back to 0.5;
 * 15. every row names its capture lane (`source: mic | loopback`), and the shadow drains segments
 *     with `front(false)` — Electron's V8 rejects the default external buffer with "External
 *     buffers are not allowed", which is why the device shadow died on the first speech segment.
 *
 * Run: node --test test/vad-shadow.mjs
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseUtteranceId, startHearing } from '../src/host/hearing/hearing.js';
import { createSileroVad, createVadShadow, VAD_WINDOW_SIZE } from '../src/host/hearing/vad.js';

const SAMPLE_RATE = 16000;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until `predicate()` is true; a missed deadline fails the test instead of hanging it. */
async function until(predicate, timeoutMs = 2000) {
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

/** A 440 Hz tone at -12 dBFS: loud enough to pass the RMS gate and to look voiced to the meter. */
function tone(ms) {
  const samples = new Int16Array(Math.round((SAMPLE_RATE * ms) / 1000));
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = Math.round(Math.sin((2 * Math.PI * 440 * index) / SAMPLE_RATE) * 0.25 * 32767);
  }
  const buffer = Buffer.alloc(samples.length * 2);
  for (let index = 0; index < samples.length; index += 1) buffer.writeInt16LE(samples[index], index * 2);
  return buffer;
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

/** Offline pass used by the synchronous fallback (no worker thread in that path). */
function fakeFinal(text) {
  return {
    createStream: () => ({ acceptWaveform: () => {} }),
    decode: () => {},
    getResult: () => ({ text }),
  };
}

/**
 * Fake Silero detector: `segments` are fixed `{startMs,endMs}` speech ranges on the clip timeline.
 * A segment becomes available (`isEmpty` false) once its end is covered by the fed samples, which
 * mirrors when sherpa closes a segment after its trailing silence.
 */
function fakeVad({ segments = [] } = {}) {
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

/** Detector double that records every `acceptWaveform` call (window contract, no segment logic). */
function recordingVad() {
  const received = [];
  return {
    received,
    acceptWaveform(samples) {
      received.push(samples);
    },
    isEmpty: () => true,
    isDetected: () => false,
    front: () => null,
    pop: () => {},
    reset: () => {},
  };
}

/**
 * Detector double that behaves like sherpa-onnx under Electron's V8: `front()` with the default
 * `enableExternalBuffer: true` throws, `front(false)` returns the segment. Plain Node accepts the
 * external buffer, which is exactly why this bug never showed up in `node --test` on the device.
 */
function externalBufferVad({ segments = [] } = {}) {
  const inner = fakeVad({ segments });
  return {
    ...inner,
    front(enableExternalBuffer = true) {
      if (enableExternalBuffer !== false) throw new Error('External buffers are not allowed');
      return inner.front();
    },
  };
}

/** Float32Array whose values encode their absolute index, so a window can be checked exactly. */
const ramp = (length, offset = 0) => {
  const out = new Float32Array(length);
  for (let index = 0; index < length; index += 1) out[index] = (offset + index) / 1000;
  return out;
};

/** Read a 16 kHz / mono / 16-bit PCM WAV into Float32 samples; null for any other shape. */
function readWavPcm(file) {
  const buffer = readFileSync(file);
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') return null;
  let offset = 12;
  let format = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      format = {
        audioFormat: buffer.readUInt16LE(body),
        channels: buffer.readUInt16LE(body + 2),
        sampleRate: buffer.readUInt32LE(body + 4),
        bitsPerSample: buffer.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      if (format === null || format.audioFormat !== 1 || format.channels !== 1
        || format.sampleRate !== SAMPLE_RATE || format.bitsPerSample !== 16) return null;
      const samples = new Float32Array(Math.floor(size / 2));
      for (let index = 0; index < samples.length; index += 1) {
        samples[index] = buffer.readInt16LE(body + index * 2) / 32768;
      }
      return samples;
    }
    offset = body + size + (size % 2);
  }
  return null;
}

/** Worker stand-in mirroring `asr-worker.js`'s reply shape. */
function fakeWorker(result) {
  const payload = typeof result === 'string' ? { text: result } : (result ?? { text: '' });
  const worker = new EventEmitter();
  worker.messages = [];
  worker.unref = () => {};
  worker.terminate = () => {
    worker.emit('exit', null);
  };
  worker.postMessage = (message) => {
    worker.messages.push(message);
    setImmediate(() => worker.emit('message', {
      type: 'result',
      id: message.id,
      utteranceId: message.utteranceId ?? null,
      segmentIds: [`${message.utteranceId ?? 's'}:s0`],
      ...payload,
    }));
  };
  return worker;
}

/** Push one clip through endpoint → worker decode → delivery and return every layer. */
async function runClip({
  ms = 600,
  streamingText = '好',
  workerText = '好',
  vadFactory,
  vadModelPath,
  vadEnabled,
  syncFinal = null,
  extra = {},
}) {
  const child = new FakeChild();
  const updates = [];
  const events = [];
  const clip = tone(ms);
  const worker = fakeWorker(workerText);

  const hearing = startHearing({
    ffmpegPath: 'ffmpeg-not-used',
    modelDir: 'models-not-used',
    finalModelDir: '',
    device: 'fake-device',
    recognizer: fakeStreaming({ endpointAtSamples: clip.length / 2, text: streamingText }),
    spawnProcess: () => child,
    ...(syncFinal === null ? { asrWorkerFactory: () => worker } : { finalRecognizer: fakeFinal(syncFinal) }),
    ...(vadFactory === undefined ? {} : { vadFactory }),
    ...(vadModelPath === undefined ? {} : { vadModelPath }),
    ...(vadEnabled === undefined ? {} : { vadEnabled }),
    ...extra,
    onUpdate: (event) => updates.push(event),
    onEvent: (type, payload) => events.push({ type, payload }),
  });

  child.stdout.write(clip);
  await until(() => updates.some((event) => typeof event.final === 'string'));
  await delay(5);

  const finals = updates.filter((event) => typeof event.final === 'string');
  const stats = hearing.stats();
  hearing.stop();
  return { finals, final: finals[0], events, stats };
}

const ofType = (events, type) => events.filter((event) => event.type === type);
const vadShadows = (events) => ofType(events, 'hearing.vad.shadow');
const vadSuppressed = (events) => ofType(events, 'hearing.vad.shadow.suppressed');

test('1) 假 VAD：影子字段齐全，投递的 finals 与文本完全不变', async () => {
  const { final, finals, events, stats } = await runClip({
    ms: 600,
    streamingText: '好',
    workerText: '好',
    vadFactory: () => fakeVad({ segments: [{ startMs: 100, endMs: 500 }] }),
  });

  // Delivery is untouched: exactly the same single final with the same text.
  assert.deepEqual(finals.map((event) => event.final), ['好']);
  assert.equal(final.final, '好');
  assert.equal(stats.finals, 1);
  assert.equal(stats.dropped + stats.hallucination, 0);

  const [shadow] = vadShadows(events).map((event) => event.payload);
  assert.ok(shadow, 'exactly one VAD shadow row per utterance');
  assert.equal(parseUtteranceId(shadow.utteranceId).seq, 1);
  assert.equal(shadow.device, 'fake-device');
  assert.equal(shadow.durationMs, 600);
  assert.equal(shadow.speechMs, 400, '100–500 ms is the detected speech span');
  assert.equal(shadow.speechRatio, 0.667);
  assert.deepEqual(shadow.segments, [{ startMs: 100, endMs: 500 }]);
  assert.equal(shadow.firstSpeechMs, 100);
  assert.equal(shadow.lastSpeechMs, 500);
  assert.equal(shadow.trailingSilenceMs, 100);
  assert.equal(shadow.energyVoicedRatio, 1, 'the same energy meter as the noise shadow');
  assert.equal(shadow.agree, true, 'both methods say speech is present');
  assert.equal(shadow.windowsFed, 18, '600 ms of audio = 18 complete 512-sample windows');
  assert.equal(shadow.vadFrames, 1, 'one speech segment was closed in this window');
  assert.equal(shadow.level, 'debug');
  assert.ok(Object.values(shadow).every((value) => value !== undefined), 'no key is `undefined`');

  // The new counters are queryable and count this delivered short answer.
  assert.equal(stats.diagnostics.shortAnswerCount, 1);
  assert.equal(stats.diagnostics.noiseTriggerCount, 0, 'a plain 「好」 raises no noise suspect');
  assert.equal(stats.diagnostics.dropAtBoundaryCount, 0);
  assert.equal(stats.diagnostics.deliverLatency.count, 1);
  assert.ok(stats.diagnostics.deliverLatency.p50Ms >= 0);
  assert.equal(stats.diagnostics.queueBacklog, 0, 'nothing queued after the delivery');
  assert.ok(stats.diagnostics.heapUsedMb > 0, 'the lazy minute sample took a heap reading');
  assert.equal(stats.diagnostics.vad.available, true);
  assert.equal(stats.diagnostics.vad.reason, '');
});

test('2) VAD 与能量法不一致：agree=false，两份测量都保留', async () => {
  // 20 ms of "speech" in 600 ms is below VAD_AGREE_MIN_RATIO, while the tone is loud everywhere.
  const { final, events } = await runClip({
    ms: 600,
    vadFactory: () => fakeVad({ segments: [{ startMs: 100, endMs: 120 }] }),
  });

  const [shadow] = vadShadows(events).map((event) => event.payload);
  assert.equal(shadow.speechRatio, 0.033);
  assert.equal(shadow.energyVoicedRatio, 1, 'the energy meter still says "voiced"');
  assert.equal(shadow.agree, false, 'the two verdicts disagree and the row says so');
  assert.equal(shadow.firstSpeechMs, 100);
  assert.equal(shadow.lastSpeechMs, 120);
  assert.equal(shadow.trailingSilenceMs, 480);
  assert.equal(final.final, '好', 'a disagreement is evidence, not a filter');
});

test('3) 30 秒内重复：只留一条完整行 + suppressed，两次都投递', async () => {
  const child = new FakeChild();
  const updates = [];
  const events = [];
  const clip = tone(600);
  const worker = fakeWorker('Okay okay,');

  const hearing = startHearing({
    ffmpegPath: 'ffmpeg-not-used',
    modelDir: 'models-not-used',
    finalModelDir: '',
    device: 'fake-device',
    recognizer: fakeStreaming({ endpointAtSamples: clip.length / 2, text: 'Okay okay,' }),
    asrWorkerFactory: () => worker,
    vadFactory: () => fakeVad({ segments: [{ startMs: 100, endMs: 500 }] }),
    spawnProcess: () => child,
    onUpdate: (event) => updates.push(event),
    onEvent: (type, payload) => events.push({ type, payload }),
  });

  const finals = () => updates.filter((event) => typeof event.final === 'string');
  child.stdout.write(clip);
  await until(() => finals().length === 1);
  child.stdout.write(clip);
  await until(() => finals().length === 2);
  await delay(5);

  assert.equal(vadShadows(events).length, 1, 'one full row inside the window');
  assert.equal(vadSuppressed(events).length, 1, 'the second occurrence is recorded as suppressed');
  assert.equal(vadSuppressed(events)[0].payload.count, 1);
  assert.deepEqual(finals().map((event) => event.final), ['Okay okay,', 'Okay okay,']);
  const stats = hearing.stats();
  assert.equal(stats.finals, 2);
  assert.equal(stats.diagnostics.noiseTriggerCount, 2, 'both suspicious judgments are counted');
  assert.equal(stats.diagnostics.shortAnswerCount, 0, 'an 11-character answer is not short');
  hearing.stop();
});

test('4) VAD 不可用：恰好一条 unavailable，其余照常投递', async () => {
  const { final, events, stats } = await runClip({
    ms: 600,
    vadModelPath: 'C:/definitely/missing/silero_vad.onnx',
  });

  const unavailable = ofType(events, 'hearing.vad.unavailable');
  assert.equal(unavailable.length, 1, 'one report per session, never a row per utterance');
  assert.match(unavailable[0].payload.reason, /silero_vad\.onnx/u);
  assert.equal(unavailable[0].payload.level, 'debug');

  assert.equal(final.final, '好', 'the unavailable shadow never blocks delivery');
  assert.equal(stats.finals, 1);
  assert.equal(stats.diagnostics.vad.available, false);
  assert.equal(vadShadows(events).length, 0);
});

test('5) 同步回退路径：事件日志仍为空，且不构造 VAD', async () => {
  let vadBuilt = 0;
  const { final, events, stats } = await runClip({
    ms: 600,
    syncFinal: '好',
    vadFactory: () => {
      vadBuilt += 1;
      return fakeVad({ segments: [{ startMs: 100, endMs: 500 }] });
    },
  });

  assert.equal(final.final, '好');
  assert.equal(stats.finals, 1);
  assert.equal(vadBuilt, 0, 'the shadow is a worker-session feature');
  assert.deepEqual(events, [], 'the synchronous contract keeps the event log empty');
  assert.equal(stats.diagnostics.vad.available, false);
});

test('6) 两份影子同源分名：vadSpeechRatio 就是 silero 的 speechRatio，能量比另名记录', async () => {
  const { final, events } = await runClip({
    ms: 600,
    vadFactory: () => fakeVad({ segments: [{ startMs: 100, endMs: 500 }] }),
  });
  const [vad] = vadShadows(events).map((event) => event.payload);
  const [noise] = ofType(events, 'hearing.noise.shadow').map((event) => event.payload);
  assert.ok(vad && noise, 'both shadow rows are written for the same utterance');

  // Same real VAD measurement, quoted under the name that says where it came from.
  assert.equal(noise.vadSpeechRatio, vad.speechRatio);
  assert.equal(noise.vadSpeechMs, vad.speechMs);
  assert.equal(noise.vadRatioSource, 'silero');
  // The energy meter is unchanged and separately named: never a stand-in for the VAD.
  assert.equal(noise.energyVoicedRatio, vad.energyVoicedRatio);
  assert.equal(noise.energySource, 'energy');
  assert.notEqual(noise.vadSpeechRatio, noise.energyVoicedRatio, '0.667 vs 1 — two measurements, never merged');

  // 「好」 is protected, so even this record-only verdict stays false.
  assert.equal(noise.wouldDrop, false);
  assert.equal(noise.wouldDropReason, 'whitelisted');
  assert.equal(final.final, '好');
});

test('7. the shadow hands the VAD an owned copy, never a foreign buffer', () => {
  const vad = recordingVad();
  const shadow = createVadShadow(vad);
  const frame = ramp(VAD_WINDOW_SIZE, 0);
  shadow.feed(frame);
  assert.equal(vad.received.length, 1, 'one full window reaches the detector');
  assert.notEqual(vad.received[0], frame, 'the VAD must not receive the caller-owned view');
  assert.equal(vad.received[0].buffer === frame.buffer, false, 'the buffer must be owned, not shared');
  for (let index = 0; index < VAD_WINDOW_SIZE; index += 1) {
    assert.equal(vad.received[0][index], frame[index], `sample ${index} survives the hand-off`);
  }
});

test('8) 窗口化喂入：1000 样本只送 1 个 512 窗口，余下 488 留到下一块', () => {
  const vad = recordingVad();
  const shadow = createVadShadow(vad);
  const first = ramp(1000, 0);
  shadow.feed(first);

  assert.equal(vad.received.length, 1, 'exactly one complete window');
  assert.equal(vad.received[0].length, VAD_WINDOW_SIZE);
  for (let index = 0; index < VAD_WINDOW_SIZE; index += 1) {
    assert.equal(vad.received[0][index], first[index], 'the window is the first 512 samples');
  }

  // 488 samples were kept: 24 more complete exactly one window (488 + 24 = 512).
  const second = ramp(24, 1000);
  shadow.feed(second);
  assert.equal(vad.received.length, 2, 'the leftover 488 samples form the next window');
  assert.equal(vad.received[1].length, VAD_WINDOW_SIZE);
  for (let index = 0; index < 488; index += 1) {
    assert.equal(vad.received[1][index], first[512 + index], `kept sample ${512 + index} is preserved`);
  }
  for (let index = 0; index < 24; index += 1) {
    assert.equal(vad.received[1][488 + index], second[index], `new sample ${index} completes the window`);
  }
});

test('9) 不足一窗：320 样本 0 次调用，凑满 512 才送一次', () => {
  const vad = recordingVad();
  const shadow = createVadShadow(vad);
  const head = ramp(320, 0);
  shadow.feed(head);
  assert.equal(vad.received.length, 0, 'a 320-sample chunk is not a VAD window');

  // 191 more still leaves one sample short; only the 192nd completes the 512-sample window.
  shadow.feed(ramp(191, 320));
  assert.equal(vad.received.length, 0, '511 samples are still short of one window');
  const tail = ramp(1, 511);
  shadow.feed(tail);
  assert.equal(vad.received.length, 1, 'the 512th sample releases the window');
  for (let index = 0; index < 320; index += 1) {
    assert.equal(vad.received[0][index], head[index], 'the pending 320 samples are kept, not dropped');
  }
  assert.equal(vad.received[0][511], tail[0], 'the completing sample is the window tail');
});

test('10) 真实 Silero：16000 样本的大块采集也不再丢音（无模型/样本时跳过）', (t) => {
  const modelPath = process.env.DSH_VAD_MODEL
    || fileURLToPath(new URL('../models/silero_vad.onnx', import.meta.url));
  if (!existsSync(modelPath)) {
    t.skip(`未找到真实模型 ${modelPath}：设置 DSH_VAD_MODEL 或把 silero_vad.onnx 放到 <repo>/models`);
    return;
  }
  const wavPath = fileURLToPath(new URL('./fixtures/asr-cutpoint/offset-0.0.wav', import.meta.url));
  if (!existsSync(wavPath)) {
    t.skip('缺少 16k 单声道人声 fixture test/fixtures/asr-cutpoint/offset-0.0.wav'
      + '（wav 不入库，先跑 tools/asr-cutpoint-fixture.mjs）');
    return;
  }
  const pcm = readWavPcm(wavPath);
  if (pcm === null) {
    t.skip('fixture 不是 16 kHz / 单声道 / 16-bit PCM WAV');
    return;
  }
  const vad = createSileroVad({ modelPath, sampleRate: SAMPLE_RATE });
  assert.ok(vad, 'the real model loads');
  const shadow = createVadShadow(vad, { sampleRate: SAMPLE_RATE });

  // The regression shape: one capture chunk of 16000 samples (1 s). Fed as-is this starved the
  // detector; the shadow now re-cuts it into 512-sample windows.
  const chunk = 16000;
  const total = Math.min(pcm.length, 12 * SAMPLE_RATE);
  for (let offset = 0; offset < total; offset += chunk) {
    shadow.feed(pcm.slice(offset, Math.min(total, offset + chunk)));
  }
  const metrics = shadow.takeUtterance({ durationMs: Math.round(total / 16), energyVoicedRatio: 0.9 });
  assert.ok(metrics, 'one utterance window with audio');
  assert.equal(metrics.windowsFed, Math.floor(total / VAD_WINDOW_SIZE), 'every complete window was fed');
  assert.ok(metrics.vadFrames > 0, 'the detector closed at least one speech segment');
  assert.ok(metrics.speechMs > 0, `speech is measured, not zero (got ${metrics.speechMs} ms)`);
  assert.ok(metrics.speechRatio > 0.3, `a clearly voiced 12 s clip is mostly speech (got ${metrics.speechRatio})`);
  assert.equal(metrics.agree, true, 'the real VAD agrees with the energy meter on this clip');
  assert.equal(shadow.takeUtterance({ durationMs: 0 }), null, 'an empty window still returns null');
});

test('11) 有样本却没有完整窗口：写一条节流的 window-starved', () => {
  const diagnostics = [];
  const shadow = createVadShadow(recordingVad(), {
    onDiagnostic: (type, payload) => diagnostics.push({ type, payload }),
  });
  shadow.feed(ramp(100, 0));
  const metrics = shadow.takeUtterance({ durationMs: 6 });
  assert.ok(metrics, 'a short window is still measured');
  assert.equal(metrics.windowsFed, 0, '100 samples never form a window');
  assert.equal(metrics.vadFrames, 0);
  assert.equal(diagnostics.length, 1, 'the starved window is reported once');
  assert.equal(diagnostics[0].type, 'hearing.vad.window-starved');
  assert.deepEqual(diagnostics[0].payload, { level: 'debug', pendingSamples: 100 });

  // Throttled: a second starved window inside the 30 s window adds no row.
  shadow.feed(ramp(100, 100));
  shadow.takeUtterance({ durationMs: 6 });
  assert.equal(diagnostics.length, 1, 'the starved row is throttled');
});

test('12) 三种块大小实测：16000 / 1280 / 320 的 windowsFed 与 speechMs 一致（无模型/样本时跳过）', (t) => {
  const modelPath = process.env.DSH_VAD_MODEL
    || fileURLToPath(new URL('../models/silero_vad.onnx', import.meta.url));
  if (!existsSync(modelPath)) {
    t.skip(`未找到真实模型 ${modelPath}：设置 DSH_VAD_MODEL 或把 silero_vad.onnx 放到 <repo>/models`);
    return;
  }
  const wavPath = fileURLToPath(new URL('./fixtures/asr-cutpoint/offset-0.0.wav', import.meta.url));
  if (!existsSync(wavPath)) {
    t.skip('缺少 16k 单声道人声 fixture test/fixtures/asr-cutpoint/offset-0.0.wav');
    return;
  }
  const pcm = readWavPcm(wavPath);
  if (pcm === null) {
    t.skip('fixture 不是 16 kHz / 单声道 / 16-bit PCM WAV');
    return;
  }

  // The three shapes a real capture can hand over: one 1 s block, a 1280-sample ffmpeg chunk and a
  // 20 ms frame. They must not change the measurement — the shadow re-cuts every one of them.
  const total = Math.min(pcm.length, 12 * SAMPLE_RATE);
  const rows = [16000, 1280, 320].map((chunk) => {
    const vad = createSileroVad({ modelPath, sampleRate: SAMPLE_RATE });
    assert.ok(vad, 'the real model loads');
    const shadow = createVadShadow(vad, { sampleRate: SAMPLE_RATE });
    for (let offset = 0; offset < total; offset += chunk) {
      shadow.feed(pcm.slice(offset, Math.min(total, offset + chunk)));
    }
    const metrics = shadow.takeUtterance({ durationMs: Math.round(total / 16), energyVoicedRatio: 0.9 });
    assert.ok(metrics);
    return {
      chunk,
      windowsFed: metrics.windowsFed,
      vadFrames: metrics.vadFrames,
      speechMs: metrics.speechMs,
      zeroRatio: metrics.zeroRatio,
    };
  });
  console.table(rows);

  const expectedWindows = Math.floor(total / VAD_WINDOW_SIZE);
  for (const row of rows) {
    assert.equal(row.windowsFed, expectedWindows, `${row.chunk}: every complete window reaches the detector`);
    assert.equal(row.vadFrames, rows[0].vadFrames, `${row.chunk}: same closed segments`);
    assert.equal(row.speechMs, rows[0].speechMs, `${row.chunk}: same measured speech (got ${row.speechMs} ms)`);
    assert.ok(row.speechMs > 0, `${row.chunk}: speech is measured, not zero`);
    // The fixture holds real silence between phrases, so a few exact zeros are normal; a muted
    // capture would read 1.0 here.
    assert.ok(row.zeroRatio < 0.5, `${row.chunk}: a voiced fixture is not digital silence (${row.zeroRatio})`);
  }
});

test('13) 影子行诊断字段：静音 zeroRatio=1，人声 zeroRatio=0', () => {
  /** Feed `samples` in 1280-sample capture chunks (the real ffmpeg shape). */
  const feedChunks = (shadow, samples) => {
    for (let offset = 0; offset < samples.length; offset += 1280) {
      shadow.feed(samples.slice(offset, Math.min(samples.length, offset + 1280)));
    }
  };

  const silence = new Float32Array(3500 * 16);
  const quiet = createVadShadow(recordingVad());
  feedChunks(quiet, silence);
  const silent = quiet.takeUtterance({ durationMs: 3500 });
  assert.ok(silent);
  assert.equal(silent.samplesFed, 56000, 'the whole 3.5 s window was fed');
  assert.equal(silent.chunkSamples, 960, 'the last capture chunk is recorded (56000 % 1280)');
  assert.equal(silent.chunkPeak, 0);
  assert.equal(silent.chunkRms, 0);
  assert.equal(silent.zeroRatio, 1, 'digital silence is all zeros');
  assert.equal(silent.maxSilenceRun, 3500, 'the zero run covers the window');
  assert.equal(silent.threshold, 0.5, 'the applied threshold is recorded');

  const voiced = new Float32Array(3500 * 16);
  for (let index = 0; index < voiced.length; index += 1) voiced[index] = index % 2 === 0 ? 0.25 : -0.25;
  const loud = createVadShadow(recordingVad());
  feedChunks(loud, voiced);
  const speech = loud.takeUtterance({ durationMs: 3500 });
  assert.ok(speech);
  assert.equal(speech.zeroRatio, 0, 'a voiced signal has no exact-zero samples');
  assert.equal(speech.maxSilenceRun, 0);
  assert.equal(speech.chunkPeak, 0.25);
  assert.equal(speech.chunkRms, 0.25);
  assert.equal(speech.samplesFed, 56000);

  // A zero run that spans capture chunks is still one run (window-level, not chunk-level).
  const split = createVadShadow(recordingVad());
  split.feed(new Float32Array(1000));
  split.feed(new Float32Array(3000));
  const spanning = split.takeUtterance({ durationMs: 250 });
  assert.equal(spanning.maxSilenceRun, 250, '4000 zero samples = 250 ms, across two chunks');
});

test('14) 阈值可配：0.3 / 0.5 写进行内，且就是构造检测器时用的值；非法值回落 0.5', async () => {
  for (const [configured, expected] of [[0.3, 0.3], [0.5, 0.5], [2, 0.5], [-1, 0.5], ['x', 0.5]]) {
    const built = [];
    const { events } = await runClip({
      ms: 600,
      vadFactory: (options) => {
        built.push(options);
        return fakeVad({ segments: [{ startMs: 100, endMs: 500 }] });
      },
      extra: { vadThreshold: configured },
    });
    const [shadow] = vadShadows(events).map((event) => event.payload);
    assert.ok(shadow, `a row exists for threshold ${String(configured)}`);
    assert.equal(shadow.threshold, expected, `row records ${expected}`);
    assert.equal(built[0].threshold, expected, 'the detector was built with the same resolved threshold');
    assert.equal(shadow.speechMs, 400, 'a threshold change never alters delivery or the measurement');
  }
});

test('15) 影子行标记来源：麦克风 mic、回环 loopback，且 front(false) 后不再被外部缓冲杀死', async () => {
  // Mic lane, default device.
  {
    const { events, final } = await runClip({
      ms: 600,
      vadFactory: () => fakeVad({ segments: [{ startMs: 100, endMs: 500 }] }),
    });
    const [shadow] = vadShadows(events).map((event) => event.payload);
    assert.equal(shadow.source, 'mic');
    assert.equal(final.final, '好');
  }

  // Loopback lane: the same shadow, a different capture source.
  {
    const { events } = await runClip({
      ms: 600,
      extra: { device: 'CABLE Output (VB-Audio Virtual Cable)' },
      vadFactory: () => fakeVad({ segments: [{ startMs: 100, endMs: 500 }] }),
    });
    const [shadow] = vadShadows(events).map((event) => event.payload);
    assert.equal(shadow.source, 'loopback');
  }

  // The real-device failure: sherpa's default front() hands back an external ArrayBuffer, which
  // Electron's V8 rejects. The shadow must call front(false) and keep measuring.
  {
    const { events, final } = await runClip({
      ms: 600,
      vadFactory: () => externalBufferVad({ segments: [{ startMs: 100, endMs: 500 }] }),
    });
    const [shadow] = vadShadows(events).map((event) => event.payload);
    assert.ok(shadow, 'the shadow survives a segment that would have thrown in production');
    assert.equal(shadow.vadFrames, 1);
    assert.equal(shadow.speechMs, 400);
    assert.equal(shadow.source, 'mic');
    assert.equal(ofType(events, 'hearing.vad.unavailable').length, 0, 'no unavailable row');
    assert.equal(final.final, '好', 'delivery is unchanged');
  }
});

test('16) 默认开启的端点续说探针在短句上零事件，VAD 影子与投递不变', async () => {
  const { final, events } = await runClip({
    ms: 600,
    vadFactory: () => fakeVad({ segments: [{ startMs: 100, endMs: 500 }] }),
  });

  // 600 ms of speech has no 1.2 s trailing silence: the probe stays silent, so the existing VAD
  // contract and delivery are exactly what they were before the probe existed.
  assert.equal(ofType(events, 'hearing.endpoint.continuation').length, 0);
  assert.equal(ofType(events, 'hearing.endpoint.no-continuation').length, 0);
  assert.equal(vadShadows(events).length, 1, 'the VAD shadow is untouched');
  assert.equal(vadShadows(events)[0].payload.source, 'mic');
  assert.deepEqual(vadShadows(events).map((event) => event.payload.speechMs), [400]);
  assert.equal(final.final, '好');
});
