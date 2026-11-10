/**
 * P-187 同材料双探针验收：
 *
 *   1. 同一张已缓存帧发出两次独立请求（内容识别 / 最小 JSON），不截图、不换模型；
 *   2. 两个分支各自保留完整安全 meta，A 与 B 的结果互不覆盖；
 *   3. B 的 bad-json / provider 失败不能被判成“不支持视觉”；A 的 empty 也保留真实原因；
 *   4. 手动入口有最短间隔与单在途，构造探针不会自动发请求；
 *   5. 结果只有受限 head/tail、短 TTL、可清除；status 不含正文；
 *   6. Host 接线只暴露显式 action，隐私会清掉旧摘要。
 *
 * Run: node --test test/vision-same-image-probe.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
import { Readable } from 'node:stream';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  VISION_PROBE_DEFAULTS,
  VISION_PROBE_PROMPTS,
  createVisionProbe,
} from '../src/host/vision/vision-probe.js';

const FRAME = { id: 'frame-1', file: 'C:\\cache\\same-frame.png', capturedAt: 1_000_000 };

/** 固定 meta，模拟真实 image-analyzer 的安全请求元数据。 */
function requestMeta(textChars, overrides = {}) {
  return {
    provider: 'demo',
    model: 'vision-model',
    imageCount: 1,
    contentBlockTypes: ['text', 'image'],
    maxTokens: 800,
    maxImages: 3,
    budget: { maxImages: 3, maxTokens: 800, timeoutMs: 30_000 },
    textChars,
    reasoningChars: 0,
    finishKind: 'stop',
    finishReason: 'stop',
    errorCode: '',
    timedOut: false,
    aborted: false,
    streamOpened: true,
    chunkCount: 3,
    durationMs: 12,
    ...overrides,
  };
}

const JSON_TEXT = '{"visible":true,"summary":"窗边有一盆绿植","confidence":0.8}';

/**
 * 可控的假分析器：按 system 提示词区分 A/B，并记录每次请求。
 * `mode.content` / `mode.json` 可以是返回对象，或 `{ text }` 简写。
 */
function harness(overrides = {}) {
  const calls = [];
  const mode = {
    content: { text: '特有内容：标题栏写着“预算表”，右上角有红色保存按钮。' },
    json: { text: JSON_TEXT },
    ...overrides.mode,
  };
  const analyze = async (options) => {
    calls.push(options);
    const isJson = options.system === VISION_PROBE_PROMPTS.json.system;
    const spec = isJson ? mode.json : mode.content;
    if (typeof overrides.beforeRespond === 'function') await overrides.beforeRespond(options, calls.length);
    if (spec !== null && typeof spec === 'object' && spec.raw === true) return spec.value;
    const text = typeof spec?.text === 'string' ? spec.text : '';
    return {
      ok: spec?.ok !== false,
      text,
      reason: spec?.reason ?? 'ok',
      images: spec?.images ?? 1,
      ...(spec?.errorCode ? { errorCode: spec.errorCode } : {}),
      meta: spec?.meta ?? requestMeta(text.length, spec?.metaOverrides),
    };
  };
  let clockValue = 1_000_000;
  const probe = createVisionProbe({
    analyze,
    frames: overrides.frames ?? (() => [FRAME]),
    isBlocked: overrides.isBlocked,
    now: () => clockValue,
    minIntervalMs: overrides.minIntervalMs ?? 1_000,
    ttlMs: overrides.ttlMs ?? 5_000,
    maxSummaryChars: overrides.maxSummaryChars,
    budget: overrides.budget,
  });
  return {
    probe,
    calls,
    mode,
    advance(ms) {
      clockValue += ms;
    },
  };
}

test('默认预算导出且冻结；构造探针不会自动发请求', () => {
  assert.ok(Object.isFrozen(VISION_PROBE_DEFAULTS));
  assert.equal(VISION_PROBE_DEFAULTS.maxFrames, 1);
  assert.ok(VISION_PROBE_DEFAULTS.minIntervalMs > 0);
  assert.ok(VISION_PROBE_DEFAULTS.ttlMs > 0);
  assert.ok(Object.isFrozen(VISION_PROBE_PROMPTS));
  const { calls, probe } = harness();
  assert.equal(calls.length, 0, '仅构造不得调用模型');
  assert.equal(probe.status().runs, 0);
});

