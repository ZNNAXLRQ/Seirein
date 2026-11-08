/**
 * Black-frame detection and one-shot retry for the vision capture / storyboard lanes.
 *
 * The OBS virtual camera can answer "active" before it produces pixels: the 10:04 capture pair
 * was a 1280x720, 4349-byte, identical-hash black frame; a later take of the same scene delivered
 * real pixels. These tests pin the behaviour the fix must guarantee:
 *   1. first frame black, retry succeeds -> the normal frame is delivered + `vision.capture.retried`;
 *   2. both frames black -> an explicit error, nothing delivered, status.virtualCamError readable;
 *   3. a normal frame -> no retry at all;
 *   4. the pure judge: identical small frames are black, identical large static frames are not;
 *   5. privacy -> no capture and no retry;
 *   6. regressions run as separate suites (see the task report).
 *
 * The Host is mounted for real; sight.js and obs.js are deterministic doubles, so no screen,
 * ffmpeg, OBS process, virtual camera or attachment store is touched. PNGs are real files built
 * with dsh-see-now's pure encoder, so the judge decodes exactly what ffmpeg would produce.
 *
 * Run: node --test test/vision-black-frame.mjs
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

import { encodePng } from 'dsh-see-now/png';

import { cleanupRoot } from './helpers/cleanup.mjs';
import { assessFrame, pngLumaStats } from '../src/host/vision/black-frame.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A real RGB PNG built from one pixel function (the same layout ffmpeg emits). */
function pngOf(width, height, pixel) {
  const rgb = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = pixel(x, y);
      const offset = (y * width + x) * 3;
      rgb[offset] = r;
      rgb[offset + 1] = g;
      rgb[offset + 2] = b;
    }
  }
  return encodePng(rgb, width, height);
}

/** The failing 10:04 frame: 1280x720 and uniformly black (bytes are tiny, like 4349). */
const BLACK_FRAME = pngOf(1280, 720, () => [0, 0, 0]);
/** A normal desktop-like frame: varied pixels, hundreds of KB. */
const NORMAL_FRAME = pngOf(1280, 720, (x, y) => [
  (x * 7 + y) % 256, (x + y * 11) % 256, (x * 3 + y * 5) % 256,
]);

const state = {
  captures: [],
  captureCalls: 0,
  sheets: [],
  sheetCalls: 0,
  stops: 0,
  obsScene: 'Main',
  obsRequests: [],
  virtualCamActive: true,
  saves: [],
};
globalThis.__visionBlackFrameTest = state;

