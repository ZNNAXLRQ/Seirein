/**
 * answer-start takeover (approved item 5) — the opening gesture may smoothly replace a
 * THINKING / pre-answer action at the first body clip's real start.
 *
 * Contract pinned here:
 *   1. a live thinking action that conflicts only on some channels IS displaced: only the
 *      conflicting channels cross-fade out (default 200 ms, ≤ 240 ms), every kept channel stays
 *      with the old owner, and breathing / blinking are never touched;
 *   2. an EXPLICIT action (or a non-preset action) is never displaced → ONE
 *      `avatar.intent.dropped {reason:'takeover-unavailable'}`, nothing queued, no delay;
 *   3. a transition outside the 120–240 ms window is refused the same way and cannot stall the
 *      scheduler;
 *   4. a free boundary behaves exactly as before (no takeover event, one action, no drop);
 *   5. exactly one owner per channel once the fade is over; the old action releases its yielded
 *      channels (and keeps its kept ones until its own natural end);
 *   6. the arbitration is immediate: it never waits for the old action to exit.
 *
 * Run: node --test test/answer-start-takeover.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createAvatarRuntime } from '../src/host/avatar/avatarRuntime.js';
import { createBehaviorRuntime } from '../src/host/avatar/motion-controller.js';
import { PRESETS } from '../src/host/avatar/presets/catalog.js';

// ---------------------------------------------------------------------------------------------
// Harness: fake clock + fake transport. No network, no timer, no host mount.
// ---------------------------------------------------------------------------------------------
const flush = () => new Promise((resolve) => setImmediate(resolve));

const HEAD_ROWS = ['headX', 'headY', 'headZ', 'gazeX', 'gazeY', 'browL', 'browR', 'eyeOpenL', 'eyeOpenR']
  .map((channel) => ({ channel, inputName: `P_${channel}`, injectable: true, verified: true }));
const CONTROLLED = HEAD_ROWS.map((row) => row.channel);

const runtimeConfig = (extra = {}) => ({
  autoTickMs: 0,
  flushIntervalMs: 1,
  idleActions: [],
  idleSwayScale: 0,
  motionWrites: true,
  motionOutputHz: 30,
  presetExecution: true,
  seed: 7,
  ...extra,
});

/** Every variant of the presets in these event buckets, except the recipes named in `keep`. */
const disabledExcept = (events, keep) => PRESETS
  .filter((preset) => preset.events.some((event) => events.includes(event)))
  .filter((preset) => !keep.includes(preset.recipeId))
  .map((preset) => preset.id);

async function makeRuntime({ config = runtimeConfig() } = {}) {
  const clock = { at: 0 };
  const frames = [];
  const runtime = createAvatarRuntime({
    transport: {
      connect: async () => {},
      disconnect: async () => {},
      write: async ({ input, value }) => { frames.push({ input, value }); return { ok: true }; },
      writeMotion: async (payload) => { frames.push(...payload.entries); return { ok: true }; },
    },
    now: () => clock.at,
    config,
  });
  const connected = await runtime.connect();
  assert.equal(connected.ok, true, `runtime connects (${connected.message ?? ''})`);
  await runtime.setChannelMappings(HEAD_ROWS, { channelMap: {} });
  runtime.takeEvents();
  return { runtime, clock, frames };
}

const ofType = (events, type) => events.filter((event) => event.type === type);

/** Advance the fake clock until no discrete action runs (the preset trajectory ends with it). */
async function runUntilIdle(runtime, clock, { maxMs = 8000, stepMs = 20 } = {}) {
  const from = clock.at;
  for (let at = from; at <= from + maxMs; at += stepMs) {
    clock.at = at;
    runtime.tick(at);
    await flush();
    if (runtime.snapshot().actions.current === null && at > from) return at;
  }
  return clock.at;
}

/** The selection the boundary will really draw for `ticket` (same seed + same context). */
const previewAnswerStart = (runtime, ticket) => runtime.selectPreset({
  state: 'speaking',
  event: 'answer-start',
  seed: `intent:${ticket}:answer-start`,
  verifiedChannels: CONTROLLED,
  targetVerified: false,
  directionVerified: false,
});

