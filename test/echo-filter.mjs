/**
 * High-confidence playback echo filter — the only noise rule that is APPLIED.
 *
 * The round-1 `wouldDrop` verdict is evidence only and could call any short text heard while the
 * assistant is speaking a "playback-echo". That is wrong for an interjection: the user may talk
 * over the reply. This suite pins the applied rule:
 *  1. only `playing === true` + a real content match with the sounding text + a low Silero ratio
 *     drops a final;
 *  2. a protected short answer/stop word always passes (whitelist first, even on an exact match);
 *  3. an uncertain match (different wording, short text, mixed user+echo content, no VAD) passes
 *     and writes one `hearing.echo.candidate` row instead;
 *  4. every other noise reason stays a shadow row: `low-vad-speech` / `no-text` never drop;
 *  5. a passed final is delivered verbatim, in utterance order; `echoFilter: false` restores the
 *     old "deliver everything" behavior.
 *
 * No microphone, ffmpeg, sherpa model or real thread is used: the child process, the streaming
 * recognizer, the VAD detector and the worker are fakes, exactly like `noise-shadow.mjs`.
 *
 * Run: node --test test/echo-filter.mjs
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import {
  echoGate,
  echoMatch,
  startHearing,
} from '../src/host/hearing/hearing.js';

const SAMPLE_RATE = 16000;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until `predicate()` is true; a missed deadline fails the test instead of hanging it. */
async function until(predicate, timeoutMs = 3000) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('timed out waiting for the delivery');
    await delay(5);
  }
}

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

/** Fake Silero detector: fixed speech ranges on the clip timeline (same shape as noise-shadow). */
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

