/**
 * Host wiring for the waiting-line priority verdict (A1), P-54 and P-139.
 *
 * This suite pins the three host connections that used to be missing:
 *   1. `voice.ack.kept` — a body that is still synthesizing keeps the waiting line: the lane
 *      records the policy verdict and writes NO `voice.ack.superseded` row;
 *   2. P-54 — real playback reports one sentence-level `speechClip('start'/'end')` pair per spoken
 *      sentence (not per intra-sentence P-65 block) and closes the whole session with `speechEnd`
 *      once the clip queue is empty;
 *   3. P-139 — the host reports `answer-start` exactly once at the first sentence head, and a turn
 *      switch drops the previous generation's staged intent; runtime failures during any of these
 *      wiring calls are debug rows only and never disturb the announcement/playback;
 *   4. P-139v — the conclusion is judged on the sentence that really sounds (at its clip start, not
 *      when the text arrives), a conclusion the spoken version dropped never triggers, and only the
 *      assistant's own "I did not hear / which one" words (never a user's question word) tilt it.
 *
 * The host is mounted for real (`apply`), the sentence lane is the typed reply lane (real session
 * events, no agent loop), and TTS/sight/subtitle/VTS are scripted: no sound, capture, network or
 * child process is used. No timer is introduced by the wiring itself: every call hangs off an
 * existing playback/turn event.
 *
 * Run: node --test test/voice-wiring.mjs
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { registerHooks } from 'node:module';
import { Readable } from 'node:stream';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupRoot, disposeAll } from './helpers/cleanup.mjs';

const state = {
  players: [],
  synthCalls: [],
  throwWiring: false,
  /** Per-synthesis-call gates: a test can hold the second sentence before it reaches TTS. */
  synthGates: [],
  /** How long the fake player process takes to exit after it started. */
  playerMs: 80,
};
globalThis.__voiceWiring = state;

const ttsUrl = new URL('../src/host/speech/tts.js', import.meta.url).href;
const sightUrl = new URL('../src/host/vision/sight.js', import.meta.url).href;
const subtitleUrl = new URL('../src/host/subtitle/subtitle.js', import.meta.url).href;
const vtsUrl = new URL('../src/host/avatar/vts.js', import.meta.url).href;
const avatarRuntimeUrl = new URL('../src/host/avatar/avatarRuntime.js', import.meta.url).href;

