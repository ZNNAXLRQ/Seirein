/**
 * One complete answer, two expressions, one voice outlet.
 *
 * The session and the auto-memory record the FULL body once. The automatic lane speaks exactly one
 * spoken version: the original text for a short answer, a condensed rewrite for a long one, and the
 * full body (with `voice.spoken.fallback`) when the rewrite fails. `assistant_say` is only an
 * explicit standalone/progress line and never replaces the final answer.
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
const { apply, splitSentences, voiceSessionTarget } = await import('../src/host/index.js');
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
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-spoken-version-'));
  await mkdir(join(root, 'data'), { recursive: true });
  await mkdir(join(root, 'workspace'), { recursive: true });
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
  assert.ok(version.chars < [...LONG_BODY].length * 0.8, `condensed ${version.chars} < 80% of ${[...LONG_BODY].length}`);
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

  // Validation failure (the model returned something that is not shorter) takes the same path.
  const invalid = await mountRound(t, { replyText: LONG_BODY, spoken: () => LONG_BODY });
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
