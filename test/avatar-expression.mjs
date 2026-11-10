/**
 * avatar-expression — the "表现倾向 → 动作选择" layer above the seven numeric dimensions.
 *
 * Run: node --test test/avatar-expression.mjs
 *
 * What this file proves:
 *   1. `style.expression` is OPTIONAL and absent stays `null` (never a fabricated 0.5);
 *   2. only concrete behavioural model answers become tendencies, broad words stay unclassified;
 *   3. the style parser clamps/rejects malformed expression data without touching numerics;
 *   4. `avatarExpressionStyleTags` maps tendencies onto soft tags at 0.7×, max-merged;
 *   5. the selector distribution shifts for the matching recipes, while hard event gates,
 *      user disables and priorities still win;
 *   6. the controller passes the expression through to preset selection, and the numeric idle
 *      chain / dimensions are bit-for-bit unchanged by it;
 *   7. a fixed seed reproduces the same selection.
 *
 * The model itself is stubbed below: a deterministic "description → model answer" fixture stands
 * in for the real LLM, because the parser must never classify persona text by itself.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AVATAR_EXPRESSION_STYLE_TAGS,
  AVATAR_EXPRESSION_TAG_SCALE,
  AVATAR_EXPRESSION_TENDENCIES,
  AVATAR_STYLE_FIELDS,
  DEFAULT_AVATAR_STYLE,
  avatarExpressionStyleTags,
  buildAvatarStylePrompt,
  coerceAvatarStyle,
  createAvatarStyleCache,
  deriveAvatarStyleDimensions,
  normalizeAvatarStyle,
  parseAvatarStyle,
} from '../src/host/avatar/style.js';
import { createPresetSelector } from '../src/host/avatar/preset-selector.js';
import { createBehaviorRuntime } from '../src/host/avatar/motion-controller.js';
import { OPERATIONS } from '../src/host/avatar/presets/index.js';

const FULL_CHANNELS = Object.freeze([...new Set(Object.values(OPERATIONS).flat())]);
const seedAt = index => (0x9e3779b9 + index * 2654435761) >>> 0;
const approx = (actual, expected, message) => assert.ok(
  Math.abs(actual - expected) < 1e-9,
  `${message} (actual=${actual}, expected=${expected})`,
);

/** Recipe groups that carry the tags of one tendency (from the read-only preset library). */
const RECIPE_GROUPS = Object.freeze({
  tender: Object.freeze(['idle-tilt', 'idle-tilt-side', 'idle-sway']),
  playful: Object.freeze(['idle-side-tilt', 'idle-eye-up', 'idle-double-blink', 'idle-body-tilt']),
  shy: Object.freeze(['idle-tilt', 'idle-eye-side', 'end-side', 'uncertain-side']),
  composed: Object.freeze(['idle-center', 'idle-eye-down', 'idle-head-eye', 'idle-body-settle']),
});

const idleContext = (persona, over = {}) => ({
  state: 'idle',
  event: 'idle',
  verifiedChannels: FULL_CHANNELS,
  persona,
  ...over,
});

const presetCount = (results, group) => results.filter(
  result => result.kind === 'preset' && group.includes(result.recipe),
).length;

/** Minimal full numeric style so expression is the only changing input. */
const NUMERIC_STYLE = Object.freeze({
  amplitude: 1,
  tempo: 1,
  gazeHabit: 'steady',
  expressiveness: 1,
  nodAmplitude: 1,
  nodDurationMs: 450,
  tiltChance: 0.15,
});

// ---------------------------------------------------------------------------------------------
// 1. Parsing: concrete tendencies coexist, values clamp, unknown names are reported
// ---------------------------------------------------------------------------------------------

