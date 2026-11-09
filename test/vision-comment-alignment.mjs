/**
 * P-186 / P-187 阶段 2：用户评论对齐（纯函数）。
 *
 * 这些用例覆盖设计文档第七节的关键分歧：
 * 快切后评论上一幕、暂停后评论、回溯词扩窗、当前词偏向最新画面、
 * 无证据、无开口时间、帧数上限、冲突词不猜，以及“开口后画面只能当现在”。
 *
 * 为什么不用 mock 时钟：本模块只吃时间戳，`now` 只在缺结束时间时兜底；
 * 直接传固定时间更接近宿主拿到的证据元数据，也能一眼看出窗口边界。
 *
 * Run: node --test test/vision-comment-alignment.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { ALIGNMENT_DEFAULTS, alignComment } from '../src/host/vision/comment-alignment.js';

/** 演示用固定时间，避免测试随真实时钟漂移。 */
const T0 = 1_700_000_000_000;

const frame = (id, capturedAt, over = {}) => ({
  id,
  capturedAt,
  source: 'desktop',
  sourceEpoch: 1,
  ...over,
});

/** 断言按采集时间升序：评论关联帧必须是时间顺序，主模型才能理解动作先后。 */
function assertAscending(ids, evidence) {
  const times = new Map(evidence.map((entry) => [entry.id, entry.capturedAt]));
  for (let i = 1; i < ids.length; i += 1) {
    assert.ok(
      times.get(ids[i - 1]) <= times.get(ids[i]),
      `relatedFrameIds 应按采集时间升序，实际为 ${ids.join(', ')}`,
    );
  }
}

test('快切后评论上一幕：开口后的新画面只进 afterSpeech，不能倒过来解释评论', () => {
  // 用户开口前画面还停在上一幕，开口后快速切镜；评论说的是上一幕，
  // 因此旧帧必须进 related，新帧只能作为“现在”单独交给调用方。
  const evidence = [
    frame('old-a', T0 - 3_000),
    frame('old-b', T0 - 1_200),
    frame('fresh-a', T0 + 800),
    frame('fresh-b', T0 + 2_100),
  ];
  const out = alignComment({
    text: '这个转身也太快了',
    startedAt: T0,
    endedAt: T0 + 3_000,
    evidence,
    now: () => T0 + 3_000,
  });

  assert.equal(out.ok, true);
  assert.deepEqual(out.window, { from: T0 - 8_000, to: T0 + 3_000 });
  assert.deepEqual(out.relatedFrameIds, ['old-a', 'old-b']);
  assert.deepEqual(out.afterSpeechFrameIds, ['fresh-a', 'fresh-b']);
  assert.equal(out.relatedFrameIds.includes('fresh-a'), false, '开口后的帧不能解释开口前的评论');
  assert.equal(out.latestFrameId, 'fresh-b');
  assert.equal(out.confidence, 'high');
  assert.equal(out.reason, 'window');
});

test('暂停几秒后评论：窗口内只有旧帧，仍然给出 related，不因缺少新画面而放弃', () => {
  // 暂停时采集不到新画面，但旧帧仍是评论指向的证据；不能把“没有最新帧”误判成“没有证据”。
  const evidence = [
    frame('paused-a', T0 - 6_000),
    frame('paused-b', T0 - 2_500),
  ];
  const out = alignComment({
    text: '她是不是笑了',
    startedAt: T0,
    endedAt: T0 + 1_200,
    evidence,
    now: () => T0 + 1_200,
  });

  assert.equal(out.ok, true);
  assert.deepEqual(out.relatedFrameIds, ['paused-a', 'paused-b']);
  assert.deepEqual(out.afterSpeechFrameIds, []);
  assert.equal(out.latestFrameId, 'paused-b');
  assert.equal(out.confidence, 'high');
  assert.equal(out.reason, 'window');
});

test('「刚才那个」扩大回溯并命中更早的帧，而不是把所有评论固定向前平移', () => {
  // 默认 8 秒看不到 12 秒前的帧；有回溯词时扩到 16 秒，才能命中用户真正指的那一幕。
  const evidence = [
    frame('early', T0 - 12_000),
    frame('recent', T0 - 3_000),
    frame('during-speech', T0 + 500),
  ];
  const neutral = alignComment({
    text: '这个动作',
    startedAt: T0,
    endedAt: T0 + 1_000,
    evidence,
    now: () => T0 + 1_000,
  });
  assert.deepEqual(neutral.relatedFrameIds, ['recent'], '没有回溯词时默认窗口不包含 12 秒前的帧');

  const out = alignComment({
    text: '刚才那个动作',
    startedAt: T0,
    endedAt: T0 + 1_000,
    evidence,
    now: () => T0 + 1_000,
  });
  assert.equal(out.reason, 'retrospective');
  assert.deepEqual(out.cues, { retrospective: true, current: false });
  assert.deepEqual(out.window, { from: T0 - 16_000, to: T0 + 1_000 });
  assert.deepEqual(out.relatedFrameIds, ['early', 'recent']);
  assert.deepEqual(out.afterSpeechFrameIds, ['during-speech']);
  assert.equal(out.confidence, 'high');
});

