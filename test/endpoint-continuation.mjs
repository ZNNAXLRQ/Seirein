/**
 * Endpoint-continuation probe (shadow): did the speaker resume before the 1.8 s endpoint?
 *
 * The probe is observation only. These tests pin its contract without a microphone, ffmpeg or a
 * real recognizer:
 *  1. speech → 1.3 s silence → speech (endpoint not reached) writes one
 *     `hearing.endpoint.continuation` with silenceMs ≈ 1200–1300 and continuedMs ≥ 1300;
 *  2. speech → silence to the 1.8 s endpoint writes one `hearing.endpoint.no-continuation`;
 *  3. a silence that never reaches 1.2 s writes neither row;
 *  4. `endpointProbe: false` writes zero probe rows (the only way to switch it off);
 *  5. the per-class 10 s throttle keeps one continuation row for two close utterances;
 *  6. delivery text and order are byte-for-byte identical with the probe on and off;
 *  7. every row names its lane (`source: mic | loopback`) and carries `level: 'debug'`.
 *
 * Run: node --test test/endpoint-continuation.mjs
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { CONTINUATION_PROBE_MS, startHearing } from '../src/host/hearing/hearing.js';

const SAMPLE_RATE = 16000;
const FRAME_SAMPLES = 320; // 20 ms, the probe's measurement frame
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(predicate, timeoutMs = 2000) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('timed out waiting for the delivery');
    await delay(5);
  }
}

/** ffmpeg stand-in: PCM written to `stdout` is treated as capture. */
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

/** A 440 Hz tone at -12 dBFS: above the energy floor, so it is a voiced frame. */
function tone(ms) {
  const samples = new Int16Array(Math.round((SAMPLE_RATE * ms) / 1000));
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = Math.round(Math.sin((2 * Math.PI * 440 * index) / SAMPLE_RATE) * 0.25 * 32767);
  }
  const buffer = Buffer.alloc(samples.length * 2);
  for (let index = 0; index < samples.length; index += 1) buffer.writeInt16LE(samples[index], index * 2);
  return buffer;
}

/** Digital silence: the probe's energy floor reads it as trailing silence. */
function silence(ms) {
  return Buffer.alloc(Math.round((SAMPLE_RATE * ms) / 1000) * 2);
}

/**
 * Streaming recognizer double whose endpoint follows the same 1.8 s trailing-silence rule the real
 * sherpa endpoint uses after text. It counts voiced frames exactly like the probe does, so a
 * continuation inside the silence cannot accidentally trigger the endpoint.
 */
function fakeEndpointRecognizer({ text = '好', endpointSilenceMs = 1800 } = {}) {
  const makeStream = () => ({
    samples: 0,
    trailingSilenceSamples: 0,
    acceptWaveform({ samples }) {
      this.samples += samples.length;
      for (let offset = 0; offset < samples.length; offset += FRAME_SAMPLES) {
        const frame = samples.subarray(offset, Math.min(samples.length, offset + FRAME_SAMPLES));
        let sumSquares = 0;
        for (const sample of frame) sumSquares += sample * sample;
        const voiced = sumSquares > 0
          && 20 * Math.log10(Math.sqrt(sumSquares / frame.length)) >= -50;
        if (voiced) this.trailingSilenceSamples = 0;
        else this.trailingSilenceSamples += frame.length;
      }
    },
  });
  return {
    createStream: makeStream,
    isReady: () => false,
    decode: () => {},
    getResult: (stream) => ({ text: stream.samples > 0 ? text : '' }),
    isEndpoint: (stream) => (stream.trailingSilenceSamples * 1000) / SAMPLE_RATE >= endpointSilenceMs,
    reset(stream) {
      stream.samples = 0;
      stream.trailingSilenceSamples = 0;
    },
  };
}

/** Worker stand-in: one reply per accurate pass, in call order. */
function fakeWorker(results) {
  const texts = Array.isArray(results) ? results : [results];
  let calls = 0;
  const worker = new EventEmitter();
  worker.messages = [];
  worker.unref = () => {};
  worker.terminate = () => worker.emit('exit', null);
  worker.postMessage = (message) => {
    worker.messages.push(message);
    const text = texts[Math.min(calls, texts.length - 1)];
    calls += 1;
    setImmediate(() => worker.emit('message', {
      type: 'result',
      id: message.id,
      utteranceId: message.utteranceId ?? null,
      segmentIds: [`${message.utteranceId ?? 's'}:s0`],
      text,
    }));
  };
  return worker;
}

