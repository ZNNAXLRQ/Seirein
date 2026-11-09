/**
 * P-139 stage 2 P1 (G4) — voice-turn identity: a normal next turn in the SAME voice reply must
 * not be a 0 ms hard cut.
 *
 * The audit found that a voice final reports its pre-turn phase with the PREVIOUS turn id (the
 * Harness `turn/start` for the new turn has not happened yet). When that real turn id arrived, the
 * runtime treated it as a turn/session switch and hard-cleared the listening/thinking gesture:
 * `interrupt:true`, a bumped motion epoch, and an `interrupted` action end. That is a fake switch,
 * not a user interruption.
 *
 * Contract pinned here:
 *   1. runtime: same session + host-marked same reply + no interrupt => the running gesture keeps
 *      running (same actionId), only the intent generation advances and identity fields update;
 *   2. a different session is still an immediate hard stop (interrupted end + epoch bump);
 *   3. after a real `interrupt()` (barge-in), a same-reply continuation claim is refused and stays
 *      hard — the interruption is never softened or revived;
 *   4. a model-switch/privacy lock still stops the old action immediately;
 *   5. host: the voice final's claim is recognized by the later Harness `turn/start` in the same
 *      session (`avatar.intent.turn mode:continued`), while an unclaimed typed turn stays hard.
 *
 * Run: node --test test/avatar-turn-continuity.mjs
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { registerHooks } from 'node:module';
import { Readable } from 'node:stream';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The runtime is imported under its own query URL: a plain-URL import here would populate Node's
// module cache before the host hook below can replace the plain URL for `index.js`.
import { createAvatarRuntime } from '../src/host/avatar/avatarRuntime.js?turn-continuity-real';

// =============================================================================================
// Runtime rig: fake clock + fake transport (the shape used by `motion-intent`)
// =============================================================================================
const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve));

const HEAD_ROWS = ['headX', 'headY', 'headZ', 'gazeX', 'gazeY']
  .map((channel) => ({ channel, inputName: `P_${channel}`, injectable: true, verified: true }));

function createRig({ presetExecution = false } = {}) {
  let clock = 0;
  const writes = [];
  const transport = {
    connect: async () => {},
    disconnect: async () => {},
    write: async () => ({ ok: true }),
    writeFrame: async (entries) => { writes.push({ at: clock, entries }); return { ok: true }; },
    writeMotion: async (payload) => { writes.push({ at: clock, entries: payload.entries }); return { ok: true }; },
  };
  const runtime = createAvatarRuntime({
    transport,
    now: () => clock,
    config: {
      autoTickMs: 0,
      flushIntervalMs: 1,
      idleActions: [],
      idleSwayScale: 0,
      motionWrites: false,
      presetExecution,
      intentTable: { 'turn-start': 'nod', 'user-speaking': 'nod', thinking: 'tilt' },
    },
  });
  return {
    runtime,
    writes,
    setClock(at) { clock = at; },
    tick(at) { clock = at; return runtime.tick(at); },
  };
}

async function connect(rig) {
  assert.equal((await rig.runtime.connect()).ok, true, 'runtime connects');
  const mapped = await rig.runtime.setChannelMappings(HEAD_ROWS, { channelMap: {} });
  assert.equal(mapped.ok, true, 'head channels verified');
  rig.runtime.setStatus('waiting', 'turn-continuity-test');
  rig.runtime.takeEvents();
}

/** Start the reply's pre-turn gesture; the runtime has no clip session, so it starts immediately. */
const startPreTurnGesture = (rig, at = 0) => {
  rig.setClock(at);
  return rig.runtime.intentEvent('turn-start', {
    at, sessionId: 1, turnId: 1, replyId: 1,
  });
};

