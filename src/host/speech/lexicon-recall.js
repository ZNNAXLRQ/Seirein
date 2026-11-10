/**
 * Lexicon v2 — local candidate recall engine (pure module).
 *
 * This module answers one question only: "given the shared lexicon's confirmed entries and this
 * turn's text, which few entries COULD the text be talking about?" It never rewrites the text,
 * never confirms anything, never reads a file and never calls a model. The host wiring and the
 * actual correction/paraphrase injection are deliberately out of scope.
 *
 * Sources of evidence, strongest first:
 *   1. exact occurrence of canonical / text / wrongForms (format-insensitive: NFKC, case fold,
 *      whitespace and punctuation ignored; a Latin form must sit on a word boundary);
 *   2. the entry's optional `reading`: an exact reading-like token, edit distance <= 1, or a
 *      shared reading fragment. Readings are never generated here (no pinyin dependency), so a
 *      pure-hanzi utterance cannot be matched against a pinyin reading unless the utterance
 *      itself carries that phonetic spelling/kana;
 *   3. for entries without a useful reading, conservative character similarity: bounded
 *      Levenshtein distance plus bigram Dice (unigram Dice for 2-3 char forms, where bigrams are
 *      too sparse). Latin forms are only compared against whole tokens / adjacent token joins to
 *      avoid matching "ann" inside "banana";
 *   4. `category`/`usage` only add a small bonus (at most 0.05) to an entry that has ALREADY
 *      matched on form or reading — they can never pull in an unrelated word by themselves.
 *
 * Close scores are reported honestly: when the top two candidates are less than
 * `RECALL_AMBIGUITY_GAP` apart the result carries `ambiguous: true`; the caller must not treat
 * that as a single answer. Ambiguity is judged on the full match set BEFORE `limit` truncates it,
 * so a small limit cannot hide a close second candidate. Results are bounded (`limit`, default 3)
 * and computed on a bounded projection of the text.
 *
 * Entry shape accepted (extra fields are ignored, malformed entries are skipped):
 *   {id, text, canonical, category, usage, reading, wrongForms: string[]}
 */

/** Default maximum number of candidates returned. */
import { splitLexiconCategories } from './lexicon-store.js';

export const RECALL_DEFAULT_LIMIT = 3;

/** Hard upper bound for a caller-supplied limit. */
export const RECALL_MAX_LIMIT = 10;

/** Top-two score gap below which the result is ambiguous. */
export const RECALL_AMBIGUITY_GAP = 0.08;

/** Minimum score for a candidate to be reported at all. */
export const RECALL_MIN_SCORE = 0.7;

/** Text is projected up to this many code points; the rest is ignored. */
const MAX_TEXT_CHARS = 500;

/** A defensive scan bound; the shared confirmed lexicon is user-managed and small. */
const MAX_ENTRIES = 5000;

/** Per-entry form bound (wrongForms can be user supplied). */
const MAX_FORMS_PER_ENTRY = 24;

/** A single form/reading longer than this is not a plausible lexicon word. */
const MAX_FORM_CHARS = 80;

/** Weights for an exact form hit, by field. */
const EXACT_FORM_SCORE = Object.freeze({
  canonical: 0.97,
  text: 0.95,
  wrongForm: 0.93,
});

/** Reading scores. */
const READ_EXACT_SCORE = 0.9;
const READ_NEAR_SCORE = 0.82;
const READ_FRAGMENT_BASE = 0.7;

/** Category labels used only for the light bonus. Unknown categories add nothing. */
const CATEGORY_HINTS = Object.freeze({
  person: ['人物', '人名', '名字'],
  character: ['角色', '人物'],
  work: ['作品', '番剧', '动画', '游戏'],
  place: ['地名', '地点', '地方'],
  term: ['术语', '名词', '专有名词'],
  expression: ['口头禅', '说法', '表达'],
  meme: ['梗', '段子', '网络用语'],
  unknown: [],
});

/** Grammatical bigrams in a usage description that should not count as semantic overlap. */
const USAGE_STOP_BIGRAMS = new Set([
  '一个', '这个', '那个', '一种', '可以', '用于', '的是', '以及', '或者',
  '什么', '表示', '通常', '一般', '用来', '当作', '这是', '就是', '也是',
]);

