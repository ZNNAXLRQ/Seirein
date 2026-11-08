/**
 * OBS as a continuous watch source, sharing one watch capability with the desktop.
 *
 * The Host is mounted for real; sight.js and obs.js are deterministic doubles, so no screen,
 * ffmpeg, OBS process, virtual camera or attachment store is touched. Each test names the user
 * requirement it proves:
 *   1. desktop → obs(scene) source switch, status source/scene/capturing/lastCaptureAt;
 *   2. assistant_watch take delivers a real image block, not just a path string;
 *   3. switching scenes invalidates old-generation frames and storyboards;
 *   4. continuous watch is not stopped by the scene idle timer; stop/component close releases;
 *   5. privacy stops both sources, cancels in-flight work, clears preview/cache, never switches
 *      an OBS scene, and restores source/scene/capture on exit;
 *   6. virtual-camera ownership: plugin-started is stopped, user-started is preserved;
 *   7. OBS autostart runs even while the source is desktop and status.running agrees;
 *   8. (regressions are run as separate suites; see the task report).
 *
 * Run: node --test test/vision-watch-source.mjs
 */
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { registerHooks } from 'node:module';
import { createServer } from 'node:net';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cleanupRoot } from './helpers/cleanup.mjs';

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const state = {
  capture: null,
  start: null,
  calls: [],
  starts: 0,
  stops: 0,
  obsScene: 'Main',
  obsScenes: ['Main', 'Other'],
  obsRequests: [],
  virtualCamActive: true,
  virtualCamStarts: 0,
  virtualCamStops: 0,
  takeGate: null,
  takeEntered: null,
  captureGate: null,
  captureEntered: null,
  sheetBytes: Buffer.from('PNG-STORYBOARD-REAL-PIXELS'),
  saves: [],
};
globalThis.__visionWatchSourceTest = state;

const sightUrl = new URL('../src/host/vision/sight.js', import.meta.url).href;
const obsUrl = new URL('../src/host/vision/obs.js', import.meta.url).href;
const hooks = registerHooks({
  load(url, context, next) {
    if (url === sightUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `const s = globalThis.__visionWatchSourceTest;
          export const resolveFfmpeg = () => 'fake-ffmpeg';
          export const resolveFfplay = () => null;
          export const capture = (o) => { s.calls.push('powershell'); return s.capture(o); };
          export const captureDesktop = (o) => { s.calls.push('desktop'); return s.capture(o); };
          export const captureDevice = (o) => { s.calls.push('device'); return s.capture(o); };
          export const startStoryboard = (o) => { s.starts += 1; return s.start(o); };
          export const shrinkShot = async () => null;
          export const OBSERVATION_TTL_MS = 30000;
          function observationTtl(ttlMs) {
            const value = Number(ttlMs);
            return Number.isFinite(value) && value >= 0 ? value : OBSERVATION_TTL_MS;
          }
          export function freshnessOf(at, now = Date.now(), ttlMs = OBSERVATION_TTL_MS) {
            const stamp = Number(at);
            if (!Number.isFinite(stamp) || stamp <= 0) return { at: null, ageMs: null, stale: true };
            const ageMs = Number.isFinite(Number(now)) ? Math.max(0, Number(now) - stamp) : null;
            return { at: stamp, ageMs, stale: ageMs === null ? true : ageMs >= observationTtl(ttlMs) };
          }
          export function readObservation(observation, { now = Date.now(), ttlMs = OBSERVATION_TTL_MS } = {}) {
            const value = observation ?? {};
            const captured = Number(value.capturedAt);
            const stored = Number.isFinite(captured) && captured > 0 ? captured : value.at;
            const freshness = freshnessOf(stored, now, ttlMs);
            return { ...value, ...freshness, hint: freshness.stale ? 'stale' : '' };
          }`,
      };
    }
    if (url === obsUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `export async function connectObs() {
          const s = globalThis.__visionWatchSourceTest;
          return {
            async request(type, data) {
              s.obsRequests.push({ type, data: data ?? null });
              if (type === 'GetSceneList') {
                return {
                  currentProgramSceneName: s.obsScene,
                  scenes: s.obsScenes.map((sceneName) => ({ sceneName })),
                };
              }
              if (type === 'SetCurrentProgramScene') {
                s.obsScene = String(data?.sceneName ?? '');
                return {};
              }
              if (type === 'GetVirtualCamStatus') return { outputActive: s.virtualCamActive };
              if (type === 'StartVirtualCam') {
                s.virtualCamActive = true;
                s.virtualCamStarts += 1;
                return {};
              }
              if (type === 'StopVirtualCam') {
                s.virtualCamActive = false;
                s.virtualCamStops += 1;
                return {};
              }
              return {};
            },
            close() {},
          };
        }`,
      };
    }
    return next(url, context);
  },
});
const { apply } = await import('../src/host/index.js');
hooks.deregister();

