/**
 * Truncation semantics: the 90 s buffer cap limits only the accurate (offline) pass. When the
 * streaming pass already heard the whole utterance, the delivered text is complete and must NOT
 * carry the "（语音过长，已截断至 90 秒）" note; that limitation belongs to the event log only
 * (`offlineLimited: true`, `note: '离线精修仅覆盖前 90 秒'`). The note is reserved for text that
 * really lost audio.
 *
 * No microphone, ffmpeg or sherpa model is used: recognizers and the child process are injected.
 *
 * Run: node --test test/asr-truncation-semantics.mjs
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { annotateTranscript, offlineLimitedNote, startHearing, truncationNotice } from '../src/host/hearing/hearing.js';

const SAMPLE_RATE = 16000;
const TRUNCATION_HINT = truncationNotice(90);
const OFFLINE_NOTE = offlineLimitedNote(90);
const TONE = (() => {
  const samples = new Int16Array(SAMPLE_RATE);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = Math.round(Math.sin((2 * Math.PI * 440 * index) / SAMPLE_RATE) * 0.25 * 32767);
  }
  const buffer = Buffer.alloc(samples.length * 2);
  for (let index = 0; index < samples.length; index += 1) buffer.writeInt16LE(samples[index], index * 2);
  return buffer;
})();

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

/** Streaming stand-in: `text` is '' when the online pass heard nothing intelligible. */
function fakeStreaming({ endpointAtSamples, text = '流式草稿' }) {
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

/** Offline stand-in: returns the scripted text for the first decode piece. */
function fakeFinal(texts) {
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
      return { text: texts[calls.length - 1] ?? `段${calls.length}` };
    },
  };
}

function harness({ endpointAtSamples, finalTexts, streamingText, maxUtteranceSec = 90 }) {
  const child = new FakeChild();
  const updates = [];
  startHearing({
    ffmpegPath: 'ffmpeg-not-used',
    modelDir: 'models-not-used',
    finalModelDir: '',
    device: 'fake-device',
    recognizer: fakeStreaming({ endpointAtSamples, text: streamingText }),
    finalRecognizer: fakeFinal(finalTexts),
    spawnProcess: () => child,
    maxUtteranceSec,
    onUpdate: (event) => updates.push(event),
  });
  return { child, updates };
}

async function feedSeconds(child, seconds) {
  for (let index = 0; index < seconds; index += 1) child.stdout.write(TONE);
  await new Promise((resolve) => setTimeout(resolve, 30));
}

const finalEvents = (updates) => updates.filter((event) => typeof event.final === 'string');

test('a) truncated audio actually adopted → text carries the hint and truncated:true', async () => {
  // The online pass heard nothing, so the only available text comes from the capped buffer.
  // A 5 s cap over 8 s of audio stays inside one decode piece, so this case tests only the
  // truncation flags (segmentation has its own regression).
  const { child, updates } = harness({
    endpointAtSamples: 8 * SAMPLE_RATE,
    streamingText: '',
    finalTexts: ['只剩前五秒'],
    maxUtteranceSec: 5,
  });
  await feedSeconds(child, 8);

  const events = finalEvents(updates);
  assert.equal(events.length, 1);
  const update = events[0];
  assert.equal(update.final, '只剩前五秒', 'the truncated offline result is the delivered text');
  assert.equal(update.refined, true);
  assert.equal(update.truncated, true, 'the text itself lost audio');
  assert.notEqual(update.offlineLimited, true);
  assert.equal(update.maxUtteranceSec, 5);

  const hint = truncationNotice(5);
  const delivered = annotateTranscript(update.final, update);
  assert.equal(delivered, `${hint}\n只剩前五秒`, 'the user is told the audio was cut');
  assert.ok(delivered.includes(hint));
});

test('b) truncated but the full online text survives → no hint, offlineLimited:true, truncated:false', async () => {
  const { child, updates } = harness({
    endpointAtSamples: 8 * SAMPLE_RATE,
    streamingText: '在线听完整句',
    finalTexts: ['离线只听前五秒'],
    maxUtteranceSec: 5,
  });
  await feedSeconds(child, 8);

  const events = finalEvents(updates);
  assert.equal(events.length, 1);
  const update = events[0];
  assert.equal(update.final, '在线听完整句', 'the complete online text is authoritative');
  assert.equal(update.refined, false, 'the truncated offline result was not adopted');
  assert.equal(update.offlineLimited, true, 'only the accurate pass was limited');
  assert.equal(update.truncated, false, 'the delivered text is complete');
  assert.equal(update.note, offlineLimitedNote(5), 'the event log explains the limitation');

  const delivered = annotateTranscript(update.final, update);
  assert.equal(delivered, '在线听完整句', 'no truncation hint reaches user or model');
  assert.ok(!delivered.includes(TRUNCATION_HINT));
  assert.ok(!delivered.includes(offlineLimitedNote(5)), 'the diagnostic note stays out of the text');
});

test('c) audio under the cap → neither flag and no hint', async () => {
  const { child, updates } = harness({
    endpointAtSamples: 10 * SAMPLE_RATE,
    streamingText: '流式草稿',
    finalTexts: ['在线听完整句'],
  });
  await feedSeconds(child, 10);

  const events = finalEvents(updates);
  assert.equal(events.length, 1);
  const update = events[0];
  assert.equal(update.final, '在线听完整句');
  assert.equal(Boolean(update.truncated), false);
  assert.equal(Boolean(update.offlineLimited), false);
  assert.equal(update.note, undefined);
  assert.equal(annotateTranscript(update.final, update), '在线听完整句');
});

test('d) offlineLimitedNote is diagnostic text only; the truncation note is the user-facing one', () => {
  assert.equal(OFFLINE_NOTE, '离线精修仅覆盖前 90 秒');
  assert.notEqual(OFFLINE_NOTE, TRUNCATION_HINT);
});
