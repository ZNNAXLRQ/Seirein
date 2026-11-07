/** E1: deterministic races at the real Host tools/routes; never captures a real screen. */
import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { registerHooks } from 'node:module';
import { createServer } from 'node:net';
import { Readable } from 'node:stream';
import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventLog } from '../src/host/memory/store.js';

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const state = { capture: null, start: null, obsGate: null, calls: [], starts: 0, stops: 0 };
globalThis.__visionPrivacyTest = state;
const sightUrl = new URL('../src/host/vision/sight.js', import.meta.url).href;
const obsUrl = new URL('../src/host/vision/obs.js', import.meta.url).href;
const hooks = registerHooks({
  load(url, context, next) {
    if (url === sightUrl) return {
      format: 'module', shortCircuit: true,
      source: `const s = globalThis.__visionPrivacyTest;
        export const resolveFfmpeg = () => 'fake-ffmpeg';
        export const resolveFfplay = () => null;
        export const capture = (o) => { s.calls.push('powershell'); return s.capture(o); };
        export const captureDesktop = (o) => { s.calls.push('desktop'); return s.capture(o); };
        export const captureDevice = (o) => { s.calls.push('device'); return s.capture(o); };
        export const startStoryboard = (o) => { s.starts++; return s.start(o); };
        // Real index.js/ambient.js import the freshness helpers from sight.js:
        // the stub must export the same names even though these tests never age a frame.
        export const OBSERVATION_TTL_MS = 30000;
        export function readObservation(observation, { now = Date.now(), ttlMs = 30000 } = {}) {
          const value = observation ?? {};
          const captured = Number(value.capturedAt);
          const stored = Number.isFinite(captured) && captured > 0 ? captured : Number(value.at);
          const at = Number.isFinite(stored) && stored > 0 ? stored : null;
          const ageMs = at === null ? null : Math.max(0, now - at);
          const stale = ageMs === null || ageMs >= ttlMs;
          return { ...value, at, ageMs, stale, hint: stale ? 'stale' : '' };
        }`,
    };
    if (url === obsUrl) return {
      format: 'module', shortCircuit: true,
      source: `export async function connectObs() { return {
        async request(type) {
          const s = globalThis.__visionPrivacyTest;
          if (type === 'GetSceneList') {
            if (s.obsGate) await s.obsGate.promise;
            return { currentProgramSceneName: 'Main', scenes: [{ sceneName: 'Main' }, { sceneName: '隐私' }] };
          }
          return { outputActive: true };
        }, close() {},
      }; }`,
    };
    return next(url, context);
  },
});
const { apply } = await import('../src/host/index.js');
hooks.deregister();
const server = createServer((socket) => socket.end());
before(async () => { await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); });
after(async () => { await new Promise((resolve) => server.close(resolve)); delete globalThis.__visionPrivacyTest; });