const server = createServer((socket) => socket.end());
before(async () => { await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); });
after(async () => { await new Promise((resolve) => server.close(resolve)); delete globalThis.__visionWatchSourceTest; });

function resetState({ virtualCamActive = true, obsScene = 'Main' } = {}) {
  state.capture = null;
  state.start = null;
  state.calls = [];
  state.starts = 0;
  state.stops = 0;
  state.obsScene = obsScene;
  state.obsScenes = ['Main', 'Other'];
  state.obsRequests = [];
  state.virtualCamActive = virtualCamActive;
  state.virtualCamStarts = 0;
  state.virtualCamStops = 0;
  state.takeGate = null;
  state.takeEntered = null;
  state.captureGate = null;
  state.captureEntered = null;
  state.saves = [];
}

async function fixture(t, {
  settings = null,
  dependencyBootDelayMs = 8000,
  sceneIdleMs = 60_000,
  virtualCamActive = true,
} = {}) {
  resetState({ virtualCamActive });
  const root = await mkdtemp(join(tmpdir(), 'dsh-vision-watch-source-'));
  if (settings !== null) {
    await mkdir(join(root, 'data'), { recursive: true });
    await writeFile(join(root, 'data', 'settings.json'), JSON.stringify(settings));
  }
  const tools = new Map();
  const routes = new Map();
  const disposers = [];
  const effect = (fn) => {
    const dispose = fn();
    if (typeof dispose === 'function') disposers.push(dispose);
    return dispose;
  };
  const attachments = {
    async saveImage({ data, mediaType, name }) {
      state.saves.push({ data, mediaType, name });
      return { id: `att-${state.saves.length}`, mediaType, name, bytes: data.length };
    },
  };
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
      effect,
      systemPrompt: { section: () => () => {} },
      webServer: {
        register(route) {
          routes.set(route.path, route.handler);
          return () => routes.delete(route.path);
        },
      },
    }),
  }, {
    root,
    enabled: true,
    defaultDomain: 'chat',
    obsPort: server.address().port,
    privacyScene: 'Privacy',
    dependencyBootDelayMs,
    sceneIdleMs,
  });
  t.after(() => cleanupRoot(root, disposers));

  const exec = () => ({
    agent: {
      session: { requestHeader: () => ({ config: { provider: 'fake', model: 'vision-model' } }) },
      options: {},
    },
  });
  const call = async (name, args = {}) => {
    const tool = tools.get(name);
    assert.ok(tool !== undefined, `${name} is registered`);
    return { tool, value: await tool.execute(args, exec()) };
  };
  const route = async (path, body, method = 'POST') => {
    let status;
    let payload;
    const req = method === 'GET'
      ? { method: 'GET', url: path }
      : Object.assign(Readable.from([JSON.stringify(body)]), { method: 'POST', url: path });
    const handler = routes.get(path.split('?')[0]);
    assert.ok(handler !== undefined, `route ${path} is registered`);
    await handler(req, {
      writeHead(code) { status = code; },
      end(data) { payload = data; },
    });
    return { status, data: payload };
  };
  const action = async (body) => JSON.parse((await route('/assistant/action', body)).data);
  const status = async () => JSON.parse((await route('/assistant/status', undefined, 'GET')).data);
  const shot = (file) => route(`/assistant/shot?path=${encodeURIComponent(file)}`, undefined, 'GET');
  const listScreens = async () => readdir(join(root, 'cache', 'screens')).catch(() => []);
  const events = async () => {
    const text = await readFile(join(root, 'data', 'events.jsonl'), 'utf8').catch(() => '');
    return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  };
  return { root, call, action, status, shot, listScreens, events };
}

