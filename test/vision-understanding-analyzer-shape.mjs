/**
 * P-187 阶段 3/4 接缝：understanding-runtime 必须看懂真实 image-analyzer.analyze 的包装形状。
 *
 * 真实分析器返回 `{ok:true,text,reason:'ok',images}` 或 `{ok:false,text:'',reason,images}`。
 * 运行时曾把整个对象当作 raw 交给 parseUnderstanding，导致线上每一次都因找不到 sceneSummary
 * 记成 `no-scene`，真实的 `no-image-support` / `read-failed` / `timeout` 全被吞掉。这里锁定：
 *
 *   1. 成功包装只把 text 交给解析器，images 不进入状态；
 *   2. 失败包装按原 reason 记失败，绝不解析（哪怕 text 本身是合法 JSON），也不触发 onAdvance；
 *   3. 裸字符串 / 裸对象（旧测试和自定义 analyze 的形状）仍原样当 raw；
 *   4. throw 才记 analyze-error；失败/取消/代次路径不回归。
 *
 * Run: node --test test/vision-understanding-analyzer-shape.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createUnderstandingRuntime } from '../src/host/vision/understanding-runtime.js';

/** 可手动推进的假时钟；与 runtime/scheduler 的注入接口一致。 */
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
    },
  };
}

function frame(id, capturedAt) {
  return { id, capturedAt, file: `C:\\shots\\${id}.png`, source: 'screen' };
}

const FRAMES = [
  frame('frame-a', 1_000_000),
  frame('frame-b', 1_005_000),
  frame('frame-c', 1_010_000),
];

const AUDIO_LINES = [
  { id: 'audio-a', audioStartAt: 1_001_000, audioEndAt: 1_002_000, text: '你好' },
];

/** 合法理解输出（JSON 文本）。 */
function validText(interval) {
  return JSON.stringify({
    sceneSummary: '桌面上有一个打开的窗口',
    events: [
      {
        from: interval.from,
        to: Math.min(interval.to, interval.from + 2_000),
        description: '窗口出现',
        evidenceFrameIds: ['frame-a'],
        evidenceAudioIds: ['audio-a'],
        uncertainty: '',
      },
    ],
    unresolved: '看不清窗口标题',
  });
}

/** 真实分析器成功包装。 */
function successResult(interval, overrides = {}) {
  return {
    ok: true,
    text: validText(interval),
    reason: 'ok',
    images: 3,
    ...overrides,
  };
}

/** 真实分析器失败包装。 */
function failureResult(reason, overrides = {}) {
  return {
    ok: false,
    text: '',
    reason,
    images: 0,
    ...overrides,
  };
}

function makeRuntime(clock, overrides = {}) {
  return createUnderstandingRuntime({
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    minIntervalMs: 15_000,
    maxFrames: 3,
    framesBetween: () => FRAMES.slice(),
    audioBetween: () => AUDIO_LINES.slice(),
    analyze: async (input) => successResult(input.interval),
    ...overrides,
  });
}

/** 让出微任务直到 predicate 成立；只用于测试替身，不消耗真实时间。 */
async function waitFor(predicate) {
  for (let i = 0; i < 50 && !predicate(); i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve();
  }
  assert.ok(predicate(), '异步编排没有推进到预期状态');
}

