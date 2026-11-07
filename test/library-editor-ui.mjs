/**
 * 「库编辑」entry UI: the settings card's replacement for the old 「重新分类」 preview button.
 *
 * Every list row edits the library itself (库=存), never the two text boxes (框=用):
 *   - text input: 保存 or Enter writes only the entry text;
 *   - category button: an inline popup grouped by parent (人设侧/画像侧), the current category is
 *     highlighted, and closing it / clicking the current item writes nothing;
 *   - 删除 asks for a second confirmation before the host call;
 *   - the row ends with a 框内/仅库 mark, so a library-only row is visibly filtered out of the box.
 * The 「分类管理」 panel also gains 新建分类 (name + parent select).
 *
 * The shipped card slice is evaluated with an injected recording `h` — no DOM and no React
 * (same technique as profile-ui.mjs / reclassify-ui.mjs).
 *
 * Run: node --test test/library-editor-ui.mjs
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
      profileSettingsBody,
      profileLibraryBody,
      profileLibraryPicker,
      profileLibraryPickerGroups,
      profileLibraryErrorText,
      profileCategoryKey,
      profileCategoryBody,
      profileCategoryResultState,
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
  openLibrary: () => {},
  setLibraryText: () => {},
  saveLibraryText: () => {},
  toggleLibraryPicker: () => {},
  closeLibraryPicker: () => {},
  chooseLibraryCategory: () => {},
  requestDeleteLibraryEntry: () => {},
  cancelDeleteLibraryEntry: () => {},
  confirmDeleteLibraryEntry: () => {},
  toggleCategory: () => {},
  startCategoryRename: () => {},
  setCategoryName: () => {},
  startCategoryMerge: () => {},
  setCategoryTarget: () => {},
  cancelCategoryEdit: () => {},
  submitCategoryRename: () => {},
  submitCategoryMerge: () => {},
  submitCategoryDelete: () => {},
  setCategoryCreateName: () => {},
  setCategoryCreateParent: () => {},
  submitCategoryCreate: () => {},
  ...overrides,
});

const fixtureProfile = () => ({
  capacity: { used: 2, cap: 96 },
  autoMaintain: true,
  running: false,
  pending: { agent: false, user: false },
  lastRunAt: '2026-11-08T02:00:00.000Z',
  lastSummary: null,
  truncated: false,
  text: { agent: '你是一名妹系角色', user: '用户喜欢喝无糖茶' },
  entries: [],
});

const fixtureCategories = () => [
  { name: '形象', parent: 'agent', count: 1, source: 'preset' },
  { name: '说话方式', parent: 'agent', count: 0, source: 'preset' },
  { name: '饮食', parent: 'user', count: 1, source: 'preset' },
  { name: '娱乐', parent: 'user', count: 0, source: 'preset' },
];

const fixtureRows = () => [
  { id: 'e1', text: '用户喜欢喝无糖茶', side: 'user', category: '饮食', inBox: true },
  { id: 'e2', text: '用户会频繁测试功能', side: 'user', category: '生活习惯', inBox: false },
];

const libraryState = (overrides = {}) => ({
  open: true,
  busy: '',
  rows: fixtureRows(),
  categories: fixtureCategories(),
  drafts: {},
  picker: '',
  confirmDelete: '',
  error: '',
  note: '',
  ...overrides,
});

const render = (library, state = {}, customHandlers = handlers()) => {
  const kit = loadProfileKit();
  return {
    kit,
    tree: kit.profileSettingsBody(h, {
      profile: fixtureProfile(),
      busy: '',
      maintain: null,
      draft: null,
      reclassify: null,
      library,
      category: state.category ?? null,
      quiz: null,
      ...state,
    }, customHandlers),
  };
};

const buttonOf = (tree, action) => collect(tree, (node) => node.props['data-profile-action'] === action)[0];
const libraryButtonOf = (tree, action) => collect(tree, (node) => node.props['data-profile-library-action'] === action)[0];
const rowOf = (tree, id) => collect(tree, (node) => node.props['data-profile-library-row'] === id)[0];
const inputOf = (tree, id) => collect(tree, (node) => node.props['data-profile-library-input'] === id)[0];

// ---- 8.1 entry point + rows ----------------------------------------------------------------

test('8.1) 「库编辑」入口取代「重新分类」，每行有文本/分类/删除与框内/仅库', () => {
  const calls = [];
  const { tree } = render(libraryState(), {}, handlers({ openLibrary: () => calls.push('open') }));
  const button = buttonOf(tree, 'library');
  assert.ok(button, 'the card has the 库编辑 button');
  assert.equal(textOf(button), '库编辑');
  assert.equal(buttonOf(tree, 'reclassify'), undefined, 'the old 重新分类 button is gone from the shipped state');
  button.props.onClick();
  assert.deepEqual(calls, ['open']);
  // A legacy card state without the library object still renders the old button (compat).
  assert.equal(textOf(buttonOf(render(undefined).tree, 'reclassify')), '重新分类');

  const rows = collect(tree, (node) => node.props['data-profile-library-row'] !== undefined);
  assert.equal(rows.length, 2, 'one row per entry');
  assert.equal(inputOf(tree, 'e1').props.value, '用户喜欢喝无糖茶');
  assert.equal(collect(tree, (node) => node.props['data-profile-library-inbox'] === 'in').length, 1);
  assert.equal(collect(tree, (node) => node.props['data-profile-library-inbox'] === 'library').length, 1);
  assert.equal(textOf(collect(tree, (node) => node.props['data-profile-library-inbox'] === 'in')[0]), '框内');
  assert.equal(textOf(collect(tree, (node) => node.props['data-profile-library-inbox'] === 'library')[0]), '仅库');
  assert.ok(libraryButtonOf(tree, 'category'));
  assert.ok(libraryButtonOf(tree, 'delete'));
  console.log(`8.1) button="${textOf(button)}" rows=${rows.length} inbox=${collect(tree, (node) => node.props['data-profile-library-inbox'] === 'in').length}/${collect(tree, (node) => node.props['data-profile-library-inbox'] === 'library').length}`);
});

// ---- 8.2 text edit: save / Enter -----------------------------------------------------------

test('8.2) 行内文本：保存按钮与 Enter 写入，未改动时保存禁用', () => {
  const calls = [];
  const { tree } = render(libraryState(), {}, handlers({
    setLibraryText: (id, value) => calls.push(['set', id, value]),
    saveLibraryText: (id) => calls.push(['save', id]),
  }));
  const input = inputOf(tree, 'e1');
  input.props.onChange({ target: { value: '用户只喝无糖茶' } });
  assert.deepEqual(calls, [['set', 'e1', '用户只喝无糖茶']]);
  assert.equal(libraryButtonOf(rowOf(tree, 'e1'), 'save').props.disabled, true, 'nothing changed yet');
  assert.equal(libraryButtonOf(rowOf(tree, 'e2'), 'save').props.disabled, true);

  const dirty = render(libraryState({ drafts: { e1: '用户只喝无糖茶' } }), {}, handlers({
    saveLibraryText: (id) => calls.push(['save-dirty', id]),
  })).tree;
  assert.equal(libraryButtonOf(rowOf(dirty, 'e1'), 'save').props.disabled, false);
  libraryButtonOf(rowOf(dirty, 'e1'), 'save').props.onClick();
  inputOf(dirty, 'e1').props.onKeyDown({ key: 'Enter' });
  inputOf(dirty, 'e1').props.onKeyDown({ key: 'a' });
  assert.deepEqual(calls.slice(-2), [['save-dirty', 'e1'], ['save-dirty', 'e1']], 'Enter saves; other keys do not');
  console.log(`8.2) calls=${JSON.stringify(calls)} dirtySaveDisabled=${libraryButtonOf(rowOf(dirty, 'e1'), 'save').props.disabled}`);
});

// ---- 8.3 category picker: grouped, current highlighted, close = no change --------------------

test('8.3) 分类弹窗：按父级分组、当前高亮；关闭/当前项不改', async (t) => {
  const calls = [];
  const { tree } = render(libraryState(), {}, handlers({
    toggleLibraryPicker: (id) => calls.push(['toggle', id]),
    chooseLibraryCategory: (id, name) => calls.push(['choose', id, name]),
    closeLibraryPicker: () => calls.push(['close']),
  }));
  libraryButtonOf(rowOf(tree, 'e1'), 'category').props.onClick();
  assert.deepEqual(calls, [['toggle', 'e1']]);

  const open = render(libraryState({ picker: 'e1' }), {}, handlers({
    chooseLibraryCategory: (id, name) => calls.push(['choose', id, name]),
    closeLibraryPicker: () => calls.push(['close']),
  })).tree;
  const picker = collect(open, (node) => node.props['data-profile-library-picker'] === 'e1')[0];
  assert.ok(picker, 'the picker stays inline in the row');
  const groups = collect(picker, (node) => node.props['data-profile-library-group'] !== undefined)
    .map((node) => node.props['data-profile-library-group']);
  assert.deepEqual(groups, ['agent', 'user'], '人设侧 first, then 画像侧');
  const options = collect(picker, (node) => node.props['data-profile-library-option'] !== undefined);
  assert.deepEqual(options.map((node) => node.props['data-profile-library-option']), ['形象', '说话方式', '饮食', '娱乐']);
  const current = options.find((node) => node.props['data-profile-library-current'] === 'true');
  assert.equal(current.props['data-profile-library-option'], '饮食');
  assert.match(textOf(current), /✓ 饮食/u, 'the current category is highlighted');
  const entertainment = options.find((node) => node.props['data-profile-library-option'] === '娱乐');
  assert.equal(entertainment.props['data-profile-library-current'], undefined);
  entertainment.props.onClick();
  assert.deepEqual(calls.slice(-1), [['choose', 'e1', '娱乐']]);
  buttonOf(open, 'library'); // no-op read; the picker's close must not choose anything.
  collect(picker, (node) => node.props['data-profile-library-action'] === 'picker-close')[0].props.onClick();
  assert.deepEqual(calls.slice(-1), [['close']]);

  // Host side of "点当前项/关闭 = 不改": re-picking the current category writes nothing.
  const root = await mkdtemp(join(tmpdir(), 'dsh-library-editor-'));
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
  const entry = profile.upsert({ side: 'user', category: '饮食', text: '用户喜欢喝无糖茶' }).entry;
  const maintainer = createProfileMaintainer({
    profile, db, now: () => new Date('2026-11-08T10:00:00.000Z'), emit: () => {},
  });
  const unchanged = maintainer.setEntryCategory({ id: entry.id, category: '饮食' });
  assert.equal(unchanged.ok, true);
  assert.equal(unchanged.changed, false);
  assert.equal(profile.revision(entry.id).length, 0, 'the current item writes no revision');
  console.log(`8.3) groups=${groups.join(',')} options=${options.length} current=${current.props['data-profile-library-option']} closeCalls=${calls.filter((call) => call[0] === 'close').length} unchanged=${unchanged.changed}`);
});

// ---- 8.4 delete: second confirmation -------------------------------------------------------

test('8.4) 删除：第一次只进入确认，确认后才调用宿主删除；取消不删', () => {
  const calls = [];
  const { tree } = render(libraryState(), {}, handlers({
    requestDeleteLibraryEntry: (id) => calls.push(['request', id]),
    confirmDeleteLibraryEntry: (id) => calls.push(['confirm', id]),
    cancelDeleteLibraryEntry: (id) => calls.push(['cancel', id]),
  }));
  libraryButtonOf(rowOf(tree, 'e1'), 'delete').props.onClick();
  assert.deepEqual(calls, [['request', 'e1']], 'the first click only asks for confirmation');

  const confirming = render(libraryState({ confirmDelete: 'e1' }), {}, handlers({
    confirmDeleteLibraryEntry: (id) => calls.push(['confirm', id]),
    cancelDeleteLibraryEntry: (id) => calls.push(['cancel', id]),
  })).tree;
  assert.ok(collect(confirming, (node) => node.props['data-profile-library-confirm'] === 'e1')[0]);
  libraryButtonOf(rowOf(confirming, 'e1'), 'delete-confirm').props.onClick();
  libraryButtonOf(rowOf(confirming, 'e1'), 'delete-cancel').props.onClick();
  assert.deepEqual(calls.slice(-2), [['confirm', 'e1'], ['cancel', 'e1']]);
  console.log(`8.4) calls=${JSON.stringify(calls)} confirmVisible=${collect(confirming, (node) => node.props['data-profile-library-confirm'] === 'e1').length}`);
});

// ---- 8.5 new category: name + parent -------------------------------------------------------

test('8.5) 新建分类：名称 + 父级下拉，空名禁用，提交回调与结果提示正确', () => {
  const calls = [];
  const rows = fixtureCategories().map((row) => ({ ...row, count: 0 }));
  const state = { category: { open: true, rows, busy: '', error: '', note: '', editing: null, merging: null, createName: '', createParent: 'agent' } };
  const empty = render(libraryState(), state, handlers({
    setCategoryCreateName: (value) => calls.push(['name', value]),
    setCategoryCreateParent: (parent) => calls.push(['parent', parent]),
    submitCategoryCreate: () => calls.push(['create']),
  })).tree;
  const nameInput = collect(empty, (node) => node.props['data-profile-category-input'] === 'create-name')[0];
  const parentSelect = collect(empty, (node) => node.props['data-profile-category-input'] === 'create-parent')[0];
  assert.ok(nameInput, 'the name input exists');
  assert.deepEqual(nameInput.props.value, '');
  assert.deepEqual(collect(parentSelect, (node) => node.type === 'option').map((node) => textOf(node)), ['人设侧', '画像侧']);
  assert.equal(collect(empty, (node) => node.props['data-profile-category-action'] === 'create')[0].props.disabled, true, 'an empty name cannot be submitted');
  nameInput.props.onChange({ target: { value: '旅行' } });
  parentSelect.props.onChange({ target: { value: 'user' } });
  assert.deepEqual(calls, [['name', '旅行'], ['parent', 'user']]);

  const ready = render(libraryState(), {
    category: { ...state.category, createName: '旅行', createParent: 'user' },
  }, handlers({ submitCategoryCreate: () => calls.push(['create-ready']) })).tree;
  const createButton = collect(ready, (node) => node.props['data-profile-category-action'] === 'create')[0];
  assert.equal(createButton.props.disabled, false);
  createButton.props.onClick();
  assert.deepEqual(calls.slice(-1), [['create-ready']]);

  const kit = loadProfileKit();
  const created = kit.profileCategoryResultState(
    { ...state.category, createName: '旅行' },
    { ok: true, category: { name: '旅行', parent: 'user' } },
    { ok: true, categories: [...rows, { name: '旅行', parent: 'user', count: 0, source: 'user' }] },
    'create',
  );
  assert.equal(created.note, '已新建分类「旅行」');
  assert.equal(created.createName, '');
  assert.ok(created.rows.some((row) => row.name === '旅行' && row.parent === 'user'));
  console.log(`8.5) options=${JSON.stringify(collect(parentSelect, (node) => node.type === 'option').map((node) => textOf(node)))} emptyDisabled=true readyDisabled=${createButton.props.disabled} note="${created.note}"`);
});

// ---- 8.6 error wording --------------------------------------------------------------------

test('8.6) 失败文案：重复文本/未知分类/条目不存在都由库编辑面板显示', () => {
  const kit = loadProfileKit();
  assert.equal(kit.profileLibraryErrorText({ ok: false, reason: 'duplicate-text' }), '同一侧已有相同内容的条目');
  assert.equal(kit.profileLibraryErrorText({ ok: false, reason: 'unknown-category' }), '分类不存在');
  assert.equal(kit.profileLibraryErrorText({ ok: false, reason: 'unknown-entry' }), '条目已不存在');
  const tree = render(libraryState({ error: '同一侧已有相同内容的条目' })).tree;
  const error = collect(tree, (node) => node.props['data-profile-library-error'] === true)[0];
  assert.match(textOf(error), /同一侧已有相同内容的条目/u);
  assert.equal(kit.profileCategoryKey('ＡＢＣ'), kit.profileCategoryKey('abc'), 'full-width/case normalization');
  console.log(`8.6) error="${textOf(error)}" key="${kit.profileCategoryKey('ＡＢＣ')}"`);
});
