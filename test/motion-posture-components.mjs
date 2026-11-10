/**
 * Phase 1 posture components — independent slow posture, preset overlay, centre/recenter,
 * continuous idle writes and the channel-ownership boundary.
 *
 * Run: node --test test/motion-posture-components.mjs
 *
 * The component layer is deliberately tested on the PURE controller where possible: the seed,
 * tick grid and snapshot are deterministic. The transport tests use a fake transport and assert
 * the rows the ONE writer really built, never a guessed input name.
 *
 * Channel ownership assumed by this suite (and by the implementation):
 *   plugin-controlled : headX / headY / headZ (and head-centred idle writes)
 *   VTS-native        : bodyX/Y/Z, breath (the controller never drives body; breath has its own row)
 *   not idle-written  : gazeX / gazeY, browL / browR (intent/expression/preset only)
 *   opt-in            : eyeOpenL / eyeOpenR (host.idleEye)
 * An explicit gaze channelMap is configuration only; it still needs a runtime probe before it can
 * be called verified. This suite never treats a declaration as proof.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  POSTURE_COMPONENT_CHANNELS,
  POSTURE_COMPONENT_MAX_AMPLITUDE,
  POSTURE_COMPONENT_MAX_MS,
  POSTURE_COMPONENT_MIN_MS,
  createBehaviorRuntime,
} from '../src/host/avatar/motion-controller.js';
import { createAvatarRuntime } from '../src/host/avatar/avatarRuntime.js';
import { PRESETS } from '../src/host/avatar/presets/index.js';

const DT = 1000 / 30;
const ALL_CHANNELS = Object.freeze([
  'headX', 'headY', 'headZ', 'gazeX', 'gazeY', 'eyeOpenL', 'eyeOpenR',
  'browL', 'browR', 'bodyX', 'bodyY', 'bodyZ', 'breath',
]);
const ALL_FAMILIES = [...new Set(PRESETS.map((preset) => preset.family))];
const HEAD_CHANNELS = Object.freeze(['headX', 'headY', 'headZ']);
const UNVERIFIED_IDLE_CHANNELS = Object.freeze(['gazeX', 'gazeY', 'browL', 'browR', 'bodyX', 'bodyY', 'bodyZ']);

const flush = () => new Promise((resolve) => setImmediate(resolve));

function behaviorConfig(extra = {}) {
  return {
    seed: 5,
    idleActions: [],
    presetTargetVerified: true,
    presetChannels: [...ALL_CHANNELS],
    presetDebugEvents: false,
    ...extra,
  };
}

function pickSelection(runtime, context, limit = 160) {
  for (let seed = 0; seed < limit; seed += 1) {
    const selection = runtime.selectPreset({ ...context, seed });
    if (selection.kind === 'preset') return selection;
  }
  return null;
}

function runBehavior(runtime, fromMs, toMs, { stepMs = DT, onTick = null } = {}) {
  for (let at = fromMs; at <= toMs; at += stepMs) {
    const pose = runtime.tick(at);
    if (onTick !== null) onTick(at, pose, runtime.snapshot());
  }
}

/** Fake transport: every frame the ONE writer builds is captured with its tick time. */
function createFakeTransport() {
  const frames = [];
  let clock = 0;
  const transport = {
    connect: async () => {},
    disconnect: async () => {},
    write: async () => ({ ok: true }),
    writeFrame: async (entries) => {
      frames.push({ at: clock, entries: entries.map((entry) => ({ ...entry })) });
      return { ok: true };
    },
    writeMotion: async (payload) => {
      frames.push({ at: clock, entries: (payload.entries ?? []).map((entry) => ({ ...entry })) });
      return { ok: true };
    },
  };
  return {
    frames,
    transport,
    setClock(at) { clock = at; },
  };
}

const ROW_DEFS = Object.freeze({
  headX: { channel: 'headX', inputName: 'P_headX', min: -30, max: 30, injectable: true, verified: true },
  headY: { channel: 'headY', inputName: 'P_headY', min: -30, max: 30, injectable: true, verified: true },
  headZ: { channel: 'headZ', inputName: 'P_headZ', min: -30, max: 30, injectable: true, verified: true },
  breath: { channel: 'breath', inputName: 'P_breath', min: 0, max: 1, injectable: true, verified: true },
  gazeX: { channel: 'gazeX', inputName: 'P_gazeX', min: -1, max: 1, injectable: true, verified: true },
  gazeY: { channel: 'gazeY', inputName: 'P_gazeY', min: -1, max: 1, injectable: true, verified: true },
  bodyX: { channel: 'bodyX', inputName: 'P_bodyX', min: -1, max: 1, injectable: true, verified: true },
  eyeOpenL: { channel: 'eyeOpenL', inputName: 'P_eyeOpenL', min: 0, max: 1, injectable: true, verified: true },
});

