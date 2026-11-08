/**
 * Live ASR threshold + low-evidence gate switch.
 *
 * The reproduced bug: `startHearing` took `minRmsDb` once and kept it as a constant, so changing
 * `asrMinRmsDb` in settings showed the new value in `status.thresholdDb` while the running capture
 * still used the old floor (clips below the new floor were still delivered).
 *
 * This suite pins the fix:
 *  1. floor -30 at start, changed to -27 while running: the next rms -28 clip is withheld; changed
 *     back to -30: the same clip is delivered again;
 *  2. a throwing getter falls back to the startup value and never interrupts capture;
 *  3. a numeric `minRmsDb` behaves exactly like the old constant (regression, including the
 *     non-finite → -50 fallback);
 *  4. `lowEvidenceGate` as a function: false → delivered; true → dropped; false → delivered again,
 *     with the shadow row still written for every clip;
 *  5. `hearing.threshold.updated { from, to }` is written only on a real change, at debug level.
 *
 * No microphone, ffmpeg, sherpa model or real worker thread is used: the child process, the
 * streaming recognizer, the VAD detector and the worker are fakes, exactly like
 * `low-evidence-gate.mjs`. One written clip is exactly one utterance: the fake streaming pass
 * endpoints at the clip's last sample, and the tone's RMS is calibrated per test.
 *
 * Run: node --test test/hearing-live-threshold.mjs
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { startHearing } from '../src/host/hearing/hearing.js';

const SAMPLE_RATE = 16000;
/** One written clip is one utterance: the fake endpoint fires at exactly this many samples. */
const CLIP_MS = 800;
const CLIP_SAMPLES = Math.round((SAMPLE_RATE * CLIP_MS) / 1000);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until `predicate()` is true; a missed deadline fails the test instead of hanging it. */
async function until(predicate, timeoutMs = 3000) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('timed out waiting for the hearing result');
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
 * A 440 Hz tone whose sine RMS is exactly `db` dBFS (amplitude = 10^(db/20)·√2). 800 ms is 352
 * whole cycles at 440 Hz, so the sampled RMS matches the requested level without cycle error.
 */
function toneAtDb(db, ms = CLIP_MS, sampleRate = SAMPLE_RATE) {
  const amplitude = 10 ** (db / 20) * Math.SQRT2;
  const samples = new Int16Array(Math.round((sampleRate * ms) / 1000));
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = Math.round(Math.sin((2 * Math.PI * 440 * index) / sampleRate) * amplitude * 32767);
  }
  const buffer = Buffer.alloc(samples.length * 2);
  for (let index = 0; index < samples.length; index += 1) buffer.writeInt16LE(samples[index], index * 2);
  return buffer;
}

/** The RMS the hearing loop measures for the clip, in dB (report/debug value). */
function measuredDb(clip) {
  const count = clip.length / 2;
  let sumSquares = 0;
  for (let index = 0; index < count; index += 1) {
    const sample = clip.readInt16LE(index * 2) / 32768;
    sumSquares += sample * sample;
  }
  return 20 * Math.log10(Math.sqrt(sumSquares / count));
}

/** Streaming pass: one endpoint per written clip, optional streaming text. */
function fakeStreaming({ text = '' } = {}) {
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
    isEndpoint: (stream) => stream.samples >= CLIP_SAMPLES,
    reset(stream) {
      stream.samples = 0;
    },
  };
}

/** Fake Silero detector: an empty segment list means "heard no speech" (real VAD ratio 0). */
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
 * Worker stand-in mirroring `asr-worker.js`'s reply shape. `texts` is consumed one entry per
 * decode, so one running session can produce different offline texts for different utterances
 * (a throttled shadow row would otherwise hide the second low-evidence verdict).
 */
