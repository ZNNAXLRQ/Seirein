/**
 * Phase 2 — base activity observation and channel ownership.
 *
 * The point of this file is NOT to add motion. It proves the two things phase 2 promised:
 *
 *   1. the already-running base layer (blink / breath / head) keeps accumulating while a preset is
 *      held or has no candidates, in every status, and STOPS when the host gate closes
 *      (privacy lock / disconnect / dispose);
 *   2. the ownership table says who may drive each channel, and an unverified gaze mapping is
 *      never written.
 *
 * Definitions asserted below (see `motion.baseActivity` in motion-controller.js):
 *   blinkCount   +1 only when a real blink cycle STARTS (idle → closing);
 *   breathCycles +1 per completed breath phase (2π wrap) while breathing is enabled;
 *   headMotionMs accumulated dt in ms for frames where an IDLE head channel really changed
 *                (> 1e-4 pose units); the final pose below is NOT used (preset/gesture excluded).
 *
 * No real VTS is contacted: fake transports and the pure controller only.
 *
 * Run: node --test test/motion-base-activity.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createBehaviorRuntime } from '../src/host/avatar/motion-controller.js';
import { createAvatarRuntime } from '../src/host/avatar/avatarRuntime.js';
import { PRESETS } from '../src/host/avatar/presets/index.js';

const DT = 1000 / 30;
const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve));

/** Tick on the normal 30 Hz grid; the controller owns every count, this loop is just time. */
function run(runtime, fromMs, toMs, stepMs = DT) {
  for (let at = fromMs; at <= toMs; at += stepMs) runtime.tick(at);
}

const activityOf = (runtime) => runtime.snapshot().motion.baseActivity;
const ALL_FAMILIES = [...new Set(PRESETS.map((preset) => preset.family))];

/** Transport that records what the writer really produced. */
function createFakeTransport() {
  const writes = [];
  const transport = {
    connect: async () => {},
    disconnect: async () => {},
    write: async ({ input, value }) => {
      writes.push({ input, value });
      return { ok: true };
    },
    writeFrame: async (entries) => {
      writes.push(...entries.map((entry) => ({ input: entry.input, value: entry.value })));
      return { ok: true };
    },
  };
  return { writes, transport };
}

/** One fake VTS channel row; the binding must carry its own verified verdict. */
function channelRow(channel, inputName, {
  verified = true, min = -1, max = 1, modelParams = [],
} = {}) {
  return {
    channel, inputName, injectable: true, verified, min, max, modelParams, inputSource: 'test',
  };
}

async function connectRuntime(t, options = {}) {
  const runtime = createAvatarRuntime({
    config: { autoTickMs: 0, flushIntervalMs: 1, idleActions: [], ...(options.config ?? {}) },
    ...options,
  });
  const result = await runtime.connect();
  assert.equal(result.ok, true, `runtime connects (${result.message ?? ''})`);
  t.after(() => runtime.dispose());
  return runtime;
}

