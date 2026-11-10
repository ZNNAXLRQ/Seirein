/**
 * Capability discovery semantics for the generic channel catalog.
 *
 * Run: node test/avatar-motion-capabilities.mjs
 *
 * Pinned:
 *   1. the legacy channels keep their exact rule-verified behaviour;
 *   2. bodyY/bodyZ verify through ParamBodyAngleY/Z, including their short BodyY/BodyZ spellings;
 *   3. shoulder/arm/hand stay injectable candidates: a matching model parameter is not proof, and
 *      an explicit user mapping still needs a runtime probe;
 *   4. an existing model parameter alone never maps a channel;
 *   5. only gaze remains probe-eligible (the new channels add no untested probe path).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PROBE_CHANNEL_ORDER,
  discoverCapabilities,
  resetCapabilities,
} from '../src/host/avatar/avatarMotion.js';
import { createHostTools } from '../src/host/runtime/tools.js';

const input = (name, min = -1, max = 1) => ({ name, min, max, defaultValue: 0 });
const parameter = (name) => ({ name });

const pool = (names) => ({
  defaultParameters: names.map((name) => input(name)),
  customParameters: [],
});

const discover = ({ modelId, inputs, modelParams, channelMap = {} }) => {
  const identity = { modelId, modelGeneration: 0, connectionGeneration: 0 };
  return discoverCapabilities({
    identity,
    currentIdentity: () => identity,
    force: true,
    channelMap,
    listInputParameters: async () => pool(inputs),
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

test('1. legacy channels keep their existing rule-verified behaviour', async () => {
  resetCapabilities();
  const result = await discover({
    modelId: 'capabilities-legacy',
    inputs: [
      'FaceAngleX', 'FaceAngleY', 'FaceAngleZ',
      'EyeRightX', 'EyeRightY',
      'EyeOpenLeft', 'EyeOpenRight',
      'BrowLeftY', 'BrowRightY', 'MouthOpen',
      'BodyAngleX', 'Breath',
    ],
    modelParams: [
      'ParamAngleX', 'ParamAngleY', 'ParamAngleZ',
      'ParamEyeBallX', 'ParamEyeBallY',
      'ParamEyeLOpen', 'ParamEyeROpen',
      'ParamBrowLY', 'ParamBrowRY', 'ParamMouthOpenY',
      'ParamBodyAngleX', 'ParamBreath',
    ],
  });

  const verified = [
    'gazeX', 'gazeY', 'headX', 'headY', 'headZ', 'eyeOpenL', 'eyeOpenR',
    'browL', 'browR', 'mouth', 'bodyX', 'breath',
  ];
  assert.deepEqual(result.mapped, verified);
  assert.deepEqual(result.verified, verified);
  assert.equal(result.mappingUnverified.length, 0);
  assert.equal(result.mappingInvalid.length, 0);
  // The new channels are unmapped, not fabricated.
  for (const channel of ['bodyY', 'bodyZ', 'shoulderL', 'shoulderR', 'armL', 'armR', 'handL', 'handR']) {
    assert.ok(result.unmapped.includes(channel), `${channel} is unmapped without an input`);
  }

  console.log(`  [1] verified=${result.verified.join(',')}`);
});

test('2. bodyY/bodyZ verify through ParamBodyAngleY/Z, including short input spellings', async () => {
  resetCapabilities();
  const long = await discover({
    modelId: 'capabilities-body-long',
    inputs: ['BodyAngleY', 'BodyAngleZ'],
    modelParams: ['ParamBodyAngleY', 'ParamBodyAngleZ'],
  });
  assert.equal(rowOf(long, 'bodyY').verified, true);
  assert.equal(rowOf(long, 'bodyZ').verified, true);
  assert.deepEqual(rowOf(long, 'bodyY').modelParams, ['ParamBodyAngleY']);
  assert.deepEqual(rowOf(long, 'bodyZ').modelParams, ['ParamBodyAngleZ']);

  // BodyY/BodyZ are explicit aliases of the same standard target, not fuzzy matches.
  resetCapabilities();
  const short = await discover({
    modelId: 'capabilities-body-short',
    inputs: ['BodyY', 'BodyZ'],
    modelParams: ['ParamBodyAngleY', 'ParamBodyAngleZ'],
  });
  assert.equal(rowOf(short, 'bodyY').inputName, 'BodyY');
  assert.equal(rowOf(short, 'bodyZ').inputName, 'BodyZ');
  assert.equal(rowOf(short, 'bodyY').verified, true);
  assert.equal(rowOf(short, 'bodyZ').verified, true);
  assert.ok(short.verified.includes('bodyY') && short.verified.includes('bodyZ'));

  // Without the target parameter the alias stays a candidate: the input alone is not proof.
  resetCapabilities();
  const noTarget = await discover({
    modelId: 'capabilities-body-no-target',
    inputs: ['BodyY', 'BodyZ'],
    modelParams: [],
  });
  assert.equal(rowOf(noTarget, 'bodyY').injectable, true);
  assert.equal(rowOf(noTarget, 'bodyY').verified, false);
  assert.equal(rowOf(noTarget, 'bodyZ').verified, false);

  console.log(`  [2] long=${long.mapped.join(',')} short=${short.mapped.join(',')}`
    + ` noTarget.verified=${noTarget.verified.join(',') || '(none)'}`);
});

test('3. arm/hand/shoulder are candidates; a model parameter and an explicit map are not proof', async () => {
  resetCapabilities();
  const inputs = ['ArmLeft', 'ArmRight', 'HandLeft', 'HandRight', 'ShoulderLeft', 'ShoulderRight'];
  const modelParams = [
    'ParamArmLA', 'ParamArmRA', 'ParamHandL', 'ParamHandR', 'ParamShoulderL', 'ParamShoulderR',
  ];
  const result = await discover({ modelId: 'capabilities-arms', inputs, modelParams });

  for (const channel of ['armL', 'armR', 'handL', 'handR', 'shoulderL', 'shoulderR']) {
    const row = rowOf(result, channel);
    assert.equal(row.injectable, true, `${channel} maps its exact input`);
    assert.equal(row.verified, false, `${channel} is never auto-verified`);
    assert.deepEqual(row.modelParams, [], `${channel} claims no target parameter`);
    assert.equal(result.verified.includes(channel), false);
  }

  // An explicit mapping chooses the input but is still unverified until a runtime probe proves it.
  resetCapabilities();
  const explicit = await discover({
    modelId: 'capabilities-arms-explicit',
    inputs,
    modelParams,
    channelMap: { armL: 'ArmLeft' },
  });
  const armL = rowOf(explicit, 'armL');
  assert.equal(armL.inputName, 'ArmLeft');
  assert.equal(armL.mappingSource, 'explicit');
  assert.equal(armL.injectable, true);
  assert.equal(armL.verified, false, 'an explicit name is not proof');
  assert.equal(armL.mappingUnverified, true);
  assert.ok(explicit.mappingUnverified.includes('armL'));
  assert.ok(explicit.mappingSources.armL === 'explicit');
  assert.equal(explicit.mappingInvalid.length, 0);

  console.log(`  [3] candidates=${result.mapped.join(',')} verified=${result.verified.join(',') || '(none)'}`
    + ` explicitArmL=${armL.verified ? 'verified' : 'unverified'}`);
});

test('4. a model parameter alone never maps a channel', async () => {
  resetCapabilities();
  const result = await discover({
    modelId: 'capabilities-params-only',
    inputs: ['FaceAngleX'],
    modelParams: [
      'ParamAngleX', 'ParamBodyAngleX', 'ParamBodyAngleY', 'ParamBodyAngleZ',
      'ParamArmLA', 'ParamArmRA', 'ParamHandL', 'ParamHandR',
    ],
  });
  assert.deepEqual(result.mapped, ['headX']);
  for (const channel of ['bodyX', 'bodyY', 'bodyZ', 'armL', 'armR', 'handL', 'handR']) {
    assert.ok(result.unmapped.includes(channel), `${channel} is unmapped even though the model has its parameter`);
    assert.equal(result.inputs[channel], null);
  }
  assert.ok(rowOf(result, 'bodyY').modelParams.includes('ParamBodyAngleY'),
    'the model parameter is still reported as model evidence');

  console.log(`  [4] mapped=${result.mapped.join(',')} bodyY.modelParams=${rowOf(result, 'bodyY').modelParams.join(',')}`);
});

test('5. probe eligibility stays limited to gaze', async () => {
  assert.deepEqual([...PROBE_CHANNEL_ORDER], ['gazeX', 'gazeY'],
    'adding body/arm/hand channels did not add an unproven probe path');

  resetCapabilities();
  const seen = [];
  const identity = { modelId: 'capabilities-probe', modelGeneration: 0, connectionGeneration: 0 };
  const result = await discoverCapabilities({
    identity,
    currentIdentity: () => identity,
    force: true,
    probeMappings: true,
    probeInputMapping: async ({ inputName }) => {
      seen.push(inputName);
      return { ok: true, changed: true, delta: { ParamEyeBallX: 0.1 } };
    },
    listInputParameters: async () => pool(['EyeRightX', 'EyeRightY', 'ArmLeft', 'BodyAngleY']),
    listModelParameters: async () => ({
      ok: true,
      source: 'test',
      parameters: ['ParamEyeBallX', 'ParamEyeBallY', 'ParamBodyAngleY', 'ParamArmLA'].map(parameter),
    }),
  });
  assert.deepEqual(seen.sort(), ['EyeRightX', 'EyeRightY'], 'only gaze inputs are probed');
  assert.ok(result.verified.includes('gazeX') && result.verified.includes('gazeY'));
  assert.equal(rowOf(result, 'armL').verified, false, 'a mapped arm candidate is not probed or verified');

  console.log(`  [5] probed=${seen.join(',')} verified=${result.verified.join(',')}`);
});

test('6. assistant_live2d status exposes controller/channel evidence without creating a runtime', async () => {
  let runtimeState = {
    connected: true,
    disposed: false,
    lastError: '',
    motion: { source: 'controller', locked: false, lockReason: '' },
    channels: {
      controlled: ['headX', 'bodyY'],
      skipped: ['breath'],
      unverified: ['gazeY'],
    },
  };
  let capabilityState = { unmapped: ['armL', 'handR', 'breath'], error: '' };
  let runtimeTouches = 0;
  const tools = createHostTools({
    features: { enabled: () => true },
    vtsClient: () => ({
      ready: true,
      model: { modelName: 'TestModel' },
      hotkeys: [{ name: 'hk' }],
      expressions: [{ name: 'exp' }],
    }),
    ensureAvatarRuntime: () => {
      runtimeTouches += 1;
      throw new Error('status must not create a runtime');
    },
    ensureAvatarRuntimeConnected: async () => {
      runtimeTouches += 1;
      return { ok: true };
    },
    avatarRuntimeStatus: () => runtimeState,
    avatarCapabilitiesStatus: () => capabilityState,
  });

  const status = await tools.executeLive2d({ action: 'status' });
  assert.equal(status.ok, true);
  assert.equal(status.connected, true);
  assert.deepEqual(status.controller, {
    running: true, locked: false, source: 'controller', lockReason: '',
  });
  assert.deepEqual(status.channels, {
    controlled: ['headX', 'bodyY'],
    skipped: ['breath'],
    unverified: ['gazeY'],
    vtsOwned: ['armL', 'handR', 'breath'],
  });
  assert.equal(status.lastError, '');
  assert.equal(runtimeTouches, 0, 'status is read-only: it never creates or connects the runtime');

  // A legacy writer or a lock is reported honestly, and the last failure stays visible.
  runtimeState = {
    connected: true,
    disposed: false,
    lastError: 'inject failed',
    motion: { source: 'legacy', locked: true, lockReason: 'privacy' },
    channels: { controlled: ['headX'], skipped: [], unverified: ['bodyY'] },
  };
  capabilityState = { unmapped: ['mouth'], error: '' };
  const degraded = await tools.executeLive2d({ action: 'status' });
  assert.equal(degraded.controller.running, false, 'the legacy 4 Hz writer is not the controller');
  assert.equal(degraded.controller.source, 'legacy');
  assert.equal(degraded.controller.locked, true);
  assert.equal(degraded.controller.lockReason, 'privacy');
  assert.equal(degraded.lastError, 'inject failed');
  assert.deepEqual(degraded.channels.vtsOwned, ['mouth']);

  console.log(`  [6] controller=${status.controller.running ? 'running' : 'stopped'}`
    + ` controlled=${status.channels.controlled.join(',')} vtsOwned=${status.channels.vtsOwned.join(',')}`);
});
