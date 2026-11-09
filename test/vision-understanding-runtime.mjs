/**
 * P-187 阶段 3：连续视听理解运行时编排（可测试纯模块）。
 *
 * 全部时间用假时钟/假定时器驱动，analyze 注入替身。覆盖：正常取证据与并入状态、坏 JSON、
 * 未知证据丢弃、无帧/被阻止跳过、单在途、clear 后旧结果不回写、状态过期、render 有界且
 * 不含路径/帧 id、stop 后不再触发、noteChange 委托调度器、analyze 抛错不外抛等。
 *
 * Run: node --test test/vision-understanding-runtime.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  UNDERSTANDING_RUNTIME_DEFAULTS,
  createUnderstandingRuntime,
} from '../src/host/vision/understanding-runtime.js';

/** 可手动推进的假时钟；setTimer/clearTimer 接口与 scheduler/runtime 的注入接口一致。 */
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
        unrefed: false,
        unref() {
          this.unrefed = true;
        },
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
          .sort((a, b) => a.dueAt - b.dueAt || a.id - b.id)[0];
        if (due === undefined) break;
        due.cleared = true;
        due.fn();
      }
    },
    pendingTimers: () => timers.filter((timer) => !timer.cleared).length,
  };
}

function frame(id, capturedAt, file = `C:\\shots\\${id}.png`) {
  return { id, capturedAt, file, source: 'screen' };
}

const FRAMES = [
  frame('frame-a', 1_000_000),
  frame('frame-b', 1_005_000),
  frame('frame-c', 1_010_000),
];

const AUDIO_LINES = [
  { id: 'audio-a', audioStartAt: 1_001_000, audioEndAt: 1_002_000, text: '你好' },
  { id: 'audio-b', audioStartAt: 1_006_000, audioEndAt: 1_007_000, text: '世界' },
];

function defaultReply(interval, overrides = {}) {
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
    ...overrides,
  });
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
    analyze: async (input) => defaultReply(input.interval),
    ...overrides,
  });
}

/** 等到异步编排推进到某个同步可见状态；只用于测试替身，不消耗真实时间。 */
async function waitFor(predicate) {
  for (let i = 0; i < 50 && !predicate(); i += 1) {
    // 每个 tick 让出一次微任务，足以穿过 framesBetween/audioBetween 的 await。
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve();
  }
  assert.ok(predicate(), '异步编排没有推进到预期状态');
}

test('正常：帧与台词进入提示词，analyze 收到带 file 的帧，解析结果并入 current', async () => {
  const clock = createFakeClock();
  const received = [];
  const runtime = makeRuntime(clock, {
    analyze: async (input) => {
      received.push(input);
      return defaultReply(input.interval);
    },
  });

  const result = await runtime.runNow({ from: 1_000_000, to: 1_020_000, reason: 'unit' });

  assert.equal(result.ok, true);
  assert.equal(result.reason, undefined);
  assert.equal(result.parsed.events.length, 1);
  assert.equal(received.length, 1);

  const input = received[0];
  assert.equal(typeof input.system, 'string');
  assert.equal(typeof input.user, 'string');
  assert.match(input.system, /JSON/);
  assert.match(input.user, /frame-a/);
  assert.equal(input.frames.length, 3);
  assert.ok(input.frames.length <= 3);
  assert.ok(input.frames.every((entry) => typeof entry.file === 'string'));
  assert.deepEqual(input.audioLines.map((line) => line.id), ['audio-a', 'audio-b']);
  assert.deepEqual(input.interval, { from: 1_000_000, to: 1_020_000 });

  const current = runtime.current();
  assert.equal(current.sceneSummary, '桌面上有一个打开的窗口');
  assert.equal(current.unresolved, '看不清窗口标题');
  assert.equal(current.events.length, 1);
  assert.deepEqual(current.events[0].evidenceFrameIds, ['frame-a']);
  assert.deepEqual(current.events[0].evidenceAudioIds, ['audio-a']);
  assert.equal(current.updatedAt, 1_000_000);

  // current 必须是副本：改返回对象不能影响内部状态。
  current.events[0].description = '被测试改掉';
  current.events[0].evidenceFrameIds.push('ghost');
  assert.equal(runtime.current().events[0].description, '窗口出现');
  assert.deepEqual(runtime.current().events[0].evidenceFrameIds, ['frame-a']);

  assert.equal(runtime.status().runs, 1);
  assert.equal(runtime.status().failures, 0);
  assert.equal(runtime.status().lastReason, 'ok');
  assert.equal(runtime.status().lastEventCount, 1);
});