// ---------------------------------------------------------------------------------------------
// 1. base activity grows with no preset / a held preset / no candidates
// ---------------------------------------------------------------------------------------------
test('1. 无 preset / hold / no-candidates：blink、breath、headMotion 都持续增长', () => {
  const measured = [];

  // (a) no preset at all: the plain continuous layer.
  const plain = createBehaviorRuntime({ config: { seed: 21, idleActions: [] } });
  run(plain, 0, 10_000);
  const plainActivity = activityOf(plain);
  assert.equal(plain.snapshot().motion.presets.enabled, false, 'preset execution is off');
  measured.push(['none', plainActivity]);

  // (b) a legal HOLD decision: privacy refuses the draw, so the selector holds. The base layer must
  // keep running even though no preset channel is written.
  const held = createBehaviorRuntime({
    config: {
      seed: 23,
      idleActions: [],
      presetExecution: true,
      presetOverrides: { disabledFamilies: ALL_FAMILIES },
    },
  });
  run(held, 0, 200);
  const heldBefore = activityOf(held);
  const hold = held.preset({ state: 'idle', event: 'idle', privacy: true, seed: 0, at: 233 });
  assert.equal(hold.kind, 'hold', 'the privacy draw is a hold');
  run(held, 233, 10_233);
  const heldAfter = activityOf(held);
  assert.equal(heldAfter.presetHeld, true, 'the last preset decision is still a hold');
  assert.ok(heldAfter.blinkCount > heldBefore.blinkCount, 'a held preset keeps blinking');
  assert.ok(heldAfter.breathCycles > heldBefore.breathCycles, 'a held preset keeps breathing');
  assert.ok(heldAfter.headMotionMs > heldBefore.headMotionMs, 'a held preset keeps head drift');
  measured.push(['hold', heldAfter]);

  // (c) no candidates: every family disabled, so the idle boundary reports no-candidate.
  const none = createBehaviorRuntime({
    config: {
      seed: 25,
      idleActions: [],
      presetExecution: true,
      presetOverrides: { disabledFamilies: ALL_FAMILIES },
    },
  });
  run(none, 0, 10_000);
  const noneActivity = activityOf(none);
  const noneSnapshot = none.snapshot().motion.presets;
  assert.equal(noneSnapshot.starts, 0, 'no preset started');
  assert.ok(noneSnapshot.holds > 0, 'the draw held');
  assert.equal(noneSnapshot.lastTrace.selection.kind, 'hold');
  assert.match(noneSnapshot.lastTrace.output.reason, /no-candidates/u, 'the reason is no-candidates');
  assert.equal(noneActivity.presetHeld, true, 'no-candidates is a preset hold state');
  measured.push(['no-candidates', noneActivity]);

  for (const [label, activity] of measured) {
    assert.ok(activity.blinkCount >= 1, `${label}: blinkCount ${activity.blinkCount} grew`);
    assert.ok(activity.breathCycles >= 2, `${label}: breathCycles ${activity.breathCycles} grew`);
    assert.ok(activity.headMotionMs > 5_000,
      `${label}: headMotionMs ${activity.headMotionMs} grew through the 10 s window`);
    // The measured run starts at t=0, so `lastAt` IS the real elapsed time: the hold case adds the
    // 200 ms warm-up and the 233 ms gap before the resumed frame loop, and the plain/no-candidate
    // cases run 0→10 s. Comparing against a hard-coded 10 s would fail a real 10.2 s window; one
    // synthetic first-frame dt is the only allowed lead (the counter starts before elapsed time 0).
    assert.ok(activity.headMotionMs <= activity.lastAt + DT,
      `${label}: headMotionMs ${activity.headMotionMs} never exceeds real time ${activity.lastAt}`);
    assert.equal(activity.state, 'running', `${label}: base activity is running`);
    assert.ok(Number.isFinite(activity.lastAt), `${label}: lastAt is a real timestamp`);
  }
  console.log(
    `[base-activity] ${measured.map(([label, activity]) => (
      `${label}: blink=${activity.blinkCount} breath=${activity.breathCycles}`
      + ` head=${Math.round(activity.headMotionMs)}ms`
    )).join(' | ')}`,
  );
});

// ---------------------------------------------------------------------------------------------
// 2. the four communication statuses all keep the base layer alive
// ---------------------------------------------------------------------------------------------
test('2. idle/listening/thinking/speaking 四状态基础活动照常累计', () => {
  const rows = [];
  for (const status of ['idle', 'listening', 'thinking', 'speaking']) {
    const runtime = createBehaviorRuntime({ config: { seed: 31, idleActions: [] } });
    runtime.setStatus(status);
    if (status === 'speaking') {
      const started = runtime.startSpeech({
        levels: new Array(80).fill(0.5),
        stepMs: 100,
        startedAt: 0,
        durationMs: 8000,
      });
      assert.equal(started.ok, true, 'the speaking envelope starts');
    }
    run(runtime, 0, 8_000);
    const activity = activityOf(runtime);
    rows.push([status, activity]);
    assert.ok(activity.blinkCount >= 1, `${status}: blinkCount ${activity.blinkCount}`);
    assert.ok(activity.breathCycles >= 1, `${status}: breathCycles ${activity.breathCycles}`);
    assert.ok(activity.headMotionMs > 3_000, `${status}: headMotionMs ${activity.headMotionMs}`);
    assert.equal(activity.state, 'running', `${status}: state stays running`);
  }
  console.log(`[base-activity] statuses ${rows.map(([status, activity]) => (
    `${status}:${activity.blinkCount}/${activity.breathCycles}/${Math.round(activity.headMotionMs)}ms`
  )).join(' ')}`);
});

