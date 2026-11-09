/**
 * P-187 阶段 5：主动回应仲裁（纯决策层）。
 *
 * 这些用例逐条盯住契约里的硬规则：
 *   证据约束、三时间（occurredAt/understoodAt/expiresAt）与 maxAgeMs、优先级选择、
 *   四类时机抑制、too-soon、ignored 静默与放大、每小时上限的可选覆盖、同身份去重且不续期、
 *   事件身份历史（候选被 prune 后仍拒绝已过期身份的迟到重登）、
 *   cancelFor、settings 覆盖、候选上限淘汰、spoken/ignored 状态、通过率 0/100/中间值、
 *   按身份只抽一次、时机/过期不抽签、未回应 quiet 仍生效、默认配额不再限制，以及畸形输入不抛错。
 *
 * 所有时间都通过可变的 `now` 注入，不用真实时钟；候选的 from/to 也按该时钟生成，
 * 这样“事件发生 -> 候选过期 -> 恢复可开口”的边界可以一眼核对。
 * 通过率随机源通过 `draw` 注入固定序列，不依赖真实随机数。
 *
 * Run: node --test test/vision-proactive-candidate.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PROACTIVE_DEFAULTS,
  createProactiveArbiter,
} from '../src/host/vision/proactive-candidate.js';

/** 固定起点，避免测试随真实时间漂移。 */
const T0 = 1_700_000_000_000;

/** 可变时钟 + 仲裁器；at/advance 只改测试自己的时间变量。 */
function createHarness(factory = {}) {
  let current = T0;
  const arbiter = createProactiveArbiter({ now: () => current, ...factory });
  return {
    arbiter,
    get now() {
      return current;
    },
    at(value) {
      current = value;
      return current;
    },
    advance(ms) {
      current += ms;
      return current;
    },
  };
}

/**
 * 带注入随机序列的仲裁器：draw 按顺序返回 values，用完后重复最后一个值。
 * drawCalls() 只暴露调用次数，便于断言“时机失败/过期/同身份不重抽”。
 */
function createRateHarness(values = [0.5], factory = {}) {
  let current = T0;
  let calls = 0;
  const arbiter = createProactiveArbiter({
    now: () => current,
    ...factory,
    draw: () => {
      const value = values[Math.min(calls, values.length - 1)];
      calls += 1;
      return value;
    },
  });
  return {
    arbiter,
    drawCalls: () => calls,
    get now() {
      return current;
    },
    at(value) {
      current = value;
      return current;
    },
    advance(ms) {
      current += ms;
      return current;
    },
  };
}

/** 生成一条合法候选；from 比 to 早 1 秒，保证时间区间合法。 */
function makeCandidate(now, over = {}) {
  return {
    id: 'event-1',
    from: now - 1_000,
    to: now,
    description: '角色突然回头',
    evidenceFrameIds: ['frame-1'],
    evidenceAudioIds: [],
    angle: '意外',
    expiresAt: null,
    priority: 0,
    ...over,
  };
}

test('证据约束：画面或音频至少一项，空证据与坏证据都不能登记', () => {
  const h = createHarness();
  const { arbiter } = h;
  const base = makeCandidate(h.now);

  assert.equal(arbiter.propose({ ...base, evidenceFrameIds: [], evidenceAudioIds: [] }), null);
  assert.equal(
    arbiter.propose({ ...base, id: 'no-evidence', evidenceFrameIds: undefined, evidenceAudioIds: undefined }),
    null,
  );
  assert.equal(
    arbiter.propose({ ...base, id: 'bad-evidence', evidenceFrameIds: ['  ', null, {}], evidenceAudioIds: [] }),
    null,
  );

  const audioOnly = arbiter.propose({
    ...base,
    id: 'audio-only',
    evidenceFrameIds: [],
    evidenceAudioIds: ['audio-1', 'audio-1'],
  });
  assert.ok(audioOnly, '只有音频证据也应被接受');
  assert.deepEqual(audioOnly.evidenceAudioIds, ['audio-1'], '证据 id 应去重');
  assert.equal(audioOnly.evidenceFrameIds.length, 0);
  assert.equal(audioOnly.angle, '意外', '反应角度应原样保留');
  assert.equal(audioOnly.eventId, '', '没有显式 eventId 时留空');
  assert.equal(Object.isFrozen(audioOnly), true);

  const status = arbiter.status();
  assert.equal(status.counts.proposed, 1);
  assert.equal(status.counts.rejected, 3);
});

test('有效期：expiresAt 到点即失效；未显式给出时按 occurredAt + maxAgeMs，边界不误杀', () => {
  const h = createHarness();
  const { arbiter } = h;
  const base = makeCandidate(h.now);

  assert.equal(arbiter.propose({ ...base, expiresAt: h.now - 1 }), null, '已过的 expiresAt 应拒绝');
  assert.equal(arbiter.propose({ ...base, id: 'expires-now', expiresAt: h.now }), null, '到点即失效');

  h.at(T0 + 8_001);
  assert.equal(
    arbiter.propose({ ...makeCandidate(h.now), id: 'too-old', from: T0 - 1_000, to: T0 }),
    null,
    'occurredAt 超过 maxAgeMs 应拒绝',
  );
  const edge = arbiter.propose({
    ...makeCandidate(h.now),
    id: 'edge',
    occurredAt: T0 + 2,
    from: T0 + 1,
    to: T0 + 2,
  });
  assert.ok(edge, 'expiresAt 前 1ms 仍应有效');
  assert.equal(edge.occurredAt, T0 + 2);
  assert.equal(edge.expiresAt, T0 + 2 + PROACTIVE_DEFAULTS.maxAgeMs);
  assert.equal(edge.understoodAt, null, '未提供 understoodAt 时留空，不参与有效期');

  const status = arbiter.status();
  assert.equal(status.counts.expired, 3);
  assert.equal(status.counts.proposed, 1);
});

test('三时间：understoodAt 只做诊断，分析完成得再晚也不重置新鲜度', () => {
  const h = createHarness({ defaults: { maxAgeMs: 60_000 } });
  const { arbiter } = h;
  const occurredAt = h.now - 40_000;

  const candidate = arbiter.propose(makeCandidate(h.now, {
    id: 'analysis-late',
    eventId: 'evt-late',
    from: occurredAt - 1_000,
    to: occurredAt,
    occurredAt,
    understoodAt: h.now,
  }));
  assert.ok(candidate, '40 秒前发生的重要事件在 60 秒窗口内仍可登记');
  assert.equal(candidate.occurredAt, occurredAt);
  assert.equal(candidate.understoodAt, h.now);
  assert.equal(candidate.expiresAt, occurredAt + 60_000, '有效期锚定 occurredAt，而非 understoodAt');

  // 距发生 59.9 秒仍可评估；到 60 秒（expiresAt）即失效。
  h.advance(19_999);
  assert.equal(arbiter.pendingIds().length, 1);
  assert.equal(arbiter.evaluate().speak, true);
  h.advance(1);
  assert.deepEqual(arbiter.pendingIds(), []);
  assert.equal(arbiter.evaluate().reason, 'no-candidate');
});