test('「现在右边那个」reason=current，latestFrameId 取全量证据里的最新画面', () => {
  // “现在”指向的是当前画面，不是评论窗口；即使最新帧晚于识别完成时间，
  // 它仍应作为 latestFrameId 返回，但不能混进解释评论的 related。
  const evidence = [
    frame('older', T0 - 2_000),
    frame('during', T0 + 900),
    frame('newest', T0 + 5_000),
  ];
  const out = alignComment({
    text: '现在右边那个是什么',
    startedAt: T0,
    endedAt: T0 + 3_000,
    evidence,
    now: () => T0 + 3_000,
  });

  assert.equal(out.reason, 'current');
  assert.deepEqual(out.cues, { retrospective: false, current: true });
  assert.equal(out.latestFrameId, 'newest');
  assert.deepEqual(out.relatedFrameIds, ['older']);
  assert.deepEqual(out.afterSpeechFrameIds, ['during']);
  assert.equal(out.confidence, 'high');
});

test('窗口内没有任何帧：confidence=low、reason=no-window-evidence，仍返回最新画面', () => {
  // 证据缓存有内容但都落在搜索窗口外，不能硬拿远处的帧解释当前评论。
  const evidence = [
    frame('too-old', T0 - 30_000),
    frame('too-new', T0 + 30_000),
  ];
  const out = alignComment({
    text: '这个',
    startedAt: T0,
    endedAt: T0 + 2_000,
    evidence,
    now: () => T0 + 2_000,
  });

  assert.equal(out.ok, true);
  assert.deepEqual(out.relatedFrameIds, []);
  assert.deepEqual(out.afterSpeechFrameIds, []);
  assert.equal(out.confidence, 'low');
  assert.equal(out.reason, 'no-window-evidence');
  assert.equal(out.latestFrameId, 'too-new', '最新画面独立于评论窗口返回');
});

test('没有 startedAt：ok=false、reason=no-start，不抛错也不猜时间', () => {
  // 识别完成时间不能替代开口时间，否则会把“评论上一幕”错算成“评论当前画面”。
  assert.doesNotThrow(() => alignComment());

  const out = alignComment({ text: '刚才那个', evidence: [frame('any', T0)], latestId: 'known' });
  assert.equal(out.ok, false);
  assert.deepEqual(out.window, { from: null, to: null });
  assert.deepEqual(out.relatedFrameIds, []);
  assert.deepEqual(out.afterSpeechFrameIds, []);
  assert.equal(out.confidence, 'low');
  assert.equal(out.reason, 'no-start');
  assert.equal(out.latestFrameId, 'known');
  assert.equal(out.cues.retrospective, true, '无开口时间时仍可报告文本线索，但不做对齐');
  assert.equal(alignComment({ startedAt: '   ' }).reason, 'no-start', '空白字符串不是有效开口时间');
  assert.equal(alignComment({ startedAt: 'not-a-time' }).reason, 'no-start');
});

test('maxFrames 上限与升序：均匀取首/中/尾，取不到就少取', () => {
  // 主请求只带少量帧，但必须覆盖窗口首尾，不能只取最近的几帧而漏掉评论指向的开头。
  const evidence = [
    frame('p1', T0 - 7_000),
    frame('p2', T0 - 6_000),
    frame('p3', T0 - 5_000),
    frame('p4', T0 - 4_000),
    frame('p5', T0 - 3_000),
    frame('p6', T0 - 2_000),
  ];
  const defaulted = alignComment({
    text: '这一串动作',
    startedAt: T0,
    endedAt: T0 + 500,
    evidence,
    now: () => T0 + 500,
  });
  assert.equal(defaulted.relatedFrameIds.length, ALIGNMENT_DEFAULTS.maxFrames);
  assert.equal(defaulted.relatedFrameIds[0], 'p1', '保留窗口最早的帧');
  assert.equal(defaulted.relatedFrameIds.at(-1), 'p6', '保留离开口最近的帧');
  assertAscending(defaulted.relatedFrameIds, evidence);

  const limited = alignComment({
    text: '这一串动作',
    startedAt: T0,
    endedAt: T0 + 500,
    evidence,
    now: () => T0 + 500,
    maxFrames: 2,
  });
  assert.deepEqual(limited.relatedFrameIds, ['p1', 'p6'], '两帧时取首尾');
  assertAscending(limited.relatedFrameIds, evidence);

  const all = alignComment({
    text: '这一串动作',
    startedAt: T0,
    endedAt: T0 + 500,
    evidence,
    now: () => T0 + 500,
    maxFrames: 10,
  });
  assert.deepEqual(all.relatedFrameIds, ['p1', 'p2', 'p3', 'p4', 'p5', 'p6']);
  assertAscending(all.relatedFrameIds, evidence);
});