async function fixture(t) {
  state.capture = null;
  state.start = null;
  state.obsGate = null;
  state.calls = [];
  state.starts = state.stops = 0;
  const root = await mkdtemp(join(tmpdir(), 'dsh-vision-privacy-'));
  const tools = new Map();
  const routes = new Map();
  const cleanups = [];
  const effect = (fn) => {
    const cleanup = fn();
    if (typeof cleanup === 'function') cleanups.push(cleanup);
    return cleanup;
  };
  // Delivery requires the Harness attachment service; a fake keeps capture/privacy assertions
  // independent of the real image store.
  let saved = 0;
  const attachments = {
    async saveImage({ data, mediaType, name }) {
      saved += 1;
      return { id: `att-${saved}`, mediaType, name, bytes: data.length };
    },
  };
  // The delivery gate resolves the exact calling route through `llm`, like DSH read_image.
  const llm = {
    async resolveModelInfo(provider, model) {
      return { provider, id: model, name: model, inputModalities: ['text', 'image'] };
    },
  };
  apply({
    effect,
    get: (service) => {
      if (service === 'attachments') return attachments;
      if (service === 'llm') return llm;
      return undefined;
    },
    tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name); } },
    inject: (_dependencies, register) => register({
      effect, systemPrompt: { section: () => () => {} },
      webServer: { register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path); } },
    }),
  }, { root, enabled: true, obsPort: server.address().port });
  t.after(async () => {
    state.obsGate?.resolve();
    for (const cleanup of cleanups.reverse()) await cleanup();
    // Dispose starts asynchronous log/cleanup work; let it finish before deleting the root.
    await new Promise((resolve) => setTimeout(resolve, 25));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  const route = async (path, body) => {
    let status;
    let result;
    const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
    req.method = 'POST';
    req.url = path;
    await routes.get(path.split('?')[0])(req, {
      writeHead(code) { status = code; },
      end(data) { result = data; },
    });
    return { status, data: result };
  };
  const action = async (body) => JSON.parse((await route('/assistant/action', body)).data);
  const call = (name, args) => tools.get(name).execute(args, {
    agent: {
      session: { requestHeader: () => ({ config: { provider: 'fake', model: 'vision-model' } }) },
      options: {},
    },
  });
  const makeShot = async (dir, name = 'shot.png') => {
    await mkdir(dir, { recursive: true });
    const file = join(dir, name);
    await writeFile(file, 'not a real screenshot');
    return { file, bytes: 21, width: 800, height: 450, engine: 'fake', frames: 4, from: 0, to: 1 };
  };
  const empty = async () => assert.deepEqual(await readdir(join(root, 'cache', 'screens')).catch(() => []), []);
  return { root, call, action, route, makeShot, empty };
}

test('normal desktop capture, preview, and clearing on privacy', async (t) => {
  const app = await fixture(t);
  state.capture = ({ dir }) => app.makeShot(dir);
  const shot = await app.call('assistant_see', {});
  assert.equal(shot.ok, true);
  assert.equal((await app.route(`/assistant/shot?path=${encodeURIComponent(shot.file)}`)).status, 200);
  assert.equal((await app.call('assistant_vision', { action: 'status' })).lastShot.file, shot.file);
  assert.equal((await app.action({ action: 'vision.mode', mode: 'privacy' })).ok, true);
  assert.equal((await app.call('assistant_vision', { action: 'status' })).lastShot, null);
  assert.equal((await app.route(`/assistant/shot?path=${encodeURIComponent(shot.file)}`)).status, 403);
  await app.empty();
  assert.equal((await app.call('assistant_vision', { action: 'set', mode: 'watch' })).ok, false);
});

test('privacy locks immediately while OBS is still pending; late capture is deleted', async (t) => {
  const app = await fixture(t);
  const started = deferred();
  const finish = deferred();
  let signal;
  state.capture = async (options) => {
    signal = options.signal;
    started.resolve();
    await finish.promise; // Deliberately ignores cancellation to exercise the Host's last gate.
    return app.makeShot(options.dir);
  };
  const capture = app.call('assistant_see', {});
  await started.promise;
  state.obsGate = deferred();
  const privacy = app.action({ action: 'vision.mode', mode: 'privacy' });
  // The action route must parse its body before it enters applyVisionMode.
  while (!signal.aborted) await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await app.call('assistant_see', {})).ok, false);
  assert.equal((await app.call('assistant_vision', { action: 'status' })).mode, 'privacy');
  finish.resolve();
  assert.equal((await capture).ok, false);
  assert.deepEqual(state.calls, ['desktop'], 'no PowerShell fallback on cancellation');
  await app.empty();
  state.obsGate.resolve();
  assert.equal((await privacy).ok, true);
});

test('a capture blocked in async event persistence is rejected before publication', async (t) => {
  const app = await fixture(t);
  const entered = deferred();
  const finish = deferred();
  const emit = EventLog.prototype.emit;
  t.mock.method(EventLog.prototype, 'emit', async function (type, ...args) {
    if (type === 'vision.captured') { entered.resolve(); await finish.promise; }
    return emit.call(this, type, ...args);
  });
  state.capture = ({ dir }) => app.makeShot(dir);
  const capture = app.action({ action: 'vision.snapshot' });
  await entered.promise;
  await app.action({ action: 'vision.mode', mode: 'privacy' });
  await app.action({ action: 'vision.mode', mode: 'watch' });
  finish.resolve();
  assert.equal((await capture).ok, false);
  assert.equal((await app.call('assistant_vision', { action: 'status' })).lastShot, null);
  await app.empty();
});