// ---------------------------------------------------------------------------------------------
// 3. privacy lock / disconnect / dispose stop the counters (the pose may still be computed)
// ---------------------------------------------------------------------------------------------
test('3. 隐私锁 / 断连 / dispose：计数冻结，不报错', async (t) => {
  const fake = createFakeTransport();
  let clock = 0;
  const runtime = await connectRuntime(t, {
    transport: fake.transport,
    now: () => clock,
    config: {
      idleParams: { headX: { inputName: 'FaceAngleX', min: -30, max: 30 } },
    },
  });

  for (clock = 0; clock <= 2_000; clock += DT) runtime.tick(clock);
  const alive = activityOf(runtime);
  assert.ok(alive.headMotionMs > 1_000, `headMotionMs ${alive.headMotionMs} grew before the gate`);

  const frozen = (label) => {
    const snapshot = activityOf(runtime);
    assert.deepEqual(
      {
        blinkCount: snapshot.blinkCount,
        breathCycles: snapshot.breathCycles,
        headMotionMs: snapshot.headMotionMs,
        lastAt: snapshot.lastAt,
      },
      {
        blinkCount: frozenBefore.blinkCount,
        breathCycles: frozenBefore.breathCycles,
        headMotionMs: frozenBefore.headMotionMs,
        lastAt: frozenBefore.lastAt,
      },
      `${label}: the counters are frozen`,
    );
    assert.equal(snapshot.state, 'stopped', `${label}: state is stopped`);
  };
  let frozenBefore = null;

  // Privacy lock: the pose keeps computing, the OBSERVATION gate is closed.
  runtime.lock('privacy');
  runtime.tick(clock);
  clock += DT;
  frozenBefore = activityOf(runtime);
  for (; clock <= 6_000; clock += DT) runtime.tick(clock);
  frozen('privacy lock');

  // Unlock: the same frame loop resumes the counters (no restart, no reset).
  runtime.unlock();
  clock += DT;
  runtime.tick(clock);
  clock += DT;
  for (; clock <= 8_000; clock += DT) runtime.tick(clock);
  const resumed = activityOf(runtime);
  assert.ok(resumed.headMotionMs > frozenBefore.headMotionMs, 'unlock resumes head activity');
  assert.equal(resumed.state, 'running', 'unlock reports running');

  // Disconnect: the socket is gone, so nothing may keep counting.
  const disconnected = await runtime.disconnect();
  assert.equal(disconnected.ok, true, `disconnect ok (${disconnected.message ?? ''})`);
  clock += DT;
  runtime.tick(clock);
  clock += DT;
  frozenBefore = activityOf(runtime);
  for (; clock <= 10_000; clock += DT) runtime.tick(clock);
  frozen('disconnect');

  // Master switch / teardown: dispose makes tick a no-op, so the last numbers stay.
  runtime.dispose();
  clock += DT;
  const disposedResult = runtime.tick(clock);
  assert.equal(disposedResult.ok, false, 'a disposed tick is refused, not thrown');
  clock += DT;
  frozenBefore = activityOf(runtime);
  for (; clock <= 12_000; clock += DT) runtime.tick(clock);
  frozen('dispose');
  console.log(
    `[base-activity] gates blink=${frozenBefore.blinkCount} breath=${frozenBefore.breathCycles}`
    + ` head=${Math.round(frozenBefore.headMotionMs)}ms state=${frozenBefore.state}`,
  );
});

