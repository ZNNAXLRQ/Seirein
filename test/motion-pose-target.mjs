/**
 * Phase 3 follow-up — the SELECTED posture component target must be recognisable.
 *
 * Scope of this suite:
 *   1. a held component target is 3–4.5° on its dominant head axis (semantic / degrees recorded),
 *      while the instantaneous pose may legitimately cross 0 during the component transition;
 *   2. the BASE micro-motion is not raised globally (only the component target moved);
 *   3. every component channel carries layered target / mixed / sent / sendResult evidence, and a
 *      transport failure is visible (never reported as a commit);
 *   4. `blinkCount` (generated blink cycles) is split from `blinkSent` (committed eye rows), and
 *      `eyeWriteOptIn:false` names its reason (`idleEye-off`);
 *   5. breath counts never masquerade as plugin-driven writes; the owner is explicit.
 *
 * No real VTS is contacted: deterministic controller runs and a fake transport only. Real visual
 * appearance remains UNVERIFIED.
 *
 * Run: node --test test/motion-pose-target.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HOLD_MICRO_DRIFT,
  POSTURE_COMPONENT_CHANNELS,
  POSTURE_COMPONENT_MAX_AMPLITUDE,
  POSTURE_COMPONENT_MIN_AMPLITUDE,
  createBehaviorRuntime,
} from '../src/host/avatar/motion-controller.js';
import { createAvatarRuntime } from '../src/host/avatar/avatarRuntime.js';

const DT = 1000 / 30;
const flush = () => new Promise((resolve) => setImmediate(resolve));
const approx = (actual, expected, message, tolerance = 1e-6) => {
  assert.ok(Math.abs(actual - expected) <= tolerance,
    `${message} (actual ${actual}, expected ${expected})`);
};

const ROW_DEFS = Object.freeze({
  headX: { channel: 'headX', inputName: 'P_headX', min: -30, max: 30, injectable: true, verified: true },
  headY: { channel: 'headY', inputName: 'P_headY', min: -30, max: 30, injectable: true, verified: true },
  headZ: { channel: 'headZ', inputName: 'P_headZ', min: -90, max: 90, injectable: true, verified: true },
  eyeOpenL: { channel: 'eyeOpenL', inputName: 'P_eyeL', min: 0, max: 1, injectable: true, verified: true },
  eyeOpenR: { channel: 'eyeOpenR', inputName: 'P_eyeR', min: 0, max: 1, injectable: true, verified: true },
  breath: { channel: 'breath', inputName: 'P_breath', min: 0, max: 1, injectable: true, verified: true },
});

const HEAD_ROWS = ['headX', 'headY', 'headZ'];
const BODY_ROWS = ['headX', 'headY', 'headZ', 'breath'];
const EYE_ROWS = ['headX', 'headY', 'headZ', 'eyeOpenL', 'eyeOpenR', 'breath'];

function rowsFor(channels) {
  return channels.map((channel) => ({ ...ROW_DEFS[channel] }));
}

/**
 * Fake transport. `fail:true` returns `ok:false` for every frame so the failed path is real (the
 * promise rejects through the same code a live transport uses), not a skipped write.
 */
function createFakeTransport({ fail = false } = {}) {
  const frames = [];
  let clock = 0;
  const response = () => (fail
    ? { ok: false, code: 'WRITE_FAILED', reason: 'test-transport-refused' }
    : { ok: true });
  const transport = {
    connect: async () => {},
    disconnect: async () => {},
    write: async () => response(),
    writeFrame: async (entries) => {
      frames.push({ at: clock, entries: entries.map((entry) => ({ ...entry })) });
      return response();
    },
    writeMotion: async (payload) => {
      frames.push({ at: clock, entries: (payload.entries ?? []).map((entry) => ({ ...entry })) });
      return response();
    },
  };
  return {
    frames,
    transport,
    setClock(at) { clock = at; },
  };
}

