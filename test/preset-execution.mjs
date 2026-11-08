/**
 * Motion preset execution — controller wiring acceptance.
 *
 * The library in `src/host/avatar/presets/` is read-only here. These tests exercise the executor:
 * selection boundaries, symbolic operation order, capability filtering, hold, no-target,
 * style consumers, interruption and the three-layer trace. They deliberately never assert a
 * visible-amplitude floor: standing still is a legal outcome.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createBehaviorRuntime,
  PRESET_EXECUTION,
} from '../src/host/avatar/motion-controller.js';
import { createAvatarRuntime } from '../src/host/avatar/avatarRuntime.js';
import { PRESETS } from '../src/host/avatar/presets/index.js';

const ALL_CHANNELS = Object.freeze([
  'headX', 'headY', 'headZ', 'gazeX', 'gazeY', 'eyeOpenL', 'eyeOpenR',
  'browL', 'browR', 'bodyX', 'bodyY', 'bodyZ', 'breath',
]);
const ALL_FAMILIES = [...new Set(PRESETS.map((preset) => preset.family))];

function makeRuntime({ style = null, enabled = false, overrides = null } = {}) {
  return createBehaviorRuntime({
    config: {
      seed: 11,
      presetExecution: enabled,
      presetTargetVerified: true,
      presetChannels: [...ALL_CHANNELS],
      ...(overrides === null ? {} : { presetOverrides: overrides }),
      ...(style === null ? {} : { style }),
    },
  });
}

/** Tick the controller on the normal 30 Hz grid. */
function run(runtime, fromMs, toMs, stepMs = 33) {
  for (let at = fromMs; at <= toMs; at += stepMs) runtime.tick(at);
}

/** Narrowing to one recipe still shares the hold option, so try several reproducible seeds. */
function pick(runtime, context) {
  for (let seed = 0; seed < 96; seed += 1) {
    const selection = runtime.selectPreset({ ...context, seed });
    if (selection.kind === 'preset') return selection;
  }
  return null;
}

function presetSnapshot(runtime) {
  return runtime.snapshot().motion.presets;
}

test('1. 复合预设保留编舞结构：按操作顺序写入各自通道与阶段', () => {
  const runtime = makeRuntime();
  const selection = pick(runtime, {
    state: 'idle', event: 'idle', recipe: 'idle-side-tilt',
  });
  assert.ok(selection !== null, 'idle-side-tilt must be selectable');
  assert.deepEqual(selection.operations, ['head-turn', 'head-tilt']);

  const started = runtime.startPreset(selection, { at: 0 });
  assert.equal(started.started, true);
  run(runtime, 0, 2800);

  const trace = presetSnapshot(runtime).lastTrace;
  assert.equal(trace.selection.kind, 'preset');
  assert.deepEqual(trace.output.stages.map((stage) => stage.op), ['head-turn', 'head-tilt']);
  const [turn, tilt] = trace.output.stages;
  assert.deepEqual(turn.channels, ['headX']);
  assert.deepEqual(tilt.channels, ['headZ']);
  assert.ok(turn.firstWriteAt !== null && tilt.firstWriteAt !== null);
  assert.ok(turn.firstWriteAt < tilt.firstWriteAt, 'first operation must start first');
  assert.deepEqual([...trace.output.channels].sort(), ['headX', 'headZ']);
  assert.ok(turn.phases.includes('prepare'));
  assert.ok(turn.phases.includes('active'));
  assert.ok(turn.phases.includes('hold'));
  assert.ok(turn.phases.includes('exit'));
  assert.ok(Math.abs(trace.output.computed.headX ?? 0) > 0);
  assert.ok(Math.abs(trace.output.computed.headZ ?? 0) > 0);
  // No transport is attached to this pure controller, so nothing can be committed.
  assert.deepEqual(trace.output.committed, {});
  assert.equal(trace.output.reason, 'completed');
});

test('2. 单通道预设只写自己的通道，不被强行加通道', () => {
  const runtime = makeRuntime();
  const selection = pick(runtime, { state: 'idle', event: 'idle', recipe: 'idle-tilt' });
  assert.ok(selection !== null);
  assert.deepEqual(selection.operations, ['head-tilt']);

  const started = runtime.startPreset(selection, { at: 0 });
  assert.equal(started.started, true);
  assert.deepEqual(started.channels, ['headZ']);
  run(runtime, 0, 1800);

  const trace = presetSnapshot(runtime).lastTrace;
  assert.deepEqual(trace.output.channels, ['headZ']);
  assert.deepEqual(trace.output.stages.map((stage) => stage.op), ['head-tilt']);
  assert.deepEqual(trace.output.stages[0].channels, ['headZ']);
  assert.equal(trace.output.channels.includes('headX'), false);
});

