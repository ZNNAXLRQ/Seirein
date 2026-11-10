/**
 * P-187 截断修复验收：
 *
 *   1. 理解请求默认预算至少 4096；`finishKind=max-tokens` 时最多提高预算重试一次，
 *      仍是同一 provider/model（不自动换模型），成功后正文可正常解析；
 *   2. 重试仍截断时明确归因 `truncated` / `errorCode:max-tokens`，不把半截正文记成 bad-json；
 *   3. 非截断的坏 JSON 仍按 bad-json 记账，不被截断归因吞掉；
 *   4. 截断计入连续失败退避：退避期内不请求，成功后重置；单次 analyze 最多两次请求，
 *      两次 token 上限之和不超过配置成本上限；
 *   5. 诊断 meta 保留 text/reasoning/token/finish 与 attempt 计数。
 *
 * 所有模型、附件、文件读取都是假实现；不触网、不读真实截图、不产生真实调用。
 *
 * Run: node --test test/vision-understanding-truncation.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  IMAGE_ANALYZER_DEFAULTS,
  createImageAnalyzer,
} from '../src/host/vision/image-analyzer.js';
import { createUnderstandingRuntime } from '../src/host/vision/understanding-runtime.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const INTERVAL = { from: 1_000_000, to: 1_020_000 };
const FRAME_A = { id: 'frame-a', capturedAt: 1_000_000, file: 'C:\\shots\\one.png' };
const FRAME_B = { id: 'frame-b', capturedAt: 1_005_000, file: 'C:\\shots\\two.png' };
const PROVIDER = 'deepseek-account';
const MODEL = 'deepseek-flash';
const REASONING = '推理'.repeat(1_270); // 2540 字符，与现场 meta.reasoningChars 对齐。
const PARTIAL_ONE = '{"sceneSummary":"桌面';
const PARTIAL_TWO = '{"sceneSummary":"桌面上有一个窗口';
const VALID_TEXT = JSON.stringify({
  sceneSummary: '桌面上有一个打开的窗口',
  events: [],
  unresolved: '',
});

function finish(kind) {
  return { type: 'finish', reason: { kind } };
}

function attempt(body, kind, reasoning = REASONING) {
  return [
    { type: 'reasoning-delta', text: reasoning },
    { type: 'text-delta', text: body },
    finish(kind),
  ];
}

/** 只构造 image-analyzer；stream 按顺序消费 scripts，每多一次请求都记录在案。 */
function analyzerHarness({ scripts, maxTokens, retryMaxTokens, maxTotalTokens } = {}) {
  const streams = [];
  let next = 0;
  const services = {
    agentDefaultModel: {
      currentSelection: () => ({ provider: PROVIDER, model: MODEL }),
    },
    attachments: {
      async saveImage({ name }) {
        return { id: `att-${name}` };
      },
    },
    llm: {
      async resolveModelInfo() {
        return { inputModalities: ['text', 'image'] };
      },
      stream(options) {
        streams.push({
          provider: options.provider,
          model: options.model,
          maxTokens: options.maxTokens,
        });
        const chunks = scripts[next];
        next += 1;
        if (chunks === undefined) throw new Error('unexpected extra model request');
        return (async function* emit() {
          for (const chunk of chunks) yield chunk;
        })();
      },
    },
  };
  const analyzer = createImageAnalyzer({
    getService: (name) => services[name],
    readFile: async () => PNG,
    maxTokens,
    retryMaxTokens,
    maxTotalTokens,
    timeoutMs: 5_000,
  });
  return { analyzer, streams };
}

