/**
 * P-187 阶段 5 host wiring:主动回应仲裁已挂进宿主，并只在 `/assistant/status` 暴露有界计数。
 *
 * 裸挂载（无真实陪伴轮、关闭持续采集）不能因此碰屏幕、模型或语音；隐私动作只重置代次，
 * 之后 `vision.proactive` 仍可读。最后一条用透明计时器包装确认 5 秒评估定时器在 dispose
 * 时被清掉（不要求端到端真的开口——那会触发真实 TTS）。
 *
 * Run: node --test test/vision-proactive-host.mjs
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
globalThis.__visionProactiveHostTest = state;

const sightUrl = new URL('../src/host/vision/sight.js', import.meta.url).href;
const hooks = registerHooks({
  load(url, context, next) {
    if (url === sightUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          const s = globalThis.__visionProactiveHostTest;
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
  const root = await mkdtemp(join(tmpdir(), 'dsh-proactive-host-'));
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
  state.makeShot = async () => {
    throw new Error('no capture expected in the proactive host test');
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

/** status.vision.proactive 的固定形状：只有计数/时间/原因，没有候选正文或路径。 */
function assertProactiveShape(view, enabled) {
  assert.ok(view !== undefined, 'status.vision.proactive 应存在');
  assert.equal(view.enabled, enabled);
  assert.equal(typeof view.pending, 'number');
  assert.equal(typeof view.valid, 'number');
  assert.equal(typeof view.counts, 'object');
  for (const key of ['proposed', 'rejected', 'expired', 'evicted', 'duplicate', 'canceled', 'spoken', 'ignored']) {
    assert.equal(typeof view.counts[key], 'number', `counts.${key} 应是数字`);
  }
  assert.equal(typeof view.spokenLastHour, 'number');
  assert.equal(typeof view.consecutiveIgnored, 'number');
  assert.equal(typeof view.canceledEvents, 'number');
  // 供给诊断：把“无成功事件/无 reaction/propose 被拒”与候选过滤分开。
  assert.equal(typeof view.eventsWithReaction, 'number');
  assert.equal(typeof view.proposeCalls, 'number');
  assert.ok(view.lastAdvanceAt === null || typeof view.lastAdvanceAt === 'number');
  assert.ok(view.lastReactionEventId === null || typeof view.lastReactionEventId === 'string');
  assert.ok(view.lastProposeRejectReason === null || typeof view.lastProposeRejectReason === 'string');
  assert.equal(typeof view.advanceStage, 'string');
  // 两阶段门禁只有计数，detail 回查永远不产生模型调用。
  assert.equal(typeof view.detail, 'object');
  assert.equal(view.detail.modelCalls, 0);
  assert.equal(JSON.stringify(view).includes('cache'), false, '状态里不含证据路径');
  assert.equal(JSON.stringify(view).includes('understand:'), false, '状态里不含候选 id/正文');
  assert.equal(JSON.stringify(view).includes('frame'), false, '状态里不含帧 id');
}

test('裸挂载：vision.proactive 可读，默认启用且没有候选/正文', async (t) => {
  const app = await fixture(t);
  const snapshot = await app.status();
  const view = snapshot.vision.proactive;
  assertProactiveShape(view, true);
  assert.equal(view.pending, 0);
  assert.equal(view.valid, 0);
  assert.equal(view.lastTopic, null);
  assert.equal(view.lastSpokenAt, null);
  assert.equal(view.counts.proposed, 0);
  assert.equal(view.advanceStage, 'no-advance', '裸挂载从未成功 advance，不是候选被过滤');
  assert.equal(state.storyboardStarts, 0, '主动接线不得触发真实采集');
});

test('proactiveEnabled:false 时 status 仍可读，只是明确 disabled', async (t) => {
  const app = await fixture(t, { proactiveEnabled: false });
  const snapshot = await app.status();
  const view = snapshot.vision.proactive;
  assertProactiveShape(view, false);
  assert.equal(view.pending, 0);
  assert.equal(state.storyboardStarts, 0);
});

test('隐私动作后主动状态不报错：候选清空、原因可读、累计计数保留', async (t) => {
  const app = await fixture(t);
  const before = (await app.status()).vision.proactive;
  assert.equal(before.counts.proposed, 0);

  const privacy = await app.action({ action: 'vision.mode', mode: 'privacy' });
  assert.equal(privacy.ok, true, privacy.error);

  const after = (await app.status()).vision.proactive;
  assertProactiveShape(after, true);
  assert.equal(after.pending, 0);
  assert.equal(after.lastReason, 'vision-invalidated');
  assert.equal(after.canceledEvents, 0);
  assert.equal(after.counts.proposed, before.counts.proposed, 'reset 保留累计计数');
  assert.equal(state.storyboardStarts, 0);
});

test('dispose 清理 5 秒评估定时器，且卸载不抛错', async (t) => {
  const timers = new Map();
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  globalThis.setInterval = function wrappedSetInterval(fn, delay, ...args) {
    const handle = realSetInterval.call(globalThis, fn, delay, ...args);
    if (delay === 5_000) timers.set(handle, false);
    return handle;
  };
  globalThis.clearInterval = function wrappedClearInterval(handle) {
    if (timers.has(handle)) timers.set(handle, true);
    return realClearInterval.call(globalThis, handle);
  };
  try {
    const app = await fixture(t);
    // 挂载后主动块可读，说明接线完成；此时 5 秒定时器应已登记。
    const view = (await app.status()).vision.proactive;
    assertProactiveShape(view, true);
    assert.ok(timers.size >= 1, '5 秒评估定时器应已安装');

    await app.dispose();
    assert.equal([...timers.values()].every(Boolean), true, 'dispose 必须清掉 5 秒评估定时器');
  } finally {
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
  }
});