test('成功包装 {ok:true,text,reason:"ok",images:3}：解析 text，状态写回，onAdvance 触发一次', async () => {
  const clock = createFakeClock();
  const advances = [];
  const runtime = makeRuntime(clock, {
    analyze: async (input) => successResult(input.interval, { images: 3 }),
    onAdvance: (payload) => advances.push(payload),
  });

  const result = await runtime.runNow({ from: 1_000_000, to: 1_020_000, reason: 'shape-ok' });

  assert.equal(result.ok, true);
  assert.equal(result.reason, undefined, 'runtime 结果不该回传分析器的 ok reason');
  assert.equal(result.parsed.sceneSummary, '桌面上有一个打开的窗口');
  assert.equal(result.parsed.events.length, 1);
  assert.equal(result.parsed.events[0].description, '窗口出现');
  assert.deepEqual(result.parsed.events[0].evidenceFrameIds, ['frame-a']);
  assert.deepEqual(result.parsed.events[0].evidenceAudioIds, ['audio-a']);
  assert.equal(result.parsed.droppedEvents, 0);

  const current = runtime.current();
  assert.equal(current.sceneSummary, '桌面上有一个打开的窗口');
  assert.equal(current.unresolved, '看不清窗口标题');
  assert.equal(current.events.length, 1);
  assert.equal(runtime.status().failures, 0);
  assert.equal(runtime.status().lastReason, 'ok');
  assert.equal(runtime.status().lastEventCount, 1);
  assert.equal(advances.length, 1, '成功并入状态后只回调一次');
  assert.equal(advances[0].parsed.events[0].description, '窗口出现');
  assert.equal(advances[0].state.events[0].description, '窗口出现');
  assert.equal(JSON.stringify(runtime.status()).includes('images'), false, 'images 只是分析器诊断计数');
});

test('失败包装 {ok:false,reason}：原样保留真实 reason，不解析、不写状态、不回调', async () => {
  for (const reason of [
    'no-image-support',
    'read-failed',
    'timeout',
    'save-failed',
    'stream-error',
  ]) {
    const clock = createFakeClock();
    const emitted = [];
    const advances = [];
    // 故意让 text 是合法 JSON：失败时必须短路，绝不能“顺手”解析出场景。
    const runtime = makeRuntime(clock, {
      analyze: async (input) => failureResult(reason, {
        text: validText(input.interval),
        images: 2,
      }),
      emit: (event) => emitted.push(event),
      onAdvance: (payload) => advances.push(payload),
    });

    // eslint-disable-next-line no-await-in-loop
    const result = await runtime.runNow({ from: 1_000_000, to: 1_020_000, reason: 'shape-fail' });

    assert.equal(result.ok, false, `${reason}: 失败包装必须失败`);
    assert.equal(result.reason, reason, `${reason}: 真实 reason 不能被 no-scene 覆盖`);
    assert.equal(result.droppedEvents, 0, `${reason}: 分析器失败不计事件丢弃`);
    assert.equal(runtime.current(), null, `${reason}: 失败不得写入状态`);
    assert.equal(runtime.render(), '', `${reason}: 失败不得产生渲染块`);
    assert.equal(advances.length, 0, `${reason}: 失败不得触发 onAdvance`);
    assert.equal(runtime.status().runs, 1);
    assert.equal(runtime.status().failures, 1);
    assert.equal(runtime.status().lastReason, reason);
    assert.equal(runtime.status().lastEventCount, 0);

    const outcome = emitted.find((event) => event.type === 'understanding-run');
    assert.ok(outcome, `${reason}: 失败必须留下 understanding-run 诊断`);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.reason, reason);
    assert.equal(JSON.stringify(emitted).includes('桌面上有一个打开的窗口'), false);
  }
});

test('失败包装缺少 reason：回退 analyze-failed，不落到解析器', async () => {
  const clock = createFakeClock();
  const runtime = makeRuntime(clock, {
    analyze: async () => ({ ok: false, text: '', images: 0 }),
  });

  const result = await runtime.runNow({ from: 1_000_000, to: 1_020_000, reason: 'shape-no-reason' });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'analyze-failed');
  assert.equal(runtime.status().lastReason, 'analyze-failed');
  assert.equal(runtime.current(), null);
});

test('成功包装但 text 不是合法 JSON：交给解析器记 bad-json，而不是 no-scene', async () => {
  const clock = createFakeClock();
  const runtime = makeRuntime(clock, {
    analyze: async () => ({ ok: true, text: '{坏输出', reason: 'ok', images: 3 }),
  });

  const result = await runtime.runNow({ from: 1_000_000, to: 1_020_000, reason: 'shape-bad-json' });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'bad-json');
  assert.equal(runtime.status().failures, 1);
  assert.equal(runtime.current(), null);
});

