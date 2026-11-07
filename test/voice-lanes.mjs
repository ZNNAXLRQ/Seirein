/**
 * Voice lanes: the waiting line (候音), the unified Markdown outlet, and subtitle timing.
 *
 * The lane (`createAckLane`) is driven with injected seams so the two-second deadline, the
 * pre-generation/pre-synthesis, cancellation and the late-result rules are exact; the trigger and
 * the tool-independence are driven through the real mounted host (`apply` + the session event
 * feed), with a fake TTS/player/overlay. No sound, network, capture, TTS service or GUI is used.
 *
 * Covered:
 *   1. the reply body starting inside the deadline cancels the line: nothing plays
 *   2. no reply body after two seconds plays exactly one line, 10–30 characters
 *   3. one line per turn, however often the trigger is repeated
 *   4. a reply body ready before the line started cancels it (including its synthesis)
 *   5. an interrupt or a newer turn cancels the old line; a late draft never plays
 *   6. a voice-disabled session never triggers the line
 *   7. tool calls (any name/category) neither trigger nor suppress the line
 *   8. the event row carries ackTriggerMs, ackReadyMs, ackFirstAudioMs and bodyFirstAudioMs
 *   9. a line already playing finishes first; the answer starts after it
 *  10–18. Markdown speech/caption, streamed fragments and the code-block rules
 *
 * Run: node --test test/voice-lanes.mjs
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { registerHooks } from 'node:module';
import { Readable } from 'node:stream';
import { access, mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupRoot, disposeAll } from './helpers/cleanup.mjs';

const state = { synth: null, players: [], subtitles: [], hides: 0, hideTimes: [], texts: [], visible: '', playError: null };
globalThis.__voiceLanes = state;

const ttsUrl = new URL('../src/host/speech/tts.js', import.meta.url).href;
const sightUrl = new URL('../src/host/vision/sight.js', import.meta.url).href;
const subtitleUrl = new URL('../src/host/subtitle/subtitle.js', import.meta.url).href;
const speechTextUrl = new URL('../src/host/speech/speech-text.js', import.meta.url).href;
const hearingUrl = new URL('../src/host/hearing/hearing.js', import.meta.url).href;
const hooks = registerHooks({
  load(url, context, next) {
    if (url === hearingUrl) {
      // A synthetic microphone: the real `handleVoiceTask` path receives one final transcript.
      return {
        format: 'module',
        shortCircuit: true,
        source: `
    const s = globalThis.__voiceLanes;
    export const modelReady = () => true;
    export const finalModelReady = () => false;
    export const isLoopbackDevice = (name) => /CABLE|Stereo Mix|Virtual/i.test(String(name));
    export const listDevices = async () => ['Fake Mic'];
    export const startHearing = (options) => {
      s.onUpdate = options.onUpdate;
      // The level meter is what a partial barge-in must cross; tests can move it.
      return { device: options.device, stop() {}, stats: () => s.hearingStats ?? { rmsDb: -20 } };
    };
    export const watchHearingExit = () => {};
    export const annotateTranscript = (text) => text;
    export const joinDetailFields = () => ({});
    export const mergeJoinFallback = () => ({});
    export const offlineLimitedNote = () => '';
    export const truncationNotice = () => '';`,
      };
    }
    if (url === speechTextUrl) {
      // The wrappers delegate to the real module; `parseFailure` is a per-call injected parser
      // failure, so a test can prove the raw-text fallback is kept only for a failed parse.
      return {
        format: 'module',
        shortCircuit: true,
        source: `
    import * as real from '${speechTextUrl}?voice-lanes-real';
    const state = () => globalThis.__voiceLanes;
    export const parse = (...args) => real.parse(...args);
    export const toSpeechText = (...args) => real.toSpeechText(...args);
    export const toCaptionText = (...args) => real.toCaptionText(...args);
    export const looksUnbalanced = (...args) => real.looksUnbalanced(...args);
    // The host drains the residual buffer after every render and forwards it to the event log.
    export const takeResiduals = (...args) => real.takeResiduals(...args);
    // A5: the host imports the shared speech budget from this module; the wrapper must re-export it.
    export const DEFAULT_SPEECH_MAX_CHARS = real.DEFAULT_SPEECH_MAX_CHARS;
    export const SPEECH_TRUNCATION_NOTE = real.SPEECH_TRUNCATION_NOTE;
    export const resolveSpeechBudget = (...args) => real.resolveSpeechBudget(...args);
    export const formatMessage = (markdown, options) => {
      const failure = state()?.parseFailure;
      if (typeof failure === 'function') {
        const error = failure(markdown);
        if (error instanceof Error) throw error;
      }
      return real.formatMessage(markdown, options);
    };`,
      };
    }
    if (url === ttsUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
    const s = globalThis.__voiceLanes;
    export { resolveGptLangs, resolveGptSovitsTimeout } from '${ttsUrl}?voice-lanes-helpers';
    // The real block driver/splitter: a test can switch chunking on with voice.chunking in
    // settings.json; the fixtures keep it off unless the test asks for it.
    export { speakChunks, speechChunkTexts } from '${ttsUrl}?voice-lanes-chunk';
    export const configureTts = () => {};
    export const gptSovitsReferenceStatus = async () => ({ seconds: null, ok: false, readable: false });
    export const warmupGptSovits = async () => ({ ok: false, skipped: 'disabled' });
    export const applyGptSovitsModels = () => ({ ok: true });
    export const synthesize = (options) => s.synth(options);
    export const speakStreaming = async () => { throw new Error('streaming not expected'); };
    export const stopPlayback = () => true;
    export const stopTts = () => true;
    // The real players report their transport start through onStart; the fake does the same when
    // the test decides to fire it, so the caption timing is observable.
    export const play = (file, options) => {
      // A test can prove the caption published with block 0 does not survive a failed start.
      if (s.playError !== null) throw s.playError;
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
    export function readObservation(o, { now = Date.now(), ttlMs = 30000 } = {}) { const v = o ?? {}; const c = Number(v.capturedAt); const s = Number.isFinite(c) && c > 0 ? c : Number(v.at); const at = Number.isFinite(s) && s > 0 ? s : null; const ageMs = at === null ? null : Math.max(0, now - at); const stale = ageMs === null || ageMs >= ttlMs; return { ...v, at, ageMs, stale, hint: stale ? 'stale' : '' }; }`,
      };
    }
    if (url === subtitleUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
    export const averageColor = async () => null;
    export { SubtitleHold } from '${subtitleUrl}?voice-lanes-real';
    export class SubtitleOverlay {
      constructor({ config }) { this.config = config; }
      async show(text, region, colors, options = {}) {
        // The real overlay re-checks the publication generation right before its write.
        if (typeof options.isCurrent === 'function' && options.isCurrent() !== true) return false;
        const s = globalThis.__voiceLanes;
        s.subtitles.push({ text, at: Date.now() });
        s.visible = text;
        return true;
      }
      async hide() {
        const s = globalThis.__voiceLanes;
        s.hides += 1;
        s.hideTimes.push(Date.now());
        s.visible = '';
      }
      async stop() {}
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
const {
  apply, cancelSpeech, createAckLane, createSpeechLedger, feedMarkdownSentences, voiceSessionTarget,
} = await import('../src/host/index.js');
const { formatMessage, looksUnbalanced } = await import('../src/host/speech/speech-text.js');
hooks.deregister();
after(() => { delete globalThis.__voiceLanes; });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const fileExists = (path) => access(path).then(() => true, () => false);
const ACK_LINE = '我这就去看看你说的天气情况';

const waitUntil = async (check, message, timeoutMs = 4000) => {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out: ${message}`);
    await tick(5);
  }
};

const userEvent = (turn, id, text = '帮我查一下明天上海的天气') => ({
  type: 'user/message',
  data: { turn, id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
});
const assistantEvent = (turn, text, { step = 1 } = {}) => ({
  type: 'assistant/message',
  data: {
    turn,
    step,
    message: { id: `a-${turn}-${step}`, role: 'assistant', content: [{ type: 'text', text }] },
  },
});
const startEvent = (turn) => ({ type: 'turn/start', data: { turn } });
const endEvent = (turn, kind = 'completed') => ({ type: 'turn/end', data: { turn, reason: { kind } } });

/**
 * A lane with injected seams. The player is recorded the instant `play` is reached; the test ends
 * it explicitly. Generation and synthesis both resolve immediately unless a test overrides them.
 */
function laneFixture({ generate, synthesize, play, captureSignal, delayMs = 60, timeoutMs = 50, persona = () => '' } = {}) {
  const events = [];
  const plays = [];
  const lane = createAckLane({
    emit: async (type, payload) => { events.push({ type, payload }); },
    generate: generate ?? (async () => ACK_LINE),
    synthesize: synthesize ?? (async ({ speech }) => ({ file: 'ack.mp3', speech })),
    play: play ?? (async ({ speech, signal }) => {
      const player = { speech, signal, startedAt: Date.now(), end: null };
      const done = new Promise((resolve) => { player.end = () => resolve(); });
      plays.push(player);
      return { audioStartedAt: player.startedAt, done };
    }),
    persona,
    captureSignal: captureSignal ?? (() => new AbortController().signal),
    delayMs,
    timeoutMs: () => timeoutMs,
  });
  return { lane, events, plays };
}

const ackEvent = (events, type) => events.find((event) => event.type === type);

// ---------------------------------------------------------------------------
// Mounted host fixture: real apply(), real delivery events, synthetic event feed
// ---------------------------------------------------------------------------