/** Write one PNG-shaped file into the storyboard directory. */
async function writeSheet(dir, name = `${randomUUID()}.png`) {
  await mkdir(dir, { recursive: true });
  const file = join(dir, name);
  await writeFile(file, state.sheetBytes);
  return {
    file, bytes: state.sheetBytes.length, width: 320, height: 200,
    frames: 3, from: 0, to: 0.25, at: Date.now(), capturedAt: Date.now(),
  };
}

/** The fake storyboard session used by startStoryboard(). */
function fakeSession({ dir, source }) {
  const done = deferred();
  let stopped = false;
  const fromObs = source?.kind === 'obs';
  return {
    engine: fromObs ? 'fake-obs' : 'fake-desktop',
    sourceKind: fromObs ? 'obs' : 'screen',
    async take() {
      if (state.takeGate !== null) {
        state.takeEntered?.resolve();
        await state.takeGate.promise;
      }
      return writeSheet(dir);
    },
    stats: () => ({ frames: 12, sheets: 1, engine: fromObs ? 'fake-obs' : 'fake-desktop' }),
    stop() {
      if (stopped) return;
      stopped = true;
      state.stops += 1;
      done.resolve();
    },
    done: done.promise,
  };
}

function installCaptures() {
  state.start = (options) => fakeSession(options);
  state.capture = async ({ dir }) => {
    if (state.captureGate !== null) {
      state.captureEntered?.resolve();
      await state.captureGate.promise;
    }
    return writeSheet(dir, 'capture.png');
  };
}

test('① 桌面 → OBS（选场景）：status 反映 source/scene/capturing，且 take 交付真实图像', async (t) => {
  const app = await fixture(t, { virtualCamActive: true });
  installCaptures();

  // Desktop first: the same watch capability works without OBS.
  const desktop = await app.call('assistant_vision', { action: 'set', source: 'desktop' });
  assert.equal(desktop.value.ok, true, desktop.value.error);
  assert.equal((await app.call('assistant_vision', { action: 'status' })).value.source, 'desktop');
  assert.equal((await app.call('assistant_watch', { action: 'start' })).value.ok, true);
  const desktopTake = await app.call('assistant_watch', { action: 'take' });
  assert.equal(desktopTake.value.ok, true, desktopTake.value.error);
  assert.equal(desktopTake.value.source, 'desktop');
  assert.equal(desktopTake.value.attachment?.id, 'att-1');
  await app.call('assistant_watch', { action: 'stop' });

  // OBS scene source.
  const obs = await app.call('assistant_vision', { action: 'set', source: 'obs', scene: 'Main' });
  assert.equal(obs.value.ok, true, obs.value.error);
  let vision = (await app.call('assistant_vision', { action: 'status' })).value;
  assert.equal(vision.source, 'obs');
  assert.equal(vision.scene, 'Main');
  assert.equal(vision.capturing, false);
  assert.equal(vision.obsRunning, true, 'the fake OBS WebSocket answered, so the process flag is true');

  const before = await app.status();
  assert.equal(before.vision.lastShot, null);
  assert.equal(before.vision.lastCaptureAt, null);

  const started = await app.call('assistant_watch', { action: 'start' });
  assert.equal(started.value.ok, true, started.value.error);
  assert.equal(started.value.source, 'obs');
  vision = (await app.call('assistant_vision', { action: 'status' })).value;
  assert.equal(vision.capturing, true);
  assert.equal(vision.scene, 'Main');

  const take = await app.call('assistant_watch', { action: 'take' });
  assert.equal(take.value.ok, true, take.value.error);
  assert.equal(take.value.ready, true);
  assert.equal(take.value.source, 'obs');
  assert.equal(take.value.scene, 'Main');

  // The result is a real image delivery: saveImage received the exact bytes, and the model-facing
  // render carries an image block (not merely the path string).
  assert.equal(state.saves.length, 2);
  const saved = state.saves.at(-1);
  assert.ok(Buffer.isBuffer(saved.data), 'saveImage receives a Buffer');
  assert.ok(saved.data.equals(state.sheetBytes), 'the storyboard bytes are the delivered bytes');
  assert.equal(saved.mediaType, 'image/png');
  assert.equal(take.value.attachment.id, 'att-2');
  const blocks = take.tool.output.render({}, take.value);
  assert.equal(blocks[0].type, 'text');
  assert.match(blocks[0].text, /Storyboard/);
  assert.equal(blocks[1].type, 'image', 'the watch result renders a real image block');
  assert.equal(blocks[1].attachment.id, 'att-2');

  vision = (await app.call('assistant_vision', { action: 'status' })).value;
  assert.equal(typeof vision.lastCaptureAt, 'number');
  assert.ok(vision.lastCaptureAt > 0);
  assert.equal((await app.status()).vision.lastShot.file, take.value.file);
  assert.equal((await app.shot(take.value.file)).status, 200);
  assert.equal((await app.call('assistant_watch', { action: 'stop' })).value.ok, true);
  assert.equal((await app.call('assistant_vision', { action: 'status' })).value.capturing, false);
});

