/**
 * P-187 阶段 5 设置页「主动回应」开关 + 通过率（宿主侧）回归。
 *
 * 固定契约：
 *   POST /assistant/action  body `{ action: 'vision.proactive', enabled: boolean, rate?: number }`
 *   成功 `{ ok: true, enabled: boolean, rate: number }`；失败 `{ ok: false, error: string }`
 *   `/assistant/status` 的 `vision.proactive.enabled` 为有效布尔值、`.rate` 为 0–100；默认开启、100%。
 *   `rate` 省略（旧客户端）时保持当前值，从未保存过则为 100，绝不清成 undefined。
 *
 * 裸挂载（关闭持续采集、依赖/采集 boot 推远）不启动真实采集；动作只写 fixture 根目录的
 * data/settings.json，状态下一次读取即生效，不需要重启。
 *
 * Run: node --test test/vision-proactive-setting.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
import { Readable } from 'node:stream';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { disposeAll } from './helpers/cleanup.mjs';

const state = {
  captures: 0,
  storyboardStarts: 0,
};
globalThis.__visionProactiveSettingTest = state;

const sightUrl = new URL('../src/host/vision/sight.js', import.meta.url).href;
const hooks = registerHooks({
  load(url, context, next) {
    if (url === sightUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          const s = globalThis.__visionProactiveSettingTest;
          export const resolveFfmpeg = () => null;
          export const resolveFfplay = () => null;
          export const capture = () => { throw new Error('real capture forbidden'); };
          export const captureDesktop = capture;
          export const captureDevice = capture;
          export const startStoryboard = () => {
            s.storyboardStarts = (s.storyboardStarts ?? 0) + 1;
            throw new Error('real capture forbidden');
          };
          export const OBSERVATION_TTL_MS = 30000;
          export function readObservation(observation, { now = Date.now(), ttlMs = 30000 } = {}) {
            const value = observation ?? {};
            const at = Number(value.capturedAt ?? value.at);
            const ageMs = Number.isFinite(at) && at > 0 ? Math.max(0, now - at) : null;
            return { ...value, at: ageMs === null ? null : at, ageMs, stale: ageMs === null || ageMs >= ttlMs, hint: '' };
          }`,
      };
    }
    return next(url, context);
  },
});
const { apply } = await import('../src/host/index.js');
hooks.deregister();

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-proactive-setting-'));
  const tools = new Map();
  const routes = new Map();
  const disposers = [];
  const effect = (fn) => {
    const cleanup = fn();
    if (typeof cleanup === 'function') disposers.push(cleanup);
    return cleanup;
  };
  const attachments = {
    async saveImage({ data, mediaType, name }) {
      return { id: 'att-1', mediaType, name, bytes: data.length };
    },
    async deleteImage() {},
  };
  const llm = {
    async resolveModelInfo(provider, model) {
      return { provider, id: model, name: model, inputModalities: ['text', 'image'] };
    },
  };
  apply({
    effect,
    get: (service) => (service === 'attachments' ? attachments : service === 'llm' ? llm : undefined),
    tools: { register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name); } },
    inject: (_dependencies, register) => register({
      effect,
      systemPrompt: {
        section() { return () => {}; },
        context() { return () => {}; },
      },
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
    privacyScene: 'Privacy',
    // 裸挂载：禁止持续采集，依赖/采集 boot 推远，测试结束前不会触发真实动作。
    evidenceCaptureEnabled: false,
    dependencyBootDelayMs: 60_000,
    evidenceCaptureBootDelayMs: 60_000,
    ...options,
  });

  state.captures = 0;
  state.storyboardStarts = 0;

  const route = async (path, body, method = 'POST') => {
    const req = method === 'GET'
      ? { method: 'GET', url: path }
      : Object.assign(Readable.from([JSON.stringify(body)]), { method: 'POST', url: path });
    const handler = routes.get(path.split('?')[0]);
    assert.ok(handler !== undefined, `route ${path} is registered`);
    let payload = '';
    await handler(req, {
      writeHead() {},
      end(data) { payload = data ?? ''; },
    });
    return JSON.parse(payload);
  };
  const status = () => route('/assistant/status', undefined, 'GET');
  const action = (body) => route('/assistant/action', body);
  const settingsPath = join(root, 'data', 'settings.json');
  const storedSettings = async () => JSON.parse(await readFile(settingsPath, 'utf8'));
  /** Raw file text (or null when nothing was ever written) is how "rejected means no write" is proven. */
  const rawSettings = async () => {
    try {
      return await readFile(settingsPath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  };
  const dispose = async () => disposeAll(disposers.splice(0));

  t.after(async () => {
    await dispose();
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
  return { root, status, action, settingsPath, storedSettings, rawSettings, dispose };
}

test('1. 裸挂载：vision.proactive 默认开启、rate 100，不启动真实采集', async (t) => {
  const app = await fixture(t);
  const snapshot = await app.status();
  const view = snapshot.vision.proactive;
  assert.ok(view !== undefined, 'status.vision.proactive 应存在');
  assert.equal(view.enabled, true, '没有存过设置时默认开启');
  assert.equal(view.rate, 100, '没有存过通过率时默认 100');
  assert.equal(view.pending, 0);
  assert.equal(state.storyboardStarts, 0, '设置接线不得触发真实采集');
  assert.equal(state.captures, 0);
});

test('2. enabled 与 rate 一次保存：动作、status、settings.json 三处一致', async (t) => {
  const app = await fixture(t);

  const saved = await app.action({ action: 'vision.proactive', enabled: true, rate: 35 });
  assert.deepEqual(saved, { ok: true, enabled: true, rate: 35 });

  const snapshot = await app.status();
  assert.equal(snapshot.vision.proactive.enabled, true);
  assert.equal(snapshot.vision.proactive.rate, 35, 'status 立即读到新通过率');
  const stored = await app.storedSettings();
  assert.equal(stored.proactive?.enabled, true);
  assert.equal(stored.proactive?.rate, 35, 'settings.json 持久化通过的 rate');
  assert.equal(state.storyboardStarts, 0);
});

test('3. rate 0 合法；越界/非整数/字符串/非法类型拒绝且不写', async (t) => {
  const app = await fixture(t);

  const zero = await app.action({ action: 'vision.proactive', enabled: true, rate: 0 });
  assert.deepEqual(zero, { ok: true, enabled: true, rate: 0 }, '0 是合法的「不开口」');
  assert.equal((await app.status()).vision.proactive.rate, 0);
  assert.equal((await app.storedSettings()).proactive?.rate, 0);

  const before = await app.rawSettings();
  for (const bad of [101, -1, '50', 35.5, null, true]) {
    const result = await app.action({ action: 'vision.proactive', enabled: true, rate: bad });
    assert.equal(result.ok, false, `非法 rate ${String(bad)} 必须拒绝`);
    assert.equal(typeof result.error, 'string');
    assert.ok(result.error.length > 0, '失败必须带 error 字符串');
    assert.equal(await app.rawSettings(), before, `非法 rate ${String(bad)} 不得写盘`);
    assert.equal((await app.status()).vision.proactive.rate, 0, 'status 保持上一次合法值');
  }
});

test('4. 非法 enabled 拒绝且不写', async (t) => {
  const app = await fixture(t);
  const before = await app.rawSettings();
  for (const bad of ['false', 0, 1, null]) {
    const result = await app.action({ action: 'vision.proactive', enabled: bad });
    assert.equal(result.ok, false, `非法 enabled ${String(bad)} 必须拒绝`);
    assert.equal(typeof result.error, 'string');
    assert.ok(result.error.length > 0);
    assert.equal(await app.rawSettings(), before, '被拒绝的请求不得写盘');
  }
  const snapshot = await app.status();
  assert.equal(snapshot.vision.proactive.enabled, true, '默认状态未被非法请求改写');
  assert.equal(snapshot.vision.proactive.rate, 100);
});

test('5. 关闭开关保留 rate；再开启时 rate 不变', async (t) => {
  const app = await fixture(t);
  assert.deepEqual(
    await app.action({ action: 'vision.proactive', enabled: true, rate: 35 }),
    { ok: true, enabled: true, rate: 35 },
  );

  const disabled = await app.action({ action: 'vision.proactive', enabled: false });
  assert.deepEqual(disabled, { ok: true, enabled: false, rate: 35 }, '只传 enabled 时回填当前 rate');
  const offSnapshot = await app.status();
  assert.equal(offSnapshot.vision.proactive.enabled, false);
  assert.equal(offSnapshot.vision.proactive.rate, 35, '关闭后 rate 不丢');
  assert.equal((await app.storedSettings()).proactive?.rate, 35);

  const reopened = await app.action({ action: 'vision.proactive', enabled: true });
  assert.deepEqual(reopened, { ok: true, enabled: true, rate: 35 }, '再次开启沿用已保存的 rate');
  assert.equal((await app.status()).vision.proactive.rate, 35);
  assert.equal(state.storyboardStarts, 0, '切换开关不启动真实采集');
});

test('6. 旧客户端只传 enabled：rate 保持当前值，缺省回落到 100，绝不写成 undefined', async (t) => {
  // 新安装、从未保存过设置：旧客户端关闭一次，rate 必须是默认 100。
  const fresh = await fixture(t);
  const freshDisabled = await fresh.action({ action: 'vision.proactive', enabled: false });
  assert.deepEqual(freshDisabled, { ok: true, enabled: false, rate: 100 });
  const freshStored = await fresh.storedSettings();
  assert.equal(freshStored.proactive?.rate, 100, '缺省时写入默认 100');
  assert.equal(typeof freshStored.proactive?.rate, 'number', 'rate 绝不能是 undefined');

  // 已经保存过 60：旧客户端只传 enabled，两个方向都保持 60。
  assert.deepEqual(
    await fresh.action({ action: 'vision.proactive', enabled: true, rate: 60 }),
    { ok: true, enabled: true, rate: 60 },
  );
  const off = await fresh.action({ action: 'vision.proactive', enabled: false });
  assert.deepEqual(off, { ok: true, enabled: false, rate: 60 });
  const on = await fresh.action({ action: 'vision.proactive', enabled: true });
  assert.deepEqual(on, { ok: true, enabled: true, rate: 60 });
  assert.equal((await fresh.storedSettings()).proactive?.rate, 60, '旧客户端的请求不清掉已保存的 rate');
  assert.equal((await fresh.status()).vision.proactive.rate, 60);
});
