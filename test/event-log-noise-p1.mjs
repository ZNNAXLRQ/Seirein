/**
 * Event-log noise reduction — P1 (the six paths outside `index.js`).
 *
 * The P0 round fixed `sandbox.skipped`, `spout.alpha.sample` and `avatar.preset.commit`. This round
 * gates the next six writers, without touching any business decision:
 *   1. `spout.stage2`: a healthy steady sample writes once per 60 s; a counter change, an alphaMode
 *      change or `fps < 30` is written at once, and `snapshot().stage2` keeps the newest sample.
 *   2. `hearing.endpoint.detail`: a speech-bearing endpoint (group / non-silence / offline split) is
 *      always written; a text-less silence-only endpoint is sampled 1-in-10 and the rest are
 *      counted into `hearing.endpoint.detail.summary {count, sampled, windowMs}`.
 *   3. `asr.delivery.order`: delivered slots stay one row each; skipped slots collapse into
 *      `asr.delivery.order.summary {count, firstSeq, lastSeq}` every 60 s / 100 slots (and at stop).
 *   4. `memory.auto.skipped`: first row per session, then one `memory.auto.skipped.summary` per
 *      5 min (or at the session's turn/end); `memory.auto.failed` still writes one row per failure.
 *   5. `hearing.vad.shadow.suppressed` / `hearing.noise.shadow.suppressed`: one counting row per
 *      60 s instead of one row per suppressed occurrence.
 *   6. `avatar.animation.end`: an `isIdle: true` End is counted (`state.animations.idleEnds`) but
 *      not written; a non-idle End stays per occurrence.
 *
 * Run: node --test test/event-log-noise-p1.mjs
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { startHearing } from '../src/host/hearing/hearing.js';
import {
  ALPHA_SAMPLE_LOG_INTERVAL_MS,
  SpoutLayer,
  STAGE2_LOG_INTERVAL_MS,
  STAGE2_MIN_FPS,
} from '../src/host/avatar/spoutLayer.js';
import { VtsClient } from '../src/host/avatar/vts.js';
import { createAutoMemoryRecorder, SKIP_SUMMARY_WINDOW_MS } from '../src/host/memory/auto-recorder.js';

const SAMPLE_RATE = 16000;
const delay = (ms) => new Promise((done) => setTimeout(done, ms));

/** Poll until `predicate()` is true; a missed deadline fails the test instead of hanging it. */
async function until(predicate, timeoutMs = 4000) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('timed out waiting for condition');
    await delay(5);
  }
}

