/**
 * Noise shadow round 1 — evidence only, zero delivery change.
 *
 * Real data: the same short decodes arrive again and again as *separate* deliveries ("The.",
 * "Yeah.", "Okay okay,", "嗯。"), 20–45 s apart — past the repeat window — with a `durationMs` that
 * is suspiciously exact (3500 ms). This suite pins the shadow contract:
 *  1. every final judgment (delivered or gated) writes at most one `hearing.noise.shadow` row,
 *     *after* the verdict, carrying the whole identity chain (utterance / decode task / segment ids /
 *     delivery slot) and the measured evidence (endpoint reason, duration, voiced ratio, both texts,
 *     playback, level, tags);
 *  2. a fixed-cut duration plus a short Latin-only text is reported as `forced-segment` +
 *     `short-latin` — and the text is **still delivered**;
 *  3. a repeated suspect + similar text within 30 s writes `hearing.noise.shadow.suppressed {count}`
 *     instead of a second full row — again without touching delivery;
 *  4. two passes that disagree are recorded as `onlineOfflineAgree: false`;
 *  5. missing decoder fields are `null`, never `undefined`, and never throw;
 *  6. `wouldDrop` is computed and recorded but never applied: protected short answers stay `false`,
 *     a low-VAD short artifact is `true` and is still delivered, and the recorded VAD ratio is the
 *     real Silero one (`vadSpeechRatio`, `vadRatioSource: 'silero'`) — never the energy meter under
 *     another name (`energyVoicedRatio`, `energySource: 'energy'`).
 *
 * No microphone, ffmpeg, sherpa model or real thread is used: the child process, the streaming
 * recognizer and the worker are fakes.
 *
 * Run: node --test test/noise-shadow.mjs
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import {
  decodeSegmented,
  endpointReasonOf,
  isProtectedShortAnswer,
  noiseSuspects,
  onFixedCutGrid,
  onlineOfflineAgree,
  shadowTextKey,
  startHearing,
  voicedMetrics,
  wouldDropVerdict,
} from '../src/host/hearing/hearing.js';

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

/**
 * Fake Silero detector: `segments` are fixed `{startMs,endMs}` speech ranges on the clip timeline.
 * A segment becomes available once its end is covered by the fed samples (as sherpa closes it).
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

/**
 * Worker stand-in that mirrors `asr-worker.js`'s reply shape: the utterance identity is echoed back
 * with the result and one `s0` piece id is reported (every clip here is far shorter than the 15 s
 * piece cap, so one utterance is exactly one decode piece).
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
    const utteranceId = message.utteranceId ?? null;
    setImmediate(() => worker.emit('message', {
      type: 'result',
      id: message.id,
      utteranceId,
      segmentIds: utteranceId === null ? ['s0'] : [`${utteranceId}:s0`],
      ...payload,
    }));
  };
  return worker;
}

/** Push one constructed clip through endpoint → worker decode → delivery and return every layer. */
async function runClip({
  ms, streamingText = '', workerText = '', workerResult = null, isVoicePlaying,
  vadFactory, vadModelPath,
}) {
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
    ...(vadFactory === undefined ? {} : { vadFactory }),
    ...(vadModelPath === undefined ? {} : { vadModelPath }),
    onUpdate: (event) => updates.push(event),
    onEvent: (type, payload) => events.push({ type, payload }),
  });

  child.stdout.write(clip);
  await until(() => updates.some((event) => typeof event.final === 'string'));
  await delay(5);

  const finals = updates.filter((event) => typeof event.final === 'string');
  const stats = hearing.stats();
  hearing.stop();
  return { finals, final: finals[0], events, stats, worker };
}

const ofType = (events, type) => events.filter((event) => event.type === type);
const shadows = (events) => ofType(events, 'hearing.noise.shadow');
const suppressed = (events) => ofType(events, 'hearing.noise.shadow.suppressed');

