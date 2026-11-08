/**
 * Semantic duplicate CANDIDATES (P-67 stage 1: report only, never merge).
 *
 * Two memories can say the same thing in different words. Merging them would rewrite `ts` /
 * `clarity` / `recall_count`, the `message_id` unique index and the FTS mirror, so this stage
 * only ANSWERS a question: "which pairs look like duplicates?". It never writes a row, never
 * rebuilds/touches `memory_fts`, never emits an event and never imports the store. The caller
 * decides what (if anything) to do with the report — today: nothing.
 *
 * Rules, in order (all deterministic and testable):
 *   1. text after normalization is identical (punctuation / whitespace / fillers ignored);
 *   2. character-bigram Jaccard similarity >= `threshold` (default 0.75);
 *   3. same derived subject AND same `kind` AND similarity >= `subjectKindThreshold` (0.6);
 *   guards — a pair whose numbers/dates differ, whose negation differs, or whose subject
 *   differs (when both carry one) is NEVER a candidate, however similar the rest is.
 *
 * Normalization is deliberately reused from `memory-normalize.js` (relative dates become
 * absolute ones there), so "今天下雨了" and "2026-11-08 下雨了。" compare as one body without
 * this module duplicating any date logic. Only the comparison projection added here removes
 * punctuation/space/fillers; `normalizeForMemory` intentionally keeps the written body.
 *
 * Pure: every function is synchronous, takes plain objects, returns fresh objects, and never
 * mutates its input. `ftsQuery` is OPTIONAL, read-only and used only to widen the comparison
 * pool (rows it returns are never counted as evidence on their own).
 */
import { normalizeForMemory } from './memory-normalize.js';

export const DEDUP_DEFAULTS = Object.freeze({
  limit: 20,
  threshold: 0.75,
  subjectKindThreshold: 0.6,
});

/** Rows one `ftsQuery` probe may contribute to the pool (bounds the O(n²) pair scan). */
const FTS_ROWS_PER_PROBE = 20;

/** Punctuation / symbol / whitespace: a separator, never wording. */
const SEPARATOR_RE = /[^\p{L}\p{N}]+/gu;
/** Sentence-final fillers that carry no meaning for duplicate detection. */
const FILLER_EDGE_RE = /^[啊吧呢嘛呀哦噢啦咯呗嗯呃]+|[啊吧呢嘛呀哦噢啦咯呗嗯呃]+$/gu;

/**
 * A predicate marker: text before the first one is treated as the sentence's subject.
 * Longer time adverbs (每天/每周) are markers too, so "小明每天早上跑步" derives 小明.
 */
const PREDICATE_RE = /(?:喜欢|讨厌|爱吃|爱喝|爱|恨|想|要|会|能|可以|应该|需要|必须|打算|准备|计划|决定|觉得|认为|希望|害怕|担心|已经|一直|平时|最近|经常|偶尔|每天|每周|每月|每年|没有|不是|不|没|别|很|太|最|更|住|在|有|是|去|来|吃|喝|玩|看|听|说|讲|做|买|卖|用|养|工作|学习|睡|起|回|到)/u;

/** A weekday token is a date even when `memory-normalize` leaves it as written (bare 周三). */
const WEEKDAY_RE = /(?:周|星期|礼拜)[一二三四五六日天]/gu;
/** Digits (including an already-normalized absolute date) or a Chinese numeral run. */
const NUMBER_RE = /\d+|[零〇一二三四五六七八九十百千万亿两]+/gu;

/** Words that merely CONTAIN a negation glyph; they do not negate a sentence. */
const LEXICALIZED_RE = /(?:不错|不过|不但|不仅|不断|不管|不论|不少|不久|不停|不同|不幸|不利|差不多|不得不|非常|特别|区别|识别|性别|告别|个别|无论)/gu;
const NEGATION_RE = /[不没别无未非莫勿]/gu;

