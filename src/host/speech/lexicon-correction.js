/**
 * Lexicon v2 — replacement decision (pure module).
 *
 * This module answers one question only: "given this ASR text and the candidates recalled for it,
 * which exact substrings may be rewritten, and into what?" It never formats, translates, speaks or
 * delivers text, never reads a file, never touches the clock and never calls a model or network.
 * `planLexiconCorrection` returns a plan; `applyLexiconPlan` executes one plan with pure string
 * surgery. Nothing here confirms a lexicon entry or writes the raw ASR copy.
 *
 * Decision rules (all deliberately conservative):
 *   - the top candidate must be clear: `score >= CORRECTION_MIN_SCORE` and the gap to the second
 *     candidate `>= CORRECTION_MIN_GAP` (recall's `ambiguous:true` is honoured as well);
 *   - exact canonical/text/wrongForm and `reading:exact` evidence may replace on score alone;
 *   - `form:near`, `reading:near` and `reading:fragment` need context/usage support (a stored
 *     context, a matching context passed by the caller, or `usage:overlap`);
 *   - evidence consisting only of `category:hint` / `usage:overlap` never replaces;
 *   - only the recognised spelling is changed, never surrounding negation/facts; an occurrence
 *     inside an explicit correction ("不是甲，是乙") or a fact-shaped form (dates/counts) is left
 *     alone rather than rewriting the statement;
 *   - overlapping spans are resolved by specificity: the longer form wins, then exact evidence,
 *     then score; an equal-length tie inside the gap is ambiguous and is not replaced.
 *
 * Locating the surface form: recall candidates expose the confirmed `canonical`, not the matched
 * surface. This module therefore uses, in order: an optional caller-provided span/`matchedForm`,
 * optional `wrongForms`/`reading` (a recall caller may enrich candidates with them), literal
 * occurrences of the candidate's known forms, then a bounded fuzzy window around the canonical
 * (or reading). A candidate that cannot be located is reported with `span-not-found`; enrichment
 * of the recall output is host wiring work and intentionally not done here.
 *
 * Primary API:
 *   planLexiconCorrection(text, candidates, options?)
 *   planLexiconCorrection({text, candidates, context?, sentence?, ...})
 *   applyLexiconPlan(text, plan)
 *
 * `candidates` may be the raw recall array or the `{entries, ambiguous}` recall result. Accepted
 * candidate extras: `wrongForms`, `matchedForm`/`surface`/`from`, `reading`, `context`,
 * `start`+`end` (or `span`), `kind`. Extra fields are ignored; malformed entries are skipped.
 *
 * Output plan shape: `{replacements: [{from, to, entryId, reason}], ambiguous, reason}`.
 * `applyLexiconPlan` returns `{text, applied}` where `applied` uses the same four fields.
 */

/** Minimum score for the top candidate to be allowed to rewrite anything. */
export const CORRECTION_MIN_SCORE = 0.85;

/** Minimum top1-top2 score gap for a non-ambiguous decision. Mirrors recall's ambiguity gap. */
export const CORRECTION_MIN_GAP = 0.08;

/** Planning is bounded to this many code points; the rest of a very long turn is ignored. */
const MAX_TEXT_CHARS = 500;

/** Recall returns at most ten candidates; extra input beyond this is ignored. */
const MAX_CANDIDATES = 10;

/** A single surface form longer than this is not a plausible word form. */
const MAX_FORM_CHARS = 80;

/** How many stored context characters must match on each side. */
const CONTEXT_WINDOW = 4;

/** Maximum number of fuzzy occurrences accepted for one candidate without explicit forms. */
const MAX_FUZZY_OCCURRENCES = 1;

const ASCII_ALNUM_RE = /^[A-Za-z0-9]$/u;
const LETTER_OR_NUMBER_RE = /[\p{L}\p{N}\p{M}]/u;

/** Explicit-correction cues immediately before a quoted wrong form. */
const NEGATION_BEFORE_RE = /(?:不是|并非|而不是|并不是|不叫|不读|不写作|没说|没有说|别叫|别写成|听成|误听成|认成|写成)\s*$/u;

