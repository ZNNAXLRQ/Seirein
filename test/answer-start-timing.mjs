/**
 * answer-start timing — the first body block's real playback start is the ONE boundary that may
 * start the opening gesture.
 *
 * The order used to be `avatarStatus('speaking')` → `avatarClip('start')` → `avatarIntent
 * ('answer-start')`. The clip-start release therefore ran BEFORE the answer-start was staged, and
 * the head-window fallback only worked while no other action owned the slot. With a pre-answer
 * gesture still running (or the clip index already served by a waiting line) the intent stayed
 * pending until `speechEnd`; `markEnded` had already moved the status to `waiting` by then, so the
 * preset selector saw `state:waiting` while every answer-start recipe is `states=speaking` and
 * returned `no-candidate`. The gesture was never played.
 *
 * Contract pinned here:
 *   1. the intent is staged before the boundary and released BY the first body clip start;
 *   2. a bare clip start (the waiting line / any other clip) never starts it; synthesis and
 *      queueing never run it;
 *   3. cancelled / expired / missed → ONE `avatar.intent.dropped {intent:'answer-start', reason}`
 *      row and no later execution; speechEnd never makes up a missed answer-start;
 *   4. exactly one answer-start per answer, later blocks/sentences never re-trigger it;
 *   5. the recipe state stays `speaking` (the constraint is not relaxed).
 *
 * Run: node --test test/answer-start-timing.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
import { Readable } from 'node:stream';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAvatarRuntime } from '../src/host/avatar/avatarRuntime.js';

// ---------------------------------------------------------------------------------------------
// Runtime harness (fake clock + fake transport, the one used by `motion-intent`)
// ---------------------------------------------------------------------------------------------
const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve));

function createFakeTransport() {
  const writes = [];
  return {
    writes,
    transport: {
      connect: async () => {},
      disconnect: async () => {},
      write: async ({ input, value }) => { writes.push({ input, value }); return { ok: true }; },
      writeFrame: async (entries) => { writes.push(...entries); return { ok: true }; },
      writeMotion: async () => ({ ok: true }),
    },
  };
}

const HEAD_ROWS = ['headX', 'headY', 'headZ', 'gazeX', 'gazeY', 'browL', 'browR', 'eyeOpenL', 'eyeOpenR']
  .map((channel) => ({ channel, inputName: `P_${channel}`, injectable: true, verified: true }));

const runtimeConfig = (extra = {}) => ({
  autoTickMs: 0,
  flushIntervalMs: 1,
  idleActions: [],
  idleSwayScale: 0,
  motionWrites: true,
  motionOutputHz: 30,
  presetExecution: true,
  ...extra,
});

async function makeRuntime({ clock = { at: 0 }, config = runtimeConfig() } = {}) {
  const fake = createFakeTransport();
  const runtime = createAvatarRuntime({ transport: fake.transport, now: () => clock.at, config });
  const connected = await runtime.connect();
  assert.equal(connected.ok, true, `runtime connects (${connected.message ?? ''})`);
  await runtime.setChannelMappings(HEAD_ROWS, { channelMap: {} });
  runtime.takeEvents();
  return { runtime, fake, clock };
}

const ofType = (events, type) => events.filter((event) => event.type === type);
const answerStartEvents = (events, type) => ofType(events, type)
  .filter((event) => event.event === 'answer-start' || event.intent === 'answer-start');

/** Drive the scheduler so a started action really ends (clock + one microtask flush per step). */
async function runUntilIdle(runtime, clock, { from = clock.at, to = from + 6000, stepMs = 20 } = {}) {
  for (let at = from; at <= to; at += stepMs) {
    clock.at = at;
    runtime.tick(at);
    await flushMicrotasks();
    if (runtime.snapshot().actions.current === null && at > from) return at;
  }
  return clock.at;
}

