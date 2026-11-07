/**
 * Acknowledgment speech policy: one short waiting line per turn.
 *
 * Trigger: the user message was delivered and the reply body has not started playing after
 * `ACK_DELAY_MS`. No tool name, category or task keyword participates: whether a tool is running
 * is irrelevant, only whether the answer is already speaking.
 *
 * The policy helpers are pure. The lane in `index.js` owns the per-turn ledger, timers, generation,
 * synthesis and playback; this module builds the prompts, validates the drafted lines, and owns
 * the two cache-only pieces: the priority verdict and the persona warm pool.
 */
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** The one trigger delay: two seconds after the user message is delivered. */
export const ACK_DELAY_MS = 3000;
export const ACK_DELAY_MIN_MS = 500;
export const ACK_DELAY_MAX_MS = 15_000;

/**
 * The wait before the cue: settings.json voice.ackDelayMs wins, then the plugin config, then the
 * shipping default. Clamped so a typo cannot silence the cue forever or make it fire immediately.
 */
export function resolveAckDelayMs(settings = null, config = null) {
  const saved = settings?.voice?.ackDelayMs;
  const configured = saved !== undefined ? saved : config?.voice?.ackDelayMs;
  const value = Number(configured);
  if (!Number.isFinite(value)) return ACK_DELAY_MS;
  return Math.min(ACK_DELAY_MAX_MS, Math.max(ACK_DELAY_MIN_MS, Math.round(value)));
}

/**
 * The body states the voice queue distinguishes for a turn. `not-started` and `synthesizing` both
 * leave the audio seat free: until the body's first clip has audio, there is nothing a short line
 * could delay, so the line may speak in both. Only `ready` (the audio exists) yields the turn to
 * the body, and a sounding body is never cut.
 */
export const ACK_BODY_PHASES = Object.freeze({
  idle: 'not-started',
  synthesizing: 'synthesizing',
  ready: 'ready',
  playing: 'playing',
});

/** Waiting-line synthesis outranks queued (not yet running) body prefetch in the TTS slot queue. */
export const ACK_SYNTH_PRIORITY = 1;

/** A waiting line must be 10–30 characters; the prompt prefers 12–20. */
export const ACK_MIN_CHARS = 10;
export const ACK_MAX_CHARS = 30;
export const ACK_PREFERRED_MIN_CHARS = 12;
export const ACK_PREFERRED_MAX_CHARS = 20;

const ACK_USER_TEXT_MAX = 120;
const ACK_RECENT_TEXT_MAX = 80;
const ACK_RECENT_MAX = 3;
const ACK_PERSONA_MAX = 300;
const ACK_TIMEOUT_DEFAULT_MS = 1200;
const ACK_TIMEOUT_MIN_MS = 500;
const ACK_TIMEOUT_MAX_MS = 3000;

