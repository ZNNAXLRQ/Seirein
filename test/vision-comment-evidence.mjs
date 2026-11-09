/**
 * P-186 / P-187 阶段 2：本轮评论证据（纯状态 + 文本渲染）。
 *
 * 覆盖 attach/render 的契约：评论关联窗口与当前最新画面分开、TTL 读时清理、
 * 同会话覆盖/跨会话隔离/maxSessions 淘汰、maxChars 截断、畸形 alignment 不抛错、
 * clear/clearAll，以及“不持有调用方可变引用、绝不出现文件路径/台词正文”。
 *
 * 时间全部用固定时间戳，避免测试随真实时钟漂移；本地 `HH:MM:SS` 由测试自己格式化，
 * 因此在任何时区运行都能对齐同一套断言。
 *
 * Run: node --test test/vision-comment-evidence.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COMMENT_EVIDENCE_DEFAULTS,
  createCommentEvidence,
} from '../src/host/vision/comment-evidence.js';

const T0 = 1_700_000_000_000;

/** 与模块相同的本地时间格式；只用于断言，不参与模块计算。 */
function hhmmss(at) {
  const date = new Date(at);
  const pad = (number) => String(number).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function alignment(over = {}) {
  return {
    confidence: 'high',
    reason: 'window',
    window: { from: T0 - 8_000, to: T0 + 4_000 },
    cues: { retrospective: false, current: false },
    relatedFrameIds: ['ev-1', 'ev-2'],
    afterSpeechFrameIds: ['ev-3'],
    latestFrameId: 'ev-3',
    ...over,
  };
}

function attachInput(over = {}) {
  return {
    sessionId: 'voice-session-a',
    utteranceId: 'u-1',
    startedAt: T0,
    endedAt: T0 + 4_000,
    alignment: alignment(),
    latestId: 'ev-3',
    latestAt: T0 + 9_000,
    frameCount: 3,
    ...over,
  };
}

test('attach 后 render：评论关联窗口/当前最新画面/把握齐全，且不含路径或台词', () => {
  let clock = T0 + 6_000;
  const evidence = createCommentEvidence({ now: () => clock });
  const saved = evidence.attach(attachInput());
  assert.ok(saved !== null);
  assert.equal(saved.sessionId, 'voice-session-a');

  const text = evidence.render('voice-session-a');
  assert.ok(text.includes('【视听证据｜本轮评论对齐】'));
  assert.ok(text.includes(`- 用户开口：${hhmmss(T0)}；语音结束（端点）：${hhmmss(T0 + 4_000)}`));
  assert.equal(text.includes('识别完成'), false, 'audioEndAt 是语音端点，不能误标成识别完成');
  assert.ok(text.includes(`- 评论关联窗口：${hhmmss(T0 - 8_000)}–${hhmmss(T0 + 4_000)}（窗口内 3 帧，关联 2 帧）`));
  assert.ok(text.includes('当前最新画面'));
  assert.ok(text.includes(`${hhmmss(T0 + 9_000)} 采集`));
  assert.ok(text.includes('晚于开口'), '最新画面晚于开口时必须明确不能倒过来解释评论');
  assert.ok(text.includes('关联把握：高（原因：window）'));
  assert.ok(text.includes('不要声称已经看见画面内容'), '图片内容尚未交付的边界必须写清楚');
  assert.ok(
    text.includes('如需回看关联帧，可调用 assistant_see 并传入 evidenceFrameIds（最多 3 个）'),
    '说明行指向按 id 回看的工具入口',
  );
  assert.equal(text.includes('C:\\'), false, '渲染不含 Windows 路径');
  assert.equal(text.includes('cache'), false, '渲染不含缓存目录');
  assert.equal(text.includes('u-1'), false, '渲染不含台词/语句 id 正文');

  // 记录按 attach 时刻计 TTL：刚 attach 后仍有效，state 只给计数与时间。
  clock += 1_000;
  const state = evidence.state();
  assert.equal(state.sessions, 1);
  assert.equal(state.latestAt, T0 + 6_000);
  assert.ok(state.attached >= 1);
  assert.equal(JSON.stringify(state).includes('【视听证据'), false, 'state 不含正文');
});

test('attach 复制入参：调用方事后改对象/数组/嵌套窗口，已存记录不变', () => {
  const evidence = createCommentEvidence({ now: () => T0 + 1_000 });
  const input = attachInput();
  evidence.attach(input);
  // 外层对象、alignment 本身、嵌套 window/cues、数组全部改一遍。
  input.sessionId = 'someone-else';
  input.alignment.reason = 'current';
  input.alignment.window.from = 0;
  input.alignment.window.to = 0;
  input.alignment.cues.current = true;
  input.alignment.relatedFrameIds.push('ev-9');
  input.alignment.afterSpeechFrameIds.length = 0;
  input.alignment.latestFrameId = 'ev-9';

  const saved = evidence.take('voice-session-a');
  assert.ok(saved !== null, '原 session 的记录仍在');
  assert.equal(saved.alignment.reason, 'window');
  assert.deepEqual(saved.alignment.window, { from: T0 - 8_000, to: T0 + 4_000 });
  assert.deepEqual(saved.alignment.cues, { retrospective: false, current: false });
  assert.deepEqual(saved.alignment.relatedFrameIds, ['ev-1', 'ev-2']);
  assert.deepEqual(saved.alignment.afterSpeechFrameIds, ['ev-3']);
  assert.equal(evidence.take('someone-else'), null);
  assert.equal(evidence.render('voice-session-a').includes('window'), true);
  assert.equal(evidence.render('voice-session-a').includes('current'), false);
});

test('TTL 过期：推进时钟后 take/render 为空，state 清理过期会话', () => {
  let clock = T0;
  const evidence = createCommentEvidence({ now: () => clock, ttlMs: 1_000 });
  evidence.attach(attachInput());
  assert.ok(evidence.take('voice-session-a') !== null);
  assert.ok(evidence.render('voice-session-a').length > 0);

  clock = T0 + 999;
  assert.ok(evidence.render('voice-session-a').length > 0, 'TTL 内仍有效');
  clock = T0 + 1_000;
  assert.equal(evidence.take('voice-session-a'), null, '到期即失效');
  assert.equal(evidence.render('voice-session-a'), '');
  const state = evidence.state();
  assert.equal(state.sessions, 0);
  assert.equal(state.expired, 1);
  assert.equal(state.latestAt, null);
});

test('同一 session 覆盖最近一条；不同 session 互不影响；maxSessions 淘汰最久未更新的会话', () => {
  let clock = T0;
  const evidence = createCommentEvidence({ now: () => clock, maxSessions: 2 });
  evidence.attach(attachInput({ sessionId: 's1', utteranceId: 'u-1' }));
  clock += 10;
  evidence.attach(attachInput({ sessionId: 's2', utteranceId: 'u-2' }));
  clock += 10;
  // 覆盖 s1：记录内容更新，并因“最近使用”移到队尾。
  evidence.attach(attachInput({ sessionId: 's1', utteranceId: 'u-3' }));

  assert.equal(evidence.state().sessions, 2);
  assert.equal(evidence.take('s1').utteranceId, 'u-3', '同一 session 只保留最近一条');
  const s1Text = evidence.render('s1');
  const s2Text = evidence.render('s2');
  assert.ok(s1Text.length > 0 && s2Text.length > 0);
  assert.notEqual(s1Text, '', '不同 session 各自可读');
  assert.equal(evidence.take('s2').utteranceId, 'u-2', '覆盖 s1 不影响 s2');

  clock += 10;
  evidence.attach(attachInput({ sessionId: 's3', utteranceId: 'u-4' }));
  assert.equal(evidence.take('s2'), null, '最久未更新的 s2 被淘汰');
  assert.equal(evidence.take('s1').utteranceId, 'u-3');
  assert.equal(evidence.take('s3').utteranceId, 'u-4');
  const state = evidence.state();
  assert.equal(state.sessions, 2);
  assert.equal(state.evicted, 1);

  // 淘汰后 s2 的旧记录绝不再被渲染。
  assert.equal(evidence.render('s2'), '');
});

test('maxChars 截断到上限；畸形 alignment 不抛错，把握/原因按低/未知渲染', () => {
  const tight = createCommentEvidence({ now: () => T0, maxChars: 80 });
  tight.attach(attachInput());
  const clipped = tight.render('voice-session-a');
  assert.ok(clipped.length > 0);
  assert.ok(clipped.length <= 80, '渲染不超过 maxChars');
  assert.equal(clipped.length, 80, '超长文本被截到上限而不是丢弃');

  const evidence = createCommentEvidence({ now: () => T0 });
  const broken = [
    null,
    'not-an-object',
    [],
    42,
    { window: 'nope', confidence: 1, reason: 7, relatedFrameIds: 'nope' },
    { window: { from: 'bad', to: {} }, confidence: 'high', reason: '  window  ', relatedFrameIds: [null, {}, 'ok', 'ok'] },
  ];
  for (const value of broken) {
    assert.doesNotThrow(() => evidence.attach(attachInput({ alignment: value, sessionId: 'broken' })));
  }
  assert.equal(evidence.render('missing-session'), '');
  assert.doesNotThrow(() => evidence.take('missing-session'));

  // 完全不存在的 alignment：必须渲染“低/未知”，不能把 undefined/null 文本漏进提示词。
  evidence.attach(attachInput({ alignment: null, sessionId: 'malformed' }));
  const text = evidence.render('malformed');
  assert.ok(text.includes('关联把握：低（原因：未知）'));

  // 明确缺 confidence/reason：同样按“低/未知”。
  evidence.attach(attachInput({ alignment: { window: { from: T0, to: T0 } }, sessionId: 'missing-fields' }));
  const missing = evidence.render('missing-fields');
  assert.ok(missing.includes('关联把握：低（原因：未知）'));
  assert.equal(missing.includes('undefined'), false);
  assert.equal(missing.includes('null'), false);
  assert.equal(missing.includes('[object'), false);

  // 原因字段即使被塞进文件路径，也只允许机器码通过；路径/正文绝不进入提示词。
  evidence.attach(attachInput({
    alignment: { confidence: 'high', reason: 'C:\\cache\\evidence\\frame.png' },
    sessionId: 'path-reason',
  }));
  const pathText = evidence.render('path-reason');
  assert.ok(pathText.includes('关联把握：高（原因：未知）'));
  assert.equal(pathText.includes('C:\\'), false);
  assert.equal(pathText.includes('frame.png'), false);
});

test('clear 只清指定会话；clearAll 清空；未知会话安全返回；默认参数不是冻结值', () => {
  const evidence = createCommentEvidence({ now: () => T0 });
  evidence.attach(attachInput({ sessionId: 's1' }));
  evidence.attach(attachInput({ sessionId: 's2' }));

  assert.equal(evidence.clear('s1'), true);
  assert.equal(evidence.render('s1'), '');
  assert.ok(evidence.render('s2').length > 0, 'clear 不影响其他会话');
  assert.equal(evidence.clear('missing'), false);
  assert.equal(evidence.clear(''), false);
  assert.equal(evidence.state().sessions, 1);

  evidence.clearAll();
  assert.equal(evidence.render('s2'), '');
  assert.equal(evidence.take('s2'), null);
  assert.equal(evidence.state().sessions, 0);

  assert.equal(COMMENT_EVIDENCE_DEFAULTS.ttlMs, 120_000);
  assert.equal(COMMENT_EVIDENCE_DEFAULTS.maxSessions, 8);
  assert.equal(COMMENT_EVIDENCE_DEFAULTS.maxChars, 400);
});
