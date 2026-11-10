/**
 * Explicit VTS channelMap (settings.avatar.channelMap) — discovery precedence, validation,
 * persistence and the client card.
 *
 * Run: node --test test/vts-channel-map-host.mjs
 *
 * Pinned:
 *   1. a valid explicit input overrides the candidate names (`mappingSource:'explicit'`) but is
 *      still unverified until a runtime probe says `changed:true`;
 *   2. an unknown explicit input records `mappingInvalid`/`unknown-input`, is not enabled, and
 *      falls back to the ordinary candidate (or stays unmapped);
 *   3. `avatar.channelMap.set` validates against the VTS input list, persists only
 *      settings.avatar.channelMap (other avatar fields preserved), and clears on empty;
 *   4. an invalid name is rejected without touching the persisted settings;
 *   5. discovery without a channelMap keeps the old candidate + name-rule verification exactly;
 *   6. the client card ships two inputs + save/clear, reads status.avatar.channelMap and rolls the
 *      inputs back when the host rejects the write.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { WebSocketServer } from 'ws';

import {
  discoverCapabilities,
  resetCapabilities,
} from '../src/host/avatar/avatarMotion.js';
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

const INPUTS = [
  { name: 'EyeRightX', min: -1, max: 1, defaultValue: 0 },
  { name: 'EyeRightY', min: -1, max: 1, defaultValue: 0 },
  { name: 'MyGazeX', min: -1, max: 1, defaultValue: 0 },
  { name: 'MyGazeY', min: -1, max: 1, defaultValue: 0 },
];
const MODEL_PARAMS = [
  { name: 'ParamEyeBallX', min: -1, max: 1, defaultValue: 0 },
  { name: 'ParamEyeBallY', min: -1, max: 1, defaultValue: 0 },
];

/** Direct discovery harness: same input list, different explicit maps. */
const discoverGaze = async (channelMap) => discoverCapabilities({
  identity: { modelId: `channel-map-${JSON.stringify(channelMap)}`, modelGeneration: 1, connectionGeneration: 1 },
  force: true,
  listInputParameters: async () => ({ defaultParameters: INPUTS, customParameters: [] }),
  listModelParameters: async () => ({ ok: true, source: 'test', parameters: MODEL_PARAMS }),
  channelMap,
});

// ---------------------------------------------------------------------------------------------
// 1. explicit wins over candidates, but stays unverified until a probe
// ---------------------------------------------------------------------------------------------
test('1. 显式映射覆盖候选名，且 probe 前仍 unverified', async () => {
  resetCapabilities();
  const withoutMap = await discoverGaze({});
  const gazeXDefault = withoutMap.channels.find((entry) => entry.channel === 'gazeX');
  assert.equal(gazeXDefault.inputName, 'EyeRightX', 'the candidate rule still selects EyeRightX');
  assert.equal(gazeXDefault.verified, true, 'the default rule is unchanged');

  const mapped = await discoverGaze({ gazeX: '  MyGazeX  ', gazeY: 'MyGazeY' });
  const gazeX = mapped.channels.find((entry) => entry.channel === 'gazeX');
  const gazeY = mapped.channels.find((entry) => entry.channel === 'gazeY');
  assert.equal(gazeX.inputName, 'MyGazeX', 'the explicit name is trimmed and used');
  assert.equal(gazeX.inputSource, 'declared');
  assert.equal(gazeX.mappingSource, 'explicit');
  assert.equal(gazeX.injectable, true);
  assert.equal(gazeX.verified, false, 'an explicit name is not proof by itself');
  assert.equal(gazeX.mappingUnverified, true);
  assert.equal(gazeY.inputName, 'MyGazeY');
  assert.equal(gazeY.verified, false);
  assert.deepEqual(mapped.mappingSources, { gazeX: 'explicit', gazeY: 'explicit' });
  assert.deepEqual(mapped.mappingInvalid, []);
  assert.ok(mapped.mapped.includes('gazeX') && mapped.mapped.includes('gazeY'));
  assert.equal(mapped.verified.includes('gazeX'), false);
  assert.ok(mapped.mappingUnverified.includes('gazeX'));

  // Declaring the same spelling as the default candidate is still an explicit mapping: it must
  // not inherit the candidate's name-rule verification.
  const sameName = await discoverGaze({ gazeX: 'EyeRightX' });
  const sameRow = sameName.channels.find((entry) => entry.channel === 'gazeX');
  assert.equal(sameRow.inputName, 'EyeRightX');
  assert.equal(sameRow.mappingSource, 'explicit');
  assert.equal(sameRow.verified, false, 'explicit is not the candidate rule even with the same name');
  assert.ok(sameName.mappingUnverified.includes('gazeX'));
  console.log(`1) explicit=${gazeX.inputName} verified=${gazeX.verified} source=${gazeX.mappingSource}`);
});