test('1. expression parses as an optional tendency map; concrete profiles can coexist', () => {
  assert.ok(AVATAR_STYLE_FIELDS.includes('expression'));
  assert.equal(DEFAULT_AVATAR_STYLE.expression, null, 'default is unclassified, not 0.5');

  const parsed = parseAvatarStyle(JSON.stringify({
    amplitude: 1.1,
    expression: { tender: 0.8, playful: 1.4, shy: -0.2, mystery: 0.9 },
  }));
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.style.expression, { tender: 0.8, playful: 1 },
    'multiple tendencies coexist; each weight clamps to 0..1; a zero weight is not a tendency');
  assert.deepEqual(parsed.ignored, ['expression.mystery'], 'unknown tendency names are ignored');
  assert.deepEqual(parsed.invalid, []);
  assert.equal(parsed.style.amplitude, 1.1, 'the numeric fields still parse normally');
  assert.ok(parsed.changed.includes('expression'));

  const single = parseAvatarStyle(JSON.stringify({ expression: { shy: 0.65 } }));
  assert.deepEqual(single.style.expression, { shy: 0.65 });
  console.log(`[expression] parsed=${JSON.stringify(parsed.style.expression)} single=${JSON.stringify(single.style.expression)}`);
});

// ---------------------------------------------------------------------------------------------
// 2. Broad words: the model omits expression, so the classification stays null
// ---------------------------------------------------------------------------------------------

test('2. broad wording omits expression; a persona refresh does not inherit a stale tendency', async () => {
  const broad = parseAvatarStyle(JSON.stringify({ amplitude: 1.05 }));
  assert.equal(broad.ok, true);
  assert.equal(broad.style.expression, null, 'a broad "cute" answer leaves expression unclassified');

  const previous = { ...DEFAULT_AVATAR_STYLE, expression: { playful: 0.9 } };
  const refreshed = parseAvatarStyle(JSON.stringify({ amplitude: 1.05 }), { base: previous });
  assert.equal(refreshed.style.expression, null,
    'an omitted expression on a persona refresh clears the previous classification');
  assert.ok(refreshed.changed.includes('expression'));

  // The real pipeline: the generator returns expression only for concrete descriptions.
  const generate = ({ personaText }) => {
    if (personaText.includes('捉弄') || personaText.includes('反应轻快')) {
      return JSON.stringify({ expressiveness: 1.2, expression: { playful: 0.85 } });
    }
    if (personaText.includes('害羞') || personaText.includes('看开')) {
      return JSON.stringify({ tiltChance: 0.2, expression: { shy: 0.8 } });
    }
    // "可爱" / "温柔" alone: concrete behaviour is absent, so the model omits expression.
    return JSON.stringify({ amplitude: 1.05, tiltChance: 0.1 });
  };
  const persisted = [];
  const cache = createAvatarStyleCache({
    generate,
    persist: state => persisted.push(structuredClone(state)),
  });

  const tease = await cache.refresh('很爱捉弄人，反应轻快，常常一句话就接上来');
  assert.deepEqual(tease.style.expression, { playful: 0.85 }, 'concrete teasing → playful');
  const shy = await cache.refresh('害羞，常看开，不太敢一直对视');
  assert.deepEqual(shy.style.expression, { shy: 0.8 }, 'concrete shy behaviour → shy');
  const cute = await cache.refresh('可爱');
  assert.equal(cute.style.expression, null, 'broad 可爱 → no forced tendency');
  assert.deepEqual(persisted.at(-1).style.expression, null, 'the cleared classification is persisted');

  const prompt = buildAvatarStylePrompt({ personaText: '可爱' });
  assert.match(prompt.system, /expression/);
  assert.match(prompt.system, /OMIT expression/);
  assert.match(prompt.system, /CONCRETE behavioural description/);
  assert.match(prompt.system, /Do not guess/);
  assert.match(prompt.prompt, /宽泛词时省略 expression/);
  assert.match(prompt.prompt, /爱捉弄人/);
  assert.match(prompt.prompt, /害羞/);
  console.log(`[expression] tease=${JSON.stringify(tease.style.expression)} shy=${JSON.stringify(shy.style.expression)} cute=${JSON.stringify(cute.style.expression)}`);
});