/**
 * Start one autonomous pre-answer action with a KNOWN recipe (the `disabled` override set is a
 * hard filter, so the draw cannot pick another recipe). The selector can still legally hold; the
 * ticket then changes and the next draw is a different seed, so a short retry is deterministic.
 */
async function stageOwner(runtime, clock, { event, status, recipe, attempts = 40 }) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await runUntilIdle(runtime, clock);
    runtime.setPresetOverrides({ disabled: disabledExcept([event], [recipe]) });
    runtime.setStatus(status, 'probe');
    const started = runtime.intentEvent(event, { at: clock.at });
    const snap = runtime.snapshot();
    const owner = snap.actions.current === null ? null : snap.motion.presets.active.at(-1) ?? null;
    if (started.released === true && owner !== null && owner.recipe === recipe) return { owner, at: clock.at };
    if (snap.actions.current !== null) await runUntilIdle(runtime, clock);
    clock.at += 20;
  }
  throw new Error(`no ${event} preset (${recipe}) could be started`);
}

/**
 * Find the answer-start draw that conflicts with `owner` on the channel `need`. The override set
 * is narrowed to ONE answer recipe at a time; each candidate is previewed with its exact seed, so
 * the boundary's real draw is the previewed one.
 */
function findTakeoverRecipe(runtime, answerRecipes, need) {
  const ticket = runtime.snapshot().intentEvents.staged + 1;
  for (const recipe of answerRecipes) {
    runtime.setPresetOverrides({ disabled: disabledExcept(['answer-start'], [recipe]) });
    const preview = previewAnswerStart(runtime, ticket);
    const channels = preview.kind === 'preset' ? [...(preview.effectiveRequires ?? [])] : [];
    if (preview.kind === 'preset' && channels.includes(need)) return { recipe, preview, channels, ticket };
  }
  return null;
}

const activeItems = (runtime) => runtime.snapshot().motion.presets.active;