const PINYIN_FOLD = new Map(Object.entries({
  ā: 'a', á: 'a', ǎ: 'a', à: 'a',
  ē: 'e', é: 'e', ě: 'e', è: 'e',
  ī: 'i', í: 'i', ǐ: 'i', ì: 'i',
  ō: 'o', ó: 'o', ǒ: 'o', ò: 'o',
  ū: 'u', ú: 'u', ǔ: 'u', ù: 'u',
  ǖ: 'v', ǘ: 'v', ǚ: 'v', ǜ: 'v', ü: 'v',
}));

const CJK_CHAR_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]/u;
const CJK_RUN_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]+/gu;
const LATIN_TOKEN_RE = /[\p{Script=Latin}\p{Nd}]+/gu;

// ---- normalization and projection -----------------------------------------

/** Trim outer whitespace and wrapping quotes/brackets; content is preserved. */
function cleanDisplay(value) {
  if (typeof value !== 'string') return '';
  let text = value.trim();
  let previous = null;
  while (previous !== text && text.length > 0) {
    previous = text;
    text = text
      .replace(/^[\s"'“”‘’「」『』《》〈〉()（）[\]【】]+/u, '')
      .replace(/[\s"'“”‘’「」『』《》〈〉()（）[\]【】]+$/u, '')
      .trim();
  }
  return text;
}

/**
 * Matching projection: NFKC, case folded, every punctuation/space run collapsed to one space.
 * Hyphens/dots are separators here; "GPT-4" therefore becomes "gpt 4" and is compared to
 * "gpt4" through the compact projection instead.
 * @param {unknown} value
 * @returns {string}
 */
function normalizeForm(value) {
  if (typeof value !== 'string') return '';
  const text = value.normalize('NFKC').toLowerCase();
  return text
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ')
    .trim()
    .replace(/\s+/gu, ' ');
}

/**
 * Reading projection: NFKC, case folded, common pinyin tone marks folded away, tone digits and
 * separators removed, Han/kana preserved. No pinyin is generated.
 * @param {unknown} value
 * @returns {string}
 */
function normalizeReading(value) {
  if (typeof value !== 'string') return '';
  const lowered = value.normalize('NFKC').toLowerCase();
  let folded = '';
  for (const char of lowered) folded += PINYIN_FOLD.get(char) ?? char;
  return folded
    .replace(/[^a-z0-9\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]/gu, '')
    .replace(/[1-5]/gu, '');
}

/** Code points of a string (surrogate-pair safe). */
function toChars(value) {
  return [...value];
}

function isCjkChar(char) {
  return typeof char === 'string' && CJK_CHAR_RE.test(char);
}

function isAsciiAlnum(char) {
  return typeof char === 'string' && char.length === 1 && /^[a-z0-9]$/u.test(char);
}

function isPureCjk(chars) {
  return chars.length > 0 && chars.every(isCjkChar);
}

function isPureLatin(chars) {
  return chars.length > 0 && chars.every((char) => /^[\p{Script=Latin}\p{Nd}]$/u.test(char));
}

function sameChars(a, b) {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

/** Bounded projection of the current turn's text. */
function projectText(raw) {
  const limited = toChars(raw).slice(0, MAX_TEXT_CHARS).join('');
  const form = normalizeForm(limited);
  const chars = toChars(form.replace(/ /gu, ''));
  const cjkRuns = [];
  for (const match of form.matchAll(CJK_RUN_RE)) cjkRuns.push(toChars(match[0]));
  const latinTokens = [];
  for (const match of form.matchAll(LATIN_TOKEN_RE)) latinTokens.push(toChars(match[0]));
  return {
    form,
    compact: form.replace(/ /gu, ''),
    chars,
    charSet: new Set(chars),
    cjkRuns,
    latinTokens,
  };
}

// ---- string metrics -------------------------------------------------------

/** Full Levenshtein distance over code-point arrays. */
function levenshtein(a, b) {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous = new Array(b.length + 1);
  let current = new Array(b.length + 1);
  for (let column = 0; column <= b.length; column += 1) previous[column] = column;
  for (let row = 1; row <= a.length; row += 1) {
    current[0] = row;
    const char = a[row - 1];
    for (let column = 1; column <= b.length; column += 1) {
      const cost = char === b[column - 1] ? 0 : 1;
      current[column] = Math.min(
        previous[column] + 1,
        current[column - 1] + 1,
        previous[column - 1] + cost,
      );
    }
    [previous, current] = [current, previous];
  }
  return previous[b.length];
}

function bigramSet(chars) {
  const set = new Set();
  if (chars.length === 1) {
    set.add(chars[0]);
  } else {
    for (let index = 0; index + 1 < chars.length; index += 1) {
      set.add(chars[index] + chars[index + 1]);
    }
  }
  return set;
}

function diceOfSets(left, right) {
  if (left.size === 0 && right.size === 0) return 1;
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const item of left) if (right.has(item)) shared += 1;
  return (2 * shared) / (left.size + right.size);
}

function unigramDice(a, b) {
  return diceOfSets(new Set(a), new Set(b));
}

function bigramDice(a, b) {
  return diceOfSets(bigramSet(a), bigramSet(b));
}

/** Length of the longest common contiguous run of code points. */
function longestCommonSubstring(a, b) {
  if (a.length === 0 || b.length === 0) return 0;
  let previous = new Array(b.length + 1).fill(0);
  let current = new Array(b.length + 1).fill(0);
  let best = 0;
  for (let row = 1; row <= a.length; row += 1) {
    for (let column = 1; column <= b.length; column += 1) {
      if (a[row - 1] === b[column - 1]) {
        current[column] = previous[column - 1] + 1;
        if (current[column] > best) best = current[column];
      } else {
        current[column] = 0;
      }
    }
    [previous, current] = [current, previous];
    current.fill(0);
  }
  return best;
}

/** Exact occurrence, with an ASCII word-boundary check for Latin ends. */
function containsExact(haystack, needle) {
  if (haystack.length === 0 || needle.length === 0) return false;
  const latinStart = isAsciiAlnum(needle[0]);
  const latinEnd = isAsciiAlnum(needle[needle.length - 1]);
  let from = 0;
  while (from <= haystack.length - needle.length) {
    const index = haystack.indexOf(needle, from);
    if (index < 0) return false;
    const beforeOk = !latinStart || index === 0 || !isAsciiAlnum(haystack[index - 1]);
    const end = index + needle.length;
    const afterOk = !latinEnd || end >= haystack.length || !isAsciiAlnum(haystack[end]);
    if (beforeOk && afterOk) return true;
    from = index + 1;
  }
  return false;
}

/**
 * Comparison spans from the text, by needle script:
 *  - CJK: windows of needle length +/- 1 inside each CJK run (no word boundaries exist);
 *  - Latin: whole tokens plus up to three adjacent tokens joined (spacing-insensitive), never a
 *    window inside a longer token;
 *  - mixed: windows of the compact text, keeping ASCII boundary rules at the needle's ends.
 */
function spansFor(text, needleChars) {
  const length = needleChars.length;
  const lengths = [...new Set([Math.max(2, length - 1), length, length + 1])]
    .filter((candidate) => candidate >= 2);
  const spans = [];
  if (isPureCjk(needleChars)) {
    for (const run of text.cjkRuns) {
      for (const windowLength of lengths) {
        for (let index = 0; index + windowLength <= run.length; index += 1) {
          spans.push(run.slice(index, index + windowLength));
        }
      }
    }
    return spans;
  }
  if (isPureLatin(needleChars)) {
    for (let index = 0; index < text.latinTokens.length; index += 1) {
      let joined = text.latinTokens[index];
      spans.push(joined);
      for (let extra = 1; extra <= 2 && index + extra < text.latinTokens.length; extra += 1) {
        joined = joined.concat(text.latinTokens[index + extra]);
        spans.push(joined);
      }
    }
    return spans;
  }
  const latinStart = isAsciiAlnum(needleChars[0]);
  const latinEnd = isAsciiAlnum(needleChars[length - 1]);
  for (const windowLength of lengths) {
    for (let index = 0; index + windowLength <= text.chars.length; index += 1) {
      if (latinStart && index > 0 && isAsciiAlnum(text.chars[index - 1])) continue;
      const end = index + windowLength;
      if (latinEnd && end < text.chars.length && isAsciiAlnum(text.chars[end])) continue;
      spans.push(text.chars.slice(index, end));
    }
  }
  return spans;
}

// ---- per-signal scoring ---------------------------------------------------

/** Conservative near-form score, or null when the form does not qualify. */
function fuzzyFormScore(text, needleChars) {
  const length = needleChars.length;
  if (length < 2) return null;
  const maxDistance = length <= 5 ? 1 : 2;

  const shared = new Set();
  for (const char of needleChars) if (text.charSet.has(char)) shared.add(char);
  if (shared.size < length - maxDistance) return null;

  let best = null;
  for (const span of spansFor(text, needleChars)) {
    if (span.length < length - 1 || span.length > length + 1) continue;
    const distance = levenshtein(needleChars, span);
    if (distance > maxDistance) continue;
    const editSimilarity = 1 - distance / Math.max(length, span.length);
    let similarity;
    if (length <= 3) {
      similarity = (editSimilarity + unigramDice(needleChars, span)) / 2;
    } else {
      const dice = bigramDice(needleChars, span);
      if (distance > 0 && dice < 0.45) continue;
      similarity = 0.65 * editSimilarity + 0.35 * dice;
    }
    const score = Math.min(0.92, 0.5 + 0.42 * similarity);
    if (best === null || score > best.score) best = {score, distance};
  }
  return best;
}

/** Reading signal: exact, edit distance <= 1, or a substantial shared fragment. */
function readingScore(text, readingChars) {
  const length = readingChars.length;
  if (length < 3) return null;
  const spans = spansFor(text, readingChars);
  let best = null;

  for (const span of spans) {
    if (Math.abs(span.length - length) > 2) continue;
    const distance = levenshtein(readingChars, span);
    if (distance === 0) {
      return {score: READ_EXACT_SCORE, reason: 'reading:exact'};
    }
    if (distance === 1) {
      const score = READ_NEAR_SCORE;
      if (best === null || score > best.score) best = {score, reason: 'reading:near'};
    }
  }

  const minimumFragment = Math.max(3, Math.ceil(length * 0.6));
  const pools = [...spans, ...text.cjkRuns];
  for (const span of pools) {
    if (span.length < 3) continue;
    const fragment = longestCommonSubstring(readingChars, span);
    if (fragment < minimumFragment) continue;
    const ratio = fragment / Math.min(length, span.length);
    if (ratio < 0.6) continue;
    const score = READ_FRAGMENT_BASE + 0.1 * Math.min(1, ratio);
    if (best === null || score > best.score) {
      best = {score, reason: 'reading:fragment'};
    }
  }
  return best;
}

function usageOverlap(usageForm, textForm) {
  const normalized = normalizeForm(usageForm);
  if (normalized.length === 0) return false;
  for (const token of normalized.match(LATIN_TOKEN_RE) ?? []) {
    if (toChars(token).length >= 3 && containsExact(textForm, token)) return true;
  }
  const chars = toChars(normalized.replace(/ /gu, ''));
  if (chars.length < 2) return false;
  for (let index = 0; index + 1 < chars.length; index += 1) {
    const bigram = chars[index] + chars[index + 1];
    if (USAGE_STOP_BIGRAMS.has(bigram)) continue;
    if (textForm.includes(bigram)) return true;
  }
  return false;
}

/** Category/usage evidence is capped and applied only after a real match. */
function contextBonus(entry, textForm) {
  let bonus = 0;
  const reasons = [];
  const category = typeof entry.category === 'string' ? entry.category : '';
  const hints = splitLexiconCategories(category).flatMap((label) => CATEGORY_HINTS[label] ?? []);
  if (hints.some((hint) => textForm.includes(hint))) {
    bonus += 0.03;
    reasons.push('category:hint');
  }
  if (usageOverlap(entry.usage, textForm)) {
    bonus += 0.02;
    reasons.push('usage:overlap');
  }
  return {bonus: Math.min(0.05, bonus), reasons};
}

function roundScore(value) {
  return Math.round(value * 10000) / 10000;
}

// ---- entry evaluation -----------------------------------------------------

function collectForms(entry) {
  const canonical = cleanDisplay(entry.canonical);
  const text = cleanDisplay(entry.text);
  const displayCanonical = canonical || text;
  if (displayCanonical.length === 0) return null;

  const forms = [];
  const seen = new Set();
  const push = (value, label) => {
    if (typeof value !== 'string') return;
    const form = normalizeForm(value);
    if (form.length === 0) return;
    const chars = toChars(form.replace(/ /gu, ''));
    if (chars.length === 0 || chars.length > MAX_FORM_CHARS) return;
    const key = `${label}\u0000${form}`;
    if (seen.has(key)) return;
    seen.add(key);
    forms.push({label, form, chars});
  };

  push(entry.canonical, 'canonical');
  push(entry.text, 'text');
  if (Array.isArray(entry.wrongForms)) {
    for (const wrong of entry.wrongForms.slice(0, MAX_FORMS_PER_ENTRY)) {
      push(wrong, 'wrongForm');
    }
  }

  const reading = normalizeReading(entry.reading);
  const readingChars = toChars(reading);
  return {
    displayCanonical,
    displayText: text || displayCanonical,
    category: typeof entry.category === 'string' ? entry.category : 'unknown',
    usage: typeof entry.usage === 'string' ? entry.usage : '',
    forms,
    readingChars: readingChars.length > MAX_FORM_CHARS ? [] : readingChars,
  };
}

function evaluateEntry(entry, text) {
  const projected = collectForms(entry);
  if (projected === null) return null;

  let base = 0;
  const reasons = [];

  for (const form of projected.forms) {
    // Spacing is not identity: "OpenAI" also matches an ASR "open ai", while the ASCII boundary
    // check still keeps "ann" out of "banana".
    if (
      containsExact(text.form, form.form)
      || containsExact(text.compact, form.chars.join(''))
    ) {
      const score = EXACT_FORM_SCORE[form.label];
      if (score > base) base = score;
      const reason = `exact:${form.label}`;
      if (!reasons.includes(reason)) reasons.push(reason);
      continue;
    }
    if (base >= EXACT_FORM_SCORE.canonical) continue;
    const fuzzy = fuzzyFormScore(text, form.chars);
    if (fuzzy !== null && fuzzy.score > base) {
      base = fuzzy.score;
      if (!reasons.includes('form:near')) reasons.push('form:near');
    }
  }

  if (base < READ_EXACT_SCORE && projected.readingChars.length >= 3) {
    const reading = readingScore(text, projected.readingChars);
    if (reading !== null && reading.score > base) {
      base = reading.score;
      if (!reasons.includes(reading.reason)) reasons.push(reading.reason);
    }
  }

  if (base < RECALL_MIN_SCORE) return null;

  const context = contextBonus(entry, text.form);
  for (const reason of context.reasons) {
    if (!reasons.includes(reason)) reasons.push(reason);
  }

  return {
    id: typeof entry.id === 'string' || typeof entry.id === 'number' ? entry.id : null,
    text: projected.displayText,
    canonical: projected.displayCanonical,
    category: projected.category,
    usage: projected.usage,
    score: roundScore(Math.min(1, base + context.bonus)),
    reasons,
  };
}

function normalizeLimit(value) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    return RECALL_DEFAULT_LIMIT;
  }
  return Math.min(value, RECALL_MAX_LIMIT);
}

function emptyResult() {
  return {entries: [], ambiguous: false};
}

/**
 * Recall a small, bounded set of lexicon candidates for one turn's text.
 *
 * Primary call shape:
 *   recallLexiconCandidates({entries, text, limit: 3})
 * The positional form `recallLexiconCandidates(entries, text, {limit})` is accepted as well.
 *
 * @param {unknown} input
 * @param {unknown} [textArg]
 * @param {unknown} [optionsArg]
 * @returns {{entries: Array<{id: string|number|null, text: string, canonical: string,
 *   category: string, usage: string, score: number, reasons: string[]}>, ambiguous: boolean}}
 */
export function recallLexiconCandidates(input = {}, textArg, optionsArg = {}) {
  let entries;
  let text;
  let options;
  if (Array.isArray(input)) {
    entries = input;
    text = textArg;
    options = optionsArg;
  } else if (input !== null && typeof input === 'object') {
    entries = input.entries;
    text = input.text;
    options = input;
  } else {
    return emptyResult();
  }

  if (!Array.isArray(entries) || entries.length === 0) return emptyResult();
  if (typeof text !== 'string') return emptyResult();

  const projected = projectText(text);
  if (projected.chars.length === 0) return emptyResult();

  const limit = normalizeLimit(options && typeof options === 'object' ? options.limit : undefined);
  const scanned = entries.length > MAX_ENTRIES ? entries.slice(0, MAX_ENTRIES) : entries;
  const matches = [];
  for (const entry of scanned) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    let candidate = null;
    try {
      candidate = evaluateEntry(entry, projected);
    } catch {
      candidate = null;
    }
    if (candidate !== null) matches.push(candidate);
  }

  matches.sort((left, right) => right.score - left.score);
  const ambiguous = matches.length >= 2
    && matches[0].score - matches[1].score < RECALL_AMBIGUITY_GAP;

  return {
    entries: matches.slice(0, limit),
    ambiguous,
  };
}

export default recallLexiconCandidates;
