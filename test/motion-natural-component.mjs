/**
 * The `natural` posture component must never be a 10–20 s all-zero target again.
 *
 * Regression scope:
 *   1. when `natural` is selected its `targetSemantic` / `targetDegrees` are NON-ZERO (and stay
 *      inside the 0.15 component cap), for the whole hold — not only for the first frame;
 *   2. the held shape is constant, so the fix is a small non-zero posture, not a mechanical sway;
 *   3. the base micro-motion is NOT raised (no non-zero floor, no global gain): the evidence's
 *      `idle − mixed` baseline stays inside the same light caps as the phase-3 suite;
 *   4. two consecutive components never repeat, including when the first one is natural;
 *   5. the same seed reproduces the exact component/pose trajectory and a different seed differs;
 *   6. a verified head mapping annotates the angle; an unmapped channel is explicitly `unknown`
 *      (the pure controller's 30° annotation is a convention, not a verified transport angle).
 *
 * No real VTS is contacted. Real visual appearance of the natural bias remains UNVERIFIED.
 *
 * Run: node --test test/motion-natural-component.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  POSTURE_COMPONENT_CHANNELS,
  POSTURE_COMPONENT_MAX_AMPLITUDE,
  POSTURE_COMPONENT_MIN_AMPLITUDE,
  POSTURE_COMPONENT_MIN_MS,
  createBehaviorRuntime,
} from '../src/host/avatar/motion-controller.js';
import { createAvatarRuntime } from '../src/host/avatar/avatarRuntime.js';

const DT = 1000 / 30;
const HEAD = Object.freeze(['headX', 'headY', 'headZ']);
/** Base micro-motion bounds for the trial: 1.5–4.5° peak-to-peak, never a 10° forced swing. */
const BASE_P2P_MIN = 1.5;
const BASE_P2P_MAX = 4.5;
/**
 * The natural target must stay above this equivalent angle so it is a real goal rather than a
 * numerical trace. This is the writer's 30°-per-unit convention, NOT a measured real-head angle;
 * real visual visibility is unverified (no real VTS in this suite).
 */
const MIN_DISCERNIBLE_DEGREES = 0.5;

const flush = () => new Promise((resolve) => setImmediate(resolve));
const approx = (actual, expected, message, tolerance = 1e-6) => {
  assert.ok(Math.abs(actual - expected) <= tolerance,
    `${message} (actual ${actual}, expected ${expected})`);
};

/** A stable component rhythm: the posture re-draw must not cut the component window short. */
function naturalConfig(seed, extra = {}) {
  return {
    seed,
    idleActions: [],
    postureHoldMinMs: 60_000,
    postureHoldMaxMs: 60_000,
    postureHoldChance: 1,
    postureStillChance: 0,
    postureComponentMinMs: 10_000,
    postureComponentMaxMs: 10_000,
    componentGazeVerified: false,
    ...extra,
  };
}

/** The first seed whose FIRST component draw is natural. */
function naturalFirstSeed(limit = 40) {
  for (let seed = 0; seed < limit; seed += 1) {
    const runtime = createBehaviorRuntime({ config: naturalConfig(seed) });
    runtime.tick(0);
    const component = runtime.snapshot().motion.posture.component;
    if (component !== null && component.id === 'natural') return seed;
  }
  throw new Error(`no seed in 0..${limit - 1} drew natural first`);
}

/** Tick one pure controller through the natural hold and keep every frame's evidence. */
function observeNatural(seed, toMs = 9_000) {
  const runtime = createBehaviorRuntime({ config: naturalConfig(seed) });
  const frames = [];
  for (let at = 0; at <= toMs; at += DT) {
    const pose = runtime.tick(at);
    const motion = runtime.snapshot().motion;
    frames.push({ at, pose, component: motion.posture.component });
  }
  return { runtime, frames };
}

