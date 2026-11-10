/**
 * Post-preset settle — the autonomous action tail.
 *
 * Run: node --test test/motion-post-preset-settle.mjs
 *
 * What this suite proves:
 *   1. a completed action's TEMPORARY offset is gone and the visible pose is back on the live
 *      natural baseline; a held posture component is released to the natural stance;
 *   2. the base activity (breath / micro-motion / idle sway) keeps running through the tail;
 *   3. the settle continues from the pose AND velocity that really existed at the boundary: it
 *      decelerates first instead of reversing in one frame;
 *   4. eye-open is never pulled to 0 by the settle (absolute channel);
 *   5. a newer preset takes the channel over from the CURRENT pose, and the old task is removed so
 *      it can never overwrite that action later;
 *   6. a short action stays in the 500–1000 ms band; a large component offset extends the window
 *      under the explicit distance/velocity bounds (never a hidden amplitude gain).
 *
 * It does NOT claim the real VTS rendering: the transport is not involved here (the controller is
 * pure), and the visual result on a real model remains TRUE-MACHINE UNVERIFIED.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PRESET_SETTLE,
  PRESET_TAKEOVER,
  createBehaviorRuntime,
} from '../src/host/avatar/motion-controller.js';

const DT = 1000 / 30;
const ALL_CHANNELS = Object.freeze([
  'headX', 'headY', 'headZ', 'gazeX', 'gazeY', 'eyeOpenL', 'eyeOpenR',
  'browL', 'browR', 'bodyX', 'bodyY', 'bodyZ', 'breath',
]);

function makeRuntime(overrides = {}) {
  const runtime = createBehaviorRuntime({
    config: {
      seed: 11,
      idleActions: [],
      presetExecution: true,
      presetTargetVerified: true,
      presetChannels: [...ALL_CHANNELS],
      presetDebugEvents: true,
      // A stable, held component: it is the natural stance the tail has to release when needed.
      postureHoldMinMs: 60_000,
      postureHoldMaxMs: 60_000,
      postureHoldChance: 1,
      postureStillChance: 0,
      postureComponentMinMs: 60_000,
      postureComponentMaxMs: 60_000,
      ...overrides,
    },
  });
  // `presetExecution` enables the autonomous boundary too; a speaking status keeps the random
  // idle draw out of these deterministic tests while the explicit action path stays active.
  runtime.setStatus('speaking', 'post-preset-settle-test');
  return runtime;
}

function pick(runtime, recipe, { state = 'idle', event = 'idle' } = {}) {
  for (let seed = 0; seed < 160; seed += 1) {
    const selection = runtime.selectPreset({ state, event, recipe, seed });
    if (selection.kind === 'preset') return selection;
  }
  return null;
}

function start(runtime, recipe, at) {
  const selection = pick(runtime, recipe);
  assert.ok(selection !== null, `${recipe} must be selectable`);
  const started = runtime.startPreset(selection, {
    at,
    context: { state: 'idle', event: 'idle' },
  });
  assert.equal(started.started, true, `${recipe} must start`);
  return started;
}

/** Tick on the normal 30 Hz grid; `onTick` receives (at, pose, snapshot, runtime). */
function run(runtime, from, to, onTick = null) {
  for (let at = from; at <= to; at += DT) {
    const pose = runtime.tick(at);
    if (onTick !== null) onTick(at, pose, runtime.snapshot(), runtime);
  }
}

const presets = (runtime) => runtime.snapshot().motion.presets;
const settleView = (runtime) => presets(runtime).settle;
const componentView = (runtime) => runtime.snapshot().motion.posture.component;
const headStep = (left, right) => Math.max(
  Math.abs(left.headX - right.headX),
  Math.abs(left.headZ - right.headZ),
);

