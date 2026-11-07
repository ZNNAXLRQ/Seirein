/**
 * ProfileStore step 2: pure scoring, adoption/forget thresholds and budget compilation.
 *
 * The fourteen cases below are the rules the user fixed on 2026-11-06. Scoring/selection/
 * compilation are exercised as pure functions; `ProfileStore` is only used where the rule is
 * about persisted evidence (message-id dedupe, user edit override, rank persistence).
 *
 * Run: node --test test/profile-rank.mjs
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DatabaseSync } from 'node:sqlite';

import {
  applyNaturalDecay,
  applyRankEvent,
  independentSupportCount,
  profileLineTokens,
  profilePromptOverheadTokens,
  profileScore,
  rankAndCompile,
  selectProfileEntries,
} from '../src/host/profile/profileRank.js';
import { formatProfilePrompt } from '../src/host/profile/profileMaintain.js';
import { createProfileStore } from '../src/host/profile/profileStore.js';

/** One temp database per store test; the store never opens/closes the handle, the test owns it. */
async function fresh(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-profile-rank-'));
  const db = new DatabaseSync(join(root, 'profile.db'));
  const profile = createProfileStore({ db });
  t.after(async () => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });
  return { root, db, profile };
}

let sequence = 0;
/** A pure entry with deterministic id/created_at unless a test overrides them. */
function entry(overrides = {}) {
  sequence += 1;
  return {
    id: `entry-${sequence}`,
    side: 'agent',
    category: '性格',
    text: `测试条目 ${sequence}`,
    clarity: 50,
    efficacy: 50,
    rank: 'new',
    supportCount: 0,
    created_at: '2026-11-06T00:00:00.000Z',
    ...overrides,
  };
}

const ids = (list) => list.map((item) => item.id);

test('1) S = C×E/100，并按 S 从高到低排序', () => {
  assert.equal(profileScore({ clarity: 80, efficacy: 50 }), 40);
  assert.equal(profileScore({ clarity: 73, efficacy: 47 }), 34.31, '73×47/100 = 34.31');

  const low = entry({ id: 'low', text: '低分条目', clarity: 80, efficacy: 50, supportCount: 2 }); // S 40
  const high = entry({ id: 'high', text: '高分条目', clarity: 70, efficacy: 60, supportCount: 2 }); // S 42
  const selection = selectProfileEntries([low, high]);

  assert.deepEqual(ids(selection.selected), ['high', 'low'], 'selected list follows S descending');
  assert.deepEqual(selection.selected.map((item) => item.score), [42, 40]);
  assert.equal(selection.usedTokens, profileLineTokens(low) + profileLineTokens(high));
  console.log(`1) S(80,50)=40 S(73,47)=34.31 order=${selection.selected.map((item) => item.id).join('>')} used=${selection.usedTokens}`);
});

test('2) 新增竞争门槛：supports>=2 且 C>=60', () => {
  const oneSupport = entry({ id: 'one-support', clarity: 80, supportCount: 1 });
  const lowClarity = entry({ id: 'low-clarity', clarity: 59, supportCount: 2 });
  const justEnough = entry({ id: 'just-enough', clarity: 60, efficacy: 100, supportCount: 2 });
  const selection = selectProfileEntries([oneSupport, lowClarity, justEnough]);

  assert.deepEqual(ids(selection.selected), ['just-enough']);
  assert.deepEqual(
    selection.skipped.map((item) => [item.id, item.reason]),
    [['one-support', 'threshold'], ['low-clarity', 'threshold']],
  );
  assert.equal(selection.ranks['one-support'], 'new');
  assert.equal(selection.ranks['low-clarity'], 'new');
  assert.equal(selection.ranks['just-enough'], 'original');
  console.log(`2) selected=${ids(selection.selected).join(',')} skipped=${selection.skipped.map((item) => item.id).join(',')}`);
});

test('3) 已采纳原订在 C<40 时退出竞争（C=40 仍保留）', () => {
  const retiring = entry({ id: 'retiring', rank: 'original', clarity: 39, supportCount: 0 });
  const holding = entry({ id: 'holding', rank: 'original', clarity: 40, supportCount: 0 });
  const selection = selectProfileEntries([retiring, holding]);

  assert.deepEqual(ids(selection.selected), ['holding']);
  assert.deepEqual(selection.skipped, [{ id: 'retiring', reason: 'threshold' }]);
  assert.equal(selection.ranks.retiring, 'new', 'leaving adoption falls back to new, not deletion');
  assert.equal(selection.ranks.holding, 'original');
  assert.equal(selection.forgotten.length, 0);
  console.log(`3) holding(C=40)=original retiring(C=39)=new skipped=${selection.skipped[0].reason}`);
});

