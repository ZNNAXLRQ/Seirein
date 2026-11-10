/**
 * Explicit blink-channel ownership (`settings.avatar.blinkOwner`).
 *
 * Scope:
 *   1. the default is VTS: `idleEye:false`, `blink.owner:'vts'`, no blink row sent;
 *   2. `plugin` + BOTH eye inputs verified opens the writer: `idleEye:true` and `blink.sent` grows;
 *   3. `plugin` without verified eyes is refused (`eye-unverified`) and never changes the setting;
 *   4. the setting persists in `settings.avatar` (other fields preserved) and switches back to VTS;
 *   5. status + client expose the two choices, disable plugin while unverified, and roll back;
 *   6. the existing motion suites stay green (run separately; see the task verification list).
 *
 * No real VTS is contacted: a fake transport drives the runtime tests and a local fake VTS
 * WebSocket server drives the host action tests. Real VTS blinking remains UNVERIFIED.
 *
 * Run: node --test test/avatar-blink-owner.mjs
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { WebSocketServer } from 'ws';

import { apply } from '../src/host/index.js';
import { createAvatarRuntime } from '../src/host/avatar/avatarRuntime.js';
import { resetCapabilities } from '../src/host/avatar/avatarMotion.js';

const DT = 1000 / 30;
const flush = () => new Promise((resolve) => setImmediate(resolve));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (check, timeoutMs = 5000, stepMs = 25) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await delay(stepMs);
  }
  return false;
};

// ---------------------------------------------------------------------------------------------
// deterministic runtime rig (same fake transport shape as motion-pose-target.mjs)
// ---------------------------------------------------------------------------------------------
const ROWS = [
  { channel: 'headX', inputName: 'P_headX', min: -30, max: 30, injectable: true, verified: true },
  { channel: 'headY', inputName: 'P_headY', min: -30, max: 30, injectable: true, verified: true },
  { channel: 'headZ', inputName: 'P_headZ', min: -90, max: 90, injectable: true, verified: true },
  { channel: 'eyeOpenL', inputName: 'P_eyeL', min: 0, max: 1, injectable: true, verified: true },
  { channel: 'eyeOpenR', inputName: 'P_eyeR', min: 0, max: 1, injectable: true, verified: true },
  { channel: 'breath', inputName: 'P_breath', min: 0, max: 1, injectable: true, verified: true },
];

function createFakeTransport({ withEyes = true } = {}) {
  const frames = [];
  return {
    frames,
    transport: {
      connect: async () => {},
      disconnect: async () => {},
      write: async () => ({ ok: true }),
      writeMotion: async (payload) => {
        frames.push((payload.entries ?? []).map((entry) => ({ ...entry })));
        return { ok: true };
      },
      writeFrame: async (entries) => {
        frames.push((entries ?? []).map((entry) => ({ ...entry })));
        return { ok: true };
      },
    },
  };
}

const runtimeConfig = (extra = {}) => ({
  autoTickMs: 0,
  flushIntervalMs: 1,
  idleActions: [],
  idleWriteHz: 10,
  motionWrites: false,
  componentGazeEnabled: false,
  seed: 5,
  postureHoldMinMs: 60_000,
  postureHoldMaxMs: 60_000,
  postureHoldChance: 1,
  postureStillChance: 0,
  postureComponentMinMs: 10_000,
  postureComponentMaxMs: 10_000,
  ...extra,
});

async function makeRig({ withEyes = true, config = {} } = {}) {
  const fake = createFakeTransport({ withEyes });
  let clock = 0;
  const runtime = createAvatarRuntime({
    transport: fake.transport,
    now: () => clock,
    config: runtimeConfig(config),
  });
  const connected = await runtime.connect();
  assert.equal(connected.ok, true, `runtime connects (${connected.message ?? ''})`);
  const rows = withEyes ? ROWS : ROWS.filter((row) => !row.channel.startsWith('eyeOpen'));
  const mapped = await runtime.setChannelMappings(rows, { channelMap: {} });
  assert.equal(mapped.ok, true, 'channel mappings apply');
  return {
    runtime,
    fake,
    async run(toMs) {
      for (let at = 0; at <= toMs; at += DT) {
        clock = at;
        runtime.tick(at);
        // Let the coalesced frame flush between ticks: one long synchronous loop would only
        // flush the final frame and could never observe a committed eye row.
        await flush();
      }
      await flush();
      await flush();
    },
  };
}

// ---------------------------------------------------------------------------------------------
// 1. default VTS owner: no eye writes, idleEye off
// ---------------------------------------------------------------------------------------------
test('1. 缺省 vts：idleEye=false、blink.owner=vts、blinkSent 不增长', async (t) => {
  const rig = await makeRig({ withEyes: true });
  t.after(() => rig.runtime.dispose());
  await rig.run(14_000);
  const snap = rig.runtime.snapshot();
  assert.ok(snap.blink.generated > 0, `the blink machine still generates cycles (${snap.blink.generated})`);
  assert.equal(snap.blink.owner, 'vts', 'the safe default owner is VTS');
  assert.equal(snap.blink.eyeWriteOptIn, false);
  assert.equal(snap.blink.eyeWriteOptInReason, 'idleEye-off', 'the opt-out reason is explicit');
  assert.equal(snap.idleParams.eye, false, 'idleEye agrees with the VTS owner');
  assert.equal(snap.blink.sent, 0, 'no eye-open row was committed');
  const eyeRows = rig.fake.frames.flat().filter((entry) => entry.channel === 'eyeOpenL'
    || entry.channel === 'eyeOpenR');
  assert.equal(eyeRows.length, 0, 'the transport never received an eye-open row');
  assert.equal(snap.motion.channelOwnership.channels.blink.owner, 'vts');
  assert.equal(snap.motionLayers.blink.owner, 'vts');
  console.log(`[blink 1] owner=${snap.blink.owner} idleEye=${snap.idleParams.eye}`
    + ` generated=${snap.blink.generated} sent=${snap.blink.sent}`);
});

// ---------------------------------------------------------------------------------------------
// 2. plugin + verified eyes: effective opt-in and real committed blink rows
// ---------------------------------------------------------------------------------------------
test('2. plugin + 已验证：idleEye=true、blink.owner=plugin、blinkSent 实际增长', async (t) => {
  const rig = await makeRig({ withEyes: true });
  t.after(() => rig.runtime.dispose());
  const applied = rig.runtime.setBlinkOwner('plugin');
  assert.equal(applied.ok, true, `plugin ownership applies (${applied.message ?? ''})`);
  assert.equal(applied.owner, 'plugin');
  assert.equal(applied.idleEye, true);
  await rig.run(14_000);
  const snap = rig.runtime.snapshot();
  assert.equal(snap.blink.owner, 'plugin');
  assert.equal(snap.blink.eyeWriteOptIn, true);
  assert.equal(snap.blink.eyeWriteOptInReason, 'idleEye-on');
  assert.equal(snap.idleParams.eye, true, 'idleEye agrees with the plugin owner');
  assert.ok(snap.blink.generated > 0, `cycles generated (${snap.blink.generated})`);
  assert.ok(snap.blink.sent > 0, `a generated blink became a committed eye row (${snap.blink.sent})`);
  assert.ok(snap.blink.sent <= snap.blink.generated);
  const eyeRows = rig.fake.frames.flat().filter((entry) => entry.channel === 'eyeOpenL'
    || entry.channel === 'eyeOpenR');
  assert.ok(eyeRows.length > 0, 'the transport really received eye-open rows');
  console.log(`[blink 2] owner=${snap.blink.owner} idleEye=${snap.idleParams.eye}`
    + ` generated=${snap.blink.generated} sent=${snap.blink.sent} eyeRows=${eyeRows.length}`);
});

// ---------------------------------------------------------------------------------------------
// 3. plugin without verified eyes: runtime + action refuse, setting stays VTS
// ---------------------------------------------------------------------------------------------
test('3. plugin + 未验证：runtime 与 action 都拒绝 eye-unverified，保持 vts', async (t) => {
  const rig = await makeRig({ withEyes: false });
  t.after(() => rig.runtime.dispose());
  const refused = rig.runtime.setBlinkOwner('plugin');
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'eye-unverified');
  assert.equal(refused.owner, 'vts');
  assert.equal(refused.idleEye, false);
  const snap = rig.runtime.snapshot();
  assert.equal(snap.blink.owner, 'vts', 'a refused switch never changes the effective owner');
  assert.equal(snap.idleParams.eye, false);
  assert.equal(snap.blink.requestedOwner, 'vts', 'the refused request is not recorded');

  const fake = await createFakeVts({ targets: [] });
  const host = await startHost(fake);
  t.after(async () => {
    host.dispose();
    await fake.close();
  });
  resetCapabilities();
  const connected = await host.callRoute('/assistant/action', { body: { action: 'live2d.connect' } });
  assert.equal(connected.ok, true, `host connects (${connected.error ?? ''})`);
  const discovered = await waitFor(async () => {
    const status = await host.status();
    return status.live2d?.capabilities?.discovered === true;
  });
  assert.equal(discovered, true, 'capability discovery settles');
  const before = await host.status();
  assert.equal(before.avatar?.blink?.eyeVerified, false, 'no eye input is verified on this model');
  const action = await host.callRoute('/assistant/action', {
    body: { action: 'avatar.blinkOwner.set', owner: 'plugin' },
  });
  assert.equal(action.ok, false);
  assert.equal(action.code, 'eye-unverified');
  assert.equal(action.blink?.setting, 'vts');
  const after = await host.status();
  assert.equal(after.avatar?.blink?.setting, 'vts', 'the refused action did not persist plugin');
  assert.equal(after.avatar?.blink?.owner, 'vts');
  const settings = await readJson(join(host.root, 'data', 'settings.json'));
  assert.notEqual(settings?.avatar?.blinkOwner, 'plugin', 'the rejected value is absent from disk');
  console.log(`[blink 3] runtime=${refused.code} action=${action.code} setting=${after.avatar.blink.setting}`);
});

// ---------------------------------------------------------------------------------------------
// 4. persistence + switch: plugin persists, other avatar fields survive, VTS revokes
// ---------------------------------------------------------------------------------------------
test('4. 设置持久化/切换：plugin 落盘保留其它字段，切回 vts 后状态与 idleEye 同步', async (t) => {
  const fake = await createFakeVts({
    parameters: [
      { name: 'EyeOpenLeft', min: 0, max: 1, defaultValue: 1 },
      { name: 'EyeOpenRight', min: 0, max: 1, defaultValue: 1 },
      { name: 'FaceAngleX', min: -30, max: 30, defaultValue: 0 },
    ],
    targets: ['ParamEyeLOpen', 'ParamEyeROpen', 'ParamAngleX'],
  });
  const host = await startHost(fake, {
    settings: { avatar: { customField: 'keep-me', blinkOwner: 'vts' } },
  });
  t.after(async () => {
    host.dispose();
    await fake.close();
  });
  resetCapabilities();
  const connected = await host.callRoute('/assistant/action', { body: { action: 'live2d.connect' } });
  assert.equal(connected.ok, true, `host connects (${connected.error ?? ''})`);
  const verified = await waitFor(async () => {
    const status = await host.status();
    const controlled = status.live2d?.runtime?.channels?.controlled ?? [];
    return status.avatar?.blink?.eyeVerified === true
      && controlled.includes('eyeOpenL') && controlled.includes('eyeOpenR');
  });
  assert.equal(verified, true, 'both eye inputs become verified and controlled');

  const plugin = await host.callRoute('/assistant/action', {
    body: { action: 'avatar.blinkOwner.set', owner: 'plugin' },
  });
  assert.equal(plugin.ok, true, `plugin is accepted (${plugin.error ?? ''})`);
  assert.equal(plugin.setting, 'plugin');
  assert.equal(plugin.blink?.owner, 'plugin');
  assert.equal(plugin.blink?.idleEye, true);
  const pluginStatus = await host.status();
  assert.equal(pluginStatus.avatar?.blink?.setting, 'plugin');
  assert.equal(pluginStatus.avatar?.blink?.owner, 'plugin');
  assert.equal(pluginStatus.live2d?.runtime?.blink?.owner, 'plugin');
  assert.equal(pluginStatus.live2d?.runtime?.idleEye, true);
  let settings = await readJson(join(host.root, 'data', 'settings.json'));
  assert.equal(settings?.avatar?.blinkOwner, 'plugin', 'the setting is persisted');
  assert.equal(settings?.avatar?.customField, 'keep-me', 'other settings.avatar fields survive');

  const vts = await host.callRoute('/assistant/action', {
    body: { action: 'avatar.blinkOwner.set', owner: 'vts' },
  });
  assert.equal(vts.ok, true, `vts switch is accepted (${vts.error ?? ''})`);
  assert.equal(vts.setting, 'vts');
  const vtsStatus = await host.status();
  assert.equal(vtsStatus.avatar?.blink?.setting, 'vts');
  assert.equal(vtsStatus.avatar?.blink?.owner, 'vts');
  assert.equal(vtsStatus.live2d?.runtime?.blink?.owner, 'vts');
  assert.equal(vtsStatus.live2d?.runtime?.idleEye, false, 'idleEye agrees with the VTS owner');
  settings = await readJson(join(host.root, 'data', 'settings.json'));
  assert.equal(settings?.avatar?.blinkOwner, 'vts');
  assert.equal(settings?.avatar?.customField, 'keep-me');

  const invalid = await host.callRoute('/assistant/action', {
    body: { action: 'avatar.blinkOwner.set', owner: 'auto' },
  });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.code, 'invalid-blink-owner', 'only the two documented values are accepted');
  console.log(`[blink 4] plugin->${plugin.blink.owner} vts->${vtsStatus.avatar.blink.owner}`
    + ` persisted=${settings.avatar.blinkOwner} invalid=${invalid.code}`);
});

// ---------------------------------------------------------------------------------------------
// 5. status + client contract (static: the shipped client parses the status projection)
// ---------------------------------------------------------------------------------------------
test('5. status/客户端静态：两个选项、status 当前值、未验证禁用、失败回滚', async () => {
  const here = fileURLToPath(new URL('.', import.meta.url));
  const clientSource = await readFile(join(here, '..', 'client.js'), 'utf8');
  const hostSource = await readFile(join(here, '..', 'src', 'host', 'index.js'), 'utf8');
  for (const needle of [
    "action: 'avatar.blinkOwner.set'",
    "'眨眼由插件控制'",
    "'由 VTS 控制'",
    "'data-avatar-blink-owner'",
    "'data-avatar-blink-owner-status'",
    'status.avatar?.blink',
    'blink.eyeVerified',
    '已保持 VTS 控制',
  ]) {
    assert.ok(clientSource.includes(needle), `client ships ${needle}`);
  }
  assert.equal((clientSource.match(/action: 'avatar\.blinkOwner\.set'/gu) ?? []).length, 1,
    'one explicit action, no polling/timer');
  assert.match(clientSource, /const setOwner[\s\S]{0,900}?setAvatarBlinkOwnerDraft\(savedOwner\)/u,
    'a failed action rolls the UI draft back to the status value');
  for (const needle of [
    "actions: ['avatar.blinkOwner.set']",
    'blinkOwner: storedAvatarBlinkOwner()',
    "'eye-unverified'",
    'blink: avatarBlinkStatus()',
    'blink: snap.blink ?? null',
  ]) {
    assert.ok(hostSource.includes(needle), `host ships ${needle}`);
  }
  assert.doesNotMatch(clientSource, /avatar\.blinkOwner\.set[\s\S]{0,300}?setInterval/u,
    'the blink choice adds no poller');
  console.log('[blink 5] client/status contract static=ok');
});

// ---------------------------------------------------------------------------------------------
// fake VTS + host mount (only the documented status/action routes)
// ---------------------------------------------------------------------------------------------
async function createFakeVts({
  model = { modelName: 'BlinkOwnerModel', modelID: 'blink-owner-model' },
  parameters = [],
  targets = [],
} = {}) {
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
      switch (request.messageType) {
        case 'AuthenticationTokenRequest':
          respond(socket, request, { authenticationToken: 'fake-token' });
          return;
        case 'AuthenticationRequest':
          respond(socket, request, { authenticated: true });
          return;
        case 'CurrentModelRequest':
          respond(socket, request, { modelLoaded: true, ...model });
          return;
        case 'HotkeysInCurrentModelRequest':
          respond(socket, request, { availableHotkeys: [] });
          return;
        case 'ExpressionStateRequest':
          respond(socket, request, { expressions: [] });
          return;
        case 'InputParameterListRequest':
          respond(socket, request, { defaultParameters: parameters, customParameters: [] });
          return;
        case 'Live2DParameterListRequest':
          respond(socket, request, {
            live2DModelParameters: targets.map((name) => ({ name })),
          });
          return;
        case 'EventSubscriptionRequest':
          respond(socket, request, {
            subscribedEventCount: 1,
            subscribedEvents: ['ModelLoadedEvent'],
          });
          return;
        case 'InjectParameterDataRequest':
          respond(socket, request, {});
          return;
        default:
          respond(socket, request, {});
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    async close() {
      for (const socket of wss.clients) socket.terminate();
      await new Promise((done) => wss.close(() => server.close(() => done())));
    },
  };
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function startHost(fake, { settings = null } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'avatar-blink-owner-'));
  await mkdir(join(root, 'data'), { recursive: true });
  await writeFile(join(root, 'data', 'features.json'), JSON.stringify({ avatar: true }), 'utf8');
  if (settings !== null) {
    await writeFile(join(root, 'data', 'settings.json'), JSON.stringify(settings, null, 2), 'utf8');
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
  return { root, callRoute, status, dispose };
}