test('1) 正常短答「好」：影子行存在、suspect 为空、投递照常', async () => {
  const { final, events, stats } = await runClip({ ms: 600, streamingText: '好', workerText: '好' });

  assert.equal(final.final, '好', 'the answer is delivered exactly as before');
  assert.equal(stats.finals, 1);
  const [shadow] = shadows(events).map((event) => event.payload);
  assert.ok(shadow, 'exactly one shadow row per final judgment');
  assert.deepEqual(shadow.suspect, [], 'a plain short answer raises no suspect');

  // Identity chain: utterance → decode task → per-piece ids → delivery slot.
  assert.equal(shadow.utteranceId, 1);
  assert.equal(shadow.decodeTaskId, 1);
  assert.deepEqual(shadow.segmentIds, ['1:s0']);
  assert.equal(shadow.deliveryId, 1);

  // Measured evidence, never a guess.
  assert.equal(shadow.endpointReason, 'natural', 'real words were decoded, then trailing silence');
  assert.equal(shadow.durationMs, 600);
  assert.equal(shadow.maxDurationMs, 20000, 'the endpoint length rule, in milliseconds');
  assert.equal(shadow.voicedRatio, 1, 'the whole clip carries energy');
  assert.ok(shadow.voicedMs > 0 && shadow.voicedMs <= 600);
  assert.ok(Number.isFinite(shadow.peakDb) && shadow.peakDb < 0);
  assert.equal(shadow.onlineText, '好');
  assert.equal(shadow.offlineText, '好');
  assert.equal(shadow.onlineOfflineAgree, true);
  assert.equal(shadow.playing, false, 'no probe → no playback claim');
  assert.equal(shadow.device, 'fake-device');
  assert.deepEqual(shadow.tags, { lang: null, emotion: null, event: null });
  assert.equal(shadow.text, '好');
  assert.equal(shadow.delivered, true);
  assert.equal(shadow.level, 'debug');
});

test('2) 3.5 s 固定切段 + 纯英文短文本：forced-segment + short-latin，仍投递', async () => {
  const { final, events, stats } = await runClip({ ms: 3500, streamingText: 'The.', workerText: 'The.' });

  const [shadow] = shadows(events).map((event) => event.payload);
  assert.deepEqual(shadow.suspect, ['short-latin', 'forced-segment']);
  assert.equal(shadow.durationMs, 3500, 'the exact duration the real log repeats');
  assert.equal(onFixedCutGrid(shadow.durationMs), true);
  assert.equal(shadow.endpointReason, 'natural', 'the decoder did produce words before the silence');

  // The shadow row is evidence only: the artifact is still delivered.
  assert.equal(final.final, 'The.', 'a suspect is not a filter in this round');
  assert.equal(stats.finals, 1);
  assert.equal(stats.dropped + stats.hallucination, 0);
  assert.equal(shadow.delivered, true);
});

test('3) 30 秒内重复的同类 suspect：第二条记 suppressed，投递不受影响', async () => {
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

  assert.equal(shadows(events).length, 1, 'one full row inside the window');
  assert.equal(suppressed(events).length, 1, 'the second occurrence is recorded as suppressed');
  assert.deepEqual(suppressed(events)[0].payload.count, 1, 'the suppressed count starts at 1');
  assert.deepEqual(
    shadows(events)[0].payload.suspect,
    ['short-latin', 'repeat-token'],
  );

  // Throttling is a log concern only: both utterances are still delivered.
  assert.deepEqual(finals().map((event) => event.final), ['Okay okay,', 'Okay okay,']);
  assert.equal(hearing.stats().finals, 2);
  hearing.stop();
});