test('重复分析不续期：同身份保留最早 occurredAt/expiresAt，并计 duplicate', () => {
  const h = createHarness();
  const { arbiter } = h;
  const first = arbiter.propose(makeCandidate(h.now, {
    id: 'understand:first',
    eventId: 'evt-stable',
    from: T0 - 1_000,
    to: T0,
    occurredAt: T0,
    understoodAt: T0,
  }));
  assert.ok(first);
  assert.equal(first.expiresAt, T0 + PROACTIVE_DEFAULTS.maxAgeMs);

  // 2 秒后同一事件被再次分析：to/描述都变了，但身份相同，时间不得被推后。
  h.advance(2_000);
  const second = arbiter.propose(makeCandidate(h.now, {
    id: 'understand:second',
    eventId: 'evt-stable',
    from: T0 + 1_000,
    to: T0 + 2_000,
    occurredAt: T0 + 2_000,
    understoodAt: h.now,
    description: '新版本的描述',
  }));
  assert.ok(second, '同身份后到版本可以合并');
  assert.equal(second.id, 'understand:first', '保留最早候选 id，避免在途生成错位');
  assert.equal(second.occurredAt, T0, '保留更早的 occurredAt');
  assert.equal(second.expiresAt, first.expiresAt, 'expiresAt 不得被重复分析延长');
  assert.equal(second.to, T0, '内容时间保留最早版本');
  assert.equal(second.description, '新版本的描述', '描述可以更新，但不重置新鲜度');
  const status = arbiter.status();
  assert.equal(status.pending, 1);
  assert.equal(status.counts.proposed, 1, '同身份合并不算新登记');
  assert.equal(status.counts.duplicate, 1, '重复分析计 duplicate');

  // 到最早的 expiresAt 就失效，而不是 second 推导出来的 T0 + 2s + maxAge。
  h.at(first.expiresAt);
  assert.deepEqual(arbiter.pendingIds(), []);
});

// ---- 事件身份历史（prune 不得抹掉“已过期”的事实）--------------------------

test('身份历史：首次 expiresAt 前同身份合并，仍保留最早 occurredAt/expiresAt', () => {
  const h = createHarness();
  const { arbiter } = h;
  const first = arbiter.propose(makeCandidate(h.now, {
    id: 'hist-before:1',
    eventId: 'evt-hist-before',
    occurredAt: T0,
    from: T0 - 1_000,
    to: T0,
    expiresAt: T0 + 9_000,
  }));
  assert.ok(first);
  assert.equal(arbiter.status().identities, 1, '首次登记写入身份历史');

  // 5 秒后（仍在首次 expiresAt 之前）同一事件带着更新后的内容时间再来：可以合并，但不续期。
  h.at(T0 + 5_000);
  const second = arbiter.propose(makeCandidate(h.now, {
    id: 'hist-before:2',
    eventId: 'evt-hist-before',
    occurredAt: T0 + 5_000,
    from: T0 + 4_000,
    to: T0 + 5_000,
    expiresAt: T0 + 14_000,
    description: '更新后的描述',
  }));
  assert.ok(second, '首次有效期之前可以合并');
  assert.equal(second.expiresAt, first.expiresAt, 'expiresAt 保持最早，不得续期');
  assert.equal(second.occurredAt, T0, 'occurredAt 保持最早');
  assert.equal(second.to, T0, '内容时间保留最早版本');
  assert.equal(second.description, '更新后的描述', '描述仍可更新');
  assert.equal(arbiter.status().pending, 1);
  assert.equal(arbiter.status().identities, 1, '合并不会新增身份');

  h.at(first.expiresAt);
  assert.deepEqual(arbiter.pendingIds(), [], '到最早 expiresAt 即失效');
  assert.equal(arbiter.evaluate().reason, 'no-candidate');
});

test('身份历史：首次 expiresAt 后迟到重登被拒绝，不能复活/续期/开口', () => {
  const h = createHarness();
  const { arbiter } = h;
  const first = arbiter.propose(makeCandidate(h.now, {
    id: 'late:1',
    eventId: 'evt-late',
    occurredAt: T0,
    from: T0 - 1_000,
    to: T0,
    expiresAt: T0 + 9_000,
  }));
  assert.ok(first);

  // 反例：候选已过 9 秒截止并被 prune 清掉；10 秒时同一事件带着“更新后的内容时间”
  // 送来，按输入会推导出 18 秒的新截止。若不查身份历史，它会被重新登记并能开口。
  h.at(T0 + 10_000);
  assert.deepEqual(arbiter.pendingIds(), []);
  const late = arbiter.propose(makeCandidate(h.now, {
    id: 'late:2',
    eventId: 'evt-late',
    occurredAt: T0 + 10_000,
    from: T0 + 9_000,
    to: T0 + 10_000,
    expiresAt: T0 + 18_000,
    description: '迟到的重复分析',
  }));
  assert.equal(late, null, '已过期身份不得重新登记');
  const status = arbiter.status();
  assert.equal(status.pending, 0);
  assert.equal(status.valid, 0);
  assert.equal(status.identities, 1, '身份历史不随候选 prune 丢失');
  assert.equal(status.lastRejectReason, 'expired-identity');
  assert.equal(status.counts.proposed, 1, '迟到重登不得计入新登记');
  assert.equal(status.counts.rejected, 1);
  assert.equal(status.counts.expired, 1);
  assert.equal(status.counts.duplicate, 1);

  const out = arbiter.evaluate();
  assert.equal(out.speak, false);
  assert.equal(out.candidate, null);
  assert.equal(out.reason, 'no-candidate');
  assert.deepEqual(out.suppressed, ['no-candidate']);
  assert.equal(arbiter.status().drawn, 0, '拒绝的迟到事件不消耗通过率抽签');

  // 再迟到一次也一样：历史只记首次，后续输入再新也不能洗白。
  h.at(T0 + 12_000);
  assert.equal(arbiter.propose(makeCandidate(h.now, {
    id: 'late:3',
    eventId: 'evt-late',
    occurredAt: T0 + 12_000,
    from: T0 + 11_000,
    to: T0 + 12_000,
    expiresAt: T0 + 20_000,
  })), null);
  assert.equal(arbiter.status().counts.expired, 2);
  assert.equal(arbiter.status().pending, 0);
});

