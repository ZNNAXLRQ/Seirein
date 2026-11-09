/**
 * 持续证据采集模块的单测：所有定时器/会话/时钟都可控，不需要 ffmpeg、屏幕或真实等待。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  EVIDENCE_CAPTURE_DEFAULTS,
  createEvidenceCapture,
} from '../src/host/vision/evidence-capture.js';

/** 让模块内部的 await 链推进若干微任务，不消耗真实时间。 */
async function flush() {
  for (let i = 0; i < 16; i += 1) await Promise.resolve();
}

/** 手动定时器：`fireNext()` 只触发当前最早的一个，并推进微任务。 */
function createManualTimers() {
  let seq = 0;
  const pending = new Map();
  const cleared = [];
  const setTimer = (fn, ms) => {
    const handle = {
      id: ++seq,
      ms,
      fn,
      unref() { /* 测试里不关心 unref */ },
    };
    pending.set(handle.id, handle);
    return handle;
  };
  const clearTimer = (handle) => {
    if (handle === null || handle === undefined) return;
    cleared.push(handle);
    pending.delete(handle.id);
  };
  const only = () => {
    assert.equal(pending.size, 1, `expected exactly one pending timer, got ${pending.size}`);
    return pending.values().next().value;
  };
  const fireNext = async () => {
    const handle = only();
    pending.delete(handle.id);
    handle.fn();
    await flush();
  };
  return { setTimer, clearTimer, pending, cleared, only, fireNext };
}

let sheetSeq = 0;
function makeSheet(label = '') {
  sheetSeq += 1;
  return {
    file: `C:\\cache\\evidence\\${label}${sheetSeq}.png`,
    bytes: 128,
    width: 4,
    height: 4,
    capturedAt: 1000 + sheetSeq,
    source: 'desktop',
  };
}

/**
 * 假采集会话。`results` 每项可以是 sheet、Error、返回 sheet/Promise 的函数；
 * 用尽之后 `take` 返回 null（模拟没有变化）。
 */
function makeSession(results = [], { sourceKind = 'screen', engine = 'fake-engine', done = Promise.resolve() } = {}) {
  const calls = [];
  let index = 0;
  let stopped = false;
  return {
    engine,
    sourceKind,
    done,
    calls,
    get stopped() { return stopped; },
    async take(options) {
      calls.push(options);
      if (stopped) throw new Error('session stopped');
      const item = index < results.length ? results[index] : null;
      index += 1;
      if (typeof item === 'function') return item();
      if (item instanceof Error) throw item;
      return item ?? null;
    },
    stop() { stopped = true; },
  };
}

function makeCapture({ session, starts, timers, events, onSheet, isBlocked = () => false, now = () => 5000 }) {
  return createEvidenceCapture({
    start: async ({ source } = {}) => {
      starts.push(source);
      return session;
    },
    onSheet: onSheet ?? (async () => {}),
    isBlocked,
    now,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    tickMs: 10,
    idleTickMs: 100,
    maxIdleTicks: 2,
    emit: (type, payload) => events.push({ type, payload }),
  });
}

test('start 幂等；有变化登记、null 不登记', async () => {
  const timers = createManualTimers();
  const events = [];
  const registered = [];
  const starts = [];
  const changed = makeSheet('a');
  const session = makeSession([changed, null]);
  const capture = makeCapture({
    session,
    starts,
    timers,
    events,
    onSheet: async (sheet) => { registered.push(sheet); },
  });

  const first = await capture.start({ source: 'screen' });
  const second = await capture.start({ source: 'screen' });
  assert.equal(starts.length, 1, '已在运行时不得重复开会话');
  assert.equal(first.running, true);
  assert.equal(second.running, true);
  assert.deepEqual(second, first);
  assert.equal(timers.only().ms, 10, '首个 tick 使用 tickMs');

  await timers.fireNext();
  assert.deepEqual(registered, [changed]);
  assert.equal(capture.status().ticks, 1);
  assert.equal(capture.status().sheets, 1);

  await timers.fireNext();
  assert.equal(registered.length, 1, 'null（无变化）不进 onSheet');
  assert.equal(capture.status().idleTicks, 1);
  assert.equal(capture.status().sheets, 1);

  const stopped = await capture.stop('test');
  await capture.done;
  assert.equal(stopped.running, false);
  assert.equal(capture.status().running, false);
  assert.equal(timers.pending.size, 0, 'stop 后不得留下定时器');
});

