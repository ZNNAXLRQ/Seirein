/**
 * Generic channel catalog — the discovery table must cover the body/arm/hand/shoulder parts of a
 * model, not only the channels of whatever model happened to be loaded when the table was written.
 *
 * Pinned here (all deterministic, no VTS):
 *   1. BodyAngleX/Y/Z + ArmLeft/Right + HandLeft/Right + ShoulderLeft/Right inputs map every new
 *      channel; bodyY/bodyZ verify through their standard model target, while arm/hand/shoulder
 *      stay candidates because their target parameter names are model-specific;
 *   2. a head/face-only input list leaves body/arms/hands/shoulders unmapped: an existing model
 *      parameter is never turned into a mapping;
 *   3. discovery is identity-scoped: a model switch re-discovers and turns arm channels off, and a
 *      switch back turns them on again;
 *   4. matching is exact and case-insensitive; similar longer names never bind;
 *   5. the original channels keep their order and behaviour.
 *
 * Run: node --test test/avatar-channel-catalog.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CHANNEL_ORDER,
  MODEL_TARGET_RULES,
  PARAMETER_CANDIDATES,
  cachedCapabilities,
  discoverCapabilities,
  resetCapabilities,
  snapshot,
} from '../src/host/avatar/avatarMotion.js';

const input = (name, min = -1, max = 1) => ({ name, min, max, defaultValue: 0 });
const parameter = (name) => ({ name });

const HEAD_INPUTS = [
  'FaceAngleX', 'FaceAngleY', 'FaceAngleZ',
  'EyeRightX', 'EyeRightY',
  'EyeOpenLeft', 'EyeOpenRight',
  'BrowLeftY', 'BrowRightY',
  'MouthOpen',
];
const BODY_ARM_INPUTS = [
  'BodyAngleX', 'BodyAngleY', 'BodyAngleZ',
  'ShoulderLeft', 'ShoulderRight',
  'ArmLeft', 'ArmRight',
  'HandLeft', 'HandRight',
];
const MODEL_PARAMS = [
  'ParamAngleX', 'ParamAngleY', 'ParamAngleZ',
  'ParamEyeBallX', 'ParamEyeBallY',
  'ParamEyeLOpen', 'ParamEyeROpen',
  'ParamBrowLY', 'ParamBrowRY', 'ParamMouthOpenY',
  'ParamBodyAngleX', 'ParamBodyAngleY', 'ParamBodyAngleZ', 'ParamBreath',
  // Arm/hand/shoulder parameters exist on this model, but the catalog has no proof rule for them.
  'ParamArmLA', 'ParamArmRA', 'ParamHandL', 'ParamHandR', 'ParamShoulderL', 'ParamShoulderR',
];

const pool = (names, customNames = []) => ({
  defaultParameters: names.map((name) => input(name)),
  customParameters: customNames.map((name) => input(name)),
});

const discover = async ({ modelId, inputs, modelParams = MODEL_PARAMS, customInputs = [], force = true, currentIdentity = undefined }) => {
  const identity = { modelId, modelGeneration: 0, connectionGeneration: 0 };
  return discoverCapabilities({
    identity,
    currentIdentity: currentIdentity ?? (() => identity),
    force,
    listInputParameters: async () => pool(inputs, customInputs),
    listModelParameters: async () => ({
      ok: true,
      source: 'test',
      parameters: modelParams.map(parameter),
    }),
  });
};

const rowOf = (result, channel) => {
  const row = result.channels.find((entry) => entry.channel === channel);
  assert.ok(row !== undefined, `channel row ${channel} is present`);
  return row;
};

test('1. BodyAngleX/Y/Z + Arm/Hand/Shoulder inputs map every new channel', async () => {
  resetCapabilities();
  // HandRight is a custom input: the catalog must not depend on VTS putting it in the defaults.
  const result = await discover({
    modelId: 'catalog-full',
    inputs: [...HEAD_INPUTS, ...BODY_ARM_INPUTS.filter((name) => name !== 'HandRight'), 'Breath'],
    customInputs: ['HandRight'],
  });

  assert.equal(result.ok, true, `discovery succeeded (${result.error})`);
  const expectedNew = ['bodyY', 'bodyZ', 'shoulderL', 'shoulderR', 'armL', 'armR', 'handL', 'handR'];
  for (const channel of expectedNew) {
    assert.ok(result.mapped.includes(channel), `${channel} is mapped from its exact input`);
    assert.equal(result.unmapped.includes(channel), false, `${channel} is not reported unmapped`);
    assert.equal(result.inputs[channel]?.injectable, true, `${channel} has an injectable input row`);
  }
  // bodyX was already in the catalog and keeps working.
  assert.ok(result.mapped.includes('bodyX'));
  // Every channel has an input in this pool.
  assert.deepEqual(result.unmapped, []);

  // Standard body targets are unambiguous: the explicit rule verifies them.
  for (const [channel, inputName, target] of [
    ['bodyY', 'BodyAngleY', 'ParamBodyAngleY'],
    ['bodyZ', 'BodyAngleZ', 'ParamBodyAngleZ'],
  ]) {
    const row = rowOf(result, channel);
    assert.equal(row.inputName, inputName);
    assert.equal(row.verified, true, `${channel} is verified by ${inputName} → ${target}`);
    assert.deepEqual(row.modelParams, [target]);
  }

  // Arm/hand/shoulder have no standard target rule: an input hit stays a candidate, even though
  // this model also exposes ParamArmLA/ParamHandL/ParamShoulderL.
  for (const [channel, inputName] of [
    ['shoulderL', 'ShoulderLeft'],
    ['shoulderR', 'ShoulderRight'],
    ['armL', 'ArmLeft'],
    ['armR', 'ArmRight'],
    ['handL', 'HandLeft'],
    ['handR', 'HandRight'],
  ]) {
    const row = rowOf(result, channel);
    assert.equal(row.inputName, inputName);
    assert.equal(row.injectable, true, `${channel} is injectable`);
    assert.equal(row.verified, false, `${channel} must remain candidate/unverified`);
    assert.deepEqual(row.modelParams, [], `${channel} has no name-rule target to claim`);
    assert.match(row.notes, /候选/u);
    assert.equal(result.verified.includes(channel), false);
  }
  // HandRight really came from the custom pool.
  assert.equal(rowOf(result, 'handR').inputSource, 'custom');

  // No name-rule entry was invented for the uncertain parts.
  for (const channel of ['shoulderL', 'shoulderR', 'armL', 'armR', 'handL', 'handR']) {
    assert.equal(MODEL_TARGET_RULES[channel], undefined, `${channel} deliberately has no target rule`);
    assert.ok(Array.isArray(PARAMETER_CANDIDATES[channel]) && PARAMETER_CANDIDATES[channel].length > 0);
  }

  console.log(`  [1] mapped=${result.mapped.join(',')}`);
  console.log(`      verified=${result.verified.join(',')} unmapped=${result.unmapped.join(',') || '(none)'}`);
});

test('2. head/face-only inputs leave body/arms/hands unmapped without inventing support', async () => {
  resetCapabilities();
  const result = await discover({ modelId: 'catalog-head-only', inputs: HEAD_INPUTS });

  const expectedUnmapped = ['bodyX', 'bodyY', 'bodyZ', 'shoulderL', 'shoulderR', 'armL', 'armR', 'handL', 'handR'];
  for (const channel of expectedUnmapped) {
    const row = rowOf(result, channel);
    assert.equal(row.injectable, false, `${channel} is not injectable without an input`);
    assert.equal(row.inputName, '');
    assert.equal(result.inputs[channel], null, `${channel} has no input entry`);
    assert.ok(result.unmapped.includes(channel), `${channel} is listed unmapped`);
    assert.equal(result.mapped.includes(channel), false);
    assert.equal(result.verified.includes(channel), false);
  }
  // The model itself HAS these parameters: parameter existence is still not a mapping.
  assert.deepEqual(rowOf(result, 'bodyY').modelParams, ['ParamBodyAngleY']);
  assert.deepEqual(rowOf(result, 'bodyX').modelParams, ['ParamBodyAngleX']);
  // The channels that do have inputs are unaffected.
  assert.ok(result.mapped.includes('headX') && result.mapped.includes('mouth') && result.mapped.includes('gazeX'));

  console.log(`  [2] mapped=${result.mapped.join(',')}`);
  console.log(`      body/arms/hands unmapped=${expectedUnmapped.join(',')}`);
});

test('3. model switch re-discovers: arms on → off → on, with identity-scoped caches', async () => {
  resetCapabilities();
  const identityA = { modelId: 'switch-model-A', modelGeneration: 0, connectionGeneration: 0 };
  const identityB = { modelId: 'switch-model-B', modelGeneration: 1, connectionGeneration: 0 };
  const identityA2 = { modelId: 'switch-model-A', modelGeneration: 2, connectionGeneration: 0 };
  let current = identityA;
  const calls = { A: 0, B: 0, A2: 0 };

  const run = async (identity, inputs, kind) => discoverCapabilities({
    identity,
    currentIdentity: () => current,
    force: true,
    listInputParameters: async () => {
      calls[kind] += 1;
      return pool(inputs);
    },
    listModelParameters: async () => ({ ok: true, source: 'test', parameters: MODEL_PARAMS.map(parameter) }),
  });

  const resultA = await run(identityA, ['FaceAngleX', 'BodyAngleY', 'ArmLeft', 'ArmRight'], 'A');
  assert.ok(resultA.mapped.includes('armL') && resultA.mapped.includes('armR'), 'model A supports arms');
  assert.equal(resultA.verified.includes('bodyY'), true, 'bodyY verifies on model A');
  assert.equal(resultA.verified.includes('armL'), false, 'arms are candidates, not proofs');

  // Switch to a model that only exposes head/face inputs.
  current = identityB;
  const resultB = await run(identityB, ['FaceAngleX'], 'B');
  assert.equal(resultB.mapped.includes('armL'), false, 'model B does not report an arm mapping');
  assert.equal(resultB.mapped.includes('armR'), false);
  assert.ok(resultB.unmapped.includes('armL') && resultB.unmapped.includes('armR'));
  assert.ok(resultB.unmapped.includes('bodyY'), 'bodyY is unsupported on model B too');
  assert.deepEqual(resultB.mapped, ['headX']);
  assert.equal(snapshot().mapped.includes('armL'), false, 'the live snapshot is B, not A');

  // The caches stay per-model: A's map is not destroyed, and B never reads it.
  assert.ok(cachedCapabilities(identityA).mapped.includes('armL'));
  assert.equal(cachedCapabilities(identityB).mapped.includes('armL'), false);

  // Switch to a new model generation that supports arms again (reverse direction).
  current = identityA2;
  const resultA2 = await run(identityA2, ['FaceAngleX', 'BodyAngleY', 'ArmLeft', 'ArmRight'], 'A2');
  assert.ok(resultA2.mapped.includes('armL') && resultA2.mapped.includes('armR'), 'arms are enabled again');
  assert.ok(resultA2.unmapped.includes('armL') === false && resultA2.unmapped.includes('armR') === false);
  assert.ok(snapshot().mapped.includes('armL'), 'the live snapshot is the newest model');
  assert.deepEqual(calls, { A: 1, B: 1, A2: 1 }, 'each model switch ran a fresh forced discovery');

  console.log(`  [3] A.arms=${resultA.mapped.includes('armL')} B.arms=${resultB.mapped.includes('armL')}`
    + ` A2.arms=${resultA2.mapped.includes('armL')} calls=${calls.A}/${calls.B}/${calls.A2}`);
});

test('4. exact case-insensitive matching; similar names never bind', async () => {
  resetCapabilities();
  const insensitive = await discover({
    modelId: 'catalog-case',
    inputs: ['bodyangley', 'BODYANGLEZ', 'armleft', 'HANDLEFT', 'shoulderleft', 'FaceAngleX'],
  });
  for (const [channel, inputName] of [
    ['bodyY', 'bodyangley'],
    ['bodyZ', 'BODYANGLEZ'],
    ['armL', 'armleft'],
    ['handL', 'HANDLEFT'],
    ['shoulderL', 'shoulderleft'],
    ['headX', 'FaceAngleX'],
  ]) {
    const row = rowOf(insensitive, channel);
    assert.equal(row.injectable, true, `${channel} matches case-insensitively`);
    assert.equal(row.inputName, inputName, `${channel} keeps the list spelling`);
  }
  // bodyY's target rule still matches through the lowercased comparison.
  assert.equal(rowOf(insensitive, 'bodyY').verified, true);

  resetCapabilities();
  const similar = await discover({
    modelId: 'catalog-similar',
    inputs: [
      'BodyAngleYExtra', 'ArmLeft2', 'ArmLeftAngleX', 'HandLeftPointer',
      'ShoulderLeftExtra', 'FaceAngleXTra', 'EyeOpenLeft2', 'BodyXL',
    ],
  });
  assert.deepEqual(similar.mapped, [], 'no similar-looking name was accepted as an exact match');
  for (const channel of ['bodyY', 'armL', 'handL', 'shoulderL', 'headX', 'eyeOpenL', 'bodyX']) {
    assert.equal(rowOf(similar, channel).injectable, false, `${channel} stays unmapped`);
    assert.ok(similar.unmapped.includes(channel), `${channel} is reported unmapped`);
  }

  console.log(`  [4] case-insensitive=${insensitive.mapped.join(',')}`);
  console.log(`      similar-names mapped=${similar.mapped.join(',') || '(none)'}`);
});

test('5. the original channel order and behaviour are unchanged', async () => {
  const legacyOrder = [
    'gazeX', 'gazeY', 'headX', 'headY', 'headZ', 'eyeOpenL', 'eyeOpenR',
    'browL', 'browR', 'mouth', 'bodyX', 'breath',
  ];
  const kept = CHANNEL_ORDER.filter((channel) => legacyOrder.includes(channel));
  assert.deepEqual(kept, legacyOrder, 'existing channels keep their relative order');

  resetCapabilities();
  const result = await discover({ modelId: 'catalog-legacy', inputs: [...HEAD_INPUTS, 'BodyAngleX', 'Breath'] });
  const expectedMapped = [
    'gazeX', 'gazeY', 'headX', 'headY', 'headZ', 'eyeOpenL', 'eyeOpenR',
    'browL', 'browR', 'mouth', 'bodyX', 'breath',
  ];
  assert.deepEqual(result.mapped, expectedMapped, 'the legacy pool maps exactly the legacy channels');
  assert.deepEqual(result.verified, expectedMapped, 'and verifies them through the existing rules');

  console.log(`  [5] legacy mapped=${result.mapped.join(',')}`);
});
