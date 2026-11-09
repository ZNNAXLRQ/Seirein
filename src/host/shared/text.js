/**
 * Host text helpers: sentence splitting, speech/caption text preparation, message-text extraction
 * and the small pure formatters (font-registry parsing, avatar-style text, dialogue summary text).
 *
 * Everything here is pure: no `apply` state, no config read, no event and no I/O. The functions
 * used to live at the top of index.js and are still re-exported from there, so the public host
 * surface is unchanged.
 */

import { randomUUID } from 'node:crypto';

import { DEFAULT_SPEECH_MAX_CHARS, resolveSpeechBudget } from '../speech/speech-text.js';
import { VOICE_MEMORY_HEADING } from '../memory/memory-injection.js';

// ---- A2: first-sentence speech --------------------------------------------
// The reply is spoken as soon as its first complete sentence exists instead of after turn/end.
// Splitting is a pure text concern; the player below is the only owner of ordering and of the
// "never replay what was already spoken" rule.

/** Characters that end a spoken sentence; a run of them stays with the sentence it closes. */
const SENTENCE_TERMINATORS = '。！？!?；;\n';
/** Closing punctuation that belongs to the sentence before it. */
const SENTENCE_CLOSERS = "”’\"'）)】]」』》〉";

/** Is `text[index]` a sentence terminator? */
function isSentenceTerminator(text, index) {
  const ch = text[index];
  if (ch === undefined) return false;
  // One ellipsis is a pause inside a sentence; a run of two or more closes it.
  if (ch === '…') return text[index + 1] === '…';
  if (ch === '.') {
    // An English period is a boundary only outside a decimal/version/abbreviation run (v1.2).
    const before = text[index - 1] ?? '';
    const after = text[index + 1] ?? '';
    return !(/[0-9A-Za-z]/u.test(before) && /[0-9A-Za-z]/u.test(after));
  }
  return SENTENCE_TERMINATORS.includes(ch);
}

/** End (exclusive) of one complete sentence starting at `start`, or -1 while it is unfinished. */
export function sentenceEndIndex(text, start) {
  for (let index = start; index < text.length; index += 1) {
    if (!isSentenceTerminator(text, index)) continue;
    let end = index + 1;
    while (end < text.length && (text[end] === '…' || isSentenceTerminator(text, end))) end += 1;
    while (end < text.length && SENTENCE_CLOSERS.includes(text[end])) end += 1;
    return end;
  }
  return -1;
}

/**
 * Split the already-available text into complete sentences and keep the unterminated tail apart,
 * so a streaming caller never speaks half a sentence it will have to repeat.
 * @param {string} text
 * @returns {{sentences: string[], rest: string}}
 */
export function takeSentences(text) {
  const value = typeof text === 'string' ? text : '';
  const sentences = [];
  let start = 0;
  for (;;) {
    const end = sentenceEndIndex(value, start);
    if (end === -1) break;
    const sentence = value.slice(start, end).trim();
    if (sentence.length > 0) sentences.push(sentence);
    start = end;
  }
  return { sentences, rest: value.slice(start) };
}

/**
 * Split a finished text into sentences. With `flush` (the default) the unterminated tail is the
 * last sentence, so a reply without punctuation is still spoken instead of being dropped.
 * @param {string} text
 * @param {{flush?: boolean}} [options]
 * @returns {string[]}
 */
export function splitSentences(text, { flush = true } = {}) {
  const { sentences, rest } = takeSentences(text);
  const tail = rest.trim();
  if (flush && tail.length > 0) sentences.push(tail);
  return sentences;
}

/** Code-point length: the unit every speech budget and every clip count uses. */
export function speechCharCount(text) {
  return [...String(text ?? '')].length;
}

