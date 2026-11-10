/**
 * P-139 stage 2 — communication events mapped to sentence-level intents.
 *
 * Run: `node --test test/motion-intent.mjs`
 *
 * The six checks are about observable behaviour, not one implementation detail:
 *   1. `answer-start` yields ONE intent at a sentence head, never twice inside the same sentence;
 *   2. `user-speaking` selects only listening intents (the event table in force is asserted);
 *   3. a turn switch drops the old generation's staged intent and stops its action immediately;
 *   4. `lookAtUser` without a real target degrades to neutral and is recorded;
 *   5. a configured event → intent table changes the selection (including invalid/ignored entries);
 *   6. style changes amplitude/duration only — the same event selects the same intent.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  OCCASIONAL_ACTION,
  createAvatarRuntime,
} from '../src/host/avatar/avatarRuntime.js';
import {
  DEFAULT_INTENT_TABLE,
  LISTENING_INTENTS,
  MOTION_EVENTS,
  NEUTRAL_INTENT,
} from '../src/host/avatar/motionEvents.js';

const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve));

/** Transport that records every single-write and every coalesced frame. */
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
        writes.push(...entries.map((entry) => ({ input: entry.input, value: entry.value })));
        return { ok: true };
      },
    },
  };
}

const connectRuntime = async (options) => {
  const runtime = createAvatarRuntime(options);
  const result = await runtime.connect();
  assert.equal(result.ok, true, `runtime connects (${result.message ?? ''})`);
  return runtime;
};

/** Verified head axes: a nod needs headY/headZ, a tilt headX, a surprise headZ. */
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

const ofType = (events, type) => events.filter((entry) => entry.type === type);

// ---------------------------------------------------------------------------------------------
// 1. sentence-level release
// ---------------------------------------------------------------------------------------------
test('1. answer-start 在句首触发一次意图，句内不重复', async () => {
  const fake = createFakeTransport();
  let clock = 0;
  const runtime = await connectRuntime({
    transport: fake.transport,
    now: () => clock,
    config: headConfig(),
  });
  runtime.takeEvents(); // drop connect/probe diagnostics

  // Three real clips. The intents arrive at different points inside a sentence; only a sentence
  // boundary (or the head window of the clip that just started) may release one.
  const clips = [
    { index: 0, start: 0, end: 1100 },
    { index: 1, start: 1200, end: 2300 },
    { index: 2, start: 2400, end: 3500 },
  ];
  const phases = [
    { at: 0, event: 'answer-start' },
    // Inside sentence 0, but after the head window: it must wait for the NEXT sentence.
    { at: 100, event: 'user-speaking' },
    { at: 1500, event: 'thinking' },
    { at: 2600, event: 'answer-end' },
  ];

  const dispatch = (at) => {
    for (const clip of clips) {
      if (clip.start === at) runtime.speechClip('start', { index: clip.index, at });
      if (clip.end === at) runtime.speechClip('end', { index: clip.index, at });
    }
    for (const phase of phases) {
      if (phase.at === at) runtime.intentEvent(phase.event, { at });
    }
  };
  for (clock = 0; clock <= 3600; clock += 20) {
    dispatch(clock);
    runtime.tick(clock);
    await flushMicrotasks();
  }
  runtime.speechEnd({ at: 3500 });

  const events = runtime.takeEvents();
  const starts = ofType(events, 'avatar.action.start');
  const staged = ofType(events, 'avatar.intent.staged');
  const clipStarts = clips.map((clip) => clip.start);

  assert.equal(starts.length, 3, `one intent per sentence (${starts.length})`);
  for (const entry of starts) {
    assert.ok(clipStarts.includes(entry.startedAt),
      `intent started at a sentence head (${entry.startedAt})`);
    assert.equal(entry.durationSource, 'intent', 'the action uses the intent duration, not the preset one');
    assert.equal(typeof entry.actionId, 'number');
  }
  // The sentence-head answer-start is the FIRST action and carries the staged ticket.
  const answerStart = staged.find((entry) => entry.event === 'answer-start');
  assert.ok(answerStart, 'answer-start was staged');
  assert.equal(answerStart.intent, DEFAULT_INTENT_TABLE['answer-start']);
  assert.equal(starts[0].actionId, answerStart.actionId, 'staged ticket becomes the action id');

  // Exactly one intent inside each sentence, and none strictly inside a clip (mid-sentence).
  for (const clip of clips) {
    const inside = starts.filter((entry) => entry.startedAt >= clip.start && entry.startedAt <= clip.end);
    assert.equal(inside.length, 1, `sentence ${clip.index} started exactly one intent (${inside.length})`);
    const mid = starts.filter((entry) => entry.startedAt > clip.start && entry.startedAt < clip.end);
    assert.equal(mid.length, 0, `sentence ${clip.index} never triggered mid-sentence`);
  }
  const settled = ofType(events, 'avatar.intent.settled');
  assert.equal(settled.length, 1, 'answer-end released the neutral settle');
  assert.equal(settled[0].event, 'answer-end');
  assert.equal(settled[0].actionId, staged.find((entry) => entry.event === 'answer-end').actionId);
  const snap = runtime.snapshot();
  assert.equal(snap.intentEvents.started, 3, 'the snapshot counts the released intents');
  console.log(
    `[p139] sentence starts=${starts.map((entry) => `${entry.name}@${entry.startedAt}`).join(',')}`
    + ` staged=${staged.length} settled=${settled.length} perSentence=1 midSentence=0`,
  );
  runtime.dispose();
});

// ---------------------------------------------------------------------------------------------
// 2. user-speaking only selects listening intents
// ---------------------------------------------------------------------------------------------
test('2. user-speaking 只按映射表触发倾听类意图', async () => {
  const fake = createFakeTransport();
  let clock = 0;
  const runtime = await connectRuntime({
    transport: fake.transport,
    now: () => clock,
    config: headConfig(),
  });
  const table = runtime.snapshot().intentEvents.table;
  assert.equal(table['user-speaking'], 'nod', 'the shipped table maps user-speaking to a nod');
  runtime.takeEvents();

  const reported = runtime.intentEvent('user-speaking', { at: 0 });
  assert.equal(reported.ok, true);
  assert.equal(reported.intent, table['user-speaking']);
  for (clock = 0; clock <= 600; clock += 20) {
    runtime.tick(clock);
    await flushMicrotasks();
  }

  const events = runtime.takeEvents();
  const staged = ofType(events, 'avatar.intent.staged');
  const starts = ofType(events, 'avatar.action.start');
  assert.equal(staged.length, 1, 'one staged intent for one phase event');
  assert.equal(staged[0].event, 'user-speaking');
  assert.ok(LISTENING_INTENTS.includes(staged[0].intent),
    `user-speaking only selects a listening intent (${staged[0].intent})`);
  assert.equal(starts.length, 1);
  assert.equal(starts[0].name, staged[0].intent, 'the started gesture is the mapped listening intent');
  assert.equal(starts[0].name, 'nod');
  assert.equal(events.some((entry) => entry.type === 'avatar.intent.staged' && entry.intent === 'surprise'),
    false, 'no surprise gesture while the user is talking');
  const ids = new Set(staged.map((entry) => entry.actionId));
  assert.equal(ids.size, 1, 'the single staged intent keeps one identity');
  console.log(
    `[p139] userSpeaking intent=${staged[0].intent} listening=${LISTENING_INTENTS.join('|')}`
    + ` starts=${starts.length} surprise=0`,
  );
  runtime.dispose();
});