async function mount(t, { services = new Map(), features = {}, chunking = false, subtitle = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-voice-lanes-'));
  await mkdir(join(root, 'data'), { recursive: true });
  await writeFile(join(root, 'data', 'features.json'), JSON.stringify({
    hearing: false,
    ambient: false,
    subtitle: true,
    voice: features.voice !== false,
  }));
  await writeFile(join(root, 'data', 'settings.json'), JSON.stringify({
    gptSovits: { enabled: false },
    // A block changes the clip count per line, so the suite keeps chunking off unless a test
    // opts in — the one documented switch back to one clip per sentence.
    voice: { chunking },
    subtitle: {
      enabled: true, mode: 'region', region: { left: 0, top: 0, width: 320, height: 100 }, ...subtitle,
    },
  }));
  state.players = [];
  state.subtitles = [];
  state.hides = 0;
  state.hideTimes = [];
  state.texts = [];
  state.visible = '';
  state.playError = null;
  state.parseFailure = null;
  state.synth = async ({ text }) => {
    state.texts.push(text);
    return { file: join(root, 'tts', `${state.texts.length}.mp3`), bytes: 16, durationMs: 200, provider: 'edge-tts' };
  };
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
  const scope = {
    effect,
    on,
    systemPrompt: { section: () => () => {} },
    webServer: {
      register(route) {
        routes.set(route.path, route.handler);
        return () => routes.delete(route.path);
      },
    },
  };
  apply({
    effect,
    on,
    get: (serviceName) => services.get(serviceName),
    tools: {
      register(tool) {
        tools.set(tool.name, tool);
        return () => tools.delete(tool.name);
      },
    },
    inject: (_deps, register) => register(scope),
  }, { root, enabled: true });

  const session = { id: 'voice-lanes-session', header: { cwd: join(root, 'workspace') } };
  const emit = (target, event) => {
    for (const entry of [...handlers]) {
      if (entry.type === 'session/event') entry.handler(target, event);
    }
  };
  const events = async () => {
    try {
      const text = await readFile(join(root, 'data', 'events.jsonl'), 'utf8');
      return text.trim().split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  };
  const waitForEvent = async (type, predicate = () => true) => {
    const started = Date.now();
    for (;;) {
      const row = (await events()).find((event) => event.type === type && predicate(event.payload ?? {}));
      if (row !== undefined) return row.payload ?? {};
      if (Date.now() - started > 6000) throw new Error(`timed out waiting for ${type}`);
      await tick(10);
    }
  };
  t.after(async () => {
    for (const player of state.players) player.resolve();
    await disposeAll(cleanups.splice(0));
    await cleanupRoot(root);
  });
  const action = async (body) => {
    const handler = routes.get('/assistant/action');
    assert.equal(typeof handler, 'function', 'the action route is registered');
    let result;
    await handler(
      Object.assign(Readable.from([JSON.stringify(body)]), { method: 'POST' }),
      { writeHead() {}, end(value) { result = JSON.parse(value); } },
    );
    return result;
  };
  const status = async () => {
    const handler = routes.get('/assistant/status');
    assert.equal(typeof handler, 'function', 'the status route is registered');
    let result = '';
    await handler({ method: 'GET', url: '/assistant/status' }, { writeHead() {}, end(value) { result = value; } });
    return JSON.parse(result);
  };
  const say = (args, exec = {}) => tools.get('assistant_say').execute(args, exec);
  return { root, session, tools, emit, events, waitForEvent, action, status, say, players: () => state.players };
}

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

/**
 * The real voice round (`handleVoiceTask` + the sentence speaker) with a synthetic microphone and
 * agent. The fake loop commits one turn per delivery; `beforeReply` holds the assistant body so a
 * test can start an `assistant_say` clip while the round is still open and then release the body.
 */
async function mountVoiceRound(t, {
  replyText = '第一句。第二句。第三句。', beforeReply = null, chunking = false,
  bargeInPartial = null, config = {},
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-voice-lanes-round-'));
  await mkdir(join(root, 'data'), { recursive: true });
  await mkdir(join(root, 'workspace'), { recursive: true });
  await writeFile(join(root, 'data', 'features.json'), JSON.stringify({
    hearing: true,
    ambient: false,
    voice: true,
    vision: false,
    subtitle: false,
    avatar: false,
    memory: false,
    fastpath: false,
  }));
  await writeFile(join(root, 'data', 'settings.json'), JSON.stringify({
    gptSovits: { enabled: false },
    langs: { speech: 'zh', subtitle: 'zh' },
    autoMemory: { enabled: false },
    // The round suite counts one clip per sentence: chunking stays off unless a test opts in.
    // `voice.bargeInPartial` is written only when a test asks; the absent key falls back to
    // plugin config and, with neither, to the shipped default (partials never interrupt).
    voice: { chunking, ...(typeof bargeInPartial === 'boolean' ? { bargeInPartial } : {}) },
  }));
  state.players = [];
  state.subtitles = [];
  state.hides = 0;
  state.hideTimes = [];
  state.texts = [];
  state.onUpdate = null;
  state.hearingStats = { rmsDb: -20 };
  state.replyTurnId = null;
  state.turnIds = [];

  const listeners = new Set();
  const cleanups = [];
  const tools = new Map();
  const services = new Map([
    ['agentDefaultModel', { currentSelection: () => ({ provider: 'fake-provider', model: 'fake-model' }) }],
    ['sessionTitle', { get: () => undefined, rename: (_session, title) => ({ title, source: { kind: 'user' } }) }],
    ['workspaceRegistry', {
      async create(path) { return { id: 'ws-voice-lanes-round', path }; },
      get() { return { id: 'ws-voice-lanes-round', async attachSession() {} }; },
    }],
  ]);
  const agents = new Map();
  let persisted = false;
  const bus = {
    on(type, fn) {
      const entry = { type, fn };
      listeners.add(entry);
      return () => listeners.delete(entry);
    },
    fire(type, ...args) {
      for (const entry of [...listeners]) {
        if (entry.type !== type) continue;
        try { entry.fn(...args); } catch { /* isolate a listener like the real bus */ }
      }
    },
    async dispatch(type, ...args) {
      let result;
      for (const entry of [...listeners]) {
        if (entry.type !== type) continue;
        result = await entry.fn(...args);
      }
      return result;
    },
  };
  const makeAgent = (sessionId) => {
    const session = { id: sessionId, header: { cwd: join(root, 'workspace') }, append() {} };
    let turn = 0;
    const agent = {
      id: sessionId,
      session,
      followup(message) {
        turn += 1;
        const turnId = turn;
        const text = JSON.stringify(message?.content ?? message);
        const isDigest = text.includes('以下内容作为长期约束与背景');
        state.loopSession = session;
        const fire = (type, data) => bus.fire('session/event', session, {
          type, seq: state.turnIds.length + turnId, time: Date.now(), data,
        });
        const runTurn = async () => {
          fire('turn/start', { turn: turnId });
          state.turnIds.push(turnId);
          fire('user/message', message);
          if (isDigest !== true) {
            state.replyTurnId = turnId;
            if (beforeReply !== null) await beforeReply.promise;
          }
          fire('assistant/message', {
            turn: turnId,
            step: 1,
            message: {
              id: `a-${turnId}`, role: 'assistant', content: [{ type: 'text', text: replyText }],
            },
          });
          fire('turn/end', { turn: turnId, reason: { kind: 'completed' } });
        };
        void runTurn().catch(() => {});
      },
    };
    return agent;
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
  const effect = (fn) => {
    const cleanup = fn();
    if (typeof cleanup === 'function') cleanups.push(cleanup);
    return cleanup;
  };
  apply({
    effect,
    on: bus.on,
    get: (name) => services.get(name),
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    inject: (_deps, registerScope) => {
      registerScope({
        effect,
        on: bus.on,
        systemPrompt: { section: () => () => {} },
        webServer: { register: () => () => {} },
      });
    },
    webServer: { register: () => () => {} },
  }, { root, enabled: true, asrMergeWindowMs: 10, ...config });

  const listen = tools.get('assistant_listen');
  assert.ok(listen !== undefined, 'assistant_listen is registered');
  const started = await listen.execute({ action: 'start' });
  assert.equal(started.ok, true, `listening started: ${started.error ?? ''}`);
  assert.equal(typeof state.onUpdate, 'function', 'the hearing session exposes onUpdate');

  const events = async () => {
    try {
      const text = await readFile(join(root, 'data', 'events.jsonl'), 'utf8');
      return text.trim().split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  };
  const waitForEvent = async (type, predicate = () => true, timeoutMs = 6000) => {
    const startedAt = Date.now();
    for (;;) {
      const row = (await events()).find((event) => event.type === type && predicate(event.payload ?? {}));
      if (row !== undefined) return row.payload ?? {};
      if (Date.now() - startedAt > timeoutMs) throw new Error(`timed out waiting for ${type}`);
      await tick(10);
    }
  };
  const sessionTarget = voiceSessionTarget({ root });
  t.after(async () => {
    for (const player of [...state.players]) player.resolve();
    await tick(20);
    await disposeAll(cleanups.splice(0));
    await cleanupRoot(root);
  });
  return {
    root,
    sessionId: sessionTarget.sessionId,
    session: () => state.loopSession,
    /** Fire one session event at the live voice session (or an explicit one, e.g. a subagent). */
    emit: (event, target = null) => bus.fire(
      'session/event',
      target ?? state.loopSession ?? { id: sessionTarget.sessionId, header: { cwd: join(root, 'workspace') } },
      event,
    ),
    say: (text) => state.onUpdate({ final: text, durationMs: 100 }),
    toolSay: (args) => tools.get('assistant_say').execute(
      typeof args === 'string' ? { text: args } : args,
      { agent: { session: { id: sessionTarget.sessionId } } },
    ),
    tool: () => tools.get('assistant_say'),
    releaseReply: () => beforeReply?.resolve(),
    events,
    waitForEvent,
    players: () => state.players,
    resolvePlayer: (index) => state.players[index]?.resolve(),
    subtitles: () => state.subtitles,
    replyTurnId: () => state.replyTurnId,
  };
}

/** The fake model every mounted ack test uses: one valid waiting line, no tools. */
function ackServices() {
  const requests = [];
  const services = new Map([
    ['llm', {
      stream(options) {
        requests.push(options);
        return (async function* generate() {
          yield { type: 'text-delta', text: ACK_LINE };
        })();
      },
    }],
    ['agentDefaultModel', { currentSelection: () => ({ provider: 'fake-provider', model: 'fake-model' }) }],
  ]);
  return { services, requests };
}

// ---------------------------------------------------------------------------
// 1. The reply body starts inside the deadline: nothing plays
// ---------------------------------------------------------------------------

test('1. a reply body starting within two seconds cancels the waiting line', async (t) => {
  const { lane, events, plays } = laneFixture({ delayMs: 2000 });
  const claimed = lane.beginTurn({ sessionId: 's-body-first', turn: 1, userText: '帮我查一下天气' });
  assert.deepEqual(claimed, { ack: true, reason: 'ok' });
  await tick(80);
  const cancelled = lane.bodyStarted({ sessionId: 's-body-first', turn: 1, at: Date.now() });
  assert.equal(cancelled, true, 'the unplayed line was cancelled at once');
  await waitUntil(() => ackEvent(events, 'voice.ack.cancelled'), 'the cancellation is recorded');
  const row = ackEvent(events, 'voice.ack.cancelled');
  assert.equal(row.payload.reason, 'body-first-audio', 'the reason names the body first audio');
  assert.ok(row.payload.ackDroppedMs >= 60, `ackDroppedMs=${row.payload.ackDroppedMs}`);
  // Still before the two-second deadline would even have fired: definitely no playback.
  await tick(2100);
  assert.equal(plays.length, 0, 'no line ever reached the player');
  assert.equal(events.filter((event) => event.type === 'voice.ack.spoken').length, 0);
  t.diagnostic(`body started at +80ms; players=0 spoken=0 cancelled=${row.payload.reason} droppedMs=${row.payload.ackDroppedMs}`);
});

// ---------------------------------------------------------------------------
// 2. No reply body within two seconds: one line of 10–30 characters plays
// ---------------------------------------------------------------------------

test('2. no reply body after two seconds plays one line of 10–30 characters', async (t) => {
  const { services } = ackServices();
  const app = await mount(t, { services });
  const deliveredAt = Date.now();
  app.emit(app.session, startEvent(3));
  app.emit(app.session, userEvent(3, 'u-3', '帮我查一下明天上海的天气'));
  const spoken = await app.waitForEvent('voice.ack.spoken', (payload) => payload.turn === 3);
  const elapsed = Date.now() - deliveredAt;
  const length = [...ACK_LINE].length;
  assert.ok(length >= 10 && length <= 30, `draft length ${length}`);
  assert.equal(spoken.chars, length);
  assert.ok(spoken.chars >= 10 && spoken.chars <= 30, `event chars ${spoken.chars}`);
  assert.equal(app.players().length, 1, 'exactly one clip played');
  assert.equal(state.texts.length, 1, 'exactly one synthesis for the waiting line');
  assert.ok(elapsed >= 1900, `played only after the deadline (measured ${elapsed}ms)`);
  assert.ok(spoken.ackTriggerMs >= 1900, `ackTriggerMs=${spoken.ackTriggerMs}`);
  assert.ok(spoken.ackReadyMs <= spoken.ackTriggerMs, `prepared before the deadline (ackReadyMs=${spoken.ackReadyMs})`);
  assert.ok(spoken.ackFirstAudioMs >= spoken.ackTriggerMs, `ackFirstAudioMs=${spoken.ackFirstAudioMs}`);
  assert.equal(spoken.bodyFirstAudioMs, null, 'the body had not started yet');
  state.players[0].resolve();
  t.diagnostic(
    `line "${ACK_LINE}" chars=${length} ackTriggerMs=${spoken.ackTriggerMs} `
    + `ackReadyMs=${spoken.ackReadyMs} ackFirstAudioMs=${spoken.ackFirstAudioMs}`,
  );
});

// ---------------------------------------------------------------------------
// 3. One line per turn, however often the trigger is repeated
// ---------------------------------------------------------------------------

test('3. the waiting line fires at most once per turn', async (t) => {
  const { lane, events, plays } = laneFixture({ delayMs: 40 });
  assert.deepEqual(
    lane.beginTurn({ sessionId: 's-once', turn: 7, userText: '帮我看看这个日志' }),
    { ack: true, reason: 'ok' },
  );
  assert.deepEqual(
    lane.beginTurn({ sessionId: 's-once', turn: 7, userText: '帮我看看这个日志' }),
    { ack: false, reason: 'already-acknowledged' },
  );
  await waitUntil(() => plays.length === 1, 'the first line reached the player');
  const skipped = ackEvent(events, 'voice.ack.skipped');
  assert.equal(skipped.payload.reason, 'already-acknowledged');
  await tick(120);
  assert.equal(plays.length, 1, 'the repeated trigger never played a second line');
  assert.equal(events.filter((event) => event.type === 'voice.ack.spoken').length, 1);
  plays[0].end();
  await lane.whenIdle();
  t.diagnostic('two triggers for turn 7; players=1 spoken=1 second=already-acknowledged');
});

// ---------------------------------------------------------------------------
// 4. The reply body being READY is not its first audio: no early cancel
// ---------------------------------------------------------------------------

test('4. a ready-but-not-sounding reply body does not cancel the line; its first audio does', async (t) => {
  let synthStarts = 0;
  const { lane, events, plays } = laneFixture({
    delayMs: 400,
    synthesize: async ({ speech }) => {
      synthStarts += 1;
      return { file: 'ack.mp3', speech };
    },
  });
  lane.beginTurn({ sessionId: 's-early', turn: 4, userText: '帮我查一下' });
  await tick(60);
  // Only "the answer is ready to speak" arrived: the waiting line keeps its clock.
  const gate = await lane.answerStart({ sessionId: 's-early', turn: 4 });
  assert.deepEqual(gate, { action: 'speak' }, 'readiness never skips the line');
  assert.equal(synthStarts, 1, 'the synthesis had already started and is not aborted');
  await tick(100);
  assert.equal(plays.length, 0, 'the deadline has not fired yet');
  // The body really starts sounding before the deadline: now the line is cancelled.
  lane.bodyStarted({ sessionId: 's-early', turn: 4, at: Date.now() });
  await tick(500);
  assert.equal(plays.length, 0, 'the cancelled line never reached the player');
  assert.ok(events.some((event) => event.type === 'voice.ack.cancelled'
    && event.payload.reason === 'body-first-audio'));
  await lane.whenIdle();
  t.diagnostic(`answer ready at +60ms; synth started=${synthStarts} players=0 reason=body-first-audio`);
});

// ---------------------------------------------------------------------------
// 5. Interrupt / newer turn / older session: the old line is cancelled
// ---------------------------------------------------------------------------

test('5. interrupt and turn switch cancel the old waiting line', async (t) => {
  const first = laneFixture({ delayMs: 300 });
  first.lane.beginTurn({ sessionId: 's-interrupt', turn: 6, userText: '帮我读一下这个文件' });
  assert.equal(first.lane.cancelTurn('s-interrupt', 6, 'interrupted'), true);
  await tick(360);
  assert.equal(first.plays.length, 0, 'the interrupted line never played');
  assert.ok(first.events.some((event) => event.type === 'voice.ack.cancelled' && event.payload.reason === 'interrupted'));

  // A newer turn supersedes the old one before the deadline.
  const second = laneFixture({ delayMs: 300 });
  second.lane.beginTurn({ sessionId: 's-switch', turn: 10, userText: '帮我查一下' });
  assert.equal(second.lane.cancelSuperseded('s-switch', 11, 'superseded'), true);
  await tick(360);
  assert.equal(second.plays.length, 0, 'the superseded line never played');
  assert.ok(second.events.some((event) => event.type === 'voice.ack.cancelled' && event.payload.reason === 'superseded'));

  // Another session's newer turn leaves this line alone (old-turn isolation is per session).
  const third = laneFixture({ delayMs: 40 });
  third.lane.beginTurn({ sessionId: 's-a', turn: 1, userText: '帮我查一下' });
  third.lane.cancelSuperseded('s-b', 2, 'superseded');
  await waitUntil(() => third.plays.length === 1, 'the other session still speaks');
  third.plays[0].end();
  await third.lane.whenIdle();
  t.diagnostic('interrupted players=0; superseded players=0; other session players=1');
});

// ---------------------------------------------------------------------------
// 6. Voice reply disabled: no trigger at all
// ---------------------------------------------------------------------------

test('6. a voice-disabled session never triggers the waiting line', async (t) => {
  const app = await mount(t, { features: { voice: false } });
  app.emit(app.session, startEvent(8));
  app.emit(app.session, userEvent(8, 'u-8', '帮我查一下明天天气'));
  await tick(2300);
  const rows = await app.events();
  assert.equal(rows.filter((event) => event.type === 'voice.ack.spoken').length, 0);
  assert.equal(app.players().length, 0, 'no clip played');
  const skipped = rows.find((event) => event.type === 'voice.ack.skipped');
  assert.equal(skipped?.payload?.reason, 'disabled');
  t.diagnostic(`voice off: spoken=0 players=0 reason=${skipped?.payload?.reason}`);
});

// ---------------------------------------------------------------------------
// 7. Any tool call: no extra trigger, no category suppression
// ---------------------------------------------------------------------------

test('7. tool calls of any category neither trigger nor suppress the line', async (t) => {
  const { services, requests } = ackServices();
  const app = await mount(t, { services });
  app.emit(app.session, startEvent(9));
  app.emit(app.session, userEvent(9, 'u-9', '帮我查一下明天的天气'));
  // A control tool, a perception tool and a "work" shell tool: all irrelevant now.
  for (const name of ['assistant_say', 'assistant_see', 'pwsh', 'terminal_open', 'session_search']) {
    app.emit(app.session, {
      type: 'tool/call',
      data: { turn: 9, step: 1, callId: `c-9-${name}`, name, arguments: '{"command":"Get-Weather"}' },
    });
  }
  const spoken = await app.waitForEvent('voice.ack.spoken', (payload) => payload.turn === 9);
  assert.equal(spoken.turn, 9);
  assert.equal(requests.length, 1, 'exactly one draft request, started at message delivery');
  assert.equal(app.players().length, 1, 'exactly one clip, not one per tool');
  // More tools arrive after the line played: still no second line and no not-work row.
  for (const name of ['assistant_remember', 'assistant_live2d', 'pwsh']) {
    app.emit(app.session, {
      type: 'tool/call',
      data: { turn: 9, step: 2, callId: `c-9b-${name}`, name, arguments: '{}' },
    });
  }
  await tick(220);
  const rows = await app.events();
  assert.equal(rows.filter((event) => event.type === 'voice.ack.spoken').length, 1);
  assert.equal(requests.length, 1, 'tool calls never start another draft');
  assert.equal(
    rows.filter((event) => event.type === 'voice.ack.skipped' && event.payload.reason === 'not-work').length,
    0,
    'the tool category no longer produces a suppression row',
  );
  state.players[0].resolve();
  // A turn with tool calls but no user message has no delivery clock at all: no line, no timer.
  app.emit(app.session, startEvent(10));
  app.emit(app.session, {
    type: 'tool/call',
    data: { turn: 10, step: 1, callId: 'c-10-pwsh', name: 'pwsh', arguments: '{}' },
  });
  await tick(300);
  assert.equal(
    (await app.events()).filter((event) => event.type === 'voice.ack.spoken' && event.payload.turn === 10).length,
    0,
    'a tool call by itself never triggers the line',
  );
  assert.equal(requests.length, 1, 'no draft for a tool-only turn');
  t.diagnostic(`tools=9 spoken=1 drafts=${requests.length} players=${app.players().length}`);
});

// ---------------------------------------------------------------------------
// 8. The event carries the three ack stages and the body-first stamp
// ---------------------------------------------------------------------------

test('8. ack events carry ackTriggerMs, ackReadyMs, ackFirstAudioMs and bodyFirstAudioMs', async (t) => {
  const { lane, events, plays } = laneFixture({ delayMs: 30 });
  lane.beginTurn({ sessionId: 's-timing', turn: 12, userText: '帮我看看这个文件' });
  await waitUntil(() => ackEvent(events, 'voice.ack.spoken'), 'the line played');
  const spoken = ackEvent(events, 'voice.ack.spoken').payload;
  for (const field of ['ackTriggerMs', 'ackReadyMs', 'ackFirstAudioMs', 'bodyFirstAudioMs']) {
    assert.ok(Object.prototype.hasOwnProperty.call(spoken, field), `voice.ack.spoken has ${field}`);
  }
  assert.ok(spoken.ackTriggerMs >= 25, `ackTriggerMs=${spoken.ackTriggerMs}`);
  assert.ok(spoken.ackReadyMs >= 0 && spoken.ackReadyMs <= spoken.ackTriggerMs, `ackReadyMs=${spoken.ackReadyMs}`);
  assert.ok(spoken.ackFirstAudioMs >= spoken.ackTriggerMs, `ackFirstAudioMs=${spoken.ackFirstAudioMs}`);
  assert.equal(spoken.bodyFirstAudioMs, null, 'body had not started when the line played');

  await tick(10);
  lane.bodyStarted({ sessionId: 's-timing', turn: 12, at: Date.now() });
  const body = await waitUntil(() => ackEvent(events, 'voice.ack.body-first'), 'the body-first row');
  for (const field of ['ackTriggerMs', 'ackReadyMs', 'ackFirstAudioMs', 'bodyFirstAudioMs']) {
    assert.ok(Object.prototype.hasOwnProperty.call(body.payload, field), `voice.ack.body-first has ${field}`);
  }
  assert.ok(body.payload.bodyFirstAudioMs >= spoken.ackFirstAudioMs, `bodyFirstAudioMs=${body.payload.bodyFirstAudioMs}`);
  plays[0].end();
  await lane.whenIdle();
  t.diagnostic(
    `spoken ackTriggerMs=${spoken.ackTriggerMs} ackReadyMs=${spoken.ackReadyMs} `
    + `ackFirstAudioMs=${spoken.ackFirstAudioMs} bodyFirstAudioMs=null; `
    + `body-first ackFirstAudioMs=${body.payload.ackFirstAudioMs} bodyFirstAudioMs=${body.payload.bodyFirstAudioMs}`,
  );
});

// ---------------------------------------------------------------------------
// 9. A line already playing finishes first; the answer starts after it
// ---------------------------------------------------------------------------

test('9. a line already playing finishes before the answer is allowed to start', async () => {
  const { lane, plays } = laneFixture({ delayMs: 30 });
  lane.beginTurn({ sessionId: 's-order', turn: 2, userText: '帮我查一下天气' });
  await waitUntil(() => plays.length === 1, 'the line reached the player');
  let gateSettled = false;
  const gatePromise = lane.answerStart({ sessionId: 's-order', turn: 2 }).then((gate) => {
    gateSettled = true;
    return gate;
  });
  await tick(40);
  assert.equal(gateSettled, false, 'the answer waits while the line plays');
  plays[0].end();
  const gate = await gatePromise;
  assert.deepEqual(gate, { action: 'finish-ack-then-answer' });
  await lane.whenIdle();
});

// ---------------------------------------------------------------------------
// 10. Markdown: speech gets plain text, the caption gets the same plain text
// ---------------------------------------------------------------------------

test('10. **重要** speaks and captions as 重要 while code/arithmetic/date/money stay literal', async (t) => {
  assert.deepEqual(formatMessage('**重要**'), { speech: '重要', caption: '重要' });
  const literal = 'C# 里 2*3 等于 6，日期 2026-11-05，金额 -5 美元';
  const formatted = formatMessage(literal);
  assert.equal(formatted.speech, literal);
  assert.equal(formatted.caption, literal);

  const app = await mount(t);
  const said = await app.say({ text: '**重要**' });
  assert.equal(said.accepted, true, 'the speech is accepted; playback happens in the background');
  await waitUntil(() => state.players.length === 1, 'the clip reached the player');
  assert.deepEqual(state.texts, ['重要'], 'TTS got the cleaned speech text');
  // The caption is published with the finished clip, before the player's start.
  await waitUntil(() => state.subtitles.length === 1, 'the caption is already up before start');
  assert.equal(state.subtitles[0].text, '重要', 'the subtitle is the caption form, not the Markdown');
  state.players[0].onStart?.({ startedAt: Date.now() });
  await tick(40);
  assert.equal(state.subtitles.length, 1, 'the start does not publish it a second time');
  state.players[0].resolve();
});

// ---------------------------------------------------------------------------
// 11. Streaming split: a half `**` is held, then cleaned after the merge
// ---------------------------------------------------------------------------

test('11. a ** split across two streamed fragments is held, then cleaned after the merge', () => {
  const first = '这是**重';
  const second = '要**的内容。';
  assert.equal(looksUnbalanced(first), true, 'the open emphasis is detected');
  // Cleaning now would emit the literal markers, so the host waits for the next fragment.
  assert.equal(formatMessage(first).speech, '这是**重', 'an unbalanced fragment is kept verbatim');

  const merged = `${first}${second}`;
  assert.equal(looksUnbalanced(merged), false);
  const formatted = formatMessage(merged);
  assert.equal(formatted.speech, '这是重要的内容。');
  assert.ok(!formatted.speech.includes('**'), 'no marker leaks into TTS');
  assert.ok(!formatted.caption.includes('**'), 'no marker leaks into the caption');

  // The same rule for a code span split in two.
  assert.equal(looksUnbalanced('运行 `npm'), true);
  assert.equal(formatMessage('运行 `npm test`。').speech, '运行 npm test。');
});

// ---------------------------------------------------------------------------
// 12. The caption follows the player start; an interrupt cannot be revived
// ---------------------------------------------------------------------------

test('12. the caption is up before the player starts; an interrupt keeps it dead', async (t) => {
  const app = await mount(t);
  const said = await app.say({ text: '第一句。' });
  assert.equal(said.accepted, true, 'the speech is accepted before the player starts');
  await waitUntil(() => state.players.length === 1, 'the clip reached the player');
  await waitUntil(() => state.subtitles.length === 1, 'the caption is up while the clip has not started');
  const shownAt = state.subtitles[0].at;
  const startedAt = Date.now();
  assert.ok(shownAt <= state.players[0].startedAt, 'published with the finished clip, not after the player start');
  state.players[0].onStart?.({ startedAt });
  await tick(40);
  assert.equal(state.subtitles.length, 1, 'the transport start republishes nothing');
  assert.equal(state.subtitles[0].text, '第一句。');

  // Interrupt: the visible line goes down with the sound, and the old callback cannot revive it.
  const before = state.hides;
  assert.equal((await app.action({ action: 'voice.mute', muted: true })).ok, true);
  await tick(20);
  assert.ok(state.hides > before, 'the interrupt hid the old caption');
  state.players[0].onStart?.({ startedAt: Date.now() });
  await tick(60);
  assert.equal(state.subtitles.length, 1, 'the late callback published nothing');
  t.diagnostic(
    `caption lead ${startedAt - shownAt}ms before play.start; after mute: hides=${state.hides}, captions=${state.subtitles.length}`,
  );
});

// ---------------------------------------------------------------------------
// 13. Every complete sentence of one fragment is consumed, in order
// ---------------------------------------------------------------------------

test('13. a fragment carrying several sentences queues all of them, in order', (t) => {
  // The host feeds its streaming Markdown buffer through this exact helper: one sentence is
  // consumed at a time, and only the unconsumed remainder is kept for the next fragment.
  const sentences = [];
  let buffer = '';
  const feed = (delta, final = false) => {
    buffer += delta;
    buffer = feedMarkdownSentences(buffer, {
      final,
      onSentence: (sentence) => sentences.push(sentence),
    });
  };
  feed('第一句。第二句。第三句。');
  assert.equal(sentences.length, 3, 'three complete sentences queued, not just the first');
  assert.deepEqual(sentences, ['第一句。', '第二句。', '第三句。'], 'queue order matches the text');
  assert.equal(buffer, '', 'all complete text was consumed from the buffer');

  // Sharded arrival: the half sentence stays buffered, then merges into the same three.
  const sharded = [];
  let rest = '';
  const feedShard = (delta) => {
    rest += delta;
    rest = feedMarkdownSentences(rest, { onSentence: (sentence) => sharded.push(sentence) });
  };
  feedShard('第一句。第二');
  assert.deepEqual(sharded, ['第一句。'], 'the incomplete second sentence is held back');
  assert.equal(rest, '第二');
  feedShard('句。第三句。');
  assert.deepEqual(sharded, ['第一句。', '第二句。', '第三句。'], 'the merged fragment still yields three');
  assert.equal(rest, '');
  t.diagnostic(`one fragment -> ${sentences.length} queued; two shards -> ${sharded.length} queued (${sharded.join('')})`);
});

// ---------------------------------------------------------------------------
// 14. Empty-after-format is silent; only a failed parse falls back to the raw text
// ---------------------------------------------------------------------------

test('14. a pure code block is not spoken (caption only); a failed parse falls back', async (t) => {
  const app = await mount(t);
  const code = '```js\nconst a = 1;\n```';
  const said = await app.say({ text: code });
  assert.equal(said.accepted, false, 'nothing speakable was accepted');
  assert.equal(said.reason, 'empty-after-format');
  assert.equal(state.texts.length, 0, 'no TTS call at all for a pure code block');
  const skipped = await app.waitForEvent(
    'voice.speech.skipped',
    (payload) => payload.reason === 'empty-after-format',
  );
  assert.equal(skipped.reason, 'empty-after-format');
  await waitUntil(() => state.subtitles.length === 1, 'the caption is still shown');
  assert.equal(state.subtitles[0].text, 'const a = 1;', 'the caption keeps the code body, not the fence');

  // The injected failure is the ONLY case that falls back to the raw Markdown.
  state.parseFailure = () => new Error('parse-down');
  try {
    const fallback = await app.say({ text: '**重要**' });
    assert.equal(fallback.accepted, true, 'the parsed-fallback line is accepted');
    await waitUntil(() => state.texts.length === 1, 'TTS got the raw text');
    assert.equal(state.texts.at(-1), '**重要**', 'the raw text is spoken only when parsing failed');
    await waitUntil(() => app.players().length === 1, 'the fallback clip reached the player');
    app.players()[0].resolve();
    await tick(10);
  } finally {
    state.parseFailure = null;
  }
});

// ---------------------------------------------------------------------------
// 15. A bold span crossing a sentence end is parsed intact, then split safely
// ---------------------------------------------------------------------------

test('15. a bold span across a sentence end never leaks a marker into voice or caption', (t) => {
  // Streaming: every candidate sentence end is still inside the bold span, so nothing may be
  // consumed — the whole span stays buffered until a boundary after the closing marker.
  let held = '';
  const early = [];
  held = feedMarkdownSentences('**第一句。第二句。**', { onSentence: (sentence) => early.push(sentence) });
  assert.equal(held, '**第一句。第二句。**', 'no boundary is safe inside the span, so it stays buffered');
  assert.deepEqual(early, [], 'neither `**第一句。` nor a lone `**` was emitted');

  // Turn end: parse the intact span first, then split its already-plain speech.
  const speech = [];
  const captions = [];
  const rest = feedMarkdownSentences('**第一句。第二句。**', {
    final: true,
    onSentence: (sentence) => speech.push(sentence),
    onCaption: (caption) => captions.push(caption),
  });
  assert.equal(rest, '');
  assert.deepEqual(speech, ['第一句。', '第二句。'], 'two plain sentences, not one broken fragment');
  assert.ok(speech.every((sentence) => !sentence.includes('**')), 'voice carries no emphasis marker');
  assert.equal(captions.length, 1);
  assert.ok(captions[0].includes('第一句。第二句。'), 'the caption keeps the whole span');
  assert.ok(!captions[0].includes('**'), 'the caption carries no emphasis marker');
  t.diagnostic(`voice=${JSON.stringify(speech)} caption=${JSON.stringify(captions[0])}`);
});

// ---------------------------------------------------------------------------
// 16. A streamed code block is skipped by TTS; the caption keeps the code body
// ---------------------------------------------------------------------------

test('16. a streamed code block is never spoken and its content stays in the caption', (t) => {
  const speech = [];
  const captions = [];
  let buffer = '';
  for (const shard of ['```js\n', 'console.log(1);\n', '```\n']) {
    buffer = feedMarkdownSentences(`${buffer}${shard}`, {
      final: false,
      onSentence: (sentence) => speech.push(sentence),
      onCaption: (caption) => captions.push(caption),
    });
  }
  assert.equal(buffer, '', 'the complete fence was consumed as one block');
  assert.deepEqual(speech, [], 'the code body never reaches the speech lane');
  assert.ok(!speech.join('').includes('console.log(1)'), 'TTS receives no code line');
  assert.equal(captions.length, 1);
  assert.ok(captions[0].includes('console.log(1);'), 'the caption keeps the code body');

  // The same block arriving only at the turn end must not be cut into a fence and a code line.
  const finalSpeech = [];
  const finalCaptions = [];
  const rest = feedMarkdownSentences('```js\nconsole.log(1);\n```\n', {
    final: true,
    onSentence: (sentence) => finalSpeech.push(sentence),
    onCaption: (caption) => finalCaptions.push(caption),
  });
  assert.equal(rest, '');
  assert.deepEqual(finalSpeech, [], 'the turn-end parse skips the code block too');
  assert.ok(finalCaptions[0].includes('console.log(1);'), 'the caption still keeps the code body');
  t.diagnostic(`voice=${JSON.stringify(speech)} caption=${JSON.stringify(captions[0])}`);
});

// ---------------------------------------------------------------------------
// 17. A marker that only arrives at the turn end never reaches TTS
// ---------------------------------------------------------------------------

test('17. an unmatched `**` arriving only at turn end is closed, not spoken or shown raw', (t) => {
  const early = [];
  const held = feedMarkdownSentences('**未闭合', { onSentence: (sentence) => early.push(sentence) });
  assert.equal(held, '**未闭合', 'the unbalanced fragment is held during streaming');
  assert.deepEqual(early, [], 'the open marker is not spoken mid-stream');

  const speech = [];
  const captions = [];
  const rest = feedMarkdownSentences('**未闭合', {
    final: true,
    onSentence: (sentence) => speech.push(sentence),
    onCaption: (caption) => captions.push(caption),
  });
  assert.equal(rest, '');
  assert.deepEqual(speech, ['未闭合'], 'the turn-end fallback closes the marker and keeps the words');
  assert.ok(speech.every((sentence) => !sentence.includes('**')), 'no marker is spoken');
  assert.equal(captions.length, 1);
  assert.ok(captions[0].trim().length > 0, 'the subtitle is not empty');
  assert.ok(!captions[0].includes('**'), 'no marker reaches the subtitle');
  t.diagnostic(`voice=${JSON.stringify(speech)} caption=${JSON.stringify(captions[0])}`);
});

// ---------------------------------------------------------------------------
// 18. Plain multi-sentence text keeps its original order and count
// ---------------------------------------------------------------------------

test('18. plain multi-sentence text still queues three sentences in order', (t) => {
  const sentences = [];
  let buffer = '';
  buffer = feedMarkdownSentences('第一句。第二句。第三句。', { onSentence: (sentence) => sentences.push(sentence) });
  assert.equal(buffer, '', 'all complete text was consumed');
  assert.deepEqual(sentences, ['第一句。', '第二句。', '第三句。'], 'three sentences, in the original order');

  // The turn-end drain of an unterminated tail keeps the old flush behaviour.
  const tail = [];
  const rest = feedMarkdownSentences('最后一句没有标点', { final: true, onSentence: (sentence) => tail.push(sentence) });
  assert.equal(rest, '');
  assert.deepEqual(tail, ['最后一句没有标点'], 'the tail is still spoken once');
  t.diagnostic(`streamed=${JSON.stringify(sentences)} tail=${JSON.stringify(tail)}`);
});

// ---------------------------------------------------------------------------
// 19. A real voice reply: every sentence plays, in order, one at a time
// ---------------------------------------------------------------------------

test('19. a three-sentence voice reply plays three clips and reports played === sentences', async (t) => {
  const gate = deferred();
  const app = await mountVoiceRound(t, { replyText: '第一句。第二句。第三句。', beforeReply: gate });
  app.say('给我讲三句');
  await waitUntil(() => app.replyTurnId() !== null, 'the reply turn started');
  assert.equal(app.players().length, 0, 'nothing plays before the body is released');
  gate.resolve();

  // Each sentence starts only after the previous clip really ended; the test releases them.
  for (let index = 0; index < 3; index += 1) {
    await waitUntil(() => app.players().length === index + 1, `sentence ${index + 1} reached the player`);
    app.resolvePlayer(index);
  }
  const first = await app.waitForEvent('voice.first-sentence');
  const starts = (await app.events()).filter((event) => event.type === 'speech.play.start');
  const finishes = (await app.events()).filter((event) => event.type === 'speech.finish');
  assert.equal(starts.length, 3, 'each sentence has its own speech.play.start');
  assert.equal(finishes.length, 3, 'each sentence has its own speech.finish');
  assert.deepEqual(starts.map((row) => row.payload.sentenceId), [0, 1, 2], 'sentence ids are ordered');
  assert.deepEqual(
    new Set(starts.map((row) => row.payload.speechId)).size,
    3,
    'every sentence has an independent speechId',
  );
  assert.equal(first.sentences, 3);
  assert.equal(first.played, 3, 'played counts the clips that actually finished');
  const clips = app.players();
  for (let index = 1; index < clips.length; index += 1) {
    assert.ok(
      clips[index].startedAt >= clips[index - 1].endedAt,
      `sentence ${index + 1} started only after sentence ${index} ended`,
    );
  }
  const cancelled = (await app.events()).filter((event) => event.type === 'speech.cancelled');
  assert.equal(cancelled.length, 0, 'a normal reply cancels nothing');
  t.diagnostic(`sentences=${first.sentences} played=${first.played} starts=${starts.length}`);
});

// ---------------------------------------------------------------------------
// 20. An explicit standalone line playing first: the reply queues, the line finishes intact
// ---------------------------------------------------------------------------

test('20. a reply arriving while an explicit assistant_say line plays waits for its finish', async (t) => {
  const gate = deferred();
  const app = await mountVoiceRound(t, { replyText: '回复第一句。回复第二句。回复第三句。', beforeReply: gate });
  app.say('开始');
  await waitUntil(() => app.replyTurnId() !== null, 'the reply turn started');
  // Purpose "explicit": a standalone line, not the answer. The answer itself must never be sent
  // through the tool, so an untagged/answer call would be accepted but not played (new rule).
  const tool = await app.toolSay({ text: '工具先说的这一句。', purpose: 'explicit' });
  assert.equal(tool.accepted, true);
  await waitUntil(() => app.players().length === 1, 'the tool clip started');

  // The reply body arrives while the tool sentence is still sounding.
  gate.resolve();
  // Bounded event wait (2 s), never a fixed sleep: wait until the reply's first sentence has really
  // been synthesized (audio ready, still waiting for the playback seat) before asserting that it
  // did not preempt the sounding tool sentence. A fixed 80 ms could pass before the reply exists.
  await waitUntil(
    () => state.texts.length >= 2,
    'the reply sentence was synthesized and is waiting for the playback seat',
    2000,
  );
  assert.equal(app.players().length, 1, 'the reply did not preempt the playing tool sentence');
  assert.equal(app.players()[0].cancelled, false, 'the tool clip was not cancelled');

  app.resolvePlayer(0);
  for (let index = 1; index < 4; index += 1) {
    await waitUntil(() => app.players().length === index + 1, `reply sentence ${index} reached the player`);
    app.resolvePlayer(index);
  }
  const first = await app.waitForEvent('voice.first-sentence');
  assert.equal(first.sentences, 3);
  assert.equal(first.played, 3, 'the whole reply played after the tool line');
  const rows = await app.events();
  const toolFinish = rows.findIndex((event) => (
    event.type === 'speech.finish' && event.payload.speechId === tool.speechId
  ));
  const replyStarts = rows
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event.type === 'speech.play.start' && event.payload.speechId !== tool.speechId);
  assert.ok(toolFinish >= 0, 'the tool line reported its finish');
  assert.ok(replyStarts.length === 3, 'three reply sentences started');
  assert.ok(
    replyStarts[0].index > toolFinish,
    `the first reply start (${replyStarts[0].index}) is after the tool finish (${toolFinish})`,
  );
  assert.equal(
    rows.filter((event) => event.type === 'speech.cancelled').length,
    0,
    'queuing never emits a cancelled event',
  );
  t.diagnostic(`tool finish@${toolFinish}; reply starts@${replyStarts.map((row) => row.index).join(',')}; played=${first.played}`);
});

// ---------------------------------------------------------------------------
// 21. reply playing first: an explicit line queues, the sentence finishes intact
// ---------------------------------------------------------------------------

test('21. an explicit assistant_say line while a reply sentence plays queues and never cuts it', async (t) => {
  const app = await mountVoiceRound(t, { replyText: '回复第一句。回复第二句。' });
  app.say('开始');
  await waitUntil(() => app.players().length === 1, 'the first reply sentence started');
  const tool = await app.toolSay({ text: '工具补充一句。', purpose: 'explicit' });
  assert.equal(tool.accepted, true);
  await tick(80);
  assert.equal(app.players().length, 1, 'the tool line waited for the playing reply sentence');
  assert.equal(app.players()[0].cancelled, false, 'the reply sentence was not cut');

  app.resolvePlayer(0);
  // FIFO: the tool request was queued before the reply's next sentence.
  await waitUntil(() => app.players().length === 2, 'the queued tool line started');
  app.resolvePlayer(1);
  await waitUntil(() => app.players().length === 3, 'the second reply sentence started');
  app.resolvePlayer(2);
  const first = await app.waitForEvent('voice.first-sentence');
  assert.equal(first.sentences, 2);
  assert.equal(first.played, 2, 'both reply sentences completed');
  const rows = await app.events();
  assert.equal(rows.filter((event) => event.type === 'speech.cancelled').length, 0);
  assert.equal(rows.filter((event) => event.type === 'speech.play.start').length, 3, 'reply 2 + tool 1');
  t.diagnostic(`players=3 played=${first.played}; tool speechId=${tool.speechId}`);
});

// ---------------------------------------------------------------------------
// 22. One answer outlet: the answer tag is dropped; explicit content is a different task
// ---------------------------------------------------------------------------

test('22. an answer-tagged tool line never plays; the reply speaks it once (explicit content still plays)', async (t) => {
  const gate = deferred();
  const app = await mountVoiceRound(t, { replyText: '工具同一句。', beforeReply: gate });
  app.say('开始');
  await waitUntil(() => app.replyTurnId() !== null, 'the reply turn started');
  // The old rule dropped a reply sentence that duplicated the tool line. The new rule reverses the
  // direction: the tool line is the duplicate and is accepted without playback; the reply keeps the
  // complete answer (every block, in order) as the one voice outlet.
  const tool = await app.toolSay({ text: '工具同一句。', purpose: 'answer' });
  assert.equal(tool.accepted, true, 'the call is still accepted, never rejected');
  assert.equal(tool.status, 'skipped');
  assert.equal(tool.reason, 'answer-goes-through-reply');
  await app.waitForEvent('voice.say.skipped', (payload) => payload.reason === 'answer-goes-through-reply');
  assert.equal(app.players().length, 0, 'the answer-tagged line never opened a player');
  gate.resolve();
  await waitUntil(() => app.players().length === 1, 'the reply sentence played');
  app.resolvePlayer(0);
  const first = await app.waitForEvent('voice.first-sentence');
  assert.equal(first.sentences, 1);
  assert.equal(first.played, 1, 'the reply spoke the answer once');
  const rows = await app.events();
  assert.equal(
    rows.filter((event) => event.type === 'speech.play.start' && event.payload.lane === 'say').length,
    0,
    'no say play.start',
  );
  t.diagnostic(`answer-tagged say skipped; players=1 reply; say play.start=0`);

  // A deliberately explicit line is a different task identity and still plays on its own.
  const gate2 = deferred();
  const app2 = await mountVoiceRound(t, { replyText: '补充不同的一句。', beforeReply: gate2 });
  app2.say('开始');
  await waitUntil(() => app2.replyTurnId() !== null, 'the second reply turn started');
  const tool2 = await app2.toolSay({ text: '工具说的一句。', purpose: 'explicit' });
  assert.equal(tool2.accepted, true);
  await waitUntil(() => app2.players().length === 1, 'the explicit line started');
  gate2.resolve();
  await tick(80);
  assert.equal(app2.players().length, 1, 'the supplement reply queued behind the explicit line');
  app2.resolvePlayer(0);
  await waitUntil(() => app2.players().length === 2, 'the supplement reply sentence started');
  app2.resolvePlayer(1);
  const second = await app2.waitForEvent('voice.first-sentence');
  assert.equal(second.sentences, 1);
  assert.equal(second.played, 1, 'the different supplement played');
  await app2.waitForEvent('speech.finish', (payload) => payload.speechId === tool2.speechId);
  t.diagnostic(`explicit line + reply: players=2 sentences=${second.sentences} played=${second.played}`);
});

// ---------------------------------------------------------------------------
// 23. Cross-entry dedupe: only a COMPLETE repeat is dropped, never a supplement
// ---------------------------------------------------------------------------

test('23. dedupe drops only complete repeats; a sentence sharing a short fragment still plays', () => {
  const ledger = createSpeechLedger();
  // The counterexample from review: tool said only 「我在」; the reply adds information.
  assert.equal(ledger.claimText({ sessionId: 's-dedupe', turn: 1, text: '我在', owner: 'speech' }).ok, true);
  const supplement = ledger.claimText({
    sessionId: 's-dedupe', turn: 1, text: '我在这里陪你，你可以慢慢说', owner: 'reply',
  });
  assert.equal(supplement.ok, true, 'a superset with new information must play');
  assert.equal(supplement.duplicate, false);

  // Exact repeat, and a shorter sentence wholly contained in what was spoken, are duplicates.
  const exact = ledger.claimText({ sessionId: 's-dedupe', turn: 2, text: '好的，我这就去。', owner: 'speech' });
  assert.equal(exact.ok, true);
  const repeat = ledger.claimText({ sessionId: 's-dedupe', turn: 2, text: '好的，我这就去。', owner: 'reply' });
  assert.equal(repeat.duplicate, true, 'an exact repeat is dropped');
  const contained = ledger.claimText({ sessionId: 's-dedupe', turn: 2, text: '我这就去', owner: 'reply' });
  assert.equal(contained.duplicate, true, 'a wholly contained shorter sentence has no new information');
});

// ---------------------------------------------------------------------------
// 24. Playback seat: granted means exclusive until finish/failed/cancel
// ---------------------------------------------------------------------------

test('24. a slow first audio keeps the seat: a later request waits instead of superseding', async () => {
  const emitted = [];
  const ledger = createSpeechLedger({ emit: async (type, payload) => { emitted.push({ type, payload }); } });
  const gate = deferred();
  let firstAudio = null;
  const a = ledger.accept({
    sessionId: 's-seat',
    turn: 1,
    text: 'A',
    claimText: true,
    run: async ({ speechId, onFirstAudio }) => {
      // Granted, still no first audio: the player start is slow (>1 s).
      await ledger.waitPlaybackTurn(speechId, { timeoutMs: 5000 });
      await new Promise((resolve) => setTimeout(resolve, 1200));
      firstAudio = Date.now();
      onFirstAudio(firstAudio);
      await gate.promise;
    },
  });
  assert.equal(a.accepted, true);
  // Wait until A really owns the seat.
  await waitUntil(() => emitted.some((row) => row.type === 'speech.synth.start'), 'A started');

  let bAudio = 0;
  const b = ledger.accept({
    sessionId: 's-seat',
    turn: 1,
    text: 'B',
    claimText: true,
    run: async ({ speechId, onFirstAudio }) => {
      await ledger.waitPlaybackTurn(speechId, { timeoutMs: 5000 });
      bAudio = Date.now();
      onFirstAudio(bAudio);
    },
  });

  // While A has no first audio, B must NOT be granted: a short wait rejects with the queue
  // timeout (still waiting), never with a superseded/cancelled reason.
  const waiting = await ledger.wait(b.speechId, { timeoutMs: 100 }).catch(() => null);
  assert.equal(waiting?.status, 'synthesizing', `B is still waiting while A holds the seat: ${JSON.stringify(waiting)}`);
  await tick(150);
  assert.equal(bAudio, 0, 'B never started during A\'s slow start');

  gate.resolve();
  await waitUntil(() => bAudio > 0, 'B started only after A finished');
  assert.ok(bAudio >= firstAudio, 'B follows A');
  assert.equal(emitted.some((row) => row.type === 'speech.cancelled'), false, 'nothing was superseded');
  assert.equal(ledger.statusOf(b.speechId)?.status === 'playing'
    || ledger.statusOf(b.speechId)?.status === 'finished', true, 'B owns the seat after A');
  ledger.cancel(a.speechId, 'test-cleanup');
  ledger.cancel(b.speechId, 'test-cleanup');
});

// ---------------------------------------------------------------------------
// 25. speech-text residuals reach the host event log (throttled per kind)
// ---------------------------------------------------------------------------

test('25. an unremovable Markdown residual is logged once per kind, not once per render', async (t) => {
  const app = await mount(t);
  const residualRows = async () => (await app.events()).filter((event) => event.type === 'speech-text.residual');
  const playOne = async (text) => {
    const before = state.players.length;
    const said = await app.say({ text });
    assert.equal(said.accepted, true, `the clip is accepted: ${text}`);
    await waitUntil(() => state.players.length > before, `the clip reached the player: ${text}`);
    state.players.at(-1).resolve();
    await app.waitForEvent('speech.finish', (payload) => payload.speechId === said.speechId);
    return said;
  };

  // An unmatched `**` cannot be removed without guessing: it is reported, never dropped silently.
  await playOne('**未闭合的强调');
  const afterFirst = await residualRows();
  assert.equal(afterFirst.length, 1, 'the forced emphasis residual reached the event log');
  assert.equal(afterFirst[0].payload.kind, 'emphasis');
  assert.equal(afterFirst[0].payload.sample, '**未闭合的强调');

  // A second residual of the SAME kind within a minute is throttled away.
  await playOne('**又一个未闭合');
  assert.equal((await residualRows()).length, 1, 'the same kind is logged at most once per 60 s');

  // A different kind has its own throttle bucket.
  await playOne('`未闭合的代码');
  const afterThird = await residualRows();
  assert.equal(afterThird.length, 2, 'a different residual kind gets its own row');
  assert.equal(afterThird[1].payload.kind, 'code-span');
  t.diagnostic(`residuals=${afterThird.map((row) => row.payload.kind).join(',')} throttledSameKind=${(await residualRows()).filter((row) => row.payload.kind === 'emphasis').length}`);
});

// ---------------------------------------------------------------------------
// 26. status.profile exposes the organizer's category stack
// ---------------------------------------------------------------------------

test('26. status.profile carries the maintainer category stack as an array', async (t) => {
  const app = await mount(t);
  const status = await app.status();
  assert.ok(Array.isArray(status.profile.categories), 'categories is always an array, never undefined');
  assert.deepEqual(status.profile.categories, [], 'no organizer instance has run yet: an empty stack, not a missing field');
  t.diagnostic(`status.profile keys=${Object.keys(status.profile).join(',')} categories=${status.profile.categories.length}`);
});

// ---------------------------------------------------------------------------
// 27. Subtitle hold: stays after the real audio end; the next line replaces it in place
// ---------------------------------------------------------------------------

test('27. the caption holds 1200ms after the real audio end; the next line replaces it in place', async (t) => {
  const app = await mount(t);
  const startClip = async (text) => {
    const before = state.players.length;
    const said = await app.say({ text });
    assert.equal(said.accepted, true, `the tool accepted: ${text}`);
    await waitUntil(() => state.players.length > before, `the clip reached the player: ${text}`);
    return state.players.at(-1);
  };

  const first = await startClip('第一句。');
  first.onStart?.({ startedAt: Date.now() });
  await waitUntil(() => state.subtitles.length === 1, 'the first caption is shown');
  const firstEnd = Date.now();
  first.resolve();
  await tick(900);
  assert.equal(state.hideTimes.length, 0, 'still visible 900ms after the real end');

  // The next sentence starts inside the hold: one write replaces the text, no hide in between.
  const second = await startClip('第二句会稍微长一些。');
  second.onStart?.({ startedAt: Date.now() });
  await waitUntil(() => state.subtitles.length === 2, 'the second caption is shown');
  assert.equal(state.hideTimes.length, 0, 'no flicker: the held line was replaced, never hidden');
  assert.equal(state.subtitles.at(-1).text, '第二句会稍微长一些。', 'the screen carries the newer sentence');
  await tick(400);
  assert.equal(state.hideTimes.length, 0, 'the old hold timer cannot hide the newer line');

  const secondEnd = Date.now();
  second.resolve();
  await waitUntil(() => state.hideTimes.length === 1, 'the second caption hides after its own hold', 4000);
  const held = state.hideTimes[0] - secondEnd;
  assert.ok(held >= 1000 && held <= 1800, `hold after the real end=${held}ms`);
  const holdRow = await app.waitForEvent('subtitle.hold');
  assert.equal(holdRow.ms, 1200, 'the observation row carries the configured hold');
  t.diagnostic(
    `firstEnd->hide after replacement never happened; second hold=${held}ms (configured ${holdRow.ms}ms); `
    + `captions=${state.subtitles.length} hides=${state.hideTimes.length}`,
  );
  // Silence: the first hold was cancelled by the replacement, not by a timer that could hide line 2.
  assert.ok(firstEnd > 0);
});

// ---------------------------------------------------------------------------
// 28. The hide is driven by the real player exit, not by durationMs or caption length
// ---------------------------------------------------------------------------

test('28. a 2s estimate with a 5s real clip does not hide early; a short caption changes nothing', async (t) => {
  const app = await mount(t);
  // The synthesizer claims 2s; the player actually runs 5s. The supplied caption ("translation")
  // is far shorter than the spoken line, so a length-based rule would hide it immediately.
  state.synth = async ({ text }) => ({
    file: join(app.root, 'tts', 'slow.mp3'), bytes: 16, durationMs: 2000, provider: 'edge-tts',
  });
  const said = await app.say({ text: '这是一句会播放五秒的正文，比它的字幕长很多。', subtitle: '短' });
  assert.equal(said.accepted, true);
  await waitUntil(() => state.players.length === 1, 'the slow clip reached the player');
  const player = state.players[0];
  player.onStart?.({ startedAt: Date.now() });
  await waitUntil(() => state.subtitles.length === 1, 'the caption is shown');
  assert.equal(state.subtitles[0].text, '短', 'the short caption is what is displayed');

  // 3.3s after the show: the old implementation (durationMs 2s + 1.2s hold) has already hidden
  // even though the player is still sounding.
  await tick(3300);
  assert.equal(state.hideTimes.length, 0, 'still playing: the caption never follows the 2s estimate');
  assert.equal(state.subtitles.length, 1, 'the short caption did not cause an early hide');
  const visibleWhilePlaying = state.hideTimes.length === 0;

  await tick(1700); // the real audio lasts 5s
  const endedAt = Date.now();
  player.resolve();
  await tick(600);
  assert.equal(state.hideTimes.length, 0, 'after the real end the configured hold runs');
  await waitUntil(() => state.hideTimes.length === 1, 'the caption hides after the hold', 4000);
  const held = state.hideTimes[0] - endedAt;
  assert.ok(held >= 1000 && held <= 1800, `hold measured from the real player exit=${held}ms`);
  t.diagnostic(
    `estimate=2000ms real=5000ms captionChars=1: no hide before the real exit; hold=${held}ms `
    + `visibleWhilePlaying=${visibleWhilePlaying}`,
  );
});

// ---------------------------------------------------------------------------
// 29. An interruption hides immediately, never after the remaining hold
// ---------------------------------------------------------------------------

test('29. an interruption during the hold hides the caption at once', async (t) => {
  const app = await mount(t);
  const said = await app.say({ text: '第一句。' });
  assert.equal(said.accepted, true);
  await waitUntil(() => state.players.length === 1, 'the clip reached the player');
  state.players[0].onStart?.({ startedAt: Date.now() });
  await waitUntil(() => state.subtitles.length === 1, 'the caption is shown');
  state.players[0].resolve();
  await tick(300); // inside the 1200ms hold
  assert.equal(state.hideTimes.length, 0, 'the hold is still running');

  const mutedAt = Date.now();
  const muted = await app.action({ action: 'voice.mute', muted: true });
  assert.equal(muted.ok, true);
  await waitUntil(() => state.hideTimes.length === 1, 'the mute hides the caption immediately', 1000);
  const latency = state.hideTimes[0] - mutedAt;
  assert.ok(latency < 600, `interrupt hide latency=${latency}ms (must not wait out the hold)`);
  t.diagnostic(`mute during hold: hide after ${latency}ms (hold left ~900ms, not awaited)`);
});

// ---------------------------------------------------------------------------
// 30. Ack metrics: synthesis 600ms -> ready ~600, first audio at the 2s trigger
// ---------------------------------------------------------------------------

test('30. ack metrics: ackReadyMs~600, ackFirstAudioMs~2000, and the line really played once', async (t) => {
  const { lane, events, plays } = laneFixture({
    delayMs: 2000,
    synthesize: async ({ speech }) => {
      await tick(600);
      return { file: 'ack.mp3', speech };
    },
  });
  lane.beginTurn({ sessionId: 's-metrics', turn: 20, userText: '帮我查一下天气' });
  const row = await waitUntil(() => ackEvent(events, 'voice.ack.spoken'), 'the line played', 5000);
  const spoken = row.payload;
  assert.ok(spoken, 'voice.ack.spoken was recorded');
  assert.equal(plays.length, 1, 'played exactly once');
  assert.ok(spoken.ackReadyMs >= 550 && spoken.ackReadyMs <= 1000, `ackReadyMs=${spoken.ackReadyMs}`);
  assert.ok(spoken.ackTriggerMs >= 1900, `ackTriggerMs=${spoken.ackTriggerMs}`);
  assert.ok(spoken.ackFirstAudioMs >= 1900 && spoken.ackFirstAudioMs <= 2400, `ackFirstAudioMs=${spoken.ackFirstAudioMs}`);
  for (const field of ['prepareStartedAt', 'textReadyAt', 'audioReadyAt', 'playedAt']) {
    assert.ok(spoken[field] > 0, `voice.ack.spoken carries ${field}`);
  }
  assert.equal(spoken.ackDroppedMs, null, 'a played line was not dropped');
  plays[0].end();
  await lane.whenIdle();
  t.diagnostic(
    `synth=600ms run=2000ms: ackReadyMs=${spoken.ackReadyMs} ackFirstAudioMs=${spoken.ackFirstAudioMs} `
    + `playedOnce=${plays.length === 1} stamps=${spoken.prepareStartedAt > 0 && spoken.textReadyAt > 0 && spoken.audioReadyAt > 0 && spoken.playedAt > 0}`,
  );
});

// ---------------------------------------------------------------------------
// 31. An unplayed line reports ackDroppedMs and its real reason
// ---------------------------------------------------------------------------

test('31. a line that never played reports ackDroppedMs and reason', async (t) => {
  const { lane, events, plays } = laneFixture({
    delayMs: 2000,
    synthesize: async ({ speech }) => {
      await tick(600);
      return { file: 'ack.mp3', speech };
    },
  });
  lane.beginTurn({ sessionId: 's-drop', turn: 21, userText: '帮我查一下天气' });
  await tick(250);
  assert.equal(lane.bodyStarted({ sessionId: 's-drop', turn: 21, at: Date.now() }), true);
  await waitUntil(() => ackEvent(events, 'voice.ack.cancelled'), 'the drop row is written');
  const row = ackEvent(events, 'voice.ack.cancelled').payload;
  assert.equal(row.reason, 'body-first-audio');
  assert.ok(row.ackDroppedMs >= 200 && row.ackDroppedMs <= 1200, `ackDroppedMs=${row.ackDroppedMs}`);
  assert.equal(row.ackFirstAudioMs, null, 'no first audio: it never played');
  await tick(2100);
  assert.equal(plays.length, 0, 'the deadline never played the dropped line');
  await lane.whenIdle();
  t.diagnostic(`dropped at +${row.ackDroppedMs}ms reason=${row.reason} players=${plays.length}`);
});

// ---------------------------------------------------------------------------
// 32. assistant_say still synthesizing at the deadline never cancels the line
// ---------------------------------------------------------------------------

test('32. a 3s-synthesizing assistant_say does not cancel the line; it plays at the 2s trigger', async (t) => {
  const { services } = ackServices();
  const app = await mount(t, { services });
  const SLOW = '这句工具语音要合成三秒';
  const baseSynth = state.synth;
  state.synth = async (options) => {
    if (options.text === SLOW) await tick(3000);
    return baseSynth(options);
  };
  app.emit(app.session, startEvent(33));
  app.emit(app.session, userEvent(33, 'u-33', '帮我查一下明天上海的天气'));
  await tick(400);
  // The tool call starts preparing while the waiting line is still inside its deadline.
  // Untagged say is an answer now and no longer plays on its own: this case tests that a
  // slow, INDEPENDENT line does not cancel the waiting line, so it must ask for that explicitly.
  const said = await app.say({ text: SLOW, purpose: 'explicit' }, { agent: { session: { id: app.session.id } } });
  assert.equal(said.accepted, true);
  const spoken = await app.waitForEvent('voice.ack.spoken', (payload) => payload.turn === 33);
  assert.ok(spoken.ackFirstAudioMs >= 1900, `ackFirstAudioMs=${spoken.ackFirstAudioMs}`);
  const rows = await app.events();
  assert.equal(
    rows.filter((event) => event.type === 'voice.ack.cancelled' && event.payload.reason === 'superseded').length,
    0,
    'preparation/synthesis never uses `superseded` to cancel the line',
  );
  assert.equal(rows.filter((event) => event.type === 'voice.ack.cancelled').length, 0, 'nothing cancelled it before it played');
  assert.equal(app.players().length, 1, 'only the waiting line has sounded so far');
  // The ack clip ends; the slow tool clip reaches the player at ~3s, where its first audio may
  // cancel a line, but this one has already played and is settled.
  state.players[0].resolve();
  await waitUntil(() => app.players().length === 2, 'the tool clip reaches the player', 6000);
  state.players[1].onStart?.({ startedAt: Date.now() });
  await tick(50);
  assert.equal(
    (await app.events()).filter((event) => event.type === 'voice.ack.cancelled' && event.payload.turn === 33).length,
    0,
    'a played line is not retroactively cancelled',
  );
  state.players[1].resolve();
  t.diagnostic(
    `saySynth=3000ms ackFirstAudioMs=${spoken.ackFirstAudioMs} superseded=0 cancelledBeforePlay=0`,
  );
});

// ---------------------------------------------------------------------------
// 33. Only a newer turn (or explicit user interruption) cancels an unplayed line
// ---------------------------------------------------------------------------

test('33. a newer turn cancels the old line; the drop row carries the superseded reason', async (t) => {
  const { lane, events, plays } = laneFixture({ delayMs: 2000 });
  lane.beginTurn({ sessionId: 's-turn', turn: 40, userText: '帮我查一下天气' });
  await tick(80);
  assert.equal(lane.cancelSuperseded('s-turn', 41, 'superseded'), true);
  await waitUntil(() => ackEvent(events, 'voice.ack.cancelled'), 'the supersede row is written');
  const row = ackEvent(events, 'voice.ack.cancelled').payload;
  assert.equal(row.reason, 'superseded');
  assert.ok(row.ackDroppedMs >= 60, `ackDroppedMs=${row.ackDroppedMs}`);
  await tick(2100);
  assert.equal(plays.length, 0, 'the old line never played for the newer turn');
  await lane.whenIdle();
  t.diagnostic(`new turn 41 drops turn 40 at +${row.ackDroppedMs}ms reason=${row.reason} players=0`);
});

// ---------------------------------------------------------------------------
// 34. Barge-in evidence: one partial is not the user; a loud sustained streak is
// ---------------------------------------------------------------------------

/** Deterministic reply synthesis for the mounted voice round, at a chosen real length. */
const useReplySynth = (root, durationMs = 200) => {
  state.synth = async ({ text }) => ({
    file: join(root, 'tts', `${text.length}-${durationMs}.mp3`),
    bytes: 16,
    durationMs,
    provider: 'edge-tts',
  });
};

/** Apply say → wait until the reply body is really sounding, so a barge-in has something to cut. */
const startSoundingReply = async (app, text = '第一句。') => {
  useReplySynth(app.root);
  app.say('开始');
  await waitUntil(() => app.players().length === 1, `the reply sentence "${text}" reached the player`);
};

test('34. a single partial frame never barges in (no cancel, no shortcut)', async (t) => {
  const app = await mountVoiceRound(t, { replyText: '第一句。' });
  await startSoundingReply(app);
  // Two characters, loud: exactly the old false-positive trigger.
  state.onUpdate({ partial: '你好' });
  await tick(120);
  const rows = await app.events();
  assert.equal(rows.filter((event) => event.type === 'hearing.bargein').length, 0, 'one frame is not evidence');
  assert.equal(rows.filter((event) => event.type === 'speech.cancelled').length, 0, 'the sounding sentence was not cut');
  assert.equal(app.players().length, 1, 'the clip is still the only playback');
  app.resolvePlayer(0);
  t.diagnostic('one loud partial: hearing.bargein=0 speech.cancelled=0');
});

test('35. three loud partial frames are reported but never interrupt (switch off by default)', async (t) => {
  const app = await mountVoiceRound(t, { replyText: '第一句。' });
  await startSoundingReply(app);
  // The first frame is too short to count; then three real frames of pure noise.
  state.onUpdate({ partial: '你' });
  state.onUpdate({ partial: '你好' });
  state.onUpdate({ partial: '你好啊' });
  state.onUpdate({ partial: '你好啊我' });
  // The evidence row is kept (debug), the playback is not: a loud streak is not a sentence.
  const skipped = await app.waitForEvent(
    'hearing.bargein.skipped',
    (payload) => payload.reason === 'partial-disabled',
  );
  assert.equal(skipped.frames, 3, 'the confirmed streak length is reported');
  assert.ok(skipped.rmsDb >= -38, `the frame was loud enough (${skipped.rmsDb}dB)`);
  await tick(120);
  const rows = await app.events();
  assert.equal(rows.filter((event) => event.type === 'hearing.bargein').length, 0, 'no barge-in row');
  assert.equal(rows.filter((event) => event.type === 'speech.cancelled').length, 0, 'the sentence keeps playing');
  assert.equal(app.players().length, 1, 'the clip is still the only playback');
  assert.equal(app.players()[0].cancelled, false);
  app.resolvePlayer(0);
  t.diagnostic(`partial-disabled: frames=${skipped.frames} rmsDb=${skipped.rmsDb} cancelled=0`);
});

test('35b. voice.bargeInPartial:true restores the old partial interrupt', async (t) => {
  const app = await mountVoiceRound(t, { replyText: '第一句。', bargeInPartial: true });
  await startSoundingReply(app);
  state.onUpdate({ partial: '你' });
  state.onUpdate({ partial: '你好' });
  state.onUpdate({ partial: '你好啊' });
  state.onUpdate({ partial: '你好啊我' });
  const barge = await app.waitForEvent('hearing.bargein', (payload) => payload.source === 'partial');
  assert.equal(barge.frames, 3, 'the confirmed streak length is reported');
  const cancelled = await app.waitForEvent('speech.cancelled');
  assert.equal(cancelled.reason, 'voice', 'the opt-in experiment cancels under the voice reason');
  t.diagnostic(`bargeInPartial:true frames=${barge.frames} cancelled=${cancelled.reason}`);
});

test('35c. without a settings key, config.voice.bargeInPartial turns the experiment on', async (t) => {
  const app = await mountVoiceRound(t, {
    replyText: '第一句。', config: { voice: { bargeInPartial: true } },
  });
  await startSoundingReply(app);
  for (const partial of ['你好', '你好啊', '你好啊我']) state.onUpdate({ partial });
  const barge = await app.waitForEvent('hearing.bargein', (payload) => payload.source === 'partial');
  assert.equal(barge.frames, 3);
  const cancelled = await app.waitForEvent('speech.cancelled');
  assert.equal(cancelled.reason, 'voice', 'config is the fallback when settings has no key');
  t.diagnostic(`config fallback: frames=${barge.frames} cancelled=${cancelled.reason}`);
});

test('35d. an explicit settings false wins over config true', async (t) => {
  const app = await mountVoiceRound(t, {
    replyText: '第一句。', bargeInPartial: false, config: { voice: { bargeInPartial: true } },
  });
  await startSoundingReply(app);
  for (const partial of ['你好', '你好啊', '你好啊我']) state.onUpdate({ partial });
  const skipped = await app.waitForEvent(
    'hearing.bargein.skipped',
    (payload) => payload.reason === 'partial-disabled',
  );
  assert.equal(skipped.frames, 3);
  await tick(120);
  const rows = await app.events();
  assert.equal(rows.filter((event) => event.type === 'hearing.bargein').length, 0, 'settings wins over config');
  assert.equal(rows.filter((event) => event.type === 'speech.cancelled').length, 0, 'the sentence keeps playing');
  app.resolvePlayer(0);
  t.diagnostic(`settings false overrides config: frames=${skipped.frames} cancelled=0`);
});

test('36. loud frames that are too quiet never confirm a barge-in', async (t) => {
  const app = await mountVoiceRound(t, { replyText: '第一句。' });
  await startSoundingReply(app);
  state.hearingStats = { rmsDb: -70 };
  for (const partial of ['你好', '你好啊', '你好啊我', '你好啊我在', '你好啊我在听']) {
    state.onUpdate({ partial });
  }
  await tick(120);
  const rows = await app.events();
  assert.equal(rows.filter((event) => event.type === 'hearing.bargein').length, 0, 'quiet frames are room tone');
  assert.equal(rows.filter((event) => event.type === 'speech.cancelled').length, 0, 'the sentence keeps playing');
  app.resolvePlayer(0);
  t.diagnostic('five quiet partials: hearing.bargein=0 speech.cancelled=0');
});

test('37. a completed utterance (final) interrupts the sounding sentence', async (t) => {
  const app = await mountVoiceRound(t, { replyText: '第一句。' });
  await startSoundingReply(app);
  // A final has already passed the ASR duration/level/text gates: it is the user.
  app.say('打断你一下');
  const barge = await app.waitForEvent('hearing.bargein', (payload) => payload.source === 'final');
  assert.equal(barge.source, 'final');
  const cancelled = await app.waitForEvent('speech.cancelled');
  assert.equal(cancelled.reason, 'voice');
  t.diagnostic(`final barge-in: cancelled=${cancelled.reason}`);
});

test('38. a real end clears speaking even while the duration estimate is still in the future', async (t) => {
  const app = await mountVoiceRound(t, { replyText: '第一句。第二句。' });
  // The first clip claims a 5s estimate but its player really closes at once. The second
  // sentence is held in synthesis, so at the moment of the partials NOTHING is playing — yet the
  // old `startedAt + duration + 400` clock would still claim "speaking" and cancel the queue.
  const secondGate = deferred();
  state.synth = async ({ text }) => {
    if (text.includes('第二句')) await secondGate.promise;
    return {
      file: join(app.root, 'tts', `est-${text.length}.mp3`), bytes: 16, durationMs: 5000, provider: 'edge-tts',
    };
  };
  app.say('开始');
  await waitUntil(() => app.players().length === 1, 'the long-estimate clip reached the player');
  app.resolvePlayer(0);
  await app.waitForEvent('speech.finish');
  await tick(30);
  state.onUpdate({ partial: '你好' });
  state.onUpdate({ partial: '你好啊' });
  state.onUpdate({ partial: '你好啊我' });
  await tick(120);
  const rows = await app.events();
  assert.equal(rows.filter((event) => event.type === 'hearing.bargein').length, 0, 'the player already closed');
  assert.equal(rows.filter((event) => event.type === 'speech.cancelled').length, 0, 'an estimate is not playback');
  // The queued second sentence survives the partials and still plays once synthesis returns.
  secondGate.resolve();
  await waitUntil(() => app.players().length === 2, 'the queued second sentence still played', 3000);
  t.diagnostic('player closed before the 5s estimate: three loud partials cancelled nothing and sentence 2 played');
});

// ---------------------------------------------------------------------------
// 39. cancelBodyStarted is scoped by (sessionId, turn), never global
// ---------------------------------------------------------------------------

test('39. cancelBodyStarted cancels only its own (sessionId, turn) line', async (t) => {
  const { lane, events, plays } = laneFixture({ delayMs: 60 });
  lane.beginTurn({ sessionId: 's-a', turn: 1, userText: '帮我查一下天气' });
  lane.beginTurn({ sessionId: 's-b', turn: 2, userText: '帮我读一下文件' });
  await tick(20);
  // A mismatched key (another session, another turn) finds no record and cancels nothing.
  assert.equal(lane.cancelBodyStarted({ sessionId: 's-a', turn: 2 }), false);
  assert.equal(lane.cancelBodyStarted({ sessionId: 's-c', turn: 1 }), false);
  await tick(20);
  assert.equal(plays.length, 0, 'a mismatched key never cancelled a line');
  assert.equal(lane.cancelBodyStarted({ sessionId: 's-a', turn: 1 }), true);
  await waitUntil(() => ackEvent(events, 'voice.ack.cancelled'), 'the named line is cancelled');
  assert.equal(ackEvent(events, 'voice.ack.cancelled').payload.turn, 1);
  await waitUntil(() => ackEvent(events, 'voice.ack.spoken'), 'the other session still speaks');
  assert.equal(ackEvent(events, 'voice.ack.spoken').payload.turn, 2);
  plays[0].end();
  await lane.whenIdle();
  t.diagnostic('scoped cancel: turn 1 cancelled, turn 2 spoken');
});

// ---------------------------------------------------------------------------
// 40. The waiting line is "playing" only after the player's real start event
// ---------------------------------------------------------------------------

test('40. answerStart trusts the real start: play() resolving first is not "playing"', async () => {
  let startHook = null;
  let end = () => {};
  const { lane } = laneFixture({
    delayMs: 20,
    play: async () => {
      const done = new Promise((resolve) => { end = resolve; });
      const session = {
        ended: false,
        cancelled: false,
        done,
        onStart(hook) { startHook = hook; },
      };
      return { audioStartedAt: Date.now(), done, session };
    },
  });
  lane.beginTurn({ sessionId: 's-start', turn: 3, userText: '帮我查一下天气' });
  await waitUntil(() => startHook !== null, 'the clip reached the player');
  const phaseOf = () => lane.status().find((record) => record.turn === 3)?.phase;
  // `play()` already resolved, but no player start: the line is not playing, so it blocks nothing.
  assert.equal(phaseOf(), 'ready');
  assert.deepEqual(await lane.answerStart({ sessionId: 's-start', turn: 3 }), { action: 'speak' });
  // The real start back-fills the fact the answer may trust.
  startHook({ startedAt: Date.now() });
  assert.equal(phaseOf(), 'playing');
  end();
  await lane.whenIdle();
});

// ---------------------------------------------------------------------------
// 41. A caption-only line owns its hold; a playback cancel does not take it down
// ---------------------------------------------------------------------------

test('41. a caption-only line survives a cancel that belongs to playback', async (t) => {
  const app = await mount(t);
  // A pure code block is caption-only: nothing is synthesized and no playback session exists.
  const said = await app.say({ text: '```js\nconst a = 1;\n```' });
  assert.equal(said.accepted, false);
  await waitUntil(() => state.subtitles.length === 1, 'the caption-only line is shown');
  const before = state.hides;
  assert.equal((await app.action({ action: 'voice.mute', muted: true })).ok, true);
  await tick(60);
  assert.equal(state.hides, before, 'the caption-only line keeps its own hold');
  await app.action({ action: 'voice.mute', muted: false });
  t.diagnostic(`caption-only line: hides before=${before} after cancel=${state.hides}`);
});

// ---------------------------------------------------------------------------
// 42. A reply that waits past speechQueueWaitMs is reported, not dropped
// ---------------------------------------------------------------------------

test('42. a slow reply queue is reported and keeps waiting instead of failing', async () => {
  const emitted = [];
  const ledger = createSpeechLedger({ emit: async (type, payload) => { emitted.push({ type, payload }); } });
  const gate = deferred();
  const a = ledger.accept({
    sessionId: 's-qs', turn: 1, text: 'A', kind: 'reply', claimText: true,
    run: async ({ speechId, onFirstAudio }) => {
      await ledger.waitPlaybackTurn(speechId, { timeoutMs: 5000 });
      onFirstAudio(Date.now());
      await gate.promise;
    },
  });
  await waitUntil(() => emitted.some((row) => row.type === 'speech.synth.start'), 'A started');
  let bGranted = false;
  const b = ledger.accept({
    sessionId: 's-qs', turn: 1, text: 'B', kind: 'reply', claimText: true,
    run: async ({ speechId, onFirstAudio }) => {
      // A short budget: this used to reject with SPEECH_QUEUE_TIMEOUT and drop the sentence.
      await ledger.waitPlaybackTurn(speechId, { timeoutMs: 40 });
      bGranted = true;
      onFirstAudio(Date.now());
    },
  });
  const slow = await waitUntil(
    () => emitted.find((row) => row.type === 'speech.queue.timeout'),
    'the slow reply queue is reported',
    2000,
  );
  assert.equal(slow.payload.lane, 'reply');
  assert.equal(bGranted, false, 'the reply keeps its place instead of being dropped');
  assert.equal(ledger.statusOf(b.speechId)?.status, 'synthesizing');
  gate.resolve();
  await waitUntil(() => bGranted, 'B starts after A finishes');
  assert.equal(emitted.filter((row) => row.type === 'speech.failed').length, 0, 'nothing failed');
  ledger.cancel(a.speechId, 'test-cleanup');
  ledger.cancel(b.speechId, 'test-cleanup');
});

// ---------------------------------------------------------------------------
// 43. answerStart re-evaluates the live phase instead of caching "speak"
// ---------------------------------------------------------------------------

test('43. a line pre-generated early but playing now makes answerStart wait for it', async (t) => {
  const { lane, plays } = laneFixture({ delayMs: 200 });
  lane.beginTurn({ sessionId: 's-live', turn: 5, userText: '帮我查一下天气' });
  // Before the deadline the line has been prepared but is not playing: the first verdict passes.
  assert.deepEqual(
    await lane.answerStart({ sessionId: 's-live', turn: 5 }),
    { action: 'speak' },
    'a preparing line does not block the answer',
  );
  await waitUntil(() => plays.length === 1, 'the line reached the player');
  // The same request now arrives while the line is really playing: the verdict must change. The
  // old cache kept returning "speak", so the answer talked over the waiting line.
  let settled = false;
  const gatePromise = lane.answerStart({ sessionId: 's-live', turn: 5 }).then((gate) => {
    settled = true;
    return gate;
  });
  await tick(40);
  assert.equal(settled, false, 'the answer waits for the line that is now playing');
  plays[0].end();
  assert.deepEqual(await gatePromise, { action: 'finish-ack-then-answer' });
  await lane.whenIdle();
  t.diagnostic('first verdict speak (preparing); second verdict waits (playing); cache only generation');
});

// ---------------------------------------------------------------------------
// 44. Weight application waits for the clip it named, never for its replacement
// ---------------------------------------------------------------------------

test('44. applying models does not interrupt a clip that replaced the one it waited for', async (t) => {
  const app = await mount(t);
  const firstLip = await app.say({ text: '先说的这一句。' });
  assert.equal(firstLip.accepted, true);
  await waitUntil(() => state.players.length === 1, 'the first clip reached the player');
  const applying = app.action({ action: 'gptSovits.applyModels' });
  // The awaited clip ends; a replacement takes the seat while the application is still waiting.
  state.players[0].resolve();
  const replacement = await app.say({ text: '接替的这一句。' });
  assert.equal(replacement.accepted, true);
  const result = await applying;
  assert.equal(result.ok, true);
  assert.equal(result.interrupted, false, 'the wait never claims an interruption');
  assert.equal(result.interruptReason, '');
  await waitUntil(() => state.players.length === 2, 'the replacement reached the player');
  assert.equal(state.players[1].signal?.aborted === true, false, 'the replacement was not cancelled');
  const rows = await app.events();
  assert.equal(
    rows.filter((event) => event.type === 'speech.cancelled').length,
    0,
    'nothing was cancelled while waiting for a clip that had already ended',
  );
  t.diagnostic(
    `applyModels interrupted=${result.interrupted} players=${state.players.length} cancelled=0`,
  );
});

// ---------------------------------------------------------------------------
// 45. Final barge-in validates the transcript before cutting
// ---------------------------------------------------------------------------

test('45. only a valid final interrupts; filtered, echoed and repeated finals are dropped', async (t) => {
  const replyText = '我这就把这段比较长的回答慢慢说给你听。';
  const echoText = '我这就把这段比较长的回答慢慢说给你听';
  const app = await mountVoiceRound(t, { replyText });
  await startSoundingReply(app);
  const eventsNow = () => app.events();
  const cancelledCount = async () => (await eventsNow()).filter((event) => event.type === 'speech.cancelled').length;
  const baseCancels = await cancelledCount();
  const baseTurns = state.turnIds.length;
  // Empty, a lone filler and the assistant's own sounding words: none is evidence of the user.
  state.onUpdate({ final: '', durationMs: 100 });
  state.onUpdate({ final: '嗯', durationMs: 100 });
  state.onUpdate({ final: echoText, durationMs: 100 });
  await tick(150);
  let rows = await eventsNow();
  assert.equal(
    rows.filter((event) => event.type === 'hearing.bargein').length,
    0,
    'an unverified final never causes a barge-in',
  );
  assert.equal(await cancelledCount(), baseCancels, 'no sounding speech was cancelled');
  const skipped = rows.filter((event) => event.type === 'hearing.bargein.skipped')
    .map((event) => event.payload.reason);
  assert.ok(skipped.includes('empty'), `expected an empty skip, got ${skipped.join(',')}`);
  assert.ok(skipped.includes('filler'), `expected a filler skip, got ${skipped.join(',')}`);
  assert.ok(skipped.includes('echo'), `expected an echo skip, got ${skipped.join(',')}`);
  assert.equal(state.turnIds.length, baseTurns, 'a filtered/echo final is not queued as a turn');
  // A real final both interrupts and becomes the next turn.
  state.onUpdate({ final: '等一下先停一下听我说', durationMs: 100 });
  const barge = await app.waitForEvent('hearing.bargein', (payload) => payload.source === 'final');
  assert.equal(barge.deduped, false);
  const cancelled = await app.waitForEvent('speech.cancelled');
  assert.equal(cancelled.reason, 'voice');
  // A second identical final while the new reply sounds is a duplicate: no second cut, no turn.
  await waitUntil(() => app.players().length === 2, 'the new turn reply reached the player', 5000);
  const afterCancel = await cancelledCount();
  const turnsAfterFirst = state.turnIds.length;
  state.onUpdate({ final: '等一下先停一下听我说', durationMs: 100 });
  await tick(150);
  rows = await eventsNow();
  assert.equal(await cancelledCount(), afterCancel, 'a duplicate final does not interrupt again');
  const duplicate = rows.filter(
    (event) => event.type === 'hearing.bargein.skipped' && event.payload.reason === 'duplicate',
  );
  assert.ok(duplicate.length >= 1, 'the duplicate final is reported as deduped');
  assert.equal(duplicate.at(-1).payload.deduped, true);
  assert.equal(state.turnIds.length, turnsAfterFirst, 'the duplicate final is dropped, not delivered');
  t.diagnostic(
    `filtered final: bargein=0 cancelled=0 dropped=1; valid final: cancelled=${cancelled.reason}; `
    + `duplicate: skipped=${duplicate.length} turn unchanged`,
  );
});

// ---------------------------------------------------------------------------
// 46. assistant_say uses the block pipeline: block 0 first, one whole-line caption
// ---------------------------------------------------------------------------

const CHUNK_LONG = '今天上海的天气有点凉，出门记得带一件外套，晚上回来的时候可能会下雨。';
/** One comma-level block of `CHUNK_LONG`: 11 + 10 + 13 characters. */
const CHUNK_BLOCKS = ['今天上海的天气有点凉，', '出门记得带一件外套，', '晚上回来的时候可能会下雨。'];
/** How long one character takes in the fixture's fake synthesizer (ms). */
const SYNTH_PER_CHAR_MS = 20;
/**
 * The causal ordering must clear at least one event-loop turn: a 0–1ms `Date.now()` tie between
 * "block 0 started" and "the last synthesis finished" must not pass as a real lead.
 */
const ORDER_MARGIN_MS = 5;

/**
 * The slow-synthesis fixture shared by test 46 and its counter-proof. Every synthesis records its
 * text and its start/finish time, so the test can reason about causal order instead of comparing
 * two estimated durations. `since` is the test's zero (the instant the line was accepted).
 */
function timedSynth(app, since) {
  const rows = [];
  state.synth = async ({ text }) => {
    const startAt = Date.now() - since;
    await tick(Math.max(4, [...text].length * SYNTH_PER_CHAR_MS));
    state.texts.push(text);
    const doneAt = Date.now() - since;
    rows.push({ text, startAt, doneAt });
    return {
      file: join(app.root, 'tts', `blk-${state.texts.length}.mp3`), bytes: 16, durationMs: 200, provider: 'edge-tts',
    };
  };
  return rows;
}

test('46. a long assistant_say line is cut into ordered blocks; block 0 plays first and publishes the caption', async (t) => {
  // The ordering proof is CAUSAL, not a duration estimate: block 0 must reach the player while a
  // later block is still synthesizing, so block 0's start precedes the last block's synthesis
  // finish. The first version compared the first-play delay with an estimated whole-line duration
  // (`firstPlayMs + 100 < wholeLineMs`); under load both sides slow down together, and one run
  // landed at 680ms vs 688ms, which flaked instead of proving the old "synthesize everything, then
  // play" defect would be caught. A whole-line path necessarily starts block 0 at or after its
  // last (only) synthesis finished, so it now fails this relation.
  const sayStartedAt = Date.now();
  const app = await mount(t, { chunking: true, subtitle: { holdMs: 400 } });
  const synthRows = timedSynth(app, sayStartedAt);
  const said = await app.say({ text: CHUNK_LONG });
  assert.equal(said.accepted, true);
  await waitUntil(() => state.players.length === 1, 'block 0 reached the player');
  const firstPlayMs = state.players[0].startedAt - sayStartedAt;
  const wholeLineMs = [...CHUNK_LONG].length * SYNTH_PER_CHAR_MS;
  // One caption for the line, published by block 0 (the other blocks carry no caption).
  state.players[0].onStart?.({ startedAt: Date.now() });
  await waitUntil(() => state.subtitles.length === 1, 'the caption appeared with block 0');
  assert.equal(state.subtitles[0].text, CHUNK_LONG, 'the caption is the whole line, not one block');
  // Block 1 is synthesized while block 0 still sounds, block 2 only after block 1 started.
  await waitUntil(() => synthRows.length >= 2, 'block 1 was prefetched during block 0');
  assert.equal(state.players[0].endedAt, 0, 'block 0 is still sounding, block 1 did not jump it');
  // Let block 0 end so block 1 can play and the last block is synthesized while block 1 sounds.
  state.players[0].resolve();
  await waitUntil(() => state.players.length === 2, 'block 1 reached the player');
  state.players[1].onStart?.({ startedAt: Date.now() });
  await waitUntil(() => synthRows.length >= 3, 'block 2 was synthesized during block 1');
  // Without every synthesis finish time the causal relation cannot be proven, so the test fails
  // rather than passing by default.
  assert.equal(synthRows.length, 3, 'the fixture recorded all three block syntheses');
  const lastSynth = synthRows.reduce((last, row) => (row.doneAt >= last.doneAt ? row : last));
  assert.ok(Number.isFinite(lastSynth.doneAt), 'the last block reported its synthesis finish time');
  assert.ok(
    firstPlayMs + ORDER_MARGIN_MS < lastSynth.doneAt,
    `block 0 started playing at ${firstPlayMs}ms, before the last block finished synthesizing at `
      + `${lastSynth.doneAt}ms (lead=${lastSynth.doneAt - firstPlayMs}ms)`,
  );
  // The remaining blocks play in order after the one before them ends.
  state.players[1].resolve();
  await waitUntil(() => state.players.length === 3, 'block 2 reached the player');
  state.players[2].onStart?.({ startedAt: Date.now() });
  state.players[2].resolve();
  const lastEndAt = Date.now();
  await tick(10);
  const spoken = await app.waitForEvent('speech.spoken', (payload) => payload.speechId === said.speechId);
  assert.equal(state.texts.length, 3, 'three blocks were synthesized');
  assert.deepEqual(state.texts, CHUNK_BLOCKS, 'blocks are synthesized in order');
  assert.equal(state.texts.join(''), CHUNK_LONG, 'the blocks concatenate back to the original line');
  assert.equal(state.players.length, 3, 'three blocks were played');
  assert.equal(state.subtitles.length, 1, 'the caption was published exactly once');
  assert.equal(spoken.hasSubtitle, true, 'the speech declares its caption line');
  assert.equal(spoken.subtitleShown, true, 'the overlay accepted the line');
  assert.ok(spoken.chunkMs > 0, `chunkMs=${spoken.chunkMs} is the block 0 synthesis time`);
  assert.ok(spoken.chunkMs < wholeLineMs, 'chunkMs is shorter than a whole-line synthesis');
  assert.equal(spoken.synthMs >= spoken.chunkMs, true, 'synthMs covers every block, not only the first');
  assert.ok(spoken.synthMs >= wholeLineMs - 40, `synthMs=${spoken.synthMs} sums the blocks`);
  assert.ok(spoken.queueWaitMs >= 0 && spoken.playbackMs > 0, 'queue and playback are separate clocks');
  assert.ok(
    spoken.queueWaitMs < spoken.chunkMs,
    `queueWaitMs=${spoken.queueWaitMs} excludes the block 0 synthesis (${spoken.chunkMs}ms)`,
  );
  assert.equal(spoken.translateMs, 0, 'a same-language line translated nothing');
  assert.equal(spoken.via, 'chunked');
  // The caption stays for its reading time after the LAST block (not after block 0), then hides.
  // The line has 31 reading units (punctuation excluded): 31 × 70 = 2170ms, which outranks the
  // configured 400ms and sits inside the 1200–4000 range. So `holdMs: 400` is now a no-op floor.
  await waitUntil(() => state.hideTimes.length === 1, 'the caption hid after its hold', 4000);
  const held = state.hideTimes[0] - lastEndAt;
  assert.ok(held >= 1900 && held <= 2800, `caption hold after the clip end=${held}ms (31 chars -> 2170)`);
  const holdRow = await app.waitForEvent('subtitle.hold');
  assert.equal(holdRow.ms, 2170, 'the hold is the caption reading time, not the configured 400ms');
  assert.equal(holdRow.chars, 31, 'the row counts reading units, punctuation excluded');
  assert.equal(holdRow.computed, 2170, 'the raw reading time before the configured floor');
  // The whole speech enters exactly ONE hold: no intermediate block hid the line.
  await tick(400);
  assert.equal(state.hideTimes.length, 1, 'the multi-block caption hid exactly once');
  t.diagnostic(
    `blocks=${state.texts.length} joinEqualsOriginal=${state.texts.join('') === CHUNK_LONG}`
    + ` block0FirstPlay=${firstPlayMs}ms lastSynthDone=${lastSynth.doneAt}ms lead=${lastSynth.doneAt - firstPlayMs}ms`
    + ` (wholeLineEstimate=${wholeLineMs}ms, duration accounting only)`
    + ` captions=${state.subtitles.length} hold=${held}ms chars=${holdRow.chars} hasSubtitle=${spoken.hasSubtitle}`
    + ` chunkMs=${spoken.chunkMs} synthMs=${spoken.synthMs} queueWaitMs=${spoken.queueWaitMs}`
    + ` playbackMs=${spoken.playbackMs} via=${spoken.via}`,
  );
});

test('46b. counter-proof: the same relation must be rejected when voice.chunking:false', async (t) => {
  // The same fixture and the same line as 46, with only the documented switch off. The host then
  // synthesizes the whole line as one block and hands it to the player afterwards — exactly the
  // old "synthesize everything, then play" defect. This case asserts that the whole-line order
  // really is block 0 >= last synthesis finish, so 46's causal assertion is what catches the
  // defect; no estimated duration is involved.
  const sayStartedAt = Date.now();
  const app = await mount(t, { chunking: false });
  const synthRows = timedSynth(app, sayStartedAt);
  const said = await app.say({ text: CHUNK_LONG });
  assert.equal(said.accepted, true);
  await waitUntil(() => state.players.length === 1, 'the whole line reached the player');
  assert.equal(state.texts.length, 1, 'chunking:false synthesizes the whole line as one block');
  assert.equal(state.texts[0], CHUNK_LONG, 'the one block is the whole line');
  assert.equal(synthRows.length, 1, 'one synthesis, and its finish time was recorded');
  const lastSynthDoneAt = synthRows[0].doneAt;
  const firstPlayMs = state.players[0].startedAt - sayStartedAt;
  assert.ok(Number.isFinite(lastSynthDoneAt), 'the whole-line synthesis finish time is known');
  assert.ok(
    firstPlayMs >= lastSynthDoneAt,
    `the whole-line clip starts at ${firstPlayMs}ms, not before its synthesis finished at ${lastSynthDoneAt}ms`,
  );
  assert.equal(
    firstPlayMs + ORDER_MARGIN_MS < lastSynthDoneAt,
    false,
    'the relation test 46 asserts is false on the whole-line path',
  );
  t.diagnostic(
    `chunking=false texts=${state.texts.length} players=${state.players.length}`
    + ` block0FirstPlay=${firstPlayMs}ms lastSynthDone=${lastSynthDoneAt}ms`
    + ` causalOrderHolds=${firstPlayMs + ORDER_MARGIN_MS < lastSynthDoneAt}`,
  );
});

// ---------------------------------------------------------------------------
// 47. cancel stops the sounding block and clears the unplayed ones
// ---------------------------------------------------------------------------

test('47. cancelling a chunked line stops the current block and starts no later block', async (t) => {
  const app = await mount(t, { chunking: true });
  const dir = join(app.root, 'tts');
  await mkdir(dir, { recursive: true });
  state.synth = async ({ text }) => {
    state.texts.push(text);
    const file = join(dir, `blk-${state.texts.length}.mp3`);
    await writeFile(file, `audio ${text.length}`);
    return { file, bytes: 8, durationMs: 500, provider: 'edge-tts' };
  };
  const said = await app.say({ text: CHUNK_LONG });
  assert.equal(said.accepted, true);
  await waitUntil(() => state.players.length === 1, 'block 0 reached the player');
  state.players[0].onStart?.({ startedAt: Date.now() });
  await waitUntil(() => state.texts.length >= 2, 'block 1 was prefetched during block 0');
  const cancelled = cancelSpeech(said.speechId, 'muted');
  assert.equal(cancelled.ok, true);
  const row = await app.waitForEvent('speech.cancelled', (payload) => payload.speechId === said.speechId);
  assert.equal(row.reason, 'muted');
  await tick(80);
  assert.equal(state.players.length, 1, 'no block started after the cancellation');
  const left = (await readdir(dir)).sort();
  assert.deepEqual(left, ['blk-1.mp3'], `only the sounding block's file remains (${left.join(',')})`);
  const rows = await app.events();
  const chunkCancel = rows.find((event) => event.type === 'voice.chunk' && event.payload.phase === 'cancel');
  assert.ok(chunkCancel !== undefined, 'the block driver reports the cancel');
  assert.equal(chunkCancel.payload.lane, 'say');
  assert.equal(chunkCancel.payload.speechId, said.speechId);
  t.diagnostic(
    `blocksBeforeCancel=1 prefetched=${state.texts.length} players=${state.players.length}`
    + ` files=${left.join(',')} chunkCancel=${chunkCancel.payload.phase}`,
  );
});

// ---------------------------------------------------------------------------
// 48. speech and subtitle stay two languages
// ---------------------------------------------------------------------------

test('48. a Japanese spoken line publishes the supplied Chinese caption, never the spoken text', async (t) => {
  const app = await mount(t);
  const spokenText = 'こんにちは、いい天気ですね。';
  const captionText = '你好，天气真好。';
  const said = await app.say({ text: spokenText, subtitle: captionText });
  assert.equal(said.accepted, true);
  await waitUntil(() => state.players.length === 1, 'the clip reached the player');
  state.players[0].onStart?.({ startedAt: Date.now() });
  await waitUntil(() => state.subtitles.length === 1, 'the caption was published');
  assert.equal(state.texts[0], spokenText, 'TTS receives the Japanese speech line');
  assert.equal(state.subtitles[0].text, captionText, 'the caption is the subtitle text, not the speech');
  state.players[0].resolve();
  const spoken = await app.waitForEvent('speech.spoken', (payload) => payload.speechId === said.speechId);
  assert.equal(spoken.hasSubtitle, true);
  assert.equal(spoken.subtitleShown, true);
  assert.equal(spoken.subtitleDiffers, true, 'the subtitle differs from the default caption');
  assert.equal(spoken.from, 'ja');
  assert.equal(spoken.to, 'ja', 'an already-Japanese line is spoken as Japanese');
  t.diagnostic(
    `speech="${state.texts[0]}" caption="${state.subtitles[0].text}" hasSubtitle=${spoken.hasSubtitle}`
    + ` differs=${spoken.subtitleDiffers} from=${spoken.from} to=${spoken.to}`,
  );
});

// ---------------------------------------------------------------------------
// 49. voice.latency: block-ready -> audio is its own stage
// ---------------------------------------------------------------------------

test('49. voice.latency splits "block ready -> first audio" from the total first-sentence wait', async (t) => {
  const replyText = CHUNK_LONG;
  const perCharMs = 8;
  const app = await mountVoiceRound(t, { replyText, chunking: true });
  state.synth = async ({ text }) => {
    await tick(Math.max(4, [...text].length * perCharMs));
    state.texts.push(text);
    return {
      file: join(app.root, 'tts', `r-${state.texts.length}.mp3`), bytes: 16, durationMs: 200, provider: 'edge-tts',
    };
  };
  app.say('请把这段天气念给我听');
  for (let index = 0; index < 3; index += 1) {
    await waitUntil(() => app.players().length === index + 1, `block ${index} reached the player`, 6000);
    app.players()[index].onStart?.({ startedAt: Date.now() });
    app.resolvePlayer(index);
    await tick(5);
  }
  const latency = await app.waitForEvent('voice.latency', (payload) => payload.turn === app.replyTurnId());
  const wholeLineMs = [...replyText].length * perCharMs;
  for (const field of ['firstChunkToAudioMs', 'textToFirstAudioMs']) {
    assert.equal(Number.isInteger(latency[field]), true, `${field} was measured (${JSON.stringify(latency[field])})`);
    assert.ok(latency[field] >= 0, `${field} is non-negative`);
  }
  assert.ok(
    latency.firstChunkToAudioMs < latency.firstSentenceToFirstAudioMs,
    `block-ready wait ${latency.firstChunkToAudioMs} < total first-sentence wait ${latency.firstSentenceToFirstAudioMs}`,
  );
  assert.ok(
    latency.firstChunkToAudioMs < wholeLineMs / 2,
    `block-ready wait ${latency.firstChunkToAudioMs} is far below a whole-line synthesis (${wholeLineMs}ms)`,
  );
  assert.ok(
    latency.textToFirstAudioMs >= latency.firstSentenceToFirstAudioMs,
    'the text->audio clock starts before the sentence was queued',
  );
  assert.ok(latency.firstSynthMs > 0, 'the first block synthesis is measured');
  assert.ok(
    latency.firstSentenceToFirstAudioMs - latency.firstChunkToAudioMs >= 40,
    'the block synthesis is what the total wait adds on top of the block-ready wait',
  );
  t.diagnostic(
    `firstChunkToAudioMs=${latency.firstChunkToAudioMs} firstSentenceToFirstAudioMs=${latency.firstSentenceToFirstAudioMs}`
    + ` textToFirstAudioMs=${latency.textToFirstAudioMs} firstSynthMs=${latency.firstSynthMs} wholeLine=${wholeLineMs}ms`,
  );
});

// ---------------------------------------------------------------------------
// 50. chunking off: one clip per line (the documented switch)
// ---------------------------------------------------------------------------

test('50. voice.chunking:false speaks the long line as one clip and one caption', async (t) => {
  const app = await mount(t, { chunking: false });
  state.synth = async ({ text }) => {
    await tick(40);
    state.texts.push(text);
    return { file: join(app.root, 'tts', 'whole.mp3'), bytes: 16, durationMs: 200, provider: 'edge-tts' };
  };
  const said = await app.say({ text: CHUNK_LONG });
  assert.equal(said.accepted, true);
  await waitUntil(() => state.players.length === 1, 'the single clip reached the player');
  state.players[0].onStart?.({ startedAt: Date.now() });
  await waitUntil(() => state.subtitles.length === 1, 'the caption was published');
  state.players[0].resolve();
  const spoken = await app.waitForEvent('speech.spoken', (payload) => payload.speechId === said.speechId);
  assert.equal(state.texts.length, 1, 'the whole line was synthesized once');
  assert.equal(state.texts[0], CHUNK_LONG);
  assert.equal(state.players.length, 1, 'the whole line played as one clip');
  assert.equal(state.subtitles.length, 1);
  assert.equal(state.subtitles[0].text, CHUNK_LONG);
  const chunkRows = (await app.events()).filter((event) => event.type === 'voice.chunk');
  assert.equal(chunkRows.length, 0, 'no block events when chunking is off');
  assert.ok(spoken.chunkMs > 0, 'chunkMs stays the (single) block synthesis time');
  assert.equal(spoken.hasSubtitle, true);
  t.diagnostic(
    `synthCalls=${state.texts.length} clips=${state.players.length} captions=${state.subtitles.length}`
    + ` voiceChunks=${chunkRows.length} chunkMs=${spoken.chunkMs}`,
  );
});

// ---------------------------------------------------------------------------
// 51. A refused caption is reported, not silently swallowed (bubble without a layer)
// ---------------------------------------------------------------------------

test('51. a bubble caption with no avatar geometry is reported as refused by subtitle.show', async (t) => {
  const app = await mount(t, { subtitle: { mode: 'bubble' } });
  const said = await app.say({ text: '第一句。' });
  assert.equal(said.accepted, true);
  await waitUntil(() => state.players.length === 1, 'the clip reached the player');
  state.players[0].onStart?.({ startedAt: Date.now() });
  const shown = await app.waitForEvent('subtitle.show');
  assert.equal(shown.ok, false, 'the overlay did not accept a line');
  assert.equal(shown.reason, 'geometry', 'no running layer means no bubble rectangle');
  assert.equal(shown.mode, 'bubble');
  assert.equal(state.subtitles.length, 0, 'nothing was painted');
  state.players[0].resolve();
  const spoken = await app.waitForEvent('speech.spoken', (payload) => payload.speechId === said.speechId);
  assert.equal(spoken.hasSubtitle, true, 'the speech still declares its caption line');
  assert.equal(spoken.subtitleShown, false, 'and the event says the overlay refused it');
  t.diagnostic(
    `subtitle.show ok=${shown.ok} reason=${shown.reason} mode=${shown.mode};`
    + ` hasSubtitle=${spoken.hasSubtitle} subtitleShown=${spoken.subtitleShown} painted=${state.subtitles.length}`,
  );
});

// ---------------------------------------------------------------------------
// 52. Block 0's caption is published with the finished audio, before play.start
// ---------------------------------------------------------------------------

test('52. the whole-line caption is up 0–500ms BEFORE the player starts, without waiting for onStart', async (t) => {
  const app = await mount(t);
  const line = '今天天气不错，我们出去走走吧。';
  const said = await app.say({ text: line });
  assert.equal(said.accepted, true);

  // No `onStart` has fired yet: the caption must already be on screen.
  await waitUntil(() => state.subtitles.length === 1, 'the caption is published before audio start', 3000);
  const caption = state.subtitles[0];
  assert.equal(caption.text, line, 'the caption is the whole sentence');
  assert.equal(state.players.length, 1, 'the block that owns the caption reached the player');
  assert.ok(caption.at <= state.players[0].startedAt, `caption at ${caption.at} <= player ${state.players[0].startedAt}`);

  // Simulate the player's real start latency (ffplay ~250ms): the lead is 0–500ms, not a whole
  // start-up later.
  await tick(250);
  const audioStartAt = Date.now();
  state.players[0].onStart?.({ startedAt: audioStartAt });
  const leadMs = audioStartAt - caption.at;
  assert.ok(leadMs >= 0 && leadMs <= 500, `caption lead before play.start=${leadMs}ms (want 0–500)`);

  // The onStart path refreshes nothing: one publication, one write, no second text.
  await tick(80);
  assert.equal(state.subtitles.length, 1, 'the caption is not re-published when audio starts');
  const showRows = (await app.events()).filter((event) => event.type === 'subtitle.show');
  assert.equal(showRows.length, 1, 'exactly one subtitle.show attempt');
  assert.equal(showRows[0].payload.ok, true);
  state.players[0].resolve();
  t.diagnostic(
    `caption lead=${leadMs}ms (published at ${caption.at}, play.start ${audioStartAt}), `
    + `publications=${state.subtitles.length} showRows=${showRows.length}`,
  );
});

// ---------------------------------------------------------------------------
// 53. A caption published ahead is hidden again when its block fails to start
// ---------------------------------------------------------------------------

test('53. a failed player start hides the caption published with block 0 (no wrong text)', async (t) => {
  const app = await mount(t);
  state.playError = new Error('ffplay failed to start');
  const said = await app.say({ text: '这句会播放失败。' });
  assert.equal(said.accepted, true);
  await waitUntil(() => state.hideTimes.length >= 1, 'the failed start hid the caption', 3000);
  assert.equal(state.visible, '', 'the screen is clear: the pre-published text was taken down');
  assert.ok(state.subtitles.length >= 1, 'the caption had been published before the start failed');
  await app.waitForEvent('subtitle.show'); // the attempt was recorded (it says stale after the failure)
  t.diagnostic(
    `failed start: published=${state.subtitles.length} hides=${state.hideTimes.length} visible=${JSON.stringify(state.visible)}`,
  );
});

// ---------------------------------------------------------------------------
// 54. Cancellation in the pre-start window hides the caption immediately
// ---------------------------------------------------------------------------

test('54. an interruption before the player starts hides the pre-published caption at once', async (t) => {
  const app = await mount(t);
  const said = await app.say({ text: '这句会被打断。' });
  assert.equal(said.accepted, true);
  // The caption is visible while the block waits for (and during) the player start.
  await waitUntil(() => state.subtitles.length === 1, 'the caption is up before audio start');
  assert.equal(state.visible, '这句会被打断。');
  assert.equal(state.players[0].endedAt, 0, 'the player has not started/ended');
  const cancelledAt = Date.now();
  assert.equal(cancelSpeech(said.speechId, 'muted').ok, true);
  await waitUntil(() => state.hideTimes.length === 1, 'the cancel hid the caption', 1000);
  const latency = state.hideTimes[0] - cancelledAt;
  assert.ok(latency < 500, `interrupt hide latency=${latency}ms (did not wait out anything)`);
  assert.equal(state.visible, '', 'no text is left behind');
  assert.equal(state.hideTimes.length, 1, 'exactly one hide');
  t.diagnostic(`pre-start cancel: hide after ${latency}ms visible=${JSON.stringify(state.visible)}`);
});

// ---------------------------------------------------------------------------
// 55. The caption lives for the whole speech: a block gap longer than the hold keeps it up
// ---------------------------------------------------------------------------

test('55. a 1.5s block gap never hides the caption; only the last block enters the one hold', async (t) => {
  // Two comma-level blocks (9 + 8 readable chars -> 1190ms, clamped to the 1200ms floor). The
  // configured 100ms is below that floor; the gap is pushed past the hold to prove no intermediate
  // block armed one. A per-block hold would have hidden the line before block 1 could arrive.
  const GAP_LINE = '今天天气真的很不错，我们出去散散步吧。';
  const app = await mount(t, { chunking: true, subtitle: { holdMs: 100 } });
  state.synth = async ({ text }) => {
    if (text.startsWith('我们出去')) await tick(1800);
    state.texts.push(text);
    return {
      file: join(app.root, 'tts', `gap-${state.texts.length}.mp3`), bytes: 16, durationMs: 200, provider: 'edge-tts',
    };
  };
  const said = await app.say({ text: GAP_LINE });
  assert.equal(said.accepted, true);
  await waitUntil(() => state.players.length === 1, 'block 0 reached the player');
  await waitUntil(() => state.subtitles.length === 1, 'the caption is up with block 0');
  assert.equal(state.visible, GAP_LINE);
  state.players[0].onStart?.({ startedAt: Date.now() });
  const blockZeroEnd = Date.now();
  state.players[0].resolve();

  // 200ms into the gap (the requested case): still visible.
  await tick(200);
  assert.equal(state.hideTimes.length, 0, 'no hide 200ms into the block gap');
  assert.equal(state.visible, GAP_LINE);

  // Block 1 is still 1.8s away: the old per-block hold would have hidden the line at 1260ms.
  await waitUntil(() => state.players.length === 2, 'block 1 finally reached the player', 5000);
  const gapMs = Date.now() - blockZeroEnd;
  assert.ok(gapMs >= 1300, `the gap ${gapMs}ms exceeds the 1200ms reading hold`);
  assert.equal(state.hideTimes.length, 0, 'the caption survived the whole block gap');
  assert.equal(state.visible, GAP_LINE, 'the same whole-sentence line is still on screen');

  state.players[1].onStart?.({ startedAt: Date.now() });
  state.players[1].resolve();
  await waitUntil(() => state.hideTimes.length === 1, 'the last block hid the caption after its hold', 5000);
  assert.equal(state.hideTimes.length, 1, 'exactly one hold/hide for the whole speech');
  assert.equal(state.subtitles.length, 1, 'the caption was published once');
  const holdRow = await app.waitForEvent('subtitle.hold');
  assert.equal(holdRow.ms, 1200, 'the last block holds the 17-unit line at the 1200ms floor');
  t.diagnostic(
    `gap=${gapMs}ms > hold=${holdRow.ms}ms: visibleThroughGap=yes `
    + `hides=${state.hideTimes.length} publications=${state.subtitles.length} blocks=${state.texts.length}`,
  );
});

// ---------------------------------------------------------------------------
// 56. Cancelling while block 0 waits for the playback seat deletes its file
// ---------------------------------------------------------------------------

test('56. a queued-then-cancelled line deletes its synthesized block 0 file', async (t) => {
  const app = await mount(t, { chunking: true });
  const dir = join(app.root, 'tts');
  await mkdir(dir, { recursive: true });
  const written = [];
  state.synth = async ({ text }) => {
    const file = join(dir, `queued-${written.length}.mp3`);
    await writeFile(file, 'audio');
    written.push({ text, file });
    return { file, bytes: 5, durationMs: 200, provider: 'edge-tts' };
  };
  // A first line holds the single playback seat.
  const first = await app.say({ text: '第一句先占着播放席位。' });
  assert.equal(first.accepted, true);
  await waitUntil(() => state.players.length === 1, 'the first line reached the player');
  // The second line synthesizes block 0, then waits for the seat.
  const second = await app.say({ text: CHUNK_LONG });
  assert.equal(second.accepted, true);
  await waitUntil(() => written.length === 2, 'block 0 of the queued line was synthesized', 3000);
  const blockZero = written[1];
  assert.equal(blockZero.text, CHUNK_BLOCKS[0], 'the queued file is the second line\'s block 0');
  assert.equal(await fileExists(blockZero.file), true, 'the file exists while the line is queued');
  assert.equal(state.players.length, 1, 'the queued line did not reach the player');

  assert.equal(cancelSpeech(second.speechId, 'muted').ok, true);
  const started = Date.now();
  await waitUntil(() => fileExists(blockZero.file).then((exists) => exists === false), 'the queued file was deleted', 3000);
  const removedMs = Date.now() - started;
  state.players[0].resolve();
  await tick(30);
  assert.equal(await fileExists(blockZero.file), false, 'the cancelled block 0 file is gone');
  t.diagnostic(
    `queued block0=${blockZero.file.split(/[\\/]/).pop()} removedAfter=${removedMs}ms `
    + `players=${state.players.length} cancelled=${second.speechId > 0}`,
  );
});

// ---------------------------------------------------------------------------
// 57. Block-boundary hand-over: a progress cue gives the seat to a waiting answer
// ---------------------------------------------------------------------------

/** 22 characters, three blocks with the default 8-character minimum. */
const PROGRESS_BLOCKS = ['我先查一下设置吧，', '然后看看日志吧，', '最后稍等。'];
const PROGRESS_BLOCKS_TEXT = PROGRESS_BLOCKS.join('');
const HANDOFF_ANSWER = '这是最终答复。';

/** Player objects are recorded in playback order; this maps each back to the block it carries. */
const trackedSynth = (app) => {
  const fileText = new Map();
  const order = [];
  state.synth = async ({ text }) => {
    order.push(text);
    const file = join(app.root, 'tts', `seat-${order.length}.mp3`);
    fileText.set(file, text);
    return { file, bytes: 16, durationMs: 200, provider: 'edge-tts' };
  };
  return { fileText, order };
};

test('57. a progress speech hands the seat to a waiting answer at a block boundary', async (t) => {
  const app = await mount(t, { chunking: true });
  const { fileText, order } = trackedSynth(app);
  const progress = await app.say({ text: PROGRESS_BLOCKS_TEXT, purpose: 'progress' });
  assert.equal(progress.accepted, true);
  await waitUntil(() => state.players.length === 1, 'progress block 0 reached the player');
  // The answer request arrives while block 0 still sounds: it synthesizes and then waits.
  const answer = await app.say({ text: HANDOFF_ANSWER, purpose: 'answer' });
  assert.equal(answer.accepted, true);
  await waitUntil(() => order.includes(HANDOFF_ANSWER), 'the answer audio is ready', 3000);
  await tick(20); // let the answer reach the playback-turn queue before the boundary
  assert.equal(state.players.length, 1, 'the sounding progress block was not cut');
  assert.equal(state.players[0].cancelled, false, 'no mid-block interruption');
  state.players[0].onStart?.({ startedAt: Date.now() });
  state.players[0].resolve();
  // At the block boundary the turn moves: the answer starts before progress block 1.
  await waitUntil(() => state.players.length === 2, 'the answer took the seat after block 0', 3000);
  assert.equal(fileText.get(state.players[1].file), HANDOFF_ANSWER, 'the answer is the next clip');
  const handoff = await app.waitForEvent(
    'speech.seat.handoff',
    (payload) => payload.fromSpeechId === progress.speechId,
  );
  assert.equal(handoff.toSpeechId, answer.speechId);
  assert.equal(handoff.atChunkBoundary, true);
  assert.equal(handoff.remainingChunks, 2, 'the two unplayed progress blocks stay queued');
  // The answer finishes, then the two remaining progress blocks resume in their original order.
  state.players[1].onStart?.({ startedAt: Date.now() });
  state.players[1].resolve();
  await waitUntil(() => state.players.length === 3, 'progress block 1 resumed after the answer', 3000);
  assert.equal(fileText.get(state.players[2].file), PROGRESS_BLOCKS[1]);
  state.players[2].onStart?.({ startedAt: Date.now() });
  state.players[2].resolve();
  await waitUntil(() => state.players.length === 4, 'progress block 2 resumed', 3000);
  assert.equal(fileText.get(state.players[3].file), PROGRESS_BLOCKS[2]);
  state.players[3].onStart?.({ startedAt: Date.now() });
  state.players[3].resolve();
  await app.waitForEvent('speech.finish', (payload) => payload.speechId === answer.speechId, 5000);
  await app.waitForEvent('speech.finish', (payload) => payload.speechId === progress.speechId, 5000);
  const played = state.players.map((player) => fileText.get(player.file));
  assert.deepEqual(
    played,
    [PROGRESS_BLOCKS[0], HANDOFF_ANSWER, PROGRESS_BLOCKS[1], PROGRESS_BLOCKS[2]],
    'the answer plays first, then the remaining progress blocks in order',
  );
  assert.ok(
    state.players[1].startedAt >= state.players[0].endedAt,
    'the answer started only after the progress block really ended',
  );
  const rows = await app.events();
  assert.equal(
    rows.filter((event) => event.type === 'speech.seat.handoff').length,
    1,
    'exactly one hand-over was reported',
  );
  t.diagnostic(`play order=${played.join(' | ')} handoffs=1 remaining=2; no block cut`);
});

// ---------------------------------------------------------------------------
// 58. No waiting request: the blocks keep playing, no hand-over event
// ---------------------------------------------------------------------------

test('58. with no higher-priority waiter the blocks play continuously and no hand-over happens', async (t) => {
  const app = await mount(t, { chunking: true });
  const { fileText } = trackedSynth(app);
  const said = await app.say({ text: PROGRESS_BLOCKS_TEXT, purpose: 'progress' });
  assert.equal(said.accepted, true);
  await waitUntil(() => state.players.length === 1, 'progress block 0 reached the player');
  state.players[0].onStart?.({ startedAt: Date.now() });
  state.players[0].resolve();
  await waitUntil(() => state.players.length === 2, 'block 1 started right after block 0', 2000);
  assert.equal(fileText.get(state.players[1].file), PROGRESS_BLOCKS[1]);
  const gapMs = state.players[1].startedAt - state.players[0].endedAt;
  assert.ok(gapMs < 400, `block 1 started ${gapMs}ms after block 0 ended (continuous playback)`);
  state.players[1].resolve();
  await waitUntil(() => state.players.length === 3, 'block 2 started right after block 1', 2000);
  assert.equal(fileText.get(state.players[2].file), PROGRESS_BLOCKS[2]);
  state.players[2].resolve();
  await app.waitForEvent('speech.finish', (payload) => payload.speechId === said.speechId, 5000);
  const rows = await app.events();
  assert.equal(
    rows.filter((event) => event.type === 'speech.seat.handoff').length,
    0,
    'nothing handed the seat over, so no hand-over event',
  );
  assert.deepEqual(
    state.players.map((player) => fileText.get(player.file)),
    PROGRESS_BLOCKS,
    'all three blocks played continuously in order',
  );
  t.diagnostic(`continuous order=${PROGRESS_BLOCKS.join(' | ')} gap=${gapMs}ms handoffs=0`);
});

// ---------------------------------------------------------------------------
// 59. Cross-turn requests never hand over; the existing preemption rule still owns them
// ---------------------------------------------------------------------------

test('59. a higher-priority request from another turn never takes a block boundary', async (t) => {
  const events = [];
  const ledger = createSpeechLedger({
    emit: async (type, payload) => { events.push({ type, payload }); },
  });
  const hold = () => new Promise(() => {});
  const progress = ledger.accept({
    sessionId: 'handoff-session', turn: 1, text: '进度语音。', priority: 2,
    run: async () => { await hold(); },
  });
  await ledger.waitPlaybackTurn(progress.speechId);
  const answer = ledger.accept({
    sessionId: 'handoff-session', turn: 2, text: '答复语音。', priority: 3,
    run: async () => { await hold(); },
  });
  await tick(10);
  let granted = false;
  ledger.waitPlaybackTurn(answer.speechId, { timeoutMs: 10_000 }).then(() => { granted = true; }, () => {});
  await tick(10);
  const handoff = ledger.handoffAtBlockBoundary(progress.speechId, { remainingChunks: 2 });
  assert.equal(handoff, null, 'a different turn keeps the existing preemption rule, not a hand-over');
  assert.equal(granted, false, 'the other turn stays queued behind the old one');
  assert.equal(events.filter((event) => event.type === 'speech.seat.handoff').length, 0);
  ledger.cancel(progress.speechId, 'explicit');
  ledger.cancel(answer.speechId, 'explicit');
  await tick(20);
  t.diagnostic('cross-turn: handoff=0, other-turn waiter still queued');
});

// ---------------------------------------------------------------------------
// 60. A multi-block preemptor is never split by the yielded speech
// ---------------------------------------------------------------------------

test('60. the answer\'s next block outranks the yielded speech, so the answer stays whole', async (t) => {
  const ledger = createSpeechLedger({ emit: async () => {} });
  const held = new Map();
  const hold = ({ speechId }) => new Promise((resolve) => held.set(speechId, resolve));
  const granted = [];
  const progress = ledger.accept({
    sessionId: 'multi', turn: 1, text: '进度语音。', priority: 2, run: hold,
  });
  await ledger.waitPlaybackTurn(progress.speechId).then(() => granted.push('progress'));
  // The final answer arrives in blocks; its first block is waiting when the boundary is reached.
  const answer1 = ledger.accept({
    sessionId: 'multi', turn: 1, text: '答复第一块。', priority: 3, run: hold,
  });
  const turn1 = ledger.waitPlaybackTurn(answer1.speechId).then(() => granted.push('answer-1'));
  await tick(10);
  assert.equal(
    ledger.handoffAtBlockBoundary(progress.speechId, { remainingChunks: 2 })?.toSpeechId,
    answer1.speechId,
  );
  await turn1;
  // The yielded speech asks for its next block; it must stay queued behind the answer.
  let resumed = false;
  const resume = ledger.waitPlaybackTurn(progress.speechId, { timeoutMs: 5000, reportOnly: true })
    .then(() => { resumed = true; granted.push('progress'); });
  const untilFinished = async (speechId) => {
    for (let index = 0; index < 50; index += 1) {
      if (ledger.statusOf(speechId)?.status === 'finished') return;
      await Promise.resolve();
    }
    throw new Error(`speech ${speechId} did not finish`);
  };
  // Block 1 settles, then the answer's block 2 becomes a new record in the same turn.
  held.get(answer1.speechId)?.();
  await untilFinished(answer1.speechId);
  const answer2 = ledger.accept({
    sessionId: 'multi', turn: 1, text: '答复第二块。', priority: 3, run: hold,
  });
  const turn2 = ledger.waitPlaybackTurn(answer2.speechId).then(() => granted.push('answer-2'));
  await tick(10);
  assert.equal(resumed, false, 'the progress speech did not slip between the answer blocks');
  held.get(answer2.speechId)?.();
  await turn2;
  await resume;
  assert.deepEqual(
    granted,
    ['progress', 'answer-1', 'answer-2', 'progress'],
    'the answer blocks stay contiguous; the remaining progress blocks resume after them',
  );
  held.get(progress.speechId)?.();
  await tick(10);
  t.diagnostic(`grants=${granted.join(' -> ')}; the multi-block answer was not split`);
});

// ---------------------------------------------------------------------------
// 61. The real reply lane keeps a multi-block answer whole across the hand-over
// ---------------------------------------------------------------------------

test('61. a multi-block reply answer stays contiguous after taking a progress boundary', async (t) => {
  const REPLY_TEXT = '这是回复的第一块内容，这是回复的第二块内容。';
  const REPLY_BLOCKS = ['这是回复的第一块内容，', '这是回复的第二块内容。'];
  const gate = deferred();
  const app = await mountVoiceRound(t, { replyText: REPLY_TEXT, chunking: true, beforeReply: gate });
  const fileText = new Map();
  const synthOrder = [];
  state.synth = async ({ text }) => {
    synthOrder.push(text);
    const file = join(app.root, 'tts', `lane-${synthOrder.length}.mp3`);
    fileText.set(file, text);
    return { file, bytes: 16, durationMs: 200, provider: 'edge-tts' };
  };
  app.say('开始');
  await waitUntil(() => app.replyTurnId() !== null, 'the reply turn started');
  const progress = await app.toolSay({ text: PROGRESS_BLOCKS_TEXT, purpose: 'progress' });
  assert.equal(progress.accepted, true);
  await waitUntil(() => app.players().length === 1, 'progress block 0 reached the player', 6000);
  gate.resolve();
  await waitUntil(() => synthOrder.includes(REPLY_BLOCKS[0]), 'the reply first block was synthesized', 8000);
  await tick(30); // let the reply block reach the playback-turn queue
  assert.equal(app.players().length, 1, 'the reply did not cut the sounding progress block');
  app.players()[0].onStart?.({ startedAt: Date.now() });
  app.resolvePlayer(0);
  // The boundary hands the turn to the reply's first block, before progress block 1.
  await waitUntil(() => app.players().length === 2, 'the reply first block started at the boundary', 8000);
  assert.equal(fileText.get(app.players()[1].file), REPLY_BLOCKS[0]);
  app.resolvePlayer(1);
  // The reply's second block is a new record in the same turn and must run before progress resumes.
  await waitUntil(() => app.players().length === 3, 'the reply second block followed its first', 8000);
  assert.equal(fileText.get(app.players()[2].file), REPLY_BLOCKS[1]);
  app.resolvePlayer(2);
  await waitUntil(() => app.players().length === 4, 'progress block 1 resumed after the answer', 8000);
  assert.equal(fileText.get(app.players()[3].file), PROGRESS_BLOCKS[1]);
  app.resolvePlayer(3);
  await waitUntil(() => app.players().length === 5, 'progress block 2 resumed', 8000);
  assert.equal(fileText.get(app.players()[4].file), PROGRESS_BLOCKS[2]);
  app.resolvePlayer(4);
  const played = app.players().map((player) => fileText.get(player.file));
  assert.deepEqual(
    played,
    [PROGRESS_BLOCKS[0], REPLY_BLOCKS[0], REPLY_BLOCKS[1], PROGRESS_BLOCKS[1], PROGRESS_BLOCKS[2]],
    'the reply answer stayed whole; the remaining progress blocks followed it',
  );
  const handoff = await app.waitForEvent(
    'speech.seat.handoff',
    (payload) => payload.fromSpeechId === progress.speechId,
  );
  assert.equal(handoff.remainingChunks, 2);
  assert.equal(
    (await app.events()).filter((event) => event.type === 'speech.seat.handoff').length,
    1,
    'exactly one hand-over was reported',
  );
  t.diagnostic(`reply-lane order=${played.join(' | ')}; multi-block answer kept contiguous`);
});

// ---------------------------------------------------------------------------
// 62. Machinery turns never pause the voice: tool step / continuation (voice round)
// ---------------------------------------------------------------------------

test('62. a tool turn/start never pauses the sounding reply (voice.speech.keep)', async (t) => {
  const app = await mountVoiceRound(t, { replyText: '第一句。第二句。' });
  await startSoundingReply(app, '第一句。');
  const session = app.session();
  assert.ok(session !== null, 'the reply session is live');
  const continuationTurn = app.replyTurnId() + 1;
  // The agent keeps working after a tool result: a new turn begins in the SAME session.
  app.emit(startEvent(continuationTurn), session);
  app.emit({
    type: 'tool/call',
    data: { turn: continuationTurn, step: 1, callId: 'c-2', name: 'pwsh', arguments: '{}' },
  }, session);
  await tick(150);
  const rows = await app.events();
  assert.equal(
    rows.filter((event) => event.type === 'speech.cancelled').length,
    0,
    'an internal turn emits no speech.cancelled',
  );
  const keep = rows.find((event) => event.type === 'voice.speech.keep');
  assert.equal(keep?.payload?.reason, 'internal-turn', 'the keep row says why the clip survived');
  assert.equal(keep?.payload?.turn, continuationTurn);
  assert.equal(app.players().length, 1, 'the first sentence is still the only sounding clip');
  t.diagnostic(`turn${continuationTurn} tool/start: cancelled=0 keeps=${rows.filter((e) => e.type === 'voice.speech.keep').length} players=${app.players().length}`);
});

// ---------------------------------------------------------------------------
// 63. An agent continuation after a tool result keeps the answer sounding
// ---------------------------------------------------------------------------

test('63. a turn/start after a tool result never pauses the accepted reply', async (t) => {
  const app = await mountVoiceRound(t, { replyText: '第一句。第二句。' });
  await startSoundingReply(app, '第一句。');
  const session = app.session();
  const replyTurn = app.replyTurnId();
  // Turn N called a tool; the result lands and the loop opens turn N+1 to continue the answer.
  app.emit({
    type: 'tool/result',
    data: { turn: replyTurn, step: 1, callId: 'c-1', result: { ok: true } },
  }, session);
  app.emit(startEvent(replyTurn + 1), session);
  await tick(180);
  const rows = await app.events();
  assert.equal(
    rows.filter((event) => event.type === 'speech.cancelled').length,
    0,
    'the continuation turn is not a user interruption',
  );
  assert.equal(app.players().length, 1, 'the sentence kept playing');
  t.diagnostic(`tool result(turn ${replyTurn}) -> turn${replyTurn + 1}: cancelled=0 players=${app.players().length}`);
});

// ---------------------------------------------------------------------------
// 64. A delegated child's events never touch the companion's voice
// ---------------------------------------------------------------------------

test('64. a subagent session never cancels the companion speech', async (t) => {
  const app = await mountVoiceRound(t, { replyText: '第一句。第二句。' });
  await startSoundingReply(app, '第一句。');
  const subagent = {
    id: 'voice-lanes-subagent',
    header: { cwd: join(app.root, 'workspace'), origin: 'subagent', delegationDepth: 1 },
  };
  for (const event of [
    startEvent(5),
    userEvent(5, 'u-subagent', '子代理自己的输入'),
    assistantEvent(5, '子代理自己的回复'),
    endEvent(5),
  ]) {
    app.emit(event, subagent);
  }
  await tick(200);
  const rows = await app.events();
  assert.equal(
    rows.filter((event) => event.type === 'speech.cancelled').length,
    0,
    'a delegated session is out of the companion voice lane',
  );
  assert.equal(app.players().length, 1, 'the companion keeps sounding');
  t.diagnostic(`subagent events: cancelled=0 players=${app.players().length}`);
});

// ---------------------------------------------------------------------------
// 65. The accepted voice input IS the one interruption
// ---------------------------------------------------------------------------

test('65. an accepted voice delivery cancels the current reply (reason voice)', async (t) => {
  const app = await mountVoiceRound(t, { replyText: '第一句。' });
  await startSoundingReply(app, '第一句。');
  const replyTurn = app.replyTurnId();
  // The microphone final passes the barge-in gate and the delivery is accepted.
  app.say('我想换一个问题');
  const cancelled = await app.waitForEvent('speech.cancelled', (payload) => payload.turn === replyTurn);
  assert.equal(cancelled.reason, 'voice', 'the event names the user-input source');
  t.diagnostic(`voice input accepted: cancelled=${cancelled.reason} turn=${cancelled.turn}`);
});

// ---------------------------------------------------------------------------
// 66. Typed input cancels; the new turn keeps its own speech signal
// ---------------------------------------------------------------------------

test('66. a typed message cancels the old reply and the next typed turn still speaks', async (t) => {
  const app = await mount(t);
  app.emit(app.session, startEvent(1));
  app.emit(app.session, userEvent(1, 'u-1', '说三句'));
  app.emit(app.session, assistantEvent(1, '第一句。第二句。'));
  app.emit(app.session, endEvent(1));
  await waitUntil(() => app.players().length === 1, 'the typed reply started sounding');
  // A bare turn/start is machinery too: only the typed message is the user's input.
  app.emit(app.session, startEvent(2));
  await tick(150);
  assert.equal(
    (await app.events()).filter((event) => event.type === 'speech.cancelled').length,
    0,
    'turn/start alone cancels nothing',
  );
  app.emit(app.session, userEvent(2, 'u-2', '换一句'));
  const cancelled = await app.waitForEvent('speech.cancelled');
  assert.equal(cancelled.reason, 'user-input');
  // The cancellation must not abort the new turn's captured signal: its answer still speaks.
  app.emit(app.session, assistantEvent(2, '新回复。'));
  app.emit(app.session, endEvent(2));
  await waitUntil(() => app.players().length === 2, 'the next typed turn still reached the player');
  t.diagnostic(`typed input: cancelled=${cancelled.reason}; players after next turn=${app.players().length}`);
});

// ---------------------------------------------------------------------------
// 67. Typed input cancels a synthesis still in flight, not only the current clip
//
// The old round ended and its typed reply is accepted, but TTS is still blocked when the next
// question arrives. Releasing that synthesis afterwards must not start the old audio: the round is
// stale by generation and the new round still gets its own clip.
// ---------------------------------------------------------------------------

test('67. a typed message drops a typed reply whose synthesis is still running', async (t) => {
  const app = await mount(t);
  const entered = deferred();
  const gate = deferred();
  const baseSynth = state.synth;
  state.synth = async (options) => {
    if (options.text === '旧合成正文。') {
      entered.resolve();
      await gate.promise;
    }
    return baseSynth(options);
  };
  app.emit(app.session, startEvent(1));
  app.emit(app.session, userEvent(1, 'u-1', '旧问题'));
  app.emit(app.session, assistantEvent(1, '旧合成正文。'));
  app.emit(app.session, endEvent(1));
  await entered.promise;

  app.emit(app.session, startEvent(2));
  app.emit(app.session, userEvent(2, 'u-2', '新问题'));
  // Release the old synthesis only after the user's input already retired the round.
  gate.resolve();
  const stale = await app.waitForEvent('voice.typed.stale-dropped', (payload) => payload.turn === 1);
  assert.equal(stale.reason, 'user-input');
  const cancelled = await app.waitForEvent('voice.speech.cancelled', (payload) => payload.turn === 1);
  assert.equal(cancelled.reason, 'user-input');
  assert.equal(cancelled.scope, 'typed');
  await tick(50);
  assert.equal(app.players().length, 0, 'the released old synthesis never started a clip');

  // The new turn is untouched by the cancellation and still speaks.
  app.emit(app.session, assistantEvent(2, '新合成正文。'));
  app.emit(app.session, endEvent(2));
  await waitUntil(() => app.players().length === 1, 'the new turn reached the player');
  app.players()[0].resolve();
  const spoken = await app.waitForEvent('voice.typed.spoken', (payload) => payload.turn === 2);
  const rows = await app.events();
  assert.equal(
    rows.filter((event) => event.type === 'voice.typed.spoken' && event.payload.turn === 1).length,
    0,
    'the old round never became a spoken round',
  );
  t.diagnostic(
    `turn1 stale=${stale.reason} cancelled=${cancelled.reason}/${cancelled.scope} players=0; `
    + `turn2 spoken=${spoken.sentences} players=${app.players().length}`,
  );
});

// ---------------------------------------------------------------------------
// 68. An accepted voice delivery retires the same typed generation
//
// The typed lane outlives the accepted-speech ledger: a voice delivery must also cancel a typed
// reply still synthesizing in an older turn, and the released result must never start a clip.
// ---------------------------------------------------------------------------

test('68. an accepted voice delivery also drops a typed reply still synthesizing', async (t) => {
  const app = await mountVoiceRound(t, { replyText: '语音新回复。' });
  useReplySynth(app.root);
  const entered = deferred();
  const gate = deferred();
  const baseSynth = state.synth;
  state.synth = async (options) => {
    if (options.text === '旧合成正文。') {
      entered.resolve();
      await gate.promise;
      return {
        file: join(app.root, 'tts', 'old-typed.mp3'), bytes: 16, durationMs: 200, provider: 'edge-tts',
      };
    }
    return baseSynth(options);
  };
  const typedSession = { id: 'voice-lanes-typed', header: { cwd: join(app.root, 'workspace') } };
  app.emit(startEvent(1), typedSession);
  app.emit(userEvent(1, 'u-1', '旧问题'), typedSession);
  app.emit(assistantEvent(1, '旧合成正文。'), typedSession);
  app.emit(endEvent(1), typedSession);
  await entered.promise;

  app.say('新问题');
  // Wait for the accepted delivery to retire the typed generation BEFORE releasing its synthesis:
  // that is exactly the ordering the regression is about.
  const cancelled = await app.waitForEvent('voice.speech.cancelled', (payload) => payload.turn === 1);
  assert.equal(cancelled.reason, 'user-input');
  assert.equal(cancelled.scope, 'typed');
  gate.resolve();
  const stale = await app.waitForEvent('voice.typed.stale-dropped', (payload) => payload.turn === 1);
  assert.equal(stale.reason, 'user-input');
  await waitUntil(
    () => app.players().every((player) => !player.file.endsWith('old-typed.mp3')),
    'the old typed synthesis never started a clip',
  );
  await waitUntil(() => app.players().length >= 1, 'the accepted voice reply still speaks');
  t.diagnostic(
    `typed turn1 stale=${stale.reason} cancelled=${cancelled.reason}/${cancelled.scope}; `
    + `old-typed players=0; voice reply players=${app.players().length}`,
  );
});