/** Explicit corrections may also put the wrong form first and the right form after a comma. */
const NEGATION_AFTER_RE = /^\s*(?:，|,)?\s*(?:而是|是|应该|应该是|应为|写作|写成)/u;

/** A form that is a date/count/state fact, not a lexicon spelling. */
const FACTUAL_FORM_RE = new RegExp([
  '^(?:下|这|上)?(?:周|星期|礼拜)[一二三四五六日天]$',
  '^(?:今天|明天|昨天|后天|前天|今晚|明早|上午|下午|晚上|中午|早上|凌晨|现在)$',
  '^\\d{1,4}(?:年|月|日|号|点|分|秒|岁|个|只|次|天|周|元|块|米|斤|人|%|％)?$',
  '^(?:\\d{1,4}[-/.]\\d{1,2}[-/.]\\d{1,2}|\\d{1,2}月\\d{1,2}[日号])$',
  '^[零〇一二三四五六七八九十百千万两几]+(?:年|月|日|号|点|分|秒|岁|个|只|次|天|周|元|块|米|斤|人)?$',
  '^(?:没|没有|不|别|未|不要)(?:去|来|走|回|吃|喝|看|说|做|买|卖|给|拿|要|想|会|能|可以|是|有|在|对|好|行|用|玩|睡|起|坐|站|开|关|写|读|听|唱|跳|跑)$',
  '^(?:去|来|走|回|吃|喝|看|说|做|买|卖|给|拿|要|想|会|能|可以|是|有|在|对|好|行|用|玩|睡|起|坐|站|开|关|写|读|听|唱|跳|跑)(?:了|过|着)$',
].join('|'), 'u');

// ---- small pure helpers ---------------------------------------------------

function charsOf(value) {
  return [...value];
}

function clipChars(value, limit) {
  const chars = charsOf(value);
  return chars.length <= limit ? value : chars.slice(0, limit).join('');
}

