/**
 * Hearing-side daily speaker-candidate seam (collect only; the host is not wired yet).
 *
 * The fake embedder/library/delivery drive the real `startHearing`; no microphone, ffmpeg, sherpa
 * model or ONNX session is used:
 *  1. a mic `ok` clip ≥800 ms offers exactly one sample; embedding/samples are fresh copies with the
 *     right lengths and content, while delivery and the `speaker.shadow` row stay unchanged;
 *  2. a loopback clip computes an embedding but never offers a candidate;
 *  3. short (<600 ms), quiet (quality=quiet) and 600–799 ms `ok` clips do not offer a candidate;
 *  4. a listener that throws (or rejects) never changes delivery, the shadow row or the counters.
 *
 * Run: node --test test/hearing-speaker-candidates.mjs
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { parseUtteranceId, startHearing } from '../src/host/hearing/hearing.js';

const SAMPLE_RATE = 16000;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until `predicate()` is true; a missed deadline fails the test instead of hanging it. */
async function until(predicate, label, timeoutMs = 3000) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) assert.fail(`timed out: ${label}`);
    await delay(5);
  }
}

/** ffmpeg stand-in: the test writes PCM into `stdout`; the hearing loop treats it as capture. */
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

/** A 440 Hz tone at -12 dBFS (or the given peak amplitude): loud enough to pass the RMS gate. */
function tone(ms, amplitude = 0.25) {
  const samples = new Int16Array(Math.round((SAMPLE_RATE * ms) / 1000));
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = Math.round(Math.sin((2 * Math.PI * 440 * index) / SAMPLE_RATE) * amplitude * 32767);
  }
  const buffer = Buffer.alloc(samples.length * 2);
  for (let index = 0; index < samples.length; index += 1) buffer.writeInt16LE(samples[index], index * 2);
  return buffer;
}

/** Streaming pass: the endpoint fires once the clip reaches `endpointAtSamples`. */
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

