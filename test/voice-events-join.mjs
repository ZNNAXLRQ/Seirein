/**
 * Voice events join keys: `turn` + `deliveryMessageId`, and the C2 recall join.
 *
 * The DSH session log already rebuilds a turn (turn/start, step/start, tool/call, tool/result,
 * assistant/message). What it could not answer is which plugin event belongs to that turn, so
 * these tests prove:
 *   1. `voice.injected` carries `turn` (the loop's own turn) and `deliveryMessageId` (= request.id,
 *      the id the session writes as `user/message.data.id`);
 *   2. `voice.reply` carries `sessionId` + `turn` + `deliveryMessageId`, and
 *      `voice.first-sentence` / `voice.latency` / `voice.stream.probe` carry `turn`;
 *   3. `voice.injected.memoryHits/memoryInjected` are the same turn's C2 `memory.recall`
 *      (4 constructed hits), not the old fabricated `{hits:0, injected:false}`;
 *   4. a stage that was not observed is null (never a fabricated 0);
 *   5. when no recall is observed, the fields stay null instead of inventing a result;
 *   6. a turn learned during the recall wait is published with that same turn's hits (one snapshot,
 *      never a stale pre-wait turn next to fresh hits);
 *   7. a wait that ends with the turn still unknown publishes null/null, never another turn's recall.
 *   8. P-46 stage 2: `speech.seat.wait` is written to the same log with the round's session/turn.
 *
 * The real host is mounted with a fake hearing/TTS/player and a synthetic agent that commits one
 * turn per delivery and runs the registered `agent/pre-step` waterfall, so the C2 recall happens
 * exactly where it does in production. No microphone, ffmpeg, TTS service, network or GUI is used.
 *
 * Run: node --test test/voice-events-join.mjs
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { registerHooks } from 'node:module';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cleanupRoot } from './helpers/cleanup.mjs';
import { MemoryStore } from '../src/host/memory/store.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Shared with the short-circuited modules and the patched EventLog. */
const state = {
  events: [],
  followups: [],
  onUpdate: null,
  players: [],
  synthesized: [],
  listenerErrors: [],
};
globalThis.__voiceEventsJoin = state;

const FAKE_REPLY = '好的。我这就去查。';

const moduleUrl = (path) => new URL(path, import.meta.url).href;
const hearingUrl = moduleUrl('../src/host/hearing/hearing.js');
const sightUrl = moduleUrl('../src/host/vision/sight.js');
const ttsUrl = moduleUrl('../src/host/speech/tts.js');