// =============================================================================================
// 1. Same session + same reply: generation advances, identity updates, action keeps running.
// =============================================================================================
test('1. 同一 session/同一 reply 的 turn 变化：动作不被 0ms 硬切，身份前移', async () => {
  const rig = createRig();
  await connect(rig);
  const first = startPreTurnGesture(rig, 0);
  assert.equal(first.released, true, 'the pre-turn gesture started');
  // Drop the initial session-establishment event: the assertion below is about the turn 1 -> 2
  // claim itself.
  rig.runtime.takeEvents();
  const before = rig.runtime.snapshot();
  const action = before.actions.current;
  assert.ok(action !== null, 'an action is running before the real turn id arrives');
  const actionId = action.actionId;

  rig.setClock(200);
  const switched = rig.runtime.intentEvent('thinking', {
    at: 200, sessionId: 1, turnId: 2, replyId: 1, continuation: true,
  });
  assert.equal(switched.staged, true, 'the new turn phase is admitted');
  const after = rig.runtime.snapshot();

  assert.equal(after.intentEvents.sessionId, before.intentEvents.sessionId, 'the session did not change');
  assert.equal(after.intentEvents.turnId, 2, 'the real turn id is now tracked');
  assert.equal(after.intentEvents.replyId, 1, 'the reply identity is preserved');
  assert.equal(after.intentEvents.generation, before.intentEvents.generation + 1,
    'the intent generation advances once for the claim');
  assert.equal(after.actions.current?.actionId, actionId,
    'the running gesture is the reply\'s own gesture and is NOT hard-cleared');
  assert.equal(after.actions.interrupted, before.actions.interrupted,
    'no interrupted action end was recorded');
  assert.equal(after.motion.epoch, before.motion.epoch,
    'the output epoch was not bumped (no hard clear / no old-frame drop)');
  assert.equal(after.intentEvents.settled, before.intentEvents.settled,
    'a turn claim never settles/relaxes the pose');

  const events = rig.runtime.takeEvents();
  const turns = events.filter((event) => event.type === 'avatar.intent.turn');
  assert.equal(turns.length, 1, 'the switch is recorded exactly once');
  assert.equal(turns[0].mode, 'continued', 'the record says same-reply continuation');
  assert.equal(turns[0].fromTurn, 1);
  assert.equal(turns[0].turnId, 2);
  assert.equal(turns[0].actionId, actionId, 'the kept action is named');
  const cuts = events.filter((event) => event.type === 'avatar.action.interrupted');
  assert.deepEqual(cuts, [], 'no action was interrupted by the normal turn boundary');
  const ends = events.filter((event) => event.type === 'avatar.action.end'
    && event.actionId === actionId);
  assert.deepEqual(ends, [], 'the old action did not end at the boundary');
  console.log(`[continuity] action=${actionId} turn=1->2 generation=${before.intentEvents.generation}`
    + `->${after.intentEvents.generation} interrupted=${after.actions.interrupted} epoch=${after.motion.epoch}`);
  rig.runtime.dispose();
});

// =============================================================================================
// 2. Different session: the historical immediate hard stop is unchanged.
// =============================================================================================
test('2. 不同 session 仍是真实 turn-switch：旧动作立即 interrupted，epoch 前移', async () => {
  const rig = createRig();
  await connect(rig);
  startPreTurnGesture(rig, 0);
  rig.runtime.takeEvents();
  const before = rig.runtime.snapshot();
  const actionId = before.actions.current?.actionId;
  assert.equal(typeof actionId, 'number', 'an action is running');

  rig.setClock(200);
  rig.runtime.intentEvent('thinking', {
    at: 200, sessionId: 2, turnId: 1, replyId: 2, continuation: false,
  });
  const after = rig.runtime.snapshot();
  assert.equal(after.intentEvents.sessionId, 2, 'the session really changed');
  assert.equal(after.actions.interrupted, before.actions.interrupted + 1,
    'the old action ended as interrupted');
  assert.ok(after.motion.epoch > before.motion.epoch, 'the output epoch was bumped (hard clear)');
  assert.notEqual(after.actions.current?.actionId, actionId, 'the old action is gone');

  const events = rig.runtime.takeEvents();
  assert.equal(events.find((event) => event.type === 'avatar.intent.turn')?.mode, 'hard');
  const cut = events.find((event) => event.type === 'avatar.action.interrupted');
  assert.ok(cut !== undefined, 'the interruption is recorded');
  assert.equal(cut.by, 'turn-switch');
  console.log(`[hard-session] action=${actionId} epoch=${before.motion.epoch}->${after.motion.epoch}`
    + ` interrupted=${after.actions.interrupted}`);
  rig.runtime.dispose();
});