// ---------------------------------------------------------------------------------------------
// 3. turn switch invalidates the old generation
// ---------------------------------------------------------------------------------------------
test('3. turn 切换：旧代际意图被丢弃，旧动作立即停止', async () => {
  const fake = createFakeTransport();
  let clock = 0;
  const runtime = await connectRuntime({
    transport: fake.transport,
    now: () => clock,
    config: headConfig(),
  });
  // A long nod so the action is still running when the turn switches.
  runtime.setStyle({ nodDurationMs: 900 });
  runtime.takeEvents();

  runtime.speechClip('start', { index: 0, at: 0 });
  const started = runtime.intentEvent('answer-start', { at: 0 });
  assert.equal(started.released, true, 'the head-window event starts immediately');
  for (clock = 0; clock <= 600; clock += 20) {
    runtime.tick(clock);
    await flushMicrotasks();
  }
  // A phase inside the sentence is staged, not started.
  const staged = runtime.intentEvent('thinking', { at: 600 });
  assert.equal(staged.released, false, 'a mid-sentence phase waits for the next boundary');
  const staleTicket = runtime.snapshot().intentEvents.pending.actionId;
  const generationBefore = runtime.snapshot().intentEvents.generation;

  // The host reports the next turn: old generation invalidated before this event is staged.
  const switched = runtime.intentEvent('turn-start', { at: 700, turnId: 1 });
  assert.equal(switched.staged, true);
  for (clock = 700; clock <= 1500; clock += 20) {
    runtime.tick(clock);
    await flushMicrotasks();
  }

  const events = runtime.takeEvents();
  const dropped = ofType(events, 'avatar.intent.dropped')
    .filter((entry) => entry.reason === 'stale-generation');
  assert.equal(dropped.length, 1, 'exactly the old staged intent was dropped');
  assert.equal(dropped[0].actionId, staleTicket, 'the dropped intent is the old generation ticket');
  assert.equal(dropped[0].intent, 'tilt');
  assert.equal(dropped[0].by, 'turn-switch');
  const interrupted = ofType(events, 'avatar.action.interrupted');
  assert.ok(interrupted.some((entry) => entry.by === 'turn-switch'),
    'the old running action was stopped with the turn switch');
  const starts = ofType(events, 'avatar.action.start');
  assert.equal(starts.length, 1, 'no action of the old generation started after the switch');
  assert.notEqual(starts[0].actionId, staleTicket, 'the stale ticket never became an action');
  const snap = runtime.snapshot();
  assert.equal(snap.intentEvents.generation, generationBefore + 1, 'the generation advanced once');
  assert.equal(snap.intentEvents.pending, null, 'nothing of the old generation is still staged');
  assert.equal(snap.speech.clip.session, false, 'the old turn\'s clip session was closed');
  console.log(
    `[p139] turnSwitch generation=${generationBefore}->${snap.intentEvents.generation}`
    + ` staleTicket=${staleTicket} dropped=${dropped.length} interrupted=${interrupted.length}`
    + ` starts=${starts.length}`,
  );
  runtime.dispose();
});

// ---------------------------------------------------------------------------------------------
// 4. lookAtUser needs a real target
// ---------------------------------------------------------------------------------------------
test('4. 无真实目标时 look-at-user 退化为中性并记录', async () => {
  const fake = createFakeTransport();
  let clock = 0;
  const runtime = await connectRuntime({
    transport: fake.transport,
    now: () => clock,
    config: {
      autoTickMs: 0,
      flushIntervalMs: 1,
      idleActions: [],
      idleParams: { headY: { inputName: 'FaceAngleY', min: -30, max: 30 } },
      inputs: {
        gazeX: { inputName: 'EyeBallX', min: -1, max: 1, injectable: true },
        gazeY: { inputName: 'EyeBallY', min: -1, max: 1, injectable: true },
      },
      channelMap: { gazeX: 'EyeBallX', gazeY: 'EyeBallY' },
      // This test isolates ONE explicit intent: the phase-3 autonomous gaze component is default
      // ON for a verified gaze mapping, so it must be switched off here or its own idle gaze rows
      // would be mistaken for the lookAtUser gesture. The default-on path is covered by test 4b.
      componentGazeEnabled: false,
    },
  });
  fake.writes.length = 0;
  runtime.takeEvents();

  // A verified gaze mapping exists, but no real target was ever published: no look, no write.
  const degraded = runtime.intentEvent('turn-start', { at: 0 });
  assert.equal(degraded.degraded, true);
  assert.equal(degraded.intent, NEUTRAL_INTENT, 'lookAtUser degrades to the neutral settle');
  for (clock = 0; clock <= 600; clock += 20) {
    runtime.tick(clock);
    await flushMicrotasks();
  }
  const neutralWrites = fake.writes.filter((entry) => entry.input === 'EyeBallX' || entry.input === 'EyeBallY');
  assert.equal(neutralWrites.length, 0, 'no gaze was written without a target');
  const first = runtime.takeEvents();
  const degradedEvents = ofType(first, 'avatar.intent.degraded');
  assert.equal(degradedEvents.length, 1);
  assert.equal(degradedEvents[0].intent, 'lookAtUser');
  assert.equal(degradedEvents[0].to, NEUTRAL_INTENT);
  assert.equal(degradedEvents[0].reason, 'no-target');
  assert.equal(ofType(first, 'avatar.action.start').some((entry) => entry.name === 'lookAtUser'), false);

  // A real verified target turns the same event into an executed look.
  runtime.setAttention({ x: 0.35, y: -0.2 }, { verified: true, source: 'vision' });
  const executed = runtime.intentEvent('turn-start', { at: 1000 });
  assert.equal(executed.degraded, false);
  assert.equal(executed.intent, 'lookAtUser');
  assert.equal(executed.released, true);
  for (clock = 1000; clock <= 1700; clock += 20) {
    runtime.tick(clock);
    await flushMicrotasks();
  }
  const gazeWrites = fake.writes.filter((entry) => entry.input === 'EyeBallX');
  assert.ok(gazeWrites.length > 0, 'a proved target is actually written');
  assert.ok(gazeWrites.some((entry) => entry.value > 0.1),
    `gazeX follows the verified target (${gazeWrites.map((entry) => entry.value.toFixed(2)).join(',')})`);
  const second = runtime.takeEvents();
  assert.equal(ofType(second, 'avatar.intent.degraded').length, 0, 'no degradation with a real target');
  assert.equal(ofType(second, 'avatar.action.start').some((entry) => entry.name === 'lookAtUser'), true);
  console.log(
    `[p139] lookAtUser noTarget=intent:${NEUTRAL_INTENT}/reason:no-target writes=0`
    + ` target=x0.35 gazeWrites=${gazeWrites.length} max=${Math.max(...gazeWrites.map((entry) => entry.value)).toFixed(3)}`,
  );
  runtime.dispose();
});

// ---------------------------------------------------------------------------------------------
// 4b. default-on autonomous gaze
// ---------------------------------------------------------------------------------------------
test('4b. 自动视线默认开启：只在能力验证后写，不冒充“看向用户”，与显式 intent 混合仍单写', async () => {
  // Default-on is still gated by BOTH verified gaze axes: a single declaration must stay silent.
  const partialFake = createFakeTransport();
  let partialClock = 0;
  const partial = await connectRuntime({
    transport: partialFake.transport,
    now: () => partialClock,
    config: {
      autoTickMs: 0,
      flushIntervalMs: 1,
      idleActions: [],
      idleParams: { headY: { inputName: 'FaceAngleY', min: -30, max: 30 } },
      inputs: {
        gazeX: { inputName: 'EyeBallX', min: -1, max: 1, injectable: true },
        gazeY: { inputName: 'EyeBallY', min: -1, max: 1, injectable: true },
      },
      // Only ONE axis is declared: the other remains unverified, so the default-on component
      // must NOT write.
      channelMap: { gazeX: 'EyeBallX' },
    },
  });
  partialFake.writes.length = 0;
  for (partialClock = 0; partialClock <= 800; partialClock += 20) {
    partial.tick(partialClock);
    await flushMicrotasks();
  }
  const partialSnap = partial.snapshot();
  assert.equal(partialSnap.inner.motion.posture.componentGazeVerified, false,
    'one verified gaze axis is not enough to open the automatic component');
  assert.equal(partialFake.writes.filter((entry) => entry.input === 'EyeBallX'
    || entry.input === 'EyeBallY').length, 0, 'the gated automatic component writes no gaze');
  partial.dispose();

  const fake = createFakeTransport();
  let clock = 0;
  const runtime = await connectRuntime({
    transport: fake.transport,
    now: () => clock,
    config: {
      autoTickMs: 0,
      flushIntervalMs: 1,
      idleActions: [],
      idleParams: { headY: { inputName: 'FaceAngleY', min: -30, max: 30 } },
      inputs: {
        gazeX: { inputName: 'EyeBallX', min: -1, max: 1, injectable: true },
        gazeY: { inputName: 'EyeBallY', min: -1, max: 1, injectable: true },
      },
      channelMap: { gazeX: 'EyeBallX', gazeY: 'EyeBallY' },
      // componentGazeEnabled is deliberately omitted: the default must be ON, but only after the
      // verified gaze takeover set opens the gate.
    },
  });
  fake.writes.length = 0;
  runtime.takeEvents();

  for (clock = 0; clock <= 800; clock += 20) {
    runtime.tick(clock);
    await flushMicrotasks();
  }
  const autoWrites = fake.writes.filter((entry) => entry.input === 'EyeBallX'
    || entry.input === 'EyeBallY');
  assert.ok(autoWrites.length > 0, 'the verified gaze component writes without any explicit intent');

  const auto = runtime.snapshot();
  assert.equal(auto.inner.motion.posture.componentGazeVerified, true,
    'automatic gaze is enabled only by the verified gaze mapping');
  assert.equal(auto.inner.motion.attention.mode, 'neutral',
    'an automatic gaze component is never reported as "looking at the user"');
  assert.equal(auto.inner.motion.attention.verified, false);
  assert.equal(ofType(runtime.takeEvents(), 'avatar.action.start')
    .some((entry) => entry.name === 'lookAtUser'), false,
  'automatic gaze never starts a lookAtUser action');

  // Every coalesced frame still writes an input at most once: the automatic component and an
  // explicit gesture share the ONE writer rather than producing duplicate rows.
  for (const entries of fake.batches) {
    const inputs = entries.map((entry) => entry.input);
    assert.equal(new Set(inputs).size, inputs.length,
      `duplicate input in one mixed frame: ${inputs.join(',')}`);
  }

  // A real target turns the SAME verified mapping into an explicit lookAtUser gesture. The
  // automatic component must coexist with it (not replace it, not double-write it).
  runtime.setAttention({ x: 0.35, y: -0.2 }, { verified: true, source: 'vision' });
  const executed = runtime.intentEvent('turn-start', { at: 1000 });
  assert.equal(executed.degraded, false, 'a verified target + verified mapping executes lookAtUser');
  assert.equal(executed.intent, 'lookAtUser');
  for (clock = 1000; clock <= 1700; clock += 20) {
    runtime.tick(clock);
    await flushMicrotasks();
  }
  const events = runtime.takeEvents();
  assert.equal(ofType(events, 'avatar.action.start')
    .some((entry) => entry.name === 'lookAtUser'), true, 'the explicit lookAtUser action really starts');
  const targetWrites = fake.writes.filter((entry) => entry.input === 'EyeBallX' && entry.value > 0.1);
  assert.ok(targetWrites.length > 0, 'the explicit target still reaches the gaze input');
  for (const entries of fake.batches) {
    const inputs = entries.map((entry) => entry.input);
    assert.equal(new Set(inputs).size, inputs.length,
      `duplicate input in one explicit+automatic frame: ${inputs.join(',')}`);
  }
  console.log(
    `[p139] autoGaze writes=${autoWrites.length} verified=${auto.inner.motion.posture.componentGazeVerified}`
    + ` attention=${auto.inner.motion.attention.mode} explicit=${executed.intent}`
    + ` targetWrites=${targetWrites.length}`,
  );
  runtime.dispose();
});

