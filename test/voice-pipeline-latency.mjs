/**
 * Voice first-audio latency, stage 2: the spoken version is delivered as a stream of complete
 * semantic units, translated and synthesized one unit at a time.
 *
 * The pure half (`spokenPipeline.js`) is driven directly: semantic-unit safety, measured block
 * sizing, the short-answer decision and the timeline payload. The host half mounts the real plugin
 * with a fake LLM (timed rewrite deltas + timed translations), fake TTS and a fake player, so the
 * numbers below are real ordering evidence, not estimates.
 *
 * Covered:
 *   1. the first stable unit starts translation + synthesis BEFORE the rewrite finishes
 *   2. negation / condition clauses ("但是" "不可以" "需要先" "除非" "如果…就") are never split
 *   3. the translation pipeline: unit N synthesizes as soon as it is translated, order preserved;
 *      a cancelled turn's late translation never plays
 *   4. generation isolation: a new turn cancels the old one and no late block of the old turn plays
 *   5. a short natural answer skips the spoken version (one model call less); a short but
 *      structured answer does not
 *   6. the same target language shares ONE in-flight translation; the kana form affects only the
 *      speech copy
 *   7. the first block prefers a whole short sentence, sized from measured synthesis cost
 *   8. `voice.pipeline.timeline` measures every stage from the accepted delivery
 *   9. `finish()` commits the unterminated tail as the last unit: no dropped final sentence, no
 *      duplicate, no empty unit, idempotent, and a stream error replays nothing
 *  10. a rewrite without a final full stop plays its last sentence too
 *  11. the streamed rewrite request carries the shared `reasoningEffort: 'off'` policy, so no
 *      reasoning wait can reappear before the first spoken unit
 *
 * Run: node --test test/voice-pipeline-latency.mjs
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { registerHooks } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupRoot, disposeAll } from './helpers/cleanup.mjs';
import {
  buildPipelineTimeline,
  createSpokenUnitStream,
  createUnitSizer,
  shouldSkipSpokenVersion,
  splitSemanticUnits,
  takeSemanticUnits,
} from '../src/host/speech/spokenPipeline.js';

const state = {
  players: [],
  texts: [],
  subtitles: [],
  synth: null,
  synthAt: [],
  onUpdate: null,
  replyTurnId: null,
  turnIds: [],
  rewriteCalls: [],
  rewriteDeltas: [],
  translateCalls: [],
};
globalThis.__pipelineLatency = state;

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
    const s = globalThis.__pipelineLatency;
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
    const s = globalThis.__pipelineLatency;
    export { resolveGptLangs, resolveGptSovitsTimeout } from '${ttsUrl}?pipeline-helpers';
    export { speakChunks, speechChunkTexts } from '${ttsUrl}?pipeline-chunk';
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
    export { SubtitleHold } from '${subtitleUrl}?pipeline-real';
    export class SubtitleOverlay {
      constructor({ config }) { this.config = config; }
      async show(text, region, colors, options = {}) {
        if (typeof options.isCurrent === 'function' && options.isCurrent() !== true) return false;
        globalThis.__pipelineLatency.subtitles.push({ text, at: Date.now() });
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
const host = await import('../src/host/index.js');
hooks.deregister();
const { apply, createReplySpeaker, voiceSessionTarget } = host;
after(() => { delete globalThis.__pipelineLatency; });

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const waitUntil = async (check, message, timeoutMs = 8000) => {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out: ${message}`);
    await tick(10);
  }
};

/** Body long by both measures (>60 chars, >2 sentences): it must go through a rewrite. */
const LONG_BODY = '先说结论：明天出门要带伞，因为下午有雨。上午云量逐渐增多，中午以后降水概率升到七成。'
  + '必要条件是带上防水外套和一把结实的伞。下一步：今晚先把伞放进包里，明早再看一次雷达图。';
const REWRITE_UNITS = ['结论：明天出门要带伞，下午有雨。', '下一步：今晚先把伞放进包里。'];
const SHORT_BODY = '现在下午三点。';

