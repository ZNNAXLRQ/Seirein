/**
 * answer-start neutral presets — runtime support for the new `head-center-lite` operation.
 *
 * The hand-authored library in `src/host/avatar/presets/` is READ-ONLY here. The user appended
 * three recipe families (`answer-nod` / `answer-turn` / `answer-center-lite` × 4 rhythms); these
 * tests consume them exactly as written and only assert the runtime/selector contract:
 *
 *   1) the executor's operation table knew `head-center-lite`, and executing it writes headX ONLY
 *      (never headZ, not even prepared/attempted/committed evidence);
 *   2) verified=[headX] exposes the new answer-start candidates (answer-turn / answer-center-lite);
 *   3) verified=[headY] selects answer-nod;
 *   4) verified=[headZ] hard-filters the new headX/headY recipes (no silent downgrade) while the
 *      existing answer-tilt still works;
 *   5) the user's 324 presets / 81 recipes / 12 answer-start entries are read with the right requires/state.
 *
 * Run: node --test test/answer-start-neutral.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createBehaviorRuntime, PRESET_OPERATION_PROFILE } from '../src/host/avatar/motion-controller.js';
import { createAvatarRuntime } from '../src/host/avatar/avatarRuntime.js';
import { createPresetSelector } from '../src/host/avatar/preset-selector.js';
import {
  OPERATIONS,
  PRESETS,
  RECIPES,
  getPreset,
  queryPresets,
} from '../src/host/avatar/presets/index.js';

const CHANNELS = Object.freeze([
  'headX', 'headY', 'headZ', 'gazeX', 'gazeY', 'eyeOpenL', 'eyeOpenR',
  'browL', 'browR', 'bodyX', 'bodyY', 'bodyZ', 'breath',
]);

/** The 12 appended presets: three recipes, four rhythms each. */
const NEW_RECIPES = Object.freeze({
  'answer-nod': Object.freeze({
    family: 'speech-beat', operations: ['nod'], requires: ['headY'],
  }),
  'answer-turn': Object.freeze({
    family: 'posture', operations: ['head-turn'], requires: ['headX'],
  }),
  'answer-center-lite': Object.freeze({
    family: 'settle', operations: ['head-center-lite'], requires: ['headX'],
  }),
});
const NEW_RECIPE_IDS = Object.freeze(Object.keys(NEW_RECIPES));
const answerStart = (verifiedChannels) => Object.freeze({
  state: 'speaking', event: 'answer-start', verifiedChannels,
});

function makeRuntime() {
  return createBehaviorRuntime({
    config: {
      seed: 11,
      presetExecution: false,
      presetTargetVerified: true,
      presetChannels: [...CHANNELS],
      presetDebugEvents: true,
    },
  });
}

/** Narrowing to one recipe still shares the hold option, so try several reproducible seeds. */
function pickSelection(runtime, context) {
  for (let seed = 0; seed < 96; seed += 1) {
    const selection = runtime.selectPreset({ ...context, seed });
    if (selection.kind === 'preset') return selection;
  }
  return null;
}

/** Start one preset through the real host runtime; a legal hold is retried with another seed. */
function startPreset(runtime, context) {
  for (let seed = 0; seed < 96; seed += 1) {
    const drawn = runtime.preset({ ...context, seed });
    if (drawn.started === true) return drawn;
  }
  return null;
}

function presetSnapshot(runtime) {
  return runtime.snapshot().motion.presets;
}