const sightUrl = new URL('../src/host/vision/sight.js', import.meta.url).href;
const obsUrl = new URL('../src/host/vision/obs.js', import.meta.url).href;
const hooks = registerHooks({
  load(url, context, next) {
    if (url === sightUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `const s = globalThis.__visionBlackFrameTest;
          export const resolveFfmpeg = () => 'fake-ffmpeg';
          export const resolveFfplay = () => null;
          export const capture = (o) => s.capture(o);
          export const captureDesktop = (o) => s.capture(o);
          export const captureDevice = (o) => s.capture(o);
          export const startStoryboard = (o) => s.start(o);
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
          const s = globalThis.__visionBlackFrameTest;
          return {
            async request(type, data) {
              s.obsRequests.push({ type, data: data ?? null });
              if (type === 'GetSceneList') {
                return { currentProgramSceneName: s.obsScene, scenes: [{ sceneName: s.obsScene }] };
              }
              if (type === 'GetVirtualCamStatus') return { outputActive: s.virtualCamActive };
              if (type === 'StartVirtualCam') { s.virtualCamActive = true; return {}; }
              if (type === 'StopVirtualCam') { s.virtualCamActive = false; return {}; }
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
after(async () => { await new Promise((resolve) => server.close(resolve)); delete globalThis.__visionBlackFrameTest; });

function resetState() {
  state.captures = [];
  state.captureCalls = 0;
  state.sheets = [];
  state.sheetCalls = 0;
  state.stops = 0;
  state.obsScene = 'Main';
  state.obsRequests = [];
  state.virtualCamActive = true;
  state.saves = [];
}

/** Write one queued frame and return the shot/sheet metadata the real capture would return. */
async function writeFrame(dir, data, width, height) {
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${randomUUID()}.png`);
  await writeFile(file, data);
  const at = Date.now();
  return {
    file, bytes: data.length, width, height, engine: 'fake',
    frames: 3, from: 0, to: 0.25, at, capturedAt: at,
  };
}

/** Fake sight module: one-shot capture and the continuous storyboard, both queue-driven. */
state.capture = async ({ dir }) => {
  state.captureCalls += 1;
  return writeFrame(dir, state.captures.shift() ?? NORMAL_FRAME, 1280, 720);
};
state.start = ({ dir }) => {
  let stopped = false;
  let finish;
  const done = new Promise((resolve) => { finish = resolve; });
  return {
    engine: 'fake-obs',
    sourceKind: 'obs',
    async take() {
      state.sheetCalls += 1;
      return writeFrame(dir, state.sheets.shift() ?? NORMAL_FRAME, 800, 450);
    },
    stats: () => ({ frames: 12, sheets: state.sheetCalls, engine: 'fake-obs' }),
    stop() {
      if (stopped) return;
      stopped = true;
      state.stops += 1;
      finish();
    },
    done,
  };
};

async function fixture(t) {
  resetState();
  const root = await mkdtemp(join(tmpdir(), 'dsh-vision-black-frame-'));
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
    dependencyBootDelayMs: 8000,
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
  const status = async () => JSON.parse((await route('/assistant/status', undefined, 'GET')).data);
  const listScreens = async () => readdir(join(root, 'cache', 'screens')).catch(() => []);
  const events = async () => {
    const text = await readFile(join(root, 'data', 'events.jsonl'), 'utf8').catch(() => '');
    return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  };
  return { root, call, status, listScreens, events };
}

async function enterScene(app, scene = 'Main') {
  const set = await app.call('assistant_vision', { action: 'set', source: 'obs', scene });
  assert.equal(set.value.ok, true, set.value.error);
}

test('① 首帧黑帧、重试成功：交付正常画面并记录 vision.capture.retried', async (t) => {
  const app = await fixture(t);
  await enterScene(app);
  assert.equal((await app.call('assistant_watch', { action: 'start' })).value.ok, true);

  state.sheets = [BLACK_FRAME, NORMAL_FRAME];
  const take = await app.call('assistant_watch', { action: 'take' });
  assert.equal(take.value.ok, true, take.value.error);
  assert.equal(take.value.ready, true);
  assert.equal(state.sheetCalls, 2, 'the black sheet was retried exactly once');
  // The delivered bytes are the retried, real frame - never the black one.
  assert.equal(state.saves.length, 1);
  assert.ok(state.saves[0].data.equals(NORMAL_FRAME), 'the normal frame is what reaches the model');
  assert.equal(take.value.attachment?.id, 'att-1');

  const events = await app.events();
  const retried = events.filter((event) => event.type === 'vision.capture.retried');
  assert.equal(retried.length, 1);
  assert.equal(retried[0].payload.reason, 'near-black');
  assert.equal(retried[0].payload.source, 'sheet:scene');
  assert.equal(events.some((event) => event.type === 'vision.capture.black'), false);

  const vision = (await app.call('assistant_vision', { action: 'status' })).value;
  assert.equal(vision.virtualCamError, null, 'a successful retry leaves no camera error');

  const screens = await app.listScreens();
  assert.equal(screens.length, 1, 'only the delivered frame remains; the black one was deleted');
  assert.equal((await app.call('assistant_watch', { action: 'stop' })).value.ok, true);
});

test('② 两次都黑：明确报错、不交付，status.virtualCamError 可读', async (t) => {
  const app = await fixture(t);
  await enterScene(app);
  state.captures = [BLACK_FRAME, BLACK_FRAME];

  const see = await app.call('assistant_see', {});
  assert.equal(see.value.ok, false);
  assert.match(see.value.reason, /黑帧|未出画面/u);
  assert.equal(see.value.attachment, null, 'a black frame is never delivered as an image');
  assert.equal(state.captures.length, 0);
  assert.equal(state.captureCalls, 2, 'one capture plus exactly one retry');

  const vision = (await app.call('assistant_vision', { action: 'status' })).value;
  assert.equal(vision.virtualCamError.reason, 'near-black');
  assert.equal(typeof vision.virtualCamError.at, 'number');
  assert.ok(vision.virtualCamError.at > 0);
  assert.equal(vision.virtualCamError.bytes, BLACK_FRAME.length);
  assert.equal(vision.virtualCamError.virtualCam, true);

  const full = await app.status();
  assert.equal(full.vision.virtualCamError.reason, 'near-black', '/assistant/status exposes it too');

  const events = await app.events();
  const black = events.filter((event) => event.type === 'vision.capture.black');
  assert.equal(black.length, 1);
  assert.deepEqual(
    { reason: black[0].payload.reason, bytes: black[0].payload.bytes, virtualCam: black[0].payload.virtualCam },
    { reason: 'near-black', bytes: BLACK_FRAME.length, virtualCam: true },
  );
  assert.equal(events.some((event) => event.type === 'vision.capture.retried'), false);
  assert.equal(events.some((event) => event.type === 'vision.delivered'), false);
  assert.deepEqual(await app.listScreens(), [], 'both black frames are deleted, never left behind');

  // A later real frame clears the stale camera error instead of keeping it forever.
  state.captures = [NORMAL_FRAME];
  const recovered = await app.call('assistant_see', {});
  assert.equal(recovered.value.ok, true, recovered.value.reason);
  const after = (await app.call('assistant_vision', { action: 'status' })).value;
  assert.equal(after.virtualCamError, null);
});

test('③ 正常画面：不重试（0 次）且不影响交付', async (t) => {
  const app = await fixture(t);
  await enterScene(app);
  state.captures = [NORMAL_FRAME];

  const see = await app.call('assistant_see', {});
  assert.equal(see.value.ok, true, see.value.reason);
  assert.equal(state.captureCalls, 1, 'a real frame is captured exactly once');
  assert.equal(see.value.attachment?.id, 'att-1');

  const events = await app.events();
  assert.equal(events.some((event) => event.type === 'vision.capture.retried'), false);
  assert.equal(events.some((event) => event.type === 'vision.capture.black'), false);
  const vision = (await app.call('assistant_vision', { action: 'status' })).value;
  assert.equal(vision.virtualCamError, null);
});

test('④ 判定规则：同哈希且字节小算黑帧，同哈希但字节大（静态页面）不误判', () => {
  // A small but colourful image: not near-black, so only the duplicate rules can catch it.
  const tiny = pngOf(16, 16, () => [200, 40, 40]);
  const tinyFirst = assessFrame({ data: tiny, at: 1000 });
  assert.equal(tinyFirst.black, false, 'one small colourful frame is a normal frame');
  const tinyAgain = assessFrame({ data: tiny, at: 1100, previous: tinyFirst.frame });
  assert.equal(tinyAgain.black, true, 'two identical small frames are a stuck/no-signal frame');
  assert.equal(tinyAgain.reason, 'duplicate-small');
  const tinyLate = assessFrame({ data: tiny, at: 2600, previous: tinyFirst.frame });
  assert.equal(tinyLate.black, true, 'the same small frame held across a wait is still black');
  assert.equal(tinyLate.reason, 'identical-small-stale');

  // A static page: the same sheet twice, hundreds of KB. Identical is NOT black by itself.
  const normalFirst = assessFrame({ data: NORMAL_FRAME, at: 1000 });
  assert.equal(normalFirst.black, false);
  const normalAgain = assessFrame({ data: NORMAL_FRAME, at: 3000, previous: normalFirst.frame });
  assert.equal(normalAgain.black, false, 'an unchanged large static page is not a black frame');

  // The startup frame itself: uniform black pixels.
  const black = assessFrame({ data: BLACK_FRAME, at: 1000 });
  assert.equal(black.black, true);
  assert.equal(black.reason, 'near-black');
  assert.ok(BLACK_FRAME.length < 10 * 1024, `the failing frame shape is small (${BLACK_FRAME.length} bytes)`);
  const stats = pngLumaStats(BLACK_FRAME);
  assert.equal(stats.mean, 0);
  assert.equal(stats.std, 0);

  // Undecodable bytes are unknown, never "black": capture-format problems are not our call.
  assert.equal(assessFrame({ data: Buffer.from('PNGDATA-NOT-REAL'), at: 1 }), null);
});

test('⑤ 隐私期间：不抓取、不重试', async (t) => {
  const app = await fixture(t);
  await enterScene(app);
  const privacy = await app.call('assistant_vision', { action: 'set', mode: 'privacy' });
  assert.equal(privacy.value.ok, true, privacy.value.error);

  const see = await app.call('assistant_see', {});
  assert.equal(see.value.ok, false);
  assert.match(see.value.reason, /隐私/u);
  const take = await app.call('assistant_watch', { action: 'take' });
  assert.equal(take.value.ok, false);
  assert.match(take.value.error, /隐私/u);

  assert.equal(state.captureCalls, 0, 'privacy is checked before the screen is touched');
  assert.equal(state.sheetCalls, 0, 'privacy is checked before a storyboard is taken');
  const events = await app.events();
  assert.equal(events.some((event) => event.type === 'vision.capture.retried'), false);
  assert.equal(events.some((event) => event.type === 'vision.capture.black'), false);
  assert.equal((await app.status()).vision.locked, true);
});