test('1. 正常完成：动作偏移归零、组件回自然站姿、动态基线继续', () => {
  const runtime = makeRuntime();
  run(runtime, 0, 3_000);
  const componentBefore = componentView(runtime);
  assert.ok(componentBefore !== null, 'a held posture component is active');
  assert.ok(Math.abs(componentBefore.target.headX) + Math.abs(componentBefore.target.headZ) > 0.2,
    'the held component really leans before the action');

  const started = start(runtime, 'idle-sway', 3_000);
  assert.deepEqual([...started.channels].sort(), ['headX', 'headZ']);
  const endAt = 3_000 + started.durationMs;

  const poses = new Map();
  run(runtime, 3_000, endAt + 4_000, (at, pose) => poses.set(at, { ...pose }));
  const events = runtime.takeEvents();
  const settleStart = events.find((event) => event.type === 'avatar.preset.settle.start');
  const componentStart = events.find((event) => event.type === 'avatar.preset.settle.component'
    && event.phase === 'start');
  assert.ok(settleStart !== undefined, 'the completed action starts a settle tail');
  assert.equal(settleStart.reason, 'completed');
  assert.deepEqual([...settleStart.channels].sort(), ['headX', 'headZ']);
  assert.ok(componentStart !== undefined, 'the held component is released by the tail');
  assert.ok(componentStart.axes.includes('headX') && componentStart.axes.includes('headZ'));
  assert.ok(componentStart.durationMs >= PRESET_SETTLE.MIN_MS
    && componentStart.durationMs <= PRESET_SETTLE.MAX_MS,
  `large component release extends the short window (${componentStart.durationMs} ms)`);
  assert.ok(componentStart.durationMs > 1_000,
    `a large component is not forced into the 0.5–1 s short band (${componentStart.durationMs} ms)`);
  // A normal exit already brought the temporary offset back to ~0; the tail must not invent one.
  for (const [channel, offset] of Object.entries(settleStart.offsets)) {
    assert.ok(Math.abs(offset) < 0.05, `${channel} completed offset is near zero (${offset})`);
  }

  const settle = settleView(runtime);
  assert.equal(settle.active.length, 0, 'the tail finished');
  assert.equal(settle.component, null, 'the component release finished');
  assert.ok(settle.completed >= 2, 'both written channels completed');
  assert.ok(settle.componentReleases >= 1, 'one component release completed');

  const after = componentView(runtime);
  assert.ok(after !== null, 'the natural posture component still exists');
  assert.ok(Math.abs(after.target.headX) < 1e-3, `headX component target is natural (${after.target.headX})`);
  assert.ok(Math.abs(after.target.headZ) < 1e-3, `headZ component target is natural (${after.target.headZ})`);

  const finalPose = runtime.snapshot().pose;
  assert.ok(Math.abs(finalPose.headX) < 0.12, `final headX is on the natural baseline (${finalPose.headX})`);
  assert.ok(Math.abs(finalPose.headZ) < 0.12, `final headZ is on the natural baseline (${finalPose.headZ})`);

  // Dynamic baseline: the base sway keeps producing new values after the action is over.
  const late = [...poses.entries()].filter(([at]) => at >= endAt + 2_000);
  assert.ok(late.length > 20, 'there is a post-settle observation window');
  const firstLate = late[0][1];
  const lastLate = late[late.length - 1][1];
  assert.ok(headStep(firstLate, lastLate) > 1e-3,
    `base micro-motion still changes the head after the tail (${headStep(firstLate, lastLate)})`);
  const activity = runtime.snapshot().motion.baseActivity;
  assert.ok(activity.headMotionMs > 100,
    `base head activity accumulated through the tail (${activity.headMotionMs} ms)`);

  // Only the action's own channels are touched; the settle never invents brow/gaze/eye/body rows.
  assert.deepEqual([...settleStart.channels].sort(), ['headX', 'headZ']);
  for (const channel of ['eyeOpenL', 'eyeOpenR', 'browL', 'browR', 'gazeX', 'gazeY', 'bodyX', 'bodyY', 'bodyZ']) {
    assert.equal(settleStart.channels.includes(channel), false, `${channel} is not settled`);
  }
  assert.ok(Math.abs(finalPose.eyeOpenL - 1) < 1e-6 && Math.abs(finalPose.eyeOpenR - 1) < 1e-6,
    'eye-open stays at its natural value');
});

