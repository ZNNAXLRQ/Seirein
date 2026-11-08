/**
 * P2: the streamed spoken version must not close the response group while the model is still
 * producing units.
 *
 * The response group used to decide "done" from the completed playback alone. With a slow spoken
 * rewrite that meant the FIRST unit finishing was enough: the group closed, and every later unit
 * (the tail the model had not produced yet) was refused as `skipped-stale`. The accepted rule is
 * BOTH conditions:
 *
 *   - the plan is sealed (the spoken organization produced its end marker), and
 *   - every real unit fed to the speaker completed.
 *
 * The host is mounted for real (`apply` + `assistant_listen` + the real voice round). Only the
 * microphone, the agent loop, TTS, the player and the provider stream are deterministic fakes.
 *
 * Covered:
 *   1. slow stream: the first unit plays, the tail is produced 500 ms later -> no early done, the
 *      tail finally plays
 *   2. fast stream: every unit arrives before playback -> done timing is unchanged (regression)
 *   3. after the plan is sealed, late units beyond the drain limit are explicitly dropped
 *   4. the first unit plays but the model has not ended after 2 s -> the group is not done
 *
 * Run: node --test test/streaming-end-slow-model.mjs
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { registerHooks } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupRoot, disposeAll } from './helpers/cleanup.mjs';
import { createResponseGroupStore } from '../src/host/session/conversation/responseGroup.js';

const state = {
  synth: null,
  players: [],
  subtitles: [],
  texts: [],
  onUpdate: null,
  hearingStats: { rmsDb: -20 },
  replyFor: null,
  holdTurns: new Map(),
  failTurns: new Set(),
  preStepMessages: new Map(),
  turnIds: [],
  /** One per test: returns the async stream the spoken rewrite should consume. */
  spokenStream: null,
  spokenCalls: 0,
  llmCalls: 0,
};
globalThis.__streamingEndSlowModel = state;