// =============================================================================================
// 1. The order itself: a registration after the boundary misses the only release point, and
//    speechEnd must never make it up under the changed status.
// =============================================================================================
test('1. 事件顺序：边界之后登记的意图错过释放点，speechEnd 不得在 waiting 状态下补做', async () => {
  const { runtime, clock } = await makeRuntime({
    config: runtimeConfig({ presetExecution: false, intentTable: { thinking: 'tilt', 'answer-start': 'nod' } }),
  });

  // The pre-answer gesture is already running when the first body clip starts (thinking → tilt).
  clock.at = 0;
  runtime.setStatus('thinking', 'voice.request');
  const thinking = runtime.intentEvent('thinking', { at: 0 });
  assert.equal(thinking.released, true, 'the thinking gesture starts before the clip');
  assert.ok(runtime.snapshot().actions.current !== null, 'the pre-answer gesture owns the slot');
  await runUntilIdle(runtime, clock, { from: 0, to: 120, stepMs: 20 });
  assert.ok(runtime.snapshot().actions.current !== null, 'the action is long enough to still run');
  // From here the answer-start release path is the preset executor (the field configuration).
  runtime.setPresetExecution(true);

  // The OLD host order: clip start first, then stage answer-start (no boundary flag).
  clock.at = 300;
  runtime.setStatus('speaking', 'playback.start');
  runtime.speechClip('start', { index: 0, at: clock.at });
  const legacy = runtime.intentEvent('answer-start', { at: clock.at });
  assert.equal(legacy.staged, true, 'the intent was admitted');
  assert.equal(legacy.released, false, 'the busy action defers it — it missed the clip-start release');
  assert.equal(runtime.snapshot().intentEvents.pending.event, 'answer-start', 'it waits in the one slot');

  // The answer is a single sentence: the host ends it, moving the status to `waiting` first.
  await runUntilIdle(runtime, clock);
  clock.at += 100;
  runtime.setStatus('waiting', 'playback.end');
  runtime.speechClip('end', { index: 0, at: clock.at });
  runtime.speechEnd({ at: clock.at });

  const events = runtime.takeEvents();
  const holds = answerStartEvents(events, 'avatar.preset.hold');
  const actions = ofType(events, 'avatar.action.start')
    .filter((entry) => entry.actionId === legacy.actionId);
  const dropped = answerStartEvents(events, 'avatar.intent.dropped');

  // The fixed path: the missed intent is dropped at speech end (expired), never executed there.
  assert.equal(holds.some((entry) => (entry.trace ?? []).includes('state:waiting')), false,
    'no answer-start draw happens after the status left speaking');
  assert.equal(actions.length, 0, 'a missed answer-start never becomes an action at speech end');
  assert.equal(dropped.length, 1, 'exactly one dropped row explains the missed intent');
  assert.equal(dropped[0].reason, 'expired', 'speech end expires the missed intent');
  // Pre-fix this used to happen: the intent was released by speechEnd in state=waiting and the
  // selector held with no candidate because every answer-start recipe is states=speaking.
  console.log(`[order] ticket=${legacy.actionId} released=${legacy.released} `
    + `holds=${holds.length} actions=${actions.length} dropped=${dropped.map((entry) => entry.reason).join(',')}`);
  runtime.dispose();
});

// =============================================================================================
// 2. Staged before the boundary, released by the first body clip start — once.
// =============================================================================================
test('2. 第一段正文真实播放开始：暂存后由该边界释放一次；裸 clip start 不触发', async () => {
  const { runtime, clock } = await makeRuntime({
    config: runtimeConfig({ presetExecution: false, intentTable: { 'answer-start': 'nod' } }),
  });
  runtime.setStatus('speaking', 'playback.start');
  const staged = runtime.intentEvent('answer-start', { at: 0, holdForClipStart: true });
  assert.equal(staged.staged, true, 'the opening intent is admitted before playback');
  assert.equal(staged.released, false, 'staging is not execution: nothing runs during preparation');
  assert.equal(runtime.snapshot().actions.current, null, 'no action runs before the real start');

  runtime.speechClip('start', { index: 0, at: 0 });
  const snap = runtime.snapshot();
  assert.equal(snap.intentEvents.pending, null, 'the clip start released the staged intent');
  assert.equal(snap.actions.current?.event, 'answer-start', 'the action really started');
  assert.equal(snap.intentEvents.started, 1, 'exactly one release');

  // Later blocks of the same sentence/session never re-stage or re-trigger it.
  clock.at = 800;
  runtime.speechClip('end', { index: 0, at: 800 });
  runtime.speechClip('start', { index: 1, at: 900 });
  for (let at = 900; at <= 1600; at += 20) {
    clock.at = at;
    runtime.tick(at);
    await flushMicrotasks();
  }
  runtime.speechClip('end', { index: 1, at: 1600 });
  runtime.speechEnd({ at: 1600 });
  const after = runtime.snapshot();
  assert.equal(after.intentEvents.staged, 1, 'the same answer never staged a second opening intent');
  assert.equal(after.intentEvents.started, 1, 'the same answer never started a second opening intent');
  const starts = ofType(runtime.takeEvents(), 'avatar.action.start')
    .filter((entry) => entry.actionId === staged.actionId);
  assert.equal(starts.length, 1, `one answer-start action (${starts.length})`);

  // A bare clip start (the waiting line / any other clip) starts nothing on its own.
  const bare = await makeRuntime({
    config: runtimeConfig({ presetExecution: false, intentTable: { 'answer-start': 'nod' } }),
  });
  bare.runtime.setStatus('speaking', 'playback.start');
  bare.runtime.speechClip('start', { index: 0, at: 0 });
  const bareEvents = bare.runtime.takeEvents();
  assert.equal(ofType(bareEvents, 'avatar.action.start').length, 0,
    'no action starts from a bare clip start (the waiting line never triggers the opening gesture)');
  console.log(`[once] staged=1 started=1 starts=${starts.length} bareStarts=0`);
  runtime.dispose();
  bare.runtime.dispose();
});

