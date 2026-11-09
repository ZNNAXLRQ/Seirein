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
 * Read-aloud cleanup for a model-produced spoken version. Every rule only removes presentation
 * (Markdown emphasis/backticks) or punctuation that is not spoken (paired quotation/book-title
 * wrappers keep their content, em dashes become a comma pause, emoji/decorative symbols and
 * redundant whitespace disappear). No content word is ever deleted.
 * @param {string} value
 * @returns {string}
 */
function cleanSpokenText(value) {
  let text = String(value ?? '');
  // Fenced code lines and inline-code backticks: keep the code text itself, drop the markers.
  text = text.replace(/```[^\n]*\n?/gu, '');
  text = text.replace(/`([^`\n]+)`/gu, '$1').replace(/`/gu, '');
  // Markdown emphasis pairs. `_` is only treated as emphasis in a pair, so `foo_bar` survives.
  text = text.replace(/\*\*([^*\n]+)\*\*/gu, '$1');
  text = text.replace(/__([^_\n]+)__/gu, '$1');
  text = text.replace(/(^|[^*\w])\*([^*\n]+)\*(?=[^*\w]|$)/gu, '$1$2');
  text = text.replace(/(^|[^_\w])_([^_\n]+)_(?=[^_\w]|$)/gu, '$1$2');
  // Paired quotation / book-title wrappers: the marks are not spoken, their content is kept.
  text = text.replace(/“([^“”]*)”/gu, '$1');
  text = text.replace(/‘([^‘’]*)’/gu, '$1');
  text = text.replace(/「([^「」]*)」/gu, '$1');
  text = text.replace(/『([^『』]*)』/gu, '$1');
  text = text.replace(/《([^《》]*)》/gu, '$1');
  text = text.replace(/〈([^〈〉]*)〉/gu, '$1');
  text = text.replace(/"([^"\n]*)"/gu, '$1');
  // A lone wrapper at either end is the same shape; strip it rather than speaking it.
  text = text.replace(/^["「『“'"‘《〈]+/u, '').replace(/["」』”'"’》〉]+$/u, '');
  // An em dash is a pause, not a word.
  text = text.replace(/——/gu, '，').replace(/—/gu, '，');
  // Emoji, variation selectors, joiners and decorative symbol characters are never spoken.
  text = text.replace(
    /[\p{Extended_Pictographic}\uFE0F\u200D\u20E3\u{1F1E6}-\u{1F3FF}]/gu,
    '',
  );
  text = text.replace(/\p{So}/gu, '');
  // Only presentation whitespace is removed; words, numbers and sentence punctuation stay.
  text = text.replace(/\s*\n+\s*/gu, ' ').replace(/[ \t]+/gu, ' ').trim();
  return text;
}

/**
 * Validate a model-produced spoken version. The candidate is first cleaned for reading (see
 * `cleanSpokenText`); similarity is never used to delete anything. Only the shape is checked
 * (non-empty, not longer than the source, no model preamble/quoting), and every failure is
 * reported with a reason so the caller can fall back to the full body. Length equality is
 * allowed: turn 11 produced a 166-character spoken version for a 166-character body and the old
 * `>=` check rejected a usable answer.
 * @returns {{ok: boolean, text: string, chars: number, reason: string}}
 */
export function normalizeSpokenVersion(source, candidate) {
  const original = String(source ?? '').trim();
  let text = String(candidate ?? '').trim();
  text = text.replace(/^(?:口语版|口播版|语音版|spoken\s*version|speech)\s*[:：]\s*/iu, '');
  text = cleanSpokenText(text);
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
