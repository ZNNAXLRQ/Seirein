/**
 * Spoken-style contract: the prompt's hard spoken-language constraints and the read-aloud
 * normalization that backs them.
 *
 * Two independent layers are asserted here:
 *   1. `SPOKEN_VERSION_GUIDE` carries a soft short-sentence / natural-phrasing contract whose
 *      priority is explicitly below facts, semantics and persona, plus two real few-shot pairs;
 *   2. `normalizeSpokenVersion` cleans presentation marks without deleting content (negation,
 *      causality, numbers/units, names, conditions, persona particles), and accepts a candidate
 *      whose length equals the body while refusing anything longer.
 *
 * The explicit full-read path is unchanged: "详细讲 / 全部读出来" still speaks the body at its
 * own completeness, and the guide still says so.
 *
 * Run: node --test test/spoken-style-contract.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

import { normalizeSpokenVersion, requestsFullRead } from '../src/host/shared/text.js';

const indexSource = await readFile(new URL('../src/host/index.js', import.meta.url), 'utf8');
const textSource = await readFile(new URL('../src/host/shared/text.js', import.meta.url), 'utf8');

const guideStart = indexSource.indexOf('const SPOKEN_VERSION_GUIDE = `');
assert.notEqual(guideStart, -1, 'SPOKEN_VERSION_GUIDE is declared');
const guideEnd = indexSource.indexOf('`;', guideStart);
assert.notEqual(guideEnd, -1, 'SPOKEN_VERSION_GUIDE is a template literal');
const guide = indexSource.slice(guideStart, guideEnd);

// ---------------------------------------------------------------------------
// 1. The hard constraint block exists, stays soft on length, and never outranks semantics/persona
// ---------------------------------------------------------------------------
test('1. guide 含软性短句约束、两组 few-shot 与语义/人设优先', (t) => {
  for (const marker of [
    '口语硬约束',
    '优先级高于文采与结构',
    '但低于事实、语义与人设',
    '冲突时，以本节为准',
  ]) {
    assert.ok(guide.includes(marker), `missing priority marker "${marker}"`);
  }

  // One main idea per sentence; long attributives split out; short sentences stay a soft rule.
  for (const marker of ['一句一个主要意思', '句子长短跟着口气走', '不为了短而硬拆', '定语太长', '再拆成短句']) {
    assert.ok(guide.includes(marker), `missing soft short-sentence rule "${marker}"`);
  }
  assert.ok(!guide.includes('约 25 字'), 'no hard 25-character ceiling');
  assert.ok(!/每句超过约\s*25\s*字|超过\s*25\s*字就拆/u.test(guide), 'no split-if-over-25 rule');

  // Formatting is phrased as "say it naturally", not a blanket ban on quotes/brackets/dashes.
  for (const marker of [
    '不朗读 Markdown', '标题', '编号', '列表符号',
    '括号补充', '引号里的原话', '破折号停顿',
    '生成时尽量改成自然口语', '间接引语', '不要为了躲符号而删掉内容',
  ]) {
    assert.ok(guide.includes(marker), `missing no-formatting rule "${marker}"`);
  }

  // Connectives are not banned: 其实/所以 may carry correction or causality.
  assert.ok(guide.includes('不禁用“其实”“所以”'), 'the guide explicitly allows 其实/所以');
  assert.ok(!guide.includes('少用书面连接词堆叠'), 'the old blanket connective warning is gone');

  // No structural signposting or closing summary.
  for (const marker of ['结构词', '第一、第二、总之', '文章式结尾', '总结']) {
    assert.ok(guide.includes(marker), `missing no-structure-word rule "${marker}"`);
  }

  // Persona expression survives; it is never deleted for "cleanliness".
  for (const marker of ['人设与已有表达优先', '语气词', '轻笑', '不为了“干净”删掉']) {
    assert.ok(guide.includes(marker), `missing persona-tone rule "${marker}"`);
  }

  // Written metaphors are only a preference, not a blanket rewrite rule.
  assert.ok(guide.includes('书面比喻、成语、评论腔优先考虑直说'), 'written metaphors prefer plain speech');
  assert.ok(guide.includes('人设正需要这种说法时保留'), 'a persona-required metaphor is kept');
  assert.ok(guide.includes('只学句式') && guide.includes('不是逐字套用的模板'),
    'the samples are examples, not absolute templates');

  // The two real written→spoken pairs are both present, word for word.
  assert.equal((guide.match(/书面：/gu) ?? []).length, 2, 'two written samples');
  assert.equal((guide.match(/口语：/gu) ?? []).length, 2, 'two spoken samples');
  for (const sample of [
    '片子好不好是外面那把尺子的事',
    '他其实在说，别人只看片子好不好',
    '这种「一开始不对付」的铺垫其实是最好的调味料',
    '一开始两个人互相看不顺眼，这个安排挺有意思',
  ]) {
    assert.ok(guide.includes(sample), `missing few-shot sample "${sample}"`);
  }

  // The earlier five-step need-oriented structure is intact.
  for (const marker of [
    '1. 识别本次需求',
    '2. 选取需要说的信息',
    '3. 保留所选结论的必要条件',
    '4. 按人设重新组织口头表达',
    '5. 检查清晰度与冗余',
  ]) {
    assert.ok(guide.includes(marker), `the five-step guide survives: "${marker}"`);
  }
  t.diagnostic(`guideChars=${guide.length} hardConstraints=yes fiveStepsIntact=yes samples=2`);
});

// ---------------------------------------------------------------------------
// 2. Normalization: presentation cleans away, content stays, equal length wins
// ---------------------------------------------------------------------------
test('2. 归一化清理示例：去格式保实词，等长采纳、超长拒绝', (t) => {
  const source = '本来就很长的一段正文，足够用来做长度基准。';

  // Markdown emphasis, a wrapping quote, an em dash and an emoji.
  const marked = normalizeSpokenVersion(source, '**结论**：“明天——有雨☔️。”');
  assert.equal(marked.ok, true);
  assert.equal(marked.text, '结论：明天，有雨。');
  assert.ok(marked.text.includes('结论') && marked.text.includes('有雨'), 'content words are kept');

  // Backticks and book-title marks are presentation only.
  const quoted = normalizeSpokenVersion(source, '读`三体`，别读《活着》。');
  assert.equal(quoted.text, '读三体，别读活着。');

  // Paired quotation marks disappear; their content stays.
  const paired = normalizeSpokenVersion(source, '「明天有雨」，记得带伞。');
  assert.equal(paired.text, '明天有雨，记得带伞。');

  // Turn 11: 166-char body and 166-char spoken version: equal is adopted.
  const equalBody = '说明'.repeat(83);
  const equalSpoken = '口播'.repeat(83);
  assert.equal([...equalBody].length, 166);
  assert.equal([...equalSpoken].length, 166);
  const equal = normalizeSpokenVersion(equalBody, equalSpoken);
  assert.equal(equal.ok, true, 'equal length is accepted');
  assert.equal(equal.chars, [...equalBody].length);

  // One character over the body is still refused; no cleanup may grow the text.
  const longer = normalizeSpokenVersion(source, `${source}再补一句。`);
  assert.equal(longer.ok, false);
  assert.equal(longer.reason, 'not-shorter');

  // The old invalid comparison is gone at the source level.
  assert.match(textSource, /if \(chars > sourceChars\) return \{ ok: false, text, chars, reason: 'not-shorter' \}/u);
  assert.ok(!textSource.includes('chars >= sourceChars'), 'the >= rejection is removed');
  t.diagnostic(`marked="${marked.text}" equal=${equal.chars} longer=${longer.reason}`);
});

// ---------------------------------------------------------------------------
// 3. Cleanup failures keep their original reasons; the detailed path is untouched
// ---------------------------------------------------------------------------
test('3. 空串/过短/前言仍按原 reason 拒绝；用户要求详细时仍按正文完整度', (t) => {
  const source = '这是足够长的正文，用来做拒绝原因的基准。';
  assert.equal(normalizeSpokenVersion(source, '😀😀').reason, 'empty');
  assert.equal(normalizeSpokenVersion(source, '好的。').reason, 'too-short');

  const preambleSource = '这是正文内容。'.repeat(10);
  const preamble = normalizeSpokenVersion(preambleSource, `好的，${preambleSource.slice(0, 62)}`);
  assert.equal(preamble.ok, false);
  assert.equal(preamble.reason, 'preamble');

  // The full-read exceptions and the guide's completeness promise are unchanged.
  assert.equal(requestsFullRead('详细讲一下明天的天气'), true);
  assert.equal(requestsFullRead('把正文全部读出来'), true);
  assert.equal(requestsFullRead('简单说说'), false);
  assert.ok(
    guide.includes('用户本轮明确要求详细、完整列举或全部朗读时，按正文本身的完整度表达'),
    'the detailed/full-read completeness rule is unchanged',
  );
  assert.ok(guide.includes('不要为了简短而省略'), 'the guide never trades completeness for brevity');
  t.diagnostic(`empty/too-short/preamble refused; fullRead=unchanged`);
});

// ---------------------------------------------------------------------------
// 4. Semantic fidelity: cleanup keeps negation/causality/units/names/conditions/persona
// ---------------------------------------------------------------------------
test('4. 语义保真：否定、因果、数字单位、名称、补充条件、人设语气词都不被清理删掉', (t) => {
  const source = '这是一段足够长的正文，用来做语义保真的长度基准。';
  const cases = [
    ['negation', '不是取消，是改到明天。', ['不是', '取消', '改到明天']],
    ['causality', '因为临时有变，所以改到明天。', ['因为', '所以', '改到明天']],
    ['range+unit', '明天 10—20℃，记得带伞。', ['10—20℃', '带伞']],
    ['minus+unit', '最低会到 -5℃，风很大。', ['-5℃', '风很大']],
    ['name reference', '《三体》里的叶文洁很关键。', ['三体', '叶文洁']],
    ['supplementary condition', '活动到周日（周末除外）。', ['活动到周日', '周末除外']],
    ['persona particles', '好呀，别担心啦。', ['好呀', '别担心啦']],
  ];
  for (const [label, candidate, fragments] of cases) {
    const result = normalizeSpokenVersion(source, candidate);
    assert.equal(result.ok, true, `${label}: the candidate is adopted`);
    for (const fragment of fragments) {
      assert.ok(result.text.includes(fragment), `${label}: kept "${fragment}" in "${result.text}"`);
    }
  }

  // Title marks are presentation only; the referenced work stays.
  const named = normalizeSpokenVersion(source, '《三体》里的叶文洁很关键。');
  assert.ok(!named.text.includes('《') && !named.text.includes('》'), 'title marks are dropped');
  assert.ok(named.text.includes('三体') && named.text.includes('叶文洁'), 'the reference object is kept');

  // Equal length is adopted conservatively: equality is fine, one character over is not.
  const equalBody = '等长正文'.repeat(8);
  const equal = normalizeSpokenVersion(equalBody, equalBody);
  assert.equal(equal.ok, true, 'an equal-length spoken version is accepted');
  assert.equal(equal.chars, [...equalBody].length);
  const longer = normalizeSpokenVersion(equalBody, `${equalBody}多一句。`);
  assert.equal(longer.ok, false, 'a longer candidate is still refused');
  assert.equal(longer.reason, 'not-shorter');
  assert.match(textSource, /if \(chars > sourceChars\) return \{ ok: false, text, chars, reason: 'not-shorter' \}/u);
  t.diagnostic(`semanticCases=${cases.length} equal=${equal.chars} longer=${longer.reason}`);
});