/**
 * A5: the spoken share of a whole reply — complete sentences only, never half a sentence.
 *
 * Sentences are taken in order while they fit the budget. The first one that would cross the cap
 * ends the share; it and every later sentence are dropped (a shorter later sentence is not
 * skipped into, because the subtitle follows the same order). `budget.unbounded` (or
 * `maxChars: 0`) keeps everything. `maxSentences` additionally caps the count, which is how the
 * caption is cut to exactly the sentences that were spoken.
 *
 * The returned counts are what `voice.speech.budget` reports and what the truncation note uses.
 *
 * @param {string} text
 * @param {{maxChars?: number|string, budget?: {maxChars: number, unbounded: boolean},
 *          maxSentences?: number}} [options]
 * @returns {{text: string, requestedChars: number, spokenChars: number, truncated: boolean,
 *            keptSentences: number, droppedSentences: number}}
 */
export function limitSpeechToSentences(text, {
  maxChars = DEFAULT_SPEECH_MAX_CHARS,
  budget = null,
  maxSentences = Infinity,
} = {}) {
  const source = typeof text === 'string' ? text : '';
  const resolved = budget ?? resolveSpeechBudget({ maxChars });
  // Sentence spans over the original string: keeping whole spans preserves the author's spacing.
  const spans = [];
  let start = 0;
  for (;;) {
    const end = sentenceEndIndex(source, start);
    if (end === -1) break;
    spans.push({ start, end });
    start = end;
  }
  if (source.slice(start).trim().length > 0) spans.push({ start, end: source.length });
  const sentenceCap = Number.isFinite(maxSentences) ? Math.max(0, Math.floor(maxSentences)) : spans.length;
  let kept = 0;
  let used = 0;
  for (const span of spans) {
    if (kept >= sentenceCap) break;
    const cost = speechCharCount(source.slice(span.start, span.end));
    if (!resolved.unbounded && used + cost > resolved.maxChars) break;
    used += cost;
    kept += 1;
  }
  const spoken = kept === 0 ? '' : source.slice(0, spans[kept - 1].end).trim();
  return {
    text: spoken,
    requestedChars: speechCharCount(source.trim()),
    spokenChars: speechCharCount(spoken),
    truncated: kept < spans.length,
    keptSentences: kept,
    droppedSentences: spans.length - kept,
  };
}

// ---- spoken version: one answer, two expressions, one voice outlet --------
export const SPOKEN_SHORT_MAX_CHARS = 60;
export const SPOKEN_SHORT_MAX_SENTENCES = 2;
/** Above this the reply is always condensed, however few sentence breaks it has. */
export const SPOKEN_SHORT_HARD_MAX_CHARS = 120;

/**
 * A short answer is spoken verbatim: ≤ 60 characters AND ≤ 2 sentences. The second condition is a
 * conjunction, not an alternative: one 800-character paragraph is a single "sentence" but far too
 * long to be read out in full, and the hard cap below keeps that from ever counting as short.
 */
export function isShortSpokenReply(text) {
  const value = String(text ?? '').trim();
  if (value.length === 0) return true;
  const chars = speechCharCount(value);
  if (chars > SPOKEN_SHORT_HARD_MAX_CHARS) return false;
  return chars <= SPOKEN_SHORT_MAX_CHARS && splitSentences(value).length <= SPOKEN_SHORT_MAX_SENTENCES;
}

const FULL_READ_REQUEST = /详细(?:讲|说|念|读|讲一下|说一下)|全部(?:读|念|说)|完整(?:念|读|讲|说)|全文(?:读|念)|读(?:全文|一遍全文)|念(?:全文|一遍全文)|从头(?:读|念)/u;

/** Did the user explicitly ask for the whole reply to be read out? Then no rewrite is attempted. */
export function requestsFullRead(utterance) {
  return FULL_READ_REQUEST.test(String(utterance ?? ''));
}