test('2. 取消/打断：真实动作偏移回零，从当前速度接续且不瞬跳', () => {
  const runtime = makeRuntime();
  run(runtime, 0, 3_000);
  start(runtime, 'idle-sway', 3_000);
  // A very short cancel fade leaves a REAL temporary offset for the tail to cancel (a normal
  // 240 ms fade would already reach zero before the item leaves the active list).
  run(runtime, 3_000, 3_500);
  assert.equal(runtime.cancelPreset({ fadeMs: 1, at: 3_500 }).ok, true);

  const poses = [];
  const axisVelocity = [];
  let settleStart = null;
  let maxStep = 0;
  let previous = runtime.snapshot().pose;
  run(runtime, 3_500, 6_500, (at, pose, snapshot) => {
    maxStep = Math.max(maxStep, headStep(previous, pose));
    previous = pose;
    poses.push({ at, ...pose });
    axisVelocity.push({
      at,
      headX: snapshot.motion.axes.headX.velocity,
      headZ: snapshot.motion.axes.headZ.velocity,
    });
    if (settleStart === null && snapshot.motion.presets.settle.channels.length > 0) {
      settleStart = {
        at,
        entries: snapshot.motion.presets.settle.active.map((entry) => ({ ...entry })),
      };
    }
  });

  assert.ok(settleStart !== null, 'the cancelled action starts a settle tail');
  const startEvents = runtime.takeEvents().filter((event) => event.type === 'avatar.preset.settle.start');
  const cancelled = startEvents.find((event) => event.reason === 'cancelled');
  assert.ok(cancelled !== undefined, 'the tail records the cancellation reason');
  const maxOffset = Math.max(...Object.values(cancelled.offsets).map((value) => Math.abs(value)));
  assert.ok(maxOffset > 0.02, `the cancelled action really left a temporary offset (${maxOffset})`);
  for (const entry of settleStart.entries) {
    assert.ok(entry.durationMs >= PRESET_SETTLE.MIN_MS
      && entry.durationMs <= PRESET_SETTLE.MAX_MS, `settle duration is bounded (${entry.durationMs})`);
  }

  // Velocity continuity at the hand-off: the first tail frame must not reverse a moving axis.
  const index = axisVelocity.findIndex((item) => item.at >= settleStart.at);
  assert.ok(index >= 1 && index < axisVelocity.length - 2);
  for (const channel of ['headX', 'headZ']) {
    const before = axisVelocity[index - 1][channel];
    const after = axisVelocity[index + 1][channel];
    if (Math.abs(before) > 0.05) {
      assert.ok(before * after > -0.05 * Math.abs(before),
        `${channel} continues from its current velocity instead of reversing (${before} → ${after})`);
    }
  }
  assert.ok(maxStep < 0.18, `no visible one-frame jump through cancel + tail (${maxStep})`);

  const settle = settleView(runtime);
  assert.equal(settle.active.length, 0, 'the cancelled tail finished');
  assert.equal(settle.component, null);
  const component = componentView(runtime);
  assert.ok(Math.abs(component.target.headX) < 1e-3 && Math.abs(component.target.headZ) < 1e-3,
    'the cancelled component released to the natural stance');
  const finalPose = runtime.snapshot().pose;
  assert.ok(Math.abs(finalPose.headX) < 0.12 && Math.abs(finalPose.headZ) < 0.12,
    `the pose returned to the dynamic natural baseline (${finalPose.headX}/${finalPose.headZ})`);
});

test('3. 眼睛不是回中通道：眨眼后的 eye-open 不被拉向 0', () => {
  const runtime = makeRuntime();
  run(runtime, 0, 3_000);
  const started = start(runtime, 'idle-blink', 3_000);
  assert.deepEqual([...started.channels].sort(), ['eyeOpenL', 'eyeOpenR']);
  const endAt = 3_000 + started.durationMs;
  let minOpenAfterBlink = 1;
  run(runtime, 3_000, endAt + 3_000, (at, pose) => {
    if (at >= endAt) minOpenAfterBlink = Math.min(minOpenAfterBlink, pose.eyeOpenL, pose.eyeOpenR);
  });

  const settle = settleView(runtime);
  assert.equal(settle.starts, 0, 'eye-only actions never create a settle entry');
  assert.deepEqual(settle.channels, []);
  assert.equal(settle.component, null);
  const startEvents = runtime.takeEvents().filter((event) => event.type === 'avatar.preset.settle.start');
  assert.equal(startEvents.length, 0);
  assert.ok(minOpenAfterBlink > 0.9,
    `eye-open returns to its natural open value, never 0 (${minOpenAfterBlink})`);
  const finalPose = runtime.snapshot().pose;
  assert.ok(finalPose.eyeOpenL > 0.9 && finalPose.eyeOpenR > 0.9);
  assert.equal(PRESET_TAKEOVER.ABSOLUTE_CHANNELS.includes('eyeOpenL'), true);
});

