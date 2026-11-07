/** A4 host ownership: fake TTS/overlay only, no network, sound, capture or GUI. */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { registerHooks } from 'node:module';
import { Readable } from 'node:stream';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupRoot, disposeAll } from './helpers/cleanup.mjs';

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until `check` is truthy; a lifecycle step is only observable after the background run. */
const waitUntil = async (check, message, timeoutMs = 3000) => {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out: ${message}`);
    await tick(5);
  }
};

/** The host log is the observable event stream: speech.* rows carry their speechId. */
const readEvents = async (root) => {
  try {
    const text = await readFile(join(root, 'data', 'events.jsonl'), 'utf8');
    return text.trim().split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
};

const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const state = { synth: null, stream: null, players: [], subtitles: [], stops: 0, ffplay: null };
globalThis.__voiceOutputLifecycle = state;
const ttsUrl = new URL('../src/host/speech/tts.js', import.meta.url).href;
const sightUrl = new URL('../src/host/vision/sight.js', import.meta.url).href;
const subtitleUrl = new URL('../src/host/subtitle/subtitle.js', import.meta.url).href;
const hooks = registerHooks({ load(url, context, next) {
  if (url === ttsUrl) return { format: 'module', shortCircuit: true, source: `
    const s = globalThis.__voiceOutputLifecycle;
    export { resolveGptLangs, resolveGptSovitsTimeout } from '${ttsUrl}?lifecycle-helpers';
    export const configureTts = () => {};
    export const gptSovitsReferenceStatus = async () => ({ seconds: null, ok: false, readable: false });
    export const warmupGptSovits = async () => ({ ok: false, skipped: 'disabled' });
    export const applyGptSovitsModels = () => s.applyModels();
    export const synthesize = (o) => s.synth(o);
    export const speakStreaming = (o) => s.stream(o);
    export const stopPlayback = () => { s.stops++; return true; };
    export const stopTts = () => { s.stops++; return true; };
    export const play = (file, options) => {
      let resolve; const done = new Promise(r => { resolve = r; });
      s.players.push({ file, ...options, resolve });
      // Like the real players, report the transport start: the caption follows this, not synthesis.
      options?.onStart?.({ startedAt: Date.now() });
      return done;
    };` };
  if (url === sightUrl) return { format: 'module', shortCircuit: true, source: `
    const forbidden = () => { throw new Error('real capture forbidden'); };
    export const resolveFfmpeg = () => null;
    export const resolveFfplay = () => globalThis.__voiceOutputLifecycle.ffplay;
    export const capture = forbidden, captureDesktop = forbidden, captureDevice = forbidden, startStoryboard = forbidden;
    export const OBSERVATION_TTL_MS = 30000;
    export function readObservation(observation, { now = Date.now(), ttlMs = 30000 } = {}) {
      const value = observation ?? {};
      const captured = Number(value.capturedAt);
      const stored = Number.isFinite(captured) && captured > 0 ? captured : Number(value.at);
      const at = Number.isFinite(stored) && stored > 0 ? stored : null;
      const ageMs = at === null ? null : Math.max(0, now - at);
      const stale = ageMs === null || ageMs >= ttlMs;
      return { ...value, at, ageMs, stale, hint: stale ? 'stale' : '' };
    }` };
  if (url === subtitleUrl) return { format: 'module', shortCircuit: true, source: `
    export const averageColor = async () => null;
    export class SubtitleOverlay {
      constructor({ config }) { this.config = config; }
      async show(text) { globalThis.__voiceOutputLifecycle.subtitles.push(text); }
      async hide() {}
      async stop() {}
    }` };
  if (url === 'node:child_process') return { format: 'module', shortCircuit: true, source: `
    export const spawn = () => { throw new Error('real process forbidden'); };
    export const execFile = () => { throw new Error('real process forbidden'); };` };
  return next(url, context);
} });
const { apply, cancelSpeech, waitSpeech } = await import('../src/host/index.js');
hooks.deregister();
after(() => { delete globalThis.__voiceOutputLifecycle; });

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-voice-lifecycle-'));
  await mkdir(join(root, 'data'), { recursive: true });
  await writeFile(join(root, 'data', 'features.json'), JSON.stringify({ hearing: false, ambient: false, subtitle: true }));
  await writeFile(join(root, 'data', 'settings.json'), JSON.stringify({
    gptSovits: { enabled: false }, subtitle: { enabled: true, mode: 'region', region: { left: 0, top: 0, width: 320, height: 100 } },
  }));
  state.synth = () => assert.fail('unexpected synthesis');
  state.stream = () => assert.fail('unexpected streaming');
  state.applyModels = () => assert.fail('unexpected weight application');
  state.ffplay = null; state.players = []; state.subtitles = []; state.stops = 0;
  const tools = new Map(), routes = new Map(), cleanups = [];
  const effect = (fn) => { const cleanup = fn(); if (typeof cleanup === 'function') cleanups.push(cleanup); return cleanup; };
  apply({ effect, tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name); } },
    inject: (_deps, register) => register({ effect, systemPrompt: { section: () => () => {} },
      webServer: { register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path); } } }),
  }, { root, enabled: true });
  const say = tools.get('assistant_say').execute;
  const dispose = async () => { const failures = await disposeAll(cleanups.splice(0)); assert.deepEqual(failures, []); };
  t.after(async () => { for (const player of state.players) player.resolve(); await dispose(); await cleanupRoot(root); });
  return { root, say, dispose,
    /** True when this accepted speech ever reported `speech.play.start` (i.e. sounded). */
    everPlayed: async (speechId) => (await readEvents(root)).some(
      (event) => event.type === 'speech.play.start' && event.payload?.speechId === speechId,
    ),
    audio: (name) => ({ file: join(root, `${name}.mp3`), bytes: 16, durationMs: 1000, provider: 'edge-tts' }),
    action: async (body) => {
      let result;
      await routes.get('/assistant/action')(Object.assign(Readable.from([JSON.stringify(body)]), { method: 'POST' }),
        { writeHead() {}, end(value) { result = JSON.parse(value); } });
      return result;
    } };
}

for (const [name, disable, enable] of [
  ['mute', { action: 'voice.mute', muted: true }, { action: 'voice.mute', muted: false }],
  ['voice disable', { action: 'feature.set', id: 'voice', enabled: false }, { action: 'feature.set', id: 'voice', enabled: true }],
]) {
  test(`${name} invalidates in-flight synthesis; reenabling cannot revive it`, async (t) => {
    const app = await fixture(t), entered = deferred(), release = deferred();
    let oldSignal;
    state.synth = async ({ signal }) => { oldSignal = signal; entered.resolve(); await release.promise; return app.audio('old'); };
    const old = await app.say({ text: 'old' });
    assert.equal(old.accepted, true, 'the old line is accepted; it synthesizes in the background');
    await entered.promise;
    assert.equal((await app.action(disable)).ok, true);
    assert.equal(oldSignal.aborted, true);
    const disabled = await app.say({ text: 'disabled' });
    assert.equal(disabled.accepted, false, 'a muted/disabled lane accepts nothing');
    await app.action(enable);
    state.synth = async () => app.audio('new');
    const next = await app.say({ text: 'new' });
    assert.equal(next.accepted, true, 'the re-enabled lane accepts the new line');
    await waitUntil(() => state.players.length === 1, 'the new clip reached the player');
    await waitUntil(() => state.subtitles.length === 1, 'the new caption was published');
    release.resolve();
    const oldEnd = await waitSpeech(old.speechId, { timeoutMs: 1000 });
    assert.equal(oldEnd.status, 'cancelled', 'the invalidated line is cancelled, never finished');
    assert.equal(await app.everPlayed(old.speechId), false, 'the invalidated line never started playing');
    await waitUntil(() => app.everPlayed(next.speechId), 'the surviving line reported playback');
    assert.deepEqual(state.players.map(p => p.file), [app.audio('new').file]);
    assert.deepEqual(state.subtitles, ['new']);
  });
}

test('teardown aborts synthesis and rejects further calls through a retained tool reference', async (t) => {
  const app = await fixture(t), entered = deferred(), release = deferred();
  let signal;
  state.synth = async (o) => { signal = o.signal; entered.resolve(); await release.promise; return app.audio('old'); };
  const old = await app.say({ text: 'old' });
  assert.equal(old.accepted, true, 'the old line is accepted; it synthesizes in the background');
  await entered.promise;
  await app.dispose();
  assert.equal(signal.aborted, true);
  release.resolve();
  const oldEnd = await waitSpeech(old.speechId, { timeoutMs: 1000 });
  assert.equal(oldEnd.status, 'cancelled', 'the torn-down line is cancelled, never finished');
  assert.equal(await app.everPlayed(old.speechId), false, 'the torn-down line never started playing');
  assert.equal((await app.say({ text: 'after dispose' })).accepted, false, 'a torn-down host accepts nothing');
  assert.equal(state.players.length, 0);
});

test('mute reaches active playback; its late completion cannot cancel the replacement', async (t) => {
  const app = await fixture(t);
  state.synth = async ({ text }) => app.audio(text);
  const said = await app.say({ text: 'old' });
  assert.equal(said.accepted, true, 'the old line is accepted; it plays in the background');
  await waitUntil(() => state.players.length === 1, 'the old clip reached the player');
  const old = state.players[0];
  await app.action({ action: 'voice.mute', muted: true });
  assert.equal(old.signal.aborted, true);
  await app.action({ action: 'voice.mute', muted: false });
  const next = await app.say({ text: 'new' });
  assert.equal(next.accepted, true, 'the replacement line is accepted');
  await waitUntil(() => state.players.length === 2, 'the replacement clip reached the player');
  const replacement = state.players[1], stops = state.stops;
  old.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(replacement.signal.aborted, false);
  assert.equal(state.stops, stops);
});

test('a superseded streaming callback cannot publish its old subtitle or report playback', async (t) => {
  const app = await fixture(t), entered = deferred(), release = deferred();
  state.ffplay = 'fake-ffplay';
  let oldStart;
  const streamed = [];
  state.stream = async (options) => {
    streamed.push(options.text);
    if (options.text === 'old') { oldStart = options.onStart; entered.resolve(); await release.promise; }
    else options.onStart({ startedAt: Date.now() });
    return app.audio(options.text);
  };
  const old = await app.say({ text: 'old' });
  assert.equal(old.accepted, true, 'the old line is accepted; it streams in the background');
  await entered.promise;
  // The seat is exclusive from grant until end/cancel, even while `startedAt === 0`: no later
  // line may replace the streamed clip. An explicit cancel is what supersedes it.
  const nextQueued = app.say({ text: 'new' });
  await tick(80);
  assert.deepEqual(streamed, ['old'], 'the new line waits behind the granted stream');
  assert.equal(cancelSpeech(old.speechId, 'superseded').ok, true, 'the old stream is explicitly cancelled');
  const next = await nextQueued;
  assert.equal(next.accepted, true, 'the new line is accepted after the cancel');
  await waitUntil(() => state.subtitles.length === 1, 'the new caption was published');
  oldStart({ startedAt: Date.now() + 10000 });
  release.resolve();
  const oldEnd = await waitSpeech(old.speechId, { timeoutMs: 1000 });
  assert.equal(oldEnd.status, 'cancelled', 'the superseded line is cancelled, never finished');
  assert.equal(await app.everPlayed(old.speechId), false, 'its late start callback never reported playback');
  await waitUntil(() => app.everPlayed(next.speechId), 'the new line reported playback');
  assert.deepEqual(state.subtitles, ['new']);
});

test('a path edit during weight application stays dirty and records the actually requested paths', async (t) => {
  const app = await fixture(t), entered = deferred(), release = deferred();
  await app.action({ action: 'tts.config', models: { gptModelPath: 'old.ckpt', sovitsModelPath: 'old.pth' } });
  state.applyModels = async () => {
    entered.resolve(); await release.promise;
    return { ok: true, gpt: { ok: true, path: 'old.ckpt' }, sovits: { ok: true, path: 'old.pth' } };
  };
  const applying = app.action({ action: 'gptSovits.applyModels' });
  await entered.promise;
  await app.action({ action: 'tts.config', models: { gptModelPath: 'new.ckpt', sovitsModelPath: 'new.pth' } });
  release.resolve();
  assert.equal((await applying).modelsDirty, true);
});

test('cancelled model application returns cancellation without recording a successful apply', async (t) => {
  const app = await fixture(t);
  state.applyModels = async () => { throw new DOMException('cancelled', 'AbortError'); };
  assert.deepEqual(await app.action({ action: 'gptSovits.applyModels' }), { ok: false, cancelled: true, error: 'cancelled' });
});