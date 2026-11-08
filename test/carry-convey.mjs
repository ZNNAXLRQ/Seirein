/**
 * B (refined): the previous round's never-spoken content becomes "待传达" material for the NEXT
 * round's spoken organization.
 *
 * The host is mounted for real (`apply` + `assistant_listen` + the real voice round); the
 * microphone, the agent loop, TTS, the player and the spoken-version model are deterministic
 * fakes. The carry is a speech-only channel: the visible answer, the session history and memory
 * are never touched, no user message is added, and nothing is truncated to a character budget.
 *
 * Covered:
 *   1. previous round never started sounding + same-topic supplement 5 s later: the ONE spoken
 *      version carries the old points and the new answer, deduped, played once
 *   2. an explicit topic switch ("切回桌面") carries nothing (reason=topic-switch)
 *   3. a 20 s gap carries nothing (reason=prior-idle), store-level with an exact clock
 *   4. a round that already started sounding is never auto-carried after an interruption
 *   5. an explicit "继续/接着播" restores the unplayed sentences verbatim, with no condense call
 *   6. the body, the user messages and the memory rows stay exactly as without a carry
 *   7. no character-budget truncation: every old point (negations and conditions included) reaches
 *      the organizer untouched
 *
 * Run: node --test test/carry-convey.mjs
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { registerHooks } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { cleanupRoot, disposeAll } from './helpers/cleanup.mjs';
import {
  CARRY_CONVEY_SYSTEM_NOTE,
  createResponseGroupStore,
  splitSpeechSentences,
} from '../src/host/session/conversation/responseGroup.js';

const state = {
  synth: null,
  players: [],
  subtitles: [],
  texts: [],
  onUpdate: null,
  replyFor: null,
  preStepMessages: new Map(),
  turnIds: [],
  held: 0,
  holdGate: null,
};
globalThis.__carryConvey = state;

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
    const s = globalThis.__carryConvey;
    export const modelReady = () => true;
    export const finalModelReady = () => false;
    export const isLoopbackDevice = (name) => /CABLE|Stereo Mix|Virtual/i.test(String(name));
    export const listDevices = async () => ['Fake Mic'];
    export const startHearing = (options) => {
      s.onUpdate = options.onUpdate;
      return { device: options.device, stop() {}, stats: () => ({ rmsDb: -20 }) };
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
    import * as real from '${speechTextUrl}?carry-convey-real';
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
    const s = globalThis.__carryConvey;
    export { resolveGptLangs, resolveGptSovitsTimeout } from '${ttsUrl}?carry-convey-helpers';
    export { speakChunks, speechChunkTexts } from '${ttsUrl}?carry-convey-chunk';
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
    export { SubtitleHold } from '${subtitleUrl}?carry-convey-real';
    export class SubtitleOverlay {
      constructor({ config }) { this.config = config; }
      async show(text) { globalThis.__carryConvey.subtitles.push({ text, at: Date.now() }); return true; }
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
after(() => { delete globalThis.__carryConvey; });

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const OLD_BODY = '先说结论：OBS 全黑多半是采集源没选对。必要条件是窗口采集要选中目标窗口，而不是整个显示器。如果采集源还是黑屏，不要直接删掉场景，先点一下窗口采集的属性再确认一次。最后再看一眼场景本身是不是空的。';
const OLD_SPOKEN = '结论：OBS 全黑多半是采集源没选对，窗口采集要选中目标窗口，而不是整个显示器。如果还是黑屏，不要直接删场景，先点开采集属性确认一次。';
const NEW_BODY = '新回答：改成游戏采集就能看到画面。';
const MERGED_SPOKEN = '先补上上次没说完的：窗口采集要选中目标窗口，不是整个显示器；如果还是黑屏，不要直接删场景。改成游戏采集就能看到画面。';
const SWITCH_BODY = '桌面模式的新回答：先把窗口都收起来，再看一眼任务栏。必要条件是显示器不要自动休眠，如果黑屏先按一下键盘。最后再确认一下外接显示器是不是接着电。';
const SWITCH_SPOKEN = '桌面模式：窗口先收起来，看一眼任务栏，显示器不要自动休眠，黑屏先按键盘，最后确认外接显示器接着电。';
const STILL_BODY = '采集源还是黑的话，先确认采集源类型是不是窗口采集，而不是显示器采集。必要条件是目标窗口没有最小化。如果还是不显示，换一个采集源再试一次。';
const STILL_SPOKEN = '采集源还是黑就先确认类型是窗口采集，目标窗口不能最小化，还不行就换一个采集源。';

/** A long old answer (> 1200 chars) whose negations/conditions sit at the end of the plan. */
const LONG_FILL = '这一条要说的细节是把每个设置都确认一遍，先看采集源再看输出分辨率，然后看场景里有没有多余的滤镜，最后才去看编码器。';
const LONG_OLD_BODY = `${Array.from({ length: 16 }, (_, index) => `第${index + 1}条，如果第${index + 1}步没有反应，不要马上重启软件，${LONG_FILL}`).join('')}最后一条结论：先备份再改配置。`;
const LONG_OLD_SPOKEN = LONG_OLD_BODY;
const LONG_MERGED = '结论：前十六条都确认过了，如果还是没反应不要重启，先备份再改配置。新回答是换成游戏采集。';

