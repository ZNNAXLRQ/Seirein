/**
 * 完整 Panel 渲染回归（不是字符串断言）。
 *
 * 背景：`396085c` 把 `inputInterrupts` 声明在「语种」闭包里，语音开关在闭包外引用它，
 * 设置页整页 `ReferenceError` 白屏；现有测试只匹配源码字符串，没有真正执行 Panel 渲染。
 *
 * 这里用记录型 React shim 直接执行真实的 `Panel()`：
 *   - 第一次 `useState(null)` 返回一份真实的 /assistant/status 投影（fixture）；
 *   - 其余 hook 返回初值/恒等实现；
 *   - useEffect 不执行，避免测试依赖网络/定时器。
 * 只要能完整返回元素树并包含语音开关文案，就证明整个设置页渲染路径没有作用域/求值异常。
 *
 * Run: node --test test/client-settings-render.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const status = JSON.parse(
  readFileSync(new URL('./fixtures/assistant-status.json', import.meta.url), 'utf8').replace(/^\uFEFF/u, ''),
);

let captured = null;
globalThis.window = {
  __ModuleLoader__: { load: (definition) => { captured = definition; } },
  location: { href: 'http://127.0.0.1/' },
  setTimeout,
  clearTimeout,
  setInterval: () => 0,
  clearInterval: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
};
globalThis.document = {
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener: () => {},
  removeEventListener: () => {},
  createElement: () => ({ style: {}, appendChild: () => {}, remove: () => {} }),
  body: { appendChild: () => {} },
};

let hookIndex = 0;
const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (initial) => {
    const index = hookIndex;
    hookIndex += 1;
    if (index === 0) return [status, () => {}];
    return [typeof initial === 'function' ? initial() : initial, () => {}];
  },
  useCallback: (fn) => fn,
  useEffect: () => {},
  useRef: (initial) => ({ current: initial }),
};

await import(new URL('../client.js', import.meta.url).href);
assert.ok(captured !== null, 'client.js registers a module definition');
const plugin = captured.factory((id) => {
  if (id === 'react') return React;
  throw new Error(`unexpected require(${id})`);
});
assert.equal(typeof plugin.__panel, 'function', 'the panel is exposed for the render regression');

const walk = (node, visit) => {
  if (node === null || node === undefined || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
};
const textsOf = (tree) => {
  const texts = [];
  walk(tree, (node) => {
    for (const child of node.children ?? []) if (typeof child === 'string') texts.push(child);
  });
  return texts;
};

test('完整 Panel 在非空 status 下渲染，不因 inputInterrupts 作用域白屏', () => {
  hookIndex = 0;
  let tree = null;
  assert.doesNotThrow(() => { tree = plugin.__panel(); }, 'Panel() 不应抛 ReferenceError');
  assert.ok(tree !== null && typeof tree === 'object', 'Panel() 返回元素树');
  const texts = textsOf(tree);
  assert.ok(texts.includes('用户输入时打断当前回复'), '语音区包含输入打断开关');
  assert.ok(texts.some((text) => text === '已开启' || text === '已关闭'), '开关显示可读状态');
  assert.ok(texts.includes('语音'), '语音分区已渲染');
  assert.ok(texts.length > 100, '整页不是只有空壳');
});

test('关闭输入打断时 Panel 仍完整渲染并显示已关闭', () => {
  const saved = status.voiceInputInterruptsReply;
  status.voiceInputInterruptsReply = false;
  hookIndex = 0;
  try {
    let tree = null;
    assert.doesNotThrow(() => { tree = plugin.__panel(); });
    const texts = textsOf(tree);
    assert.ok(texts.includes('用户输入时打断当前回复'));
    assert.ok(texts.includes('已关闭'), '状态文案跟随 status');
  } finally {
    if (saved === undefined) delete status.voiceInputInterruptsReply;
    else status.voiceInputInterruptsReply = saved;
  }
});
