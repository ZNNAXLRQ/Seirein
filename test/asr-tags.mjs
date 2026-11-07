/**
 * Three-layer ASR observation: `hearing.asr.raw` → `hearing.asr.cleaned` → `hearing.delivery`.
 *
 * This suite pins the *observation-only* contract of the SenseVoice tag audit:
 *  1. one row per layer per delivered utterance, all three carrying the same utterance `id`;
 *  2. a raw decode text that really contains tags (`<|zh|>`, `<|HAPPY|>`, …) is reported with those
 *     tags in `cleaned.tags` and stripped from `cleaned.cleaned` — while the delivered text stays
 *     exactly the pre-existing decoder text (no strip is applied to delivery);
 *  2b. the SenseVoice side-channel fields (`lang`/`emotion`/`event`, raw + clean) travel from the
 *     worker result into `hearing.asr.cleaned`; a missing field is `null`, never `undefined`;
 *  3. tags never change `finals` / `hallucination` / `dropped` counting.
 *
 * The rows exist on the worker session path only: the synchronous fallback deliberately keeps its
 * event log empty (the same rule `asr.delivery.order` follows), so these tests drive a fake worker
 * thread. No microphone, ffmpeg, sherpa model or real thread is used.
 *
 * Run: node --test test/asr-tags.mjs
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { asrTagFields, decodeSegmented, splitAsrTags, startHearing } from '../src/host/hearing/hearing.js';

const SAMPLE_RATE = 16000;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until `predicate()` is true; a missed deadline fails the test instead of hanging it. */
async function until(predicate, timeoutMs = 1000) {
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

/**
 * Worker stand-in with the surface `createAsrWorkerClient` uses. `result` is the reply the thread
 * would send (`{ text, lang, emotion, event, langClean, ... }`), or a bare text string.
 */
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
    setImmediate(() => worker.emit('message', { type: 'result', id: message.id, ...payload }));
  };
  return worker;
}

/**
 * Push one constructed clip through endpoint → worker decode → delivery and return every layer.
 *
 * @param {{ms: number, streamingText?: string, workerText?: string, workerResult?: object,
 *          isVoicePlaying?: () => boolean}} clip
 */
