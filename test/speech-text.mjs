/**
 * Speech/caption text derivation: structure-aware Markdown cleaning for TTS and subtitles.
 *
 * The module is not wired into the host yet; these tests pin the contract only.
 *
 * Run: node --test test/speech-text.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ensurePlain,
  formatMessage,
  looksUnbalanced,
  parse,
  takeResiduals,
  toCaptionText,
  toSpeechText,
} from '../src/host/speech/speech-text.js';

test('1. bold markers are removed for speech and caption', () => {
  assert.equal(toSpeechText('**重要**'), '重要');
  assert.equal(toCaptionText('**重要**'), '重要');
  assert.equal(toSpeechText('*斜体* 和 __强调__'), '斜体 和 强调');
  assert.equal(toCaptionText('*斜体* 和 __强调__'), '斜体 和 强调');

  // a pair closed right before a word is still a pair (`**a**b` is Markdown for bold `a`, `b`)
  assert.equal(toSpeechText('**a**b'), 'ab');
  assert.equal(looksUnbalanced('**a**b'), false);
});

test('2. headings, quotes and lists lose their markers but keep pauses and line breaks', () => {
  // heading: marker gone, speech adds the closing pause, caption only the text
  assert.equal(toSpeechText('# 标题'), '标题。');
  assert.equal(toCaptionText('# 标题'), '标题');

  // quote: marker gone on both outputs
  assert.equal(toSpeechText('> 引用内容'), '引用内容');
  assert.equal(toCaptionText('> 引用内容'), '引用内容');

  // list: speech joins items with pauses, caption keeps one line per item
  assert.equal(toSpeechText('- 第一项\n- 第二项'), '第一项；第二项。');
  assert.equal(toCaptionText('- 第一项\n- 第二项'), '第一项\n第二项');
  assert.equal(toSpeechText('1. 第一步\n2. 第二步'), '第一步；第二步。');
});

test('3. links read their label only; the target is opt-in', () => {
  const link = '[说明](https://x)';
  assert.equal(toSpeechText(link), '说明', 'speech never spells the URL out by default');
  assert.equal(toCaptionText(link), '说明', 'a clean subtitle keeps the label only by default');
  assert.equal(toCaptionText(link, { links: 'text-only' }), '说明');
  assert.equal(toCaptionText(link, { links: 'with-url' }), '说明（https://x）', 'the target stays opt-in');
  assert.equal(toSpeechText(link, { links: 'read-url' }), '说明（https://x）');

  // an image keeps its alt text and never reads its target
  const image = '![图](https://x/y.png)';
  assert.equal(toSpeechText(image), '图');
  assert.equal(toCaptionText(image), '图');
  assert.equal(toCaptionText(image, { links: 'with-url' }), '图');

  // a bare long URL is not spelled out by default; the caption keeps it verbatim
  const bare = '详见 https://example.com/very/long/path';
  assert.equal(toSpeechText(bare), '详见');
  assert.equal(toCaptionText(bare), bare);
  assert.equal(toSpeechText(bare, { links: 'read-url' }), bare);
});

test('4. inline code loses its backticks but keeps its content', () => {
  const source = '运行 `npm test` 即可';
  assert.equal(toSpeechText(source), '运行 npm test 即可');
  assert.equal(toCaptionText(source), '运行 npm test 即可');
});

test('5. tables become ordered speech text and row-per-line captions', () => {
  const table = ['| 姓名 | 年龄 |', '| --- | --- |', '| 张三 | 30 |'].join('\n');
  assert.equal(toSpeechText(table), '姓名：张三；年龄：30', 'no pipes are spoken');
  assert.deepEqual(toCaptionText(table).split('\n'), ['姓名，年龄', '张三，30']);

  // the same table's header names are what the speech renderer uses as labels
  const twoRows = ['| 城市 | 温度 |', '| --- | --- |', '| 北京 | 12 |', '| 上海 | 18 |'].join('\n');
  assert.equal(toSpeechText(twoRows), '城市：北京；温度：12\n城市：上海；温度：18');
});

test('6. fenced code is skipped for speech by default and read-first-line on request', () => {
  const code = ['```js', 'const a = 1;', 'console.log(a);', '```'].join('\n');
  assert.equal(toSpeechText(code), '', 'default skip: nothing to read');
  assert.equal(toSpeechText(code, { codeBlocks: 'read-first-line' }), 'const a = 1;');
  assert.equal(toCaptionText(code), 'const a = 1;\nconsole.log(a);', 'fences removed, body kept');

  const onlyLang = '```text\n```';
  assert.equal(toSpeechText(onlyLang), '');
  assert.equal(toCaptionText(onlyLang), '');
});

test('7. syntax-like characters in ordinary text are preserved exactly', () => {
  // mid-sentence: arithmetic, negative numbers, dates, money, identifiers, hyphenation
  const sentence = 'C# 与 2*3、-5、2026-11-05、$3.50、file_name.py、a-b 都保留。';
  assert.equal(toSpeechText(sentence), sentence);
  assert.equal(toCaptionText(sentence), sentence);

  // line-leading shapes must not be mistaken for headings/lists/thematic breaks either
  const lines = ['C#', '2*3', '-5', '2026-11-05', '$3.50', 'file_name.py', 'a-b'].join('\n');
  assert.equal(toSpeechText(lines), lines);
  assert.equal(toCaptionText(lines), lines);
});

test('8. an unclosed marker keeps the original text and is reported', () => {
  const partial = '**未闭合';
  assert.equal(toSpeechText(partial), partial, 'nothing is cleaned before the closer arrives');
  assert.equal(toCaptionText(partial), partial);
  assert.equal(looksUnbalanced(partial), true);

  assert.equal(looksUnbalanced('**重要**'), false, 'a complete pair is balanced');
  assert.equal(looksUnbalanced('C# 2*3 -5'), false, 'ordinary characters are not delimiters');
  assert.equal(looksUnbalanced('`code'), true, 'an open code span waits for its close');
  assert.equal(looksUnbalanced('```js\nconst a = 1;'), true, 'an open fence waits for its close');
  assert.equal(looksUnbalanced('[说明](https://x'), true, 'an open link target waits for its close');
  assert.equal(looksUnbalanced(''), false);
});

test('9. mixed Chinese/English text keeps every punctuation mark', () => {
  const source = '我们用 **Node.js** 写了一个 CLI，速度提升 2*3 倍；如果不满足条件，就不要执行，结果见 `README.md`。';
  const expected = '我们用 Node.js 写了一个 CLI，速度提升 2*3 倍；如果不满足条件，就不要执行，结果见 README.md。';
  assert.equal(toSpeechText(source), expected);
  assert.equal(toCaptionText(source), expected);
  assert.ok(expected.includes('，') && expected.includes('；') && expected.includes('。'));
});

test('10. a long reply keeps sentence order and stays readable', () => {
  const lines = Array.from({ length: 24 }, (_, index) => `第${index + 1}段：这是第${index + 1}句完整的话。`);
  const source = lines.join('\n\n');

  const speech = toSpeechText(source);
  const caption = toCaptionText(source);

  assert.deepEqual(speech.split('\n'), lines, 'one line per paragraph, original order');
  assert.deepEqual(caption.split('\n\n'), lines, 'paragraph breaks preserved');
  assert.equal(speech.split('\n').length, 24, 'paragraphs are not merged away');
});

test('11. plain text without Markdown round-trips unchanged', () => {
  const single = '明天上午 9:30 在 3 楼会议室见，带上 a-b 方案和 $3.50 的报价。';
  assert.equal(toSpeechText(single), single);
  assert.equal(toCaptionText(single), single);

  const multi = '第一行没有标记\n第二行也没有';
  assert.equal(toSpeechText(multi), multi);
  assert.equal(toCaptionText(multi), multi);

  assert.equal(parse(single).blocks.length, 1, 'plain text stays one paragraph');
});

test('12. one parse feeds both renderers', () => {
  const markdown = '# 标题\n\n用 **加粗** 和 [链接](https://example.com/a) 以及 `code`。';
  let calls = 0;
  const seen = [];
  const result = formatMessage(markdown, {
    parse: (text) => {
      calls += 1;
      seen.push(text);
      return parse(text);
    },
  });

  assert.equal(calls, 1, 'exactly one parse for speech and caption');
  assert.deepEqual(seen, [markdown]);
  assert.equal(result.speech, toSpeechText(markdown), 'speech is the same as the single-output call');
  assert.equal(result.caption, toCaptionText(markdown), 'caption is the same as the single-output call');

  // a caller that already has the tree can render both forms without parsing again
  const document = parse(markdown);
  assert.equal(toSpeechText(document), result.speech);
  assert.equal(toCaptionText(document), result.caption);
});

test('13. empty and whitespace-only input produces empty output', () => {
  for (const source of ['', '   ', '\n\n\t', ' \r\n ']) {
    assert.equal(toSpeechText(source), '');
    assert.equal(toCaptionText(source), '');
  }
  assert.deepEqual(parse('').blocks, []);
  assert.equal(formatMessage('  \n ').speech, '');
  assert.equal(looksUnbalanced('   '), false);
});

test('14. captions keep line breaks while speech never keeps a blank line', () => {
  const source = '第一段。\n\n第二段。\n\n\n第三段。';
  assert.equal(toSpeechText(source), '第一段。\n第二段。\n第三段。');
  assert.equal(toCaptionText(source), '第一段。\n\n第二段。\n\n第三段。');
  assert.ok(!toSpeechText(source).includes('\n\n'), 'speech has no empty lines');

  const heading = '# 标题\n正文内容';
  assert.equal(toCaptionText(heading), '标题\n\n正文内容', 'caption keeps the heading on its own line');
  assert.equal(toSpeechText(heading), '标题。\n正文内容');
});

test('15. table rows lose every pipe; separator rows disappear and content order is kept', () => {
  const table = ['| 姓名 | 年龄 |', '|:---|---:|', '| 张三 | 30 |', '| 李四 | 25 |'].join('\n');
  assert.equal(toSpeechText(table), '姓名：张三；年龄：30\n姓名：李四；年龄：25');
  assert.deepEqual(toCaptionText(table).split('\n'), ['姓名，年龄', '张三，30', '李四，25']);
  for (const output of [toSpeechText(table), toCaptionText(table)]) {
    assert.ok(!output.includes('|'), `no pipe survives: ${output}`);
    assert.ok(!output.includes('---'), 'the separator row is gone');
  }

  // a streamed header-only fragment (the separator has not arrived yet) is cleaned too
  assert.equal(toCaptionText('| a | b |'), 'a，b');
  assert.equal(toSpeechText('| a | b |'), 'a，b');

  // a separator row with no header is table syntax, not content
  assert.equal(toCaptionText('|---|---|'), '');
  assert.equal(toSpeechText('|---|---|'), '');
});

test('16. bold, italic, strikethrough and inline code lose markers but keep text', () => {
  const source = '**加粗**、__加粗__、*斜体*、_斜体_、~~删除~~、`code`。';
  const expected = '加粗、加粗、斜体、斜体、删除、code。';
  assert.equal(toSpeechText(source), expected);
  assert.equal(toCaptionText(source), expected);
  assert.equal(looksUnbalanced(source), false);
});

test('17. heading, quote, list, fence and thematic-break markers are removed', () => {
  assert.equal(toSpeechText('# 标题'), '标题。');
  assert.equal(toCaptionText('# 标题'), '标题');
  assert.equal(toSpeechText('> 引用'), '引用');
  assert.equal(toCaptionText('- 列表'), '列表');
  assert.equal(toCaptionText('1. 有序'), '有序');
  assert.equal(toCaptionText('- [ ] 任务'), '任务', 'a task-list checkbox is a marker, not content');

  const fence = ['```js', 'const a = 1;', '```'].join('\n');
  assert.equal(toCaptionText(fence), 'const a = 1;', 'fences removed, body kept');
  assert.equal(toSpeechText(fence, { codeBlocks: 'read-first-line' }), 'const a = 1;');

  assert.equal(toCaptionText('前\n\n---\n\n后'), '前\n\n后', 'a horizontal rule is an empty line');
  assert.equal(toSpeechText('前\n\n---\n\n后'), '前\n后');
  assert.equal(toCaptionText('前\n\n***\n\n后'), '前\n\n后');
});

test('18. HTML tags are dropped and their text is kept', () => {
  assert.equal(toSpeechText('<b>加粗</b>'), '加粗');
  assert.equal(toCaptionText('<b>加粗</b>'), '加粗');
  assert.equal(toCaptionText('<p>第一段</p><p>第二段</p>'), '第一段\n\n第二段');
  assert.equal(toSpeechText('<p>第一段</p><p>第二段</p>'), '第一段\n第二段');
  assert.equal(toCaptionText('<!-- 注释 -->可见'), '可见');
  assert.equal(toCaptionText('a < b'), 'a < b', 'a lone < is not a tag');
  assert.ok(!looksUnbalanced('<div>块</div>'));
});

test('19. a table mixed with paragraphs keeps order and leaves no Markdown markers', () => {
  const source = [
    '开头说明：',
    '',
    '| 项目 | 状态 |',
    '|---|---|',
    '| 构建 | **通过** |',
    '| 测试 | `ok` |',
    '',
    '结尾段落。[链接](https://x)',
  ].join('\n');
  const speech = toSpeechText(source);
  const caption = toCaptionText(source);

  assert.equal(speech, '开头说明：\n项目：构建；状态：通过\n项目：测试；状态：ok\n结尾段落。链接');
  assert.equal(caption, '开头说明：\n\n项目，状态\n构建，通过\n测试，ok\n\n结尾段落。链接');
  for (const output of [speech, caption]) {
    for (const marker of ['|', '---', '**', '`', '](', '#']) {
      assert.ok(!output.includes(marker), `"${marker}" must not survive: ${JSON.stringify(output)}`);
    }
  }
});

test('20. syntax-like ordinary text survives the wider cleaning', () => {
  const sentence = 'C#、2*3、-5、2026-11-05、$3.50、file_name.py、a-b、10~20。';
  assert.equal(toSpeechText(sentence), sentence);
  assert.equal(toCaptionText(sentence), sentence);
  assert.equal(toSpeechText('C# 2*3 -5'), 'C# 2*3 -5');
  assert.equal(toCaptionText('C# 2*3 -5'), 'C# 2*3 -5');

  assert.equal(looksUnbalanced('~~未闭合'), true, 'an open strikethrough waits for its close');
  assert.equal(looksUnbalanced('10~20 与 ~/.bashrc'), false, 'single tildes are not delimiters');
});

// ---------------------------------------------------------------------------
// Zero-Markdown guarantee: formats nobody enumerated, not just the known ones
// ---------------------------------------------------------------------------

/** Markers no rendered lane may carry, whatever produced them. */
const CONTROL_SHAPES = [
  [/^ {0,3}(?:#{1,6}[ \t]+|>[ \t]?|(?:[-*+]|\d{1,9}[.)])[ \t]+)/mu, 'a line-leading marker'],
  [/\*\*|__|~~|==/u, 'a paired delimiter'],
  [/`/u, 'a backtick'],
  [/\|/u, 'a table pipe'],
  [/<\/?[A-Za-z][^>]*>|<!--|<https?:\/\//u, 'a tag, comment or autolink'],
  [/!?\[[^\]\n]*\]\([^)\n]*\)/u, 'an inline link'],
  [/\[[^\]\n]+\]\[[^\]\n]*\]/u, 'a reference link'],
  [/\[\^[^\]\n]+\]/u, 'a footnote reference'],
  [/\[![A-Za-z][^\]]*\]/u, 'a callout label'],
  [/\\[\\`*_{}[\]()#+\-.!>~|]/u, 'an escape sequence'],
];

function assertNoMarkdown(label, output) {
  for (const [shape, description] of CONTROL_SHAPES) {
    assert.ok(!shape.test(output), `${label}: ${description} survives in ${JSON.stringify(output)}`);
  }
}

/**
 * One row per structural family, not per known implementation detail. The expected strings are
 * the full output, so they also assert that the words keep their original order.
 */
const CORPUS = [
  ['heading (#)', '# 标题\n正文', '标题。\n正文', '标题\n\n正文'],
  ['heading (setext)', '标题\n====', '标题。', '标题'],
  ['quote', '> 引用内容', '引用内容', '引用内容'],
  ['quote with callout', '> [!NOTE]\n> 注意事项', '注意事项', '注意事项'],
  ['unordered list', '- 第一项\n- 第二项', '第一项；第二项。', '第一项\n第二项'],
  ['ordered list', '1. 第一步\n2. 第二步', '第一步；第二步。', '第一步\n第二步'],
  ['task list', '- [ ] 任务一\n- [x] 任务二', '任务一；任务二。', '任务一\n任务二'],
  ['definition list', '术语\n: 定义', '术语\n定义', '术语\n\n定义'],
  ['table with separator', '| 姓名 | 年龄 |\n|:---|---:|\n| 张三 | 30 |', '姓名：张三；年龄：30', '姓名，年龄\n张三，30'],
  ['table without separator', '| a | b |\n| c | d |', 'a：c；b：d', 'a，b\nc，d'],
  ['fenced code with language', '```js\nconst a = 1;\n```', '', 'const a = 1;'],
  ['indented code', '    缩进代码', '', '缩进代码'],
  ['inline code', '运行 `npm test` 即可', '运行 npm test 即可', '运行 npm test 即可'],
  ['bold', '**加粗**', '加粗', '加粗'],
  ['italic', '*斜体*', '斜体', '斜体'],
  ['strikethrough', '~~删除~~', '删除', '删除'],
  ['nested emphasis', '~~**删除加粗**~~', '删除加粗', '删除加粗'],
  ['triple emphasis', '***三重强调***', '三重强调', '三重强调'],
  ['inline link', '[说明](https://x)', '说明', '说明'],
  ['reference link', '[文字][ref]\n\n[ref]: https://x', '文字', '文字'],
  ['autolink', '<https://x>', '', 'https://x'],
  ['image', '![图](https://x/y.png)', '图', '图'],
  ['footnote', '正文[^1]\n\n[^1]: 脚注内容', '正文\n脚注内容', '正文\n\n脚注内容'],
  ['horizontal rule', '前\n\n---\n\n后', '前\n后', '前\n\n后'],
  ['HTML tag and comment', '<b>加粗</b><!-- 注释 -->可见', '加粗可见', '加粗可见'],
  ['escaped marker', '转义字符 \\*', '转义字符 *', '转义字符 *'],
  ['inline math', '行内 $x$', '行内 $x$', '行内 $x$'],
  ['underscore emphasis', '_下划线_', '下划线', '下划线'],
  ['superscript', '^上标^', '上标', '上标'],
  ['emoji shortcode', ':smile:', ':smile:', ':smile:'],
  ['HTML entity', '&amp;', '&', '&'],
  ['deep nested quote', '>>> 嵌套引用', '嵌套引用', '嵌套引用'],
];

function assertOrder(label, output, words) {
  let at = -1;
  for (const word of words) {
    const found = output.indexOf(word, at + 1);
    assert.ok(found > at, `${label}: "${word}" is missing or out of order in ${JSON.stringify(output)}`);
    at = found;
  }
}

test('21. corpus matrix: every Markdown family loses its markers and keeps its words in order', () => {
  for (const [name, source, expectedSpeech, expectedCaption] of CORPUS) {
    const speech = toSpeechText(source);
    const caption = toCaptionText(source);
    assert.equal(speech, expectedSpeech, `${name}: speech`);
    assert.equal(caption, expectedCaption, `${name}: caption`);
    assertNoMarkdown(`${name}: speech`, speech);
    assertNoMarkdown(`${name}: caption`, caption);
    // Exact equality implies order; this keeps the intent visible for future readers.
    assertOrder(`${name}: speech`, speech, expectedSpeech.split(/[；。\n]+/u).filter(Boolean));
    assertOrder(`${name}: caption`, caption, expectedCaption.split(/[，\n]+/u).filter(Boolean));
  }
});

test('22. an unsupported/incomplete construct is recorded, never silently passed', () => {
  takeResiduals(); // events from earlier tests (an unclosed marker) are not this case's evidence
  const source = '>>> 嵌套引用 **未闭合';
  assert.equal(toSpeechText(source), '嵌套引用 **未闭合', 'the supported quote is cleaned; the unclosed pair stays');
  assert.equal(toCaptionText(source), '嵌套引用 **未闭合');

  const events = takeResiduals();
  const residual = events.find((event) => event.type === 'speech-text.residual');
  assert.ok(residual, `expected speech-text.residual, got ${JSON.stringify(events)}`);
  assert.equal(residual.kind, 'emphasis', 'the event names the shape that reached the fallback');
  assert.ok(residual.sample.includes('**未闭合'), `sample keeps the offending text: ${residual.sample}`);
  assert.ok(residual.sample.length <= 40, 'the sample is truncated to 40 characters');

  // Deep quote nesting is supported, so it needs no fallback at all.
  takeResiduals();
  assert.equal(toSpeechText('>>> 嵌套引用'), '嵌套引用');
  assert.deepEqual(takeResiduals(), [], 'a supported shape records nothing');

  // An unknown structure the cleaner must not guess at (an unclosed comment could still be
  // streaming) also stays visible and is recorded, rather than disappearing silently.
  takeResiduals();
  assert.equal(toSpeechText('<!-- 未闭合注释'), '<!-- 未闭合注释');
  const unknown = takeResiduals().find((event) => event.kind === 'html');
  assert.ok(unknown, 'an unsupported block structure is recorded too');

  // `formatMessage` shares the same fallback: speech and caption both report, once per render.
  takeResiduals();
  const shared = formatMessage('**未闭合');
  assert.equal(shared.speech, '**未闭合');
  assert.equal(shared.caption, '**未闭合');
  assert.ok(takeResiduals().some((event) => event.type === 'speech-text.residual'));
});

test('23. the protection list survives the rendered fallback verbatim', () => {
  const protectedWords = ['C#', '2*3', '-5', '2026-11-05', '$3.50', 'file_name.py', 'a-b'];
  for (const word of protectedWords) {
    assert.equal(toSpeechText(word), word, `speech keeps ${word}`);
    assert.equal(toCaptionText(word), word, `caption keeps ${word}`);
    assert.equal(ensurePlain(word), word, `fallback keeps ${word}`);
  }

  const sentence = 'C# 与 2*3、-5、2026-11-05、$3.50、file_name.py、a-b 都保留（原样）。';
  assert.equal(toSpeechText(sentence), sentence);
  assert.equal(toCaptionText(sentence), sentence);
  assert.equal(ensurePlain(sentence), sentence);
});

test('24. ensurePlain is idempotent', () => {
  const samples = [
    ...CORPUS.map(([, source]) => source),
    'C# 与 2*3、-5、2026-11-05、$3.50、file_name.py、a-b（原样）。',
    '### 新格式 **粗** `code` [x](https://y) | a | b |',
    '**未闭合',
    '```js\nconst a = 1;',
  ];
  for (const source of samples) {
    const once = ensurePlain(source);
    assert.equal(ensurePlain(once), once, `not idempotent for ${JSON.stringify(source)}`);
    const speech = toSpeechText(source);
    assert.equal(toSpeechText(speech), speech, `speech is not idempotent for ${JSON.stringify(source)}`);
  }
});

test('25. the fallback cleans structures the parser never saw', () => {
  // A future format that only exists as already-rendered text: the parser cannot be taught it,
  // yet the rendered lane still loses every marker and keeps the words.
  const rendered = '### 新格式 **粗** `code` [x](https://y) | a | b |';
  assert.equal(ensurePlain(rendered), '新格式 粗 code x，a，b');
  assertNoMarkdown('post-render fallback', ensurePlain(rendered));

  // One fallback, two contracts: speech removes empty lines, caption keeps line structure.
  const multiline = '第一段\n\n第二段';
  assert.equal(ensurePlain(multiline, { lane: 'speech' }), '第一段\n第二段');
  assert.equal(ensurePlain(multiline, { lane: 'caption' }), '第一段\n\n第二段');
});

test('26. literal regions are protected from the rendered-text cleanup', () => {
  // A pipe inside code is content: it is not a table border and must not become a comma.
  const codeSpan = '`a \\| b`';
  for (const [label, render] of [['speech', toSpeechText], ['caption', toCaptionText]]) {
    const output = render(codeSpan);
    assert.ok(output.includes('a | b'), `${label} keeps the literal pipe: ${JSON.stringify(output)}`);
    assert.ok(!output.includes('a，b'), `${label} must not read the pipe as table syntax`);
  }

  // HTML inside code is code text, not a tag to strip.
  const html = '`<div>hello</div>`';
  assert.equal(toSpeechText(html), '<div>hello</div>');
  assert.equal(toCaptionText(html), '<div>hello</div>');

  // Escaped markers stay literal: the fallback must not read them as emphasis.
  const escaped = '\\*不是强调\\*';
  assert.equal(toSpeechText(escaped), '*不是强调*');
  assert.equal(toCaptionText(escaped), '*不是强调*');
  assert.equal(toSpeechText('a \\| b'), 'a | b', 'a `\\|` in prose is a literal pipe too');

  // No protection marker may reach any caller.
  const outputs = [toSpeechText(codeSpan), toCaptionText(html), toSpeechText(escaped)];
  for (const output of outputs) {
    assert.ok(!output.includes('\u0000'), `no NUL placeholder leaks: ${JSON.stringify(output)}`);
    assert.ok(!/\u0000L\d+\u0000|L\d+L/u.test(output), `no placeholder text leaks: ${JSON.stringify(output)}`);
  }

  // The last pass stays idempotent once the literal text is what the caller holds.
  for (const output of outputs) {
    assert.equal(ensurePlain(ensurePlain(output)), ensurePlain(output), `not idempotent for ${JSON.stringify(output)}`);
  }
});

test('27. indented code is a code block: speech skips it, caption keeps it', () => {
  const source = '说明：\n\n    console.log("secret")';
  assert.equal(toSpeechText(source), '说明：', 'speech skips indented code like a fence');
  assert.equal(toCaptionText(source), '说明：\n\nconsole.log("secret")', 'caption keeps the code body');
  assert.equal(toSpeechText(source, { codeBlocks: 'read-first-line' }), '说明：\nconsole.log("secret")');

  // A block at the start of the document needs no preceding blank line.
  assert.equal(toSpeechText('    console.log("secret")'), '');
  assert.equal(toCaptionText('    console.log("secret")'), 'console.log("secret")');
  assert.ok(!toCaptionText(source).includes('\u0000'), 'the code body is protected, not leaked');

  // Without a separating blank line an indented line is prose continuation, not code.
  assert.equal(toSpeechText('第一段\n    继续的缩进文字'), '第一段\n继续的缩进文字');
});