test('身份历史：不同 id/eventId 的新事件不受已过期身份影响', () => {
  const h = createHarness();
  const { arbiter } = h;
  assert.ok(arbiter.propose(makeCandidate(h.now, {
    id: 'stale',
    eventId: 'evt-stale',
    occurredAt: T0,
    from: T0 - 1_000,
    to: T0,
    expiresAt: T0 + 9_000,
  })));

  h.at(T0 + 10_000);
  assert.equal(arbiter.propose(makeCandidate(h.now, {
    id: 'stale-late',
    eventId: 'evt-stale',
    occurredAt: T0 + 10_000,
    from: T0 + 9_000,
    to: T0 + 10_000,
    expiresAt: T0 + 18_000,
  })), null, '旧身份仍被拒绝');

  const fresh = arbiter.propose(makeCandidate(h.now, {
    id: 'fresh',
    eventId: 'evt-fresh',
    occurredAt: T0 + 10_000,
    from: T0 + 9_000,
    to: T0 + 10_000,
    expiresAt: T0 + 18_000,
  }));
  assert.ok(fresh, '不同事件身份应正常登记');
  assert.equal(arbiter.status().pending, 1);
  assert.equal(arbiter.status().identities, 2);
  const out = arbiter.evaluate();
  assert.equal(out.speak, true);
  assert.equal(out.candidate.id, 'fresh');
});

test('身份历史有界且 reset 代次清空；cancelFor 不写历史', () => {
  const h = createHarness();
  const { arbiter } = h;
  // 第一条先过期，随后 300 个新身份把最早的历史挤出有界表。
  assert.ok(arbiter.propose(makeCandidate(h.now, {
    id: 'bounded-first',
    eventId: 'evt-bounded-first',
    occurredAt: T0,
    from: T0 - 1_000,
    to: T0,
    expiresAt: T0 + 1_000,
  })));
  for (let i = 0; i < 300; i += 1) {
    assert.ok(arbiter.propose(makeCandidate(h.now, {
      id: `bounded-${i}`,
      eventId: `evt-bounded-${i}`,
      occurredAt: T0,
      from: T0 - 1_000,
      to: T0,
      expiresAt: T0 + 20_000,
    })), `bounded-${i} 应能登记`);
  }
  assert.equal(arbiter.status().identities, 256, '身份历史必须保持有界');

  h.at(T0 + 2_000);
  // 最早的身份已被挤出：这是有界表的明确取舍，按新事件登记而不是永久拒绝。
  const replayed = arbiter.propose(makeCandidate(h.now, {
    id: 'bounded-first',
    eventId: 'evt-bounded-first',
    occurredAt: T0 + 2_000,
    from: T0 + 1_000,
    to: T0 + 2_000,
    expiresAt: T0 + 11_000,
  }));
  assert.ok(replayed, '被挤出历史的身份按新事件登记');
  assert.equal(arbiter.status().identities, 256, '重新登记后仍保持有界');

  // reset 是代次边界：清空后同一过期身份可在新代次重新登记。
  const g = createHarness();
  assert.ok(g.arbiter.propose(makeCandidate(g.now, {
    id: 'gen:1',
    eventId: 'evt-gen',
    occurredAt: T0,
    from: T0 - 1_000,
    to: T0,
    expiresAt: T0 + 1_000,
  })));
  g.at(T0 + 2_000);
  assert.equal(g.arbiter.propose(makeCandidate(g.now, {
    id: 'gen:2',
    eventId: 'evt-gen',
    occurredAt: T0 + 2_000,
    from: T0 + 1_000,
    to: T0 + 2_000,
    expiresAt: T0 + 12_000,
  })), null, '同一代次内已过期身份仍被拒绝');
  assert.equal(g.arbiter.status().identities, 1);
  assert.equal(g.arbiter.reset('vision-invalidated'), 0);
  assert.equal(g.arbiter.status().identities, 0, 'reset 清空身份历史');
  assert.ok(g.arbiter.propose(makeCandidate(g.now, {
    id: 'gen:3',
    eventId: 'evt-gen',
    occurredAt: T0 + 2_000,
    from: T0 + 1_000,
    to: T0 + 2_000,
    expiresAt: T0 + 12_000,
  })), '新代次不再受旧身份历史限制');

  // cancelFor 只写取消集，不写身份历史。
  const c = createHarness();
  c.arbiter.cancelFor(['never-proposed', null]);
  assert.equal(c.arbiter.status().identities, 0);
});

test('说过的重要事件在 expiresAt 前不会被重复分析再次登记', () => {
  const h = createHarness({ defaults: { maxAgeMs: 60_000 } });
  const { arbiter } = h;
  const first = arbiter.propose(makeCandidate(h.now, {
    id: 'understand:spoken',
    eventId: 'evt-spoken',
    to: T0,
    occurredAt: T0,
    understoodAt: T0,
  }));
  assert.ok(first);
  assert.equal(arbiter.evaluate().speak, true);
  arbiter.spoken(first);

  // 20 秒后同一事件再次进入理解结果：仍在候选有效期内，说过的记忆必须压住它。
  h.advance(20_000);
  assert.equal(arbiter.propose(makeCandidate(h.now, {
    id: 'understand:spoken-again',
    eventId: 'evt-spoken',
    to: T0 + 20_000,
    occurredAt: T0,
    understoodAt: h.now,
  })), null);
  assert.equal(arbiter.status().counts.duplicate, 1);
  assert.equal(arbiter.evaluate().reason, 'no-candidate');
});