function rowsFor(channels, overrides = {}) {
  return channels.map((channel) => ({ ...ROW_DEFS[channel], ...(overrides[channel] ?? {}) }));
}

async function makeIdleRuntime({ config = {}, rows = rowsFor(['headX', 'headY', 'headZ', 'breath', 'gazeX', 'gazeY', 'bodyX']) } = {}) {
  const fake = createFakeTransport();
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
      // This suite isolates the phase-1 HEAD component/expression ownership boundary. The phase-3
      // gaze component (verified gaze) is covered by test/motion-multi-component.mjs.
      componentGazeEnabled: false,
      ...config,
    },
  });
  const connected = await runtime.connect();
  assert.equal(connected.ok, true, `runtime connects (${connected.message ?? ''})`);
  const mapped = await runtime.setChannelMappings(rows, { channelMap: {} });
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
  };
}

const framesWithChannel = (frames, channel) => frames
  .flatMap((frame) => frame.entries)
  .filter((entry) => entry.channel === channel);

const hasChannel = (frames, channel) => framesWithChannel(frames, channel).length > 0;

// ---------------------------------------------------------------------------------------------
// 1. continuous idle writes under hold / no-candidates
// ---------------------------------------------------------------------------------------------
test('1. hold / no-candidates 下连续 idle 帧仍写 headX/Y/Z/breath，不冻结', async () => {
  const rig = await makeIdleRuntime({ config: { presetExecution: true } });
  rig.runtime.setPresetOverrides({ disabledFamilies: ALL_FAMILIES });
  rig.fake.frames.length = 0;
  for (let at = 0; at <= 12_000; at += DT) await rig.tick(at);

  const snapshot = rig.runtime.snapshot();
  const presets = snapshot.motion.presets;
  assert.ok(presets.holds > 0, 'the disabled family set really drew a hold');
  assert.equal(presets.starts, 0, 'no preset trajectory was started');
  const trace = presets.lastTrace;
  assert.equal(trace.selection.kind, 'hold');
  assert.deepEqual(trace.output.channels, []);

  for (const channel of [...HEAD_CHANNELS, 'breath']) {
    assert.ok(hasChannel(rig.fake.frames, channel), `${channel} was still written under hold`);
  }
  const headX = framesWithChannel(rig.fake.frames, 'headX').map((entry) => entry.value);
  assert.ok(headX.length > 10, `enough headX rows (${headX.length})`);
  assert.ok(Math.max(...headX) - Math.min(...headX) > 0.01,
    'headX is not frozen (the base activity layer keeps moving)');
  for (const channel of UNVERIFIED_IDLE_CHANNELS) {
    assert.equal(hasChannel(rig.fake.frames, channel), false, `${channel} is not an idle write channel`);
  }
  rig.runtime.dispose();
});

// ---------------------------------------------------------------------------------------------
// 2. after a complete preset: the base frame keeps writing, never frozen
// ---------------------------------------------------------------------------------------------
test('2. 完整动作结束后连续 idle 帧仍写 headX/Y/Z/breath（exit→0，基础层继续）', async () => {
  const rig = await makeIdleRuntime({ config: { presetExecution: false } });
  let started = null;
  for (let seed = 0; seed < 160 && started === null; seed += 1) {
    const drawn = rig.runtime.preset({ state: 'idle', event: 'idle', recipe: 'idle-side', seed, at: 1000 });
    if (drawn.started === true) started = drawn;
  }
  assert.ok(started !== null, 'idle-side started');
  const endAt = 1000 + started.durationMs;
  for (let at = 0; at <= endAt + 500; at += DT) await rig.tick(at);
  assert.equal(rig.runtime.snapshot().motion.presets.active.length, 0, 'the action really ended');

  rig.fake.frames.length = 0;
  for (let at = endAt + 500; at <= endAt + 2500; at += DT) await rig.tick(at);
  for (const channel of [...HEAD_CHANNELS, 'breath']) {
    assert.ok(hasChannel(rig.fake.frames, channel), `${channel} continues after the action`);
  }
  const headZ = framesWithChannel(rig.fake.frames, 'headZ').map((entry) => entry.value);
  assert.ok(Math.max(...headZ.map(Math.abs)) < 18 + 1e-6,
    'the post-action frame is the idle/component baseline, not the old preset peak');
  rig.runtime.dispose();
});