// =============================================================================================
// 3. Busy boundary = missed (drop, never defer); cancelled/expired drops are explicit.
// =============================================================================================
test('3. 错过/取消/过期：边界释放失败即 dropped，不延迟到 speechEnd 补做', async () => {
  const seen = [];
  // (a) A busy boundary: staged before the clip start, but a pre-answer action owns the slot.
  {
    const { runtime, clock } = await makeRuntime({
      config: runtimeConfig({ presetExecution: false, intentTable: { thinking: 'tilt', 'answer-start': 'nod' } }),
    });
    runtime.setStatus('thinking', 'voice.request');
    runtime.intentEvent('thinking', { at: 0 });
    assert.ok(runtime.snapshot().actions.current !== null, 'the rival action is running');
    runtime.setStatus('speaking', 'playback.start');
    const staged = runtime.intentEvent('answer-start', { at: 100, holdForClipStart: true });
    clock.at = 100;
    runtime.speechClip('start', { index: 0, at: 100 });
    const snap = runtime.snapshot();
    assert.equal(snap.intentEvents.pending, null, 'a busy boundary never leaves the intent pending');
    const dropped = answerStartEvents(runtime.takeEvents(), 'avatar.intent.dropped');
    assert.equal(dropped.length, 1, 'the missed boundary is reported');
    assert.equal(dropped[0].intent, 'answer-start', 'the row names the phase');
    assert.equal(dropped[0].reason, 'missed', 'a busy boundary is a miss, not a deferral');
    seen.push(`missed@${dropped[0].at}`);
    await runUntilIdle(runtime, clock);
    runtime.setStatus('waiting', 'playback.end');
    runtime.speechClip('end', { index: 0, at: clock.at });
    runtime.speechEnd({ at: clock.at });
    assert.equal(ofType(runtime.takeEvents(), 'avatar.action.start')
      .filter((entry) => entry.actionId === staged.actionId).length, 0,
    'the missed answer-start is never played at speech end');
    runtime.dispose();
  }

  // (b) A cancelled playback drops the staged intent before any boundary.
  {
    const { runtime } = await makeRuntime();
    runtime.setStatus('speaking', 'playback.start');
    const staged = runtime.intentEvent('answer-start', { at: 0, holdForClipStart: true });
    runtime.dropAnswerStart('cancelled', { at: 40 });
    const dropped = answerStartEvents(runtime.takeEvents(), 'avatar.intent.dropped');
    assert.equal(dropped.length, 1);
    assert.equal(dropped[0].reason, 'cancelled');
    seen.push(`cancelled@${dropped[0].at}`);
    runtime.speechClip('start', { index: 0, at: 50 });
    runtime.speechEnd({ at: 60 });
    assert.equal(ofType(runtime.takeEvents(), 'avatar.action.start')
      .filter((entry) => entry.actionId === staged.actionId).length, 0,
    'a cancelled answer-start never starts later');
    runtime.dispose();
  }

  // (c) A turn switch expires the staged intent (the old generation may never start).
  {
    const { runtime, clock } = await makeRuntime();
    runtime.setStatus('speaking', 'playback.start');
    const staged = runtime.intentEvent('answer-start', { at: 0, holdForClipStart: true });
    runtime.intentEvent('turn-start', { at: 10, turnId: 2 });
    const dropped = answerStartEvents(runtime.takeEvents(), 'avatar.intent.dropped');
    assert.equal(dropped.length, 1, 'the stable-generation check reports the old intent');
    assert.equal(dropped[0].reason, 'expired', 'a turn switch expires it');
    seen.push(`expired@${dropped[0].at}`);
    clock.at = 20;
    runtime.speechClip('start', { index: 0, at: 20 });
    runtime.speechEnd({ at: 30 });
    assert.equal(ofType(runtime.takeEvents(), 'avatar.action.start')
      .filter((entry) => entry.actionId === staged.actionId).length, 0,
    'an expired answer-start never starts in the new turn');
    runtime.dispose();
  }
  console.log(`[drops] ${seen.join(' ')} (one row each, no later action)`);
});

// =============================================================================================
// Host mounting: real `apply`, fake VTS/clock, scripted TTS. The waiting line / synthesis /
// queueing surfaces are proven not to trigger the opening gesture.
// =============================================================================================
const hostState = {
  players: [],
  synthCalls: [],
  playerMs: 4000,
  bodyGates: [],
  /** P-139 P1: delayed start callback + its exact anchor (file path). */
  playerStartDelayMs: 0,
  anchorAt: 0,
  playerScheduled: [],
  /** P-139 P1: streamed transport (say lane) first-chunk callback. */
  ffplay: null,
  streamStartDelayMs: 0,
  streamAnchorAt: 0,
  streamScheduled: [],
  /** Failure injection for the file player. */
  playThrows: false,
};
globalThis.__answerStartTiming = hostState;

const ttsUrl = new URL('../src/host/speech/tts.js', import.meta.url).href;
const sightUrl = new URL('../src/host/vision/sight.js', import.meta.url).href;
const subtitleUrl = new URL('../src/host/subtitle/subtitle.js', import.meta.url).href;
const vtsUrl = new URL('../src/host/avatar/vts.js', import.meta.url).href;

