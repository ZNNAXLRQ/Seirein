/**
 * P-187 诊断补丁验收：
 *
 *   1. image-analyzer 成功/失败都带安全 meta（provider/model、图片数、正文/推理长度、finish、
 *      empty/bad-json 对照），且 meta 是非枚举字段，不破坏旧调用；
 *   2. empty / bad-json 在 understanding-runtime 里保留真实原因与 meta，不会被误判成
 *      `no-image-support`；
 *   3. 失败样本最多 3 条、每条 head+tail ≤2KB、10 分钟 TTL、clear 清空，且不把路径带出去；
 *   4. 连续失败 3 次进入指数退避，状态给出 degraded/retryAt/lastError；成功重置；手动 runNow
 *      可绕过一次；退避期间调度器不再请求模型。
 *
 * Run: node --test test/vision-understanding-diagnostics.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createImageAnalyzer } from '../src/host/vision/image-analyzer.js';
import { createUnderstandingRuntime } from '../src/host/vision/understanding-runtime.js';
import {
  UNDERSTANDING_SAMPLES_DEFAULTS,
  createUnderstandingSamples,
} from '../src/host/vision/understanding-samples.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const INTERVAL = { from: 1_000_000, to: 1_020_000 };
const FRAME_A = { id: 'frame-a', capturedAt: 1_000_000, file: 'C:\\shots\\one.png' };
const FRAME_B = { id: 'frame-b', capturedAt: 1_005_000, file: 'C:\\shots\\two.png' };

function finish(kind, code = '') {
  return {
    type: 'finish',
    reason: {
      kind,
      ...(code ? { failure: { code, message: '不应进入 meta 的正文 C:\\secret\\x.png' } } : {}),
    },
  };
}

/** 只构造 image-analyzer；成功路径默认两帧、图片能力明确可用。 */
function analyzerHarness(overrides = {}) {
  const reads = [];
  const saves = [];
  const streams = [];
  const services = {
    agentDefaultModel: {
      currentSelection: () => overrides.selection ?? { provider: 'demo', model: 'vision-model' },
    },
    attachments: {
      async saveImage(input) {
        saves.push(input);
        return { id: `att-${saves.length}` };
      },
    },
    llm: {
      async resolveModelInfo() {
        return overrides.modelInfo ?? { inputModalities: ['text', 'image'] };
      },
      stream(options) {
        streams.push(options);
        if (typeof overrides.stream === 'function') return overrides.stream(options);
        const chunks = overrides.chunks ?? [finish('stop')];
        return (async function* emit() {
          for (const chunk of chunks) yield chunk;
        })();
      },
    },
  };
  const analyzer = createImageAnalyzer({
    getService: (name) => services[name],
    readFile: overrides.readFile ?? (async (file) => {
      reads.push(file);
      return PNG;
    }),
    now: overrides.now,
    maxTokens: overrides.maxTokens,
    setTimer: overrides.setTimer,
    clearTimer: overrides.clearTimer,
  });
  return { analyzer, reads, saves, streams };
}