test('冲突词：同时有回溯与当前线索时不扩窗、不猜，confidence=low', () => {
  // “刚才那个现在还在动吗”既回指又指现在，规则无法判断主轴；
  // 此时保留默认窗口和候选，但把置信度降下来，交给调用方确认。
  const evidence = [
    frame('pre-a', T0 - 4_000),
    frame('pre-b', T0 - 1_000),
  ];
  const out = alignComment({
    text: '刚才那个现在还在动吗',
    startedAt: T0,
    endedAt: T0 + 1_500,
    evidence,
    now: () => T0 + 1_500,
  });

  assert.deepEqual(out.cues, { retrospective: true, current: true });
  assert.deepEqual(out.window, { from: T0 - 8_000, to: T0 + 1_500 }, '冲突时不使用扩大后的回溯窗口');
  assert.equal(out.reason, 'window');
  assert.equal(out.confidence, 'low');
  assert.deepEqual(out.relatedFrameIds, ['pre-a', 'pre-b'], '候选仍保留，只是不宣称高置信');
});

test('窗口里只有开口后的帧：related 为空、confidence=low，afterSpeech 仍可作为现在', () => {
  // 用户说完才出现画面，或证据缓存把开口前的内容淘汰了；这些帧不能倒着解释评论。
  const evidence = [
    frame('after-1', T0 + 400),
    frame('after-2', T0 + 1_500),
  ];
  const out = alignComment({
    text: '现在这个',
    startedAt: T0,
    endedAt: T0 + 2_000,
    evidence,
    now: () => T0 + 2_000,
  });

  assert.equal(out.ok, true);
  assert.deepEqual(out.relatedFrameIds, []);
  assert.deepEqual(out.afterSpeechFrameIds, ['after-1', 'after-2']);
  assert.equal(out.confidence, 'low');
  assert.equal(out.reason, 'current');
  assert.equal(out.latestFrameId, 'after-2');

  const passed = alignComment({
    startedAt: T0,
    endedAt: T0 + 2_000,
    evidence: [frame('after-1', T0 + 400)],
    latestId: 'ui-latest',
    now: () => T0 + 2_000,
  });
  assert.equal(passed.latestFrameId, 'ui-latest', '调用方已知最新画面时优先采用');
});

test('endedAt 早于 startedAt：视为没有结束时间，改用 now 而不是产生反向窗口', () => {
  // 识别完成时间可能因时钟回拨或重试早于开口；此时不能把窗口截断到开口之前。
  const out = alignComment({
    text: '这个',
    startedAt: T0,
    endedAt: T0 - 5_000,
    evidence: [frame('after-end', T0 + 700)],
    now: () => T0 + 2_000,
  });

  assert.deepEqual(out.window, { from: T0 - 8_000, to: T0 + 2_000 });
  assert.deepEqual(out.relatedFrameIds, []);
  assert.deepEqual(out.afterSpeechFrameIds, ['after-end']);
  assert.equal(out.reason, 'window');
  assert.equal(out.confidence, 'low');
});

test('非法或残缺证据不抛错：跳过坏记录，只对齐可用的 id + 采集时间', () => {
  // 证据窗口淘汰、序列化或来源切换可能留下残缺项；一条坏记录不应拖垮整句评论对齐。
  const evidence = [
    null,
    {},
    { id: '', capturedAt: T0 - 1_000 },
    { id: 'ok', capturedAt: T0 - 1_000 },
    { id: 'bad-time', capturedAt: 'not-a-time' },
    { id: 'negative-time', capturedAt: -1 },
  ];
  const out = alignComment({
    text: '这个',
    startedAt: T0,
    endedAt: T0 + 1_000,
    evidence,
    now: () => T0 + 1_000,
  });

  assert.equal(out.ok, true);
  assert.deepEqual(out.relatedFrameIds, ['ok']);
  assert.deepEqual(out.afterSpeechFrameIds, []);
  assert.equal(out.latestFrameId, 'ok');
  assert.equal(out.confidence, 'high');
});