function fakeClock(start = 1_000_000) {
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

function runtimeHarness(clock, analyze, overrides = {}) {
  return createUnderstandingRuntime({
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    minIntervalMs: 1,
    failureThreshold: 3,
    backoffBaseMs: 1_000,
    backoffMaxMs: 8_000,
    framesBetween: () => [FRAME_A, FRAME_B],
    audioBetween: () => [],
    ...overrides,
    analyze,
  });
}

function requestMeta(overrides = {}) {
  return {
    provider: PROVIDER,
    model: MODEL,
    imageCount: 2,
    contentBlockTypes: ['text', 'image'],
    maxTokens: IMAGE_ANALYZER_DEFAULTS.maxTokens,
    textChars: 0,
    reasoningChars: 0,
    finishKind: 'stop',
    finishReason: 'stop',
    errorCode: '',
    timedOut: false,
    aborted: false,
    streamOpened: true,
    chunkCount: 2,
    durationMs: 10,
    ...overrides,
  };
}

function analyzeInput() {
  return {
    system: 'system',
    user: 'user',
    frames: [FRAME_A, FRAME_B],
    audioLines: [],
    interval: INTERVAL,
  };
}

test('a) 默认预算 ≥4096；首次 max-tokens 后提高预算重试一次，成功正文可解析', async () => {
  assert.ok(IMAGE_ANALYZER_DEFAULTS.maxTokens >= 4096, '默认输出预算至少 4096');
  const { analyzer, streams } = analyzerHarness({
    scripts: [attempt(PARTIAL_ONE, 'max-tokens'), attempt(VALID_TEXT, 'stop')],
  });

  const result = await analyzer.analyze(analyzeInput());
  assert.equal(result.ok, true);
  assert.equal(result.text, VALID_TEXT);
  assert.equal(streams.length, 2, '截断后只重试一次');
  assert.equal(streams[0].maxTokens, 4096, '首次使用默认预算');
  assert.equal(streams[1].maxTokens, 8192, '截断重试提高预算');
  assert.deepEqual(
    [streams[0].provider, streams[0].model, streams[1].provider, streams[1].model],
    [PROVIDER, MODEL, PROVIDER, MODEL],
    '重试不自动换模型',
  );
  assert.equal(result.meta.attempts, 2);
  assert.equal(result.meta.maxTokens, 8192, 'meta 反映最终一次请求的实际预算');
  assert.equal(result.meta.budget.maxTokens, 4096, 'budget 保留配置上限');
  assert.equal(result.meta.finishKind, 'stop');
  assert.equal(result.meta.textChars, VALID_TEXT.length);
  assert.ok(
    streams.reduce((sum, request) => sum + request.maxTokens, 0)
      <= IMAGE_ANALYZER_DEFAULTS.maxTotalTokens,
    '单次 analyze 的总 token 上限受成本上限约束',
  );

  // 成功后的正文确实能被理解运行时解析，而不是停在 bad-json。
  const clock = fakeClock();
  const runtimeAnalyzer = analyzerHarness({
    scripts: [attempt(PARTIAL_ONE, 'max-tokens'), attempt(VALID_TEXT, 'stop')],
  }).analyzer;
  const runtime = runtimeHarness(clock, (options) => runtimeAnalyzer.analyze(options));
  const run = await runtime.runNow({ ...INTERVAL, reason: 'after-retry' });
  assert.equal(run.ok, true);
  assert.equal(runtime.status().lastReason, 'ok');
  assert.equal(runtime.status().lastMeta.maxTokens, 8192);
  assert.equal(runtime.status().lastMeta.finishKind, 'stop');
  assert.equal(runtime.status().degraded, false);
});

test('b) 两次都 max-tokens：明确 truncated/max-tokens，最多两次且保留诊断 meta', async () => {
  const { analyzer, streams } = analyzerHarness({
    scripts: [
      attempt(PARTIAL_ONE, 'max-tokens'),
      attempt(PARTIAL_TWO, 'max-tokens'),
    ],
  });

  const result = await analyzer.analyze(analyzeInput());
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'truncated', '不得只报 stream-error/empty');
  assert.equal(result.errorCode, 'max-tokens');
  assert.equal(result.images, 2);
  assert.equal(streams.length, 2, '最多两次请求，绝不无限重试');
  assert.equal(result.meta.attempts, 2);
  assert.equal(result.meta.finishKind, 'max-tokens', '保留真实 finish');
  assert.equal(result.meta.finishReason, 'max-tokens');
  assert.equal(result.meta.maxTokens, 8192);
  assert.equal(result.meta.reasoningChars, REASONING.length, '保留推理长度');
  assert.equal(result.meta.textChars, PARTIAL_TWO.length, '保留正文长度');
  assert.equal(result.diagnosticText, PARTIAL_TWO, '半截正文只进入非枚举诊断字段');

  // 运行时把它记成 truncated/max-tokens，而不是解析成 bad-json。
  const clock = fakeClock();
  const runtimeAnalyzer = analyzerHarness({
    scripts: [
      attempt(PARTIAL_ONE, 'max-tokens'),
      attempt(PARTIAL_TWO, 'max-tokens'),
    ],
  }).analyzer;
  const runtime = runtimeHarness(clock, (options) => runtimeAnalyzer.analyze(options));
  const run = await runtime.runNow({ ...INTERVAL, reason: 'still-truncated' });
  assert.equal(run.ok, false);
  assert.equal(run.reason, 'truncated');
  assert.notEqual(run.reason, 'bad-json');
  assert.equal(run.errorCode, 'max-tokens');

  const status = runtime.status();
  assert.equal(status.lastReason, 'truncated');
  assert.equal(status.lastReasonCode, 'truncated');
  assert.equal(status.lastErrorCode, 'max-tokens');
  assert.equal(status.lastError, 'max-tokens');
  assert.equal(status.lastMeta.finishKind, 'max-tokens');
  assert.equal(status.lastMeta.maxTokens, 8192);
  assert.equal(status.lastMeta.reasoningChars, REASONING.length);
  assert.equal(status.lastMeta.textChars, PARTIAL_TWO.length);
  assert.equal(status.failures, 1);
  assert.equal(status.degraded, false);
  assert.equal(JSON.stringify(status).includes(PARTIAL_TWO), false, 'status 不进入正文');

  const sample = runtime.samples()[0];
  assert.equal(sample.reason, 'truncated');
  assert.equal(sample.errorCode, 'max-tokens');
  assert.equal(sample.meta.finishKind, 'max-tokens');
  assert.ok(sample.head.includes('sceneSummary'), '失败样本保留有界正文');
});