async function makeRig({
  rows = BODY_ROWS,
  idleEye = false,
  fail = false,
  config = {},
} = {}) {
  const fake = createFakeTransport({ fail });
  let clock = 0;
  const runtime = createAvatarRuntime({
    transport: fake.transport,
    now: () => clock,
    config: {
      autoTickMs: 0,
      flushIntervalMs: 1,
      idleActions: [],
      idleWriteHz: 10,
      motionWrites: false,
      componentGazeEnabled: false,
      seed: 5,
      postureHoldMinMs: 60_000,
      postureHoldMaxMs: 60_000,
      postureHoldChance: 1,
      postureStillChance: 0,
      postureComponentMinMs: 10_000,
      postureComponentMaxMs: 10_000,
      idleEye,
      ...config,
    },
  });
  const connected = await runtime.connect();
  assert.equal(connected.ok, true, `runtime connects (${connected.message ?? ''})`);
  const mapped = await runtime.setChannelMappings(rowsFor(rows), { channelMap: {} });
  assert.equal(mapped.ok, true, 'channel mappings apply');
  return {
    runtime,
    fake,
    async tick(at) {
      clock = at;
      fake.setClock(at);
      runtime.tick(at);
      await flush();
    },
    async run(toMs, stepMs = DT) {
      for (let at = 0; at <= toMs; at += stepMs) await this.tick(at);
      // Let the transport promise chain settle before reading the evidence.
      await flush();
      await flush();
    },
  };
}