const ACK_MARKDOWN = /[*#`]/u;
const ACK_EMOJI = /\p{Extended_Pictographic}/u;
const ACK_TRAILING_PUNCT = /[。．.！!？?，,、；;：:…~～\s]+$/u;
const ACK_PATH_PATTERNS = Object.freeze([
  /[A-Za-z]:[\\/]/u,
  /\/home\//iu,
  /\/users\//iu,
  /\\/u,
]);
const ACK_QUOTE_PAIRS = Object.freeze([
  Object.freeze(['"', '"']),
  Object.freeze(["'", "'"]),
  Object.freeze(['“', '”']),
  Object.freeze(['‘', '’']),
  Object.freeze(['「', '」']),
  Object.freeze(['『', '』']),
]);

/**
 * Progress, result and time claims are never spoken by a waiting line. The model is told so, and
 * this list is the second line of defence: a rejected line is dropped, never repaired.
 */
const UNSAFE_ACK_TEXT = Object.freeze([
  /完成/u,
  /结果/u,
  /成功/u,
  /失败/u,
  /第\s*[0-9零〇一二三四五六七八九十百两]+\s*步/u,
  /秒/u,
  /分钟/u,
  /小时/u,
  /大约/u,
  /大概/u,
  /预计/u,
  /已经/u,
  /正在/u,
  /进度/u,
  /马上/u,
  /立刻/u,
  /稍后/u,
]);

/**
 * Remove one or two matching quote layers around a line, without touching quotes inside it.
 * @param {string} text
 * @returns {string}
 */
function stripAckWrappingQuotes(text) {
  let out = text;
  for (let pass = 0; pass < 2; pass += 1) {
    const chars = [...out];
    if (chars.length < 2) return out;
    const pair = ACK_QUOTE_PAIRS.find(
      ([open, close]) => chars[0] === open && chars[chars.length - 1] === close,
    );
    if (pair === undefined) return out;
    out = chars.slice(1, -1).join('').trim();
  }
  return out;
}

/** Normalise a spoken candidate: single line, no wrapping quotes, no trailing punctuation. */
function normalizeAckText(text) {
  let out = text.replace(/\s+/gu, ' ').trim();
  out = out.replace(ACK_TRAILING_PUNCT, '');
  out = stripAckWrappingQuotes(out);
  out = out.replace(ACK_TRAILING_PUNCT, '').trim();
  return out;
}

/**
 * Validate a model-generated waiting line before it may be spoken.
 *
 * A rejected line is never repaired into something speakable and never replaced by a canned
 * template: the caller reports `voice.ack.failed` and stays silent for that turn.
 *
 * `context` is the context block the request carried (persona/profile/memory/recent turns) and
 * `userText` the user's own words: a line that repeats either is an echo, not a reaction, and is
 * rejected even when its length is right.
 *
 * @param {*} text
 * @param {{context?: string, userText?: string}} [source]
 * @returns {{ok: boolean, line: string, reason: string}} `line` is empty when `ok` is false
 */
export function validateAckLine(text, { context = '', userText = '' } = {}) {
  if (typeof text !== 'string') return { ok: false, line: '', reason: 'not-string' };
  if (/[\r\n]/u.test(text)) return { ok: false, line: '', reason: 'multiline' };

  const line = normalizeAckText(text);
  if (line.length === 0) return { ok: false, line: '', reason: 'empty' };
  // Semantic safety comes first: a short but unsafe line is reported as unsafe, not as short.
  if (ACK_MARKDOWN.test(line)) return { ok: false, line: '', reason: 'markdown' };
  if (ACK_EMOJI.test(line)) return { ok: false, line: '', reason: 'emoji' };
  if (UNSAFE_ACK_TEXT.some((pattern) => pattern.test(line))) {
    return { ok: false, line: '', reason: 'progress' };
  }
  if (ACK_PATH_PATTERNS.some((pattern) => pattern.test(line))) {
    return { ok: false, line: '', reason: 'path' };
  }
  if (ackEchoesContext(line, { context, userText })) {
    return { ok: false, line: '', reason: 'echo' };
  }
  const length = [...line].length;
  if (length < ACK_MIN_CHARS) return { ok: false, line: '', reason: 'too-short' };
  if (length > ACK_MAX_CHARS) return { ok: false, line: '', reason: 'too-long' };
  return { ok: true, line, reason: 'ok' };
}

/** Minimum shared snippet for an echo; shorter overlaps are ordinary shared words. */
const ACK_ECHO_MIN_CHARS = 8;
const ACK_ECHO_BIGRAM_RATIO = 0.8;

/** Comparable form: punctuation, symbols and spaces do not make a repeated line different. */
function echoKey(value) {
  return String(value ?? '').replace(/[\s\p{P}\p{S}]/gu, '');
}

/**
 * True when the line repeats the user's words or a context sentence. The full-sentence substring
 * check catches an outright copy; the bigram ratio catches a lightly reworded copy. A normal
 * reaction shares only everyday words, well under the threshold.
 *
 * @param {string} line
 * @param {{context?: string, userText?: string}} [source]
 * @returns {boolean}
 */
export function ackEchoesContext(line, { context = '', userText = '' } = {}) {
  const candidate = echoKey(line);
  if ([...candidate].length < ACK_ECHO_MIN_CHARS) return false;
  const references = [String(userText ?? '')]
    .concat(String(context ?? '').split(/[。！？!?；;\n]+/u))
    .map((value) => echoKey(value))
    .filter((value) => [...value].length >= ACK_ECHO_MIN_CHARS);
  for (const reference of references) {
    if (reference.includes(candidate) || candidate.includes(reference)) return true;
    const grams = new Set();
    for (let index = 0; index + 1 < reference.length; index += 1) grams.add(reference.slice(index, index + 2));
    if (grams.size === 0) continue;
    let hit = 0;
    let total = 0;
    for (let index = 0; index + 1 < candidate.length; index += 1) {
      total += 1;
      if (grams.has(candidate.slice(index, index + 2))) hit += 1;
    }
    if (total > 0 && hit / total >= ACK_ECHO_BIGRAM_RATIO) return true;
  }
  return false;
}

const ACK_PROMPT_PATH_REDACTIONS = Object.freeze([
  Object.freeze({
    pattern: /[A-Za-z]:[\\/][^\s，。；、）)】"'`]*/gu,
    replacement: '[路径]',
  }),
  Object.freeze({
    pattern: /(?:\/home|\/users|\/root|\/tmp)\/[^\s，。；、）)】"'`]*/giu,
    replacement: '[路径]',
  }),
  Object.freeze({
    pattern: /\\[^\s，。；、）)】"'`]*/gu,
    replacement: '[路径]',
  }),
]);
const ACK_PROMPT_COMMAND_TAIL = /(?:^|\s)(?:--command|-command|-c)\s+[\s\S]*$/iu;

function clipText(text, limit) {
  return [...text].slice(0, limit).join('');
}

/**
 * Prepare the user's words for the prompt: redact paths and a command tail, flatten whitespace,
 * and cap the length.
 *
 * @param {*} value
 * @param {number} limit
 * @returns {string}
 */
function sanitizePromptText(value, limit) {
  let text = typeof value === 'string' ? value : '';
  text = text.replace(ACK_PROMPT_COMMAND_TAIL, ' [已省略]');
  for (const { pattern, replacement } of ACK_PROMPT_PATH_REDACTIONS) {
    text = text.replace(pattern, replacement);
  }
  text = text.replace(/\s+/gu, ' ').trim();
  return clipText(text, limit);
}

/**
 * Build the messages for one independent, short generation request.
 *
 * The request is self-contained: it carries the persona and this turn's user message, a few
 * recent lines (at most `ACK_RECENT_MAX`) to avoid repeating a line just used, and nothing else
 * from the conversation — no memory retrieval and no chat history. It asks for one short Chinese
 * spoken line that sounds like the companion reacting to what the user just said, so the line is
 * never unrelated to the persona or the request. Tool names and tool arguments deliberately never
 * enter the prompt.
 *
 * @param {{persona?: string, userText?: string, language?: string, recent?: string[]}} [input]
 * @returns {{messages: Array<{role: 'system'|'user', content: string}>}}
 */
export function buildAckPrompt({ persona, userText, language, recent } = {}) {
  const personaText = typeof persona === 'string' ? clipText(persona.trim(), ACK_PERSONA_MAX) : '';
  const said = sanitizePromptText(userText, ACK_USER_TEXT_MAX);
  const lang = sanitizePromptText(language, 20) || 'zh-CN';
  const recentLines = (Array.isArray(recent) ? recent : [])
    .map((line) => sanitizePromptText(line, ACK_RECENT_TEXT_MAX))
    .filter((line) => line.length > 0)
    .slice(-ACK_RECENT_MAX);

  const system = [
    '你是一个语音助手，用户刚说完话，你要先接一句很短的过渡话，表示你这就去处理。',
    personaText.length > 0 ? `人设：${personaText}` : '人设：自然、简短、口语化。',
    '规则：',
    `1. 只输出一句中文口语，${ACK_MIN_CHARS}到${ACK_MAX_CHARS}个字，优先${ACK_PREFERRED_MIN_CHARS}到${ACK_PREFERRED_MAX_CHARS}个字。`,
    '2. 必须结合人设和用户这句话的内容，说一句自然的反应，不能答非所问。',
    '3. 不要说进度、结果、耗时或完成时间。',
    '4. 不要 Markdown、表情符号、引号或编号。',
    `语言环境：${lang}`,
    '只输出这一句话，不要解释。',
  ].join('\n');

  const user = [
    `用户刚才说：${said.length > 0 ? said : '（没有文字）'}`,
    recentLines.length > 0 ? `最近说过的几句（不要重复其中的说法）：\n${recentLines.map((line) => `- ${line}`).join('\n')}` : '',
    '请用一句话接住这句话，然后表示你这就去看。',
  ].filter((line) => line.length > 0).join('\n');

  return {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  };
}

/**
 * Resolve the budget for the independent generation request.
 *
 * @param {{config?: *}} [input]
 * @returns {number} milliseconds in the 500..3000 range, 1200 by default
 */
export function ackTimeoutMs({ config } = {}) {
  let raw;
  if (typeof config === 'number' || typeof config === 'string') {
    raw = config;
  } else if (config !== null && typeof config === 'object') {
    raw = config.ackTimeoutMs ?? config.ack?.timeoutMs ?? config.ackSpeech?.timeoutMs;
  }
  const value = typeof raw === 'number'
    ? raw
    : typeof raw === 'string' && raw.trim().length > 0
      ? Number(raw)
      : Number.NaN;
  if (!Number.isFinite(value)) return ACK_TIMEOUT_DEFAULT_MS;
  return Math.min(ACK_TIMEOUT_MAX_MS, Math.max(ACK_TIMEOUT_MIN_MS, Math.round(value)));
}

/**
 * A progress line is a status cue, never the answer. It gets 30 characters in total, so a "please
 * wait" line cannot hold the single playback seat for a whole paragraph. The cap applies only to a
 * line the caller explicitly tagged `purpose: 'progress'` or `purpose: 'ack'`; an untagged call is
 * standalone content and is spoken whole.
 */
export const PROGRESS_MAX_CHARS = 30;

/** The host prompt and tool description quote this: a cue is opted into, never guessed from text. */
export const PROGRESS_PURPOSE_HINT =
  "想做进度说明请显式传 purpose:'progress'（短确认传 'ack'）；不传 purpose 的一律按正文完整播报，不裁剪。";

/** True only for the purposes that opt into the 30-character cue cap. */
export function isCuePurpose(purpose) {
  return purpose === 'progress' || purpose === 'ack';
}

/**
 * @deprecated A line's opening words never make it a progress cue, so this never selects clipping.
 * Kept as an always-false shim for callers that still import it; use `isCuePurpose` / `planSayText`.
 * @returns {false}
 */
export function looksLikeProgressLine() {
  return false;
}

/** The first sentence/comma is the natural cut point of an overlong progress line. */
const PROGRESS_LINE_CUT = /[。．.！!？?；;，,、：:]/u;
const PROGRESS_TRAILING_PUNCT = /[。．.！!？?，,、；;：:…~～\s]+$/u;

/**
 * Cap one progress line. An overlong line is cut before the first sentence/comma marker when that
 * prefix fits the cap, otherwise hard-cut at the cap; trailing punctuation is dropped so the
 * spoken cue stays clean. Returns the spoken text plus the length facts for the event log.
 *
 * @param {*} text
 * @param {{maxChars?: number}} [options]
 * @returns {{text: string, chars: number, originalChars: number, clipped: boolean}}
 */
export function clipProgressLine(text, { maxChars = PROGRESS_MAX_CHARS } = {}) {
  const source = typeof text === 'string' ? text.trim() : '';
  const chars = [...source];
  const raw = Number(maxChars);
  const limit = Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : PROGRESS_MAX_CHARS;
  if (chars.length <= limit) {
    return { text: source, chars: chars.length, originalChars: chars.length, clipped: false };
  }
  let head = source;
  const cut = source.search(PROGRESS_LINE_CUT);
  if (cut > 0 && [...source.slice(0, cut)].length <= limit) head = source.slice(0, cut);
  if ([...head].length > limit) head = chars.slice(0, limit).join('');
  head = head.replace(PROGRESS_TRAILING_PUNCT, '').trim();
  if (head.length === 0) head = chars.slice(0, limit).join('').trim();
  return { text: head, chars: [...head].length, originalChars: chars.length, clipped: true };
}

/**
 * Decide the spoken text for one `assistant_say` call.
 *
 * Only an explicit cue purpose opts into the cap. An untagged call is content and is returned
 * verbatim even when it opens with "我先…"/"让我…"; no text prefix is inspected.
 *
 * @param {*} text
 * @param {{purpose?: string, maxChars?: number}} [options]
 * @returns {{text: string, chars: number, originalChars: number, clipped: boolean, cue: boolean}}
 */
export function planSayText(text, { purpose = '', maxChars = PROGRESS_MAX_CHARS } = {}) {
  const source = typeof text === 'string' ? text : '';
  if (!isCuePurpose(purpose)) {
    const chars = [...source].length;
    return { text: source, chars, originalChars: chars, clipped: false, cue: false };
  }
  return { ...clipProgressLine(source, { maxChars }), cue: true };
}

/**
 * Plan what to do with the waiting line once the reply body is ready to speak.
 *
 * Cancellation is terminal. A result that arrives after a mute, an interruption or a superseded
 * turn must be discarded, never used to restart the line or to speak over the new turn.
 *
 * @param {{ackStarted?: boolean, answerReady?: boolean, muted?: boolean,
 *          interrupted?: boolean, superseded?: boolean}} input
 * @returns {{action: 'skip'|'finish-ack-then-answer'|'cancel'|'speak', reason?: string,
 *            lateResult?: 'discard', revive?: boolean}}
 */
export function planAckPlayback({
  ackStarted = false,
  answerReady = false,
  muted = false,
  interrupted = false,
  superseded = false,
} = {}) {
  const stopReason = interrupted ? 'interrupted' : muted ? 'muted' : superseded ? 'superseded' : '';
  if (stopReason.length > 0) {
    return { action: 'cancel', reason: stopReason, lateResult: 'discard', revive: false };
  }
  if (answerReady && !ackStarted) return { action: 'skip', reason: 'answer-first' };
  if (ackStarted && answerReady) return { action: 'finish-ack-then-answer' };
  return { action: 'speak' };
}

/**
 * A1 priority verdict for one waiting-line request at the two-second trigger.
 *
 * The reply body is tracked as one of `ACK_BODY_PHASES`. A body with no audio yet never speaks
 * first: `not-started` and `synthesizing` both yield `play`, so the line sounds exactly as before
 * even when synthesis takes many seconds, and a warm hit is kept the same way (it is a fully
 * prepared line, not a queued request). Only a body whose first clip is `ready` cancels the line
 * (`cancel`, `body-ready`) so the answer speaks first. An already sounding line is always kept
 * (existing finish-first rule), and a `playing` body keeps the existing cancel rule.
 *
 * The verdict carries the event the lane records for the decision: `kept` when the line stays
 * (`voice.ack.kept {reason:'body-synthesizing'}`) and `cancelled` when it is dropped.
 *
 * @param {{bodyPhase?: string, ackPlaying?: boolean}} [input]
 * @returns {{action: 'play'|'keep'|'cancel', reason: string,
 *            event?: 'kept'|'cancelled'}}
 */
export function planAckPriority({ bodyPhase = ACK_BODY_PHASES.idle, ackPlaying = false } = {}) {
  if (ackPlaying) return { action: 'keep', reason: 'ack-playing' };
  if (bodyPhase === ACK_BODY_PHASES.playing) {
    return { action: 'cancel', reason: 'body-first-audio', event: 'cancelled' };
  }
  if (bodyPhase === ACK_BODY_PHASES.synthesizing) {
    // No audio exists yet, so the line cannot delay the body: play it, including on a warm hit.
    return { action: 'play', reason: 'body-synthesizing', event: 'kept' };
  }
  if (bodyPhase === ACK_BODY_PHASES.ready) {
    return { action: 'cancel', reason: 'body-ready', event: 'cancelled' };
  }
  return { action: 'play', reason: 'body-not-started' };
}

// ---------------------------------------------------------------------------
// A2: persona warm pool — generic waiting lines, synthesized ahead of time
// ---------------------------------------------------------------------------

/** Hard cap on the warm pool; the oldest entry is evicted (and its file removed) first. */
export const ACK_WARM_CAPACITY = 6;
/** How many of the most recently used lines `take()` avoids: only a pool of these may reuse one. */
export const ACK_WARM_RECENT_AVOID = 2;
/**
 * The prompt revision and the identity fields form the cache key exactly as before: no group or
 * capacity field joins it. The new warm-text rules therefore fill an existing short pool up to the
 * new capacity instead of discarding audio the current identity can still serve.
 */
export const ACK_WARM_PROMPT_VERSION = 1;
/** One manifest file beside the warm audio, recording the identity and the LRU entries. */
const ACK_WARM_MANIFEST = 'manifest.json';

/**
 * A warm line is a generic "I am here / give me a moment" reaction. It must never claim that a
 * concrete action is underway or promised: those statements can be false by the time they play.
 * The progress/time list in `validateAckLine` already rejects most of them; this list closes the
 * remaining action words that would turn a generic line into a claim.
 */
const WARM_COMMITMENT = /查|搜|处理|资料|数据库|文件|文档|代码|网页|网上|获取/u;

/**
 * The four uses a warm line may serve. A line whose use cannot be told from its words is
 * `general`. The prompt asks for `ACK_WARM_GROUP_MIN` lines per use; the pool itself still keeps
 * at most `ACK_WARM_CAPACITY`, balanced across the groups so every use is represented.
 */
export const ACK_WARM_GROUPS = Object.freeze({
  general: Object.freeze({ id: 'general', label: '通用等待', hint: '只说你在听、在准备，不针对任何具体内容' }),
  question: Object.freeze({ id: 'question', label: '承接疑问', hint: '接住对方的疑问，表示你听清了这个问题' }),
  accept: Object.freeze({ id: 'accept', label: '接受请求', hint: '表示收到并愿意配合，不说要做什么或要多久' }),
  company: Object.freeze({ id: 'company', label: '温和陪伴', hint: '陪着对方等，语气温和不急' }),
});
export const ACK_WARM_GROUP_IDS = Object.freeze(Object.keys(ACK_WARM_GROUPS));
/** Lines per use in the generation request; a fixed palette is never used as a fallback line. */
export const ACK_WARM_GROUP_MIN = 2;

/** The first matching marker decides the use; order matters (`好的…你说…` is an acceptance). */
const WARM_GROUP_MARKERS = Object.freeze([
  Object.freeze({ id: 'accept', pattern: /(好的|好呀|行啊|可以|没问题|收到|明白|听见了|交给我|放心|这就|来啦|来了)/u }),
  Object.freeze({ id: 'question', pattern: /(你说|说说|讲讲|你问|问吧|什么问题|什么事|怎么回事|怎么啦|哪里)/u }),
  Object.freeze({ id: 'company', pattern: /(陪|等|慢慢|不急|别急|在呢|在这儿|一直|安心|守着)/u }),
]);

/**
 * The use a warm line serves, from its words alone. No match means the use cannot be told, so the
 * line joins the general group rather than inventing a purpose.
 *
 * @param {*} text
 * @returns {'general'|'question'|'accept'|'company'}
 */
export function classifyWarmLine(text) {
  const line = String(text ?? '');
  for (const marker of WARM_GROUP_MARKERS) {
    if (marker.pattern.test(line)) return marker.id;
  }
  return 'general';
}

const WARM_FILLER = /[啊呀吧呢啦哦嘛哈哟噢唉诶嘿嗯]/gu;
const WARM_NOISE = /[\s\p{P}\p{S}]/gu;

/** Wording identity: fillers, punctuation and spacing never make a repeated line new. */
export function warmTextKey(text) {
  return String(text ?? '').replace(WARM_NOISE, '').replace(WARM_FILLER, '');
}

/** Sentence skeletons that count as one shape even when the wording around them differs. */
const WARM_SHAPES = Object.freeze([
  Object.freeze(['look', /^(?:让我|叫我|我|咱们|我们)?(?:先|来|去|再)?(?:看看|看一下|看一眼|瞧瞧|看)/u]),
  Object.freeze(['think', /^(?:让我|叫我|我)?(?:先|来|再)?(?:想想|想一下|想一想|想)/u]),
  Object.freeze(['say', /^(?:你|您)?(?:先)?(?:说说|讲讲|说|讲)/u]),
  Object.freeze(['hear', /^(?:我)?(?:在|先)?(?:听听|听你说|听着|听)/u]),
  Object.freeze(['wait', /^(?:你|您)?(?:先)?(?:等一等|等等|等一下|稍等|等)/u]),
]);

/**
 * The sentence shape of a line: 我看看、我来看看、让我看看 share one shape. A line outside
 * every known family only shares a shape with the identical wording, so unrelated lines are never
 * suppressed by accident.
 *
 * @param {*} text
 * @returns {string}
 */
export function warmShapeKey(text) {
  const line = warmTextKey(text);
  for (const [id, pattern] of WARM_SHAPES) {
    if (pattern.test(line)) return id;
  }
  return `w:${line}`;
}

/**
 * Pick up to `limit` items, always taking the one whose group is least represented so far, and
 * update `counts` in place. This is what keeps four uses inside a six-line budget.
 *
 * @param {Array<{group: string}>} items
 * @param {{limit?: number, counts?: Map<string, number>}} [options]
 * @returns {Array<{group: string}>}
 */
function spreadWarmGroups(items, { limit = ACK_WARM_CAPACITY, counts = new Map() } = {}) {
  const pool = items.slice();
  const picked = [];
  while (pool.length > 0 && picked.length < limit) {
    let best = 0;
    for (let index = 1; index < pool.length; index += 1) {
      if ((counts.get(pool[index].group) ?? 0) < (counts.get(pool[best].group) ?? 0)) best = index;
    }
    const [item] = pool.splice(best, 1);
    counts.set(item.group, (counts.get(item.group) ?? 0) + 1);
    picked.push(item);
  }
  return picked;
}

/**
 * Order the model's lines into the entries one build may synthesize.
 *
 * Exact wording (after filler/punctuation normalization) is dropped. A second line in an already
 * used sentence shape is kept back and picked only when the remaining room cannot be filled
 * without it, at weight 0.5 so `take()` prefers a unique-shape line while both are in the pool.
 * Groups are interleaved least-represented first, so even a six-line pool covers every use.
 *
 * @param {string[]} lines
 * @param {{capacity?: number, existing?: string[]}} [options]
 * @returns {Array<{text: string, group: string, shape: string, weight: number}>}
 */
export function planWarmCandidates(lines, { capacity = ACK_WARM_CAPACITY, existing = [] } = {}) {
  const cap = Math.max(1, Math.min(ACK_WARM_CAPACITY, Math.floor(Number(capacity) || ACK_WARM_CAPACITY)));
  const previous = (Array.isArray(existing) ? existing : [existing])
    .filter((line) => typeof line === 'string' && line.length > 0);
  const known = new Set(previous.map((line) => warmTextKey(line)));
  const taken = new Set(previous.map((line) => warmShapeKey(line)));
  const groups = new Map();
  for (const line of previous) {
    const group = classifyWarmLine(line);
    groups.set(group, (groups.get(group) ?? 0) + 1);
  }
  const unique = [];
  const reused = [];
  for (const raw of Array.isArray(lines) ? lines : [lines]) {
    const checked = validateWarmLine(raw);
    if (!checked.ok) continue;
    const key = warmTextKey(checked.line);
    if (known.has(key)) continue;
    known.add(key);
    const shape = warmShapeKey(checked.line);
    const item = { text: checked.line, group: classifyWarmLine(checked.line), shape };
    if (taken.has(shape)) {
      reused.push({ ...item, weight: 0.5 });
    } else {
      taken.add(shape);
      unique.push({ ...item, weight: 1 });
    }
  }
  const room = Math.max(0, cap - previous.length);
  const picked = [];
  for (const list of [unique, reused]) {
    picked.push(...spreadWarmGroups(list, { limit: room - picked.length, counts: groups }));
  }
  return picked;
}

/**
 * Cache key: persona hash + speech language + voice + model version, plus the prompt revision.
 * Any change must rebuild the pool instead of serving audio recorded for another persona/engine.
 */
export function ackWarmFingerprint({ persona = '', language = '', voice = '', modelVersion = '' } = {}) {
  return Object.freeze({
    promptVersion: ACK_WARM_PROMPT_VERSION,
    persona: createHash('sha256').update(String(persona ?? ''), 'utf8').digest('hex').slice(0, 16),
    language: String(language ?? ''),
    voice: String(voice ?? ''),
    modelVersion: String(modelVersion ?? ''),
  });
}

/** Stable, short key for the cache row and the event log. */
export function ackWarmKey(input = {}) {
  const fingerprint = ackWarmFingerprint(input);
  return createHash('sha256')
    .update([
      fingerprint.promptVersion,
      fingerprint.persona,
      fingerprint.language,
      fingerprint.voice,
      fingerprint.modelVersion,
    ].join('\u0000'), 'utf8')
    .digest('hex')
    .slice(0, 16);
}

/**
 * Prompt for the background warm build: only generic waiting lines, never a reaction to a task.
 *
 * The request covers the four uses, `ACK_WARM_GROUP_MIN` lines each, so the model has to vary both
 * wording and sentence shape; the pool still keeps at most its own capacity. The persona is quoted
 * verbatim and the tone rule makes the lines sound like that companion, not a neutral announcer.
 *
 * @param {{persona?: string, language?: string, count?: number}} [input]
 * @returns {{system: string, user: string, chars: number}}
 */
export function buildAckWarmPrompt({ persona, language, count = ACK_WARM_CAPACITY } = {}) {
  const personaText = typeof persona === 'string' ? clipText(persona.trim(), ACK_PERSONA_MAX) : '';
  const amount = Math.max(1, Math.min(ACK_WARM_CAPACITY, Math.floor(Number(count) || ACK_WARM_CAPACITY)));
  const ask = Math.max(amount, ACK_WARM_GROUP_IDS.length * ACK_WARM_GROUP_MIN);
  const lang = sanitizePromptText(language, 20) || 'zh-CN';
  const uses = ACK_WARM_GROUP_IDS
    .map((id) => `- ${ACK_WARM_GROUPS[id].label}：${ACK_WARM_GROUPS[id].hint}`)
    .join('\n');
  const order = ACK_WARM_GROUP_IDS.map((id) => ACK_WARM_GROUPS[id].label).join('、');
  const system = [
    '你要为语音助手准备几句通用的等候短句，供来不及马上回答时先接一句。',
    personaText.length > 0 ? `人设：${personaText}` : '人设：自然、简短、口语化。',
    '语气规则：',
    '1. 必须完全用这个人设的语气说话：称呼、口头禅、语气词都像这个人本人在接话。',
    `2. 四种用途各写${ACK_WARM_GROUP_MIN}句，并按下述顺序轮流写，每句只属于一种用途：`,
    uses,
    `3. 这${ask}句之间措辞和句式都不能重复，不要都用同一个开头，同一人设下不产生重复说法。`,
    `4. 每句${ACK_MIN_CHARS}到${ACK_MAX_CHARS}个字，优先${ACK_PREFERRED_MIN_CHARS}到${ACK_PREFERRED_MAX_CHARS}个字。`,
    '5. 每句都与具体任务无关，只表示你在听、在准备，不针对任何具体对象。',
    '6. 不得出现查、搜、处理、资料、进度、结果、完成、成功、失败、马上、稍后、时间或时长。',
    '7. 不要 Markdown、表情符号、引号、编号；每行一句。',
    `语言环境：${lang}`,
    '只输出这些句子，不要解释。',
  ].join('\n');
  const user = `请按${order}的顺序轮流各写一句，共${ACK_WARM_GROUP_MIN}轮，每行一句。`;
  return { system, user, chars: [...system].length + [...user].length };
}

/**
 * Validate one warm line. Generic waiting lines are stricter than a per-turn draft: a line may not
 * name an action that might not happen.
 *
 * @param {*} text
 * @returns {{ok: boolean, line: string, reason: string}}
 */
export function validateWarmLine(text) {
  const checked = validateAckLine(text);
  if (!checked.ok) return checked;
  if (WARM_COMMITMENT.test(checked.line)) return { ok: false, line: '', reason: 'commitment' };
  return checked;
}

/**
 * Parse a model answer into distinct valid warm lines. Numbering/bullets are stripped; an invalid
 * line is dropped, never repaired.
 *
 * @param {*} text
 * @param {number} limit
 * @returns {string[]}
 */
export function parseWarmLines(text, limit = ACK_WARM_CAPACITY) {
  const cap = Math.max(1, Math.min(ACK_WARM_CAPACITY, Math.floor(Number(limit) || ACK_WARM_CAPACITY)));
  const lines = String(text ?? '')
    .split(/\r?\n/u)
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)、])\s*/u, '').trim())
    .filter((line) => line.length > 0);
  const valid = [];
  const seen = new Set();
  for (const line of lines) {
    const checked = validateWarmLine(line);
    if (!checked.ok) continue;
    // Wording identity ignores fillers/punctuation: a "different" duplicate never enters the pool.
    const key = warmTextKey(checked.line);
    if (seen.has(key)) continue;
    seen.add(key);
    valid.push(checked.line);
  }
  // When the answer is longer than the room, keep the uses spread instead of the first N lines:
  // the model answers use by use, so a plain slice would leave later uses with nothing.
  if (valid.length <= cap) return valid;
  const spread = spreadWarmGroups(valid.map((line) => ({ text: line, group: classifyWarmLine(line) })), {
    limit: cap,
  });
  return spread.map((item) => item.text);
}

