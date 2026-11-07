/**
 * 接纳即返回 (accept-then-return) speech: `assistant_say` answers with the accepted speech and the
 * clip keeps being synthesized and played in the background.
 *
 * The host is the real mounted plugin (`apply` + the real tool); only the TTS transport, the
 * player, the sight helpers and the subtitle overlay are scripted. Timings are controlled by the
 * fixture (`synthMs`, `playMs`), so every assertion below is about the host contract, not about
 * machine speed:
 *
 *   1. the tool returns `accepted` before synthesis/playback and never waits for the clip
 *   2. background event order is synth.start -> play.start -> finish, same speechId/turn/session
 *   3. `waitSpeech` returns status 'finished' once the clip ends
 *   4. `waitSpeech` timeout reports the current status and does NOT cancel the playing voice
 *   5. `cancelSpeech` emits speech.cancelled and stops the player
 *   6. idempotency is by identity, not text: same speechId+sentenceId never replays, two
 *      deliberate lines with the same text both play
 *   7. speech.finish carries callToFirstAudioMs / playDurationMs / queueWaitMs as numbers
 *   8. a failed clip reports speech.failed with the same error and the three numeric fields
 *   9. three accepted lines play FIFO, one at a time, even when a later one synthesizes first
 *  10. a queue wait over `speechQueueWaitMs` fails with reason queue-timeout and plays nothing
 *  11. `turn/start` is not an interruption; the user's next message clears the old turn's speech
 *
 * Run: node --test test/speech-async.mjs
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { registerHooks } from 'node:module';
import { Readable } from 'node:stream';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupRoot, disposeAll } from './helpers/cleanup.mjs';

const state = {
  root: '',
  clips: [],
  texts: [],
  kills: [],
  seq: 0,
  synthMs: 60,
  playMs: 400,
  failText: '',
  synthDelays: {},
  synthDone: [],
  textByFile: new Map(),
  /** Optional scripted streaming transport (`speakStreaming`); file playback when null. */
  ffplay: null,
  /** How many clips are "sounding"; the seat may never let two overlap. */
  live: 0,
  overlaps: 0,
  stream: async () => { throw new Error('streaming not expected'); },
};
globalThis.__speechAsync = state;

/** Scripted player: `onStart` is the first-audio anchor and the returned promise is the clip end. */
state.play = (file, options = {}) => new Promise((resolve, reject) => {
  const clip = {
    file,
    startedAt: Date.now(),
    endedAt: 0,
    cancelled: false,
    finish: null,
    cancelNow: null,
  };
  // Overlap accounting: a clip counts as sounding from `play()` until it ends OR a kill is
  // requested (the real stopPlayback kills the player process, not eventually).
  if (state.live > 0) state.overlaps += 1;
  state.live += 1;
  const release = () => {
    if (clip.accounted === true) return;
    clip.accounted = true;
    state.live = Math.max(0, state.live - 1);
  };
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    if (clip.endedAt === 0) clip.endedAt = Date.now();
    release();
    resolve();
  };
  clip.finish = finish;
  clip.cancelNow = () => {
    if (settled) return;
    settled = true;
    clip.cancelled = true;
    clip.endedAt = Date.now();
    release();
    reject(new DOMException('Speech cancelled', 'AbortError'));
  };
  clip.kill = release;
  state.clips.push(clip);
  options.onStart?.({ startedAt: clip.startedAt });
  const timer = setTimeout(finish, state.playMs);
  timer.unref?.();
  const abort = () => {
    clearTimeout(timer);
    clip.cancelNow();
  };
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted === true) abort();
});

/** Synthesis: a controllable delay, then a result whose length is the scripted clip duration. */
state.synthesize = async (options = {}) => {
  state.texts.push(options.text);
  const delay = Number.isFinite(state.synthDelays?.[options.text]) ? state.synthDelays[options.text] : state.synthMs;
  await new Promise((resolve) => setTimeout(resolve, delay));
  options.signal?.throwIfAborted?.();
  if (state.failText.length > 0 && options.text === state.failText) {
    throw new Error('tts-down');
  }
  state.seq += 1;
  const file = join(state.root, 'tts', `${state.seq}.mp3`);
  state.synthDone.push({ text: options.text, at: Date.now() });
  state.textByFile.set(file, options.text);
  return {
    file,
    bytes: 16,
    durationMs: state.playMs,
    provider: 'edge-tts',
  };
};

/** Real stopPlayback kills the player; the exit is asynchronous, like a real process close. */
state.stopPlayback = () => {
  const clip = state.clips.at(-1);
  if (clip === undefined || clip.endedAt > 0) return false;
  state.kills.push(clip);
  // The kill request already silences the player: count it as no longer sounding, then let the
  // rejected transport settle out of band.
  clip.kill?.();
  setImmediate(() => clip.cancelNow());
  return true;
};

