/**
 * P-187 阶段 6 —— 持续观看的独立设置与状态机（宿主侧）。
 *
 * 这里驱动真实注册的 `agent/pre-step` 瀑布与 `/assistant/action`，但 sight.js 被替换成
 * 可注入的假故事板：不会碰屏幕、ffmpeg、OBS 或模型。重点覆盖：
 *   1. 无记录默认 true；显式 false 写盘并在重挂载后保留；
 *   2. 关闭后首轮 / 切模式 / feature enable / retry 都不启动采集；
 *   3. 只有真实陪伴轮才置位 companionSessionSeen；子代理 / 编码代理 / 维护轮不算；
 *   4. 隐私暂停与恢复；确定性错误不轮询，依赖变化后可重试；
 *   5. status.vision.continuous 的字段与 `starting` 不冒充 `capturing`。
 *
 * Run: node --test test/vision-continuous-view.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
import { Readable } from 'node:stream';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { disposeAll } from './helpers/cleanup.mjs';

const state = {
  ffmpegPath: 'C:/fake/ffmpeg.exe',
  storyboardStarts: 0,
  takes: 0,
  sheets: 0,
  stops: 0,
  /** 每个故事板会话还能取多少张变化帧；Infinity 表示一直有变化。 */
  sheetsToTake: 0,
  /** 前 N 次 startStoryboard 抛非确定性错误。 */
  failStarts: 0,
  /** 测试可替换：返回一个假会话或一个可控 Promise。 */
  startStoryboard: null,
  /** 最近一次 startStoryboard 收到的入参，用来核对分辨率。 */
  startOptions: null,
};
globalThis.__visionContinuousHostTest = state;

