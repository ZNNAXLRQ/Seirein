/**
 * P-56 host wiring acceptance: freshness, cross-boundary invalidation, coalescing, statistics.
 *
 * The module-side contract (freshness/ambient classification) has its own file. This file drives
 * the REAL Host tools/routes through a fake sight capture and a fake OBS socket, so each of the
 * four wiring claims has direct evidence:
 *   ① an expired observation is projected as observedAt + current:false and the model-facing
 *      summary says it is not the current picture;
 *   ② privacy / mode / OBS-scene switches clear the old shot and storyboard and cancel an
 *      in-flight capture;
 *   ③ five same-source "look now" calls produce exactly one real capture (500 ms merge window);
 *   ④ capture failures and privacy refusals are counted in `status.perception.stats`.
 *
 * No real screen, OBS, ffmpeg or attachment store is touched.
 *
 * Run: node --test test/perception-host-wiring.mjs
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

const state = {
  capture: null,
  start: null,
  calls: [],
  starts: 0,
  stops: 0,
  obsScene: 'Main',
  obsScenes: ['Main', 'Other', 'Privacy'],
  obsRequests: [],
  saveGate: null,
  saves: 0,
  deletedAttachments: [],
};
globalThis.__perceptionHostTest = state;

const sightUrl = new URL('../src/host/vision/sight.js', import.meta.url).href;
const obsUrl = new URL('../src/host/vision/obs.js', import.meta.url).href;
const hooks = registerHooks({
  load(url, context, next) {
    if (url === sightUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `const s = globalThis.__perceptionHostTest;
          export const resolveFfmpeg = () => 'fake-ffmpeg';
          export const resolveFfplay = () => null;
          export const capture = (o) => { s.calls.push('powershell'); return s.capture(o); };
          export const captureDesktop = (o) => { s.calls.push('desktop'); return s.capture(o); };
          export const captureDevice = (o) => { s.calls.push('device'); return s.capture(o); };
          export const startStoryboard = (o) => { s.starts += 1; return s.start(o); };
          export const shrinkShot = async () => null;
          // Real index.js/ambient.js import the freshness helpers from sight.js. The module-side
          // tests pin the real implementation; this stub keeps the exact contract the Host reads.
          export const OBSERVATION_TTL_MS = 30000;
          function observationTtl(ttlMs) {
            const value = Number(ttlMs);
            return Number.isFinite(value) && value >= 0 ? value : OBSERVATION_TTL_MS;
          }
          export function freshnessOf(at, now = Date.now(), ttlMs = OBSERVATION_TTL_MS) {
            const stamp = Number(at);
            if (!Number.isFinite(stamp) || stamp <= 0) return { at: null, ageMs: null, stale: true };
            const current = Number(now);
            const ageMs = Number.isFinite(current) ? Math.max(0, current - stamp) : null;
            return { at: stamp, ageMs, stale: ageMs === null ? true : ageMs >= observationTtl(ttlMs) };
          }
          export function readObservation(observation, { now = Date.now(), ttlMs = OBSERVATION_TTL_MS } = {}) {
            const value = observation ?? {};
            const captured = Number(value.capturedAt);
            const stored = Number.isFinite(captured) && captured > 0 ? captured : value.at;
            const freshness = freshnessOf(stored, now, ttlMs);
            const seconds = Math.round(observationTtl(ttlMs) / 1000);
            const hint = freshness.stale
              ? freshness.ageMs === null
                ? '这条观察没有可信的采集时间，不能当作当前事实'
                : \`这条观察已过去 \${Math.round(freshness.ageMs / 1000)} 秒（阈值 \${seconds} 秒），可能已不是当前状态\`
              : '';
            return { ...value, ...freshness, hint };
          }`,
      };
    }
    if (url === obsUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `export async function connectObs() { return {
          async request(type, data) {
            const s = globalThis.__perceptionHostTest;
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
            if (type === 'GetVirtualCamStatus') return { outputActive: false };
            return {};
          },
          close() {},
        }; }`,
      };
    }
    return next(url, context);
  },
});
const { ambientStartSource, apply, perceptionView } = await import('../src/host/index.js');
hooks.deregister();

const server = createServer((socket) => socket.end());
before(async () => { await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); });
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  delete globalThis.__perceptionHostTest;
});

const TYPE_CHECKS = {
  object: (value) => value !== null && typeof value === 'object' && !Array.isArray(value),
  array: (value) => Array.isArray(value),
  string: (value) => typeof value === 'string',
  number: (value) => typeof value === 'number' && Number.isFinite(value),
  integer: (value) => Number.isInteger(value),
  boolean: (value) => typeof value === 'boolean',
  null: (value) => value === null,
};

function validate(schema, value, path = 'value') {
  if (Object.hasOwn(schema, 'oneOf')) {
    const matches = schema.oneOf.filter((candidate) => {
      try {
        validate(candidate, value, path);
        return true;
      } catch {
        return false;
      }
    });
    assert.equal(matches.length, 1, `${path} must match exactly one oneOf branch`);
    return;
  }
  if (Object.hasOwn(schema, 'type')) {
    assert.ok(TYPE_CHECKS[schema.type](value), `${path} must be of type ${schema.type}`);
  }
  if (schema.type === 'object') {
    for (const key of schema.required ?? []) assert.ok(Object.hasOwn(value, key), `${path}.${key} is required`);
    const properties = schema.properties ?? {};
    for (const [key, child] of Object.entries(properties)) {
      if (Object.hasOwn(value, key)) validate(child, value[key], `${path}.${key}`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        assert.ok(Object.hasOwn(properties, key), `"${path}.${key}" is not a declared property`);
      }
    }
  }
}

function fakeSession(take) {
  const done = deferred();
  let stopped = false;
  return {
    engine: 'fake',
    sourceKind: 'screen',
    take,
    stats: () => ({ frames: 8, sheets: 1, engine: 'fake' }),
    stop() {
      if (stopped) return;
      stopped = true;
      state.stops += 1;
      done.resolve();
    },
    done: done.promise,
  };
}

async function fixture(t, { attachments = true, llm = true } = {}) {
  state.capture = null;
  state.start = null;
  state.calls = [];
  state.starts = 0;
  state.stops = 0;
  state.obsScene = 'Main';
  state.obsScenes = ['Main', 'Other', 'Privacy'];
  state.obsRequests = [];
  state.saveGate = null;
  state.saves = 0;
  state.deletedAttachments = [];

  const root = await mkdtemp(join(tmpdir(), 'dsh-perception-host-'));
  const tools = new Map();
  const routes = new Map();
  const disposers = [];
  const effect = (fn) => {
    const cleanup = fn();
    if (typeof cleanup === 'function') disposers.push(cleanup);
    return cleanup;
  };
  let saved = 0;
  const attachmentsService = {
    async saveImage({ data, mediaType, name }) {
      state.saves += 1;
      if (state.saveGate !== null) await state.saveGate;
      saved += 1;
      return { id: `att-${saved}`, mediaType, name, bytes: data.length };
    },
    async deleteImage(attachment) {
      state.deletedAttachments.push(attachment);
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
      if (service === 'attachments') return attachments ? attachmentsService : undefined;
      if (service === 'llm') return llm ? llmService : undefined;
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
  });
  t.after(() => cleanupRoot(root, disposers));

  const exec = (overrides = {}) => ({
    ...overrides,
    agent: overrides.agent ?? {
      session: { requestHeader: () => ({ config: { provider: 'fake', model: 'vision-model' } }) },
      options: {},
    },
  });
  const call = async (name, args = {}, overrides = {}) => {
    const tool = tools.get(name);
    assert.ok(tool !== undefined, `${name} is registered`);
    return tool.execute(args, exec(overrides));
  };
  const render = (name, value) => {
    const tool = tools.get(name);
    assert.ok(tool !== undefined, `${name} is registered`);
    return tool.output.render({}, value);
  };
  const route = async (path, body, method = 'POST') => {
    let statusCode;
    let payload;
    const req = method === 'GET'
      ? { method: 'GET', url: path }
      : Object.assign(Readable.from([JSON.stringify(body)]), { method: 'POST', url: path });
    const handler = routes.get(path.split('?')[0]);
    assert.ok(handler !== undefined, `route ${path} is registered`);
    await handler(req, {
      writeHead(code) { statusCode = code; },
      end(data) { payload = data; },
    });
    return { status: statusCode, data: payload };
  };
  const action = async (body) => JSON.parse((await route('/assistant/action', body)).data);
  const status = async () => JSON.parse((await route('/assistant/status', undefined, 'GET')).data);
  const shot = (file) => route(`/assistant/shot?path=${encodeURIComponent(file)}`, undefined, 'GET');
  const makeShot = async (dir, { at = Date.now(), name } = {}) => {
    await mkdir(dir, { recursive: true });
    const file = join(dir, name ?? `${randomUUID()}.png`);
    await writeFile(file, Buffer.from('PNGDATA-HOST-WIRING'));
    return {
      file, bytes: 20, width: 320, height: 200, engine: 'fake',
      frames: 4, from: 0, to: 1, at, capturedAt: at,
    };
  };
  const events = async () => {
    const text = await readFile(join(root, 'data', 'events.jsonl'), 'utf8').catch(() => '');
    return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  };
  const waitForEvent = async (type, predicate = () => true) => {
    for (let i = 0; i < 100; i += 1) {
      const hit = (await events()).find((event) => event.type === type && predicate(event));
      if (hit !== undefined) return hit;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return undefined;
  };
  const listScreens = async () => readdir(join(root, 'cache', 'screens')).catch(() => []);
  return { root, call, render, action, status, shot, makeShot, events, waitForEvent, listScreens };
}

const NOW = 1_700_000_000_000;

function mountSimple(root) {
  const tools = new Map();
  const disposers = [];
  const effect = (fn) => {
    const cleanup = fn();
    if (typeof cleanup === 'function') disposers.push(cleanup);
    return cleanup;
  };
  apply({
    effect,
    tools: { register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name); } },
    inject: (_names, callback) => callback({
      effect,
      webServer: { register: () => () => {} },
      systemPrompt: { section: () => () => {} },
    }),
  }, { root, defaultDomain: 'chat', enabled: true });
  return { tools, disposers };
}

test('① 过期证据：status.perception.lastVision.current=false，模型侧带 observedAt 且注明非当前', async (t) => {
  const app = await fixture(t);
  const oldAt = Date.now() - 45_000;
  state.capture = ({ dir }) => app.makeShot(dir, { at: oldAt, name: 'old.png' });

  const seen = await app.call('assistant_see', { reason: 'freshness' });
  assert.equal(seen.ok, true, seen.reason);
  assert.equal(seen.observedAt, oldAt, 'the delivered evidence carries observedAt');
  assert.equal(seen.stale, true);
  assert.equal(seen.current, false, 'an expired observation is not current');
  assert.match(seen.hint, /45 秒/u, 'the hint carries the real age');

  const text = app.render('assistant_see', seen)
    .filter((block) => block.type === 'text').map((block) => block.text).join('\n');
  assert.match(text, /非当前画面/u, 'the model-facing summary says it is not current');
  assert.match(text, /observedAt=\d{4}-\d{2}-\d{2}T/u, 'the model-facing summary names observedAt');

  const snapshot = await app.status();
  assert.equal(snapshot.perception.lastVision.file, seen.file);
  assert.equal(snapshot.perception.lastVision.observedAt, oldAt);
  assert.equal(snapshot.perception.lastVision.stale, true);
  assert.equal(snapshot.perception.lastVision.current, false);
  assert.equal(snapshot.perception.stats.staleDropped, 1, 'the stale demotion is counted once');
  assert.ok(await app.waitForEvent('perception.stale-dropped'),
    'perception.stale-dropped is recorded');

  // A genuinely fresh frame goes back to current:true.
  state.capture = ({ dir }) => app.makeShot(dir, { at: Date.now(), name: 'fresh.png' });
  const fresh = await app.call('assistant_see', {});
  assert.equal(fresh.ok, true, fresh.reason);
  assert.notEqual(fresh.file, seen.file);
  assert.equal(fresh.current, true);
  const after = await app.status();
  assert.equal(after.perception.lastVision.file, fresh.file);
  assert.equal(after.perception.lastVision.current, true);
});

test('② 进隐私：旧截图与故事板不再交付，在途采集被取消', async (t) => {
  const app = await fixture(t);
  // A live storyboard exists first.
  state.start = async ({ dir }) => fakeSession(() => app.makeShot(dir, { name: 'sheet.png' }));
  assert.equal((await app.call('assistant_watch', { action: 'start' })).ok, true);
  const sheet = await app.call('assistant_watch', { action: 'take' });
  assert.equal(sheet.ok, true, sheet.error);
  assert.equal(sheet.ready, true);
  assert.equal((await app.shot(sheet.file)).status, 200);

  state.capture = ({ dir }) => app.makeShot(dir, { name: 'shot.png' });
  const seen = await app.call('assistant_see', {});
  assert.equal(seen.ok, true, seen.reason);
  assert.equal((await app.status()).perception.lastVision.file, seen.file);
  assert.equal((await app.shot(seen.file)).status, 200);

  const privacy = await app.action({ action: 'vision.mode', mode: 'privacy' });
  assert.equal(privacy.ok, true, privacy.error);
  assert.equal(
    state.obsRequests.some((entry) => entry.type === 'SetCurrentProgramScene'),
    false,
    'privacy is a plugin-side lock and never switches an OBS scene',
  );
  const cleared = await app.status();
  assert.equal(cleared.perception.lastVision, null, 'the old observation is no longer delivered');
  assert.equal(cleared.vision.lastShot, null);
  assert.equal((await app.shot(seen.file)).status, 403, 'the old screenshot is not served');
  assert.equal((await app.shot(sheet.file)).status, 403, 'the old storyboard is not served');
  assert.equal((await app.call('assistant_see', {})).ok, false);
  assert.equal((await app.call('assistant_watch', { action: 'take' })).ok, false);
  assert.deepEqual(await app.listScreens(), [], 'both files are deleted');

  // In-flight capture: privacy must win even when the capture itself ignores cancellation.
  assert.equal((await app.action({ action: 'vision.mode', mode: 'watch' })).ok, true);
  const entered = deferred();
  const finish = deferred();
  state.capture = async ({ dir }) => {
    entered.resolve();
    await finish.promise;
    return app.makeShot(dir, { name: 'late.png' });
  };
  const pending = app.call('assistant_see', {});
  await entered.promise;
  const secondPrivacy = await app.action({ action: 'vision.mode', mode: 'privacy' });
  assert.equal(secondPrivacy.ok, true, secondPrivacy.error);
  finish.resolve();
  const late = await pending;
  assert.equal(late.ok, false, 'the in-flight capture is cancelled');
  assert.match(late.reason, /隐私|作废/u);
  assert.deepEqual(await app.listScreens(), []);
  assert.equal((await app.action({ action: 'vision.mode', mode: 'watch' })).ok, true);
});

test('② 切 OBS 场景：旧截图不再交付，在途场景采集被作废（含外部切换）', async (t) => {
  const app = await fixture(t);
  const scene = await app.action({ action: 'vision.mode', mode: 'scene', scene: 'Main' });
  assert.equal(scene.ok, true, scene.error);
  state.capture = ({ dir }) => app.makeShot(dir, { name: 'scene.png' });
  const seen = await app.call('assistant_see', {});
  assert.equal(seen.ok, true, seen.reason);
  assert.equal(seen.mode, 'scene');
  assert.equal((await app.status()).perception.lastVision.scene, 'Main');

  // Host-side OBS scene switch while in scene mode routes through the mode machine.
  const switched = await app.call('assistant_obs', { action: 'set', scene: 'Other' });
  assert.equal(switched.ok, true, switched.error);
  assert.equal((await app.status()).perception.lastVision, null);
  assert.equal((await app.shot(seen.file)).status, 403);

  // In-flight capture: switching the scene aborts it and deletes the undelivered frame.
  const entered = deferred();
  const finish = deferred();
  state.capture = async ({ dir }) => {
    entered.resolve();
    await finish.promise;
    return app.makeShot(dir, { name: 'late-scene.png' });
  };
  const pending = app.call('assistant_see', {});
  await entered.promise;
  const switchedBack = await app.call('assistant_obs', { action: 'set', scene: 'Main' });
  assert.equal(switchedBack.ok, true, switchedBack.error);
  finish.resolve();
  const late = await pending;
  assert.equal(late.ok, false, 'the in-flight scene capture is invalidated');
  assert.deepEqual(await app.listScreens(), []);

  // External OBS switch (not through the Host): the next look refuses before an old frame ships.
  state.obsScene = 'Other';
  const external = await app.call('assistant_see', {});
  assert.equal(external.ok, false);
  assert.match(external.reason, /场景已切换/u);
  assert.equal((await app.status()).perception.lastVision, null);
});

test('P2-1 缓存命中后切场景：复用前核验来源，旧图作废且不再标 current', async (t) => {
  const app = await fixture(t);
  const scene = await app.action({ action: 'vision.mode', mode: 'scene', scene: 'Main' });
  assert.equal(scene.ok, true, scene.error);
  state.capture = ({ dir }) => app.makeShot(dir, { name: 'cached.png' });

  const first = await app.call('assistant_see', {});
  assert.equal(first.ok, true, first.reason);
  assert.equal(first.current, true);
  assert.equal(state.saves, 1);
  assert.equal(state.calls.filter((name) => name === 'device').length, 1);

  // The cached frame is still inside the 500 ms merge window, but OBS now shows another scene.
  state.obsScene = 'Other';
  const second = await app.call('assistant_see', {});
  t.diagnostic(`cache-then-switch: ok=${second.ok} current=${second.current} reason=${second.reason}`);
  assert.equal(second.ok, false, 'the cached old-scene frame is refused');
  assert.equal(second.current, false);
  assert.match(second.reason, /场景已切换/u);
  assert.equal(second.attachment, null, 'no image is delivered for the stale cache hit');
  assert.equal(state.saves, 1, 'the cache hit is not saved as a second attachment');
  assert.equal(state.calls.filter((name) => name === 'device').length, 1,
    'the old cache is verified and refused, not silently recaptured');
  assert.deepEqual(await app.listScreens(), [], 'the cached screenshot is deleted');
  assert.equal((await app.shot(first.file)).status, 403, 'the old preview is no longer served');
  assert.equal((await app.status()).perception.lastVision, null);
});

test('P2-1 附件保存期间切场景：最终交付前核验来源，刚保存的附件被丢弃', async (t) => {
  const app = await fixture(t);
  const scene = await app.action({ action: 'vision.mode', mode: 'scene', scene: 'Main' });
  assert.equal(scene.ok, true, scene.error);
  state.capture = ({ dir }) => app.makeShot(dir, { name: 'save-race.png' });

  const gate = deferred();
  state.saveGate = gate.promise;
  t.after(() => gate.resolve());
  const pending = app.call('assistant_see', {});
  let early = null;
  void pending.then((value) => { early = value; }, (error) => { early = { ok: false, reason: String(error) }; });
  for (let i = 0; i < 200 && state.saves === 0 && early === null; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(early === null, `the call finished before saveImage: ${JSON.stringify(early)}`);
  assert.equal(state.saves, 1, 'the delivery is inside saveImage');
  // OBS switches while the attachment bytes are being written.
  state.obsScene = 'Other';
  gate.resolve();

  const result = await pending;
  t.diagnostic(`switch-during-save: ok=${result.ok} stale=${result.stale} current=${result.current} `
    + `attachments=${state.saves} deleted=${state.deletedAttachments.length}`);
  assert.equal(result.ok, false, 'the late frame is refused');
  assert.equal(result.stale, true, 'the refusal says the observation is stale');
  assert.equal(result.current, false);
  assert.equal(result.attachment, null);
  assert.equal(state.saves, 1);
  assert.equal(state.deletedAttachments.length, 1, 'the just-saved attachment is dropped');
  assert.equal(state.deletedAttachments[0].id, 'att-1');
  assert.deepEqual(await app.listScreens(), [], 'the screenshot file is deleted too');
  assert.equal((await app.status()).perception.lastVision, null);
  const events = await app.events();
  assert.equal(events.some((event) => event.type === 'vision.delivered'), false,
    'a stale frame never records delivery');
  assert.equal(events.some((event) => event.type === 'vision.delivery.refused'
    && event.payload.stage === 'source'), true, 'the refusal names the source stage');
});

test('③ 同源连点 5 次只产生 1 次采集，合并事件记录 count=5', async (t) => {
  const app = await fixture(t);
  const gate = deferred();
  state.capture = async ({ dir }) => {
    await gate.promise;
    return app.makeShot(dir, { name: 'burst.png' });
  };
  const burst = Array.from({ length: 5 }, () => app.call('assistant_see', { reason: 'burst' }));
  for (let i = 0; i < 100 && state.calls.length === 0; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(state.calls.filter((name) => name === 'desktop').length, 1,
    'only one real capture has started while all five calls are pending');
  gate.resolve();
  const results = await Promise.all(burst);
  assert.ok(results.every((result) => result.ok === true),
    `all five calls are served: ${results.map((result) => result.reason).join('; ')}`);
  assert.equal(state.calls.filter((name) => name === 'desktop').length, 1,
    'five clicks produced exactly one real capture');

  const snapshot = await app.status();
  assert.equal(snapshot.perception.stats.captures, 1);
  assert.equal(snapshot.perception.stats.coalesced, 4);
  let coalesced = [];
  for (let i = 0; i < 100; i += 1) {
    coalesced = (await app.events()).filter((event) => event.type === 'perception.coalesced');
    if (coalesced.length >= 1 && Math.max(...coalesced.map((event) => Number(event.payload.count))) === 5) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(coalesced.length >= 1, 'perception.coalesced is recorded');
  assert.equal(Math.max(...coalesced.map((event) => Number(event.payload.count))), 5);
});

test('④ 采集失败与隐私拒绝进入 status.perception.stats', async (t) => {
  const app = await fixture(t);
  const privacy = await app.action({ action: 'vision.mode', mode: 'privacy' });
  assert.equal(privacy.ok, true, privacy.error);
  const refused = await app.call('assistant_see', {});
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /隐私/u);
  let snapshot = await app.status();
  assert.ok(snapshot.perception.stats.rejected >= 1, 'the privacy refusal is counted');
  assert.equal(snapshot.perception.lastVision, null);
  assert.ok(await app.waitForEvent('perception.rejected', (event) => /隐私/u.test(event.payload.reason)),
    'perception.rejected carries the privacy reason');

  assert.equal((await app.action({ action: 'vision.mode', mode: 'watch' })).ok, true);
  state.capture = async () => { throw new Error('fake capture exploded'); };
  const failed = await app.call('assistant_see', {});
  assert.equal(failed.ok, false);
  assert.match(failed.reason, /fake capture exploded/u);
  snapshot = await app.status();
  assert.ok(snapshot.perception.stats.failed >= 1, 'the capture failure is counted');
  assert.ok(snapshot.perception.stats.captures >= 1, 'the attempt is still visible');
});

test('the tool schemas declare observedAt/current and additionalProperties:false still holds', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-perception-wiring-'));
  const { tools, disposers } = mountSimple(root);
  t.after(() => cleanupRoot(root, disposers));

  const see = tools.get('assistant_see');
  assert.ok(see !== undefined, 'assistant_see is registered');
  for (const field of ['at', 'capturedAt', 'observedAt', 'ageMs', 'stale', 'current', 'hint']) {
    assert.ok(Object.hasOwn(see.output.schema.properties, field), `assistant_see declares ${field}`);
    assert.ok(see.output.schema.required.includes(field), `assistant_see requires ${field}`);
  }

  const vision = tools.get('assistant_vision');
  const branch = vision.output.schema.properties.lastShot.oneOf[0];
  for (const field of ['at', 'capturedAt', 'observedAt', 'ageMs', 'stale', 'current', 'generation', 'hint']) {
    assert.ok(Object.hasOwn(branch.properties, field), `lastShot declares ${field}`);
  }
  const staleShot = perceptionView({
    file: 'shot.png', source: 'watch', engine: 'ffmpeg', ts: NOW, width: 1280, height: 720,
    capturedAt: NOW - 45_000, at: NOW - 45_000, observedAt: NOW - 45_000, generation: 3,
  }, NOW);
  assert.equal(staleShot.observedAt, NOW - 45_000);
  assert.equal(staleShot.current, false);
  validate(branch, staleShot, 'lastShot');
  validate(vision.output.schema.properties.lastShot, null, 'lastShot');

  const ambient = tools.get('assistant_ambient');
  assert.ok(Object.hasOwn(ambient.output.schema.properties, 'source'), 'assistant_ambient declares source');
  assert.ok(ambient.output.schema.required.includes('source'), 'assistant_ambient requires source');
});

test('a loopback ambient endpoint classifies as loopback and carries the ambient.source event', () => {
  const loopback = ambientStartSource('CABLE Output (VB-Audio Virtual Cable)');
  assert.equal(loopback.source, 'loopback');
  assert.equal(loopback.device, 'CABLE Output (VB-Audio Virtual Cable)');
  assert.deepEqual(loopback.event, {
    type: 'ambient.source',
    payload: { source: 'loopback', device: 'CABLE Output (VB-Audio Virtual Cable)' },
  });

  const mic = ambientStartSource('Microphone (Realtek(R) Audio)');
  assert.equal(mic.source, 'mic');
  assert.deepEqual(mic.event, {
    type: 'ambient.source',
    payload: { source: 'mic', device: 'Microphone (Realtek(R) Audio)' },
  });
});