test('4) 在线/离线不一致：onlineOfflineAgree=false，两路文本都记录', async () => {
  const { final, events } = await runClip({ ms: 600, streamingText: '你好', workerText: '您好' });

  const [shadow] = shadows(events).map((event) => event.payload);
  assert.equal(shadow.onlineText, '你好', 'the streaming pass is recorded as it was');
  assert.equal(shadow.offlineText, '您好', 'the raw offline text is recorded even though it was adopted');
  assert.equal(shadow.onlineOfflineAgree, false);
  assert.equal(final.final, '您好', 'delivery still uses the offline text as before');
});

test('5) 缺失字段一律 null、不抛错；没有音频可测时 voicedRatio 为 null', async () => {
  // The worker reports text only: no tags, no prompt.
  const { events } = await runClip({ ms: 600, workerResult: { text: 'Yeah.' } });

  const [shadow] = shadows(events).map((event) => event.payload);
  assert.deepEqual(shadow.tags, { lang: null, emotion: null, event: null });
  assert.equal(shadow.onlineText, '', 'nothing was heard by the streaming pass');
  assert.equal(shadow.endpointReason, 'silence', 'the no-token silence rule ended it — the noise shape');
  assert.equal(shadow.onlineOfflineAgree, null, 'one empty side is "not comparable", not a disagreement');
  assert.ok(Object.values(shadow).every((value) => value !== undefined), 'no key is `undefined`');

  // Pure helpers never throw on missing input, and never invent a measurement.
  assert.equal(voicedMetrics(null), null);
  assert.equal(voicedMetrics([]), null);
  assert.equal(voicedMetrics(new Float32Array(0)), null);
  assert.equal(endpointReasonOf(Number.NaN), 'other');
  assert.equal(endpointReasonOf(0), 'other');
  assert.equal(endpointReasonOf(600), 'other', 'an unknown hypothesis state is not guessed');
  assert.equal(endpointReasonOf(20000, { hasOnlineText: true }), 'max-duration');
  assert.equal(endpointReasonOf(600, { hasOnlineText: true }), 'natural');
  assert.equal(endpointReasonOf(600, { hasOnlineText: false }), 'silence');
  assert.equal(onFixedCutGrid(Number.NaN), false);
  assert.equal(onFixedCutGrid(0), false);
  assert.equal(shadowTextKey(null), '');
  assert.deepEqual(noiseSuspects({ text: '' }), []);
  assert.equal(onlineOfflineAgree('', ''), null);
  assert.equal(voicedMetrics([new Float32Array(SAMPLE_RATE * 2), new Float32Array(SAMPLE_RATE)]).frames, 150);
});

test('6) 每段 decode 的 id：单段与多段（含接缝裁判）都带 utterance 前缀', () => {
  const recognizer = {
    createStream: () => ({ acceptWaveform: () => {} }),
    decode: () => {},
    getResult: () => ({ text: 'x' }),
  };
  const single = decodeSegmented(recognizer, new Float32Array(SAMPLE_RATE), SAMPLE_RATE, 0, SAMPLE_RATE, { utteranceId: 7 });
  assert.deepEqual(single.segmentIds, ['7:s0']);
  // Without an utterance id the piece ids are still stable, just unscoped.
  assert.deepEqual(decodeSegmented(recognizer, new Float32Array(SAMPLE_RATE), SAMPLE_RATE).segmentIds, ['s0']);
  // 40 000 samples at a 16 000-sample piece with 12 800 samples of shared audio: 3 pieces + 2 referees.
  const multi = decodeSegmented(
    recognizer, new Float32Array(40000), 16000, 12800, SAMPLE_RATE, { utteranceId: 7 },
  );
  assert.deepEqual(multi.segmentIds, ['7:s0', '7:j0', '7:s1', '7:j1', '7:s2']);
});

/** Exactly one full shadow row from one clip run. */
function onlyShadow(events) {
  const rows = shadows(events).map((event) => event.payload);
  assert.equal(rows.length, 1, 'exactly one full shadow row');
  return rows[0];
}

