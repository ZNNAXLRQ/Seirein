/**
 * preset-idle-diversity — idle preset quality acceptance for this batch.
 *
 * Run: node --test test/preset-idle-diversity.mjs
 *
 * A. recipe-level anti-repeat (same recipe, any timing variant) + legacy memory completion
 * B. posture-aware settle gate: near-baseline hysteresis, posture-held, explicit recenter/answer-end
 * C. tired coverage: neutral posture/attention recipes, native-only recipes still not executable
 * D. semantic/idle separate clocks (2 s quiet window), without touching arbitration
 * E. blink layers are reported, never counted as idle diversity
 *
 * Every draw is seeded. The printed lines are deliberately recomputable numbers for the report.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { PRESETS, OPERATIONS } from '../src/host/avatar/presets/index.js';
import { createPresetSelector } from '../src/host/avatar/preset-selector.js';
import { createBehaviorRuntime } from '../src/host/avatar/motion-controller.js';

const ALL_CHANNELS = Object.freeze([
  'headX', 'headY', 'headZ', 'gazeX', 'gazeY', 'eyeOpenL', 'eyeOpenR',
  'browL', 'browR', 'bodyX', 'bodyY', 'bodyZ', 'breath',
]);
const NATIVE_CHANNELS = Object.freeze(['bodyX', 'bodyY', 'bodyZ', 'breath']);
/** What the executor actually may drive after `presetContext()` strips VTS-native channels. */
const EXECUTABLE_CHANNELS = Object.freeze(ALL_CHANNELS.filter(channel => !NATIVE_CHANNELS.includes(channel)));
const FULL_SEMANTIC_CHANNELS = Object.freeze([...new Set(Object.values(OPERATIONS).flat())]);

const idle = (over = {}) => ({
  state: 'idle', event: 'idle', verifiedChannels: EXECUTABLE_CHANNELS, ...over,
});
const seedAt = index => (0x9e3779b9 + index * 2654435761) >>> 0;

function makeRuntime(overrides = {}) {
  return createBehaviorRuntime({
    config: {
      seed: 17,
      presetExecution: true,
      presetTargetVerified: true,
      presetChannels: [...ALL_CHANNELS],
      presetDebugEvents: true,
      ...overrides,
    },
  });
}

/** Narrowed draws still share hold, so try several reproducible seeds. */
function pick(runtime, context) {
  for (let seed = 0; seed < 128; seed += 1) {
    const selection = runtime.selectPreset({ ...context, seed });
    if (selection.kind === 'preset') return selection;
  }
  return null;
}

function variantWeight(selector, context, recipe, presetId) {
  const explained = selector.explain(context);
  const family = explained.families.find(entry => entry.recipes.some(item => item.recipe === recipe));
  if (family === undefined) return null;
  const found = family.recipes.find(item => item.recipe === recipe);
  return found?.variants.find(item => item.presetId === presetId)?.weight ?? null;
}

const recipesOf = presets => [...new Set(presets.map(preset => preset.recipeId))];
const familiesOf = presets => new Set(presets.map(preset => preset.family));

// ---------------------------------------------------------------------------------------------
// A. Recipe-level anti-repeat
// ---------------------------------------------------------------------------------------------

test('A1. same recipe / another variant is a repeat; a different recipe is not penalised', () => {
  const selector = createPresetSelector();
  const base = variantWeight(selector, idle(), 'idle-tilt', 'idle-tilt.flow');
  assert.ok(base > 0);

  const recipeRepeat = variantWeight(
    selector,
    idle({ recent: { recipes: ['idle-tilt'] } }),
    'idle-tilt',
    'idle-tilt.flow',
  );
  const presetRepeat = variantWeight(
    selector,
    idle({ recent: { actions: ['idle-tilt.flow'] } }),
    'idle-tilt',
    'idle-tilt.flow',
  );
  const otherRecipe = variantWeight(
    selector,
    idle({ recent: { recipes: ['idle-down'] } }),
    'idle-tilt',
    'idle-tilt.flow',
  );

  assert.ok(recipeRepeat < base * 0.8,
    `recipe repeat ${recipeRepeat} must be clearly below base ${base}`);
  assert.ok(presetRepeat < recipeRepeat * 0.85,
    `same preset ${presetRepeat} must be below same recipe ${recipeRepeat}`);
  assert.equal(otherRecipe, base, 'a different recipe must not be penalised');

  console.log(`[A1] idle-tilt.flow base=${base.toFixed(4)} sameRecipe=${recipeRepeat.toFixed(4)} `
    + `samePreset=${presetRepeat.toFixed(4)} otherRecipe=${otherRecipe.toFixed(4)}`);
});