// ---------------------------------------------------------------------------------------------
// 3. Malformed / legacy data: never touches numeric fields, never invents a tendency
// ---------------------------------------------------------------------------------------------

test('3. malformed and legacy styles keep numerics and the old classification', () => {
  const legacy = { amplitude: 0.7, tempo: 1.2, tiltChance: 0.2, channels: { headX: { amplitude: 0.6 } } };
  const coerced = coerceAvatarStyle(legacy);
  assert.equal(coerced.amplitude, 0.7);
  assert.equal(coerced.tempo, 1.2);
  assert.equal(coerced.tiltChance, 0.2);
  assert.deepEqual(coerced.channels, { headX: { amplitude: 0.6 } });
  assert.equal(coerced.expression, null, 'a legacy style without expression is valid and unclassified');
  assert.deepEqual(coerceAvatarStyle(undefined), DEFAULT_AVATAR_STYLE, 'missing style still defaults cleanly');

  const base = { ...DEFAULT_AVATAR_STYLE, amplitude: 0.8, tempo: 1.1, expression: { tender: 0.6 } };
  const broken = normalizeAvatarStyle(
    { amplitude: 0.9, expression: { tender: 'a lot', mystery: 1 } },
    { base },
  );
  assert.equal(broken.ok, true);
  assert.equal(broken.style.amplitude, 0.9, 'a valid numeric field still applies');
  assert.equal(broken.style.tempo, 1.1, 'untouched numerics keep the base');
  assert.deepEqual(broken.style.expression, { tender: 0.6 },
    'damaged tendency data keeps the previous valid classification');
  assert.deepEqual(broken.invalid, ['expression.tender']);
  assert.deepEqual(broken.ignored, ['expression.mystery']);

  for (const bad of ['shy', ['tender'], 42]) {
    const result = normalizeAvatarStyle({ expression: bad, amplitude: 0.5 }, { base });
    assert.equal(result.ok, true);
    assert.deepEqual(result.invalid, ['expression'], `non-object expression ${JSON.stringify(bad)} is invalid`);
    assert.equal(result.style.amplitude, 0.5);
    assert.deepEqual(result.style.expression, { tender: 0.6 }, 'invalid expression leaves the old value');
  }

  assert.equal(coerceAvatarStyle({ expression: 'shy' }).expression, null);
  assert.equal(coerceAvatarStyle({ expression: { tender: 0 } }).expression, null,
    'an all-zero map means "no tendency", not a classification at 0');

  // Expression is a selection hint only: it cannot move the dimensions or their seed.
  const version = 'v1-expression-chain';
  const plain = deriveAvatarStyleDimensions({ ...NUMERIC_STYLE, expression: null }, { styleVersion: version });
  const withExpression = deriveAvatarStyleDimensions(
    { ...NUMERIC_STYLE, expression: { tender: 1, playful: 0.4 } },
    { styleVersion: version },
  );
  assert.deepEqual(withExpression, plain, 'dimensions and seed are unchanged by expression');
  assert.deepEqual(
    deriveAvatarStyleDimensions({ ...NUMERIC_STYLE, expression: { tender: 1 } }),
    deriveAvatarStyleDimensions({ ...NUMERIC_STYLE, expression: null }),
    'the canonical (version-less) seed also ignores expression',
  );
  console.log(`[expression] legacy=${JSON.stringify(coerced.expression)} brokenKept=${JSON.stringify(broken.style.expression)} seedUnchanged=${withExpression.seed === plain.seed}`);
});

// ---------------------------------------------------------------------------------------------
// 4. Tendency → soft style tags (0.7×, max merged, never additive)
// ---------------------------------------------------------------------------------------------

