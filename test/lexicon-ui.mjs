/**
 * 「记忆与人设 → 共享语言库」设置页回归。
 *
 * 与 test/audio-retention-ui.mjs 同一套做法：从 client.js 抽出真正发货的
 * `lexiconSpeakerId` / `lexiconObservedForms` / `lexiconSaveBody` / `lexiconDialogOf` /
 * `lexiconSection`，用记录型 `h` 求值 —— 不需要 DOM、React 或宿主。
 *
 * 固定的是用户实际能看见/点到的东西：
 *   1. 两组列表（有数据/空数据）、加载中；手动新建表单三字段+读音、类别/库位展示；
 *   2. 确认候选的请求体（speakerId 只从宿主状态取，字符串参数逐项核对）；
 *   3. 编辑弹窗预填三字段/读音 + lexicon.update 保存请求体；
 *   4. 删除/忽略都是两步确认，第一次点击不写；
 *   5. 未接线/读取失败/坏数据只显示错误，不抛出（含宿主当前不带 ok 的 list 形状）；
 *   6. client.js 接线检查（回归套件 audio-retention-ui / motion-presets-ui / hearing-ui /
 *      node test/smoke.mjs 单独执行，结果见交付说明）。
 *   7. 两步保存（P2，tests 7-9）：confirm 成功但补存误识别形式失败 → 弹窗保留并显示
 *      「已确认但误识别形式未保存：<原因>」+ [重试保存]；重试只发 lexicon.edit；取消重试时
 *      关闭并刷新，同时保留提示；confirm 失败/纯编辑成功保持原行为（不关闭 / 一次关闭）。
 *
 * Run: node --test test/lexicon-ui.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const clientSource = readFileSync(join(repoRoot, 'client.js'), 'utf8');

// The whole shipped block: helpers + section, up to Panel. Extracting from the first helper keeps
// the section's own dependencies (observed forms, dialog state, request bodies) under test.
const blockFrom = clientSource.indexOf('    function lexiconSpeakerId(');
const blockTo = clientSource.indexOf('    function Panel() {', blockFrom);
assert.ok(blockFrom > 0 && blockTo > blockFrom, 'client.js still ships the lexicon block before Panel');
const lexiconBlockSource = clientSource.slice(blockFrom, blockTo);

const styles = new Proxy({}, { get: (_target, key) => ({ marker: String(key) }) });
const lexicon = new Function(
  'styles',
  'BORDER',
  'DANGER',
  `${lexiconBlockSource}
return {
  lexiconSpeakerId, lexiconListData, lexiconObservedForms, lexiconDialogOf, lexiconSaveBody, lexiconSection,
  lexiconFailureReason, lexiconPartialNotice, lexiconWrongFormsBody,
  lexiconSaveSteps, lexiconRetryStep, settleLexiconSave, closeLexiconDialogState,
  lexiconEmptyDraft, lexiconAddBody, lexiconCategoryLabel, lexiconLibraryLabel,
};`,
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

const nodesOf = (tree) => {
  const nodes = [];
  walk(tree, (node) => nodes.push(node));
  return nodes;
};

const textsOf = (tree) => {
  const texts = [];
  walk(tree, (node) => {
    for (const child of node.children ?? []) if (typeof child === 'string') texts.push(child);
  });
  return texts;
};

const nodeOf = (tree, attr, value) => nodesOf(tree).find(
  (node) => String(node.props?.[attr] ?? '') === String(value),
);

const buttonOf = (tree, label) => {
  const found = nodesOf(tree).find(
    (node) => node.type === 'button' && (node.children ?? []).some((child) => child === label),
  );
  assert.ok(found !== undefined, `the section renders a «${label}» button`);
  return found;
};

const inputOf = (tree, predicate) => {
  const found = nodesOf(tree).find((node) => node.type === 'input' && predicate(node));
  assert.ok(found !== undefined, 'the expected input is rendered');
  return found;
};

const T0 = '2026-11-08T10:00:00.000Z';

const candidate = (overrides = {}) => ({
  id: 'cand-1',
  text: '向晚',
  canonical: '',
  wrongForms: [],
  kind: 'proper-noun',
  status: 'candidate',
  speakerId: null,
  assigned: false,
  context: { before: '', after: '' },
  sourceIds: ['u1', 'u2'],
  at: T0,
  ...overrides,
});

const word = (overrides = {}) => ({
  id: 'word-1',
  text: '向晚',
  canonical: '向晚',
  wrongForms: ['像晚', '想晚'],
  kind: 'proper-noun',
  category: 'person',
  usage: '角色名',
  reading: '',
  library: 'public',
  status: 'confirmed',
  speakerId: 'spk-1',
  assigned: true,
  context: { before: '今天', after: '来了' },
  confirmedAt: T0,
  at: T0,
  ...overrides,
});

/** One Panel-like mount: render inputs are explicit, every handler records and mimics Panel. */
const mount = (overrides = {}) => {
  const calls = {
    refresh: 0,
    openConfirm: [],
    openEdit: [],
    close: [],
    change: [],
    removeForm: [],
    save: [],
    retry: [],
    askIgnore: [],
    ignore: [],
    askRemove: [],
    remove: [],
    cancel: 0,
    changeDraft: [],
    add: [],
    move: [],
  };
  const state = {
    data: { entries: [], unassigned: [], loading: false, error: '' },
    busy: '',
    dialog: null,
    pending: null,
    speakerId: 'spk-1',
    draft: lexicon.lexiconEmptyDraft(),
    ...overrides,
  };
  const handlers = {
    refresh: () => { calls.refresh += 1; },
    openConfirm: (entry) => {
      calls.openConfirm.push(entry);
      state.pending = null;
      state.dialog = lexicon.lexiconDialogOf(entry, 'confirm');
    },
    openEdit: (entry) => {
      calls.openEdit.push(entry);
      state.pending = null;
      state.dialog = lexicon.lexiconDialogOf(entry, 'edit');
    },
    closeDialog: (dialog) => { calls.close.push(dialog); state.dialog = null; },
    changeDialog: (patch) => {
      calls.change.push(patch);
      state.dialog = state.dialog === null ? null : { ...state.dialog, ...patch, error: '' };
    },
    removeWrongForm: (index) => {
      calls.removeForm.push(index);
      if (state.dialog !== null) {
        state.dialog = {
          ...state.dialog,
          wrongForms: state.dialog.wrongForms.filter((_form, at) => at !== index),
        };
      }
    },
    saveDialog: (dialog, speakerId) => { calls.save.push([dialog, speakerId]); },
    retrySave: (dialog) => { calls.retry.push(dialog); },
    askIgnore: (id) => {
      calls.askIgnore.push(id);
      state.pending = { kind: 'ignore', id: String(id) };
    },
    ignore: (id) => { calls.ignore.push(id); state.pending = null; },
    askRemove: (id) => {
      calls.askRemove.push(id);
      state.pending = { kind: 'remove', id: String(id) };
    },
    remove: (id) => { calls.remove.push(id); state.pending = null; },
    cancelWrite: () => { calls.cancel += 1; state.pending = null; },
    changeDraft: (patch) => {
      calls.changeDraft.push(patch);
      state.draft = { ...state.draft, ...patch, error: '' };
    },
    add: (draft) => { calls.add.push(draft); },
    move: (id, library) => { calls.move.push([String(id), String(library)]); },
  };
  const render = () => lexicon.lexiconSection(h, {
    data: state.data,
    busy: state.busy,
    dialog: state.dialog,
    pending: state.pending,
    speakerId: state.speakerId,
    draft: state.draft,
  }, handlers);
  return { state, calls, render };
};

