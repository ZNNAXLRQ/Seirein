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
    // The session already exists: no rollover digest, so each followup is exactly one turn.
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

  app.say('新增内容');
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