test('runNow({focus})：关注文本进入分析器 user 的【本次关注点】', async () => {
  const clock = createFakeClock();
  const received = [];
  const runtime = makeRuntime(clock, {
    analyze: async (input) => {
      received.push(input);
      return defaultReply(input.interval);
    },
  });

  const focus = '角色为什么突然回头？';
  const result = await runtime.runNow({
    from: 1_000_000,
    to: 1_020_000,
    reason: 'focus',
    focus,
  });

  assert.equal(result.ok, true);
  assert.equal(received.length, 1);
  assert.match(received[0].user, /【本次关注点】/, '提示词必须有明确的关注点小节');
  assert.ok(received[0].user.includes(focus), '关注文本必须出现在 user 里');
  assert.equal(runtime.render().includes(focus), false, 'focus 只进提示词，不进被动渲染块');
  assert.equal(runtime.status().lastFocusChars, focus.length);
});

test('focus 超长/带换行：压成单行空格并截断到 200', async () => {
  const clock = createFakeClock();
  let received = null;
  const runtime = makeRuntime(clock, {
    analyze: async (input) => {
      received = input;
      return defaultReply(input.interval);
    },
  });

  const head = '长'.repeat(150);
  const tail = '尾'.repeat(100);
  const result = await runtime.runNow({
    from: 1_000_000,
    to: 1_020_000,
    reason: 'long-focus',
    focus: `${head}\n${tail}`,
  });

  assert.equal(result.ok, true);
  assert.equal(runtime.status().lastFocusChars, 200, '运行时把 focus 截到 200 字符');

  // 提示词层还会把关注点截到 160（含“已截断”标记）；这里只断言它仍是单行且前缀正确。
  const section = received.user
    .split('【本次关注点】\n')[1]
    .split('\n\n【覆盖缺口】')[0];
  assert.ok(!section.includes('\n'), '换行必须被压平，不能伪造出新的结构行');
  assert.ok(section.startsWith(`${head} `), '换行应压成空格并保留前缀');
  assert.ok(section.includes('尾'), '关注点本身的内容仍要保留');
  assert.ok(!section.includes('尾'.repeat(10)), '超出上限的尾部不得出现');
});

test('focus 非字符串：忽略且不影响运行', async () => {
  const clock = createFakeClock();
  const received = [];
  const runtime = makeRuntime(clock, {
    analyze: async (input) => {
      received.push(input);
      return defaultReply(input.interval);
    },
  });

  for (const focus of [12345, null, { text: '不是字符串' }, ['数组']]) {
    // eslint-disable-next-line no-await-in-loop
    const result = await runtime.runNow({
      from: 1_000_000,
      to: 1_020_000,
      reason: 'bad-focus',
      focus,
    });
    assert.equal(result.ok, true);
    assert.match(
      received[received.length - 1].user,
      /【本次关注点】\n无特别关注点。/,
      '非字符串 focus 必须按“无关注点”处理',
    );
    assert.equal(runtime.status().lastFocusChars, 0);
  }
});

