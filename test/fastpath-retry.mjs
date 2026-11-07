/**
 * Fast-path failure policy (scheme A): retry ONCE, then make the failure visible.
 *
 * Proves, through the real mounted host (`apply` + the synthetic microphone final):
 *  1. first attempt fails with 500, second succeeds -> the answer plays once, exactly one
 *     `fastpath.retry`, no failure notice, no duplicate history;
 *  2. both attempts fail -> the short notice (<= 30 chars) plays, `fastpath.failed.shown`
 *     {spoken:true} is recorded and the answer is never spoken;
 *  3. a sentence already played before the failure -> no retry (no repeat), the notice still plays;
 *  4. a user cancel (mute / barge-in) -> no retry, no notice, no retry event;
 *  5. a non-retryable 400 -> no retry, the notice plays;
 *  6. the backoff is 800 ms ±20 %.
 *
 * Proves, against the FastPath class directly (the reviewer's counter-example):
 *  6. ONE generation deadline is shared by both attempts: budget 100 ms, first failure at ~50 ms,
 *     injected 20 ms backoff -> the retry only gets the ~20-30 ms that is left, never a fresh
 *     100 ms; after it times out there is no third attempt and the turn stays within budget + 30 ms;
 *  7. a sufficient budget (500 ms) still retries successfully and reports a sensible `remainingMs`;
 *  8. a sentence already handed to playback still blocks the retry (regression, module level);
 *  9. a 0 / tiny budget fails immediately as `budget-exhausted` — a budget verdict, never a
 *     provider reason;
 * 10. a backoff that no longer fits the remaining budget also fails as `budget-exhausted`;
 * 11. the real host reports that verdict: `fastpath.failed`/`failed.shown` reason
 *     `budget-exhausted` with attempts=1 and NO model request at all.
 *
 * No real microphone, TTS service, player, subtitle overlay, network or GUI is used.
 * Run: node --test test/fastpath-retry.mjs
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { registerHooks } from 'node:module';
import { Readable } from 'node:stream';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupRoot, disposeAll } from './helpers/cleanup.mjs';
import { FastPath, fastpathRetryDelayMs } from '../src/host/session/inference/fastpath.js';

const FAILED_LINE = '我这边服务暂时不可用，稍后再试';

const state = {
  synth: null,
  players: [],
  subtitles: [],
  texts: [],
  llmSteps: [],
  llmCalls: [],
  onUpdate: null,
};
globalThis.__fastpathRetry = state;

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
    const s = globalThis.__fastpathRetry;
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
    const s = globalThis.__fastpathRetry;
    export { resolveGptLangs, resolveGptSovitsTimeout } from '${ttsUrl}?fastpath-retry-helpers';
    export { speakChunks, speechChunkTexts } from '${ttsUrl}?fastpath-retry-chunk';
    export const configureTts = () => {};
    export const gptSovitsReferenceStatus = async () => ({ seconds: null, ok: false, readable: false });
    export const warmupGptSovits = async () => ({ ok: false, skipped: 'disabled' });
    export const applyGptSovitsModels = () => ({ ok: true });
    export const synthesize = (options) => s.synth(options);
    export const speakStreaming = async () => { throw new Error('streaming not expected'); };
    export const stopPlayback = () => true;
    export const stopTts = () => true;
    export const play = (file, options) => {
      let resolveDone;
      const done = new Promise((resolve) => { resolveDone = resolve; });
      const player = {
        file, ...options, startedAt: Date.now(), endedAt: 0, cancelled: false, endReason: '',
        resolve: () => { if (player.endedAt === 0) player.endedAt = Date.now(); resolveDone(); },
      };
      // A short clip: it ends on its own so the next sentence/notice can take the seat.
      setTimeout(() => player.resolve(), 5);
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
    export function readObservation(o) { return { ...(o ?? {}), stale: false, hint: '' }; }`,
      };
    }
    if (url === subtitleUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
    export const averageColor = async () => null;
    export { SubtitleHold } from '${subtitleUrl}?fastpath-retry-real';
    export class SubtitleOverlay {
      constructor({ config }) { this.config = config; }
      async show(text) {
        const s = globalThis.__fastpathRetry;
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
const { apply } = await import('../src/host/index.js');
hooks.deregister();
after(() => { delete globalThis.__fastpathRetry; });

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait for an LLM step's delay, but wake immediately when the turn is cancelled. */
function waitWithSignal(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener?.('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

const serverError = () => Object.assign(new Error('Internal Server Error (request_id 71b503db)'), { status: 500 });

/**
 * A fake LLM driven by a script: one entry per request. `error` throws before any delta,
 * `texts` streams sentence by sentence, `afterMs` waits between the last delta and the throw.
 */
function llmScript(steps) {
  state.llmSteps = [...steps];
  return {
    async *stream(request) {
      const step = state.llmSteps.shift() ?? { texts: ['默认回答。'] };
      state.llmCalls.push(step);
      if (step.error !== undefined && step.texts === undefined) throw step.error;
      if (step.hangMs !== undefined) {
        await waitWithSignal(step.hangMs, request.signal);
        return;
      }
      for (const text of step.texts ?? []) {
        if (request.signal.aborted) return;
        yield { type: 'text-delta', text };
      }
      if (step.afterMs !== undefined) await waitWithSignal(step.afterMs, request.signal);
      if (request.signal.aborted) return;
      if (step.error !== undefined) throw step.error;
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
}

async function mount(t, steps, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-fastpath-retry-'));
  await mkdir(join(root, 'data'), { recursive: true });
  await mkdir(join(root, 'workspace'), { recursive: true });
  await writeFile(join(root, 'data', 'features.json'), JSON.stringify({
    hearing: true,
    ambient: false,
    subtitle: true,
    voice: true,
    vision: false,
    avatar: false,
    memory: false,
    fastpath: true,
  }));
  await writeFile(join(root, 'data', 'settings.json'), JSON.stringify({
    gptSovits: { enabled: false },
    langs: { speech: 'zh', subtitle: 'zh' },
    autoMemory: { enabled: false },
    voice: { chunking: false },
    subtitle: {
      enabled: true,
      mode: 'region',
      region: { left: 0, top: 0, width: 320, height: 100 },
    },
  }));
  state.players = [];
  state.subtitles = [];
  state.texts = [];
  state.llmSteps = [];
  state.llmCalls = [];
  state.onUpdate = null;
  state.synth = async ({ text }) => {
    state.texts.push(text);
    return { file: join(root, 'tts', `${state.texts.length}.mp3`), bytes: 16, durationMs: 100, provider: 'edge-tts' };
  };

  const cleanups = [];
  const tools = new Map();
  const routes = new Map();
  const llm = llmScript(steps);
  // A fallback to the agent lane would land here; every test asserts it stays 0.
  const agentLoop = {
    calls: 0,
    async resume() { agentLoop.calls += 1; throw new Error('agent fallback forbidden'); },
    async createAgent() { agentLoop.calls += 1; throw new Error('agent fallback forbidden'); },
  };
  const services = new Map([
    ['llm', llm],
    ['agentDefaultModel', { currentSelection: () => ({ provider: 'fake-provider', model: 'fake-model' }) }],
    ['agentLoop', agentLoop],
  ]);
  const effect = (fn) => {
    const cleanup = fn();
    if (typeof cleanup === 'function') cleanups.push(cleanup);
    return cleanup;
  };
  apply({
    effect,
    on: () => () => {},
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
        on: () => () => {},
        systemPrompt: { section: () => () => {} },
        webServer: { register: (route) => { routes.set(route.path, route.handler); return () => routes.delete(route.path); } },
      });
    },
    webServer: { register: (route) => { routes.set(route.path, route.handler); return () => routes.delete(route.path); } },
  }, {
    root,
    enabled: true,
    asrMergeWindowMs: 10,
    // The retry's shape is production (one retry); only the 800 ms wait is scaled in tests.
    fastpathRetryDelayMs: 20,
    fastpathRetryJitter: 0,
    // `overrides` may scale the generation budget; everything else stays production-shaped.
    ...overrides,
  });

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

  t.after(async () => {
    for (const player of state.players) player.resolve();
    await tick(20);
    await disposeAll(cleanups.splice(0));
    await cleanupRoot(root);
  });

  return {
    root,
    say: (text) => state.onUpdate({ final: text, durationMs: 100 }),
    events,
    waitForEvent,
    action,
    agentLoop,
  };
}

const ofType = (rows, type) => rows.filter((event) => event.type === type && event.payload !== undefined);
const eventPayloads = (rows, type) => ofType(rows, type).map((event) => event.payload);

// ---------------------------------------------------------------------------
// 0. the retry backoff is 800 ms ±20 %
// ---------------------------------------------------------------------------

test('0. retry backoff is 800 ms ±20 %', (t) => {
  const samples = Array.from({ length: 400 }, () => fastpathRetryDelayMs());
  assert.ok(samples.every((ms) => ms >= 640 && ms <= 960), `all samples in 640..960: ${Math.min(...samples)}..${Math.max(...samples)}`);
  assert.ok(new Set(samples).size > 20, 'the jitter produces a spread, not one constant');
  assert.equal(fastpathRetryDelayMs({ random: () => 0.5 }), 800, 'the centre value is 800 ms');
  t.diagnostic(`samples=${Math.min(...samples)}..${Math.max(...samples)}ms (centre 800ms)`);
});

// ---------------------------------------------------------------------------
// 1. first 500, second success: one answer, one retry, no notice
// ---------------------------------------------------------------------------

test('1. 首次 500、第二次成功：答案只播一次，fastpath.retry 1 条，无提示', async (t) => {
  const app = await mount(t, [
    { error: serverError() },
    { texts: ['我在，你说。'] },
  ]);
  app.say('随便聊聊');
  const spoken = await app.waitForEvent('fastpath.spoken');
  await tick(80);
  const rows = await app.events();
  const retries = eventPayloads(rows, 'fastpath.retry');
  assert.equal(retries.length, 1, 'exactly one retry event');
  assert.equal(retries[0].reason, 'server-error');
  assert.equal(retries[0].attempt, 2, 'the event announces the second attempt');
  assert.equal(retries[0].delayMs, 20, 'the configured backoff is reported');
  assert.ok(Number.isInteger(retries[0].turn) && retries[0].turn > 0, `turn=${retries[0].turn}`);
  assert.equal(state.llmCalls.length, 2, 'exactly two model attempts');
  assert.deepEqual(state.texts, ['我在，你说。'], 'only the answer reached TTS');
  assert.equal(state.players.length, 1, 'the answer played once');
  assert.equal(ofType(rows, 'fastpath.failed.shown').length, 0, 'no failure notice on success');
  assert.equal(ofType(rows, 'fastpath.failed').length, 0);
  assert.equal(spoken.chars, [...'我在，你说。'].length);
  assert.equal(app.agentLoop.calls, 0, 'never fell back to the agent lane');
  // The retry reused the turn: one user line, one assistant line.
  const history = (await readFile(join(app.root, 'data', 'conversation.jsonl'), 'utf8'))
    .trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(history.map((entry) => entry.role), ['user', 'assistant'], 'one user + one assistant line');
  assert.equal(history[0].text, '随便聊聊');
  t.diagnostic(`attempts=${state.llmCalls.length} retries=${retries.length} attempt=${retries[0].attempt} delayMs=${retries[0].delayMs} turn=${retries[0].turn} plays=${state.players.length} notice=0`);
});

// ---------------------------------------------------------------------------
// 2. both attempts 500: the notice plays, the answer is never spoken
// ---------------------------------------------------------------------------

test('2. 两次都 500：播放 ≤30 字提示、failed.shown{spoken:true}，答案未播', async (t) => {
  const app = await mount(t, [
    { error: new Error('Service is too busy. We advise users to temporarily switch.') },
    { error: serverError() },
  ]);
  app.say('今天天气如何');
  const shown = await app.waitForEvent('fastpath.failed.shown');
  await tick(80);
  const rows = await app.events();
  const retries = eventPayloads(rows, 'fastpath.retry');
  assert.equal(retries.length, 1, 'exactly one retry event');
  assert.equal(retries[0].reason, 'provider-busy', 'the provider busy reason is named');
  assert.equal(state.llmCalls.length, 2, 'two attempts, never a third');
  assert.equal(shown.spoken, true, 'the notice was really spoken');
  assert.equal(shown.reason, 'server-error', 'the second failure reason is reported');
  assert.ok(Number.isInteger(shown.turn) && shown.turn > 0, `turn=${shown.turn}`);
  assert.equal(shown.turn, retries[0].turn, 'retry and failure share the same turn');
  assert.deepEqual(state.texts, [FAILED_LINE], 'only the notice reached TTS; the answer never did');
  assert.ok([...FAILED_LINE].length <= 30, `notice is ${[...FAILED_LINE].length} chars`);
  assert.equal(state.players.length, 1, 'exactly one clip: the notice');
  assert.deepEqual(state.subtitles.map((entry) => entry.text), [FAILED_LINE], 'the notice caption was shown once');
  assert.equal(ofType(rows, 'fastpath.spoken').length, 0, 'the failed turn is never reported as spoken');
  assert.equal(app.agentLoop.calls, 0, 'never fell back to the agent lane');
  t.diagnostic(`retries=${retries.length} reason=${retries[0].reason} attempts=${state.llmCalls.length} spoken=${shown.spoken} notice="${FAILED_LINE}" chars=${[...FAILED_LINE].length} answerClips=0 noticeClips=${state.players.length} turn=${shown.turn}`);
});

// ---------------------------------------------------------------------------
// 3. a sentence already played: no retry, no repeat, the notice still plays
// ---------------------------------------------------------------------------

test('3. 首轮已播一句后失败：不重试（retry=0），不重复念，给出提示', async (t) => {
  const app = await mount(t, [
    { texts: ['第一句。'], afterMs: 200, error: serverError() },
  ]);
  app.say('讲两句');
  const shown = await app.waitForEvent('fastpath.failed.shown');
  await tick(80);
  const rows = await app.events();
  assert.equal(ofType(rows, 'fastpath.retry').length, 0, 'no retry after audio started');
  assert.equal(state.llmCalls.length, 1, 'only the first attempt was made');
  assert.equal(shown.spoken, true, 'the notice was spoken');
  assert.deepEqual(state.texts, ['第一句。', FAILED_LINE], 'the answer sentence played once, then the notice');
  assert.equal(state.texts.filter((text) => text === '第一句。').length, 1, 'the answer sentence was never repeated');
  assert.equal(state.players.length, 2, 'one answer clip + one notice clip');
  assert.equal(app.agentLoop.calls, 0, 'never fell back to the agent lane');
  t.diagnostic(`retries=0 attempts=${state.llmCalls.length} answerClips=1 noticeClips=1 spoken=${shown.spoken} texts=${JSON.stringify(state.texts)}`);
});

// ---------------------------------------------------------------------------
// 4. the user cancels: no retry, no notice, no retry event
// ---------------------------------------------------------------------------

test('4. 用户取消：不重试、不提示、无 retry 事件', async (t) => {
  const app = await mount(t, [{ hangMs: 5_000 }]);
  app.say('先别说');
  const started = Date.now();
  while (state.llmCalls.length === 0 && Date.now() - started < 3000) await tick(10);
  assert.equal(state.llmCalls.length, 1, 'the first attempt is in flight');
  const muted = await app.action({ action: 'voice.mute', muted: true });
  assert.equal(muted.ok, true);
  await app.waitForEvent('fastpath.bargein');
  await sleep(300);
  const rows = await app.events();
  assert.equal(ofType(rows, 'fastpath.retry').length, 0, 'a user cancel never retries');
  assert.equal(ofType(rows, 'fastpath.failed.shown').length, 0, 'a user cancel never shows the notice');
  assert.equal(ofType(rows, 'fastpath.failed.silent').length, 0);
  assert.equal(ofType(rows, 'fastpath.failed').length, 0, 'the cancel is not a failure');
  assert.equal(state.llmCalls.length, 1, 'no second attempt');
  assert.deepEqual(state.texts, [], 'nothing was spoken');
  assert.deepEqual(state.subtitles, [], 'nothing was captioned');
  t.diagnostic(`cancel=voice.mute retries=0 notice=0 attempts=${state.llmCalls.length} texts=0`);
});

// ---------------------------------------------------------------------------
// 5. non-retryable 400: no retry, the notice plays
// ---------------------------------------------------------------------------

test('5. 非可重试错误（400）：不重试，直接提示', async (t) => {
  const app = await mount(t, [
    { error: Object.assign(new Error('Bad Request (HTTP 400)'), { status: 400 }) },
  ]);
  app.say('这句话有问题');
  const shown = await app.waitForEvent('fastpath.failed.shown');
  await tick(80);
  const rows = await app.events();
  assert.equal(ofType(rows, 'fastpath.retry').length, 0, 'a 400 is never retried');
  assert.equal(state.llmCalls.length, 1, 'one attempt only');
  assert.equal(shown.spoken, true);
  assert.equal(shown.reason, 'http-400', 'the status is named in the reason');
  assert.deepEqual(state.texts, [FAILED_LINE], 'the notice played, no answer');
  assert.equal(app.agentLoop.calls, 0, 'never fell back to the agent lane');
  t.diagnostic(`retries=0 attempts=${state.llmCalls.length} reason=${shown.reason} spoken=${shown.spoken} notice="${FAILED_LINE}"`);
});

// ---------------------------------------------------------------------------
// The shared generation budget. Measured against the FastPath class itself: the deadline
// arithmetic is what is under test, and the mounted host would add playback/hearing noise to it.
// ---------------------------------------------------------------------------

/**
 * Wall-clock wait precise to ~1 ms. `setTimeout` on Windows overshoots by up to ~15 ms (60 -> 75),
 * which would hide the arithmetic under test; the fake stream spins on `setImmediate` until the
 * requested instant and still wakes early on abort.
 */
function preciseWait(ms, signal) {
  const end = Date.now() + Math.max(0, ms);
  return new Promise((resolve) => {
    const step = () => {
      if (signal?.aborted === true || Date.now() >= end) {
        resolve();
        return;
      }
      setImmediate(step);
    };
    step();
  });
}

/** FastPath + a scripted fake `llm` + an event sink; no host, no playback, no network. */
async function budgetHarness({ config = {}, steps = [] } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-fastpath-budget-'));
  const events = [];
  const calls = [];
  let next = 0;
  const llm = {
    async *stream(request) {
      const step = steps[next] ?? { texts: ['默认回答。'] };
      next += 1;
      calls.push({ at: Date.now() });
      if (step.error !== undefined && step.texts === undefined && step.afterMs === undefined) throw step.error;
      if (step.hangMs !== undefined) {
        await preciseWait(step.hangMs, request.signal);
        return;
      }
      for (const text of step.texts ?? []) {
        if (request.signal.aborted) return;
        yield { type: 'text-delta', text };
      }
      if (step.afterMs !== undefined) await preciseWait(step.afterMs, request.signal);
      if (request.signal.aborted) return;
      if (step.error !== undefined) throw step.error;
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
  const fastPath = new FastPath({
    root,
    config,
    getLlm: () => llm,
    getSelection: () => ({ currentSelection: () => ({ provider: 'fake-provider', model: 'fake-model' }) }),
    persona: { read: () => '' },
    memory: { brief: () => ({ text: '' }) },
    log: {
      emit(type, payload) {
        events.push({ type, ...payload });
        return Promise.resolve();
      },
    },
  });
  return { root, fastPath, events, calls };
}

const eventsOf = (events, type) => events.filter((event) => event.type === type);

async function rejectAsk(fastPath, utterance, options = {}) {
  const startedAt = Date.now();
  let error = null;
  try {
    await fastPath.askStream(utterance, options);
  } catch (caught) {
    error = caught;
  }
  return { error, totalMs: Date.now() - startedAt };
}

// ---------------------------------------------------------------------------
// 6. one deadline: the retry gets what is left, not a fresh budget
// ---------------------------------------------------------------------------

test('6. 共享预算：100ms、首败~50ms、退避20ms -> 重试只剩~20ms，不再第三次，总耗时 ≤ 预算+30ms', async (t) => {
  // The first failure is timed at 50 ms rather than 60 ms on purpose: the injected 20 ms backoff
  // is a real `setTimeout`, which Windows may wake ~11 ms late, and with a 60 ms first failure that
  // would leave < MIN_ATTEMPT_MS and legitimately take the abandon path. 50 ms keeps the intended
  // scenario (the retry really runs on the remainder) reproducible on a coarse clock.
  const { root, fastPath, events, calls } = await budgetHarness({
    config: { fastpathStreamTimeoutMs: 100, fastpathRetryDelayMs: 20, fastpathRetryJitter: 0 },
    steps: [{ afterMs: 50, error: serverError() }, { hangMs: 5_000 }],
  });
  t.after(async () => { await cleanupRoot(root); });

  const { error, totalMs } = await rejectAsk(fastPath, '预算一百毫秒', { turn: 6 });
  const retries = eventsOf(events, 'fastpath.retry');
  const timeouts = eventsOf(events, 'fastpath.stream.timeout');

  assert.equal(calls.length, 2, 'the second attempt ran, and there was never a third');
  assert.equal(retries.length, 1, 'exactly one retry event');
  assert.equal(retries[0].attempt, 2);
  assert.equal(retries[0].budgetMs, 100, 'the event carries the turn budget');
  assert.equal(retries[0].delayMs, 20, 'the injected backoff is reported');
  // ~100 - 50 - 20 = ~30 ms (a few ms of real-clock jitter): the retry window, NOT another 100 ms.
  assert.ok(
    retries[0].remainingMs >= 10 && retries[0].remainingMs <= 40,
    `the retry window is what the deadline left: ${retries[0].remainingMs} ms`,
  );
  assert.equal(timeouts.length, 1);
  assert.equal(timeouts[0].ms, retries[0].remainingMs, 'the attempt timer is exactly that remainder');
  assert.equal(timeouts[0].budgetMs, 100, 'the timeout event still names the turn budget');
  assert.ok(error !== null, 'the turn reports the timeout');
  assert.equal(error.fastpathFailure.reason, 'timeout');
  assert.equal(error.fastpathFailure.attempts, 2);
  assert.equal(error.fastpathFailure.budgetMs, 100);
  assert.ok(totalMs <= 130, `total ${totalMs} ms stays within the 100 ms budget + 30 ms`);
  t.diagnostic(`budget=100ms firstFail≈50ms backoff=20ms retryWindow=${retries[0].remainingMs}ms attempts=${calls.length} total=${totalMs}ms (≤130ms) reason=${error.fastpathFailure.reason}`);
});

// ---------------------------------------------------------------------------
// 7. a sufficient budget still retries successfully
// ---------------------------------------------------------------------------

test('7. 预算充足（500ms）：重试成功，remainingMs 已扣退避且仍合理', async (t) => {
  const { root, fastPath, events, calls } = await budgetHarness({
    config: { fastpathStreamTimeoutMs: 500, fastpathRetryDelayMs: 20, fastpathRetryJitter: 0 },
    steps: [{ error: serverError() }, { texts: ['我在，你说。'] }],
  });
  t.after(async () => { await cleanupRoot(root); });

  const startedAt = Date.now();
  const result = await fastPath.askStream('预算充足', { turn: 7 });
  const totalMs = Date.now() - startedAt;
  const retries = eventsOf(events, 'fastpath.retry');

  assert.equal(calls.length, 2, 'one retry');
  assert.equal(result.reply, '我在，你说。');
  assert.equal(result.attempts, 2);
  assert.equal(retries.length, 1);
  assert.equal(retries[0].budgetMs, 500);
  // The first attempt failed at once; the 20 ms backoff is charged, so the retry sees < 500 ms.
  assert.ok(
    retries[0].remainingMs > 400 && retries[0].remainingMs <= 490,
    `remainingMs=${retries[0].remainingMs} is the 500 ms budget minus the backoff`,
  );
  assert.equal(eventsOf(events, 'fastpath.stream.timeout').length, 0, 'no attempt timed out');
  assert.ok(totalMs < 500, `total ${totalMs} ms`);
  t.diagnostic(`budget=500ms backoff=20ms remainingMs=${retries[0].remainingMs}ms attempts=${calls.length} total=${totalMs}ms reply="${result.reply}"`);
});

// ---------------------------------------------------------------------------
// 8. a sentence already played: still no retry (regression)
// ---------------------------------------------------------------------------

test('8. 首轮已播出内容：不重试（回归，模块级）', async (t) => {
  const { root, fastPath, events, calls } = await budgetHarness({
    config: { fastpathStreamTimeoutMs: 500, fastpathRetryDelayMs: 20, fastpathRetryJitter: 0 },
    steps: [{ texts: ['第一句。'], afterMs: 40, error: serverError() }],
  });
  t.after(async () => { await cleanupRoot(root); });

  const plays = [];
  const { error } = await rejectAsk(fastPath, '讲两句', {
    turn: 8,
    onSentence: async (sentence) => { plays.push(sentence); },
  });

  assert.equal(calls.length, 1, 'only the first attempt was made');
  assert.deepEqual(plays, ['第一句。'], 'the sentence played exactly once');
  assert.equal(eventsOf(events, 'fastpath.retry').length, 0, 'audio already started: never retried');
  assert.equal(error.fastpathFailure.reason, 'server-error');
  assert.equal(error.fastpathFailure.attempts, 1);
  assert.equal(error.fastpathFailure.spoken, 1);
  t.diagnostic(`played=${JSON.stringify(plays)} retries=0 attempts=${calls.length} reason=${error.fastpathFailure.reason} spoken=${error.fastpathFailure.spoken}`);
});

// ---------------------------------------------------------------------------
// 9. a 0 / tiny budget fails as budget-exhausted, before any request
// ---------------------------------------------------------------------------

test('9. 预算 0 / 极小：不发起请求，reason=budget-exhausted（与 provider 错误区分）', async (t) => {
  for (const budget of [0, 5]) {
    const { root, fastPath, events, calls } = await budgetHarness({
      config: { fastpathStreamTimeoutMs: budget, fastpathRetryDelayMs: 20, fastpathRetryJitter: 0 },
      steps: [{ texts: ['不该被请求。'] }],
    });
    t.after(async () => { await cleanupRoot(root); });

    const { error, totalMs } = await rejectAsk(fastPath, `预算 ${budget}`, { turn: 9 });
    assert.ok(error !== null, `budget ${budget}: the turn fails`);
    assert.equal(error.fastpathFailure.reason, 'budget-exhausted', 'a budget verdict, not a provider reason');
    assert.equal(error.fastpathFailure.retryable, false);
    assert.equal(error.fastpathFailure.attempts, 1);
    assert.equal(error.fastpathFailure.budgetMs, budget);
    assert.equal(error.fastpathFailure.spoken, 0);
    assert.equal(error.fastpathFailure.lastReason, '', 'no provider failure happened');
    assert.match(error.message, /预算/u);
    assert.equal(calls.length, 0, 'no model request when no usable window exists');
    assert.equal(eventsOf(events, 'fastpath.retry').length, 0);
    assert.ok(totalMs < 50, `elapsed ${totalMs} ms`);
    t.diagnostic(`budget=${budget}ms calls=0 attempts=${error.fastpathFailure.attempts} remainingMs=${error.fastpathFailure.remainingMs} reason=${error.fastpathFailure.reason} elapsed=${totalMs}ms`);
  }
});

// ---------------------------------------------------------------------------
// 10. a backoff larger than what is left: abandon the retry, same verdict
// ---------------------------------------------------------------------------

test('10. 退避装不进剩余预算：放弃重试，仍记 budget-exhausted 并保留 provider 原因', async (t) => {
  const { root, fastPath, events, calls } = await budgetHarness({
    config: { fastpathStreamTimeoutMs: 100, fastpathRetryDelayMs: 60, fastpathRetryJitter: 0 },
    steps: [{ afterMs: 60, error: serverError() }, { texts: ['不该出现。'] }],
  });
  t.after(async () => { await cleanupRoot(root); });

  const { error, totalMs } = await rejectAsk(fastPath, '退避太大', { turn: 10 });

  assert.equal(calls.length, 1, 'the backoff cannot fit, so there is no second attempt');
  assert.equal(eventsOf(events, 'fastpath.retry').length, 0, 'a retry that never runs is not announced');
  assert.equal(error.fastpathFailure.reason, 'budget-exhausted');
  assert.equal(error.fastpathFailure.lastReason, 'server-error', 'the provider reason is kept for diagnosis');
  assert.equal(error.fastpathFailure.delayMs, 60);
  assert.equal(error.fastpathFailure.attempts, 1);
  assert.equal(error.fastpathFailure.remainingMs, 0, 'the arithmetic is clamped, never negative');
  assert.ok(totalMs <= 130, `total ${totalMs} ms stays within the 100 ms budget + 30 ms`);
  t.diagnostic(`budget=100ms firstFail≈60ms backoff=60ms -> afterWaitMs<0 attempts=${calls.length} reason=${error.fastpathFailure.reason} lastReason=${error.fastpathFailure.lastReason} total=${totalMs}ms (≤130ms)`);
});

// ---------------------------------------------------------------------------
// 11. the real host turns the verdict into the failed event and the notice
// ---------------------------------------------------------------------------

test('11. 真实宿主：预算 5ms -> fastpath.failed reason=budget-exhausted、attempts=1、无模型请求', async (t) => {
  const app = await mount(t, [{ texts: ['不该被请求。'] }], { fastpathStreamTimeoutMs: 5 });
  app.say('预算用完了');
  const failed = await app.waitForEvent('fastpath.failed');
  const shown = await app.waitForEvent('fastpath.failed.shown');
  await tick(80);
  const rows = await app.events();

  assert.equal(failed.reason, 'budget-exhausted', 'the event distinguishes a budget verdict from a provider error');
  assert.equal(failed.retryable, false);
  assert.equal(failed.attempts, 1);
  assert.match(String(failed.error ?? ''), /预算/u);
  assert.equal(shown.reason, 'budget-exhausted');
  assert.equal(shown.spoken, true, 'the failure notice still plays');
  assert.equal(state.llmCalls.length, 0, 'no model request');
  assert.equal(ofType(rows, 'fastpath.retry').length, 0, 'nothing to retry');
  assert.deepEqual(state.texts, [FAILED_LINE], 'only the notice reached TTS');
  assert.equal(app.agentLoop.calls, 0, 'never fell back to the agent lane');
  t.diagnostic(`budget=5ms attempts=${failed.attempts} reason=${failed.reason} requests=${state.llmCalls.length} retries=0 notice="${FAILED_LINE}" spoken=${shown.spoken}`);
});

