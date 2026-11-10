/**
 * Hotkey key parsing and conflicts:
 *
 *   1. A bare Num1 is refused: numpad digits type text, so they need a modifier. The message
 *      names the reason in the user's words and suggests F9 or a media/volume key.
 *   2. The whole numpad (Num0..Num9 and the five operators) belongs to the modifier-required set.
 *   3. Modified numpad combos still parse: "Ctrl+Num1" -> VK 97 (0x61) while "Ctrl+1" -> 49
 *      (0x31), and the two remain distinguishable.
 *   4. F1-F24 are valid single keys; F9 is checked through parseBinding and through the tool.
 *   5. Media/volume keys and explicit non-text keys (Esc, Enter, arrows, Home/End/PgUp/PgDn,
 *      Insert/Delete) may still stand alone.
 *   6. Regression: legacy combos keep their exact modifiers/VK, the shipped default table parses
 *      without overlap, numpad and main-row digits do not conflict, bare letters/digits/Space
 *      are still refused, and a duplicate combo is still accepted with one hotkey.conflict event.
 *
 * Numpad Enter is intentionally not covered: it shares VK_RETURN (0x0d) with Enter and Windows
 * exposes no way to tell them apart, so it is documented as `Enter`.
 *
 * Run: node --test test/hotkeys-keys.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cleanupRoot } from './helpers/cleanup.mjs';
import { apply } from '../src/host/index.js';
import { DEFAULT_HOTKEYS, findHotkeyConflicts, parseBinding } from '../src/host/platform/hotkeys.js';

const NUMPAD_NAMES = [
  ...Array.from({ length: 10 }, (_, digit) => `Num${digit}`),
  'NumMultiply',
  'NumAdd',
  'NumSubtract',
  'NumDecimal',
  'NumDivide',
];

/** Minimal fake context: enough for `apply()` to register tools and mount the poller. */
function mount(root, config = {}) {
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
  apply(ctx, { root, enabled: true, ...config });
  return {
    call: async (toolName, args = {}) => {
      const tool = tools.get(toolName);
      assert.ok(tool !== undefined, `tool registered: ${toolName}`);
      return tool.execute(args, {});
    },
    disposers,
  };
}

/** Poll the host JSONL log for events of one type (the log append is asynchronous). */
async function waitForEvents(root, type, timeoutMs = 5000) {
  const { readFile } = await import('node:fs/promises');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const events = (await readFile(join(root, 'data', 'events.jsonl'), 'utf8').catch(() => ''))
      .trim()
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line));
    const found = events.filter((event) => event.type === type);
    if (found.length > 0) return found;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return [];
}

/** A bare key that types text must explain the numpad reason and point at F9/media keys. */
function assertModifierRequired(combo) {
  assert.throws(
    () => parseBinding(combo),
    (error) => {
      assert.match(error.message, /需要修饰键/u, `${combo} names the missing modifier`);
      assert.match(error.message, /needs a modifier/u);
      assert.match(error.message, /小键盘数字也会打字/u, `${combo} says numpad keys also type`);
      assert.match(error.message, /F9/u, `${combo} suggests F9`);
      assert.match(error.message, /媒体键/u, `${combo} suggests a media key`);
      assert.match(error.message, /Ctrl\+/u, `${combo} suggests a modified combo`);
      return true;
    },
    `${combo} is refused without a modifier`,
  );
}

test('1. 裸 Num1 被拒绝：错误说明小键盘数字也会打字并建议 F9/媒体键', async (t) => {
  assertModifierRequired('Num1');

  const root = await mkdtemp(join(tmpdir(), 'dsh-assistant-hotkeys-keys-'));
  const app = mount(root);
  t.after(async () => {
    await cleanupRoot(root, app.disposers);
  });

  const refused = await app.call('assistant_hotkeys', { action: 'set', name: 'vision', combo: 'Num1' });
  assert.equal(refused.ok, false, 'the tool refuses a bare numpad digit');
  assert.match(refused.error, /需要修饰键/u);
  assert.match(refused.error, /小键盘数字也会打字/u);
  assert.match(refused.error, /F9/u);
  assert.match(refused.error, /媒体键/u);

  const status = await app.call('assistant_hotkeys', { action: 'status' });
  const vision = status.bindings.find((entry) => entry.action === 'vision');
  assert.equal(vision?.combo, DEFAULT_HOTKEYS.vision, 'the rejected binding is not saved');

  t.diagnostic(`Num1 -> rejected: "${refused.error.slice(0, 64)}..." · vision stays ${vision?.combo}`);
});