test('② 切场景：旧代次帧与待交付故事板作废，新代次正常', async (t) => {
  const app = await fixture(t, { virtualCamActive: true });
  installCaptures();
  assert.equal((await app.call('assistant_vision', { action: 'set', source: 'obs', scene: 'Main' })).value.ok, true);
  assert.equal((await app.call('assistant_watch', { action: 'start' })).value.ok, true);

  const first = await app.call('assistant_watch', { action: 'take' });
  assert.equal(first.value.ok, true, first.value.error);
  const oldFile = first.value.file;
  assert.equal((await app.shot(oldFile)).status, 200);

  // A take is in flight when the scene changes.
  state.takeGate = deferred();
  state.takeEntered = deferred();
  const pending = app.call('assistant_watch', { action: 'take' });
  await state.takeEntered.promise;

  const switched = await app.call('assistant_obs', { action: 'set', scene: 'Other' });
  assert.equal(switched.value.ok, true, switched.value.error);
  assert.equal(state.obsScene, 'Other');
  assert.equal((await app.shot(oldFile)).status, 403, 'the old generation storyboard is not served');

  state.takeGate.resolve();
  const late = await pending;
  assert.equal(late.value.ok, false, 'the old generation take cannot deliver');
  assert.match(late.value.error, /作废|停止|切换/u);

  // The scene switch restarts capture in a new generation.
  assert.equal((await app.call('assistant_vision', { action: 'status' })).value.capturing, true);
  state.takeGate = null;
  state.takeEntered = null;
  const fresh = await app.call('assistant_watch', { action: 'take' });
  assert.equal(fresh.value.ok, true, fresh.value.error);
  assert.notEqual(fresh.value.file, oldFile);
  assert.equal(fresh.value.scene, 'Other');
  assert.equal((await app.shot(fresh.value.file)).status, 200);
});

test('③ 持续观看不被场景空闲关闭误停；停止后释放采集与插件启动的虚拟摄像头', async (t) => {
  const app = await fixture(t, { virtualCamActive: false, sceneIdleMs: 5_000 });
  installCaptures();
  assert.equal((await app.call('assistant_vision', { action: 'set', source: 'obs', scene: 'Main' })).value.ok, true);
  assert.equal(state.virtualCamStarts, 1, 'the plugin started the virtual camera');
  assert.equal((await app.call('assistant_watch', { action: 'start' })).value.ok, true);

  let vision = (await app.call('assistant_vision', { action: 'status' })).value;
  assert.equal(vision.capturing, true);
  assert.equal(vision.idleSeconds, 0, 'no scene idle countdown exists while watching');

  // The scene idle timer would have fired by now; a running storyboard must keep the camera.
  await sleep(5_300);
  assert.equal(state.virtualCamStops, 0, 'the idle timer did not stop the virtual camera');
  assert.equal(state.virtualCamActive, true);
  vision = (await app.call('assistant_vision', { action: 'status' })).value;
  assert.equal(vision.capturing, true);
  assert.equal(vision.virtualCam, true);

  const stopped = await app.call('assistant_watch', { action: 'stop' });
  assert.equal(stopped.value.ok, true);
  assert.ok(state.stops >= 1, 'the storyboard session was stopped');
  assert.equal(state.virtualCamStops, 1, 'the plugin-owned camera was released');
  assert.equal(state.virtualCamActive, false);
  vision = (await app.call('assistant_vision', { action: 'status' })).value;
  assert.equal(vision.capturing, false);
  assert.equal(vision.virtualCam, false);
});

