/**
 * Stage 1 — unified motion generation, continuous trajectory, action continuity and the minimal
 * idle loop.
 *
 * Run: node --test test/avatar-motion.mjs
 *
 * The nine acceptance checks in this file are deliberately about observable properties, not about
 * one implementation detail:
 *   1. adjacent frames and the second difference stay inside the controller limits;
 *   2. the amplitude cap and the per-frame step cap survive a deliberately huge curve;
 *   3. one input is written at most once per frame;
 *   4. a lock/disconnect invalidates the old output generation (a staged delayed frame never lands);
 *   5. a slow send keeps ONE newest slot: dropped grows, sent never replays a backlog;
 *   6. 10 s at the default 30 Hz produces a sane frame/write count and CPU time;
 *   7. a 10 s posture window switches ≤ 2 times while breathing/blinking continue;
 *   8. conversation-end relaxation lowers amplitude/tempo monotonically over a few seconds;
 *   9. the same seed produces the same trajectory twice.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BREATH,
  EXPRESSION_MOTION,
  EXPRESSION_RELEASE,
  HOLD_MICRO_DRIFT,
  IDLE_SPEECH_SCALE,
  INTENT_IDLE_RATIO,
  OCCASIONAL_ACTION,
  POSTURE_HOLD_ALLOCATION,
  POSTURE_HOLD_MAX_MS,
  POSTURE_HOLD_MIN_MS,
  POSTURE_TRANSITION,
  RELAX_PLAN,
  SHORT_ACTION_TRANSITION,
  SPEECH_HEAD_DAMP,
  TIMING,
  createAvatarRuntime,
  createBehaviorRuntime,
  toInputValue,
} from '../src/host/avatar/avatarRuntime.js';
import {
  CHANNEL_ORDER,
  discoverCapabilities,
  resetCapabilities,
} from '../src/host/avatar/avatarMotion.js';

const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Bounded poll for a condition that a real timer/microtask chain has to produce. */
const waitFor = async (predicate, timeoutMs = 1000, stepMs = 2) => {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (predicate()) return true;
    await delay(stepMs);
  }
  return predicate();
};
const DT = 1000 / 30;

/** Transport that records every single-write and every coalesced frame. */
function createFakeTransport() {
  const writes = [];
  const batches = [];
  const stats = { writeCalls: 0, frameCalls: 0, motionCalls: 0 };
  return {
    writes,
    batches,
    stats,
    get writeCalls() { return stats.writeCalls; },
    get frameCalls() { return stats.frameCalls; },
    get motionCalls() { return stats.motionCalls; },
    transport: {
      connect: async () => {},
      disconnect: async () => {},
      write: async ({ input, value }) => {
        stats.writeCalls += 1;
        writes.push({ input, value });
        return { ok: true };
      },
      writeFrame: async (entries) => {
        stats.frameCalls += 1;
        batches.push(entries);
        writes.push(...entries.map((entry) => ({ input: entry.input, value: entry.value })));
        return { ok: true };
      },
      writeMotion: async (payload) => {
        stats.motionCalls += 1;
        batches.push(payload.entries ?? []);
        return { ok: true };
      },
    },
  };
}

/** Transport whose motion sends stay pending until the test resolves them, one at a time. */
function createSlowMotionTransport() {
  const calls = [];
  const resolvers = [];
  return {
    calls,
    transport: {
      connect: async () => {},
      disconnect: async () => {},
      write: async () => ({ ok: true }),
      writeMotion: (payload) => {
        calls.push(payload);
        return new Promise((resolve) => {
          resolvers.push(() => resolve({ ok: true }));
        });
      },
    },
    resolveNext() {
      const next = resolvers.shift();
      if (next) next();
    },
  };
}

/**
 * Transport whose motion sends are individually controllable and which can expose motion abort.
 * `abort: false` keeps the old transfer alive forever (no termination support); with `abort: true`
 * the transport reports the cancellation but the OLD promise may still settle later, which is
 * exactly the late-completion case the sequence gate must reject.
 */
function createControlledMotionTransport({
  abort = false, stallFirst = false, abortImpl = null,
} = {}) {
  const calls = [];
  const resolvers = [];
  const aborts = [];
  /** Wall-clock time each physical send was handed to the transport (async-cancel ordering). */
  const sentAt = [];
  const transport = {
    connect: async () => {},
    disconnect: async () => {},
    write: async () => ({ ok: true }),
    writeMotion: (payload) => {
      const index = calls.length;
      calls.push(payload);
      sentAt.push(performance.now());
      if (stallFirst && index === 0) return new Promise(() => {});
      return new Promise((resolve) => {
        resolvers[index] = (result = { ok: true }) => resolve(result);
      });
    },
  };
  if (abort) {
    transport.abortMotion = (input) => {
      aborts.push({ ...input, calledAt: performance.now() });
      // A custom impl may return a Promise (async cancel) or throw; the default is synchronous.
      return typeof abortImpl === 'function' ? abortImpl(input) : true;
    };
  }
  return {
    calls,
    aborts,
    sentAt,
    transport,
    resolveCall(index) {
      resolvers[index]?.({ ok: true });
    },
  };
}

const connectRuntime = async (options) => {
  const runtime = createAvatarRuntime(options);
  const result = await runtime.connect();
  assert.equal(result.ok, true, `runtime connects (${result.message ?? ''})`);
  return runtime;
};

const motionConfig = (extra = {}) => ({
  autoTickMs: 0,
  flushIntervalMs: 1,
  idleActions: [],
  idleParams: { headX: { inputName: 'FaceAngleX', min: -30, max: 30 } },
  ...extra,
});

const lastMotion = (runtime) => runtime.snapshot().motion;

// ---------------------------------------------------------------------------------------------
// 1. continuous trajectory
// ---------------------------------------------------------------------------------------------
test('1. 轨迹连续：相邻帧 ≤ 速度界，二阶差分 ≤ 加速度界', () => {
  const runtime = createBehaviorRuntime({ config: { seed: 123, idleActions: [] } });
  const channels = ['headX', 'headY', 'headZ', 'bodyX', 'gazeX', 'gazeY'];
  const rows = [];
  for (let index = 0; index <= 300; index += 1) rows.push(runtime.tick(index * DT));

  const motion = runtime.snapshot().motion;
  const velocityBound = motion.limits.maxVelocity * (DT / 1000) + 1e-6;
  const accelerationBound = motion.limits.maxAcceleration * (DT / 1000) ** 2 + 1e-6;
  for (const channel of channels) {
    let maxDelta = 0;
    let maxSecond = 0;
    for (let index = 1; index < rows.length; index += 1) {
      maxDelta = Math.max(maxDelta, Math.abs(rows[index][channel] - rows[index - 1][channel]));
    }
    for (let index = 2; index < rows.length; index += 1) {
      maxSecond = Math.max(maxSecond, Math.abs(
        rows[index][channel] - 2 * rows[index - 1][channel] + rows[index - 2][channel],
      ));
    }
    assert.ok(maxDelta <= velocityBound,
      `${channel} adjacent delta ${maxDelta} exceeds ${velocityBound}`);
    assert.ok(maxSecond <= accelerationBound,
      `${channel} second difference ${maxSecond} exceeds ${accelerationBound}`);
  }

  // A cancelled gesture leaves continuously and returns to the CURRENT natural posture (not 0):
  // a control runtime with the same seed/tick path must end on the same pose.
  const control = createBehaviorRuntime({ config: { seed: 123, idleActions: [] } });
  for (let index = 0; index <= 300; index += 1) control.tick(index * DT);
  runtime.intent('nod');
  for (let index = 1; index <= 10; index += 1) {
    runtime.tick(10_000 + index * DT);
    control.tick(10_000 + index * DT);
  }
  runtime.cancelIntent('nod', { fadeMs: 240 });
  let previous = null;
  let maxJump = 0;
  for (let index = 11; index <= 90; index += 1) {
    const pose = runtime.tick(10_000 + index * DT);
    control.tick(10_000 + index * DT);
    if (previous !== null) maxJump = Math.max(maxJump, Math.abs(pose.headY - previous));
    previous = pose.headY;
  }
  const natural = control.snapshot().pose;
  const settled = runtime.snapshot().pose;
  assert.ok(maxJump < 0.05, `cancel stayed continuous (max jump ${maxJump})`);
  assert.ok(Math.abs(settled.headY - natural.headY) < 1e-6, 'cancel returned to the natural posture');
  assert.ok(Math.abs(natural.headY) > 0.001, 'the natural posture is not zero');
  console.log(
    `[motion] continuity maxV=${motion.limits.maxVelocity}/s maxA=${motion.limits.maxAcceleration}/s²`
    + ` dt=${(DT / 1000).toFixed(4)}s frames=${rows.length} cancelJump=${maxJump.toFixed(4)}`
    + ` natural=${natural.headY.toFixed(4)}`,
  );
});

// ---------------------------------------------------------------------------------------------
// 2. amplitude / step limits survive an inflated curve
// ---------------------------------------------------------------------------------------------
test('2. 限幅有效：巨大曲线仍受 idleAmplitude / idleMaxStep 约束', async () => {
  const fake = createFakeTransport();
  const runtime = await connectRuntime({
    transport: fake.transport,
    config: motionConfig({
      // Three mapped axes: no single-channel alive gain, so the plain amplitude cap applies.
      idleParams: {
        headX: { inputName: 'FaceAngleX', min: -30, max: 30 },
        headY: { inputName: 'FaceAngleY', min: -30, max: 30 },
        headZ: { inputName: 'FaceAngleZ', min: -30, max: 30 },
      },
      idleSwayScale: 10,
      idleAmplitude: 0.05,
      idleMaxStep: 0.01,
    }),
  });
  const values = [];
  for (let index = 0; index < 40; index += 1) {
    runtime.tick(1000 + index * 250);
    await flushMicrotasks();
  }
  const head = fake.writes.filter((entry) => entry.input === 'FaceAngleX').map((entry) => entry.value);
  assert.ok(head.length >= 10, `head was written contiguously (${head.length})`);
  const peak = Math.max(...head.map(Math.abs));
  let maxStep = 0;
  for (let index = 1; index < head.length; index += 1) {
    maxStep = Math.max(maxStep, Math.abs(head[index] - head[index - 1]));
  }
  assert.ok(peak <= 0.05 * 30 + 1e-9, `peak ${peak}° exceeds the ±1.5° cap`);
  assert.ok(maxStep <= 0.01 * 30 + 1e-9, `step ${maxStep}° exceeds idleMaxStep`);
  console.log(`[motion] limits peak=${peak.toFixed(3)}° step=${maxStep.toFixed(3)}° cap=1.5°/0.3°`);
  runtime.dispose();
});

// ---------------------------------------------------------------------------------------------
// 3. one final writer per input per frame
// ---------------------------------------------------------------------------------------------
test('3. 无多方争写：每帧每个 input 最多一次写入', async () => {
  const fake = createFakeTransport();
  const runtime = await connectRuntime({
    transport: fake.transport,
    config: motionConfig({
      idleParams: {
        headX: { inputName: 'FaceAngleX', min: -30, max: 30 },
        headY: { inputName: 'FaceAngleY', min: -30, max: 30 },
        headZ: { inputName: 'FaceAngleZ', min: -30, max: 30 },
      },
    }),
  });
  for (let index = 0; index < 40; index += 1) {
    runtime.tick(1000 + index * 50);
    await flushMicrotasks();
  }
  let batches = 0;
  for (const entries of fake.batches) {
    batches += 1;
    const seen = new Set();
    for (const entry of entries) {
      assert.equal(seen.has(entry.input), false, `${entry.input} written twice in one frame`);
      seen.add(entry.input);
    }
  }
  assert.ok(batches > 0, 'at least one coalesced frame was sent');
  // "Look at the user" is only a verified direction. This model has no verified gaze channel, so
  // even a caller-supplied position must fall back to the preset neutral attention direction.
  const unverified = runtime.setAttention({ x: 0.6, y: -0.2 }, { verified: false });
  const withoutGaze = runtime.setAttention({ x: 0.6, y: -0.2 }, { verified: true });
  assert.equal(unverified.attention.mode, 'neutral', 'an unverified target is never called user');
  assert.equal(withoutGaze.attention.mode, 'neutral', 'no verified gaze mapping means neutral only');
  assert.deepEqual(withoutGaze.attention.target, { x: 0, y: 0 }, 'neutral attention is (0, 0)');
  console.log(`[motion] single-writer batches=${batches} inputs=${[...new Set(fake.writes.map((entry) => entry.input))].length} attention=${withoutGaze.attention.mode}`);
  runtime.dispose();
});

// ---------------------------------------------------------------------------------------------
// 4. old generation never revives
// ---------------------------------------------------------------------------------------------
test('4. 无旧轮复活：lock 后延迟帧不再写入，旧代 settle 记为 stale', async () => {
  const slow = createSlowMotionTransport();
  const runtime = await connectRuntime({
    transport: slow.transport,
    config: motionConfig({ motionWrites: true, motionOutputHz: 30, seed: 7 }),
  });
  runtime.tick(0); // frame A is in flight
  runtime.tick(DT); // frame B staged
  runtime.tick(2 * DT); // frame C overwrites B
  assert.equal(slow.calls.length, 1, 'exactly one slow send is in flight');
  assert.ok(lastMotion(runtime).dropped >= 1, 'the staged old frame was dropped on overwrite');

  const before = slow.calls.length;
  runtime.lock('privacy');
  assert.equal(lastMotion(runtime).locked, true, 'the output gate is locked');

  slow.resolveNext(); // A settles AFTER the lock
  await flushMicrotasks();
  await flushMicrotasks();
  for (let index = 3; index <= 10; index += 1) runtime.tick(index * DT);
  await flushMicrotasks();

  const after = lastMotion(runtime);
  assert.equal(slow.calls.length, before, 'no old-generation frame was sent after the lock');
  assert.ok(after.stale >= 1, `the late settle is stale (${after.stale})`);
  assert.equal(after.sent, 0, 'a stale send never counts as sent');
  assert.equal(after.inFlight, false, 'the stale settle still released the physical send gate');
  console.log(
    `[motion] generation lock=privacy writes=${slow.calls.length} stale=${after.stale}`
    + ` sent=${after.sent} inFlight=${after.inFlight}`,
  );

  // The same guarantee on a normal disconnect: the in-flight old frame settles into `stale` and
  // no tick after the close can send it.
  const slowDisconnect = createSlowMotionTransport();
  const second = await connectRuntime({
    transport: slowDisconnect.transport,
    config: motionConfig({ motionWrites: true, motionOutputHz: 30, seed: 9 }),
  });
  second.tick(0);
  assert.equal(slowDisconnect.calls.length, 1, 'one frame is in flight before the disconnect');
  await second.disconnect();
  const callsAfterClose = slowDisconnect.calls.length;
  slowDisconnect.resolveNext();
  await flushMicrotasks();
  for (let index = 1; index <= 5; index += 1) second.tick(index * DT);
  await flushMicrotasks();
  assert.equal(slowDisconnect.calls.length, callsAfterClose, 'a disconnected generation sends nothing');
  assert.ok(lastMotion(second).stale >= 1, 'the late disconnect settle is stale');
  console.log(
    `[motion] generation disconnect writes=${slowDisconnect.calls.length} stale=${lastMotion(second).stale}`,
  );
  runtime.dispose();
  second.dispose();
});

// ---------------------------------------------------------------------------------------------
// 5. single slot, single flight, no replay backlog
// ---------------------------------------------------------------------------------------------
test('5. 队列不积压：慢发送只保留最新一帧，dropped 增长且 sent 不补播', async () => {
  const slow = createSlowMotionTransport();
  const runtime = await connectRuntime({
    transport: slow.transport,
    config: motionConfig({ motionWrites: true, motionOutputHz: 30, seed: 11 }),
  });
  runtime.tick(0);
  for (let index = 1; index <= 30; index += 1) runtime.tick(index * DT);
  const whileBlocked = lastMotion(runtime);
  assert.equal(slow.calls.length, 1, 'a slow send blocks new sends (single flight)');
  assert.ok(whileBlocked.dropped >= 20, `old staged frames were dropped (${whileBlocked.dropped})`);

  slow.resolveNext();
  await flushMicrotasks();
  assert.equal(slow.calls.length, 2, 'the newest frame is sent as soon as the slow send settles');
  assert.equal(slow.calls[1].at, 30 * DT, 'the sent frame is the newest staged one, not a replayed backlog');

  slow.resolveNext();
  await flushMicrotasks();
  const after = lastMotion(runtime);
  assert.equal(after.inFlight, false, 'the single-flight gate is open again');
  assert.equal(after.pending, false, 'no frame remains queued');
  assert.equal(after.sent, 2, 'only completed sends count');
  assert.equal(slow.calls.length, after.sent, 'sent never exceeds what the transport saw');
  console.log(
    `[motion] backpressure calls=${slow.calls.length} sent=${after.sent} dropped=${after.dropped}`
    + ` inFlight=${after.inFlight} pending=${after.pending}`,
  );
  runtime.dispose();
});

// ---------------------------------------------------------------------------------------------
// 6. load at the default output rate
// ---------------------------------------------------------------------------------------------
test('6. 负载可接受：默认 30Hz 下 10 秒帧数与 CPU 时间量级合理', () => {
  const runtime = createBehaviorRuntime({ config: { seed: 99, idleActions: [] } });
  const started = performance.now();
  for (let index = 0; index <= 300; index += 1) runtime.tick(index * DT);
  const cpuMs = performance.now() - started;
  const snapshot = runtime.snapshot();
  assert.ok(snapshot.motion.frames >= 290, `controller frames ${snapshot.motion.frames} / 301`);
  assert.ok(snapshot.frames.computed >= 290, `computed poses ${snapshot.frames.computed} / 301`);
  assert.ok(cpuMs < 2000, `10 s of 30 Hz ticks took ${cpuMs.toFixed(1)} ms`);
  console.log(
    `[motion] load 30Hz/10s controllerFrames=${snapshot.motion.frames} poses=${snapshot.frames.computed}`
    + ` cpuMs=${cpuMs.toFixed(1)}`,
  );
});