test('显式 expiresAt 优先：旧 to 仍可登记/待选/评估，到 expiresAt 才失效', () => {
  const h = createHarness();
  const { arbiter } = h;

  // 真实故障：理解耗时约 30 秒，事件 to 是 30 秒前；登记时用“现在 + 8 秒”作为显式有效期。
  const candidate = arbiter.propose(makeCandidate(h.now, {
    id: 'understand:old-to',
    from: h.now - 31_000,
    to: h.now - 30_000,
    expiresAt: h.now + 8_000,
  }));
  assert.ok(candidate, '显式 expiresAt 未到，旧 to 不应再被 maxAgeMs 二次拒绝');
  assert.equal(candidate.to, h.now - 30_000, 'from/to 保留原始内容时间');
  assert.equal(candidate.expiresAt, h.now + 8_000, '显式 expiresAt 原样保留');
  assert.deepEqual(arbiter.pendingIds(), ['understand:old-to']);
  const status = arbiter.status();
  assert.equal(status.valid, 1);
  assert.equal(status.counts.expired, 0);
  assert.equal(status.counts.proposed, 1);

  // 即使 to 已经 37 秒前，只要还没到 expiresAt，evaluate 仍能选到（isUsable 同语义）。
  h.advance(7_000);
  const picked = arbiter.evaluate();
  assert.equal(picked.speak, true);
  assert.equal(picked.candidate.id, 'understand:old-to');

  // 到点即失效：评估侧也必须用新语义，否则会出现 propose 成功、evaluate 选不到的半修复。
  h.advance(1_000);
  assert.deepEqual(arbiter.pendingIds(), []);
  const expired = arbiter.evaluate();
  assert.equal(expired.speak, false);
  assert.equal(expired.reason, 'no-candidate');
  assert.equal(arbiter.status().valid, 0);
});

test('无显式 expiresAt 时保持原 to 年龄规则；显式 expiresAt 已过仍直接 expired', () => {
  const h = createHarness();
  const { arbiter } = h;

  // 没有显式 expiresAt：旧的 to 仍按 maxAgeMs 拒绝（既有语义不变）。
  assert.equal(arbiter.propose(makeCandidate(h.now, {
    id: 'no-expiry-old-to',
    from: h.now - 31_000,
    to: h.now - 30_000,
    expiresAt: null,
  })), null);
  // 显式 expiresAt 已过：即使 to 很新也失效。
  assert.equal(arbiter.propose(makeCandidate(h.now, {
    id: 'expired-explicit',
    expiresAt: h.now - 1,
  })), null);

  const status = arbiter.status();
  assert.equal(status.counts.expired, 2);
  assert.equal(status.counts.proposed, 0);
  assert.equal(status.counts.rejected, 2);
});

test('描述必须是可读文本：空白、非字符串都拒绝且不抛错', () => {
  const h = createHarness();
  const values = ['', '   ', null, 42, {}, undefined];
  values.forEach((description, index) => {
    assert.equal(
      h.arbiter.propose({ ...makeCandidate(h.now), id: `bad-description-${index}`, description }),
      null,
      `description=${String(description)} 应被拒绝`,
    );
  });
  assert.equal(h.arbiter.status().counts.rejected, values.length);
});

test('选择：priority 高者优先，同优先级取更晚 to，evaluate 不消费候选', () => {
  const h = createHarness();
  const { arbiter } = h;

  arbiter.propose(makeCandidate(h.now, {
    id: 'early-low',
    priority: 2,
    to: h.now - 300,
    description: '低优先级',
  }));
  arbiter.propose(makeCandidate(h.now, {
    id: 'high-old',
    priority: 5,
    to: h.now - 800,
    description: '高优先级旧',
  }));
  arbiter.propose(makeCandidate(h.now, {
    id: 'high-new',
    priority: 5,
    to: h.now - 400,
    description: '高优先级新',
  }));

  const first = arbiter.evaluate();
  assert.equal(first.speak, true);
  assert.equal(first.reason, 'rate-hit', '默认 100% 时通过率直接命中');
  assert.deepEqual(first.suppressed, []);
  assert.equal(first.candidate.id, 'high-new', '同优先级应选 to 更晚者');

  const second = arbiter.evaluate();
  assert.equal(second.candidate.id, 'high-new');
  assert.equal(arbiter.status().pending, 3, 'evaluate 不应消费候选');

  assert.equal(arbiter.cancelFor('high-new'), 1);
  assert.equal(arbiter.evaluate().candidate.id, 'high-old', '最高者取消后由同优先级次新者接手');
});

test('时机抑制按优先级：user-speaking > assistant-busy > pending-reply > key-dialogue', () => {
  const h = createHarness();
  const { arbiter } = h;
  arbiter.propose(makeCandidate(h.now));

  const cases = [
    [{ userSpeaking: true }, 'user-speaking'],
    [{ assistantBusy: true }, 'assistant-busy'],
    [{ pendingReply: true }, 'pending-reply'],
    [{ keyDialogue: true }, 'key-dialogue'],
  ];
  for (const [input, expected] of cases) {
    const out = arbiter.evaluate(input);
    assert.equal(out.speak, false);
    assert.equal(out.reason, expected);
    assert.deepEqual(out.suppressed, [expected]);
    assert.equal(out.candidate, null, '被抑制时不暴露待说候选');
  }

  const all = arbiter.evaluate({
    userSpeaking: true,
    assistantBusy: true,
    pendingReply: true,
    keyDialogue: true,
  });
  assert.equal(all.reason, 'user-speaking');
  assert.deepEqual(all.suppressed, [
    'user-speaking',
    'assistant-busy',
    'pending-reply',
    'key-dialogue',
  ]);
});

test('too-soon 是可选取覆盖：显式 minGapMs 生效，默认 0 不再限制', () => {
  const h = createHarness();
  const { arbiter } = h;

  const first = arbiter.propose(makeCandidate(h.now));
  assert.equal(arbiter.evaluate().speak, true);
  arbiter.spoken(first);

  h.advance(44_999);
  arbiter.propose(makeCandidate(h.now, { id: 'next' }));
  const blocked = arbiter.evaluate({ settings: { minGapMs: 45_000 } });
  assert.equal(blocked.speak, false);
  assert.equal(blocked.reason, 'too-soon');
  assert.deepEqual(blocked.suppressed, ['too-soon']);
  assert.equal(blocked.candidate, null);

  h.at(T0 + 45_000);
  const allowed = arbiter.evaluate({ settings: { minGapMs: 45_000 } });
  assert.equal(allowed.speak, true);
  assert.equal(allowed.candidate.id, 'next');
});

test('hourly-limit 是可选取覆盖：滚动一小时内达到上限后不再开口，过窗恢复', () => {
  const h = createHarness();
  const { arbiter } = h;
  const settings = { maxPerHour: 2, minGapMs: 0 };

  const speak = (id) => {
    const candidate = arbiter.propose(makeCandidate(h.now, { id }));
    const out = arbiter.evaluate({ settings });
    assert.equal(out.speak, true, `${id} 应该允许开口`);
    assert.equal(arbiter.spoken(candidate), true);
  };

  speak('e1');
  h.advance(1_000);
  speak('e2');
  h.advance(1_000);

  arbiter.propose(makeCandidate(h.now, { id: 'e3' }));
  const blocked = arbiter.evaluate({ settings });
  assert.equal(blocked.speak, false);
  assert.equal(blocked.reason, 'hourly-limit');
  assert.deepEqual(blocked.suppressed, ['hourly-limit']);
  assert.equal(blocked.candidate, null);

  // 第一小时窗口过去：e1 掉出窗口，e2 仍在，上限 2 还没到。
  h.at(T0 + 3_600_001);
  arbiter.propose(makeCandidate(h.now, { id: 'e4' }));
  const allowed = arbiter.evaluate({ settings });
  assert.equal(allowed.speak, true);
  assert.equal(allowed.candidate.id, 'e4');
});