// ---------------------------------------------------------------------------------------------
// 4. ownership table: head plugin, blink follows the effective owner (VTS until plugin+eyes),
//    breath/gaze also verified-only
// ---------------------------------------------------------------------------------------------
test('4. 所有权表：head plugin，blink 按有效 owner，breath 按 verified，gaze 仅 verified，body/arms 不写', async (t) => {
  const fake = createFakeTransport();
  const runtime = await connectRuntime(t, { transport: fake.transport });
  const applied = await runtime.setChannelMappings([
    channelRow('headX', 'FaceAngleX', { min: -30, max: 30, modelParams: ['ParamAngleX'] }),
    channelRow('headY', 'FaceAngleY', { min: -30, max: 30, modelParams: ['ParamAngleY'] }),
    channelRow('headZ', 'FaceAngleZ', { min: -90, max: 90, modelParams: ['ParamAngleZ'] }),
    channelRow('gazeX', 'EyeRightX', { modelParams: ['ParamEyeBallX'] }),
    channelRow('gazeY', 'EyeRightY', { modelParams: ['ParamEyeBallY'] }),
    channelRow('breath', 'ParamBreath', { min: 0, max: 1, modelParams: ['ParamBreath'] }),
  ], { channelMap: {} });
  assert.equal(applied.ok, true);
  assert.ok(applied.channels.controlled.includes('gazeX'), 'gazeX is controlled');

  const ownership = runtime.snapshot().motion.channelOwnership;
  assert.equal(ownership.channels.headX.source, 'plugin');
  assert.equal(ownership.channels.headX.owner, 'plugin-base');
  assert.equal(ownership.channels.headX.verified, true);
  assert.equal(ownership.channels.blink.source, 'vts-native',
    'no eye mapping means VTS still owns the actual blink');
  assert.equal(ownership.channels.blink.owner, 'vts-native');
  assert.equal(ownership.channels.blink.status, 'native');
  assert.equal(ownership.channels.blink.verified, false);
  assert.equal(ownership.channels.blink.nativePossible, true, 'VTS native idle may blink too');
  assert.equal(ownership.channels.breath.source, 'plugin', 'a verified breath input is plugin-driven');
  assert.equal(ownership.channels.breath.verified, true);
  assert.equal(ownership.channels.gazeX.source, 'plugin', 'a verified gaze mapping is plugin-driven');
  assert.equal(ownership.channels.gazeY.verified, true);
  assert.equal(ownership.channels.bodyX.source, 'vts-native', 'body stays native');
  assert.equal(ownership.channels.bodyY.source, 'vts-native');
  assert.equal(ownership.channels.bodyZ.source, 'vts-native');
  assert.equal(ownership.channels.arms.source, 'unsupported', 'arms are never written');
  assert.ok(ownership.plugin.includes('headX') && !ownership.plugin.includes('blink'));
  assert.ok(ownership.plugin.includes('breath') && ownership.plugin.includes('gazeX'));
  assert.ok(ownership.vtsNative.includes('bodyX'));
  assert.ok(ownership.vtsNative.includes('blink'));
  assert.deepEqual(ownership.unsupported, ['arms']);
  // The view never leaks an input name or a path.
  const serialized = JSON.stringify(ownership);
  for (const forbidden of ['FaceAngle', 'EyeRight', 'ParamBreath', '\\\\', 'D:\\']) {
    assert.equal(serialized.includes(forbidden), false, `ownership does not contain ${forbidden}`);
  }
  assert.deepEqual(runtime.snapshot().motionLayers.channelOwnership, ownership,
    'the status projection is the same table');

  // No mappings at all: breath/head stay native, gaze is explicitly unconfigured.
  const bare = await connectRuntime(t);
  const bareOwnership = bare.snapshot().motion.channelOwnership;
  assert.equal(bareOwnership.channels.breath.source, 'vts-native');
  assert.equal(bareOwnership.channels.headX.source, 'vts-native');
  assert.equal(bareOwnership.channels.gazeX.source, 'vts-native');
  assert.equal(bareOwnership.channels.gazeX.status, 'unconfigured');

  // A discovered but UNVERIFIED gaze row is `native-possible`, never `plugin`.
  const unverified = await connectRuntime(t);
  await unverified.setChannelMappings([
    channelRow('gazeX', 'EyeRightX', { verified: false, modelParams: ['ParamEyeBallX'] }),
    channelRow('gazeY', 'EyeRightY', { verified: false, modelParams: ['ParamEyeBallY'] }),
  ], { channelMap: {} });
  const unverifiedOwnership = unverified.snapshot().motion.channelOwnership;
  assert.equal(unverifiedOwnership.channels.gazeX.verified, false);
  assert.equal(unverifiedOwnership.channels.gazeX.source, 'vts-native');
  assert.equal(unverifiedOwnership.channels.gazeX.status, 'native-possible');
  console.log(
    `[ownership] plugin=${ownership.plugin.join(',')}`
    + ` native=${ownership.vtsNative.join(',')} unsupported=${ownership.unsupported.join(',')}`,
  );
});

// ---------------------------------------------------------------------------------------------
// 5. gaze gate: an unverified gaze mapping is never written (there is a real write point)
// ---------------------------------------------------------------------------------------------
test('5. 未验证 gaze 不写：thinking 的 gazeY 通道被拒绝', async (t) => {
  const fake = createFakeTransport();
  let clock = 0;
  const runtime = await connectRuntime(t, {
    transport: fake.transport,
    now: () => clock,
    config: {
      idleParams: { headX: { inputName: 'FaceAngleX', min: -30, max: 30 } },
    },
  });
  await runtime.setChannelMappings([
    channelRow('headX', 'FaceAngleX', { min: -30, max: 30, modelParams: ['ParamAngleX'] }),
    channelRow('gazeX', 'EyeRightX', { verified: false, modelParams: ['ParamEyeBallX'] }),
    channelRow('gazeY', 'EyeRightY', { verified: false, modelParams: ['ParamEyeBallY'] }),
  ], { channelMap: {} });

  fake.writes.length = 0;
  clock = 100;
  // A thinking expression drives gazeY; the unverified mapping must keep it off the wire.
  runtime.intentEvent('thinking', { at: 100 });
  for (clock = 100; clock <= 1_200; clock += 20) {
    runtime.tick(clock);
    await flushMicrotasks();
  }
  const gazeWrites = fake.writes.filter((entry) => /^EyeRight[XY]$/u.test(entry.input));
  assert.deepEqual(gazeWrites, [], 'no unverified gaze input was written');
  assert.ok(fake.writes.some((entry) => entry.input === 'FaceAngleX'),
    'the verified head channel was still written (the run is real)');
  const ownership = runtime.snapshot().motion.channelOwnership;
  assert.equal(ownership.channels.gazeY.status, 'native-possible');
  console.log(
    `[gaze-gate] writes=${fake.writes.length} gazeWrites=${gazeWrites.length}`
    + ` gazeY=${ownership.channels.gazeY.status}`,
  );
});
