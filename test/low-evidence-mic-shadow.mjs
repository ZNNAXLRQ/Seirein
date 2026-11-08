/**
 * Low-evidence mic recheck shadow (`hearing.low-evidence.mic-shadow`) — observation only.
 *
 * Real data: 25 low-evidence shadow rows, 22 of them on the loopback lane (BGM / animation audio,
 * harmless) and 3 on the mic. One mic row is 「还有。」 with `voicedRatio 0.31`, `rmsDb -22`,
 * `peakDb -1`, arriving right after a human answer — i.e. the energy meter heard voice and the
 * accurate pass decoded words while Silero reported zero speech. That is what a missed detection on
 * a short microphone utterance looks like, so enabling the low-evidence gate from that row could
 * drop a real answer. This suite pins the record-only contract:
 *  1. mic + `vadSpeechRatio === 0` + energy 0.31 + 「还有。」 → exactly one row, every field present,
 *     `delivered` as the verdict really stands, `text` cut at 40 characters;
 *  2. the loopback lane (the 22 harmless rows) writes nothing;
 *  3. Silero not running (`vadSpeechRatio === null`) writes nothing — an unmeasured detector is
 *     never read as "0 missed";
 *  4. low energy (0.05) writes nothing — "Silero heard nothing" alone is not a candidate;
 *  5. a protected short answer is recorded with `whitelisted: true` (and still delivered);
 *  6. delivery is unchanged: the same three clips deliver in the same order on mic and loopback —
 *     only the mic lane produces rows;
 *  7. regression of the neighbouring contracts: the existing `hearing.low-evidence.shadow` row keeps
 *     its exact shape, the gate still drops the same shape (`delivered: false` is recorded as such),
 *     one utterance id writes at most one row and the 10 s window turns a repeat into a count.
 *
 * No microphone, ffmpeg, sherpa model or real worker thread is used: the child process, the
 * streaming recognizer, the detector and the worker are all fakes. The clip is built so the energy
 * VAD measures a chosen ratio exactly (20 ms frames at 16 kHz).
 *
 * Run: node --test test/low-evidence-mic-shadow.mjs
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import {
  MIC_SHADOW_MIN_ENERGY_RATIO,
  MIC_SHADOW_TEXT_MAX_CHARS,
  createMicShadowLog,
  micShadowVerdict,
  truncateShadowText,
} from '../src/host/hearing/audio-evidence.js';
import { startHearing } from '../src/host/hearing/hearing.js';

const SAMPLE_RATE = 16000;
/** One energy-VAD frame: exactly one 20 ms frame, so the measured ratio is the frame ratio. */
const FRAME_SAMPLES = 320;

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

/**
 * A clip whose energy VAD measures `voicedFrames / totalFrames` exactly: the first `voicedFrames`
 * frames carry a 440 Hz tone at -12 dBFS, the rest sit at -60 dB, far outside the 24 dB dynamic
 * range the energy meter uses. 31 voiced frames out of 100 is the real 「还有。」 row (0.31).
 */
function energyClip({ voicedFrames = 31, totalFrames = 100 } = {}) {
  const samples = new Int16Array(totalFrames * FRAME_SAMPLES);
  for (let index = 0; index < samples.length; index += 1) {
    const frame = Math.floor(index / FRAME_SAMPLES);
    const amplitude = frame < voicedFrames ? 0.25 : 0.001;
    samples[index] = Math.round(
      Math.sin((2 * Math.PI * 440 * index) / SAMPLE_RATE) * amplitude * 32767,
    );
  }
  const buffer = Buffer.alloc(samples.length * 2);
  for (let index = 0; index < samples.length; index += 1) buffer.writeInt16LE(samples[index], index * 2);
  return buffer;
}

const clipDurationMs = (clip) => Math.round(clip.length / 2 / 16);

