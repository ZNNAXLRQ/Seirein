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
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
          export const resolveFfmpeg = () => (s.allowCapture === true ? 'ffmpeg' : null);
          export const resolveFfplay = () => null;
          export const capture = (options) => s.makeShot(options.dir);
          export const captureDesktop = capture;
          export const captureDevice = capture;
          export const startStoryboard = (options) => {
            if (typeof s.storyboardFactory === 'function') return s.storyboardFactory(options);
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
const {
  apply,
  voiceSessionTarget,
  createUnderstandingMaterialGate,
  understandingMaterialSignature,
} = await import('../src/host/index.js');
hooks.deregister();
const hostSource = readFileSync(new URL('../src/host/index.js', import.meta.url), 'utf8');

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-understanding-host-'));
  const tools = new Map();
  const routes = new Map();
  const promptSections = new Map();
  const promptContexts = new Map();
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
      const index = list.indexOf(handler);
      if (index >= 0) list.splice(index, 1);
    };
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
  await mkdir(join(root, 'workspace'), { recursive: true });
  await mkdir(join(root, 'data'), { recursive: true });
  if (options.features !== null && typeof options.features === 'object') {
    await writeFile(join(root, 'data', 'features.json'), `${JSON.stringify(options.features)}\n`, 'utf8');
  }
  if (options.settings !== null && typeof options.settings === 'object') {
    await writeFile(join(root, 'data', 'settings.json'), `${JSON.stringify(options.settings)}\n`, 'utf8');
  }
  apply({
    effect,
    on,
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
  state.allowCapture = options.allowCapture === true;
  state.storyboardFactory = null;
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
  return { root, status, action, dispose, promptSections, promptContexts, listeners };
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
  assert.equal(view.lastReasonCode, '', '失败原因码初始为空');
  assert.equal(view.lastErrorCode, '', 'provider 错误码初始为空');
  assert.equal(view.rawChars, 0, 'bad-json 诊断初始为空');
  assert.equal(view.rawHash, '');
  assert.deepEqual(view.state, { sceneChars: 0, events: 0, unresolvedChars: 0 });
  // 设置页成本概览的只读数值：20 秒是限速下限，不是定时器；上限只是算术值。
  assert.equal(view.intervalMs, 20_000, '默认最短间隔 20 秒');
  assert.equal(view.maxImages, 3, '单次最多 3 张输入图');
  assert.equal(view.theoreticalPerHour, 180, '3600/20 = 180 次/小时');
  assert.equal(view.theoreticalImagesPerHour, 540, '180 × 3 = 540 张/小时');
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

test('相同材料签名第二次不触发；onSheet 只在登记成功后带签名触发', async () => {
  const gate = createUnderstandingMaterialGate();
  const sheet = {
    file: join('cache', 'screens', 'sheet-a.png'),
    capturedAt: 1_700_000_000_000,
    bytes: 4096,
    frames: 6,
  };
  const added = {
    file: join('cache', 'evidence', 'ev-1.png'),
    capturedAt: 1_700_000_000_000,
    bytes: 4096,
  };
  const signature = understandingMaterialSignature(sheet, added);
  assert.ok(signature.length <= 240, '签名有界');
  assert.equal(signature.includes('cache'), false, '签名只保留文件名，不含完整路径');
  assert.equal(gate.accept(signature, sheet.capturedAt), true, '第一次新材料放行');
  assert.equal(gate.accept(signature, sheet.capturedAt), false, '同一签名第二次不触发');
  assert.equal(gate.status().lastMaterialAt, sheet.capturedAt, '记录 lastMaterialAt');
  assert.equal(gate.accept(`${signature}-next`, sheet.capturedAt + 1), true, '不同材料仍放行');

  // 无法从裸挂载驱动真实采集，因此用源码断言核对接线：先判断新 entry，再带签名 note。
  const onSheetAt = hostSource.indexOf('onSheet: async (sheet) =>');
  assert.ok(onSheetAt > 0, 'index.js 有 onSheet 接线');
  const onSheetRegion = hostSource.slice(onSheetAt, hostSource.indexOf('isBlocked:', onSheetAt));
  assert.match(onSheetRegion, /if \(added === null\) return;/, '无新增证据不触发');
  assert.match(onSheetRegion,
    /materialSignature: understandingMaterialSignature\(sheet, added\)/,
    'onSheet 用登记后的 entry + sheet 元数据生成签名');
  const noteAt = hostSource.indexOf('const noteUnderstandingChange = (request) =>');
  assert.ok(noteAt > 0);
  const noteRegion = hostSource.slice(noteAt, noteAt + 1200);
  assert.match(noteRegion, /understandingMaterial\.accept\(signature, source\.materialAt\)/,
    'noteUnderstandingChange 内做签名比较并记录');
  assert.match(noteRegion, /if \(!understandingMaterial\.accept\(signature, source\.materialAt\)\) return;/,
    '同签名在能力探测/排程之前就被挡住');
});

test('隐私、切源或停止后材料签名重置；评论 priority 路径不受静态签名限制', () => {
  const gate = createUnderstandingMaterialGate();
  assert.equal(gate.accept('same-material', 1), true);
  gate.reset();
  assert.equal(gate.accept('same-material', 2), true, 'reset 后同一材料重新放行');
  assert.equal(gate.status().lastMaterialSignature, 'same-material');
  assert.equal(gate.status().lastMaterialAt, 2);
  // 评论路径没有签名：总是放行，也不覆盖故事板签名。
  assert.equal(gate.accept('', 3), true);
  assert.equal(gate.status().lastMaterialSignature, 'same-material', '无签名请求不写材料签名');

  const invalidateAt = hostSource.indexOf('const invalidateVision = () =>');
  assert.ok(invalidateAt > 0);
  const invalidateRegion = hostSource.slice(invalidateAt, invalidateAt + 2500);
  assert.match(invalidateRegion, /resetUnderstandingMaterial\(\)/,
    '隐私/切源/换代（invalidateVision）重置签名');

  const stopAt = hostSource.indexOf('const stopEvidenceCapture = async');
  assert.ok(stopAt > 0);
  const stopRegion = hostSource.slice(stopAt, stopAt + 900);
  assert.match(stopRegion, /resetUnderstandingMaterial\(\)/, '停止采集时重置签名');

  const disposeAt = hostSource.indexOf('understanding.stop();');
  assert.ok(disposeAt > 0);
  assert.match(hostSource.slice(disposeAt, disposeAt + 200), /resetUnderstandingMaterial\(\)/,
    '卸载停止理解时也重置签名');
});

// ---------------------------------------------------------------------------
// 真实采集接线：voice + typed 陪伴轮都渲染 understanding；analyzer 失败只留机器码
// ---------------------------------------------------------------------------

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, timeoutMs = 5_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > until) assert.fail('condition not met before timeout');
    await delay(10);
  }
}

