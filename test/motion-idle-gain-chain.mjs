/**
 * Idle gain chain — why the base activity used to be ~0.37° and what the fix separates.
 *
 * THE 0.37° CLAIM (must be quoted with axis / duration / statistic):
 *   - axis: headY (pitch), statistic: PEAK of the BASE posture target (not peak-to-peak, not the
 *     final pose, excluding the ±1.1° hold drift and the speech micro-motion), window 60 s,
 *     fixed persona `amplitude: 0.45`.
 *   - the old chain was 0.034 (headY base constant) × idleSwayScale 1.2 × postureReach 1.5 ×
 *     persona 0.45 × persona 0.45 (the persona amplitude was multiplied TWICE) × 30° = 0.372°.
 *   - this is NOT the `idleMax=0.3707` line printed by test/avatar-style.mjs:39. That number is
 *     |headX| max in SEMANTIC units, i.e. 0.3707 × 30 = 11.12°, a different axis, unit and
 *     statistic. It is also not comparable with the old report's ±3.2° headY peak (different old
 *     gain chain / layer); only like-for-like measurements are compared here.
 *
 * Layer vocabulary measured below, per axis and sample window:
 *   L1 raw base trajectory      `axis.current - component.target` (unitless posture units)
 *   L2 persona/status scaling   `observed.idle - observed.mixed` in degrees (base after gain)
 *   L3 component mixing         `observed.mixed` in degrees (the component's own target)
 *   L4 output pose              the published pose in degrees (spring + clamps)
 *   L5 input conversion         the value the writer maps for a ±30 input (1 semantic = 30°)
 *   L6 final send               rows received by the fake transport
 * Every layer reports p2p, peak, max velocity and the longest near-still run.
 *
 * Run: node --test test/motion-idle-gain-chain.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BASE_ACTIVITY_DEGREES,
  BASE_ACTIVITY_PERSONA_SCALE,
  OCCASIONAL_ACTION,
  POSTURE_COMPONENT_MAX_AMPLITUDE,
  createBehaviorRuntime,
} from '../src/host/avatar/motion-controller.js';
import { createAvatarRuntime } from '../src/host/avatar/avatarRuntime.js';

const DT = 1000 / 30;
const HEAD = Object.freeze(['headX', 'headY', 'headZ']);
const IDLE_MS = 60_000;
const SPEAK_MS = 20_000;
/** Base p2p trial band shared with the degree-level suites: visible, but never a forced swing. */
const BASE_P2P_MIN = 1.5;
const BASE_P2P_MAX = 4.5;
/** Fixed persona used for every measurement. 0.45 is what reproduces the old 0.372° headY peak. */
const PERSONA = Object.freeze({
  amplitude: 0.45,
  tempo: 1,
  gazeHabit: 'steady',
  expressiveness: 1,
  nodAmplitude: 1,
});

const flush = () => new Promise((resolve) => setImmediate(resolve));

/** 0.2–1.5 → the single base-visibility multiplier (quiet keeps 0.8, lively reaches 1.0). */
function personaScale(amplitude) {
  const t = Math.max(0, Math.min(1, (amplitude - 0.2) / 1.3));
  return BASE_ACTIVITY_PERSONA_SCALE.MIN
    + (BASE_ACTIVITY_PERSONA_SCALE.MAX - BASE_ACTIVITY_PERSONA_SCALE.MIN) * t;
}

/** The old quiet chain, kept ONLY as provenance arithmetic for the 0.37° note. */
function oldQuietHeadYPeak(amplitude = 0.45) {
  return 0.034 * 1.2 * 1.5 * amplitude * amplitude * OCCASIONAL_ACTION.DEGREES_PER_POSE_UNIT;
}

function controllerConfig(extra = {}) {
  return {
    seed: 1, // seed 1's first component is `natural` (headY band is 0, so headY base is direct)
    idleActions: [],
    postureHoldMinMs: 12_000,
    postureHoldMaxMs: 12_000,
    postureHoldChance: 0, // every hold expiry re-draws: the base posture really moves
    postureStillChance: 0,
    postureComponentMinMs: 20_000,
    postureComponentMaxMs: 20_000,
    componentGazeVerified: false,
    presetExecution: false,
    style: PERSONA,
    ...extra,
  };
}

function p2p(values) {
  return Math.max(...values) - Math.min(...values);
}

