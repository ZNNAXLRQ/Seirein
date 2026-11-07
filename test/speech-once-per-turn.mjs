/**
 * One answer, one voice outlet: the official answer is spoken by the reply lane's spoken version
 * exactly once, and `assistant_say` never opens a second answer outlet.
 *
 * The host is the real mounted plugin (`apply` + the real `assistant_say` + the real voice round),
 * with a synthetic microphone, a fake agent loop and a fake TTS/player. No sound, network, capture
 * or GUI is used.
 *
 * Covered:
 *   1. say(purpose:'answer') then reply -> say accepted but skipped, reply plays once, 1 play.start
 *   2. an untagged say is the same answer content -> same skip event
 *   3. say(purpose:'explicit') is a different task identity -> both it and the reply play
 *   4. a four-block answer plays all four blocks in order, never interrupted as a "duplicate"
 *   5. a short progress line plays first and does not occupy the answer's voice
 *   6. a yielded speech that was invalidated never resumes (no second play.start)
 *   7. two sessions on the same turn number never affect each other
 *
 * Run: node test/speech-once-per-turn.mjs
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { registerHooks } from 'node:module';
import { Readable } from 'node:stream';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupRoot, disposeAll } from './helpers/cleanup.mjs';

const state = { synth: null, players: [], subtitles: [], texts: [], onUpdate: null, replyTurnId: null, hearingStats: { rmsDb: -20 } };
globalThis.__speechOnce = state;

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
    const s = globalThis.__speechOnce;
    export const modelReady = () => true;
    export const finalModelReady = () => false;
    export const isLoopbackDevice = (name) => /CABLE|Stereo Mix|Virtual/i.test(String(name));
    export const listDevices = async () => ['Fake Mic'];
    export const startHearing = (options) => {
      s.onUpdate = options.onUpdate;
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
      return {
        format: 'module',
        shortCircuit: true,
        source: `
    import * as real from '${speechTextUrl}?speech-once-real';
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
    const s = globalThis.__speechOnce;
    export { resolveGptLangs, resolveGptSovitsTimeout } from '${ttsUrl}?speech-once-helpers';
    export { speakChunks, speechChunkTexts } from '${ttsUrl}?speech-once-chunk';
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
    export { SubtitleHold } from '${subtitleUrl}?speech-once-real';
    export class SubtitleOverlay {
      constructor({ config }) { this.config = config; }
      async show(text, region, colors, options = {}) {
        if (typeof options.isCurrent === 'function' && options.isCurrent() !== true) return false;
        const s = globalThis.__speechOnce;
        s.subtitles.push({ text, at: Date.now() });
        return true;
      }
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

const { apply, createSpeechLedger, voiceSessionTarget } = await import('../src/host/index.js');
hooks.deregister();
after(() => { delete globalThis.__speechOnce; });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

const waitUntil = async (check, message, timeoutMs = 5000) => {
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

/**
 * The real voice round (`handleVoiceTask` + the sentence speaker) with a synthetic microphone and
 * a fake agent loop. The fake loop commits one turn per delivery; `beforeReply` holds the assistant
 * body so a test can call `assistant_say` while the round is still open.
 */
