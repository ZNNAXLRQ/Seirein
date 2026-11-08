/**
 * Continuous dialogue capture, hearing side: capture + boundaries only.
 *
 * `createDialogueContext()` already owns the buffer; this suite pins how the capture loop feeds it:
 *  1. every DELIVERED final is pushed in capture order, one `hearing.dialogue.appended` per text;
 *  2. a partial never enters the buffer;
 *  3. a second delivery of the same utteranceId inside the repeat window is the same speech and is
 *     pushed once (a different utterance identity with the same words still is new speech);
 *  4. a source change (microphone → loopback) is `boundary(source-switch)` — event and buffer;
 *  5. silence longer than `DIALOGUE_IDLE_MS` is `boundary(idle)`, lazily on the capture frame, and
 *     speech after it does not repeat the boundary;
 *  6. delivery is untouched: the finals are byte-identical with capture on and off;
 *  7. `dialogueSnapshot()` is a read-only view — nothing is injected this round;
 *  8. two captures sharing one buffer: a source switch is an automatic boundary reported as
 *     `voice.dialogue.source-boundary` and render() never splices the two sources together; the
 *     same source on two devices is NOT a source change.
 *
 * No microphone, ffmpeg, sherpa model or real thread is used. The capture clock is injected, so the
 * 30 s idle threshold is crossed without waiting; a fake worker supplies the refined text (the
 * worker path is where the `hearing.dialogue.*` rows exist, like `hearing.asr.*`).
 *
 * Run: node --test test/dialogue-capture.mjs
 * Regression: node --test test/hearing-*.mjs test/asr-tags.mjs test/noise-shadow.mjs
 *             node test/smoke.mjs
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import {
  DIALOGUE_IDLE_MS,
  DIALOGUE_REPEAT_WINDOW_MS,
  createDialogueCapture,
  parseUtteranceId,
  startHearing,
} from '../src/host/hearing/hearing.js';
import { createDialogueContext } from '../src/host/session/conversation/dialogueContext.js';

const SAMPLE_RATE = 16000;
/** A real microphone endpoint name (never a loopback). */
const MIC = 'Fake Microphone (USB)';
/** A DirectShow loopback name: `isLoopbackDevice()` classifies it as `loopback`. */
const LOOPBACK = 'CABLE Output (VB-Audio Virtual Cable)';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until `predicate()` is true; a missed deadline fails the test instead of hanging it. */
async function until(predicate, label, timeoutMs = 3000) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) assert.fail(`timed out: ${label}`);
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