function cleanDisplay(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function clipContext(value, side) {
  const chars = charsOf(value);
  return side === 'before'
    ? chars.slice(-CONTEXT_WINDOW).join('')
    : chars.slice(0, CONTEXT_WINDOW).join('');
}

function isWellFormed(value) {
  return typeof value.isWellFormed !== 'function' || value.isWellFormed();
}

function isAsciiAlnum(char) {
  return typeof char === 'string' && ASCII_ALNUM_RE.test(char);
}

/** A literal form must not sit inside a longer Latin/digit token. */
function boundaryOk(source, start, end) {
  const first = source[start];
  const last = source[end - 1];
  if (isAsciiAlnum(first) && start > 0 && isAsciiAlnum(source[start - 1])) return false;
  if (isAsciiAlnum(last) && end < source.length && isAsciiAlnum(source[end])) return false;
  return true;
}

/** All non-overlapping literal occurrences of one form, respecting ASCII token boundaries. */
function literalOccurrences(source, form) {
  const occurrences = [];
  if (typeof form !== 'string' || form.length === 0 || form.length > MAX_FORM_CHARS) return occurrences;
  let from = 0;
  while (from <= source.length - form.length) {
    const start = source.indexOf(form, from);
    if (start < 0) break;
    const end = start + form.length;
    if (boundaryOk(source, start, end)) occurrences.push({start, end});
    from = start + Math.max(1, form.length);
  }
  return occurrences;
}

function levenshtein(left, right) {
  if (left.length === 0) return right.length;
  if (right.length === 0) return left.length;
  let previous = new Array(right.length + 1);
  let current = new Array(right.length + 1);
  for (let column = 0; column <= right.length; column += 1) previous[column] = column;
  for (let row = 1; row <= left.length; row += 1) {
    current[0] = row;
    const char = left[row - 1];
    for (let column = 1; column <= right.length; column += 1) {
      const cost = char === right[column - 1] ? 0 : 1;
      current[column] = Math.min(
        previous[column] + 1,
        current[column - 1] + 1,
        previous[column - 1] + cost,
      );
    }
    [previous, current] = [current, previous];
  }
  return previous[right.length];
}

function bigramDice(left, right) {
  const leftSet = new Set();
  const rightSet = new Set();
  for (let index = 0; index + 1 < left.length; index += 1) leftSet.add(left[index] + left[index + 1]);
  for (let index = 0; index + 1 < right.length; index += 1) rightSet.add(right[index] + right[index + 1]);
  if (leftSet.size === 0 || rightSet.size === 0) return 0;
  let shared = 0;
  for (const bigram of leftSet) if (rightSet.has(bigram)) shared += 1;
  return (2 * shared) / (leftSet.size + rightSet.size);
}

/**
 * Character units (letters/numbers/marks) with their UTF-16 offsets. Windows over units can span
 * internal spaces or punctuation, which is what makes "xiang wan" comparable to "xiangwan".
 */
function projectUnits(value) {
  const units = [];
  let offset = 0;
  for (const char of charsOf(value)) {
    const start = offset;
    offset += char.length;
    const normalized = char.normalize('NFKC').toLowerCase();
    if (LETTER_OR_NUMBER_RE.test(normalized)) units.push({char: normalized, start, end: offset});
  }
  return units;
}

/** Does a unit window start/end on a whole Latin token? */
function unitBoundaryOk(source, units, startIndex, endIndex, targetChars) {
  const first = targetChars[0];
  const last = targetChars[targetChars.length - 1];
  if (isAsciiAlnum(first) && startIndex > 0) {
    const previous = units[startIndex - 1];
    if (previous.end === units[startIndex].start && isAsciiAlnum(source[previous.end - 1])) return false;
  }
  if (isAsciiAlnum(last) && endIndex < units.length) {
    const next = units[endIndex];
    if (units[endIndex - 1].end === next.start && isAsciiAlnum(source[next.start])) return false;
  }
  return true;
}

/** Bounded fuzzy windows for `target`; returns actual source spans and a 0..1 similarity. */
function fuzzyOccurrences(sourceUnits, source, target) {
  const targetChars = projectUnits(target).map((unit) => unit.char);
  const length = targetChars.length;
  if (length < 2 || length > MAX_FORM_CHARS || sourceUnits.length < 2) return [];
  const lengths = [...new Set([Math.max(2, length - 1), length, length + 1])]
    .filter((candidate) => candidate >= 2);
  const maxDistance = length <= 5 ? 1 : 2;
  const bestByStart = new Map();

  for (let startIndex = 0; startIndex < sourceUnits.length; startIndex += 1) {
    for (const windowLength of lengths) {
      const endIndex = startIndex + windowLength;
      if (endIndex > sourceUnits.length) continue;
      if (!unitBoundaryOk(source, sourceUnits, startIndex, endIndex, targetChars)) continue;
      const windowChars = [];
      for (let index = startIndex; index < endIndex; index += 1) {
        windowChars.push(sourceUnits[index].char);
      }
      const distance = levenshtein(targetChars, windowChars);
      if (distance > maxDistance) continue;
      const shared = new Set(targetChars);
      let common = 0;
      for (const char of new Set(windowChars)) if (shared.has(char)) common += 1;
      if (common < Math.max(1, length - maxDistance)) continue;
      const similarity = 1 - distance / Math.max(length, windowLength);
      if (length >= 4 && distance > 0 && bigramDice(targetChars, windowChars) < 0.4) continue;
      const start = sourceUnits[startIndex].start;
      const end = sourceUnits[endIndex - 1].end;
      const previous = bestByStart.get(start);
      if (previous === undefined || similarity > previous.similarity
        || (similarity === previous.similarity && end - start > previous.end - previous.start)) {
        bestByStart.set(start, {start, end, similarity});
      }
    }
  }

  const best = [...bestByStart.values()];
  if (best.length === 0) return [];
  best.sort((left, right) => right.similarity - left.similarity
    || (right.end - right.start) - (left.end - left.start)
    || left.start - right.start);
  const exact = best.filter((item) => item.similarity === 1);
  if (exact.length > 0) return exact; // an exact normalized occurrence is not a guess
  return best.slice(0, MAX_FUZZY_OCCURRENCES);
}

/** Normalize a stored/caller context to the checked window, or null when unusable. */
function usableContext(value) {
  if (value === null || typeof value !== 'object') return null;
  const before = typeof value.before === 'string' ? clipContext(value.before, 'before') : '';
  const after = typeof value.after === 'string' ? clipContext(value.after, 'after') : '';
  if (before.length === 0 && after.length === 0) return null;
  return {before, after};
}

function contextMatches(source, start, end, context) {
  const beforeOk = context.before.length === 0
    || source.slice(Math.max(0, start - context.before.length), start).endsWith(context.before);
  const afterOk = context.after.length === 0
    || source.slice(end, end + context.after.length).startsWith(context.after);
  return beforeOk && afterOk;
}

/** Bigram/word overlap between a usage description and arbitrary text (no scoring, just support). */
function usageOverlap(usage, text) {
  if (typeof usage !== 'string' || text.length === 0) return false;
  const normalizedUsage = usage.normalize('NFKC').toLowerCase();
  const normalizedText = text.normalize('NFKC').toLowerCase();
  for (const token of normalizedUsage.match(/[\p{Script=Latin}\p{Nd}]{3,}/gu) ?? []) {
    if (normalizedText.includes(token)) return true;
  }
  const chars = charsOf(normalizedUsage.replace(/[^\p{L}\p{N}\p{M}]+/gu, ''));
  for (let index = 0; index + 1 < chars.length; index += 1) {
    const bigram = chars[index] + chars[index + 1];
    if (normalizedText.includes(bigram)) return true;
  }
  return false;
}

/** Turn caller context/sentence/usage/pattern options into usable context evidence. */
function optionContexts(options) {
  const contexts = [];
  const pushString = (value) => {
    if (typeof value === 'string' && value.length > 0) contexts.push({text: value});
  };
  pushString(options.context);
  pushString(options.sentence);
  pushString(options.usage);
  pushString(options.pattern);
  if (options.context !== null && typeof options.context === 'object') {
    const context = usableContext(options.context);
    if (context !== null) contexts.push({context});
  }
  const direct = usableContext({before: options.before, after: options.after});
  if (direct !== null) contexts.push({context: direct});
  return contexts;
}

function contextSupports(candidate, occurrence, source, contexts) {
  const stored = usableContext(candidate.context);
  if (stored !== null && contextMatches(source, occurrence.start, occurrence.end, stored)) return true;
  for (const entry of contexts) {
    if (entry.context !== undefined
      && contextMatches(source, occurrence.start, occurrence.end, entry.context)) return true;
    if (entry.text !== undefined) {
      if (usageOverlap(candidate.usage, entry.text)) return true;
      if (typeof candidate.usage === 'string' && candidate.usage.length > 0
        && usageOverlap(entry.text, candidate.usage)) return true;
    }
  }
  if (candidate.reasons.includes('usage:overlap')) return true;
  return false;
}

function isFactualForm(form) {
  return typeof form === 'string' && form.length > 0 && FACTUAL_FORM_RE.test(form.trim());
}

function isFactualCandidate(candidate) {
  if (candidate.kind === 'fact-correction' || candidate.ignored === true) return true;
  if (candidate.raw?.reason === 'fact-correction') return true;
  if (isFactualForm(candidate.to)) return true;
  return candidate.forms.some(isFactualForm);
}

/** Is this occurrence quoted as the wrong side of an explicit correction/negation? */
function protectedByCorrection(source, start, end) {
  const before = source.slice(Math.max(0, start - 12), start);
  if (NEGATION_BEFORE_RE.test(before)) return true;
  const after = source.slice(end, Math.min(source.length, end + 12));
  return NEGATION_AFTER_RE.test(after) && /(?:不是|并非|而不是|并不是)/u.test(before);
}

// ---- input normalisation --------------------------------------------------

function normalizeCandidate(raw, index) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (typeof raw.score !== 'number' || !Number.isFinite(raw.score)) return null;
  const to = cleanDisplay(raw.canonical) || cleanDisplay(raw.to) || cleanDisplay(raw.text);
  if (to.length === 0 || to.length > MAX_FORM_CHARS || !isWellFormed(to)) return null;
  const reasons = Array.isArray(raw.reasons)
    ? raw.reasons.filter((reason) => typeof reason === 'string')
    : [];
  const forms = [];
  const addForm = (value) => {
    const form = cleanDisplay(value);
    if (form.length === 0 || form.length > MAX_FORM_CHARS || form === to || !isWellFormed(form)) return;
    if (!forms.includes(form)) forms.push(form);
  };
  if (typeof raw.matchedForm === 'string') addForm(raw.matchedForm);
  if (typeof raw.surface === 'string') addForm(raw.surface);
  if (typeof raw.form === 'string') addForm(raw.form);
  if (typeof raw.from === 'string') addForm(raw.from);
  if (typeof raw.wrongForm === 'string') addForm(raw.wrongForm);
  if (Array.isArray(raw.wrongForms)) {
    for (const form of raw.wrongForms.slice(0, 24)) addForm(form);
  }
  if (typeof raw.text === 'string' && raw.text !== to) addForm(raw.text);
  const reading = cleanDisplay(raw.reading);
  if ((reasons.includes('reading:exact') || reasons.includes('reading:near')
    || reasons.includes('reading:fragment')) && reading.length > 0) {
    addForm(reading);
  }
  const span = raw.span !== null && typeof raw.span === 'object' ? raw.span : raw;
  const start = Number.isInteger(span.start) ? span.start : null;
  const end = Number.isInteger(span.end) ? span.end : null;
  return {
    index,
    raw,
    id: typeof raw.id === 'string' || typeof raw.id === 'number' ? raw.id : null,
    to,
    score: raw.score,
    reasons,
    forms,
    reading: reading.length > 0 ? reading : '',
    context: raw.context ?? null,
    usage: typeof raw.usage === 'string' ? raw.usage : '',
    category: typeof raw.category === 'string' ? raw.category : '',
    kind: typeof raw.kind === 'string' ? raw.kind : '',
    ignored: raw.ignored === true,
    start,
    end,
  };
}