test('scene-mode device capture is invalidated before returning or caching a file', async (t) => {
  const app = await fixture(t);
  const scene = await app.action({ action: 'vision.mode', mode: 'scene', scene: 'Main' });
  assert.equal(
    scene.ok,
    true,
    `scene switch failed: ${scene.error || 'no error'} (mode=${scene.mode}, scene=${scene.scene ?? ''})`,
  );
  assert.equal(scene.mode, 'scene', 'the switch actually enters scene mode');
  assert.equal(scene.scene, 'Main', 'the requested scene is the active one');
  const entered = deferred();
  const finish = deferred();
  state.capture = async ({ dir }) => { entered.resolve(); await finish.promise; return app.makeShot(dir); };
  const capture = app.call('assistant_see', {});
  // Fail fast if the delivery gate refuses before the scene device is touched; otherwise this
  // test would wait forever on `entered` and report only a timeout.
  let earlyResult;
  let earlyError;
  const first = await Promise.race([
    entered.promise.then(() => 'entered'),
    capture.then(
      (value) => { earlyResult = value; return 'returned'; },
      (error) => { earlyError = error; return 'returned'; },
    ),
  ]);
  if (first === 'returned') {
    assert.fail(
      `scene capture returned before captureDevice: reason="${earlyError?.message ?? earlyResult?.reason ?? 'unknown'}"`
      + `; captureCalls=[${state.calls.join(',')}]`,
    );
  }
  await app.action({ action: 'vision.mode', mode: 'privacy' });
  finish.resolve();
  assert.equal((await capture).ok, false);
  assert.deepEqual(state.calls, ['device']);
  await app.empty();
  t.diagnostic(`scene-mode: expected ok=true; actual ok=${scene.ok}; captureDevice=${state.calls.filter((call) => call === 'device').length}`);
});

function fakeSession(take = async () => null) {
  const done = deferred();
  let stopped = false;
  return {
    engine: 'fake', sourceKind: 'screen', take,
    stats: () => ({ frames: 8, sheets: 1, engine: 'fake' }),
    stop() { if (!stopped) { stopped = true; state.stops++; done.resolve(); } },
    done: done.promise,
  };
}

test('concurrent starts join; a late start after privacy cannot resurrect watcher', async (t) => {
  const app = await fixture(t);
  const entered = deferred();
  const finish = deferred();
  state.start = async () => { entered.resolve(); await finish.promise; return fakeSession(); };
  const first = app.call('assistant_watch', { action: 'start' });
  await entered.promise;
  const second = app.call('assistant_watch', { action: 'start' });
  await app.action({ action: 'vision.mode', mode: 'privacy' });
  finish.resolve();
  assert.equal((await first).ok, false);
  assert.equal((await second).ok, false);
  assert.equal(state.starts, 1);
  assert.equal(state.stops, 1);
  assert.equal((await app.call('assistant_watch', { action: 'status' })).running, false);
});

test('in-flight storyboard take is discarded as a whole after privacy', async (t) => {
  const app = await fixture(t);
  const entered = deferred();
  const finish = deferred();
  state.start = async ({ dir }) => fakeSession(async () => {
    entered.resolve(); await finish.promise;
    return app.makeShot(dir, 'sheet.png');
  });
  assert.equal((await app.call('assistant_watch', { action: 'start' })).ok, true);
  const take = app.call('assistant_watch', { action: 'take' });
  await entered.promise;
  await app.action({ action: 'vision.mode', mode: 'privacy' });
  finish.resolve();
  const result = await take;
  assert.equal(result.ok, false);
  assert.equal(result.ready, false);
  assert.equal(result.file, '');
  await app.empty();
});

test('a normal storyboard supports concurrent start, take and stop without duplicate capture', async (t) => {
  const app = await fixture(t);
  state.start = async ({ dir }) => fakeSession(() => app.makeShot(dir, 'sheet.png'));
  const starts = await Promise.all([
    app.call('assistant_watch', { action: 'start' }), app.call('assistant_watch', { action: 'start' }),
  ]);
  assert.ok(starts.every((result) => result.ok));
  assert.equal(state.starts, 1);
  const sheet = await app.call('assistant_watch', { action: 'take' });
  assert.equal(sheet.ok, true);
  assert.equal(sheet.ready, true);
  assert.equal((await app.route(`/assistant/shot?path=${encodeURIComponent(sheet.file)}`)).status, 200);
  await app.call('assistant_watch', { action: 'stop' });
  assert.equal(state.stops, 1);
  await app.empty();
});

