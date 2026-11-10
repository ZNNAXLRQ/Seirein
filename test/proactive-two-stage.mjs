/**
 * P-187 阶段 5 补充：主动链诊断二分 + 两阶段门禁（纯逻辑）。
 *
 * 覆盖三件事：
 *   1. `proposeCalls` / `lastProposeRejectReason` 能把“从未 propose”“propose 被 expired 拒绝”
 *      “重复/已说过的 duplicate”分开；`ignored()` 后的 quiet 仍由 evaluate 给出 too-soon。
 *   2. 宏观候选先过本地门禁（过期/用户已评论/助手已回应/重复/quiet/busy），这些拒绝
 *      不会触发 detail 回查。
 *   3. 只有短描述且带理解层事件 id 的候选才回查本地 event-index；回查只读、modelCalls 恒 0，
 *      细节缺失/原帧失效时返回机器原因，不产生“可以开口”的结果。spoken 用纯仲裁器覆盖，
 *      不依赖真实 TTS。
 *
 * Run: node --test test/proactive-two-stage.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PROACTIVE_DEFAULTS,
  createProactiveArbiter,
} from '../src/host/vision/proactive-candidate.js';
import {
  createProactiveTwoStageGate,
  needsProactiveDetail,
  resolveProactiveDetail,
} from '../src/host/vision/proactive-detail.js';

const T0 = 1_700_000_000_000;

function makeCandidate(over = {}) {
  return {
    id: 'event-1',
    eventId: 'evt-1',
    sourceEventId: 'ue-1',
    from: T0 - 1_000,
    to: T0,
    occurredAt: T0 - 500,
    description: '推门',
    evidenceFrameIds: ['frame-1'],
    evidenceAudioIds: [],
    angle: '像是刚回来',
    expiresAt: T0 + 60_000,
    priority: 1,
    ...over,
  };
}

test('仲裁器诊断：proposeCalls/拒绝分类/quiet 与纯仲裁器 spoken', () => {
  let now = T0;
  const arbiter = createProactiveArbiter({ now: () => now, draw: () => 0 });

  const candidate = arbiter.propose(makeCandidate());
  assert.ok(candidate, '合法候选应登记');
  let status = arbiter.status();
  assert.equal(status.counts.proposed, 1);
  assert.equal(status.proposeCalls, 1, 'propose 被调用一次');
  assert.equal(status.lastProposeRejectReason, null);

  const decision = arbiter.evaluate({ settings: { enabled: true, rate: 100 } });
  assert.equal(decision.speak, true);
  assert.equal(decision.reason, 'rate-hit');
  status = arbiter.status();
  assert.equal(status.drawn, 1);
  assert.equal(status.passed, 1);

  // 纯仲裁器覆盖 spoken；宿主层因 voice off 只会到 speech-failed，不在宿主断言 spoken。
  arbiter.spoken(candidate);
  status = arbiter.status();
  assert.equal(status.counts.spoken, 1);
  assert.equal(status.lastReason, 'spoken');

  // duplicate：同事件身份在“刚说过”的抑制窗口内再次登记。
  assert.equal(arbiter.propose(makeCandidate({ id: 'event-2' })), null);
  status = arbiter.status();
  assert.equal(status.counts.rejected, 1);
  assert.equal(status.lastProposeRejectReason, 'duplicate');
  assert.equal(status.proposeCalls, 2, '被拒绝的 propose 也计入调用次数');

  // expired：内容时间早于 maxAgeMs 的默认窗口。
  assert.equal(arbiter.propose(makeCandidate({
    id: 'event-old',
    eventId: 'evt-old',
    sourceEventId: 'ue-old',
    from: T0 - 120_000,
    to: T0 - 120_000,
    occurredAt: T0 - 120_000,
    expiresAt: T0 - 60_000,
  })), null);
  status = arbiter.status();
  assert.equal(status.lastProposeRejectReason, 'expired');
  assert.ok(status.counts.expired >= 1);
  assert.equal(status.proposeCalls, 3);

  // quiet：ignored() 之后 evaluate 在选候选之前就返回 too-soon，不抽签。
  arbiter.ignored();
  const quietDecision = arbiter.evaluate({ settings: { enabled: true, rate: 100 } });
  assert.equal(quietDecision.speak, false);
  assert.equal(quietDecision.reason, 'too-soon');
  status = arbiter.status();
  assert.equal(status.lastReason, 'too-soon');
  assert.equal(status.drawn, 1, 'quiet 不得重新抽签');

  // reset 是代次边界：清最近原因/身份，但累计诊断计数（含 proposeCalls）保留。
  arbiter.reset('test-reset');
  status = arbiter.status();
  assert.equal(status.proposeCalls, 3);
  assert.equal(status.lastProposeRejectReason, null);
  assert.equal(status.lastReason, 'test-reset');
  assert.equal(status.counts.spoken, 1, 'reset 不归零累计计数');
  assert.equal(PROACTIVE_DEFAULTS.importantMaxAgeMs, 60_000);
});

test('两阶段本地门禁：过期/已评论/已回应/重复/quiet/busy 都不触发 detail', () => {
  let now = T0;
  let detailCalls = 0;
  const gate = createProactiveTwoStageGate({
    now: () => now,
    detail: () => {
      detailCalls += 1;
      return { ok: true, evidence: { source: 'event-index', frameIds: ['frame-1'] } };
    },
  });
  const candidate = makeCandidate();

  assert.equal(gate.consider(candidate, { userSpeaking: true }).reason, 'user-speaking');
  assert.equal(gate.consider(candidate, { assistantBusy: true }).reason, 'assistant-busy');
  assert.equal(gate.consider(candidate, { pendingReply: true }).reason, 'pending-reply');
  assert.equal(gate.consider(candidate, { quietUntil: T0 + 5_000 }).reason, 'quiet');
  assert.equal(gate.consider({ ...candidate, expiresAt: T0 - 1 }).reason, 'expired');

  const commented = gate.consider(
    { ...candidate, occurredAt: T0 - 2_000 },
    { userCommentAt: T0 - 1_000 },
  );
  assert.equal(commented.ok, false);
  assert.equal(commented.reason, 'user-commented');
  assert.equal(commented.passive, true, '用户已讨论同一事件时并入被动');
  assert.equal(commented.cancel, true);

  const replied = gate.consider(
    { ...candidate, occurredAt: T0 - 2_000 },
    { assistantReplyAt: T0 - 1_000 },
  );
  assert.equal(replied.reason, 'assistant-replied');
  assert.equal(detailCalls, 0, '所有本地拒绝都不应回查细节');

  // 第一次通过 detail 后记住身份；第二次同身份直接 duplicate，不重复回查。
  const accepted = gate.consider(candidate, {});
  assert.equal(accepted.ok, true);
  assert.equal(accepted.stage, 'detail');
  assert.equal(accepted.detailCalls, 1);
  assert.equal(accepted.modelCalls, 0);
  assert.equal(detailCalls, 1);
  const duplicate = gate.consider(makeCandidate({ id: 'event-1-copy' }), {});
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.reason, 'duplicate');
  assert.equal(detailCalls, 1, '重复候选不得再次回查');

  now = T0 + 61_000;
  assert.equal(gate.status().passed, 1);
  assert.equal(gate.status().modelCalls, 0);
});

test('detail 回查：复用事件索引，modelCalls=0，失败返回机器原因与候选证据', () => {
  const candidate = makeCandidate();
  const event = {
    eventId: 'ue-1',
    frameIds: ['frame-1', 'frame-2'],
    description: '有人推门进来',
    keyDialogue: '我回来了',
    startedAt: T0 - 1_000,
    endedAt: T0,
  };
  const index = {
    get(id) { return id === 'ue-1' ? event : null; },
    search() { throw new Error('should not search when get() hits'); },
  };
  const ok = resolveProactiveDetail({
    candidate,
    eventIndex: index,
    evidenceAvailable: (ids) => ids.every((id) => id === 'frame-1' || id === 'frame-2'),
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.reason, 'detail-ok');
  assert.equal(ok.stage, 'detail');
  assert.equal(ok.detailCalls, 1);
  assert.equal(ok.modelCalls, 0, '回查本地索引不是模型调用');
  assert.deepEqual(ok.evidence.frameIds, ['frame-1', 'frame-2']);
  assert.equal(ok.evidence.keyDialogue, '我回来了');

  const emptyIndex = {
    get: () => null,
    search: () => ({ ok: false, reason: 'no-index', events: [], count: 0 }),
  };
  const missing = resolveProactiveDetail({ candidate, eventIndex: emptyIndex });
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'detail-index-empty');
  assert.equal(missing.detailCalls, 1);
  assert.equal(missing.modelCalls, 0);
  assert.deepEqual(missing.candidateEvidence.frameIds, ['frame-1']);

  const unavailable = resolveProactiveDetail({ candidate, eventIndex: null });
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.reason, 'detail-unavailable');
  assert.deepEqual(unavailable.candidateEvidence.frameIds, ['frame-1']);

  const noMatch = resolveProactiveDetail({
    candidate,
    eventIndex: {
      get: () => null,
      search: () => ({ ok: true, reason: 'ok', events: [], count: 0 }),
    },
  });
  assert.equal(noMatch.ok, false);
  assert.equal(noMatch.reason, 'detail-event-missing');

  // Same time window but a different event with no shared frame: this is not the candidate's
  // detail, even if it is the only result returned by a loose search.
  const unrelated = resolveProactiveDetail({
    candidate,
    eventIndex: {
      get: () => null,
      search: () => ({
        ok: true,
        reason: 'ok',
        events: [{
          eventId: 'ue-other',
          frameIds: ['frame-other'],
          description: '路边汽车起火',
          keyDialogue: '',
          startedAt: T0 - 500,
          endedAt: T0,
        }],
        count: 1,
      }),
    },
    evidenceAvailable: () => true,
  });
  assert.equal(unrelated.ok, false);
  assert.equal(unrelated.reason, 'detail-event-missing');

  // A storyboard cell that really belongs to the candidate may be used.
  const cellMatch = resolveProactiveDetail({
    candidate,
    eventIndex: {
      get: () => null,
      search: () => ({
        ok: true,
        reason: 'ok',
        events: [{
          eventId: 'ue-cell',
          frameIds: ['frame-1'],
          description: '同一张故事板的细节',
          keyDialogue: '',
          startedAt: T0 - 500,
          endedAt: T0,
        }],
        count: 1,
      }),
    },
    evidenceAvailable: () => true,
  });
  assert.equal(cellMatch.ok, true);
  assert.equal(cellMatch.evidence.eventId, 'ue-cell');

  const expiredEvidence = resolveProactiveDetail({
    candidate,
    eventIndex: index,
    evidenceAvailable: () => false,
  });
  assert.equal(expiredEvidence.ok, false);
  assert.equal(expiredEvidence.reason, 'detail-evidence-expired');
  assert.deepEqual(expiredEvidence.candidateEvidence.frameIds, ['frame-1']);

  // 不需要细节：没有理解层事件 id，或描述足够长。此时 detailCalls 保持 0。
  assert.equal(needsProactiveDetail(makeCandidate({ sourceEventId: '' })), false);
  assert.equal(needsProactiveDetail(makeCandidate({
    description: '画面里有人推门进来并停在门口，像是在等屋里的人回应这篇文章',
  })), false);
  const notNeeded = resolveProactiveDetail({
    candidate: makeCandidate({ sourceEventId: '' }),
    eventIndex: { get() { throw new Error('must not query'); } },
  });
  assert.equal(notNeeded.ok, true);
  assert.equal(notNeeded.reason, 'detail-not-needed');
  assert.equal(notNeeded.detailCalls, 0);
});

test('细节不可用：门禁不返回可开口结果，也不调用模型', () => {
  const gate = createProactiveTwoStageGate({
    now: () => T0,
    eventIndex: {
      get: () => null,
      search: () => ({ ok: false, reason: 'no-index', events: [], count: 0 }),
    },
  });
  const result = gate.consider(makeCandidate(), {});
  assert.equal(result.ok, false, '细节不足/不可用不得强行开口');
  assert.equal(result.stage, 'detail');
  assert.equal(result.reason, 'detail-index-empty');
  assert.equal(result.detailCalls, 1);
  assert.equal(result.modelCalls, 0);
  assert.deepEqual(result.candidateEvidence.frameIds, ['frame-1']);

  const status = gate.status();
  assert.equal(status.detailRejected, 1);
  assert.equal(status.passed, 0);
  assert.equal(status.modelCalls, 0);
});