test('同图两次独立请求：A/B 提示词不同、元数据完整且互不覆盖', async () => {
  const contentText = '特有内容：桌面窗口标题是“季度预算”，图表峰值 42%。';
  const { probe, calls } = harness({
    mode: { content: { text: contentText }, json: { text: JSON_TEXT } },
  });

  const result = await probe.run();
  assert.equal(result.ok, true, `probe 应成功：${result.reason}`);
  assert.equal(result.reason, 'ok');
  assert.equal(calls.length, 2, '两次独立请求');
  assert.deepEqual(calls[0].frames, [FRAME]);
  assert.deepEqual(calls[1].frames, [FRAME], '两次使用同一张缓存帧');
  assert.equal(calls[0].system, VISION_PROBE_PROMPTS.content.system);
  assert.equal(calls[1].system, VISION_PROBE_PROMPTS.json.system);
  assert.notEqual(calls[0].user, calls[1].user);

  for (const branch of ['content', 'json']) {
    const meta = result[branch].meta;
    assert.equal(meta.provider, 'demo');
    assert.equal(meta.model, 'vision-model');
    assert.equal(meta.imageCount, 1);
    assert.deepEqual(meta.contentBlockTypes, ['text', 'image']);
    assert.equal(meta.maxTokens, 800);
    assert.equal(typeof meta.textChars, 'number');
    assert.equal(typeof meta.reasoningChars, 'number');
    assert.equal(meta.finishKind, 'stop');
    assert.deepEqual(meta.budget, { maxImages: 3, maxTokens: 800, timeoutMs: 30_000 });
    assert.equal(meta.timedOut, false);
    assert.equal(meta.aborted, false);
    assert.equal(typeof meta.durationMs, 'number');
  }
  assert.equal(result.content.meta.textChars, contentText.length);
  assert.equal(result.json.meta.textChars, JSON_TEXT.length);
  assert.equal(result.json.parseOk, true);
  assert.equal(result.json.shapeOk, true);
  assert.ok(result.content.summary.head.includes('季度预算'));
  assert.ok(result.json.summary.head.includes('visible'));
  assert.equal(result.content.text, undefined, '对外结果不复制完整正文');
});

test('B 的 bad-json / provider 失败只记在 json 分支，不误判“不支持视觉”', async () => {
  const bad = harness({ mode: { json: { text: '这不是 JSON，只是一句解释。' } } });
  const badResult = await bad.probe.run();
  assert.equal(badResult.ok, false);
  assert.equal(badResult.reason, 'json-invalid');
  assert.equal(badResult.content.ok, true, 'A 仍然成功');
  assert.equal(badResult.json.ok, false);
  assert.equal(badResult.json.reason, 'bad-json');
  assert.equal(badResult.json.parseOk, false);
  assert.notEqual(badResult.reason, 'no-image-support');

  const failed = harness({
    mode: {
      json: {
        ok: false,
        text: '',
        reason: 'stream-error',
        errorCode: 'rate_limited',
        metaOverrides: { errorCode: 'rate_limited', textChars: 0, finishKind: 'error' },
      },
    },
  });
  const failedResult = await failed.probe.run();
  assert.equal(failedResult.ok, false);
  assert.equal(failedResult.reason, 'json-failed');
  assert.equal(failedResult.content.ok, true);
  assert.equal(failedResult.json.reason, 'stream-error');
  assert.equal(failedResult.json.meta.errorCode, 'rate_limited');
  assert.notEqual(failedResult.reason, 'no-image-support');

  const badShape = harness({ mode: { json: { text: '{"foo":1}' } } });
  const shapeResult = await badShape.probe.run();
  assert.equal(shapeResult.reason, 'json-invalid');
  assert.equal(shapeResult.json.parseOk, true);
  assert.equal(shapeResult.json.shapeOk, false);
  assert.notEqual(shapeResult.reason, 'no-image-support');
});

test('A 的 empty 保留 stream-error/empty；只有 A 自己声明 unsupported 才写 no-image-support', async () => {
  const empty = harness({
    mode: {
      content: {
        ok: false,
        text: '',
        reason: 'stream-error',
        errorCode: 'empty',
        metaOverrides: { errorCode: 'empty', textChars: 0 },
      },
    },
  });
  const emptyResult = await empty.probe.run();
  assert.equal(emptyResult.ok, false);
  assert.equal(emptyResult.reason, 'content-failed');
  assert.equal(emptyResult.content.ok, false);
  assert.equal(emptyResult.content.reason, 'stream-error');
  assert.equal(emptyResult.content.meta.errorCode, 'empty');
  assert.equal(emptyResult.json.ok, true);
  assert.notEqual(emptyResult.reason, 'no-image-support');

  const unsupported = harness({
    mode: {
      content: {
        ok: false,
        text: '',
        reason: 'no-image-support',
        metaOverrides: { errorCode: '', imageCount: 0, contentBlockTypes: [] },
      },
    },
  });
  const unsupportedResult = await unsupported.probe.run();
  assert.equal(unsupportedResult.reason, 'no-image-support');
  assert.equal(unsupportedResult.content.reason, 'no-image-support');
});