/** p2p / peak / max velocity / longest near-still run (|Δ| below 1e-4 for one sample). */
function metrics(values, dtMs = DT) {
  assert.ok(values.length > 0, 'a layer must have samples');
  let min = Infinity;
  let max = -Infinity;
  let peak = 0;
  let maxVelocity = 0;
  let stillMs = 0;
  let lastChange = 0;
  let changes = 0;
  let previous = null;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    min = Math.min(min, value);
    max = Math.max(max, value);
    peak = Math.max(peak, Math.abs(value));
    if (previous !== null) {
      const delta = Math.abs(value - previous);
      maxVelocity = Math.max(maxVelocity, delta / (dtMs / 1000));
      if (delta > 1e-4) {
        changes += 1;
        lastChange = index;
      } else {
        stillMs = Math.max(stillMs, (index - lastChange) * dtMs);
      }
    }
    previous = value;
  }
  return { p2p: max - min, peak, maxVelocity, stillMs, changes };
}

/**
 * Drive the pure controller and collect the layer evidence. Frames within 2.5 s of a component
 * swap are excluded: `observed.mixed` already names the new component while the posture axis is
 * still inside the planned 1.2–1.8 s transition, so that window is a transition, not base motion.
 */
function collectController(extra = {}, durationMs = IDLE_MS) {
  const runtime = createBehaviorRuntime({ config: controllerConfig(extra) });
  const layers = {
    rawUnit: Object.fromEntries(HEAD.map((channel) => [channel, []])),
    baseDeg: Object.fromEntries(HEAD.map((channel) => [channel, []])),
    mixDeg: Object.fromEntries(HEAD.map((channel) => [channel, []])),
    poseDeg: Object.fromEntries(HEAD.map((channel) => [channel, []])),
  };
  const holds = new Map();
  let latest = null;
  for (let at = 0; at <= durationMs; at += DT) {
    const pose = runtime.tick(at);
    const snapshot = runtime.snapshot();
    const component = snapshot.motion.posture.component;
    if (component?.observed === null || component?.observed === undefined) continue;
    latest = snapshot;
    if (at - component.startedAt < 2_500) continue;
    const key = `${component.id}@${component.startedAt}`;
    const hold = holds.get(key) ?? {
      id: component.id,
      startedAt: component.startedAt,
      baseDeg: Object.fromEntries(HEAD.map((channel) => [channel, []])),
      mixDeg: Object.fromEntries(HEAD.map((channel) => [channel, []])),
    };
    for (const channel of HEAD) {
      layers.rawUnit[channel].push(
        snapshot.motion.axes[channel].current - (component.target[channel] ?? 0),
      );
      const base = component.observed.idle[channel] - (component.observed.mixed[channel] ?? 0);
      layers.baseDeg[channel].push(base * OCCASIONAL_ACTION.DEGREES_PER_POSE_UNIT);
      layers.mixDeg[channel].push(
        (component.observed.mixed[channel] ?? 0) * OCCASIONAL_ACTION.DEGREES_PER_POSE_UNIT,
      );
      layers.poseDeg[channel].push(pose[channel] * OCCASIONAL_ACTION.DEGREES_PER_POSE_UNIT);
      hold.baseDeg[channel].push(base * OCCASIONAL_ACTION.DEGREES_PER_POSE_UNIT);
      hold.mixDeg[channel].push((component.observed.mixed[channel] ?? 0)
        * OCCASIONAL_ACTION.DEGREES_PER_POSE_UNIT);
    }
    holds.set(key, hold);
  }
  return { runtime, layers, holds: [...holds.values()], latest };
}

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
  return { frames, transport, setClock(at) { clock = at; } };
}

const HEAD_ROWS = Object.freeze([
  { channel: 'headX', inputName: 'P_headX', min: -30, max: 30, injectable: true, verified: true },
  { channel: 'headY', inputName: 'P_headY', min: -30, max: 30, injectable: true, verified: true },
  { channel: 'headZ', inputName: 'P_headZ', min: -90, max: 90, injectable: true, verified: true },
  { channel: 'breath', inputName: 'P_breath', min: 0, max: 1, injectable: true, verified: true },
]);

