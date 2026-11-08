/**
 * Low-evidence delivery verdict — shadow first, gate opt-in.
 *
 * The field shape this suite reproduces: `endpointReason: 'silence'`, a 3.0–3.5 s clip,
 * a positive energy ratio (`voicedMs > 0` — room tone), a real Silero ratio of exactly 0,
 * empty streaming text and a non-empty offline decode ("The.", "我?"). The offline pass is the
 * only thing that "heard" a word, so the text must not be treated as evidence — but the first
 * round only records it:
 *  1. a low-evidence utterance writes `hearing.low-evidence.shadow` and is still delivered;
 *  2. with `lowEvidenceGate: true` the same utterance is withheld and `hearing.low-evidence.dropped`
 *     is written;
 *  3. a protected short answer (停/好/不/OK) is never low evidence — `whitelisted`, still delivered;
 *  4. a low-energy but real word (real VAD ratio > 0) passes;
 *  5. a non-empty streaming text passes, even when the offline pass is empty or different;
 *  6. the default (gate off) delivery is byte-for-byte the same as before this round;
 *  7. fields are complete and the shadow row is throttled, without touching delivery.
 *
 * No microphone, ffmpeg, sherpa model or real worker thread is used: every layer is injected.
 *
 * Run: node --test test/low-evidence-gate.mjs
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { lowEvidenceVerdict, parseUtteranceId, startHearing } from '../src/host/hearing/hearing.js';

const SAMPLE_RATE = 16000;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until `predicate()` is true; a missed deadline fails the test instead of hanging it. */
async function until(predicate, timeoutMs = 2000) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('timed out waiting for the verdict');
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

/** A 440 Hz tone at -12 dBFS: loud enough for the energy/RMS gates (it is room tone, not speech). */
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

/** Fake Silero detector: segments are fixed speech ranges; an empty list means "heard nothing". */
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

/** Worker stand-in mirroring `asr-worker.js`'s reply shape. */
function fakeWorker(text) {
  const worker = new EventEmitter();
  worker.unref = () => {};
  worker.terminate = () => {
    worker.emit('exit', null);
  };
  worker.postMessage = (message) => {
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
  ms = 3000,
  streamingText = '',
  workerText = 'The.',
  vadSegments = [],
  lowEvidenceGate = false,
} = {}) {
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
    vadFactory: () => fakeVad({ segments: vadSegments }),
    spawnProcess: () => child,
    lowEvidenceGate,
    onUpdate: (event) => updates.push(event),
    onEvent: (type, payload) => events.push({ type, payload }),
  });
  return { child, clip, updates, events, hearing };
}

/** Push one clip and wait for either its delivery or its low-evidence drop. */
async function runClip(options = {}) {
  const session = makeSession(options);
  const { child, clip, updates, events, hearing } = session;
  child.stdout.write(clip);
  await until(() => updates.some((event) => typeof event.final === 'string')
    || events.some((event) => event.type === 'hearing.low-evidence.dropped'));
  await delay(5);
  const finals = updates.filter((event) => typeof event.final === 'string');
  const stats = hearing.stats();
  hearing.stop();
  return { finals, final: finals[0], events, stats, session };
}

const ofType = (events, type) => events.filter((event) => event.type === type);
const lowShadows = (events) => ofType(events, 'hearing.low-evidence.shadow');
const lowSuppressed = (events) => ofType(events, 'hearing.low-evidence.shadow.suppressed');
const lowDropped = (events) => ofType(events, 'hearing.low-evidence.dropped');

/** Exactly one full low-evidence shadow row from one clip run. */
function onlyLowShadow(events) {
  const rows = lowShadows(events).map((event) => event.payload);
  assert.equal(rows.length, 1, 'exactly one full low-evidence row');
  return rows[0];
}

// ---------------------------------------------------------------------------
// 1. The 2066 / 2198 shape: shadow says low evidence, delivery unchanged
// ---------------------------------------------------------------------------

test('1) 2066/2198 型（vad=0, online 空, offline 有文本）：影子 lowEvidence=true，仍投递', async () => {
  const cases = [
    { ms: 3000, offline: 'The.', expectChars: 4 },
    { ms: 3500, offline: '我?', expectChars: 2 },
  ];
  for (const item of cases) {
    const { final, events, stats } = await runClip({
      ms: item.ms,
      streamingText: '',
      workerText: item.offline,
      vadSegments: [],
    });
    const shadow = onlyLowShadow(events);
    assert.equal(shadow.reason, 'silent-offline-hallucination');
    assert.equal(shadow.vadRatio, 0, 'the real VAD heard exactly zero speech');
    assert.equal(shadow.textChars, item.expectChars);
    assert.equal(shadow.delivered, true, 'shadow only: the clip is still delivered');
    assert.equal(lowDropped(events).length, 0, 'no gate is active by default');

    // The observed contradiction, reproduced: the energy meter hears the room tone, Silero does
    // not hear speech, and the offline pass still invented words.
    const noise = ofType(events, 'hearing.noise.shadow').map((event) => event.payload)[0];
    assert.ok(noise, 'the noise shadow still records the same utterance');
    assert.equal(noise.endpointReason, 'silence', 'no streaming token, trailing-silence rule');
    assert.ok(noise.voicedMs > 0, 'the energy meter reports "voiced"');
    assert.equal(noise.vadSpeechRatio, 0, 'the real VAD reports no speech');
    assert.equal(noise.energyVoicedRatio, 1, 'room tone is energy, not speech');

    assert.equal(final.final, item.offline, 'delivery is byte-for-byte unchanged');
    assert.equal(stats.finals, 1);
    assert.equal(stats.lowEvidenceDropped, 0);
  }
});