function normalizeCandidates(value) {
  let list = value;
  let ambiguous = false;
  if (list !== null && typeof list === 'object' && !Array.isArray(list)) {
    if (typeof list.ambiguous === 'boolean') ambiguous = list.ambiguous;
    list = list.entries ?? list.candidates ?? [];
  }
  if (!Array.isArray(list)) return {candidates: [], ambiguous};
  const candidates = [];
  for (let index = 0; index < Math.min(list.length, MAX_CANDIDATES); index += 1) {
    const candidate = normalizeCandidate(list[index], index);
    if (candidate !== null) candidates.push(candidate);
  }
  candidates.sort((left, right) => right.score - left.score || left.index - right.index);
  return {candidates, ambiguous};
}

function normalizeOptions(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    if (typeof value === 'string') return {context: value};
    return {};
  }
  return value;
}

/**
 * Accept `(text, candidates, options)`, `(candidates, text, options)` and the object form
 * `{text, candidates|entries, context?}`. Returns null for an unusable call.
 */
function readArguments(input, candidatesArg, optionsArg) {
  if (typeof input === 'string') {
    return {
      text: input,
      candidates: candidatesArg,
      options: normalizeOptions(optionsArg),
    };
  }
  if (Array.isArray(input)) {
    return {
      text: typeof candidatesArg === 'string' ? candidatesArg : '',
      candidates: input,
      options: normalizeOptions(optionsArg),
    };
  }
  if (input !== null && typeof input === 'object') {
    const options = normalizeOptions({
      ...input,
      ...(input.options !== null && typeof input.options === 'object' ? input.options : {}),
      ...normalizeOptions(optionsArg),
    });
    return {
      text: typeof input.text === 'string' ? input.text : '',
      candidates: input.candidates ?? input.entries ?? input.recall ?? null,
      options,
    };
  }
  return null;
}