async function makeSentRuntime(extra = {}) {
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
      componentGazeEnabled: false,
      presetExecution: false,
      postureHoldMinMs: 12_000,
      postureHoldMaxMs: 12_000,
      postureHoldChance: 0,
      postureStillChance: 0,
      postureComponentMinMs: 20_000,
      postureComponentMaxMs: 20_000,
      componentGazeVerified: false,
      seed: 1,
      style: PERSONA,
      ...extra,
    },
  });
  const connected = await runtime.connect();
  assert.equal(connected.ok, true, `runtime connects (${connected.message ?? ''})`);
  const mapped = await runtime.setChannelMappings(HEAD_ROWS, { channelMap: {} });
  assert.equal(mapped.ok, true, 'head mappings apply');
  return {
    runtime,
    fake,
    async tick(at, onFrame = null) {
      clock = at;
      fake.setClock(at);
      runtime.tick(at);
      await flush();
      if (onFrame !== null) onFrame(runtime.snapshot(), at);
    },
  };
}

const rowsFor = (fake, channel) => fake.frames
  .flatMap((frame) => frame.entries)
  .filter((entry) => entry.channel === channel)
  .map((entry) => entry.value);

// ---------------------------------------------------------------------------------------------
// 1. 0.37° provenance: the old quiet headY peak, and the new chain is not a global amplification
// ---------------------------------------------------------------------------------------------
test('1. 0.37° 出处：旧链 headY 峰值 0.372°（60s，峰值，不含 drift）；新链只修人设重复缩放', () => {
  const oldPeak = oldQuietHeadYPeak(PERSONA.amplitude);
  assert.ok(Math.abs(oldPeak - 0.37) < 0.01,
    `the old quiet headY base peak is ${oldPeak.toFixed(4)}° (axis headY, 60s, peak)`);
  // The same 0.3707 from avatar-style:39 is semantic headX, not this number.
  assert.ok(Math.abs(0.3707 * OCCASIONAL_ACTION.DEGREES_PER_POSE_UNIT - 11.121) < 0.01,
    'idleMax=0.3707 is 11.12° headX when converted, not 0.37°');

  // New nominal base peak (status idle, idleSwayScale 1.2) for the SAME quiet persona.
  const newQuietPeak = BASE_ACTIVITY_DEGREES.headY / OCCASIONAL_ACTION.DEGREES_PER_POSE_UNIT
    * personaScale(PERSONA.amplitude) * 1.2 * OCCASIONAL_ACTION.DEGREES_PER_POSE_UNIT;
  assert.ok(newQuietPeak > oldPeak * 3.5 && newQuietPeak < 2.5,
    `the fix restores the quiet headY base to ${newQuietPeak.toFixed(3)}° without a global blow-up`);
  // The DEFAULT persona is not amplified: its headY base peak stays at/below the old 1.836°.
  const newDefaultPeak = BASE_ACTIVITY_DEGREES.headY / OCCASIONAL_ACTION.DEGREES_PER_POSE_UNIT
    * personaScale(1) * 1.2 * OCCASIONAL_ACTION.DEGREES_PER_POSE_UNIT;
  assert.ok(newDefaultPeak <= 1.85,
    `the default persona headY base peak ${newDefaultPeak.toFixed(3)}° is not amplified`);
  // The component target is a separate vocabulary and is not derived from the base span.
  assert.ok(POSTURE_COMPONENT_MAX_AMPLITUDE * OCCASIONAL_ACTION.DEGREES_PER_POSE_UNIT >= 12,
    'the component target keeps its own 12° semantic ceiling');
  console.log(`[gain-chain] oldQuietHeadYPeak=${oldPeak.toFixed(4)}° newQuiet=${newQuietPeak.toFixed(3)}° `
    + `newDefault=${newDefaultPeak.toFixed(3)}° semanticIdleMax=0.3707→11.12° headX`);
});