test('A2. legacy preset-only memory is completed through the catalog; unknown ids stay unknown', () => {
  const selector = createPresetSelector();
  const historyWeight = history => variantWeight(
    selector,
    idle({ history, now: 2000 }),
    'idle-tilt',
    'idle-tilt.flow',
  );
  const fresh = historyWeight([]);
  const legacyPresetOnly = historyWeight([{ id: 'idle-tilt.flow', at: 1000 }]);
  const explicitRecipe = historyWeight([{ id: 'idle-tilt.flow', recipe: 'idle-tilt', at: 1000 }]);
  const explicitRecipeOnly = historyWeight([{ recipe: 'idle-tilt', at: 1000 }]);
  const unknown = historyWeight([{ id: 'no-such-preset', at: 1000 }]);

  assert.equal(legacyPresetOnly, explicitRecipe,
    'an old preset-only entry gets the same recipe completion as an explicit entry');
  assert.ok(legacyPresetOnly < fresh * 0.6, 'legacy history still penalises the recipe');
  assert.ok(explicitRecipeOnly < fresh && explicitRecipeOnly > legacyPresetOnly,
    'recipe-only history is weaker than preset+recipe history');
  assert.equal(unknown, fresh, 'an unknown id is never guessed into a recipe');

  console.log(`[A2] fresh=${fresh.toFixed(4)} legacyPresetOnly=${legacyPresetOnly.toFixed(4)} `
    + `recipeOnly=${explicitRecipeOnly.toFixed(4)} unknown=${unknown.toFixed(4)}`);
});

test('A3. only a real start appends selection memory; hold/refusal/cancel do not', () => {
  const runtime = makeRuntime();
  const blank = runtime.presetsSnapshot().selectionMemory;
  assert.deepEqual(blank.history, []);
  assert.deepEqual(blank.recentActions, []);
  assert.deepEqual(blank.recentRecipes, []);

  // A draw that holds does not start anything.
  const held = runtime.selectPreset({ state: 'idle', event: 'idle', verifiedChannels: [], seed: 0 });
  assert.equal(held.kind, 'hold');
  assert.deepEqual(runtime.presetsSnapshot().selectionMemory.history, []);

  // Passing that hold back to startPreset is a refusal, still no memory.
  const refused = runtime.startPreset(held, { at: 0 });
  assert.equal(refused.started, false);
  assert.deepEqual(runtime.presetsSnapshot().selectionMemory.history, []);

  // A real start is the first and only writer.
  const chosen = pick(runtime, { state: 'idle', event: 'idle', recipe: 'idle-tilt' });
  assert.ok(chosen !== null, 'idle-tilt must be selectable');
  const started = runtime.startPreset(chosen, {
    at: 1000,
    context: { state: 'idle', event: 'idle' },
  });
  assert.equal(started.started, true);
  let memory = runtime.presetsSnapshot().selectionMemory;
  assert.equal(memory.history.length, 1);
  assert.deepEqual(Object.keys(memory.history[0]).sort(), ['at', 'family', 'id', 'recipe']);
  assert.equal(memory.history[0].id, chosen.presetId);
  assert.equal(memory.history[0].recipe, 'idle-tilt');
  assert.equal(memory.history[0].family, 'posture');
  assert.equal(memory.history[0].at, 1000);
  assert.ok(memory.recentRecipes.includes('idle-tilt'));
  assert.ok(memory.recentActions.includes('idle-tilt'));
  assert.ok(memory.recentActions.includes(chosen.presetId));

  // The next autonomous idle draw hard-excludes the just-used recipe while the pool is healthy
  // (recipe cooldown); the recipe is not cleared, the rest of the pool simply stays available.
  let cooled = 0;
  let repeatedRecipe = 0;
  let nextPresets = 0;
  for (let seed = 0; seed < 500; seed += 1) {
    const next = runtime.selectPreset({ state: 'idle', event: 'idle', seed });
    if (next.reasons.includes('recipe-cooldown')) cooled += 1;
    if (next.kind === 'preset') nextPresets += 1;
    if (next.kind === 'preset' && next.recipe === 'idle-tilt') repeatedRecipe += 1;
  }
  assert.ok(cooled > 0, 'the just-used recipe is put on an idle cooldown');
  assert.ok(nextPresets > 400, `the cooldown keeps the rest of the idle pool alive: ${nextPresets}`);
  assert.equal(repeatedRecipe, 0, 'a healthy idle pool does not immediately replay the same recipe');

  // Cancelling a started action keeps the fact that it really performed.
  const beforeCancel = runtime.presetsSnapshot().selectionMemory.history.length;
  runtime.cancelPreset({ at: 2000 });
  assert.equal(runtime.presetsSnapshot().selectionMemory.history.length, beforeCancel,
    'cancel must not append or erase a performed start');

  console.log(`[A3] history=${JSON.stringify(memory.history[0])} cooldownDraws=${cooled} `
    + `repeatedRecipe=${repeatedRecipe} nextPresets=${nextPresets} historyAfterCancel=${beforeCancel}`);
});