async function mountRound(t, { replyText = '最终答复。', beforeReply = null, chunking = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-speech-once-'));
  await mkdir(join(root, 'data'), { recursive: true });
  await mkdir(join(root, 'workspace'), { recursive: true });
  await writeFile(join(root, 'data', 'features.json'), JSON.stringify({
    hearing: true, ambient: false, voice: true, vision: false, subtitle: false,
    avatar: false, memory: false, fastpath: false,
  }));
  await writeFile(join(root, 'data', 'settings.json'), JSON.stringify({
    gptSovits: { enabled: false },
    langs: { speech: 'zh', subtitle: 'zh' },
    autoMemory: { enabled: false },
    voice: { chunking },
  }));

  state.players = [];
  state.subtitles = [];
  state.texts = [];
  state.onUpdate = null;
  state.replyTurnId = null;
  let synthSeq = 0;
  state.synth = async ({ text }) => {
    state.texts.push(text);
    return {
      file: join(root, 'tts', `${++synthSeq}.mp3`),
      bytes: 16,
      durationMs: 200,
      provider: 'edge-tts',
    };
  };

  const listeners = new Set();
  const cleanups = [];
  const tools = new Map();
  const services = new Map([
    ['agentDefaultModel', { currentSelection: () => ({ provider: 'fake-provider', model: 'fake-model' }) }],
    ['sessionTitle', { get: () => undefined, rename: (_session, title) => ({ title, source: { kind: 'user' } }) }],
    ['workspaceRegistry', {
      async create(path) { return { id: 'ws-speech-once', path }; },
      get() { return { id: 'ws-speech-once', async attachSession() {} }; },
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
          type, seq: turnId, time: Date.now(), data,
        });
        const runTurn = async () => {
          fire('turn/start', { turn: turnId });
          fire('user/message', message);
          if (isDigest !== true) {
            state.replyTurnId = turnId;
            if (beforeReply !== null) await beforeReply.promise;
          }
          fire('assistant/message', {
            turn: turnId,
            step: 1,
            message: { id: `a-${turnId}`, role: 'assistant', content: [{ type: 'text', text: replyText }] },
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
  const waitForEvent = async (type, predicate = () => true, timeoutMs = 6000) => {
    const startedAt = Date.now();
    for (;;) {
      const row = (await events()).find((event) => event.type === type && predicate(event.payload ?? {}));
      if (row !== undefined) return row.payload ?? {};
      if (Date.now() - startedAt > timeoutMs) throw new Error(`timed out waiting for ${type}`);
      await tick(10);
    }
  };
  // The host's dated session is the LOCAL day with the 04:00 rollover (`dayStampFor`, which uses
  // the computer clock), not the UTC date. `new Date().toISOString().slice(0, 10)` still names
  // yesterday between 00:00 and 08:00 Beijing time, so the test derived a session id the host
  // never uses. Ask the host helper for the same id (one clock + rollover rule) instead of
  // duplicating the convention here. This only fixes the expected id: every "one answer, one
  // voice" assertion below is untouched.
  const sessionId = voiceSessionTarget({ root }).sessionId;
  const sessionFor = (id) => (id === sessionId ? state.loopSession : { id, header: { cwd: join(root, 'workspace') } });
  t.after(async () => {
    beforeReply?.resolve?.();
    for (const player of [...state.players]) player.resolve();
    await tick(20);
    await disposeAll(cleanups.splice(0));
    await cleanupRoot(root);
  });
  return {
    root,
    sessionId,
    say: (text) => state.onUpdate({ final: text, durationMs: 100 }),
    toolSay: (args, { sessionId: target = sessionId } = {}) => tools.get('assistant_say').execute(
      typeof args === 'string' ? { text: args } : args,
      { agent: { session: sessionFor(target) } },
    ),
    emit: (id, type, data) => bus.fire('session/event', sessionFor(id), {
      type, seq: 1, time: Date.now(), data,
    }),
    events,
    waitForEvent,
    players: () => state.players,
    resolvePlayer: (index) => state.players[index]?.resolve(),
    replyTurnId: () => state.replyTurnId,
    synthTexts: () => state.texts,
  };
}

const sayStarts = (rows) => rows.filter((event) => event.type === 'speech.play.start' && event.payload.lane === 'say');
const replyStarts = (rows) => rows.filter((event) => event.type === 'speech.play.start' && event.payload.lane === 'reply');

// ---------------------------------------------------------------------------
// 1. answer-tagged say + reply -> the say never plays, the reply plays once
// ---------------------------------------------------------------------------

test('1. say(purpose:answer) then reply: the say is accepted but skipped, the reply plays once', async (t) => {
  const gate = deferred();
  const app = await mountRound(t, { replyText: '这是最终答复的口语版。', beforeReply: gate });
  app.say('开始');
  await waitUntil(() => app.replyTurnId() !== null, 'the reply turn started');

  const said = await app.toolSay({ text: '这是最终答复的完整正文，长度远超口语版，完整内容留在会话里。', purpose: 'answer' });
  assert.equal(said.accepted, true, 'the call is accepted, never rejected');
  assert.equal(said.status, 'skipped', 'the answer line is accepted without opening a player');
  assert.equal(said.reason, 'answer-goes-through-reply');
  const skipped = await app.waitForEvent('voice.say.skipped', (payload) => payload.reason === 'answer-goes-through-reply');
  assert.equal(skipped.purpose, 'answer');
  assert.equal(skipped.turn, app.replyTurnId());
  assert.equal(skipped.sessionId, app.sessionId);
  assert.equal(app.players().length, 0, 'no clip was produced for the answer line');

  gate.resolve();
  await waitUntil(() => app.players().length === 1, 'the reply spoken version reached the player');
  app.resolvePlayer(0);
  await app.waitForEvent('speech.finish', (payload) => payload.lane === 'reply');
  const rows = await app.events();
  assert.equal(sayStarts(rows).length, 0, 'the answer tag never opened a say outlet');
  assert.equal(replyStarts(rows).length, 1, 'the reply spoke the answer exactly once');
  assert.equal(
    rows.filter((event) => event.type === 'speech.play.start').length,
    1,
    'one answer, one play.start',
  );
  t.diagnostic(`say skipped; reply play.start=1; say play.start=0; event=${skipped.reason}`);
});

// ---------------------------------------------------------------------------
// 2. an untagged call is the same answer content
// ---------------------------------------------------------------------------

test('2. an untagged assistant_say is answer content: same skip, same event', async (t) => {
  const gate = deferred();
  const app = await mountRound(t, { replyText: '另一条最终答复。', beforeReply: gate });
  app.say('开始');
  await waitUntil(() => app.replyTurnId() !== null, 'the reply turn started');

  const said = await app.toolSay('未标 purpose 的答案正文，不应当独立开播。');
  assert.equal(said.accepted, true);
  assert.equal(said.status, 'skipped');
  assert.equal(said.reason, 'answer-goes-through-reply');
  const skipped = await app.waitForEvent('voice.say.skipped', (payload) => payload.reason === 'answer-goes-through-reply');
  assert.equal(skipped.purpose, 'answer', 'an untagged call is classified as the answer');
  assert.equal(skipped.requestedPurpose, '', 'the event still shows that no tag was sent');
  assert.equal(app.players().length, 0);

  gate.resolve();
  await waitUntil(() => app.players().length === 1, 'the reply played');
  app.resolvePlayer(0);
  await app.waitForEvent('speech.finish', (payload) => payload.lane === 'reply');
  assert.equal((await app.events()).filter((event) => event.type === 'speech.play.start').length, 1);
  t.diagnostic(`untagged say skipped; purpose=${skipped.purpose}; play.start=1 (reply only)`);
});

// ---------------------------------------------------------------------------
// 3. explicit is a different task identity and never replaces the reply
// ---------------------------------------------------------------------------

test('3. say(purpose:explicit) plays and the reply answer still plays', async (t) => {
  const gate = deferred();
  const app = await mountRound(t, { replyText: '最终答复正文。', beforeReply: gate });
  app.say('开始');
  await waitUntil(() => app.replyTurnId() !== null, 'the reply turn started');

  const said = await app.toolSay({ text: '这是用户点播的一句独立的话。', purpose: 'explicit' });
  assert.equal(said.accepted, true);
  assert.equal(said.status, 'synthesizing', 'the explicit line starts playing in the background');
  await waitUntil(() => app.players().length === 1, 'the explicit line reached the player');
  app.resolvePlayer(0);

  gate.resolve();
  await waitUntil(() => app.players().length === 2, 'the reply answer played after the explicit line');
  app.resolvePlayer(1);
  await app.waitForEvent('speech.finish', (payload) => payload.speechId === said.speechId);
  await app.waitForEvent('speech.finish', (payload) => payload.lane === 'reply');
  const rows = await app.events();
  assert.equal(sayStarts(rows).length, 1, 'the explicit line sounded');
  assert.equal(replyStarts(rows).length, 1, 'the answer still went through the reply outlet');
  assert.equal(rows.filter((event) => event.type === 'speech.play.start').length, 2, 'two task identities');
  t.diagnostic(`explicit say=1 + reply=1; total play.start=2; both play`);
});

// ---------------------------------------------------------------------------
// 4. a multi-block answer plays every block in order, never as a "duplicate"
// ---------------------------------------------------------------------------

test('4. a four-block answer plays all four blocks in order, with no duplicate interruption', async (t) => {
  const BLOCKS = ['第一块内容在这里，', '第二块内容在这里，', '第三块内容在这里，', '第四块内容在这里。'];
  const replyText = BLOCKS.join('');
  const gate = deferred();
  const app = await mountRound(t, { replyText, beforeReply: gate, chunking: true });
  const fileText = new Map();
  let synthSeq = 0;
  state.synth = async ({ text }) => {
    const file = join(app.root, 'tts', `block-${++synthSeq}.mp3`);
    fileText.set(file, text);
    return { file, bytes: 16, durationMs: 200, provider: 'edge-tts' };
  };
  app.say('开始');
  await waitUntil(() => app.replyTurnId() !== null, 'the reply turn started');
  // An answer-tagged tool line with the very same text must not make the reply skip any block.
  const said = await app.toolSay({ text: replyText, purpose: 'answer' });
  assert.equal(said.status, 'skipped');

  gate.resolve();
  const played = [];
  for (let index = 0; index < BLOCKS.length; index += 1) {
    await waitUntil(() => app.players().length >= index + 1, `reply block ${index} reached the player`, 8000);
    played.push(fileText.get(app.players()[index].file));
    app.resolvePlayer(index);
    await tick(5);
  }
  await app.waitForEvent('speech.finish', (payload) => payload.lane === 'reply');
  assert.deepEqual(played, BLOCKS, 'all four blocks played in their original order');
  const rows = await app.events();
  assert.equal(replyStarts(rows).length, 4, 'four reply blocks started');
  assert.equal(rows.filter((event) => event.type === 'speech.cancelled').length, 0, 'no block was interrupted');
  assert.equal(sayStarts(rows).length, 0);
  t.diagnostic(`blocks=${played.length} order ok; cancelled=0; say play.start=0`);
});

// ---------------------------------------------------------------------------
// 5. a short progress line plays, then the answer plays normally
// ---------------------------------------------------------------------------

test('5. a short progress line plays first and does not occupy the answer voice', async (t) => {
  const gate = deferred();
  const app = await mountRound(t, { replyText: '最终答复。', beforeReply: gate });
  app.say('开始');
  await waitUntil(() => app.replyTurnId() !== null, 'the reply turn started');

  const progress = await app.toolSay({ text: '我这就去查一下，稍等。', purpose: 'progress' });
  assert.equal(progress.accepted, true);
  await app.waitForEvent('voice.say.progress', (payload) => payload.turn === app.replyTurnId());
  await waitUntil(() => app.players().length === 1, 'the progress line reached the player');
  app.resolvePlayer(0);
  await app.waitForEvent('speech.finish', (payload) => payload.speechId === progress.speechId);

  gate.resolve();
  await waitUntil(() => app.players().length === 2, 'the answer played after the progress line');
  app.resolvePlayer(1);
  await app.waitForEvent('speech.finish', (payload) => payload.lane === 'reply');
  const rows = await app.events();
  assert.equal(sayStarts(rows).length, 1, 'the progress line sounded');
  assert.equal(replyStarts(rows).length, 1, 'the answer still played');
  t.diagnostic(`progress say=1; reply=1; answer not skipped by progress`);
});

// ---------------------------------------------------------------------------
// 6. a yielded speech that was invalidated never resumes
// ---------------------------------------------------------------------------

test('6. a yielded, invalidated speech has no second play.start (resumeAfter never revives it)', async (t) => {
  const emitted = [];
  const ledger = createSpeechLedger({
    emit: async (type, payload) => { emitted.push({ type, payload }); },
  });
  const held = new Map();
  const hold = (speechId) => new Promise((resolve) => held.set(speechId, resolve));
  const blockingRun = async ({ speechId, onFirstAudio }) => {
    await ledger.waitPlaybackTurn(speechId);
    onFirstAudio(Date.now());
    await hold(speechId);
  };
  const progress = ledger.accept({
    sessionId: 'handoff-s', turn: 1, text: '进度语音第一块。', priority: 2, run: blockingRun,
  });
  await waitUntil(() => emitted.some((row) => (
    row.type === 'speech.play.start' && row.payload.speechId === progress.speechId
  )), 'the progress block sounded');

  // The answer arrives as a higher-priority block and waits for the boundary.
  const answer = ledger.accept({
    sessionId: 'handoff-s', turn: 1, text: '这是最终答复。', priority: 3, run: blockingRun,
  });
  await tick(10);
  const handoff = ledger.handoffAtBlockBoundary(progress.speechId, { remainingChunks: 1 });
  assert.equal(handoff?.toSpeechId, answer.speechId, 'the answer took the seat at the block boundary');

  // The yielded progress line is invalidated while paused (mute/barge-in cancels the record).
  assert.equal(ledger.cancel(progress.speechId, 'muted').ok, true);
  await waitUntil(() => emitted.some((row) => (
    row.type === 'speech.play.start' && row.payload.speechId === answer.speechId
  )), 'the answer sounded');
  held.get(answer.speechId)?.();
  await tick(30);
  await assert.rejects(
    ledger.waitPlaybackTurn(progress.speechId, { reportOnly: true }),
    (error) => error?.code === 'SPEECH_CANCELLED',
    'the invalidated speech can never be granted the seat again',
  );
  const starts = emitted.filter((row) => row.type === 'speech.play.start' && row.payload.speechId === progress.speechId);
  assert.equal(starts.length, 1, 'exactly one play.start for the yielded line');
  assert.equal(ledger.statusOf(progress.speechId).status, 'cancelled');
  held.get(progress.speechId)?.();
  await tick(10);
  t.diagnostic(`handoff=${handoff.toSpeechId}; yielded play.start=1; status=cancelled; no revival`);
});

// ---------------------------------------------------------------------------
// 7. the same turn number in another session is a different scope
// ---------------------------------------------------------------------------

test('7. two sessions on the same turn number never affect each other', async (t) => {
  const gate = deferred();
  const app = await mountRound(t, { replyText: '本场会话的最终答复。', beforeReply: gate });
  app.say('开始');
  await waitUntil(() => app.replyTurnId() !== null, 'the reply turn started');

  // A second conversation opens the SAME turn number. It has no voice reply outlet of its own.
  const otherSession = 'speech-once-other-session';
  const sharedTurn = app.replyTurnId();
  app.emit(otherSession, 'turn/start', { turn: sharedTurn });
  const foreign = await app.toolSay({ text: '另一场会话的答案正文。', purpose: 'answer' }, { sessionId: otherSession });
  assert.equal(foreign.accepted, true);
  assert.notEqual(foreign.status, 'skipped', 'the other session has no reply outlet to defer to');
  await waitUntil(() => app.players().length === 1, 'the other session line played');
  app.resolvePlayer(0);
  await app.waitForEvent('speech.finish', (payload) => payload.speechId === foreign.speechId);

  // The voice round in this session still owns its own answer: that line is skipped.
  const own = await app.toolSay({ text: '本场会话的答案正文。', purpose: 'answer' });
  assert.equal(own.status, 'skipped');
  const skipped = await app.waitForEvent('voice.say.skipped', (payload) => payload.sessionId === app.sessionId);
  assert.equal(skipped.reason, 'answer-goes-through-reply');
  assert.equal(
    (await app.events()).filter((event) => event.type === 'voice.say.skipped').length,
    1,
    'only the owning session logged the skip',
  );

  gate.resolve();
  await waitUntil(() => app.players().length === 2, 'the owning reply played');
  app.resolvePlayer(1);
  await app.waitForEvent('speech.finish', (payload) => payload.lane === 'reply');

  // Ledger scope: cancelling turns of one session leaves the other session's same turn alive.
  const unit = createSpeechLedger({ emit: async () => {} });
  const other = unit.accept({ sessionId: 'sess-b', turn: 1, text: 'B。', run: async () => { await new Promise(() => {}); } });
  await unit.waitPlaybackTurn(other.speechId);
  assert.equal(unit.cancelBefore('sess-a', 2), 0, 'no record of another session is cancelled');
  assert.equal(unit.statusOf(other.speechId).status, 'synthesizing', 'the other session is untouched');
  unit.cancel(other.speechId, 'explicit');
  await tick(10);
  t.diagnostic(`foreign(answer)=played; own(answer)=skipped; cross-session cancelBefore=0`);
});