/** Start one capture session, feed each clip, and wait for its final before writing the next. */
async function runClips({
  clips,
  endpointProbe,
  endpointProbeMs,
  device = 'fake-device',
  texts = '好',
  chunkSamples = 0,
}) {
  const child = new FakeChild();
  const updates = [];
  const events = [];
  const hearing = startHearing({
    ffmpegPath: 'ffmpeg-not-used',
    modelDir: 'models-not-used',
    finalModelDir: '',
    device,
    recognizer: fakeEndpointRecognizer({ endpointSilenceMs: 1800 }),
    asrWorkerFactory: () => fakeWorker(texts),
    spawnProcess: () => child,
    ...(endpointProbe === undefined ? {} : { endpointProbe }),
    ...(endpointProbeMs === undefined ? {} : { endpointProbeMs }),
    onUpdate: (event) => updates.push(event),
    onEvent: (type, payload) => events.push({ type, payload }),
  });
  const finals = () => updates.filter((event) => typeof event.final === 'string');
  for (const clip of clips) {
    const wanted = finals().length + 1;
    // `chunkSamples` mirrors a real ffmpeg block; 0 writes the clip as one block.
    const step = chunkSamples > 0 ? chunkSamples * 2 : clip.length;
    for (let offset = 0; offset < clip.length; offset += step) {
      child.stdout.write(clip.subarray(offset, Math.min(clip.length, offset + step)));
    }
    await until(() => finals().length === wanted);
  }
  await delay(10);
  return { child, hearing, updates, events, finals };
}

const ofType = (events, type) => events.filter((event) => event.type === type);
const continuations = (events) => ofType(events, 'hearing.endpoint.continuation');
const noContinuations = (events) => ofType(events, 'hearing.endpoint.no-continuation');

/** speech 600 ms → silence 1300 ms → speech 600 ms → silence 1800 ms (the endpoint) */
const CONTINUATION_CLIP = () => Buffer.concat([tone(600), silence(1300), tone(600), silence(1800)]);
/** speech 600 ms → silence 1800 ms (the endpoint; nothing resumed) */
const ENDPOINT_CLIP = () => Buffer.concat([tone(600), silence(1800)]);

test('1) 静音 1.3s 后续说：一条 continuation，silenceMs≈1200–1300，continuedMs≥1300', async () => {
  // 1280-sample blocks (80 ms), the shape a real ffmpeg capture hands over: the candidate and the
  // continuation must survive chunk boundaries, not only a single big write.
  const { hearing, events, finals } = await runClips({
    clips: [CONTINUATION_CLIP()],
    chunkSamples: 1280,
  });
  try {
    const rows = continuations(events);
    assert.equal(rows.length, 1, 'one continuation row for the resumed utterance');
    assert.equal(noContinuations(events).length, 0, 'a resumed utterance is not a no-continuation');
    const [row] = rows.map((event) => event.payload);
    assert.equal(row.utteranceId, 1);
    assert.equal(row.source, 'mic');
    assert.equal(row.probeMs, CONTINUATION_PROBE_MS, 'the default probe point is reported');
    assert.equal(CONTINUATION_PROBE_MS, 1200, 'the shipped probe default is 1.2 s');
    assert.equal(row.silenceMs, 1200, 'silence frozen when the 1200 ms probe point was crossed');
    assert.equal(row.continuedMs, 1300, 'the resumed word came after 1300 ms of silence');
    assert.equal(row.level, 'debug');
    assert.deepEqual(finals().map((event) => event.final), ['好'], 'delivery is unchanged');
  } finally {
    hearing.stop();
  }
});

test('2) 静音到 1.8s 端点：一条 no-continuation，没有 continuation', async () => {
  const { hearing, events, finals } = await runClips({ clips: [ENDPOINT_CLIP()] });
  try {
    const rows = noContinuations(events);
    assert.equal(rows.length, 1, 'the endpoint without a resume is recorded');
    assert.equal(continuations(events).length, 0);
    const [row] = rows.map((event) => event.payload);
    assert.equal(row.utteranceId, 1);
    assert.equal(row.source, 'mic');
    assert.equal(row.silenceMs, 1200, 'silence at the 1200 ms probe point');
    assert.equal(row.level, 'debug');
    assert.ok(!('continuedMs' in row), 'a non-resumed endpoint has no continuedMs');
    assert.deepEqual(finals().map((event) => event.final), ['好']);
  } finally {
    hearing.stop();
  }
});