// ---------------------------------------------------------------------------------------------
// B. Posture-aware settle gate
// ---------------------------------------------------------------------------------------------

test('B1. near-baseline skips idle settle with a visible reason; deviation allows it', () => {
  const selector = createPresetSelector();
  const near = selector.explain(idle({ postureOffset: { headX: 0.01, headZ: -0.02 } }));
  assert.equal(near.families.some(family => family.family === 'settle'), false,
    'idle-center must not be a candidate near the natural baseline');
  assert.ok(near.excluded.some(entry => entry.recipe === 'idle-center' && entry.reason === 'near-baseline'),
    `near-baseline reason is visible: ${JSON.stringify(near.excluded)}`);
  assert.ok(near.reasons.some(reason => reason.startsWith('excluded:near-baseline')),
    'explain.reasons carries the exclusion');

  const far = selector.explain(idle({ postureOffset: { headX: 0.24, headZ: -0.12 } }));
  assert.equal(far.families.some(family => family.family === 'settle'), true,
    'a real offset keeps the settle candidate available');

  // Unknown pose data must NOT be treated as 0, and a partial offset is not near-baseline either.
  const unknown = selector.explain(idle({ postureOffset: null }));
  assert.equal(unknown.families.some(family => family.family === 'settle'), true);
  const partial = selector.explain(idle({ postureOffset: { headX: 0.0 } }));
  assert.equal(partial.families.some(family => family.family === 'settle'), true,
    'missing headZ stays unknown instead of being treated as zero');

  console.log(`[B1] nearSettle=${near.families.some(f => f.family === 'settle')} `
    + `farSettle=${far.families.some(f => f.family === 'settle')} `
    + `partialSettle=${partial.families.some(f => f.family === 'settle')}`);
});