// ---------------------------------------------------------------------------
// 2. Opting in: the same shape is dropped, with one event
// ---------------------------------------------------------------------------

test('2) lowEvidenceGate=true：同型样本 drop，记 hearing.low-evidence.dropped', async () => {
  const { finals, events, stats } = await runClip({
    ms: 3000,
    streamingText: '',
    workerText: 'The.',
    vadSegments: [],
    lowEvidenceGate: true,
  });
  assert.equal(finals.length, 0, 'the hallucinated offline text is withheld');
  assert.equal(stats.finals, 0);
  assert.equal(stats.lowEvidenceDropped, 1, 'the applied gate counts its decision');
  const [dropped] = lowDropped(events).map((event) => event.payload);
  assert.ok(dropped, 'the drop is reported once');
  assert.equal(dropped.reason, 'silent-offline-hallucination');
  assert.equal(dropped.vadRatio, 0);
  assert.equal(dropped.textChars, 4);

  const shadow = onlyLowShadow(events);
  assert.equal(shadow.delivered, false, 'the shadow row reflects the real verdict');
});

// ---------------------------------------------------------------------------
// 3. A real short answer wins over the low-evidence shape
// ---------------------------------------------------------------------------

test('3) 真实短答「停」：vad=0 且流式为空也白名单放行', async () => {
  for (const text of ['停', '好', '不', 'OK']) {
    const { final, events, stats } = await runClip({
      ms: 600,
      streamingText: '',
      workerText: text,
      vadSegments: [],
      lowEvidenceGate: true,
    });
    assert.equal(final.final, text, `${text} must still be delivered with the gate on`);
    assert.equal(stats.lowEvidenceDropped, 0);
    assert.equal(lowDropped(events).length, 0);
    const shadow = onlyLowShadow(events);
    assert.equal(shadow.reason, 'whitelisted');
    assert.equal(shadow.delivered, true);
  }
});

// ---------------------------------------------------------------------------
// 4. Low energy but the real VAD did hear speech
// ---------------------------------------------------------------------------

test('4) vad>0 的低能量语音：不判低证据，门禁开启也放行', async () => {
  const { final, events, stats } = await runClip({
    ms: 600,
    streamingText: '',
    workerText: '你好',
    // 160 ms of speech in 600 ms = 0.267: quiet, but the detector heard it.
    vadSegments: [{ startMs: 100, endMs: 260 }],
    lowEvidenceGate: true,
  });
  assert.equal(final.final, '你好');
  assert.equal(stats.lowEvidenceDropped, 0);
  assert.equal(lowShadows(events).length, 0, 'a measured word is not a low-evidence candidate');
});

// ---------------------------------------------------------------------------
// 5. Streaming text is authoritative: no low-evidence verdict from offline alone
// ---------------------------------------------------------------------------

test('5) online 有文本：不因 offline 空/不同而误判', async () => {
  const same = await runClip({
    ms: 600,
    streamingText: '你好',
    workerText: '您好',
    vadSegments: [],
    lowEvidenceGate: true,
  });
  assert.equal(same.final.final, '您好', 'the offline refinement is still adopted as before');
  assert.equal(same.stats.lowEvidenceDropped, 0);
  assert.equal(lowShadows(same.events).length, 0);

  const offlineEmpty = await runClip({
    ms: 600,
    streamingText: '你好',
    workerText: '',
    vadSegments: [],
    lowEvidenceGate: true,
  });
  assert.equal(offlineEmpty.final.final, '你好', 'an empty accurate pass keeps the streaming text');
  assert.equal(offlineEmpty.stats.lowEvidenceDropped, 0);
  assert.equal(lowShadows(offlineEmpty.events).length, 0);
});

// ---------------------------------------------------------------------------
// 6. Gate off is the default and changes no delivery byte
// ---------------------------------------------------------------------------

test('6) 开关关闭 → 投递逐字不变（与未加门禁的行为对照）', async () => {
  const off = await runClip({ ms: 3500, streamingText: '', workerText: '我?', vadSegments: [] });
  assert.deepEqual(off.finals.map((event) => event.final), ['我?']);
  assert.equal(off.stats.finals, 1);
  assert.equal(off.stats.dropped + off.stats.hallucination, 0);

  // The same clip with the gate enabled is the only configuration that changes the outcome.
  const on = await runClip({
    ms: 3500, streamingText: '', workerText: '我?', vadSegments: [], lowEvidenceGate: true,
  });
  assert.deepEqual(on.finals, []);
  assert.equal(on.stats.lowEvidenceDropped, 1);

  // And the off path is identical when repeated: same text, same duration, same delivery count.
  const offAgain = await runClip({ ms: 3500, streamingText: '', workerText: '我?', vadSegments: [] });
  assert.deepEqual(offAgain.finals.map((event) => event.final), ['我?']);
  assert.equal(offAgain.final.durationMs, off.final.durationMs);
});

