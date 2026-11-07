/**
 * Ambient autostart / hotkey regression.
 *
 * 1. Ambient on + a loopback device: one start after the 1.5 s settle delay, repeated loads do
 *    not start it twice.
 * 2. No device: `ambient.start.deferred` is recorded, the 5 s / 15 s / 30 s ladder is bounded,
 *    and it stops after the third retry (fake timers, no ffmpeg).
 * 3. Ctrl+Alt+A toggles the independent ambient session: running -> stop, stopped -> start.
 * 4. Ambient off: no timer, no start.
 * 5. An old hotkeys.json without `ambient` is filled with Ctrl+Alt+A; custom bindings survive.
 *
 * Run: node --test test/ambient-autostart.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cleanupRoot } from './helpers/cleanup.mjs';
import { apply, createAmbientAutostart, toggleAmbientCapture } from '../src/host/index.js';
import { DEFAULT_HOTKEYS, HOTKEY_ACTIONS } from '../src/host/platform/hotkeys.js';

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

function mount(root) {
  const tools = new Map();
  const disposers = [];
  const ctx = {
    effect: (fn) => {
      const value = fn();
      if (typeof value === 'function') disposers.push(value);
      return value;
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
  };
  apply(ctx, { root, enabled: true });
  return {
    call: async (toolName, args = {}) => {
      const tool = tools.get(toolName);
      assert.ok(tool !== undefined, `tool registered: ${toolName}`);
      return tool.execute(args, {});
    },
    /** `ctx.effect()` disposers in registration order; `cleanupRoot` runs them in reverse. */
    disposers,
  };
}

test('组件开启 + 设备存在：加载后延迟 1.5s 自动 start 一次，重复加载不重复启动', async () => {
  const timers = fakeTimers();
  const log = fakeLog();
  let starts = 0;
  let running = false;

  const auto = createAmbientAutostart({
    enabled: () => true,
    isRunning: () => running,
    start: async () => {
      starts += 1;
      running = true;
      return { ok: true, device: 'CABLE Output', error: '' };
    },
    log,
    setTimer: timers.setTimeout.bind(timers),
    clearTimer: timers.clearTimeout.bind(timers),
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
  assert.equal(log.events.length, 0, 'a successful start logs no deferred event');
});

test('设备缺失：记 ambient.start.deferred，重试 3 次（5s/15s/30s）后停止', async () => {
  const timers = fakeTimers();
  const log = fakeLog();
  let attempts = 0;

  const auto = createAmbientAutostart({
    enabled: () => true,
    isRunning: () => false,
    start: async () => {
      attempts += 1;
      return {
        ok: false,
        device: '',
        error: '没有检测到回环设备。需要 VB-Cable（CABLE Output）或启用「立体声混音」',
      };
    },
    log,
    setTimer: timers.setTimeout.bind(timers),
    clearTimer: timers.clearTimeout.bind(timers),
  });

  auto.schedule();
  await timers.fire(1500);
  assert.equal(attempts, 1, 'initial attempt');
  assert.deepEqual(
    log.events,
    [{ type: 'ambient.start.deferred', payload: { reason: '找不到设备', device: '' } }],
  );

  await timers.fire(5000);
  assert.equal(attempts, 2, 'retry 1 at 5 s');
  await timers.fire(15000);
  assert.equal(attempts, 3, 'retry 2 at 15 s');
  assert.deepEqual(timers.delays(), [30000], 'last retry is scheduled for 30 s');
  await timers.fire(30000);
  assert.equal(attempts, 4, 'retry 3 at 30 s');

  // Four deferred records total (initial + three retries), then the ladder goes quiet.
  assert.equal(log.events.filter((entry) => entry.type === 'ambient.start.deferred').length, 4);
  assert.equal(timers.size, 0, 'no timer is left after the third retry');
  assert.equal(auto.pending, false);
  await drain();
  assert.equal(attempts, 4, 'no further attempt is made');
});

test('快捷键 Ctrl+Alt+A：运行中 stop，未运行 start，结果写 hotkeys.ambient {running}', async () => {
  const log = fakeLog();
  const calls = [];
  let running = false;
  let spawns = 0;

  const deps = {
    isRunning: () => running,
    start: async () => {
      spawns += 1;
      calls.push('start');
      running = true;
      return { ok: true, device: 'CABLE Output', error: '' };
    },
    stop: async () => {
      calls.push('stop');
      running = false;
    },
    log,
  };

  const started = await toggleAmbientCapture(deps);
  assert.deepEqual(started, { running: true, device: 'CABLE Output', error: '' });
  assert.deepEqual(calls, ['start']);
  assert.equal(spawns, 1);

  const stopped = await toggleAmbientCapture(deps);
  assert.deepEqual(stopped, { running: false, device: '', error: '' });
  assert.deepEqual(calls, ['start', 'stop']);
  assert.deepEqual(log.events, [
    { type: 'hotkeys.ambient', payload: { running: true } },
    { type: 'hotkeys.ambient', payload: { running: false } },
  ]);
});

test('组件关闭：不自启，也不留下重试定时器', async () => {
  const timers = fakeTimers();
  let starts = 0;

  const auto = createAmbientAutostart({
    enabled: () => false,
    isRunning: () => false,
    start: async () => {
      starts += 1;
      return { ok: true, device: 'CABLE Output', error: '' };
    },
    log: fakeLog(),
    setTimer: timers.setTimeout.bind(timers),
    clearTimer: timers.clearTimeout.bind(timers),
  });

  auto.schedule();
  assert.equal(timers.size, 0, 'a disabled component arms nothing');
  assert.equal(starts, 0);
  await drain();
  assert.equal(starts, 0);
});

test('旧 hotkeys.json 缺 ambient：自动补 Ctrl+Alt+A，已有自定义项不被覆盖', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-assistant-ambient-hotkeys-'));
  await mkdir(join(root, 'data'), { recursive: true });
  await writeFile(
    join(root, 'data', 'hotkeys.json'),
    `${JSON.stringify(
      { mic: 'Ctrl+Alt+Shift+M', vision: 'Ctrl+Alt+Shift+V', layerEdit: 'Ctrl+Alt+Shift+E' },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const app = mount(root);
  t.after(async () => {
    await cleanupRoot(root, app.disposers);
  });

  assert.equal(DEFAULT_HOTKEYS.ambient, 'Ctrl+Alt+A');
  assert.ok(HOTKEY_ACTIONS.includes('ambient'), 'ambient is a known hotkey action');

  const status = await app.call('assistant_hotkeys', { action: 'status' });
  const bindings = Object.fromEntries(status.bindings.map((row) => [row.action, row.combo]));
  assert.equal(bindings.ambient, 'Ctrl+Alt+A', 'the missing default is filled in');
  assert.equal(bindings.mic, 'Ctrl+Alt+Shift+M', 'custom mic survives');
  assert.equal(bindings.vision, 'Ctrl+Alt+Shift+V', 'custom vision survives');
  assert.equal(bindings.layerEdit, 'Ctrl+Alt+Shift+E', 'custom layerEdit survives');
  assert.equal(status.bindings.length, 4);

  const saved = JSON.parse(await readFile(join(root, 'data', 'hotkeys.json'), 'utf8'));
  assert.equal(saved.ambient, 'Ctrl+Alt+A', 'the filled default is written back');
  assert.equal(saved.mic, 'Ctrl+Alt+Shift+M');
  assert.equal(saved.vision, 'Ctrl+Alt+Shift+V');
  assert.equal(saved.layerEdit, 'Ctrl+Alt+Shift+E');
});
