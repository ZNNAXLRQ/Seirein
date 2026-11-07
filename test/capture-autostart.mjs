/**
 * Microphone (hearing) autostart regression, sharing the capture ladder with ambient.
 *
 * 1. Hearing on: one start after the 1.5 s settle delay; repeated loads do not start twice.
 * 2. Device missing: `hearing.start.deferred` is recorded, the 5 s / 15 s / 30 s ladder is
 *    bounded, and it stops after the third retry (fake timers, no ffmpeg).
 * 3. Already running (hotkey / tool / settings page): autostart skips it and arms nothing.
 * 4. Hearing off: no timer, no start.
 * 5. The same factory still records `ambient.start.deferred` for the loopback session.
 * 6. A manual stop (`cancel()`) drops a pending retry and leaves no timer behind.
 *
 * Run: node --test test/capture-autostart.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createAmbientAutostart,
  createCaptureAutostart,
  createHearingAutostart,
} from '../src/host/index.js';

/** Let the async attempt() finish all of its awaits before the next assertion. */
async function drain() {
  for (let turn = 0; turn < 6; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** Minimal fake timer table: record delays, fire a chosen delay, never touch the real clock. */
function fakeTimers() {
  let nextId = 1;
  const pending = new Map();
  const api = {
    setTimeout(fn, ms) {
      const id = nextId;
      nextId += 1;
      pending.set(id, { id, ms, fn });
      return { id, unref() {} };
    },
    clearTimeout(handle) {
      if (handle !== null && typeof handle === 'object') pending.delete(handle.id);
    },
    delays() {
      return [...pending.values()].map((entry) => entry.ms);
    },
    get size() {
      return pending.size;
    },
    async fire(ms) {
      const found = [...pending.values()].find((entry) => entry.ms === ms);
      assert.ok(found !== undefined, `a ${ms} ms timer is pending (have ${api.delays().join(', ')})`);
      pending.delete(found.id);
      found.fn();
      await drain();
    },
  };
  return api;
}

function fakeLog() {
  const events = [];
  return {
    events,
    async emit(type, payload) {
      events.push({ type, payload });
    },
  };
}

function hearingAutostart({ enabled = () => true, isRunning = () => false, start, log, timers }) {
  return createHearingAutostart({
    enabled,
    isRunning,
    start,
    log,
    setTimer: timers.setTimeout.bind(timers),
    clearTimer: timers.clearTimeout.bind(timers),
  });
}

test('组件开启 + 设备存在：加载后延迟 1.5s 自动 start 一次，重复加载不重复启动', async () => {
  const timers = fakeTimers();
  const log = fakeLog();
  let starts = 0;
  let running = false;

  const auto = hearingAutostart({
    start: async () => {
      starts += 1;
      running = true;
      return { ok: true, running: true, device: 'Fake Mic', devices: ['Fake Mic'], error: '' };
    },
    log,
    timers,
  });

  // First load and a repeated load both arm the same singleton.
  auto.schedule();
  auto.schedule();
  assert.deepEqual(timers.delays(), [1500], 'one settle-delay timer, not two');
  assert.equal(starts, 0, 'nothing starts before the delay');

  await timers.fire(1500);
  assert.equal(starts, 1, 'exactly one start after 1.5 s');
  assert.equal(running, true);
  assert.equal(auto.deferred, null);

  // A later load/retry cannot start the already-running session again.
  auto.schedule();
  assert.equal(timers.size, 0);
  assert.equal(starts, 1);
  assert.deepEqual(log.events, [], 'a successful start logs no deferred event');
});

test('设备缺失：记 hearing.start.deferred，重试 3 次（5s/15s/30s）后停止', async () => {
  const timers = fakeTimers();
  const log = fakeLog();
  let attempts = 0;

  const auto = hearingAutostart({
    start: async () => {
      attempts += 1;
      return { ok: false, running: false, device: '', devices: [], error: '没有可用的录音设备' };
    },
    log,
    timers,
  });

  auto.schedule();
  await timers.fire(1500);
  assert.equal(attempts, 1, 'initial attempt');
  assert.deepEqual(log.events, [
    { type: 'hearing.start.deferred', payload: { reason: '找不到设备', device: '' } },
  ]);
  assert.equal(auto.deferred?.reason, '找不到设备');

  await timers.fire(5000);
  assert.equal(attempts, 2, 'retry 1 at 5 s');
  await timers.fire(15000);
  assert.equal(attempts, 3, 'retry 2 at 15 s');
  assert.deepEqual(timers.delays(), [30000], 'last retry is scheduled for 30 s');
  await timers.fire(30000);
  assert.equal(attempts, 4, 'retry 3 at 30 s');

  // Four deferred records total (initial + three retries), then the ladder goes quiet.
  assert.equal(log.events.filter((entry) => entry.type === 'hearing.start.deferred').length, 4);
  assert.equal(timers.size, 0, 'no timer is left after the third retry');
  assert.equal(auto.pending, false);
  await drain();
  assert.equal(attempts, 4, 'no further attempt is made');
});

test('设备占用：同样记 hearing.start.deferred（reason=设备占用）', async () => {
  const timers = fakeTimers();
  const log = fakeLog();

  const auto = hearingAutostart({
    start: async () => ({ ok: false, device: 'Fake Mic', error: 'ffmpeg: device busy (EBUSY)' }),
    log,
    timers,
  });

  auto.schedule();
  await timers.fire(1500);
  assert.deepEqual(log.events, [
    { type: 'hearing.start.deferred', payload: { reason: '设备占用', device: 'Fake Mic' } },
  ]);
  auto.cancel();
});

test('已在运行：跳过，不启动也不留定时器', async () => {
  const timers = fakeTimers();
  const log = fakeLog();
  let starts = 0;

  const auto = hearingAutostart({
    isRunning: () => true,
    start: async () => {
      starts += 1;
      return { ok: true, running: true, device: 'Fake Mic', devices: [], error: '' };
    },
    log,
    timers,
  });

  auto.schedule();
  assert.equal(timers.size, 0, 'a running session arms nothing');
  assert.equal(starts, 0);
  await drain();
  assert.equal(starts, 0);
  assert.equal(auto.deferred, null);
});

test('组件关闭：不自启，也不留下重试定时器', async () => {
  const timers = fakeTimers();
  let starts = 0;

  const auto = hearingAutostart({
    enabled: () => false,
    start: async () => {
      starts += 1;
      return { ok: true, running: true, device: 'Fake Mic', devices: [], error: '' };
    },
    log: fakeLog(),
    timers,
  });

  auto.schedule();
  assert.equal(timers.size, 0, 'a disabled component arms nothing');
  assert.equal(starts, 0);
  await drain();
  assert.equal(starts, 0);
});

test('回环回归：共用工厂仍记 ambient.start.deferred，时序不变', async () => {
  const timers = fakeTimers();
  const log = fakeLog();

  // `createCaptureAutostart` without a kind stays ambient; the named wrapper is the same.
  const viaFactory = createCaptureAutostart({
    enabled: () => true,
    isRunning: () => false,
    start: async () => ({ ok: false, device: '', error: '没有检测到回环设备' }),
    log,
    setTimer: timers.setTimeout.bind(timers),
    clearTimer: timers.clearTimeout.bind(timers),
  });
  viaFactory.schedule();
  assert.deepEqual(timers.delays(), [1500]);
  await timers.fire(1500);
  assert.deepEqual(log.events, [
    { type: 'ambient.start.deferred', payload: { reason: '找不到设备', device: '' } },
  ]);
  assert.deepEqual(timers.delays(), [5000], 'ambient keeps the 5 s first retry');
  viaFactory.cancel();

  const named = createAmbientAutostart({
    enabled: () => false,
    isRunning: () => false,
    start: async () => ({ ok: true, device: '', error: '' }),
    log: fakeLog(),
    setTimer: timers.setTimeout.bind(timers),
    clearTimer: timers.clearTimeout.bind(timers),
  });
  named.schedule();
  assert.equal(named.pending, false);
});

test('手动停止（cancel）：清掉待重试，之后不再尝试', async () => {
  const timers = fakeTimers();
  const log = fakeLog();
  let attempts = 0;

  const auto = hearingAutostart({
    start: async () => {
      attempts += 1;
      return { ok: false, device: '', error: '没有可用的录音设备' };
    },
    log,
    timers,
  });

  auto.schedule();
  await timers.fire(1500);
  assert.equal(attempts, 1);
  assert.deepEqual(timers.delays(), [5000], 'the first retry is pending');

  // stopListening() cancels the ladder: the user asked for quiet.
  auto.cancel();
  assert.equal(auto.pending, false);
  assert.equal(timers.size, 0);
  await drain();
  assert.equal(attempts, 1, 'no retry runs after a manual stop');
});