// ---------------------------------------------------------------------------------------------
// 5. configurable event → intent table
// ---------------------------------------------------------------------------------------------
test('5. 事件→意图表可配置（含非法项与未知事件的显式记录）', async () => {
  const run = async (intentTable) => {
    const fake = createFakeTransport();
    let clock = 0;
    const runtime = await connectRuntime({
      transport: fake.transport,
      now: () => clock,
      config: headConfig(intentTable === undefined ? {} : { intentTable }),
    });
    fake.writes.length = 0;
    runtime.takeEvents();
    return { runtime, fake, setClock: (value) => { clock = value; } };
  };

  const custom = await run({ 'answer-start': 'surprise' });
  assert.equal(custom.runtime.snapshot().intentEvents.table['answer-start'], 'surprise');
  const reported = custom.runtime.intentEvent('answer-start', { at: 0 });
  assert.equal(reported.intent, 'surprise', 'the configured table selects the intent');
  custom.runtime.tick(0);
  await flushMicrotasks();
  let events = custom.runtime.takeEvents();
  assert.equal(ofType(events, 'avatar.action.start')[0].name, 'surprise');

  // Runtime replacement: the next event uses the NEW table, no restart involved.
  const replaced = custom.runtime.setIntentTable({ thinking: 'nod' });
  assert.equal(replaced.table.thinking, 'nod');
  const bad = custom.runtime.setIntentTable({ thinking: 'wiggle', bogus: 'nod' });
  assert.deepEqual(bad.invalid, ['thinking'], 'an unknown intent is reported, not guessed');
  assert.deepEqual(bad.ignored, ['bogus'], 'an unknown phase cannot add a lifecycle hook');
  assert.equal(custom.runtime.snapshot().intentEvents.table.thinking, 'nod',
    'an invalid entry keeps the previous valid mapping');

  const thinking = custom.runtime.intentEvent('thinking', { at: 1000 });
  assert.equal(thinking.intent, 'nod');
  custom.runtime.tick(1000);
  await flushMicrotasks();
  events = custom.runtime.takeEvents();
  assert.equal(ofType(events, 'avatar.action.start')[0].name, 'nod');

  // And the shipped default is untouched by the runtime that configured a table.
  const shipped = await run(undefined);
  assert.deepEqual({ ...shipped.runtime.snapshot().intentEvents.table }, { ...DEFAULT_INTENT_TABLE });
  assert.equal(shipped.runtime.intentEvent('answer-start', { at: 0 }).intent, DEFAULT_INTENT_TABLE['answer-start']);
  console.log(
    `[p139] table custom=surprise replaced=nod invalid=[thinking] ignored=[bogus]`
    + ` defaultAnswerStart=${DEFAULT_INTENT_TABLE['answer-start']} events=${MOTION_EVENTS.length}`,
  );
  custom.runtime.dispose();
  shipped.runtime.dispose();
});

// ---------------------------------------------------------------------------------------------
// 6. style changes size/timing, never the selection
// ---------------------------------------------------------------------------------------------
test('6. 风格只影响幅度/时长，不改变意图选择', async () => {
  const run = async (style) => {
    const fake = createFakeTransport();
    let clock = 0;
    const runtime = await connectRuntime({
      transport: fake.transport,
      now: () => clock,
      config: headConfig({ style }),
    });
    runtime.takeEvents();
    const reported = runtime.intentEvent('user-speaking', { at: 0 });
    runtime.tick(0);
    await flushMicrotasks();
    const events = runtime.takeEvents();
    const started = ofType(events, 'avatar.action.start')[0];
    const gesture = ofType(events, 'avatar.intent.start')[0];
    runtime.dispose();
    return { intent: reported.intent, action: started, gesture };
  };

  const quiet = await run({ amplitude: 0.5, tempo: 1.4, nodDurationMs: 450 });
  const lively = await run({ amplitude: 1.35, tempo: 0.7, nodDurationMs: 450 });

  assert.equal(quiet.intent, 'nod');
  assert.equal(lively.intent, 'nod', 'the same event selects the same intent in both styles');
  assert.equal(quiet.action.name, lively.action.name);
  assert.ok(lively.action.durationMs > quiet.action.durationMs,
    `tempo changes duration (${quiet.action.durationMs} < ${lively.action.durationMs})`);
  assert.ok(lively.gesture.amplitude > quiet.gesture.amplitude,
    `amplitude scales the gesture (${quiet.gesture.amplitude} < ${lively.gesture.amplitude})`);
  console.log(
    `[p139] styleSelection intent=quiet:${quiet.intent}/lively:${lively.intent}`
    + ` duration=${quiet.action.durationMs}/${lively.action.durationMs}`
    + ` amplitude=${quiet.gesture.amplitude.toFixed(3)}/${lively.gesture.amplitude.toFixed(3)}`,
  );
});

// ---------------------------------------------------------------------------------------------
// 7-9. P-139 stage 3 — action variants, dimensions never select an intent, single-slot regression
// ---------------------------------------------------------------------------------------------

test('7. 动作变体：同一意图连续 5 次相邻变体不同，意图名/通道不变，只改幅度/时长', async () => {
  const fake = createFakeTransport();
  const runtime = await connectRuntime({
    transport: fake.transport,
    now: () => 0,
    config: headConfig({ seed: 31, style: { amplitude: 1, tempo: 1 } }),
  });
  runtime.takeEvents();

  const results = [];
  for (let index = 0; index < 5; index += 1) {
    const info = runtime.intent('nod', { at: index * 40 });
    assert.equal(info.ok, true, `intent ${index} starts`);
    results.push(info);
    runtime.tick(index * 40);
  }
  const snapshot = runtime.snapshot();
  const events = runtime.takeEvents();
  const drawn = ofType(events, 'avatar.intent.variant');

  assert.equal(drawn.length, 5, 'one variant event per started intent');
  for (const entry of drawn) {
    assert.equal(entry.intent, 'nod', 'the event names the SAME intent');
    assert.equal(typeof entry.variant, 'string');
    assert.equal(entry.seed, drawn[0].seed, 'all draws share the one seeded stream identity');
  }
  for (let index = 1; index < results.length; index += 1) {
    assert.notEqual(results[index].variant, results[index - 1].variant,
      `variant never repeats back-to-back (${results[index - 1].variant} → ${results[index].variant})`);
    assert.equal(results[index].kind, 'nod', 'the intent name is unchanged by the variant');
    assert.deepEqual(results[index].channels, results[0].channels, 'the variant never changes channels');
    if (results[index].variant !== results[index - 1].variant) {
      const expressionChanged = results[index].amplitude !== results[index - 1].amplitude
        || results[index].durationMs !== results[index - 1].durationMs;
      assert.ok(expressionChanged, 'a new variant changes amplitude or duration, nothing semantic');
    }
  }
  assert.ok(new Set(results.map((entry) => entry.variant)).size >= 2, 'more than one variant was used');
  assert.deepEqual(snapshot.intent.lastVariant, {
    intent: 'nod',
    variant: results.at(-1).variant,
    seed: drawn.at(-1).seed,
  }, 'snapshot().intent.lastVariant mirrors the last draw');
  console.log(
    `[p139] variants=${results.map((entry) => entry.variant).join('→')}`
    + ` amplitudes=${results.map((entry) => entry.amplitude.toFixed(3)).join('/')}`
    + ` durations=${results.map((entry) => entry.durationMs).join('/')}`
    + ` lastVariant=${snapshot.intent.lastVariant.variant}`,
  );
  runtime.dispose();
});