// ---------------------------------------------------------------------------------------------
// 1. natural is a real, small, constant non-zero target — not an all-zero long hold
// ---------------------------------------------------------------------------------------------
test('1. natural 选中：targetSemantic 非零且 ≤0.40，保持恒定，角度可换算', () => {
  const seed = naturalFirstSeed();
  const { frames } = observeNatural(seed);
  assert.ok(frames.length > 100, `enough natural frames (${frames.length})`);

  const targetSets = new Set();
  let maxSemantic = 0;
  let maxDegrees = 0;
  let firstComponent = null;

  for (const { component } of frames) {
    assert.ok(component !== null, 'a component is held for the whole window');
    assert.equal(component.id, 'natural', `the hold stayed natural (seed ${seed})`);
    assert.equal(component.durationMs, POSTURE_COMPONENT_MIN_MS,
      'the natural hold uses the same 10–20 s window as every component');
    if (firstComponent === null) firstComponent = component;

    // The bug was an ALL-ZERO target. Both non-zero natural axes must carry a real goal.
    assert.ok(component.semantic.headX > 0, `natural yaw target is non-zero (${component.semantic.headX})`);
    assert.ok(component.semantic.headZ > 0, `natural roll target is non-zero (${component.semantic.headZ})`);
    assert.deepEqual(component.targetSemantic, component.semantic,
      'the named targetSemantic view is the held semantic target');
    assert.deepEqual(component.observed.targetSemantic, component.semantic,
      'the per-frame observed target evidence is not zero either');

    for (const channel of POSTURE_COMPONENT_CHANNELS) {
      const semantic = component.semantic[channel];
      assert.ok(Number.isFinite(semantic), `${channel} semantic target is finite`);
      assert.ok(Math.abs(semantic) <= POSTURE_COMPONENT_MAX_AMPLITUDE + 1e-9,
        `${channel} natural semantic ${semantic} ≤ ${POSTURE_COMPONENT_MAX_AMPLITUDE}`);
      maxSemantic = Math.max(maxSemantic, Math.abs(semantic));

      const degrees = component.targetDegrees[channel];
      approx(degrees, semantic * 30, `${channel} targetDegrees follows the 30°-per-unit convention`);
      maxDegrees = Math.max(maxDegrees, Math.abs(degrees));
    }
    targetSets.add(JSON.stringify(component.semantic));
  }

  assert.equal(targetSets.size, 1, 'the natural shape is held constant, not mechanically swayed');
  assert.ok(maxSemantic > 0, 'the natural target is not the old all-zero vector');
  assert.ok(maxSemantic >= POSTURE_COMPONENT_MIN_AMPLITUDE * 0.2 - 1e-9,
    `the natural target is a real posture, not floating-point noise (${maxSemantic})`);
  assert.ok(maxDegrees >= MIN_DISCERNIBLE_DEGREES,
    `natural carries a discernible equivalent angle (${maxDegrees.toFixed(3)}°)`);
  // The target is non-zero, but the INSTANTANEOUS output is not floored: the pose still starts at
  // rest, so the component transition can pass through zero instead of snapping to the target.
  const firstPose = frames[0].pose;
  assert.ok(Math.abs(firstPose.headX) < 0.01 && Math.abs(firstPose.headZ) < 0.01,
    `the pose is not floored to the non-zero target (${firstPose.headX}, ${firstPose.headZ})`);
  // The pure controller can only publish the writer convention; a real transport angle needs a
  // verified mapping (test 4 covers mapped vs unknown).
  assert.match(String(firstComponent.targetDegreesBasis), /mapping-unverified|unknown/u,
    'without a verified transport mapping the angle basis is marked, never claimed as measured');

  console.log(`[natural] seed=${seed} targetSemantic=headX ${firstComponent.semantic.headX.toFixed(4)} `
    + `headZ ${firstComponent.semantic.headZ.toFixed(4)} `
    + `→ ${Math.abs(firstComponent.targetDegrees.headX).toFixed(3)}° / `
    + `${Math.abs(firstComponent.targetDegrees.headZ).toFixed(3)}° (mapping unverified)`);
});

