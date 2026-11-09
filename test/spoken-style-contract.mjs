/**
 * Spoken-style contract: the prompt's hard spoken-language constraints and the read-aloud
 * normalization that backs them.
 *
 * Two independent layers are asserted here:
 *   1. `SPOKEN_VERSION_GUIDE` carries a short-sentence / no-formatting / few-written-connective
 *      section whose priority is explicitly above style and structure;
 *   2. `normalizeSpokenVersion` cleans presentation marks without deleting content, and accepts a
 *      candidate whose length equals the body (turn 11: 166 chars -> 166 chars) while still
 *      refusing anything longer.
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
// 1. The hard constraint block exists and outranks style/structure
// ---------------------------------------------------------------------------
test('1. guide 含口语硬约束，且优先级高于文采与结构', (t) => {
  for (const marker of [
    '口语硬约束',
    '优先级高于文采与结构',
    '冲突时，以本节为准',
  ]) {
    assert.ok(guide.includes(marker), `missing priority marker "${marker}"`);
  }

  // One meaning per sentence, short sentences, long attributives split out.
  for (const marker of ['一句一个意思', '尽量短句', '约 25 字', '长定语拆成短句']) {
    assert.ok(guide.includes(marker), `missing short-sentence rule "${marker}"`);
  }

  // No Markdown / headings / numbering / brackets / quotes / dashes / emoji.
  for (const marker of [
    '不输出 Markdown', '标题', '编号', '括号', '引号', '破折号', '表情符号',
    '停顿只用逗号和句号',
  ]) {
    assert.ok(guide.includes(marker), `missing no-formatting rule "${marker}"`);
  }

  // Written connectives are limited, not banned outright.
  assert.match(
    guide,
    /少用书面连接词堆叠[^。]*其实、所以、正是、这种、并且、而/u,
    'the guide names the written connectives to avoid stacking',
  );
  assert.match(guide, /需要时用自然口语，但不要过量/u, 'natural spoken connectives are allowed, not excessive');

  // No structural signposting or closing summary.
  for (const marker of ['结构词', '第一、第二、总之', '结尾总结']) {
    assert.ok(guide.includes(marker), `missing no-structure-word rule "${marker}"`);
  }

  // Persona voice survives, without piling up particles or coy padding.
  for (const marker of ['保留人设语气', '不堆语气词', '不靠撒娇或铺垫']) {
    assert.ok(guide.includes(marker), `missing persona-tone rule "${marker}"`);
  }

  // Exactly one short contrast example, not a long tutorial.
  assert.equal((guide.match(/示例/gu) ?? []).length, 1, 'exactly one contrast example');
  assert.ok(guide.includes('书面') && guide.includes('口语'), 'the example contrasts written and spoken');

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
  t.diagnostic(`guideChars=${guide.length} hardConstraints=yes fiveStepsIntact=yes examples=1`);
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