test('status().lastFocusChars：只保留最近一次请求的长度，不含正文', async () => {
  const clock = createFakeClock();
  const runtime = makeRuntime(clock);

  assert.equal(runtime.status().lastFocusChars, 0, '尚未分析时为 0');

  const shortFocus = '看主角的手';
  assert.equal((await runtime.runNow({
    from: 1_000_000,
    to: 1_020_000,
    reason: 'short',
    focus: shortFocus,
  })).ok, true);
  assert.equal(runtime.status().lastFocusChars, shortFocus.length);
  assert.equal(JSON.stringify(runtime.status()).includes(shortFocus), false);

  assert.equal((await runtime.runNow({
    from: 1_000_000,
    to: 1_020_000,
    reason: 'long',
    focus: `  ${'注'.repeat(250)}  `,
  })).ok, true);
  assert.equal(runtime.status().lastFocusChars, 200);
  assert.equal(JSON.stringify(runtime.status()).includes('注'), false, 'status 只能带长度，不能带正文');
});

test('失败轮（bad-json）不改变既有状态/计数语义', async () => {
  const clock = createFakeClock();
  let mode = 'ok';
  const runtime = makeRuntime(clock, {
    analyze: async (input) => (mode === 'ok' ? defaultReply(input.interval) : '{坏输出'),
  });

  assert.equal((await runtime.runNow({
    from: 1_000_000,
    to: 1_020_000,
    reason: 'first',
    focus: '成功轮关注点',
  })).ok, true);
  const before = runtime.current();
  const statusBefore = runtime.status();
  const renderedBefore = runtime.render();

  mode = 'bad';
  const failed = await runtime.runNow({
    from: 1_000_000,
    to: 1_020_000,
    reason: 'second',
    focus: '失败轮关注点',
  });

  assert.equal(failed.ok, false);
  assert.equal(failed.reason, 'bad-json');
  assert.deepEqual(runtime.current(), before, '失败轮不得改写既有状态');
  assert.equal(runtime.render(), renderedBefore, '失败轮不得改写渲染块');

  const statusAfter = runtime.status();
  assert.equal(statusAfter.runs, statusBefore.runs + 1);
  assert.equal(statusAfter.failures, statusBefore.failures + 1);
  assert.equal(statusAfter.lastReason, 'bad-json');
  assert.equal(statusAfter.lastEventCount, 0, '失败轮把上一轮事件计数归零');
  assert.equal(statusAfter.droppedEvents, statusBefore.droppedEvents);
  assert.equal(statusAfter.lastFocusChars, '失败轮关注点'.length);
});

test('onAdvance：成功并入状态后调用一次，参数含 events/sceneSummary 且是副本', async () => {
  const clock = createFakeClock();
  const calls = [];
  const observed = [];
  const runtime = makeRuntime(clock, {
    onAdvance: (payload) => {
      calls.push(payload);
      // 先记录回调收到的内容，再故意改副本。
      observed.push({
        parsedScene: payload.parsed.sceneSummary,
        parsedEvent: payload.parsed.events[0].description,
        stateScene: payload.state.sceneSummary,
        stateEvent: payload.state.events[0].description,
        stateEventCount: payload.state.events.length,
        coverage: payload.state.coverage.map((span) => ({ ...span })),
        updatedAt: payload.state.updatedAt,
      });
      payload.parsed.sceneSummary = '被回调改掉';
      payload.parsed.events[0].description = '被回调改掉';
      payload.parsed.events[0].evidenceFrameIds.push('ghost');
      payload.state.sceneSummary = '被回调改掉';
      payload.state.events[0].description = '被回调改掉';
      payload.state.coverage[0].from = 0;
    },
  });

  const result = await runtime.runNow({ from: 1_000_000, to: 1_020_000, reason: 'advance' });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1, '成功并入后只回调一次');
  assert.equal(observed[0].parsedScene, '桌面上有一个打开的窗口');
  assert.equal(observed[0].parsedEvent, '窗口出现');
  assert.equal(observed[0].stateScene, '桌面上有一个打开的窗口');
  assert.equal(observed[0].stateEvent, '窗口出现');
  assert.equal(observed[0].stateEventCount, 1);
  assert.deepEqual(observed[0].coverage, [{ from: 1_010_000, to: 1_020_000 }], '帧间缺口不虚报为覆盖');
  assert.equal(observed[0].updatedAt, 1_000_000);

  assert.equal(runtime.current().sceneSummary, '桌面上有一个打开的窗口');
  assert.equal(runtime.current().events[0].description, '窗口出现');
  assert.deepEqual(runtime.current().events[0].evidenceFrameIds, ['frame-a']);
  assert.deepEqual(runtime.current().coverage, [{ from: 1_010_000, to: 1_020_000 }]);
  assert.equal(result.parsed.sceneSummary, '桌面上有一个打开的窗口');
});

