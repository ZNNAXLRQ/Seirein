/**
 * 持续观看启动门禁拆分回归。
 *
 * 覆盖：
 *   1. 显式 true + 启动 boot：无需任何陪伴轮/点击即进入 capturing；companionSeen 仍为 false；
 *   2. 缺失字段安全迁移为 false；显式 false 重启仍关闭；
 *   3. 隐私暂停与退出恢复；在途启动被隐私取消且迟到会话被收掉；
 *   4. 依赖缺失属确定性失败、不自动重试；依赖恢复后显式启动可恢复；
 *   5. 首轮前只做有界缓存，零理解调用/零主动候选；首轮后的首次理解不回看启动以来的旧帧；
 *   6. 设置页持续观看文案与“显式开启/重启保持关闭”一致。
 *
 * 全部使用可注入的假 sight 故事板：不碰屏幕、ffmpeg、OBS 或模型。
 * Run: node --test test/continuous-autostart.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
import { Readable } from 'node:stream';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { disposeAll } from './helpers/cleanup.mjs';

const state = {
  ffmpegPath: 'C:/fake/ffmpeg.exe',
  storyboardStarts: 0,
  takes: 0,
  sheets: 0,
  stops: 0,
  sheetsToTake: 0,
  failStarts: 0,
  startStoryboard: null,
};
globalThis.__continuousAutostartTest = state;

const sightUrl = new URL('../src/host/vision/sight.js', import.meta.url).href;
const hooks = registerHooks({
  load(url, context, next) {
    if (url === sightUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          const s = globalThis.__continuousAutostartTest;
          export const resolveFfmpeg = () => s.ffmpegPath;
          export const resolveFfplay = () => null;
          export const capture = () => { throw new Error('no one-shot capture in continuous autostart test'); };
          export const captureDesktop = capture;
          export const captureDevice = capture;
          export const startStoryboard = (options) => {
            s.storyboardStarts = (s.storyboardStarts ?? 0) + 1;
            if (s.failStarts > 0) {
              s.failStarts -= 1;
              throw new Error('temporary storyboard failure');
            }
            return s.startStoryboard(options);
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeSession(options) {
  let finish = null;
  const done = new Promise((resolve) => { finish = resolve; });
  let stopped = false;
  return {
    engine: 'fake',
    sourceKind: options?.source?.kind === 'obs' ? 'obs' : 'desktop',
    async take() {
      state.takes += 1;
      if (stopped || state.sheetsToTake <= 0) return null;
      state.sheetsToTake -= 1;
      const dir = options.dir;
      await mkdir(dir, { recursive: true });
      const file = join(dir, `sheet-${++state.sheets}.png`);
      await writeFile(file, Buffer.from(`SHEET-${state.sheets}`));
      return {
        file,
        capturedAt: Date.now(),
        width: 320,
        height: 200,
        engine: 'fake',
        frames: 6,
      };
    },
    stop() {
      stopped = true;
      state.stops += 1;
      finish();
    },
    done,
  };
}

async function fixture(t, config = {}, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-continuous-autostart-'));
  state.ffmpegPath = options.ffmpegPath === undefined ? 'C:/fake/ffmpeg.exe' : options.ffmpegPath;
  state.storyboardStarts = 0;
  state.takes = 0;
  state.sheets = 0;
  state.stops = 0;
  state.sheetsToTake = options.sheetsToTake ?? 0;
  state.failStarts = options.failStarts ?? 0;
  state.startStoryboard = options.startStoryboard ?? ((startOptions) => fakeSession(startOptions));

  if (options.settings !== undefined && options.settings !== null) {
    await mkdir(join(root, 'data'), { recursive: true });
    await writeFile(join(root, 'data', 'settings.json'),
      `${JSON.stringify(options.settings, null, 2)}\n`, 'utf8');
  }

  const tools = new Map();
  const routes = new Map();
  const listeners = new Map();
  const disposers = [];
  const effect = (fn) => {
    const cleanup = fn();
    if (typeof cleanup === 'function') disposers.push(cleanup);
    return cleanup;
  };
  const on = (type, handler) => {
    const list = listeners.get(type) ?? [];
    list.push(handler);
    listeners.set(type, list);
    return () => {
      const current = listeners.get(type) ?? [];
      listeners.set(type, current.filter((entry) => entry !== handler));
    };
  };
  const attachments = {
    async saveImage({ mediaType, name, data }) {
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
    on,
    get: (service) => (service === 'attachments' ? attachments : service === 'llm' ? llm : undefined),
    tools: { register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name); } },
    inject: (_dependencies, register) => register({
      effect,
      systemPrompt: { section: () => () => {}, context: () => () => {} },
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
    dependencyBootDelayMs: 60_000,
    evidenceCaptureTickMs: 10,
    understandingMinIntervalMs: 10,
    ...config,
  });

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
  const workspace = join(root, 'workspace');
  const companionId = voiceSessionTarget({ root }).sessionId;
  const companionAgent = (extra = {}) => ({
    id: companionId,
    options: {},
    session: {
      id: companionId,
      header: { cwd: workspace },
      requestHeader: () => ({ config: { provider: 'fake', model: 'vision-model' } }),
    },
    ...extra,
  });
  const runPreStep = async ({ agent, turn = 1, step = 1, text = '你好' }) => {
    const payload = {
      step,
      turn,
      agent,
      signal: undefined,
      messages: [{
        id: `msg-${turn}`,
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text }],
      }],
    };
    const handlers = listeners.get('agent/pre-step') ?? [];
    let index = 0;
    const next = async () => {
      if (index >= handlers.length) return { kind: 'ok', messages: [] };
      const handler = handlers[index];
      index += 1;
      return handler(payload, next);
    };
    return next();
  };
  const waitFor = async (predicate, label, timeoutMs = 3000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await sleep(10);
    }
    assert.fail(`timed out waiting for ${label}`);
  };
  const dispose = async () => disposeAll(disposers.splice(0));

  t.after(async () => {
    await dispose();
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
  return { root, status, action, runPreStep, companionAgent, companionId, waitFor, dispose };
}

// ---------------------------------------------------------------------------
// 1. 显式 true：启动 boot 直接采集，无需首轮/点击
// ---------------------------------------------------------------------------
test('1. 显式 true：新 mount 无对话也自动 capturing，companionSeen 保持 false', async (t) => {
  const app = await fixture(t, {}, {
    settings: { vision: { continuousView: true } },
    sheetsToTake: Infinity,
  });
  await app.waitFor(async () => (await app.status()).vision.continuous.state === 'capturing',
    'boot to start capture without any companion turn');
  await app.waitFor(async () => state.takes > 0, 'the storyboard to take its first frame');
  const view = (await app.status()).vision.continuous;
  assert.equal(view.enabled, true);
  assert.equal(view.capturing, true);
  assert.equal(view.companionSeen, false, '采集不伪造陪伴轮');
  assert.equal(view.understandingEnabled, false, '理解仍被首轮门禁挡住');
  assert.equal(view.proactiveEnabled, false, '主动回应仍被首轮门禁挡住');
  assert.equal(state.storyboardStarts, 1, 'boot 只尝试一次');
  assert.ok(state.takes > 0, '故事板已经开始取帧');
});

// ---------------------------------------------------------------------------
// 2. 缺失字段 / 显式 false：启动不采集
// ---------------------------------------------------------------------------
test('2. 缺失字段安全迁移为 false；显式 false 重启后仍关闭', async (t) => {
  const missing = await fixture(t, { evidenceCaptureBootDelayMs: 10 }, {
    settings: null,
    sheetsToTake: Infinity,
  });
  await sleep(120);
  let view = (await missing.status()).vision.continuous;
  assert.equal(view.enabled, false);
  assert.equal(view.state, 'off');
  assert.equal(view.capturing, false);
  assert.equal(state.storyboardStarts, 0, '旧 settings 没有该字段时不得自动采集');

  const disabled = await fixture(t, { evidenceCaptureBootDelayMs: 10 }, {
    settings: { vision: { continuousView: false } },
    sheetsToTake: Infinity,
  });
  await sleep(120);
  view = (await disabled.status()).vision.continuous;
  assert.equal(view.enabled, false);
  assert.equal(view.state, 'off');
  assert.equal(view.capturing, false);
  assert.equal(state.storyboardStarts, 0, '显式 false 重启后仍不得采集');
});

// ---------------------------------------------------------------------------
// 3. 隐私阻断 / 退出恢复
// ---------------------------------------------------------------------------
test('3. 隐私暂停采集，退出隐私按已保存 true 恢复；companionSeen 不变', async (t) => {
  const app = await fixture(t, {}, {
    settings: { vision: { continuousView: true } },
    sheetsToTake: 0,
  });
  await app.waitFor(async () => (await app.status()).vision.continuous.state === 'capturing',
    'capture before privacy');

  const privacy = await app.action({ action: 'vision.mode', mode: 'privacy' });
  assert.equal(privacy.ok, true, privacy.error);
  let view = (await app.status()).vision.continuous;
  assert.equal(view.enabled, true, '隐私不改变已保存的开关');
  assert.equal(view.state, 'privacy');
  assert.equal(view.capturing, false);
  assert.equal((await app.status()).vision.evidenceCapture.running, false);

  const restored = await app.action({ action: 'vision.mode', mode: 'watch' });
  assert.equal(restored.ok, true, restored.error);
  await app.waitFor(async () => (await app.status()).vision.continuous.state === 'capturing',
    'capture to resume after leaving privacy');
  view = (await app.status()).vision.continuous;
  assert.equal(view.enabled, true);
  assert.equal(view.companionSeen, false);
  assert.equal(view.understandingEnabled, false);
});

// ---------------------------------------------------------------------------
// 4. 在途启动被隐私取消：迟到会话必须收掉
// ---------------------------------------------------------------------------
test('4. 在途启动期间进入隐私：取消启动、迟到会话被停止、不得进入 capturing', async (t) => {
  let release = null;
  let lateSession = null;
  const app = await fixture(t, {}, {
    settings: { vision: { continuousView: true } },
    sheetsToTake: Infinity,
    startStoryboard: (options) => new Promise((resolve) => {
      release = () => {
        lateSession = fakeSession(options);
        resolve(lateSession);
      };
    }),
  });
  await app.waitFor(async () => (await app.status()).vision.continuous.state === 'starting',
    'start in flight');

  const privacy = app.action({ action: 'vision.mode', mode: 'privacy' });
  await sleep(30);
  release();
  const result = await privacy;
  assert.equal(result.ok, true, result.error);
  const view = (await app.status()).vision.continuous;
  assert.equal(view.state, 'privacy');
  assert.equal(view.capturing, false);
  assert.equal((await app.status()).vision.evidenceCapture.running, false);
  assert.equal(state.storyboardStarts, 1, '只发生过一次启动尝试');
  assert.equal(state.stops, 1, '迟到的采集会话已被停止');
  assert.equal(lateSession !== null, true);
});

test('4b. 在途启动期间关闭开关：取消启动并收掉迟到会话，状态保持 off', async (t) => {
  let release = null;
  let lateSession = null;
  const app = await fixture(t, {}, {
    settings: { vision: { continuousView: true } },
    sheetsToTake: Infinity,
    startStoryboard: (options) => new Promise((resolve) => {
      release = () => {
        lateSession = fakeSession(options);
        resolve(lateSession);
      };
    }),
  });
  await app.waitFor(async () => (await app.status()).vision.continuous.state === 'starting',
    'start in flight before close');

  const off = app.action({ action: 'vision.continuousView', enabled: false });
  await sleep(30);
  release();
  const result = await off;
  assert.equal(result.ok, true, result.error);
  assert.equal(result.state, 'off');
  const view = (await app.status()).vision.continuous;
  assert.equal(view.enabled, false);
  assert.equal(view.state, 'off');
  assert.equal(view.capturing, false);
  assert.equal((await app.status()).vision.evidenceCapture.running, false);
  assert.equal(state.storyboardStarts, 1);
  assert.equal(state.stops, 1, '迟到的采集会话已被停止');
  assert.equal(lateSession !== null, true);
});

// ---------------------------------------------------------------------------
// 5. 依赖缺失的确定性失败 / 恢复
// ---------------------------------------------------------------------------
test('5. 缺 ffmpeg：启动失败不自动重试；依赖恢复后显式启动成功', async (t) => {
  const app = await fixture(t, { evidenceCaptureRetryBaseMs: 20 }, {
    settings: { vision: { continuousView: true } },
    ffmpegPath: null,
    sheetsToTake: 0,
  });
  await app.waitFor(async () => (await app.status()).vision.continuous.state === 'failed',
    'deterministic boot failure');
  let view = (await app.status()).vision.continuous;
  assert.match(view.error, /ffmpeg/i);
  assert.equal(view.retryAt, null, '确定性错误不排重试');
  assert.equal(view.capturing, false);
  assert.equal(state.storyboardStarts, 0, '依赖检查在启动故事板之前就失败');

  await sleep(100);
  view = (await app.status()).vision.continuous;
  assert.equal(view.state, 'failed', '不会自己轮询');
  assert.equal(view.retryAt, null);

  state.ffmpegPath = 'C:/fake/ffmpeg.exe';
  const retried = await app.action({ action: 'vision.continuousView', enabled: true });
  assert.equal(retried.ok, true, retried.error);
  await app.waitFor(async () => (await app.status()).vision.continuous.state === 'capturing',
    'capture after dependency recovery');
  assert.equal(state.storyboardStarts, 1);
});

// ---------------------------------------------------------------------------
// 6. 首轮前只缓存、零理解；首次理解只从首轮窗口开始
// ---------------------------------------------------------------------------
test('6. 首轮前零理解调用/零候选；首轮后首次理解不回看启动以来的旧帧', async (t) => {
  const analyzedCapturedAt = [];
  let analyzeCalls = 0;
  const app = await fixture(t, {
    evidenceCaptureTickMs: 10,
    understandingMinIntervalMs: 10,
    understandingAnalyzer: async ({ frames }) => {
      analyzeCalls += 1;
      for (const frame of frames) {
        if (Number.isFinite(frame?.capturedAt)) analyzedCapturedAt.push(frame.capturedAt);
      }
      return { ok: true, text: '{"sceneSummary":"首轮之后的场景"}' };
    },
  }, {
    settings: { vision: { continuousView: true } },
    sheetsToTake: Infinity,
  });

  await app.waitFor(async () => {
    const snapshot = await app.status();
    return snapshot.vision.continuous.state === 'capturing' && snapshot.vision.evidence.frames >= 3;
  }, 'bounded cache to fill before the first companion turn');

  await sleep(150);
  let snapshot = await app.status();
  assert.equal(analyzeCalls, 0, '首轮前不得调用理解模型');
  assert.equal(snapshot.vision.understanding.runs, 0, '首轮前不得有成功理解');
  assert.equal(snapshot.vision.proactive.pending, 0, '首轮前不得产生主动候选');
  assert.equal(snapshot.vision.continuous.lastUnderstandingAt, null);
  assert.ok(snapshot.vision.evidence.frames >= 3, '首轮前仍持续写入有界证据缓存');
  assert.equal(snapshot.vision.continuous.companionSeen, false);

  // 留出首轮前继续采样的时间，确保证据窗口里确实还有“首轮之前”的帧。
  await sleep(40);
  const turnStartedAt = Date.now();
  await app.runPreStep({ agent: app.companionAgent(), turn: 1, text: '你好' });
  await app.waitFor(async () => {
    const current = await app.status();
    return current.vision.continuous.companionSeen === true && analyzeCalls > 0;
  }, 'first understanding after the first companion turn');

  snapshot = await app.status();
  assert.equal(snapshot.vision.continuous.understandingEnabled, true);
  assert.equal(snapshot.vision.continuous.proactiveEnabled, true);
  assert.ok(analyzedCapturedAt.length > 0, '至少分析过一帧');
  assert.ok(analyzedCapturedAt.every((at) => at >= turnStartedAt),
    `首次理解只能使用首轮之后的帧；实际 ${JSON.stringify(analyzedCapturedAt)}，首轮 ${turnStartedAt}`);
});

// ---------------------------------------------------------------------------
// 7. 设置页文案
// ---------------------------------------------------------------------------
test('7. 设置页持续观看文案：需显式开启；启动自动采集；关闭后重启仍关闭', async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = await readFile(join(here, '..', 'client.js'), 'utf8');
  assert.match(source, /需显式开启；开启后启动 DSH 自动采集，关闭后重启仍关闭/u);
  assert.match(source, /启动 DSH 后会自动采集/u);
  assert.match(source, /重启 DSH 都不会重新打开/u);
  assert.doesNotMatch(source, /持续观看默认开启（兼容旧版自动行为）/u);
});
