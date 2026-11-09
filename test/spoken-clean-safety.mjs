/**
 * P2 regression: read-aloud cleanup must protect substance before it removes presentation.
 *
 * Order of operations under test:
 *   1. fenced/inline code is protected first (only fences/backticks go, every inner character
 *      stays: spaces, `--`, underscores, paths, versions);
 *   2. identifiers (`__debug__`, `_x`, `foo_bar`, `snake_case`, `--flag`) are never rewritten by
 *      Markdown emphasis rules;
 *   3. only explicitly paired asterisk emphasis and quotation/title wrappers are removed, with
 *      their content kept;
 *   4. emoji/decorative symbols are the only symbols deleted — letters, digits, units, minus and
 *      range signs survive;
 *   5. a substantive-token comparison gates the result. If cleanup would lose or change content
 *      (for example `_debug_` collapsing to `debug`), `normalizeSpokenVersion` returns
 *      `{ok:false, reason:'unsafe-cleanup', text:原文}` and never adopts the damaged text.
 *
 * Run: node --test test/spoken-clean-safety.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeSpokenVersion } from '../src/host/shared/text.js';

/** Long enough that shape checks (not-shorter) never mask a cleanup result. */
const SOURCE = '这是一段足够长的正文，用来作为朗读版本长度与内容校验的基准。'.repeat(3);
const BT = '`';
const FENCE = BT.repeat(3);
const fenced = (body, info = '') => [FENCE + info, body, FENCE].join('\n');

// ---------------------------------------------------------------------------
// 1. The two reported probes: a fenced command and an identifier pair
// ---------------------------------------------------------------------------
test('1. 探针：围栏代码命令与标识符都保留，清理不再删内容', (t) => {
  // Probe 1: ```cleanup --dry-run``` used to be deleted with its restriction clause.
  const codeLine = `${FENCE}cleanup --dry-run${FENCE}`;
  const command = normalizeSpokenVersion(SOURCE, `执行前先备份，${codeLine}只能在测试目录运行。`);
  assert.equal(command.ok, true, 'the code-carrying candidate is safe to adopt');
  assert.ok(command.text.includes('cleanup --dry-run'), 'the fenced command survives');
  assert.ok(command.text.includes('只能在测试目录运行'), 'the restriction condition survives');
  assert.ok(!command.text.includes(BT), 'only the fence markers are removed');

  // Probe 2: __debug__ and debug used to collapse into the same word.
  const identifiers = normalizeSpokenVersion(SOURCE, '设置 __debug__，不要设置 debug。');
  assert.equal(identifiers.ok, true, 'the identifier pair is safe to adopt');
  assert.ok(identifiers.text.includes('__debug__'), 'the underscored identifier keeps its underscores');
  assert.ok(identifiers.text.includes('debug'), 'the plain identifier is still present');
  assert.notEqual(identifiers.text, '设置 debug，不要设置 debug。', 'the two identifiers never collapse');
  assert.ok(
    identifiers.text.indexOf('__debug__') < identifiers.text.lastIndexOf('debug'),
    'both occurrences stay in their original order',
  );
  t.diagnostic(`probe1="${command.text}" probe2="${identifiers.text}"`);
});

