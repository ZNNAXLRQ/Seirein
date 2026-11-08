/**
 * 「听觉 → 麦克风与门限」阈值输入框回归：保存后输入框必须回显新值，失败时回到旧值，重新打开设置页回显
 * 持久化值。输入框是受控的（`value` 来自 settings 的已保存值 + 本地草稿），不是
 * `defaultValue` 那种只在首次渲染取值的不受控输入。
 *
 * 做法与 test/layer-settings.mjs、test/tts-ui.mjs 相同：从 client.js 抽出真正发货的
 * `hearingThresholdRow`，用记录型 `h` 求值 —— 不需要 DOM、React 或宿主。
 *
 * Run: node --test test/hearing-ui.mjs
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

/** The shipped threshold row, extracted so a fake save can drive the real code. */
const loadThresholdRow = () => {
  const from = clientSource.indexOf('    function hearingThresholdRow(h, { draft, saved, busy, onDraft, onSave }) {');
  const to = clientSource.indexOf('    function Panel() {', from);
  assert.ok(from > 0 && to > from, 'the shipped hearingThresholdRow is found in client.js');
  const slice = clientSource.slice(from, to);
  return new Function(
    'styles',
    `${slice}\nreturn hearingThresholdRow;`,
  )(styles);
};

const thresholdRow = loadThresholdRow();