// ---------------------------------------------------------------------------------------------
// 7. posture hold window
// ---------------------------------------------------------------------------------------------
test('7. 待机保持：10 秒窗口姿态切换 ≤ 2，期间呼吸/眨眼仍在', () => {
  const runtime = createBehaviorRuntime({
    config: {
      seed: 314,
      idleActions: [],
      postureHoldMinMs: 10000,
      postureHoldMaxMs: 10000,
    },
  });
  let sawBlink = false;
  let minEye = 1;
  let switchesAtTenSeconds = 0;
  const breath = [];
  const tenSecondEnd = 10_000;
  for (let at = 0; at <= 25_000; at += DT) {
    const pose = runtime.tick(at);
    if (at <= tenSecondEnd) {
      const snap = runtime.snapshot();
      if (snap.blink.factor < 0.5) sawBlink = true;
      minEye = Math.min(minEye, pose.eyeOpenL);
      breath.push(pose.breath);
      switchesAtTenSeconds = snap.motion.postureSwitches;
    }
  }
  const snap = runtime.snapshot();
  assert.ok(switchesAtTenSeconds <= 2,
    `the posture switched ${switchesAtTenSeconds} times in the 10 s window`);
  assert.ok(snap.motion.postureHolds + snap.motion.postureSwitches >= 1,
    'a hold decision happened after the 10 s window');
  assert.ok(sawBlink, 'blinking continued during the hold');
  assert.ok(Math.max(...breath) - Math.min(...breath) > 0.05, 'breathing continued during the hold');

  // A hold is a real decision outcome, not just "wait one more sample": force it and prove the
  // same target survives the 10 s boundary without counting a switch.
  const holder = createBehaviorRuntime({
    config: {
      seed: 271,
      idleActions: [],
      postureHoldMinMs: 10000,
      postureHoldMaxMs: 10000,
      postureHoldChance: 1,
    },
  });
  for (let at = 0; at <= 12_000; at += DT) holder.tick(at);
  const held = holder.snapshot().motion;
  assert.ok(held.postureHolds >= 1, 'the same posture was explicitly held');
  assert.equal(held.postureSwitches, 0, 'holding does not count as a posture switch');
  console.log(
    `[motion] hold switches=${snap.motion.postureSwitches} holds=${snap.motion.postureHolds}`
    + ` decisions=${snap.motion.postureDecisions} minEye=${minEye.toFixed(3)}`
    + ` breathRange=${(Math.max(...breath) - Math.min(...breath)).toFixed(3)}`
    + ` forcedHold=${held.postureHolds}`,
  );
});

// ---------------------------------------------------------------------------------------------
// 8. conversation-end relaxation
// ---------------------------------------------------------------------------------------------
test('8. 放松过渡：交流结束后 amplitude/tempo 在数秒内单调下降', () => {
  const runtime = createBehaviorRuntime({ config: { seed: 8, idleActions: [] } });
  runtime.beginTurn();
  runtime.setSpeech({
    levels: Array.from({ length: 10 }, () => 0.7),
    stepMs: 100,
    startedAt: 1000,
    durationMs: 1000,
  });
  for (let at = 0; at <= 1200; at += 33) runtime.tick(at);
  const afterSpeech = 1900; // release tail + the configured delay has elapsed by here
  const samples = [];
  for (let at = afterSpeech; at <= afterSpeech + 3200; at += 100) {
    runtime.tick(at);
    const style = runtime.snapshot().style.effective;
    samples.push({ at, amplitude: style.amplitude, tempo: style.tempo, relax: runtime.snapshot().motion.relaxation });
  }
  for (let index = 1; index < samples.length; index += 1) {
    assert.ok(samples[index].amplitude <= samples[index - 1].amplitude + 1e-9,
      `amplitude rose at ${samples[index].at}`);
    assert.ok(samples[index].tempo <= samples[index - 1].tempo + 1e-9,
      `tempo rose at ${samples[index].at}`);
  }
  assert.ok(samples[samples.length - 1].amplitude < samples[0].amplitude - 0.02,
    'the amplitude really relaxed');
  assert.ok(samples[samples.length - 1].tempo < samples[0].tempo - 0.02,
    'the tempo really relaxed');
  console.log(
    `[motion] relax amplitude ${samples[0].amplitude.toFixed(3)} → ${samples.at(-1).amplitude.toFixed(3)}`
    + ` tempo ${samples[0].tempo.toFixed(3)} → ${samples.at(-1).tempo.toFixed(3)}`
    + ` relax=${samples.at(-1).relax.toFixed(2)}`,
  );
});

// ---------------------------------------------------------------------------------------------
// 9. fixed-seed reproducibility
// ---------------------------------------------------------------------------------------------
test('9. 固定种子可复现：同 seed 两次轨迹一致，异 seed 不同', () => {
  const run = (seed) => {
    const runtime = createBehaviorRuntime({ config: { seed, idleActions: [] } });
    const rows = [];
    for (let index = 0; index <= 150; index += 1) {
      const pose = runtime.tick(index * DT);
      rows.push([pose.headX, pose.headY, pose.headZ, pose.bodyX, pose.gazeX]);
    }
    return rows;
  };
  const first = run(4242);
  const second = run(4242);
  const other = run(4243);
  assert.deepEqual(first, second, 'the same seed produced a different trajectory');
  assert.notDeepEqual(first, other, 'a different seed produced an identical trajectory');
  console.log(`[motion] seed reproducibility seed=4242 frames=${first.length} identical=true otherSeedDiffers=true`);
});

// ---------------------------------------------------------------------------------------------
// 10. the legacy motion floor never leaks into the 30 Hz controller output
// ---------------------------------------------------------------------------------------------
test('10. floor 不进入 30Hz 控制器：motionWrites 下无 floor 注入、无 ±0.81° 脉动', async () => {
  const fake = createFakeTransport();
  const logs = [];
  const runtime = await connectRuntime({
    transport: fake.transport,
    log: (message, data = {}) => logs.push({ message, ...data }),
    config: motionConfig({
      motionWrites: true,
      motionOutputHz: 30,
      seed: 5,
      // A still curve would make the legacy floor due, but this path must never apply it.
      idleSwayScale: 1e-9,
      postureHoldMinMs: 10_000,
      postureHoldMaxMs: 10_000,
      postureHoldChance: 1,
    }),
  });
  for (let index = 0; index <= 300; index += 1) {
    runtime.tick(index * DT);
    await flushMicrotasks();
  }
  const snapshot = runtime.snapshot();
  assert.ok(snapshot.motion.sent > 0, `the 30 Hz pump really sent frames (${snapshot.motion.sent})`);
  assert.equal(snapshot.idleParams.frames, 0, 'the legacy 4 Hz idle flush is not also run');
  assert.equal(snapshot.idleParams.motionFloor.injected, 0, 'the floor injected nothing on this path');
  assert.equal(logs.filter((entry) => entry.event === 'avatar.idle.motion-floor').length, 0,
    'no floor event was produced');
  assert.equal(snapshot.motion.postureSwitches, 0, 'the forced posture hold was not interrupted');
  const values = fake.batches.flat()
    .filter((entry) => entry.input === 'FaceAngleX')
    .map((entry) => entry.value);
  assert.ok(values.length > 0, 'the head input was written by the controller');
  const peak = Math.max(...values.map(Math.abs));
  assert.ok(peak <= 0.5, `the controller output carries no ±0.81° floor pulse (peak ${peak.toFixed(4)})`);
  console.log(
    `[motion] floor-legacy sent=${snapshot.motion.sent} idleFrames=0 injected=0`
    + ` holdSwitches=0 peak=${peak.toFixed(4)}`,
  );
  runtime.dispose();
});

// ---------------------------------------------------------------------------------------------
// 11. P1 regression: an invalidated frame still releases the physical send gate
// ---------------------------------------------------------------------------------------------
test('11. 作废帧仍清 inFlight：发送中 lock → 旧发送结算 → unlock 后继续发送', async () => {
  const slow = createSlowMotionTransport();
  const runtime = await connectRuntime({
    transport: slow.transport,
    config: motionConfig({ motionWrites: true, motionOutputHz: 30, seed: 21 }),
  });
  runtime.tick(0); // frame A is in flight
  assert.equal(slow.calls.length, 1, 'frame A is in flight');

  runtime.lock('privacy'); // the epoch advances while A is still unsettled
  slow.resolveNext(); // A settles AFTER the invalidation
  await flushMicrotasks();
  await flushMicrotasks();

  let snap = lastMotion(runtime);
  assert.equal(snap.inFlight, false, 'the invalidated send still released the physical gate');
  assert.equal(snap.stale, 1, 'the discarded result was counted as stale');
  assert.equal(snap.sent, 0, 'a stale send is never counted as sent');

  runtime.unlock();
  runtime.tick(DT);
  assert.equal(slow.calls.length, 2, 'after unlock the pump sends again (no P1 deadlock)');

  slow.resolveNext();
  await flushMicrotasks();
  runtime.tick(2 * DT);
  slow.resolveNext();
  await flushMicrotasks();

  snap = lastMotion(runtime);
  assert.equal(snap.sent, 2, 'subsequent sends keep being counted');
  assert.equal(snap.inFlight, false, 'the gate is open again');
  console.log(
    `[motion] p1-lock stale=${snap.stale} sent=${snap.sent} calls=${slow.calls.length}`
    + ` inFlight=${snap.inFlight}`,
  );
  runtime.dispose();
});

// ---------------------------------------------------------------------------------------------
// 12. one queued slot: two frames during a send never run concurrently, the newest wins
// ---------------------------------------------------------------------------------------------
test('12. 发送中连来两帧只发最新：dropped 增长、无并发', async () => {
  const slow = createSlowMotionTransport();
  const runtime = await connectRuntime({
    transport: slow.transport,
    config: motionConfig({ motionWrites: true, motionOutputHz: 30, seed: 23 }),
  });
  runtime.tick(0); // A in flight
  runtime.tick(DT); // B staged
  runtime.tick(2 * DT); // C overwrites B

  let snap = lastMotion(runtime);
  assert.equal(slow.calls.length, 1, 'still exactly one physical send in flight');
  assert.ok(snap.dropped >= 1, `the overwritten middle frame was dropped (${snap.dropped})`);

  slow.resolveNext();
  await flushMicrotasks();
  assert.equal(slow.calls.length, 2, 'the newest staged frame goes out right after the settle');
  assert.equal(slow.calls[1].at, 2 * DT, 'the sent frame is the newest one, not the dropped middle frame');
  assert.equal(lastMotion(runtime).inFlight, true, 'the new send is tracked as in flight');

  runtime.tick(3 * DT); // staged while call 2 is still pending
  assert.equal(slow.calls.length, 2, 'no concurrent send while one is in flight');

  slow.resolveNext();
  await flushMicrotasks();
  assert.equal(slow.calls.length, 3, 'the queued frame is pumped after the second settle');
  assert.equal(slow.calls[2].at, 3 * DT, 'the queued frame is the latest one');
  slow.resolveNext();
  await flushMicrotasks();

  snap = lastMotion(runtime);
  assert.equal(snap.inFlight, false, 'the gate is open');
  assert.equal(snap.sent, 3, 'only adopted sends are counted');
  console.log(
    `[motion] latest-only calls=${slow.calls.length} dropped=${snap.dropped}`
    + ` sent=${snap.sent} inFlight=${snap.inFlight}`,
  );
  runtime.dispose();
});

// ---------------------------------------------------------------------------------------------
// 13. a never-settling send keeps the single-flight gate CLOSED (the old P1 counterexample)
// ---------------------------------------------------------------------------------------------
test('13. 超时不解锁：旧发送永挂时保持单飞，记 abandoned 且不倒序', async () => {
  const stalled = createControlledMotionTransport({ stallFirst: true });
  const runtime = await connectRuntime({
    transport: stalled.transport,
    config: motionConfig({
      motionWrites: true,
      motionOutputHz: 30,
      motionSendTimeoutMs: 20,
      motionSendAbandonMs: 30,
      seed: 27,
    }),
  });
  runtime.tick(0); // frame A is in flight
  assert.equal(stalled.calls.length, 1, 'the first send is pending forever');
  assert.equal(lastMotion(runtime).inFlight, true, 'the gate is held by the pending send');

  runtime.tick(DT); // a newer frame is staged, but must never overtake A
  await delay(120); // past the 20 ms timeout and the 20+30 ms abandon deadline

  let snap = lastMotion(runtime);
  assert.equal(snap.inFlight, true, 'the watchdog does NOT release the single-flight gate');
  assert.equal(snap.timeouts, 1, 'the timeout was counted');
  assert.equal(snap.abandoned, 1, 'the still-unresolved lane was marked abandoned');
  assert.equal(snap.skipped, true, 'the lane is skipped, so no newer value is written');
  assert.equal(snap.outOfOrder, 0, 'no out-of-order completion happened');
  assert.equal(snap.sent, 0, 'nothing was applied');
  assert.equal(snap.appliedSeq, 0, 'appliedSeq never advanced');
  assert.equal(snap.sendSeq, 1, 'only the abandoned send was started');
  assert.equal(stalled.calls.length, 1, 'no new send started while the old one is unresolved');

  const events = runtime.takeEvents();
  const timeouts = events.filter((entry) => entry.type === 'avatar.motion.send.timeout');
  const abandoned = events.filter((entry) => entry.type === 'avatar.motion.send.abandoned');
  assert.equal(timeouts.length, 1, 'the timeout event was recorded');
  assert.equal(timeouts[0].timeoutMs, 20, 'the event carries the configured timeout');
  assert.equal(abandoned.length, 1, 'the abandoned event was recorded');
  assert.equal(abandoned[0].seq, 1, 'the abandoned event carries the old send sequence');

  runtime.tick(3 * DT);
  await flushMicrotasks();
  assert.equal(stalled.calls.length, 1, 'the skipped lane still refuses a new send');
  console.log(
    `[motion] timeout-held timeouts=${snap.timeouts} abandoned=${snap.abandoned}`
    + ` outOfOrder=${snap.outOfOrder} sendSeq=${snap.sendSeq} appliedSeq=${snap.appliedSeq}`
    + ` skipped=${snap.skipped} calls=${stalled.calls.length}`,
  );
  runtime.dispose();
});

// ---------------------------------------------------------------------------------------------
// 14. abort support: cancel the old transfer, then the newest frame is allowed to start
// ---------------------------------------------------------------------------------------------
test('14. 支持 abort：取消旧发送后发最新帧，appliedSeq 递增', async () => {
  const lane = createControlledMotionTransport({ abort: true });
  const runtime = await connectRuntime({
    transport: lane.transport,
    config: motionConfig({
      motionWrites: true,
      motionOutputHz: 30,
      motionSendTimeoutMs: 50,
      seed: 31,
    }),
  });
  runtime.tick(0); // frame A in flight
  runtime.tick(DT); // frame B staged
  assert.equal(lane.calls.length, 1, 'frame A is in flight');
  await delay(70); // past the 50 ms watchdog, before the next send's own watchdog

  assert.equal(lane.aborts.length, 1, 'the watchdog asked the transport to abort the old send');
  assert.equal(lane.aborts[0].seq, 1, 'the abort carries the old send sequence');
  assert.equal(lane.calls.length, 2, 'the newest frame started because the old transfer was cancelled');
  assert.equal(lane.calls[1].at, DT, 'the started frame is the newest staged one');

  lane.resolveCall(1);
  await flushMicrotasks();
  const snap = lastMotion(runtime);
  assert.equal(snap.sent, 1, 'only the newer send was adopted');
  assert.equal(snap.sendSeq, 2, 'two physical sends started');
  assert.equal(snap.appliedSeq, 2, 'appliedSeq advanced to the newer send');
  assert.equal(snap.abandoned, 0, 'a cancelled send is not abandoned');
  assert.equal(snap.outOfOrder, 0, 'the cancelled send produced no out-of-order completion');
  assert.equal(snap.inFlight, false, 'the newer send released its gate');
  console.log(
    `[motion] abort appliedSeq=${snap.appliedSeq} sendSeq=${snap.sendSeq} aborts=${lane.aborts.length}`
    + ` abandoned=${snap.abandoned} outOfOrder=${snap.outOfOrder}`,
  );
  runtime.dispose();
});

// ---------------------------------------------------------------------------------------------
// 15. a completion older than the applied sequence is dropped and reported
// ---------------------------------------------------------------------------------------------
test('15. 完成事件乱序：旧 seq 在新 seq 之后到达时丢弃并记 out-of-order', async () => {
  const lane = createControlledMotionTransport({ abort: true });
  const runtime = await connectRuntime({
    transport: lane.transport,
    config: motionConfig({
      motionWrites: true,
      motionOutputHz: 30,
      motionSendTimeoutMs: 50,
      seed: 33,
    }),
  });
  runtime.tick(0);
  runtime.tick(DT);
  await delay(70);
  assert.equal(lane.calls.length, 2, 'the newer send started after the abort');

  lane.resolveCall(1); // the newer send completes first
  await flushMicrotasks();
  let snap = lastMotion(runtime);
  assert.equal(snap.appliedSeq, 2, 'the newer send applied first');

  lane.resolveCall(0); // the cancelled old send still reports completion, late
  await flushMicrotasks();
  snap = lastMotion(runtime);
  assert.equal(snap.outOfOrder, 1, 'the late completion was rejected as out of order');
  assert.equal(snap.appliedSeq, 2, 'a late older completion cannot move appliedSeq backwards');
  assert.equal(snap.sent, 1, 'the late completion is never counted as sent');
  const events = runtime.takeEvents().filter((entry) => entry.type === 'avatar.motion.send.out-of-order');
  assert.equal(events.length, 1, 'the out-of-order event was recorded');
  assert.equal(events[0].seq, 1, 'the event names the late sequence');
  assert.equal(events[0].appliedSeq, 2, 'the event names the already-applied sequence');
  console.log(
    `[motion] out-of-order appliedSeq=${snap.appliedSeq} outOfOrder=${snap.outOfOrder}`
    + ` lateSeq=${events[0].seq} sent=${snap.sent}`,
  );
  runtime.dispose();
});

// ---------------------------------------------------------------------------------------------
// 16. normal path regression: send count/order unchanged, appliedSeq tracks sent
// ---------------------------------------------------------------------------------------------
test('16. 正常路径：发送次数与顺序不变，appliedSeq 与 sent 同步', async () => {
  const lane = createControlledMotionTransport();
  const runtime = await connectRuntime({
    transport: lane.transport,
    config: motionConfig({ motionWrites: true, motionOutputHz: 30, seed: 35 }),
  });
  for (let index = 0; index <= 40; index += 1) {
    runtime.tick(index * DT);
    lane.resolveCall(lane.calls.length - 1);
    await flushMicrotasks();
  }
  const snap = lastMotion(runtime);
  assert.equal(snap.sent, lane.calls.length, 'every started send was adopted');
  assert.equal(snap.sendSeq, lane.calls.length, 'sendSeq counts exactly the physical sends');
  assert.equal(snap.appliedSeq, lane.calls.length, 'appliedSeq matches the adopted sends');
  assert.equal(snap.timeouts, 0, 'no timeout on the normal path');
  assert.equal(snap.abandoned, 0, 'no abandoned lane on the normal path');
  assert.equal(snap.outOfOrder, 0, 'no out-of-order completion on the normal path');
  assert.equal(snap.skipped, false, 'the lane is not skipped');
  assert.equal(snap.inFlight, false, 'the gate is open');
  for (let index = 1; index < lane.calls.length; index += 1) {
    assert.ok(lane.calls[index].at > lane.calls[index - 1].at,
      `send ${index} went out after send ${index - 1}`);
  }
  console.log(
    `[motion] normal sent=${snap.sent} sendSeq=${snap.sendSeq} appliedSeq=${snap.appliedSeq}`
    + ` outOfOrder=${snap.outOfOrder} ordered=true`,
  );
  runtime.dispose();
});

