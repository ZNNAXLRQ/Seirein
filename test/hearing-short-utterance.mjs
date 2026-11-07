/**
 * Short-speech regression: a real 300–600 ms answer ("好"/"不"/"停") must reach delivery.
 *
 * The old audio-duration gate (`MIN_UTTERANCE_MS = 600`) decided *permanently* that anything
 * shorter was a click, and the loudness gate was only computed for audio that passed it — so a
 * 300 ms "好" was dropped twice over, even when the streaming pass had already recognized it.
 * Duration is only a candidate signal now:
 *   - below the 150 ms floor (a click / key blip / breath) the clip is still rejected as
 *     `too-short`, whatever text a model hallucinated for it;
 *   - at or above the floor the recognized text decides; recognized text is delivered, and a loud
 *     clip with no valid text is rejected as `no-text` with a `hearing.filtered {reason, ms}` row.
 *
 * No microphone, ffmpeg, sherpa model, worker thread or timer is used: the child process and both
 * recognizers are injected fakes, and the endpoint is scripted at the end of the constructed clip
 * (so the measured utterance duration is exactly that clip).
 *
 * Run: node --test test/hearing-short-utterance.mjs
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { startHearing } from '../src/host/hearing/hearing.js';

const SAMPLE_RATE = 16000;
/** Floor of the retained minimum-valid-audio check (mirrors hearing.js). */
const MIN_AUDIO_MS = 150;

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

/** Deterministic broadband noise at the same level: a click/blip with no speech in it. */
function noise(ms) {
  const samples = new Int16Array(Math.round((SAMPLE_RATE * ms) / 1000));
  let seed = 12345;
  for (let index = 0; index < samples.length; index += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    samples[index] = Math.round(((seed / 0x7fffffff) * 2 - 1) * 0.25 * 32767);
  }
  const buffer = Buffer.alloc(samples.length * 2);
  for (let index = 0; index < samples.length; index += 1) buffer.writeInt16LE(samples[index], index * 2);
  return buffer;
}

/** Streaming pass: the endpoint fires exactly at the end of the constructed clip. */
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

