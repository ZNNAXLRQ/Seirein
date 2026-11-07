/**
 * Playback end: the player process is the real end signal, the duration estimate is only a
 * watchdog. Regression for "the next sentence starts while the previous clip is still sounding"
 * and for "a watchdog timeout is released as a normal end".
 *
 * The tts module is replaced with a scripted player so every scenario is deterministic:
 *   - a "process" handle (the promise that settles when the child closes), or
 *   - no handle at all (the estimate-plus-margin watchdog is then only a stall guard).
 * `stopPlayback` simulates the real kill: it resolves the child's exit only when the test's
 * `confirmKill` says the process is actually confirmed gone.
 *
 * Run: node --test test/playback-end.mjs
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { registerHooks } from 'node:module';
import { Readable } from 'node:stream';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupRoot, disposeAll } from './helpers/cleanup.mjs';

const state = { stream: null, synth: null, clips: [], timers: [], kills: [], confirmKill: true, stopPlayback: null };
globalThis.__playbackEnd = state;

const ttsUrl = new URL('../src/host/speech/tts.js', import.meta.url).href;
const sightUrl = new URL('../src/host/vision/sight.js', import.meta.url).href;
const subtitleUrl = new URL('../src/host/subtitle/subtitle.js', import.meta.url).href;
const hooks = registerHooks({ load(url, context, next) {
  if (url === ttsUrl) return { format: 'module', shortCircuit: true, source: `
    const s = globalThis.__playbackEnd;
    export { resolveGptLangs, resolveGptSovitsTimeout } from '${ttsUrl}?playback-end-helpers';
    export const configureTts = () => {};
    export const gptSovitsReferenceStatus = async () => ({ seconds: null, ok: false, readable: false });
    export const warmupGptSovits = async () => ({ ok: false, skipped: 'disabled' });
    export const applyGptSovitsModels = () => ({ ok: true });
    export const synthesize = (o) => s.synth(o);
    export const speakStreaming = (o) => s.stream(o);
    export const play = (file, options) => {
      let resolve; const done = new Promise((doneResolve) => { resolve = doneResolve; });
      s.clips.push({ file, startedAt: Date.now(), endedAt: 0, exit: done, resolve });
      options?.onStart?.({ startedAt: Date.now() });
      return done;
    };
    export const stopPlayback = () => s.stopPlayback();
    export const stopTts = () => true;` };
  if (url === sightUrl) return { format: 'module', shortCircuit: true, source: `
    const forbidden = () => { throw new Error('real capture forbidden'); };
    export const resolveFfmpeg = () => null;
    export const resolveFfplay = () => 'fake-ffplay';
    export const capture = forbidden, captureDesktop = forbidden, captureDevice = forbidden, startStoryboard = forbidden;
    export const OBSERVATION_TTL_MS = 30000;
    export function readObservation(o, { now = Date.now(), ttlMs = 30000 } = {}) {
      const v = o ?? {}; const c = Number(v.capturedAt); const s = Number.isFinite(c) && c > 0 ? c : Number(v.at);
      const at = Number.isFinite(s) && s > 0 ? s : null;
      const ageMs = at === null ? null : Math.max(0, now - at);
      return { ...v, at, ageMs, stale: ageMs === null || ageMs >= ttlMs, hint: '' };
    }` };
  if (url === subtitleUrl) return { format: 'module', shortCircuit: true, source: `
    export const averageColor = async () => null;
    export class SubtitleOverlay {
      constructor({ config }) { this.config = config; }
      async show() {}
      async hide() {}
      async stop() {}
    }` };
  if (url === 'node:child_process') return { format: 'module', shortCircuit: true, source: `
    export const spawn = () => { throw new Error('real process forbidden'); };
    export const execFile = () => { throw new Error('real process forbidden'); };` };
  return next(url, context);
} });
const { apply } = await import('../src/host/index.js');
hooks.deregister();
after(() => { delete globalThis.__playbackEnd; });

const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(check, message, timeoutMs = 6000) {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out: ${message}`);
    await tick(10);
  }
}

const readEvents = async (root) => {
  try {
    const text = await readFile(join(root, 'data', 'events.jsonl'), 'utf8');
    return text.trim().split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
};

/**
 * One scripted streaming clip. `actualMs` is when the player process closes; the returned result
 * carries `estimatedMs` as the TTS duration estimate. `handle:false` models a player without a
 * usable process handle (system player), where the watchdog is only a stall guard.
 */
