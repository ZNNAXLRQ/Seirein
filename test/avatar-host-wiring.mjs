/**
 * Host wiring for the Live2D behavior runtime.
 *
 * Acceptance pinned here:
 *   1. the mouth is written ONLY through the runtime (one intent → one transport frame; the old
 *      `client.setMouth()` path is gone);
 *   2. an unmapped mouth channel is skipped and recorded as `avatar.channel.skipped {channel}`;
 *   3. preset execution is on by default, so the legacy light idle-action pool is NOT sampled; with
 *      an explicit `presetExecution:false` the light pool is on, and an action the model does not
 *      expose is skipped and recorded, never guessed as an expression (emotions stay intent-only);
 *   4. disabling the avatar component disposes the runtime (its tick stops; status reports it);
 *   5. the unified 30 Hz controller writes by default (`motion.source:'controller'`), an explicit
 *      `avatarMotionWrites:false` keeps the legacy 4 Hz path, and the first connect builds the
 *      persona style immediately (one boot event; an empty persona records a skip).
 *
 * No real VTube Studio is contacted: an in-process fake speaks the same WebSocket protocol as
 * test/vts-gaps.mjs.
 *
 * Run: node --test test/avatar-host-wiring.mjs
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mkdir, mkdtemp, readFile as readText, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { WebSocketServer } from 'ws';

import { apply } from '../src/host/index.js';
import { personaStyleVersion } from '../src/host/avatar/avatarRuntime.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (check, timeoutMs = 4000, stepMs = 25) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await sleep(stepMs);
  }
  return false;
};

// Readiness is waited for with a bounded poll (2 s cap, 25 ms step), never a fixed sleep: the
// host starts the persona style build with a fire-and-forget `void refreshAvatarStyle()`.
// Batched runs execute several host suites at once; the previous 2 s cap produced a single
// unexplained timeout under that load (see batch 2026-11-07: avatar 8/9). The assertion itself is
// unchanged, only the bounded wait is longer.
const READY_TIMEOUT_MS = 5000;
const READY_STEP_MS = 25;

/** The full on-failure scene: motion counters, style versions and the whole event log. */
const describeAvatar = async (host, fake = null) => {
  const status = await host.status().catch((error) => ({ error: String(error?.message ?? error) }));
  const events = await host.events().catch(() => []);
  const runtime = status?.live2d?.runtime ?? null;
  return [
    `live2d.runtime.motion=${JSON.stringify(runtime?.motion ?? null, null, 2)}`,
    `styleVersion(motion)=${JSON.stringify(runtime?.motion?.styleVersion ?? null)}`
      + ` styleVersion(style)=${JSON.stringify(status?.live2d?.style?.styleVersion ?? null)}`,
    `connected=${JSON.stringify(runtime?.connected ?? null)} disposed=${JSON.stringify(runtime?.disposed ?? null)}`
      + ` timerActive=${JSON.stringify(runtime?.timerActive ?? null)}`
      + ` motionEpoch=${JSON.stringify(runtime?.motionEpoch ?? null)}`,
    `vtsFrames=${fake === null ? 'n/a' : fake.frames.length}`,
    `events=${JSON.stringify(events, null, 2)}`,
  ].join('\n');
};

/**
 * Wait until the persona style is BOTH installed on the runtime (`status...motion.styleVersion`)
 * and recorded as `avatar.style.applied {styleVersion}`. On timeout the caller asserts `ok` and
 * prints `detail`, so a real product race is visible instead of being retried away.
 */
const waitStyleReady = async (host, expectedVersion, { fake = null, timeoutMs = READY_TIMEOUT_MS } = {}) => {
  const ok = await waitFor(async () => {
    const status = await host.status();
    if (status?.live2d?.runtime?.motion?.styleVersion !== expectedVersion) return false;
    return (await host.events()).some((event) => event.type === 'avatar.style.applied'
      && event.payload?.styleVersion === expectedVersion);
  }, timeoutMs, READY_STEP_MS);
  return ok ? { ok: true, detail: '' } : { ok: false, detail: await describeAvatar(host, fake) };
};

/** Wait until the unified controller is the writing source and has staged output frames. */
const waitMotionReady = async (host, { fake = null, minOutputFrames = 1, timeoutMs = READY_TIMEOUT_MS } = {}) => {
  const ok = await waitFor(async () => {
    const motion = (await host.status())?.live2d?.runtime?.motion;
    return (motion?.outputFrames ?? 0) >= minOutputFrames && motion?.source === 'controller';
  }, timeoutMs, READY_STEP_MS);
  return ok ? { ok: true, detail: '' } : { ok: false, detail: await describeAvatar(host, fake) };
};

const MOUTH_INPUT = { name: 'MouthOpen', min: 0, max: 1, defaultValue: 0 };
const HEAD_INPUT = { name: 'FaceAngleX', min: -30, max: 30, defaultValue: 0 };

/**
 * Fake VTS. Records every InjectParameterDataRequest / TriggerHotKeyByKeySequenceRequest and
 * TriggerExpressionRequest so a test can prove which path really wrote.
 */
async function createFakeVts({
  defaultParameters = [],
  modelParams = [],
  hotkeys = [],
  expressions = [],
  rejectInputs = [],
  // Delay every InjectParameterDataResponse: lets a test hold one parameter frame in flight
  // while it closes the output gate (the runtime must count that late settle as stale).
  injectDelayMs = 0,
  model = { modelName: 'FakeHiyori', modelID: 'model-A' },
} = {}) {
  const state = { defaultParameters, modelParams, hotkeys, expressions, model, rejectInputs, injectDelayMs };
  const frames = [];
  const rejectedFrames = [];
  const requests = [];
  const triggeredHotkeys = [];
  const triggeredExpressions = [];
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
      requests.push(request);
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
          respond(socket, request, { availableHotkeys: state.hotkeys });
          return;
        case 'ExpressionStateRequest':
          respond(socket, request, { expressions: state.expressions });
          return;
        case 'InputParameterListRequest':
          respond(socket, request, {
            defaultParameters: state.defaultParameters,
            customParameters: [],
          });
          return;
        case 'Live2DParameterListRequest':
          respond(socket, request, { live2DModelParameters: state.modelParams });
          return;
        case 'EventSubscriptionRequest':
          respond(socket, request, { subscribedEvents: ['ModelLoadedEvent'], subscribedEventCount: 1 });
          return;
        case 'InjectParameterDataRequest': {
          frames.push(request);
          // A rejected binding must be observable as an APIError, exactly like real VTS.
          const rejected = (request.data?.parameterValues ?? [])
            .some((value) => state.rejectInputs.includes(value.id));
          if (rejected) {
            rejectedFrames.push(request);
            send(socket, {
              apiName: 'VTubeStudioPublicAPI',
              apiVersion: '1.0',
              requestID: request.requestID,
              messageType: 'APIError',
              data: { errorID: 101, errorMessage: 'parameter rejected by the fake' },
            });
            return;
          }
          if (state.injectDelayMs > 0) {
            setTimeout(() => respond(socket, request, {}), state.injectDelayMs);
            return;
          }
          respond(socket, request, {});
          return;
        }
        case 'HotkeyTriggerRequest':
          triggeredHotkeys.push(request);
          respond(socket, request, {});
          return;
        case 'ExpressionTriggerRequest':
          triggeredExpressions.push(request);
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
    frames,
    rejectedFrames,
    requests,
    triggeredHotkeys,
    triggeredExpressions,
    emitModelLoaded() {
      for (const socket of wss.clients) {
        send(socket, {
          apiName: 'VTubeStudioPublicAPI',
          apiVersion: '1.0',
          messageType: 'ModelLoadedEvent',
          data: { modelLoaded: true, modelName: state.model.modelName, modelID: state.model.modelID },
        });
      }
    },
    async close() {
      for (const socket of wss.clients) socket.terminate();
      await new Promise((done) => wss.close(() => server.close(() => done())));
    },
  };
}

