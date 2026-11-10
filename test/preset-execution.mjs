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
import { readFileSync } from 'node:fs';

import {
  createBehaviorRuntime,
  PRESET_EXECUTION,
  PRESET_GESTURE_GAIN,
} from '../src/host/avatar/motion-controller.js';
import { createAvatarRuntime } from '../src/host/avatar/avatarRuntime.js';
import { PRESETS } from '../src/host/avatar/presets/index.js';

const ALL_CHANNELS = Object.freeze([
  'headX', 'headY', 'headZ', 'gazeX', 'gazeY', 'eyeOpenL', 'eyeOpenR',
  'browL', 'browR', 'bodyX', 'bodyY', 'bodyZ', 'breath',
]);
const ALL_FAMILIES = [...new Set(PRESETS.map((preset) => preset.family))];

function makeRuntime({
  style = null, enabled = false, overrides = null, debugEvents = true, extraConfig = {},
} = {}) {
  return createBehaviorRuntime({
    config: {
      seed: 11,
      presetExecution: enabled,
      presetTargetVerified: true,
      presetChannels: [...ALL_CHANNELS],
      presetDebugEvents: debugEvents,
      ...(overrides === null ? {} : { presetOverrides: overrides }),
      ...(style === null ? {} : { style }),
      ...extraConfig,
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

test('7. 动作目标有可辨下限，但不是每帧 floor；安静人设静止时不被强行驱动', () => {
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
  // The target itself has a visible 10–20° band (a planned head goal, not a per-frame floor); the
  // hold/still branch above still writes nothing.
  assert.ok(trace.output.peakDegrees >= 10 - 1e-6 && trace.output.peakDegrees <= 20 + 1e-6,
    `quiet head target ${trace.output.peakDegrees.toFixed(2)}° is inside the visible 10–20° band`);
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

// ---------------------------------------------------------------------------------------------
// Preset decision observability (read-only): the events + projection answer "did the idle preset
// really run, and what filtered it out". These tests only READ; they never assert a new writer.
// ---------------------------------------------------------------------------------------------
const DECISION_EVENT_TYPES = Object.freeze([
  'avatar.preset.select', 'avatar.preset.skip', 'avatar.preset.commit',
]);
const SKIP_REASONS = Object.freeze(['no-candidate', 'hold', 'channel-unverified', 'throttled', 'busy']);

/** Tick an idle runtime, draining the diagnostic buffer so nothing is lost to the ring cap. */
function idleEvents(runtime, toMs, fromMs = 0, stepMs = 33) {
  const events = [];
  for (let at = fromMs; at <= toMs; at += stepMs) {
    runtime.tick(at);
    events.push(...runtime.takeEvents());
  }
  return events;
}

const decisionEvents = (events) => events.filter((event) => DECISION_EVENT_TYPES.includes(event.type));

test('11. 待机决策事件：select/skip 字段齐全，同类事件 1 秒内至多 1 条', () => {
  // A boosted action keeps the draw on a preset (hold still competes, so both remain visible).
  const runtime = makeRuntime({ enabled: true, overrides: { actionPriority: { 'idle-tilt': 100 } } });
  const decisions = decisionEvents(idleEvents(runtime, 20_000));
  assert.ok(decisions.length >= 2, `the idle rhythm published decisions: ${decisions.length}`);

  const selects = decisions.filter((event) => event.type === 'avatar.preset.select');
  assert.ok(selects.length >= 1, 'an idle draw selected a preset');
  for (const row of selects) {
    assert.equal(typeof row.presetId, 'string');
    assert.equal(typeof row.family, 'string');
    assert.equal(typeof row.recipe, 'string');
    assert.equal(typeof row.variant, 'string');
    assert.equal(row.event, 'idle');
    assert.equal(typeof row.score, 'number');
    assert.ok(Array.isArray(row.channels) && row.channels.length > 0, 'selected channels are named');
  }

  const skips = decisions.filter((event) => event.type === 'avatar.preset.skip');
  assert.ok(skips.length >= 1, 'a wait/skip is observable (the throttled idle gate)');
  for (const row of skips) {
    assert.ok(SKIP_REASONS.includes(row.reason), `skip reason is the closed vocabulary: ${row.reason}`);
    assert.equal(row.event, 'idle');
    assert.ok(Array.isArray(row.droppedChannels));
  }

  // Throttle proof: the same class never appears twice inside one second.
  for (const type of DECISION_EVENT_TYPES) {
    const at = decisions.filter((event) => event.type === type).map((event) => event.at);
    for (let index = 1; index < at.length; index += 1) {
      assert.ok(at[index] - at[index - 1] >= 1000, `${type} throttled: ${at[index - 1]} -> ${at[index]}`);
    }
  }
});

test('12. 被过滤的决策带原因：no-candidate / channel-unverified / hold', () => {
  // Every family disabled → the selector has no legal candidate at all.
  const disabled = makeRuntime({ enabled: true, overrides: { disabledFamilies: ALL_FAMILIES } });
  const none = decisionEvents(idleEvents(disabled, 12_000))
    .find((event) => event.type === 'avatar.preset.skip' && event.reason === 'no-candidate');
  assert.ok(none, 'all families disabled must report no-candidate');
  assert.equal(none.event, 'idle');
  assert.deepEqual(none.droppedChannels, []);

  // No verified channel set → the hard channel filter refuses every candidate.
  const blind = makeRuntime({ enabled: true });
  blind.tick(0);
  blind.selectPreset({ state: 'idle', event: 'idle', verifiedChannels: [], seed: 0, now: 10 });
  const channelSkip = blind.takeEvents().find((event) => event.type === 'avatar.preset.skip');
  assert.ok(channelSkip, 'an unverified channel set is reported');
  assert.equal(channelSkip.reason, 'channel-unverified');
  assert.equal(channelSkip.event, 'idle');

  // A legal hold draw (privacy refuses the draw) is not an error: it is `hold`.
  const privacy = makeRuntime({ enabled: true });
  privacy.tick(0);
  privacy.selectPreset({ state: 'idle', event: 'idle', privacy: true, seed: 0, now: 10 });
  const hold = privacy.takeEvents().find((event) => event.type === 'avatar.preset.skip');
  assert.ok(hold, 'a hold is still an explicit decision');
  assert.equal(hold.reason, 'hold');
  assert.equal(hold.event, 'idle');
});

test('13. 状态投影随决策更新：motion.presets.debug 九个字段（index 映射）', () => {
  const runtime = makeRuntime({ enabled: true, overrides: { actionPriority: { 'idle-tilt': 100 } } });
  const decisions = decisionEvents(idleEvents(runtime, 20_000));
  const snapshot = presetSnapshot(runtime);
  const projection = snapshot.debug;
  assert.deepEqual(
    Object.keys(projection).sort(),
    ['byAction', 'decisions', 'enabled', 'holds', 'lastAt', 'lastEvent', 'lastPresetId',
      'selectorKey', 'skips'],
  );
  assert.equal(projection.enabled, true, 'the projection says preset execution is on');
  assert.ok(projection.decisions > 0, `decisions ${projection.decisions}`);
  assert.equal(projection.decisions, snapshot.selected + snapshot.holds, 'every draw counted once');
  assert.ok(projection.skips >= 1, `skips ${projection.skips}`);
  assert.equal(projection.lastEvent, 'idle');
  assert.equal(typeof projection.lastAt, 'number');
  assert.ok(projection.selectorKey.includes('idle-tilt'), 'selectorKey names the overrides in force');
  const lastSelect = decisions.filter((event) => event.type === 'avatar.preset.select').at(-1);
  assert.ok(lastSelect, 'a select event exists');
  assert.equal(projection.lastPresetId, lastSelect.presetId);
  assert.equal(projection.lastAt >= lastSelect.at, true, 'the projection is never older than its event');

  // Lightweight by-action rollup: the LAST action only (no history), always maintained.
  assert.deepEqual(Object.keys(projection.byAction).sort(),
    ['lastActionId', 'lastCommitCount', 'lastEvent']);
  assert.match(projection.byAction.lastActionId, /^presetAction#\d+$/,
    'the idle rhythm started an action and the rollup names it');
  assert.equal(projection.byAction.lastCommitCount, 0, 'this runtime has no transport: no commits');
  assert.equal(projection.byAction.lastEvent, 'idle');

  // index.js exposes that exact object at status.live2d.runtime.motion.presets (source wiring proof,
  // the same pattern test/observability-wiring.mjs uses for index.js projections).
  const source = readFileSync(new URL('../src/host/index.js', import.meta.url), 'utf8');
  assert.match(source, /presets: inner\.motion\?\.presets\?\.debug \?\? \{/u);
  assert.match(source, /lastPresetId: null, lastEvent: '', lastAt: null, selectorKey: ''/u);
});

test('14. 关闭 presetDebugEvents：零事件，投影照常更新', () => {
  const runtime = makeRuntime({
    enabled: true,
    debugEvents: false,
    overrides: { actionPriority: { 'idle-tilt': 100 } },
  });
  const events = idleEvents(runtime, 20_000);
  assert.equal(decisionEvents(events).length, 0, 'the switch silences every new debug event');
  const projection = presetSnapshot(runtime).debug;
  assert.ok(projection.decisions > 0, `decisions ${projection.decisions}`);
  assert.ok(projection.skips >= 1, `skips ${projection.skips}`);
  assert.equal(projection.lastEvent, 'idle');
  assert.equal(typeof projection.lastAt, 'number');
  // The by-action rollup is projection state, not an event: it updates with the switch off.
  assert.match(projection.byAction.lastActionId, /^presetAction#\d+$/u);
  assert.equal(projection.byAction.lastCommitCount, 0);
  assert.equal(projection.byAction.lastEvent, 'idle');
});

test('15. 提交事件：commit 只在传输确认后出现，并进入宿主 debug 日志', async () => {
  let clock = 0;
  const logs = [];
  const transport = {
    connect: async () => {},
    disconnect: async () => {},
    write: async () => ({ ok: true }),
    writeMotion: async () => ({ ok: true }),
  };
  const runtime = createAvatarRuntime({
    transport,
    now: () => clock,
    log: (message, data = {}) => logs.push({ message, ...data }),
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

  let started = null;
  for (let seed = 0; seed < 96 && started === null; seed += 1) {
    const drawn = runtime.preset({ state: 'idle', event: 'idle', recipe: 'idle-tilt', seed, at: 0 });
    if (drawn.started === true) started = drawn;
  }
  assert.ok(started !== null, 'a preset trajectory started');
  for (const at of [0, 200, 400, 800, 1200, 1600]) {
    clock = at;
    runtime.tick(at);
    await new Promise((resolve) => setImmediate(resolve));
  }

  const commits = runtime.takeEvents().filter((event) => event.type === 'avatar.preset.commit');
  assert.ok(commits.length >= 1, 'the acknowledged send produced a commit event');
  const commit = commits[0];
  assert.deepEqual(
    Object.keys(commit).sort(),
    ['actionId', 'at', 'channels', 'commitCount', 'committed', 'event', 'firstAt', 'firstValue',
      'lastAbs', 'lastAt', 'lastValue', 'peak', 'peakByChannel', 'presetId', 'selectionId',
      'skippedByTransport', 'spanMs', 'type'],
  );
  assert.equal(commit.presetId, started.presetId);
  assert.deepEqual(commit.channels, started.channels);
  assert.equal(commit.actionId, started.actionId, 'commit keeps the action identity');
  assert.equal(commit.event, 'idle', 'the commit says which event the action was for');
  assert.equal(commit.selectionId, started.selectionId, 'and the draw it executed');
  assert.equal(commit.commitCount, 1, 'the first acknowledged send of this action');
  assert.equal(commit.firstAt, commit.at, 'the merge window opens at the first acknowledgement');
  assert.equal(commit.lastAt, commit.at);
  assert.ok(commit.committed.length > 0);
  assert.ok(commit.committed.every((channel) => commit.channels.includes(channel)));
  assert.equal(typeof commit.skippedByTransport, 'object');

  // The same decisions reach the host debug log (`avatarRuntimeLog` → events.jsonl).
  const logged = logs.filter((row) => DECISION_EVENT_TYPES.includes(row.message));
  assert.ok(logged.some((row) => row.message === 'avatar.preset.select'), 'select is logged');
  assert.ok(logged.some((row) => row.message === 'avatar.preset.skip' && row.reason === 'busy'),
    'the busy boundary is logged');
  assert.ok(logged.some((row) => row.message === 'avatar.preset.commit' && row.presetId === started.presetId),
    'the commit is logged');
  const select = logged.find((row) => row.message === 'avatar.preset.select');
  assert.equal(select.event, 'idle', 'the payload keeps the preset event vocabulary');
  assert.equal(typeof select.score, 'number');
  assert.ok(Array.isArray(select.channels));
});

// ---------------------------------------------------------------------------------------------
// Amplitude / duration evidence (read-only). These only READ the new payload fields: selection,
// amplitude and write cadence stay exactly as before.
// ---------------------------------------------------------------------------------------------

/** One avatar runtime on a fake clock whose transport records every motion frame. */
async function makeTransportRuntime() {
  let clock = 0;
  const frames = [];
  const logs = [];
  const transport = {
    connect: async () => {},
    disconnect: async () => {},
    write: async () => ({ ok: true }),
    writeMotion: async (payload) => {
      frames.push({
        at: payload.at,
        entries: payload.entries.map((entry) => ({ channel: entry.channel, value: entry.value })),
      });
      return { ok: true };
    },
  };
  const runtime = createAvatarRuntime({
    transport,
    now: () => clock,
    log: (message, data = {}) => logs.push({ message, ...data }),
    config: {
      seed: 11,
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
  return {
    runtime,
    frames,
    logs,
    tick: async (at) => {
      clock = at;
      runtime.tick(at);
      await new Promise((resolve) => setImmediate(resolve));
      return frames.at(-1) ?? null;
    },
  };
}

/** Start one deterministic idle-tilt trajectory (the same draw the existing tests use). */
function startIdleTilt(runtime) {
  for (let seed = 0; seed < 96; seed += 1) {
    const drawn = runtime.preset({ state: 'idle', event: 'idle', recipe: 'idle-tilt', seed, at: 0 });
    if (drawn.started === true) return drawn;
  }
  return null;
}

test('16. commit 幅度证据：peak/firstValue/lastValue/spanMs 与最终发送值一致', async () => {
  const { runtime, frames, logs, tick } = await makeTransportRuntime();
  const started = startIdleTilt(runtime);
  assert.ok(started !== null, 'a preset trajectory started');
  runtime.takeEvents(); // the start/select of this trajectory is covered by test 17

  const sentByAt = new Map();
  // Run the WHOLE trajectory so the early excursion and the tail (return to rest) are both
  // acknowledged. The frame peak below is measured independently from the frames the transport
  // really received, so `commit.peak` can be checked against the real trajectory, not its tail.
  const observedPeak = new Map();
  const tracked = new Set(started.channels);
  for (let at = 0; at <= started.durationMs + 200; at += 33) {
    const frame = await tick(at);
    const sent = new Map();
    for (const entry of frame?.entries ?? []) {
      if (!entry.channel) continue;
      sent.set(entry.channel, entry.value);
      // `at >= durationMs` is the frame where the action is already retired: its rows are idle
      // writes, not acknowledgements of this action.
      if (at < started.durationMs && tracked.has(entry.channel) && Number.isFinite(entry.value)) {
        const magnitude = Math.abs(entry.value);
        observedPeak.set(entry.channel, Math.max(observedPeak.get(entry.channel) ?? 0, magnitude));
      }
    }
    sentByAt.set(at, sent);
  }
  // The 1 s commit throttle writes the first acknowledgement at once and flushes the newest one
  // after the window; the runtime is idle here, so this wait is what releases the trailing row.
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_100));

  const commits = runtime.takeEvents().filter((event) => event.type === 'avatar.preset.commit');
  assert.equal(commits.length, 2, `first + last acknowledgement of the action: ${commits.length}`);
  const commit = commits.at(-1);
  assert.equal(commit.presetId, started.presetId);
  assert.equal(typeof commit.peak, 'number');
  assert.equal(typeof commit.lastAbs, 'number');
  assert.equal(typeof commit.spanMs, 'number');
  assert.equal(commit.lastValue !== null && typeof commit.lastValue === 'object', true);
  assert.equal(commit.firstValue !== null && typeof commit.firstValue === 'object', true);
  assert.ok(commit.commitCount > commits[0].commitCount, 'the trailing row is a later acknowledgement');

  // The evidence must be the acknowledged values, not a recomputed physical quantity.
  const sent = sentByAt.get(commit.lastAt);
  assert.ok(sent !== undefined, `a frame was sent at the acknowledged time ${commit.lastAt}`);
  for (const channel of commit.committed) {
    assert.equal(commit.lastValue[channel], sent.get(channel),
      `lastValue equals the final sent value: ${channel}`);
    assert.ok(Number.isFinite(commit.firstValue[channel]), `firstValue is finite: ${channel}`);
  }
  // `lastAbs` keeps the OLD tail semantics; `peak` is the whole-action maximum, which here really
  // is a visible head excursion (not a near-zero return-to-rest value).
  assert.equal(commit.lastAbs, Math.max(...Object.values(commit.lastValue).map(Math.abs)));
  assert.ok(commit.peak >= commit.lastAbs, `peak ${commit.peak} >= lastAbs ${commit.lastAbs}`);
  assert.ok(commit.peak > 0.1, `normal head trajectory peak is visible: ${commit.peak}`);
  assert.ok(commit.peak <= 0.95 + 1e-9, `peak stays inside the head clamp: ${commit.peak}`);
  const observed = Math.max(0, ...observedPeak.values());
  assert.equal(commit.peak, observed, 'peak equals the max |acknowledged value| of the whole action');
  assert.deepEqual(commit.peakByChannel, Object.fromEntries(observedPeak));
  assert.equal(commit.spanMs, commit.lastAt - commits[0].lastAt, 'span = first ack -> last ack');

  // The same observability reaches the host log sink.
  assert.ok(logs.some((row) => row.message === 'avatar.preset.start'), 'start is logged too');
  assert.ok(logs.some((row) => row.message === 'avatar.preset.commit'), 'commit is logged');
});

test('16b. commit peak = 整段 maxAbs（先大后回位仍报早期大值）；lastAbs 保留尾值语义', () => {
  const runtime = makeRuntime();
  const selection = pick(runtime, { state: 'idle', event: 'idle', recipe: 'idle-tilt' });
  assert.ok(selection !== null, 'idle-tilt must be selectable');
  const started = runtime.startPreset(selection, { at: 0 });
  assert.equal(started.started, true);
  const live = presetSnapshot(runtime).active.find((item) => item.presetId === started.presetId);
  assert.ok(live !== undefined, 'the action is live');
  const owners = [{ seq: live.seq, generation: live.generation }];
  runtime.takeEvents();

  // The exact regression shape: a large early excursion, then a return to (almost) rest. Each
  // acknowledgement is >1 s after the previous one, so the commit throttle writes all three and
  // the last event is a real tail, not a suppressed middle frame.
  const acknowledge = (at, value) => runtime.notePresetTransport({
    phase: 'committed', owners, at, rows: [{ channel: 'headZ', value }],
  });
  acknowledge(0, 0.5);
  acknowledge(1_100, 0.02);
  acknowledge(2_200, 0.001);

  const commits = runtime.takeEvents().filter((event) => event.type === 'avatar.preset.commit');
  assert.equal(commits.length, 3, 'each spaced acknowledgement is written');
  assert.equal(commits[0].peak, 0.5, 'the first acknowledgement is its own peak');
  assert.equal(commits[0].lastAbs, 0.5);
  const last = commits.at(-1);
  assert.equal(last.peak, 0.5, 'peak is the whole-action maxAbs, not the tail value');
  assert.equal(last.peakByChannel.headZ, 0.5, 'the per-channel maxAbs is kept too');
  assert.equal(last.lastAbs, 0.001, 'lastAbs is the max |last acknowledged value|');
  assert.equal(last.lastValue.headZ, 0.001, 'the tail value itself stays available');
  assert.ok(last.peak > 0.1 && last.lastAbs < 0.01,
    `early ${last.peak} vs tail ${last.lastAbs}`);
});

test('17. start 事件带幅度/时长/阶段，并已放开宿主白名单', () => {
  const runtime = makeRuntime();
  const selection = pick(runtime, { state: 'idle', event: 'idle', recipe: 'idle-tilt' });
  assert.ok(selection !== null);
  runtime.takeEvents();

  const started = runtime.startPreset(selection, { at: 0 });
  assert.equal(started.started, true);
  const start = runtime.takeEvents().find((event) => event.type === 'avatar.preset.start');
  assert.ok(start, 'the start event is emitted');
  assert.equal(start.presetId, started.presetId);
  assert.equal(start.event, 'idle');
  assert.deepEqual(start.channels, started.channels);
  assert.equal(typeof start.amplitude, 'number');
  assert.ok(start.amplitude > 0, `planned amplitude ${start.amplitude}`);
  assert.ok(start.durationMs > 0, `planned duration ${start.durationMs}`);
  assert.ok(Array.isArray(start.stages) && start.stages.length > 0);
  const stage = start.stages[0];
  assert.equal(stage.op, 'head-tilt');
  assert.deepEqual(stage.channels, started.channels);
  assert.ok(stage.amplitude > 0);
  assert.ok(stage.activeMs > 0 && stage.holdMs >= 0 && stage.exitMs > 0);

  // Source wiring proof: index.js forwards the start payload to the host debug log.
  const source = readFileSync(new URL('../src/host/index.js', import.meta.url), 'utf8');
  assert.match(source, /message === 'avatar\.preset\.start'/u);
});

test('17b. head 目标固定为显式度数带：全局增益不覆盖它，眼动保持原样', () => {
  function gestureProbe(gain, recipe, state, event) {
    const runtime = makeRuntime({
      enabled: true,
      extraConfig: { idleSwayScale: 0, presetGestureGain: gain },
    });
    const selection = pick(runtime, { state, event, recipe });
    assert.ok(selection !== null, `${recipe} must be selectable`);
    runtime.takeEvents();
    const started = runtime.startPreset(selection, { at: 0, context: { state, event } });
    assert.equal(started.started, true);
    const start = runtime.takeEvents().find(entry => entry.type === 'avatar.preset.start');
    assert.ok(start, 'the start evidence is emitted');
    let peak = 0;
    for (let at = 0; at <= 1800; at += 33) {
      const pose = runtime.tick(at);
      peak = Math.max(peak, Math.abs(pose.headX), Math.abs(pose.headZ));
    }
    return { start, peak };
  }

  for (const [recipe, state, event] of [
    ['idle-side', 'idle', 'idle'],
    ['speak-turn', 'speaking', 'sentence-gap'],
  ]) {
    const legacy = gestureProbe(1, recipe, state, event);
    const amplified = gestureProbe(PRESET_GESTURE_GAIN, recipe, state, event);
    assert.equal(amplified.start.stages[0].op, 'head-turn');
    // Head operations now read an explicit degree band; a hidden global multiplier must not
    // silently push them past 10–20°. The old experimental gain stays for non-head nominal work.
    const legacyDegrees = Math.abs(legacy.start.stages[0].targetDegrees.headX);
    const amplifiedDegrees = Math.abs(amplified.start.stages[0].targetDegrees.headX);
    assert.ok(legacyDegrees >= 12 - 1e-6 && legacyDegrees <= 20 + 1e-6,
      `${recipe}: planned ${legacyDegrees.toFixed(2)}° is inside the 12–20° band`);
    assert.ok(Math.abs(amplifiedDegrees - legacyDegrees) < 1e-9,
      `${recipe}: gain must not change the head target (${legacyDegrees}° vs ${amplifiedDegrees}°)`);
    assert.ok(Math.abs(amplified.peak - legacy.peak) < 1e-9,
      `${recipe}: output peak unchanged ${legacy.peak.toFixed(4)}`);
    console.log(`[gain] ${recipe} head target held at ${legacyDegrees.toFixed(2)}° `
      + `(gain ${PRESET_GESTURE_GAIN} ignored for explicit degrees)`);
  }

  // Eye movement is explicitly NOT part of this experiment: its nominal stays bit-identical.
  function gazeAmplitude(gain) {
    const runtime = makeRuntime({
      enabled: true,
      extraConfig: { idleSwayScale: 0, presetGestureGain: gain },
    });
    const selection = pick(runtime, { state: 'idle', event: 'idle', recipe: 'idle-eye-side' });
    assert.ok(selection !== null);
    runtime.takeEvents();
    const started = runtime.startPreset(selection, { at: 0, context: { state: 'idle', event: 'idle' } });
    assert.equal(started.started, true);
    const start = runtime.takeEvents().find(entry => entry.type === 'avatar.preset.start');
    return start.amplitude;
  }
  const legacyGaze = gazeAmplitude(1);
  const amplifiedGaze = gazeAmplitude(PRESET_GESTURE_GAIN);
  assert.equal(amplifiedGaze, legacyGaze, 'gaze-only presets keep their old amplitude');
  console.log(`[gain] gaze-only idle-eye-side unchanged ${legacyGaze.toFixed(4)}`);
});

test('18. answer-start 空候选：skip 带 reasons 与 state，可区分 state-mismatch / requires-target', () => {
  const runtime = makeRuntime();
  runtime.tick(0);
  runtime.takeEvents();

  // answer-start presets exist only for state 'speaking'; thinking is a state mismatch.
  const held = runtime.selectPreset({
    state: 'thinking', event: 'answer-start',
    verifiedChannels: [...ALL_CHANNELS], targetVerified: true, now: 1000,
  });
  assert.equal(held.kind, 'hold');
  const mismatch = runtime.takeEvents().find((event) => event.type === 'avatar.preset.skip');
  assert.ok(mismatch, 'an empty answer-start candidate is an explicit skip');
  assert.equal(mismatch.event, 'answer-start');
  assert.equal(mismatch.state, 'thinking');
  assert.equal(mismatch.reason, 'no-candidate');
  assert.ok(Array.isArray(mismatch.verifiedChannels) && mismatch.verifiedChannels.includes('headZ'));
  assert.ok(Array.isArray(mismatch.reasons) && mismatch.reasons.length > 0);
  assert.ok(mismatch.reasons.includes('no-candidates'));
  assert.ok(mismatch.reasons.includes('state:thinking'));
  assert.equal(mismatch.reasons.includes('requires-target'), false);

  // The same event with a targeted recipe but no verified target fails for a DIFFERENT reason.
  const targeted = runtime.selectPreset({
    state: 'speaking', event: 'answer-start', recipe: 'answer-attend',
    verifiedChannels: ['gazeX', 'gazeY'], targetVerified: false, now: 3000,
  });
  assert.equal(targeted.kind, 'hold');
  const requiresTarget = runtime.takeEvents().find((event) => event.type === 'avatar.preset.skip');
  assert.ok(requiresTarget);
  assert.equal(requiresTarget.state, 'speaking');
  assert.ok(requiresTarget.reasons.length > 0);
  assert.ok(requiresTarget.reasons.includes('requires-target'));
  assert.equal(requiresTarget.reasons.includes('state:thinking'), false);
  assert.notEqual(requiresTarget.reasons.join('|'), mismatch.reasons.join('|'),
    'the two empty-candidate causes are distinguishable');
});

test('19. commit 节流 1 s：同一动作 1 s 内 4 次提交 = 首条 + 末条（末条必到）', async () => {
  const { runtime, tick } = await makeTransportRuntime();
  const started = startIdleTilt(runtime);
  assert.ok(started !== null);
  runtime.takeEvents();

  for (const at of [0, 250, 500, 750]) await tick(at);
  const inside = runtime.takeEvents().filter((event) => event.type === 'avatar.preset.commit');
  assert.equal(inside.length, 1, 'only the first acknowledgement is written inside the window');
  assert.equal(inside[0].commitCount, 1);
  const acknowledged = runtime.snapshot().motion.presets.debug.byAction.lastCommitCount;
  assert.ok(acknowledged > 1, `the other acknowledgements happened: ${acknowledged}`);

  // The window closes: the newest suppressed acknowledgement is written, never dropped.
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_100));
  const trailing = runtime.takeEvents().filter((event) => event.type === 'avatar.preset.commit');
  assert.equal(trailing.length, 1, 'exactly one trailing row closes the action');
  assert.ok(trailing[0].commitCount > inside[0].commitCount,
    `the last acknowledgement arrives: ${inside[0].commitCount} -> ${trailing[0].commitCount}`);
  assert.ok(trailing.every((event) => event.presetId === started.presetId));
});

// ---------------------------------------------------------------------------------------------
// Action correlation (association only): `selectionId` links one draw to the action it executed;
// `actionId` links that action's start/commit rows. Nothing here changes what is selected or how
// large it is — every assertion below reads ids and counts from the existing payloads.
// ---------------------------------------------------------------------------------------------
test('20. select→start 关联：select 带 selectionId，start 沿用并分配唯一 actionId', () => {
  const runtime = makeRuntime();
  runtime.tick(0);
  runtime.takeEvents();

  let selection = null;
  let selectEvent = null;
  // Space the draws 2 s apart so the 1 s select throttle keeps the event of the draw we start.
  for (let seed = 0, now = 0; seed < 96; seed += 1, now += 2000) {
    const drawn = runtime.selectPreset({
      state: 'idle', event: 'idle', recipe: 'idle-tilt', seed, now,
    });
    const events = runtime.takeEvents();
    if (drawn.kind !== 'preset') continue;
    selection = drawn;
    selectEvent = events.find((event) => event.type === 'avatar.preset.select') ?? null;
    if (selectEvent !== null) break;
  }
  assert.ok(selection !== null, 'a draw returned a preset');
  assert.match(selection.selectionId, /^presetSelect#\d+$/u, 'every draw has its own selection id');
  assert.ok(selectEvent !== null, 'the draw published its select event');
  assert.equal(selectEvent.selectionId, selection.selectionId, 'the select event names its draw');
  assert.equal(selectEvent.event, 'idle');

  const started = runtime.startPreset(selection, { at: 0 });
  assert.equal(started.started, true);
  assert.match(started.actionId, /^presetAction#\d+$/u, 'start allocates a unique action id');
  assert.equal(started.selectionId, selection.selectionId, 'the action keeps the draw it executed');

  const start = runtime.takeEvents().find((event) => event.type === 'avatar.preset.start');
  assert.ok(start, 'the start event is emitted');
  assert.equal(start.actionId, started.actionId);
  assert.equal(start.selectionId, selection.selectionId, 'select → start share the draw id');
  assert.equal(start.event, 'idle');
});

test('21. 同一动作多条 commit 按 actionId 归并：首条 + 末条，firstAt/lastAt 成窗口', async () => {
  const { runtime, tick } = await makeTransportRuntime();
  const started = startIdleTilt(runtime);
  assert.ok(started !== null);
  assert.match(started.actionId, /^presetAction#\d+$/u);
  runtime.takeEvents();

  for (const at of [0, 250, 500, 750]) await tick(at);
  const inside = runtime.takeEvents().filter((event) => event.type === 'avatar.preset.commit');
  assert.equal(inside.length, 1, 'the window keeps only the first acknowledgement');
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_100));
  const trailing = runtime.takeEvents().filter((event) => event.type === 'avatar.preset.commit');
  assert.equal(trailing.length, 1, 'the newest acknowledgement closes the action');
  const commits = [...inside, ...trailing];
  assert.ok(commits.every((event) => event.actionId === started.actionId),
    'every ack of one action carries the same actionId');
  assert.ok(commits.every((event) => event.selectionId === started.selectionId));
  assert.equal(commits[0].commitCount, 1, 'commitCount is the merge counter for this action');
  assert.ok(commits[1].commitCount > 1,
    `the trailing row is a later acknowledgement: ${commits[1].commitCount}`);
  assert.ok(commits.every((event) => event.firstAt === commits[0].lastAt),
    'firstAt stays the first acknowledgement of the action');
  assert.deepEqual(
    commits.map((event) => event.spanMs),
    commits.map((event) => event.lastAt - event.firstAt),
    'each row reports its own acknowledgement window',
  );
  assert.equal(commits[0].lastAt, commits[0].at, 'the first row is written at its acknowledgement');
  assert.equal(commits[1].firstAt, commits[0].firstAt, 'the trailing row keeps the same window start');

  const byAction = runtime.snapshot().motion.presets.debug.byAction;
  assert.equal(byAction.lastActionId, started.actionId);
  assert.equal(byAction.lastEvent, 'idle');
  assert.ok(byAction.lastCommitCount > 1,
    `the status projection counts every acknowledgement: ${byAction.lastCommitCount}`);
});

test('22. idle 动作的 commit 带 event=idle；对话边界动作带自己的 event', async () => {
  const { runtime, tick } = await makeTransportRuntime();
  const started = startIdleTilt(runtime);
  assert.ok(started !== null);
  runtime.takeEvents();
  for (const at of [0, 250, 500]) await tick(at);
  const idleCommits = runtime.takeEvents().filter((event) => event.type === 'avatar.preset.commit');
  assert.ok(idleCommits.length >= 1);
  assert.ok(idleCommits.every((event) => event.event === 'idle'),
    'an idle trajectory commits with event=idle');
  assert.ok(idleCommits.every((event) => event.actionId === started.actionId));

  // A dialogue boundary is a different event, and the start payload says so.
  const controller = makeRuntime();
  controller.tick(0);
  controller.takeEvents();
  const listener = pick(controller, {
    state: 'listening', event: 'user-speaking', recipe: 'listen-lower',
  });
  assert.ok(listener !== null);
  const dialogue = controller.startPreset(listener, { at: 0 });
  assert.equal(dialogue.started, true);
  const dialogueStart = controller.takeEvents().find((event) => event.type === 'avatar.preset.start');
  assert.ok(dialogueStart);
  assert.equal(dialogueStart.event, 'user-speaking');
  assert.match(dialogueStart.actionId, /^presetAction#\d+$/u);

  // A second action on the same controller gets a different id (ids are per runtime, monotonic).
  controller.clearPresets('next-action', { fadeMs: 0, at: 1000 });
  const second = pick(controller, { state: 'idle', event: 'idle', recipe: 'idle-tilt' });
  assert.ok(second !== null);
  const secondStart = controller.startPreset(second, { at: 2000 });
  assert.equal(secondStart.started, true);
  assert.notEqual(secondStart.actionId, dialogue.actionId, 'each action id is unique');
});

test('23. skip 也带 event：有 draw 的 hold 带 selectionId，未 draw 的 gate/busy 两者为 null', () => {
  const runtime = makeRuntime();
  runtime.tick(0);
  runtime.takeEvents();

  const blind = runtime.selectPreset({
    state: 'idle', event: 'idle', verifiedChannels: [], seed: 0, now: 10,
  });
  assert.equal(blind.kind, 'hold');
  const holdSkip = runtime.takeEvents().find((event) => event.type === 'avatar.preset.skip');
  assert.ok(holdSkip, 'a held draw is an explicit skip');
  assert.equal(holdSkip.event, 'idle');
  assert.equal(holdSkip.selectionId, blind.selectionId, 'the skip names the draw that held');
  assert.equal(holdSkip.actionId, null, 'a hold started no action');

  // The host refused the boundary before drawing (busy): event known, no draw/action yet.
  runtime.notePresetSkip('busy', { event: 'user-speaking', at: 2000 });
  const busySkip = runtime.takeEvents()
    .filter((event) => event.type === 'avatar.preset.skip')
    .find((event) => event.reason === 'busy');
  assert.ok(busySkip, 'the busy boundary is reported');
  assert.equal(busySkip.event, 'user-speaking');
  assert.equal(busySkip.selectionId, null);
  assert.equal(busySkip.actionId, null);
});