// ---------------------------------------------------------------------------------------------
// 2. unknown input: rejected as evidence, fallback candidate stays unverified
// ---------------------------------------------------------------------------------------------
test('2. 未知 input 记录 mappingInvalid/unknown-input 并回退候选', async () => {
  resetCapabilities();
  const malformed = await discoverGaze({ gazeX: 'NoSuchInput' });
  const gazeX = malformed.channels.find((entry) => entry.channel === 'gazeX');
  assert.equal(gazeX.inputName, 'EyeRightX', 'the ordinary candidate is used as a fallback');
  assert.equal(gazeX.injectable, true);
  assert.equal(gazeX.verified, false, 'the invalid explicit name never verifies the fallback');
  assert.equal(gazeX.mappingInvalid, true);
  assert.equal(gazeX.mappingInvalidReason, 'unknown-input');
  assert.equal(gazeX.mappingSource, '');
  assert.deepEqual(malformed.mappingInvalid, ['gazeX']);
  assert.equal(malformed.mappingSources.gazeX, undefined);
  assert.ok(malformed.mappingUnverified.includes('gazeX'), 'the fallback still needs a probe');

  // No candidate at all: the channel is not enabled, but the bad declaration is still recorded.
  const noCandidate = await discoverCapabilities({
    identity: { modelId: 'channel-map-no-candidate', modelGeneration: 1, connectionGeneration: 1 },
    force: true,
    listInputParameters: async () => ({
      defaultParameters: [INPUTS[2]],
      customParameters: [],
    }),
    listModelParameters: async () => ({ ok: true, source: 'test', parameters: MODEL_PARAMS }),
    channelMap: { gazeX: 'NoSuchInput' },
  });
  const unmapped = noCandidate.channels.find((entry) => entry.channel === 'gazeX');
  assert.equal(unmapped.injectable, false);
  assert.equal(unmapped.mappingInvalid, true);
  assert.equal(unmapped.mappingSource, '');
  assert.ok(noCandidate.unmapped.includes('gazeX'));
  assert.deepEqual(noCandidate.mappingInvalid, ['gazeX']);
  console.log(`2) fallback=${gazeX.inputName} invalid=${malformed.mappingInvalid.join(',')}`
    + ` noCandidate=${unmapped.injectable ? 'enabled' : 'unmapped'}`);
});

