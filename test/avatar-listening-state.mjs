/**
 * Listening is temporary: the avatar state machine must never get stuck in `listening`.
 *
 * Root cause pinned here (the real regression): an open microphone is not speech. The host used
 * to seed `listening` from `hearing !== null` when the behavior runtime was created, and again
 * unconditionally at `hearing.start`. Under autoListen no `hearing.stop/exit` ever arrives, so
 * `listening` had no exit: the waiting→tired(10 min)→idle preset draw never ran again (an idle
 * `avatar.preset.*` event stream filled with `user-speaking`, zero `idle`).
 *
 * Acceptance pinned here:
 *   1. creating the runtime while hearing runs (no turn, no playback) seeds `waiting` — not
 *      `listening`, and no `hearing.active` state row exists;
 *   2. `hearing.start` → waiting; real ASR activity → listening; a real turn → thinking, its end
 *      → waiting; a fake clock then reaches tired (and the idle preset draw keeps running);
 *   3. a silent `listening` state degrades to `waiting` after `config.avatarListeningIdleMs`
 *      (10 s floor here), with `avatar.state {reason:"listening-idle"}` and the debug counter —
 *      and it never fabricates an `idle` state event;
 *   4. creating the runtime while a clip is really playing seeds `speaking`; the clip end returns
 *      to `waiting`;
 *   5. the preset event mapping (`waiting`/`tired` → `idle`) is asserted from the selection
 *      context, and the fake-clock autonomous draw really samples `idle`.
 *
 * The synthetic microphone / TTS are module replacements; the VTS is an in-process fake speaking
 * the same WebSocket protocol as `test/avatar-host-wiring.mjs`. No sound, capture or network is
 * used beyond loopback.
 *
 * Run: node --test test/avatar-listening-state.mjs
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as realSetTimeout } from 'node:timers';
import test from 'node:test';

import { WebSocketServer } from 'ws';

import { cleanupRoot } from './helpers/cleanup.mjs';

/** Per-test-process seams shared with the replaced hearing/TTS modules. */
const state = {
  onUpdate: null,
  players: [],
  synthesized: [],
  hearingStarts: 0,
};
globalThis.__avatarListeningState = state;

const ttsUrl = new URL('../src/host/speech/tts.js', import.meta.url).href;
const hearingUrl = new URL('../src/host/hearing/hearing.js', import.meta.url).href;
const sightUrl = new URL('../src/host/vision/sight.js', import.meta.url).href;