test('默认不再限制固定配额：连续两条候选可以立即开口，无需 45 秒/每小时 6 句', () => {
  assert.equal(PROACTIVE_DEFAULTS.minGapMs, 0, '默认最小间隔为 0');
  assert.equal(PROACTIVE_DEFAULTS.maxPerHour, null, '默认每小时不限制');

  const h = createHarness();
  const { arbiter } = h;

  const first = arbiter.propose(makeCandidate(h.now, { id: 'first' }));
  const firstOut = arbiter.evaluate();
  assert.equal(firstOut.speak, true);
  assert.equal(firstOut.reason, 'rate-hit');
  arbiter.spoken(first);

  h.advance(1_000);
  arbiter.propose(makeCandidate(h.now, { id: 'second' }));
  const secondOut = arbiter.evaluate();
  assert.equal(secondOut.speak, true, '默认不应出现 too-soon/hourly-limit');
  assert.deepEqual(secondOut.suppressed, []);
  assert.equal(secondOut.candidate.id, 'second');
  assert.equal(arbiter.status().spokenLastHour, 1);
});

test('ignored 静默：连续未回应进入 quiet 期，静默结束后按放大后的间隔恢复', () => {
  const h = createHarness();
  const { arbiter } = h;

  const first = arbiter.propose(makeCandidate(h.now));
  assert.equal(arbiter.evaluate().speak, true);
  arbiter.spoken(first);

  h.at(T0 + 10_000);
  arbiter.ignored();
  const afterIgnore = arbiter.status();
  assert.equal(afterIgnore.counts.ignored, 1);
  assert.equal(afterIgnore.consecutiveIgnored, 1);
  assert.equal(afterIgnore.quietUntil, T0 + 130_000);
  assert.equal(afterIgnore.lastReason, 'ignored');

  h.at(T0 + 129_999);
  arbiter.propose(makeCandidate(h.now, { id: 'after-quiet' }));
  const quiet = arbiter.evaluate();
  assert.equal(quiet.speak, false);
  assert.equal(quiet.reason, 'too-soon', 'quiet 期内应继续视为 too-soon');
  assert.deepEqual(quiet.suppressed, ['too-soon']);

  // 距上次开口 130 秒，已超过 quiet 与放大后的 90 秒间隔。
  h.at(T0 + 130_000);
  const resumed = arbiter.evaluate();
  assert.equal(resumed.speak, true);
  assert.equal(resumed.candidate.id, 'after-quiet');
  arbiter.spoken(resumed.candidate);

  const afterSpoken = arbiter.status();
  assert.equal(afterSpoken.consecutiveIgnored, 0);
  assert.equal(afterSpoken.quietUntil, null);
});

test('连续 ignored 按倍数放大最小间隔，静默期较短时由倍数接管', () => {
  const h = createHarness({
    defaults: {
      ...PROACTIVE_DEFAULTS,
      minGapMs: 10_000,
      quietAfterIgnoredMs: 5_000,
    },
  });
  const { arbiter } = h;

  const first = arbiter.propose(makeCandidate(h.now));
  assert.equal(arbiter.evaluate().speak, true);
  arbiter.spoken(first);

  h.at(T0 + 6_000);
  arbiter.ignored();
  assert.equal(arbiter.status().quietUntil, T0 + 11_000);

  // quiet 已结束，但连续 1 次 ignored 让最小间隔变成 2x = 20s。
  h.at(T0 + 11_000);
  arbiter.propose(makeCandidate(h.now, { id: 'scaled-1' }));
  const scaled = arbiter.evaluate();
  assert.equal(scaled.speak, false);
  assert.equal(scaled.reason, 'too-soon');

  h.at(T0 + 20_000);
  arbiter.propose(makeCandidate(h.now, { id: 'scaled-2' }));
  const allowed = arbiter.evaluate();
  assert.equal(allowed.speak, true);
  assert.equal(allowed.candidate.id, 'scaled-2');
});

test('同身份去重、cancelFor 取消、说过的事件在窗口内不能重复登记', () => {
  const h = createHarness();
  const { arbiter } = h;

  assert.ok(arbiter.propose(makeCandidate(h.now, { id: 'same', description: '旧版本' })));
  assert.ok(arbiter.propose(makeCandidate(h.now, { id: 'same', description: '新版本' })));
  assert.equal(arbiter.status().pending, 1, '同身份只保留一条');
  assert.equal(arbiter.status().counts.evicted, 0, '同身份替换不算淘汰');

  const picked = arbiter.evaluate();
  assert.equal(picked.candidate.description, '新版本', '后到版本应替换旧版本');
  arbiter.spoken(picked.candidate);

  assert.equal(
    arbiter.propose(makeCandidate(h.now, { id: 'same', description: '重复' })),
    null,
    '刚说过的事件在 maxAgeMs 窗口内不能重复登记',
  );
  assert.equal(
    arbiter.status().counts.duplicate,
    2,
    '第二次同身份登记已计一次 duplicate，说过后的重复登记再计一次',
  );

  arbiter.propose(makeCandidate(h.now, { id: 'e2' }));
  assert.equal(arbiter.cancelFor('e2'), 1);
  assert.equal(arbiter.status().pending, 0);
  assert.equal(
    arbiter.evaluate({ settings: { minGapMs: 0 } }).reason,
    'no-candidate',
    '取消并说过后没有待说候选',
  );
  assert.equal(
    arbiter.propose(makeCandidate(h.now, { id: 'e2' })),
    null,
    '已取消事件不能复活',
  );
  assert.equal(arbiter.cancelFor([null, undefined, {}]), 0, '坏 id 应跳过');
});