// ---------------------------------------------------------------------------
// 2. Normal presentation cleanup still works: emphasis / quotes / em dash / emoji
// ---------------------------------------------------------------------------
test('2. 正常清理：明确成对的强调、引号、书名号、破折号停顿与 emoji', (t) => {
  const marked = normalizeSpokenVersion(SOURCE, '**重点**：“明天——有雨☔️。”');
  assert.equal(marked.ok, true);
  assert.equal(marked.text, '重点：明天，有雨。', 'markers go, content stays, prose em dash becomes a pause');
  assert.ok(marked.text.includes('重点') && marked.text.includes('有雨'), 'content words survive');

  const quoted = normalizeSpokenVersion(SOURCE, '读`三体`，别读《活着》，“活着”最好。');
  assert.equal(quoted.ok, true);
  assert.equal(quoted.text, '读三体，别读活着，活着最好。', 'backticks and all quote/title wrappers are presentation');
  assert.ok(quoted.text.includes('三体') && quoted.text.includes('活着'), 'the referenced titles stay');

  // A single-underscore pair is still a harmless emphasis wrapper when nothing word-like changes.
  const underscore = normalizeSpokenVersion(SOURCE, '_重点_是备份，不是删除。');
  assert.equal(underscore.ok, true, 'underscore emphasis around CJK is safely cleaned');
  assert.equal(underscore.text, '重点是备份，不是删除。');

  // Decorative stars/music notes disappear; content words do not.
  const decorated = normalizeSpokenVersion(SOURCE, '★已完成★，♪下一项。');
  assert.equal(decorated.ok, true);
  assert.equal(decorated.text, '已完成，下一项。');
  t.diagnostic(`marked="${marked.text}" quoted="${quoted.text}" underscore="${underscore.text}" decorated="${decorated.text}"`);
});

// ---------------------------------------------------------------------------
// 3. Code is protected first: all inner characters survive, including spaces
// ---------------------------------------------------------------------------
test('3. 代码块/内联代码内部字符（空格、--、下划线、路径、版本）逐字保留', (t) => {
  const inline = normalizeSpokenVersion(
    SOURCE,
    '路径 `C:\\work\\a_b`，版本 `v1.2.3`，标志 `--dry-run`，代码 `a  b`。',
  );
  assert.equal(inline.ok, true);
  assert.ok(inline.text.includes('C:\\work\\a_b'), 'the Windows path is unchanged');
  assert.ok(inline.text.includes('v1.2.3'), 'the version is unchanged');
  assert.ok(inline.text.includes('--dry-run'), 'the CLI flag is unchanged');
  assert.ok(inline.text.includes('a  b'), 'double spaces inside code are preserved');

  const codeLine = '  cd /srv/app_v1 && run --dry-run -5 10—20';
  const block = normalizeSpokenVersion(
    SOURCE,
    `执行前先备份：\n${fenced(codeLine, 'bash')}\n只能在测试目录运行。`,
  );
  assert.equal(block.ok, true);
  assert.ok(block.text.includes(codeLine), 'the fenced body, including indentation, is kept verbatim');
  assert.ok(!block.text.includes('bash'), 'only the fence info word is dropped');
  assert.ok(block.text.includes('只能在测试目录运行'), 'text after the block is kept');

  // A body with no letters/digits is still protected by the placeholder-integrity check.
  const symbolsOnly = normalizeSpokenVersion(SOURCE, `${fenced('--')}保留`);
  assert.equal(symbolsOnly.ok, true);
  assert.ok(symbolsOnly.text.includes('--'), 'symbol-only code is not swallowed');

  // An unterminated fence must still keep its body instead of deleting the rest of the reply.
  const unclosed = normalizeSpokenVersion(SOURCE, `${FENCE}\ncleanup --dry-run\n只能在测试目录运行。`);
  assert.equal(unclosed.ok, true, `unclosed fence stays content-preserving: ${unclosed.reason}`);
  assert.ok(unclosed.text.includes('cleanup --dry-run'), 'the unclosed code body survives');
  assert.ok(unclosed.text.includes('只能在测试目录运行'), 'the following sentence survives');
  t.diagnostic(`inline="${inline.text}" block="${block.text}" symbols="${symbolsOnly.text}" unclosed="${unclosed.text}"`);
});