// ---- evidence and span collection ----------------------------------------

function classifyEvidence(candidate) {
  const reasons = candidate.reasons;
  if (reasons.includes('exact:wrongForm')) {
    return {strength: 'exact', reason: 'exact:wrongForm'};
  }
  if (reasons.some((reason) => reason.startsWith('exact:'))) {
    return {strength: 'exact', reason: reasons.find((reason) => reason.startsWith('exact:'))};
  }
  if (reasons.includes('reading:exact')) {
    return {strength: 'reading-exact', reason: 'reading:exact'};
  }
  for (const reason of ['form:near', 'reading:near', 'reading:fragment']) {
    if (reasons.includes(reason)) return {strength: 'near', reason};
  }
  return {
    strength: 'weak',
    reason: reasons.includes('usage:overlap') || reasons.includes('category:hint')
      ? 'context-only'
      : 'no-evidence',
  };
}

function candidateSpans(candidate, source, sourceUnits, contexts) {
  const evidence = classifyEvidence(candidate);
  const spans = [];
  let blocked = '';
  const pushSpan = (start, end, reason) => {
    if (!Number.isInteger(start) || !Number.isInteger(end)
      || start < 0 || end > source.length || end <= start) return;
    const from = source.slice(start, end);
    if (from.length === 0 || from.length > MAX_FORM_CHARS || from === candidate.to) return;
    if (!isWellFormed(from)) return;
    if (protectedByCorrection(source, start, end)) {
      blocked = blocked || 'negation-context';
      return;
    }
    if (spans.some((span) => span.start === start && span.end === end)) return;
    const occurrence = {start, end, from};
    if (evidence.strength === 'near' && !contextSupports(candidate, occurrence, source, contexts)) {
      blocked = blocked || 'context-required';
      return;
    }
    spans.push({start, end, from, reason});
  };

  // 1. An explicit caller-provided span is the strongest locator.
  if (candidate.start !== null && candidate.end !== null) {
    pushSpan(candidate.start, candidate.end, evidence.reason);
  }

  // 2. Literal known forms (wrong spellings, a differing text field, an exact reading).
  for (const form of candidate.forms) {
    for (const span of literalOccurrences(source, form)) {
      pushSpan(span.start, span.end, evidence.reason);
    }
  }
  if (spans.length > 0) return {spans, evidence, reason: 'matched'};

  // 3. Fuzzy fallback: the confirmed spelling itself, or the reading when recall used phonetics.
  const targets = [];
  if (candidate.reading.length >= 2) targets.push(candidate.reading);
  if (!targets.includes(candidate.to)) targets.push(candidate.to);
  for (const target of targets) {
    for (const span of fuzzyOccurrences(sourceUnits, source, target)) {
      pushSpan(span.start, span.end, evidence.reason);
    }
  }
  if (spans.length > 0) return {spans, evidence, reason: 'matched'};
  if (blocked.length > 0) return {spans: [], evidence, reason: blocked};
  if (literalOccurrences(source, candidate.to).length > 0) {
    return {spans: [], evidence, reason: 'already-canonical'};
  }
  return {spans: [], evidence, reason: 'span-not-found'};
}

