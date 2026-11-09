/**
 * P-187 阶段 3 host wiring: the background understanding runtime is mounted, registered as a
 * runtime context AFTER the audiovisual block, and its status projection is a bounded read with no
 * text/paths. A bare mount (no companion turn, no capture, no ASR) must never start real capture or
 * spend a model call just because the block exists.
 *
 * Run: node --test test/vision-understanding-host.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
import { Readable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { disposeAll } from './helpers/cleanup.mjs';
import { DIALOGUE_INJECTION_ORDER } from '../src/host/session/conversation/dialogue-summary.js';

const state = {
  /** Filled by the fixture; the stubbed sight module calls it instead of touching the screen. */
  makeShot: null,
  captures: 0,
  /** Any failed/mis-fired storyboard attempt must be visible to the test. */
  storyboardStarts: 0,
};
globalThis.__visionUnderstandingHostTest = state;

const sightUrl = new URL('../src/host/vision/sight.js', import.meta.url).href;
const hooks = registerHooks({
  load(url, context, next) {
    if (url === sightUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          const s = globalThis.__visionUnderstandingHostTest;
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
const { apply, voiceSessionTarget } = await import('../src/host/index.js');
hooks.deregister();

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-understanding-host-'));
  const tools = new Map();
  const routes = new Map();
  const promptSections = new Map();
  const promptContexts = new Map();
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
        section(definition) {
          promptSections.set(definition.name, definition);
          return () => {};
        },
        context(definition) {
          promptContexts.set(definition.name, definition);
          return () => {};
        },
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
    // 禁止持续采集：裸挂载/隐私路径都不得启动真实故事板。
    evidenceCaptureEnabled: false,
    // 依赖启动与采集 boot 都推远，测试结束前不会到点。
    dependencyBootDelayMs: 60_000,
    evidenceCaptureBootDelayMs: 60_000,
    ...options,
  });

  state.captures = 0;
  state.storyboardStarts = 0;
  state.makeShot = async () => {
    throw new Error('no capture expected in the understanding host test');
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
  return { root, status, action, dispose, promptSections, promptContexts };
}

test('裸挂载：assistant:understanding 已注册且渲染空，status 只给计数不碰采集', async (t) => {
  const app = await fixture(t);
  const understanding = app.promptContexts.get('assistant:understanding');
  assert.ok(understanding !== undefined, 'assistant:understanding 以 runtime context 注册，不是 section');
  assert.equal(app.promptSections.has('assistant:understanding'), false, '动态块不得进入历史 section');
  assert.equal(typeof understanding.text, 'function');
  assert.equal(understanding.text({}), '', '无状态时不产生空块');

  const audiovisual = app.promptContexts.get('assistant:audiovisual');
  assert.ok(audiovisual !== undefined);
  assert.equal(understanding.order, audiovisual.order + 1, 'understanding 紧接 audiovisual');
  assert.ok(understanding.order > DIALOGUE_INJECTION_ORDER);

  const snapshot = await app.status();
  const view = snapshot.vision.understanding;
  assert.ok(view !== undefined, 'status.vision.understanding 暴露只读状态');
  assert.equal(view.runs, 0);
  assert.equal(view.pending, 0);
  assert.equal(view.failures, 0);
  assert.equal(view.stopped, false);
  assert.equal(view.hasState, false);
  assert.deepEqual(view.state, { sceneChars: 0, events: 0, unresolvedChars: 0 });
  assert.equal(JSON.stringify(view).includes('cache'), false, '状态里不含证据路径');
  assert.equal(JSON.stringify(view).includes('frame'), false, '状态里不含帧 id');

  // 裸挂载 / 无真实陪伴轮：既不启动持续采集，也不产生故事板尝试。
  assert.equal(snapshot.vision.evidenceCapture.running, false);
  assert.equal(snapshot.vision.evidenceCapture.startedAt, null);
  assert.equal(state.storyboardStarts, 0, 'understanding 接线不得触发真实采集');
});

test('进入隐私后 understanding 状态仍可读，且只清状态不停止运行时', async (t) => {
  const app = await fixture(t);
  const privacy = await app.action({ action: 'vision.mode', mode: 'privacy' });
  assert.equal(privacy.ok, true, privacy.error);

  const snapshot = await app.status();
  const view = snapshot.vision.understanding;
  assert.ok(view !== undefined);
  assert.equal(typeof view.runs, 'number');
  assert.equal(typeof view.pending, 'number');
  assert.equal(view.stopped, false, '隐私只清状态，不停止运行时');
  assert.equal(view.hasState, false);
  assert.deepEqual(view.state, { sceneChars: 0, events: 0, unresolvedChars: 0 });
  assert.equal(state.storyboardStarts, 0);

  // 退出隐私后运行时仍可用（clear 会重建调度器）。
  const normal = await app.action({ action: 'vision.mode', mode: 'watch' });
  assert.equal(normal.ok, true, normal.error);
  const after = await app.status();
  assert.equal(after.vision.understanding.stopped, false);
  assert.deepEqual(after.vision.understanding.state, { sceneChars: 0, events: 0, unresolvedChars: 0 });
});

test('测试缝：注入 understandingAnalyzer 时连续渲染两次都不探测模型、不抛错', async (t) => {
  let analyzeCalls = 0;
  const app = await fixture(t, {
    understandingAnalyzer: async () => {
      analyzeCalls += 1;
      return '{"sceneSummary":"should not run"}';
    },
  });
  const understanding = app.promptContexts.get('assistant:understanding');
  assert.ok(understanding !== undefined);
  const workspace = join(app.root, 'workspace');
  const companion = {
    id: voiceSessionTarget({ root: app.root }).sessionId,
    session: { header: { cwd: workspace } },
  };
  // 无状态：即使门禁全部满足，渲染仍是 ''，也不允许为了渲染去调模型。
  assert.equal(understanding.text(companion), '');
  assert.equal(understanding.text(companion), '');
  assert.equal(analyzeCalls, 0, '只读渲染不得触发分析');
  assert.equal(state.storyboardStarts, 0);

  const snapshot = await app.status();
  assert.equal(snapshot.vision.understanding.runs, 0);
  assert.deepEqual(snapshot.vision.understanding.state, { sceneChars: 0, events: 0, unresolvedChars: 0 });
});