// ---------------------------------------------------------------------------------------------
// 3. component hold band + semantic amplitude cap
// ---------------------------------------------------------------------------------------------
test('3. 组件保持 POSTURE_COMPONENT_MIN_MS–MAX_MS，语义幅度 ≤0.40（30°单位）', () => {
  const runtime = createBehaviorRuntime({
    config: behaviorConfig({
      postureHoldMinMs: 60_000,
      postureHoldMaxMs: 60_000,
      postureHoldChance: 1,
      postureStillChance: 0,
      postureComponentMinMs: POSTURE_COMPONENT_MIN_MS,
      postureComponentMaxMs: POSTURE_COMPONENT_MIN_MS,
    }),
  });
  const seenStarts = new Set();
  const durations = [];
  const semantic = [];
  const ids = new Set();
  let previousStart = null;
  let observedEvidence = 0;
  for (let at = 0; at <= POSTURE_COMPONENT_MIN_MS * 3 + 1_000; at += DT) {
    runtime.tick(at);
    const component = runtime.snapshot().motion.posture.component;
    if (component === null) continue;
    ids.add(component.id);
    assert.deepEqual(component.channels, [...POSTURE_COMPONENT_CHANNELS],
      'a component only ever drives the verified head channels');
    for (const channel of POSTURE_COMPONENT_CHANNELS) {
      semantic.push(Math.abs(component.semantic[channel]));
      if (component.observed !== null) {
        observedEvidence += 1;
        assert.ok(Math.abs(component.observed.mixed?.[channel] ?? 0) <= POSTURE_COMPONENT_MAX_AMPLITUDE + 1e-9,
          `${channel} mixed contribution stays inside the semantic cap`);
        assert.ok(Number.isFinite(component.observed.pose?.[channel]),
          `${channel} actual posed value is recorded`);
        assert.equal(Number.isFinite(component.observed.target?.[channel]), true);
      }
    }
    if (component.startedAt !== previousStart) {
      previousStart = component.startedAt;
      seenStarts.add(component.startedAt);
      durations.push(component.durationMs);
    }
  }
  assert.ok(observedEvidence > 0, 'target / mixed / actual-pose evidence was recorded');
  assert.ok(ids.size >= 2, `at least two component shapes were drawn (${[...ids].join(',')})`);
  assert.ok(durations.length >= 2, `component swaps were observed (${durations.length})`);
  for (const duration of durations) {
    assert.ok(duration >= POSTURE_COMPONENT_MIN_MS - 1e-9 && duration <= POSTURE_COMPONENT_MAX_MS + 1e-9,
      `component hold ${duration} ms is inside the 10–20 s band`);
  }
  assert.ok(Math.max(...semantic) <= POSTURE_COMPONENT_MAX_AMPLITUDE + 1e-9,
    `max semantic component ${Math.max(...semantic)} ≤ ${POSTURE_COMPONENT_MAX_AMPLITUDE}`);
  const motion = runtime.snapshot().motion;
  assert.ok(motion.posture.componentTransitions >= 1, 'component swaps are counted separately');
  const last = motion.posture.lastComponentTransition;
  assert.ok(last !== null && last.durationMs >= 1200 && last.durationMs <= 1800,
    `the component swap is interpolated in 1.2–1.8 s (${last?.durationMs} ms)`);
  assert.ok(motion.posture.lastTransition === null
    || motion.posture.lastTransition.kind !== 'component',
  'a component swap never masquerades as an idle re-draw');
});