// ---------------------------------------------------------------------------------------------
// 3. probe is the only path from explicit to verified
// ---------------------------------------------------------------------------------------------
test('3. 显式映射仍需 probe 才 verified', async () => {
  resetCapabilities();
  const before = await discoverGaze({ gazeX: 'MyGazeX' });
  assert.equal(before.verified.includes('gazeX'), false, 'no probe → not verified');
  assert.ok(before.mappingUnverified.includes('gazeX'));

  let probes = 0;
  const after = await discoverCapabilities({
    identity: { modelId: 'channel-map-probe', modelGeneration: 1, connectionGeneration: 1 },
    force: true,
    listInputParameters: async () => ({ defaultParameters: INPUTS, customParameters: [] }),
    listModelParameters: async () => ({ ok: true, source: 'test', parameters: MODEL_PARAMS }),
    channelMap: { gazeX: 'MyGazeX' },
    probeMappings: true,
    probeInputMapping: async ({ inputName }) => {
      probes += 1;
      return inputName === 'MyGazeX'
        ? { ok: true, changed: true, delta: { ParamEyeBallX: 0.5 }, error: '' }
        : { ok: true, changed: false, delta: {}, error: '' };
    },
  });
  const gazeX = after.channels.find((entry) => entry.channel === 'gazeX');
  assert.equal(probes, 2, 'both discoverable gaze channels are probed');
  const gazeY = after.channels.find((entry) => entry.channel === 'gazeY');
  assert.equal(gazeY.verified, false, 'an unchanged gazeY probe stays unverified');
  assert.ok(after.mappingUnverified.includes('gazeY'));
  assert.equal(gazeX.inputName, 'MyGazeX');
  assert.equal(gazeX.mappingSource, 'explicit');
  assert.equal(gazeX.verified, true, 'changed:true is what promotes it');
  assert.equal(gazeX.mappingUnverified, false);
  assert.ok(after.verified.includes('gazeX'));
  assert.equal(after.mappingUnverified.includes('gazeX'), false);
  console.log(`3) probes=${probes} verified=${gazeX.verified} source=${gazeX.mappingSource}`);
});

// ---------------------------------------------------------------------------------------------
// 4. no channelMap → the historical candidate/name-rule behavior
// ---------------------------------------------------------------------------------------------
test('4. 未配置时行为不变', async () => {
  resetCapabilities();
  const plain = await discoverCapabilities({
    identity: { modelId: 'channel-map-none', modelGeneration: 1, connectionGeneration: 1 },
    force: true,
    listInputParameters: async () => ({ defaultParameters: INPUTS, customParameters: [] }),
    listModelParameters: async () => ({ ok: true, source: 'test', parameters: MODEL_PARAMS }),
  });
  for (const channel of ['gazeX', 'gazeY']) {
    const row = plain.channels.find((entry) => entry.channel === channel);
    assert.equal(row.inputName, channel === 'gazeX' ? 'EyeRightX' : 'EyeRightY');
    assert.equal(row.verified, true, `${channel} still verifies by the unchanged name rule`);
    assert.equal(row.mappingSource, '');
    assert.equal(row.mappingInvalid, false);
  }
  assert.deepEqual(plain.mappingInvalid, []);
  assert.deepEqual(plain.mappingSources, {});
  assert.ok(plain.verified.includes('gazeX') && plain.verified.includes('gazeY'));
  console.log(`4) verified=${plain.verified.filter((channel) => channel.startsWith('gaze')).join(',')}`);
});

// ---------------------------------------------------------------------------------------------
// 5. real host action: validation, persistence, preservation, clear, safe status
// ---------------------------------------------------------------------------------------------
async function createFakeVts() {
  const state = { params: { ParamEyeBallX: 0, ParamEyeBallY: 0 } };
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
  // VTS answers an unsupported message with APIError, not with a fake success response.
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
          respond(socket, request, { modelLoaded: true, modelName: 'ChannelMapModel', modelID: 'channel-map' });
          return;
        case 'HotkeysInCurrentModelRequest':
          respond(socket, request, { availableHotkeys: [] });
          return;
        case 'ExpressionStateRequest':
          respond(socket, request, { expressions: [] });
          return;
        case 'InputParameterListRequest':
          respond(socket, request, { defaultParameters: INPUTS, customParameters: [] });
          return;
        case 'Live2DParameterListRequest':
          respond(socket, request, {
            live2DModelParameters: [
              {
                name: 'ParamEyeBallX',
                value: state.params.ParamEyeBallX,
                min: -1,
                max: 1,
                defaultValue: 0,
              },
              {
                name: 'ParamEyeBallY',
                value: state.params.ParamEyeBallY,
                min: -1,
                max: 1,
                defaultValue: 0,
              },
            ],
          });
          return;
        case 'EventSubscriptionRequest':
          respond(socket, request, {
            subscribedEventCount: 1,
            subscribedEvents: [String(request.data?.eventName ?? 'ModelLoadedEvent')],
          });
          return;
        case 'InjectParameterDataRequest':
          for (const entry of Array.isArray(request.data?.parameterValues) ? request.data.parameterValues : []) {
            if (entry?.id === 'MyGazeX') state.params.ParamEyeBallX = Number(entry.value);
          }
          respond(socket, request, {});
          return;
        default:
          respondApiError(socket, request, `Unknown message type: ${request.messageType}`);
      }
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    requests,
    async close() {
      for (const socket of wss.clients) socket.terminate();
      await new Promise((done) => wss.close(() => server.close(() => done())));
    },
  };
}