// ---------------------------------------------------------------------------------------------
// 1. Operation table + execution: headX only, headZ is never written
// ---------------------------------------------------------------------------------------------
test('1. 操作表含 head-center-lite；执行只写 headX，从不触碰 headZ', async () => {
  // The executor's own table: same amplitude/duration class as head-center, headX-only semantics.
  assert.equal(Object.prototype.hasOwnProperty.call(PRESET_OPERATION_PROFILE, 'head-center-lite'), true);
  const profile = PRESET_OPERATION_PROFILE['head-center-lite'];
  assert.equal(profile.kind, 'center');
  assert.equal(profile.amount, 0);
  assert.equal(profile.active, 'TURN_ACTIVE_MS');
  assert.deepEqual(OPERATIONS['head-center-lite'], ['headX'], 'the library declares yaw only');
  const recipe = RECIPES.find((entry) => entry.id === 'answer-center-lite');
  assert.deepEqual(recipe.operations, ['head-center-lite']);
  assert.deepEqual(recipe.requires, ['headX']);
  assert.equal(recipe.requires.includes('headZ'), false);

  // Even when headZ IS verified, the operation must not add it: headX is the whole definition.
  const full = makeRuntime();
  const onlyLite = pickSelection(full, {
    state: 'speaking', event: 'answer-start', verifiedChannels: [...CHANNELS],
    recipe: 'answer-center-lite',
  });
  assert.ok(onlyLite !== null);
  const fullStarted = full.startPreset(onlyLite, { at: 0 });
  assert.equal(fullStarted.started, true);
  assert.deepEqual(fullStarted.channels, ['headX'], 'headZ is never added, even when verified');

  // Real host runtime: a verified answer-turn first moves headX off the natural baseline, then the
  // lite settle returns it. Every preset row (prepared/attempted/committed) must stay headX-only.
  let clock = 0;
  const transport = {
    connect: async () => {},
    disconnect: async () => {},
    write: async () => ({ ok: true }),
    writeMotion: async () => ({ ok: true }),
  };
  const runtime = createAvatarRuntime({
    transport,
    now: () => clock,
    config: {
      seed: 11,
      autoTickMs: 0,
      flushIntervalMs: 1,
      idleActions: [],
      idleSwayScale: 0,
      motionWrites: true,
      motionOutputHz: 30,
      presetExecution: false,
      presetDebugEvents: true,
    },
  });
  assert.equal((await runtime.connect()).ok, true);
  const rows = ['headX', 'headY', 'headZ', 'gazeX', 'gazeY', 'eyeOpenL', 'eyeOpenR', 'browL', 'browR']
    .map((channel) => ({ channel, inputName: `P_${channel}`, injectable: true, verified: true }));
  await runtime.setChannelMappings(rows, { channelMap: {} });
  const tick = async (at) => {
    clock = at;
    runtime.tick(at);
    await new Promise((resolve) => setImmediate(resolve));
  };

  await tick(0);
  const turn = startPreset(runtime, {
    ...answerStart(['headX']), recipe: 'answer-turn', at: 0,
  });
  assert.ok(turn !== null, 'answer-turn must start on a yaw-only model');
  assert.deepEqual(turn.channels, ['headX']);
  for (let at = 33; at <= 396; at += 33) await tick(at);
  runtime.cancelPreset({ fadeMs: 0, at: 396 });
  await tick(429);
  runtime.takeEvents();

  const center = startPreset(runtime, {
    ...answerStart(['headX']), recipe: 'answer-center-lite', at: 429,
  });
  assert.ok(center !== null, 'answer-center-lite must start on a yaw-only model');
  assert.deepEqual(center.operations, ['head-center-lite']);
  assert.deepEqual(center.channels, ['headX']);
  assert.deepEqual(center.stages.map((stage) => stage.channels), [['headX']]);
  for (let at = 462; at <= 2400; at += 33) await tick(at);

  const events = runtime.takeEvents();
  // Transport acknowledgement is the strongest "really sent" evidence: the preset rows the sender
  // handed over are headX only, and no frame of this action carries headZ.
  const commits = events.filter((event) => (
    event.type === 'avatar.preset.commit' && event.presetId === center.presetId
  ));
  assert.ok(commits.length >= 1, 'the preset rows were acknowledged by the transport');
  for (const commit of commits) {
    assert.deepEqual(commit.channels, ['headX']);
    assert.ok(commit.committed.every((channel) => channel === 'headX'));
    assert.equal(Object.keys(commit.lastValue).includes('headZ'), false);
  }

  const trace = presetSnapshot(runtime).lastTrace;
  assert.equal(trace.selection.presetId, center.presetId);
  assert.equal(trace.selection.recipe, 'answer-center-lite');
  assert.deepEqual(trace.output.stages.map((stage) => stage.op), ['head-center-lite']);
  assert.deepEqual(trace.output.stages[0].channels, ['headX']);
  assert.deepEqual(trace.output.channels, ['headX']);
  for (const phase of ['computed', 'prepared', 'attempted', 'committed']) {
    assert.equal(Object.keys(trace.output[phase]).includes('headZ'), false,
      `${phase} evidence must not contain headZ`);
  }
  assert.ok(trace.output.samples.every((sample) => (
    Object.keys(sample.channels).every((channel) => channel === 'headX')
  )), 'every sampled write is headX');
});