/** 假 act：按脚本逐次返回宿主结果，并记录每次 (body, tag)；第二步失败就是脚本里的 ok:false。 */
const makeAct = (results) => {
  const calls = [];
  const act = async (body, tag) => {
    calls.push({ body, tag });
    return results.shift();
  };
  return { act, calls };
};

/** 假 setLexiconDialog：支持函数式更新，`get()` 读当前弹窗（Panel 用同一种写法）。 */
const makeDialogState = (initial = null) => {
  let dialog = initial;
  const setDialog = (value) => {
    dialog = typeof value === 'function' ? value(dialog) : value;
  };
  return { setDialog, get: () => dialog, set: (value) => { dialog = value; } };
};

/** 记录 loadLexicon / show 的调用；某些分支不该刷新或提示时用会抛错的实现。 */
const makeEffects = () => {
  const seen = { refresh: 0, shown: [] };
  return {
    seen,
    loadLexicon: async () => { seen.refresh += 1; },
    show: (text) => { seen.shown.push(text); },
  };
};

// ---------------------------------------------------------------------------------------------
// 1. Both lists: rows with text/kind/occurrences/time, empty states, loading
// ---------------------------------------------------------------------------------------------
test('1. 两组列表：有数据渲染行，空数据与加载中各自有文案', () => {
  const view = mount({
    data: {
      unassigned: [
        candidate(),
        candidate({ id: 'cand-2', text: '阿晚', kind: 'correction', count: 5, sourceIds: [] }),
        // The backend keeps assigned-but-unconfirmed corrections in the visible list, marked
        // `assigned:true`; the card must render that row (and allow confirming it, no identity gate).
        candidate({
          id: 'cand-3', text: '林晚', kind: 'correction', assigned: true, speakerId: 'spk-1',
          wrongForms: ['林晚'], sourceIds: ['u3'],
        }),
      ],
      entries: [word(), word({ id: 'draft-1', status: 'candidate', canonical: '草稿', wrongForms: [] })],
      loading: false,
      error: '',
    },
  });
  const tree = view.render();
  const texts = textsOf(tree);

  assert.ok(texts.includes('待确认候选（3）'), 'the candidate header carries its count');
  assert.ok(texts.includes('共享词库（1）'), 'the confirmed header carries its count');
  assert.ok(texts.includes('向晚'), 'the candidate text is visible');
  assert.ok(texts.includes('林晚'), 'an assigned-but-unconfirmed candidate is visible too');
  assert.ok(texts.includes('专有名词'), 'the kind is labelled in Chinese');
  assert.ok(texts.includes('纠正'), 'a correction candidate shows its own kind');
  assert.ok(texts.some((text) => text.includes('出现 2 次')), 'evidence count comes from sourceIds');
  assert.ok(texts.some((text) => text.includes('出现 5 次')), 'an explicit count wins');
  assert.ok(texts.some((text) => text.includes('2026')), 'the occurrence time is rendered');
  assert.ok(texts.some((text) => text.includes('误识别形式：像晚 / 想晚')), 'wrong forms are listed');
  assert.ok(texts.some((text) => text.includes('确认于 2026')), 'the confirmation time is rendered');

  const rowA = nodeOf(tree, 'data-lexicon-candidate', 'cand-1');
  const rowB = nodeOf(tree, 'data-lexicon-candidate', 'cand-2');
  const rowC = nodeOf(tree, 'data-lexicon-candidate', 'cand-3');
  assert.ok(rowA !== undefined && rowB !== undefined, 'both candidates render their own row');
  assert.ok(rowC !== undefined, 'the assigned candidate is not dropped from the visible list');
  assert.equal(rowC.props['data-lexicon-candidate'], 'cand-3');
  assert.ok(buttonOf(rowC, '确认') !== undefined, 'an assigned candidate is still confirmable');
  assert.ok(buttonOf(rowA, '确认') !== undefined && buttonOf(rowA, '忽略') !== undefined);
  assert.ok(nodeOf(tree, 'data-lexicon-entry', 'word-1') !== undefined, 'the confirmed word has its row');
  assert.equal(nodeOf(tree, 'data-lexicon-entry', 'draft-1'), undefined,
    'a non-confirmed entry never appears in the personal lexicon');
  const wordRow = nodeOf(tree, 'data-lexicon-entry', 'word-1');
  assert.equal(wordRow.props['data-lexicon-library'], 'public');
  assert.ok(textsOf(wordRow).includes('人名'), 'the category is labelled in Chinese');
  assert.ok(textsOf(wordRow).includes('公共库'), 'the library slot is visible');
  assert.ok(textsOf(wordRow).includes('用法：角色名'), 'the usage is visible');
  assert.equal(buttonOf(wordRow, '移到声纹库').props.disabled, true,
    'move-to-voiceprint is disabled while the voiceprint library is not built');
  assert.match(String(buttonOf(wordRow, '移到声纹库').props.title), /声纹库尚未建立/u);

  const form = nodeOf(tree, 'data-lexicon-new-form', '1');
  assert.ok(form !== undefined, 'the manual add form is mounted');
  assert.equal(inputOf(form, (node) => node.props['data-lexicon-new-text'] === '1').props.value, '');
  assert.ok(nodesOf(form).some((node) => node.type === 'select'
    && node.props?.['data-lexicon-new-category'] === '1'), 'the category dropdown is present');
  assert.ok(nodesOf(form).some((node) => node.type === 'input'
    && node.props?.['data-lexicon-new-usage'] === '1'), 'the usage field is present');
  assert.ok(nodesOf(form).some((node) => node.type === 'input'
    && node.props?.['data-lexicon-new-reading'] === '1'), 'the optional reading field is present');
  assert.equal(buttonOf(form, '添加词条').props.disabled, true, 'empty text cannot be added');

  const empty = mount().render();
  assert.ok(textsOf(empty).includes('没有待确认的候选'), 'empty unassigned has its own text');
  assert.ok(textsOf(empty).includes('共享词库还是空的'), 'empty lexicon has its own text');
  assert.ok(textsOf(empty).includes('待确认候选（0）') && textsOf(empty).includes('共享词库（0）'));

  const loading = mount({ data: null }).render();
  assert.ok(textsOf(loading).includes('正在读取语言库…'), 'a null list renders the loading text');
  assert.ok(textsOf(mount({ data: { loading: true } }).render()).includes('正在读取语言库…'),
    'an explicit loading flag renders the same text');

  console.log('[lexicon-ui 1] unassigned=3 entries=1 assignedVisible=cand-3 empty=0/0 loading=正在读取语言库…');
});

