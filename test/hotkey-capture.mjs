/**
 * Settings-page hotkey capture must distinguish the numpad from the main row.
 *
 * The settings page listens for `keydown` and builds `[...mods, normalizeKey(event)].join('+')`.
 * With NumLock on, a numpad digit reports `key="1"` exactly like the main row, so reading
 * `event.key` used to collapse a captured numpad press into "Ctrl+1". `normalizeKey` now reads
 * `event.code` first for `Numpad*`, while the hotkey engine already maps Num0..Num9 /
 * NumMultiply / NumAdd / NumSubtract / NumDecimal / NumDivide onto the VK_NUMPAD0..9 and
 * operator virtual keys — "Ctrl+Num1" (0x61) and "Ctrl+1" (0x31) stay distinct end to end.
 *
 * The shipped `normalizeKey` and the shipped `keydown` handler are sliced out of client.js and
 * run against fake events (same approach as test/ack-delay-ui.mjs); the save round-trip goes
 * through the real host tool, so the stored combo is exactly what the UI captured.
 *
 * Regression commands: `node test/smoke.mjs` and `node --check client.js`.
 *
 * Run: node --test test/hotkey-capture.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cleanupRoot } from './helpers/cleanup.mjs';
import { apply } from '../src/host/index.js';
import { parseBinding } from '../src/host/platform/hotkeys.js';

const clientSource = await readFile(new URL('../client.js', import.meta.url), 'utf8');

/** The shipped `NUMPAD_CODE` table + `normalizeKey` (they sit together at the top of the factory). */
const loadNormalizeKey = () => {
  const from = clientSource.indexOf('    const NUMPAD_CODE = {');
  const to = clientSource.indexOf("    const POLL_KEY = '__seireinPoll';", from);
  assert.ok(from > 0 && to > from, 'the shipped normalizeKey is found in client.js');
  return new Function(`${clientSource.slice(from, to)}\n    return normalizeKey;`)();
};
const normalizeKey = loadNormalizeKey();

/** The shipped `onKeyDown` capture handler, with the three React setters replaced by recorders. */
const loadKeydownHandler = () => {
  const from = clientSource.indexOf('        const onKeyDown = (event) => {');
  const to = clientSource.indexOf("        window.addEventListener('keydown', onKeyDown, true);", from);
  assert.ok(from > 0 && to > from, 'the shipped hotkey keydown handler is found in client.js');
  return new Function('normalizeKey', `
    const calls = { captured: [], hint: [] };
    const setEditingHotkey = () => {};
    const setCaptured = (value) => { calls.captured.push(value); };
    const setCaptureHint = (value) => { calls.hint.push(value); };
    ${clientSource.slice(from, to)}
    return { onKeyDown, calls };
  `)(normalizeKey);
};

/** Press one key and report what the settings page would display/save. */
const press = (init) => {
  const { onKeyDown, calls } = loadKeydownHandler();
  onKeyDown({
    code: '',
    key: '',
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    preventDefault() {},
    stopPropagation() {},
    ...init,
  });
  return { captured: calls.captured.at(-1) ?? '', hint: calls.hint.at(-1) ?? '' };
};

const NUMPAD_OPERATORS = [
  ['NumpadMultiply', 'NumMultiply', '*'],
  ['NumpadAdd', 'NumAdd', '+'],
  ['NumpadSubtract', 'NumSubtract', '-'],
  ['NumpadDecimal', 'NumDecimal', '.'],
  ['NumpadDivide', 'NumDivide', '/'],
];

/** Minimal fake context: enough for `apply()` to register tools and mount the poller. */
const mount = (root) => {
  const tools = new Map();
  const disposers = [];
  apply({
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
  }, { root, enabled: true });
  return {
    call: (name, args = {}) => tools.get(name).execute(args, {}),
    disposers,
  };
};

test('1. Numpad1 + Ctrl 捕获为 Ctrl+Num1，不再退化成 Ctrl+1', (t) => {
  assert.equal(normalizeKey({ code: 'Numpad1', key: '1' }), 'Num1');

  const result = press({ code: 'Numpad1', key: '1', ctrlKey: true });
  assert.equal(result.captured, 'Ctrl+Num1');
  assert.notEqual(result.captured, 'Ctrl+1', 'the numpad digit is not folded into the main-row digit');
  assert.equal(result.hint, '');

  // All ten numpad digits take the Num0..Num9 names.
  for (let digit = 0; digit <= 9; digit += 1) {
    assert.equal(normalizeKey({ code: `Numpad${digit}`, key: String(digit) }), `Num${digit}`);
  }

  t.diagnostic(`code=Numpad1 key="1" +Ctrl -> captured="${result.captured}" · all ten digits -> Num0..Num9`);
});

