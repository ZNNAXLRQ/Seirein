/**
 * `voice.inputInterruptsReply` — whether the user's own next input (voice or typed) may cut the
 * assistant speech that is already playing.
 *
 * Default `true` keeps the historical behavior: an accepted voice delivery / typed user message
 * cancels the sounding clip and every unfinished typed/say line. Stored `false` keeps the old
 * speech: pending proactive candidates are still retired, the sounding line finishes, and the new
 * reply is queued behind it through the one playback seat. Explicit stops (mute, component switch,
 * feature disable) never go through that gate and still stop immediately.
 *
 * The fixture is the real mounted host with fake TTS/sight/subtitle/hearing: no sound, capture,
 * network, process or GUI is involved. Fake players stay unresolved until the test resolves them,
 * which lets us prove "the old sentence was not cut" and "the new sentence did not start early".
 *
 * Run: node --test test/voice-input-interrupt-setting.mjs
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
  players: [],
  synth: [],
  stops: 0,
  hearingOnUpdate: null,
  hearingStarted: 0,
};
globalThis.__voiceInputInterrupt = state;

const ttsUrl = new URL('../src/host/speech/tts.js', import.meta.url).href;
const sightUrl = new URL('../src/host/vision/sight.js', import.meta.url).href;
const subtitleUrl = new URL('../src/host/subtitle/subtitle.js', import.meta.url).href;
const hearingUrl = new URL('../src/host/hearing/hearing.js', import.meta.url).href;

const hooks = registerHooks({
  load(url, context, next) {
    if (url === ttsUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
    const s = globalThis.__voiceInputInterrupt;
    export { resolveGptLangs, resolveGptSovitsTimeout } from '${ttsUrl}?voice-input-interrupt-helpers';
    export const configureTts = () => {};
    export const gptSovitsReferenceStatus = async () => ({ seconds: null, ok: false, readable: false });
    export const warmupGptSovits = async () => ({ ok: false, skipped: 'disabled' });
    export const applyGptSovitsModels = () => ({ ok: true });
    export const synthesize = async (options) => {
      s.synth.push(String(options?.text ?? ''));
      return {
        file: 'voice-input-interrupt-' + s.synth.length + '.mp3',
        bytes: 16,
        durationMs: 30000,
        provider: 'fake',
        text: String(options?.text ?? ''),
      };
    };
    export const speakStreaming = async (options) => {
      // The assistant_say lane prefers the streamed transport when ffplay is resolvable. This
      // fake mirrors tts.js's own file fallback so the same controllable player is used.
      const result = await synthesize(options);
      const playback = play(result.file, {
        ffplayPath: options.ffplayPath, signal: options.signal, onStart: options.onStart,
      });
      playback.catch(() => {});
      try { options.onTransport?.({ exit: playback, via: 'file' }); } catch { /* diagnostic only */ }
      return { ...result, firstChunkMs: null, via: 'file' };
    };
    export const play = (file, options) => {
      let resolve;
      const done = new Promise((resolveDone) => { resolve = resolveDone; });
      const player = {
        file,
        signal: options?.signal ?? null,
        createdAt: Date.now(),
        resolvedAt: 0,
        aborted: false,
        stopped: false,
        resolve() {
          if (this.resolvedAt > 0) return false;
          this.resolvedAt = Date.now();
          resolve();
          return true;
        },
        stop() {
          if (this.resolvedAt > 0) return false;
          this.stopped = true;
          this.resolve();
          return true;
        },
      };
      const onAbort = () => { player.aborted = true; player.stop(); };
      if (player.signal?.aborted === true) onAbort();
      else player.signal?.addEventListener?.('abort', onAbort, { once: true });
      s.players.push(player);
      try {
        options?.onStart?.({ startedAt: player.createdAt });
        options?.onTransport?.({ exit: done, via: 'fake-player' });
      } catch {
        /* the fake transport is observation only */
      }
      return done;
    };
    export const stopPlayback = () => {
      s.stops += 1;
      for (const player of s.players) player.stop();
      return true;
    };
    export const stopTts = () => {
      s.stops += 1;
      for (const player of s.players) player.stop();
      return true;
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
    export const resolveFfplay = () => 'ffplay-fake';
    export const capture = forbidden, captureDesktop = forbidden, captureDevice = forbidden, startStoryboard = forbidden;
    export const OBSERVATION_TTL_MS = 30000;
    export function readObservation(o, { now = Date.now(), ttlMs = 30000 } = {}) {
      const v = o ?? {}; const c = Number(v.capturedAt); const at = Number.isFinite(c) && c > 0 ? c : null;
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
      async show() { return true; }
      async hide() {}
      async stop() {}
    }`,
      };
    }
    if (url === hearingUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
    const s = globalThis.__voiceInputInterrupt;
    export const modelReady = () => true;
    export const finalModelReady = () => false;
    export const isLoopbackDevice = (name) => /CABLE|Stereo Mix|Virtual/i.test(String(name));
    export const selectMicrophoneDevice = (devices) => ({ device: devices[0] ?? '', reason: '' });
    export const listDevices = async () => ['Fake Mic'];
    export const startHearing = (options) => {
      s.hearingStarted += 1;
      s.hearingOnUpdate = options.onUpdate;
      return { device: options.device, stop() {}, stats: () => ({ rmsDb: -30, peakDb: -20 }) };
    };
    export const watchHearingExit = () => {};
    export const annotateTranscript = (text) => text;
    export const joinDetailFields = () => ({});
    export const mergeJoinFallback = () => ({});
    export const offlineLimitedNote = () => '';
    export const truncationNotice = () => '';`,
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
after(() => { delete globalThis.__voiceInputInterrupt; });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitUntil = async (check, label, timeoutMs = 5000) => {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out: ${label}`);
    await sleep(10);
  }
};
const startEvent = (turn) => ({ type: 'turn/start', data: { turn } });
const endEvent = (turn) => ({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } });
const userEvent = (turn, text = '这是用户的问题') => ({
  type: 'user/message',
  data: { turn, id: `u-${turn}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
});
const assistantEvent = (turn, text) => ({
  type: 'assistant/message',
  data: { turn, step: 1, message: { id: `a-${turn}`, role: 'assistant', content: [{ type: 'text', text }] } },
});
const readEvents = async (root) => {
  try {
    const text = await readFile(join(root, 'data', 'events.jsonl'), 'utf8');
    return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
};

async function mount(t, { hearing = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-voice-input-interrupt-'));
  await mkdir(join(root, 'data'), { recursive: true });
  await mkdir(join(root, 'workspace'), { recursive: true });
  await writeFile(join(root, 'data', 'features.json'), JSON.stringify({
    hearing, ambient: false, voice: true, avatar: false, subtitle: false, memory: false, fastpath: false,
  }));
  await writeFile(join(root, 'data', 'settings.json'), JSON.stringify({
    gptSovits: { enabled: false },
    langs: { speech: 'zh', subtitle: 'zh' },
    typedReply: { voice: true },
    voice: { chunking: false },
  }));
  state.players = [];
  state.synth = [];
  state.stops = 0;
  state.hearingOnUpdate = null;
  state.hearingStarted = 0;

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
    webServer: { register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path); } },
  };
  apply({
    effect,
    on,
    get: () => undefined,
    tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name); } },
    inject: (_deps, register) => register(scope),
  }, { root, enabled: true });

  const session = { id: 'voice-input-interrupt-session', header: { cwd: join(root, 'workspace') } };
  const emit = (event) => {
    for (const entry of [...handlers]) if (entry.type === 'session/event') entry.handler(session, event);
  };
  const callRoute = async (path, { method = 'POST', body = undefined } = {}) => {
    const handler = routes.get(path);
    assert.equal(typeof handler, 'function', `the ${path} route is registered`);
    let result;
    await handler(
      Object.assign(Readable.from([JSON.stringify(body ?? {})]), { method, url: path }),
      { writeHead() {}, end(value) { result = value; } },
    );
    return typeof result === 'string' ? JSON.parse(result) : result;
  };
  const action = (body) => callRoute('/assistant/action', { body });
  const status = () => callRoute('/assistant/status', { method: 'GET' });
  const events = () => readEvents(root);
  const driveTypedTurn = (turn, text) => {
    emit(startEvent(turn));
    emit(userEvent(turn, text));
    emit(assistantEvent(turn, text));
    emit(endEvent(turn));
  };
  const players = () => state.players;
  const waitForPlayer = async (count, label = `player ${count}`) => waitUntil(
    () => players().length >= count,
    label,
  ).then(() => players()[count - 1]);
  t.after(async () => {
    for (const player of [...state.players]) player.resolve();
    await disposeAll(cleanups.splice(0));
    await cleanupRoot(root);
  });
  return {
    root, session, emit, action, status, events, driveTypedTurn, players, waitForPlayer,
    say: (args, exec) => tools.get('assistant_say').execute(args, exec),
    listen: (args) => tools.get('assistant_listen').execute(args),
  };
}