/** Number/date tokens of one body: a weekday token counts even when it is not a numeral run. */
function comparableNumberTokens(text) {
  const tokens = [...text.matchAll(NUMBER_RE)].map((match) => match[0]);
  tokens.push(...[...text.matchAll(WEEKDAY_RE)].map((match) => match[0]));
  return tokens.sort();
}

/** Negation glyphs outside lexicalized words, sorted so word order cannot fake a difference. */
function negationTokens(text) {
  const cleaned = text.replace(LEXICALIZED_RE, '');
  return [...cleaned.matchAll(NEGATION_RE)].map((match) => match[0]).sort();
}

function sameTokens(left, right) {
  if (left.length !== right.length) return false;
  return left.every((token, index) => token === right[index]);
}

/** The leading phrase before the sentence's predicate, or '' when there is none. */
function deriveSubject(text) {
  const match = PREDICATE_RE.exec(text);
  if (match === null) return '';
  const subject = text.slice(0, match.index).trim();
  if (subject.length === 0 || subject.length > 12) return '';
  return subject;
}

/**
 * Comparison projection of one memory body.
 *
 * @param {string} text the memory text as stored
 * @param {{now?: Date|number|string, timeZone?: string}} [options] `now` pins relative dates.
 * @returns {{text: string, key: string, subject: string, numbers: string[], negations: string[]}}
 *   `text` is the normalization result (dates absolute), `key` is the punctuation/space/filler
 *   free form used for equality and Jaccard, `subject` the derived subject.
 */
export function normalizeForDedup(text, { now = new Date(), timeZone = undefined } = {}) {
  const raw = typeof text === 'string' ? text : '';
  const normalized = normalizeForMemory(raw, { now, timeZone, expand: false, context: null }).text;
  const body = normalized.normalize('NFKC').toLowerCase();
  const segments = body
    .split(SEPARATOR_RE)
    .map((segment) => segment.replace(FILLER_EDGE_RE, ''))
    .filter((segment) => segment.length > 0);
  const key = segments.join('');
  return {
    text: normalized,
    key,
    subject: deriveSubject(key),
    numbers: comparableNumberTokens(body),
    negations: negationTokens(body),
  };
}

/** Character-bigram Jaccard over two comparison keys; short keys fall back to the whole key. */
export function dedupSimilarity(leftKey, rightKey) {
  const left = String(leftKey ?? '');
  const right = String(rightKey ?? '');
  if (left.length === 0 || right.length === 0) return 0;
  const grams = (value) => {
    if (value.length < 2) return new Set([value]);
    const set = new Set();
    for (let index = 0; index + 1 < value.length; index += 1) set.add(value.slice(index, index + 2));
    return set;
  };
  const a = grams(left);
  const b = grams(right);
  let shared = 0;
  for (const gram of a) if (b.has(gram)) shared += 1;
  const union = a.size + b.size - shared;
  return union === 0 ? 0 : shared / union;
}

function pairScore(left, right, threshold, subjectKindThreshold) {
  const a = left.dedup;
  const b = right.dedup;
  // Guards first: a number/date/negation difference is evidence of DIFFERENT facts, so the
  // pair is dropped entirely instead of being reported with a low score.
  if (!sameTokens(a.numbers, b.numbers)) return null;
  if (!sameTokens(a.negations, b.negations)) return null;
  if (a.subject.length > 0 && b.subject.length > 0 && a.subject !== b.subject) return null;

  if (a.key.length === 0 || b.key.length === 0) return null;
  if (a.key === b.key) return { score: 1, reasons: ['normalized-equal'] };

  const similarity = dedupSimilarity(a.key, b.key);
  const reasons = [];
  let candidate = false;
  if (similarity >= threshold) {
    candidate = true;
    reasons.push(`jaccard:${similarity.toFixed(2)}`);
  }
  const sameSubject = a.subject.length > 0 && a.subject === b.subject;
  const sameKind = left.kind === right.kind;
  if (sameSubject && sameKind && similarity >= subjectKindThreshold) {
    candidate = true;
    if (reasons.length === 0) reasons.push(`jaccard:${similarity.toFixed(2)}`);
    if (!reasons.includes('same-subject')) reasons.push('same-subject');
    if (!reasons.includes('same-kind')) reasons.push('same-kind');
  }
  return candidate ? { score: similarity, reasons } : null;
}