test('成功 meta：实际路由、图片数、内容块、正文/推理长度、finish、chunk、耗时', async () => {
  const clock = { value: 5_000 };
  const { analyzer, streams } = analyzerHarness({
    now: () => (clock.value += 25),
    chunks: [
      { type: 'reasoning-delta', text: '先想一想' },
      { type: 'text-delta', text: '画面' },
      { type: 'text-delta', text: '有一扇窗。' },
      finish('stop'),
    ],
  });

  const result = await analyzer.analyze({
    frames: [FRAME_A, FRAME_B],
    user: '看到了什么？',
  });

  assert.equal(result.ok, true);
  assert.equal(result.text, '画面有一扇窗。');

  const meta = result.meta;
  assert.ok(meta, '成功结果必须能显式读到 meta');
  assert.equal(meta.provider, 'demo');
  assert.equal(meta.model, 'vision-model');
  assert.equal(meta.imageCount, 2);
  assert.deepEqual(meta.contentBlockTypes, ['text', 'image']);
  assert.equal(meta.maxTokens, 4096);
  assert.equal(meta.textChars, '画面有一扇窗。'.length);
  assert.equal(meta.reasoningChars, '先想一想'.length);
  assert.equal(meta.finishKind, 'stop');
  assert.equal(meta.finishReason, 'stop');
  assert.equal(meta.errorCode, '');
  assert.equal(meta.timedOut, false);
  assert.equal(meta.aborted, false);
  assert.equal(meta.streamOpened, true);
  assert.equal(meta.chunkCount, 4);
  assert.ok(Number.isInteger(meta.durationMs) && meta.durationMs >= 0);

  // 旧调用兼容：meta 是非枚举字段，不改变 deepEqual / JSON 形状。
  assert.equal(Object.keys(result).includes('meta'), false);
  assert.equal(JSON.stringify(result).includes('"meta"'), false);
  assert.equal(JSON.stringify(meta).includes('C:\\'), false);
  assert.equal(streams.length, 1);
});

test('失败 meta：错误码、finish、图片数、流已打开与耗时；不泄漏异常正文', async () => {
  const { analyzer } = analyzerHarness({
    chunks: [
      { type: 'text-delta', text: '半截' },
      finish('error', 'rate_limited'),
    ],
  });

  const result = await analyzer.analyze({ frames: [FRAME_A, FRAME_B] });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'stream-error');
  assert.equal(result.errorCode, 'rate_limited');

  const meta = result.meta;
  assert.equal(meta.provider, 'demo');
  assert.equal(meta.model, 'vision-model');
  assert.equal(meta.imageCount, 2);
  assert.equal(meta.textChars, 2);
  assert.equal(meta.finishKind, 'error');
  assert.equal(meta.finishReason, 'error');
  assert.equal(meta.errorCode, 'rate_limited');
  assert.equal(meta.timedOut, false);
  assert.equal(meta.aborted, false);
  assert.equal(meta.streamOpened, true);
  assert.equal(meta.chunkCount, 2);
  assert.equal(JSON.stringify(result).includes('secret'), false);
  assert.equal(JSON.stringify(meta).includes('secret'), false);
});

test('empty 不是“模型空生成”：errorCode 是 empty 哨兵，meta 保留真实 finish 与 chunk 计数', async () => {
  const { analyzer } = analyzerHarness({
    chunks: [finish('stop')],
  });

  const result = await analyzer.analyze({ frames: [FRAME_A] });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'stream-error');
  assert.equal(result.errorCode, 'empty');

  const meta = result.meta;
  assert.equal(meta.errorCode, 'empty');
  assert.equal(meta.finishKind, 'stop', '必须保留真实 finish，不能把 empty 改写为“空生成”');
  assert.equal(meta.finishReason, 'stop');
  assert.equal(meta.textChars, 0);
  assert.equal(meta.streamOpened, true);
  assert.equal(meta.chunkCount, 1);
  assert.equal(meta.timedOut, false);
  assert.equal(meta.aborted, false);

  // 失败时原始输出只挂非枚举诊断字段，供有界样本使用；不进入 JSON/结果正文。
  assert.equal(Object.keys(result).includes('diagnosticText'), false);
  assert.equal(JSON.stringify(result).includes('diagnosticText'), false);
});

test('超时/取消 meta：timedOut / aborted 是真实标志位，不是从文本推断', async () => {
  const timed = analyzerHarness({
    setTimer(fn) {
      fn();
      return { unref() {} };
    },
    chunks: [],
  });
  const timeout = await timed.analyzer.analyze({ frames: [FRAME_A] });
  assert.equal(timeout.reason, 'timeout');
  assert.equal(timeout.meta.timedOut, true);
  assert.equal(timeout.meta.aborted, false);
  assert.equal(timeout.meta.streamOpened, true);
  assert.equal(timeout.meta.chunkCount, 0);

  const controller = new AbortController();
  controller.abort();
  const aborted = await timed.analyzer.analyze({ frames: [FRAME_A], signal: controller.signal });
  assert.equal(aborted.reason, 'aborted');
  assert.equal(aborted.meta.aborted, true);
  assert.equal(aborted.meta.timedOut, false);
  assert.equal(aborted.meta.streamOpened, false);
  assert.equal(aborted.meta.imageCount, 0);
});