// ---------------------------------------------------------------------------------------------
// 2. the base micro-motion is still light: the component offset is not a global gain/floor
// ---------------------------------------------------------------------------------------------
test('2. natural 期间基础微动持续：60s 峰峰值约 1.5–4.5°，不是固定住十几秒', () => {
  const seed = naturalFirstSeed();
  const runtime = createBehaviorRuntime({ config: naturalConfig(seed) });
  const baseMin = { headX: Number.POSITIVE_INFINITY, headY: Number.POSITIVE_INFINITY, headZ: Number.POSITIVE_INFINITY };
  const baseHigh = { headX: Number.NEGATIVE_INFINITY, headY: Number.NEGATIVE_INFINITY, headZ: Number.NEGATIVE_INFINITY };
  let samples = 0;

  for (let at = 0; at <= 60_000; at += DT) {
    runtime.tick(at);
    const component = runtime.snapshot().motion.posture.component;
    assert.ok(component?.observed !== null && component?.observed !== undefined,
      'per-frame target/mixed/idle evidence exists');
    // A component swap is interpolated over 1.2–1.8 s; during it `idle` still carries the previous
    // component while `mixed` already names the new one, so do not read that window as base motion.
    if (at - component.startedAt < 2_000) continue;
    samples += 1;
    for (const channel of HEAD) {
      // `idle` is the composed idle base (base swing + drift + component). Removing the component
      // share leaves the base micro-motion this fix must NOT have raised.
      const base = (component.observed.idle?.[channel] ?? 0) - (component.observed.mixed?.[channel] ?? 0);
      baseMin[channel] = Math.min(baseMin[channel], base);
      baseHigh[channel] = Math.max(baseHigh[channel], base);
    }
  }

  assert.ok(samples > 1_000, `enough settled base frames (${samples})`);
  for (const channel of HEAD) {
    const p2p = (baseHigh[channel] - baseMin[channel]) * 30;
    assert.ok(p2p >= BASE_P2P_MIN,
      `base ${channel} keeps moving (${p2p.toFixed(2)}° p2p ≥ ${BASE_P2P_MIN}°)`);
    assert.ok(p2p <= BASE_P2P_MAX,
      `base ${channel} stays light (${p2p.toFixed(2)}° p2p ≤ ${BASE_P2P_MAX}°)`);
  }
  assert.ok(Math.abs(baseHigh.headX) > 0 && Math.abs(baseHigh.headY) > 0 && Math.abs(baseHigh.headZ) > 0,
    'the base layer is present on every axis');

  const baseDegrees = HEAD.map((channel) => ((baseHigh[channel] - baseMin[channel]) * 30).toFixed(2)).join('/');
  console.log(`[natural-base] 60s baseP2P headX/Y/Z=${baseDegrees}° (trial 1.5–4.5°), base still moving`);
});

// ---------------------------------------------------------------------------------------------
// 3. two consecutive components never repeat; the same seed reproduces the trajectory
// ---------------------------------------------------------------------------------------------
test('3. 连续两个组件不重复；同 seed 复现，异 seed 不同', () => {
  const seed = naturalFirstSeed();
  const collect = (s) => {
    const runtime = createBehaviorRuntime({ config: naturalConfig(s) });
    const rows = [];
    const starts = [];
    for (let at = 0; at <= 25_000; at += DT) {
      const pose = runtime.tick(at);
      const component = runtime.snapshot().motion.posture.component;
      if (component !== null && !starts.some((entry) => entry.at === component.startedAt)) {
        starts.push({ at: component.startedAt, id: component.id });
      }
      rows.push([
        pose.headX, pose.headY, pose.headZ,
        component?.id ?? null,
        component?.startedAt ?? null,
        component?.semantic?.headZ ?? null,
      ]);
    }
    return { rows, starts, motion: runtime.snapshot().motion };
  };

  const first = collect(seed);
  const second = collect(seed);
  const other = collect(seed + 1);

  assert.equal(first.starts[0].id, 'natural', 'the measured window starts on a natural draw');
  assert.ok(first.starts.length >= 2, `at least two components were drawn (${first.starts.length})`);
  for (let index = 1; index < first.starts.length; index += 1) {
    assert.notEqual(first.starts[index].id, first.starts[index - 1].id,
      `back-to-back components differ (${first.starts[index - 1].id} → ${first.starts[index].id})`);
  }
  assert.ok(first.motion.posture.componentHistory.length >= 2,
    'the component history recorded the draws');
  assert.deepEqual(first.rows, second.rows,
    'the same seed produced a different natural/component trajectory');
  assert.notDeepEqual(first.rows, other.rows,
    'a different seed produced an identical trajectory');
  assert.ok(first.motion.posture.componentTransitions >= 1,
    'a component swap really happened in the measured window');

  console.log(`[natural-repeat] starts=${first.starts.map((entry) => entry.id).join('→')} `
    + `sameSeed=true otherSeedDiffers=true`);
});