async function startHost(fake, extra = {}, { personaText = '' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'avatar-host-wiring-'));
  await mkdir(join(root, 'data'), { recursive: true });
  await writeFile(join(root, 'data', 'features.json'), JSON.stringify({ avatar: true }), 'utf8');
  if (personaText.length > 0) {
    await mkdir(join(root, 'memory'), { recursive: true });
    // The settings box is the persona source; the style build reads it fresh.
    await writeFile(join(root, 'memory', 'persona.md'), personaText, 'utf8');
  }
  const routes = new Map();
  const tools = new Map();
  const disposers = [];
  const collect = (fn) => {
    const dispose = fn();
    if (typeof dispose === 'function') disposers.push(dispose);
    return dispose;
  };
  const fakeCtx = {
    effect: collect,
    // The persona → style build is one background completion. A scripted stream keeps it a real
    // completion (so `avatar.style.applied` carries a version) without contacting a provider.
    get: (service) => {
      if (service === 'llm') {
        return {
          stream: () => (async function* styleFrames() {
            yield { type: 'text-delta', text: JSON.stringify({ amplitude: 1.15, tempo: 1.1, gazeHabit: 'wandering' }) };
            yield { type: 'finish', reason: { kind: 'stop' } };
          })(),
        };
      }
      if (service === 'agentDefaultModel') {
        return { currentSelection: () => ({ provider: 'fake', model: 'fake-model' }) };
      }
      return undefined;
    },
    tools: {
      register: (definition) => {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
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
  apply(fakeCtx, { root, vtsPort: fake.port, enabled: true, ...extra });

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
  const events = async () => (await readText(join(root, 'data', 'events.jsonl'), 'utf8').catch(() => ''))
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
  return { root, tools, callRoute, status, events, dispose };
}

const waitDiscovered = (host) => waitFor(async () => (await host.status()).live2d?.capabilities?.discovered === true);

test('mouth is written only through the runtime (no legacy setMouth path remains)', async (t) => {
  const fake = await createFakeVts({
    defaultParameters: [MOUTH_INPUT, HEAD_INPUT],
    // The default VTS pairing: these model parameters make the mouth/head bindings verified.
    modelParams: [{ name: 'ParamMouthOpenY' }, { name: 'ParamAngleX' }],
    hotkeys: [{ hotkeyID: 'hk-sway', name: 'sway' }],
  });
  const host = await startHost(fake, { avatarIdleActionIntervalMs: 20 });
  t.after(async () => {
    host.dispose();
    await fake.close();
  });

  const connected = await host.callRoute('/assistant/action', { body: { action: 'live2d.connect' } });
  assert.equal(connected.ok, true, 'live2d.connect succeeds against the fake');
  assert.equal(await waitDiscovered(host), true, 'capability discovery settles');

  const before = fake.frames.length;
  const tool = host.tools.get('assistant_live2d');
  const result = await tool.execute({ action: 'mouth', value: 0.4 });
  assert.equal(result.ok, true, `the mapped mouth is accepted (${result.error})`);
  assert.equal(result.acknowledged, false, 'runtime writes are not reported as VTS-acknowledged');

  // Idle parameter frames may share the transport now, so wait for the mouth frame itself rather
  // than for "one new frame" (which could be a head-angle idle frame).
  const wrote = await waitFor(() => fake.frames.slice(before)
    .some((frame) => frame.data?.parameterValues?.some((value) => value.id === 'MouthOpen' && value.value === 0.4)), 3000);
  assert.equal(wrote, true, 'the mouth value reaches VTS');
  const mouthFrames = fake.frames.slice(before)
    .filter((frame) => frame.data?.parameterValues?.some((value) => value.id === 'MouthOpen'));
  assert.equal(mouthFrames.length, 1, 'exactly one mouth frame for one intent');
  const frame = mouthFrames[0];
  assert.equal(frame.messageType, 'InjectParameterDataRequest');
  assert.equal(frame.data.parameterValues.length, 1, 'a mouth frame carries one parameter');
  assert.equal(frame.data.parameterValues[0].id, 'MouthOpen');
  assert.equal(frame.data.parameterValues[0].value, 0.4);

  const status = await host.status();
  assert.equal(status.live2d.runtime.connected, true, 'status exposes the connected runtime');
  assert.equal(status.live2d.runtime.mouthInput, 'MouthOpen', 'status exposes the mapped mouth input');
  assert.equal(status.live2d.runtime.mouth.writes, 1, 'the runtime counted exactly one mouth write');
  assert.equal(status.live2d.capabilities.mapped.includes('mouth'), true);

  // Continuous output: the unified 30 Hz controller is the default writer, so it stages frames
  // instead of the legacy 4 Hz idle flush (whose counters stay 0 on this path).
  const idleWritten = await waitMotionReady(host, { fake, minOutputFrames: 3 });
  assert.equal(idleWritten.ok, true, `the controller stages interpolated frames continuously — ${idleWritten.detail}`);
  const idleStatus = await host.status();
  assert.equal(idleStatus.live2d.runtime.idleSource, 'param', 'the idle source is the parameter engine');
  assert.ok(idleStatus.live2d.runtime.idleParams.mapped.includes('headX'), 'headX is part of the mapping');
  // Idle write tuning is observable from status, and the tuning event is recorded once at start.
  assert.equal(idleStatus.live2d.runtime.idleActions.writeHz, 4, 'status exposes the configured idle write rate');
  assert.equal(idleStatus.live2d.runtime.idleActions.suppressedBySpeech >= 0, true);
  assert.ok(
    idleStatus.live2d.runtime.motion.controllerFrames > 0,
    'status exposes how many frames the controller computed',
  );
  const tuned = await waitFor(async () => (await host.events())
    .some((event) => event.type === 'avatar.idle.tuned' && event.payload?.writeHz === 4), 2000);
  assert.equal(tuned, true, 'avatar.idle.tuned {writeHz} is recorded at startup');
  const headFrames = fake.frames.filter((entry) => entry.data?.parameterValues
    ?.some((value) => value.id === 'FaceAngleX'));
  assert.ok(headFrames.length > 0, 'head angle idle frames reach VTS');
  for (const entry of headFrames) {
    for (const value of entry.data.parameterValues) {
      if (value.id !== 'FaceAngleX') continue;
      assert.ok(Math.abs(value.value) <= 30, 'the head angle stays inside the declared input range');
    }
  }
  // The model has no eye/gaze inputs: those channels are skipped and recorded, throttled.
  const partialSkip = await waitFor(async () => (await host.events()).some((event) => (
    event.type === 'avatar.channel.skipped' && event.payload?.reason === 'unmapped'
  )), 3000);
  assert.equal(partialSkip, true, 'unmapped idle channels are skipped and recorded');

  // The old direct write path is gone from the host source: the only inject call site is the
  // runtime transport adapter, so a second writer cannot be reintroduced silently.
  const source = await readFile(new URL('../src/host/index.js', import.meta.url), 'utf8');
  const code = source
    .split('\n')
    .map((line) => line.replace(/\/\/[^\r\n]*/u, ''))
    .join('\n');
  assert.equal(/client\.setMouth\(/u.test(code), false, 'no client.setMouth() call remains');
  assert.equal((code.match(/client\.injectInputs\(/gu) ?? []).length, 1, 'one injectInputs call site (the runtime transport)');

  // Preset execution is the default action writer: the host still CONFIGURES the legacy pool
  // (`idleActions.enabled:true`, below) but the preset boundary replaces its sampler. The
  // observable equivalent of `motion.presets.enabled` is therefore: the pool is present yet emits
  // nothing, no legacy hotkey is driven, and no expression is invented.
  await sleep(600);
  const presetIdle = (await host.status()).live2d.runtime.idleActions;
  assert.equal(presetIdle.enabled, true, 'the legacy pool is still configured, not silently deleted');
  assert.equal(presetIdle.emitted, 0,
    'the legacy idle action pool emits nothing while preset execution owns the boundaries');
  assert.deepEqual(fake.triggeredHotkeys, [], 'the legacy idle hotkey path is not driven in preset mode');
  assert.deepEqual(fake.triggeredExpressions, [], 'preset mode never invents an emotion expression');
  const legacyIdleEvents = (await host.events()).filter((event) => event.type === 'avatar.idleAction');
  assert.deepEqual(legacyIdleEvents, [], 'no discrete idle action is queued in preset mode');

  const final = await host.status();
  assert.deepEqual(final.live2d.runtime.idleActions.pool, ['sway'],
    'the host still publishes the adapted pool, but preset mode does not sample it');
  console.log(
    `[avatar] mouthFrames=1 runtimeWrites=${status.live2d.runtime.mouth.writes} mouthInput=${status.live2d.runtime.mouthInput}`
    + ` idleSource=${idleStatus.live2d.runtime.idleSource} controllerFrames=${idleStatus.live2d.runtime.motion.controllerFrames}`
    + ` preset=true legacyIdlePool=${final.live2d.runtime.idleActions.pool.join(',')}`
    + ` legacyIdleEmitted=${final.live2d.runtime.idleActions.emitted}`
    + ` hotkeys=${fake.triggeredHotkeys.length} expressions=${fake.triggeredExpressions.length}`,
  );
});

test('显式 presetExecution:false → 轻量待机动作池仍按旧契约触发适配热键', async (t) => {
  const fake = await createFakeVts({
    defaultParameters: [MOUTH_INPUT, HEAD_INPUT],
    modelParams: [{ name: 'ParamMouthOpenY' }, { name: 'ParamAngleX' }],
    hotkeys: [{ hotkeyID: 'hk-sway', name: 'sway' }],
  });
  const host = await startHost(fake, { avatarIdleActionIntervalMs: 20, presetExecution: false });
  t.after(async () => {
    host.dispose();
    await fake.close();
  });

  assert.equal((await host.callRoute('/assistant/action', { body: { action: 'live2d.connect' } })).ok, true);
  assert.equal(await waitDiscovered(host), true);

  const idled = await waitFor(async () => (await host.status()).live2d?.runtime?.idleActions?.emitted >= 1, 4000);
  assert.equal(idled, true, 'the lightweight idle action pool is enabled when preset execution is off');
  assert.equal(await waitFor(() => fake.triggeredHotkeys.length >= 1, 4000), true,
    'an adapted idle hotkey is triggered on the legacy path');
  assert.deepEqual(fake.triggeredExpressions, [], 'legacy idle actions never trigger expressions');
  const final = await host.status();
  assert.deepEqual(final.live2d.runtime.idleActions.pool, ['sway'], 'the pool narrows to the adapted hotkey');
  console.log(
    `[idle-legacy] presetExecution=false emitted=${final.live2d.runtime.idleActions.emitted}`
    + ` pool=${final.live2d.runtime.idleActions.pool.join(',')}`
    + ` hotkeys=${fake.triggeredHotkeys.length} expressions=${fake.triggeredExpressions.length}`,
  );
});

test('an unmapped mouth channel is skipped and recorded instead of writing', async (t) => {
  const fake = await createFakeVts({ defaultParameters: [HEAD_INPUT], hotkeys: [{ hotkeyID: 'hk-idle', name: 'Idle' }] });
  const host = await startHost(fake, { avatarIdleActionIntervalMs: 20 });
  t.after(async () => {
    host.dispose();
    await fake.close();
  });

  const connected = await host.callRoute('/assistant/action', { body: { action: 'live2d.connect' } });
  assert.equal(connected.ok, true);
  assert.equal(await waitDiscovered(host), true);

  const before = fake.frames.length;
  const tool = host.tools.get('assistant_live2d');
  const result = await tool.execute({ action: 'mouth', value: 0.5 });
  await sleep(150);
  assert.equal(result.ok, false, 'an unmapped mouth fails');
  assert.match(result.error, /mouth channel not mapped/u);
  assert.equal(result.acknowledged, false);
  const mouthFrames = fake.frames.slice(before)
    .filter((entry) => entry.data?.parameterValues?.some((value) => value.id === 'MouthOpen'));
  assert.equal(mouthFrames.length, 0, 'zero MouthOpen frames for an unmapped mouth');

  const events = await host.events();
  const skippedMouth = events.filter((event) => event.type === 'avatar.channel.skipped'
    && event.payload?.channel === 'mouth' && event.payload?.reason === 'unmapped');
  assert.ok(skippedMouth.length >= 1,
    'avatar.channel.skipped {channel:"mouth",reason:"unmapped"} is recorded');
  assert.equal((await host.status()).live2d.runtime.mouth.unmapped >= 1, true, 'the runtime counted the unmapped write');

  // Preset execution is the default action writer: the legacy light idle pool is configured but
  // not sampled at all, so the old "unadapted idle action skipped" stream must not appear, and no
  // expression is invented as a fallback.
  await sleep(600);
  const presetMode = (await host.status()).live2d.runtime.idleActions;
  assert.equal(presetMode.enabled, true, 'the legacy pool is still configured, not silently deleted');
  assert.equal(presetMode.emitted, 0,
    'the legacy idle action pool emits nothing while preset execution owns the boundaries');
  const idleSkips = (await host.events()).filter((event) => event.type === 'avatar.channel.skipped'
    && ['sway', 'tilt', 'glance', 'nod'].includes(event.payload?.channel));
  assert.deepEqual(idleSkips, [], 'preset mode records no legacy idle-action skip');
  assert.deepEqual(fake.triggeredExpressions, [], 'no emotional expression is triggered');
  console.log(
    `[avatar] unmapped mouth frames=0 skippedMouthEvents=${skippedMouth.length}`
    + ` presetModeIdleEmits=${presetMode.emitted} skippedIdleEvents=${idleSkips.length}`
    + ` expressions=${fake.triggeredExpressions.length}`,
  );
});

test('显式 presetExecution:false → 未适配的轻量待机动作被跳过并记录', async (t) => {
  const fake = await createFakeVts({
    defaultParameters: [HEAD_INPUT],
    hotkeys: [{ hotkeyID: 'hk-idle', name: 'Idle' }],
  });
  const host = await startHost(fake, { avatarIdleActionIntervalMs: 20, presetExecution: false });
  t.after(async () => {
    host.dispose();
    await fake.close();
  });

  assert.equal((await host.callRoute('/assistant/action', { body: { action: 'live2d.connect' } })).ok, true);
  assert.equal(await waitDiscovered(host), true);

  const skipped = await waitFor(async () => (await host.events()).some((event) => (
    event.type === 'avatar.channel.skipped'
    && ['sway', 'tilt', 'glance', 'nod'].includes(event.payload?.channel)
    && event.payload?.reason === 'idle-action-unmapped'
  )), 5000);
  assert.equal(skipped, true, 'an unadapted idle action is skipped and recorded on the legacy path');
  assert.deepEqual(fake.triggeredExpressions, [], 'no emotional expression is triggered');
  const final = await host.status();
  assert.ok(final.live2d.runtime.idleActions.emitted >= 1, 'the legacy pool really sampled an action');
  console.log(
    `[idle-legacy] presetExecution=false emitted=${final.live2d.runtime.idleActions.emitted}`
    + ` skippedIdleEvents=${(await host.events()).filter((event) => event.type === 'avatar.channel.skipped'
      && ['sway', 'tilt', 'glance', 'nod'].includes(event.payload?.channel)).length}`
    + ` expressions=${fake.triggeredExpressions.length}`,
  );
});

test('disabling the avatar component disposes the runtime', async (t) => {
  const fake = await createFakeVts({ defaultParameters: [MOUTH_INPUT], hotkeys: [] });
  const host = await startHost(fake, { avatarIdleActionIntervalMs: 20 });
  t.after(async () => {
    host.dispose();
    await fake.close();
  });

  assert.equal((await host.callRoute('/assistant/action', { body: { action: 'live2d.connect' } })).ok, true);
  assert.equal(await waitDiscovered(host), true);
  const connectedStatus = await host.status();
  assert.equal(connectedStatus.live2d.runtime.connected, true);
  assert.equal(connectedStatus.live2d.runtime.disposed, false);
  // Only the mouth input is discovered here: there is no head/eye/gaze mapping, so the runtime
  // writes no idle frames. Preset execution is the default action writer, so the legacy hotkey
  // fallback is configured but not sampled at all — that keeps the disposal assertions below
  // unambiguous.
  await sleep(600);
  const presetIdle = (await host.status()).live2d.runtime.idleActions;
  assert.equal(presetIdle.enabled, true, 'the legacy pool is still configured, not silently deleted');
  assert.equal(presetIdle.emitted, 0, 'the legacy idle action pool emits nothing in preset mode');
  const legacyIdleSkips = (await host.events()).filter((event) => event.type === 'avatar.channel.skipped'
    && ['sway', 'tilt', 'glance', 'nod'].includes(event.payload?.channel));
  assert.deepEqual(legacyIdleSkips, [], 'preset mode records no legacy idle-action skip');
  assert.ok(['hotkey', 'none'].includes(connectedStatus.live2d.runtime.idleSource), 'no parameter engine without a mapping');
  assert.deepEqual(connectedStatus.live2d.runtime.idleParams.mapped, []);
  assert.equal(connectedStatus.live2d.runtime.idleParams.writes, 0);
  assert.equal(fake.frames.length, 0, 'no parameter frame without an idle mapping');

  const disabled = await host.callRoute('/assistant/action', { body: { action: 'feature.set', id: 'avatar', enabled: false } });
  assert.equal(disabled.ok, true, 'feature.set avatar=false succeeds');

  const disposed = await waitFor(async () => (await host.status()).live2d?.runtime?.disposed === true, 3000);
  assert.equal(disposed, true, 'the runtime is disposed by the component hook');
  const status = await host.status();
  assert.equal(status.live2d.runtime.connected, false, 'a disposed runtime is not connected');
  assert.equal(status.live2d.runtime.timerActive, false, 'the runtime tick is cleared');

  // No further frames may be written after disposal, even with playback/idle timing still pending.
  const before = fake.frames.length;
  await sleep(300);
  assert.equal(fake.frames.length, before, 'a disposed runtime writes nothing');
  const events = await host.events();
  assert.ok(
    events.some((event) => event.type === 'avatar.runtime.dispose' && event.payload?.reason === 'component-disabled'),
    'the dispose reason is recorded',
  );
  console.log(
    `[avatar] disabled → disposed=${status.live2d.runtime.disposed} connected=${status.live2d.runtime.connected}`
    + ` timerActive=${status.live2d.runtime.timerActive} framesAfterDispose=${fake.frames.length - before}`,
  );
});

// ---------------------------------------------------------------------------------------------
// Channel takeover: verified input mappings only
// ---------------------------------------------------------------------------------------------

const HEAD_Y_INPUT = { name: 'FaceAngleY', min: -30, max: 30, defaultValue: 0 };
const HEAD_Z_INPUT = { name: 'FaceAngleZ', min: -30, max: 30, defaultValue: 0 };
const EYE_L_INPUT = { name: 'EyeOpenLeft', min: 0, max: 1, defaultValue: 0 };
const EYE_R_INPUT = { name: 'EyeOpenRight', min: 0, max: 1, defaultValue: 0 };
const injectedIds = (fake) => fake.frames.flatMap((frame) => (frame.data?.parameterValues ?? [])
  .map((value) => String(value.id)));

test('takeover only covers discovered verified inputs; injectable candidates stay unverified', async (t) => {
  const fake = await createFakeVts({
    defaultParameters: [MOUTH_INPUT, HEAD_INPUT, HEAD_Y_INPUT, HEAD_Z_INPUT, EYE_L_INPUT, EYE_R_INPUT],
    // Model parameters are evidence: only the standard pairings that are present verify a channel.
    modelParams: [
      { name: 'ParamAngleX' }, { name: 'ParamEyeLOpen' }, { name: 'ParamBreath' },
      { name: 'ParamMouthOpenY' },
    ],
    hotkeys: [{ hotkeyID: 'hk-sway', name: 'sway' }],
  });
  const host = await startHost(fake, { avatarIdleActionIntervalMs: 20 });
  t.after(async () => {
    host.dispose();
    await fake.close();
  });

  assert.equal((await host.callRoute('/assistant/action', { body: { action: 'live2d.connect' } })).ok, true);
  assert.equal(await waitDiscovered(host), true);
  const ready = await waitFor(async () => {
    const channels = (await host.status()).live2d?.runtime?.channels;
    return channels?.controlled?.includes('mouth') === true && channels.skipped.length > 0;
  }, 3000);
  assert.equal(ready, true, 'the runtime publishes its channel takeover set');

  const channels = (await host.status()).live2d.runtime.channels;
  assert.deepEqual(
    channels.controlled,
    ['headX', 'eyeOpenL', 'mouth'],
    'only channels discovery verified (input + matching model parameter) are controlled',
  );
  assert.deepEqual(
    channels.unverified,
    ['headY', 'headZ', 'eyeOpenR'],
    'injectable inputs without the matching model parameter are candidates, not controlled',
  );
  for (const channel of ['gazeX', 'gazeY', 'breath']) {
    assert.ok(channels.skipped.includes(channel), `${channel} is skipped as unmapped`);
    assert.equal(channels.controlled.includes(channel), false, `${channel} was not taken over`);
  }

  const waitIdle = await waitFor(() => fake.frames.some((frame) => frame.data?.parameterValues
    ?.some((value) => String(value.id).startsWith('FaceAngle'))), 3000);
  assert.equal(waitIdle, true, 'a verified head mapping is written');
  for (const id of injectedIds(fake)) {
    assert.equal(id.startsWith('Param'), false, `${id} is a model parameter, never an injectable input`);
    assert.equal(['Breath', 'EyeBallX', 'EyeBallY'].includes(id), false, `${id} was never mapped`);
    assert.equal(['FaceAngleY', 'FaceAngleZ', 'EyeOpenRight'].includes(id), false,
      `${id} is injectable but unverified, so it is never written`);
  }
  const skipped = (await host.events()).filter((event) => event.type === 'avatar.channel.skipped');
  for (const channel of ['gazeX', 'breath']) {
    assert.ok(
      skipped.some((event) => event.payload?.channel === channel && event.payload?.reason === 'unmapped'),
      `${channel} records avatar.channel.skipped {reason:"unmapped"}`,
    );
  }
  const unverifiedEvents = (await host.events()).filter((event) => event.type === 'avatar.channel.unverified');
  for (const channel of ['headY', 'headZ', 'eyeOpenR']) {
    assert.ok(
      unverifiedEvents.some((event) => event.payload?.channel === channel
        && event.payload?.reason === 'not-verified'),
      `${channel} records avatar.channel.unverified {reason:"not-verified"}`,
    );
  }
  console.log(
    `[channels] controlled=${channels.controlled.join(',')} skipped=${channels.skipped.join(',')}`
    + ` unverified=${channels.unverified.join(',')} injected=${[...new Set(injectedIds(fake))].join(',')}`,
  );
});

test('an explicit gaze mapping enters controlled only after an accepted probe', async (t) => {
  const fake = await createFakeVts({
    defaultParameters: [MOUTH_INPUT, HEAD_INPUT, { name: 'MyGazeX', min: -1, max: 1, defaultValue: 0 }],
    modelParams: [{ name: 'ParamEyeBallX' }, { name: 'ParamAngleX' }, { name: 'ParamMouthOpenY' }],
  });
  const host = await startHost(fake, { avatarChannelMap: { gazeX: 'MyGazeX' } });
  t.after(async () => {
    host.dispose();
    await fake.close();
  });

  assert.equal((await host.callRoute('/assistant/action', { body: { action: 'live2d.connect' } })).ok, true);
  assert.equal(await waitDiscovered(host), true);
  const controlled = await waitFor(async () => (
    (await host.status()).live2d?.runtime?.channels?.controlled?.includes('gazeX') === true
  ), 3000);
  assert.equal(controlled, true, 'the accepted probe promotes gazeX to controlled');

  const channels = (await host.status()).live2d.runtime.channels;
  assert.equal(channels.unverified.includes('gazeX'), false, 'an accepted probe is not unverified');
  assert.ok(channels.controlled.includes('mouth') && channels.controlled.includes('headX'));
  const gazeFrames = fake.frames.filter((frame) => frame.data?.parameterValues
    ?.some((value) => value.id === 'MyGazeX'));
  assert.equal(gazeFrames.length, 1, 'exactly one probe frame was injected');
  assert.equal(gazeFrames[0].data.parameterValues[0].id, 'MyGazeX');
  assert.equal(gazeFrames[0].data.parameterValues[0].value, 0, 'the probe used the neutral/default value');
  assert.equal(fake.rejectedFrames.length, 0, 'VTS accepted the probe');
  const verified = await waitFor(async () => (await host.events()).some((event) => (
    event.type === 'avatar.channel.verified'
    && event.payload?.channel === 'gazeX' && event.payload?.input === 'MyGazeX'
  )), 2000);
  assert.equal(verified, true, 'avatar.channel.verified records the accepted binding');
  console.log(
    `[channels] explicit gazeX=MyGazeX controlled=${channels.controlled.join(',')}`
    + ` probeFrames=${gazeFrames.length} unverified=${channels.unverified.join(',') || 'none'}`,
  );
});

test('a rejected explicit probe stays unverified and is never written again', async (t) => {
  const fake = await createFakeVts({
    defaultParameters: [MOUTH_INPUT, HEAD_INPUT, { name: 'MyGazeX', min: -1, max: 1, defaultValue: 0 }],
    modelParams: [{ name: 'ParamEyeBallX' }, { name: 'ParamAngleX' }],
    rejectInputs: ['MyGazeX'],
  });
  const host = await startHost(fake, { avatarChannelMap: { gazeX: 'MyGazeX' } });
  t.after(async () => {
    host.dispose();
    await fake.close();
  });

  assert.equal((await host.callRoute('/assistant/action', { body: { action: 'live2d.connect' } })).ok, true);
  assert.equal(await waitDiscovered(host), true);
  const unverified = await waitFor(async () => (
    (await host.status()).live2d?.runtime?.channels?.unverified?.includes('gazeX') === true
  ), 3000);
  assert.equal(unverified, true, 'the rejected probe leaves gazeX unverified');

  const channels = (await host.status()).live2d.runtime.channels;
  assert.equal(channels.controlled.includes('gazeX'), false, 'gazeX is not taken over');
  assert.equal(fake.rejectedFrames.length, 1, 'the rejected probe is visible as an APIError');
  assert.equal(fake.rejectedFrames[0].data.parameterValues.length, 1);
  assert.equal(fake.rejectedFrames[0].data.parameterValues[0].id, 'MyGazeX');
  const before = fake.frames.filter((frame) => frame.data?.parameterValues
    ?.some((value) => value.id === 'MyGazeX')).length;
  await sleep(350);
  const after = fake.frames.filter((frame) => frame.data?.parameterValues
    ?.some((value) => value.id === 'MyGazeX')).length;
  assert.equal(after, before, 'an unverified input is never injected again');
  assert.equal(after, 1, 'only the original probe was sent');
  const recorded = await waitFor(async () => (await host.events()).some((event) => (
    event.type === 'avatar.channel.unverified'
    && event.payload?.channel === 'gazeX' && event.payload?.input === 'MyGazeX'
  )), 2000);
  assert.equal(recorded, true, 'avatar.channel.unverified records the failed binding');
  console.log(
    `[channels] rejected gazeX=MyGazeX controlled=${channels.controlled.join(',')}`
    + ` unverified=${channels.unverified.join(',')} frames=${after}`,
  );
});

test('unverified breath/gaze never cause a VTS tracking/breath shutdown call', async (t) => {
  const fake = await createFakeVts({
    defaultParameters: [MOUTH_INPUT],
    // The model does expose these output parameters — the API still cannot inject them.
    modelParams: [{ name: 'ParamBreath' }, { name: 'ParamEyeBallX' }, { name: 'ParamEyeBallY' }],
  });
  const host = await startHost(fake, {
    avatarChannelMap: {
      breath: 'ParamBreath',
      gazeX: 'ParamEyeBallX',
      gazeY: 'ParamEyeBallY',
    },
  });
  t.after(async () => {
    host.dispose();
    await fake.close();
  });

  assert.equal((await host.callRoute('/assistant/action', { body: { action: 'live2d.connect' } })).ok, true);
  assert.equal(await waitDiscovered(host), true);
  const ready = await waitFor(async () => {
    const list = (await host.status()).live2d?.runtime?.channels?.unverified ?? [];
    return ['breath', 'gazeX', 'gazeY'].every((channel) => list.includes(channel));
  }, 3000);
  assert.equal(ready, true, 'model parameter names never verify an input');

  const channels = (await host.status()).live2d.runtime.channels;
  for (const channel of ['breath', 'gazeX', 'gazeY']) {
    assert.equal(channels.controlled.includes(channel), false, `${channel} is not controlled`);
  }
  assert.deepEqual(fake.frames, [], 'no injection is sent for an unverified channel');
  const forbidden = fake.requests.filter((request) => (
    /Tracking|Breath|SetParameter|SetModelParameter/u.test(String(request.messageType))
  ));
  assert.deepEqual(forbidden, [], 'no VTS tracking/breath shutdown request exists');
  assert.deepEqual(injectedIds(fake), [], 'no model parameter name is ever injected');
  console.log(
    `[channels] unverified=${channels.unverified.join(',')} controlled=${channels.controlled.join(',')}`
    + ` injectionFrames=${fake.frames.length} shutdownCalls=0`,
  );
});

// ---------------------------------------------------------------------------------------------
// Motion gate, attention and the opt-in 30 Hz output path
// ---------------------------------------------------------------------------------------------

const GAZE_X_INPUT = { name: 'EyeBallX', min: -1, max: 1, defaultValue: 0 };
const GAZE_Y_INPUT = { name: 'EyeBallY', min: -1, max: 1, defaultValue: 0 };
const GAZE_MODEL_PARAMS = [{ name: 'ParamEyeBallX' }, { name: 'ParamEyeBallY' }];

/** Connect a host whose model exports a verified head channel (the motion frame producer). */
async function startMotionHost({ injectDelayMs = 0 } = {}) {
  const fake = await createFakeVts({
    defaultParameters: [MOUTH_INPUT, HEAD_INPUT, GAZE_X_INPUT, GAZE_Y_INPUT],
    modelParams: [{ name: 'ParamAngleX' }, { name: 'ParamMouthOpenY' }, ...GAZE_MODEL_PARAMS],
    injectDelayMs,
  });
  const host = await startHost(fake, { avatarIdleActionIntervalMs: 20, obsPort: 1 });
  assert.equal((await host.callRoute('/assistant/action', { body: { action: 'live2d.connect' } })).ok, true);
  assert.equal(await waitDiscovered(host), true);
  assert.equal(await waitFor(async () => (
    (await host.status()).live2d?.runtime?.channels?.controlled?.includes('headX') === true
  ), 3000), true, 'the runtime is connected and mapped');
  const controllerReady = await waitMotionReady(host, { fake });
  assert.equal(controllerReady.ok, true,
    `the 30 Hz controller is the writing source before the motion assertions — ${controllerReady.detail}`);
  return { fake, host };
}

test('entering privacy locks the motion gate once and drops the late frame as stale', async (t) => {
  // The fake holds every parameter frame unanswered for 2 s: VTS's own reply timeout (400 ms)
  // settles it while the gate is already closed, which is exactly the "old generation" case.
  const { fake, host } = await startMotionHost({ injectDelayMs: 2000 });
  t.after(async () => {
    host.dispose();
    await fake.close();
  });
  const before = (await host.status()).live2d.runtime;
  assert.equal(before.motion.writes, true, 'the default output path is the 30 Hz controller');
  assert.equal(before.motion.source, 'controller');

  // Hold one idle frame in flight, then enter privacy while it is still unanswered. Waiting for
  // a NEW frame (not "any frame") matters: earlier idle frames may already have settled.
  const framesBefore = fake.frames.length;
  assert.equal(await waitFor(() => fake.frames.length > framesBefore, 3000), true, 'an idle frame reached VTS');
  const privacy = await host.callRoute('/assistant/action', { body: { action: 'privacy.toggle' } });
  assert.equal(privacy.ok, true, `entering privacy succeeds (${privacy.error ?? privacy.warning ?? ''})`);
  assert.equal(privacy.mode, 'privacy');

  assert.equal(
    await waitFor(async () => (await host.status()).live2d?.runtime?.motion?.locked === true, 2000),
    true,
    'the runtime reports the output gate as locked',
  );
  assert.equal(
    await waitFor(async () => (await host.events()).some((event) => event.type === 'avatar.motion.locked'), 2000),
    true,
    'avatar.motion.locked is recorded',
  );
  const lockEvents = (await host.events()).filter((event) => event.type === 'avatar.motion.locked');
  assert.equal(lockEvents.length, 1, `avatar.motion.locked is recorded once (${lockEvents.length})`);
  assert.equal(lockEvents[0].payload?.reason, 'privacy');
  const locked = (await host.status()).live2d.runtime;
  assert.equal(locked.motion.lockReason, 'privacy');
  assert.ok(locked.motionEpoch >= 1, `the lock bumps the output generation (${locked.motionEpoch})`);

  // The frame that was already in flight settles after the lock: it must be counted as stale.
  assert.equal(
    await waitFor(async () => (await host.status()).live2d?.runtime?.motion?.stale >= 1, 2500),
    true,
    'the frame settling after the lock is counted as stale',
  );
  const framesAtLock = fake.frames.length;
  await sleep(500);
  assert.equal(fake.frames.length, framesAtLock, 'no new parameter frame is written after the lock');
  const final = (await host.status()).live2d.runtime;
  console.log(
    `[lock] lockEvents=${lockEvents.length} reason=${lockEvents[0].payload?.reason}`
    + ` stale=${final.motion.stale} motionEpoch=${final.motionEpoch}`
    + ` framesAfterLock=${fake.frames.length - framesAtLock}`,
  );
});

test('leaving privacy unlocks the gate and idle writes resume', async (t) => {
  const { fake, host } = await startMotionHost();
  t.after(async () => {
    host.dispose();
    await fake.close();
  });

  const entered = await host.callRoute('/assistant/action', { body: { action: 'privacy.toggle' } });
  assert.equal(entered.ok, true);
  assert.equal(entered.mode, 'privacy');
  assert.equal(
    await waitFor(async () => (await host.status()).live2d?.runtime?.motion?.locked === true, 2000),
    true,
    'privacy closes the gate before the restore step',
  );
  const framesAtLock = fake.frames.length;
  await sleep(250);
  assert.equal(fake.frames.length, framesAtLock, 'a locked runtime writes nothing while private');

  const restore = await host.callRoute('/assistant/action', { body: { action: 'privacy.toggle' } });
  assert.equal(restore.ok, true);
  assert.equal(restore.mode, 'watch');
  assert.equal(
    await waitFor(async () => (await host.status()).live2d?.runtime?.motion?.locked === false, 2000),
    true,
    'leaving privacy unlocks the output gate',
  );
  assert.equal(
    await waitFor(async () => (await host.events()).some((event) => event.type === 'avatar.motion.unlocked'), 2000),
    true,
    'avatar.motion.unlocked is recorded',
  );
  const unlockEvents = (await host.events()).filter((event) => event.type === 'avatar.motion.unlocked');
  assert.ok(unlockEvents.length >= 1, 'avatar.motion.unlocked is recorded');
  assert.equal(
    await waitFor(() => fake.frames.length > framesAtLock, 3000),
    true,
    'idle frames are written again after unlock',
  );
  const final = (await host.status()).live2d.runtime;
  console.log(
    `[unlock] unlockEvents=${unlockEvents.length} locked=${final.motion.locked}`
    + ` framesAfterUnlock=${fake.frames.length - framesAtLock} motionEpoch=${final.motionEpoch}`,
  );
});

test('without a verified gaze channel setAttention is never called, even with a vision position', async (t) => {
  const fake = await createFakeVts({
    // Head + mouth only: nothing in this model verifies a gaze input.
    defaultParameters: [MOUTH_INPUT, HEAD_INPUT],
    modelParams: [{ name: 'ParamAngleX' }, { name: 'ParamMouthOpenY' }],
  });
  const host = await startHost(fake, {
    avatarIdleActionIntervalMs: 20,
    // A real position is available, but the second proof (a verified gaze channel) is missing.
    vision: { userPosition: { x: 0.6, y: -0.2 } },
  });
  t.after(async () => {
    host.dispose();
    await fake.close();
  });

  assert.equal((await host.callRoute('/assistant/action', { body: { action: 'live2d.connect' } })).ok, true);
  assert.equal(await waitDiscovered(host), true);
  assert.equal(await waitFor(async () => {
    const channels = (await host.status()).live2d?.runtime?.channels;
    return channels?.controlled?.includes('headX') === true && channels?.controlled?.includes('gazeX') === false;
  }, 3000), true, 'the verified set has no gaze channel');
  await sleep(300);

  const runtime = (await host.status()).live2d.runtime;
  assert.equal(runtime.motion.attentionCalls, 0, 'setAttention is not called without a verified gaze channel');
  assert.equal(runtime.motion.attention.mode, 'neutral', 'attention stays neutral');
  assert.deepEqual(runtime.motion.attention.target, { x: 0, y: 0 }, 'neutral attention is (0, 0), never a random look');
  assert.equal(runtime.motion.writes, true, 'the 30 Hz controller is on by default');
  assert.equal(runtime.motion.source, 'controller');
  console.log(
    `[attention] controlled=${runtime.channels.controlled.join(',')} attentionCalls=${runtime.motion.attentionCalls}`
    + ` attention=${runtime.motion.attention.mode}(${runtime.motion.attention.target.x},${runtime.motion.attention.target.y})`,
  );
});

test('a verified gaze channel plus a real vision position publishes exactly that attention target', async (t) => {
  const fake = await createFakeVts({
    defaultParameters: [MOUTH_INPUT, HEAD_INPUT, GAZE_X_INPUT, GAZE_Y_INPUT],
    modelParams: [{ name: 'ParamAngleX' }, { name: 'ParamMouthOpenY' }, ...GAZE_MODEL_PARAMS],
  });
  const position = { x: 0.45, y: -0.3 };
  const host = await startHost(fake, { avatarIdleActionIntervalMs: 20, vision: { userPosition: position } });
  t.after(async () => {
    host.dispose();
    await fake.close();
  });

  assert.equal((await host.callRoute('/assistant/action', { body: { action: 'live2d.connect' } })).ok, true);
  assert.equal(await waitDiscovered(host), true);
  assert.equal(await waitFor(async () => (
    (await host.status()).live2d?.runtime?.motion?.attentionCalls >= 1
  ), 3000), true, 'the verified gaze + real position pair publishes attention');

  const runtime = (await host.status()).live2d.runtime;
  assert.equal(runtime.channels.controlled.includes('gazeX'), true, 'gazeX is verified');
  assert.ok(runtime.motion.attentionCalls >= 1, 'setAttention was really called');
  assert.equal(runtime.motion.attention.mode, 'user');
  assert.deepEqual(runtime.motion.attention.target, position, 'the published target is the vision position');
  assert.equal(runtime.motion.attention.verified, true);
  assert.equal(runtime.motion.attention.source, 'vision');
  console.log(
    `[attention] controlled=${runtime.channels.controlled.join(',')} attentionCalls=${runtime.motion.attentionCalls}`
    + ` target=(${runtime.motion.attention.target.x},${runtime.motion.attention.target.y})`
    + ` verified=${runtime.motion.attention.verified} source=${runtime.motion.attention.source}`,
  );
});

test('默认启用 30 Hz 控制器：不传配置即 motionWrites 生效、source=controller、状态字段齐全', async (t) => {
  const fake = await createFakeVts({
    defaultParameters: [HEAD_INPUT, GAZE_X_INPUT],
    modelParams: [{ name: 'ParamAngleX' }, { name: 'ParamEyeBallX' }],
  });
  const host = await startHost(fake, { avatarIdleActionIntervalMs: 20 });
  t.after(async () => {
    host.dispose();
    await fake.close();
  });
  assert.equal((await host.callRoute('/assistant/action', { body: { action: 'live2d.connect' } })).ok, true);
  assert.equal(await waitDiscovered(host), true);
  const controllerReady = await waitMotionReady(host, { fake, minOutputFrames: 3 });
  assert.equal(controllerReady.ok, true,
    `the controller stages interpolated frames by default — ${controllerReady.detail}`);

  const runtime = (await host.status()).live2d.runtime;
  assert.equal(runtime.motion.writes, true, 'motionWrites is on by default');
  assert.equal(runtime.motion.source, 'controller', 'the default writer is the unified controller');
  assert.ok(runtime.motion.controllerFrames > 0, `the controller computed frames (${runtime.motion.controllerFrames})`);
  assert.equal(typeof runtime.motion.heldPosture, 'boolean', 'heldPosture is reported');
  assert.equal(runtime.motion.heldPosture, true, 'the controller is inside a held-posture window');
  assert.equal(typeof runtime.motion.styleVersion, 'string', 'styleVersion is reported');
  assert.equal(await waitFor(() => fake.frames.length >= 1, 3000), true, 'controller frames reach VTS');
  console.log(
    `[motion] default writes=${runtime.motion.writes} source=${runtime.motion.source}`
    + ` controllerFrames=${runtime.motion.controllerFrames} heldPosture=${runtime.motion.heldPosture}`
    + ` styleVersion=${runtime.motion.styleVersion || '(default)'} outputFrames=${runtime.motion.outputFrames}`
    + ` vtsFrames=${fake.frames.length}`,
  );
});

test('显式 avatarMotionWrites:false → source=legacy，写入频率仍 4Hz', async (t) => {
  const fake = await createFakeVts({
    defaultParameters: [HEAD_INPUT, GAZE_X_INPUT],
    modelParams: [{ name: 'ParamAngleX' }, { name: 'ParamEyeBallX' }],
  });
  const host = await startHost(fake, { avatarIdleActionIntervalMs: 20, avatarMotionWrites: false });
  t.after(async () => {
    host.dispose();
    await fake.close();
  });
  assert.equal((await host.callRoute('/assistant/action', { body: { action: 'live2d.connect' } })).ok, true);
  assert.equal(await waitDiscovered(host), true);
  assert.equal(await waitFor(async () => (
    (await host.status()).live2d?.runtime?.idleParams?.writes >= 1
  ), 3000), true, 'the legacy idle flush writes');
  const before = (await host.status()).live2d.runtime.idleParams.frames;
  await sleep(1000);
  const after = (await host.status()).live2d.runtime.idleParams.frames;
  const framesInSecond = after - before;
  const runtime = (await host.status()).live2d.runtime;
  assert.equal(runtime.motion.writes, false, 'the explicit opt-out reaches the runtime config');
  assert.equal(runtime.motion.source, 'legacy', 'the status names the legacy writer');
  assert.equal(runtime.motion.outputFrames, 0, 'the 30 Hz pump is not running');
  assert.equal(runtime.idleParams.writeHz, 4, 'the legacy idle cadence is preserved');
  assert.ok(framesInSecond >= 3 && framesInSecond <= 6,
    `1 s of legacy output stays around 4 Hz (${framesInSecond} frames)`);
  assert.equal(await waitFor(() => fake.frames.length >= 1, 3000), true, 'legacy frames reach VTS');
  console.log(
    `[motion] legacy writes=${runtime.motion.writes} source=${runtime.motion.source}`
    + ` outputFrames=${runtime.motion.outputFrames} writeHz=${runtime.idleParams.writeHz}`
    + ` framesPerSecond=${framesInSecond} styleVersion=${runtime.motion.styleVersion || '(default)'}`,
  );
});

test('首次连接立即生成人设风格（只触发一次），status.motion.styleVersion 可核对', async (t) => {
  const personaText = '温柔、沉稳的陪伴者，说话慢一点';
  const fake = await createFakeVts({
    defaultParameters: [HEAD_INPUT],
    modelParams: [{ name: 'ParamAngleX' }],
  });
  const host = await startHost(fake, { avatarIdleActionIntervalMs: 20 }, { personaText });
  t.after(async () => {
    host.dispose();
    await fake.close();
  });
  assert.equal((await host.callRoute('/assistant/action', { body: { action: 'live2d.connect' } })).ok, true);

  assert.equal(await waitFor(async () => (
    (await host.events()).filter((event) => event.type === 'avatar.style.boot').length === 1
  ), 3000), true, 'the first connect triggers exactly one background build');
  const expectedVersion = personaStyleVersion(personaText);
  const styleReady = await waitStyleReady(host, expectedVersion, { fake });
  assert.equal(styleReady.ok, true,
    `the build really ran through the model completion — ${styleReady.detail}`);

  const events = await host.events();
  assert.equal(events.filter((event) => event.type === 'avatar.style.boot').length, 1, 'a single boot trigger');
  const applied = events.find((event) => event.type === 'avatar.style.applied');
  assert.equal(applied.payload.styleVersion, expectedVersion, 'the applied version is the persona text version');
  const status = await host.status();
  assert.equal(status.live2d.runtime.motion.styleVersion, expectedVersion,
    'status.motion.styleVersion exposes the installed style');
  assert.equal(status.live2d.style.styleVersion, expectedVersion, 'the style section agrees');
  assert.equal(status.live2d.runtime.motion.source, 'controller', 'the motion writer is unaffected');
  console.log(
    `[style-boot] bootEvents=1 applied=${applied.payload.styleVersion}`
    + ` statusVersion=${status.live2d.runtime.motion.styleVersion}`
    + ` changed=${(applied.payload.changed ?? []).join(',') || 'none'}`,
  );
});

test('人设为空：首次连接跳过风格生成并记事件', async (t) => {
  const fake = await createFakeVts({
    defaultParameters: [HEAD_INPUT],
    modelParams: [{ name: 'ParamAngleX' }],
  });
  const host = await startHost(fake, { avatarIdleActionIntervalMs: 20 });
  t.after(async () => {
    host.dispose();
    await fake.close();
  });
  assert.equal((await host.callRoute('/assistant/action', { body: { action: 'live2d.connect' } })).ok, true);

  assert.equal(await waitFor(async () => (await host.events()).some((event) => (
    event.type === 'avatar.style.skipped' && event.payload?.reason === 'empty-persona'
  )), 3000), true, 'the empty-persona skip is recorded');
  const events = await host.events();
  assert.equal(events.some((event) => event.type === 'avatar.style.applied'), false, 'no style was generated');
  const status = await host.status();
  assert.equal(status.live2d.runtime.motion.styleVersion, '', 'the default style carries no version');
  assert.equal(status.live2d.runtime.motion.writes, true, 'the motion default is independent of the skip');
  const skipped = events.find((event) => event.type === 'avatar.style.skipped');
  console.log(
    `[style-skip] skipped=${skipped.payload.reason} trigger=${skipped.payload.trigger}`
    + ` styleVersion='${status.live2d.runtime.motion.styleVersion}' writes=${status.live2d.runtime.motion.writes}`,
  );
});

test('idle tuning inherits the module defaults unless explicitly configured', async (t) => {
  const defaultFake = await createFakeVts({
    defaultParameters: [HEAD_INPUT],
    modelParams: [{ name: 'ParamAngleX' }],
  });
  const defaultHost = await startHost(defaultFake, {});
  t.after(async () => {
    defaultHost.dispose();
    await defaultFake.close();
  });
  assert.equal((await defaultHost.callRoute('/assistant/action', { body: { action: 'live2d.connect' } })).ok, true);
  assert.equal(await waitDiscovered(defaultHost), true);
  const defaults = (await defaultHost.status()).live2d.runtime.idleActions;
  assert.equal(defaults.intervalMs, 7000, 'the module default interval is inherited');
  assert.equal(defaults.amplitude, 0.18, 'the module default amplitude is inherited');
  assert.equal(defaults.maxStep, 0.03, 'the module default step cap is inherited');
  assert.equal(defaults.swayScale, 1.2, 'the module default sway scale is inherited');
  assert.equal(defaults.writeHz, 4, 'the module default idle cadence is inherited');

  const explicitFake = await createFakeVts({
    defaultParameters: [HEAD_INPUT],
    modelParams: [{ name: 'ParamAngleX' }],
  });
  const explicitHost = await startHost(explicitFake, {
    avatarIdleActionIntervalMs: 9000,
    avatarIdleAmplitude: 0.1,
    avatarIdleMaxStep: 0.02,
  });
  t.after(async () => {
    explicitHost.dispose();
    await explicitFake.close();
  });
  assert.equal((await explicitHost.callRoute('/assistant/action', { body: { action: 'live2d.connect' } })).ok, true);
  assert.equal(await waitDiscovered(explicitHost), true);
  const explicit = (await explicitHost.status()).live2d.runtime.idleActions;
  assert.equal(explicit.intervalMs, 9000, 'an explicit interval overrides the module default');
  assert.equal(explicit.amplitude, 0.1, 'an explicit amplitude overrides the module default');
  assert.equal(explicit.maxStep, 0.02, 'an explicit step cap overrides the module default');
  console.log(
    `[idle] defaults=${defaults.intervalMs}/${defaults.amplitude}/${defaults.maxStep}/${defaults.swayScale}`
    + ` explicit=${explicit.intervalMs}/${explicit.amplitude}/${explicit.maxStep}/${explicit.swayScale}`,
  );
});