// =============================================================================================
// 1. Thinking occupies headZ; the opening gesture (headX + headZ) takes over: thinking yields
//    headZ, the gesture really runs at the boundary, breathing/blinking keep going.
// =============================================================================================
test('1. thinking 占 headZ → 开口动作平滑接替：让出 headZ、边界即执行、呼吸/眨眼保持', async () => {
  const { runtime, clock } = await makeRuntime();
  let staged;
  // `think-tilt` is the only thinking recipe allowed: its trajectory is headZ.
  for (let attempt = 0; attempt < 40 && staged === undefined; attempt += 1) {
    const owner = await stageOwner(runtime, clock, { event: 'thinking', status: 'thinking', recipe: 'think-tilt' });
    assert.deepEqual(owner.owner.channels, ['headZ'], 'the pre-answer action owns headZ');
    // The boundary draws for the SPEAKING state (every answer-start recipe is states=speaking).
    runtime.setStatus('speaking', 'playback.start');
    const found = findTakeoverRecipe(runtime, ['answer-center', 'answer-tilt'], 'headZ');
    if (found !== null) { staged = { owner, ...found }; break; }
    await runUntilIdle(runtime, clock);
    clock.at += 20;
  }
  assert.ok(staged, 'a thinking owner + a conflicting opening gesture was staged');
  runtime.takeEvents();

  // The first body clip starts NOW: the arbitration is immediate, it never waits for thinking.
  const at = clock.at;
  const pending = runtime.intentEvent('answer-start', { at, holdForClipStart: true });
  assert.equal(pending.released, false, 'staging is not execution');
  const boundary = runtime.speechClip('start', { index: 0, at });
  const snap = runtime.snapshot();
  assert.equal(snap.actions.current?.event, 'answer-start', 'the opening gesture started at the boundary');
  assert.equal(snap.actions.current?.startedAt, at, 'it was not delayed by the running action');
  assert.equal(boundary.ok, true);
  assert.equal(snap.intentEvents.pending, null, 'the boundary resolved the intent');

  const events = runtime.takeEvents();
  const takeover = ofType(events, 'avatar.preset.takeover');
  assert.equal(takeover.length, 1, 'exactly one takeover row');
  assert.deepEqual(takeover[0].yieldedChannels, ['headZ'], 'only the conflicting channel yields');
  assert.deepEqual(takeover[0].keptChannels, [], 'a single-channel owner keeps nothing');
  assert.equal(takeover[0].fadeMs, 200, 'the default cross-fade is 200 ms');
  assert.equal(takeover[0].fromAction, staged.owner.owner.presetId, 'the displaced action is the thinking preset');
  assert.equal(takeover[0].fromPreset, staged.owner.owner.presetId);
  assert.equal(takeover[0].toPreset, staged.preview.presetId, 'the takeover names the opening gesture');
  assert.equal(ofType(events, 'avatar.intent.dropped').length, 0, 'a successful takeover drops nothing');

  // The old action's record ends with a reason, its motion is not cut: the shared channel fades.
  const ended = ofType(events, 'avatar.action.end').filter((entry) => entry.name !== snap.actions.current.name);
  assert.equal(ended.length, 1, 'the displaced action ends exactly once');
  assert.equal(ended[0].by, 'takeover');
  assert.equal(ended[0].interrupted, true);

  // Breathing and blinking are untouched: no preset owns an eye channel and the breath curve,
  // the eye-open value and the composed pose keep advancing while the fade runs.
  const ownerBefore = staged.owner.owner;
  assert.equal(ownerBefore.channels.includes('eyeOpenL'), false);
  const poses = [];
  for (let t = at; t <= at + 400; t += 20) {
    clock.at = t;
    poses.push(runtime.tick(t));
    await flush();
  }
  const eyeValues = poses.map((pose) => pose.eyeOpenL);
  assert.ok(eyeValues.every((value) => value === 1), 'blinking keeps its own eye value (1 = open)');
  const breathValues = poses.map((pose) => pose.breath);
  assert.ok(breathValues.every((value) => Number.isFinite(value)), 'breathing still runs');
  assert.ok(new Set(breathValues.map((value) => value.toFixed(4))).size > 3, 'the breath curve advances');
  // No jump: the composed head roll never steps by more than the spring's own per-frame bound.
  for (let index = 1; index < poses.length; index += 1) {
    const step = Math.abs(poses[index].headZ - poses[index - 1].headZ);
    assert.ok(step <= 0.08, `headZ step ${step.toFixed(4)} stays inside one smooth frame`);
  }

  const done = ofType(runtime.takeEvents(), 'avatar.preset.takeover.done');
  assert.equal(done.length, 1, 'the fade completion is reported');
  assert.deepEqual(done[0].channels, ['headZ'], 'the yielded channel is released after the fade');
  const active = activeItems(runtime);
  assert.equal(active.length, 1, 'the old action is gone: only the opening gesture drives the pose');
  assert.equal(active[0].event, 'answer-start');
  assert.equal(runtime.snapshot().motion.presets.takeovers, 1);
  console.log(`[1] owner=${ownerBefore.presetId}${JSON.stringify(ownerBefore.channels)} `
    + `-> ${staged.preview.presetId}${JSON.stringify(staged.channels)} yielded=${JSON.stringify(takeover[0].yieldedChannels)} `
    + `fadeMs=${takeover[0].fadeMs} startAt=${snap.actions.current.startedAt} (boundary ${at}) `
    + `eye=${new Set(eyeValues).size} breathSteps=${new Set(breathValues.map((v) => v.toFixed(3))).size}`);
  runtime.dispose();
});