/**
 * Change reason for the rebuild event: which part of the identity no longer matches.
 * @param {object|null} previous
 * @param {object} next
 * @returns {string}
 */
function warmChangedReason(previous, next) {
  if (previous === null || previous === undefined) return 'missing';
  if (previous.promptVersion !== next.promptVersion) return 'prompt-version';
  for (const field of ['persona', 'language', 'voice', 'modelVersion']) {
    if (previous[field] !== next[field]) return `${field}-changed`;
  }
  return 'key-changed';
}

/**
 * A2 warm pool: up to `capacity` persona-appropriate generic waiting lines, synthesized ahead of
 * time under `dir` and served from memory.
 *
 * The pool is deliberately passive: it never plays anything and it never starts a request on its
 * own. The host schedules `build()` only after an idle window; `take()` is a synchronous, cheap
 * lookup on the delivery path. A missing/partial pool is not an error: the lane falls back to its
 * existing per-turn draft, so the first start never blocks chat.
 *
 * Events: `voice.ack.warm {built, ms, key}` after one build,
 * `voice.ack.cache.rebuild {reason, key}` whenever a key change (or missing manifest) discards the
 * previous files, `voice.ack.warm.discarded {reason:'disposed'|'cancelled'|'superseded'}` when
 * a build's generation is cancelled before its manifest is committed, and
 * `voice.ack.warm.cleanup-skipped {reason:'newer-owner'}` when a late cleanup finds the manifest
 * rewritten by a newer batch and leaves it (and the audio it serves) in place.
 *
 * @param {object} options
 * @returns {{ensure: Function, take: Function, build: Function, clear: Function, dispose: Function,
 *            status: Function}}
 */