test('4. tendency tags follow the documented mapping at 0.7× and merge by max', () => {
  assert.deepEqual(AVATAR_EXPRESSION_TENDENCIES, ['tender', 'playful', 'shy', 'composed']);
  assert.equal(AVATAR_EXPRESSION_TAG_SCALE, 0.7);
  assert.deepEqual(AVATAR_EXPRESSION_STYLE_TAGS.tender, ['gentle', 'warm', 'dreamy']);
  assert.deepEqual(AVATAR_EXPRESSION_STYLE_TAGS.playful, ['playful', 'lively', 'curious']);
  assert.deepEqual(AVATAR_EXPRESSION_STYLE_TAGS.shy, ['shy', 'reserved', 'dreamy']);
  assert.deepEqual(AVATAR_EXPRESSION_STYLE_TAGS.composed, ['composed', 'elegant', 'cool']);

  assert.deepEqual(avatarExpressionStyleTags({ expression: { tender: 1 } }),
    { gentle: 0.7, warm: 0.7, dreamy: 0.7 },
    'a full tendency maps to three soft tags at 0.7×');

  const multi = avatarExpressionStyleTags({ expression: { tender: 0.6, shy: 0.4 } });
  approx(multi.dreamy, 0.42, 'shared tags merge by MAX (0.6×0.7), never by addition');
  approx(multi.gentle, 0.42);
  approx(multi.shy, 0.28);
  approx(multi.reserved, 0.28);

  assert.deepEqual(avatarExpressionStyleTags({ expression: null }), {}, 'unclassified adds no bias');
  assert.deepEqual(avatarExpressionStyleTags({ expression: { shy: 0 } }), {}, 'a zero tendency adds no bias');
  assert.deepEqual(avatarExpressionStyleTags({}), {});
  assert.deepEqual(avatarExpressionStyleTags({ expression: { tender: 0.5 } }, { scale: 2 }),
    { gentle: 1, warm: 1, dreamy: 1 }, 'the scale is clamped at 1');
  console.log(`[expression] multi=${JSON.stringify(multi)}`);
});

// ---------------------------------------------------------------------------------------------
// 5. Selection layer: matching recipes get more weight, hard gates stay hard
// ---------------------------------------------------------------------------------------------

test('5. expression shifts the selector distribution per tendency', () => {
  const selector = createPresetSelector();
  const draw = (expression) => {
    const styles = avatarExpressionStyleTags({ expression });
    return Array.from({ length: 600 }, (_, index) => selector.select(idleContext(
      { styles },
      { seed: seedAt(index) },
    )));
  };
  const neutral = draw(null);
  const results = {
    tender: draw({ tender: 1 }),
    playful: draw({ playful: 1 }),
    shy: draw({ shy: 1 }),
    composed: draw({ composed: 1 }),
  };
  const baseline = Object.fromEntries(
    Object.entries(RECIPE_GROUPS).map(([name, group]) => [name, presetCount(neutral, group)]),
  );
  const shifted = Object.fromEntries(
    Object.entries(RECIPE_GROUPS).map(([name, group]) => [name, presetCount(results[name], group)]),
  );

  assert.ok(shifted.tender > baseline.tender + 10,
    `tender increases gentle/dreamy recipes (${baseline.tender} → ${shifted.tender})`);
  assert.ok(shifted.playful > baseline.playful + 40,
    `playful increases playful/lively recipes (${baseline.playful} → ${shifted.playful})`);
  assert.ok(shifted.shy > baseline.shy + 10,
    `shy increases shy/reserved recipes (${baseline.shy} → ${shifted.shy})`);
  assert.ok(shifted.composed > baseline.composed + 25,
    `composed increases composed/elegant recipes (${baseline.composed} → ${shifted.composed})`);

  // A fixed seed reproduces the whole selection, expression included.
  const first = selector.select(idleContext({ styles: avatarExpressionStyleTags({ expression: { playful: 0.8 } }) }, { seed: 424242 }));
  const second = createPresetSelector().select(idleContext(
    { styles: avatarExpressionStyleTags({ expression: { playful: 0.8 } }) },
    { seed: 424242 },
  ));
  assert.deepEqual(first, second);

  assert.ok(results.playful.some(result => result.kind === 'preset'));
  console.log(`[expression] neutral=${JSON.stringify(baseline)} shifted=${JSON.stringify(shifted)}`);
});

