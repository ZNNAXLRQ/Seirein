/**
 * Spoken-version de-duplication (pure module): drop whole repeated sentences from an already
 * rewritten spoken script, without rewriting, merging or reordering the survivors.
 *
 * Rules under test:
 *  - normalized-identical sentences (punctuation/whitespace ignored): first one wins;
 *  - character-3-gram Jaccard >= 0.90 for ADJACENT pairs and >= 0.85 for NON-adjacent pairs:
 *    the more informative sentence wins (character count; a tie keeps the earlier one);
 *  - the LAST sentence is a protected conclusion; only an exact echo of the sentence right
 *    before it is dropped;
 *  - order, punctuation and every surviving sentence are untouched;
 *  - `enabled:false`, `exactOnly:true` and a custom `similarityThreshold` change only what is
 *    considered a duplicate.
 *
 * Run: node --test test/spoken-dedupe.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  dedupeSpokenUnits,
  spokenSimilarity,
} from '../src/host/speech/spoken-dedupe.js';

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

/** 39 key chars; append "具体安排" for the longer version. */
const P39 = '今天下午我们一起把方案里的数据都重新核对了一遍然后和团队约好明天上午最终再确认';
const SHORTER = `${P39}。`;
const LONGER = `${P39}具体安排。`;
const OTHER_TAIL = '剩下的事项按原计划继续推进。';

/** 31 key chars; the two tails differ in both characters. */
const P31 = '今天下午我们一起把方案里的数据重新核对了一遍然后约好明天再确认';
const ADJ_A = `${P31}细节。`;
const ADJ_B = `${P31}要点。`;

/** 27 key chars, so the pair below is NOT adjacent (a middle sentence sits between them). */
const P27 = '今天下午我们一起把方案里的数据重新核对了一遍然后再约好';
const NONADJ_A = `${P27}明天。`;
const NONADJ_B = `${P27}后天。`;

/** 23 key chars + two 7-char opposing views: wording close, meaning different. */
const P23 = '把之前收集到的所有资料都重新看了一遍以后我觉得';
const VIEW_A = `${P23}风险太高要谨慎。`;
const VIEW_B = `${P23}机会很大可推进。`;

const keyLength = (text) => [...String(text).replace(/[\s\p{P}\p{S}]+/gu, '')].length;

// ---------------------------------------------------------------------------
// 1) identical sentences: keep the first, drop the later one
// ---------------------------------------------------------------------------

test('完全相同的两句：保留第 1 句，第二句删除，reason=exact', () => {
  const input = ['先检查配置。', '先检查配置。'];
  const result = dedupeSpokenUnits(input);

  assert.deepEqual(result.units, ['先检查配置。']);
  assert.deepEqual(result.removed, [
    { text: '先检查配置。', reason: 'exact', keptWith: 0 },
  ]);
  assert.deepEqual(input, ['先检查配置。', '先检查配置。'], 'the input list is not mutated');
});

test('只差标点/空白的句子按归一化后完全相同处理', () => {
  const result = dedupeSpokenUnits(['好的，我马上处理。', '好的 我马上处理！']);

  assert.deepEqual(result.units, ['好的，我马上处理。'], 'the first punctuation stays verbatim');
  assert.equal(result.removed.length, 1);
  assert.equal(result.removed[0].reason, 'exact');
  assert.equal(result.removed[0].keptWith, 0);
});

// ---------------------------------------------------------------------------
// 2) near restatement: the less informative sentence disappears
// ---------------------------------------------------------------------------

test('近义复述（相邻 0.90）：删信息少的一句，保留更长的一句', () => {
  const score = spokenSimilarity(SHORTER, LONGER);
  assert.ok(score >= 0.9 && score < 0.95, `fixture score is adjacent-high: ${score.toFixed(4)}`);
  assert.ok(keyLength(LONGER) > keyLength(SHORTER), 'the surviving sentence carries more characters');

  const result = dedupeSpokenUnits([SHORTER, LONGER, OTHER_TAIL]);

  assert.deepEqual(result.units, [LONGER, OTHER_TAIL], 'longer restatement and the tail remain, in order');
  assert.deepEqual(result.removed, [
    { text: SHORTER, reason: 'similar', keptWith: 0 },
  ]);
});

// ---------------------------------------------------------------------------
// 3) close wording, different opinion: never deleted
// ---------------------------------------------------------------------------

test('不同观点但措辞相近（约 0.6）：不删', () => {
  const score = spokenSimilarity(VIEW_A, VIEW_B);
  assert.ok(score >= 0.55 && score < 0.7, `fixture score is below every threshold: ${score.toFixed(4)}`);

  const result = dedupeSpokenUnits([VIEW_A, VIEW_B]);

  assert.deepEqual(result.units, [VIEW_A, VIEW_B]);
  assert.deepEqual(result.removed, []);
});

// ---------------------------------------------------------------------------
// 4) conclusion vs opening: the conclusion survives
// ---------------------------------------------------------------------------

test('结论句与开头重复：删开头，保留结尾结论', () => {
  const input = ['先检查配置。', '再重启服务。', '先检查配置！'];
  const result = dedupeSpokenUnits(input);

  assert.deepEqual(result.units, ['再重启服务。', '先检查配置！'], 'the conclusion keeps its own punctuation');
  assert.deepEqual(result.removed, [
    { text: '先检查配置。', reason: 'exact', keptWith: 1 },
  ]);
});