// =============================================================================================
// 2. An explicit action is never displaced: ONE takeover-unavailable drop, no queue, no delay.
// =============================================================================================
test('2. 显式动作占用：dropped takeover-unavailable，不排队、不延迟、不事后补做', async () => {
  const { runtime, clock } = await makeRuntime();
  // `conclusion` → the `affirm` family: an explicit, authored gesture, never a pre-answer draw.
  let owner = null;
  for (let attempt = 0; attempt < 40 && owner === null; attempt += 1) {
    await runUntilIdle(runtime, clock);
    runtime.setPresetOverrides({ disabled: disabledExcept(['affirm'], ['agree-nod']) });
    runtime.setStatus('speaking', 'playback.start');
    runtime.markConclusion('这一条是结论。', { at: clock.at });
    const snap = runtime.snapshot();
    if (snap.actions.current !== null && snap.actions.current.event === 'conclusion') {
      owner = snap.actions.current;
    } else {
      if (snap.actions.current !== null) await runUntilIdle(runtime, clock);
      clock.at += 20;
    }
  }
  assert.ok(owner, 'the explicit conclusion action is running');
  const ownerStartedAt = owner.startedAt;
  const ownerPreset = owner.presetId;
  await runUntilIdle(runtime, clock);
  // Keep the action alive at the boundary: a fresh conclusion action, then the clip start.
  let current = runtime.snapshot().actions.current;
  if (current === null) {
    runtime.setPresetOverrides({ disabled: disabledExcept(['affirm'], ['agree-nod']) });
    for (let attempt = 0; attempt < 40 && runtime.snapshot().actions.current === null; attempt += 1) {
      runtime.markConclusion('结论。', { at: clock.at });
      if (runtime.snapshot().actions.current === null) { clock.at += 20; }
    }
    current = runtime.snapshot().actions.current;
  }
  assert.ok(current !== null, 'an explicit action owns the pose at the boundary');
  const startedBefore = runtime.snapshot().intentEvents.started;
  runtime.takeEvents();

  const at = clock.at;
  const staged = runtime.intentEvent('answer-start', { at, holdForClipStart: true });
  const boundary = runtime.speechClip('start', { index: 0, at });
  const snap = runtime.snapshot();

  const dropped = ofType(runtime.takeEvents(), 'avatar.intent.dropped');
  assert.equal(dropped.length, 1, 'exactly one drop explains the skipped opening gesture');
  assert.equal(dropped[0].event, 'answer-start');
  assert.equal(dropped[0].intent, 'answer-start');
  assert.equal(dropped[0].reason, 'takeover-unavailable', 'an explicit owner is a takeover refusal');
  assert.equal(dropped[0].at, at, 'the decision is immediate (same boundary instant)');
  assert.equal(dropped[0].takeover.reason, 'explicit-action');
  assert.equal(snap.intentEvents.pending, null, 'nothing stays staged');
  assert.equal(snap.intentEvents.dropped, 1);
  assert.equal(snap.actions.current?.actionId, current.actionId, 'the explicit action keeps the slot');
  assert.equal(snap.actions.current?.startedAt, current.startedAt, 'it was not restarted');
  assert.equal(boundary.actionId, current.actionId, 'the clip start started nothing new');
  assert.equal(ofType(runtime.takeEvents(), 'avatar.preset.takeover').length, 0, 'no takeover happened');

  // Never queued: the whole answer runs and ends without that ticket becoming an action.
  for (let t = at; t <= at + 2500; t += 20) {
    clock.at = t;
    runtime.tick(t);
    await flush();
  }
  runtime.setStatus('waiting', 'playback.end');
  runtime.speechClip('end', { index: 0, at: clock.at });
  runtime.speechEnd({ at: clock.at });
  const afterEnd = clock.at;
  for (let t = afterEnd; t <= afterEnd + 1000; t += 20) {
    clock.at = t;
    runtime.tick(t);
    await flush();
  }
  const started = ofType(runtime.takeEvents(), 'avatar.action.start')
    .filter((entry) => entry.actionId === staged.actionId);
  assert.equal(started.length, 0, 'the dropped opening gesture is never played later');
  assert.equal(runtime.snapshot().intentEvents.started, startedBefore,
    'the refused boundary released no opening gesture (not now, not at speech end)');
  console.log(`[2] owner=${ownerPreset} startedAt=${ownerStartedAt} -> dropped `
    + `${dropped[0].reason}/${dropped[0].takeover.reason} at=${dropped[0].at} `
    + `pending=${snap.intentEvents.pending} lateActions=${started.length}`);
  runtime.dispose();
});

