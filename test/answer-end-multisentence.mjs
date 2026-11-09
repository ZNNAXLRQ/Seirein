/**
 * answer-end / avatarSpeechEnd must fire ONCE per whole reply, never at a sentence gap.
 *
 * The old `markEnded` reported the answer end whenever (a) the clip was the reply body, (b) it
 * ended naturally, and (c) `playbackQueued()` was false. A sentence-by-sentence reply has an empty
 * playback queue between two sentences — the next sentence's `play()` is only requested after the
 * current clip's `done` settles — so every sentence looked like the end of the answer. Two voice
 * rounds produced 32 answer-end actions in the reported trace (one `end-center`/`end-tilt` per
 * sentence), which read as a small jitter at every sentence boundary.
 *
 * The fix keeps a per-answer `bodyOpen` state: only the producer's own body-closed signal (the
 * reply speaker's `finish()` resolving, or the fast reply stream returning) seals the round. A
 * natural sentence end is only a candidate; it becomes the answer end after the seal, once, when
 * the queue is empty. Cancelled/interrupted rounds are closed without ever committing.
 *
 * Pinned here with real host mounting, scripted TTS and fake players:
 *   1. multi-sentence playback (empty queue between sentences) → answer-end only after the LAST;
 *   2. single sentence → exactly one;
 *   3. a barge-in / user cancellation after the first sentence ended naturally → zero;
 *   4. an ack (waiting line) end and a tool `assistant_say` end → zero.
 *
 * Run: node --test test/answer-end-multisentence.mjs
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
  /** How long a fake player takes to exit when a test does not resolve it explicitly. */
  playerMs: 15000,
};
globalThis.__answerEndMulti = state;

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
    const s = globalThis.__answerEndMulti;
    export { resolveGptLangs, resolveGptSovitsTimeout } from '${ttsUrl}?answer-end-helpers';
    export { speakChunks, speechChunkTexts, resolveChunkMinChars } from '${ttsUrl}?answer-end-chunk';
    export const configureTts = () => {};
    export const gptSovitsReferenceStatus = async () => ({ seconds: null, ok: false, readable: false });
    export const warmupGptSovits = async () => ({ ok: false, skipped: 'disabled' });
    export const applyGptSovitsModels = () => ({ ok: true });
    export const synthesize = async (options) => {
      s.synthCalls.push({ text: String(options?.text ?? ''), purpose: String(options?.purpose ?? '') });
      return { file: 'answer-end-' + s.synthCalls.length + '.mp3', bytes: 16, durationMs: 120, provider: 'fake' };
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
      // A fake player process: the host's own process watcher (not a test timer) ends the clip.
      options?.onTransport?.({ exit: done, via: 'fake-player' });
      const timer = setTimeout(() => player.resolve(), s.playerMs ?? 15000);
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
        this.model = { modelName: 'FakeAnswerEnd' };
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
      async injectInputs(entries) { this.writes.push(entries); return { ok: true, sent: true, acknowledged: true, rejected: [] }; }
      async triggerHotkey() { return 'fake-hotkey'; }
      async triggerExpression() { return 'fake-expression'; }
      async moveModel() {}
      setChannelInputs(inputs) { this.channels = inputs; }
      close() { this.ready = false; this.connected = false; }
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
after(() => { delete globalThis.__answerEndMulti; });

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
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
  const root = await mkdtemp(join(tmpdir(), 'dsh-answer-end-multi-'));
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
  // Sentence-level splitting stays ON (`takeSentences`); chunking is OFF so one sentence is one
  // player. That makes the sentence gap the only thing between two players.
  await writeFile(join(root, 'data', 'settings.json'), JSON.stringify({
    gptSovits: { enabled: false },
    langs: { speech: 'zh', subtitle: 'zh' },
    typedReply: { voice: true },
    voice: { chunking: false },
    ...settings,
    ...(settings.voice ? { voice: { chunking: false, ...settings.voice } } : {}),
  }));
  state.players = [];
  state.synthCalls = [];
  state.playerMs = 15000;
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
  }, { root, enabled: true, presetExecution: false });

  const session = { id: 'answer-end-multi-session', header: { cwd: join(root, 'workspace') } };
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

  const connected = await action({ action: 'live2d.connect' });
  assert.equal(connected.ok, true, `live2d.connect succeeded (${connected.error ?? ''})`);
  await waitUntil(async () => {
    const controlled = (await runtime())?.channels?.controlled ?? [];
    return controlled.includes('headY') && controlled.includes('headZ');
  }, 'avatar capability discovery installed the head channels');

  return {
    root,
    emit,
    action,
    status,
    runtime,
    players: () => state.players,
    synthCalls: () => state.synthCalls,
    say: (args) => tools.get('assistant_say').execute(args),
    events: () => readEvents(root),
  };
}

const answerEndCalls = async (app) => (await app.runtime()).intentEvents.calls['answer-end'] ?? 0;
/**
 * Cross-check the host call count against the runtime's own admission/settle counters. The host's
 * `avatarRuntimeLog` only forwards selected debug rows, so an answer-end intent is NOT in
 * events.jsonl; the runtime status is the authoritative evidence for it.
 */