test('onAdvance 抛错：只记一条 emit 诊断，runNow 仍成功且状态已写回', async () => {
  const clock = createFakeClock();
  const emitted = [];
  const runtime = makeRuntime(clock, {
    emit: (event) => emitted.push(event),
    onAdvance: () => {
      throw new Error('boom C:\\secret\\frame-a.png');
    },
  });

  const result = await runtime.runNow({ from: 1_000_000, to: 1_020_000, reason: 'callback-fail' });

  assert.equal(result.ok, true, '回调抛错不能改变运行结果');
  assert.equal(result.parsed.events.length, 1);
  assert.equal(runtime.current().sceneSummary, '桌面上有一个打开的窗口');
  assert.equal(runtime.status().failures, 0, '回调失败不计入运行时失败');
  assert.equal(runtime.status().lastReason, 'ok');

  const callbackEvent = emitted.find((event) => event.reason === 'callback-error');
  assert.ok(callbackEvent, '回调失败必须留下 emit 诊断');
  assert.equal(callbackEvent.type, 'understanding-advance-callback-error');
  assert.equal(callbackEvent.ok, false);
  const emittedText = JSON.stringify(emitted);
  assert.equal(emittedText.includes('boom'), false);
  assert.equal(emittedText.includes('C:\\'), false);
  assert.equal(emittedText.includes('frame-a'), false);
});

test('clear 后到达的结果：不写回状态，也不回调 onAdvance', async () => {
  const clock = createFakeClock();
  let started = false;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const calls = [];
  const runtime = makeRuntime(clock, {
    analyze: async (input) => {
      started = true;
      await gate;
      return defaultReply(input.interval);
    },
    onAdvance: (payload) => calls.push(payload),
  });

  const first = runtime.runNow({ from: 1_000_000, to: 1_020_000, reason: 'stale' });
  await waitFor(() => started);
  runtime.clear('privacy');
  release();

  const outcome = await first;
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, 'stale');
  assert.equal(calls.length, 0, '代次失效的在途结果不得回调');
  assert.equal(runtime.current(), null);
});

test('分析器返回坏 JSON：ok:false、failures 计数、状态保持为空', async () => {
  const clock = createFakeClock();
  const runtime = makeRuntime(clock, {
    analyze: async () => '这不是 JSON',
  });

  const result = await runtime.runNow({ from: 1_000_000, to: 1_020_000, reason: 'bad-json' });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'bad-json');
  assert.equal(runtime.current(), null);
  assert.equal(runtime.render(), '');
  assert.equal(runtime.status().runs, 1);
  assert.equal(runtime.status().failures, 1);
  assert.equal(runtime.status().lastReason, 'bad-json');
});