const sightUrl = new URL('../src/host/vision/sight.js', import.meta.url).href;
const hooks = registerHooks({
  load(url, context, next) {
    if (url === sightUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          const s = globalThis.__visionContinuousHostTest;
          export const resolveFfmpeg = () => s.ffmpegPath;
          export const resolveFfplay = () => null;
          export const capture = () => { throw new Error('no one-shot capture in continuous host test'); };
          export const captureDesktop = capture;
          export const captureDevice = capture;
          export const startStoryboard = (options) => {
            s.storyboardStarts = (s.storyboardStarts ?? 0) + 1;
            s.startOptions = options;
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

/** 一个假故事板会话：take() 返回真实小文件，让宿主走完复制/登记逻辑。 */
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
  const root = options.root ?? await mkdtemp(join(tmpdir(), 'dsh-continuous-view-'));
  state.ffmpegPath = options.ffmpegPath === undefined ? 'C:/fake/ffmpeg.exe' : options.ffmpegPath;
  state.storyboardStarts = 0;
  state.takes = 0;
  state.sheets = 0;
  state.stops = 0;
  state.sheetsToTake = options.sheetsToTake ?? 0;
  state.failStarts = options.failStarts ?? 0;
  state.startStoryboard = options.startStoryboard ?? ((startOptions) => fakeSession(startOptions));
  state.startOptions = null;

  // 可预置 settings.json（例如显式 false）；未指定时按“用户已显式开启”准备，因为缺失字段
  // 现在安全迁移为 false。传 settings:null 可模拟旧文件里完全没有该字段。
  const settings = options.settings === undefined
    ? { vision: { continuousView: true } }
    : options.settings;
  if (settings !== null) {
    await mkdir(join(root, 'data'), { recursive: true });
    await writeFile(join(root, 'data', 'settings.json'), `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
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
    evidenceCaptureBootDelayMs: 60_000,
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
  /**
   * 跑一次真实的 `agent/pre-step` 瀑布（与循环一致：每个监听器按注册顺序）。
   * handler[0] 里包含 prepareVisionForTurn；第二段是会话延续上下文，不影响本测试。
   */
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
  const waitFor = async (predicate, label, timeoutMs = 2500) => {
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
  return {
    root, status, action, runPreStep, companionAgent, companionId, waitFor, dispose,
    listeners, routes,
  };
}

// ---------------------------------------------------------------------------
// 1. 默认值与显式持久化
// ---------------------------------------------------------------------------

test('1. 缺失字段安全迁移为 false；显式 true 立即采集并落盘；显式 false 保留', async (t) => {
  // 旧 settings 文件没有 vision.continuousView：升级后不得自动采集。
  const app = await fixture(t, {}, { settings: null, sheetsToTake: 0 });
  const before = (await app.status()).vision.continuous;
  assert.equal(before.enabled, false, '缺失字段按安全迁移视为关闭');
  assert.equal(before.state, 'off');
  assert.equal(before.companionSeen, false);
  assert.equal(before.capturing, false);
  assert.equal(before.understandingEnabled, false);
  assert.equal(before.lastFrameAt, null, '进程/挂载不算有画面');
  assert.equal(before.lastUnderstandingAt, null);
  await sleep(80);
  assert.equal(state.storyboardStarts, 0, '缺失字段不得因升级自动开始采集');

  const invalid = await app.action({ action: 'vision.continuousView', enabled: 'false' });
  assert.equal(invalid.ok, false, 'enabled 必须是布尔值');
  assert.match(invalid.error, /布尔/u);

  // 显式开启：写盘并立即启动，无需任何陪伴轮。
  const on = await app.action({ action: 'vision.continuousView', enabled: true });
  assert.equal(on.ok, true, on.error);
  assert.equal(on.enabled, true);
  await app.waitFor(async () => (await app.status()).vision.continuous.state === 'capturing',
    'explicit true to start capture immediately');
  let snapshot = await app.status();
  assert.equal(snapshot.vision.continuous.enabled, true);
  assert.equal(snapshot.vision.continuous.capturing, true);
  assert.equal(snapshot.vision.continuous.companionSeen, false, '采集不伪造陪伴轮');
  let saved = JSON.parse(await readFile(join(app.root, 'data', 'settings.json'), 'utf8'));
  assert.equal(saved.vision.continuousView, true, '显式 true 落盘');

  const off = await app.action({ action: 'vision.continuousView', enabled: false });
  assert.equal(off.ok, true, off.error);
  assert.equal(off.enabled, false);
  assert.equal(off.state, 'off', '关闭后状态是 off，不是 running/capturing');
  const after = (await app.status()).vision.continuous;
  assert.equal(after.enabled, false);
  assert.equal(after.state, 'off');
  assert.equal(after.capturing, false);

  saved = JSON.parse(await readFile(join(app.root, 'data', 'settings.json'), 'utf8'));
  assert.equal(saved.vision.continuousView, false, '只写 settings.vision.continuousView，显式 false 落盘');
  // 模式切换只写 mode/scene 等字段，必须保留独立开关（否则会被默认值翻回来）。
  const mode = await app.action({ action: 'vision.mode', mode: 'watch' });
  assert.equal(mode.ok, true, mode.error);
  const preserved = JSON.parse(await readFile(join(app.root, 'data', 'settings.json'), 'utf8'));
  assert.equal(preserved.vision.continuousView, false, '切模式不得丢失显式 false');
  assert.equal((await app.status()).vision.continuous.enabled, false);

  // 重挂载读取显式 false：启动 boot 也不得启动采集。
  const restarted = await fixture(t, { evidenceCaptureBootDelayMs: 10 }, {
    settings: { vision: { continuousView: false } },
    sheetsToTake: 0,
  });
  await sleep(120);
  const restartedView = (await restarted.status()).vision.continuous;
  assert.equal(restartedView.enabled, false);
  assert.equal(restartedView.state, 'off');
  assert.equal(restartedView.capturing, false);
  assert.equal(state.storyboardStarts, 0, '显式 false 重启后仍不采集');
});

// ---------------------------------------------------------------------------
// 2. 关闭后的所有启动路径
// ---------------------------------------------------------------------------

test('2. 关闭后：首轮、切模式、feature enable 都不启动采集；理解/候选队列保持空', async (t) => {
  const app = await fixture(t, {
    understandingMinIntervalMs: 1_000,
    understandingAnalyzer: async () => ({ ok: true, text: '{"sceneSummary":"should not run"}' }),
  }, {
    settings: { vision: { continuousView: false } },
    sheetsToTake: Infinity,
  });
  const companion = app.companionAgent();

  // 首次真实陪伴轮：只置位 companionSeen，不得启动采集。
  await app.runPreStep({ agent: companion, turn: 1, text: '你好' });
  await sleep(80);
  assert.equal(state.storyboardStarts, 0, '关闭后首轮不得启动采集');
  let snapshot = await app.status();
  assert.equal(snapshot.vision.continuous.companionSeen, true, '真实陪伴轮仍然能证明会话已出现');
  assert.equal(snapshot.vision.continuous.state, 'off');
  assert.equal(snapshot.vision.evidenceCapture.running, false);

  // 切来源（同模式也走完整 stop/start 路径）。
  const mode = await app.action({ action: 'vision.mode', mode: 'watch' });
  assert.equal(mode.ok, true, mode.error);
  await sleep(60);
  assert.equal(state.storyboardStarts, 0, '关闭后切模式不得启动采集');

  // feature disable → enable 会触发 onFeatureEnable 的 startEvidenceCapture。
  const disabled = await app.action({ action: 'feature.set', id: 'vision', enabled: false });
  assert.equal(disabled.ok, true, disabled.error);
  const enabled = await app.action({ action: 'feature.set', id: 'vision', enabled: true });
  assert.equal(enabled.ok, true, enabled.error);
  await sleep(80);
  assert.equal(state.storyboardStarts, 0, '关闭后 feature enable 不得启动采集');

  snapshot = await app.status();
  assert.equal(snapshot.vision.continuous.state, 'off');
  assert.equal(snapshot.vision.continuous.retryAt, null, '关闭后不排重试');
  assert.equal(snapshot.vision.understanding.pending, 0, '没有采集就不会有后台理解排队');
  assert.equal(snapshot.vision.proactive.pending, 0);
});

// ---------------------------------------------------------------------------
// 3. 首次真实陪伴轮 / 排除代理轮
// ---------------------------------------------------------------------------

test('3. 代理/维护轮不置位 companionSeen；真实陪伴轮置位并可在未启动时补启采集', async (t) => {
  const app = await fixture(t, { evidenceCaptureBootDelayMs: 60_000 }, { sheetsToTake: 0 });
  const workspace = join(app.root, 'workspace');

  // 子代理：即使 id 等于陪伴 id，也不得置位或启动。
  await app.runPreStep({
    agent: app.companionAgent({ session: { id: app.companionId, header: { cwd: workspace, origin: 'subagent' } } }),
    turn: 1,
  });
  // 编码代理：不同 session id、显式 coding 用途，即使在工作区内。
  await app.runPreStep({
    agent: {
      id: 'coding-agent',
      options: { purpose: 'coding' },
      session: { id: 'coding-agent', header: { cwd: workspace } },
    },
    turn: 2,
  });
  // 摘要/后台维护轮：陪伴 id + purpose:compaction。
  await app.runPreStep({
    agent: app.companionAgent({ options: { purpose: 'compaction' } }),
    turn: 3,
  });
  await sleep(60);
  assert.equal(state.storyboardStarts, 0, '代理/维护轮不得启动持续采集');
  let beforeTurn = await app.status();
  assert.equal(beforeTurn.vision.continuous.companionSeen, false, 'companionSessionSeen 不得被代理轮置位');
  assert.equal(beforeTurn.vision.continuous.understandingEnabled, false);
  assert.equal(beforeTurn.vision.continuous.proactiveEnabled, false);

  // 真实陪伴轮：启动。
  await app.runPreStep({ agent: app.companionAgent(), turn: 4 });
  await app.waitFor(async () => (await app.status()).vision.continuous.state === 'capturing',
    'first real companion turn to start continuous capture');
  assert.equal(state.storyboardStarts, 1);
  const snapshot = await app.status();
  assert.equal(snapshot.vision.continuous.enabled, true);
  assert.equal(snapshot.vision.continuous.companionSeen, true);
  assert.equal(snapshot.vision.continuous.understandingEnabled, true);
  assert.equal(snapshot.vision.continuous.proactiveEnabled, true);
  assert.equal(snapshot.vision.continuous.source, 'desktop');
  assert.equal(snapshot.vision.evidenceCapture.running, true);
});

// ---------------------------------------------------------------------------
// 4. 隐私暂停 / 恢复
// ---------------------------------------------------------------------------

test('4. 隐私暂停采集，退出隐私后恢复（开关保持开启）', async (t) => {
  const app = await fixture(t, {}, { sheetsToTake: 0 });
  await app.runPreStep({ agent: app.companionAgent(), turn: 1 });
  await app.waitFor(async () => (await app.status()).vision.continuous.state === 'capturing',
    'capture before privacy');

  const privacy = await app.action({ action: 'vision.mode', mode: 'privacy' });
  assert.equal(privacy.ok, true, privacy.error);
  const paused = (await app.status()).vision.continuous;
  assert.equal(paused.enabled, true, '隐私不改变独立开关');
  assert.equal(paused.state, 'privacy');
  assert.equal((await app.status()).vision.evidenceCapture.running, false);
  const startsPaused = state.storyboardStarts;

  const restored = await app.action({ action: 'vision.mode', mode: 'watch' });
  assert.equal(restored.ok, true, restored.error);
  await app.waitFor(async () => (await app.status()).vision.continuous.state === 'capturing',
    'capture to resume after leaving privacy');
  assert.ok(state.storyboardStarts > startsPaused, '退出隐私后重新启动采集');
});

// ---------------------------------------------------------------------------
// 5. 确定性错误不轮询；依赖变化后可重试
// ---------------------------------------------------------------------------

test('5. 缺 ffmpeg 属确定性错误：state:failed、不排重试；依赖恢复后切模式可重试', async (t) => {
  const app = await fixture(t, {
    evidenceCaptureRetryBaseMs: 25,
  }, {
    ffmpegPath: null,
    sheetsToTake: 0,
  });
  await app.runPreStep({ agent: app.companionAgent(), turn: 1 });
  await app.waitFor(async () => (await app.status()).vision.continuous.state === 'failed',
    'deterministic failure to be visible');
  let snapshot = await app.status();
  assert.match(snapshot.vision.continuous.error, /ffmpeg/i);
  assert.equal(snapshot.vision.continuous.retryAt, null, '确定性错误不排定时重试');
  assert.equal(state.storyboardStarts, 0);

  // 超过一个（被缩短的）重试间隔也不得自己轮询。
  await sleep(120);
  snapshot = await app.status();
  assert.equal(snapshot.vision.continuous.state, 'failed');
  assert.equal(snapshot.vision.continuous.retryAt, null);
  assert.equal(state.storyboardStarts, 0, '确定性错误不会每 60s 重开故事板');

  // 依赖恢复：下一次显式启动（切模式）重试并成功。
  state.ffmpegPath = 'C:/fake/ffmpeg.exe';
  const retried = await app.action({ action: 'vision.mode', mode: 'watch' });
  assert.equal(retried.ok, true, retried.error);
  await app.waitFor(async () => (await app.status()).vision.continuous.state === 'capturing',
    'capture after dependency recovery');
  assert.equal(state.storyboardStarts, 1);
});

test('6. 其它错误按退避重试：retryAt 存在，重试成功后恢复 capturing', async (t) => {
  const app = await fixture(t, {
    evidenceCaptureRetryBaseMs: 30,
  }, {
    failStarts: 1,
    sheetsToTake: 0,
  });
  await app.runPreStep({ agent: app.companionAgent(), turn: 1 });
  await app.waitFor(async () => (await app.status()).vision.continuous.state === 'retrying',
    'transient failure to enter retrying');
  const retrying = (await app.status()).vision.continuous;
  assert.ok(Number.isFinite(retrying.retryAt) && retrying.retryAt > 0, '给出下次重试时间');
  assert.match(retrying.error, /temporary/i);

  await app.waitFor(async () => (await app.status()).vision.continuous.state === 'capturing',
    'backoff retry to succeed');
  assert.equal(state.storyboardStarts, 2, '第一次失败 + 一次重试');
  assert.equal((await app.status()).vision.continuous.retryAt, null);
});

// ---------------------------------------------------------------------------
// 6. 状态字段与 starting 语义
// ---------------------------------------------------------------------------

test('7. status.continuous 字段齐全；starting 期间不写 capturing/不冒充有画面', async (t) => {
  let release = null;
  const app = await fixture(t, {
    evidenceCaptureTickMs: 20,
    understandingMinIntervalMs: 10,
    understandingAnalyzer: async () => ({ ok: true, text: '{"sceneSummary":"测试场景"}' }),
  }, {
    sheetsToTake: Infinity,
    startStoryboard: (options) => {
      return new Promise((resolve) => {
        release = () => resolve(fakeSession(options));
      });
    },
  });

  await app.runPreStep({ agent: app.companionAgent(), turn: 1 });
  await app.waitFor(async () => (await app.status()).vision.continuous.state === 'starting',
    'start in flight to be starting');
  let snapshot = await app.status();
  assert.equal(snapshot.vision.continuous.state, 'starting');
  assert.notEqual(snapshot.vision.continuous.state, 'capturing', 'starting 不得写成 capturing');
  assert.equal(snapshot.vision.evidenceCapture.running, false, '启动 await 期间进程还不存在');
  assert.equal(snapshot.vision.continuous.lastFrameAt, null, '没有帧就没有画面');

  release();
  await app.waitFor(async () => (await app.status()).vision.continuous.state === 'capturing',
    'capture after release');
  await app.waitFor(async () => {
    const view = (await app.status()).vision.continuous;
    return Number.isFinite(view.lastFrameAt) && view.lastFrameAt > 0;
  }, 'a real frame to update lastFrameAt');
  await app.waitFor(async () => {
    const view = (await app.status()).vision.continuous;
    return Number.isFinite(view.lastUnderstandingAt) && view.lastUnderstandingAt > 0;
  }, 'a successful understanding to update lastUnderstandingAt');

  snapshot = await app.status();
  const view = snapshot.vision.continuous;
  for (const key of ['enabled', 'state', 'capturing', 'understandingEnabled', 'proactiveEnabled',
    'source', 'lastFrameAt', 'lastUnderstandingAt', 'error', 'retryAt', 'companionSeen']) {
    assert.ok(Object.hasOwn(view, key), `continuous.${key} 必须存在`);
  }
  assert.equal(typeof view.enabled, 'boolean');
  assert.equal(typeof view.state, 'string');
  assert.equal(view.source, 'desktop');
  assert.equal(typeof view.companionSeen, 'boolean');
  assert.equal(typeof view.lastFrameAt, 'number');
  assert.equal(typeof view.lastUnderstandingAt, 'number');
  assert.equal(JSON.stringify(view).includes('cache'), false, '状态不含文件路径');
});

test('8. 关闭会取消已排期的退避重试；之后切模式也不会重新打开', async (t) => {
  const app = await fixture(t, { evidenceCaptureRetryBaseMs: 200 }, {
    failStarts: 1,
    sheetsToTake: 0,
  });
  await app.runPreStep({ agent: app.companionAgent(), turn: 1 });
  await app.waitFor(async () => (await app.status()).vision.continuous.state === 'retrying',
    'transient failure before close');
  assert.equal(state.storyboardStarts, 1);

  const off = await app.action({ action: 'vision.continuousView', enabled: false });
  assert.equal(off.ok, true, off.error);
  assert.equal(off.state, 'off');
  // 等待超过原定重试间隔：计时器必须已被取消。
  await sleep(350);
  assert.equal(state.storyboardStarts, 1, '关闭后不得再执行已排期的重试');
  assert.equal((await app.status()).vision.continuous.state, 'off');

  const mode = await app.action({ action: 'vision.mode', mode: 'watch' });
  assert.equal(mode.ok, true, mode.error);
  await sleep(60);
  assert.equal(state.storyboardStarts, 1, '关闭后切模式不得重新打开');
});

test('9. 关闭时立即停采集、取消在途理解、清候选队列', async (t) => {
  let releaseAnalyze = null;
  const app = await fixture(t, {
    evidenceCaptureTickMs: 20,
    understandingMinIntervalMs: 5_000,
    understandingAnalyzer: async () => new Promise((resolve) => {
      releaseAnalyze = () => resolve({ ok: true, text: '{"sceneSummary":"不应写回"}' });
    }),
  }, { sheetsToTake: Infinity });
  await app.runPreStep({ agent: app.companionAgent(), turn: 1 });
  await app.waitFor(async () => (await app.status()).vision.continuous.state === 'capturing',
    'capture before close');
  await app.waitFor(async () => (await app.status()).vision.understanding.running === true,
    'an in-flight understanding to start from a real frame');

  const off = await app.action({ action: 'vision.continuousView', enabled: false });
  assert.equal(off.ok, true, off.error);
  assert.equal(off.state, 'off');
  const after = await app.status();
  assert.equal(after.vision.evidenceCapture.running, false, '关闭立即停采集');
  assert.equal(after.vision.understanding.pending, 0, '关闭清掉后台理解队列');
  assert.equal(after.vision.proactive.pending, 0, '关闭清掉主动候选');
  assert.equal(after.vision.continuous.lastUnderstandingAt, null,
    '关闭前在途的理解不得在关闭后写回“最近理解”');
  const runsAtClose = after.vision.understanding.runs;

  // 让在途分析迟到返回：代次已变，结果必须被丢弃且不触发 onAdvance。
  releaseAnalyze?.();
  await sleep(150);
  const final = await app.status();
  assert.equal(final.vision.understanding.runs, runsAtClose, '关闭后不再有新的后台理解');
  assert.equal(final.vision.continuous.lastUnderstandingAt, null, '迟到的理解结果不得写回');
});

// ---------------------------------------------------------------------------
// 7. 采集分辨率：默认 1920×1200，status 显示实际生效值
// ---------------------------------------------------------------------------

test('10. 默认按 1920×1200 采集；continuous/evidenceCapture 显示分辨率且不带路径', async (t) => {
  const app = await fixture(t, {}, { sheetsToTake: 0 });
  await app.runPreStep({ agent: app.companionAgent(), turn: 1 });
  await app.waitFor(async () => (await app.status()).vision.continuous.state === 'capturing',
    'capture to start at the default resolution');

  assert.equal(state.startOptions.width, 1920, '默认宽度不再是 800');
  assert.equal(state.startOptions.height, 1200, '默认高度不再是 450');

  let snapshot = await app.status();
  assert.equal(snapshot.vision.continuous.state, 'capturing');
  assert.equal(snapshot.vision.continuous.width, 1920);
  assert.equal(snapshot.vision.continuous.height, 1200);
  assert.equal(snapshot.vision.evidenceCapture.width, 1920);
  assert.equal(snapshot.vision.evidenceCapture.height, 1200);
  // 分辨率只是两个数字：状态里不得出现缓存目录/文件路径。
  assert.equal(JSON.stringify({
    continuous: snapshot.vision.continuous,
    evidenceCapture: snapshot.vision.evidenceCapture,
  }).includes('cache'), false, '分辨率状态不含文件路径');

  // 关闭采集后不再声称有采集分辨率。
  const off = await app.action({ action: 'vision.continuousView', enabled: false });
  assert.equal(off.ok, true, off.error);
  assert.equal(off.continuous.width, null, '停止后不显示旧分辨率');
  assert.equal(off.continuous.height, null);
  snapshot = await app.status();
  assert.equal(snapshot.vision.continuous.width, null);
  assert.equal(snapshot.vision.evidenceCapture.width, null);
});

test('11. config 覆盖分辨率并 clamp；status 与 startStoryboard 入参一致', async (t) => {
  const cases = [
    { config: { visionWidth: 1600, visionHeight: 1000 }, expected: { width: 1600, height: 1000 } },
    { config: { visionWidth: 640, visionHeight: 360 }, expected: { width: 1280, height: 720 } },
    { config: { visionWidth: 9000, visionHeight: 100 }, expected: { width: 2560, height: 720 } },
  ];
  for (const { config, expected } of cases) {
    const app = await fixture(t, config, { sheetsToTake: 0 });
    await app.runPreStep({ agent: app.companionAgent(), turn: 1 });
    await app.waitFor(async () => (await app.status()).vision.continuous.state === 'capturing',
      `capture with ${JSON.stringify(config)}`);

    assert.deepEqual(
      { width: state.startOptions.width, height: state.startOptions.height },
      expected,
      `startStoryboard 入参 ${JSON.stringify(config)}`,
    );
    const snapshot = await app.status();
    assert.equal(snapshot.vision.continuous.width, expected.width);
    assert.equal(snapshot.vision.continuous.height, expected.height);
    assert.equal(snapshot.vision.evidenceCapture.width, expected.width);
    assert.equal(snapshot.vision.evidenceCapture.height, expected.height);
  }
});