test('B2. posture-held skips idle settle, but an explicit recenter/answer-end overrides it', () => {
  const selector = createPresetSelector();
  const held = selector.explain(idle({
    postureOffset: { headX: 0.24, headZ: 0.12 },
    postureHeld: true,
  }));
  assert.equal(held.families.some(family => family.family === 'settle'), false);
  assert.ok(held.excluded.some(entry => entry.recipe === 'idle-center' && entry.reason === 'posture-held'));

  // Explicit recenter request wins over both the held posture and the near-baseline gate.
  const recenter = selector.explain(idle({
    postureOffset: { headX: 0, headZ: 0 },
    postureHeld: true,
    recenterRequested: true,
  }));
  assert.equal(recenter.families.some(family => family.family === 'settle'), true,
    'recenterRequested must allow the settle candidate');
  assert.equal(recenter.excluded.some(entry => entry.reason === 'near-baseline'), false);

  // answer-end is an explicit boundary, not an autonomous idle draw: it keeps its settle recipe.
  const answerEnd = selector.query({
    state: 'idle',
    event: 'answer-end',
    verifiedChannels: FULL_SEMANTIC_CHANNELS,
    postureOffset: { headX: 0, headZ: 0 },
    postureHeld: true,
  });
  const settleRecipes = new Set(answerEnd.filter(preset => preset.family === 'settle').map(preset => preset.recipeId));
  assert.ok(settleRecipes.has('end-center'), 'end-center must survive answer-end');
  assert.ok(settleRecipes.has('idle-center'), 'idle-center still serves the explicit answer-end boundary');

  // A selector whose only remaining family is settle shows the concrete hold reason.
  const families = [...new Set(PRESETS.map(preset => preset.family))];
  const onlySettle = createPresetSelector({
    overrides: { disabledFamilies: families.filter(family => family !== 'settle') },
  });
  const nearHold = onlySettle.select(idle({ postureOffset: { headX: 0, headZ: 0 } }));
  assert.equal(nearHold.kind, 'hold');
  assert.ok(nearHold.reasons.includes('near-baseline'), nearHold.reasons.join(','));

  const heldHold = onlySettle.select(idle({
    postureOffset: { headX: 0.24, headZ: 0.12 },
    postureHeld: true,
  }));
  assert.equal(heldHold.kind, 'hold');
  assert.ok(heldHold.reasons.includes('posture-held'), heldHold.reasons.join(','));

  console.log(`[B2] heldExcluded=${held.excluded.filter(e => e.reason === 'posture-held').length} `
    + `recenterSettle=${recenter.families.some(f => f.family === 'settle')} `
    + `answerEndSettle=${[...settleRecipes].join(',')}`);
});

test('B3. near-baseline uses a wider exit than entry (hysteresis), not a flickering boundary', () => {
  const selector = createPresetSelector();
  const settleAvailable = context => selector.explain(context)
    .families.some(family => family.family === 'settle');

  // Enter the near band at 0.02.
  assert.equal(settleAvailable(idle({ postureOffset: { headX: 0.02, headZ: 0.02 } })), false);
  // 0.07 is above the enter threshold (0.06) but below the exit threshold (0.096): stay near.
  assert.equal(settleAvailable(idle({ postureOffset: { headX: 0.07, headZ: 0.07 } })), false,
    'a value between enter and exit must not reopen settle immediately');
  // 0.12 leaves the band.
  assert.equal(settleAvailable(idle({ postureOffset: { headX: 0.12, headZ: 0.12 } })), true);
  // Back to 0.07: it must not re-enter until below the enter threshold.
  assert.equal(settleAvailable(idle({ postureOffset: { headX: 0.07, headZ: 0.07 } })), true,
    'leaving the band needs the wider exit threshold');
  // 0.02 re-enters.
  assert.equal(settleAvailable(idle({ postureOffset: { headX: 0.02, headZ: 0.02 } })), false);

  console.log('[B3] near@0.02=false, 0.07=false, 0.12=true, 0.07=true, 0.02=false');
});

// ---------------------------------------------------------------------------------------------
// C. Tired coverage
// ---------------------------------------------------------------------------------------------