test('2. 裸 Num5 与裸 numadd 同样被拒绝；全部小键盘键名都需要修饰键', (t) => {
  assertModifierRequired('Num5');
  assertModifierRequired('numadd');
  for (const name of NUMPAD_NAMES) assertModifierRequired(name);

  t.diagnostic(`Num5 / numadd / all ${NUMPAD_NAMES.length} numpad names -> 需要修饰键 · F9/媒体键`);
});

test('3. Ctrl+Num1 -> 97、Ctrl+1 -> 49：带修饰组合仍有效且可区分', (t) => {
  const numpad = parseBinding('Ctrl+Num1');
  const mainRow = parseBinding('Ctrl+1');

  assert.deepEqual(numpad.mods, [0x11]);
  assert.deepEqual(mainRow.mods, [0x11]);
  // Windows VK_NUMPAD0..9 are 0x60..0x69, so the key labelled "1" is 0x61 = 97. 96 is Num0.
  assert.equal(numpad.vk, 0x61);
  assert.equal(mainRow.vk, 0x31);
  assert.equal(numpad.vk, 97);
  assert.equal(mainRow.vk, 49);
  assert.notEqual(numpad.vk, mainRow.vk, 'numpad and main-row digits are distinguishable');
  assert.equal(parseBinding('Ctrl+Num0').vk, 96);

  const operators = {
    NumMultiply: 0x6a,
    NumAdd: 0x6b,
    NumSubtract: 0x6d,
    NumDecimal: 0x6e,
    NumDivide: 0x6f,
  };
  for (const [name, vk] of Object.entries(operators)) {
    const parsed = parseBinding(`Ctrl+${name}`);
    assert.deepEqual(parsed.mods, [0x11], `${name} keeps the modifier`);
    assert.equal(parsed.vk, vk, `${name} -> 0x${vk.toString(16)}`);
  }
  assert.equal(parseBinding('Ctrl+numadd').vk, 0x6b, 'operator names are case-insensitive');

  t.diagnostic(`Ctrl+Num1 -> mods=[0x11] vk=${numpad.vk} (0x61) · Ctrl+1 -> mods=[0x11] vk=${mainRow.vk} (0x31) · Ctrl+Num0 -> 96 (0x60) · operators keep their VKs`);
});

test('4. F9 裸键通过；F1-F24 均为可用单键', async (t) => {
  const binding = parseBinding('F9');
  assert.deepEqual(binding.mods, [], 'no modifier required');
  assert.equal(binding.vk, 0x78);

  for (let index = 1; index <= 24; index += 1) {
    const functionKey = parseBinding(`F${index}`);
    assert.deepEqual(functionKey.mods, [], `F${index} may stand alone`);
    assert.equal(functionKey.vk, 0x6f + index, `F${index} -> 0x${(0x6f + index).toString(16)}`);
  }

  const root = await mkdtemp(join(tmpdir(), 'dsh-assistant-hotkeys-keys-'));
  const app = mount(root);
  t.after(async () => {
    await cleanupRoot(root, app.disposers);
  });

  const set = await app.call('assistant_hotkeys', { action: 'set', name: 'vision', combo: 'F9' });
  assert.equal(set.ok, true, `F9 passes tool validation: ${set.error ?? ''}`);
  const status = await app.call('assistant_hotkeys', { action: 'status' });
  const row = status.bindings.find((entry) => entry.action === 'vision');
  assert.equal(row?.combo, 'F9');
  assert.equal(row?.valid, true);

  t.diagnostic(`F9 -> mods=[] vk=${binding.vk} (0x78) · F1-F24 parse · tool set ok=${set.ok} valid=${row?.valid}`);
});

test('5. MediaPlayPause 裸键通过；媒体/音量与非文本键仍可单键', (t) => {
  const media = parseBinding('MediaPlayPause');
  assert.deepEqual(media.mods, [], 'MediaPlayPause may stand alone');
  assert.equal(media.vk, 0xb3);

  const singles = {
    MediaStop: 0xb2,
    MediaNext: 0xb0,
    MediaPrev: 0xb1,
    VolumeMute: 0xad,
    VolumeDown: 0xae,
    VolumeUp: 0xaf,
    Esc: 0x1b,
    Enter: 0x0d,
    Up: 0x26,
    Down: 0x28,
    Left: 0x25,
    Right: 0x27,
    Home: 0x24,
    End: 0x23,
    PageUp: 0x21,
    PageDown: 0x22,
    Insert: 0x2d,
    Delete: 0x2e,
  };
  for (const [name, vk] of Object.entries(singles)) {
    const parsed = parseBinding(name);
    assert.deepEqual(parsed.mods, [], `${name} may stand alone`);
    assert.equal(parsed.vk, vk, `${name} -> 0x${vk.toString(16)}`);
  }

  t.diagnostic(`MediaPlayPause -> mods=[] vk=${media.vk} (0xb3) · ${Object.keys(singles).length} media/non-text keys remain single-key`);
});

