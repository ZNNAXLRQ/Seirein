/**
 * Action-mapping probe — head coverage, plugin eye gating, stale guards and startup auto-verify.
 *
 * Run: node --test test/avatar-motion-probe.mjs
 *
 * Pinned:
 *   1. one explicit probe measures gaze + head; `changed:true` keeps headX verified while
 *      `changed:false` marks headY/headZ mappingUnverified and never removes the channel;
 *      eyeOpenL/R are measured only while `blinkOwner:'plugin'`;
 *   2. an unverified head axis makes the base layer report `headDriven:false` and keep the channel
 *      with VTS (`source:'vts-native'`) instead of claiming the plugin drives it;
 *   3. a late old-head result can never verify the newly mapped head input (stale guard);
 *   4. the startup auto-verify path includes head (once per connection, source=startup);
 *   5. `verifyMappingsOnStartup:false` still starts no probe and reads no before/after values.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { WebSocketServer } from 'ws';

import { createAvatarRuntime } from '../src/host/avatar/avatarRuntime.js';
import { apply } from '../src/host/index.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

const waitFor = async (check, timeoutMs = 6000, stepMs = 25) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await sleep(stepMs);
  }
  return false;
};

const channelRow = (channel, inputName, parameterName, min, max) => ({
  channel,
  inputName,
  inputSource: 'test',
  injectable: true,
  verified: true,
  modelParams: [parameterName],
  min,
  max,
  defaultValue: 0,
});

const HEAD_ROWS = [
  channelRow('headX', 'FaceAngleX', 'ParamAngleX', -30, 30),
  channelRow('headY', 'FaceAngleY', 'ParamAngleY', -30, 30),
  channelRow('headZ', 'FaceAngleZ', 'ParamAngleZ', -90, 90),
];
const EYE_ROWS = [
  channelRow('eyeOpenL', 'EyeOpenLeft', 'ParamEyeLOpen', 0, 1),
  channelRow('eyeOpenR', 'EyeOpenRight', 'ParamEyeROpen', 0, 1),
];

function createTransport(probeInputMapping) {
  return {
    probeActive: false,
    connect: async () => {},
    disconnect: async () => {},
    write: () => ({ ok: true, acknowledged: true }),
    probeInputMapping,
  };
}

// ---------------------------------------------------------------------------------------------
// 1. head changed:true/false applies as evidence; eye rows only when the plugin owns blinking
// ---------------------------------------------------------------------------------------------
test('1. 头部 changed:true/false；eye 仅在 blinkOwner=plugin 时探测', async () => {
  const calls = [];
  let firstUnverified = [];
  const transport = createTransport(async ({ inputName, parameterNames }) => {
    calls.push({ inputName, parameterNames: [...parameterNames] });
    return {
      ok: true,
      changed: inputName === 'FaceAngleX',
      delta: { [parameterNames[0]]: inputName === 'FaceAngleX' ? 0.5 : 0 },
      error: '',
    };
  });
  const runtime = createAvatarRuntime({ transport, config: { autoTickMs: 0 } });
  try {
    assert.equal((await runtime.connect()).ok, true);
    assert.equal((await runtime.setChannelMappings(HEAD_ROWS)).ok, true);

    const result = await runtime.probeMapping();
    assert.equal(result.ok, true, `probe completed (${result.error})`);
    assert.deepEqual(Object.keys(result.channels).sort(), ['headX', 'headY', 'headZ']);
    assert.equal(result.channels.headX.changed, true);
    assert.equal(result.channels.headX.inputName, 'FaceAngleX');
    assert.deepEqual(result.channels.headX.parameterNames, ['ParamAngleX']);
    assert.equal(result.channels.headY.changed, false);
    assert.equal(result.channels.headZ.changed, false);
    assert.deepEqual(result.mappingUnverified.sort(), ['headY', 'headZ']);
    firstUnverified = [...result.mappingUnverified];
    assert.deepEqual(calls.map((entry) => entry.inputName).sort(),
      ['FaceAngleX', 'FaceAngleY', 'FaceAngleZ'], 'no eye input is measured under VTS blink owner');

    const snapshot = runtime.snapshot();
    assert.ok(snapshot.channels.controlled.includes('headX'), 'changed:true stays controlled');
    assert.equal(snapshot.channels.controlled.includes('headY'), false);
    assert.ok(snapshot.channels.unverified.includes('headY'));
    assert.deepEqual(snapshot.channels.headUnverified.sort(), ['headY', 'headZ']);
    assert.equal(snapshot.channels.probe.headX.changed, true);
    assert.equal(snapshot.channels.probe.headY.changed, false);
    assert.equal('before' in snapshot.channels.probe.headX, false, 'raw before values are not exposed');
    assert.equal('after' in snapshot.channels.probe.headX, false, 'raw after values are not exposed');

    // The unverified channel keeps its mapping (input + target parameter), it is never deleted.
    assert.equal(result.channels.headY.inputName, 'FaceAngleY');
    assert.deepEqual(result.channels.headY.parameterNames, ['ParamAngleY']);
  } finally {
    runtime.dispose();
  }

  // With blinkOwner=plugin the same action probe also measures both eyes and can open the owner.
  const eyeCalls = [];
  const pluginRuntime = createAvatarRuntime({
    transport: createTransport(async ({ inputName, parameterNames }) => {
      eyeCalls.push(inputName);
      return { ok: true, changed: inputName.startsWith('EyeOpen'), delta: { [parameterNames[0]]: 0.5 }, error: '' };
    }),
    config: { autoTickMs: 0, blinkOwner: 'plugin' },
  });
  try {
    assert.equal((await pluginRuntime.connect()).ok, true);
    assert.equal((await pluginRuntime.setChannelMappings([...HEAD_ROWS, ...EYE_ROWS])).ok, true);
    const result = await pluginRuntime.probeMapping();
    assert.ok(result.channels.eyeOpenL, 'left eye was measured with the plugin owner');
    assert.ok(result.channels.eyeOpenR, 'right eye was measured with the plugin owner');
    assert.equal(result.channels.eyeOpenL.changed, true);
    assert.equal(result.channels.eyeOpenR.changed, true);
    assert.ok(eyeCalls.includes('EyeOpenLeft') && eyeCalls.includes('EyeOpenRight'));
    assert.equal(pluginRuntime.snapshot().blink.owner, 'plugin', 'both verified eyes open the plugin owner');
  } finally {
    pluginRuntime.dispose();
  }
  console.log(`1) calls=${calls.map((entry) => entry.inputName).join(',')}`
    + ` unverified=${firstUnverified.join(',')} eyeCalls=${eyeCalls.length}`);
});

// ---------------------------------------------------------------------------------------------
// 2. an unverified head axis must not be reported as driven by the base layer
// ---------------------------------------------------------------------------------------------
test('2. 未验证头部：基础层 headDriven=false，通道归 VTS，不宣称已驱动', async () => {
  const runtime = createAvatarRuntime({
    transport: createTransport(async ({ parameterNames }) => ({
      ok: true,
      changed: false,
      delta: { [parameterNames[0]]: 0 },
      error: '',
    })),
    config: { autoTickMs: 0 },
  });
  try {
    assert.equal((await runtime.connect()).ok, true);
    assert.equal((await runtime.setChannelMappings(HEAD_ROWS)).ok, true);
    assert.equal(runtime.snapshot().motionLayers.baseActivity.headDriven, true,
      'name-verified head rows are writable before the probe');

    const result = await runtime.probeMapping();
    assert.deepEqual(result.mappingUnverified.sort(), ['headX', 'headY', 'headZ']);

    const snapshot = runtime.snapshot();
    assert.deepEqual(snapshot.channels.headUnverified.sort(), ['headX', 'headY', 'headZ']);
    assert.deepEqual(snapshot.motionLayers.baseActivity.headUnverified.sort(),
      ['headX', 'headY', 'headZ'], 'the base layer view names the unverified axes');
    assert.equal(snapshot.motionLayers.baseActivity.headDriven, false,
      'no unverified head axis is claimed as driven');
    for (const channel of ['headX', 'headY', 'headZ']) {
      assert.equal(snapshot.motionLayers.channelOwnership.channels[channel].source, 'vts-native',
        `${channel} stays with VTS`);
      assert.notEqual(snapshot.motionLayers.channelOwnership.channels[channel].status, 'plugin');
    }
    assert.equal(snapshot.motionLayers.baseActivity.headProbe.headX.changed, false);
    console.log(`2) headUnverified=${snapshot.channels.headUnverified.join(',')}`
      + ` headDriven=${snapshot.motionLayers.baseActivity.headDriven}`);
  } finally {
    runtime.dispose();
  }
});

// ---------------------------------------------------------------------------------------------
// 3. a late old-head result must not verify the newly mapped head binding
// ---------------------------------------------------------------------------------------------
test('3. stale：旧 head 结果迟到不得验证新 head 映射', async () => {
  const pending = deferred();
  const started = deferred();
  const calls = [];
  const transport = createTransport(async ({ inputName, parameterNames }) => {
    calls.push(inputName);
    if (calls.length === 1) {
      started.resolve(inputName);
      return pending.promise;
    }
    return { ok: true, changed: true, delta: { [parameterNames[0]]: 0.5 }, error: '' };
  });
  const runtime = createAvatarRuntime({ transport, config: { autoTickMs: 0 } });
  try {
    assert.equal((await runtime.connect()).ok, true);
    const oldRow = channelRow('headX', 'OldHead', 'ParamAngleX', -30, 30);
    assert.equal((await runtime.setChannelMappings([oldRow])).ok, true);

    const probe = runtime.probeMapping();
    assert.equal(await started.promise, 'OldHead', 'the probe measured the old head input');

    // The mapping changes while the probe is still in flight; the new head row starts unverified.
    const newRow = { ...channelRow('headX', 'NewHead', 'ParamAngleX', -30, 30), verified: false };
    assert.equal((await runtime.setChannelMappings([newRow])).ok, true);
    assert.equal(runtime.snapshot().channels.controlled.includes('headX'), false);
    assert.ok(runtime.snapshot().channels.unverified.includes('headX'));

    pending.resolve({ ok: true, changed: true, delta: { ParamAngleX: 0.5 }, error: '' });
    const stale = await probe;
    assert.equal(stale.stale, true, 'the late result is marked stale');
    assert.match(String(stale.discarded), /mapping|binding/u, `discarded=${stale.discarded}`);
    assert.equal(stale.applied, false);
    assert.deepEqual(stale.channels, {}, 'a stale result exposes no applicable evidence');
    assert.deepEqual(stale.mappingUnverified, [], 'a stale result marks nothing unverified');
    assert.equal(stale.discardedChannels.headX.inputName, 'OldHead');

    const after = runtime.snapshot();
    assert.equal(after.channels.controlled.includes('headX'), false,
      'the old changed:true result did not verify NewHead');
    assert.ok(after.channels.unverified.includes('headX'));
    assert.equal(after.channels.probe.headX, undefined, 'no probe evidence was written for the stale row');

    // A live probe of the current mapping still works and verifies NewHead.
    const fresh = await runtime.probeMapping();
    assert.equal(fresh.channels.headX.inputName, 'NewHead');
    assert.equal(fresh.channels.headX.changed, true);
    assert.ok(runtime.snapshot().channels.controlled.includes('headX'));
    assert.deepEqual(calls, ['OldHead', 'NewHead']);
    console.log(`3) discarded=${stale.discarded} calls=${calls.join(',')} newHeadVerified=true`);
  } finally {
    runtime.dispose();
  }
});

// ---------------------------------------------------------------------------------------------
// 4./5. real host wiring: startup verification includes head; the off switch still starts nothing
// ---------------------------------------------------------------------------------------------
async function createFakeVts() {
  const state = {
    model: { modelName: 'HeadProbeModel', modelID: 'head-probe-model' },
    params: {
      ParamEyeBallX: 0,
      ParamEyeBallY: 0,
      ParamAngleX: 0,
      ParamAngleY: 0,
      ParamAngleZ: 0,
    },
  };
  const requests = [];
  const server = createServer();
  const wss = new WebSocketServer({ server });
  const send = (socket, message) => {
    try {
      socket.send(JSON.stringify(message));
    } catch {
      /* socket already gone */
    }
  };
  const respond = (socket, request, data) => send(socket, {
    apiName: 'VTubeStudioPublicAPI',
    apiVersion: '1.0',
    requestID: request.requestID,
    messageType: `${String(request.messageType).replace(/Request$/u, '')}Response`,
    data,
  });
  const respondApiError = (socket, request, message) => send(socket, {
    apiName: 'VTubeStudioPublicAPI',
    apiVersion: '1.0',
    requestID: request.requestID,
    messageType: 'APIError',
    data: { errorID: 100, message },
  });

  wss.on('connection', (socket) => {
    socket.on('message', (raw) => {
      let request;
      try {
        request = JSON.parse(String(raw));
      } catch {
        return;
      }
      requests.push({ messageType: request.messageType, data: request.data ?? {} });
      switch (request.messageType) {
        case 'AuthenticationTokenRequest':
          respond(socket, request, { authenticationToken: 'fake-token' });
          return;
        case 'AuthenticationRequest':
          respond(socket, request, { authenticated: true });
          return;
        case 'CurrentModelRequest':
          respond(socket, request, { modelLoaded: true, ...state.model });
          return;
        case 'HotkeysInCurrentModelRequest':
          respond(socket, request, { availableHotkeys: [] });
          return;
        case 'ExpressionStateRequest':
          respond(socket, request, { expressions: [] });
          return;
        case 'InputParameterListRequest':
          respond(socket, request, {
            defaultParameters: [
              { name: 'EyeRightX', min: -1, max: 1, defaultValue: 0 },
              { name: 'EyeRightY', min: -1, max: 1, defaultValue: 0 },
              { name: 'FaceAngleX', min: -30, max: 30, defaultValue: 0 },
              { name: 'FaceAngleY', min: -30, max: 30, defaultValue: 0 },
              { name: 'FaceAngleZ', min: -90, max: 90, defaultValue: 0 },
            ],
            customParameters: [],
          });
          return;
        case 'Live2DParameterListRequest':
          respond(socket, request, {
            live2DModelParameters: Object.entries(state.params).map(([name, value]) => ({
              name,
              value,
              min: -90,
              max: 90,
              defaultValue: 0,
            })),
          });
          return;
        case 'EventSubscriptionRequest': {
          const eventName = String(request.data?.eventName ?? 'ModelLoadedEvent');
          respond(socket, request, { subscribedEventCount: 1, subscribedEvents: [eventName] });
          return;
        }
        case 'InjectParameterDataRequest': {
          // Only FaceAngleX/Y/Z and EyeRightX move their model parameter; EyeRightY is the honest
          // "injectable but unchanged" case that must stay unverified.
          for (const entry of Array.isArray(request.data?.parameterValues) ? request.data.parameterValues : []) {
            if (entry?.id === 'EyeRightX') state.params.ParamEyeBallX = Number(entry.value);
            if (entry?.id === 'FaceAngleX') state.params.ParamAngleX = Number(entry.value);
            if (entry?.id === 'FaceAngleY') state.params.ParamAngleY = Number(entry.value);
            if (entry?.id === 'FaceAngleZ') state.params.ParamAngleZ = Number(entry.value);
          }
          respond(socket, request, {});
          return;
        }
        default:
          respondApiError(socket, request, `Unknown message type: ${request.messageType}`);
      }
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    requests,
    state,
    count: (messageType) => requests.filter((entry) => entry.messageType === messageType).length,
    async close() {
      for (const socket of wss.clients) socket.terminate();
      await new Promise((done) => wss.close(() => server.close(() => done())));
    },
  };
}

async function startHost(fake, { settings } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'avatar-motion-probe-'));
  await mkdir(join(root, 'data'), { recursive: true });
  await writeFile(join(root, 'data', 'features.json'), JSON.stringify({ avatar: true }), 'utf8');
  if (settings !== undefined) {
    await writeFile(join(root, 'data', 'settings.json'), JSON.stringify(settings), 'utf8');
  }
  const routes = new Map();
  const disposers = [];
  const collect = (fn) => {
    const dispose = fn();
    if (typeof dispose === 'function') disposers.push(dispose);
    return dispose;
  };
  const fakeCtx = {
    effect: collect,
    tools: { register: () => () => {} },
    inject: (_names, callback) => callback({
      effect: collect,
      webServer: {
        register: (route) => {
          routes.set(route.path, route.handler);
          return () => {};
        },
      },
      systemPrompt: { section: () => () => {} },
    }),
  };
  apply(fakeCtx, { root, vtsPort: fake.port, enabled: true });

  const callRoute = async (path, { method = 'POST', body = undefined } = {}) => {
    const handler = routes.get(path);
    if (handler === undefined) throw new Error(`route not registered: ${path}`);
    const req = new EventEmitter();
    req.method = method;
    req.url = path;
    req.setEncoding = () => {};
    req.destroy = () => {};
    setImmediate(() => {
      if (body !== undefined) req.emit('data', JSON.stringify(body));
      req.emit('end');
    });
    const res = {
      code: 0,
      body: '',
      writeHead(code) { this.code = code; },
      end(data) { this.body = String(data ?? ''); },
    };
    await handler(req, res);
    try {
      return JSON.parse(res.body);
    } catch {
      return { raw: res.body };
    }
  };

  const status = () => callRoute('/assistant/status', { method: 'GET' });
  const events = async () => (await readFile(join(root, 'data', 'events.jsonl'), 'utf8').catch(() => ''))
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const dispose = () => {
    for (const disposer of disposers.reverse()) {
      try {
        const result = disposer();
        if (result && typeof result.catch === 'function') result.catch(() => {});
      } catch {
        /* best effort */
      }
    }
  };
  return { root, callRoute, status, events, dispose };
}