function fakeWorker(texts) {
  const queue = Array.isArray(texts) ? [...texts] : [texts];
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

/** Build one hearing session with every stage controllable and no real process/thread. */
function makeSession({
  minRmsDb,
  lowEvidenceGate,
  streamingText = '测试',
  workerTexts = ['测试'],
} = {}) {
  const child = new FakeChild();
  const updates = [];
  const events = [];
  const hearing = startHearing({
    ffmpegPath: 'ffmpeg-not-used',
    modelDir: 'models-not-used',
    finalModelDir: '',
    device: 'fake-device',
    recognizer: fakeStreaming({ text: streamingText }),
    asrWorkerFactory: () => fakeWorker(workerTexts),
    vadFactory: () => fakeVad({ segments: [] }),
    spawnProcess: () => child,
    minRmsDb,
    lowEvidenceGate,
    onUpdate: (event) => updates.push(event),
    onEvent: (type, payload) => events.push({ type, payload }),
  });
  return { child, updates, events, hearing };
}

const finals = (updates) => updates.filter((event) => typeof event.final === 'string');
const ofType = (events, type) => events.filter((event) => event.type === type);
const thresholdUpdated = (events) => ofType(events, 'hearing.threshold.updated');
const lowShadows = (events) => ofType(events, 'hearing.low-evidence.shadow');
const lowDropped = (events) => ofType(events, 'hearing.low-evidence.dropped');

/** Write exactly one clip and wait until the capture loop finished processing that chunk. */
async function feedClip({ child, hearing }, clip) {
  const before = hearing.stats().frames;
  child.stdout.write(clip);
  await until(() => hearing.stats().frames > before);
}

/**
 * One fixed sequence under one floor: a -28 dB clip (above -30, delivered), a -32 dB clip (below
 * -30, withheld), then the -28 dB clip again (delivered). Used to compare a number with a getter.
 */
async function runFloorSequence(minRmsDb) {
  const session = makeSession({ minRmsDb, streamingText: '测试' });
  const { updates, events, hearing } = session;
  try {
    await feedClip(session, toneAtDb(-28));
    await until(() => finals(updates).length === 1);
    // The -32 dB clip is withheld under a -30 floor but delivered under the -50 fallback. Wait for
    // whichever verdict this floor produces before the next clip: an open group would merge them.
    await feedClip(session, toneAtDb(-32));
    await until(() => finals(updates).length > 1 || hearing.stats().dropped === 1);
    await delay(20);
    const afterQuiet = finals(updates).length;
    await feedClip(session, toneAtDb(-28));
    await until(() => finals(updates).length === afterQuiet + 1);
    const stats = hearing.stats();
    return {
      finals: finals(updates).map((event) => event.final),
      afterQuiet,
      finalsCount: stats.finals,
      dropped: stats.dropped,
      thresholdEvents: thresholdUpdated(events).map((event) => event.payload),
    };
  } finally {
    hearing.stop();
  }
}

// ---------------------------------------------------------------------------
// 1. Changing the floor while the capture is running
// ---------------------------------------------------------------------------

test('1) 运行中改阈值 -30→-27：rms -28 的片段被拦；改回 -30 恢复投递', async () => {
  const floor = { db: -30 };
  const session = makeSession({ minRmsDb: () => floor.db, streamingText: '测试' });
  const { updates, hearing } = session;
  const clip = toneAtDb(-28);
  const measured = measuredDb(clip);
  assert.ok(Math.abs(measured + 28) < 0.2, `the clip must measure about -28 dB (got ${measured.toFixed(2)})`);
  try {
    // Startup floor -30: -28 is above it, so the clip is delivered.
    await feedClip(session, clip);
    await until(() => finals(updates).length === 1);
    assert.equal(hearing.stats().finals, 1);
    assert.equal(hearing.stats().dropped, 0);

    // The setting changes to -27 while the capture keeps running: -28 is now below the floor.
    floor.db = -27;
    await feedClip(session, clip);
    await delay(60);
    assert.equal(finals(updates).length, 1, 'rms -28 under a -27 floor must not be delivered');
    assert.equal(hearing.stats().finals, 1);
    assert.equal(hearing.stats().dropped, 1, 'the withheld clip is counted as dropped');

    // Changing it back to -30 must restore delivery on the same running session.
    floor.db = -30;
    await feedClip(session, clip);
    await until(() => finals(updates).length === 2);
    assert.deepEqual(finals(updates).map((event) => event.final), ['测试', '测试']);
    assert.equal(hearing.stats().finals, 2);
    assert.equal(hearing.stats().dropped, 1);

    // Two real changes, both reported with their actual values.
    assert.deepEqual(
      thresholdUpdated(session.events).map((event) => event.payload),
      [{ level: 'debug', from: -30, to: -27 }, { level: 'debug', from: -27, to: -30 }],
    );
  } finally {
    hearing.stop();
  }
});

// ---------------------------------------------------------------------------
// 2. A throwing getter keeps the startup value and never stops capture
// ---------------------------------------------------------------------------

test('2) getter 抛错：回退到启动值 -30，采集不中断', async () => {
  let mode = 'ok';
  const session = makeSession({
    minRmsDb: () => {
      if (mode === 'throw') throw new Error('settings read failed');
      return -30;
    },
    streamingText: '测试',
  });
  const { updates, events, hearing } = session;
  const loud = toneAtDb(-28);
  const quiet = toneAtDb(-32);
  try {
    // Startup floor -30.
    await feedClip(session, loud);
    await until(() => finals(updates).length === 1);
    assert.equal(hearing.stats().finals, 1);

    // From now on every resolution throws; the session must keep working with the startup value.
    mode = 'throw';
    await feedClip(session, loud);
    await until(() => finals(updates).length === 2);
    assert.equal(hearing.stats().finals, 2, 'capture continues after a throwing getter');
    assert.equal(hearing.stats().lastError, null);

    // -32 is below the fallback -30, so the fallback really is the startup value, not a guess.
    await feedClip(session, quiet);
    await delay(60);
    assert.equal(finals(updates).length, 2, 'a -32 clip stays below the -30 fallback');
    assert.equal(hearing.stats().dropped, 1);
    assert.ok(hearing.stats().frames >= 3, 'the capture loop is still running');
    assert.equal(thresholdUpdated(events).length, 0, 'a throw is a fallback, never a threshold change');
  } finally {
    hearing.stop();
  }
});

// ---------------------------------------------------------------------------
// 3. A number is unchanged from the old constant (regression)
// ---------------------------------------------------------------------------

test('3) 传数字与旧版完全一致（含 NaN → -50 回退）', async () => {
  const numeric = await runFloorSequence(-30);
  const getter = await runFloorSequence(() => -30);
  assert.deepEqual(numeric, {
    finals: ['测试', '测试'],
    afterQuiet: 1,
    finalsCount: 2,
    dropped: 1,
    thresholdEvents: [],
  });
  assert.deepEqual(getter, numeric, 'a constant getter is the same session as the number');
  assert.equal(numeric.thresholdEvents.length, 0, 'an unchanged value writes no event');

  // The old fallback `Number.isFinite(minRmsDb) ? minRmsDb : -50` is preserved: a non-finite
  // number behaves exactly like a -50 floor, so the -32 clip is *delivered*, not withheld.
  const nonFinite = await runFloorSequence(Number.NaN);
  assert.deepEqual(nonFinite.finals, ['测试', '测试', '测试']);
  assert.equal(nonFinite.finalsCount, 3);
  assert.equal(nonFinite.dropped, 0);
  assert.equal(nonFinite.afterQuiet, 2);
});

// ---------------------------------------------------------------------------
// 4. The low-evidence gate as a live getter
// ---------------------------------------------------------------------------

test('4) lowEvidenceGate 函数：false 投递 → true 丢弃 → false 恢复（影子事件仍在）', async () => {
  const gate = { open: false };
  const session = makeSession({
    minRmsDb: -50,
    lowEvidenceGate: () => gate.open === true,
    // The low-evidence shape: nothing streamed, the offline pass "heard" a word, VAD ratio 0.
    streamingText: '',
    workerTexts: ['The.', '我?', 'Way.'],
  });
  const { updates, events, hearing } = session;
  const clip = toneAtDb(-12);
  try {
    // 1) default off: the candidate is delivered and recorded by the shadow.
    await feedClip(session, clip);
    await until(() => finals(updates).length === 1);
    assert.equal(lowDropped(events).length, 0);

    // 2) the settings switch turns on: the *next* low-evidence clip is withheld.
    gate.open = true;
    await feedClip(session, clip);
    await until(() => lowDropped(events).length === 1);
    await delay(20);
    assert.equal(finals(updates).length, 1, 'the hallucinated offline text is withheld');
    assert.equal(hearing.stats().lowEvidenceDropped, 1);

    // 3) the settings switch turns off: delivery resumes without a restart.
    gate.open = false;
    await feedClip(session, clip);
    await until(() => finals(updates).length === 2);
    assert.deepEqual(finals(updates).map((event) => event.final), ['The.', 'Way.']);
    assert.equal(hearing.stats().lowEvidenceDropped, 1);

    // The shadow kept recording throughout: one full row per clip, delivered flag follows the switch.
    const rows = lowShadows(events).map((event) => event.payload);
    assert.deepEqual(rows.map((row) => [row.reason, row.delivered]), [
      ['silent-offline-hallucination', true],
      ['silent-offline-hallucination', false],
      ['silent-offline-hallucination', true],
    ]);
    assert.deepEqual(rows.map((row) => row.vadRatio), [0, 0, 0]);
    assert.deepEqual(rows.map((row) => row.textChars), [4, 2, 4]);
    assert.ok(rows.every((row) => row.level === 'debug'), 'shadow rows stay debug telemetry');
  } finally {
    hearing.stop();
  }
});

// ---------------------------------------------------------------------------
// 5. The change event: only on a real change, debug, exact payload
// ---------------------------------------------------------------------------

test('5) hearing.threshold.updated {from,to}：仅变化时写，level=debug', async () => {
  const floor = { db: -30 };
  const session = makeSession({ minRmsDb: () => floor.db, streamingText: '测试' });
  const { updates, events, hearing } = session;
  const clip = toneAtDb(-28);
  try {
    // First judgments all resolve the startup value: no event.
    await feedClip(session, clip);
    await until(() => finals(updates).length === 1);
    assert.equal(thresholdUpdated(events).length, 0);

    // One real change writes exactly one row.
    floor.db = -27;
    await feedClip(session, clip);
    await delay(60);
    assert.equal(thresholdUpdated(events).length, 1);

    // Resolving the same value again (another chunk) must not repeat the row.
    await feedClip(session, clip);
    await delay(60);
    assert.equal(thresholdUpdated(events).length, 1);

    // And the way back is a second real change.
    floor.db = -30;
    await feedClip(session, clip);
    await until(() => finals(updates).length === 2);

    const rows = thresholdUpdated(events).map((event) => event.payload);
    assert.deepEqual(rows, [
      { level: 'debug', from: -30, to: -27 },
      { level: 'debug', from: -27, to: -30 },
    ]);
    assert.ok(rows.every((row) => Object.keys(row).sort().join(',') === 'from,level,to'));
  } finally {
    hearing.stop();
  }
});