test('c) 运行时对成功包装但 finish=max-tokens 的输出也归因 truncated，不误报 bad-json', async () => {
  const clock = fakeClock();
  const emitted = [];
  const runtime = runtimeHarness(clock, async () => ({
    ok: true,
    text: PARTIAL_ONE,
    reason: 'ok',
    images: 2,
    meta: requestMeta({
      maxTokens: 8192,
      finishKind: 'max-tokens',
      finishReason: 'max-tokens',
      textChars: PARTIAL_ONE.length,
      reasoningChars: REASONING.length,
    }),
  }), { emit: (event) => emitted.push(event) });

  const result = await runtime.runNow({ ...INTERVAL, reason: 'ok-wrapper-truncated' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'truncated');
  assert.equal(result.errorCode, 'max-tokens');

  const status = runtime.status();
  assert.equal(status.lastReason, 'truncated');
  assert.equal(status.lastErrorCode, 'max-tokens');
  assert.equal(status.lastMeta.finishKind, 'max-tokens');
  assert.equal(status.lastMeta.maxTokens, 8192);
  assert.equal(status.lastMeta.reasoningChars, REASONING.length);
  assert.equal(status.sampleCount, 1);
  assert.equal(JSON.stringify(emitted).includes(PARTIAL_ONE), false);
});

test('d) 非截断的坏 JSON 仍是 bad-json，不被截断归因覆盖', async () => {
  const clock = fakeClock();
  const bad = '{坏输出 不是 JSON';
  const runtime = runtimeHarness(clock, async () => ({
    ok: true,
    text: bad,
    reason: 'ok',
    images: 2,
    meta: requestMeta({ finishKind: 'stop', textChars: bad.length }),
  }));

  const result = await runtime.runNow({ ...INTERVAL, reason: 'plain-bad-json' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'bad-json');
  assert.equal(result.errorCode, '');

  const status = runtime.status();
  assert.equal(status.lastReason, 'bad-json');
  assert.equal(status.lastError, 'bad-json');
  assert.equal(status.lastErrorCode, '');
  assert.equal(status.lastMeta.finishKind, 'stop');
  assert.equal(status.rawChars, bad.length);
  assert.ok(status.rawHash.length > 0);
});

test('e) 截断计入连续失败退避；退避期不请求，成功后重置', async () => {
  const clock = fakeClock();
  let calls = 0;
  let mode = 'truncated';
  const runtime = runtimeHarness(clock, async () => {
    calls += 1;
    if (mode === 'ok') {
      return {
        ok: true,
        text: VALID_TEXT,
        reason: 'ok',
        images: 2,
        meta: requestMeta({ finishKind: 'stop', textChars: VALID_TEXT.length }),
      };
    }
    return {
      ok: false,
      text: '',
      reason: 'truncated',
      images: 2,
      errorCode: 'max-tokens',
      meta: requestMeta({
        finishKind: 'max-tokens',
        finishReason: 'max-tokens',
        errorCode: 'max-tokens',
        maxTokens: 8192,
        textChars: PARTIAL_ONE.length,
        reasoningChars: REASONING.length,
      }),
    };
  });

  for (let index = 0; index < 3; index += 1) {
    // eslint-disable-next-line no-await-in-loop
    const result = await runtime.runNow({ ...INTERVAL, reason: `truncated-${index}` });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'truncated');
  }
  assert.equal(calls, 3);

  const degraded = runtime.status();
  assert.equal(degraded.degraded, true);
  assert.equal(degraded.failureStreak, 3);
  assert.equal(degraded.lastReason, 'truncated');
  assert.equal(degraded.lastError, 'max-tokens');
  assert.equal(degraded.backoffMs, 1_000);
  assert.equal(degraded.retryAt, clock.now() + 1_000);

  // 退避期内调度器不得绕过退避再请求；挂起队列不产生新的模型调用。
  const noted = runtime.noteChange({ ...INTERVAL, reason: 'during-backoff', priority: true });
  assert.equal(noted.accepted, false);
  assert.equal(noted.reason, 'backoff');
  assert.equal(calls, 3, '退避期内不调用 analyze');

  // 手动入口仍保留一次显式绕过；成功即重置退避，不在失败状态里继续烧请求。
  mode = 'ok';
  const reset = await runtime.runNow({ ...INTERVAL, reason: 'manual-success' });
  assert.equal(reset.ok, true);
  assert.equal(calls, 4);

  const recovered = runtime.status();
  assert.equal(recovered.degraded, false);
  assert.equal(recovered.failureStreak, 0);
  assert.equal(recovered.retryAt, null);
  assert.equal(recovered.backoffMs, 0);
  assert.equal(recovered.lastError, '');
  assert.equal(recovered.lastReason, 'ok');
});

test('f) length 也是 token 上限截断：重试后仍截断则 errorCode 归一为 max-tokens', async () => {
  const { analyzer, streams } = analyzerHarness({
    scripts: [
      attempt(PARTIAL_ONE, 'length'),
      attempt(PARTIAL_TWO, 'length'),
    ],
  });

  const result = await analyzer.analyze(analyzeInput());
  assert.equal(streams.length, 2);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'truncated');
  assert.equal(result.errorCode, 'max-tokens');
  assert.equal(result.meta.finishKind, 'length', 'meta 保留 provider 的原始 finish 机器码');
});