// =============================================================================================
// 3. A real barge-in is never softened: the next continuation claim is refused.
// =============================================================================================
test('3. barge-in 之后的 continuation 仍硬清，旧动作不复活', async () => {
  const rig = createRig();
  await connect(rig);
  startPreTurnGesture(rig, 0);
  rig.runtime.takeEvents();
  const before = rig.runtime.snapshot();
  const actionId = before.actions.current?.actionId;
  assert.equal(typeof actionId, 'number', 'an action is running');

  rig.setClock(200);
  const cut = rig.runtime.interrupt({ reason: 'barge-in' });
  assert.equal(cut.interruptedAction, true, 'the barge-in cut the running action');
  assert.equal(rig.runtime.snapshot().actions.current, null, 'nothing is running after the barge-in');

  // The same utterance's turn/start still arrives; the host claim may even look continuous, but
  // the runtime must keep the real interruption hard.
  rig.setClock(220);
  rig.runtime.intentEvent('thinking', {
    at: 220, sessionId: 1, turnId: 2, replyId: 1, continuation: true,
  });
  const after = rig.runtime.snapshot();
  const events = rig.runtime.takeEvents();
  const turn = events.find((event) => event.type === 'avatar.intent.turn');
  assert.equal(turn?.mode, 'hard', 'the runtime refuses the same-reply continuation after a barge-in');
  assert.equal(after.actions.interrupted, before.actions.interrupted + 1,
    'the barge-in is still counted as the one real interruption');
  assert.notEqual(after.actions.current?.actionId, actionId, 'the old action never revives');
  const revival = events.filter((event) => event.actionId === actionId
    && (event.type === 'avatar.action.start' || event.type === 'avatar.preset.action'));
  assert.deepEqual(revival, [], 'the interrupted action id never starts again');
  console.log(`[barge-in] action=${actionId} mode=${turn?.mode} interrupted=${after.actions.interrupted}`
    + ` revived=0`);
  rig.runtime.dispose();
});

// =============================================================================================
// 4. Model switch / privacy lock: immediate stop, no continuation exception.
// =============================================================================================
test('4. 模型切换/隐私锁仍立即停：动作结束、epoch 前移、运动门关闭', async () => {
  const rig = createRig();
  await connect(rig);
  startPreTurnGesture(rig, 0);
  const before = rig.runtime.snapshot();
  const actionId = before.actions.current?.actionId;
  assert.equal(typeof actionId, 'number', 'an action is running');

  rig.setClock(200);
  rig.runtime.lock('model-changed');
  const after = rig.runtime.snapshot();
  assert.equal(after.actions.current, null, 'the old action is stopped immediately');
  assert.equal(after.motion.locked, true, 'the motion gate is closed');
  assert.ok(after.motion.epoch > before.motion.epoch, 'old frames are invalidated by the epoch bump');
  const events = rig.runtime.takeEvents();
  const end = events.find((event) => event.type === 'avatar.action.end'
    && event.actionId === actionId);
  assert.ok(end !== undefined, 'the old action has an explicit end');
  assert.equal(end.interrupted, false, 'a model switch is not a user interruption');
  const interrupted = events.filter((event) => event.type === 'avatar.action.interrupted');
  assert.deepEqual(interrupted, [], 'no barge-in interruption is invented');
  console.log(`[model-switch] action=${actionId} ended=true epoch=${before.motion.epoch}`
    + `->${after.motion.epoch} locked=true`);
  rig.runtime.dispose();
});

// =============================================================================================
// Host mount: fake VTS / hearing / TTS, real `apply`. Proves the voice-final claim is wired to
// the same session's Harness turn/start, and an unclaimed typed turn stays hard.
// =============================================================================================
const hostState = {
  onUpdate: null,
  players: [],
  synthCalls: [],
};
globalThis.__avatarTurnContinuity = hostState;

const ttsUrl = new URL('../src/host/speech/tts.js', import.meta.url).href;
const sightUrl = new URL('../src/host/vision/sight.js', import.meta.url).href;
const subtitleUrl = new URL('../src/host/subtitle/subtitle.js', import.meta.url).href;
const vtsUrl = new URL('../src/host/avatar/vts.js', import.meta.url).href;
const hearingUrl = new URL('../src/host/hearing/hearing.js', import.meta.url).href;
const avatarRuntimeUrl = new URL('../src/host/avatar/avatarRuntime.js', import.meta.url).href;

