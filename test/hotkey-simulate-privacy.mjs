/**
 * `assistant_hotkeys simulate` 不能绕过隐私：
 *
 *   1. 隐私开启时，凡是会触发 vision / mic 绑定（含多按一个修饰键也能落到的绑定）的 simulate
 *      一律拒绝：`ok:false, reason:'privacy-blocked'`，不注入按键，并记录
 *      `hotkey.simulate.refused {reason}`；隐私保持开启；
 *   2. 隐私开启时，simulate 一个与隐私无关的绑定（layerEdit）仍可用；
 *   3. 非隐私下 simulate 正常；
 *   4. 回归：用户真实按下 vision 热键（poller.tick 读到的真实按键状态）仍能退出隐私。
 *
 * No real key is injected: `HotkeyPoller.prototype.simulate` is replaced with a recorder, and
 * the poller's native start is replaced with a fake `GetAsyncKeyState` state.
 *
 * Run: node --test test/hotkey-simulate-privacy.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { cleanupRoot } from './helpers/cleanup.mjs';
import { apply } from '../src/host/index.js';
import {
  DEFAULT_HOTKEYS,
  HotkeyPoller,
  hotkeyActionsForCombo,
} from '../src/host/platform/hotkeys.js';

const VK = { ctrl: 0x11, alt: 0x12, v: 0x56, m: 0x4d, e: 0x45 };

/** Mount the real host with settings routes and a fake key state; never touches real keys. */
async function mount(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-hotkey-privacy-'));
  const tools = new Map();
  const routes = new Map();
  const disposers = [];
  const capturedPoller = [];
  const api = {
    down: new Set(),
    getAsyncKeyState(vk) { return this.down.has(vk) ? 0x8000 : 0; },
    keybdEvent() { throw new Error('a real key was injected'); },
  };
  // Replace native start: capture the real poller and give it the fake key state.
  t.mock.method(HotkeyPoller.prototype, 'start', async function start() {
    this.api = api;
    this.refresh(this.bindings);
    capturedPoller.push(this);
  });
  const simulated = [];
  t.mock.method(HotkeyPoller.prototype, 'simulate', async function simulate(combo) {
    simulated.push(combo);
  });

  const effect = (fn) => {
    const cleanup = fn();
    if (typeof cleanup === 'function') disposers.push(cleanup);
    return cleanup;
  };
  apply({
    effect,
    get: () => undefined,
    tools: { register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name); } },
    inject: (_dependencies, register) => register({
      effect,
      systemPrompt: { section: () => () => {} },
      webServer: { register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path); } },
    }),
  }, { root, enabled: true });
  t.after(async () => {
    await cleanupRoot(root, disposers);
  });

  const route = async (path, body) => {
    let data;
    const req = body === undefined
      ? { method: 'GET', url: path }
      : Object.assign(Readable.from([JSON.stringify(body)]), { method: 'POST', url: path });
    await routes.get(path.split('?')[0])(req, {
      writeHead() {},
      end(value) { data = value; },
    });
    return data;
  };
  const events = async () => (await readFile(join(root, 'data', 'events.jsonl'), 'utf8').catch(() => ''))
    .trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const waitForEvent = async (type, predicate = () => true) => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const hit = (await events()).find((event) => event.type === type && predicate(event));
      if (hit !== undefined) return hit;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return undefined;
  };
  return {
    root,
    api,
    simulated,
    capturedPoller,
    call: (name, args = {}) => tools.get(name).execute(args, {}),
    action: async (body) => JSON.parse(await route('/assistant/action', body)),
    waitForEvent,
    events,
  };
}