/**
 * Substantive tokens the cleanup must never lose or rewrite: CJK (and other letter) characters,
 * Latin/digit identifiers (underscores included), signed numbers with units, `--flags`, paths and
 * versions. Presentation punctuation (Markdown markers, quotes, em dashes, commas) is absent, so
 * removing it is allowed; removing or changing any token below is not.
 *
 * Single CJK characters are tokens on purpose: `**重点**是` -> `重点是` keeps the same two
 * characters and must pass, while `__debug__` -> `debug` loses underscores and must fail.
 */
const SUBSTANTIVE_TOKEN = /[+\-−]?\d+(?:[.,]\d+)*(?:[%‰℃℉°]|[A-Za-z]+)?|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[./\\]?[+\-]{0,2}(?=[\p{Script=Latin}\p{N}_]*[\p{Script=Latin}\p{N}])[\p{Script=Latin}\p{N}_]+(?:[./\\:+\-][\p{Script=Latin}\p{N}_]+)*[%‰℃℉°]?|[%‰℃℉°㎡¥$€£]|\p{L}/gu;

/** Ordered substantive tokens of a text; the cleanup passes only when they are unchanged. */
function substantiveTokens(value) {
  return String(value ?? '').match(SUBSTANTIVE_TOKEN) ?? [];
}

/** Same token count, same tokens, same order. */
function sameSubstantiveTokens(before, after) {
  if (before.length !== after.length) return false;
  return before.every((token, index) => token === after[index]);
}

/**
 * Read-aloud cleanup for a model-produced spoken version.
 *
 * Protection comes first: fenced code and inline code are replaced by placeholders and every
 * character inside them (spaces, `--`, underscores, paths, versions) is restored verbatim after
 * display cleanup. Underscore identifiers (`__debug__`, `_x`, `foo_bar`, `snake_case`) are not
 * touched: `__...__` is never treated as emphasis, and a bounded `_..._` pair is cleaned only
 * when the safety gate proves no identifier changed. Only explicit asterisk emphasis
 * (`**text**`, `*text*`) has its markers removed and its content kept.
 *
 * Afterwards the substantive tokens of the pre-clean text and of the cleaned text are compared.
 * If any content token was lost or changed (identifier collapsed, code span swallowed, CJK or a
 * number/unit dropped), the cleanup is refused with `unsafe-cleanup` instead of returning a
 * damaged string.
 *
 * @param {string} value
 * @returns {{ok: boolean, text: string, reason: string}}
 */