// ---------------------------------------------------------------------------------------------
// 4. component + full gesture: the gesture rides on top, the component survives
// ---------------------------------------------------------------------------------------------
test('4. 完整手势叠加在组件之上：姿态目标不变，动作结束后回到同一组件', () => {
  const config = behaviorConfig({
    postureHoldMinMs: 60_000,
    postureHoldMaxMs: 60_000,
    postureHoldChance: 1,
    postureStillChance: 0,
    postureComponentMinMs: 10_000,
    postureComponentMaxMs: 10_000,
  });
  const control = createBehaviorRuntime({ config });
  const action = createBehaviorRuntime({ config });
  let componentBefore = null;
  let targetBefore = null;
  let gestureStarted = null;
  let peakDifference = 0;
  let endAt = 0;
  for (let at = 0; at <= 6_000; at += DT) {
    const controlPose = control.tick(at);
    const actionPose = action.tick(at);
    if (gestureStarted === null && at >= 3_000) {
      componentBefore = { ...action.snapshot().motion.posture.component };
      targetBefore = { ...action.snapshot().motion.posture.target };
      const selection = pickSelection(action, { state: 'idle', event: 'idle', recipe: 'idle-side' });
      assert.ok(selection !== null, 'idle-side selection is available');
      gestureStarted = action.startPreset(selection, { at });
      assert.equal(gestureStarted.started, true);
      endAt = at + gestureStarted.durationMs;
    }
    if (gestureStarted !== null) {
      peakDifference = Math.max(peakDifference, Math.abs(actionPose.headX - controlPose.headX));
    }
  }
  assert.ok(peakDifference > 0.05, `the gesture was visible on top of the component (${peakDifference})`);
  const after = action.snapshot();
  assert.equal(after.motion.posture.component.id, componentBefore.id,
    'the preset did not replace the posture component');
  assert.deepEqual(after.motion.posture.component.semantic, componentBefore.semantic,
    'the component target is unchanged by the preset');
  assert.deepEqual(after.motion.posture.target, targetBefore,
    'the preset adds to the idle frame; it never rewrites posture.target');
  assert.equal(after.motion.presets.active.length, 0, 'the action ended');
  assert.ok(control.snapshot().pose && after.pose);
  const controlPose = control.snapshot().pose;
  assert.ok(Math.abs(after.pose.headX - controlPose.headX) < 1e-3,
    `the pose returned to the component baseline (${after.pose.headX} vs ${controlPose.headX})`);
  assert.ok(after.motion.posture.component.observed !== null,
    'target / mixed / actual pose evidence is recorded');
  const observed = after.motion.posture.component.observed;
  for (const channel of HEAD_CHANNELS) {
    assert.ok(Number.isFinite(observed.target[channel]), `observed target.${channel} is recorded`);
    assert.ok(Number.isFinite(observed.semantic[channel]), `observed semantic.${channel} is recorded`);
    assert.ok(Number.isFinite(observed.mixed[channel]), `observed mixed.${channel} is recorded`);
    assert.ok(Number.isFinite(observed.pose[channel]), `observed pose.${channel} is recorded`);
  }
  console.log(`[component+gesture] gesture=${gestureStarted.presetId} peakDiff=${peakDifference.toFixed(3)} `
    + `component=${componentBefore.id} target.headZ=${targetBefore.headZ.toFixed(3)}`);
});

// ---------------------------------------------------------------------------------------------
// 5. a running preset must not snap back to the OLD base: it follows the new base
// ---------------------------------------------------------------------------------------------
test('5. 动作期间更换基础姿态：结束后跟随新基础姿态，不跳回旧姿态', () => {
  const config = behaviorConfig({
    postureHoldMinMs: 1_200,
    postureHoldMaxMs: 1_200,
    postureHoldChance: 0,
    postureStillChance: 0,
  });
  const control = createBehaviorRuntime({ config });
  const action = createBehaviorRuntime({ config });
  let started = null;
  let targetAtStart = null;
  for (let at = 0; at <= 9_000; at += DT) {
    control.tick(at);
    action.tick(at);
    if (started === null && at >= 3_000) {
      const selection = pickSelection(action, { state: 'idle', event: 'idle', recipe: 'idle-side' });
      assert.ok(selection !== null);
      targetAtStart = { ...action.snapshot().motion.posture.target };
      started = action.startPreset(selection, { at });
      assert.equal(started.started, true);
    }
  }
  const controlMotion = control.snapshot().motion;
  const actionMotion = action.snapshot().motion;
  assert.ok(actionMotion.posture.target.headX !== targetAtStart.headX,
    'the base posture really changed while the action ran');
  assert.deepEqual(actionMotion.posture.target, controlMotion.posture.target,
    'the action and the control converged on the SAME current base target');
  const actionPose = action.snapshot().pose;
  const controlPose = control.snapshot().pose;
  for (const channel of HEAD_CHANNELS) {
    assert.ok(Math.abs(actionPose[channel] - controlPose[channel]) < 1e-6,
      `${channel} followed the new base instead of the old preset pose`);
  }
  console.log(`[follow-new-base] old=${targetAtStart.headX.toFixed(3)} `
    + `new=${controlMotion.posture.target.headX.toFixed(3)} diff=${Math.abs(actionPose.headX - controlPose.headX)}`);
});

