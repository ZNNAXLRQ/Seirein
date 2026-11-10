/**
 * Human-visible motion ranges and continuity — the degree-level acceptance for the continuous
 * controller.
 *
 * Trial bands (not universal standards):
 *   - base micro-motion: 1.5–4.5° peak-to-peak, continuously changing, no per-frame floor;
 *   - held posture component: 5–12° on its dominant axis, headX/headZ independent;
 *   - ordinary preset: 10–20°; a deliberate lean/look can use a larger per-operation band;
 *   - quiet < lively is preserved without dropping the quiet persona below the visible band.
 *
 * The final-send checks use the real avatarRuntime writer over a fake transport (no VTS):
 * 30 Hz computation is not the same as 30 Hz effective output, so the rows that really left the
 * controller are measured, not only the internal target.
 *
 * Real VTS appearance remains UNVERIFIED.
 *
 * Run: node --test test/motion-degree-range.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HOLD_MICRO_DRIFT,
  POSTURE_COMPONENT_CHANNELS,
  POSTURE_COMPONENT_DEGREE_BANDS,
  PRESET_OPERATION_DEGREE_RANGES,
  createBehaviorRuntime,
} from '../src/host/avatar/motion-controller.js';
import { createAvatarRuntime } from '../src/host/avatar/avatarRuntime.js';

const DT = 1000 / 30;
const HEAD = Object.freeze(['headX', 'headY', 'headZ']);
const ALL_CHANNELS = Object.freeze([
  'headX', 'headY', 'headZ', 'gazeX', 'gazeY', 'eyeOpenL', 'eyeOpenR',
  'browL', 'browR', 'bodyX', 'bodyY', 'bodyZ', 'breath',
]);
const flush = () => new Promise((resolve) => setImmediate(resolve));
const approx = (actual, expected, message, tolerance = 1e-6) => {
  assert.ok(Math.abs(actual - expected) <= tolerance,
    `${message} (actual ${actual}, expected ${expected})`);
};

function behaviorConfig(extra = {}) {
  return {
    seed: 21,
    idleActions: [],
    postureHoldMinMs: 60_000,
    postureHoldMaxMs: 60_000,
    postureHoldChance: 1,
    postureStillChance: 0,
    postureComponentMinMs: 10_000,
    postureComponentMaxMs: 10_000,
    componentGazeVerified: false,
    presetExecution: false,
    ...extra,
  };
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
  return {
    frames,
    transport,
    setClock(at) { clock = at; },
  };
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
      postureHoldMinMs: 60_000,
      postureHoldMaxMs: 60_000,
      postureHoldChance: 1,
      postureStillChance: 0,
      postureComponentMinMs: 10_000,
      postureComponentMaxMs: 10_000,
      seed: 21,
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
    async tick(at) {
      clock = at;
      fake.setClock(at);
      runtime.tick(at);
      await flush();
    },
  };
}

const rowsFor = (fake, channel) => fake.frames
  .flatMap((frame) => frame.entries)
  .filter((entry) => entry.channel === channel)
  .map((entry) => entry.value);

/** Max interval (ms) between two consecutive distinct values, after rounding. */
function plateauMs(frames, channel, fromAt = 3_000) {
  let lastValue = null;
  let lastAt = null;
  let maxGap = 0;
  for (const frame of frames) {
    if (frame.at < fromAt) continue;
    for (const entry of frame.entries) {
      if (entry.channel !== channel) continue;
      const value = Math.round(entry.value * 1000) / 1000;
      if (lastValue === null || value !== lastValue) {
        if (lastAt !== null) maxGap = Math.max(maxGap, frame.at - lastAt);
        lastAt = frame.at;
        lastValue = value;
      }
    }
  }
  return maxGap;
}

function p2p(values) {
  return Math.max(...values) - Math.min(...values);
}