test('4. 新动作接管：从当前姿态继续，旧回中任务不得迟到覆盖', () => {
  const runtime = makeRuntime();
  run(runtime, 0, 3_000);
  const first = start(runtime, 'idle-sway', 3_000);
  const firstEnd = 3_000 + first.durationMs;

  let takeoverAt = null;
  let second = null;
  let secondAt = null;
  let peakAfter = 0;
  run(runtime, 3_000, firstEnd + 4_500, (at, pose, snapshot) => {
    if (second === null && snapshot.motion.presets.settle.channels.length > 0) {
      takeoverAt = at;
      secondAt = at + DT;
      const secondSelection = pick(runtime, 'idle-side');
      assert.ok(secondSelection !== null);
      second = runtime.startPreset(secondSelection, {
        at: secondAt,
        context: { state: 'idle', event: 'idle' },
      });
      assert.equal(second.started, true);
      assert.deepEqual(second.channels, ['headX']);
      return;
    }
    if (second !== null && at >= secondAt && at <= secondAt + 800) {
      peakAfter = Math.max(peakAfter, Math.abs(pose.headX));
    }
  });
  assert.ok(takeoverAt !== null, 'the sway tail is running before the new action starts');
  assert.ok(second !== null, 'the replacement action started');

  const events = runtime.takeEvents();
  const takeover = events.find((event) => event.type === 'avatar.preset.settle.takeover');
  assert.ok(takeover !== undefined, 'a newer preset takes the settle over');
  assert.equal(takeover.channel, 'headX');
  assert.match(takeover.by, /^preset:/);
  const componentTakeover = events.find((event) => event.type === 'avatar.preset.settle.component'
    && event.phase === 'takeover');
  assert.ok(componentTakeover !== undefined, 'the component release yields the same axis');
  assert.ok(componentTakeover.axes.includes('headX'));
  const oldDone = events.find((event) => event.type === 'avatar.preset.settle.done'
    && event.channel === 'headX' && event.actionId === first.actionId);
  assert.ok(oldDone !== undefined, 'the old headX task is finished explicitly');
  assert.equal(oldDone.outcome, 'taken-over', 'the old task never claims a completed centre write');
  assert.ok(peakAfter > 0.05, `the new action really drives the channel (${peakAfter})`);

  const settle = settleView(runtime);
  assert.equal(settle.active.some((entry) => entry.actionId === first.actionId
    && entry.channel === 'headX'), false, 'no old headX task is left behind');
  assert.equal(settle.takeovers >= 1, true);
});

test('5. 回中曲线有界：短动作在 0.5–1 s 内，大幅偏移按距离/速度延长', () => {
  assert.ok(PRESET_SETTLE.MIN_MS >= 500 && PRESET_SETTLE.MIN_MS <= 1_000);
  assert.ok(PRESET_SETTLE.DEFAULT_MS >= PRESET_SETTLE.MIN_MS);
  assert.ok(PRESET_SETTLE.MAX_MS > 1_000, 'large moves may extend past the short band');
  assert.ok(PRESET_SETTLE.DISTANCE_SPEED > 0 && PRESET_SETTLE.VELOCITY_DECEL > 0);

  const runtime = makeRuntime();
  run(runtime, 0, 3_000);
  start(runtime, 'idle-sway', 3_000);
  // Force a real residual: a 1 ms cancel removes the item before the fade can scale the last
  // contribution, so the tail has both a non-zero offset and a non-zero velocity to carry.
  run(runtime, 3_000, 3_400);
  runtime.cancelPreset({ fadeMs: 1, at: 3_400 });
  let starts = null;
  run(runtime, 3_400, 3_600, (at, pose, snapshot) => {
    if (starts === null && snapshot.motion.presets.settle.active.length > 0) {
      starts = snapshot.motion.presets.settle.active.map((entry) => ({ ...entry }));
    }
  });
  assert.ok(starts !== null);
  const extended = starts.some((entry) => entry.durationMs > PRESET_SETTLE.MIN_MS);
  assert.equal(extended, true, `a moving offset uses more than the bare minimum (${JSON.stringify(
    starts.map((entry) => entry.durationMs))})`);
  for (const entry of starts) {
    assert.ok(entry.durationMs <= PRESET_SETTLE.MAX_MS, `duration is capped (${entry.durationMs})`);
  }
});
