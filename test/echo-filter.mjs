/**
 * High-confidence playback echo filter — the only noise rule that is APPLIED.
 *
 * The round-1 `wouldDrop` verdict is evidence only and could call any short text heard while the
 * assistant is speaking a "playback-echo". That is wrong for an interjection: the user may talk
 * over the reply. This suite pins the applied rule:
 *  1. only `playing === true` + a real content match with the sounding text + a low Silero ratio
 *     drops a final — and only when the input is a PURE echo (P1: any extra content means the user
 *     is talking, so a negation / stop order / extra phrase always passes; P2 is conservative:
 *     ONE real character outside the echo, such as 「吗」, is already extra content);
 *  2. a protected short answer/stop word always passes (whitelist first, even on an exact match);
 *  3. an uncertain match (different wording, short text, mixed user+echo content, no VAD) passes
 *     and writes one `hearing.echo.candidate` row instead;
 *  4. every other noise reason stays a shadow row: `low-vad-speech` / `no-text` never drop;
 *  5. a passed final is delivered verbatim, in utterance order; `echoFilter: false` restores the
 *     old "deliver everything" behavior;
 *  6. P2: the reference is the text really sent to TTS (`speechText`), never the subtitle. No
 *     speechText means the final passes with `no-speech-text`; a clip switch re-references the
 *     new block only.
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
 * One constructed clip through endpoint → worker decode → delivery. `playingText` may be a string,
 * a `{ subtitle, speechText }` object, or a getter returning either; `playing` is the host's live
 * playback probe. When it is a function it is called again for every judgment, exactly like the
 * host's getter, so a test can switch the sounding block between two clips.
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
    extraChars: 0,
    extraKind: '',
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
  // 9/10 coverage with ONE leftover character: P2 treats that character as real user speech, so the
  // input passes (「吗」 turns the echoed statement into a question). A pure echo still drops.
  assert.equal(echoGate({ text: '一二三四五六七八九', playingText: '一二三四五六七八九', playing: true, vadSpeechRatio: 0.05 }).drop, true);
  const oneCharMore = echoGate({ text: '一二三四五六七八九十一', playingText: '一二三四五六七八九', playing: true, vadSpeechRatio: 0.05 });
  assert.equal(oneCharMore.reason, 'mixed');
  assert.equal(oneCharMore.extraChars, 2, '「十一」is real uncovered content');
  // One leftover real character is already enough (P2: no 2-character threshold).
  const single = echoGate({ text: '一二三四五六七八九十', playingText: '一二三四五六七八九', playing: true, vadSpeechRatio: 0.05 });
  assert.equal(single.reason, 'mixed');
  assert.equal(single.extraChars, 1, '「十」');
  // P1 boundary: the residual decides, whatever the coverage ratio says.
  assert.equal(echoGate({ text: '不，一二三四五六七八九', playingText: '一二三四五六七八九', playing: true, vadSpeechRatio: 0.05 }).extraKind, 'negation');
  // A pure echo with only a filler syllable is still the echo (filler stripped for comparison).
  assert.equal(echoGate({ text: '一二三四五六七八九啊', playingText: '一二三四五六七八九', playing: true, vadSpeechRatio: 0.05 }).drop, true);
  // P2 boundary: an empty reference is never guessed; it passes and says why.
  assert.equal(echoGate({ text: PLAYING, playingText: '', playing: true, vadSpeechRatio: 0 }).reason, 'no-speech-text');
  // Every missing condition passes, with the reason that explains it.
  assert.equal(echoGate({ text: PLAYING, playingText: PLAYING, playing: true, vadSpeechRatio: 0.05 }).drop, true);
  assert.equal(echoGate({ text: PLAYING, playingText: PLAYING, playing: true, vadSpeechRatio: null }).reason, 'no-vad');
  assert.equal(echoGate({ text: PLAYING, playingText: PLAYING, playing: true, vadSpeechRatio: 0.25 }).reason, 'vad-high');
  assert.equal(echoGate({ text: PLAYING, playingText: PLAYING, playing: false, vadSpeechRatio: 0 }).reason, 'not-playing');
  assert.equal(echoGate({ text: '停', playingText: '停下来吧', playing: true, vadSpeechRatio: 0 }).reason, 'whitelisted');
  // Low VAD alone is NOT this rule: the old `low-vad-speech` shadow stays unapplied.
  assert.equal(echoGate({ text: 'The.', playingText: PLAYING, playing: true, vadSpeechRatio: 0.05 }).drop, false);
});

// ---------------------------------------------------------------------------
// P1: only a PURE echo is dropped — a mixed input is always delivered
// ---------------------------------------------------------------------------

/** The sounding sentence the P1 cases echo: the old rule dropped all three of them. */
const TOMORROW = '我明天会去图书馆学习';