// ---------------------------------------------------------------------------------------------
// 17. an abandoned send that finally settles reopens the lane and sends only the newest frame
// ---------------------------------------------------------------------------------------------
test('17. 超时后旧发送最终 settle：解除跳过并只发最新帧，不补播', async () => {
  const lane = createControlledMotionTransport();
  const runtime = await connectRuntime({
    transport: lane.transport,
    config: motionConfig({
      motionWrites: true,
      motionOutputHz: 30,
      motionSendTimeoutMs: 20,
      motionSendAbandonMs: 30,
      seed: 39,
    }),
  });
  runtime.tick(0); // A in flight
  runtime.tick(DT); // B staged
  runtime.tick(2 * DT); // C overwrites B
  await delay(120); // timeout + abandon
  assert.equal(lastMotion(runtime).abandoned, 1, 'the lane was marked abandoned first');
  assert.equal(lane.calls.length, 1, 'still no concurrent send');

  lane.resolveCall(0); // the old send finally settles
  await flushMicrotasks();
  assert.equal(lane.calls.length, 2, 'the lane reopened after the old send settled');
  assert.equal(lane.calls[1].at, 2 * DT, 'the newest staged frame was sent, not a replayed backlog');
  assert.equal(lastMotion(runtime).skipped, false, 'the lane is no longer skipped');

  lane.resolveCall(1);
  await flushMicrotasks();
  const snap = lastMotion(runtime);
  assert.equal(snap.sent, 2, 'the abandoned send and the newest frame were both adopted');
  assert.equal(snap.appliedSeq, 2, 'appliedSeq ends on the newest frame');
  assert.equal(snap.outOfOrder, 0, 'the recover path never reorders');
  assert.equal(snap.inFlight, false, 'the gate is open');
  console.log(
    `[motion] recover abandoned=${snap.abandoned} sent=${snap.sent}`
    + ` sendSeq=${snap.sendSeq} appliedSeq=${snap.appliedSeq} outOfOrder=${snap.outOfOrder}`,
  );
  runtime.dispose();
});

// ---------------------------------------------------------------------------------------------
// 18. sync cancel: a synchronous true confirmation releases the gate in the same turn
// ---------------------------------------------------------------------------------------------
test('18. 同步取消确认：abort 返回 true → 立刻发新帧，mode=sync/confirmed', async () => {
  const lane = createControlledMotionTransport({ abort: true });
  const runtime = await connectRuntime({
    transport: lane.transport,
    config: motionConfig({
      motionWrites: true,
      motionOutputHz: 30,
      motionSendTimeoutMs: 50,
      motionCancelWaitMs: 300,
      seed: 41,
    }),
  });
  runtime.tick(0); // A in flight
  runtime.tick(DT); // B staged
  assert.equal(lane.calls.length, 1, 'frame A is the only physical send');
  await delay(70); // past the 50 ms watchdog

  const snap = lastMotion(runtime);
  assert.equal(lane.calls.length, 2, 'the sync confirmation opened the gate and pumped the newest frame');
  assert.equal(lane.calls[1].at, DT, 'the newest staged frame was sent');
  assert.equal(snap.cancelConfirmed, 1, 'the sync cancel was counted as confirmed');
  assert.equal(snap.cancelUnconfirmed, 0, 'nothing was left unconfirmed');
  assert.equal(snap.inFlight, true, 'the newer send owns the gate');
  const cancels = runtime.takeEvents().filter((entry) => entry.type === 'avatar.motion.send.cancel');
  assert.equal(cancels.length, 1, 'the cancel event was recorded');
  assert.equal(cancels[0].sendId, 1, 'the event names the cancelled send');
  assert.equal(cancels[0].mode, 'sync', 'the transport answered synchronously');
  assert.equal(cancels[0].confirmed, true, 'the event reports the confirmation');
  console.log(
    `[motion] cancel-sync confirmed=${snap.cancelConfirmed} unconfirmed=${snap.cancelUnconfirmed}`
    + ` mode=${cancels[0].mode} newFrameAt=${lane.calls[1].at}`,
  );

  lane.resolveCall(1);
  await flushMicrotasks();
  runtime.dispose();
});

// ---------------------------------------------------------------------------------------------
// 19. async cancel: the new frame waits for the 100 ms confirmation, never starts before it
// ---------------------------------------------------------------------------------------------
test('19. 异步取消确认：100ms 后 resolve → 确认前不发新帧，确认后才 pump', async () => {
  let abortCalledAt = 0;
  let abortResolvedAt = 0;
  const lane = createControlledMotionTransport({
    abort: true,
    abortImpl: () => {
      abortCalledAt = performance.now();
      return new Promise((resolve) => {
        setTimeout(() => {
          abortResolvedAt = performance.now();
          resolve(true);
        }, 100);
      });
    },
  });
  const runtime = await connectRuntime({
    transport: lane.transport,
    config: motionConfig({
      motionWrites: true,
      motionOutputHz: 30,
      motionSendTimeoutMs: 40,
      motionCancelWaitMs: 500,
      seed: 43,
    }),
  });
  runtime.tick(0); // A in flight
  runtime.tick(DT); // B staged
  await delay(60); // past the 40 ms watchdog, before the 100 ms confirmation

  assert.equal(lane.aborts.length, 1, 'the watchdog asked for an async cancel');
  assert.equal(lane.calls.length, 1, 'no new frame while the cancel is unconfirmed');
  assert.equal(lastMotion(runtime).inFlight, true, 'the single-flight gate is still CLOSED');
  assert.equal(lastMotion(runtime).cancelConfirmed, 0, 'the pending cancel is not counted yet');

  const started = await waitFor(() => lane.calls.length === 2, 400);
  const snap = lastMotion(runtime);
  assert.equal(started, true, 'the new frame started after the confirmation');
  assert.ok(abortResolvedAt - abortCalledAt >= 95,
    `the transport really answered later (${(abortResolvedAt - abortCalledAt).toFixed(1)} ms)`);
  assert.equal(snap.cancelConfirmed, 1, 'the async cancel was confirmed');
  assert.equal(snap.cancelUnconfirmed, 0, 'no unconfirmed cancel was counted');
  assert.equal(lane.calls.length, 2, 'exactly one new physical send');
  assert.ok(lane.sentAt[1] >= abortResolvedAt,
    `new frame at ${lane.sentAt[1]} must not precede the abort resolution ${abortResolvedAt}`);
  assert.equal(lane.calls[1].at, DT, 'the newest staged frame was sent');
  const cancels = runtime.takeEvents().filter((entry) => entry.type === 'avatar.motion.send.cancel');
  assert.equal(cancels.length, 1, 'one cancel event was recorded');
  assert.equal(cancels[0].mode, 'async', 'the transport answered with a Promise');
  assert.equal(cancels[0].confirmed, true, 'the Promise resolved true');
  assert.ok(cancels[0].ms >= 95, `the event carries the wait (${cancels[0].ms} ms)`);
  console.log(
    `[motion] cancel-async confirmed=${snap.cancelConfirmed} mode=${cancels[0].mode}`
    + ` waitMs=${cancels[0].ms} abortToNewFrameMs=${(lane.sentAt[1] - abortCalledAt).toFixed(1)}`
    + ` ordered=${lane.sentAt[1] >= abortResolvedAt}`,
  );

  lane.resolveCall(1);
  await flushMicrotasks();
  runtime.dispose();
});

// ---------------------------------------------------------------------------------------------
// 20. async cancel resolving false: still unconfirmed, so the gate stays closed and is abandoned
// ---------------------------------------------------------------------------------------------
test('20. 异步取消 resolve false：保持单飞、走 abandoned、不发新帧', async () => {
  let releaseAbort = null;
  const lane = createControlledMotionTransport({
    abort: true,
    abortImpl: () => new Promise((resolve) => { releaseAbort = resolve; }),
  });
  const runtime = await connectRuntime({
    transport: lane.transport,
    config: motionConfig({
      motionWrites: true,
      motionOutputHz: 30,
      motionSendTimeoutMs: 30,
      motionSendAbandonMs: 30,
      motionCancelWaitMs: 500,
      seed: 45,
    }),
  });
  runtime.tick(0); // A in flight
  runtime.tick(DT); // B staged
  await delay(50); // past the watchdog; the async cancel is pending
  assert.equal(lane.aborts.length, 1, 'the async cancel was requested');
  assert.equal(lane.calls.length, 1, 'no new frame while the cancel is pending');
  assert.equal(typeof releaseAbort, 'function', 'the abort promise is controllable');
  releaseAbort(false);
  await flushMicrotasks();

  let snap = lastMotion(runtime);
  assert.equal(snap.cancelUnconfirmed, 1, 'resolve false is not a confirmation');
  assert.equal(snap.cancelConfirmed, 0, 'no confirmation was counted');
  assert.equal(snap.inFlight, true, 'the single-flight gate stays CLOSED');
  assert.equal(lane.calls.length, 1, 'no new frame after an unconfirmed cancel');

  await delay(70); // past the 30 ms abandon grace
  snap = lastMotion(runtime);
  assert.equal(snap.abandoned, 1, 'the unresolved lane was abandoned');
  assert.equal(snap.skipped, true, 'the lane is skipped');
  assert.equal(lane.calls.length, 1, 'still no new frame');
  assert.equal(snap.inFlight, true, 'the old send still owns the gate');
  const cancels = runtime.takeEvents().filter((entry) => entry.type === 'avatar.motion.send.cancel');
  assert.equal(cancels.length, 1, 'one cancel event was recorded');
  assert.equal(cancels[0].mode, 'async', 'the transport answered with a Promise');
  assert.equal(cancels[0].confirmed, false, 'the event reports the refusal');
  console.log(
    `[motion] cancel-async-false confirmed=${snap.cancelConfirmed}`
    + ` unconfirmed=${snap.cancelUnconfirmed} abandoned=${snap.abandoned}`
    + ` skipped=${snap.skipped} calls=${lane.calls.length}`,
  );
  runtime.dispose();
});

// ---------------------------------------------------------------------------------------------
// 21. async cancel rejected or timed out: both are unconfirmed, both abandon without a new frame
// ---------------------------------------------------------------------------------------------
test('21. 异步取消 reject/超时：保持单飞、走 abandoned 且记 unconfirmed', async () => {
  // (a) the abort promise rejects
  const rejecting = createControlledMotionTransport({
    abort: true,
    abortImpl: () => Promise.reject(new Error('cancel rejected')),
  });
  const rejectedRuntime = await connectRuntime({
    transport: rejecting.transport,
    config: motionConfig({
      motionWrites: true,
      motionOutputHz: 30,
      motionSendTimeoutMs: 20,
      motionSendAbandonMs: 25,
      motionCancelWaitMs: 200,
      seed: 47,
    }),
  });
  rejectedRuntime.tick(0);
  rejectedRuntime.tick(DT);
  await delay(80); // past timeout + reject + abandon grace
  let snap = lastMotion(rejectedRuntime);
  assert.equal(snap.cancelUnconfirmed, 1, 'a rejected cancel is unconfirmed');
  assert.equal(snap.cancelConfirmed, 0, 'a rejected cancel is never confirmed');
  assert.equal(snap.abandoned, 1, 'the lane was abandoned');
  assert.equal(snap.skipped, true, 'the lane is skipped');
  assert.equal(snap.inFlight, true, 'the old send still owns the gate');
  assert.equal(rejecting.calls.length, 1, 'no new frame was sent');
  let cancels = rejectedRuntime.takeEvents().filter((entry) => entry.type === 'avatar.motion.send.cancel');
  assert.equal(cancels.length, 1, 'the rejection recorded one cancel event');
  assert.equal(cancels[0].mode, 'async', 'the rejection came from a Promise');
  assert.equal(cancels[0].confirmed, false, 'the event reports the rejection');
  const rejectedLine = `[motion] cancel-reject unconfirmed=${snap.cancelUnconfirmed}`
    + ` abandoned=${snap.abandoned} skipped=${snap.skipped} calls=${rejecting.calls.length}`;
  rejectedRuntime.dispose();

  // (b) the abort promise never settles; the bounded wait expires
  const hanging = createControlledMotionTransport({
    abort: true,
    abortImpl: () => new Promise(() => {}),
  });
  const timeoutRuntime = await connectRuntime({
    transport: hanging.transport,
    config: motionConfig({
      motionWrites: true,
      motionOutputHz: 30,
      motionSendTimeoutMs: 20,
      motionSendAbandonMs: 25,
      motionCancelWaitMs: 40,
      seed: 49,
    }),
  });
  timeoutRuntime.tick(0);
  timeoutRuntime.tick(DT);
  await delay(130); // past timeout + cancel wait + abandon grace
  snap = lastMotion(timeoutRuntime);
  assert.equal(snap.cancelUnconfirmed, 1, 'a timed-out cancel is unconfirmed');
  assert.equal(snap.cancelConfirmed, 0, 'a timed-out cancel is never confirmed');
  assert.equal(snap.abandoned, 1, 'the lane was abandoned');
  assert.equal(snap.skipped, true, 'the lane is skipped');
  assert.equal(snap.inFlight, true, 'the old send still owns the gate');
  assert.equal(hanging.calls.length, 1, 'no new frame was sent');
  cancels = timeoutRuntime.takeEvents().filter((entry) => entry.type === 'avatar.motion.send.cancel');
  assert.equal(cancels.length, 1, 'the timeout recorded one cancel event');
  assert.equal(cancels[0].mode, 'async', 'the timeout came from a Promise');
  assert.equal(cancels[0].confirmed, false, 'the event reports the timeout');
  assert.ok(cancels[0].ms >= 35, `the event carries the bounded wait (${cancels[0].ms} ms)`);
  console.log(rejectedLine);
  console.log(
    `[motion] cancel-timeout unconfirmed=${snap.cancelUnconfirmed} abandoned=${snap.abandoned}`
    + ` skipped=${snap.skipped} waitMs=${cancels[0].ms} calls=${hanging.calls.length}`,
  );
  timeoutRuntime.dispose();
});

// ---------------------------------------------------------------------------------------------
// P-139 阶段 1 — 持续姿态的差异更清楚
// ---------------------------------------------------------------------------------------------
/**
 * Transport that keeps each motion payload (entries AND the semantic pose), so a test can prove a
 * written value was not clamped by comparing it with the pose the controller actually produced.
 */
function createPoseRecordingTransport() {
  const frames = [];
  return {
    frames,
    transport: {
      connect: async () => {},
      disconnect: async () => {},
      write: async () => ({ ok: true }),
      writeMotion: async (payload) => {
        frames.push({ entries: payload.entries, pose: payload.pose });
        return { ok: true };
      },
    },
  };
}

const absStats = (values) => {
  const sorted = values.map(Math.abs).sort((a, b) => a - b);
  return {
    p50: sorted[Math.floor(sorted.length / 2)] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
  };
};

/** Drive the default 30 Hz controller writer and return its FaceAngleX writes + the raw pose. */
const recordControllerHead = async (style, durationMs = 120_000) => {
  const fake = createPoseRecordingTransport();
  const runtime = await connectRuntime({
    transport: fake.transport,
    config: motionConfig({
      motionWrites: true,
      motionOutputHz: 30,
      seed: 4242,
      style,
      // Two mapped head axes: no single-channel alive gain, so FaceAngleX is exactly pose × 30.
      idleParams: {
        headX: { inputName: 'FaceAngleX', min: -30, max: 30 },
        headY: { inputName: 'FaceAngleY', min: -30, max: 30 },
      },
    }),
  });
  fake.frames.length = 0;
  const poses = [];
  for (let at = 1000; at <= 1000 + durationMs; at += DT) {
    poses.push(runtime.tick(at));
    await flushMicrotasks();
  }
  const rows = fake.frames.flatMap((frame) => frame.entries
    .filter((entry) => entry.input === 'FaceAngleX')
    .map((entry) => ({ value: entry.value, raw: frame.pose.headX * 30 })));
  const snapshot = runtime.snapshot();
  runtime.dispose();
  return { rows, snapshot, poses };
};

test('22. P-139 目标姿态：基础微动落在 2–4° 峰峰试验带，且没有触发幅度/步长截断', async () => {
  const style = { amplitude: 1.4, tempo: 1.5, gazeHabit: 'wandering' };
  const { rows, snapshot } = await recordControllerHead(style);
  assert.ok(rows.length >= 1000, `the controller wrote head frames (${rows.length})`);
  const after = absStats(rows.map((row) => row.value));
  // Trial range for the visible base layer: a few degrees, not the old 10° forced swing and not
  // the sub-degree trace that read as "frozen" between presets.
  assert.ok(after.p50 >= 0.8 && after.p50 <= 3.0,
    `p50 |headX| ${after.p50.toFixed(2)}° stays in the visible base band`);
  // The sent headX also carries the held component (5–12°) on top of the base, so its peak is
  // allowed up to the component cap; the BASE-only p2p is measured in the natural-component suite.
  assert.ok(after.max >= 2 && after.max <= 14.5,
    `max |headX| ${after.max.toFixed(2)}° stays inside the base+component cap`);

  // The amplitude/step limiter must not be what produced those numbers: every written value is
  // exactly the pose the controller produced (no cap, no idleMaxStep truncation).
  let clipped = 0;
  for (const row of rows) {
    if (Math.abs(row.value - row.raw) > 1e-9) clipped += 1;
  }
  assert.equal(clipped, 0, `no written sample was truncated by a limiter (${clipped}/${rows.length})`);
  // Lively style is allowed a proportionally larger cap, but the value still has to stay below it.
  const capDegrees = 0.6 * (1.4 * 1.4 * 1.08) * 30;
  assert.ok(after.max < capDegrees, `peak ${after.max.toFixed(2)}° stays below the style cap ${capDegrees.toFixed(2)}°`);
  assert.ok(snapshot.motion.posture.transitions >= 1, 'the persona really re-drew its posture');
  console.log(
    `[p139] range p50=${after.p50.toFixed(2)}° max=${after.max.toFixed(2)}° clipped=${clipped}`
    + ` cap=${capDegrees.toFixed(2)}° transitions=${snapshot.motion.posture.transitions}`,
  );
});