// ---------------------------------------------------------------------------
// 7. Field completeness and the log throttle
// ---------------------------------------------------------------------------

test('7) 事件字段齐全、无 undefined；30 秒内重复只写一条 + suppressed', async () => {
  const session = makeSession({ ms: 3000, streamingText: '', workerText: 'The.', vadSegments: [] });
  const { child, clip, updates, events, hearing } = session;
  const finals = () => updates.filter((event) => typeof event.final === 'string');
  child.stdout.write(clip);
  await until(() => finals().length === 1);
  child.stdout.write(clip);
  await until(() => finals().length === 2);
  await delay(5);

  const rows = lowShadows(events).map((event) => event.payload);
  assert.equal(rows.length, 1, 'one full row inside the throttle window');
  assert.deepEqual(Object.keys(rows[0]).sort(), [
    'delivered', 'level', 'reason', 'textChars', 'utteranceId', 'vadRatio',
  ]);
  assert.equal(rows[0].level, 'debug');
  assert.equal(parseUtteranceId(rows[0].utteranceId).seq, 1);
  assert.equal(parseUtteranceId(rows[0].utteranceId).instanceId, hearing.instanceId);
  assert.equal(rows[0].vadRatio, 0);
  assert.equal(rows[0].textChars, 4);
  assert.equal(rows[0].delivered, true);
  assert.ok(Object.values(rows[0]).every((value) => value !== undefined), 'no key is `undefined`');

  const suppressed = lowSuppressed(events).map((event) => event.payload);
  assert.equal(suppressed.length, 1);
  assert.equal(suppressed[0].count, 1);

  // Throttling is a log concern only: both utterances are still delivered.
  assert.deepEqual(finals().map((event) => event.final), ['The.', 'The.']);
  assert.equal(hearing.stats().finals, 2);
  hearing.stop();
});

// ---------------------------------------------------------------------------
// 8. Pure verdict contract
// ---------------------------------------------------------------------------

test('8) lowEvidenceVerdict 契约：五条件全满足才 true，白名单最后判', () => {
  const base = {
    text: 'The.',
    vadSpeechRatio: 0,
    onlineText: '',
    offlineText: 'The.',
    endpointReason: 'silence',
    durationMs: 3000,
  };
  assert.deepEqual(lowEvidenceVerdict(base), {
    lowEvidence: true, reason: 'silent-offline-hallucination', wouldDrop: true,
  });
  assert.deepEqual(lowEvidenceVerdict({ ...base, text: '我?', offlineText: '我?' }), {
    lowEvidence: true, reason: 'silent-offline-hallucination', wouldDrop: true,
  });

  // Whitelist is checked last: only a clip that would otherwise be low evidence reports it.
  assert.deepEqual(lowEvidenceVerdict({ ...base, text: '停', offlineText: '停' }), {
    lowEvidence: false, reason: 'whitelisted',
  });
  assert.deepEqual(lowEvidenceVerdict({ ...base, text: 'OK' }), {
    lowEvidence: false, reason: 'whitelisted',
  });
  // Whitelist also wins when checked directly against a protected word.
  assert.equal(lowEvidenceVerdict({ ...base, text: '好' }).lowEvidence, false);

  // Each missing condition names why it is not low evidence.
  assert.deepEqual(lowEvidenceVerdict({ ...base, vadSpeechRatio: null }), {
    lowEvidence: false, reason: 'no-vad',
  });
  assert.deepEqual(lowEvidenceVerdict({ ...base, vadSpeechRatio: 0.05 }), {
    lowEvidence: false, reason: 'vad-speech',
  });
  assert.deepEqual(lowEvidenceVerdict({ ...base, onlineText: '嗯' }), {
    lowEvidence: false, reason: 'online-text',
  });
  assert.deepEqual(lowEvidenceVerdict({ ...base, offlineText: '' }), {
    lowEvidence: false, reason: 'no-offline-text',
  });
  assert.deepEqual(lowEvidenceVerdict({ ...base, endpointReason: 'max-duration' }), {
    lowEvidence: false, reason: 'max-duration',
  });
  assert.deepEqual(lowEvidenceVerdict({ ...base, endpointReason: 'natural' }), {
    lowEvidence: false, reason: 'endpoint-other',
  });
  assert.deepEqual(lowEvidenceVerdict({ ...base, text: '' }), {
    lowEvidence: false, reason: 'no-text',
  });
  // Punctuation-only streaming text counts as empty, exactly like the shadow's text key.
  assert.deepEqual(lowEvidenceVerdict({ ...base, onlineText: '。' }), {
    lowEvidence: true, reason: 'silent-offline-hallucination', wouldDrop: true,
  });
  // The helper never throws on missing input.
  assert.equal(lowEvidenceVerdict().lowEvidence, false);
  assert.equal(lowEvidenceVerdict(null).lowEvidence, false);
});