/** Exact evidence is more specific than a reading, which is more specific than a near form. */
function evidenceRank(strength) {
  if (strength === 'exact') return 3;
  if (strength === 'reading-exact') return 2;
  return 1;
}

/** Resolve competing spans: long form first, then evidence strength, then score. */
function resolveSpans(spans) {
  if (spans.length <= 1) return {selected: spans, ambiguous: false};
  const ambiguousIndexes = new Set();
  for (let left = 0; left < spans.length; left += 1) {
    for (let right = left + 1; right < spans.length; right += 1) {
      const a = spans[left];
      const b = spans[right];
      const overlap = a.start < b.end && b.start < a.end;
      if (!overlap) continue;
      const lengthA = a.end - a.start;
      const lengthB = b.end - b.start;
      if (lengthA !== lengthB) continue;
      if (a.evidenceRank !== b.evidenceRank) continue;
      if (Math.abs(a.score - b.score) < CORRECTION_MIN_GAP) {
        ambiguousIndexes.add(left);
        ambiguousIndexes.add(right);
      }
    }
  }
  const candidates = spans.filter((_span, index) => !ambiguousIndexes.has(index));
  candidates.sort((left, right) => (right.end - right.start) - (left.end - left.start)
    || right.evidenceRank - left.evidenceRank
    || right.score - left.score
    || left.start - right.start);
  const selected = [];
  for (const span of candidates) {
    if (selected.some((kept) => span.start < kept.end && kept.start < span.end)) continue;
    selected.push(span);
  }
  selected.sort((left, right) => left.start - right.start);
  return {selected, ambiguous: ambiguousIndexes.size > 0};
}