// =============================================================================================
// 3. A transition outside the short window is refused and recorded; nothing stalls.
// =============================================================================================
test('3. 过渡超过 240ms 上限：放弃接替并记录，不卡住调度', async () => {
  const { runtime, clock } = await makeRuntime({ config: runtimeConfig({ presetTakeoverFadeMs: 400 }) });
  let staged;
  for (let attempt = 0; attempt < 40 && staged === undefined; attempt += 1) {
    const owner = await stageOwner(runtime, clock, { event: 'thinking', status: 'thinking', recipe: 'think-tilt' });
    runtime.setStatus('speaking', 'playback.start');
    const found = findTakeoverRecipe(runtime, ['answer-center', 'answer-tilt'], 'headZ');
    if (found !== null) { staged = { owner, ...found }; break; }
    await runUntilIdle(runtime, clock);
    clock.at += 20;
  }
  assert.ok(staged, 'a thinking owner + a real opening draw was staged');
  const ownerActionId = runtime.snapshot().actions.current.actionId;
  runtime.takeEvents();

  const at = clock.at;
  runtime.intentEvent('answer-start', { at, holdForClipStart: true });
  runtime.speechClip('start', { index: 0, at });
  const snap = runtime.snapshot();
  const dropped = ofType(runtime.takeEvents(), 'avatar.intent.dropped');
  assert.equal(dropped.length, 1, 'the refusal is reported once');
  assert.equal(dropped[0].reason, 'takeover-unavailable');
  assert.equal(dropped[0].takeover.reason, 'transition-out-of-window');
  assert.equal(dropped[0].takeover.fadeMs, null, 'an out-of-window fade is never used');
  assert.equal(ofType(runtime.takeEvents(), 'avatar.preset.takeover').length, 0, 'no takeover started');
  assert.equal(snap.actions.current?.actionId, ownerActionId, 'the owner was left untouched');
  assert.equal(snap.intentEvents.pending, null, 'nothing is pending');
  assert.equal(activeItems(runtime)[0].yieldedChannels.length, 0, 'nothing was faded');

  // Not stuck: the old action still ends on its own clock and the scheduler keeps producing frames.
  const poses = [];
  for (let t = at; t <= at + 3000; t += 20) {
    clock.at = t;
    poses.push(runtime.tick(t));
    await flush();
  }
  assert.equal(runtime.snapshot().actions.current, null, 'the old action ended normally');
  assert.equal(poses.length, 151);
  assert.ok(poses.every((pose) => Number.isFinite(pose.headZ)), 'every tick produced a pose');
  const lateStarts = ofType(runtime.takeEvents(), 'avatar.action.start')
    .filter((entry) => entry.event === 'answer-start');
  assert.equal(lateStarts.length, 0, 'the refused gesture is not started later');
  console.log(`[3] fadeMs=400 -> ${dropped[0].reason}/${dropped[0].takeover.reason} `
    + `ownerKept=${snap.actions.current?.actionId === ownerActionId} ticks=${poses.length} lateStarts=${lateStarts.length}`);
  runtime.dispose();
});

// =============================================================================================
// 4. Free boundary: exactly the previous behaviour (no takeover, no drop, one opening action).
// =============================================================================================
test('4. 无占用时行为不变：直接执行，无 takeover、无 dropped（回归）', async () => {
  const { runtime, clock } = await makeRuntime();
  // Narrow the draw to one legal opening recipe, then prove it is a real preset for this ticket.
  let preview = null;
  for (const recipe of ['answer-center', 'answer-tilt', 'answer-turn', 'answer-nod']) {
    runtime.setPresetOverrides({ disabled: disabledExcept(['answer-start'], [recipe]) });
    const candidate = previewAnswerStart(runtime, 1);
    if (candidate.kind === 'preset') { preview = candidate; break; }
  }
  assert.ok(preview, 'an opening recipe is available for this draw');
  runtime.setStatus('speaking', 'playback.start');

  const staged = runtime.intentEvent('answer-start', { at: 0, holdForClipStart: true });
  assert.equal(runtime.snapshot().actions.current, null, 'nothing runs before the real start');
  const boundary = runtime.speechClip('start', { index: 0, at: 0 });
  const snap = runtime.snapshot();
  const events = runtime.takeEvents();
  assert.equal(ofType(events, 'avatar.preset.takeover').length, 0, 'a free boundary never takes over');
  assert.equal(ofType(events, 'avatar.intent.dropped').length, 0, 'nothing is dropped');
  assert.equal(ofType(events, 'avatar.preset.hold').length, 0, 'the draw did not hold');
  assert.equal(ofType(events, 'avatar.preset.action').length, 1, 'exactly one opening gesture ran');
  assert.equal(snap.actions.current?.actionId, staged.actionId, 'the staged ticket became the action');
  assert.equal(snap.actions.current?.presetId, preview.presetId, 'the previewed preset really ran');
  assert.equal(snap.intentEvents.started, 1);
  assert.equal(boundary.actionId, staged.actionId);
  assert.equal(snap.motion.presets.takeovers, 0);
  assert.equal(activeItems(runtime).length, 1);
  assert.equal(activeItems(runtime)[0].yieldedChannels.length, 0);
  console.log(`[4] preview=${preview.presetId} started=${snap.actions.current.presetId} `
    + `takeovers=${snap.motion.presets.takeovers} dropped=${snap.intentEvents.dropped} `
    + `pending=${snap.intentEvents.pending}`);
  runtime.dispose();
});