const ttsUrl = new URL('../src/host/speech/tts.js', import.meta.url).href;
const sightUrl = new URL('../src/host/vision/sight.js', import.meta.url).href;
const subtitleUrl = new URL('../src/host/subtitle/subtitle.js', import.meta.url).href;
const hooks = registerHooks({
  load(url, context, next) {
    if (url === ttsUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
    const s = globalThis.__speechAsync;
    export { resolveGptLangs, resolveGptSovitsTimeout } from '${ttsUrl}?speech-async-helpers';
    export const configureTts = () => {};
    export const gptSovitsReferenceStatus = async () => ({ seconds: null, ok: false, readable: false });
    export const warmupGptSovits = async () => ({ ok: false, skipped: 'disabled' });
    export const applyGptSovitsModels = () => ({ ok: true });
    export const synthesize = (options) => s.synthesize(options);
    export const speakStreaming = (options) => s.stream(options);
    export const play = (file, options) => s.play(file, options);
    export const stopPlayback = () => s.stopPlayback();
    export const stopTts = () => true;`,
      };
    }
    if (url === sightUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
    const forbidden = () => { throw new Error('real capture forbidden'); };
    const s = globalThis.__speechAsync;
    export const resolveFfmpeg = () => null;
    export const resolveFfplay = () => s.ffplay ?? null;
    export const capture = forbidden, captureDesktop = forbidden, captureDevice = forbidden, startStoryboard = forbidden;
    export const OBSERVATION_TTL_MS = 30000;
    export function readObservation(o, { now = Date.now(), ttlMs = 30000 } = {}) {
      const v = o ?? {}; const c = Number(v.capturedAt); const s = Number(v.capturedAt) || Number(v.at);
      const at = Number.isFinite(c) && c > 0 ? c : (Number.isFinite(s) && s > 0 ? s : null);
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
    export class SubtitleOverlay {
      constructor({ config }) { this.config = config; }
      async show() {}
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
const { apply, createSpeechLedger, waitSpeech, cancelSpeech } = await import('../src/host/index.js');
hooks.deregister();
after(() => { delete globalThis.__speechAsync; });

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

const waitUntil = async (check, message, timeoutMs = 4000) => {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out: ${message}`);
    await tick(10);
  }
};

// ---------------------------------------------------------------------------
// Mounted host fixture: real apply() + real assistant_say, scripted transport
// ---------------------------------------------------------------------------

async function mount(t, { synthMs = 60, playMs = 400, failText = '', queueWaitMs, synthDelays = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-speech-async-'));
  await mkdir(join(root, 'data'), { recursive: true });
  await writeFile(join(root, 'data', 'features.json'), JSON.stringify({
    hearing: false,
    ambient: false,
    subtitle: false,
    voice: true,
  }));
  await writeFile(join(root, 'data', 'settings.json'), JSON.stringify({
    gptSovits: { enabled: false },
    subtitle: { enabled: false },
    ...(Number.isFinite(queueWaitMs) ? { speechQueueWaitMs: queueWaitMs } : {}),
  }));
  state.root = root;
  state.clips = [];
  state.texts = [];
  state.kills = [];
  state.seq = 0;
  state.synthMs = synthMs;
  state.playMs = playMs;
  state.failText = failText;
  state.synthDelays = synthDelays;
  state.synthDone = [];
  state.textByFile = new Map();
  state.ffplay = null;
  state.live = 0;
  state.overlaps = 0;
  state.stream = async () => { throw new Error('streaming not expected'); };

  const handlers = [];
  const cleanups = [];
  const tools = new Map();
  const routes = new Map();
  const effect = (fn) => {
    const cleanup = fn();
    if (typeof cleanup === 'function') cleanups.push(cleanup);
    return cleanup;
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
    systemPrompt: { section: () => () => {} },
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
    tools: {
      register(tool) {
        tools.set(tool.name, tool);
        return () => tools.delete(tool.name);
      },
    },
    inject: (_deps, register) => register(scope),
  }, { root, enabled: true });

  const session = { id: 'speech-async-session', header: { cwd: join(root, 'workspace') } };
  const emit = (event) => {
    for (const entry of [...handlers]) {
      if (entry.type === 'session/event') entry.handler(session, event);
    }
  };
  const events = async () => {
    try {
      const text = await readFile(join(root, 'data', 'events.jsonl'), 'utf8');
      return text.trim().split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  };
  const waitForEvent = async (type, predicate = () => true, timeoutMs = 4000) => {
    const started = Date.now();
    for (;;) {
      const row = (await events()).find((event) => event.type === type && predicate(event.payload ?? {}));
      if (row !== undefined) return row.payload ?? {};
      if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${type}`);
      await tick(10);
    }
  };
  t.after(async () => {
    for (const clip of [...state.clips]) clip.finish?.();
    await tick(20);
    await disposeAll(cleanups.splice(0));
    await cleanupRoot(root);
  });
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
  return {
    root,
    session,
    emit,
    events,
    waitForEvent,
    action,
    beginTurn: (turn) => emit({ type: 'turn/start', data: { turn } }),
    say: (args) => tools.get('assistant_say').execute(args, { agent: { session } }),
    tool: () => tools.get('assistant_say'),
    players: () => state.clips,
    synthTexts: () => state.texts,
  };
}

// ---------------------------------------------------------------------------
// 1. Acceptance returns before the clip exists
// ---------------------------------------------------------------------------

test('1. the tool returns accepted before synthesis and playback finish', async (t) => {
  const app = await mount(t, { synthMs: 80, playMs: 400 });
  app.beginTurn(7);
  const calledAt = Date.now();
  const said = await app.say({ text: '第一句。' });
  const returnedInMs = Date.now() - calledAt;
  assert.equal(said.accepted, true, 'the call was accepted');
  assert.equal(typeof said.speechId, 'string');
  assert.ok(said.speechId.length > 0, 'a speech id is always present');
  assert.equal(said.status, 'synthesizing', 'acceptance never claims the voice already played');
  assert.equal(said.queued, false, 'the first speech of the host did not queue');
  assert.equal(said.duplicate, false);
  assert.ok(
    returnedInMs < 200,
    `returned in ${returnedInMs}ms, before synthesis (${state.synthMs}ms) + playback (${state.playMs}ms)`,
  );
  assert.equal(app.players().length, 0, 'no player had started when the tool returned');
  // Requirement: the text the model sees says "accepted for later playback", never "played".
  const rendered = app.tool().output.render({ text: '第一句。' }, said).map((block) => block.text).join('');
  assert.match(rendered, /已接纳/);
  assert.match(rendered, /稍后播报/);
  assert.ok(!rendered.includes('已播放'), 'the tool output never claims the line already played');
  const finished = await waitSpeech(said.speechId, { timeoutMs: 3000 });
  assert.equal(finished.ok, true);
  assert.equal(finished.status, 'finished');
  t.diagnostic(`returned in ${returnedInMs}ms; synth=${state.synthMs}ms play=${state.playMs}ms; status ${said.status} -> ${finished.status}`);
});

// ---------------------------------------------------------------------------
// 2-3. Background event order and waitSpeech completion
// ---------------------------------------------------------------------------

test('2-3. events run synth.start -> play.start -> finish, and waitSpeech reports finished', async (t) => {
  const app = await mount(t, { synthMs: 50, playMs: 300 });
  app.beginTurn(8);
  const said = await app.say({ text: '顺序测试。' });
  const waited = await waitSpeech(said.speechId, { timeoutMs: 3000 });
  assert.equal(waited.status, 'finished', 'waitSpeech returns the settled state');
  const rows = (await app.events()).filter((event) => (
    ['speech.synth.start', 'speech.play.start', 'speech.finish'].includes(event.type)
    && event.payload?.speechId === said.speechId
  ));
  assert.deepEqual(
    rows.map((event) => event.type),
    ['speech.synth.start', 'speech.play.start', 'speech.finish'],
    'the background events are ordered',
  );
  for (const row of rows) {
    assert.equal(row.payload.speechId, said.speechId);
    assert.equal(row.payload.turn, 8, 'every event carries the turn');
    assert.equal(row.payload.sessionId, app.session.id, 'every event carries the session id');
  }
  assert.equal(rows.at(-1).payload.status, 'finished');
  assert.equal(rows[1].payload.owner, true, 'the clip that started is the single playback owner');
  assert.equal(rows.at(-1).payload.preempted, false, 'a naturally finished line was not preempted');
  t.diagnostic(`order=${rows.map((event) => event.type).join(' -> ')} speechId=${said.speechId}`);
});

// ---------------------------------------------------------------------------
// 4. A timeout observes, it never cancels
// ---------------------------------------------------------------------------

test('4. a waitSpeech timeout leaves the playing voice untouched', async (t) => {
  const app = await mount(t, { synthMs: 30, playMs: 900 });
  app.beginTurn(9);
  const said = await app.say({ text: '超时测试。' });
  await app.waitForEvent('speech.play.start', (payload) => payload.speechId === said.speechId);
  const timedOut = await waitSpeech(said.speechId, { timeoutMs: 80 });
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.reason, 'timeout', 'a timeout is its own answer');
  assert.equal(timedOut.status, 'playing', 'it reports what the speech was doing when the wait expired');
  const clip = app.players().at(-1);
  assert.equal(clip.cancelled, false, 'the timed-out wait did not cancel the player');
  const cancelledRows = (await app.events()).filter(
    (event) => event.type === 'speech.cancelled' && event.payload?.speechId === said.speechId,
  );
  assert.equal(cancelledRows.length, 0, 'no cancel event was caused by the timeout');
  const finished = await waitSpeech(said.speechId, { timeoutMs: 3000 });
  assert.equal(finished.status, 'finished', 'the voice finished on its own after the timeout');
  t.diagnostic(`timeout status=${timedOut.status}; clip.cancelled=${clip.cancelled}; then ${finished.status}`);
});

// ---------------------------------------------------------------------------
// 5. Cancellation is an explicit action
// ---------------------------------------------------------------------------

test('5. cancelSpeech stops the clip and emits speech.cancelled', async (t) => {
  const app = await mount(t, { synthMs: 30, playMs: 1200 });
  app.beginTurn(10);
  const said = await app.say({ text: '取消测试。' });
  await app.waitForEvent('speech.play.start', (payload) => payload.speechId === said.speechId);
  const cancelled = cancelSpeech(said.speechId);
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.status, 'cancelled');
  const event = await app.waitForEvent(
    'speech.cancelled',
    (payload) => payload.speechId === said.speechId,
  );
  assert.equal(event.status, 'cancelled');
  assert.equal(event.reason, 'explicit', 'cancelSpeech is the explicit cancel class');
  assert.equal(event.cancelClass, 'explicit');
  assert.equal(event.turn, 10);
  assert.equal(event.sessionId, app.session.id);
  await waitUntil(() => app.players().at(-1).cancelled === true, 'the player was stopped');
  const waited = await waitSpeech(said.speechId, { timeoutMs: 1000 });
  assert.equal(waited.ok, false, 'a cancelled speech is not a success');
  assert.equal(waited.reason, 'cancelled');
  assert.equal(waited.status, 'cancelled');
  t.diagnostic(`cancel -> ${event.status}; player stopped; wait=${waited.reason}`);
});

// ---------------------------------------------------------------------------
// 5b. Old-turn isolation rides the user's NEXT input, never a turn/start
// ---------------------------------------------------------------------------

test('5b. a newer turn alone cancels nothing; the user message cancels the previous speech', async (t) => {
  const app = await mount(t, { synthMs: 30, playMs: 1200 });
  app.beginTurn(20);
  const said = await app.say({ text: '旧轮语音。' });
  await app.waitForEvent('speech.play.start', (payload) => payload.speechId === said.speechId);
  // Turning is machinery: the next turn starting leaves the old clip sounding.
  app.beginTurn(21);
  await tick(120);
  assert.equal(
    (await app.events()).filter((event) => event.type === 'speech.cancelled').length,
    0,
    'turn/start is not an interruption',
  );
  // The user's own message for turn 21 is the one allowed preemption.
  app.emit({
    type: 'user/message',
    data: { turn: 21, id: 'u-21', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '下一句' }] },
  });
  const event = await app.waitForEvent('speech.cancelled', (payload) => payload.speechId === said.speechId);
  assert.equal(event.reason, 'user-input', 'only the user input preempts');
  assert.equal(event.turn, 20, 'the cancelled event still identifies the old turn');
  await waitUntil(() => app.players().at(-1).cancelled === true, 'the old clip was stopped');
  const waited = await waitSpeech(said.speechId, { timeoutMs: 1000 });
  assert.equal(waited.status, 'cancelled');
  t.diagnostic(`turn 21 start kept turn 20 speech; user message cancelled ${said.speechId} (${event.reason})`);
});

// ---------------------------------------------------------------------------
// 6. Identity, not text, is the idempotency key
// ---------------------------------------------------------------------------

test('6. two deliberate lines with the same text are two speeches; identity dedupes', async (t) => {
  const app = await mount(t, { synthMs: 30, playMs: 250 });
  app.beginTurn(11);
  const first = await app.say({ text: '重复一次。' });
  const second = await app.say({ text: '重复一次。' });
  assert.equal(second.accepted, true);
  assert.equal(second.duplicate, false, 'a new call is a new identity, even with the same text');
  assert.notEqual(second.speechId, first.speechId, 'each deliberate line has its own speechId');
  await waitSpeech(first.speechId, { timeoutMs: 3000 });
  await waitSpeech(second.speechId, { timeoutMs: 3000 });
  assert.equal(app.synthTexts().filter((text) => text === '重复一次。').length, 2, 'synthesized twice');
  assert.equal(app.players().length, 2, 'played twice');

  // The ledger seam: one identity is idempotent, two identities with the same text both play.
  const events = [];
  const runs = [];
  const ledger = createSpeechLedger({ emit: async (type, payload) => { events.push({ type, payload }); } });
  const run = async ({ onFirstAudio }) => {
    runs.push(1);
    onFirstAudio(Date.now());
  };
  const a = ledger.accept({ sessionId: 's', turn: 1, text: '同文。', identity: 'r:1', claimText: true, run });
  const b = ledger.accept({ sessionId: 's', turn: 1, text: '同文。', identity: 'r:1', claimText: true, run });
  const c = ledger.accept({ sessionId: 's', turn: 1, text: '同文。', identity: 'r:2', claimText: true, run });
  assert.equal(b.duplicate, true);
  assert.equal(b.speechId, a.speechId, 'the same identity returns the same speechId');
  assert.equal(c.duplicate, false);
  assert.notEqual(c.speechId, a.speechId, 'a different identity with the same text still plays');
  await Promise.all([
    ledger.wait(a.speechId, { timeoutMs: 1000 }),
    ledger.wait(c.speechId, { timeoutMs: 1000 }),
  ]);
  assert.equal(runs.length, 2, 'the duplicate identity never ran');
  t.diagnostic(`same text: ${first.speechId} and ${second.speechId}; identity r:1 -> ${a.speechId}, r:2 -> ${c.speechId}`);
});

// ---------------------------------------------------------------------------
// 7-8. The three timings, on success and on failure
// ---------------------------------------------------------------------------

test('7. speech.finish carries callToFirstAudioMs / playDurationMs / queueWaitMs', async (t) => {
  const app = await mount(t, { synthMs: 80, playMs: 300 });
  app.beginTurn(12);
  const said = await app.say({ text: '耗时测试。' });
  // A second, different line is accepted while the first is still sounding: it reports `queued`
  // and its first audio has to wait for the single playback channel.
  const queuedSpeech = await app.say({ text: '排队测试。' });
  assert.equal(queuedSpeech.queued, true, 'a second accepted speech reports that it queued');
  await waitSpeech(said.speechId, { timeoutMs: 4000 });
  const finish = await app.waitForEvent('speech.finish', (payload) => payload.speechId === said.speechId);
  for (const field of ['callToFirstAudioMs', 'playDurationMs', 'queueWaitMs']) {
    assert.equal(typeof finish[field], 'number', `${field} is a number`);
    assert.ok(finish[field] >= 0, `${field} is not negative (${finish[field]})`);
  }
  assert.ok(finish.callToFirstAudioMs >= 70, `first audio waits for synthesis (${finish.callToFirstAudioMs}ms)`);
  assert.ok(finish.playDurationMs >= 200, `playDurationMs≈300 (${finish.playDurationMs}ms)`);
  assert.ok(finish.queueWaitMs < 50, `the first speech of the turn did not queue (${finish.queueWaitMs}ms)`);
  await waitSpeech(queuedSpeech.speechId, { timeoutMs: 4000 });
  const queuedFinish = await app.waitForEvent('speech.finish', (payload) => payload.speechId === queuedSpeech.speechId);
  assert.ok(
    queuedFinish.callToFirstAudioMs >= 250,
    `the queued speech waited for the first clip before its first audio (${queuedFinish.callToFirstAudioMs}ms)`,
  );
  t.diagnostic(
    `callToFirstAudio=${finish.callToFirstAudioMs}ms playDuration=${finish.playDurationMs}ms `
    + `queueWait=${finish.queueWaitMs}ms; queuedFirstAudio=${queuedFinish.callToFirstAudioMs}ms`,
  );
});

test('8. speech.failed also carries the three numeric timings', async (t) => {
  const app = await mount(t, { synthMs: 30, playMs: 200, failText: '失败测试。' });
  app.beginTurn(13);
  const said = await app.say({ text: '失败测试。' });
  const waited = await waitSpeech(said.speechId, { timeoutMs: 3000 });
  assert.equal(waited.ok, false);
  assert.equal(waited.reason, 'failed');
  const failed = await app.waitForEvent('speech.failed', (payload) => payload.speechId === said.speechId);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, 'tts-down');
  for (const field of ['callToFirstAudioMs', 'playDurationMs', 'queueWaitMs']) {
    assert.equal(typeof failed[field], 'number', `failed ${field} is a number`);
    assert.ok(failed[field] >= 0, `failed ${field} is not negative`);
  }
  assert.equal(failed.callToFirstAudioMs, 0, 'nothing ever reached the player');
  assert.equal(failed.playDurationMs, 0, 'nothing ever played');
  assert.equal(app.players().length, 0, 'a failed synthesis played nothing');
  t.diagnostic(`failed status=${failed.status}; timings=${failed.callToFirstAudioMs}/${failed.playDurationMs}/${failed.queueWaitMs}`);
});

// ---------------------------------------------------------------------------
// 9. FIFO: three accepted lines play in request order, never overlapping
// ---------------------------------------------------------------------------

test('9. three accepted lines play one at a time, in request order (FIFO)', async (t) => {
  const app = await mount(t, { synthMs: 20, playMs: 120 });
  app.beginTurn(14);
  const first = await app.say({ text: '第一句。' });
  const second = await app.say({ text: '第二句。' });
  const third = await app.say({ text: '第三句。' });
  for (const said of [first, second, third]) {
    const finished = await waitSpeech(said.speechId, { timeoutMs: 5000 });
    assert.equal(finished.status, 'finished');
  }
  assert.equal(app.players().length, 3, 'every accepted line reached a player exactly once');
  // The fixture numbers the files in acceptance order: the players must follow it.
  const played = app.players().map((clip) => clip.file.split(/[\\/]/u).pop());
  assert.deepEqual(played, ['1.mp3', '2.mp3', '3.mp3'], 'playback order matches the request order');
  const starts = (await app.events())
    .filter((event) => event.type === 'speech.play.start')
    .map((event) => event.payload.speechId);
  assert.deepEqual(starts, [first.speechId, second.speechId, third.speechId], 'play.start order is FIFO');
  const clips = app.players();
  for (let index = 1; index < clips.length; index += 1) {
    assert.ok(
      clips[index].startedAt >= clips[index - 1].endedAt,
      `clip ${index + 1} started only after clip ${index} ended`,
    );
  }
  t.diagnostic(`FIFO=${starts.join(' -> ')}`);
});

// ---------------------------------------------------------------------------
// 10. Queue timeout: a request that waits too long fails without a player
// ---------------------------------------------------------------------------

test('10. a queue wait over speechQueueWaitMs fails with reason queue-timeout', async (t) => {
  const app = await mount(t, { synthMs: 20, playMs: 700, queueWaitMs: 120 });
  app.beginTurn(15);
  const blocker = await app.say({ text: '先说的长句。' });
  await app.waitForEvent('speech.play.start', (payload) => payload.speechId === blocker.speechId);
  const queued = await app.say({ text: '等到超时的句子。' });
  assert.equal(queued.queued, true, 'the second request reported that it queued');
  const failed = await app.waitForEvent('speech.failed', (payload) => payload.speechId === queued.speechId);
  assert.equal(failed.reason, 'queue-timeout', 'the failure names the queue timeout');
  assert.equal(failed.status, 'failed');
  assert.equal(app.players().length, 1, 'the timed-out line never started a player');
  const waited = await waitSpeech(queued.speechId, { timeoutMs: 1000 });
  assert.equal(waited.reason, 'failed');
  assert.equal(waited.failureReason, 'queue-timeout');
  const finished = await waitSpeech(blocker.speechId, { timeoutMs: 3000 });
  assert.equal(finished.status, 'finished', 'the playing line was never cut by the timeout');
  const cancelled = (await app.events()).filter((event) => event.type === 'speech.cancelled');
  assert.equal(cancelled.length, 0, 'a queue timeout is a failure, not a cancellation');
  t.diagnostic(`queue-timeout after ${failed.queueWaitMs}ms; players=${app.players().length}; blocker=${finished.status}`);
});

// ---------------------------------------------------------------------------
// 11. A user message clears the old playing line AND its queued lines
// ---------------------------------------------------------------------------

test('11. a user message cancels the old owner and its queued requests', async (t) => {
  const app = await mount(t, { synthMs: 20, playMs: 900 });
  app.beginTurn(16);
  const playing = await app.say({ text: '旧轮正在播。' });
  await app.waitForEvent('speech.play.start', (payload) => payload.speechId === playing.speechId);
  const queued = await app.say({ text: '旧轮排队句。' });
  // A new turn starting is machinery; the user message is the trigger.
  app.beginTurn(17);
  await tick(60);
  assert.equal(
    (await app.events()).filter((event) => event.type === 'speech.cancelled').length,
    0,
    'turn/start alone never cancels',
  );
  app.emit({
    type: 'user/message',
    data: { turn: 17, id: 'u-17', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '新的一轮' }] },
  });
  const playingCancel = await app.waitForEvent(
    'speech.cancelled',
    (payload) => payload.speechId === playing.speechId,
  );
  assert.equal(playingCancel.reason, 'user-input');
  const queuedCancel = await app.waitForEvent(
    'speech.cancelled',
    (payload) => payload.speechId === queued.speechId,
  );
  assert.equal(queuedCancel.reason, 'user-input', 'a queued old-turn request is cleared too');
  await waitUntil(() => app.players().every((clip) => clip.cancelled === true), 'the old clip stopped');
  assert.equal(app.players().length, 1, 'the queued line never reached a player');
  // The user message marked turn 17 as a typed round, so a standalone line must say it is explicit.
  const after = await app.say({ text: '新轮第一句。', purpose: 'explicit' });
  const newFinish = await waitSpeech(after.speechId, { timeoutMs: 3000 });
  assert.equal(newFinish.status, 'finished', 'the new turn is not affected by old callbacks');
  t.diagnostic(`user input: playing=${playingCancel.reason}, queued=${queuedCancel.reason}, new=${newFinish.status}`);
});

// ---------------------------------------------------------------------------
// 12. FIFO is acceptance order, even when a later line synthesizes first
// ---------------------------------------------------------------------------

test('12. a faster later line never overtakes the slower earlier accepted line', async (t) => {
  const app = await mount(t, {
    playMs: 120,
    synthDelays: { '慢句。': 220, '快句。': 10 },
  });
  app.beginTurn(18);
  const slow = await app.say({ text: '慢句。' });
  const fast = await app.say({ text: '快句。' });
  await waitSpeech(slow.speechId, { timeoutMs: 5000 });
  await waitSpeech(fast.speechId, { timeoutMs: 5000 });
  const done = state.synthDone;
  const slowDone = done.find((entry) => entry.text === '慢句。');
  const fastDone = done.find((entry) => entry.text === '快句。');
  assert.ok(fastDone.at < slowDone.at, 'the later line really was ready first');
  const played = app.players().map((clip) => state.textByFile.get(clip.file));
  assert.deepEqual(played, ['慢句。', '快句。'], 'playback still follows acceptance order');
  const starts = (await app.events())
    .filter((event) => event.type === 'speech.play.start')
    .map((event) => event.payload.speechId);
  assert.deepEqual(starts, [slow.speechId, fast.speechId], 'play.start order is acceptance order');
  t.diagnostic(`fast ready ${slowDone.at - fastDone.at}ms earlier but played second: ${played.join(' -> ')}`);
});

// ---------------------------------------------------------------------------
// 13. cancel -> the queued waiter is granted and starts (no lost grant)
// ---------------------------------------------------------------------------

test('13. a waiter queued right after a cancel still gets the seat and starts', async (t) => {
  const app = await mount(t, { synthMs: 5, playMs: 600 });
  app.beginTurn(30);
  const blocker = await app.say({ text: '先占着席位的一句。' });
  await app.waitForEvent('speech.play.start', (payload) => payload.speechId === blocker.speechId);
  assert.equal(cancelSpeech(blocker.speechId, 'superseded').ok, true);
  // Accepted in the same tick as the cancel: the seat is still marked, the pump must hand it over.
  const next = await app.say({ text: '取消之后这句要起播。' });
  const granted = await app.waitForEvent(
    'speech.seat.granted',
    (payload) => payload.speechId === next.speechId,
    4000,
  );
  assert.equal(granted.speechId, next.speechId, 'the waiter owns the seat');
  const started = await app.waitForEvent(
    'speech.play.start',
    (payload) => payload.speechId === next.speechId,
    4000,
  );
  assert.ok(Number(started.callToFirstAudioMs) >= 0);
  const rows = await app.events();
  assert.equal(
    rows.filter((event) => event.type === 'speech.seat.double-release').length,
    0,
    'the cancel released the seat exactly once',
  );
  t.diagnostic(`cancel→queue: granted=${next.speechId} start=${started.speechId} doubleRelease=0 lost=0`);
});

// ---------------------------------------------------------------------------
// 14. grant -> immediate cancel: the cancelled clip never reports play.start
// ---------------------------------------------------------------------------

test('14. a clip cancelled after its grant never reports play.start; the queue continues', async (t) => {
  const app = await mount(t, { synthMs: 5, playMs: 400 });
  state.ffplay = 'fake-ffplay';
  state.stream = async (options) => {
    if (options.text.includes('取消的')) {
      // Grant happened, no first chunk yet: hold the transport until the cancel aborts it.
      await new Promise((resolve, reject) => {
        const fail = () => reject(new DOMException('cancelled', 'AbortError'));
        if (options.signal?.aborted === true) { fail(); return; }
        options.signal?.addEventListener('abort', fail, { once: true });
      });
    }
    options.onStart?.({ startedAt: Date.now() });
    return {
      file: join(app.root, 'tts', `stream-${options.text.length}.mp3`),
      bytes: 16,
      durationMs: 400,
      provider: 'edge-tts',
    };
  };
  app.beginTurn(31);
  const first = await app.say({ text: '先占着席位的一句。' });
  await app.waitForEvent('speech.play.start', (payload) => payload.speechId === first.speechId);
  const doomed = await app.say({ text: '被取消的这一句。' });
  const next = await app.say({ text: '下一句继续播。' });
  // Release the first clip: the doomed one is granted the seat (its transport has not started).
  assert.equal(cancelSpeech(first.speechId, 'superseded').ok, true);
  await app.waitForEvent('speech.seat.granted', (payload) => payload.speechId === doomed.speechId, 5000);
  assert.equal(cancelSpeech(doomed.speechId, 'muted').ok, true);
  const cancelled = await app.waitForEvent(
    'speech.cancelled',
    (payload) => payload.speechId === doomed.speechId,
    5000,
  );
  assert.equal(cancelled.reason, 'muted');
  const nextGrant = await app.waitForEvent(
    'speech.seat.granted',
    (payload) => payload.speechId === next.speechId,
    5000,
  );
  assert.equal(nextGrant.speechId, next.speechId, 'the cancelled grant was released and re-granted');
  const nextStart = await app.waitForEvent(
    'speech.play.start',
    (payload) => payload.speechId === next.speechId,
    5000,
  );
  const rows = await app.events();
  assert.equal(
    rows.filter((event) => event.type === 'speech.play.start' && event.payload.speechId === doomed.speechId).length,
    0,
    'the cancelled session never published play.start',
  );
  t.diagnostic(
    `grant→cancel: ${doomed.speechId} play.start=0; queue continued with ${next.speechId}`
    + ` (start=${nextStart.speechId})`,
  );
});

// ---------------------------------------------------------------------------
// 15. 100 random cancel/finish/grant interleavings: one sound, no lost grant
// ---------------------------------------------------------------------------

/** Deterministic PRNG: the interleaving is random enough to stress the seat but reproducible. */
const seededRandom = (seed) => {
  let value = seed >>> 0;
  return () => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    return value / 0x1_0000_0000;
  };
};

test('15. 100 random cancel/finish/grant interleavings never overlap and never lose a grant', async (t) => {
  const app = await mount(t, { synthMs: 5, playMs: 60 });
  const random = seededRandom(20261107);
  const accepted = [];
  for (let index = 0; index < 100; index += 1) {
    const choice = random();
    if (choice < 0.45 || accepted.length === 0) {
      const said = await app.say({ text: `第${index}句随机交错语音。` });
      if (said.accepted === true) accepted.push(said.speechId);
    } else if (choice < 0.75) {
      const target = accepted[Math.floor(random() * accepted.length)];
      cancelSpeech(target, random() < 0.5 ? 'superseded' : 'muted');
    } else {
      const sounding = state.clips.find((clip) => clip.endedAt === 0);
      sounding?.finish();
    }
    await tick(Math.floor(random() * 4));
  }
  // Drain: finish whatever is still sounding, then wait for every accepted speech to settle.
  for (const clip of [...state.clips]) clip.finish?.();
  for (const speechId of accepted) await waitSpeech(speechId, { timeoutMs: 8000 });
  await tick(80);
  const rows = await app.events();
  const granted = rows.filter((event) => event.type === 'speech.seat.granted');
  const released = rows.filter((event) => event.type === 'speech.seat.released');
  const doubleRelease = rows.filter((event) => event.type === 'speech.seat.double-release');
  const starts = rows.filter((event) => event.type === 'speech.play.start');
  const grantedIds = granted.map((event) => event.payload.speechId);
  const releasedIds = released.map((event) => event.payload.speechId);
  // 1) Never two players sounding at once (the scripted player counts the overlap itself).
  assert.equal(state.overlaps, 0, 'two clips sounded at the same moment');
  assert.equal(state.live, 0, 'a player was still sounding at quiescence');
  // 2) No double release.
  assert.equal(doubleRelease.length, 0, 'a seat was released twice');
  // 3) No lost grant: every grant was released, and every play.start belongs to a granted seat.
  assert.equal(grantedIds.length, releasedIds.length, 'grant/release counts differ');
  for (const speechId of grantedIds) {
    assert.ok(releasedIds.includes(speechId), `granted ${speechId} was never released (lost grant)`);
  }
  for (const row of starts) {
    assert.ok(grantedIds.includes(row.payload.speechId), `play.start without a seat grant: ${row.payload.speechId}`);
  }
  // 4) The stress really granted many seats (it is not passing on an empty log).
  assert.ok(grantedIds.length >= 10, `only ${grantedIds.length} grants in 100 iterations`);
  const uniqueGrants = new Set(grantedIds);
  assert.equal(uniqueGrants.size, grantedIds.length, 'one speech was granted the seat twice');
  t.diagnostic(
    `100 interleavings: grants=${grantedIds.length} releases=${releasedIds.length} `
    + `doubleRelease=${doubleRelease.length} overlaps=${state.overlaps} lostGrant=0 starts=${starts.length}`,
  );
});

// ---------------------------------------------------------------------------
// 16-17. Progress cues are capped at 30 characters at the tool layer
// ---------------------------------------------------------------------------

const LONG_PROGRESS = '我正在检查这项设置和运行日志，看看是不是缓存没有刷新，你再稍等一下，马上就好。';
const LONG_PROGRESS_CLIPPED = '我正在检查这项设置和运行日志';

test('16. a 40-character progress line is clipped at its first comma and reports the event', async (t) => {
  const app = await mount(t, { synthMs: 10, playMs: 80 });
  app.beginTurn(41);
  assert.ok([...LONG_PROGRESS].length > 30, 'the fixture really is over the 30-character cap');
  const said = await app.say({ text: LONG_PROGRESS, purpose: 'progress' });
  assert.equal(said.accepted, true, 'an overlong progress cue is clipped, not rejected');
  const progress = await app.waitForEvent('voice.say.progress', (payload) => payload.turn === 41);
  assert.equal(progress.clipped, true, 'the event says the cap changed the line');
  assert.ok(progress.chars <= 30, `spoken chars=${progress.chars} stay within the cap`);
  assert.equal(progress.chars, [...LONG_PROGRESS_CLIPPED].length);
  assert.equal(progress.originalChars, [...LONG_PROGRESS].length, 'the original length is reported');
  const finished = await waitSpeech(said.speechId, { timeoutMs: 3000 });
  assert.equal(finished.status, 'finished');
  assert.equal(app.synthTexts()[0], LONG_PROGRESS_CLIPPED, 'TTS only receives the clipped cue');
  t.diagnostic(
    `original=${progress.originalChars} chars -> clipped=${progress.chars} `
    + `("${LONG_PROGRESS_CLIPPED}") accepted=${said.accepted} status=${finished.status}`,
  );
});

test('17. a short progress line is accepted unchanged (regression)', async (t) => {
  const app = await mount(t, { synthMs: 10, playMs: 80 });
  app.beginTurn(42);
  const shortLine = '我先去查一下相关资料，你稍等。';
  const said = await app.say({ text: shortLine, purpose: 'progress' });
  assert.equal(said.accepted, true);
  const progress = await app.waitForEvent('voice.say.progress', (payload) => payload.turn === 42);
  assert.equal(progress.clipped, false, 'a short cue is not touched');
  assert.equal(progress.chars, [...shortLine].length);
  assert.equal(progress.originalChars, [...shortLine].length);
  const finished = await waitSpeech(said.speechId, { timeoutMs: 3000 });
  assert.equal(finished.status, 'finished');
  assert.equal(app.synthTexts()[0], shortLine, 'the short cue reaches TTS verbatim');
  t.diagnostic(`short progress chars=${progress.chars} clipped=${progress.clipped} status=${finished.status}`);
});

test('18. an untagged line is spoken whole even when it reads like progress', async (t) => {
  const app = await mount(t, { synthMs: 10, playMs: 80 });
  app.beginTurn(43);
  const said = await app.say({ text: LONG_PROGRESS });
  assert.equal(said.accepted, true);
  await waitSpeech(said.speechId, { timeoutMs: 3000 });
  // The 30-char cap belongs to an explicitly tagged progress/ack line only: guessing from the
  // opening words used to cut real content (e.g. a correction that starts with "我先前说的...").
  const rows = await app.events();
  assert.equal(rows.filter((event) => event.type === 'voice.say.progress' && event.payload.turn === 43).length, 0);
  assert.equal(app.synthTexts()[0], LONG_PROGRESS, 'the untagged line is spoken in full');
  t.diagnostic(`untagged line spoken whole: ${[...LONG_PROGRESS].length} chars, no clipping event`);
});