test('4) C<10 第五阶段直接删除（C=10 不删），compileRank 返回删除列表', async (t) => {
  const doomed = entry({ id: 'doomed', clarity: 9, supportCount: 5 });
  const boundary = entry({ id: 'boundary', rank: 'original', clarity: 10, supportCount: 0 });
  const selection = selectProfileEntries([doomed, boundary]);
  assert.deepEqual(ids(selection.forgotten), ['doomed']);
  assert.equal(selection.forgotten[0].reason, 'forgotten');
  assert.equal(selection.ranks.doomed, undefined, 'a forgotten entry is not ranked');
  assert.deepEqual(ids(selection.selected), []);
  assert.deepEqual(selection.skipped, [{ id: 'boundary', reason: 'threshold' }], 'C=10 is kept but retires');

  const { profile } = await fresh(t);
  const stored = profile.upsert({ side: 'agent', text: '这条会被遗忘', clarity: 9, efficacy: 80 }).entry;
  const result = profile.compileRank();
  assert.equal(result.forgotten.length, 1);
  assert.deepEqual(result.applied.removed, [stored.id]);
  assert.equal(profile.get(stored.id), null, 'no archive row survives the fifth stage');
  console.log(`4) forgotten=${result.forgotten.length} removed=${result.applied.removed.join(',')} storedExists=${profile.get(stored.id)}`);
});

test('5) 同一 message_id 重复支持 → 分数不变（幂等，证据只算一份）', async (t) => {
  const first = applyRankEvent({ clarity: 50, efficacy: 50 }, { type: 'support', messageId: 'msg-1' });
  assert.deepEqual([first.clarity, first.efficacy, first.applied], [60, 53, true]);
  const replay = applyRankEvent(
    { clarity: first.clarity, efficacy: first.efficacy },
    { type: 'support', messageId: 'msg-1' },
    { seenMessageIds: ['msg-1'] },
  );
  assert.deepEqual([replay.clarity, replay.efficacy, replay.applied, replay.reason], [60, 53, false, 'duplicate']);

  const { profile } = await fresh(t);
  const stored = profile.upsert({ side: 'agent', text: '重复支持测试', clarity: 50, efficacy: 50 }).entry;
  const a = profile.recordSupport(stored.id, { messageId: 'msg-1' });
  const b = profile.recordSupport(stored.id, { messageId: 'msg-1' });
  assert.equal(a.applied, true);
  assert.equal(b.duplicate, true);
  assert.equal(b.applied, false);
  assert.deepEqual([b.entry.clarity, b.entry.efficacy], [60, 53]);

  // Raw replay of the same evidence also cannot multiply the independent support count.
  profile.addEvidence(stored.id, { messageId: 'msg-1', kind: 'support' });
  assert.equal(profile.get(stored.id).clarity, 60);
  assert.equal(profile.supportCount(stored.id), 1);
  assert.equal(independentSupportCount(profile.evidence(stored.id)), 1);
  console.log(`5) clarity=${b.entry.clarity} efficacy=${b.entry.efficacy} duplicate=${b.duplicate} supports=${profile.supportCount(stored.id)}`);
});

test('6) 无新交流批次 → 不降分（停用期间不遗忘）', async (t) => {
  const idle = applyRankEvent({ clarity: 50, efficacy: 50 }, { type: 'idle', hasNewExchange: false });
  assert.deepEqual([idle.clarity, idle.applied, idle.reason], [50, false, 'no-new-exchange']);
  const active = applyRankEvent({ clarity: 50, efficacy: 50 }, { type: 'idle', hasNewExchange: true });
  assert.deepEqual([active.clarity, active.applied, active.reason], [48, true, 'idle']);

  const { profile } = await fresh(t);
  const stored = profile.upsert({ side: 'agent', text: '停用期间不降分', clarity: 50, efficacy: 50 }).entry;
  profile.recordIdle(stored.id, { hasNewExchange: false });
  profile.recordIdle(stored.id, { hasNewExchange: false });
  profile.recordIdle(stored.id, { hasNewExchange: false });
  assert.equal(profile.get(stored.id).clarity, 50, 'three quiet rounds change nothing');
  const decayed = profile.recordIdle(stored.id, { hasNewExchange: true });
  assert.equal(decayed.entry.clarity, 48);
  assert.equal(profile.recordIdle(stored.id, { hasNewExchange: false }).entry.clarity, 48);
  console.log(`6) offRounds=50 active=${decayed.entry.clarity} againOff=${profile.get(stored.id).clarity}`);
});