// ---------------------------------------------------------------------------------------------
// 6. centre/recenter: no overlap overshoot, returns to the current natural baseline
// ---------------------------------------------------------------------------------------------
test('6. head-center 重叠不过冲、结束确实回基线（不回零点/旧帧）', () => {
  const config = behaviorConfig({
    postureHoldMinMs: 60_000,
    postureHoldMaxMs: 60_000,
    postureHoldChance: 1,
    postureStillChance: 0,
    postureComponentMinMs: 10_000,
    postureComponentMaxMs: 10_000,
  });
  const control = createBehaviorRuntime({ config });
  const action = createBehaviorRuntime({ config });
  let side = null;
  let center = null;
  let sidePeak = 0;
  let maxPast = 0;
  let minPast = 0;
  const rawDiffs = [];
  for (let at = 0; at <= 5_000; at += DT) {
    const controlPose = control.tick(at);
    const actionPose = action.tick(at);
    if (side === null) {
      const selection = pickSelection(action, { state: 'idle', event: 'idle', recipe: 'idle-side' });
      assert.ok(selection !== null);
      side = action.startPreset(selection, { at });
      assert.equal(side.started, true);
    }
    if (center === null && at >= 600) {
      const selection = pickSelection(action, { state: 'idle', event: 'idle', recipe: 'idle-center' });
      assert.ok(selection !== null, 'idle-center selection is available');
      center = action.startPreset(selection, { at });
      assert.equal(center.started, true);
    }
    if (side !== null) rawDiffs.push(actionPose.headX - controlPose.headX);
  }
  // The side direction comes from the observed difference, not from a guess about the draw sign.
  const strongest = rawDiffs.reduce((best, value) => (Math.abs(value) > Math.abs(best) ? value : best), 0);
  const sideSign = Math.sign(strongest) || 1;
  for (const raw of rawDiffs) {
    const signed = raw * sideSign;
    maxPast = Math.max(maxPast, signed);
    minPast = Math.min(minPast, signed);
  }
  const sideTrace = action.snapshot().motion.presets.recent
    .find((entry) => entry.selection.presetId === side.presetId);
  // The observed side excursion, not only the trajectory's own peak: the base/component is part
  // of the actual action-vs-control difference, so a larger (but still legal) base must not look
  // like an overshoot introduced by the centre operation.
  sidePeak = Math.max(
    sideTrace?.output?.peak ?? 0,
    ...rawDiffs.map((value) => Math.abs(value)),
  );
  const finalDiff = Math.abs(action.snapshot().pose.headX - control.snapshot().pose.headX);
  assert.ok(finalDiff < 1e-3, `the pose returned to the current baseline (${finalDiff})`);
  assert.ok(maxPast <= sidePeak + 0.03,
    `no overshoot past the side peak (${maxPast} vs ${sidePeak})`);
  assert.ok(minPast >= -0.03,
    `no overshoot past the baseline in the opposite direction (${minPast})`);
  assert.ok(center.trace.output.reason === 'running' || center.trace.output.reason === 'completed'
    || action.snapshot().motion.presets.lastTrace?.selection?.presetId === center.presetId);
  console.log(`[center] sidePeak=${sidePeak.toFixed(3)} maxPast=${maxPast.toFixed(3)} `
    + `minPast=${minPast.toFixed(3)} finalDiff=${finalDiff.toFixed(6)}`);
});

// ---------------------------------------------------------------------------------------------
// 7. channel ownership: only verified head channels; body/gaze stay idle-unwritten
// ---------------------------------------------------------------------------------------------
test('7. 组件只驱动 headX/Y/Z；body/gaze 无 idle 行，breath 走独立行', async () => {
  const rig = await makeIdleRuntime({ config: { presetExecution: false } });
  rig.fake.frames.length = 0;
  for (let at = 0; at <= 8_000; at += DT) await rig.tick(at);
  const snapshot = rig.runtime.snapshot();
  const component = snapshot.motion.posture.component;
  assert.ok(component !== null);
  assert.deepEqual(component.channels, [...POSTURE_COMPONENT_CHANNELS]);
  assert.deepEqual(Object.keys(component.target).sort(), ['headX', 'headY', 'headZ']);
  for (const channel of HEAD_CHANNELS) {
    assert.ok(hasChannel(rig.fake.frames, channel), `${channel} has idle rows`);
  }
  assert.ok(hasChannel(rig.fake.frames, 'breath'), 'breath still has its own verified row');
  for (const channel of UNVERIFIED_IDLE_CHANNELS) {
    assert.equal(hasChannel(rig.fake.frames, channel), false, `${channel} is not in the idle write set`);
  }
  assert.equal(hasChannel(rig.fake.frames, 'eyeOpenL'), false,
    'eye-open is opt-in and untouched by default');
  const headWrites = HEAD_CHANNELS
    .flatMap((channel) => framesWithChannel(rig.fake.frames, channel))
    .map((entry) => Math.abs(entry.value));
  assert.ok(headWrites.length > 0);
  assert.ok(Math.max(...headWrites) <= 18 + 1e-6,
    `actual head writes stay inside the default idle head budget (${Math.max(...headWrites).toFixed(2)}°)`);
  rig.runtime.dispose();
});

