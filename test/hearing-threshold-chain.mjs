/**
 * 阈值保存 → 采集实例证据链（hearing.instance.* / effectiveMinRmsDb / 重启结果）。
 *
 * 审查纠正：`hearing.threshold` 保存后会**停止并重启**正在运行的采集，所以不能断言
 * “设置只改显示”。本套件同时钉住旧 bug 的修正：重启失败以前仍返回 `ok:true`（只有
 * `restarted:false`），界面因此误报成功；现在失败必须是 `ok:false + error`。
 *
 * 覆盖：
 *  1. 保存阈值 → 旧实例 stopped、新实例 started，新实例的 effectiveMinRmsDb 就是新值；
 *  2. 重启失败（stop 抛错 / start 抛错 / start 返回 ok:false）→ ok:false + error，
 *     `thresholdRestart` 状态可读；
 *  3. 未运行 → ok:true restarted:false reason='not-running'，不编造实例；
 *  4. 在途片段：判定用的是判定当时（旧实例、旧阈值）的快照，之后的阈值写入不会重判/改标；
 *  5. 日志 rms 与门禁比较值是同一指标（utterance RMS），不是帧 RMS；
 *  6. 连续改两次阈值 → 两个新实例，最后生效值是第二次。
 *
 * 不启用真实麦克风 / ffmpeg / sherpa 模型 / worker 线程：子进程、流式识别器、VAD 与 worker
 * 都是假的，写法与 `hearing-live-threshold.mjs` / `noise-shadow.mjs` 相同。
 *
 * Run: node --test test/hearing-threshold-chain.mjs
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import test from 'node:test';

import { startHearing } from '../src/host/hearing/hearing.js';
import { createHearingSettingsActions, projectHearingStatus } from '../src/host/hearing/settings-actions.js';
import { apply } from '../src/host/index.js';

const SAMPLE_RATE = 16000;
const CLIP_MS = 800;
const CLIP_SAMPLES = Math.round((SAMPLE_RATE * CLIP_MS) / 1000);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until `predicate()` is true; a missed deadline fails the test instead of hanging it. */
async function until(predicate, timeoutMs = 3000) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('timed out waiting for the hearing evidence');
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

/** 440 Hz tone whose sine RMS is exactly `db` dBFS (same calibration as the live-threshold suite). */
function toneAtDb(db, ms = CLIP_MS) {
  const amplitude = 10 ** (db / 20) * Math.SQRT2;
  const samples = new Int16Array(Math.round((SAMPLE_RATE * ms) / 1000));
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = Math.round(Math.sin((2 * Math.PI * 440 * index) / SAMPLE_RATE) * amplitude * 32767);
  }
  const buffer = Buffer.alloc(samples.length * 2);
  for (let index = 0; index < samples.length; index += 1) buffer.writeInt16LE(samples[index], index * 2);
  return buffer;
}

/** A loud burst followed by digital silence: the utterance RMS and the frame RMS disagree. */
function burstClip({ burstDb = -10, burstMs = 200, totalMs = 800 } = {}) {
  const total = Math.round((SAMPLE_RATE * totalMs) / 1000);
  const burst = Math.round((SAMPLE_RATE * burstMs) / 1000);
  const samples = new Int16Array(total);
  const amplitude = 10 ** (burstDb / 20) * Math.SQRT2;
  for (let index = 0; index < burst; index += 1) {
    samples[index] = Math.round(Math.sin((2 * Math.PI * 440 * index) / SAMPLE_RATE) * amplitude * 32767);
  }
  const buffer = Buffer.alloc(samples.length * 2);
  for (let index = 0; index < samples.length; index += 1) buffer.writeInt16LE(samples[index], index * 2);
  return buffer;
}

/** The utterance RMS in dB the gate compares and the row reports (over the whole clip). */
function utteranceDb(clip) {
  const count = clip.length / 2;
  let sumSquares = 0;
  for (let index = 0; index < count; index += 1) {
    const sample = clip.readInt16LE(index * 2) / 32768;
    sumSquares += sample * sample;
  }
  return 20 * Math.log10(Math.sqrt(sumSquares / count));
}