test('7) 偶然矛盾 C-5/E 不变；持续明确矛盾 C-10/E-5（均钳制到 0）', async (t) => {
  const occasional = applyRankEvent({ clarity: 50, efficacy: 50 }, { type: 'contradiction', severity: 'occasional' });
  assert.deepEqual([occasional.clarity, occasional.efficacy, occasional.delta], [45, 50, { clarity: -5, efficacy: 0 }]);
  const sustained = applyRankEvent({ clarity: 50, efficacy: 50 }, { type: 'contradiction', severity: 'sustained' });
  assert.deepEqual([sustained.clarity, sustained.efficacy, sustained.delta], [40, 45, { clarity: -10, efficacy: -5 }]);
  const floor = applyRankEvent({ clarity: 3, efficacy: 2 }, { type: 'contradiction', severity: 'sustained' });
  assert.deepEqual([floor.clarity, floor.efficacy], [0, 0], 'scores never go below zero');

  const { profile } = await fresh(t);
  const stored = profile.upsert({ side: 'agent', text: '矛盾测试', clarity: 50, efficacy: 50 }).entry;
  const first = profile.recordContradiction(stored.id, { severity: 'occasional', messageId: 'contra-1' });
  assert.deepEqual([first.entry.clarity, first.entry.efficacy], [45, 50]);
  const second = profile.recordContradiction(stored.id, { severity: 'sustained', messageId: 'contra-2' });
  assert.deepEqual([second.entry.clarity, second.entry.efficacy], [35, 45]);
  const replay = profile.recordContradiction(stored.id, { severity: 'sustained', messageId: 'contra-2' });
  assert.equal(replay.duplicate, true);
  assert.deepEqual([replay.entry.clarity, replay.entry.efficacy], [35, 45], 'same message id never stacks');
  console.log(`7) occasional=45/50 sustained=35/45 replay=${replay.duplicate}`);
});

test('8) 用户 edit / reject 直接生效，不受分数阻挡', async (t) => {
  const { profile } = await fresh(t);
  const stored = profile.upsert({
    side: 'agent',
    text: '原本 C=5 会被遗忘',
    clarity: 5,
    efficacy: 5,
    rank: 'new',
  }).entry;
  assert.equal(profile.supportCount(stored.id), 0);

  const edited = profile.edit(stored.id, { text: '用户当场改成的条目', clarity: 60, efficacy: 60 });
  assert.equal(edited.entry.text, '用户当场改成的条目');
  assert.deepEqual([edited.entry.clarity, edited.entry.efficacy], [60, 60]);
  const compiled = profile.compileRank();
  assert.equal(compiled.forgotten.length, 0, 'the user edit removes the C<10 forget risk');
  assert.notEqual(profile.get(stored.id), null);

  assert.equal(profile.reject(stored.id), true, 'reject is immediate even without any score');
  assert.equal(profile.get(stored.id), null);
  assert.equal(profile.upsert({ side: 'agent', text: '用户当场改成的条目' }), null, 'tombstone follows the edited text');
  console.log(`8) edited=${edited.entry.clarity}/${edited.entry.efficacy} forgotten=${compiled.forgotten.length} rejected=true`);
});