// =============================================================================================
// 5. Kept channels: only the shared channel is handed over; after the fade exactly one owner
//    remains per channel and the old action keeps its own.
// =============================================================================================
test('5. 只让出冲突通道：过渡结束后每通道单一 owner，旧动作保留非冲突通道', async () => {
  const { runtime, clock } = await makeRuntime();
  let staged;
  for (let attempt = 0; attempt < 40 && staged === undefined; attempt += 1) {
    // `listen-center` owns headX + headZ (a two-channel pre-answer action).
    const owner = await stageOwner(runtime, clock, { event: 'user-speaking', status: 'listening', recipe: 'listen-center' });
    assert.deepEqual([...owner.owner.channels].sort(), ['headX', 'headZ'], 'the owner owns headX + headZ');
    runtime.setStatus('speaking', 'playback.start');
    // The opening gesture needs headX ONLY, so headZ must stay with the old action.
    const ticket = runtime.snapshot().intentEvents.staged + 1;
    runtime.setPresetOverrides({ disabled: disabledExcept(['answer-start'], ['answer-turn']) });
    const preview = previewAnswerStart(runtime, ticket);
    const channels = preview.kind === 'preset' ? [...(preview.effectiveRequires ?? [])] : [];
    if (preview.kind === 'preset' && channels.includes('headX') && !channels.includes('headZ')) {
      staged = { owner, preview, channels, ticket };
      break;
    }
    await runUntilIdle(runtime, clock);
    clock.at += 20;
  }
  assert.ok(staged, 'a two-channel owner + a single-channel opening gesture was staged');
  runtime.takeEvents();

  const at = clock.at;
  runtime.intentEvent('answer-start', { at, holdForClipStart: true });
  runtime.speechClip('start', { index: 0, at });
  const events = runtime.takeEvents();
  const takeover = ofType(events, 'avatar.preset.takeover');
  assert.equal(takeover.length, 1);
  assert.deepEqual(takeover[0].yieldedChannels, ['headX'], 'the shared channel is yielded');
  assert.deepEqual(takeover[0].keptChannels, ['headZ'], 'the non-conflicting channel is kept');
  assert.equal(takeover[0].fadeMs, 200);

  // During the fade the two actions blend the shared channel (defined mix), and the old action
  // keeps full ownership of the kept channel in its own record.
  let snapping = runtime.snapshot();
  const oldDuring = snapping.motion.presets.active.find((item) => item.presetId === staged.owner.owner.presetId);
  assert.ok(oldDuring, 'the old action is still live during the fade');
  assert.deepEqual(oldDuring.yieldedChannels, ['headX']);
  assert.deepEqual(oldDuring.keptChannels, ['headZ']);

  for (let t = at; t <= at + 400; t += 20) {
    clock.at = t;
    runtime.tick(t);
    await flush();
  }
  snapping = runtime.snapshot();
  const done = ofType(runtime.takeEvents(), 'avatar.preset.takeover.done');
  assert.equal(done.length, 1, 'the fade completed');
  assert.deepEqual(done[0].channels, ['headX'], 'the yielded channel was released');

  const active = snapping.motion.presets.active;
  const oldAfter = active.find((item) => item.presetId === staged.owner.owner.presetId);
  assert.ok(oldAfter, 'the old action survives on its kept channel');
  assert.deepEqual(oldAfter.channels, ['headZ'], 'only the kept channel remains its own');
  assert.deepEqual(oldAfter.releasedChannels, ['headX'], 'the yielded channel is released');
  assert.deepEqual(oldAfter.yieldedChannels, [], 'nothing is still fading');
  // Exactly one owner per channel after the transition.
  const owners = new Map();
  for (const item of active) {
    for (const channel of item.channels) {
      assert.equal(owners.has(channel), false, `channel ${channel} has one owner only`);
      owners.set(channel, item.presetId);
    }
  }
  assert.equal(owners.get('headX'), staged.preview.presetId, 'the opening gesture owns the shared channel');
  assert.equal(owners.get('headZ'), staged.owner.owner.presetId, 'the old action owns the kept channel');

  // The old action's record ended at the boundary (the serial slot moved); its motion continues.
  const ended = ofType(events, 'avatar.action.end').filter((entry) => entry.by === 'takeover');
  assert.equal(ended.length, 1);
  assert.equal(ended[0].name, staged.owner.owner.presetId);
  assert.equal(runtime.snapshot().actions.current?.event, 'answer-start');
  console.log(`[5] owner=${staged.owner.owner.presetId}${JSON.stringify(staged.owner.owner.channels)} `
    + `-> ${staged.preview.presetId}${JSON.stringify(staged.channels)} `
    + `yielded=${JSON.stringify(takeover[0].yieldedChannels)} kept=${JSON.stringify(takeover[0].keptChannels)} `
    + `afterOwners=${JSON.stringify(Object.fromEntries(owners))}`);
  runtime.dispose();
});

