/**
 * Spoken-version de-duplication: drop whole repeated sentences from an ALREADY-REWRITTEN spoken
 * script. It never rewrites, merges, shortens or reorders a surviving sentence; the only change is
 * that some sentences disappear from the list.
 *
 * Two sentences count as the same layer of meaning when:
 *  1. their comparison keys are identical — lowercase, all whitespace / punctuation / symbols
 *     removed (`exact`); or
 *  2. the character-3-gram Jaccard similarity of those keys reaches the threshold — 0.90 for
 *     ADJACENT sentences, 0.85 for NON-adjacent ones (`similar`). Adjacent pairs are held to the
 *     stricter bar because a neighbouring restatement is often a legitimate continuation.
 *
 * Which one survives:
 *  - exact: the first occurrence (except the conclusion rule below);
 *  - similar: the one carrying more information, measured as the comparison key's character count
 *    (punctuation and whitespace do not count). Equal length keeps the EARLIER sentence.
 *
 * The conclusion (the LAST sentence) is protected from being removed: when it repeats an earlier,
 * non-adjacent sentence, the earlier copy is dropped instead. The one exception is a pure echo: if
 * the last sentence is exactly identical to the sentence right before it, it is the redundant copy
 * and is dropped.
 *
 * `dedupeSpokenUnits` is pure, never throws on odd input, and can be switched off (`enabled:false`),
 * in which case the input list is returned untouched.
 */

import { splitSemanticUnits } from './spokenPipeline.js';

/** Default threshold for non-adjacent pairs. */
export const DEFAULT_SIMILARITY_THRESHOLD = 0.85;
/** Adjacent pairs must reach at least this (always stricter than the non-adjacent threshold). */
export const DEFAULT_ADJACENT_THRESHOLD = 0.9;
/** Granularity of the similarity measure: character 3-grams. */
const NGRAM_SIZE = 3;

const codePoints = (value) => [...String(value ?? '')];

/** Comparison key: lowercase, without whitespace, punctuation or symbols. */
const normalizeKey = (value) => String(value ?? '').replace(/[\s\p{P}\p{S}]+/gu, '').toLowerCase();

/** Character 3-grams of a key; a key of at most 3 characters collapses to itself. */
function gramsOf(key) {
  const chars = codePoints(key);
  if (chars.length === 0) return new Set();
  if (chars.length <= NGRAM_SIZE) return new Set([chars.join('')]);
  const grams = new Set();
  for (let index = 0; index + NGRAM_SIZE <= chars.length; index += 1) {
    grams.add(chars.slice(index, index + NGRAM_SIZE).join(''));
  }
  return grams;
}

/**
 * 0..1 character-3-gram Jaccard similarity over the comparison keys (same measure as the spoken
 * de-duplicator). Exported so callers and tests can reason about the threshold without duplicating
 * the normalization rules.
 */
export function spokenSimilarity(left, right) {
  const a = gramsOf(normalizeKey(left));
  const b = gramsOf(normalizeKey(right));
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const gram of a) if (b.has(gram)) shared += 1;
  return shared / (a.size + b.size - shared);
}

function clampThreshold(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_SIMILARITY_THRESHOLD;
  return Math.max(0, Math.min(1, parsed));
}

/**
 * Remove whole repeated sentences from a spoken script, preserving everything else verbatim.
 *
 * @param {string[]|string} units spoken sentences, or one text split on sentence boundaries.
 * @param {{enabled?: boolean, exactOnly?: boolean, similarityThreshold?: number}} [options]
 *   `enabled:false` returns the input untouched; `exactOnly:true` disables the similarity rule;
 *   `similarityThreshold` replaces the non-adjacent 0.85 floor (adjacent stays `max(0.9, value)`).
 * @returns {{units: string[], removed: Array<{text: string, reason: 'exact'|'similar',
 *   keptWith: number}>}} `keptWith` is the index, in the RETURNED `units`, of the surviving
 *   sentence that says the same thing.
 */
export function dedupeSpokenUnits(units, {
  enabled = true, exactOnly = false, similarityThreshold = DEFAULT_SIMILARITY_THRESHOLD,
} = {}) {
  const list = Array.isArray(units)
    ? units
    : splitSemanticUnits(String(units ?? ''), { clauseSplit: false });
  if (!enabled || list.length < 2) return { units: list, removed: [] };

  const base = clampThreshold(similarityThreshold);
  const adjacent = Math.max(DEFAULT_ADJACENT_THRESHOLD, base);
  const total = list.length;
  const last = total - 1;
  const keys = list.map(normalizeKey);
  const grams = keys.map(gramsOf);
  const weights = keys.map((key) => codePoints(key).length);
  const alive = new Array(total).fill(true);
  const droppedBy = new Map();
  const reasons = new Map();

  const drop = (index, keeper, reason) => {
    alive[index] = false;
    droppedBy.set(index, keeper);
    reasons.set(index, reason);
  };

  const verdictOf = (i, j) => {
    if (keys[i].length === 0 || keys[j].length === 0) return '';
    if (keys[i] === keys[j]) return 'exact';
    if (exactOnly) return '';
    const a = grams[i];
    const b = grams[j];
    let shared = 0;
    for (const gram of a) if (b.has(gram)) shared += 1;
    const score = shared / (a.size + b.size - shared);
    return score >= (j === i + 1 ? adjacent : base) ? 'similar' : '';
  };

  // A last sentence identical to the one before it is a pure echo, never a conclusion.
  if (keys[last].length > 0 && keys[last] === keys[last - 1]) drop(last, last - 1, 'exact');

  for (let i = 0; i < total; i += 1) {
    if (!alive[i]) continue;
    for (let j = i + 1; j < total; j += 1) {
      if (!alive[j]) continue;
      const reason = verdictOf(i, j);
      if (reason === '') continue;
      if (j === last) {
        // The conclusion survives; the earlier restatement is what gets dropped.
        drop(i, j, reason);
        break;
      }
      if (weights[i] < weights[j]) {
        drop(i, j, reason);
        break;
      }
      drop(j, i, reason);
    }
  }

  const resultIndices = [];
  for (let i = 0; i < total; i += 1) if (alive[i]) resultIndices.push(i);
  const positionOf = new Map(resultIndices.map((index, position) => [index, position]));
  const removed = [];
  for (let i = 0; i < total; i += 1) {
    if (alive[i]) continue;
    // A keeper may itself have been superseded later; follow the chain to the final survivor.
    let keeper = droppedBy.get(i);
    while (!alive[keeper] && droppedBy.has(keeper)) keeper = droppedBy.get(keeper);
    removed.push({ text: list[i], reason: reasons.get(i), keptWith: positionOf.get(keeper) });
  }
  return { units: list.filter((_, index) => alive[index]), removed };
}
