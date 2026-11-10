/**
 * Startup gaze-mapping auto-verification (`settings.avatar.verifyMappingsOnStartup`).
 *
 * Run: node --test test/avatar-mapping-autoverify.mjs
 *
 * Pinned:
 *   1. default (missing key) = true: connect + capability discovery runs the gaze probe once and
 *      the existing status/event record receives the result, marked `source:'startup'`;
 *   2. an explicit persisted false opts out (no probe, no extra parameter reads);
 *   3. the same connection never probes twice, while a reconnect can probe once again;
 *   4. no gaze input/modelParams and an unconnected VTS are safe skips (no probe, no throw);
 *   5. the manual action still performs exactly one measurement, and the settings switch writes
 *      only `settings.avatar.verifyMappingsOnStartup` (other avatar fields survive, invalid values
 *      are rejected without touching the file);
 *   6. privacy cancels the startup attempt and leaving privacy does not turn it into a retry;
 *   7. the runtime cancellation predicate itself discards an in-flight result instead of applying
 *      changed:true, so a revoked startup measurement can never verify a channel.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { WebSocketServer } from 'ws';

import { apply } from '../src/host/index.js';
import { createAvatarRuntime } from '../src/host/avatar/avatarRuntime.js';

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

// ---------------------------------------------------------------------------------------------
// fake VTS: one model, two gaze inputs that move the model parameters they are mapped to
// ---------------------------------------------------------------------------------------------
async function createFakeVts({ gaze = true } = {}) {
  const state = {
    model: { modelName: gaze ? 'AutoVerifyModel' : 'NoGazeModel', modelID: gaze ? 'auto-verify' : 'no-gaze' },
    params: gaze
      ? { ParamEyeBallX: 0, ParamEyeBallY: 0 }
      : { ParamMouthOpenY: 0 },
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
            defaultParameters: gaze
              ? [
                { name: 'EyeRightX', min: -1, max: 1, defaultValue: 0 },
                { name: 'EyeRightY', min: -1, max: 1, defaultValue: 0 },
              ]
              : [{ name: 'MouthOpen', min: 0, max: 1, defaultValue: 0 }],
            customParameters: [],
          });
          return;
        case 'Live2DParameterListRequest':
          respond(socket, request, {
            live2DModelParameters: gaze
              ? [
                { name: 'ParamEyeBallX', value: state.params.ParamEyeBallX, min: -1, max: 1, defaultValue: 0 },
                { name: 'ParamEyeBallY', value: state.params.ParamEyeBallY, min: -1, max: 1, defaultValue: 0 },
              ]
              : [
                { name: 'ParamMouthOpenY', value: state.params.ParamMouthOpenY, min: 0, max: 1, defaultValue: 0 },
              ],
          });
          return;
        case 'EventSubscriptionRequest': {
          const eventName = String(request.data?.eventName ?? 'ModelLoadedEvent');
          respond(socket, request, { subscribedEventCount: 1, subscribedEvents: [eventName] });
          return;
        }
        case 'InjectParameterDataRequest': {
          // EyeRightX moves its target; EyeRightY is the honest unchanged case (still injectable,
          // so the auto result must be `ok:true` with gazeY unverified, not a failed probe).
          for (const entry of Array.isArray(request.data?.parameterValues) ? request.data.parameterValues : []) {
            if (entry?.id === 'EyeRightX') state.params.ParamEyeBallX = Number(entry.value);
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
    disconnectClients() {
      for (const socket of wss.clients) socket.terminate();
    },
    async close() {
      for (const socket of wss.clients) socket.terminate();
      await new Promise((done) => wss.close(() => server.close(() => done())));
    },
  };
}

// ---------------------------------------------------------------------------------------------
// real host wiring around the fake socket
// ---------------------------------------------------------------------------------------------
async function startHost(fake, { settings } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'avatar-mapping-autoverify-'));
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
  const action = (body) => callRoute('/assistant/action', { body });
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
  const probeEvents = async (source = undefined) => (await events())
    .filter((entry) => entry.type === 'avatar.mapping.probe'
      && (source === undefined || entry.payload?.source === source));
  const readSettings = async () => JSON.parse(await readFile(join(root, 'data', 'settings.json'), 'utf8'));
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
  return { root, callRoute, status, action, events, probeEvents, readSettings, dispose };
}

const connect = async (host) => host.callRoute('/assistant/action', { body: { action: 'live2d.connect' } });

// ---------------------------------------------------------------------------------------------
// 1. default true: one automatic startup probe with the existing status/event contract
// ---------------------------------------------------------------------------------------------
test('1. 缺省 true：连接+发现后自动 probe 一次，status 有结果，source=startup', async (t) => {
  const fake = await createFakeVts();
  const host = await startHost(fake);
  t.after(async () => {
    host.dispose();
    await fake.close();
  });

  const connected = await connect(host);
  assert.equal(connected.ok, true, `connect succeeds (${connected.error ?? ''})`);
  assert.equal(await waitFor(async () => {
    const snapshot = await host.status();
    return snapshot.avatar?.mapping?.lastAt !== null
      && snapshot.avatar.mapping.channels?.gazeX?.changed === true;
  }), true, 'the startup probe recorded a gaze result');

  const snapshot = await host.status();
  assert.equal(snapshot.avatar.verifyMappingsOnStartup, true, 'missing setting defaults to true');
  assert.equal(snapshot.avatar.mapping.ok, true);
  assert.equal(snapshot.avatar.mapping.stale, false);
  assert.equal(snapshot.avatar.mapping.channels.gazeX.changed, true);
  assert.equal(snapshot.avatar.mapping.channels.gazeY.changed, false);
  assert.deepEqual(snapshot.avatar.mapping.unverified, ['gazeY']);
  assert.equal(snapshot.live2d.capabilities.verified.includes('gazeX'), true);

  // The status view is published before `probeAvatarMapping` awaits the log flush, so the event row
  // may land a tick later. Wait for the event itself (not a fixed sleep); only then is "exactly one"
  // meaningful, and the later no-retry check still catches a second write.
  assert.equal(await waitFor(async () => (await host.probeEvents('startup')).length >= 1), true,
    'the startup probe event was recorded');
  const startup = await host.probeEvents('startup');
  assert.equal(startup.length, 1,
    `exactly one startup probe event (got ${startup.length}: ${JSON.stringify(startup.map((row) => row.payload))})`);
  assert.equal(startup[0].payload.source, 'startup');
  assert.equal(startup[0].payload.ok, true);
  assert.equal(await host.probeEvents('manual').then((rows) => rows.length), 0,
    'the startup attempt is not a manual click');

  // Once per connection: no timer/poll may start a second measurement.
  const reads = fake.count('Live2DParameterListRequest');
  await sleep(300);
  assert.equal(fake.count('Live2DParameterListRequest'), reads, 'no automatic retry after startup');
  assert.equal((await host.probeEvents('startup')).length, 1, 'still one startup event');

  console.log(`1) source=startup gazeX=${snapshot.avatar.mapping.channels.gazeX.changed}`
    + ` unverified=${snapshot.avatar.mapping.unverified.join(',')} events=${startup.length}`);
});

// ---------------------------------------------------------------------------------------------
// 2. explicit false opts out completely
// ---------------------------------------------------------------------------------------------
test('2. 显式 false：不 probe，也不产生额外参数读取', async (t) => {
  const fake = await createFakeVts();
  const host = await startHost(fake, {
    settings: { avatar: { verifyMappingsOnStartup: false, blinkOwner: 'vts' } },
  });
  t.after(async () => {
    host.dispose();
    await fake.close();
  });

  const connected = await connect(host);
  assert.equal(connected.ok, true, `connect succeeds (${connected.error ?? ''})`);
  assert.equal(await waitFor(async () => {
    const snapshot = await host.status();
    const controlled = snapshot.live2d?.runtime?.channels?.controlled ?? [];
    return snapshot.live2d?.ready === true && controlled.includes('gazeX') && controlled.includes('gazeY');
  }), true, 'discovery still mapped both gaze channels');

  await sleep(300);
  const snapshot = await host.status();
  assert.equal(snapshot.avatar.verifyMappingsOnStartup, false);
  assert.equal(snapshot.avatar.mapping.lastAt, null, 'no automatic probe record');
  assert.equal((await host.events()).some((entry) => entry.type === 'avatar.mapping.probe'), false,
    'no probe event');
  const reads = fake.count('Live2DParameterListRequest');
  await sleep(150);
  assert.equal(fake.count('Live2DParameterListRequest'), reads, 'status/discovery did not start a probe');
  console.log(`2) setting=false mapping.lastAt=${snapshot.avatar.mapping.lastAt} events=0`);
});

// ---------------------------------------------------------------------------------------------
// 3. one attempt per connection generation; a reconnect is allowed one new attempt
// ---------------------------------------------------------------------------------------------
test('3. 同一连接不重复；重连后按设置再一次', async (t) => {
  const fake = await createFakeVts();
  const host = await startHost(fake);
  t.after(async () => {
    host.dispose();
    await fake.close();
  });

  assert.equal((await connect(host)).ok, true);
  assert.equal(await waitFor(async () => (await host.probeEvents('startup')).length === 1), true,
    'first connection probes once');

  // A second connect while already ready is still the same connection generation.
  assert.equal((await connect(host)).ok, true);
  await sleep(300);
  assert.equal((await host.probeEvents('startup')).length, 1,
    'an already-connected connect call does not probe again');

  // Drop the socket, wait until the client is really disconnected, then reconnect.
  fake.disconnectClients();
  assert.equal(await waitFor(async () => {
    const snapshot = await host.status();
    return snapshot.live2d?.ready !== true && snapshot.live2d?.socketOpen !== true;
  }), true, 'the old socket is reported closed');
  assert.equal((await connect(host)).ok, true, 'reconnect succeeds');
  assert.equal(await waitFor(async () => (await host.probeEvents('startup')).length === 2), true,
    'the new connection generation gets its own single attempt');
  await sleep(300);
  assert.equal((await host.probeEvents('startup')).length, 2, 'still exactly one per connection');
  console.log(`3) startupEvents=${(await host.probeEvents('startup')).length}`);
});

// ---------------------------------------------------------------------------------------------
// 4. no gaze target / unconnected host: safe skip, never a throw or a retry
// ---------------------------------------------------------------------------------------------
test('4. 无 gaze 映射与未连接均安全跳过', async (t) => {
  const noGaze = await createFakeVts({ gaze: false });
  const host = await startHost(noGaze);
  t.after(async () => {
    host.dispose();
    await noGaze.close();
  });

  assert.equal((await connect(host)).ok, true);
  assert.equal(await waitFor(async () => {
    const snapshot = await host.status();
    return snapshot.live2d?.capabilities?.discovered === true;
  }), true, 'discovery completed without a gaze mapping');
  assert.equal(await waitFor(async () => (await host.events())
    .some((entry) => entry.type === 'avatar.mapping.probe.skipped'
      && entry.payload?.reason === 'no-probe-mapping')), true,
  'the skipped attempt is recorded once');
  await sleep(250);
  assert.equal((await host.events()).some((entry) => entry.type === 'avatar.mapping.probe'), false,
    'no measurement was started');
  assert.equal((await host.status()).avatar.mapping.lastAt, null);

  // A dead API port: connect fails, and startup verification never runs outside a connection.
  const dead = await createFakeVts();
  const deadPort = dead.port;
  await dead.close();
  const offlineHost = await startHost({ port: deadPort });
  t.after(() => offlineHost.dispose());
  const failed = await offlineHost.callRoute('/assistant/action', { body: { action: 'live2d.connect' } });
  assert.equal(failed.ok, false, 'connect to the closed port fails');
  await sleep(200);
  assert.equal((await offlineHost.events()).some((entry) => entry.type === 'avatar.mapping.probe'), false,
    'unconnected host wrote no probe result');
  console.log('4) noGazeSkip=1 unconnectedProbe=0');
});

// ---------------------------------------------------------------------------------------------
// 5. manual action remains one explicit measurement; the switch persists only its own key
// ---------------------------------------------------------------------------------------------
test('5. 手动按钮仍一次动作；设置开关保留其它 avatar 字段并拒绝非布尔值', async (t) => {
  const fake = await createFakeVts();
  const host = await startHost(fake, {
    settings: { avatar: { blinkOwner: 'vts', channelMap: { gazeX: 'EyeRightX' } } },
  });
  t.after(async () => {
    host.dispose();
    await fake.close();
  });

  assert.equal((await connect(host)).ok, true);
  assert.equal(await waitFor(async () => (await host.probeEvents('startup')).length === 1), true);

  const readsBefore = fake.count('Live2DParameterListRequest');
  const manual = await host.action({ action: 'avatar.mapping.probe' });
  assert.equal(manual.ok, true, `manual probe succeeds (${manual.error ?? ''})`);
  assert.equal(manual.source, 'manual');
  assert.equal(manual.channels.gazeX.changed, true);
  assert.equal(manual.channels.gazeY.changed, false);
  assert.equal(fake.count('Live2DParameterListRequest') - readsBefore, 4,
    'one manual click = two channels x before/after reads');
  await sleep(200);
  assert.equal(fake.count('Live2DParameterListRequest') - readsBefore, 4, 'manual click never retries');
  assert.equal((await host.probeEvents('manual')).length, 1);
  assert.equal((await host.probeEvents('startup')).length, 1, 'manual does not create a startup event');

  const turnedOff = await host.action({ action: 'avatar.verifyMappingsOnStartup.set', enabled: false });
  assert.equal(turnedOff.ok, true);
  assert.equal(turnedOff.verifyMappingsOnStartup, false);
  const savedOff = await host.readSettings();
  assert.equal(savedOff.avatar.verifyMappingsOnStartup, false);
  assert.equal(savedOff.avatar.blinkOwner, 'vts', 'other avatar fields survive the merge');
  assert.deepEqual(savedOff.avatar.channelMap, { gazeX: 'EyeRightX' }, 'channelMap survives the merge');
  assert.equal((await host.status()).avatar.verifyMappingsOnStartup, false);

  const invalid = await host.action({ action: 'avatar.verifyMappingsOnStartup.set', enabled: 'yes' });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.code, 'invalid-boolean');
  assert.equal((await host.readSettings()).avatar.verifyMappingsOnStartup, false,
    'a rejected value does not touch settings');

  const turnedOn = await host.action({ action: 'avatar.verifyMappingsOnStartup.set', enabled: true });
  assert.equal(turnedOn.ok, true);
  assert.equal((await host.readSettings()).avatar.verifyMappingsOnStartup, true);
  assert.equal((await host.status()).avatar.verifyMappingsOnStartup, true);
  console.log(`5) manualReads=4 manualEvents=1 startupEvents=1 switch=${turnedOn.verifyMappingsOnStartup}`);
});

// ---------------------------------------------------------------------------------------------
// 6. privacy: no startup measurement, and leaving privacy is not an automatic retry
// ---------------------------------------------------------------------------------------------
test('6. 隐私中取消自动验证；离开隐私不自动重试', async (t) => {
  const fake = await createFakeVts();
  const host = await startHost(fake);
  t.after(async () => {
    host.dispose();
    await fake.close();
  });

  const privacy = await host.action({ action: 'privacy.toggle' });
  assert.equal(privacy.ok, true, `privacy toggle succeeds (${privacy.error ?? ''})`);
  assert.equal(await waitFor(async () => (await host.status()).vision?.locked === true), true,
    'privacy is on before the VTS connection');

  assert.equal((await connect(host)).ok, true);
  assert.equal(await waitFor(async () => (await host.events())
    .some((entry) => entry.type === 'avatar.mapping.probe.skipped'
      && entry.payload?.source === 'startup' && entry.payload?.reason === 'privacy')), true,
  'the startup attempt is cancelled with source=startup/reason=privacy');
  await sleep(250);
  assert.equal((await host.probeEvents('startup')).length, 0, 'no probe ran in privacy');
  assert.equal((await host.status()).avatar.mapping.lastAt, null);

  // Leaving privacy alone must not unlock a deferred startup probe: the connection's attempt was
  // already consumed by the privacy cancellation.
  const left = await host.action({ action: 'privacy.toggle' });
  assert.equal(left.ok, true, `leaving privacy succeeds (${left.error ?? ''})`);
  assert.equal(await waitFor(async () => (await host.status()).vision?.locked !== true), true);
  assert.equal((await connect(host)).ok, true);
  await sleep(300);
  assert.equal((await host.probeEvents('startup')).length, 0, 'leaving privacy did not retry');
  console.log(`6) privacySkip=1 startupProbe=0`);
});

// ---------------------------------------------------------------------------------------------
// 7. runtime cancellation: an in-flight revoked measurement cannot verify anything
// ---------------------------------------------------------------------------------------------
test('7. 测量中被取消：结果按 cancelled 丢弃，不写 verified', async () => {
  const pending = deferred();
  const transport = {
    probeActive: false,
    connect: async () => {},
    disconnect: async () => {},
    write: () => ({ ok: true, acknowledged: true }),
    probeInputMapping: () => pending.promise,
  };
  const runtime = createAvatarRuntime({ transport, config: { autoTickMs: 0 } });
  try {
    assert.equal((await runtime.connect()).ok, true);
    const mapped = await runtime.setChannelMappings([{
      channel: 'gazeX',
      inputName: 'EyeRightX',
      inputSource: 'test',
      injectable: true,
      verified: false,
      modelParams: ['ParamEyeBallX'],
      min: -1,
      max: 1,
      defaultValue: 0,
    }]);
    assert.equal(mapped.ok, true);

    let cancelled = false;
    const probe = runtime.probeGazeMapping({ cancelled: () => cancelled });
    await sleep(10);
    cancelled = true; // privacy/connection/unload revokes the startup measurement
    pending.resolve({ ok: true, changed: true, delta: { ParamEyeBallX: 0.5 }, error: '' });
    const result = await probe;

    assert.equal(result.stale, true);
    assert.equal(result.discarded, 'cancelled');
    assert.deepEqual(result.channels, {}, 'revoked evidence exposes no applicable channel');
    assert.deepEqual(result.mappingUnverified, [], 'revoked evidence marks nothing unverified');
    assert.equal(runtime.snapshot().channels.controlled.includes('gazeX'), false,
      'the late changed:true result never verified the channel');
    assert.equal(transport.probeActive, false, 'the probe pause was released');
    console.log(`7) discarded=${result.discarded} controlled=${runtime.snapshot().channels.controlled.join(',')}`);
  } finally {
    runtime.dispose();
  }
});