test('连续 idle 后切到 idleTickMs，有变化立即恢复 tickMs', async () => {
  const timers = createManualTimers();
  const events = [];
  const registered = [];
  const changed = makeSheet('b');
  const session = makeSession([null, null, null, changed, null]);
  const capture = makeCapture({
    session,
    starts: [],
    timers,
    events,
    onSheet: async (sheet) => { registered.push(sheet); },
  });

  await capture.start({ source: 'screen' });
  assert.equal(timers.only().ms, 10);

  await timers.fireNext(); // idle 1
  assert.equal(capture.status().idleTicks, 1);
  assert.equal(timers.only().ms, 10);
  await timers.fireNext(); // idle 2
  assert.equal(capture.status().idleTicks, 2);
  assert.equal(timers.only().ms, 10, '未超过 maxIdleTicks 时仍用 tickMs');
  await timers.fireNext(); // idle 3 > maxIdleTicks
  assert.equal(capture.status().idleTicks, 3);
  assert.equal(timers.only().ms, 100, '连续无变化后降到 idleTickMs');

  await timers.fireNext(); // 有变化
  assert.deepEqual(registered, [changed]);
  assert.equal(capture.status().idleTicks, 0);
  assert.equal(timers.only().ms, 10, '一有变化立即恢复 tickMs');

  await timers.fireNext(); // 再次 idle 1
  assert.equal(capture.status().idleTicks, 1);
  assert.equal(timers.only().ms, 10);
  await capture.stop('test');
});

test('isBlocked 为真时不取帧；恢复后照常取', async () => {
  const timers = createManualTimers();
  const events = [];
  const starts = [];
  let blocked = true;
  const changed = makeSheet('c');
  const session = makeSession([changed]);
  const capture = makeCapture({
    session,
    starts,
    timers,
    events,
    isBlocked: () => blocked,
  });

  await capture.start({ source: 'screen' });
  await timers.fireNext();
  assert.equal(session.calls.length, 0, '被挡住时不得调用 take');
  assert.equal(capture.status().ticks, 1);
  assert.equal(timers.only().ms, 10, '被挡住也要继续调度下一次');

  blocked = false;
  await timers.fireNext();
  assert.equal(session.calls.length, 1);
  assert.equal(session.calls[0].force, false, '持续采集永远不强制 flush');
  assert.equal(capture.status().sheets, 1);
  await capture.stop('test');
});

test('stop 之后旧 session 迟到的 sheet 不登记', async () => {
  const timers = createManualTimers();
  const events = [];
  const registered = [];
  const late = makeSheet('late');
  let resolveTake;
  const session = makeSession([() => new Promise((resolve) => { resolveTake = resolve; })]);
  const capture = makeCapture({
    session,
    starts: [],
    timers,
    events,
    onSheet: async (sheet) => { registered.push(sheet); },
  });

  await capture.start({ source: 'screen' });
  await timers.fireNext(); // take 挂起，尚未返回
  assert.equal(session.calls.length, 1);

  const stopping = capture.stop('test');
  await flush();
  resolveTake(late);
  const stopped = await stopping;

  assert.equal(stopped.running, false);
  assert.equal(registered.length, 0, 'stop 之后迟到的 sheet 必须丢弃');
  assert.ok(
    events.some((entry) => entry.type === 'vision.evidence.capture.stale'),
    '迟到结果应记 stale',
  );
  assert.equal(session.stopped, true);
  await capture.done;
});

test('restart 后旧 session 迟到 sheet 不登记，新 session 正常登记', async () => {
  const timers = createManualTimers();
  const events = [];
  const registered = [];
  const late = makeSheet('old');
  const fresh = makeSheet('new');
  let resolveOld;
  const oldSession = makeSession([() => new Promise((resolve) => { resolveOld = resolve; })]);
  const newSession = makeSession([fresh], { sourceKind: 'obs', engine: 'new-engine' });
  const starts = [];
  let calls = 0;
  const capture = createEvidenceCapture({
    start: async ({ source } = {}) => {
      starts.push(source);
      calls += 1;
      return calls === 1 ? oldSession : newSession;
    },
    onSheet: async (sheet) => { registered.push(sheet); },
    isBlocked: () => false,
    now: () => 5000,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    tickMs: 10,
    idleTickMs: 100,
    maxIdleTicks: 2,
    emit: (type, payload) => events.push({ type, payload }),
  });

  await capture.start({ source: 'screen' });
  await timers.fireNext(); // 旧 session 的 take 挂起

  const restarting = capture.restart({ source: 'obs' });
  await flush();
  resolveOld(late);
  const restarted = await restarting;
  assert.equal(restarted.running, true);
  assert.equal(restarted.source, 'obs');
  assert.equal(restarted.engine, 'new-engine');
  assert.equal(starts[starts.length - 1], 'obs');
  assert.equal(oldSession.stopped, true);

  await timers.fireNext(); // 新 session 的 tick
  assert.deepEqual(registered, [fresh], '只有新 session 的 sheet 能登记');
  assert.ok(!registered.includes(late));
  assert.ok(events.some((entry) => entry.type === 'vision.evidence.capture.stale'));
  await capture.stop('test');
});