test('4. 启动自动验证包含 head（每次连接一次，source=startup）', async (t) => {
  const fake = await createFakeVts();
  const host = await startHost(fake);
  t.after(async () => {
    host.dispose();
    await fake.close();
  });

  const connected = await host.callRoute('/assistant/action', { body: { action: 'live2d.connect' } });
  assert.equal(connected.ok, true, `connect succeeds (${connected.error ?? ''})`);
  assert.equal(await waitFor(async () => {
    const snapshot = await host.status();
    return snapshot.avatar?.mapping?.channels?.headX?.changed === true
      && snapshot.avatar.mapping.channels.headZ?.changed === true;
  }), true, 'the startup probe measured the head channels');

  const snapshot = await host.status();
  const mapping = snapshot.avatar.mapping;
  assert.equal(mapping.ok, true);
  assert.equal(mapping.channels.gazeX.changed, true);
  assert.equal(mapping.channels.gazeY.changed, false);
  assert.deepEqual(mapping.unverified, ['gazeY']);
  for (const channel of ['headX', 'headY', 'headZ']) {
    assert.equal(mapping.channels[channel].changed, true, `${channel} changed:true`);
    assert.equal(mapping.channels[channel].inputName.startsWith('FaceAngle'), true);
    assert.equal(mapping.channels[channel].parameterNames[0].startsWith('ParamAngle'), true);
    assert.equal('before' in mapping.channels[channel], false, 'no raw before values');
    assert.equal('after' in mapping.channels[channel], false, 'no raw after values');
  }
  assert.ok(snapshot.live2d.capabilities.verified.includes('headX'));
  assert.ok(snapshot.live2d.capabilities.verified.includes('headY'));
  assert.ok(snapshot.live2d.capabilities.verified.includes('headZ'));
  assert.deepEqual(snapshot.live2d.capabilities.headUnverified, []);
  assert.equal(snapshot.live2d.runtime.channels.headUnverified.length, 0);
  assert.equal(snapshot.live2d.runtime.channels.probe.headX.changed, true);
  assert.equal(snapshot.live2d.runtime.motionLayers.baseActivity.headDriven, true);
  assert.deepEqual(snapshot.live2d.runtime.motionLayers.baseActivity.headUnverified, []);

  const startup = (await host.events()).filter((entry) => entry.type === 'avatar.mapping.probe'
    && entry.payload?.source === 'startup');
  assert.equal(startup.length, 1, 'exactly one startup probe event');
  assert.equal(startup[0].payload.channels.headX.changed, true);
  assert.equal(JSON.stringify(startup[0].payload).includes('before'), false);
  // Head inputs carry the documented VTS ranges; the probe value is the normalised 0.5.
  const faceInjections = fake.requests.filter((entry) => entry.messageType === 'InjectParameterDataRequest'
    && Array.isArray(entry.data?.parameterValues)
    && entry.data.parameterValues.some((row) => String(row?.id ?? '').startsWith('FaceAngle')));
  assert.ok(faceInjections.some((entry) => entry.data.parameterValues.some((row) => row.id === 'FaceAngleX'
    && Number(row.value) === 0.5)), 'FaceAngleX probe value was sent');
  console.log(`4) head=${['headX', 'headY', 'headZ']
    .map((channel) => mapping.channels[channel].changed).join(',')}`
    + ` startupEvents=${startup.length} headDriven=${snapshot.live2d.runtime.motionLayers.baseActivity.headDriven}`);
});

