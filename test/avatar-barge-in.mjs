/**
 * P-139 阶段 2 P0 A — barge-in → motion interrupt（平滑退出，不 0ms 硬清）。
 *
 * 1) 运行时：`reason:'barge-in'` 必须与 `reason:'interrupt'` 走同一条平滑退出路径：活动的 preset
 *    先被标记为 cancelled、在 240 ms 淡出窗口内继续写，然后才释放；不能像 turn-switch 那样在一帧
 *    内移除（0 ms 硬清）。淡出结束后旧 action 不会复活。
 * 2) 隐私锁 / 断连仍是立即停写：它们没有 "interrupt/barge-in" 语义，必须保持 0 帧移除。
 * 3) 宿主：真实 barge-in final（noteBargeInFinal 路径）在取消播放的同时调用一次
 *    `avatarRuntime.interrupt({reason:'barge-in'})`；被打断的 reply 不产生 `answer-end`，旧 action
 *    不复活；随后同一条语音输入失败走 `speakLine`（purpose 'say'）的整行播报，自然结束也不是
 *    回答结束。
 *
 * 用假 clock/transport/fake VTS/fake hearing/fake TTS：没有声音、采集、网络或子进程。
 *
 * Run: node --test test/avatar-barge-in.mjs
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { registerHooks } from 'node:module';
import { Readable } from 'node:stream';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The runtime is imported under its own query URL: a plain-URL import here would populate Node's
// module cache before the hook below can replace the plain URL for `index.js`.
import { createAvatarRuntime } from '../src/host/avatar/avatarRuntime.js?barge-in-suite-real';

// =============================================================================================
// Runtime rig: fake clock + fake transport (same shape as `preset-transport`)
// =============================================================================================
const HEAD_ROWS = ['headX', 'headY', 'headZ', 'gazeX', 'gazeY']
  .map((channel) => ({ channel, inputName: `P_${channel}`, injectable: true, verified: true }));

function createRig() {
  let clock = 0;
  const frames = [];
  const transport = {
    connect: async () => {},
    disconnect: async () => {},
    write: async () => ({ ok: true }),
    writeFrame: async (entries) => {
      frames.push({ at: clock, entries: entries.map((entry) => ({ ...entry })) });
      return { ok: true };
    },
    writeMotion: async (payload) => {
      frames.push({ at: clock, entries: payload.entries.map((entry) => ({ ...entry })) });
      return { ok: true };
    },
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
      presetExecution: true,
    },
  });
  return {
    runtime,
    frames,
    setClock(at) { clock = at; },
    tick(at) { clock = at; return runtime.tick(at); },
  };
}

async function connect(rig) {
  assert.equal((await rig.runtime.connect()).ok, true, 'runtime connects');
  const result = await rig.runtime.setChannelMappings(HEAD_ROWS, { channelMap: {} });
  assert.equal(result.ok, true, 'head channels verified');
  // Keep the autonomous preset boundary out of these deterministic tests.
  rig.runtime.setStatus('speaking', 'barge-in-test');
  rig.runtime.takeEvents();
}

const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve));
async function run(rig, from, to, stepMs = 33) {
  for (let at = from; at <= to; at += stepMs) {
    rig.tick(at);
    await flushMicrotasks();
  }
}

/** Draw a preset of one recipe; a hold draw is retried with the next deterministic seed. */
function startPreset(runtime, context) {
  for (let seed = 0; seed < 160; seed += 1) {
    const result = runtime.preset({ ...context, seed });
    if (result.started === true) return result;
  }
  throw new Error(`no preset started for ${JSON.stringify(context)}`);
}

const channelFrames = (frames, channel) => frames
  .filter((frame) => frame.entries.some((entry) => entry.channel === channel))
  .map((frame) => ({
    at: frame.at,
    entry: frame.entries.find((entry) => entry.channel === channel),
  }));

const presetSnapshot = (runtime) => runtime.snapshot().motion.presets;
const withReason = (events, type, reason) => events.filter((event) => event.type === type
  && event.reason === reason);

