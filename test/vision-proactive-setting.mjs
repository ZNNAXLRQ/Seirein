/**
 * P-187 阶段 5 设置页「主动回应」开关（宿主侧）回归。
 *
 * 固定契约：
 *   POST /assistant/action  body `{ action: 'vision.proactive', enabled: boolean }`
 *   成功 `{ ok: true, enabled: boolean }`；失败 `{ ok: false, error: string }`
 *   /assistant/status 的 `vision.proactive.enabled` 为有效布尔值；默认开启。
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
  const dispose = async () => disposeAll(disposers.splice(0));

  t.after(async () => {
    await dispose();
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
  return { root, status, action, settingsPath, storedSettings, dispose };
}

test('1. 裸挂载：vision.proactive.enabled 默认 true，不启动真实采集', async (t) => {
  const app = await fixture(t);
  const snapshot = await app.status();
  const view = snapshot.vision.proactive;
  assert.ok(view !== undefined, 'status.vision.proactive 应存在');
  assert.equal(view.enabled, true, '没有存过设置时默认开启');
  assert.equal(view.pending, 0);
  assert.equal(state.storyboardStarts, 0, '设置接线不得触发真实采集');
  assert.equal(state.captures, 0);
});

test('2. 关闭：动作成功、status 立即生效、settings.json 持久化', async (t) => {
  const app = await fixture(t);

  const disabled = await app.action({ action: 'vision.proactive', enabled: false });
  assert.deepEqual(disabled, { ok: true, enabled: false });

  const snapshot = await app.status();
  assert.equal(snapshot.vision.proactive.enabled, false);
  const stored = await app.storedSettings();
  assert.equal(stored.proactive?.enabled, false, 'settings.json 里 proactive.enabled 应为 false');
  assert.equal(state.storyboardStarts, 0);
});

test('3. 非法 enabled：ok:false 且状态与磁盘都不变', async (t) => {
  const app = await fixture(t);

  // 先落到 false，再确认非法请求不会把它改回 true。
  assert.deepEqual(
    await app.action({ action: 'vision.proactive', enabled: false }),
    { ok: true, enabled: false },
  );
  const before = await app.status();

  const bad = await app.action({ action: 'vision.proactive', enabled: 'false' });
  assert.equal(bad.ok, false, '非布尔 enabled 必须拒绝');
  assert.equal(typeof bad.error, 'string');
  assert.ok(bad.error.length > 0, '失败必须带 error 字符串');

  const after = await app.status();
  assert.equal(after.vision.proactive.enabled, before.vision.proactive.enabled);
  assert.equal(after.vision.proactive.enabled, false);
  assert.equal((await app.storedSettings()).proactive?.enabled, false);
});

test('4. 再次开启：动作成功、status 为 true、settings.json 持久化', async (t) => {
  const app = await fixture(t);

  assert.deepEqual(
    await app.action({ action: 'vision.proactive', enabled: false }),
    { ok: true, enabled: false },
  );
  const enabled = await app.action({ action: 'vision.proactive', enabled: true });
  assert.deepEqual(enabled, { ok: true, enabled: true });

  const snapshot = await app.status();
  assert.equal(snapshot.vision.proactive.enabled, true);
  assert.equal((await app.storedSettings()).proactive?.enabled, true);
  assert.equal(state.storyboardStarts, 0, '开关动作不启动真实采集');
});