// ---------------------------------------------------------------------------------------------
// 8. 0.15 semantic bound holds across personas and statuses
// ---------------------------------------------------------------------------------------------
test('8. 0.40 语义上界：默认/活泼/安静人设、idle/listening 均不越界', () => {
  const styles = [
    { label: 'default', style: null },
    { label: 'lively', style: { amplitude: 1.35, tempo: 1.35, nodAmplitude: 1.3, expressiveness: 1.4, tiltChance: 0.4, nodDurationMs: 350 } },
    { label: 'quiet', style: { amplitude: 0.55, tempo: 0.8, nodAmplitude: 0.5, expressiveness: 0.6, tiltChance: 0.05, nodDurationMs: 700 } },
  ];
  let maxSemantic = 0;
  for (const entry of styles) {
    for (const status of ['idle', 'listening']) {
      for (let seed = 0; seed < 3; seed += 1) {
        const runtime = createBehaviorRuntime({
          config: behaviorConfig({
            seed,
            status,
            ...(entry.style === null ? {} : { style: entry.style }),
          }),
        });
        for (let at = 0; at <= 45_000; at += DT) {
          runtime.tick(at);
          const component = runtime.snapshot().motion.posture.component;
          if (component === null) continue;
          assert.ok(component.amplitude <= POSTURE_COMPONENT_MAX_AMPLITUDE + 1e-9,
            `${entry.label}/${status} amplitude ${component.amplitude}`);
          for (const channel of POSTURE_COMPONENT_CHANNELS) {
            const value = Math.abs(component.semantic[channel]);
            maxSemantic = Math.max(maxSemantic, value);
            assert.ok(value <= POSTURE_COMPONENT_MAX_AMPLITUDE + 1e-9,
              `${entry.label}/${status}/${channel} semantic ${value} ≤ ${POSTURE_COMPONENT_MAX_AMPLITUDE}`);
          }
        }
      }
    }
  }
  assert.ok(maxSemantic > 0.01, `a real component amplitude was measured (${maxSemantic})`);
  console.log(`[components] maxSemantic=${maxSemantic.toFixed(4)} cap=${POSTURE_COMPONENT_MAX_AMPLITUDE}`);
});

// ---------------------------------------------------------------------------------------------
// 9. interrupt / relax clear the component
// ---------------------------------------------------------------------------------------------
test('9. interrupt/relax 清组件：目标归零、不复活旧组件', () => {
  const interruptRuntime = createBehaviorRuntime({
    config: behaviorConfig({
      postureHoldMinMs: 60_000,
      postureHoldMaxMs: 60_000,
      postureHoldChance: 1,
      postureStillChance: 0,
    }),
  });
  runBehavior(interruptRuntime, 0, 5_000);
  const before = interruptRuntime.snapshot().motion.posture.component;
  assert.ok(before !== null);
  interruptRuntime.interrupt({ reason: 'component-test' });
  const interrupted = interruptRuntime.snapshot().motion;
  assert.equal(interrupted.posture.component, null, 'interrupt clears the component');
  assert.equal(interrupted.posture.componentPaused, true);
  for (const channel of HEAD_CHANNELS) {
    assert.ok(Math.abs(interrupted.posture.target[channel]) < 1e-9, `${channel} target reset to rest`);
  }
  runBehavior(interruptRuntime, 5_033, 8_000);
  const afterInterrupt = interruptRuntime.snapshot().motion.posture;
  assert.equal(afterInterrupt.component, null, 'the old component never revived');

  const relaxRuntime = createBehaviorRuntime({
    config: behaviorConfig({
      postureHoldMinMs: 60_000,
      postureHoldMaxMs: 60_000,
      postureHoldChance: 1,
      postureStillChance: 0,
    }),
  });
  runBehavior(relaxRuntime, 0, 5_000);
  assert.ok(relaxRuntime.snapshot().motion.posture.component !== null);
  const relaxed = relaxRuntime.relax({ at: 5_000 });
  assert.equal(relaxed.ok, true);
  assert.equal(relaxRuntime.snapshot().motion.posture.component, null, 'relax clears the component');
  runBehavior(relaxRuntime, 5_033, 9_500);
  const afterRelax = relaxRuntime.snapshot().motion.posture;
  assert.equal(afterRelax.component, null, 'the component does not revive during/after relax');
  for (const channel of HEAD_CHANNELS) {
    assert.ok(Math.abs(afterRelax.target[channel]) < 1e-9, `relax leaves ${channel} at the base`);
  }
});

