/**
 * Persona-weighted head/gaze component selection.
 *
 * Run: node --test test/motion-persona-components.mjs
 *
 * The persona is a SOFT WEIGHT, not a fixed template: it changes the probability of the next
 * component shape (and biases the amplitude/hold inside the existing bands), but every shape stays
 * reachable, the same seed reproduces the same trajectory, and the current shape is still excluded
 * from the next draw. These tests sample the PURE controller (no transport), so the only input is
 * the style + seed and the only output is the controller's own deterministic draw.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COMPONENT_SELECTION_WEIGHT_FLOOR,
  POSTURE_COMPONENT_CHANNELS,
  POSTURE_COMPONENT_MAX_AMPLITUDE,
  POSTURE_COMPONENT_MAX_MS,
  POSTURE_COMPONENT_MIN_MS,
  POSTURE_GAZE_COMPONENT_MAX_AMPLITUDE,
  POSTURE_GAZE_COMPONENT_MAX_MS,
  POSTURE_GAZE_COMPONENT_MIN_MS,
  createBehaviorRuntime,
  gazeComponentWeights,
  personaComponentBias,
  postureComponentWeights,
} from '../src/host/avatar/motion-controller.js';

const DT = 1000 / 30;
const HEAD_IDS = ['natural', 'lean-left', 'lean-right', 'look-back'];
const GAZE_IDS = ['gaze-left', 'gaze-right', 'gaze-up', 'gaze-down', 'gaze-center'];

/**
 * Four deliberately different personas. Numeric fields drive the seven traits; `expression` is the
 * optional behavioural classification. The two inputs are combined by the controller, not by the
 * test, so a change in either one is observed end to end.
 */
const STYLES = Object.freeze({
  lively: Object.freeze({
    amplitude: 1.5,
    tempo: 1.45,
    expressiveness: 1.5,
    nodAmplitude: 1.5,
    nodDurationMs: 260,
    tiltChance: 0.45,
    gazeHabit: 'wandering',
    expression: Object.freeze({ playful: 1 }),
  }),
  soft: Object.freeze({
    amplitude: 0.45,
    tempo: 0.65,
    expressiveness: 0.35,
    nodAmplitude: 0.5,
    nodDurationMs: 880,
    tiltChance: 0,
    gazeHabit: 'steady',
    expression: Object.freeze({ tender: 1 }),
  }),
  shy: Object.freeze({
    amplitude: 0.7,
    tempo: 0.85,
    expressiveness: 0.5,
    nodAmplitude: 0.6,
    nodDurationMs: 700,
    tiltChance: 0.05,
    gazeHabit: 'steady',
    expression: Object.freeze({ shy: 1 }),
  }),
  composed: Object.freeze({
    amplitude: 0.75,
    tempo: 0.7,
    expressiveness: 0.6,
    nodAmplitude: 0.7,
    nodDurationMs: 760,
    tiltChance: 0.05,
    gazeHabit: 'direct',
    expression: Object.freeze({ composed: 1 }),
  }),
});

const SAMPLE_SEEDS = 512;

function behaviorConfig(extra = {}) {
  return {
    idleActions: [],
    presetDebugEvents: false,
    componentGazeVerified: true,
    ...extra,
  };
}

function drawFirst(styleName, seed, extra = {}) {
  const runtime = createBehaviorRuntime({
    config: behaviorConfig({ seed, style: STYLES[styleName], ...extra }),
  });
  runtime.tick(0);
  const snapshot = runtime.snapshot();
  return {
    head: snapshot.motion.posture.component,
    gaze: snapshot.motion.posture.gazeComponent,
    traits: snapshot.style.traits,
    expression: snapshot.style.baseline.expression,
  };
}

