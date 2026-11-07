/**
 * Host side of the subtitle generation guard (P2 wiring).
 *
 * The overlay unit tests prove the final write is refused; this test mounts the real host with a
 * fake overlay to prove the host actually claims a generation for every show/hide, passes it (and
 * a live `isCurrent`) into the publication, and that `subtitle.hide` outranks a show that is still
 * waiting. The fake overlay follows the same contract as the real one: it re-checks `isCurrent`
 * after its wait and writes nothing when the show was superseded.
 *
 * Run: node --test test/subtitle-generation-host.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupRoot } from './helpers/cleanup.mjs';

const state = {
  shows: [],
  hides: [],
  writes: [],
  gate: null,
  dropped: 0,
};
globalThis.__subtitleGenerationHost = state;

const subtitleUrl = new URL('../src/host/subtitle/subtitle.js', import.meta.url).href;
const ttsUrl = new URL('../src/host/speech/tts.js', import.meta.url).href;
const sightUrl = new URL('../src/host/vision/sight.js', import.meta.url).href;

const hooks = registerHooks({
  load(url, context, next) {
    if (url === subtitleUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
    export const averageColor = async () => null;
    export class SubtitleOverlay {
      constructor({ config }) { this.config = { ...config }; }
      async show(text, region, colors, options = {}) {
        const s = globalThis.__subtitleGenerationHost;
        s.shows.push({ text, region, colors, options });
        if (s.gate !== null) await s.gate.promise;
        if (typeof options.isCurrent === 'function' && options.isCurrent() !== true) {
          s.dropped += 1;
          return false;
        }
        s.writes.push({ mode: 'text', text });
        return true;
      }
      async hide(options = {}) {
        const s = globalThis.__subtitleGenerationHost;
        s.hides.push(options);
        s.writes.push({ mode: 'hidden' });
      }
      async stop() {}
    }`,
      };
    }
    if (url === ttsUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
    export const configureTts = () => {};
    export const gptSovitsReferenceStatus = async () => ({ seconds: null, ok: false, readable: false });
    export const warmupGptSovits = async () => ({ ok: false, skipped: 'disabled' });
    export const applyGptSovitsModels = () => ({ ok: true });
    export const synthesize = async () => { throw new Error('synthesis not expected'); };
    export const speakStreaming = async () => { throw new Error('streaming not expected'); };
    export const stopPlayback = () => true;
    export const stopTts = () => true;
    export const play = async () => {};
    export const resolveGptLangs = () => [];
    export const resolveGptSovitsTimeout = () => 1000;`,
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
    export function readObservation(o) { return { ...(o ?? {}), stale: true, hint: 'stale' }; }`,
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

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

const waitUntil = async (check, message, timeoutMs = 3000) => {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out: ${message}`);
    await tick(5);
  }
};

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

/** Mount the real plugin with a fake web server; HTTP actions are delivered through its handler. */
async function mount(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-subtitle-generation-'));
  await mkdir(join(root, 'data'), { recursive: true });
  await writeFile(join(root, 'data', 'features.json'), JSON.stringify({
    hearing: false, ambient: false, subtitle: true,
  }));
  await writeFile(join(root, 'data', 'settings.json'), JSON.stringify({
    gptSovits: { enabled: false },
    subtitle: { enabled: true, mode: 'region', region: { left: 0, top: 0, width: 320, height: 100 } },
  }));
  state.shows = [];
  state.hides = [];
  state.writes = [];
  state.gate = null;
  state.dropped = 0;

  const handlers = [];
  const cleanups = [];
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
    tools: { register: () => () => {} },
    inject: (_deps, register) => register(scope),
  }, { root, enabled: true });

  const action = routes.get('/assistant/action');
  assert.ok(action, 'the UI action route is registered');
  const callAction = (body) => new Promise((resolve, reject) => {
    const req = new EventEmitter();
    req.method = 'POST';
    req.setEncoding = () => {};
    req.destroy = () => {};
    const res = {
      writeHead() {},
      end(text) {
        try {
          resolve(JSON.parse(text || '{}'));
        } catch (error) {
          reject(error);
        }
      },
    };
    Promise.resolve(action(req, res)).catch(reject);
    req.emit('data', JSON.stringify(body));
    req.emit('end');
  });

  t.after(async () => {
    await cleanupRoot(root, cleanups.splice(0));
  });
  return { callAction };
}

test('a hide during the show outranks it: the host generation blocks the stale publication', async (t) => {
  const app = await mount(t);
  state.gate = deferred();

  const preview = app.callAction({ action: 'subtitle.preview' });
  await waitUntil(() => state.shows.length === 1, 'the overlay show started');
  const show = state.shows[0];
  assert.equal(typeof show.options.generation, 'number', 'the show carries a numeric generation');
  assert.equal(typeof show.options.isCurrent, 'function', 'the show carries the live epoch/generation check');
  assert.equal(show.options.isCurrent(), true, 'the show is current before the hide');

  const hidden = await app.callAction({ action: 'subtitle.hide' });
  assert.equal(hidden.ok, true);
  assert.equal(state.hides.length, 1, 'the hide reached the overlay');
  assert.equal(typeof state.hides[0].generation, 'number', 'the hide claims a generation');
  assert.ok(state.hides[0].generation > show.options.generation, 'the hide outranks the running show');
  assert.equal(show.options.isCurrent(), false, 'the still-waiting show is now stale');
  assert.deepEqual(state.writes.map((row) => row.mode), ['hidden'], 'the hide is the only write so far');

  state.gate.resolve(); // the show's wait ends after the hide, exactly like the probe returning
  const previewResult = await preview;

  assert.equal(state.dropped, 1, 'the fake overlay refused the stale show at its final check');
  assert.equal(previewResult.ok, false, 'showSubtitle reports that nothing was displayed');
  assert.deepEqual(state.writes.map((row) => row.mode), ['hidden'], 'no text write follows the hide');
  t.diagnostic(`host: showGeneration=${show.options.generation} hideGeneration=${state.hides[0].generation} writes=${state.writes.map((row) => row.mode).join('->')} final=${state.writes.at(-1).mode} dropped=${state.dropped} previewOk=${previewResult.ok}`);
});