test('6. expression never bypasses user disables, priorities or the event gate', () => {
  const styles = avatarExpressionStyleTags({ expression: { tender: 1 } });
  const disabled = createPresetSelector({ overrides: { disabledFamilies: ['posture'] } });
  const draws = Array.from({ length: 240 }, (_, index) => disabled.select(idleContext(
    { styles },
    { seed: seedAt(index) },
  )));
  assert.ok(draws.some(result => result.kind === 'preset'), 'the draw still selects elsewhere');
  assert.ok(draws.every(result => result.kind === 'hold' || result.family !== 'posture'),
    'a soft tendency never re-enables a disabled family');

  const prioritized = createPresetSelector({
    overrides: { actionPriority: { 'idle-tilt': 100 } },
  });
  let chosen = null;
  for (let seed = 0; seed < 256 && chosen === null; seed += 1) {
    const result = prioritized.select(idleContext({ styles }, { seed, recipe: 'idle-tilt' }));
    if (result.kind === 'preset') chosen = result;
  }
  assert.ok(chosen !== null, 'the prioritised recipe is selectable');
  assert.ok(chosen.reasons.includes('priority:100'), 'the user priority is still reported');
  assert.ok(chosen.reasons.some(reason => reason.startsWith('persona-fit:')),
    'expression is only the soft persona-fit factor');

  const gate = prioritized.select(idleContext(
    { styles },
    { recipe: 'welcome-nod', seed: 1 },
  ));
  assert.equal(gate.kind, 'hold',
    'an idle context still cannot fire a greeting; expression is not an event override');
  assert.ok(gate.reasons.includes('no-candidates'));
  console.log(`[expression] disabledDraws=${draws.length} priority=${chosen.reasons.find(reason => reason.startsWith('priority:'))} gate=${gate.kind}`);
});

// ---------------------------------------------------------------------------------------------
// 6. Controller wiring: presetPersona and the soft component draw hear the expression; the numeric
//    base goal / dimensions do not
// ---------------------------------------------------------------------------------------------

