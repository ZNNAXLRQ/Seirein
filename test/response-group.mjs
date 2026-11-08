/**
 * Response groups (batch 2 of continuous speech): one expression, one coherent answer.
 *
 * The host is mounted for real (`apply` + `assistant_listen` + the real voice round), while the
 * microphone, the agent loop, TTS and the player are deterministic fakes. The agent model is a
 * function of the *pre-step decision*, so a test can prove the internal continuation context
 * actually reached the turn that follows — and that it is not a user message.
 *
 * Covered:
 *   1. a second segment during generation: both inputs in the final answer, one playback, the
 *      old result never plays late
 *   2. body finished but voice not started: the old audio never plays, one unified spoken version
 *   3. partly played: the new version continues the unvoiced sentences, never restarts the opening
 *   4. fully played: the next input is a normal new round, no repeated summary
 *   5. explicit cancel ("停/别说了"): cancelled, never auto-resumed
 *   6. the second round fails: the first group's unvoiced content is retained
 *   7. explicit topic switch: no forced merge, the pending group is retained with a reason
 *   8. one answer, many sentences/blocks: every block plays once, in order
 *   9. group count and lifetime limits, with reasons
 *  10. host round: an input seven minutes later is a new round, never a merge of the old answer
 *  11. store: a seven-minute-old group is abandoned+retained; the new group inherits nothing
 *  12. store: a supplement five seconds later still continues (original behavior)
 *  13. store: twenty seconds exceeds the default 15 s window
 *  14. store: a configured 30 s window continues at 20 s and stops just past it
 *  15. store: a topic switch inside the window still does not merge
 *  16. store: an explicit continuation ("还有/补充") 2 s later still merges
 *  17. store: a new instruction ("切回屏幕模式"/"打开 OBS") 2 s later opens a new group
 *  18. store: answer text done + speech incomplete becomes speechPending (never into a new group)
 *  19. store: "接着播/继续" is the only path that restores speechPending content
 *  20. store: a superseded group's late body/plan/playback is never mixed into the new group
 *  21. store (B): a never-spoken round's points are carried into the next spoken organization,
 *      but a round that already started sounding is never auto-carried
 *
 * Run: node --test test/response-group.mjs
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { registerHooks } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupRoot, disposeAll } from './helpers/cleanup.mjs';
import {
  CONTINUATION_MAX_GAP_MS,
  composeCarryConveyFallback,
  composeCarryConveyText,
  composeResponseGroupContext,
  createResponseGroupStore,
  splitSpeechSentences,
} from '../src/host/session/conversation/responseGroup.js';

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
  replyTurnId: null,
  loopSession: null,
};
globalThis.__responseGroups = state;

const ttsUrl = new URL('../src/host/speech/tts.js', import.meta.url).href;
const sightUrl = new URL('../src/host/vision/sight.js', import.meta.url).href;
const subtitleUrl = new URL('../src/host/subtitle/subtitle.js', import.meta.url).href;
const speechTextUrl = new URL('../src/host/speech/speech-text.js', import.meta.url).href;
const hearingUrl = new URL('../src/host/hearing/hearing.js', import.meta.url).href;
const hooks = registerHooks({
  load(url, context, next) {
    if (url === hearingUrl) {
      // Synthetic microphone: the real `handleVoiceTask` path receives each final the test sends.
      return {
        format: 'module',
        shortCircuit: true,
        source: `
    const s = globalThis.__responseGroups;
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
      // The wrappers delegate to the real module, so Markdown speech/caption parsing is real.
      return {
        format: 'module',
        shortCircuit: true,
        source: `
    import * as real from '${speechTextUrl}?response-group-real';
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
    const s = globalThis.__responseGroups;
    export { resolveGptLangs, resolveGptSovitsTimeout } from '${ttsUrl}?response-group-helpers';
    export { speakChunks, speechChunkTexts } from '${ttsUrl}?response-group-chunk';
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
    export { SubtitleHold } from '${subtitleUrl}?response-group-real';
    export class SubtitleOverlay {
      constructor({ config }) { this.config = config; }
      async show(text) { globalThis.__responseGroups.subtitles.push({ text, at: Date.now() }); return true; }
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
const { apply, voiceSessionTarget } = await import('../src/host/index.js');
hooks.deregister();
after(() => { delete globalThis.__responseGroups; });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

const waitUntil = async (check, message, timeoutMs = 6000) => {
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

/**
 * The real voice round with a fake agent. The agent runs one turn per followup and asks the
 * registered `agent/pre-step` waterfall first (so the host's internal continuation context is
 * actually appended to that turn's messages, exactly like the real loop).
 */