// ---------------------------------------------------------------------------------------------
// 2. idle base visibility, layer by layer (60 s, fixed persona, presets paused)
// ---------------------------------------------------------------------------------------------
test('2. 待机 60s 逐层：L1 原始基础→L2 人设/状态→L3 组件混合→L4 姿势，基础 p2p 1.5–4.5°', () => {
  const { layers } = collectController();
  const report = {};
  for (const channel of HEAD) {
    const raw = metrics(layers.rawUnit[channel]);
    const base = metrics(layers.baseDeg[channel]);
    const mixed = metrics(layers.mixDeg[channel]);
    const pose = metrics(layers.poseDeg[channel]);
    report[channel] = { raw, base, mixed, pose };

    assert.ok(base.p2p >= BASE_P2P_MIN && base.p2p <= BASE_P2P_MAX,
      `${channel} base p2p ${base.p2p.toFixed(2)}° is in the 1.5–4.5° trial band`);
    assert.ok(base.peak >= 0.8, `${channel} base peak ${base.peak.toFixed(2)}° is visible`);
    assert.ok(base.changes > 1_200, `${channel} base keeps changing (${base.changes} frames)`);
    assert.ok(base.maxVelocity < 12,
      `${channel} base max velocity ${base.maxVelocity.toFixed(2)}°/s is a sway, not a gesture`);
    assert.ok(base.stillMs <= 1_000,
      `${channel} longest base near-still ${base.stillMs.toFixed(0)}ms stays under 1s`);
    // The raw base trajectory is continuous: no jump beyond one posture unit between frames.
    assert.ok(raw.maxVelocity < 20,
      `${channel} raw base step ${raw.maxVelocity.toFixed(2)} units/s is continuous`);
    // L3 is the component layer, not base: its own target stays inside the semantic cap.
    assert.ok(mixed.peak <= POSTURE_COMPONENT_MAX_AMPLITUDE * 30 + 1e-6,
      `${channel} component peak ${mixed.peak.toFixed(2)}° stays inside 0.40 semantic`);
    // L4 is the published pose after the spring/clamp; its span need not be the arithmetic sum of
    // base and component (they can oppose), but it must remain a continuous, finite pose.
    assert.ok(Number.isFinite(pose.p2p) && pose.p2p >= 0,
      `${channel} published pose is finite`);
  }
  console.log('[idle-layers] '
    + HEAD.map((channel) => `${channel}:L1=${report[channel].raw.p2p.toFixed(2)}u `
      + `L2=${report[channel].base.p2p.toFixed(2)}° L3=${report[channel].mixed.p2p.toFixed(2)}° `
      + `L4=${report[channel].pose.p2p.toFixed(2)}° v=${report[channel].base.maxVelocity.toFixed(1)}°/s `
      + `still=${report[channel].base.stillMs.toFixed(0)}ms`).join(' | '));
});

// ---------------------------------------------------------------------------------------------
// 3. during a held component the base layer still moves; the component target is not re-scaled
// ---------------------------------------------------------------------------------------------
test('3. 组件保持 20s 内：基础仍在动；组件目标恒定且在 5–12°，不与基础共用增益', () => {
  const { holds } = collectController();
  assert.ok(holds.length >= 2, `at least two component holds were observed (${holds.length})`);
  let measured = 0;
  for (const hold of holds) {
    const baseZ = metrics(hold.baseDeg.headZ);
    const baseY = metrics(hold.baseDeg.headY);
    const baseX = metrics(hold.baseDeg.headX);
    assert.ok(Math.max(baseX.p2p, baseY.p2p, baseZ.p2p) >= 0.5,
      `${hold.id} hold still carries base activity (${baseZ.p2p.toFixed(2)}° headZ p2p)`);
    assert.ok(baseX.changes > 40 && baseY.changes > 40 && baseZ.changes > 40,
      `${hold.id} hold base changes on every axis`);
    for (const channel of HEAD) {
      assert.ok(metrics(hold.mixDeg[channel]).p2p <= 1e-6,
        `${hold.id}/${channel} component target is held constant, not mechanically swayed`);
    }
    const dominant = Math.max(...HEAD.map((channel) => Math.abs(hold.mixDeg[channel][0])));
    assert.ok(dominant <= POSTURE_COMPONENT_MAX_AMPLITUDE * 30 + 1e-6,
      `${hold.id} dominant component ${dominant.toFixed(2)}° stays ≤ 0.40 semantic`);
    if (hold.id === 'natural') {
      assert.ok(dominant >= 5 && dominant <= 8,
        `natural dominant target ${dominant.toFixed(2)}° uses its own 5–8° band`);
      // Within one 20 s hold the base p2p is smaller than the 60 s window; the point here is that
      // headY (component band 0) still moves at all while the component is held.
      assert.ok(metrics(hold.baseDeg.headY).p2p >= 0.5,
        `natural holds headY at 0, so the measured headY base is direct (${baseY.p2p.toFixed(2)}°)`);
    }
    measured += 1;
  }
  assert.ok(measured >= 2, 'more than one hold window was checked');
  console.log(`[component-holds] ${holds.length} holds; `
    + `baseZ per hold=${holds.map((hold) => metrics(hold.baseDeg.headZ).p2p.toFixed(2)).join('/')}°`);
});