test('3. 能力不足时换候选，不静默退化：输出只到已验证通道', () => {
  const runtime = makeRuntime();
  // The requested recipe needs headZ, which this model does not verify: it must NOT be
  // partially executed; the selector returns a hold instead.
  const forced = runtime.selectPreset({
    state: 'idle', event: 'idle', recipe: 'idle-side-tilt',
    verifiedChannels: ['headX'], seed: 0,
  });
  assert.equal(forced.kind, 'hold');
  assert.ok(forced.reasons.includes('no-candidates'));

  // A different candidate family still resolves on the one verified channel.
  const alternative = pick(runtime, {
    state: 'idle', event: 'idle', family: 'attention', verifiedChannels: ['headX'],
  });
  assert.ok(alternative !== null);
  assert.ok(alternative.effectiveRequires.every((channel) => channel === 'headX'));
  assert.deepEqual(alternative.droppedChannels, [], 'no partial/dropped execution');

  const started = runtime.startPreset(alternative, { at: 0 });
  assert.equal(started.started, true);
  run(runtime, 0, 1800);
  const trace = presetSnapshot(runtime).lastTrace;
  assert.deepEqual(trace.output.channels, ['headX']);
  assert.ok(trace.output.channels.every((channel) => channel === 'headX'));

  // Body and breath stay VTS-native: a preset needing only them is never a candidate.
  const nativeOnly = runtime.selectPreset({
    state: 'idle', event: 'idle', verifiedChannels: ['bodyX', 'breath'], seed: 0,
  });
  assert.equal(nativeOnly.kind, 'hold');
  assert.ok(nativeOnly.reasons.some((reason) => reason.startsWith('native-owned:')));

  // User overrides are read from the same shape as motion-presets.json (disabled / priority).
  runtime.setPresetOverrides({ actionPriority: { 'idle-tilt': 100 } });
  const boosted = pick(runtime, { state: 'idle', event: 'idle', recipe: 'idle-tilt' });
  assert.ok(boosted !== null);
  assert.ok(boosted.reasons.includes('priority:100'));
});

test('4. hold = 保持当前姿态：不产生任何动作写入', () => {
  const runtime = makeRuntime({
    enabled: true,
    overrides: { disabledFamilies: ALL_FAMILIES },
  });
  // Warm up the initial posture draw once; the hold window itself is 10–20 s, so the target is a
  // stable baseline for the whole observation and any change would be a real forced drive.
  run(runtime, 0, 200);
  const before = { ...runtime.snapshot().motion.posture.target };
  run(runtime, 233, 10_000);
  const snap = presetSnapshot(runtime);
  assert.equal(snap.starts, 0);
  assert.ok(snap.holds > 0);
  assert.equal(snap.active.length, 0);
  assert.equal(snap.lastTrace.selection.kind, 'hold');
  assert.deepEqual(snap.lastTrace.output.channels, []);
  assert.ok(snap.lastTrace.selection.reasons.includes('hold'));
  assert.deepEqual(runtime.snapshot().motion.posture.target, before);
});

test('5. 无真实目标：排除需要目标的候选，trace 记原因，不假装注视', () => {
  const runtime = makeRuntime();
  const held = runtime.selectPreset({
    state: 'listening', event: 'user-speaking', recipe: 'listen-look',
    verifiedChannels: ['gazeX', 'gazeY'], targetVerified: false, seed: 0,
  });
  assert.equal(held.kind, 'hold');
  assert.ok(held.reasons.includes('requires-target'));
  assert.ok(held.reasons.includes('target-unverified'));

  const chosen = pick(runtime, {
    state: 'listening', event: 'user-speaking', recipe: 'listen-lower',
    verifiedChannels: ['headY'], targetVerified: false,
  });
  assert.ok(chosen !== null);
  assert.notEqual(chosen.requiresTarget, true);
  const started = runtime.startPreset(chosen, { at: 0 });
  assert.equal(started.started, true);
  run(runtime, 0, 1200);
  const trace = presetSnapshot(runtime).lastTrace;
  assert.equal(trace.selection.targetVerified, false);
  assert.ok(trace.selection.reasons.includes('target-unverified'));
  assert.equal(trace.selection.presetId.includes('look'), false);
});

