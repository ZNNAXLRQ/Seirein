/**
 * Optional runtime mapping probe — does an injectable VTS input really drive a model parameter?
 *
 * Run: node --test test/vts-gaze-probe.mjs
 *
 * The fake here is a `client.request` stub, not a WebSocket server: every VTS answer the probe
 * consumes (GetParameterValues, InjectParameterDataRequest) is exercised through the real
 * VtsClient.probeInputMapping() code path, including its 80 ms wait, its frame-loop pause flag and
 * its best-effort restore to 0. The capability test drives the real discoverCapabilities() with a
 * stub probe function, so the rule under test is "only changed:true keeps verified; a failed probe
 * marks the channel mappingUnverified but never removes it".
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { VtsClient } from '../src/host/avatar/vts.js';
import {
  PROBE_CHANNEL_ORDER,
  discoverCapabilities,
  resetCapabilities,
} from '../src/host/avatar/avatarMotion.js';

const OPEN = 1;

const clone = (value) => JSON.parse(JSON.stringify(value));

/**
 * A client whose transport is a request stub. `mapped:false` models an input that VTS accepts but
 * whose value does not reach any model parameter (the exact false positive a name rule produces).
 */
function createProbeClient({ mapped = true, failOn = '', values = {} } = {}) {
  const client = new VtsClient({ tokenPath: 'unused-token.json' });
  // `connected` is a getter over socket.readyState; a plain OPEN sentinel is enough because every
  // request is served by the stub below and no real socket is created.
  client.socket = { readyState: OPEN };
  client.authenticated = true;
  const requests = [];
  const params = { ParamEyeBallX: 0, ParamEyeBallY: 0, ...values };

  client.request = async (messageType, data = {}) => {
    requests.push({ messageType, data: clone(data) });
    if (failOn === messageType) {
      const error = new Error(`${messageType} timed out`);
      error.code = 'PROBE_TEST_TIMEOUT';
      throw error;
    }
    if (messageType === 'GetParameterValues') {
      return {
        messageType: 'GetParameterValuesResponse',
        data: {
          parameterValues: (Array.isArray(data.parameterNames) ? data.parameterNames : [])
            .map((name) => ({ name, value: params[name] ?? null })),
        },
      };
    }
    if (messageType === 'InjectParameterDataRequest') {
      if (mapped === true) {
        for (const entry of Array.isArray(data.parameterValues) ? data.parameterValues : []) {
          if (entry.id === 'EyeRightX') params.ParamEyeBallX = entry.value;
          if (entry.id === 'EyeRightY') params.ParamEyeBallY = entry.value;
        }
      }
      return { messageType: 'InjectParameterDataResponse', data: {} };
    }
    throw new Error(`unexpected request ${messageType}`);
  };

  return { client, requests, params };
}

const injections = (requests) => requests.filter((entry) => entry.messageType === 'InjectParameterDataRequest');

// ---------------------------------------------------------------------------------------------
// 1. a real value change is evidence
// ---------------------------------------------------------------------------------------------
test('1. before/after 参数变化 → changed:true', async () => {
  const fake = createProbeClient({ mapped: true });
  const result = await fake.client.probeInputMapping({
    inputName: 'EyeRightX',
    parameterNames: ['ParamEyeBallX'],
    value: 0.5,
  });

  assert.equal(result.ok, true, `probe completed (${result.error})`);
  assert.equal(result.changed, true, 'a moved parameter is evidence');
  assert.equal(result.inputName, 'EyeRightX');
  assert.deepEqual(result.parameterNames, ['ParamEyeBallX']);
  assert.equal(result.before.ParamEyeBallX, 0);
  assert.ok(Math.abs(result.after.ParamEyeBallX - 0.5) < 1e-9);
  assert.ok(result.delta.ParamEyeBallX > 0.01, `delta ${result.delta.ParamEyeBallX} exceeds the threshold`);
  assert.equal(result.error, '');
  console.log(`     changed=${result.changed} before=${result.before.ParamEyeBallX}`
    + ` after=${result.after.ParamEyeBallX} delta=${result.delta.ParamEyeBallX}`);
});

// ---------------------------------------------------------------------------------------------
// 2. an accepted injection with no parameter movement is NOT evidence
// ---------------------------------------------------------------------------------------------
test('2. 注入被接受但参数不变 → changed:false（名称/存在不等于驱动）', async () => {
  const fake = createProbeClient({ mapped: false, values: { ParamEyeBallX: 0.12 } });
  const result = await fake.client.probeInputMapping({
    inputName: 'EyeRightX',
    parameterNames: ['ParamEyeBallX'],
    value: 0.5,
  });

  assert.equal(result.ok, true, `the reads and the injection all succeeded (${result.error})`);
  assert.equal(result.changed, false, 'no parameter movement means no evidence');
  assert.equal(result.before.ParamEyeBallX, 0.12);
  assert.equal(result.after.ParamEyeBallX, 0.12);
  assert.equal(result.delta.ParamEyeBallX, 0);
  console.log(`     changed=${result.changed} before=${result.before.ParamEyeBallX}`
    + ` after=${result.after.ParamEyeBallX} delta=${result.delta.ParamEyeBallX}`);
});

