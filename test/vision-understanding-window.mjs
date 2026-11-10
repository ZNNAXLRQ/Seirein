/**
 * P-187 后续：理解窗口选择与“no-frames 可诊断”的纯模块测试。
 *
 * 背景：线上日志连续 `vision.evidence.added`，但 `understanding-run` 反复 `no-frames`。
 * 这里用假时钟 + 假证据固定三件事：
 *
 *   1. `between()` 用可见范围相交，边界（含 from/to）必须命中；故事板 from/to、逐帧时刻
 *      与镜头身份都参与选择，不会被压成采集点；
 *   2. 缓存里确实有帧、只是被窗口/来源/代次过滤掉时，`diagnose()` 给出机器原因与安全计数；
 *      `no-baseline` 只属于真正没有已登记证据的窗口；
 *   3. 静态画面没有新变化时，有界 `baseline()` 能让最近一帧仍被选中；超龄/跨代次/早于
 *      本轮会话的帧不能当基准。
 *
 * 全部不读磁盘、不调用模型、不截图。
 *
 * Run: node --test test/vision-understanding-window.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createEvidenceWindow } from '../src/host/vision/evidence-window.js';
import { createUnderstandingRuntime } from '../src/host/vision/understanding-runtime.js';

const BASE = 1_700_000_000_000;
const SOURCE = 'desktop';
const EPOCH = 1;

function frame(over = {}) {
  return {
    file: 'C:\\cache\\evidence\\ev.png',
    bytes: 100,
    capturedAt: BASE,
    source: SOURCE,
    sourceEpoch: EPOCH,
    kind: 'storyboard',
    width: 800,
    height: 450,
    ...over,
  };
}

function sheet(startedAt, endedAt, over = {}) {
  return frame({
    capturedAt: startedAt,
    startedAt,
    endedAt,
    kind: 'storyboard',
    ...over,
  });
}

/** 原始输出形状合格的成功分析器；记录每次实际收到的帧。 */
function makeAnalyzer(calls) {
  return async (input) => {
    const at = Number(input?.interval?.from) || BASE;
    calls.push({
      frames: Array.isArray(input?.frames) ? input.frames.map((entry) => entry.id) : [],
      from: input?.interval?.from,
      to: input?.interval?.to,
    });
    return JSON.stringify({
      sceneSummary: '假场景',
      events: [],
      unresolved: '',
      observedAt: at,
    });
  };
}

function makeRuntime(clock, framesBetween, calls) {
  return createUnderstandingRuntime({
    now: () => clock.now,
    framesBetween,
    audioBetween: () => [],
    analyze: makeAnalyzer(calls),
    maxFrames: 8,
    maxAgeMs: 300_000,
  });
}

// ---------------------------------------------------------------------------
// 1. 范围相交与边界
// ---------------------------------------------------------------------------

test('between：故事板 from/to 与窗口相交即命中，边界含 from/to，不压成采集点', () => {
  const clock = { now: BASE + 10_000 };
  const window = createEvidenceWindow({ now: () => clock.now });
  const added = window.add(sheet(BASE, BASE + 5_000, { frameTimes: [BASE, BASE + 2_500, BASE + 5_000] }));
  assert.ok(added !== null);
  assert.equal(added.startedAt, BASE);
  assert.equal(added.endedAt, BASE + 5_000);

  // capturedAt 在窗口外（BASE+5s 之前），但可见范围覆盖窗口：必须命中。
  assert.deepEqual(window.between(BASE + 2_000, BASE + 3_000).map((entry) => entry.id), [added.id]);
  // 含边界：结束时刻等于 from、开始时刻等于 to 都算相交。
  assert.equal(window.between(BASE + 5_000, BASE + 6_000).length, 1, 'endedAt == from 命中');
  assert.equal(window.between(BASE - 1_000, BASE).length, 1, 'startedAt == to 命中');
  // 完全在可见范围之外（哪怕是 1ms）就不命中。
  assert.equal(window.between(BASE + 5_001, BASE + 6_000).length, 0);
  assert.equal(window.between(BASE - 2_000, BASE - 1).length, 0);

  // note 窗口直接从 added.startedAt/endedAt 取，与 between 同一套时间，不会“记进去但查不到”。
  const noteWindow = { from: added.startedAt, to: added.endedAt };
  assert.equal(window.between(noteWindow.from, noteWindow.to,
    { source: SOURCE, sourceEpoch: EPOCH }).length, 1);
});

