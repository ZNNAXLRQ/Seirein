/**
 * Body text -> speech-language translation, and the one shared speech preparation outlet.
 *
 * The translator is deliberately independent of the conversation: one `request` seam receives a
 * single system prompt plus the one source line, with no chat history, no memory block and no tool
 * definitions. It never creates a turn and never resubmits anything to the agent. A bounded LRU
 * caches the result per (source, target, rules revision, purpose, Japanese speech script, text).
 *
 * When a lightweight channel is present, this module does NOT build the prompt for it: every
 * model call hands over an explicit `translate`/`kana` input package (target text, languages,
 * script, purpose, round) and the channel renders system/user. That keeps one prompt source of
 * truth (the builders below) and guarantees no chat context is attached.
 *
 * `prepareSpeech` is the speech outlet every voice lane shares: TTS receives `speechText` in
 * `speechLang`. `prepareCaption` is the independent subtitle stream: it translates the same body
 * line into the subtitle language and never produces audio. The two streams read their own
 * setting, skip when the target equals the source, and share the translator (whose cache key
 * includes the target language and the purpose — `speech` or `subtitle` — so they never share an
 * entry). Same-language text is not translated at all. A failed or
 * cancelled speech translation falls back to speaking the original text in its own language — a
 * Chinese line is never labelled `ja` and sent to Japanese synthesis. A failed caption
 * translation keeps the original line as the subtitle.
 *
 * Every request starts from a 2048-token budget (`maxTokens`, or the settings name
 * `translateMaxTokens`). An answer the provider stopped at the token cap — `finish` is
 * `max-tokens` / `max_tokens` / `length`, or `truncated:true` — means the budget went into
 * reasoning, so it is retried exactly ONCE at `min(16384, max(8192, first * 4))` with a
 * direct-answer instruction ("直接输出译文，不要输出推理过程"). A retry that is still truncated fails
 * the whole line with `TRANSLATE_INCOMPLETE`, so half a line is never cached or spoken.
 *
 * Every model call has its OWN deadline (`translateTimeoutMs`, or the code-level `timeoutMs`;
 * default 15000 ms): a retry re-arms the clock instead of inheriting the first attempt's leftover
 * time. A deadline is NOT a token problem — a line that needed more than 15 s of reasoning would
 * need even longer with a larger budget — so a timed-out attempt is retried exactly ONCE at the
 * SAME token budget (with the direct-answer instruction) and only a `max-tokens` truncation raises
 * it. A sentence whose retry is also late fails alone with `TRANSLATE_TIMEOUT`; the other sentences
 * of the same reply are separate calls and never share its deadline or its cancellation.
 *
 * Up to `maxConcurrent` (default 3) translations of one translator run at once; the rest wait for
 * a free slot. Voice waiters come FIRST: a subtitle never overtakes a voice line that is already
 * queued, and no running translation is interrupted (priority reorders the queue only). Subtitles
 * cannot starve either: after `TRANSLATE_VOICE_BURST` queued voice lines in a row, the oldest
 * waiting subtitle is admitted next (3:1), and `translate.priority` records the counters. An empty
 * lane never holds a slot idle, and a request a caller already cancelled is purged before a slot is
 * handed out. Each lane's own `queueWaitMs` is reported on the admission and translation rows, so
 * the two waits can be compared later. The wait
 * happens BEFORE a deadline is armed, so queuing can never eat a sentence's timeout budget.
 *
 * A Japanese SPEECH translation is validated SENTENCE BY SENTENCE against the selected
 * `jaSpeechScript`. `mixed` keeps kanji + kana and only requires kana per sentence; `kana`
 * requires no Han at all; `kanaSpaced` (default) additionally requires word-separating spaces
 * (分かち書き), because the voice only needs a correct reading and phrase boundaries — except a
 * short answer such as 「はい。」, which is one unsegmentable word and passes as pure kana. A
 * Japanese SUBTITLE is written text, not synthesis: it always uses the `mixed` rule (normal
 * kanji + kana) whatever the speech script is. A failing sentence is sent back to the
 * model once — only those sentences, with the same hard rules — and the answer is spliced back in
 * place. If a sentence still fails after that one repair round, the WHOLE line fails with
 * `TRANSLATE_NOT_KANA` (mixed keeps `TRANSLATE_NOT_JAPANESE`) and the existing fallback speaks the
 * source language, so a Han-bearing or unspaced line is never synthesized.
 *
 * Events (emitted through `onEvent` / `emit`):
 *   `voice.translate`        {ms, cached, from, to}
 *   `voice.translate.retry`  {reason, from, to}   reason `max-tokens` raises the budget;
 *                                                 reason `timeout` keeps it (from === to)
 *   `voice.translate.repair` {sentences}
 *   `voice.translate.failed` {code, from, to, ms} — a TRANSLATE_TIMEOUT also carries
 *                                                 {budgetMs, attempt, maxTokens}: which attempt ran
 *                                                 out, its deadline and its token budget
 *   `voice.translate.fallback {from, to, code, sentenceId}`
 *   `voice.subtitle.fallback {from, to, code, sentenceId}`
 *   `translate.priority`     {servedVoice, servedSubtitle, lane, queueWaitMs} — the counters after
 *                                                 one QUEUED request was admitted (the only place
 *                                                 priority decides); `lane` is `voice`|`subtitle`
 *   `translate.share.reowner` {from, to} — a cancelled owner handed the shared request to a waiter
 *   `translate.share.cancelled {waiters}` — the shared request is really cancelled (no live waiter)
 */

import { createHash } from 'node:crypto';

/** The prompt/validation revision participates in the cache key; bump it when either changes. */
export const TRANSLATE_RULES_VERSION = 3;
export const DEFAULT_TRANSLATE_CACHE_CAPACITY = 500;
/**
 * The deadline of ONE model call. 6 s was shorter than the reasoning many replies need; 15 s fits
 * the reported 6.0 s near-misses with room to spare. Every attempt still shares the ONE total
 * budget below, so two attempts can never hold a sentence for 30 s.
 */
export const DEFAULT_TRANSLATE_TIMEOUT_MS = 15000;
/**
 * The total budget of one translation: first attempt + timeout retry + truncation retry + the
 * repair round all draw from it. Past it the line falls back to its original language instead of
 * spending another fresh window.
 */
export const DEFAULT_TRANSLATE_TOTAL_MS = 20000;
/** How many sentences of one reply may be translated at once; the rest wait in arrival order. */
export const DEFAULT_TRANSLATE_CONCURRENCY = 3;
/** The first-request budget. A reasoning model can spend all of it before writing one word. */
export const DEFAULT_TRANSLATE_MAX_TOKENS = 2048;
/** A truncated answer spent its budget on reasoning: the one retry raises the ceiling this far. */
const TRANSLATE_TRUNCATED_RETRY_MIN_TOKENS = 8192;
const TRANSLATE_RETRY_MAX_TOKENS = 16384;

/** Languages the companion speaks; the translator only accepts these targets/sources. */
export const TRANSLATE_LANGS = Object.freeze(['zh', 'ja', 'en', 'ko', 'yue']);

/**
 * Japanese speech scripts, chosen by the host for A/B listening:
 *   mixed      — kanji + kana (the old behaviour; every sentence must contain kana)
 *   kana       — kana only, no word spaces (no Han at all)
 *   kanaSpaced — kana only + 分かち書き, i.e. words separated by a space (no Han, one space)
 * The default is `kanaSpaced`; an unknown value falls back to it.
 */
export const JA_SPEECH_SCRIPTS = Object.freeze(['mixed', 'kana', 'kanaSpaced']);
export const DEFAULT_JA_SPEECH_SCRIPT = 'kanaSpaced';

export function normalizeJaSpeechScript(value) {
  const script = String(value ?? '').trim();
  return JA_SPEECH_SCRIPTS.includes(script) ? script : DEFAULT_JA_SPEECH_SCRIPT;
}

/**
 * What a translation is for. `speech` feeds TTS (so Japanese obeys the selected speech script);
 * `subtitle` is painted on screen and keeps normal Japanese writing (kanji + kana, `mixed`).
 * The purpose is part of the cache key: the same source must never serve the other use's form.
 */
export const TRANSLATE_PURPOSES = Object.freeze(['speech', 'subtitle']);
export const DEFAULT_TRANSLATE_PURPOSE = 'speech';

export function normalizeTranslatePurpose(value) {
  const purpose = String(value ?? '').trim();
  return TRANSLATE_PURPOSES.includes(purpose) ? purpose : DEFAULT_TRANSLATE_PURPOSE;
}

const LANG_NAMES = Object.freeze({ zh: '中文', ja: '日语', en: '英语', ko: '韩语', yue: '粤语' });