// ---------------------------------------------------------------------------------------------
// 2. verified = [headX]
// ---------------------------------------------------------------------------------------------
test('2. verified=[headX]：answer-start 候选由 answer-turn / answer-center-lite 提供', () => {
  const candidates = queryPresets(answerStart(['headX']));
  assert.equal(candidates.length, 8, 'two recipes × four rhythms');
  assert.deepEqual(
    [...new Set(candidates.map((preset) => preset.recipeId))].sort(),
    ['answer-center-lite', 'answer-turn'],
  );
  assert.ok(candidates.every((preset) => (
    preset.requires.length === 1 && preset.requires[0] === 'headX'
    && preset.requires.includes('headZ') === false
    && preset.requiresTarget === false && preset.requiresDirection === false
  )));

  const runtime = makeRuntime();
  const drawn = pickSelection(runtime, answerStart(['headX']));
  assert.ok(drawn !== null, 'a yaw-only capability must still select an answer-start preset');
  assert.ok(['answer-turn', 'answer-center-lite'].includes(drawn.recipe));
  assert.deepEqual(drawn.effectiveRequires, ['headX']);
  assert.deepEqual(drawn.droppedChannels, []);
  const started = runtime.startPreset(drawn, { at: 0 });
  assert.equal(started.started, true);
  assert.deepEqual(started.channels, ['headX']);

  // Both recipes are really reachable through the selector (not just present in the catalog):
  // over a deterministic seed sweep the same context draws answer-turn AND answer-center-lite.
  const sweep = makeRuntime();
  const drawnRecipes = new Set();
  for (let seed = 0; seed < 32; seed += 1) {
    const selection = sweep.selectPreset({ ...answerStart(['headX']), seed });
    if (selection.kind === 'preset') drawnRecipes.add(selection.recipe);
  }
  assert.deepEqual([...drawnRecipes].sort(), ['answer-center-lite', 'answer-turn']);
});

// ---------------------------------------------------------------------------------------------
// 3. verified = [headY]
// ---------------------------------------------------------------------------------------------
test('3. verified=[headY]：answer-nod 可被选中（仅 headY）', () => {
  const candidates = queryPresets(answerStart(['headY']));
  assert.equal(candidates.length, 4);
  assert.ok(candidates.every((preset) => (
    preset.recipeId === 'answer-nod'
    && preset.family === 'speech-beat'
    && preset.semantic === 'neutral'
    && preset.requires.includes('headZ') === false
  )));

  const runtime = makeRuntime();
  const drawn = pickSelection(runtime, answerStart(['headY']));
  assert.ok(drawn !== null);
  assert.equal(drawn.recipe, 'answer-nod');
  assert.deepEqual(drawn.operations, ['nod']);
  assert.deepEqual(drawn.effectiveRequires, ['headY']);
  const started = runtime.startPreset(drawn, { at: 0 });
  assert.equal(started.started, true);
  assert.deepEqual(started.channels, ['headY']);
});

