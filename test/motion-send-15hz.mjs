/**
 * Send-cadence acceptance for the unified motion writer.
 *
 * Run: node --test test/motion-send-15hz.mjs
 *
 * The contract:
 *   - the pose is COMPUTED at 30 Hz, but the shipped send cadence is 15 Hz;
 *   - `idleWriteHz` stays host-configurable and is hard-capped at 30 Hz (never above compute);
 *   - a slow transport keeps only the NEWEST frame: due frames are coalesced/dropped, never queued;
 *   - the snapshot reports the REAL committed rate, send duration, late frames and coalescing;
 *   - only ONE writer path is active at a time (legacy idle flush OR the single-slot pump).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createAvatarRuntime } from '../src/host/avatar/avatarRuntime.js';

const DT = 1000 / 30;
const flush = async () => {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
};

const baseConfig = (extra = {}) => ({
  autoTickMs: 0,
  flushIntervalMs: 1,
  idleActions: [],
  idleParams: {
    headX: { inputName: 'FaceAngleX', min: -30, max: 30 },
    headY: { inputName: 'FaceAngleY', min: -30, max: 30 },
  },
  ...extra,
});

async function connectRuntime({ transport, config, now }) {
  const runtime = createAvatarRuntime({ transport, now, config });
  const connected = await runtime.connect();
  assert.equal(connected.ok, true, `runtime connects (${connected.message ?? ''})`);
  return runtime;
}

/** Immediate recorder: it also records the fake clock at which each coalesced frame was sent. */
function createRecordingTransport(clockRef) {
  const calls = [];
  const individualWrites = [];
  let motionCalls = 0;
  return {
    calls,
    individualWrites,
    get motionCalls() { return motionCalls; },
    transport: {
      connect: async () => {},
      disconnect: async () => {},
      write: async (entry) => {
        individualWrites.push({ at: clockRef.value, ...entry });
        return { ok: true };
      },
      writeFrame: async (entries) => {
        calls.push({ at: clockRef.value, entries });
        return { ok: true };
      },
      // Distinct counter so the test can prove the pump path is a different single writer.
      writeMotion: async (payload) => {
        motionCalls += 1;
        calls.push({ at: clockRef.value, entries: payload.entries ?? [] });
        return { ok: true };
      },
    },
  };
}

test('1. 默认 15 Hz：计算仍 30 Hz，真实发送率/耗时/单出口可观测', async () => {
  const clock = { value: 0 };
  const fake = createRecordingTransport(clock);
  const runtime = await connectRuntime({
    transport: fake.transport,
    now: () => clock.value,
    config: baseConfig(),
  });
  // Connect-time mapping probes use the per-row transport hook; the motion writer starts after.
  fake.individualWrites.length = 0;

  for (clock.value = 0; clock.value <= 3000; clock.value += DT) {
    runtime.tick(clock.value);
    await flush();
  }

  const snap = runtime.snapshot();
  const idle = snap.idleParams;
  assert.equal(idle.writeHz, 15, 'the shipped send cadence is 15 Hz');
  assert.equal(snap.inner.fps.compute, 30, 'the controller still COMPUTES at 30 Hz');
  assert.ok(fake.calls.length >= 35, `15 Hz really sends (${fake.calls.length} frames / 3 s)`);
  assert.ok(idle.actualHz >= 13 && idle.actualHz <= 16,
    `actualHz measures committed frames, not compute frames (${idle.actualHz})`);
  assert.ok(Number.isFinite(idle.sendDurationMs) && idle.sendDurationMs >= 0,
    `sendDurationMs is recorded (${idle.sendDurationMs})`);
  assert.ok(Number.isFinite(idle.sendDurationAvgMs) && idle.sendDurationAvgMs >= 0);
  assert.equal(idle.commits, fake.calls.length, 'commits equal the frames the transport accepted');

  // ONE writer: the legacy idle flush used writeFrame only; no per-row/mouth call and no pump.
  assert.ok(fake.individualWrites.length === 0, 'no second per-row writer ran');
  assert.equal(fake.motionCalls, 0, 'the pump path is not also active');
  assert.equal(idle.path, 'idle', 'the snapshot names the one active send path');
  console.log(
    `[send15] frames=${fake.calls.length} actualHz=${idle.actualHz}`
    + ` writeHz=${idle.writeHz} sendDurationMs=${idle.sendDurationMs}`
    + ` late=${idle.lateFrames} coalesced=${idle.coalesced}`,
  );
  runtime.dispose();
});