const playerOrder = (players) => players.map((player, index) => ({
  index: index + 1,
  createdAt: player.createdAt,
  resolvedAt: player.resolvedAt,
  stopped: player.stopped,
  aborted: player.aborted,
}));

// ---------------------------------------------------------------------------
// 1. Default true: the next typed input cancels the sounding reply (historical behavior)
// ---------------------------------------------------------------------------

test('1. default true: a typed user message cuts the sounding reply', async (t) => {
  const app = await mount(t);
  assert.equal((await app.status()).voiceInputInterruptsReply, true, 'missing setting reads as true');

  app.driveTypedTurn(1, '第一轮正式回复。');
  const first = await app.waitForPlayer(1);
  assert.equal(first.stopped, false, 'the old clip is sounding before the input');

  app.emit(startEvent(2));
  app.emit(userEvent(2, '第二轮问题。'));
  await waitUntil(() => first.stopped === true || first.aborted === true, 'the old clip was cut');
  await waitUntil(async () => (await app.events()).some((event) => (
    event.type === 'speech.cancelled' || event.type === 'voice.speech.cancelled'
  )), 'the interruption is recorded as a speech cancellation');

  app.emit(assistantEvent(2, '第二轮正式回复。'));
  app.emit(endEvent(2));
  const second = await app.waitForPlayer(2);
  second.resolve();
  await waitUntil(async () => (await app.events()).some(
    (event) => event.type === 'voice.typed.spoken' && event.payload?.turn === 2,
  ), 'the new reply still speaks');
  t.diagnostic(`default=true: player1 stopped=${first.stopped} aborted=${first.aborted}; player2 spoken=true`);
});