/** Offline (SenseVoice) stand-in: one scripted result per decode piece, and a call ledger. */
function fakeFinal(text) {
  const calls = [];
  return {
    calls,
    createStream: () => ({
      samples: 0,
      acceptWaveform({ samples }) {
        this.samples = samples.length;
      },
    }),
    decode: () => {},
    getResult(stream) {
      calls.push(stream.samples);
      return { text };
    },
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Push one constructed clip through VAD → ASR → delivery and return every layer's verdict.
 *
 * @param {{ms: number, kind?: 'speech'|'noise'|'silence', streamingText?: string,
 *          offlineText?: string}} clip
 */
async function runClip({ ms, kind = 'speech', streamingText = '', offlineText = '' }) {
  const child = new FakeChild();
  const updates = [];
  const events = [];
  const clip = kind === 'noise' ? noise(ms) : kind === 'silence' ? Buffer.alloc(ms * 16 * 2) : tone(ms);
  const final = fakeFinal(offlineText);

  const hearing = startHearing({
    ffmpegPath: 'ffmpeg-not-used',
    modelDir: 'models-not-used',
    finalModelDir: '',
    device: 'fake-device',
    recognizer: fakeStreaming({ endpointAtSamples: clip.length / 2, text: streamingText }),
    finalRecognizer: final,
    spawnProcess: () => child,
    onUpdate: (event) => updates.push(event),
    onEvent: (type, payload) => events.push({ type, payload }),
  });

  child.stdout.write(clip);
  await tick();
  await tick();
  await tick();

  const finals = updates.filter((event) => typeof event.final === 'string');
  const filtered = events.filter((event) => event.type === 'hearing.filtered');
  hearing.stop();
  return {
    finals,
    final: finals[0],
    filtered,
    decodeCalls: final.calls.length,
    stats: hearing.stats(),
  };
}

const speech = (word) => ({ streamingText: word, offlineText: word });

// ---------------------------------------------------------------------------
// 1–3. A short real answer is delivered; duration no longer discards it
// ---------------------------------------------------------------------------

test('300 ms「好」reaches delivery', async () => {
  const result = await runClip({ ms: 300, ...speech('好') });
  assert.equal(result.finals.length, 1, 'the 300 ms word is delivered, not gated by duration');
  assert.equal(result.final.final, '好');
  assert.equal(result.final.durationMs, 300, 'the measured utterance is 300 ms');
  assert.equal(result.final.refined, true, 'the accurate pass now runs for short audio too');
  assert.equal(result.decodeCalls, 1, 'SenseVoice decoded the short clip once');
  assert.equal(result.filtered.length, 0, 'nothing was filtered');
  assert.equal(result.stats.dropped, 0);
});

test('500 ms「不」reaches delivery', async () => {
  const result = await runClip({ ms: 500, ...speech('不') });
  assert.equal(result.finals.length, 1);
  assert.equal(result.final.final, '不');
  assert.equal(result.final.durationMs, 500);
  assert.equal(result.final.refined, true);
  assert.equal(result.filtered.length, 0);
});

test('600 ms「停」reaches delivery (boundary unchanged)', async () => {
  const result = await runClip({ ms: 600, ...speech('停') });
  assert.equal(result.finals.length, 1);
  assert.equal(result.final.final, '停');
  assert.equal(result.final.durationMs, 600);
  assert.equal(result.filtered.length, 0);
});

// ---------------------------------------------------------------------------
// 4. Loud noise with no recognizable text is still filtered, with an event
// ---------------------------------------------------------------------------

test('200 ms of pure noise is dropped with hearing.filtered {reason:no-text, ms:200}', async () => {
  const result = await runClip({ ms: 200, kind: 'noise' });
  assert.equal(result.finals.length, 0, 'no valid text, so nothing is delivered');
  assert.equal(result.filtered.length, 1, 'the drop is reported');
  assert.deepEqual(result.filtered[0].payload, { reason: 'no-text', ms: 200 });
  assert.equal(result.stats.finals, 0);
  // Counted once as a non-speech utterance: loud, but with no text to deliver.
  assert.equal(result.stats.dropped + result.stats.hallucination, 1);
  // Above the floor the accurate pass runs; it is the *empty text* that filters the clip.
  assert.equal(result.decodeCalls, 1);
});

// ---------------------------------------------------------------------------
// 5. Regression: normal speech is unaffected
// ---------------------------------------------------------------------------

test('900 ms normal sentence is delivered (regression)', async () => {
  const sentence = '今天下午三点开会';
  const result = await runClip({ ms: 900, ...speech(sentence) });
  assert.equal(result.finals.length, 1);
  assert.equal(result.final.final, sentence);
  assert.equal(result.final.durationMs, 900);
  assert.equal(result.final.refined, true);
  assert.equal(result.filtered.length, 0);
});

// ---------------------------------------------------------------------------
// 6. The minimum-valid-audio floor survives: a click is never delivered
// ---------------------------------------------------------------------------

test('an 80 ms click below the floor is dropped as too-short, even if a model hallucinated text', async () => {
  const result = await runClip({
    ms: 80,
    kind: 'noise',
    // A hallucinated character must not override the floor.
    streamingText: '啊',
    offlineText: '啊',
  });
  assert.equal(result.finals.length, 0, 'audio under the floor is never delivered');
  assert.equal(result.decodeCalls, 0, 'it is rejected before the accurate pass');
  assert.equal(result.filtered.length, 1);
  assert.deepEqual(result.filtered[0].payload, { reason: 'too-short', ms: 80 });
  assert.ok(MIN_AUDIO_MS > 80, 'the fixture really is under the retained floor');
});

test('the floor admits a short word but not a click: the same 160 ms boundary both ways', async () => {
  const shortWord = await runClip({ ms: 160, ...speech('好') });
  assert.equal(shortWord.finals.length, 1, 'just above the floor with text → delivered');
  const click = await runClip({ ms: 160, kind: 'noise' });
  assert.equal(click.finals.length, 0, 'just above the floor without text → filtered');
  assert.deepEqual(click.filtered[0].payload, { reason: 'no-text', ms: 160 });
});

// ---------------------------------------------------------------------------
// 7. Text is the deciding signal, not the accurate pass specifically
// ---------------------------------------------------------------------------

test('short audio keeps the streaming text when the accurate pass hears nothing', async () => {
  const result = await runClip({ ms: 300, streamingText: '好', offlineText: '' });
  assert.equal(result.finals.length, 1, 'a recognized word from either pass is enough');
  assert.equal(result.final.final, '好');
  assert.equal(result.final.refined, false, 'the delivered text is the streaming one');
});

// ---------------------------------------------------------------------------
// 8. Room tone is not "filtered speech": no event flood on an idle microphone
// ---------------------------------------------------------------------------

test('1 s of digital silence only bumps the counter; it is not logged as filtered speech', async () => {
  const result = await runClip({ ms: 1000, kind: 'silence' });
  assert.equal(result.finals.length, 0);
  assert.equal(result.stats.dropped, 1);
  assert.equal(result.filtered.length, 0, 'silence is not a lost utterance worth a row');
});