// ---------------------------------------------------------------------------
// 5) adjacent threshold is strict: 0.88 < 0.90 -> keep both
// ---------------------------------------------------------------------------

test('相邻句 0.88：用 0.9 阈值判定，不删', () => {
  const score = spokenSimilarity(ADJ_A, ADJ_B);
  assert.ok(score >= 0.85 && score < 0.9, `fixture score sits between the two thresholds: ${score.toFixed(4)}`);

  const result = dedupeSpokenUnits([ADJ_A, ADJ_B]);

  assert.deepEqual(result.units, [ADJ_A, ADJ_B]);
  assert.deepEqual(result.removed, []);
});

// ---------------------------------------------------------------------------
// 6) non-adjacent threshold: 0.86 >= 0.85 -> delete
// ---------------------------------------------------------------------------

test('非相邻 0.86：用 0.85 阈值判定，删除重复的一句', () => {
  const score = spokenSimilarity(NONADJ_A, NONADJ_B);
  assert.ok(score >= 0.85 && score < 0.9, `fixture score clears the non-adjacent floor: ${score.toFixed(4)}`);

  const result = dedupeSpokenUnits([NONADJ_A, '今天天气不错。', NONADJ_B, '记得早点休息。']);

  assert.deepEqual(result.units, [NONADJ_A, '今天天气不错。', '记得早点休息。']);
  assert.deepEqual(result.removed, [
    { text: NONADJ_B, reason: 'similar', keptWith: 0 },
  ]);
});

// ---------------------------------------------------------------------------
// 7) single sentence / disabled
// ---------------------------------------------------------------------------

test('只有一句：原样返回', () => {
  const input = ['只有这一句。'];
  const result = dedupeSpokenUnits(input);

  assert.deepEqual(result.units, input);
  assert.deepEqual(result.removed, []);
});

test('enabled:false：原样返回（同一个数组引用，removed 为空）', () => {
  const input = ['先检查配置。', '先检查配置。'];
  const result = dedupeSpokenUnits(input, { enabled: false });

  assert.equal(result.units, input, 'the caller gets its own list back');
  assert.deepEqual(result.units, ['先检查配置。', '先检查配置。']);
  assert.deepEqual(result.removed, []);
});

// ---------------------------------------------------------------------------
// 8) order and punctuation are preserved exactly
// ---------------------------------------------------------------------------

test('顺序保持、标点逐字不变：只删整句', () => {
  const input = ['第一句，带标点。', '第二句！', '第一句，带标点。', '第三句？'];
  const result = dedupeSpokenUnits(input);

  assert.deepEqual(result.units, ['第一句，带标点。', '第二句！', '第三句？']);
  // Every surviving string is byte-for-byte one of the input units, in the original order.
  const positions = result.units.map((unit) => input.indexOf(unit));
  assert.deepEqual(positions, [0, 1, 3]);
  assert.deepEqual(result.removed, [
    { text: '第一句，带标点。', reason: 'exact', keptWith: 0 },
  ]);
});

// ---------------------------------------------------------------------------
// 9) a whole text is split on sentence boundaries first
// ---------------------------------------------------------------------------

test('输入整段文本：先按句界切分再去重', () => {
  const result = dedupeSpokenUnits('先检查配置。再重启服务。再重启服务。');

  assert.deepEqual(result.units, ['先检查配置。', '再重启服务。']);
  assert.deepEqual(result.removed, [
    { text: '再重启服务。', reason: 'exact', keptWith: 1 },
  ]);
});

// ---------------------------------------------------------------------------
// 10) exactOnly disables the similarity rule
// ---------------------------------------------------------------------------

test('exactOnly:true：近义复述不删，只删完全相同的句子', () => {
  const near = dedupeSpokenUnits([SHORTER, LONGER, OTHER_TAIL], { exactOnly: true });
  assert.deepEqual(near.units, [SHORTER, LONGER, OTHER_TAIL]);
  assert.deepEqual(near.removed, []);

  const exact = dedupeSpokenUnits(['先检查配置。', '先检查配置。'], { exactOnly: true });
  assert.deepEqual(exact.units, ['先检查配置。']);
  assert.equal(exact.removed[0].reason, 'exact');
});

// ---------------------------------------------------------------------------
// 11) a custom threshold replaces the non-adjacent floor
// ---------------------------------------------------------------------------

test('similarityThreshold 0.95：0.90 的近义句不再删除', () => {
  const result = dedupeSpokenUnits([SHORTER, LONGER, OTHER_TAIL], { similarityThreshold: 0.95 });

  assert.deepEqual(result.units, [SHORTER, LONGER, OTHER_TAIL]);
  assert.deepEqual(result.removed, []);
});

// ---------------------------------------------------------------------------
// 12) keptWith always names a surviving unit, even through a removal chain
// ---------------------------------------------------------------------------

test('keptWith 指向最终保留的句子（删除链自动回溯）', () => {
  const result = dedupeSpokenUnits(['先检查配置。', '先检查配置。', '先检查配置。']);

  assert.deepEqual(result.units, ['先检查配置。']);
  assert.equal(result.removed.length, 2);
  for (const entry of result.removed) {
    assert.equal(entry.reason, 'exact');
    assert.equal(entry.keptWith, 0, 'both copies point at the one surviving sentence');
  }
});
