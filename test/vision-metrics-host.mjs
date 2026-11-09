/**
 * P-187 阶段 6 host wiring：`/assistant/status` 的 `vision.audiovisual` 数字投影已接线。
 *
 * 裸挂载（关闭持续采集、依赖与采集 boot 推远）不得碰屏幕/模型/语音；隐私动作之后该块仍可读。
 * 只断言计数与形状，绝不要求真实截图或 ASR。
 *
 * Run: node --test test/vision-metrics-host.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
import { Readable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { disposeAll } from './helpers/cleanup.mjs';

const state = {
  makeShot: null,
  captures: 0,
  storyboardStarts: 0,
};
globalThis.__visionMetricsHostTest = state;

const sightUrl = new URL('../src/host/vision/sight.js', import.meta.url).href;
const hooks = registerHooks({
  load(url, context, next) {
    if (url === sightUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          const s = globalThis.__visionMetricsHostTest;
          export const resolveFfmpeg = () => null;
          export const resolveFfplay = () => null;
          export const capture = (options) => s.makeShot(options.dir);
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
  const root = await mkdtemp(join(tmpdir(), 'dsh-metrics-host-'));
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
    // 裸挂载：禁止持续采集，boot 推远，测试结束前不会触发真实动作。
    evidenceCaptureEnabled: false,
    dependencyBootDelayMs: 60_000,
    evidenceCaptureBootDelayMs: 60_000,
    ...options,
  });

  state.captures = 0;
  state.storyboardStarts = 0;
  state.makeShot = async () => {
    throw new Error('no capture expected in the metrics host test');
  };

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
  const dispose = async () => disposeAll(disposers.splice(0));

  t.after(async () => {
    await dispose();
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
  return { root, status, action, dispose };
}

/** 阶段 6 的固定形状：计数全是数字，速率是数字或 null。 */
function assertAudiovisualShape(view) {
  assert.ok(view !== undefined, 'status.vision.audiovisual 应存在');
  assert.ok(Number.isInteger(view.cache.frames) && view.cache.frames >= 0);
  assert.ok(Number.isInteger(view.cache.bytes) && view.cache.bytes >= 0);
  assert.ok(Number.isInteger(view.cache.pinnedFrames) && view.cache.pinnedFrames >= 0);
  for (const key of ['entries', 'chars', 'finals']) {
    assert.equal(typeof view.media[key], 'number', `media.${key} 应是数字`);
  }
  for (const key of ['sessions', 'attached', 'expired']) {
    assert.equal(typeof view.comment[key], 'number', `comment.${key} 应是数字`);
  }
  for (const key of ['runs', 'failures', 'droppedEvents', 'eventCount', 'sceneChars']) {
    assert.equal(typeof view.understanding[key], 'number', `understanding.${key} 应是数字`);
  }
  assert.equal(typeof view.understanding.hasState, 'boolean');
  assert.equal(typeof view.proactive.enabled, 'boolean');
  for (const key of ['pending', 'spoken', 'ignored']) {
    assert.equal(typeof view.proactive[key], 'number', `proactive.${key} 应是数字`);
  }
  assert.equal(typeof view.proactive.quiet, 'boolean');
  for (const key of ['understandingPerMinute', 'proactivePerHour']) {
    const rate = view.rates[key];
    assert.ok(rate === null || (typeof rate === 'number' && Number.isFinite(rate)),
      `rates.${key} 应是数字或 null`);
  }
  assert.ok(view.at === null || typeof view.at === 'number');
  assert.equal(JSON.stringify(view).includes('"id"'), false, '投影不含 id');
}

test('裸挂载：status.vision.audiovisual 存在且计数全为 0', async (t) => {
  const app = await fixture(t);
  const snapshot = await app.status();
  const view = snapshot.vision.audiovisual;

  assertAudiovisualShape(view);
  assert.equal(view.cache.frames, 0);
  assert.equal(view.cache.bytes, 0);
  assert.equal(view.cache.pinnedFrames, 0);
  assert.equal(view.media.entries, 0);
  assert.equal(view.media.chars, 0);
  assert.equal(view.media.finals, 0);
  assert.deepEqual(view.comment, { sessions: 0, attached: 0, expired: 0 });
  assert.deepEqual(view.understanding, {
    runs: 0,
    failures: 0,
    droppedEvents: 0,
    eventCount: 0,
    sceneChars: 0,
    hasState: false,
  });
  assert.equal(view.proactive.enabled, true, '默认启用');
  assert.equal(view.proactive.pending, 0);
  assert.equal(view.proactive.spoken, 0);
  assert.equal(view.proactive.ignored, 0);
  // 刚挂载 uptime > 0，速率按公式可得数字；只要求契约允许的“数字或 null”。
  for (const rate of Object.values(view.rates)) {
    assert.ok(rate === null || typeof rate === 'number');
  }

  const serialized = JSON.stringify(view);
  assert.equal(serialized.includes(app.root), false, 'JSON 不含 fixture 路径');
  assert.equal(serialized.includes(join(app.root, 'cache')), false, 'JSON 不含证据目录');
  assert.equal(serialized.includes('ev-'), false, 'JSON 不含帧 id');
  assert.equal(state.storyboardStarts, 0, '数字投影不得触发真实采集');
});

test('隐私动作后 audiovisual 仍可读，计数保持 0 且不启动采集', async (t) => {
  const app = await fixture(t);
  const privacy = await app.action({ action: 'vision.mode', mode: 'privacy' });
  assert.equal(privacy.ok, true, privacy.error);

  const after = (await app.status()).vision.audiovisual;
  assertAudiovisualShape(after);
  assert.equal(after.cache.frames, 0);
  assert.equal(after.media.entries, 0);
  assert.equal(after.understanding.runs, 0);
  assert.equal(after.understanding.hasState, false);
  assert.equal(typeof after.proactive.enabled, 'boolean');
  assert.equal(JSON.stringify(after).includes(app.root), false, '隐私后也不泄漏路径');
  assert.equal(state.storyboardStarts, 0, '隐私动作不得触发真实采集');

  // 退出隐私后同一投影仍在，不改变其他状态字段。
  const normal = await app.action({ action: 'vision.mode', mode: 'watch' });
  assert.equal(normal.ok, true, normal.error);
  const restored = (await app.status()).vision.audiovisual;
  assertAudiovisualShape(restored);
  assert.equal(restored.cache.frames, 0);
  assert.equal(state.storyboardStarts, 0);
});