test('C1. tired gains neutral posture/attention recipes; native-only recipes stay ineligible', () => {
  const selector = createPresetSelector();
  const context = { state: 'tired', event: 'idle', verifiedChannels: EXECUTABLE_CHANNELS };
  const candidates = selector.query(context);
  const recipes = recipesOf(candidates);
  const families = familiesOf(candidates);

  const previousBatch = ['idle-center', 'idle-blink', 'tired-lower', 'tired-blink'];
  const added = ['idle-side', 'idle-tilt', 'idle-down', 'idle-eye-side', 'idle-eye-down', 'idle-sway'];

  for (const recipe of previousBatch) assert.ok(recipes.includes(recipe), `kept ${recipe}`);
  for (const recipe of added) assert.ok(recipes.includes(recipe), `new tired recipe ${recipe}`);
  assert.ok(recipes.length >= 9, `tired effective recipes ${recipes.length}`);
  assert.ok(candidates.every(preset => preset.semantic === 'neutral'),
    'tired coverage must only add neutral idle actions');

  for (const family of ['posture', 'attention', 'rest', 'blink', 'settle']) {
    assert.ok(families.has(family), `tired family ${family}`);
  }
  assert.ok(families.size >= 5, `tired families ${families.size}`);

  // Native-only recipes never become executable candidates once the native channels are stripped.
  assert.equal(recipes.includes('idle-body-settle'), false);
  assert.equal(recipes.includes('idle-breath'), false);

  const explained = selector.explain(context);
  assert.ok(explained.reasons.includes('family:posture'));
  assert.ok(explained.reasons.includes('family:attention'));
  assert.ok(explained.reasons.some(reason => reason === 'family:rest' || reason === 'family:blink'));
  assert.ok(explained.reasons.length >= 5);

  console.log(`[C1] tired recipes ${previousBatch.length} -> ${recipes.length}: ${recipes.join(',')}`);
  console.log(`[C1] tired families ${families.size}: ${[...families].join(',')} reasons=${explained.reasons.join('|')}`);
});

// ---------------------------------------------------------------------------------------------
// D. Semantic/idle separate timing
// ---------------------------------------------------------------------------------------------

function semanticRuntimeProbe() {
  const runtime = makeRuntime();
  for (let at = 0; at <= 12_000; at += 33) runtime.tick(at);
  const at = 12_033;
  runtime.tick(at);
  runtime.takeEvents();

  const semantic = pick(runtime, { state: 'idle', event: 'answer-end', recipe: 'end-center', at });
  assert.ok(semantic !== null, 'end-center must be selectable at an explicit answer-end boundary');
  const started = runtime.startPreset(semantic, {
    at,
    context: { state: 'idle', event: 'answer-end' },
  });
  assert.equal(started.started, true);
  assert.equal(runtime.presetsSnapshot().lastSemanticAt, at);
  // Drop the running action so the only remaining gate would be the semantic quiet window.
  runtime.clearIntents({ reason: 'test-isolation', at });
  return { runtime, at };
}

test('D1. an idle draw stays quiet for 2 s after a real semantic start, without moving nextDecisionAt', () => {
  const { runtime, at } = semanticRuntimeProbe();
  const before = runtime.snapshot().motion.presets.debug.decisions;

  runtime.tick(at + 1000); // 1 s: still inside the quiet window
  const during = runtime.snapshot().motion.presets.debug.decisions;
  assert.equal(during, before, 'no idle draw inside the 2 s semantic quiet window');
  const skips = runtime.takeEvents()
    .filter(event => event.type === 'avatar.preset.skip')
    .map(event => ({ reason: event.reason, event: event.event, at: event.at }));
  assert.ok(skips.some(entry => entry.reason === 'busy' && entry.event === 'idle'),
    `the quiet gate is observable: ${JSON.stringify(skips)}`);

  // A separate clock: after the window, forcing a due decision still draws normally.
  runtime.setPresetExecution(true, { at: at + 2000 });
  const beforeDue = runtime.snapshot().motion.presets.debug.decisions;
  runtime.tick(at + 4000);
  assert.ok(runtime.snapshot().motion.presets.debug.decisions > beforeDue,
    'after the quiet window the idle boundary decides again');

  console.log(`[D1] decisions before=${before} during=${during} afterWindow>${beforeDue}`);
});

test('D2. a semantic event is not blocked by the idle quiet window', () => {
  const runtime = makeRuntime();
  runtime.tick(0);
  const before = runtime.presetsSnapshot().lastSemanticAt;
  const confused = pick(runtime, {
    state: 'thinking',
    event: 'confused',
    intent: 'confusion',
    verifiedChannels: ['headX', 'headY', 'headZ', 'browL'],
    at: 100,
  });
  assert.ok(confused !== null, 'confused must keep its own selection path');
  const started = runtime.startPreset(confused, {
    at: 100,
    context: { state: 'thinking', event: 'confused', intent: 'confusion' },
  });
  assert.equal(started.started, true);
  assert.equal(runtime.presetsSnapshot().lastSemanticAt, 100);
  assert.notEqual(runtime.presetsSnapshot().lastSemanticAt, before);

  console.log(`[D2] semanticStart=${started.presetId} lastSemanticAt=${runtime.presetsSnapshot().lastSemanticAt}`);
});