test('3) 静音从未到 1.2s：两类事件都不出现', async () => {
  const child = new FakeChild();
  const events = [];
  const updates = [];
  const hearing = startHearing({
    ffmpegPath: 'ffmpeg-not-used',
    modelDir: 'models-not-used',
    finalModelDir: '',
    device: 'fake-device',
    recognizer: fakeEndpointRecognizer(),
    asrWorkerFactory: () => fakeWorker('好'),
    spawnProcess: () => child,
    onUpdate: (event) => updates.push(event),
    onEvent: (type, payload) => events.push({ type, payload }),
  });
  try {
    // speech → 1.0 s silence → speech: no candidate, and the fake endpoint (1.8 s) never fires.
    child.stdout.write(Buffer.concat([tone(600), silence(1000), tone(600)]));
    await delay(100);
    assert.equal(continuations(events).length, 0, 'no continuation below the probe point');
    assert.equal(noContinuations(events).length, 0, 'no endpoint row either');
    assert.equal(updates.filter((event) => typeof event.final === 'string').length, 0,
      'the utterance is still open, so nothing was finalized');
  } finally {
    hearing.stop();
  }
});

test('4) 关闭开关 endpointProbe:false：零探针事件，投递不变', async () => {
  const { hearing, events, finals } = await runClips({
    clips: [CONTINUATION_CLIP()],
    endpointProbe: false,
  });
  try {
    assert.equal(continuations(events).length, 0, 'the switch removes the continuation row');
    assert.equal(noContinuations(events).length, 0, 'and the no-continuation row');
    assert.deepEqual(finals().map((event) => event.final), ['好'], 'delivery text is unchanged');
  } finally {
    hearing.stop();
  }
});

test('5) 10s 节流：两次续说只留一条 continuation', async () => {
  const { hearing, events, finals } = await runClips({
    clips: [CONTINUATION_CLIP(), CONTINUATION_CLIP()],
    texts: ['一', '二'],
  });
  try {
    const rows = continuations(events);
    assert.equal(rows.length, 1, 'two continuations inside the 10 s window write one row');
    assert.equal(rows[0].payload.utteranceId, 1, 'the first occurrence is the one kept');
    assert.equal(noContinuations(events).length, 0);
    assert.deepEqual(finals().map((event) => event.final), ['一', '二'], 'both utterances still deliver');
  } finally {
    hearing.stop();
  }
});

test('6) 投递回归：开启/关闭探针的文本与顺序逐字一致', async () => {
  // One no-resume utterance, one resumed utterance, one no-resume utterance: the endpoint rules
  // and the accurate pass see the same audio either way.
  const clips = [
    ENDPOINT_CLIP(),
    CONTINUATION_CLIP(),
    ENDPOINT_CLIP(),
  ];
  const on = await runClips({ clips, texts: ['甲', '乙', '丙'] });
  const off = await runClips({ clips, texts: ['甲', '乙', '丙'], endpointProbe: false });
  try {
    assert.deepEqual(on.finals().map((event) => event.final), ['甲', '乙', '丙']);
    assert.deepEqual(off.finals().map((event) => event.final), ['甲', '乙', '丙']);
    assert.deepEqual(
      on.finals().map((event) => event.final),
      off.finals().map((event) => event.final),
      'the delivered text and order are byte-for-byte identical',
    );
    assert.ok(continuations(on.events).length + noContinuations(on.events).length > 0,
      'the probe was actually observing in the "on" session');
    assert.equal(continuations(off.events).length + noContinuations(off.events).length, 0,
      'the "off" session writes zero probe rows');
  } finally {
    on.hearing.stop();
    off.hearing.stop();
  }
});

test('7) 回环通道打上 loopback；探针点可配', async () => {
  const { hearing, events } = await runClips({
    clips: [CONTINUATION_CLIP()],
    device: 'CABLE Output (VB-Audio Virtual Cable)',
    endpointProbeMs: 800,
  });
  try {
    const [row] = continuations(events).map((event) => event.payload);
    assert.ok(row, 'the loopback lane also writes the continuation row');
    assert.equal(row.source, 'loopback');
    assert.equal(row.probeMs, 800, 'the configured probe point is reported');
    assert.equal(row.silenceMs, 800, 'the candidate moved to the configured 800 ms');
    assert.equal(row.continuedMs, 1300, 'the resumed word still came after 1.3 s of silence');
  } finally {
    hearing.stop();
  }
});