test('5. verifyMappingsOnStartup=false：连接后不启动 probe，也不做 before/after 读取', async (t) => {
  const fake = await createFakeVts();
  const host = await startHost(fake, {
    settings: { avatar: { verifyMappingsOnStartup: false, blinkOwner: 'vts' } },
  });
  t.after(async () => {
    host.dispose();
    await fake.close();
  });

  const connected = await host.callRoute('/assistant/action', { body: { action: 'live2d.connect' } });
  assert.equal(connected.ok, true, `connect succeeds (${connected.error ?? ''})`);
  assert.equal(await waitFor(async () => {
    const snapshot = await host.status();
    const controlled = snapshot.live2d?.runtime?.channels?.controlled ?? [];
    return snapshot.live2d?.ready === true
      && controlled.includes('headX') && controlled.includes('headZ');
  }), true, 'discovery mapped the head channels without probing them');

  const readsAfterDiscovery = fake.count('Live2DParameterListRequest');
  await sleep(300);
  const snapshot = await host.status();
  assert.equal(snapshot.avatar.verifyMappingsOnStartup, false);
  assert.equal(snapshot.avatar.mapping.lastAt, null, 'no startup probe record');
  assert.equal((await host.events()).some((entry) => entry.type === 'avatar.mapping.probe'), false,
    'no probe event');
  assert.equal(fake.count('Live2DParameterListRequest'), readsAfterDiscovery,
    'status/discovery did not start a before/after probe');
  assert.deepEqual(snapshot.live2d.capabilities.probeEvidence, {},
    'name-verified head rows carry no runtime probe evidence yet');
  console.log(`5) setting=false mapping.lastAt=${snapshot.avatar.mapping.lastAt}`
    + ` reads=${readsAfterDiscovery} probeEvents=0`);
});