function clampLimit(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEDUP_DEFAULTS.limit;
  return Math.max(0, Math.min(100, Math.floor(parsed)));
}

function clampThreshold(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEDUP_DEFAULTS.threshold;
  return Math.max(0, Math.min(1, parsed));
}

/**
 * Report semantic duplicate candidates without touching storage.
 *
 * @param {Array<object>} list memories, each `{id, text, kind?, domain?, ts?, clarity?,
 *   recallCount?}`. Only `id`, `text` and `kind` are used; every other field is ignored, so a
 *   store row can be passed as-is.
 * @param {{limit?: number, threshold?: number, ftsQuery?: ((text: string) => object[]|
 *   {hits?: object[], rows?: object[]}) | null, subjectKindThreshold?: number,
 *   now?: Date|number|string, timeZone?: string}} [options]
 *   `limit` caps the reported pairs (default 20); `threshold` is the Jaccard cutoff (default
 *   0.75); `ftsQuery` MAY widen the pool with read-only FTS hits (called with each seed text).
 * @returns {Array<{a: {id: string, text: string}, b: {id: string, text: string},
 *   score: number, reasons: string[]}>} highest score first, deterministic id tie-break.
 *   A pair is reported at most once, and `a` always comes earlier in the merged pool.
 */
export function dedupCandidates(list, {
  limit = DEDUP_DEFAULTS.limit,
  threshold = DEDUP_DEFAULTS.threshold,
  ftsQuery = null,
  subjectKindThreshold = DEDUP_DEFAULTS.subjectKindThreshold,
  now = new Date(),
  timeZone = undefined,
} = {}) {
  const maxPairs = clampLimit(limit);
  const cutoff = clampThreshold(threshold);
  const kindCutoff = clampThreshold(subjectKindThreshold);
  if (maxPairs === 0) return [];

  const pool = [];
  const byId = new Map();
  const add = (entry, external) => {
    if (entry === null || typeof entry !== 'object') return;
    const id = typeof entry.id === 'string' ? entry.id : '';
    const text = typeof entry.text === 'string' ? entry.text : '';
    if (id.length === 0 || text.trim().length === 0) return;
    if (byId.has(id)) return;
    const record = {
      id,
      text,
      kind: typeof entry.kind === 'string' ? entry.kind : 'fact',
      external,
      dedup: normalizeForDedup(text, { now, timeZone }),
    };
    byId.set(id, record);
    pool.push(record);
  };

  for (const entry of Array.isArray(list) ? list : []) add(entry, false);

  // Optional widening: read-only probes over the seed rows. A throwing/async probe is ignored —
  // this module must never turn an FTS hiccup into a failure or a write.
  if (typeof ftsQuery === 'function') {
    for (const seed of [...pool]) {
      let result;
      try {
        result = ftsQuery(seed.text);
      } catch {
        continue;
      }
      const rows = Array.isArray(result) ? result : (result?.hits ?? result?.rows);
      if (!Array.isArray(rows)) continue;
      for (const row of rows.slice(0, FTS_ROWS_PER_PROBE)) add(row, true);
    }
  }

  const pairs = [];
  for (let left = 0; left < pool.length; left += 1) {
    for (let right = left + 1; right < pool.length; right += 1) {
      const a = pool[left];
      const b = pool[right];
      const scored = pairScore(a, b, cutoff, kindCutoff);
      if (scored === null) continue;
      const reasons = [...scored.reasons];
      if (a.external || b.external) reasons.push('fts-expanded');
      pairs.push({
        a: { id: a.id, text: a.text },
        b: { id: b.id, text: b.text },
        score: scored.score,
        reasons,
      });
    }
  }

  pairs.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    const byA = left.a.id.localeCompare(right.a.id);
    return byA !== 0 ? byA : left.b.id.localeCompare(right.b.id);
  });
  return pairs.slice(0, maxPairs);
}