test('9) 入选→original；未入选→new，分数与证据保留，下一轮可再竞争', async (t) => {
  const { profile } = await fresh(t);
  const adopted = profile.upsert({
    side: 'agent', category: '性格', text: '已有两份独立支持', clarity: 80, efficacy: 80,
  }).entry;
  profile.addEvidence(adopted.id, { messageId: 'a-1', kind: 'support' });
  profile.addEvidence(adopted.id, { messageId: 'a-2', kind: 'support' });

  const pending = profile.upsert({
    side: 'agent', category: '性格', text: '只有一份独立支持', clarity: 80, efficacy: 80,
  }).entry;
  profile.addEvidence(pending.id, { messageId: 'b-1', kind: 'support' });

  const first = profile.compileRank();
  assert.equal(profile.get(adopted.id).rank, 'original');
  assert.equal(profile.get(pending.id).rank, 'new');
  assert.deepEqual(
    [profile.get(pending.id).clarity, profile.get(pending.id).efficacy, profile.supportCount(pending.id)],
    [80, 80, 1],
    'an unselected entry keeps its score and evidence',
  );

  profile.addEvidence(pending.id, { messageId: 'b-2', kind: 'support' });
  const second = profile.compileRank();
  assert.equal(profile.get(pending.id).rank, 'original', 'the second support lets it compete immediately');
  assert.deepEqual(second.applied.reranked, [{ id: pending.id, from: 'new', to: 'original' }]);
  console.log(`9) firstReranked=${first.applied.reranked.map((item) => `${item.id}:${item.to}`).join(',')} pendingEvidence=1 second=${profile.get(pending.id).rank}`);
});

test('10) 类目预算：该类超预算 → 该项 skippedByBudget，其它类不受影响', () => {
  const a1 = entry({ id: 'a1', category: '性格', text: '性格条目一十二三', clarity: 80, efficacy: 100, supportCount: 2 });
  const a2 = entry({ id: 'a2', category: '性格', text: '性格条目四五六七', clarity: 70, efficacy: 100, supportCount: 2 });
  const b1 = entry({ id: 'b1', side: 'user', category: '饮食', text: '饮食条目八九十', clarity: 75, efficacy: 100, supportCount: 2 });
  const costA = profileLineTokens(a1);
  assert.equal(profileLineTokens(a2), costA, 'same-length texts cost the same approximation');
  const costB = profileLineTokens(b1);
  const config = {
    categoryBudget: costA + 1,
    // The total also carries the headings; reserve them so the test still targets the category rule.
    totalBudget: costA + costB + profilePromptOverheadTokens(new Set(['agent', 'user'])) + Math.floor(costA / 2),
  };

  const selection = selectProfileEntries([a1, a2, b1], { config });
  assert.deepEqual(ids(selection.selected), ['a1', 'b1']);
  assert.deepEqual(selection.skipped, [{ id: 'a2', reason: 'skippedByBudget' }]);
  assert.equal(selection.ranks.a2, 'new');
  assert.equal(selection.usedTokens, costA + costB);
  assert.equal(selection.budget, config.totalBudget);
  console.log(`10) selected=a1,b1 skipped=a2:${selection.skipped[0].reason} used=${selection.usedTokens}/${selection.budget} costA=${costA}`);
});

test('11) 借用：某类用不完的基础预算可被其它类使用', () => {
  const big = entry({ id: 'big', category: '性格', text: '需要借用预算的性格条目', clarity: 90, efficacy: 100, supportCount: 2 });
  const small = entry({ id: 'small', side: 'user', category: '饮食', text: '小吃', clarity: 70, efficacy: 100, supportCount: 2 });
  const costBig = profileLineTokens(big);
  const costSmall = profileLineTokens(small);
  const config = { categoryBudget: costBig - 1, totalBudget: 100 };

  const selection = selectProfileEntries([big, small], { config });
  assert.deepEqual(ids(selection.selected), ['small', 'big'], 'pass 2 borrows for big after small used its base');
  assert.equal(selection.categoryUsed['agent:性格'], costBig);
  assert.ok(selection.categoryUsed['agent:性格'] > config.categoryBudget, 'big exceeds its own base by borrowing');
  assert.equal(selection.usedTokens, costBig + costSmall);
  assert.ok(selection.usedTokens <= 100);
  console.log(`11) base=${config.categoryBudget} bigUsed=${selection.categoryUsed['agent:性格']} used=${selection.usedTokens}/100`);
});