test('坏 JSON 不清空既有状态：失败只增加计数，上一段结果仍可读', async () => {
  const clock = createFakeClock();
  let mode = 'ok';
  const runtime = makeRuntime(clock, {
    analyze: async (input) => (mode === 'ok' ? defaultReply(input.interval) : '{坏输出'),
  });

  assert.equal((await runtime.runNow({ from: 1_000_000, to: 1_020_000 })).ok, true);
  const before = runtime.current();
  assert.equal(before.sceneSummary, '桌面上有一个打开的窗口');

  mode = 'bad';
  const failed = await runtime.runNow({ from: 1_000_000, to: 1_020_000, reason: 'second' });
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, 'bad-json');
  assert.equal(runtime.status().failures, 1);
  assert.equal(runtime.status().runs, 2);

  const after = runtime.current();
  assert.equal(after.sceneSummary, before.sceneSummary);
  assert.equal(after.events.length, before.events.length);
  assert.equal(after.updatedAt, before.updatedAt);
});

test('事件引用不存在的帧 id：整条丢弃并累计 droppedEvents，合法事件保留', async () => {
  const clock = createFakeClock();
  const runtime = makeRuntime(clock, {
    analyze: async (input) => JSON.stringify({
      sceneSummary: '一个窗口',
      events: [
        {
          from: input.interval.from,
          to: input.interval.from + 1_000,
          description: '编造证据的事件',
          evidenceFrameIds: ['ghost-frame'],
          evidenceAudioIds: [],
          uncertainty: '',
        },
        {
          from: input.interval.from + 1_000,
          to: input.interval.from + 2_000,
          description: '真实证据的事件',
          evidenceFrameIds: ['frame-a'],
          evidenceAudioIds: [],
          uncertainty: '推断：可能是通知',
        },
      ],
      unresolved: '',
    }),
  });

  const result = await runtime.runNow({ from: 1_000_000, to: 1_020_000, reason: 'drop' });

  assert.equal(result.ok, true);
  assert.equal(result.parsed.droppedEvents, 1);
  assert.deepEqual(result.parsed.unknownEvidenceIds, ['ghost-frame']);
  assert.equal(runtime.current().events.length, 1);
  assert.equal(runtime.current().events[0].description, '真实证据的事件');
  assert.equal(runtime.status().droppedEvents, 1);
});

test('窗口内没有帧：no-frames，不调用 analyze，也不进入失败计数', async () => {
  const clock = createFakeClock();
  let analyzeCalls = 0;
  let audioCalls = 0;
  const runtime = makeRuntime(clock, {
    framesBetween: () => [],
    audioBetween: () => {
      audioCalls += 1;
      return AUDIO_LINES.slice();
    },
    analyze: async () => {
      analyzeCalls += 1;
      return '{}';
    },
  });

  const result = await runtime.runNow({ from: 1_000_000, to: 1_020_000, reason: 'empty' });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no-frames');
  assert.equal(analyzeCalls, 0);
  assert.equal(audioCalls, 0);
  assert.equal(runtime.current(), null);
  assert.equal(runtime.status().runs, 0);
  assert.equal(runtime.status().failures, 0);
  assert.equal(runtime.status().lastReason, 'no-frames');
});

test('isBlocked 为真（或检查抛错）时直接 blocked，不取帧也不调用 analyze', async () => {
  const clock = createFakeClock();
  let framesCalls = 0;
  let analyzeCalls = 0;
  const runtime = makeRuntime(clock, {
    isBlocked: () => true,
    framesBetween: () => {
      framesCalls += 1;
      return FRAMES.slice();
    },
    analyze: async () => {
      analyzeCalls += 1;
      return defaultReply({ from: 1_000_000, to: 1_020_000 });
    },
  });

  const blocked = await runtime.runNow({ from: 1_000_000, to: 1_020_000 });
  assert.deepEqual(blocked, { ok: false, reason: 'blocked' });
  assert.equal(framesCalls, 0);
  assert.equal(analyzeCalls, 0);
  assert.equal(runtime.status().lastReason, 'blocked');

  // 隐私检查本身抛错按“被挡住”处理，同样不能把异常抛给调用方。
  const failingCheck = makeRuntime(clock, {
    isBlocked: () => {
      throw new Error('privacy check failed');
    },
    analyze: async () => {
      analyzeCalls += 1;
      return '{}';
    },
  });
  const safe = await failingCheck.runNow({ from: 1_000_000, to: 1_020_000 });
  assert.deepEqual(safe, { ok: false, reason: 'blocked' });
  assert.equal(analyzeCalls, 0);
});