function fakeWorker(result) {
  const worker = new EventEmitter();
  worker.messages = [];
  worker.unref = () => {};
  worker.terminate = () => {
    worker.emit('exit', null);
  };
  worker.postMessage = (message) => {
    worker.messages.push(message);
    const utteranceId = message.utteranceId ?? null;
    const value = typeof result === 'function' ? result(message) : result;
    const payload = typeof value === 'string' ? { text: value } : (value ?? { text: '' });
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

const ofType = (events, type) => events.filter((event) => event.type === type);
const finalsOf = (updates) => updates.filter((event) => typeof event.final === 'string');
const dropsOf = (events) => ofType(events, 'hearing.echo.dropped');
const candidatesOf = (events) => ofType(events, 'hearing.echo.candidate');

/**
 * One constructed clip through endpoint → worker decode → delivery. `playingText` may be a string
 * or a getter; `playing` is the host's live playback probe.
 */
async function runClip({
  ms = 1200,
  streamingText = '',
  workerText = '',
  playing = false,
  playingText = '',
  echoFilter,
  vadSegments = [{ startMs: 100, endMs: 160 }],
  isVoicePlaying,
  passVad = true,
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
    spawnProcess: () => child,
    isVoicePlaying: isVoicePlaying ?? (() => playing),
    playingText: () => (typeof playingText === 'function' ? playingText() : playingText),
    ...(passVad ? { vadFactory: () => fakeVad({ segments: vadSegments }) } : {}),
    ...(echoFilter === undefined ? {} : { echoFilter }),
    onUpdate: (event) => updates.push(event),
    onEvent: (type, payload) => events.push({ type, payload }),
  });

  child.stdout.write(clip);
  await until(() => finalsOf(updates).length > 0 || dropsOf(events).length > 0);
  await delay(5);
  const stats = hearing.stats();
  hearing.stop();
  const finals = finalsOf(updates);
  return {
    finals,
    final: finals[0],
    events,
    stats,
    drops: dropsOf(events),
    candidates: candidatesOf(events),
  };
}

const PLAYING = '今天天气不错';

test('1) 播放中识别出与正在播放文本完全相同 → drop，事件 hearing.echo.dropped', async () => {
  const { finals, drops, events, stats } = await runClip({
    streamingText: PLAYING,
    workerText: PLAYING,
    playing: true,
    playingText: PLAYING,
  });

  assert.equal(finals.length, 0, 'the echo is withheld, not delivered');
  assert.equal(stats.finals, 0);
  assert.equal(stats.echoDropped, 1, 'the applied rule counts its decision');
  assert.equal(stats.hallucination, 0, 'an echo is not a hallucination');
  assert.equal(drops.length, 1);
  assert.deepEqual(drops[0].payload, {
    level: 'debug',
    utteranceId: 1,
    matchedChars: 6,
    playingChars: 6,
    reason: 'playback-echo',
  });
  assert.equal(candidatesOf(events).length, 0, 'a dropped echo is not also a candidate');
});

test('2) 播放中用户插话「等一下」→ 内容不匹配，不 drop，事件 candidate', async () => {
  const protectedClip = await runClip({
    streamingText: '等一下',
    workerText: '等一下',
    playing: true,
    playingText: PLAYING,
  });
  assert.equal(protectedClip.final.final, '等一下');
  assert.equal(protectedClip.drops.length, 0);
  assert.equal(protectedClip.candidates.length, 1);
  assert.equal(protectedClip.candidates[0].payload.reason, 'whitelisted',
    '「等一下」is also a protected answer — it passes for both reasons');
  assert.equal(protectedClip.candidates[0].payload.matched, false);
  assert.equal(protectedClip.candidates[0].payload.delivered, true);

  const interjection = await runClip({
    streamingText: '你先等一下',
    workerText: '你先等一下',
    playing: true,
    playingText: PLAYING,
  });
  assert.equal(interjection.final.final, '你先等一下', 'a non-protected interjection passes too');
  assert.equal(interjection.drops.length, 0);
  assert.equal(interjection.candidates[0].payload.reason, 'not-similar');
  assert.equal(interjection.candidates[0].payload.matched, false);
});

test('3) 播放中用户说「停」→ 白名单优先，不 drop', async () => {
  const stop = await runClip({
    streamingText: '停',
    workerText: '停',
    playing: true,
    playingText: '请停下来',
    vadSegments: [{ startMs: 100, endMs: 110 }],
  });
  assert.equal(stop.final.final, '停');
  assert.equal(stop.drops.length, 0);
  assert.equal(stop.candidates[0].payload.reason, 'whitelisted');

  // Even a protected word that matches the playing line EXACTLY is never treated as an echo.
  const okay = await runClip({
    streamingText: 'okay',
    workerText: 'okay',
    playing: true,
    playingText: 'okay',
    vadSegments: [{ startMs: 100, endMs: 110 }],
  });
  assert.equal(okay.final.final, 'okay');
  assert.equal(okay.drops.length, 0);
  assert.equal(okay.candidates[0].payload.reason, 'whitelisted');
  assert.equal(okay.candidates[0].payload.matched, true, 'the match is reported, but the whitelist wins');
});

test('4) 播放中识别出播放文本的一部分（≥4 字，占比 ≥70%）→ drop', async () => {
  const playingText = '今天天气非常不错我们出去走走吧';
  const { finals, drops } = await runClip({
    streamingText: '气非常不错',
    workerText: '气非常不错',
    playing: true,
    playingText,
  });
  assert.equal(finals.length, 0);
  assert.equal(drops.length, 1);
  assert.equal(drops[0].payload.matchedChars, 5);
  assert.equal(drops[0].payload.playingChars, 14, 'the filler 「吧」 is removed for comparison only');
  assert.equal(drops[0].payload.reason, 'playback-echo');
});

test('5) 混说（播放文本 + 额外内容，占比 <70%）→ 不 drop', async () => {
  const spoken = '今天天气不错我们出去走走吧';
  const { final, drops, candidates } = await runClip({
    streamingText: spoken,
    workerText: spoken,
    playing: true,
    playingText: PLAYING,
  });
  assert.equal(drops.length, 0, 'extra user words mean the user is talking, not echoing');
  assert.equal(final.final, spoken, 'delivered verbatim');
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].payload.matched, true, 'the overlap is reported…');
  assert.equal(candidates[0].payload.reason, 'mixed', '…but it is not high confidence');
});

test('6) 未播放时同文本 → 不 drop', async () => {
  const { final, drops, candidates } = await runClip({
    streamingText: PLAYING,
    workerText: PLAYING,
    playing: false,
    playingText: PLAYING,
  });
  assert.equal(final.final, PLAYING);
  assert.equal(drops.length, 0, 'playback state is half of the gate');
  assert.equal(candidates[0].payload.reason, 'not-playing');
  assert.equal(candidates[0].payload.matched, true);
});

test('7) 播放中低 VAD 但内容不匹配 → 只记录 candidate，不 drop', async () => {
  const { final, drops, candidates, stats } = await runClip({
    streamingText: '帮我看看',
    workerText: '帮我看看',
    playing: true,
    playingText: PLAYING,
    vadSegments: [{ startMs: 100, endMs: 110 }],
  });
  assert.equal(final.final, '帮我看看');
  assert.equal(drops.length, 0);
  assert.equal(stats.echoDropped, 0);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].payload.reason, 'not-similar');
  assert.equal(candidates[0].payload.matched, false);
});

test('8) 关闭过滤开关 → 全部放行（回归）', async () => {
  const { final, drops, candidates, events, stats } = await runClip({
    streamingText: PLAYING,
    workerText: PLAYING,
    playing: true,
    playingText: PLAYING,
    echoFilter: false,
  });
  assert.equal(final.final, PLAYING, 'the exact-match echo is delivered again');
  assert.equal(drops.length, 0);
  assert.equal(candidates.length, 0, 'a disabled filter writes no echo rows either');
  assert.equal(stats.echoDropped, 0);
  // The round-1 shadow still records its (record-only) verdict: only the applied rule is switched off.
  assert.equal(ofType(events, 'hearing.noise.shadow').length, 1);
});