test('7) 真实短答 好/不/停/OK：低 VAD 下 wouldDrop=false，reason=whitelisted', async () => {
  for (const text of ['好', '不', '停', 'OK']) {
    const { final, events } = await runClip({
      ms: 600,
      streamingText: text,
      workerText: text,
      // 20 ms of "speech" in 600 ms = 0.033, below every threshold: only the whitelist protects it.
      vadFactory: () => fakeVad({ segments: [{ startMs: 100, endMs: 120 }] }),
    });
    const shadow = onlyShadow(events);
    assert.equal(shadow.vadSpeechRatio, 0.033);
    assert.equal(shadow.vadRatioSource, 'silero');
    assert.equal(shadow.wouldDrop, false, `${text} is a real short answer`);
    assert.equal(shadow.wouldDropReason, 'whitelisted');
    assert.equal(final.final, text);
    assert.equal(shadow.delivered, true);
  }
});

test('8) 无明显人声 + 文本 "The."：wouldDrop=true / low-vad-speech，但仍 delivered=true', async () => {
  const { final, events, stats } = await runClip({
    ms: 600,
    streamingText: 'The.',
    workerText: 'The.',
    // 30 ms of speech in 600 ms = 0.05: the real VAD says "almost no voice".
    vadFactory: () => fakeVad({ segments: [{ startMs: 100, endMs: 130 }] }),
  });
  const shadow = onlyShadow(events);
  assert.equal(shadow.vadSpeechMs, 30);
  assert.equal(shadow.vadSpeechRatio, 0.05);
  assert.equal(shadow.vadRatioSource, 'silero');
  assert.equal(shadow.energyVoicedRatio, 1, 'the volume meter still hears the tone');
  assert.equal(shadow.voicedRatio, 1, 'the round-1 energy key is unchanged');
  assert.equal(shadow.energySource, 'energy');
  assert.equal(shadow.wouldDrop, true);
  assert.equal(shadow.wouldDropReason, 'low-vad-speech');

  // The verdict is recorded, never applied.
  assert.equal(shadow.delivered, true);
  assert.equal(final.final, 'The.');
  assert.equal(stats.finals, 1);
  assert.equal(stats.dropped + stats.hallucination, 0);
});

test('9) 播放中的回声（playing=true, ratio=0.1）：wouldDrop=true / playback-echo，仍投递', async () => {
  const { final, events } = await runClip({
    ms: 600,
    streamingText: 'The.',
    workerText: 'The.',
    isVoicePlaying: () => true,
    // 60 ms of speech in 600 ms = 0.1.
    vadFactory: () => fakeVad({ segments: [{ startMs: 100, endMs: 160 }] }),
  });
  const shadow = onlyShadow(events);
  assert.equal(shadow.playing, true);
  assert.equal(shadow.vadSpeechRatio, 0.1);
  assert.equal(shadow.wouldDrop, true);
  assert.equal(shadow.wouldDropReason, 'playback-echo', 'while playing, echo is the more specific reason');
  assert.equal(shadow.delivered, true);
  assert.equal(final.final, 'The.');
});

test('10) VAD 不可用：wouldDrop=false / no-vad，能量比仍有值且两者分名', async () => {
  const { final, events } = await runClip({
    ms: 600,
    streamingText: 'The.',
    workerText: 'The.',
    vadModelPath: 'C:/definitely/missing/silero_vad.onnx',
  });
  const shadow = onlyShadow(events);
  assert.equal(shadow.vadSpeechRatio, null, 'never fabricated as 0');
  assert.equal(shadow.vadSpeechMs, null);
  assert.equal(shadow.vadRatioSource, null);
  assert.equal(shadow.energyVoicedRatio, 1, 'the energy meter still measured this clip');
  assert.equal(shadow.energySource, 'energy');
  // Two measurements, two names: the energy value can never be read as a VAD value.
  assert.ok(Object.hasOwn(shadow, 'vadSpeechRatio') && Object.hasOwn(shadow, 'energyVoicedRatio'));
  assert.equal(shadow.vadSpeechRatio === null && shadow.energyVoicedRatio === 1, true);
  assert.equal(shadow.wouldDrop, false);
  assert.equal(shadow.wouldDropReason, 'no-vad');
  assert.equal(shadow.delivered, true);
  assert.equal(final.final, 'The.');
});