/** Sample the very first component of many independent seed streams. */
function sampleFirst(styleName, seeds = SAMPLE_SEEDS, extra = {}) {
  const head = Object.fromEntries(HEAD_IDS.map((id) => [id, 0]));
  const gaze = Object.fromEntries(GAZE_IDS.map((id) => [id, 0]));
  let headAmplitude = 0;
  let headHold = 0;
  let gazeAmplitude = 0;
  let gazeHold = 0;
  for (let seed = 0; seed < seeds; seed += 1) {
    const { head: headComponent, gaze: gazeComponent } = drawFirst(styleName, seed, extra);
    assert.ok(headComponent !== null, `${styleName}/${seed} drew a head component`);
    assert.ok(gazeComponent !== null, `${styleName}/${seed} drew a gaze component`);
    head[headComponent.id] += 1;
    gaze[gazeComponent.id] += 1;
    headAmplitude += headComponent.amplitude;
    headHold += headComponent.durationMs;
    gazeAmplitude += gazeComponent.amplitude;
    gazeHold += gazeComponent.durationMs;
  }
  const fraction = (count) => count / seeds;
  const shares = (map, ids = null) => {
    const picked = ids ?? Object.keys(map);
    return picked.reduce((sum, id) => sum + fraction(map[id] ?? 0), 0);
  };
  return {
    head,
    gaze,
    headShare: (ids) => shares(head, ids),
    gazeShare: (ids) => shares(gaze, ids),
    headAmplitude: headAmplitude / seeds,
    headHold: headHold / seeds,
    gazeAmplitude: gazeAmplitude / seeds,
    gazeHold: gazeHold / seeds,
  };
}

const pct = (value) => `${(value * 100).toFixed(1)}%`;
const nonNatural = (sample) => sample.headShare(['lean-left', 'lean-right', 'look-back']);

// ---------------------------------------------------------------------------------------------
// 1. lively vs soft: a visibly different head AND gaze distribution, plus gentler amplitude/hold
// ---------------------------------------------------------------------------------------------
test('1. 高 lively 与高 soft 的头部/视线组件分布明显不同（软权重，不硬切）', () => {
  const lively = sampleFirst('lively');
  const soft = sampleFirst('soft');

  const livelyDynamic = nonNatural(lively);
  const softDynamic = nonNatural(soft);
  assert.ok(livelyDynamic > softDynamic + 0.30,
    `lively head is much more dynamic (${pct(livelyDynamic)} vs ${pct(softDynamic)})`);
  assert.ok(soft.headShare(['natural']) > 0.30,
    `soft keeps natural as its main shape (${pct(soft.headShare(['natural']))})`);
  assert.ok(lively.headShare(['look-back']) > 0.15,
    `lively still uses look-back often (${pct(lively.headShare(['look-back']))})`);
  assert.ok(lively.headShare(['natural']) > 0,
    `lively can still draw natural (${lively.headShare(['natural'])}/${SAMPLE_SEEDS})`);

  const livelyGaze = lively.gazeShare(['gaze-up']);
  const softGaze = soft.gazeShare(['gaze-down', 'gaze-center']);
  assert.ok(livelyGaze > soft.gazeShare(['gaze-up']) + 0.15,
    `lively looks up much more than soft (${pct(livelyGaze)} vs ${pct(soft.gazeShare(['gaze-up']))})`);
  assert.ok(softGaze > livelyGaze + 0.15,
    `soft rests down/centre much more than lively looks up (${pct(softGaze)} vs ${pct(livelyGaze)})`);
  assert.ok(softGaze > 0.40,
    `soft gaze tends down/restful (${pct(softGaze)})`);

  // The persona also biases the AMPLITUDE/HOLD inside the existing bands, not just the shape.
  assert.ok(lively.headAmplitude > soft.headAmplitude + 0.004,
    `lively components are stronger (${lively.headAmplitude.toFixed(4)} vs ${soft.headAmplitude.toFixed(4)})`);
  assert.ok(soft.headHold > lively.headHold + 2_000,
    `soft components are held longer (${Math.round(soft.headHold)} ms vs ${Math.round(lively.headHold)} ms)`);

  console.log(
    `[lively-vs-soft] head dynamic=${pct(livelyDynamic)}/${pct(softDynamic)} `
    + `gaze dynamic=${pct(livelyGaze)}/${pct(softGaze)} `
    + `amp=${lively.headAmplitude.toFixed(4)}/${soft.headAmplitude.toFixed(4)} `
    + `hold=${Math.round(lively.headHold)}/${Math.round(soft.headHold)}ms`,
  );
});