export function createAckWarmPool({
  dir = '',
  meta = () => ({}),
  generate = null,
  synthesize = null,
  emit = async () => {},
  capacity = ACK_WARM_CAPACITY,
  now = () => Date.now(),
  readTextFile = readFile,
  writeTextFile = writeFile,
  renameFile = rename,
  removeFile = unlink,
  removeTree = rm,
  makeDir = mkdir,
  accessFile = access,
} = {}) {
  const cap = Math.max(1, Math.min(ACK_WARM_CAPACITY, Math.floor(Number(capacity) || ACK_WARM_CAPACITY)));
  const manifestPath = () => join(dir, ACK_WARM_MANIFEST);
  /** Current entries in LRU order: least recently used first. */
  let entries = [];
  /** Wording keys of the last used lines, oldest first: `take()` never reuses them immediately. */
  let recent = [];
  let lastUsedAt = 0;
  let loadedKey = '';
  let fingerprint = null;
  let loaded = false;
  /** The active build run. A newer build supersedes it; `clear()`/`dispose()` cancel it. */
  let building = null;
  /** Bumped by every new build, `clear()` and `dispose()`: an older token can never persist. */
  let generation = 0;
  let disposed = false;
  const log = async (type, payload) => {
    try {
      await emit(type, payload);
    } catch {
      /* the event log is best-effort */
    }
  };
  const metaNow = () => {
    const value = typeof meta === 'function' ? meta() : meta;
    return value !== null && typeof value === 'object' ? value : {};
  };
  const currentKey = () => ackWarmKey(metaNow());
  const fileExists = async (file) => {
    if (typeof file !== 'string' || file.length === 0) return false;
    try {
      await accessFile(file);
      return true;
    } catch {
      return false;
    }
  };
  /** Remove every cached file and the manifest; the caller decides whether to report the rebuild. */
  const clearFiles = async () => {
    entries = [];
    recent = [];
    lastUsedAt = 0;
    loadedKey = '';
    loaded = false;
    fingerprint = null;
    if (dir.length === 0) return;
    try {
      await removeTree(dir, { recursive: true, force: true });
    } catch {
      /* a missing/locked directory is not fatal: entries are already empty */
    }
  };
  const rebuild = async (reason) => {
    const key = currentKey();
    await clearFiles();
    await log('voice.ack.cache.rebuild', { reason, key });
  };
  /** Invalidate every older token; the active run learns why it may not finish. */
  const cancelBuild = (reason) => {
    generation += 1;
    if (building !== null && building.cancelled !== true) {
      building.cancelled = true;
      building.reason = reason;
    }
  };
  /** The one predicate every build checkpoint and `persist()` consult. */
  const isStale = (run) => disposed === true || run.cancelled === true || run.token !== generation;
  /**
   * Remove only the files this run owns. The manifest is shared, so a committed one is removed
   * only while the file still names this batch as its writer (`manifestOwner`) and no newer
   * generation exists; otherwise the newer batch's manifest stays and an ownership conflict is
   * reported as `voice.ack.warm.cleanup-skipped {reason:'newer-owner'}`. Audio files referenced by
   * the current entries are never removed: a newer manifest may serve them.
   */
  const cleanupRun = async (run) => {
    const written = Array.isArray(run.written) ? run.written.splice(0) : [];
    for (const file of written) await removeFile(file).catch(() => {});
    if (run.manifestCommitted === true) {
      run.manifestCommitted = false;
      let owner = null;
      try {
        owner = JSON.parse(await readTextFile(manifestPath(), 'utf8'))?.manifestOwner ?? null;
      } catch {
        owner = null; // already gone (reset/earlier cleanup): nothing to remove or skip
      }
      if (owner !== null && (owner !== run.token || run.token !== generation)) {
        await log('voice.ack.warm.cleanup-skipped', { reason: 'newer-owner' });
      } else if (owner !== null) {
        await removeFile(manifestPath()).catch(() => {});
      }
    }
    for (const entry of run.added) {
      // The current entries may serve this clip: a newer batch loaded it from our manifest.
      if (entries.some((current) => current.file === entry.file)) continue;
      await removeFile(entry.file).catch(() => {});
    }
    // A directory this run created (or found absent) is removable; a newer run may own it now.
    if (building === run && (run.dirCreated === true || run.dirExisted !== true)) {
      await removeTree(dir, { recursive: true, force: true }).catch(() => {});
    }
  };
  /**
   * A disposed, cleared or superseded batch is never committed: its files are removed and the drop
   * is reported once. `persist()` calls this only after it has re-checked the run's token.
   */
  const discard = async (run, startedAt, key) => {
    if (run.discarded === true) return null;
    run.discarded = true;
    const reason = disposed === true ? 'disposed' : (run.reason || 'cancelled');
    await cleanupRun(run);
    await log('voice.ack.warm.discarded', { reason });
    return { built: 0, ms: Math.max(0, now() - startedAt), key, stale: true, discarded: reason };
  };
  const persist = async (run, { key, nextEntries, nextFingerprint }) => {
    if (dir.length === 0) return true;
    // Requirement: the token is re-checked immediately before the write, not only in the loop.
    if (isStale(run) === true) return false;
    await makeDir(dir, { recursive: true });
    run.dirCreated = run.dirExisted !== true;
    if (isStale(run) === true) return false;
    const body = JSON.stringify({
      key,
      fingerprint: nextFingerprint,
      manifestOwner: run.token,
      entries: nextEntries.map((entry) => ({
        text: entry.text,
        file: entry.file,
        durationMs: entry.durationMs,
        bytes: entry.bytes,
        provider: entry.provider,
        at: entry.at,
        group: entry.group,
        shape: entry.shape,
        weight: entry.weight,
        uses: entry.uses,
        usedAt: entry.usedAt,
      })),
      updatedAt: now(),
    }, null, 2);
    // Batch identity is part of the temporary name: an older batch can only ever remove its own.
    const tmp = `${manifestPath()}.${run.token}.tmp`;
    run.written.push(tmp);
    await writeTextFile(tmp, `${body}\n`, 'utf8');
    // `dispose()` may have won the race while the manifest was being written.
    if (isStale(run) === true) return false;
    await renameFile(tmp, manifestPath());
    // The file is this run's, but a newer batch may already have renamed its own over it: the
    // `manifestOwner` field recorded above is the authority cleanup checks, not this flag.
    run.manifestCommitted = true;
    return true;
  };
  /**
   * Load the manifest for the current identity, rebuilding (and deleting old files) on any change.
   * Safe to call repeatedly; only a real identity change touches the disk.
   */
  const ensure = async () => {
    // A disposed pool is terminal: never read, rebuild or recreate its cache directory.
    if (disposed === true) return { key: currentKey(), rebuilt: false, reason: '' };
    const currentMeta = metaNow();
    const nextFingerprint = ackWarmFingerprint(currentMeta);
    const key = ackWarmKey(currentMeta);
    if (loaded === true && loadedKey === key && fingerprint !== null
      && fingerprint.persona === nextFingerprint.persona
      && fingerprint.language === nextFingerprint.language
      && fingerprint.voice === nextFingerprint.voice
      && fingerprint.modelVersion === nextFingerprint.modelVersion) {
      return { key, rebuilt: false, reason: '' };
    }
    if (dir.length === 0) {
      loaded = true;
      loadedKey = key;
      fingerprint = nextFingerprint;
      return { key, rebuilt: false, reason: '' };
    }
    let manifest = null;
    try {
      manifest = JSON.parse(await readTextFile(manifestPath(), 'utf8'));
    } catch {
      manifest = null;
    }
    const previousFingerprint = fingerprint ?? manifest?.fingerprint ?? null;
    const previousKey = loadedKey || (typeof manifest?.key === 'string' ? manifest.key : '');
    const changed = previousKey.length > 0 && previousKey !== key;
    if (changed) {
      const reason = warmChangedReason(previousFingerprint, nextFingerprint);
      await rebuild(reason);
      loaded = true;
      loadedKey = key;
      fingerprint = nextFingerprint;
      return { key, rebuilt: true, reason };
    }
    if (manifest === null) {
      if (previousKey.length > 0) await rebuild('missing');
      loaded = true;
      loadedKey = key;
      fingerprint = nextFingerprint;
      return { key, rebuilt: false, reason: previousKey.length > 0 ? 'missing' : '' };
    }
    // Same identity: restore only entries whose audio file still exists, newest-capacity last.
    const restored = [];
    for (const entry of Array.isArray(manifest.entries) ? manifest.entries : []) {
      if (typeof entry?.text !== 'string' || typeof entry?.file !== 'string') continue;
      if (await fileExists(entry.file)) restored.push({
        text: entry.text,
        file: entry.file,
        durationMs: Number(entry.durationMs) || 0,
        bytes: Number(entry.bytes) || 0,
        provider: String(entry.provider ?? ''),
        at: Number(entry.at) || 0,
        // Older manifests predate the grouping/rotation fields: derive them from the text.
        group: typeof entry.group === 'string' && ACK_WARM_GROUPS[entry.group] !== undefined
          ? entry.group
          : classifyWarmLine(entry.text),
        shape: typeof entry.shape === 'string' && entry.shape.length > 0
          ? entry.shape
          : warmShapeKey(entry.text),
        weight: Number(entry.weight) > 0 ? Number(entry.weight) : 1,
        uses: Number(entry.uses) || 0,
        usedAt: Number(entry.usedAt) || Number(entry.at) || 0,
      });
    }
    // A manifest written under a larger capacity keeps only the newest rows; older files are
    // removed here so the LRU cap is a real disk cap, not just an in-memory one.
    for (const stale of restored.slice(0, Math.max(0, restored.length - cap))) {
      await removeFile(stale.file).catch(() => {});
    }
    entries = restored.slice(-cap);
    loaded = true;
    loadedKey = key;
    fingerprint = nextFingerprint;
    return { key, rebuilt: false, reason: '' };
  };
  /**
   * Synchronous cache lookup. Never waits, never starts a request; `null` means "draft one".
   *
   * Rotation: the entries array is LRU order, so the first entry that is not one of the last
   * `ACK_WARM_RECENT_AVOID` used lines wins. Only a pool made entirely of those may reuse one, and
   * then the least recently used of them. A hit records its use time (monotonic even when `now()`
   * is a frozen clock) and moves to the back, so the next lookup advances.
   */
  const take = () => {
    if (loaded !== true || loadedKey.length === 0) return null;
    if (currentKey() !== loadedKey) return null;
    if (entries.length === 0) return null;
    const avoid = new Set(recent.slice(-ACK_WARM_RECENT_AVOID));
    let index = entries.findIndex((entry) => !avoid.has(warmTextKey(entry.text)));
    if (index < 0) index = 0;
    const [entry] = entries.splice(index, 1);
    const usedAt = Math.max(now(), lastUsedAt + 1);
    lastUsedAt = usedAt;
    entry.usedAt = usedAt;
    entry.uses = (Number(entry.uses) || 0) + 1;
    entries.push(entry);
    recent.push(warmTextKey(entry.text));
    while (recent.length > ACK_WARM_RECENT_AVOID) recent.shift();
    return {
      text: entry.text,
      file: entry.file,
      key: loadedKey,
      group: entry.group ?? classifyWarmLine(entry.text),
      audio: {
        file: entry.file,
        durationMs: entry.durationMs,
        bytes: entry.bytes,
        provider: entry.provider,
      },
    };
  };
  /**
   * Build the pool once. A new build supersedes an older one: every run carries a generation
   * token, and a token that is no longer current can never reach `persist()`. A cancelled or
   * disposed run removes only the files it wrote and reports `voice.ack.warm.discarded`; a
   * manifest already rewritten by a newer batch is left alone.
   */
  const build = async ({ signal = null } = {}) => {
    const startedAt = now();
    // A new run starts a new generation; the older batch is superseded, not joined.
    const previous = building;
    generation += 1;
    if (previous !== null && previous.cancelled !== true) {
      previous.cancelled = true;
      previous.reason = 'superseded';
    }
    const run = {
      token: generation,
      cancelled: false,
      reason: 'cancelled',
      added: [],
      written: [],
      manifestCommitted: false,
      dirExisted: false,
      dirCreated: false,
      discarded: false,
    };
    building = run;
    let key = '';
    const promise = (async () => {
      try {
        if (disposed === true) return discard(run, startedAt, key);
        run.dirExisted = dir.length > 0 ? await fileExists(dir) : false;
        if (isStale(run) === true) return discard(run, startedAt, key);
        const ensured = await ensure();
        key = ensured.key;
        if (isStale(run) === true) return discard(run, startedAt, key);
        if (typeof generate !== 'function' || typeof synthesize !== 'function') {
          return { built: 0, ms: Math.max(0, now() - startedAt), key };
        }
        if (entries.length >= cap) {
          await log('voice.ack.warm', { built: 0, ms: Math.max(0, now() - startedAt), key });
          return { built: 0, ms: Math.max(0, now() - startedAt), key };
        }
        let raw = [];
        try {
          raw = await generate({
            signal,
            count: cap - entries.length,
            persona: metaNow().persona ?? '',
            language: metaNow().language ?? '',
          });
        } catch {
          raw = [];
        }
        if (isStale(run) === true) return discard(run, startedAt, key);
        const candidates = (Array.isArray(raw) ? raw : [raw]).filter((line) => typeof line === 'string');
        // Wording dedupe, shape reuse only when short, and group spread happen here (pure).
        const planned = planWarmCandidates(candidates, {
          capacity: cap,
          existing: entries.map((entry) => entry.text),
        });
        let built = 0;
        const added = [];
        for (const candidate of planned) {
          if (isStale(run) === true) return discard(run, startedAt, key);
          if (signal?.aborted === true) break;
          if (entries.length + added.length >= cap) break;
          try {
            const audio = await synthesize({
              text: candidate.text,
              signal,
              dir,
              language: metaNow().language ?? '',
              voice: metaNow().voice ?? '',
            });
            // The batch may have been disposed/cleared/superseded while TTS ran.
            if (isStale(run) === true) return discard(run, startedAt, key);
            if (signal?.aborted === true) break;
            if (audio === null || typeof audio?.file !== 'string') continue;
            const entry = {
              text: candidate.text,
              group: candidate.group,
              shape: candidate.shape,
              weight: candidate.weight,
              uses: 0,
              usedAt: now(),
              file: audio.file,
              durationMs: Number(audio.durationMs) || 0,
              bytes: Number(audio.bytes) || 0,
              provider: String(audio.provider ?? ''),
              at: now(),
            };
            added.push(entry);
            run.added.push(entry);
            built += 1;
          } catch {
            /* one failed line never poisons the pool */
          }
        }
        // The identity may have changed while the model/TTS ran: never persist that batch.
        if (currentKey() !== key) {
          await clearFiles();
          return { built: 0, ms: Math.max(0, now() - startedAt), key, stale: true };
        }
        const nextFingerprint = ackWarmFingerprint(metaNow());
        const nextEntries = entries.concat(added);
        const evicted = [];
        while (nextEntries.length > cap) evicted.push(nextEntries.shift());
        let persisted = false;
        try {
          persisted = await persist(run, { key, nextEntries, nextFingerprint });
        } catch {
          // A guarded write seam (the host's run gate) refused a cancelled batch: the gate owns
          // the dropped-row event, so this path only removes the files this run touched. A pool
          // cancellation that broke the write still reports its own drop.
          await cleanupRun(run);
          if (isStale(run) === true) return discard(run, startedAt, key);
          return { built: 0, ms: Math.max(0, now() - startedAt), key, stale: true };
        }
        if (persisted !== true) return discard(run, startedAt, key);
        // `dispose()` may have won after the rename: roll the just-written manifest back.
        if (isStale(run) === true) return discard(run, startedAt, key);
        for (const evictedEntry of evicted) await removeFile(evictedEntry.file).catch(() => {});
        entries = nextEntries;
        loaded = true;
        loadedKey = key;
        fingerprint = nextFingerprint;
        const ms = Math.max(0, now() - startedAt);
        await log('voice.ack.warm', { built, ms, key });
        return { built, ms, key };
      } catch {
        await cleanupRun(run);
        if (isStale(run) === true) return discard(run, startedAt, key);
        return { built: 0, ms: Math.max(0, now() - startedAt), key, stale: true };
      }
    })();
    try {
      return await promise;
    } finally {
      if (building === run) building = null;
    }
  };
  const clear = async (reason = 'manual') => {
    // A clear invalidates the in-flight generation before deleting the files it may still write.
    cancelBuild('cancelled');
    await rebuild(reason);
  };
  /** Teardown: terminal. A build that is still running sees `disposed` and never persists. */
  const dispose = async () => {
    if (disposed === true) return;
    disposed = true;
    cancelBuild('disposed');
    await clearFiles();
  };
  const status = () => ({
    key: loadedKey,
    loaded,
    capacity: cap,
    entries: entries.length,
    texts: entries.map((entry) => entry.text),
    groups: entries.map((entry) => entry.group ?? classifyWarmLine(entry.text)),
    weights: entries.map((entry) => (Number(entry.weight) > 0 ? Number(entry.weight) : 1)),
    recent: recent.slice(),
  });
  return { ensure, take, build, clear, dispose, status };
}
