/**
 * Hotkey pruning regression: an upgrade must start normally with an old hotkeys.json.
 *
 * Retired actions (ptt / avatar / pauseAll / settings) are dropped on load, the cleaned table is
 * written back, and one `hotkeys.pruned` event records the cleanup. Unknown actions are treated
 * the same way. mic, vision, layerEdit and ambient remain and all stay rebindable.
 *
 * Run: node --test test/hotkeys-prune.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cleanupRoot } from './helpers/cleanup.mjs';
import { apply } from '../src/host/index.js';
import { DEFAULT_HOTKEYS, HOTKEY_ACTIONS, pruneHotkeyBindings } from '../src/host/platform/hotkeys.js';

/** A hotkeys.json written by an older build, plus one action no build ever shipped. */
const OLD_BINDINGS = {
  ptt: 'Ctrl+Alt+T',
  mic: 'Ctrl+Alt+M',
  vision: 'Ctrl+Alt+V',
  avatar: 'Ctrl+Alt+L',
  layerEdit: 'Ctrl+Alt+Shift+E',
  pauseAll: 'Ctrl+Alt+Space',
  settings: 'Ctrl+Alt+S',
  unknownAction: 'Ctrl+Alt+U',
};

const KEPT = ['ambient', 'layerEdit', 'mic', 'vision'];
/** OLD_BINDINGS predates ambient, so pruning alone keeps only these three. */
const PRUNED = ['layerEdit', 'mic', 'vision'];
const RETIRED = ['avatar', 'pauseAll', 'ptt', 'settings', 'unknownAction'];

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

const actions = (bindings) => Object.keys(bindings).sort();

test('the default table and the pruner keep only mic / vision / layerEdit / ambient', () => {
  assert.deepEqual([...HOTKEY_ACTIONS].sort(), KEPT);
  assert.deepEqual(actions(DEFAULT_HOTKEYS), KEPT);

  const pruned = pruneHotkeyBindings(OLD_BINDINGS);
  assert.deepEqual(actions(pruned.bindings), PRUNED);
  assert.equal(pruned.bindings.layerEdit, 'Ctrl+Alt+Shift+E', 'a custom layerEdit survives pruning');
  assert.deepEqual(pruned.dropped.map((entry) => entry.action).sort(), RETIRED);
  // A garbage table is discarded, never thrown on.
  assert.deepEqual(pruneHotkeyBindings(null), { bindings: {}, dropped: [] });
  assert.deepEqual(pruneHotkeyBindings([]), { bindings: {}, dropped: [] });
});

test('loading an old hotkeys.json drops retired actions, logs hotkeys.pruned and stays editable', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-assistant-hotkeys-'));
  await mkdir(join(root, 'data'), { recursive: true });
  await writeFile(join(root, 'data', 'hotkeys.json'), `${JSON.stringify(OLD_BINDINGS, null, 2)}\n`, 'utf8');

  const app = mount(root);
  t.after(async () => {
    await cleanupRoot(root, app.disposers);
  });

  // 1) Status exposes exactly the three surviving bindings; the load did not throw.
  const status = await app.call('assistant_hotkeys', { action: 'status' });
  assert.equal(status.ok, true);
  assert.deepEqual(actions(Object.fromEntries(status.bindings.map((row) => [row.action, row.combo]))), KEPT);
  assert.equal(status.bindings.every((row) => row.valid === true), true);

  // 2) The stale file was rewritten without the retired keys, keeping the custom layerEdit.
  const saved = JSON.parse(await readFile(join(root, 'data', 'hotkeys.json'), 'utf8'));
  assert.deepEqual(actions(saved), KEPT);
  assert.equal(saved.layerEdit, 'Ctrl+Alt+Shift+E');
  assert.equal(saved.ptt, undefined);

  // 3) Exactly one cleanup event, naming the dropped actions.
  let pruned = null;
  for (let attempt = 0; attempt < 40 && pruned === null; attempt += 1) {
    const events = (await readFile(join(root, 'data', 'events.jsonl'), 'utf8').catch(() => ''))
      .trim()
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line));
    pruned = events.find((event) => event.type === 'hotkeys.pruned') ?? null;
    if (pruned === null) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(pruned !== null, 'hotkeys.pruned is recorded');
  assert.deepEqual([...pruned.payload.dropped].sort(), RETIRED);
  assert.equal(pruned.payload.source, 'data/hotkeys.json');

  // 4) A retired name is refused; a surviving one still rebinds.
  const refused = await app.call('assistant_hotkeys', { action: 'set', name: 'ptt', combo: 'Ctrl+Alt+T' });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /unknown hotkey name/u);

  const changed = await app.call('assistant_hotkeys', { action: 'set', name: 'mic', combo: 'Ctrl+Alt+Shift+M' });
  assert.equal(changed.ok, true);
  const afterSet = await app.call('assistant_hotkeys', { action: 'status' });
  assert.equal(afterSet.bindings.find((row) => row.action === 'mic')?.combo, 'Ctrl+Alt+Shift+M');
  assert.equal(afterSet.bindings.find((row) => row.action === 'vision')?.combo, 'Ctrl+Alt+V');
  assert.equal(afterSet.bindings.find((row) => row.action === 'layerEdit')?.combo, 'Ctrl+Alt+Shift+E');

  // 5) Reset returns the shipped four-key table.
  const reset = await app.call('assistant_hotkeys', { action: 'reset' });
  assert.equal(reset.ok, true);
  assert.deepEqual(actions(Object.fromEntries(reset.bindings.map((row) => [row.action, row.combo]))), KEPT);
  assert.equal(reset.bindings.find((row) => row.action === 'layerEdit')?.combo, 'Ctrl+Alt+E');
  assert.equal(reset.bindings.find((row) => row.action === 'ambient')?.combo, 'Ctrl+Alt+A');
});

test('a hotkeys.json written before layerEdit existed is filled from the default', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-assistant-hotkeys-'));
  await mkdir(join(root, 'data'), { recursive: true });
  await writeFile(
    join(root, 'data', 'hotkeys.json'),
    `${JSON.stringify({ mic: 'Ctrl+Alt+Shift+M', vision: 'Ctrl+Alt+V' }, null, 2)}\n`,
    'utf8',
  );

  const app = mount(root);
  t.after(async () => {
    await cleanupRoot(root, app.disposers);
  });

  const status = await app.call('assistant_hotkeys', { action: 'status' });
  assert.equal(status.ok, true);
  assert.deepEqual(actions(Object.fromEntries(status.bindings.map((row) => [row.action, row.combo]))), KEPT);
  assert.equal(status.bindings.find((row) => row.action === 'layerEdit')?.combo, 'Ctrl+Alt+E');
  assert.equal(status.bindings.find((row) => row.action === 'mic')?.combo, 'Ctrl+Alt+Shift+M');

  // The default is written back, while the custom mic binding is untouched.
  const saved = JSON.parse(await readFile(join(root, 'data', 'hotkeys.json'), 'utf8'));
  assert.equal(saved.layerEdit, 'Ctrl+Alt+E');
  assert.equal(saved.mic, 'Ctrl+Alt+Shift+M');
  assert.equal(saved.vision, 'Ctrl+Alt+V');
});