// ---------------------------------------------------------------------------------------------
// 1. held component target is recognisable; the instantaneous pose may cross 0
// ---------------------------------------------------------------------------------------------
test('1. 静止保持：组件 target 可辨认（≥3°/0.10），瞬时姿态可经过 0', () => {
  const style = {
    amplitude: 0.3, tempo: 1, gazeHabit: 'steady', expressiveness: 1,
    nodAmplitude: 1, nodDurationMs: 450, tiltChance: 0.05,
  };
  const runtime = createBehaviorRuntime({
    config: {
      seed: 5,
      idleActions: [],
      style,
      postureHoldMinMs: 60_000,
      postureHoldMaxMs: 60_000,
      postureHoldChance: 1,
      postureStillChance: 0,
      postureComponentMinMs: 2_500,
      postureComponentMaxMs: 2_500,
      componentGazeVerified: false,
    },
  });

  let maxTargetSemantic = 0;
  let maxTargetDegrees = 0;
  let minPoseHeadZ = Number.POSITIVE_INFINITY;
  let minPoseAt = null;
  let targetAtMinPose = null;
  let componentAtMinPose = null;
  const transitions = [];
  const transitionKeys = new Set();
  const seen = new Set();

  for (let at = 0; at <= 14_000; at += DT) {
    const pose = runtime.tick(at);
    const motion = runtime.snapshot().motion;
    const component = motion.posture.component;
    if (component === null) continue;
    seen.add(component.id);
    // A component transition is published when it COMPLETES, so collect it from the snapshot
    // rather than from the instant the new shape starts.
    const completed = motion.posture.lastComponentTransition;
    if (completed !== null) {
      const key = `${completed.startedAt}:${completed.endedAt}`;
      if (transitionKeys.has(key) !== true) {
        transitionKeys.add(key);
        transitions.push(completed);
      }
    }

    // The dominant axis of every lean/look component must be a real held target, not a trace.
    // `natural` is now deliberately the smallest NON-ZERO shape instead of a 10–20 s zero hold:
    // it must carry a real target, but it does not have to reach the full lean band.
    const dominant = Math.max(...POSTURE_COMPONENT_CHANNELS.map(
      (channel) => Math.abs(component.semantic?.[channel] ?? 0),
    ));
    maxTargetSemantic = Math.max(maxTargetSemantic, dominant);
    if (component.id === 'natural') {
      assert.ok(dominant > 0,
        `natural carries a non-zero held target (${dominant}), never a 10–20 s all-zero hold`);
      assert.ok(dominant <= POSTURE_COMPONENT_MAX_AMPLITUDE + 1e-9,
        `natural dominant target ${dominant} ≤ ${POSTURE_COMPONENT_MAX_AMPLITUDE}`);
    } else {
      assert.ok(dominant >= POSTURE_COMPONENT_MIN_AMPLITUDE - 1e-6,
        `${component.id} dominant target ${dominant} ≥ ${POSTURE_COMPONENT_MIN_AMPLITUDE}`);
      assert.ok(dominant <= POSTURE_COMPONENT_MAX_AMPLITUDE + 1e-9,
        `${component.id} dominant target ${dominant} ≤ ${POSTURE_COMPONENT_MAX_AMPLITUDE}`);
    }
    for (const channel of POSTURE_COMPONENT_CHANNELS) {
      const semantic = component.observed?.semantic?.[channel] ?? 0;
      const degrees = component.observed?.targetDegrees?.[channel] ?? 0;
      maxTargetDegrees = Math.max(maxTargetDegrees, Math.abs(degrees));
      approx(degrees, semantic * 30, `${component.id}/${channel} targetDegrees follows the 30° convention`);
    }

    // Track the instantaneous pose while the roll target is a real held excursion. During a
    // component transition from one side to the other the pose legitimately passes through 0.
    const heldRoll = Math.abs(component.semantic?.headZ ?? 0);
    if (heldRoll >= 0.10) {
      const absPose = Math.abs(pose.headZ);
      if (absPose < minPoseHeadZ) {
        minPoseHeadZ = absPose;
        minPoseAt = at;
        targetAtMinPose = component.semantic.headZ;
        componentAtMinPose = component.id;
      }
    }
  }

  assert.ok(seen.size >= 2, `at least two component shapes were selected (${[...seen].join(',')})`);
  assert.ok(maxTargetSemantic >= 0.10,
    `a held component target is recognisable (semantic ${maxTargetSemantic})`);
  assert.ok(maxTargetDegrees >= 3,
    `a held component target is ≥3° (${maxTargetDegrees.toFixed(2)}°)`);
  assert.ok(transitions.length >= 1, 'at least one component swap transition was observed');
  assert.ok(runtime.snapshot().motion.posture.componentTransitions >= 1,
    'the component swap counter advanced');
  for (const transition of transitions) {
    assert.equal(transition.kind, 'component', 'the swap is labelled as a component transition');
    assert.ok(transition.durationMs >= 1_200 && transition.durationMs <= 1_800,
      `the swap is interpolated in 1.2–1.8 s (${transition.durationMs} ms)`);
  }
  assert.ok(minPoseHeadZ < 0.01,
    `the instantaneous pose can pass through 0 (${minPoseHeadZ} at ${minPoseAt} ms)`);
  assert.ok(Math.abs(targetAtMinPose) >= 0.10,
    `the held target stays recognisable at the zero-crossing frame (${targetAtMinPose})`);
  assert.ok(componentAtMinPose !== null);
  console.log(
    `[pose-target] maxSem=${maxTargetSemantic.toFixed(4)} maxDeg=${maxTargetDegrees.toFixed(2)}`
    + ` minPose.headZ=${minPoseHeadZ.toFixed(6)}@${Math.round(minPoseAt)}ms`
    + ` target@min=${targetAtMinPose.toFixed(4)} shapes=${[...seen].join(',')}`,
  );

  // The lowest legal persona amplitude plus the quietest status must STILL produce a recognisable
  // held target: the gain cancellation is part of the component target, not a global gain.
  const low = createBehaviorRuntime({
    config: {
      seed: 3,
      idleActions: [],
      style: { ...style, amplitude: 0.2 },
      status: 'tired',
      postureHoldMinMs: 60_000,
      postureHoldMaxMs: 60_000,
      postureHoldChance: 1,
      postureStillChance: 0,
      postureComponentMinMs: 10_000,
      postureComponentMaxMs: 10_000,
      componentGazeVerified: false,
    },
  });
  let lowestTarget = 0;
  let lowestSaturated = false;
  for (let at = 0; at <= 15_000; at += DT) {
    low.tick(at);
    const component = low.snapshot().motion.posture.component;
    if (component === null) continue;
    const dominant = Math.max(...POSTURE_COMPONENT_CHANNELS.map(
      (channel) => Math.abs(component.semantic?.[channel] ?? 0),
    ));
    lowestTarget = Math.max(lowestTarget, dominant);
    if (Object.values(component.saturated ?? {}).some(Boolean)) lowestSaturated = true;
  }
  assert.ok(lowestTarget >= POSTURE_COMPONENT_MIN_AMPLITUDE - 1e-6,
    `quiet+tired still reaches the recognisable band (${lowestTarget})`);
  assert.ok(lowestTarget <= POSTURE_COMPONENT_MAX_AMPLITUDE + 1e-9);
  assert.equal(lowestSaturated, false, 'the legal persona range did not hit the internal axis bound');
  console.log(`[pose-target] quiet+tired target=${lowestTarget.toFixed(4)} (${(lowestTarget * 30).toFixed(2)}°)`);
});