// ---------------------------------------------------------------------------------------------
// 3. the probe restores the input to 0, and it does so after the after-read
// ---------------------------------------------------------------------------------------------
test('3. 探测结束后恢复 input=0（after 之后）', async () => {
  const fake = createProbeClient({ mapped: true });
  const result = await fake.client.probeInputMapping({
    inputName: 'EyeRightX',
    parameterNames: ['ParamEyeBallX'],
    value: 0.5,
  });
  assert.equal(result.ok, true);

  const sent = fake.requests.map((entry) => entry.messageType);
  assert.deepEqual(sent, [
    'GetParameterValues',
    'InjectParameterDataRequest',
    'GetParameterValues',
    'InjectParameterDataRequest',
  ], 'read → inject → read → restore');
  const sentInjections = injections(fake.requests);
  assert.equal(sentInjections[0].data.parameterValues[0].value, 0.5, 'the probe value was injected');
  assert.equal(sentInjections[1].data.parameterValues[0].id, 'EyeRightX', 'the same input is restored');
  assert.equal(sentInjections[1].data.parameterValues[0].value, 0, 'the restore value is 0');
  assert.equal(fake.params.ParamEyeBallX, 0, 'the model parameter also returned to 0');
  console.log(`     order=${sent.join(' → ')} restored=${sentInjections[1].data.parameterValues[0].value}`);
});

// ---------------------------------------------------------------------------------------------
// 4. timeouts / VTS errors / no connection never throw
// ---------------------------------------------------------------------------------------------
test('4. 超时/错误安全返回 ok:false，不抛异常', async () => {
  const readFailure = createProbeClient({ failOn: 'GetParameterValues' });
  const readResult = await readFailure.client.probeInputMapping({
    inputName: 'EyeRightX',
    parameterNames: ['ParamEyeBallX'],
  });
  assert.equal(readResult.ok, false, 'a read timeout is reported as data');
  assert.match(readResult.error, /timed out/u);
  assert.equal(readResult.changed, false);
  assert.equal(injections(readFailure.requests).length, 0, 'no injection after a failed before-read');

  const injectFailure = createProbeClient({ failOn: 'InjectParameterDataRequest' });
  const injectResult = await injectFailure.client.probeInputMapping({
    inputName: 'EyeRightX',
    parameterNames: ['ParamEyeBallX'],
  });
  assert.equal(injectResult.ok, false, 'an injection failure is reported as data');
  assert.match(injectResult.error, /timed out/u);
  assert.equal(injectResult.changed, false);
  // The restore is attempted (best effort) even though the inject request failed: the probe
  // request itself plus the restore request are both visible to the stub.
  const attempts = injections(injectFailure.requests);
  assert.equal(attempts.length, 2, 'the probe attempt and one restore attempt were made');
  assert.equal(attempts[1].data.parameterValues[0].value, 0, 'the second attempt is the restore to 0');

  const disconnected = new VtsClient({ tokenPath: 'unused-token.json' });
  const offline = await disconnected.probeInputMapping({
    inputName: 'EyeRightX',
    parameterNames: ['ParamEyeBallX'],
  });
  assert.equal(offline.ok, false);
  assert.match(offline.error, /not connected/iu);

  const invalid = await disconnected.probeInputMapping({ inputName: '', parameterNames: [] });
  assert.equal(invalid.ok, false);
  assert.match(invalid.error, /inputName/u);
  console.log(`     read=${readResult.error.slice(0, 40)} inject=${injectResult.error.slice(0, 40)}`
    + ` offline=${offline.error} invalid=${invalid.error}`);
});