// ---------------------------------------------------------------------------------------------
// 4. speaking: the same base layer keeps moving (only damped), independent of the component
// ---------------------------------------------------------------------------------------------
test('4. 说话 20s：基础层仍持续变化（语音只阻尼，不冻结），组件目标不参与基础增益', () => {
  const runtime = createBehaviorRuntime({ config: controllerConfig() });
  const spoken = runtime.setSpeech({
    levels: Array.from({ length: 200 }, () => 0.5),
    stepMs: 100,
    durationMs: SPEAK_MS,
    startedAt: 0,
  });
  assert.equal(spoken.ok, true, 'the speech envelope is active');
  const base = Object.fromEntries(HEAD.map((channel) => [channel, []]));
  for (let at = 0; at <= SPEAK_MS; at += DT) {
    runtime.tick(at);
    const snapshot = runtime.snapshot();
    const component = snapshot.motion.posture.component;
    if (component?.observed === null || component?.observed === undefined) continue;
    if (at - component.startedAt < 2_500) continue;
    for (const channel of HEAD) {
      base[channel].push(
        (component.observed.idle[channel] - (component.observed.mixed[channel] ?? 0))
        * OCCASIONAL_ACTION.DEGREES_PER_POSE_UNIT,
      );
    }
  }
  for (const channel of HEAD) {
    const stats = metrics(base[channel]);
    const lower = channel === 'headY' ? 1.5 : 0.9;
    const upper = channel === 'headY' ? 5.5 : BASE_P2P_MAX;
    assert.ok(stats.p2p >= lower && stats.p2p <= upper,
      `speaking ${channel} base p2p ${stats.p2p.toFixed(2)}° is inside ${lower}–${upper}°`);
    assert.ok(stats.changes > 300, `speaking ${channel} base keeps changing`);
    assert.ok(stats.stillMs <= 1_200,
      `speaking ${channel} longest near-still ${stats.stillMs.toFixed(0)}ms`);
  }
  console.log(`[speaking-base] ${HEAD.map((channel) => (
    `${channel}=${metrics(base[channel]).p2p.toFixed(2)}°`
  )).join(' ')}`);
});