// ---------------------------------------------------------------------------------------------
// 2. Confirm: speakerId comes from host status; body matches lexicon.confirm
// ---------------------------------------------------------------------------------------------
test('2. 确认候选：speakerId 可选，有则带、无则不带；没有身份按钮仍可用', async () => {
  assert.equal(lexicon.lexiconSpeakerId({ lexicon: { speakerId: 'spk-9', source: 'setting' } }), 'spk-9',
    'the authoritative status.lexicon.speakerId is the primary source');
  assert.equal(lexicon.lexiconSpeakerId({ lexicon: { speakerId: 'spk-9' } }), 'spk-9',
    'the host lexicon block is the primary source');
  assert.equal(lexicon.lexiconSpeakerId({
    lexicon: { speakerId: null, source: null },
    speaker: { lastShadow: { decision: 'match', speakerId: 'spk-5' } },
  }), 'spk-5', 'a null host identity falls back to the matched shadow');
  assert.equal(lexicon.lexiconSpeakerId({ speaker: { selfId: 'spk-8' } }), 'spk-8',
    'the speaker status self id is the fallback');
  assert.equal(lexicon.lexiconSpeakerId({ speaker: { speakerId: 'spk-7' } }), 'spk-7',
    'the speaker status id is accepted too');
  assert.equal(lexicon.lexiconSpeakerId({ speaker: { id: 'spk-6' } }), 'spk-6',
    'a bare speaker status id is the last fallback');
  assert.equal(lexicon.lexiconSpeakerId({ speaker: { lastShadow: { decision: 'match', speakerId: 'spk-5' } } }),
    'spk-5', 'a matched voiceprint shadow supplies the identity while no explicit field exists');
  assert.equal(lexicon.lexiconSpeakerId({ speaker: { lastShadow: { decision: 'unsure', speakerId: 'spk-5' } } }),
    '', 'an unsure shadow verdict is not an identity');
  assert.equal(lexicon.lexiconSpeakerId({
    lexicon: { speakerId: 'spk-9' },
    speaker: { lastShadow: { decision: 'match', speakerId: 'spk-5' } },
  }), 'spk-9', 'an explicit host id always wins over the shadow');
  assert.equal(lexicon.lexiconSpeakerId(null), '', 'no status → no identity');
  assert.equal(lexicon.lexiconSpeakerId({ lexicon: { speakerId: '  ' } }), '', 'blank is not an id');

  const correctionCandidate = candidate({ kind: 'correction', wrongForms: ['像晚', '想晚'] });
  assert.deepEqual(lexicon.lexiconObservedForms(candidate()), [],
    'a plain candidate has no recorded wrong form yet');
  assert.deepEqual(lexicon.lexiconObservedForms(correctionCandidate), ['像晚', '想晚'],
    'a correction candidate carries its recorded wrong forms');
  assert.deepEqual(
    lexicon.lexiconObservedForms({ kind: 'proper-noun', text: 'GTP4', canonical: 'GPT-4', wrongForms: [] }),
    ['GTP4'],
    'a confirmed spelling that differs from the raw text adds that raw text',
  );

  const view = mount({ speakerId: 'spk-9', data: { unassigned: [correctionCandidate], entries: [], error: '' } });
  const row = nodeOf(view.render(), 'data-lexicon-candidate', 'cand-1');
  assert.ok(row !== undefined);
  const confirmButton = buttonOf(row, '确认');
  assert.equal(confirmButton.props.disabled, false, 'with a host identity the confirm button is enabled');
  await confirmButton.props.onClick();
  assert.deepEqual(view.calls.openConfirm, [correctionCandidate], 'the row opens the dialog for that candidate');

  const dialogTree = view.render();
  const dialog = nodeOf(dialogTree, 'data-lexicon-dialog', 'confirm');
  assert.ok(dialog !== undefined, 'the confirm dialog is open');
  const canonicalInput = inputOf(dialog, (node) => node.props.value === '向晚');
  assert.equal(canonicalInput.props.value, '向晚', 'the dialog prefills the observed text as the spelling');
  assert.ok(textsOf(dialog).includes('像晚') && textsOf(dialog).includes('想晚'),
    'the recorded wrong forms are shown');
  assert.ok(textsOf(dialog).some((text) => text.includes('可删减')), 'the wrong-form block says it can be trimmed');

  await buttonOf(dialog, '确认').props.onClick();
  assert.equal(view.calls.save.length, 1, 'the dialog save handler ran once');
  const [savedDialog, savedSpeakerId] = view.calls.save[0];
  assert.equal(savedSpeakerId, 'spk-9', 'the dialog receives the speakerId taken from host status');

  const body = lexicon.lexiconSaveBody(savedDialog, savedSpeakerId);
  assert.deepEqual(body, {
    action: 'lexicon.confirm',
    speakerId: 'spk-9',
    id: 'cand-1',
    canonical: '向晚',
  }, 'a supplied speakerId is optional provenance and stays in the body');
  assert.ok(!('wrongForms' in body) && !('context' in body), 'confirm never sends edit-only fields');

  // Without an identity the request body must not carry speakerId at all (not an empty string).
  const anonymousBody = lexicon.lexiconSaveBody(savedDialog, '');
  assert.deepEqual(anonymousBody, {
    action: 'lexicon.confirm',
    id: 'cand-1',
    canonical: '向晚',
  }, 'no speakerId means the key is absent, not an empty string');

  const textOnly = lexicon.lexiconSaveBody({
    mode: 'confirm', id: '', text: '阿晚', canonical: '阿晚',
  }, 'spk-9');
  assert.deepEqual(textOnly, {
    action: 'lexicon.confirm', speakerId: 'spk-9', text: '阿晚', canonical: '阿晚',
  }, 'without an id the contract falls back to text');

  // The Panel resolves the identity from `/assistant/status` and the section never invents one.
  const selfId = lexicon.lexiconSpeakerId({ lexicon: { speakerId: 'spk-self', source: 'setting' } });
  assert.equal(selfId, 'spk-self');
  const statusView = mount({
    speakerId: selfId,
    data: {
      unassigned: [candidate({ id: 'cand-9', kind: 'correction', assigned: true, speakerId: 'spk-self' })],
      entries: [],
      error: '',
    },
  });
  const statusRow = nodeOf(statusView.render(), 'data-lexicon-candidate', 'cand-9');
  assert.ok(statusRow !== undefined, 'an assigned candidate from the host is rendered');
  assert.equal(buttonOf(statusRow, '确认').props.disabled, false,
    'a speakerId taken from status.lexicon enables the confirm button');
  await buttonOf(statusRow, '确认').props.onClick();
  assert.deepEqual(statusView.calls.openConfirm.map((entry) => entry.id), ['cand-9']);

  const anonymous = mount({ speakerId: '', data: { unassigned: [candidate()], entries: [], error: '' } });
  assert.equal(buttonOf(nodeOf(anonymous.render(), 'data-lexicon-candidate', 'cand-1'), '确认').props.disabled,
    false, 'without a host identity the confirm button is still enabled');
  anonymous.state.dialog = lexicon.lexiconDialogOf(candidate(), 'confirm');
  const anonymousDialog = nodeOf(anonymous.render(), 'data-lexicon-dialog', 'confirm');
  assert.equal(buttonOf(anonymousDialog, '确认').props.disabled, false,
    'the dialog can be saved without a host identity');

  console.log('[lexicon-ui 2] speakerId=spk-9 body=', JSON.stringify(body),
    'anonymousBody=', JSON.stringify(anonymousBody), 'no-identity-confirmEnabled=true');
});