test('settings 覆盖：enabled=false 永不开口，频率/间隔可覆盖，畸形设置忽略', () => {
  const h = createHarness();
  const { arbiter } = h;
  arbiter.propose(makeCandidate(h.now));

  const disabled = arbiter.evaluate({ settings: { enabled: false } });
  assert.equal(disabled.speak, false);
  assert.equal(disabled.reason, 'disabled');
  assert.equal(disabled.candidate, null);
  assert.deepEqual(disabled.suppressed, ['disabled']);

  const zeroLimit = arbiter.evaluate({ settings: { maxPerHour: 0 } });
  assert.equal(zeroLimit.reason, 'hourly-limit', 'maxPerHour 覆盖为 0 应直接限流');

  assert.equal(arbiter.evaluate({ settings: 'not-an-object' }).speak, true, '字符串 settings 应忽略');
  assert.equal(arbiter.evaluate({ settings: [] }).speak, true, '数组 settings 应忽略');
  assert.equal(
    arbiter.evaluate({ settings: { enabled: 'false', maxPerHour: -1, minGapMs: 'x' } }).speak,
    true,
    '畸形字段应逐个忽略，而不是当成 false / 0',
  );

  const ok = arbiter.evaluate();
  assert.equal(ok.speak, true);
  arbiter.spoken(ok.candidate);

  h.advance(1_500);
  arbiter.propose(makeCandidate(h.now, { id: 'after-short-gap' }));
  const blocked = arbiter.evaluate({ settings: { minGapMs: 5_000 } });
  assert.equal(blocked.reason, 'too-soon');
  // 覆盖成 1s 后，距上次开口 1.5s 就可以开口。
  const out = arbiter.evaluate({ settings: { minGapMs: 1_000 } });
  assert.equal(out.speak, true);
  assert.equal(out.candidate.id, 'after-short-gap');
});

test('候选上限：只保留最新 maxCandidates 条，旧的淘汰并计数', () => {
  const h = createHarness();
  const { arbiter } = h;

  for (let i = 1; i <= 5; i += 1) {
    arbiter.propose(makeCandidate(h.now, { id: `e${i}`, to: h.now - (5 - i) }));
  }
  const status = arbiter.status();
  assert.equal(status.pending, PROACTIVE_DEFAULTS.maxCandidates);
  assert.equal(status.counts.evicted, 1);

  assert.equal(arbiter.evaluate().candidate.id, 'e5', '淘汰最旧后，同优先级取 to 最新的一条');
  assert.equal(arbiter.cancelFor('e5'), 1);
  assert.equal(arbiter.evaluate().candidate.id, 'e4');
});

test('evaluate 过期过滤：候选自然过期后返回 no-candidate，但不消费/不淘汰', () => {
  const h = createHarness();
  const { arbiter } = h;
  assert.ok(arbiter.propose(makeCandidate(h.now)));

  h.at(T0 + 8_001);
  const out = arbiter.evaluate();
  assert.equal(out.speak, false);
  assert.equal(out.reason, 'no-candidate');
  assert.equal(out.candidate, null);
  assert.deepEqual(out.suppressed, ['no-candidate']);

  const status = arbiter.status();
  assert.equal(status.pending, 1, 'evaluate 不应移除过期候选');
  assert.equal(status.valid, 0);
  assert.equal(status.counts.evicted, 0);
});

test('spoken/ignored 状态：记录最近时间、截断主题与计数，status 不含正文', () => {
  const h = createHarness();
  const { arbiter } = h;
  const longDescription = '角色在雨里回头看向镜头，'.repeat(10);
  const candidate = arbiter.propose(makeCandidate(h.now, {
    id: 'topic-1',
    description: longDescription,
  }));

  assert.equal(arbiter.evaluate().speak, true);
  assert.equal(arbiter.spoken(candidate, { now: T0 }), true);
  const afterSpoken = arbiter.status();
  assert.equal(afterSpoken.lastSpokenAt, T0);
  assert.equal(afterSpoken.lastTopicId, 'topic-1');
  assert.equal(afterSpoken.counts.spoken, 1);
  assert.ok(Array.from(afterSpoken.lastTopic).length <= 48, '主题摘要长度应受限');
  assert.ok(afterSpoken.lastTopic.endsWith('…'), '超长主题应截断');
  assert.equal(
    JSON.stringify(afterSpoken).includes(longDescription),
    false,
    'status 不应带完整候选正文',
  );

  h.at(T0 + 1_000);
  arbiter.ignored();
  const afterIgnored = arbiter.status();
  assert.equal(afterIgnored.counts.ignored, 1);
  assert.equal(afterIgnored.consecutiveIgnored, 1);
  assert.equal(afterIgnored.quietUntil, T0 + 121_000);
  assert.equal(afterIgnored.lastReason, 'ignored');
});

test('cancelAll：清空待选池并记录原因，但不写取消集，事件可以重新登记', () => {
  const h = createHarness();
  const { arbiter } = h;
  assert.ok(arbiter.propose(makeCandidate(h.now, { id: 'a' })));
  assert.ok(arbiter.propose(makeCandidate(h.now, { id: 'b' })));
  assert.deepEqual(arbiter.pendingIds().sort(), ['a', 'b']);

  assert.equal(arbiter.cancelAll('user-comment'), 2);
  const status = arbiter.status();
  assert.equal(status.pending, 0);
  assert.equal(status.lastReason, 'user-comment');
  assert.equal(status.counts.canceled, 2);
  assert.equal(status.canceledEvents, 0, 'cancelAll 不得扩张取消集');

  // 取消集没变：同 id 可以重新登记，而不是像 cancelFor 那样被永久拒绝。
  assert.ok(arbiter.propose(makeCandidate(h.now, { id: 'a' })));
  assert.equal(arbiter.status().pending, 1);
  // 空/畸形原因回退到默认机器码，仍只清待选池。
  assert.equal(arbiter.cancelAll(), 1);
  assert.equal(arbiter.status().lastReason, 'cancel-all');
  assert.equal(arbiter.cancelAll({ reason: 'x' }), 0, '非字符串原因不应抛错');
});

test('pendingIds：只返回当前有效候选的只读副本', () => {
  const h = createHarness();
  const { arbiter } = h;
  arbiter.propose(makeCandidate(h.now, { id: 'ok' }));
  arbiter.propose(makeCandidate(h.now, { id: 'expired', expiresAt: h.now + 1_000 }));
  arbiter.propose(makeCandidate(h.now, { id: 'cancel' }));
  arbiter.cancelFor('cancel');

  h.advance(1_000);
  const ids = arbiter.pendingIds();
  assert.deepEqual(ids, ['ok'], '过期的候选不出现在结果里');
  assert.equal(arbiter.status().pending, 2, 'pendingIds 不消费/不清理候选');
  assert.equal(arbiter.status().valid, 1);

  // 副本：调用方怎么改都不影响仲裁器内部状态。
  ids.push('mutated');
  ids.reverse();
  assert.deepEqual(arbiter.pendingIds(), ['ok']);
});

