/**
 * 「听觉 → 音频保留（诊断）」设置页回归。
 *
 * The shipped `retentionSection` is extracted from client.js and evaluated with a recording `h`
 * (same pattern as `hearing-ui.mjs` / `speaker-host-wiring.mjs`): no DOM, no React, no host. It
 * pins what the user can actually see and click:
 *   1. the switch renders OFF by default (explicitly "默认关闭"), ON after the host says so, and
 *      clicking it asks for the opposite value through `voice.audioRetention`;
 *   2. the cap hint uses the live limits (20 条 / 5 分钟 / 50 MB) and an empty list says so;
 *   3. a row shows time / duration / reason / size, 试听 asks only for a path (no auto-play),
 *      and delete is a two-step confirmation (single and all);
 *   4. an unwired / failed action renders the host's error text and never throws;
 *   5. client.js mounts the section in the 听觉 card and talks to the four documented actions.
 *
 * Run: node --test test/audio-retention-ui.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const clientSource = readFileSync(join(here, '..', 'client.js'), 'utf8');

const sectionFrom = clientSource.indexOf('    function retentionSection(');
const sectionTo = clientSource.indexOf('    function Panel() {', sectionFrom);
assert.ok(sectionFrom > 0 && sectionTo > sectionFrom, 'client.js still ships retentionSection before Panel');
const styles = new Proxy({}, { get: (_target, key) => ({ marker: String(key) }) });
const retentionSource = clientSource.slice(sectionFrom, sectionTo);
const retentionSection = new Function(
  'styles',
  'DANGER',
  `${retentionSource}\nreturn retentionSection;`,
)(styles, '#c92a2a');

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

const buttonOf = (tree, label) => {
  const found = nodesOf(tree).find(
    (node) => node.type === 'button' && (node.children ?? []).some((child) => child === label),
  );
  assert.ok(found !== undefined, `the section renders a «${label}» button`);
  return found;
};

const buttonLabels = (tree) => nodesOf(tree)
  .filter((node) => node.type === 'button')
  .map((node) => (node.children ?? []).filter((child) => typeof child === 'string').join(''));

/** One Panel-like mount: all state is passed explicitly, every handler records its call. */
const mount = (overrides = {}) => {
  const calls = { toggle: [], preview: [], askDelete: [], delete: [], cancel: 0, deleteAll: 0 };
  const state = {
    status: { retention: { enabled: false } },
    data: { items: [], limits: null, error: '', loading: false },
    busy: '',
    preview: null,
    confirm: '',
    ...overrides,
    calls,
  };
  const render = () => retentionSection(h, {
    status: state.status,
    data: state.data,
    busy: state.busy,
    preview: state.preview,
    confirm: state.confirm,
    onToggle: (enabled) => { calls.toggle.push(enabled); },
    onPreview: (id) => { calls.preview.push(id); },
    onAskDelete: (id) => { calls.askDelete.push(id); state.confirm = String(id); },
    onDelete: (id) => { calls.delete.push(id); },
    onCancel: () => { calls.cancel += 1; state.confirm = ''; },
    onDeleteAll: () => { calls.deleteAll += 1; },
  });
  return { state, render };
};

const item = (overrides = {}) => ({
  id: 'clip-1',
  createdAt: '2026-11-08T10:00:00.000Z',
  durationMs: 1200,
  reason: 'noise',
  bytes: 38_912,
  missing: false,
  ...overrides,
});

test('1. 开关：默认关闭、开启态、点击请求相反值', async () => {
  const view = mount();
  const off = view.render();
  assert.equal(buttonOf(off, '已关闭').props.style.marker, 'btn', 'OFF uses the plain button style');
  assert.ok(textsOf(off).includes('音频保留（诊断）'));
  assert.ok(textsOf(off).some((text) => text.includes('默认关闭')), 'the hint states the default');
  assert.ok(textsOf(off).some((text) => text.includes('最多 20 条/5 分钟/50 MB')), 'the documented caps are visible');
  assert.ok(textsOf(off).includes('暂时没有保留的片段'));
  await buttonOf(off, '已关闭').props.onClick();
  assert.deepEqual(view.state.calls.toggle, [true], 'OFF asks the host to enable it');

  const onView = mount({ status: { retention: { enabled: true } } });
  const on = onView.render();
  assert.equal(buttonOf(on, '已开启').props.style.marker, 'btnActive', 'ON uses the active style');
  await buttonOf(on, '已开启').props.onClick();
  assert.deepEqual(onView.state.calls.toggle, [false], 'ON asks the host to disable it');

  const busy = mount({ busy: 'audio-retention' });
  assert.equal(buttonOf(busy.render(), '已关闭').props.disabled, true, 'a pending action disables the switch');
});