// ---------------------------------------------------------------------------
// runtime：empty / bad-json 保留真实原因与 meta
// ---------------------------------------------------------------------------

function createFakeClock(start = 1_000_000) {
  let now = start;
  let sequence = 0;
  const timers = [];
  return {
    now: () => now,
    setTimer(fn, delay = 0) {
      sequence += 1;
      const timer = {
        id: sequence,
        dueAt: now + Math.max(0, Number(delay) || 0),
        fn,
        cleared: false,
        unref() {},
      };
      timers.push(timer);
      return timer;
    },
    clearTimer(timer) {
      if (timer !== null && typeof timer === 'object') timer.cleared = true;
    },
    advance(ms) {
      now += Math.max(0, Number(ms) || 0);
      for (;;) {
        const due = timers
          .filter((timer) => !timer.cleared && timer.dueAt <= now)
          .sort((left, right) => left.dueAt - right.dueAt || left.id - right.id)[0];
        if (due === undefined) break;
        due.cleared = true;
        due.fn();
      }
    },
  };
}

function validText() {
  return JSON.stringify({
    sceneSummary: '桌面上有一个打开的窗口',
    events: [],
    unresolved: '',
  });
}

function requestMeta(overrides = {}) {
  return {
    provider: 'demo',
    model: 'vision-model',
    imageCount: 2,
    contentBlockTypes: ['text', 'image'],
    maxTokens: 800,
    textChars: 0,
    reasoningChars: 0,
    finishKind: 'stop',
    finishReason: 'stop',
    errorCode: 'empty',
    timedOut: false,
    aborted: false,
    streamOpened: true,
    chunkCount: 1,
    durationMs: 12,
    ...overrides,
  };
}

function makeRuntime(clock, overrides = {}) {
  return createUnderstandingRuntime({
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    minIntervalMs: 1,
    maxFrames: 3,
    framesBetween: () => [FRAME_A, FRAME_B],
    audioBetween: () => [],
    analyze: async () => validText(),
    ...overrides,
  });
}

