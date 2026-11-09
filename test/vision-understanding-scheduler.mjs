/**
 * P-187 阶段 3：连续视听理解的后台分析节奏调度（纯模块）。
 *
 * 全部时间都由假时钟/假定时器驱动，不等待真实时间。覆盖：单在途、minInterval、priority 插队
 * 与保留、maxPending 丢弃最旧非优先窗口、重叠窗口合并、run 抛错后继续、stop 后不再触发、
 * status 只含计数/时间/原因。
 *
 * Run: node --test test/vision-understanding-scheduler.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SCHEDULER_DEFAULTS,
  createUnderstandingScheduler,
} from '../src/host/vision/understanding-scheduler.js';

/** 可手动推进的假时钟；setTimer/clearTimer 与 scheduler 的注入接口一一对应。 */
function createFakeClock(start = 0) {
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

function makeScheduler(clock, over = {}) {
  return createUnderstandingScheduler({
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    ...over,
  });
}

test('单在途：运行中重叠 note 只合并，不并发启动；flush 返回同一个在途 promise', async () => {
  const clock = createFakeClock();
  const calls = [];
  let release;
  const scheduler = makeScheduler(clock, {
    run(window) {
      calls.push(window);
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });

  const noted = scheduler.note({ reason: 'first', from: 1_000, to: 2_000 });
  assert.equal(noted.pending, 1);
  const first = scheduler.flush();
  assert.equal(scheduler.status().running, true);
  assert.equal(scheduler.status().runs, 1);

  // 与在途窗口重叠：只合并，不再排队。
  scheduler.note({ reason: 'second', from: 1_200, to: 1_800 });
  assert.equal(scheduler.status().pending, 0);
  assert.equal(scheduler.status().merged, 1);
  assert.equal(scheduler.flush(), first, '运行中 flush 不应启动第二个 run');

  release({ ok: true });
  assert.deepEqual(await first, { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(scheduler.status().runs, 1);
  assert.equal(scheduler.status().running, false);
  assert.equal(scheduler.status().pending, 0);
  assert.equal(clock.pendingTimers(), 0);
});

test('minInterval：冷却期内 flush 不启动，假定时器到点后才跑下一次', async () => {
  const clock = createFakeClock();
  const seen = [];
  const scheduler = makeScheduler(clock, {
    minIntervalMs: 3_000,
    run: async (window) => {
      seen.push(window.reason);
      return window.reason;
    },
  });

  scheduler.note({ reason: 'a', from: 1_000, to: 2_000 });
  assert.equal(await scheduler.flush(), 'a');
  assert.equal(scheduler.status().lastAt, 0);

  scheduler.note({ reason: 'b', from: 3_000, to: 4_000 });
  assert.equal(await scheduler.flush(), null, '冷却期内手动 flush 禁止启动');
  assert.equal(scheduler.status().runs, 1);
  assert.equal(scheduler.status().pending, 1);
  assert.ok(clock.pendingTimers() >= 1, '冷却期必须安排一个定时器而不是忙等');

  clock.advance(2_999);
  assert.equal(scheduler.status().runs, 1, '未到 3000ms 不触发');
  clock.advance(1);
  assert.equal(scheduler.status().runs, 2, '到点后定时器启动下一次');
  assert.equal(await scheduler.flush(), 'b');
  assert.deepEqual(seen, ['a', 'b']);
  assert.equal(scheduler.status().lastAt, 3_000);
});

test('priority：优先窗口占用下一个执行槽，但不突破 minInterval', async () => {
  const clock = createFakeClock();
  const seen = [];
  const scheduler = makeScheduler(clock, {
    run: async (window) => {
      seen.push(window.reason);
      return window.reason;
    },
  });

  scheduler.note({ reason: 'base', from: 0, to: 100 });
  assert.equal(await scheduler.flush(), 'base');

  // 普通窗口先到，优先窗口后到；两者不重叠，不应合并。
  scheduler.note({ reason: 'normal', from: 2_000, to: 2_100 });
  scheduler.note({ reason: 'priority', from: 3_000, to: 3_100, priority: true });
  assert.equal(scheduler.status().pending, 2);
  assert.equal(scheduler.status().merged, 0);

  clock.advance(3_000);
  assert.equal(scheduler.status().runs, 2, '仍是 minInterval 之后才启动');
  assert.equal(await scheduler.flush(), 'priority');
  assert.deepEqual(seen, ['base', 'priority'], '优先窗口先于更早排队的普通窗口');
  assert.equal(scheduler.status().pending, 1);

  clock.advance(3_000);
  assert.equal(await scheduler.flush(), 'normal');
  assert.deepEqual(seen, ['base', 'priority', 'normal']);
});

test('maxPending：超限丢弃最旧的非优先窗口并计数，优先窗口保留', async () => {
  const clock = createFakeClock();
  const seen = [];
  const scheduler = makeScheduler(clock, {
    maxPending: 2,
    run: async (window) => {
      seen.push(window.reason);
      return window.reason;
    },
  });

  scheduler.note({ reason: 'a', from: 1_000, to: 1_100 });
  scheduler.note({ reason: 'b', from: 2_000, to: 2_100 });
  const noted = scheduler.note({ reason: 'p', from: 3_000, to: 3_100, priority: true });
  assert.equal(noted.pending, 2);
  assert.equal(noted.dropped, 1, '最旧的普通窗口 a 被丢弃');

  assert.equal(await scheduler.flush(), 'p', '优先窗口先执行');
  clock.advance(3_000);
  assert.equal(await scheduler.flush(), 'b');
  assert.deepEqual(seen, ['p', 'b']);
  assert.equal(scheduler.status().dropped, 1);
});

test('重叠窗口合并：并集、merged 计数与最后一次原因', async () => {
  const clock = createFakeClock();
  const calls = [];
  const scheduler = makeScheduler(clock, {
    run: async (window) => {
      calls.push(window);
      return window.reason;
    },
  });

  scheduler.note({ reason: 'one', from: 1_000, to: 2_000 });
  const noted = scheduler.note({ reason: 'two', from: 1_500, to: 2_500 });
  assert.equal(noted.pending, 1);
  assert.equal(noted.merged, 1);
  assert.equal(await scheduler.flush(), 'two');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    from: 1_000,
    to: 2_500,
    reason: 'two',
    priority: false,
  });
});

test('run 同步抛错或异步拒绝：计入 failures，不阻塞后续 run', async () => {
  const clock = createFakeClock();
  let attempts = 0;
  const scheduler = makeScheduler(clock, {
    run(window) {
      attempts += 1;
      if (attempts === 1) throw new Error('sync boom');
      if (attempts === 2) return Promise.reject(new Error('async boom'));
      return Promise.resolve(window.reason);
    },
  });

  scheduler.note({ reason: 'a', from: 1, to: 2 });
  assert.equal(await scheduler.flush(), null, '同步抛错被收敛成 null');
  assert.equal(scheduler.status().failures, 1);
  assert.equal(scheduler.status().running, false);

  scheduler.note({ reason: 'b', from: 3, to: 4 });
  clock.advance(3_000);
  assert.equal(await scheduler.flush(), null, '异步拒绝同样被收敛成 null');
  assert.equal(scheduler.status().failures, 2);
  assert.equal(scheduler.status().running, false);

  scheduler.note({ reason: 'c', from: 5, to: 6 });
  clock.advance(3_000);
  assert.equal(await scheduler.flush(), 'c');
  assert.equal(scheduler.status().runs, 3);
  assert.equal(scheduler.status().failures, 2);
});

test('stop：清定时器/队列，在途 run 不被强杀，结果不再触发新 run', async () => {
  const clock = createFakeClock();
  let release;
  let calls = 0;
  const scheduler = makeScheduler(clock, {
    run() {
      calls += 1;
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });

  scheduler.note({ reason: 'a', from: 1, to: 2 });
  const first = scheduler.flush();
  scheduler.note({ reason: 'queued', from: 3, to: 4 });
  assert.equal(scheduler.status().pending, 1);

  scheduler.stop();
  assert.equal(scheduler.status().pending, 0, 'stop 清空等待队列');
  assert.equal(clock.pendingTimers(), 0);

  release('done');
  assert.equal(await first, 'done');
  assert.equal(calls, 1, '在途 run 自然结束，不被强杀');
  assert.equal(scheduler.status().running, false);
  assert.equal(scheduler.status().runs, 1);

  scheduler.note({ reason: 'after', from: 5, to: 6 });
  clock.advance(10_000);
  assert.equal(scheduler.status().runs, 1, 'stop 后不再触发');
  assert.equal(await scheduler.flush(), null);
});

test('stop 清掉空闲时已安排的定时器，假时钟推进也不会再跑', async () => {
  const clock = createFakeClock();
  let runs = 0;
  const scheduler = makeScheduler(clock, {
    run: async () => {
      runs += 1;
      return 'ok';
    },
  });

  scheduler.note({ reason: 'pending', from: 1, to: 2 });
  assert.ok(clock.pendingTimers() >= 1);
  scheduler.stop();
  assert.equal(clock.pendingTimers(), 0);
  clock.advance(10_000);
  assert.equal(runs, 0);
  assert.equal(await scheduler.flush(), null);
});

test('默认队列上限：10 个不重叠窗口只保留 8 个，丢弃最旧并计数', () => {
  const clock = createFakeClock();
  const scheduler = makeScheduler(clock, { run: async () => 'ok' });

  for (let index = 0; index < 10; index += 1) {
    scheduler.note({
      reason: `n${index}`,
      from: (index + 1) * 1_000,
      to: (index + 1) * 1_000 + 10,
    });
  }
  const status = scheduler.status();
  assert.equal(status.pending, SCHEDULER_DEFAULTS.maxPending);
  assert.equal(status.dropped, 2);
  assert.equal(status.merged, 0);
  assert.equal(status.runs, 0);
});

test('priorityHoldMs：超过保护期后，优先窗口按普通窗口参与淘汰', () => {
  const clock = createFakeClock();
  // 定时器不实际触发，专注验证队列淘汰策略。
  const scheduler = makeScheduler(clock, {
    setTimer: () => null,
    clearTimer: () => {},
    maxPending: 1,
    run: async () => 'ok',
  });

  scheduler.note({ reason: 'old-priority', from: 1, to: 2, priority: true });
  clock.advance(SCHEDULER_DEFAULTS.priorityHoldMs + 1);
  const noted = scheduler.note({ reason: 'new-normal', from: 3, to: 4 });
  assert.equal(noted.pending, 1);
  assert.equal(noted.dropped, 1);
});

test('status：只暴露计数/时间/原因；默认常量冻结且数值正确；缺 run 立即报错', async () => {
  assert.deepEqual(SCHEDULER_DEFAULTS, {
    minIntervalMs: 3_000,
    maxPending: 8,
    priorityHoldMs: 15_000,
  });
  assert.ok(Object.isFrozen(SCHEDULER_DEFAULTS));
  assert.throws(() => createUnderstandingScheduler({}), TypeError);

  const clock = createFakeClock();
  const scheduler = makeScheduler(clock, { run: async (window) => window.reason });
  assert.deepEqual(scheduler.status(), {
    running: false,
    pending: 0,
    lastAt: null,
    lastReason: '',
    runs: 0,
    failures: 0,
    dropped: 0,
    merged: 0,
  });

  scheduler.note({ reason: 'why', from: 1, to: 2 });
  const pending = scheduler.status();
  assert.equal(pending.pending, 1);
  assert.equal(pending.lastAt, null, '还没 run，lastAt 仍为空');
  assert.equal(pending.lastReason, '');

  assert.equal(await scheduler.flush(), 'why');
  const after = scheduler.status();
  assert.deepEqual(Object.keys(after).sort(), [
    'dropped',
    'failures',
    'lastAt',
    'lastReason',
    'merged',
    'pending',
    'running',
    'runs',
  ]);
  assert.equal(after.running, false);
  assert.equal(after.pending, 0);
  assert.equal(after.lastAt, 0);
  assert.equal(after.lastReason, 'why');
  assert.equal(after.runs, 1);
  assert.equal(after.failures, 0);
  assert.equal(after.dropped, 0);
  assert.equal(after.merged, 0);
});