async function runClip({ ms, streamingText = '', workerText = '', workerResult = null, isVoicePlaying }) {
  const child = new FakeChild();
  const updates = [];
  const events = [];
  const clip = tone(ms);
  const worker = fakeWorker(workerResult ?? workerText);

  const hearing = startHearing({
    ffmpegPath: 'ffmpeg-not-used',
    modelDir: 'models-not-used',
    finalModelDir: '',
    device: 'fake-device',
    recognizer: fakeStreaming({ endpointAtSamples: clip.length / 2, text: streamingText }),
    asrWorkerFactory: () => worker,
    spawnProcess: () => child,
    ...(isVoicePlaying === undefined ? {} : { isVoicePlaying }),
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

const OBSERVED = new Set(['hearing.asr.raw', 'hearing.asr.cleaned', 'hearing.delivery']);
const observations = (events) => events.filter((event) => OBSERVED.has(event.type));
const ofType = (events, type) => events.filter((event) => event.type === type);

test('三层事件在正常语音上各出现一次，id 一致，投递文本不变', async () => {
  const sentence = '今天下午三点开会';
  const { final, events } = await runClip({ ms: 900, streamingText: sentence, workerText: sentence });

  assert.deepEqual(
    observations(events).map((event) => event.type),
    ['hearing.asr.raw', 'hearing.asr.cleaned', 'hearing.delivery'],
    'exactly one row per layer, in order',
  );
  const [raw, cleaned, delivery] = observations(events).map((event) => event.payload);
  assert.equal(raw.id, 1);
  assert.equal(cleaned.id, raw.id, 'cleaned rides the same utterance id');
  assert.equal(delivery.id, raw.id, 'delivery rides the same utterance id');
  for (const payload of [raw, cleaned, delivery]) assert.equal(payload.level, 'debug', 'rows are debug level');

  assert.equal(raw.raw, sentence);
  assert.equal(raw.chars, sentence.length);
  assert.equal(cleaned.cleaned, sentence);
  assert.deepEqual(cleaned.tags, [], 'plain speech carries no tags');
  assert.equal(cleaned.stripped, false);
  // A worker result that simply omits the side-channel fields must not leak `undefined`.
  for (const key of ['lang', 'langClean', 'emotion', 'emotionClean', 'event', 'eventClean']) {
    assert.equal(cleaned[key], null, `${key} is null when the worker does not report it`);
  }
  assert.equal(cleaned.refined, true);
  assert.equal(cleaned.tagSource, 'worker');
  assert.equal(delivery.text, final.final, 'the delivery observation agrees with onUpdate');
  assert.equal(delivery.text, sentence);
  assert.equal(delivery.durationMs, 900);
  assert.ok(Number.isFinite(delivery.rmsDb) && delivery.rmsDb < 0, 'a measured level, not a guess');
  assert.equal(delivery.bargein, false, 'no probe → no barge-in claim');
});

test('原始文本含标签（假数据）→ cleaned 记录 lang/emotion/event 与 tags，投递文本保持原样', async () => {
  const tagged = '<|zh|><|HAPPY|><|Speech|><|withitn|>你好';
  const workerResult = {
    text: tagged,
    lang: '<|zh|>', langClean: 'zh',
    emotion: '<|HAPPY|>', emotionClean: 'HAPPY',
    event: '<|Speech|>', eventClean: 'Speech',
  };
  const { final, events, stats } = await runClip({ ms: 900, streamingText: '你好', workerResult });

  const raw = ofType(events, 'hearing.asr.raw')[0]?.payload;
  const cleaned = ofType(events, 'hearing.asr.cleaned')[0]?.payload;
  assert.equal(raw.raw, tagged, 'the raw row is the decoder text, tags included');
  assert.deepEqual(cleaned.tags, ['<|zh|>', '<|HAPPY|>', '<|Speech|>', '<|withitn|>']);
  assert.equal(cleaned.cleaned, '你好');
  assert.equal(cleaned.stripped, true);
  assert.equal(cleaned.lang, '<|zh|>');
  assert.equal(cleaned.langClean, 'zh');
  assert.equal(cleaned.emotion, '<|HAPPY|>');
  assert.equal(cleaned.emotionClean, 'HAPPY');
  assert.equal(cleaned.event, '<|Speech|>');
  assert.equal(cleaned.eventClean, 'Speech');
  assert.equal(cleaned.refined, true);
  assert.equal(cleaned.tagSource, 'worker');
  // The tag strip is observation only: delivery must be byte-identical to the pre-change behavior.
  assert.equal(final.final, tagged, 'delivery still carries the unmodified decoder text');
  assert.equal(ofType(events, 'hearing.delivery')[0]?.payload.text, tagged);
  assert.equal(stats.finals, 1, 'the tagged utterance is delivered exactly like the plain one');
  // Only complete `<|...|>` tokens count; ordinary angle-bracket text is left alone.
  assert.deepEqual(splitAsrTags('a <|zh|> b <|Laughter|>'), { cleaned: 'a b', tags: ['<|zh|>', '<|Laughter|>'], stripped: true });
  assert.deepEqual(splitAsrTags('答案是 <3 和 1<2'), { cleaned: '答案是 <3 和 1<2', tags: [], stripped: false });
});

test('字段缺失或异常一律 null：decoder 采集与类型归一化都不抛错', async () => {
  // A single-piece decode (16 kHz → 1 s < the 15 s piece) carrying every side-channel tag.
  const taggedRecognizer = {
    createStream: () => ({ acceptWaveform: () => {} }),
    decode: () => {},
    getResult: () => ({
      text: '<|zh|><|HAPPY|><|Speech|>你好',
      lang: '<|zh|>',
      emotion: '<|HAPPY|>',
      event: '<|Speech|>',
    }),
  };
  const pass = decodeSegmented(taggedRecognizer, new Float32Array(SAMPLE_RATE), SAMPLE_RATE, 0);
  assert.equal(pass.text, '<|zh|><|HAPPY|><|Speech|>你好');
  assert.deepEqual(
    { lang: pass.lang, langClean: pass.langClean, emotion: pass.emotion, emotionClean: pass.emotionClean, event: pass.event, eventClean: pass.eventClean },
    { lang: '<|zh|>', langClean: 'zh', emotion: '<|HAPPY|>', emotionClean: 'HAPPY', event: '<|Speech|>', eventClean: 'Speech' },
  );

  // The same decode without the fields: every key is null, never undefined.
  const bareRecognizer = { ...taggedRecognizer, getResult: () => ({ text: '你好' }) };
  const bare = decodeSegmented(bareRecognizer, new Float32Array(SAMPLE_RATE), SAMPLE_RATE, 0);
  assert.equal(bare.text, '你好');
  for (const key of ['lang', 'langClean', 'emotion', 'emotionClean', 'event', 'eventClean']) {
    assert.equal(bare[key], null, `${key} is null when the decoder omits it`);
  }
  // Non-string / empty values are null too (no `undefined`, no throw), and `raw` keeps the brackets.
  assert.deepEqual(asrTagFields({ lang: '<|zh|>', emotion: '', event: 42 }), {
    lang: '<|zh|>', langClean: 'zh',
    emotion: null, emotionClean: null,
    event: null, eventClean: null,
  });
  assert.deepEqual(asrTagFields(null), {
    lang: null, langClean: null, emotion: null, emotionClean: null, event: null, eventClean: null,
  });
});

test('标签存在与否不影响 finals / hallucination / dropped 计数', async () => {
  const plain = await runClip({ ms: 900, streamingText: '你好', workerText: '你好' });
  const tagged = await runClip({ ms: 900, streamingText: '你好', workerText: '<|zh|><|NEUTRAL|><|Speech|>你好' });

  assert.equal(plain.stats.finals, tagged.stats.finals);
  assert.equal(plain.stats.hallucination, tagged.stats.hallucination);
  assert.equal(plain.stats.dropped, tagged.stats.dropped);
  assert.equal(tagged.stats.finals, 1);
  assert.equal(tagged.stats.hallucination, 0);
  assert.equal(tagged.final.final, '<|zh|><|NEUTRAL|><|Speech|>你好');
});

test('delivery 的 bargein 只读可选播放探针，不自行判定', async () => {
  const withVoice = await runClip({ ms: 900, streamingText: '好', workerText: '好', isVoicePlaying: () => true });
  assert.equal(ofType(withVoice.events, 'hearing.delivery')[0]?.payload.bargein, true);
});