test('9) 放行场景的投递文本与顺序逐字不变', async () => {
  const child = new FakeChild();
  const updates = [];
  const events = [];
  const state = { playing: false, text: PLAYING };
  const clip = tone(1200);
  const texts = [PLAYING, '帮我看看'];

  const hearing = startHearing({
    ffmpegPath: 'ffmpeg-not-used',
    modelDir: 'models-not-used',
    finalModelDir: '',
    device: 'fake-device',
    recognizer: fakeStreaming({ endpointAtSamples: clip.length / 2, text: '' }),
    asrWorkerFactory: () => fakeWorker((message) => texts[message.utteranceId === 2 ? 1 : 0]),
    spawnProcess: () => child,
    isVoicePlaying: () => state.playing,
    playingText: () => state.text,
    vadFactory: () => fakeVad({ segments: [{ startMs: 100, endMs: 160 }] }),
    onUpdate: (event) => updates.push(event),
    onEvent: (type, payload) => events.push({ type, payload }),
  });

  child.stdout.write(clip);
  await until(() => finalsOf(updates).length === 1);
  state.playing = true;
  state.text = PLAYING;
  child.stdout.write(clip);
  await until(() => finalsOf(updates).length === 2);
  await delay(5);

  const finals = finalsOf(updates);
  assert.deepEqual(finals.map((event) => event.final), [PLAYING, '帮我看看'], 'verbatim, in order');
  assert.deepEqual(finals.map((event) => event.utteranceId), [1, 2]);
  assert.equal(dropsOf(events).length, 0);
  assert.equal(hearing.stats().finals, 2);
  hearing.stop();
});

test('10) echoMatch / echoGate 边界：只认精确或连续子串，不确定一律放行', () => {
  // Normalization: tags/punctuation/spacing/case/filler syllables do not make new words.
  assert.deepEqual(echoMatch('嗯，今天 天气不错啊。', PLAYING), {
    matched: true, reason: 'exact', matchedChars: 6, playingChars: 6, coverage: 1,
  });
  assert.equal(echoMatch('OKAY!', 'okay').reason, 'exact');
  // The input is one piece of the playing line.
  assert.deepEqual(echoMatch('气非常不错', '今天天气非常不错'), {
    matched: true, reason: 'input-in-playing', matchedChars: 5, playingChars: 8, coverage: 1,
  });
  // The playing line is one piece of a longer input: coverage decides mixed speech.
  assert.equal(echoMatch('今天天气不错我们出发', PLAYING).reason, 'playing-in-input');
  assert.equal(echoMatch('今天天气不错我们出发', PLAYING).coverage, 0.6);
  // 4 chars is the floor; similar-but-not-substring is never an echo.
  assert.equal(echoMatch('你好', '你好世界').reason, 'short-text');
  assert.equal(echoMatch('今天天气很好', PLAYING).reason, 'not-similar');
  assert.equal(echoMatch('', PLAYING).reason, 'no-text');
  // 7/10 = 0.7 is enough, 7/11 is mixed.
  assert.equal(echoGate({ text: '一二三四五六七八九十', playingText: '一二三四五六七', playing: true, vadSpeechRatio: 0.05 }).drop, true);
  assert.equal(echoGate({ text: '一二三四五六七八九十一', playingText: '一二三四五六七', playing: true, vadSpeechRatio: 0.05 }).reason, 'mixed');
  // Every missing condition passes, with the reason that explains it.
  assert.equal(echoGate({ text: PLAYING, playingText: PLAYING, playing: true, vadSpeechRatio: 0.05 }).drop, true);
  assert.equal(echoGate({ text: PLAYING, playingText: PLAYING, playing: true, vadSpeechRatio: null }).reason, 'no-vad');
  assert.equal(echoGate({ text: PLAYING, playingText: PLAYING, playing: true, vadSpeechRatio: 0.25 }).reason, 'vad-high');
  assert.equal(echoGate({ text: PLAYING, playingText: PLAYING, playing: false, vadSpeechRatio: 0 }).reason, 'not-playing');
  assert.equal(echoGate({ text: '停', playingText: '停下来吧', playing: true, vadSpeechRatio: 0 }).reason, 'whitelisted');
  // Low VAD alone is NOT this rule: the old `low-vad-speech` shadow stays unapplied.
  assert.equal(echoGate({ text: 'The.', playingText: PLAYING, playing: true, vadSpeechRatio: 0.05 }).drop, false);
});