test('2. Digit1 + Ctrl 捕获为 Ctrl+1，主键盘数字不被改名', (t) => {
  assert.equal(normalizeKey({ code: 'Digit1', key: '1' }), '1');

  const result = press({ code: 'Digit1', key: '1', ctrlKey: true });
  assert.equal(result.captured, 'Ctrl+1');
  assert.notEqual(result.captured, 'Ctrl+Num1');
  assert.equal(result.hint, '');

  t.diagnostic(`code=Digit1 key="1" +Ctrl -> captured="${result.captured}"`);
});

test('3. NumpadAdd 等五类小键盘运算符捕获为 Ctrl+NumAdd', (t) => {
  for (const [code, name, key] of NUMPAD_OPERATORS) {
    assert.equal(normalizeKey({ code, key }), name, `${code} -> ${name}`);
    const result = press({ code, key, ctrlKey: true });
    assert.equal(result.captured, `Ctrl+${name}`, `${code} keeps its numpad name`);
  }

  const add = press({ code: 'NumpadAdd', key: '+', ctrlKey: true });
  assert.equal(add.captured, 'Ctrl+NumAdd');
  assert.notEqual(add.captured, 'Ctrl++', 'the operator character does not win over the numpad name');

  t.diagnostic(`NumpadMultiply/Add/Subtract/Decimal/Divide + Ctrl -> ${NUMPAD_OPERATORS.map(([, name]) => `Ctrl+${name}`).join(' / ')}`);
});

test('4. F9 单键可直接捕获；主键盘数字/字母与小键盘无修饰仍被拒绝', (t) => {
  const f9 = press({ code: 'F9', key: 'F9' });
  assert.equal(f9.captured, 'F9');
  assert.equal(f9.hint, '');
  assert.equal(parseBinding('F9').combo, 'F9', 'the host accepts a bare F key');

  for (const [label, event] of [
    ['main-row digit', { code: 'Digit1', key: '1' }],
    ['letter', { code: 'KeyV', key: 'v' }],
    ['numpad digit', { code: 'Numpad1', key: '1' }],
  ]) {
    const refused = press(event);
    assert.equal(refused.captured, '', `${label} is not captured without a modifier`);
    assert.match(refused.hint, /需要至少一个修饰键/u, `${label} says a modifier is required`);
  }

  t.diagnostic(`F9 -> "${f9.captured}" (single key) · bare Digit1/KeyV/Numpad1 -> refused with 修饰键 hint`);
});

test('5. UI 显示与保存值一致：Ctrl+Num1 原样保存，host status 不改写', async (t) => {
  const captured = press({ code: 'Numpad1', key: '1', ctrlKey: true }).captured;
  assert.equal(captured, 'Ctrl+Num1');

  // The settings page saves `captured` verbatim and displays `entry.combo` verbatim.
  assert.match(
    clientSource,
    /action: 'hotkey\.set', name: entry\.action, combo: captured/u,
    'the save button sends the captured combo unchanged',
  );
  assert.match(
    clientSource,
    /editingHotkey === entry\.action \? \(captured \|\| '请按键…'\) : entry\.combo/u,
    'the displayed value is the captured combo / the stored combo, never a rewritten key',
  );
  assert.match(
    clientSource,
    /小键盘需要 NumLock 打开（关闭时产生的是方向键功能）/u,
    'the hint warns that the numpad needs NumLock',
  );

  const root = await mkdtemp(join(tmpdir(), 'dsh-assistant-hotkey-capture-'));
  const app = mount(root);
  t.after(async () => {
    await cleanupRoot(root, app.disposers);
  });

  const saved = await app.call('assistant_hotkeys', { action: 'set', name: 'mic', combo: captured });
  assert.equal(saved.ok, true, `the host accepts the captured combo: ${saved.error ?? ''}`);

  const status = await app.call('assistant_hotkeys', { action: 'status' });
  const row = status.bindings.find((entry) => entry.action === 'mic');
  assert.equal(row?.combo, 'Ctrl+Num1', 'the stored combo is still Num1, not 1');
  assert.equal(row?.valid, true);

  assert.equal(parseBinding(captured).vk, 0x61, 'Ctrl+Num1 -> VK_NUMPAD1');
  assert.equal(parseBinding('Ctrl+1').vk, 0x31, 'Ctrl+1 -> VK_1');

  t.diagnostic(`captured="${captured}" -> saved combo="${row?.combo}" valid=${row?.valid} · vk=0x61 vs Ctrl+1 vk=0x31 · NumLock hint present`);
});