// ---------------------------------------------------------------------------------------------
// 4. verified = [headZ] only: hard filter, never a downgrade
// ---------------------------------------------------------------------------------------------
test('4. verified=[headZ]：新的中性配方不可选（能力硬过滤），原有 answer-tilt 仍可选', () => {
  const candidates = queryPresets(answerStart(['headZ']));
  assert.equal(candidates.length, 4);
  assert.ok(candidates.every((preset) => preset.recipeId === 'answer-tilt'));
  assert.ok(candidates.every((preset) => preset.requires.includes('headZ')));

  const runtime = makeRuntime();
  for (const recipe of NEW_RECIPE_IDS) {
    const held = runtime.selectPreset({
      ...answerStart(['headZ']), recipe, seed: 0, now: 1000,
    });
    assert.equal(held.kind, 'hold', `${recipe} must not execute on a roll-only model`);
    assert.ok(held.reasons.includes('no-candidates'), `${recipe}: ${held.reasons.join(',')}`);
    assert.equal(held.reasons.some((reason) => String(reason).includes('headZ')), false);
  }

  // A forged/stale selection cannot silently downgrade to headZ either: the executor drops the
  // unavailable operation, records the explicit cause and starts nothing.
  runtime.takeEvents();
  const forged = {
    kind: 'preset', presetId: 'answer-center-lite.flow', family: 'settle',
    recipe: 'answer-center-lite', variant: 'flow',
    operations: ['head-center-lite'], requires: ['headX'], effectiveRequires: ['headX'],
    requiresTarget: false, requiresDirection: false, droppedChannels: [],
    verifiedChannels: ['headZ'], reasons: [],
  };
  const refused = runtime.startPreset(forged, { at: 2000 });
  assert.equal(refused.started, false);
  assert.equal(refused.kind, 'hold');
  assert.equal(refused.reason, 'no-executable-operations');
  assert.ok(refused.selection.reasons.includes('no-executable-operations'));
  assert.equal(presetSnapshot(runtime).active.length, 0, 'a refused operation starts nothing');
  const refusedEvent = runtime.takeEvents().find((event) => event.type === 'avatar.preset.skip');
  assert.ok(refusedEvent, 'the refused operation is recorded');
  assert.equal(refusedEvent.reason, 'channel-unverified');

  const tilt = pickSelection(runtime, answerStart(['headZ']));
  assert.ok(tilt !== null, 'the existing answer-tilt stays available');
  assert.equal(tilt.recipe, 'answer-tilt');
  assert.deepEqual(tilt.effectiveRequires, ['headZ']);
  const started = runtime.startPreset(tilt, { at: 0 });
  assert.equal(started.started, true);
  assert.deepEqual(started.channels, ['headZ']);
});

// ---------------------------------------------------------------------------------------------
// 5. The user's appended library is read completely and correctly
// ---------------------------------------------------------------------------------------------
test('5. 预设总数 324；12 条 answer-start 新 recipe 的 requires / 状态 / 变体全部正确读取', () => {
  assert.equal(PRESETS.length, 324);
  assert.equal(RECIPES.length, 81);

  let newPresets = 0;
  for (const [recipeId, expected] of Object.entries(NEW_RECIPES)) {
    const recipe = RECIPES.find((entry) => entry.id === recipeId);
    assert.ok(recipe !== undefined, `${recipeId} must be part of the read-only library`);
    assert.equal(recipe.family, expected.family);
    assert.deepEqual(recipe.states, ['speaking']);
    assert.deepEqual(recipe.events, ['answer-start']);
    assert.equal(recipe.semantic, 'neutral');
    assert.deepEqual(recipe.operations, expected.operations);
    assert.deepEqual(recipe.requires, expected.requires);
    assert.equal(recipe.requiresTarget, false);
    assert.equal(recipe.requiresDirection, false);
    assert.equal(recipe.requires.includes('headZ'), false);

    const entries = PRESETS.filter((preset) => preset.recipeId === recipeId);
    assert.equal(entries.length, 4, `${recipeId}: four rhythms`);
    assert.deepEqual(
      entries.map((preset) => preset.id).sort(),
      ['flow', 'linger', 'pause', 'spaced'].map((variant) => `${recipeId}.${variant}`),
    );
    for (const preset of entries) {
      assert.deepEqual(preset.states, ['speaking']);
      assert.deepEqual(preset.events, ['answer-start']);
      assert.deepEqual(preset.requires, expected.requires);
      assert.equal(preset.requiresTarget, false);
      assert.equal(preset.requiresDirection, false);
    }
    newPresets += entries.length;
  }
  assert.equal(newPresets, 12);
  // The 12 answer-start presets are the append block immediately before the newest idle-sway
  // append; every pre-existing ordinal/id is still untouched.
  assert.ok(PRESETS.slice(-16, -4).every((preset) => NEW_RECIPE_IDS.includes(preset.recipeId)));
  assert.ok(PRESETS.slice(-4).every((preset) => preset.recipeId === 'idle-sway'),
    'idle-sway is the newest append');
  assert.deepEqual(getPreset('answer-center-lite.flow').operations, ['head-center-lite']);

  // The selector validates the whole catalog at construction (a malformed recipe throws).
  const selector = createPresetSelector();
  assert.equal(selector.stats().presets, 324);
  assert.equal(selector.stats().recipes, 81);
});