// ---------------------------------------------------------------------------------------------
// 10. privacy / idle-off / disconnect stop writes
// ---------------------------------------------------------------------------------------------
test('10. 隐私锁、总开关 idle:false、断连：停止写入', async () => {
  const rig = await makeIdleRuntime({ config: { presetExecution: false } });
  for (let at = 0; at <= 2_000; at += DT) await rig.tick(at);
  assert.ok(hasChannel(rig.fake.frames, 'headX'), 'baseline idle frames are flowing');
  assert.ok(hasChannel(rig.fake.frames, 'breath'), 'baseline breath frames are flowing');

  rig.runtime.lock('privacy-test');
  rig.fake.frames.length = 0;
  for (let at = 2_000; at <= 4_000; at += DT) await rig.tick(at);
  assert.equal(rig.fake.frames.length, 0, 'privacy lock writes nothing');
  rig.runtime.unlock();
  for (let at = 4_000; at <= 5_000; at += DT) await rig.tick(at);
  assert.ok(hasChannel(rig.fake.frames, 'headX'), 'unlock resumes the writer');

  rig.runtime.setIntent({ flags: { idle: false } });
  rig.fake.frames.length = 0;
  for (let at = 5_000; at <= 6_000; at += DT) await rig.tick(at);
  assert.equal(rig.fake.frames.length, 0, 'the explicit idle:false master switch stops idle frames');
  rig.runtime.setIntent({ flags: { idle: true } });
  for (let at = 6_000; at <= 7_000; at += DT) await rig.tick(at);
  assert.ok(hasChannel(rig.fake.frames, 'headX'), 'idle:true resumes');

  await rig.runtime.disconnect();
  rig.fake.frames.length = 0;
  for (let at = 7_000; at <= 8_000; at += DT) await rig.tick(at);
  assert.equal(rig.fake.frames.length, 0, 'disconnect writes nothing');
  rig.runtime.dispose();
});

// ---------------------------------------------------------------------------------------------
// 11. enabling preset execution clears the old discrete idle queue
// ---------------------------------------------------------------------------------------------
test('11. 开启 preset 时清空旧离散 idle 队列，启用前入队的动作不泄漏', () => {
  const runtime = createBehaviorRuntime({
    config: {
      seed: 7,
      idleActions: ['sway'],
      idleActionIntervalMs: 100,
      idleActionDedupeMs: 0,
      presetExecution: false,
    },
  });
  runBehavior(runtime, 0, 600);
  const emittedBefore = runtime.snapshot().idleActions.emitted;
  assert.ok(runtime.snapshot().idleActions.queued > 0,
    'the legacy pool sampled at least one action before the switch');
  runtime.setPresetExecution(true, { at: 600 });
  assert.equal(runtime.snapshot().idleActions.queued, 0, 'the old queue was cleared');
  assert.deepEqual(runtime.takeActions(), [], 'nothing queued before the switch can leak');
  runBehavior(runtime, 633, 2_000);
  assert.equal(runtime.snapshot().idleActions.emitted, emittedBefore,
    'no new legacy action was emitted after the switch');
});

// ---------------------------------------------------------------------------------------------
// 12. deterministic seed across the component layer
// ---------------------------------------------------------------------------------------------
test('12. 同 seed 复现组件轨迹，异 seed 不同', () => {
  const run = (seed) => {
    const runtime = createBehaviorRuntime({ config: behaviorConfig({ seed }) });
    const rows = [];
    for (let at = 0; at <= 30_000; at += DT) {
      const pose = runtime.tick(at);
      const component = runtime.snapshot().motion.posture.component;
      rows.push([
        pose.headX, pose.headY, pose.headZ,
        component?.id ?? null,
        component?.startedAt ?? null,
        component?.semantic?.headZ ?? null,
      ]);
    }
    return { rows, motion: runtime.snapshot().motion };
  };
  const first = run(4242);
  const second = run(4242);
  const other = run(4243);
  assert.deepEqual(first.rows, second.rows, 'the same seed produced a different component trajectory');
  assert.notDeepEqual(first.rows, other.rows, 'a different seed produced an identical trajectory');
  assert.ok(first.motion.posture.componentHistory.length >= 1);
  console.log(`[determinism] frames=${first.rows.length} sameSeed=true otherSeedDiffers=true`);
});