// ---------------------------------------------------------------------------------------------
// 6. blink ownership follows the EFFECTIVE writer, while its evidence stays visible
// ---------------------------------------------------------------------------------------------
test('6. channelOwnership.blink：默认 vts → vts-native/native；plugin 且双眼验证才标 plugin', async () => {
  const makeRuntime = async (blinkOwner) => {
    let clock = 1_000_000;
    const runtime = createAvatarRuntime({
      transport: createTransport(async ({ parameterNames }) => ({
        ok: true,
        changed: true,
        delta: { [parameterNames[0]]: 0.5 },
        error: '',
      })),
      now: () => clock,
      config: { autoTickMs: 0, blinkOwner },
    });
    assert.equal((await runtime.connect()).ok, true);
    assert.equal((await runtime.setChannelMappings([...HEAD_ROWS, ...EYE_ROWS])).ok, true);
    // Generate real blink-machine cycles so "generated > 0" cannot be mistaken for a plugin write.
    for (; clock <= 1_014_000; clock += 33) runtime.tick(clock);
    return runtime;
  };

  const vtsOwned = await makeRuntime('vts');
  try {
    const blink = vtsOwned.snapshot().motion.channelOwnership.channels.blink;
    assert.equal(blink.source, 'vts-native', 'the plugin does not write eyes under VTS ownership');
    assert.equal(blink.owner, 'vts-native');
    assert.equal(blink.status, 'native');
    assert.equal(blink.verified, false, 'ownership is not claimed as verified plugin output');
    assert.equal(blink.eyeVerified, true, 'both eye mappings are still proven');
    assert.equal(blink.requestedOwner, 'vts');
    assert.ok(blink.generated > 0, 'the blink machine still generated cycles');
    assert.equal(blink.sent, 0, 'generated cycles are not a plugin eye write');
    assert.ok(vtsOwned.snapshot().motion.channelOwnership.vtsNative.includes('blink'));
    assert.equal(vtsOwned.snapshot().motion.channelOwnership.plugin.includes('blink'), false);
  } finally {
    vtsOwned.dispose();
  }

  const pluginOwned = await makeRuntime('plugin');
  try {
    const snapshot = pluginOwned.snapshot();
    const blink = snapshot.motion.channelOwnership.channels.blink;
    assert.equal(blink.source, 'plugin');
    assert.equal(blink.owner, 'plugin');
    assert.equal(blink.status, 'plugin');
    assert.equal(blink.verified, true);
    assert.equal(blink.eyeVerified, true);
    assert.equal(blink.requestedOwner, 'plugin');
    assert.ok(blink.generated > 0);
    assert.ok(snapshot.motion.channelOwnership.plugin.includes('blink'));
    assert.equal(snapshot.blink.owner, 'plugin');
    console.log(`6) vts=${vtsOwned.snapshot().blink.owner} plugin=${blink.owner}`
      + ` generated=${blink.generated} sent=${blink.sent}`);
  } finally {
    pluginOwned.dispose();
  }
});

