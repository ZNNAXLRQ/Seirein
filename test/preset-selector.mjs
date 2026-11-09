/**
 * preset-selector tests — the selection layer only (no controller, no VTS, no presets edits).
 *
 * Run: node --test test/preset-selector.mjs
 *
 * Every draw is seeded, so the statistical assertions below are deterministic and do not
 * depend on wall-clock time or Math.random.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { PRESETS, OPERATIONS, RECIPES, STYLES, VARIANTS } from '../src/host/avatar/presets/index.js';
import { createPresetIndex, createPresetSelector, PRESET_SELECTOR_CONSTANTS } from '../src/host/avatar/preset-selector.js';

/** Every semantic channel the library knows, as if a model had verified all of them. */
const FULL_CHANNELS = Object.freeze([...new Set(Object.values(OPERATIONS).flat())]);
const HEAD_CHANNELS = Object.freeze(['headX', 'headY', 'headZ']);
const SEMANTIC_FAMILIES = new Set(PRESETS.filter(preset => preset.semantic !== 'neutral').map(preset => preset.family));

const idle = (over = {}) => ({ state: 'idle', event: 'idle', verifiedChannels: FULL_CHANNELS, ...over });
const seedAt = index => (0x9e3779b9 + index * 2654435761) >>> 0;
const draw = (selector, context, count) => Array.from(
  { length: count },
  (_, index) => selector.select({ ...context, seed: seedAt(index) }),
);
const presetsOnly = results => results.filter(result => result.kind === 'preset');
const countBy = (results, keyOf) => {
  const counts = new Map();
  for (const result of presetsOnly(results)) {
    const key = keyOf(result);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
};
const shareBy = (results, keyOf) => {
  const counts = countBy(results, keyOf);
  return new Map([...counts].map(([key, count]) => [key, count / results.length]));
};
const totalVariation = (a, b) => {
  const keys = new Set([...a.keys(), ...b.keys()]);
  return [...keys].reduce((sum, key) => sum + Math.abs((a.get(key) ?? 0) - (b.get(key) ?? 0)), 0) / 2;
};
const presetOf = (selector, result) => selector.index.byId.get(result.presetId);

// ---------------------------------------------------------------------------------------------
// 1. Reproducibility
// ---------------------------------------------------------------------------------------------
test('same context and seed reproduce the same selection; rand is injectable', () => {
  const selector = createPresetSelector();
  const context = idle({ persona: { styles: ['composed'] }, seed: 424242 });
  const first = selector.select(context);
  const second = selector.select({ ...context });
  assert.equal(first.kind, 'preset');
  assert.deepEqual(first, second);
  assert.equal(typeof first.score, 'number');
  assert.ok(first.score > 0);
  assert.ok(first.probability > 0 && first.probability < 1);
  assert.deepEqual(selector.explain({ ...context, seed: 1 }), selector.explain({ ...context, seed: 1 }));

  const sequence = () => {
    const values = [0.01, 0.55, 0.2, 0.9, 0.4, 0.75, 0.3];
    let cursor = 0;
    return () => values[cursor++ % values.length];
  };
  const viaRand = selector.select(idle({ rand: sequence() }));
  const viaRandAgain = selector.select(idle({ rand: sequence() }));
  assert.deepEqual(viaRand, viaRandAgain);
});

// ---------------------------------------------------------------------------------------------
// 2. Persona style shifts the distribution
// ---------------------------------------------------------------------------------------------
test('different persona styles produce different sampled distributions', () => {
  const selector = createPresetSelector();
  const reserved = draw(selector, idle({ persona: { styles: ['reserved', 'composed', 'cool'] } }), 600);
  const lively = draw(selector, idle({ persona: { styles: ['playful', 'lively', 'cheerful'] } }), 600);
  assert.ok(presetsOnly(reserved).length > 450);
  assert.ok(totalVariation(shareBy(reserved, r => r.family), shareBy(lively, r => r.family)) > 0.1);
  assert.ok(totalVariation(shareBy(reserved, r => r.recipe), shareBy(lively, r => r.recipe)) > 0.2);

  // The dimension projection is a different input path with the same soft-only effect.
  const livelyDimensions = selector.explain(idle({ persona: { dimensions: { liveliness: 0.9, softness: 0.2, restraint: 0.2 } } }));
  const quietDimensions = selector.explain(idle({ persona: { dimensions: { liveliness: 0.1, softness: 0.9, restraint: 0.9 } } }));
  const weights = explain => new Map(explain.families.map(family => [family.family, family.weight]));
  assert.notDeepEqual(weights(livelyDimensions), weights(quietDimensions));
});

// ---------------------------------------------------------------------------------------------
// 3. User disables
// ---------------------------------------------------------------------------------------------
test('disabled action ids and families never appear', () => {
  const disabledIds = ['idle-side.flow', 'idle-tilt.pause', 'idle-blink.linger'];
  const selector = createPresetSelector({ overrides: { disabled: disabledIds } });
  const results = draw(selector, idle(), 500);
  assert.ok(presetsOnly(results).length > 400);
  assert.ok(results.every(result => result.kind === 'hold' || !disabledIds.includes(result.presetId)));

  const familySelector = createPresetSelector({ overrides: { disabledFamilies: ['posture', 'breath'] } });
  const familyResults = draw(familySelector, idle(), 400);
  assert.ok(presetsOnly(familyResults).length > 300);
  assert.ok(familyResults.every(result => result.kind === 'hold' || !['posture', 'breath'].includes(result.family)));

  // Per-call overrides replace the factory overrides for that call only.
  const perCall = selector.select(idle({ overrides: { disabled: ['idle-eye-down.flow'] } }));
  assert.notEqual(perCall.presetId, 'idle-eye-down.flow');
});

// ---------------------------------------------------------------------------------------------
// 4. Priority raises the sampled share
// ---------------------------------------------------------------------------------------------
test('raising an action priority raises its share over a large sample', () => {
  const context = { state: 'thinking', event: 'thinking', verifiedChannels: FULL_CHANNELS };
  const base = createPresetSelector();
  const boosted = createPresetSelector({ overrides: { actionPriority: { 'think-up': 100 } } });
  const sample = 2000;
  const baseShare = presetsOnly(draw(base, context, sample)).filter(result => result.recipe === 'think-up').length / sample;
  const boostedShare = presetsOnly(draw(boosted, context, sample)).filter(result => result.recipe === 'think-up').length / sample;
  assert.ok(baseShare > 0.02, `baseline share ${baseShare}`);
  assert.ok(boostedShare > baseShare * 1.8, `${boostedShare} vs ${baseShare}`);
  assert.ok(boostedShare < 0.5, 'priority 100 never guarantees the action');

  // Family priority reaches every recipe of that family.
  const familyBoost = createPresetSelector({ overrides: { familyPriority: { thought: 100 } } });
  const familyShare = presetsOnly(draw(familyBoost, context, sample)).filter(result => result.family === 'thought').length / sample;
  assert.ok(familyShare > 0.35);
});

// ---------------------------------------------------------------------------------------------
// 5. Variant count must not distort family probability
// ---------------------------------------------------------------------------------------------
test('more timing variants in a family do not inflate that family', () => {
  const makePreset = (family, recipeId, variant) => ({
    id: `${recipeId}.${variant}`,
    family,
    recipeId,
    states: ['idle'],
    events: ['idle'],
    semantic: 'neutral',
    styles: ['common'],
    requires: ['headZ'],
    requiresTarget: false,
    requiresDirection: false,
    operations: ['head-tilt'],
    timing: { id: variant },
  });
  // Family alpha has ONE variant, family beta has EIGHT; both have identical base scores.
  const synthetic = [
    makePreset('alpha', 'a1', 'flow'),
    ...Array.from({ length: 8 }, (_, index) => makePreset('beta', 'b1', `v${index}`)),
  ];
  const selector = createPresetSelector({ presets: synthetic });
  const context = { state: 'idle', event: 'idle', verifiedChannels: ['headZ'] };
  const results = draw(selector, context, 1200);
  const families = shareBy(results, result => result.family);
  assert.ok(Math.abs((families.get('alpha') ?? 0) - (families.get('beta') ?? 0)) < 0.06);

  const explained = selector.explain(context);
  const alpha = explained.families.find(family => family.family === 'alpha');
  const beta = explained.families.find(family => family.family === 'beta');
  assert.equal(alpha.weight, beta.weight);
  assert.equal(alpha.probability, beta.probability);

  // Inside the family the timing variants stay roughly uniform (conditional on beta).
  const betaDraws = presetsOnly(results).filter(result => result.family === 'beta');
  const variants = countBy(betaDraws, result => result.variant);
  assert.equal(variants.size, 8);
  for (const count of variants.values()) {
    const share = count / betaDraws.length;
    assert.ok(share > 0.08 && share < 0.18, `variant share ${share}`);
  }
});

// ---------------------------------------------------------------------------------------------
// 6. Semantics require their intent; idle never carries a gesture
// ---------------------------------------------------------------------------------------------
test('semantic gestures never fire without their intent; idle cannot nod, shake or frown', () => {
  const selector = createPresetSelector();
  const idleDraws = draw(selector, idle({ intent: 'agreement', semantic: 'agreement' }), 300);
  for (const result of presetsOnly(idleDraws)) {
    const preset = presetOf(selector, result);
    assert.equal(preset.semantic, 'neutral');
    assert.ok(!SEMANTIC_FAMILIES.has(preset.family));
    assert.ok(!preset.operations.some(operation => ['nod', 'double-nod', 'shake', 'brow-knit', 'brow-one'].includes(operation)));
  }
  assert.ok(presetsOnly(idleDraws).length > 200);

  // An intent event with a contradicting (or explicitly neutral) intent fails closed.
  const speaking = { state: 'speaking', verifiedChannels: FULL_CHANNELS, targetVerified: true };
  assert.equal(selector.select({ ...speaking, event: 'deny', semantic: 'neutral' }).kind, 'hold');
  assert.equal(selector.select({ ...speaking, event: 'deny', intent: 'agreement' }).kind, 'hold');
  // No preset is offered for a deny event in an idle state at all.
  assert.equal(selector.select(idle({ event: 'deny', intent: 'disagreement' })).kind, 'hold');

  // The matching intent selects the negation family, and only there does `shake` appear.
  const deny = presetsOnly(draw(selector, { ...speaking, event: 'deny', intent: 'disagreement' }, 200));
  assert.ok(deny.length > 100);
  assert.ok(deny.every(result => result.family === 'negation'));
  assert.ok(deny.every(result => result.operations.includes('shake')));
});

// ---------------------------------------------------------------------------------------------
// 7. Required channels are hard constraints; no single-channel downgrade
// ---------------------------------------------------------------------------------------------
test('a missing required channel excludes the candidate instead of degrading it', () => {
  const selector = createPresetSelector();
  const headOnly = selector.query({ state: 'idle', event: 'idle', verifiedChannels: HEAD_CHANNELS });
  assert.ok(headOnly.length >= 24);
  assert.ok(headOnly.every(preset => preset.requires.every(channel => HEAD_CHANNELS.includes(channel))));
  assert.ok(headOnly.every(preset => !preset.requiresTarget && !preset.requiresDirection));

  // head-center needs headX AND headZ: one axis alone is never accepted.
  assert.equal(selector.query({ state: 'idle', event: 'idle', verifiedChannels: ['headX'], family: 'settle' }).length, 0);
  assert.equal(selector.query({ state: 'idle', event: 'idle', verifiedChannels: ['headZ'], family: 'settle' }).length, 0);
  assert.ok(selector.query({ state: 'idle', event: 'idle', verifiedChannels: [...HEAD_CHANNELS], family: 'settle' }).length > 0);

  // Body and breath never sneak in through a head-only capability report.
  const headResults = draw(selector, idle({ verifiedChannels: HEAD_CHANNELS }), 300);
  const checked = presetsOnly(headResults);
  assert.ok(checked.length > 200);
  const verified = new Set(HEAD_CHANNELS);
  assert.ok(checked.every(result => result.requires.every(channel => verified.has(channel))));
  assert.ok(checked.every(result => !['bodyX', 'bodyY', 'bodyZ', 'breath', 'gazeX', 'gazeY'].some(channel => result.requires.includes(channel))));
});

// ---------------------------------------------------------------------------------------------
// 8. Optional one-sided channel is dropped and recorded
// ---------------------------------------------------------------------------------------------
test('a one-sided brow channel is optional; the missing side is reported', () => {
  const selector = createPresetSelector();
  const context = {
    state: 'thinking',
    event: 'confused',
    intent: 'confusion',
    verifiedChannels: ['headX', 'headY', 'headZ', 'browL'],
  };
  const results = draw(selector, context, 400);
  const draws = presetsOnly(results);
  assert.ok(draws.length > 180);
  const verified = new Set(context.verifiedChannels);
  assert.ok(draws.every(result => !result.presetId.startsWith('confused-brow')));
  assert.ok(draws.every(result => result.requires
    .filter(channel => !result.droppedChannels.includes(channel))
    .every(channel => verified.has(channel))));
  assert.ok(draws.every(result => result.effectiveRequires.every(channel => verified.has(channel))));
  assert.ok(draws.every(result => result.effectiveRequires.length === result.requires.length - result.droppedChannels.length));
  const combos = draws.filter(result => result.recipe === 'confused-combo');
  assert.ok(combos.length > 50);
  assert.ok(combos.every(result => result.droppedChannels.length === 1 && result.droppedChannels[0] === 'browR'));
  assert.ok(combos.every(result => result.operations.includes('brow-one')));
  assert.ok(draws.some(result => result.droppedChannels.length === 0));

  // With no brow channel at all the brow operations disappear entirely.
  const noBrow = selector.query({ state: 'thinking', event: 'confused', intent: 'confusion', verifiedChannels: ['headX', 'headY', 'headZ'] });
  assert.ok(noBrow.length > 0);
  assert.ok(noBrow.every(preset => !preset.requires.includes('browL') && !preset.requires.includes('browR')));
});

// ---------------------------------------------------------------------------------------------
// 9. gaze-target and head-turn direction need explicit proofs
// ---------------------------------------------------------------------------------------------
test('gaze-target needs a real target; sound direction needs its own proof', () => {
  const selector = createPresetSelector();
  const listening = { state: 'listening', event: 'user-speaking', verifiedChannels: FULL_CHANNELS };
  const without = draw(selector, listening, 300);
  assert.ok(presetsOnly(without).length > 100);
  assert.ok(presetsOnly(without).every(result => !presetOf(selector, result).requiresTarget));
  assert.ok(presetsOnly(without).every(result => !presetOf(selector, result).requiresDirection));
  assert.equal(selector.query({ ...listening, targetVerified: 1 }).filter(preset => preset.requiresTarget).length, 0);

  const withTarget = selector.query({ ...listening, targetVerified: true });
  assert.ok(withTarget.some(preset => preset.requiresTarget));
  assert.ok(withTarget.every(preset => !preset.requiresDirection));
  const withDirection = selector.query({ ...listening, directionVerified: true });
  assert.ok(withDirection.some(preset => preset.requiresDirection));
  const withBoth = selector.query({ ...listening, targetVerified: true, directionVerified: true });
  assert.ok(withBoth.some(preset => preset.requiresTarget && preset.requiresDirection));
});

// ---------------------------------------------------------------------------------------------
// 10. Empty candidates hold; safety and disposal hold
// ---------------------------------------------------------------------------------------------
test('an exhausted candidate set holds and never bypasses a hard constraint', () => {
  const selector = createPresetSelector();
  const noChannels = selector.select(idle({ verifiedChannels: [] }));
  assert.equal(noChannels.kind, 'hold');
  assert.equal(noChannels.presetId, null);
  assert.ok(noChannels.reasons.includes('no-candidates'));

  for (const [context, reason] of [
    [idle({ privacy: true }), 'privacy'],
    [idle({ disposed: true }), 'disposed'],
    [{}, 'invalid-context'],
    [idle({ verifiedChannels: 'headX' }), 'invalid-channels'],
  ]) {
    const held = selector.select(context);
    assert.equal(held.kind, 'hold');
    assert.ok(held.reasons.includes(reason), `${reason}: ${held.reasons.join(',')}`);
  }

  const allFamilies = [...selector.index.byFamily.keys()];
  const disabledAll = selector.select(idle({ overrides: { disabledFamilies: allFamilies, disabled: PRESETS.map(preset => preset.id) } }));
  assert.equal(disabledAll.kind, 'hold');
  assert.ok(disabledAll.reasons.includes('no-candidates'));
  assert.equal(selector.select({}).kind, 'hold');
  assert.deepEqual(selector.query(), []);
});

// ---------------------------------------------------------------------------------------------
// 11. Recent-family repetition penalty and frequency constraint
// ---------------------------------------------------------------------------------------------
test('recent-family repetition and frequency history make a candidate less likely', () => {
  const families = [...new Set(PRESETS.map(preset => preset.family))];
  const keep = ['posture', 'attention', 'settle', 'blink'];
  const selector = createPresetSelector({
    overrides: {
      familyPriority: { posture: 100 },
      disabledFamilies: families.filter(family => !keep.includes(family)),
    },
  });
  const baseline = selector.explain(idle());
  assert.equal(baseline.relaxed, false);
  const repeated = selector.explain(idle({ recent: { families: ['posture', 'posture', 'posture'] } }));
  const weightOf = (explain, family) => explain.families.find(entry => entry.family === family).weight;
  assert.ok(weightOf(repeated, 'posture') < weightOf(baseline, 'posture') * 0.5);
  assert.equal(weightOf(repeated, 'attention'), weightOf(baseline, 'attention'));

  // Sequential sampling with a three-draw memory is measurably more even than independent draws.
  const run = (withRecent) => {
    const counts = new Map();
    const recent = [];
    for (let index = 0; index < 1000; index += 1) {
      const result = selector.select(idle({
        seed: 1000 + index,
        recent: withRecent ? { families: [...recent] } : undefined,
      }));
      if (result.kind !== 'preset') continue;
      counts.set(result.family, (counts.get(result.family) ?? 0) + 1);
      if (withRecent) {
        recent.push(result.family);
        if (recent.length > 3) recent.shift();
      }
    }
    return counts;
  };
  const independent = run(false);
  const adaptive = run(true);
  const maxShare = counts => Math.max(...[...counts.values()]) / 1000;
  assert.ok(maxShare(adaptive) < maxShare(independent) - 0.03, `${maxShare(adaptive)} vs ${maxShare(independent)}`);

  // Frequency is its own soft penalty, and only inside the window.
  const history = Array.from({ length: 6 }, (_, index) => ({ id: 'idle-tilt.flow', at: 1000 + index * 1000 }));
  const frequencyWeight = (context) => {
    const explain = selector.explain(context);
    const family = explain.families.find(entry => entry.family === 'posture');
    const recipe = family.recipes.find(entry => entry.recipe === 'idle-tilt');
    return recipe.variants.find(variant => variant.presetId === 'idle-tilt.flow').weight;
  };
  const freshWeight = frequencyWeight(idle({ }));
  const heavyWeight = frequencyWeight(idle({ history, now: 10_000, frequencyWindowMs: 60_000 }));
  assert.ok(heavyWeight < freshWeight * 0.5);
  const staleWeight = frequencyWeight(idle({ history, now: 10_000 + 120_000, frequencyWindowMs: 60_000 }));
  assert.equal(staleWeight, freshWeight);
});

// ---------------------------------------------------------------------------------------------
// 12. Priority 0 / 50 / 100 stay bounded and ordered
// ---------------------------------------------------------------------------------------------
test('user priority 0/50/100 is ordered but never a guarantee', () => {
  const context = { state: 'thinking', event: 'thinking', verifiedChannels: FULL_CHANNELS };
  const sample = 2500;
  const shareFor = (priority) => {
    const selector = createPresetSelector({ overrides: { actionPriority: { 'think-up': priority } } });
    return presetsOnly(draw(selector, context, sample)).filter(result => result.recipe === 'think-up').length / sample;
  };
  const low = shareFor(0);
  const normal = shareFor(50);
  const high = shareFor(100);
  assert.ok(low > 0.003, `priority 0 stays reachable: ${low}`);
  assert.ok(low < normal, `${low} < ${normal}`);
  assert.ok(normal < high, `${normal} < ${high}`);
  assert.ok(high > normal * 1.5, `${high} vs ${normal}`);
  assert.ok(high < 0.9, 'priority 100 does not lock out the rest');
  assert.equal(PRESET_SELECTOR_CONSTANTS.DEFAULT_PRIORITY, 50);
});

// ---------------------------------------------------------------------------------------------
// 13. Index and queries
// ---------------------------------------------------------------------------------------------
test('the in-memory index answers state/event/family/style queries', () => {
  const index = createPresetIndex();
  const stats = index.stats();
  assert.equal(stats.presets, PRESETS.length);
  assert.equal(stats.recipes, RECIPES.length);
  assert.equal(stats.styles, STYLES.length);
  assert.equal(stats.families, new Set(PRESETS.map(preset => preset.family)).size);
  assert.equal(stats.variants, 4);
  assert.equal(stats.byState.idle, PRESETS.filter(preset => preset.states.includes('idle')).length);

  assert.equal(index.find({ state: 'idle' }).length, stats.byState.idle);
  const gentleIdle = index.find({ state: 'idle', style: 'gentle' });
  assert.ok(gentleIdle.length > 0);
  assert.ok(gentleIdle.every(preset => preset.states.includes('idle') && preset.styles.includes('gentle')));
  assert.deepEqual(index.find({ state: 'unknown' }), []);
  assert.deepEqual(index.find({ style: 'unknown' }), []);
  assert.equal(index.byId.get(PRESETS[0].id), PRESETS[0]);
  assert.equal(index.byStyle.size, STYLES.length);

  // The selector accepts a pre-built index and narrows by family/style/recipe.
  const selector = createPresetSelector({ catalog: index });
  const posture = selector.query({ state: 'idle', event: 'idle', verifiedChannels: FULL_CHANNELS, family: 'posture' });
  assert.ok(posture.length > 0);
  assert.ok(posture.every(preset => preset.family === 'posture'));
  const styleQuery = selector.query({ state: 'idle', event: 'idle', verifiedChannels: FULL_CHANNELS, style: 'dreamy' });
  assert.ok(styleQuery.length > 0);
  assert.ok(styleQuery.every(preset => preset.styles.includes('dreamy')));
});

// ---------------------------------------------------------------------------------------------
// 14. Candidate shortage relaxes soft penalties only
// ---------------------------------------------------------------------------------------------
test('a candidate shortage relaxes soft penalties but never a hard constraint', () => {
  const selector = createPresetSelector();
  const tight = idle({ verifiedChannels: ['gazeX'] });
  const explained = selector.explain(tight);
  assert.equal(explained.families.length, 1);
  assert.equal(explained.relaxed, true);

  const withHistory = selector.explain({
    ...tight,
    recent: { families: ['attention'], actions: ['idle-eye-side.flow'] },
    history: [{ id: 'idle-eye-side.flow', at: 1000 }],
    now: 2000,
  });
  assert.equal(withHistory.relaxed, true);
  assert.equal(withHistory.families[0].weight, explained.families[0].weight);

  const result = selector.select({ ...tight, seed: 7 });
  assert.equal(result.kind, 'preset');
  assert.ok(result.reasons.includes('candidate-shortage'));
  assert.ok(result.reasons.includes('relaxed-soft-penalties'));
  assert.deepEqual(result.requires, ['gazeX']);
  assert.ok(result.requires.every(channel => channel === 'gazeX'));
});

// ---------------------------------------------------------------------------------------------
// 15. Construction validation and bounded overrides
// ---------------------------------------------------------------------------------------------
test('construction rejects a malformed catalog and clamps user overrides', () => {
  assert.throws(() => createPresetSelector({ presets: [] }), TypeError);
  assert.throws(() => createPresetSelector({ presets: [{ id: 'broken' }] }), TypeError);
  assert.throws(() => createPresetSelector({ presets: [PRESETS[0], PRESETS[0]] }), TypeError);
  assert.throws(() => createPresetSelector({ minFamilies: 0 }), TypeError);

  const selector = createPresetSelector({
    overrides: {
      disabled: ['no-such-preset'],
      familyPriority: { posture: 999, attention: -5 },
      actionPriority: { 'no-such-recipe': 'not-a-number', 'idle-tilt': 75 },
    },
  });
  assert.equal(selector.overrides.familyPriority.get('posture'), 100);
  assert.equal(selector.overrides.familyPriority.get('attention'), 0);
  assert.equal(selector.overrides.actionPriority.get('idle-tilt'), 75);
  assert.ok(!selector.overrides.actionPriority.has('no-such-recipe'));
  assert.ok(selector.select(idle({ seed: 3 })).kind === 'preset');
  assert.equal(selector.stats().presets, PRESETS.length);
});

// ---------------------------------------------------------------------------------------------
// 16. idle-sway — neutral slow headX sway, selectable in idle / waiting / tired
// ---------------------------------------------------------------------------------------------
test('idle-sway is catalogued, unique, and selectable on the headX idle channel', () => {
  const recipe = RECIPES.find(entry => entry.id === 'idle-sway');
  assert.ok(recipe !== undefined, 'idle-sway recipe exists');
  assert.equal(recipe.label, '左右轻摇');
  assert.equal(recipe.family, 'posture');
  assert.deepEqual([...recipe.states].sort(), ['idle', 'tired', 'waiting']);
  assert.deepEqual([...recipe.events], ['idle']);
  assert.equal(recipe.semantic, 'neutral');
  assert.deepEqual([...recipe.operations], ['head-sway']);
  assert.deepEqual([...recipe.requires], ['headX']);
  for (const style of ['gentle', 'dreamy', 'composed']) {
    assert.ok(recipe.styles.includes(style), `idle-sway style ${style}`);
  }
  assert.deepEqual([...OPERATIONS['head-sway']], ['headX']);

  // It shares the headX oscillator with shake but is a distinct operation, and it never uses the
  // roll channel that idle-tilt owns.
  const tilt = RECIPES.find(entry => entry.id === 'idle-tilt');
  assert.notEqual(recipe.id, tilt.id);
  assert.deepEqual([...tilt.requires], ['headZ']);
  assert.notDeepEqual([...recipe.requires], [...tilt.requires]);

  const presetIds = PRESETS.map(preset => preset.id);
  assert.equal(new Set(presetIds).size, presetIds.length, 'preset ids are unique');
  const recipeIds = RECIPES.map(entry => entry.id);
  assert.equal(new Set(recipeIds).size, recipeIds.length, 'recipe ids are unique');
  const swayPresets = PRESETS.filter(preset => preset.recipeId === 'idle-sway');
  assert.equal(swayPresets.length, VARIANTS.length);
  assert.ok(swayPresets.every(preset => preset.states.includes('idle')
    && preset.operations.includes('head-sway') && preset.requires.includes('headX')));

  const selector = createPresetSelector();
  for (const state of ['idle', 'waiting', 'tired']) {
    const candidates = selector.query({ state, event: 'idle', verifiedChannels: FULL_CHANNELS });
    assert.ok(candidates.some(preset => preset.recipeId === 'idle-sway'),
      `${state} candidates include idle-sway`);
  }

  // The autonomous idle pool can really draw it, without recipe narrowing or a priority override.
  let natural = null;
  for (let seed = 0; seed < 5000 && natural === null; seed += 1) {
    const result = selector.select(idle({ seed }));
    if (result.kind === 'preset' && result.recipe === 'idle-sway') natural = result;
  }
  assert.ok(natural !== null, 'idle-sway can be drawn from the idle pool');
  assert.ok(natural.operations.includes('head-sway'));

  // A waiting draw narrows to the recipe and still executes through the selector's contract.
  const narrowed = selector.select({
    state: 'waiting', event: 'idle', verifiedChannels: FULL_CHANNELS, recipe: 'idle-sway', seed: 11,
  });
  assert.equal(narrowed.kind, 'preset');
  assert.equal(narrowed.recipe, 'idle-sway');
  assert.deepEqual([...narrowed.requires], ['headX']);
});