// ---------------------------------------------------------------------------------------------
// 3. Edit dialog: prefill (spelling / wrong forms / context) and the save body
// ---------------------------------------------------------------------------------------------
test('3. 编辑弹窗：预填三字段/读音；保存走 lexicon.update 且不碰 status/wrongForms', async () => {
  const entry = word({ reading: 'xiàng wǎn' });
  const view = mount({ data: { unassigned: [], entries: [entry], error: '' } });
  const row = nodeOf(view.render(), 'data-lexicon-entry', 'word-1');
  assert.ok(row !== undefined);
  await buttonOf(row, '编辑').props.onClick();
  assert.deepEqual(view.calls.openEdit, [entry], 'the row opens edit for that entry');

  let dialog = nodeOf(view.render(), 'data-lexicon-dialog', 'edit');
  assert.ok(dialog !== undefined, 'the edit dialog is open');
  assert.equal(inputOf(dialog, (node) => node.props['data-lexicon-dialog-text'] === '1').props.value, '向晚',
    'the canonical spelling is prefilled');
  const categorySelect = nodesOf(dialog).find((node) => node.type === 'select'
    && node.props?.['data-lexicon-dialog-category'] === '1');
  assert.ok(categorySelect !== undefined, 'the category dropdown is shown in edit');
  assert.equal(categorySelect.props.value, 'person');
  assert.equal(inputOf(dialog, (node) => node.props['data-lexicon-dialog-usage'] === '1').props.value,
    '角色名', 'the usage is prefilled');
  assert.equal(inputOf(dialog, (node) => node.props['data-lexicon-dialog-reading'] === '1').props.value,
    'xiàng wǎn', 'the optional reading is prefilled');
  assert.ok(!nodesOf(dialog).some((node) => node.props?.['data-lexicon-remove-form'] !== undefined),
    'the main edit form no longer edits internal wrongForms');

  // Edit each field; the dialog must stay controlled.
  inputOf(dialog, (node) => node.props['data-lexicon-dialog-text'] === '1')
    .props.onChange({ target: { value: '向晚晚' } });
  assert.deepEqual(view.calls.change.at(-1), { canonical: '向晚晚' }, 'typing updates the dialog state');
  dialog = nodeOf(view.render(), 'data-lexicon-dialog', 'edit');
  nodesOf(dialog).find((node) => node.type === 'select'
    && node.props?.['data-lexicon-dialog-category'] === '1')
    .props.onChange({ target: { value: 'character' } });
  inputOf(dialog, (node) => node.props['data-lexicon-dialog-usage'] === '1')
    .props.onChange({ target: { value: '  角色别称  ' } });
  inputOf(dialog, (node) => node.props['data-lexicon-dialog-reading'] === '1')
    .props.onChange({ target: { value: 'xiàng wǎn wǎn' } });
  dialog = nodeOf(view.render(), 'data-lexicon-dialog', 'edit');

  await buttonOf(dialog, '保存修改').props.onClick();
  const [savedDialog, savedSpeakerId] = view.calls.save.at(-1);
  assert.equal(savedSpeakerId, 'spk-1', 'the section still passes the host identity');
  const body = lexicon.lexiconSaveBody(savedDialog, savedSpeakerId);
  assert.deepEqual(body, {
    action: 'lexicon.update',
    id: 'word-1',
    canonical: '向晚晚',
    category: 'character',
    usage: '角色别称',
    reading: 'xiàng wǎn wǎn',
  }, 'the edit body matches lexicon.update and carries no status/wrongForms');
  assert.ok(!('status' in body) && !('wrongForms' in body), 'status is never sent by the main form');

  console.log('[lexicon-ui 3] prefilled=向晚/person/角色名/xiàng wǎn body=', JSON.stringify(body));
});

// ---------------------------------------------------------------------------------------------
// 4. Delete and ignore are two-step; the first click never writes
// ---------------------------------------------------------------------------------------------
test('4. 忽略与删除都是两步确认，第一次点击不写入', async () => {
  const view = mount({
    data: { unassigned: [candidate({ sourceIds: [] })], entries: [word()], error: '' },
  });

  const candidateRow = () => nodeOf(view.render(), 'data-lexicon-candidate', 'cand-1');
  await buttonOf(candidateRow(), '忽略').props.onClick();
  assert.deepEqual(view.calls.askIgnore, ['cand-1'], 'the first click only asks');
  assert.deepEqual(view.calls.ignore, [], 'nothing is rejected yet');
  let row = candidateRow();
  assert.ok(textsOf(row).includes('确认忽略？'), 'the row switches to a confirmation');
  await buttonOf(row, '取消').props.onClick();
  assert.equal(view.calls.cancel, 1, 'cancel is its own action');
  assert.equal(view.state.pending, null, 'cancel drops the pending write');
  row = candidateRow();
  assert.equal(buttonOf(row, '忽略').props.disabled, false);

  await buttonOf(row, '忽略').props.onClick();
  await buttonOf(candidateRow(), '确认忽略').props.onClick();
  assert.deepEqual(view.calls.ignore, ['cand-1'], 'the second click performs the reject');
  assert.equal(view.state.pending, null);

  const wordRow = () => nodeOf(view.render(), 'data-lexicon-entry', 'word-1');
  await buttonOf(wordRow(), '删除').props.onClick();
  assert.deepEqual(view.calls.askRemove, ['word-1']);
  assert.deepEqual(view.calls.remove, [], 'nothing is removed by the first click');
  assert.ok(textsOf(wordRow()).includes('确认删除？'));
  await buttonOf(wordRow(), '确认删除').props.onClick();
  assert.deepEqual(view.calls.remove, ['word-1'], 'the second click performs the removal');

  const busy = mount({ busy: 'lexicon-reject', data: { unassigned: [candidate()], entries: [word()], error: '' } });
  assert.equal(buttonOf(nodeOf(busy.render(), 'data-lexicon-candidate', 'cand-1'), '忽略').props.disabled,
    true, 'a pending action disables the row buttons');

  console.log('[lexicon-ui 4] ignore=two-step remove=two-step cancel=1');
});

