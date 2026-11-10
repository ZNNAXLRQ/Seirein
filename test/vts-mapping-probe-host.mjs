/**
 * Explicit gaze-mapping probe — runtime method, host action/status and the client entry.
 *
 * Run: node --test test/vts-mapping-probe-host.mjs
 *
 * Pinned:
 *   1. an unconnected runtime returns a safe `ok:false` result (never throws);
 *   2. `changed:true` marks gazeX verified, `changed:false` keeps gazeY mapped but unverified;
 *      every runtime-owned write is held while a probe measures and resumes afterwards;
 *   3. a never-settling probe becomes a bounded timeout, not a hung caller;
 *   4. the real host action records `avatar.mapping.probe`, `/assistant/status.avatar.mapping`
 *      has the documented shape, and neither discovery nor status runs a probe automatically;
 *   5. the client ships exactly one explicit button/action and no new polling.
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

const waitFor = async (check, timeoutMs = 5000, stepMs = 25) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await sleep(stepMs);
  }
  return false;
};

const GAZE_ROWS = [
  {
    channel: 'gazeX',
    inputName: 'EyeRightX',
    inputSource: 'default',
    injectable: true,
    verified: true,
    modelParams: ['ParamEyeBallX'],
    min: -1,
    max: 1,
    defaultValue: 0,
  },
  {
    channel: 'gazeY',
    inputName: 'EyeRightY',
    inputSource: 'default',
    injectable: true,
    verified: true,
    modelParams: ['ParamEyeBallY'],
    min: -1,
    max: 1,
    defaultValue: 0,
  },
];

// ---------------------------------------------------------------------------------------------
// 1. no connection → safe data, never a throw
// ---------------------------------------------------------------------------------------------
test('1. 未连接时 probeGazeMapping 安全失败', async () => {
  const runtime = createAvatarRuntime({ transport: { connect: async () => {} } });
  const result = await runtime.probeGazeMapping();
  assert.equal(result.ok, false);
  assert.deepEqual(result.channels, {});
  assert.deepEqual(result.mappingUnverified, []);
  assert.match(result.error, /未连接/u);
  assert.ok(Number.isFinite(Date.parse(result.at)), `at is an ISO timestamp: ${result.at}`);
  const disposed = runtime.dispose();
  assert.equal(disposed.ok, true);
  console.log(`1) ok=${result.ok} error=${result.error}`);
});

// ---------------------------------------------------------------------------------------------
// 2. one changed + one unchanged channel; writes pause during the measurement and resume after
// ---------------------------------------------------------------------------------------------
test('2. changed:true → verified；changed:false → unverified 但保留通道；帧写入暂停/恢复', async () => {
  const writes = [];
  const observedProbeActive = [];
  let pausedWrite = null;
  let writesDuringProbe = null;
  let runtime = null;

  const transport = {
    probeActive: false,
    connect: async () => {},
    disconnect: async () => {},
    write: (frame) => {
      writes.push({ ...frame });
      return { ok: true, acknowledged: true };
    },
    probeInputMapping: async ({ inputName }) => {
      observedProbeActive.push(transport.probeActive);
      if (inputName === 'EyeRightX') {
        // Called while the probe is still measuring: the facade must hold this write.
        pausedWrite = await runtime.writeMouth(0.4);
        writesDuringProbe = writes.length;
        return { ok: true, changed: true, delta: { ParamEyeBallX: 0.5 }, error: '' };
      }
      return { ok: true, changed: false, delta: { ParamEyeBallY: 0 }, error: '' };
    },
  };

  runtime = createAvatarRuntime({ transport });
  const connected = await runtime.connect();
  assert.equal(connected.ok, true);
  const mapped = await runtime.setChannelMappings(GAZE_ROWS);
  assert.equal(mapped.ok, true);
  // Install the mouth after channel mapping: applyChannelMappings() intentionally clears a mouth
  // input that has no verified binding, so setting it first would be undone.
  runtime.setMouthInput('MouthOpen');

  const before = writes.length;
  const result = await runtime.probeGazeMapping();

  assert.equal(result.ok, true, `both probes completed (${result.error})`);
  assert.equal(result.channels.gazeX.changed, true);
  assert.equal(result.channels.gazeX.inputName, 'EyeRightX');
  assert.deepEqual(result.channels.gazeX.parameterNames, ['ParamEyeBallX']);
  assert.equal(result.channels.gazeX.delta.ParamEyeBallX, 0.5);
  assert.equal(result.channels.gazeY.changed, false);
  assert.match(result.channels.gazeY.error, /^$/u);
  assert.deepEqual(result.mappingUnverified, ['gazeY']);
  assert.ok(Number.isFinite(Date.parse(result.at)));
  assert.deepEqual(Object.keys(result.channels.gazeX).sort(),
    ['changed', 'delta', 'error', 'inputName', 'parameterNames'],
    'the probe projection exposes no before/after or page body');
  assert.equal('before' in result.channels.gazeX, false);
  assert.equal(result.error, '');

  assert.deepEqual(observedProbeActive, [true, true], 'the transport probe flag was held for both');
  assert.equal(transport.probeActive, false, 'the flag is restored after the probe');
  assert.equal(pausedWrite?.ok, true, 'the held write still reports success to the mouth caller');
  assert.equal(writesDuringProbe, before, 'no transport frame was written while measuring');

  const snapshot = runtime.snapshot();
  assert.ok(snapshot.channels.controlled.includes('gazeX'), 'changed:true is controlled');
  assert.equal(snapshot.channels.controlled.includes('gazeY'), false, 'changed:false is not controlled');
  assert.ok(snapshot.channels.unverified.includes('gazeY'), 'the unchanged channel is unverified');
  assert.equal(snapshot.channels.unverified.includes('gazeX'), false);
  // The channel itself is preserved: its input and target parameters are still known.
  assert.equal(result.channels.gazeY.inputName, 'EyeRightY');
  assert.deepEqual(result.channels.gazeY.parameterNames, ['ParamEyeBallY']);

  // Resume: the same writer works immediately after the probe.
  const resumed = await runtime.writeMouth(0.4);
  assert.equal(resumed.ok, true);
  assert.ok(writes.length > before, 'frame writes resume after the probe');

  runtime.dispose();
  console.log(`2) changedX=${result.channels.gazeX.changed} changedY=${result.channels.gazeY.changed}`
    + ` pausedWrites=${writesDuringProbe - before} resumedWrites=${writes.length - before}`);
});

// ---------------------------------------------------------------------------------------------
// 3. a never-settling transport is bounded and safe
// ---------------------------------------------------------------------------------------------
test('3. 探测超时：返回 ok:false，不抛出，通道仍保留', async () => {
  const transport = {
    probeActive: false,
    connect: async () => {},
    disconnect: async () => {},
    write: () => ({ ok: true }),
    probeInputMapping: () => new Promise(() => {}),
  };
  const runtime = createAvatarRuntime({ transport, config: { gazeProbeTimeoutMs: 20 } });
  await runtime.connect();
  const mapped = await runtime.setChannelMappings(GAZE_ROWS);
  assert.equal(mapped.ok, true);

  const started = Date.now();
  const result = await runtime.probeGazeMapping();
  const elapsed = Date.now() - started;
  assert.equal(result.ok, false);
  assert.ok(elapsed < 1000, `timeout is bounded (${elapsed} ms)`);
  assert.match(result.error, /timed out/u);
  assert.deepEqual(result.mappingUnverified.sort(), ['gazeX', 'gazeY']);
  assert.equal(result.channels.gazeX.changed, false);
  assert.match(result.channels.gazeX.error, /timed out/u);
  assert.equal(result.channels.gazeX.inputName, 'EyeRightX');
  assert.equal(transport.probeActive, false, 'the transport flag is cleared after a timeout');
  assert.ok(runtime.snapshot().channels.unverified.includes('gazeX'));
  runtime.dispose();
  console.log(`3) ok=${result.ok} elapsed=${elapsed}ms unverified=${result.mappingUnverified.join(',')}`);
});

// ---------------------------------------------------------------------------------------------
// 4. real host wiring: one explicit action, event and status projection
// ---------------------------------------------------------------------------------------------
async function createFakeVts() {
  const state = {
    model: { modelName: 'ProbeModel', modelID: 'probe-model' },
    params: { ParamEyeBallX: 0, ParamEyeBallY: 0 },
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
            ],
            customParameters: [],
          });
          return;
        case 'Live2DParameterListRequest':
          respond(socket, request, {
            live2DModelParameters: [
              { name: 'ParamEyeBallX', min: -1, max: 1, defaultValue: 0 },
              { name: 'ParamEyeBallY', min: -1, max: 1, defaultValue: 0 },
            ],
          });
          return;
        case 'EventSubscriptionRequest': {
          const eventName = String(request.data?.eventName ?? 'ModelLoadedEvent');
          respond(socket, request, {
            subscribedEventCount: 1,
            subscribedEvents: [eventName],
          });
          return;
        }
        case 'GetParameterValues': {
          const names = Array.isArray(request.data?.parameterNames) ? request.data.parameterNames : [];
          respond(socket, request, {
            parameterValues: names.map((name) => ({ name, value: state.params[name] ?? 0 })),
          });
          return;
        }
        case 'InjectParameterDataRequest': {
          // Only EyeRightX moves a parameter: EyeRightY is the honest "injectable but unchanged"
          // case the probe must mark unverified instead of trusting the name.
          for (const entry of Array.isArray(request.data?.parameterValues) ? request.data.parameterValues : []) {
            if (entry?.id === 'EyeRightX') state.params.ParamEyeBallX = Number(entry.value);
          }
          respond(socket, request, {});
          return;
        }
        default:
          respond(socket, request, {});
      }
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    requests,
    state,
    async close() {
      for (const socket of wss.clients) socket.terminate();
      await new Promise((done) => wss.close(() => server.close(() => done())));
    },
  };
}

async function startHost(fake) {
  const root = await mkdtemp(join(tmpdir(), 'vts-mapping-probe-'));
  await mkdir(join(root, 'data'), { recursive: true });
  await writeFile(join(root, 'data', 'features.json'), JSON.stringify({ avatar: true }), 'utf8');
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

test('4. 宿主 action/status：显式触发一次、事件仅结果字段、默认不自动探测', async (t) => {
  const fake = await createFakeVts();
  const host = await startHost(fake);
  t.after(async () => {
    host.dispose();
    await fake.close();
  });

  const connected = await host.callRoute('/assistant/action', { body: { action: 'live2d.connect' } });
  assert.equal(connected.ok, true, `connect succeeds (${connected.error ?? ''})`);

  const ready = await waitFor(async () => {
    const snapshot = await host.status();
    const controlled = snapshot.live2d?.runtime?.channels?.controlled ?? [];
    return snapshot.live2d?.ready === true
      && controlled.includes('gazeX') && controlled.includes('gazeY');
  }, 5000, 50);
  assert.equal(ready, true, 'discovery handed both gaze channels to the runtime');

  // Discovery (the default path) is read-only: no probe readings before the explicit click.
  assert.equal(
    fake.requests.filter((entry) => entry.messageType === 'GetParameterValues').length,
    0,
    'capability discovery did not probe the mapping automatically',
  );
  const beforeStatus = await host.status();
  assert.deepEqual(beforeStatus.avatar.mapping, {
    lastAt: null,
    ok: null,
    channels: {},
    unverified: [],
  }, 'no probe record yet');

  const result = await host.callRoute('/assistant/action', { body: { action: 'avatar.mapping.probe' } });
  assert.equal(result.ok, true, `probe action completed (${result.error ?? ''})`);
  assert.equal(result.channels.gazeX.changed, true);
  assert.equal(result.channels.gazeY.changed, false);
  assert.deepEqual(result.unverified, ['gazeY']);
  assert.equal(typeof result.lastAt, 'string');
  assert.ok(Number.isFinite(Date.parse(result.lastAt)));

  const afterStatus = await host.status();
  assert.equal(afterStatus.avatar.mapping.lastAt, result.lastAt);
  assert.equal(afterStatus.avatar.mapping.ok, true);
  assert.equal(afterStatus.avatar.mapping.channels.gazeX.changed, true);
  assert.equal(afterStatus.avatar.mapping.channels.gazeY.changed, false);
  assert.deepEqual(afterStatus.avatar.mapping.unverified, ['gazeY']);
  // The discovery view follows the same evidence: changed:true verified, changed:false not.
  assert.ok(afterStatus.live2d.capabilities.verified.includes('gazeX'));
  assert.equal(afterStatus.live2d.capabilities.verified.includes('gazeY'), false);
  assert.ok(afterStatus.live2d.capabilities.mappingUnverified.includes('gazeY'));
  // No path/page body is exposed by the status record.
  assert.equal(JSON.stringify(afterStatus.avatar.mapping).includes(host.root), false);
  assert.equal(JSON.stringify(afterStatus.avatar.mapping).includes('\\'), false);

  const eventFound = await waitFor(async () => (await host.events())
    .some((event) => event.type === 'avatar.mapping.probe'), 2000, 25);
  assert.equal(eventFound, true, 'avatar.mapping.probe was recorded');
  const event = (await host.events()).find((entry) => entry.type === 'avatar.mapping.probe');
  assert.deepEqual(Object.keys(event.payload).sort(), ['at', 'channels', 'ok', 'unverified']);
  assert.equal(event.payload.ok, true);
  assert.equal(event.payload.channels.gazeX.changed, true);
  assert.equal(event.payload.channels.gazeY.changed, false);
  assert.deepEqual(event.payload.unverified, ['gazeY']);
  assert.equal(JSON.stringify(event.payload).includes(host.root), false);

  // Exactly one click = one measurement pass; status reads never re-probe.
  const reads = () => fake.requests.filter((entry) => entry.messageType === 'GetParameterValues').length;
  const afterActionReads = reads();
  assert.equal(afterActionReads, 4, 'two channels × before/after reads, no retry inside one click');
  await sleep(120);
  await host.status();
  assert.equal(reads(), afterActionReads, 'status/action did not retry or poll the probe');

  console.log(`4) lastAt=${result.lastAt} changed=${result.channels.gazeX.changed ? 'gazeX' : ''}`
    + `${result.channels.gazeY.changed ? ',gazeY' : ''} unverified=${result.unverified.join(',')}`
    + ` eventFields=${Object.keys(event.payload).sort().join(',')} reads=${afterActionReads}`);
});

// ---------------------------------------------------------------------------------------------
// 5. client static: one explicit button/action, result row, no new polling
// ---------------------------------------------------------------------------------------------
test('5. 客户端静态：一个显式按钮 + 结果行，无轮询', async () => {
  const { readFile } = await import('node:fs/promises');
  const { dirname, join: joinPath } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const here = dirname(fileURLToPath(import.meta.url));
  const clientSource = await readFile(joinPath(here, '..', 'client.js'), 'utf8');

  assert.equal((clientSource.match(/action: 'avatar\.mapping\.probe'/gu) ?? []).length, 1,
    '客户端只有一处显式触发');
  assert.ok(clientSource.includes("'验证视线映射'"), '按钮文案存在');
  assert.ok(clientSource.includes('data-avatar-mapping'), '结果行有稳定标记');
  assert.ok(clientSource.includes('已连通'), '结果行能显示已连通');
  assert.ok(clientSource.includes('未变化'), '结果行能显示未变化');
  assert.ok(clientSource.includes('失败：'), '结果行能显示失败原因');
  assert.ok(clientSource.includes('status.avatar?.mapping'), '结果行读取 status.avatar.mapping');
  assert.doesNotMatch(
    clientSource,
    /action: 'avatar\.mapping\.probe'[\s\S]{0,300}?setInterval/u,
    '验证按钮不新增轮询',
  );
  console.log('5) button=1 resultRow=1 poll=0');
});