// ---------------------------------------------------------------------------
// 2. false: the old clip is never cut; the next reply waits for its natural end
// ---------------------------------------------------------------------------

test('2. false: the old reply finishes first, then the next reply plays with no overlap', async (t) => {
  const app = await mount(t);
  assert.equal((await app.action({ action: 'voice.inputInterruptsReply', enabled: false })).ok, true);

  app.driveTypedTurn(1, '旧回复第一句。');
  const first = await app.waitForPlayer(1);
  // Let the old typed round really own the clip before the next input arrives.
  await sleep(30);
  assert.equal(first.stopped, false);

  app.driveTypedTurn(2, '新回复第一句。');
  await sleep(120);
  assert.equal(app.players().length, 1, 'the new reply did not start while the old clip sounded');
  assert.equal(first.stopped, false, 'the old clip was not stopped by the input');
  assert.equal(first.aborted, false, 'the old clip signal was not aborted by the input');

  const rowsBefore = await app.events();
  assert.equal(rowsBefore.some((event) => event.type === 'speech.cancelled'
    && event.payload?.reason === 'user-input'), false,
  'no user-input cancellation was written');

  first.resolve();
  const second = await app.waitForPlayer(2);
  assert.ok(second.createdAt >= first.resolvedAt,
    `the new clip started only after the old clip ended (${second.createdAt} >= ${first.resolvedAt})`);
  assert.equal(app.players().filter((player) => player.resolvedAt === 0).length, 1,
    'exactly one clip is audible at a time');
  second.resolve();
  await waitUntil(async () => (await app.events()).some(
    (event) => event.type === 'voice.typed.spoken' && event.payload?.turn === 2,
  ), 'the queued reply still speaks');
  t.diagnostic(`false order=${JSON.stringify(playerOrder([first, second]))}`);
});