async function startHost(fake) {
  const root = await mkdtemp(join(tmpdir(), 'vts-channel-map-'));
  await mkdir(join(root, 'data'), { recursive: true });
  await writeFile(join(root, 'data', 'features.json'), JSON.stringify({ avatar: true }), 'utf8');
  await writeFile(join(root, 'data', 'settings.json'), JSON.stringify({
    avatar: { someOtherAvatarSetting: 'keep-me' },
    other: { untouched: true },
  }), 'utf8');
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
  const settings = async () => JSON.parse(await readFile(join(root, 'data', 'settings.json'), 'utf8'));
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
  return { root, callRoute, status, settings, dispose };
}

test('5. 宿主 action：校验、持久化、保留其它字段、清除、status 安全视图', async (t) => {
  const fake = await createFakeVts();
  const host = await startHost(fake);
  t.after(async () => {
    host.dispose();
    await fake.close();
  });

  assert.equal((await host.callRoute('/assistant/action', { body: { action: 'live2d.connect' } })).ok, true);
  const ready = await waitFor(async () => (await host.status()).live2d?.ready === true);
  assert.equal(ready, true, 'the fake VTS connected');

  // Unknown name is rejected and nothing is written.
  const before = await host.settings();
  const rejected = await host.callRoute('/assistant/action', {
    body: { action: 'avatar.channelMap.set', gazeX: 'NoSuchInput' },
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'unknown-input');
  assert.match(rejected.error, /NoSuchInput/u);
  assert.deepEqual(await host.settings(), before, 'a rejected write leaves settings untouched');

  // Save: the canonical spelling is returned and only the two input names are persisted.
  const saved = await host.callRoute('/assistant/action', {
    body: { action: 'avatar.channelMap.set', gazeX: '  mygazex  ', gazeY: '' },
  });
  assert.equal(saved.ok, true, `save succeeds (${saved.error ?? ''})`);
  assert.deepEqual(saved.channelMap, { gazeX: 'MyGazeX', gazeY: '' });
  assert.deepEqual(saved.effective, { gazeX: 'MyGazeX', gazeY: '' });
  const stored = await host.settings();
  assert.equal(stored.avatar.someOtherAvatarSetting, 'keep-me', 'other avatar fields are preserved');
  assert.deepEqual(stored.avatar.channelMap, { gazeX: 'MyGazeX' });
  assert.deepEqual(stored.other, { untouched: true }, 'unrelated settings are preserved');

  const afterSave = await host.status();
  assert.deepEqual(afterSave.avatar.channelMap, { gazeX: 'MyGazeX', gazeY: '' });
  assert.equal(JSON.stringify(afterSave.avatar.channelMap).includes(host.root), false, 'no path in status');
  const gazeX = afterSave.live2d.capabilities.channels.find((entry) => entry.channel === 'gazeX');
  assert.equal(gazeX.inputName, 'MyGazeX', 'status reflects the effective explicit input');
  assert.equal(gazeX.mappingSource, 'explicit');
  assert.equal(gazeX.verified, false, 'saving is not proof');
  assert.ok(afterSave.live2d.capabilities.mappingUnverified.includes('gazeX'));
  assert.deepEqual(afterSave.live2d.capabilities.mappingInvalid, []);
  assert.deepEqual(afterSave.live2d.capabilities.mappingSources, { gazeX: 'explicit' });

  // Clear: both fields removed, the presence of {} still overrides any legacy config fallback.
  const cleared = await host.callRoute('/assistant/action', {
    body: { action: 'avatar.channelMap.set', clear: true },
  });
  assert.equal(cleared.ok, true, `clear succeeds (${cleared.error ?? ''})`);
  assert.deepEqual(cleared.channelMap, { gazeX: '', gazeY: '' });
  assert.deepEqual((await host.settings()).avatar.channelMap, {});
  assert.deepEqual((await host.status()).avatar.channelMap, { gazeX: '', gazeY: '' });
  const fallback = await host.status();
  const fallbackX = fallback.live2d.capabilities.channels.find((entry) => entry.channel === 'gazeX');
  assert.equal(fallbackX.inputName, 'EyeRightX', 'clearing restores the ordinary candidate');
  assert.equal(fallbackX.mappingSource, '');
  assert.equal(fallbackX.verified, true, 'the unchanged default name rule verifies again');

  // A stale cached row with the same inputName must still be refreshed to `mappingSource:explicit`
  // (the old cache cannot be mistaken for the new declaration just because the name matches).
  const sameName = await host.callRoute('/assistant/action', {
    body: { action: 'avatar.channelMap.set', gazeX: 'EyeRightX' },
  });
  assert.equal(sameName.ok, true, `same-name save succeeds (${sameName.error ?? ''})`);
  const sameStatus = await host.status();
  const sameRow = sameStatus.live2d.capabilities.channels.find((entry) => entry.channel === 'gazeX');
  assert.equal(sameRow.inputName, 'EyeRightX');
  assert.equal(sameRow.mappingSource, 'explicit', 'the cached candidate row was re-discovered');
  assert.equal(sameRow.verified, false, 'saving the same spelling does not reuse name-rule proof');
  console.log(`5) saved=${saved.channelMap.gazeX} rejected=${rejected.code} cleared=${JSON.stringify(cleared.channelMap)}`);
});

// ---------------------------------------------------------------------------------------------
// 6. client static: two inputs, save/clear, status echo, rollback
// ---------------------------------------------------------------------------------------------
test('6. 客户端静态：两个输入框 + 保存/清除 + 状态回显 + 失败回滚', async () => {
  const here = new URL('.', import.meta.url);
  const clientSource = await readFile(new URL('../client.js', here), 'utf8');

  assert.equal((clientSource.match(/action: 'avatar\.channelMap\.set'/gu) ?? []).length, 2,
    'save and clear both use the one action');
  assert.ok(clientSource.includes("'data-avatar-channel-map': channel"), 'both inputs carry a stable marker');
  assert.ok(clientSource.includes("channelRow('gazeX', '视线 X 输入名')"));
  assert.ok(clientSource.includes("channelRow('gazeY', '视线 Y 输入名')"));
  assert.ok(clientSource.includes("'保存视线映射'") && clientSource.includes("'清除视线映射'"));
  assert.ok(clientSource.includes('status.avatar?.channelMap'), 'the card echoes the persisted map');
  assert.ok(clientSource.includes('仍需验证'), 'the card says a saved map still needs a probe');
  assert.ok(clientSource.includes("'data-avatar-channel-map-status': statusState"));
  assert.ok(clientSource.includes('失败回滚'), 'the failure branch documents its rollback');
  assert.ok(/else \{\s*\/\/ 失败回滚[\s\S]{0,200}?rollback\(\);/u.test(clientSource),
    'an explicit rollback happens when the host rejects the write');
  assert.doesNotMatch(
    clientSource,
    /action: 'avatar\.channelMap\.set'[\s\S]{0,400}?setInterval/u,
    'saving a map does not add polling',
  );
  console.log('6) inputs=2 actions=2 rollback=1');
});
