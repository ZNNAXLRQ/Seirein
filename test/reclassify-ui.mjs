/**
 * 「重新分类」per-row UI: the preview lists every live entry with a default decision (noise →
 * delete, move → move, keep → unchecked), the user can change each row, and only the selected
 * rows are sent as `{moves, deletes}`. 「全部取消」 closes the list and writes nothing.
 *
 * The shipped card slice is evaluated with an injected recording `h` — no DOM and no React
 * (same technique as profile-ui.mjs). The host preview is also exercised against a temp SQLite DB,
 * so "cancel writes nothing" is proven on the library itself, not only on the handler wiring.
 *
 * Run: node --test test/reclassify-ui.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { DatabaseSync } from 'node:sqlite';

import { createProfileMaintainer } from '../src/host/profile/profileMaintain.js';
import { createProfileStore } from '../src/host/profile/profileStore.js';

const here = dirname(fileURLToPath(import.meta.url));
const clientSource = readFileSync(join(here, '..', 'client.js'), 'utf8');

// ---- fixture kit ---------------------------------------------------------------------------

const styles = new Proxy({}, { get: (_target, key) => ({ marker: String(key) }) });
const line = (label, value) => ({ type: 'line', props: { label, value }, children: [] });
const fmtTokens = (value) => {
  const n = Number(value ?? 0);
  return n >= 1e4 ? `${(n / 1e4).toFixed(1)} 万` : String(Math.round(n));
};
const h = (type, props, ...children) => ({ type, props: props ?? {}, children });

const walk = (node, visit) => {
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (typeof node !== 'object') return;
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
};
const collect = (tree, predicate) => {
  const found = [];
  walk(tree, (node) => {
    if (predicate(node)) found.push(node);
  });
  return found;
};
const textOf = (node) => {
  const parts = [];
  walk(node, (item) => {
    for (const child of item.children ?? []) {
      if (typeof child === 'string') parts.push(child);
    }
  });
  return parts.join(' ');
};

const loadProfileKit = () => {
  const from = clientSource.indexOf('    // ---- profile library (人设库)');
  const to = clientSource.indexOf('    function Panel() {', from);
  assert.ok(from > 0 && to > from, 'the shipped profile card helpers are found in client.js');
  const slice = clientSource.slice(from, to);
  return new Function(
    'styles', 'line', 'MUTED', 'ACCENT', 'BORDER', 'DANGER', 'fmtTokens',
    `${slice}\nreturn {
      profileSideLabel,
      profileReclassifyPreviewState,
      profileReclassifyApplyState,
      profileSettingsBody,
      reclassifyDefaultChoice,
      reclassifyChoices,
      reclassifyChoiceOptions,
      reclassifyMovesAndDeletes,
      reclassifySelectedCount,
    };`,
  )(styles, line, '#6b7280', '#3b5bdb', '#d8dce3', '#c92a2a', fmtTokens);
};

const handlers = (overrides = {}) => ({
  maintainNow: () => {},
  cancelMaintain: () => {},
  setAutoMaintain: () => {},
  setText: () => {},
  saveText: () => {},
  previewReclassify: () => {},
  applyReclassify: () => {},
  cancelReclassify: () => {},
  setReclassifyChoice: () => {},
  toggleCategory: () => {},
  startCategoryRename: () => {},
  setCategoryName: () => {},
  startCategoryMerge: () => {},
  setCategoryTarget: () => {},
  cancelCategoryEdit: () => {},
  submitCategoryRename: () => {},
  submitCategoryMerge: () => {},
  submitCategoryDelete: () => {},
  ...overrides,
});

const fixtureProfile = () => ({
  capacity: { used: 3, cap: 96 },
  autoMaintain: true,
  running: false,
  pending: { agent: false, user: false },
  lastRunAt: '2026-11-08T02:00:00.000Z',
  lastSummary: null,
  truncated: false,
  text: { agent: '妹系美少女角色', user: '用户会先安静地听完\n用户喜欢喝无糖茶' },
  entries: [],
});

/** The three preview rows: noise (library-only), move (in box), keep (in box). */
const fixtureItems = () => [
  {
    entryId: 'n1',
    text: '用户会频繁测试功能',
    side: 'user',
    category: '生活习惯',
    from: { side: 'user', category: '生活习惯' },
    to: null,
    inBox: false,
    kind: 'noise',
    suggested: 'delete',
    reason: 'test-behavior',
  },
  {
    entryId: 'm1',
    text: '用户会先安静地听完',
    side: 'user',
    category: '说话方式',
    from: { side: 'user', category: '说话方式' },
    to: { side: 'agent', category: '说话方式' },
    inBox: true,
    kind: 'normal',
    suggested: 'move',
    reason: '是助手的说话方式',
  },
  {
    entryId: 'k1',
    text: '用户喜欢喝无糖茶',
    side: 'user',
    category: '饮食',
    from: { side: 'user', category: '饮食' },
    to: { side: 'user', category: '饮食' },
    inBox: true,
    kind: 'normal',
    suggested: 'keep',
    reason: '',
  },
];