test('④ 组件关闭同样释放采集与插件启动的虚拟摄像头', async (t) => {
  const app = await fixture(t, { virtualCamActive: false });
  installCaptures();
  assert.equal((await app.call('assistant_vision', { action: 'set', source: 'obs', scene: 'Main' })).value.ok, true);
  assert.equal((await app.call('assistant_watch', { action: 'start' })).value.ok, true);
  assert.equal(state.virtualCamStarts, 1);

  const disabled = await app.action({ action: 'feature.set', id: 'vision', enabled: false });
  assert.equal(disabled.ok, true, disabled.error);
  assert.ok(state.stops >= 1, 'component close stopped the watcher');
  assert.equal(state.virtualCamStops, 1, 'component close released the plugin camera');
  assert.equal(state.virtualCamActive, false);
  assert.equal((await app.call('assistant_watch', { action: 'start' })).value.ok, false);
});

test('⑤ 隐私：停两种来源/取消在途/清空缓存/拒绝旧画面，且不切 OBS 场景；解除后恢复', async (t) => {
  const app = await fixture(t, { virtualCamActive: true, obsScene: 'Main' });
  installCaptures();
  assert.equal((await app.call('assistant_vision', { action: 'set', source: 'obs', scene: 'Main' })).value.ok, true);
  assert.equal((await app.call('assistant_watch', { action: 'start' })).value.ok, true);
  const sheet = await app.call('assistant_watch', { action: 'take' });
  assert.equal(sheet.value.ok, true, sheet.value.error);
  const oldSheet = sheet.value.file;

  // An in-flight one-shot look that deliberately ignores cancellation exercises the last gate.
  state.captureGate = deferred();
  state.captureEntered = deferred();
  const pending = app.call('assistant_see', {});
  await state.captureEntered.promise;

  const sceneBefore = state.obsScene;
  const requestsBefore = state.obsRequests.length;
  const privacy = await app.action({ action: 'vision.mode', mode: 'privacy' });
  assert.equal(privacy.ok, true, privacy.error);

  // Privacy must not switch the OBS program scene (the old privacy-scene layer is gone).
  const duringPrivacy = state.obsRequests.slice(requestsBefore);
  assert.equal(
    duringPrivacy.some((entry) => entry.type === 'SetCurrentProgramScene'),
    false,
    'privacy never calls SetCurrentProgramScene',
  );
  assert.equal(state.obsScene, sceneBefore, 'the user program scene is untouched');

  assert.ok(state.stops >= 1, 'privacy stopped the running OBS watch');
  state.captureGate.resolve();
  const late = await pending;
  assert.equal(late.value.ok, false, 'the in-flight capture is cancelled');
  assert.match(late.value.reason, /隐私|作废/u);

  const locked = await app.status();
  assert.equal(locked.vision.locked, true);
  assert.equal(locked.vision.capturing, false);
  assert.equal(locked.vision.lastShot, null);
  assert.equal(locked.vision.lastCaptureAt, null);
  assert.equal(locked.perception.lastVision, null);
  assert.equal((await app.shot(oldSheet)).status, 403, 'the old storyboard is not served');
  assert.deepEqual(await app.listScreens(), [], 'cache/screens is cleared');
  assert.equal((await app.call('assistant_watch', { action: 'take' })).value.ok, false);
  const blockedStart = await app.action({ action: 'vision.watch.start', source: 'obs', scene: 'Main' });
  assert.equal(blockedStart.ok, false, 'continuous watch cannot start while privacy is locked');
  assert.equal(blockedStart.locked, true);

  // Only the user can leave; the previous source/scene comes back and capture resumes.
  const exit = await app.action({ action: 'privacy.toggle' });
  assert.equal(exit.ok, true, exit.error);
  const restored = await app.status();
  assert.equal(restored.vision.source, 'obs');
  assert.equal(restored.vision.scene, 'Main');
  assert.equal(restored.vision.capturing, true, 'the previous continuous watch resumed');
  assert.equal(state.obsScene, 'Main');

  state.takeGate = null;
  const fresh = await app.call('assistant_watch', { action: 'take' });
  assert.equal(fresh.value.ok, true, fresh.value.error);
  assert.notEqual(fresh.value.file, oldSheet);

  // The same lock stops the desktop source too (switching while watching resumes it there).
  assert.equal((await app.call('assistant_vision', { action: 'set', source: 'desktop' })).value.ok, true);
  assert.equal((await app.call('assistant_vision', { action: 'status' })).value.capturing, true);
  assert.equal((await app.action({ action: 'vision.mode', mode: 'privacy' })).ok, true);
  assert.equal((await app.call('assistant_vision', { action: 'status' })).value.capturing, false);
  assert.ok(state.stops >= 2, 'both the OBS watch and the desktop watch were stopped');
});