// ---------------------------------------------------------------------------------------------
// 2. shy / composed: look-back and down/side vs natural/lean and centre/less movement
// ---------------------------------------------------------------------------------------------
test('2. shy 倾向 look-back/下侧看，composed 倾向 natural/lean、中心/少动', () => {
  const shy = sampleFirst('shy');
  const composed = sampleFirst('composed');

  // Head: shy strongly prefers look-back but keeps natural; composed prefers natural/lean.
  assert.ok(shy.headShare(['look-back']) > composed.headShare(['look-back']) + 0.15,
    `shy look-back ${pct(shy.headShare(['look-back']))} vs composed ${pct(composed.headShare(['look-back']))}`);
  assert.ok(shy.headShare(['natural']) > 0.08,
    `shy still keeps natural available (${pct(shy.headShare(['natural']))})`);
  assert.ok(composed.headShare(['natural', 'lean-left', 'lean-right']) > 0.70,
    `composed head is natural/lean (${pct(composed.headShare(['natural', 'lean-left', 'lean-right']))})`);
  assert.ok(composed.headShare(['look-back']) < 0.20,
    `composed avoids frequent look-backs (${pct(composed.headShare(['look-back']))})`);

  // Gaze: shy looks down/to the side; composed rests at centre and glances up less.
  assert.ok(shy.gazeShare(['gaze-down', 'gaze-left', 'gaze-right']) > 0.60,
    `shy gaze is down/side (${pct(shy.gazeShare(['gaze-down', 'gaze-left', 'gaze-right']))})`);
  assert.ok(shy.gazeShare(['gaze-down']) > shy.gazeShare(['gaze-up']),
    `shy looks down more than up (${pct(shy.gazeShare(['gaze-down']))} vs ${pct(shy.gazeShare(['gaze-up']))})`);
  assert.ok(composed.gazeShare(['gaze-center']) > 0.15,
    `composed uses the still centre (${pct(composed.gazeShare(['gaze-center']))})`);
  assert.ok(composed.gazeShare(['gaze-center']) > composed.gazeShare(['gaze-up']),
    `composed rests more than it looks up (${pct(composed.gazeShare(['gaze-center']))} vs ${pct(composed.gazeShare(['gaze-up']))})`);
  assert.ok(shy.gazeShare(['gaze-up']) < 0.15,
    `shy looks up rarely (${pct(shy.gazeShare(['gaze-up']))})`);

  // Composed switches less than a lively persona because its hold is stretched inside the band.
  const lively = sampleFirst('lively');
  assert.ok(composed.headHold > lively.headHold + 2_000,
    `composed holds longer than lively (${Math.round(composed.headHold)} ms vs ${Math.round(lively.headHold)} ms)`);
  assert.ok(composed.gazeHold > lively.gazeHold + 1_000,
    `composed gaze holds longer than lively (${Math.round(composed.gazeHold)} ms vs ${Math.round(lively.gazeHold)} ms)`);
  assert.ok(composed.headHold > POSTURE_COMPONENT_MIN_MS && composed.headHold < POSTURE_COMPONENT_MAX_MS,
    'the composed hold stays inside the head band');
  assert.ok(composed.gazeHold >= POSTURE_GAZE_COMPONENT_MIN_MS && composed.gazeHold <= POSTURE_GAZE_COMPONENT_MAX_MS,
    'the composed gaze hold stays inside the gaze band');

  console.log(
    `[shy-composed] shyBack=${pct(shy.headShare(['look-back']))} composedBack=${pct(composed.headShare(['look-back']))} `
    + `composedCentre=${pct(composed.gazeShare(['gaze-center']))} holds(lively/composed)=`
    + `${Math.round(lively.headHold)}/${Math.round(composed.headHold)}ms`,
  );
});

