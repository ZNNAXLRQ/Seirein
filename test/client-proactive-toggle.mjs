/**
 * 设置页「主动回应」开关（客户端侧）静态回归。
 *
 * 固定契约（宿主实现随后落地，客户端先按此接线）：
 *   POST /assistant/action  body `{ action: 'vision.proactive', enabled: boolean }`
 *   成功 `{ ok: true, enabled: boolean }`；失败 `{ ok: false, error: string }`
 *   /assistant/status 的 `vision.proactive.enabled` 为布尔有效值；默认开启。
 *
 * 浏览器 bundle 不能在 Node 里 import（window.__ModuleLoader__ + React + DOM），因此与
 * 其它 client-*.mjs 一样，对真正发货的源码做定位断言：不启动浏览器，不模拟宿主。
 *
 * Run: node --test test/client-proactive-toggle.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'client.js'), 'utf8');

const visionAt = source.indexOf("settingsCard(h, 'vision', '视觉与感知'");
const hearingAt = source.indexOf("\n        settingsBlock('hearing'", visionAt);
assert.ok(visionAt > 0, 'client.js ships the vision settings card');
assert.ok(hearingAt > visionAt, 'the hearing card follows the vision card');
const visionRegion = source.slice(visionAt, hearingAt);

test('1. 开关调用固定契约：action vision.proactive、enabled 布尔、成功用 result.enabled', () => {
  assert.match(
    visionRegion,
    /await act\(\{ action: 'vision\.proactive', enabled: next \}, 'vision-proactive'\);/u,
    '开关通过设置页统一的 act 发 POST /assistant/action',
  );
  assert.match(visionRegion, /const next = !proactiveOn;/u, '每次点击翻转当前值');
  assert.match(visionRegion, /typeof result\.enabled === 'boolean'/u, '成功响应按契约读 enabled');
  assert.match(visionRegion, /result\?\.ok === true/u, '以 ok 判断成功');
  // 契约字段不能写成其它名字（例如 proactive / value）。
  assert.doesNotMatch(visionRegion, /action: 'vision\.proactive'[^\n]*\b(?:proactive|value):/u,
    'enabled 字段名与契约一致');
});

test('2. 初值来自 vision.proactive.enabled；未知时按开启展示且不强行写回', () => {
  assert.match(visionRegion, /const vm = status\.vision \?\? \{\};/u,
    '视觉卡片从 status.vision 读取');
  assert.match(
    visionRegion,
    /typeof vm\.proactive\?\.enabled === 'boolean' \? vm\.proactive\.enabled : true/u,
    '布尔值直接用作初值，未知（非布尔）时按 true 展示',
  );
  assert.match(
    visionRegion,
    /typeof proactiveDraft === 'boolean' \? proactiveDraft : proactiveSaved/u,
    '乐观值优先，没有乐观值时回到 status 的已保存值',
  );
  // 未知/初始状态只展示：state 从 null 开始，挂载阶段没有任何写回动作。
  assert.match(source, /const \[proactiveDraft, setProactiveDraft\] = useState\(null\);/u);
  assert.doesNotMatch(source, /useEffect\([^)]*proactive/u, '不新增 effect 去写回初始值');
});

test('3. 开关位于视觉分区：label 与视觉卡片同段，且不在其它卡片', () => {
  assert.match(visionRegion, /'主动回应'/u, '视觉卡片里有「主动回应」');
  assert.match(visionRegion, /'（看到值得说的事时主动开口）'/u, 'label 里带一句说明');
  assert.match(visionRegion, /'data-settings-toggle': 'vision-proactive'/u,
    '开关有稳定的定位标记');
  assert.match(visionRegion, /'已开启' : '已关闭'/u, '按钮文案跟随开关状态');
  // 视觉分区从卡片声明开始，到下一张卡片（听觉）结束：开关确实落在这段里。
  assert.ok(visionRegion.indexOf("'主动回应'") > visionRegion.indexOf("settingsGroup(h, 'vision'"),
    '开关在视觉子容器内，而不是卡片外');
  assert.equal((source.match(/'主动回应'/gu) ?? []).length, 1, '开关只渲染一次');
});

test('4. 乐观更新与失败回滚：点击先写本地，失败清掉乐观值并显示错误', () => {
  assert.match(visionRegion, /setProactiveDraft\(next\);/u, '点击后立即乐观更新');
  assert.match(visionRegion, /setProactiveError\(''\);/u, '点击时清除上一次错误');
  assert.match(visionRegion, /setProactiveDraft\(null\);/u,
    '失败时清掉乐观值，回滚到 status.vision.proactive.enabled');
  assert.match(visionRegion, /setProactiveError\(String\(result\?\.error \?\? '保存失败'\)\);/u,
    '失败响应按契约读 error');
  assert.match(visionRegion, /主动回应保存失败：\$\{proactiveError\}/u, '失败错误显示在开关下方');
  // 请求进行中禁用，避免连点。
  assert.match(visionRegion, /disabled: busyNow/u, '动作进行中禁用开关');
});

test('5. 不新增轮询：视觉卡片没有定时器/effect，沿用设置页原有 status 刷新', () => {
  assert.doesNotMatch(visionRegion, /setInterval|setTimeout|requestAnimationFrame/u,
    '开关不装定时器');
  assert.doesNotMatch(visionRegion, /useEffect|useState|useRef/u,
    '开关不新增 effect/state 订阅');
  assert.equal((source.match(/setInterval\(load, 3000\)/gu) ?? []).length, 1,
    '设置页仍只有原有的 3 秒 status 轮询');
  assert.match(source, /const act = useCallback\(/u);
  assert.match(source, /await load\(\);/u, 'act 成功后沿用原有的 status 刷新');
});