// ---------------------------------------------------------------------------
// 4. Identifier protection: underscores, flags, paths and versions are not emphasis
// ---------------------------------------------------------------------------
test('4. 标识符保护：__debug__/_x/foo_bar/snake_case/--flag/路径/版本不被强调规则改写', (t) => {
  const candidate = '设置 __debug__ 和 _x，保留 foo_bar、snake_case，按 --flag 跑 /tmp/demo_v1，版本 v1.2.3。';
  const protectedText = normalizeSpokenVersion(SOURCE, candidate);
  assert.equal(protectedText.ok, true, `identifier candidate is safe: ${protectedText.reason}`);
  for (const fragment of ['__debug__', '_x', 'foo_bar', 'snake_case', '--flag', '/tmp/demo_v1', 'v1.2.3']) {
    assert.ok(protectedText.text.includes(fragment), `identifier "${fragment}" is unchanged`);
  }

  // `__...__` is deliberately left alone rather than guessed to be Markdown bold.
  const doubleUnderscore = normalizeSpokenVersion(SOURCE, '保留 __重点__ 的下划线。');
  assert.equal(doubleUnderscore.ok, true);
  assert.ok(doubleUnderscore.text.includes('__重点__'), 'double-underscore pairs keep their underscores');
  t.diagnostic(`text="${protectedText.text}" doubleUnderscore="${doubleUnderscore.text}"`);
});

// ---------------------------------------------------------------------------
// 5. Symbols: only emoji/decoration go; units, minus and range signs stay
// ---------------------------------------------------------------------------
test('5. 符号清理不误删单位/负号/范围符/乘法星号', (t) => {
  const units = normalizeSpokenVersion(SOURCE, '温度 25℃（±2℃），最低 -5℃，范围 10—20℃，面积 15㎡。');
  assert.equal(units.ok, true);
  for (const fragment of ['25℃', '±2℃', '-5℃', '10—20℃', '15㎡']) {
    assert.ok(units.text.includes(fragment), `unit/range fragment "${fragment}" survives`);
  }

  // `2 * 3 * 4` is arithmetic, not Markdown emphasis: the asterisks are kept.
  const multiply = normalizeSpokenVersion(SOURCE, '2 * 3 * 4 等于 24。');
  assert.equal(multiply.ok, true);
  assert.ok(multiply.text.includes('2 * 3 * 4'), 'space-padded asterisks are not emphasis');
  t.diagnostic(`units="${units.text}" multiply="${multiply.text}"`);
});

// ---------------------------------------------------------------------------
// 6. Unsafe cleanup is refused, never adopted: `_debug_` would become a different word
// ---------------------------------------------------------------------------
test('6. 清理会改变标识符时 normalize 返回 unsafe-cleanup，不 ok、不采用被破坏文本', (t) => {
  const candidate = '设置 _debug_，不要设置 debug。';
  const result = normalizeSpokenVersion(SOURCE, candidate);
  assert.equal(result.ok, false, 'a lossy cleanup is not adopted');
  assert.equal(result.reason, 'unsafe-cleanup', 'the refusal is reported as unsafe-cleanup');
  // `_debug_` -> `debug` would make the two identifiers identical; the un-cleaned text is returned.
  assert.ok(result.text.includes('_debug_'), 'the returned text keeps the underscored identifier');
  assert.notEqual(result.text, '设置 debug，不要设置 debug。', 'the damaged text is never returned');
  t.diagnostic(`ok=${result.ok} reason=${result.reason} text="${result.text}"`);
});

// ---------------------------------------------------------------------------
// 7. A cleanup failure never turns into a silent success via the length checks
// ---------------------------------------------------------------------------
test('7. unsafe 先于长度/前言判断：短候选也不会绕过安全检查', (t) => {
  // The damaged form would be short enough and start with a normal sentence; the safety gate
  // must still win before any shape acceptance.
  const result = normalizeSpokenVersion(SOURCE, '_debug_。');
  assert.equal(result.ok, false, 'a short lossy candidate is refused');
  assert.equal(result.reason, 'unsafe-cleanup');
  assert.ok(result.text.includes('_debug_'), 'the original candidate text is returned');
  t.diagnostic(`reason=${result.reason} chars=${result.chars} text="${result.text}"`);
});