test('reset：清空候选/取消集/抽签记录/重复窗口/时机窗口，保留累计计数', () => {
  const h = createHarness();
  const { arbiter } = h;
  const first = arbiter.propose(makeCandidate(h.now, { id: 'e1' }));
  assert.equal(arbiter.evaluate().speak, true);
  arbiter.spoken(first);
  arbiter.ignored();
  arbiter.propose(makeCandidate(h.now, { id: 'e2' }));
  arbiter.cancelFor('e2');
  arbiter.propose(makeCandidate(h.now, { id: 'e3' }));
  const before = arbiter.status();
  assert.equal(before.counts.spoken, 1);
  assert.equal(before.counts.ignored, 1);
  assert.equal(before.counts.canceled, 1);
  assert.equal(before.drawn, 1);
  assert.equal(before.passed, 1);

  h.advance(1_000);
  assert.equal(arbiter.reset('vision-invalidated'), 1, 'reset 返回清掉的候选数');
  const after = arbiter.status();
  assert.equal(after.pending, 0);
  assert.equal(after.canceledEvents, 0, '取消集应在代次边界清空');
  assert.equal(after.lastSpokenAt, null);
  assert.equal(after.consecutiveIgnored, 0);
  assert.equal(after.quietUntil, null);
  assert.equal(after.spokenLastHour, 0, '每小时窗口应清空');
  assert.equal(after.lastTopicId, null);
  assert.equal(after.lastTopic, null);
  assert.equal(after.lastReason, 'vision-invalidated');
  // 累计计数保留：它们描述仲裁器整个生命周期，清窗口不应让诊断数字归零。
  assert.equal(after.counts.proposed, before.counts.proposed);
  assert.equal(after.counts.spoken, before.counts.spoken);
  assert.equal(after.counts.ignored, before.counts.ignored);
  assert.equal(after.counts.canceled, before.counts.canceled);
  assert.equal(after.drawn, before.drawn, '抽签计数是累计值，reset 不归零');

  // 取消集与 spokenAt 都已清空：同一事件 id 可以重新登记并重新开口。
  assert.ok(arbiter.propose(makeCandidate(h.now, { id: 'e1' })));
  const resumed = arbiter.evaluate({ settings: { minGapMs: 0 } });
  assert.equal(resumed.speak, true);
  assert.equal(resumed.candidate.id, 'e1');
});

// ---- 通过率（rate）---------------------------------------------------------

test('通过率 0%：不开口、不调用随机源，重复 evaluate 仍不重抽', () => {
  const h = createRateHarness([0.1]);
  const { arbiter } = h;
  arbiter.propose(makeCandidate(h.now));

  const out = arbiter.evaluate({ settings: { rate: 0 } });
  assert.equal(out.speak, false);
  assert.equal(out.reason, 'rate-zero');
  assert.deepEqual(out.suppressed, ['rate-zero']);
  assert.equal(out.candidate, null);
  assert.equal(h.drawCalls(), 0, '0% 不需要随机数');

  const again = arbiter.evaluate({ settings: { rate: 0 } });
  assert.equal(again.reason, 'rate-zero');
  assert.equal(h.drawCalls(), 0, '重复 evaluate 不调用随机源');
  const status = arbiter.status();
  assert.equal(status.rate, 0);
  assert.equal(status.drawn, 1, '同一身份只记录一次');
  assert.equal(status.passed, 0);
  assert.equal(status.pending, 1, '未开口的候选仍在待选池里等待过期');
});

test('通过率 100%：必过且不消耗随机源', () => {
  const h = createRateHarness([0.99]);
  const { arbiter } = h;
  arbiter.propose(makeCandidate(h.now));

  const out = arbiter.evaluate({ settings: { rate: 100 } });
  assert.equal(out.speak, true);
  assert.equal(out.reason, 'rate-hit');
  assert.deepEqual(out.suppressed, []);
  assert.equal(out.candidate.id, 'event-1');
  assert.equal(h.drawCalls(), 0, '100% 不需要随机数');
  const status = arbiter.status();
  assert.equal(status.rate, 100);
  assert.equal(status.drawn, 1);
  assert.equal(status.passed, 1);
});

test('通过率 50%：中间值只抽一次；命中开口，未命中保持待选且不重抽', () => {
  const hit = createRateHarness([0.2]);
  hit.arbiter.propose(makeCandidate(hit.now, { id: 'hit' }));
  const hitOut = hit.arbiter.evaluate({ settings: { rate: 50 } });
  assert.equal(hitOut.speak, true);
  assert.equal(hitOut.reason, 'rate-hit');
  assert.equal(hitOut.candidate.id, 'hit');
  assert.equal(hit.drawCalls(), 1);
  // 同一身份再次 evaluate：沿用已记录的“通过”，不会重新抽。
  assert.equal(hit.arbiter.evaluate({ settings: { rate: 50 } }).speak, true);
  assert.equal(hit.drawCalls(), 1);
  assert.equal(hit.arbiter.status().passed, 1);

  const miss = createRateHarness([0.9]);
  miss.arbiter.propose(makeCandidate(miss.now, { id: 'miss' }));
  const missOut = miss.arbiter.evaluate({ settings: { rate: 50 } });
  assert.equal(missOut.speak, false);
  assert.equal(missOut.reason, 'rate-miss');
  assert.deepEqual(missOut.suppressed, ['rate-miss']);
  assert.equal(missOut.candidate, null);
  assert.equal(miss.drawCalls(), 1);
  const missAgain = miss.arbiter.evaluate({ settings: { rate: 50 } });
  assert.equal(missAgain.reason, 'rate-miss');
  assert.equal(miss.drawCalls(), 1, '同一身份不重抽');
  const missStatus = miss.arbiter.status();
  assert.equal(missStatus.rate, 50);
  assert.equal(missStatus.drawn, 1);
  assert.equal(missStatus.passed, 0);
  assert.equal(missStatus.pending, 1);
});