test('对象含字符串 text 即按包装解析（不要求显式 ok 字段）', async () => {
  const clock = createFakeClock();
  const runtime = makeRuntime(clock, {
    analyze: async (input) => ({ text: validText(input.interval), images: 3 }),
  });

  const result = await runtime.runNow({ from: 1_000_000, to: 1_020_000, reason: 'shape-text-only' });

  assert.equal(result.ok, true);
  assert.equal(runtime.current().sceneSummary, '桌面上有一个打开的窗口');
});

test('裸字符串 / 裸对象保持原行为：直接作为 raw 解析', async () => {
  const clock = createFakeClock();
  let mode = 'string';
  const runtime = makeRuntime(clock, {
    analyze: async (input) => {
      if (mode === 'string') return validText(input.interval);
      return {
        sceneSummary: '裸对象场景',
        events: [
          {
            from: input.interval.from,
            to: input.interval.from + 1_000,
            description: '裸对象事件',
            evidenceFrameIds: ['frame-a'],
            evidenceAudioIds: [],
            uncertainty: '',
          },
        ],
        unresolved: '',
      };
    },
  });

  const fromString = await runtime.runNow({ from: 1_000_000, to: 1_020_000, reason: 'raw-string' });
  assert.equal(fromString.ok, true);
  assert.equal(fromString.parsed.sceneSummary, '桌面上有一个打开的窗口');

  mode = 'object';
  const fromObject = await runtime.runNow({ from: 1_000_000, to: 1_020_000, reason: 'raw-object' });
  assert.equal(fromObject.ok, true);
  assert.equal(fromObject.parsed.sceneSummary, '裸对象场景');
  assert.equal(runtime.current().sceneSummary, '裸对象场景');
  const events = runtime.current().events;
  assert.equal(events[events.length - 1].description, '裸对象事件', '第二次裸对象结果按到达顺序追加');
});

test('analyze 抛错仍记 analyze-error（唯一使用该标签的路径）', async () => {
  const clock = createFakeClock();
  const runtime = makeRuntime(clock, {
    analyze: async () => {
      throw new Error('boom C:\\secret\\frame-a.png');
    },
  });

  const result = await runtime.runNow({ from: 1_000_000, to: 1_020_000, reason: 'throw' });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'analyze-error');
  assert.equal(runtime.status().failures, 1);
  assert.equal(runtime.current(), null);
  const statusText = JSON.stringify(runtime.status());
  assert.equal(statusText.includes('boom'), false);
  assert.equal(statusText.includes('C:\\'), false);
});

test('在途成功包装 + clear 代次失效：返回 stale，不写状态、不计失败、不回调', async () => {
  const clock = createFakeClock();
  let started = false;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const advances = [];
  const runtime = makeRuntime(clock, {
    analyze: async (input) => {
      started = true;
      await gate;
      return successResult(input.interval);
    },
    onAdvance: (payload) => advances.push(payload),
  });

  const first = runtime.runNow({ from: 1_000_000, to: 1_020_000, reason: 'stale' });
  await waitFor(() => started);
  runtime.clear('privacy');
  release();

  const outcome = await first;
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, 'stale', 'late 的成功包装也不得写回');
  assert.equal(runtime.current(), null);
  assert.equal(runtime.status().failures, 0, '代次失效不计失败');
  assert.equal(advances.length, 0, '代次失效不得回调');
});

test('performRun 只在一处解开包装：真实 analyzer 的 images 不进入 status/current', async () => {
  const clock = createFakeClock();
  const runtime = makeRuntime(clock, {
    analyze: async (input) => successResult(input.interval, { images: 3, marker: 'analyzer-private' }),
  });

  assert.equal((await runtime.runNow({ from: 1_000_000, to: 1_020_000 })).ok, true);

  const statusText = JSON.stringify(runtime.status());
  const currentText = JSON.stringify(runtime.current());
  for (const leaked of ['analyzer-private', 'images', 'C:\\\\shots']) {
    assert.equal(statusText.includes(leaked), false, `status 泄漏 ${leaked}`);
    assert.equal(currentText.includes(leaked), false, `current 泄漏 ${leaked}`);
  }
});