const walk = (node, visit) => {
  if (node === null || node === undefined || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
};

const inputOf = (tree) => {
  let found = null;
  walk(tree, (node) => {
    if (found === null && node.type === 'input' && node.props.type === 'number') found = node;
  });
  assert.ok(found !== null, 'the row renders a number input');
  return found;
};

const saveButtonOf = (tree) => {
  let found = null;
  walk(tree, (node) => {
    if (found === null && node.type === 'button'
      && (node.children ?? []).some((child) => child === '保存阈值')) found = node;
  });
  assert.ok(found !== null, 'the row renders the 保存阈值 button');
  return found;
};

const textsOf = (tree) => {
  const texts = [];
  walk(tree, (node) => {
    for (const child of node.children ?? []) {
      if (typeof child === 'string') texts.push(child);
    }
  });
  return texts;
};

/**
 * One Panel-like mount: `draft`/`saved` mimic the component state, `onSave` mimics the
 * `act({action:'hearing.threshold'})` wrapper and updates `saved` only when it succeeds.
 */
const mount = ({ saved = -50, draft = null, result = { ok: true } } = {}) => {
  const state = { saved, draft, busy: '', calls: [], result };
  state.onSave = async (db) => {
    state.calls.push(db);
    if (state.result.ok) state.saved = db;
    return state.result;
  };
  const stateView = () => state;
  const render = () => thresholdRow(h, {
    draft: state.draft,
    saved: state.saved,
    busy: state.busy,
    onDraft: (value) => { state.draft = value; },
    onSave: state.onSave,
  });
  const type = (value) => {
    inputOf(render()).props.onChange({ target: { value } });
  };
  const save = async () => {
    await saveButtonOf(render()).props.onClick();
  };
  return { state: stateView, render, type, save };
};

test('1. 保存新阈值 → 输入框显示新值（受控，不留在旧值）', async () => {
  const view = mount({ saved: -50 });
  assert.equal(inputOf(view.render()).props.value, '-50', '打开时显示已保存值');

  view.type('-35');
  assert.equal(inputOf(view.render()).props.value, '-35', '编辑时显示草稿');

  await view.save();
  assert.deepEqual(view.state().calls, [-35], '保存发送的是输入框里的值');
  assert.equal(view.state().draft, null, '保存后丢弃草稿');

  const after = view.render();
  assert.equal(inputOf(after).props.value, '-35', '输入框回显保存后的 settings 值');
  assert.ok(textsOf(after).includes('触发阈值 -35 dB（越低越灵敏；说话时电平需高于它）'), '说明文字同步');
});

test('2. 保存失败 → 输入框保持旧值，不回显脏数据', async () => {
  const view = mount({ saved: -50, result: { ok: false, error: '阈值需在 -90 与 -10 之间' } });
  view.type('-35');
  assert.equal(inputOf(view.render()).props.value, '-35', '编辑中允许输入');

  await view.save();
  assert.deepEqual(view.state().calls, [-35], '失败时请求仍然发出');
  assert.equal(view.state().draft, null, '失败后草稿被丢弃');

  const after = view.render();
  assert.equal(inputOf(after).props.value, '-50', '输入框回到保存前的旧值');
  assert.ok(!textsOf(after).some((text) => text.includes('-35')), '界面上不再出现脏值 -35');
});

test('3. 重新打开设置页 → 显示持久化后的值', () => {
  // 重新挂载：draft 为 null（新 Panel 的初始状态），saved 来自 /assistant/status。
  const reopened = mount({ saved: -35 });
  assert.equal(inputOf(reopened.render()).props.value, '-35', '新挂载的输入框直接回显持久化值');

  // Panel 的初始草稿必须是 null，保存值必须来自 status.hearing.thresholdDb，不能写死。
  assert.match(clientSource, /const \[thresholdDraft, setThresholdDraft\] = useState\(null\);/u);
  assert.match(clientSource, /saved: Number\(status\.hearing\?\.thresholdDb \?\? -50\),/u);
  assert.match(clientSource, /hearingThresholdRow\(h, \{/u);
});

test('4. 回归：设置页的数字输入不再用 defaultValue 做一次性绑定', () => {
  // 阈值输入由 hearingThresholdRow 的 value 控制；字幕字号上限原先用 defaultValue，同样改为受控。
  assert.doesNotMatch(clientSource, /value: thresholdDraft/u, '阈值输入框不再直接绑定可变成旧值的草稿');
  assert.doesNotMatch(clientSource, /defaultValue:/u, '没有遗留的 defaultValue 数字输入');
  assert.match(clientSource, /value: sizeMaxDraft \?\? String\(sub\.sizeMax \?\? 32\),/u);
  assert.match(clientSource, /onChange: \(event\) => setSizeMaxDraft\(event\.target\.value\),/u);
});

/**
 * 阈值保存后的提示分支：从 client.js 抽出真正发货的 `onSave` 处理器，用记录型 `act`/`show`
 * 求值。三个分支分别是「重启成功（新实例）」「已保存但采集未运行」「重启失败」。
 */
const loadThresholdSave = () => {
  const marker = "const result = await act({ action: 'hearing.threshold', db }, 'threshold');";
  const at = clientSource.indexOf(marker);
  assert.ok(at > 0, 'the shipped threshold save is found in client.js');
  const anchor = clientSource.lastIndexOf('onSave: async (db) => {', at);
  assert.ok(anchor > 0, 'the threshold row onSave handler is found');
  // Find the closing `},` at the same indentation as `onSave`, so a layout change that re-indents
  // the handler does not break the extraction.
  const lineStart = clientSource.lastIndexOf('\n', anchor) + 1;
  const indent = ' '.repeat(anchor - lineStart);
  const end = clientSource.indexOf(`\n${indent}},`, at);
  assert.ok(end > anchor, 'the onSave handler body is bounded');
  const body = clientSource.slice(anchor + 'onSave: async (db) => {'.length, end);
  return new Function('act', 'show', `return async (db) => {${body}\n};`);
};

test('5. 阈值保存提示：成功重启 / 采集未运行 / 失败三种分支', async () => {
  const build = loadThresholdSave();
  const run = async (result) => {
    const shown = [];
    const calls = [];
    const onSave = build(
      async (body, tag) => {
        calls.push({ body, tag });
        return result;
      },
      (message) => shown.push(message),
    );
    await onSave(-35);
    return { shown, calls };
  };

  const restarted = await run({ ok: true, restarted: true, db: -35, instanceId: 'inst-1' });
  assert.deepEqual(restarted.shown, ['已生效（新实例）'], '重启成功提示新实例已生效');
  assert.deepEqual(
    restarted.calls,
    [{ body: { action: 'hearing.threshold', db: -35 }, tag: 'threshold' }],
    '保存仍然发出 hearing.threshold 请求',
  );

  const idle = await run({ ok: true, restarted: false, db: -35, reason: 'not-running' });
  assert.deepEqual(idle.shown, ['已保存（采集未运行）'], '采集未运行时说明已保存');

  const failed = await run({
    ok: false, restarted: false, db: -35, error: '重启采集失败', message: '重启失败：重启采集失败',
  });
  assert.deepEqual(failed.shown, ['重启失败：重启采集失败'], '失败时显示宿主给的 message');

  const bare = await run({ ok: false });
  assert.deepEqual(bare.shown, ['保存失败'], '没有 message/error 时回退到通用提示');
});