const hooks = registerHooks({
  load(url, context, next) {
    if (url === sightUrl) {
      // `resolveFfplay() === null` keeps the say lane on the file path (synthesize + play) this
      // suite can control; every real capture entry point is forbidden.
      return {
        format: 'module',
        shortCircuit: true,
        source: `
    const forbidden = () => { throw new Error('real capture forbidden'); };
    export const resolveFfmpeg = () => 'ffmpeg-fake';
    export const resolveFfplay = () => null;
    export const capture = forbidden, captureDesktop = forbidden, captureDevice = forbidden;
    export const startStoryboard = forbidden;
    export const OBSERVATION_TTL_MS = 30000;
    export function readObservation(o, { now = Date.now(), ttlMs = 30000 } = {}) {
      const v = o ?? {};
      const c = Number(v.capturedAt);
      const s = Number.isFinite(c) && c > 0 ? c : Number(v.at);
      const at = Number.isFinite(s) && s > 0 ? s : null;
      const ageMs = at === null ? null : Math.max(0, now - at);
      const stale = ageMs === null || ageMs >= ttlMs;
      return { ...v, at, ageMs, stale, hint: stale ? 'stale' : '' };
    }`,
      };
    }
    if (url === hearingUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
    const s = globalThis.__avatarListeningState;
    export const modelReady = () => true;
    export const finalModelReady = () => false;
    export const isLoopbackDevice = (name) => /CABLE|Stereo Mix|Virtual/i.test(String(name));
    export const listDevices = async () => ['Fake Mic'];
    export const startHearing = (options) => {
      s.hearingStarts += 1;
      s.onUpdate = options.onUpdate;
      return {
        device: options.device,
        instanceId: 'fake-hearing',
        stop() {},
        stats: () => ({ rmsDb: -20, peakDb: -10 }),
      };
    };
    export const watchHearingExit = () => {};
    export const annotateTranscript = (text) => text;
    export const joinDetailFields = () => ({});
    export const mergeJoinFallback = () => ({});
    export const offlineLimitedNote = () => '';
    export const truncationNotice = () => '';`,
      };
    }
    if (url === ttsUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
    const s = globalThis.__avatarListeningState;
    export const resolveGptLangs = () => ({ speech: 'zh', subtitle: 'zh' });
    export const resolveGptSovitsTimeout = () => 30000;
    export const configureTts = () => {};
    export const gptSovitsReferenceStatus = async () => ({ seconds: null, ok: false, readable: false });
    export const warmupGptSovits = async () => ({ ok: false, skipped: 'disabled' });
    export const applyGptSovitsModels = () => ({ ok: true });
    export const synthesize = (options) => {
      s.synthesized.push(options?.text ?? '');
      return { file: 'fake-' + s.synthesized.length + '.mp3', bytes: 16, durationMs: 400, provider: 'fake' };
    };
    export const speakStreaming = async () => { throw new Error('streaming not expected'); };
    export const stopPlayback = () => true;
    export const stopTts = () => true;
    // One controllable player: a test resolves it to make the host observe a real clip end.
    export const play = (file, options) => {
      let resolve;
      const done = new Promise((doneResolve) => { resolve = doneResolve; });
      const player = {
        file,
        ...options,
        startedAt: Date.now(),
        endedAt: 0,
        cancelled: false,
        resolve: () => {
          if (player.endedAt === 0) player.endedAt = Date.now();
          resolve();
        },
      };
      s.players.push(player);
      return done;
    };`,
      };
    }
    return next(url, context);
  },
});
const { apply, voiceSessionTarget } = await import('../src/host/index.js');
const { createBehaviorRuntime } = await import('../src/host/avatar/motion-controller.js');
hooks.deregister();

/** Real timers, independent of `t.mock.timers` (only setInterval is mocked in one test). */
const sleep = (ms) => new Promise((resolve) => realSetTimeout(resolve, ms));

const waitFor = async (check, timeoutMs = 6000, stepMs = 20) => {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (await check()) return true;
    await sleep(stepMs);
  }
  return false;
};

/** Minimal fake VTS: authentication, model info and one verified head channel. */
async function createFakeVts() {
  const frames = [];
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
          respond(socket, request, { modelLoaded: true, modelName: 'FakeHiyori', modelID: 'model-A' });
          return;
        case 'HotkeysInCurrentModelRequest':
          respond(socket, request, { availableHotkeys: [] });
          return;
        case 'ExpressionStateRequest':
          respond(socket, request, { expressions: [] });
          return;
        case 'InputParameterListRequest':
          respond(socket, request, {
            defaultParameters: [{ name: 'FaceAngleX', min: -30, max: 30, defaultValue: 0 }],
            customParameters: [],
          });
          return;
        case 'Live2DParameterListRequest':
          respond(socket, request, { live2DModelParameters: [{ name: 'ParamAngleX' }] });
          return;
        case 'EventSubscriptionRequest':
          respond(socket, request, { subscribedEvents: ['ModelLoadedEvent'], subscribedEventCount: 1 });
          return;
        case 'InjectParameterDataRequest':
          frames.push(request);
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
    async close() {
      for (const socket of wss.clients) socket.terminate();
      await new Promise((done) => wss.close(() => server.close(() => done())));
    },
  };
}

/**
 * Mount the real `apply()` with the fake VTS, a synthetic microphone and a controllable TTS.
 * The fake agent completes exactly one empty-bodied turn per delivered utterance, which is all
 * the state machine needs: thinking at `voice.request`, waiting at the turn release.
 */