test('11) P1 否定混说「不，我明天会去图书馆学习」→ 放行，extraKind=negation', async () => {
  const text = `不，${TOMORROW}`;
  const { final, drops, candidates, stats } = await runClip({
    streamingText: text,
    workerText: text,
    playing: true,
    playingText: TOMORROW,
    vadSegments: [{ startMs: 100, endMs: 160 }],
  });
  assert.equal(drops.length, 0, 'a negation is real user speech, not an echo');
  assert.equal(final.final, text, 'delivered verbatim');
  assert.equal(stats.echoDropped, 0);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].payload.reason, 'mixed');
  assert.equal(candidates[0].payload.matched, true, 'the echo overlap is still reported…');
  assert.equal(candidates[0].payload.extraKind, 'negation', '…along with the kind of new content');
  assert.equal(candidates[0].payload.extraChars, 1);
  assert.equal(candidates[0].payload.delivered, true);
});

test('12) P1 停止混说「我明天会去图书馆学习，别说了」→ 放行，extraKind=stop', async () => {
  const text = `${TOMORROW}，别说了`;
  const { final, drops, candidates } = await runClip({
    streamingText: text,
    workerText: text,
    playing: true,
    playingText: TOMORROW,
    vadSegments: [{ startMs: 100, endMs: 160 }],
  });
  assert.equal(drops.length, 0, 'a stop order always passes, even after a long echo');
  assert.equal(final.final, text);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].payload.reason, 'mixed');
  assert.equal(candidates[0].payload.extraKind, 'stop');
  assert.equal(candidates[0].payload.extraChars, 3, '「别说了」is the uncovered content');
});

test('13) P1 纯回声「我明天会去图书馆学习」→ drop，extraChars=0 / extraKind=""', async () => {
  const { finals, events, drops, stats, candidates } = await runClip({
    streamingText: TOMORROW,
    workerText: TOMORROW,
    playing: true,
    playingText: TOMORROW,
    vadSegments: [{ startMs: 100, endMs: 160 }],
  });
  assert.equal(finals.length, 0, 'a pure echo is still withheld');
  assert.equal(stats.echoDropped, 1);
  assert.equal(drops.length, 1);
  assert.equal(drops[0].payload.reason, 'playback-echo');
  assert.equal(drops[0].payload.matchedChars, 10);
  assert.equal(drops[0].payload.playingChars, 10);
  assert.equal(drops[0].payload.extraChars, 0);
  assert.equal(drops[0].payload.extraKind, '');
  assert.equal(candidates.length, 0, 'a dropped echo is not also a candidate');
});

test('14) P1 纯回声 + 标点/语气词「我明天会去图书馆学习啊。」→ 仍 drop', async () => {
  const { finals, drops } = await runClip({
    streamingText: `${TOMORROW}啊。`,
    workerText: `${TOMORROW}啊。`,
    playing: true,
    playingText: TOMORROW,
    vadSegments: [{ startMs: 100, endMs: 160 }],
  });
  assert.equal(finals.length, 0, 'punctuation and tone particles add no words');
  assert.equal(drops.length, 1);
  assert.equal(drops[0].payload.extraChars, 0, '「啊」/「。」are stripped before counting');
  assert.equal(drops[0].payload.extraKind, '');
  assert.equal(drops[0].payload.reason, 'playback-echo');
});

// ---------------------------------------------------------------------------
// P2: the reference is the text really sent to TTS (speechText), never the subtitle
// ---------------------------------------------------------------------------

const JA_SPEECH = '明日図書館に行きます';
const ZH_SUBTITLE = '明天去图书馆';

test('15) P2 中日双语：字幕 zh / speechText ja；ja 回声 drop，zh 字幕内容不 drop', async () => {
  // The audio is the Japanese line; the screen shows the Chinese subtitle. The exact Japanese
  // transcript is an echo…
  const jaEcho = await runClip({
    streamingText: JA_SPEECH,
    workerText: JA_SPEECH,
    playing: true,
    playingText: { subtitle: ZH_SUBTITLE, speechText: JA_SPEECH },
    vadSegments: [{ startMs: 100, endMs: 160 }],
  });
  assert.equal(jaEcho.finals.length, 0);
  assert.equal(jaEcho.drops.length, 1);
  assert.equal(jaEcho.drops[0].payload.matchedChars, 10, 'matched against the Japanese speech text');

  // …while an input that merely repeats the Chinese subtitle is NOT the audio: it never matches.
  const zhInput = await runClip({
    streamingText: ZH_SUBTITLE,
    workerText: ZH_SUBTITLE,
    playing: true,
    playingText: { subtitle: ZH_SUBTITLE, speechText: JA_SPEECH },
    vadSegments: [{ startMs: 100, endMs: 160 }],
  });
  assert.equal(zhInput.final.final, ZH_SUBTITLE, 'the subtitle is never used as the reference');
  assert.equal(zhInput.drops.length, 0);
  assert.equal(zhInput.candidates[0].payload.reason, 'not-similar');
  assert.equal(zhInput.candidates[0].payload.matched, false);
});