test('单在途：连续 runNow 只调用一次 analyze，第二次返回 in-flight', async () => {
  const clock = createFakeClock();
  let analyzeCalls = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const runtime = makeRuntime(clock, {
    analyze: async (input) => {
      analyzeCalls += 1;
      await gate;
      return defaultReply(input.interval);
    },
  });

  const first = runtime.runNow({ from: 1_000_000, to: 1_020_000, reason: 'first' });
  const second = await runtime.runNow({ from: 1_000_000, to: 1_020_000, reason: 'second' });

  assert.deepEqual(second, { ok: false, reason: 'in-flight' });
  await waitFor(() => analyzeCalls === 1);
  assert.equal(analyzeCalls, 1);

  release();
  const result = await first;
  assert.equal(result.ok, true);
  assert.equal(analyzeCalls, 1);
  assert.equal(runtime.status().running, false);
});

test('clear：render 变空、清调度器队列，旧在途结果不回写状态', async () => {
  const clock = createFakeClock();
  let analyzeCalls = 0;
  let started = false;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const runtime = makeRuntime(clock, {
    analyze: async (input) => {
      analyzeCalls += 1;
      started = true;
      await gate;
      return defaultReply(input.interval);
    },
  });

  // 先登记一次调度（排了定时器），再手动起一次分析；clear 必须把两者都停止/清空。
  runtime.noteChange({ from: 1_000_000, to: 1_020_000, reason: 'change' });
  const first = runtime.runNow({ from: 1_000_000, to: 1_020_000, reason: 'manual' });
  await waitFor(() => started);
  assert.equal(analyzeCalls, 1);

  runtime.clear('privacy');
  assert.equal(runtime.current(), null);
  assert.equal(runtime.render(), '');
  assert.equal(runtime.status().hasState, false);
  assert.equal(runtime.status().pending, 0);

  clock.advance(30_000);
  assert.equal(analyzeCalls, 1, 'clear 后旧调度器不应再触发分析');

  release();
  const stale = await first;
  assert.equal(stale.ok, false);
  assert.equal(stale.reason, 'stale');
  assert.equal(runtime.current(), null);
  assert.equal(runtime.render(), '');

  // clear 只清当前一轮，运行时仍可继续使用：新分析写回新状态。
  const resumed = await runtime.runNow({ from: 1_005_000, to: 1_020_000, reason: 'after-clear' });
  assert.equal(resumed.ok, true);
  assert.equal(runtime.current().sceneSummary, '桌面上有一个打开的窗口');
  assert.notEqual(runtime.render(), '');
});

test('状态过期：超过 maxAgeMs 后 current/render 清空，边界值仍保留', async () => {
  const clock = createFakeClock();
  const runtime = makeRuntime(clock, { maxAgeMs: 5_000 });

  const result = await runtime.runNow({ from: 1_000_000, to: 1_020_000 });
  assert.equal(result.ok, true);
  assert.ok(runtime.current());

  clock.advance(5_000);
  assert.ok(runtime.current(), '恰好等于 maxAgeMs 时不应过期');
  assert.notEqual(runtime.render(), '');

  clock.advance(1);
  assert.equal(runtime.current(), null);
  assert.equal(runtime.render(), '');
  assert.equal(runtime.status().hasState, false);
});