/** Synchronous event capture: `void emitEvent` must be visible right after the call. */
function createLog() {
  const events = [];
  return {
    events,
    emit(type, payload) {
      events.push({ type, payload });
    },
    ofType(type) {
      return events.filter((event) => event.type === type).map((event) => event.payload);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// 1. spout.stage2 — change/degradation immediate, steady 60 s heartbeat, snapshot always newest
// ---------------------------------------------------------------------------------------------

const stage2Line = (overrides = {}) => JSON.stringify({
  type: 'diagnostic',
  event: 'spout.stage2',
  fps: 60,
  dropped: 0,
  resized: 0,
  framebufferErrors: 0,
  alphaMode: 'premultiplied',
  at: Date.now(),
  ...overrides,
});

function createLayer(stage2LogIntervalMs) {
  const log = createLog();
  const layer = new SpoutLayer({
    root: 'C:\\tmp\\event-log-noise-p1',
    settings: () => ({ electronExecutable: 'C:\\tmp\\electron.exe' }),
    log,
    ...(stage2LogIntervalMs === undefined ? {} : { stage2LogIntervalMs }),
  });
  return { layer, log };
}

test('1. spout.stage2: steady → one line per window; fps drop / counter change immediate; snapshot newest', async () => {
  assert.equal(STAGE2_LOG_INTERVAL_MS, 60_000, 'the shipping heartbeat is 60 s');
  assert.equal(STAGE2_MIN_FPS, 30, 'fps below 30 counts as a degradation');
  assert.equal(createLayer().layer.stage2LogIntervalMs, 60_000, 'the default is applied');

  // 40 ms window: the heartbeat is observable without a minute-long test.
  const { layer, log } = createLayer(40);

  for (let index = 0; index < 60; index += 1) layer.handleLine(stage2Line());
  const first = log.ofType('spout.stage2');
  assert.equal(first.length, 1, '60 healthy steady samples → 1 written row');
  assert.equal(first[0].suppressed, 0, 'the first row folds nothing');
  assert.equal(first[0].windowMs, 40, 'the counting row reports its window');

  // A healthy sample inside the window is not written, yet the status snapshot is the newest one.
  layer.handleLine(stage2Line({ fps: 58.4 }));
  assert.equal(log.ofType('spout.stage2').length, 1, 'a steady sample inside the window is not written');
  assert.equal(layer.snapshot().stage2.fps, 58.4, 'snapshot().stage2 carries the newest sample');

  // Degradation is never throttled: one low-fps sample is written immediately.
  layer.handleLine(stage2Line({ fps: 20 }));
  const afterDrop = log.ofType('spout.stage2');
  assert.equal(afterDrop.length, 2, 'fps 20 is written at once');
  assert.equal(afterDrop[1].fps, 20);
  assert.equal(afterDrop[1].suppressed, 60, 'the folded samples are counted on the new row');

  // A counter change is written immediately, before the heartbeat window elapses.
  layer.handleLine(stage2Line({ fps: 60, dropped: 1 }));
  assert.equal(log.ofType('spout.stage2').length, 3, 'a dropped change is written at once');
  assert.equal(log.ofType('spout.stage2')[2].dropped, 1);

  // An alphaMode change is written immediately too.
  layer.handleLine(stage2Line({ fps: 60, dropped: 1, alphaMode: 'straight' }));
  assert.equal(log.ofType('spout.stage2').length, 4, 'an alphaMode change is written at once');
  assert.equal(log.ofType('spout.stage2')[3].alphaMode, 'straight');

  // Heartbeat: only once the window has elapsed does the next steady sample reach the log.
  layer.handleLine(stage2Line({ fps: 60, dropped: 1, alphaMode: 'straight' }));
  assert.equal(log.ofType('spout.stage2').length, 4, 'still inside the window');
  await delay(80);
  layer.handleLine(stage2Line({ fps: 60, dropped: 1, alphaMode: 'straight' }));
  const heartbeat = log.ofType('spout.stage2');
  assert.equal(heartbeat.length, 5, 'the heartbeat writes the steady sample');
  assert.equal(heartbeat[4].suppressed, 1, 'the heartbeat carries the folded count');
});

// ---------------------------------------------------------------------------------------------
// 2. hearing.endpoint.detail — speech rows always, silence-only 1/10 + 60 s summary
// ---------------------------------------------------------------------------------------------

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

/** 440 Hz tone: loud enough to pass the RMS gate and to form a group. */
function tone(ms) {
  const samples = new Int16Array(Math.round((SAMPLE_RATE * ms) / 1000));
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = Math.round(Math.sin((2 * Math.PI * 440 * index) / SAMPLE_RATE) * 0.25 * 32767);
  }
  const buffer = Buffer.alloc(samples.length * 2);
  for (let index = 0; index < samples.length; index += 1) buffer.writeInt16LE(samples[index], index * 2);
  return buffer;
}

/** Digital silence of `ms` — below the floor, so it never opens a group. */
function silence(ms) {
  return Buffer.alloc(Math.round((SAMPLE_RATE * ms) / 1000) * 2);
}

/** Streaming stand-in: the endpoint fires once the constructed clip is fully buffered. */
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

/** Worker stand-in: answers immediately with the configured text. */
function fakeWorker(text) {
  const worker = new EventEmitter();
  worker.unref = () => {};
  worker.terminate = () => {};
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

/** Fake Silero detector: fixed speech ranges on the clip timeline (see test/vad-shadow.mjs). */
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

function startSession({
  now = undefined,
  streamingText = '好',
  workerText = '好',
  endpointAtSamples = SAMPLE_RATE,
  hearingOptions = {},
} = {}) {
  const child = new FakeChild();
  const updates = [];
  const events = [];
  const hearing = startHearing({
    ffmpegPath: 'ffmpeg-not-used',
    modelDir: 'models-not-used',
    finalModelDir: '',
    device: 'fake-device',
    recognizer: fakeStreaming({ endpointAtSamples, text: streamingText }),
    asrWorkerFactory: () => fakeWorker(workerText),
    spawnProcess: () => child,
    ...(now === undefined ? {} : { now }),
    onUpdate: (event) => updates.push(event),
    onEvent: (type, payload) => events.push({ type, payload }),
    ...hearingOptions,
  });
  const payloads = (type) => events.filter((event) => event.type === type).map((event) => event.payload);
  return { child, hearing, updates, events, payloads };
}

/** Feed one clip and wait until its delivery slot settled (delivered or counted as skipped). */
async function feed(child, hearing, clip) {
  const before = hearing.stats().delivery.next;
  child.stdout.write(clip);
  await until(() => hearing.stats().delivery.next > before);
}

test('2a. endpoint.detail: silence-only 10 × → 1 sample + summary; grouped rows are all kept', async () => {
  // No streaming words: the silence clips are exactly the text-less idle-mic shape.
  const session = startSession({ endpointAtSamples: SAMPLE_RATE, streamingText: '', workerText: '好' });
  const { child, hearing, payloads } = session;

  // Ten text-less silence endpoints: no group, endpointReason 'silence' — the idle-mic flood.
  for (let index = 0; index < 10; index += 1) await feed(child, hearing, silence(2000));

  const beforeSpeech = payloads('hearing.endpoint.detail');
  assert.equal(beforeSpeech.length, 1, '1-in-10 silence-only rows is written');
  assert.equal(beforeSpeech[0].groupId, null, 'the sample is the group-less silence shape');
  assert.equal(beforeSpeech[0].endpointReason, 'silence');
  assert.equal(beforeSpeech[0].offlineSplit, false);
  assert.equal(beforeSpeech[0].level, 'debug');

  // One loud clip: it forms a group, so its endpoint row is written immediately (not sampled).
  await feed(child, hearing, tone(1000));
  const details = payloads('hearing.endpoint.detail');
  assert.equal(details.length, 2, 'the speech-bearing endpoint row is always written');
  assert.match(details[1].groupId, /^ug-\d+$/u, 'the grouped row carries its group id');

  // Stop flushes the pending silence count: the 10 rows are counted, never lost silently.
  hearing.stop();
  const summaries = payloads('hearing.endpoint.detail.summary');
  assert.equal(summaries.length, 1);
  assert.deepEqual(
    { count: summaries[0].count, sampled: summaries[0].sampled, windowMs: summaries[0].windowMs },
    { count: 10, sampled: 1, windowMs: 60_000 },
  );
});

test('2b. endpoint.detail: the summary is flushed by the next silence row after 60 s', async () => {
  const clock = { value: 1_000_000 };
  const session = startSession({
    now: () => clock.value,
    endpointAtSamples: SAMPLE_RATE,
    streamingText: '',
    workerText: '好',
  });

  await feed(session.child, session.hearing, silence(2000));
  await feed(session.child, session.hearing, silence(2000));
  assert.equal(session.payloads('hearing.endpoint.detail').length, 1, 'only row 1 is sampled');

  clock.value += 60_000;
  await feed(session.child, session.hearing, silence(2000));
  const summaries = session.payloads('hearing.endpoint.detail.summary');
  assert.equal(summaries.length, 1, 'the window elapsed: one counting row appears');
  assert.deepEqual(
    { count: summaries[0].count, sampled: summaries[0].sampled },
    { count: 2, sampled: 1 },
  );
  // Row 3 opens the next window and is sampled again (1 % 10 == 1).
  assert.equal(session.payloads('hearing.endpoint.detail').length, 2);
  session.hearing.stop();
});

// ---------------------------------------------------------------------------------------------
// 3. asr.delivery.order — delivered rows always, skipped slots counted per 60 s / 100
// ---------------------------------------------------------------------------------------------

test('3a. delivery.order: skipped slots are counted; delivered rows are all kept', async () => {
  const clock = { value: 2_000_000 };
  const session = startSession({
    now: () => clock.value,
    endpointAtSamples: Math.round(SAMPLE_RATE * 0.6),
    // Grouping is a product-level merge; this test pins the delivery-log gate, so it opts out.
    hearingOptions: { asrGroupCommitMs: 0 },
  });
  const { child, hearing, payloads } = session;

  for (let index = 0; index < 3; index += 1) await feed(child, hearing, silence(600));
  await feed(child, hearing, tone(600)); // seq 4: really delivered

  const delivered = payloads('asr.delivery.order');
  assert.deepEqual(
    delivered.map((entry) => [entry.seq, entry.delivered, entry.skipped]),
    [[4, true, false]],
    'every delivered slot keeps its own row',
  );
  assert.equal(payloads('asr.delivery.order.summary').length, 0, 'the skipped window is still open');

  // The next skipped slot after the window closes is written as one summary with both bounds.
  clock.value += 60_000;
  await feed(child, hearing, silence(600)); // seq 5: skipped
  const summaries = payloads('asr.delivery.order.summary');
  assert.equal(summaries.length, 1);
  assert.deepEqual(
    { count: summaries[0].count, firstSeq: summaries[0].firstSeq, lastSeq: summaries[0].lastSeq },
    { count: 4, firstSeq: 1, lastSeq: 5 },
    'the four skipped slots (1,2,3,5) are one counting row',
  );
  assert.equal(delivered.length, 1, 'the delivered row was not duplicated by the summary');
  hearing.stop();
});

test('3b. delivery.order: 100 skipped slots flush at the count cap', async () => {
  const session = startSession({
    endpointAtSamples: Math.round(SAMPLE_RATE * 0.4),
    hearingOptions: { asrGroupCommitMs: 0 },
  });
  const { child, hearing, payloads } = session;
  for (let index = 0; index < 100; index += 1) await feed(child, hearing, silence(400));

  assert.equal(payloads('asr.delivery.order').length, 0, 'no per-slot row for a skipped slot');
  const summaries = payloads('asr.delivery.order.summary');
  assert.equal(summaries.length, 1, 'exactly one summary at the 100-slot cap');
  assert.deepEqual(
    { count: summaries[0].count, firstSeq: summaries[0].firstSeq, lastSeq: summaries[0].lastSeq },
    { count: 100, firstSeq: 1, lastSeq: 100 },
  );
  hearing.stop();
});

// ---------------------------------------------------------------------------------------------
// 4. memory.auto.skipped — first per session + one summary per 5 min; failed stays per row
// ---------------------------------------------------------------------------------------------

test('4a. memory.auto.skipped: first row per session, then one 5-minute summary', async () => {
  assert.equal(SKIP_SUMMARY_WINDOW_MS, 300_000, 'the shipping window is 5 min');
  const events = [];
  const log = { async emit(type, payload) { events.push({ type, payload }); } };
  const clock = { value: 3_000_000 };
  const ofType = (type) => events.filter((event) => event.type === type).map((event) => event.payload);
  const recorder = createAutoMemoryRecorder({
    memory: {},
    log,
    settings: { enabled: true, minChars: 1, maxChars: 400, includeReply: true },
    scopeOf: (session) => (typeof session?.header?.cwd === 'string' ? 'out-of-scope' : 'no-cwd'),
    now: () => clock.value,
  });
  const message = (id) => ({
    type: 'user/message',
    time: clock.value,
    data: { id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '别的项目的话' }] },
  });

  const foreign = { id: 'foreign-session', header: { cwd: 'D:\\Other\\project' } };
  await recorder.handle(foreign, message('m1'));
  assert.deepEqual(ofType('memory.auto.skipped').map((entry) => entry.reason), ['out-of-scope']);
  for (const id of ['m2', 'm3', 'm4']) await recorder.handle(foreign, message(id));
  assert.equal(events.length, 1, 'three skips inside the window write nothing');

  clock.value += SKIP_SUMMARY_WINDOW_MS;
  await recorder.handle(foreign, message('m5'));
  assert.deepEqual(ofType('memory.auto.skipped.summary'), [{
    sessionId: 'foreign-session',
    reason: 'out-of-scope',
    count: 4,
    windowMs: SKIP_SUMMARY_WINDOW_MS,
  }], 'the counted skips (m2..m5) become one summary');

  // A different session still gets its own first row.
  await recorder.handle({ id: 'other-session', header: {} }, message('o1'));
  assert.equal(ofType('memory.auto.skipped').length, 2, 'one first row per session');
  assert.equal(ofType('memory.auto.skipped')[1].reason, 'no-cwd');

  // A session ending flushes its count without waiting for the 5-minute window.
  await recorder.handle(foreign, message('m6'));
  await recorder.handle(foreign, { type: 'turn/end', time: clock.value, data: { turn: 1, reason: { kind: 'completed' } } });
  const flushed = ofType('memory.auto.skipped.summary');
  assert.equal(flushed.length, 2);
  assert.equal(flushed[1].count, 1, 'the turn/end flush reports the pending skip');
  assert.equal(ofType('memory.auto.skipped').length, 2, 'no second first-row for the same session');
});

test('4b. memory.auto.failed is still one row per failure', async () => {
  const events = [];
  const log = { async emit(type, payload) { events.push({ type, payload }); } };
  const recorder = createAutoMemoryRecorder({
    memory: { addMessage() { throw new Error('db closed'); } },
    log,
    settings: { enabled: true, minChars: 1, maxChars: 400, includeReply: true },
    scopeOf: () => 'in-scope',
  });
  const message = (id) => ({
    type: 'user/message',
    time: Date.now(),
    data: { id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '要记住的话' }] },
  });
  await recorder.handle({ id: 'inside', header: {} }, message('f1'));
  await recorder.handle({ id: 'inside', header: {} }, message('f2'));
  const failed = events.filter((event) => event.type === 'memory.auto.failed');
  assert.equal(failed.length, 2, 'each failure is still written verbatim');
  assert.equal(failed[0].payload.error, 'db closed');
  assert.equal(failed[1].payload.error, 'db closed');
  assert.equal(events.filter((event) => event.type === 'memory.auto.skipped').length, 0);
});