// =============================================================================================
// 1. barge-in reason = smooth fade, no 0 ms hard clear, old action never revives
// =============================================================================================
test('1. motion-controller：barge-in 走平滑淡出（不清 0ms），淡出结束旧 action 不复活', async () => {
  const rig = createRig();
  await connect(rig);
  const started = startPreset(rig.runtime, { state: 'speaking', event: 'answer-start', recipe: 'answer-nod' });
  assert.deepEqual(started.channels, ['headY'], 'the nod really owns headY');
  const actionId = started.actionId;
  assert.equal(typeof actionId, 'string', 'the answer-start action has an identity');
  assert.equal(presetSnapshot(rig.runtime).active.length, 1, 'the answer-start action is running');

  // 300 ms of real trajectory, then the user barges in.
  await run(rig, 0, 300);
  const writesBefore = channelFrames(rig.frames, 'headY').length;
  assert.ok(writesBefore > 0, `the nod was writing before the barge-in (${writesBefore})`);

  rig.setClock(300);
  const result = rig.runtime.interrupt({ reason: 'barge-in' });
  assert.equal(result.reason, 'barge-in', 'the runtime keeps the one reason vocabulary');

  // No 0 ms hard clear: the trajectory is cancelled but STILL in the active list (fading).
  const fading = presetSnapshot(rig.runtime);
  assert.equal(fading.active.length, 1, 'the preset is fading, not removed in one frame');
  assert.equal(fading.active[0].cancelled, true, 'it is marked as the one fading trajectory');
  assert.equal(rig.runtime.snapshot().actions.current, null, 'no legacy action is left running');

  const clearRows = withReason(rig.runtime.takeEvents(), 'avatar.preset.cleared', 'barge-in');
  assert.equal(clearRows.length, 1, `one barge-in clearance row (${clearRows.length})`);
  assert.equal(clearRows[0].removed, 0, 'nothing was removed at 0 ms');
  assert.equal(clearRows[0].faded, 1, 'exactly the running trajectory took the smooth fade');

  // The 240 ms fade window keeps writing; after the release nothing is written any more.
  await run(rig, 310, 2600);
  const headYFrames = channelFrames(rig.frames, 'headY');
  const duringFade = headYFrames.filter((frame) => frame.at >= 300 && frame.at <= 600);
  assert.ok(duringFade.length > 0, `the cancelled trajectory keeps writing while it fades (${duringFade.length})`);
  const last = headYFrames[headYFrames.length - 1];
  const afterLast = rig.frames.filter((frame) => frame.at > last.at + 300
    && frame.entries.some((entry) => entry.channel === 'headY'));
  assert.deepEqual(afterLast, [], 'after the smooth exit nothing more is written to the old channel');
  assert.equal(presetSnapshot(rig.runtime).active.length, 0, 'the faded trajectory really released');
  assert.deepEqual(presetSnapshot(rig.runtime).releasing, [], 'the release window is freed');

  // Old action never revives: same actionId can never start again after the interruption.
  const revived = rig.runtime.takeEvents()
    .filter((event) => event.actionId === actionId
      && (event.type === 'avatar.preset.action' || event.type === 'avatar.action.start'));
  assert.deepEqual(revived, [], 'the interrupted actionId is never started again');
  assert.notEqual(rig.runtime.snapshot().actions.current?.actionId, actionId, 'no old action owns the pose');
  console.log(`[barge-in] reason=${result.reason} beforeWrites=${writesBefore} `
    + `fadeWrites=${duringFade.length} lastAt=${Math.round(last.at)} removed=0 faded=1 revived=0`);
  rig.runtime.dispose();
});

// =============================================================================================
// 2. Privacy lock / disconnect keep their immediate hard stop (unchanged semantics)
// =============================================================================================
test('2. 隐私锁/断连仍立即停写：0 帧移除，无淡出写入', async () => {
  const outcomes = [];
  for (const [name, stop] of [
    ['privacy', (runtime) => { const locked = runtime.lock('privacy'); assert.equal(locked.locked, true); }],
    ['disconnect', async (runtime) => { await runtime.disconnect(); }],
  ]) {
    const rig = createRig();
    await connect(rig);
    startPreset(rig.runtime, { state: 'speaking', event: 'answer-start', recipe: 'answer-nod' });
    await run(rig, 0, 300);
    assert.equal(presetSnapshot(rig.runtime).active.length, 1, `${name}: the preset is running`);
    rig.setClock(300);
    await stop(rig.runtime);

    const rows = rig.runtime.takeEvents().filter((event) => event.type === 'avatar.preset.cleared');
    assert.equal(rows.length, 1, `${name}: one clearance row`);
    assert.equal(rows[0].removed, 1, `${name}: removed in one frame`);
    assert.equal(rows[0].faded, 0, `${name}: no fade window`);
    assert.equal(presetSnapshot(rig.runtime).active.length, 0, `${name}: nothing is left to fade`);
    await run(rig, 310, 700);
    const late = channelFrames(rig.frames, 'headY').filter((frame) => frame.at > 300);
    assert.deepEqual(late, [], `${name}: no late headY write after the hard stop`);
    outcomes.push(`${name}=removed:${rows[0].removed}/faded:${rows[0].faded}`);
    rig.runtime.dispose();
  }
  console.log(`[hard-stop] ${outcomes.join(' ')}`);
});

