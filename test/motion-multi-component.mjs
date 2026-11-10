/**
 * Phase 3 — multi-component composition and unified arbitration.
 *
 * Scope (explicit): this is the HEAD component (existing 4-shape library) PLUS an independent GAZE
 * component. It is NOT a body/arm implementation: body/arms stay VTS-native and unwritten. The
 * plugin still does not start/stop VTS's native idle animation, and real visual appearance has NOT
 * been verified on a real VTS model.
 *
 * The gaze component exists ONLY while BOTH `gazeX` and `gazeY` are verified plugin-owned channels.
 * An explicit channelMap declaration, a single verified axis or a `native-possible` candidate never
 * opens it. The pure controller receives that gate through `setComponentGazeVerified()/config`;
 * the avatar-runtime facade derives it from the verified takeover set.
 *
 * Units: both components use the writer's 30°-per-semantic-unit convention. The head component is
 * capped at 0.15 semantic (4.5° equivalent); the gaze component at 0.12 semantic (3.6° EQUIVALENT —
 * the VTS gaze input is normalized ±1, so this is 12 % of the eye range, not a measured rotation).
 *
 * Run: node --test test/motion-multi-component.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  POSTURE_COMPONENT_MAX_AMPLITUDE,
  POSTURE_COMPONENT_MAX_MS,
  POSTURE_COMPONENT_MIN_MS,
  POSTURE_GAZE_COMPONENT_MAX_AMPLITUDE,
  POSTURE_GAZE_COMPONENT_MAX_MS,
  POSTURE_GAZE_COMPONENT_MIN_MS,
  createBehaviorRuntime,
} from '../src/host/avatar/motion-controller.js';
import {
  INTENT_IDLE_RATIO,
  createAvatarRuntime,
} from '../src/host/avatar/avatarRuntime.js';
import { PRESETS } from '../src/host/avatar/presets/index.js';

const DT = 1000 / 30;
const HEAD = Object.freeze(['headX', 'headY', 'headZ']);
const GAZE = Object.freeze(['gazeX', 'gazeY']);
const ALL_FAMILIES = [...new Set(PRESETS.map((preset) => preset.family))];
const flush = () => new Promise((resolve) => setImmediate(resolve));

/** Stable posture rhythm so a component test measures the COMPONENT, not a random re-draw. */
function behaviorConfig(extra = {}) {
  return {
    seed: 5,
    idleActions: [],
    presetDebugEvents: false,
    presetTargetVerified: true,
    presetChannels: [
      'headX', 'headY', 'headZ', 'gazeX', 'gazeY', 'browL', 'browR',
      'bodyX', 'bodyY', 'bodyZ', 'eyeOpenL', 'eyeOpenR', 'breath',
    ],
    postureHoldMinMs: 60_000,
    postureHoldMaxMs: 60_000,
    postureHoldChance: 1,
    postureStillChance: 0,
    postureComponentMinMs: 10_000,
    postureComponentMaxMs: 10_000,
    postureGazeComponentMinMs: 6_000,
    postureGazeComponentMaxMs: 6_000,
    componentGazeVerified: true,
    ...extra,
  };
}

function run(runtime, fromMs, toMs, { stepMs = DT, onTick = null } = {}) {
  for (let at = fromMs; at <= toMs; at += stepMs) {
    const pose = runtime.tick(at);
    if (onTick !== null) onTick(at, pose, runtime.snapshot());
  }
}

function pickSelection(runtime, context, limit = 200) {
  for (let seed = 0; seed < limit; seed += 1) {
    const selection = runtime.selectPreset({ ...context, seed });
    if (selection.kind === 'preset') return selection;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// avatar-runtime transport harness
// ---------------------------------------------------------------------------------------------
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
  gazeX: { channel: 'gazeX', inputName: 'P_gazeX', min: -1, max: 1, injectable: true, verified: true },
  gazeY: { channel: 'gazeY', inputName: 'P_gazeY', min: -1, max: 1, injectable: true, verified: true },
  bodyX: { channel: 'bodyX', inputName: 'P_bodyX', min: -1, max: 1, injectable: true, verified: true },
  breath: { channel: 'breath', inputName: 'P_breath', min: 0, max: 1, injectable: true, verified: true },
});

function rowsFor(channels, overrides = {}) {
  return channels.map((channel) => ({ ...ROW_DEFS[channel], ...(overrides[channel] ?? {}) }));
}