// ---------------------------------------------------------------------------
// 2b. false: the old reply's own remaining sentence goes first, the new reply after it
// ---------------------------------------------------------------------------

test('2b. false: the old reply finishes its remaining sentence before the new reply starts', async (t) => {
  const app = await mount(t);
  assert.equal((await app.action({ action: 'voice.inputInterruptsReply', enabled: false })).ok, true);
  const textOf = (player) => {
    const match = /-(\d+)\.mp3$/u.exec(player.file);
    return match === null ? '' : state.synth[Number(match[1]) - 1] ?? '';
  };

  app.driveTypedTurn(1, '旧回复第一句。旧回复第二句。');
  const first = await app.waitForPlayer(1);
  app.driveTypedTurn(2, '新回复第一句。');
  await sleep(120);
  assert.equal(app.players().length, 1, 'the old second sentence is queued behind the first, not cut');

  first.resolve();
  const second = await app.waitForPlayer(2);
  assert.match(textOf(second), /旧回复第二句/u, 'the old reply keeps its own next sentence first');
  await sleep(80);
  assert.equal(app.players().length, 2, 'the new reply still waits for the old reply to finish');
  second.resolve();
  const third = await app.waitForPlayer(3);
  assert.match(textOf(third), /新回复第一句/u, 'the queued new reply plays after the whole old reply');
  third.resolve();
  t.diagnostic(`false multi-sentence order=${state.synth.map((text, index) => `${index + 1}:${text}`).join(' | ')}`);
});

// ---------------------------------------------------------------------------
// 3. false: an already playing standalone / proactive-like line is not cut either
// ---------------------------------------------------------------------------

test('3. false: a sounding standalone line is not cut and the typed reply queues behind it', async (t) => {
  const app = await mount(t);
  assert.equal((await app.action({ action: 'voice.inputInterruptsReply', enabled: false })).ok, true);

  const say = await app.say({ text: '主动回应的一句。', purpose: 'explicit' }, { agent: { session: app.session } });
  assert.equal(say.accepted, true);
  const line = await app.waitForPlayer(1);

  app.driveTypedTurn(1, '用户随后说的一句话。');
  await sleep(120);
  assert.equal(app.players().length, 1, 'the reply is queued behind the standalone line');
  assert.equal(line.stopped, false, 'the standalone line keeps playing');
  assert.equal(line.aborted, false);

  line.resolve();
  const reply = await app.waitForPlayer(2);
  assert.ok(reply.createdAt >= line.resolvedAt, 'the reply starts only after the standalone line ends');
  reply.resolve();
  t.diagnostic(`false standalone: line stopped=${line.stopped}; reply queued=${reply.createdAt >= line.resolvedAt}`);
});

// ---------------------------------------------------------------------------
// 4. false: a voice final is still accepted/processed and does not cut playback
// ---------------------------------------------------------------------------

test('4. false: a verified voice final is delivered without stopping the sounding reply', async (t) => {
  const app = await mount(t, { hearing: true });
  assert.equal((await app.action({ action: 'voice.inputInterruptsReply', enabled: false })).ok, true);

  // Build a sounding reply first (the real typed lane, same playback seat as the voice reply).
  app.driveTypedTurn(1, '正在播放的旧回复。');
  const old = await app.waitForPlayer(1);

  const started = await app.listen({ action: 'start' });
  assert.equal(started.ok, true, `hearing starts (${started.error ?? ''})`);
  assert.equal(typeof state.hearingOnUpdate, 'function');

  const result = state.hearingOnUpdate({ final: '我也有话说', durationMs: 420 });
  assert.notEqual(result?.accepted, false, 'the final is not refused by the barge-in gate');
  await waitUntil(async () => (await app.events()).some(
    (event) => event.type === 'hearing.bargein.deferred',
  ), 'the final is deferred, not treated as an interruption');
  assert.equal(old.stopped, false, 'the sounding reply was not cut');
  assert.equal(old.aborted, false);

  // The transcript reaches the delivery path (processed input), while the old clip still sounds.
  await waitUntil(async () => (await app.events()).some(
    (event) => event.type === 'voice.transcript'
      && String(event.payload?.text ?? '').includes('我也有话说'),
  ), 'the voice transcript was processed');
  assert.equal(old.stopped, false, 'processing the input did not stop the old clip');

  old.resolve();
  t.diagnostic(`false voice: deferred=true transcript=true oldStopped=${old.stopped} hearingStarts=${state.hearingStarted}`);
});

