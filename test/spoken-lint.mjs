/**
 * Read-only spoken-style lint.
 *
 * `spokenLint` only OBSERVES: it never edits the text, never blocks/retries and makes no model
 * call. Quotation marks, em dashes and emoji are counted as neutral facts (persona may use them),
 * so a non-zero count is not an error. `writtenStyleHints` lists written-style words that actually
 * occur — it is a hint, not a verdict. The `voice.spoken.lint` event carries counts + hint words
 * only: it must never log the spoken text itself.
 *
 * Run: node --test test/spoken-lint.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

import { spokenLint } from '../src/host/shared/text.js';

const indexSource = await readFile(new URL('../src/host/index.js', import.meta.url), 'utf8');
const textSource = await readFile(new URL('../src/host/shared/text.js', import.meta.url), 'utf8');

const LINT_FIELDS = [
  'copyRisk', 'emDashes', 'emoji', 'longestSentence',
  'maxSentenceChars', 'quoteMarks', 'sentences', 'writtenStyleHints',
].sort();

// ---------------------------------------------------------------------------
// 1. Long sentence / quotes / em dash / emoji / copyRisk counts
// ---------------------------------------------------------------------------
test('1. 长句/引号/破折号/emoji/copyRisk 计数正确', (t) => {
  const long = '这'.repeat(90);
  const text = `${long}。“引用”他说——真的吗？😀`;
  const lint = spokenLint(text, { bodyChars: 100 });

  assert.equal(lint.sentences, 3, 'two punctuation sentences plus the emoji tail');
  assert.equal(lint.maxSentenceChars, 91, 'the 90-char sentence plus its terminator');
  assert.equal([...lint.longestSentence].length, 80, 'longestSentence is truncated to 80 code points');
  assert.equal(lint.longestSentence, '这'.repeat(80), 'the truncated value is the first 80 chars');
  assert.equal(lint.quoteMarks, 2, '“ and ” are both counted');
  assert.equal(lint.emDashes, 1, 'a Chinese —— is one em-dash run');
  assert.equal(lint.emoji, 1, 'one emoji code point');
  assert.deepEqual(lint.writtenStyleHints, [], 'no written-style word occurs');
  assert.equal(lint.copyRisk, true, '104 spoken chars / 100 body chars ≥ 0.95');
  assert.deepEqual(Object.keys(lint).sort(), LINT_FIELDS);
  t.diagnostic(`sentences=${lint.sentences} max=${lint.maxSentenceChars} longest=${[...lint.longestSentence].length} copyRisk=${lint.copyRisk}`);
});

// ---------------------------------------------------------------------------
// 2. No hits: every count is 0 and copyRisk is false
// ---------------------------------------------------------------------------
test('2. 无命中时全 0，copyRisk 不误报', (t) => {
  const lint = spokenLint('明天会下雨。记得带伞。', { bodyChars: 1000 });
  assert.deepEqual(lint, {
    sentences: 2,
    maxSentenceChars: 6,
    longestSentence: '明天会下雨。',
    quoteMarks: 0,
    emDashes: 0,
    emoji: 0,
    writtenStyleHints: [],
    copyRisk: false,
  });
  t.diagnostic(`max=${lint.maxSentenceChars} copyRisk=${lint.copyRisk} hints=${lint.writtenStyleHints.length}`);
});

// ---------------------------------------------------------------------------
// 3. writtenStyleHints: only words that actually occur, in fixed order
// ---------------------------------------------------------------------------
test('3. writtenStyleHints 只列实际出现的书面词，旧字段名 bannedTerms 不存在', (t) => {
  const lint = spokenLint('这种言外之意像一把尺子，铺垫和调味料都太满，CP感也刻意，扎心。');
  assert.deepEqual(lint.writtenStyleHints, [
    '言外之意', '尺子', '铺垫', '调味料', 'CP感', '扎心',
  ]);
  assert.equal('bannedTerms' in lint, false, 'the field is a hint list, not a ban list');
  assert.deepEqual(spokenLint('普通的说法。').writtenStyleHints, []);
  assert.ok(!textSource.includes('bannedTerms'), 'the source never uses the old bannedTerms name');
  t.diagnostic(`hints=${lint.writtenStyleHints.join(',')}`);
});

// ---------------------------------------------------------------------------
// 4. Read-only: the input text is untouched and no text is returned
// ---------------------------------------------------------------------------
test('4. lint 只读：不修改输入，也不返回正文', (t) => {
  const value = '“引用”——😀';
  const snapshot = value;
  const lint = spokenLint(value, { bodyChars: 10 });
  assert.equal(value, snapshot, 'the input string is unchanged');
  assert.ok(!Object.hasOwn(lint, 'text'), 'no text field is returned');
  assert.deepEqual(Object.keys(lint).sort(), LINT_FIELDS);
  assert.equal(lint.quoteMarks, 2);
  assert.equal(lint.emDashes, 1);
  assert.equal(lint.emoji, 1);
  // Non-zero presentation counts are observations, never failures.
  assert.ok(lint.quoteMarks > 0 && lint.emDashes > 0 && lint.emoji > 0,
    'persona may legitimately use these; the lint does not require zero');
  t.diagnostic(`inputUnchanged=yes fields=${Object.keys(lint).length} quote=${lint.quoteMarks} dash=${lint.emDashes} emoji=${lint.emoji}`);
});

// ---------------------------------------------------------------------------
// 5. copyRisk threshold: 95% is risky, 94% is not, no bodyChars means unmeasured
// ---------------------------------------------------------------------------
test('5. copyRisk 以正文长度 95% 为界，缺 bodyChars 时为 false', (t) => {
  const at95 = spokenLint('字'.repeat(95), { bodyChars: 100 });
  assert.equal(at95.copyRisk, true, '95/100 is at the threshold');
  const at94 = spokenLint('字'.repeat(94), { bodyChars: 100 });
  assert.equal(at94.copyRisk, false, '94/100 is below the threshold');
  assert.equal(spokenLint('字'.repeat(95)).copyRisk, false, 'unmeasured is false, not a guess');
  t.diagnostic(`95%=${at95.copyRisk} 94%=${at94.copyRisk} unmeasured=${spokenLint('字'.repeat(95)).copyRisk}`);
});

// ---------------------------------------------------------------------------
// 6. The event row carries counts/hints only — never the spoken text
// ---------------------------------------------------------------------------
test('6. voice.spoken.lint 事件字段齐全且不记录正文（源码断言）', (t) => {
  const start = indexSource.indexOf("log.emit('voice.spoken.lint'");
  assert.notEqual(start, -1, 'the event is emitted');
  const end = indexSource.indexOf('.catch(', start);
  assert.notEqual(end, -1, 'the emit has a catch');
  const block = indexSource.slice(start, end);
  for (const field of [
    'turn', 'maxSentenceChars', 'quoteMarks', 'emDashes', 'emoji', 'writtenStyleHints', 'copyRisk',
  ]) {
    assert.ok(block.includes(`${field}:`), `event field "${field}" is present`);
  }
  assert.ok(!/\btext\s*:/u.test(block), 'the event has no text field');
  assert.ok(!block.includes('spokenText'), 'the event never logs spokenText');
  assert.ok(!block.includes('bannedTerms'), 'the event uses writtenStyleHints, not bannedTerms');

  // One emission per successful generation path: typed, whole-answer and streamed.
  const calls = indexSource.match(/emitSpokenLint\(\{/gu) ?? [];
  assert.equal(calls.length, 3, 'typed + whole-answer + streamed success paths are wired');
  t.diagnostic(`fields=7 calls=${calls.length} textLogged=no`);
});