test('23. P-139 保持是主体：10 s 内 transitions ≤ 2，另一次决策明确选择不动', () => {
  const runtime = createBehaviorRuntime({
    config: {
      seed: 777,
      idleActions: [],
      // The 6–12 s range is a variant, not a new forced rhythm.
      postureHoldMinMs: 6000,
      postureHoldMaxMs: 12_000,
    },
  });
  let transitionsAtTenSeconds = 0;
  for (let at = 0; at <= 30_000; at += DT) {
    runtime.tick(at);
    if (at <= 10_000) transitionsAtTenSeconds = runtime.snapshot().motion.posture.transitions;
  }
  const held = runtime.snapshot().motion;
  assert.ok(transitionsAtTenSeconds <= 2,
    `transitions in the 10 s window = ${transitionsAtTenSeconds}`);
  assert.ok(Number.isFinite(held.posture.heldSince), 'posture.heldSince is observable');
  assert.ok(held.posture.remainingMs >= 0 && held.posture.remainingMs <= held.holdMs,
    `posture.remainingMs stays inside the hold (${held.posture.remainingMs}/${held.holdMs})`);
  assert.deepEqual(Object.keys(held.posture.target).sort(), ['bodyX', 'gazeX', 'gazeY', 'headX', 'headY', 'headZ'],
    'posture.target carries the per-axis goal');
  assert.equal(typeof held.posture.transitions, 'number', 'posture.transitions is observable');

  // A decision may keep the avatar exactly where it is: force that outcome and prove it is a real
  // branch (no transition, target ≈ current axes), not a missed timer.
  const still = createBehaviorRuntime({
    config: {
      seed: 11,
      idleActions: [],
      postureHoldMinMs: 6000,
      postureHoldMaxMs: 6000,
      postureHoldChance: 0,
      postureStillChance: 1,
    },
  });
  for (let at = 0; at <= 30_000; at += DT) still.tick(at);
  const stillSnap = still.snapshot().motion;
  assert.equal(stillSnap.posture.transitions, 0, 'choosing not to move is not a transition');
  assert.ok(stillSnap.posture.stills >= 1, `a no-move decision was recorded (${stillSnap.posture.stills})`);
  assert.equal(stillSnap.posture.lastDecision, 'still', 'the last decision reports the no-move outcome');
  console.log(
    `[p139] hold transitions@10s=${transitionsAtTenSeconds} total=${held.posture.transitions}`
    + ` holds=${held.postureHolds} remaining=${Math.round(held.posture.remainingMs)}ms`
    + ` stills=${stillSnap.posture.stills} stillTransitions=${stillSnap.posture.transitions}`,
  );
});

test('24. P-139 过渡：单次 1.2–1.8 s，相邻帧 ≤ 速度界、二阶差 ≤ 加速度界', () => {
  const runtime = createBehaviorRuntime({
    config: {
      seed: 5,
      idleActions: [],
      postureHoldMinMs: 4000,
      postureHoldMaxMs: 4000,
      postureHoldChance: 0,
      postureStillChance: 0,
      decisionHz: 30,
    },
  });
  const seen = new Map();
  // Smoothness is a property of every actual channel trajectory, not of `max(|headX|,|headY|,|headZ|)`:
  // that max has a kink whenever the dominant axis changes, so its second difference is not an
  // acceleration and can spike even when each axis is C². Track each axis separately.
  const previous = { headX: null, headY: null, headZ: null };
  const previousPrevious = { headX: null, headY: null, headZ: null };
  let maxDelta = 0;
  let maxSecond = 0;
  for (let at = 0; at <= 30_000; at += DT) {
    const pose = runtime.tick(at);
    const motion = runtime.snapshot().motion;
    for (const axis of ['headX', 'headY', 'headZ']) {
      const value = pose[axis];
      if (previous[axis] !== null) {
        maxDelta = Math.max(maxDelta, Math.abs(value - previous[axis]));
      }
      if (previousPrevious[axis] !== null) {
        maxSecond = Math.max(maxSecond,
          Math.abs(value - 2 * previous[axis] + previousPrevious[axis]));
      }
      previousPrevious[axis] = previous[axis];
      previous[axis] = value;
    }
    const last = motion.posture.lastTransition;
    if (last !== null && !seen.has(last.startedAt)) seen.set(last.startedAt, last);
  }
  const transitions = [...seen.values()];
  assert.ok(transitions.length >= 2, `several real transitions were observed (${transitions.length})`);
  for (const entry of transitions) {
    assert.ok(entry.actualMs >= 1200 && entry.actualMs <= 1800,
      `transition took ${entry.actualMs} ms (expected 1200–1800)`);
    assert.ok(entry.durationMs >= 1200 && entry.durationMs <= 1800,
      `planned transition was ${entry.durationMs} ms (expected 1200–1800)`);
  }
  // A visible 5–12° component lands over 1.2–1.8 s; every per-axis step stays well under 1.5°/frame
  // at 30 Hz (the old internal-axis bound is no longer meaningful after per-axis gain cancellation).
  const velocityBound = 0.05;
  const accelerationBound = 0.01;
  assert.ok(maxDelta <= velocityBound, `adjacent frame ${maxDelta} exceeds ${velocityBound}`);
  assert.ok(maxSecond <= accelerationBound, `second difference ${maxSecond} exceeds ${accelerationBound}`);
  console.log(
    `[p139] transitions=${transitions.length}`
    + ` durations=${transitions.map((entry) => Math.round(entry.actualMs)).join(',')}`
    + ` maxDelta=${maxDelta.toFixed(4)}≤${velocityBound.toFixed(4)}`
    + ` maxSecond=${maxSecond.toFixed(5)}≤${accelerationBound.toFixed(5)}`,
  );
});

test('25. P-139 聆听抑制：聆听时的大姿态变化显著少于 idle', () => {
  const run = (status) => {
    const runtime = createBehaviorRuntime({ config: { seed: 99, idleActions: [], status } });
    for (let at = 0; at <= 60_000; at += DT) runtime.tick(at);
    return runtime.snapshot().motion;
  };
  const idle = run('idle');
  const listening = run('listening');
  assert.ok(idle.posture.transitions >= 1, `idle really changed posture (${idle.posture.transitions})`);
  assert.ok(listening.posture.transitions < idle.posture.transitions * 0.5,
    `listening transitions ${listening.posture.transitions} must be < 0.5 × idle ${idle.posture.transitions}`);
  assert.ok(listening.posture.stills >= 1, `listening chose to stay put (${listening.posture.stills})`);
  console.log(
    `[p139] listening transitions=${listening.posture.transitions} idle=${idle.posture.transitions}`
    + ` ratio=${(listening.posture.transitions / Math.max(1, idle.posture.transitions)).toFixed(2)}`
    + ` stills=${listening.posture.stills}`,
  );
});

// ---------------------------------------------------------------------------------------------
// P-54 remainder — sentence-level action timing (clip start/end events, no timer)
// ---------------------------------------------------------------------------------------------
const clipRuntimeConfig = (extra = {}) => ({
  autoTickMs: 0,
  flushIntervalMs: 1,
  random: () => 0,
  idleActions: ['sway'],
  idleActionIntervalMs: 100,
  idleActionDedupeMs: 0,
  actionDurationMs: 200,
  idleParams: { headX: { inputName: 'FaceAngleX', min: -30, max: 30 } },
  ...extra,
});

test('26. 句级动作时点：3 句播放，动作只在 clip start 触发，句中断 0 次', async () => {
  const fake = createFakeTransport();
  let clock = 0;
  const runtime = await connectRuntime({
    transport: fake.transport,
    now: () => clock,
    config: clipRuntimeConfig(),
  });
  runtime.takeEvents(); // drop connect/probe diagnostics

  // Three real clips: start/end pairs reported by the host's playback events.
  const clips = [
    { index: 0, start: 0, end: 1200 },
    { index: 1, start: 1600, end: 2800 },
    { index: 2, start: 3200, end: 4400 },
  ];
  const starts = [];
  const ends = [];
  for (const clip of clips) {
    starts.push(clip.start);
    ends.push(clip.end);
  }

  const nextEvent = clips.flatMap((clip) => [
    { at: clip.start, kind: 'start', index: clip.index },
    { at: clip.end, kind: 'end', index: clip.index },
  ]).sort((left, right) => left.at - right.at);
  let eventIndex = 0;

  for (clock = 0; clock <= 5500; clock += 20) {
    while (eventIndex < nextEvent.length && nextEvent[eventIndex].at <= clock) {
      const event = nextEvent[eventIndex];
      runtime.speechClip(event.kind, { index: event.index, at: event.at });
      eventIndex += 1;
    }
    runtime.tick(clock);
    await flushMicrotasks();
  }
  runtime.speechEnd({ at: 4400 });

  const events = runtime.takeEvents();
  const timed = events.filter((entry) => entry.type === 'avatar.action.timed');
  const actionStarts = events.filter((entry) => entry.type === 'avatar.action.start');

  assert.ok(timed.length >= 2, `actions were timed to sentence starts (${timed.length})`);
  for (const entry of timed) {
    assert.equal(entry.reason, 'sentence-start', 'the timing reason names the boundary');
    assert.ok(starts.includes(entry.at), `timed at a clip start (${entry.at})`);
    const clip = clips.find((candidate) => candidate.start === entry.at);
    assert.equal(entry.clipIndex, clip.index, 'the event carries the sentence index');
    assert.equal(typeof entry.actionId, 'number', 'the event carries the action identity');
  }
  // No action may start strictly inside a playing clip (a mid-sentence trigger).
  for (const entry of actionStarts) {
    for (const clip of clips) {
      const inside = entry.startedAt > clip.start && entry.startedAt < clip.end;
      assert.equal(inside, false,
        `action started mid-sentence at ${entry.startedAt} inside clip ${clip.index}`);
    }
  }
  const snap = runtime.snapshot();
  assert.equal(snap.speech.clip.starts, 3, 'three clip starts were observed');
  assert.equal(snap.speech.clip.ends, 3, 'three clip ends were observed');
  assert.equal(snap.speech.clip.timed, timed.length, 'the snapshot counts the timed starts');
  console.log(
    `[p54] clips=${clips.length} timed=${timed.map((entry) => `${entry.at}@${entry.clipIndex}`).join(',')}`
    + ` starts=${actionStarts.map((entry) => entry.startedAt).join(',')}`
    + ` midSentence=0`,
  );
  runtime.dispose();
});

test('27. 动作写入不阻塞语音：慢动作帧下口型照常写入，播放时点不变', async () => {
  const run = async ({ withAction }) => {
    let clock = 0;
    const mouthWrites = [];
    const frameWrites = [];
    let releaseFrame = null;
    let blockFrames = false;
    const transport = {
      connect: async () => {},
      disconnect: async () => {},
      write: async ({ input, value }) => {
        mouthWrites.push({ input, value, at: clock });
        return { ok: true };
      },
      writeFrame: (entries) => {
        frameWrites.push({ at: clock, inputs: entries.map((entry) => entry.input) });
        if (blockFrames !== true) return { ok: true };
        return new Promise((resolve) => { releaseFrame = () => resolve({ ok: true }); });
      },
    };
    const runtime = await connectRuntime({
      transport,
      now: () => clock,
      config: clipRuntimeConfig({
        idleActionIntervalMs: 100,
        actionDurationMs: 300,
        flushIntervalMs: 20,
        ...(withAction ? {} : { idleActions: [] }),
      }),
    });
    // The mouth input comes from a verified mapping in production; map it directly here.
    runtime.setMouthInput('MouthOpen');
    const levels = Array.from({ length: 200 }, (_, index) => (index % 20) / 20);
    const spoken = await runtime.speak({
      levels, stepMs: 10, durationMs: 2000, startedAt: 0, owner: 'speech',
    });
    assert.equal(spoken.ok, true, 'the speech session was accepted');
    runtime.speechClip('start', { index: 0, at: 0 });

    let actionStarted = null;
    for (clock = 0; clock <= 1200; clock += 20) {
      if (withAction && clock === 100) {
        // The single waiting candidate is released exactly at this clip start.
        blockFrames = true;
        const timed = runtime.speechClip('start', { index: 1, at: 100 });
        actionStarted = timed.actionId;
      }
      runtime.tick(clock);
      await flushMicrotasks();
    }
    const snap = runtime.snapshot();
    if (typeof releaseFrame === 'function') releaseFrame();
    await flushMicrotasks();
    return { mouthWrites, frameWrites, snap, actionStarted, spoken, runtime };
  };

  const baseline = await run({ withAction: false });
  const withAction = await run({ withAction: true });

  // The exact same speech writes (same clock timestamps, same envelope values) reach the player,
  // even though the action's parameter frame is stuck in flight.
  assert.deepEqual(
    withAction.mouthWrites.map((entry) => entry.at),
    baseline.mouthWrites.map((entry) => entry.at),
    'the mouth write timestamps are untouched by the concurrent action',
  );
  assert.equal(withAction.mouthWrites.length, baseline.mouthWrites.length);
  for (let index = 0; index < baseline.mouthWrites.length; index += 1) {
    assert.ok(Math.abs(withAction.mouthWrites[index].value - baseline.mouthWrites[index].value) < 1e-9,
      `mouth value at ${baseline.mouthWrites[index].at} is unchanged`);
  }
  assert.ok(withAction.actionStarted !== null, 'the action really started at the sentence boundary');
  assert.equal(withAction.snap.actions.started >= 1, true, 'the runtime scheduled the action');
  assert.equal(withAction.snap.speech.clip.index, 1, 'the clip index is still the second sentence');
  assert.equal(withAction.spoken.startedAt, 0, 'the speech playback start timestamp is unchanged');
  assert.equal(withAction.snap.speech.speaking, true, 'the speech session is still playing');
  assert.ok(withAction.snap.idleParams.dropped > 0,
    `the slow action frame was dropped, never queued (${withAction.snap.idleParams.dropped})`);
  console.log(
    `[p54] mouthWrites=${withAction.mouthWrites.length}`
    + ` (baseline ${baseline.mouthWrites.length})`
    + ` actionId=${withAction.actionStarted} idleDropped=${withAction.snap.idleParams.dropped}`
    + ` speechStartedAt=${withAction.spoken.startedAt}`,
  );
  withAction.runtime.dispose();
  baseline.runtime.dispose();
});

test('28. 单槽回归：动作重叠时丢弃旧候选，不排队、不并发', async () => {
  const fake = createFakeTransport();
  let clock = 0;
  const runtime = await connectRuntime({
    transport: fake.transport,
    now: () => clock,
    config: clipRuntimeConfig({ actionDurationMs: 600 }),
  });
  runtime.takeEvents();

  let maxWaiting = 0;
  let maxConcurrent = 0;
  for (clock = 0; clock <= 3000; clock += 10) {
    runtime.tick(clock);
    await flushMicrotasks();
    const actions = runtime.snapshot().actions;
    maxWaiting = Math.max(maxWaiting, actions.waiting);
    maxConcurrent = Math.max(maxConcurrent, actions.current === null ? 0 : 1);
  }
  const events = runtime.takeEvents();
  const starts = events.filter((entry) => entry.type === 'avatar.action.start');
  const snap = runtime.snapshot();
  assert.ok(maxWaiting <= 1, `the single waiting slot was never exceeded (${maxWaiting})`);
  assert.equal(maxConcurrent, 1, 'at most one action ran at a time');
  assert.ok(snap.actions.dropped > 0,
    `overlapping candidates were dropped, not queued (${snap.actions.dropped})`);
  assert.ok(starts.length >= 2, `several actions still ran (${starts.length})`);
  for (let index = 1; index < starts.length; index += 1) {
    const gap = starts[index].startedAt - starts[index - 1].startedAt;
    assert.ok(gap >= 600, `no overlap: starts ${gap} ms apart (duration 600)`);
  }
  const delivered = runtime.takeActions();
  assert.ok(delivered.length <= starts.length, 'delivery is one entry per started action');
  for (const entry of delivered) assert.equal(typeof entry.actionId, 'number');
  console.log(
    `[p54] starts=${starts.length} dropped=${snap.actions.dropped}`
    + ` maxWaiting=${maxWaiting} maxConcurrent=${maxConcurrent} delivered=${delivered.length}`,
  );
  runtime.dispose();
});

// ---------------------------------------------------------------------------------------------
// 29. privacy lock / disconnect / model switch stop the CORE trajectory immediately
// ---------------------------------------------------------------------------------------------
test('29. 隐私锁/断连/模型切换/打断：核心旧轨迹立即停，不跑完剩余时长', async () => {
  const headRows = [
    { channel: 'headX', inputName: 'FaceAngleX', injectable: true, verified: true, min: -30, max: 30 },
    { channel: 'headY', inputName: 'FaceAngleY', injectable: true, verified: true, min: -30, max: 30 },
    { channel: 'headZ', inputName: 'FaceAngleZ', injectable: true, verified: true, min: -30, max: 30 },
  ];
  const runPath = async (stop) => {
    const fake = createFakeTransport();
    let clock = 0;
    const runtime = await connectRuntime({
      transport: fake.transport,
      now: () => clock,
      config: motionConfig({
        style: { nodDurationMs: 1200 },
        idleParams: {
          headX: { inputName: 'FaceAngleX', min: -30, max: 30 },
          headY: { inputName: 'FaceAngleY', min: -30, max: 30 },
          headZ: { inputName: 'FaceAngleZ', min: -30, max: 30 },
        },
      }),
    });
    runtime.takeEvents();
    clock = 0;
    const started = runtime.intent('tilt', { at: 0 });
    assert.equal(started.ok, true, 'the tilt started');
    for (clock = 0; clock <= 100; clock += 20) runtime.tick(clock);
    clock = 100;
    const before = runtime.snapshot().intents;
    assert.equal(before.active.length, 1, 'one tilt trajectory is running');
    assert.equal(before.active[0].kind, 'tilt');
    const remainingBefore = before.active[0].remainingMs;
    assert.ok(remainingBefore > 300, `the tilt still had ${Math.round(remainingBefore)} ms to run`);

    await stop(runtime);
    const after = runtime.snapshot().intents;
    assert.deepEqual(after.active, [], 'no old trajectory survives the stop');
    assert.deepEqual(after.channels, [], 'no old channel keeps flushing');
    const cleared = runtime.takeEvents()
      .filter((entry) => entry.type === 'avatar.intent.trajectory.cleared');
    assert.equal(cleared.length, 1, `one clearance event was recorded (${cleared.length})`);
    assert.deepEqual(cleared[0].axes, ['headX', 'headZ'], 'the cleared axes are the tilt channels');
    assert.ok(Math.abs(cleared[0].remainingMs - remainingBefore) <= 1000 / 30,
      `cleared remainingMs ${cleared[0].remainingMs} ≈ pre-clear ${Math.round(remainingBefore)}`);

    // One more frame: the axis target is the pure idle base (a surviving tilt would drive headX).
    runtime.tick(100 + DT);
    const target = runtime.snapshot().intents.target;
    assert.equal(target.headX, 0, `the old tilt contributes nothing after the stop (${target.headX})`);
    runtime.dispose();
    return { reason: cleared[0].reason, remainingMs: cleared[0].remainingMs, before: remainingBefore };
  };

  const locked = await runPath((runtime) => runtime.lock('privacy'));
  assert.equal(locked.reason, 'lock:privacy');
  const disconnected = await runPath(async (runtime) => { await runtime.disconnect(); });
  assert.equal(disconnected.reason, 'disconnect');
  const switched = await runPath(async (runtime) => {
    await runtime.setChannelMappings(headRows, { channelMap: {} });
  });
  assert.equal(switched.reason, 'channel-mappings');
  const bargedIn = await runPath((runtime) => runtime.interrupt({ reason: 'barge-in' }));
  assert.equal(bargedIn.reason, 'barge-in');
  console.log(
    `[motion] trajectory-stop lock=${locked.reason}/${locked.remainingMs}ms`
    + ` disconnect=${disconnected.reason}/${disconnected.remainingMs}ms`
    + ` model=${switched.reason}/${switched.remainingMs}ms`
    + ` interrupt=${bargedIn.reason}/${bargedIn.remainingMs}ms`
    + ` preClear=${Math.round(locked.before)}ms activeAfter=0`,
  );
});