const hooks = registerHooks({
  load(url, context, next) {
    if (url === ttsUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
    const s = globalThis.__answerStartTiming;
    export { resolveGptLangs, resolveGptSovitsTimeout } from '${ttsUrl}?as-helpers';
    export { speakChunks, speechChunkTexts, resolveChunkMinChars } from '${ttsUrl}?as-chunk';
    export const configureTts = () => {};
    export const gptSovitsReferenceStatus = async () => ({ seconds: null, ok: false, readable: false });
    export const warmupGptSovits = async () => ({ ok: false, skipped: 'disabled' });
    export const applyGptSovitsModels = () => ({ ok: true });
    export const synthesize = async (options) => {
      s.synthCalls.push({ text: String(options?.text ?? ''), purpose: String(options?.purpose ?? '') });
      if (String(options?.purpose ?? '') === 'answer') {
        const gate = s.bodyGates.shift?.();
        if (gate !== undefined && gate !== null) await gate;
      }
      return { file: 'as-' + s.synthCalls.length + '.mp3', bytes: 16, durationMs: 80, provider: 'fake' };
    };
    export const speakStreaming = async (options) => {
      const s = globalThis.__answerStartTiming;
      const scheduledAt = Date.now();
      const firstDataAt = s.streamAnchorAt > 0 ? s.streamAnchorAt : Date.now();
      s.streamScheduled.push({ scheduledAt, firstDataAt });
      const fire = () => {
        try {
          options?.onStart?.({
            startedAt: firstDataAt,
            firstDataAt,
            firstDataIsAudible: false,
            firstPcmAt: null,
            firstAudibleAt: null,
          });
        } catch { /* observation only */ }
      };
      if (s.streamStartDelayMs > 0) {
        const timer = setTimeout(fire, s.streamStartDelayMs);
        timer.unref?.();
      } else {
        fire();
      }
      return { file: 'as-stream.mp3', bytes: 16, durationMs: 500, firstChunkMs: s.streamStartDelayMs, via: 'ffplay-stream' };
    };
    export const play = (file, options) => {
      const s = globalThis.__answerStartTiming;
      if (s.playThrows === true) throw new Error('fake player failed');
      let resolve;
      const done = new Promise((r) => { resolve = r; });
      const scheduledAt = Date.now();
      const anchorAt = s.anchorAt > 0 ? s.anchorAt : scheduledAt;
      s.playerScheduled.push({ file, scheduledAt, anchorAt });
      const player = { file, startedAt: anchorAt, resolve };
      s.players.push(player);
      const fire = () => {
        try { options?.onStart?.({ startedAt: anchorAt }); } catch { /* observation only */ }
      };
      if (s.playerStartDelayMs > 0) {
        const timer = setTimeout(fire, s.playerStartDelayMs);
        timer.unref?.();
      } else {
        fire();
      }
      options?.onTransport?.({ exit: done, via: 'fake-player' });
      const timer = setTimeout(() => resolve(), s.playerMs);
      timer.unref?.();
      return done;
    };
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
    export const resolveFfplay = () => globalThis.__answerStartTiming.ffplay ?? null;
    export const capture = forbidden, captureDesktop = forbidden, captureDevice = forbidden, startStoryboard = forbidden;
    export const OBSERVATION_TTL_MS = 30000;
    export function readObservation() { return { at: null, ageMs: null, stale: true, hint: '' }; }`,
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
        this.ready = true; this.connected = true; this.model = { modelName: 'Fake' }; this.modelId = 'fake';
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
      async moveModel() {}
      setChannelInputs() {}
      close() { this.ready = false; this.connected = false; }
      // /assistant/status 的授权块经由该方法投影；保持与真实客户端一致的返回，不特判生产代码。
      authStatus() {
        return {
          state: this.ready ? 'ready' : 'disconnected',
          authenticated: this.ready === true,
          needsAuth: false,
          authError: '',
          lastAuthAt: 0,
          lastAuthSuccessAt: 0,
          retryable: this.ready !== true,
          authorizePending: false,
          authorizeRequests: 0,
          freshTokenRejected: false,
        };
      }
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
const { apply } = await import('../src/host/index.js');
hooks.deregister();
test.after(() => { delete globalThis.__answerStartTiming; });

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
const userMessage = (turn, text = '说点什么') => ({
  type: 'user/message',
  data: { turn, id: `u-${turn}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
});
const assistantBody = (turn, text) => ({
  type: 'assistant/message',
  data: { turn, step: 1, message: { id: `a-${turn}`, role: 'assistant', content: [{ type: 'text', text }] } },
});
const turnEnd = (turn) => ({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } });

async function mountHost(t, { settings = {}, extra = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'answer-start-timing-'));
  await mkdir(join(root, 'data'), { recursive: true });
  await mkdir(join(root, 'workspace'), { recursive: true });
  await writeFile(join(root, 'data', 'features.json'), JSON.stringify({
    hearing: false, ambient: false, voice: true, avatar: true, subtitle: false, memory: false, fastpath: false,
  }));
  await writeFile(join(root, 'data', 'settings.json'), JSON.stringify({
    gptSovits: { enabled: false },
    langs: { speech: 'zh', subtitle: 'zh' },
    typedReply: { voice: true },
    voice: { chunking: true, ...settings.voice },
  }));
  hostState.players = [];
  hostState.synthCalls = [];
  hostState.playerMs = 4000;
  hostState.bodyGates = [];
  hostState.playerStartDelayMs = 0;
  hostState.anchorAt = 0;
  hostState.playerScheduled = [];
  hostState.ffplay = null;
  hostState.streamStartDelayMs = 0;
  hostState.streamAnchorAt = 0;
  hostState.streamScheduled = [];
  hostState.playThrows = false;
  const handlers = [];
  const cleanups = [];
  const routes = new Map();
  const tools = new Map();
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
  }, { root, enabled: true, ...extra });

  const session = { id: 'answer-start-session', header: { cwd: join(root, 'workspace') } };
  const emit = (event) => { for (const entry of [...handlers]) if (entry.type === 'session/event') entry.handler(session, event); };
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
  t.after(async () => {
    for (const player of [...hostState.players]) player.resolve();
    await tick(30);
    for (const cleanup of cleanups.reverse()) {
      try { const value = cleanup(); if (value && typeof value.catch === 'function') value.catch(() => {}); } catch { /* best effort */ }
    }
    // The host's event sink is a fire-and-forget append: let it settle before removing the root.
    await tick(200);
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const connected = await callRoute('/assistant/action', { body: { action: 'live2d.connect' } });
  assert.equal(connected.ok, true, `live2d.connect succeeds (${connected.error ?? ''})`);
  await waitUntil(async () => ((await runtime())?.channels?.controlled ?? []).includes('headY'),
    'the runtime verified the head channels');
  return {
    root, emit, status, runtime, events, players: () => hostState.players, synthCalls: () => hostState.synthCalls,
    tools,
    say: async (args) => {
      const tool = tools.get('assistant_say');
      assert.ok(tool !== undefined, 'assistant_say is registered');
      return tool.execute(args);
    },
  };
}

// =============================================================================================
// 4. Host wiring: the waiting line / synthesis / queue never trigger; the first body start does.
// =============================================================================================
test('4. 候音/翻译/合成/排队不触发；第一段正文起播时登记一次并在该边界解决', async (t) => {
  const app = await mountHost(t, { settings: { voice: { ackDelayMs: 500 } } });
  let releaseBody;
  hostState.bodyGates.push(new Promise((resolve) => { releaseBody = resolve; }));

  app.emit(turnStart(1));
  app.emit(userMessage(1, '帮我查一下明天的天气'));
  // The waiting line may play while the body is still synthesizing: it is NOT the body start.
  await waitUntil(() => app.players().length >= 1, 'the waiting line reached the player');
  let view = await app.runtime();
  assert.equal(view.intentEvents.calls['answer-start'], 0, 'the waiting line never reports answer-start');

  // The body's text arrives, but its synthesis is still gated: nothing may stand it up yet.
  app.emit(assistantBody(1, '明天上海多云，出门带件外套。'));
  app.emit(turnEnd(1));
  await tick(120);
  view = await app.runtime();
  assert.equal(view.intentEvents.calls['answer-start'], 0, 'translation/synthesis never reports answer-start');
  assert.equal((await app.events()).filter((entry) => entry.type === 'avatar.intent.staged'
    && entry.payload?.event === 'answer-start').length, 0, 'no answer-start is even staged during synthesis');

  // The body is ready and waits behind the sounding waiting line: queueing still runs nothing.
  releaseBody();
  await tick(150);
  view = await app.runtime();
  assert.equal(view.intentEvents.calls['answer-start'], 0, 'queueing never reports answer-start');

  // End the waiting line: the first body clip starts, and it stages the intent exactly once.
  app.players()[0].resolve();
  await waitUntil(async () => (await app.runtime()).intentEvents.calls['answer-start'] === 1,
    'the first body clip reported answer-start');
  view = await app.runtime();
  assert.equal(view.intentEvents.pending, null,
    'the boundary resolved the intent: it is neither waiting nor resent to a later boundary');
  const readStaged = async () => (await app.events()).filter((entry) => entry.type === 'avatar.intent.staged'
    && entry.payload?.event === 'answer-start');
  await waitUntil(async () => (await readStaged()).length >= 1, 'the answer-start staged debug row');
  const staged = await readStaged();
  assert.equal(staged.length, 1, 'the first body start stages exactly one opening intent');
  const holds = (await app.events()).filter((entry) => entry.type === 'avatar.preset.hold'
    && entry.payload?.event === 'answer-start' && (entry.payload?.trace ?? []).includes('state:waiting'));
  assert.equal(holds.length, 0, 'no answer-start draw happens after the status left speaking');

  // The body really ended: the answer never re-triggers on later blocks/sentences.
  for (const player of [...app.players()].slice(1)) player.resolve();
  await waitUntil(async () => (await app.runtime()).speech.clip.session === false, 'the answer ended');
  await tick(120);
  view = await app.runtime();
  assert.equal(view.intentEvents.calls['answer-start'], 1, 'the same answer reported it only once');
  const stagedAfter = await readStaged();
  assert.equal(stagedAfter.length, 1, 'later blocks never stage it again');
  const drops = (await app.events()).filter((entry) => entry.type === 'avatar.intent.dropped'
    && entry.payload?.event === 'answer-start');
  const answers = (await app.events()).filter((entry) => (entry.type === 'avatar.preset.action'
    || entry.type === 'avatar.intent.start') && entry.payload?.event === 'answer-start');
  console.log(`[host] players=${app.players().length} calls=${view.intentEvents.calls['answer-start']} `
    + `staged=${stagedAfter.length} pending=${JSON.stringify(view.intentEvents.pending)} `
    + `starts=${view.speech.clip.starts} stateHolds=${holds.length} `
    + `dropped=${drops.map((entry) => entry.payload.reason).join(',') || 'none'} `
    + `released=${answers.map((entry) => entry.type).join(',') || 'none'}`);
});

// =============================================================================================
// 5. Host, free boundary: the first body clip's real start really starts ONE opening gesture.
// =============================================================================================
test('5. 边界空闲时第一段正文起播恰好触发一次 opening gesture（候音不触发）', async (t) => {
  // The legacy executor is deterministic here (answer-start → nod): this test is about WHEN it is
  // released, not about preset selection (the preset suites and the event-order test cover that).
  const app = await mountHost(t, { settings: { voice: { ackDelayMs: 500 } }, extra: { presetExecution: false } });
  app.emit(turnStart(1));
  app.emit(userMessage(1, '帮我查一下明天的天气'));
  await waitUntil(() => app.players().length >= 1, 'the waiting line reached the player');
  let view = await app.runtime();
  assert.equal(view.intentEvents.calls['answer-start'], 0, 'the waiting line never reports answer-start');

  app.emit(assistantBody(1, '明天上海多云，出门带件外套。'));
  app.emit(turnEnd(1));
  // The pre-answer gesture (thinking → tilt) must be over before the body boundary; while the
  // waiting line is still sounding nothing else starts.
  await tick(2000);
  view = await app.runtime();
  assert.equal(view.intentEvents.calls['answer-start'], 0, 'synthesis/queueing never reports answer-start');
  const startedBefore = view.intentEvents.started;

  app.players()[0].resolve();
  await waitUntil(async () => (await app.runtime()).speech.clip.starts >= 2, 'the first body clip started');
  await waitUntil(async () => (await app.runtime()).intentEvents.calls['answer-start'] === 1,
    'the first body start reported answer-start');
  view = await app.runtime();
  assert.equal(view.intentEvents.pending, null, 'the intent was resolved by its boundary');
  // The host status exposes the released phase; the action itself is the mapped nod, started once.
  assert.equal(view.intentEvents.lastEvent, 'answer-start', 'the released phase is the opening intent');
  assert.equal(view.intentEvents.lastIntent, 'nod', 'the legacy executor started the mapped nod');
  assert.equal(view.intentEvents.started, startedBefore + 1, 'exactly one gesture started at the boundary');
  const atBoundary = {
    lastEvent: view.intentEvents.lastEvent,
    lastIntent: view.intentEvents.lastIntent,
    started: view.intentEvents.started,
  };
  const readStaged = async () => (await app.events()).filter((entry) => entry.type === 'avatar.intent.staged'
    && entry.payload?.event === 'answer-start');
  await waitUntil(async () => (await readStaged()).length >= 1, 'the answer-start staged debug row');
  const staged = await readStaged();
  assert.equal(staged.length, 1, 'exactly one admission for this answer');

  // Later blocks/sentences of the same answer never re-trigger it.
  for (const player of [...app.players()].slice(1)) player.resolve();
  await waitUntil(async () => (await app.runtime()).speech.clip.session === false, 'the answer ended');
  await tick(120);
  view = await app.runtime();
  assert.equal(view.intentEvents.calls['answer-start'], 1, 'the same answer reported it only once');
  assert.equal((await app.events()).filter((entry) => entry.type === 'avatar.intent.staged'
    && entry.payload?.event === 'answer-start').length, 1, 'later blocks never stage it again');
  console.log(`[start] calls=1 staged=${staged.length} `
    + `atBoundary=${atBoundary.lastEvent}/${atBoundary.lastIntent} `
    + `started=${startedBefore}->${atBoundary.started} clipStarts=${view.speech.clip.starts} `
    + `dropped=${(await app.events()).filter((entry) => entry.type === 'avatar.intent.dropped'
      && entry.payload?.event === 'answer-start').length}`);
});

// =============================================================================================
// 6. Lane gate (P-139 stage 2 P0 B): only the ANSWER BODY's natural end reports the answer end.
//    The waiting line (ack) closes its own clip; the reply body reports `answer-end` exactly once.
// =============================================================================================
test('6. 候音（ack）结束不触发 answer-end；reply 正文自然结束恰好触发一次', async (t) => {
  const app = await mountHost(t, { settings: { voice: { ackDelayMs: 200 } } });
  // Hold the body's synthesis: the waiting line plays and ends while no answer body is ready.
  let releaseBody;
  hostState.bodyGates.push(new Promise((resolve) => { releaseBody = resolve; }));

  app.emit(turnStart(1));
  app.emit(userMessage(1, '帮我查一下明天的天气'));
  await waitUntil(() => app.players().length >= 1, 'the waiting line reached the player');
  const beforeAck = await app.runtime();
  assert.equal(beforeAck.intentEvents.calls['answer-end'], 0, 'nothing is an answer end before it starts');
  const settledBeforeAck = beforeAck.intentEvents.settled;

  // The waiting line (lane ack) really ends: its own clip closes, the answer does not.
  app.players()[0].resolve();
  await tick(250);
  let view = await app.runtime();
  assert.equal(view.intentEvents.calls['answer-end'], 0, 'an ack end is never an answer end');
  assert.equal(view.intentEvents.settled, settledBeforeAck, 'an ack end never settles the pose');
  assert.equal(view.speech.clip.session, true, 'the ack did not close the whole speech session');
  assert.equal(view.speech.clip.active, false, 'the ack closed its own clip');
  const ackSession = view.speech.clip.session;

  // The answer body arrives and its first block starts once the held synthesis is released.
  app.emit(assistantBody(1, '明天上海多云。'));
  app.emit(turnEnd(1));
  releaseBody();
  await waitUntil(() => app.players().length >= 2, 'the reply body reached the player');
  const answerStartBeforeEnd = (await app.runtime()).intentEvents.calls['answer-start'];
  assert.equal(answerStartBeforeEnd, 1, 'the body start still reports answer-start once');

  // End every body block (a sentence may have been split): the reply's natural end reports once.
  for (let index = 0; index < 60; index += 1) {
    if ((await app.runtime()).intentEvents.calls['answer-end'] > 0) break;
    for (const player of app.players().slice(1)) player.resolve();
    await tick(40);
  }
  await waitUntil(async () => (await app.runtime()).intentEvents.calls['answer-end'] === 1,
    'the reply body end reported answer-end exactly once');
  await tick(200);
  view = await app.runtime();
  assert.equal(view.intentEvents.calls['answer-end'], 1, 'the reply body reports its end once, never twice');
  assert.equal(view.speech.clip.session, false, 'the reply natural end closed the speech session');
  const stagedAnswerStart = (await app.events()).filter((entry) => entry.type === 'avatar.intent.staged'
    && entry.payload?.event === 'answer-start');
  assert.equal(stagedAnswerStart.length, 1, 'the ack still never staged an opening intent');
  console.log(`[lane] ack: answerEnd=0 settled=${settledBeforeAck} session=${ackSession} `
    + `reply: answerEnd=${view.intentEvents.calls['answer-end']} players=${app.players().length}`);
});

// =============================================================================================
// 7. Anchor source: the file path marks the clip at the player's start callback, not at play().
// =============================================================================================
test('7. 文件路径：answer-start/clip 锚点取播放器 start 回调，不早于 play() 调度', async (t) => {
  const app = await mountHost(t, { settings: { voice: { ackDelayMs: 60000 } } });
  hostState.playerStartDelayMs = 300;
  hostState.anchorAt = Date.now() + 500;
  const anchor = hostState.anchorAt;

  app.emit(turnStart(1));
  app.emit(userMessage(1, '帮我查一下明天的天气'));
  app.emit(assistantBody(1, '明天上海多云，出门带件外套。'));
  app.emit(turnEnd(1));
  await waitUntil(() => hostState.playerScheduled.length >= 1, 'the body player was scheduled');
  const scheduledAt = hostState.playerScheduled[0].scheduledAt;

  // The player exists but its start callback has not fired: nothing may claim an audible start.
  let view = await app.runtime();
  assert.equal(view.intentEvents.calls['answer-start'], 0,
    'no answer-start before the player start callback');
  assert.equal(view.speech.clip.starts, 0, 'no clip boundary before the player start callback');
  assert.equal(hostState.playerScheduled[0].anchorAt, anchor, 'the fake start anchor is the future one');

  await waitUntil(async () => (await app.runtime()).intentEvents.calls['answer-start'] === 1,
    'the player start callback reported answer-start', 5000);
  view = await app.runtime();
  assert.equal(view.speech.clip.startedAt, anchor, 'the clip boundary uses the player start anchor');
  assert.equal(view.speech.clip.anchor, 'player-ready',
    'the anchor source is recorded as the player-ready callback, never called audible');
  assert.ok(scheduledAt > 0 && anchor > scheduledAt, `the anchor follows the schedule (${scheduledAt} -> ${anchor})`);

  await waitUntil(async () => (await app.events()).some((entry) => entry.type === 'avatar.intent.staged'
    && entry.payload?.event === 'answer-start'), 'the answer-start staged event');
  const staged = (await app.events()).filter((entry) => entry.type === 'avatar.intent.staged'
    && entry.payload?.event === 'answer-start');
  assert.equal(staged.length, 1, 'exactly one opening intent');
  assert.equal(staged[0].payload.at, anchor, 'the staged intent carries the player start anchor');
  await waitUntil(async () => (await app.events()).some((entry) => entry.type === 'avatar.speech.anchor'
    && entry.payload?.anchor === 'player-ready'), 'the player-ready anchor event');
  const anchors = (await app.events()).filter((entry) => entry.type === 'avatar.speech.anchor'
    && entry.payload?.anchor === 'player-ready');
  assert.equal(anchors.length, 1, 'the anchor source is also recorded as a runtime event');
  assert.equal(anchors[0].payload.at, anchor);
  console.log(`[anchor-file] scheduled=${scheduledAt} anchor=${anchor} `
    + `startedAt=${view.speech.clip.startedAt} source=${view.speech.clip.anchor}`);
});

// =============================================================================================
// 8. Streamed transport: the first-chunk callback is the anchor; the tool lane never opens an
//    answer-start. (In this build the streamed transport serves the `say` lane, not the body.)
// =============================================================================================
test('8. 流式路径：clip 锚点取首块起播回调；工具 say lane 不产生 answer-start', async (t) => {
  const app = await mountHost(t, { settings: { voice: { ackDelayMs: 60000 } } });
  hostState.ffplay = 'ffplay-fake';
  hostState.streamStartDelayMs = 500;
  hostState.streamAnchorAt = Date.now() + 700;
  const anchor = hostState.streamAnchorAt;

  const said = await app.say({ text: '我先去查一下稍等。', purpose: 'explicit' });
  assert.equal(said?.accepted, true, `the streamed line was accepted (${said?.reason ?? ''})`);
  // The tool reports acceptance before its background playback starts: wait for the stream.
  await waitUntil(() => hostState.streamScheduled.length >= 1, 'the streamed transport was scheduled');
  await waitUntil(async () => (await app.runtime()).speech.clip.starts >= 1, 'the streamed clip started');
  assert.equal(hostState.streamScheduled.length, 1,
    `the streamed transport was used (synth=${JSON.stringify(hostState.synthCalls)} players=${app.players().length})`);
  const scheduledAt = hostState.streamScheduled[0].scheduledAt;
  assert.ok(anchor > scheduledAt, `the first chunk follows the schedule (${scheduledAt} -> ${anchor})`);

  const view = await app.runtime();
  assert.equal(view.speech.clip.startedAt, anchor, 'the streamed clip uses the first-chunk anchor');
  assert.equal(view.speech.clip.anchor, 'first-data',
    'the anchor source is the first chunk handed to the player, never called audible');
  assert.equal(view.intentEvents.calls['answer-start'], 0,
    'the tool say lane never opens the answer body');
  await waitUntil(async () => (await app.events()).some((entry) => entry.type === 'avatar.speech.anchor'
    && entry.payload?.anchor === 'first-data'), 'the streamed anchor event');
  const anchors = (await app.events()).filter((entry) => entry.type === 'avatar.speech.anchor'
    && entry.payload?.anchor === 'first-data');
  assert.equal(anchors.length, 1, 'the streamed anchor source is recorded once');
  assert.equal(anchors[0].payload.at, anchor);
  const starts = (await app.events()).filter((entry) => entry.type === 'avatar.action.start'
    && entry.payload?.event === 'answer-start');
  assert.deepEqual(starts, [], 'no answer-start action from the tool lane');
  console.log(`[anchor-stream] scheduled=${scheduledAt} anchor=${anchor} `
    + `startedAt=${view.speech.clip.startedAt} source=${view.speech.clip.anchor}`);
});

// =============================================================================================
// 9. A body clip cancelled before its player starts never produces answer-start.
// =============================================================================================
test('9. 取消：起播前取消的文件路径 clip 不产生 answer-start', async (t) => {
  const app = await mountHost(t, { settings: { voice: { ackDelayMs: 60000 } } });
  hostState.playerStartDelayMs = 1500;
  hostState.anchorAt = Date.now() + 1700;

  app.emit(turnStart(1));
  app.emit(userMessage(1, '帮我查一下明天的天气'));
  app.emit(assistantBody(1, '明天上海多云，出门带件外套。'));
  app.emit(turnEnd(1));
  await waitUntil(() => hostState.playerScheduled.length >= 1, 'the body player was scheduled');
  assert.equal((await app.runtime()).intentEvents.calls['answer-start'], 0,
    'still no answer-start while the player is unstarted');

  // The user's next typed input is the interruption; the pending clip must not start.
  app.emit(userMessage(2, '换一句'));
  await waitUntil(async () => (await app.events()).some((entry) => entry.type === 'speech.cancelled'),
    'the pending clip was cancelled');
  await tick(1800); // past the fake start delay: a cancelled clip must not resurrect the boundary
  const view = await app.runtime();
  assert.equal(view.intentEvents.calls['answer-start'], 0,
    'a cancelled-before-start clip never produced answer-start');
  assert.equal(view.speech.clip.starts, 0, 'no clip boundary was opened for the cancelled clip');
  console.log(`[cancel] answerStart=${view.intentEvents.calls['answer-start']} `
    + `clipStarts=${view.speech.clip.starts} scheduled=${hostState.playerScheduled.length}`);
});

// =============================================================================================
// 10. A body player that fails to start never produces answer-start.
// =============================================================================================
test('10. 失败：播放器启动失败不产生 answer-start', async (t) => {
  const app = await mountHost(t, { settings: { voice: { ackDelayMs: 60000 } } });
  hostState.playThrows = true;

  app.emit(turnStart(1));
  app.emit(userMessage(1, '帮我查一下明天的天气'));
  app.emit(assistantBody(1, '明天上海多云，出门带件外套。'));
  app.emit(turnEnd(1));
  await tick(900); // let the typed lane try its own fallback too (all file players fail)
  const view = await app.runtime();
  assert.equal(view.intentEvents.calls['answer-start'], 0,
    'a player that never started never produced answer-start');
  assert.equal(view.speech.clip.starts, 0, 'no clip boundary for a failed start');
  const starts = (await app.events()).filter((entry) => entry.type === 'avatar.action.start'
    && entry.payload?.event === 'answer-start');
  assert.deepEqual(starts, [], 'no answer-start action from a failed start');
  console.log(`[failed] answerStart=${view.intentEvents.calls['answer-start']} `
    + `clipStarts=${view.speech.clip.starts} players=${app.players().length}`);
});