function emptyPlan(reason, ambiguous = false) {
  return {replacements: [], ambiguous, reason};
}

function defineSpan(replacement, span) {
  Object.defineProperties(replacement, {
    start: {value: span.start, enumerable: false},
    end: {value: span.end, enumerable: false},
  });
  return replacement;
}

/**
 * Decide whether/where the recalled lexicon candidates may rewrite one ASR text.
 *
 * @param {unknown} input ASR text, or `{text, candidates, context?, sentence?}`
 * @param {unknown} [candidatesArg] recall candidates or `{entries, ambiguous}`
 * @param {unknown} [optionsArg] `{context?, sentence?, before?, after?, usage?}`
 * @returns {{replacements: Array<{from: string, to: string, entryId: string|number|null,
 *   reason: string}>, ambiguous: boolean, reason: string}}
 */
export function planLexiconCorrection(input = {}, candidatesArg, optionsArg = {}) {
  const args = readArguments(input, candidatesArg, optionsArg);
  if (args === null) return emptyPlan('invalid-input');
  const sourceText = args.text;
  if (typeof sourceText !== 'string') return emptyPlan('invalid-text');
  if (sourceText.trim().length === 0) return emptyPlan('empty-text');

  const source = clipChars(sourceText, MAX_TEXT_CHARS);
  const {candidates, ambiguous: recallAmbiguous} = normalizeCandidates(args.candidates);
  if (candidates.length === 0) return emptyPlan('no-candidates');
  const options = args.options;
  if (options.ambiguous === true) {
    // A caller-provided ambiguity flag is authoritative for this decision.
    return emptyPlan('ambiguous', true);
  }

  const top = candidates[0];
  const second = candidates[1];
  if (top.score < CORRECTION_MIN_SCORE) return emptyPlan('low-confidence');
  if (recallAmbiguous || (second !== undefined && top.score - second.score < CORRECTION_MIN_GAP)) {
    return emptyPlan('ambiguous', true);
  }

  const topEvidence = classifyEvidence(top);
  if (topEvidence.strength === 'weak') return emptyPlan('weak-evidence');
  if (isFactualCandidate(top)) return emptyPlan('factual-form');

  const contexts = optionContexts(options);
  const sourceUnits = projectUnits(source);
  const topResult = candidateSpans(top, source, sourceUnits, contexts);
  if (topResult.spans.length === 0) return emptyPlan(topResult.reason);

  const spans = [];
  for (const span of topResult.spans) {
    spans.push({
      ...span,
      score: top.score,
      evidenceRank: evidenceRank(topResult.evidence.strength),
      entryId: top.id,
      candidate: top,
    });
  }
  // Lower candidates may cover a different, non-overlapping position in the same sentence.
  for (const candidate of candidates.slice(1)) {
    if (candidate.score < CORRECTION_MIN_SCORE) continue;
    if (classifyEvidence(candidate).strength === 'weak') continue;
    if (isFactualCandidate(candidate)) continue;
    const result = candidateSpans(candidate, source, sourceUnits, contexts);
    for (const span of result.spans) {
      spans.push({
        ...span,
        score: candidate.score,
        evidenceRank: evidenceRank(result.evidence.strength),
        entryId: candidate.id,
        candidate,
      });
    }
  }

  const resolved = resolveSpans(spans);
  if (resolved.selected.length === 0) {
    return emptyPlan(resolved.ambiguous ? 'ambiguous' : 'overlap', resolved.ambiguous);
  }
  const replacements = resolved.selected.map((span) => defineSpan({
    from: span.from,
    to: span.candidate.to,
    entryId: span.entryId,
    reason: span.reason,
  }, span));
  return {
    replacements,
    ambiguous: resolved.ambiguous,
    reason: resolved.ambiguous ? 'replace-with-ambiguity' : 'replace',
  };
}