test('8. 维度只影响表达：同一事件表下安静/活泼人设选出相同意图', async () => {
  const quietStyle = {
    amplitude: 0.55, tempo: 0.8, nodAmplitude: 0.5, expressiveness: 0.6,
    tiltChance: 0.05, nodDurationMs: 700,
  };
  const livelyStyle = {
    amplitude: 1.35, tempo: 1.35, nodAmplitude: 1.3, expressiveness: 1.4,
    tiltChance: 0.4, nodDurationMs: 350,
  };
  const select = async (style) => {
    const fake = createFakeTransport();
    const runtime = await connectRuntime({
      transport: fake.transport,
      now: () => 0,
      config: headConfig({ style }),
    });
    const table = { ...runtime.snapshot().intentEvents.table };
    const intents = ['turn-start', 'user-speaking', 'thinking', 'answer-end'].map((event) =>
      runtime.intentEvent(event, { at: 0 }).intent);
    const dimensions = runtime.snapshot().style.dimensions;
    runtime.dispose();
    return { table, intents, dimensions };
  };

  const quiet = await select(quietStyle);
  const lively = await select(livelyStyle);
  assert.deepEqual(quiet.table, lively.table, 'both runs use the same event → intent table');
  assert.deepEqual(quiet.intents, lively.intents,
    `the table selects the same intents regardless of dimensions (${quiet.intents.join(',')})`);
  assert.ok(lively.dimensions.liveliness > quiet.dimensions.liveliness,
    'the two personas really do differ in dimensions');
  console.log(
    `[p139] dimensionsSelection intents=${quiet.intents.join(',')}`
    + ` liveliness=${quiet.dimensions.liveliness}/${lively.dimensions.liveliness}`
    + ` restraint=${quiet.dimensions.restraint}/${lively.dimensions.restraint}`,
  );
});

/** Transport whose motion sends stay pending until the test resolves them, one at a time. */
function createGatedMotionTransport() {
  const calls = [];
  const resolvers = [];
  return {
    calls,
    transport: {
      connect: async () => {},
      disconnect: async () => {},
      write: async () => ({ ok: true }),
      writeMotion: (payload) => {
        calls.push(payload);
        return new Promise((resolve) => {
          resolvers.push(() => resolve({ ok: true }));
        });
      },
    },
    resolveNext() {
      const next = resolvers.shift();
      if (next) next();
    },
  };
}

test('9. 单槽/单飞回归：突发意图仍只有一条发送在飞，旧帧只丢不补播', async () => {
  const gated = createGatedMotionTransport();
  const runtime = await connectRuntime({
    transport: gated.transport,
    now: () => 0,
    config: headConfig({ motionWrites: true, motionOutputHz: 30, seed: 7 }),
  });
  runtime.takeEvents();
  runtime.tick(0); // the first motion frame is now physically in flight
  assert.equal(gated.calls.length, 1, 'exactly one send is in flight');

  for (let index = 0; index < 5; index += 1) {
    runtime.intent('nod', { at: index * 10 });
    for (let step = 1; step <= 3; step += 1) runtime.tick(index * 30 + step * 10);
  }
  await flushMicrotasks();
  const during = runtime.snapshot().motion;
  assert.equal(gated.calls.length, 1, 'no concurrent send while one frame is unsettled');
  assert.equal(during.inFlight, true, 'the single-flight gate is held by the one send');
  assert.equal(during.pending, true, 'at most one newer frame is staged');
  assert.ok(during.dropped >= 1, `older staged frames were dropped, not replayed (${during.dropped})`);
  assert.equal(during.sent, 0, 'no send is counted before it settles');

  gated.resolveNext();
  await flushMicrotasks();
  await flushMicrotasks();
  assert.equal(gated.calls.length, 2, 'the newest staged frame goes out after the settle');
  const after = runtime.snapshot().motion;
  assert.ok(after.sent >= 1, 'a settled send is counted');
  assert.equal(after.inFlight, true, 'the second send owns the gate; sends never overlap');
  assert.ok(after.sent <= gated.calls.length, 'sent never exceeds the physical transport calls');
  console.log(
    `[p139] singleFlight calls=${gated.calls.length} dropped=${during.dropped}`
    + ` sent=${after.sent} inFlight=${after.inFlight} pending=${after.pending}`,
  );
  runtime.dispose();
});

// ---------------------------------------------------------------------------------------------
// 10. a turn switch clears the CORE trajectory, not just the bookkeeping
// ---------------------------------------------------------------------------------------------
test('10. 切轮立即清核心旧轨迹：轴目标归零、无两套叠加、事件 remainingMs 真实', async () => {
  const fake = createFakeTransport();
  let clock = 0;
  const runtime = await connectRuntime({
    transport: fake.transport,
    now: () => clock,
    config: headConfig({
      // A long enough gesture that the old trajectory would visibly keep running (the counterexample).
      style: { nodDurationMs: 1200 },
      intentTable: { thinking: 'tilt', 'user-speaking': 'nod' },
    }),
  });
  runtime.takeEvents();

  clock = 0;
  const first = runtime.intentEvent('thinking', { at: 0, turnId: 0 });
  assert.equal(first.intent, 'tilt');
  assert.equal(first.released, true, 'turn 1 starts the head tilt immediately');
  for (clock = 0; clock <= 100; clock += 20) runtime.tick(clock);
  clock = 100;
  const before = runtime.snapshot().intents;
  assert.equal(before.active.length, 1, 'one tilt trajectory is running');
  assert.equal(before.active[0].kind, 'tilt');
  const oldRemaining = before.active[0].remainingMs;
  assert.ok(oldRemaining > 300, `the old tilt still had ${Math.round(oldRemaining)} ms to run`);
  assert.ok(before.channels.includes('headX'), 'the old tilt still targets headX before the switch');

  // Turn 2 starts 100 ms later: the old generation must be cleared before the new gesture exists.
  const switched = runtime.intentEvent('user-speaking', { at: 100, turnId: 1 });
  assert.equal(switched.intent, 'nod');
  assert.equal(switched.released, true);

  const cleared = ofType(runtime.takeEvents(), 'avatar.intent.trajectory.cleared');
  assert.equal(cleared.length, 1, `exactly one trajectory clearance was recorded (${cleared.length})`);
  assert.equal(cleared[0].reason, 'turn-switch');
  assert.deepEqual(cleared[0].axes, ['headX', 'headZ'], 'the cleared axes are the old tilt channels');
  // Requirement 4: the event carries the REAL remaining time, not a record-only marker.
  assert.ok(Math.abs(cleared[0].remainingMs - oldRemaining) <= 1000 / 30,
    `cleared remainingMs ${cleared[0].remainingMs} must match the pre-clear ${oldRemaining}`);
  assert.ok(cleared[0].remainingMs > 300, 'the cancelled tail was a real, sizeable trajectory');

  // The next frame's axis target is the pure idle base on headX: the nod never drives headX, so a
  // surviving old tilt would be the only source of a non-zero headX target here.
  runtime.tick(100);
  const after = runtime.snapshot().intents;
  assert.equal(after.target.headX, 0, `no residual headX target (${after.target.headX})`);
  assert.equal(after.channels.includes('headX'), false, 'no old headX trajectory is still flushing');
  assert.deepEqual(after.active.map((entry) => entry.kind), ['nod'],
    'only the new generation is active — the two tilt targets never stack');
  const oldLeft = after.active
    .filter((entry) => entry.kind === 'tilt')
    .reduce((max, entry) => Math.max(max, entry.remainingMs), 0);
  assert.ok(oldLeft <= 1000 / 30, `the old trajectory has at most one frame left (${oldLeft} ms)`);

  // The same-generation NEW gesture is untouched: it keeps running and drives its own axis.
  for (clock = 120; clock <= 400; clock += 20) runtime.tick(clock);
  const later = runtime.snapshot().intents;
  assert.equal(later.active.length, 1, 'the new nod was not interrupted by the clear');
  assert.equal(later.active[0].kind, 'nod');
  assert.ok(Math.abs(later.target.headY) > 0.01, `the new gesture still drives headY (${later.target.headY})`);
  assert.equal(later.target.headX, 0, 'the old tilt never comes back');
  console.log(
    `[p139] trajectoryClear reason=${cleared[0].reason} axes=${cleared[0].axes.join('|')}`
    + ` remainingMs=${cleared[0].remainingMs} (pre-clear ${Math.round(oldRemaining)})`
    + ` oldLeft=${oldLeft}ms active=${after.active.map((entry) => entry.kind).join(',')}`
    + ` headXTarget=0 nodHeadY=${later.target.headY.toFixed(3)}`,
  );
  runtime.dispose();
});