// ---------------------------------------------------------------------------------------------
// 4. verified mapping → angle; unmapped → unknown (never a guessed transport angle)
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
  return { frames, transport, setClock(at) { clock = at; } };
}

test('4. 已验证 headX 映射给出角度；未映射 headZ 标 unknown', async (t) => {
  const seed = naturalFirstSeed();
  const fake = createFakeTransport();
  let clock = 0;
  const runtime = createAvatarRuntime({
    transport: fake.transport,
    now: () => clock,
    config: {
      autoTickMs: 0,
      flushIntervalMs: 1,
      idleWriteHz: 10,
      motionWrites: false,
      componentGazeEnabled: false,
      ...naturalConfig(seed),
    },
  });
  t.after(() => runtime.dispose());
  const connected = await runtime.connect();
  assert.equal(connected.ok, true, `runtime connects (${connected.message ?? ''})`);
  // Only headX is mapped: headZ can never claim a verified angle.
  const mapped = await runtime.setChannelMappings([
    { channel: 'headX', inputName: 'P_headX', min: -30, max: 30, injectable: true, verified: true },
  ], { channelMap: {} });
  assert.equal(mapped.ok, true, 'channel mappings apply');

  for (let at = 0; at <= 2_000; at += DT) {
    clock = at;
    fake.setClock(at);
    runtime.tick(at);
    await flush();
  }
  await flush();
  await flush();

  const snapshot = runtime.snapshot();
  assert.equal(snapshot.motion.posture.component.id, 'natural',
    'the mapped run is holding the natural component');
  const evidence = snapshot.motion.componentEvidence;
  assert.ok(evidence !== null && evidence !== undefined, 'component evidence exists');

  const headX = evidence.channels.headX;
  assert.ok(headX.targetSemantic > 0, `mapped headX target semantic is non-zero (${headX.targetSemantic})`);
  assert.ok(headX.targetDegrees > 0, `mapped headX angle is non-zero (${headX.targetDegrees}°)`);
  assert.equal(headX.targetDegreesBasis, 'verified-head-30deg-per-semantic-unit');
  approx(headX.targetDegrees, headX.targetSemantic * 30,
    'the verified head mapping keeps the 30° convention');

  const headZ = evidence.channels.headZ;
  assert.ok(headZ.targetSemantic > 0, `unmapped headZ target semantic is still non-zero (${headZ.targetSemantic})`);
  assert.equal(headZ.targetDegrees, null, 'an unmapped channel has no guessed angle');
  assert.equal(headZ.targetDegreesBasis, 'unknown', 'an unmapped channel is explicitly unknown');

  console.log(`[natural-mapping] headX=${headX.targetSemantic.toFixed(4)}`
    + `/${headX.targetDegrees.toFixed(3)}° (${headX.targetDegreesBasis}) `
    + `headZ=${headZ.targetSemantic.toFixed(4)}/unknown(${headZ.targetDegreesBasis})`);
});