// ---------------------------------------------------------------------------------------------
// E. Blink layers (reported, excluded from the diversity count)
// ---------------------------------------------------------------------------------------------

test('E1. base blink and a preset blink are reported as a dual drive, not as diversity', () => {
  const runtime = makeRuntime();
  const blink = pick(runtime, { state: 'idle', event: 'idle', recipe: 'idle-blink' });
  assert.ok(blink !== null);
  const started = runtime.startPreset(blink, { at: 0, context: { state: 'idle', event: 'idle' } });
  assert.equal(started.started, true);
  const layers = runtime.presetsSnapshot().blinkLayers;
  assert.equal(layers.baseline.active, true, 'the base blink layer keeps running');
  assert.equal(layers.preset.starts, 1);
  assert.equal(layers.preset.active, true);
  assert.equal(layers.dualDrive, true);
  console.log(`[E1] blinkLayers=${JSON.stringify(layers)}`);
});

// ---------------------------------------------------------------------------------------------
// F. idle-sway execution: a headZ-led light body sway, not a headX-only turn
// ---------------------------------------------------------------------------------------------

test('F1. idle-sway leans on headZ with a small headX companion, asymmetrically and without a forced zero', () => {
  // Isolate the preset from the continuous idle curve so the measured ratio is the preset's own.
  const runtime = makeRuntime({ idleSwayScale: 0 });
  const selection = pick(runtime, { state: 'idle', event: 'idle', recipe: 'idle-sway' });
  assert.ok(selection !== null, 'idle-sway must be selectable');
  assert.deepEqual(selection.operations, ['head-sway']);

  const started = runtime.startPreset(selection, { at: 0, context: { state: 'idle', event: 'idle' } });
  assert.equal(started.started, true);
  assert.deepEqual(started.channels, ['headZ', 'headX'], 'the sway is a roll with a small yaw companion');

  const samples = [];
  for (let at = 0; at <= 3600; at += 33) {
    const pose = runtime.tick(at);
    samples.push({ at, z: pose.headZ, x: pose.headX });
  }
  const trace = runtime.snapshot().motion.presets.lastTrace;
  assert.equal(trace.selection.recipe, 'idle-sway');
  assert.deepEqual(trace.output.stages.map(stage => stage.op), ['head-sway']);
  assert.equal(trace.output.stages[0].kind, 'sway', 'sway has its own execution kind');
  assert.deepEqual(trace.output.stages[0].channels, ['headZ', 'headX']);
  assert.deepEqual(trace.output.channels, ['headZ', 'headX'], 'roll is the new primary, yaw is the companion');
  assert.deepEqual(
    [...new Set(trace.output.stages.flatMap(stageEntry => stageEntry.channels))],
    started.channels,
    'one trajectory owns exactly its own channels (single writer, no duplicated axis)',
  );
  assert.ok(trace.output.stages[0].activeMs >= 2200 && trace.output.stages[0].activeMs <= 2800,
    `slow active phase ${trace.output.stages[0].activeMs} ms (negation shake is 620 ms)`);

  // Judge the ACTUAL composed output inside this stage's active phase.
  const stage = trace.output.stages[0];
  const active = samples.filter(sample => sample.at >= stage.startMs + 150
    && sample.at <= stage.startMs + 150 + stage.activeMs);
  assert.ok(active.length >= 20, `active samples ${active.length}`);
  const zs = active.map(sample => sample.z);
  const xs = active.map(sample => sample.x);
  const minZ = Math.min(...zs);
  const maxZ = Math.max(...zs);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const peakZ = Math.max(Math.abs(minZ), Math.abs(maxZ));
  const peakX = Math.max(Math.abs(minX), Math.abs(maxX));

  assert.ok(maxZ > 0.25, `one side lean ${maxZ.toFixed(4)} pose units`);
  assert.ok(minZ < -0.15, `the other side lean ${minZ.toFixed(4)} pose units`);
  assert.ok(maxZ - minZ > 0.50, `peak-to-peak headZ ${(maxZ - minZ).toFixed(4)} is clearly visible`);
  assert.ok(peakZ <= 14 / 30 + 1e-6,
    `headZ peak ${peakZ.toFixed(4)} stays under the shared 14° cap (${(peakZ * 30).toFixed(2)}°)`);
  assert.ok(peakX < peakZ * 0.5, `headX ${peakX.toFixed(4)} follows headZ ${peakZ.toFixed(4)} instead of leading`);

  const ratio = peakX / Math.max(1e-6, peakZ);
  assert.ok(ratio >= 0.2 && ratio <= 0.3,
    `headX:headZ ratio ${ratio.toFixed(3)} sits in the requested 0.2–0.3 band`);
  assert.ok(Math.max(Math.abs(maxZ), Math.abs(minZ)) > Math.min(Math.abs(maxZ), Math.abs(minZ)) * 1.05,
    'the two sides are deliberately asymmetric, not a mirrored oscillator');

  const signs = zs.filter(value => Math.abs(value) > 1e-4).map(value => Math.sign(value));
  const directionChanges = signs.slice(1).filter((sign, index) => sign !== signs[index]).length;
  assert.ok(directionChanges >= 1, `the sway really changes direction (${directionChanges} change(s))`);
  assert.ok(signs.includes(1) && signs.includes(-1), 'both directions are present');

  // The hold keeps the second lean (no forced zero at the end of the active phase); the exit then
  // hands the pose back to the natural baseline.
  const holdFrom = stage.startMs + 150 + stage.activeMs;
  const hold = samples.filter(sample => sample.at >= holdFrom
    && sample.at <= holdFrom + stage.holdMs + 33);
  assert.ok(hold.length > 0, 'the dwell was sampled');
  const holdPeak = Math.max(...hold.map(sample => Math.abs(sample.z)));
  assert.ok(holdPeak > 0.05, `the dwell keeps a visible offset (${holdPeak.toFixed(4)}) instead of zeroing`);

  const actionEnd = trace.output.durationMs;
  const tail = samples.filter(sample => sample.at >= actionEnd + 250);
  assert.ok(tail.length > 0, 'the post-action tail was sampled');
  assert.ok(tail.every(sample => Math.abs(sample.z) < 0.05),
    'the natural exit returns the pose to the baseline after the action');

  console.log(`[F1] recipe=${selection.recipe} op=head-sway headZ min=${minZ.toFixed(4)} `
    + `max=${maxZ.toFixed(4)} peakToPeak=${(maxZ - minZ).toFixed(4)} `
    + `headX min=${minX.toFixed(4)} max=${maxX.toFixed(4)} ratio=${ratio.toFixed(3)} `
    + `activeMs=${stage.activeMs} holdPeak=${holdPeak.toFixed(4)} directionChanges=${directionChanges}`);
});