const answerEndStatus = async (app) => {
  const view = await app.runtime();
  return {
    calls: view.intentEvents.calls['answer-end'] ?? 0,
    staged: view.intentEvents.staged ?? 0,
    settled: view.intentEvents.settled ?? 0,
    lastEvent: view.intentEvents.lastEvent ?? '',
    pending: view.intentEvents.pending?.event ?? null,
  };
};
/** Natural sentence ends really observed by the playback layer (one per sentence). */
const naturalPlaybackEnds = async (app) => (await app.events())
  .filter((event) => event.type === 'voice.playback.end' && event.payload?.endReason === 'end');
/** Real end-action trace for answer-end (the reported jitter): must never exceed one per answer. */
const answerEndTraces = async (app) => ((await app.runtime()).motion?.actionTrace ?? [])
  .filter((trace) => trace.event === 'answer-end');

// =============================================================================================
// 1. Multi-sentence: empty queue between sentences is NOT the answer end.
// =============================================================================================
test('1. 多句流式：句间队列空不报 answer-end，最后一句播完才恰好一次', async (t) => {
  const app = await mount(t);
  state.playerMs = 15000;
  app.emit(turnStart(1));
  app.emit(userMessage(1, '说三句'));
  app.emit(assistantBody(1, '第一句先说明背景。第二句给出建议。最后一句是结论。'));
  app.emit(turnEnd(1));

  await waitUntil(() => app.players().length >= 1, 'the first sentence reached the player');
  assert.equal(await answerEndCalls(app), 0, 'nothing is an answer end while the first sentence sounds');

  // Finish sentence 1 naturally: the playback queue is empty until sentence 2 requests the seat.
  // This is exactly the gap that used to report a false answer end.
  app.players()[0].resolve();
  await waitUntil(() => app.players().length >= 2, 'the second sentence reached the player');
  await tick(150);
  assert.equal(await answerEndCalls(app), 0,
    'a sentence gap (queue empty, body still open) must not report the answer end');
  let gap = await app.runtime();
  assert.notEqual(gap.intentEvents.lastEvent, 'answer-end', 'the runtime admitted no answer-end at the first gap');
  assert.notEqual(gap.intentEvents.pending?.event, 'answer-end', 'no answer-end waits in the intent slot');
  assert.equal((await answerEndTraces(app)).length, 0, 'no answer-end action trace exists at the first gap');

  app.players()[1].resolve();
  await waitUntil(() => app.players().length >= 3, 'the third sentence reached the player');
  await tick(150);
  assert.equal(await answerEndCalls(app), 0, 'the second gap is not the answer end either');
  gap = await app.runtime();
  assert.notEqual(gap.intentEvents.lastEvent, 'answer-end', 'the runtime admitted no answer-end at the second gap');
  assert.equal((await answerEndTraces(app)).length, 0, 'no answer-end action trace exists at the second gap');
  assert.equal((await app.runtime()).speech.clip.session, true,
    'the speech session is still open while a later sentence is queued');
  // The playback layer really observed three sentence ends; only the answer-end may be one.
  await waitUntil(async () => (await naturalPlaybackEnds(app)).length === 2,
    'the first two sentence playback ends are recorded');

  const last = app.players()[2];
  last.resolve();
  await waitUntil(async () => (await answerEndCalls(app)) === 1, 'the answer end after the last sentence');
  await waitUntil(async () => (await app.events()).some((event) => event.type === 'voice.typed.spoken'),
    'the typed speaker reported its whole round finished');
  await waitUntil(async () => (await naturalPlaybackEnds(app)).length === 3,
    'the third sentence playback end is recorded');
  await tick(200);

  const status = await answerEndStatus(app);
  const ends = await naturalPlaybackEnds(app);
  assert.equal(status.calls, 1, `exactly one answer end for the whole answer (${status.calls})`);
  assert.equal(status.lastEvent, 'answer-end', 'the runtime admitted the answer-end phase');
  assert.equal(ends.length, 3, `three natural sentence ends, one answer end (${ends.length})`);
  assert.ok((await answerEndTraces(app)).length <= 1, 'never more than one answer-end action trace');
  // The third natural end was the one that closed the answer: the two earlier gaps never did.
  assert.ok(last.endedAt > 0, 'the last sentence has a real end instant');
  t.diagnostic(`players=${app.players().length} sentenceEnds=${ends.length} answerEnd=${status.calls} `
    + `lastEvent=${status.lastEvent} traces=${(await answerEndTraces(app)).length} lastEndedAt=${last.endedAt}`);
});