async function mountVoiceRound(t, {
  chunking = false, config = {}, replyFor = null, holdTurns = new Map(), failTurns = new Set(),
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-response-group-'));
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
    // The acknowledgement line is not part of this suite: park it far past every test.
    voice: { chunking, ackDelayMs: 15000 },
  }));
  state.players = [];
  state.subtitles = [];
  state.texts = [];
  state.onUpdate = null;
  state.hearingStats = { rmsDb: -20 };
  state.turnIds = [];
  state.replyTurnId = null;
  state.loopSession = null;
  state.preStepMessages = new Map();
  state.holdTurns = holdTurns;
  state.failTurns = failTurns;
  state.replyFor = typeof replyFor === 'function' ? replyFor : (() => '第一句。第二句。');
  state.synth = async ({ text }) => {
    state.texts.push(text);
    return { file: join(root, 'tts', `${state.texts.length}.mp3`), bytes: 16, durationMs: 200, provider: 'edge-tts' };
  };

  const listeners = new Set();
  const cleanups = [];
  const tools = new Map();
  const services = new Map([
    ['agentDefaultModel', { currentSelection: () => ({ provider: 'fake-provider', model: 'fake-model' }) }],
    ['sessionTitle', { get: () => undefined, rename: (_session, title) => ({ title, source: { kind: 'user' } }) }],
    ['workspaceRegistry', {
      async create(path) { return { id: 'ws-response-group', path }; },
      get() { return { id: 'ws-response-group', async attachSession() {} }; },
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
  /**
   * Run the `agent/pre-step` waterfall as the loop does: registered listeners in order, each
   * receiving `(payload, next)`. Returns the final decision (with every appended message).
   */
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
          state.loopSession = session;
          const decision = await runPreStep(agent, session, turnId, message);
          const messages = Array.isArray(decision?.messages) ? decision.messages : [message];
          state.preStepMessages.set(turnId, messages);
          fireEvent(session, 'turn/start', { turn: turnId });
          state.turnIds.push(turnId);
          fireEvent(session, 'user/message', message);
          state.replyTurnId = turnId;
          const held = state.holdTurns.get(turnId);
          if (held !== undefined) await held.promise;
          if (state.failTurns.has(turnId)) {
            fireEvent(session, 'turn/end', { turn: turnId, reason: { kind: 'error' } });
            return;
          }
          const userText = messageText(message);
          const text = typeof state.replyFor === 'function'
            ? state.replyFor({ turn: turnId, text: userText, messages })
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
    // The session already exists, so each followup is exactly one turn.
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
    say: (text) => state.onUpdate({ final: text, durationMs: 100 }),
    events,
    waitForEvent,
    players: () => state.players,
    resolvePlayer: (index) => state.players[index]?.resolve(),
    texts: () => state.texts,
    preStep: (turn) => state.preStepMessages.get(turn) ?? null,
    turnIds: () => state.turnIds,
    contextMessages: (turn) => (state.preStepMessages.get(turn) ?? [])
      .filter((message) => message?.source?.kind === 'assistant-response-group'),
    userMessages: (turn) => (state.preStepMessages.get(turn) ?? [])
      .filter((message) => message?.source?.kind === 'user'),
  };
}

/** Resolve one player after the previous clip reached the player, so playback stays serial. */
async function playAll(app, expected) {
  for (let index = 0; index < expected; index += 1) {
    await waitUntil(() => app.players().length >= index + 1, `clip ${index + 1} reached the player`);
    app.resolvePlayer(index);
    await tick(10);
  }
}

const playerCaptions = (app) => app.players().map((player) => {
  const match = /(\d+)\.mp3$/u.exec(String(player.file ?? ''));
  return match === null ? '' : String(state.texts[Number(match[1]) - 1] ?? '');
});

/**
 * A bare store with a controllable clock. The continuation window is a decision about *minutes*,
 * so its cases are proven directly instead of sleeping in the suite.
 */
function groupStore(overrides = {}) {
  const clock = { t: 1_000_000 };
  const events = [];
  const store = createResponseGroupStore({
    now: () => clock.t,
    emit: (type, payload) => events.push({ type, payload }),
    ...overrides,
  });
  return {
    store,
    clock,
    events,
    abandoned: () => events.find((row) => row.type === 'voice.response.group.abandoned') ?? null,
  };
}

/**
 * One group whose text is complete but whose speaker never started: the exact B case where the
 * unvoiced points may be carried into the NEXT round's spoken organization.
 */
function openNeverPlayedGroup(store, clock, {
  sessionId, text = 'OBS 全黑怎么调', plan = '旧回答第一句。旧回答第二句。',
}) {
  const input = store.beginInput({ sessionId, text, at: clock.t });
  store.noteAnswerPlan({ group: input.group, version: 1, text: plan });
  store.adjustSpeech({ group: input.group, version: 1, text: plan });
  assert.equal(store.get(input.group.id).speechStarted, false, 'the fixture never started sounding');
  assert.equal(store.get(input.group.id).played.length, 0, 'played=0 is the carry gate');
  return input;
}

/**
 * One group whose first sentence sounded and whose second sentence is still unvoiced, so the group
 * is `playing` and still owns pending content — the exact state of the OBS counterexample.
 */
function openPlayingGroup(store, clock, { sessionId, text = '请把这一轮完整读出来' }) {
  const input = store.beginInput({ sessionId, text, at: clock.t });
  store.noteAnswerPlan({
    group: input.group, version: input.answerVersion, text: '旧回答第一句。旧回答第二句。',
  });
  store.adjustSpeech({
    group: input.group, version: input.answerVersion, text: '旧回答第一句。旧回答第二句。',
  });
  store.notePlaybackStart({
    group: input.group, version: input.answerVersion, sentenceId: 0, text: '旧回答第一句。',
  });
  assert.equal(store.get(input.group.id).state, 'playing', 'the fixture group is sounding');
  assert.deepEqual(
    store.get(input.group.id).pendingSentences,
    ['旧回答第二句。'],
    'the fixture keeps one unvoiced sentence',
  );
  return input;
}

// ---------------------------------------------------------------------------
// 1. A second segment while the first answer is still generating
// ---------------------------------------------------------------------------

test('1. a segment during generation is unified into one answer and the old result never plays', async (t) => {
  const gate = deferred();
  const app = await mountVoiceRound(t, {
    holdTurns: new Map([[1, gate]]),
    replyFor: ({ turn, messages }) => {
      if (turn === 1) return '第一轮的完整回答：天气要查，路线也要看。';
      const context = messages.map((message) => messageText(message)).join('\n');
      const unified = context.includes('本次新增输入：补充内容') && context.includes('第一段输入');
      return unified ? '统一回答：第一段输入和补充内容一起处理完了。' : '没有拿到连续上下文。';
    },
  });
  app.say('第一段输入');
  await waitUntil(() => app.preStep(1) !== null, 'the first turn started');
  const created = await app.waitForEvent('voice.response.group.created');
  const groupId = created.groupId;

  app.say('补充内容');
  const continued = await app.waitForEvent('voice.response.group.continued');
  assert.equal(continued.groupId, groupId, 'the second segment joined the same group');
  assert.equal(continued.generation, 2, 'a new generation for the segment');
  assert.equal(continued.priorVersion, 1, 'the first answer version is the prior one');
  assert.equal(app.turnIds().length, 1, 'no parallel agent turn was opened while the first was held');

  gate.resolve();
  await waitUntil(() => app.preStep(2) !== null, 'the unified turn started');
  const context = app.contextMessages(2).map((message) => messageText(message)).join('\n');
  assert.ok(context.includes('第一段输入'), 'the internal context carries the earlier user input');
  assert.ok(context.includes('第一轮的完整回答'), 'the internal context carries the generated answer');
  assert.ok(context.includes('本次新增输入：补充内容'), 'the internal context carries the new input');
  assert.equal(app.userMessages(2).length, 1, 'only the new segment is a real user message');

  await playAll(app, 2);
  const done = await app.waitForEvent('voice.response.group.done');
  assert.equal(done.groupId, groupId);
  const rows = await app.events();
  const played = rows.filter((event) => event.type === 'voice.response.playback' && event.payload.status === 'started');
  assert.ok(played.length >= 1, 'the unified answer was played');
  assert.equal(played.every((event) => event.payload.answerVersion === 2), true, 'only version 2 sounded');
  assert.equal(
    rows.filter((event) => event.type === 'voice.response.playback' && event.payload.answerVersion === 1).length,
    0,
    'the superseded first version never reached the player',
  );
  assert.equal(app.players().length, 2, 'one unified answer task: the unvoiced first body, then the unified line');
  assert.match(playerCaptions(app)[1], /统一回答/u);
  t.diagnostic(
    `group=${groupId} gen=${continued.generation} turns=${app.turnIds().join(',')} `
    + `players=2 playedVersion=2 oldPlayback=0`,
  );
});

// ---------------------------------------------------------------------------
// 2. Body finished, voice not started: the old audio never plays
// ---------------------------------------------------------------------------

test('2. a segment after the body but before voice playback revokes the old audio and speaks once', async (t) => {
  const synthGate = deferred();
  const synthEntered = deferred();
  const app = await mountVoiceRound(t, {
    replyFor: ({ turn }) => (turn === 1 ? '旧回答第一句。旧回答第二句。' : '新回答。'),
  });
  const baseSynth = state.synth;
  state.synth = async (options) => {
    if (options.text.includes('旧回答第一句')) {
      synthEntered.resolve();
      await synthGate.promise;
    }
    return baseSynth(options);
  };
  app.say('请完整读出来');
  await app.waitForEvent('voice.response.group.ready', (payload) => payload.version === 1);
  await synthEntered.promise;
  assert.equal(app.players().length, 0, 'the old version had not reached the player yet');

  app.say('补充内容');
  await app.waitForEvent('voice.response.group.continued');
  synthGate.resolve();
  await waitUntil(() => app.preStep(2) !== null, 'the unified turn started');
  await playAll(app, 3);
  const done = await app.waitForEvent('voice.response.group.done');
  assert.equal(done.reason, 'played');
  const rows = await app.events();
  assert.equal(
    rows.filter((event) => event.type === 'voice.response.playback' && event.payload.answerVersion === 1).length,
    0,
    'the revoked version never played a block',
  );
  assert.equal(playerCaptions(app).length, 3, 'the unified version played three sentences, not the old clip plus the new one');
  assert.deepEqual(
    playerCaptions(app),
    ['旧回答第一句。', '旧回答第二句。', '新回答。'],
    'the old body was kept and voiced once, then the new answer',
  );
  t.diagnostic(`oldAudioPlayers=0 unifiedSentences=${playerCaptions(app).length} done=${done.reason}`);
});

// ---------------------------------------------------------------------------
// 3. Partly played: continue, never restart from the top
// ---------------------------------------------------------------------------

test('3. a segment while partly played continues the unvoiced sentences without repeating the opening', async (t) => {
  const secondGate = deferred();
  const app = await mountVoiceRound(t, {
    replyFor: ({ turn }) => (turn === 1 ? '第一句。第二句。第三句。' : '第一句。第二句。第三句。补充内容。'),
  });
  const baseSynth = state.synth;
  state.synth = async (options) => {
    if (options.text.includes('第二句') && options.text.includes('第二句。第三句') === false) {
      await secondGate.promise;
    }
    return baseSynth(options);
  };
  app.say('请完整读出来');
  await waitUntil(() => app.players().length === 1, 'the first sentence started');
  app.say('完整读一遍补充内容');
  const cancelled = await app.waitForEvent('speech.cancelled');
  assert.equal(cancelled.reason, 'voice');
  const continued = await app.waitForEvent('voice.response.group.continued');
  assert.equal(continued.playedSentences, 1, 'only the first sentence had really played');
  secondGate.resolve();
  await waitUntil(() => app.preStep(2) !== null, 'the continuation turn started');
  const oldPlayerCount = app.players().length;
  const captions = [];
  for (let index = 0; index < 3; index += 1) {
    const playerIndex = oldPlayerCount + index;
    await waitUntil(() => app.players().length >= playerIndex + 1, `continued sentence ${index + 1} reached the player`);
    captions.push(playerCaptions(app)[playerIndex]);
    app.resolvePlayer(playerIndex);
    await tick(15);
  }
  const done = await app.waitForEvent('voice.response.group.done');
  assert.equal(done.reason, 'played');
  assert.deepEqual(captions, ['第二句。', '第三句。', '补充内容。'], 'unvoiced sentences continue in order; the opening is not replayed');
  assert.ok(!captions.includes('第一句。'), 'the already-played opening never repeats');
  assert.equal(
    playerCaptions(app)[0],
    '第一句。',
    'the first sentence was the one that had already played',
  );
  const rows = await app.events();
  const speech = rows.find((event) => event.type === 'voice.response.speech');
  assert.equal(speech?.payload?.skippedPlayedSentences, 1, 'the already-played sentence was skipped exactly once');
  t.diagnostic(
    `playedBefore=1 continued=${captions.join('|')} skipped=${speech?.payload?.skippedPlayedSentences} `
    + `prepended=${speech?.payload?.prependedSentences}`,
  );
});

// ---------------------------------------------------------------------------
// 4. Fully played: the next input is a normal new round
// ---------------------------------------------------------------------------

test('4. a segment after the whole answer played is a normal new round with no repeated summary', async (t) => {
  const app = await mountVoiceRound(t, {
    replyFor: ({ turn }) => (turn === 1 ? '旧回答第一句。旧回答第二句。' : '新的内容。'),
  });
  app.say('请完整读出来');
  await playAll(app, 2);
  const done = await app.waitForEvent('voice.response.group.done');
  const firstGroup = done.groupId;
  const rowsBefore = await app.events();
  const firstCreated = rowsBefore.find((event) => event.type === 'voice.response.group.created');

  app.say('换一个新问题');
  const secondCreated = await app.waitForEvent('voice.response.group.created', (payload) => payload.groupId !== firstGroup);
  assert.notEqual(secondCreated.groupId, firstGroup, 'a finished group is not continued');
  assert.notEqual(secondCreated.reason, 'topic-switch', 'no forced merge: it is simply a new round');
  await waitUntil(() => app.preStep(2) !== null, 'the new round started');
  assert.equal(app.contextMessages(2).length, 0, 'a new round gets no continuation context');
  await waitUntil(() => app.players().length === 3, 'the new answer reached the player');
  app.resolvePlayer(2);
  assert.equal(playerCaptions(app)[2], '新的内容。');
  assert.ok(!playerCaptions(app).slice(2).some((text) => text.includes('旧回答')), 'the previous answer is not summarized again');
  assert.equal(
    (await app.events()).filter((event) => event.type === 'voice.response.group.continued').length,
    0,
    'no continuation was fabricated for a finished group',
  );
  t.diagnostic(`groups=${firstCreated.payload.groupId}->${secondCreated.groupId} reason=${secondCreated.reason} repeats=0`);
});

// ---------------------------------------------------------------------------
// 5. Explicit cancel: cancelled, never auto-resumed
// ---------------------------------------------------------------------------

test('5. "停，别说了" cancels the group and never resumes by itself', async (t) => {
  const app = await mountVoiceRound(t, {
    replyFor: () => '第一句。第二句。第三句。',
  });
  app.say('请完整读出来');
  await waitUntil(() => app.players().length === 1, 'the first sentence started');
  const turnsBefore = app.turnIds().slice();
  app.say('停，别说了');
  const cancelled = await app.waitForEvent('voice.response.group.cancelled');
  assert.equal(cancelled.explicit, true);
  assert.equal(cancelled.reason, 'user-cancel');
  const userCancel = await app.waitForEvent('voice.response.user-cancel');
  assert.equal(userCancel.explicit, true);
  await tick(400);
  assert.deepEqual(app.turnIds(), turnsBefore, 'the stop phrase never opens an agent turn');
  assert.equal(app.players().length, 1, 'nothing new was synthesized/played after the cancel');
  const rows = await app.events();
  assert.equal(
    rows.filter((event) => event.type === 'voice.response.group.continued').length,
    0,
    'an explicit cancel is not a continuation',
  );
  // A later utterance is a new group, not an automatic resume of the cancelled one.
  app.say('换个新问题');
  const created = await app.waitForEvent('voice.response.group.created', (payload) => payload.groupId !== cancelled.groupId);
  assert.notEqual(created.groupId, cancelled.groupId);
  await waitUntil(() => app.preStep(2) !== null, 'the later input is a normal new round');
  assert.equal(app.contextMessages(2).length, 0, 'no automatic recovery context after a cancel');
  t.diagnostic(`cancelled=${cancelled.groupId} explicit=${cancelled.explicit} resumedTurns=${app.turnIds().length - turnsBefore.length}`);
});

// ---------------------------------------------------------------------------
// 6. A failed second round keeps the first answer's unvoiced content
// ---------------------------------------------------------------------------

test('6. a failed second round does not erase the first group\'s pending content', async (t) => {
  const gate = deferred();
  const app = await mountVoiceRound(t, {
    holdTurns: new Map([[1, gate]]),
    failTurns: new Set([2]),
    replyFor: ({ turn }) => (turn === 1 ? '第一轮待回应第一句。第一轮待回应第二句。' : '第三轮回应。'),
  });
  app.say('第一段输入');
  await waitUntil(() => app.preStep(1) !== null, 'the first turn started');
  const created = await app.waitForEvent('voice.response.group.created');

  app.say('补充内容');
  await app.waitForEvent('voice.response.group.continued');
  gate.resolve();
  const failed = await app.waitForEvent('voice.response.group.failed');
  assert.equal(failed.retained, true, 'a normal failure retains the pending content');
  assert.equal(failed.groupId, created.groupId);
  assert.ok(failed.pendingSentences >= 2, `pending sentences retained (${failed.pendingSentences})`);

  app.say('再补充一句');
  const continuedAgain = await app.waitForEvent('voice.response.group.continued', (payload) => payload.generation >= 3);
  assert.equal(continuedAgain.groupId, created.groupId, 'the same group still owns the unvoiced content');
  assert.equal(continuedAgain.priorState, 'failed');
  await waitUntil(() => app.preStep(3) !== null, 'the third turn started');
  const context = app.contextMessages(3).map((message) => messageText(message)).join('\n');
  assert.ok(context.includes('第一轮待回应第一句'), 'the third turn still sees the first answer\'s unvoiced content');
  assert.ok(context.includes('第一段输入'), 'the earlier user input is still there');
  t.diagnostic(
    `group=${created.groupId} failedRetained=${failed.retained} pending=${failed.pendingSentences} `
    + `gen3=${continuedAgain.generation}`,
  );
});

// ---------------------------------------------------------------------------
// 7. An explicit topic switch does not force a merge
// ---------------------------------------------------------------------------

test('7. an explicit topic switch is not merged; the pending group is retained with a reason', async (t) => {
  const app = await mountVoiceRound(t, {
    replyFor: ({ turn }) => (turn === 1 ? '旧话题第一句。旧话题第二句。' : '新话题的回答。'),
  });
  app.say('请完整读出来');
  await waitUntil(() => app.players().length === 1, 'the first sentence started');
  const created = await app.waitForEvent('voice.response.group.created');
  app.say('换个话题，明天天气怎么样');
  const abandoned = await app.waitForEvent('voice.response.group.abandoned');
  assert.equal(abandoned.reason, 'topic-switch');
  assert.equal(abandoned.retained, true);
  assert.ok(abandoned.pending > 0, 'the unvoiced content is retained as a bounded state');
  const next = await app.waitForEvent('voice.response.group.created', (payload) => payload.groupId !== created.groupId);
  assert.equal(next.reason, 'topic-switch', 'the new group names the switch');
  await waitUntil(() => app.preStep(2) !== null, 'the new-topic turn started');
  assert.equal(app.contextMessages(2).length, 0, 'a topic switch never injects the old continuation context');
  await waitUntil(() => app.players().length === 2, 'the new-topic answer reached the player');
  assert.equal(playerCaptions(app)[1], '新话题的回答。');
  const rows = await app.events();
  assert.equal(
    rows.filter((event) => event.type === 'voice.response.group.continued').length,
    0,
    'no forced merge across topics',
  );
  t.diagnostic(`old=${created.groupId} reason=${abandoned.reason} pending=${abandoned.pending} new=${next.groupId}`);
});

// ---------------------------------------------------------------------------
// 8. One answer, many sentences and blocks: all played once, in order
// ---------------------------------------------------------------------------

test('8. many sentences and blocks all play once in order', async (t) => {
  const reply = '这是第一块的内容，这是第二块的内容，这是第三块的内容。最后一句单独播放。';
  const app = await mountVoiceRound(t, {
    chunking: true,
    replyFor: () => reply,
  });
  app.say('请完整读出来');
  const expectedBlocks = 4;
  await playAll(app, expectedBlocks);
  const done = await app.waitForEvent('voice.response.group.done');
  assert.equal(done.reason, 'played');
  const rows = await app.events();
  const order = rows
    .filter((event) => event.type === 'voice.response.playback' && event.payload.status === 'started')
    .map((event) => `${event.payload.sentenceId}:${event.payload.chunkIndex}`);
  assert.deepEqual(order, ['0:0', '0:1', '0:2', '1:0'], 'every block played once, sentence order preserved');
  assert.equal(app.players().length, expectedBlocks, 'one player per block');
  assert.equal(
    rows.filter((event) => event.type === 'voice.response.playback'
      && (event.payload.status === 'skipped-stale' || event.payload.status === 'partial')).length,
    0,
    'no block was skipped or cut',
  );
  t.diagnostic(`blocks=${order.join(',')} players=${app.players().length} groupDone=${done.groupId}`);
});

// ---------------------------------------------------------------------------
// 9. Group count and lifetime limits
// ---------------------------------------------------------------------------

test('9. group count is capped and an expired group is retained with its reason', async (t) => {
  const app = await mountVoiceRound(t, {
    config: { responseGroupMax: 2, responseGroupTtlMs: 150 },
    replyFor: ({ turn }) => `第${turn}组回答。`,
  });
  const runRound = async (text, index) => {
    app.say(text);
    await waitUntil(() => app.players().length >= index + 1, `round ${index + 1} reached the player`);
    app.resolvePlayer(index);
    await tick(20);
  };
  await runRound('第一组', 0);
  await app.waitForEvent('voice.response.group.done', (payload) => payload.groupId === 'rg-1');
  await runRound('第二组', 1);
  await app.waitForEvent('voice.response.group.done', (payload) => payload.groupId === 'rg-2');
  await runRound('第三组', 2);
  const evicted = await app.waitForEvent('voice.response.group.evicted');
  assert.equal(evicted.reason, 'limit');
  assert.ok(evicted.groups <= 2, `retained groups stay within the cap (${evicted.groups})`);

  // A pending group older than the lifetime is expired, and the next input opens a new group.
  const hold = deferred();
  state.holdTurns.set(4, hold);
  app.say('会过期的这一组');
  await waitUntil(() => app.preStep(4) !== null, 'the held group started');
  await tick(250);
  app.say('过期之后的新一组');
  const expired = await app.waitForEvent('voice.response.group.expired');
  assert.equal(expired.reason, 'ttl');
  assert.equal(expired.retained, true);
  const created = await app.waitForEvent('voice.response.group.created', (payload) => payload.reason === 'prior-expired');
  assert.ok(created.groupId.length > 0);
  hold.resolve();
  const rows = await app.events();
  assert.ok(rows.filter((event) => event.type === 'voice.response.group.created').length >= 5);
  t.diagnostic(
    `evicted=${evicted.priorState}/${evicted.reason} groups=${evicted.groups} `
    + `expired=${expired.groupId}/${expired.reason} next=${created.groupId}/${created.reason}`,
  );
});

// ---------------------------------------------------------------------------
// 10. A seven-minute gap: a new round, never a merge of the old answer
// ---------------------------------------------------------------------------

test('10. an input seven minutes later is a new round, never a merge of the old answer', async (t) => {
  // The host's store reads `Date.now()` per input. Shift that seam only while the second utterance
  // is taken, so seven minutes pass without sleeping; everything is restored right after the two
  // group events, so the rest of the round runs on the real clock.
  const realNow = Date.now;
  let skewMs = 0;
  Date.now = () => realNow() + skewMs;
  t.after(() => { Date.now = realNow; });
  const app = await mountVoiceRound(t, {
    replyFor: ({ turn }) => (turn === 1
      ? 'OBS 那轮的旧回答第一句。OBS 那轮的旧回答第二句。'
      : '切回屏幕模式的新回答。'),
  });
  app.say('OBS 全黑那轮该怎么调');
  const created = await app.waitForEvent('voice.response.group.created');
  await waitUntil(() => app.players().length === 1, 'the old answer started sounding');

  skewMs = 7 * 60_000;
  app.say('切回屏幕模式');
  let abandoned;
  let next;
  try {
    abandoned = await app.waitForEvent('voice.response.group.abandoned');
    next = await app.waitForEvent(
      'voice.response.group.created',
      (payload) => payload.groupId !== created.groupId,
    );
  } finally {
    skewMs = 0;
  }
  assert.equal(abandoned.groupId, created.groupId, 'the old group is the one abandoned');
  assert.equal(abandoned.reason, 'prior-idle');
  assert.equal(abandoned.retained, true, 'the old content is retained, never merged');
  assert.ok(
    abandoned.gapMs >= 7 * 60_000 && abandoned.gapMs < 7 * 60_000 + 5_000,
    `the gap is measured between the inputs (${abandoned.gapMs} ms)`,
  );
  assert.notEqual(next.groupId, created.groupId, 'the stale input opens a new group');
  assert.equal(next.reason, 'prior-idle');
  assert.equal(next.segments, 1, 'the new group owns only its own segment');

  await waitUntil(() => app.preStep(2) !== null, 'the new round started');
  assert.equal(app.contextMessages(2).length, 0, 'a stale input gets no continuation context');
  assert.equal(
    (await app.events()).filter((event) => event.type === 'voice.response.group.continued').length,
    0,
    'nothing from the old round was merged',
  );
  await waitUntil(() => app.players().length >= 2, 'the new answer reached the player');
  const captions = playerCaptions(app);
  assert.equal(captions[1], '切回屏幕模式的新回答。');
  assert.ok(
    !captions.slice(1).some((text) => text.includes('OBS')),
    'the old round is not summarized or replayed',
  );
  t.diagnostic(
    `old=${created.groupId}/${abandoned.reason} gap=${abandoned.gapMs}ms retained=${abandoned.retained} `
    + `new=${next.groupId} context=0 merged=0`,
  );
});

// ---------------------------------------------------------------------------
// 11. Seven minutes (store level): abandoned + retained, new group inherits nothing
// ---------------------------------------------------------------------------

test('11. a seven-minute-old group is abandoned and retained; the new group inherits nothing', (t) => {
  const { store, clock, events, abandoned } = groupStore();
  const first = openPlayingGroup(store, clock, { sessionId: 's-idle' });

  clock.t += 7 * 60_000;
  const second = store.beginInput({ sessionId: 's-idle', text: '切回屏幕模式', at: clock.t });

  assert.equal(second.continuation, false, 'a seven-minute-old expression is not continued');
  assert.equal(second.reason, 'prior-idle');
  assert.equal(second.gapMs, 7 * 60_000);
  assert.notEqual(second.group.id, first.group.id, 'the new input opens a new group');

  const row = abandoned();
  assert.equal(row.payload.groupId, first.group.id);
  assert.equal(row.payload.reason, 'prior-idle');
  assert.equal(row.payload.retained, true);
  assert.equal(row.payload.gapMs, 7 * 60_000);
  assert.equal(store.get(first.group.id).state, 'abandoned');
  assert.deepEqual(
    store.get(first.group.id).pendingSentences,
    ['旧回答第二句。'],
    'the old unvoiced sentence stays on the abandoned group',
  );
  assert.equal(store.size(), 2, 'the abandoned group is retained in the store');
  assert.equal(
    store.isCurrentAnswer(first.group, first.answerVersion),
    false,
    'an abandoned group may never open a speaker',
  );

  // The new group owns only its own input: no old segment, answer or pending sentence is merged.
  const snapshot = store.snapshot(second.group.id);
  assert.deepEqual(snapshot.segments.map((segment) => segment.text), ['切回屏幕模式']);
  assert.equal(snapshot.pending, 0);
  assert.equal(store.get(second.group.id).priorAnswer, null);
  assert.deepEqual(store.get(second.group.id).pendingSentences, []);
  const context = composeResponseGroupContext({ group: second.group, newInput: '切回屏幕模式' });
  assert.ok(!context.includes('旧回答'), 'the new group carries no earlier-round content');
  assert.equal(events.filter((event) => event.type === 'voice.response.group.continued').length, 0);
  t.diagnostic(
    `old=${first.group.id}/${row.payload.reason} gap=${row.payload.gapMs}ms retained=${row.payload.retained} `
    + `new=${second.group.id} newPending=0 merged=0`,
  );
});

// ---------------------------------------------------------------------------
// 12. Five seconds (store level): the original continuation behavior is kept
// ---------------------------------------------------------------------------

test('12. a supplement five seconds later still continues the same group', (t) => {
  const { store, clock, events } = groupStore();
  const first = openPlayingGroup(store, clock, { sessionId: 's-continue' });

  clock.t += 5_000;
  const second = store.beginInput({ sessionId: 's-continue', text: '再补充一句', at: clock.t });

  assert.equal(second.continuation, true, 'a genuine supplement inside the window still continues');
  assert.equal(second.reason, 'continue-playing');
  assert.equal(second.group.id, first.group.id);
  assert.equal(second.generation, 2);
  assert.equal(second.answerVersion, 2);
  assert.deepEqual(
    store.get(first.group.id).segments.map((segment) => segment.text),
    ['请把这一轮完整读出来', '再补充一句'],
  );
  const continued = events.find((event) => event.type === 'voice.response.group.continued');
  assert.equal(continued.payload.generation, 2);
  assert.equal(continued.payload.priorVersion, 1);
  assert.equal(continued.payload.playedSentences, 1, 'the already-played sentence is still known');
  // The continuation still speaks the old unvoiced sentence, then the new plan.
  const adjusted = store.adjustSpeech({ group: first.group, version: 2, text: '补充回答。' });
  assert.equal(adjusted.text, '旧回答第二句。补充回答。');
  t.diagnostic(
    `gap=5000ms reason=${second.reason} gen=${second.generation} speech=${adjusted.text}`,
  );
});

// ---------------------------------------------------------------------------
// 13. Twenty seconds (store level): past the default 15 s window
// ---------------------------------------------------------------------------

test('13. twenty seconds exceeds the default 15 s window and opens a new group', (t) => {
  const { store, clock, abandoned } = groupStore();
  const first = openPlayingGroup(store, clock, { sessionId: 's-20s' });
  assert.equal(CONTINUATION_MAX_GAP_MS, 15_000, 'the shipping default is 15 s');

  clock.t += 20_000;
  const second = store.beginInput({ sessionId: 's-20s', text: '再补充一句', at: clock.t });

  assert.equal(second.continuation, false);
  assert.equal(second.reason, 'prior-idle');
  assert.equal(second.gapMs, 20_000);
  assert.notEqual(second.group.id, first.group.id);
  const row = abandoned();
  assert.equal(row.payload.reason, 'prior-idle');
  assert.equal(row.payload.gapMs, 20_000);
  assert.equal(row.payload.retained, true);
  assert.equal(store.get(first.group.id).state, 'abandoned');
  assert.equal(store.get(first.group.id).pendingSentences.length, 1, 'old pending content is retained');
  assert.equal(store.get(second.group.id).pendingSentences.length, 0);
  t.diagnostic(
    `gap=${row.payload.gapMs}ms window=${CONTINUATION_MAX_GAP_MS}ms continuation=false `
    + `state=${store.get(first.group.id).state}`,
  );
});

// ---------------------------------------------------------------------------
// 14. A configured window: 30 s continues at 20 s, still ends at 30 s
// ---------------------------------------------------------------------------

test('14. a configured 30 s window continues at twenty seconds and stops just past it', (t) => {
  const { store, clock } = groupStore({ continuationMaxGapMs: 30_000 });
  const first = openPlayingGroup(store, clock, { sessionId: 's-custom' });
  clock.t += 20_000;
  const second = store.beginInput({ sessionId: 's-custom', text: '再补充一句', at: clock.t });
  assert.equal(second.continuation, true, '20 s is inside the configured window');
  assert.equal(second.group.id, first.group.id);

  // The configured window is still a hard edge.
  const edge = groupStore({ continuationMaxGapMs: 30_000 });
  const edgeFirst = openPlayingGroup(edge.store, edge.clock, { sessionId: 's-custom-edge' });
  edge.clock.t += 30_001;
  const last = edge.store.beginInput({ sessionId: 's-custom-edge', text: '再补充一句', at: edge.clock.t });
  assert.equal(last.continuation, false);
  assert.equal(last.reason, 'prior-idle');
  assert.notEqual(last.group.id, edgeFirst.group.id);
  assert.equal(edge.abandoned().payload.gapMs, 30_001);
  t.diagnostic(
    `window=30000ms gap=20000ms -> ${second.reason}; edge=30001ms -> ${last.reason}`,
  );
});

// ---------------------------------------------------------------------------
// 15. A topic switch inside the window still does not merge (existing logic kept)
// ---------------------------------------------------------------------------

test('15. a topic switch inside the window does not merge and still names the switch', (t) => {
  const { store, clock, events, abandoned } = groupStore();
  const first = openPlayingGroup(store, clock, { sessionId: 's-topic' });

  clock.t += 3_000; // inside the default window: the switch, not the gap, decides
  const second = store.beginInput({
    sessionId: 's-topic', text: '换个话题，明天天气怎么样', at: clock.t,
  });

  assert.equal(second.continuation, false);
  assert.equal(second.reason, 'topic-switch');
  const row = abandoned();
  assert.equal(row.payload.groupId, first.group.id);
  assert.equal(row.payload.reason, 'topic-switch');
  assert.equal(row.payload.retained, true);
  assert.equal(store.get(first.group.id).pendingSentences.length, 1, 'the old pending content is retained');
  assert.equal(store.get(second.group.id).pendingSentences.length, 0, 'no old content is carried over');
  assert.deepEqual(
    store.get(second.group.id).segments.map((segment) => segment.text),
    ['换个话题，明天天气怎么样'],
  );
  assert.equal(events.filter((event) => event.type === 'voice.response.group.continued').length, 0);
  t.diagnostic(
    `gap=3000ms reason=${second.reason} old=${row.payload.groupId}/retained true newPending=0`,
  );
});

// ---------------------------------------------------------------------------
// 16. An explicit continuation two seconds later still merges
// ---------------------------------------------------------------------------

test('16. an explicit continuation ("还有/补充") two seconds later still merges', (t) => {
  const { store, clock, events } = groupStore();
  const first = openPlayingGroup(store, clock, { sessionId: 's-cont' });

  clock.t += 2_000; // inside the window AND phrased as a continuation
  const second = store.beginInput({ sessionId: 's-cont', text: '还有，再补充一句', at: clock.t });

  assert.equal(second.continuation, true, 'a genuine continuation inside the window merges');
  assert.equal(second.reason, 'continue-playing');
  assert.equal(second.group.id, first.group.id);
  assert.equal(second.generation, 2);
  assert.equal(second.answerVersion, 2);
  const continued = events.find((event) => event.type === 'voice.response.group.continued');
  assert.equal(continued.payload.generation, 2);
  assert.equal(continued.payload.priorVersion, 1);
  assert.equal(continued.payload.playedSentences, 1, 'the already-played sentence is still known');
  // The continuation speaks the old unvoiced sentence, then the new plan.
  const adjusted = store.adjustSpeech({ group: first.group, version: 2, text: '新增回答。' });
  assert.equal(adjusted.text, '旧回答第二句。新增回答。');
  t.diagnostic(`gap=2000ms reason=${second.reason} gen=${second.generation} speech=${adjusted.text}`);
});

// ---------------------------------------------------------------------------
// 17. A new instruction two seconds later opens a new group (window is not sufficient)
// ---------------------------------------------------------------------------

test('17. a new instruction two seconds later opens a new group even with a backlog', (t) => {
  const rows = [];
  for (const input of ['切回屏幕模式', '打开 OBS 看看']) {
    const { store, clock, events, abandoned } = groupStore();
    const first = openPlayingGroup(store, clock, { sessionId: `s-instr-${rows.length}` });
    clock.t += 2_000; // deliberately inside the 15 s window
    const second = store.beginInput({ sessionId: `s-instr-${rows.length}`, text: input, at: clock.t });

    assert.equal(second.continuation, false, `${input} is a new instruction, never a continuation`);
    assert.equal(second.reason, 'new-instruction');
    assert.notEqual(second.group.id, first.group.id, 'a new group is created');
    const row = abandoned();
    assert.equal(row.payload.groupId, first.group.id);
    assert.equal(row.payload.reason, 'new-instruction');
    assert.equal(store.get(first.group.id).pendingSentences.length, 1, 'old unvoiced content is retained');
    assert.equal(store.get(second.group.id).pendingSentences.length, 0, 'nothing is inherited');
    assert.equal(events.filter((event) => event.type === 'voice.response.group.continued').length, 0);
    rows.push(`${input}:${second.reason}/${row.payload.reason}`);
  }
  t.diagnostic(`2s instructions -> ${rows.join(' | ')} (window alone never merges)`);
});

// ---------------------------------------------------------------------------
// 18. Text done + speech incomplete is speechPending, never inherited
// ---------------------------------------------------------------------------

test('18. answer text done but speech incomplete becomes speechPending and never enters a new group', (t) => {
  const { store, clock, events } = groupStore();
  const first = openPlayingGroup(store, clock, { sessionId: 's-pending' });

  clock.t += 2_000;
  const second = store.beginInput({ sessionId: 's-pending', text: '切回屏幕模式', at: clock.t });
  assert.equal(second.continuation, false);

  const pending = events.find((event) => event.type === 'voice.response.group.speech-pending');
  assert.ok(pending !== undefined, 'the unanswered-speech state is reported');
  assert.equal(pending.payload.groupId, first.group.id);
  assert.equal(pending.payload.sentences, 1);
  assert.equal(pending.payload.chars, '旧回答第二句。'.length);
  assert.equal(pending.payload.answerVersion, 1);

  const old = store.get(first.group.id);
  assert.equal(old.state, 'abandoned', 'the old group is retired, not revived');
  assert.deepEqual(old.speechPending.sentences, ['旧回答第二句。'], 'the answered text is kept as speechPending');
  assert.equal(old.speechPending.reason, 'new-instruction');

  // The new group owns only its own input and spoken plan.
  const snapshot = store.snapshot(second.group.id);
  assert.deepEqual(snapshot.segments.map((segment) => segment.text), ['切回屏幕模式']);
  assert.equal(snapshot.pending, 0);
  assert.equal(snapshot.speechPending, null);
  assert.equal(store.get(second.group.id).priorAnswer, null);
  const context = composeResponseGroupContext({ group: second.group, newInput: '切回屏幕模式' });
  assert.ok(!context.includes('旧回答'), 'the old answer is not in the new group\'s context');
  const adjusted = store.adjustSpeech({ group: second.group, version: 1, text: '屏幕模式的新回答。' });
  assert.equal(adjusted.text, '屏幕模式的新回答。', 'the old speech is not prepended to the new group');
  assert.equal(adjusted.unplayedPrior.length, 0);
  t.diagnostic(
    `old=${first.group.id} speechPending=${pending.payload.sentences}句/${pending.payload.chars}字 `
    + `new=${second.group.id} inherited=0`,
  );
});

// ---------------------------------------------------------------------------
// 19. "接着播/继续" restores speechPending; nothing else does
// ---------------------------------------------------------------------------

test('19. only an explicit "接着播/继续" restores speechPending content', (t) => {
  const { store, clock, events } = groupStore();
  const first = openPlayingGroup(store, clock, { sessionId: 's-resume' });

  clock.t += 2_000;
  const second = store.beginInput({ sessionId: 's-resume', text: '切回屏幕模式', at: clock.t });
  assert.equal(second.continuation, false, 'a new instruction does not resume the old content');

  // An ordinary, unrelated request while speechPending exists must not restore it either.
  clock.t += 2_000;
  const third = store.beginInput({ sessionId: 's-resume', text: '明天天气怎么样', at: clock.t });
  assert.equal(third.continuation, false, 'a normal new question does not resume pending speech');
  assert.notEqual(third.group.id, first.group.id);
  assert.deepEqual(store.get(first.group.id).speechPending.sentences, ['旧回答第二句。'], 'still waiting');

  // Only the explicit request restores it, and the restored version precedes the new answer.
  clock.t += 2_000;
  const resumed = store.beginInput({ sessionId: 's-resume', text: '接着播，继续', at: clock.t });
  assert.equal(resumed.continuation, true);
  assert.equal(resumed.reason, 'resume-pending');
  assert.equal(resumed.group.id, first.group.id, 'the old group is the one resumed');
  assert.equal(resumed.generation, 2);
  assert.equal(resumed.priorVersion, 1);
  assert.equal(store.get(first.group.id).speechPending, null, 'resuming clears the pending marker');
  assert.equal(events.filter((event) => event.type === 'voice.response.group.continued').length, 1);
  const adjusted = store.adjustSpeech({ group: first.group, version: 2, text: '补充回答。' });
  assert.equal(adjusted.text, '旧回答第二句。补充回答。', 'the unplayed old sentence is restored first');
  assert.deepEqual(store.get(third.group.id).speechPending, null, 'other groups are untouched');
  t.diagnostic(
    `newInstruction=${second.reason} normal=${third.reason} resume=${resumed.reason} `
    + `restored=${adjusted.text}`,
  );
});

// ---------------------------------------------------------------------------
// 20. A superseded group's late result never mixes into the new group
// ---------------------------------------------------------------------------

test('20. a superseded group\'s late body/plan/playback never mixes into the new group', (t) => {
  const { store, clock } = groupStore();
  const first = openPlayingGroup(store, clock, { sessionId: 's-late' });

  clock.t += 2_000;
  const second = store.beginInput({ sessionId: 's-late', text: '切回屏幕模式', at: clock.t });
  assert.equal(second.continuation, false);

  // The old turn's result arrives after its group was retired.
  store.noteAnswerBody({
    group: first.group, version: 1, turn: 1, text: '迟到的旧正文。',
  });
  store.noteAnswerPlan({
    group: first.group, version: 1, turn: 1, text: '迟到的旧口语。', feedText: '迟到的旧正文。',
  });
  store.notePlaybackStart({
    group: first.group, version: 1, sentenceId: 9, text: '迟到的旧句。',
  });

  assert.equal(store.get(first.group.id).state, 'abandoned', 'the old group is not revived by late output');
  assert.equal(store.isCurrentAnswer(first.group, 1), false, 'the old version may never open a speaker');
  const snapshot = store.snapshot(second.group.id);
  assert.deepEqual(snapshot.segments.map((segment) => segment.text), ['切回屏幕模式']);
  assert.equal(snapshot.pending, 0);
  assert.equal(snapshot.played.length, 0, 'the old late playback never counts for the new group');
  assert.equal(store.get(second.group.id).priorAnswer, null);
  assert.deepEqual(store.get(second.group.id).pendingSentences, []);
  const context = composeResponseGroupContext({ group: second.group, newInput: '切回屏幕模式' });
  assert.ok(!context.includes('迟到'), 'the new group never sees the late result');
  t.diagnostic(
    `old=${first.group.id}/abandoned lateBody=kept new=${second.group.id} mixed=0 stolen=0`,
  );
});

// ---------------------------------------------------------------------------
// 21. B: never-spoken points are carried; a sounded round is never auto-carried
// ---------------------------------------------------------------------------

test('21. never-spoken points are carried into the next speech; a sounded round is not', (t) => {
  const { store, clock, events } = groupStore();
  const first = openNeverPlayedGroup(store, clock, { sessionId: 's-carry' });
  const carriedPlan = '旧回答第一句。旧回答第二句。';

  clock.t += 5_000;
  const second = store.beginInput({ sessionId: 's-carry', text: '补充一下，那个采集源呢', at: clock.t });
  assert.equal(second.continuation, true, 'a same-topic supplement still continues the group');
  const carry = events.find((row) => row.type === 'voice.carry.convey');
  assert.ok(carry !== undefined, 'the carry decision is reported');
  assert.equal(carry.payload.merged, true);
  assert.equal(carry.payload.reason, 'same-topic');
  assert.equal(carry.payload.priorGroupId, first.group.id);
  assert.equal(carry.payload.sentences, 2);
  assert.equal(carry.payload.chars, carriedPlan.length);
  assert.equal(carry.payload.gapMs, 5_000);

  // The organizer gets the points and says them; adjustSpeech must not prepend them a second time.
  const carried = store.carryForSpeech(second.group, second.answerVersion);
  assert.deepEqual(carried.sentences, ['旧回答第一句。', '旧回答第二句。']);
  assert.equal(carried.chars, carriedPlan.length);
  const adjusted = store.adjustSpeech({ group: second.group, version: 2, text: '新的口语版。' });
  assert.equal(adjusted.carried, true);
  assert.deepEqual(adjusted.prepended, []);
  assert.equal(adjusted.text, '新的口语版。');
  assert.equal(store.carryForSpeech(second.group, 1), null, 'the carry belongs to one answer version only');

  // A round that already sounded is never auto-carried, even with unvoiced content left.
  const played = openPlayingGroup(store, clock, { sessionId: 's-carry-played' });
  clock.t += 2_000;
  const next = store.beginInput({ sessionId: 's-carry-played', text: '采集源还是黑的', at: clock.t });
  const refused = events.filter((row) => row.type === 'voice.carry.convey').at(-1);
  assert.equal(refused.payload.merged, false);
  assert.equal(refused.payload.reason, 'prior-played');
  assert.equal(store.get(next.group.id).carryConvey, null);
  assert.equal(store.carryForSpeech(next.group, next.answerVersion), null);
  // The old group still owns its unvoiced tail as speechPending (explicit resume only).
  assert.deepEqual(store.get(played.group.id).speechPending.sentences, ['旧回答第二句。']);
  assert.equal(store.get(played.group.id).speechStarted, true);
  t.diagnostic(
    `carried=${carry.payload.sentences}句/${carry.payload.chars}字 gap=${carry.payload.gapMs}ms merged=true; `
    + `playedRound merged=${refused.payload.merged} reason=${refused.payload.reason}`,
  );
});

// ---------------------------------------------------------------------------
// 22. P2-1: a third input before B's plan keeps A's points in C's carry
// ---------------------------------------------------------------------------

test('22. A -> B -> C keeps the never-spoken A points when B\'s spoken plan is still missing', (t) => {
  const { store, clock, events } = groupStore();
  const A = '第一轮结论：窗口采集要选中目标窗口。第一轮条件：如果还黑屏就先别删场景。';
  const B = '第二轮正文：先确认采集源类型是窗口采集。';
  const first = store.beginInput({ sessionId: 's-carry-abc', text: 'OBS 全黑怎么调', at: clock.t });
  store.noteAnswerPlan({ group: first.group, version: 1, text: A });
  store.adjustSpeech({ group: first.group, version: 1, text: A });
  assert.equal(store.get(first.group.id).speechStarted, false, 'A never started sounding');

  clock.t += 2_000;
  const second = store.beginInput({ sessionId: 's-carry-abc', text: '补充一下，那采集源呢', at: clock.t });
  assert.equal(second.continuation, true);
  assert.equal(second.answerVersion, 2);
  // B's body is ready, but its spoken organization has not returned yet.
  store.noteAnswerBody({ group: first.group, version: 2, turn: 2, text: B });

  clock.t += 2_000;
  const third = store.beginInput({ sessionId: 's-carry-abc', text: '再补充一句，那编码器呢', at: clock.t });
  assert.equal(third.continuation, true);
  assert.equal(third.answerVersion, 3);
  const carryRow = events.filter((row) => row.type === 'voice.carry.convey').at(-1);
  assert.equal(carryRow.payload.merged, true);
  assert.equal(carryRow.payload.sentences, 3, 'two A points plus B\'s body are inherited by C');
  const carry = store.carryForSpeech(first.group, 3);
  assert.deepEqual(carry.sentences, [
    '第一轮结论：窗口采集要选中目标窗口。',
    '第一轮条件：如果还黑屏就先别删场景。',
    B,
  ]);
  assert.equal(carry.sentences.filter((row) => row.includes('要选中目标窗口')).length, 1, 'A appears exactly once');

  // C's spoken plan conveys every point; the fulfilled carry is consumed and cleared.
  const cPlan = `${A}${B}第三轮补充：编码器用硬件编码。`;
  const adjusted = store.adjustSpeech({ group: first.group, version: 3, text: cPlan });
  assert.equal(adjusted.carried, true);
  assert.equal(adjusted.text, cPlan);
  const pendingText = store.get(first.group.id).pendingSentences.join('');
  assert.equal((pendingText.match(/窗口采集要选中目标窗口/gu) ?? []).length, 1, 'said once, never duplicated');
  assert.equal(store.get(first.group.id).carryConvey, null, 'a fulfilled carry is cleared');
  assert.equal(store.carryForSpeech(first.group, 3), null);
  t.diagnostic(
    `A=2句 B=1句 Ccarry=${carryRow.payload.sentences}句/${carryRow.payload.chars}字 `
    + `repeated=0 fulfilled=cleared`,
  );
});

// ---------------------------------------------------------------------------
// 23. P2-1: points that already played are never carried into a later round
// ---------------------------------------------------------------------------

test('23. a fully played round contributes no carry to the next round', (t) => {
  const { store, clock, events } = groupStore();
  const plan = '旧回答第一句。旧回答第二句。';
  const first = store.beginInput({ sessionId: 's-carried-played', text: 'OBS 全黑怎么调', at: clock.t });
  store.noteAnswerPlan({ group: first.group, version: 1, text: plan });
  store.adjustSpeech({ group: first.group, version: 1, text: plan });
  for (let index = 0; index < 2; index += 1) {
    const sentence = splitSpeechSentences(plan)[index];
    store.notePlaybackStart({ group: first.group, version: 1, sentenceId: index, text: sentence });
    store.notePlaybackEnd({
      group: first.group, version: 1, sentenceId: index, chunkIndex: 0, chunkCount: 1,
      status: 'completed', text: sentence,
    });
  }
  assert.equal(store.get(first.group.id).state, 'done', 'the whole answer really played');

  clock.t += 2_000;
  const second = store.beginInput({ sessionId: 's-carried-played', text: '再补充一句', at: clock.t });
  assert.equal(second.continuation, false, 'a finished round is a new round');
  assert.equal(second.reason, 'prior-done');
  assert.equal(
    events.filter((row) => row.type === 'voice.carry.convey').length,
    0,
    'nothing unplayed is left, so no carry decision exists',
  );
  assert.equal(store.get(second.group.id).carryConvey, null);
  assert.deepEqual(store.get(second.group.id).pendingSentences, []);
  t.diagnostic('played=2/2 carryRows=0 newCarry=null pending=0');
});

// ---------------------------------------------------------------------------
// 24. P2-2: budget shortage - the new conclusion plays, old points stay pending
// ---------------------------------------------------------------------------

test('24. a 1158-char carry plus a 106-char conclusion with a failed organizer keeps the conclusion', (t) => {
  const { store, clock, events } = groupStore();
  const head1 = '旧要点一：先确认采集源类型。';
  const head2 = '旧要点二：窗口采集要选中目标窗口。';
  const head3 = '旧要点三：如果还黑屏就点开采集属性确认一次';
  const oldText = `${head1}${head2}${head3}${'旧'.repeat(1158 - head1.length - head2.length - head3.length - 1)}。`;
  const newHead = '新结论：把编码器改成硬件编码，然后重启一次采集，画面就会出来';
  const newText = `${newHead}${'了'.repeat(106 - newHead.length - 1)}。`;
  assert.equal(oldText.length, 1158, 'fixture: three old sentences total 1158 chars');
  assert.equal(splitSpeechSentences(oldText).length, 3);
  assert.equal(newText.length, 106, 'fixture: the new conclusion is 106 chars');

  const first = store.beginInput({ sessionId: 's-budget', text: 'OBS 全黑怎么调', at: clock.t });
  store.noteAnswerPlan({ group: first.group, version: 1, text: oldText });
  store.adjustSpeech({ group: first.group, version: 1, text: oldText });
  clock.t += 2_000;
  const second = store.beginInput({ sessionId: 's-budget', text: '补充一下，那编码器呢', at: clock.t });
  assert.equal(second.continuation, true);
  store.noteAnswerBody({ group: first.group, version: 2, turn: 2, text: newText });

  // The organizer was unavailable: the budget-aware fallback keeps the current answer whole.
  const fallback = composeCarryConveyFallback(oldText, newText, { maxChars: 1200 });
  assert.equal(fallback.merged, false);
  assert.equal(fallback.text, newText, 'the 106-char conclusion is the whole fallback plan');
  assert.equal(fallback.pending.join(''), oldText, 'all old points stay pending, uncut');
  store.deferCarry({ group: first.group, version: 2, sentences: fallback.pending });
  const deferRow = events.filter((row) => row.type === 'voice.carry.convey').at(-1);
  assert.equal(deferRow.payload.deferred, 3, 'the report counts the deferred points');
  assert.equal(deferRow.payload.superseded, 0, 'nothing was corrected, so nothing is superseded');
  assert.equal(deferRow.payload.reason, 'budget-deferred');
  const adjusted = store.adjustSpeech({ group: first.group, version: 2, text: fallback.text });
  assert.equal(adjusted.text, newText, 'the old points are never prepended');
  assert.equal(adjusted.deferred, true, 'the carry is explicitly deferred, not fulfilled');
  const retained = store.carryForSpeech(first.group, 2);
  assert.deepEqual(retained.sentences, splitSpeechSentences(oldText), 'old points remain as 待传达');

  // What actually plays is the new conclusion only.
  store.notePlaybackStart({ group: first.group, version: 2, sentenceId: 0, text: newText });
  const played = store.get(first.group.id).played;
  assert.deepEqual(played, [newText]);
  assert.ok(!played.join('').includes('旧要点'), 'no old sentence is played');
  assert.equal(store.carryForSpeech(first.group, 2).sentences.join(''), oldText);

  // The fallback answer played, but the deferred points were never in a plan: a later same-topic
  // round still inherits them, exactly once.
  store.notePlaybackEnd({
    group: first.group, version: 2, sentenceId: 0, chunkIndex: 0, chunkCount: 1,
    status: 'completed', text: newText,
  });
  assert.equal(store.get(first.group.id).state, 'done');
  clock.t += 2_000;
  const later = store.beginInput({ sessionId: 's-budget', text: '再补充一句，那显示器呢', at: clock.t });
  const laterCarry = store.carryForSpeech(later.group, later.answerVersion);
  assert.ok(laterCarry !== null, 'the deferred points survive the played fallback');
  assert.deepEqual(laterCarry.sentences, splitSpeechSentences(oldText));
  const laterPlan = `${oldText}第四轮补充：显示器接电就行。`;
  const laterAdjusted = store.adjustSpeech({ group: later.group, version: later.answerVersion, text: laterPlan });
  assert.equal(laterAdjusted.carried, true);
  assert.equal((laterAdjusted.text.match(/旧要点一/gu) ?? []).length, 1, 'each point is spoken at most once');
  t.diagnostic(
    `old=${oldText.length}字/3句 new=${newText.length}字/1句 budget=1200 fallback=new-only `
    + `played=1 oldPlayed=0 pending=${retained.sentences.length}句 laterCarry=${laterCarry.sentences.length}句`,
  );
});

// ---------------------------------------------------------------------------
// 25. P2-2: a correction in the new answer wins over the old conclusion
// ---------------------------------------------------------------------------

test('25. a correcting new conclusion is spoken and the old conclusion is superseded', (t) => {
  const oldText = '旧结论：先重启软件。条件：不要先删除场景。';
  const newText = '更正：不是先重启软件，而是先换一个采集源。';
  const fallback = composeCarryConveyFallback(oldText, newText, { maxChars: 1200 });
  assert.equal(fallback.merged, false);
  assert.equal(fallback.text, newText, 'the correction is the spoken version');
  assert.ok(!fallback.text.includes('旧结论'), 'the old conclusion is not repeated');
  assert.deepEqual(fallback.pending, [], 'a corrected point is NOT deferred: it must never carry again');
  assert.deepEqual(
    fallback.superseded,
    ['旧结论：先重启软件。', '条件：不要先删除场景。'],
    'the whole old carry is retired',
  );
  assert.equal(fallback.reason, 'superseded');
  t.diagnostic(
    `old="${oldText}" new="${fallback.text}" oldConclusionSpoken=no `
    + `superseded=${fallback.superseded.length}句 deferred=${fallback.pending.length}句`,
  );
});

// ---------------------------------------------------------------------------
// 26. P2-2: enough budget keeps the original merge (old points still ride along)
// ---------------------------------------------------------------------------

test('26. when the budget is sufficient the old points still merge (original behavior kept)', (t) => {
  const oldText = '旧要点一：先确认采集源。旧要点二：再看编码器。';
  const newText = '新结论：窗口采集已经能看到画面。';
  const fallback = composeCarryConveyFallback(oldText, newText, { maxChars: 1200 });
  assert.equal(fallback.merged, true);
  assert.equal(fallback.text, `${oldText}${newText}`);
  assert.deepEqual(fallback.pending, []);
  assert.equal(fallback.text, composeCarryConveyText(oldText, newText), 'the original merge is unchanged');
  t.diagnostic(
    `old=${oldText.length}字 new=${newText.length}字 budget=1200 merged=yes pending=0`,
  );
});

// ---------------------------------------------------------------------------
// 27. P2: a corrected point is superseded (not deferred) and never comes back
// ---------------------------------------------------------------------------

test('27. A -> correcting B -> C fallback never revives the corrected A point', (t) => {
  const { store, clock, events } = groupStore();
  const A = '先重启软件。';
  const B = '更正：不要重启软件，先换一个采集源。';
  const C = '确认采集源的目标窗口即可。';
  const first = store.beginInput({ sessionId: 's-superseded', text: 'OBS 全黑怎么调', at: clock.t });
  store.noteAnswerPlan({ group: first.group, version: 1, text: A });
  store.adjustSpeech({ group: first.group, version: 1, text: A });
  assert.equal(store.get(first.group.id).speechStarted, false, 'A never sounded');

  clock.t += 2_000;
  const second = store.beginInput({ sessionId: 's-superseded', text: '补充一下，那采集源呢', at: clock.t });
  assert.equal(second.continuation, true);
  assert.deepEqual(store.carryForSpeech(second.group, 2).sentences, [A], 'A is the carry material for B');

  store.noteAnswerBody({ group: second.group, version: 2, text: B });
  const fallback = composeCarryConveyFallback(A, B, { maxChars: 1200 });
  assert.equal(fallback.merged, false);
  assert.deepEqual(fallback.superseded, [A], 'the corrected A point is superseded, not deferred');
  assert.deepEqual(fallback.pending, [], 'nothing is deferred: a superseded point never carries again');

  // index.js order: supersede BEFORE adjustSpeech, so no old point can be prepended.
  store.supersedeCarry({
    group: second.group, version: 2, sentences: fallback.superseded, reason: fallback.reason,
  });
  const row = events.filter((event) => event.type === 'voice.carry.convey').at(-1);
  assert.equal(row.payload.superseded, 1, 'the event reports the retired count');
  assert.equal(row.payload.deferred, 0);
  assert.equal(store.carryForSpeech(second.group, 2), null, 'the carry pool is empty');
  assert.deepEqual(store.snapshot(second.group.id).supersededCarry, [A], 'kept as internal history only');

  const adjusted = store.adjustSpeech({ group: second.group, version: 2, text: fallback.text });
  assert.equal(adjusted.text, B, 'the correction is the whole plan: the old point is not prepended');
  store.notePlaybackStart({ group: second.group, version: 2, sentenceId: 0, text: B });
  store.notePlaybackEnd({
    group: second.group, version: 2, sentenceId: 0, chunkIndex: 0, chunkCount: 1, status: 'completed', text: B,
  });
  assert.deepEqual(store.get(second.group.id).played, [B], 'exactly the correction played');
  assert.equal(store.get(second.group.id).state, 'done');

  // C: same topic, organizer failed, no carry left anywhere.
  clock.t += 2_000;
  const third = store.beginInput({ sessionId: 's-superseded', text: '再补充一句，那窗口呢', at: clock.t });
  assert.equal(store.carryForSpeech(third.group, third.answerVersion), null, 'C inherits nothing');
  assert.deepEqual(store.get(third.group.id).pendingSentences, []);
  const cFallback = composeCarryConveyFallback('', C, { maxChars: 1200 });
  assert.equal(cFallback.text, C, 'C only speaks its own body');
  assert.ok(!cFallback.text.includes('先重启软件'), 'the corrected A point never returns');
  t.diagnostic(
    `A="${A}" B="${B}" superseded=${row.payload.superseded} deferred=${row.payload.deferred} `
    + `Bplayed="${B}" Ccarry=0 Cplayed="${cFallback.text}" staleReplay=0`,
  );
});

// ---------------------------------------------------------------------------
// 28. P2: an ambiguous contradiction (no correction word) carries nothing
// ---------------------------------------------------------------------------

test('28. an ambiguous contradiction without a correction word is never carried', (t) => {
  const oldText = '先重启软件。';
  const newText = '其实不用重启软件，先换一个采集源。';
  assert.ok(!/(?:更正|纠正|改为|以[^。！？；;]{0,12}为准)/u.test(newText), 'fixture: no explicit correction word');
  const fallback = composeCarryConveyFallback(oldText, newText, { maxChars: 1200 });
  assert.equal(fallback.merged, false, 'validity is unconfirmed: no merge');
  assert.equal(fallback.text, newText, 'only the current answer is played');
  assert.deepEqual(fallback.pending, [], 'the old point is not deferred either');
  assert.deepEqual(fallback.superseded, [oldText]);
  assert.equal(fallback.reason, 'unconfirmed');

  const { store, clock } = groupStore();
  const first = openNeverPlayedGroup(store, clock, { sessionId: 's-ambiguous', plan: oldText });
  clock.t += 2_000;
  const second = store.beginInput({ sessionId: 's-ambiguous', text: '补充一下，那采集源呢', at: clock.t });
  store.supersedeCarry({ group: second.group, version: 2, sentences: fallback.superseded, reason: fallback.reason });
  store.adjustSpeech({ group: second.group, version: 2, text: fallback.text });
  assert.ok(
    !store.get(first.group.id).pendingSentences.some((sentence) => sentence.includes('先重启软件')),
    'pending excludes the unconfirmed old point',
  );
  assert.equal(store.carryForSpeech(second.group, 2), null);
  t.diagnostic(
    `old="${oldText}" new="${newText}" correctionWord=no merged=${fallback.merged} `
    + `played="${fallback.text}" pending=0 carry=null`,
  );
});

// ---------------------------------------------------------------------------
// 29. P2: a late version-2 supersede never clears version 3's carry
// ---------------------------------------------------------------------------

test('29. a late version-2 supersede is refused and version 3 keeps its carry', (t) => {
  const A1 = '第一轮结论：窗口采集要选中目标窗口。';
  const A2 = '第一轮条件：如果还黑屏就先别删场景。';
  const B = '第二轮正文：先确认采集源类型是窗口采集。';

  /**
   * A never sounded, B's body is ready but its spoken plan is still missing, C opens version 3:
   * exactly the counterexample where B's late organizer result must not retire C's points.
   */
  const openToVersionThree = (sessionId) => {
    const { store, clock, events } = groupStore();
    const first = store.beginInput({ sessionId, text: 'OBS 全黑怎么调', at: clock.t });
    store.noteAnswerPlan({ group: first.group, version: 1, text: `${A1}${A2}` });
    store.adjustSpeech({ group: first.group, version: 1, text: `${A1}${A2}` });
    assert.equal(store.get(first.group.id).speechStarted, false, 'A never started sounding');

    clock.t += 2_000;
    const second = store.beginInput({ sessionId, text: '补充一下，那采集源呢', at: clock.t });
    assert.equal(second.answerVersion, 2);
    // B's body is ready, but its spoken organization has not returned yet.
    store.noteAnswerBody({ group: second.group, version: 2, text: B });

    clock.t += 2_000;
    const third = store.beginInput({ sessionId, text: '再补充一句，那编码器呢', at: clock.t });
    assert.equal(third.answerVersion, 3);
    return { store, clock, events, group: third.group };
  };

  const { store, events, group } = openToVersionThree('s-stale-v2');
  const carryBefore = store.snapshot(group.id).carryConvey;
  assert.equal(carryBefore.version, 3, 'C owns a fresh carry for version 3');
  assert.deepEqual(carryBefore.sentences, [A1, A2, B]);
  const pendingBefore = [...store.get(group.id).pendingSentences];
  assert.deepEqual(pendingBefore, [A1, A2, B]);

  // B's organizer finally returns (version 2) and reports a correction of A1.
  const refused = store.supersedeCarry({ group, version: 2, sentences: [A1], reason: 'superseded' });
  assert.deepEqual(refused, { ok: false, reason: 'stale-version' });
  assert.deepEqual(store.snapshot(group.id).carryConvey, carryBefore, 'version 3 carry is untouched');
  assert.deepEqual(store.get(group.id).pendingSentences, pendingBefore, 'version 3 pending is untouched');
  assert.deepEqual(store.get(group.id).supersededCarry, [], 'nothing was retired by the stale result');
  assert.deepEqual(store.carryForSpeech(group, 3).sentences, [A1, A2, B]);
  const staleRow = events.filter((row) => row.type === 'voice.carry.convey').at(-1).payload;
  assert.equal(staleRow.staleVersionRejected, true, 'the refusal is reported');
  assert.equal(staleRow.reason, 'stale-version');
  assert.equal(staleRow.answerVersion, 2);
  assert.equal(staleRow.currentVersion, 3);
  assert.equal(staleRow.superseded, 0, 'a refused retirement reports no retired point');

  // A correction inside version 3 still retires its own point normally.
  const applied = store.supersedeCarry({ group, version: 3, sentences: [A1], reason: 'superseded' });
  assert.equal(applied.ok, true);
  assert.deepEqual(store.get(group.id).supersededCarry, [A1]);
  assert.deepEqual(store.get(group.id).pendingSentences, [A2, B]);
  assert.deepEqual(store.snapshot(group.id).carryConvey.sentences, [A2, B]);
  const retiredRow = events.filter((row) => row.type === 'voice.carry.convey').at(-1).payload;
  assert.equal(retiredRow.superseded, 1, 'an in-version correction still retires');
  assert.equal(retiredRow.answerVersion, 3);
  t.diagnostic(
    `v3carry=${carryBefore.sentences.length}句 stale(v2) rejected=${refused.reason} `
    + `carryAfterStale=${carryBefore.sentences.length}句 pendingAfterStale=${pendingBefore.length}句 `
    + `sameVersionSuperseded=${retiredRow.superseded} carryLeft=${store.snapshot(group.id).carryConvey.sentences.length}句`,
  );
});

// ---------------------------------------------------------------------------
// 30. P2: a late version-3 supersede is refused once version 4 is current
// ---------------------------------------------------------------------------

test('30. a late version-3 supersede is refused once version 4 is current', (t) => {
  const A1 = '第一轮结论：窗口采集要选中目标窗口。';
  const A2 = '第一轮条件：如果还黑屏就先别删场景。';
  const B = '第二轮正文：先确认采集源类型是窗口采集。';
  const C = '第三轮正文：编码器改成硬件编码。';
  const { store, clock, events } = groupStore();
  const sessionId = 's-stale-v3';
  const first = store.beginInput({ sessionId, text: 'OBS 全黑怎么调', at: clock.t });
  store.noteAnswerPlan({ group: first.group, version: 1, text: `${A1}${A2}` });
  store.adjustSpeech({ group: first.group, version: 1, text: `${A1}${A2}` });
  clock.t += 2_000;
  const second = store.beginInput({ sessionId, text: '补充一下，那采集源呢', at: clock.t });
  store.noteAnswerBody({ group: second.group, version: 2, text: B });
  clock.t += 2_000;
  const third = store.beginInput({ sessionId, text: '再补充一句，那编码器呢', at: clock.t });
  store.noteAnswerBody({ group: third.group, version: 3, text: C });
  clock.t += 2_000;
  const fourth = store.beginInput({ sessionId, text: '再补充一句，那显示器呢', at: clock.t });
  assert.equal(fourth.answerVersion, 4);
  const carryBefore = store.snapshot(fourth.group.id).carryConvey;
  assert.equal(carryBefore.version, 4);
  assert.ok(carryBefore.sentences.includes(A1), 'version 4 still owns the never-spoken A points');
  const pendingBefore = [...store.get(fourth.group.id).pendingSentences];

  // Version 3's organizer returns late and reports a correction: version 4 must keep everything.
  const refused = store.supersedeCarry({ group: fourth.group, version: 3, sentences: [A1] });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'stale-version');
  assert.deepEqual(store.snapshot(fourth.group.id).carryConvey, carryBefore);
  assert.deepEqual(store.get(fourth.group.id).pendingSentences, pendingBefore);
  assert.deepEqual(store.get(fourth.group.id).supersededCarry, []);
  const staleRow = events.filter((row) => row.type === 'voice.carry.convey').at(-1).payload;
  assert.equal(staleRow.staleVersionRejected, true);
  assert.equal(staleRow.answerVersion, 3);
  assert.equal(staleRow.currentVersion, 4);
  assert.equal(staleRow.superseded, 0);

  // Version 4 may still retire its own point.
  const applied = store.supersedeCarry({ group: fourth.group, version: 4, sentences: [A1] });
  assert.equal(applied.ok, true);
  assert.deepEqual(store.get(fourth.group.id).supersededCarry, [A1]);
  assert.ok(
    !store.snapshot(fourth.group.id).carryConvey.sentences.includes(A1),
    'the in-version correction trims version 4 only',
  );
  t.diagnostic(
    `v4carry=${carryBefore.sentences.length}句 stale(v3) rejected=${refused.reason} `
    + `pendingKept=${pendingBefore.length}句 current(v4) superseded=1`,
  );
});

// ---------------------------------------------------------------------------
// 31. P2: a stale defer never writes the current version's carry
// ---------------------------------------------------------------------------

test('31. a stale defer is refused and never overwrites the current version\'s carry', (t) => {
  const A1 = '第一轮结论：窗口采集要选中目标窗口。';
  const A2 = '第一轮条件：如果还黑屏就先别删场景。';
  const B = '第二轮正文：先确认采集源类型是窗口采集。';
  const { store, clock, events } = groupStore();
  const sessionId = 's-stale-defer';
  const first = store.beginInput({ sessionId, text: 'OBS 全黑怎么调', at: clock.t });
  store.noteAnswerPlan({ group: first.group, version: 1, text: `${A1}${A2}` });
  store.adjustSpeech({ group: first.group, version: 1, text: `${A1}${A2}` });
  clock.t += 2_000;
  const second = store.beginInput({ sessionId, text: '补充一下，那采集源呢', at: clock.t });
  store.noteAnswerBody({ group: second.group, version: 2, text: B });
  clock.t += 2_000;
  const third = store.beginInput({ sessionId, text: '再补充一句，那编码器呢', at: clock.t });
  assert.equal(third.answerVersion, 3);
  const carryBefore = store.snapshot(third.group.id).carryConvey;
  assert.equal(carryBefore.version, 3);

  // Version 2's budget fallback is late: it must not replace version 3's carry with its own rows.
  const refused = store.deferCarry({ group: third.group, version: 2, sentences: ['旧版本要延期的要点。'] });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'stale-version');
  assert.deepEqual(store.snapshot(third.group.id).carryConvey, carryBefore, 'the carry is not overwritten');
  const staleRow = events.filter((row) => row.type === 'voice.carry.convey').at(-1).payload;
  assert.equal(staleRow.staleVersionRejected, true);
  assert.equal(staleRow.reason, 'stale-version');
  assert.equal(staleRow.deferred, 0);
  assert.equal(staleRow.answerVersion, 2);
  assert.equal(staleRow.currentVersion, 3);

  // The current version may still defer its own points.
  const applied = store.deferCarry({ group: third.group, version: 3, sentences: [A1, A2, B] });
  assert.equal(applied.ok, true);
  assert.equal(store.snapshot(third.group.id).carryConvey.version, 3);
  assert.equal(store.snapshot(third.group.id).carryConvey.deferred, true);
  assert.deepEqual(store.snapshot(third.group.id).carryConvey.sentences, [A1, A2, B]);
  const deferRow = events.filter((row) => row.type === 'voice.carry.convey').at(-1).payload;
  assert.equal(deferRow.deferred, 3);
  assert.equal(deferRow.staleVersionRejected, undefined);
  t.diagnostic(
    `v3carry kept after stale defer=${carryBefore.sentences.length}句 `
    + `staleDeferred=${staleRow.deferred} currentDeferred=${deferRow.deferred}句 version=${applied.carry.version}`,
  );
});