test('7. controller preset/component selection uses expression while the numeric base chain stays identical', () => {
  const makeRuntime = style => createBehaviorRuntime({
    config: {
      seed: 11,
      presetExecution: true,
      presetTargetVerified: true,
      presetChannels: FULL_CHANNELS,
      style,
    },
  });
  const draw = (expression) => {
    const runtime = makeRuntime({ ...NUMERIC_STYLE, expression });
    return Array.from({ length: 600 }, (_, index) => runtime.selectPreset({
      state: 'idle',
      event: 'idle',
      seed: seedAt(index),
    }));
  };
  const neutral = draw(null);
  const playful = draw({ playful: 1 });
  const baseline = presetCount(neutral, RECIPE_GROUPS.playful);
  const withExpression = presetCount(playful, RECIPE_GROUPS.playful);
  assert.ok(withExpression > baseline + 40,
    `the controller really passes expression into selection (${baseline} → ${withExpression})`);

  // Broad / legacy styles must be indistinguishable: expression:null adds no forced bias.
  const legacyRuntime = makeRuntime({ ...NUMERIC_STYLE });
  const nullRuntime = makeRuntime({ ...NUMERIC_STYLE, expression: null });
  for (let seed = 0; seed < 60; seed += 1) {
    const legacy = legacyRuntime.selectPreset({ state: 'idle', event: 'idle', seed });
    const nulled = nullRuntime.selectPreset({ state: 'idle', event: 'idle', seed });
    assert.deepEqual(nulled, legacy, 'expression:null selects exactly like a legacy style');
  }

  // Snapshot/passthrough: baseline and effective both expose the classification; status changes
  // and relaxation pass it through verbatim rather than scaling it.
  const runtime = makeRuntime({ ...NUMERIC_STYLE, expression: { tender: 0.8 } });
  assert.deepEqual(runtime.snapshot().style.baseline.expression, { tender: 0.8 });
  runtime.tick(0);
  assert.deepEqual(runtime.snapshot().style.effective.expression, { tender: 0.8 });
  runtime.setStatus('thinking');
  runtime.tick(1000);
  assert.deepEqual(runtime.snapshot().style.effective.expression, { tender: 0.8 });

  // Numeric chain: the same seed keeps the numeric base goal/dimensions identical. The persona
  // tendency is allowed to bias the SOFT component draw (commit d981072: expression reaches the
  // head/gaze component selection and its amplitude); it still never rewrites the numeric posture
  // draw, the hold drift or the style dimensions. Assert that split explicitly instead of demanding
  // bit-identical head poses, which would pin the old selection-only behaviour.
  const numericRun = (expression) => {
    const rt = createBehaviorRuntime({
      config: { seed: 7, idleActions: [], style: { ...NUMERIC_STYLE, expression } },
    });
    const poses = [];
    for (let at = 0; at <= 3000; at += 100) {
      rt.tick(at);
      poses.push(rt.snapshot().pose);
    }
    const snapshot = rt.snapshot();
    return {
      poses,
      dimensions: snapshot.style.dimensions,
      baseline: snapshot.style.baseline,
      base: snapshot.motion.posture.base,
      drift: snapshot.motion.holdDrift,
      component: snapshot.motion.posture.component,
    };
  };
  const plain = numericRun(null);
  const classified = numericRun({ tender: 1, playful: 0.5 });
  assert.deepEqual(classified.dimensions, plain.dimensions, 'expression never changes dimensions');
  assert.equal(classified.baseline.amplitude, plain.baseline.amplitude);
  assert.equal(classified.baseline.tempo, plain.baseline.tempo);
  // The numeric idle draw and drift are bit-for-bit the same; only the component layer differs.
  assert.deepEqual(classified.base, plain.base, 'expression never changes the numeric idle base draw');
  assert.deepEqual(classified.drift, plain.drift, 'expression never changes the hold drift');
  assert.notDeepEqual(classified.component.targetSemantic, plain.component.targetSemantic,
    'expression really reaches the component amplitude (the new selection-only exception)');
  const headChannels = new Set(['headX', 'headY', 'headZ']);
  for (const [index, pose] of plain.poses.entries()) {
    for (const [channel, numeric] of Object.entries(pose)) {
      if (headChannels.has(channel)) continue;
      assert.equal(classified.poses[index][channel], numeric,
        `expression never changes the numeric ${channel} channel`);
    }
    for (const channel of headChannels) {
      assert.ok(Math.abs(classified.poses[index][channel] - pose[channel]) <= 0.05,
        `the component-only ${channel} difference stays inside the component band`);
    }
  }
  // Both are still ordinary natural holds: expression shifts WHERE inside the 5–8° band, not the band.
  for (const run of [plain, classified]) {
    const headZDegrees = run.component.targetDegrees.headZ;
    assert.ok(headZDegrees >= 5 && headZDegrees <= 8,
      `the natural component headZ ${headZDegrees.toFixed(2)}° stays in its 5–8° band`);
  }
  console.log(`[expression] controller ${baseline}→${withExpression} poses=${plain.poses.length}`
    + ` component headZ ${plain.component.targetDegrees.headZ.toFixed(2)}°→`
    + `${classified.component.targetDegrees.headZ.toFixed(2)}° version=${JSON.stringify(plain.dimensions.seed)}`);
});