test('F2. idle-sway shares the recipe-level anti-repeat bucket', () => {
  const selector = createPresetSelector();
  const base = variantWeight(selector, idle(), 'idle-sway', 'idle-sway.flow');
  assert.ok(base > 0, `base weight ${base}`);
  const repeated = variantWeight(
    selector,
    idle({ recent: { recipes: ['idle-sway'] } }),
    'idle-sway',
    'idle-sway.flow',
  );
  assert.ok(repeated < base * 0.8,
    `same-recipe repeat ${repeated.toFixed(4)} must fall below ${(base * 0.8).toFixed(4)}`);
  console.log(`[F2] idle-sway.flow base=${base.toFixed(4)} sameRecipe=${repeated.toFixed(4)}`);
});

test('F3. sway stops on privacy lock / disconnect: no residual writer, no restart', () => {
  const stopPaths = [
    ['privacy', (runtime, at) => runtime.clearIntents({ reason: 'lock:privacy', at })],
    ['disconnect', (runtime, at) => runtime.clearPresets('disconnect', { at })],
  ];
  for (const [label, stop] of stopPaths) {
    const runtime = makeRuntime({ idleSwayScale: 0 });
    const selection = pick(runtime, { state: 'idle', event: 'idle', recipe: 'idle-sway' });
    assert.ok(selection !== null);
    runtime.startPreset(selection, { at: 0, context: { state: 'idle', event: 'idle' } });
    for (let at = 0; at <= 300; at += 33) runtime.tick(at);
    const before = runtime.presetsSnapshot();
    assert.equal(before.active.length, 1, `${label}: the sway is running`);
    assert.deepEqual(before.active[0].channels, ['headZ', 'headX']);

    stop(runtime, 300);
    const stopped = runtime.presetsSnapshot();
    assert.equal(stopped.active.length, 0, `${label}: no sway trajectory survives`);
    const starts = stopped.starts;
    for (let at = 300; at <= 900; at += 33) runtime.tick(at);
    const after = runtime.presetsSnapshot();
    assert.equal(after.active.length, 0, `${label}: no residual writer keeps the channels`);
    assert.equal(after.starts, starts, `${label}: the stopped sway is not restarted`);
    assert.equal(after.lastTrace.output.channels.includes('headZ'), true,
      `${label}: the trace still names the stopped channels (evidence only)`);
    console.log(`[F3] ${label}: active ${before.active.length} → 0, starts stays ${after.starts}`);
  }
});