test('review P2: three concurrent starts share one retry after the first startup fails', async (t) => {
  const app = await fixture(t);
  const entered = deferred();
  const failFirst = deferred();
  const retryEntered = deferred();
  const finishRetry = deferred();
  const sessions = [];
  t.after(() => { for (const session of sessions) session.stop(); });
  state.start = async () => {
    if (state.starts === 1) {
      entered.resolve();
      await failFirst.promise;
      throw new Error('first startup failed');
    }
    const session = fakeSession();
    sessions.push(session);
    retryEntered.resolve();
    await finishRetry.promise;
    return session;
  };
  const first = app.call('assistant_watch', { action: 'start' });
  await entered.promise;
  const waiters = [app.call('assistant_watch', { action: 'start' }), app.call('assistant_watch', { action: 'start' })];
  await new Promise((resolve) => setImmediate(resolve));
  failFirst.resolve();
  await retryEntered.promise;
  // Hold the replacement open so every old waiter has a chance to compete for its slot.
  await new Promise((resolve) => setImmediate(resolve));
  finishRetry.resolve();
  const results = await Promise.all([first, ...waiters]);
  assert.equal(state.starts, 2, 'one failed startup plus one shared replacement');
  assert.equal(results[0].ok, false);
  assert.match(results[0].error, /first startup failed/);
  assert.ok(results.slice(1).every((result) => result.ok), 'both waiters use the successful replacement');
  assert.equal(sessions.length, 1);
  assert.equal((await app.call('assistant_watch', { action: 'status' })).running, true);
  await app.call('assistant_watch', { action: 'stop' });
  assert.equal(state.stops, 1);
});

test('review P2: concurrent new-generation retries share ownership after a stale startup fails', async (t) => {
  const app = await fixture(t);
  const entered = deferred();
  const failOld = deferred();
  const retryEntered = deferred();
  const finishRetry = deferred();
  const sessions = [];
  t.after(() => { for (const session of sessions) session.stop(); });
  let oldSignal;
  state.start = async ({ signal }) => {
    if (state.starts === 1) {
      oldSignal = signal;
      entered.resolve();
      await failOld.promise;
      throw new Error('stale startup failed');
    }
    assert.notEqual(signal, oldSignal);
    assert.equal(signal.aborted, false);
    const session = fakeSession();
    sessions.push(session);
    retryEntered.resolve();
    await finishRetry.promise;
    return session;
  };
  const old = app.call('assistant_watch', { action: 'start' });
  await entered.promise;
  const staleWaiter = app.call('assistant_watch', { action: 'start' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await app.action({ action: 'vision.mode', mode: 'privacy' })).ok, true);
  assert.equal(oldSignal.aborted, true);
  assert.equal((await app.action({ action: 'vision.mode', mode: 'watch' })).ok, true);
  const current = [app.call('assistant_watch', { action: 'start' }), app.call('assistant_watch', { action: 'start' })];
  await new Promise((resolve) => setImmediate(resolve));
  failOld.resolve();
  await retryEntered.promise;
  await new Promise((resolve) => setImmediate(resolve));
  finishRetry.resolve();
  const results = await Promise.all([old, staleWaiter, ...current]);
  assert.equal(state.starts, 2, 'the stale attempt must have only one current-generation replacement');
  assert.ok(results.slice(0, 2).every((result) => !result.ok), 'stale owners and waiters stay invalid');
  assert.ok(results.slice(2).every((result) => result.ok), 'current waiters share the replacement');
  assert.equal(sessions.length, 1);
  await app.call('assistant_watch', { action: 'stop' });
  assert.equal(state.stops, 1);
});

test('a pending user scene switch cannot unlock a later privacy request', async (t) => {
  const app = await fixture(t);
  state.obsGate = deferred();
  const scene = app.action({ action: 'vision.mode', mode: 'scene', scene: 'Main' });
  // Let the scene transition reach its pending GetSceneList request.
  await new Promise((resolve) => setTimeout(resolve, 10));
  const privacy = app.action({ action: 'vision.mode', mode: 'privacy' });
  while ((await app.call('assistant_vision', { action: 'status' })).mode !== 'privacy') {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal((await app.call('assistant_see', {})).ok, false);
  state.obsGate.resolve();
  assert.equal((await scene).ok, false);
  assert.equal((await privacy).ok, true);
  assert.equal((await app.call('assistant_vision', { action: 'status' })).mode, 'privacy');
});

test('100 privacy round trips never revive old captures or leave files', async (t) => {
  const app = await fixture(t);
  for (let i = 0; i < 100; i++) {
    const entered = deferred();
    const finish = deferred();
    state.capture = async ({ dir }) => { entered.resolve(); await finish.promise; return app.makeShot(dir); };
    const capture = app.call('assistant_see', {});
    await entered.promise;
    assert.equal((await app.action({ action: 'vision.mode', mode: 'privacy' })).ok, true);
    assert.equal((await app.action({ action: 'vision.mode', mode: 'watch' })).ok, true);
    finish.resolve();
    assert.equal((await capture).ok, false, `old capture ${i} rejected after unlock`);
    await app.empty();
  }
  state.capture = ({ dir }) => app.makeShot(dir);
  assert.equal((await app.call('assistant_see', {})).ok, true, 'normal capture recovers');
});