test('runtime：empty 失败保留 stream-error/empty 与 finish meta，不误判 no-image-support', async () => {
  const clock = createFakeClock();
  const emitted = [];
  const runtime = makeRuntime(clock, {
    analyze: async () => ({
      ok: false,
      text: '',
      reason: 'stream-error',
      images: 2,
      errorCode: 'empty',
      meta: requestMeta(),
    }),
    emit: (event) => emitted.push(event),
  });

  const result = await runtime.runNow({ ...INTERVAL, reason: 'empty' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'stream-error');
  assert.notEqual(result.reason, 'no-image-support');

  const status = runtime.status();
  assert.equal(status.lastReason, 'stream-error');
  assert.equal(status.lastReasonCode, 'stream-error');
  assert.equal(status.lastErrorCode, 'empty');
  assert.equal(status.lastError, 'empty');
  assert.equal(status.lastMeta.errorCode, 'empty');
  assert.equal(status.lastMeta.finishKind, 'stop');
  assert.equal(status.lastMeta.textChars, 0);
  assert.equal(status.lastMeta.streamOpened, true);
  assert.equal(status.failures, 1);
  assert.equal(status.sampleCount, 1);
  assert.equal(status.degraded, false);

  // 状态和事件只带机器字段，不含正文或路径。
  assert.equal(JSON.stringify(status).includes('C:\\'), false);
  assert.equal(JSON.stringify(emitted).includes('C:\\'), false);
  assert.equal(runtime.render(), '');
});

test('runtime：bad-json 保留请求 meta 和 head 样本，原因不被 no-scene/no-image-support 覆盖', async () => {
  const clock = createFakeClock();
  const emitted = [];
  const raw = '{坏输出 不是 JSON';
  const runtime = makeRuntime(clock, {
    analyze: async () => ({
      ok: true,
      text: raw,
      reason: 'ok',
      images: 2,
      meta: requestMeta({ errorCode: '', textChars: raw.length, chunkCount: 3 }),
    }),
    emit: (event) => emitted.push(event),
  });

  const result = await runtime.runNow({ ...INTERVAL, reason: 'bad-json' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'bad-json');
  assert.notEqual(result.reason, 'no-scene');
  assert.notEqual(result.reason, 'no-image-support');

  const status = runtime.status();
  assert.equal(status.lastReason, 'bad-json');
  assert.equal(status.lastError, 'bad-json');
  assert.equal(status.lastMeta.textChars, raw.length);
  assert.equal(status.lastMeta.finishKind, 'stop');
  assert.equal(status.rawChars, raw.length);
  assert.ok(status.rawHash.length > 0);
  assert.equal(status.sampleCount, 1);

  const samples = runtime.samples();
  assert.equal(samples.length, 1);
  assert.equal(samples[0].reason, 'bad-json');
  assert.ok(samples[0].head.includes('坏输出'));
  assert.equal(JSON.stringify(status).includes('坏输出'), false, 'status 不进入正文');
  assert.equal(JSON.stringify(emitted).includes('坏输出'), false, '事件不进入正文');
  assert.equal(runtime.render(), '', 'bad-json 不产生注入块');
});

// ---------------------------------------------------------------------------
// 样本：head+tail、3 条上限、TTL、清空、meta 白名单
// ---------------------------------------------------------------------------

test('失败样本：最多 3 条，每条 head+tail ≤2KB，10 分钟过期，clear 清空', () => {
  const clock = createFakeClock();
  const store = createUnderstandingSamples({
    now: clock.now,
    // 故意传超过硬上限的值，验证模块不会放大预算。
    maxEntries: 10,
    maxBodyBytes: 8 * 1024,
    ttlMs: 10 * 60_000,
  });
  assert.equal(store.status().maxEntries, 3);
  assert.equal(store.status().maxBodyBytes, 2 * 1024);
  assert.equal(store.status().ttlMs, UNDERSTANDING_SAMPLES_DEFAULTS.ttlMs);

  const long = 'HEAD-' + '中'.repeat(3_000) + '-TAIL';
  for (let index = 0; index < 4; index += 1) {
    store.record({
      reason: 'bad-json',
      errorCode: 'empty',
      text: `${index}:${long}`,
      meta: requestMeta({ textChars: long.length + 2 }),
    });
  }

  assert.equal(store.count(), 3, '第 4 条挤掉最旧一条');
  const samples = store.list();
  assert.equal(samples.length, 3);
  assert.equal(samples[0].head.startsWith('1:HEAD-'), true);
  assert.equal(samples[2].head.startsWith('3:HEAD-'), true);
  for (const sample of samples) {
    assert.equal(sample.truncated, true);
    assert.equal(sample.headBytes + sample.tailBytes <= 2 * 1024, true);
    assert.equal(Buffer.byteLength(sample.head + sample.tail, 'utf8') <= 2 * 1024, true);
    assert.ok(sample.head.includes('HEAD-'));
    assert.ok(sample.tail.endsWith('-TAIL'));
    assert.equal(sample.reason, 'bad-json');
    assert.equal(sample.errorCode, 'empty');
    assert.equal(sample.meta.finishKind, 'stop');
  }

  // 恰好 10 分钟仍保留；多 1ms 自动过期。
  clock.advance(10 * 60_000);
  assert.equal(store.count(), 3);
  clock.advance(1);
  assert.equal(store.count(), 0);
  assert.deepEqual(store.list(), []);

  store.record({ reason: 'stream-error', text: 'short' });
  assert.equal(store.count(), 1);
  store.clear();
  assert.equal(store.count(), 0);
});

test('失败样本：路径脱敏、meta 只收白名单、正文不复制截图/路径', () => {
  const store = createUnderstandingSamples({ now: () => 1_000_000 });
  const sample = store.record({
    reason: 'read-failed',
    text: '读取 C:\\shots\\one.png 失败',
    meta: {
      provider: 'demo',
      model: 'vision-model',
      imageCount: 1,
      textChars: 10,
      text: '不允许复制的正文',
      path: 'C:\\shots\\one.png',
      file: 'C:\\shots\\one.png',
    },
  });

  assert.equal(Buffer.byteLength(sample.head + sample.tail, 'utf8') <= 2 * 1024, true);
  assert.equal(sample.head.includes('C:\\shots'), false);
  assert.equal(sample.head.includes('[path]'), true);
  assert.equal(sample.redacted, true);
  assert.equal(sample.meta.provider, 'demo');
  assert.equal(sample.meta.imageCount, 1);
  assert.equal('text' in sample.meta, false);
  assert.equal('path' in sample.meta, false);
  assert.equal('file' in sample.meta, false);
  assert.equal(JSON.stringify(sample).includes('C:\\shots'), false);
});

// ---------------------------------------------------------------------------
// 退避 / 降级 / 成功后重置
// ---------------------------------------------------------------------------

test('连续 3 次失败进入指数退避；调度器不再请求；成功重置；手动 runNow 绕过一次', async () => {
  const clock = createFakeClock();
  let calls = 0;
  let mode = 'fail';
  const runtime = makeRuntime(clock, {
    failureThreshold: 3,
    backoffBaseMs: 1_000,
    backoffMaxMs: 1_500,
    analyze: async () => {
      calls += 1;
      if (mode === 'ok') {
        return { ok: true, text: validText(), reason: 'ok', images: 2, meta: requestMeta({ errorCode: '' }) };
      }
      return {
        ok: false,
        text: '',
        reason: 'stream-error',
        images: 2,
        errorCode: 'rate_limited',
        meta: requestMeta({ errorCode: 'rate_limited' }),
      };
    },
  });

  for (let index = 0; index < 3; index += 1) {
    // eslint-disable-next-line no-await-in-loop
    const result = await runtime.runNow({ ...INTERVAL, reason: `fail-${index}` });
    assert.equal(result.ok, false);
  }
  assert.equal(calls, 3);

  const degraded = runtime.status();
  assert.equal(degraded.degraded, true);
  assert.equal(degraded.failureStreak, 3);
  assert.equal(degraded.lastError, 'rate_limited');
  assert.equal(degraded.backoffMs, 1_000);
  assert.equal(degraded.retryAt, clock.now() + 1_000);
  assert.equal(degraded.sampleCount, 3, '样本最多 3 条');
  assert.equal(degraded.lastMeta.errorCode, 'rate_limited');

  // 退避期内 noteChange 仍保留采集，但不排队、不请求。
  const noted = runtime.noteChange({ ...INTERVAL, reason: 'during-backoff', priority: true });
  assert.equal(noted.accepted, false);
  assert.equal(noted.reason, 'backoff');
  assert.equal(noted.degraded, true);
  assert.equal(noted.retryAt, degraded.retryAt);
  assert.equal(calls, 3, '退避期内不调用 analyze');

  clock.advance(999);
  const still = runtime.noteChange({ ...INTERVAL, reason: 'still-backoff' });
  assert.equal(still.accepted, false);
  assert.equal(calls, 3);

  // 到 retryAt 后放行一次探测；失败则退避翻倍（上限 1500）。
  clock.advance(1);
  const queued = runtime.noteChange({ ...INTERVAL, reason: 'retry-now' });
  assert.notEqual(queued.accepted, false);
  const probed = await runtime.scheduler.flush();
  assert.equal(probed.ok, false);
  assert.equal(calls, 4);

  const grown = runtime.status();
  assert.equal(grown.degraded, true);
  assert.equal(grown.failureStreak, 4);
  assert.equal(grown.backoffMs, 1_500, '指数增长受上限约束');
  assert.equal(grown.retryAt, clock.now() + 1_500);

  // 手动 runNow 在退避期内绕过一次；成功即重置所有退避状态。
  mode = 'ok';
  const bypass = await runtime.runNow({ ...INTERVAL, reason: 'manual-bypass' });
  assert.equal(bypass.ok, true);
  assert.equal(calls, 5);

  const reset = runtime.status();
  assert.equal(reset.degraded, false);
  assert.equal(reset.failureStreak, 0);
  assert.equal(reset.retryAt, null);
  assert.equal(reset.backoffMs, 0);
  assert.equal(reset.lastError, '');
  assert.equal(reset.lastReason, 'ok');
  assert.equal(reset.lastMeta.errorCode, '');
});

test('手动 runNow 的退避绕过只给一次：再失败后继续被挡住，不烧请求', async () => {
  const clock = createFakeClock();
  let calls = 0;
  const runtime = makeRuntime(clock, {
    failureThreshold: 3,
    backoffBaseMs: 1_000,
    backoffMaxMs: 8_000,
    analyze: async () => {
      calls += 1;
      return {
        ok: false,
        text: '',
        reason: 'stream-error',
        images: 2,
        errorCode: 'timeout',
        meta: requestMeta({ errorCode: 'timeout', timedOut: true, finishKind: '' }),
      };
    },
  });

  for (let index = 0; index < 3; index += 1) {
    // eslint-disable-next-line no-await-in-loop
    await runtime.runNow({ ...INTERVAL, reason: `fail-${index}` });
  }
  assert.equal(calls, 3);
  assert.equal(runtime.status().degraded, true);

  // 第一次手动：绕过并真实请求一次，但仍失败 -> 重新进入退避。
  const bypass = await runtime.runNow({ ...INTERVAL, reason: 'manual-fail' });
  assert.equal(bypass.ok, false);
  assert.notEqual(bypass.reason, 'backoff');
  assert.equal(calls, 4);
  assert.equal(runtime.status().degraded, true);

  // 第二次手动：绕过额度已用完，直接 backoff，不再调用 analyze。
  const blocked = await runtime.runNow({ ...INTERVAL, reason: 'manual-blocked' });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'backoff');
  assert.equal(blocked.retryAt, runtime.status().retryAt);
  assert.equal(blocked.lastError, 'timeout');
  assert.equal(calls, 4, '第二次手动不得再发请求');
});

test('隐私 clear 清空样本与退避；普通 skip 不增加失败/样本', async () => {
  const clock = createFakeClock();
  let framesMode = 'normal';
  const runtime = makeRuntime(clock, {
    failureThreshold: 3,
    framesBetween: () => (framesMode === 'empty' ? [] : [FRAME_A, FRAME_B]),
    analyze: async () => ({
      ok: false,
      text: '',
      reason: 'stream-error',
      images: 2,
      errorCode: 'empty',
      meta: requestMeta(),
    }),
  });

  for (let index = 0; index < 3; index += 1) {
    // eslint-disable-next-line no-await-in-loop
    await runtime.runNow({ ...INTERVAL, reason: `fail-${index}` });
  }
  assert.equal(runtime.status().degraded, true);
  assert.equal(runtime.status().sampleCount, 3);
  assert.equal(runtime.samples().length, 3);

  const cleared = runtime.clear('privacy');
  assert.equal(cleared.degraded, false);
  assert.equal(cleared.retryAt, null);
  assert.equal(cleared.failureStreak, 0);
  assert.equal(cleared.lastError, '');
  assert.equal(cleared.sampleCount, 0);
  assert.deepEqual(runtime.samples(), []);

  // skip 不是失败：不增加 failures、不写样本、不触发退避。
  framesMode = 'empty';
  const skipped = await runtime.runNow({ ...INTERVAL, reason: 'skip' });
  assert.equal(skipped.ok, false);
  assert.equal(skipped.reason, 'no-frames');
  assert.equal(runtime.status().failures, 3, '只在 before 的 3 次失败上累计');
  assert.equal(runtime.status().sampleCount, 0);
  assert.equal(runtime.status().degraded, false);
});