// ---------------------------------------------------------------------------------------------
// P-139 stage 4 — "why each motion happens": A hold, B transition, hold drift, conversation-end relax
// ---------------------------------------------------------------------------------------------
/** Config for a short response action: the nod needs the three head axes to be verified. */
const responseConfig = (extra = {}) => ({
  autoTickMs: 0,
  flushIntervalMs: 1,
  idleActions: [],
  idleParams: {
    headX: { inputName: 'FaceAngleX', min: -30, max: 30 },
    headY: { inputName: 'FaceAngleY', min: -30, max: 30 },
    headZ: { inputName: 'FaceAngleZ', min: -30, max: 30 },
  },
  ...extra,
});

test('30. P-139 阶段 4 — relax：2–4 s 平滑衰减到基座（无跳变）', () => {
  const runtime = createBehaviorRuntime({
    config: {
      seed: 77,
      idleActions: [],
      postureHoldMinMs: 6000,
      postureHoldMaxMs: 6000,
      postureHoldChance: 1,
      postureStillChance: 0,
    },
  });
  for (let at = 0; at <= 12_000; at += DT) runtime.tick(at);
  const before = runtime.snapshot().motion;
  assert.ok(Math.abs(before.axes.headX.current) > 0.3,
    `the posture really deviated before the relax (${before.axes.headX.current.toFixed(3)})`);

  const result = runtime.relax({ at: 12_000 });
  assert.equal(result.ok, true);
  assert.ok(result.durationMs >= RELAX_PLAN.MIN_MS && result.durationMs <= RELAX_PLAN.MAX_MS,
    `relax ${result.durationMs} ms is inside 2–4 s`);
  assert.equal(result.transitionMs, result.durationMs, 'the planned transition uses the whole window');

  const samples = [];
  let maxDelta = 0;
  let previous = null;
  for (let at = 12_000; at <= 16_500; at += DT) {
    runtime.tick(at);
    const motion = runtime.snapshot().motion;
    const axis = motion.axes.headX.current;
    if (previous !== null) maxDelta = Math.max(maxDelta, Math.abs(axis - previous));
    previous = axis;
    samples.push({ at, axis, relax: motion.relaxation });
  }
  // No jump: the transition starts and ends with zero velocity, so one frame never steps past the
  // controller's own velocity bound.
  const limit = runtime.snapshot().motion.limits.maxVelocity * (DT / 1000) + 1e-6;
  assert.ok(maxDelta <= limit, `adjacent frame ${maxDelta.toFixed(5)} exceeds ${limit.toFixed(5)}`);
  const endAt = 12_000 + result.durationMs;
  let previousAxis = Number.POSITIVE_INFINITY;
  for (const sample of samples) {
    if (sample.at > endAt) break;
    assert.ok(sample.axis <= previousAxis + 1e-9,
      `the amplitude decays monotonically (${sample.axis.toFixed(4)} at ${sample.at.toFixed(0)} ms)`);
    previousAxis = sample.axis;
  }
  assert.ok(samples.some((sample) => sample.relax >= 1), 'the relaxation factor reaches 1 inside the window');
  const completed = runtime.snapshot().motion;
  for (const axis of ['headX', 'headY', 'headZ', 'bodyX', 'gazeX', 'gazeY']) {
    assert.ok(Math.abs(completed.posture.target[axis]) < 1e-9, `posture.target.${axis} returned to the base`);
  }
  assert.ok(Math.abs(completed.axes.headX.current) < 0.03,
    `the pose ends at the base (${completed.axes.headX.current.toFixed(4)})`);
  assert.equal(completed.posture.lastTransition.kind, 'relax');
  assert.ok(Math.abs(completed.posture.lastTransition.durationMs - result.durationMs) <= DT + 1e-6,
    'the recorded transition is the 2–4 s relax');
  assert.ok(completed.posture.relaxTransitions >= 1, 'the relax transition is counted separately');
  assert.equal(completed.posture.transitions, 0, 'a relax is never counted as an idle re-draw');
  console.log(
    `[p139] relax duration=${result.durationMs}ms from=${result.from.headX.toFixed(3)}`
    + ` maxDelta=${maxDelta.toFixed(5)}≤${limit.toFixed(5)}`
    + ` end=${completed.axes.headX.current.toFixed(4)} relax=${completed.relaxation.toFixed(2)}`
    + ` kind=${completed.posture.lastTransition.kind}`,
  );
});

test('31. P-139 阶段 4 — A 保持分配：活泼 4–8 s、安静 6–12 s，不动概率保留', () => {
  const run = (style, seed = 42) => {
    const runtime = createBehaviorRuntime({ config: { seed, idleActions: [], style } });
    let minMs = Number.POSITIVE_INFINITY;
    let maxMs = 0;
    let variant = '';
    for (let at = 0; at <= 240_000; at += DT) {
      runtime.tick(at);
      const motion = runtime.snapshot().motion;
      if (motion.holdMs > 0) {
        minMs = Math.min(minMs, motion.holdMs);
        maxMs = Math.max(maxMs, motion.holdMs);
        variant = motion.holdVariant;
      }
    }
    return { motion: runtime.snapshot().motion, minMs, maxMs, variant };
  };
  const lively = run({ amplitude: 1.35, tempo: 1.35, nodAmplitude: 1.3, expressiveness: 1.4, tiltChance: 0.4, nodDurationMs: 350 });
  const quiet = run({ amplitude: 0.55, tempo: 0.8, nodAmplitude: 0.5, expressiveness: 0.6, tiltChance: 0.05, nodDurationMs: 700 });
  assert.ok(lively.motion.holdMs >= POSTURE_HOLD_ALLOCATION.lively.MIN_MS
    && lively.motion.holdMs <= POSTURE_HOLD_ALLOCATION.lively.MAX_MS,
  `lively current hold ${Math.round(lively.motion.holdMs)}ms is in 4–8 s`);
  assert.ok(quiet.motion.holdMs >= POSTURE_HOLD_ALLOCATION.base.MIN_MS
    && quiet.motion.holdMs <= POSTURE_HOLD_ALLOCATION.base.MAX_MS,
  `quiet current hold ${Math.round(quiet.motion.holdMs)}ms is in the base band`);
  assert.ok(lively.minMs >= 4_000 && lively.maxMs <= 8_000,
    `every lively window is 4–8 s (${Math.round(lively.minMs)}–${Math.round(lively.maxMs)}ms)`);
  assert.ok(quiet.minMs >= POSTURE_HOLD_ALLOCATION.base.MIN_MS && quiet.maxMs <= POSTURE_HOLD_ALLOCATION.base.MAX_MS,
    `every quiet window stays in the base band (${Math.round(quiet.minMs)}–${Math.round(quiet.maxMs)}ms)`);
  assert.equal(lively.variant, 'lively');
  assert.equal(quiet.variant, 'base');
  // The still/hold outcomes are untouched: both personas explicitly chose not to move.
  assert.ok(lively.motion.posture.stills >= 1, `lively stills ${lively.motion.posture.stills}`);
  assert.ok(quiet.motion.posture.stills >= 1, `quiet stills ${quiet.motion.posture.stills}`);
  assert.ok(lively.motion.posture.transitions >= 1);
  assert.ok(quiet.motion.posture.transitions >= 1);

  // An explicit host window always wins, so a tuning profile / test stays deterministic.
  const pinned = createBehaviorRuntime({
    config: { seed: 42, idleActions: [], postureHoldMinMs: 10_000, postureHoldMaxMs: 10_000 },
  });
  for (let at = 0; at <= 20_000; at += DT) pinned.tick(at);
  const pinnedMotion = pinned.snapshot().motion;
  assert.equal(pinnedMotion.holdVariant, 'config');
  assert.equal(pinnedMotion.holdMs, 10_000, 'the configured hold is not re-allocated by A');
  console.log(
    `[p139] holdA lively=${Math.round(lively.minMs)}–${Math.round(lively.maxMs)}ms/${lively.variant}`
    + ` stills=${lively.motion.posture.stills} quiet=${Math.round(quiet.minMs)}–${Math.round(quiet.maxMs)}ms/${quiet.variant}`
    + ` stills=${quiet.motion.posture.stills} pinned=${pinnedMotion.holdMs}ms/${pinnedMotion.holdVariant}`,
  );
});

test('32. P-139 阶段 4 — B 过渡：短促回应动作 0.8–1.2 s，待机换姿态仍 1.2–1.8 s', async () => {
  const idle = createBehaviorRuntime({
    config: {
      seed: 5,
      idleActions: [],
      postureHoldMinMs: 4000,
      postureHoldMaxMs: 4000,
      postureHoldChance: 0,
      postureStillChance: 0,
      decisionHz: 30,
    },
  });
  const seen = new Map();
  for (let at = 0; at <= 30_000; at += DT) {
    idle.tick(at);
    const last = idle.snapshot().motion.posture.lastTransition;
    if (last !== null && !seen.has(last.startedAt)) seen.set(last.startedAt, last);
  }
  const idleTransitions = [...seen.values()];
  assert.ok(idleTransitions.length >= 2, `several idle transitions were observed (${idleTransitions.length})`);
  for (const entry of idleTransitions) {
    assert.equal(entry.kind, 'idle', 'an idle re-draw keeps the idle window');
    assert.ok(entry.durationMs >= 1200 && entry.durationMs <= 1800,
      `idle transition ${entry.durationMs} ms (expected 1200–1800)`);
    assert.ok(entry.actualMs >= 1200 && entry.actualMs <= 1800);
  }

  const runShort = async (tempo) => {
    const fake = createFakeTransport();
    let clock = 0;
    const runtime = await connectRuntime({
      transport: fake.transport,
      now: () => clock,
      config: responseConfig({ seed: 7, style: { tempo } }),
    });
    runtime.takeEvents();
    for (clock = 0; clock <= 200; clock += 20) {
      runtime.tick(clock);
      await flushMicrotasks();
    }
    clock = 300;
    runtime.speechClip('start', { index: 0, at: 300 });
    const reported = runtime.intentEvent('user-speaking', { at: 300 });
    assert.equal(reported.released, true, 'the listening micro-reaction starts at the sentence head');
    for (clock = 300; clock <= 2200; clock += 20) {
      runtime.tick(clock);
      await flushMicrotasks();
    }
    const motion = runtime.snapshot().motion;
    runtime.dispose();
    return { motion, reported };
  };

  const normal = await runShort(1);
  assert.equal(normal.motion.posture.shortTransitions, 1, 'the short response action landed its posture');
  assert.equal(normal.motion.posture.transitions, 0, 'no idle re-draw happened inside the run');
  const short = normal.motion.posture.lastTransition;
  assert.equal(short.kind, 'short');
  assert.ok(short.durationMs >= SHORT_ACTION_TRANSITION.MIN_MS && short.durationMs <= SHORT_ACTION_TRANSITION.MAX_MS,
    `short transition ${short.durationMs} ms (expected 800–1200)`);
  assert.ok(short.actualMs >= SHORT_ACTION_TRANSITION.MIN_MS && short.actualMs <= SHORT_ACTION_TRANSITION.MAX_MS + DT);
  const quiet = await runShort(0.7);
  assert.equal(quiet.motion.posture.lastTransition.durationMs, 1200, 'a slow persona reaches the 1.2 s edge');
  const lively = await runShort(1.5);
  assert.equal(lively.motion.posture.lastTransition.durationMs, 800, 'a quick persona reaches the 0.8 s edge');
  console.log(
    `[p139] transitionB idle=${idleTransitions.slice(0, 3).map((entry) => Math.round(entry.actualMs)).join(',')}ms`
    + ` short=${short.durationMs}ms quiet=${quiet.motion.posture.lastTransition.durationMs}ms`
    + ` lively=${lively.motion.posture.lastTransition.durationMs}ms idleRedraws=${normal.motion.posture.transitions}`,
  );
});

test('33. P-139 阶段 4 — 保持期间微动：≤1°、低频、复用 30 Hz tick', () => {
  const runtime = createBehaviorRuntime({
    config: {
      seed: 5,
      idleActions: [],
      postureHoldMinMs: 60_000,
      postureHoldMaxMs: 60_000,
      postureHoldChance: 1,
      postureStillChance: 0,
    },
  });
  const samples = [];
  let maxStep = 0;
  let previous = null;
  const framesBefore = runtime.snapshot().motion.frames;
  const ticks = 1200;
  for (let index = 0; index <= ticks; index += 1) {
    runtime.tick(index * DT);
    const drift = runtime.snapshot().motion.holdDrift;
    for (const axis of ['headX', 'headY', 'headZ']) {
      assert.ok(Math.abs(drift[axis]) <= HOLD_MICRO_DRIFT.DEGREES / 30 + 1e-9,
        `${axis} drift ${drift[axis]} exceeds ${HOLD_MICRO_DRIFT.DEGREES}°`);
    }
    const pitch = drift.headY * 30;
    const roll = drift.headZ * 30;
    if (previous !== null) maxStep = Math.max(maxStep, Math.abs(pitch - previous));
    previous = pitch;
    samples.push({ pitch, roll, yaw: drift.headX * 30 });
  }
  assert.ok(Math.max(...samples.map((entry) => Math.abs(entry.yaw))) > 0.2,
    'the yaw now carries the same slow, irregular drift as the other head axes');
  assert.ok(Math.max(...samples.map((entry) => Math.abs(entry.pitch))) > 0.2, 'the pitch really drifts');
  let crossings = 0;
  for (let index = 1; index < samples.length; index += 1) {
    if (Math.sign(samples[index].pitch) !== Math.sign(samples[index - 1].pitch)) crossings += 1;
  }
  assert.ok(crossings <= 6, `low-frequency drift (${crossings} sign changes in 40 s)`);
  assert.ok(maxStep < 0.01, `no visible step (${maxStep.toFixed(5)}°/frame)`);
  // It rides the same 30 Hz tick: exactly one controller frame per tick, no timer of its own.
  assert.equal(runtime.snapshot().motion.frames - framesBefore, ticks + 1);
  // An explicit "no idle sway" opt-out stays exactly still.
  const still = createBehaviorRuntime({
    config: {
      seed: 5,
      idleActions: [],
      idleSwayScale: 0,
      postureHoldMinMs: 60_000,
      postureHoldMaxMs: 60_000,
    },
  });
  for (let at = 0; at <= 3_000; at += DT) still.tick(at);
  const stillDrift = still.snapshot().motion.holdDrift;
  assert.equal(Math.abs(stillDrift.headX), 0);
  assert.equal(Math.abs(stillDrift.headY), 0);
  assert.equal(Math.abs(stillDrift.headZ), 0);
  console.log(
    `[p139] holdDrift maxPitch=${Math.max(...samples.map((entry) => Math.abs(entry.pitch))).toFixed(3)}°`
    + ` maxRoll=${Math.max(...samples.map((entry) => Math.abs(entry.roll))).toFixed(3)}°`
    + ` cap=${HOLD_MICRO_DRIFT.DEGREES}° crossings=${crossings} maxStep=${maxStep.toFixed(5)}°`
    + ` frames=${runtime.snapshot().motion.frames - framesBefore} sway0=0`,
  );
});

// ---------------------------------------------------------------------------------------------
// Motion attribution — `avatar.action.trace` records the value that was REALLY written: after the
// speech scale and after the amplitude cap, not the raw request. This is evidence only; the writer
// path (idleWriteValue/intentWriteValue) is untouched.
// ---------------------------------------------------------------------------------------------
/** One idle candidate ('sway' → headX) runs long enough for >=2 tracked writes. */
const traceConfig = (extra = {}) => ({
  autoTickMs: 0,
  flushIntervalMs: 1,
  seed: 7,
  idleActions: ['sway'],
  idleActionIntervalMs: 100,
  idleActionDedupeMs: 0,
  actionDurationMs: 600,
  idleParams: { headX: { inputName: 'FaceAngleX', min: -30, max: 30 } },
  ...extra,
});

const firstTraceFor = (events, channel) => events
  .filter((entry) => entry.type === 'avatar.action.trace' && entry.channels.includes(channel))
  .at(0);