// ---------------------------------------------------------------------------------------------
// 2. base micro-motion stays light (no global visibility gain)
// ---------------------------------------------------------------------------------------------
test('2. 基础微动仍轻：基底贡献 ≤ ~6.6°，hold drift ≤1°，组件目标独立可辨认', () => {
  const runtime = createBehaviorRuntime({
    config: {
      seed: 21,
      idleActions: [],
      postureHoldMinMs: 60_000,
      postureHoldMaxMs: 60_000,
      postureHoldChance: 1,
      postureStillChance: 0,
      postureComponentMinMs: 10_000,
      postureComponentMaxMs: 10_000,
      componentGazeVerified: false,
    },
  });
  const baseMax = { headX: 0, headY: 0, headZ: 0 };
  const componentMax = { headX: 0, headY: 0, headZ: 0 };
  let driftMaxDegrees = 0;

  for (let at = 0; at <= 22_000; at += DT) {
    runtime.tick(at);
    const motion = runtime.snapshot().motion;
    const component = motion.posture.component;
    driftMaxDegrees = Math.max(driftMaxDegrees, ...POSTURE_COMPONENT_CHANNELS.map(
      (channel) => Math.abs(motion.holdDrift?.[channel] ?? 0) * 30,
    ));
    if (component?.observed === null || component?.observed === undefined) continue;
    // A component swap is interpolated over 1.2–1.8 s. During that window `observed.idle` still
    // carries the PREVIOUS component while `observed.mixed` already names the NEW one, so
    // `idle − mixed` would mix two different shapes and must not be read as the base layer.
    // Measure the base only once the current component has settled.
    if (at - component.startedAt < 2_000) continue;
    for (const channel of POSTURE_COMPONENT_CHANNELS) {
      const idle = component.observed.idle?.[channel] ?? 0;
      const mixed = component.observed.mixed?.[channel] ?? 0;
      // `idle` is the composed idle base (base swing + drift + component); subtracting the
      // component share leaves the base micro-motion this task must NOT have raised.
      baseMax[channel] = Math.max(baseMax[channel], Math.abs(idle - mixed));
      componentMax[channel] = Math.max(componentMax[channel], Math.abs(mixed));
    }
  }

  assert.equal(runtime.snapshot().motion.holdDrift?.maxDegrees, HOLD_MICRO_DRIFT.DEGREES);
  assert.ok(driftMaxDegrees <= HOLD_MICRO_DRIFT.DEGREES + 1e-6,
    `hold drift stays ≤1° (${driftMaxDegrees.toFixed(3)}°)`);
  assert.ok(baseMax.headX <= 0.22, `base headX stays light (${baseMax.headX.toFixed(4)} = ${(baseMax.headX * 30).toFixed(2)}°)`);
  assert.ok(baseMax.headY <= 0.19, `base headY stays light (${baseMax.headY.toFixed(4)} = ${(baseMax.headY * 30).toFixed(2)}°)`);
  assert.ok(baseMax.headZ <= 0.19, `base headZ stays light (${baseMax.headZ.toFixed(4)} = ${(baseMax.headZ * 30).toFixed(2)}°)`);
  assert.ok(Math.max(...Object.values(componentMax)) >= 0.10,
    'the selected component target itself is still recognisable');
  assert.ok(runtime.snapshot().motion.baseActivity.headMotionMs > 20_000,
    'the base layer really kept moving for the whole window');
  console.log(
    `[base-light] baseMax headX/headY/headZ=${Object.values(baseMax).map((v) => (v * 30).toFixed(2)).join('/')}°`
    + ` driftMax=${driftMaxDegrees.toFixed(2)}° componentMax=${Math.max(...Object.values(componentMax)).toFixed(4)}`,
  );
});

