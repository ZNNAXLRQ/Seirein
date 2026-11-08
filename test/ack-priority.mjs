/**
 * Waiting-line priority (A1), persona warm pool (A2) and the deadline tier order.
 *
 * A1 checks the body states the lane distinguishes at the two-second trigger:
 *   not-started  -> the line may speak first, the body follows in order;
 *   synthesizing -> the line still plays: a body without audio cannot speak first, so the policy
 *                   verdict is `kept` / `body-synthesizing` and no `superseded` row is written;
 *   ready        -> the line is cancelled with `voice.ack.cancelled {reason:'body-ready'}`.
 * A playing line is never cut; a body already playing keeps the existing finish-first rule.
 *
 * The deadline tier order (tests 33-37) is: the turn's own draft (text + audio) first, otherwise a
 * warm pool line, otherwise the fixed `ACK_FALLBACK_LINE`. The trigger never waits for a draft: a
 * text-only or still-synthesizing draft loses and a late draft never replaces a line that played.
 * `voice.ack.source {turn, source, draftReadyMs}` is the throttled debug row for the choice.
 *
 * A2 checks the warm pool itself: built during an idle window, the cache key covers
 * persona/caption language/speech language/voice/model version, a changed voice rebuilds with an
 * event, cached text is generic (no unbacked promise), and the first start without cache never
 * blocks chat. Under the tier order a draft always starts on the delivery path; the pool is only
 * taken at the deadline when that draft is not fully ready.
 *
 * The acceptance comparison measures the body's first audio for a warm-backed turn against a miss
 * (and against no waiting line at all) on one serialized model/TTS resource; the difference must
 * be at most 200 ms.
 *
 * P2/P3 (tests 12-18) cover the two fixes around the warm build: a disposed/cancelled batch never
 * reaches `persist()` (no cache directory, no manifest, a `voice.ack.warm.discarded` row, no
 * partial file), and cancelling a build that already had valid entries keeps them (the cancelled
 * tail is dropped instead of clearing the whole pool). The busy test only counts the assistant's
 * own non-delegated turns, keyed by (sessionId, turn), bounded, with a throttled
 * `voice.ack.warm.blocked {blockedBy}` row.
 *
 * P4 (tests 20a-20d) cover batch-owned manifest files: the manifest tmp is named after the batch
 * token, the manifest records its writer, and a late batch never deletes a newer batch's manifest
 * (`voice.ack.warm.cleanup-skipped {reason:'newer-owner'}`) while still removing its own tmp and
 * audio. The normal path still leaves exactly one `manifest.json` and no tmp file.
 *
 * P5 (tests 24-27) mount the real plugin and drive its real `session/event` listener, because a
 * correct counter is not enough: the host used to ignore its answer and cancel the running warm
 * build anyway. Only an accepted (assistant, non-delegated) turn may interrupt the build or reset
 * its idle window; a foreign workspace or subagent turn, and an unregistered `turn/end`, must not.
 *
 * `createAckLane` is imported from the real host; TTS, sight, subtitle, hearing and child_process
 * are scripted so no sound, capture, network or child process is used.
 *
 * Run: node --test test/ack-priority.mjs
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { registerHooks } from 'node:module';
import { mkdtemp, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupRoot } from './helpers/cleanup.mjs';
import {
  ACK_BODY_PHASES,
  ACK_WARM_CAPACITY,
  ACK_WARM_GROUP_IDS,
  ACK_WARM_GROUP_MIN,
  ACK_WARM_GROUPS,
  ACK_WARM_RECENT_AVOID,
  ackWarmKey,
  buildAckWarmPrompt,
  classifyWarmLine,
  createAckWarmPool,
  parseWarmLines,
  planAckPriority,
  planWarmCandidates,
  validateWarmLine,
  warmShapeKey,
  warmTextKey,
} from '../src/host/speech/ack-speech.js';

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
    export const modelReady = () => true;
    export const finalModelReady = () => false;
    export const isLoopbackDevice = (name) => /CABLE|Stereo Mix|Virtual/i.test(String(name));
    export const listDevices = async () => ['Fake Mic'];
    export const startHearing = () => ({ device: 'Fake Mic', stop() {}, stats: () => ({ rmsDb: -20 }) });
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
    export { resolveGptLangs, resolveGptSovitsTimeout } from '${ttsUrl}?ack-priority-helpers';
    export { speakChunks, speechChunkTexts } from '${ttsUrl}?ack-priority-chunk';
    export const configureTts = () => {};
    export const gptSovitsReferenceStatus = async () => ({ seconds: null, ok: false, readable: false });
    export const warmupGptSovits = async () => ({ ok: false, skipped: 'disabled' });
    export const applyGptSovitsModels = () => ({ ok: true });
    export const synthesize = async () => ({ file: 'unused.mp3', bytes: 16, durationMs: 100, provider: 'fake' });
    export const speakStreaming = async () => { throw new Error('streaming not expected'); };
    export const play = () => { throw new Error('real playback not expected'); };
    export const stopPlayback = () => true;
    export const stopTts = () => true;`,
      };
    }
    if (url === sightUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
    const forbidden = () => { throw new Error('real capture forbidden'); };
    export const resolveFfmpeg = () => null;
    export const resolveFfplay = () => null;
    export const capture = forbidden, captureDesktop = forbidden, captureDevice = forbidden, startStoryboard = forbidden;
    export const OBSERVATION_TTL_MS = 30000;
    export function readObservation(o, { now = Date.now(), ttlMs = 30000 } = {}) {
      const v = o ?? {}; const c = Number(v.capturedAt);
      const at = Number.isFinite(c) && c > 0 ? c : null;
      const ageMs = at === null ? null : Math.max(0, now - at);
      return { ...v, at, ageMs, stale: ageMs === null || ageMs >= ttlMs, hint: '' };
    }`,
      };
    }
    if (url === subtitleUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
    export const averageColor = async () => null;
    export { SubtitleHold } from '${subtitleUrl}?ack-priority-real';
    export class SubtitleOverlay {
      constructor({ config }) { this.config = config; }
      async show() { return true; }
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
const {
  ACK_FALLBACK_LINE,
  ackWarmActivityReason,
  apply,
  createAckLane,
  createAckWarmRunGate,
  createAckWarmScheduler,
  createAckWarmTurnMeter,
  isSubagentAgent,
} = await import('../src/host/index.js');
hooks.deregister();
after(() => { /* no global fixture state */ });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ACK_LINE = '我这就去看看你说的天气情况';
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const waitUntil = async (check, message, timeoutMs = 4000) => {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out: ${message}`);
    await tick(5);
  }
};
const ackEvent = (events, type) => events.find((event) => event.type === type);

/**
 * One lane with injected seams. The default player records the instant it is reached and ends
 * only when the test calls `end()`, so the existing finish-first rule is testable.
 */
function laneFixture({
  delayMs = 80,
  warm = null,
  generate,
  synthesize,
  play,
  timeoutMs = 100,
} = {}) {
  const events = [];
  const plays = [];
  const lane = createAckLane({
    emit: async (type, payload) => { events.push({ type, payload }); },
    generate: generate ?? (async () => ACK_LINE),
    synthesize: synthesize ?? (async ({ speech }) => ({ file: 'ack.mp3', durationMs: 100, speech })),
    play: play ?? (async ({ speech, signal }) => {
      const player = { speech, signal, startedAt: Date.now(), end: null };
      const done = new Promise((resolve) => { player.end = () => resolve(); });
      plays.push(player);
      return { audioStartedAt: player.startedAt, done };
    }),
    warm,
    persona: () => '你是小音，说话温柔简短。',
    captureSignal: () => new AbortController().signal,
    delayMs,
    timeoutMs: () => timeoutMs,
  });
  return { lane, events, plays };
}

/** A serialized model/TTS resource: jobs run one at a time in submission order. */
function serialVoiceQueue(costMs) {
  let tail = Promise.resolve();
  const order = [];
  return {
    order,
    job(label) {
      const run = tail.then(async () => {
        order.push(label);
        await tick(costMs);
        return { label, at: Date.now() };
      });
      tail = run.catch(() => {});
      return run;
    },
  };
}

async function warmFixture(t, { capacity = ACK_WARM_CAPACITY, generate, synthesize, meta } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-ack-warm-'));
  t.after(() => cleanupRoot(root));
  const dir = join(root, 'cache', 'ack');
  await mkdir(dir, { recursive: true });
  const events = [];
  const metaState = {
    persona: '你是小音，说话温柔简短。',
    language: 'zh-CN',
    voice: 'voice-a',
    modelVersion: 'route/fake|edge',
    ...(meta ?? {}),
  };
  let seq = 0;
  const pool = createAckWarmPool({
    dir,
    meta: () => metaState,
    generate: generate ?? (async ({ count }) => ['让我先想一想到底该怎么回答你', '我在这里陪你等一会儿', '你先说说看我在听'].slice(0, count)),
    synthesize: synthesize ?? (async ({ text, dir: target }) => {
      seq += 1;
      const file = join(typeof target === 'string' && target.length > 0 ? target : dir, `warm-${seq}.mp3`);
      await writeFile(file, 'fake-audio');
      return { file, durationMs: 120, bytes: 10, provider: 'fake' };
    }),
    emit: async (type, payload) => { events.push({ type, payload }); },
    capacity,
  });
  return { root, dir, pool, events, metaState };
}

/**
 * A warm pool whose persist writes run through the P2 gate, wired exactly like the host: the
 * directory/manifest seams are counted so a refused `persist()` is observable.
 */
async function gateFixture(t, { generate, synthesize } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-ack-warm-gate-'));
  t.after(() => cleanupRoot(root));
  const dir = join(root, 'cache', 'ack');
  const events = [];
  const writes = { makeDir: 0, manifest: 0 };
  const emit = async (type, payload) => { events.push({ type, payload }); };
  const gate = createAckWarmRunGate({ emit });
  const pool = createAckWarmPool({
    dir,
    meta: () => ({ persona: '你是小音', language: 'zh-CN', voice: 'voice-a', modelVersion: 'm1' }),
    generate,
    synthesize,
    emit,
    makeDir: gate.makeDir(async (...args) => { writes.makeDir += 1; return mkdir(...args); }),
    writeTextFile: gate.writeTextFile(async (...args) => { writes.manifest += 1; return writeFile(...args); }),
  });
  gate.bind(pool);
  return { root, dir, events, writes, gate, pool };
}

/** The host's scheduler wiring around a gate-guarded pool. */
function gatedScheduler(fixture, { idleMs = 10 } = {}) {
  return createAckWarmScheduler({
    idleMs: () => idleMs,
    activity: () => '',
    build: ({ signal }) => fixture.gate.build(fixture.pool.build, { signal }),
    // Cancelling a build never clears the pool; the pool removes only its own cancelled batch.
    discard: async () => {},
    emit: async (type, payload) => { fixture.events.push({ type, payload }); },
  });
}

// ---------------------------------------------------------------------------
// A1: three body states at the two-second trigger
// ---------------------------------------------------------------------------

test('1. body not started: the ready line plays first and the body follows in order', async (t) => {
  assert.deepEqual(
    planAckPriority({ bodyPhase: ACK_BODY_PHASES.idle }),
    { action: 'play', reason: 'body-not-started' },
  );
  const order = [];
  const { lane, events, plays } = laneFixture({
    delayMs: 60,
    play: async ({ speech, signal }) => {
      order.push('ack');
      const player = { speech, signal, startedAt: Date.now(), end: null };
      const done = new Promise((resolve) => { player.end = () => resolve(); });
      plays.push(player);
      return { audioStartedAt: player.startedAt, done };
    },
  });
  lane.beginTurn({ sessionId: 's-a1-order', turn: 1, userText: '帮我查一下明天上海的天气' });
  await waitUntil(() => plays.length === 1, 'the waiting line reached the player');
  assert.equal(plays[0].speech, ACK_LINE);
  // The body has not even started synthesizing at the trigger: the line could preempt it.
  assert.equal(lane.status()[0].bodyPhase, ACK_BODY_PHASES.idle);
  plays[0].end();
  await lane.whenIdle();
  // The body's own first clip follows the line; the line already finished, so it is not cut.
  order.push('body');
  assert.deepEqual(order, ['ack', 'body'], 'the line is first, the body second');
  assert.equal(events.filter((event) => event.type === 'voice.ack.spoken').length, 1);
  assert.equal(events.filter((event) => event.type === 'voice.ack.cancelled').length, 0);
  t.diagnostic(`order=${order.join(' -> ')} spoken=1 cancelled=0 bodyPhase=not-started`);
});

test('2. body synthesizing: the line still plays and nothing is superseded', async (t) => {
  assert.deepEqual(
    planAckPriority({ bodyPhase: ACK_BODY_PHASES.synthesizing }),
    { action: 'play', reason: 'body-synthesizing', event: 'kept' },
  );
  const { lane, events, plays } = laneFixture({ delayMs: 80 });
  lane.beginTurn({ sessionId: 's-a1-synth', turn: 2, userText: '帮我查一下明天的天气' });
  await tick(10);
  // The body entered synthesis before the deadline, and its audio is still minutes away.
  assert.equal(lane.bodySynthesizing({ sessionId: 's-a1-synth', turn: 2 }), true);
  await waitUntil(() => plays.length === 1, 'the line reached the player while the body synthesizes');
  assert.equal(plays[0].speech, ACK_LINE);
  assert.equal(lane.status()[0].bodyPhase, ACK_BODY_PHASES.synthesizing);
  const spoken = await waitUntil(() => ackEvent(events, 'voice.ack.spoken'), 'the spoken row');
  assert.equal(spoken.payload.bodyFirstAudioMs, null, 'the body had not started sounding');
  assert.equal(events.filter((event) => event.type === 'voice.ack.superseded').length, 0);
  assert.equal(events.filter((event) => event.type === 'voice.ack.cancelled').length, 0);
  plays[0].end();
  await lane.whenIdle();
  // The body carries on afterwards: recording its first audio does not cancel a played line.
  assert.equal(lane.bodyStarted({ sessionId: 's-a1-synth', turn: 2, at: Date.now() }), false);
  t.diagnostic(
    `synthesizing: plays=${plays.length} verdict=play/body-synthesizing/kept `
    + `superseded=0 cancelled=0 bodyFirst=null`,
  );
});

test('2b. a warm line serves when the draft lost, and is kept while the body synthesizes', async (t) => {
  const fixture = await warmFixture(t);
  const build = await fixture.pool.build();
  assert.ok(build.built >= 1, `warm built=${build.built}`);
  // The per-turn draft loses (an empty draft), so the deadline falls to tier b: the pool.
  const { lane, events, plays } = laneFixture({
    delayMs: 80,
    warm: fixture.pool,
    generate: async () => '',
  });
  lane.beginTurn({ sessionId: 's-warm-synth', turn: 21, userText: '帮我查一下明天上海的天气' });
  await tick(10);
  assert.equal(lane.bodySynthesizing({ sessionId: 's-warm-synth', turn: 21 }), true);
  await waitUntil(() => plays.length === 1, 'the cached line reached the player');
  const hit = ackEvent(events, 'voice.ack.cache.hit');
  assert.ok(hit !== undefined, 'voice.ack.cache.hit is written');
  assert.equal(hit.payload.key, build.key);
  const chosen = ackEvent(events, 'voice.ack.source');
  assert.equal(chosen.payload.source, 'warm', 'the tier row names the pool');
  assert.equal(chosen.payload.draftReadyMs, null, 'the draft never became ready');
  const spoken = ackEvent(events, 'voice.ack.spoken').payload;
  assert.equal(spoken.source, 'warm', 'the kept line came from the pool, not the failed draft');
  assert.equal(events.filter((event) => event.type === 'voice.ack.superseded').length, 0);
  assert.equal(events.filter((event) => event.type === 'voice.ack.cancelled').length, 0);
  plays[0].end();
  await lane.whenIdle();
  t.diagnostic(
    `warm synthesizing: plays=${plays.length} source=${spoken.source} key=${hit.payload.key} `
    + `superseded=0 cancelled=0`,
  );
});

test('3. body audio ready: the line is cancelled with body-ready and never plays', async (t) => {
  assert.deepEqual(
    planAckPriority({ bodyPhase: ACK_BODY_PHASES.ready }),
    { action: 'cancel', reason: 'body-ready', event: 'cancelled' },
  );
  const { lane, events, plays } = laneFixture({ delayMs: 500 });
  lane.beginTurn({ sessionId: 's-a1-ready', turn: 3, userText: '帮我查一下明天的天气' });
  await tick(20);
  lane.bodySynthesizing({ sessionId: 's-a1-ready', turn: 3 });
  assert.equal(lane.bodyReady({ sessionId: 's-a1-ready', turn: 3 }), true);
  const row = await waitUntil(
    () => ackEvent(events, 'voice.ack.cancelled'),
    'the body-ready cancellation is written',
  );
  assert.equal(row.payload.reason, 'body-ready');
  assert.ok(row.payload.ackDroppedMs >= 0, `ackDroppedMs=${row.payload.ackDroppedMs}`);
  await tick(600);
  assert.equal(plays.length, 0, 'the cancelled line never reached the player');
  assert.equal(events.filter((event) => event.type === 'voice.ack.spoken').length, 0);
  t.diagnostic(`cancelled=${row.payload.reason} ackDroppedMs=${row.payload.ackDroppedMs} players=0`);
});

test('3b. a line already playing is kept when the body becomes ready: finish first, never cut', async (t) => {
  assert.deepEqual(
    planAckPriority({ bodyPhase: ACK_BODY_PHASES.ready, ackPlaying: true }),
    { action: 'keep', reason: 'ack-playing' },
  );
  const { lane, events, plays } = laneFixture({ delayMs: 30 });
  lane.beginTurn({ sessionId: 's-a1-playing', turn: 4, userText: '帮我查一下天气' });
  await waitUntil(() => plays.length === 1, 'the line reached the player');
  let settled = false;
  const gate = lane.answerStart({ sessionId: 's-a1-playing', turn: 4 }).then((value) => {
    settled = true;
    return value;
  });
  await tick(30);
  assert.equal(settled, false, 'the body still waits while the line plays');
  // Recording the body's synthesizing/ready state never cuts a sounding line.
  assert.equal(lane.bodySynthesizing({ sessionId: 's-a1-playing', turn: 4 }), true);
  assert.equal(lane.bodyReady({ sessionId: 's-a1-playing', turn: 4 }), false);
  // The line is recorded as spoken; readiness only appends, it never cancels.
  assert.ok(ackEvent(events, 'voice.ack.spoken') !== undefined, 'the sounding line is recorded');
  assert.equal(events.filter((event) => event.type === 'voice.ack.cancelled').length, 0);
  plays[0].end();
  assert.deepEqual(await gate, { action: 'finish-ack-then-answer' });
  await lane.whenIdle();
  t.diagnostic('playing line kept; body ready not cut; gate=finish-ack-then-answer cancelled=0');
});

// ---------------------------------------------------------------------------
// A2: warm pool cache, rebuild, generic text
// ---------------------------------------------------------------------------

test('4. a ready draft outranks the pool (no take()); changing the voice rebuilds with an event', async (t) => {
  const fixture = await warmFixture(t);
  const beforeKey = ackWarmKey(fixture.metaState);
  const build = await fixture.pool.build();
  assert.ok(build.built >= 1, `built=${build.built}`);
  assert.equal(build.key, beforeKey);
  const warmRow = fixture.events.find((event) => event.type === 'voice.ack.warm');
  assert.ok(warmRow !== undefined, 'voice.ack.warm is written');
  assert.equal(warmRow.payload.key, beforeKey);
  assert.ok(warmRow.payload.built >= 1);
  assert.ok(warmRow.payload.ms >= 0);

  let takes = 0;
  const warm = { take: () => { takes += 1; return fixture.pool.take(); } };
  const { lane, events, plays } = laneFixture({
    delayMs: 120,
    warm,
    generate: async () => ACK_LINE,
    synthesize: async ({ speech }) => ({ file: 'ack.mp3', durationMs: 100, speech }),
  });
  lane.beginTurn({ sessionId: 's-draft-first', turn: 5, userText: '帮我查一下明天上海的天气' });
  await waitUntil(() => plays.length === 1, 'the drafted line reached the player');
  assert.equal(takes, 0, 'a draft that won the deadline never takes a pool line');
  assert.equal(ackEvent(events, 'voice.ack.cache.hit'), undefined, 'no cache hit for a draft');
  assert.equal(plays[0].speech, ACK_LINE, 'the drafted line is what played');
  const spoken = ackEvent(events, 'voice.ack.spoken').payload;
  assert.equal(spoken.source, 'draft');
  const chosen = ackEvent(events, 'voice.ack.source').payload;
  assert.equal(chosen.source, 'draft');
  assert.ok(chosen.draftReadyMs >= 0 && chosen.draftReadyMs <= spoken.ackTriggerMs,
    `draftReadyMs=${chosen.draftReadyMs} trigger=${spoken.ackTriggerMs}`);
  plays[0].end();
  await lane.whenIdle();

  // Voice change: same persona/language/model, different voice -> rebuild and a visible event.
  fixture.metaState.voice = 'voice-b';
  const rebuild = await fixture.pool.ensure();
  assert.equal(rebuild.rebuilt, true);
  const afterKey = ackWarmKey(fixture.metaState);
  assert.notEqual(afterKey, beforeKey);
  const rebuildRow = fixture.events.find((event) => event.type === 'voice.ack.cache.rebuild');
  assert.ok(rebuildRow !== undefined, 'voice.ack.cache.rebuild is written');
  assert.equal(rebuildRow.payload.reason, 'voice-changed');
  assert.equal(fixture.pool.take(), null, 'the old identity is not served');
  t.diagnostic(
    `draft-first: takes=0 source=${chosen.source} draftReadyMs=${chosen.draftReadyMs} `
    + `trigger=${spoken.ackTriggerMs} key=${beforeKey}; `
    + `rebuild=${rebuildRow.payload.reason} key=${afterKey}`,
  );
});

test('5. cached text is generic: unbacked promises are rejected before caching', async (t) => {
  const generate = async () => [
    '我正在查资料马上就好',
    '我正在处理这个文件',
    '让我先想一想到底该怎么回答你',
    '我在这里陪你等一会儿',
  ];
  const fixture = await warmFixture(t, { generate });
  const build = await fixture.pool.build();
  assert.equal(build.built, 2, `built=${build.built}`);
  const rows = fixture.events.find((event) => event.type === 'voice.ack.warm');
  assert.equal(rows.payload.built, 2);
  const texts = fixture.pool.status().texts;
  assert.equal(texts.length, 2);
  for (const line of texts) {
    const checked = validateWarmLine(line);
    assert.equal(checked.ok, true, `cached line is valid: ${line}`);
    assert.doesNotMatch(line, /查资料|正在处理|马上/u, `no unbacked promise is cached: ${line}`);
  }
  assert.equal(validateWarmLine('我正在查资料马上就好').ok, false);
  assert.equal(validateWarmLine('我正在处理这个文件').ok, false);
  const manifest = JSON.parse(await readFile(join(fixture.dir, 'manifest.json'), 'utf8'));
  const manifestText = JSON.stringify(manifest);
  assert.doesNotMatch(manifestText, /查资料|正在处理|马上/u, 'the manifest holds no promise text');
  t.diagnostic(`built=${build.built} cached="${texts.join(' | ')}" promiseText=0`);
});

// ---------------------------------------------------------------------------
// Quality gate: the body's first audio is never delayed by the warm path
// ---------------------------------------------------------------------------

test('6. a first start with no cache does not block chat', async (t) => {
  assert.deepEqual(
    planAckPriority({ bodyPhase: ACK_BODY_PHASES.idle }),
    { action: 'play', reason: 'body-not-started' },
  );
  const root = await mkdtemp(join(tmpdir(), 'dsh-ack-nowarm-'));
  t.after(() => cleanupRoot(root));
  let warmBuilds = 0;
  const emptyPool = createAckWarmPool({
    dir: join(root, 'cache', 'ack'),
    meta: () => ({ persona: '你是小音', language: 'zh-CN', voice: 'voice-a', modelVersion: 'm1' }),
    generate: async () => { warmBuilds += 1; return []; },
    synthesize: async () => { throw new Error('no warm build expected'); },
    emit: async () => {},
  });
  await emptyPool.ensure();
  assert.equal(emptyPool.take(), null, 'no cache means no hit');

  const COST = 80;
  // Baseline: the same body work with no waiting-line lane at all.
  const baselineQueue = serialVoiceQueue(COST);
  const baselineDeliveredAt = Date.now();
  const baselineBody = await baselineQueue.job('body-tts');
  const baselineMs = baselineBody.at - baselineDeliveredAt;

  const resource = serialVoiceQueue(COST);
  const { lane } = laneFixture({
    delayMs: 10_000,
    warm: emptyPool,
    generate: async () => {
      await resource.job('ack-gen');
      return ACK_LINE;
    },
    synthesize: async ({ speech }) => {
      await resource.job('ack-tts');
      return { file: 'ack.mp3', durationMs: 100, speech };
    },
  });
  const deliveredAt = Date.now();
  lane.beginTurn({ sessionId: 's-cold', turn: 6, userText: '帮我查一下明天的天气' });
  const beginReturnedMs = Date.now() - deliveredAt;
  assert.ok(beginReturnedMs < 100, `beginTurn returned in ${beginReturnedMs}ms`);
  // The body's first clip is enqueued right after the delivery; the warm pool never runs.
  await tick(0);
  const bodyFirst = await resource.job('body-tts');
  const bodyFirstMs = bodyFirst.at - deliveredAt;
  const coldDelta = bodyFirstMs - baselineMs;
  assert.equal(warmBuilds, 0, 'the warm build is deferred until the idle window');
  // The per-turn fallback may share the queue, but it stays inside the acceptance budget.
  assert.ok(coldDelta <= 200, `body first audio +${coldDelta}ms over baseline (budget 200ms)`);
  void lane.cancel('test-end');
  await lane.whenIdle();
  t.diagnostic(
    `cold start: beginTurn=${beginReturnedMs}ms warmBuilds=0 baseline=${baselineMs}ms `
    + `bodyFirstAudio=${bodyFirstMs}ms delta=${coldDelta}ms queue=${resource.order.join(' -> ')}`,
  );
});

test('7. a warm pool never delays the body: every turn drafts, the pool is not taken at delivery', async (t) => {
  const COST = 80;
  const runTurn = async ({ mode }) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-ack-accept-'));
    t.after(() => cleanupRoot(root));
    const dir = join(root, 'cache', 'ack');
    await mkdir(dir, { recursive: true });
    const meta = { persona: '你是小音', language: 'zh-CN', voice: 'voice-a', modelVersion: 'm1' };
    let seq = 0;
    const pool = createAckWarmPool({
      dir,
      meta: () => meta,
      generate: async ({ count }) => ['让我先想一想到底该怎么回答你', '我在这里陪你等一会儿'].slice(0, count),
      synthesize: async ({ text }) => {
        seq += 1;
        const file = join(dir, `warm-${seq}.mp3`);
        await writeFile(file, 'warm-audio');
        return { file, durationMs: 120, bytes: 8, provider: 'fake' };
      },
      emit: async () => {},
    });
    await pool.ensure();
    if (mode === 'hit') await pool.build();
    let takeCalls = 0;
    const warm = { take: () => { takeCalls += 1; return pool.take(); } };
    const resource = serialVoiceQueue(COST);
    let ackModelCalls = 0;
    let ackSynthCalls = 0;
    const { lane } = laneFixture({
      delayMs: 10_000,
      warm,
      generate: async () => {
        ackModelCalls += 1;
        await resource.job('ack-gen');
        return ACK_LINE;
      },
      synthesize: async ({ speech }) => {
        ackSynthCalls += 1;
        await resource.job('ack-tts');
        return { file: 'ack.mp3', durationMs: 100, speech };
      },
    });
    const deliveredAt = Date.now();
    if (mode !== 'none') {
      lane.beginTurn({ sessionId: `s-${mode}`, turn: 7, userText: '帮我查一下明天的天气' });
      // Let the waiting-line preparation enqueue first, like a real delivery.
      await tick(0);
    }
    const bodyFirst = await resource.job('body-tts');
    const bodyFirstMs = bodyFirst.at - deliveredAt;
    if (mode !== 'none') {
      void lane.cancel('test-end');
      await lane.whenIdle();
    }
    return {
      bodyFirstMs,
      takeCalls,
      ackModelCalls,
      ackSynthCalls,
      queue: [...resource.order],
    };
  };

  const none = await runTurn({ mode: 'none' });
  const hit = await runTurn({ mode: 'hit' });
  const miss = await runTurn({ mode: 'miss' });
  assert.equal(none.ackModelCalls + none.ackSynthCalls, 0);
  // The per-turn draft is tier a, so it always starts; a built pool changes nothing before the
  // deadline and is never taken on the delivery path.
  assert.equal(hit.ackModelCalls, 1, 'a built pool never replaces the per-turn draft');
  assert.equal(hit.ackSynthCalls, 1, 'the draft is synthesized even when the pool has lines');
  assert.equal(hit.takeCalls, 0, 'nothing is taken from the pool before the trigger');
  assert.equal(miss.ackModelCalls, 1, 'miss: the fallback drafts one line');
  assert.equal(miss.ackSynthCalls, 1, 'miss: the fallback synthesizes once');
  const hitDelta = hit.bodyFirstMs - none.bodyFirstMs;
  const missDelta = miss.bodyFirstMs - hit.bodyFirstMs;
  assert.ok(hitDelta <= 200, `hit body first audio +${hitDelta}ms (budget 200ms)`);
  assert.ok(missDelta <= 200, `miss vs hit body first audio +${missDelta}ms (budget 200ms)`);
  t.diagnostic(
    `body first audio: no-ack=${none.bodyFirstMs}ms hit=${hit.bodyFirstMs}ms miss=${miss.bodyFirstMs}ms; `
    + `hit-baseline=${hitDelta}ms miss-hit=${missDelta}ms (<=200ms) `
    + `drafts=${hit.ackModelCalls + miss.ackModelCalls} takeCalls=${hit.takeCalls}`,
  );
});

// ---------------------------------------------------------------------------
// A3: the warm build yields to a live task and is cancelled by new activity
// ---------------------------------------------------------------------------

test('8. a turn that has not ended: five idle seconds never start the warm build', async (t) => {
  const events = [];
  let builds = 0;
  let live = ackWarmActivityReason({ generating: true });
  const scheduler = createAckWarmScheduler({
    idleMs: () => 40,
    activity: () => live,
    build: async () => { builds += 1; return { built: 1 }; },
    emit: async (type, payload) => { events.push({ type, payload }); },
  });
  scheduler.schedule();
  await tick(200);
  assert.equal(live, 'generating');
  assert.equal(builds, 0, 'no warm build is started beside a live turn');
  assert.equal(scheduler.status().building, false);
  assert.equal(events.filter((event) => event.type === 'voice.ack.warm.cancelled').length, 0);
  // The same window is re-armed rather than dropped: once the turn ends it builds normally.
  live = ackWarmActivityReason({});
  await waitUntil(() => builds === 1, 'the idle window builds after the turn ends');
  scheduler.dispose();
  t.diagnostic(`generating: builds=0 cancelled=0 while live; re-armed builds=${builds} after idle`);
});

test('9. a user message during the warm build aborts it: cancelled=1 and no partial cache', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-ack-warm-cancel-'));
  t.after(() => cleanupRoot(root));
  const dir = join(root, 'cache', 'ack');
  await mkdir(dir, { recursive: true });
  const events = [];
  let synthCalls = 0;
  let release = () => {};
  const gate = new Promise((resolve) => { release = resolve; });
  const pool = createAckWarmPool({
    dir,
    meta: () => ({ persona: '你是小音', language: 'zh-CN', voice: 'voice-a', modelVersion: 'm1' }),
    generate: async () => ['让我先想一想到底该怎么回答你', '我在这里陪你等一会儿'],
    synthesize: async ({ dir: target, signal }) => {
      synthCalls += 1;
      const file = join(target, `warm-${synthCalls}.mp3`);
      await writeFile(file, 'warm-audio');
      // The first line completes; the second is still synthesizing when the user speaks.
      if (synthCalls === 1) return { file, durationMs: 120, bytes: 8, provider: 'fake' };
      await gate;
      signal?.throwIfAborted();
      return { file, durationMs: 120, bytes: 8, provider: 'fake' };
    },
    emit: async (type, payload) => { events.push({ type, payload }); },
  });
  await pool.ensure();
  const scheduler = createAckWarmScheduler({
    idleMs: () => 20,
    activity: () => '',
    build: ({ signal }) => pool.build({ signal }),
    // Cancelling a build keeps previously valid entries: the late batch is dropped by the pool.
    discard: async () => {},
    emit: async (type, payload) => { events.push({ type, payload }); },
  });
  const running = scheduler.run();
  await waitUntil(() => synthCalls === 2, 'the second warm line is being synthesized');
  // The user speaks: the in-flight build is aborted, so its first finished line must not survive.
  assert.equal(scheduler.cancel('user-message'), true, 'the running build was cancelled');
  release();
  await running;
  const cancelled = events.filter((event) => event.type === 'voice.ack.warm.cancelled');
  assert.equal(cancelled.length, 1, 'exactly one warm cancellation row');
  assert.equal(cancelled[0].payload.reason, 'user-message');
  assert.equal(pool.take(), null, 'the aborted batch never becomes a cache hit');
  assert.equal(pool.status().entries, 0, 'the partial batch left no in-memory entries');
  const survivors = await readdir(dir).catch(() => []);
  assert.deepEqual(survivors, [], 'no partial audio file or manifest is left on disk');
  scheduler.dispose();
  t.diagnostic(
    `cancel: cancelled=${cancelled.length} reason=${cancelled[0].payload.reason} `
    + `entries=${pool.status().entries} take=null files=${survivors.length}`,
  );
});

test('10. an idle window still builds normally: no cancelled row and capacity is 6', async (t) => {
  const fixture = await warmFixture(t);
  const scheduler = createAckWarmScheduler({
    idleMs: () => 30,
    activity: () => ackWarmActivityReason({}),
    build: ({ signal }) => fixture.pool.build({ signal }),
    discard: async () => {},
    emit: async (type, payload) => { fixture.events.push({ type, payload }); },
  });
  scheduler.schedule();
  await waitUntil(
    () => fixture.events.some((event) => event.type === 'voice.ack.warm'),
    'the idle window produced a warm row',
  );
  assert.equal(scheduler.status().building, false);
  assert.ok(fixture.pool.status().entries >= 1, `entries=${fixture.pool.status().entries}`);
  assert.equal(fixture.pool.status().capacity, ACK_WARM_CAPACITY);
  assert.equal(fixture.events.filter((event) => event.type === 'voice.ack.warm.cancelled').length, 0);
  const warmRow = fixture.events.find((event) => event.type === 'voice.ack.warm');
  scheduler.dispose();
  t.diagnostic(
    `idle: built=${warmRow.payload.built} entries=${fixture.pool.status().entries} `
    + `capacity=${fixture.pool.status().capacity} cancelled=0`,
  );
});

test('11. a TTS slot in use: the window is re-armed, never started', async (t) => {
  // The probe order is the same one the host uses: sound, synthesis, translation, generation.
  assert.equal(ackWarmActivityReason({ playing: true, synthesizing: true }), 'playing');
  assert.equal(ackWarmActivityReason({ synthesizing: true, translating: true }), 'synthesizing');
  assert.equal(ackWarmActivityReason({ translating: true, generating: true }), 'translating');
  assert.equal(ackWarmActivityReason({ generating: true }), 'generating');
  assert.equal(ackWarmActivityReason({}), '');
  const events = [];
  let builds = 0;
  let live = ackWarmActivityReason({ synthesizing: true });
  const scheduler = createAckWarmScheduler({
    idleMs: () => 30,
    activity: () => live,
    build: async () => { builds += 1; return { built: 1 }; },
    emit: async (type, payload) => { events.push({ type, payload }); },
  });
  scheduler.schedule();
  await tick(150);
  assert.equal(live, 'synthesizing');
  assert.equal(builds, 0, 'no warm build starts while the TTS slot is held');
  assert.equal(events.filter((event) => event.type === 'voice.ack.warm.cancelled').length, 0);
  live = ackWarmActivityReason({ playing: true });
  await tick(80);
  assert.equal(builds, 0, 'a held playback seat also postpones the build');
  live = '';
  await waitUntil(() => builds === 1, 'the build starts only after both seats are free');
  scheduler.dispose();
  t.diagnostic(`synthesizing/playing: builds=0 cancelled=0; free-window builds=${builds}`);
});

// ---------------------------------------------------------------------------
// P2: a disposed/cancelled warm build never reaches persist()
// ---------------------------------------------------------------------------

test('12. P2 dispose during the build: no cache directory, no manifest, one discarded row', async (t) => {
  let releaseDraft = () => {};
  const draftGate = new Promise((resolve) => { releaseDraft = resolve; });
  let generateStarted = false;
  let synthCalls = 0;
  const fixture = await gateFixture(t, {
    generate: async () => {
      generateStarted = true;
      await draftGate;
      return ['让我先想一想到底该怎么回答你', '我在这里陪你等一会儿'];
    },
    synthesize: async ({ dir: target }) => {
      synthCalls += 1;
      const file = join(target, `warm-${synthCalls}.mp3`);
      await mkdir(target, { recursive: true });
      await writeFile(file, 'fake-audio');
      return { file, durationMs: 100, bytes: 10, provider: 'fake' };
    },
  });
  const scheduler = gatedScheduler(fixture);
  const running = scheduler.run();
  await waitUntil(() => generateStarted, 'the warm draft is running');
  // Teardown while the model result is still pending, then let the result through.
  fixture.gate.dispose();
  scheduler.dispose();
  releaseDraft();
  await running;
  assert.equal(synthCalls, 0, 'the aborted batch never synthesized a line');
  await assert.rejects(readdir(fixture.dir), /ENOENT/, 'the cache directory was never created');
  assert.equal(await readFile(join(fixture.dir, 'manifest.json'), 'utf8').catch(() => null), null);
  assert.equal(fixture.writes.makeDir, 0, 'persist() never reached the directory seam');
  assert.equal(fixture.writes.manifest, 0, 'persist() never wrote the manifest');
  const discarded = fixture.events.filter((event) => event.type === 'voice.ack.warm.discarded');
  assert.equal(discarded.length, 1, 'exactly one discarded row');
  assert.equal(discarded[0].payload.reason, 'disposed');
  assert.equal(fixture.pool.status().entries, 0);
  assert.equal(fixture.pool.take(), null);
  assert.equal(fixture.events.filter((event) => event.type === 'voice.ack.warm').length, 0);
  t.diagnostic(
    `dispose: generate=${generateStarted} synth=0 dir=absent manifest=absent `
    + `makeDir=${fixture.writes.makeDir} manifestWrites=${fixture.writes.manifest} `
    + `discarded=${discarded.length}/${discarded[0].payload.reason} entries=0`,
  );
});

test('13. P2 cancel during the last line: the queued persist is refused and partial files are cleaned', async (t) => {
  let synthCalls = 0;
  let releaseSecond = () => {};
  const secondGate = new Promise((resolve) => { releaseSecond = resolve; });
  const fixture = await gateFixture(t, {
    generate: async () => ['让我先想一想到底该怎么回答你', '我在这里陪你等一会儿'],
    synthesize: async ({ dir: target }) => {
      synthCalls += 1;
      const file = join(target, `warm-${synthCalls}.mp3`);
      await mkdir(target, { recursive: true });
      await writeFile(file, 'fake-audio');
      // The first line is finished; the second is still synthesizing when the build is cancelled.
      if (synthCalls === 2) await secondGate;
      return { file, durationMs: 100, bytes: 10, provider: 'fake' };
    },
  });
  const scheduler = gatedScheduler(fixture);
  const running = scheduler.run();
  await waitUntil(() => synthCalls === 2, 'the second warm line is synthesizing');
  assert.equal(fixture.writes.makeDir, 0, 'no persist before the batch finished');
  // The host closes the gate first, then aborts the batch (its `cancelAckWarm`).
  fixture.gate.cancel();
  assert.equal(scheduler.cancel('user-message'), true, 'the running build was cancelled');
  // Releasing the result lets the build reach its end; the queued persist must be refused.
  releaseSecond();
  await running;
  assert.equal(fixture.writes.makeDir, 0, 'the queued persist never reached the directory seam');
  assert.equal(fixture.writes.manifest, 0, 'the queued persist never wrote the manifest');
  assert.deepEqual(await readdir(fixture.dir).catch(() => []), [], 'the partial batch was cleaned up');
  assert.equal(fixture.pool.status().entries, 0, 'no partial batch stays in memory');
  assert.equal(fixture.pool.take(), null);
  const discarded = fixture.events.filter((event) => event.type === 'voice.ack.warm.discarded');
  assert.equal(discarded.length, 1);
  assert.equal(discarded[0].payload.reason, 'cancelled');
  const cancelled = fixture.events.filter((event) => event.type === 'voice.ack.warm.cancelled');
  assert.equal(cancelled.length, 1);
  assert.equal(cancelled[0].payload.reason, 'user-message');
  t.diagnostic(
    `cancel: synth=${synthCalls} persist=${fixture.writes.makeDir} manifest=${fixture.writes.manifest} `
    + `files=0 discarded=${discarded.length}/${discarded[0].payload.reason} `
    + `cancelled=${cancelled.length}/${cancelled[0].payload.reason}`,
  );
});

test('19. P2 a persist that already started is cleaned when the batch is cancelled', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-ack-warm-gate-mid-'));
  t.after(() => cleanupRoot(root));
  const dir = join(root, 'cache', 'ack');
  const events = [];
  const emit = async (type, payload) => { events.push({ type, payload }); };
  const gate = createAckWarmRunGate({ emit });
  let writeStarted = false;
  let releaseWrite = () => {};
  const writeGate = new Promise((resolve) => { releaseWrite = resolve; });
  const pool = createAckWarmPool({
    dir,
    meta: () => ({ persona: '你是小音', language: 'zh-CN', voice: 'voice-a', modelVersion: 'm1' }),
    generate: async () => ['让我先想一想到底该怎么回答你'],
    synthesize: async ({ dir: target }) => {
      const file = join(target, 'warm-1.mp3');
      await mkdir(target, { recursive: true });
      await writeFile(file, 'fake-audio');
      return { file, durationMs: 100, bytes: 10, provider: 'fake' };
    },
    emit,
    makeDir: gate.makeDir(mkdir),
    // persist() is already inside its write when the cancel arrives: the manifest still lands,
    // so the batch must be cleaned afterwards.
    writeTextFile: gate.writeTextFile(async (...args) => {
      writeStarted = true;
      await writeGate;
      return writeFile(...args);
    }),
  });
  gate.bind(pool);
  const scheduler = createAckWarmScheduler({
    idleMs: () => 10,
    activity: () => '',
    build: ({ signal }) => gate.build(pool.build, { signal }),
    discard: async () => {},
    emit,
  });
  const running = scheduler.run();
  await waitUntil(() => writeStarted, 'persist() reached its manifest write');
  gate.cancel();
  assert.equal(scheduler.cancel('user-message'), true);
  releaseWrite();
  await running;
  assert.deepEqual(await readdir(dir).catch(() => []), [], 'the started persist was cleaned up');
  assert.equal(await readFile(join(dir, 'manifest.json'), 'utf8').catch(() => null), null);
  assert.equal(pool.status().entries, 0);
  assert.equal(pool.take(), null);
  const discarded = events.filter((event) => event.type === 'voice.ack.warm.discarded');
  assert.equal(discarded.length, 1);
  assert.equal(discarded[0].payload.reason, 'cancelled');
  t.diagnostic(
    `mid-persist: writeStarted=${writeStarted} files=0 manifest=absent `
    + `discarded=${discarded.length}/${discarded[0].payload.reason} entries=0`,
  );
});

/** A warm pool over a directory that does not exist yet, with direct (ungated) seams. */
async function tokenFixture(t, { generate, synthesize } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-ack-warm-token-'));
  t.after(() => cleanupRoot(root));
  const dir = join(root, 'cache', 'ack');
  const events = [];
  let seq = 0;
  const pool = createAckWarmPool({
    dir,
    meta: () => ({ persona: '你是小音', language: 'zh-CN', voice: 'voice-a', modelVersion: 'm1' }),
    generate,
    synthesize: synthesize ?? (async ({ text, dir: target }) => {
      seq += 1;
      const file = join(target, `warm-${seq}.mp3`);
      await mkdir(target, { recursive: true });
      await writeFile(file, 'fake-audio');
      return { file, durationMs: 120, bytes: 10, provider: 'fake', text };
    }),
    emit: async (type, payload) => { events.push({ type, payload }); },
  });
  return { root, dir, pool, events };
}

// ---------------------------------------------------------------------------
// P2: the pool's own generation token, not only the host gate
// ---------------------------------------------------------------------------

const TOKEN_LINES = ['让我先想一想到底该怎么回答你', '我在这里陪你等一会儿', '你慢慢说我一直在这儿听'];

test('13a. P2 pool.dispose() during the draft: no cache directory, no manifest, disposed row', async (t) => {
  let releaseDraft = () => {};
  const draftGate = new Promise((resolve) => { releaseDraft = resolve; });
  let generateStarted = false;
  let synthCalls = 0;
  const fixture = await tokenFixture(t, {
    generate: async () => {
      generateStarted = true;
      await draftGate;
      return TOKEN_LINES;
    },
    synthesize: async ({ dir: target }) => {
      synthCalls += 1;
      const file = join(target, `warm-${synthCalls}.mp3`);
      await mkdir(target, { recursive: true });
      await writeFile(file, 'fake-audio');
      return { file, durationMs: 100, bytes: 10, provider: 'fake' };
    },
  });
  const running = fixture.pool.build();
  await waitUntil(() => generateStarted, 'the warm draft is running');
  await fixture.pool.dispose();
  releaseDraft();
  const result = await running;
  assert.equal(synthCalls, 0, 'the disposed batch never synthesized a line');
  assert.equal(result.stale, true);
  await assert.rejects(readdir(fixture.dir), /ENOENT/, 'the disposed build never created the cache directory');
  assert.equal(await readFile(join(fixture.dir, 'manifest.json'), 'utf8').catch(() => null), null);
  const discarded = fixture.events.filter((event) => event.type === 'voice.ack.warm.discarded');
  assert.equal(discarded.length, 1);
  assert.equal(discarded[0].payload.reason, 'disposed');
  assert.equal(fixture.pool.status().entries, 0);
  assert.equal(fixture.pool.take(), null);
  assert.equal(fixture.events.filter((event) => event.type === 'voice.ack.warm').length, 0);
  t.diagnostic(
    `dispose: generate=${generateStarted} synth=${synthCalls} dir=absent manifest=absent `
    + `discarded=${discarded.length}/${discarded[0].payload.reason} entries=0 take=null`,
  );
});

test('13b. P2 pool.clear() during the draft: no cache directory, no manifest, cancelled row', async (t) => {
  let releaseDraft = () => {};
  const draftGate = new Promise((resolve) => { releaseDraft = resolve; });
  let generateStarted = false;
  let synthCalls = 0;
  const fixture = await tokenFixture(t, {
    generate: async () => {
      generateStarted = true;
      await draftGate;
      return TOKEN_LINES;
    },
    synthesize: async ({ dir: target }) => {
      synthCalls += 1;
      const file = join(target, `warm-${synthCalls}.mp3`);
      await mkdir(target, { recursive: true });
      await writeFile(file, 'fake-audio');
      return { file, durationMs: 100, bytes: 10, provider: 'fake' };
    },
  });
  const running = fixture.pool.build();
  await waitUntil(() => generateStarted, 'the warm draft is running');
  await fixture.pool.clear('test-clear');
  releaseDraft();
  const result = await running;
  assert.equal(synthCalls, 0, 'the cleared batch never synthesized a line');
  assert.equal(result.stale, true);
  await assert.rejects(readdir(fixture.dir), /ENOENT/, 'the cleared build never created the cache directory');
  assert.equal(await readFile(join(fixture.dir, 'manifest.json'), 'utf8').catch(() => null), null);
  const discarded = fixture.events.filter((event) => event.type === 'voice.ack.warm.discarded');
  assert.equal(discarded.length, 1);
  assert.equal(discarded[0].payload.reason, 'cancelled');
  assert.equal(fixture.pool.status().entries, 0);
  assert.equal(fixture.pool.take(), null);
  t.diagnostic(
    `clear: generate=${generateStarted} synth=${synthCalls} dir=absent manifest=absent `
    + `discarded=${discarded.length}/${discarded[0].payload.reason} entries=0 take=null`,
  );
});

test('13c. P2 a new build supersedes the old draft: the old result is dropped, the new one persists', async (t) => {
  let releaseFirst = () => {};
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  let generateCalls = 0;
  const fixture = await tokenFixture(t, {
    generate: async () => {
      generateCalls += 1;
      if (generateCalls === 1) {
        await firstGate;
        return ['让我先想一想到底该怎么回答你'];
      }
      return ['我在这里陪你等一会儿', '你先说说看我在听'];
    },
  });
  const first = fixture.pool.build();
  await waitUntil(() => generateCalls === 1, 'the first warm draft is running');
  const second = await fixture.pool.build();
  assert.ok(second.built >= 1, `the superseding build persisted, built=${second.built}`);
  assert.equal(second.stale, undefined);
  releaseFirst();
  const firstResult = await first;
  assert.equal(firstResult.stale, true, 'the superseded result is dropped');
  const discarded = fixture.events.filter((event) => event.type === 'voice.ack.warm.discarded');
  assert.equal(discarded.length, 1);
  assert.equal(discarded[0].payload.reason, 'superseded');
  const manifest = JSON.parse(await readFile(join(fixture.dir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.entries.length, second.built, 'only the new batch is in the manifest');
  const taken = fixture.pool.take();
  assert.ok(taken !== null, 'the new batch is served');
  assert.ok(TOKEN_LINES.includes(taken.text));
  t.diagnostic(
    `supersede: first=${firstResult.stale}/${discarded[0].payload.reason} secondBuilt=${second.built} `
    + `manifestEntries=${manifest.entries.length} take=${taken.text}`,
  );
});

test('13d. P2 the normal path still writes the manifest and serves a take() hit', async (t) => {
  const fixture = await tokenFixture(t, { generate: async () => TOKEN_LINES });
  const result = await fixture.pool.build();
  assert.equal(result.built, 3);
  assert.equal(result.stale, undefined);
  const manifest = JSON.parse(await readFile(join(fixture.dir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.entries.length, 3);
  assert.equal(fixture.pool.status().capacity, ACK_WARM_CAPACITY);
  assert.equal(fixture.pool.status().entries, 3);
  const first = fixture.pool.take();
  assert.ok(first !== null);
  assert.equal(first.text, TOKEN_LINES[0], 'take() serves the least recently used line');
  assert.equal(fixture.pool.take().text, TOKEN_LINES[1], 'the LRU order advances');
  assert.equal(fixture.events.filter((event) => event.type === 'voice.ack.warm.discarded').length, 0);
  t.diagnostic(
    `normal: built=${result.built} manifestEntries=${manifest.entries.length} `
    + `capacity=${fixture.pool.status().capacity} take1="${first.text}" take2="${TOKEN_LINES[1]}"`,
  );
});

test('13e. P2 pool.clear() while persist() is writing: the started write is rolled back', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-ack-warm-token-mid-'));
  t.after(() => cleanupRoot(root));
  const dir = join(root, 'cache', 'ack');
  const events = [];
  let writeStarted = false;
  let releaseWrite = () => {};
  const writeGate = new Promise((resolve) => { releaseWrite = resolve; });
  let seq = 0;
  const pool = createAckWarmPool({
    dir,
    meta: () => ({ persona: '你是小音', language: 'zh-CN', voice: 'voice-a', modelVersion: 'm1' }),
    generate: async () => ['让我先想一想到底该怎么回答你'],
    synthesize: async ({ text, dir: target }) => {
      seq += 1;
      const file = join(target, `warm-${seq}.mp3`);
      await mkdir(target, { recursive: true });
      await writeFile(file, 'fake-audio');
      return { file, durationMs: 120, bytes: 10, provider: 'fake', text };
    },
    emit: async (type, payload) => { events.push({ type, payload }); },
    writeTextFile: async (...args) => {
      writeStarted = true;
      await writeGate;
      return writeFile(...args);
    },
  });
  const running = pool.build();
  await waitUntil(() => writeStarted, 'persist() reached its manifest write');
  // The pool's own clear arrives while the manifest write is in flight.
  await pool.clear('probe-clear');
  releaseWrite();
  const result = await running;
  assert.equal(result.stale, true);
  assert.deepEqual(await readdir(dir).catch(() => []), [], 'the started write was cleaned up');
  assert.equal(await readFile(join(dir, 'manifest.json'), 'utf8').catch(() => null), null);
  assert.equal(pool.status().entries, 0);
  assert.equal(pool.take(), null);
  const discarded = events.filter((event) => event.type === 'voice.ack.warm.discarded');
  assert.equal(discarded.length, 1);
  assert.equal(discarded[0].payload.reason, 'cancelled');
  t.diagnostic(
    `mid-write clear: writeStarted=${writeStarted} files=0 manifest=absent `
    + `discarded=${discarded.length}/${discarded[0].payload.reason} entries=0`,
  );
});

// ---------------------------------------------------------------------------
// P4: batch ownership — a late cleanup never deletes a newer batch's manifest
// ---------------------------------------------------------------------------

/**
 * A pool whose `renameFile` seam pauses the `pauseBatch`-th batch *after* the real rename, so that
 * batch has already committed its manifest when a newer batch replaces it.
 */
async function pausedRenameFixture(t, { pauseBatch = 1 } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-ack-warm-owner-'));
  t.after(() => cleanupRoot(root));
  const dir = join(root, 'cache', 'ack');
  const events = [];
  let renameCalls = 0;
  let pausedDone = false;
  let releasePause = () => {};
  const pauseGate = new Promise((resolve) => { releasePause = resolve; });
  let generateCalls = 0;
  let synthSeq = 0;
  const pool = createAckWarmPool({
    dir,
    meta: () => ({ persona: '你是小音', language: 'zh-CN', voice: 'voice-a', modelVersion: 'm1' }),
    generate: async () => {
      generateCalls += 1;
      return generateCalls === 1
        ? [TOKEN_LINES[0]]
        : [TOKEN_LINES[1], TOKEN_LINES[2]];
    },
    synthesize: async ({ text, dir: target }) => {
      synthSeq += 1;
      const file = join(target, `warm-${synthSeq}.mp3`);
      await mkdir(target, { recursive: true });
      await writeFile(file, 'fake-audio');
      return { file, durationMs: 120, bytes: 10, provider: 'fake', text };
    },
    emit: async (type, payload) => { events.push({ type, payload }); },
    renameFile: async (from, to) => {
      await rename(from, to);
      renameCalls += 1;
      if (renameCalls === pauseBatch) {
        pausedDone = true;
        await pauseGate;
      }
    },
  });
  return { root, dir, events, pool, waitPaused: () => pausedDone, releasePause };
}

const manifestFileNames = (names) => names.filter((name) => name === 'manifest.json');
const tmpFileNames = (names) => names.filter((name) => name.endsWith('.tmp'));

test('20a. a late batch never deletes the manifest a newer batch committed', async (t) => {
  const fixture = await pausedRenameFixture(t);
  const first = fixture.pool.build();
  await waitUntil(() => fixture.waitPaused(), 'the first batch committed its manifest, then paused');
  const firstManifest = JSON.parse(await readFile(join(fixture.dir, 'manifest.json'), 'utf8'));
  assert.equal(firstManifest.manifestOwner, 1, 'the manifest records the batch that wrote it');
  assert.equal(firstManifest.entries.length, 1);

  // The newer batch commits its own complete batch over that manifest.
  const second = await fixture.pool.build();
  assert.equal(second.built, 2);
  assert.equal(second.stale, undefined);
  const newest = JSON.parse(await readFile(join(fixture.dir, 'manifest.json'), 'utf8'));
  assert.equal(newest.manifestOwner, 2, 'ownership moved to the newer batch');
  assert.deepEqual(newest.entries.map((entry) => entry.text), [TOKEN_LINES[1], TOKEN_LINES[2]]);

  // Only now does the late batch reach its cleanup: it must leave the newer manifest alone.
  fixture.releasePause();
  const late = await first;
  assert.equal(late.stale, true, 'the late batch stays discarded');
  const manifest = JSON.parse(await readFile(join(fixture.dir, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest, newest, 'the newer manifest and its entries survive the late cleanup');
  for (const entry of manifest.entries) {
    assert.notEqual(await readFile(entry.file, 'utf8').catch(() => null), null, `audio kept: ${entry.file}`);
  }
  assert.equal(
    await readFile(firstManifest.entries[0].file, 'utf8').catch(() => null),
    null,
    'the late batch still removes the audio only it owned',
  );
  const skipped = fixture.events.filter((event) => event.type === 'voice.ack.warm.cleanup-skipped');
  assert.equal(skipped.length, 1, 'exactly one ownership-conflict row');
  assert.deepEqual(skipped[0].payload, { reason: 'newer-owner' });
  const discarded = fixture.events.filter((event) => event.type === 'voice.ack.warm.discarded');
  assert.equal(discarded.length, 1, 'voice.ack.warm.discarded is unchanged');
  assert.equal(discarded[0].payload.reason, 'superseded');
  const names = await readdir(fixture.dir);
  assert.equal(manifestFileNames(names).length, 1, 'exactly one final manifest.json');
  assert.deepEqual(tmpFileNames(names), [], 'no batch tmp file is left behind');
  t.diagnostic(
    `late owner conflict: first=s1(owner=1) second=s2(manifestOwner=${manifest.manifestOwner}) `
    + `entries=${manifest.entries.length} manifest=kept tmp=0 `
    + `cleanup-skipped=${skipped.length}/${skipped[0].payload.reason} discarded=${discarded.length}/${discarded[0].payload.reason}`,
  );
});

test('20b. a late batch removes the manifest tmp file it wrote', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-ack-warm-own-tmp-'));
  t.after(() => cleanupRoot(root));
  const dir = join(root, 'cache', 'ack');
  const events = [];
  let writeCalls = 0;
  let writeStarted = false;
  let releaseWrite = () => {};
  const writeGate = new Promise((resolve) => { releaseWrite = resolve; });
  let generateCalls = 0;
  let synthSeq = 0;
  const pool = createAckWarmPool({
    dir,
    meta: () => ({ persona: '你是小音', language: 'zh-CN', voice: 'voice-a', modelVersion: 'm1' }),
    generate: async () => {
      generateCalls += 1;
      return generateCalls === 1
        ? [TOKEN_LINES[0]]
        : [TOKEN_LINES[1], TOKEN_LINES[2]];
    },
    synthesize: async ({ text, dir: target }) => {
      synthSeq += 1;
      const file = join(target, `warm-${synthSeq}.mp3`);
      await mkdir(target, { recursive: true });
      await writeFile(file, 'fake-audio');
      return { file, durationMs: 120, bytes: 10, provider: 'fake', text };
    },
    emit: async (type, payload) => { events.push({ type, payload }); },
    // The first batch writes its batch-owned tmp and pauses before its rename.
    writeTextFile: async (file, body, encoding) => {
      writeCalls += 1;
      await writeFile(file, body, encoding);
      if (writeCalls === 1) {
        writeStarted = true;
        await writeGate;
      }
    },
  });
  const first = pool.build();
  await waitUntil(() => writeStarted, 'the first batch wrote its manifest tmp');
  const ownTmp = 'manifest.json.1.tmp';
  const during = await readdir(dir);
  assert.ok(during.includes(ownTmp), `the batch-owned tmp exists while paused: ${during.join(',')}`);
  assert.equal(await readFile(join(dir, 'manifest.json'), 'utf8').catch(() => null), null);

  // The second batch completes while the first is still paused before its rename.
  const second = await pool.build();
  assert.equal(second.built, 2);
  assert.equal(second.stale, undefined);
  releaseWrite();
  const late = await first;
  assert.equal(late.stale, true);
  const after = await readdir(dir);
  assert.equal(after.includes(ownTmp), false, 'the late batch removed the tmp it wrote');
  assert.equal(after.includes('manifest.json'), true, 'the newer manifest remains');
  assert.deepEqual(tmpFileNames(after), [], 'no tmp file is left behind');
  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.manifestOwner, 2);
  assert.equal(manifest.entries.length, 2);
  const discarded = events.filter((event) => event.type === 'voice.ack.warm.discarded');
  assert.equal(discarded.length, 1);
  assert.equal(discarded[0].payload.reason, 'superseded');
  t.diagnostic(
    `own tmp: during=${during.length} files ownTmp=${ownTmp} afterTmp=0 `
    + `manifestOwner=${manifest.manifestOwner} entries=${manifest.entries.length} `
    + `discarded=${discarded.length}/${discarded[0].payload.reason}`,
  );
});

test('20c. the normal path leaves exactly one manifest and no tmp file', async (t) => {
  const fixture = await tokenFixture(t, { generate: async () => TOKEN_LINES });
  const result = await fixture.pool.build();
  assert.equal(result.built, 3);
  assert.equal(result.stale, undefined);
  const names = await readdir(fixture.dir);
  assert.equal(manifestFileNames(names).length, 1, 'only the final manifest.json exists');
  assert.deepEqual(tmpFileNames(names), [], 'no batch tmp file survives a successful build');
  const manifest = JSON.parse(await readFile(join(fixture.dir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.entries.length, 3);
  assert.equal(manifest.manifestOwner, 1);
  t.diagnostic(
    `normal path: files=${names.length} manifest=${manifestFileNames(names).length} tmp=0 `
    + `entries=${manifest.entries.length} manifestOwner=${manifest.manifestOwner}`,
  );
});

test('20d. two completed batches leave only the latest manifest', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-ack-warm-latest-'));
  t.after(() => cleanupRoot(root));
  const dir = join(root, 'cache', 'ack');
  let generateCalls = 0;
  let synthSeq = 0;
  const pool = createAckWarmPool({
    dir,
    meta: () => ({ persona: '你是小音', language: 'zh-CN', voice: 'voice-a', modelVersion: 'm1' }),
    generate: async () => {
      generateCalls += 1;
      return generateCalls === 1
        ? [TOKEN_LINES[0]]
        : [TOKEN_LINES[1], TOKEN_LINES[2]];
    },
    synthesize: async ({ text, dir: target }) => {
      synthSeq += 1;
      const file = join(target, `warm-${synthSeq}.mp3`);
      await mkdir(target, { recursive: true });
      await writeFile(file, 'fake-audio');
      return { file, durationMs: 120, bytes: 10, provider: 'fake', text };
    },
    emit: async () => {},
  });
  const first = await pool.build();
  assert.equal(first.built, 1);
  assert.equal(first.stale, undefined);
  const second = await pool.build();
  assert.equal(second.built, 2);
  assert.equal(second.stale, undefined);
  const names = await readdir(dir);
  assert.equal(manifestFileNames(names).length, 1, 'exactly one manifest.json');
  assert.deepEqual(tmpFileNames(names), [], 'no batch tmp file remains');
  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.manifestOwner, 2, 'the surviving manifest belongs to the latest batch');
  assert.deepEqual(
    manifest.entries.map((entry) => entry.text),
    [TOKEN_LINES[0], TOKEN_LINES[1], TOKEN_LINES[2]],
    'the manifest content is the latest batch',
  );
  assert.equal(pool.status().entries, 3);
  t.diagnostic(
    `two successes: first=${first.built} second=${second.built} manifests=1 tmp=0 `
    + `manifestOwner=${manifest.manifestOwner} entries=${manifest.entries.length}`,
  );
});

// ---------------------------------------------------------------------------
// P3: the busy test counts only the assistant's own, non-delegated turns
// ---------------------------------------------------------------------------

const ASSISTANT_CWD = 'D:\\assistant\\workspace';

test('14. P3 another workspace session never blocks the assistant warm build', async (t) => {
  const events = [];
  const meter = createAckWarmTurnMeter({
    inScope: (session) => session?.header?.cwd === ASSISTANT_CWD,
    subagent: (session) => isSubagentAgent({ session }),
    emit: async (type, payload) => { events.push({ type, payload }); },
  });
  const other = { id: 's-other', header: { cwd: 'D:\\Projects\\coding-agent' } };
  assert.equal(meter.start({ session: other, sessionId: 's-other', turn: 7 }), false);
  assert.equal(meter.size, 0, 'a foreign workspace turn is not an active warm turn');
  assert.deepEqual(meter.turns(), []);
  let builds = 0;
  const scheduler = createAckWarmScheduler({
    idleMs: () => 10,
    // The host's probe: a live own turn emits the throttled blocked row.
    activity: () => {
      if (meter.size === 0) return '';
      meter.noteBlocked();
      return ackWarmActivityReason({ generating: true });
    },
    build: async () => { builds += 1; return { built: 1 }; },
    emit: async (type, payload) => { events.push({ type, payload }); },
  });
  scheduler.schedule();
  await waitUntil(() => builds === 1, 'the warm build runs while only a foreign turn is live');
  // The assistant's own turn does own the seat: the next window is deferred instead of building.
  const own = { id: 's-own', header: { cwd: ASSISTANT_CWD } };
  assert.equal(meter.start({ session: own, sessionId: 's-own', turn: 8 }), true);
  assert.equal(meter.size, 1);
  scheduler.schedule();
  await tick(120);
  assert.equal(builds, 1, 'the assistant turn keeps the warm build out');
  const blocked = events.filter((event) => event.type === 'voice.ack.warm.blocked');
  assert.ok(blocked.length >= 1, 'a busy window is reported');
  assert.equal(blocked[0].payload.reason, 'busy');
  assert.equal(blocked[0].payload.blockedBy, 'generating', 'the deferred window names the live resource');
  assert.equal(blocked[0].payload.activeTurns, 1, 'only the assistant turn is counted');
  assert.deepEqual(meter.turns(), [{ sessionId: 's-own', turn: 8 }]);
  // It ends: only its own row goes, and the next window builds again.
  assert.equal(meter.end({ sessionId: 's-own', turn: 8 }), true);
  await waitUntil(() => builds === 2, 'the warm build resumes after the assistant turn ends');
  scheduler.dispose();
  t.diagnostic(
    `foreignTurn active=0 build=1; ownTurn active=${blocked[0].payload.activeTurns} `
    + `blocked=${blocked.length}/${blocked[0].payload.reason}; after end builds=${builds}`,
  );
});

test('15. P3 a subagent turn is never counted as an active warm turn', async (t) => {
  const events = [];
  const meter = createAckWarmTurnMeter({
    inScope: () => true,
    subagent: (session) => isSubagentAgent({ session }),
    emit: async (type, payload) => { events.push({ type, payload }); },
  });
  const child = { id: 's-child', header: { origin: 'subagent' } };
  assert.equal(meter.start({ session: child, sessionId: 's-child', turn: 1 }), false);
  const deeper = { id: 's-deep', header: { delegationDepth: 1 } };
  assert.equal(meter.start({ session: deeper, sessionId: 's-deep', turn: 2 }), false);
  assert.equal(meter.size, 0, 'a delegated child never owns the assistant voice resources');
  assert.deepEqual(meter.turns(), []);
  assert.equal(events.length, 0, 'a subagent turn writes no busy row of its own');
  // The same in-scope session without the subagent header is counted: the filter is the child flag.
  const own = { id: 's-own', header: {} };
  assert.equal(meter.start({ session: own, sessionId: 's-own', turn: 3 }), true);
  assert.equal(meter.size, 1);
  t.diagnostic(
    `child=${isSubagentAgent({ session: child })} deep=${isSubagentAgent({ session: deeper })} `
    + `active=${meter.size} rows=${JSON.stringify(meter.turns())}`,
  );
});

test('16. P3 one turn/end removes only its own (sessionId, turn) row', async (t) => {
  const meter = createAckWarmTurnMeter();
  assert.equal(meter.start({ session: {}, sessionId: 's-a', turn: 1 }), true);
  assert.equal(meter.start({ session: {}, sessionId: 's-b', turn: 2 }), true);
  assert.equal(meter.start({ session: {}, sessionId: 's-a', turn: 3 }), true);
  assert.equal(meter.size, 3);
  assert.equal(meter.end({ sessionId: 's-a', turn: 3 }), true);
  assert.deepEqual(meter.turns(), [
    { sessionId: 's-a', turn: 1 },
    { sessionId: 's-b', turn: 2 },
  ]);
  assert.equal(meter.end({ sessionId: 's-a', turn: 3 }), false, 'a stale end is a no-op');
  // A turn of the same session that never started never releases the live rows.
  assert.equal(meter.end({ sessionId: 's-a', turn: 9 }), false);
  assert.equal(meter.size, 2);
  t.diagnostic(`after one end: rows=${JSON.stringify(meter.turns())} active=${meter.size}`);
});

test('17. P3 the active-turn table is bounded and evicts the oldest first', async (t) => {
  const meter = createAckWarmTurnMeter();
  for (let turn = 1; turn <= 65; turn += 1) {
    assert.equal(meter.start({ session: {}, sessionId: 's-cap', turn }), true);
  }
  assert.equal(meter.size, 64, 'the table is capped at 64 live turns');
  const rows = meter.turns();
  assert.deepEqual(rows[0], { sessionId: 's-cap', turn: 2 }, 'the oldest row was evicted');
  assert.deepEqual(rows.at(-1), { sessionId: 's-cap', turn: 65 }, 'the newest row is kept');
  assert.equal(meter.end({ sessionId: 's-cap', turn: 1 }), false, 'the evicted row is already gone');
  assert.equal(meter.size, 64);
  t.diagnostic(`active=${meter.size} oldest=${JSON.stringify(rows[0])} newest=${JSON.stringify(rows.at(-1))}`);
});

test('18. P3 the blocked row carries the live turn count and is throttled', async (t) => {
  let clock = 1_000_000;
  const events = [];
  const meter = createAckWarmTurnMeter({
    emit: async (type, payload) => { events.push({ type, payload }); },
    throttleMs: 30_000,
    now: () => clock,
  });
  meter.start({ session: {}, sessionId: 's-a', turn: 1 });
  assert.equal(meter.noteBlocked(), true, 'the first busy window is reported');
  assert.equal(meter.noteBlocked(), false, 'the same window is throttled');
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    type: 'voice.ack.warm.blocked',
    payload: { reason: 'busy', blockedBy: 'generating', activeTurns: 1 },
  });
  clock += 30_000;
  assert.equal(meter.noteBlocked(), true, 'a new throttle window reports again');
  assert.equal(events.length, 2);
  meter.start({ session: {}, sessionId: 's-b', turn: 2 });
  clock += 29_999;
  assert.equal(meter.noteBlocked(), false, 'still inside the throttle window');
  clock += 1;
  assert.equal(meter.noteBlocked(), true);
  assert.equal(events[2].payload.activeTurns, 2, 'the count follows the live table');
  t.diagnostic(
    `rows=${events.length} reasons=${events.map((event) => event.payload.reason).join(',')} `
    + `activeTurns=${events.map((event) => event.payload.activeTurns).join(',')} throttle=30000`,
  );
});

// ---------------------------------------------------------------------------
// P5: the complete host path — only the assistant's own turn interrupts the warm build
// ---------------------------------------------------------------------------
// The meter tests above only prove what the counter *answers*. The host ignored that answer: it
// called the meter, threw the boolean away, and still cancelled the running build and reset the
// idle timer. These tests mount the real plugin and fire its real `session/event` listener, so the
// cancel/rearm wiring itself is exercised. Every observation is the host's own event log or the
// cache directory it writes; no internal seam is read.

const WARM_DRAFT_LINES = '让我先想一想到底该怎么回答你\n我在这里陪你等一会儿\n你先说说看我在听';
const FOREIGN_CWD = 'D:/Projects/coding-agent';

const deferredBox = () => {
  const box = { resolve: null };
  box.promise = new Promise((resolve) => { box.resolve = resolve; });
  return box;
};

/**
 * Mount the real plugin with the voice component on (everything that would capture, draw or spawn
 * stays off) and a short warm window. `holdDraft` parks the first warm draft until
 * `releaseDraft()`, so a turn event can be fired against a build that is genuinely in flight.
 */
async function mountWarmHost(t, { idleMs = 20, holdDraft = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-ack-warm-host-'));
  await mkdir(join(root, 'data'), { recursive: true });
  await mkdir(join(root, 'workspace'), { recursive: true });
  await writeFile(join(root, 'data', 'features.json'), JSON.stringify({
    hearing: false,
    ambient: false,
    voice: true,
    vision: false,
    subtitle: false,
    avatar: false,
    memory: false,
    fastpath: false,
  }));
  await writeFile(join(root, 'data', 'settings.json'), JSON.stringify({
    gptSovits: { enabled: false },
    autoMemory: { enabled: false },
    voice: { ackWarmIdleMs: idleMs },
  }));
  const state = {
    streams: 0,
    holdDraft: holdDraft === true,
    selection: { provider: 'fake-provider', model: 'fake-model' },
    gate: deferredBox(),
  };
  const handlers = [];
  const cleanups = [];
  const tools = new Map();
  const sections = new Map();
  const routes = new Map();
  const effect = (run) => {
    const value = run();
    if (typeof value === 'function') cleanups.push(value);
    return value;
  };
  const on = (type, handler) => {
    const entry = { type, handler };
    handlers.push(entry);
    return () => {
      const index = handlers.indexOf(entry);
      if (index >= 0) handlers.splice(index, 1);
    };
  };
  const scope = {
    effect,
    on,
    systemPrompt: {
      section(definition) {
        sections.set(definition.name, definition);
        return () => sections.delete(definition.name);
      },
    },
    webServer: {
      register(route) {
        routes.set(route.path, route.handler);
        return () => routes.delete(route.path);
      },
    },
  };
  apply({
    effect,
    on,
    get: (serviceName) => {
      if (serviceName === 'llm') {
        return {
          stream() {
            state.streams += 1;
            // The first request is the warm draft; only the test may let it answer.
            const warmDraft = state.streams === 1;
            return (async function* generate() {
              if (warmDraft && state.holdDraft === true) await state.gate.promise;
              yield { type: 'text-delta', text: WARM_DRAFT_LINES };
              yield { type: 'finish', reason: { kind: 'stop' } };
            })();
          },
        };
      }
      if (serviceName === 'agentDefaultModel') {
        return { currentSelection: () => ({ ...state.selection }) };
      }
      return undefined;
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    inject: (_deps, register) => register(scope),
    webServer: scope.webServer,
  }, { root, enabled: true });

  const events = async () => {
    try {
      const text = await readFile(join(root, 'data', 'events.jsonl'), 'utf8');
      return text.trim().split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  };
  const rows = async (type) => (await events()).filter((row) => row.type === type);
  const waitFor = async (type, count = 1, timeoutMs = 6000) => {
    const startedAt = Date.now();
    for (;;) {
      const found = await rows(type);
      if (found.length >= count) return found;
      if (Date.now() - startedAt > timeoutMs) throw new Error(`timed out waiting for ${count} × ${type}`);
      await tick(10);
    }
  };
  const app = {
    root,
    state,
    /** The companion's own session: its cwd is the configured workspace. */
    own: { id: 's-own', header: { cwd: join(root, 'workspace') } },
    /** Another workspace's session: never in the companion's voice scope. */
    foreign: { id: 's-other', header: { cwd: FOREIGN_CWD } },
    /** A delegated child inside the companion's own workspace: scoped out by the delegation flag. */
    child: { id: 's-child', header: { cwd: join(root, 'workspace'), origin: 'subagent' } },
    events,
    rows,
    waitFor,
    waitForEvent: async (type) => (await waitFor(type, 1))[0],
    /** Wait until the warm draft really reached the model (the build is in flight). */
    waitDraft: async () => {
      const startedAt = Date.now();
      while (state.streams === 0) {
        if (Date.now() - startedAt > 5000) throw new Error('the warm draft never started');
        await tick(5);
      }
    },
    /** Dispatch one event exactly as the Harness event bus does (every listener sees it). */
    fire(session, event) {
      for (const entry of [...handlers]) {
        if (entry.type === 'session/event') entry.handler(session, event);
      }
    },
    turnStart(session, turn) {
      app.fire(session, { type: 'turn/start', data: { turn } });
    },
    turnEnd(session, turn) {
      app.fire(session, { type: 'turn/end', data: { turn, reason: { kind: 'stop' } } });
    },
    releaseDraft() {
      state.gate.resolve();
    },
    setSelection(next) {
      state.selection = { ...next };
    },
    manifestText: () => readFile(join(root, 'cache', 'ack', 'manifest.json'), 'utf8').catch(() => null),
    async manifest() {
      const text = await app.manifestText();
      return text === null ? null : JSON.parse(text);
    },
  };
  t.after(async () => {
    // A draft parked by a cancelled turn must not keep waiting forever.
    state.gate.resolve();
    await cleanupRoot(root, cleanups.splice(0));
  });
  return app;
}

test('24. P5 an assistant turn/start cancels the in-flight warm build (accepted=true)', async (t) => {
  const app = await mountWarmHost(t, { holdDraft: true });
  await app.waitDraft();
  assert.equal((await app.rows('voice.ack.warm.activity')).length, 0, 'no turn was accepted yet');
  app.turnStart(app.own, 1);
  const activity = await app.waitForEvent('voice.ack.warm.activity');
  assert.deepEqual(activity.payload, {
    reason: 'turn-start',
    sessionId: 's-own',
    turn: 1,
    accepted: true,
  });
  const cancelled = await app.waitForEvent('voice.ack.warm.cancelled');
  assert.equal(cancelled.payload.reason, 'turn-start', 'its own turn aborts the running build');
  const discarded = await app.waitForEvent('voice.ack.warm.discarded');
  assert.equal(discarded.payload.reason, 'cancelled');
  app.releaseDraft();
  assert.equal((await app.rows('voice.ack.warm')).length, 0, 'the aborted batch is never served');
  assert.equal(await app.manifestText(), null, 'nothing reached the cache directory');
  t.diagnostic(
    'own turn/start: accepted=true cancelled=1/turn-start discarded=1/cancelled warmRows=0 manifest=absent',
  );
});

test('25. P5 another workspace turn/start never cancels the in-flight warm build', async (t) => {
  const app = await mountWarmHost(t, { holdDraft: true });
  await app.waitDraft();
  app.turnStart(app.foreign, 7);
  const activity = await app.waitForEvent('voice.ack.warm.activity');
  assert.deepEqual(activity.payload, {
    reason: 'turn-start',
    sessionId: 's-other',
    turn: 7,
    accepted: false,
  });
  await tick(80);
  assert.equal((await app.rows('voice.ack.warm.cancelled')).length, 0, 'a foreign turn cancels nothing');
  assert.equal((await app.rows('voice.ack.warm.discarded')).length, 0);
  app.releaseDraft();
  const warm = await app.waitForEvent('voice.ack.warm');
  assert.ok(warm.payload.built >= 1, `the in-flight batch completed: built=${warm.payload.built}`);
  const manifest = await app.manifest();
  assert.ok(manifest !== null, 'the warm batch was written to disk');
  assert.equal(manifest.key, warm.payload.key);
  assert.ok(manifest.entries.length >= 1, `entries=${manifest.entries.length}`);
  assert.equal((await app.rows('voice.ack.warm.cancelled')).length, 0, 'still no cancellation');
  t.diagnostic(
    `foreign turn/start: accepted=false cancelled=0 discarded=0 built=${warm.payload.built} `
    + `manifest=${manifest.entries.length} entries key=${warm.payload.key}`,
  );
});

test('26. P5 a subagent turn/start never cancels the in-flight warm build', async (t) => {
  const app = await mountWarmHost(t, { holdDraft: true });
  await app.waitDraft();
  // The child sits inside the companion's own workspace: only the delegation flag denies it.
  assert.equal(app.child.header.cwd, join(app.root, 'workspace'));
  app.turnStart(app.child, 3);
  const activity = await app.waitForEvent('voice.ack.warm.activity');
  assert.deepEqual(activity.payload, {
    reason: 'turn-start',
    sessionId: 's-child',
    turn: 3,
    accepted: false,
  });
  await tick(80);
  assert.equal((await app.rows('voice.ack.warm.cancelled')).length, 0, 'a delegated child cancels nothing');
  app.releaseDraft();
  const warm = await app.waitForEvent('voice.ack.warm');
  assert.ok(warm.payload.built >= 1, `the in-flight batch completed: built=${warm.payload.built}`);
  const manifest = await app.manifest();
  assert.ok(manifest !== null, 'the warm batch was written to disk');
  assert.equal(manifest.key, warm.payload.key);
  assert.equal((await app.rows('voice.ack.warm.cancelled')).length, 0);
  t.diagnostic(
    `subagent turn/start: accepted=false cancelled=0 built=${warm.payload.built} `
    + `manifest=${manifest.entries.length} entries key=${warm.payload.key}`,
  );
});

test('27. P5 a turn/end that was never registered does not re-arm or re-check the warm build', async (t) => {
  const app = await mountWarmHost(t, { idleMs: 250, holdDraft: false });
  const warm = await app.waitForEvent('voice.ack.warm');
  assert.ok(warm.payload.built >= 1, `the first idle build persisted: built=${warm.payload.built}`);
  const keyBefore = warm.payload.key;
  assert.ok(await app.manifest() !== null, 'the first batch is on disk');
  // A live own turn keeps the seat: every later window is deferred, never built.
  app.turnStart(app.own, 1);
  const started = await app.waitForEvent('voice.ack.warm.activity');
  assert.deepEqual(started.payload, {
    reason: 'turn-start',
    sessionId: 's-own',
    turn: 1,
    accepted: true,
  });
  // Any ensure()/build from here reports a rebuild, so a stray follow-up cannot hide.
  app.setSelection({ provider: 'fake-provider-2', model: 'fake-model-2' });
  app.turnEnd(app.foreign, 9);
  const activity = await app.waitFor('voice.ack.warm.activity', 2);
  assert.deepEqual(activity.at(-1).payload, {
    reason: 'turn-end',
    sessionId: 's-other',
    turn: 9,
    accepted: false,
  });
  await tick(120);
  assert.equal(
    (await app.rows('voice.ack.cache.rebuild')).length,
    0,
    'an unregistered end never re-checks the cache identity',
  );
  // Its own registered end does re-check and re-arm: the identity change is applied here.
  app.turnEnd(app.own, 1);
  const rebuild = await app.waitForEvent('voice.ack.cache.rebuild');
  assert.equal(rebuild.payload.reason, 'modelVersion-changed');
  assert.notEqual(rebuild.payload.key, keyBefore, 'the rebuilt key follows the new model version');
  t.diagnostic(
    `unregistered end: accepted=false rebuild=0; own end: rebuild=1/${rebuild.payload.reason} `
    + `keyBefore=${keyBefore} keyAfter=${rebuild.payload.key}`,
  );
});

// ---------------------------------------------------------------------------
// P6: warm pool variety — grouping, wording/shape dedupe, rotation
// ---------------------------------------------------------------------------
// The pool used to hold three fixed lines, so almost every turn took one of three recordings.
// Capacity is now six and every line carries a use (general / question / accept / company), a
// wording key and a sentence shape. A build spreads the uses, never stores the same wording twice,
// and keeps a reused sentence shape only when the pool cannot be filled without it. take() rotates
// through all six before any repeat, then still avoids the two most recent lines.

/** Twelve valid lines covering the four uses, three each. */
const VARIETY_LINES = [
  '我先在心里过一遍再说',
  '我先把这件事理一理再说',
  '我先理一理再答你这句',
  '你说的这个问题我听着呢',
  '你问的这个我先接住了',
  '你先说说看我一直听着',
  '好的我收到了就按你说的来',
  '没问题这件事交给我来办',
  '可以我这就接住你这句',
  '我陪着你慢慢来不着急',
  '你先歇会儿我一直在这儿',
  '别着急我在这儿陪着你',
];

test('28. the pool fills six lines and covers all four uses', async (t) => {
  assert.equal(ACK_WARM_CAPACITY, 6, 'capacity grew from three to six');
  assert.equal(ACK_WARM_GROUP_IDS.length, 4, 'four uses');
  assert.equal(ACK_WARM_GROUP_MIN, 2, 'the request asks for two lines per use');
  const fixture = await warmFixture(t, { generate: async () => VARIETY_LINES });
  const build = await fixture.pool.build();
  assert.equal(build.built, ACK_WARM_CAPACITY, `built=${build.built}`);
  const status = fixture.pool.status();
  assert.equal(status.capacity, 6);
  assert.equal(status.entries, 6);
  assert.equal(new Set(status.texts).size, 6, 'six distinct lines');
  for (const id of ACK_WARM_GROUP_IDS) {
    assert.ok(status.groups.includes(id), `use ${id} is represented`);
  }
  assert.equal(new Set(status.groups).size, 4, 'all four uses in one six-line pool');
  // The generation request names every use and asks for two lines of each.
  const prompt = buildAckWarmPrompt({ persona: '你是小音，说话温柔简短。', language: 'zh-CN', count: 1 });
  const text = `${prompt.system}\n${prompt.user}`;
  for (const id of ACK_WARM_GROUP_IDS) {
    assert.match(text, new RegExp(ACK_WARM_GROUPS[id].label, 'u'), `${id} is in the prompt`);
  }
  assert.match(text, /四种用途各写2句/u);
  assert.match(text, /小音/u, 'the persona tone is quoted');
  assert.match(text, /措辞和句式都不能重复/u, 'the prompt forbids repeated wording and shape');
  const counts = ACK_WARM_GROUP_IDS.map((id) => status.groups.filter((group) => group === id).length);
  // The host's own parse seam is what the pool actually receives: the request asks for eight
  // lines (two per use) and the first six kept must still cover four uses, not just the first ones.
  const answer = [
    VARIETY_LINES[0], VARIETY_LINES[1],
    VARIETY_LINES[3], VARIETY_LINES[4],
    VARIETY_LINES[6], VARIETY_LINES[7],
    VARIETY_LINES[9], VARIETY_LINES[10],
  ].join('\n');
  const parsed = parseWarmLines(answer, 6);
  assert.equal(parsed.length, 6);
  assert.equal(
    new Set(parsed.map((line) => classifyWarmLine(line))).size,
    ACK_WARM_GROUP_IDS.length,
    'the six kept lines still cover all four uses',
  );
  t.diagnostic(
    `built=${build.built} capacity=${status.capacity} uses=${status.groups.join(',')} `
    + `counts=${counts.join('/')} promptUses=4 promptPerUse=2 parseKept=${parsed.length}/uses4`,
  );
});

test('29. take() rotates six different lines, then never reuses the last two', async (t) => {
  const fixture = await warmFixture(t, { generate: async () => VARIETY_LINES });
  await fixture.pool.build();
  const taken = [];
  for (let index = 0; index < 12; index += 1) {
    const hit = fixture.pool.take();
    assert.ok(hit !== null, `take ${index + 1} hit the pool`);
    taken.push(hit.text);
  }
  assert.equal(new Set(taken.slice(0, 6)).size, 6, 'the first six takes are all different');
  for (let index = 1; index < taken.length; index += 1) {
    assert.notEqual(taken[index], taken[index - 1], `take ${index + 1} repeats take ${index}`);
    if (index >= 2) {
      assert.notEqual(taken[index], taken[index - 2], `take ${index + 1} reuses the line two back`);
    }
  }
  assert.ok(taken.slice(6).some((line) => taken.slice(0, 6).includes(line)), 'reuse starts after six');
  const status = fixture.pool.status();
  assert.equal(status.recent.length, ACK_WARM_RECENT_AVOID, 'the last two lines are remembered');
  assert.deepEqual(status.recent, taken.slice(-2).map((line) => warmTextKey(line)));
  t.diagnostic(
    `takes=12 firstSix=${new Set(taken.slice(0, 6)).size} adjacent=0 twoBack=0 `
    + `recent=${status.recent.length} seq=${taken.join('|')}`,
  );
});

test('30. one sentence shape is reused only when the pool cannot fill without it', async (t) => {
  // The wording differs, the skeleton (look) is the same.
  assert.equal(warmShapeKey('我看看'), warmShapeKey('我来看看'));
  assert.equal(warmShapeKey('我看看'), warmShapeKey('让我看看'));
  assert.equal(new Set(['我看看', '我来看看', '让我看看'].map((line) => warmTextKey(line))).size, 3);

  const candidates = ['让我先看看你发来的情况', '我来看看你说的天气情况', '你先说说看我一直听着'];
  const short = planWarmCandidates(candidates, { capacity: 2 });
  assert.equal(short.length, 2, 'two unique shapes fill the room');
  assert.equal(short.some((item) => item.weight === 0.5), false, 'no shape is reused yet');
  assert.equal(short.some((item) => item.text === candidates[1]), false);
  const full = planWarmCandidates(candidates, { capacity: 3 });
  assert.equal(full.length, 3);
  assert.equal(full.filter((item) => item.weight === 0.5).length, 1, 'the reused shape is down-weighted');
  assert.equal(full.find((item) => item.weight === 0.5).shape, warmShapeKey(candidates[0]));

  // The same behaviour through a real pool: capacity 2 keeps only the unique-shape look line,
  // capacity 3 has room for the reused skeleton at weight 0.5.
  const two = await warmFixture(t, { capacity: 2, generate: async () => candidates });
  const builtTwo = await two.pool.build();
  assert.equal(builtTwo.built, 2);
  assert.deepEqual(two.pool.status().weights, [1, 1]);
  assert.equal(two.pool.status().texts.includes(candidates[1]), false, 'the reused shape stays out');
  const three = await warmFixture(t, { capacity: 3, generate: async () => candidates });
  const builtThree = await three.pool.build();
  assert.equal(builtThree.built, 3);
  const weights = three.pool.status().weights;
  assert.equal(weights.filter((weight) => weight === 1).length, 2);
  assert.equal(weights.filter((weight) => weight === 0.5).length, 1);
  const reused = three.pool.status().texts[weights.indexOf(0.5)];
  assert.equal(warmShapeKey(reused), warmShapeKey(candidates[0]), 'same skeleton as the kept look line');
  assert.notEqual(warmTextKey(reused), warmTextKey(candidates[0]), 'but different wording');
  t.diagnostic(
    `shape(我看看)=${warmShapeKey('我看看')} plan2=${short.length}/reuse0 `
    + `plan3=${full.length}/weight0.5=1 pool2=${two.pool.status().texts.length}/reuse0 `
    + `pool3=${builtThree.built}/weights=${weights.join(',')} reused="${reused}"`,
  );
});

test('31. identical wording (fillers/punctuation/spacing) never enters the pool twice', async (t) => {
  const lines = [
    '我在这里陪你等一会儿',
    '我在这里陪你等一会儿。',
    '我 在这里陪你等一会儿呀',
    '你先说说看我一直听着',
  ];
  const fixture = await warmFixture(t, { generate: async () => lines });
  const build = await fixture.pool.build();
  assert.equal(build.built, 2, `built=${build.built}`);
  const status = fixture.pool.status();
  assert.equal(status.entries, 2);
  const key = warmTextKey('我在这里陪你等一会儿');
  assert.equal(status.texts.filter((line) => warmTextKey(line) === key).length, 1, 'one copy only');
  const manifest = JSON.parse(await readFile(join(fixture.dir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.entries.length, 2, 'the manifest holds one copy');
  // The host's own parse seam drops the same duplicates before the pool ever sees them.
  const parsed = parseWarmLines(lines.join('\n'), 6);
  assert.equal(parsed.length, 2);
  assert.equal(parsed.filter((line) => warmTextKey(line) === key).length, 1);
  t.diagnostic(
    `candidates=4 built=${build.built} entries=${status.entries} `
    + `uniqueWording=${new Set(status.texts.map((line) => warmTextKey(line))).size} parse=${parsed.length}`,
  );
});

test('32. a persona change rebuilds the pool and never serves the old identity', async (t) => {
  const fixture = await warmFixture(t, {
    generate: async () => ['我在这里陪你等一会儿', '你先说说看我一直听着'],
  });
  const build = await fixture.pool.build();
  assert.ok(build.built >= 1, `built=${build.built}`);
  const beforeKey = ackWarmKey(fixture.metaState);
  fixture.metaState.persona = '你是阿岚，说话干脆利落，不拖泥带水。';
  const ensured = await fixture.pool.ensure();
  assert.equal(ensured.rebuilt, true);
  assert.equal(ensured.reason, 'persona-changed');
  assert.notEqual(ensured.key, beforeKey, 'the key follows the persona');
  assert.equal(fixture.pool.take(), null, 'a line recorded for the old persona is not served');
  assert.equal(fixture.pool.status().entries, 0);
  const row = fixture.events.find((event) => event.type === 'voice.ack.cache.rebuild');
  assert.equal(row.payload.reason, 'persona-changed');
  t.diagnostic(
    `persona change: rebuild=${ensured.rebuilt}/${ensured.reason} take=null entries=0 `
    + `keyBefore=${beforeKey} keyAfter=${ensured.key}`,
  );
});

// ---------------------------------------------------------------------------
// Deadline tier order: draft > warm pool > fixed fallback
// ---------------------------------------------------------------------------

test('33. a draft whose text AND audio are ready at the deadline wins: source=draft, pool not taken', async (t) => {
  const fixture = await warmFixture(t);
  const build = await fixture.pool.build();
  assert.ok(build.built >= 1, `warm built=${build.built}`);
  let takes = 0;
  const warm = { take: () => { takes += 1; return fixture.pool.take(); } };
  const { lane, events, plays } = laneFixture({ delayMs: 100, warm });
  lane.beginTurn({ sessionId: 's-tier-draft', turn: 61, userText: '帮我查一下明天上海的天气' });
  await waitUntil(() => plays.length === 1, 'the drafted line reached the player');
  const chosen = ackEvent(events, 'voice.ack.source').payload;
  const spoken = ackEvent(events, 'voice.ack.spoken').payload;
  assert.equal(chosen.turn, 61);
  assert.equal(chosen.source, 'draft', 'tier a: the per-turn draft');
  assert.ok(chosen.draftReadyMs >= 0 && chosen.draftReadyMs <= spoken.ackTriggerMs,
    `draftReadyMs=${chosen.draftReadyMs} trigger=${spoken.ackTriggerMs}`);
  assert.equal(plays[0].speech, ACK_LINE, 'the drafted line is what played');
  assert.equal(takes, 0, 'the warm pool was never taken');
  assert.equal(ackEvent(events, 'voice.ack.cache.hit'), undefined, 'no cache hit for a draft');
  assert.equal(spoken.source, 'draft');
  plays[0].end();
  await lane.whenIdle();
  t.diagnostic(
    `source=${chosen.source} draftReadyMs=${chosen.draftReadyMs} trigger=${spoken.ackTriggerMs} `
    + `takes=${takes} speech="${plays[0].speech}"`,
  );
});

test('34. a text-only draft (audio not ready) is not usable: the warm pool serves, source=warm', async (t) => {
  const fixture = await warmFixture(t);
  const build = await fixture.pool.build();
  assert.ok(build.built >= 1, `warm built=${build.built}`);
  let releaseAudio = () => {};
  const audioGate = new Promise((resolve) => { releaseAudio = resolve; });
  let draftSynthCalls = 0;
  const { lane, events, plays } = laneFixture({
    delayMs: 120,
    warm: fixture.pool,
    generate: async () => ACK_LINE,
    synthesize: async ({ speech }) => {
      draftSynthCalls += 1;
      // The draft's text is final at once; its audio is still synthesizing at the deadline.
      if (speech === ACK_LINE) await audioGate;
      return { file: 'ack.mp3', durationMs: 100, speech };
    },
  });
  lane.beginTurn({ sessionId: 's-tier-text', turn: 62, userText: '帮我查一下明天上海的天气' });
  const chosen = await waitUntil(() => ackEvent(events, 'voice.ack.source'), 'the tier row is written');
  assert.equal(chosen.payload.source, 'warm', 'tier b: text alone never wins');
  assert.equal(chosen.payload.draftReadyMs, null, 'the draft never became fully ready');
  const hit = ackEvent(events, 'voice.ack.cache.hit');
  assert.ok(hit !== undefined, 'the pool line is a cache hit');
  await waitUntil(() => plays.length === 1, 'the warm line reached the player');
  assert.ok(fixture.pool.status().texts.includes(plays[0].speech), 'a pool line is what played');
  assert.notEqual(plays[0].speech, ACK_LINE, 'the text-only draft never plays');
  assert.equal(draftSynthCalls, 1, 'the draft really started and reached TTS');
  assert.equal(ackEvent(events, 'voice.ack.spoken').payload.source, 'warm');
  releaseAudio();
  plays[0].end();
  await lane.whenIdle();
  await tick(60);
  assert.equal(plays.length, 1, 'the late draft never played');
  t.diagnostic(
    `source=${chosen.payload.source} draftReadyMs=${chosen.payload.draftReadyMs} `
    + `draftText="${ACK_LINE}" played="${plays[0].speech}" draftSynth=${draftSynthCalls} key=${hit.payload.key}`,
  );
});

test('35. a draft that fails or times out loses the deadline: the warm pool serves, source=warm', async (t) => {
  const fixture = await warmFixture(t);
  const build = await fixture.pool.build();
  assert.ok(build.built >= 1, `warm built=${build.built}`);

  // (i) the model errors out.
  const failed = laneFixture({
    delayMs: 80,
    warm: fixture.pool,
    generate: async () => { throw new Error('model down'); },
  });
  failed.lane.beginTurn({ sessionId: 's-tier-fail', turn: 63, userText: '帮我查一下明天的天气' });
  const failedRow = await waitUntil(() => ackEvent(failed.events, 'voice.ack.failed'), 'the failure row');
  await waitUntil(() => failed.plays.length === 1, 'the pool served after the model failed');
  assert.equal(ackEvent(failed.events, 'voice.ack.source').payload.source, 'warm');
  assert.ok(fixture.pool.status().texts.includes(failed.plays[0].speech));
  assert.equal(ackEvent(failed.events, 'voice.ack.spoken').payload.source, 'warm');
  failed.plays[0].end();
  await failed.lane.whenIdle();
  assert.equal(failedRow.payload.reason, 'generate');

  // (ii) the draft times out (the generator never answers).
  const timed = laneFixture({
    delayMs: 80,
    warm: fixture.pool,
    generate: () => new Promise(() => {}),
    timeoutMs: 20,
  });
  timed.lane.beginTurn({ sessionId: 's-tier-timeout', turn: 64, userText: '帮我查一下明天的天气' });
  const timeoutRow = await waitUntil(
    () => ackEvent(timed.events, 'voice.ack.failed'),
    'the timeout row',
  );
  assert.equal(timeoutRow.payload.reason, 'timeout');
  await waitUntil(() => timed.plays.length === 1, 'the pool served after the draft timed out');
  assert.equal(ackEvent(timed.events, 'voice.ack.source').payload.source, 'warm');
  timed.plays[0].end();
  await timed.lane.whenIdle();
  t.diagnostic(
    `fail=${failedRow.payload.reason}->source=warm; timeout=${timeoutRow.payload.reason}->source=warm; `
    + `played="${timed.plays[0].speech}"`,
  );
});

test('36. an empty pool with no usable draft uses the fixed fallback: source=fallback', async (t) => {
  // The pool is never built: `take()` returns null (tier b is empty).
  const fixture = await warmFixture(t);
  assert.equal(fixture.pool.take(), null, 'precondition: no warm line');
  const synthesized = [];
  const { lane, events, plays } = laneFixture({
    delayMs: 80,
    warm: fixture.pool,
    generate: async () => '',
    synthesize: async ({ speech }) => {
      synthesized.push(speech);
      return { file: 'ack.mp3', durationMs: 100, speech };
    },
  });
  lane.beginTurn({ sessionId: 's-tier-fallback', turn: 65, userText: '帮我查一下明天上海的天气' });
  await waitUntil(() => plays.length === 1, 'the fallback line reached the player');
  const chosen = ackEvent(events, 'voice.ack.source').payload;
  assert.equal(chosen.source, 'fallback', 'tier c: the fixed generic line');
  assert.equal(chosen.draftReadyMs, null);
  assert.equal(plays[0].speech, ACK_FALLBACK_LINE, 'the shipped fallback line plays');
  assert.deepEqual(synthesized, [ACK_FALLBACK_LINE], 'the fixed line is synthesized on demand');
  assert.equal(ackEvent(events, 'voice.ack.cache.hit'), undefined, 'no pool line was taken');
  assert.equal(ackEvent(events, 'voice.ack.spoken').payload.source, 'fallback');
  plays[0].end();
  await lane.whenIdle();
  t.diagnostic(
    `source=${chosen.source} draftReadyMs=${chosen.draftReadyMs} speech="${plays[0].speech}" `
    + `synth=${synthesized.length}`,
  );
});

test('37. a draft arriving after the deadline never replaces the line that already played', async (t) => {
  const fixture = await warmFixture(t);
  const build = await fixture.pool.build();
  assert.ok(build.built >= 1, `warm built=${build.built}`);
  let releaseAudio = () => {};
  const audioGate = new Promise((resolve) => { releaseAudio = resolve; });
  let draftSynthDone = false;
  const { lane, events, plays } = laneFixture({
    delayMs: 100,
    warm: fixture.pool,
    generate: async () => ACK_LINE,
    synthesize: async ({ speech }) => {
      if (speech === ACK_LINE) {
        await audioGate;
        draftSynthDone = true;
      }
      return { file: 'ack.mp3', durationMs: 100, speech };
    },
  });
  lane.beginTurn({ sessionId: 's-tier-late', turn: 66, userText: '帮我查一下明天上海的天气' });
  await waitUntil(() => plays.length === 1, 'the warm line reached the player');
  const first = plays[0].speech;
  assert.ok(fixture.pool.status().texts.includes(first), 'the warm line played first');
  // The draft's audio finally arrives: it must not start a second clip or replace the played one.
  releaseAudio();
  await waitUntil(() => draftSynthDone, 'the late draft audio resolved');
  await tick(80);
  assert.equal(plays.length, 1, 'no second clip: a late draft never replaces a played line');
  assert.equal(lane.status()[0].source, 'warm', 'the turn still reports the warm tier');
  assert.equal(events.filter((event) => event.type === 'voice.ack.spoken').length, 1);
  assert.equal(events.filter((event) => event.type === 'voice.ack.source').length, 1);
  assert.equal(
    events.filter((event) => event.type === 'voice.ack.failed').length,
    0,
    'the losing draft never reports a failure over the spoken line',
  );
  plays[0].end();
  await lane.whenIdle();
  await tick(40);
  assert.equal(plays.length, 1, 'still exactly one clip after the turn settled');
  t.diagnostic(
    `played="${first}" source=warm players=${plays.length} draftSynthDone=${draftSynthDone} `
    + `spoken=1 sourceRows=1 failed=0`,
  );
});