async function makeRuntime({ config = {}, rows } = {}) {
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
      seed: 5,
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
// 1. head + gaze coexist; an UNVERIFIED gaze is never written (head still is)
// ---------------------------------------------------------------------------------------------
test('1. 头部+gaze 组合：verified gaze 写出；未验证/native-possible 不写；verified bodyX 走基础层', async (t) => {
  const verified = await makeRuntime({
    rows: rowsFor(['headX', 'headY', 'headZ', 'gazeX', 'gazeY', 'bodyX']),
  });
  t.after(() => verified.runtime.dispose());
  for (let at = 0; at <= 6_000; at += DT) await verified.tick(at);
  const snapshot = verified.runtime.snapshot();
  assert.equal(snapshot.motionLayers.components.gazeVerified, true, 'the verified gate is open');
  assert.equal(snapshot.motionLayers.components.gazeOwnership, 'plugin');
  assert.ok(snapshot.motion.posture.component !== null, 'the head component exists');
  assert.ok(snapshot.motion.posture.gazeComponent !== null, 'the gaze component exists');
  assert.deepEqual(snapshot.motion.posture.gazeComponent.channels, [...GAZE]);
  for (const channel of HEAD) {
    assert.ok(hasChannel(verified.fake.frames, channel), `${channel} is written`);
  }
  for (const channel of GAZE) {
    assert.ok(hasChannel(verified.fake.frames, channel), `${channel} is written when verified`);
  }
  assert.ok(hasChannel(verified.fake.frames, 'bodyX'),
    'a verified bodyX is written by the phase-4 base layer, independent of the head/gaze components');
  assert.equal(verified.runtime.snapshot().channels.bodyArms.writeChannels.includes('bodyX'), true,
    'bodyX is in the verified body/arm write set');
  assert.deepEqual(verified.runtime.snapshot().motion.posture.bodyArms.components.body.channels,
    ['bodyX'], 'only the verified body channel is claimed by the body component');

  // Declared-but-unverified gaze: the head layer keeps writing, gaze is not in the write set.
  const unverified = await makeRuntime({
    rows: rowsFor(['headX', 'headY', 'headZ', 'gazeX', 'gazeY', 'bodyX'], {
      gazeX: { verified: false },
      gazeY: { verified: false },
    }),
  });
  t.after(() => unverified.runtime.dispose());
  for (let at = 0; at <= 6_000; at += DT) await unverified.tick(at);
  const unverifiedSnapshot = unverified.runtime.snapshot();
  assert.equal(unverifiedSnapshot.motionLayers.components.gazeVerified, false,
    'unverified native-possible gaze does not open the gate');
  assert.equal(unverifiedSnapshot.motion.posture.gazeComponent, null,
    'no gaze component is drawn while the gate is closed');
  assert.ok(unverifiedSnapshot.motion.posture.component !== null, 'the head component still runs');
  for (const channel of GAZE) {
    assert.equal(hasChannel(unverified.fake.frames, channel), false,
      `${channel} is never written while unverified`);
  }
  assert.ok(hasChannel(unverified.fake.frames, 'headX'), 'the verified head channel still writes');
  console.log('[multi] verified rows head+gaze, unverified gaze rows=0');
});

// ---------------------------------------------------------------------------------------------
// 2. per-channel caps: head ≤0.15, gaze ≤0.12 (≈3.6° equivalent), no summing past the cap
// ---------------------------------------------------------------------------------------------
test('2. 组合限幅：head 语义 ≤0.15、gaze ≤0.12/3.6° 等效，observed mixed 不越界', () => {
  const runtime = createBehaviorRuntime({
    config: behaviorConfig({ seed: 11, postureComponentMinMs: 10_000, postureComponentMaxMs: 20_000 }),
  });
  let maxHeadSemantic = 0;
  let maxHeadMixed = 0;
  let maxGazeSemantic = 0;
  let maxGazeMixed = 0;
  let maxGazeDegrees = 0;
  let maxRoll = 0;
  for (let at = 0; at <= 60_000; at += DT) {
    const pose = runtime.tick(at);
    const motion = runtime.snapshot().motion;
    const head = motion.posture.component;
    if (head !== null) {
      for (const channel of HEAD) {
        const semantic = Math.abs(head.semantic[channel] ?? 0);
        maxHeadSemantic = Math.max(maxHeadSemantic, semantic);
        assert.ok(semantic <= POSTURE_COMPONENT_MAX_AMPLITUDE + 1e-9,
          `head ${channel} semantic ${semantic} ≤ 0.15`);
        const mixed = Math.abs(head.observed?.mixed?.[channel] ?? 0);
        maxHeadMixed = Math.max(maxHeadMixed, mixed);
        assert.ok(mixed <= POSTURE_COMPONENT_MAX_AMPLITUDE + 1e-9,
          `head ${channel} mixed ${mixed} ≤ 0.15`);
      }
    }
    const gaze = motion.posture.gazeComponent;
    if (gaze !== null) {
      for (const channel of GAZE) {
        const value = Math.abs(gaze.value[channel] ?? 0);
        maxGazeSemantic = Math.max(maxGazeSemantic, value);
        assert.ok(value <= POSTURE_GAZE_COMPONENT_MAX_AMPLITUDE + 1e-9,
          `gaze ${channel} semantic ${value} ≤ 0.12`);
        const mixed = Math.abs(gaze.observed?.mixed?.[channel] ?? 0);
        maxGazeMixed = Math.max(maxGazeMixed, mixed);
        assert.ok(mixed <= POSTURE_GAZE_COMPONENT_MAX_AMPLITUDE + 1e-9,
          `gaze ${channel} mixed ${mixed} ≤ 0.12`);
        const degrees = Math.abs(gaze.degrees[channel] ?? 0);
        maxGazeDegrees = Math.max(maxGazeDegrees, degrees);
        assert.ok(degrees <= POSTURE_GAZE_COMPONENT_MAX_AMPLITUDE * 30 + 1e-9,
          `gaze ${channel} ${degrees}° equivalent ≤ 3.6°`);
      }
    }
    maxRoll = Math.max(maxRoll, Math.abs(pose.headZ));
    assert.ok(Math.abs(pose.headZ) <= 14 / 30 + 1e-9, 'the composed roll stays inside the 14° budget');
  }
  assert.ok(maxHeadSemantic > 0.01 && maxGazeSemantic > 0.01, 'both components really moved');
  assert.ok(maxHeadMixed > 0.005 && maxGazeMixed > 0.005, 'both mixed contributions were observed');

  // A status switch changes the live head gain. A component drawn on a quiet/tired baseline must
  // still stay ≤0.15 after switching back to the larger idle gain (the per-frame cap, not the
  // draw-time value, is the guarantee). The shape draw is random, so scan a few fixed seeds until
  // one really produces an un-capped request above the cap.
  let sawUncappedOverCap = false;
  let cappedMax = 0;
  for (let seed = 0; seed < 30 && sawUncappedOverCap !== true; seed += 1) {
    const gainRuntime = createBehaviorRuntime({
      config: behaviorConfig({
        seed,
        status: 'tired',
        postureComponentMinMs: 10_000,
        postureComponentMaxMs: 10_000,
      }),
    });
    run(gainRuntime, 0, 1_000);
    gainRuntime.setStatus('idle');
    for (let at = 1_033; at <= 2_000; at += DT) {
      gainRuntime.tick(at);
      const observed = gainRuntime.snapshot().motion.posture.component?.observed;
      if (observed === null || observed === undefined) continue;
      for (const channel of HEAD) {
        const uncapped = Math.abs(observed.uncapped?.[channel] ?? 0);
        const capped = Math.abs(observed.mixed?.[channel] ?? 0);
        cappedMax = Math.max(cappedMax, capped);
        if (uncapped > POSTURE_COMPONENT_MAX_AMPLITUDE + 1e-6) sawUncappedOverCap = true;
        assert.ok(capped <= POSTURE_COMPONENT_MAX_AMPLITUDE + 1e-9,
          `status-switched ${channel} mixed ${capped} ≤ 0.15`);
      }
    }
  }
  assert.ok(sawUncappedOverCap,
    'at least one seed really pushed the un-capped request over the cap after the status switch');
  assert.ok(cappedMax <= POSTURE_COMPONENT_MAX_AMPLITUDE + 1e-9);
  console.log(
    `[caps] headSem=${maxHeadSemantic.toFixed(4)}/${POSTURE_COMPONENT_MAX_AMPLITUDE}`
    + ` gazeSem=${maxGazeSemantic.toFixed(4)}/${POSTURE_GAZE_COMPONENT_MAX_AMPLITUDE}`
    + ` gazeDeg=${maxGazeDegrees.toFixed(2)} mixed=${maxHeadMixed.toFixed(4)}/${maxGazeMixed.toFixed(4)}`
    + ` rollDeg=${(maxRoll * 30).toFixed(2)} gainSwitchCapped=${cappedMax.toFixed(3)}`,
  );
});

// ---------------------------------------------------------------------------------------------
// 3. the two components keep INDEPENDENT windows and rotate separately
// ---------------------------------------------------------------------------------------------
test('3. 两组件独立保持/轮替：head 10–20 s，gaze 6–12 s，互不重绘', () => {
  const runtime = createBehaviorRuntime({
    config: behaviorConfig({
      seed: 17,
      postureComponentMinMs: POSTURE_COMPONENT_MIN_MS,
      postureComponentMaxMs: POSTURE_COMPONENT_MAX_MS,
      postureGazeComponentMinMs: POSTURE_GAZE_COMPONENT_MIN_MS,
      postureGazeComponentMaxMs: POSTURE_GAZE_COMPONENT_MAX_MS,
    }),
  });
  const headDurations = [];
  const gazeDurations = [];
  let head = null;
  let gaze = null;
  let gazeSwapsUnderSameHead = 0;
  let headIdAtLastGazeSwap = null;
  for (let at = 0; at <= 70_000; at += DT) {
    runtime.tick(at);
    const posture = runtime.snapshot().motion.posture;
    if (posture.component !== null && posture.component.startedAt !== head?.startedAt) {
      head = { startedAt: posture.component.startedAt, id: posture.component.id, durationMs: posture.component.durationMs };
      headDurations.push(head.durationMs);
    }
    if (posture.gazeComponent !== null && posture.gazeComponent.startedAt !== gaze?.startedAt) {
      const currentHeadId = posture.component?.id ?? null;
      if (gaze !== null && currentHeadId === headIdAtLastGazeSwap) gazeSwapsUnderSameHead += 1;
      headIdAtLastGazeSwap = currentHeadId;
      gaze = {
        startedAt: posture.gazeComponent.startedAt,
        id: posture.gazeComponent.id,
        durationMs: posture.gazeComponent.durationMs,
      };
      gazeDurations.push(gaze.durationMs);
    }
  }
  assert.ok(headDurations.length >= 3, `head rotated ${headDurations.length} times`);
  assert.ok(gazeDurations.length > headDurations.length,
    `gaze rotated more often (${gazeDurations.length} vs ${headDurations.length})`);
  assert.ok(gazeSwapsUnderSameHead >= 2,
    `gaze swapped while the head component stayed the same (${gazeSwapsUnderSameHead})`);
  for (const duration of headDurations) {
    assert.ok(duration >= POSTURE_COMPONENT_MIN_MS - 1e-9 && duration <= POSTURE_COMPONENT_MAX_MS + 1e-9,
      `head hold ${duration} ms is inside 10–20 s`);
  }
  for (const duration of gazeDurations) {
    assert.ok(duration >= POSTURE_GAZE_COMPONENT_MIN_MS - 1e-9
      && duration <= POSTURE_GAZE_COMPONENT_MAX_MS + 1e-9,
    `gaze hold ${duration} ms is inside 6–12 s`);
  }
  console.log(
    `[independent] head=${headDurations.length} gaze=${gazeDurations.length}`
    + ` gazeSwapsUnderSameHead=${gazeSwapsUnderSameHead}`,
  );
});

// ---------------------------------------------------------------------------------------------
// 4. same-channel preset conflict: preset keeps its expression, component yields, then recovers
// ---------------------------------------------------------------------------------------------
test('4. 同通道冲突：preset 保留表达，组件目标让位/减幅，preset 结束后平滑回组件', () => {
  const config = behaviorConfig({
    seed: 21,
    postureComponentMinMs: 10_000,
    postureComponentMaxMs: 10_000,
    postureGazeComponentMinMs: 6_000,
    postureGazeComponentMaxMs: 6_000,
  });
  const control = createBehaviorRuntime({ config });
  const action = createBehaviorRuntime({ config });
  run(control, 0, 2_000);
  run(action, 0, 2_000);
  const before = action.snapshot().motion.posture;
  const selection = pickSelection(action, { state: 'idle', event: 'idle', recipe: 'idle-side' });
  assert.ok(selection !== null, 'idle-side selection is available');
  const started = action.startPreset(selection, { at: 2_000 });
  assert.equal(started.started, true);
  let peakHeadDiff = 0;
  let componentYield = null;
  const conflicts = [];
  let presetIdsAtConflict = [];
  for (let at = 2_000; at <= 2_000 + started.durationMs + 2_500; at += DT) {
    const controlPose = control.tick(at);
    const actionPose = action.tick(at);
    peakHeadDiff = Math.max(peakHeadDiff, Math.abs(actionPose.headX - controlPose.headX));
    for (const entry of action.snapshot().motion.arbitration.head) {
      if (entry.channel === 'headX' && Math.abs(entry.gesture) > 1e-4) {
        conflicts.push(entry);
        if (componentYield === null) componentYield = entry;
        presetIdsAtConflict = entry.presetIds;
      }
    }
  }
  assert.ok(peakHeadDiff > 0.03, `the preset was visible on the conflicting channel (${peakHeadDiff})`);
  assert.ok(componentYield !== null, 'the same-channel conflict was recorded');
  assert.ok(conflicts.length > 0, 'the conflict was observed over several frames');
  assert.ok(presetIdsAtConflict.includes(started.presetId), 'the conflict names the preset owner');
  assert.ok(Math.abs(componentYield.componentBefore) > 1e-4, 'the component really contributed before the conflict');
  assert.ok(Math.abs(componentYield.componentAfter) <= Math.abs(componentYield.componentBefore) + 1e-9,
    `component target yielded (${componentYield.componentBefore} → ${componentYield.componentAfter})`);
  assert.ok(componentYield.yieldScale >= 0 && componentYield.yieldScale <= 1 + 1e-9);
  assert.ok(Math.abs(componentYield.componentAfter) <= Math.abs(componentYield.gesture) * INTENT_IDLE_RATIO + 1e-9,
    'the surviving component is inside the INTENT_IDLE_RATIO window');
  // A LARGE gesture leaves the component its full idle share (the cap is wider than the idle base),
  // so "yield" is a reduction under a small gesture, not a permanent zeroing of the component.
  const strong = conflicts.filter((entry) => Math.abs(entry.gesture) > 0.1
    && Math.abs(entry.componentBefore) > 1e-4);
  assert.ok(strong.length > 0, 'a strong gesture conflict was observed');
  const bestRetained = Math.max(...strong.map((entry) => Math.abs(entry.componentAfter) / Math.abs(entry.componentBefore)));
  assert.ok(bestRetained > 0.5,
    `the component keeps its contribution under a strong gesture (retained ${bestRetained})`);
  const after = action.snapshot().motion.posture;
  assert.equal(after.component.id, before.component.id, 'the preset did not replace the component');
  assert.deepEqual(after.component.semantic, before.component.semantic,
    'the head component target is unchanged by the preset');
  assert.deepEqual(after.gazeComponent?.id, before.gazeComponent?.id, 'the gaze component survived');
  assert.equal(action.snapshot().motion.presets.active.length, 0, 'the preset ended');
  const actionPose = action.snapshot().pose;
  const controlPose = control.snapshot().pose;
  for (const channel of HEAD) {
    assert.ok(Math.abs(actionPose[channel] - controlPose[channel]) < 2e-3,
      `${channel} returned to the component baseline (${actionPose[channel]} vs ${controlPose[channel]})`);
  }
  console.log(
    `[conflict] preset=${started.presetId} peak=${peakHeadDiff.toFixed(3)}`
    + ` yield=${componentYield.componentBefore.toFixed(3)}→${componentYield.componentAfter.toFixed(3)}`
    + ` final=${Math.abs(actionPose.headX - controlPose.headX).toFixed(6)}`,
  );
});

// ---------------------------------------------------------------------------------------------
// 4b. a gaze preset conflict: the preset keeps its eye expression, the component yields
// ---------------------------------------------------------------------------------------------
test('4b. gaze 通道冲突：preset 保留表达，gaze 组件让位，结束回组件', () => {
  const config = behaviorConfig({
    seed: 23,
    postureComponentMinMs: 10_000,
    postureGazeComponentMinMs: 6_000,
    postureGazeComponentMaxMs: 6_000,
  });
  const control = createBehaviorRuntime({ config });
  const action = createBehaviorRuntime({ config });
  run(control, 0, 2_000);
  run(action, 0, 2_000);
  const before = action.snapshot().motion.posture.gazeComponent;
  assert.ok(before !== null);
  const selection = pickSelection(action, { state: 'idle', event: 'idle', recipe: 'idle-eye-side' });
  assert.ok(selection !== null, 'idle-eye-side selection is available');
  const started = action.startPreset(selection, { at: 2_000 });
  assert.equal(started.started, true);
  let conflict = null;
  let peakGazeDiff = 0;
  for (let at = 2_000; at <= 2_000 + started.durationMs + 2_000; at += DT) {
    const controlPose = control.tick(at);
    const actionPose = action.tick(at);
    peakGazeDiff = Math.max(peakGazeDiff, Math.abs(actionPose.gazeX - controlPose.gazeX));
    for (const entry of action.snapshot().motion.arbitration.gaze) {
      if (Math.abs(entry.gesture) > 1e-4 && entry.presetIds.includes(started.presetId)) {
        conflict = conflict ?? entry;
      }
    }
  }
  assert.ok(peakGazeDiff > 0.01, `the gaze preset was visible (${peakGazeDiff})`);
  assert.ok(conflict !== null, 'the gaze-channel conflict was recorded');
  assert.ok(Math.abs(conflict.componentAfter) <= Math.abs(conflict.componentBefore) + 1e-9,
    'the gaze component yielded to the preset expression');
  assert.ok(Math.abs(conflict.componentAfter) <= Math.abs(conflict.gesture) * INTENT_IDLE_RATIO + 1e-9,
    'the surviving gaze component is inside the arbitration window');
  const after = action.snapshot().motion.posture.gazeComponent;
  assert.ok(after !== null, 'the gaze component was not destroyed by the preset');
  assert.deepEqual(after.value, before.value, 'the gaze component target is unchanged');
  assert.deepEqual(after.id, before.id, 'the gaze component still holds the same direction');
  const actionPose = action.snapshot().pose;
  const controlPose = control.snapshot().pose;
  for (const channel of GAZE) {
    assert.ok(Math.abs(actionPose[channel] - controlPose[channel]) < 3e-3,
      `${channel} returned to the component baseline (${actionPose[channel]} vs ${controlPose[channel]})`);
  }
  console.log(
    `[gaze-conflict] preset=${started.presetId} peak=${peakGazeDiff.toFixed(4)}`
    + ` yield=${conflict.componentBefore.toFixed(4)}→${conflict.componentAfter.toFixed(4)}`,
  );
});

// ---------------------------------------------------------------------------------------------
// 5. old preset exit cannot overwrite a newer action on the same channel
// ---------------------------------------------------------------------------------------------
test('5. 旧 preset 收尾不覆盖新动作：退出尾被抑制，新动作继续', () => {
  const runtime = createBehaviorRuntime({
    config: behaviorConfig({ seed: 29, postureComponentMinMs: 10_000, postureGazeComponentMinMs: 6_000 }),
  });
  runtime.tick(0);
  const firstSelection = pickSelection(runtime, { state: 'idle', event: 'idle', recipe: 'idle-side' });
  assert.ok(firstSelection !== null);
  const first = runtime.startPreset(firstSelection, { at: 1_000 });
  assert.equal(first.started, true);
  assert.ok(first.durationMs > 600, `the first action is long enough to overlap (${first.durationMs} ms)`);
  run(runtime, 1_033, 1_000 + first.durationMs - 220);
  const secondSelection = pickSelection(runtime, { state: 'idle', event: 'idle', recipe: 'idle-side' });
  assert.ok(secondSelection !== null);
  const secondAt = 1_000 + first.durationMs - 200;
  const second = runtime.startPreset(secondSelection, { at: secondAt });
  assert.equal(second.started, true);
  let suppressed = null;
  for (let at = secondAt; at <= secondAt + 500; at += DT) {
    runtime.tick(at);
    const entries = runtime.snapshot().motion.arbitration.suppressedExits;
    const hit = entries.find((entry) => entry.presetId === first.presetId && entry.channel === 'headX');
    if (hit !== undefined) suppressed = hit;
  }
  assert.ok(suppressed !== null, 'the old action EXIT on the shared channel was suppressed');
  assert.match(suppressed.reason, /exit|cancel-fade/u);
  const active = runtime.snapshot().motion.presets.active;
  assert.equal(active.some((item) => item.startedAt === 1_000), false, 'the old trajectory ended');
  assert.equal(active.some((item) => item.startedAt === secondAt), true,
    'the newer trajectory is the one still running');
  console.log(`[exit-guard] suppressed=${suppressed.presetId}/${suppressed.channel} (${suppressed.reason})`);
});

// ---------------------------------------------------------------------------------------------
// 6. status switches and component swaps during an action stay continuous
// ---------------------------------------------------------------------------------------------
test('6. 动作期间换状态/换组件：组件不重置、姿态连续、结束回当前组件', () => {
  const config = behaviorConfig({
    seed: 33,
    postureComponentMinMs: 10_000,
    postureComponentMaxMs: 10_000,
    postureGazeComponentMinMs: 6_000,
    postureGazeComponentMaxMs: 6_000,
  });
  const control = createBehaviorRuntime({ config });
  const action = createBehaviorRuntime({ config });
  const statusAt = [[2_000, 'listening'], [4_000, 'thinking'], [6_000, 'speaking'], [8_000, 'idle']];
  let statusIndex = 0;
  let started = null;
  let previousPose = null;
  let maxStep = 0;
  let swapsDuringAction = 0;
  let previousComponentStart = null;
  for (let at = 0; at <= 14_000; at += DT) {
    while (statusIndex < statusAt.length && at >= statusAt[statusIndex][0]) {
      const status = statusAt[statusIndex][1];
      control.setStatus(status);
      action.setStatus(status);
      statusIndex += 1;
    }
    control.tick(at);
    const pose = action.tick(at);
    if (previousPose !== null) {
      maxStep = Math.max(
        maxStep,
        Math.abs(pose.headX - previousPose.headX),
        Math.abs(pose.headY - previousPose.headY),
        Math.abs(pose.headZ - previousPose.headZ),
        Math.abs(pose.gazeX - previousPose.gazeX),
        Math.abs(pose.gazeY - previousPose.gazeY),
      );
    }
    previousPose = pose;
    if (started === null && at >= 9_000) {
      const selection = pickSelection(action, { state: 'idle', event: 'idle', recipe: 'idle-tilt' });
      assert.ok(selection !== null);
      started = action.startPreset(selection, { at });
      assert.equal(started.started, true);
    }
    const component = action.snapshot().motion.posture.component;
    if (component !== null) {
      if (previousComponentStart !== null && component.startedAt !== previousComponentStart && started !== null
        && at <= 9_000 + started.durationMs) {
        swapsDuringAction += 1;
      }
      previousComponentStart = component.startedAt;
    }
  }
  assert.ok(swapsDuringAction >= 1, `the head component swapped during the action (${swapsDuringAction})`);
  assert.ok(maxStep < 0.09, `no visible jump across status/component changes (max step ${maxStep.toFixed(4)})`);
  const actionPose = action.snapshot().pose;
  const controlPose = control.snapshot().pose;
  for (const channel of [...HEAD, ...GAZE]) {
    assert.ok(Math.abs(actionPose[channel] - controlPose[channel]) < 3e-3,
      `${channel} is back at the control/component baseline (${actionPose[channel]} vs ${controlPose[channel]})`);
  }
  console.log(`[continuity] maxStep=${maxStep.toFixed(4)} swapsDuringAction=${swapsDuringAction}`);
});

// ---------------------------------------------------------------------------------------------
// 7. interrupt / relax clear BOTH components and they do not silently revive
// ---------------------------------------------------------------------------------------------
test('7. interrupt/relax 清两个组件：目标归零，暂停期不复活', () => {
  const interruptRuntime = createBehaviorRuntime({ config: behaviorConfig({ seed: 41 }) });
  run(interruptRuntime, 0, 5_000);
  assert.ok(interruptRuntime.snapshot().motion.posture.component !== null);
  assert.ok(interruptRuntime.snapshot().motion.posture.gazeComponent !== null);
  interruptRuntime.interrupt({ reason: 'phase3-test' });
  const interrupted = interruptRuntime.snapshot().motion.posture;
  assert.equal(interrupted.component, null, 'interrupt clears the head component');
  assert.equal(interrupted.gazeComponent, null, 'interrupt clears the gaze component');
  assert.equal(interrupted.componentPaused, true);
  assert.equal(interrupted.gazeComponentPaused, true);
  for (const channel of HEAD) {
    assert.ok(Math.abs(interrupted.target[channel]) < 1e-9, `${channel} target reset to rest`);
  }
  run(interruptRuntime, 5_033, 9_000);
  assert.equal(interruptRuntime.snapshot().motion.posture.component, null, 'head component never revived');
  assert.equal(interruptRuntime.snapshot().motion.posture.gazeComponent, null, 'gaze component never revived');

  const relaxRuntime = createBehaviorRuntime({ config: behaviorConfig({ seed: 43 }) });
  run(relaxRuntime, 0, 5_000);
  assert.ok(relaxRuntime.snapshot().motion.posture.component !== null);
  assert.ok(relaxRuntime.snapshot().motion.posture.gazeComponent !== null);
  const relaxed = relaxRuntime.relax({ at: 5_000 });
  assert.equal(relaxed.ok, true);
  const afterRelax = relaxRuntime.snapshot().motion.posture;
  assert.equal(afterRelax.component, null, 'relax clears the head component');
  assert.equal(afterRelax.gazeComponent, null, 'relax clears the gaze component');
  run(relaxRuntime, 5_033, 9_500);
  assert.equal(relaxRuntime.snapshot().motion.posture.component, null);
  assert.equal(relaxRuntime.snapshot().motion.posture.gazeComponent, null);
});

// ---------------------------------------------------------------------------------------------
// 8. privacy lock / master idle switch / disconnect stop BOTH component writes
// ---------------------------------------------------------------------------------------------
test('8. 隐私锁、总开关 idle:false、断连：两个组件都停写', async (t) => {
  const rig = await makeRuntime({
    rows: rowsFor(['headX', 'headY', 'headZ', 'gazeX', 'gazeY', 'bodyX']),
  });
  t.after(() => rig.runtime.dispose());
  for (let at = 0; at <= 2_000; at += DT) await rig.tick(at);
  assert.ok(hasChannel(rig.fake.frames, 'headX'), 'baseline head row');
  assert.ok(hasChannel(rig.fake.frames, 'gazeX'), 'baseline gaze row');

  rig.runtime.lock('phase3-privacy');
  rig.fake.frames.length = 0;
  for (let at = 2_000; at <= 4_000; at += DT) await rig.tick(at);
  assert.equal(rig.fake.frames.length, 0, 'privacy lock writes neither component nor anything else');
  rig.runtime.unlock();
  for (let at = 4_000; at <= 5_000; at += DT) await rig.tick(at);
  assert.ok(hasChannel(rig.fake.frames, 'headX'), 'unlock resumes the head writer');
  assert.ok(hasChannel(rig.fake.frames, 'gazeX'), 'unlock resumes the gaze component writer');

  rig.runtime.setIntent({ flags: { idle: false } });
  rig.fake.frames.length = 0;
  for (let at = 5_000; at <= 6_000; at += DT) await rig.tick(at);
  assert.equal(rig.fake.frames.length, 0, 'the explicit idle:false master switch stops both components');
  rig.runtime.setIntent({ flags: { idle: true } });
  for (let at = 6_000; at <= 7_000; at += DT) await rig.tick(at);
  assert.ok(hasChannel(rig.fake.frames, 'headX'), 'idle:true resumes the head writer');

  await rig.runtime.disconnect();
  rig.fake.frames.length = 0;
  for (let at = 7_000; at <= 8_000; at += DT) await rig.tick(at);
  assert.equal(rig.fake.frames.length, 0, 'disconnect writes nothing');
  console.log('[gates] privacy/idle-off/disconnect produced 0 rows while closed');
});

// ---------------------------------------------------------------------------------------------
// 9. determinism: same seed reproduces both component streams (different seed does not)
// ---------------------------------------------------------------------------------------------
test('9. 同 seed 复现两组件与姿态；异 seed 不同', () => {
  const sample = (seed) => {
    const runtime = createBehaviorRuntime({ config: behaviorConfig({ seed }) });
    const rows = [];
    for (let at = 0; at <= 40_000; at += DT) {
      const pose = runtime.tick(at);
      const posture = runtime.snapshot().motion.posture;
      rows.push([
        pose.headX, pose.headY, pose.headZ, pose.gazeX, pose.gazeY,
        posture.component?.id ?? null,
        posture.component?.startedAt ?? null,
        posture.component?.semantic?.headX ?? null,
        posture.gazeComponent?.id ?? null,
        posture.gazeComponent?.startedAt ?? null,
        posture.gazeComponent?.value?.gazeX ?? null,
        posture.gazeComponent?.value?.gazeY ?? null,
      ]);
    }
    return rows;
  };
  const first = sample(4242);
  const second = sample(4242);
  const other = sample(4243);
  assert.deepEqual(first, second, 'the same seed produced a different head/gaze component trajectory');
  assert.notDeepEqual(first, other, 'a different seed produced an identical trajectory');
  console.log(`[determinism] frames=${first.length} sameSeed=true otherSeedDiffers=true`);
});