// ---------------------------------------------------------------------------------------------
// 3. layered target / mixed / sent / sendResult, including a visible failure
// ---------------------------------------------------------------------------------------------
test('3. 每通道 target/mixed/sent/sendResult 有值；失败可见；无映射时角度 unknown', async (t) => {
  const okRig = await makeRig();
  t.after(() => okRig.runtime.dispose());
  await okRig.run(2_500);
  const okSnapshot = okRig.runtime.snapshot();
  const evidence = okSnapshot.motion.componentEvidence;
  assert.ok(evidence !== null && evidence !== undefined, 'component evidence exists');
  for (const channel of HEAD_ROWS) {
    const row = evidence.channels[channel];
    assert.ok(row !== undefined, `${channel} has component evidence`);
    assert.ok(Number.isFinite(row.targetSemantic), `${channel} targetSemantic is recorded`);
    assert.ok(Number.isFinite(row.targetDegrees), `${channel} targetDegrees is recorded`);
    assert.ok(Number.isFinite(row.mixed), `${channel} mixed is recorded`);
    assert.ok(Number.isFinite(row.sent), `${channel} sent is recorded (last committed row)`);
    assert.equal(row.sendResult, 'ok', `${channel} last send committed`);
    assert.ok(row.inputRange !== null, `${channel} carries the verified input range`);
    assert.equal(row.sent, row.sentInput, `${channel} sent aliases sentInput`);
    assert.ok(row.sent >= row.inputRange.min - 1e-9 && row.sent <= row.inputRange.max + 1e-9,
      `${channel} sent stays inside the verified input range`);
    assert.ok(Number.isFinite(row.sentSemantic), `${channel} sentSemantic is recorded`);
    approx(row.sentDegrees, row.sentSemantic * 30, `${channel} sentDegrees=30×sentSemantic`);
    assert.ok(row.targetInput >= row.inputRange.min - 1e-9 && row.targetInput <= row.inputRange.max + 1e-9,
      `${channel} targetInput stays inside the verified range`);
    approx(row.targetDegrees, row.targetSemantic * 30, `${channel} targetDegrees=30×semantic`);
  }
  assert.equal(okSnapshot.motionLayers.components.evidence.channels.headX.sendResult, 'ok',
    'the motionLayers projection carries the same evidence');
  assert.ok(okSnapshot.motion.componentEvidence.summary.sentRows > 0,
    'the summary counts the committed component rows');

  // Failure path: the transport refuses every frame. The evidence must say failed, never ok.
  const failedRig = await makeRig({ fail: true });
  t.after(() => failedRig.runtime.dispose());
  await failedRig.run(1_200);
  const failedSnapshot = failedRig.runtime.snapshot();
  const failedRow = failedSnapshot.motion.componentEvidence.channels.headX;
  assert.equal(failedRow.sendResult, 'failed', 'a refused row is reported as failed');
  assert.equal(failedRow.lastResult, 'failed');
  assert.ok(String(failedRow.lastError ?? '').length > 0, 'the failure reason is exposed');
  assert.ok(failedSnapshot.motion.transport.failed > 0, 'the transport evidence counts the failure');
  assert.ok(failedSnapshot.motion.componentEvidence.summary.failedRows > 0);
  assert.equal(failedSnapshot.motion.transport.committed, 0, 'a refused row is never a commit');

  // Only headX is mapped: headY/headZ cannot be converted, so their angle is explicitly unknown.
  const unmappedRig = await makeRig({ rows: ['headX'] });
  t.after(() => unmappedRig.runtime.dispose());
  await unmappedRig.run(1_000);
  const unmapped = unmappedRig.runtime.snapshot().motion.componentEvidence.channels;
  assert.equal(unmapped.headY.targetDegrees, null, 'an unmapped channel has no guessed angle');
  assert.equal(unmapped.headY.targetDegreesBasis, 'unknown');
  assert.equal(unmapped.headY.sendResult, 'not-written');
  assert.equal(unmapped.headX.sendResult, 'ok');

  // The 30 Hz motion-pump path builds the same evidence (not only the legacy idle flush).
  const motionRig = await makeRig({ config: { motionWrites: true } });
  t.after(() => motionRig.runtime.dispose());
  await motionRig.run(1_500);
  const pumped = motionRig.runtime.snapshot();
  assert.equal(pumped.motion.componentEvidence.channels.headX.sendResult, 'ok',
    'the 30 Hz motion path records a committed component row');
  assert.ok(pumped.motion.transport.committed > 0, 'the motion pump committed rows');
  console.log(
    `[evidence] frames=${evidence.frame} sentRows=${okSnapshot.motion.componentEvidence.summary.sentRows}`
    + ` failed=${failedRow.sendResult}/${failedRow.lastErrorCode}`
    + ` unmapped.headY=${unmapped.headY.targetDegreesBasis}`
    + ` motionFrames=${pumped.motion.componentEvidence.frame}`,
  );
});