// =============================================================================================
// 2. Single sentence: still exactly one answer end.
// =============================================================================================
test('2. 单句：恰好一次 answer-end', async (t) => {
  const app = await mount(t);
  app.emit(turnStart(1));
  app.emit(userMessage(1, '说一句'));
  app.emit(assistantBody(1, '只有这一句回答。'));
  app.emit(turnEnd(1));

  await waitUntil(() => app.players().length === 1, 'the only sentence reached the player');
  assert.equal(await answerEndCalls(app), 0, 'no answer end before the sentence finishes');
  app.players()[0].resolve();
  await waitUntil(async () => (await answerEndCalls(app)) === 1, 'the single answer end');
  await waitUntil(async () => (await app.events()).some((event) => event.type === 'voice.typed.spoken'),
    'the typed speaker finished');
  await tick(200);
  const status = await answerEndStatus(app);
  assert.equal(status.calls, 1, 'the single sentence reports exactly one answer end');
  assert.equal(status.lastEvent, 'answer-end', 'the runtime admitted the answer-end phase');
  assert.equal((await naturalPlaybackEnds(app)).length, 1, 'one natural sentence end');
  assert.ok((await answerEndTraces(app)).length <= 1, 'at most one answer-end action trace');
  t.diagnostic(`answerEnd=${status.calls} naturalEnds=1 `
    + `traces=${(await answerEndTraces(app)).length}`);
});

// =============================================================================================
// 3. Barge-in / cancellation: a natural first sentence must not become the answer end.
// =============================================================================================
test('3. barge-in/取消：第一句自然结束后的取消不产生 answer-end', async (t) => {
  const app = await mount(t);
  app.emit(turnStart(1));
  app.emit(userMessage(1, '说三句'));
  app.emit(assistantBody(1, '第一句先说明背景。第二句给出建议。最后一句是结论。'));
  app.emit(turnEnd(1));

  await waitUntil(() => app.players().length >= 1, 'the first sentence reached the player');
  app.players()[0].resolve();
  await waitUntil(() => app.players().length >= 2, 'the second sentence reached the player');
  await tick(120);
  assert.equal(await answerEndCalls(app), 0, 'the first sentence end is only a candidate');

  // The user cancels the answer between two sentences (second clip sounding, no queued playback).
  app.emit(userMessage(2, '先别说了'));
  await waitUntil(async () => (await app.events()).some((event) => event.type === 'speech.cancelled'),
    'the sounding reply clip was cancelled');
  await tick(300);
  const status = await answerEndStatus(app);
  assert.equal(status.calls, 0, 'a barge-in/cancel never reports answer-end');
  assert.equal(status.settled, 0, 'a cancelled answer never settles the pose');
  assert.equal((await answerEndTraces(app)).length, 0, 'a cancelled answer has no answer-end action trace');

  const last = app.players()[app.players().length - 1];
  if (last) last.resolve();
  await tick(200);
  assert.equal(await answerEndCalls(app), 0, 'settling the cancelled clip never revives the answer end');
  t.diagnostic(`players=${app.players().length} answerEnd=${await answerEndCalls(app)}`);
});

// =============================================================================================
// 4. Ack (waiting line): its own natural end is not an answer end.
// =============================================================================================
test('4. 候音（ack）自然结束不产生 answer-end', async (t) => {
  const app = await mount(t, { settings: { voice: { ackDelayMs: 200 } } });
  app.emit(turnStart(1));
  app.emit(userMessage(1, '帮我查一下明天的天气'));

  await waitUntil(() => app.players().length >= 1, 'the waiting line reached the player');
  assert.equal(await answerEndCalls(app), 0, 'no answer end while the waiting line sounds');
  const ack = app.players()[0];
  ack.resolve();
  await waitUntil(async () => (await app.events()).some((event) => event.type === 'voice.playback.end'),
    'the ack clip finished');
  await tick(250);
  const status = await answerEndStatus(app);
  assert.equal(status.calls, 0, 'an ack end is never an answer end');
  assert.equal(status.settled, 0, 'an ack end never settles the pose');
  assert.equal((await answerEndTraces(app)).length, 0, 'an ack end has no answer-end action trace');
  t.diagnostic(`ackPlayers=${app.players().length} answerEnd=${status.calls}`);
});

// =============================================================================================
// 5. Tool `assistant_say`: a whole-line tool clip end is not an answer end.
// =============================================================================================
test('5. 工具 assistant_say 整行结束不产生 answer-end', async (t) => {
  const app = await mount(t, { settings: { voice: { ackDelayMs: 60000 } } });
  app.emit(turnStart(1));
  app.emit(userMessage(1, '说一句'));
  const said = await app.say({ text: '我先去查一下，稍等。', purpose: 'explicit' });
  assert.equal(said.accepted, true, `the tool line was accepted (${said.reason ?? ''})`);

  await waitUntil(() => app.players().length >= 1, 'the tool line reached the player');
  assert.equal(await answerEndCalls(app), 0, 'no answer end while the tool line sounds');
  app.players()[0].resolve();
  await waitUntil(async () => (await app.events()).some((event) => event.type === 'voice.playback.end'),
    'the tool clip finished');
  await tick(200);
  const status = await answerEndStatus(app);
  assert.equal(status.calls, 0, 'a tool line end is never an answer end');
  assert.equal(status.settled, 0, 'a tool line end never settles the pose');
  assert.equal((await answerEndTraces(app)).length, 0, 'a tool line end has no answer-end action trace');
  t.diagnostic(`toolPlayers=${app.players().length} answerEnd=${status.calls}`);
});