test('between：同窗口多帧按 capturedAt 升序；当前镜头用 latest，上一镜头仍可按范围命中', () => {
  const clock = { now: BASE + 20_000 };
  const window = createEvidenceWindow({ now: () => clock.now, minGapMs: 0 });
  const previous = window.add(sheet(BASE + 1_000, BASE + 1_000, {
    file: 'C:\\cache\\evidence\\previous.png', shotId: 'shot-a', kind: 'frame', frameTimes: [BASE + 1_000],
  }));
  const current = window.add(sheet(BASE + 11_000, BASE + 13_000, {
    file: 'C:\\cache\\evidence\\current.png', shotId: 'shot-b', frameTimes: [BASE + 11_000, BASE + 12_000],
  }));
  assert.ok(previous !== null && current !== null);

  // 8/16 秒回溯窗口仍能取到上一镜头；顺序按采集时间。
  const hit = window.between(BASE, BASE + 12_000);
  assert.deepEqual(hit.map((entry) => entry.shotId), ['shot-a', 'shot-b']);
  assert.equal(window.latest().shotId, 'shot-b', '当前镜头 = 最新一帧');

  // 逐帧时刻只统计窗口内真实发生的变化：整段 2 次，左半段 1 次，右边界含 2s 那一刻。
  assert.equal(window.diagnose(BASE, BASE + 13_000).frameTimesInWindow, 3,
    '窗口内实际变化：上一镜头 1 次 + 当前镜头 2 次');
  assert.equal(window.diagnose(BASE + 11_000, BASE + 11_500).frameTimesInWindow, 1);
  assert.equal(window.diagnose(BASE + 12_000, BASE + 13_000).frameTimesInWindow, 1);
});

// ---------------------------------------------------------------------------
// 2. 来源/代次过滤与排除原因
// ---------------------------------------------------------------------------

test('between：来源/代次严格过滤；diagnose 把“窗口里有帧但被 epoch 过滤”标成 source-epoch', () => {
  const clock = { now: BASE + 5_000 };
  const window = createEvidenceWindow({ now: () => clock.now });
  const added = window.add(sheet(BASE, BASE + 2_000, { source: 'obs', sourceEpoch: 3 }));
  assert.ok(added !== null);

  assert.equal(window.between(BASE, BASE + 2_000, { source: 'obs', sourceEpoch: 3 }).length, 1);
  assert.equal(window.between(BASE, BASE + 2_000, { source: 'desktop', sourceEpoch: 3 }).length, 0);
  assert.equal(window.between(BASE, BASE + 2_000, { source: 'obs', sourceEpoch: 2 }).length, 0);

  const bySource = window.diagnose(BASE, BASE + 2_000, { source: 'desktop', sourceEpoch: 3 });
  assert.equal(bySource.reason, 'source-epoch');
  assert.equal(bySource.inWindow, 1);
  assert.equal(bySource.selected, 0);
  assert.equal(bySource.sourceMismatch, 1);
  assert.equal(bySource.epochMismatch, 0);

  const byEpoch = window.diagnose(BASE, BASE + 2_000, { source: 'obs', sourceEpoch: 2 });
  assert.equal(byEpoch.reason, 'source-epoch');
  assert.equal(byEpoch.epochMismatch, 1);
  assert.equal(byEpoch.sourceMismatch, 0);

  const ok = window.diagnose(BASE, BASE + 2_000, { source: 'obs', sourceEpoch: 3 });
  assert.equal(ok.reason, 'frames');
  assert.equal(ok.selected, 1);
});

test('清空/换代：旧证据读不到，no-baseline 只在缓存真的为空时出现', () => {
  const clock = { now: BASE + 5_000 };
  const window = createEvidenceWindow({ now: () => clock.now });
  window.add(sheet(BASE, BASE + 1_000));

  // 缓存非空但窗口在范围外：原因是 outside-window，不是 no-baseline。
  const outside = window.diagnose(BASE + 20_000, BASE + 30_000);
  assert.equal(outside.reason, 'outside-window');
  assert.equal(outside.total, 1);
  assert.equal(outside.inWindow, 0);
  assert.equal(outside.outsideWindow, 1);

  const result = window.clear('vision-invalidated');
  assert.equal(result.generation, 1);
  assert.equal(window.state().frames, 0);
  assert.equal(window.between(BASE, BASE + 1_000).length, 0);

  const empty = window.diagnose(BASE, BASE + 1_000);
  assert.equal(empty.reason, 'no-baseline');
  assert.equal(empty.total, 0);
  assert.equal(empty.inWindow, 0);

  // 新代次的帧照常命中；诊断只回显标量，不带路径/帧 id。
  const next = window.add(sheet(BASE + 100, BASE + 1_100, { sourceEpoch: 2 }));
  assert.ok(next !== null);
  assert.equal(window.between(BASE, BASE + 2_000, { sourceEpoch: 2 }).length, 1);
  const safe = JSON.stringify(window.diagnose(BASE, BASE + 2_000, { sourceEpoch: 2 }));
  assert.equal(safe.includes('C:\\\\'), false, '诊断不带路径');
  assert.equal(safe.includes('ev-'), false, '诊断不带帧 id');
  assert.equal(safe.includes('base 场景正文'), false);
});

// ---------------------------------------------------------------------------
// 3. 静态画面基准帧（有界）
// ---------------------------------------------------------------------------