test('单在途 + 最短间隔：并发第二次立即 in-flight，冷却期内不再发请求', async () => {
  let release = null;
  const gate = new Promise((resolve) => { release = resolve; });
  let blockedOnce = true;
  const calls = [];
  const probe = createVisionProbe({
    frames: () => [FRAME],
    minIntervalMs: 1_000,
    ttlMs: 5_000,
    now: () => 1_000_000,
    analyze: async (options) => {
      calls.push(options);
      if (blockedOnce && options.system === VISION_PROBE_PROMPTS.content.system) {
        blockedOnce = false;
        await gate;
      }
      const text = options.system === VISION_PROBE_PROMPTS.json.system
        ? JSON_TEXT
        : '特有内容：一扇蓝色百叶窗。';
      return { ok: true, text, reason: 'ok', images: 1, meta: requestMeta(text.length) };
    },
  });

  const first = probe.run();
  const second = await probe.run();
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'in-flight');
  assert.equal(calls.length, 1, '第二次不得并发调用模型');

  release();
  const done = await first;
  assert.equal(done.ok, true);
  assert.equal(calls.length, 2);

  const limited = await probe.run();
  assert.equal(limited.ok, false);
  assert.equal(limited.reason, 'rate-limited');
  assert.equal(typeof limited.retryAt, 'number');
  assert.equal(calls.length, 2, '冷却期内不请求');

  probe.clear();
  const stillLimited = await probe.run();
  assert.equal(stillLimited.reason, 'rate-limited', 'clear 不重置限速');
});

test('无缓存帧 / 隐私门禁 / 未配置分析器：只返回机器原因，不请求模型', async () => {
  const noFrames = harness({ frames: () => [] });
  const noFrameResult = await noFrames.probe.run();
  assert.equal(noFrameResult.ok, false);
  assert.equal(noFrameResult.reason, 'no-frames');
  assert.equal(noFrames.calls.length, 0);

  const throwingFrames = harness({ frames: () => { throw new Error('cache gone'); } });
  assert.equal((await throwingFrames.probe.run()).reason, 'no-frames');
  assert.equal(throwingFrames.calls.length, 0);

  const blocked = harness({ isBlocked: () => true });
  assert.equal((await blocked.probe.run()).reason, 'blocked');
  assert.equal(blocked.calls.length, 0);

  let blockedChecks = 0;
  const throwingGate = harness({ isBlocked: () => { blockedChecks += 1; throw new Error('gate'); } });
  assert.equal((await throwingGate.probe.run()).reason, 'blocked');
  assert.equal(blockedChecks, 1);

  const bare = createVisionProbe({ frames: () => [FRAME] });
  assert.equal((await bare.run()).reason, 'not-configured');
});

test('受限摘要：head+tail 有上限，status 无正文，TTL 过期，clear 清空', async () => {
  const long = `HEAD-${'中'.repeat(4_000)}-TAIL`;
  const { probe, advance, calls } = harness({
    mode: { content: { text: long } },
    maxSummaryChars: 120,
    ttlMs: 5_000,
  });
  const result = await probe.run();
  assert.equal(result.content.summary.truncated, true);
  assert.ok(result.content.summary.head.includes('HEAD-'));
  assert.ok(result.content.summary.tail.endsWith('-TAIL'));
  assert.ok(
    Array.from(result.content.summary.head).length + Array.from(result.content.summary.tail).length <= 120,
  );

  const status = probe.status();
  assert.equal(status.runs, 1);
  assert.equal(status.failures, 0);
  assert.equal(status.hasResult, true);
  assert.equal(typeof status.expiresAt, 'number');
  assert.equal(JSON.stringify(status).includes('HEAD-'), false, 'status 不复制正文');
  assert.equal(JSON.stringify(status).includes('中中中'), false, 'status 不复制长正文');

  advance(5_001);
  assert.equal(probe.view().reason, 'expired');
  assert.equal(probe.status().hasResult, false);

  advance(1_000);
  const again = await probe.run();
  assert.equal(again.ok, true);
  assert.equal(calls.length, 4);
  const cleared = probe.clear();
  assert.equal(cleared.cleared, true);
  assert.equal(cleared.hasResult, false);
  assert.equal(probe.view().reason, 'empty');
  assert.equal(JSON.stringify(probe.view()).includes('HEAD-'), false);
});