// ---------------------------------------------------------------------------------------------
// 3. same seed reproduces; a different persona re-weights the SAME roll
// ---------------------------------------------------------------------------------------------
test('3. 同 seed+人设可复现，异人设不复制轨迹', () => {
  const sample = (styleName, seed) => {
    const runtime = createBehaviorRuntime({
      config: behaviorConfig({
        seed,
        style: STYLES[styleName],
        postureComponentMinMs: 10_000,
        postureComponentMaxMs: 10_000,
        postureGazeComponentMinMs: 6_000,
        postureGazeComponentMaxMs: 6_000,
      }),
    });
    const rows = [];
    for (let at = 0; at <= 60_000; at += DT) {
      const pose = runtime.tick(at);
      const posture = runtime.snapshot().motion.posture;
      rows.push([
        pose.headX, pose.headY, pose.headZ, pose.gazeX, pose.gazeY,
        posture.component?.id ?? null,
        posture.component?.startedAt ?? null,
        posture.component?.semantic?.headZ ?? null,
        posture.gazeComponent?.id ?? null,
        posture.gazeComponent?.startedAt ?? null,
        posture.gazeComponent?.value?.gazeX ?? null,
        posture.gazeComponent?.value?.gazeY ?? null,
      ]);
    }
    return rows;
  };

  const livelyA = sample('lively', 4242);
  const livelyB = sample('lively', 4242);
  const soft = sample('soft', 4242);
  assert.deepEqual(livelyA, livelyB, 'the same seed + persona did not reproduce the trajectory');
  assert.notDeepEqual(livelyA, soft, 'a different persona produced an identical trajectory');
  console.log(`[determinism] frames=${livelyA.length} sameSeed=true differentPersonaDiffers=true`);
});

// ---------------------------------------------------------------------------------------------
// 4. the weighted draw keeps the existing "never twice in a row" rule
// ---------------------------------------------------------------------------------------------
test('4. 加权抽取仍不连续重复同项（head 与 gaze 都覆盖）', () => {
  for (const styleName of ['lively', 'shy', 'composed']) {
    const runtime = createBehaviorRuntime({
      config: behaviorConfig({
        seed: 77,
        style: STYLES[styleName],
        postureComponentMinMs: 10_000,
        postureComponentMaxMs: 10_000,
        postureGazeComponentMinMs: 6_000,
        postureGazeComponentMaxMs: 6_000,
      }),
    });
    const head = [];
    const gaze = [];
    let lastHead = null;
    let lastGaze = null;
    for (let at = 0; at <= 90_000; at += DT) {
      runtime.tick(at);
      const posture = runtime.snapshot().motion.posture;
      if (posture.component !== null && posture.component.id !== lastHead) {
        lastHead = posture.component.id;
        head.push(lastHead);
      }
      if (posture.gazeComponent !== null && posture.gazeComponent.id !== lastGaze) {
        lastGaze = posture.gazeComponent.id;
        gaze.push(lastGaze);
      }
    }
    assert.ok(head.length >= 4, `${styleName} rotated the head enough (${head.length})`);
    assert.ok(gaze.length >= 6, `${styleName} rotated the gaze enough (${gaze.length})`);
    for (let index = 1; index < head.length; index += 1) {
      assert.notEqual(head[index], head[index - 1], `${styleName} repeated head ${head[index]}`);
    }
    for (let index = 1; index < gaze.length; index += 1) {
      assert.notEqual(gaze[index], gaze[index - 1], `${styleName} repeated gaze ${gaze[index]}`);
    }
    console.log(`[no-repeat] ${styleName} head=${head.join('>')} gaze=${gaze.join('>')}`);
  }
});