test('16) P2 拿不到 speechText → 放行且 reason=no-speech-text（不凭字幕猜测）', async () => {
  // A subtitle-only reference: the gate must not guess — the input is delivered.
  const subtitleOnly = await runClip({
    streamingText: PLAYING,
    workerText: PLAYING,
    playing: true,
    playingText: () => ({ subtitle: PLAYING }),
    vadSegments: [{ startMs: 100, endMs: 160 }],
  });
  assert.equal(subtitleOnly.final.final, PLAYING, 'an unknown reference always delivers');
  assert.equal(subtitleOnly.drops.length, 0);
  assert.equal(subtitleOnly.candidates[0].payload.reason, 'no-speech-text');
  assert.equal(subtitleOnly.candidates[0].payload.matched, false);
  assert.equal(subtitleOnly.candidates[0].payload.delivered, true);

  // Empty reference is the same answer, not `no-text` / not a drop.
  const empty = await runClip({
    streamingText: PLAYING,
    workerText: PLAYING,
    playing: true,
    playingText: '',
    vadSegments: [{ startMs: 100, endMs: 160 }],
  });
  assert.equal(empty.final.final, PLAYING);
  assert.equal(empty.candidates[0].payload.reason, 'no-speech-text');

  // A throwing getter is "no speech text", never a capture failure.
  const throwing = await runClip({
    streamingText: PLAYING,
    workerText: PLAYING,
    playing: true,
    playingText: () => { throw new Error('no player'); },
    vadSegments: [{ startMs: 100, endMs: 160 }],
  });
  assert.equal(throwing.final.final, PLAYING);
  assert.equal(throwing.candidates[0].payload.reason, 'no-speech-text');
});

test('17) P2 播放块切换：块 A 的 speechText 不匹配块 B 的输入', async () => {
  const BLOCK_A = '明日図書館に行きます';
  const BLOCK_B = '今日はいい天気ですね';
  const child = new FakeChild();
  const updates = [];
  const events = [];
  const clip = tone(1200);
  // The sounding block: speech text + subtitle, switched between the two clips.
  const state = { speechText: BLOCK_A, subtitle: '明天去图书馆' };

  const hearing = startHearing({
    ffmpegPath: 'ffmpeg-not-used',
    modelDir: 'models-not-used',
    finalModelDir: '',
    device: 'fake-device',
    recognizer: fakeStreaming({ endpointAtSamples: clip.length / 2, text: '' }),
    asrWorkerFactory: () => fakeWorker(BLOCK_A),
    spawnProcess: () => child,
    isVoicePlaying: () => true,
    playingText: () => ({ subtitle: state.subtitle, speechText: state.speechText }),
    vadFactory: () => fakeVad({ segments: [{ startMs: 100, endMs: 160 }] }),
    onUpdate: (event) => updates.push(event),
    onEvent: (type, payload) => events.push({ type, payload }),
  });

  // Block A is sounding: its own words are an echo and are dropped.
  child.stdout.write(clip);
  await until(() => dropsOf(events).length === 1);
  assert.equal(finalsOf(updates).length, 0);

  // The clip moved to block B. The same input is now NOT what is sounding: it must be delivered.
  state.speechText = BLOCK_B;
  state.subtitle = '今天天气真好';
  child.stdout.write(clip);
  await until(() => finalsOf(updates).length === 1);
  await delay(5);

  const finals = finalsOf(updates);
  assert.equal(finals.length, 1);
  assert.equal(finals[0].final, BLOCK_A, 'block A text is delivered while block B speaks');
  assert.equal(dropsOf(events).length, 1, 'only the block-A echo was dropped');
  const candidate = candidatesOf(events)[0];
  assert.equal(candidate.payload.reason, 'not-similar');
  assert.equal(candidate.payload.matched, false);
  hearing.stop();
});