function cleanSpokenText(value) {
  const original = String(value ?? '');
  const code = [];
  // A run of NULs that does not occur in the input: a document cannot forge a placeholder.
  let mark = '\u0000';
  while (original.includes(mark)) mark += '\u0000';
  const placeholderPattern = () => new RegExp(`${mark}C(\\d+)${mark}`, 'gu');
  const placeholder = (content) => {
    code.push(content);
    return `${mark}C${code.length - 1}${mark}`;
  };
  const restore = (text) => text.replace(placeholderPattern(), (_whole, index) => code[Number(index)] ?? '');
  let text = original;

  // 1. Fenced code first: drop only the fence lines (and the info word), keep the code body.
  text = text.replace(/```[^\n]*\n([\s\S]*?)```/gu, (_whole, body) => placeholder(body));
  // 2. Then inline code, including a one-line triple-backtick span.
  text = text.replace(/```([^\n`]*?)```/gu, (_whole, body) => placeholder(body));
  text = text.replace(/`([^`\n]+)`/gu, (_whole, body) => placeholder(body));
  // 3. Any remaining backtick is presentation only; its neighbours stay.
  text = text.replace(/`+/gu, '');

  // The baseline includes every code body, so a cleanup step that swallows a placeholder is
  // caught below even when the body itself has no letters/digits.
  const baseline = substantiveTokens(restore(text));

  // 4. Explicit paired Markdown emphasis. `__...__` is never treated as emphasis because it is
  // also the shape of identifiers such as `__debug__`; underscores are content, so the pair is
  // kept. A single `_..._` wrapper is cleaned only when clearly bounded; the safety gate below
  // refuses it when the content is an identifier (for example `_debug_`, which would become a
  // different word).
  text = text.replace(/\*\*([^\s*](?:[^*\n]*[^\s*])?)\*\*/gu, '$1');
  text = text.replace(/(^|[^*\w])\*([^\s*](?:[^*\n]*[^\s*])?)\*(?=[^*\w]|$)/gu, '$1$2');
  text = text.replace(/(^|[^_\w])_([^\s_](?:[^_\n]*[^\s_])?)_(?=[^_\w]|$)/gu, '$1$2');
  // 5. Paired quotation / book-title wrappers: the marks are not spoken, their content is kept.
  text = text.replace(/“([^“”]*)”/gu, '$1');
  text = text.replace(/‘([^‘’]*)’/gu, '$1');
  text = text.replace(/「([^「」]*)」/gu, '$1');
  text = text.replace(/『([^『』]*)』/gu, '$1');
  text = text.replace(/《([^《》]*)》/gu, '$1');
  text = text.replace(/〈([^〈〉]*)〉/gu, '$1');
  text = text.replace(/"([^"\n]*)"/gu, '$1');
  // A lone wrapper at either end is the same shape; strip it rather than speaking it.
  text = text.replace(/^["「『“'"‘《〈]+/u, '').replace(/["」』”'"’》〉]+$/u, '');
  // 6. A prose em dash is a pause, not a word; a dash joining digits or Latin letters is a range
  // (10—20, v1—v2) and must survive. En dashes / minus signs were never rewritten here.
  text = text.replace(/—+/gu, (run, offset, whole) => {
    const before = whole[offset - 1] ?? '';
    const after = whole[offset + run.length] ?? '';
    return /[0-9A-Za-z]/u.test(before) && /[0-9A-Za-z]/u.test(after) ? run : '，';
  });
  // 7. Emoji, variation selectors and joiners are never spoken.
  text = text.replace(
    /[\p{Extended_Pictographic}\uFE0F\u200D\u20E3\u{1F1E6}-\u{1F3FF}]/gu,
    '',
  );
  // A few purely decorative dingbats are presentation. Do NOT strip the whole Unicode `So`
  // category: it also contains spoken units (°, ℃, ㎡) and would silently delete real content.
  text = text.replace(/[★☆✦✧✩✪✫✬✭✮✯✰♪♫♬]/gu, '');
  // 8. Only presentation whitespace is removed; words, numbers and sentence punctuation stay.
  text = text.replace(/\s*\n+\s*/gu, ' ').replace(/[ \t]+/gu, ' ').trim();

  // 9. Safety gate: every code placeholder must still be present, in order, and the restored
  // text must carry exactly the same substantive tokens as the baseline.
  const present = [...text.matchAll(placeholderPattern())].map((match) => Number(match[1]));
  const placeholdersIntact = present.length === code.length
    && present.every((index, position) => index === position);
  const cleaned = restore(text);
  if (!placeholdersIntact || !sameSubstantiveTokens(baseline, substantiveTokens(cleaned))) {
    // Never hand back a damaged cleanup: the caller falls back to the original full text.
    return { ok: false, text: original, reason: 'unsafe-cleanup' };
  }
  return { ok: true, text: cleaned, reason: '' };
}

/**
 * Validate a model-produced spoken version. The candidate is first cleaned for reading (see
 * `cleanSpokenText`); similarity is never used to delete anything. Only the shape is checked
 * (non-empty, not longer than the source, no model preamble/quoting), and every failure is
 * reported with a reason so the caller can fall back to the full body. Cleanup that cannot be
 * proven content-preserving is refused as `unsafe-cleanup` with the un-cleaned candidate text:
 * a damaged version is never adopted, even when its length would be acceptable. Length equality
 * is allowed and is a deliberate, conservative choice: an equal-length rewrite is accepted when it
 * is content-faithful and actually sounds spoken, because rejecting it merely for not getting
 * shorter would fall back to prose that is MORE written. "Equal" is not a way around the length
 * ceiling: a longer candidate is still refused.
 * @returns {{ok: boolean, text: string, chars: number, reason: string}}
 */
export function normalizeSpokenVersion(source, candidate) {
  const original = String(source ?? '').trim();
  let text = String(candidate ?? '').trim();
  text = text.replace(/^(?:口语版|口播版|语音版|spoken\s*version|speech)\s*[:：]\s*/iu, '');
  const cleaned = cleanSpokenText(text);
  if (cleaned.ok !== true) {
    return {
      ok: false,
      text,
      chars: speechCharCount(text),
      reason: cleaned.reason || 'unsafe-cleanup',
    };
  }
  text = cleaned.text;
  const chars = speechCharCount(text);
  const sourceChars = speechCharCount(original);
  if (chars === 0) return { ok: false, text: '', chars: 0, reason: 'empty' };
  if (chars < 4) return { ok: false, text, chars, reason: 'too-short' };
  if (chars > sourceChars) return { ok: false, text, chars, reason: 'not-shorter' };
  if (/^(?:好的|当然|以下是|这是)/u.test(text) && chars > sourceChars * 0.9) {
    return { ok: false, text, chars, reason: 'preamble' };
  }
  return { ok: true, text, chars, reason: '' };
}

/**
 * Written-style words the lint only HINTS at: they are common in the source prose and easy to
 * copy into a spoken version. Listing one never blocks, rewrites or judges the candidate.
 */
const WRITTEN_STYLE_HINTS = Object.freeze([
  '言外之意', '尺子', '铺垫', '调味料', 'CP感', '扎心',
]);
/** Quotation / title marks the lint counts (never strips): 「」“”‘’《》. */
const LINT_QUOTE_MARKS = '「」“”‘’《》';
/** `longestSentence` is truncated to this many code points in the returned observation. */
const LINT_LONGEST_MAX = 80;

/**
 * Read-only spoken-style lint. It never edits `text`, never blocks or retries, and costs no model
 * call: callers use it only for observation. Counts are deliberately neutral — quotation marks,
 * em dashes and emoji may be legitimate persona expression, so a non-zero count is not an error.
 *
 * - `sentences`: number of completed sentences (unterminated tail counted as one).
 * - `maxSentenceChars`: code-point length of the longest sentence, terminator included.
 * - `longestSentence`: that sentence truncated to 80 code points.
 * - `quoteMarks`: total count of 「」“”‘’《》 characters.
 * - `emDashes`: number of em-dash runs (a Chinese `——` is one run).
 * - `emoji`: number of emoji code points.
 * - `writtenStyleHints`: written-style words that actually occur, in a fixed order.
 * - `copyRisk`: true when the spoken/body length ratio is ≥ 0.95; needs `bodyChars`, otherwise
 *   false (not measured, never a judgement).
 *
 * @param {string} text
 * @param {{bodyChars?: number}} [options]
 * @returns {{sentences: number, maxSentenceChars: number, longestSentence: string,
 *            quoteMarks: number, emDashes: number, emoji: number,
 *            writtenStyleHints: string[], copyRisk: boolean}}
 */
export function spokenLint(text, { bodyChars = 0 } = {}) {
  const value = String(text ?? '');
  const sentences = splitSentences(value);
  let maxSentenceChars = 0;
  let longestSentence = '';
  for (const sentence of sentences) {
    const chars = speechCharCount(sentence);
    if (chars > maxSentenceChars) {
      maxSentenceChars = chars;
      longestSentence = sentence;
    }
  }
  const longestPoints = [...longestSentence];
  if (longestPoints.length > LINT_LONGEST_MAX) {
    longestSentence = longestPoints.slice(0, LINT_LONGEST_MAX).join('');
  }
  let quoteMarks = 0;
  for (const char of value) {
    if (LINT_QUOTE_MARKS.includes(char)) quoteMarks += 1;
  }
  const emDashes = (value.match(/—+/gu) ?? []).length;
  const emoji = (value.match(/[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}]/gu) ?? []).length;
  const writtenStyleHints = WRITTEN_STYLE_HINTS.filter((word) => value.includes(word));
  const spokenChars = speechCharCount(value);
  const body = Number(bodyChars);
  const copyRisk = Number.isFinite(body) && body > 0 ? spokenChars / body >= 0.95 : false;
  return {
    sentences: sentences.length,
    maxSentenceChars,
    longestSentence,
    quoteMarks,
    emDashes,
    emoji,
    writtenStyleHints,
    copyRisk,
  };
}

/**
 * Text a whole-reply fallback may speak. `speechText` is present only when the body-eligible text
 * differs from the committed `text`, so a turn whose only words were pre-tool commentary yields
 * '' (subtitle/log only) instead of replaying that commentary.
 */
export function replySpeechText(result) {
  const value = typeof result?.speechText === 'string' ? result.speechText : (result?.text ?? '');
  return String(value).replace(/\s+/gu, ' ').trim();
}

/**
 * Join only the text blocks of one logged message. Reasoning, tool calls and tool results are
 * deliberately excluded: they are machinery, not something either side actually said.
 */
export function messageTextBlocks(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
}

/**
 * Remove the plugin's own memory block from a delivered utterance. The block is prefixed to the
 * user text before delivery, but the stored original must be the user's words only.
 */
export function stripMemoryInjection(text) {
  const value = String(text ?? '');
  const heading = `## ${VOICE_MEMORY_HEADING}`;
  if (!value.startsWith(heading)) return value;
  const separator = value.indexOf('\n\n');
  return separator >= 0 ? value.slice(separator + 2) : '';
}

// ---- C2: pre-step memory injection ----------------------------------------
// The one custom source kind `assistant-memory` is the exclusion marker every other lane checks,
// so the block can never be recorded back, re-queried, or turned into a voice trigger.
export const ASSISTANT_MEMORY_SOURCE = 'assistant-memory';

/** True for the plugin's own pre-step block; the one exclusion marker used by every lane. */
export function isAssistantMemoryMessage(message) {
  return message?.source?.kind === ASSISTANT_MEMORY_SOURCE;
}

/**
 * The user's own words for one pre-step. Runtime context, the daily digest and the plugin's own
 * injected block are not questions, so they can never become this turn's retrieval query.
 * @param {Array<object>} messages the claimed inbox messages of this step
 * @returns {string} the last genuine user text, or ''
 */
export function memoryQueryText(messages = []) {
  if (!Array.isArray(messages)) return '';
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === null || typeof message !== 'object' || message.role !== 'user') continue;
    // The isolation contract: a previous turn's injected block is reference material, never input.
    if (isAssistantMemoryMessage(message)) continue;
    if (message.source?.kind !== 'user') continue;
    const text = messageTextBlocks(message);
    if (text.includes('以下内容作为长期约束与背景')) continue;
    const trimmed = text.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return '';
}