// ---------------------------------------------------------------------------------------------
// 5. vad/noise shadow suppressed — one counting row per 60 s, never one per occurrence
// ---------------------------------------------------------------------------------------------

test('5. vad/noise shadow suppressed: one counting row per 60 s window', async () => {
  const clock = { value: 4_000_000 };
  const session = startSession({
    now: () => clock.value,
    streamingText: 'Okay okay,',
    workerText: 'Okay okay,',
    endpointAtSamples: Math.round(SAMPLE_RATE * 0.6),
    hearingOptions: {
      asrGroupCommitMs: 0,
      vadFactory: () => fakeVad({ segments: [{ startMs: 100, endMs: 500 }] }),
    },
  });
  const { child, hearing, payloads } = session;
  const clip = () => tone(600);

  // One full shadow row, then four suppressed occurrences inside the 30 s shadow window.
  for (let index = 0; index < 5; index += 1) await feed(child, hearing, clip());
  assert.equal(payloads('hearing.vad.shadow').length, 1, 'one full VAD row inside the shadow window');
  assert.equal(payloads('hearing.noise.shadow').length, 1, 'one full noise row inside the shadow window');
  const vadFirst = payloads('hearing.vad.shadow.suppressed');
  const noiseFirst = payloads('hearing.noise.shadow.suppressed');
  assert.equal(vadFirst.length, 1, 'the first suppression is visible at once');
  assert.equal(vadFirst[0].count, 1, 'it counts one occurrence');
  assert.equal(vadFirst[0].windowMs, 60_000);
  assert.equal(noiseFirst.length, 1, 'the noise shadow behaves the same');

  // Past the 60 s window the shadow row is re-armed (the 30 s repeat window expired), then the
  // next repeat must report the accumulated count instead of a per-occurrence row.
  clock.value += 61_000;
  await feed(child, hearing, clip()); // fresh full row (old row expired)
  await feed(child, hearing, clip()); // suppressed again
  assert.equal(payloads('hearing.vad.shadow').length, 2, 'the expired window re-armed the full row');
  assert.equal(payloads('hearing.noise.shadow').length, 2);
  const vadSummary = payloads('hearing.vad.shadow.suppressed');
  const noiseSummary = payloads('hearing.noise.shadow.suppressed');
  assert.deepEqual(vadSummary.map((entry) => entry.count), [1, 4], '4 folded occurrences in one row');
  assert.deepEqual(noiseSummary.map((entry) => entry.count), [1, 4]);
  assert.equal(vadSummary[1].windowMs, 60_000);
  hearing.stop();
});

