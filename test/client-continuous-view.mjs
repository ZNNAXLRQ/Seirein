/**
 * 设置页「持续观看」独立开关 + 状态行（客户端侧）静态回归。
 *
 * 固定契约：
 *   POST /assistant/action  body `{ action: 'vision.continuousView', enabled: boolean }`
 *   /assistant/status 的 `vision.continuous` =
 *     { enabled, state: 'off'|'waiting'|'starting'|'capturing'|'privacy'|'failed'|'retrying',
 *       source: 'desktop'|'obs', lastFrameAt, lastUnderstandingAt, error, retryAt, companionSeen }
 *
 * 浏览器 bundle 不能在 Node 里 import（window.__ModuleLoader__ + React + DOM），因此与
 * 其它 client-*.mjs 一样，对真正发货的源码做定位断言：不启动浏览器，不模拟宿主。
 *
 * Run: node --test test/client-continuous-view.mjs
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

test('1. 开关走固定动作契约：vision.continuousView + enabled 布尔；失败回滚', () => {
  assert.match(
    visionRegion,
    /await act\(\s*\{ action: 'vision\.continuousView', enabled: next \},\s*'vision-continuous-view',?\s*\)/u,
    '开关通过设置页统一的 act 发 POST /assistant/action',
  );
  assert.match(visionRegion, /const next = !continuousOn;/u, '每次点击翻转当前值');
  assert.match(visionRegion, /result\?\.ok === true/u, '以 ok 判断成功');
  assert.match(visionRegion, /typeof result\.enabled === 'boolean'/u, '成功响应按契约读 enabled');
  assert.match(visionRegion, /setContinuousDraft\(next\);/u, '点击后立即乐观更新');
  assert.match(visionRegion, /setContinuousError\(''\);/u, '动作开始时清除上一次错误');
  assert.match(visionRegion, /setContinuousDraft\(null\);/u, '失败时清掉乐观值，回滚到 status');
  assert.match(visionRegion, /setContinuousError\(String\(result\?\.error \?\? '保存失败'\)\);/u,
    '失败响应按契约读 error');
  assert.match(visionRegion, /持续观看保存失败：\$\{continuousError\}/u, '失败错误显示在控件下方');
  assert.match(visionRegion, /disabled: busyNow/u, '动作进行中禁用开关');
  assert.match(visionRegion, /'data-settings-toggle': 'vision-continuous-view'/u, '开关有稳定定位标记');
  assert.match(visionRegion, /continuousOn \? '已开启' : '已关闭'/u, '按钮文案跟随开关状态');
});

test('2. 初值来自 status.vision.continuous.enabled；未知时按默认开启展示且不写回', () => {
  assert.match(visionRegion, /const vm = status\.vision \?\? \{\};/u, '视觉卡片从 status.vision 读取');
  assert.match(visionRegion, /const continuousView = vm\.continuous \?\? \{\};/u,
    '状态对象来自 vm.continuous');
  assert.match(
    visionRegion,
    /typeof continuousView\.enabled === 'boolean'\s*\?\s*continuousView\.enabled\s*:\s*true/u,
    '布尔值直接用作初值；未知（旧 status / 首次加载）按默认开启展示',
  );
  assert.match(
    visionRegion,
    /typeof continuousDraft === 'boolean' \? continuousDraft : continuousSaved/u,
    '乐观值优先，没有乐观值时回到 status 的已保存值',
  );
  assert.match(source, /const \[continuousDraft, setContinuousDraft\] = useState\(null\);/u);
  assert.match(source, /const \[continuousError, setContinuousError\] = useState\(''\);/u);
  assert.doesNotMatch(source, /useEffect\([^)]*continuous/iu, '不新增 effect 去写回初始值');
  assert.match(visionRegion, /持续观看默认开启（兼容旧版自动行为）/u,
    '设置页写明无记录时默认开启，兼容旧自动行为');
});

test('3. 状态行显示来源、状态、最近帧、最近理解、失败原因与下次重试', () => {
  assert.match(visionRegion, /line\('持续观看状态'/u, '有独立的持续观看状态行');
  assert.match(visionRegion, /line\('持续观看来源'/u, '来源行');
  assert.match(visionRegion, /line\('最近帧'/u, '最近帧行');
  assert.match(visionRegion, /line\('最近理解'/u, '最近理解行');
  assert.match(visionRegion, /line\('失败原因'/u, '失败原因行');
  assert.match(visionRegion, /line\('下次重试'/u, '重试时间行');
  assert.match(visionRegion, /continuousAt\(continuousView\.lastFrameAt\)/u, '最近帧取 status 时间戳');
  assert.match(visionRegion, /continuousAt\(continuousView\.lastUnderstandingAt\)/u,
    '最近理解取 status 时间戳');
  assert.match(visionRegion, /continuousView\.source === 'obs'/u, '来源按 desktop/obs 展示');
  // 关闭文案必须明确，不能只说“未运行”。
  assert.match(visionRegion, /已关闭，不会自动恢复/u, '关闭后明确不会自动恢复');
  assert.match(visionRegion, /首轮、切换来源、重试和重启插件都不会重新打开/u,
    '关闭文案点名所有不会自动恢复的路径');
  assert.doesNotMatch(visionRegion, /未启动 · 最近取景[\s\S]{0,80}持续观看状态/u,
    '旧的“未启动”不能冒充持续观看状态');
});

test('4. 状态机标签：starting 不写成 capturing；没有新轮询', () => {
  for (const label of ['已关闭', '等待首次真实陪伴轮 / 依赖就绪', '正在启动', '采集中',
    '隐私模式暂停', '启动失败', '等待重试']) {
    assert.ok(visionRegion.includes(`'${label}'`), `状态标签包含「${label}」`);
  }
  // 状态行直接使用 continuousView.state；只有确实 capturing 时才在状态后追加来源。
  assert.match(visionRegion, /const continuousState = typeof continuousView\.state === 'string'/u,
    '状态来自宿主的 state 字符串');
  assert.match(visionRegion, /continuousState === 'capturing' \? ` · \$\{continuousSourceLabel\}`/u,
    '只有 capturing 才追加来源，starting 不会被写成采集中');
  assert.match(visionRegion, /const continuousStateLabel = continuousLabels\[continuousState\]/u,
    '状态行用一个独立映射渲染，不复用 vm.capturing');
  assert.ok(visionRegion.includes("starting: '正在启动'"));
  assert.ok(visionRegion.includes("capturing: '采集中'"));
  assert.notEqual(
    visionRegion.indexOf("starting: '正在启动'"),
    visionRegion.indexOf("capturing: '采集中'"),
    'starting 与 capturing 是两个不同标签',
  );

  assert.doesNotMatch(visionRegion, /setInterval|setTimeout|requestAnimationFrame/u,
    '控件不装定时器');
  assert.doesNotMatch(visionRegion, /useEffect|useRef/u, '控件不新增 effect/订阅');
  assert.equal((source.match(/setInterval\(load, 3000\)/gu) ?? []).length, 1,
    '设置页仍只有原有的 3 秒 status 轮询');
});
