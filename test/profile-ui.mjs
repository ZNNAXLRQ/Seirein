/**
 * Profile library card: the settings card under the memory card. The user only edits the two
 * texts (agent persona / user profile); the host's model split turns them into categorized
 * fragments. The card therefore has no entry list and no entry-level buttons.
 *
 * The shipped block is evaluated with an injected recording `h` — no DOM and no React needed
 * (same technique as layer-settings.mjs). The host rule `profileAutoMaintainEnabled` is imported
 * from index.js, so no real model or database is touched.
 *
 * Proves the rules fixed on 2026-11-06 (revised: save vs organize):
 *  - exactly two text boxes (agent/user), filled from `status.profile.text`, with draft override;
 *  - 「保存」 sends `profile.save` with both texts — it only persists the boxes and says
 *    "已保存到文本框，尚未入库"; no split counters, no entry-level UI;
 *  - 「整理后入库」/「立刻整理」 sends `profile.maintain.now` with both texts (the host runs the
 *    complete split → library → rewrite → write-back flow) and shows the round summary;
 *  - a per-side `pending` flag drives the「整理后入库」label and the pending hint;
 *  - 「暂停自动整理」 writes `profile.autoMaintain=false`, which the host rule reads back;
 *  - no entry-level UI at all: the rendered tree has no entry rows and the source region for this
 *    card contains no lock/undo/remove button, so a user cannot lock, revert or delete an entry;
 *  - 「重新分类」 previews first: change rows show `原分类 → 新分类` plus a cross-side
 *    `画像 → 人设` badge, and nothing is written until 「应用 N 条」;
 *  - the removed 「最近变化」 block is never rendered or requested again.
 *
 * Run: node --test test/profile-ui.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { DatabaseSync } from 'node:sqlite';

import {
  PROFILE_STATUS_ENTRY_LIMIT,
  profileAutoMaintainEnabled,
  profileCategoryAction,
  profileReclassifyApply,
  profileReclassifyPreview,
} from '../src/host/index.js';
import { createProfileMaintainer } from '../src/host/profile/profileMaintain.js';
import { createProfileStore } from '../src/host/profile/profileStore.js';

const here = dirname(fileURLToPath(import.meta.url));
const clientSource = readFileSync(join(here, '..', 'client.js'), 'utf8');

// ---- fixture kit ---------------------------------------------------------------------------

/** Minimal style/line kit so the shipped slice can run without a DOM or React. */
const styles = new Proxy({}, { get: (_target, key) => ({ marker: String(key) }) });
const line = (label, value) => ({ type: 'line', props: { label, value }, children: [] });
const fmtTokens = (value) => {
  const n = Number(value ?? 0);
  return n >= 1e4 ? `${(n / 1e4).toFixed(1)} 万` : String(Math.round(n));
};

/** Recording element factory: every node keeps its type, props and children. */
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

/** All descendant text, in document order (strings only; `line` keeps its value in props). */
const textOf = (node) => {
  const parts = [];
  walk(node, (item) => {
    for (const child of item.children ?? []) {
      if (typeof child === 'string') parts.push(child);
    }
  });
  return parts.join(' ');
};

const linesOf = (tree) => collect(tree, (node) => node.type === 'line');

