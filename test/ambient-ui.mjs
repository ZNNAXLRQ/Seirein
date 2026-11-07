/**
 * 「环境声音 → 最近听到」折叠行回归：默认只露最近 1 条（超过 40 字截到 40 字 + …），
 * 点「展开」显示最近 3 条（旧→新、各自截断），点「收起」回到 1 条；recent 为空时显示「—」
 * 且没有按钮；只有 1 条时也不给按钮。
 *
 * 做法与 test/hearing-ui.mjs、test/tts-ui.mjs 相同：从 client.js 抽出真正发货的
 * `line` 与 `ambientRecentRow`，用记录型 `h` 求值 —— 不需要 DOM、React 或宿主。
 *
 * Run: node --test test/ambient-ui.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const clientSource = readFileSync(join(here, '..', 'client.js'), 'utf8');

/** Recording element factory: every node keeps its type, props and children. */
const h = (type, props, ...children) => ({ type, props: props ?? {}, children });
const styles = new Proxy({}, { get: (_target, key) => ({ marker: String(key) }) });

/** The shipped `line` + `ambientRecentRow`, extracted so the real render drives the assertions. */
const loadRecentRow = () => {
  const from = clientSource.indexOf('    function line(label, value) {');
  const to = clientSource.indexOf('    const fmtTokens = (value) => {', from);
  assert.ok(from > 0 && to > from, 'the shipped line/ambientRecentRow are found in client.js');
  const slice = clientSource.slice(from, to);
  return new Function(
    'h', 'styles',
    `${slice}\nreturn { line, ambientRecentRow };`,
  )(h, styles);
};

const { ambientRecentRow } = loadRecentRow();

const walk = (node, visit) => {
  if (node === null || node === undefined || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
};

/** The whole 「最近听到」row: a div whose children contain the label span. */
const rowOf = (tree) => {
  let found = null;
  walk(tree, (node) => {
    if (found !== null) return;
    if (node.type === 'div' && (node.children ?? []).some((child) => (
      child !== null && typeof child === 'object' && child.type === 'span'
      && (child.children ?? []).includes('最近听到')
    ))) found = node;
  });
  assert.ok(found !== null, 'the row labelled 最近听到 is rendered');
  return found;
};

/** Rendered text per line: one line when collapsed, three when expanded. */
const linesOf = (tree) => {
  const value = rowOf(tree).children[1];
  // React flattens arrays passed as children; the recording `h` keeps them nested.
  return (value.children ?? []).flat(Infinity).map((child) => (
    typeof child === 'string' ? child : (child.children ?? []).join('')
  ));
};

/** The per-line spans (not the text) so the no-wrap/ellipsis style can be checked. */
const entryNodesOf = (tree) => {
  const value = rowOf(tree).children[1];
  return (value.children ?? []).flat(Infinity).filter((child) => child !== null && typeof child === 'object');
};

const toggleOf = (tree) => {
  let found = null;
  walk(tree, (node) => {
    if (found !== null) return;
    if (node.type === 'button' && (node.children ?? []).some((text) => text === '展开' || text === '收起')) {
      found = node;
    }
  });
  return found;
};

const clip = (text) => {
  const chars = Array.from(text);
  return chars.length > 40 ? `${chars.slice(0, 40).join('')}…` : text;
};

/** One Panel-like mount: `expanded` mimics the Panel's local `expandedAmbient` state. */
const mount = (recent) => {
  const state = { expanded: false };
  const render = () => ambientRecentRow(h, {
    recent,
    expanded: state.expanded,
    onToggle: (next) => { state.expanded = next; },
  });
  const toggle = () => {
    const button = toggleOf(render());
    assert.ok(button !== null, 'the toggle button is rendered');
    button.props.onClick();
  };
  return { state, render, toggle };
};

const SHORT = '敲键盘的声音';
const LONG_45 = '环'.repeat(45);
const EXACT_40 = '四'.repeat(40);
const LONG_41 = '三'.repeat(41);

test('1. 默认折叠：只渲染最近 1 条，超过 40 字截到 40 字 + …', () => {
  const view = mount([SHORT, '旧'.repeat(45), LONG_45]);
  const tree = view.render();
  assert.deepEqual(linesOf(tree), [`${'环'.repeat(40)}…`], '只显示最新 1 条并按字符截断');
  assert.equal(Array.from(linesOf(tree)[0]).length, 41, '40 字 + 省略号');

  const entry = entryNodesOf(tree)[0];
  assert.equal(entry.props.style.whiteSpace, 'nowrap', '每条不换行');
  assert.equal(entry.props.style.textOverflow, 'ellipsis', '放不下时整行省略');

  const toggle = toggleOf(tree);
  assert.ok(toggle !== null, '折叠时行尾有「展开」');
  assert.deepEqual(toggle.children, ['展开']);
  assert.equal(toggle.props.style.marker, 'btn', '复用现有行内按钮样式');
  assert.equal(rowOf(tree).props.style.marker, 'row', '不新增卡片');

  // 展开状态是 Panel 局部 state，不写 settings。
  assert.match(clientSource, /const \[expandedAmbient, setExpandedAmbient\] = useState\(false\);/u);
  assert.match(clientSource, /ambientRecentRow\(h, \{/u);
  assert.doesNotMatch(clientSource, /expandedAmbient\s*:/u, '没有把 expandedAmbient 写进 settings');
});

test('2. 点「展开」→ 最近 3 条（旧→新、各自截断），按钮变「收起」', () => {
  const view = mount([SHORT, '一'.repeat(45), LONG_41, EXACT_40, '五'.repeat(12)]);
  view.toggle();
  const tree = view.render();
  assert.deepEqual(linesOf(tree), [
    `${'三'.repeat(40)}…`,
    EXACT_40,
    '五'.repeat(12),
  ], '只取最近 3 条，按旧→新排列；刚好 40 字不加省略号');
  assert.equal(linesOf(tree).length, 3, '展开后 3 条各占一行');

  const toggle = toggleOf(tree);
  assert.ok(toggle !== null);
  assert.deepEqual(toggle.children, ['收起'], '展开后按钮变成「收起」');
});

test('3. 再点「收起」→ 回到最近 1 条', () => {
  const view = mount([SHORT, '一'.repeat(41), EXACT_40, LONG_45]);
  view.toggle();
  assert.equal(linesOf(view.render()).length, 3, '先展开成 3 条');

  view.toggle();
  const tree = view.render();
  assert.deepEqual(linesOf(tree), [clip(LONG_45)], '收起后只留最新 1 条');
  assert.deepEqual(toggleOf(tree).children, ['展开'], '按钮回到「展开」');
});

test('4. recent 为空 → 显示「—」且没有展开按钮', () => {
  const view = mount([]);
  const tree = view.render();
  assert.deepEqual(linesOf(tree), ['—'], '空列表沿用「—」');
  assert.equal(toggleOf(tree), null, '没有可展开的内容就不给按钮');
});

test('5. recent 只有 1 条 → 不显示展开按钮', () => {
  const view = mount(['只有一句']);
  const tree = view.render();
  assert.deepEqual(linesOf(tree), ['只有一句'], '单条原样显示（≤40 字）');
  assert.equal(toggleOf(tree), null, '只有 1 条时展开没有意义，不显示按钮');
});