test('12) 总预算 600 硬上限：超出时按 S 低者先跳过', () => {
  const entries = [];
  for (let index = 0; index < 10; index += 1) {
    entries.push(entry({
      id: `rank-${index}`,
      category: '性格',
      text: `第${index}条：${'这是一段用来测试总预算硬上限的内容。'.repeat(3)}`,
      clarity: 60 + index,
      efficacy: 100,
      supportCount: 2,
    }));
  }
  const selection = selectProfileEntries(entries);
  assert.equal(selection.budget, 600);
  assert.ok(selection.usedTokens <= 600, `usedTokens must not exceed 600, got ${selection.usedTokens}`);
  const budgetSkips = selection.skipped.filter((item) => item.reason === 'skippedByBudget');
  assert.ok(budgetSkips.length >= 1, 'at least the 10th entry must be skipped');
  assert.ok(
    budgetSkips.some((item) => item.id === 'rank-0'),
    'the lowest-S entry is skipped first',
  );
  assert.equal(selection.ranks['rank-0'], 'new', 'a skipped entry stays new and can compete later');
  const selectedScores = selection.selected.map((item) => item.score);
  const skippedScores = entries
    .filter((item) => budgetSkips.some((skip) => skip.id === item.id))
    .map((item) => profileScore(item));
  assert.ok(Math.min(...selectedScores) >= Math.max(...skippedScores), 'budget cuts from the low-S end');
  console.log(`12) used=${selection.usedTokens}/600 selected=${selection.selected.length} skipped=${budgetSkips.length} lowest=rank-0:${budgetSkips.find((item) => item.id === 'rank-0').reason}`);
});

test('13) 编译输出：按类目分组、无截断、usedTokens<=budget', () => {
  const longAgent = '说话时把结论放在前面不要铺垫不要客套也不要重复我已经知道的内容并且尽量用具体的例子说明问题'.
    repeat(3);
  const personality = entry({ id: 'p1', category: '性格', text: '说话简短', clarity: 72, efficacy: 65, supportCount: 2 });
  const language = entry({ id: 'p2', category: '语言', text: longAgent, clarity: 80, efficacy: 70, supportCount: 2 });
  const food = entry({ id: 'u1', side: 'user', category: '饮食', text: '喜欢冰美式', clarity: 90, efficacy: 80, supportCount: 2 });

  const result = rankAndCompile([food, language, personality]);
  assert.equal(result.sections.length, 2);
  assert.deepEqual(result.sections.map((section) => section.side), ['agent', 'user']);
  assert.equal(result.sections[0].title, '人设（自动整理）');
  assert.equal(result.sections[1].title, '用户偏好（自动整理）');
  assert.equal(result.sections[0].heading, '## 人设（自动整理）');
  assert.deepEqual(
    result.sections[0].lines.map((line) => line.slice(0, 5)),
    ['- [性格', '- [语言'],
    'agent categories follow 性格→语言',
  );
  assert.ok(result.sections[0].lines[0].includes('（C=72, E=65）'), 'the line carries C/E');
  assert.ok(result.sections[0].lines[1].includes(longAgent), 'long text is emitted whole');
  assert.equal(result.text.includes('…'), false, 'never truncates');
  assert.ok(result.text.indexOf('## 人设（自动整理）') < result.text.indexOf('## 用户偏好（自动整理）'));
  assert.ok(result.usedTokens <= result.budget, `usedTokens ${result.usedTokens} must fit ${result.budget}`);
  assert.ok(result.usedTokens > 0);
  assert.equal(result.skipped.length, 0);
  console.log(`13) sections=${result.sections.map((section) => section.title).join('|')} used=${result.usedTokens}/${result.budget} longChars=${longAgent.length} full=${result.text.includes(longAgent)}`);
});

test('14) 同义合并：相同 fingerprint 只出一条（保留 S 最高）', async (t) => {
  const { profile } = await fresh(t);
  const high = profile.upsert({
    side: 'user', category: '饮食', text: 'I like coffee', clarity: 80, efficacy: 80, rank: 'new',
  }).entry;
  const low = profile.upsert({
    side: 'user', category: '饮食', text: 'i like coffee', clarity: 60, efficacy: 60, rank: 'new',
  }).entry;
  for (const id of [high.id, low.id]) {
    profile.addEvidence(id, { messageId: `${id}-1`, kind: 'support' });
    profile.addEvidence(id, { messageId: `${id}-2`, kind: 'support' });
  }

  const result = profile.compileRank();
  assert.equal(result.sections.length, 1);
  const coffeeLines = result.sections[0].lines.filter((line) => line.toLowerCase().includes('coffee'));
  assert.equal(coffeeLines.length, 1, 'same fingerprint yields exactly one line');
  assert.ok(coffeeLines[0].includes('I like coffee'), 'the higher-S spelling survives');
  assert.equal(result.text.toLowerCase().match(/coffee/g).length, 1);
  assert.equal(profile.get(high.id).rank, 'original');
  assert.equal(profile.get(low.id).rank, 'new');
  assert.ok(result.skipped.some((item) => item.id === low.id && item.reason === 'duplicate'));
  console.log(`14) lines=${coffeeLines.length} kept=${coffeeLines[0]} duplicateSkipped=${low.id}`);
});