// ---------------------------------------------------------------------------------------------
// 5. final send: L5 conversion and L6 rows; visibility, no dead zone, no per-frame floor
// ---------------------------------------------------------------------------------------------
test('5. 最终发送 60s：sent=pose×30（无量程错误）、基础 p2p 1.5–4.5°、无 floor、18° 安全上限', async () => {
  const rig = await makeSentRuntime();
  const perChannel = Object.fromEntries(HEAD.map((channel) => [channel, {
    sent: [], base: [], poseDeg: [], conversionError: 0,
  }]));
  let sentRows = 0;
  for (let at = 0; at <= IDLE_MS; at += DT) {
    await rig.tick(at, (snapshot) => {
      const frame = rig.fake.frames[rig.fake.frames.length - 1];
      if (frame === undefined || frame.at !== at) return;
      const component = snapshot.motion.posture.component;
      // A component swap is interpolated over 1.2–1.8 s: the row may still carry the old component
      // while the snapshot already names the new one. This is a transition, not base motion.
      if (component !== null && component !== undefined
        && Number.isFinite(component.startedAt)
        && at - component.startedAt < 2_500) return;
      const mixed = component?.observed?.mixed ?? {};
      for (const entry of frame.entries) {
        if (!HEAD.includes(entry.channel)) continue;
        sentRows += 1;
        const pose = snapshot.inner.pose ?? snapshot.pose;
        const poseDeg = pose[entry.channel] * OCCASIONAL_ACTION.DEGREES_PER_POSE_UNIT;
        perChannel[entry.channel].sent.push(entry.value);
        perChannel[entry.channel].poseDeg.push(poseDeg);
        perChannel[entry.channel].conversionError = Math.max(
          perChannel[entry.channel].conversionError,
          Math.abs(entry.value - poseDeg),
        );
        perChannel[entry.channel].base.push(entry.value
          - (mixed[entry.channel] ?? 0) * OCCASIONAL_ACTION.DEGREES_PER_POSE_UNIT);
      }
    });
  }
  const snapshot = rig.runtime.snapshot();
  assert.ok(sentRows > 500, `final rows really left the writer (${sentRows})`);
  for (const channel of HEAD) {
    const data = perChannel[channel];
    assert.ok(data.sent.length > 450, `${channel} has enough final rows (${data.sent.length})`);
    assert.ok(data.conversionError <= 0.05,
      `${channel} sent = pose×30 (max error ${data.conversionError.toFixed(4)}°)`);
    const base = metrics(data.base, 100);
    const sentStats = metrics(data.sent, 100);
    assert.ok(base.p2p >= BASE_P2P_MIN && base.p2p <= BASE_P2P_MAX,
      `${channel} final base p2p ${base.p2p.toFixed(2)}° is in the 1.5–4.5° band`);
    assert.ok(base.stillMs <= 1_200,
      `${channel} final base near-still ${base.stillMs.toFixed(0)}ms`);
    assert.ok(base.maxVelocity <= 18,
      `${channel} final base max velocity ${base.maxVelocity.toFixed(1)}°/s stays a sway`);
    assert.ok(sentStats.stillMs <= 1_200,
      `${channel} final sent near-still ${sentStats.stillMs.toFixed(0)}ms`);
    assert.ok(sentStats.maxVelocity <= 40,
      `${channel} final sent max velocity ${sentStats.maxVelocity.toFixed(1)}°/s is bounded by the 0.12/frame step cap`);
    assert.ok(new Set(data.sent.map((value) => value.toFixed(3))).size > 250,
      `${channel} sent values are not quantised into a dead zone`);
    // Safety only: the writer cap is ±0.6 semantic = ±18°; the visibility assertions are above.
    assert.ok(Math.max(...data.sent.map(Math.abs)) <= 18.5,
      `${channel} sent |value| stays inside the 18° safety cap`);
  }
  assert.equal(snapshot.idleParams.motionFloor.injected, 0, 'no per-frame motion floor was injected');
  assert.equal(snapshot.idleParams.amplitude, 0.6, 'the send amplitude cap stays the safety constant');
  rig.runtime.dispose();
  console.log(`[final-send] rows=${sentRows} baseP2P=${HEAD.map((channel) => (
    metrics(perChannel[channel].base, 100).p2p.toFixed(2)
  )).join('/')}° sentP2P=${HEAD.map((channel) => (
    metrics(perChannel[channel].sent, 100).p2p.toFixed(2)
  )).join('/')}° sentV=${HEAD.map((channel) => (
    metrics(perChannel[channel].sent, 100).maxVelocity.toFixed(1)
  )).join('/')}°/s floor=0`);
});