test('真实采集：voice 与 typed 陪伴轮都注入 understanding，编码用途 typed 为空；失败 errorCode 可读且采集继续', async (t) => {
  const control = { mode: 'ok', forceTyped: false, allowSecond: false, takes: 0 };
  const app = await fixture(t, {
    // 用测试缝模拟“同一陪伴会话里的文字轮”：identity 仍是 companion，lane 改成 typed。
    contextLaneOverride: () => (control.forceTyped === true ? 'typed' : undefined),
    allowCapture: true,
    evidenceCaptureEnabled: true,
    // 25 ms tick：既让第二份材料晚于证据窗口 200 ms 去重间隔，又不会在 260 ms 内
    // 触发连续 30 次空 take 后的 6 s 空闲退避（5 ms tick 会，测试因此偶发超时）。
    evidenceCaptureTickMs: 25,
    understandingMinIntervalMs: 1,
    features: {
      hearing: false, ambient: false, voice: false, vision: true,
      subtitle: false, avatar: false, memory: false, fastpath: false,
    },
    settings: { vision: { continuousView: true } },
    understandingAnalyzer: async (options) => {
      if (control.mode === 'fail') {
        return { ok: false, text: '', reason: 'stream-error', errorCode: 'rate_limited', images: 1 };
      }
      const at = Number(options?.interval?.from) || Date.now();
      return {
        ok: true,
        text: JSON.stringify({
          sceneSummary: '测试场景：桌面上有一个打开的窗口',
          events: [],
          unresolved: '',
          // 事件时间只用于展示；这里没有事件，保留字段方便未来扩展。
          observedAt: at,
        }),
        reason: 'ok',
        images: 1,
      };
    },
  });

  const screenDir = join(app.root, 'cache', 'screens');
  await mkdir(screenDir, { recursive: true });
  await writeFile(join(screenDir, 'sheet-1.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01]));
  await writeFile(join(screenDir, 'sheet-2.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x02]));
  state.storyboardFactory = () => ({
    engine: 'fake',
    sourceKind: 'screen',
    done: Promise.resolve(),
    stop: () => {},
    take: async () => {
      if (control.takes === 0) {
        control.takes = 1;
        return { file: join(screenDir, 'sheet-1.png'), capturedAt: Date.now(), width: 2, height: 2, frames: 2 };
      }
      if (control.allowSecond === true && control.takes === 1) {
        control.takes = 2;
        return { file: join(screenDir, 'sheet-2.png'), capturedAt: Date.now(), width: 2, height: 2, frames: 2 };
      }
      return null;
    },
  });

  const companionId = voiceSessionTarget({ root: app.root }).sessionId;
  const workspace = join(app.root, 'workspace');
  const companion = () => ({
    id: companionId,
    session: { id: companionId, header: { cwd: workspace } },
  });
  const handlers = app.listeners.get('agent/pre-step') ?? [];
  assert.ok(handlers.length > 0, 'Host 注册了 agent/pre-step');
  await handlers[0]({
    agent: companion(),
    turn: 1,
    step: 1,
    signal: new AbortController().signal,
    messages: [{ id: 'u-1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '嗨' }] }],
  }, async () => ({ kind: 'enter', messages: [] }));

  await waitFor(async () => (await app.status()).vision.understanding.hasState === true);
  const understanding = app.promptContexts.get('assistant:understanding');
  assert.ok(understanding !== undefined);

  // 先固定第一次成功的结果，再立即切换第二份材料。采集循环连续 30 次空 take
  // 后会退避到 6 s；25 ms tick 下 260 ms 的等待仍处于 active tick。
  const success = (await app.status()).vision.understanding;
  assert.equal(success.lastReasonCode, 'ok');
  assert.equal(success.lastErrorCode, '');
  assert.equal(success.rawChars, 0);
  assert.equal(success.rawHash, '');
  control.mode = 'fail';

  // voice lane（identity 推导）行为不变。
  const voiceText = understanding.text({ agent: companion() });
  assert.ok(voiceText.includes('测试场景'), `voice 陪伴轮仍注入：${voiceText}`);

  // typed lane + 同一 companion：文字陪伴轮现在也注入。
  control.forceTyped = true;
  const typedText = understanding.text({ agent: companion() });
  assert.ok(typedText.includes('测试场景'), `typed 陪伴轮注入：${typedText}`);

  // typed 但属于编码用途：仍被排除，不注入。
  // 普通 GUI typed 已按新语义放行（见 test/vision-typed-companion.mjs）。
  const outsider = {
    id: 'coding-agent-session',
    options: { purpose: 'coding' },
    session: { id: 'coding-agent-session', header: { cwd: workspace } },
  };
  assert.equal(understanding.text({ agent: outsider }), '', '编码用途 typed 不注入');

  // 第二份材料必须晚于证据窗口的 200 ms 同源去重间隔；25 ms tick 下仍处于 active tick。
  await delay(260);
  control.allowSecond = true;
  // 第二份材料让 analyzer 失败：errorCode 只作为机器码进入 status，采集不被阻塞。
  await waitFor(async () => (await app.status()).vision.understanding.failures >= 1);

  const snapshot = await app.status();
  const failed = snapshot.vision.understanding;
  assert.equal(failed.lastReasonCode, 'stream-error');
  assert.equal(failed.lastErrorCode, 'rate_limited');
  assert.equal(failed.rawChars, 0);
  assert.equal(failed.rawHash, '');
  assert.equal(snapshot.vision.evidenceCapture.running, true, 'understanding 失败不阻塞持续采集');
  assert.ok(snapshot.vision.evidenceCapture.sheets >= 2, '第二份材料仍被采集并交给理解');

  // 失败只增加计数，不销毁上一段已理解状态。
  assert.ok(understanding.text({ agent: companion() }).includes('测试场景'),
    '失败不清空既有 understanding 状态');
});

// ---------------------------------------------------------------------------
// 窗口诊断：成功运行也记录本次取证窗口/计数与三段时刻，且始终无路径/帧 id
// ---------------------------------------------------------------------------

test('理解窗口诊断：status.window 可解释本次选择，timing 记录证据/理解/交付时刻', async (t) => {
  let analyzed = null;
  const app = await fixture(t, {
    allowCapture: true,
    evidenceCaptureEnabled: true,
    evidenceCaptureTickMs: 25,
    // 证据基准默认 90 s；这里显式给一个上界，证明走的是可配置的有界策略。
    evidenceBaselineMaxAgeMs: 120_000,
    understandingMinIntervalMs: 1,
    features: {
      hearing: false, ambient: false, voice: false, vision: true,
      subtitle: false, avatar: false, memory: false, fastpath: false,
    },
    settings: { vision: { continuousView: true } },
    understandingAnalyzer: async (options) => {
      analyzed = options;
      const frameId = options?.frames?.[0]?.id;
      return {
        ok: true,
        text: JSON.stringify({
          sceneSummary: '窗口诊断场景',
          events: frameId === undefined
            ? []
            : [{
              from: options.interval.from,
              to: options.interval.to,
              description: '窗口内事件',
              evidenceFrameIds: [frameId],
              evidenceAudioIds: [],
              uncertainty: '',
            }],
          unresolved: '',
        }),
        reason: 'ok',
        images: 1,
      };
    },
  });

  const screenDir = join(app.root, 'cache', 'screens');
  await mkdir(screenDir, { recursive: true });
  await writeFile(join(screenDir, 'sheet-window.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x03]));
  const control = { takes: 0 };
  state.storyboardFactory = () => ({
    engine: 'fake',
    sourceKind: 'screen',
    done: Promise.resolve(),
    stop: () => {},
    take: async () => {
      if (control.takes > 0) return null;
      control.takes += 1;
      return {
        file: join(screenDir, 'sheet-window.png'),
        capturedAt: Date.now(),
        width: 2,
        height: 2,
        frames: 2,
      };
    },
  });
  const companionId = voiceSessionTarget({ root: app.root }).sessionId;
  const workspace = join(app.root, 'workspace');
  const companion = {
    id: companionId,
    session: { id: companionId, header: { cwd: workspace } },
  };
  const handlers = app.listeners.get('agent/pre-step') ?? [];
  assert.ok(handlers.length > 0);
  await handlers[0]({
    agent: companion,
    turn: 1,
    step: 1,
    signal: new AbortController().signal,
    messages: [{ id: 'u-win-1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '嗨' }] }],
  }, async () => ({ kind: 'enter', messages: [] }));

  await waitFor(async () => (await app.status()).vision.understanding.hasState === true);
  const view = (await app.status()).vision.understanding;

  // 成功运行同样保留窗口投影：能看出“选了哪些帧、来自哪个来源/代次”。
  assert.equal(view.lastReasonCode, 'ok');
  assert.ok(view.window !== null, 'status.window 必须存在');
  assert.equal(typeof view.window.windowFrom, 'number', 'windowFrom 是毫秒数字');
  assert.equal(typeof view.window.windowTo, 'number');
  assert.ok(view.window.windowTo >= view.window.windowFrom);
  assert.equal(view.window.frameCount, 1, '本次确实选到 1 帧');
  assert.equal(view.window.source, 'desktop');
  assert.equal(view.window.sourceEpoch, 0);
  assert.equal(view.window.reason, 'frames');
  assert.ok(analyzed !== null && analyzed.frames.length === 1, '模型收到同一帧');

  // 三段时刻：证据登记、理解完成（当前有事件）、本轮交付（还没渲染过，先为 null）。
  assert.equal(typeof view.timing.evidenceAt, 'number');
  assert.equal(typeof view.timing.understoodAt, 'number');
  assert.equal(typeof view.timing.eventAt, 'number', '事件发生时刻来自已并入状态的事件');
  assert.equal(view.timing.deliveredAt, null, '尚未交付给本轮模型时保持 null');

  const understanding = app.promptContexts.get('assistant:understanding');
  const rendered = understanding.text({ agent: companion });
  assert.ok(rendered.includes('窗口诊断场景'), `本轮交付非空：${rendered}`);
  const after = (await app.status()).vision.understanding;
  assert.equal(typeof after.timing.deliveredAt, 'number', '非空理解块交付后记录交付时间');

  // 安全面：窗口诊断/时刻不含路径、帧 id 或证据目录。
  const serialized = JSON.stringify({ window: view.window, timing: view.timing });
  assert.equal(serialized.includes(app.root), false, '不含 fixture 路径');
  assert.equal(serialized.includes('cache'), false, '不含证据目录');
  assert.equal(serialized.includes('ev-'), false, '不含帧 id');
});

test('接线：no-frames 事件/status 带窗口与排除原因，静态画面有有界基准兜底', () => {
  const framesAt = hostSource.indexOf('framesBetween: (from, to) => {');
  assert.ok(framesAt > 0, 'index.js 由 framesBetween 统一记录窗口');
  const framesRegion = hostSource.slice(framesAt, framesAt + 2600);
  assert.match(framesRegion, /evidenceWindow\.diagnose\(from, to, \{/, '无帧前先做排除原因诊断');
  assert.match(framesRegion, /vision\.understanding\.window\.miss/, 'no-frames 窗口留下安全事件');
  assert.match(framesRegion, /understandingWindowOf\(\{ from, to, source, sourceEpoch, frames, diagnosis \}\)/,
    '窗口视图只由标量组成');
  assert.match(hostSource, /rest\.window = \{ \.\.\.understandingWindowView \}/,
    'understanding-run 附带本次窗口');

  const statusAt = hostSource.indexOf('const understandingStatusView = () => {');
  assert.ok(statusAt > 0);
  const statusRegion = hostSource.slice(statusAt, statusAt + 2600);
  assert.match(statusRegion, /window: windowView/, 'status 暴露本次窗口');
  assert.match(statusRegion, /timing,/, 'status 暴露三段时刻');
  assert.match(statusRegion, /deliveredAt:/, '交付时刻有独立字段');

  const baselineAt = hostSource.indexOf('const windowWithBaseline = (');
  assert.ok(baselineAt > 0, '静态画面有基准兜底');
  const baselineRegion = hostSource.slice(baselineAt, baselineAt + 1800);
  assert.match(baselineRegion, /evidenceWindow\.baseline\(\{/, '复用证据窗口的基准帧');
  assert.match(baselineRegion, /minEndedAt: companionEvidenceFrom/,
    '首轮前的旧画面不得成为基准');
  assert.match(baselineRegion, /vision\.understanding\.baseline/, '使用基准帧留下安全事件');
  // 语音与 typed 两条自然评论路径都接入基准兜底，不依赖 see/take。
  assert.match(hostSource, /evidence\.length === 0\s*\n\s*\? windowWithBaseline\(/,
    '语音/typed 路径在窗口无帧时尝试基准');
});

test('自然评论轮：typed pre-step 用本轮证据窗口实际取到相关帧，不依赖 see/take', async (t) => {
  const calls = [];
  const app = await fixture(t, {
    allowCapture: true,
    evidenceCaptureEnabled: true,
    evidenceCaptureTickMs: 25,
    understandingMinIntervalMs: 1,
    features: {
      hearing: false, ambient: false, voice: false, vision: true,
      subtitle: false, avatar: false, memory: false, fastpath: false,
    },
    settings: { vision: { continuousView: true } },
    understandingAnalyzer: async (options) => {
      const frameId = options?.frames?.[0]?.id;
      calls.push({
        from: options?.interval?.from,
        to: options?.interval?.to,
        frames: Array.isArray(options?.frames) ? options.frames.map((entry) => entry.id) : [],
      });
      return {
        ok: true,
        text: JSON.stringify({
          sceneSummary: '自然评论场景',
          events: frameId === undefined
            ? []
            : [{
              from: options.interval.from,
              to: options.interval.to,
              description: '评论所指画面',
              evidenceFrameIds: [frameId],
              evidenceAudioIds: [],
              uncertainty: '',
            }],
          unresolved: '',
        }),
        reason: 'ok',
        images: 1,
      };
    },
  });

  const screenDir = join(app.root, 'cache', 'screens');
  await mkdir(screenDir, { recursive: true });
  await writeFile(join(screenDir, 'sheet-comment.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x04]));
  const control = { takes: 0 };
  state.storyboardFactory = () => ({
    engine: 'fake',
    sourceKind: 'screen',
    done: Promise.resolve(),
    stop: () => {},
    take: async () => {
      if (control.takes > 0) return null;
      control.takes += 1;
      return {
        file: join(screenDir, 'sheet-comment.png'),
        capturedAt: Date.now(),
        width: 2,
        height: 2,
        frames: 2,
      };
    },
  });

  const companionId = voiceSessionTarget({ root: app.root }).sessionId;
  const workspace = join(app.root, 'workspace');
  const companion = {
    id: companionId,
    session: { id: companionId, header: { cwd: workspace } },
  };
  const handlers = app.listeners.get('agent/pre-step') ?? [];
  const preStep = (turn, messageId, text) => handlers[0]({
    agent: companion,
    turn,
    step: 1,
    signal: new AbortController().signal,
    messages: [{ id: messageId, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }],
  }, async () => ({ kind: 'enter', messages: [] }));

  // 第 1 轮：建立陪伴会话并启动证据采集；故事板随即登记一帧。
  await preStep(1, 'u-comment-1', '嗨');
  await waitFor(async () => (await app.status()).vision.understanding.runs >= 1);
  const firstCalls = calls.length;
  assert.ok(firstCalls >= 1, '故事板分析已发生');

  // 第 2 轮：普通 typed 陪伴轮，只在发送窗口内取证据（不触发 see/take 采集）。
  await preStep(2, 'u-comment-2', '这个画面里的人刚才在做什么');
  await waitFor(async () => calls.length > firstCalls);
  const commentCall = calls[calls.length - 1];
  assert.ok(commentCall.frames.length >= 1, '自然评论轮必须实际取到证据帧');
  assert.ok(commentCall.to - commentCall.from >= 9_000, '使用本轮发送窗口，而不是零宽点');
  const snapshot = await app.status();
  assert.equal(snapshot.vision.understanding.lastReasonCode, 'ok');
  assert.ok(snapshot.vision.understanding.window.frameCount >= 1);
  assert.equal(snapshot.vision.evidenceCapture.running, true, '评论轮不重启/不影响持续采集');
});

