/**
 * 设置页「后台理解」成本概览回归（2026-11-09）。
 *
 * 只做静态契约断言：成本行是一行只读小字，数值优先来自 status.vision.understanding，
 * 缺失时用 20 秒 / 3 张 / 180 次 / 540 张兜底；明确说明“限速、按变化触发，不是定时调用”，
 * 且不新增开关、不新增轮询。
 *
 * Run: node --test test/client-understanding-cost.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const clientSource = readFileSync(join(here, '..', 'client.js'), 'utf8');

const visionAt = clientSource.indexOf("settingsCard(h, 'vision'");
const hearingAt = clientSource.indexOf("settingsCard(h, 'hearing'");
assert.ok(visionAt > 0 && hearingAt > visionAt, 'client.js 里能找到视觉卡片区域');
const visionRegion = clientSource.slice(visionAt, hearingAt);

const costAt = visionRegion.indexOf("'data-settings-note': 'understanding-cost'");
const triggerAt = visionRegion.indexOf("'data-settings-note': 'understanding-trigger'");
assert.ok(costAt > 0 && triggerAt > costAt, '成本行与触发说明都存在');
// 只截取两条 note 的渲染区域（到主动回应那一行之前），避免把整张卡片的其他控件算进来。
const proactiveAt = visionRegion.indexOf("'主动回应'", triggerAt);
assert.ok(proactiveAt > triggerAt);
const noteRegion = visionRegion.slice(costAt, proactiveAt);

test('1. 成本概览是只读小字，文案包含最短间隔、理论上限与费用免责声明', () => {
  assert.equal((visionRegion.match(/data-settings-note': 'understanding-cost'/gu) ?? []).length, 1,
    '成本概览只渲染一行');
  assert.equal((visionRegion.match(/data-settings-note': 'understanding-trigger'/gu) ?? []).length, 1,
    '限速/触发方式说明只渲染一行');
  assert.equal((visionRegion.match(/style: styles\.hint/gu) ?? []).length >= 2, true,
    '两行都用小字 hint 样式');
  assert.ok(visionRegion.includes(
    '`后台理解：最短间隔约 ${understandingIntervalText}；持续触发理论上限约 ${understandingPerHour} 次/小时、最多 ${understandingImagesPerHour} 张输入图（实际费用取决于模型与图片处理方式）`',
  ), '成本行文案与用户定稿一致');
  assert.ok(visionRegion.includes(
    '`限速、按变化触发，不是定时调用：每次分析最多 ${understandingMaxImages} 张输入图，静止或没有新证据时不会调用。`',
  ), '明确说明限速、按变化触发而不是定时调用');
  assert.match(visionRegion, /每次分析最多 \$\{understandingMaxImages\} 张输入图/,
    '文案里体现每次最多 3 张输入图');
  console.log('1) notes=2 hint=yes copy=exact');
});

test('2. 数值优先取 status.vision.understanding，缺失时用 20s / 3 / 180 / 540 兜底', () => {
  assert.match(visionRegion, /const understandingView = vm\.understanding \?\? \{\};/u,
    '只读 status.vision.understanding');
  assert.match(visionRegion,
    /boundedCount\(understandingView\.intervalMs, 20_000\)/u,
    'intervalMs 缺失时兜底 20 秒');
  assert.match(visionRegion,
    /boundedCount\(understandingView\.maxImages, 3\)/u,
    'maxImages 缺失时兜底 3 张');
  assert.match(visionRegion,
    /boundedCount\(understandingView\.theoreticalPerHour, 180, true\)/u,
    'theoreticalPerHour 缺失时兜底 180 次/小时');
  assert.match(visionRegion,
    /const understandingImagesFallback = understandingPerHour \* understandingMaxImages \|\| 540;/u,
    'theoreticalImagesPerHour 缺失时优先按 perHour×maxImages 算，空值兜底 540 张');
  assert.match(visionRegion,
    /boundedCount\(\s*understandingView\.theoreticalImagesPerHour,\s*understandingImagesFallback,\s*true,?\s*\)/u,
    'theoreticalImagesPerHour 优先取 status，缺失才用兜底');
  // 默认 20 秒的显示文本是“20 秒”，不是裸数字。
  assert.match(visionRegion,
    /understandingIntervalMs % 1000 === 0[\s\S]{0,120}understandingIntervalMs \/ 1000\} 秒/u,
    '毫秒间隔渲染为秒');
  console.log('2) source=vision.understanding fallback=20s/3/180/540');
});

test('3. 只读展示：没有新增开关、没有请求、没有新轮询或定时器', () => {
  assert.doesNotMatch(noteRegion, /onClick|onChange|data-settings-toggle|action:\s*['"]/u,
    '成本概览是只读展示，不新增开关/动作');
  assert.doesNotMatch(noteRegion, /fetch\(|setInterval|setTimeout|requestAnimationFrame/u,
    '成本概览不发请求、不装定时器');
  assert.doesNotMatch(visionRegion, /setInterval|setTimeout|requestAnimationFrame/u,
    '整个视觉卡片没有新增轮询/定时器');
  assert.equal((clientSource.match(/setInterval\(load, 3000\)/gu) ?? []).length, 1,
    '轮询仍只有原有的那一个');
  assert.equal((clientSource.match(/setInterval\(/gu) ?? []).length, 2,
    'client.js 的 setInterval 总数不变（原有轮询 + 顶层 tick）');
  console.log('3) readonly=yes requests=0 newTimers=0 pollSources=1');
});