test('11) 长文本/正常句子：即使 VAD 比例低也 wouldDrop=false', async () => {
  // 60 ms of speech in a 1.2 s clip = 0.05, but the text is a sentence, not an artifact.
  const lowVad = () => fakeVad({ segments: [{ startMs: 100, endMs: 160 }] });
  const cn = await runClip({ ms: 1200, streamingText: '今天天气不错', workerText: '今天天气不错', vadFactory: lowVad });
  const cnShadow = onlyShadow(cn.events);
  assert.equal(cnShadow.vadSpeechRatio, 0.05);
  assert.equal(cnShadow.wouldDrop, false);
  assert.equal(cnShadow.wouldDropReason, 'not-suspicious');
  assert.equal(cn.final.final, '今天天气不错');

  const en = await runClip({
    ms: 1200,
    streamingText: 'I am not sure about that.',
    workerText: 'I am not sure about that.',
    vadFactory: lowVad,
  });
  const enShadow = onlyShadow(en.events);
  assert.equal(enShadow.wouldDrop, false);
  assert.equal(enShadow.wouldDropReason, 'not-suspicious');
});

test('12) 判定函数契约：白名单优先、无 VAD 不冒充、长文本与播放优先级', () => {
  // A protected answer wins over every other input, including a zero VAD reading and playback.
  for (const text of ['好', '不', '停', 'OK', '嗯嗯', '别说了', 'stop']) {
    assert.equal(isProtectedShortAnswer(text), true, `${text} is protected`);
    assert.deepEqual(
      wouldDropVerdict({ vadSpeechRatio: 0, playing: true, text }),
      { wouldDrop: false, wouldDropReason: 'whitelisted' },
    );
  }
  assert.equal(isProtectedShortAnswer('The.'), false, 'a suspect word is not protected');

  // No real VAD: the energy meter is never a stand-in.
  assert.deepEqual(wouldDropVerdict({ vadSpeechRatio: null, text: 'The.' }), { wouldDrop: false, wouldDropReason: 'no-vad' });
  assert.deepEqual(wouldDropVerdict({ text: 'The.' }), { wouldDrop: false, wouldDropReason: 'no-vad' }, 'missing VAD is not 0');
  // Low real VAD + a short artifact-looking text.
  assert.deepEqual(wouldDropVerdict({ vadSpeechRatio: 0.05, text: 'The.' }), { wouldDrop: true, wouldDropReason: 'low-vad-speech' });
  assert.deepEqual(wouldDropVerdict({ vadSpeechRatio: 0.05, text: 'Yeah.' }), { wouldDrop: false, wouldDropReason: 'not-suspicious' }, '4 Latin characters is a word, not an artifact');
  // Playback is the more specific reason and is checked first.
  assert.deepEqual(wouldDropVerdict({ vadSpeechRatio: 0.1, playing: true, text: 'The.' }), { wouldDrop: true, wouldDropReason: 'playback-echo' });
  assert.deepEqual(wouldDropVerdict({ vadSpeechRatio: 0.2, playing: false, text: 'The.' }), { wouldDrop: false, wouldDropReason: 'not-suspicious' });
  assert.deepEqual(wouldDropVerdict({ vadSpeechRatio: 0.9, text: 'The.' }), { wouldDrop: false, wouldDropReason: 'not-suspicious' });
  assert.deepEqual(wouldDropVerdict({ vadSpeechRatio: 0.05, text: '今天天气不错' }), { wouldDrop: false, wouldDropReason: 'not-suspicious' });
  assert.deepEqual(wouldDropVerdict(null), { wouldDrop: false, wouldDropReason: 'no-text' });
});