/** Worker stand-in mirroring `asr-worker.js`'s reply shape. */
function fakeWorker(text) {
  const worker = new EventEmitter();
  worker.unref = () => {};
  worker.terminate = () => {
    worker.emit('exit', null);
  };
  worker.postMessage = (message) => {
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

const ofType = (events, type) => events.filter((event) => event.type === type);
const vector = (values) => Float32Array.from(values);

/** Fake embedder whose calls (the exact audio handed to it) and result are inspectable. */
function fakeEmbedder(result = vector([0.9, 0.3, 0.1, 0.2])) {
  const state = { calls: [], result };
  state.factory = () => ({
    embed(samples) {
      state.calls.push(samples);
      return state.result;
    },
  });
  return state;
}

/** Fake speaker library: one enrolled, enabled speaker and a fixed match verdict. */
function fakeLibrary(decision = 'match') {
  return {
    list: () => [{ id: 'alice', enabled: true }],
    match: () => ({
      decision,
      score: 0.99,
      speakerId: 'alice',
      runnerUpScore: 0.1,
      margin: 0.89,
    }),
  };
}

/**
 * Start one fake hearing session, push one clip, wait for its delivered final (optionally one
 * event), then return the collected updates/events and the session stats.
 */
async function runClip(t, {
  ms = 1000,
  amplitude = 0.25,
  device = 'fake-device',
  workerText = '好',
  embedder = fakeEmbedder(),
  library = fakeLibrary(),
  onSpeakerSample,
  waitFor = 'speaker.shadow',
} = {}) {
  const child = new FakeChild();
  const updates = [];
  const events = [];
  const clip = tone(ms, amplitude);
  const hearing = startHearing({
    ffmpegPath: 'ffmpeg-not-used',
    modelDir: 'models-not-used',
    finalModelDir: '',
    device,
    recognizer: fakeStreaming({ endpointAtSamples: clip.length / 2, text: '好' }),
    spawnProcess: () => child,
    asrWorkerFactory: () => fakeWorker(workerText),
    speakerShadow: true,
    speakerEmbedderFactory: embedder.factory,
    speakerLibrary: library,
    onSpeakerSample,
    onUpdate: (event) => updates.push(event),
    onEvent: (type, payload) => events.push({ type, payload }),
  });
  t.after(() => hearing.stop());

  child.stdout.write(clip);
  await until(() => updates.some((event) => typeof event.final === 'string'), 'the delivered final');
  if (waitFor !== null) await until(() => ofType(events, waitFor).length > 0, waitFor);
  await delay(30);

  const finals = updates.filter((event) => typeof event.final === 'string');
  return { finals, final: finals[0], events, stats: hearing.stats(), embedder };
}

// ---------------------------------------------------------------------------
// 1. mic + ok + >= 800 ms: one sample, copies, unchanged delivery/shadow
// ---------------------------------------------------------------------------

test('1) mic/ok/≥800ms：回调一次，embedding 与 samples 为独立副本', async (t) => {
  const embedder = fakeEmbedder(vector([0.9, 0.3, 0.1, 0.2]));
  const samples = [];
  const { finals, final, events, stats } = await runClip(t, {
    ms: 1000,
    embedder,
    onSpeakerSample: (sample) => samples.push(sample),
  });
  await until(() => samples.length > 0, 'onSpeakerSample');

  assert.equal(samples.length, 1, 'exactly one candidate for one utterance');
  const [sample] = samples;
  assert.deepEqual(
    Object.keys(sample).sort(),
    ['decision', 'durationMs', 'embedding', 'quality', 'sampleRate', 'samples', 'score', 'source', 'speakerId', 'text', 'utteranceId'],
  );
  assert.equal(sample.utteranceId, final.utteranceId, 'the candidate carries the delivered utterance id');
  assert.equal(parseUtteranceId(sample.utteranceId).seq, 1);

  assert.ok(sample.embedding instanceof Float32Array);
  assert.deepEqual([...sample.embedding], [...embedder.result], 'the copy keeps the embedding values');
  assert.notStrictEqual(sample.embedding, embedder.result, 'the embedding is a copy, not the embedder buffer');

  assert.ok(sample.samples instanceof Float32Array);
  assert.equal(sample.samples.length, SAMPLE_RATE, '1 s at 16 kHz');
  assert.notStrictEqual(sample.samples, embedder.calls[0], 'the PCM is a copy, not the internal capture buffer');
  const peak = sample.samples.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
  assert.ok(peak > 0.24 && peak <= 0.26, `the copied PCM keeps the tone level: ${peak}`);
  const internalFirst = embedder.calls[0][0];
  sample.samples[0] = 0.999;
  assert.equal(embedder.calls[0][0], internalFirst, 'mutating the copy cannot touch capture state');

  assert.equal(sample.sampleRate, 16000);
  assert.equal(sample.durationMs, 1000);
  assert.equal(sample.source, 'mic');
  assert.equal(sample.quality, 'ok');
  assert.equal(sample.decision, 'match');
  assert.equal(sample.text, '好');

  assert.deepEqual(finals.map((event) => event.final), ['好'], 'delivery is byte-identical');
  assert.equal(stats.finals, 1);
  const [shadow] = ofType(events, 'speaker.shadow').map((event) => event.payload);
  assert.equal(shadow.decision, 'match', 'the shadow row is still written');
  assert.equal(shadow.quality, 'ok');
  console.log(
    `[hearing-speaker-candidates 1] calls=${samples.length} embeddingLen=${sample.embedding.length} `
    + `samplesLen=${sample.samples.length} durationMs=${sample.durationMs} source=${sample.source} `
    + `quality=${sample.quality} decision=${sample.decision} final=${final.final}`,
  );
});

// ---------------------------------------------------------------------------
// 2. loopback is never collected
// ---------------------------------------------------------------------------

test('2) loopback：即便算出了 embedding，也不触发候选', async (t) => {
  const embedder = fakeEmbedder();
  const samples = [];
  const { finals, events } = await runClip(t, {
    ms: 1000,
    device: 'CABLE Input (VB-Audio Virtual Cable)',
    embedder,
    onSpeakerSample: (sample) => samples.push(sample),
  });

  assert.equal(samples.length, 0, 'the loopback lane never becomes a candidate');
  assert.equal(embedder.calls.length, 1, 'the shadow still computed an embedding');
  const [shadow] = ofType(events, 'speaker.shadow').map((event) => event.payload);
  assert.equal(shadow.source, 'loopback');
  assert.equal(shadow.decision, 'match', 'the loopback row is unchanged');
  assert.deepEqual(finals.map((event) => event.final), ['好']);
  console.log(
    `[hearing-speaker-candidates 2] candidates=${samples.length} embedCalls=${embedder.calls.length} `
    + `source=${shadow.source} decision=${shadow.decision}`,
  );
});

// ---------------------------------------------------------------------------
// 3. short / quiet / 600–799 ms never trigger
// ---------------------------------------------------------------------------

test('3) short / quiet / too-short：不触发候选', async (t) => {
  const candidates = [];
  const onSpeakerSample = (sample) => candidates.push(sample);

  const short = fakeEmbedder();
  const shortRun = await runClip(t, { ms: 400, embedder: short, onSpeakerSample });
  assert.equal(candidates.length, 0, 'a <600 ms clip never embeds and never becomes a candidate');
  assert.equal(short.calls.length, 0);
  const [shortShadow] = ofType(shortRun.events, 'speaker.shadow').map((event) => event.payload);
  assert.equal(shortShadow.quality, 'short');
  assert.equal(shortShadow.decision, 'unsure');

  const quiet = fakeEmbedder();
  const quietRun = await runClip(t, { ms: 1000, amplitude: 0.008, embedder: quiet, onSpeakerSample });
  assert.equal(candidates.length, 0, 'a quiet clip is never a candidate');
  assert.equal(quiet.calls.length, 1, 'the shadow still computed its embedding');
  const [quietShadow] = ofType(quietRun.events, 'speaker.shadow').map((event) => event.payload);
  assert.equal(quietShadow.quality, 'quiet');
  assert.equal(quietShadow.decision, 'unsure');

  const tooShort = fakeEmbedder();
  const shortOkRun = await runClip(t, { ms: 700, embedder: tooShort, onSpeakerSample });
  assert.equal(candidates.length, 0, '600–799 ms is below the candidate floor');
  assert.equal(tooShort.calls.length, 1);
  const [shortOkShadow] = ofType(shortOkRun.events, 'speaker.shadow').map((event) => event.payload);
  assert.equal(shortOkShadow.quality, 'ok', 'quality alone would pass; the duration floor is the gate');
  assert.equal(shortOkShadow.decision, 'match');
  assert.deepEqual(shortRun.finals.map((event) => event.final), ['好']);
  assert.deepEqual(quietRun.finals.map((event) => event.final), ['好']);
  assert.deepEqual(shortOkRun.finals.map((event) => event.final), ['好']);
  console.log(
    `[hearing-speaker-candidates 3] candidates=${candidates.length} `
    + `short=${shortShadow.quality}/${short.calls.length} `
    + `quiet=${quietShadow.quality}/${quiet.calls.length} `
    + `700ms=${shortOkShadow.quality}/${tooShort.calls.length}`,
  );
});

// ---------------------------------------------------------------------------
// 4. A throwing / rejecting listener changes nothing
// ---------------------------------------------------------------------------

test('4) 回调抛错/拒绝：投递、影子与计数都不受影响', async (t) => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));

  let thrown = 0;
  const throwing = await runClip(t, {
    ms: 1000,
    onSpeakerSample: () => {
      thrown += 1;
      throw new Error('listener boom');
    },
  });
  assert.equal(thrown, 1, 'the listener really was invoked');
  assert.deepEqual(throwing.finals.map((event) => event.final), ['好'], 'delivery continues');
  assert.equal(throwing.stats.finals, 1);
  const [throwingShadow] = ofType(throwing.events, 'speaker.shadow').map((event) => event.payload);
  assert.equal(throwingShadow.decision, 'match', 'the shadow row is still written');

  let rejected = 0;
  const rejecting = await runClip(t, {
    ms: 1000,
    onSpeakerSample: async () => {
      rejected += 1;
      throw new Error('listener async boom');
    },
  });
  assert.equal(rejected, 1);
  await delay(50);
  assert.deepEqual(rejecting.finals.map((event) => event.final), ['好']);
  assert.equal(rejecting.stats.finals, 1);
  const [rejectingShadow] = ofType(rejecting.events, 'speaker.shadow').map((event) => event.payload);
  assert.equal(rejectingShadow.decision, 'match');
  assert.deepEqual(unhandled, [], 'a rejected listener promise is swallowed');
  console.log(
    `[hearing-speaker-candidates 4] thrown=${thrown} rejected=${rejected} `
    + `finals=${throwing.finals.length},${rejecting.finals.length} unhandled=${unhandled.length}`,
  );
});