test('render：有界、不含路径/帧 id，含 uncertainty、unresolved 与覆盖提示', async () => {
  const clock = createFakeClock();
  const runtime = makeRuntime(clock, {
    maxChars: 260,
    maxEventsShown: 2,
    analyze: async (input) => JSON.stringify({
      sceneSummary: '桌面上有一个窗口',
      events: [
        {
          from: input.interval.from,
          to: input.interval.from + 1_000,
          description: '窗口出现',
          evidenceFrameIds: ['frame-a'],
          evidenceAudioIds: [],
          uncertainty: '推断：可能是设置窗口',
        },
        {
          from: input.interval.from + 1_000,
          to: input.interval.from + 2_000,
          description: '鼠标移向按钮',
          evidenceFrameIds: ['frame-b'],
          evidenceAudioIds: [],
          uncertainty: '',
        },
      ],
      unresolved: '看不清任务栏图标',
    }),
  });

  const result = await runtime.runNow({ from: 1_000_000, to: 1_020_000 });
  assert.equal(result.ok, true);

  const rendered = runtime.render();
  assert.ok(rendered.length > 0);
  assert.ok(rendered.length <= 260, `render 超长：${rendered.length}`);
  assert.ok(rendered.includes('推断：可能是设置窗口'));
  assert.ok(rendered.includes('看不清任务栏图标'));
  assert.ok(rendered.includes('覆盖'));
  assert.ok(!rendered.includes('C:\\'));
  assert.ok(!rendered.includes('frame-a'));
  assert.ok(!rendered.includes('frame-b'));
  assert.ok(!rendered.includes('audio-a'));
});

test('render：超长内容严格截断到 maxChars，且仍不含路径/帧 id', async () => {
  const clock = createFakeClock();
  const longText = '很长的场景描述'.repeat(100);
  const runtime = makeRuntime(clock, {
    maxChars: 120,
    analyze: async (input) => JSON.stringify({
      sceneSummary: longText,
      events: [
        {
          from: input.interval.from,
          to: input.interval.from + 1_000,
          description: '事件描述'.repeat(60),
          evidenceFrameIds: ['frame-a'],
          evidenceAudioIds: [],
          uncertainty: '不确定'.repeat(30),
        },
      ],
      unresolved: '未解决内容'.repeat(60),
    }),
  });

  const result = await runtime.runNow({ from: 1_000_000, to: 1_020_000 });
  assert.equal(result.ok, true);

  const rendered = runtime.render();
  assert.ok(rendered.length <= 120, `render 超长：${rendered.length}`);
  assert.ok(rendered.endsWith('…'));
  assert.ok(!rendered.includes('C:\\'));
  assert.ok(!rendered.includes('frame-a'));
});

test('覆盖缺口提示：两段不相接的覆盖区间会渲染缺口时间', async () => {
  const clock = createFakeClock();
  const runtime = makeRuntime(clock, {
    framesBetween: (from, to) => FRAMES.filter((entry) => entry.capturedAt >= from && entry.capturedAt <= to),
    analyze: async (input) => defaultReply({ from: input.interval.from, to: input.interval.to }),
  });

  // 第一段覆盖到 1_002_000，第二段从 1_010_000 开始；中间是真实缺口。
  assert.equal((await runtime.runNow({ from: 1_000_000, to: 1_002_000 })).ok, true);
  assert.equal((await runtime.runNow({ from: 1_010_000, to: 1_012_000 })).ok, true);

  const rendered = runtime.render();
  assert.ok(rendered.includes('【覆盖缺口】'));
  assert.ok(rendered.includes('–'));
});

test('stop：noteChange/runNow 不再触发 analyze', async () => {
  const clock = createFakeClock();
  let analyzeCalls = 0;
  const runtime = makeRuntime(clock, {
    analyze: async (input) => {
      analyzeCalls += 1;
      return defaultReply(input.interval);
    },
  });

  const first = await runtime.runNow({ from: 1_000_000, to: 1_020_000 });
  assert.equal(first.ok, true);
  assert.equal(analyzeCalls, 1);

  runtime.stop();
  assert.equal(runtime.status().stopped, true);

  const afterStop = await runtime.runNow({ from: 1_000_000, to: 1_020_000 });
  assert.deepEqual(afterStop, { ok: false, reason: 'stopped' });

  runtime.noteChange({ from: 1_000_000, to: 1_020_000, reason: 'after-stop', priority: true });
  clock.advance(120_000);
  assert.equal(analyzeCalls, 1);
});