// ---------------------------------------------------------------------------------------------
// Recomputable before/after summaries for the report
// ---------------------------------------------------------------------------------------------

test('SUMMARY. same-recipe repeat rate and near-baseline settle draws (before vs after)', () => {
  const sample = 800;
  const observe = (withRecipeMemory) => {
    const selector = createPresetSelector();
    let previous = null;
    let repeats = 0;
    const recent = [];
    for (let index = 0; index < sample; index += 1) {
      const result = selector.select(idle({
        seed: seedAt(index),
        ...(withRecipeMemory ? { recent: { recipes: [...recent] } } : {}),
      }));
      if (result.kind !== 'preset') continue;
      if (previous !== null && result.recipe === previous) repeats += 1;
      previous = result.recipe;
      if (withRecipeMemory) {
        recent.push(result.recipe);
        if (recent.length > 3) recent.shift();
      }
    }
    return repeats / sample;
  };
  const withoutMemory = observe(false);
  const withMemory = observe(true);
  assert.ok(withMemory < withoutMemory,
    `recipe memory must lower the repeat rate: ${withMemory} < ${withoutMemory}`);
  // The idle recipe cooldown is a hard exclusion while the pool is healthy, so consecutive
  // same-recipe draws should drop sharply rather than merely become less likely.
  assert.ok(withMemory <= withoutMemory * 0.25,
    `consecutive same-recipe draws must drop sharply: ${withMemory} vs ${withoutMemory}`);
  const dropped = withoutMemory > 0 ? (1 - withMemory / withoutMemory) * 100 : 0;

  // "Before" = offset unknown (the pre-change selector behaved this way); "after" = near baseline.
  const beforeSelector = createPresetSelector();
  const afterSelector = createPresetSelector();
  let beforeSettle = 0;
  let afterSettle = 0;
  for (let index = 0; index < 1000; index += 1) {
    const before = beforeSelector.select(idle({ seed: seedAt(index) }));
    if (before.kind === 'preset' && before.family === 'settle') beforeSettle += 1;
    const after = afterSelector.select(idle({
      seed: seedAt(index),
      postureOffset: { headX: 0.01, headZ: -0.01 },
    }));
    if (after.kind === 'preset' && after.family === 'settle') afterSettle += 1;
  }
  assert.equal(afterSettle, 0, 'near baseline must produce zero automatic settle draws');

  console.log(`[SUMMARY] same-recipe repeat rate: noMemory=${withoutMemory.toFixed(3)} `
    + `withMemory=${withMemory.toFixed(3)} (${sample} draws, drop=${dropped.toFixed(1)}%)`);
  console.log(`[SUMMARY] settle draws near baseline: before(unknownOffset)=${beforeSettle}/1000 `
    + `after(nearBaseline)=${afterSettle}/1000`);
});