/** Explicit aliases for callers that name the decision rather than the module. */
export const planLexiconReplacements = planLexiconCorrection;
export const planLexiconReplacement = planLexiconCorrection;
export const decideLexiconReplacement = planLexiconCorrection;

// ---- plan application -----------------------------------------------------

/** Find the literal occurrence to use when a serialized plan lost its hidden span. */
function fallbackOccurrence(source, replacement, usedStarts) {
  const occurrences = literalOccurrences(source, replacement.from);
  for (const occurrence of occurrences) {
    if (!usedStarts.has(occurrence.start)) return occurrence;
  }
  return null;
}

/**
 * Apply a plan from `planLexiconCorrection` to one text. Pure: no mutation, no I/O.
 *
 * Replacements are resolved to spans and applied from the end of the text towards the beginning,
 * so earlier offsets never shift. Overlapping or stale spans are skipped defensively; the result
 * reports only replacements that were actually applied. When a plan has been serialized and lost
 * its hidden spans, occurrences are located literally (the first unused occurrence wins).
 *
 * @param {unknown} text the text the plan was computed for
 * @param {unknown} plan `{replacements: [{from, to, entryId?, reason?}]}`
 * @returns {{text: string, applied: Array<{from: string, to: string,
 *   entryId: string|number|null, reason: string}>}}
 */
export function applyLexiconPlan(text, plan) {
  const source = typeof text === 'string' ? text : '';
  const result = {text: source, applied: []};
  if (source.length === 0 || plan === null || typeof plan !== 'object'
    || !Array.isArray(plan.replacements)) return result;

  const usedStarts = new Set();
  const resolved = [];
  for (const replacement of plan.replacements) {
    if (replacement === null || typeof replacement !== 'object') continue;
    if (typeof replacement.from !== 'string' || replacement.from.length === 0) continue;
    if (typeof replacement.to !== 'string' || replacement.from === replacement.to) continue;
    if (replacement.from.length > MAX_FORM_CHARS || replacement.to.length > MAX_FORM_CHARS) continue;
    if (!isWellFormed(replacement.from) || !isWellFormed(replacement.to)) continue;
    let span = null;
    if (Number.isInteger(replacement.start) && Number.isInteger(replacement.end)
      && replacement.start >= 0 && replacement.end <= source.length
      && replacement.end > replacement.start
      && source.slice(replacement.start, replacement.end) === replacement.from) {
      span = {start: replacement.start, end: replacement.end};
    } else {
      span = fallbackOccurrence(source, replacement, usedStarts);
    }
    if (span === null) continue;
    usedStarts.add(span.start);
    resolved.push({span, replacement});
  }

  // Apply from the end towards the beginning. At equal starts the longer span goes first.
  resolved.sort((left, right) => right.span.start - left.span.start
    || right.span.end - left.span.end);
  let output = source;
  let rightBoundary = source.length;
  const appliedWithOffsets = [];
  for (const item of resolved) {
    const {start, end} = item.span;
    if (end > rightBoundary) continue; // overlaps a span already applied to the right
    if (start < 0 || end > source.length || source.slice(start, end) !== item.replacement.from) continue;
    output = output.slice(0, start) + item.replacement.to + output.slice(end);
    rightBoundary = start;
    appliedWithOffsets.push({
      start,
      applied: {
        from: item.replacement.from,
        to: item.replacement.to,
        entryId: item.replacement.entryId ?? null,
        reason: typeof item.replacement.reason === 'string' ? item.replacement.reason : '',
      },
    });
  }
  appliedWithOffsets.sort((left, right) => left.start - right.start);
  result.text = output;
  result.applied = appliedWithOffsets.map((item) => item.applied);
  return result;
}

export default planLexiconCorrection;