test('stop：已在途的分析完成后不写回状态', async () => {
  const clock = createFakeClock();
  let started = false;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const runtime = makeRuntime(clock, {
    analyze: async (input) => {
      started = true;
      await gate;
      return defaultReply(input.interval);
    },
  });

  const first = runtime.runNow({ from: 1_000_000, to: 1_020_000 });
  await waitFor(() => started);
  runtime.stop();
  release();

  const outcome = await first;
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, 'stopped');
  assert.equal(runtime.current(), null);
  assert.equal(runtime.render(), '');
});

test('noteChange 委托内部调度器：假时钟推进后分析一次，原因保留', async () => {
  const clock = createFakeClock();
  const reasons = [];
  const runtime = makeRuntime(clock, {
    analyze: async (input) => {
      reasons.push(input.interval);
      return defaultReply(input.interval);
    },
  });

  const noted = runtime.noteChange({
    from: 1_000_000,
    to: 1_020_000,
    reason: 'change',
    priority: true,
  });
  assert.equal(noted.pending, 1);
  assert.equal(runtime.scheduler.status().pending, 1);

  clock.advance(0);
  const flushed = await runtime.scheduler.flush();
  assert.ok(flushed === null || flushed.ok === true);

  assert.equal(reasons.length, 1);
  assert.equal(runtime.status().runs, 1);
  assert.equal(runtime.status().lastWindowReason, 'change');
  assert.equal(runtime.current().sceneSummary, '桌面上有一个打开的窗口');
});

test('analyze 抛错：不向调用方抛出，记为 analyze-error 且不泄漏错误正文', async () => {
  const clock = createFakeClock();
  const runtime = makeRuntime(clock, {
    analyze: async () => {
      throw new Error('boom C:\\secret\\frame-a.png');
    },
  });

  const result = await runtime.runNow({ from: 1_000_000, to: 1_020_000 });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'analyze-error');
  assert.equal(result.droppedEvents, 0);
  assert.equal(runtime.status().failures, 1);
  assert.equal(runtime.current(), null);

  const statusText = JSON.stringify(runtime.status());
  assert.ok(!statusText.includes('boom'));
  assert.ok(!statusText.includes('C:\\'));
  assert.ok(!statusText.includes('frame-a'));
});

test('maxFrames：超预算时均匀取样，保留首尾帧且每帧带 file', async () => {
  const clock = createFakeClock();
  const manyFrames = Array.from({ length: 6 }, (_, index) => (
    frame(`sample-${index}`, 1_000_000 + index * 1_000)
  ));
  let received = null;
  const runtime = makeRuntime(clock, {
    maxFrames: 3,
    framesBetween: () => manyFrames.slice(),
    analyze: async (input) => {
      received = input;
      return defaultReply(input.interval);
    },
  });

  const result = await runtime.runNow({ from: 1_000_000, to: 1_010_000 });
  assert.equal(result.ok, true);
  assert.equal(received.frames.length, 3);
  assert.equal(received.frames[0].id, 'sample-0');
  assert.equal(received.frames[received.frames.length - 1].id, 'sample-5');
  assert.ok(received.frames.every((entry) => typeof entry.file === 'string'));
});

test('默认预算常量保持不变', () => {
  assert.deepEqual(UNDERSTANDING_RUNTIME_DEFAULTS, {
    maxFrames: 3,
    maxChars: 900,
    maxEventsShown: 3,
    maxAgeMs: 300_000,
  });
  assert.ok(Object.isFrozen(UNDERSTANDING_RUNTIME_DEFAULTS));
});