/** Build the injected message; a fresh id keeps it apart from the user's delivery message. */
export function memoryInjectionMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    source: { kind: ASSISTANT_MEMORY_SOURCE },
    content: [{ type: 'text', text }],
  };
}

// ---- avatar style text ----------------------------------------------------
/** Snapshot sections whose heading names the user profile; the rest is assistant persona. */
const USER_PROFILE_HEADING = /用户|画像/u;

/**
 * Keep only the assistant part of a compiled profile snapshot: user-profile sections are dropped
 * and section headings are removed. A snapshot without headings is already assistant-only text.
 */
export function assistantPersonaFromSnapshot(snapshotText = '') {
  const raw = String(snapshotText ?? '');
  const lines = raw.split(/\r?\n/u);
  const kept = [];
  let inUserSection = false;
  let sawHeading = false;
  for (const line of lines) {
    const heading = /^##\s+(.+?)\s*$/u.exec(line);
    if (heading !== null) {
      sawHeading = true;
      inUserSection = USER_PROFILE_HEADING.test(heading[1]);
      continue;
    }
    if (!inUserSection) kept.push(line);
  }
  return (sawHeading ? kept.join('\n') : raw).trim();
}

/**
 * Resolve the style source: the persona box wins whenever it has text (trial/save/writeback
 * included), and only an empty box falls back to the library snapshot. `chars` is the length of
 * exactly the text handed to the background builder.
 */