test('6. 风格字段有真实消费者：tiltChance 改偏头分布，gazeHabit 改注视/移开与停留', () => {
  function distribution(style) {
    const runtime = makeRuntime({ style });
    const counts = { tilt: 0, target: 0, away: 0, preset: 0 };
    for (let seed = 0; seed < 160; seed += 1) {
      const selection = runtime.selectPreset({ state: 'idle', event: 'idle', seed });
      if (selection.kind !== 'preset') continue;
      counts.preset += 1;
      if (selection.operations.includes('head-tilt')) counts.tilt += 1;
      if (selection.operations.includes('gaze-target')) counts.target += 1;
      if (selection.operations.some((operation) => operation.startsWith('gaze-'))) counts.away += 1;
    }
    return counts;
  }

  const lowTilt = distribution({ tiltChance: 0.02 });
  const highTilt = distribution({ tiltChance: 0.5 });
  assert.ok(highTilt.tilt > lowTilt.tilt, `high tilt ${highTilt.tilt} > low ${lowTilt.tilt}`);

  const wandering = distribution({ gazeHabit: 'wandering' });
  const direct = distribution({ gazeHabit: 'direct' });
  assert.ok(wandering.away > direct.away, `wandering away ${wandering.away} > direct ${direct.away}`);
  assert.ok(direct.target > wandering.target, `direct target ${direct.target} > wandering ${wandering.target}`);

  function dwellMs(style, recipe) {
    const runtime = makeRuntime({ style });
    const selection = pick(runtime, { state: 'idle', event: 'idle', recipe, targetVerified: true });
    assert.ok(selection !== null);
    runtime.startPreset(selection, { at: 0 });
    run(runtime, 0, 2600);
    const trace = presetSnapshot(runtime).lastTrace;
    return trace.output.stages[0].holdMs;
  }
  const wanderingDwell = dwellMs({ gazeHabit: 'wandering' }, 'idle-eye-side');
  const directDwell = dwellMs({ gazeHabit: 'direct' }, 'idle-eye-side');
  assert.ok(wanderingDwell > directDwell, `wandering dwell ${wanderingDwell} > direct ${directDwell}`);
});

test('7. 无统一可见性下限：安静人设静止时不被强行驱动，动作幅度不被抬到下限', () => {
  assert.equal(Object.prototype.hasOwnProperty.call(PRESET_EXECUTION, 'VISIBLE_FLOOR'), false);
  const still = makeRuntime({
    enabled: true,
    style: { amplitude: 0.05, tiltChance: 0.02 },
    overrides: { disabledFamilies: ALL_FAMILIES },
  });
  run(still, 0, 15_000);
  const snap = presetSnapshot(still);
  assert.equal(snap.starts, 0);
  assert.ok(snap.holds > 0);
  assert.ok(snap.lastTrace.selection.reasons.includes('hold'));
  assert.deepEqual(snap.lastTrace.output.channels, []);
  assert.equal(snap.lastTrace.output.peak, 0);

  const quiet = makeRuntime({ style: { amplitude: 0.05, tiltChance: 0.02 } });
  const selection = pick(quiet, { state: 'idle', event: 'idle', recipe: 'idle-tilt' });
  assert.ok(selection !== null);
  quiet.startPreset(selection, { at: 0 });
  run(quiet, 0, 1800);
  const trace = presetSnapshot(quiet).lastTrace;
  assert.ok(trace.output.peak > 0, 'a quiet persona still expresses');
  assert.ok(trace.output.peak < 0.08, `no visible floor was applied: peak ${trace.output.peak}`);
});

test('8. trace 三层存在；channels=[] 时带有明确原因', () => {
  const runtime = makeRuntime({
    enabled: true,
    overrides: { disabledFamilies: ALL_FAMILIES },
  });
  const held = runtime.preset({ state: 'idle', event: 'idle', seed: 0 });
  assert.equal(held.started, false);
  const holdTrace = presetSnapshot(runtime).lastTrace;
  assert.ok(holdTrace.selection !== undefined);
  assert.ok(holdTrace.output !== undefined);
  assert.ok(holdTrace.visible !== undefined);
  assert.equal(holdTrace.visible.verifiable, false);
  assert.deepEqual(holdTrace.output.channels, []);
  assert.ok(holdTrace.selection.reasons.includes('hold'));
  assert.ok(holdTrace.output.reason.length > 0);

  const activeRuntime = makeRuntime();
  const selection = pick(activeRuntime, {
    state: 'idle', event: 'idle', recipe: 'idle-side-tilt',
  });
  activeRuntime.startPreset(selection, { at: 0 });
  run(activeRuntime, 0, 300);
  const activeTrace = presetSnapshot(activeRuntime).currentTrace;
  assert.ok(activeTrace !== null);
  assert.ok(activeTrace.selection.reasons.length > 0);
  assert.ok(activeTrace.output.channels.length > 0);
  assert.equal(activeTrace.visible.verifiable, false);
  assert.equal(activeTrace.visible.reason, 'render-not-observable');
});

