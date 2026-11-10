/**
 * One complete answer, two expressions, one voice outlet.
 *
 * The session and the auto-memory record the FULL body once. The automatic lane speaks exactly one
 * spoken version: the original text for a short answer, a short response organized around what the
 * current turn needs (not "the whole body, compressed"), and the full body (with
 * `voice.spoken.fallback`) when the rewrite fails. `assistant_say` is only an explicit
 * standalone/progress line and never replaces the final answer.
 *
 * Run: node --test test/spoken-version.mjs
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { registerHooks } from 'node:module';
import { Readable } from 'node:stream';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { cleanupRoot, disposeAll } from './helpers/cleanup.mjs';

const state = {
  players: [], texts: [], subtitles: [], synth: null, onUpdate: null, replyTurnId: null, turnIds: [],
};
globalThis.__spokenVersion = state;

const ttsUrl = new URL('../src/host/speech/tts.js', import.meta.url).href;
const sightUrl = new URL('../src/host/vision/sight.js', import.meta.url).href;
const subtitleUrl = new URL('../src/host/subtitle/subtitle.js', import.meta.url).href;
const hearingUrl = new URL('../src/host/hearing/hearing.js', import.meta.url).href;

const hooks = registerHooks({
  load(url, context, next) {
    if (url === hearingUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
    const s = globalThis.__spokenVersion;
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
    if (url === ttsUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
    const s = globalThis.__spokenVersion;
    export { resolveGptLangs, resolveGptSovitsTimeout } from '${ttsUrl}?spoken-helpers';
    export { speakChunks, speechChunkTexts } from '${ttsUrl}?spoken-chunk';
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
    export function readObservation(o) { return { ...(o ?? {}), stale: false }; }`,
      };
    }
    if (url === subtitleUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
    export const averageColor = async () => null;
    export { SubtitleHold } from '${subtitleUrl}?spoken-real';
    export class SubtitleOverlay {
      constructor({ config }) { this.config = config; }
      async show(text, region, colors, options = {}) {
        if (typeof options.isCurrent === 'function' && options.isCurrent() !== true) return false;
        globalThis.__spokenVersion.subtitles.push({ text, at: Date.now() });
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
const { apply, normalizeSpokenVersion, splitSentences, voiceSessionTarget } = await import('../src/host/index.js');
hooks.deregister();
after(() => { delete globalThis.__spokenVersion; });

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

// A body that is long by both measures (>60 chars and >2 sentences).
const LONG_BODY = '先说结论：明天出门要带伞，因为下午有雨。具体来说，上午云量会逐渐增多，中午以后降水概率升到七成，傍晚还有一阵较强的风。必要条件是带上防水外套和一把结实的伞。下一步：今晚先把伞放进包里，明早出门前再看一次雷达图。另外，如果临时有变，我会再提醒你。';
const LONG_SPOKEN = '结论：明天出门要带伞，下午有雨，必要条件是防水外套和结实的伞，下一步是今晚把伞放进包里，明早再看一次雷达图。';
const BODY_ONLY = '上午云量会逐渐增多';
const SHORT_BODY = '现在下午三点。';
const FULL_READ_UTTERANCE = '详细讲一下明天的天气';

const spokenRequestOf = (options) => String(options?.system ?? '').includes('可直接朗读的口语版')
  || String(options?.messages?.[0]?.content?.[0]?.text ?? '').includes('<完整答复>');
/** The two text halves a spoken-version request sends; used to compare/assert question input. */
const requestTextOf = (options) => ({
  system: String(options?.system ?? ''),
  user: String(options?.messages?.[0]?.content?.[0]?.text ?? ''),
});

/**
 * Real mounted host: synthetic microphone + fake TTS/player/subtitle + a fake agent loop. The only
 * model calls that happen are the ones the host makes for a spoken version (the fake loop never
 * calls the model), so `spokenRequests.length` is the second-call count.
 */