test('15) 自然衰退：默认 C-2、E 不变，0 为下限；idle 事件复用同一规则', () => {
  const quiet = applyNaturalDecay({ clarity: 60, efficacy: 50 });
  assert.deepEqual([quiet.clarity, quiet.efficacy, quiet.delta], [58, 50, { clarity: -2, efficacy: 0 }]);
  const floor = applyNaturalDecay({ clarity: 1, efficacy: 70 });
  assert.deepEqual([floor.clarity, floor.efficacy], [0, 70], 'clarity never goes below zero');
  const custom = applyNaturalDecay({ clarity: 60, efficacy: 50 }, { config: { idleClarityLoss: 3 } });
  assert.equal(custom.clarity, 57);

  const idle = applyRankEvent({ clarity: 60, efficacy: 50 }, { type: 'idle', hasNewExchange: true });
  assert.deepEqual([idle.clarity, idle.efficacy, idle.applied], [58, 50, true]);
  const quietRound = applyRankEvent({ clarity: 60, efficacy: 50 }, { type: 'idle', hasNewExchange: false });
  assert.deepEqual([quietRound.clarity, quietRound.applied, quietRound.reason], [60, false, 'no-new-exchange']);
  console.log(`15) decay=${quiet.clarity} floor=${floor.clarity} custom=${custom.clarity} idle=${idle.clarity}`);
});

test('16) 锁定：不遗忘，且采纳状态不变（原订保留，新增不自动转正）', () => {
  const lockedOriginal = entry({ id: 'locked-original', clarity: 35, rank: 'original', locked: true });
  const lockedNew = entry({
    id: 'locked-new', clarity: 90, efficacy: 90, supportCount: 2, locked: true,
  });
  const selection = selectProfileEntries([lockedOriginal, lockedNew]);

  assert.deepEqual(ids(selection.selected), ['locked-original'], 'a locked original stays compiled below the retirement line');
  assert.equal(selection.ranks['locked-original'], 'original');
  assert.equal(selection.ranks['locked-new'], 'new', 'a locked new entry is never auto-promoted');
  assert.equal(selection.forgotten.length, 0);
  assert.deepEqual(selection.skipped, [{ id: 'locked-new', reason: 'locked' }]);
  console.log(`16) selected=${ids(selection.selected).join(',')} lockedNew=${selection.ranks['locked-new']} skipped=${selection.skipped[0].reason}`);
});

test('17) 编译与注入同一预算口径：刚好 600 的编译结果不会被注入整块跳过', () => {
  // Build one line whose whole compiled body (heading + line) estimates exactly 600 tokens.
  const prefix = '## 人设（自动整理）\n- [性格] ';
  const suffix = '（C=60, E=50）';
  const overhead = profilePromptOverheadTokens(new Set(['agent']));
  const base = profileLineTokens({ category: '性格', text: '', clarity: 60, efficacy: 50 });
  const fill = '条'.repeat(600 - overhead - base);
  const exact = entry({
    id: 'exact-600', category: '性格', text: fill, clarity: 60, efficacy: 50, supportCount: 2,
  });

  const result = rankAndCompile([exact]);
  assert.equal(result.text, `${prefix}${fill}${suffix}`, 'the compiled body includes the group heading');
  assert.equal(result.usedTokens, 600, 'usedTokens must count the heading too');
  assert.equal(result.budget, 600);
  assert.ok(result.selected.length === 1, 'the entry still fits the selection budget');

  const injected = formatProfilePrompt(result.text);
  assert.equal(injected.skipped, null, '600/600 passes the injection gate');
  assert.equal(injected.text, result.text);
  assert.equal(injected.entries, 1);
  console.log(`17) used=${result.usedTokens}/${result.budget} heading=${overhead} skipped=${injected.skipped} injectedChars=${injected.text.length}`);
});