export function resolveAvatarStyleText({ boxText = '', snapshotText = '' } = {}) {
  const box = String(boxText ?? '').trim();
  if (box.length > 0) return { text: box, kind: 'box', chars: box.length };
  const snapshot = assistantPersonaFromSnapshot(snapshotText);
  return { text: snapshot, kind: 'snapshot', chars: snapshot.length };
}

// ---- nonverbal perception cue (experimental, default off) -------------------
/**
 * `true` only for the one SenseVoice side-channel tag this version treats as evidence:
 * `<|Laughter|>` / `Laughter`, case-insensitive. A missing value, an emotion tag (`<|HAPPY|>`) or a
 * speech tag (`<|Speech|>`) is not evidence, so it never creates a cue.
 */
export function nonverbalLaughterTag(value) {
  if (typeof value !== 'string') return false;
  return value.trim().replace(/^<\|/u, '').replace(/\|>$/u, '').trim().toLowerCase() === 'laughter';
}

/**
 * Why the user's own words end the cue: an explicit denial, an explicit recovery, or a request to
 * stop adjusting. Ordinary chat matches none of these, so it never touches the cue.
 * @returns {''|'denied'|'recovered'|'stop-adjusting'}
 */
export function nonverbalClearReason(text) {
  const value = typeof text === 'string' ? text : '';
  if (value.length === 0) return '';
  if (/(?:我|人家)?(?:没有|没)(?:在)?笑|(?:不是|并没有)(?:在)?笑|(?:我)?(?:没有|没)(?:那么)?(?:开心|高兴)/u.test(value)) return 'denied';
  if (/(?:我)?(?:已经)?没事(?:了|儿)?|(?:我|已经)(?:已经)?(?:好|恢复)(?:了|多了|起来)|(?:我)?(?:已经)?(?:没|不)(?:那么)?(?:难过|伤心|低落|不开心)/u.test(value)) return 'recovered';
  if (/(?:别|不要|不用|不必|停止|别再)(?:这样|那样|再这样|安慰|调整|管我|提(?:这|那)?(?:个|件)?事?)/u.test(value)) return 'stop-adjusting';
  return '';
}