// =============================================================================================
// Host mount: fake VTS / hearing / TTS, real `apply`. One barge-in final, then the failed
// voice delivery speaks its whole-line notice through `speakLine` (lane 'say').
// =============================================================================================
const hostState = {
  onUpdate: null,
  players: [],
  synthCalls: [],
  interruptCalls: [],
  playerMs: 3000,
};
globalThis.__avatarBargeIn = hostState;

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
    const s = globalThis.__avatarBargeIn;
    export const modelReady = () => true;
    export const finalModelReady = () => false;
    export const isLoopbackDevice = (name) => /CABLE|Stereo Mix|Virtual/i.test(String(name));
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
    const s = globalThis.__avatarBargeIn;
    export { resolveGptLangs, resolveGptSovitsTimeout } from '${ttsUrl}?barge-in-helpers';
    export { speakChunks, speechChunkTexts, resolveChunkMinChars } from '${ttsUrl}?barge-in-chunk';
    export const configureTts = () => {};
    export const gptSovitsReferenceStatus = async () => ({ seconds: null, ok: false, readable: false });
    export const warmupGptSovits = async () => ({ ok: false, skipped: 'disabled' });
    export const applyGptSovitsModels = () => ({ ok: true });
    export const synthesize = async (options) => {
      s.synthCalls.push(String(options?.text ?? ''));
      return { file: 'barge-in-' + s.synthCalls.length + '.mp3', bytes: 16, durationMs: 120, provider: 'fake' };
    };
    export const speakStreaming = async () => { throw new Error('streaming not expected'); };
    export const play = (file, options) => {
      let resolve;
      const done = new Promise((resolveDone) => { resolve = resolveDone; });
      const player = {
        file,
        startedAt: Date.now(),
        endedAt: 0,
        resolve: () => {
          if (player.endedAt === 0) player.endedAt = Date.now();
          resolve();
        },
      };
      s.players.push(player);
      options?.onStart?.({ startedAt: player.startedAt });
      options?.onTransport?.({ exit: done, via: 'fake-player' });
      const timer = setTimeout(() => player.resolve(), s.playerMs ?? 3000);
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
    export const resolveFfplay = () => 'ffplay-fake';
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
        this.ready = true; this.connected = true; this.model = { modelName: 'FakeBargeIn' }; this.modelId = 'fake';
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
    import * as real from '${avatarRuntimeUrl}?barge-in-real';
    export const AVATAR_ERROR_CODES = real.AVATAR_ERROR_CODES;
    export const buildAvatarStylePrompt = real.buildAvatarStylePrompt;
    export const createAvatarStyleCache = real.createAvatarStyleCache;
    export const DEFAULT_AVATAR_STYLE = real.DEFAULT_AVATAR_STYLE;
    export const personaStyleVersion = real.personaStyleVersion;
    export function createAvatarRuntime(options) {
      const runtime = real.createAvatarRuntime(options);
      const interrupt = runtime.interrupt;
      runtime.interrupt = (opts = {}) => {
        const result = interrupt.call(runtime, opts);
        globalThis.__avatarBargeIn.interruptCalls.push({
          reason: String(opts?.reason ?? ''),
          interruptedAction: result?.interruptedAction === true,
        });
        return result;
      };
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
const { apply } = await import('../src/host/index.js');
hooks.deregister();
after(() => { delete globalThis.__avatarBargeIn; });

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

async function mountHost(t, { extra = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'avatar-barge-in-'));
  await mkdir(join(root, 'data'), { recursive: true });
  await mkdir(join(root, 'workspace'), { recursive: true });
  await writeFile(join(root, 'data', 'features.json'), JSON.stringify({
    hearing: true, ambient: false, voice: true, avatar: true, subtitle: false, memory: false, fastpath: false,
  }));
  await writeFile(join(root, 'data', 'settings.json'), JSON.stringify({
    gptSovits: { enabled: false },
    langs: { speech: 'zh', subtitle: 'zh' },
    typedReply: { voice: true },
    voice: { chunking: true },
  }));
  hostState.onUpdate = null;
  hostState.players = [];
  hostState.synthCalls = [];
  hostState.interruptCalls = [];
  hostState.playerMs = 15000;

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
  }, { root, enabled: true, asrMergeWindowMs: 40, ...extra });

  const session = { id: 'avatar-barge-in-session', header: { cwd: join(root, 'workspace') } };
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
    for (const player of [...hostState.players]) player.resolve();
    await tick(30);
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
    return controlled.includes('headY') && controlled.includes('headZ');
  }, 'the runtime verified the head channels');

  const listen = tools.get('assistant_listen');
  assert.ok(listen !== undefined, 'assistant_listen is registered');
  const started = await listen.execute({ action: 'start' });
  assert.equal(started.ok, true, `hearing starts (${started.error ?? ''})`);
  assert.equal(typeof hostState.onUpdate, 'function', 'the hearing session exposes onUpdate');
  return {
    root, emit, action: (body) => callRoute('/assistant/action', { body }), status, runtime,
    players: () => hostState.players, synthCalls: () => hostState.synthCalls,
    barge: (text) => hostState.onUpdate({ final: text, durationMs: 320 }),
    events, waitForEvent,
  };
}