/** Digital silence: a captured frame with nothing to recognize (the idle case). */
function silence(ms) {
  return Buffer.alloc(Math.round((SAMPLE_RATE * ms) / 1000) * 2);
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

/** Worker stand-in mirroring `asr-worker.js`: one scripted refined text per decode request. */
function fakeWorker(texts) {
  const queue = [...texts];
  const worker = new EventEmitter();
  worker.messages = [];
  worker.unref = () => {};
  worker.terminate = () => {
    worker.emit('exit', null);
  };
  worker.postMessage = (message) => {
    worker.messages.push(message);
    const text = queue.length > 0 ? queue.shift() : '';
    setImmediate(() => worker.emit('message', { type: 'result', id: message.id, text }));
  };
  return worker;
}

/**
 * Start one fake hearing session.
 *
 * `onUpdate` may return a host verdict (`false` / `{accepted:false, reason}` / `true`): the session
 * records the update first, then forwards that value to hearing, exactly like a host callback that
 * owns barge-in. Without it the callback returns `undefined` — the legacy contract.
 *
 * @param {{clock?: Function, device?: string, texts?: string[],
 *          dialogueFactory?: Function, streamingText?: string,
 *          isVoicePlaying?: Function, onUpdate?: Function}} [options]
 */
function startSession({
  clock, device = MIC, texts = [], dialogueFactory,
  streamingText = '流式草稿', isVoicePlaying, onUpdate,
} = {}) {
  const child = new FakeChild();
  const updates = [];
  const events = [];
  const worker = fakeWorker(texts);
  const hearing = startHearing({
    ffmpegPath: 'ffmpeg-not-used',
    modelDir: 'models-not-used',
    finalModelDir: '',
    device,
    recognizer: fakeStreaming({ endpointAtSamples: SAMPLE_RATE, text: streamingText }),
    asrWorkerFactory: () => worker,
    spawnProcess: () => child,
    ...(clock === undefined ? {} : { now: clock }),
    ...(dialogueFactory === undefined ? {} : { dialogueFactory }),
    ...(isVoicePlaying === undefined ? {} : { isVoicePlaying }),
    onUpdate: (event) => {
      updates.push(event);
      return onUpdate?.(event);
    },
    onEvent: (type, payload) => events.push({ type, payload }),
  });
  const finals = () => updates.filter((event) => typeof event.final === 'string');
  const ofType = (type) => events.filter((event) => event.type === type);
  return { child, hearing, updates, events, worker, finals, ofType };
}

/** Write one 1 s utterance (the fake endpoint is 1 s) and wait for its delivered final. */
async function speak(session, ms = 1000) {
  const before = session.finals().length;
  session.child.stdout.write(tone(ms));
  await until(() => session.finals().length > before, 'the delivered final');
  return session.finals()[before];
}

// ---------------------------------------------------------------------------
// 1. Two delivered finals enter the buffer in capture order
// ---------------------------------------------------------------------------

test('1. 两段最终文本按采集顺序入缓冲；hearing.dialogue.appended 恰好两条', async () => {
  let clockValue = 1_000;
  const context = createDialogueContext({ source: 'mic', now: () => clockValue });
  const session = startSession({
    clock: () => clockValue,
    dialogueFactory: () => context,
    texts: ['第一段：门是开着的。', '第二段：里面没有人。'],
  });

  const first = await speak(session);
  clockValue = 2_000;
  const second = await speak(session);

  assert.equal(first.final, '第一段：门是开着的。');
  assert.equal(second.final, '第二段：里面没有人。');
  assert.equal(first.refined, true, 'the accurate pass still owns the delivered text');

  const recent = context.snapshot().recent;
  assert.deepEqual(recent.map((entry) => entry.text), ['第一段：门是开着的。', '第二段：里面没有人。']);
  assert.deepEqual(recent.map((entry) => entry.at), [1_000, 2_000], 'the capture timestamp is the endpoint');
  assert.deepEqual(recent.map((entry) => entry.source), ['mic', 'mic']);

  const appended = session.ofType('hearing.dialogue.appended');
  assert.equal(appended.length, 2, 'two finals, two appended rows');
  assert.deepEqual(appended.map((event) => event.payload), [
    { chars: '第一段：门是开着的。'.length, at: 1_000, utteranceId: first.utteranceId },
    { chars: '第二段：里面没有人。'.length, at: 2_000, utteranceId: second.utteranceId },
  ]);
  assert.ok(appended.every((event) => parseUtteranceId(event.payload.utteranceId) !== null),
    'the buffer is keyed by the scoped id');

  const view = session.hearing.dialogueSnapshot();
  assert.deepEqual(Object.keys(view).sort(), ['generation', 'needsSummary', 'pendingVersion', 'renderText']);
  assert.equal(view.needsSummary, false);
  assert.equal(view.pendingVersion, 0);
  assert.equal(view.generation, 1);
  assert.ok(view.renderText.indexOf('第一段：门是开着的。') < view.renderText.indexOf('第二段：里面没有人。'));
  session.hearing.stop();
});

// ---------------------------------------------------------------------------
// 2. A partial never enters the buffer
// ---------------------------------------------------------------------------

test('2. partial 不进入缓冲，也不产生 appended 事件', async () => {
  const context = createDialogueContext({ source: 'mic' });
  const session = startSession({ clock: () => 1_000, dialogueFactory: () => context });

  session.child.stdout.write(tone(200)); // below the 1 s endpoint: a partial only
  await until(() => session.updates.some((event) => typeof event.partial === 'string'), 'a partial update');

  assert.equal(session.finals().length, 0, 'no endpoint, so nothing was delivered');
  assert.equal(session.ofType('hearing.dialogue.appended').length, 0, 'partials write no appended row');
  assert.equal(context.snapshot().recent.length, 0, 'the buffer stayed empty');
  assert.equal(context.snapshot().pending.length, 0);
  assert.equal(session.hearing.dialogueSnapshot().renderText, '');
  session.hearing.stop();
});

// ---------------------------------------------------------------------------
// 3. The same utteranceId is captured once (repeat window)
// ---------------------------------------------------------------------------

test('3. 同一 utteranceId 重复投稿只入缓冲一次；不同 utteranceId 的同句是新语音', () => {
  const context = createDialogueContext({ now: () => 5_000 });
  const events = [];
  const capture = createDialogueCapture({
    context,
    source: 'mic',
    now: () => 5_000,
    emit: (type, payload) => events.push({ type, payload }),
  });

  assert.ok(capture.push({ text: '同一句。', at: 1_000, utteranceId: 'u7' }));
  assert.equal(
    capture.push({ text: '同一句。', at: 1_200, utteranceId: 'u7' }),
    null,
    'a second delivery of the same utterance is not pushed',
  );
  assert.equal(context.snapshot().recent.length, 1);
  assert.equal(events.filter((event) => event.type === 'hearing.dialogue.appended').length, 1);

  // The same words said again are new speech: the utterance identity decides, not the text.
  assert.ok(capture.push({ text: '同一句。', at: 1_400, utteranceId: 'u8' }));
  assert.equal(context.snapshot().recent.length, 2);

  // Past the window the memory is dropped, so the identity alone no longer suppresses.
  const later = 1_400 + DIALOGUE_REPEAT_WINDOW_MS + 1;
  assert.ok(capture.push({ text: '同一句。', at: later, utteranceId: 'u7' }));
  assert.equal(context.snapshot().recent.length, 3);
  assert.equal(events.filter((event) => event.type === 'hearing.dialogue.appended').length, 3);

  capture.close('stop');
  assert.equal(
    capture.push({ text: '停止之后。', at: later + 1_000, utteranceId: 'u9' }),
    null,
    'a closed capture takes no more text',
  );
});

// ---------------------------------------------------------------------------
// 4. Microphone → loopback is a source-switch boundary
// ---------------------------------------------------------------------------

test('4. 设备切换（麦克风 → 回环）→ boundary(source-switch) 事件与缓冲边界标记', async () => {
  let clockValue = 1_000;
  const shared = createDialogueContext({ source: 'mic', now: () => clockValue });
  const factory = () => shared;

  const microphone = startSession({
    clock: () => clockValue,
    device: MIC,
    dialogueFactory: factory,
    texts: ['麦克风里的一句。'],
  });
  await speak(microphone);
  assert.equal(shared.snapshot().segment, 0, 'the first session runs in segment 0');
  microphone.hearing.stop();
  assert.equal(shared.snapshot().boundaryReason, 'stop', 'stopping listening closes the segment');
  assert.equal(shared.snapshot().segment, 1);

  clockValue = 2_000;
  const loopback = startSession({
    clock: () => clockValue,
    device: LOOPBACK,
    dialogueFactory: factory,
    texts: ['回环里的一句。'],
  });
  const boundaries = loopback.ofType('hearing.dialogue.boundary');
  assert.deepEqual(boundaries.map((event) => event.payload.reason), ['source-switch'], 'the switch is reported');
  assert.equal(shared.snapshot().boundaryReason, 'source-switch', 'the buffer carries the same boundary');
  assert.equal(shared.snapshot().segment, 2, 'the new source starts a new segment');

  await speak(loopback);
  const view = loopback.hearing.dialogueSnapshot();
  assert.ok(view.renderText.includes('source-switch'), 'the rendered context names the boundary cause');
  assert.ok(
    view.renderText.indexOf('麦克风里的一句。') < view.renderText.indexOf('回环里的一句。'),
    'the earlier text stays before the boundary',
  );
  const sources = shared.snapshot().recent.map((entry) => entry.source);
  assert.deepEqual(sources, ['mic', 'loopback'], 'each utterance keeps the source it came from');
  loopback.hearing.stop();
});

// ---------------------------------------------------------------------------
// 5. A long silence is an idle boundary, exactly once
// ---------------------------------------------------------------------------

test('5. 静默超过 30 s → boundary(idle)；恢复说话后不重复标记', async () => {
  let clockValue = 1_000;
  const context = createDialogueContext({ source: 'mic', now: () => clockValue });
  const session = startSession({
    clock: () => clockValue,
    dialogueFactory: () => context,
    texts: ['先说话。', '很久以后又说。'],
  });

  await speak(session);
  assert.equal(session.ofType('hearing.dialogue.boundary').length, 0, 'no boundary while it is still speaking');

  // The capture is open and silent: the next frame already ticks past the idle threshold.
  clockValue = 1_000 + DIALOGUE_IDLE_MS + 1_000;
  session.child.stdout.write(silence(100));
  await until(() => session.ofType('hearing.dialogue.boundary').length === 1, 'the idle boundary');

  const [idle] = session.ofType('hearing.dialogue.boundary');
  assert.deepEqual(idle.payload, { reason: 'idle' });
  assert.equal(context.snapshot().boundaryReason, 'idle');
  assert.equal(session.ofType('hearing.dialogue.appended').length, 1, 'silence is not text');

  // Speech after the boundary opens the new segment; the same silence is not marked twice.
  clockValue += 1_000;
  await speak(session);
  const idleRows = session.ofType('hearing.dialogue.boundary').filter((event) => event.payload.reason === 'idle');
  assert.equal(idleRows.length, 1, 'one idle boundary per silent gap');
  assert.equal(session.ofType('hearing.dialogue.appended').length, 2);
  assert.equal(context.snapshot().recent.length, 2);
  assert.equal(context.snapshot().segment, 1, 'the idle boundary opened one new segment');
  session.hearing.stop();
});

// ---------------------------------------------------------------------------
// 6. Delivery is untouched: the finals are identical with capture on and off
// ---------------------------------------------------------------------------

test('6. 投递内容与改动前一致：finals 文本、refined、utteranceId 都不变', async () => {
  const script = ['第一句。', '第二句，带标点。'];

  const run = async (dialogueFactory) => {
    let clockValue = 1_000;
    const session = startSession({ clock: () => clockValue, dialogueFactory, texts: [...script] });
    const delivered = [];
    for (let index = 0; index < script.length; index += 1) {
      clockValue += 1_000;
      delivered.push(await speak(session));
    }
    session.hearing.stop();
    return delivered;
  };

  const captured = await run(() => createDialogueContext({ source: 'mic' }));
  // `null` from the factory disables capture: this is the pre-change delivery path.
  const uncaptured = await run(() => null);

  assert.deepEqual(captured.map((update) => update.final), script, 'the captured text is exactly the delivered text');
  // The instance prefix necessarily differs between two launches; the local seq must not.
  assert.deepEqual(
    captured.map((update) => ({
      final: update.final, refined: update.refined, seq: parseUtteranceId(update.utteranceId).seq,
    })),
    uncaptured.map((update) => ({
      final: update.final, refined: update.refined, seq: parseUtteranceId(update.utteranceId).seq,
    })),
    'capturing never changes what is delivered',
  );
  assert.deepEqual(captured.map((update) => parseUtteranceId(update.utteranceId).seq), [1, 2]);
  assert.equal(captured[0].refined, true);
});

// ---------------------------------------------------------------------------
// 7. Two captures, one shared buffer: the source switch is an automatic boundary
// ---------------------------------------------------------------------------

test('7. 麦克风与回环共享缓冲：来源切换自动成界，事件 voice.dialogue.source-boundary，渲染不拼接', () => {
  const shared = createDialogueContext({ now: () => 1_000 });
  const events = [];
  const emit = (type, payload) => events.push({ type, payload });
  const microphone = createDialogueCapture({ context: shared, source: 'mic', now: () => 1_000, emit });
  const loopback = createDialogueCapture({ context: shared, source: 'loopback', now: () => 2_000, emit });

  microphone.push({ text: '我不舒服，', at: 1_000, utteranceId: 'mic-1' });
  loopback.push({ text: '你去拿药吧。', at: 2_000, utteranceId: 'loop-1' });
  microphone.push({ text: '我想回家。', at: 3_000, utteranceId: 'mic-2' });

  assert.deepEqual(
    events.filter((event) => event.type === 'voice.dialogue.source-boundary').map((event) => event.payload),
    [
      { from: 'mic', to: 'loopback', at: 2_000 },
      { from: 'loopback', to: 'mic', at: 3_000 },
    ],
    'each capture change writes one debug row with both sources and the moment it happened',
  );
  assert.equal(shared.snapshot().segment, 2, 'two switches opened two segments');

  const rendered = shared.render();
  assert.ok(rendered.includes('[麦克风] 我不舒服，'), 'the microphone line keeps its source tag');
  assert.ok(rendered.includes('[系统声音] 你去拿药吧。'), 'the loopback line keeps its source tag');
  assert.ok(rendered.includes('来源切换：麦克风 → 系统声音'));
  assert.ok(rendered.includes('来源切换：系统声音 → 麦克风'));
  assert.ok(!rendered.includes('我不舒服，你去拿药吧。'), 'the two captures never become one sentence');
  assert.ok(!rendered.includes('我不舒服，我想回家。'), 'the same capture is not rejoined across another source');
  assert.ok(
    rendered.indexOf('我不舒服') < rendered.indexOf('你去拿药吧')
      && rendered.indexOf('你去拿药吧') < rendered.indexOf('我想回家'),
    'render order is time order',
  );
});

// ---------------------------------------------------------------------------
// 8. Same source on two devices is NOT a source change
// ---------------------------------------------------------------------------

test('8. 同来源不同设备（mic A → mic B）不算来源切换：不写边界事件，未完句照常合并', () => {
  const shared = createDialogueContext({ now: () => 1_000 });
  const events = [];
  const emit = (type, payload) => events.push({ type, payload });
  const micA = createDialogueCapture({ context: shared, source: 'mic', now: () => 1_000, emit });
  const micB = createDialogueCapture({ context: shared, source: 'mic', now: () => 2_000, emit });

  micA.push({ text: '钥匙在柜子里，', at: 1_000, utteranceId: 'micA-1', source: 'mic' });
  micB.push({ text: '你去拿吧。', at: 2_000, utteranceId: 'micB-1', source: 'mic' });

  assert.equal(
    events.filter((event) => event.type === 'voice.dialogue.source-boundary').length,
    0,
    'the same source writes no source-boundary row, whatever the device',
  );
  assert.equal(shared.snapshot().segment, 0, 'no source segment was opened');
  const rendered = shared.render();
  assert.ok(rendered.includes('钥匙在柜子里，你去拿吧。'), 'the unfinished sentence still merges within one source');
  assert.ok(!rendered.includes('来源切换'), 'no source divider');
  assert.deepEqual(shared.snapshot().recent.map((entry) => entry.source), ['mic', 'mic']);
});

// ---------------------------------------------------------------------------
// 9. A playback echo the host refused never enters the buffer
// ---------------------------------------------------------------------------

test('9. 播放中的回授（宿主判定 drop）→ 不入缓冲、写 hearing.dialogue.gated，原投递路径不变', async () => {
  const assistantLine = '我在听你说。';
  const run = async (device, source) => {
    const context = createDialogueContext({ source });
    const session = startSession({
      clock: () => 1_000,
      device,
      texts: [assistantLine],
      streamingText: assistantLine,
      isVoicePlaying: () => true,
      dialogueFactory: () => context,
      // The host owns barge-in: while its own voice sounds, this exact line is an echo, not a user.
      onUpdate: (event) => (event.final === assistantLine
        ? { accepted: false, reason: 'playback-echo' }
        : { accepted: true }),
    });
    const delivered = await speak(session);
    assert.equal(delivered.final, assistantLine, 'hearing still hands the final to the host unchanged');
    assert.equal(session.finals().length, 1, 'the pre-existing delivery rule is untouched');
    assert.equal(context.snapshot().recent.length, 0, 'a refused echo never enters the continuous dialogue');
    assert.equal(session.ofType('hearing.dialogue.appended').length, 0);
    const gated = session.ofType('hearing.dialogue.gated');
    assert.equal(gated.length, 1, 'the refusal is recorded once');
    assert.deepEqual(gated[0].payload, {
      level: 'debug', reason: 'playback-echo', utteranceId: delivered.utteranceId, source,
    });
    session.hearing.stop();
  };
  // The microphone hears the assistant's own speaker; the loopback echoes it. Both are gated.
  await run(MIC, 'mic');
  await run(LOOPBACK, 'loopback');
});

// ---------------------------------------------------------------------------
// 10. Real user speech while playing passes barge-in and is captured
// ---------------------------------------------------------------------------

test('10. 播放中真实用户说话（barge-in 接受）→ 入缓冲并照常投递', async () => {
  const context = createDialogueContext({ source: 'mic', now: () => 2_000 });
  const playing = true;
  const session = startSession({
    clock: () => 2_000,
    texts: ['等一下'],
    streamingText: '等一下',
    isVoicePlaying: () => playing,
    dialogueFactory: () => context,
    // A new short utterance while playing is barge-in, not the assistant's line: accept and buffer.
    onUpdate: () => ({ accepted: true, reason: 'barge-in' }),
  });

  const delivered = await speak(session);
  assert.equal(delivered.final, '等一下');
  assert.equal(context.snapshot().recent.length, 1, 'accepted user speech is captured');
  assert.equal(context.snapshot().recent[0].text, '等一下');
  assert.equal(session.ofType('hearing.dialogue.appended').length, 1);
  assert.equal(session.ofType('hearing.dialogue.gated').length, 0, 'nothing was gated');
  session.hearing.stop();
});

// ---------------------------------------------------------------------------
// 11. No host verdict (legacy callback) falls back to the delivery gate
// ---------------------------------------------------------------------------

test('11. 未播放、宿主不返回判定（旧 onUpdate）→ 沿用投递判定入缓冲', async () => {
  const context = createDialogueContext({ source: 'mic', now: () => 3_000 });
  const session = startSession({
    clock: () => 3_000,
    texts: ['今天天气不错。'],
    streamingText: '今天天气不错。',
    isVoicePlaying: () => false,
    dialogueFactory: () => context,
    // No return value: the pre-existing contract.
  });

  await speak(session);
  assert.equal(context.snapshot().recent.length, 1);
  assert.equal(context.snapshot().recent[0].text, '今天天气不错。');
  assert.equal(session.ofType('hearing.dialogue.appended').length, 1);
  assert.equal(session.ofType('hearing.dialogue.gated').length, 0);
  session.hearing.stop();
});

// ---------------------------------------------------------------------------
// 12. Noise-filtered (no-text) audio never reaches the buffer
// ---------------------------------------------------------------------------

test('12. 被噪声过滤（no-text）的片段：不入缓冲，也不算“宿主丢弃”', async () => {
  const context = createDialogueContext({ source: 'mic' });
  const session = startSession({
    clock: () => 4_000,
    texts: [''],
    streamingText: '',
    isVoicePlaying: () => false,
    dialogueFactory: () => context,
    onUpdate: () => ({ accepted: true }),
  });

  session.child.stdout.write(tone(1000));
  await until(() => session.ofType('hearing.filtered').length === 1, 'the filtered event');
  assert.equal(session.ofType('hearing.filtered')[0].payload.reason, 'no-text');
  assert.equal(session.finals().length, 0, 'no final update was delivered');
  assert.equal(context.snapshot().recent.length, 0, 'noise never enters the dialogue buffer');
  assert.equal(session.ofType('hearing.dialogue.appended').length, 0);
  assert.equal(
    session.ofType('hearing.dialogue.gated').length,
    0,
    'gated means a delivered final the host refused, not audio that never became a final',
  );
  session.hearing.stop();
});

// ---------------------------------------------------------------------------
// 13. The third host verdict (inactive: component closed / capture stopping) also gates the buffer
// ---------------------------------------------------------------------------

test('13. 宿主返回 inactive（组件关闭/停止丢弃）→ 同样不入缓冲并记录 reason', async () => {
  const context = createDialogueContext({ source: 'mic' });
  const session = startSession({
    clock: () => 5_000,
    device: MIC,
    texts: ['关闭前的一句。'],
    streamingText: '关闭前的一句。',
    isVoicePlaying: () => false,
    dialogueFactory: () => context,
    // The shipped host returns this while the hearing component is closed: delivery continues,
    // the continuous dialogue does not capture it.
    onUpdate: () => ({ accepted: false, reason: 'inactive' }),
  });

  const delivered = await speak(session);
  assert.equal(delivered.final, '关闭前的一句。', 'hearing still hands the final to the host unchanged');
  assert.equal(context.snapshot().recent.length, 0, 'an inactive fragment never enters the buffer');
  const gated = session.ofType('hearing.dialogue.gated');
  assert.equal(gated.length, 1, 'the refusal is recorded once');
  assert.deepEqual(gated[0].payload, {
    level: 'debug', reason: 'inactive', utteranceId: delivered.utteranceId, source: 'mic',
  });
  session.hearing.stop();
});