const hooks = registerHooks({
  load(url, context, next) {
    if (url === hearingUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
    const s = globalThis.__avatarTurnContinuity;
    export const modelReady = () => true;
    export const finalModelReady = () => false;
    export const isLoopbackDevice = () => false;
    export const selectMicrophoneDevice = (devices) => ({ device: devices[0] ?? '', reason: '' });
    export const listDevices = async () => ['Fake Mic'];
    export const startHearing = (options) => {
      s.onUpdate = options.onUpdate;
      return { device: options.device, stop() {}, stats: () => ({ rmsDb: -30, peakDb: -20 }) };
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
    const s = globalThis.__avatarTurnContinuity;
    export { resolveGptLangs, resolveGptSovitsTimeout } from '${ttsUrl}?turn-continuity-helpers';
    export { speakChunks, speechChunkTexts, resolveChunkMinChars } from '${ttsUrl}?turn-continuity-chunk';
    export const configureTts = () => {};
    export const gptSovitsReferenceStatus = async () => ({ seconds: null, ok: false, readable: false });
    export const warmupGptSovits = async () => ({ ok: false, skipped: 'disabled' });
    export const applyGptSovitsModels = () => ({ ok: true });
    // No notice playback in this suite: the failed voice delivery's whole-line fallback is not
    // the subject here and must not start a second action/clip.
    export const synthesize = async (options) => {
      s.synthCalls.push({ text: String(options?.text ?? ''), purpose: String(options?.purpose ?? '') });
      throw new Error('no synthesis in turn-continuity');
    };
    export const speakStreaming = async () => { throw new Error('streaming not expected'); };
    export const play = () => { throw new Error('no playback in turn-continuity'); };
    export const stopPlayback = () => true;
    export const stopTts = () => true;`,
      };
    }
    if (url === sightUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
    const forbidden = () => { throw new Error('real capture forbidden'); };
    export const resolveFfmpeg = () => 'ffmpeg-fake';
    export const resolveFfplay = () => null;
    export const capture = forbidden, captureDesktop = forbidden, captureDevice = forbidden, startStoryboard = forbidden;
    export const OBSERVATION_TTL_MS = 30000;
    export function readObservation(o, { now = Date.now(), ttlMs = 30000 } = {}) {
      const v = o ?? {}; const c = Number(v.capturedAt); const at = Number.isFinite(c) && c > 0 ? c : null;
      const ageMs = at === null ? null : Math.max(0, now - at);
      return { ...v, at, ageMs, stale: ageMs === null || ageMs >= ttlMs, hint: '' };
    }`,
      };
    }
    if (url === subtitleUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
    export const averageColor = async () => null;
    export class SubtitleOverlay { async show() { return true; } async hide() {} async stop() {} }`,
      };
    }
    if (url === vtsUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
    export class VtsClient {
      constructor() {
        this.ready = false; this.connected = false; this.model = null; this.modelId = '';
        this.hotkeys = []; this.expressions = []; this.animations = { current: null }; this.writes = [];
      }
      async connect() {
        this.ready = true; this.connected = true; this.model = { modelName: 'FakeContinuity' }; this.modelId = 'fake';
        return { ok: true, model: this.model, modelId: 'fake', hotkeys: [] };
      }
      async listInputParameters() {
        return { ok: true, defaultParameters: [
          { name: 'FaceAngleX', min: -30, max: 30, defaultValue: 0 },
          { name: 'FaceAngleY', min: -30, max: 30, defaultValue: 0 },
          { name: 'FaceAngleZ', min: -30, max: 30, defaultValue: 0 },
          { name: 'MouthOpen', min: 0, max: 1, defaultValue: 0 }], customParameters: [] };
      }
      async listModelParameters() {
        return { ok: true, parameters: [
          { name: 'ParamAngleX' }, { name: 'ParamAngleY' }, { name: 'ParamAngleZ' }, { name: 'ParamMouthOpenY' }] };
      }
      async injectInputs(entries) { this.writes.push(entries); return { ok: true, sent: true, acknowledged: true, rejected: [] }; }
      async triggerHotkey() { return 'fake-hotkey'; }
      async triggerExpression() { return 'fake-expression'; }
      moveModel() {}
      setChannelInputs() {}
      close() { this.ready = false; this.connected = false; }
      authStatus() {
        return {
          state: this.ready ? 'ready' : 'disconnected', authenticated: this.ready === true,
          needsAuth: false, authError: '', lastAuthAt: 0, lastAuthSuccessAt: 0,
          retryable: this.ready !== true, authorizePending: false, authorizeRequests: 0,
          freshTokenRejected: false,
        };
      }
    }`,
      };
    }
    if (url === avatarRuntimeUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
    import * as real from '${avatarRuntimeUrl}?turn-continuity-host-real';
    export const AVATAR_ERROR_CODES = real.AVATAR_ERROR_CODES;
    export const buildAvatarStylePrompt = real.buildAvatarStylePrompt;
    export const createAvatarStyleCache = real.createAvatarStyleCache;
    export const DEFAULT_AVATAR_STYLE = real.DEFAULT_AVATAR_STYLE;
    export const personaStyleVersion = real.personaStyleVersion;
    export function createAvatarRuntime(options) {
      const runtime = real.createAvatarRuntime(options);
      globalThis.__avatarTurnContinuity.runtime = runtime;
      return runtime;
    }`,
      };
    }
    if (url === 'node:child_process') {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
    export const spawn = () => { throw new Error('real process forbidden'); };
    export const execFile = () => { throw new Error('real process forbidden'); };`,
      };
    }
    return next(url, context);
  },
});
const hostModule = await import('../src/host/index.js');
const { apply, voiceSessionTarget } = hostModule;
hooks.deregister();
after(() => { delete globalThis.__avatarTurnContinuity; });

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const waitUntil = async (check, label, timeoutMs = 8000) => {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out: ${label}`);
    await tick(10);
  }
};

const turnStart = (turn) => ({ type: 'turn/start', data: { turn } });
const turnEnd = (turn) => ({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } });

async function mountHost(t) {
  const root = await mkdtemp(join(tmpdir(), 'avatar-turn-continuity-'));
  await mkdir(join(root, 'data'), { recursive: true });
  await mkdir(join(root, 'workspace'), { recursive: true });
  await writeFile(join(root, 'data', 'features.json'), JSON.stringify({
    hearing: true, ambient: false, voice: true, avatar: true, subtitle: false, memory: false, fastpath: false,
  }));
  await writeFile(join(root, 'data', 'settings.json'), JSON.stringify({
    gptSovits: { enabled: false },
    langs: { speech: 'zh', subtitle: 'zh' },
    typedReply: { voice: true },
    voice: { chunking: true, ackDelayMs: 60000 },
  }));
  hostState.onUpdate = null;
  hostState.players = [];
  hostState.synthCalls = [];
  hostState.runtime = null;

  const handlers = [];
  const cleanups = [];
  const tools = new Map();
  const routes = new Map();
  const effect = (fn) => { const cleanup = fn(); if (typeof cleanup === 'function') cleanups.push(cleanup); return cleanup; };
  const on = (type, handler) => {
    const entry = { type, handler };
    handlers.push(entry);
    return () => { const index = handlers.indexOf(entry); if (index >= 0) handlers.splice(index, 1); };
  };
  const registerRoute = (route) => { routes.set(route.path, route.handler); return () => routes.delete(route.path); };
  const scope = { effect, on, systemPrompt: { section: () => () => {} }, webServer: { register: registerRoute } };
  apply({
    effect,
    on,
    get: () => undefined,
    tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name); } },
    inject: (_deps, register) => register(scope),
    webServer: { register: registerRoute },
  }, { root, enabled: true, asrMergeWindowMs: 40 });

  const sessionId = voiceSessionTarget({ root, rolloverHour: 4 }).sessionId;
  const session = { id: sessionId, header: { cwd: join(root, 'workspace') } };
  const emit = (event) => {
    for (const entry of [...handlers]) if (entry.type === 'session/event') entry.handler(session, event);
  };
  const callRoute = async (path, { method = 'POST', body = undefined } = {}) => {
    const handler = routes.get(path);
    assert.equal(typeof handler, 'function', `the ${path} route is registered`);
    let result;
    await handler(
      Object.assign(Readable.from([JSON.stringify(body ?? {})]), { method, url: path }),
      { writeHead() {}, end(value) { result = value; } },
    );
    return typeof result === 'string' ? JSON.parse(result) : result;
  };
  const status = () => callRoute('/assistant/status', { method: 'GET' });
  const runtime = async () => (await status()).live2d.runtime;
  const events = async () => {
    try {
      const text = await readFile(join(root, 'data', 'events.jsonl'), 'utf8');
      return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    } catch { return []; }
  };
  const waitForEvent = async (type, predicate = () => true, timeoutMs = 8000) => {
    const row = await waitUntil(
      async () => (await events()).find((event) => event.type === type && predicate(event.payload ?? {})),
      `event ${type}`,
      timeoutMs,
    );
    return row.payload ?? {};
  };

  t.after(async () => {
    for (const cleanup of cleanups.reverse()) {
      try { const value = cleanup(); if (value && typeof value.catch === 'function') value.catch(() => {}); } catch { /* best effort */ }
    }
    await tick(200);
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const connected = await callRoute('/assistant/action', { body: { action: 'live2d.connect' } });
  assert.equal(connected.ok, true, `live2d.connect succeeds (${connected.error ?? ''})`);
  await waitUntil(async () => {
    const controlled = (await runtime())?.channels?.controlled ?? [];
    return controlled.includes('headY') || controlled.includes('headZ') || controlled.includes('headX');
  }, 'the runtime verified the head channels');

  const listen = tools.get('assistant_listen');
  assert.ok(listen !== undefined, 'assistant_listen is registered');
  const started = await listen.execute({ action: 'start' });
  assert.equal(started.ok, true, `hearing starts (${started.error ?? ''})`);
  assert.equal(typeof hostState.onUpdate, 'function', 'the hearing session exposes onUpdate');

  return {
    root, sessionId, emit, status, runtime, events, waitForEvent,
    final: (text) => hostState.onUpdate({ final: text, durationMs: 320 }),
  };
}

// =============================================================================================
// 5. Host wiring: voice final claim + same-session turn/start = continued; unclaimed = hard.
// =============================================================================================
test('5. 宿主：语音终稿的 claim 被同一 session 的 turn/start 认领为 continued，未认领的 typed turn 仍 hard', async (t) => {
  const app = await mountHost(t);
  // Seed the previous Harness turn, so the voice final's pre-turn phase carries turn 1.
  app.emit(turnStart(1));
  app.emit(turnEnd(1));
  const traceBefore = (await app.runtime()).motion.actionTrace.length;
  const interruptedBefore = (await app.events())
    .filter((event) => event.type === 'avatar.action.interrupted').length;

  // The verified voice final reports its pre-turn phase with the PREVIOUS turn id (1). This is the
  // exact condition the audit says used to manufacture a fake switch.
  app.final('先讲一句');
  await waitUntil(async () => (await app.runtime()).intentEvents.calls['turn-start'] >= 1,
    'the voice final reported turn-start');
  const pre = await app.runtime();
  assert.equal(pre.intentEvents.turnId, 1, 'the pre-turn phase still carries the previous turn id');

  // The real Harness turn/start for the SAME voice session arrives.
  app.emit(turnStart(2));
  await waitUntil(async () => (await app.runtime()).intentEvents.turnId === 2,
    'the real turn id was claimed');
  const after = await app.runtime();
  assert.equal(after.intentEvents.generation, pre.intentEvents.generation + 1,
    'the claim advanced the intent generation once');
  assert.equal(after.motion.epoch, pre.motion.epoch, 'the claim did not hard-clear the output epoch');
  assert.equal(after.motion.actionTrace.length, traceBefore,
    'no action ended at the turn claim (the running gesture was kept)');
  const interruptedAfter = (await app.events())
    .filter((event) => event.type === 'avatar.action.interrupted').length;
  assert.equal(interruptedAfter, interruptedBefore,
    'the pre-turn gesture was not interrupted by its own turn/start');

  const turnRow = await app.waitForEvent('avatar.intent.turn', (payload) => payload.turnId === 2);
  assert.equal(turnRow.mode, 'continued', 'the host claim was recognized as one reply');
  assert.equal(turnRow.turnId, 2);
  assert.equal(turnRow.previousReplyId >= 1, true, 'the voice final opened a reply identity');
  assert.equal(turnRow.previousReplyId, turnRow.replyId, 'the same reply id crossed the boundary');
  assert.notEqual(turnRow.actionId, null, 'the kept pre-turn action is named in the record');

  // A typed turn/start has no voice claim: the historical hard switch is unchanged.
  app.emit(turnStart(3));
  const typedRow = await app.waitForEvent('avatar.intent.turn', (payload) => payload.turnId === 3);
  assert.equal(typedRow.mode, 'hard', 'an unclaimed turn is still a hard switch');
  console.log(`[host] preTurn=${pre.intentEvents.turnId} reply=${turnRow.replyId}`
    + ` voice=${turnRow.mode}/action:${turnRow.actionId} typed=${typedRow.mode}`
    + ` traces=${traceBefore}->${after.motion.actionTrace.length}`);
});