test('34. 说话缩放：trace.final 与 amplitude 均记录缩放后的实际写入值', async () => {
  const run = async (speaking) => {
    const fake = createFakeTransport();
    let clock = 0;
    const runtime = await connectRuntime({
      transport: fake.transport,
      now: () => clock,
      config: traceConfig({
        // A high cap and no step limit, so the speech scale is the only reduction in play.
        idleAmplitude: 1,
        idleMaxStep: 1,
        idleSwayScale: 1.2,
      }),
    });
    runtime.takeEvents();
    if (speaking === true) {
      const spoken = await runtime.speak({
        levels: Array.from({ length: 40 }, () => 0.5), stepMs: 50, durationMs: 2000, startedAt: 0,
      });
      assert.equal(spoken.ok, true, 'the speech session is active for the whole action');
    }
    for (clock = 0; clock <= 900; clock += 20) {
      runtime.tick(clock);
      await flushMicrotasks();
    }
    const trace = firstTraceFor(runtime.takeEvents(), 'headX');
    assert.ok(trace, 'the sway action emitted a trace');
    return { trace, writes: fake.writes, snapshot: runtime.snapshot() };
  };

  const quiet = await run(false);
  const scaled = await run(true);

  // The recorded `final` is a value that really reached the transport (semantic → input mapping).
  const expectedInput = toInputValue({ min: -30, max: 30 }, scaled.trace.final.headX, { bidirectional: true });
  assert.ok(scaled.writes.some((entry) => entry.input === 'FaceAngleX'
    && Math.abs(entry.value - expectedInput) < 1e-9),
  `trace.final is the last actual write (${expectedInput} not found)`);

  assert.equal(scaled.trace.suppressed, 'speech-damping', 'the trace names the speech scale');
  assert.ok(scaled.trace.amplitude > 0);
  // Both the peak (`amplitude`) and the last value (`final`) are post-scale: the 0.9 write scale is
  // visible as a clearly smaller swing than the same action with no active speech.
  assert.ok(scaled.trace.amplitude < quiet.trace.amplitude * 0.75,
    `speaking amplitude ${scaled.trace.amplitude.toFixed(5)} < quiet ${quiet.trace.amplitude.toFixed(5)}`);
  assert.ok(Math.abs(scaled.trace.final.headX) < Math.abs(quiet.trace.final.headX),
    `speaking final ${scaled.trace.final.headX.toFixed(5)} < quiet ${quiet.trace.final.headX.toFixed(5)}`);
  assert.ok(Math.abs(scaled.trace.final.headX) <= scaled.trace.amplitude + 1e-9,
    'the last value is bound by the recorded (scaled) amplitude');
  assert.ok(scaled.trace.amplitude <= quiet.trace.amplitude + 1e-9,
    'the recorded amplitude itself is the scaled one');
  // The numeric relation: the written value is the 0.6 core head damp × the 0.9 idle write scale.
  const expectedRatio = SPEECH_HEAD_DAMP * IDLE_SPEECH_SCALE;
  const actualRatio = scaled.trace.amplitude / quiet.trace.amplitude;
  assert.ok(Math.abs(actualRatio - expectedRatio) < 0.02,
    `amplitude ratio ${actualRatio.toFixed(3)} ≈ speech scale ${expectedRatio.toFixed(3)}`);
  console.log(
    `[trace] speechScale quiet=${quiet.trace.amplitude.toFixed(5)}`
    + ` speaking=${scaled.trace.amplitude.toFixed(5)}`
    + ` ratio=${(scaled.trace.amplitude / quiet.trace.amplitude).toFixed(3)}`
    + ` expected=${expectedRatio.toFixed(3)}`
    + ` final=${scaled.trace.final.headX.toFixed(5)} suppressed=${scaled.trace.suppressed}`
    + ` inputWrite=${expectedInput.toFixed(4)}`,
  );
});

test('35. 限幅命中：suppressed=limit，final 等于该通道的幅度上限', async () => {
  const fake = createFakeTransport();
  let clock = 0;
  const cap = 0.01;
  const runtime = await connectRuntime({
    transport: fake.transport,
    now: () => clock,
    config: traceConfig({
      // Three mapped channels → no single-channel alive gain, so the plain cap applies exactly.
      idleParams: {
        headX: { inputName: 'FaceAngleX', min: -30, max: 30 },
        headY: { inputName: 'FaceAngleY', min: -30, max: 30 },
        headZ: { inputName: 'FaceAngleZ', min: -30, max: 30 },
      },
      // A deliberately huge idle curve against a tiny cap: every tracked write is clamped.
      idleSwayScale: 10,
      idleAmplitude: cap,
      idleMaxStep: 1,
    }),
  });
  runtime.takeEvents();
  for (clock = 0; clock <= 900; clock += 20) {
    runtime.tick(clock);
    await flushMicrotasks();
  }

  const trace = firstTraceFor(runtime.takeEvents(), 'headX');
  assert.ok(trace, 'the sway action emitted a trace');
  assert.equal(trace.suppressed, 'limit', 'the trace names the amplitude cap');
  assert.ok(Math.abs(trace.amplitude - cap) < 1e-12,
    `the recorded peak is the cap (${trace.amplitude})`);
  assert.ok(Math.abs(Math.abs(trace.final.headX) - cap) < 1e-12,
    `final is the cap itself (${trace.final.headX})`);
  const expectedInput = toInputValue({ min: -30, max: 30 }, cap, { bidirectional: true });
  assert.ok(fake.writes.some((entry) => entry.input === 'FaceAngleX'
    && Math.abs(Math.abs(entry.value) - expectedInput) < 1e-9),
  `the capped value really reached the transport (${expectedInput} not found)`);
  assert.ok(runtime.snapshot().motion.actionTrace.some((entry) => entry.actionId === trace.actionId),
    'the read-only buffer keeps the capped trace');
  console.log(
    `[trace] limit cap=${cap} final.headX=${trace.final.headX}`
    + ` amplitude=${trace.amplitude} inputWrite=±${expectedInput.toFixed(2)}`
    + ` suppressed=${trace.suppressed} channel=${trace.channels.join('|')}`,
  );
  runtime.dispose();
});

// ---------------------------------------------------------------------------------------------
// Stage 5 — the speaking micro-motion is a continuous expression layer, and the idle posture is
// not accelerated by it.
// ---------------------------------------------------------------------------------------------

/** Speaking micro-motion probe: idle sway is off, so headY contains ONLY the micro-motion. */
async function runSpeechMicro(style) {
  const fake = createFakeTransport();
  let clock = 0;
  const runtime = await connectRuntime({
    transport: fake.transport,
    now: () => clock,
    config: {
      autoTickMs: 0,
      flushIntervalMs: 1,
      idleActions: [],
      idleSwayScale: 0,
      seed: 3,
      idleParams: { headY: { inputName: 'FaceAngleY', min: -30, max: 30 } },
      style,
    },
  });
  runtime.takeEvents();
  fake.writes.length = 0;
  const spoken = await runtime.speak({ levels: [0.5], stepMs: 100, durationMs: 60_000, startedAt: 0 });
  assert.equal(spoken.ok, true, 'the speech envelope runs for the whole 60 s window');
  let peak = 0;
  let changes = 0;
  let lastSign = 0;
  let maxDelta = 0;
  let boundaryMax = 0;
  let boundariesSent = 0;
  let nextBoundary = 5_000;
  let previous = null;
  for (clock = 0; clock <= 60_000; clock += DT) {
    // A sentence boundary is only a REPORT: if the micro-motion restarted per clip, the value or
    // its slope would jump here. Placing ten of them gives a reset a chance to show up.
    let boundaryTick = false;
    while (clock >= nextBoundary && boundariesSent < 10) {
      runtime.speechClip('start', { index: ++boundariesSent, at: nextBoundary });
      boundaryTick = true;
      nextBoundary += 5_000;
    }
    const pose = runtime.tick(clock);
    if (previous !== null && clock > 1000) {
      const delta = pose.headY - previous;
      maxDelta = Math.max(maxDelta, Math.abs(delta));
      if (Math.abs(delta) > 1e-9) {
        const sign = Math.sign(delta);
        if (sign !== lastSign) changes += 1;
        lastSign = sign;
      }
      if (boundaryTick) boundaryMax = Math.max(boundaryMax, Math.abs(delta));
      peak = Math.max(peak, Math.abs(pose.headY));
    }
    previous = pose.headY;
    await flushMicrotasks();
  }
  const dimensions = runtime.snapshot().style.dimensions;
  runtime.dispose();
  const degrees = (semantic) => semantic * OCCASIONAL_ACTION.DEGREES_PER_POSE_UNIT;
  const seconds = 59;
  return {
    peakDegrees: degrees(peak),
    maxDeltaDegrees: degrees(maxDelta),
    boundaryDeltaDegrees: degrees(boundaryMax),
    changes,
    frequencyHz: changes / (2 * seconds),
    boundariesSent,
    liveliness: dimensions.liveliness,
    writes: fake.writes,
  };
}


test('36. 说话微动：60 s 内 headY 连续 1–2° 起伏，句间不重置，幅度随 liveliness', async () => {
  const quiet = await runSpeechMicro({ amplitude: 0.3, tempo: 0.8, nodAmplitude: 0.3 });
  const lively = await runSpeechMicro({ amplitude: 1.4, tempo: 1.4, nodAmplitude: 1.3, expressiveness: 1.4, tiltChance: 0.4 });

  // 1–2° low-frequency sway, not a per-sentence action: tens of up/down turns in 60 s.
  assert.ok(quiet.changes >= 3, `headY turns up/down at least 3 times in 60 s (${quiet.changes})`);
  assert.ok(quiet.peakDegrees >= 1 && quiet.peakDegrees <= 2,
    `quiet micro-motion peak ${quiet.peakDegrees.toFixed(2)}° is in 1–2°`);
  assert.ok(lively.peakDegrees >= 1 && lively.peakDegrees <= 2,
    `lively micro-motion peak ${lively.peakDegrees.toFixed(2)}° is in 1–2°`);
  assert.ok(lively.peakDegrees > quiet.peakDegrees + 0.2,
    `the amplitude scales with liveliness (${quiet.peakDegrees.toFixed(2)}° < ${lively.peakDegrees.toFixed(2)}°)`);
  // ~0.3–0.7 Hz (the turn count below/above is the low-frequency proof; this pins the band).
  assert.ok(quiet.frequencyHz >= 0.3 && quiet.frequencyHz <= 0.7,
    `quiet micro-motion frequency ${quiet.frequencyHz.toFixed(2)} Hz is in 0.3–0.7 Hz`);
  assert.ok(lively.frequencyHz >= 0.3 && lively.frequencyHz <= 0.7,
    `lively micro-motion frequency ${lively.frequencyHz.toFixed(2)} Hz is in 0.3–0.7 Hz`);
  // Continuity: ten sentence boundaries; a per-clip restart would snap the value by ~1–2° in one
  // frame. The observed per-frame delta stays far below that, boundary frames included.
  assert.ok(quiet.boundariesSent >= 5, `sentence boundaries were reported (${quiet.boundariesSent})`);
  assert.ok(quiet.maxDeltaDegrees <= 0.5,
    `no restart jump at any frame (max per-frame ${quiet.maxDeltaDegrees.toFixed(3)}° ≤ 0.5°)`);
  assert.ok(quiet.boundaryDeltaDegrees <= 0.5,
    `no restart jump at sentence boundaries (${quiet.boundaryDeltaDegrees.toFixed(3)}° ≤ 0.5°)`);
  // Only headY is touched by the micro-motion.
  assert.deepEqual([...new Set(quiet.writes.map((entry) => entry.input))], ['FaceAngleY'],
    'the speaking micro-motion writes headY only');
  console.log(
    `[speech-micro] quiet(l=${quiet.liveliness}) peak=${quiet.peakDegrees.toFixed(2)}°`
    + ` ${quiet.frequencyHz.toFixed(2)}Hz turns=${quiet.changes}`
    + ` boundaryΔ=${quiet.boundaryDeltaDegrees.toFixed(3)}° maxΔ=${quiet.maxDeltaDegrees.toFixed(3)}°`
    + ` lively(l=${lively.liveliness}) peak=${lively.peakDegrees.toFixed(2)}° ${lively.frequencyHz.toFixed(2)}Hz`,
  );
});

test('37. 待机回归：无语音不叠加微动，保持窗口与过渡时长不变', () => {
  // (a) No speech, no idle sway → headY is exactly still: the micro-motion never leaks into idle.
  const still = createBehaviorRuntime({ config: { seed: 5, idleActions: [], idleSwayScale: 0 } });
  let stillMax = 0;
  for (let at = 0; at <= 10_000; at += DT) {
    const pose = still.tick(at);
    stillMax = Math.max(stillMax, Math.abs(pose.headY));
  }
  assert.equal(stillMax, 0, `idle headY stays exactly still without speech (${stillMax})`);

  // (b) The hold window and the idle re-draw transition keep their pre-change bands.
  const idle = createBehaviorRuntime({
    config: {
      seed: 5,
      idleActions: [],
      postureHoldMinMs: 6000,
      postureHoldMaxMs: 6000,
      postureHoldChance: 0,
      postureStillChance: 0,
      decisionHz: 30,
    },
  });
  const transitions = new Map();
  for (let at = 0; at <= 30_000; at += DT) {
    idle.tick(at);
    const last = idle.snapshot().motion.posture.lastTransition;
    if (last !== null && !transitions.has(last.startedAt)) transitions.set(last.startedAt, last);
  }
  const redraws = [...transitions.values()];
  assert.ok(redraws.length >= 2, `the idle posture was re-drawn (${redraws.length} times)`);
  for (const entry of redraws) {
    assert.equal(entry.kind, 'idle', 'an idle re-draw is still an idle transition');
    assert.ok(entry.durationMs >= 1200 && entry.durationMs <= 1800,
      `idle transition ${entry.durationMs} ms is still 1.2–1.8 s`);
  }
  const motion = idle.snapshot().motion;
  assert.equal(motion.holdMs, 6000, `the explicit hold window is unchanged (${Math.round(motion.holdMs)} ms)`);
  console.log(
    `[speech-micro] idleNoSpeech headY=${stillMax}`
    + ` hold=${Math.round(motion.holdMs)}ms`
    + ` transitions=${redraws.map((entry) => Math.round(entry.actualMs)).join('|')}ms`
    + ` band=1200–1800ms`,
  );
});

// ---------------------------------------------------------------------------------------------
// Stage 2–4 continuation — richer, still bounded motion: the channel check, thinking/listening
// expression gestures, the 3–5 s breath cycle, the 20–40 s micro-action and the hard caps.
// ---------------------------------------------------------------------------------------------

/** One fake VTS input row (same shape as InputParameterListRequest). */
const fakeInput = (name, min = -1, max = 1) => ({ name, min, max, defaultValue: 0 });

/** The hiyori model's Live2D parameter names that the channel table reasons about. */
const FAKE_MODEL_PARAMS = [
  'ParamAngleX', 'ParamAngleY', 'ParamAngleZ',
  'ParamEyeLOpen', 'ParamEyeROpen', 'ParamBrowLY', 'ParamBrowRY', 'ParamMouthOpenY',
  'ParamEyeBallX', 'ParamEyeBallY',
  'ParamBodyAngleX', 'ParamBodyAngleY', 'ParamBodyAngleZ', 'ParamBreath',
];

const fakeDiscovery = async (modelId, inputs) => {
  resetCapabilities();
  return discoverCapabilities({
    identity: { modelId, modelGeneration: 1, connectionGeneration: 1 },
    force: true,
    listInputParameters: async () => ({ defaultParameters: inputs, customParameters: [] }),
    listModelParameters: async () => ({
      ok: true,
      source: 'test',
      parameters: FAKE_MODEL_PARAMS.map((name) => ({ name })),
    }),
  });
};

test('38. 通道核对：EyeRightX/Y 存在则 gaze mapped+verified，身体/呼吸仍 skipped', async () => {
  const eyeInputs = [
    fakeInput('FaceAngleX', -30, 30), fakeInput('FaceAngleY', -30, 30), fakeInput('FaceAngleZ', -30, 30),
    fakeInput('EyeOpenLeft', 0, 1), fakeInput('EyeOpenRight', 0, 1),
    fakeInput('BrowLeftY', 0, 1), fakeInput('BrowRightY', 0, 1), fakeInput('MouthOpen', 0, 1),
    fakeInput('EyeRightX'), fakeInput('EyeRightY'),
  ];
  const withEyes = await fakeDiscovery('probe-with-eyes', eyeInputs);
  const gazeX = withEyes.channels.find((entry) => entry.channel === 'gazeX');
  const gazeY = withEyes.channels.find((entry) => entry.channel === 'gazeY');
  const bodyX = withEyes.channels.find((entry) => entry.channel === 'bodyX');
  const breath = withEyes.channels.find((entry) => entry.channel === 'breath');
  assert.equal(gazeX.inputName, 'EyeRightX', 'gazeX maps the VTS default eye-tracking input');
  assert.equal(gazeY.inputName, 'EyeRightY', 'gazeY maps the VTS default eye-tracking input');
  assert.equal(gazeX.injectable, true);
  assert.equal(gazeX.verified, true, 'EyeRightX + ParamEyeBallX verifies the channel');
  assert.ok(withEyes.mapped.includes('gazeX') && withEyes.mapped.includes('gazeY'));
  assert.ok(withEyes.verified.includes('gazeX') && withEyes.verified.includes('gazeY'));
  // The MODEL has ParamBodyAngleX / ParamBodyAngleY / ParamBodyAngleZ / ParamBreath, but VTS exposes
  // no injectable input for them: the parameter existing is not a mapping. Nothing is invented.
  assert.equal(bodyX.injectable, false, 'bodyX stays unmapped (no BodyAngleX input)');
  assert.ok(bodyX.modelParams.includes('ParamBodyAngleX'), 'the model parameter itself does exist');
  assert.equal(breath.injectable, false, 'breath stays unmapped (no Breath input)');
  assert.ok(breath.modelParams.includes('ParamBreath'));
  assert.ok(withEyes.unmapped.includes('bodyX') && withEyes.unmapped.includes('breath'));
  assert.ok(CHANNEL_ORDER.includes('bodyY') && CHANNEL_ORDER.includes('bodyZ'),
    'bodyY/bodyZ are in the generic channel catalog');
  assert.ok(withEyes.unmapped.includes('bodyY') && withEyes.unmapped.includes('bodyZ'),
    'this fake pool has no BodyAngleY/Z input, so both stay unmapped instead of being invented');

  const withoutEyes = await fakeDiscovery('probe-without-eyes',
    eyeInputs.filter((entry) => !/^Eye(Right|Left)[XY]$/u.test(entry.name)));
  assert.equal(withoutEyes.mapped.includes('gazeX'), false, 'without the input, gazeX is skipped');
  assert.equal(withoutEyes.unmapped.includes('gazeX'), true);
  assert.equal(withoutEyes.unmapped.includes('gazeY'), true);

  // The mapped channel is really written: a thinking gesture drives EyeRightY (gaze up), and no
  // body/breath input is ever guessed.
  const fake = createFakeTransport();
  let clock = 0;
  const runtime = await connectRuntime({
    transport: fake.transport,
    now: () => clock,
    config: motionConfig(),
  });
  await runtime.setChannelMappings(withEyes.channels, { channelMap: {} });
  fake.writes.length = 0;
  clock = 100;
  runtime.intentEvent('thinking', { at: 100 });
  for (clock = 100; clock <= 900; clock += 20) {
    runtime.tick(clock);
    await flushMicrotasks();
  }
  const eyeWrites = fake.writes.filter((entry) => entry.input === 'EyeRightY' || entry.input === 'EyeRightX');
  assert.ok(eyeWrites.length > 0, `the mapped gaze input was written (${eyeWrites.length})`);
  assert.ok(eyeWrites.some((entry) => Math.abs(entry.value) > 0.02),
    'the thinking gaze-up is a real, non-zero value');
  assert.deepEqual(fake.writes.filter((entry) => /BodyAngle|^Breath$/iu.test(entry.input)), [],
    'no unmapped body/breath input was ever written');
  const channels = runtime.snapshot().channels;
  assert.ok(channels.controlled.includes('gazeX') && channels.controlled.includes('gazeY'));
  for (const channel of ['bodyX', 'bodyY', 'bodyZ', 'breath']) {
    assert.ok(channels.skipped.includes(channel), `${channel} is reported skipped, not controlled`);
  }
  console.log(
    `[channels] mapped=${withEyes.mapped.join(',')}`
    + ` unmapped=${withEyes.unmapped.join(',')}`
    + ` eyeWrites=${eyeWrites.length} max=${Math.max(...eyeWrites.map((entry) => Math.abs(entry.value))).toFixed(3)}`
    + ` skippedRuntime=${channels.skipped.join(',')}`,
  );
  runtime.dispose();
});