// =============================================================================================
// 3. Host barge-in → one interrupt('barge-in'); no answer-end; old action never revives;
//    the following whole-line `speakLine` (lane say) end is not an answer end either.
// =============================================================================================
test('3. 宿主 barge-in：interrupt 调一次（barge-in）、reply 不报 answer-end、旧 action 不复活、say 行结束不报', async (t) => {
  // The legacy executor is deterministic here: `thinking` starts one long nod immediately, so the
  // barge-in really has a running action to cut. The preset smooth fade itself is covered by test 1.
  const app = await mountHost(t, { extra: { presetExecution: false } });
  app.emit(turnStart(1));
  app.emit(userMessage(1, '先讲一句'));
  app.emit(assistantBody(1, '今天上海多云。'));
  app.emit(turnEnd(1));
  await waitUntil(() => app.players().length >= 1, 'the typed reply reached the player');

  const before = await app.runtime();
  assert.equal(before.intentEvents.calls['answer-end'], 0, 'no answer-end before the answer is over');
  const traceBefore = before.motion.actionTrace?.length ?? 0;

  // The verified user final: noteBargeInFinal cancels the sounding clip AND interrupts the motion.
  app.barge('帮我把明天的天气也讲一下');
  assert.equal(hostState.interruptCalls.length, 1, 'the host called interrupt exactly once');
  assert.equal(hostState.interruptCalls[0].reason, 'barge-in', 'the one reason vocabulary is barge-in');
  assert.equal(hostState.interruptCalls[0].interruptedAction, true,
    'a really running action was cut (the wrapper saw interruptedAction:true)');

  // The playback really was cancelled (host audio semantics unchanged).
  await app.waitForEvent('speech.cancelled', (payload) => payload.reason === 'voice');
  await tick(80);
  assert.equal(hostState.interruptCalls.length, 1, 'the later delivery path never interrupts a second time');
  const after = await app.runtime();
  assert.equal(after.intentEvents.calls['answer-end'], 0, 'an interrupted reply is not an answer end');
  assert.ok((after.motion.actionTrace?.length ?? 0) > traceBefore,
    'the running action has one ended trace after the barge-in');
  const queuedAnswerStarts = (await app.events()).filter((event) => event.type === 'avatar.intent.staged'
    && event.payload?.event === 'answer-start');
  assert.ok(queuedAnswerStarts.length >= 1, 'the answer start was staged, not silently invented later');

  // The accepted utterance cannot open an agent session in this mount, so the host speaks its
  // whole-line `speakLine` notice (`purpose: 'say'`, lane `say`). Its natural end must not settle.
  await waitUntil(() => app.synthCalls().some((text) => text.includes('语音通道暂时不可用')),
    'the speakLine notice was synthesized');
  await waitUntil(() => app.players().length >= 2, 'the speakLine notice reached the player');
  const sayBefore = await app.runtime();
  const settledBeforeSay = sayBefore.intentEvents.settled;
  const notice = app.players()[app.players().length - 1];
  notice.resolve();
  await app.waitForEvent('voice.playback.end');
  await tick(120);

  const final = await app.runtime();
  assert.equal(final.intentEvents.calls['answer-end'], 0, 'the say line end never reports answer-end');
  assert.equal(final.intentEvents.settled, settledBeforeSay, 'the say line end never settles the pose');
  assert.equal(final.speech.clip.session, true, 'the say line closed its clip without closing the answer session');
  assert.equal(hostState.interruptCalls.length, 1, 'still exactly one interrupt for the one barge-in');
  console.log(`[host] interrupt=${hostState.interruptCalls[0].reason} `
    + `cut=${hostState.interruptCalls[0].interruptedAction} traces=${traceBefore}->${final.motion.actionTrace?.length ?? 0} `
    + `answerEnd=${final.intentEvents.calls['answer-end']} settled=${final.intentEvents.settled} `
    + `saySession=${final.speech.clip.session}`);
});