test('18) P1 新增内容判定：correction / other / 单字符残余', async () => {
  const correction = await runClip({
    streamingText: `不对，${TOMORROW}`,
    workerText: `不对，${TOMORROW}`,
    playing: true,
    playingText: TOMORROW,
    vadSegments: [{ startMs: 100, endMs: 160 }],
  });
  assert.equal(correction.drops.length, 0);
  assert.equal(correction.candidates[0].payload.extraKind, 'correction');

  // A phrase of the user's own that the playing line never said: `other`, not a stop word.
  const phrase = await runClip({
    streamingText: `${TOMORROW}，顺便买杯咖啡`,
    workerText: `${TOMORROW}，顺便买杯咖啡`,
    playing: true,
    playingText: TOMORROW,
    vadSegments: [{ startMs: 100, endMs: 160 }],
  });
  assert.equal(phrase.drops.length, 0);
  assert.equal(phrase.candidates[0].payload.reason, 'mixed');
  assert.equal(phrase.candidates[0].payload.extraKind, 'other');
  assert.equal(phrase.candidates[0].payload.extraChars, 6, '「顺便买杯咖啡」');

  // One leftover real character is already user speech under P2: no 2-character threshold.
  const single = await runClip({
    streamingText: `${TOMORROW}吗`,
    workerText: `${TOMORROW}吗`,
    playing: true,
    playingText: TOMORROW,
    vadSegments: [{ startMs: 100, endMs: 160 }],
  });
  assert.equal(single.drops.length, 0, '「吗」turns the statement into a question');
  assert.equal(single.final.final, `${TOMORROW}吗`);
  assert.equal(single.candidates[0].payload.reason, 'mixed');
  assert.equal(single.candidates[0].payload.extraChars, 1, 'the residual is counted…');
  assert.equal(single.candidates[0].payload.extraKind, 'other', '…and is not a tone particle');
});

// ---------------------------------------------------------------------------
// P2: the residual rule is conservative — ANY real character outside the echo passes
// ---------------------------------------------------------------------------

/** The verdict for one input against the sounding line TOMORROW (playing, VAD exactly 0). */
const gateTomorrow = (text) => echoGate({
  text,
  playingText: TOMORROW,
  playing: true,
  vadSpeechRatio: 0,
});

test('19) P2 反例：单字「吗」把陈述变提问 → 放行，extraChars=1，residual=「吗」', async () => {
  const text = `${TOMORROW}吗`;
  const { final, drops, candidates, stats } = await runClip({
    streamingText: text,
    workerText: text,
    playing: true,
    playingText: TOMORROW,
    vadSegments: [{ startMs: 100, endMs: 160 }],
  });
  assert.equal(drops.length, 0, 'one real character is enough: no 2-character threshold');
  assert.equal(final.final, text, 'delivered verbatim');
  assert.equal(stats.echoDropped, 0);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].payload.reason, 'mixed');
  assert.equal(candidates[0].payload.extraChars, 1);
  assert.equal(candidates[0].payload.extraKind, 'other', '「吗」is real content, not a protection word');
  assert.equal(candidates[0].payload.delivered, true);

  // The residual is carried on the verdict (`hearing.js` writes extraChars/extraKind to the event).
  const verdict = gateTomorrow(text);
  assert.equal(verdict.drop, false);
  assert.equal(verdict.reason, 'mixed');
  assert.equal(verdict.extraChars, 1);
  assert.equal(verdict.residual, '吗');
});

test('20) P2 纯回声对照：「我明天会去图书馆学习」→ 仍 drop（功能未关闭）', async () => {
  const { finals, drops, candidates, stats } = await runClip({
    streamingText: TOMORROW,
    workerText: TOMORROW,
    playing: true,
    playingText: TOMORROW,
    vadSegments: [{ startMs: 100, endMs: 160 }],
  });
  assert.equal(finals.length, 0, 'a pure echo is still withheld');
  assert.equal(drops.length, 1);
  assert.equal(drops[0].payload.reason, 'playback-echo');
  assert.equal(drops[0].payload.extraChars, 0);
  assert.equal(drops[0].payload.extraKind, '');
  assert.equal(candidates.length, 0);
  assert.equal(stats.echoDropped, 1);
  const verdict = gateTomorrow(TOMORROW);
  assert.equal(verdict.drop, true);
  assert.equal(verdict.residual, '');
});