const hooks = registerHooks({
  load(url, context, next) {
    // A scripted TTS: the real P-65 block splitter/driver is kept, so chunking is the real one.
    if (url === ttsUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
    const s = globalThis.__voiceWiring;
    export { resolveGptLangs, resolveGptSovitsTimeout } from '${ttsUrl}?voice-wiring-helpers';
    export { speakChunks, speechChunkTexts, resolveChunkMinChars } from '${ttsUrl}?voice-wiring-chunk';
    export const configureTts = () => {};
    export const gptSovitsReferenceStatus = async () => ({ seconds: null, ok: false, readable: false });
    export const warmupGptSovits = async () => ({ ok: false, skipped: 'disabled' });
    export const applyGptSovitsModels = () => ({ ok: true });
    export const synthesize = async (options) => {
      s.synthCalls.push(String(options?.text ?? ''));
      // A test can hold one sentence (e.g. the one after the first clip) before TTS returns.
      const gate = s.synthGates?.shift?.();
      if (gate !== undefined && gate !== null) await (typeof gate === 'function' ? gate() : gate);
      return { file: 'wiring-' + s.synthCalls.length + '.mp3', bytes: 16, durationMs: 120, provider: 'fake' };
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
      // A fake player process: it reports a real handle and exits shortly after, exactly like
      // ffplay closing. The host's process watcher (not a test timer) ends the clip.
      options?.onTransport?.({ exit: done, via: 'fake-player' });
      const timer = setTimeout(() => player.resolve(), s.playerMs ?? 80);
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
    export const resolveFfmpeg = () => null;
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
    export class SubtitleOverlay {
      constructor({ config }) { this.config = config; }
      async show() { return true; }
      async hide() {}
      async stop() {}
    }`,
      };
    }
    // The VTS socket is replaced by an in-process fake: `live2d.connect` really succeeds, so the
    // behavior runtime exists and is connected without opening a port.
    if (url === vtsUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
    export class VtsClient {
      constructor(options = {}) {
        this.options = options;
        this.ready = false;
        this.connected = false;
        this.connectPromise = null;
        this.model = null;
        this.modelId = '';
        this.hotkeys = [];
        this.expressions = [];
        this.animations = { current: null };
        this.writes = [];
        this.channels = null;
      }
      async connect() {
        this.ready = true;
        this.connected = true;
        this.model = { modelName: 'FakeHiyori' };
        this.modelId = 'fake-model';
        return { ok: true, model: this.model, modelId: this.modelId, hotkeys: [] };
      }
      async listInputParameters() {
        return {
          ok: true,
          defaultParameters: [
            { name: 'FaceAngleX', min: -30, max: 30, defaultValue: 0 },
            { name: 'FaceAngleY', min: -30, max: 30, defaultValue: 0 },
            { name: 'FaceAngleZ', min: -30, max: 30, defaultValue: 0 },
            { name: 'MouthOpen', min: 0, max: 1, defaultValue: 0 },
          ],
          customParameters: [],
        };
      }
      async listModelParameters() {
        return { ok: true, parameters: [{ name: 'ParamAngleX' }, { name: 'ParamAngleY' }, { name: 'ParamAngleZ' }, { name: 'ParamMouthOpenY' }] };
      }
      async injectInputs(entries) {
        this.writes.push(entries);
        return { ok: true, sent: true, acknowledged: true, rejected: [] };
      }
      async triggerHotkey() { return 'fake-hotkey'; }
      async triggerExpression() { return 'fake-expression'; }
      async moveModel() {}
      setChannelInputs(inputs) { this.channels = inputs; }
      close() { this.ready = false; this.connected = false; }
      // The status route projects the authorization block through this method.
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
    // Test 5 needs a runtime whose wiring calls throw. Everything else is the real runtime.
    if (url === avatarRuntimeUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
    import * as real from '${avatarRuntimeUrl}?voice-wiring-real';
    export const AVATAR_ERROR_CODES = real.AVATAR_ERROR_CODES;
    export const buildAvatarStylePrompt = real.buildAvatarStylePrompt;
    export const createAvatarStyleCache = real.createAvatarStyleCache;
    export const DEFAULT_AVATAR_STYLE = real.DEFAULT_AVATAR_STYLE;
    export const personaStyleVersion = real.personaStyleVersion;
    export function createAvatarRuntime(options) {
      const runtime = real.createAvatarRuntime(options);
      const wiring = globalThis.__voiceWiring;
      if (wiring?.throwWiring === true) {
        runtime.speechClip = () => { throw new Error('speechClip failed'); };
        runtime.speechEnd = () => { throw new Error('speechEnd failed'); };
        runtime.intentEvent = () => { throw new Error('intentEvent failed'); };
        runtime.markConclusion = () => { throw new Error('markConclusion failed'); };
        runtime.relax = () => { throw new Error('relax failed'); };
      }
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
const { apply, createAckLane } = await import('../src/host/index.js');
hooks.deregister();
after(() => { delete globalThis.__voiceWiring; });

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const ACK_LINE = '我这就去看看你说的天气情况';

async function waitUntil(check, message, timeoutMs = 8000) {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out: ${message}`);
    await tick(10);
  }
}

const readEvents = async (root) => {
  try {
    const text = await readFile(join(root, 'data', 'events.jsonl'), 'utf8');
    return text.trim().split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
};

/** One scripted typed reply lane round: turn/start → user/message → body → turn/end. */
const turnStart = (turn) => ({ type: 'turn/start', data: { turn } });
const userMessage = (turn, text = '说点什么') => ({
  type: 'user/message',
  data: {
    turn,
    id: `u-${turn}`,
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text }],
  },
});
const assistantBody = (turn, text) => ({
  type: 'assistant/message',
  data: {
    turn,
    step: 1,
    message: { id: `a-${turn}`, role: 'assistant', content: [{ type: 'text', text }] },
  },
});
const turnEnd = (turn) => ({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } });

async function mount(t, { settings = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-voice-wiring-'));
  await mkdir(join(root, 'data'), { recursive: true });
  await mkdir(join(root, 'workspace'), { recursive: true });
  await writeFile(join(root, 'data', 'features.json'), JSON.stringify({
    hearing: false,
    ambient: false,
    voice: true,
    avatar: true,
    subtitle: false,
    memory: false,
    fastpath: false,
  }));
  // P-65 chunking is ON so a long sentence really splits into two played blocks.
  await writeFile(join(root, 'data', 'settings.json'), JSON.stringify({
    gptSovits: { enabled: false },
    langs: { speech: 'zh', subtitle: 'zh' },
    typedReply: { voice: true },
    voice: { chunking: true },
    ...settings,
    ...(settings.voice ? { voice: { chunking: true, ...settings.voice } } : {}),
  }));
  state.players = [];
  state.synthCalls = [];
  state.throwWiring = false;
  state.synthGates = [];
  state.playerMs = 80;
  const handlers = [];
  const cleanups = [];
  const tools = new Map();
  const routes = new Map();
  const effect = (fn) => {
    const cleanup = fn();
    if (typeof cleanup === 'function') cleanups.push(cleanup);
    return cleanup;
  };
  const on = (type, handler) => {
    const entry = { type, handler };
    handlers.push(entry);
    return () => {
      const index = handlers.indexOf(entry);
      if (index >= 0) handlers.splice(index, 1);
    };
  };
  const registerRoute = (route) => {
    routes.set(route.path, route.handler);
    return () => routes.delete(route.path);
  };
  const scope = {
    effect,
    on,
    systemPrompt: { section: () => () => {} },
    webServer: { register: registerRoute },
  };
  apply({
    effect,
    on,
    // No model service: the typed lane speaks the body verbatim (no condense round trip).
    get: () => undefined,
    tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name); } },
    inject: (_deps, register) => register(scope),
    webServer: { register: registerRoute },
  }, { root, enabled: true });

  const session = { id: 'voice-wiring-session', header: { cwd: join(root, 'workspace') } };
  const emit = (event) => {
    for (const entry of [...handlers]) {
      if (entry.type === 'session/event') entry.handler(session, event);
    }
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
  const action = (body) => callRoute('/assistant/action', { body });
  const status = () => callRoute('/assistant/status', { method: 'GET' });
  const runtime = async () => (await status()).live2d.runtime;

  t.after(async () => {
    for (const player of [...state.players]) player.resolve();
    await tick(20);
    await disposeAll(cleanups.splice(0));
    await cleanupRoot(root);
  });

  return {
    root,
    session,
    emit,
    action,
    status,
    runtime,
    players: () => state.players,
    synthCalls: () => state.synthCalls,
    say: (args) => tools.get('assistant_say').execute(args),
    connectAvatar: async () => {
      const connected = await action({ action: 'live2d.connect' });
      assert.equal(connected.ok, true, `live2d.connect succeeded (${connected.error ?? ''})`);
      const view = await runtime();
      assert.equal(view.connected, true, 'the behavior runtime is connected');
      // Discovery is a background completion: a sentence head can only start a gesture once the
      // head channels are verified AND installed on the runtime, so tests wait for that boundary
      // instead of guessing a sleep (the runtime's own channel set is the one `intent()` consults).
      await waitUntil(async () => {
        const controlled = (await runtime())?.channels?.controlled ?? [];
        return controlled.includes('headY') && controlled.includes('headZ');
      }, 'avatar capability discovery installed the head channels');
      return runtime();
    },
    events: () => readEvents(root),
    waitForEvent: async (type, predicate = () => true, timeoutMs = 8000) => {
      try {
        const row = await waitUntil(
          async () => (await readEvents(root)).find((event) => event.type === type && predicate(event.payload ?? {})),
          `event ${type}`,
          timeoutMs,
        );
        return row.payload ?? {};
      } catch (error) {
        const rows = await readEvents(root);
        const lines = rows.map((row) => `${row.type}${row.payload?.reason ? `(${row.payload.reason})` : ''}`);
        throw new Error(`${error.message}; seen=[${lines.join(' ')}]`);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 1. A synthesizing body keeps the waiting line: kept row, no superseded row
// ---------------------------------------------------------------------------

test('1. a synthesizing body keeps the waiting line: voice.ack.kept, never superseded', async (t) => {
  const events = [];
  const plays = [];
  const lane = createAckLane({
    emit: async (type, payload) => { events.push({ type, payload }); },
    generate: async () => ACK_LINE,
    synthesize: async ({ speech }) => ({ file: 'ack.mp3', durationMs: 100, speech }),
    play: async ({ speech, signal }) => {
      let resolve;
      const done = new Promise((doneResolve) => { resolve = doneResolve; });
      const player = { speech, signal, startedAt: Date.now(), end: () => resolve() };
      plays.push(player);
      return { audioStartedAt: player.startedAt, done };
    },
    persona: () => '你是小音，说话温柔简短。',
    captureSignal: () => new AbortController().signal,
    delayMs: 80,
    timeoutMs: () => 100,
  });
  lane.beginTurn({ sessionId: 's-kept', turn: 2, userText: '帮我查一下明天的天气' });
  await tick(10);
  assert.equal(lane.bodySynthesizing({ sessionId: 's-kept', turn: 2 }), true,
    'the body is synthesizing at the two-second trigger');
  await waitUntil(() => plays.length === 1, 'the kept line reached the player');
  const kept = await waitUntil(() => events.find((event) => event.type === 'voice.ack.kept'),
    'voice.ack.kept is written');
  await waitUntil(() => events.some((event) => event.type === 'voice.ack.spoken'), 'the spoken row');
  assert.equal(kept.payload.turn, 2);
  assert.equal(kept.payload.reason, 'body-synthesizing');
  assert.equal(kept.payload.bodyPhase, 'synthesizing');
  assert.equal(events.filter((event) => event.type === 'voice.ack.superseded').length, 0,
    'no superseded row exists for a kept line');
  assert.equal(events.filter((event) => event.type === 'voice.ack.cancelled').length, 0,
    'a synthesizing body never cancels the line');
  plays[0].end();
  await lane.whenIdle();
  t.diagnostic(`kept turn=${kept.payload.turn} reason=${kept.payload.reason} `
    + `bodyPhase=${kept.payload.bodyPhase} superseded=0 cancelled=0 plays=${plays.length}`);
});

// ---------------------------------------------------------------------------
// 2. P-54: three played blocks, two sentences → two clip starts/ends + speechEnd
// ---------------------------------------------------------------------------

test('2. three blocks across two sentences report two clip starts/ends and close the session', async (t) => {
  const app = await mount(t);
  await app.connectAvatar();
  const before = await app.runtime();
  assert.equal(before.speech.clip.starts, 0);
  // The turn's own thinking gesture must have finished before the first sentence, otherwise the
  // runtime legitimately defers the sentence-head intent (that rule is tested in 4).
  app.emit(turnStart(1));
  app.emit(userMessage(1));
  await tick(1000);
  app.emit(assistantBody(1, '今天上海的天气有点凉，出门记得带一件外套。路上小心。'));
  app.emit(turnEnd(1));
  await app.waitForEvent('voice.typed.spoken');
  // Three played blocks: the long sentence split at its comma (2) plus the short one (1).
  assert.equal(app.synthCalls().length, 3, `three blocks were synthesized (${JSON.stringify(app.synthCalls())})`);
  assert.equal(app.players().length, 3, 'three blocks reached the player');
  const clip = (await app.runtime()).speech.clip;
  assert.equal(clip.starts, 2, 'one clip start per spoken sentence');
  assert.equal(clip.ends, 2, 'one clip end per spoken sentence');
  assert.equal(clip.session, false, 'the last clip end closed the speech session');
  assert.equal(clip.active, false, 'no clip is active after the queue drained');
  assert.ok(Number.isInteger(clip.timed) && clip.timed <= clip.starts,
    `timed starts stay within the reported clip starts (timed=${clip.timed})`);
  assert.equal(clip.index, 1, 'the last reported sentence index is the second sentence');
  t.diagnostic(`blocks=${app.synthCalls().length} starts=${clip.starts} ends=${clip.ends} `
    + `timed=${clip.timed} session=${clip.session} index=${clip.index}`);
});

// ---------------------------------------------------------------------------
// 3. P-139: answer-start once at the first sentence head, never per block
// ---------------------------------------------------------------------------

test('3. answer-start is reported once at the first sentence head, never per block', async (t) => {
  const app = await mount(t);
  await app.connectAvatar();
  app.emit(turnStart(1));
  app.emit(userMessage(1));
  await tick(1000);
  // One sentence that really splits into two played blocks.
  app.emit(assistantBody(1, '今天上海的天气有点凉，出门记得带一件外套。'));
  app.emit(turnEnd(1));
  const first = await waitUntil(async () => {
    const view = await app.runtime();
    return view.speech.clip.starts === 1 ? view : null;
  }, 'the first sentence started');
  assert.equal(first.intentEvents.calls['answer-start'], 1,
    'the first sentence head reported exactly one answer-start');
  await app.waitForEvent('voice.typed.spoken');
  const view = await app.runtime();
  const calls = view.intentEvents.calls;
  assert.equal(calls['answer-start'], 1, 'the second block did not report answer-start again');
  assert.ok(view.intentEvents.started >= 1, 'the first-sentence intent became a real action');
  assert.equal(view.speech.clip.starts, 1, 'the two blocks stayed one sentence');
  t.diagnostic(`blocks=${app.synthCalls().length} answerStartCalls=${calls['answer-start']} `
    + `staged=${view.intentEvents.staged} started=${view.intentEvents.started} `
    + `lastEvent=${view.intentEvents.lastEvent} starts=${view.speech.clip.starts}`);
});

// ---------------------------------------------------------------------------
// 4. P-139: a turn switch advances the generation and drops the staged intent
// ---------------------------------------------------------------------------

test('4. a turn switch advances the generation and drops the previous staged intent', async (t) => {
  const app = await mount(t);
  // A long-sounding clip: the switch happens while turn 1's sentence is still playing.
  state.playerMs = 2000;
  await app.connectAvatar();
  // No wait: turn 1's thinking gesture is still running when its first sentence starts, so the
  // sentence-head intent waits in the one slot (the runtime's own deferral rule).
  app.emit(turnStart(1));
  app.emit(userMessage(1));
  app.emit(assistantBody(1, '第一句先分成两块，第二句单独一块。'));
  app.emit(turnEnd(1));
  await waitUntil(async () => (await app.runtime()).speech.clip.starts === 1, 'the first sentence started');
  const before = await app.runtime();
  // New contract: answer-start resolves at the first body clip start — released or explicitly
  // dropped, never carried over to speechEnd in a different state.
  assert.equal(before.intentEvents.pending, null, 'the first-sentence intent is resolved at the clip boundary');
  assert.equal(before.intentEvents.calls['answer-start'], 1);
  const generationBefore = before.intentEvents.generation;
  const droppedBefore = before.intentEvents.dropped;
  const startedBefore = before.intentEvents.started;
  // Turn 2 begins while turn 1's clip is still sounding.
  app.emit(turnStart(2));
  const after = await app.runtime();
  assert.equal(after.intentEvents.generation, generationBefore + 1, 'the generation advanced once');
  assert.equal(after.intentEvents.turnId, 2, 'the runtime tracks turn 2');
  // The staged answer-start already resolved at the clip start, so the turn switch carries no
  // stale intent forward; it only advances the generation and stages turn 2's own phase.
  assert.ok(after.intentEvents.dropped >= droppedBefore, 'nothing was revived by the switch');
  assert.equal(after.intentEvents.lastEvent, 'thinking', 'turn 2 stages its own phase');
  // The switch must not revive the resolved answer-start; the runtime stages only turn 2's phase.
  assert.notEqual(after.intentEvents.pending?.event, 'answer-start',
    'no stale answer-start is carried into turn 2');
  t.diagnostic(`generation=${generationBefore}->${after.intentEvents.generation} `
    + `turnId=${after.intentEvents.turnId} dropped=${droppedBefore}->${after.intentEvents.dropped} `
    + `started=${startedBefore}->${after.intentEvents.started} pendingBefore=answer-start`);
});

// ---------------------------------------------------------------------------
// 5. A throwing runtime is debug-only: the announcement still plays to its end
// ---------------------------------------------------------------------------

test('5. a throwing runtime never disturbs playback and is reported as debug only', async (t) => {
  const app = await mount(t);
  state.throwWiring = true;
  try {
    await app.connectAvatar();
    const said = await app.say({ text: '这是一句测试播报。' });
    assert.equal(said.accepted, true, `the line was accepted (${said.reason ?? ''})`);
    await waitUntil(() => app.players().length === 1, 'the clip reached the player');
    app.players()[0].resolve();
    const end = await app.waitForEvent('voice.playback.end');
    assert.equal(end.endReason, 'end', 'the clip really ended');
    assert.equal(end.source, 'process', 'the player exit was the end signal');
    await app.waitForEvent('speech.finish');
    const failures = (await app.events()).filter((event) => event.type === 'avatar.wiring.failed');
    assert.ok(failures.length >= 2, `the wiring failures are recorded (${failures.length})`);
    for (const row of failures) {
      assert.equal(row.payload.level, 'debug', 'a wiring failure is a debug row only');
      assert.equal(typeof row.payload.call, 'string');
    }
    t.diagnostic(`playbackEnd=${end.endReason}/${end.source} wiringFailures=${failures.length} `
      + `calls=${[...new Set(failures.map((row) => row.payload.call))].join(',')}`);
  } finally {
    state.throwWiring = false;
  }
});

// ---------------------------------------------------------------------------
// 6. P-139v: the conclusion follows the sentence that really sounds, not the arriving text
// ---------------------------------------------------------------------------

test('6. 结论在第三句 clip 开始时才触发，不在文字到达时', async (t) => {
  const app = await mount(t);
  await app.connectAvatar();
  state.playerMs = 1500;
  app.emit(turnStart(1));
  app.emit(userMessage(1, '帮我安排一下迁移'));
  // The conclusion is the THIRD sentence, and its text arrives while nothing has played yet.
  app.emit(assistantBody(1, '第一句话说明背景。第二句话给出建议。结论是周五之前完成。'));
  await tick(120);
  assert.equal(app.players().length, 0, '正文到达时还没有任何播放器');
  assert.equal((await app.runtime()).wiring.conclusion, 0, '文字到达不触发结论动作');
  app.emit(turnEnd(1));
  // Two sentences have sounded; the third has not started, so the gesture must still be absent.
  await waitUntil(() => app.players().length === 2, '前两句都到了播放器');
  assert.equal((await app.runtime()).wiring.conclusion, 0, '第二句播放时结论尚未触发');
  // The third clip starts: one mark, at sentence index 2, while the third player is sounding.
  await waitUntil(() => app.players().length === 3, '第三句到达播放器');
  const view = await app.runtime();
  assert.equal(view.wiring.conclusion, 1, '第三句 clip 开始时触发一次结论动作');
  assert.equal(view.intentEvents.conclusions.marked, 1, '运行时只接纳一次结论');
  assert.equal(view.speech.clip.index, 2, '触发所在句索引是第三句（2）');
  const deferred = await app.waitForEvent('avatar.conclusion.deferred', (p) => p.matched === true);
  assert.equal(deferred.sentenceIndex, 2, 'deferred 记录的是第三句');
  await app.waitForEvent('voice.typed.spoken');
  t.diagnostic(`playersAtTrigger=${app.players().length} clipIndex=${view.speech.clip.index} `
    + `wiring=${view.wiring.conclusion} marked=${view.intentEvents.conclusions.marked} `
    + `deferred=${deferred.matched}@${deferred.sentenceIndex}`);
});

// ---------------------------------------------------------------------------
// 7. P-139v: a conclusion sentence the spoken version dropped never triggers
// ---------------------------------------------------------------------------

test('7. 结论句被口语版丢弃：不触发，只有 deferred{matched:false}', async (t) => {
  // The speech budget only covers the first two sentences: the conclusion is never spoken.
  const app = await mount(t, { settings: { voice: { chunking: true, speechMaxChars: 24 } } });
  await app.connectAvatar();
  app.emit(turnStart(1));
  app.emit(userMessage(1, '简单说说迁移'));
  app.emit(assistantBody(1, '先备份数据库再迁移系统。然后检查迁移结果。结论是周五之前完成。'));
  app.emit(turnEnd(1));
  await app.waitForEvent('voice.typed.spoken');
  const view = await app.runtime();
  assert.equal(app.synthCalls().length, 2, `口语版只播前两句 (${JSON.stringify(app.synthCalls())})`);
  assert.equal(app.players().length, 2, '只有两句真的到了播放器');
  assert.equal(view.wiring.conclusion, 0, '未被播出的结论句不触发动作');
  assert.equal(view.intentEvents.conclusions.marked, 0, '运行时没有结论');
  const rows = (await app.events()).filter((event) => event.type === 'avatar.conclusion.deferred');
  assert.equal(rows.length, 1, '每轮只留一条节流的 deferred 行');
  assert.equal(rows[0].payload.matched, false, 'deferred 指出这一句不是结论');
  assert.equal(rows[0].payload.level, 'debug', 'deferred 只是 debug 行');
  assert.equal(rows[0].payload.sentenceIndex, 0, '判断发生在实际播出句（第一句）');
  t.diagnostic(`synth=${app.synthCalls().length} players=${app.players().length} `
    + `wiring=${view.wiring.conclusion} deferred=${rows.length}/matched:${rows[0].payload.matched} `
    + `@${rows[0].payload.sentenceIndex}`);
});

// ---------------------------------------------------------------------------
// 8. P-139v: an ordinary user question is NOT the assistant's confusion
// ---------------------------------------------------------------------------

test('8. 普通提问「今天是否周六」不触发 confused', async (t) => {
  const app = await mount(t);
  await app.connectAvatar();
  app.emit(turnStart(1));
  app.emit(userMessage(1, '今天是否周六'));
  app.emit(assistantBody(1, '今天是周六。'));
  app.emit(turnEnd(1));
  await app.waitForEvent('voice.typed.spoken');
  const view = await app.runtime();
  assert.equal(view.wiring.confused, 0, '用户提问词不再触发困惑');
  assert.equal(view.intentEvents.calls.confused, 0, '运行时没有收到 confused 相位');
  const rows = (await app.events()).filter((event) => event.type === 'avatar.confused.trigger');
  assert.equal(rows.length, 0, '没有 confused.trigger 行');
  t.diagnostic(`wiring=${view.wiring.confused} calls=${view.intentEvents.calls.confused} triggers=${rows.length}`);
});

// ---------------------------------------------------------------------------
// 9. P-139v: only the assistant's own "I did not hear / say that again" triggers
// ---------------------------------------------------------------------------

test('9. 助手说「我没听清，你再说一遍」触发一次 confused', async (t) => {
  const app = await mount(t);
  await app.connectAvatar();
  app.emit(turnStart(1));
  app.emit(userMessage(1, '你刚才说什么'));
  app.emit(assistantBody(1, '我没听清，你再说一遍。'));
  app.emit(turnEnd(1));
  await app.waitForEvent('voice.typed.spoken');
  const view = await app.runtime();
  assert.equal(view.wiring.confused, 1, '助手自己的没听清触发一次');
  assert.equal(view.intentEvents.calls.confused, 1, '运行时收到一次 confused 相位');
  const rows = (await app.events()).filter((event) => event.type === 'avatar.confused.trigger');
  assert.equal(rows.length, 1, '一条 debug trigger 行便于观察');
  assert.equal(rows[0].payload.level, 'debug', 'trigger 只是 debug 行');
  assert.equal(rows[0].payload.phrase, '没听清', '记录命中的短语');
  t.diagnostic(`wiring=${view.wiring.confused} calls=${view.intentEvents.calls.confused} `
    + `trigger=${rows.length} phrase=${rows[0].payload.phrase}`);
});

// ---------------------------------------------------------------------------
// 10. P-139v: at most one conclusion and one confused phase per turn
// ---------------------------------------------------------------------------

test('10. 每轮最多一次：两个结论句/两处困惑提示都只各触发一次', async (t) => {
  const app = await mount(t);
  await app.connectAvatar();
  app.emit(turnStart(1));
  app.emit(userMessage(1, '说清楚点'));
  // Two conclusion leads and two confused phrases in one turn.
  app.emit(assistantBody(1, '结论是周五之前完成。总之先备份数据。我没听清，你再说一遍。'));
  app.emit(turnEnd(1));
  await app.waitForEvent('voice.typed.spoken');
  const view = await app.runtime();
  assert.equal(view.wiring.conclusion, 1, '同轮第二个结论句不再 mark');
  assert.equal(view.intentEvents.conclusions.marked, 1, '运行时只接纳一次结论');
  assert.equal(view.wiring.confused, 1, '同轮第二处困惑提示不再触发');
  assert.equal(view.intentEvents.calls.confused, 1, '运行时只收到一次 confused 相位');
  const deferred = (await app.events()).filter((event) => event.type === 'avatar.conclusion.deferred'
    && event.payload?.matched === true);
  assert.equal(deferred.length, 1, '结论只被认领一次');
  const triggers = (await app.events()).filter((event) => event.type === 'avatar.confused.trigger');
  assert.equal(triggers.length, 1, '困惑只被认领一次');
  t.diagnostic(`conclusion=${view.wiring.conclusion}/marked:${view.intentEvents.conclusions.marked} `
    + `confused=${view.wiring.confused}/calls:${view.intentEvents.calls.confused} `
    + `deferred=${deferred.length} triggers=${triggers.length}`);
});

// ---------------------------------------------------------------------------
// 11. relax only at the answer end, once, and never mid-answer
// ---------------------------------------------------------------------------

test('11. 回答结束且无后续语音才 relax 一次', async (t) => {
  const app = await mount(t);
  await app.connectAvatar();
  // Hold the SECOND sentence in TTS: the first clip ends while the answer is still unfinished.
  let releaseSecond = null;
  const secondGate = new Promise((resolve) => { releaseSecond = resolve; });
  state.synthGates = [null, () => secondGate];
  app.emit(turnStart(1));
  app.emit(userMessage(1, '说两句'));
  app.emit(assistantBody(1, '第一句先说明背景。第二句给出建议。'));
  app.emit(turnEnd(1));
  await app.waitForEvent('voice.playback.end');
  await tick(80);
  assert.equal((await app.runtime()).wiring.relax, 0,
    'a finished clip is not the answer end: the second sentence is still queued in the answer');
  releaseSecond();
  await app.waitForEvent('voice.typed.spoken');
  await waitUntil(async () => (await app.runtime()).wiring.relax === 1, 'relax is called once');
  const view = await app.runtime();
  assert.equal(view.wiring.relax, 1, 'exactly one relax call for the answer');
  assert.equal(view.motion.relaxTransitions, 1, 'the runtime planned exactly one 2–4 s relax');
  assert.equal(app.synthCalls().length, 2, 'both sentences really went through TTS');
  t.diagnostic(`relax=${view.wiring.relax} planned=${view.motion.relaxTransitions} `
    + `sentences=${app.synthCalls().length} players=${app.players().length}`);
});

// ---------------------------------------------------------------------------
// 12. A throwing wiring call is debug only: the answer is still spoken to its end
// ---------------------------------------------------------------------------

test('12. 接线调用抛错只记 debug，播报照常完成', async (t) => {
  const app = await mount(t);
  state.throwWiring = true;
  try {
    await app.connectAvatar();
    app.emit(turnStart(1));
    app.emit(userMessage(1, '继续'));
    // The answer's own words carry both wiring cues: a conclusion lead and a confusion phrase.
    app.emit(assistantBody(1, '结论是再试一次。我没听清。'));
    app.emit(turnEnd(1));
    await app.waitForEvent('voice.typed.spoken');
    assert.ok(app.synthCalls().length >= 1, 'the answer was still synthesized');
    assert.ok(app.players().length >= 1, 'the answer was still played');
    const events = await app.events();
    const failures = events.filter((event) => event.type === 'avatar.wiring.failed');
    const calls = new Set(failures.map((row) => row.payload.call));
    for (const call of ['confused', 'markConclusion', 'relax']) {
      assert.ok(calls.has(call), `the failed ${call} call is recorded (${[...calls].join(',')})`);
    }
    for (const row of failures) {
      assert.equal(row.payload.level, 'debug', 'a wiring failure is a debug row only');
    }
    assert.ok(events.some((event) => event.type === 'voice.playback.end'), 'playback still ended');
    t.diagnostic(`failures=${failures.length} calls=${[...calls].join(',')} `
      + `synthesized=${app.synthCalls().length} played=${app.players().length}`);
  } finally {
    state.throwWiring = false;
  }
});

// ---------------------------------------------------------------------------
// 13. Turning is machinery; only the user's own typed message interrupts
// ---------------------------------------------------------------------------

test('13. turn/start never pauses the typed reply; a typed message does', async (t) => {
  const app = await mount(t);
  // One long clip, so the continuation turn arrives while the answer is really sounding.
  state.playerMs = 2000;
  app.emit(turnStart(1));
  app.emit(userMessage(1, '说两句'));
  app.emit(assistantBody(1, '第一句。'));
  app.emit(turnEnd(1));
  await waitUntil(() => app.players().length === 1, 'the typed reply reached the player');
  // An agent continuation opens turn 2 with no user message: the answer keeps sounding.
  app.emit(turnStart(2));
  await tick(150);
  const rows = await app.events();
  assert.equal(
    rows.filter((event) => event.type === 'speech.cancelled').length,
    0,
    'turn/start is not a cancellation trigger',
  );
  const keep = rows.find((event) => event.type === 'voice.speech.keep');
  assert.equal(keep?.payload?.reason, 'internal-turn');
  assert.equal(app.players().length, 1, 'the clip survived the internal turn');
  // The user's own typed message IS the interruption.
  app.emit(userMessage(2, '换一句'));
  const cancelled = await app.waitForEvent('speech.cancelled');
  assert.equal(cancelled.reason, 'user-input');
  t.diagnostic(`turn2 start: cancelled=0 keep=${keep?.payload?.reason}; typed input: ${cancelled.reason}`);
});