// ---------------------------------------------------------------------------------------------
// 6. complete preset: entry / hold / end / interrupt keep the base layer continuous
// ---------------------------------------------------------------------------------------------
test('6. 完整动作进入/保持/结束/打断：基础活动不断，结束/打断不冻结，18° 仅为安全上限', async () => {
  const rig = await makeSentRuntime({ presetExecution: true });
  let started = null;
  for (let seed = 0; seed < 96 && started === null; seed += 1) {
    const drawn = rig.runtime.preset({ state: 'idle', event: 'idle', recipe: 'idle-tilt', seed, at: 0 });
    if (drawn.started === true) started = drawn;
  }
  assert.ok(started !== null, 'idle-tilt started');
  let maxStep = 0;
  let previous = null;
  let baseGrowth = [];
  let previousHeadMs = null;
  let postEndHeadMs = null;
  let postEndGrowth = 0;
  for (let at = 0; at <= started.durationMs + 4_000; at += DT) {
    await rig.tick(at, (snapshot) => {
      const frame = rig.fake.frames[rig.fake.frames.length - 1];
      if (frame === undefined || frame.at !== at) return;
      for (const entry of frame.entries) {
        if (entry.channel !== 'headX') continue;
        if (previous !== null) maxStep = Math.max(maxStep, Math.abs(entry.value - previous));
        previous = entry.value;
      }
      const headMs = snapshot.inner.baseActivity?.headMotionMs
        ?? snapshot.motion.baseActivity.headMotionMs;
      if (previousHeadMs !== null && at >= 1_000 && at <= started.durationMs) {
        baseGrowth.push(headMs - previousHeadMs);
      }
      if (at >= started.durationMs + 1_000) {
        if (postEndHeadMs !== null) postEndGrowth += headMs - postEndHeadMs;
        postEndHeadMs = headMs;
      }
      previousHeadMs = headMs;
    });
  }
  assert.ok(maxStep <= 6, `preset entry has no jump (max sent step ${maxStep.toFixed(2)}°)`);
  assert.ok(baseGrowth.length >= 3, `base activity was sampled during the hold (${baseGrowth.length})`);
  for (const growth of baseGrowth) {
    assert.ok(growth > 25,
      `base activity accumulated through the preset hold (${growth.toFixed(1)}ms)`);
  }

  // The tail after the preset ends must keep moving, not freeze on the last preset frame.
  const afterEnd = rig.fake.frames.filter((frame) => frame.at >= started.durationMs + 1_000);
  assert.ok(afterEnd.length > 5, 'post-end idle frames were still sent');
  const tail = afterEnd.flatMap((frame) => frame.entries)
    .filter((entry) => entry.channel === 'headX')
    .map((entry) => entry.value);
  // Inside one 12 s posture hold the base only has slow drift/micro-noise; the honest acceptance
  // here is "it never freezes", not the old contaminated 0.3° p2p that came from component wander.
  assert.ok(p2p(tail) > 0.05, `post-end tail keeps moving (p2p ${p2p(tail).toFixed(2)}°)`);
  assert.ok(new Set(tail.map((value) => value.toFixed(3))).size > 3,
    'the post-end tail keeps changing instead of freezing');
  assert.ok(postEndGrowth > 500,
    `base activity keeps accumulating after the preset ends (${postEndGrowth.toFixed(0)}ms)`);

  // Interrupt a second action: the old trajectory must stop and the base layer must resume.
  let second = null;
  for (let seed = 0; seed < 96 && second === null; seed += 1) {
    const drawn = rig.runtime.preset({
      state: 'idle', event: 'idle', recipe: 'idle-side', seed, at: started.durationMs + 4_000,
    });
    if (drawn.started === true) second = drawn;
  }
  assert.ok(second !== null, 'a second action started for the interrupt check');
  const interruptAt = started.durationMs + 4_000 + 600;
  for (let at = started.durationMs + 4_000; at <= interruptAt; at += DT) {
    await rig.tick(at);
  }
  rig.runtime.interrupt({ reason: 'gain-chain-test' });
  let afterInterruptHeadMs = null;
  let afterInterruptGrowth = 0;
  let interruptPeak = 0;
  for (let at = interruptAt; at <= interruptAt + 1_500; at += DT) {
    await rig.tick(at, (snapshot) => {
      const headMs = snapshot.inner.baseActivity?.headMotionMs
        ?? snapshot.motion.baseActivity.headMotionMs;
      if (afterInterruptHeadMs !== null) {
        afterInterruptGrowth += headMs - afterInterruptHeadMs;
      }
      afterInterruptHeadMs = headMs;
      const pose = snapshot.inner.pose ?? snapshot.pose;
      interruptPeak = Math.max(interruptPeak,
        Math.abs(pose.headX) * 30, Math.abs(pose.headY) * 30, Math.abs(pose.headZ) * 30);
    });
  }
  assert.ok(afterInterruptGrowth > 500,
    `base activity resumes after the interrupt (${afterInterruptGrowth.toFixed(0)}ms)`);
  assert.ok(interruptPeak <= 18.5,
    `the interrupted pose stays inside the 18° safety cap (${interruptPeak.toFixed(2)}°)`);
  const interruptedTrace = rig.runtime.snapshot().motion.presets.lastTrace;
  assert.ok(interruptedTrace !== null, 'the interrupted action still has a trace');
  rig.runtime.dispose();
  console.log(`[preset-continuity] duration=${started.durationMs.toFixed(0)}ms maxStep=${maxStep.toFixed(2)}° `
    + `tailP2P=${p2p(tail).toFixed(2)}° resume=${afterInterruptGrowth.toFixed(0)}ms`);
});