test('畸形分析器输出：裸字符串按成功正文处理，null 收敛为 analyze-error，且不泄露路径', async () => {
  const { probe, mode } = harness({
    mode: { content: { raw: true, value: '裸字符串输出' } },
  });
  const stringResult = await probe.run();
  assert.equal(stringResult.content.ok, true);
  assert.equal(stringResult.content.summary.head, '裸字符串输出');
  assert.equal(stringResult.reason, 'ok', 'B 仍是默认合法 JSON');

  mode.content = { raw: true, value: null };
  mode.json = { raw: true, value: null };
  const nullProbe = createVisionProbe({
    frames: () => [FRAME],
    analyze: async () => null,
    minIntervalMs: 1,
    ttlMs: 1_000,
  });
  const nullResult = await nullProbe.run();
  assert.equal(nullResult.content.ok, false);
  assert.equal(nullResult.content.reason, 'analyze-error');
  assert.equal(nullResult.json.reason, 'analyze-error');
  assert.equal(JSON.stringify(nullResult).includes('C:\\cache'), false, '对外结果不含帧路径');
});

// ---------------------------------------------------------------------------
// Host 接线：只有显式 action 才运行，隐私会清掉旧摘要
// ---------------------------------------------------------------------------

const state = { storyboardStarts: 0, captures: 0 };
globalThis.__visionProbeHostTest = state;

