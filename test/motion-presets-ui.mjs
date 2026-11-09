/**
 * 动作预设设置页 v1 + 用户覆盖持久化。
 *
 * 只读 `presets/`，不改 `motion-controller.js` / `avatarRuntime.js`：本测试验证
 *   1) 宿主 motion.presets.list 的 320 条/22 家族与字段；
 *   2) client.js 真实发货的搜索/家族/风格/可用性过滤；
 *   3) 动作启停 → disabled 写入/移除，且 selector 真的遵守；
 *   4) 家族启停/优先级写入与重新读取；
 *   5) 优先级 0–100 夹紧；
 *   6) 单条/家族/全局恢复默认；
 *   7) 坏 JSON → 默认值 + motion.presets.corrupt；
 *   8) 能力缺失 / 需要目标 / 需要方向的只读原因；隐私不再锁定动作；
 *   9) UI 控件（搜索框、三个过滤、启停、优先级、恢复默认、待接线预览）；
 *  10) 预设库与选择器契约回归（motion-preset-library / preset-selector / smoke 另行执行）。
 *
 * Run: node --test test/motion-presets-ui.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { OPERATIONS, PRESETS, RECIPES, STYLES } from '../src/host/avatar/presets/index.js';
import { createPresetSelector } from '../src/host/avatar/preset-selector.js';
import {
  createAvatarSettingsActions,
  createDefaultMotionPresetOverrides,
  createMotionPresetOverridesStore,
} from '../src/host/avatar/settings-actions.js';

const here = dirname(fileURLToPath(import.meta.url));
const FULL_CHANNELS = Object.freeze([...new Set(Object.values(OPERATIONS).flat())]);
const ACTION_ID = 'idle-side.flow';
const FAMILY_ID = 'posture';

// ---------------------------------------------------------------------------------------------
// Host harness: real store + real settings action handler, temp root per test.
// ---------------------------------------------------------------------------------------------

const makeEnv = (overrides = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'seirein-motion-presets-'));
  mkdirSync(join(root, 'data'), { recursive: true });
  const file = join(root, 'data', 'motion-presets.json');
  const events = [];
  const log = {
    emit: (type, payload) => {
      events.push({ type, payload });
      return Promise.resolve();
    },
  };
  const store = createMotionPresetOverridesStore({ file, log });
  const services = {
    motionPresetStore: store,
    log,
    avatarCapabilitiesStatus: () => ({ verified: FULL_CHANNELS }),
    avatarMotionLockReasons: [],
    vision: { mode: 'watch' },
    ...overrides,
  };
  return {
    root,
    file,
    events,
    store,
    services,
    handler: createAvatarSettingsActions(services),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
    readFile: () => JSON.parse(readFileSync(file, 'utf8')),
    corruptEvents: () => events.filter(event => event.type === 'motion.presets.corrupt'),
    changedEvents: () => events.filter(event => event.type === 'motion.presets.changed'),
  };
};

// ---------------------------------------------------------------------------------------------
// UI harness: the shipped `motionPresetSection` extracted from client.js, evaluated with a
// recording `h` — no DOM, no React, no host (same pattern as test/layer-edit-buttons.mjs).
// ---------------------------------------------------------------------------------------------

const clientSource = readFileSync(join(here, '..', 'client.js'), 'utf8');
const sectionFrom = clientSource.indexOf('    function motionPresetSection(');
const sectionTo = clientSource.indexOf('    function Panel() {');
assert.ok(sectionFrom > 0 && sectionTo > sectionFrom, 'client.js still ships motionPresetSection before Panel');
const styles = new Proxy({}, { get: (_target, key) => ({ marker: String(key) }) });
const motionPresetSection = new Function(
  'styles',
  'BORDER',
  'DANGER',
  `${clientSource.slice(sectionFrom, sectionTo)}\nreturn motionPresetSection;`,
)(styles, '#d8dce3', '#c92a2a');

const h = (type, props, ...children) => ({ type, props: props ?? {}, children });

const walk = (node, visit) => {
  if (node === null || node === undefined || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
};

const collect = (tree) => {
  const nodes = [];
  walk(tree, node => nodes.push(node));
  return nodes;
};

const textOf = (node) => {
  const texts = [];
  walk(node, (entry) => {
    for (const child of entry.children ?? []) if (typeof child === 'string') texts.push(child);
  });
  return texts.join(' ');
};

const buttonOf = (root, label) => collect(root).find(
  node => node.type === 'button' && textOf(node) === label,
);

const familyBlockOf = (tree, family) => collect(tree).find(node => (
  node.props?.['data-family'] === family
  && collect(node).some(entry => entry.type === 'button' && textOf(entry) === '禁用家族')
));

const makeHandlers = () => {
  const calls = { override: [], reset: [], drafts: [], filters: [], queries: [], refreshes: 0 };
  return {
    calls,
    handlers: {
      setQuery: (value) => calls.queries.push(value),
      setFilter: (key, value) => calls.filters.push([key, value]),
      setDraft: (key, value) => calls.drafts.push([key, value]),
      override: async (body) => { calls.override.push(body); return { ok: true }; },
      reset: async (body) => { calls.reset.push(body); return { ok: true }; },
      refresh: () => { calls.refreshes += 1; },
    },
  };
};

const renderSection = (data, over = {}) => {
  const { handlers } = makeHandlers();
  const tree = motionPresetSection(h, {
    data,
    query: '',
    filters: { family: '', style: '', availability: '' },
    drafts: {},
    busy: '',
    ...over,
  }, over.handlers ?? handlers);
  return tree;
};

// ---------------------------------------------------------------------------------------------
// 1. List: 320 actions, 22 families, grouping and required fields
// ---------------------------------------------------------------------------------------------
test('1. 列表返回 320 条、22 个家族，按家族分组且字段完整', async (t) => {
  const env = makeEnv();
  t.after(env.cleanup);
  const result = await env.handler({ action: 'motion.presets.list' });
  assert.equal(result.ok, true);
  assert.equal(result.items.length, 320);
  assert.equal(result.families.length, 22);
  assert.equal(result.items.length, PRESETS.length);

  const expected = new Map();
  for (const preset of PRESETS) expected.set(preset.family, (expected.get(preset.family) ?? 0) + 1);
  assert.equal(result.families.reduce((sum, family) => sum + family.count, 0), 320);
  for (const family of result.families) {
    assert.equal(family.count, expected.get(family.family), family.family);
    assert.equal(family.enabled, true);
    assert.equal(family.priority, 50);
    assert.ok(typeof family.label === 'string' && family.label.length > 0);
  }
  assert.deepEqual(
    Object.fromEntries(result.items.map(item => [item.family, 0])),
    Object.fromEntries([...expected.keys()].map(family => [family, 0])),
  );

  const item = result.items.find(entry => entry.presetId === ACTION_ID);
  assert.ok(item !== undefined);
  assert.equal(item.family, 'attention');
  assert.equal(item.recipe, 'idle-side');
  assert.equal(item.variant, 'flow');
  assert.equal(item.name, '侧看后停留 · 连贯接续');
  // Intentional recipe coverage (commit "tired 覆盖"): these actions now also apply while tired,
  // so the settings row truthfully names the third state. The selector-only settle metadata
  // (settle / offsetThreshold / settleChannels) is internal and must not leak into the row.
  assert.deepEqual(item.states, ['idle', 'waiting', 'tired']);
  assert.deepEqual(item.stateLabels, ['待机', '等待', '疲倦']);
  for (const internal of ['settle', 'offsetThreshold', 'settleChannels']) {
    assert.equal(Object.hasOwn(item, internal), false, `settings row must not expose ${internal}`);
  }
  assert.deepEqual(item.events, ['idle']);
  assert.deepEqual(item.eventLabels, ['空闲']);
  assert.deepEqual(item.styles, ['reserved', 'composed', 'cool']);
  assert.deepEqual(item.styleLabels, ['内敛', '沉稳', '清冷']);
  assert.deepEqual(item.requires, ['headX']);
  assert.equal(typeof item.available, 'boolean');
  assert.equal(typeof item.reason, 'string');
  assert.equal(result.overrides.version, 1);
});

// ---------------------------------------------------------------------------------------------
// 2. Search / family / style / availability filters (real shipped UI logic)
// ---------------------------------------------------------------------------------------------
test('2. 搜索与家族/风格/可用性过滤只保留匹配项', async (t) => {
  const env = makeEnv();
  t.after(env.cleanup);
  const list = await env.handler({
    action: 'motion.presets.list',
    targetVerified: true,
    directionVerified: true,
  });
  const rowsOf = tree => collect(tree).filter(node => typeof node.props?.['data-preset-id'] === 'string');

  const searched = rowsOf(renderSection(list, { query: '眨眼' }));
  assert.ok(searched.length > 0 && searched.length < 320, `search hits ${searched.length}`);
  assert.ok(searched.every(row => textOf(row).includes('眨眼')));

  const byFamily = rowsOf(renderSection(list, { filters: { family: 'blink', style: '', availability: '' } }));
  assert.equal(byFamily.length, 16);
  assert.ok(byFamily.every(row => row.props['data-family'] === 'blink'));

  const byStyle = rowsOf(renderSection(list, { filters: { family: '', style: 'dreamy', availability: '' } }));
  assert.ok(byStyle.length > 0);
  assert.ok(byStyle.every(row => row.props['data-styles'].split(',').includes('dreamy')));

  const allAvailable = rowsOf(renderSection(list, { filters: { family: '', style: '', availability: 'available' } }));
  assert.equal(allAvailable.length, 320);
  assert.ok(allAvailable.every(row => row.props['data-available'] === '1'));

  const unproved = await env.handler({ action: 'motion.presets.list' });
  const unavailable = unproved.items.filter(item => item.available === false).length;
  assert.ok(unavailable > 0);
  const onlyUnavailable = rowsOf(renderSection(unproved, { filters: { family: '', style: '', availability: 'unavailable' } }));
  assert.equal(onlyUnavailable.length, unavailable);
  assert.ok(onlyUnavailable.every(row => row.props['data-available'] === '0'));
  assert.ok(onlyUnavailable.every(row => textOf(row).includes('不可用原因')));
});

// ---------------------------------------------------------------------------------------------
// 3. Action disable → disabled[]; re-enable removes it; selector obeys
// ---------------------------------------------------------------------------------------------
test('3. 禁用动作写入 disabled，重新启用移除，selector 遵守覆盖', async (t) => {
  const env = makeEnv();
  t.after(env.cleanup);

  let result = await env.handler({
    action: 'motion.presets.override', kind: 'action', id: ACTION_ID, enabled: false,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.overrides.disabled, [ACTION_ID]);
  assert.deepEqual(env.readFile(), {
    version: 1,
    disabled: [ACTION_ID],
    disabledFamilies: [],
    familyPriority: {},
    actionPriority: {},
  });
  assert.equal(env.changedEvents().length, 1);
  assert.deepEqual(env.changedEvents()[0].payload, {
    kind: 'action', id: ACTION_ID, enabled: false, priority: 50,
  });

  const selector = createPresetSelector({ overrides: result.overrides });
  const eligible = selector.query({ state: 'idle', event: 'idle', verifiedChannels: FULL_CHANNELS });
  assert.ok(!eligible.some(preset => preset.id === ACTION_ID));

  result = await env.handler({
    action: 'motion.presets.override', kind: 'action', id: ACTION_ID, enabled: true,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.overrides.disabled, []);
  const after = createPresetSelector({ overrides: result.overrides })
    .query({ state: 'idle', event: 'idle', verifiedChannels: FULL_CHANNELS });
  assert.ok(after.some(preset => preset.id === ACTION_ID));
});

// ---------------------------------------------------------------------------------------------
// 4. Family disable / priority are written, listed and re-read from disk
// ---------------------------------------------------------------------------------------------
test('4. 家族禁用与优先级写入、读取并跨实例持久化', async (t) => {
  const env = makeEnv();
  t.after(env.cleanup);

  let result = await env.handler({
    action: 'motion.presets.override', kind: 'family', id: FAMILY_ID, enabled: false, priority: 80,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.overrides.disabledFamilies, [FAMILY_ID]);
  assert.equal(result.overrides.familyPriority[FAMILY_ID], 80);
  assert.equal(env.readFile().familyPriority[FAMILY_ID], 80);

  const listed = await env.handler({ action: 'motion.presets.list' });
  const posture = listed.families.find(family => family.family === FAMILY_ID);
  assert.equal(posture.enabled, false);
  assert.equal(posture.priority, 80);
  assert.equal(listed.items.filter(item => item.family === FAMILY_ID).length, posture.count);

  // A fresh store over the same file sees the persisted overrides (upgrade-safe data path).
  const reopened = createMotionPresetOverridesStore({ file: env.file });
  assert.deepEqual(reopened.read(), result.overrides);

  // The selector's family overrides have the same shape the store persists.
  const selector = createPresetSelector({ overrides: reopened.read() });
  const query = selector.query({ state: 'idle', event: 'idle', verifiedChannels: FULL_CHANNELS });
  assert.ok(query.every(preset => preset.family !== FAMILY_ID));
  assert.equal(selector.overrides.familyPriority.get(FAMILY_ID), 80);

  result = await env.handler({
    action: 'motion.presets.override', kind: 'family', id: FAMILY_ID, enabled: true,
  });
  assert.deepEqual(result.overrides.disabledFamilies, []);
});

// ---------------------------------------------------------------------------------------------
// 5. Priority clamping and validation
// ---------------------------------------------------------------------------------------------
test('5. 优先级越界夹紧到 0–100，非法值被拒绝', async (t) => {
  const env = makeEnv();
  t.after(env.cleanup);

  let result = await env.handler({
    action: 'motion.presets.override', kind: 'action', id: ACTION_ID, priority: -20,
  });
  assert.equal(result.ok, true);
  assert.equal(result.overrides.actionPriority[ACTION_ID], 0);

  result = await env.handler({
    action: 'motion.presets.override', kind: 'action', id: ACTION_ID, priority: 250,
  });
  assert.equal(result.overrides.actionPriority[ACTION_ID], 100);

  result = await env.handler({
    action: 'motion.presets.override', kind: 'family', id: FAMILY_ID, priority: 99.6,
  });
  assert.equal(result.overrides.familyPriority[FAMILY_ID], 100);

  result = await env.handler({
    action: 'motion.presets.override', kind: 'family', id: FAMILY_ID, priority: 'not-a-number',
  });
  assert.equal(result.ok, false);
  assert.equal(result.overrides, undefined);
  assert.deepEqual(env.readFile().familyPriority, { [FAMILY_ID]: 100 });

  assert.equal(env.readFile().actionPriority[ACTION_ID], 100);
});

// ---------------------------------------------------------------------------------------------
// 6. Reset: one action, one family, all
// ---------------------------------------------------------------------------------------------
test('6. 单条、家族与全局恢复默认都会清空对应覆盖', async (t) => {
  const env = makeEnv();
  t.after(env.cleanup);

  await env.handler({ action: 'motion.presets.override', kind: 'action', id: ACTION_ID, enabled: false, priority: 90 });
  await env.handler({ action: 'motion.presets.override', kind: 'family', id: FAMILY_ID, enabled: false, priority: 20 });

  let result = await env.handler({ action: 'motion.presets.reset', kind: 'action', id: ACTION_ID });
  assert.equal(result.ok, true);
  assert.deepEqual(result.overrides.disabled, []);
  assert.deepEqual(result.overrides.actionPriority, {});
  assert.deepEqual(result.overrides.disabledFamilies, [FAMILY_ID]);
  assert.equal(result.overrides.familyPriority[FAMILY_ID], 20);

  result = await env.handler({ action: 'motion.presets.reset', kind: 'family', id: FAMILY_ID });
  assert.deepEqual(result.overrides.disabledFamilies, []);
  assert.deepEqual(result.overrides.familyPriority, {});

  await env.handler({ action: 'motion.presets.override', kind: 'action', id: 'idle-tilt.flow', enabled: false, priority: 10 });
  await env.handler({ action: 'motion.presets.override', kind: 'family', id: 'thought', priority: 70 });
  result = await env.handler({ action: 'motion.presets.reset', all: true });
  assert.equal(result.ok, true);
  assert.deepEqual(result.overrides, createDefaultMotionPresetOverrides());
  assert.deepEqual(env.readFile(), createDefaultMotionPresetOverrides());
});

// ---------------------------------------------------------------------------------------------
// 7. Corrupt file → defaults + one event, without breaking the next read
// ---------------------------------------------------------------------------------------------
test('7. 坏 JSON 回退默认并记录 motion.presets.corrupt', async (t) => {
  const env = makeEnv();
  t.after(env.cleanup);

  assert.deepEqual(env.store.read(), createDefaultMotionPresetOverrides());
  assert.equal(env.corruptEvents().length, 0, 'a missing file is not corruption');

  writeFileSync(env.file, '{ this is not json', 'utf8');
  const events = [];
  const store = createMotionPresetOverridesStore({
    file: env.file,
    log: { emit: (type, payload) => { events.push({ type, payload }); return Promise.resolve(); } },
  });
  assert.deepEqual(store.read(), createDefaultMotionPresetOverrides());
  assert.equal(events.filter(event => event.type === 'motion.presets.corrupt').length, 1);
  assert.equal(events[0].payload.file, env.file);
  store.read();
  assert.equal(events.filter(event => event.type === 'motion.presets.corrupt').length, 1, 'one event per bad content');

  writeFileSync(env.file, JSON.stringify({ version: 1, disabled: 'nope', disabledFamilies: [], familyPriority: {}, actionPriority: {} }), 'utf8');
  assert.deepEqual(store.read(), createDefaultMotionPresetOverrides());
  assert.equal(events.filter(event => event.type === 'motion.presets.corrupt').length, 2);

  // A valid file recovers; a later corrupt file is reported again.
  store.write(createDefaultMotionPresetOverrides());
  assert.deepEqual(store.read(), createDefaultMotionPresetOverrides());
  writeFileSync(env.file, '[]', 'utf8');
  assert.deepEqual(store.read(), createDefaultMotionPresetOverrides());
  assert.equal(events.filter(event => event.type === 'motion.presets.corrupt').length, 3);
});

// ---------------------------------------------------------------------------------------------
// 8. Unavailable reasons are read-only: capability / target / direction; privacy locks capture only
// ---------------------------------------------------------------------------------------------
test('8. 不可用原因：能力缺失、需要目标、需要方向；隐私不锁定动作', async (t) => {
  const capabilityEnv = makeEnv({ avatarCapabilitiesStatus: () => ({ verified: ['headX'] }) });
  const targetEnv = makeEnv();
  const directionEnv = makeEnv();
  const privacyEnv = makeEnv({ avatarMotionLockReasons: ['privacy'], vision: { mode: 'privacy' } });
  t.after(() => {
    capabilityEnv.cleanup();
    targetEnv.cleanup();
    directionEnv.cleanup();
    privacyEnv.cleanup();
  });

  const capability = await capabilityEnv.handler({ action: 'motion.presets.list' });
  const gazeItem = capability.items.find(item => item.presetId === 'idle-eye-side.flow');
  assert.equal(gazeItem.available, false);
  assert.match(gazeItem.reason, /能力未验证/);
  assert.match(gazeItem.reason, /gazeX/);

  const target = await targetEnv.handler({ action: 'motion.presets.list' });
  const targetItem = target.items.find(item => item.presetId === 'idle-look-back.flow');
  assert.equal(targetItem.requiresTarget, true);
  assert.equal(targetItem.available, false);
  assert.match(targetItem.reason, /需要目标/);
  const targetProved = await targetEnv.handler({ action: 'motion.presets.list', targetVerified: true });
  assert.equal(targetProved.items.find(item => item.presetId === 'idle-look-back.flow').available, true);

  const direction = await directionEnv.handler({ action: 'motion.presets.list' });
  const directionItem = direction.items.find(item => item.presetId === 'listen-turn.flow');
  assert.equal(directionItem.available, false);
  assert.match(directionItem.reason, /需要方向/);

  const privacy = await privacyEnv.handler({ action: 'motion.presets.list', privacy: true });
  assert.equal(privacy.locked, false, 'privacy is not a motion lock');
  assert.deepEqual(privacy.lockReasons, []);
  assert.ok(privacy.items.every(item => !item.reason.includes('隐私锁定')));
  assert.ok(privacy.items.filter(item => item.requiresTarget).every(item => item.available === false));
  assert.ok(privacy.items.filter(item => item.requiresTarget).every(item => item.reason.includes('需要目标')));

  // The same reason reaches the row as read-only text (no button changes it).
  const tree = renderSection(direction);
  const row = collect(tree).find(node => node.props?.['data-preset-id'] === 'listen-turn.flow');
  assert.ok(row !== undefined);
  assert.match(textOf(row), /不可用原因：.*需要方向/);
});

// ---------------------------------------------------------------------------------------------
// 9. UI controls: search, three filters, toggles, priority, reset, preview
// ---------------------------------------------------------------------------------------------
test('9. UI 控件：搜索框、三个过滤、启停、优先级、恢复默认、待接线预览', async (t) => {
  const env = makeEnv();
  t.after(env.cleanup);
  const list = await env.handler({ action: 'motion.presets.list', targetVerified: true, directionVerified: true });

  const { calls, handlers } = makeHandlers();
  const tree = motionPresetSection(h, {
    data: list,
    query: '',
    filters: { family: '', style: '', availability: '' },
    drafts: {},
    busy: '',
  }, handlers);

  // Search input drives onQuery; the three selects drive onFilter.
  const search = collect(tree).find(node => node.type === 'input' && String(node.props.placeholder ?? '').includes('搜索'));
  assert.ok(search !== undefined);
  search.props.onChange({ target: { value: '偏头' } });
  assert.deepEqual(calls.queries, ['偏头']);

  const selects = collect(tree).filter(node => node.type === 'select');
  assert.equal(selects.length, 3);
  assert.deepEqual(selects.map(node => node.props.title), ['按家族过滤', '按风格过滤', '按可用性过滤']);
  selects[0].props.onChange({ target: { value: 'posture' } });
  selects[1].props.onChange({ target: { value: 'gentle' } });
  selects[2].props.onChange({ target: { value: 'unavailable' } });
  assert.deepEqual(calls.filters, [['family', 'posture'], ['style', 'gentle'], ['availability', 'unavailable']]);

  // Action-level disable button → override(action, enabled:false).
  const row = collect(tree).find(node => node.props?.['data-preset-id'] === ACTION_ID);
  assert.ok(row !== undefined);
  assert.equal(buttonOf(row, '禁用').props.disabled, false);
  await buttonOf(row, '禁用').props.onClick();
  assert.deepEqual(calls.override.at(-1), { kind: 'action', id: ACTION_ID, enabled: false });

  // Priority input is controlled by value + draft, commits on blur.
  const priorityInput = collect(row).find(node => node.type === 'input' && node.props.type === 'number');
  assert.equal(priorityInput.props.value, '50');
  priorityInput.props.onChange({ target: { value: '77' } });
  assert.deepEqual(calls.drafts.at(-1), [`action:${ACTION_ID}`, '77']);
  await priorityInput.props.onBlur({ target: { value: '77' } });
  assert.deepEqual(calls.override.at(-1), { kind: 'action', id: ACTION_ID, priority: 77 });

  // Per-row reset and global reset.
  await buttonOf(row, '恢复默认').props.onClick();
  assert.deepEqual(calls.reset.at(-1), { kind: 'action', id: ACTION_ID });
  await buttonOf(tree, '全部恢复默认').props.onClick();
  assert.deepEqual(calls.reset.at(-1), { all: true });

  // Family-level toggle and reset.
  const family = familyBlockOf(tree, FAMILY_ID);
  assert.ok(family !== undefined);
  await buttonOf(family, '禁用家族').props.onClick();
  assert.deepEqual(calls.override.at(-1), { kind: 'family', id: FAMILY_ID, enabled: false });
  await buttonOf(family, '恢复该家族默认').props.onClick();
  assert.deepEqual(calls.reset.at(-1), { kind: 'family', id: FAMILY_ID });

  // Preview stays disabled until the controller wiring lands.
  const preview = buttonOf(tree, '预览（待接线）');
  assert.ok(preview !== undefined);
  assert.equal(preview.props.disabled, true);
  assert.match(String(preview.props.title), /待接线/);
  assert.equal(buttonOf(tree, '刷新').props.disabled, false);
});

// ---------------------------------------------------------------------------------------------
// 10. Regression contract for the read-only library and selector
// ---------------------------------------------------------------------------------------------
test('10. 回归：320 条/80 配方/16 风格与 selector 抽样不变', () => {
  assert.equal(PRESETS.length, 320);
  assert.equal(RECIPES.length, 80);
  assert.equal(STYLES.length, 16);
  assert.equal(new Set(PRESETS.map(preset => preset.family)).size, 22);
  assert.equal(new Set(PRESETS.map(preset => preset.id)).size, 320);

  const selector = createPresetSelector();
  const result = selector.select({
    state: 'idle',
    event: 'idle',
    verifiedChannels: FULL_CHANNELS,
    seed: 7,
  });
  assert.equal(result.kind, 'preset');
  assert.ok(result.probability > 0 && result.probability < 1);
  assert.equal(selector.stats().presets, 320);
  assert.equal(selector.stats().recipes, 80);
  assert.equal(selector.stats().styles, 16);
});