test('同身份换措辞不重抽：eventId 优先于 id，描述/ id 变化沿用第一次结果', () => {
  const h = createRateHarness([0.9, 0.1]);
  const { arbiter } = h;

  const first = arbiter.propose(makeCandidate(h.now, {
    id: 'understand:100',
    eventId: 'evt-7',
    description: '旧措辞',
  }));
  assert.equal(first.eventId, 'evt-7');
  const miss = arbiter.evaluate({ settings: { rate: 50 } });
  assert.equal(miss.reason, 'rate-miss');
  assert.equal(h.drawCalls(), 1);

  // 同一事件换 id/描述后再次登记：按 eventId 去重，只保留最新一条，也不产生新抽签。
  const second = arbiter.propose(makeCandidate(h.now, {
    id: 'understand:200',
    eventId: 'evt-7',
    description: '新措辞',
  }));
  assert.ok(second, '同身份的换措辞版本可以替换旧候选');
  assert.equal(arbiter.status().pending, 1, '同 eventId 只保留一条');
  assert.equal(h.drawCalls(), 1, '登记本身不抽签');

  const again = arbiter.evaluate({ settings: { rate: 50 } });
  assert.equal(again.reason, 'rate-miss', '沿用第一次未命中，不因 0.1 的重抽命中');
  assert.equal(h.drawCalls(), 1, '同身份不重抽');
});

test('时机失败不抽签：user-speaking/disabled 返回时随机源不被调用，恢复后才抽', () => {
  const h = createRateHarness([0.2]);
  const { arbiter } = h;
  arbiter.propose(makeCandidate(h.now));

  const speaking = arbiter.evaluate({ userSpeaking: true, settings: { rate: 50 } });
  assert.equal(speaking.reason, 'user-speaking');
  assert.equal(h.drawCalls(), 0, '时机抑制必须发生在抽签之前');

  const disabled = arbiter.evaluate({ settings: { enabled: false, rate: 50 } });
  assert.equal(disabled.reason, 'disabled');
  assert.equal(h.drawCalls(), 0);

  const hit = arbiter.evaluate({ settings: { rate: 50 } });
  assert.equal(hit.speak, true);
  assert.equal(h.drawCalls(), 1, '时机恢复后才抽一次');
});

test('过期候选不抽签：expiresAt/maxAgeMs 失效后返回 no-candidate，随机源不调用', () => {
  const h = createRateHarness([0.2]);
  const { arbiter } = h;
  arbiter.propose(makeCandidate(h.now, { expiresAt: h.now + 1_000 }));

  h.advance(1_000);
  const out = arbiter.evaluate({ settings: { rate: 50 } });
  assert.equal(out.speak, false);
  assert.equal(out.reason, 'no-candidate');
  assert.deepEqual(out.suppressed, ['no-candidate']);
  assert.equal(h.drawCalls(), 0, '没有有效候选时不应抽签');
  assert.equal(arbiter.status().drawn, 0);
});

test('未回应 quiet 仍生效：ignored 后通过率抽签要等静默期结束', () => {
  const h = createRateHarness([0.2, 0.2]);
  const { arbiter } = h;

  const first = arbiter.propose(makeCandidate(h.now, { id: 'first' }));
  assert.equal(arbiter.evaluate({ settings: { rate: 100 } }).speak, true);
  arbiter.spoken(first);

  h.advance(1_000);
  arbiter.ignored();
  arbiter.propose(makeCandidate(h.now, { id: 'during-quiet' }));
  const blocked = arbiter.evaluate({ settings: { rate: 50 } });
  assert.equal(blocked.speak, false);
  assert.equal(blocked.reason, 'too-soon');
  assert.equal(h.drawCalls(), 0, 'quiet 期内不应抽签');

  h.at(T0 + 121_000);
  arbiter.propose(makeCandidate(h.now, { id: 'after-quiet' }));
  const allowed = arbiter.evaluate({ settings: { rate: 50 } });
  assert.equal(allowed.speak, true);
  assert.equal(allowed.reason, 'rate-hit');
  assert.equal(h.drawCalls(), 1, '静默结束后才抽一次');
});

test('通过率设置：0/100 边界、越界夹取、畸形值回退默认 100', () => {
  const high = createRateHarness([0.5]);
  high.arbiter.propose(makeCandidate(high.now));
  assert.equal(high.arbiter.evaluate({ settings: { rate: 250 } }).speak, true, '超过 100 夹到 100');
  assert.equal(high.arbiter.status().rate, 100);
  assert.equal(high.drawCalls(), 0, '夹到 100 后不需要随机数');

  const low = createRateHarness([0.5]);
  low.arbiter.propose(makeCandidate(low.now));
  assert.equal(low.arbiter.evaluate({ settings: { rate: -5 } }).reason, 'rate-zero', '低于 0 夹到 0');
  assert.equal(low.arbiter.status().rate, 0);

  const malformed = createRateHarness([0.5]);
  malformed.arbiter.propose(makeCandidate(malformed.now));
  assert.equal(
    malformed.arbiter.evaluate({ settings: { rate: 'not-a-number' } }).speak,
    true,
    '畸形 rate 回退默认 100',
  );
  assert.equal(malformed.arbiter.status().rate, 100);
});

test('畸形输入不抛错：工厂参数、propose、evaluate、spoken、cancelFor、ignored 都可安全调用', () => {
  assert.doesNotThrow(() => {
    const arbiter = createProactiveArbiter(null);
    assert.equal(arbiter.propose(null), null);
    assert.equal(arbiter.propose('x'), null);
    assert.equal(arbiter.propose([]), null);
    assert.equal(arbiter.propose({}), null);
    assert.equal(
      arbiter.propose({ id: {}, description: 'x', to: T0, evidenceFrameIds: ['f'] }),
      null,
    );
    assert.equal(
      arbiter.propose({ id: 'bad-time', description: 'x', to: 'not-time', evidenceFrameIds: ['f'] }),
      null,
    );

    const empty = arbiter.evaluate(null);
    assert.equal(empty.speak, false);
    assert.equal(empty.reason, 'no-candidate');
    arbiter.evaluate('x');
    arbiter.evaluate([]);
    arbiter.evaluate({ settings: 42 });

    assert.equal(arbiter.spoken(null), false);
    assert.equal(arbiter.spoken({}), false);
    assert.equal(arbiter.spoken({ id: 'x' }, null), true);
    assert.equal(arbiter.cancelFor(null), 0);
    assert.equal(arbiter.cancelFor([null, undefined, {}]), 0);
    assert.equal(arbiter.cancelAll('bad'), 0);
    assert.deepEqual(arbiter.pendingIds(), []);
    assert.equal(arbiter.reset('bad'), 0);
    arbiter.ignored();
    arbiter.status();
  });

  assert.doesNotThrow(() => {
    const thrownClock = createProactiveArbiter({
      now: () => {
        throw new Error('clock');
      },
      draw: () => {
        throw new Error('draw');
      },
      defaults: 'bad',
    });
    thrownClock.evaluate();
    thrownClock.propose(null);
    thrownClock.status();
    createProactiveArbiter({ now: 'not-a-function' }).evaluate();
  });
});