/** Host-controlled source wording: a loopback may be a video or music, never the user's voice. */
const NONVERBAL_SOURCE_LABEL = { mic: '麦克风', loopback: '系统声音（回环）', unknown: '音频输入' };

/**
 * The one injected block. The detection only supplies the age, the clock time and the source
 * label; the wording (and therefore every instruction) is fixed here, so a detection can never
 * generate its own prompt text.
 */
export function nonverbalCuePrompt(cue, ageMs) {
  const source = cue?.source === 'mic' || cue?.source === 'loopback' ? cue.source : 'unknown';
  const age = Number(ageMs);
  const seconds = Math.max(0, Math.round((Number.isFinite(age) ? age : 0) / 1000));
  const at = new Date(Number(cue?.observedAt) > 0 ? Number(cue.observedAt) : Date.now());
  const clock = [at.getHours(), at.getMinutes(), at.getSeconds()]
    .map((part) => String(part).padStart(2, '0')).join(':');
  const heard = source === 'loopback' ? '可能来自视频或音乐，' : '';
  return [
    `【系统观察·非语言线索】${NONVERBAL_SOURCE_LABEL[source]}在 ${seconds} 秒前（${clock}）检测到疑似笑声，${heard}来源及情绪含义未确认。`,
    '这不是用户发言，不改变任何硬决策；可结合当前对话调整回应；不要据此断言用户开心，也不必主动提及检测结果。',
  ].join('\n');
}