const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;
const HAN_ALL = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/gu;
/** A Japanese speech line must contain no Han at all; this is the exact check for that rule. */
const KANJI = /[\u3400-\u4dbf\u4e00-\u9fff]/u;
/** 分かち書き: words inside a Japanese sentence are separated by a half- or full-width space. */
const WORD_SPACE = /[ \u3000]/u;
/** Hiragana + katakana: the evidence that a Japanese line was really translated. */
const KANA = /[\u3040-\u30ff]/u;
const KANA_ALL = /[\u3040-\u30ff]/gu;
const KANA_RUNS = /[\u3040-\u30ff]+/gu;
const HANGUL = /[\uac00-\ud7af\u1100-\u11ff]/u;
const LATIN = /[A-Za-z]/u;
const PUNCTUATION = /[\s。、！？!?；;：:,.，．…「」『』"'“”‘’（）()\[\]【】《》·・]/gu;

const countOf = (text, pattern) => (text.match(pattern) ?? []).length;

/**
 * Best-effort language of one line, used only when the caller has no explicit source language.
 *
 * Kana is not proof of Japanese on its own: a Chinese sentence that quotes one Japanese word
 * (「ありがとう」) contains a single kana run inside a mostly-Han line. Japanese prose mixes kana
 * runs through the sentence, so a lone run in a Han-dominant line is treated as a foreign word
 * and the line stays `zh`. Han-only text is Chinese; everything else keeps the old ordering.
 * @param {string} text
 * @returns {'zh'|'ja'|'en'|'ko'|'yue'}
 */
export function detectLanguage(text) {
  const value = typeof text === 'string' ? text : '';
  if (KANA.test(value)) {
    const runs = (value.match(KANA_RUNS) ?? []).length;
    const kana = countOf(value, KANA_ALL);
    const han = countOf(value, HAN_ALL);
    if (runs <= 1 && han >= 4 && han > kana) return 'zh';
    return 'ja';
  }
  if (HANGUL.test(value)) return 'ko';
  if (HAN.test(value)) return 'zh';
  if (LATIN.test(value)) return 'en';
  return 'zh';
}

/** Dice similarity over the longest common subsequence: 1 = identical, 0 = nothing shared. */
function similarity(a, b) {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const previous = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = 0;
    for (let j = 1; j <= b.length; j += 1) {
      const saved = previous[j];
      previous[j] = a[i - 1] === b[j - 1]
        ? diagonal + 1
        : Math.max(previous[j], previous[j - 1]);
      diagonal = saved;
    }
  }
  return (2 * previous[b.length]) / (a.length + b.length);
}

export function normalizeLang(value) {
  const lang = String(value ?? '').trim().toLowerCase();
  return TRANSLATE_LANGS.includes(lang) ? lang : '';
}

/** Strip whitespace so "相 同" and "相同" compare as the same text. */
function compact(value) {
  return String(value ?? '').replace(PUNCTUATION, '');
}