// ---------------------------------------------------------------------------------------------
// 11. same-generation handoff is unchanged: an action-busy intent waits, never drops
// ---------------------------------------------------------------------------------------------
test('11. 同代际交接不变：action-busy 延迟到下一句，后一个意图不丢、不清轨迹', async () => {
  const fake = createFakeTransport();
  let clock = 0;
  const runtime = await connectRuntime({
    transport: fake.transport,
    now: () => clock,
    config: headConfig({
      style: { nodDurationMs: 1200 },
      intentTable: { 'answer-start': 'tilt', thinking: 'nod' },
    }),
  });
  runtime.takeEvents();

  clock = 0;
  runtime.speechClip('start', { index: 0, at: 0 });
  const first = runtime.intentEvent('answer-start', { at: 0 });
  assert.equal(first.released, true, 'the first intent starts at the sentence head');
  for (clock = 20; clock <= 300; clock += 20) runtime.tick(clock);
  clock = 300;
  const second = runtime.intentEvent('thinking', { at: 300 });
  assert.equal(second.released, false, 'a mid-sentence phase waits for the next boundary');
  const pendingTicket = runtime.snapshot().intentEvents.pending?.actionId;
  assert.equal(typeof pendingTicket, 'number');

  // The next sentence starts while the first action is still running: DEFER, do not drop.
  clock = 400;
  runtime.speechClip('end', { index: 0, at: 400 });
  clock = 500;
  runtime.speechClip('start', { index: 1, at: 500 });
  let snap = runtime.snapshot();
  assert.equal(snap.actions.current?.actionId, 1, 'the first gesture still owns the one action slot');
  assert.equal(snap.intentEvents.pending?.actionId, pendingTicket, 'the deferred intent keeps its ticket');
  assert.equal(snap.intentEvents.dropped, 0, 'action-busy is a defer, never a drop');

  // Let the first action end, then the next boundary starts the deferred intent.
  for (clock = 520; clock <= 900; clock += 20) runtime.tick(clock);
  clock = 1000;
  runtime.speechClip('start', { index: 2, at: 1000 });
  snap = runtime.snapshot();
  assert.equal(snap.actions.current?.name, 'nod', 'the deferred intent started at the next sentence');
  assert.equal(snap.actions.current?.actionId, pendingTicket, 'it kept its staged ticket');
  assert.equal(snap.intentEvents.pending, null, 'nothing of this generation is left staged');
  assert.equal(snap.intentEvents.started, 2, 'both intents of the same generation ran');
  assert.equal(snap.intentEvents.generation, 1, 'no generation switch happened');

  const events = runtime.takeEvents();
  assert.equal(ofType(events, 'avatar.intent.trajectory.cleared').length, 0,
    'a same-generation handoff clears no trajectory');
  assert.equal(ofType(events, 'avatar.intent.dropped').length, 0,
    'the deferred intent was never dropped');
  const starts = ofType(events, 'avatar.action.start');
  assert.deepEqual(starts.map((entry) => entry.name), ['tilt', 'nod'], 'both handoffs ran in order');
  console.log(
    `[p139] sameGeneration generation=${snap.intentEvents.generation}`
    + ` deferredTicket=${pendingTicket} dropped=${snap.intentEvents.dropped}`
    + ` starts=${starts.map((entry) => `${entry.name}@${entry.startedAt}`).join(',')} cleared=0`,
  );
  runtime.dispose();
});

// ---------------------------------------------------------------------------------------------
// P-139 stage 4 — "why each motion happens": the conclusion mark and the confused phase
// ---------------------------------------------------------------------------------------------
test('12. markConclusion：一次更大更长的 nod，且不连续重复', async () => {
  const fake = createFakeTransport();
  let clock = 0;
  const runtime = await connectRuntime({
    transport: fake.transport,
    now: () => clock,
    config: headConfig({ seed: 31 }),
  });
  runtime.takeEvents();

  // Baseline: the same persona runs an ordinary nod through the public gesture entry.
  const plain = runtime.intent('nod', { at: 0 });
  assert.equal(plain.ok, true);
  assert.equal(plain.profile, null, 'a plain gesture carries no profile');
  assert.equal(plain.occasional, false);
  for (clock = 0; clock <= 900; clock += 20) runtime.tick(clock);

  clock = 1000;
  const conclusion = runtime.markConclusion('最终结论：先备份，再迁移。', { at: 1000 });
  assert.equal(conclusion.ok, true);
  assert.equal(conclusion.intent, 'nod', 'a conclusion is still the table-selected nod');
  assert.equal(conclusion.profile, 'conclusion');
  assert.equal(conclusion.released, true, 'no speech session → released immediately');
  for (clock = 1000; clock <= 2200; clock += 20) runtime.tick(clock);

  const events = runtime.takeEvents();
  const starts = ofType(events, 'avatar.intent.start');
  const conclusionGesture = starts.find((entry) => entry.profile === 'conclusion');
  const plainGesture = starts.find((entry) => entry.profile === null);
  assert.ok(plainGesture && conclusionGesture, 'both gestures were recorded');
  assert.equal(conclusionGesture.kind, 'nod', 'markConclusion never invents a new intent');
  assert.equal(conclusionGesture.occasional, true);
  // Slightly bigger and slightly longer than the ordinary nod of the same persona.
  assert.ok(conclusionGesture.amplitude > plainGesture.amplitude * 1.05,
    `conclusion amplitude ${conclusionGesture.amplitude.toFixed(3)} > plain ${plainGesture.amplitude.toFixed(3)}`);
  assert.ok(conclusionGesture.durationMs > plainGesture.durationMs,
    `conclusion duration ${conclusionGesture.durationMs}ms > plain ${plainGesture.durationMs}ms`);
  assert.ok(conclusionGesture.peakDegrees >= 12 && conclusionGesture.peakDegrees <= 14,
    `the conclusion nod reaches ${conclusionGesture.peakDegrees}° (12–14° band)`);
  const action = ofType(events, 'avatar.action.start').find((entry) => entry.actionId === conclusion.actionId);
  assert.ok(action, 'the staged conclusion ticket became an action');
  assert.equal(action.name, 'nod');
  assert.equal(runtime.snapshot().intentEvents.lastProfile, 'conclusion',
    'the released conclusion is recorded as the last profile');

  // Not back-to-back: a second mark is refused while the last released intent is a conclusion.
  const repeat = runtime.markConclusion('又一个结论', { at: 2400 });
  assert.equal(repeat.ok, false);
  assert.equal(repeat.reason, 'conclusion-repeat');
  // Any other released intent breaks the run, so a later conclusion is admissible again.
  runtime.intentEvent('thinking', { at: 2500 });
  for (clock = 2500; clock <= 4200; clock += 20) runtime.tick(clock);
  const again = runtime.markConclusion({ at: 4300 });
  assert.equal(again.ok, true);
  assert.notEqual(again.reason, 'conclusion-repeat');
  for (clock = 4320; clock <= 5200; clock += 20) runtime.tick(clock);
  const secondStarts = ofType(runtime.takeEvents(), 'avatar.intent.start')
    .filter((entry) => entry.profile === 'conclusion');
  assert.equal(secondStarts.length, 1, 'the admissible conclusion really ran');
  const snapshot = runtime.snapshot();
  assert.deepEqual(snapshot.intentEvents.conclusions, { marked: 2, deduped: 1 },
    'one mark was refused as a back-to-back repeat');
  console.log(
    `[p139] conclusion plain=${plainGesture.amplitude.toFixed(3)}/${plainGesture.durationMs}ms`
    + ` conclusion=${conclusionGesture.amplitude.toFixed(3)}/${conclusionGesture.durationMs}ms`
    + ` peak=${conclusionGesture.peakDegrees}° repeat=${repeat.reason}`
    + ` marked=${snapshot.intentEvents.conclusions.marked} deduped=${snapshot.intentEvents.conclusions.deduped}`,
  );
  runtime.dispose();
});