test('2. 列表行：时间 / 时长 / 原因 / 大小，文件缺失有标记', () => {
  const view = mount({
    data: {
      items: [
        item(),
        item({ id: 'clip-2', reason: 'low-evidence', durationMs: 600, bytes: 20_000, missing: true }),
      ],
      limits: { maxClips: 20, maxDurationMs: 300_000, maxBytes: 52_428_800 },
      error: '',
      loading: false,
    },
  });
  const tree = view.render();
  const texts = textsOf(tree);
  const rowA = texts.find((text) => text.includes('噪声'));
  assert.ok(rowA !== undefined, 'the noise reason is labelled in Chinese');
  assert.match(rowA, /1\.2 秒/u, 'duration is shown');
  assert.match(rowA, /38 KB/u, 'size is shown');
  assert.ok(rowA.includes('2026'), 'the timestamp is rendered');
  const rowB = texts.find((text) => text.includes('证据不足'));
  assert.ok(rowB !== undefined, 'low-evidence is labelled');
  assert.ok(rowB.includes('文件缺失'), 'a missing file is visible, not silently dropped');
  assert.ok(buttonLabels(tree).includes('试听'));
  assert.ok(buttonLabels(tree).includes('删除'));
});

test('3. 试听只取路径（不自动播放）；删除需两次确认（单条与全部）', async () => {
  const view = mount({ data: { items: [item()], limits: null, error: '', loading: false } });

  // Rendering itself must never request audio: only the 试听 click does, and it returns a path.
  assert.deepEqual(view.state.calls.preview, [], 'render does not trigger playback');
  await buttonOf(view.render(), '试听').props.onClick();
  assert.deepEqual(view.state.calls.preview, ['clip-1']);

  const withPath = mount({
    data: { items: [item()], limits: null, error: '', loading: false },
    preview: { id: 'clip-1', path: 'C:\\seirein\\cache\\retention\\clip-1.wav' },
  });
  const previewText = textsOf(withPath.render()).find((text) => text.includes('clip-1.wav'));
  assert.ok(previewText !== undefined, 'the export path is displayed');
  assert.ok(previewText.includes('不自动播放'), 'the card states that nothing is played automatically');

  // Single delete: first click asks, the row then offers confirmation.
  await buttonOf(view.render(), '删除').props.onClick();
  assert.deepEqual(view.state.calls.askDelete, ['clip-1']);
  const confirming = view.render();
  assert.ok(textsOf(confirming).includes('确认删除？'));
  await buttonOf(confirming, '确认').props.onClick();
  assert.deepEqual(view.state.calls.delete, ['clip-1']);
  await buttonOf(confirming, '取消').props.onClick();
  assert.equal(view.state.confirm, '');
  assert.equal(view.state.calls.cancel, 1);

  // All: first click asks, the bottom row then confirms.
  const allView = mount({
    data: { items: [item(), item({ id: 'clip-2' })], limits: null, error: '', loading: false },
  });
  await buttonOf(allView.render(), '全部删除').props.onClick();
  assert.deepEqual(allView.state.calls.askDelete, ['all']);
  const allConfirm = allView.render();
  assert.ok(textsOf(allConfirm).includes('确认删除全部？'));
  await buttonOf(allConfirm, '确认全部删除').props.onClick();
  assert.equal(allView.state.calls.deleteAll, 1);
});

test('4. 错误分支：未接线 / 读取失败只显示文案，不崩溃', () => {
  const failed = mount({
    data: { items: [], limits: null, loading: false, error: 'AUDIO_RETENTION_UNAVAILABLE' },
  });
  const failedText = textsOf(failed.render());
  assert.ok(
    failedText.some((text) => text.includes('音频保留不可用：AUDIO_RETENTION_UNAVAILABLE')),
    'the host error code is shown verbatim',
  );
  assert.ok(failedText.includes('暂时没有保留的片段'), 'the empty list still renders');

  const loading = mount({ data: null });
  assert.ok(textsOf(loading.render()).includes('正在读取保留列表…'));

  // A broken row (no createdAt / no bytes) still renders a placeholder instead of throwing.
  const broken = mount({
    data: { items: [{ id: 'x', reason: 'unknown', createdAt: null, durationMs: null, bytes: null }], limits: null, error: '' },
  });
  const brokenText = textsOf(broken.render());
  assert.ok(brokenText.some((text) => text.includes('unknown')), 'an unknown reason is still visible');
});

test('5. client.js 接线：听觉卡片挂载 + 四个动作 + 不自动播放', () => {
  assert.match(clientSource, /speakerShadowRow\(h, \{ status, busy, act \}\),\s*retentionSection\(h, \{/u,
    'the section is mounted right after the voiceprint row in the 听觉 card');
  assert.match(clientSource, /const \[retentionData, setRetentionData\] = useState\(null\);/u);
  assert.match(clientSource, /action: 'audio\.retention\.list'/u);
  assert.match(clientSource, /action: 'voice\.audioRetention', enabled/u);
  assert.match(clientSource, /action: 'audio\.retention\.delete'/u);
  assert.match(clientSource, /action: 'audio\.retention\.export'/u);
  assert.match(clientSource, /setRetentionPreview\(\{ id, path: String\(result\.path \?\? ''\) \}\)/u,
    'export stores the path for display');
  assert.doesNotMatch(retentionSource, /new Audio\(/u, 'the card never constructs a player');
  assert.doesNotMatch(retentionSource, /\.play\(\)/u, 'the card never auto-plays the diagnostic clip');
  console.log('[retention-ui 5] mountedIn=听觉 actions=list/toggle/delete/export autoPlay=no');
});