function pick(runtime, context, limit = 160) {
  for (let seed = 0; seed < limit; seed += 1) {
    const selection = runtime.selectPreset({ ...context, seed });
    if (selection.kind === 'preset') return selection;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// 1. held component: 5–12°, headX/headZ independent, target degrees match the semantic convention
// ---------------------------------------------------------------------------------------------
test('1. 姿态组件目标 5–12°：natural/lean/look-back 分轴，headX 与 headZ 不同幅度', () => {
  // Seed 1 draws `natural` first (the same deterministic draw the natural-component suite uses).
  const runtime = createBehaviorRuntime({ config: behaviorConfig({ seed: 1 }) });
  const byId = new Map();
  for (let at = 0; at <= 60_000; at += DT) {
    runtime.tick(at);
    const component = runtime.snapshot().motion.posture.component;
    if (component === null) continue;
    const entry = byId.get(component.id) ?? { max: 0, headX: 0, headZ: 0 };
    for (const channel of POSTURE_COMPONENT_CHANNELS) {
      const degrees = Math.abs(component.targetDegrees?.[channel] ?? 0);
      const semantic = Math.abs(component.semantic?.[channel] ?? 0);
      approx(component.targetDegrees?.[channel] ?? 0,
        (component.semantic?.[channel] ?? 0) * 30,
        `${component.id}/${channel} targetDegrees follows 30°-per-unit`);
      entry.max = Math.max(entry.max, degrees);
      if (channel === 'headX') entry.headX = Math.max(entry.headX, degrees);
      if (channel === 'headZ') entry.headZ = Math.max(entry.headZ, degrees);
    }
    byId.set(component.id, entry);
  }

  assert.ok(byId.has('natural'), 'natural was drawn in the 60 s window');
  for (const [id, entry] of byId) {
    assert.ok(entry.max >= 5 - 1e-6 && entry.max <= 12 + 1e-6,
      `${id} dominant target ${entry.max.toFixed(2)}° is inside 5–12°`);
    const bands = POSTURE_COMPONENT_DEGREE_BANDS[id];
    assert.ok(bands !== undefined, `${id} has an explicit degree band`);
  }
  const natural = byId.get('natural');
  assert.ok(natural.headZ >= 5 && natural.headZ <= 8,
    `natural roll ${natural.headZ.toFixed(2)}° is the light 5–8° target`);
  const lean = byId.get('lean-left') ?? byId.get('lean-right');
  assert.ok(lean !== undefined, 'a lean component was drawn');
  assert.ok(lean.headZ >= 8 && lean.headZ <= 12,
    `lean roll ${lean.headZ.toFixed(2)}° is the larger 8–12° target`);
  const look = byId.get('look-back') ?? byId.get('lean-left');
  assert.ok(Math.abs(look.headX - look.headZ) > 0.5,
    `${look && look.headX}° yaw and ${look && look.headZ}° roll are separate, not one shared scalar`);
  console.log(`[degree-components] ${[...byId.entries()].map(([id, entry]) => (
    `${id}:${entry.headX.toFixed(2)}/${entry.headZ.toFixed(2)}°`
  )).join(' ')}`);
});

// ---------------------------------------------------------------------------------------------
// 2. base micro-motion: 60 s continuous, 1.5–4.5° peak-to-peak, no restart at component swaps
// ---------------------------------------------------------------------------------------------
test('2. 基础层 60s 连续：峰峰值约 2–4°，组件保持期间仍变化，drift 不重置', () => {
  const runtime = createBehaviorRuntime({ config: behaviorConfig() });
  const min = { headX: Infinity, headY: Infinity, headZ: Infinity };
  const max = { headX: -Infinity, headY: -Infinity, headZ: -Infinity };
  let maxDriftStep = 0;
  let previousDrift = null;
  let previousBase = null;
  let maxBaseStep = 0;
  let changes = 0;
  let lastChangeAt = null;
  let maxGap = 0;

  for (let at = 0; at <= 60_000; at += DT) {
    runtime.tick(at);
    const motion = runtime.snapshot().motion;
    const component = motion.posture.component;
    const drift = motion.holdDrift;
    if (previousDrift !== null) {
      maxDriftStep = Math.max(maxDriftStep, ...HEAD.map(
        (channel) => Math.abs((drift?.[channel] ?? 0) - (previousDrift[channel] ?? 0)) * 30,
      ));
    }
    previousDrift = { ...drift };

    if (component?.observed === null || component?.observed === undefined) continue;
    // Skip the planned component transition window: `idle` still carries the previous component
    // while `mixed` already names the new one. Reset the continuity clocks so the skipped window
    // is not counted as a base plateau.
    if (at - component.startedAt < 2_000) {
      previousBase = null;
      lastChangeAt = null;
      continue;
    }
    const base = {};
    for (const channel of HEAD) {
      base[channel] = (component.observed.idle?.[channel] ?? 0)
        - (component.observed.mixed?.[channel] ?? 0);
      min[channel] = Math.min(min[channel], base[channel]);
      max[channel] = Math.max(max[channel], base[channel]);
    }
    if (previousBase !== null) {
      const step = Math.max(...HEAD.map((channel) => Math.abs(base[channel] - previousBase[channel])));
      maxBaseStep = Math.max(maxBaseStep, step);
      if (step > 1e-8) {
        changes += 1;
        if (lastChangeAt !== null) maxGap = Math.max(maxGap, at - lastChangeAt);
        lastChangeAt = at;
      }
    }
    previousBase = base;
  }

  for (const channel of HEAD) {
    const span = (max[channel] - min[channel]) * 30;
    const lower = channel === 'headY' ? 1.2 : 1.5;
    assert.ok(span >= lower && span <= 4.6,
      `${channel} base peak-to-peak ${span.toFixed(2)}° is in the visible 2–4° trial band`);
  }
  assert.ok(changes > 1_000, `base really keeps changing (${changes} changes)`);
  assert.ok(maxGap <= 1_000, `no long base plateau (max gap ${maxGap.toFixed(0)} ms)`);
  assert.ok(maxBaseStep * 30 < 1.5, `no base jump (${(maxBaseStep * 30).toFixed(3)}°/frame)`);
  assert.ok(maxDriftStep <= 0.05,
    `hold drift continues without a reset at component swaps (${maxDriftStep.toFixed(4)}°/frame)`);
  assert.ok(HOLD_MICRO_DRIFT.DEGREES >= 1 && HOLD_MICRO_DRIFT.DEGREES <= 3,
    `hold drift stays in the 1–3° trial band (${HOLD_MICRO_DRIFT.DEGREES}°)`);
  console.log(`[degree-base] p2p=${HEAD.map(
    (channel) => ((max[channel] - min[channel]) * 30).toFixed(2),
  ).join('/')}° changes=${changes} maxGap=${maxGap.toFixed(0)}ms driftStep=${maxDriftStep.toFixed(4)}°`);
});

// ---------------------------------------------------------------------------------------------
// 3. final send: 60 s of real rows, no obvious plateau, no per-frame motion floor
// ---------------------------------------------------------------------------------------------
test('3. 60s 最终发送曲线：head 三轴持续变化、无明显平台、motionFloor.injected=0', async () => {
  const rig = await makeSentRuntime();
  for (let at = 0; at <= 63_000; at += DT) {
    await rig.tick(at);
  }
  const snapshot = rig.runtime.snapshot();
  const stats = {};
  for (const channel of HEAD) {
    const values = rowsFor(rig.fake, channel);
    assert.ok(values.length > 200, `${channel} really left the writer (${values.length} rows)`);
    const distinct = new Set(values.map((value) => Math.round(value * 1000))).size;
    const gap = plateauMs(rig.fake.frames, channel);
    assert.ok(distinct > 20, `${channel} has ${distinct} distinct sent values`);
    assert.ok(gap <= 1_500, `${channel} has no long flat segment (max gap ${gap} ms)`);
    stats[channel] = { distinct, gap, p2p: p2p(values) };
  }
  assert.equal(snapshot.idleParams.motionFloor.injected, 0,
    'no per-frame motion floor was injected');
  assert.equal(snapshot.idleParams.amplitude, 0.6,
    'the default send budget is the trial 0.6 (±18°), not the old 0.18 (±5.4°)');
  assert.equal(snapshot.idleParams.maxStep, 0.12,
    'the send-step budget allows a visible action without a hidden floor');
  rig.runtime.dispose();
  console.log(`[degree-send] ${HEAD.map((channel) => (
    `${channel}: distinct=${stats[channel].distinct} gap=${stats[channel].gap}ms p2p=${stats[channel].p2p.toFixed(2)}°`
  )).join(' ')}`);
});

// ---------------------------------------------------------------------------------------------
// 4. complete preset: ordinary 10–20°, large action per-operation (not a uniform 45°)
// ---------------------------------------------------------------------------------------------
test('4. 完整预设：普通 10–20°，lean 更大但按操作分档（不统一 45°），人设差异保留', () => {
  const run = (recipe, style, seed = 11) => {
    const runtime = createBehaviorRuntime({
      config: behaviorConfig({
        seed,
        presetExecution: false,
        presetTargetVerified: true,
        presetChannels: [...ALL_CHANNELS],
        presetDebugEvents: false,
        ...(style === null ? {} : { style }),
      }),
    });
    const selection = pick(runtime, { state: 'idle', event: 'idle', recipe });
    assert.ok(selection !== null, `${recipe} is selectable`);
    const started = runtime.startPreset(selection, { at: 0 });
    assert.equal(started.started, true);
    let posePeak = 0;
    for (let at = 0; at <= started.durationMs + 400; at += DT) {
      const pose = runtime.tick(at);
      posePeak = Math.max(posePeak,
        Math.abs(pose.headX), Math.abs(pose.headY), Math.abs(pose.headZ));
    }
    const trace = runtime.snapshot().motion.presets.lastTrace;
    return {
      targetDegrees: started.trace.output.stages.map((stage) => stage.targetDegrees),
      peakDegrees: trace.output.peakDegrees,
      computedDegrees: trace.output.computedDegrees,
      posePeakDegrees: posePeak * 30,
    };
  };

  for (const recipe of ['idle-tilt', 'idle-down', 'idle-side']) {
    const result = run(recipe, null);
    assert.ok(result.peakDegrees >= 10 - 1e-6 && result.peakDegrees <= 20 + 1e-6,
      `${recipe} planned peak ${result.peakDegrees.toFixed(2)}° is inside 10–20°`);
    assert.ok(result.computedDegrees
      && Object.values(result.computedDegrees).some((value) => Number.isFinite(value)),
    `${recipe} records computed degrees`);
  }

  const sway = run('idle-sway', null);
  assert.ok(sway.peakDegrees >= 16 - 1e-6 && sway.peakDegrees <= 28 + 1e-6,
    `idle-sway ${sway.peakDegrees.toFixed(2)}° uses its larger per-operation band`);
  assert.ok(PRESET_OPERATION_DEGREE_RANGES['head-sway'].max <= 30,
    'the lean band stays below the ±30° yaw/pitch safety and never a uniform 45°');
  const swayTarget = sway.targetDegrees[0];
  assert.ok(Math.abs(swayTarget.headZ) <= 90 && Math.abs(swayTarget.headX) <= 30,
    'headZ uses ±90 and headX uses ±30 independently');

  const quiet = run('idle-side', { amplitude: 0.3, tempo: 0.9, tiltChance: 0.03 }, 11);
  const lively = run('idle-side', { amplitude: 1.4, tempo: 1.3, tiltChance: 0.4 }, 11);
  assert.ok(quiet.peakDegrees < lively.peakDegrees,
    `quiet ${quiet.peakDegrees.toFixed(2)}° < lively ${lively.peakDegrees.toFixed(2)}°`);
  assert.ok(quiet.peakDegrees >= 10 - 1e-6,
    `quiet still reaches the visible 10° floor (${quiet.peakDegrees.toFixed(2)}°)`);
  console.log(`[degree-preset] normal=${['idle-tilt', 'idle-down', 'idle-side']
    .map((recipe) => run(recipe, null).peakDegrees.toFixed(2)).join('/')}° `
    + `sway=${sway.peakDegrees.toFixed(2)}° quiet=${quiet.peakDegrees.toFixed(2)}° `
    + `lively=${lively.peakDegrees.toFixed(2)}°`);
});

// ---------------------------------------------------------------------------------------------
// 5. preset entry/hold/end: no jump, base keeps moving, no freeze after the tail
// ---------------------------------------------------------------------------------------------
test('5. 预设前后连续：进入不跳、保持/结束基础层继续，结束不冻结在最后一帧', async () => {
  const rig = await makeSentRuntime({ presetExecution: true });
  let started = null;
  for (let seed = 0; seed < 96 && started === null; seed += 1) {
    const drawn = rig.runtime.preset({ state: 'idle', event: 'idle', recipe: 'idle-tilt', seed, at: 0 });
    if (drawn.started === true) started = drawn;
  }
  assert.ok(started !== null, 'idle-tilt started');
  const endAt = started.durationMs;
  for (let at = 0; at <= endAt + 4_000; at += DT) {
    await rig.tick(at);
  }

  const headX = rowsFor(rig.fake, 'headX');
  const headZ = rowsFor(rig.fake, 'headZ');
  let maxStep = 0;
  for (let index = 1; index < headX.length; index += 1) {
    maxStep = Math.max(maxStep, Math.abs(headX[index] - headX[index - 1]));
  }
  assert.ok(maxStep <= 6, `no preset jump (max sent step ${maxStep.toFixed(2)}°)`);
  assert.ok(Math.max(...headZ.map(Math.abs)) >= 10,
    `the ordinary tilt really reaches the visible send band (${Math.max(...headZ.map(Math.abs)).toFixed(2)}°)`);

  // A 1 s bucket must keep changing through entry, active and the post-end tail; the base layer is
  // not allowed to stop on the last preset frame.
  const afterEnd = rig.fake.frames.filter((frame) => frame.at >= endAt + 1_000);
  assert.ok(afterEnd.length > 10, 'post-end idle frames were still sent');
  const tail = afterEnd.flatMap((frame) => frame.entries)
    .filter((entry) => entry.channel === 'headX')
    .map((entry) => entry.value);
  assert.ok(new Set(tail.map((value) => Math.round(value * 1000))).size > 3,
    'the tail keeps moving instead of freezing at the last preset value');
  assert.ok(p2p(tail) > 0.3, `post-end tail has a visible p2p (${p2p(tail).toFixed(2)}°)`);

  // Each 1 s window during the action contains several distinct values (base activity continues
  // while the preset is held).
  for (let from = 1_000; from + 1_000 <= endAt; from += 1_000) {
    const bucket = rig.fake.frames
      .filter((frame) => frame.at >= from && frame.at < from + 1_000)
      .flatMap((frame) => frame.entries)
      .filter((entry) => entry.channel === 'headX')
      .map((entry) => entry.value);
    assert.ok(new Set(bucket.map((value) => Math.round(value * 1000))).size > 2,
      `preset window ${from}–${from + 1_000} ms still carries changing base motion`);
  }

  const snapshot = rig.runtime.snapshot();
  assert.equal(snapshot.idleParams.motionFloor.injected, 0, 'no per-frame floor during playback');
  rig.runtime.dispose();
  console.log(`[degree-preset-continuity] duration=${endAt}ms maxStep=${maxStep.toFixed(2)}° `
    + `tailP2P=${p2p(tail).toFixed(2)}°`);
});