// ---------------------------------------------------------------------------------------------
// 4. blink: generated cycles vs committed eye rows; the opt-in reason is exposed
// ---------------------------------------------------------------------------------------------
test('4. blinkCount=生成周期、blinkSent=实际发送；eyeWriteOptIn:false 原因可见', async (t) => {
  const offRig = await makeRig({ rows: EYE_ROWS, idleEye: false });
  t.after(() => offRig.runtime.dispose());
  await offRig.run(14_000);
  const off = offRig.runtime.snapshot();
  assert.ok(off.blink.generated > 0, `the blink machine generated cycles (${off.blink.generated})`);
  assert.equal(off.blink.sent, 0, 'no eye row was sent while idleEye is off');
  assert.equal(off.blink.eyeWriteOptIn, false);
  assert.equal(off.blink.eyeWriteOptInReason, 'idleEye-off', 'the opt-out reason is explicit');
  assert.equal(off.motion.channelOwnership.channels.blink.eyeWriteOptInReason, 'idleEye-off');
  const eyeRows = offRig.fake.frames.flatMap((frame) => frame.entries)
    .filter((entry) => entry.channel === 'eyeOpenL' || entry.channel === 'eyeOpenR');
  assert.equal(eyeRows.length, 0, 'the transport never received an eye-open row');

  const onRig = await makeRig({ rows: EYE_ROWS, idleEye: true });
  t.after(() => onRig.runtime.dispose());
  await onRig.run(14_000);
  const on = onRig.runtime.snapshot();
  assert.ok(on.blink.generated > 0);
  assert.ok(on.blink.sent > 0, `a generated blink became a committed eye row (${on.blink.sent})`);
  assert.ok(on.blink.sent <= on.blink.generated,
    `blinkSent cannot exceed generated cycles (${on.blink.sent} ≤ ${on.blink.generated})`);
  assert.equal(on.blink.eyeWriteOptIn, true);
  assert.equal(on.blink.eyeWriteOptInReason, 'idleEye-on');
  assert.equal(on.motion.baseActivity.blinkGenerated, on.blink.generated);
  assert.equal(on.motion.baseActivity.blinkSent, on.blink.sent);

  // A generated blink whose eye rows all fail must NOT be counted as sent.
  const failedRig = await makeRig({ rows: EYE_ROWS, idleEye: true, fail: true });
  t.after(() => failedRig.runtime.dispose());
  await failedRig.run(14_000);
  const failed = failedRig.runtime.snapshot();
  assert.ok(failed.blink.generated > 0, 'the blink machine still generated cycles');
  assert.equal(failed.blink.sent, 0, 'no failed eye row is counted as a sent blink');
  assert.ok(['failed', 'pending'].includes(failed.blink.lastResult),
    `the eye send result is a failure, not a screen blink (${failed.blink.lastResult})`);
  console.log(
    `[blink] off=${off.blink.generated}/${off.blink.sent}(${off.blink.eyeWriteOptInReason})`
    + ` on=${on.blink.generated}/${on.blink.sent} failed=${failed.blink.generated}/${failed.blink.sent}`
    + ` last=${failed.blink.lastResult}`,
  );
});

// ---------------------------------------------------------------------------------------------
// 5. breath owner is explicit; generated cycles are not called plugin-driven
// ---------------------------------------------------------------------------------------------
test('5. breath owner 明确：无映射时 native 计数不算插件驱动', async (t) => {
  const nativeRig = await makeRig({ rows: BODY_ROWS.filter((channel) => channel !== 'breath') });
  t.after(() => nativeRig.runtime.dispose());
  await nativeRig.run(8_000);
  const native = nativeRig.runtime.snapshot();
  assert.ok(native.motion.baseActivity.breathCycles > 0,
    `the controller generated breath cycles (${native.motion.baseActivity.breathCycles})`);
  assert.equal(native.breath.owner, 'vts-native', 'without a verified row the owner is VTS native');
  assert.equal(native.breath.driven, false, 'the generated cycles did not drive a plugin row');
  assert.equal(native.breath.writes, 0);
  assert.equal(native.breath.generatedCycles, native.motion.baseActivity.breathCycles);
  assert.equal(native.motion.baseActivity.breathOwner, 'vts-native');
  assert.match(native.breath.generatedCountMeaning, /not a transport write/u);
  assert.equal(nativeRig.fake.frames.some(
    (frame) => frame.entries.some((entry) => entry.channel === 'breath'),
  ), false, 'no breath row was written');

  const pluginRig = await makeRig({ rows: BODY_ROWS });
  t.after(() => pluginRig.runtime.dispose());
  await pluginRig.run(8_000);
  const plugin = pluginRig.runtime.snapshot();
  assert.equal(plugin.breath.owner, 'plugin');
  assert.equal(plugin.breath.driven, true, 'a committed verified breath row really drove the channel');
  assert.ok(plugin.breath.writes > 0);
  assert.ok(plugin.breath.generatedCycles > 0);
  assert.ok(plugin.motion.baseActivity.breathDriven === true);
  console.log(
    `[breath] native=${native.breath.owner} generated=${native.breath.generatedCycles}`
    + ` writes=${native.breath.writes} | plugin=${plugin.breath.owner}`
    + ` generated=${plugin.breath.generatedCycles} writes=${plugin.breath.writes}`,
  );
});