/** A positive whole token budget, or the fallback when the value is missing or nonsense. */
function positiveTokens(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

/** How many queued voice lines may be admitted in a row before a waiting subtitle is due next. */
export const TRANSLATE_VOICE_BURST = 3;

/**
 * A VOICE-first slot gate: at most `max` translations hold a slot, so the sentences of one reply
 * run in parallel up to the cap instead of queueing one by one.
 *
 * Only the queue is reordered: a translation that already holds a slot always runs to completion,
 * so a subtitle is never interrupted. A waiting voice line is admitted before any waiting subtitle
 * (voice must not block behind subtitles); subtitles still cannot starve — once `voiceBurst` queued
 * voice lines were served in a row (both lanes waiting), the oldest waiting subtitle goes next
 * (3:1 by default). The rule never idles a slot and never reorders across an empty queue: whichever
 * lane has work and the other does not runs at once. Requests that a caller has already cancelled
 * (an old turn, an interrupted subtitle) are purged BEFORE a slot is handed out, so a stale
 * subtitle never takes a slot from live work, and the admission event carries the lane's own
 * `queueWaitMs`. `stats()` / `priorityStats()` are the observable seams for the tests.
 */
function createSlotGate(value, {
  voiceBurst = TRANSLATE_VOICE_BURST,
  onServe = null,
  now = () => Date.now(),
} = {}) {
  const numeric = Number(value);
  const max = Number.isFinite(numeric) && numeric > 0
    ? Math.max(1, Math.floor(numeric))
    : DEFAULT_TRANSLATE_CONCURRENCY;
  const waiting = [];
  /** Queued admissions, per lane: the counters `translate.priority` reports. */
  let servedVoice = 0;
  let servedSubtitle = 0;
  /** Queued voice lines served since the last queued subtitle: the starvation bound. */
  let voiceRun = 0;
  const priorityStats = () => ({ servedVoice, servedSubtitle });
  /** Settle one waiter without a slot (it was cancelled while waiting). */
  const drop = (waiter) => {
    if (waiter.settled) return false;
    waiter.settled = true;
    waiter.cleanup?.();
    waiter.resolve(false);
    return true;
  };
  /** Remove every stale waiter BEFORE scheduling: an old turn must not take a live slot. */
  const purgeStale = () => {
    for (let index = waiting.length - 1; index >= 0; index -= 1) {
      const waiter = waiting[index];
      if (!waiter.settled && waiter.signal?.aborted !== true) continue;
      waiting.splice(index, 1);
      drop(waiter);
    }
  };
  /** Hand a freed slot to `waiter`; false when it is already settled (cancelled) and must be skipped. */
  const promote = (waiter) => {
    if (waiter.settled) return false;
    waiter.settled = true;
    waiter.cleanup?.();
    if (waiter.priority === 'subtitle') {
      servedSubtitle += 1;
      voiceRun = 0;
    } else {
      servedVoice += 1;
      voiceRun += 1;
    }
    const queueWaitMs = Math.max(0, now() - waiter.enqueuedAt);
    try {
      onServe?.(waiter.priority, priorityStats(), { lane: waiter.priority, queueWaitMs });
    } catch {
      /* observation can never break a translation */
    }
    waiter.resolve(true);
    return true;
  };
  /** Index of the waiter to admit next: voice first, unless a waiting subtitle is due its turn. */
  const nextWaiter = () => {
    let voiceAt = -1;
    let subtitleAt = -1;
    for (let index = 0; index < waiting.length; index += 1) {
      if (waiting[index].priority === 'subtitle') {
        if (subtitleAt < 0) subtitleAt = index;
      } else if (voiceAt < 0) {
        voiceAt = index;
      }
    }
    // Only one lane waiting (or the fairness bound not reached): the available lane runs now. No
    // slot is ever held back to "wait for a ratio".
    if (subtitleAt < 0) return voiceAt;
    if (voiceAt < 0) return subtitleAt;
    return voiceRun >= voiceBurst ? subtitleAt : voiceAt;
  };
  const gate = {
    max,
    active: 0,
    peak: 0,
    /** Resolves true when a slot is held, false when `signal` aborted while waiting (no slot). */
    acquire(signal = null, priority = 'voice') {
      if (gate.active < max) {
        gate.active += 1;
        gate.peak = Math.max(gate.peak, gate.active);
        return Promise.resolve(true);
      }
      return new Promise((resolve) => {
        const waiter = {
          resolve,
          settled: false,
          cleanup: null,
          priority: priority === 'subtitle' ? 'subtitle' : 'voice',
          signal,
          enqueuedAt: now(),
        };
        const abandon = () => {
          if (waiter.settled) return;
          waiter.settled = true;
          waiter.cleanup?.();
          const index = waiting.indexOf(waiter);
          if (index >= 0) waiting.splice(index, 1);
          resolve(false);
        };
        if (signal?.aborted === true) { abandon(); return; }
        purgeStale();
        signal?.addEventListener?.('abort', abandon, { once: true });
        waiter.cleanup = () => signal?.removeEventListener?.('abort', abandon);
        waiting.push(waiter);
      });
    },
    release() {
      purgeStale();
      while (waiting.length > 0) {
        const index = nextWaiter();
        if (index < 0) break;
        const [waiter] = waiting.splice(index, 1);
        // A freed slot goes straight to the chosen waiter; a cancelled one is simply skipped.
        if (promote(waiter)) return;
      }
      gate.active = Math.max(0, gate.active - 1);
    },
    stats() {
      return { active: gate.active, peak: gate.peak, max };
    },
    priorityStats,
  };
  return gate;
}

/** Cache key: hash(sourceLang, targetLang, rulesVersion, purpose, Japanese script, text). */
export function translationKey({
  from = 'zh', to = 'ja', rulesVersion = TRANSLATE_RULES_VERSION, text = '',
  jaSpeechScript = DEFAULT_JA_SPEECH_SCRIPT, purpose = DEFAULT_TRANSLATE_PURPOSE,
} = {}) {
  // The speech script only changes Japanese SPOKEN output: a subtitle uses normal Japanese
  // writing, so Japanese subtitles never inherit the speech script. The purpose itself is always
  // hashed: speech and subtitles are separate entry families and never share a cache row.
  const use = normalizeTranslatePurpose(purpose);
  const script = to === 'ja' && use === 'speech' ? normalizeJaSpeechScript(jaSpeechScript) : '';
  return createHash('sha256')
    .update(`${from}\u0000${to}\u0000${rulesVersion}\u0000${use}\u0000${script}\u0000${text}`, 'utf8')
    .digest('hex');
}

/**
 * Bounded least-recently-used cache. `get` refreshes recency; `set` evicts the oldest key.
 * Capacity is a hard cap (default 500 entries).
 */
export class TranslationCache {
  constructor({ capacity = DEFAULT_TRANSLATE_CACHE_CAPACITY } = {}) {
    const numeric = Number(capacity);
    this.capacity = Number.isFinite(numeric) && numeric > 0
      ? Math.max(1, Math.floor(numeric))
      : DEFAULT_TRANSLATE_CACHE_CAPACITY;
    this.entries = new Map();
  }

  get(key) {
    if (!this.entries.has(key)) return undefined;
    const value = this.entries.get(key);
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key, value) {
    if (this.entries.has(key)) this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return value;
  }

  has(key) {
    return this.entries.has(key);
  }

  clear() {
    this.entries.clear();
  }

  get size() {
    return this.entries.size;
  }
}

export function createTranslationCache(options = {}) {
  return new TranslationCache(options);
}

/** The hard rules shared by the first translation and the one targeted repair round, per script. */
const JAPANESE_RULES = Object.freeze({
  mixed: [
    '- 日语必须是真正翻译后的自然口语：允许假名与汉字混合，但每个句子都必须出现假名；绝不能把中文原文逐字照搬、按音读照读或只替换成同形汉字。',
    '- 整段必须是日语；不得保留中文词句；专有名词也需按日语书写处理。',
  ].join('\n'),
  kana: [
    '- 译文只能使用平假名、片假名、长音符「ー」与标点，不得出现任何汉字；汉字的人名、地名、数字、英文都要按读音写成假名。',
    '- 整段必须是全假名日语；不得照搬中文原文或使用同形汉字。',
  ].join('\n'),
  kanaSpaced: [
    '- 译文只能使用平假名、片假名、长音符「ー」与标点，不得出现任何汉字；汉字的人名、地名、数字、英文都要按读音写成假名。',
    '- 词与词之间必须用半角或全角空格分开（分かち書き），不得把整句假名连写在一起；也不得照搬中文原文或使用同形汉字。',
  ].join('\n'),
});

/** The exact prompt pair sent to the model; exported so tests can assert what is (not) included. */
export function translationPrompt({
  from = 'zh', to = 'ja', jaSpeechScript = DEFAULT_JA_SPEECH_SCRIPT, purpose = DEFAULT_TRANSLATE_PURPOSE,
} = {}) {
  const fromName = LANG_NAMES[from] ?? from;
  const toName = LANG_NAMES[to] ?? to;
  // A Japanese subtitle is written, not synthesized: it keeps normal Japanese writing (`mixed`)
  // even when the speech lane is configured for kana/分かち書き.
  const ruleScript = normalizeTranslatePurpose(purpose) === 'subtitle'
    ? 'mixed'
    : normalizeJaSpeechScript(jaSpeechScript);
  const japaneseRule = to === 'ja' ? `\n${JAPANESE_RULES[ruleScript]}` : '';
  return {
    system: [
      `你是语音播报的${fromName}→${toName}翻译器。`,
      '只输出译文本身：不要解释、不要注释、不要加引号、不要输出原文。',
      `把输入完整翻译成自然的${toName}口语，保留原意、语气和情绪；不扩写、不省略。${japaneseRule}`,
    ].join('\n'),
    user: `把下面这段${fromName}翻译成${toName}：\n`,
  };
}

/** The one extra repair line per script; `mixed` keeps the old kanji-tolerant rule. */
const JAPANESE_REPAIR_RULE = Object.freeze({
  mixed: '每个句子都必须出现假名；不得输出任何中文。',
  kana: '不得出现任何汉字，全部写成假名。',
  kanaSpaced: '不得出现任何汉字，全部写成假名；词与词之间必须用半角或全角空格分开（分かち書き）。',
});

/**
 * The targeted repair prompt: only the sentences that failed the script check, carrying the SAME
 * hard rules, and one output line per sentence so the answer can be spliced back in place.
 * @returns {{system: string, user: string, sentences: string[]}}
 */
export function translationRepairPrompt({
  from = 'zh', to = 'ja', sentences = [], jaSpeechScript = DEFAULT_JA_SPEECH_SCRIPT,
  purpose = DEFAULT_TRANSLATE_PURPOSE,
} = {}) {
  const use = normalizeTranslatePurpose(purpose);
  const script = use === 'subtitle' ? 'mixed' : normalizeJaSpeechScript(jaSpeechScript);
  const { system } = translationPrompt({ from, to, jaSpeechScript: script, purpose: use });
  const toName = LANG_NAMES[to] ?? to;
  const repairRule = to === 'ja' ? JAPANESE_REPAIR_RULE[script] : '不得输出原文。';
  const list = (Array.isArray(sentences) ? sentences : [])
    .map((sentence) => String(sentence).trim())
    .filter((sentence) => sentence.length > 0);
  return {
    system: [
      system,
      `下面是译文里不合格的句子：只把这些句子逐句改写成自然的${toName}口语，保持原意和语气。`,
      '严格一行只输出一句改写结果，顺序与输入完全一致；不要编号、不要解释、不要加引号。',
      repairRule,
    ].join('\n'),
    user: `把下面${list.length}句逐行改写成${toName}（每行一句，共${list.length}行）：\n`,
    sentences: list,
  };
}

/**
 * The only endings that prove a complete answer. The translation of a partial line may still look
 * plausible (the first half in Japanese), which is exactly why anything else — a `length` finish,
 * an error, or no finish at all — must never be cached or played as if it were the whole line.
 * A token count at the cap only counts as truncation without one of these.
 */
const NORMAL_FINISH = new Set(['completed', 'complete', 'stop', 'end', 'eos', 'success', 'finished']);

/** Finishes that prove the provider stopped because the token budget ran out, not because it ended. */
const TRUNCATED_FINISH = new Set(['maxtokens', 'length']);

/** `finish` is either a string or `{kind|type|reason}` depending on the provider. */
function finishKind(value) {
  if (typeof value === 'string') return value.trim().toLowerCase();
  if (value !== null && typeof value === 'object') {
    return String(value.kind ?? value.type ?? value.reason ?? '').trim().toLowerCase();
  }
  return '';
}

/** True when the answer hit the token cap: `max-tokens` / `max_tokens` / `length` or a flagged result. */
function isTruncated(collected) {
  if (collected?.truncated === true) return true;
  return TRUNCATED_FINISH.has(finishKind(collected?.finish).replace(/[^a-z]/gu, ''));
}

const emptyCollected = { text: '', finish: '', outputTokens: 0, truncated: false, complete: false };

/**
 * A structured answer keeps the finish metadata the object branch used to discard: a `length`
 * finish, a `truncated: true` flag or a missing finish means the text may only be half a line.
 */
function structuredCollected(result, maxTokens) {
  let finish = '';
  for (const key of ['finishReason', 'finish_reason', 'stopReason', 'finish']) {
    if (result[key] !== undefined && result[key] !== null) {
      finish = finishKind(result[key]);
      break;
    }
  }
  const total = Number(result.usage?.outputTokens ?? result.usage?.output_tokens);
  const outputTokens = Number.isFinite(total) && total >= 0 ? total : 0;
  const capped = Number(maxTokens) > 0 && outputTokens >= Number(maxTokens);
  const truncated = result.truncated === true || (capped && !NORMAL_FINISH.has(finish));
  return {
    text: result.text,
    finish,
    outputTokens,
    truncated,
    complete: NORMAL_FINISH.has(finish) && !truncated,
  };
}

/**
 * Read either a plain string, `{text}`, or a chunk stream from the request seam.
 *
 * Only a normal finish counts as a complete answer: `text-delta` alone (a stream that simply
 * stops) and a structured result without `finishReason:'stop'` are both incomplete.
 */
async function collectText(result, { maxTokens = 0 } = {}) {
  // A plain string is the seam's "whole answer" form and carries no finish metadata to check.
  if (typeof result === 'string') return { ...emptyCollected, text: result, complete: true };
  if (result !== null && typeof result === 'object' && typeof result[Symbol.asyncIterator] === 'function') {
    let out = '';
    let finish = '';
    let outputTokens = 0;
    for await (const chunk of result) {
      if (typeof chunk === 'string') { out += chunk; continue; }
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') out += chunk.text;
      else if (chunk?.type === 'text' && typeof chunk.text === 'string') out += chunk.text;
      if (chunk?.type === 'finish') finish = finishKind(chunk.reason ?? chunk.finishReason ?? chunk.finish);
      else if (typeof chunk?.finishReason === 'string') finish = finishKind(chunk.finishReason);
      else if (chunk?.type === 'error') finish = 'error';
      if (chunk?.type === 'usage') {
        const total = Number(chunk.usage?.outputTokens ?? chunk.usage?.output_tokens);
        if (Number.isFinite(total) && total >= 0) outputTokens = total;
      }
    }
    const capped = Number(maxTokens) > 0 && outputTokens >= Number(maxTokens);
    const truncated = capped && !NORMAL_FINISH.has(finish);
    return {
      text: out,
      finish,
      outputTokens,
      truncated,
      complete: NORMAL_FINISH.has(finish) && !truncated,
    };
  }
  if (result !== null && typeof result === 'object' && typeof result.text === 'string') {
    return structuredCollected(result, maxTokens);
  }
  return emptyCollected;
}

/**
 * The one budget after a truncated answer: at least 8192 and 4x the first budget (the reasoning
 * that ate it is usually longer than the answer), clamped to 16384 and never below the first.
 */
function retryMaxTokens(first) {
  const base = positiveTokens(first, DEFAULT_TRANSLATE_MAX_TOKENS);
  const raised = Math.max(TRANSLATE_TRUNCATED_RETRY_MIN_TOKENS, base * 4);
  return Math.max(base, Math.min(TRANSLATE_RETRY_MAX_TOKENS, raised));
}

/** The retry prompt: the same rules plus the direct-answer line the truncated answer ignored. */
export const STRICT_TRANSLATION_LINE = '严格模式：直接输出译文，不要输出推理过程，不要写思考、分析或自检。';

export function strictTranslationSystem(system) {
  return [
    String(system ?? '').trim(),
    STRICT_TRANSLATION_LINE,
  ].filter((line) => line.length > 0).join('\n');
}

/** Keep the translation only: drop labels, wrapping quotes and extra lines. */
function sanitizeTranslation(value) {
  let text = String(value ?? '').replace(/\r\n?/gu, '\n').trim();
  if (text.length === 0) return '';
  text = text.split('\n').map((line) => line.trim()).filter((line) => line.length > 0).join(' ');
  text = text.replace(/^(?:译文|翻译|日文|日本語|英文|中文)\s*[:：]\s*/u, '');
  text = text.replace(/^["'“”「『]+/u, '').replace(/["'“”」』]+$/u, '');
  return text.trim();
}

/** A run of characters that closes a sentence: terminators keep their closing quotes attached. */
const SENTENCE_TERMINATOR = /[。．！？!?；;…\n]/u;
const SENTENCE_CLOSER = /[」』”’"'）)\]]/u;
/** A repaired line that already ends like a sentence keeps that ending; otherwise the old one wins. */
const ENDS_SENTENCE = /[。．！？!?；;…\n]["'“”」』]*$/u;

/**
 * Split one translation into sentence pieces, preserving every character AND its offsets so a
 * repaired sentence can be written back exactly where the old one was.
 * @param {string} text
 * @returns {Array<{text: string, start: number, end: number}>}
 */
function splitTranslationSentences(text) {
  const value = String(text ?? '');
  const pieces = [];
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (!SENTENCE_TERMINATOR.test(value[index])) continue;
    let end = index + 1;
    while (end < value.length && (SENTENCE_TERMINATOR.test(value[end]) || SENTENCE_CLOSER.test(value[end]))) {
      end += 1;
    }
    pieces.push({ text: value.slice(start, end), start, end });
    start = end;
    index = end - 1;
  }
  if (start < value.length) pieces.push({ text: value.slice(start), start, end: value.length });
  return pieces;
}

/**
 * A Japanese utterance short enough to be one unsegmentable unit (「はい。」「いいえ。」「そうですね。」)
 * needs no 分かち書き. Six or more kana is treated as a multi-word line that still must be spaced.
 */
const SPEECH_SEGMENTATION_KANA = 6;

/**
 * Validate one sentence against the selected script. Empty or punctuation-only pieces always pass.
 *   mixed      — must contain kana (kanji is allowed)
 *   kana       — must contain no Han
 *   kanaSpaced — must contain no Han and at least one word space, EXCEPT a short answer.
 */
function isValidJapaneseSentence(text, script) {
  // Trim first: the space `sanitizeTranslation` inserts between model lines must not count as 分かち書き.
  const body = String(text ?? '').trim();
  if (compact(body).length === 0) return true;
  if (script === 'mixed') return KANA.test(body);
  if (KANJI.test(body)) return false;
  if (script === 'kana') return true;
  if (WORD_SPACE.test(body)) return true;
  // A short answer is one phrase with no word boundary to mark, so it passes as-is — but only
  // when it is pure kana (no Han above, no latin fragment), never as a way around the long rule.
  return countOf(body, KANA_ALL) < SPEECH_SEGMENTATION_KANA && !LATIN.test(body);
}

/** Sentences that fail the selected script check; empty when the whole translation is speech-ready. */
export function findInvalidJapaneseSentences(text, jaSpeechScript = DEFAULT_JA_SPEECH_SCRIPT) {
  const script = normalizeJaSpeechScript(jaSpeechScript);
  return splitTranslationSentences(text)
    .filter((piece) => !isValidJapaneseSentence(piece.text, script))
    .map((piece) => piece.text.trim());
}

/** Repair numbering (`1.`, `2、`) is not part of the sentence. */
const REPAIR_NUMBERING = /^\d+\s*[.、)）:：]\s*/u;

/**
 * Repair-model output → one rewritten sentence per offending sentence, or null when the answer is
 * not a usable per-sentence repair (a wrong count would silently move text between sentences).
 * One line per sentence is the requested shape; a model that thinks in prose is split on sentence
 * punctuation instead.
 */
function parseRepairSentences(value, expected) {
  const lines = String(value ?? '')
    .replace(/\r\n?/gu, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line
      .replace(REPAIR_NUMBERING, '')
      .replace(/^["'“”「『]+/u, '')
      .replace(/["'“”」』]+$/u, '')
      .trim())
    .filter((line) => line.length > 0);
  if (lines.length === expected) return lines;
  const pieces = splitTranslationSentences(lines.join(' '))
    .map((piece) => piece.text.trim())
    .filter((piece) => piece.length > 0);
  return pieces.length === expected ? pieces : null;
}

/** Write repaired sentences back in place; every untouched character keeps its offset. */
function spliceRepairedSentences(text, pieces, replacements) {
  let output = '';
  let cursor = 0;
  for (let index = 0; index < pieces.length; index += 1) {
    const piece = pieces[index];
    if (piece.start < cursor) continue;
    output += text.slice(cursor, piece.start);
    const body = String(replacements[index] ?? '').trim();
    if (body.length === 0) {
      output += piece.text;
      cursor = piece.end;
      continue;
    }
    // Keep the sentence boundary the repaired line chose; only a repaired line that forgot its
    // ending borrows the old one (and its trailing whitespace), so it cannot swallow the next one.
    const tail = piece.text.match(/[。．！？!?；;…\n]+[\s]*$/u)?.[0] ?? '';
    const spacing = piece.text.match(/[\s]*$/u)?.[0] ?? '';
    if (ENDS_SENTENCE.test(body)) output += `${body}${spacing}`;
    else output += `${body}${tail}`;
    cursor = piece.end;
  }
  return output + text.slice(cursor);
}

/**
 * Empty string means valid; otherwise the failure code reported to the event log.
 *
 * `TRANSLATE_UNCHANGED` is reserved for a translation that is essentially the source again:
 * the normalized strings are equal, or they are more than 90 % similar. A translation that
 * merely keeps a short source word (「了解」 → 「了解です。」) is a real translation. The Japanese
 * check itself is per sentence (`findInvalidJapaneseSentences`: no Han and 分かち書き by default),
 * not one kana anywhere in the line.
 */
function validateTranslation(translated, { source, from }) {
  const out = compact(translated);
  if (translated.length === 0 || out.length === 0) return 'TRANSLATE_EMPTY';
  const original = compact(source);
  if (from !== 'ja' && (out === original || similarity(out, original) > 0.9)) return 'TRANSLATE_UNCHANGED';
  return '';
}

/**
 * Boundary between context and target. The context block is assembled by the fast path and is
 * available to the model, but the answer may only contain the translation of the target line:
 * a translation that also rendered the persona/profile/memory text would be spoken or cached as
 * if it were the reply.
 *
 * Two deterministic tests, no prompt trust:
 * - `context-echo`: the answer contains a context sentence (length >= 8) or a section marker;
 * - `ratio`: the compact answer is more than 5x or less than 0.2x the target. The range is wider
 *   than a 3x rule because kana and English characters legitimately expand a Chinese source 3-4x;
 *   a context block that really went through the model is an order of magnitude larger. Short
 *   targets skip the ratio so a one-word line such as 「了解」 → 「了解です。」 is never a violation.
 */
export const BOUNDARY_MAX_RATIO = 5;
export const BOUNDARY_MIN_RATIO = 0.2;
const BOUNDARY_SENTENCE_MIN_CHARS = 8;
const BOUNDARY_RATIO_MIN_SOURCE_CHARS = 4;
const BOUNDARY_MARKERS = Object.freeze([
  '<待译正文>', '</待译正文>', '待译正文',
  '## 人设', '## 用户画像', '## 相关记忆', '## 最近对话',
]);

/** Sentences of the context block, normalized for a substring check. */
function boundarySentences(context) {
  return String(context ?? '')
    .split(/[。！？!?；;\n]+/u)
    .map((sentence) => compact(sentence))
    .filter((sentence) => [...sentence].length >= BOUNDARY_SENTENCE_MIN_CHARS);
}

/**
 * Empty string means the answer stayed inside the target; otherwise the boundary reason.
 * @param {{text?: string, source?: string, context?: string}} input
 * @returns {''|'context-echo'|'ratio'}
 */
export function translationBoundary({ text = '', source = '', context = '' } = {}) {
  const answer = String(text ?? '');
  const compactAnswer = compact(answer);
  if (BOUNDARY_MARKERS.some((marker) => answer.includes(marker))) return 'context-echo';
  for (const sentence of boundarySentences(context)) {
    if (sentence.length === 0) continue;
    if (compactAnswer.includes(sentence)) return 'context-echo';
  }
  const sourceChars = [...compact(source)].length;
  const answerChars = [...compactAnswer].length;
  // The ratio guard exists for the assist path, where context is present and "translated the
  // whole prompt" is a real failure. The plain request seam (empty context) keeps the historical
  // prompt-only contract: Chinese→Japanese kana legitimately expands past 3x on short lines.
  if (String(context ?? '').length > 0
    && sourceChars >= BOUNDARY_RATIO_MIN_SOURCE_CHARS && answerChars > 0) {
    const ratio = answerChars / sourceChars;
    if (ratio > BOUNDARY_MAX_RATIO || ratio < BOUNDARY_MIN_RATIO) return 'ratio';
  }
  return '';
}

/** System line appended to the translation prompt: the tag body is the only translatable text. */
export const BOUNDARY_SYSTEM_RULE = '用户消息里 <待译正文> 标签内的内容是唯一需要翻译的目标正文；标签外的上下文只用于理解指代与语气，不要翻译、复述或总结上下文，不要输出标签本身。';

/** Wrap the target in the explicit boundary tags; a repair round must not re-wrap its sentences. */
export function wrapTarget(text) {
  return `<待译正文>\n${text}\n</待译正文>`;
}

/**
 * The ONE boundary repair round: the original target again, with the previous answer discarded.
 * It reuses the normal translation rules plus the hard boundary line, and the caller re-checks the
 * result; a still-violating answer falls back to the source language instead of being played.
 */
export function boundaryRepairPrompt({ from, to, jaSpeechScript, purpose, source }) {
  const { system } = translationPrompt({ from, to, jaSpeechScript, purpose });
  const toName = LANG_NAMES[to] ?? to;
  return {
    system: [
      system,
      BOUNDARY_SYSTEM_RULE,
      '上一次的译文混入了上下文内容，必须丢弃。这次只重新翻译 <待译正文> 内的目标正文。',
    ].join('\n'),
    user: `只输出下面 <待译正文> 内内容的${toName}译文：\n${wrapTarget(source)}\n`,
  };
}

function abortReason(lane) {
  return lane.reason ?? new DOMException('Translation cancelled', 'AbortError');
}

/** Race the model call against the lane so a request that ignores its signal cannot hang us. */
function raceAbort(promise, lane) {
  if (lane.aborted) return Promise.reject(abortReason(lane));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortReason(lane));
    lane.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => { lane.removeEventListener('abort', onAbort); resolve(value); },
      (error) => { lane.removeEventListener('abort', onAbort); reject(error); },
    );
  });
}

function notify(options) {
  try {
    const task = options.onEvent?.(options.type, options.payload);
    if (task !== null && typeof task === 'object' && typeof task.catch === 'function') task.catch(() => {});
  } catch {
    /* observation can never break a translation */
  }
}

/**
 * Create the isolated translation entry.
 *
 * `request({system, messages, maxTokens, signal})` is the only model access: it returns a string,
 * `{text}`, or an async text-delta stream. No conversation state is passed in or stored.
 *
 * `jaSpeechScript` chooses the Japanese speech script (`mixed` | `kana` | `kanaSpaced`); it is part
 * of the cache key, so switching the script never reuses an entry written under another script.
 * `purpose` (`speech` | `subtitle`) selects which Japanese form is required: a speech translation
 * follows `jaSpeechScript`, a subtitle is normal Japanese writing (`mixed`) — and the purpose is
 * part of the cache key, so the two uses never share an entry.
 *
 * @returns {{translate: Function, cache: TranslationCache, rulesVersion: number,
 *   jaSpeechScript: string, timeoutMs: number, maxTokens: number, stats: Function,
 *   priorityStats: Function}}
 */
export function createTranslator({
  request,
  channel = null,
  cache = createTranslationCache(),
  rulesVersion = TRANSLATE_RULES_VERSION,
  timeoutMs = undefined,
  translateTimeoutMs = undefined,
  totalMs = undefined,
  translateTotalMs = undefined,
  maxConcurrent = DEFAULT_TRANSLATE_CONCURRENCY,
  maxTokens = undefined,
  translateMaxTokens = undefined,
  jaSpeechScript = DEFAULT_JA_SPEECH_SCRIPT,
  now = () => Date.now(),
  timers = null,
  onEvent = null,
} = {}) {
  if (typeof request !== 'function') {
    throw new TypeError('createTranslator requires a request({system, messages, maxTokens, signal}) function');
  }
  const script = normalizeJaSpeechScript(jaSpeechScript);
  // `translateMaxTokens` is the settings-facing name of the same budget; `maxTokens` is the
  // code-level one. An explicit (or configured) value always wins over the default.
  const budget = positiveTokens(translateMaxTokens ?? maxTokens, DEFAULT_TRANSLATE_MAX_TOKENS);
  // `translateTimeoutMs` is the settings-facing name of the same deadline (index.js already maps
  // `config.voice.translateTimeoutMs` to `timeoutMs`); `timeoutMs` is the code-level one.
  const numericTimeout = Number(translateTimeoutMs ?? timeoutMs);
  const limit = Number.isFinite(numericTimeout) && numericTimeout > 0 ? numericTimeout : DEFAULT_TRANSLATE_TIMEOUT_MS;
  // ONE total budget for the whole translation. A per-attempt window is still useful (it produces
  // the TIMEOUT event with the attempt scene), but it can never extend the line beyond this total.
  const numericTotal = Number(translateTotalMs ?? totalMs);
  const totalLimit = Math.max(
    limit,
    Number.isFinite(numericTotal) && numericTotal > 0 ? numericTotal : DEFAULT_TRANSLATE_TOTAL_MS,
  );
  // One clock for every attempt. It is injectable so a test can prove a 6 s answer survives a
  // 15 s deadline, and that a retry gets a fresh 15 s, without waiting real seconds.
  const clock = timers ?? { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
  // Every queued admission is reported with its lane and its own queue wait:
  // `translate.priority {servedVoice, servedSubtitle, lane, queueWaitMs}`.
  const gate = createSlotGate(maxConcurrent, {
    now,
    onServe: (_priority, counters, wait) => notify({
      onEvent,
      type: 'translate.priority',
      payload: { ...counters, lane: wait.lane, queueWaitMs: wait.queueWaitMs },
    }),
  });

  /**
   * @param {string} text
   * @param {{from?: string, to?: string, signal?: AbortSignal,
   *   purpose?: 'speech'|'subtitle',
   *   context?: {turn?: number|null, deliveryMessageId?: string|null}}} [options]
   * @returns {Promise<{ok: boolean, text: string, cached: boolean, ms: number, queueWaitMs: number, code?: string}>}
   */
  // ---- same-target reuse: one in-flight translation per (from, to, form, text) ---------------
  // A subtitle and a speech line of the same sentence in the same target language need the SAME
  // text. The second caller joins the first request instead of paying a second model call, and
  // `reused` is set on the joiner's result. `form` is the script the purpose needs (`mixed` for a
  // subtitle, the configured speech script for Japanese speech), so a kana speech copy can never
  // be served as the subtitle — the kana rewrite applies to the speech copy only. Cancellation is
  // per USE: a joiner may leave (its overlay was hidden) without cancelling the owner, and if the
  // OWNER aborts while other callers still wait, the highest-priority waiter (voice before
  // subtitle) takes the request over with its own purpose and input instead of failing them all.
  const inflight = new Map();
  const shareForm = (toLang, use) => (toLang === 'ja' && use === 'speech' ? script : 'mixed');
  const shareKeyOf = ({ fromLang, toLang, form, text }) => createHash('sha256')
    .update(`${fromLang}\u0000${toLang}\u0000${rulesVersion}\u0000${form}\u0000${text}`, 'utf8')
    .digest('hex');
  /**
   * Wait for another caller's translation. Returns `{result}` when the shared request settles,
   * `{reown, adopted}` when a cancelled owner hands the request to this caller (which takes the
   * remaining waiters along), or `{aborted}` when THIS caller's own signal fired — a joiner leaving
   * never touches the owner or the other waiters.
   */
  const joinInflight = (group, signal, use) => new Promise((resolve) => {
    const waiter = { group, rank: use === 'subtitle' ? 1 : 0, at: now(), done: false, finish: null };
    const finish = (value) => {
      if (waiter.done) return;
      waiter.done = true;
      waiter.group?.waiters.delete(waiter);
      signal?.removeEventListener?.('abort', onAbort);
      resolve(value);
    };
    waiter.finish = finish;
    const onAbort = () => finish({ aborted: true });
    if (signal?.aborted === true) { onAbort(); return; }
    signal?.addEventListener?.('abort', onAbort, { once: true });
    group.waiters.add(waiter);
    group.joined += 1;
  });

  async function translate(text, {
    from = 'zh', to = 'ja', signal, purpose = DEFAULT_TRANSLATE_PURPOSE, context = null,
    // A few preceding units, used ONLY to keep names/pronouns and tone consistent (the channel
    // renders them as context the model must not translate). Never part of the cache key.
    neighbors = null,
  } = {}) {
    const use = normalizeTranslatePurpose(purpose);
    // Join keys ride beside every `voice.translate` / `voice.translate.failed` row so a
    // translation can be joined to its turn without guessing it from timestamps.
    const join = {};
    const joinTurn = Number(context?.turn);
    if (Number.isSafeInteger(joinTurn)) join.turn = joinTurn;
    if (typeof context?.deliveryMessageId === 'string' && context.deliveryMessageId.length > 0) {
      join.deliveryMessageId = context.deliveryMessageId;
    }
    // A subtitle is displayed, not synthesized: it keeps normal Japanese writing (`mixed`).
    const japaneseScript = use === 'subtitle' ? 'mixed' : script;
    const source = typeof text === 'string' ? text : String(text ?? '');
    const fromLang = normalizeLang(from) || 'zh';
    const toLang = normalizeLang(to) || 'ja';
    if (source.trim().length === 0) {
      return { ok: false, code: 'TRANSLATE_EMPTY', text: '', cached: false, ms: 0 };
    }
    if (fromLang === toLang) {
      return { ok: true, text: source, cached: false, ms: 0, noop: true };
    }
    const key = translationKey({
      from: fromLang, to: toLang, rulesVersion, text: source, jaSpeechScript: script, purpose: use,
    });
    const hit = cache.get(key);
    if (hit !== undefined) {
      notify({
        onEvent,
        type: 'voice.translate',
        payload: { ms: 0, cached: true, from: fromLang, to: toLang, purpose: use, queueWaitMs: 0, ...join },
      });
      return { ok: true, text: hit, cached: true, ms: 0, queueWaitMs: 0 };
    }

    // Same target language and the same required form: share ONE in-flight request (if any).
    const form = shareForm(toLang, use);
    const shareKey = shareKeyOf({ fromLang, toLang, form, text: source });
    // Waiters inherited from an owner that was cancelled while this caller still needed its line.
    let adopted = null;
    const current = inflight.get(shareKey);
    if (current !== undefined && current.settled !== true) {
      const joinedAt = now();
      const joined = await joinInflight(current, signal, use);
      if (joined.aborted === true) {
        // Only THIS purpose cancelled: the owner and the other waiters keep their line.
        return { ok: false, code: 'TRANSLATE_CANCELLED', text: '', cached: false, ms: Math.max(0, now() - joinedAt), queueWaitMs: 0 };
      }
      if (joined.reown === true) {
        // The owner was cancelled: this waiter runs the request instead and brings the others.
        adopted = joined.adopted ?? [];
      } else if (joined.result !== undefined) {
        const ms = Math.max(0, now() - joinedAt);
        if (joined.result.ok === true) {
          // The shared text is this purpose's own text (same target language AND same required
          // form): cache it under this purpose's key too, so a later line of the same sentence is
          // a hit without a second request.
          cache.set(key, joined.result.text);
          notify({
            onEvent,
            type: 'voice.translate.shared',
            payload: { ms, from: fromLang, to: toLang, purpose: use, form, chars: [...source].length, ...join },
          });
        }
        return { ...joined.result, cached: false, ms, queueWaitMs: 0, reused: true };
      }
    }
    // This call owns the shared request: every joiner settles with exactly this result.
    const group = { settled: false, waiters: new Set(), joined: 0 };
    for (const waiter of adopted ?? []) {
      if (waiter.done === true) continue;
      // Their own abort listener is still armed: a waiter that cancels now only leaves this group.
      waiter.group = group;
      group.waiters.add(waiter);
      group.joined += 1;
    }
    inflight.set(shareKey, group);
    const settleShared = (result) => {
      if (group.settled) return;
      group.settled = true;
      if (inflight.get(shareKey) === group) inflight.delete(shareKey);
      const waiting = [...group.waiters];
      group.waiters.clear();
      for (const waiter of waiting) waiter.finish({ result });
    };
    /**
     * The owner was cancelled but other callers still wait: voice before subtitle (then arrival
     * order, the same priority the slot gate uses) takes the request over with its OWN purpose and
     * input; the rest stay attached to the new owner instead of being cancelled with it.
     */
    const handOver = () => {
      const live = [...group.waiters].filter((waiter) => waiter.done !== true);
      if (live.length === 0) return false;
      live.sort((a, b) => a.rank - b.rank || a.at - b.at);
      const next = live[0];
      group.settled = true;
      if (inflight.get(shareKey) === group) inflight.delete(shareKey);
      group.waiters.delete(next);
      notify({ onEvent, type: 'translate.share.reowner', payload: { from: fromLang, to: toLang } });
      next.finish({ reown: true, adopted: [...group.waiters] });
      return true;
    };

    const startedAt = now();
    // The one clock every attempt shares; `callModel` takes what is left of it.
    const totalDeadlineAt = startedAt + totalLimit;
    let attempt = 0;

    /**
     * One model call with its OWN deadline. Every attempt — first round, timeout retry,
     * truncation retry, repair round — re-arms the clock, so a retry never inherits the first
     * attempt's leftover time. Returns an outcome instead of throwing: the failure code needs
     * `timedOut`, `attempt` and the token budget of THAT call.
     */
    const callModel = async (
      system,
      user,
      payload,
      attemptTokens,
      { wrap = true, mode = 'translate', strict = false } = {},
    ) => {
      attempt += 1;
      const current = attempt;
      const controller = new AbortController();
      let expired = false;
      // The attempt window is the SMALLER of its own deadline and what is left of the total one.
      // When the total budget is already gone the request is not sent at all.
      const attemptBudget = Math.max(0, Math.min(limit, totalDeadlineAt - now()));
      const timer = clock.setTimeout(() => {
        expired = true;
        controller.abort(new DOMException('Translation timed out', 'TimeoutError'));
      }, attemptBudget);
      timer?.unref?.();
      // A fresh lane per attempt: the caller's cancellation is forwarded to THIS attempt only, and
      // the listener is removed when it settles (a long reply would otherwise pile up one listener
      // per retry on the one shared turn signal).
      const forward = () => controller.abort(signal?.reason ?? new DOMException('Translation cancelled', 'AbortError'));
      if (signal !== undefined && signal !== null) {
        if (signal.aborted) forward();
        else signal.addEventListener('abort', forward, { once: true });
      }
      const lane = controller.signal;
      try {
        // One isolated message per call: the first round carries the source line, the repair round
        // carries only the offending sentences. The request seam adds provider/model.
        const body = String(payload ?? '');
        const activeChannel = typeof channel === 'function' ? channel() : channel;
        const usingChannel = activeChannel !== null && typeof activeChannel?.ask === 'function';
        const messages = [{ role: 'user', content: [{ type: 'text', text: `${user}${body}` }] }];
        // The channel owns the prompt shape for its task: the caller names the input package
        // (target text, languages, script, purpose and which round it is) and the channel renders
        // system/user. No call site builds a prompt for it, and no context is attached.
        // `request` remains the fallback seam used by tests and by builds without a channel.
        const run = usingChannel
          ? Promise.resolve()
            .then(() => activeChannel.ask({
              task: japaneseScript === 'mixed' ? 'translate' : 'kana',
              input: {
                text: mode === 'boundary-repair' ? source : body,
                targetLang: toLang,
                from: fromLang,
                jaSpeechScript: script,
                purpose: use,
                mode,
                strict,
                boundary: wrap && body.length > 0,
                // The previous unit(s) only: the channel renders them as "相邻句" context that must
                // not be translated, so a name or pronoun stays consistent across the stream.
                ...(Array.isArray(neighbors) && neighbors.length > 0 ? { neighbors } : {}),
              },
              maxTokens: attemptTokens,
              timeoutMs: attemptBudget + 100,
              signal: lane,
            }))
            .then((value) => ({
              text: typeof value?.text === 'string' ? value.text : '',
              complete: value?.complete === true,
              truncated: value?.truncated === true,
              finishReason: String(value?.finishKind ?? ''),
              context: typeof value?.context === 'string' ? value.context : '',
              contextChars: Number(value?.contextChars) || 0,
            }))
          : Promise.resolve()
            .then(() => request({ system, messages, maxTokens: attemptTokens, signal: lane }))
            .then((value) => collectText(value, { maxTokens: attemptTokens }));
        const collected = attemptBudget > 0
          ? await raceAbort(run, lane)
          : (() => {
            expired = true;
            throw new DOMException('Translation timed out', 'TimeoutError');
          })();
        return { ok: true, collected, timedOut: expired, attempt: current, tokens: attemptTokens, budgetMs: attemptBudget };
      } catch {
        return { ok: false, collected: null, timedOut: expired, attempt: current, tokens: attemptTokens, budgetMs: attemptBudget };
      } finally {
        clock.clearTimeout(timer);
        signal?.removeEventListener?.('abort', forward);
      }
    };
    const cancelled = () => signal?.aborted === true;
    const failureCode = (outcome) => (
      outcome.timedOut && !cancelled()
        ? 'TRANSLATE_TIMEOUT'
        : (cancelled() ? 'TRANSLATE_CANCELLED' : 'TRANSLATE_REQUEST_FAILED')
    );
    /** How long this request waited for a slot (0 when one was free): reported per lane. */
    let queueWaitMs = 0;
    const fail = (code, extra = {}) => {
      const ms = Math.max(0, now() - startedAt);
      notify({
        onEvent,
        type: 'voice.translate.failed',
        payload: { code, from: fromLang, to: toLang, purpose: use, queueWaitMs, ms, ...join, ...extra },
      });
      const result = { ok: false, code, text: '', cached: false, ms, queueWaitMs };
      // A cancelled owner never cancels the OTHER purpose: a still-waiting caller takes the
      // request over. Only when every waiter cancelled too does the request really end.
      if (code === 'TRANSLATE_CANCELLED' && handOver()) return result;
      if (code === 'TRANSLATE_CANCELLED') {
        notify({ onEvent, type: 'translate.share.cancelled', payload: { waiters: group.joined } });
      }
      settleShared(result);
      return result;
    };
    /** A dead attempt: a TIMEOUT event carries the scene — which attempt, its deadline and budget. */
    const failAttempt = (outcome) => {
      const code = failureCode(outcome);
      return code === 'TRANSLATE_TIMEOUT'
        ? fail(code, { budgetMs: outcome.budgetMs ?? limit, attempt: outcome.attempt, maxTokens: outcome.tokens })
        : fail(code);
    };

    // Only a sentence that really reaches the model holds a slot: a cache hit never waits, a
    // sentence that times out releases its slot for the sentences behind it, and a QUEUED sentence
    // still leaves the queue when its turn is cancelled (an interrupt never waits behind a timeout).
    // The lane is the queue priority: a voice line goes before any queued subtitle.
    const queueLane = use === 'subtitle' ? 'subtitle' : 'voice';
    const queuedAt = now();
    const slot = await gate.acquire(signal, queueLane);
    queueWaitMs = Math.max(0, now() - queuedAt);
    if (!slot) return fail('TRANSLATE_CANCELLED');
    try {
      const { system, user } = translationPrompt({
        from: fromLang, to: toLang, jaSpeechScript: script, purpose: use,
      });
      // The same rules plus the direct-answer line: used by every retry below.
      const strictSystem = strictTranslationSystem(system);
      // The budget that produced the complete answer (raised only after a truncated retry).
      let attemptTokens = budget;
      let outcome = await callModel(system, user, source, attemptTokens);

      // A deadline is NOT a token problem: 2048 -> 8192 makes the line need even longer to finish.
      // The ONE timeout retry keeps the SAME budget and gets a fresh deadline plus the
      // direct-answer instruction (reasoning is what ran out of time). Other request errors keep
      // their old no-retry behaviour and are reported below.
      if (!outcome.ok && outcome.timedOut && !cancelled()) {
        // Log the dead attempt BEFORE the retry: a retry that succeeds must still leave the scene
        // behind (which attempt ran out, on which deadline), and two late attempts log two rows.
        failAttempt(outcome);
        notify({
          onEvent,
          type: 'voice.translate.retry',
          payload: { reason: 'timeout', from: attemptTokens, to: attemptTokens },
        });
        outcome = await callModel(strictSystem, user, source, attemptTokens, { strict: true });
      }
      if (!outcome.ok) return failAttempt(outcome);
      if (cancelled()) return fail('TRANSLATE_CANCELLED');

      // A `max-tokens` / `length` finish (or `truncated:true`) means the budget went into
      // reasoning, not into the line. Retry exactly ONCE with a much larger budget and a
      // direct-answer instruction; the event keeps the budgets, never the text.
      if (isTruncated(outcome.collected)) {
        // Only the FIRST round may raise the budget: after a timeout retry the line already spent
        // two windows, and a still-truncated answer is a half line (TRANSLATE_INCOMPLETE).
        if (outcome.attempt > 1) return fail('TRANSLATE_INCOMPLETE');
        const raised = retryMaxTokens(attemptTokens);
        notify({
          onEvent,
          type: 'voice.translate.retry',
          payload: { reason: 'max-tokens', from: attemptTokens, to: raised },
        });
        outcome = await callModel(strictSystem, user, source, raised, { strict: true });
        attemptTokens = raised;
        if (!outcome.ok) return failAttempt(outcome);
        if (cancelled()) return fail('TRANSLATE_CANCELLED');
        if (isTruncated(outcome.collected)) return fail('TRANSLATE_INCOMPLETE');
      }

      // `text-delta` alone proves nothing: an unfinished stream may already contain a plausible
      // half translation, and a structured answer that is not `finishReason:'stop'` (or is marked
      // truncated) may be a half line too. Only a complete answer may be repaired, cached or played.
      if (outcome.collected.complete !== true) return fail('TRANSLATE_INCOMPLETE');

      let translated = sanitizeTranslation(outcome.collected.text);
      const invalid = validateTranslation(translated, { source, from: fromLang });
      if (invalid !== '') return fail(invalid);

      // The context the request really carried (empty on the plain `request` seam). The boundary
      // check is deterministic, so a prompt that ignored the instruction still cannot get a
      // context-laden line cached or spoken.
      const targetChars = [...source].length;
      let contextChars = Number(outcome.collected.contextChars) || [...String(outcome.collected.context ?? '')].length;
      const boundary = translationBoundary({
        text: translated, source, context: outcome.collected.context,
      });
      if (boundary !== '') {
        notify({
          onEvent,
          type: 'voice.translate.boundary',
          payload: { reason: boundary, contextChars, targetChars, from: fromLang, to: toLang },
        });
        // ONE repair round from the ORIGINAL target (never from the polluted answer), then the
        // same boundary check again; a second violation falls back to the source language.
        const prompt = boundaryRepairPrompt({
          from: fromLang, to: toLang, jaSpeechScript: script, purpose: use, source,
        });
        const repaired = await callModel(prompt.system, prompt.user, '', attemptTokens, {
          wrap: false, mode: 'boundary-repair',
        });
        if (!repaired.ok) return failAttempt(repaired);
        if (cancelled()) return fail('TRANSLATE_CANCELLED');
        if (repaired.collected.complete !== true) return fail('TRANSLATE_INCOMPLETE');
        translated = sanitizeTranslation(repaired.collected.text);
        const afterRepair = validateTranslation(translated, { source, from: fromLang });
        if (afterRepair !== '') return fail(afterRepair);
        contextChars = Number(repaired.collected.contextChars) || contextChars;
        const stillBoundary = translationBoundary({
          text: translated, source, context: repaired.collected.context,
        });
        if (stillBoundary !== '') return fail('TRANSLATE_BOUNDARY');
      }

      if (toLang === 'ja') {
        // `mixed` keeps the historical failure code; both kana speech scripts report TRANSLATE_NOT_KANA.
        const failedCode = japaneseScript === 'mixed' ? 'TRANSLATE_NOT_JAPANESE' : 'TRANSLATE_NOT_KANA';
        let offenders = splitTranslationSentences(translated)
          .filter((piece) => !isValidJapaneseSentence(piece.text, japaneseScript));
        if (offenders.length > 0) {
          // ONE targeted round: only the sentences failing the selected script go back to the
          // model, with the same hard rules; every other sentence is kept and spliced back in place.
          const prompt = translationRepairPrompt({
            from: fromLang,
            to: toLang,
            sentences: offenders.map((piece) => piece.text.trim()),
            jaSpeechScript: script,
            purpose: use,
          });
          notify({ onEvent, type: 'voice.translate.repair', payload: { sentences: prompt.sentences } });
          // The repair round reuses the budget that just produced a complete answer and gets its
          // OWN fresh deadline; a truncation here is still INCOMPLETE (the retries belong above).
          const repaired = await callModel(
            prompt.system, prompt.user, prompt.sentences.join('\n'), attemptTokens,
            { mode: 'script-repair' },
          );
          if (!repaired.ok) return failAttempt(repaired);
          if (cancelled()) return fail('TRANSLATE_CANCELLED');
          if (repaired.collected.complete !== true) return fail('TRANSLATE_INCOMPLETE');
          const replacements = parseRepairSentences(repaired.collected.text, offenders.length);
          if (replacements === null) return fail(failedCode);
          translated = spliceRepairedSentences(translated, offenders, replacements);
          offenders = splitTranslationSentences(translated)
            .filter((piece) => !isValidJapaneseSentence(piece.text, japaneseScript));
          // Still failing after the one repair round: fail the WHOLE line so the caller speaks the
          // source language. An unreadable Japanese line is never synthesized.
          if (offenders.length > 0) return fail(failedCode);
        }
      }

      const ms = Math.max(0, now() - startedAt);
      cache.set(key, translated);
      notify({
        onEvent,
        type: 'voice.translate',
        payload: {
          ms, cached: false, from: fromLang, to: toLang, purpose: use, queueWaitMs, contextChars, targetChars, ...join,
        },
      });
      const result = { ok: true, text: translated, cached: false, ms, queueWaitMs };
      settleShared(result);
      return result;
    } finally {
      // An unexpected throw must not leave a joiner waiting forever.
      if (!group.settled) {
        settleShared({
          ok: false, code: 'TRANSLATE_CANCELLED', text: '', cached: false,
          ms: Math.max(0, now() - startedAt), queueWaitMs,
        });
      }
      gate.release();
    }
  }

  return {
    translate,
    cache,
    rulesVersion,
    jaSpeechScript: script,
    timeoutMs: limit,
    totalMs: totalLimit,
    maxTokens: budget,
    maxConcurrent: gate.max,
    /** Slot occupancy: `{active, peak, max}` — the testable evidence that the width was used. */
    stats: () => gate.stats(),
    /** Queued admissions per lane: `{servedVoice, servedSubtitle}` (the priority evidence). */
    priorityStats: () => gate.priorityStats(),
  };
}

/** `voice.latency` extension fields; absent when translation did not run for the first sentence. */
export function translationLatencyFields({ translateMs, cached, translateCached, translated } = {}) {
  const fields = {};
  const numeric = Number(translateMs);
  if (Number.isFinite(numeric) && numeric > 0) fields.translateMs = Math.round(numeric);
  const wasCached = cached === true || translateCached === true;
  if (translated === true || wasCached) fields.translateCached = wasCached;
  return fields;
}

function emitBestEffort(emit, type, payload) {
  if (typeof emit !== 'function') return;
  try {
    const task = emit(type, payload);
    if (task !== null && typeof task === 'object' && typeof task.catch === 'function') task.catch(() => {});
  } catch {
    /* observation can never break speech */
  }
}

/**
 * The shared speech outlet: caption = the original line, speech = the translated line.
 *
 * - `speechLang === textLang` (or a detected same-language line): no translator call at all.
 * - `assistant_say` passing Japanese while speech is Japanese: detected as `ja`, no translation.
 * - Translation failure/timeout/cancellation: `fallback: true`, `speechLang` becomes the SOURCE
 *   language, so the original Chinese line is synthesized as Chinese, never as `ja`.
 * - A cancellation after the in-flight translation settles (`signal.aborted`) throws, so a late
 *   result can never reach synthesis or the player.
 *
 * @param {string} text
 * @param {object} [options]
 * @returns {Promise<{ok: boolean, captionText: string, speechText: string, textLang: string,
 *   speechLang: string, translated: boolean, cached: boolean, translateMs: number,
 *   translateQueueWaitMs: number, fallback: boolean, code: string, sentenceId: any}>}
 */
export async function prepareSpeech(text, {
  speechLang = 'zh',
  textLang = undefined,
  translator = null,
  signal = undefined,
  sentenceId = null,
  context = null,
  emit = null,
  neighbors = null,
} = {}) {
  const captionText = typeof text === 'string' ? text : String(text ?? '');
  const sourceLang = normalizeLang(textLang) || detectLanguage(captionText);
  const targetLang = normalizeLang(speechLang) || 'zh';
  const base = {
    ok: true,
    captionText,
    speechText: captionText,
    textLang: sourceLang,
    speechLang: targetLang,
    translated: false,
    cached: false,
    translateMs: 0,
    translateQueueWaitMs: 0,
    fallback: false,
    code: '',
    sentenceId,
  };
  if (captionText.trim().length === 0 || sourceLang === targetLang) return base;

  const active = typeof translator === 'function' ? translator() : translator;
  if (active === null || active === undefined || typeof active.translate !== 'function') {
    emitBestEffort(emit, 'voice.translate.fallback', {
      from: sourceLang, to: targetLang, code: 'TRANSLATE_UNAVAILABLE', sentenceId,
    });
    return { ...base, ok: false, speechLang: sourceLang, fallback: true, code: 'TRANSLATE_UNAVAILABLE' };
  }

  signal?.throwIfAborted?.();
  const result = await active.translate(captionText, {
    from: sourceLang, to: targetLang, signal, purpose: 'speech', context, neighbors,
  });
  // The user interrupted while the model was thinking: discard the late result instead of
  // synthesizing and playing it into the new turn. `throwIfAborted` is the same contract the
  // synthesis seam already honours.
  signal?.throwIfAborted?.();

  if (result?.ok !== true) {
    const code = typeof result?.code === 'string' && result.code.length > 0 ? result.code : 'TRANSLATE_FAILED';
    emitBestEffort(emit, 'voice.translate.fallback', { from: sourceLang, to: targetLang, code, sentenceId });
    return {
      ...base,
      ok: false,
      speechLang: sourceLang,
      fallback: true,
      code,
      translateMs: Number(result?.ms) > 0 ? Math.round(Number(result.ms)) : 0,
      translateQueueWaitMs: Number(result?.queueWaitMs) > 0 ? Math.round(Number(result.queueWaitMs)) : 0,
    };
  }

  return {
    ...base,
    speechText: result.text,
    speechLang: targetLang,
    translated: true,
    cached: result.cached === true,
    // True when this line joined a same-form translation already in flight (the subtitle's, when
    // both lanes target the same language): the round paid ONE model call, not two.
    reused: result.reused === true,
    translateMs: Number(result.ms) > 0 ? Math.round(Number(result.ms)) : 0,
    translateQueueWaitMs: Number(result.queueWaitMs) > 0 ? Math.round(Number(result.queueWaitMs)) : 0,
  };
}

/**
 * The subtitle stream: translate the body line into the subtitle language. It never produces
 * audio and never throws on a translation failure — the original line stays the caption, so a
 * broken or slow subtitle can neither silence nor delay the speech lane.
 *
 * `captionLang` is `langs.subtitle`; `textLang` (when known) is the explicit body language and
 * wins over detection. Same target and source skip the model entirely.
 *
 * @param {string} text
 * @param {{captionLang?: string, textLang?: string, translator?: any, signal?: AbortSignal,
 *   sentenceId?: any, emit?: Function}} [options]
 * @returns {Promise<{ok: boolean, captionText: string, textLang: string, captionLang: string,
 *   translated: boolean, cached: boolean, translateMs: number, code: string, sentenceId: any}>}
 */
export async function prepareCaption(text, {
  captionLang = 'zh',
  textLang = undefined,
  translator = null,
  signal = undefined,
  sentenceId = null,
  emit = null,
} = {}) {
  const original = typeof text === 'string' ? text : String(text ?? '');
  const sourceLang = normalizeLang(textLang) || detectLanguage(original);
  const targetLang = normalizeLang(captionLang) || 'zh';
  const base = {
    ok: true,
    captionText: original,
    textLang: sourceLang,
    captionLang: targetLang,
    translated: false,
    cached: false,
    translateMs: 0,
    code: '',
    sentenceId,
  };
  if (original.trim().length === 0 || sourceLang === targetLang) return base;

  const active = typeof translator === 'function' ? translator() : translator;
  if (active === null || active === undefined || typeof active.translate !== 'function') {
    emitBestEffort(emit, 'voice.subtitle.fallback', {
      from: sourceLang, to: targetLang, code: 'TRANSLATE_UNAVAILABLE', sentenceId,
    });
    return { ...base, ok: false, code: 'TRANSLATE_UNAVAILABLE' };
  }

  signal?.throwIfAborted?.();
  const result = await active.translate(original, {
    from: sourceLang, to: targetLang, signal, purpose: 'subtitle',
  });
  signal?.throwIfAborted?.();

  if (result?.ok !== true) {
    const code = typeof result?.code === 'string' && result.code.length > 0 ? result.code : 'TRANSLATE_FAILED';
    emitBestEffort(emit, 'voice.subtitle.fallback', { from: sourceLang, to: targetLang, code, sentenceId });
    return {
      ...base,
      ok: false,
      code,
      translateMs: Number(result?.ms) > 0 ? Math.round(Number(result.ms)) : 0,
    };
  }

  return {
    ...base,
    captionText: result.text,
    translated: true,
    cached: result.cached === true,
    translateMs: Number(result.ms) > 0 ? Math.round(Number(result.ms)) : 0,
  };
}

/**
 * Start both reply streams together. The returned promises are independent: the caller awaits
 * the speech one for synthesis and may use the caption one whenever it settles, so the subtitle
 * never blocks the voice and the voice never delays the subtitle.
 */
export function prepareReplyStreams(text, options = {}) {
  return {
    caption: prepareCaption(text, options),
    speech: prepareSpeech(text, options),
  };
}