test('9. 打断/切场景/切模型：旧动作不再贡献，新动作只含自己的通道', () => {
  function startHeadTurn(runtime, at) {
    const selection = pick(runtime, { state: 'idle', event: 'idle', recipe: 'idle-side' });
    assert.ok(selection !== null);
    assert.deepEqual(selection.operations, ['head-turn']);
    runtime.startPreset(selection, { at, generation: 0 });
    return selection;
  }

  // Hard generation switch (model/scene switch): the old trajectory is gone, not paused.
  const switched = makeRuntime();
  const old = startHeadTurn(switched, 0);
  run(switched, 0, 400);
  assert.equal(presetSnapshot(switched).active.length, 1);
  switched.clearIntents({ reason: 'model-switch', at: 400 });
  assert.equal(presetSnapshot(switched).active.length, 0);
  const replacement = pick(switched, { state: 'idle', event: 'idle', recipe: 'idle-tilt' });
  switched.startPreset(replacement, { at: 500 });
  run(switched, 500, 2400);
  const trace = presetSnapshot(switched).lastTrace;
  assert.deepEqual(trace.output.channels, ['headZ']);
  assert.notEqual(trace.selection.presetId, old.presetId);
  assert.equal(presetSnapshot(switched).active.some((item) => item.presetId === old.presetId), false);

  // Barge-in interrupt: the stop is a short smooth fade, then the old trajectory is gone.
  const interrupted = makeRuntime();
  const before = startHeadTurn(interrupted, 0);
  run(interrupted, 0, 300);
  interrupted.interrupt({ reason: 'barge-in' });
  assert.equal(presetSnapshot(interrupted).active[0]?.cancelled, true);
  run(interrupted, 333, 700);
  assert.equal(presetSnapshot(interrupted).active.length, 0);
  const after = pick(interrupted, { state: 'idle', event: 'idle', recipe: 'idle-tilt' });
  interrupted.startPreset(after, { at: 800 });
  run(interrupted, 800, 2600);
  const finalTrace = presetSnapshot(interrupted).lastTrace;
  assert.deepEqual(finalTrace.output.channels, ['headZ']);
  assert.notEqual(finalTrace.selection.presetId, before.presetId);
});

test('10. 控制器接线：意图事件边界走 select/preset，动作不再来自旧四意图', async () => {
  let clock = 0;
  const frames = [];
  const transport = {
    connect: async () => {},
    disconnect: async () => {},
    write: async () => ({ ok: true }),
    writeMotion: async (payload) => { frames.push(payload); return { ok: true }; },
  };
  const runtime = createAvatarRuntime({
    transport,
    now: () => clock,
    config: {
      autoTickMs: 0,
      flushIntervalMs: 1,
      idleActions: [],
      idleSwayScale: 0,
      motionWrites: true,
      motionOutputHz: 30,
      presetExecution: true,
    },
  });
  assert.equal((await runtime.connect()).ok, true);
  const rows = ['headX', 'headY', 'headZ', 'gazeX', 'gazeY', 'eyeOpenL', 'eyeOpenR', 'browL', 'browR']
    .map((channel) => ({ channel, inputName: `P_${channel}`, injectable: true, verified: true }));
  await runtime.setChannelMappings(rows, { channelMap: {} });
  assert.equal(runtime.snapshot().motion.presets.enabled, true);
  runtime.setStatus('thinking', 'preset-test');
  runtime.intentEvent('confused', { at: 0 });
  runtime.speechClip('start', { at: 0 });

  const action = runtime.snapshot().actions.current;
  assert.ok(action !== null, 'the boundary must start an action');
  assert.match(action.name, /^confused-/, 'the action name is a stable preset id');
  assert.notEqual(action.name, 'tilt', 'it is not the legacy four-intent mapping');
  assert.ok(action.presetOperations.length > 0);

  const trace = runtime.snapshot().motion.presets.currentTrace;
  assert.ok(trace !== null);
  assert.equal(trace.selection.kind, 'preset');
  assert.deepEqual(trace.selection.operations, action.presetOperations);

  for (const at of [0, 400, 800]) {
    clock = at;
    runtime.tick(at);
    await new Promise((resolve) => setImmediate(resolve));
  }
  const written = new Set(frames.flatMap((frame) => frame.entries.map((entry) => entry.channel)));
  const liveTrace = runtime.snapshot().motion.presets.currentTrace;
  assert.ok(liveTrace.output.channels.length > 0, 'the preset trajectory produced channel output');
  assert.ok(liveTrace.output.channels.every((channel) => written.has(channel)),
    'every preset channel reached the one transport writer');
});