async function mountRound(t, {
  replyText = SHORT_BODY,
  replyTexts = null,
  spoken = () => LONG_SPOKEN,
  spokenError = null,
  spokenDelayMs = 0,
  beforeReply = null,
  personaText = '',
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-spoken-version-'));
  await mkdir(join(root, 'data'), { recursive: true });
  await mkdir(join(root, 'workspace'), { recursive: true });
  if (personaText.length > 0) {
    await mkdir(join(root, 'memory'), { recursive: true });
    await writeFile(join(root, 'memory', 'persona.md'), personaText);
  }
  await writeFile(join(root, 'data', 'features.json'), JSON.stringify({
    hearing: true, ambient: false, voice: true, vision: false,
    subtitle: true, avatar: false, memory: true, fastpath: false,
  }));
  await writeFile(join(root, 'data', 'settings.json'), JSON.stringify({
    gptSovits: { enabled: false },
    langs: { speech: 'zh', subtitle: 'zh' },
    voice: { chunking: false },
    subtitle: {
      enabled: true, mode: 'region', region: { left: 0, top: 0, width: 320, height: 100 },
    },
  }));
  state.players = [];
  state.texts = [];
  state.subtitles = [];
  state.onUpdate = null;
  state.replyTurnId = null;
  state.turnIds = [];
  state.synth = async ({ text }) => {
    state.texts.push(text);
    return { file: join(root, 'tts', `${state.texts.length}.mp3`), bytes: 16, durationMs: 200, provider: 'edge-tts' };
  };

  const spokenRequests = [];
  const allRequests = [];
  const streamOf = (text) => (async function* generate() {
    yield { type: 'text-delta', text };
    yield { type: 'finish', reason: { kind: 'stop' } };
  })();
  const llm = {
    resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'off' }] } }),
    stream(options) {
      allRequests.push(options);
      if (!spokenRequestOf(options)) return streamOf('稍等，我在查。');
      spokenRequests.push(options);
      if (spokenError !== null) {
        return (async function* fail() { throw spokenError; })();
      }
      const source = String(options?.messages?.[0]?.content?.[0]?.text ?? '');
      return (async function* generate() {
        if (spokenDelayMs > 0) await tick(spokenDelayMs);
        yield { type: 'text-delta', text: spoken(source) };
        yield { type: 'finish', reason: { kind: 'stop' } };
      })();
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
      async create(path) { return { id: 'ws-spoken-version', path }; },
      get() { return { id: 'ws-spoken-version', async attachSession() {} }; },
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
        try { entry.fn(...args); } catch { /* isolate like the real bus */ }
      }
    },
  };
  // The typed lane: a session the voice delivery never claimed. Same event shapes the real feed
  // writes, so `condenseForSpeech` is exercised without an agent loop.
  const typedSession = { id: 'spoken-version-typed', header: { cwd: join(root, 'workspace') }, append() {} };
  let typedSeq = 0;
  const driveTyped = (turn, { body, utterance = '明天出门要注意什么' } = {}) => {
    const fire = (type, data) => bus.fire('session/event', typedSession, {
      type, seq: ++typedSeq, time: Date.now(), data,
    });
    fire('turn/start', { turn });
    fire('user/message', {
      turn, id: `u-${turn}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: utterance }],
    });
    fire('assistant/message', {
      turn, step: 1, message: { id: `a-${turn}`, role: 'assistant', content: [{ type: 'text', text: body }] },
    });
    fire('turn/end', { turn, reason: { kind: 'completed' } });
  };
  const makeAgent = (sessionId) => {
    const session = { id: sessionId, header: { cwd: join(root, 'workspace') }, append() {} };
    let turn = 0;
    return {
      id: sessionId,
      session,
      followup(message) {
        turn += 1;
        const turnId = turn;
        const text = JSON.stringify(message?.content ?? message);
        const isDigest = text.includes('以下内容作为长期约束与背景');
        const fire = (type, data) => bus.fire('session/event', session, {
          type, seq: state.turnIds.length + turnId, time: Date.now(), data,
        });
        void (async () => {
          fire('turn/start', { turn: turnId });
          state.turnIds.push(turnId);
          fire('user/message', message);
          if (isDigest !== true) {
            state.replyTurnId = turnId;
            if (beforeReply !== null) await beforeReply.promise;
          }
          if (isDigest !== true) {
            const texts = Array.isArray(replyTexts) && replyTexts.length > 0 ? replyTexts : [replyText];
            for (const [index, text] of texts.entries()) {
              fire('assistant/message', {
                turn: turnId,
                step: 1,
                message: {
                  id: `a-${turnId}-${index}`, role: 'assistant', content: [{ type: 'text', text }],
                },
              });
            }
          }
          fire('turn/end', { turn: turnId, reason: { kind: 'completed' } });
        })().catch(() => {});
      },
    };
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
  const started = await listen.execute({ action: 'start' });
  assert.equal(started.ok, true, `listening started: ${started.error ?? ''}`);
  const sessionTarget = voiceSessionTarget({ root });
  const exec = { agent: { session: { id: sessionTarget.sessionId } } };

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
    toolSay: (args) => tools.get('assistant_say').execute(args, exec),
    driveTyped,
    typedSession,
    events,
    waitForEvent,
    players: () => state.players,
    texts: () => state.texts,
    subtitles: () => state.subtitles,
    spokenRequests,
    allRequests,
    replyTurnId: () => state.replyTurnId,
    releaseReply: () => beforeReply?.resolve(),
  };
}

/** Resolve every clip the given spoken text produces, in order. */
async function playText(app, text, timeoutMs = 6000) {
  const sentences = splitSentences(text);
  for (let index = 0; index < sentences.length; index += 1) {
    await waitUntil(() => app.players().length >= index + 1, `clip ${index} reached the player`, timeoutMs);
    app.players()[index].onStart?.({ startedAt: Date.now() });
    app.players()[index].resolve();
    await tick(5);
  }
  return sentences.length;
}

// ---------------------------------------------------------------------------
// 1. Short answer: the original text, no second model call
// ---------------------------------------------------------------------------
test('1. a short answer is spoken verbatim and makes no second model call', async (t) => {
  const app = await mountRound(t, { replyText: SHORT_BODY });
  app.say('现在几点');
  await waitUntil(() => app.players().length === 1, 'the short answer reached the player');
  await playText(app, SHORT_BODY);
  const version = await app.waitForEvent('voice.spoken.version');
  assert.equal(app.spokenRequests.length, 0, 'no spoken-version request for a short answer');
  assert.equal(version.source, 'original');
  assert.equal(version.chars, [...SHORT_BODY].length);
  assert.equal(version.ms, 0);
  assert.deepEqual(app.texts(), [SHORT_BODY]);
  t.diagnostic(`spokenRequests=0 synth=${JSON.stringify(app.texts())} source=${version.source} chars=${version.chars}`);
});

// ---------------------------------------------------------------------------
// 2. Long answer: one condensed version, shorter than the body, conclusion kept
// ---------------------------------------------------------------------------
test('2. a long answer gets one condensed spoken version that keeps the key conclusion', async (t) => {
  const app = await mountRound(t, { replyText: LONG_BODY, spoken: () => LONG_SPOKEN });
  app.say('明天出门要注意什么');
  await waitUntil(() => app.players().length >= 1, 'the condensed version reached the player');
  await playText(app, LONG_SPOKEN);
  const version = await app.waitForEvent('voice.spoken.version');
  assert.equal(app.spokenRequests.length, 1, 'exactly one spoken-version call');
  assert.equal(version.source, 'condensed');
  // The shape contract is "shorter than the body"; there is no fixed compression ratio.
  assert.ok(version.chars < [...LONG_BODY].length, `spoken ${version.chars} < body ${[...LONG_BODY].length}`);
  const spokenText = app.texts().join('');
  assert.ok(spokenText.includes('结论'), 'the conclusion is kept');
  assert.ok(spokenText.includes('下一步'), 'the next step is kept');
  assert.ok(!spokenText.includes(BODY_ONLY), 'the long argument is not read aloud');
  assert.ok(!app.texts().some((text) => text.includes(BODY_ONLY)), 'the full body is never synthesized too');
  const first = await app.waitForEvent('voice.first-sentence');
  assert.equal(first.spokenVersionUsed, true, 'the first-sentence row records adoption');
  assert.ok(first.spokenVersionMs > 0, 'the first-sentence row records spokenVersionMs');
  assert.equal(first.spokenSource, 'condensed');
  t.diagnostic(
    `calls=${app.spokenRequests.length} chars=${version.chars}/${[...LONG_BODY].length} `
    + `ratio=${(version.chars / [...LONG_BODY].length).toFixed(2)} source=${version.source}`,
  );
});

// ---------------------------------------------------------------------------
// 3. Memory: exactly one assistant record, the full body (never the spoken version)
// ---------------------------------------------------------------------------
test('3. memory records one full-body assistant message, never a second spoken-version message', async (t) => {
  const app = await mountRound(t, { replyText: LONG_BODY, spoken: () => LONG_SPOKEN });
  app.say('明天出门要注意什么');
  await app.waitForEvent('memory.auto', (payload) => payload.role === 'assistant');
  await playText(app, LONG_SPOKEN);
  const db = new DatabaseSync(join(app.root, 'memory', 'memory.db'));
  const rows = db.prepare("select role, text from memory_event where session_id = ? and hidden = 0 order by ts").all(app.sessionId);
  db.close();
  const assistantRows = rows.filter((row) => row.role === 'assistant');
  assert.equal(assistantRows.length, 1, 'one assistant memory record');
  assert.ok(assistantRows[0].text.includes(BODY_ONLY), 'the record is the full body');
  assert.ok(assistantRows[0].text.includes('如果临时有变'), 'the full body tail is recorded');
  assert.ok(!rows.some((row) => row.role === 'assistant' && row.text === LONG_SPOKEN), 'the spoken version is not a memory row');
  t.diagnostic(`assistantRows=${assistantRows.length} chars=${assistantRows[0].text.length} fullBodyOnly=yes`);
});

// ---------------------------------------------------------------------------
// 4. One automatic playback: the condensed version only, never short + full twice
// ---------------------------------------------------------------------------
test('4. one answer is played once: only the spoken version, no full-body replay', async (t) => {
  const app = await mountRound(t, { replyText: LONG_BODY, spoken: () => LONG_SPOKEN });
  app.say('明天出门要注意什么');
  await playText(app, LONG_SPOKEN);
  await tick(80);
  const rows = await app.events();
  const answerVersions = rows.filter((event) => event.type === 'voice.spoken.version' && event.payload.purpose === 'answer');
  assert.equal(answerVersions.length, 1, 'one spoken-version decision for the answer');
  assert.equal(app.players().length, 1, 'one automatic clip');
  assert.equal(app.texts().length, 1, 'one synthesis for the automatic lane');
  assert.equal(app.texts()[0], LONG_SPOKEN);
  assert.ok(!app.texts().join('').includes(BODY_ONLY), 'the full body is never replayed by the automatic lane');
  t.diagnostic(`players=${app.players().length} syntheses=${app.texts().length} answerTasks=${answerVersions.length}`);
});

// ---------------------------------------------------------------------------
// 5. assistant_say is still an independent progress line and never skips the answer
// ---------------------------------------------------------------------------
test('5. a progress line plays independently and does not replace the final answer', async (t) => {
  const gate = deferred();
  const app = await mountRound(t, { replyText: SHORT_BODY, beforeReply: gate });
  app.say('帮我查一下天气');
  await waitUntil(() => app.replyTurnId() !== null, 'the reply turn started');
  const progress = await app.toolSay({ text: '我去查，稍等。', purpose: 'progress' });
  assert.equal(progress.accepted, true, `progress accepted: ${progress.reason ?? ''}`);
  await waitUntil(() => app.players().length === 1, 'the progress clip started');
  app.players()[0].resolve();
  // The same turn + replyVersion + purpose is one task: a different text is not a second task.
  const repeat = await app.toolSay({ text: '还在查，再等等。', purpose: 'progress' });
  assert.equal(repeat.accepted, false, 'a repeated progress task is refused');
  gate.resolve();
  await waitUntil(() => app.players().length === 2, 'the final answer still played');
  app.players()[1].onStart?.({ startedAt: Date.now() });
  app.players()[1].resolve();
  assert.equal(app.texts()[1], SHORT_BODY, 'the final answer was spoken after the progress line');
  t.diagnostic(`progress=${progress.speechId} duplicateRefused=${repeat.accepted === false} answerPlayed=${app.texts()[1] === SHORT_BODY}`);
});

// ---------------------------------------------------------------------------
// 6. "详细讲" -> the full body, no rewrite
// ---------------------------------------------------------------------------
test('6. an explicit full-read request speaks the whole body without a rewrite', async (t) => {
  const app = await mountRound(t, { replyText: LONG_BODY, spoken: () => LONG_SPOKEN });
  app.say(FULL_READ_UTTERANCE);
  await playText(app, LONG_BODY);
  await tick(50);
  assert.equal(app.spokenRequests.length, 0, 'the full-read request never generates a spoken version');
  assert.ok(app.texts().join('').includes(BODY_ONLY), 'the full body is spoken');
  assert.ok(!app.texts().includes(LONG_SPOKEN), 'the condensed text is not used');
  const version = await app.waitForEvent('voice.spoken.version');
  assert.equal(version.source, 'original');
  t.diagnostic(`spokenRequests=0 source=${version.source} clips=${app.texts().length}`);
});

// ---------------------------------------------------------------------------
// 7. Rewrite failure -> the full body, with an explicit fallback event
// ---------------------------------------------------------------------------
test('7. a failed spoken version falls back to the full body and records the reason', async (t) => {
  const app = await mountRound(t, {
    replyText: LONG_BODY,
    spokenError: Object.assign(new Error('provider down'), { code: 'SPOKEN_UNAVAILABLE' }),
  });
  app.say('明天出门要注意什么');
  await playText(app, LONG_BODY);
  await tick(50);
  const fallback = await app.waitForEvent('voice.spoken.fallback');
  assert.equal(fallback.reason, 'SPOKEN_UNAVAILABLE');
  const version = await app.waitForEvent('voice.spoken.version');
  assert.equal(version.source, 'full-fallback');
  assert.equal(version.refused, true);
  assert.ok(app.texts().join('').includes(BODY_ONLY), 'the full body is spoken, not a truncated summary');
  assert.ok(!app.texts().includes(LONG_SPOKEN), 'no condensed text was played');
  t.diagnostic(`fallbackReason=${fallback.reason} source=${version.source} clips=${app.texts().length}`);

  // Validation failure (the model returned something longer than the body) takes the same path.
  // Equal length is allowed since turn 11; only an actually longer candidate is not-shorter.
  const invalid = await mountRound(t, { replyText: LONG_BODY, spoken: () => `${LONG_BODY}再补一句。` });
  invalid.say('明天出门要注意什么');
  await playText(invalid, LONG_BODY);
  const rejected = await invalid.waitForEvent('voice.spoken.fallback');
  assert.equal(rejected.reason, 'not-shorter');
  const rejectedVersion = await invalid.waitForEvent('voice.spoken.version');
  assert.equal(rejectedVersion.source, 'full-fallback');
  assert.ok(invalid.texts().join('').includes(BODY_ONLY), 'the full body is spoken after a failed validation');
});

// ---------------------------------------------------------------------------
// 8. First audio is not slowed by the rewrite: ready vs failed
// ---------------------------------------------------------------------------
test('8. the first audio is not slower than +200ms when the spoken version is ready', async (t) => {
  const failed = await mountRound(t, {
    replyText: LONG_BODY,
    spokenError: Object.assign(new Error('provider down'), { code: 'SPOKEN_UNAVAILABLE' }),
  });
  const failedStartedAt = Date.now();
  failed.say('明天出门要注意什么');
  await waitUntil(() => failed.players().length === 1, 'the fallback clip reached the player');
  const baselineMs = failed.players()[0].startedAt - failedStartedAt;
  failed.players()[0].onStart?.({ startedAt: Date.now() });
  failed.players()[0].resolve();
  // Finish the whole fallback body before mounting the second host: the global fake player list
  // must not receive a late clip from the first round.
  for (let index = 1; index < splitSentences(LONG_BODY).length; index += 1) {
    await waitUntil(() => failed.players().length >= index + 1, `fallback clip ${index} reached the player`);
    failed.players()[index].resolve();
  }
  await failed.waitForEvent('voice.first-sentence');

  const ready = await mountRound(t, { replyText: LONG_BODY, spoken: () => LONG_SPOKEN, spokenDelayMs: 60 });
  const readyStartedAt = Date.now();
  ready.say('明天出门要注意什么');
  await waitUntil(() => ready.players().length === 1, 'the spoken-version clip reached the player');
  const readyMs = ready.players()[0].startedAt - readyStartedAt;
  ready.players()[0].onStart?.({ startedAt: Date.now() });
  ready.players()[0].resolve();
  await ready.waitForEvent('voice.first-sentence');

  assert.ok(
    readyMs <= baselineMs + 200,
    `first audio ready=${readyMs}ms baseline=${baselineMs}ms (allowed ${baselineMs + 200}ms)`,
  );
  t.diagnostic(`firstAudio baseline(failed)=${baselineMs}ms ready=${readyMs}ms delta=${readyMs - baselineMs}ms`);
});

// ---------------------------------------------------------------------------
// 9. Subtitle follows the actual spoken content (the condensed version)
// ---------------------------------------------------------------------------
test('9. the subtitle follows the spoken version, not the full body', async (t) => {
  const app = await mountRound(t, { replyText: LONG_BODY, spoken: () => LONG_SPOKEN });
  app.say('明天出门要注意什么');
  await waitUntil(() => app.players().length === 1, 'the clip reached the player');
  app.players()[0].onStart?.({ startedAt: Date.now() });
  await waitUntil(() => app.subtitles().length >= 1, 'the caption appeared');
  const caption = app.subtitles()[0].text;
  assert.ok(caption.includes('结论'), 'the caption is the spoken content');
  assert.ok(!caption.includes(BODY_ONLY), 'the caption is not the full body');
  app.players()[0].resolve();
  t.diagnostic(`captionChars=${caption.length} bodyChars=${[...LONG_BODY].length} followsSpoken=yes`);
});

// ---------------------------------------------------------------------------
// 10. A lead-in followed by the conclusion: the conclusion is still spoken
// ---------------------------------------------------------------------------
test('10. a short lead-in does not freeze the spoken version before the conclusion', async (t) => {
  const lead = '我先说明一下现状。';
  const conclusion = '最终结论：不要删除数据，先备份，然后再检查索引；如果索引异常，先停服务再恢复备份，恢复后要重新校验一遍记录数量与最近的写入时间，确认没有遗漏。';
  const app = await mountRound(t, {
    replyTexts: [lead, conclusion],
    spoken: () => '结论：不要删除数据，先备份再检查索引。',
  });
  app.say('我该先做什么');
  // The spoken version must be built from the whole answer, so the conclusion reaches the player.
  await waitUntil(() => app.spokenRequests.length >= 1, 'the spoken-version request was made');
  const asked = String(app.spokenRequests[0]?.messages?.[0]?.content?.[0]?.text ?? '');
  assert.ok(asked.includes('最终结论'), `the rewrite saw the conclusion: ${asked}`);
  await waitUntil(() => app.players().length >= 1, 'the clip reached the player');
  app.players()[0].onStart?.({ startedAt: Date.now() });
  app.players()[0].resolve();
  const version = await app.waitForEvent('voice.spoken.version');
  assert.equal(version.source, 'condensed');
  assert.ok(app.texts().join('').includes('备份'), 'the spoken line carries the conclusion');
  t.diagnostic(`askedHasConclusion=yes source=${version.source} synth=${JSON.stringify(app.texts())}`);
});

// ---------------------------------------------------------------------------
// 11. One very long paragraph is not a "short answer"
// ---------------------------------------------------------------------------
test('11. an 800-character single paragraph is condensed, never read verbatim', async (t) => {
  const long = `${'这是一段很长的说明。'.repeat(0)}${'关于这个问题的背景和细节需要仔细说明，'.repeat(40)}最后结论是保留备份。`;
  const app = await mountRound(t, { replyText: long, spoken: () => '结论：保留备份。' });
  app.say('展开讲讲背景');
  try {
    await waitUntil(() => app.spokenRequests.length >= 1, 'the long paragraph triggered a rewrite');
  } catch (error) {
    const systems = app.allRequests.map((options) => String(options?.system ?? '').slice(0, 40));
    const rows = await app.events();
    const version = rows.find((event) => event.type === 'voice.spoken.version')?.payload ?? null;
    throw new Error(`${error.message} (allRequests=${app.allRequests.length}, systems=${JSON.stringify(systems)}, version=${JSON.stringify(version)})`);
  }
  await waitUntil(() => app.players().length >= 1, 'the condensed clip reached the player');
  app.players()[0].onStart?.({ startedAt: Date.now() });
  app.players()[0].resolve();
  const version = await app.waitForEvent('voice.spoken.version');
  assert.equal(version.source, 'condensed');
  assert.ok(app.texts().join('').length < 100, 'only the short spoken version was synthesized');
  t.diagnostic(`source=${version.source} bodyChars=${[...long].length} spokenChars=${app.texts().join('').length}`);
});

// ---------------------------------------------------------------------------
// 12-19. Need-oriented organization (user-final definition, 2026-11-09)
//
// The spoken version is NOT "the whole body, compressed". The same rewrite request carries five
// steps: identify the need, select the information, keep the conditions that change the conclusion,
// reorganize in persona, then check clarity. Length is a result (no fixed ratio); nothing is cut by
// similarity or by character count.
// ---------------------------------------------------------------------------
const PERSONA_TEXT = '# 人设与用户画像\n\n> 由助手在对话中维护，用户不需要编辑本文件。\n\n- 说话温柔，称呼用户为"你"\n';
const PERSONA_LINE = '- 说话温柔，称呼用户为"你"';

const GUIDE_MARKERS = [
  '1. 识别本次需求',
  '2. 选取需要说的信息',
  '3. 保留所选结论的必要条件',
  '4. 按人设重新组织口头表达',
  '5. 检查清晰度与冗余',
  '直接答案、推荐、差异、解释还是完整列举',
  '按需取用，不默认全部覆盖',
  '首选、主要理由与关键取舍',
  '不逐条读整张表',
  '否定、适用条件、关键数字、时间、风险与不确定性',
  '逐项回应',
  '不照搬正文结构',
  '不靠额外铺垫、撒娇或结尾总结',
  '同一观点通常只说一次',
  '长度是结果不是目标',
  '字数只作软性的防铺陈约束',
  '没有固定压缩比',
];

const assertNeedGuide = (system, label) => {
  assert.ok(system.startsWith('【人设】'), `${label}: the persona section stays first`);
  for (const marker of GUIDE_MARKERS) {
    assert.ok(system.includes(marker), `${label}: missing "${marker}"`);
  }
  // The hard output contract survives: one passage, no headings/list markers.
  assert.ok(system.includes('只输出一段可直接朗读的口语版'), `${label}: one-passage contract`);
  assert.ok(system.includes('不加标题、编号或列表符号'), `${label}: no headings/list markers`);
  // The old "compress the whole body" instruction is gone.
  assert.ok(!system.includes('保留关键结论、必要条件与下一步，省略展开论证'),
    `${label}: the old compression-only instruction was replaced`);
  // No fixed ratio / character target was introduced.
  assert.doesNotMatch(system, /压缩比\s*[为是]?\s*\d|压缩到\s*\d|不超过\s*\d+\s*(?:字|%|％)/u,
    `${label}: no fixed compression ratio or character cap`);
};

const RECOMMEND_BODY = '下面把候选方案列出来。方案A：本地缓存，读取快，但需要额外维护失效逻辑。方案B：远程接口，维护简单，但网络抖动会影响延迟。方案C：混合方案，兼顾两者，但实现成本最高。综合来看，如果每日请求在一万次以内，方案B最省心；如果要求离线可用，方案A更稳。';
const RECOMMEND_SPOKEN = '首选方案B，主要理由是维护简单，代价是网络抖动会影响延迟。';
const COMPLEX_BODY = '结论：不要直接重装系统。前提是硬盘还能正常读取；如果硬盘已经出现异响，请先断电并备份，否则可能扩大损坏。当前错误码是 0x80070005，过去 24 小时出现了 3 次。下一步是明早 9 点前把重要数据复制到外置盘，再决定是否重装。';
const COMPLEX_SPOKEN = '不要直接重装系统：只有硬盘还能正常读取时才能继续；如果硬盘有异响，先断电备份，否则可能扩大损坏。错误码 0x80070005，24 小时内出现了 3 次，明早 9 点前先备份。';
const MULTI_BODY = '先回答你问的两件事：第一，明天下午有雨，降水概率七成，出门带伞。第二，地铁二号线今晚十点后停运，晚归要改乘公交。另外补充一个无关的细节：周末公园有活动。';
const MULTI_SPOKEN = '明天下午有雨，降水概率七成，出门带伞。地铁二号线今晚十点后停运，晚归改乘公交。';

// 12. Typed lane: the five-step guide is the request, with the persona kept above it.
test('12. the typed spoken-version prompt is a five-step need-oriented guide with the persona', async (t) => {
  const app = await mountRound(t, { personaText: PERSONA_TEXT });
  app.driveTyped(1, { body: RECOMMEND_BODY });
  await waitUntil(() => app.spokenRequests.length >= 1, 'the typed spoken-version request was made');
  const system = String(app.spokenRequests[0].system ?? '');
  assertNeedGuide(system, 'typed');
  assert.ok(system.includes(PERSONA_LINE), 'the persona content is still passed to the rewrite');
  assert.ok(system.includes('【当前用户问题】明天出门要注意什么'),
    'typed: the current user question is part of the request');
  assert.equal(app.spokenRequests.length, 1, 'one request: the five steps run inside it, no separate analysis call');
  await playText(app, RECOMMEND_SPOKEN);
  t.diagnostic(`lane=typed systemChars=${system.length} steps=5 separateAnalysisCalls=0`);
});

// 13. Answer/stream lane: the same guide, still one request.
test('13. the answer/stream spoken-version prompt uses the same five-step guide', async (t) => {
  const app = await mountRound(t, { replyText: RECOMMEND_BODY, spoken: () => RECOMMEND_SPOKEN });
  app.say('推荐哪个');
  await waitUntil(() => app.spokenRequests.length >= 1, 'the streamed spoken-version request was made');
  const system = String(app.spokenRequests[0].system ?? '');
  assertNeedGuide(system, 'answer');
  assert.ok(system.includes('【当前用户问题】推荐哪个'),
    'streamed answer: the current user question is part of the request');
  assert.equal(app.spokenRequests.length, 1, 'one request: no extra analysis call');
  // The longer guide does not buy a larger output budget: the existing sizing is untouched.
  assert.equal(
    Number(app.spokenRequests[0].maxTokens),
    Math.min(1024, Math.max(120, Math.ceil(RECOMMEND_BODY.length * 1.5))),
    'the streamed rewrite keeps its existing maxTokens budget',
  );
  assert.equal(app.spokenRequests[0].reasoningEffort, 'off', 'the shared reasoning policy is unchanged');
  await playText(app, RECOMMEND_SPOKEN);
  const version = await app.waitForEvent('voice.spoken.version');
  assert.equal(version.source, 'condensed');
  t.diagnostic(
    `lane=answer systemChars=${system.length} requestCalls=${app.spokenRequests.length} `
    + `maxTokens=${app.spokenRequests[0].maxTokens} source=${version.source}`,
  );
});

// ---------------------------------------------------------------------------
// 13b. P2-3: every spoken-version request carries THIS turn's question
// ---------------------------------------------------------------------------
test('20. 相同正文 + 不同问题 → 口语版请求不同；相同问题 + 相同正文 → 请求稳定', async (t) => {
  const questionA = '只比较 B 的维护成本，不要推荐 A';
  const questionB = '只推荐 C，并说明理由';
  const requestFor = async (utterance) => {
    const app = await mountRound(t);
    app.driveTyped(1, { body: RECOMMEND_BODY, utterance });
    await waitUntil(() => app.spokenRequests.length >= 1, `the spoken-version request for "${utterance}"`);
    return requestTextOf(app.spokenRequests[0]);
  };
  const first = await requestFor(questionA);
  const second = await requestFor(questionB);
  const repeated = await requestFor(questionA);

  assert.ok(first.system.includes(`【当前用户问题】${questionA}`), 'question A is in the request');
  assert.ok(first.system.includes('<完整答复>') || first.user.includes('<完整答复>'),
    'the complete answer is still the request body');
  assert.ok(!first.system.includes(questionB), 'a different turn\'s question is never mixed in');
  assert.ok(second.system.includes(`【当前用户问题】${questionB}`), 'question B is in the request');
  assert.notEqual(second.system, first.system, 'same body with a different question changes the request');
  assert.equal(repeated.system, first.system, 'same question + same body keeps the request stable');
  assert.equal(repeated.user, first.user, 'the answer body is unchanged by the question');
  t.diagnostic(`qA=${first.system.length}chars qB=${second.system.length}chars `
    + `different=${second.system !== first.system} stable=${repeated.system === first.system}`);
});

// 14. Recommendation: first choice + reason + tradeoff, never the whole table.
test('14. a recommendation speaks the first choice, reason and tradeoff, not the whole table', async (t) => {
  const app = await mountRound(t, { replyText: RECOMMEND_BODY, spoken: () => RECOMMEND_SPOKEN });
  app.say('这几个方案推荐哪个');
  await waitUntil(() => app.spokenRequests.length >= 1, 'the recommendation was organized');
  const system = String(app.spokenRequests[0].system ?? '');
  assert.ok(
    system.includes('例如问“推荐哪个”，只说首选、主要理由与关键取舍，不逐条读整张表。'),
    'the prompt turns "推荐哪个" into first choice + reason + tradeoff, not a table read-out',
  );
  await playText(app, RECOMMEND_SPOKEN);
  const spoken = app.texts().join('');
  assert.equal(spoken, RECOMMEND_SPOKEN, 'the model output is spoken verbatim, no post-hoc deletion');
  assert.ok(spoken.includes('首选'), 'first choice kept');
  assert.ok(spoken.includes('理由'), 'main reason kept');
  assert.ok(spoken.includes('代价'), 'key tradeoff kept');
  assert.ok(!spoken.includes('方案A') && !spoken.includes('方案C'), 'the other table rows are not read out');
  t.diagnostic(`recommendation="${spoken}" tableRowsRead=0 synthesizeCalls=${app.texts().length}`);
});

// 15. Complex conditions: negation, condition, number, time and risk survive when they change the answer.
test('15. a conditional answer keeps the negation, condition, numbers and time', async (t) => {
  const app = await mountRound(t, { replyText: COMPLEX_BODY, spoken: () => COMPLEX_SPOKEN });
  app.say('我该直接重装系统吗');
  await waitUntil(() => app.spokenRequests.length >= 1, 'the conditional answer was organized');
  const system = String(app.spokenRequests[0].system ?? '');
  assert.ok(
    system.includes('会改变结论的否定、适用条件、关键数字、时间、风险与不确定性必须保留'),
    'the prompt forbids dropping conditions that change the conclusion',
  );
  await playText(app, COMPLEX_SPOKEN);
  const spoken = app.texts().join('');
  assert.equal(spoken, COMPLEX_SPOKEN);
  assert.ok(spoken.includes('不要'), 'the negation is kept');
  assert.ok(spoken.includes('如果'), 'the condition is kept');
  assert.ok(spoken.includes('0x80070005') && spoken.includes('3 次'), 'the key numbers are kept');
  assert.ok(spoken.includes('明早 9 点'), 'the time is kept');
  t.diagnostic(`keptNegation=yes keptCondition=yes keptNumbers=yes keptTime=yes chars=${[...spoken].length}`);
});

// 16. Multiple questions: every question gets an answer; an unrelated aside is not read.
test('16. when the user asks two things, both are answered item by item', async (t) => {
  const app = await mountRound(t, { replyText: MULTI_BODY, spoken: () => MULTI_SPOKEN });
  app.say('明天带伞吗，地铁还开吗');
  await waitUntil(() => app.spokenRequests.length >= 1, 'the two questions were organized');
  const system = String(app.spokenRequests[0].system ?? '');
  assert.ok(system.includes('用户一次问了多个问题，就逐项回应'), 'the prompt asks for one response per question');
  await playText(app, MULTI_SPOKEN);
  const spoken = app.texts().join('');
  assert.ok(spoken.includes('带伞') && spoken.includes('停运'), 'both questions are answered');
  assert.ok(!spoken.includes('公园'), 'the unrelated aside is not read out');
  t.diagnostic(`answers=2/2 unrelatedAside=omitted chars=${[...spoken].length}`);
});

// 17. Persona: kept as a section, never a mechanical ending.
test('17. the persona stays a section and the prompt forbids a mechanical persona ending', async (t) => {
  const app = await mountRound(t, { personaText: PERSONA_TEXT });
  app.driveTyped(1, { body: RECOMMEND_BODY });
  await waitUntil(() => app.spokenRequests.length >= 1, 'the typed spoken-version request was made');
  const system = String(app.spokenRequests[0].system ?? '');
  const personaAt = system.indexOf('【人设】');
  const guideAt = system.indexOf('1. 识别本次需求');
  assert.ok(personaAt === 0, 'the persona block is first');
  assert.ok(guideAt > personaAt, 'the guide follows the persona, it does not replace it');
  assert.ok(system.includes(PERSONA_LINE), 'the current persona text is present');
  assert.ok(system.includes('不靠额外铺垫、撒娇或结尾总结来机械体现人设'),
    'the prompt explicitly rejects a mechanical ending as persona expression');
  assert.ok(!system.includes('结尾加') && !system.includes('最后说一句'),
    'no instruction asks for an added closing line');
  await playText(app, RECOMMEND_SPOKEN);
  t.diagnostic(`personaAt=${personaAt} guideAt=${guideAt} mechanicalEndingRequired=no`);
});

// 18. "全部读出来" still takes the original path: no rewrite, no forced brevity.
test('18. an explicit "全部读出来" keeps the original full-body path', async (t) => {
  const app = await mountRound(t, { replyText: LONG_BODY, spoken: () => LONG_SPOKEN });
  app.say('把正文全部读出来');
  await playText(app, LONG_BODY);
  await tick(50);
  assert.equal(app.spokenRequests.length, 0, 'no spoken-version request for an explicit full read');
  assert.ok(app.texts().join('').includes(BODY_ONLY), 'the full body is spoken');
  assert.ok(!app.texts().includes(LONG_SPOKEN), 'no shortened version is substituted');
  const version = await app.waitForEvent('voice.spoken.version');
  assert.equal(version.source, 'original');
  t.diagnostic(`spokenRequests=0 source=${version.source} clips=${app.texts().length}`);
});

// 19. Contract: the observation rows keep exactly their pre-change field set.
test('19. voice.spoken.version / voice.spoken.text keep their existing fields', async (t) => {
  const app = await mountRound(t, { replyText: LONG_BODY, spoken: () => LONG_SPOKEN });
  app.say('明天出门要注意什么');
  await playText(app, LONG_SPOKEN);
  const version = await app.waitForEvent('voice.spoken.version');
  assert.deepEqual(Object.keys(version).sort(), [
    'adopted', 'bodyChars', 'chars', 'decision', 'ms', 'purpose', 'ratio', 'reason', 'refused',
    'replyVersion', 'retried', 'savedChars', 'source', 'spokenChars', 'tooLong', 'truncated',
    'turn', 'verdict',
  ]);
  const textRow = await app.waitForEvent('voice.spoken.text', (payload) => payload.purpose === 'answer');
  assert.deepEqual(Object.keys(textRow).sort(), [
    'answerVersion', 'bodyChars', 'groupId', 'purpose', 'source',
    'spokenChars', 'spokenText', 'topicOverlap', 'turn',
  ]);
  assert.equal(textRow.spokenText, LONG_SPOKEN, 'the logged text is the expression that was played');
  assert.equal(textRow.source, version.source);
  t.diagnostic(`versionFields=${Object.keys(version).length} textFields=${Object.keys(textRow).length} source=${version.source}`);
});

// ---------------------------------------------------------------------------
// 21. Equal length is allowed (turn 11: a 166-char body and a 166-char spoken version)
// ---------------------------------------------------------------------------
test('21. 口语版与正文等长时会被标为 too-long，而不是静默当作已压缩', async (t) => {
  const equalBody = '说明'.repeat(83);
  const equalSpoken = '口播'.repeat(83);
  assert.equal([...equalBody].length, 166, 'fixture: the body is 166 characters');
  assert.equal([...equalSpoken].length, 166, 'fixture: the candidate is 166 characters');
  const app = await mountRound(t, { replyText: equalBody, spoken: () => equalSpoken });
  app.say('展开说说');
  await waitUntil(() => app.players().length >= 1, 'the equal-length version reached the player');
  await playText(app, equalSpoken);
  const version = await app.waitForEvent('voice.spoken.version');
  assert.equal(version.source, 'condensed', 'the valid candidate is still played (it is not a truncation)');
  assert.equal(version.refused, false);
  assert.equal(version.chars, 166);
  assert.equal(version.bodyChars, 166);
  assert.equal(version.ratio, 1);
  assert.equal(version.tooLong, true, 'a near-copy of a long body is reported, never silently accepted');
  assert.equal(version.verdict, 'adopted-too-long');
  assert.equal(version.retried, false, 'the streamed lane cannot retry after audio already started');
  const warning = await app.waitForEvent('voice.spoken.too-long');
  assert.equal(warning.reason, 'too-long');
  assert.equal(warning.ratio, 1);
  assert.equal(app.texts().join(''), equalSpoken, 'the 166-char spoken version is played');
  const fallbacks = (await app.events()).filter((event) => event.type === 'voice.spoken.fallback');
  assert.deepEqual(fallbacks, [], 'no fallback row for an equal-length candidate');
  t.diagnostic(`source=${version.source} chars=${version.chars}/${[...equalBody].length} tooLong=${version.tooLong} fallbacks=0`);
});

// ---------------------------------------------------------------------------
// 22. Read-aloud cleanup: formatting is dropped, content words are kept
// ---------------------------------------------------------------------------
test('22. 朗读清理去掉强调/引号/书名号/破折号/emoji，并保留正文实词', async (t) => {
  const source = '本来就很长的一段正文，足够用来做长度基准。';
  const marked = normalizeSpokenVersion(source, '**结论**：“明天——有雨☔️。”');
  assert.equal(marked.ok, true);
  assert.equal(marked.text, '结论：明天，有雨。');
  assert.ok(marked.text.includes('结论') && marked.text.includes('有雨'), 'the content words are kept');
  assert.ok(!marked.text.includes('**') && !marked.text.includes('——'), 'no emphasis/em dash is spoken');

  const quoted = normalizeSpokenVersion(source, '读`三体`，别读《活着》。');
  assert.equal(quoted.text, '读三体，别读活着。', 'backticks and book-title marks are dropped, content kept');

  const paired = normalizeSpokenVersion(source, '「明天有雨」，记得带伞。');
  assert.equal(paired.text, '明天有雨，记得带伞。', 'paired quotation marks are dropped, content kept');
  t.diagnostic(`marked="${marked.text}" quoted="${quoted.text}" paired="${paired.text}"`);
});

// ---------------------------------------------------------------------------
// 23. The length ceiling and the original refusal reasons still hold after cleanup
// ---------------------------------------------------------------------------
test('23. 清理后仍不得长于正文；空串/过短/前言仍按原 reason 拒绝', async (t) => {
  const source = '拿一段足够长的正文，用来做长度上限的基准。';
  const equal = normalizeSpokenVersion(source, source);
  assert.equal(equal.ok, true, 'equality is accepted');
  assert.equal(equal.chars, [...source].length);

  const longer = normalizeSpokenVersion(source, `${source}再补一句。`);
  assert.equal(longer.ok, false);
  assert.equal(longer.reason, 'not-shorter', 'a longer candidate is still refused');

  const preambleSource = '这是正文内容。'.repeat(10);
  const preamble = normalizeSpokenVersion(preambleSource, `好的，${preambleSource.slice(0, 62)}`);
  assert.equal(preamble.ok, false);
  assert.equal(preamble.reason, 'preamble', 'a near-full-length model preamble is still refused');

  assert.equal(normalizeSpokenVersion(source, '😀😀').reason, 'empty', 'emoji-only text cleans to empty');
  assert.equal(normalizeSpokenVersion(source, '好的。').reason, 'too-short', 'a candidate under 4 chars is still too short');
  t.diagnostic(`equal=${equal.chars} longer=${longer.reason} preamble=${preamble.reason} empty/too-short=refused`);
});

// ---------------------------------------------------------------------------
// 24. P2 regression: protect code/identifiers BEFORE removing presentation
// ---------------------------------------------------------------------------
test('24. 清理先保护实质内容：围栏命令与 __debug__ 不被删，无法安全清理时拒绝采用', (t) => {
  const source = '拿一段足够长的正文，用来做清理安全回归的长度基准。'.repeat(2);
  const BT = '`';

  // Probe 1: the fenced command and the condition that follows it must both survive.
  const command = normalizeSpokenVersion(
    source,
    `执行前先备份，${BT.repeat(3)}cleanup --dry-run${BT.repeat(3)}只能在测试目录运行。`,
  );
  assert.equal(command.ok, true, `the command candidate is safe: ${command.reason}`);
  assert.ok(command.text.includes('cleanup --dry-run'), 'the fenced command is kept');
  assert.ok(command.text.includes('只能在测试目录运行'), 'the restriction after the code is kept');

  // Probe 2: the two identifiers must not collapse into the same word.
  const identifiers = normalizeSpokenVersion(source, '设置 __debug__，不要设置 debug。');
  assert.equal(identifiers.ok, true, `the identifier candidate is safe: ${identifiers.reason}`);
  assert.ok(identifiers.text.includes('__debug__'), 'the underscored identifier keeps its underscores');
  assert.ok(identifiers.text.includes('debug'), 'the plain identifier is still there');
  assert.notEqual(identifiers.text, '设置 debug，不要设置 debug。', 'the identifiers never collapse');

  // A cleanup that would change an identifier is refused, never adopted as ok:true.
  const unsafe = normalizeSpokenVersion(source, '设置 _debug_，不要设置 debug。');
  assert.equal(unsafe.ok, false);
  assert.equal(unsafe.reason, 'unsafe-cleanup');
  assert.ok(unsafe.text.includes('_debug_'), 'the unsafe result keeps the un-cleaned text');
  t.diagnostic(
    `command="${command.text}" identifiers="${identifiers.text}" unsafe=${unsafe.reason}`,
  );
});

// ---------------------------------------------------------------------------
// 25. Length gate: a near-copy typed rewrite is retried once with the stronger prompt
// ---------------------------------------------------------------------------
const RETRY_BODY = '先说结论：不要直接删除数据，先备份再检查索引。'.repeat(7);
const RETRY_SPOKEN = '结论：不要直接删除数据，先备份再检查索引；如果索引异常，先停服务再恢复备份。';

test('25. 长正文的口语版接近原文时先重试一次更强缩短，再记录长度数据', async (t) => {
  const calls = [];
  const app = await mountRound(t, {
    spoken: (source) => {
      calls.push(source);
      return calls.length === 1 ? RETRY_BODY : RETRY_SPOKEN;
    },
  });
  app.driveTyped(1, { body: RETRY_BODY });
  await waitUntil(() => app.spokenRequests.length >= 2, 'the too-long candidate was retried once');
  const version = await app.waitForEvent('voice.spoken.version', (payload) => payload.purpose === 'typed');
  const firstSystem = String(app.spokenRequests[0]?.system ?? '');
  const secondSystem = String(app.spokenRequests[1]?.system ?? '');
  assert.equal(calls.length, 2, 'one retry, no unbounded loop');
  assert.ok(firstSystem.includes('【本次长度参考】'), 'the first request carries the soft length target');
  assert.ok(!firstSystem.includes('【更强缩短重试】'), 'the first request uses the normal guide');
  assert.ok(secondSystem.includes('【更强缩短重试】'), 'the retry carries the stronger shortening instruction');
  assert.equal(version.source, 'condensed');
  assert.equal(version.retried, true);
  assert.equal(version.tooLong, false, 'the shorter retry is accepted normally');
  assert.equal(version.verdict, 'adopted');
  assert.equal(version.bodyChars, [...RETRY_BODY].length);
  assert.equal(version.spokenChars, [...RETRY_SPOKEN].length);
  assert.ok(version.ratio < 0.85, `retry ratio ${version.ratio} is no longer a near-copy`);
  assert.equal(version.savedChars, [...RETRY_BODY].length - [...RETRY_SPOKEN].length);
  assert.equal(app.texts().join(''), RETRY_SPOKEN, 'only the shortened retry is spoken');
  const summary = await app.waitForEvent('voice.spoken.summary');
  const last = summary.recent.at(-1);
  assert.equal(last.retried, true);
  assert.equal(last.bodyChars, version.bodyChars);
  assert.equal('spokenText' in last, false, 'the recent summary never stores the spoken text');
  t.diagnostic(
    `retry calls=${calls.length} body=${version.bodyChars} spoken=${version.spokenChars} `
    + `ratio=${version.ratio} tooLong=${version.tooLong}`,
  );
});

test('26. 明确要求逐条完整列举时不强制缩短：不设目标、不重试、still flagged as explicit', async (t) => {
  const calls = [];
  const app = await mountRound(t, {
    spoken: (source) => {
      calls.push(source);
      return RETRY_BODY;
    },
  });
  app.driveTyped(2, { body: RETRY_BODY, utterance: '把要点逐条完整列举' });
  const version = await app.waitForEvent('voice.spoken.version', (payload) => payload.purpose === 'typed');
  assert.equal(calls.length, 1, 'an explicit detail request gets no shortening retry');
  const system = String(app.spokenRequests[0]?.system ?? '');
  assert.ok(!system.includes('【本次长度参考】'), 'an explicit detail request has no length target');
  assert.ok(!system.includes('【更强缩短重试】'));
  assert.equal(version.source, 'condensed');
  assert.equal(version.retried, false);
  assert.equal(version.tooLong, false, 'detail requests are exempt from the too-long gate');
  assert.equal(version.reason, 'explicit-detail');
  assert.equal(version.verdict, 'explicit-detail');
  t.diagnostic(`detail calls=${calls.length} body=${version.bodyChars} spoken=${version.spokenChars} tooLong=${version.tooLong}`);
});

