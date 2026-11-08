/**
 * P2-2: a shared vision capture must not be cancelled by one of its waiters.
 *
 * The module contract under test:
 *   • two callers inside the 500 ms merge window share ONE real capture;
 *   • cancelling caller A withdraws only A's wait (`perception.capture.detached`), B still gets
 *     the frame and the real capture signal is never aborted;
 *   • only when the LAST waiter cancels is the private capture controller aborted
 *     (`perception.capture.cancelled {waiters:0}`), leaving no lane entry or file behind;
 *   • a result that arrives after the last waiter left is discarded, never delivered.
 *
 * The screen/attachment backends are test doubles; no real screen, OBS or ffmpeg is touched.
 *
 * Run: node --test test/vision-capture-share.mjs
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { registerHooks } from 'node:module';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cleanupRoot } from './helpers/cleanup.mjs';

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

const state = {
  capture: null,
  calls: 0,
  captureSignal: null,
  entered: null,
  gate: null,
  written: null,
  lastFile: '',
  attachments: [],
};
globalThis.__visionCaptureShareTest = state;

const sightUrl = new URL('../src/host/vision/sight.js', import.meta.url).href;
const hooks = registerHooks({
  load(url, context, next) {
    if (url === sightUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `const s = globalThis.__visionCaptureShareTest;
          export const resolveFfmpeg = () => 'fake-ffmpeg';
          export const resolveFfplay = () => null;
          export const capture = (o) => { s.calls += 1; return s.capture(o); };
          export const captureDesktop = (o) => { s.calls += 1; return s.capture(o); };
          export const captureDevice = (o) => { s.calls += 1; return s.capture(o); };
          export const startStoryboard = () => { throw new Error('storyboard is not used here'); };
          export const shrinkShot = async () => null;
          export const OBSERVATION_TTL_MS = 30000;
          export function freshnessOf(at, now = Date.now(), ttlMs = OBSERVATION_TTL_MS) {
            const stamp = Number(at);
            if (!Number.isFinite(stamp) || stamp <= 0) return { at: null, ageMs: null, stale: true };
            const ageMs = Math.max(0, now - stamp);
            return { at: stamp, ageMs, stale: ageMs >= ttlMs };
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
    return next(url, context);
  },
});
const { apply } = await import('../src/host/index.js');
hooks.deregister();
after(() => { delete globalThis.__visionCaptureShareTest; });

async function fixture(t) {
  state.capture = null;
  state.calls = 0;
  state.captureSignal = null;
  state.entered = null;
  state.gate = null;
  state.written = null;
  state.lastFile = '';
  state.attachments = [];

  const root = await mkdtemp(join(tmpdir(), 'dsh-vision-capture-share-'));
  const tools = new Map();
  const disposers = [];
  const effect = (fn) => {
    const cleanup = fn();
    if (typeof cleanup === 'function') disposers.push(cleanup);
    return cleanup;
  };
  let saved = 0;
  const attachmentsService = {
    async saveImage({ mediaType, name }) {
      saved += 1;
      const attachment = { id: `att-${saved}`, mediaType, name };
      state.attachments.push(attachment);
      return attachment;
    },
  };
  const llmService = {
    async resolveModelInfo(provider, model) {
      return { provider, id: model, name: model, inputModalities: ['text', 'image'] };
    },
  };
  apply({
    effect,
    get: (service) => {
      if (service === 'attachments') return attachmentsService;
      if (service === 'llm') return llmService;
      return undefined;
    },
    tools: { register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name); } },
    inject: (_dependencies, register) => register({
      effect,
      systemPrompt: { section: () => () => {} },
      webServer: { register: () => () => {} },
    }),
  }, {
    root,
    enabled: true,
    defaultDomain: 'chat',
    obsPort: 1,
    privacyScene: 'Privacy',
  });
  t.after(() => cleanupRoot(root, disposers));

  const call = async (name, args = {}, overrides = {}) => {
    const tool = tools.get(name);
    assert.ok(tool !== undefined, `${name} is registered`);
    return tool.execute(args, {
      ...overrides,
      agent: overrides.agent ?? {
        session: { requestHeader: () => ({ config: { provider: 'fake', model: 'vision-model' } }) },
        options: {},
      },
    });
  };
  const events = async () => {
    const text = await readFile(join(root, 'data', 'events.jsonl'), 'utf8').catch(() => '');
    return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  };
  const waitForEvent = async (type, predicate = () => true) => {
    for (let i = 0; i < 200; i += 1) {
      const hit = (await events()).find((event) => event.type === type && predicate(event));
      if (hit !== undefined) return hit;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return undefined;
  };
  const listScreens = async () => readdir(join(root, 'cache', 'screens')).catch(() => []);
  return { root, call, events, waitForEvent, listScreens };
}

/** Install a capture double that blocks until `gate`; optionally it ignores cancellation. */
function installCapture({ ignoreAbort = false } = {}) {
  const entered = deferred();
  const gate = deferred();
  const written = deferred();
  state.entered = entered;
  state.gate = gate;
  state.written = written;
  state.lastFile = '';
  state.capture = async ({ dir, signal }) => {
    state.captureSignal = signal;
    entered.resolve();
    if (ignoreAbort) {
      await gate.promise;
    } else {
      await new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason);
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        gate.promise.then(resolve);
      });
    }
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${randomUUID()}.png`);
    await writeFile(file, Buffer.from('PNGDATA-SHARED-CAPTURE'));
    state.lastFile = file;
    written.resolve(file);
    return {
      file, bytes: 22, width: 320, height: 200, engine: 'fake',
      at: Date.now(), capturedAt: Date.now(),
    };
  };
  return { entered, gate, written };
}

test('P2-2 取消 A 不连坐：共享采集继续，B 正常拿到图像', async (t) => {
  const app = await fixture(t);
  const { entered, gate } = installCapture();
  const controllerA = new AbortController();
  const pendingA = app.call('assistant_see', {}, { signal: controllerA.signal });
  await entered.promise;

  // B arrives while A's capture is still in flight: it joins the same lane.
  const pendingB = app.call('assistant_see', {});
  const coalesced = await app.waitForEvent('perception.coalesced', (event) => Number(event.payload.count) === 2);
  assert.ok(coalesced !== undefined, 'B joined the in-flight capture');
  assert.equal(state.calls, 1, 'one real capture is shared');

  controllerA.abort(new Error('A cancelled'));
  const resultA = await pendingA;
  t.diagnostic(`share-a-cancel: A.ok=${resultA.ok} reason=${resultA.reason} `
    + `captureAborted=${state.captureSignal?.aborted}`);
  assert.equal(resultA.ok, false, 'the cancelled caller gets its own cancellation');
  assert.match(resultA.reason, /取消/u);
  assert.equal(state.captureSignal?.aborted, false, 'the shared capture keeps running for B');

  gate.resolve();
  const resultB = await pendingB;
  assert.equal(resultB.ok, true, resultB.reason);
  assert.equal(resultB.current, true);
  assert.equal(state.calls, 1, 'B used the same real capture');
  assert.equal(state.attachments.length, 1, 'B still receives the image attachment');
  assert.equal(state.attachments[0].id, 'att-1');

  const detached = await app.waitForEvent('perception.capture.detached',
    (event) => Number(event.payload.waiters) === 1);
  assert.ok(detached !== undefined, 'detached event reports the one remaining waiter');
  const cancelled = (await app.events()).filter((event) => event.type === 'perception.capture.cancelled');
  assert.equal(cancelled.length, 0, 'the shared capture was not aborted while B waited');
});

test('P2-2 全部取消才中止共享采集，lane 与文件都清理', async (t) => {
  const app = await fixture(t);
  const { entered } = installCapture();
  const controllerA = new AbortController();
  const controllerB = new AbortController();
  const pendingA = app.call('assistant_see', {}, { signal: controllerA.signal });
  await entered.promise;
  const pendingB = app.call('assistant_see', {}, { signal: controllerB.signal });
  const coalesced = await app.waitForEvent('perception.coalesced', (event) => Number(event.payload.count) === 2);
  assert.ok(coalesced !== undefined, 'B joined the in-flight capture');

  controllerA.abort(new Error('A cancelled'));
  const resultA = await pendingA;
  assert.equal(resultA.ok, false);
  assert.equal(state.captureSignal?.aborted, false, 'A alone does not abort the capture');

  controllerB.abort(new Error('B cancelled'));
  const resultB = await pendingB;
  t.diagnostic(`share-all-cancel: A.ok=${resultA.ok} B.ok=${resultB.ok} `
    + `captureAborted=${state.captureSignal?.aborted}`);
  assert.equal(resultB.ok, false);
  assert.match(resultB.reason, /取消/u);
  assert.equal(state.captureSignal?.aborted, true, 'the last waiter aborts the private capture');

  const cancelled = await app.waitForEvent('perception.capture.cancelled',
    (event) => Number(event.payload.waiters) === 0);
  assert.ok(cancelled !== undefined, 'cancelled event reports no remaining waiter');
  assert.deepEqual(await app.listScreens(), [], 'an aborted pending capture writes no file');

  // The lane map was cleared: a fresh call starts its own capture instead of joining a corpse.
  const fresh = installCapture();
  const after = app.call('assistant_see', {});
  await fresh.entered.promise;
  fresh.gate.resolve();
  const result = await after;
  assert.equal(result.ok, true, result.reason);
  assert.equal(state.calls, 2, 'the new call paid for one new real capture');
  assert.equal(result.current, true);
});

test('P2-2 取消后才到的画面不交付且被删除', async (t) => {
  const app = await fixture(t);
  const { entered, gate, written } = installCapture({ ignoreAbort: true });
  const controller = new AbortController();
  const pending = app.call('assistant_see', {}, { signal: controller.signal });
  await entered.promise;

  controller.abort(new Error('cancelled before the late frame'));
  const result = await pending;
  t.diagnostic(`late-after-cancel: ok=${result.ok} reason=${result.reason} `
    + `captureAborted=${state.captureSignal?.aborted}`);
  assert.equal(result.ok, false);
  assert.match(result.reason, /取消/u);
  assert.equal(state.captureSignal?.aborted, true, 'the only waiter aborts the private capture');

  // The double ignores cancellation and still produces a file afterwards.
  gate.resolve();
  const file = await written.promise;
  for (let i = 0; i < 200; i += 1) {
    const exists = await readFile(file).then(() => true, () => false);
    if (!exists) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(await readFile(file).then(() => true, () => false), false,
    'the late frame is deleted instead of becoming an orphan');
  assert.deepEqual(await app.listScreens(), []);
  assert.equal(state.attachments.length, 0, 'the late frame is never saved or delivered');
  const events = await app.events();
  assert.equal(events.some((event) => event.type === 'vision.delivered'), false);
  assert.ok(await app.waitForEvent('perception.capture.cancelled',
    (event) => Number(event.payload.waiters) === 0));
});
