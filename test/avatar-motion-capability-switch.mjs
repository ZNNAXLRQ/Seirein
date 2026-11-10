/**
 * Model-switch / reconnect rediscovery for the generic channel catalog.
 *
 * Run: node test/avatar-motion-capability-switch.mjs
 *
 * The host re-discovers with `force:true` on `connect` and on `model-changed` (src/host/index.js).
 * These tests pin the contract those call sites rely on:
 *   1. a forced discovery for a new model generation replaces the old catalog, and switching back
 *      re-enables the channels the new model supports;
 *   2. `force:true` on the same identity bypasses the cached map and adopts a changed input list
 *      (the reconnect path), while a non-forced call still serves the cache;
 *   3. a discovery that resolves after the model changed is dropped and can never leak the old
 *      model's arm/shoulder/hand support into the new status snapshot.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  cachedCapabilities,
  discoverCapabilities,
  resetCapabilities,
  snapshot,
} from '../src/host/avatar/avatarMotion.js';

const input = (name, min = -1, max = 1) => ({ name, min, max, defaultValue: 0 });
const parameter = (name) => ({ name });
const pool = (names) => ({
  defaultParameters: names.map((name) => input(name)),
  customParameters: [],
});
const model = (names) => async () => ({
  ok: true,
  source: 'test',
  parameters: names.map(parameter),
});

const HEAD_ONLY_INPUTS = ['FaceAngleX', 'FaceAngleY', 'FaceAngleZ'];
const ARM_INPUTS = ['FaceAngleX', 'BodyAngleX', 'BodyAngleY', 'ArmLeft', 'ArmRight', 'HandLeft', 'ShoulderLeft'];
const HEAD_MODEL_PARAMS = ['ParamAngleX', 'ParamAngleY', 'ParamAngleZ'];
const FULL_MODEL_PARAMS = [
  ...HEAD_MODEL_PARAMS,
  'ParamBodyAngleX', 'ParamBodyAngleY', 'ParamArmLA', 'ParamArmRA', 'ParamHandL', 'ParamShoulderL',
];

const discover = async ({ identity, inputs, modelParams, force = true, currentIdentity, calls }) => discoverCapabilities({
  identity,
  currentIdentity,
  force,
  listInputParameters: async () => {
    if (calls !== undefined) calls.count += 1;
    return pool(inputs);
  },
  listModelParameters: model(modelParams),
});

const rowOf = (result, channel) => {
  const row = result.channels.find((entry) => entry.channel === channel);
  assert.ok(row !== undefined, `channel row ${channel} is present`);
  return row;
};
const armChannels = ['shoulderL', 'armL', 'armR', 'handL'];

test('1. model-changed: arms on → off → on, and the status snapshot follows every switch', async () => {
  resetCapabilities();
  const identityA = { modelId: 'switch-host-A', modelGeneration: 0, connectionGeneration: 1 };
  const identityB = { modelId: 'switch-host-B', modelGeneration: 1, connectionGeneration: 1 };
  const identityC = { modelId: 'switch-host-C', modelGeneration: 2, connectionGeneration: 1 };
  let current = identityA;
  const calls = { count: 0 };
  const currentIdentity = () => current;

  const resultA = await discover({
    identity: identityA,
    inputs: ARM_INPUTS,
    modelParams: FULL_MODEL_PARAMS,
    currentIdentity,
    calls,
  });
  for (const channel of armChannels) {
    assert.ok(resultA.mapped.includes(channel), `${channel} mapped on A`);
  }
  assert.ok(resultA.verified.includes('bodyY'), 'bodyY is verified on A');
  assert.equal(resultA.verified.includes('armL'), false, 'armL is still only a candidate on A');
  assert.equal(snapshot().mapped.includes('armL'), true, 'status shows A after the connect discovery');

  // handleVtsModelChanged: drop the old cache, bump the generation, then discover with force:true.
  resetCapabilities();
  current = identityB;
  const resultB = await discover({
    identity: identityB,
    inputs: HEAD_ONLY_INPUTS,
    modelParams: FULL_MODEL_PARAMS,
    currentIdentity,
    calls,
  });
  assert.deepEqual(resultB.mapped, ['headX', 'headY', 'headZ'], 'B maps only its head inputs');
  for (const channel of armChannels) {
    assert.equal(resultB.mapped.includes(channel), false, `${channel} is off on B`);
    assert.ok(resultB.unmapped.includes(channel), `${channel} is reported unmapped on B`);
    assert.equal(resultB.inputs[channel], null);
  }
  assert.equal(resultB.verified.includes('bodyY'), false, 'B has no body input, so bodyY is not verified');
  assert.equal(snapshot().mapped.includes('armL'), false, 'status now shows B, not A');
  assert.ok(snapshot().unmapped.includes('armL'));
  assert.ok(Array.isArray(snapshot().channels) && snapshot().channels.length > 0,
    'the status rows include the new catalog channels');
  assert.equal(rowOf(snapshot(), 'armL').injectable, false);

  // Switch to a model that supports the arms again.
  resetCapabilities();
  current = identityC;
  const resultC = await discover({
    identity: identityC,
    inputs: ARM_INPUTS,
    modelParams: FULL_MODEL_PARAMS,
    currentIdentity,
    calls,
  });
  for (const channel of armChannels) {
    assert.ok(resultC.mapped.includes(channel), `${channel} is enabled again on C`);
    assert.equal(resultC.unmapped.includes(channel), false);
  }
  assert.equal(snapshot().mapped.includes('armL'), true);
  assert.equal(snapshot().unmapped.includes('armL'), false);
  assert.equal(calls.count, 3, 'each model generation ran its own forced discovery');

  console.log(`  [1] A.arms=${resultA.mapped.includes('armL')} B.arms=${resultB.mapped.includes('armL')}`
    + ` C.arms=${resultC.mapped.includes('armL')} requests=${calls.count}`);
});

test('2. reconnect (force, same identity): bypass the cached map and adopt a changed catalog', async () => {
  resetCapabilities();
  const identity = { modelId: 'switch-reconnect', modelGeneration: 0, connectionGeneration: 3 };
  const currentIdentity = () => identity;
  const calls = { count: 0 };

  const first = await discover({
    identity,
    inputs: HEAD_ONLY_INPUTS,
    modelParams: FULL_MODEL_PARAMS,
    currentIdentity,
    calls,
  });
  assert.deepEqual(first.mapped, ['headX', 'headY', 'headZ']);
  assert.equal(cachedCapabilities(identity).mapped.includes('armL'), false);

  // No force: the completed map is served from the identity cache (nothing changed on the wire).
  const cached = await discover({
    identity,
    inputs: ARM_INPUTS,
    modelParams: FULL_MODEL_PARAMS,
    force: false,
    currentIdentity,
    calls,
  });
  assert.equal(cached.fromCache, true, 'a non-forced call reuses the cached map');
  assert.equal(cached.mapped.includes('armL'), false, 'the stale cached map is what is served');
  assert.equal(calls.count, 1, 'the cache hit did not send another request');

  // A reconnect calls force:true: the new input list replaces the cached one.
  const reconnected = await discover({
    identity,
    inputs: ARM_INPUTS,
    modelParams: FULL_MODEL_PARAMS,
    currentIdentity,
    calls,
  });
  assert.equal(reconnected.fromCache, undefined);
  assert.ok(reconnected.mapped.includes('armL') && reconnected.mapped.includes('armR'));
  assert.equal(reconnected.verified.includes('armL'), false, 'the newly supported arm stays a candidate');
  assert.equal(cachedCapabilities(identity).mapped.includes('armL'), true);
  assert.equal(snapshot().mapped.includes('armL'), true);
  assert.equal(calls.count, 2, 'force sent a fresh InputParameterListRequest');

  console.log(`  [2] cached.arms=${cached.mapped.includes('armL')} forced.arms=${reconnected.mapped.includes('armL')}`
    + ` requests=${calls.count}`);
});

test('3. a late old-model result is dropped and cannot leak old arm support', async () => {
  resetCapabilities();
  const identityA = { modelId: 'switch-late-A', modelGeneration: 0, connectionGeneration: 2 };
  const identityB = { modelId: 'switch-late-B', modelGeneration: 1, connectionGeneration: 2 };
  let current = identityA;
  let resolveA;
  let requestsA = 0;
  const events = [];

  const pendingA = discoverCapabilities({
    identity: identityA,
    currentIdentity: () => current,
    log: { emit: async (type, payload) => events.push({ type, payload }) },
    listInputParameters: () => {
      requestsA += 1;
      return new Promise((resolve) => { resolveA = resolve; });
    },
    listModelParameters: model(FULL_MODEL_PARAMS),
  });

  // The model changes while A's list request is still in flight.
  current = identityB;
  resetCapabilities();
  const resultB = await discoverCapabilities({
    identity: identityB,
    currentIdentity: () => current,
    force: true,
    log: { emit: async (type, payload) => events.push({ type, payload }) },
    listInputParameters: async () => pool(HEAD_ONLY_INPUTS),
    listModelParameters: model(FULL_MODEL_PARAMS),
  });
  assert.deepEqual(resultB.mapped, ['headX', 'headY', 'headZ']);

  // A finally answers with a model that supports arms: it must be dropped, not committed.
  resolveA(pool(ARM_INPUTS));
  const resultA = await pendingA;
  assert.equal(resultA.stale, true, 'the old-model result is marked stale');
  assert.equal(requestsA, 1);
  assert.equal(resultA.mapped.includes('armL'), true, 'the stale answer still carries its own old map');
  assert.equal(snapshot().mapped.includes('armL'), false, 'but the live status remains B\'s map');
  assert.equal(snapshot().mapped.includes('headX'), true);
  assert.equal(snapshot().unmapped.includes('armL'), true);
  assert.ok(events.some((event) => event.type === 'avatar.discovery.dropped'
    && event.payload?.reason === 'stale-identity'));

  console.log(`  [3] stale.arms=${resultA.mapped.includes('armL')} live.arms=${snapshot().mapped.includes('armL')}`
    + ` dropped=${events.filter((event) => event.type === 'avatar.discovery.dropped').length}`);
});