// ---------------------------------------------------------------------------------------------
// 5. Failure branch: unwired / unreadable / malformed data renders text, never throws
// ---------------------------------------------------------------------------------------------
test('5. 失败分支：未接线/坏数据只显示「语言库不可用」，不崩溃', () => {
  const contractShape = lexicon.lexiconListData({
    ok: true, entries: [word()], unassigned: [candidate()], candidates: [candidate()],
  });
  assert.deepEqual(contractShape, { entries: [word()], unassigned: [candidate()], loading: false, error: '' },
    'the documented {ok:true, entries, unassigned, candidates} shape is accepted');
  const bareShape = lexicon.lexiconListData({ entries: [], unassigned: [] });
  assert.deepEqual(bareShape, { entries: [], unassigned: [], loading: false, error: '' },
    'a host shape without ok (older backend) is still accepted');
  assert.equal(lexicon.lexiconListData({ ok: false, code: 'LEXICON_UNAVAILABLE' }).error,
    'LEXICON_UNAVAILABLE', 'an explicit ok:false is a failure');
  assert.equal(lexicon.lexiconListData({ ok: false, reason: 'not-found' }).error, 'not-found',
    'a store reason is surfaced instead of a generic message');
  assert.equal(lexicon.lexiconListData({}).error, '读取失败', 'a payload without lists is a failure');

  const failed = mount({
    data: { entries: [], unassigned: [], loading: false, error: 'LEXICON_UNAVAILABLE' },
  }).render();
  const failedTexts = textsOf(failed);
  assert.ok(failedTexts.some((text) => text.includes('语言库不可用：LEXICON_UNAVAILABLE')),
    'the host error is shown verbatim behind the documented prefix');
  assert.ok(failedTexts.includes('没有待确认的候选'), 'the lists still render their empty states');

  assert.doesNotThrow(() => mount({
    data: {
      unassigned: [{ id: null, text: null, kind: null, at: null }],
      entries: [{ id: 'broken', text: null, canonical: null, wrongForms: null, confirmedAt: null }],
      error: '',
    },
  }).render(), 'malformed rows render instead of throwing');
  const brokenTexts = textsOf(mount({
    data: { unassigned: [{ id: 'x', text: null }], entries: [], error: '' },
  }).render());
  assert.ok(brokenTexts.includes('（空）'), 'a missing text falls back to a placeholder');

  const dialogError = mount({
    dialog: {
      mode: 'edit', id: 'word-1', text: '向晚', canonical: '', wrongForms: [], observed: [],
      context: { before: '', after: '' }, error: 'canonical-empty',
    },
    data: { unassigned: [], entries: [word()], error: '' },
  }).render();
  assert.ok(textsOf(nodeOf(dialogError, 'data-lexicon-dialog', 'edit')).includes('canonical-empty'),
    'a failed save reason stays visible in the dialog');
  assert.equal(buttonOf(nodeOf(dialogError, 'data-lexicon-dialog', 'edit'), '保存修改').props.disabled,
    true, 'an empty spelling cannot be saved');

  const noData = mount({ data: { entries: [], unassigned: [], error: undefined } }).render();
  assert.ok(textsOf(noData).includes('共享词库还是空的'), 'an undefined error is not printed');

  console.log('[lexicon-ui 5] error=语言库不可用：LEXICON_UNAVAILABLE crash=no');
});