function startClip(options, root, { estimatedMs, actualMs, handle = true }) {
  const clip = { text: options.text, startedAt: Date.now(), endedAt: 0, estimatedMs, exit: null };
  let settle;
  clip.exit = new Promise((resolve) => { settle = resolve; });
  clip.resolve = () => {
    if (clip.endedAt === 0) clip.endedAt = Date.now();
    if (state.active === clip) state.active = null; // the player is gone: nothing left to kill
    settle();
  };
  state.clips.push(clip);
  state.active = clip;
  options.onStart?.({ startedAt: clip.startedAt });
  if (handle) options.onTransport?.({ exit: clip.exit, via: 'ffplay-stream' });
  const timer = setTimeout(() => clip.resolve(), actualMs);
  timer.unref?.();
  state.timers.push(timer);
  return {
    file: join(root, `clip-${state.clips.length}.mp3`),
    bytes: 16,
    durationMs: estimatedMs,
    firstChunkMs: 0,
    via: 'ffplay-stream',
    provider: 'edge-tts',
  };
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-playback-end-'));
  await mkdir(join(root, 'data'), { recursive: true });
  await writeFile(join(root, 'data', 'features.json'), JSON.stringify({ hearing: false, ambient: false, subtitle: false }));
  await writeFile(join(root, 'data', 'settings.json'), JSON.stringify({ gptSovits: { enabled: false } }));
  state.stream = () => assert.fail('unexpected streaming');
  state.synth = () => assert.fail('unexpected synthesis');
  state.clips = [];
  state.timers = [];
  state.kills = [];
  state.active = null;
  state.confirmKill = true;
  // The real tts `stopPlayback` kills the player and its close proves the exit. When a test sets
  // `confirmKill:false` the kill is issued but the exit never comes — the unconfirmed case.
  state.stopPlayback = () => {
    const clip = state.active ?? null;
    if (clip === null) return false;
    state.kills.push(clip);
    if (state.confirmKill) clip.resolve();
    return true;
  };
  const tools = new Map(), routes = new Map(), cleanups = [];
  const effect = (fn) => { const cleanup = fn(); if (typeof cleanup === 'function') cleanups.push(cleanup); return cleanup; };
  apply({
    effect,
    tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name); } },
    inject: (_deps, register) => register({
      effect,
      systemPrompt: { section: () => () => {} },
      webServer: { register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path); } },
    }),
  }, { root, enabled: true });
  const dispose = async () => {
    const failures = await disposeAll(cleanups.splice(0));
    assert.deepEqual(failures, []);
  };
  t.after(async () => {
    for (const timer of state.timers) clearTimeout(timer);
    for (const clip of state.clips) clip.resolve?.();
    await tick(10);
    await dispose();
    await cleanupRoot(root);
  });
  return {
    root,
    say: (args) => tools.get('assistant_say').execute(args),
    events: () => readEvents(root),
    waitForEvent: async (type, predicate = () => true, timeoutMs = 6000) => {
      const row = await waitUntil(
        async () => (await readEvents(root)).find((event) => event.type === type && predicate(event.payload ?? {})),
        `event ${type}`,
        timeoutMs,
      );
      return row.payload ?? {};
    },
    action: async (body) => {
      let result;
      await routes.get('/assistant/action')(
        Object.assign(Readable.from([JSON.stringify(body)]), { method: 'POST' }),
        { writeHead() {}, end(value) { result = JSON.parse(value); } },
      );
      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// 1. Process exit later than the estimate: the process wins, no early end
// ---------------------------------------------------------------------------

test('1. a player that exits later than the estimate ends the clip, not the timer', async (t) => {
  const app = await fixture(t);
  state.stream = (options) => startClip(options, app.root, { estimatedMs: 1000, actualMs: 1800 });
  const beganAt = Date.now();
  assert.equal((await app.say({ text: '第一句。' })).accepted, true);
  const end = await app.waitForEvent('voice.playback.end');
  const observedAt = Date.now();
  assert.equal(end.estimatedMs, 1000);
  assert.equal(end.source, 'process', 'the process exit is the recorded end source');
  assert.equal(end.confirmed, true, 'a real process exit is confirmed');
  assert.equal(end.endReason, 'end', 'a proven process exit is a normal end');
  assert.ok(end.actualMs >= 1700 && end.actualMs <= 2200, `actualMs≈1800, got ${end.actualMs}`);
  assert.ok(observedAt - beganAt >= 1700, 'the clip was not marked ended at estimate+200');
  assert.equal(state.clips[0].endedAt > 0, true, 'the scripted process really closed');
  const skew = await app.waitForEvent('voice.playback.skew');
  assert.equal(skew.deltaMs, end.actualMs - end.estimatedMs);
  assert.ok(skew.deltaMs > 500, `skew records the late exit, got ${skew.deltaMs}`);
  t.diagnostic(`estimated=${end.estimatedMs}ms actual=${end.actualMs}ms source=${end.source} skew=${skew.deltaMs}ms`);
});

// ---------------------------------------------------------------------------
// 2. Process exit earlier than the estimate: end at the exit, not at the estimate
// ---------------------------------------------------------------------------

test('2. a player that exits earlier than the estimate ends immediately', async (t) => {
  const app = await fixture(t);
  state.stream = (options) => startClip(options, app.root, { estimatedMs: 2000, actualMs: 1200 });
  const beganAt = Date.now();
  assert.equal((await app.say({ text: '第二句。' })).accepted, true);
  const end = await app.waitForEvent('voice.playback.end');
  assert.equal(end.estimatedMs, 2000);
  assert.equal(end.source, 'process');
  assert.equal(end.confirmed, true);
  assert.equal(end.endReason, 'end');
  assert.ok(end.actualMs >= 1100 && end.actualMs <= 1600, `actualMs≈1200, got ${end.actualMs}`);
  assert.ok(Date.now() - beganAt < 1900, 'the clip did not wait for the 2000ms estimate');
  t.diagnostic(`estimated=${end.estimatedMs}ms actual=${end.actualMs}ms source=${end.source}`);
});

// ---------------------------------------------------------------------------
// 3. Watchdog expiry kills the player and proves the exit: reason 'watchdog'
// ---------------------------------------------------------------------------

test('3. a stalled player is killed by the watchdog and confirmed gone', async (t) => {
  const app = await fixture(t);
  state.stream = (options) => startClip(options, app.root, { estimatedMs: 1000, actualMs: 60_000 });
  const beganAt = Date.now();
  assert.equal((await app.say({ text: '卡住的一句。' })).accepted, true);
  await waitUntil(() => state.clips.length === 1, 'the clip reached the player');
  const end = await app.waitForEvent('voice.playback.end', () => true, 12_000);
  const observedAt = Date.now();
  assert.equal(end.source, 'watchdog', 'the watchdog owns a stalled end');
  assert.equal(end.confirmed, true, 'the kill was followed by a proven process exit');
  assert.equal(end.endReason, 'watchdog', 'a confirmed stall is not a normal end');
  assert.ok(observedAt - beganAt >= 4800, `watchdog fired at ~${observedAt - beganAt}ms, before the 5000ms guard`);
  assert.equal(state.kills.length, 1, 'the player was killed exactly once');
  assert.equal(state.clips[0].endedAt > 0, true, 'the player process really closed');
  const stalled = await app.waitForEvent('voice.playback.stalled');
  assert.equal(stalled.killed, true);
  assert.equal(stalled.confirmed, true);
  t.diagnostic(`estimated=${end.estimatedMs}ms actual=${end.actualMs}ms source=${end.source} `
    + `confirmed=${end.confirmed} reason=${end.endReason} kills=${state.kills.length} stalled=${stalled.confirmed}`);
});

// ---------------------------------------------------------------------------
// 3b. The kill cannot be confirmed: the session is 'failed', never a normal end
// ---------------------------------------------------------------------------

test('3b. an unconfirmed kill marks the clip failed, not ended', async (t) => {
  const app = await fixture(t);
  state.confirmKill = false; // the kill is issued, but the child never reports its exit
  state.stream = (options) => startClip(options, app.root, { estimatedMs: 1000, actualMs: 60_000 });
  assert.equal((await app.say({ text: '杀不掉的一句。' })).accepted, true);
  await waitUntil(() => state.clips.length === 1, 'the clip reached the player');
  const end = await app.waitForEvent('voice.playback.end', () => true, 12_000);
  assert.equal(end.source, 'watchdog');
  assert.equal(end.confirmed, false, 'an exit that was never observed is not a proven end');
  assert.equal(end.endReason, 'failed', 'a stalled clip without confirmation is a failure');
  assert.equal(state.kills.length, 1, 'the watchdog still issued the kill');
  assert.equal(state.clips[0].endedAt, 0, 'the player was never confirmed gone');
  const stalled = await app.waitForEvent('voice.playback.stalled');
  assert.equal(stalled.killed, true);
  assert.equal(stalled.confirmed, false);
  t.diagnostic(`estimated=${end.estimatedMs}ms actual=${end.actualMs}ms source=${end.source} `
    + `confirmed=${end.confirmed} reason=${end.endReason} kills=${state.kills.length} stalled=${stalled.confirmed}`);
});

// ---------------------------------------------------------------------------
// 3c. No process handle: the timer is a stall guard, never a normal end
// ---------------------------------------------------------------------------

test('3c. without a process handle the watchdog never reports a normal end', async (t) => {
  const app = await fixture(t);
  state.stream = (options) => startClip(options, app.root, { estimatedMs: 1000, actualMs: 60_000, handle: false });
  const beganAt = Date.now();
  assert.equal((await app.say({ text: '没有句柄的一句。' })).accepted, true);
  const end = await app.waitForEvent('voice.playback.end');
  const observedAt = Date.now();
  assert.equal(end.source, 'watchdog', 'the estimate is a guess, not a proven end');
  assert.equal(end.confirmed, false);
  assert.equal(end.endReason, 'failed', 'an unprovable end is not a normal end');
  assert.ok(observedAt - beganAt >= 1480, `watchdog fired at ~${observedAt - beganAt}ms, before estimate+500`);
  assert.ok(end.actualMs >= 1480 && end.actualMs <= 2300, `actualMs≈1500, got ${end.actualMs}`);
  const stalled = await app.waitForEvent('voice.playback.stalled');
  assert.equal(stalled.confirmed, false);
  t.diagnostic(`estimated=${end.estimatedMs}ms actual=${end.actualMs}ms source=${end.source} `
    + `confirmed=${end.confirmed} reason=${end.endReason} kills=${state.kills.length}`);
});

// ---------------------------------------------------------------------------
// 4. Two clips are serialized: the second starts only after the first ended
// ---------------------------------------------------------------------------

test('4. the second clip starts only after the first clip ended', async (t) => {
  const app = await fixture(t);
  state.stream = (options) => startClip(options, app.root, { estimatedMs: 300, actualMs: 300 });
  // Both requests arrive together; the host must not let them overlap.
  const first = app.say({ text: '第一句。' });
  const second = app.say({ text: '第二句。' });
  await Promise.all([first, second]);
  await waitUntil(async () => (await app.events()).filter((e) => e.type === 'voice.playback.end').length === 2,
    'both clips ended');
  assert.equal(state.clips.length, 2, 'two clips reached a player');
  const [a, b] = state.clips;
  assert.ok(a.endedAt > 0 && b.endedAt > 0, 'both scripted processes closed');
  assert.ok(b.startedAt >= a.endedAt, `second started ${a.endedAt - b.startedAt}ms before the first ended`);
  const ends = (await app.events()).filter((e) => e.type === 'voice.playback.end');
  assert.deepEqual(ends.map((e) => e.payload.source), ['process', 'process']);
  assert.deepEqual(ends.map((e) => e.payload.confirmed), [true, true]);
  t.diagnostic(`first start=${a.startedAt} end=${a.endedAt}; second start=${b.startedAt} end=${b.endedAt}`);
});

// ---------------------------------------------------------------------------
// 5. Explicit interruption still ends at once and records why (regression)
// ---------------------------------------------------------------------------

test('5. an explicit cancel ends the clip immediately and records the reason', async (t) => {
  const app = await fixture(t);
  state.stream = (options) => startClip(options, app.root, { estimatedMs: 5000, actualMs: 60_000 });
  assert.equal((await app.say({ text: '要打断的一句。' })).accepted, true);
  await waitUntil(() => state.clips.length === 1, 'the clip reached the player');
  const before = Date.now();
  assert.equal((await app.action({ action: 'voice.mute', muted: true })).ok, true);
  const cancelled = await app.waitForEvent('speech.cancelled');
  assert.equal(cancelled.reason, 'muted');
  assert.equal(cancelled.endReason, 'cancelled', 'an explicit cancel is its own end reason');
  assert.ok(cancelled.elapsedMs <= Date.now() - before + 500, 'the cancel landed at once');
  await tick(400);
  const ends = (await app.events()).filter((e) => e.type === 'voice.playback.end');
  assert.equal(ends.length, 0, 'a cancelled clip is not a natural end');
  t.diagnostic(`cancel reason=${cancelled.reason} endReason=${cancelled.endReason} elapsed=${cancelled.elapsedMs}ms`);
});