// ---------------------------------------------------------------------------
// Mount: real host, fake microphone / agent loop / TTS / player / spoken model
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

const spokenRequestOf = (options) => String(options?.system ?? '').includes('可直接朗读的口语版')
  || String(options?.messages?.[0]?.content?.[0]?.text ?? '').includes('<完整答复>');

async function mountRound(t, {
  replyFor = () => '第一句。第二句。',
  spoken = () => '',
  holdSynth = () => false,
  memory = false,
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-carry-convey-'));
  await mkdir(join(root, 'data'), { recursive: true });
  await mkdir(join(root, 'workspace'), { recursive: true });
  await writeFile(join(root, 'data', 'features.json'), JSON.stringify({
    hearing: true, ambient: false, voice: true, vision: false, subtitle: false, avatar: false,
    memory, fastpath: false,
  }));
  await writeFile(join(root, 'data', 'settings.json'), JSON.stringify({
    gptSovits: { enabled: false },
    langs: { speech: 'zh', subtitle: 'zh' },
    autoMemory: { enabled: memory },
    voice: { chunking: false, ackDelayMs: 15000 },
  }));
  state.players = [];
  state.subtitles = [];
  state.texts = [];
  state.onUpdate = null;
  state.replyFor = typeof replyFor === 'function' ? replyFor : (() => String(replyFor));
  state.held = 0;
  state.preStepMessages = new Map();
  state.turnIds = [];
  state.holdGate = deferred();
  state.synth = async ({ text }) => {
    state.texts.push(text);
    // Only the FIRST matching clip is held: a later round may legitimately say the same text.
    if (holdSynth(String(text)) === true && state.held === 0) {
      state.held += 1;
      await state.holdGate.promise;
    }
    return { file: join(root, 'tts', `${state.texts.length}.mp3`), bytes: 16, durationMs: 200, provider: 'edge-tts' };
  };

  const spokenRequests = [];
  // `value` may be a string or a promise: a test can hold the organizer's answer (a late result).
  const streamOf = (value) => (async function* generate() {
    const text = await value;
    yield { type: 'text-delta', text };
    yield { type: 'finish', reason: { kind: 'stop' } };
  })();
  const llm = {
    resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'off' }] } }),
    stream(options) {
      const userText = String(options?.messages?.[0]?.content?.[0]?.text ?? '');
      if (!spokenRequestOf(options)) return streamOf('稍等，我在看。');
      spokenRequests.push({ system: String(options?.system ?? ''), user: userText });
      return streamOf(spoken(userText));
    },
  };

  const listeners = new Set();
  const cleanups = [];
  const tools = new Map();
  const services = new Map([
    ['llm', llm],
    ['agentDefaultModel', { currentSelection: () => ({ provider: 'fake-provider', model: 'fake-model' }) }],
    ['sessionTitle', { get: () => undefined, rename: (_session, title) => ({ title, source: { kind: 'user' } }) }],
    ['workspaceRegistry', {
      async create(path) { return { id: 'ws-carry-convey', path }; },
      get() { return { id: 'ws-carry-convey', async attachSession() {} }; },
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
          const text = state.replyFor({ turn: turnId, text: messageText(message), messages });
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
  const target = voiceSessionTarget({ root });
  t.after(async () => {
    state.holdGate.resolve();
    for (const player of [...state.players]) player.resolve();
    await tick(20);
    await disposeAll(cleanups.splice(0));
    await cleanupRoot(root);
  });
  return {
    root,
    sessionId: target.sessionId,
    say: (text) => state.onUpdate({ final: text, durationMs: 100 }),
    events,
    waitForEvent,
    players: () => state.players,
    resolvePlayer: (index) => state.players[index]?.resolve(),
    texts: () => state.texts,
    spokenRequests: () => spokenRequests,
    preStep: (turn) => state.preStepMessages.get(turn) ?? null,
    userMessages: (turn) => (state.preStepMessages.get(turn) ?? [])
      .filter((message) => message?.source?.kind === 'user'),
    playerCaptions: () => state.players.map((player) => {
      const match = /(\d+)\.mp3$/u.exec(String(player.file ?? ''));
      return match === null ? '' : String(state.texts[Number(match[1]) - 1] ?? '');
    }),
  };
}

/** Resolve clips serially so the next sentence reaches the player. */
async function playAll(app, expected) {
  for (let index = 0; index < expected; index += 1) {
    await waitUntil(() => app.players().length >= index + 1, `clip ${index + 1} reached the player`);
    app.resolvePlayer(index);
    await tick(10);
  }
}

const carryEventOf = async (app, predicate = () => true) => app.waitForEvent('voice.carry.convey', predicate);

/** The clips one spoken plan is played as: one per sentence (the speaker's own splitter). */
const sentenceClips = (text) => splitSpeechSentences(String(text ?? ''));

const joined = (texts) => texts.join('');

// ---------------------------------------------------------------------------
// 1. Never-spoken round + same-topic supplement: one organized spoken reply
// ---------------------------------------------------------------------------

test('1. a never-spoken round plus a same-topic supplement are spoken once, deduped', async (t) => {
  const realNow = Date.now;
  let skewMs = 0;
  Date.now = () => realNow() + skewMs;
  t.after(() => { Date.now = realNow; });
  const app = await mountRound(t, {
    holdSynth: (text) => text.includes('采集源没选对'),
    replyFor: ({ turn }) => (turn === 1 ? OLD_BODY : NEW_BODY),
    spoken: (userText) => (userText.includes('<上一轮待传达>') ? MERGED_SPOKEN : OLD_SPOKEN),
  });
  assert.ok(OLD_SPOKEN.length < OLD_BODY.length, 'fixture: the spoken version is shorter than the body');

  app.say('OBS 全黑怎么调');
  await waitUntil(() => state.held === 1, 'the first synthesized clip is held');
  const ready = await app.waitForEvent('voice.response.group.ready', (payload) => payload.version === 1);
  const firstGroup = ready.groupId;
  assert.equal(app.players().length, 0, 'the old version never reached the player');

  skewMs = 5_000;
  app.say('补充一下，那窗口采集还是黑屏呢');
  let carry;
  let continued;
  try {
    carry = await carryEventOf(app, (payload) => payload.merged === true);
    continued = await app.waitForEvent('voice.response.group.continued');
  } finally {
    skewMs = 0;
  }
  assert.equal(carry.groupId, continued.groupId);
  assert.equal(carry.priorGroupId, firstGroup, 'the carried points belong to the never-spoken round');
  assert.equal(carry.reason, 'same-topic');
  assert.equal(carry.merged, true);
  assert.equal(carry.sentences, 2, 'both old sentences are carried as points');
  assert.ok(carry.chars >= OLD_SPOKEN.length, `the whole old plan is carried (${carry.chars} chars)`);
  assert.ok(carry.gapMs >= 4_900 && carry.gapMs < 5_200, `the gap is measured between inputs (${carry.gapMs} ms)`);

  state.holdGate.resolve();
  await waitUntil(() => app.spokenRequests().length === 2, 'the second spoken version was organized');
  const request = app.spokenRequests()[1];
  assert.ok(request.system.includes(CARRY_CONVEY_SYSTEM_NOTE), 'the organizer is told how to use 【待传达】');
  assert.ok(request.user.includes(`<上一轮待传达>\n${OLD_SPOKEN}\n</上一轮待传达>`), 'the whole old plan is the carry block');
  assert.ok(request.user.includes(`<完整答复>\n${NEW_BODY}\n</完整答复>`), 'the complete new body is still supplied');

  const clips = sentenceClips(MERGED_SPOKEN);
  await playAll(app, clips.length);
  const done = await app.waitForEvent('voice.response.group.done');
  assert.equal(done.reason, 'played');
  const played = joined(app.playerCaptions());
  assert.equal(played, MERGED_SPOKEN, 'exactly the organized spoken version, once');
  assert.ok(!played.includes('第一句'), 'no raw old sentence is replayed verbatim');
  assert.equal(played.split('窗口采集').length - 1, 1, 'the old point is said once, not repeated');
  assert.equal(played.split('游戏采集').length - 1, 1, 'the new answer is said once');
  const rows = await app.events();
  assert.equal(
    rows.filter((event) => event.type === 'voice.response.playback' && event.payload.answerVersion === 1).length,
    0,
    'the superseded version never played',
  );
  assert.equal(
    rows.filter((event) => event.type === 'voice.spoken.version' && event.payload.purpose === 'answer').length,
    2,
    'one spoken version per round, never a second one for the carried points',
  );
  t.diagnostic(
    `carry=${carry.sentences}句/${carry.chars}字 gap=${carry.gapMs}ms merged=${carry.merged} `
    + `clips=${clips.length} spokenChars=${played.length} oldPlayback=0`,
  );
});

// ---------------------------------------------------------------------------
// 2. Topic switch: nothing is carried
// ---------------------------------------------------------------------------

test('2. an explicit topic switch ("切回桌面") carries nothing', async (t) => {
  const app = await mountRound(t, {
    holdSynth: (text) => text.includes('采集源没选对'),
    replyFor: ({ turn }) => (turn === 1 ? OLD_BODY : SWITCH_BODY),
    spoken: (userText) => (userText.includes(SWITCH_BODY) ? SWITCH_SPOKEN : OLD_SPOKEN),
  });
  app.say('OBS 全黑怎么调');
  await waitUntil(() => state.held === 1, 'the first clip is held before any sound');
  const firstGroup = (await app.waitForEvent('voice.response.group.ready', (payload) => payload.version === 1)).groupId;

  app.say('切回桌面');
  const carry = await carryEventOf(app);
  assert.equal(carry.priorGroupId, firstGroup);
  assert.equal(carry.merged, false, 'a subject change never carries');
  assert.equal(carry.reason, 'topic-switch');
  const abandoned = await app.waitForEvent('voice.response.group.abandoned');
  assert.equal(abandoned.reason, 'new-instruction', 'the group machine keeps its own reason');

  state.holdGate.resolve();
  const switchClips = sentenceClips(SWITCH_SPOKEN);
  await waitUntil(() => app.players().length === switchClips.length, 'the new-topic answer reached the player');
  const request = app.spokenRequests().at(-1);
  assert.ok(!request.system.includes(CARRY_CONVEY_SYSTEM_NOTE), 'the organizer gets no carry instruction');
  assert.ok(!request.user.includes('<上一轮待传达>'), 'no carried block is sent');
  await playAll(app, switchClips.length);
  const spoken = joined(app.playerCaptions());
  assert.equal(spoken, SWITCH_SPOKEN, 'only the new-topic answer is spoken');
  assert.ok(!spoken.includes('采集源'), 'the old points are not spoken');
  t.diagnostic(
    `carry merged=${carry.merged} reason=${carry.reason} groupAbandoned=${abandoned.reason} `
    + `spokenChars=${spoken.length} oldPoints=0`,
  );
});

// ---------------------------------------------------------------------------
// 3. 20 s gap: outside the 15 s auto-association window
// ---------------------------------------------------------------------------

test('3. a 20 s gap is outside the window and carries nothing (reason=prior-idle)', (t) => {
  const clock = { t: 2_000_000 };
  const events = [];
  const store = createResponseGroupStore({
    now: () => clock.t,
    emit: (type, payload) => events.push({ type, payload }),
  });
  const first = store.beginInput({ sessionId: 's-gap', text: 'OBS 全黑怎么调', at: clock.t });
  store.noteAnswerPlan({ group: first.group, version: 1, text: OLD_SPOKEN });
  store.adjustSpeech({ group: first.group, version: 1, text: OLD_SPOKEN });
  assert.equal(store.get(first.group.id).speechStarted, false, 'nothing started sounding');

  clock.t += 20_000;
  const second = store.beginInput({ sessionId: 's-gap', text: '再补充一句', at: clock.t });
  assert.equal(second.continuation, false, 'a 20 s gap is a new request, not a continuation');
  assert.equal(second.reason, 'prior-idle');
  const carry = events.find((row) => row.type === 'voice.carry.convey');
  assert.ok(carry !== undefined, 'the decision is reported');
  assert.equal(carry.payload.merged, false);
  assert.equal(carry.payload.reason, 'prior-idle');
  assert.equal(carry.payload.gapMs, 20_000);
  assert.equal(store.get(second.group.id).carryConvey, null, 'the new group carries no points');
  assert.equal(store.carryForSpeech(second.group, second.answerVersion), null);
  assert.equal(
    events.filter((row) => row.type === 'voice.carry.convey' && row.payload.merged === true).length,
    0,
  );
  t.diagnostic(
    `gap=${carry.payload.gapMs}ms window=15000ms reason=${carry.payload.reason} `
    + `merged=false newCarry=null`,
  );
});

// ---------------------------------------------------------------------------
// 4. Already sounding: an interruption is never auto-carried
// ---------------------------------------------------------------------------

test('4. a round that already started sounding is not auto-carried after an interruption', async (t) => {
  const app = await mountRound(t, {
    // Two sentences, both short: the first round speaks the body verbatim.
    replyFor: ({ turn }) => (turn === 1 ? '第一句。第二句。' : STILL_BODY),
    spoken: () => STILL_SPOKEN,
  });
  app.say('OBS 全黑怎么调');
  await waitUntil(() => app.players().length === 1, 'the first sentence reached the player');
  assert.equal(app.playerCaptions()[0], '第一句。');
  app.say('采集源还是黑的');
  const carry = await carryEventOf(app);
  assert.equal(carry.merged, false, 'a group that already sounded is never carried');
  assert.equal(carry.reason, 'prior-played');
  const abandoned = await app.waitForEvent('voice.response.group.abandoned');
  assert.equal(abandoned.retained, true);
  assert.ok(abandoned.pending >= 1, 'the unvoiced remainder is retained as speechPending');
  const pending = await app.waitForEvent('voice.response.group.speech-pending');
  assert.ok(pending.sentences >= 1);

  const stillClips = sentenceClips(STILL_SPOKEN);
  await waitUntil(() => app.players().length === 1 + stillClips.length, 'the new-round answer reached the player');
  const request = app.spokenRequests().at(-1);
  assert.ok(!request.user.includes('<上一轮待传达>'), 'no auto-carry after playback started');
  const spoken = joined(app.playerCaptions().slice(1));
  await playAll(app, 1 + stillClips.length);
  assert.equal(spoken, STILL_SPOKEN, 'only the new answer is spoken');
  assert.ok(!joined(app.playerCaptions()).includes('第二句'), 'the interrupted remainder is not replayed by itself');
  t.diagnostic(
    `carry merged=${carry.merged} reason=${carry.reason} speechPending=${pending.sentences}句 `
    + `oldReplayed=0`,
  );
});

// ---------------------------------------------------------------------------
// 5. Explicit "继续/接着播": restore verbatim, no condense call
// ---------------------------------------------------------------------------

test('5. an explicit "接着播" restores the unplayed sentences verbatim with no condense call', async (t) => {
  const app = await mountRound(t, {
    // The second sentence's synthesis is held, so it never really starts sounding.
    holdSynth: (text) => text.includes('第二句。'),
    replyFor: ({ turn }) => {
      if (turn === 1) return '第一句。第二句。';
      return turn === 2 ? '好的。' : '记住了。';
    },
    spoken: () => '这段不应该被用到。',
  });
  app.say('请把这一轮完整读出来');
  const created = await app.waitForEvent('voice.response.group.created');
  const firstGroup = created.groupId;
  await waitUntil(() => app.players().length === 1, 'the first sentence started');
  app.resolvePlayer(0);
  await waitUntil(() => state.held === 1, 'the second sentence is held before any sound');
  assert.deepEqual(app.playerCaptions(), ['第一句。']);

  app.say('切回桌面');
  await app.waitForEvent('voice.response.group.speech-pending');
  const carrySwitch = await carryEventOf(app);
  assert.equal(carrySwitch.merged, false);

  await waitUntil(() => app.players().length === 2, 'the new-round answer played');
  assert.equal(app.playerCaptions()[1], '好的。');
  app.resolvePlayer(1);
  await tick(20);

  app.say('接着播');
  const resumed = await app.waitForEvent(
    'voice.response.group.continued',
    (payload) => payload.reason === 'resume-pending',
  );
  assert.equal(resumed.groupId, firstGroup, 'the same group is resumed');
  assert.equal(resumed.priorVersion, 1);
  await playAll(app, 4);
  const captions = app.playerCaptions();
  assert.deepEqual(captions.slice(2), ['第二句。', '记住了。'], 'the unplayed tail is restored verbatim, then the new answer');
  assert.equal(app.spokenRequests().length, 0, 'the resumed round never asks for a condense');
  const rows = await app.events();
  assert.equal(
    rows.filter((event) => event.type === 'voice.carry.convey' && event.payload.merged === true).length,
    0,
    'an explicit resume is not a carry',
  );
  assert.deepEqual(app.playerCaptions().slice(0, 2), ['第一句。', '好的。'], 'the already-heard opening is never replayed');
  state.holdGate.resolve();
  await tick(20);
  assert.equal(app.players().length, 4, 'the held, superseded clip never reaches the player');
  t.diagnostic(
    `restored="${captions.slice(2).join('|')}" condenseCalls=0 carries=0 `
    + `resumeReason=${resumed.reason}`,
  );
});

// ---------------------------------------------------------------------------
// 6. Body, user messages and memory are untouched by a carry
// ---------------------------------------------------------------------------

test('6. the body, the user messages and the memory rows are unchanged by a carry', async (t) => {
  const app = await mountRound(t, {
    memory: true,
    holdSynth: (text) => text.includes('采集源没选对'),
    replyFor: ({ turn }) => (turn === 1 ? OLD_BODY : NEW_BODY),
    spoken: (userText) => (userText.includes('<上一轮待传达>') ? MERGED_SPOKEN : OLD_SPOKEN),
  });
  app.say('OBS 全黑怎么调');
  await waitUntil(() => state.held === 1, 'the first clip is held');
  await app.waitForEvent('voice.response.group.ready', (payload) => payload.version === 1);
  app.say('补充一下，那窗口采集还是黑屏呢');
  await carryEventOf(app, (payload) => payload.merged === true);
  state.holdGate.resolve();
  const mergedClips = sentenceClips(MERGED_SPOKEN);
  await playAll(app, mergedClips.length);
  await app.waitForEvent('memory.auto', (payload) => payload.role === 'assistant', 8000);

  // The visible answer is the exact committed body of each turn (never the merged speech).
  const replies = (await app.events())
    .filter((row) => row.type === 'voice.reply')
    .map((row) => row.payload?.chars);
  assert.deepEqual(replies, [OLD_BODY.length, NEW_BODY.length], 'each committed body keeps its own length');
  const spokenRows = (await app.events())
    .filter((row) => row.type === 'voice.spoken.text' && row.payload?.purpose === 'answer');
  const mergedRow = spokenRows.at(-1)?.payload ?? {};
  assert.equal(mergedRow.bodyChars, NEW_BODY.length, 'the spoken round declares the NEW body as its body');
  assert.ok(mergedRow.spokenChars > NEW_BODY.length, 'the spoken version is longer: it carries the old points');
  const assistantRows = (await app.events())
    .filter((row) => row.type === 'assistant/message')
    .map((row) => messageText(row.payload?.message));
  assert.equal(assistantRows.length, 0, 'the carry never adds an assistant message of its own');

  // Exactly the two real utterances are user messages; the carry adds none.
  const users = [1, 2].map((turn) => app.userMessages(turn));
  assert.equal(users[0].length, 1, 'turn 1 has exactly one real user message');
  assert.equal(users[1].length, 1, 'turn 2 has exactly one real user message');
  assert.deepEqual(
    users.map((rows) => messageText(rows[0])),
    ['OBS 全黑怎么调', '补充一下，那窗口采集还是黑屏呢'],
  );
  const allPreStep = [1, 2]
    .flatMap((turn) => app.preStep(turn) ?? [])
    .map((message) => messageText(message))
    .join('\n');
  assert.ok(!allPreStep.includes(MERGED_SPOKEN), 'the merged speech is never a turn message');
  assert.ok(!allPreStep.includes('待传达'), 'the carry is not a message at all');

  // Memory records the full body once per turn, never the organized spoken version.
  const readBodies = () => {
    const db = new DatabaseSync(join(app.root, 'memory', 'memory.db'));
    const rows = db.prepare('select role, text from memory_event where session_id = ? and hidden = 0 order by ts').all(app.sessionId);
    db.close();
    return rows.filter((row) => row.role === 'assistant').map((row) => row.text);
  };
  let bodies = readBodies();
  await waitUntil(() => {
    bodies = readBodies();
    return bodies.length >= 2;
  }, 'both turns were recorded in memory', 8000);
  assert.equal(bodies.length, 2, 'one assistant memory record per turn');
  assert.ok(bodies[0].includes('OBS 全黑多半是采集源没选对'), 'turn 1 memory is the full body');
  assert.ok(bodies[0].includes('最后再看一眼场景本身是不是空的'), 'turn 1 memory keeps the body tail');
  assert.ok(bodies[1].includes(NEW_BODY), 'turn 2 memory is the full body');
  assert.ok(!bodies.some((text) => text.includes(MERGED_SPOKEN)), 'the spoken version is never a memory row');
  assert.ok(!bodies.some((text) => text.includes('待传达')), 'the carried points are never memorized');
  t.diagnostic(
    `bodyChars=${replies.join('/')} userMessages=1+1 memoryRows=${bodies.length} `
    + `spokenBodyChars=${mergedRow.bodyChars} carryInMemory=0`,
  );
});

// ---------------------------------------------------------------------------
// 7. No character-budget truncation: every point reaches the organizer
// ---------------------------------------------------------------------------

test('7. no character budget truncates the carried points (negations and conditions kept)', async (t) => {
  const app = await mountRound(t, {
    holdSynth: (text) => text.includes('第1条，如果'),
    replyFor: ({ turn }) => (turn === 1 ? LONG_OLD_BODY : NEW_BODY),
    spoken: (userText) => (userText.includes('<上一轮待传达>') ? LONG_MERGED : LONG_OLD_SPOKEN),
  });
  assert.ok(LONG_OLD_SPOKEN.length > 1200, `fixture exceeds the 1200-char context budget (${LONG_OLD_SPOKEN.length})`);
  app.say('把每一条都讲清楚');
  await waitUntil(() => state.held === 1, 'the first clip is held before any sound');
  app.say('再补充一下');
  const carry = await carryEventOf(app, (payload) => payload.merged === true);
  assert.ok(carry.chars > 1200, `the carried points are not cut to the context budget (${carry.chars})`);
  assert.equal(carry.sentences, 17, 'every old sentence is carried, including the final conclusion');

  await waitUntil(() => app.spokenRequests().length === 2, 'the organized version was requested');
  const request = app.spokenRequests()[1];
  const block = /<上一轮待传达>\n([\s\S]*?)\n<\/上一轮待传达>/u.exec(request.user);
  assert.ok(block !== null, 'the carry block is present');
  assert.equal(block[1], LONG_OLD_SPOKEN, 'the carry block is the old plan verbatim, not a truncated slice');
  assert.equal(block[1].length, carry.chars, 'the whole plan (negations and conditions included) is sent');
  assert.ok(block[1].includes('如果第16步没有反应'), 'the late condition survives');
  assert.ok(block[1].includes('不要马上重启软件'), 'the negation survives');
  assert.ok(!/(?:\.\.\.|…)（?被?截断/iu.test(request.user), 'no truncation marker is inserted');

  state.holdGate.resolve();
  const mergedClips = sentenceClips(LONG_MERGED);
  await playAll(app, mergedClips.length);
  const spoken = joined(app.playerCaptions());
  assert.ok(spoken.includes('不要'), 'the spoken version keeps the negation');
  assert.ok(spoken.includes('如果'), 'the spoken version keeps the condition');
  assert.ok(!spoken.includes('被截断'), 'the spoken version carries no truncation marker');
  t.diagnostic(
    `oldChars=${LONG_OLD_SPOKEN.length} carryChars=${carry.chars} >1200=yes sentences=${carry.sentences} `
    + `blockVerbatim=yes spokenKeepsNegation=yes`,
  );
});

// ---------------------------------------------------------------------------
// 8. P2-2: a failed organizer speaks the new conclusion, never the old budget hog
// ---------------------------------------------------------------------------

test('8. a failed organizer plays the new conclusion and never spends the budget on old points', async (t) => {
  const head1 = '旧要点一：先确认采集源类型。';
  const head2 = '旧要点二：窗口采集要选中目标窗口。';
  const head3 = '旧要点三：如果还黑屏就点开采集属性确认一次';
  const OLD_PLAN = `${head1}${head2}${head3}${'旧'.repeat(1158 - head1.length - head2.length - head3.length - 1)}。`;
  const OLD_BODY = `${OLD_PLAN}${'旧正文补充。'.repeat(20)}`;
  const newHead = '新结论：把编码器改成硬件编码，然后重启一次采集，画面就会出来';
  const NEW_106 = `${newHead}${'了'.repeat(106 - newHead.length - 1)}。`;
  assert.equal(OLD_PLAN.length, 1158);
  assert.equal(NEW_106.length, 106);
  assert.ok(OLD_BODY.length > OLD_PLAN.length, 'fixture: the body is longer than the spoken plan');

  const app = await mountRound(t, {
    holdSynth: (text) => text.includes('旧要点一'),
    replyFor: ({ turn }) => (turn === 1 ? OLD_BODY : NEW_106),
    // The first round organizes normally; the carry round returns nothing usable (organizer failed).
    spoken: (userText) => (userText.includes('<上一轮待传达>') ? '' : OLD_PLAN),
  });
  app.say('OBS 全黑怎么调');
  await waitUntil(() => state.held === 1, 'the first old clip is held before any sound');
  await app.waitForEvent('voice.response.group.ready', (payload) => payload.version === 1);
  assert.equal(app.players().length, 0, 'no old sentence reached the player');

  app.say('补充一下，那编码器呢');
  const carry = await carryEventOf(app, (payload) => payload.merged === true);
  assert.equal(carry.sentences, 3);
  assert.equal(carry.chars, OLD_PLAN.length, 'the whole old plan is the carry material');

  state.holdGate.resolve();
  await waitUntil(() => app.spokenRequests().length === 2, 'the carry round asked the organizer');
  // P2-3: the whole-answer (blocking) outlet names the current question too; the carried points are
  // extra context, never a replacement for what this turn actually asked.
  const carryRequest = app.spokenRequests().at(-1);
  assert.ok(String(carryRequest.system).includes('【当前用户问题】补充一下，那编码器呢'),
    'the blocking answer rewrite carries the current user question');
  assert.ok(String(carryRequest.user).includes('<上一轮待传达>'),
    'the carried points are still passed beside the question');
  const fallback = await app.waitForEvent('voice.spoken.fallback');
  assert.equal(fallback.reason, 'empty', 'the organizer returned no usable spoken version');

  const clips = sentenceClips(NEW_106);
  await waitUntil(() => app.players().length === clips.length, 'the new conclusion reached the player');
  const captions = app.playerCaptions();
  assert.deepEqual(captions, clips, 'only the current answer is played');
  assert.ok(!captions.join('').includes('旧要点'), 'no old point is spoken');
  await playAll(app, clips.length);
  const done = await app.waitForEvent('voice.response.group.done');
  assert.equal(done.reason, 'played');
  await tick(20);
  assert.equal(app.players().length, clips.length, 'the held, superseded old clip never plays');
  t.diagnostic(
    `carry=${carry.sentences}句/${carry.chars}字 new=${NEW_106.length}字/1句 budget=1200 `
    + `fallback=${fallback.reason} playedNew=${captions.join('').length} oldPlayed=0`,
  );
});

// ---------------------------------------------------------------------------
// 9. P2: a corrected point is superseded, never deferred, never revived
// ---------------------------------------------------------------------------

test('9. a corrected never-spoken point is superseded and a later fallback cannot revive it', async (t) => {
  const A_PLAN = '先重启软件。';
  const B_BODY = '更正：不要重启软件，先换一个采集源。';
  const C_BODY = '确认采集源的目标窗口即可，如果还是黑屏，就把窗口采集的属性重新点开确认一次，顺便看一眼采集源的类型有没有选错，最后再看看场景里有没有多余的滤镜。';
  const app = await mountRound(t, {
    // A never really starts sounding: its first clip is held before any audio.
    holdSynth: (text) => text.includes('先重启软件'),
    replyFor: ({ turn }) => (turn === 1 ? A_PLAN : turn === 2 ? B_BODY : C_BODY),
    // The organizer fails on the carry round AND on C: both fall back deterministically.
    spoken: () => '',
  });

  app.say('OBS 全黑怎么调');
  await waitUntil(() => state.held === 1, 'A\'s clip is held before any sound');
  const firstGroup = (await app.waitForEvent('voice.response.group.ready', (payload) => payload.version === 1)).groupId;
  assert.equal(app.players().length, 0, 'A never reached the player');

  app.say('补充一下，那采集源呢');
  const carry = await carryEventOf(app, (payload) => payload.merged === true);
  assert.equal(carry.priorGroupId, firstGroup, 'A\'s never-spoken point is the carry material');
  assert.equal(carry.sentences, 1);
  const retired = await carryEventOf(app, (payload) => payload.superseded >= 1);
  assert.equal(retired.superseded, 1, 'the corrected A point is superseded');
  assert.equal(retired.deferred, 0, 'nothing is deferred: a correction is not a budget defer');
  assert.equal(retired.reason, 'superseded');

  state.holdGate.resolve();
  await waitUntil(() => app.players().length >= 1, 'B\'s correction reached the player');
  assert.equal(app.playerCaptions()[0], B_BODY, 'the correction itself plays normally');
  await playAll(app, 1);
  await app.waitForEvent('voice.response.group.done', (payload) => payload.reason === 'played');
  assert.equal(joined(app.playerCaptions()), B_BODY, 'B says exactly the correction, never the old point');

  app.say('再补充一句，那窗口呢');
  const cClips = sentenceClips(C_BODY);
  await waitUntil(() => app.players().length >= 2, 'C\'s fallback answer reached the player');
  const request = app.spokenRequests().at(-1);
  assert.ok(!request.system.includes(CARRY_CONVEY_SYSTEM_NOTE), 'C gets no carry instruction');
  assert.ok(!request.user.includes('<上一轮待传达>'), 'nothing is carried into C');
  await playAll(app, 1 + cClips.length);
  const captions = app.playerCaptions();
  assert.deepEqual(captions.slice(1), cClips, 'C plays only its own current body');
  const spoken = captions.join('');
  assert.ok(!spoken.includes('先重启软件'), 'the corrected A point never comes back');
  assert.equal(spoken.split('采集源的目标窗口').length - 1, 1, 'the current body is said exactly once');
  const rows = await app.events();
  assert.equal(
    rows.filter((event) => event.type === 'voice.carry.convey' && event.payload.merged === true).length,
    1,
    'only B carries; the corrected point is never re-carried',
  );
  await tick(20);
  assert.ok(!app.playerCaptions().join('').includes('先重启软件'), 'no late clip revives the old point');
  t.diagnostic(
    `A="${A_PLAN}" B="${B_BODY}" superseded=${retired.superseded} deferred=${retired.deferred} `
    + `Bplayed="${captions[0]}" Cclips=${cClips.length} Cplayed="${captions.slice(1).join('|')}" `
    + `staleReplay=0 merges=1`,
  );
});

// ---------------------------------------------------------------------------
// 10. P2: a late organizer result for B (version 2) never clears C's (version 3) carry
// ---------------------------------------------------------------------------

test('10. a late version-2 organizer result never clears version 3\'s carry', async (t) => {
  const A_BODY = '第一轮：先重启软件。';
  const B_BODY = '其实不用重启软件，先换一个采集源。';
  const C_BODY = '第三轮：确认采集源的目标窗口就行。';
  // B's organizer answer is held until AFTER C has opened version 3: the late result must not
  // retire the points version 3 already owns.
  const lateB = deferred();
  t.after(() => lateB.resolve());
  const app = await mountRound(t, {
    holdSynth: (text) => text.includes('先重启软件'),
    replyFor: ({ turn }) => (turn === 1 ? A_BODY : turn === 2 ? B_BODY : C_BODY),
    spoken: (userText) => (userText.includes(B_BODY) ? lateB.promise.then(() => '') : ''),
  });

  app.say('OBS 全黑怎么调');
  await waitUntil(() => state.held === 1, 'A\'s only clip is held before any sound');
  const firstGroup = (await app.waitForEvent('voice.response.group.ready', (payload) => payload.version === 1)).groupId;

  app.say('补充一下，那采集源呢');
  const bCarry = await carryEventOf(app, (payload) => payload.answerVersion === 2 && payload.merged === true);
  assert.equal(bCarry.priorGroupId, firstGroup, 'B carries A\'s never-spoken point');
  assert.equal(bCarry.sentences, 1);
  // B's spoken organizer is now in flight (held): its result will arrive late.
  await waitUntil(
    () => app.spokenRequests().some((request) => request.user.includes(B_BODY)),
    'B\'s organizer was requested',
  );

  app.say('再补充一句，那编码器呢');
  const cCarry = await carryEventOf(app, (payload) => payload.answerVersion === 3 && payload.merged === true);
  assert.equal(cCarry.groupId, firstGroup, 'violation is about one group version');
  assert.equal(cCarry.sentences, 2, 'C holds A\'s point plus B\'s body');

  // B's late organizer result resolves now (still version 2): it must be refused as stale.
  lateB.resolve();
  const late = await app.waitForEvent(
    'voice.carry.convey',
    (payload) => payload.answerVersion === 2 && (payload.staleVersionRejected === true || payload.superseded > 0),
  );
  assert.equal(late.staleVersionRejected, true, 'the late version-2 retirement is refused');
  assert.equal(late.reason, 'stale-version');
  assert.equal(late.superseded, 0, 'nothing was retired from version 3');
  assert.equal(late.currentVersion, 3);
  const rows = await app.events();
  const v2Rows = rows.filter((event) => event.type === 'voice.carry.convey' && event.payload.answerVersion === 2);
  assert.equal(
    v2Rows.filter((event) => event.payload.superseded > 0).length,
    0,
    'no version-2 row reports a retirement of version 3 points',
  );
  t.diagnostic(
    `A="${A_BODY}" B(late,v2) refused=${late.reason} superseded=${late.superseded} `
    + `C(v3)carry=${cCarry.sentences}句/${cCarry.chars}字 current=${late.currentVersion}`,
  );
});