test('1. 命中 vision/mic 绑定的 simulate 在隐私下被拒绝，并记录 hotkey.simulate.refused', async (t) => {
  const app = await mount(t);
  assert.equal((await app.action({ action: 'vision.mode', mode: 'privacy' })).ok, true);
  assert.equal((await app.call('assistant_vision', { action: 'status' })).mode, 'privacy');

  for (const combo of ['Ctrl+Alt+V', 'Ctrl+Alt+Shift+V', 'Ctrl+Alt+M']) {
    const result = await app.call('assistant_hotkeys', { action: 'simulate', combo });
    assert.equal(result.ok, false, `${combo} 被拒绝`);
    assert.equal(result.reason, 'privacy-blocked', `${combo} -> privacy-blocked`);
    assert.match(result.error, /隐私/u);
  }
  assert.deepEqual(app.simulated, [], '被拒绝的 simulate 没有注入任何按键');
  assert.equal((await app.call('assistant_vision', { action: 'status' })).mode, 'privacy', '隐私仍开启');

  const refused = await app.waitForEvent('hotkey.simulate.refused', (event) => event.payload?.reason === 'privacy-blocked');
  assert.ok(refused, 'hotkey.simulate.refused 已写入 events.jsonl');
  assert.equal(refused.payload.reason, 'privacy-blocked');

  // A privacy-neutral binding is still allowed for poller testing.
  assert.equal((await app.call('assistant_hotkeys', { action: 'simulate', combo: 'Ctrl+Alt+E' })).ok, true);
  assert.deepEqual(app.simulated, ['Ctrl+Alt+E']);
  assert.equal((await app.call('assistant_vision', { action: 'status' })).mode, 'privacy', '中性 simulate 不改变隐私');

  t.diagnostic(`privacy-blocked for Ctrl+Alt+V / Ctrl+Alt+Shift+V / Ctrl+Alt+M · layerEdit still simulated · event reason=${refused.payload.reason}`);
});

test('2. 非隐私下 simulate 正常；隐私状态由运行中的 vision 模式决定', async (t) => {
  const app = await mount(t);
  assert.equal((await app.call('assistant_vision', { action: 'status' })).mode, 'watch');
  const result = await app.call('assistant_hotkeys', { action: 'simulate', combo: 'Ctrl+Alt+V' });
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(app.simulated, ['Ctrl+Alt+V']);

  // Entering privacy through the settings/user path flips the same guard back on.
  assert.equal((await app.action({ action: 'vision.mode', mode: 'privacy' })).ok, true);
  const blocked = await app.call('assistant_hotkeys', { action: 'simulate', combo: 'Ctrl+Alt+V' });
  assert.equal(blocked.reason, 'privacy-blocked');

  t.diagnostic(`watch -> simulate ok (${app.simulated.length} call) · privacy -> ${blocked.reason}`);
});

test('3. 回归：用户真实按下 vision 热键仍能退出隐私（热键路径未被改动）', async (t) => {
  const app = await mount(t);
  assert.equal((await app.action({ action: 'vision.mode', mode: 'privacy' })).ok, true);
  assert.equal(app.capturedPoller.length, 1, 'the host poller was captured');

  // Hold Ctrl+Alt+V exactly like a human would; the poller reads the fake async key state.
  app.api.down = new Set([VK.ctrl, VK.alt, VK.v]);
  app.capturedPoller[0].tick();

  let mode = 'privacy';
  for (let attempt = 0; attempt < 200 && mode === 'privacy'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    mode = (await app.call('assistant_vision', { action: 'status' })).mode;
  }
  assert.equal(mode, 'watch', 'the user hotkey left privacy');
  assert.equal((await app.call('assistant_hotkeys', { action: 'status' })).lastAction, 'vision');

  const triggered = await app.waitForEvent('hotkey.triggered', (event) => event.payload?.action === 'vision');
  assert.ok(triggered, 'hotkey.triggered recorded for the real press');

  t.diagnostic(`real Ctrl+Alt+V -> privacy off (mode=${mode}) · lastAction=vision · hotkey.triggered recorded`);
});

test('4. 匹配规则覆盖“多按一个修饰键也能落到该绑定”的情况', () => {
  assert.deepEqual(hotkeyActionsForCombo(DEFAULT_HOTKEYS, 'Ctrl+Alt+V'), ['vision']);
  assert.deepEqual(hotkeyActionsForCombo(DEFAULT_HOTKEYS, 'Ctrl+Alt+Shift+V'), ['vision']);
  assert.deepEqual(hotkeyActionsForCombo(DEFAULT_HOTKEYS, 'Ctrl+Alt+M'), ['mic']);
  assert.deepEqual(hotkeyActionsForCombo(DEFAULT_HOTKEYS, 'Ctrl+Alt+E'), ['layerEdit']);
  assert.deepEqual(hotkeyActionsForCombo(DEFAULT_HOTKEYS, 'Ctrl+Alt+F9'), []);
  assert.deepEqual(hotkeyActionsForCombo({ vision: 'F9' }, 'Ctrl+F9'), ['vision']);
  assert.deepEqual(hotkeyActionsForCombo({ vision: 'Ctrl+Alt+V' }, 'Ctrl+V'), [], '缺少修饰键不会落到绑定');
  assert.deepEqual(hotkeyActionsForCombo(null, 'Ctrl+Alt+V'), []);
  assert.deepEqual(hotkeyActionsForCombo(DEFAULT_HOTKEYS, 'Num1'), []);
});
