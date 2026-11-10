/**
 * 声纹卡片主次与候选空状态 / 动作（纯客户端）。
 *
 *   1. 候选区在「登记状态」之后、旧登记记录（折叠区）之前渲染；
 *   2. 0 候选时仍显示「刷新候选」，且「建立基础声纹」「强化」的禁用原因可见；
 *   3. 有候选时试听 / 勾选 / 删除 / 清空 / 预览一致性 / 建立基础声纹 / 强化 / 重命名 / 回滚均可用；
 *   4. 旧登记条目的确认 / 拒绝 / 删除仍保留，并被标为「旧登记记录（兼容）」。
 *
 * 与 client-speaker-enrollment 一样，直接求值 client.js 里真实发货的声纹区块，
 * 用记录型 `h` 检查渲染顺序与按钮回调，不需要 DOM、React 或宿主。
 *
 * Run: node --test test/speaker-candidate-ui-order.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, '..');
const clientSource = readFileSync(join(projectRoot, 'client.js'), 'utf8');

const BLOCK_FROM = clientSource.indexOf('    const SPEAKER_ENROLL_READ_TIMEOUT_MS');
const BLOCK_TO = clientSource.indexOf('    // ---- P-111 客户端诊断', BLOCK_FROM);
assert.ok(BLOCK_FROM > 0 && BLOCK_TO > BLOCK_FROM, 'client.js ships the speaker block before diagnostics');
const block = clientSource.slice(BLOCK_FROM, BLOCK_TO);

const h = (type, props, ...children) => ({ type, props: props ?? {}, children });
const styles = new Proxy({}, { get: (_target, key) => ({ marker: String(key) }) });

const load = () => new Function(
  'styles', 'DANGER', 'fetch', 'setTimeout', 'clearTimeout', 'AbortController',
  `${block}
return {
  speakerEnrollSection,
  speakerCandidateSection,
  speakerCandidateView,
  speakerEnrollView,
  SPEAKER_ENROLL_RECORD_HINT,
  SPEAKER_CANDIDATE_NOTICE,
};`,
)(styles, '#c92a2a', async () => { throw new Error('unexpected request'); }, setTimeout, clearTimeout, AbortController);

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
const buttonOf = (tree, label) => {
  const found = nodesOf(tree).find(
    (node) => node.type === 'button' && (node.children ?? []).some((child) => child === label),
  );
  assert.ok(found !== undefined, `the card renders a «${label}» button`);
  return found;
};
const nodeWithProp = (tree, key, value = 'true') => nodesOf(tree).find(
  (node) => node.props?.[key] === value,
);

const entryOf = (overrides = {}) => ({
  speakerId: 'self-lin',
  label: '本人',
  status: 'pending',
  samples: 3,
  totalDurationMs: 3200,
  confirmedAt: '',
  ...overrides,
});
const listOf = (overrides = {}) => ({ ok: true, selfId: 'self-lin', entries: [entryOf()], ...overrides });
const shadowOf = (overrides = {}) => ({
  ok: true,
  lastShadow: {
    decision: 'match', class: 'self', quality: 'ok', score: 0.87,
    speakerId: 'self-lin', at: '2026-11-11T02:00:00.000Z',
  },
  counts: { match: 2, mismatch: 1, unsure: 1 },
  ...overrides,
});
const dataOf = (list = listOf(), shadow = shadowOf(), extra = {}) => ({
  list, shadow, loading: false, error: '', at: 1_700_000_000_000, ...extra,
});

const candidateOf = (id, overrides = {}) => ({
  id,
  durationMs: 1200,
  at: '2026-11-11T02:00:00.000Z',
  text: `候选 ${id}`,
  audioAvailable: true,
  groupId: 'g1',
  ...overrides,
});
const templateOf = (overrides = {}) => ({
  ok: true,
  currentVersion: 2,
  versions: [
    {
      version: 2, sampleCount: 3, totalDurationMs: 3600, createdAt: '', reason: 'initial',
    },
    {
      version: 1, sampleCount: 2, totalDurationMs: 2400, createdAt: '', reason: 'initial',
    },
  ],
  ...overrides,
});
const candidateDataOf = (candidates, extra = {}) => ({
  list: {
    ok: true,
    count: candidates.length,
    groupCount: candidates.length === 0 ? 0 : 1,
    candidates,
    library: { present: true, label: '我的声音', enabled: true },
    template: templateOf(),
    ...(extra.list ?? {}),
  },
  loading: false,
  error: '',
  ...(extra.data ?? {}),
});

const baseProps = () => ({
  data: dataOf(),
  busy: false,
  notice: '',
  onRefresh: () => {},
  onRecord: () => {},
  onConfirm: () => {},
  onReject: () => {},
  onRemove: () => {},
  onCopy: () => {},
  candidateData: candidateDataOf([]),
  candidateBusy: false,
  candidateSelection: [],
  candidateAudio: {},
  candidatePreview: null,
  candidateNotice: null,
  label: '',
  shadowEnabled: false,
  onCandidateRefresh: () => {},
  onCandidateToggle: () => {},
  onCandidateAudio: () => {},
  onCandidateRemove: () => {},
  onCandidateClear: () => {},
  onCandidatePreview: () => {},
  onCandidateBuild: () => {},
  onTemplateStrengthen: () => {},
  onCandidateRename: () => {},
  onCandidateLabel: () => {},
  rollbackAsk: null,
  onTemplateRollbackAsk: () => {},
  onTemplateRollbackCancel: () => {},
  onTemplateRollback: () => {},
});

const sectionOf = (api, extra = {}) => api.speakerEnrollSection(h, { ...baseProps(), ...extra });

// ---------------------------------------------------------------------------
// 1. candidate section before the legacy enrolment section
// ---------------------------------------------------------------------------
test('1. 候选区在登记状态之后、旧登记记录之前', () => {
  const api = load();
  const tree = sectionOf(api, {
    candidateData: candidateDataOf([candidateOf('spc-1')]),
    shadowEnabled: true,
  });
  const nodes = nodesOf(tree);
  const indexOfGroup = (id) => nodes.findIndex((node) => node.props?.['data-settings-group'] === id);
  const candidateIndex = indexOfGroup('speaker-candidates');
  const legacyIndex = indexOfGroup('speaker-enroll-legacy');
  assert.ok(candidateIndex > 0, 'the candidate group renders');
  assert.ok(legacyIndex > candidateIndex, 'the legacy block renders after the candidates');

  const statusIndex = nodes.findIndex((node) => (node.children ?? []).includes('登记状态'));
  assert.ok(statusIndex > 0, 'the status block renders');
  assert.ok(candidateIndex > statusIndex, 'candidates come after the status block');

  const legacySummaryIndex = nodes.findIndex(
    (node) => node.type === 'summary' && (node.children ?? []).some(
      (child) => typeof child === 'string' && child.includes('旧登记记录（兼容）'),
    ),
  );
  assert.ok(legacySummaryIndex > candidateIndex, 'the legacy summary is below the candidates');
  const legacy = nodes[legacyIndex];
  assert.equal(
    nodesOf(legacy).some((node) => node.props?.['data-settings-group'] === 'speaker-candidates'),
    false,
    'the candidate section is not nested inside the collapsed legacy block',
  );

  console.log(`[1] status<${candidateIndex} candidates<${legacySummaryIndex} legacySummary`);
});

// ---------------------------------------------------------------------------
// 2. empty candidates: refresh is present and disabled reasons are visible
// ---------------------------------------------------------------------------
test('2. 0 候选：显示刷新入口、空状态与建立/强化禁用原因', () => {
  const api = load();
  const tree = sectionOf(api, {
    candidateData: candidateDataOf([], { list: { template: { ok: true, currentVersion: null, versions: [] } } }),
    shadowEnabled: false,
  });

  const refresh = buttonOf(tree, '刷新候选');
  assert.equal(refresh.props.disabled, false, 'refresh stays available with 0 candidates');
  assert.equal(refresh.props['data-speaker-candidate-refresh'], 'true');

  const empty = nodeWithProp(tree, 'data-speaker-candidate-empty');
  assert.ok(empty !== undefined, 'the explicit empty state renders');
  assert.ok(textsOf(tree).some((text) => text.includes('还没有声纹候选')));
  assert.ok(textsOf(tree).some((text) => text.includes('去「听觉」页开启「声纹影子」')));

  const build = buttonOf(tree, '建立基础声纹');
  assert.equal(build.props.disabled, true);
  const buildReason = nodeWithProp(tree, 'data-speaker-candidate-build-reason');
  assert.ok(buildReason !== undefined, 'the build refusal reason is visible, not only a title');
  assert.ok(textsOf(buildReason).join('').includes('还没有候选'));

  const strengthen = buttonOf(tree, '强化当前声纹');
  assert.equal(strengthen.props.disabled, true);
  const strengthenReason = nodeWithProp(tree, 'data-speaker-candidate-strengthen-reason');
  assert.ok(strengthenReason !== undefined);
  assert.ok(textsOf(strengthenReason).join('').includes('还没有基础声纹版本'));

  assert.equal(buttonOf(tree, '清空候选').props.disabled, true, 'nothing to clear');
  console.log('[2] empty=true refresh=true buildReason=true strengthenReason=true');
});

// ---------------------------------------------------------------------------
// 3. candidates: every explicit action stays wired
// ---------------------------------------------------------------------------
test('3. 有候选：试听/勾选/删除/清空/预览/建立/强化/重命名/回滚可用', () => {
  const api = load();
  const candidates = [candidateOf('spc-1'), candidateOf('spc-2')];
  const calls = {
    refresh: 0, toggle: [], audio: [], remove: [], clear: 0,
    preview: [], build: [], strengthen: [], rename: [], rollback: [],
  };
  const tree = sectionOf(api, {
    candidateData: candidateDataOf(candidates),
    candidateSelection: ['spc-1'],
    candidateAudio: { 'spc-1': 'data:audio/wav;base64,AA==' },
    label: '我的声音',
    rollbackAsk: 1,
    onCandidateRefresh: () => { calls.refresh += 1; },
    onCandidateToggle: (id, checked) => calls.toggle.push([id, checked]),
    onCandidateAudio: (id) => calls.audio.push(id),
    onCandidateRemove: (id) => calls.remove.push(id),
    onCandidateClear: () => { calls.clear += 1; },
    onCandidatePreview: (ids) => calls.preview.push([...ids]),
    onCandidateBuild: (ids, label) => calls.build.push([[...ids], label]),
    onTemplateStrengthen: (ids, label) => calls.strengthen.push([[...ids], label]),
    onCandidateRename: (label) => calls.rename.push(label),
    onTemplateRollback: (version) => calls.rollback.push(version),
  });

  assert.equal(buttonOf(tree, '试听').props.disabled, false);
  assert.equal(buttonOf(tree, '删除').props.disabled, false);
  assert.equal(buttonOf(tree, '预览一致性').props.disabled, false);
  assert.equal(buttonOf(tree, '建立基础声纹').props.disabled, false);
  assert.equal(buttonOf(tree, '强化当前声纹').props.disabled, false);
  assert.equal(buttonOf(tree, '清空候选').props.disabled, false);
  assert.equal(buttonOf(tree, '重命名').props.disabled, false);
  assert.ok(nodesOf(tree).some((node) => node.type === 'audio'), 'loaded preview audio is rendered');
  assert.ok(buttonOf(tree, '确认回滚') !== undefined, 'the version chain keeps rollback');

  const checked = nodesOf(tree).find(
    (node) => node.type === 'input' && node.props.type === 'checkbox' && node.props.checked === true,
  );
  assert.ok(checked !== undefined);
  checked.props.onChange();
  buttonOf(tree, '试听').props.onClick();
  buttonOf(tree, '删除').props.onClick();
  buttonOf(tree, '清空候选').props.onClick();
  buttonOf(tree, '预览一致性').props.onClick();
  buttonOf(tree, '建立基础声纹').props.onClick();
  buttonOf(tree, '强化当前声纹').props.onClick();
  buttonOf(tree, '重命名').props.onClick();
  buttonOf(tree, '确认回滚').props.onClick();
  buttonOf(tree, '刷新候选').props.onClick();

  assert.deepEqual(calls.toggle, [['spc-1', false]]);
  assert.deepEqual(calls.audio, ['spc-1']);
  assert.deepEqual(calls.remove, ['spc-1']);
  assert.equal(calls.clear, 1);
  assert.deepEqual(calls.preview, [['spc-1']]);
  assert.deepEqual(calls.build, [[['spc-1'], '我的声音']]);
  assert.deepEqual(calls.strengthen, [[['spc-1'], '我的声音']]);
  assert.deepEqual(calls.rename, ['我的声音']);
  assert.deepEqual(calls.rollback, [1]);
  assert.equal(calls.refresh, 1);

  // With candidates but nothing selected, both explicit build paths explain why they are off.
  const unselected = sectionOf(api, { candidateData: candidateDataOf(candidates) });
  assert.equal(buttonOf(unselected, '建立基础声纹').props.disabled, true);
  assert.ok(textsOf(nodeWithProp(unselected, 'data-speaker-candidate-build-reason')).join('').includes('先勾选'));
  assert.equal(buttonOf(unselected, '强化当前声纹').props.disabled, true);
  assert.ok(textsOf(nodeWithProp(unselected, 'data-speaker-candidate-strengthen-reason')).join('').includes('先勾选'));

  console.log('[3] audio/remove/clear/preview/build/strengthen/rename/rollback all fired');
});

// ---------------------------------------------------------------------------
// 4. legacy entries keep confirm / reject / remove
// ---------------------------------------------------------------------------
test('4. 旧登记记录（兼容）仍可确认/拒绝/删除', () => {
  const api = load();
  const calls = { confirm: [], reject: [], remove: [] };
  const tree = sectionOf(api, {
    data: dataOf(listOf({ entries: [entryOf()] })),
    candidateData: candidateDataOf([candidateOf('spc-1')]),
    onConfirm: (id) => calls.confirm.push(id),
    onReject: (id) => calls.reject.push(id),
    onRemove: (id) => calls.remove.push(id),
  });

  assert.ok(textsOf(tree).some((text) => text.includes('旧登记记录（兼容）')));
  assert.ok(textsOf(tree).some((text) => text.includes('旧登记条目')));
  assert.ok(textsOf(tree).some((text) => text.includes('旧影子观测')));
  assert.ok(textsOf(tree).some((text) => text.includes('仅用于兼容')));

  for (const label of ['确认', '拒绝', '删除条目']) {
    assert.equal(buttonOf(tree, label).props.disabled, false, `${label} stays usable`);
  }
  buttonOf(tree, '确认').props.onClick();
  buttonOf(tree, '拒绝').props.onClick();
  buttonOf(tree, '删除条目').props.onClick();
  assert.deepEqual(calls.confirm, ['self-lin']);
  assert.deepEqual(calls.reject, ['self-lin']);
  assert.deepEqual(calls.remove, ['self-lin']);
  console.log('[4] legacy confirm/reject/remove still wired');
});