/** Extract the shipped profile UI kit (helpers + card body) from client.js. */
const loadProfileKit = () => {
  const from = clientSource.indexOf('    // ---- profile library (人设库)');
  const to = clientSource.indexOf('    function Panel() {', from);
  assert.ok(from > 0 && to > from, 'the shipped profile card helpers are found in client.js');
  const slice = clientSource.slice(from, to);
  return new Function(
    'styles', 'line', 'MUTED', 'ACCENT', 'BORDER', 'DANGER', 'fmtTokens',
    `${slice}\nreturn {
      profileTexts,
      profileSideLabel,
      profileSaveText,
      profileSaveState,
      profileMaintainNow,
      profileMaintainState,
      profileSummaryText,
      profileReclassifyPreviewState,
      profileReclassifyApplyState,
      profileAutoBody,
      profileSettingsBody,
      profileCategoryRows,
      profileCategorySourceLabel,
      profileCategoryErrorText,
      profileCategoryResultState,
      profileCategoryBody,
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

/** The shape `/assistant/status` returns for `status.profile`, with per-test overrides. */
const fixtureProfile = (overrides = {}) => ({
  capacity: { used: 3, cap: 96 },
  autoMaintain: true,
  running: false,
  pending: { agent: false, user: false },
  lastRunAt: '2026-11-06T02:00:00.000Z',
  lastSummary: { added: 1, updated: 0, adopted: 2, dropped: 0, forgotten: 0, tokens: 900 },
  truncated: false,
  text: { agent: '妹系美少女角色\n说话方式带一点撒娇感', user: '喜欢冰美式' },
  // The card must not render these even when the host still returns them in status.
  entries: [
    { id: 'e1', side: 'agent', text: '说话简短', category: '语言', tags: '简洁,温柔', clarity: 70, efficacy: 56, rank: 'original', locked: true },
    { id: 'e2', side: 'user', text: '喜欢冰美式', category: '饮食', tags: '', clarity: 60, efficacy: 53, rank: 'new', locked: false },
  ],
  ...overrides,
});

const render = (profile, state = {}, customHandlers = handlers()) => {
  const kit = loadProfileKit();
  return {
    kit,
    tree: kit.profileSettingsBody(h, {
      profile,
      busy: '',
      maintain: null,
      draft: null,
      reclassify: null,
      ...state,
    }, customHandlers),
  };
};

const buttonOf = (tree, action) => collect(tree, (node) => node.props['data-profile-action'] === action)[0];
const boxes = (tree) => collect(tree, (node) => typeof node.props['data-profile-input'] === 'string');

// ---- 1. title + capacity -------------------------------------------------------------------

test('1. 渲染：标题含容量 used/cap，卡片仍在记忆卡片之后', () => {
  const { tree } = render(fixtureProfile());
  const cards = collect(tree, (node) => node.props['data-profile-card'] === true);
  assert.equal(cards.length, 1, 'exactly one profile card');
  const title = collect(tree, (node) => node.props['data-profile-title'] === true)[0];
  assert.ok(title, 'the card has a title node');
  assert.match(textOf(title), /人设库 · 3\/96/u, `title must carry used/cap, got "${textOf(title)}"`);
  const capacityLine = linesOf(tree).find((node) => node.props.label === '容量');
  assert.equal(capacityLine?.props.value, '3 / 96 条（3%）');

  const memoryAt = clientSource.indexOf("'记忆',");
  const profileAt = clientSource.indexOf('profileSettingsBody(h, {');
  assert.ok(memoryAt > 0, 'the memory card title is present');
  assert.ok(profileAt > memoryAt, `profile mount (${profileAt}) must follow the memory card (${memoryAt})`);
  console.log(`1) title=${textOf(title)} mount=${profileAt}>memory=${memoryAt}`);
});

// ---- 2. the two text boxes -----------------------------------------------------------------

test('2. 两个文本框：agent/user 各自显示持久化文本，草稿优先，改动回传 setText', () => {
  const { tree } = render(fixtureProfile());
  const inputs = boxes(tree);
  assert.equal(inputs.length, 2, 'exactly two editable texts');
  const bySide = Object.fromEntries(inputs.map((node) => [node.props['data-profile-input'], node]));
  assert.deepEqual(Object.keys(bySide).sort(), ['agent', 'user']);
  assert.equal(bySide.agent.props.value, '妹系美少女角色\n说话方式带一点撒娇感');
  assert.equal(bySide.user.props.value, '喜欢冰美式');
  assert.equal(bySide.agent.type, 'textarea');

  const calls = [];
  const drafted = render(fixtureProfile(), { draft: { agent: '改过的人设' } }, handlers({
    setText: (side, value) => calls.push([side, value]),
  }));
  const agentBox = boxes(drafted.tree).find((node) => node.props['data-profile-input'] === 'agent');
  assert.equal(agentBox.props.value, '改过的人设', 'the in-progress draft wins over status');
  assert.equal(
    boxes(drafted.tree).find((node) => node.props['data-profile-input'] === 'user').props.value,
    '喜欢冰美式',
    'a draft on one side does not blank the other',
  );
  agentBox.props.onChange({ target: { value: '再改一点' } });
  assert.deepEqual(calls, [['agent', '再改一点']]);

  // No persisted text (old host / empty boxes) renders two empty boxes, not an error.
  const empty = render(fixtureProfile({ text: undefined })).tree;
  assert.deepEqual(boxes(empty).map((node) => node.props.value), ['', '']);
  console.log(`2) boxes=${inputs.length} agent="${agentBox.props.value}" user="${bySide.user.props.value}"`);
});

// ---- 3. save: text box only ----------------------------------------------------------------

test('3. 「保存」→ profile.save（只写文本框）；提示尚未入库；失败显示错误', async () => {
  const kit = loadProfileKit();
  const calls = [];
  const act = async (body, tag) => {
    calls.push({ body, tag });
    return { ok: true, saved: ['agent', 'user'], pending: { agent: true, user: true } };
  };
  const shown = [];
  const result = await kit.profileSaveText(act, { agent: '妹系…', user: '喜欢冰美式' }, (text) => shown.push(text));
  assert.deepEqual(calls[0].body, {
    action: 'profile.save',
    agent: '妹系…',
    user: '喜欢冰美式',
  });
  assert.equal(calls[0].tag, 'profile-save');
  assert.match(shown[0], /已保存到文本框，尚未入库/u);
  assert.match(shown[0], /整理后入库/u);

  // The card button only hands off to the Panel handler (which owns act()).
  const clicked = [];
  const card = render(fixtureProfile(), {}, handlers({ saveText: () => clicked.push('save') }));
  buttonOf(card.tree, 'save').props.onClick();
  assert.deepEqual(clicked, ['save']);

  const state = kit.profileSaveState(result);
  assert.equal(state.running, false);
  assert.equal(state.error, '');
  assert.match(state.note, /已保存到文本框，尚未入库/u);
  const done = render(fixtureProfile(), { maintain: state });
  assert.match(textOf(done.tree), /已保存到文本框，尚未入库/u);
  assert.equal(collect(done.tree, (node) => node.props['data-profile-split'] === true).length, 0,
    'no split counters after a text-only save');
  console.log(`3) body=${JSON.stringify(calls[0].body)} note="${state.note}"`);

  // A failed save leaves the typed text in the box and shows the reason.
  const failed = kit.profileSaveState({ ok: false, error: '保存失败' });
  assert.equal(failed.error, '保存失败');
  const failedTree = render(fixtureProfile(), { maintain: failed }).tree;
  assert.match(textOf(failedTree), /操作失败：保存失败/u);
  assert.deepEqual(
    boxes(failedTree).map((node) => node.props.value),
    ['妹系美少女角色\n说话方式带一点撒娇感', '喜欢冰美式'],
    'a failed save never blanks or replaces the boxes',
  );
});

// ---- 4. maintain now -----------------------------------------------------------------------

test('4. 「立刻整理」→ profile.maintain.now（带两段文本）；运行中与摘要', async () => {
  const kit = loadProfileKit();
  const summary = { added: 2, updated: 1, adopted: 5, dropped: 0, forgotten: 1, tokens: 1200 };
  const calls = [];
  const act = async (body, tag) => {
    calls.push({ body, tag });
    return { ok: true, ran: true, summary };
  };
  const result = await kit.profileMaintainNow(act, { agent: '人设文本', user: '画像文本' });
  assert.deepEqual(calls[0].body, {
    action: 'profile.maintain.now',
    agent: '人设文本',
    user: '画像文本',
  }, 'the card hands the current boxes to the round so they are persisted before it runs');
  assert.equal(calls[0].tag, 'profile-maintain');

  // A caller without box texts still sends the bare action (host-side tests / older callers).
  await kit.profileMaintainNow(act);
  assert.deepEqual(calls[1].body, { action: 'profile.maintain.now' });

  const running = render(fixtureProfile(), { maintain: { running: true } });
  const runningButton = buttonOf(running.tree, 'maintain');
  assert.equal(textOf(runningButton), '正在整理…');
  assert.equal(runningButton.props.disabled, true, 'a second round cannot start while one runs');

  const state = kit.profileMaintainState(result);
  const done = render(fixtureProfile(), { maintain: state });
  const summaryNode = collect(done.tree, (node) => node.props['data-profile-summary'] === true)[0];
  assert.ok(summaryNode, 'a summary line is shown after the round');
  assert.match(textOf(summaryNode), /本次整理：新增 2 · 更新 1 · 收编 5 · 丢弃 0 · 遗忘 1 · 1200 tokens/u);
  assert.equal(textOf(buttonOf(done.tree, 'maintain')), '立刻整理', 'the button is usable again');

  const idle = kit.profileMaintainState({ ok: true, ran: false, reason: 'no-new-content' });
  assert.equal(idle.note, '没有新的交流可整理');
  assert.equal(idle.summary, null);

  // A queued click is silent: the button is disabled and shows 「已排队…」 with a cancel action.
  const queuedState = kit.profileMaintainState({ ok: true, status: 'queued', reason: 'playing', taskId: 'pm-1' });
  assert.equal(queuedState.running, false, 'the request itself has returned; only the queue remains');
  assert.equal(queuedState.queued, true);
  const queuedTree = render(fixtureProfile(), { maintain: queuedState }).tree;
  const queuedButton = buttonOf(queuedTree, 'maintain');
  assert.equal(textOf(queuedButton), '已排队…');
  assert.equal(queuedButton.props.disabled, true, 'a queued click cannot start a second round');
  assert.ok(buttonOf(queuedTree, 'maintain-cancel'), 'the queued request can be cancelled');

  const cancelledState = kit.profileMaintainState({ ok: true, status: 'cancelled', taskId: 'pm-1' });
  assert.equal(cancelledState.running, false);
  assert.equal(cancelledState.queued, false);
  assert.equal(cancelledState.note, '已取消');

  // The removed「最近变化」block must not come back, not even from a stale status payload.
  const legacy = render(fixtureProfile({ recent: [{ id: 'rev-1', text: '旧说法', source: 'user' }] }));
  assert.equal(collect(legacy.tree, (node) => node.props['data-profile-recent'] === true).length, 0,
    'no recent-change panel is rendered');
  assert.equal(buttonOf(legacy.tree, 'recent'), undefined, 'no recent toggle button remains');
  console.log(`4) action=${calls[0].body.action} summary="${textOf(summaryNode)}" recent=none`);
});

// ---- 5. pause switch -----------------------------------------------------------------------

test('5. 暂停开关 → 写 profile.autoMaintain=false，status 反映', async () => {
  const kit = loadProfileKit();
  const calls = [];
  const act = async (body, tag) => {
    calls.push({ body, tag });
    return { ok: true, autoMaintain: body.autoMaintain };
  };
  assert.deepEqual(kit.profileAutoBody(false), { action: 'profile.auto', autoMaintain: false });
  await act(kit.profileAutoBody(false), 'profile-auto');
  assert.deepEqual(calls[0], { body: { action: 'profile.auto', autoMaintain: false }, tag: 'profile-auto' });

  const on = render(fixtureProfile());
  assert.equal(textOf(buttonOf(on.tree, 'auto')), '暂停自动整理');
  assert.match(linesOf(on.tree).find((node) => node.props.label === '自动整理').props.value, /^开/u);

  const setCalls = [];
  const off = render(fixtureProfile({ autoMaintain: false }), {}, handlers({
    setAutoMaintain: (enabled) => setCalls.push(enabled),
  }));
  const offButton = buttonOf(off.tree, 'auto');
  assert.equal(textOf(offButton), '恢复自动整理');
  assert.match(linesOf(off.tree).find((node) => node.props.label === '自动整理').props.value, /已暂停/u);
  offButton.props.onClick();
  assert.deepEqual(setCalls, [true], 'the switch asks for the opposite state');

  assert.equal(profileAutoMaintainEnabled({}), true);
  assert.equal(profileAutoMaintainEnabled({ profile: { autoMaintain: false } }), false);
  assert.equal(profileAutoMaintainEnabled({ profile: { autoMaintain: true } }), true);
  assert.equal(profileAutoMaintainEnabled({ profile: null }), true);
  console.log(`6. body=${JSON.stringify(calls[0].body)} hostRule=${profileAutoMaintainEnabled({ profile: { autoMaintain: false } })}`);
});

// ---- 6. no entry-level UI ------------------------------------------------------------------

test('6. 卡片不再渲染任何条目或条目级按钮（锁定/撤销）；分类管理只操作分类本身', () => {
  const from = clientSource.indexOf('    // ---- profile library (人设库)');
  const to = clientSource.indexOf('    function Panel() {', from);
  const region = clientSource.slice(from, to);
  for (const word of ['锁定', '解锁', '撤销']) {
    assert.equal(region.includes(word), false, `the profile card region must not mention「${word}」`);
  }
  // The only 删除 in the card is the category-row button of the 「分类管理」 child container; no
  // entry can be deleted from this card, so every entry-level marker must stay absent.
  assert.match(region, /'data-profile-category-action': 'delete'/u, '删除 only exists for a category row');
  for (const attr of ['data-profile-entry', 'data-profile-edit-field', 'data-profile-locked', 'data-profile-empty']) {
    assert.equal(region.includes(attr), false, `the profile card region must not render「${attr}」`);
  }

  const { tree } = render(fixtureProfile());
  assert.equal(collect(tree, (node) => typeof node.props['data-profile-entry'] === 'string').length, 0,
    'status.profile.entries is never rendered');
  for (const action of ['edit', 'lock', 'undo', 'remove']) {
    assert.equal(buttonOf(tree, action), undefined, `no「${action}」button exists`);
  }
  const actions = [...new Set(collect(tree, (node) => typeof node.props['data-profile-action'] === 'string')
    .map((node) => node.props['data-profile-action']))].sort();
  assert.deepEqual(actions, ['auto', 'maintain', 'reclassify', 'save'], 'only save/maintain/auto/reclassify remain');
  assert.equal(region.includes('最近变化'), false, 'the removed recent block leaves no wording behind');
  assert.equal(region.includes('data-profile-recent'), false, 'the removed recent block leaves no marker behind');
  console.log(`6) region=${region.length}B words=none actions=${actions.join(',')}`);
});

// ---- 7. layout: two boxes + four buttons ---------------------------------------------------

test('7. 布局：两个文本框 + 保存 + 立刻整理 + 重新分类 + 暂停按钮', () => {
  const { tree } = render(fixtureProfile());
  assert.equal(collect(tree, (node) => node.type === 'textarea').length, 2, 'exactly two textareas');
  assert.equal(boxes(tree).length, 2);
  assert.equal(textOf(buttonOf(tree, 'save')), '保存');
  assert.equal(textOf(buttonOf(tree, 'maintain')), '立刻整理');
  assert.equal(textOf(buttonOf(tree, 'reclassify')), '重新分类');
  assert.equal(textOf(buttonOf(tree, 'auto')), '暂停自动整理');
  const order = collect(tree, (node) => typeof node.props['data-profile-action'] === 'string')
    .map((node) => node.props['data-profile-action']);
  assert.equal(order.indexOf('reclassify'), order.indexOf('maintain') + 1, '「重新分类」sits next to「立刻整理」');

  // Saving disables the buttons and says so, so a slow model cannot be double-submitted.
  const saving = render(fixtureProfile(), { busy: 'profile-save' });
  assert.equal(textOf(buttonOf(saving.tree, 'save')), '保存中…');
  assert.equal(buttonOf(saving.tree, 'save').props.disabled, true);
  assert.equal(buttonOf(saving.tree, 'save').props['data-profile-action'], 'save');

  // A pending side relabels the organize button and renders the 「尚未入库」 hint.
  const pending = render(fixtureProfile({ pending: { agent: true, user: false } }));
  assert.equal(textOf(buttonOf(pending.tree, 'maintain')), '整理后入库');
  assert.ok(collect(pending.tree, (node) => node.props['data-profile-pending'] === true)[0],
    'the pending hint is visible while the box has unsynced text');
  assert.match(textOf(pending.tree), /保存只写入文本框.*拆分→入库→重写→写回/u);

  // Empty boxes still render the card (no placeholder that hides the editors).
  const empty = render(fixtureProfile({ capacity: { used: 0, cap: 96 }, text: { agent: '', user: '' }, entries: [] })).tree;
  assert.match(textOf(collect(empty, (node) => node.props['data-profile-title'] === true)[0]), /0\/96/u);
  assert.deepEqual(boxes(empty).map((node) => node.props.value), ['', '']);
  assert.equal(PROFILE_STATUS_ENTRY_LIMIT, 200, 'status still caps the entry list it returns');
  console.log(`7) boxes=2 buttons=保存/整理后入库/重新分类/暂停自动整理 saving="${textOf(buttonOf(saving.tree, 'save'))}" pending="${textOf(buttonOf(pending.tree, 'maintain'))}"`);
});

// ---- 8. reclassify preview: compact rows + cross-side badge --------------------------------

test('8. 重新分类预览：显示「原分类 → 新分类」，跨侧标「画像 → 人设」，确认前不写库', () => {
  const changes = [
    {
      entryId: 'e1',
      text: '用户喜欢看悬疑电影',
      from: { side: 'user', category: '饮食' },
      to: { side: 'user', category: '娱乐' },
    },
    {
      entryId: 'e2',
      text: '用户会先安静地听完',
      from: { side: 'user', category: '说话方式' },
      to: { side: 'agent', category: '说话方式' },
    },
  ];
  const { tree } = render(fixtureProfile(), {
    reclassify: { open: true, busy: '', changes, version: 'v1', error: '', note: '' },
  });
  const panel = collect(tree, (node) => node.props['data-profile-reclassify'] === true)[0];
  assert.ok(panel, 'the preview list is rendered');
  assert.match(textOf(panel), /待确认的分类变更（2 条）/u);
  assert.match(textOf(panel), /饮食 → 娱乐/u);
  assert.match(textOf(panel), /说话方式 → 说话方式/u);
  const cross = collect(panel, (node) => node.props['data-profile-reclassify-cross'] === true);
  assert.equal(cross.length, 1, 'only the cross-side row carries the side marker');
  assert.match(textOf(cross[0]), /画像 → 人设/u);
  assert.equal(textOf(buttonOf(panel, 'reclassify-apply')), '应用 2 条');
  assert.equal(buttonOf(panel, 'reclassify-apply').props.disabled, false);
  assert.equal(textOf(buttonOf(panel, 'reclassify-cancel')), '取消');
  assert.equal(buttonOf(panel, 'reclassify-cancel').props.disabled, false);

  // The buttons only hand off to the Panel handlers (which own act()).
  const clicked = [];
  const wired = render(fixtureProfile(), {
    reclassify: { open: true, busy: '', changes, version: 'v1', error: '', note: '' },
  }, handlers({
    previewReclassify: () => clicked.push('preview'),
    applyReclassify: () => clicked.push('apply'),
    cancelReclassify: () => clicked.push('cancel'),
  }));
  buttonOf(wired.tree, 'reclassify').props.onClick();
  buttonOf(wired.tree, 'reclassify-apply').props.onClick();
  buttonOf(wired.tree, 'reclassify-cancel').props.onClick();
  assert.deepEqual(clicked, ['preview', 'apply', 'cancel']);

  // The state mapping keeps the exact preview version and rows for the confirm request.
  const state = loadProfileKit().profileReclassifyPreviewState({ ok: true, total: 3, changes, version: 'v1' });
  assert.equal(state.open, true);
  assert.equal(state.version, 'v1');
  assert.deepEqual(state.changes, changes);
  console.log(`8) rows=${changes.length} cross=${cross.length} apply="${textOf(buttonOf(panel, 'reclassify-apply'))}"`);
});

// ---- 9. reclassify outcomes: empty / busy / conflict / applied -----------------------------

test('9. 无变更提示「分类已是最新」；忙时禁用；冲突提示重新预览；成功提示条数', () => {
  const kit = loadProfileKit();

  const empty = kit.profileReclassifyPreviewState({ ok: true, total: 5, changes: [], version: 'v1' });
  assert.equal(empty.open, false, 'an empty plan never opens the confirm list');
  assert.equal(empty.note, '分类已是最新');
  const emptyTree = render(fixtureProfile(), { reclassify: empty }).tree;
  assert.match(textOf(emptyTree), /分类已是最新/u);
  assert.equal(buttonOf(emptyTree, 'reclassify-apply'), undefined, 'no apply button for an empty plan');

  const previewing = render(fixtureProfile(), {
    reclassify: { open: false, busy: 'preview', changes: [], version: null, error: '', note: '' },
  }).tree;
  assert.equal(textOf(buttonOf(previewing, 'reclassify')), '预览中…');
  assert.equal(buttonOf(previewing, 'reclassify').props.disabled, true, 'a second preview cannot be fired');

  const applying = render(fixtureProfile(), {
    reclassify: {
      open: true,
      busy: 'apply',
      changes: [{ entryId: 'e1', text: '用户喜欢看悬疑电影', from: { side: 'user', category: '饮食' }, to: { side: 'user', category: '娱乐' } }],
      version: 'v1',
      error: '',
      note: '',
    },
  }).tree;
  assert.equal(textOf(buttonOf(applying, 'reclassify-apply')), '应用中…');
  assert.equal(buttonOf(applying, 'reclassify-apply').props.disabled, true, 'the confirm button cannot repeat');
  assert.equal(buttonOf(applying, 'reclassify-cancel').props.disabled, true, 'cancel waits for the request');
  assert.equal(buttonOf(applying, 'reclassify').props.disabled, true, 'the whole card is busy during apply');

  const conflict = kit.profileReclassifyApplyState({ ok: false, aborted: true, reason: 'version-conflict', applied: 0 });
  assert.equal(conflict.open, false);
  assert.equal(conflict.note, '库已变化，请重新预览');
  const conflictTree = render(fixtureProfile(), { reclassify: conflict }).tree;
  assert.match(textOf(conflictTree), /库已变化，请重新预览/u);

  const applied = kit.profileReclassifyApplyState({ ok: true, applied: 2 });
  assert.equal(applied.open, false);
  assert.equal(applied.applied, 2);
  assert.equal(applied.note, '已应用 2 条分类变更');
  const appliedTree = render(fixtureProfile(), { reclassify: applied }).tree;
  assert.match(textOf(appliedTree), /已应用 2 条分类变更/u);

  const busyState = kit.profileReclassifyPreviewState({ ok: false, status: 'busy' });
  assert.match(busyState.error, /整理进行中/u);
  console.log(`9) empty="${empty.note}" conflict="${conflict.note}" applied="${applied.note}" busyDisabled=${buttonOf(previewing, 'reclassify').props.disabled}`);
});

// ---- 10. host preview/apply: preview is read-only, apply keeps scores ----------------------

async function freshReclassify(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-profile-ui-'));
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
  const make = (changes) => createProfileMaintainer({
    profile,
    db,
    now: () => new Date('2026-11-06T10:00:00.000Z'),
    emit: () => {},
    readMessages: () => [],
    extract: async () => ({ candidates: [] }),
    reclassify: async () => ({ changes }),
    config: { intervalDays: 7, queuePollMs: 20 },
  });
  return { profile, make };
}

test('10. 宿主 preview 不写库；apply 后分类/侧改变，C/E、supports、evidence、rank 不变', async (t) => {
  const { profile, make } = await freshReclassify(t);
  const categoryTarget = profile.upsert({
    side: 'user', category: '饮食', text: '用户喜欢看悬疑电影',
    clarity: 72, efficacy: 41, rank: 'candidate',
  }).entry;
  const sideTarget = profile.upsert({
    side: 'user', category: '说话方式', text: '用户会先安静地听完',
    clarity: 66, efficacy: 38, rank: 'new',
  }).entry;
  profile.addEvidence(categoryTarget.id, { messageId: 'm-1' });
  profile.addEvidence(categoryTarget.id, { messageId: 'm-2' });
  profile.addEvidence(sideTarget.id, { messageId: 'm-3' });
  const maintainer = make([
    { entryId: categoryTarget.id, side: 'user', category: '娱乐' },
    { entryId: sideTarget.id, side: 'agent', category: '说话方式' },
  ]);

  const before = {
    entries: profile.list().map((entry) => ({ ...entry })),
    categoryRevisions: profile.revision(categoryTarget.id).length,
    sideRevisions: profile.revision(sideTarget.id).length,
  };
  const preview = await profileReclassifyPreview(maintainer);
  assert.equal(preview.ok, true);
  assert.equal(preview.total, 2);
  assert.equal(preview.changes.length, 2);
  assert.equal(typeof preview.version, 'string');
  const cross = preview.changes.find((change) => change.entryId === sideTarget.id);
  assert.deepEqual(cross.from, { side: 'user', category: '说话方式' });
  assert.deepEqual(cross.to, { side: 'agent', category: '说话方式' }, 'the cross-side plan carries both sides');
  assert.deepEqual(profile.list().map((entry) => ({ ...entry })), before.entries, 'preview wrote no entry');
  assert.equal(profile.revision(categoryTarget.id).length, before.categoryRevisions, 'preview wrote no revision');
  assert.equal(profile.revision(sideTarget.id).length, before.sideRevisions);

  const applied = await profileReclassifyApply(maintainer, { changes: preview.changes, version: preview.version });
  assert.equal(applied.ok, true);
  assert.equal(applied.applied, 2);
  assert.equal(profile.get(categoryTarget.id).category, '娱乐');
  assert.equal(profile.get(categoryTarget.id).side, 'user');
  assert.equal(profile.get(sideTarget.id).side, 'agent');
  assert.equal(profile.get(sideTarget.id).category, '说话方式');
  assert.equal(profile.get(categoryTarget.id).clarity, 72);
  assert.equal(profile.get(categoryTarget.id).efficacy, 41);
  assert.equal(profile.get(categoryTarget.id).rank, 'candidate');
  assert.equal(profile.get(sideTarget.id).clarity, 66);
  assert.equal(profile.get(sideTarget.id).efficacy, 38);
  assert.equal(profile.supportCount(categoryTarget.id), 2);
  assert.equal(profile.supportCount(sideTarget.id), 1);
  assert.equal(profile.evidence(categoryTarget.id).length, 2);
  assert.equal(profile.revision(categoryTarget.id).length, 1);
  assert.equal(profile.revision(categoryTarget.id)[0].source, 'reclassify');
  console.log(`10) previewTotal=${preview.total} previewChanges=${preview.changes.length} applied=${applied.applied} category=${profile.get(categoryTarget.id).category} side=${profile.get(sideTarget.id).side} clarity=${profile.get(categoryTarget.id).clarity}/${profile.get(sideTarget.id).clarity} supports=${profile.supportCount(categoryTarget.id)}/${profile.supportCount(sideTarget.id)}`);
});

test('11. 版本冲突 aborted；整理运行/排队时 busy 且不预演、不入队', async (t) => {
  const { profile, make } = await freshReclassify(t);
  const target = profile.upsert({ side: 'user', category: '饮食', text: '用户喜欢看悬疑电影' }).entry;
  const maintainer = make([{ entryId: target.id, side: 'user', category: '娱乐' }]);
  const preview = await profileReclassifyPreview(maintainer);
  assert.equal(preview.changes.length, 1);
  profile.edit(target.id, { category: '运动' });
  const result = await profileReclassifyApply(maintainer, { changes: preview.changes, version: preview.version });
  assert.equal(result.ok, false);
  assert.equal(result.aborted, true);
  assert.equal(result.reason, 'version-conflict');
  assert.equal(result.applied, 0);
  assert.equal(profile.get(target.id).category, '运动', 'the manual edit is kept');
  const conflictState = loadProfileKit().profileReclassifyApplyState(result);
  assert.equal(conflictState.note, '库已变化，请重新预览');

  let planned = false;
  let applied = false;
  const busyMaintainer = {
    status: () => ({ running: true, queued: false }),
    planReclassify: async () => {
      planned = true;
      return { ok: true, changes: [] };
    },
    applyReclassify: async () => {
      applied = true;
      return { ok: true, applied: 0 };
    },
  };
  assert.deepEqual(await profileReclassifyPreview(busyMaintainer), { ok: false, status: 'busy' });
  assert.deepEqual(profileReclassifyApply(busyMaintainer, {}), { ok: false, status: 'busy' });
  assert.equal(planned, false, 'busy preview never calls the model');
  assert.equal(applied, false, 'busy apply never writes');
  const queued = { status: () => ({ running: false, queued: true }) };
  assert.deepEqual(await profileReclassifyPreview(queued), { ok: false, status: 'busy' }, 'a queued round also blocks');
  console.log(`11) aborted=${result.aborted} reason=${result.reason} conflict="${conflictState.note}" busy=ok`);
});

// ---- 12. category list: the four fields the card renders ------------------------------------

test('12. 分类列表：名称/上级/条目数/来源（预设与模型）字段完整', async (t) => {
  const { profile, make } = await freshReclassify(t);
  const maintainer = make([]);
  profile.upsert({ side: 'user', category: '饮食', text: '用户喜欢冰美式' });
  profile.upsert({ side: 'user', category: '饮食', text: '用户不吃香菜' });
  maintainer.applyCategoryOps([{ kind: 'add', name: '天气', parent: 'user', description: '用户所在地的天气' }]);
  profile.upsert({ side: 'user', category: '天气', text: '用户住在杭州' });

  const listed = profileCategoryAction(maintainer, 'list');
  assert.equal(listed.ok, true);
  const rows = listed.categories;
  for (const row of rows) {
    assert.deepEqual(Object.keys(row).sort(), ['count', 'name', 'parent', 'source'], 'four fields per row');
  }
  assert.equal(rows.length, 9, 'eight presets + one model category');
  const food = rows.find((row) => row.name === '饮食');
  assert.deepEqual(food, { name: '饮食', parent: 'user', count: 2, source: 'preset' });
  const weather = rows.find((row) => row.name === '天气');
  assert.deepEqual(weather, { name: '天气', parent: 'user', count: 1, source: 'model' });
  assert.deepEqual(rows.find((row) => row.name === '说话方式'), {
    name: '说话方式', parent: 'agent', count: 0, source: 'preset',
  });
  console.log(`12) categories=${rows.length} 饮食=${JSON.stringify(food)} 天气=${JSON.stringify(weather)}`);
});

// ---- 13. rename: entries follow the name; conflicts change nothing -------------------------

test('13. 改名：条目随分类改到新名；重名/超长/空名拒绝且不改库', async (t) => {
  const { profile, make } = await freshReclassify(t);
  const maintainer = make([]);
  const a = profile.upsert({ side: 'user', category: '饮食', text: '用户喜欢冰美式' }).entry;
  const b = profile.upsert({ side: 'user', category: '饮食', text: '用户不吃香菜' }).entry;

  const renamed = profileCategoryAction(maintainer, 'rename', { name: '饮食', next: '吃喝' });
  assert.equal(renamed.ok, true);
  assert.ok(maintainer.categories().some((row) => row.name === '吃喝' && row.parent === 'user'));
  assert.equal(maintainer.categories().some((row) => row.name === '饮食'), false, 'the old name is gone');
  assert.equal(profile.get(a.id).category, '吃喝', 'entries follow the rename');
  assert.equal(profile.get(b.id).category, '吃喝');
  assert.equal(profile.get(a.id).text, '用户喜欢冰美式', 'renaming never touches the entry text');

  const duplicate = profileCategoryAction(maintainer, 'rename', { name: '吃喝', next: '运动' });
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.error, '名称已存在');
  assert.equal(profile.get(a.id).category, '吃喝', 'a refused rename changes nothing');

  const crossSide = profileCategoryAction(maintainer, 'rename', { name: '吃喝', next: '形象' });
  assert.equal(crossSide.ok, false, 'normalized duplicate detection is stack-wide');

  const tooLong = profileCategoryAction(maintainer, 'rename', {
    name: '吃喝', next: '一二三四五六七八九十一二三四五六七八九十一',
  });
  assert.equal(tooLong.ok, false);
  assert.match(tooLong.error, /最多 20 字/u);
  const blank = profileCategoryAction(maintainer, 'rename', { name: '吃喝', next: '   ' });
  assert.equal(blank.ok, false);
  console.log(`13) renamed=${renamed.ok} category=${profile.get(a.id).category} duplicate=${duplicate.error} long=${tooLong.error} blank=${blank.error}`);
});

// ---- 14. merge: entries migrate, the source row is dropped, texts stay ---------------------

test('14. 合并：条目全部迁到目标（迁移数正确），源分类删除，条目内容不变', async (t) => {
  const { profile, make } = await freshReclassify(t);
  const maintainer = make([]);
  profile.upsert({ side: 'user', category: '运动', text: '用户每天跑步五公里' });
  profile.upsert({ side: 'user', category: '运动', text: '用户周末游泳' });
  profile.upsert({ side: 'user', category: '娱乐', text: '用户喜欢悬疑电影' });
  const beforeTexts = profile.list().map((entry) => entry.text).sort();

  const merged = profileCategoryAction(maintainer, 'merge', { from: '运动', into: '娱乐' });
  assert.equal(merged.ok, true);
  assert.equal(merged.moved, 2, 'two entries migrated');
  assert.equal(maintainer.categories().some((row) => row.name === '运动'), false, 'the source row is deleted');
  assert.equal(profile.list().length, 3, 'merge never deletes an entry');
  assert.deepEqual(profile.list().map((entry) => entry.text).sort(), beforeTexts, 'entry text is unchanged');
  assert.equal(profile.list().filter((entry) => entry.category === '娱乐').length, 3);

  const crossSide = profileCategoryAction(maintainer, 'merge', { from: '娱乐', into: '形象' });
  assert.equal(crossSide.ok, false);
  assert.match(crossSide.error, /同一侧/u);
  const self = profileCategoryAction(maintainer, 'merge', { from: '娱乐', into: '娱乐' });
  assert.equal(self.ok, false);
  console.log(`14) moved=${merged.moved} entertainmentEntries=${profile.list().filter((entry) => entry.category === '娱乐').length} sourceExists=${maintainer.categories().some((row) => row.name === '运动')} crossSide=${crossSide.error}`);
});

// ---- 15. delete: entries survive and fall back to the nearest same-side category ------------

test('15. 删除分类：条目不删除，回退到同侧最近分类；同侧最后一个 → CATEGORY_LAST', async (t) => {
  const { profile, make } = await freshReclassify(t);
  const maintainer = make([]);
  maintainer.applyCategoryOps([{ kind: 'add', name: '饮食偏好', parent: 'user', description: '' }]);
  const entry = profile.upsert({ side: 'user', category: '饮食偏好', text: '用户只喝无糖茶' }).entry;
  const total = profile.list().length;

  const deleted = profileCategoryAction(maintainer, 'delete', { name: '饮食偏好' });
  assert.equal(deleted.ok, true);
  assert.equal(deleted.fallback, '饮食', 'the nearest same-side category is 饮食');
  assert.equal(deleted.reassigned, 1);
  assert.equal(profile.list().length, total, 'the entry is not deleted');
  assert.equal(profile.get(entry.id).category, '饮食');
  assert.equal(profile.get(entry.id).text, '用户只喝无糖茶', 'the entry text is unchanged');
  assert.equal(maintainer.categories().some((row) => row.name === '饮食偏好'), false);

  // Leave exactly one user-side category, then the host refuses the last delete.
  const userRows = maintainer.categories().filter((row) => row.parent === 'user');
  for (const row of userRows.slice(1)) {
    assert.equal(profileCategoryAction(maintainer, 'delete', { name: row.name }).ok, true);
  }
  const last = maintainer.categories().filter((row) => row.parent === 'user');
  assert.equal(last.length, 1);
  const refused = profileCategoryAction(maintainer, 'delete', { name: last[0].name });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'CATEGORY_LAST');
  assert.equal(refused.error, '同一侧至少保留一个分类');
  assert.equal(profile.list().length, total, 'a refused delete touches no entry');
  assert.ok(maintainer.categories().some((row) => row.name === last[0].name), 'the last category stays');
  console.log(`15) deleted=${deleted.ok} fallback=${deleted.fallback} reassigned=${deleted.reassigned} entries=${profile.list().length} last=${refused.code}/${refused.error}`);
});

// ---- 16. UI: collapsed child container, inline editors, busy state, red error --------------

test('16. 分类管理面板：默认收起、行内改名/合并/删除、操作中禁用、错误红字', () => {
  const kit = loadProfileKit();
  const rows = [
    { name: '饮食', parent: 'user', count: 2, source: 'preset' },
    { name: '天气', parent: 'user', count: 1, source: 'model' },
    { name: '形象', parent: 'agent', count: 0, source: 'preset' },
  ];
  const profile = fixtureProfile({ categories: rows });
  const rowOf = (tree, name) => collect(tree, (node) => node.props?.['data-profile-category-row'] === name)[0];
  const buttonIn = (node, action) => collect(node, (item) => item.props?.['data-profile-category-action'] === action)[0];

  const closed = render(profile).tree;
  const toggle = collect(closed, (node) => node.props['data-profile-category-toggle'] === true)[0];
  assert.ok(toggle, 'the collapsible child container exists');
  assert.match(textOf(toggle), /分类管理（3）/u, 'the title carries the category count');
  assert.equal(collect(closed, (node) => node.props['data-profile-category-panel'] === true).length, 0,
    'it starts collapsed');

  const clicked = [];
  const wired = render(profile, {}, handlers({ toggleCategory: () => clicked.push('toggle') }));
  collect(wired.tree, (node) => node.props['data-profile-category-toggle'] === true)[0].props.onClick();
  assert.deepEqual(clicked, ['toggle'], 'the title toggles the panel');

  const openState = { open: true, rows, busy: '', error: '', note: '', editing: null, merging: null };
  const calls = [];
  const open = render(profile, { category: openState }, handlers({
    setCategoryName: (value) => calls.push(['name', value]),
    setCategoryTarget: (value) => calls.push(['target', value]),
    submitCategoryRename: (name) => calls.push(['rename-save', name]),
    submitCategoryMerge: (name) => calls.push(['merge-save', name]),
    submitCategoryDelete: (name) => calls.push(['delete', name]),
    startCategoryRename: (name) => calls.push(['rename', name]),
    startCategoryMerge: (name) => calls.push(['merge', name]),
    cancelCategoryEdit: () => calls.push(['cancel']),
  }));
  assert.equal(collect(open.tree, (node) => node.props['data-profile-category-row'] !== undefined).length, 3);
  assert.match(textOf(rowOf(open.tree, '饮食')), /饮食 画像 2 条 预设/u);
  assert.match(textOf(rowOf(open.tree, '天气')), /天气 画像 1 条 模型/u);
  assert.equal(buttonIn(rowOf(open.tree, '形象'), 'delete').props.disabled, true,
    'the last category of a side cannot be deleted');
  assert.equal(buttonIn(rowOf(open.tree, '饮食'), 'delete').props.disabled, false);
  buttonIn(rowOf(open.tree, '饮食'), 'rename').props.onClick();
  buttonIn(rowOf(open.tree, '饮食'), 'merge').props.onClick();
  buttonIn(rowOf(open.tree, '天气'), 'delete').props.onClick();
  assert.deepEqual(calls, [['rename', '饮食'], ['merge', '饮食'], ['delete', '天气']]);

  // Inline rename (input) and merge (select) replace the row buttons; no new page is opened.
  const renaming = render(profile, {
    category: { ...openState, editing: { name: '饮食', value: '吃喝' } },
  }, handlers({ setCategoryName: (value) => calls.push(['name', value]), submitCategoryRename: (name) => calls.push(['rename-save', name]) })).tree;
  const renameInput = collect(rowOf(renaming, '饮食'), (node) => node?.props?.['data-profile-category-input'] === 'rename')[0];
  assert.ok(renameInput, 'rename uses an inline input');
  assert.equal(renameInput.props.value, '吃喝');
  renameInput.props.onChange({ target: { value: '吃喝2' } });
  buttonIn(rowOf(renaming, '饮食'), 'rename-save').props.onClick();
  assert.deepEqual(calls.slice(-2), [['name', '吃喝2'], ['rename-save', '饮食']]);

  const merging = render(profile, {
    category: { ...openState, merging: { name: '饮食', into: '' } },
  }, handlers({ setCategoryTarget: (value) => calls.push(['target', value]), submitCategoryMerge: (name) => calls.push(['merge-save', name]) })).tree;
  const mergeSelect = collect(rowOf(merging, '饮食'), (node) => node?.props?.['data-profile-category-input'] === 'merge')[0];
  assert.ok(mergeSelect, 'merge uses an inline select');
  const options = collect(mergeSelect, (node) => node.type === 'option').map((node) => node.props.value);
  assert.deepEqual(options, ['', '天气'], 'only same-side categories can be merged into');
  assert.equal(buttonIn(rowOf(merging, '饮食'), 'merge-save').props.disabled, true, 'a target is required');
  mergeSelect.props.onChange({ target: { value: '天气' } });
  assert.deepEqual(calls.slice(-1), [['target', '天气']]);
  const mergeReady = render(profile, {
    category: { ...openState, merging: { name: '饮食', into: '天气' } },
  }, handlers({ submitCategoryMerge: (name) => calls.push(['merge-save', name]) })).tree;
  assert.equal(buttonIn(rowOf(mergeReady, '饮食'), 'merge-save').props.disabled, false);
  buttonIn(rowOf(mergeReady, '饮食'), 'merge-save').props.onClick();
  assert.deepEqual(calls.slice(-1), [['merge-save', '饮食']]);

  // Every row button is disabled while a category action runs.
  const busy = render(profile, {
    category: { ...openState, busy: 'rename', editing: { name: '饮食', value: '饮食' } },
  });
  assert.equal(buttonIn(rowOf(busy.tree, '饮食'), 'rename-save').props.disabled, true);
  assert.equal(buttonIn(rowOf(busy.tree, '天气'), 'rename').props.disabled, true);
  assert.equal(buttonIn(rowOf(busy.tree, '天气'), 'delete').props.disabled, true);
  assert.equal(collect(busy.tree, (node) => node.props['data-profile-category-toggle'] === true)[0].props.disabled,
    false, 'the panel itself stays open while an action runs');

  // Errors are red text inside the panel; CATEGORY_LAST gets the fixed wording.
  const failed = render(profile, { category: { ...openState, error: '名称已存在' } }).tree;
  const errorNode = collect(failed, (node) => node.props['data-profile-category-error'] === true)[0];
  assert.ok(errorNode, 'an error stays inside the panel');
  assert.match(textOf(errorNode), /名称已存在/u);
  assert.equal(kit.profileCategoryErrorText({ ok: false, code: 'CATEGORY_LAST', error: 'x' }), '同一侧至少保留一个分类');
  assert.equal(kit.profileCategoryErrorText({ ok: false, error: '名称已存在' }), '名称已存在');
  assert.equal(kit.profileCategorySourceLabel('model'), '模型');
  assert.equal(kit.profileCategorySourceLabel('preset'), '预设');

  const afterMerge = kit.profileCategoryResultState(
    { open: true, rows, busy: 'merge', editing: { name: '饮食', value: 'x' }, merging: { name: '饮食', into: '天气' } },
    { ok: true, moved: 2 }, { ok: true, categories: rows }, 'merge',
  );
  assert.equal(afterMerge.busy, '');
  assert.equal(afterMerge.editing, null);
  assert.equal(afterMerge.note, '已合并，迁移 2 条');
  const afterDelete = kit.profileCategoryResultState({}, { ok: true, reassigned: 1, fallback: '饮食' }, { ok: true, categories: rows }, 'delete');
  assert.equal(afterDelete.note, '已删除分类，1 条回退到「饮食」');
  const afterFail = kit.profileCategoryResultState({}, { ok: false, code: 'CATEGORY_LAST' }, { ok: true, categories: rows }, 'delete');
  assert.equal(afterFail.error, '同一侧至少保留一个分类');
  assert.equal(afterFail.open, true);
  console.log(`16) toggle="${textOf(toggle)}" rows=${rows.length} busyDisabled=${buttonIn(rowOf(busy.tree, '天气'), 'rename').props.disabled} error="${textOf(errorNode)}" deleteNote="${afterDelete.note}"`);
});