test('39. thinking：视线轻微上移 + 眉毛微动，0.4–1.2 s 后回到基线', () => {
  const runtime = createBehaviorRuntime({ config: { seed: 7, idleActions: [] } });
  runtime.tick(0);
  runtime.tick(DT);
  const started = runtime.expression('thinking', 66);
  assert.ok(started, 'the thinking expression starts');
  assert.equal(started.durationMs, EXPRESSION_MOTION.THINKING_MS);
  assert.ok(started.durationMs >= 400 && started.durationMs <= 1200,
    `thinking lasts ${started.durationMs} ms (0.4–1.2 s)`);
  assert.deepEqual(started.channels, ['gazeY', 'browL', 'browR'], 'gaze + both brows only');

  let peakGazeY = 0;
  let peakBrowL = 0;
  let peakBrowR = 0;
  let visibleAt = null;
  for (let at = 66; at <= 66 + 1200; at += DT) {
    const pose = runtime.tick(at);
    peakGazeY = Math.max(peakGazeY, pose.gazeY);
    peakBrowL = Math.max(peakBrowL, pose.browL);
    peakBrowR = Math.max(peakBrowR, pose.browR);
    if (visibleAt === null && pose.gazeY > 0.01 && pose.browL > 0.01) visibleAt = at - 66;
  }
  assert.ok(visibleAt !== null && visibleAt <= 1200, 'the gaze/brow gesture is visible inside its window');
  assert.ok(peakGazeY >= 0.05 && peakGazeY <= EXPRESSION_MOTION.MAX_GAZE,
    `gazeY peak ${peakGazeY.toFixed(4)} is in 0.05..0.7`);
  assert.ok(peakBrowL >= 0.1 && peakBrowL <= 0.4, `browL peak ${peakBrowL.toFixed(3)} is a micro-move`);
  assert.ok(peakBrowR >= 0.05 && peakBrowR <= 0.4, `browR peak ${peakBrowR.toFixed(3)} is a micro-move`);
  // After the 0.9 s window the pose returns to the neutral baseline (no permanent offset).
  runtime.tick(66 + 1600);
  const after = runtime.tick(66 + 2400);
  assert.ok(Math.abs(after.gazeY) < 0.03, `gazeY returned to baseline (${after.gazeY.toFixed(4)})`);
  assert.ok(Math.abs(after.browL) < 0.01 && Math.abs(after.browR) < 0.01,
    `brows returned to baseline (${after.browL.toFixed(4)}/${after.browR.toFixed(4)})`);
  const events = runtime.takeEvents().filter((entry) => entry.type === 'avatar.expression.start');
  assert.ok(events.some((entry) => entry.kind === 'thinking'), 'avatar.expression.start records it');
  console.log(
    `[thinking] duration=${started.durationMs}ms visibleAt=${visibleAt}ms`
    + ` gazeY=${peakGazeY.toFixed(4)} browL=${peakBrowL.toFixed(3)} browR=${peakBrowR.toFixed(3)}`
    + ` after(gazeY=${after.gazeY.toFixed(4)})`,
  );
});

test('40. 呼吸：待机与说话都是 3–5 s 慢周期，且不与说话微动互相覆盖', () => {
  assert.equal(TIMING.BREATH_PERIOD_MIN_MS, 3000, 'the low bound is 3 s');
  assert.equal(TIMING.BREATH_PERIOD_MAX_MS, 5000, 'the high bound is 5 s');
  const measure = (speaking) => {
    const runtime = createBehaviorRuntime({ config: { seed: 4, idleActions: [] } });
    if (speaking) {
      const session = runtime.startSpeech({
        text: 'あいうえおかきくけこさしすせそたちつてとなにぬねの',
        durationMs: 30_000,
        startedAt: 0,
      });
      assert.equal(session.ok, true);
    }
    const crossings = [];
    const headY = [];
    let previous = null;
    for (let at = 0; at <= 24_000; at += 20) {
      const pose = runtime.tick(at);
      headY.push(pose.headY);
      if (previous !== null && previous < 0.5 && pose.breath >= 0.5) crossings.push(at);
      previous = pose.breath;
    }
    const periods = crossings.slice(1).map((at, index) => at - crossings[index]);
    return { periods, headRange: Math.max(...headY) - Math.min(...headY) };
  };

  const idle = measure(false);
  const speaking = measure(true);
  assert.ok(idle.periods.length >= 5, `idle breath cycled (${idle.periods.length} periods)`);
  assert.ok(speaking.periods.length >= 6, `speaking breath cycled (${speaking.periods.length} periods)`);
  for (const period of idle.periods) {
    assert.ok(period >= 3000 && period <= 5000, `idle period ${period} ms is 3–5 s`);
  }
  for (const period of speaking.periods) {
    assert.ok(period >= 3000 && period <= 5000, `speaking period ${period} ms is 3–5 s`);
  }
  // Speaking keeps a slow breath AND the 1–2° pitch micro-motion: separate channels, both present.
  assert.ok(speaking.headRange > 0.01, `speech micro-motion kept its pitch sway (${speaking.headRange.toFixed(4)})`);
  assert.ok(BREATH.SPEAKING_SPEED > 1 && BREATH.SPEAKING_SPEED <= 1.1,
    'speaking shortens the cycle by at most 1.1×');
  console.log(
    `[breath] idle=${idle.periods.join('|')}ms speaking=${speaking.periods.join('|')}ms`
    + ` speechHeadRange=${speaking.headRange.toFixed(4)} speed=${BREATH.SPEAKING_SPEED}`,
  );
});

test('41. 偶发小动作：20–40 s 一次，幅度低于头部 14° / 眼睛 0.7 / 身体 10°', () => {
  const runtime = createBehaviorRuntime({ config: { seed: 9, idleActions: [] } });
  let firstAt = null;
  let firstKind = '';
  let firstChannels = [];
  const peaks = { headX: 0, headY: 0, headZ: 0, gazeX: 0, gazeY: 0, bodyX: 0, bodyY: 0, bodyZ: 0 };
  for (let at = 0; at <= 46_000; at += DT) {
    const pose = runtime.tick(at);
    for (const channel of Object.keys(peaks)) peaks[channel] = Math.max(peaks[channel], Math.abs(pose[channel]));
    if (firstAt === null) {
      const snapshot = runtime.snapshot().motion.expressions;
      if (snapshot.occasional.starts > 0) {
        firstAt = at;
        firstKind = snapshot.occasional.lastKind;
        firstChannels = snapshot.active[0]?.channels ?? [];
      }
    }
  }
  assert.ok(firstAt !== null, 'an occasional micro-action ran inside 46 s');
  assert.ok(firstAt >= EXPRESSION_MOTION.OCCASIONAL_MIN_MS && firstAt <= EXPRESSION_MOTION.OCCASIONAL_MAX_MS,
    `the first micro-action started at ${firstAt} ms (20–40 s)`);
  assert.ok(['glance', 'weight-shift'].includes(firstKind), `kind ${firstKind}`);
  assert.deepEqual(firstChannels.slice().sort(),
    firstKind === 'glance' ? ['gazeX'] : ['bodyX', 'headZ'],
    'the micro-action only touches its own small channel set');
  assert.ok(peaks.headX * OCCASIONAL_ACTION.DEGREES_PER_POSE_UNIT <= EXPRESSION_MOTION.MAX_HEAD_DEGREES,
    `headX ${(peaks.headX * 30).toFixed(2)}° ≤ 14°`);
  assert.ok(peaks.headY * OCCASIONAL_ACTION.DEGREES_PER_POSE_UNIT <= EXPRESSION_MOTION.MAX_HEAD_DEGREES,
    `headY ${(peaks.headY * 30).toFixed(2)}° ≤ 14°`);
  assert.ok(peaks.headZ * OCCASIONAL_ACTION.DEGREES_PER_POSE_UNIT <= EXPRESSION_MOTION.MAX_HEAD_DEGREES,
    `headZ ${(peaks.headZ * 30).toFixed(2)}° ≤ 14°`);
  assert.ok(peaks.bodyX * OCCASIONAL_ACTION.DEGREES_PER_POSE_UNIT <= EXPRESSION_MOTION.MAX_BODY_DEGREES,
    `bodyX ${(peaks.bodyX * 30).toFixed(2)}° ≤ 10°`);
  assert.ok(peaks.gazeX <= EXPRESSION_MOTION.MAX_GAZE && peaks.gazeY <= EXPRESSION_MOTION.MAX_GAZE,
    `gaze ${peaks.gazeX.toFixed(3)}/${peaks.gazeY.toFixed(3)} ≤ 0.7`);
  const schedule = runtime.snapshot().motion.expressions.occasional;
  assert.ok(schedule.nextAt - schedule.lastAt >= EXPRESSION_MOTION.OCCASIONAL_MIN_MS
    && schedule.nextAt - schedule.lastAt <= EXPRESSION_MOTION.OCCASIONAL_MAX_MS,
  `the next slot is ${Math.round(schedule.nextAt - schedule.lastAt)} ms away`);
  console.log(
    `[occasional] firstAt=${firstAt}ms kind=${firstKind} channels=${firstChannels.join('|')}`
    + ` peaks(headX=${(peaks.headX * 30).toFixed(2)}°,headZ=${(peaks.headZ * 30).toFixed(2)}°,`
    + `bodyX=${(peaks.bodyX * 30).toFixed(2)}°,gazeX=${peaks.gazeX.toFixed(3)})`
    + ` next=${Math.round(schedule.nextAt - schedule.lastAt)}ms`,
  );
});

test('42. 约束回归：幅度上限、保持/过渡时长不变；结论停顿与单侧眉不越界', () => {
  // A: the hold window and the planned transition are untouched.
  assert.equal(POSTURE_TRANSITION.MIN_MS, 1200);
  assert.equal(POSTURE_TRANSITION.MAX_MS, 1800);
  assert.equal(POSTURE_TRANSITION.BASE_MS, 1500);
  assert.equal(POSTURE_HOLD_MIN_MS, 10_000);
  assert.equal(POSTURE_HOLD_MAX_MS, 20_000);
  assert.deepEqual({ ...POSTURE_HOLD_ALLOCATION.lively }, { MIN_MS: 4_000, MAX_MS: 8_000 });
  // C: the motion budget, unchanged and stated once.
  assert.equal(EXPRESSION_MOTION.MAX_HEAD_DEGREES, 14);
  assert.equal(EXPRESSION_MOTION.MAX_GAZE, 0.7);
  assert.equal(EXPRESSION_MOTION.MAX_BODY_DEGREES, 10);
  assert.equal(OCCASIONAL_ACTION.MAX_DEGREES, 14);

  const lively = {
    amplitude: 1.4, tempo: 1.5, nodAmplitude: 1.3, expressiveness: 1.4, nodDurationMs: 350,
  };
  // Conclusion: the same nod plus ONE marked affirmation hold (a plateau, not a bigger sinus).
  const conclusion = createBehaviorRuntime({
    config: { seed: 3, idleActions: [], idleSwayScale: 0, style: lively },
  });
  conclusion.tick(1000);
  const info = conclusion.intent('nod', { at: 1000, profile: 'conclusion' });
  assert.equal(info.ok, true);
  const samples = [];
  for (let elapsed = 33; elapsed <= info.durationMs; elapsed += 33) {
    samples.push(Math.abs(conclusion.tick(1000 + elapsed).headY));
  }
  const peak = Math.max(...samples);
  let run = 0;
  let longestHold = 0;
  for (const value of samples) {
    if (value >= peak * 0.9) {
      run += 33;
      longestHold = Math.max(longestHold, run);
    } else {
      run = 0;
    }
  }
  assert.ok(peak * 30 <= OCCASIONAL_ACTION.MAX_DEGREES,
    `the posed conclusion nod stays at ${(peak * 30).toFixed(2)}° ≤ 14°`);
  assert.ok(info.peakDegrees >= OCCASIONAL_ACTION.MIN_DEGREES
    && info.peakDegrees <= OCCASIONAL_ACTION.MAX_DEGREES,
  `the conclusion nod reports ${info.peakDegrees}° (12–14° band)`);
  assert.ok(longestHold >= 120,
    `the conclusion holds its affirmation for ${longestHold} ms (a visible pause)`);

  // Confused: the head tilt plus a SINGLE raised brow (the other side slightly down).
  const confused = createBehaviorRuntime({
    config: { seed: 3, idleActions: [], idleSwayScale: 0, style: lively },
  });
  confused.tick(1000);
  const tilt = confused.intent('tilt', { at: 1000, profile: 'confused' });
  assert.ok(tilt.channels.includes('browL') && tilt.channels.includes('browR'));
  let browUp = 0;
  let browDown = 0;
  let headPeak = 0;
  for (let elapsed = 33; elapsed <= tilt.durationMs; elapsed += 33) {
    const pose = confused.tick(1000 + elapsed);
    browUp = Math.max(browUp, pose.browL);
    browDown = Math.min(browDown, pose.browR);
    headPeak = Math.max(headPeak, Math.abs(pose.headX), Math.abs(pose.headZ));
  }
  assert.ok(browUp > 0.1, `one brow is visibly raised (${browUp.toFixed(3)})`);
  assert.ok(browDown < -0.02, `the other brow is slightly lowered (${browDown.toFixed(3)})`);
  assert.ok(headPeak * 30 <= OCCASIONAL_ACTION.MAX_DEGREES,
    `the confused head stays at ${(headPeak * 30).toFixed(2)}° ≤ 14°`);
  console.log(
    `[constraints] conclusionPeak=${(peak * 30).toFixed(2)}° hold=${longestHold}ms`
    + ` confusedBrowUp=${browUp.toFixed(3)} browDown=${browDown.toFixed(3)}`
    + ` head=${(headPeak * 30).toFixed(2)}° caps=14°/0.7/10°`,
  );
});

test('43. 回归：actionTrace 反映 gaze 新通道，status.channels 是实际 mapped 列表', async () => {
  const fake = createFakeTransport();
  let clock = 0;
  const runtime = await connectRuntime({
    transport: fake.transport,
    now: () => clock,
    config: motionConfig(),
  });
  const discovery = await fakeDiscovery('trace-model', [
    fakeInput('FaceAngleX', -30, 30), fakeInput('FaceAngleY', -30, 30), fakeInput('FaceAngleZ', -30, 30),
    fakeInput('EyeOpenLeft', 0, 1), fakeInput('EyeOpenRight', 0, 1),
    fakeInput('BrowLeftY', 0, 1), fakeInput('BrowRightY', 0, 1), fakeInput('MouthOpen', 0, 1),
    fakeInput('EyeRightX'), fakeInput('EyeRightY'),
  ]);
  await runtime.setChannelMappings(discovery.channels, { channelMap: {} });
  runtime.setAttention({ x: 0.4, y: 0.2 }, { verified: true, source: 'test' });
  fake.writes.length = 0;
  clock = 100;
  const released = runtime.intentEvent('turn-start', { at: 100 });
  assert.equal(released.ok, true);
  assert.equal(released.released, true, 'turn-start releases the lookAtUser gesture');
  for (clock = 100; clock <= 2000; clock += 20) {
    runtime.tick(clock);
    await flushMicrotasks();
  }
  const snapshot = runtime.snapshot();
  const trace = snapshot.motion.actionTrace.find((entry) => entry.actionId === released.actionId);
  assert.ok(trace, 'the ended lookAtUser action emitted a trace');
  assert.ok(trace.channels.includes('gazeX') && trace.channels.includes('gazeY'),
    `the trace names the new gaze channels (${trace.channels.join('|')})`);
  assert.ok(Math.abs(trace.final.gazeX) > 0.05,
    `the trace final keeps the reached gaze value (${Number(trace.final.gazeX).toFixed(3)})`);
  assert.ok(snapshot.channels.controlled.includes('gazeX') && snapshot.channels.controlled.includes('gazeY'),
    'the controlled list is the real mapped+verified set');
  assert.deepEqual(snapshot.channels.skipped.slice().sort(), ['bodyX', 'bodyY', 'bodyZ', 'breath'],
    'everything without an injectable input stays skipped');
  console.log(
    `[trace] channels=${trace.channels.join('|')} final.gazeX=${Number(trace.final.gazeX).toFixed(3)}`
    + ` controlled=${snapshot.channels.controlled.join(',')}`
    + ` skipped=${snapshot.channels.skipped.join(',')}`,
  );
  runtime.dispose();
});

// ---------------------------------------------------------------------------------------------
// Stage 6 — expression RELEASE. An expression drives channels the idle frame does not own, so
// dropping them the instant its envelope ends leaves the last non-zero value on the VTS input:
// the model keeps the "thinking" gaze forever. The channel now stays a write channel until the
// pose is provably back at the baseline (or the 400 ms window forces exactly one 0 and frees it);
// a channel a new expression/intent takes over is handed off directly.
// ---------------------------------------------------------------------------------------------

/** Motion transport that timestamps every sent frame with the simulated clock. */
function createTimedMotionTransport() {
  const frames = [];
  const clock = { at: 0 };
  const transport = {
    connect: async () => {},
    disconnect: async () => {},
    write: async () => ({ ok: true }),
    writeFrame: async (entries) => {
      frames.push({ at: clock.at, entries });
      return { ok: true };
    },
    writeMotion: async (payload) => {
      frames.push({ at: clock.at, entries: payload.entries ?? [] });
      return { ok: true };
    },
  };
  return { frames, clock, transport };
}

/** The same injectable inputs the other avatar tests use (gaze/brows/head/eyes, no body/breath). */
const releaseInputs = () => [
  fakeInput('FaceAngleX', -30, 30), fakeInput('FaceAngleY', -30, 30), fakeInput('FaceAngleZ', -30, 30),
  fakeInput('EyeOpenLeft', 0, 1), fakeInput('EyeOpenRight', 0, 1),
  fakeInput('BrowLeftY', 0, 1), fakeInput('BrowRightY', 0, 1), fakeInput('MouthOpen', 0, 1),
  fakeInput('EyeRightX'), fakeInput('EyeRightY'),
];

