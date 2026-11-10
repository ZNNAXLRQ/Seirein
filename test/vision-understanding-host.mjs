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

test('真实采集：voice 与 typed 陪伴轮都注入 understanding，typed 非陪伴轮为空；失败 errorCode 可读且采集继续', async (t) => {
  const control = { mode: 'ok', forceTyped: false, allowSecond: false, takes: 0 };
  const app = await fixture(t, {
    // 用测试缝模拟“同一陪伴会话里的文字轮”：identity 仍是 companion，lane 改成 typed。
    contextLaneOverride: () => (control.forceTyped === true ? 'typed' : undefined),
    allowCapture: true,
    evidenceCaptureEnabled: true,
    evidenceCaptureTickMs: 5,
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

  // voice lane（identity 推导）行为不变。
  const voiceText = understanding.text({ agent: companion() });
  assert.ok(voiceText.includes('测试场景'), `voice 陪伴轮仍注入：${voiceText}`);

  // typed lane + 同一 companion：文字陪伴轮现在也注入。
  control.forceTyped = true;
  const typedText = understanding.text({ agent: companion() });
  assert.ok(typedText.includes('测试场景'), `typed 陪伴轮注入：${typedText}`);

  // typed 但不是 companion：不注入。
  const outsider = {
    id: 'gui-typed-session',
    session: { id: 'gui-typed-session', header: { cwd: workspace } },
  };
  assert.equal(understanding.text({ agent: outsider }), '', 'typed 非陪伴轮不注入');

  const success = (await app.status()).vision.understanding;
  assert.equal(success.lastReasonCode, 'ok');
  assert.equal(success.lastErrorCode, '');
  assert.equal(success.rawChars, 0);
  assert.equal(success.rawHash, '');

  // 换一份材料并让 analyzer 失败：errorCode 只作为机器码进入 status，采集不被阻塞。
  await delay(260);
  control.mode = 'fail';
  control.allowSecond = true;
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