const ttsUrl = new URL('../src/host/speech/tts.js', import.meta.url).href;
const sightUrl = new URL('../src/host/vision/sight.js', import.meta.url).href;
const subtitleUrl = new URL('../src/host/subtitle/subtitle.js', import.meta.url).href;
const speechTextUrl = new URL('../src/host/speech/speech-text.js', import.meta.url).href;
const hearingUrl = new URL('../src/host/hearing/hearing.js', import.meta.url).href;
const hooks = registerHooks({
  load(url, context, next) {
    if (url === hearingUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
    const s = globalThis.__streamingEndSlowModel;
    export const modelReady = () => true;
    export const finalModelReady = () => false;
    export const isLoopbackDevice = (name) => /CABLE|Stereo Mix|Virtual/i.test(String(name));
    export const listDevices = async () => ['Fake Mic'];
    export const startHearing = (options) => {
      s.onUpdate = options.onUpdate;
      return { device: options.device, stop() {}, stats: () => s.hearingStats };
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
      return {
        format: 'module',
        shortCircuit: true,
        source: `
    import * as real from '${speechTextUrl}?streaming-end-real';
    export const parse = (...args) => real.parse(...args);
    export const toSpeechText = (...args) => real.toSpeechText(...args);
    export const toCaptionText = (...args) => real.toCaptionText(...args);
    export const looksUnbalanced = (...args) => real.looksUnbalanced(...args);
    export const takeResiduals = (...args) => real.takeResiduals(...args);
    export const DEFAULT_SPEECH_MAX_CHARS = real.DEFAULT_SPEECH_MAX_CHARS;
    export const SPEECH_TRUNCATION_NOTE = real.SPEECH_TRUNCATION_NOTE;
    export const resolveSpeechBudget = (...args) => real.resolveSpeechBudget(...args);
    export const formatMessage = (...args) => real.formatMessage(...args);`,
      };
    }
    if (url === ttsUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
    const s = globalThis.__streamingEndSlowModel;
    export { resolveGptLangs, resolveGptSovitsTimeout } from '${ttsUrl}?streaming-end-helpers';
    export { speakChunks, speechChunkTexts } from '${ttsUrl}?streaming-end-chunk';
    export const configureTts = () => {};
    export const gptSovitsReferenceStatus = async () => ({ seconds: null, ok: false, readable: false });
    export const warmupGptSovits = async () => ({ ok: false, skipped: 'disabled' });
    export const applyGptSovitsModels = () => ({ ok: true });
    export const synthesize = (options) => s.synth(options);
    export const speakStreaming = async () => { throw new Error('streaming not expected'); };
    export const stopPlayback = () => true;
    export const stopTts = () => true;
    export const play = (file, options) => {
      let resolve;
      const done = new Promise((doneResolve) => { resolve = doneResolve; });
      const player = {
        file,
        ...options,
        startedAt: Date.now(),
        endedAt: 0,
        cancelled: false,
        resolve: () => { if (player.endedAt === 0) player.endedAt = Date.now(); resolve(); },
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
    export function readObservation(o, { now = Date.now(), ttlMs = 30000 } = {}) { return { ...(o ?? {}), stale: true, hint: 'stale' }; }`,
      };
    }
    if (url === subtitleUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
    export const averageColor = async () => null;
    export { SubtitleHold } from '${subtitleUrl}?streaming-end-real';
    export class SubtitleOverlay {
      constructor({ config }) { this.config = config; }
      async show(text) { globalThis.__streamingEndSlowModel.subtitles.push({ text, at: Date.now() }); return true; }
      async hide() {}
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
// Import `reply-speaker` through the host entry too, AFTER the hooks: importing it directly would
// pull the real `tts.js` (via chunk-capabilities) before the stub can replace it.
const { apply, voiceSessionTarget, createReplySpeaker } = await import('../src/host/index.js');
hooks.deregister();
after(() => { delete globalThis.__streamingEndSlowModel; });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

const waitUntil = async (check, message, timeoutMs = 8000) => {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out: ${message}`);
    await tick(5);
  }
};

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

const messageText = (message) => {
  const blocks = Array.isArray(message?.content) ? message.content : [];
  return blocks.filter((block) => block?.type === 'text').map((block) => block.text).join('');
};

/** One reply whose body is a SINGLE long sentence: only the sealed unit count can distinguish it. */
const LONG_BODY = '这是一段需要完整播放的长回答，第一次播放结束并不代表口语组织已经结束，'
  + '因为后面的内容仍然会在模型里继续生成，而且必须等到最后的单元也播放完成之后才可以宣布整个回应结束。';

/** The rewrite's first stable unit. */
const UNIT_ONE = '第一单元已经完整播放。';
/** The tail the slow model only produces after the first unit already finished. */
const UNIT_TWO = '第二单元现在才产出。';

const SPOKEN_SYSTEM_MARK = '只输出一段可直接朗读的口语版';

/**
 * The real voice round with a fake agent and a fake provider. The agent answers with `LONG_BODY`;
 * the spoken rewrite's provider stream is the per-test `state.spokenStream` generator, so a test
 * decides exactly when each unit exists.
 */
async function mountVoiceRound(t, {
  chunking = true, reply = LONG_BODY, holdTurns = new Map(), failTurns = new Set(),
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-streaming-end-'));
  await mkdir(join(root, 'data'), { recursive: true });
  await mkdir(join(root, 'workspace'), { recursive: true });
  await writeFile(join(root, 'data', 'features.json'), JSON.stringify({
    hearing: true, ambient: false, voice: true, vision: false, subtitle: false, avatar: false,
    memory: false, fastpath: false,
  }));
  await writeFile(join(root, 'data', 'settings.json'), JSON.stringify({
    gptSovits: { enabled: false },
    langs: { speech: 'zh', subtitle: 'zh' },
    autoMemory: { enabled: false },
    voice: { chunking, ackDelayMs: 15000 },
  }));
  state.players = [];
  state.subtitles = [];
  state.texts = [];
  state.onUpdate = null;
  state.hearingStats = { rmsDb: -20 };
  state.turnIds = [];
  state.preStepMessages = new Map();
  state.holdTurns = holdTurns;
  state.failTurns = failTurns;
  state.replyFor = reply;
  state.spokenCalls = 0;
  state.llmCalls = 0;
  state.synth = async ({ text }) => {
    state.texts.push(text);
    return { file: join(root, 'tts', `${state.texts.length}.mp3`), bytes: 16, durationMs: 200, provider: 'edge-tts' };
  };

  const listeners = new Set();
  const cleanups = [];
  const tools = new Map();
  const emptyStream = async function* emptyReplyStream() {
    yield { type: 'text', text: '好的。' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  };
  const services = new Map([
    ['agentDefaultModel', { currentSelection: () => ({ provider: 'fake-provider', model: 'fake-model' }) }],
    ['sessionTitle', { get: () => undefined, rename: (_session, title) => ({ title, source: { kind: 'user' } }) }],
    ['workspaceRegistry', {
      async create(path) { return { id: 'ws-streaming-end', path }; },
      get() { return { id: 'ws-streaming-end', async attachSession() {} }; },
    }],
    ['llm', {
      stream(options = {}) {
        state.llmCalls += 1;
        const system = String(options.system ?? '');
        if (system.includes(SPOKEN_SYSTEM_MARK)) {
          state.spokenCalls += 1;
          return state.spokenStream();
        }
        return emptyStream();
      },
    }],
  ]);
  const agents = new Map();
  let seq = 0;
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
  };
  const fireEvent = (session, type, data) => bus.fire('session/event', session, {
    type, seq: (seq += 1), time: Date.now(), data,
  });
  const runPreStep = async (agent, session, turn, message) => {
    const entries = [...listeners].filter((entry) => entry.type === 'agent/pre-step');
    let index = 0;
    const payload = { agent, session, turn, step: 1, messages: [message], signal: new AbortController().signal };
    const next = async () => {
      if (index >= entries.length) return { kind: 'accept', messages: [message] };
      const entry = entries[index];
      index += 1;
      return entry.fn(payload, next);
    };
    return next();
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
        const runTurn = async () => {
          const decision = await runPreStep(agent, session, turnId, message);
          const messages = Array.isArray(decision?.messages) ? decision.messages : [message];
          state.preStepMessages.set(turnId, messages);
          fireEvent(session, 'turn/start', { turn: turnId });
          state.turnIds.push(turnId);
          fireEvent(session, 'user/message', message);
          const held = state.holdTurns.get(turnId);
          if (held !== undefined) await held.promise;
          if (state.failTurns.has(turnId)) {
            fireEvent(session, 'turn/end', { turn: turnId, reason: { kind: 'error' } });
            return;
          }
          const text = typeof state.replyFor === 'function'
            ? state.replyFor({ turn: turnId, text: messageText(message), messages })
            : String(state.replyFor);
          fireEvent(session, 'assistant/message', {
            turn: turnId,
            step: 1,
            message: { id: `a-${turnId}`, role: 'assistant', content: [{ type: 'text', text: String(text ?? '') }] },
          });
          fireEvent(session, 'turn/end', { turn: turnId, reason: { kind: 'completed' } });
        };
        void runTurn().catch(() => {});
      },
    };
    return agent;
  };
  services.set('agentLoop', {
    async resume(_ownerCtx, options) {
      const id = options.resumeSessionId;
      if (!agents.has(id)) agents.set(id, makeAgent(id));
      return { agent: agents.get(id) };
    },
    async createAgent(_ownerCtx, options) {
      const agent = makeAgent(options.sessionId);
      agents.set(options.sessionId, agent);
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
  }, { root, enabled: true, asrMergeWindowMs: 10 });

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
  const findEvent = async (type, predicate = () => true) => {
    const row = (await events()).find((event) => event.type === type && predicate(event.payload ?? {}));
    return row?.payload ?? null;
  };
  const waitForEvent = async (type, predicate = () => true, timeoutMs = 8000) => {
    const startedAt = Date.now();
    for (;;) {
      const row = await findEvent(type, predicate);
      if (row !== null) return row;
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
    say: (text) => state.onUpdate({ final: text, durationMs: 100 }),
    events,
    findEvent,
    waitForEvent,
    players: () => state.players,
    resolvePlayer: (index) => state.players[index]?.resolve(),
    texts: () => state.texts,
    turnIds: () => state.turnIds,
  };
}

// ---------------------------------------------------------------------------
// 1. Slow stream: first unit plays, the tail arrives 500 ms later
// ---------------------------------------------------------------------------

test('1. slow stream: the first unit finishing never closes the group; the tail still plays', async (t) => {
  const tailGate = deferred();
  const app = await mountVoiceRound(t);
  state.spokenStream = async function* slowStream() {
    yield { type: 'text', text: UNIT_ONE };
    await tailGate.promise;
    yield { type: 'text', text: UNIT_TWO };
    yield { type: 'finish', reason: { kind: 'stop' } };
  };

  app.say('介绍一下吧');
  await waitUntil(() => app.players().length === 1, 'the first unit reached the player');
  await app.waitForEvent('voice.response.playback', (payload) => payload.status === 'started');
  app.resolvePlayer(0);
  await app.waitForEvent('voice.response.playback', (payload) => payload.status === 'completed');

  // The model is still writing: 500 ms after the first unit finished there is no tail and no done.
  await tick(500);
  assert.equal((await app.findEvent('voice.response.group.done')) !== null, false,
    'the group did not close while the plan was unsealed');
  assert.equal((await app.findEvent('voice.response.group.sealed')) !== null, false,
    'no seal was reported before the stream ended');
  assert.equal(app.players().length, 1, 'no tail unit existed yet');

  // The model produces the tail now; it must still be played.
  tailGate.resolve();
  await waitUntil(() => app.players().length === 2, 'the late tail unit reached the player');
  // Let the stream produce its end marker before the tail clip ends: the completion must then be
  // the ordinary "last unit played" path, not a seal-time catch-up.
  const sealed = await app.waitForEvent('voice.response.group.sealed');
  app.resolvePlayer(1);
  const done = await app.waitForEvent('voice.response.group.done');
  assert.deepEqual({ groupId: sealed.groupId, units: sealed.units }, { groupId: done.groupId, units: 2 });
  assert.equal(done.reason, 'played');
  const rows = await app.events();
  const skips = rows.filter((row) => row.type === 'voice.response.playback' && row.payload.status === 'skipped-stale');
  assert.equal(skips.length, 0, 'the tail was played, never refused as stale');
  const completed = rows.filter((row) => row.type === 'voice.response.playback' && row.payload.status === 'completed');
  assert.equal(completed.length, 2, 'both units completed');
  t.diagnostic(
    `playedUnits=2 sealedUnits=${sealed.units} done=${done.reason} `
    + `sealedBeforeDone=true skippedStale=${skips.length}`,
  );
});

// ---------------------------------------------------------------------------
// 2. Fast stream: every unit arrives before playback; done timing is unchanged
// ---------------------------------------------------------------------------

test('2. fast stream: done still follows the LAST completed unit (regression)', async (t) => {
  const app = await mountVoiceRound(t);
  state.spokenStream = async function* fastStream() {
    yield { type: 'text', text: UNIT_ONE };
    yield { type: 'text', text: UNIT_TWO };
    yield { type: 'finish', reason: { kind: 'stop' } };
  };

  app.say('介绍一下吧');
  const sealed = await app.waitForEvent('voice.response.group.sealed');
  assert.equal(sealed.units, 2, 'both units were fed before playback');
  await waitUntil(() => app.players().length === 1, 'the first unit started');
  app.resolvePlayer(0);
  await app.waitForEvent('voice.response.playback', (payload) => payload.status === 'completed');
  await tick(50);
  assert.equal((await app.findEvent('voice.response.group.done')) !== null, false,
    'the sealed plan still has an unfinished unit, so the group is not done');

  await waitUntil(() => app.players().length === 2, 'the second unit started');
  app.resolvePlayer(1);
  const done = await app.waitForEvent('voice.response.group.done');
  assert.equal(done.reason, 'played');

  const rows = await app.events();
  const completed = rows.filter((row) => row.type === 'voice.response.playback' && row.payload.status === 'completed');
  assert.equal(completed.length, 2, 'both units completed before the group closed');
  assert.equal(done.playedSentences, 2, 'the completion covers both real units');
  t.diagnostic(
    `sealedUnits=${sealed.units} completed=${completed.length} doneAfterLast=true done=${done.reason} `
    + `playedSentences=${done.playedSentences}`,
  );
});

// ---------------------------------------------------------------------------
// 3. Sealed plan: late units beyond the drain limit are explicitly dropped
// ---------------------------------------------------------------------------

function mountSealedPlan({ units = ['第一句。'] } = {}) {
  const clock = { t: 0 };
  const events = [];
  const plays = [];
  const dropped = [];
  const store = createResponseGroupStore({
    now: () => clock.t,
    emit: (type, payload) => events.push({ type, payload }),
  });
  const input = store.beginInput({ sessionId: 'seirein-stream-seal', text: '测试问题', at: clock.t });
  const { group } = input;
  const version = input.answerVersion;
  store.noteAnswerPlan({
    group, version, text: units.join(''), feedText: units.join(''), source: 'condensed',
    chars: units.join('').length, units: units.length,
  });
  const speaker = createReplySpeaker({
    startedAt: 0,
    now: () => clock.t,
    synthesize: async ({ text }) => ({ file: `${text}.mp3`, bytes: 8, durationMs: 1 }),
    play: async ({ text, sentenceId, chunkIndex = 0, chunkCount = 1 }) => {
      const gate = deferred();
      const current = store.isCurrentAnswer(group, version);
      if (current) {
        store.notePlaybackStart({ group, version, sentenceId, chunkIndex, chunkCount, text });
      } else {
        store.notePlaybackSkipped({ group, version, sentenceId, chunkIndex, chunkCount });
      }
      plays.push({ text, gate, done: false });
      return {
        audioStartedAt: 1,
        done: gate.promise.then(() => {
          if (current) {
            store.notePlaybackEnd({
              group, version, sentenceId, chunkIndex, chunkCount, status: 'completed', text,
            });
          }
        }),
      };
    },
    onEvent: (event) => {
      if (event.type === 'voice.speech.dropped') dropped.push(event);
    },
  });
  return { clock, events, plays, dropped, store, group, version, speaker };
}

test('3. after the plan seals, late units beyond the drain limit are explicitly dropped', async (t) => {
  const app = mountSealedPlan();
  app.speaker.push('第一句。');
  const finishing = app.speaker.finish({ fullText: '第一句。' });
  await waitUntil(() => app.plays.length === 1, 'the sealed unit reached the player');
  // The first late unit must arrive while finish() is still draining (the real race window).
  app.speaker.push('迟到第1句。');
  assert.equal(app.dropped.length, 0, 'a unit inside the drain window is not dropped yet');
  app.plays[0].gate.resolve();
  await waitUntil(() => app.store.get(app.group.id).state === 'done', 'the sealed plan completed');
  const sealed = app.events.find((row) => row.type === 'voice.response.group.sealed');
  assert.deepEqual(
    { groupId: sealed.payload.groupId, units: sealed.payload.units },
    { groupId: app.group.id, units: 1 },
  );

  // Four late units are drained (each starts one extra run); the fifth exceeds LATE_DRAIN_ROUNDS.
  await waitUntil(() => app.plays.length === 2, 'late unit 1 was drained');
  for (let index = 2; index <= 4; index += 1) {
    app.speaker.push(`迟到第${index}句。`);
    app.plays[index - 1].gate.resolve();
    await waitUntil(() => app.plays.length === index + 1, `late unit ${index} was drained`);
  }
  app.speaker.push('第五个迟到单元。');
  app.plays[4].gate.resolve();
  const stats = await finishing;

  assert.equal(stats.droppedSentences, 1, 'the over-limit unit is counted as dropped');
  assert.equal(app.dropped.length, 1, 'exactly one explicit dropped row');
  assert.equal(app.dropped[0].reason, 'late-after-finish');
  assert.match(app.dropped[0].text, /第五个迟到单元/u);
  assert.equal(app.store.get(app.group.id).state, 'done', 'a late extra unit never revives the sealed group');
  t.diagnostic(
    `sealedUnits=1 drainedLate=4 dropped=${app.dropped.length} reason=${app.dropped[0].reason} `
    + `statsDropped=${stats.droppedSentences} group=${app.store.get(app.group.id).state}`,
  );
});

// ---------------------------------------------------------------------------
// 4. First unit plays, the model has not ended after 2 s: still not done
// ---------------------------------------------------------------------------

test('4. the first unit plays but the model is silent for 2 s: the group stays open', async (t) => {
  const tailGate = deferred();
  const app = await mountVoiceRound(t);
  state.spokenStream = async function* stalledStream() {
    yield { type: 'text', text: UNIT_ONE };
    await tailGate.promise;
    yield { type: 'text', text: UNIT_TWO };
    yield { type: 'finish', reason: { kind: 'stop' } };
  };

  app.say('介绍一下吧');
  await waitUntil(() => app.players().length === 1, 'the first unit reached the player');
  app.resolvePlayer(0);
  await app.waitForEvent('voice.response.playback', (payload) => payload.status === 'completed');

  await tick(2_000);
  const during = await app.events();
  const sealedBefore = during.some((row) => row.type === 'voice.response.group.sealed');
  const doneBefore = during.some((row) => row.type === 'voice.response.group.done');
  assert.equal(sealedBefore, false, 'after 2 s the spoken plan is still unsealed');
  assert.equal(doneBefore, false, 'the group did not declare done from the first unit alone');
  assert.equal(app.players().length, 1, 'no tail unit was invented');

  // Let the test finish cleanly: the tail arrives, plays, and only then closes the answer.
  tailGate.resolve();
  await waitUntil(() => app.players().length === 2, 'the tail finally reached the player');
  await app.waitForEvent('voice.response.group.sealed');
  app.resolvePlayer(1);
  const done = await app.waitForEvent('voice.response.group.done');
  assert.equal(done.reason, 'played');
  t.diagnostic(
    `after2s sealed=${sealedBefore} done=${doneBefore} players=${app.players().length} `
    + `finalDone=${done.reason} generatingOrPlaying=${!doneBefore}`,
  );
});