async function mount(t, fake, { features = {}, config = {}, personaText = '' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'avatar-listening-state-'));
  await mkdir(join(root, 'data'), { recursive: true });
  await mkdir(join(root, 'workspace'), { recursive: true });
  if (personaText.length > 0) {
    await mkdir(join(root, 'memory'), { recursive: true });
    await writeFile(join(root, 'memory', 'persona.md'), personaText, 'utf8');
  }
  await writeFile(join(root, 'data', 'features.json'), JSON.stringify({
    avatar: true,
    hearing: true,
    voice: true,
    memory: false,
    subtitle: false,
    vision: false,
    fastpath: false,
    ...features,
  }), 'utf8');
  await writeFile(join(root, 'data', 'settings.json'), JSON.stringify({
    gptSovits: { enabled: false },
    voice: { chunking: false },
    autoMemory: { enabled: false },
  }), 'utf8');

  state.onUpdate = null;
  state.players = [];
  state.synthesized = [];
  state.hearingStarts = 0;

  const cleanups = [];
  const tools = new Map();
  const routes = new Map();
  const listeners = new Set();
  const effect = (fn) => {
    const cleanup = fn();
    if (typeof cleanup === 'function') cleanups.push(cleanup);
    return cleanup;
  };
  const on = (type, handler) => {
    const entry = { type, handler };
    listeners.add(entry);
    return () => listeners.delete(entry);
  };
  const fire = (type, ...args) => {
    for (const entry of [...listeners]) {
      if (entry.type !== type) continue;
      try {
        entry.handler(...args);
      } catch {
        /* isolate a listener like the real bus */
      }
    }
  };

  const services = new Map([
    ['agentDefaultModel', { currentSelection: () => ({ provider: 'fake', model: 'fake-model' }) }],
    ['sessionTitle', { get: () => undefined, rename: (_session, title) => ({ title }) }],
    ['workspaceRegistry', {
      async create(path) { return { id: 'ws-avatar-listening', path }; },
      get() { return { id: 'ws-avatar-listening', async attachSession() {} }; },
    }],
    // Persona → style completion: a real completion, never a provider contact.
    ['llm', {
      stream: () => (async function* styleFrames() {
        yield { type: 'text-delta', text: JSON.stringify({ amplitude: 1.1, tempo: 1.05, gazeHabit: 'wandering' }) };
        yield { type: 'finish', reason: { kind: 'stop' } };
      })(),
    }],
  ]);
  const agents = new Map();
  let persisted = false;
  const makeAgent = (sessionId) => {
    const session = { id: sessionId, header: { cwd: join(root, 'workspace') }, append() {} };
    let turn = 0;
    return {
      id: sessionId,
      session,
      followup(message) {
        turn += 1;
        const turnId = turn;
        const emit = (type, data) => fire('session/event', session, {
          type, seq: turnId, time: Date.now(), data,
        });
        void (async () => {
          emit('turn/start', { turn: turnId });
          emit('user/message', message);
          // An empty committed body keeps this turn speech-free: the state machine, not the TTS
          // lane, is what is under test here.
          emit('assistant/message', {
            turn: turnId,
            step: 1,
            message: { id: `a-${turnId}`, role: 'assistant', content: [] },
          });
          emit('turn/end', { turn: turnId, reason: { kind: 'completed' } });
        })().catch(() => {});
      },
    };
  };
  services.set('agentLoop', {
    async resume(_ownerCtx, options) {
      if (!persisted) throw new Error('not persisted yet');
      const id = options.resumeSessionId;
      if (!agents.has(id)) agents.set(id, makeAgent(id));
      return { agent: agents.get(id) };
    },
    async createAgent(_ownerCtx, options) {
      const agent = makeAgent(options.sessionId);
      agents.set(options.sessionId, agent);
      persisted = true;
      return { agent };
    },
  });

  apply({
    effect,
    on,
    get: (name) => services.get(name),
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    inject: (_deps, registerScope) => registerScope({
      effect,
      on,
      systemPrompt: { section: () => () => {} },
      webServer: {
        register(route) {
          routes.set(route.path, route.handler);
          return () => routes.delete(route.path);
        },
      },
    }),
  }, { root, enabled: true, vtsPort: fake.port, ...config });

  const callRoute = async (path, { method = 'POST', body = undefined } = {}) => {
    const handler = routes.get(path);
    assert.equal(typeof handler, 'function', `route registered: ${path}`);
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
  const waitEvent = async (type, predicate = () => true, timeoutMs = 6000) => {
    let found = null;
    const ok = await waitFor(async () => {
      found = (await events()).find((row) => row.type === type && predicate(row.payload ?? {})) ?? null;
      return found !== null;
    }, timeoutMs);
    assert.equal(ok, true, `timed out waiting for ${type}`);
    return found.payload ?? {};
  };
  const status = () => callRoute('/assistant/status', { method: 'GET' });
  const action = (body) => callRoute('/assistant/action', { body });
  const waitStatus = async (expected, timeoutMs = 6000) => {
    const ok = await waitFor(async () => (await status()).live2d?.runtime?.status === expected, timeoutMs);
    assert.equal(ok, true, `runtime status reaches ${expected} (last: ${(await status()).live2d?.runtime?.status})`);
    return status();
  };
  const dispose = () => {
    for (const cleanup of cleanups.reverse()) {
      try {
        cleanup();
      } catch {
        /* best effort */
      }
    }
  };
  t.after(async () => {
    for (const player of [...state.players]) player.resolve();
    await sleep(20);
    await cleanupRoot(root, cleanups.splice(0));
  });
  return {
    root,
    sessionId: voiceSessionTarget({ root }).sessionId,
    tools,
    status,
    action,
    events,
    waitEvent,
    waitStatus,
    dispose,
    listen: (args = { action: 'start' }) => tools.get('assistant_listen').execute(args),
    say: (args) => tools.get('assistant_say').execute(args),
    feed: (event) => state.onUpdate(event),
    players: () => state.players,
  };
}