/** Root of one mounted host round. */
async function mountRound(t, {
  replyText = LONG_BODY,
  langs = { speech: 'en', subtitle: 'zh' },
  chunking = true,
  rewrite = null,
  translateDelayMs = 20,
  translate = () => 'Take an umbrella tomorrow.',
  speechSynthDelayMs = 0,
  holdSecondUnit = null,
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-pipeline-latency-'));
  await mkdir(join(root, 'data'), { recursive: true });
  await mkdir(join(root, 'workspace'), { recursive: true });
  await writeFile(join(root, 'data', 'features.json'), JSON.stringify({
    hearing: true, ambient: false, voice: true, vision: false,
    subtitle: true, avatar: false, memory: true, fastpath: false,
  }));
  await writeFile(join(root, 'data', 'settings.json'), JSON.stringify({
    gptSovits: { enabled: false },
    langs,
    voice: { chunking },
    subtitle: { enabled: true, mode: 'region', region: { left: 0, top: 0, width: 320, height: 100 } },
  }));
  state.players = [];
  state.texts = [];
  state.subtitles = [];
  state.synthAt = [];
  state.onUpdate = null;
  state.replyTurnId = null;
  state.turnIds = [];
  state.rewriteCalls = [];
  state.rewriteDeltas = [];
  state.translateCalls = [];
  const synthTexts = state.texts;
  state.synth = async ({ text }) => {
    if (speechSynthDelayMs > 0) await tick(speechSynthDelayMs);
    synthTexts.push(text);
    state.synthAt.push(Date.now());
    return {
      file: join(root, 'tts', `${synthTexts.length}.mp3`), bytes: 16, durationMs: 120, provider: 'edge-tts',
    };
  };

  // The rewrite stream: one delta per semantic unit, with the exact delays the test names. The
  // SECOND unit may be held on a gate so a test can act while the rewrite is still writing.
  // `rewrite` may be a function `(callIndex) => steps` (one script per turn) or a step array.
  const defaultSteps = REWRITE_UNITS.map((text, index) => ({
    text,
    delayMs: index === 0 ? 40 : 700,
    gate: index === 1 ? holdSecondUnit : null,
  }));
  const stepsFor = (callIndex) => (typeof rewrite === 'function'
    ? rewrite(callIndex)
    : (Array.isArray(rewrite) ? rewrite : defaultSteps));
  let rewriteIndex = 0;
  const lastText = (options) => String(options?.messages?.[0]?.content?.[0]?.text ?? '');
  /** The target text of a translation prompt: inside <待译正文>, else the whole user content. */
  const targetOf = (text) => {
    const tagged = /<待译正文>\n([\s\S]*?)\n<\/待译正文>/u.exec(text);
    return tagged !== null ? tagged[1] : text;
  };
  const isTranslation = (system) => system.includes('翻译器') || system.includes('<待译正文>');
  const llm = {
    resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'off' }] } }),
    stream(options) {
      const system = String(options?.system ?? '');
      if (system.includes('口语版')) {
        const steps = stepsFor(rewriteIndex);
        rewriteIndex += 1;
        state.rewriteCalls.push({ at: Date.now(), options });
        return (async function* rewriteStream() {
          for (const step of steps) {
            if (step.delayMs > 0) await tick(step.delayMs);
            if (step.gate !== null && step.gate !== undefined) await step.gate.promise;
            state.rewriteDeltas.push({ text: step.text, at: Date.now() });
            yield { type: 'text-delta', text: step.text };
          }
          yield { type: 'finish', reason: { kind: 'stop' } };
        })();
      }
      // Any other auxiliary task (waiting line, draft) is not part of the translation evidence.
      if (!isTranslation(system)) {
        return (async function* other() {
          yield { type: 'text-delta', text: '我去查，稍等。' };
          yield { type: 'finish', reason: { kind: 'stop' } };
        })();
      }
      const call = { at: Date.now(), source: targetOf(lastText(options)), system };
      state.translateCalls.push(call);      return (async function* translateStream() {
        if (translateDelayMs > 0) await tick(translateDelayMs);
        yield { type: 'text-delta', text: translate(call.source, system) };
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
      async create(path) { return { id: 'ws-pipeline-latency', path }; },
      get() { return { id: 'ws-pipeline-latency', async attachSession() {} }; },
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
    let replyIndex = 0;
    return {
      id: sessionId,
      session,
      followup(message) {
        turn += 1;
        const turnId = turn;
        const text = JSON.stringify(message?.content ?? message);
        const isDigest = text.includes('以下内容作为长期约束与背景');
        // A test may script one body per turn: `replyText` as an array is indexed by reply order.
        const body = Array.isArray(replyText) ? (replyText[replyIndex] ?? replyText[0]) : replyText;
        if (isDigest !== true) replyIndex += 1;
        const fire = (type, data) => bus.fire('session/event', session, {
          type, seq: state.turnIds.length + turnId, time: Date.now(), data,
        });
        void (async () => {
          fire('turn/start', { turn: turnId });
          state.turnIds.push(turnId);
          fire('user/message', message);
          if (isDigest !== true) {
            state.replyTurnId = turnId;
            // A real turn is never instantaneous: give the accepted delivery its own instants.
            await tick(5);
            fire('assistant/message', {
              turn: turnId,
              step: 1,
              message: { id: `a-${turnId}`, role: 'assistant', content: [{ type: 'text', text: body }] },
            });
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

  const events = async () => {
    try {
      const text = await readFile(join(root, 'data', 'events.jsonl'), 'utf8');
      return text.trim().split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  };
  const waitForEvent = async (type, predicate = () => true, timeoutMs = 8000) => {
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
    events,
    waitForEvent,
    players: () => state.players,
    texts: () => state.texts,
    subtitles: () => state.subtitles,
    rewriteDeltas: () => state.rewriteDeltas,
    translateCalls: () => state.translateCalls,
    rewriteCalls: () => state.rewriteCalls,
    replyTurnId: () => state.replyTurnId,
  };
}

/** Wait for the clip at `index`, start it and let it end. Returns false on timeout. */
async function playClip(app, index, timeoutMs = 8000) {
  const started = Date.now();
  while (app.players().length < index + 1) {
    if (Date.now() - started > timeoutMs) return false;
    await tick(10);
  }
  app.players()[index].onStart?.({ startedAt: Date.now() });
  app.players()[index].resolve();
  await tick(5);
  return true;
}

/** Play every clip the round produces until the speech settles. */
async function playAll(app, expected = 6) {
  for (let index = 0; index < expected; index += 1) {
    if (!(await playClip(app, index))) return index;
  }
  return expected;
}

// ---------------------------------------------------------------------------
// 1. The first unit starts translation + synthesis before the rewrite finishes
// ---------------------------------------------------------------------------
test('1. the first semantic unit is translated and synthesized before the rewrite completes', async (t) => {
  const app = await mountRound(t, { replyText: LONG_BODY });
  app.say('明天出门要注意什么');
  // Two units reach the player; the first clip exists while unit 2 is still being written.
  assert.equal(await playClip(app, 0), true, 'the first unit reached the player');
  await waitUntil(() => app.rewriteDeltas().length >= 2, 'the rewrite produced its second unit');
  assert.equal(await playClip(app, 1), true, 'the second unit reached the player');
  const first = await app.waitForEvent('voice.first-sentence');
  assert.ok(first.translateMs > 0, 'the first unit was translated');

  const deltas = app.rewriteDeltas();
  const calls = app.translateCalls();
  assert.equal(deltas.length, 2, 'the rewrite streamed two units');
  assert.ok(app.rewriteCalls().length === 1, 'exactly one rewrite request');
  assert.equal(calls.length, 2, `each unit was translated once: ${JSON.stringify(calls.map((row) => row.source))}`);
  // The proof: translation of unit 1 began BEFORE the rewrite produced unit 2.
  assert.ok(
    calls[0].at < deltas[1].at,
    `translation #1 at +${calls[0].at - deltas[0].at}ms after unit 1, unit 2 at +${deltas[1].at - deltas[0].at}ms`,
  );
  assert.ok(
    state.synthAt[0] < deltas[1].at,
    `synthesis #1 at +${state.synthAt[0] - deltas[0].at}ms, before unit 2 (${deltas[1].at - deltas[0].at}ms)`,
  );
  // The second unit's translation carries the FIRST unit as neighbours (names/tone context).
  assert.ok(!calls[0].system.includes('相邻句'), 'the first unit has no preceding context');
  assert.ok(
    calls[1].system.includes('相邻句') && calls[1].system.includes(REWRITE_UNITS[0]),
    'the second unit carries the preceding unit as context',
  );
  t.diagnostic(
    `unit1=+0ms translate1=+${calls[0].at - deltas[0].at}ms synth1=+${state.synthAt[0] - deltas[0].at}ms `
    + `unit2=+${deltas[1].at - deltas[0].at}ms`,
  );
});

// ---------------------------------------------------------------------------
// 2. Negation / condition clauses are never split into a misleading half
// ---------------------------------------------------------------------------
test('2. contrast/negation/condition clauses are never cut into a misleading half sentence', () => {
  const cases = [
    ['这个可以，但是不行。', ['这个可以，但是不行。']],
    ['不可以现在删，先备份。', ['不可以现在删，先备份。']],
    ['需要先备份，再检查索引。', ['需要先备份，再检查索引。']],
    ['除非你先确认，否则不要动。', ['除非你先确认，否则不要动。']],
    ['如果下雨，就取消。', ['如果下雨，就取消。']],
  ];
  for (const [text, expected] of cases) {
    assert.deepEqual(splitSemanticUnits(text, { clauseSplit: true }), expected, `${text} stays whole`);
  }
  // Streaming: the pause after "如果下雨" is HELD until the consequence proves the pair safe.
  const first = takeSemanticUnits('如果下雨，', { final: false, clauseSplit: true });
  assert.deepEqual(first.units, [], 'the conditional is not delivered on its own');
  assert.equal(first.rest, '如果下雨，', 'the whole conditional tail is retained');
  const second = takeSemanticUnits(`${first.rest}就取消。`, { final: false, clauseSplit: true });
  assert.deepEqual(second.units, ['如果下雨，就取消。'], 'the pair is delivered together');
  // A plain pause that is safe still splits: two complete clauses, no connector.
  assert.deepEqual(
    splitSemanticUnits('明天出门要带伞，下午的降水概率会升到七成。', { clauseSplit: true, minChars: 8 }),
    ['明天出门要带伞，', '下午的降水概率会升到七成。'],
    'a safe comma cut still happens',
  );
});

// ---------------------------------------------------------------------------
// 3. Translation pipeline: unit N synthesizes as soon as it is translated; order preserved
// ---------------------------------------------------------------------------
test('3. units synthesize as translated, keep their order, and a cancellation never plays late', async () => {
  const played = [];
  const synthStarted = [];
  const gate = deferred();
  const speaker = createReplySpeaker({
    startedAt: Date.now(),
    synthesize: async ({ text, sentenceId }) => {
      synthStarted.push({ text, at: Date.now() });
      // Unit 2's translation is slow: unit 1 must already be playing by then.
      if (sentenceId === 1) await gate.promise;
      return { file: `unit-${sentenceId}.mp3`, durationMs: 10 };
    },
    play: async ({ text }) => {
      played.push(text);
      return { audioStartedAt: Date.now(), done: Promise.resolve() };
    },
  });
  speaker.push('第一块。第二块。第三块。');
  await waitUntil(() => played.length >= 1, 'the first unit played');
  assert.deepEqual(
    synthStarted.slice(0, 2).map((row) => row.text),
    ['第一块。', '第二块。'],
    'unit 2 started translating+synthesizing while unit 1 was still ahead',
  );
  gate.resolve();
  await speaker.finish({ fullText: '第一块。第二块。第三块。' });
  assert.deepEqual(played, ['第一块。', '第二块。', '第三块。'], 'playback order follows the text');

  // Cancellation: a late result of the old turn is never played.
  const oldPlayed = [];
  const late = deferred();
  const oldSpeaker = createReplySpeaker({
    synthesize: async ({ sentenceId }) => {
      if (sentenceId === 1) await late.promise;
      return { file: `old-${sentenceId}.mp3`, durationMs: 10 };
    },
    play: async ({ text }) => {
      oldPlayed.push(text);
      return { audioStartedAt: Date.now(), done: Promise.resolve() };
    },
  });
  oldSpeaker.push('旧轮第一句。旧轮第二句。');
  await waitUntil(() => oldPlayed.length >= 1, 'the old first unit played');
  oldSpeaker.cancel('new-turn');
  late.resolve();
  await tick(40);
  assert.deepEqual(oldPlayed, ['旧轮第一句。'], 'the cancelled turn played nothing after the cancel');
  assert.equal(oldSpeaker.stats.cancelled, true);

  // The unit stream itself: a cancelled stream drops its buffer and every later delta.
  const streamed = [];
  const stream = createSpokenUnitStream({ onUnit: (unit) => streamed.push(unit) });
  stream.push('第一块。未完成的第二');
  stream.cancel();
  stream.push('块。');
  stream.finish();
  assert.deepEqual(streamed, ['第一块。'], 'a cancelled unit stream emits nothing after the cancel');
});

// ---------------------------------------------------------------------------
// 4. Generation isolation: a new turn cancels the old one; its late block never plays
// ---------------------------------------------------------------------------
test('4. a new turn cancels the old round and the old round\'s late unit is never played', async (t) => {
  const gate = deferred();
  const app = await mountRound(t, {
    replyText: [LONG_BODY, SHORT_BODY],
    // Turn 1: unit 1 then a held late unit. Turn 2 is the short body, so it never rewrites.
    rewrite: () => ([
      { text: REWRITE_UNITS[0], delayMs: 20, gate: null },
      { text: '旧轮迟到的一句。', delayMs: 0, gate },
    ]),
  });
  app.say('先说第一件事');
  await waitUntil(() => app.rewriteDeltas().length >= 1, 'the old rewrite produced its first unit');
  assert.equal(await playClip(app, 0), true, 'the old first unit played');

  // The second utterance supersedes the old turn before the rewrite ever finishes.
  app.say('停一下听我说');
  await waitUntil(() => app.players().length >= 2, 'the new turn spoke after the barge-in', 8000);
  assert.equal(await playClip(app, 1), true, 'the new turn\'s answer played');
  gate.resolve();
  await tick(150);
  const spoken = app.texts().join('|');
  assert.ok(!spoken.includes('旧轮迟到'), `no late old unit was spoken: ${spoken}`);
  assert.ok(
    app.texts().includes('Take an umbrella tomorrow.'),
    `the new turn spoke its own answer: ${spoken}`,
  );
  t.diagnostic(`newTurnClips=${app.texts().length} lateOldUnitPlayed=${spoken.includes('旧轮迟到')}`);
});

// ---------------------------------------------------------------------------
// 5. Short natural answer: no spoken version (one model call less)
// ---------------------------------------------------------------------------
test('5. a short natural answer skips the spoken version; a short structured one does not', async (t) => {
  // (a) Natural and short: spoken verbatim, zero rewrite calls.
  const natural = await mountRound(t, {
    replyText: SHORT_BODY,
    langs: { speech: 'zh', subtitle: 'zh' },
  });
  natural.say('现在几点');
  assert.equal(await playClip(natural, 0), true, 'the short answer played');
  assert.equal(natural.rewriteCalls().length, 0, 'no rewrite request for a short natural answer');
  assert.deepEqual(natural.texts(), [SHORT_BODY], 'the answer is spoken verbatim');
  const naturalTexts = [...natural.texts()];
  const naturalTimeline = await natural.waitForEvent('voice.pipeline.timeline');
  assert.equal(naturalTimeline.skippedSpokenVersion, true, 'the timeline records the skip');
  const version = await natural.waitForEvent('voice.spoken.version');
  assert.equal(version.source, 'original');
  assert.equal(version.ms, 0);
  // The pure decision: length is only one condition, a structured short answer is not "short".
  assert.deepEqual(shouldSkipSpokenVersion(SHORT_BODY, SHORT_BODY), { skip: true, reason: 'short-natural' });
  assert.deepEqual(
    shouldSkipSpokenVersion('- 先备份\n- 再检查索引', '先备份 再检查索引'),
    { skip: false, reason: 'structured' },
  );
  await tick(20);

  // (b) Short but a LIST: length alone must not allow it to be read verbatim.
  const listBody = '- 先备份\n- 再检查索引';
  const structured = await mountRound(t, {
    replyText: listBody,
    langs: { speech: 'zh', subtitle: 'zh' },
    rewrite: [{ text: '先备份，再检查索引。', delayMs: 20, gate: null }],
  });
  structured.say('怎么处理');
  await waitUntil(() => structured.rewriteCalls().length === 1, 'the structured answer was rewritten');
  assert.equal(await playClip(structured, 0), true, 'the rewritten line played');
  assert.deepEqual(structured.texts(), ['先备份，再检查索引。'], 'the list was not read verbatim');
  const structuredTimeline = await structured.waitForEvent('voice.pipeline.timeline');
  assert.equal(structuredTimeline.skippedSpokenVersion, false, 'a structured answer is not skipped');
  t.diagnostic(
    `naturalCalls=0 naturalText=${JSON.stringify(naturalTexts)} `
    + `structuredCalls=1 structuredText=${JSON.stringify(structured.texts())}`,
  );
});

// ---------------------------------------------------------------------------
// 6. Same target language: one shared in-flight translation; kana affects only the speech copy
// ---------------------------------------------------------------------------
test('6. the subtitle and the speech share one translation; the kana form stays on the speech copy', async (t) => {
  // (a) Same target language (en): subtitle and speech share ONE request.
  const shared = await mountRound(t, {
    replyText: SHORT_BODY,
    langs: { speech: 'en', subtitle: 'en' },
  });
  shared.say('现在几点');
  assert.equal(await playClip(shared, 0), true, 'the shared-translation clip played');
  await waitUntil(() => shared.translateCalls().length >= 1, 'a translation ran');
  assert.equal(shared.translateCalls().length, 1, 'the same text was translated exactly once');
  const sharedTimeline = await shared.waitForEvent('voice.pipeline.timeline');
  assert.equal(sharedTimeline.reusedTranslation, true, 'the timeline records the reuse');
  assert.deepEqual(shared.texts(), ['Take an umbrella tomorrow.'], 'the speech uses the shared text');
  await waitUntil(
    () => shared.subtitles().some((row) => row.text === 'Take an umbrella tomorrow.'),
    'the translated subtitle was painted',
  );
  assert.equal(
    shared.subtitles().at(-1).text,
    shared.texts()[0],
    'the subtitle is the same translation, not a second request',
  );

  // (b) Japanese: the subtitle keeps normal writing, the speech copy is kana. The two forms are
  // NOT the same translation, so the speech never receives the mixed subtitle text.
  const kanaText = 'きょう は いい てんき です ね。';
  const mixedText = '今日はいい天気ですね。';
  const japanese = await mountRound(t, {
    replyText: '今天天气很好。',
    langs: { speech: 'ja', subtitle: 'ja' },
    translate: (_source, system) => (String(system).includes('平假名') ? kanaText : mixedText),
  });
  japanese.say('天气怎么样');
  assert.equal(await playClip(japanese, 0), true, 'the Japanese clip played');
  await waitUntil(
    () => japanese.subtitles().some((row) => row.text === mixedText),
    'the mixed subtitle was painted',
  );
  assert.equal(japanese.texts()[0], kanaText, 'the speech copy is kana');
  assert.equal(japanese.subtitles().at(-1).text, mixedText, 'the subtitle keeps normal Japanese');
  assert.ok(
    !japanese.subtitles().some((row) => row.text === kanaText),
    'the kana form is never painted on the subtitle',
  );
  assert.equal(japanese.translateCalls().length, 2, 'the two required forms are two translations');
  const kanaTimeline = await japanese.waitForEvent('voice.pipeline.timeline');
  assert.equal(kanaTimeline.reusedTranslation, false, 'different forms are not shared');
  t.diagnostic(
    `sharedCalls=1 reused=true speech=${JSON.stringify(japanese.texts())} `
    + `subtitle=${JSON.stringify(japanese.subtitles().at(-1).text)} kanaCalls=2`,
  );
});

// ---------------------------------------------------------------------------
// 7. First block size: a whole short sentence beats a fixed comma cut
// ---------------------------------------------------------------------------
test('7. the first block prefers a whole short sentence and is sized from measured cost', () => {
  const fast = createUnitSizer();
  // A whole short sentence always wins, whatever the measured cost.
  assert.deepEqual(splitSemanticUnits('今天天气不错。', { clauseSplit: true }), ['今天天气不错。']);
  // A one-clause sentence with a comma below the floor is not split into a stub.
  assert.deepEqual(splitSemanticUnits('好的，我知道了。', { clauseSplit: true }), ['好的，我知道了。']);
  // The default size keeps a medium sentence whole (the old "first comma" cut would have split it).
  const medium = '今天天气不错，我们出去走走吧，顺便买点水果和牛奶回来。';
  assert.deepEqual(
    splitSemanticUnits(medium, { clauseSplit: true, cutAtChars: fast.targetChars() }),
    [medium],
    'a whole short sentence is the first block',
  );
  // An expensive provider measured from real synthesis shrinks the block to a natural clause.
  const slow = createUnitSizer();
  slow.observe({ ms: 2400, chars: 24 });
  assert.ok(slow.targetChars() <= 20, `a slow provider targets a small block (${slow.targetChars()})`);
  const units = splitSemanticUnits(medium, { clauseSplit: true, cutAtChars: slow.targetChars() });
  assert.deepEqual(
    units,
    ['今天天气不错，我们出去走走吧，', '顺便买点水果和牛奶回来。'],
    'the cut lands on the natural clause past the target, not on the first comma',
  );
  assert.equal(units.join(''), medium, 'no character is lost or doubled');
  // Measurement is monotonic and cheap: a fast sample grows the block again.
  const before = slow.targetChars();
  slow.observe({ ms: 100, chars: 40 });
  assert.ok(slow.targetChars() > before, `a fast sample grows the block (${before} -> ${slow.targetChars()})`);
});

// ---------------------------------------------------------------------------
// 8. voice.pipeline.timeline: every stage measured from the accepted delivery
// ---------------------------------------------------------------------------
test('8. voice.pipeline.timeline measures every stage from the accepted delivery', async (t) => {
  const app = await mountRound(t, { replyText: LONG_BODY });
  app.say('明天出门要注意什么');
  assert.equal(await playClip(app, 0), true, 'the first unit played');
  await waitUntil(() => app.rewriteDeltas().length >= 2, 'the rewrite finished');
  assert.equal(await playClip(app, 1), true, 'the second unit played');
  const timeline = await app.waitForEvent('voice.pipeline.timeline');
  for (const key of [
    'bodyReadyMs', 'spokenStartedMs', 'spokenFirstSentenceMs', 'translatedFirstMs',
    'firstChunkSynthMs', 'firstAudioMs', 'spokenCompleteMs',
  ]) {
    assert.equal(Number.isInteger(timeline[key]), true, `${key} is a measured integer (${timeline[key]})`);
    assert.ok(timeline[key] >= 0, `${key} is non-negative`);
  }
  assert.ok(timeline.bodyReadyMs >= 0, `the complete body arrived after the accepted delivery: ${JSON.stringify(timeline)}`);
  assert.ok(
    timeline.spokenStartedMs >= timeline.bodyReadyMs,
    `the spoken version starts after the complete body (${timeline.spokenStartedMs} >= ${timeline.bodyReadyMs})`,
  );
  assert.ok(
    timeline.spokenFirstSentenceMs >= timeline.spokenStartedMs,
    'the first unit follows the start of the spoken version',
  );
  assert.ok(timeline.translatedFirstMs >= timeline.spokenFirstSentenceMs, 'translation follows the unit');
  assert.ok(timeline.firstChunkSynthMs >= timeline.translatedFirstMs, 'synthesis follows the translation');
  assert.ok(timeline.firstAudioMs >= timeline.firstChunkSynthMs, 'audio follows the first block');
  assert.ok(timeline.spokenCompleteMs >= timeline.firstAudioMs, 'the spoken version completes last');
  assert.ok(
    timeline.firstAudioMs - timeline.spokenFirstSentenceMs < 1000,
    `first audio ${timeline.firstAudioMs - timeline.spokenFirstSentenceMs}ms after the first unit`,
  );
  assert.equal(timeline.skippedSpokenVersion, false);
  assert.equal(timeline.reusedTranslation, false);
  assert.equal(timeline.turn, app.replyTurnId(), 'the timeline is joined to its turn');

  // `firstSynthMs` already includes the translation: the block-ready stage is not translate+synth
  // added twice. The interval unit -> block-ready is bounded by the two measured stages once.
  const latency = await app.waitForEvent('voice.latency');
  assert.ok(latency.firstSynthMs > 0, 'the synthesis stage was measured');
  assert.ok(latency.translateMs > 0, 'the translation stage was measured');
  assert.ok(
    timeline.firstChunkSynthMs - timeline.spokenFirstSentenceMs
      <= latency.translateMs + latency.firstSynthMs + 400,
    `block-ready ${timeline.firstChunkSynthMs - timeline.spokenFirstSentenceMs}ms is not a double-add of `
      + `translate ${latency.translateMs}ms + synth ${latency.firstSynthMs}ms`,
  );

  // The pure builder: a stage that never happened stays null, never a fabricated 0.
  const empty = buildPipelineTimeline({ turn: 4, origin: 1000 });
  assert.equal(empty.turn, 4);
  assert.equal(empty.bodyReadyMs, null);
  assert.equal(empty.spokenStartedMs, null);
  assert.equal(empty.spokenFirstSentenceMs, null);
  assert.equal(empty.translatedFirstMs, null);
  assert.equal(empty.firstChunkSynthMs, null);
  assert.equal(empty.firstAudioMs, null);
  assert.equal(empty.spokenCompleteMs, null);
  assert.equal(empty.skippedSpokenVersion, false);
  assert.equal(empty.reusedTranslation, false);
  t.diagnostic(
    `body=${timeline.bodyReadyMs} unit=${timeline.spokenFirstSentenceMs} `
    + `translated=${timeline.translatedFirstMs} chunk=${timeline.firstChunkSynthMs} `
    + `audio=${timeline.firstAudioMs} complete=${timeline.spokenCompleteMs}`,
  );
});

// ---------------------------------------------------------------------------
// 9. finish() commits the unterminated tail as the last unit
// ---------------------------------------------------------------------------
test('9. finish() speaks the unterminated tail exactly once, with no empty unit', (t) => {
  /** Drive one unit stream over `deltas`, then finish it `finishTimes` times. */
  const collect = (deltas, { finishTimes = 1, ...options } = {}) => {
    const units = [];
    const stream = createSpokenUnitStream({ ...options, onUnit: (unit) => units.push(unit) });
    for (const delta of deltas) stream.push(delta);
    for (let index = 0; index < finishTimes; index += 1) stream.finish();
    return { units, stats: stream.stats() };
  };

  // (1) The review's counterexample: the second sentence has no full stop. Two units, second whole,
  // and the units join back to exactly the input (nothing lost, nothing doubled).
  const review = '明天出门要带伞。记得今晚把伞放进包里';
  const whole = collect([review]);
  assert.deepEqual(
    whole.units,
    ['明天出门要带伞。', '记得今晚把伞放进包里'],
    'the unterminated second sentence is committed as the LAST unit',
  );
  assert.equal(whole.units.join(''), review, 'no character is lost or doubled');
  assert.equal(whole.stats.units, 2, 'both units are counted');
  // The same text arriving in several deltas produces the same two units.
  const streamed = collect([review.slice(0, 12), review.slice(12)]);
  assert.deepEqual(streamed.units, whole.units, 'a split delta stream still commits the whole tail');

  // The tail may OPEN with a connective ("但是" / "所以") and still be the end of the reply: it is a
  // complete unit at the end, never a misleading half sentence to drop.
  assert.deepEqual(collect(['先说结论。但是']).units, ['先说结论。', '但是'], 'a trailing connective is not dropped');
  assert.deepEqual(
    collect(['今天下雨。所以，记得带伞']).units,
    ['今天下雨。', '所以，记得带伞'],
    'a connective-led tail is committed whole',
  );

  // (2) A single sentence with no terminator at all: one complete unit.
  const bare = '今天下午三点';
  assert.deepEqual(collect([bare]).units, [bare], 'a reply without any punctuation is still spoken');

  // (3) A whitespace- or punctuation-only remainder never becomes an (empty) unit.
  assert.deepEqual(collect(['第一句。', '   ']).units, ['第一句。'], 'a whitespace-only tail is not a unit');
  assert.deepEqual(collect(['第一句。', '，']).units, ['第一句。'], 'a punctuation-only tail is not a unit');
  assert.deepEqual(collect(['第一句。   ']).units, ['第一句。'], 'trailing spaces do not duplicate the sentence');
  assert.deepEqual(collect(['   ', '，']).units, [], 'a stream of only whitespace/punctuation emits nothing');

  // (4) finish() is idempotent: the second call adds no unit and never replays the first.
  const twice = collect([review], { finishTimes: 2 });
  assert.deepEqual(twice.units, whole.units, 'a repeated finish() does not change the unit list');
  assert.equal(twice.stats.units, whole.stats.units, 'the unit count is unchanged by a repeated finish()');

  // (5) Overlong text keeps the existing size cap: the measured sizer cuts it at its pauses, so the
  // last unit is only the tail, never one oversized blob. A pause-free run has no cut point in the
  // existing rules, so it is committed once, whole (no truncation, no duplication).
  const slow = createUnitSizer();
  slow.observe({ ms: 2400, chars: 24 }); // ≈100 ms/char -> a block of about 12 characters
  const clauses = Array.from({ length: 12 }, (_, index) => `第${index + 1}项先检查配置再复测`);
  const longNoStop = `${clauses.join('，')}，最后看日志`;
  const longUnits = collect([longNoStop], { sizer: slow }).units;
  const sizes = longUnits.map((unit) => [...unit].length);
  assert.equal(longUnits.join(''), longNoStop, 'a long unterminated text loses no character');
  assert.ok(longUnits.length >= 8, `the existing size cap still cuts the long text (${longUnits.length} units)`);
  assert.ok(
    Math.max(...sizes) <= 2 * slow.targetChars(),
    `no oversized block (max ${Math.max(...sizes)} chars, target ${slow.targetChars()})`,
  );
  const noPauses = '甲'.repeat(200);
  const noPauseUnits = collect([noPauses]).units;
  assert.deepEqual(noPauseUnits, [noPauses], 'a pause-free run is delivered once, whole, untruncated');

  // (6) A stream error ends with cancel() (the existing fallback rule). A later finish() must replay
  // nothing and commit no leftover, so the already-spoken units are never spoken twice.
  const emitted = [];
  const failed = createSpokenUnitStream({ onUnit: (unit) => emitted.push(unit) });
  failed.push('第一句。第二句。第三句还没有结束');
  failed.cancel();
  failed.finish();
  assert.deepEqual(emitted, ['第一句。', '第二句。'], 'nothing is replayed or appended after a stream error');

  t.diagnostic(
    `reviewUnits=${JSON.stringify(whole.units)} joinOk=${whole.units.join('') === review} `
    + `single=${JSON.stringify(collect([bare]).units)} blank=0 punct=0 twiceUnits=${twice.stats.units} `
    + `longUnits=${longUnits.length} longMax=${Math.max(...sizes)} `
    + `noPauseUnits=${noPauseUnits.length} errorReplay=${emitted.length}`,
  );
});

// ---------------------------------------------------------------------------
// 10. The review's counterexample end to end: the rewrite's last sentence has no full stop
// ---------------------------------------------------------------------------
test('10. a rewrite without a final full stop plays its last sentence too', async (t) => {
  const tail = '记得今晚把伞放进包里';
  // Distinct English lines: a translation that is (nearly) the source again is a failed
  // translation (`TRANSLATE_UNCHANGED`), which would fall back to the untranslated line.
  const spoken = new Map([
    ['明天出门要带伞。', 'Umbrella tomorrow.'],
    [tail, 'Pack the umbrella tonight.'],
  ]);
  const app = await mountRound(t, {
    replyText: LONG_BODY,
    // Exactly the reviewed case: sentence 1 ends with 。, sentence 2 has no terminator.
    rewrite: [
      { text: '明天出门要带伞。', delayMs: 20, gate: null },
      { text: tail, delayMs: 0, gate: null },
    ],
    translate: (source) => spoken.get(source) ?? `other:${source}`,
  });
  app.say('明天出门要注意什么');
  assert.equal(await playClip(app, 0), true, 'the first unit reached the player');
  assert.equal(await playClip(app, 1), true, 'the unterminated LAST unit reached the player');
  assert.deepEqual(
    app.texts(),
    ['Umbrella tomorrow.', 'Pack the umbrella tonight.'],
    'both units were translated and synthesized, in order, nothing lost or repeated',
  );
  const timeline = await app.waitForEvent('voice.pipeline.timeline');
  assert.equal(timeline.skippedSpokenVersion, false, 'the rewrite was streamed, not skipped');
  t.diagnostic(
    `clips=${JSON.stringify(app.texts())} spokenCompleteMs=${timeline.spokenCompleteMs}`,
  );
});

// ---------------------------------------------------------------------------
// 11. The streamed rewrite carries the SAME request policy as the lightweight channel
// ---------------------------------------------------------------------------
test('11. the streamed spoken rewrite requests reasoningEffort off, exactly like the lightweight channel', async (t) => {
  const app = await mountRound(t, { replyText: LONG_BODY });
  app.say('明天出门要带伞吗');
  await waitUntil(() => app.rewriteCalls().length === 1, 'the streamed rewrite was requested');
  const call = app.rewriteCalls()[0];
  const request = call.options ?? {};
  // The review's finding: this request used to pass NO reasoning control, so the model could spend
  // the rewrite's budget "thinking" before its first spoken unit.
  assert.equal(request.reasoningEffort, 'off', 'the streamed rewrite sends the shared reasoning off policy');
  assert.equal(request.provider, 'fake-provider', 'same route as the lightweight channel');
  assert.equal(request.model, 'fake-model');
  assert.ok(Number(request.maxTokens) >= 120, 'the rewrite still sizes its own output budget');
  assert.ok(request.signal !== undefined && request.signal !== null, 'the turn signal is still passed');
  assert.match(String(request.system), /口语版/u, 'the rewrite prompt is unchanged');
  assert.doesNotMatch(String(request.system), /记忆片段|最近一句/iu, 'the rewrite is still context-free');
  assert.match(String(request.messages?.[0]?.content?.[0]?.text ?? ''), /完整答复/u);
  // The policy changes only the request: the OUTPUT path still streams, so the first unit reaches
  // translation + synthesis while the model is still writing (no buffering of the whole rewrite).
  assert.equal(await playClip(app, 0), true, 'the first streamed unit still reaches the player');
  assert.equal(await playClip(app, 1), true, 'the second streamed unit still reaches the player');
  assert.deepEqual(app.texts(), ['Take an umbrella tomorrow.', 'Take an umbrella tomorrow.']);
  const timeline = await app.waitForEvent('voice.pipeline.timeline');
  assert.equal(timeline.skippedSpokenVersion, false, 'the rewrite was streamed, not skipped');
  t.diagnostic(
    `rewriteReasoning=${String(request.reasoningEffort)} maxTokens=${request.maxTokens} `
    + `units=${app.rewriteDeltas().length} clips=${app.texts().length} skipped=${timeline.skippedSpokenVersion}`,
  );
});