test('2. 忙时只发最新：慢发送不积压，dropped/coalesced 增长且无旧帧补播', async () => {
  const clock = { value: 0 };
  const calls = [];
  const resolvers = [];
  const transport = {
    connect: async () => {},
    disconnect: async () => {},
    write: async () => ({ ok: true }),
    writeFrame: (entries) => {
      const index = calls.length;
      calls.push({ at: clock.value, entries });
      return new Promise((resolve) => {
        resolvers[index] = () => resolve({ ok: true });
      });
    },
  };
  const runtime = await connectRuntime({
    transport,
    now: () => clock.value,
    config: baseConfig(),
  });

  runtime.tick(0); // frame A owns the single-flight gate
  for (let index = 1; index <= 30; index += 1) {
    clock.value = index * DT;
    runtime.tick(clock.value);
    await flush();
  }
  assert.equal(calls.length, 1, 'a slow send blocks every newer physical send');
  const whileBlocked = runtime.snapshot();
  assert.ok(whileBlocked.idleParams.dropped >= 20,
    `due frames were dropped, not queued (${whileBlocked.idleParams.dropped})`);
  assert.ok(whileBlocked.idleParams.coalesced >= 20,
    `the same frames are counted as coalesced (${whileBlocked.idleParams.coalesced})`);
  assert.ok(whileBlocked.idleParams.actualHz < 5,
    `actualHz reports the real slow delivery (${whileBlocked.idleParams.actualHz})`);

  resolvers[0]();
  await flush();
  assert.equal(calls.length, 1, 'settling the old send does not replay the backlog');

  const newestTick = 30 * DT + DT;
  clock.value = newestTick;
  runtime.tick(newestTick);
  await flush();
  assert.equal(calls.length, 2, 'exactly ONE newest frame follows the settle');
  assert.equal(calls[1].at, newestTick, 'the sent frame is the newest pose, not an older queued one');
  assert.equal(runtime.snapshot().motion.pending, false, 'no pump frame remains queued after the send');
  resolvers[1]();
  await flush();
  const after = runtime.snapshot();
  assert.equal(after.idleParams.commits, 2, 'only completed sends count as commits');
  assert.equal(after.idleParams.dropped, whileBlocked.idleParams.dropped,
    'the newest frame itself is not counted as dropped');
  console.log(
    `[send15] backpressure calls=${calls.length} dropped=${after.idleParams.dropped}`
    + ` coalesced=${after.idleParams.coalesced} actualHz=${after.idleParams.actualHz}`,
  );
  runtime.dispose();
});

test('3. 配置可覆盖且上限 30 Hz：30 Hz 真正每帧发送，超配被钳制', async () => {
  const run = async (idleWriteHz) => {
    const clock = { value: 0 };
    const fake = createRecordingTransport(clock);
    const runtime = await connectRuntime({
      transport: fake.transport,
      now: () => clock.value,
      config: baseConfig({ idleWriteHz }),
    });
    for (clock.value = 0; clock.value <= 1000; clock.value += DT) {
      runtime.tick(clock.value);
      await flush();
    }
    const snap = runtime.snapshot();
    runtime.dispose();
    return { frames: fake.calls.length, idle: snap.idleParams };
  };

  const thirty = await run(30);
  assert.equal(thirty.idle.writeHz, 30, 'an explicit 30 Hz is accepted');
  assert.ok(thirty.frames >= 28, `30 Hz sends on nearly every 30 Hz tick (${thirty.frames})`);
  assert.ok(thirty.idle.actualHz >= 28 && thirty.idle.actualHz <= 32,
    `30 Hz is measured as ~30 (${thirty.idle.actualHz})`);

  const capped = await run(120);
  assert.equal(capped.idle.writeHz, 30, 'the hard ceiling clamps a higher request to 30 Hz');
  assert.ok(capped.frames >= 28, `the clamped rate still sends at 30 Hz (${capped.frames})`);
  console.log(
    `[send15] config 30Hz=${thirty.frames} actual=${thirty.idle.actualHz}`
    + ` cap30=${capped.frames} actual=${capped.idle.actualHz}`,
  );
});

test('4. 晚到帧被记录：真正错过发送时点的 tick 才计入 lateFrames', async () => {
  const clock = { value: 0 };
  const fake = createRecordingTransport(clock);
  const runtime = await connectRuntime({
    transport: fake.transport,
    now: () => clock.value,
    config: baseConfig(),
  });

  for (const at of [0, DT, 200, 200 + DT, 200 + 2 * DT]) {
    clock.value = at;
    runtime.tick(at);
    await flush();
  }
  const snap = runtime.snapshot();
  assert.ok(snap.idleParams.lateFrames >= 1,
    `the 200 ms gap is a late frame (${snap.idleParams.lateFrames})`);
  assert.equal(snap.idleParams.writeHz, 15);
  assert.ok(fake.calls.length >= 2, 'late ticks still send the newest pose');
  console.log(
    `[send15] lateFrames=${snap.idleParams.lateFrames} frames=${fake.calls.length}`
    + ` actualHz=${snap.idleParams.actualHz}`,
  );
  runtime.dispose();
});

test('5. 泵路径也是单一出口：只走 writeMotion，snapshot 报告同一套发送事实', async () => {
  const clock = { value: 0 };
  const fake = createRecordingTransport(clock);
  const runtime = await connectRuntime({
    transport: fake.transport,
    now: () => clock.value,
    config: baseConfig({ motionWrites: true, motionOutputHz: 30 }),
  });
  fake.individualWrites.length = 0;

  for (clock.value = 0; clock.value <= 1000; clock.value += DT) {
    runtime.tick(clock.value);
    await flush();
  }
  const snap = runtime.snapshot();
  assert.ok(fake.motionCalls >= 28, `the pump sends at 30 Hz (${fake.motionCalls})`);
  assert.equal(fake.individualWrites.length, 0, 'no per-row writer');
  assert.equal(snap.motion.send.path, 'pump', 'the snapshot names the pump as the one path');
  assert.ok(snap.motion.actualHz >= 28 && snap.motion.actualHz <= 32,
    `the pump reports its real committed rate (${snap.motion.actualHz})`);
  assert.equal(snap.motion.send.commits, fake.motionCalls);
  console.log(
    `[send15] pump frames=${fake.motionCalls} actualHz=${snap.motion.actualHz}`
    + ` sendDurationMs=${snap.motion.sendDurationMs}`,
  );
  runtime.dispose();
});