async function connectAvatar(host) {
  const connected = await host.action({ action: 'live2d.connect' });
  assert.equal(connected.ok, true, `live2d.connect succeeds (${connected.error ?? ''})`);
  const discovered = await waitFor(async () => (await host.status()).live2d?.capabilities?.discovered === true);
  assert.equal(discovered, true, 'capability discovery settles');
}

// ---------------------------------------------------------------------------------------------
// 1. Runtime creation: a running microphone is not a `listening` seed
// ---------------------------------------------------------------------------------------------

test('1. 创建运行时且 hearing 已运行、无回放/回合 → waiting（不再种 listening）', async (t) => {
  const fake = await createFakeVts();
  const host = await mount(t, fake);
  t.after(() => fake.close());

  const started = await host.listen({ action: 'start' });
  assert.equal(started.ok, true, `microphone starts (${started.error ?? ''})`);
  assert.equal(started.running, true);
  assert.equal(state.hearingStarts, 1);

  // The runtime is created AFTER the microphone is already open — the exact old regression path.
  await connectAvatar(host);
  const status = await host.status();
  assert.equal(status.hearing.running, true, 'hearing is still running');
  assert.equal(status.live2d.runtime.status, 'waiting', 'an open microphone alone seeds waiting');

  const avatarStates = (await host.events()).filter((row) => row.type === 'avatar.state');
  assert.equal(
    avatarStates.some((row) => row.payload?.reason === 'hearing.active'),
    false,
    'no `hearing.active` seed row exists',
  );
  assert.equal(
    avatarStates.some((row) => row.payload?.status === 'listening'),
    false,
    'runtime creation never enters listening',
  );
  console.log(`[1] hearing.running=${status.hearing.running} runtime.status=${status.live2d.runtime.status}`
    + ` stateRows=${avatarStates.length}`);
});