test('21) P2 纯回声 + 语气词/标点「…啊。」「…呢」→ 仍 drop', async () => {
  for (const suffix of ['啊。', '呢', '吧', '嘛', '啦', '哇', '咯', '诶', '欸', '呀', '哦', '嗯']) {
    const verdict = gateTomorrow(`${TOMORROW}${suffix}`);
    assert.equal(verdict.drop, true, `「${suffix}」is a tone particle/punctuation, not new speech`);
    assert.equal(verdict.extraChars, 0, `「${suffix}」is stripped before counting`);
    assert.equal(verdict.extraKind, '');
  }
  // The same answer through the real delivery path, for the two suffixes named in the ticket.
  const withParticle = await runClip({
    streamingText: `${TOMORROW}啊。`,
    workerText: `${TOMORROW}啊。`,
    playing: true,
    playingText: TOMORROW,
    vadSegments: [{ startMs: 100, endMs: 160 }],
  });
  assert.equal(withParticle.finals.length, 0);
  assert.equal(withParticle.drops.length, 1);
  assert.equal(withParticle.drops[0].payload.extraChars, 0);

  const withNe = await runClip({
    streamingText: `${TOMORROW}呢`,
    workerText: `${TOMORROW}呢`,
    playing: true,
    playingText: TOMORROW,
    vadSegments: [{ startMs: 100, endMs: 160 }],
  });
  assert.equal(withNe.finals.length, 0);
  assert.equal(withNe.drops.length, 1);
});

test('22) P2 单字新增「谁」「不」「停」→ 放行（判定不看词表）', async () => {
  const cases = [
    { suffix: '谁', kind: 'other' },
    { suffix: '不', kind: 'negation', label: 'negation label only; the pass comes from the residual' },
    { suffix: '停', kind: 'stop', label: 'stop label only; the pass comes from the residual' },
  ];
  for (const { suffix, kind } of cases) {
    const verdict = gateTomorrow(`${TOMORROW}${suffix}`);
    assert.equal(verdict.drop, false, `「${suffix}」must pass`);
    assert.equal(verdict.reason, 'mixed');
    assert.equal(verdict.extraChars, 1);
    assert.equal(verdict.extraKind, kind);
  }

  const stop = await runClip({
    streamingText: `${TOMORROW}停`,
    workerText: `${TOMORROW}停`,
    playing: true,
    playingText: TOMORROW,
    vadSegments: [{ startMs: 100, endMs: 160 }],
  });
  assert.equal(stop.drops.length, 0);
  assert.equal(stop.final.final, `${TOMORROW}停`);
  assert.equal(stop.candidates[0].payload.reason, 'mixed');
  assert.equal(stop.candidates[0].payload.extraKind, 'stop');
  assert.equal(stop.candidates[0].payload.extraChars, 1);
});

test('23) P2 新增 2 字以上实词「顺便买咖啡」→ 放行', async () => {
  const text = `${TOMORROW}，顺便买咖啡`;
  const { final, drops, candidates } = await runClip({
    streamingText: text,
    workerText: text,
    playing: true,
    playingText: TOMORROW,
    vadSegments: [{ startMs: 100, endMs: 160 }],
  });
  assert.equal(drops.length, 0);
  assert.equal(final.final, text);
  assert.equal(candidates[0].payload.reason, 'mixed');
  assert.equal(candidates[0].payload.extraKind, 'other');
  assert.equal(candidates[0].payload.extraChars, 5, '「顺便买咖啡」');

  const verdict = gateTomorrow(text);
  assert.equal(verdict.drop, false);
  assert.equal(verdict.residual, '顺便买咖啡');
  assert.equal(verdict.extraChars, 5);
});

test('24) P2 回归：无 speechText / 未播放 → 放行（含单字新增）', async () => {
  const text = `${TOMORROW}吗`;
  assert.equal(echoGate({ text, playingText: '', playing: true, vadSpeechRatio: 0 }).reason, 'no-speech-text');
  assert.equal(echoGate({ text, playingText: TOMORROW, playing: false, vadSpeechRatio: 0 }).reason, 'not-playing');
  // A high real VAD still passes, and a null VAD is never guessed.
  assert.equal(echoGate({ text: TOMORROW, playingText: TOMORROW, playing: true, vadSpeechRatio: 0.3 }).reason, 'vad-high');
  assert.equal(echoGate({ text: TOMORROW, playingText: TOMORROW, playing: true, vadSpeechRatio: null }).reason, 'no-vad');

  const notPlaying = await runClip({
    streamingText: text,
    workerText: text,
    playing: false,
    playingText: TOMORROW,
    vadSegments: [{ startMs: 100, endMs: 160 }],
  });
  assert.equal(notPlaying.final.final, text);
  assert.equal(notPlaying.drops.length, 0);
  assert.equal(notPlaying.candidates[0].payload.reason, 'not-playing');
});
