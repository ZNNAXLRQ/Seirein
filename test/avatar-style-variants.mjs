/**
 * avatar-style-variants — P-139 stage 3 acceptance (style dimensions + action variants).
 *
 * Run: node --test test/avatar-style-variants.mjs
 *
 * Covered here:
 *   1. the six PLAN dimensions are persona-derived (plus the frozen legacy three), deterministic
 *      per persona version, and map onto the ONE `styleTraitEffects` table;
 *   2. different dimension profiles produce observably different amplitude / tempo / hold /
 *      variant spread / attention (head-turn) weights;
 *   3. the same seed reproduces the same timing + action variant;
 *   4. a different action variant of the same recipe is still a recipe-level repeat;
 *   5. the executor applies the selected delivery variant, and the same recipe's variants really
 *      produce different durations/holds/peaks.
 *
 * No test here adds a timer, a request, a writer or a second 30 Hz loop: selection is pure and the
 * execution checks only read the existing single controller.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AVATAR_STYLE_DIMENSIONS,
  AVATAR_STYLE_LEGACY_DIMENSIONS,
  deriveAvatarStyleDimensions,
  splitAvatarStyleDimensions,
} from '../src/host/avatar/style.js';
import { styleTraitEffects } from '../src/host/avatar/motion-config.js';
import { createPresetSelector } from '../src/host/avatar/preset-selector.js';
import { createBehaviorRuntime } from '../src/host/avatar/motion-controller.js';
import { OPERATIONS, RECIPES } from '../src/host/avatar/presets/index.js';

const ALL_CHANNELS = Object.freeze([...new Set(Object.values(OPERATIONS).flat())]);
const seedAt = index => (0x9e3779b9 + index * 2654435761) >>> 0;
const idle = (over = {}) => ({
  state: 'idle',
  event: 'idle',
  verifiedChannels: ALL_CHANNELS,
  ...over,
});

const QUIET_STYLE = Object.freeze({
  amplitude: 0.5,
  tempo: 0.7,
  gazeHabit: 'steady',
  expressiveness: 0.5,
  nodAmplitude: 0.5,
  nodDurationMs: 800,
  tiltChance: 0.05,
});
const LIVELY_STYLE = Object.freeze({
  amplitude: 1.4,
  tempo: 1.5,
  gazeHabit: 'wandering',
  expressiveness: 1.4,
  nodAmplitude: 1.3,
  nodDurationMs: 350,
  tiltChance: 0.4,
});

const QUIET_TRAITS = Object.freeze({
  liveliness: 0.15,
  softness: 0.9,
  restraint: 0.9,
  expressiveness: 0.2,
  attention: 0.15,
  composure: 0.9,
  texture: 0.15,
});
const LIVELY_TRAITS = Object.freeze({
  liveliness: 0.9,
  softness: 0.15,
  restraint: 0.15,
  expressiveness: 0.9,
  attention: 0.9,
  composure: 0.15,
  texture: 0.9,
});

const countBy = (results, keyOf) => {
  const counts = new Map();
  for (const result of results) {
    if (result.kind !== 'preset') continue;
    const key = keyOf(result);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
};
const shareBy = (results, keyOf) => {
  const counts = countBy(results, keyOf);
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  return new Map([...counts].map(([key, count]) => [key, count / total]));
};
const totalVariation = (a, b) => {
  const keys = new Set([...a.keys(), ...b.keys()]);
  return [...keys].reduce((sum, key) => sum + Math.abs((a.get(key) ?? 0) - (b.get(key) ?? 0)), 0) / 2;
};
const presetResults = results => results.filter(result => result.kind === 'preset');

// ---------------------------------------------------------------------------------------------
// 1. Persona-derived dimensions and the one mapping table
// ---------------------------------------------------------------------------------------------

test('1. six PLAN dimensions (plus the legacy three) are persona-derived and deterministic', () => {
  for (const name of ['liveliness', 'restraint', 'expressiveness', 'attention', 'composure', 'texture']) {
    assert.ok(AVATAR_STYLE_DIMENSIONS.includes(name), `${name} is a declared style dimension`);
  }
  assert.deepEqual([...AVATAR_STYLE_LEGACY_DIMENSIONS], ['liveliness', 'softness', 'restraint']);

  const version = 'v1-stage3-persona';
  const quiet = deriveAvatarStyleDimensions(QUIET_STYLE, { styleVersion: version });
  const quietAgain = deriveAvatarStyleDimensions(QUIET_STYLE, { styleVersion: version });
  const lively = deriveAvatarStyleDimensions(LIVELY_STYLE, { styleVersion: 'v1-lively-persona' });
  assert.deepEqual(quiet, quietAgain, 'same style + version => identical dimensions');
  assert.equal(quiet.seed, quietAgain.seed);

  for (const name of AVATAR_STYLE_DIMENSIONS) {
    assert.ok(Number.isFinite(quiet[name]) && quiet[name] >= 0 && quiet[name] <= 1,
      `${name} stays in [0,1] (${quiet[name]})`);
  }

  // Direction checks: the quiet persona is restrained/composed, the lively one expressive/scanning.
  assert.ok(quiet.restraint > lively.restraint);
  assert.ok(quiet.composure > lively.composure);
  assert.ok(quiet.softness > lively.softness);
  assert.ok(lively.liveliness > quiet.liveliness);
  assert.ok(lively.expressiveness > quiet.expressiveness);
  assert.ok(lively.attention > quiet.attention);
  assert.ok(lively.texture > quiet.texture);

  // The snapshot keeps the frozen three-field shape; the full set lives beside it.
  const split = splitAvatarStyleDimensions(quiet);
  assert.deepEqual(Object.keys(split.dimensions).sort(), ['liveliness', 'restraint', 'seed', 'softness']);
  assert.deepEqual(Object.keys(split.traits).sort(), [...AVATAR_STYLE_DIMENSIONS, 'seed'].sort());

  // One pure table maps the dimensions onto every consumer, so no consumer hard-codes persona ids.
  const quietEffects = styleTraitEffects(quiet);
  const livelyEffects = styleTraitEffects(lively);
  assert.ok(livelyEffects.amplitude > quietEffects.amplitude, 'lively/expressive => larger gestures');
  assert.ok(livelyEffects.tempo > quietEffects.tempo, 'lively => faster rhythm');
  assert.ok(quietEffects.duration > livelyEffects.duration, 'composed/soft => longer active phase');
  assert.ok(quietEffects.hold > livelyEffects.hold, 'composed/soft => longer hold');
  assert.ok(livelyEffects.attentionChance > quietEffects.attentionChance, 'attention => reorientation chance');
  assert.ok(livelyEffects.variantSpread > quietEffects.variantSpread, 'texture => wider variant spread');
  assert.ok(quietEffects.hold <= 1.5 && livelyEffects.amplitude >= 0.55, 'effects stay bounded');
  console.log(
    `[dims] quiet=${JSON.stringify(compact(quiet))} lively=${JSON.stringify(compact(lively))}`,
  );
});

function compact(dimensions) {
  const out = {};
  for (const name of AVATAR_STYLE_DIMENSIONS) out[name] = dimensions[name];
  out.seed = dimensions.seed;
  return out;
}

// ---------------------------------------------------------------------------------------------
// 2. Dimension profiles change the sampled action-variant distribution and attention weighting
// ---------------------------------------------------------------------------------------------

test('2. different dimension profiles produce different action variants and head-turn weights', () => {
  const selector = createPresetSelector();
  const sample = 800;
  const drawFor = (traits) => Array.from({ length: sample }, (_, index) => selector.select(idle({
    persona: { dimensions: traits },
    seed: seedAt(index),
  })));
  const quiet = drawFor(QUIET_TRAITS);
  const lively = drawFor(LIVELY_TRAITS);

  const quietVariants = countBy(quiet, result => result.actionVariantKey);
  const livelyVariants = countBy(lively, result => result.actionVariantKey);
  assert.ok(quietVariants.size > 1, 'the same recipe family offers replaceable variants');
  assert.ok(livelyVariants.size > 1);
  const variantDistance = totalVariation(
    shareBy(quiet, result => result.actionVariantKey),
    shareBy(lively, result => result.actionVariantKey),
  );
  assert.ok(variantDistance > 0.15,
    `persona changes the variant distribution (${variantDistance.toFixed(3)})`);

  const lateral = results => presetResults(results)
    .filter(result => result.operations.some(operation => operation === 'head-turn' || operation === 'shake')).length;
  const quietLateral = lateral(quiet);
  const livelyLateral = lateral(lively);
  assert.ok(livelyLateral > quietLateral * 1.4,
    `high attention turns the head more (${livelyLateral} vs ${quietLateral})`);

  // Every variant is still the SAME recipe identity: the composite key names the variant, while
  // family/recipe probabilities are not inflated by turning variants into extra presets.
  for (const result of presetResults(lively).slice(0, 50)) {
    assert.equal(typeof result.actionVariant, 'string');
    assert.equal(result.actionVariantKey, `${result.recipe}:${result.actionVariant}`);
  }
  console.log(
    `[variants] quietLateral=${quietLateral} livelyLateral=${livelyLateral}`
    + ` TV=${variantDistance.toFixed(3)}`
    + ` variantCount=${livelyVariants.size}`,
  );
});

// ---------------------------------------------------------------------------------------------
// 3. Fixed seed reproducibility (timing + action variant)
// ---------------------------------------------------------------------------------------------

test('3. the same seed reproduces the same recipe, timing variant and action variant', () => {
  const context = idle({
    persona: { dimensions: LIVELY_TRAITS },
    seed: 424242,
  });
  const first = createPresetSelector().select(context);
  const second = createPresetSelector().select({ ...context });
  assert.equal(first.kind, 'preset');
  assert.deepEqual(first, second, 'a fixed seed reproduces the entire selection');
  assert.equal(typeof first.actionVariant, 'string');
  assert.equal(first.actionVariantProfile.id, first.actionVariant);

  // A run of seeded draws really uses more than one replacement (not a constant label).
  const variants = new Set();
  for (let index = 0; index < 120; index += 1) {
    const draw = createPresetSelector().select(idle({
      persona: { dimensions: LIVELY_TRAITS },
      seed: seedAt(index),
    }));
    if (draw.kind === 'preset') variants.add(draw.actionVariantKey);
  }
  assert.ok(variants.size >= 3, `several replacement variants are reachable (${variants.size})`);
  console.log(`[seed] preset=${first.presetId} timing=${first.variant} action=${first.actionVariant} variants=${variants.size}`);
});

// ---------------------------------------------------------------------------------------------
// 4. Action variants never bypass the recipe-level anti-repeat
// ---------------------------------------------------------------------------------------------

function variantWeight(selector, context, recipe, presetId) {
  const explained = selector.explain(context);
  const family = explained.families.find(entry => entry.recipes.some(item => item.recipe === recipe));
  if (family === undefined) return null;
  const found = family.recipes.find(item => item.recipe === recipe);
  return found?.variants.find(item => item.presetId === presetId)?.weight ?? null;
}

test('4. a different action variant is distinct, but the same recipe is still the repeat unit', () => {
  const selector = createPresetSelector();
  const base = variantWeight(selector, idle(), 'idle-tilt', 'idle-tilt.flow');
  assert.ok(base > 0);
  const sameRecipe = variantWeight(
    selector,
    idle({ recent: { recipes: ['idle-tilt'] } }),
    'idle-tilt',
    'idle-tilt.flow',
  );
  const otherRecipe = variantWeight(
    selector,
    idle({ recent: { recipes: ['idle-down'] } }),
    'idle-tilt',
    'idle-tilt.flow',
  );
  assert.ok(sameRecipe < base * 0.8,
    `recipe repeat ${sameRecipe} is clearly below base ${base}`);
  assert.equal(otherRecipe, base, 'a different recipe is not penalised');

  // The recipe keeps one variant set (replacements), and those variants are NOT separate presets.
  const recipe = RECIPES.find(entry => entry.id === 'idle-tilt');
  assert.ok(recipe.actionVariants.length >= 2);
  assert.ok(recipe.actionVariants.every(variant => typeof variant.id === 'string'));
  const ids = new Set(recipe.actionVariants.map(variant => variant.id));
  assert.equal(ids.size, recipe.actionVariants.length, 'variant ids are unique inside one recipe');

  // Recent recipe memory still outranks a single exact timing-variant repeat, and a variant label
  // in history never completes to a different recipe.
  const exactPreset = variantWeight(
    selector,
    idle({ recent: { actions: ['idle-tilt.flow'] } }),
    'idle-tilt',
    'idle-tilt.flow',
  );
  assert.ok(exactPreset < sameRecipe, 'same exact preset is stronger than same recipe');
  console.log(`[cooldown] base=${base.toFixed(4)} sameRecipe=${sameRecipe.toFixed(4)} exact=${exactPreset.toFixed(4)} other=${otherRecipe}`);
});

// ---------------------------------------------------------------------------------------------
// 5. Executor applies the chosen variant; persona dimensions change the actual trajectory
// ---------------------------------------------------------------------------------------------

function makeRuntime(style) {
  return createBehaviorRuntime({
    config: {
      seed: 11,
      presetExecution: true,
      presetTargetVerified: true,
      presetChannels: [...ALL_CHANNELS],
      style,
    },
  });
}

function pickPreset(runtime, context) {
  for (let seed = 0; seed < 96; seed += 1) {
    const selection = runtime.selectPreset({ ...context, seed });
    if (selection.kind === 'preset') return selection;
  }
  return null;
}

test('5. the selected delivery variant reaches the trajectory, and persona dimensions change it', () => {
  const run = (style) => {
    const runtime = makeRuntime(style);
    const selection = pickPreset(runtime, { state: 'idle', event: 'idle', recipe: 'idle-tilt' });
    assert.ok(selection !== null);
    const started = runtime.startPreset(selection, { at: 0 });
    assert.equal(started.started, true);
    assert.equal(started.actionVariant, selection.actionVariant);
    assert.equal(started.actionVariantKey, selection.actionVariantKey);
    const end = Math.ceil(started.durationMs) + 100;
    for (let at = 0; at <= end; at += 33) runtime.tick(at);
    const trace = runtime.presetsSnapshot().lastTrace;
    assert.equal(trace.selection.actionVariant, selection.actionVariant);
    return {
      selection,
      started,
      trace,
      peak: trace.output.peak,
      activeMs: started.stages[0].activeMs,
      holdMs: started.stages[0].holdMs,
    };
  };

  const quiet = run(QUIET_STYLE);
  const lively = run(LIVELY_STYLE);
  assert.ok(lively.peak > quiet.peak * 2,
    `the expressive persona produces a larger preset peak (${lively.peak} vs ${quiet.peak})`);
  assert.ok(quiet.holdMs > lively.holdMs,
    `the composed persona holds longer (${quiet.holdMs}ms vs ${lively.holdMs}ms)`);
  assert.ok(quiet.started.durationMs > lively.started.durationMs,
    `the composed persona takes longer overall (${quiet.started.durationMs} vs ${lively.started.durationMs})`);
  assert.notEqual(quiet.selection.actionVariantKey, lively.selection.actionVariantKey,
    'different persona dimensions select different deliveries for the same recipe');

  // The variant is a delivery, not a new action: the recipe and timing identity are unchanged.
  assert.equal(quiet.selection.recipe, 'idle-tilt');
  assert.equal(lively.selection.recipe, 'idle-tilt');
  console.log(
    `[executor] quiet=${quiet.selection.actionVariant} ${Math.round(quiet.started.durationMs)}ms hold=${Math.round(quiet.holdMs)} peak=${quiet.peak.toFixed(3)}`
    + ` lively=${lively.selection.actionVariant} ${Math.round(lively.started.durationMs)}ms hold=${Math.round(lively.holdMs)} peak=${lively.peak.toFixed(3)}`,
  );
});

// ---------------------------------------------------------------------------------------------
// 6. Safety invariants that must not regress while selection gets richer
// ---------------------------------------------------------------------------------------------

test('6. privacy/disposal still hold before any variant is drawn', () => {
  const selector = createPresetSelector();
  for (const [over, reason] of [
    [{ privacy: true }, 'privacy'],
    [{ disposed: true }, 'disposed'],
  ]) {
    const held = selector.select(idle(over));
    assert.equal(held.kind, 'hold');
    assert.ok(held.reasons.includes(reason));
    assert.equal(held.actionVariant, null, 'no variant is chosen for a refused draw');
  }
  console.log('[safety] privacy/disposed => hold, no action variant');
});
