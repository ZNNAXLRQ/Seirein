/**
 * P-187 阶段 5：主动回应仲裁（纯决策层）。
 *
 * 这些用例逐条盯住契约里的硬规则：
 *   证据约束、有效期与 maxAgeMs、优先级选择、四类时机抑制、too-soon、
 *   ignored 静默与放大、每小时上限、同 id 去重、cancelFor、settings 覆盖、
 *   候选上限淘汰、spoken/ignored 状态，以及畸形输入不抛错。
 *
 * 所有时间都通过可变的 `now` 注入，不用真实时钟；候选的 from/to 也按该时钟生成，
 * 这样“事件发生 -> 候选过期 -> 恢复可开口”的边界可以一眼核对。
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
  assert.equal(Object.isFrozen(audioOnly), true);

  const status = arbiter.status();
  assert.equal(status.counts.proposed, 1);
  assert.equal(status.counts.rejected, 3);
});

test('有效期：expiresAt 到点即失效，事件超过 maxAgeMs 拒绝，边界不误杀', () => {
  const h = createHarness();
  const { arbiter } = h;
  const base = makeCandidate(h.now);

  assert.equal(arbiter.propose({ ...base, expiresAt: h.now - 1 }), null, '已过的 expiresAt 应拒绝');
  assert.equal(arbiter.propose({ ...base, id: 'expires-now', expiresAt: h.now }), null, '到点即失效');

  h.at(T0 + 8_001);
  assert.equal(
    arbiter.propose({ ...makeCandidate(h.now), id: 'too-old', from: T0 - 1_000, to: T0 }),
    null,
    'now - to > maxAgeMs 应拒绝',
  );
  const edge = arbiter.propose({
    ...makeCandidate(h.now),
    id: 'edge',
    from: T0 - 1_000,
    to: T0 + 1,
  });
  assert.ok(edge, 'now - to 恰好等于 maxAgeMs 时仍应有效');

  const status = arbiter.status();
  assert.equal(status.counts.expired, 3);
  assert.equal(status.counts.proposed, 1);
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
  assert.equal(first.reason, 'ok');
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

test('too-soon：距上次开口不足 minGapMs 不开口，到点后恢复', () => {
  const h = createHarness();
  const { arbiter } = h;

  const first = arbiter.propose(makeCandidate(h.now));
  assert.equal(arbiter.evaluate().speak, true);
  arbiter.spoken(first);

  h.advance(44_999);
  arbiter.propose(makeCandidate(h.now, { id: 'next' }));
  const blocked = arbiter.evaluate();
  assert.equal(blocked.speak, false);
  assert.equal(blocked.reason, 'too-soon');
  assert.deepEqual(blocked.suppressed, ['too-soon']);
  assert.equal(blocked.candidate, null);

  h.at(T0 + 45_000);
  const allowed = arbiter.evaluate();
  assert.equal(allowed.speak, true);
  assert.equal(allowed.candidate.id, 'next');
});

test('hourly-limit：滚动一小时内达到上限后不再开口，过窗恢复', () => {
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

test('同 id 去重、cancelFor 取消、说过的事件在窗口内不能重复登记', () => {
  const h = createHarness();
  const { arbiter } = h;

  assert.ok(arbiter.propose(makeCandidate(h.now, { id: 'same', description: '旧版本' })));
  assert.ok(arbiter.propose(makeCandidate(h.now, { id: 'same', description: '新版本' })));
  assert.equal(arbiter.status().pending, 1, '同 id 只保留一条');
  assert.equal(arbiter.status().counts.evicted, 0, '同 id 替换不算淘汰');

  const picked = arbiter.evaluate();
  assert.equal(picked.candidate.description, '新版本', '后到版本应替换旧版本');
  arbiter.spoken(picked.candidate);

  assert.equal(
    arbiter.propose(makeCandidate(h.now, { id: 'same', description: '重复' })),
    null,
    '刚说过的事件在 maxAgeMs 窗口内不能重复登记',
  );
  assert.equal(arbiter.status().counts.duplicate, 1);

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

  // 默认 minGapMs 是 45s；覆盖成 1s 后，1.5s 就可以开口。
  h.advance(1_500);
  arbiter.propose(makeCandidate(h.now, { id: 'after-short-gap' }));
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

test('reset：清空候选/取消集/重复窗口/时机窗口，保留累计计数', () => {
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

  // 取消集与 spokenAt 都已清空：同一事件 id 可以重新登记并重新开口。
  assert.ok(arbiter.propose(makeCandidate(h.now, { id: 'e1' })));
  const resumed = arbiter.evaluate({ settings: { minGapMs: 0 } });
  assert.equal(resumed.speak, true);
  assert.equal(resumed.candidate.id, 'e1');
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
      defaults: 'bad',
    });
    thrownClock.evaluate();
    thrownClock.propose(null);
    thrownClock.status();
    createProactiveArbiter({ now: 'not-a-function' }).evaluate();
  });
});