/** Streaming pass: the endpoint fires once the whole clip has been fed (one utterance per clip). */
function fakeStreaming({ endpointAtSamples, text = '' }) {
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

/** Fake Silero detector: `segments` are fixed speech ranges; an empty list means "heard nothing". */
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

/**
 * Worker stand-in mirroring `asr-worker.js`'s reply shape. `texts` is consumed one per decode, so a
 * multi-clip session can deliver a different sentence for every utterance.
 */
function fakeWorker(texts) {
  const queue = Array.isArray(texts) ? [...texts] : [texts ?? ''];
  const worker = new EventEmitter();
  worker.unref = () => {};
  worker.terminate = () => {
    worker.emit('exit', null);
  };
  worker.postMessage = (message) => {
    const text = queue.length > 1 ? queue.shift() : (queue[0] ?? '');
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

/**
 * One hearing session over `items` (one clip each, delivered sequentially) with every stage
 * controllable and no real process/thread. `device` picks the lane: any name without a loopback
 * marker is `mic`, "Stereo Mix" is `loopback`.
 */
async function runClips(items, {
  device = 'fake-device',
  vadSegments = [],
  useVad = true,
  lowEvidenceGate = false,
} = {}) {
  const child = new FakeChild();
  const updates = [];
  const events = [];
  const clips = items.map((item) => energyClip(item));
  const hearing = startHearing({
    ffmpegPath: 'ffmpeg-not-used',
    modelDir: 'models-not-used',
    finalModelDir: '',
    device,
    // The whole clip is the utterance: the endpoint fires on the last fed sample. Every clip in one
    // session has the same length, so one threshold ends each of them exactly once.
    recognizer: fakeStreaming({ endpointAtSamples: Math.min(...clips.map((clip) => clip.length / 2)), text: '' }),
    asrWorkerFactory: () => fakeWorker(items.map((item) => item.text ?? '')),
    spawnProcess: () => child,
    lowEvidenceGate,
    ...(useVad ? { vadFactory: () => fakeVad({ segments: vadSegments }) } : {}),
    // A missing model file is how Silero "is not running": the ratio stays null, never 0.
    ...(useVad ? {} : { vadModelPath: 'C:/definitely/missing/silero_vad.onnx' }),
    onUpdate: (event) => updates.push(event),
    onEvent: (type, payload) => events.push({ type, payload }),
  });

  const finals = () => updates.filter((event) => typeof event.final === 'string');
  // One clip settles as either a delivery or a withheld verdict (the opt-in gate case).
  const withheld = () => events.filter(
    (event) => event.type === 'hearing.low-evidence.dropped' || event.type === 'hearing.echo.dropped',
  );
  const settled = () => finals().length + withheld().length;
  for (let index = 0; index < clips.length; index += 1) {
    child.stdout.write(clips[index]);
    await until(() => settled() >= index + 1);
  }
  await delay(10);
  const stats = hearing.stats();
  hearing.stop();
  return { finals: finals(), events, stats };
}

/** One clip, one session — the common case. */
const runClip = (item, options = {}) => runClips([item], options);

const ofType = (events, type) => events.filter((event) => event.type === type);
const micRows = (events) => ofType(events, 'hearing.low-evidence.mic-shadow');
const micSuppressed = (events) => ofType(events, 'hearing.low-evidence.mic-shadow.suppressed');
const lowShadows = (events) => ofType(events, 'hearing.low-evidence.shadow');
const lowDropped = (events) => ofType(events, 'hearing.low-evidence.dropped');

/** Exactly one full mic row from one clip run. */
function onlyMicRow(events) {
  const rows = micRows(events).map((event) => event.payload);
  assert.equal(rows.length, 1, 'exactly one mic row');
  return rows[0];
}

// ---------------------------------------------------------------------------
// 1. The real 「还有。」 shape: one complete row, delivery untouched
// ---------------------------------------------------------------------------

test('1) mic + vad=0 + 能量 0.31 + 「还有。」：写一条，字段齐全、delivered 如实', async () => {
  const item = { voicedFrames: 31, text: '还有。' };
  const { finals, events, stats } = await runClip(item);

  const row = onlyMicRow(events);
  assert.deepEqual(Object.keys(row).sort(), [
    'delivered', 'durationMs', 'energyVoicedRatio', 'level', 'peakDb', 'rmsDb',
    'text', 'textChars', 'utteranceId', 'vadSpeechRatio', 'whitelisted',
  ], 'the row carries exactly the documented fields');
  assert.ok(Object.values(row).every((value) => value !== undefined), 'no key is `undefined`');

  // The measured values, not estimates: the energy meter vs the real detector.
  assert.equal(row.vadSpeechRatio, 0, 'Silero reported exactly zero speech');
  assert.equal(row.energyVoicedRatio, 0.31, 'the volume meter heard voice in 31% of the clip');
  assert.equal(row.rmsDb, -20, 'loud enough to be a real utterance (the real row was -22)');
  assert.equal(row.peakDb, -12, 'a real peak, not a click at the noise floor');
  assert.equal(row.durationMs, clipDurationMs(energyClip(item)), 'the whole clip');
  assert.equal(row.utteranceId, 1);
  assert.equal(row.text, '还有。');
  assert.equal(row.textChars, 3);
  assert.equal(row.whitelisted, false, 'a sentence is not a protected short answer');
  assert.equal(row.level, 'debug');

  // The verdict the row observes: this clip was delivered, because the gate is off by default.
  assert.equal(row.delivered, true, 'delivered is recorded as it really stands');
  assert.deepEqual(finals.map((event) => event.final), ['还有。'], 'the answer is still delivered');
  assert.equal(stats.finals, 1);
  assert.equal(stats.lowEvidenceDropped, 0);

  // `text` is cut at 40 characters; `textChars` keeps the full length.
  const longText = '这是一次很长的麦克风短句用来验证影子文本会截断到四十个字为止然后再多写一些内容凑长度';
  const long = await runClip({ voicedFrames: 31, text: longText });
  const longRow = onlyMicRow(long.events);
  assert.equal(MIC_SHADOW_TEXT_MAX_CHARS, 40);
  assert.equal([...longText].length > 40, true, 'the fixture is longer than the row limit');
  assert.equal(longRow.textChars, [...longText].length, 'the full length is kept');
  assert.equal([...longRow.text].length, 40, 'text is truncated to 40 characters');
  assert.equal(longRow.text, [...longText].slice(0, 40).join(''));
  assert.deepEqual(long.finals.map((event) => event.final), [longText], 'nothing is cut from delivery');
});

// ---------------------------------------------------------------------------
// 2. The loopback lane: none of these rows
// ---------------------------------------------------------------------------

test('2) 回环来源（BGM/动画声）：不写 mic 影子，既有低证据影子照旧', async () => {
  const { finals, events, stats } = await runClip(
    { voicedFrames: 31, text: '还有。' },
    { device: 'Stereo Mix (Realtek(R) Audio)' },
  );

  assert.equal(micRows(events).length, 0, 'the loopback lane never writes a mic row');
  assert.equal(micSuppressed(events).length, 0);
  assert.deepEqual(finals.map((event) => event.final), ['还有。'], 'delivery is unchanged');
  assert.equal(stats.finals, 1);

  // The 22 harmless rows keep being recorded exactly as before: only the new row is mic-only.
  const [low] = lowShadows(events).map((event) => event.payload);
  assert.ok(low, 'the low-evidence shadow still records the loopback clip');
  assert.equal(low.reason, 'silent-offline-hallucination');
});

// ---------------------------------------------------------------------------
// 3. Silero not running: null is not zero
// ---------------------------------------------------------------------------

test('3) silero 未运行（vadSpeechRatio=null）：不写，不把未测量当成 0', async () => {
  const { finals, events } = await runClip({ voicedFrames: 31, text: '还有。' }, { useVad: false });

  assert.equal(micRows(events).length, 0, 'an unmeasured detector is not a missed detection');
  assert.equal(micSuppressed(events).length, 0);
  // Proof that the detector really was not running, and that the ratio is null — not 0.
  const [noise] = ofType(events, 'hearing.noise.shadow').map((event) => event.payload);
  assert.equal(noise.vadSpeechRatio, null);
  assert.equal(noise.vadRatioSource, null);
  assert.equal(noise.energyVoicedRatio, 0.31, 'the energy meter still measured the clip');
  assert.deepEqual(finals.map((event) => event.final), ['还有。']);
});

// ---------------------------------------------------------------------------
// 4. Low energy: "Silero heard nothing" is not enough on its own
// ---------------------------------------------------------------------------

test('4) 能量低（0.05）：不写', async () => {
  const { finals, events } = await runClip({ voicedFrames: 5, text: '还有。' });

  assert.equal(micRows(events).length, 0, 'a quiet clip is not a Silero-miss candidate');
  const [noise] = ofType(events, 'hearing.noise.shadow').map((event) => event.payload);
  assert.equal(noise.energyVoicedRatio, 0.05, 'the measured ratio is what rules the row out');
  assert.equal(noise.vadSpeechRatio, 0);
  assert.deepEqual(finals.map((event) => event.final), ['还有。'], 'delivery is unchanged');
  assert.equal(MIC_SHADOW_MIN_ENERGY_RATIO, 0.15, 'the recorded threshold');
});

// ---------------------------------------------------------------------------
// 5. A protected short answer is recorded, not filtered
// ---------------------------------------------------------------------------

test('5) 白名单短答：写一条但 whitelisted=true，仍投递', async () => {
  for (const text of ['好', '停', 'OK']) {
    const { finals, events, stats } = await runClip({ voicedFrames: 31, text });

    const row = onlyMicRow(events);
    assert.equal(row.whitelisted, true, `${text} is a protected short answer`);
    assert.equal(row.text, text);
    assert.equal(row.vadSpeechRatio, 0);
    assert.equal(row.energyVoicedRatio, 0.31);
    assert.equal(row.delivered, true, 'recorded with the real verdict');
    assert.deepEqual(finals.map((event) => event.final), [text], 'the answer is still delivered');
    assert.equal(stats.finals, 1);
    assert.equal(stats.lowEvidenceDropped, 0);
  }
});

// ---------------------------------------------------------------------------
// 6. Delivery is unchanged: same three clips, same order, only the mic lane logs
// ---------------------------------------------------------------------------

test('6) 不改变投递：同一组三句在 mic / 回环上顺序完全一致', async () => {
  const items = [
    { voicedFrames: 31, text: '还有。' }, // qualifies
    { voicedFrames: 31, text: '好' }, // qualifies + whitelisted
    { voicedFrames: 5, text: '今天天气不错' }, // energy too low → no row
  ];
  const mic = await runClips(items, { device: 'fake-device' });
  const loopback = await runClips(items, { device: 'Stereo Mix (Realtek(R) Audio)' });

  const micOrder = mic.finals.map((event) => event.final);
  const loopOrder = loopback.finals.map((event) => event.final);
  assert.deepEqual(micOrder, ['还有。', '好', '今天天气不错'], 'mic delivery order');
  assert.deepEqual(loopOrder, micOrder, 'the shadow changes no delivery byte or order');
  assert.equal(mic.stats.finals, 3);
  assert.equal(loopback.stats.finals, 3);

  const rows = micRows(mic.events).map((event) => event.payload);
  assert.deepEqual(rows.map((row) => row.utteranceId), [1, 2], 'one row per qualifying utterance');
  assert.deepEqual(rows.map((row) => row.delivered), [true, true]);
  assert.equal(micRows(loopback.events).length, 0, 'the loopback run logs nothing new');
  // The third clip is the control: it was delivered and wrote no mic row.
  assert.equal(micRows(mic.events).some((event) => event.payload.utteranceId === 3), false);
});

// ---------------------------------------------------------------------------
// 7. Neighbouring contracts: the old shadow, the gate, and the log throttle
// ---------------------------------------------------------------------------

test('7) 既有 low-evidence 影子/门禁不变；同一 utteranceId 只一条 + 10 秒节流', async () => {
  // 7a. The existing low-evidence shadow row keeps its exact shape next to the new row.
  const off = await runClip({ voicedFrames: 31, text: '还有。' });
  const [low] = lowShadows(off.events).map((event) => event.payload);
  assert.deepEqual(Object.keys(low).sort(), [
    'delivered', 'level', 'reason', 'textChars', 'utteranceId', 'vadRatio',
  ], 'the low-evidence row is untouched');
  assert.equal(low.delivered, true);
  assert.equal(onlyMicRow(off.events).delivered, true);

  // 7b. Gate on: the same clip is withheld, and `delivered: false` is recorded as it stands.
  const on = await runClip({ voicedFrames: 31, text: '还有。' }, { lowEvidenceGate: true });
  assert.deepEqual(on.finals, [], 'the gate still withholds the same shape');
  assert.equal(on.stats.lowEvidenceDropped, 1);
  assert.equal(lowDropped(on.events).length, 1);
  const gated = onlyMicRow(on.events);
  assert.equal(gated.delivered, false, 'the shadow row follows the real verdict');
  assert.equal(gated.utteranceId, 1);
  // Observation only: the new row never withheld anything on its own (counters are the gate's).
  assert.equal(off.stats.lowEvidenceDropped, 0);

  // 7c. Pure contract: each missing condition names itself.
  const base = { source: 'mic', text: '还有。', vadSpeechRatio: 0, energyVoicedRatio: 0.31 };
  assert.deepEqual(micShadowVerdict(base), { shadow: true, reason: 'mic-low-evidence' });
  assert.deepEqual(micShadowVerdict({ ...base, source: 'loopback' }), { shadow: false, reason: 'not-mic' });
  assert.deepEqual(micShadowVerdict({ ...base, source: 'unknown' }), { shadow: false, reason: 'not-mic' });
  assert.deepEqual(micShadowVerdict({ ...base, text: '' }), { shadow: false, reason: 'no-text' });
  assert.deepEqual(micShadowVerdict({ ...base, text: '。，！' }), { shadow: false, reason: 'no-text' });
  assert.deepEqual(micShadowVerdict({ ...base, vadSpeechRatio: null }), { shadow: false, reason: 'no-vad' });
  assert.deepEqual(micShadowVerdict({ ...base, vadSpeechRatio: undefined }), { shadow: false, reason: 'no-vad' });
  assert.deepEqual(micShadowVerdict({ ...base, vadSpeechRatio: 0.05 }), { shadow: false, reason: 'vad-speech' });
  assert.deepEqual(micShadowVerdict({ ...base, energyVoicedRatio: null }), { shadow: false, reason: 'low-energy' });
  assert.deepEqual(micShadowVerdict({ ...base, energyVoicedRatio: 0.15 }), { shadow: false, reason: 'low-energy' });
  assert.equal(micShadowVerdict().shadow, false, 'never throws on missing input');
  assert.equal(micShadowVerdict(null).shadow, false);
  // The 40-character cut is a record concern only, and never invents text.
  const forty = '一二三四五六七八九十'.repeat(4);
  assert.equal([...forty].length, 40);
  assert.equal(truncateShadowText(`${forty}甲`), forty);
  assert.equal(truncateShadowText('短', 40), '短');
  assert.equal(truncateShadowText(null), '');
  assert.equal(truncateShadowText('', 40), '');

  // 7d. One utterance id writes at most one row; a repeat inside the window is only a count.
  const log = createMicShadowLog();
  assert.deepEqual(log.admit({ utteranceId: 7, at: 1000, textKey: '还有' }), {
    write: true, duplicate: false, count: 0,
  });
  assert.deepEqual(log.admit({ utteranceId: 7, at: 1500, textKey: '还有' }), {
    write: false, duplicate: true, count: 0,
  }, 'the same utterance id is never a second row');
  assert.deepEqual(log.admit({ utteranceId: 8, at: 2000, textKey: '还有' }), {
    write: false, duplicate: false, count: 1,
  }, 'the same text inside 10 s is a suppressed count');
  assert.deepEqual(log.admit({ utteranceId: 9, at: 11000, textKey: '还有' }), {
    write: true, duplicate: false, count: 0,
  }, 'outside the 10 s window it is a new row');
});
