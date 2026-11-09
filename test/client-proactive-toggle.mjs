/**
 * 设置页「主动回应」开关 + 通过率输入（客户端侧）静态回归。
 *
 * 固定契约（宿主实现随后落地，客户端先按此接线）：
 *   POST /assistant/action  body `{ action: 'vision.proactive', enabled: boolean, rate: number }`
 *   成功 `{ ok: true, enabled: boolean, rate: number }`；失败 `{ ok: false, error: string }`
 *   /assistant/status 的 `vision.proactive.enabled` 为布尔有效值、`.rate` 为 0–100；默认开启、100%。
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

test('1. 开关与通过率都调用固定契约：action vision.proactive、enabled 布尔、rate 数字', () => {
  // 开关动作带上当前 rate；rate 输入的动作带上当前 enabled。两者一次保存两个字段。
  assert.match(
    visionRegion,
    /await act\(\s*\{ action: 'vision\.proactive', enabled: next, rate: proactiveRate \},\s*'vision-proactive',?\s*\)/u,
    '开关通过设置页统一的 act 发 POST /assistant/action，并带 rate',
  );
  assert.match(
    visionRegion,
    /await act\(\s*\{ action: 'vision\.proactive', enabled: proactiveOn, rate: next \},\s*'vision-proactive-rate',?\s*\)/u,
    '通过率提交同样带 enabled 与 rate',
  );
  assert.match(visionRegion, /const next = !proactiveOn;/u, '每次点击翻转当前值');
  assert.match(visionRegion, /typeof result\.enabled === 'boolean'/u, '成功响应按契约读 enabled');
  assert.match(visionRegion, /clampProactiveRate\(result\.rate\)/u, '成功响应按契约读 rate（0–100）');
  assert.match(visionRegion, /result\?\.ok === true/u, '以 ok 判断成功');
  // 契约字段不能写成其它名字（例如 proactive / value / probability）。
  assert.doesNotMatch(visionRegion, /action: 'vision\.proactive'[^\n]*\b(?:proactive|value|probability):/u,
    'enabled/rate 字段名与契约一致');
});

test('2. 初值来自 vision.proactive.enabled / rate；未知时按开启、100% 展示且不强行写回', () => {
  assert.match(visionRegion, /const vm = status\.vision \?\? \{\};/u,
    '视觉卡片从 status.vision 读取');
  assert.match(
    visionRegion,
    /typeof vm\.proactive\?\.enabled === 'boolean' \? vm\.proactive\.enabled : true/u,
    '布尔值直接用作初值，未知（非布尔）时按 true 展示',
  );
  assert.match(
    visionRegion,
    /clampProactiveRate\(vm\.proactive\?\.rate\) \?\? 100/u,
    'rate 直接取 status（先夹到 0–100），未知时按 100 展示；0 不会被 ?? 回退',
  );
  assert.match(
    visionRegion,
    /typeof proactiveDraft === 'boolean' \? proactiveDraft : proactiveSaved/u,
    '乐观值优先，没有乐观值时回到 status 的已保存值',
  );
  assert.match(
    visionRegion,
    /typeof proactiveRateDraft === 'number'\s*\?\s*proactiveRateDraft\s*:\s*proactiveRateSaved/u,
    '通过率同样乐观值优先，否则回到 status 的已保存值',
  );
  // 未知/初始状态只展示：state 从 null 开始，挂载阶段没有任何写回动作。
  assert.match(source, /const \[proactiveDraft, setProactiveDraft\] = useState\(null\);/u);
  assert.match(source, /const \[proactiveRateDraft, setProactiveRateDraft\] = useState\(null\);/u);
  assert.doesNotMatch(source, /useEffect\([^)]*proactive/u, '不新增 effect 去写回初始值');
});

test('3. 位于视觉分区：开关与通过率同段，且各只渲染一次', () => {
  assert.match(visionRegion, /'主动回应'/u, '视觉卡片里有「主动回应」');
  assert.match(visionRegion, /'（看到值得说的事时主动开口）'/u, 'label 里带一句说明');
  assert.match(visionRegion, /'data-settings-toggle': 'vision-proactive'/u,
    '开关有稳定的定位标记');
  assert.match(visionRegion, /'已开启' : '已关闭'/u, '按钮文案跟随开关状态');

  assert.match(visionRegion, /'主动回应通过率'/u, '视觉卡片里有「主动回应通过率」');
  assert.match(visionRegion, /'data-settings-input': 'vision-proactive-rate'/u,
    '通过率输入有稳定的定位标记');
  assert.match(visionRegion, /'aria-label': '主动回应通过率'/u, '输入有无障碍标签');
  assert.match(visionRegion, /type: 'number'/u, '通过率是数字输入');
  assert.match(visionRegion, /min: 0/u, '下界 0');
  assert.match(visionRegion, /max: 100/u, '上界 100');
  assert.match(visionRegion, /step: 5/u, '步进 5（0–100 的 5/10 步进）');
  assert.match(visionRegion, /h\('span', \{ style: styles\.value \}, '%'\)/u, '显示百分号');

  // 视觉分区从卡片声明开始，到下一张卡片（听觉）结束：控件确实落在这段里。
  assert.ok(visionRegion.indexOf("'主动回应'") > visionRegion.indexOf("settingsGroup(h, 'vision'"),
    '开关在视觉子容器内，而不是卡片外');
  assert.equal((source.match(/'主动回应'/gu) ?? []).length, 1, '开关只渲染一次');
  assert.equal((source.match(/'主动回应通过率'/gu) ?? []).length, 2,
    '通过率标签只渲染一次（另一处是同一个输入的 aria-label）');
});

test('4. 乐观更新与失败回滚：点击/失焦先写本地，失败清掉乐观值并显示错误', () => {
  assert.match(visionRegion, /setProactiveDraft\(next\);/u, '开关点击后立即乐观更新');
  assert.match(visionRegion, /setProactiveError\(''\);/u, '动作开始时清除上一次错误');
  assert.match(visionRegion, /setProactiveDraft\(null\);/u,
    '开关失败时清掉乐观值，回滚到 status.vision.proactive.enabled');
  assert.match(visionRegion, /setProactiveRateDraft\(next\);/u, '通过率先乐观更新');
  assert.match(visionRegion, /setProactiveRateDraft\(null\);/u,
    '通过率失败时清掉乐观值，回滚到 status.vision.proactive.rate');
  assert.match(visionRegion, /setProactiveRateDraft\(clampProactiveRate\(result\.rate\) \?\? next\);/u,
    '成功时以宿主返回的 rate 为准');
  assert.match(visionRegion, /setProactiveError\(String\(result\?\.error \?\? '保存失败'\)\);/u,
    '失败响应按契约读 error');
  assert.match(visionRegion, /主动回应保存失败：\$\{proactiveError\}/u, '失败错误显示在控件下方');
  // 请求进行中禁用，避免连点。
  assert.match(visionRegion, /disabled: busyNow/u, '动作进行中禁用开关');
  // 关闭主动回应时通过率输入禁用。
  assert.match(visionRegion, /disabled: busyNow \|\| !proactiveOn/u,
    '开关关闭时通过率输入禁用');
});

test('5. 无新增轮询：视觉卡片没有定时器/effect，沿用设置页原有 status 刷新', () => {
  assert.doesNotMatch(visionRegion, /setInterval|setTimeout|requestAnimationFrame/u,
    '控件不装定时器');
  assert.doesNotMatch(visionRegion, /useEffect|useState|useRef/u,
    '控件不新增 effect/state 订阅（state 在组件顶部声明）');
  assert.equal((source.match(/setInterval\(load, 3000\)/gu) ?? []).length, 1,
    '设置页仍只有原有的 3 秒 status 轮询');
  assert.match(source, /const act = useCallback\(/u);
  assert.match(source, /await load\(\);/u, 'act 成功后沿用原有的 status 刷新');
});

test('6. 0/100 边界：夹取函数、默认值、未改动不重复提交', () => {
  // 客户端与宿主共用 0–100 的整数百分比；输入本身也限死 min/max，避免提交越界值。
  assert.match(
    visionRegion,
    /return Math\.min\(100, Math\.max\(0, Math\.round\(number\)\)\);/u,
    '本地夹取到 0–100 的整数',
  );
  assert.match(visionRegion, /if \(!Number\.isFinite\(number\)\) return null;/u,
    '非数字不提交');
  assert.match(visionRegion, /proactiveRateSaved = clampProactiveRate\(vm\.proactive\?\.rate\) \?\? 100/u,
    'status 缺 rate 时默认 100（满分必过）');
  // 值没变时不发请求，失焦/回车只是把乐观值收回 status 值。
  assert.match(visionRegion, /next === proactiveRateSaved/u,
    '与已保存值相同时不重复提交');
  assert.match(visionRegion, /if \(next !== null\) setProactiveRateDraft\(next\);/u,
    '输入过程中只更新本地草稿，不逐键发请求');
  assert.match(visionRegion, /onBlur: \(\) => \{/u, '失焦提交');
  assert.match(visionRegion, /event\.key === 'Enter'/u, '回车提交（通过 blur 触发同一个函数）');
});