const render = (reclassify, customHandlers = handlers()) => {
  const kit = loadProfileKit();
  return {
    kit,
    tree: kit.profileSettingsBody(h, {
      profile: fixtureProfile(),
      busy: '',
      maintain: null,
      draft: null,
      reclassify,
      category: null,
      quiz: null,
    }, customHandlers),
  };
};

const buttonOf = (tree, action) => collect(tree, (node) => node.props['data-profile-action'] === action)[0];
const rowsOf = (tree) => collect(tree, (node) => node.props['data-profile-reclassify-row'] === true);

test('5.1) 默认勾选：noise→删除、move→移入、keep→不勾；框内/仅库与噪声标签', () => {
  const kit = loadProfileKit();
  const items = fixtureItems();
  const choices = kit.reclassifyChoices(items);
  const { tree } = render({
    open: true, busy: '', items, choices, version: 'v1', error: '', note: '',
  });
  // The shipped default helper builds exactly the state a preview result produces.
  const state = kit.profileReclassifyPreviewState({ ok: true, total: 3, items, version: 'v1' });
  assert.deepEqual(state.choices, { n1: 'delete', m1: 'move', k1: 'keep' });
  assert.equal(kit.reclassifySelectedCount(items, state.choices), 2);

  const rows = rowsOf(tree);
  assert.equal(rows.length, 3, 'every live entry has one row');
  const check = (id) => collect(tree, (node) => node.props['data-profile-reclassify-check'] === id)[0];
  assert.equal(check('n1').props.checked, true, 'noise is pre-checked for deletion');
  assert.equal(check('m1').props.checked, true, 'a move is pre-checked');
  assert.equal(check('k1').props.checked, false, 'keep is not checked');
  const choice = (id) => collect(tree, (node) => node.props['data-profile-reclassify-choice'] === id)[0];
  assert.equal(choice('n1').props.value, 'delete');
  assert.equal(choice('m1').props.value, 'move');
  assert.equal(choice('k1').props.value, 'keep');
  const optionsOf = (node) => collect(node, (item) => item.type === 'option').map((item) => textOf(item));
  assert.deepEqual(optionsOf(choice('n1')), ['删除', '保留']);
  assert.deepEqual(optionsOf(choice('m1')), ['移入 人设/说话方式', '保留', '删除']);

  const badges = collect(tree, (node) => node.props['data-profile-reclassify-inbox'] !== undefined);
  assert.deepEqual(badges.map((node) => textOf(node)), ['仅库', '框内', '框内']);
  assert.equal(collect(tree, (node) => node.props['data-profile-reclassify-noise'] === true).length, 1, 'only the noise row carries 噪声');
  assert.match(textOf(collect(tree, (node) => node.props['data-profile-reclassify'] === true)[0]), /建议删除 1 · 仅库 1/u);
  assert.equal(textOf(buttonOf(tree, 'reclassify-apply')), '应用选中（2）');
  assert.equal(textOf(buttonOf(tree, 'reclassify-cancel')), '全部取消');
  console.log(`5.1) rows=${rows.length} checked=${check('n1').props.checked}/${check('m1').props.checked}/${check('k1').props.checked} apply="${textOf(buttonOf(tree, 'reclassify-apply'))}"`);
});