test('take 抛错不中断循环；onSheet 抛错也不中断', async () => {
  const timers = createManualTimers();
  const events = [];
  const changed = makeSheet('d');
  const session = makeSession([new Error('boom'), changed]);
  const registered = [];
  const capture = makeCapture({
    session,
    starts: [],
    timers,
    events,
    onSheet: async (sheet) => { registered.push(sheet); },
  });

  await capture.start({ source: 'screen' });
  await timers.fireNext(); // take 抛错
  assert.equal(capture.status().running, true, 'take 失败不得停止采集');
  assert.ok(
    events.some((entry) => entry.type === 'vision.evidence.capture.failed' && entry.payload.reason === 'boom'),
  );
  assert.equal(timers.only().ms, 10, '失败后继续调度');

  await timers.fireNext(); // 恢复
  assert.deepEqual(registered, [changed]);
  await capture.stop('test');

  // onSheet 抛错：sheet 已取到（计数+1），但循环继续。
  const timers2 = createManualTimers();
  const events2 = [];
  const registered2 = [];
  const first = makeSheet('e1');
  const second = makeSheet('e2');
  const session2 = makeSession([first, second]);
  const capture2 = makeCapture({
    session: session2,
    starts: [],
    timers: timers2,
    events: events2,
    onSheet: async (sheet) => {
      registered2.push(sheet);
      if (sheet === first) throw new Error('host rejected');
    },
  });
  await capture2.start({ source: 'screen' });
  await timers2.fireNext();
  assert.equal(capture2.status().running, true);
  assert.ok(
    events2.some((entry) => entry.type === 'vision.evidence.capture.failed' && entry.payload.stage === 'on-sheet'),
  );
  assert.equal(timers2.only().ms, 10);
  await timers2.fireNext();
  assert.deepEqual(registered2, [first, second]);
  await capture2.stop('test');
});

test('status 计数/时间/来源正确，stop 后 running=false，且不含文件路径', async () => {
  const timers = createManualTimers();
  const events = [];
  const changed = makeSheet('f');
  const session = makeSession([changed, null]);
  const capture = makeCapture({
    session,
    starts: [],
    timers,
    events,
    now: () => 4242,
  });

  await capture.start({ source: 'screen' });
  await timers.fireNext();
  await timers.fireNext();
  const status = capture.status();
  assert.deepEqual(status, {
    running: true,
    startedAt: 4242,
    ticks: 2,
    sheets: 1,
    idleTicks: 1,
    source: 'screen',
    engine: 'fake-engine',
  });
  assert.equal('file' in status, false);
  assert.equal(JSON.stringify(status).includes('C:'), false, 'status 不得暴露文件路径');

  await capture.stop('test');
  const stopped = capture.status();
  assert.equal(stopped.running, false);
  assert.equal(stopped.ticks, 2, '计数在 stop 后仍可读');
  assert.equal(stopped.sheets, 1);
  assert.equal(stopped.startedAt, 4242);
  await capture.done;
});

test('stop 最多等 5 s，超时记 stop-timeout 并返回', async () => {
  const timers = createManualTimers();
  const events = [];
  const never = new Promise(() => {});
  const session = makeSession([() => never], { done: new Promise(() => {}) });
  const capture = makeCapture({
    session,
    starts: [],
    timers,
    events,
  });

  await capture.start({ source: 'screen' });
  await timers.fireNext(); // take 永不返回

  const stopping = capture.stop('wedged');
  await flush();
  assert.equal(timers.only().ms, 5000, '停止等待上限应为 5 s');
  await timers.fireNext(); // 触发超时

  const stopped = await stopping;
  assert.equal(stopped.running, false);
  assert.ok(events.some((entry) => entry.type === 'vision.evidence.capture.stop-timeout'));
  await capture.done;
});

test('stop 超时放弃卡住的启动后，新的 start 仍能开会话', async () => {
  const timers = createManualTimers();
  const events = [];
  const registered = [];
  const fresh = makeSheet('fresh');
  const session = makeSession([fresh]);
  let starts = 0;
  const capture = createEvidenceCapture({
    start: async () => {
      starts += 1;
      if (starts === 1) return new Promise(() => {}); // 第一次启动永远卡住
      return session;
    },
    onSheet: async (sheet) => { registered.push(sheet); },
    isBlocked: () => false,
    now: () => 5000,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    tickMs: 10,
    idleTickMs: 100,
    maxIdleTicks: 2,
    emit: (type, payload) => events.push({ type, payload }),
  });

  void capture.start({ source: 'screen' }); // 故意不 await：它永远不会完成
  await flush();
  const stopping = capture.stop('wedged');
  await flush();
  await timers.fireNext(); // 触发 stop 的 5 s 超时
  const stopped = await stopping;
  assert.equal(stopped.running, false);

  const restarted = await capture.start({ source: 'screen' });
  assert.equal(restarted.running, true);
  assert.equal(starts, 2);
  await timers.fireNext();
  assert.deepEqual(registered, [fresh]);
  await capture.stop('test');
});

test('默认参数符合约定', () => {
  assert.deepEqual({ ...EVIDENCE_CAPTURE_DEFAULTS }, {
    tickMs: 2000,
    maxIdleTicks: 30,
    idleTickMs: 6000,
  });
  assert.ok(Object.isFrozen(EVIDENCE_CAPTURE_DEFAULTS));
});