// ---------------------------------------------------------------------------------------------
// 5. discovery marks unproven gaze mappings without deleting the eye channel
// ---------------------------------------------------------------------------------------------
test('5. 能力发现：未变化的 probe → mappingUnverified，eye 通道保留', async () => {
  resetCapabilities();
  const probed = [];
  const changing = false;
  const result = await discoverCapabilities({
    identity: { modelId: 'probe-fake-model', modelGeneration: 1, connectionGeneration: 1 },
    force: true,
    probeMappings: true,
    probeInputMapping: async (request) => {
      probed.push(clone(request));
      return { ok: true, changed: changing, before: {}, after: {}, delta: {} };
    },
    listInputParameters: async () => ({
      defaultParameters: [
        { name: 'EyeRightX', min: -1, max: 1, defaultValue: 0 },
        { name: 'EyeRightY', min: -1, max: 1, defaultValue: 0 },
      ],
      customParameters: [],
    }),
    listModelParameters: async () => ({
      ok: true,
      source: 'fake',
      parameters: [{ name: 'ParamEyeBallX' }, { name: 'ParamEyeBallY' }],
    }),
  });

  const byChannel = Object.fromEntries(result.channels.map((entry) => [entry.channel, entry]));
  for (const channel of PROBE_CHANNEL_ORDER) {
    const entry = byChannel[channel];
    assert.equal(entry.injectable, true, `${channel} stays injectable`);
    assert.equal(entry.inputName.startsWith('EyeRight'), true, `${channel} keeps its input name`);
    assert.equal(entry.verified, false, `${channel} is not verified by an unchanged probe`);
    assert.equal(entry.mappingUnverified, true, `${channel} is marked mappingUnverified`);
    assert.equal(entry.probe.ok, true, `${channel} records the successful probe read`);
    assert.equal(entry.probe.changed, false, `${channel} records changed:false`);
  }
  assert.equal(probed.length, 2, 'exactly the two gaze channels were probed');
  assert.deepEqual(probed.map((entry) => entry.inputName).sort(), ['EyeRightX', 'EyeRightY']);
  assert.deepEqual(probed.map((entry) => entry.parameterNames).flat().sort(),
    ['ParamEyeBallX', 'ParamEyeBallY']);
  assert.ok(result.mapped.includes('gazeX') && result.mapped.includes('gazeY'),
    'the channels remain mapped (injectable)');
  assert.ok(!result.unmapped.includes('gazeX') && !result.unmapped.includes('gazeY'),
    'the eye channels are not deleted');
  assert.deepEqual(result.mappingUnverified.sort(), ['gazeX', 'gazeY']);
  assert.ok(!result.verified.includes('gazeX') && !result.verified.includes('gazeY'));
  assert.equal(result.probeError, '');
  const probeLog = result.channels.filter((entry) => entry.channel === 'gazeX')
    .map((entry) => entry.notes).join('');
  assert.match(probeLog, /mappingUnverified/u);
  console.log(`     probed=${probed.map((entry) => entry.inputName).join(',')}`
    + ` mapped=${result.mapped.join(',')} verified=${result.verified.join(',') || '(none)'}`
    + ` unverified=${result.mappingUnverified.join(',')}`);

  // A changed probe keeps the name-rule verification. A fresh identity avoids the module cache.
  resetCapabilities();
  const confirmed = await discoverCapabilities({
    identity: { modelId: 'probe-confirmed-model', modelGeneration: 1, connectionGeneration: 1 },
    force: true,
    probeMappings: true,
    probeInputMapping: async () => ({
      ok: true,
      changed: true,
      before: { ParamEyeBallX: 0 },
      after: { ParamEyeBallX: 0.5 },
      delta: { ParamEyeBallX: 0.5 },
    }),
    listInputParameters: async () => ({
      defaultParameters: [
        { name: 'EyeRightX', min: -1, max: 1, defaultValue: 0 },
        { name: 'EyeRightY', min: -1, max: 1, defaultValue: 0 },
      ],
      customParameters: [],
    }),
    listModelParameters: async () => ({
      ok: true,
      source: 'fake',
      parameters: [{ name: 'ParamEyeBallX' }, { name: 'ParamEyeBallY' }],
    }),
  });
  assert.ok(confirmed.verified.includes('gazeX') && confirmed.verified.includes('gazeY'),
    'changed:true keeps the channels verified');
  assert.deepEqual(confirmed.mappingUnverified, [], 'a confirmed probe is not marked unverified');
  const confirmedX = confirmed.channels.find((entry) => entry.channel === 'gazeX');
  assert.equal(confirmedX.probe.delta.ParamEyeBallX, 0.5, 'the probe delta is kept as evidence');

  // Default is OFF: without probeMappings the probe is never called and name-rule verification
  // stays exactly as before.
  resetCapabilities();
  let defaultCalls = 0;
  const plain = await discoverCapabilities({
    identity: { modelId: 'probe-default-model', modelGeneration: 1, connectionGeneration: 1 },
    force: true,
    probeInputMapping: async () => {
      defaultCalls += 1;
      return { ok: true, changed: false };
    },
    listInputParameters: async () => ({
      defaultParameters: [
        { name: 'EyeRightX', min: -1, max: 1, defaultValue: 0 },
        { name: 'EyeRightY', min: -1, max: 1, defaultValue: 0 },
      ],
      customParameters: [],
    }),
    listModelParameters: async () => ({
      ok: true,
      source: 'fake',
      parameters: [{ name: 'ParamEyeBallX' }, { name: 'ParamEyeBallY' }],
    }),
  });
  assert.equal(defaultCalls, 0, 'probeMappings defaults to false');
  assert.ok(plain.verified.includes('gazeX') && plain.verified.includes('gazeY'),
    'the existing name rule is unchanged when probing is off');
  console.log(`     confirmed=${confirmed.verified.join(',')} defaultProbeCalls=${defaultCalls}`);
});