/** 30 Hz motion writer on a still idle pose, so every gaze write is the expression's own. */
const releaseConfig = (extra = {}) => ({
  autoTickMs: 0,
  flushIntervalMs: 1,
  idleActions: [],
  idleSwayScale: 0,
  // Expression RELEASE is measured against the idle baseline: keep the phase-3 gaze component out
  // of this suite so its own held gaze cannot mask a missing release. The component is covered by
  // test/motion-multi-component.mjs.
  componentGazeEnabled: false,
  idleParams: {
    headX: { inputName: 'FaceAngleX', min: -30, max: 30 },
    headY: { inputName: 'FaceAngleY', min: -30, max: 30 },
    headZ: { inputName: 'FaceAngleZ', min: -30, max: 30 },
  },
  motionWrites: true,
  motionOutputHz: 30,
  ...extra,
});

/** Connected runtime whose every sent row is timestamped; `rows(channel)` reads one channel. */
const setupReleaseRuntime = async (extra = {}) => {
  const modelId = `release-model-${Object.keys(extra).sort().join('-') || 'base'}`;
  const channels = await fakeDiscovery(modelId, releaseInputs());
  const timed = createTimedMotionTransport();
  const runtime = await connectRuntime({
    transport: timed.transport,
    now: () => timed.clock.at,
    config: releaseConfig(extra),
  });
  await runtime.setChannelMappings(channels.channels, { channelMap: {} });
  timed.frames.length = 0;
  return {
    runtime,
    timed,
    tick: async (at) => {
      timed.clock.at = at;
      runtime.tick(at);
      await flushMicrotasks();
    },
    rows: (channel) => timed.frames.flatMap((frame) => frame.entries
      .filter((entry) => entry.channel === channel)
      .map((entry) => ({ at: frame.at, input: entry.input, value: entry.value }))),
  };
};

test('44. 表情结束后保留通道：gazeY 400 ms 内回位写入并释放（不再残留姿态）', async () => {
  const { runtime, rows, tick } = await setupReleaseRuntime();
  await tick(100);
  runtime.intentEvent('thinking', { at: 100 });
  for (let at = 140; at <= 2200; at += 40) await tick(at);

  const end = 100 + EXPRESSION_MOTION.THINKING_MS; // 1000 ms: the envelope reaches 0 here
  const gaze = rows('gazeY');
  assert.ok(gaze.length > 20, `the thinking gaze really writes (${gaze.length} rows)`);
  assert.ok(gaze.some((row) => row.value > 0.05), 'the gesture itself is visible');
  // The counterexample: 30 Hz path used to write gazeY only until the envelope ended (≈880 ms).
  const after = gaze.filter((row) => row.at > end);
  assert.ok(after.length >= 3, `the channel keeps writing after the end (${after.length} rows)`);
  const back = after.find((row) => Math.abs(row.value) <= EXPRESSION_RELEASE.BASELINE_EPSILON);
  assert.ok(back, 'a return-to-baseline write happens after the expression ended');
  assert.ok(back.at - end <= EXPRESSION_RELEASE.MAX_HOLD_MS,
    `the returning write lands at ${back.at} (end+${back.at - end} ms ≤ ${EXPRESSION_RELEASE.MAX_HOLD_MS})`);
  const last = gaze[gaze.length - 1];
  assert.ok(Math.abs(last.value) <= EXPRESSION_RELEASE.BASELINE_EPSILON,
    `the last written value is the baseline (${last.value.toFixed(4)})`);

  const releases = runtime.takeEvents().filter((entry) => entry.type === 'avatar.expression.release');
  const released = releases.find((entry) => entry.channel === 'gazeY');
  assert.ok(released, 'avatar.expression.release records the gazeY release');
  assert.equal(released.atMs, end, 'the release window starts at the expression end');
  assert.equal(released.settled, true, 'it settled on the baseline, not on the timeout');
  assert.ok(released.at - end <= EXPRESSION_RELEASE.MAX_HOLD_MS,
    `released at end+${released.at - end} ms (≤ ${EXPRESSION_RELEASE.MAX_HOLD_MS})`);
  assert.equal(gaze.filter((row) => row.at > released.at).length, 0,
    'the channel is really free after the release');
  assert.deepEqual(runtime.snapshot().motion.expressions.releasing, [],
    'no channel stays reserved in the steady state');
  console.log(
    `[release] end=${end}ms backWrite=${back.at}(+${back.at - end}ms,${back.value.toFixed(4)})`
    + ` lastWrite=${last.at}(+${last.at - end}ms,${last.value.toFixed(4)}) releasedAt=${released.at}`,
  );
  runtime.dispose();

  // The bug existed on the OLD 4 Hz idle writer too (it released the channel and relied on VTS to
  // "pick up" the pose). It now ends on an explicit 0 as well; the 4 Hz cadence means the forced
  // write lands on the first flush at/after the 400 ms deadline, at most one idle frame later.
  const legacy = await setupReleaseRuntime({ motionWrites: false, idleWriteHz: 4 });
  await legacy.tick(100);
  legacy.runtime.intentEvent('thinking', { at: 100 });
  for (let at = 140; at <= 2400; at += 20) await legacy.tick(at);
  const legacyAfter = legacy.rows('gazeY').filter((row) => row.at > end);
  const legacyLast = legacyAfter[legacyAfter.length - 1];
  assert.ok(legacyAfter.length >= 2, `the legacy writer keeps gazeY in the frame (${legacyAfter.length} writes)`);
  assert.equal(legacyLast.value, 0, 'the legacy writer ends on an explicit 0 (no residual pose)');
  assert.ok(legacyLast.at - end <= EXPRESSION_RELEASE.MAX_HOLD_MS + 250,
    `delivered at end+${legacyLast.at - end} ms (≤ 400 ms + one 4 Hz frame)`);
  const legacyRelease = legacy.runtime.takeEvents()
    .filter((entry) => entry.type === 'avatar.expression.release')
    .find((entry) => entry.channel === 'gazeY');
  assert.ok(legacyRelease, 'the legacy path records the release as well');
  assert.equal(legacyRelease.atMs, end);
  assert.equal(legacy.rows('gazeY').filter((row) => row.at > legacyLast.at).length, 0,
    'the legacy channel is free after its final 0');
  console.log(
    `[release-4hz] writes=${legacyAfter.length} last=${legacyLast.at}(+${legacyLast.at - end}ms,${legacyLast.value})`
    + ` settled=${legacyRelease.settled}`,
  );
  legacy.runtime.dispose();
});

test('45. 回位期间新表情接管同一通道：直接交接，无先归零再抬起', async () => {
  const { runtime, rows, tick } = await setupReleaseRuntime();
  await tick(100);
  runtime.intentEvent('thinking', { at: 100 });
  for (let at = 140; at <= 1100; at += 40) await tick(at);
  const inside = runtime.snapshot().motion.expressions.releasing;
  assert.ok(inside.some((entry) => entry.channel === 'gazeY'),
    'the gazeY release is still running when the new expression starts');

  const takeoverAt = 1100;
  runtime.intentEvent('thinking', { at: takeoverAt }); // same channel, second gesture
  for (let at = 1140; at <= 2400; at += 40) await tick(at);

  const gaze = rows('gazeY').filter((row) => row.at >= takeoverAt);
  assert.ok(gaze.length > 10, `the channel is written continuously through the takeover (${gaze.length})`);
  const secondEnd = takeoverAt + EXPRESSION_MOTION.THINKING_MS;
  const during = gaze.filter((row) => row.at <= secondEnd);
  const min = Math.min(...during.map((row) => row.value));
  // The signature of the bug would be a zeroed write followed by a new rise: never here.
  assert.ok(min > EXPRESSION_RELEASE.BASELINE_EPSILON,
    `no zeroed/dipped write after the takeover (min ${min.toFixed(4)} > ${EXPRESSION_RELEASE.BASELINE_EPSILON})`);
  const peakIndex = during.reduce((best, row, index) => (row.value > during[best].value ? index : best), 0);
  for (let index = 1; index <= peakIndex; index += 1) {
    assert.ok(during[index].value >= during[index - 1].value - 0.001,
      `the handed-over channel rises monotonically (${during[index - 1].value.toFixed(4)} → ${during[index].value.toFixed(4)})`);
  }
  // The second gesture's own release still settles afterwards (the handoff did not skip it).
  assert.ok(gaze.some((row) => row.at > secondEnd && Math.abs(row.value) <= EXPRESSION_RELEASE.BASELINE_EPSILON),
    'the new gesture releases its own channel after its end');

  const releases = runtime.takeEvents().filter((entry) => entry.type === 'avatar.expression.release');
  const gazeEvents = releases.filter((entry) => entry.channel === 'gazeY');
  assert.equal(gazeEvents.length, 1,
    'the old release was handed off, so only the NEW expression releases gazeY');
  assert.equal(gazeEvents[0].atMs, takeoverAt + EXPRESSION_MOTION.THINKING_MS,
    'and it releases at the NEW expression end, never at the old one');
  assert.equal(gazeEvents[0].settled, true);
  assert.equal(gazeEvents.some((entry) => entry.settled === 'timeout'), false,
    'no forced 0 ever landed inside the new gesture');
  console.log(
    `[takeover] at=${takeoverAt}ms releaseRunning=1 min=${min.toFixed(4)} peak=${during[peakIndex].at}`
    + `(${during[peakIndex].value.toFixed(4)}) releaseAtMs=${gazeEvents[0].atMs} settled=${gazeEvents[0].settled}`,
  );
  runtime.dispose();
});

test('46. 兜底：平滑极慢导致回位超时 → 400 ms 到期强制写 0 并释放', async () => {
  // gazeFollowMs = 500 keeps gazeY high for far longer than the release window.
  const { runtime, rows, tick } = await setupReleaseRuntime({ gazeFollowMs: 500 });
  await tick(100);
  runtime.intentEvent('thinking', { at: 100 });
  for (let at = 140; at <= 2000; at += 40) await tick(at);

  const end = 100 + EXPRESSION_MOTION.THINKING_MS;
  const after = rows('gazeY').filter((row) => row.at > end);
  const forced = after.find((row) => row.value === 0);
  assert.ok(forced, 'the timeout wrote exactly one 0');
  assert.ok(forced.at - end >= EXPRESSION_RELEASE.MAX_HOLD_MS,
    `the force waits for the deadline (end+${forced.at - end} ms)`);
  const frame = 1000 / 30;
  assert.ok(forced.at - end <= EXPRESSION_RELEASE.MAX_HOLD_MS + 2 * frame,
    `it is delivered on the first output frame at/after 400 ms (end+${forced.at - end} ms)`);
  const before = after.filter((row) => row.at < forced.at);
  assert.ok(before.every((row) => Math.abs(row.value) > EXPRESSION_RELEASE.BASELINE_EPSILON),
    'the pose had NOT returned by the deadline (this really is the slow case)');

  const releases = runtime.takeEvents().filter((entry) => entry.type === 'avatar.expression.release');
  const released = releases.find((entry) => entry.channel === 'gazeY');
  assert.ok(released, 'the timeout is recorded');
  assert.equal(released.settled, 'timeout');
  assert.equal(released.forced, true);
  assert.equal(after.filter((row) => row.at > forced.at).length, 0,
    'nothing is written after the forced 0 (the channel is released)');
  assert.deepEqual(runtime.snapshot().motion.expressions.releasing, []);
  console.log(
    `[timeout] end=${end}ms forcedZeroAt=${forced.at}(+${forced.at - end}ms)`
    + ` lastBefore=${before[before.length - 1].value.toFixed(4)} settled=${released.settled}`,
  );
  runtime.dispose();
});

test('47. 只影响表情层：说话 headY 微动照常，眉回位后释放', async () => {
  const { runtime, rows, tick } = await setupReleaseRuntime();
  await tick(0);
  const started = await runtime.speak({
    text: 'あいうえおかきくけこさしすせそたちつてとなにぬねの',
    durationMs: 6000,
    startedAt: 0,
    owner: 'speech',
  });
  assert.equal(started.ok, true);
  await tick(100);
  runtime.intentEvent('thinking', { at: 100 });
  for (let at = 140; at <= 2000; at += 40) await tick(at);
  const end = 100 + EXPRESSION_MOTION.THINKING_MS;

  // headY is the speaking pitch micro-motion: the release must never touch or zero it.
  const headY = rows('headY').filter((row) => row.at >= end);
  assert.ok(headY.length >= 20, `headY keeps its normal cadence after the expression (${headY.length} rows)`);
  const semantic = headY.map((row) => Math.abs(row.value) / 30); // FaceAngleY range is ±30
  assert.ok(Math.max(...semantic) > 0.002,
    `the speaking micro-motion is unchanged (${Math.max(...semantic).toFixed(4)} semantic)`);
  assert.equal(runtime.snapshot().motion.expressions.releasing
    .some((entry) => entry.channel === 'headY'), false, 'headY is never a release channel');
  const brows = rows('browL');
  assert.ok(brows.some((row) => Math.abs(row.value) > 0.05), 'the expression brow really moved');
  const releases = runtime.takeEvents().filter((entry) => entry.type === 'avatar.expression.release');
  for (const channel of ['browL', 'browR']) {
    const released = releases.find((entry) => entry.channel === channel);
    assert.ok(released, `${channel} is released like gazeY`);
    assert.equal(released.settled, true);
    assert.equal(rows(channel).filter((row) => row.at > released.at).length, 0,
      `${channel} stops being written after its release`);
  }
  console.log(
    `[other-channels] headYRows=${headY.length} headYpeak=${Math.max(...semantic).toFixed(4)}`
    + ` browReleaseMs=${releases.filter((entry) => entry.channel === 'browL')[0].at - end}`
    + ` headYReleasing=0`,
  );
  runtime.dispose();
});

// ---------------------------------------------------------------------------------------------
// 48. sender evidence does not depend on a preset: prepared / attempted / committed / failed /
//     stale stay separated on BOTH write paths (30 Hz pump and the legacy idle flush).
// ---------------------------------------------------------------------------------------------
test('48. 发送层证据不依赖预设：ok:false/异常不记 committed，成功才记，作废记 stale', async () => {
  const transportStatus = (runtime) => runtime.snapshot().motion.transport;

  // (a) 30 Hz continuous path, every send rejected with ok:false.
  let clock = 0;
  const rejected = [];
  const rejecting = {
    connect: async () => {},
    disconnect: async () => {},
    write: () => ({ ok: true }),
    writeMotion: (payload) => {
      rejected.push(payload.entries.map((entry) => ({ ...entry })));
      return { ok: false, code: 'VTS_REJECTED', reason: 'rejected' };
    },
  };
  const rejectedRuntime = await connectRuntime({
    transport: rejecting,
    now: () => clock,
    config: motionConfig({ motionWrites: true, motionOutputHz: 30, seed: 3 }),
  });
  for (let index = 0; index < 6; index += 1) {
    clock = index * DT;
    rejectedRuntime.tick(clock);
    await flushMicrotasks();
  }
  const rejectedStatus = transportStatus(rejectedRuntime);
  assert.equal(rejectedStatus.attempted, rejected.length);
  assert.equal(rejectedStatus.failed, rejected.length, 'every ok:false send is failed');
  assert.equal(rejectedStatus.committed, 0, 'a rejected send never becomes a commit');
  assert.equal(rejectedStatus.committedRows, 0);
  assert.ok(rejectedStatus.prepared >= rejectedStatus.attempted);
  assert.equal(rejectedStatus.lastErrorCode, 'VTS_REJECTED');
  rejectedRuntime.dispose();

  // (b) the same path with ok:true: every acknowledged send is one commit.
  let okClock = 0;
  const accepted = [];
  const accepting = {
    connect: async () => {},
    disconnect: async () => {},
    write: () => ({ ok: true }),
    writeMotion: (payload) => {
      accepted.push(payload.entries.map((entry) => ({ ...entry })));
      return { ok: true };
    },
  };
  const acceptedRuntime = await connectRuntime({
    transport: accepting,
    now: () => okClock,
    config: motionConfig({ motionWrites: true, motionOutputHz: 30, seed: 5 }),
  });
  for (let index = 0; index < 6; index += 1) {
    okClock = index * DT;
    acceptedRuntime.tick(okClock);
    await flushMicrotasks();
  }
  const acceptedStatus = transportStatus(acceptedRuntime);
  assert.equal(acceptedStatus.attempted, accepted.length);
  assert.equal(acceptedStatus.committed, accepted.length, 'one commit per ok:true send');
  assert.equal(acceptedStatus.failed, 0);
  assert.ok(Number.isFinite(acceptedStatus.lastCommittedAt));
  acceptedRuntime.dispose();

  // (c) a synchronous throw on the LEGACY idle path is a failed send, never a commit.
  let idleClock = 0;
  const throwing = {
    connect: async () => {},
    disconnect: async () => {},
    write: () => ({ ok: true }),
    writeFrame: () => { throw new Error('frame boom'); },
  };
  const throwingRuntime = await connectRuntime({
    transport: throwing,
    now: () => idleClock,
    config: motionConfig({ motionWrites: false, idleWriteHz: 8, seed: 9 }),
  });
  for (let index = 0; index < 5; index += 1) {
    idleClock = index * 50;
    throwingRuntime.tick(idleClock);
    await flushMicrotasks();
  }
  const throwingStatus = transportStatus(throwingRuntime);
  assert.ok(throwingStatus.failed >= 1, `the thrown idle send was failed (${throwingStatus.failed})`);
  assert.equal(throwingStatus.committed, 0);
  assert.match(throwingStatus.lastError, /frame boom/);
  assert.equal(throwingStatus.lastErrorCode, 'WRITE_FAILED');
  throwingRuntime.dispose();

  // (d) an in-flight send invalidated by a lock settles late: stale, never a commit.
  let slowClock = 0;
  let resolveSlow = null;
  const slow = {
    connect: async () => {},
    disconnect: async () => {},
    write: () => ({ ok: true }),
    writeMotion: () => new Promise((resolve) => { resolveSlow = () => resolve({ ok: true }); }),
  };
  const slowRuntime = await connectRuntime({
    transport: slow,
    now: () => slowClock,
    config: motionConfig({ motionWrites: true, motionOutputHz: 30, seed: 11 }),
  });
  slowClock = 0;
  slowRuntime.tick(0);
  assert.equal(transportStatus(slowRuntime).attempted, 1);
  const committedBefore = transportStatus(slowRuntime).committed;
  slowRuntime.lock('privacy');
  resolveSlow();
  await flushMicrotasks();
  await flushMicrotasks();
  const slowStatus = transportStatus(slowRuntime);
  assert.equal(slowStatus.committed, committedBefore, 'the invalidated result is not a commit');
  assert.ok(slowStatus.stale >= 1);
  assert.equal(slowStatus.lastStaleReason, 'generation');
  slowRuntime.dispose();

  console.log(
    `[transport-evidence] rejectedAttempted=${rejectedStatus.attempted} rejectedFailed=${rejectedStatus.failed}`
    + ` rejectedCommitted=${rejectedStatus.committed} acceptedCommitted=${acceptedStatus.committed}`
    + ` throwFailed=${throwingStatus.failed} stale=${slowStatus.stale}`,
  );
});