test('baseline：取同来源/同代次、有界时间内最新一帧；超龄或早于本轮会话不算', () => {
  const clock = { now: BASE + 30_000 };
  const window = createEvidenceWindow({ now: () => clock.now });
  window.add(sheet(BASE + 10_000, BASE + 12_000, { file: 'C:\\cache\\evidence\\a.png', sourceEpoch: 1 }));
  const newest = window.add(sheet(BASE + 20_000, BASE + 22_000, { file: 'C:\\cache\\evidence\\b.png', sourceEpoch: 1 }));
  window.add(sheet(BASE + 15_000, BASE + 16_000, { file: 'C:\\cache\\evidence\\c.png', source: 'obs', sourceEpoch: 1 }));
  assert.ok(newest !== null);

  const baseline = window.baseline({ source: SOURCE, sourceEpoch: 1, maxAgeMs: 15_000 });
  assert.ok(baseline !== null);
  assert.equal(baseline.id, newest.id, '返回最新可用帧');
  assert.equal(baseline.baseline, true);
  assert.equal(baseline.ageMs, 8_000, 'age 从可见结束时刻算');

  // 超龄：30s 前结束的帧不再当基准。
  assert.equal(window.baseline({ source: SOURCE, sourceEpoch: 1, maxAgeMs: 5_000 }), null);
  // 跨来源/代次：不能借用别的画面。
  assert.equal(window.baseline({ source: 'obs', sourceEpoch: 1, maxAgeMs: 15_000 })?.source, 'obs');
  assert.equal(window.baseline({ source: SOURCE, sourceEpoch: 2, maxAgeMs: 15_000 }), null);
  // 早于本轮陪伴会话的帧（例如首轮前的缓存）不得成为基准。
  assert.equal(window.baseline({
    source: SOURCE, sourceEpoch: 1, maxAgeMs: 15_000, minEndedAt: BASE + 25_000,
  }), null);
  assert.ok(window.baseline({
    source: SOURCE, sourceEpoch: 1, maxAgeMs: 15_000, minEndedAt: BASE + 21_000,
  }) !== null);
  // 非法上限直接返回 null，绝不无限回看。
  assert.equal(window.baseline({ source: SOURCE, sourceEpoch: 1, maxAgeMs: 0 }), null);
  assert.equal(window.baseline({ source: SOURCE, sourceEpoch: 1, maxAgeMs: Number.NaN }), null);
});

test('静态画面：窗口里没有新帧时，有界基准能把真实帧重新选进理解窗口', async () => {
  const clock = { now: BASE + 30_000 };
  const window = createEvidenceWindow({ now: () => clock.now, minGapMs: 0 });
  // 最后一次变化发生在 20 秒前；之后画面静止，不再有 added。
  const baseline = window.add(sheet(BASE + 8_000, BASE + 10_000, {
    shotId: 'shot-static', frameTimes: [BASE + 8_000, BASE + 9_000],
  }));
  assert.ok(baseline !== null);

  const calls = [];
  const runtime = makeRuntime(clock, (from, to) => window.between(from, to, {
    source: SOURCE, sourceEpoch: EPOCH,
  }), calls);

  // 自然评论的窗口（例如 sentAt - 16s）覆盖不到 20 秒前的帧：这是真实的 outside-window。
  const directFrom = BASE + 14_000;
  const directTo = BASE + 30_000;
  const direct = await runtime.runNow({ from: directFrom, to: directTo, reason: 'typed' });
  assert.equal(direct.ok, false);
  assert.equal(direct.reason, 'no-frames');
  assert.equal(window.diagnose(directFrom, directTo).reason, 'outside-window');
  assert.equal(calls.length, 0, 'no-frames 不调用模型');

  // 有界基准兜底：起点前移到基准帧的可见范围，结束点不变。
  const base = window.baseline({ source: SOURCE, sourceEpoch: EPOCH, maxAgeMs: 90_000 });
  assert.ok(base !== null);
  const widened = { from: Math.min(directFrom, base.startedAt ?? base.capturedAt), to: directTo };
  const result = await runtime.runNow({ ...widened, reason: 'typed' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].frames, [baseline.id], '基准帧真实进入本次请求');
  assert.deepEqual([calls[0].from, calls[0].to], [BASE + 8_000, BASE + 30_000]);

  const view = window.diagnose(widened.from, widened.to, { source: SOURCE, sourceEpoch: EPOCH });
  assert.equal(view.reason, 'frames');
  assert.equal(view.selected, 1);
  assert.equal(view.frameTimesInWindow, 2, '窗口内实际有两次逐帧变化，不是“只记变化”一句话');
});

test('no-frames 只在窗口真的没有可用帧时发生：有帧则 window.frameCount>0 且不 no-frames', async () => {
  const clock = { now: BASE + 3_000 };
  const window = createEvidenceWindow({ now: () => clock.now });
  window.add(sheet(BASE, BASE + 2_000, { frameTimes: [BASE, BASE + 1_000] }));
  const calls = [];
  const runtime = makeRuntime(clock, (from, to) => window.between(from, to, {
    source: SOURCE, sourceEpoch: EPOCH,
  }), calls);
  // 边界窗口 [endedAt, endedAt] 也能选中；有帧就不可能 no-frames。
  const outcome = await runtime.runNow({ from: BASE + 2_000, to: BASE + 2_000, reason: 'sheet' });
  assert.equal(outcome.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(window.diagnose(BASE + 2_000, BASE + 2_000).selected, 1);
});
