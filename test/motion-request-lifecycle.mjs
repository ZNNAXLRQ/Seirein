/**
 * Semantic request lifecycle acceptance.
 *
 * Run: node --test test/motion-request-lifecycle.mjs
 *
 * There is deliberately NO single queue and NO blanket 2 s TTL:
 *   - an opening action is bound to the real first audio; a missed boundary is dropped there;
 *   - a confused (corrective) request may be replaced by a newer explicit response;
 *   - a persistent posture owns its hold window and is never shortened to 2 s;
 *   - the same request class in a new turn never merges with the old turn's ticket;
 *   - priority is lifecycle gate → current communication intent → idle;
 *   - a normal cancel is smooth and the base activity keeps running.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createAvatarRuntime } from '../src/host/avatar/avatarRuntime.js';

const DT = 1000 / 30;
const flush = async () => {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
};

const ofType = (events, type) => events.filter((entry) => entry.type === type);

function createFakeTransport() {
  const writes = [];
  const batches = [];
  return {
    writes,
    batches,
    transport: {
      connect: async () => {},
      disconnect: async () => {},
      write: async ({ input, value }) => {
        writes.push({ input, value });
        return { ok: true };
      },
      writeFrame: async (entries) => {
        batches.push(entries);
        writes.push(...entries.map((entry) => ({ ...entry })));
        return { ok: true };
      },
    },
  };
}

const headConfig = (extra = {}) => ({
  autoTickMs: 0,
  flushIntervalMs: 1,
  idleActions: [],
  idleParams: {
    headX: { inputName: 'FaceAngleX', min: -30, max: 30 },
    headY: { inputName: 'FaceAngleY', min: -30, max: 30 },
    headZ: { inputName: 'FaceAngleZ', min: -30, max: 30 },
  },
  ...extra,
});

async function connectRuntime(config = headConfig(), options = {}) {
  const fake = options.fake ?? createFakeTransport();
  let clock = options.clock?.value ?? 0;
  const now = options.clock
    ? () => options.clock.value
    : () => clock;
  const runtime = createAvatarRuntime({ transport: fake.transport, now, config });
  const connected = await runtime.connect();
  assert.equal(connected.ok, true, `runtime connects (${connected.message ?? ''})`);
  fake.writes.length = 0;
  fake.batches.length = 0;
  runtime.takeEvents();
  return { runtime, fake, clock: options.clock ?? { get value() { return clock; }, set value(v) { clock = v; } } };
}

// ---------------------------------------------------------------------------------------------
// 1. opening action: real first audio or drop at the boundary
// ---------------------------------------------------------------------------------------------
test('1. 开口动作绑定真实首音：首音到达才启动，错过/会话结束即丢弃（无统一 2s 过期）', async () => {
  const clock = { value: 0 };
  const first = await connectRuntime(headConfig(), { clock });
  first.runtime.speechClip('start', { index: 0, at: 0 });
  const staged = first.runtime.intentEvent('answer-start', {
    at: 50, holdForClipStart: true,
  });
  assert.equal(staged.staged, true);
  assert.equal(staged.released, false, 'staged for the first-body-clip boundary');
  const ticket = staged.actionId;

  // 3 s with the clip still open: the request waits for its REAL boundary and is not expired by a
  // blanket 2 s TTL.
  for (clock.value = 50; clock.value <= 3000; clock.value += DT) {
    first.runtime.tick(clock.value);
    await flush();
  }
  let snap = first.runtime.snapshot();
  assert.equal(snap.actions.started, 0, 'no opening gesture ran before the first audio boundary');
  assert.equal(snap.intentEvents.pending?.actionId, ticket, 'the opening request is still the staged one');
  assert.equal(snap.requestLifecycle.pending.category, 'opening');
  assert.equal(snap.requestLifecycle.pending.deadline, 'first-audio');
  assert.equal(snap.requestLifecycle.pending.ttlMs, null, 'opening has no uniform TTL');
  assert.equal(snap.requestLifecycle.pending.persistent, false);

  const ended = first.runtime.speechEnd({ at: 3100 });
  assert.equal(ended.ok, true);
  snap = first.runtime.snapshot();
  assert.equal(snap.intentEvents.pending, null, 'session end clears the missed opening request');
  const dropped = ofType(first.runtime.takeEvents(), 'avatar.intent.dropped')
    .filter((entry) => entry.event === 'answer-start');
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].reason, 'expired');
  assert.equal(dropped[0].lifecycle, 'opening');
  assert.equal(snap.actions.started, 0, 'the missed opening gesture is never replayed');
  first.runtime.dispose();

  // The same request at the REAL first clip start runs exactly once, at that boundary.
  const secondClock = { value: 0 };
  const second = await connectRuntime(headConfig(), { clock: secondClock });
  second.runtime.speechClip('start', { index: 0, at: 0 });
  const secondStaged = second.runtime.intentEvent('answer-start', {
    at: 50, holdForClipStart: true,
  });
  const secondTicket = secondStaged.actionId;
  const released = second.runtime.speechClip('start', { index: 1, at: 300 });
  assert.equal(released.ok, true);
  const starts = ofType(second.runtime.takeEvents(), 'avatar.action.start');
  assert.equal(starts.length, 1, 'the opening gesture starts once at the real first audio');
  assert.equal(starts[0].actionId, secondTicket, 'the staged ticket became the action id');
  assert.equal(starts[0].startedAt, 300, 'the action is anchored to the clip start, not a tick');
  assert.equal(second.runtime.snapshot().requestLifecycle.current.category, 'opening');
  console.log(
    `[lifecycle] opening ticket=${ticket} missed=expired holds=3000ms`
    + ` realStart=300ms starts=${starts.length}`,
  );
  second.runtime.dispose();
});

// ---------------------------------------------------------------------------------------------
// 2. corrective request may be replaced by a newer explicit response
// ---------------------------------------------------------------------------------------------
test('2. confused 是纠正请求：更新的明确回应可取代，不排队、不补做', async () => {
  const clock = { value: 0 };
  const { runtime } = await connectRuntime(headConfig(), { clock });
  runtime.speechClip('start', { index: 0, at: 0 });
  const confused = runtime.intentEvent('confused', { at: 400 });
  assert.equal(confused.released, false, 'a mid-sentence confused request waits for its boundary');
  const confusedTicket = confused.actionId;
  let snap = runtime.snapshot();
  assert.equal(snap.requestLifecycle.pending.category, 'corrective');
  assert.equal(snap.requestLifecycle.pending.deadline, 'next-boundary');

  // A newer explicit answer-start replaces the correction BEFORE it runs.
  const explicit = runtime.intentEvent('answer-start', { at: 500 });
  assert.equal(explicit.released, false, 'the replacement still waits for the next boundary');
  assert.notEqual(explicit.actionId, confusedTicket, 'a new request gets a new ticket, never a merged one');
  snap = runtime.snapshot();
  assert.equal(snap.requestLifecycle.pending.category, 'opening');
  assert.equal(snap.requestLifecycle.counts.superseded, 1);
  assert.equal(snap.requestLifecycle.lastDropped.event, 'confused');
  assert.equal(snap.requestLifecycle.lastDropped.category, 'corrective');
  assert.equal(snap.requestLifecycle.lastDropped.reason, 'superseded');
  const superseded = ofType(runtime.takeEvents(), 'avatar.request.superseded');
  assert.equal(superseded.length, 1);
  assert.equal(superseded[0].from, 'corrective');
  assert.equal(superseded[0].to, 'opening');
  assert.equal(superseded[0].replacedCorrective, true);
  assert.equal(superseded[0].previousActionId, confusedTicket);

  runtime.speechClip('start', { index: 1, at: 700 });
  const starts = ofType(runtime.takeEvents(), 'avatar.action.start');
  assert.equal(starts.length, 1, 'only the replacement runs');
  assert.equal(starts[0].actionId, explicit.actionId);
  assert.equal(starts[0].name, 'nod', 'the explicit answer-start owns the boundary');
  assert.equal(starts.some((entry) => entry.actionId === confusedTicket), false,
    'the replaced confused request never runs later');
  console.log(
    `[lifecycle] corrective confused=${confusedTicket} replacedBy=${explicit.actionId}`
    + ` superseded=${superseded.length} starts=${starts.length}`,
  );
  runtime.dispose();
});

// ---------------------------------------------------------------------------------------------
// 3. persistent posture has no blanket 2 s TTL
// ---------------------------------------------------------------------------------------------
test('3. 持续姿态不适用统一 2s 过期：head/gaze 组件按自身保持窗口存活', async () => {
  const clock = { value: 0 };
  const fake = createFakeTransport();
  const { runtime } = await connectRuntime(headConfig({
    seed: 7,
    postureHoldMinMs: 10000,
    postureHoldMaxMs: 10000,
    // A verified gaze mapping opens the default-on gaze component.
    inputs: {
      gazeX: { inputName: 'EyeBallX', min: -1, max: 1, injectable: true },
      gazeY: { inputName: 'EyeBallY', min: -1, max: 1, injectable: true },
    },
    channelMap: { gazeX: 'EyeBallX', gazeY: 'EyeBallY' },
  }), { clock, fake });

  for (clock.value = 0; clock.value <= 2000; clock.value += DT) {
    runtime.tick(clock.value);
    await flush();
  }
  const at2s = runtime.snapshot().requestLifecycle.persistent;
  assert.ok(at2s.head, 'a head posture component is held at 2 s');
  assert.equal(at2s.head.ttlMs, null, 'persistent posture has no uniform TTL');
  assert.ok(at2s.head.holdUntil - 2000 > 2000,
    `the hold window still has >2 s left at 2 s (${at2s.head.holdUntil - 2000} ms)`);
  assert.ok(at2s.gaze, 'the verified gaze component is held at 2 s');
  assert.equal(at2s.gaze.ttlMs, null);
  assert.equal(at2s.gaze.verified, true);

  for (clock.value = 2500; clock.value <= 5000; clock.value += DT) {
    runtime.tick(clock.value);
    await flush();
  }
  const at5s = runtime.snapshot().requestLifecycle.persistent;
  assert.equal(at5s.head.id, at2s.head.id, 'the SAME posture survives past the 2 s mark');
  assert.equal(at5s.head.holdUntil, at2s.head.holdUntil, 'its own hold window was never shortened');
  assert.ok(at5s.head.holdUntil - 5000 > 0, 'the held posture is still inside its real window');
  console.log(
    `[lifecycle] persistent head=${at5s.head.id} holdUntil=${at5s.head.holdUntil}`
    + ` gaze=${at5s.gaze?.id ?? 'none'} ttl=null`,
  );
  runtime.dispose();
});

// ---------------------------------------------------------------------------------------------
// 4. the same class in a new turn never merges with the old ticket
// ---------------------------------------------------------------------------------------------
test('4. 同类请求不跨轮合并：旧轮 pending 丢弃，新轮取得新 ticket 并独立启动', async () => {
  const clock = { value: 0 };
  const { runtime } = await connectRuntime(headConfig(), { clock });
  // Establish turn 1 without starting a gesture, then open a clip.
  runtime.intentEvent('idle', { at: 0, turnId: 1 });
  runtime.speechClip('start', { index: 0, at: 0 });
  const first = runtime.intentEvent('thinking', { at: 300, turnId: 1 });
  assert.equal(first.released, false, 'the first thinking request waits mid-sentence');
  const oldTicket = first.actionId;
  assert.equal(runtime.snapshot().requestLifecycle.pending.actionId, oldTicket);

  // The next turn reports the SAME class. It must not merge into the old pending ticket.
  const second = runtime.intentEvent('thinking', { at: 400, turnId: 2 });
  assert.notEqual(second.actionId, oldTicket, 'the new turn gets its own ticket');
  assert.equal(second.released, true, 'the new turn starts without waiting for the old clip');
  let snap = runtime.snapshot();
  assert.equal(snap.intentEvents.pending, null, 'the old pending request is gone');
  assert.equal(snap.actions.current?.actionId, second.actionId, 'the new action carries the new ticket');
  const events = runtime.takeEvents();
  const dropped = ofType(events, 'avatar.intent.dropped');
  const old = dropped.find((entry) => entry.actionId === oldTicket);
  assert.ok(old, 'the old turn request is explicitly dropped');
  assert.equal(old.reason, 'stale-generation');
  assert.equal(old.by, 'turn-switch');
  assert.ok(snap.requestLifecycle.counts.staleGeneration >= 1);
  assert.equal(snap.requestLifecycle.lastStaged.turnId, 2);
  const starts = ofType(events, 'avatar.action.start');
  assert.equal(starts.length, 1);
  assert.equal(starts[0].actionId, second.actionId);
  console.log(
    `[lifecycle] turnScoped old=${oldTicket} new=${second.actionId}`
    + ` drop=${old.reason}/${old.by} starts=${starts.length}`,
  );
  runtime.dispose();
});

// ---------------------------------------------------------------------------------------------
// 5. priority: lifecycle gate → current intent → idle
// ---------------------------------------------------------------------------------------------
test('5. 优先级：已暂存的交流意图先于待机候选，句首门禁释放后才启动', async () => {
  const clock = { value: 0 };
  const { runtime } = await connectRuntime(headConfig({
    idleActions: ['nod'],
    idleActionIntervalMs: 20,
    idleActionDedupeMs: 0,
    actionDurationMs: 600,
  }), { clock });

  runtime.speechClip('start', { index: 0, at: 0 });
  const opening = runtime.intentEvent('answer-start', {
    at: 50, holdForClipStart: true,
  });
  assert.equal(opening.staged, true);
  for (clock.value = 0; clock.value <= 290; clock.value += DT) {
    runtime.tick(clock.value);
    await flush();
  }
  let snap = runtime.snapshot();
  assert.equal(snap.actions.started, 0, 'no idle candidate starts while a higher-priority request waits');
  assert.equal(snap.intentEvents.pending?.actionId, opening.actionId);

  const boundary = runtime.speechClip('start', { index: 1, at: 300 });
  assert.equal(boundary.ok, true);
  const starts = ofType(runtime.takeEvents(), 'avatar.action.start');
  assert.equal(starts.length, 1, 'only the lifecycle-gated intent starts at the boundary');
  assert.equal(starts[0].actionId, opening.actionId);
  assert.equal(starts[0].startedAt, 300);
  snap = runtime.snapshot();
  assert.equal(snap.requestLifecycle.priorityOrder[0], 'lifecycle-gate');
  assert.equal(snap.requestLifecycle.priorityOrder[1], 'current-intent');
  assert.equal(snap.requestLifecycle.priorityOrder[2], 'idle');
  console.log(
    `[lifecycle] priority staged=${opening.actionId} idleStartsBefore=0`
    + ` boundaryStart=${starts[0].startedAt} idleWaiting=${snap.actions.waiting}`,
  );
  runtime.dispose();
});

// ---------------------------------------------------------------------------------------------
// 6. smooth interruption: cancel fades, base activity continues
// ---------------------------------------------------------------------------------------------
test('6. 允许平滑打断：cancel 为淡出而非瞬移，基础活动继续', async () => {
  const clock = { value: 0 };
  const { runtime } = await connectRuntime(headConfig({ seed: 5 }), { clock });
  runtime.speechClip('start', { index: 0, at: 0 });
  const started = runtime.intentEvent('user-speaking', { at: 100 });
  assert.equal(started.released, true, 'the listening gesture starts in the sentence-head window');
  const rows = [];
  for (clock.value = 100; clock.value <= 320; clock.value += 20) {
    const pose = runtime.tick(clock.value);
    rows.push({ at: clock.value, pose });
    await flush();
  }
  const before = runtime.snapshot();
  assert.ok(before.actions.current, 'the gesture is running before the cancel');
  assert.equal(before.motion.baseActivity.state, 'running');

  const cancelled = runtime.cancelAction('nod', { fadeMs: 240 });
  assert.equal(cancelled.ok, true);
  assert.equal(runtime.snapshot().actions.current, null, 'the action slot is released by the cancel');
  const settling = runtime.snapshot();
  assert.ok(settling.inner.intents.active.length >= 1,
    'the trajectory stays in the core for a bounded fade, not a hard snap');

  for (clock.value = 320; clock.value <= 900; clock.value += 20) {
    const pose = runtime.tick(clock.value);
    rows.push({ at: clock.value, pose });
    await flush();
  }
  const after = runtime.snapshot();
  assert.equal(after.inner.intents.active.length, 0, 'the faded trajectory leaves the active list');
  assert.equal(after.motion.baseActivity.state, 'running', 'base activity keeps running');
  assert.ok(after.motion.baseActivity.headMotionMs > before.motion.baseActivity.headMotionMs,
    `base head motion continued after the cancel (${before.motion.baseActivity.headMotionMs}`
    + ` -> ${after.motion.baseActivity.headMotionMs})`);

  // The fade respects the controller velocity bound; a hard reset would exceed it on one frame.
  const limit = before.motion.limits.maxVelocity * (20 / 1000) + 0.02;
  let maxDelta = 0;
  for (let index = rows.findIndex((row) => row.at >= 320) + 1; index < rows.length; index += 1) {
    maxDelta = Math.max(maxDelta, Math.abs(rows[index].pose.headX - rows[index - 1].pose.headX));
  }
  assert.ok(maxDelta <= limit,
    `the cancel frame stays inside the velocity bound (${maxDelta.toFixed(4)} ≤ ${limit.toFixed(4)})`);
  console.log(
    `[lifecycle] smooth cancel fade=240ms maxDelta=${maxDelta.toFixed(4)}`
    + ` baseHeadMotion=${after.motion.baseActivity.headMotionMs} active=${after.inner.intents.active.length}`,
  );
  runtime.dispose();
});