// ---------------------------------------------------------------------------------------------
// 6. client.js wiring + regressions: the section is mounted in 记忆与人设 and uses lexicon actions
// ---------------------------------------------------------------------------------------------
test('6. 接线检查：设置页挂载、八个动作、手动添加/移动与可选身份；确认无身份门槛', () => {
  assert.match(clientSource, /const \[lexiconData, setLexiconData\] = useState\(null\);/u);
  assert.match(clientSource, /const \[lexiconDialog, setLexiconDialog\] = useState\(null\);/u);
  assert.match(clientSource, /const \[lexiconPending, setLexiconPending\] = useState\(null\);/u);
  assert.match(clientSource, /const \[lexiconDraft, setLexiconDraft\] = useState\(\(\) => lexiconEmptyDraft\(\)\);/u,
    'the manual new-entry draft is its own state');
  assert.match(clientSource, /speakerId: lexiconSpeakerId\(status\)/u, 'the panel resolves the optional identity from status');
  assert.match(clientSource, /setLexiconData\(lexiconListData\(result\)\);/u,
    'the list parser handles both the documented and the bare host shape');
  assert.doesNotMatch(lexiconBlockSource, /speaker-required/u, 'the card no longer expects a speaker-required gate');
  const lexiconOnly = lexiconBlockSource.slice(
    lexiconBlockSource.indexOf('    function lexiconSection('),
    lexiconBlockSource.indexOf('    // ---- 声纹登记'),
  );
  assert.doesNotMatch(lexiconOnly, /selfId === ''/u,
    'no confirm button/dialog condition may gate on a missing selfId');

  for (const action of [
    'lexicon.list', 'lexicon.add', 'lexicon.update', 'lexicon.move',
    'lexicon.confirm', 'lexicon.edit', 'lexicon.reject', 'lexicon.remove',
  ]) {
    assert.ok(
      clientSource.includes(`'${action}'`),
      `client.js calls ${action}`,
    );
  }

  const mount = /(\n\s+)lexiconSection\(h, \{/u.exec(clientSource);
  const retentionMount = /(\n\s+)retentionSection\(h, \{/u.exec(clientSource);
  assert.ok(mount !== null && retentionMount !== null, 'both sections are mounted in the settings page');
  assert.ok(mount.index < retentionMount.index,
    '共享语言库 stays in 6、记忆与人设, above 音频保留 in 11、诊断与维护');
  assert.ok(clientSource.indexOf('    function lexiconSection(') > clientSource.indexOf('    function retentionSection('));

  assert.doesNotMatch(lexiconBlockSource, /fetch\(/u, 'the lexicon block never fetches by itself');
  // The rendering section stays pure; the two-step save flow takes `act` by injection and is
  // exercised directly by tests 7-9 (so this check is scoped to lexiconSection, not the block).
  const sectionFrom = lexiconBlockSource.indexOf('    function lexiconSection(');
  assert.ok(sectionFrom > 0, 'the block still ships the rendering section');
  assert.doesNotMatch(lexiconBlockSource.slice(sectionFrom), /\bact\(/u,
    'the rendering section has no host side effects; the save flow receives act by injection');
  assert.match(clientSource, /const body = lexiconSaveBody\(dialog, speakerId\);/u);
  assert.match(clientSource, /const firstTag = body\.action === 'lexicon\.edit'/u,
    'the edit/update/confirm modes pick their own act tag');
  assert.match(clientSource, /const result = await act\(body, tag\);/u,
    'ignore/remove share the same act() write path');
  assert.match(clientSource, /saveDialog: \(dialog, speakerId\) => void saveLexiconDialog\(dialog, speakerId\),/u,
    'the section passes the status-derived identity into the Panel save');
  assert.match(clientSource, /const second = await act\(lexiconWrongFormsBody\(dialog, entryId\), 'lexicon-edit'\);/u,
    'a trimmed confirm dialog is followed by one edit call');
  assert.match(clientSource, /const body = lexiconAddBody\(draft\);/u,
    'the new-entry form goes through the pure lexiconAddBody builder');
  assert.match(clientSource, /add: \(draft\) => void addLexiconEntry\(draft\),/u,
    'the section wires the manual add handler');
  assert.match(clientSource, /move: \(id, library\) => void moveLexicon\(id, library\),/u,
    'the section wires the library move handler');
  assert.match(clientSource, /action: 'lexicon\.move', id: String\(id\), library: String\(library\)/u,
    'the move handler sends the stable id and target library');
  assert.match(clientSource, /newDraft\?\.error/u, 'a failed manual add keeps its reason in the form');
  assert.match(clientSource, /if \(second\?\.ok !== true\) \{\s+return \{ stage: 'partial', entryId, notice:/u,
    'the second step result is inspected instead of ignored');
  assert.match(clientSource, /retrySave: \(dialog\) => void retryLexiconSave\(dialog\),/u,
    'a partial dialog wires its own retry handler');
  assert.match(clientSource, /const outcome = await lexiconRetryStep\(\{ dialog, act \}\);/u,
    'the retry runs the retry step, not the save step');
  assert.match(clientSource, /closeDialog: \(dialog\) => void closeLexiconDialog\(dialog\),/u,
    'closing a partial dialog keeps the dialog state so the Panel can refresh and hint');
  const retryFrom = clientSource.indexOf('    async function lexiconRetryStep(');
  const retryTo = clientSource.indexOf('    async function settleLexiconSave(', retryFrom);
  assert.ok(retryFrom > 0 && retryTo > retryFrom, 'the retry step is its own shipped function');
  assert.doesNotMatch(clientSource.slice(retryFrom, retryTo), /lexicon\.confirm/u,
    'the retry never repeats the confirmation');
  assert.doesNotMatch(clientSource.slice(retryFrom, retryTo), /saveLexiconDialog/u,
    'the retry never goes back through the two-step save');

  console.log('[lexicon-ui 6] mounted=记忆与人设 actions=8 add/move=wired speakerId=status retry=edit-only');
});

// ---------------------------------------------------------------------------------------------
// 7. P2: confirm ok + the follow-up edit fails → the dialog stays open with partial success
// ---------------------------------------------------------------------------------------------
test('7. confirm 成功 + 补存 edit 失败：弹窗保留、显示部分成功、内容不丢', async () => {
  const base = lexicon.lexiconDialogOf(
    candidate({ kind: 'correction', wrongForms: ['像晚', '想晚'] }), 'confirm');
  const trimmed = { ...base, wrongForms: ['想晚'] }; // 用户在弹窗里删掉了一条误识别形式
  const { act, calls } = makeAct([
    { ok: true, entry: { id: 'cand-1' } },
    { ok: false, reason: 'write-failed' }, // 审查复现的真实回调：第二步 write-failed
  ]);
  const outcome = await lexicon.lexiconSaveSteps({ dialog: trimmed, speakerId: 'spk-1', act });

  assert.equal(calls.length, 2, 'confirm then the follow-up edit both run');
  assert.deepEqual(calls[0].body, {
    action: 'lexicon.confirm', speakerId: 'spk-1', id: 'cand-1', canonical: '向晚',
  });
  assert.deepEqual(calls[1].body, { action: 'lexicon.edit', id: 'cand-1', wrongForms: ['想晚'] },
    'the second step saves only the forms the user kept');
  assert.equal(calls[1].tag, 'lexicon-edit');
  assert.equal(outcome.stage, 'partial', 'the failed second step is not swallowed');
  assert.equal(outcome.entryId, 'cand-1');
  assert.equal(outcome.notice, '已确认但误识别形式未保存：write-failed');

  const effects = makeEffects();
  const ui = makeDialogState(trimmed);
  await lexicon.settleLexiconSave({
    dialog: trimmed, outcome, setDialog: ui.setDialog,
    loadLexicon: effects.loadLexicon, show: effects.show,
  });
  const kept = ui.get();
  assert.ok(kept !== null && kept !== undefined, 'the dialog is NOT closed');
  assert.equal(kept.retryId, 'cand-1', 'the confirmed entry id is kept for the retry');
  assert.equal(kept.notice, '已确认但误识别形式未保存：write-failed');
  assert.deepEqual(kept.wrongForms, ['想晚'], 'the trimmed content survives the failure');
  assert.equal(kept.canonical, '向晚');
  assert.equal(effects.seen.refresh, 1, 'the confirmed state is refreshed in the list');
  assert.deepEqual(effects.seen.shown, [], 'no full-success toast');

  // Render: notice + retry button; the user's content is still in the inputs.
  const view = mount({ dialog: kept, data: { unassigned: [], entries: [word()], error: '' } });
  const node = nodeOf(view.render(), 'data-lexicon-dialog', 'confirm');
  assert.ok(node !== undefined, 'the confirm dialog is still rendered');
  assert.equal(node.props['data-lexicon-partial'], '1');
  assert.ok(textsOf(node).includes('已确认但误识别形式未保存：write-failed'),
    'the partial reason is visible');
  assert.equal(inputOf(node, (item) => item.props.value === '向晚').props.value, '向晚',
    'the spelling field is preserved');
  assert.ok(textsOf(node).includes('想晚'), 'the kept wrong form is still listed');
  assert.ok(!textsOf(node).includes('像晚'), 'the removed wrong form stays removed');
  const retry = buttonOf(node, '重试保存');
  assert.equal(retry.props.disabled, false, 'the retry is available');
  buttonOf(node, '关闭');
  assert.ok(!nodesOf(node).some((item) => item.type === 'button' && (item.children ?? []).includes('确认')),
    'the partial dialog cannot run the confirm step again');
  await retry.props.onClick();
  assert.equal(view.calls.save.length, 0, 'the retry button does not use the save path');
  assert.deepEqual(view.calls.retry, [kept], 'the retry receives the current (re-trimmed) dialog');

  console.log('[lexicon-ui 7] first=confirm(ok) second=edit(write-failed) stage=partial open=yes',
    'notice=已确认但误识别形式未保存：write-failed content=[想晚] refresh=1');
});

// ---------------------------------------------------------------------------------------------
// 8. Retry: only lexicon.edit (never confirm); success closes + refreshes, failure stays open
// ---------------------------------------------------------------------------------------------
test('8. 点击[重试保存] 只调用 lexicon.edit：成功关闭并刷新，失败留在弹窗', async () => {
  const base = lexicon.lexiconDialogOf(
    candidate({ kind: 'correction', wrongForms: ['像晚', '想晚'] }), 'confirm');
  const partial = {
    ...base,
    wrongForms: ['想晚'],
    retryId: 'cand-1',
    notice: '已确认但误识别形式未保存：write-failed',
  };

  const { act, calls } = makeAct([{ ok: true, entry: { id: 'cand-1' } }]);
  const effects = makeEffects();
  const ui = makeDialogState(partial);
  const outcome = await lexicon.lexiconRetryStep({ dialog: partial, act });

  assert.equal(calls.length, 1, 'the retry performs exactly one write');
  assert.equal(calls[0].body.action, 'lexicon.edit');
  assert.deepEqual(calls[0].body, { action: 'lexicon.edit', id: 'cand-1', wrongForms: ['想晚'] });
  assert.equal(calls[0].tag, 'lexicon-edit');
  assert.equal(outcome.stage, 'done');

  await lexicon.settleLexiconSave({
    dialog: partial, outcome, setDialog: ui.setDialog,
    loadLexicon: effects.loadLexicon, show: effects.show,
  });
  assert.equal(ui.get(), null, 'a successful retry closes the dialog');
  assert.equal(effects.seen.refresh, 1, 'a successful retry refreshes the list');
  assert.deepEqual(effects.seen.shown, ['已确认「向晚」']);

  // A failing retry keeps the dialog with the fresh reason and the same retry id.
  const fail = makeAct([{ ok: false, reason: 'not-found' }]);
  ui.set(partial);
  const failed = await lexicon.lexiconRetryStep({ dialog: partial, act: fail.act });
  assert.equal(failed.stage, 'partial');
  assert.equal(failed.notice, '已确认但误识别形式未保存：not-found');
  assert.equal(fail.calls.length, 1, 'a failing retry does not loop by itself');
  await lexicon.settleLexiconSave({
    dialog: partial, outcome: failed, setDialog: ui.setDialog,
    loadLexicon: effects.loadLexicon, show: effects.show,
  });
  assert.ok(ui.get() !== null, 'the dialog stays open after a failed retry');
  assert.equal(ui.get().notice, '已确认但误识别形式未保存：not-found');
  assert.equal(ui.get().retryId, 'cand-1');

  // Without a confirmed entry id there is nothing to retry, and nothing is written.
  const skipped = await lexicon.lexiconRetryStep({ dialog: { ...base }, act: fail.act });
  assert.equal(skipped.stage, 'skipped');
  assert.equal(fail.calls.length, 1, 'no write is attempted without a confirmed id');

  console.log('[lexicon-ui 8] retryCalls=1 action=lexicon.edit closed=yes refresh=1',
    'retryFail=partial open=yes retryId=cand-1 skipped=no-write');
});

// ---------------------------------------------------------------------------------------------
// 9. Regressions: confirm failure stays open, edit closes once, cancelling a partial keeps a hint
// ---------------------------------------------------------------------------------------------
test('9. 回归：confirm 失败不关闭；编辑成功只关一次；取消重试刷新并保留提示', async () => {
  const base = lexicon.lexiconDialogOf(
    candidate({ kind: 'correction', wrongForms: ['像晚', '想晚'] }), 'confirm');
  const trimmed = { ...base, wrongForms: ['想晚'] };

  // confirm failed: the error stays in the dialog; nothing refreshes and nothing toasts.
  const denied = makeAct([{ ok: false, reason: 'write-failed' }]);
  const ui = makeDialogState(trimmed);
  const failed = await lexicon.lexiconSaveSteps({ dialog: trimmed, speakerId: '', act: denied.act });
  assert.equal(failed.stage, 'failed');
  assert.equal(denied.calls.length, 1, 'a failed confirm never reaches the second step');
  assert.ok(!('speakerId' in denied.calls[0].body), 'no identity means no speakerId field in the request');
  await lexicon.settleLexiconSave({
    dialog: trimmed,
    outcome: failed,
    setDialog: ui.setDialog,
    loadLexicon: async () => { throw new Error('a failed confirm must not refresh'); },
    show: () => { throw new Error('a failed confirm must not toast'); },
  });
  assert.ok(ui.get() !== null, 'the dialog stays open');
  assert.equal(ui.get().error, 'write-failed');
  const failNode = nodeOf(mount({
    dialog: ui.get(), data: { unassigned: [], entries: [word()], error: '' },
  }).render(), 'data-lexicon-dialog', 'confirm');
  assert.ok(textsOf(failNode).includes('write-failed'), 'the host reason is visible');

  // edit mode: one write, one close, one refresh.
  const editDialog = lexicon.lexiconDialogOf(word(), 'edit');
  const single = makeAct([{ ok: true, entry: { id: 'word-1' } }]);
  const editUi = makeDialogState(editDialog);
  const effects = makeEffects();
  const done = await lexicon.lexiconSaveSteps({ dialog: editDialog, speakerId: 'spk-1', act: single.act });
  assert.equal(done.stage, 'done');
  assert.equal(single.calls.length, 1, 'an edit dialog writes exactly once');
  assert.equal(single.calls[0].body.action, 'lexicon.update');
  assert.deepEqual(single.calls[0].body, {
    action: 'lexicon.update',
    id: 'word-1',
    canonical: '向晚',
    category: 'person',
    usage: '角色名',
    reading: '',
  }, 'the edit dialog updates the main fields only');
  assert.equal(single.calls[0].tag, 'lexicon-update');
  await lexicon.settleLexiconSave({
    dialog: editDialog, outcome: done, setDialog: editUi.setDialog,
    loadLexicon: effects.loadLexicon, show: effects.show,
  });
  assert.equal(editUi.get(), null, 'the dialog closes once');
  assert.equal(effects.seen.refresh, 1);
  assert.deepEqual(effects.seen.shown, ['词库已更新']);

  // confirm ok + nothing trimmed: one write, one close.
  const plain = { ...base, wrongForms: ['像晚', '想晚'] };
  const keep = makeAct([{ ok: true, entry: { id: 'cand-1' } }]);
  const plainUi = makeDialogState(plain);
  const plainEffects = makeEffects();
  const keptOutcome = await lexicon.lexiconSaveSteps({
    dialog: plain, speakerId: 'spk-1', act: keep.act,
  });
  assert.equal(keptOutcome.stage, 'done');
  assert.equal(keep.calls.length, 1, 'an untouched confirm does not call edit');
  await lexicon.settleLexiconSave({
    dialog: plain, outcome: keptOutcome, setDialog: plainUi.setDialog,
    loadLexicon: plainEffects.loadLexicon, show: plainEffects.show,
  });
  assert.equal(plainUi.get(), null);
  assert.deepEqual(plainEffects.seen.shown, ['已确认「向晚」']);

  // Cancel a partial dialog: close + refresh + keep the "not saved" hint.
  const partial = {
    ...trimmed, retryId: 'cand-1', notice: '已确认但误识别形式未保存：write-failed',
  };
  const cancelUi = makeDialogState(partial);
  const cancelEffects = makeEffects();
  const view = mount({ dialog: partial, data: { unassigned: [], entries: [word()], error: '' } });
  await buttonOf(nodeOf(view.render(), 'data-lexicon-dialog', 'confirm'), '关闭').props.onClick();
  assert.deepEqual(view.calls.close, [partial], 'the close handler receives the partial dialog');
  assert.equal(view.calls.save.length + view.calls.retry.length, 0, 'closing writes nothing');
  await lexicon.closeLexiconDialogState({
    dialog: partial, setDialog: cancelUi.setDialog,
    loadLexicon: cancelEffects.loadLexicon, show: cancelEffects.show,
  });
  assert.equal(cancelUi.get(), null, 'closing a partial dialog closes it');
  assert.equal(cancelEffects.seen.refresh, 1, 'closing refreshes the now-confirmed list');
  assert.deepEqual(cancelEffects.seen.shown, ['已确认「向晚」，误识别形式未保存']);

  // A normal cancel (no partial state) stays silent and does not refresh.
  const normalUi = makeDialogState(base);
  const normalEffects = makeEffects();
  await lexicon.closeLexiconDialogState({
    dialog: base, setDialog: normalUi.setDialog,
    loadLexicon: normalEffects.loadLexicon, show: normalEffects.show,
  });
  assert.equal(normalUi.get(), null);
  assert.equal(normalEffects.seen.refresh, 0);
  assert.deepEqual(normalEffects.seen.shown, []);

  console.log('[lexicon-ui 9] confirmFail=open(no-refresh) edit=one-write close=1',
    'partialCancel=refresh+hint plainCancel=silent');
});

// ---------------------------------------------------------------------------------------------
// 10. Manual add form + library move + candidate delete
// ---------------------------------------------------------------------------------------------
test('10. 手动新建：三字段+读音请求体；库位移动；候选删除保留', async () => {
  const view = mount({
    draft: {
      text: '充电', category: 'expression',
      usage: '指陪我聊一会，不是给设备充电', reading: 'chōng diàn', error: '',
    },
    data: { unassigned: [], entries: [], error: '' },
  });
  const form = nodeOf(view.render(), 'data-lexicon-new-form', '1');
  assert.ok(form !== undefined);
  assert.equal(buttonOf(form, '添加词条').props.disabled, false, 'a filled three-field form can add');
  await buttonOf(form, '添加词条').props.onClick();
  assert.equal(view.calls.add.length, 1);
  const draft = view.calls.add[0];
  assert.deepEqual(lexicon.lexiconAddBody(draft), {
    action: 'lexicon.add',
    text: '充电',
    category: 'expression',
    usage: '指陪我聊一会，不是给设备充电',
    reading: 'chōng diàn',
  }, 'the add body carries the three fields plus optional reading, no speakerId');
  assert.equal(lexicon.lexiconCategoryLabel('expression'), '特殊表达');
  assert.equal(lexicon.lexiconLibraryLabel('public'), '公共库');
  assert.equal(lexicon.lexiconLibraryLabel('voiceprint'), '声纹库');

  // The form is disabled while the word is blank; changing the draft goes through the handler.
  const blank = mount({ data: { unassigned: [], entries: [], error: '' } });
  const blankForm = nodeOf(blank.render(), 'data-lexicon-new-form', '1');
  assert.equal(buttonOf(blankForm, '添加词条').props.disabled, true);
  inputOf(blankForm, (node) => node.props['data-lexicon-new-text'] === '1')
    .props.onChange({ target: { value: '充电' } });
  assert.deepEqual(blank.calls.changeDraft.at(-1), { text: '充电' });
  const select = nodesOf(blankForm).find((node) => node.type === 'select'
    && node.props?.['data-lexicon-new-category'] === '1');
  select.props.onChange({ target: { value: 'term' } });
  assert.deepEqual(blank.calls.changeDraft.at(-1), { category: 'term' });

  // Library move: public -> voiceprint is disabled until a voiceprint library exists; a stored
  // voiceprint row can always be moved back to public.
  const publicView = mount({ data: { unassigned: [], entries: [word()], error: '' } });
  const publicRow = nodeOf(publicView.render(), 'data-lexicon-entry', 'word-1');
  assert.equal(buttonOf(publicRow, '移到声纹库').props.disabled, true);
  const voiceprintView = mount({
    data: { unassigned: [], entries: [word({ library: 'voiceprint' })], error: '' },
  });
  const voiceprintRow = nodeOf(voiceprintView.render(), 'data-lexicon-entry', 'word-1');
  await buttonOf(voiceprintRow, '移到公共库').props.onClick();
  assert.deepEqual(voiceprintView.calls.move, [['word-1', 'public']]);

  // Candidate delete is still available (in addition to the tombstone-producing ignore).
  const candidateView = mount({ data: { unassigned: [candidate()], entries: [], error: '' } });
  const candidateRow = () => nodeOf(candidateView.render(), 'data-lexicon-candidate', 'cand-1');
  await buttonOf(candidateRow(), '删除').props.onClick();
  assert.deepEqual(candidateView.calls.askRemove, ['cand-1']);
  assert.deepEqual(candidateView.calls.remove, [], 'the first click only asks');
  await buttonOf(candidateRow(), '确认删除').props.onClick();
  assert.deepEqual(candidateView.calls.remove, ['cand-1']);

  console.log('[lexicon-ui 10] addBody=', JSON.stringify(lexicon.lexiconAddBody(draft)),
    'move=', JSON.stringify(voiceprintView.calls.move), 'candidateDelete=two-step');
});