// ---------------------------------------------------------------------------
// 5. Explicit stops ignore the setting and stop at once
// ---------------------------------------------------------------------------

test('5. explicit mute / component switch / feature disable still stop immediately', async (t) => {
  const mountOne = async () => {
    const app = await mount(t);
    assert.equal((await app.action({ action: 'voice.inputInterruptsReply', enabled: false })).ok, true);
    app.driveTypedTurn(1, '要被显式停掉的一句。');
    const player = await app.waitForPlayer(1);
    return { app, player };
  };

  const mute = await mountOne();
  assert.equal((await mute.app.action({ action: 'voice.mute', muted: true })).ok, true);
  await waitUntil(() => mute.player.stopped === true, 'mute stopped the clip immediately');

  const playback = await mountOne();
  assert.equal((await playback.app.action({ action: 'voice.playback', enabled: false })).ok, true);
  await waitUntil(() => playback.player.stopped === true, 'playback disable stopped the clip immediately');

  const feature = await mountOne();
  assert.equal((await feature.app.action({ action: 'feature.set', id: 'voice', enabled: false })).ok, true);
  await waitUntil(() => feature.player.stopped === true, 'feature disable stopped the clip immediately');

  t.diagnostic(`explicit stops: mute=${mute.player.stopped} playback=${playback.player.stopped} feature=${feature.player.stopped}`);
});

// ---------------------------------------------------------------------------
// 6. Settings: persistence, invalid values, status and the card controls
// ---------------------------------------------------------------------------

test('6. setting persists in settings.voice, rejects non-booleans and is read by status/client', async (t) => {
  const app = await mount(t);
  assert.equal((await app.status()).voiceInputInterruptsReply, true, 'default is true');

  const off = await app.action({ action: 'voice.inputInterruptsReply', enabled: false });
  assert.deepEqual(off, { ok: true, inputInterruptsReply: false, enabled: false });
  const saved = JSON.parse(await readFile(join(app.root, 'data', 'settings.json'), 'utf8'));
  assert.equal(saved.voice.inputInterruptsReply, false);
  assert.equal(saved.voice.chunking, false, 'other settings.voice fields are preserved');
  assert.equal((await app.status()).voiceInputInterruptsReply, false, 'status reads the persisted value');

  // Invalid values do not write and do not flip the persisted state.
  for (const body of [
    { action: 'voice.inputInterruptsReply', enabled: 'false' },
    { action: 'voice.inputInterruptsReply', enabled: 0 },
    { action: 'voice.inputInterruptsReply' },
  ]) {
    const result = await app.action(body);
    assert.equal(result.ok, false, `rejects ${JSON.stringify(body)}`);
    assert.match(String(result.error), /布尔/u);
  }
  const afterInvalid = JSON.parse(await readFile(join(app.root, 'data', 'settings.json'), 'utf8'));
  assert.equal(afterInvalid.voice.inputInterruptsReply, false, 'invalid values leave the setting untouched');
  assert.equal((await app.status()).voiceInputInterruptsReply, false);

  // The shipped card: label, boolean action, status-backed current value, act() reload (rollback).
  const client = await readFile(new URL('../client.js', import.meta.url), 'utf8');
  assert.match(client, /用户输入时打断当前回复/u);
  assert.match(client, /action: 'voice\.inputInterruptsReply'/u);
  assert.match(client, /enabled: !inputInterrupts/u);
  assert.match(client, /const inputInterrupts = status\.voiceInputInterruptsReply !== false/u);
  assert.match(client, /await act\(\{[\s\S]{0,160}?action: 'voice\.inputInterruptsReply'[\s\S]{0,160}?enabled: !inputInterrupts/u);
  // act() always reloads /assistant/status in its finally path (the old value comes back on failure).
  assert.match(client, /const act = useCallback\([\s\S]{0,1200}?await load\(\);[\s\S]{0,240}?finally \{/u);
  t.diagnostic(`settings: persisted=false otherVoiceField=${saved.voice.chunking} invalid=true client=wired`);
});