test('5.2) 逐条选择：改变一行后选中数量与 {moves,deletes} 负载正确', () => {
  const kit = loadProfileKit();
  const items = fixtureItems();
  const defaults = kit.reclassifyChoices(items);
  assert.deepEqual(kit.reclassifyMovesAndDeletes(items, defaults), {
    moves: [{ id: 'm1', side: 'agent', category: '说话方式' }],
    deletes: ['n1'],
  });

  // Turn the keep row into a delete: the count becomes 3 and the payload carries it.
  const changed = { ...defaults, k1: 'delete' };
  assert.equal(kit.reclassifySelectedCount(items, changed), 3);
  assert.deepEqual(kit.reclassifyMovesAndDeletes(items, changed).deletes.sort(), ['k1', 'n1']);

  // The select/checkbox handlers report the clicked row id + decision to the Panel.
  const calls = [];
  const { tree } = render({
    open: true, busy: '', items, choices: defaults, version: 'v1', error: '', note: '',
  }, handlers({ setReclassifyChoice: (entryId, choice) => calls.push([entryId, choice]) }));
  const select = collect(tree, (node) => node.props['data-profile-reclassify-choice'] === 'm1')[0];
  select.props.onChange({ target: { value: 'keep' } });
  const checkbox = collect(tree, (node) => node.props['data-profile-reclassify-check'] === 'k1')[0];
  checkbox.props.onChange({ target: { checked: true } });
  checkbox.props.onChange({ target: { checked: false } });
  assert.deepEqual(calls, [['m1', 'keep'], ['k1', 'delete'], ['k1', 'keep']]);

  // selected=0 disables the apply button (nothing to send).
  const none = render({
    open: true, busy: '', items, choices: { n1: 'keep', m1: 'keep', k1: 'keep' }, version: 'v1', error: '', note: '',
  }).tree;
  assert.equal(textOf(buttonOf(none, 'reclassify-apply')), '应用选中（0）');
  assert.equal(buttonOf(none, 'reclassify-apply').props.disabled, true);
  console.log(`5.2) default=${JSON.stringify(defaults)} changedSelected=${kit.reclassifySelectedCount(items, changed)} calls=${JSON.stringify(calls)}`);
});

test('5.3) 「全部取消」只关闭列表：不调用应用、宿主预览不写库', async (t) => {
  const calls = [];
  const { tree } = render({
    open: true, busy: '', items: fixtureItems(), choices: loadProfileKit().reclassifyChoices(fixtureItems()), version: 'v1', error: '', note: '',
  }, handlers({
    applyReclassify: () => calls.push('apply'),
    cancelReclassify: () => calls.push('cancel'),
  }));
  buttonOf(tree, 'reclassify-cancel').props.onClick();
  assert.deepEqual(calls, ['cancel'], 'cancel never goes through apply');

  const root = await mkdtemp(join(tmpdir(), 'dsh-reclassify-ui-'));
  const db = new DatabaseSync(join(root, 'profile.db'));
  const profile = createProfileStore({ db });
  t.after(async () => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });
  const noisy = profile.upsert({ side: 'user', category: '生活习惯', text: '用户会频繁测试功能' }).entry;
  const normal = profile.upsert({ side: 'user', category: '饮食', text: '用户喜欢喝无糖茶' }).entry;
  const maintainer = createProfileMaintainer({
    profile,
    db,
    now: () => new Date('2026-11-08T10:00:00.000Z'),
    emit: () => {},
    readMessages: () => [],
    extract: async () => ({ candidates: [] }),
    reclassify: async () => ({ changes: [] }),
    config: { intervalDays: 7, queuePollMs: 20 },
  });
  const before = profile.list().map((entry) => ({ ...entry }));
  const plan = await maintainer.previewReclassify();
  assert.equal(plan.items.length, 2);
  // Cancel = the preview is discarded, not applied: the library and revisions are untouched.
  const after = profile.list().map((entry) => ({ ...entry }));
  assert.deepEqual(after, before, 'cancel/a preview writes no entry');
  assert.equal(profile.revision(noisy.id).length, 0);
  assert.equal(profile.revision(normal.id).length, 0);
  console.log(`5.3) previewItems=${plan.items.length} entriesBefore=${before.length} entriesAfter=${after.length} revisions=0`);
});

test('5.4) 应用结果状态：moved/deleted 计数与版本冲突提示', () => {
  const kit = loadProfileKit();
  const applied = kit.profileReclassifyApplyState({ ok: true, moved: 1, deleted: 1, skipped: 0 });
  assert.equal(applied.open, false);
  assert.equal(applied.note, '已应用：移入 1 条，删除 1 条');
  assert.equal(applied.moved, 1);
  assert.equal(applied.deleted, 1);
  const conflict = kit.profileReclassifyApplyState({ ok: false, aborted: true, reason: 'version-conflict', moved: 0, deleted: 0 });
  assert.equal(conflict.note, '库已变化，请重新预览');
  console.log(`5.4) applied="${applied.note}" conflict="${conflict.note}"`);
});