// ---------------------------------------------------------------------------------------------
// 2. hearing.start → waiting; ASR activity → listening; turn → thinking → waiting; fake clock
//    reaches tired and the idle preset draw keeps running
// ---------------------------------------------------------------------------------------------

test('2. hearing.start → waiting；真实回合 thinking → waiting → tired（假时钟）', async (t) => {
  // Only intervals are mocked: the host's 60 s housekeeping and the runtime tick become manually
  // driven, while the test's own waits keep real timers.
  t.mock.timers.enable({ apis: ['setInterval'] });
  const fake = await createFakeVts();
  const host = await mount(t, fake, { config: { avatarTickMs: 400 } });
  t.after(() => fake.close());

  await connectAvatar(host);
  await host.waitStatus('waiting');

  const started = await host.listen({ action: 'start' });
  assert.equal(started.ok, true);
  assert.equal((await host.status()).live2d.runtime.status, 'waiting', 'hearing.start stays waiting');

  // Real ASR activity is the one thing that may claim listening.
  host.feed({ partial: '你' });
  await host.waitStatus('listening');
  const listening = await host.waitEvent('avatar.state', (p) => p.status === 'listening');
  assert.equal(listening.reason, 'hearing.partial');

  // A completed utterance opens a real turn: `voice.request` is the thinking edge.
  host.feed({ final: '你好' });
  const thinking = await host.waitEvent('avatar.state', (p) => p.status === 'thinking', 8000);
  assert.equal(thinking.reason, 'voice.request');
  // The turn completes: the release/turn-end edge returns to waiting (never back to listening).
  const released = await host.waitEvent(
    'avatar.state',
    (p) => p.status === 'waiting' && (p.reason === 'voice.release' || p.reason === 'turn.end'),
    8000,
  );
  assert.equal(released.previous, 'thinking');
  await host.waitStatus('waiting');

  // A fake clock: one real tick establishes `idleSince`, then jump the wall clock past the
  // 10-minute tired threshold and run the mocked 60 s housekeeping tick.
  t.mock.timers.tick(1000);
  const realNow = Date.now;
  Date.now = () => realNow() + 11 * 60_000;
  try {
    t.mock.timers.tick(60_000);
    const tired = await host.waitEvent('avatar.state', (p) => p.status === 'tired', 4000);
    assert.equal(tired.reason, 'idle-timeout');
    assert.equal((await host.status()).live2d.runtime.status, 'tired');
  } finally {
    Date.now = realNow;
  }

  // The autonomous draw keeps sampling the `idle` event for the waiting/tired state.
  const presets = (await host.status()).live2d.runtime.motion.presets;
  assert.ok(presets.decisions > 0, 'the idle preset boundary still decides');
  assert.equal(presets.lastEvent, 'idle', 'the late draws use the idle event');
  console.log(`[2] thinking=${thinking.status} released=${released.status} tired=tired`
    + ` presetDecisions=${presets.decisions} presetEvent=${presets.lastEvent}`);
});

// ---------------------------------------------------------------------------------------------
// 3. Silent listening degrades to waiting; configurable threshold; no fabricated idle
// ---------------------------------------------------------------------------------------------