// =============================================================================================
// 6. A channel that cannot be split (an absolute eye-open write) is refused in the controller
//    itself: no blend is invented, no channel is written, the owner stays exactly as it was.
// =============================================================================================
test('6. 通道无法分离（绝对写通道）→ 拒绝接替，不写任何通道、不改变旧动作', () => {
  const runtime = createBehaviorRuntime({
    config: { presetExecution: true, seed: 3, presetDebugEvents: false },
  });
  const pick = (context) => {
    for (let seed = 0; seed < 40; seed += 1) {
      const selection = runtime.selectPreset({ ...context, seed: `${context.recipe}:${seed}` });
      if (selection.kind === 'preset') return selection;
    }
    return null;
  };
  const ownerSelection = pick({ state: 'thinking', event: 'thinking', recipe: 'idle-blink', verifiedChannels: CONTROLLED });
  assert.ok(ownerSelection, 'the owner blink preset is selectable');
  const owner = runtime.startPreset(ownerSelection, {
    at: 0,
    context: { state: 'thinking', event: 'thinking', verifiedChannels: CONTROLLED },
  });
  assert.equal(owner.started, true);
  assert.deepEqual([...owner.channels].sort(), ['eyeOpenL', 'eyeOpenR'], 'the owner owns absolute eye channels');

  const blinkSelection = pick({ state: 'speaking', event: 'sentence-gap', recipe: 'speak-blink', verifiedChannels: CONTROLLED });
  assert.ok(blinkSelection, 'the opening blink preset is selectable');
  const refused = runtime.startPreset(blinkSelection, {
    at: 10,
    context: { state: 'speaking', event: 'answer-start', verifiedChannels: CONTROLLED },
    takeover: { actionId: owner.actionId, action: owner.presetId, preset: owner.presetId, event: 'thinking' },
  });
  assert.equal(refused.started, false, 'the blend is not invented');
  assert.equal(refused.reason, 'takeover-unavailable');
  assert.equal(refused.takeover.reason, 'channel-not-separable');
  assert.deepEqual(refused.takeover.yieldedChannels, ['eyeOpenL', 'eyeOpenR']);
  assert.deepEqual(refused.takeover.keptChannels, []);
  assert.equal(runtime.snapshot().motion.presets.takeovers, 0, 'no takeover was counted');
  assert.equal(ofType(runtime.takeEvents(), 'avatar.preset.takeover').length, 0, 'no takeover row was written');
  const active = runtime.snapshot().motion.presets.active;
  assert.equal(active.length, 1, 'only the owner is running');
  assert.deepEqual(active[0].channels, ['eyeOpenL', 'eyeOpenR'], 'the owner keeps every channel');
  assert.deepEqual(active[0].yieldedChannels, [], 'nothing is fading');
  console.log(`[6] owner=${owner.presetId}${JSON.stringify(owner.channels)} -> refused `
    + `${refused.takeover.reason} yielded=${JSON.stringify(refused.takeover.yieldedChannels)} `
    + `takeovers=${runtime.snapshot().motion.presets.takeovers}`);
});