// ---------------------------------------------------------------------------------------------
// 5. every shape remains reachable; a quiet persona still gets natural / still
// ---------------------------------------------------------------------------------------------
test('5. natural/不动仍可被选中：权重有正下限，安静人设仍会 natural/中心', () => {
  for (const styleName of Object.keys(STYLES)) {
    const { traits, expression } = drawFirst(styleName, 0);
    const headWeights = postureComponentWeights(traits, expression);
    const gazeWeights = gazeComponentWeights(traits, expression);
    assert.deepEqual(Object.keys(headWeights), HEAD_IDS);
    assert.deepEqual(Object.keys(gazeWeights), GAZE_IDS);
    for (const [id, weight] of Object.entries(headWeights)) {
      assert.ok(Number.isFinite(weight) && weight >= COMPONENT_SELECTION_WEIGHT_FLOOR,
        `${styleName} head ${id} is positive (${weight})`);
    }
    for (const [id, weight] of Object.entries(gazeWeights)) {
      assert.ok(Number.isFinite(weight) && weight >= COMPONENT_SELECTION_WEIGHT_FLOOR,
        `${styleName} gaze ${id} is positive (${weight})`);
    }
  }

  const soft = sampleFirst('soft');
  const composed = sampleFirst('composed');
  assert.ok(soft.headShare(['natural']) > 0.30,
    `a quiet/soft persona really draws natural (${pct(soft.headShare(['natural']))})`);
  assert.ok(composed.headShare(['natural']) > 0.15,
    `a composed persona really draws natural (${pct(composed.headShare(['natural']))})`);
  assert.ok(composed.gazeShare(['gaze-center']) > 0.10,
    `a composed persona really holds the still centre (${pct(composed.gazeShare(['gaze-center']))})`);

  // The soft weights are only biases: no persona turns a shape into a hard "always/never".
  const livelinessBias = personaComponentBias({ liveliness: 0.95, softness: 0.1 }, { playful: 1 });
  const softBias = personaComponentBias({ liveliness: 0.1, softness: 0.9 }, { tender: 1 });
  assert.ok(softBias.amplitudeExponent > livelinessBias.amplitudeExponent,
    'soft draws a gentler amplitude inside the same band');
  assert.ok(softBias.holdFactor > livelinessBias.holdFactor,
    'soft stretches the hold inside the same band');
  console.log(
    `[reachable] natural floor=${COMPONENT_SELECTION_WEIGHT_FLOOR} `
    + `softNatural=${pct(soft.headShare(['natural']))} composedCentre=${pct(composed.gazeShare(['gaze-center']))}`,
  );
});

// ---------------------------------------------------------------------------------------------
// 6. hard bounds are untouched (caps, channels, bands) while only the draw is re-weighted
// ---------------------------------------------------------------------------------------------
test('6. 只改抽取概率：幅度上限、组件通道、保持区间不变', () => {
  for (const styleName of Object.keys(STYLES)) {
    for (let seed = 0; seed < 64; seed += 1) {
      const { head, gaze } = drawFirst(styleName, seed);
      assert.deepEqual(head.channels, [...POSTURE_COMPONENT_CHANNELS], 'head only drives verified channels');
      assert.deepEqual(Object.keys(head.target).sort(), [...POSTURE_COMPONENT_CHANNELS].sort());
      assert.ok(head.durationMs >= POSTURE_COMPONENT_MIN_MS && head.durationMs <= POSTURE_COMPONENT_MAX_MS,
        `head hold ${head.durationMs} stays in band`);
      for (const channel of POSTURE_COMPONENT_CHANNELS) {
        assert.ok(Math.abs(head.semantic[channel]) <= POSTURE_COMPONENT_MAX_AMPLITUDE + 1e-9,
          `head ${channel} semantic stays capped`);
      }
      assert.deepEqual(gaze.channels, ['gazeX', 'gazeY']);
      assert.ok(gaze.durationMs >= POSTURE_GAZE_COMPONENT_MIN_MS
        && gaze.durationMs <= POSTURE_GAZE_COMPONENT_MAX_MS,
      `gaze hold ${gaze.durationMs} stays in band`);
      for (const channel of ['gazeX', 'gazeY']) {
        assert.ok(Math.abs(gaze.value[channel]) <= POSTURE_GAZE_COMPONENT_MAX_AMPLITUDE + 1e-9,
          `gaze ${channel} stays capped`);
      }
      if (gaze.id === 'gaze-center') {
        assert.deepEqual(gaze.value, { gazeX: 0, gazeY: 0 }, 'the still centre is exactly zero');
        assert.equal(gaze.amplitude, 0, 'the still centre has no semantic amplitude');
      }
    }
  }
  console.log('[bounds] caps/channels/holds unchanged; only selection probability and interior bias moved');
});