// ---- subtitle font names (Windows registry text) --------------------------
/**
 * Family name of a `Fonts` registry value: drop the `(TrueType)` / `(OpenType)` / `(Type 1)`
 * suffix. Anything else (for example a real parenthesis in the name) is kept.
 * @param {string} valueName registry value name such as `Microsoft YaHei UI (TrueType)`
 */
export function fontFamilyFromValueName(valueName) {
  return String(valueName ?? '')
    .replace(/\s*\((?:TrueType|OpenType|Type 1|Vector|Raster|Device|CID[^)]*)\)\s*$/iu, '')
    .trim();
}

/**
 * Parse `reg query ...\Fonts` output into sorted, de-duplicated family names.
 * Several hives' output may be concatenated; `HKEY_...` headers and non-value lines are skipped.
 * @param {string} output raw reg.exe text
 * @returns {string[]} family names, Chinese collation (zh-Hans) order
 */
export function parseFontRegistryOutput(output) {
  const families = new Set();
  for (const rawLine of String(output ?? '').split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0 || /^HKEY_/iu.test(line)) continue;
    // `name    REG_SZ    file.ttf`: the value name is the text before the type column.
    const typed = line.match(/^(.*?)\s{2,}REG_(?:SZ|EXPAND_SZ|MULTI_SZ|BINARY|DWORD|QWORD)(?:\s{2,}|$)/u);
    if (typed === null) continue;
    const family = fontFamilyFromValueName(typed[1]);
    if (family.length > 0) families.add(family);
  }
  return [...families].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN', { sensitivity: 'base' }));
}

// ---- dialogue summary text ------------------------------------------------
export const DIALOGUE_SUMMARY_DEFAULTS = Object.freeze({
  maxChars: 400,
  maxTokens: 600,
  timeoutMs: 30_000,
  retryBaseMs: 5_000,
  retryMaxMs: 60_000,
});

/** One paragraph, at most `maxChars` characters (the beginning is kept: people/events come first). */
export function normalizeDialogueSummary(value, maxChars = DIALOGUE_SUMMARY_DEFAULTS.maxChars) {
  const text = typeof value === 'string'
    ? value.replace(/\s*\n+\s*/gu, ' ').replace(/[ \t]+/gu, ' ').trim()
    : '';
  const cap = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : DIALOGUE_SUMMARY_DEFAULTS.maxChars;
  const chars = Array.from(text);
  return chars.length > cap ? chars.slice(0, cap).join('') : text;
}

/**
 * The exact summary request body: the old summary plus everything the summary does not cover yet
 * (`snapshot().pending`), with the coordinates the answer must carry back.
 */
export function dialogueSummaryRequest(snapshot) {
  const view = snapshot !== null && typeof snapshot === 'object' ? snapshot : {};
  const summary = typeof view.summary === 'string' ? view.summary.trim() : '';
  const pending = Array.isArray(view.pending) ? view.pending : [];
  const pendingText = pending
    .map((item) => (typeof item?.text === 'string' ? item.text.trim() : ''))
    .filter((text) => text.length > 0)
    .join('\n');
  const user = [
    summary.length > 0 ? `【旧摘要】\n${summary}` : '',
    pendingText.length > 0 ? `【待摘要原文】\n${pendingText}` : '',
  ].filter((part) => part.length > 0).join('\n\n');
  return {
    user,
    through: Number.isSafeInteger(view.pendingVersion) ? view.pendingVersion : 0,
    generation: Number.isSafeInteger(view.generation) ? view.generation : 0,
    chars: pendingText.length,
  };
}