test('13. confused：温和歪头 + 眉毛写入，事件表只多一行', async () => {
  const fake = createFakeTransport();
  let clock = 0;
  const runtime = await connectRuntime({
    transport: fake.transport,
    now: () => clock,
    config: headConfig({
      seed: 3,
      inputs: {
        browL: { inputName: 'ParamBrowLY', min: -1, max: 1, injectable: true },
        browR: { inputName: 'ParamBrowRY', min: -1, max: 1, injectable: true },
      },
      channelMap: { browL: 'ParamBrowLY', browR: 'ParamBrowRY' },
    }),
  });
  const table = runtime.snapshot().intentEvents.table;
  assert.equal(table.confused, 'tilt', 'confused selects the tilt');
  for (const [event, intent] of Object.entries(DEFAULT_INTENT_TABLE)) {
    if (event === 'confused') continue;
    assert.equal(table[event], intent, `the stage-2 row "${event}" is unchanged`);
  }
  runtime.takeEvents();
  for (clock = 0; clock <= 200; clock += 20) {
    runtime.tick(clock);
    await flushMicrotasks();
  }

  clock = 300;
  const reported = runtime.intentEvent('confused', { at: 300 });
  assert.equal(reported.ok, true);
  assert.equal(reported.intent, 'tilt');
  assert.equal(reported.profile, 'confused');
  let browTargetPeak = 0;
  let tiltTargetPeak = 0;
  let tiltPosePeak = 0;
  for (clock = 300; clock <= 1400; clock += 20) {
    const pose = runtime.tick(clock);
    await flushMicrotasks();
    const adds = runtime.snapshot().intents.target ?? {};
    browTargetPeak = Math.max(browTargetPeak, Math.abs(adds.browL ?? 0), Math.abs(adds.browR ?? 0));
    tiltTargetPeak = Math.max(tiltTargetPeak, Math.abs(adds.headX ?? 0), Math.abs(adds.headZ ?? 0));
    tiltPosePeak = Math.max(tiltPosePeak, Math.abs(pose.headX), Math.abs(pose.headZ));
  }
  const gesture = ofType(runtime.takeEvents(), 'avatar.intent.start')
    .find((entry) => entry.profile === 'confused');
  assert.ok(gesture, 'the confused gesture started');
  assert.equal(gesture.kind, 'tilt');
  assert.ok(gesture.channels.includes('headX') && gesture.channels.includes('headZ'),
    'the tilt channels are unchanged');
  assert.ok(gesture.channels.includes('browL') && gesture.channels.includes('browR'),
    'the profile adds the two already-mapped brow channels');
  // Gentle: the brows move a little, the tilt stays well inside the 14° occasional ceiling.
  assert.ok(browTargetPeak > 0.1 && browTargetPeak <= 0.4 + 1e-9,
    `brow target peak ${browTargetPeak.toFixed(3)} is gentle (0.1..0.4)`);
  assert.ok(tiltTargetPeak <= 14 / 30 + 1e-9, `tilt target peak ${tiltTargetPeak.toFixed(3)} ≤ 14°`);
  assert.ok(tiltPosePeak * 30 <= 14 + 1e-6, `the posed tilt ${(tiltPosePeak * 30).toFixed(2)}° ≤ 14°`);
  assert.ok(gesture.peakDegrees <= 14, `peakDegrees ${gesture.peakDegrees} ≤ 14`);
  const browWrites = fake.writes
    .filter((entry) => entry.input === 'ParamBrowLY' || entry.input === 'ParamBrowRY');
  assert.ok(browWrites.some((entry) => Math.abs(entry.value) > 0.02 && Math.abs(entry.value) <= 0.4 + 1e-9),
    'a gentle brow value was really written');
  console.log(
    `[p139] confused intent=${gesture.kind} channels=${gesture.channels.join('|')}`
    + ` tiltTarget=${(tiltTargetPeak * 30).toFixed(2)}° browTarget=${browTargetPeak.toFixed(3)}`
    + ` browWrites=${browWrites.length} peak=${Math.max(...browWrites.map((entry) => Math.abs(entry.value))).toFixed(3)}`,
  );
  runtime.dispose();
});

// ---------------------------------------------------------------------------------------------
// Motion attribution — the counters are split, and the trace chains intent → action → final value.
//
// Correction the old inference missed: `speech.clip.timed = 0` does NOT prove the head intent failed.
// `speechClip('start')` releases a staged intent through `releaseIntent()` and only `intent.started`
// grows; `clips.timed` was always the OTHER path (a waiting idle candidate started at a clip start).
// The three tests below pin each counter to exactly one source.
// ---------------------------------------------------------------------------------------------
test('14. 计数分离：answer-start 在句首释放只增 intent.releasedAtClipStart', async () => {
  const fake = createFakeTransport();
  let clock = 0;
  const runtime = await connectRuntime({
    transport: fake.transport,
    now: () => clock,
    config: headConfig(), // idleActions: [] → no waiting candidate can inflate `candidate.*`
  });
  runtime.takeEvents();

  runtime.speechClip('start', { index: 0, at: 0 });
  const released = runtime.intentEvent('answer-start', { at: 0 });
  assert.equal(released.released, true, 'the head-window intent is released at the clip start');

  let snap = runtime.snapshot();
  assert.equal(snap.intentEvents.releasedAtClipStart, 1,
    'the clip-start release is counted in its own bucket');
  assert.equal(snap.intentEvents.releasedOther, 0, 'no other release path ran');
  assert.equal(snap.intentEvents.started, 1, 'the old aggregate still counts the intent');
  // The two counts are INDEPENDENT: the candidate bucket is untouched by an intent release.
  assert.equal(snap.speech.clip.candidate.timed, 0, 'candidate.timed did not move');
  assert.equal(snap.speech.clip.candidate.other, 0);
  assert.equal(snap.speech.clip.timed, 0, 'legacy timed is the candidate counter, not the intent counter');

  for (clock = 20; clock <= 800; clock += 20) {
    runtime.tick(clock);
    await flushMicrotasks();
  }
  const trace = ofType(runtime.takeEvents(), 'avatar.action.trace')
    .find((entry) => entry.actionId === released.actionId);
  assert.ok(trace, 'the ended action emitted exactly one trace');
  assert.equal(trace.intent, 'nod');
  assert.equal(trace.event, 'answer-start', 'the trace keeps the phase identity');
  assert.equal(trace.stagedAt, 0);
  assert.equal(trace.releasedBy, 'sentence-start');
  assert.equal(trace.releasedAt, 0);
  assert.equal(trace.suppressed, 'none');
  assert.ok(trace.channels.includes('headY'), 'the nod really wrote its pitch channel');
  console.log(
    `[trace] clipRelease intentRelease=${snap.intentEvents.releasedAtClipStart}`
    + ` other=${snap.intentEvents.releasedOther} candidate.timed=${snap.speech.clip.candidate.timed}`
    + ` legacyTimed=${snap.speech.clip.timed}`
    + ` trace=${trace.intent}/${trace.event}/${trace.releasedBy} final.headY=${trace.final.headY.toFixed(3)}`,
  );
  runtime.dispose();
});

test('15. 计数分离：待机候选在句首启动只增 candidate.timed，不动 intent.released*', async () => {
  const fake = createFakeTransport();
  let clock = 0;
  const runtime = await connectRuntime({
    transport: fake.transport,
    now: () => clock,
    config: headConfig({
      random: () => 0,
      // `sway` only needs headX, so it is a COMPLETE candidate the host would animate.
      idleActions: ['sway'],
      idleActionIntervalMs: 100,
      idleActionDedupeMs: 0,
      actionDurationMs: 600,
    }),
  });
  runtime.takeEvents();

  // A clip is playing, so the sampled candidate must WAIT for the next sentence boundary.
  runtime.speechClip('start', { index: 0, at: 0 });
  for (clock = 0; clock <= 200; clock += 20) {
    runtime.tick(clock);
    await flushMicrotasks();
  }
  assert.equal(runtime.snapshot().actions.waiting, 1, 'one candidate is held for the boundary');

  clock = 200;
  const boundary = runtime.speechClip('start', { index: 1, at: 200 });
  assert.equal(typeof boundary.actionId, 'number', 'the boundary started the held candidate');
  let snap = runtime.snapshot();
  assert.equal(snap.speech.clip.candidate.timed, 1, 'the candidate-at-clip-start bucket grew');
  assert.equal(snap.speech.clip.candidate.other, 0);
  assert.equal(snap.speech.clip.timed, 1, 'the legacy field keeps the same candidate meaning');
  assert.equal(snap.intentEvents.releasedAtClipStart, 0, 'no staged intent was released');
  assert.equal(snap.intentEvents.releasedOther, 0);

  // Let that action end, end the session, then let a candidate start on a NORMAL tick.
  for (clock = 220; clock <= 1000; clock += 20) {
    runtime.tick(clock);
    await flushMicrotasks();
  }
  runtime.speechClip('end', { index: 1, at: 1000 });
  runtime.speechEnd({ at: 1000 });
  for (clock = 1020; clock <= 1200; clock += 20) {
    runtime.tick(clock);
    await flushMicrotasks();
  }
  snap = runtime.snapshot();
  assert.equal(snap.speech.clip.candidate.timed, 1, 'a normal start is not counted as timed');
  assert.equal(snap.speech.clip.candidate.other, 1, 'the normal candidate start has its own bucket');
  assert.equal(snap.intentEvents.releasedAtClipStart, 0);
  assert.equal(snap.intentEvents.releasedOther, 0);
  console.log(
    `[trace] clipCandidate candidate.timed=${snap.speech.clip.candidate.timed}`
    + ` candidate.other=${snap.speech.clip.candidate.other} legacyTimed=${snap.speech.clip.timed}`
    + ` intentRelease=${snap.intentEvents.releasedAtClipStart}/${snap.intentEvents.releasedOther}`,
  );
  runtime.dispose();
});