test('6. 回归：旧组合、默认表、numpad 不冲突、重复组合仍上报冲突', async (t) => {
  const legacy = parseBinding('Ctrl+Alt+V');
  assert.deepEqual(legacy.mods, [0x11, 0x12]);
  assert.equal(legacy.vk, 0x56);

  const shipped = Object.fromEntries(
    Object.entries(DEFAULT_HOTKEYS).map(([action, combo]) => [action, parseBinding(combo)]),
  );
  assert.deepEqual(shipped.mic.mods, [0x11, 0x12]);
  assert.equal(shipped.mic.vk, 0x4d);
  assert.deepEqual(shipped.vision.mods, [0x11, 0x12]);
  assert.equal(shipped.vision.vk, 0x56);
  assert.deepEqual(shipped.layerEdit.mods, [0x11, 0x12]);
  assert.equal(shipped.layerEdit.vk, 0x45);
  assert.deepEqual(shipped.ambient.mods, [0x11, 0x12]);
  assert.equal(shipped.ambient.vk, 0x41);
  assert.deepEqual(shipped.callMode.mods, [0x11, 0x12]);
  assert.equal(shipped.callMode.vk, 0x43);
  assert.deepEqual(findHotkeyConflicts(DEFAULT_HOTKEYS), []);
  assert.deepEqual(
    findHotkeyConflicts({ mic: 'Ctrl+Num1', vision: 'Ctrl+1' }),
    [],
    'numpad and main-row digits do not conflict',
  );

  // Bare letters/digits/Space are still refused: the new numpad rule did not widen anything.
  assert.throws(() => parseBinding('L'), /需要修饰键/u);
  assert.throws(() => parseBinding('5'), /需要修饰键/u);
  assert.throws(() => parseBinding('Space'), /需要修饰键/u);

  // A duplicate combo is still accepted (both actions keep firing, as before) but emits one
  // `hotkey.conflict` event naming both actions and the combo.
  const root = await mkdtemp(join(tmpdir(), 'dsh-assistant-hotkeys-keys-'));
  const app = mount(root);
  t.after(async () => {
    await cleanupRoot(root, app.disposers);
  });

  const changed = await app.call('assistant_hotkeys', { action: 'set', name: 'vision', combo: 'Ctrl+Alt+M' });
  assert.equal(changed.ok, true, 'the existing behavior is kept: the duplicate binding is accepted');

  const events = await waitForEvents(root, 'hotkey.conflict');
  assert.equal(events.length, 1, 'exactly one conflict event for the pair');
  const payload = events[0].payload;
  assert.deepEqual([payload.action, payload.conflictWith].sort(), ['mic', 'vision'], 'both actions are named');
  assert.equal(payload.combo, 'Ctrl+Alt+M');

  const status = await app.call('assistant_hotkeys', { action: 'status' });
  const vision = status.bindings.find((entry) => entry.action === 'vision');
  assert.equal(vision?.combo, 'Ctrl+Alt+M', 'the conflicting binding was not silently dropped');
  assert.equal(vision?.valid, true);

  // A table that already overlaps at mount time (saved file / plugin config) is reported too.
  const mountRoot = await mkdtemp(join(tmpdir(), 'dsh-assistant-hotkeys-keys-'));
  const mounted = mount(mountRoot, { hotkeys: { vision: 'Ctrl+Alt+M' } });
  t.after(async () => {
    await cleanupRoot(mountRoot, mounted.disposers);
  });
  const loadEvents = await waitForEvents(mountRoot, 'hotkey.conflict');
  assert.equal(loadEvents.length, 1, 'the conflict is reported on load as well');
  assert.equal(loadEvents[0].payload.combo, 'Ctrl+Alt+M');

  t.diagnostic(`legacy Ctrl+Alt+V -> vk=0x${legacy.vk.toString(16)} · defaults ok · numpad/main-row conflicts=0 · duplicate events set=${events.length} load=${loadEvents.length}`);
});
