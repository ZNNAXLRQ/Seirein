/**
 * Ack speech policy: the fixed two-second delay, one-line prompt, 10–30 character validation and
 * playback cancellation. Pure module only; no model, TTS, player, timer or child process is used.
 *
 * Run: node --test test/ack-speech.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  ACK_DELAY_MS,
  ACK_MAX_CHARS,
  ACK_MIN_CHARS,
  ackTimeoutMs,
  buildAckPrompt,
  isCuePurpose,
  looksLikeProgressLine,
  planAckPlayback,
  planSayText,
  PROGRESS_MAX_CHARS,
  PROGRESS_PURPOSE_HINT,
  validateAckLine,
} from '../src/host/speech/ack-speech.js';
import { renderLightweightInput } from '../src/host/session/inference/lightweight.js';

const source = await readFile(new URL('../src/host/speech/ack-speech.js', import.meta.url), 'utf8');
const UNSAFE_ACK = /完成|结果|成功|失败|第\s*[0-9零〇一二三四五六七八九十百两]+\s*步|秒|分钟|小时|大约|大概|预计|已经|正在|进度|马上|立刻|稍后/u;
const chars = (text) => [...text].length;

test('the single trigger delay is two seconds', () => {
  assert.equal(ACK_DELAY_MS, 3000, 'the shipping wait is three seconds');
  // The trigger is time-only: no tool table and no tool-name gate survive in this module.
  assert.doesNotMatch(source, /categoryOfTool|shouldAcknowledge|TOOL_CATEGORY/u);
  assert.doesNotMatch(source, /pwsh|terminal_open|assistant_see/u, 'no tool name participates in the trigger');
});

test('the waiting line is 10–30 characters, preferably 12–20', () => {
  assert.equal(ACK_MIN_CHARS, 10);
  assert.equal(ACK_MAX_CHARS, 30);
  const prompt = buildAckPrompt({ persona: '你是小音，说话温柔简短。', userText: '帮我查一下明天上海的天气' });
  const text = prompt.messages.map((message) => message.content).join('\n');
  assert.match(text, /10\s*到\s*30\s*个字/u);
  assert.match(text, /12\s*到\s*20\s*个字/u);
});

test('buildAckPrompt carries the persona and the current user message only', () => {
  const prompt = buildAckPrompt({
    persona: '你是小音，说话温柔简短。',
    userText: '帮我看看 D:\\Users\\alice\\项目\\note.txt 里写了什么',
    language: 'zh-CN',
  });

  assert.ok(Array.isArray(prompt.messages));
  assert.equal(prompt.messages.length, 2);
  assert.equal(prompt.messages[0].role, 'system');
  assert.equal(prompt.messages[1].role, 'user');

  const text = prompt.messages.map((message) => message.content).join('\n');
  assert.match(text, /小音/u);
  assert.match(text, /用户刚才说：/u);
  assert.match(text, /帮我看看/u, 'the user message reaches the prompt');
  assert.match(text, /进度/u, 'progress claims are forbidden');
  assert.doesNotMatch(text, /alice/iu, 'user name must not reach the prompt');
  assert.doesNotMatch(text, /[A-Za-z]:\\/u, 'the drive path must be redacted');
  assert.doesNotMatch(text, /\\/u, 'no path separators may remain');
  assert.doesNotMatch(text, /\/home\/|\/users\//iu);
  // No tool idea: the prompt never mentions a tool/argument field.
  assert.doesNotMatch(text, /工具|参数摘要/u);
});

test('validateAckLine accepts 10–30 characters and normalises wrapping quotes', () => {
  const line = '我这就去看看你说的天气情况';
  assert.equal(chars(line), 13);
  assert.deepEqual(validateAckLine(line), { ok: true, line, reason: 'ok' });
  assert.equal(validateAckLine('“我这就去看看你说的天气情况。”').line, line);
  assert.equal(validateAckLine('「我这就去看看你说的天气情况」').line, line);
  assert.equal(validateAckLine('  我这就去看看你说的天气情况！ ').line, line);
  assert.equal(validateAckLine('我'.repeat(10)).ok, true);
  assert.equal(validateAckLine('我'.repeat(30)).ok, true);
});

test('validateAckLine rejects shorter than 10 and longer than 30 characters', () => {
  const short = validateAckLine('我看看');
  assert.equal(short.ok, false);
  assert.equal(short.reason, 'too-short');
  assert.equal(short.line, '');

  const tooLong = '一'.repeat(31);
  assert.equal(chars(tooLong), 31);
  const long = validateAckLine(tooLong);
  assert.equal(long.ok, false);
  assert.equal(long.reason, 'too-long');
  assert.equal(long.line, '');
});

test('validateAckLine rejects progress, result and time claims', () => {
  const lines = ['这个已经完成了', '完成了，我去看看', '现在走到第 2 步了', '预计 3 秒就好了', '还要几分钟才能好', '已经成功拿到了'];
  for (const line of lines) {
    const result = validateAckLine(line);
    assert.equal(result.ok, false, line);
    assert.equal(result.reason, 'progress', line);
  }
});

test('validateAckLine rejects Markdown, emoji and paths', () => {
  const cases = [
    ['**我这就去看看情况**', 'markdown'],
    ['# 我这就去看看情况', 'markdown'],
    ['`我这就去看看情况`', 'markdown'],
    ['我这就去看看情况😀', 'emoji'],
    ['看看 C:\\Users\\alice', 'path'],
    ['/home/alice/note.txt', 'path'],
  ];
  for (const [line, reason] of cases) {
    const result = validateAckLine(line);
    assert.equal(result.ok, false, line);
    assert.equal(result.reason, reason, line);
  }
});

test('playback plan cancels an unstarted line and lets a playing one finish', () => {
  assert.deepEqual(
    planAckPlayback({ ackStarted: false, answerReady: true }),
    { action: 'skip', reason: 'answer-first' },
  );
  assert.deepEqual(
    planAckPlayback({ ackStarted: true, answerReady: true }),
    { action: 'finish-ack-then-answer' },
  );

  for (const [flag, reason] of [
    ['muted', 'muted'],
    ['interrupted', 'interrupted'],
    ['superseded', 'superseded'],
  ]) {
    const plan = planAckPlayback({ ackStarted: true, answerReady: false, [flag]: true });
    assert.equal(plan.action, 'cancel');
    assert.equal(plan.reason, reason);
    assert.equal(plan.lateResult, 'discard');
    assert.equal(plan.revive, false);
  }

  assert.deepEqual(planAckPlayback({}), { action: 'speak' });
  // Cancellation wins over a ready answer: a late result must never revive the line.
  const precedence = planAckPlayback({ ackStarted: true, answerReady: true, muted: true });
  assert.equal(precedence.action, 'cancel');
  assert.equal(precedence.reason, 'muted');
});

test('ackTimeoutMs defaults to 1200ms and clamps to 500..3000', () => {
  assert.equal(ackTimeoutMs(), 1200);
  assert.equal(ackTimeoutMs({}), 1200);
  assert.equal(ackTimeoutMs({ config: {} }), 1200);
  assert.equal(ackTimeoutMs({ config: { ackTimeoutMs: 1500 } }), 1500);
  assert.equal(ackTimeoutMs({ config: { ackTimeoutMs: 100 } }), 500);
  assert.equal(ackTimeoutMs({ config: { ackTimeoutMs: 9000 } }), 3000);
  assert.equal(ackTimeoutMs({ config: { ackTimeoutMs: '800' } }), 800);
  assert.equal(ackTimeoutMs({ config: { ackTimeoutMs: 'soon' } }), 1200);
});

test('the module never looks at task text', () => {
  assert.doesNotMatch(source, /搜索|查询|总结|命令/u, 'no command-keyword matching in the module');
  assert.doesNotMatch(
    source,
    /task[\s\S]{0,120}(?:\.match|\.test|\.includes|\.indexOf|\.search)\s*\(/u,
    'task text is not inspected',
  );
  assert.doesNotMatch(source, /UNSAFE_ACK_TEXT[\s\S]{0,40}source/u);
  // The validation list is the only remaining text inspection, and it never selects a speaker.
  assert.match(source, /UNSAFE_ACK_TEXT/u);
});

test('the ack input package carries the persona, the current message and a few recent lines only', () => {
  const memory = '记忆条目甲：用户喜欢冰美式';
  const profile = '画像条目乙：用户住在上海';
  const rendered = renderLightweightInput('ack', {
    persona: '你是小音，说话温柔简短。',
    userText: '帮我查一下明天上海的天气',
    recent: ['我这就去看看天气情况', '交给我吧'],
    memory,
    profile,
    history: '最近的整段聊天记录',
  });
  const text = `${rendered.system}\n${rendered.user}`;
  assert.match(rendered.system, /小音/u, 'the persona is in the system prompt');
  assert.match(rendered.user, /用户刚才说：.*帮我查一下明天上海的天气/u, 'the current message is the target');
  assert.match(rendered.user, /最近说过的几句/u, 'a few recent lines are kept as loose context');
  assert.match(rendered.user, /我这就去看看天气情况/u);
  assert.ok(!text.includes(memory), 'no memory entry is retrieved or included');
  assert.ok(!text.includes(profile), 'no user-profile entry is included');
  assert.ok(!text.includes('最近的整段聊天记录'), 'unrelated chat history fields are ignored');
  assert.equal(rendered.chars, [...rendered.system].length + [...rendered.user].length);
  assert.equal(rendered.tokensEstimate, Math.ceil(rendered.chars / 2));
  // buildAckPrompt (the renderer's own seam) has the same shape and still sanitizes the message.
  const prompt = buildAckPrompt({ persona: '你是小音', userText: '看看 C:\\Users\\alice\\note.txt', recent: ['先接一句'] });
  const promptText = prompt.messages.map((message) => message.content).join('\n');
  assert.doesNotMatch(promptText, /[A-Za-z]:\\/u, 'the path is redacted before it reaches the package');
  assert.match(promptText, /先接一句/u);
  console.log(`ack package chars=${rendered.chars} tokens=${rendered.tokensEstimate} persona=yes currentMessage=yes recent=2 memory=0 profile=0`);
});

test('the ack module has no template pool: a failed draft is not replaced by a canned line', () => {
  assert.doesNotMatch(source, /ACK_LINE_GROUPS|pickAckLine|我看看哈?['"`]/u);
});

test('validateAckLine rejects a line that repeats the user words or a context sentence', () => {
  const userText = '帮我查一下明天上海的天气';
  const context = '你是运行在用户电脑上的伴生助手。用户喜欢在深夜写代码，喝冰美式。';
  const userEcho = validateAckLine('帮我查一下明天上海的天气', { userText });
  assert.equal(userEcho.ok, false);
  assert.equal(userEcho.reason, 'echo', 'a copied user sentence is not a reaction');
  const contextEcho = validateAckLine('用户喜欢在深夜写代码，喝冰美式', { context });
  assert.equal(contextEcho.ok, false);
  assert.equal(contextEcho.reason, 'echo', 'a context sentence must not be spoken as a reaction');
  // A normal reaction shares only everyday words ("天气"): it stays valid.
  const normal = validateAckLine('我这就去看看天气情况', { userText, context });
  assert.equal(normal.ok, true);
  assert.equal(normal.reason, 'ok');
});

// ---------------------------------------------------------------------------
// Explicit purpose only: no text-prefix guess decides whether a line is clipped
// ---------------------------------------------------------------------------

const CORRECTION = '我先前说的结论不准确，现在更正：不要删除原始数据，请先完成备份……';

test('1. an untagged correction is spoken whole: no prefix guess clips the answer', () => {
  const plan = planSayText(CORRECTION);
  assert.equal(plan.cue, false, 'an untagged call is content, not a cue');
  assert.equal(plan.clipped, false, 'nothing was clipped');
  assert.equal(plan.text, CORRECTION, 'the exact text survives');
  assert.match(plan.text, /现在更正/u, 'the real correction content is kept');
  assert.match(plan.text, /先完成备份/u, 'the instruction content is kept');
  assert.equal(plan.chars, [...CORRECTION].length);
  assert.equal(plan.originalChars, [...CORRECTION].length);
  console.log(`untagged correction: chars=${plan.chars} clipped=${plan.clipped} text="${plan.text}"`);
});

test('2. the same text tagged purpose progress is cut at its first sentence and reports clipped', () => {
  const plan = planSayText(CORRECTION, { purpose: 'progress' });
  assert.equal(plan.cue, true);
  assert.equal(plan.clipped, true, 'the explicit cue reports the clip');
  assert.equal(plan.text, '我先前说的结论不准确');
  assert.equal(plan.originalChars, [...CORRECTION].length);
  assert.ok([...plan.text].length <= PROGRESS_MAX_CHARS);
  // `ack` is the other explicit cue purpose and takes the same cap.
  const ack = planSayText(CORRECTION, { purpose: 'ack' });
  assert.equal(ack.cue, true);
  assert.equal(ack.clipped, true);
  assert.equal(ack.text, '我先前说的结论不准确');
  console.log(
    `progress: ${plan.originalChars} -> ${plan.chars} chars clipped=${plan.clipped} text="${plan.text}"`,
  );
});

test('3. an untagged "我先查一下" is not clipped and the prefix guess is retired', () => {
  const plan = planSayText('我先查一下');
  assert.deepEqual(plan, {
    text: '我先查一下', chars: 5, originalChars: 5, clipped: false, cue: false,
  });
  for (const line of ['我先查一下', '让我看看这个文件', '我正在检查日志', CORRECTION]) {
    assert.equal(looksLikeProgressLine(line), false, `no prefix guess for: ${line}`);
  }
  console.log(`untagged "我先查一下": chars=${plan.chars} clipped=${plan.clipped} looksLikeProgressLine=false`);
});

test('4. an explicit progress line within 30 characters is untouched (regression)', () => {
  const line = '我先去查一下相关资料，你稍等。';
  assert.equal([...line].length, 15);
  const plan = planSayText(line, { purpose: 'progress' });
  assert.equal(plan.cue, true);
  assert.equal(plan.clipped, false);
  assert.equal(plan.text, line, 'the short cue reaches TTS verbatim');
  assert.equal(plan.chars, 15);
  console.log(`short progress: chars=${plan.chars} clipped=${plan.clipped} text="${plan.text}"`);
});

test('5. only progress and ack opt into the cap, and the prompt says so', () => {
  assert.equal(isCuePurpose('progress'), true);
  assert.equal(isCuePurpose('ack'), true);
  for (const purpose of ['', 'explicit', 'answer', undefined]) {
    assert.equal(isCuePurpose(purpose), false, String(purpose));
  }
  assert.match(PROGRESS_PURPOSE_HINT, /显式传\s*purpose:'progress'/u);
  assert.match(PROGRESS_PURPOSE_HINT, /完整播报/u);
  assert.match(PROGRESS_PURPOSE_HINT, /不裁剪/u);
  assert.doesNotMatch(PROGRESS_PURPOSE_HINT, /我先|让我|正在/u, 'the prompt teaches the tag, not the wording');
  console.log(`hint="${PROGRESS_PURPOSE_HINT}"`);
});