test('3. listening 静音超时 → waiting（reason=listening-idle，阈值 10s 生效）', async (t) => {
  const fake = await createFakeVts();
  const host = await mount(t, fake, { config: { avatarListeningIdleMs: 10_000 } });
  t.after(() => fake.close());

  await connectAvatar(host);
  await host.waitStatus('waiting');
  assert.equal((await host.listen({ action: 'start' })).ok, true);
  host.feed({ partial: '嗯' });
  await host.waitStatus('listening');
  const startedAt = Date.now();

  // The configured 10 s floor is honoured: no degradation at ~2 s.
  await sleep(2000);
  assert.equal((await host.status()).live2d.runtime.status, 'listening', 'still listening before the threshold');

  const degraded = await host.waitEvent('avatar.state', (p) => p.reason === 'listening-idle', 15_000);
  assert.equal(degraded.status, 'waiting');
  assert.equal(degraded.previous, 'listening');
  assert.ok(Date.now() - startedAt >= 9500, 'the idle deadline is not shorter than the configured floor');

  const final = await host.status();
  assert.equal(final.live2d.runtime.status, 'waiting');
  assert.equal(final.live2d.runtime.wiring.listeningIdle, 1, 'the debug counter records the degradation');

  // Never a fabricated idle: the state machine only moves listening → waiting; `idle` is a
  // preset EVENT derived from waiting/tired, not a host status.
  const states = (await host.events()).filter((row) => row.type === 'avatar.state');
  assert.equal(states.some((row) => row.payload?.status === 'idle'), false, 'no idle state is written');
  assert.equal(
    (await host.events()).some((row) => row.type === 'avatar.listening.idle' && row.payload?.count === 1),
    true,
    'the listening-idle debug row carries the count',
  );
  console.log(`[3] idleMs=${degraded.reason === 'listening-idle' ? '>=10000' : 'n/a'}`
    + ` elapsedMs=${Date.now() - startedAt} status=${final.live2d.runtime.status}`
    + ` counter=${final.live2d.runtime.wiring.listeningIdle} idleStates=0`);
});

// ---------------------------------------------------------------------------------------------
// 4. Playback seeds speaking; the clip end returns to waiting
// ---------------------------------------------------------------------------------------------

test('4. 正在播放时创建运行时 → speaking；播放结束 → waiting', async (t) => {
  const fake = await createFakeVts();
  const host = await mount(t, fake);
  t.after(() => fake.close());

  const accepted = await host.say({ text: '我在想。', purpose: 'explicit' });
  assert.equal(accepted.accepted, true, `the standalone line is accepted (${accepted.reason ?? ''})`);
  assert.equal(await waitFor(() => host.players().length >= 1, 4000), true, 'the clip really reaches the player');

  // The runtime is created while `playback !== null`: it must inherit speaking, not listening.
  await connectAvatar(host);
  const speaking = await host.waitStatus('speaking');
  assert.equal(speaking.live2d.runtime.status, 'speaking');
  const seed = await host.waitEvent('avatar.state', (p) => p.status === 'speaking');
  assert.equal(seed.reason, 'playback.active');

  host.players()[0].resolve();
  const ended = await host.waitEvent('avatar.state', (p) => p.previous === 'speaking', 5000);
  assert.equal(ended.status, 'waiting');
  await host.waitStatus('waiting');
  console.log(`[4] seed=${seed.reason} end=${ended.reason} status=${(await host.status()).live2d.runtime.status}`);
});

// ---------------------------------------------------------------------------------------------
// 5. Preset mapping: waiting/tired use the `idle` event (context + fake-clock autonomous draw)
// ---------------------------------------------------------------------------------------------

test('5. waiting/tired → 预设事件 idle（选择上下文 + 假时钟自动抽取）', async () => {
  const runtime = createBehaviorRuntime({
    config: {
      seed: 7,
      presetExecution: true,
      presetChannels: ['headX'],
      presetDebugEvents: false,
    },
  });
  for (const status of ['waiting', 'tired']) {
    const selection = runtime.selectPreset({ state: status });
    assert.equal(selection.context.state, status);
    assert.equal(selection.context.event, 'idle', `${status} samples the idle preset event`);
  }

  // Fake clock: the autonomous boundary runs on ticks, not on wall time.
  runtime.setStatus('waiting', { reason: 'avatar-listening-test' });
  for (let at = 0; at <= 60_000; at += 33) runtime.tick(at);
  const debug = runtime.snapshot().motion.presets.debug;
  assert.ok(debug.decisions > 0, 'an idle decision happened inside the fake minute');
  assert.equal(debug.lastEvent, 'idle', 'the autonomous draw sampled the idle event');
  console.log(`[5] waitingEvent=idle tiredEvent=idle autonomousDecisions=${debug.decisions}`
    + ` autonomousEvent=${debug.lastEvent}`);
});