test('⑥ 虚拟摄像头归属：用户自启的保留，插件启动的才停', async (t) => {
  const app = await fixture(t, { virtualCamActive: true });
  installCaptures();
  assert.equal((await app.call('assistant_vision', { action: 'set', source: 'obs', scene: 'Main' })).value.ok, true);
  assert.equal(state.virtualCamStarts, 0, 'an already-running user camera is reused, not started');
  assert.equal((await app.call('assistant_watch', { action: 'start' })).value.ok, true);
  assert.equal((await app.call('assistant_watch', { action: 'stop' })).value.ok, true);
  assert.equal(state.virtualCamStops, 0, 'stop does not kill the user stream');
  assert.equal(state.virtualCamActive, true);

  // Privacy also only releases plugin-owned resources.
  assert.equal((await app.call('assistant_watch', { action: 'start' })).value.ok, true);
  assert.equal((await app.action({ action: 'vision.mode', mode: 'privacy' })).ok, true);
  assert.equal(state.virtualCamStops, 0);
  assert.equal(state.virtualCamActive, true);
});

test('⑦ OBS 自启：source=desktop 不否决自启，status.running 与实际一致', async (t) => {
  const app = await fixture(t, {
    virtualCamActive: true,
    dependencyBootDelayMs: 0,
    settings: {
      autostart: { obs: { enabled: true, autoClose: true, path: '' } },
      vision: { mode: 'watch', scene: '' },
    },
  });
  let status;
  for (let i = 0; i < 100; i += 1) {
    status = await app.status();
    if (status.vision.obsRunning === true && status.autostart.obs.running === true) break;
    await sleep(20);
  }
  assert.equal(status.vision.source, 'desktop', 'OBS autostart is not vetoed by the desktop source');
  assert.equal(status.vision.obsRunning, true, 'status.vision reports the OBS process as running');
  assert.equal(status.autostart.obs.running, true, 'status.autostart.obs.running agrees with the probe');
  const vision = (await app.call('assistant_vision', { action: 'status' })).value;
  assert.equal(vision.obsRunning, true);

  const acquire = (await app.events()).find((event) => (
    event.type === 'dependency.acquire' && event.payload?.target === 'obs'
  ));
  assert.ok(acquire !== undefined, 'boot acquired the OBS dependency');
  assert.equal(acquire.payload.running, true, 'the dependency is running, not skipped');
});

test('⑧ assistant_see 仍是单次取景：交付图像但不建立持续采集', async (t) => {
  const app = await fixture(t, { virtualCamActive: true });
  installCaptures();
  assert.equal((await app.call('assistant_vision', { action: 'set', source: 'obs', scene: 'Main' })).value.ok, true);

  const look = await app.call('assistant_see', {});
  assert.equal(look.value.ok, true, look.value.reason);
  assert.equal(look.value.mode, 'scene');
  assert.equal(look.value.attachment?.id, 'att-1');
  assert.equal(state.starts, 0, 'a one-shot look never starts a storyboard');
  assert.equal((await app.call('assistant_vision', { action: 'status' })).value.capturing, false);
  assert.equal((await app.call('assistant_watch', { action: 'status' })).value.running, false);
});