const sightUrl = new URL('../src/host/vision/sight.js', import.meta.url).href;
const hooks = registerHooks({
  load(url, context, next) {
    if (url === sightUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          const s = globalThis.__visionProbeHostTest;
          export const resolveFfmpeg = () => null;
          export const resolveFfplay = () => null;
          export const capture = () => {
            s.captures += 1;
            throw new Error('probe must not capture');
          };
          export const captureDesktop = capture;
          export const captureDevice = capture;
          export const startStoryboard = () => {
            s.storyboardStarts += 1;
            throw new Error('probe must not capture');
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

async function hostFixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-vision-probe-host-'));
  const routes = new Map();
  const disposers = [];
  const effect = (fn) => {
    const cleanup = fn();
    if (typeof cleanup === 'function') disposers.push(cleanup);
    return cleanup;
  };
  await mkdir(join(root, 'workspace'), { recursive: true });
  await mkdir(join(root, 'data'), { recursive: true });
  await writeFile(
    join(root, 'data', 'features.json'),
    `${JSON.stringify(options.features ?? {
      vision: true, hearing: false, ambient: false, voice: false,
      subtitle: false, avatar: false, memory: false, fastpath: false,
    })}\n`,
    'utf8',
  );
  const png = join(root, 'cached-frame.png');
  await writeFile(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01]));

  const attachments = {
    async saveImage({ mediaType, name, data }) {
      return { id: 'att-1', mediaType, name, bytes: data.length };
    },
  };
  const llm = {
    async resolveModelInfo(provider, model) {
      return { provider, id: model, name: model, inputModalities: ['text', 'image'] };
    },
  };
  const ctx = {
    effect,
    on: () => () => {},
    get: (name) => (name === 'attachments' ? attachments : name === 'llm' ? llm : undefined),
    tools: { register: () => () => {} },
    inject: (_dependencies, register) => register({
      effect,
      systemPrompt: {
        section: () => () => {},
        context: () => () => {},
      },
      webServer: {
        register(route) {
          routes.set(route.path, route.handler);
          return () => routes.delete(route.path);
        },
      },
    }),
  };
  const analyzeCalls = [];
  apply(ctx, {
    root,
    enabled: true,
    defaultDomain: 'chat',
    evidenceCaptureEnabled: false,
    dependencyBootDelayMs: 60_000,
    evidenceCaptureBootDelayMs: 60_000,
    visionProbeFrames: () => [{ id: 'cached-1', file: png, capturedAt: Date.now() }],
    visionProbeMinIntervalMs: 60_000,
    understandingAnalyzer: async (request) => {
      analyzeCalls.push(request);
      const text = request.system === VISION_PROBE_PROMPTS.json.system
        ? JSON_TEXT
        : '窗口标题写着“同材料诊断”。';
      return {
        ok: true,
        text,
        reason: 'ok',
        images: 1,
        meta: requestMeta(text.length),
      };
    },
    ...options,
  });

  const route = async (path, body, method = 'POST') => {
    const handler = routes.get(path);
    assert.ok(handler !== undefined, `route ${path} is registered`);
    const req = method === 'GET'
      ? { method: 'GET', url: path }
      : Object.assign(Readable.from([JSON.stringify(body)]), { method: 'POST', url: path });
    let payload = '';
    await handler(req, { writeHead() {}, end(data) { payload = data ?? ''; } });
    return JSON.parse(payload);
  };

  t.after(async () => {
    for (const dispose of disposers.splice(0)) {
      try { await dispose(); } catch { /* best effort */ }
    }
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
  return {
    status: () => route('/assistant/status', undefined, 'GET'),
    action: (body) => route('/assistant/action', body),
    analyzeCalls,
    png,
  };
}

test('clear/stop 使在途结果失效：晚到的探针结果不得跨隐私边界写回', async () => {
  let release = null;
  const gate = new Promise((resolve) => { release = resolve; });
  const calls = [];
  const probe = createVisionProbe({
    frames: () => [FRAME],
    minIntervalMs: 1,
    ttlMs: 5_000,
    analyze: async (options) => {
      calls.push(options);
      if (options.system === VISION_PROBE_PROMPTS.content.system) await gate;
      const text = options.system === VISION_PROBE_PROMPTS.json.system
        ? JSON_TEXT
        : '特有内容：旧代次的画面。';
      return { ok: true, text, reason: 'ok', images: 1, meta: requestMeta(text.length) };
    },
  });

  const pending = probe.run();
  // 等 A 请求真正开始后再 clear，覆盖“在途结果晚到”的路径。
  while (calls.length === 0) await new Promise((resolve) => setTimeout(resolve, 0));
  probe.clear();
  release();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'stale');
  assert.equal(calls.length, 1, 'clear 后不再发第二次请求');
  assert.equal(probe.status().hasResult, false, '旧代次结果不得写回');

  probe.stop();
  const stoppedProbe = createVisionProbe({ frames: () => [FRAME], analyze: async () => 'x' });
  stoppedProbe.stop();
  assert.equal((await stoppedProbe.run()).reason, 'stopped');
});

test('Host：裸挂载不自动跑探针；显式 action 才请求；隐私清空摘要；不额外截图', async (t) => {
  state.storyboardStarts = 0;
  state.captures = 0;
  const app = await hostFixture(t);
  assert.equal(app.analyzeCalls.length, 0, '挂载不得自动跑双探针');
  const before = await app.status();
  assert.ok(before.vision.probe !== undefined, 'status.vision.probe 可读');
  assert.equal(before.vision.probe.runs, 0);
  assert.equal(before.vision.probe.hasResult, false);

  const run = await app.action({ action: 'vision.probe' });
  assert.equal(run.ok, true, `probe action 应成功：${run.reason}`);
  assert.equal(app.analyzeCalls.length, 2, 'action 触发两次独立请求');
  assert.equal(run.content.meta.imageCount, 1);
  assert.equal(run.json.parseOk, true);
  assert.equal(JSON.stringify(run).includes(app.png), false, '对外摘要不含缓存路径');

  const status = await app.status();
  assert.equal(status.vision.probe.runs, 1);
  assert.equal(status.vision.probe.hasResult, true);
  assert.equal(JSON.stringify(status.vision.probe).includes('同材料诊断'), false, 'status 不含正文');

  const viewed = await app.action({ action: 'vision.probe.status' });
  assert.equal(viewed.ok, true);
  assert.ok(viewed.content.summary.head.includes('同材料诊断'));

  const limited = await app.action({ action: 'vision.probe' });
  assert.equal(limited.reason, 'rate-limited');
  assert.equal(app.analyzeCalls.length, 2, '冷却期内不得再发请求');

  const cleared = await app.action({ action: 'vision.probe.clear' });
  assert.equal(cleared.ok, true);
  assert.equal(cleared.hasResult, false);
  assert.equal((await app.status()).vision.probe.hasResult, false);

  const privacy = await app.action({ action: 'vision.mode', mode: 'privacy' });
  assert.equal(privacy.ok, true, privacy.error);
  const blocked = await app.action({ action: 'vision.probe' });
  assert.equal(blocked.reason, 'blocked');
  assert.equal(app.analyzeCalls.length, 2);
  assert.equal((await app.status()).vision.probe.hasResult, false, '隐私清掉旧摘要');

  assert.equal(state.captures, 0, '探针不得截图');
  assert.equal(state.storyboardStarts, 0, '探针不得启动故事板');
});