test('16. action-busy defer：释放路径记 releasedOther，trace 的 suppressed=action-busy', async () => {
  const fake = createFakeTransport();
  let clock = 0;
  const runtime = await connectRuntime({
    transport: fake.transport,
    now: () => clock,
    config: headConfig({
      random: () => 0,
      // A long first gesture, so the next sentence boundary arrives while it still runs.
      style: { nodDurationMs: 900, tempo: 0.6 },
      intentTable: { 'answer-start': 'nod', thinking: 'tilt' },
    }),
  });
  runtime.takeEvents();

  clock = 0;
  runtime.speechClip('start', { index: 0, at: 0 });
  const first = runtime.intentEvent('answer-start', { at: 0 });
  assert.equal(first.released, true);
  for (clock = 20; clock <= 300; clock += 20) {
    runtime.tick(clock);
    await flushMicrotasks();
  }
  clock = 300;
  const second = runtime.intentEvent('thinking', { at: 300 });
  assert.equal(second.released, false, 'a mid-sentence phase is staged');
  const ticket = runtime.snapshot().intentEvents.pending?.actionId;
  assert.equal(typeof ticket, 'number');

  // The next sentence starts while the first action still owns the slot: DEFER, do not drop.
  clock = 400;
  runtime.speechClip('end', { index: 0, at: 400 });
  clock = 500;
  runtime.speechClip('start', { index: 1, at: 500 });
  let snap = runtime.snapshot();
  assert.equal(snap.actions.current?.actionId, first.actionId, 'the first gesture still runs');
  assert.equal(snap.intentEvents.pending?.actionId, ticket, 'the deferred intent keeps its ticket');
  assert.equal(snap.intentEvents.releasedOther, 1, 'the deferral is counted as a non-clip-start release path');
  assert.equal(snap.intentEvents.releasedAtClipStart, 1, 'the first answer-start was the clip-start release');
  assert.equal(snap.intentEvents.dropped, 0, 'a defer is never a drop');

  // Let the first action end, then release the deferred intent at the following boundary.
  clock = 520;
  while (runtime.snapshot().actions.current !== null && clock < 4000) {
    runtime.tick(clock);
    await flushMicrotasks();
    clock += 20;
  }
  const releaseAt = clock + 100;
  runtime.speechClip('start', { index: 2, at: releaseAt });
  snap = runtime.snapshot();
  assert.equal(snap.actions.current?.actionId, ticket, 'the deferred ticket became the action');
  assert.equal(snap.intentEvents.releasedAtClipStart, 2, 'the eventual release is a clip-start release');
  clock = releaseAt + 20;
  while (runtime.snapshot().actions.current !== null && clock < 8000) {
    runtime.tick(clock);
    await flushMicrotasks();
    clock += 20;
  }

  const trace = ofType(runtime.takeEvents(), 'avatar.action.trace')
    .find((entry) => entry.actionId === ticket);
  assert.ok(trace, 'the deferred action emitted its trace when it ended');
  assert.equal(trace.intent, 'tilt');
  assert.equal(trace.event, 'thinking', 'the trace still names the staged phase');
  assert.equal(trace.stagedAt, 300, 'staging time is carried, not the release time');
  assert.equal(trace.releasedBy, 'sentence-start');
  assert.equal(trace.releasedAt, releaseAt);
  assert.equal(trace.suppressed, 'action-busy', 'the trace names the gate that delayed it');
  assert.ok(trace.channels.includes('headX') && trace.channels.includes('headZ'),
    'the tilt wrote its own channels after the defer');
  const recent = runtime.snapshot().motion.actionTrace;
  assert.ok(recent.length >= 2 && recent.length <= 5, `status keeps up to 5 traces (${recent.length})`);
  assert.ok(recent.some((entry) => entry.actionId === ticket && entry.suppressed === 'action-busy'),
    'the read-only buffer exposes the same record');
  console.log(
    `[trace] actionBusy deferred=${ticket} releasedAt=${releaseAt}`
    + ` releasedOther=${snap.intentEvents.releasedOther} releasedAtClipStart=${snap.intentEvents.releasedAtClipStart}`
    + ` trace=${trace.intent}/${trace.releasedBy}/${trace.suppressed}`
    + ` final.headX=${trace.final.headX.toFixed(3)} recent=${recent.length}`,
  );
  runtime.dispose();
});

// ---------------------------------------------------------------------------------------------
// Stage 5 — the intent amplitudes are VISIBLE on the real model, and the speaking micro-motion is
// an expression layer (not one fixed action per sentence).
// ---------------------------------------------------------------------------------------------

/**
 * The quiet persona measured on the real machine (style amplitude 0.2 / nodAmplitude 0.2). Before
 * the visible floor this produced a tilt with amplitude 0.0116 ≈ 0.35°, which is invisible.
 */
const QUIET_PERSONA = Object.freeze({
  amplitude: 0.2, tempo: 0.9, nodAmplitude: 0.2, expressiveness: 0.3, tiltChance: 0, nodDurationMs: 500,
});

/** Three verified head axes + the two brow channels the confused profile may use; no idle sway. */
const visibleConfig = (extra = {}) => ({
  autoTickMs: 0,
  flushIntervalMs: 1,
  idleActions: [],
  idleSwayScale: 0,
  seed: 3,
  style: QUIET_PERSONA,
  idleParams: {
    headX: { inputName: 'FaceAngleX', min: -30, max: 30 },
    headY: { inputName: 'FaceAngleY', min: -30, max: 30 },
    headZ: { inputName: 'FaceAngleZ', min: -30, max: 30 },
  },
  inputs: {
    browL: { inputName: 'ParamBrowLY', min: -1, max: 1, injectable: true },
    browR: { inputName: 'ParamBrowRY', min: -1, max: 1, injectable: true },
  },
  channelMap: { browL: 'ParamBrowLY', browR: 'ParamBrowRY' },
  ...extra,
});

/** Run one released/started intent on the quiet persona and collect its real writes + trace. */
async function runVisibleIntent(trigger, eventText = '') {
  const fake = createFakeTransport();
  let clock = 0;
  const runtime = await connectRuntime({
    transport: fake.transport,
    now: () => clock,
    config: visibleConfig(),
  });
  runtime.takeEvents();
  for (clock = 0; clock <= 200; clock += 20) {
    runtime.tick(clock);
    await flushMicrotasks();
  }
  clock = 300;
  const reported = trigger === 'conclusion'
    ? runtime.markConclusion(eventText, { at: clock })
    : runtime.intentEvent(trigger, { at: clock });
  assert.equal(reported.ok, true, `${trigger} is accepted`);
  const posePeak = { headX: 0, headY: 0, headZ: 0 };
  for (clock = 300; clock <= 4000; clock += 20) {
    const pose = runtime.tick(clock);
    for (const channel of ['headX', 'headY', 'headZ']) {
      posePeak[channel] = Math.max(posePeak[channel], Math.abs(pose[channel]));
    }
    await flushMicrotasks();
  }
  const events = runtime.takeEvents();
  const trace = ofType(events, 'avatar.action.trace').find((entry) => entry.channels.length > 0);
  const start = ofType(events, 'avatar.intent.start')[0];
  const action = ofType(events, 'avatar.action.start')[0];
  const snapshot = runtime.snapshot();
  runtime.dispose();
  return { trace, start, action, snapshot, posePeak, reported };
}