// ---------------------------------------------------------------------------------------------
// 6. avatar.animation.end — an idle End is counted, not written; a non-idle End stays
// ---------------------------------------------------------------------------------------------

test('6. avatar.animation.end: isIdle End is dropped from the log but counted in the state', () => {
  const events = [];
  const client = new VtsClient({
    tokenPath: 'C:\\tmp\\event-log-noise-p1\\vts-token.json',
    animationEvents: true,
    onEvent: (type, payload) => events.push({ type, payload }),
  });
  const ofType = (type) => events.filter((event) => event.type === type).map((event) => event.payload);

  client.handleModelAnimation({
    animationEventType: 'Start', animationName: 'IdleSway', animationLength: 4, isIdleAnimation: true,
  });
  assert.equal(ofType('avatar.animation.start').length, 1);
  client.handleModelAnimation({
    animationEventType: 'End', animationName: 'IdleSway', animationLength: 4, isIdleAnimation: true,
  });
  assert.equal(ofType('avatar.animation.end').length, 0, 'the idle loop End is not written');
  assert.equal(client.animations.idleEnds, 1, 'it is counted in the animation state');
  assert.equal(client.animations.ends, 1, 'the total End counter is unchanged');
  assert.equal(client.animations.current, null, 'the idle End still clears the running animation');
  assert.equal(client.getAnimationState().idleEnds, 1, 'the count is part of the host-facing state');

  client.handleModelAnimation({
    animationEventType: 'Start', animationName: 'Nod', animationLength: 2.5, isIdleAnimation: false,
  });
  client.handleModelAnimation({
    animationEventType: 'End', animationName: 'Nod', animationLength: 2.5, isIdleAnimation: false,
  });
  assert.deepEqual(ofType('avatar.animation.end'), [{ name: 'Nod', durationMs: 2500, isIdle: false }],
    'a non-idle End stays one row per occurrence');
  assert.equal(client.animations.idleEnds, 1);
  assert.equal(client.animations.ends, 2);
});

// Keep the alpha contract from P0 referenced here so a future change to the shared throttle state
// fails this suite as well (the two sample gates are independent fields on the same instance).
test('7. the two SpoutLayer log gates stay independent (the P0 alpha gate is untouched)', () => {
  assert.equal(ALPHA_SAMPLE_LOG_INTERVAL_MS, 30_000, 'P0 alpha sample window unchanged');
  const { layer } = createLayer();
  assert.equal(layer.alphaSampleIntervalMs, 30_000);
  assert.equal(layer.stage2LogIntervalMs, 60_000);
  assert.equal(layer.alphaSampleLastVerdict, null, 'the alpha gate keeps its own state');
  assert.equal(layer.stage2LastWrite, null, 'the stage2 gate keeps its own state');
});