const hooks = registerHooks({
  load(href, context, next) {
    if (href === hearingUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          const s = globalThis.__voiceEventsJoin;
          export const modelReady = () => true;
          export const finalModelReady = () => false;
          export const isLoopbackDevice = (name) => /CABLE|Stereo Mix|Virtual/i.test(String(name));
          export const listDevices = async () => ['Fake Mic'];
          export const startHearing = (options) => {
            s.onUpdate = options.onUpdate;
            return { device: options.device, stop() {}, stats: () => null };
          };
          export const watchHearingExit = () => {};
          export const annotateTranscript = (text) => text;
          export const joinDetailFields = () => ({});
          export const mergeJoinFallback = () => ({});
          export const offlineLimitedNote = () => '';
          export const truncationNotice = () => '';
        `,
      };
    }
    if (href === sightUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          const forbidden = async () => { throw new Error('capture forbidden'); };
          export const resolveFfmpeg = () => 'ffmpeg-fake';
          export const resolveFfplay = () => null;
          export const capture = forbidden;
          export const captureDesktop = forbidden;
          export const captureDevice = forbidden;
          export const startStoryboard = forbidden;
          export const OBSERVATION_TTL_MS = 30000;
          export function readObservation(o, { now = Date.now(), ttlMs = 30000 } = {}) { const v = o ?? {}; const c = Number(v.capturedAt); const s = Number.isFinite(c) && c > 0 ? c : Number(v.at); const at = Number.isFinite(s) && s > 0 ? s : null; const ageMs = at === null ? null : Math.max(0, now - at); const stale = ageMs === null || ageMs >= ttlMs; return { ...v, at, ageMs, stale, hint: stale ? 'stale' : '' }; }
        `,
      };
    }
    if (href === ttsUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          const s = globalThis.__voiceEventsJoin;
          export { resolveGptLangs, resolveGptSovitsTimeout } from '${ttsUrl}?voice-events-join-helpers';
          export const configureTts = () => {};
          export const gptSovitsReferenceStatus = async () => ({ seconds: null, ok: false, readable: false });
          export const warmupGptSovits = async () => ({ ok: false, skipped: 'disabled' });
          export const applyGptSovitsModels = () => ({ ok: true });
          export const synthesize = async ({ text }) => {
            s.synthesized.push(text);
            return { file: 'fake-' + s.synthesized.length + '.mp3', bytes: 16, durationMs: 120, provider: 'edge-tts' };
          };
          export const speakStreaming = async () => { throw new Error('streaming not expected'); };
          export const stopPlayback = () => true;
          export const stopTts = () => true;
          export const play = (file, options) => {
            let resolve;
            const done = new Promise((doneResolve) => { resolve = doneResolve; });
            s.players.push({ file, onStart: options?.onStart, resolve, settled: false });
            return done;
          };
        `,
      };
    }
    return next(href, context);
  },
});

const { apply } = await import('../src/host/index.js');
const { EventLog } = await import('../src/host/memory/store.js');
hooks.deregister();

const originalEmit = EventLog.prototype.emit;
EventLog.prototype.emit = async function emit(type, payload) {
  state.events.push({ type, payload });
  return { id: 'voice-events-join', ts: new Date().toISOString(), type, payload };
};

after(() => {
  EventLog.prototype.emit = originalEmit;
  delete globalThis.__voiceEventsJoin;
});

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

async function until(predicate, label, timeoutMs = 8_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await sleep(10);
  }
  assert.fail(`timed out: ${label}`);
}

/** Resolve every clip the fake player received; callbacks that never fire would stall `finish()`. */
function drainPlayers() {
  for (const player of state.players) {
    if (player.settled === true) continue;
    player.settled = true;
    try {
      player.onStart?.({ startedAt: Date.now() });
    } catch {
      /* the start callback is a caption hook */
    }
    player.resolve();
  }
}

/** Wait for one event while keeping the fake playback moving. */
async function untilEvents(predicate, label) {
  await until(() => {
    drainPlayers();
    return predicate();
  }, label);
}

/** One session-event bus that isolates a throwing listener, like the real dispatch does. */
function createBus() {
  const listeners = new Set();
  return {
    on(type, fn) {
      const entry = { type, fn };
      listeners.add(entry);
      return () => listeners.delete(entry);
    },
    fire(type, ...args) {
      for (const entry of [...listeners]) {
        if (entry.type !== type) continue;
        try {
          entry.fn(...args);
        } catch (error) {
          state.listenerErrors.push({ type, error: error?.message ?? String(error) });
        }
      }
    },
    /** Await a waterfall (the plugin's `agent/pre-step` listener) the way the loop does. */
    async dispatch(type, ...args) {
      let result;
      for (const entry of [...listeners]) {
        if (entry.type !== type) continue;
        result = await entry.fn(...args);
      }
      return result;
    },
  };
}

/** Seed real memory records so the pre-step recall has exactly four hits for the utterance. */
function seed(root, texts) {
  const store = new MemoryStore(root);
  store.open();
  for (const [index, text] of texts.entries()) {
    // One session per record: adjacent rows would arrive as context pairs and inflate the hit
    // count, and this fixture needs four direct hits exactly.
    store.addMessage({
      sessionId: `join-seed-${index}`,
      turnId: 1,
      role: 'user',
      clarity: 'vivid',
      importance: 60,
      messageId: `join-seed-${index}`,
      text,
    });
  }
  store.close();
}

/**
 * Mount the plugin against a temp root. The fake agent commits one synthetic turn per delivery and
 * runs the real `agent/pre-step` waterfall before the assistant message, exactly like the loop.
 */
async function mount(t, {
  memory = true,
  seeds = null,
  // Fixture timing controls. The turn number the fake loop starts from, an optional delay before
  // it publishes this delivery's events (so the recall join begins with `stage.turn === null`),
  // a string turn id (the delivery can settle while the voice stage never sees a safe-integer
  // turn), and a delay before `turn/end`.
  startTurn = 1,
  deferEventsMs = 0,
  stringTurn = false,
  endDelayMs = 0,
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-voice-events-join-'));
  await mkdir(join(root, 'data'), { recursive: true });
  await mkdir(join(root, 'workspace'), { recursive: true });
  // Seed through the real store before the plugin opens its own handle on the same root.
  if (Array.isArray(seeds) && seeds.length > 0) seed(root, seeds);
  await writeFile(join(root, 'data', 'features.json'), JSON.stringify({
    hearing: true,
    ambient: false,
    voice: true,
    vision: false,
    subtitle: false,
    avatar: false,
    memory,
    fastpath: false,
  }), 'utf8');
  await writeFile(join(root, 'data', 'settings.json'), JSON.stringify({
    gptSovits: { enabled: false },
    langs: { speech: 'zh', subtitle: 'zh' },
    // The live session's own messages must not enter the recall of this same turn: the fixture
    // counts exactly the four seeded hits.
    autoMemory: { enabled: false },
  }), 'utf8');

  state.events = [];
  state.followups = [];
  state.onUpdate = null;
  state.players = [];
  state.synthesized = [];
  state.listenerErrors = [];
  state.deliveryAt = 0;
  state.turnStartedAt = 0;

  const bus = createBus();
  const cleanups = [];
  const tools = new Map();
  const services = new Map([
    ['agentDefaultModel', { currentSelection: () => ({ provider: 'fake-provider', model: 'fake-model' }) }],
    ['sessionTitle', { get: () => undefined, rename: (_session, title) => ({ title, source: { kind: 'user' } }) }],
    ['workspaceRegistry', {
      async create(path) {
        return { id: 'ws-voice-events-join', path };
      },
      get() {
        return { id: 'ws-voice-events-join', async attachSession() {} };
      },
    }],
  ]);
  const agents = new Map();
  let persisted = false;
  const makeAgent = (sessionId) => {
    const session = {
      id: sessionId,
      header: { cwd: join(root, 'workspace') },
      append() {},
    };
    let turn = startTurn - 1;
    const agent = {
      id: sessionId,
      session,
      followup(message) {
        state.followups.push(message);
        state.deliveryAt = Date.now();
        turn += 1;
        const turnId = turn;
        // The loop's turn id as the event log carries it. A string id still binds (and settles)
        // the delivery in `awaitSessionResult`, but it is never a safe integer for the voice
        // stage's `stage.turn`: the fixture can therefore model "the wait ended with an unknown
        // turn" without leaving an unacknowledged 180 s waiter behind.
        const loopTurn = stringTurn ? String(turnId) : turnId;
        const fire = (type, data) => bus.fire('session/event', session, {
          type,
          seq: state.events.length + turnId,
          time: Date.now(),
          data,
        });
        const runTurn = () => {
          state.turnStartedAt = Date.now();
          fire('turn/start', { turn: loopTurn });
          fire('user/message', message);
          // The loop awaits the pre-step waterfall before the first request of the turn.
          void bus.dispatch('agent/pre-step', {
            agent,
            turn: turnId,
            step: 1,
            signal: new AbortController().signal,
            messages: [message],
          }, async () => ({ kind: 'enter', messages: [message] }))
            .catch(() => null)
            .then(() => {
              fire('assistant/message', {
                turn: loopTurn,
                step: 1,
                message: {
                  id: `a-${turnId}`,
                  role: 'assistant',
                  content: [{ type: 'text', text: FAKE_REPLY }],
                },
              });
              const finishTurn = () => fire('turn/end', { turn: loopTurn, reason: { kind: 'completed' } });
              if (endDelayMs > 0) setTimeout(finishTurn, endDelayMs);
              else finishTurn();
            });
        };
        if (deferEventsMs > 0) setTimeout(runTurn, deferEventsMs);
        else runTurn();
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
  const ctx = {
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
  };
  apply(ctx, { root, enabled: true, asrMergeWindowMs: 10 });
  t.after(async () => {
    drainPlayers();
    await cleanupRoot(root, cleanups.splice(0));
  });

  const listen = tools.get('assistant_listen');
  assert.ok(listen !== undefined, 'assistant_listen is registered');
  const started = await listen.execute({ action: 'start' });
  assert.equal(started.ok, true, `listening started: ${started.error ?? ''}`);
  assert.equal(typeof state.onUpdate, 'function', 'the hearing session exposes onUpdate');

  const rows = (type) => state.events.filter((entry) => entry.type === type);
  return { root, rows, say: (text) => state.onUpdate({ final: text, durationMs: 100 }) };
}

/** Run one real voice round: the utterance, then wait until its reply events exist. */
async function runVoiceRound(app, utterance) {
  app.say(utterance);
  await untilEvents(() => app.rows('voice.latency').length === 1, 'voice.latency');
  return {
    injected: app.rows('voice.injected')[0]?.payload ?? null,
    reply: app.rows('voice.reply')[0]?.payload ?? null,
    firstSentence: app.rows('voice.first-sentence')[0]?.payload ?? null,
    latency: app.rows('voice.latency')[0].payload,
    probe: app.rows('voice.stream.probe')[0]?.payload ?? null,
    // P-46: the round's own timeline row, emitted before `voice.latency` on the spoken path.
    timeline: app.rows('voice.turn.timeline')[0]?.payload ?? null,
    // P-46 stage 0: `voice.pipeline.timeline` gained the same session/delivery join keys.
    pipeline: app.rows('voice.pipeline.timeline')[0]?.payload ?? null,
    recalls: app.rows('memory.recall').map((entry) => entry.payload),
  };
}

// ---------------------------------------------------------------------------
// 1) injected join keys + the C2 recall join (4 hits)
// ---------------------------------------------------------------------------

test('1) a real voice round joins voice.injected to its turn, delivery message and recall', async (t) => {
  const app = await mount(t, {
    seeds: [
      '我很喜欢月光下的散步，昨晚也是',
      '月光下的散步让我心情很好',
      '上周也在月光下散步，风很轻',
      '月光下的散步结束后我买了热咖啡',
    ],
  });
  const round = await runVoiceRound(app, '月光下的散步你还记得吗');

  // The session is created by this mount, but there is no digest turn any more: the day
  // background rides the request's own pre-step, so the utterance is turn 1. A fixed 1 is the
  // right turn here, and the join below must still carry it verbatim.
  const request = state.followups.at(-1);
  assert.equal(round.injected.turn, 1, 'injected carries the loop turn that the request opened');
  assert.equal(round.injected.deliveryMessageId, request.id, 'deliveryMessageId is the delivered request id');

  // The same turn's C2 recall, not the voice lane's old fixed {hits:0, injected:false}.
  const recall = round.recalls.find((payload) => payload.turn === round.injected.turn);
  assert.ok(recall !== undefined, 'the same turn logged a memory.recall');
  assert.equal(recall.hits, 4, 'four constructed records matched');
  assert.equal(recall.injected, true);
  assert.equal(round.injected.memoryHits, recall.hits, 'memoryHits mirrors memory.recall.hits');
  assert.equal(round.injected.memoryInjected, recall.injected, 'memoryInjected mirrors memory.recall.injected');

  // A second round in the same session joins its own turn: it must not inherit round 1's four
  // hits, and a real recall with no match is reported as 0/false (not null, not round 1's 4).
  app.say('请列出三个编译器的名字');
  await untilEvents(() => app.rows('voice.latency').length === 2, 'the second voice.latency');
  const secondRequest = state.followups.at(-1);
  const secondInjected = app.rows('voice.injected')
    .map((entry) => entry.payload)
    .find((payload) => payload.deliveryMessageId === secondRequest.id);
  assert.ok(secondInjected !== undefined, 'the second round logged its own voice.injected');
  const secondRecall = app.rows('memory.recall')
    .map((entry) => entry.payload)
    .find((payload) => payload.turn === secondInjected.turn);
  assert.equal(secondInjected.turn, 2, 'the second round is its own turn (1 is not reused)');
  assert.ok(secondRecall !== undefined, 'the second turn logged its own memory.recall');
  assert.equal(secondRecall.hits, 0, 'the unrelated question matched nothing');
  assert.equal(secondInjected.memoryHits, 0, 'a real recall with no hit is 0, not round 1\'s 4');
  assert.equal(secondInjected.memoryInjected, false);

  console.log(`[1] injected turn=${round.injected.turn} deliveryMessageId=${round.injected.deliveryMessageId} `
    + `memoryHits=${round.injected.memoryHits} memoryInjected=${round.injected.memoryInjected}; `
    + `second turn=${secondInjected.turn} memoryHits=${secondInjected.memoryHits}`);
});

// ---------------------------------------------------------------------------
// 2) reply / first-sentence / latency / probe carry the turn
// ---------------------------------------------------------------------------

test('2) voice.reply, voice.first-sentence, voice.latency and the stream probe carry the turn', async (t) => {
  const app = await mount(t);
  const round = await runVoiceRound(app, '帮我看看明天的天气');
  const request = state.followups.at(-1);

  assert.equal(round.reply.turn, 1, 'voice.reply.turn');
  assert.equal(round.reply.sessionId, round.injected.sessionId, 'voice.reply.sessionId');
  assert.equal(round.reply.deliveryMessageId, request.id, 'voice.reply.deliveryMessageId');
  assert.equal(round.firstSentence.turn, 1, 'voice.first-sentence.turn');
  assert.equal(round.latency.turn, 1, 'voice.latency.turn');
  assert.equal(round.probe.turn, 1, 'voice.stream.probe.turn');
  assert.equal(round.injected.turn, 1, 'and the injected row agrees');
  // P-46: the round's timeline row joins on the same delivery, session and turn.
  assert.ok(round.timeline !== null, 'the spoken round logged voice.turn.timeline');
  assert.equal(round.timeline.sessionId, round.injected.sessionId, 'voice.turn.timeline.sessionId');
  assert.equal(round.timeline.deliveryMessageId, request.id, 'voice.turn.timeline.deliveryMessageId');
  assert.equal(round.timeline.acceptTurn, 1, 'voice.turn.timeline.acceptTurn');
  assert.equal(round.timeline.turn, 1, 'voice.turn.timeline.turn');
  assert.equal(round.timeline.status, 'ok');
  // P-46 stage 0: the existing pipeline timeline is joinable too; its own fields are unchanged.
  assert.ok(round.pipeline !== null, 'the round logged voice.pipeline.timeline');
  assert.equal(round.pipeline.sessionId, round.injected.sessionId, 'voice.pipeline.timeline.sessionId');
  assert.equal(round.pipeline.deliveryMessageId, request.id, 'voice.pipeline.timeline.deliveryMessageId');
  assert.equal(round.pipeline.turn, 1, 'voice.pipeline.timeline still carries its own turn');
  assert.ok(Number.isInteger(round.pipeline.bodyReadyMs), 'the existing stages are untouched');
  // The same round: every join key points at one turn.
  assert.deepEqual(
    new Set([round.injected.turn, round.reply.turn, round.firstSentence.turn, round.latency.turn,
      round.probe.turn, round.timeline.turn]),
    new Set([1]),
  );
  // P-46 stage 2: the playback seat wait is written to this same event log with the caller's
  // session/turn attribution, so it joins the round like any other speech row.
  const seatWaits = app.rows('speech.seat.wait').map((entry) => entry.payload);
  const replySeat = seatWaits.find((row) => row.turn === 1 && row.sessionId === round.injected.sessionId);
  assert.ok(replySeat !== undefined, 'the round logged an attributed speech.seat.wait');
  assert.ok(Number.isInteger(replySeat.waitMs) && replySeat.waitMs >= 0, 'seat waitMs is a measured duration');
  assert.ok(typeof replySeat.outcome === 'string' && replySeat.outcome.length > 0, 'seat outcome is present');

  console.log(`[2] reply turn=${round.reply.turn} first-sentence turn=${round.firstSentence.turn} `
    + `latency turn=${round.latency.turn} probe turn=${round.probe.turn} deliveryMessageId=${round.reply.deliveryMessageId} `
    + `timeline turn=${round.timeline.turn} status=${round.timeline.status} `
    + `seat turn=${replySeat.turn} waitMs=${replySeat.waitMs} outcome=${replySeat.outcome}`);
});

// ---------------------------------------------------------------------------
// 3) an unobserved stage is null, never a fabricated 0
// ---------------------------------------------------------------------------

test('3) an unobserved stage stays null (the real round had no ASR endpoint stamp)', async (t) => {
  const app = await mount(t);
  const round = await runVoiceRound(app, '这句没有端点时间戳');
  // This round supplies no endpointAt/asrMs: the ASR stage was not observed.
  assert.equal(round.latency.asrMs, null, 'an unobserved stage is null, not 0');
  for (const field of ['injectToAckMs', 'ackToFirstTextMs', 'firstTextToFirstSentenceMs',
    'firstSentenceToFirstAudioMs', 'totalMs']) {
    assert.equal(Number.isInteger(round.latency[field]), true, `${field} was measured`);
    assert.ok(round.latency[field] >= 0, `${field} is non-negative`);
  }
  console.log(`[3] asrMs=${JSON.stringify(round.latency.asrMs)} totalMs=${round.latency.totalMs} `
    + `injectToAckMs=${round.latency.injectToAckMs}`);
});

// ---------------------------------------------------------------------------
// 4) no observed recall -> null, never an invented {hits:0, injected:false}
// ---------------------------------------------------------------------------

test('4) voice.injected keeps memoryHits/memoryInjected null when no recall was observed', async (t) => {
  const app = await mount(t, { memory: false });
  const round = await runVoiceRound(app, '记忆关闭时也不该编造命中数');

  assert.equal(round.recalls.length, 0, 'the memory lane is off, so nothing recalled');
  assert.equal(round.injected.turn, 1, 'the turn join key still exists');
  assert.equal(round.injected.deliveryMessageId, state.followups.at(-1).id);
  assert.equal(round.injected.memoryHits, null, 'no observed recall -> null, not 0');
  assert.equal(round.injected.memoryInjected, null, 'no observed recall -> null, not false');
  console.log(`[4] memoryHits=${JSON.stringify(round.injected.memoryHits)} `
    + `memoryInjected=${JSON.stringify(round.injected.memoryInjected)} turn=${round.injected.turn}`);
});

// ---------------------------------------------------------------------------
// 5) the turn becomes known DURING the recall wait: one snapshot, no stale null
// ---------------------------------------------------------------------------

test('5) a turn learned during the recall wait is published together with that turn\'s hits', async (t) => {
  const app = await mount(t, {
    // There is no digest turn before the request: the delivered request is turn 6 itself.
    startTurn: 6,
    deferEventsMs: 120, // the join's wait starts while `stage.turn` is still null
    seeds: [
      '我很喜欢月光下的散步，昨晚也是',
      '月光下的散步让我心情很好',
      '上周也在月光下散步，风很轻',
      '月光下的散步结束后我买了热咖啡',
    ],
  });
  const round = await runVoiceRound(app, '月光下的散步你还记得吗');

  // The fixture delayed turn/start for longer than the microtask that starts the join, so the
  // pre-wait snapshot was null; the published row must carry the turn that was learned while
  // waiting, and the hits of that same turn (not a stale-null row next to fresh hits).
  assert.ok(state.turnStartedAt - state.deliveryAt >= 100,
    'the loop acknowledged the turn only after the recall wait had begun');
  assert.equal(round.injected.turn, 6, 'the turn learned during the wait is published');
  const recall = round.recalls.find((payload) => payload.turn === round.injected.turn);
  assert.ok(recall !== undefined, 'the same turn logged a memory.recall');
  assert.equal(recall.hits, 4);
  assert.equal(round.injected.memoryHits, 4, 'memoryHits is the same turn\'s recall, not null');
  assert.equal(round.injected.memoryInjected, true);
  console.log(`[5] turn=${round.injected.turn} memoryHits=${round.injected.memoryHits} `
    + `memoryInjected=${round.injected.memoryInjected} recallHits=${recall.hits}`);
});

// ---------------------------------------------------------------------------
// 6) the wait ends with the turn still unknown: null/null, never another turn's recall
// ---------------------------------------------------------------------------

test('6) an unknown turn keeps turn/memoryHits null instead of borrowing another turn\'s hits', async (t) => {
  const app = await mount(t, {
    startTurn: 6,
    stringTurn: true, // the delivery settles, but the voice stage never sees a safe-integer turn
    endDelayMs: 2_400, // longer than VOICE_RECALL_WAIT_MS: the recall wait really times out
    seeds: [
      '我很喜欢月光下的散步，昨晚也是',
      '月光下的散步让我心情很好',
      '上周也在月光下散步，风很轻',
      '月光下的散步结束后我买了热咖啡',
    ],
  });
  app.say('月光下的散步你还记得吗');
  await untilEvents(() => app.rows('voice.injected').length === 1, 'voice.injected (unknown turn)');
  // The recall exists under turn 6; an emit with no observed turn must not use it.
  await untilEvents(() => app.rows('memory.recall').some((entry) => entry.payload.turn === 6), 'turn 6 recall');
  await untilEvents(() => app.rows('voice.latency').length === 1, 'voice.latency (unknown turn)');

  const injected = app.rows('voice.injected')[0].payload;
  const recall = app.rows('memory.recall').map((entry) => entry.payload).find((payload) => payload.turn === 6);
  assert.equal(recall.hits, 4, 'a turn 6 recall with four hits was observed during the wait');
  assert.equal(injected.turn, null, 'the turn the wait could not observe stays null');
  assert.equal(injected.memoryHits, null, 'another turn\'s hits are never mixed into a null turn');
  assert.equal(injected.memoryInjected, null, 'another turn\'s injected flag is never mixed in');
  console.log(`[6] turn=${JSON.stringify(injected.turn)} `
    + `memoryHits=${JSON.stringify(injected.memoryHits)} `
    + `memoryInjected=${JSON.stringify(injected.memoryInjected)} observedRecallHits=${recall.hits}`);
});