test('17. 意图幅度可见：answer-start / confused / conclusion 的真实写入达到可见语义', async () => {
  const toDegrees = (semantic) => Math.round(semantic * OCCASIONAL_ACTION.DEGREES_PER_POSE_UNIT * 100) / 100;

  // 1. answer-start → a nod on headY, visible (≈4–6°) and landed in the B window.
  const answer = await runVisibleIntent('answer-start', '先备份，再迁移。');
  assert.ok(answer.trace, 'answer-start emitted an action trace');
  assert.ok(answer.trace.final.headY >= 0.12,
    `answer-start final headY ${answer.trace.final.headY.toFixed(4)} ≥ 0.12 (${toDegrees(answer.trace.final.headY)}°)`);
  assert.ok(toDegrees(answer.trace.final.headY) >= 3.6,
    `answer-start visible in degrees (${toDegrees(answer.trace.final.headY)}° ≥ 3.6°)`);
  assert.ok(answer.start.peakDegrees >= 4 && answer.start.peakDegrees <= 6,
    `answer-start target ${answer.start.peakDegrees}° is in the 4–6° band`);
  const answerShort = answer.snapshot.motion.posture.lastTransition;
  assert.equal(answerShort.kind, 'short', 'answer-start used the B short-transition');
  assert.ok(answerShort.durationMs >= 800 && answerShort.durationMs <= 1200,
    `answer-start transition ${answerShort.durationMs} ms is 0.8–1.2 s`);

  // 2. confused → a tilt whose headX really reaches 8–10°, roll capped by C, brows gentle.
  const confused = await runVisibleIntent('confused');
  assert.ok(confused.trace, 'confused emitted an action trace');
  assert.ok(confused.trace.final.headX >= 0.27,
    `confused final headX ${confused.trace.final.headX.toFixed(4)} ≥ 0.27 (${toDegrees(confused.trace.final.headX)}°)`);
  const confusedDegrees = toDegrees(confused.trace.final.headX);
  assert.ok(confusedDegrees >= 8 && confusedDegrees <= 10,
    `confused headX ${confusedDegrees}° is in the 8–10° band`);
  assert.ok(Math.abs(confused.trace.final.headZ ?? 0) <= OCCASIONAL_ACTION.MAX_DEGREES
    / OCCASIONAL_ACTION.DEGREES_PER_POSE_UNIT + 1e-9,
  `confused roll ${toDegrees(confused.trace.final.headZ ?? 0)}° stays inside the C ceiling`);
  assert.ok(confused.start.peakDegrees <= OCCASIONAL_ACTION.MAX_DEGREES,
    `confused recorded peak ${confused.start.peakDegrees}° ≤ ${OCCASIONAL_ACTION.MAX_DEGREES}°`);
  assert.ok(confused.start.channels.includes('browL') && confused.start.channels.includes('browR'),
    'the confused profile still writes the two verified brow channels');
  const browPeak = Math.max(
    Math.abs(confused.trace.final.browL ?? 0),
    Math.abs(confused.trace.final.browR ?? 0),
  );
  assert.ok(browPeak > 0.02 && browPeak <= OCCASIONAL_ACTION.BROW_MAX + 1e-9,
    `confused brows stay gentle (${browPeak.toFixed(3)} in 0.02..${OCCASIONAL_ACTION.BROW_MAX})`);

  // 3. conclusion → a marked nod on headY, 6–8°, landed in the B window.
  const conclusion = await runVisibleIntent('conclusion', '最终结论：先备份，再迁移。');
  assert.ok(conclusion.trace, 'conclusion emitted an action trace');
  assert.ok(conclusion.trace.final.headY >= 0.2,
    `conclusion final headY ${conclusion.trace.final.headY.toFixed(4)} ≥ 0.2 (${toDegrees(conclusion.trace.final.headY)}°)`);
  const conclusionDegrees = toDegrees(conclusion.trace.final.headY);
  assert.ok(conclusionDegrees >= 6 && conclusionDegrees <= 8,
    `conclusion headY ${conclusionDegrees}° is in the 6–8° band`);
  assert.ok(conclusion.start.peakDegrees >= 6 && conclusion.start.peakDegrees <= 8,
    `conclusion target ${conclusion.start.peakDegrees}° is in the 6–8° band`);
  const conclusionShort = conclusion.snapshot.motion.posture.lastTransition;
  assert.equal(conclusionShort.kind, 'short');
  assert.ok(conclusionShort.durationMs >= 800 && conclusionShort.durationMs <= 1200,
    `conclusion transition ${conclusionShort.durationMs} ms is 0.8–1.2 s`);

  console.log(
    `[visible] quietPersona(amp=0.2,nod=0.2) answerFinal=${answer.trace.final.headY.toFixed(4)}`
    + `/${toDegrees(answer.trace.final.headY)}° target=${answer.start.peakDegrees}° short=${answerShort.durationMs}ms`
    + ` confusedHeadX=${confused.trace.final.headX.toFixed(4)}/${confusedDegrees}°`
    + ` roll=${toDegrees(confused.trace.final.headZ ?? 0)}° brow=${browPeak.toFixed(3)}`
    + ` conclusion=${conclusion.trace.final.headY.toFixed(4)}/${conclusionDegrees}°`
    + ` target=${conclusion.start.peakDegrees}° short=${conclusionShort.durationMs}ms`,
  );
});

test('18. 说话微动在意图动作期间暂停，结束后恢复（headY 不写 headX/gaze/body/breath）', async () => {
  const fake = createFakeTransport();
  let clock = 0;
  const runtime = await connectRuntime({
    transport: fake.transport,
    now: () => clock,
    config: visibleConfig({ style: { amplitude: 0.8, tempo: 1, nodAmplitude: 0.8 } }),
  });
  runtime.takeEvents();
  fake.writes.length = 0; // connect probes are not motion frames
  const spoken = await runtime.speak({
    levels: Array.from({ length: 40 }, () => 0.5), stepMs: 100, durationMs: 20_000, startedAt: 0,
  });
  assert.equal(spoken.ok, true, 'the speech envelope is active');

  // Find a real micro-motion peak first: pausing at a peak makes "paused" observable.
  let triggerAt = null;
  let beforePeak = 0;
  for (clock = 0; clock <= 6000; clock += 1000 / 30) {
    const pose = runtime.tick(clock);
    beforePeak = Math.max(beforePeak, Math.abs(pose.headY));
    await flushMicrotasks();
    if (triggerAt === null && clock >= 3000 && Math.abs(pose.headY) >= 0.04) {
      triggerAt = clock;
      break;
    }
  }
  assert.ok(triggerAt !== null, `a speaking micro-motion peak was found (${beforePeak.toFixed(3)})`);
  assert.ok(beforePeak > 0.03, `the micro-motion is really moving before the gesture (${beforePeak.toFixed(3)})`);
  // The micro-motion wrote NON-ZERO values only on the verified pitch channel: headX/headZ were
  // merely mapped idle rows written as 0, never moved by the sway.
  const movedInputs = new Set(fake.writes
    .filter((entry) => Math.abs(entry.value) > 1e-9)
    .map((entry) => entry.input));
  assert.deepEqual([...movedInputs], ['FaceAngleY'],
    `the speaking micro-motion only moves headY (${[...movedInputs].join(',')})`);

  // A tilt owns headX/headZ, so headY stays the pure micro-motion channel during the gesture.
  const started = runtime.intent('tilt', { at: triggerAt });
  assert.equal(started.ok, true, 'the tilt starts');
  const durationMs = started.durationMs;
  const paused = { from: triggerAt + 400, to: triggerAt + durationMs, peak: 0 };
  const resumed = { from: triggerAt + durationMs + 400, to: triggerAt + durationMs + 2400, peak: 0 };
  for (clock = triggerAt + 20; clock <= resumed.to; clock += 1000 / 30) {
    const pose = runtime.tick(clock);
    if (clock >= paused.from && clock < paused.to) {
      paused.peak = Math.max(paused.peak, Math.abs(pose.headY));
    }
    if (clock >= resumed.from && clock <= resumed.to) {
      resumed.peak = Math.max(resumed.peak, Math.abs(pose.headY));
    }
    await flushMicrotasks();
  }
  assert.ok(paused.peak < 0.012,
    `headY micro-motion is paused during the gesture (${(paused.peak * 30).toFixed(2)}° < 0.36°)`);
  assert.ok(resumed.peak > 0.03,
    `headY micro-motion resumes after the gesture (${(resumed.peak * 30).toFixed(2)}° > 0.9°)`);
  console.log(
    `[visible] microPause before=${(beforePeak * 30).toFixed(2)}° during=${(paused.peak * 30).toFixed(2)}°`
    + ` after=${(resumed.peak * 30).toFixed(2)}° tilt=${durationMs}ms`,
  );
  runtime.dispose();
});