// ---------------------------------------------------------------------------------------------
// 13. listening/thinking moves are occasional, not structurally zero
// ---------------------------------------------------------------------------------------------
test('13. listening/thinking 120 s 内 moves>0，且不连续抖动', () => {
  const run = (status, seed) => {
    const runtime = createBehaviorRuntime({ config: behaviorConfig({ status, seed }) });
    const moveTimes = [];
    let previousSwitches = 0;
    let lastMoveAt = Number.NEGATIVE_INFINITY;
    let minGap = Number.POSITIVE_INFINITY;
    for (let at = 0; at <= 120_000; at += DT) {
      runtime.tick(at);
      const motion = runtime.snapshot().motion;
      // Count the counter, not the (possibly overwritten) lastDecision string: two valid moves
      // may be separated by a component swap, and a consecutive moved decision is still a move.
      while (motion.postureSwitches > previousSwitches) {
        previousSwitches += 1;
        moveTimes.push(at);
        if (Number.isFinite(lastMoveAt)) minGap = Math.min(minGap, at - lastMoveAt);
        lastMoveAt = at;
      }
    }
    return { motion: runtime.snapshot().motion, moveTimes, minGap };
  };
  const listening = run('listening', 9);
  const thinking = run('thinking', 2);
  for (const [status, result] of [['listening', listening], ['thinking', thinking]]) {
    assert.ok(result.motion.postureSwitches > 0,
      `${status} really moved (${result.motion.postureSwitches})`);
    assert.ok(result.motion.postureSwitches <= result.motion.postureDecisions * 0.4,
      `${status} stayed mostly quiet (${result.motion.postureSwitches}/${result.motion.postureDecisions})`);
    assert.ok(result.motion.posture.componentTransitions > 0,
      `${status} still ran the component layer`);
    if (Number.isFinite(result.minGap)) {
      assert.ok(result.minGap >= 5_000, `${status} moves are spaced (${result.minGap} ms)`);
    }
  }
  console.log(`[moves] listening=${listening.motion.postureSwitches}/${listening.motion.postureDecisions} `
    + `thinking=${thinking.motion.postureSwitches}/${thinking.motion.postureDecisions} `
    + `times=${listening.moveTimes.map((at) => Math.round(at)).join(',')}`);
});

// ---------------------------------------------------------------------------------------------
// 14. back-to-back triggers/cancel: no accumulated drift, no final overshoot
// ---------------------------------------------------------------------------------------------
test('14. 连续触发/打断：无累积漂移，回落到控制组基线', () => {
  const config = behaviorConfig({
    postureHoldMinMs: 60_000,
    postureHoldMaxMs: 60_000,
    postureHoldChance: 1,
    postureStillChance: 0,
    postureComponentMinMs: 10_000,
    postureComponentMaxMs: 10_000,
  });
  const control = createBehaviorRuntime({ config });
  const action = createBehaviorRuntime({ config });
  let maxStep = 0;
  let previous = null;
  const selections = ['idle-side', 'idle-tilt', 'idle-down'];
  let startedAt = 0;
  let index = 0;
  let active = null;
  for (let at = 0; at <= 10_000; at += DT) {
    control.tick(at);
    const pose = action.tick(at);
    if (previous !== null) {
      maxStep = Math.max(maxStep, Math.abs(pose.headX - previous.headX), Math.abs(pose.headZ - previous.headZ));
    }
    previous = pose;
    if (active === null && at >= 1_000 && index < selections.length) {
      const selection = pickSelection(action, { state: 'idle', event: 'idle', recipe: selections[index] });
      assert.ok(selection !== null);
      active = action.startPreset(selection, { at });
      assert.equal(active.started, true);
      startedAt = at;
      index += 1;
    } else if (active !== null && at - startedAt >= 350) {
      // Interrupt the tail quickly, then start the next gesture: the spring must not retain a
      // residual excursion from the cancelled action.
      action.cancelPreset({ fadeMs: 120, at });
      active = null;
    }
  }
  const actionPose = action.snapshot().pose;
  const controlPose = control.snapshot().pose;
  assert.ok(action.snapshot().motion.presets.active.length === 0, 'all gestures ended');
  for (const channel of HEAD_CHANNELS) {
    assert.ok(Math.abs(actionPose[channel] - controlPose[channel]) < 0.01,
      `${channel} is back at the control baseline (${actionPose[channel]} vs ${controlPose[channel]})`);
  }
  assert.ok(maxStep < 0.15, `no visible jump between frames (${maxStep.toFixed(4)})`);
  console.log(`[trigger-chain] gestures=${index} maxStep=${maxStep.toFixed(4)} `
    + `drift=${Math.abs(actionPose.headX - controlPose.headX).toFixed(6)}`);
});