/** The loudest 20 ms frame in dB — the meter a buggy implementation might log instead. */
function loudestFrameDb(clip) {
  const count = clip.length / 2;
  const frame = Math.round((SAMPLE_RATE * 20) / 1000);
  let best = -Infinity;
  for (let offset = 0; offset < count; offset += frame) {
    let sumSquares = 0;
    const end = Math.min(count, offset + frame);
    for (let index = offset; index < end; index += 1) {
      const sample = clip.readInt16LE(index * 2) / 32768;
      sumSquares += sample * sample;
    }
    best = Math.max(best, 20 * Math.log10(Math.sqrt(sumSquares / (end - offset))));
  }
  return best;
}

/** Streaming pass: one endpoint per written clip; the text is what the streaming pass heard. */
function fakeStreaming({ text = '', endpointAtSamples = CLIP_SAMPLES } = {}) {
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

/** Worker stand-in mirroring `asr-worker.js`'s reply shape; `delayMs` keeps a decode in flight. */
function fakeWorker({ text = '', delayMs = 0 } = {}) {
  const worker = new EventEmitter();
  worker.unref = () => {};
  worker.terminate = () => {
    worker.emit('exit', null);
  };
  worker.postMessage = (message) => {
    const emit = () => worker.emit('message', {
      type: 'result',
      id: message.id,
      utteranceId: message.utteranceId ?? null,
      segmentIds: message.utteranceId === null ? ['s0'] : [`${message.utteranceId}:s0`],
      text,
    });
    if (delayMs > 0) setTimeout(emit, delayMs);
    else setImmediate(emit);
  };
  return worker;
}

/** Fake Silero detector: an empty segment list means "heard no speech". */
function fakeVad() {
  return {
    acceptWaveform: () => {},
    isEmpty: () => true,
    front: () => undefined,
    pop: () => {},
    isDetected: () => false,
    reset: () => {},
  };
}

/** One real `startHearing` session with every stage fake. `minRmsDb` stays a live getter. */
function makeSession({ device = 'fake-device', minRmsDb, text = '测试', workerDelayMs = 0, endpointMs = CLIP_MS } = {}) {
  const child = new FakeChild();
  const updates = [];
  const events = [];
  const hearing = startHearing({
    ffmpegPath: 'ffmpeg-not-used',
    modelDir: 'models-not-used',
    finalModelDir: '',
    device,
    recognizer: fakeStreaming({
      text,
      endpointAtSamples: Math.round((SAMPLE_RATE * endpointMs) / 1000),
    }),
    asrWorkerFactory: () => fakeWorker({ text, delayMs: workerDelayMs }),
    vadFactory: () => fakeVad(),
    spawnProcess: () => child,
    minRmsDb,
    onUpdate: (event) => updates.push(event),
    onEvent: (type, payload) => events.push({ type, payload }),
  });
  return { child, hearing, updates, events };
}

const ofType = (events, type) => events.filter((event) => event.type === type);
const payloads = (events, type) => ofType(events, type).map((event) => event.payload);
const finals = (updates) => updates.filter((event) => typeof event.final === 'string');

/** Write exactly one clip and wait until the capture loop processed that chunk. */
async function feedClip(session, clip) {
  const before = session.hearing.stats().frames;
  session.child.stdout.write(clip);
  await until(() => session.hearing.stats().frames > before);
}

/**
 * The settings-action side, wired like the Host: `runtime.asrMinRmsDb` is the one mirror the
 * action writes and every session's live getter reads; `startListening` opens a real session,
 * `stopListening` closes it. Failures are injected through `state`.
 */
function makeHost({ db = -50 } = {}) {
  const state = {
    runtime: { asrMinRmsDb: db },
    hearing: null,
    sessions: [],
    logEvents: [],
    settings: {},
    stopError: '',
    startError: '',
    startThrow: '',
    thresholdRestart: null,
  };
  const startListening = async (deviceArg) => {
    if (state.startThrow !== '') throw new Error(state.startThrow);
    if (state.startError !== '') return { ok: false, running: false, device: '', error: state.startError };
    if (state.hearing !== null) {
      return { ok: true, running: true, device: state.hearing.device, instanceId: state.hearing.instanceId };
    }
    const session = makeSession({
      device: deviceArg ?? 'fake-device',
      minRmsDb: () => Number(state.runtime.asrMinRmsDb ?? -50),
    });
    state.sessions.push(session);
    state.hearing = session.hearing;
    services.hearing = session.hearing;
    return { ok: true, running: true, device: session.hearing.device, instanceId: session.hearing.instanceId };
  };
  const stopListening = async () => {
    if (state.stopError !== '') throw new Error(state.stopError);
    const session = state.hearing;
    state.hearing = null;
    services.hearing = null;
    session?.stop();
  };
  const services = {
    runtime: state.runtime,
    log: { emit: async (type, payload) => state.logEvents.push({ type, payload }) },
    writeSettings: (patch) => Object.assign(state.settings, patch),
    getDevices: async () => ['fake-device'],
    deviceRows: () => [],
    deviceCache: null,
    openContainer: async () => ({ ok: true }),
    componentSettings: () => ({ enabled: true }),
    hearingAutostart: { schedule() {}, cancel() {} },
    emitSpeakerStatus() {},
    speakerShadowEnabled: () => false,
    speakerModelState: () => null,
    startSpeakerDownload() {},
    storedVoice: () => ({}),
    saveCallNames() {},
    callModeNames: () => ({ names: [], enabledNames: [] }),
    callNameStore: {},
    enterCallMode: async () => ({ ok: true }),
    exitCallMode: async () => ({ ok: true }),
    startAmbient: async () => ({ ok: true }),
    stopAmbient: async () => {},
    isLoopbackName: () => false,
    // Wired exactly like the Host: the action writes `services.hearing`/`services.thresholdRestart`
    // and the accessors below keep the Host's state, so the status projection reads the same state.
    get hearing() { return state.hearing; },
    set hearing(value) { state.hearing = value; },
    get thresholdRestart() { return state.thresholdRestart; },
    set thresholdRestart(value) { state.thresholdRestart = value; },
    startListening,
    stopListening,
  };
  const handler = createHearingSettingsActions(services);
  const act = (body) => handler(body);
  const latest = () => state.sessions[state.sessions.length - 1] ?? null;
  const stopAll = () => {
    for (const session of state.sessions) {
      try {
        session.hearing.stop();
      } catch {
        /* already closed */
      }
    }
  };
  return { state, services, act, latest, stopAll };
}

// ---------------------------------------------------------------------------
// 1. Saving the threshold really replaces the instance, and the new floor is in force
// ---------------------------------------------------------------------------

test('1) 保存阈值：旧实例 stopped、新实例 started，新实例 effectiveMinRmsDb=新值', async (t) => {
  const host = makeHost({ db: -50 });
  try {
    const started = await host.act({ action: 'hearing.start' });
    assert.equal(started.ok, true);
    const oldSession = host.latest();
    const oldId = oldSession.hearing.instanceId;
    assert.equal(started.instanceId, oldId, 'hearing.start reports the instance it opened');

    const result = await host.act({ action: 'hearing.threshold', db: -33 });
    assert.equal(result.ok, true, 'a successful restart is ok:true');
    assert.equal(result.restarted, true);
    assert.equal(result.minRmsDb, -33);
    assert.equal(result.message, '已生效（新实例）');
    assert.equal(host.state.settings.asrMinRmsDb, -33, 'the value is persisted');
    assert.equal(host.state.runtime.asrMinRmsDb, -33, 'the live mirror the getter reads is updated');

    const newSession = host.latest();
    const newId = newSession.hearing.instanceId;
    assert.notEqual(newId, oldId, 'a restart creates a new capture instance');
    assert.equal(result.instanceId, newId, 'the action reports the NEW instance, not the old one');

    // Old instance: one stopped row with its own id. New instance: one started row with the new floor.
    const oldEvents = oldSession.events;
    assert.deepEqual(payloads(oldEvents, 'hearing.instance.started'), [{
      instanceId: oldId, minRmsDb: -50, device: 'fake-device', source: 'mic',
    }]);
    assert.deepEqual(payloads(oldEvents, 'hearing.instance.stopped'), [{ instanceId: oldId, reason: 'stopped' }]);
    const startedRows = payloads(newSession.events, 'hearing.instance.started');
    assert.deepEqual(startedRows, [{ instanceId: newId, minRmsDb: -33, device: 'fake-device', source: 'mic' }]);

    // A -40 dB clip passes the old -50 floor but must be withheld by the new -33 floor: the new
    // value is really in force, and the row names the new instance and the new effective floor.
    await feedClip(newSession, toneAtDb(-40));
    await until(() => payloads(newSession.events, 'hearing.noise.shadow').length === 1);
    const [shadow] = payloads(newSession.events, 'hearing.noise.shadow');
    assert.equal(shadow.instanceId, newId);
    assert.equal(shadow.effectiveMinRmsDb, -33);
    assert.equal(shadow.delivered, false, 'a -40 dB clip is below the saved -33 dB floor');
    assert.equal(finals(newSession.updates).length, 0);
    assert.equal(newSession.hearing.stats().dropped, 1);

    // Status projection: instance id, effective floor, and a successful restart record.
    const projected = projectHearingStatus({ running: true, thresholdDb: -33 }, {
      session: host.services.hearing,
      restart: host.services.thresholdRestart,
      fallbackMinRmsDb: -33,
    });
    assert.equal(projected.instanceId, newId);
    assert.equal(projected.minRmsDb, -33);
    assert.equal(projected.thresholdRestart.ok, true);
    assert.equal(projected.thresholdRestart.error, '');
    assert.equal(typeof projected.thresholdRestart.lastAt, 'string');
    t.diagnostic(`instances ${oldId} → ${newId}; saved -50 → -33; row effectiveMinRmsDb=${shadow.effectiveMinRmsDb} rmsDb=${shadow.rmsDb} delivered=${shadow.delivered}`);
  } finally {
    host.stopAll();
  }
});

// ---------------------------------------------------------------------------
// 2. A failed restart is a failed save (the old bug: ok:true + restarted:false)
// ---------------------------------------------------------------------------

test('2) 重启失败：ok:false + error，thresholdRestart 状态可读（stop/start 抛错与 start 失败）', async () => {
  // 2a. stopListening throws.
  {
    const host = makeHost({ db: -40 });
    try {
      await host.act({ action: 'hearing.start' });
      host.state.stopError = 'stop failed: device busy';
      const result = await host.act({ action: 'hearing.threshold', db: -35 });
      assert.equal(result.ok, false, 'a failed restart is never reported as success');
      assert.equal(result.restarted, false);
      assert.equal(result.db, -35);
      assert.match(result.error, /stop failed/u);
      assert.equal(result.message, '重启失败：stop failed: device busy');
      assert.equal(host.state.thresholdRestart.ok, false);
      assert.equal(host.state.thresholdRestart.error, 'stop failed: device busy');

      const projected = projectHearingStatus({ running: true }, {
        session: host.services.hearing,
        restart: host.services.thresholdRestart,
        fallbackMinRmsDb: -35,
      });
      assert.equal(projected.thresholdRestart.ok, false);
      assert.match(projected.thresholdRestart.error, /stop failed/u);
      assert.equal(projected.minRmsDb, -35, 'the saved value is still the effective setting');
      assert.ok(payloads(host.state.logEvents, 'hearing.threshold.restart.failed').some(
        (row) => row.db === -35 && /stop failed/u.test(row.error),
      ), 'the failure is recorded as an event, not only in the reply');
    } finally {
      host.stopAll();
    }
  }

  // 2b. startListening throws after a successful stop: nothing runs, and the reply says so.
  {
    const host = makeHost({ db: -40 });
    try {
      await host.act({ action: 'hearing.start' });
      host.state.startThrow = 'start failed: no device';
      const result = await host.act({ action: 'hearing.threshold', db: -30 });
      assert.equal(result.ok, false);
      assert.equal(result.restarted, false);
      assert.match(result.error, /start failed/u);
      assert.equal(result.instanceId, undefined, 'a failed restart names no instance');
      assert.equal(host.state.hearing, null, 'the capture really is gone');
      const projected = projectHearingStatus({ running: false }, {
        session: host.services.hearing,
        restart: host.services.thresholdRestart,
        fallbackMinRmsDb: -30,
      });
      assert.equal(projected.instanceId, '', 'no instance is invented');
      assert.equal(projected.minRmsDb, -30);
      assert.equal(projected.thresholdRestart.ok, false);
    } finally {
      host.stopAll();
    }
  }

  // 2c. startListening answers ok:false (the normal "no device" path) — same honest reply.
  {
    const host = makeHost({ db: -40 });
    try {
      await host.act({ action: 'hearing.start' });
      host.state.startError = '没有可用的录音设备';
      const result = await host.act({ action: 'hearing.threshold', db: -28 });
      assert.equal(result.ok, false);
      assert.match(result.error, /没有可用的录音设备/u);
      assert.equal(host.state.thresholdRestart.ok, false);
    } finally {
      host.stopAll();
    }
  }
});

// ---------------------------------------------------------------------------
// 3. Not running: the threshold is saved, and no restart is claimed
// ---------------------------------------------------------------------------

test('3) 未运行：ok:true restarted:false reason=not-running，不编造实例', async () => {
  const host = makeHost({ db: -50 });
  try {
    assert.equal(host.state.hearing, null);
    const result = await host.act({ action: 'hearing.threshold', db: -42 });
    assert.equal(result.ok, true);
    assert.equal(result.restarted, false);
    assert.equal(result.reason, 'not-running');
    assert.equal(result.minRmsDb, -42);
    assert.equal(result.instanceId, undefined, 'no instance is pretending to run');
    assert.equal(host.state.settings.asrMinRmsDb, -42);
    assert.equal(host.state.sessions.length, 0, 'no capture was started by a save');
    assert.deepEqual(host.state.thresholdRestart, {
      lastAt: host.state.thresholdRestart.lastAt, ok: null, error: '',
    });

    const projected = projectHearingStatus({ running: false }, {
      session: host.services.hearing,
      restart: host.services.thresholdRestart,
      fallbackMinRmsDb: -42,
    });
    assert.equal(projected.instanceId, '');
    assert.equal(projected.minRmsDb, -42, 'stopped: the next start would use the saved floor');
    assert.equal(projected.thresholdRestart.ok, null);
  } finally {
    host.stopAll();
  }
});

// ---------------------------------------------------------------------------
// 4. An in-flight fragment keeps the instance and floor it was judged with
// ---------------------------------------------------------------------------

test('4) 在途片段：带旧 instanceId 与旧阈值，不被之后写入的新阈值误判', async (t) => {
  const floor = { db: -30 };
  const session = makeSession({
    minRmsDb: () => floor.db,
    text: '测试',
    // The audio is judged at the endpoint, but the decode (and its row) settles 120 ms later.
    workerDelayMs: 120,
  });
  const { hearing, events } = session;
  const oldId = hearing.instanceId;
  try {
    const clip = toneAtDb(-28);
    await feedClip(session, clip);
    // The endpoint judgment is already frozen: the floor is changed while the decode is in flight.
    await until(() => ofType(events, 'hearing.endpoint.detail').length === 1);
    floor.db = -20;

    await until(() => ofType(events, 'hearing.noise.shadow').length === 1);
    await until(() => ofType(events, 'hearing.delivery').length === 1);
    assert.equal(finals(session.updates).length, 1, 'the in-flight fragment is delivered once');

    const [shadow] = payloads(events, 'hearing.noise.shadow');
    const [delivery] = payloads(events, 'hearing.delivery');
    assert.equal(shadow.instanceId, oldId, 'the row still belongs to the judging instance');
    assert.equal(shadow.effectiveMinRmsDb, -30, 'the row reports the floor that judged it, not the new one');
    assert.equal(shadow.delivered, true, '-28 dB passed the -30 dB floor at judgment time');
    assert.equal(shadow.rmsDb, Math.round(utteranceDb(clip)));
    assert.ok(shadow.rmsDb > -30 && shadow.rmsDb < -20, '-28 dB sits between the old and new floors');

    assert.ok(delivery, 'the delivered fragment is observed too');
    assert.equal(delivery.instanceId, oldId);
    assert.equal(delivery.effectiveMinRmsDb, -30);
    assert.equal(delivery.rmsDb, shadow.rmsDb, 'delivery and shadow log the same utterance level');

    // The judgment event (single snapshot) still shows the old floor, and the live value did move:
    // the two are deliberately different, which is the whole point of snapshotting per segment.
    assert.equal(hearing.minRmsDb(), -20, 'the instance resolves the new value from now on');
    assert.equal(hearing.stats().finals, 1);
    t.diagnostic(`instance=${oldId} effectiveMinRmsDb=${shadow.effectiveMinRmsDb} (live now ${hearing.minRmsDb()}) rmsDb=${shadow.rmsDb} delivered=${shadow.delivered}`);
  } finally {
    hearing.stop();
  }
});

// ---------------------------------------------------------------------------
// 5. One metric: the gate and both log rows use the utterance RMS, not the frame RMS
// ---------------------------------------------------------------------------

test('5) 日志 rms 与门禁比较值一致：都是 utterance RMS（不是帧 RMS）', async (t) => {
  const clip = burstClip({ burstDb: -10, burstMs: 200, totalMs: 800 });
  const exact = utteranceDb(clip);
  const frameDb = loudestFrameDb(clip);
  const expected = Math.round(exact);
  // The clip is built so the two meters disagree: a frame-based floor would pass it.
  assert.ok(exact < -14, `utterance RMS ${exact.toFixed(2)} dB below the -14 dB floor`);
  assert.ok(frameDb > -14, `the loudest frame ${frameDb.toFixed(2)} dB is above -14 dB`);

  // (a) Floor -14: the utterance gate withholds it; both rows still report the same utterance dB.
  const gated = makeSession({ minRmsDb: () => -14, text: 'The.' });
  try {
    await feedClip(gated, Buffer.from(clip));
    await until(() => payloads(gated.events, 'hearing.noise.shadow').length === 1);
    const [shadow] = payloads(gated.events, 'hearing.noise.shadow');
    assert.equal(shadow.delivered, false, 'the utterance RMS is below the floor');
    assert.equal(shadow.effectiveMinRmsDb, -14);
    assert.equal(shadow.rmsDb, expected, 'the logged rms IS the gate metric, not the loudest frame');
    assert.notEqual(shadow.rmsDb, Math.round(frameDb));
    assert.equal(finals(gated.updates).length, 0);
    assert.equal(gated.hearing.stats().dropped, 1);

    // (b) The same audio under floor -30: delivered, and the delivery row's rms EQUALS the shadow row's.
    const open = makeSession({ minRmsDb: () => -30, text: 'The.' });
    try {
      await feedClip(open, Buffer.from(clip));
      await until(() => payloads(open.events, 'hearing.delivery').length === 1);
      const [shadowRow] = payloads(open.events, 'hearing.noise.shadow');
      const [deliveryRow] = payloads(open.events, 'hearing.delivery');
      assert.equal(shadowRow.delivered, true);
      assert.equal(shadowRow.effectiveMinRmsDb, -30);
      assert.equal(deliveryRow.effectiveMinRmsDb, -30);
      assert.equal(deliveryRow.rmsDb, shadowRow.rmsDb, 'one utterance, one logged level');
      assert.equal(deliveryRow.rmsDb, expected);
      assert.equal(finals(open.updates).length, 1);
      t.diagnostic(`utterance=${exact.toFixed(2)}dB frame=${frameDb.toFixed(2)}dB logged=${expected}; floor -14 delivered=${shadow.delivered}, floor -30 delivered=${shadowRow.delivered}`);
    } finally {
      open.hearing.stop();
    }
  } finally {
    gated.hearing.stop();
  }
});

// ---------------------------------------------------------------------------
// 6. Two saves in a row: two new instances, the second value is the effective one
// ---------------------------------------------------------------------------

test('6) 连续改两次：两个新实例，最后生效值是第二次', async (t) => {
  const host = makeHost({ db: -50 });
  try {
    await host.act({ action: 'hearing.start' });
    const first = host.latest();
    const firstId = first.hearing.instanceId;

    const a = await host.act({ action: 'hearing.threshold', db: -40 });
    assert.equal(a.ok, true);
    assert.equal(a.restarted, true);
    const second = host.latest();
    const secondId = second.hearing.instanceId;
    assert.notEqual(secondId, firstId);
    assert.equal(a.instanceId, secondId);

    const b = await host.act({ action: 'hearing.threshold', db: -20 });
    assert.equal(b.ok, true);
    assert.equal(b.restarted, true);
    const third = host.latest();
    const thirdId = third.hearing.instanceId;
    assert.notEqual(thirdId, secondId);
    assert.notEqual(thirdId, firstId);
    assert.equal(b.instanceId, thirdId);
    assert.equal(b.minRmsDb, -20);
    assert.equal(host.state.sessions.length, 3, 'start + two restarts = three instances');

    // Each instance started with the floor that was current at its own start.
    assert.deepEqual(
      host.state.sessions.map((session) => payloads(session.events, 'hearing.instance.started')[0]?.minRmsDb),
      [-50, -40, -20],
    );
    // The first two were stopped; the last is still running.
    assert.deepEqual(payloads(first.events, 'hearing.instance.stopped'), [{ instanceId: firstId, reason: 'stopped' }]);
    assert.deepEqual(payloads(second.events, 'hearing.instance.stopped'), [{ instanceId: secondId, reason: 'stopped' }]);
    assert.deepEqual(payloads(third.events, 'hearing.instance.stopped'), []);

    // A -30 dB clip: above the first new floor (-40), below the last one (-20) → withheld by the
    // final instance, and the row proves it judged with -20.
    await feedClip(third, toneAtDb(-30));
    await until(() => payloads(third.events, 'hearing.noise.shadow').length === 1);
    const [shadow] = payloads(third.events, 'hearing.noise.shadow');
    assert.equal(shadow.instanceId, thirdId);
    assert.equal(shadow.effectiveMinRmsDb, -20, 'the second save is the value in force');
    assert.equal(shadow.delivered, false);

    const projected = projectHearingStatus({ running: true }, {
      session: host.services.hearing,
      restart: host.services.thresholdRestart,
      fallbackMinRmsDb: -20,
    });
    assert.equal(projected.instanceId, thirdId);
    assert.equal(projected.minRmsDb, -20);
    assert.equal(projected.thresholdRestart.ok, true);
    t.diagnostic(`instances ${[firstId, secondId, thirdId].join(' → ')}; started floors [-50,-40,-20]; final effectiveMinRmsDb=${shadow.effectiveMinRmsDb}`);
  } finally {
    host.stopAll();
  }
});

// ---------------------------------------------------------------------------
// 7. End to end: the served status carries exactly these three fields
// ---------------------------------------------------------------------------

test('7) /assistant/status 接线：instanceId / minRmsDb / thresholdRestart 由投影给出', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-threshold-chain-'));
  await mkdir(join(root, 'data'), { recursive: true });
  await writeFile(join(root, 'data', 'features.json'), JSON.stringify({ hearing: false }));
  const routes = new Map();
  const cleanups = [];
  const effect = (fn) => {
    const cleanup = fn();
    if (typeof cleanup === 'function') cleanups.push(cleanup);
    return cleanup;
  };
  const noop = () => () => {};
  const scope = {
    effect,
    on: noop,
    systemPrompt: { section: noop },
    webServer: {
      register(route) {
        routes.set(route.path, route.handler);
        return () => routes.delete(route.path);
      },
    },
  };
  apply({
    effect,
    on: noop,
    get: () => undefined,
    tools: { register: () => () => {} },
    inject: (_deps, register) => register(scope),
  }, { root, enabled: true });
  t.after(async () => {
    for (const cleanup of cleanups.reverse()) {
      try {
        await cleanup();
      } catch {
        /* teardown best effort */
      }
    }
    await rm(root, { recursive: true, force: true });
  });

  const call = async (path, { method = 'GET', body } = {}) => {
    const handler = routes.get(path);
    assert.equal(typeof handler, 'function', `${path} is registered`);
    let out = '';
    await handler(
      Object.assign(Readable.from(body === undefined ? [] : [JSON.stringify(body)]), { method, url: path }),
      { writeHead() {}, end(value) { out = value; } },
    );
    return JSON.parse(out);
  };

  const before = await call('/assistant/status');
  assert.equal(before.hearing.running, false);
  assert.equal(before.hearing.instanceId, '', 'no capture → no instance id');
  assert.equal(before.hearing.minRmsDb, -50, 'stopped: the value the next start would use');
  assert.deepEqual(before.hearing.thresholdRestart, { lastAt: null, ok: null, error: '' });

  const saved = await call('/assistant/action', { method: 'POST', body: { action: 'hearing.threshold', db: -42 } });
  assert.equal(saved.ok, true);
  assert.equal(saved.restarted, false);
  assert.equal(saved.reason, 'not-running');
  assert.equal(saved.minRmsDb, -42);

  const after = await call('/assistant/status');
  assert.equal(after.hearing.minRmsDb, -42, 'the served status reports the effective floor');
  assert.equal(after.hearing.thresholdDb, -42, 'the pre-existing field still agrees');
  assert.equal(after.hearing.instanceId, '');
  assert.equal(after.hearing.thresholdRestart.ok, null);
});

