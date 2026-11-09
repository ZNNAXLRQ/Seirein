/**
 * Speaker template — pure decision / vector math for building a base voiceprint.
 *
 * This module answers exactly one question: "do the candidates the caller has already selected
 * agree closely enough to become one speaker template, and if so, what vector represents them?"
 * It is deliberately not a store and not an identity decision:
 *   - it never reads or writes the speaker library (or any file), never sets `self`, never calls
 *     a model, uses the network, or assigns a speakerId;
 *   - it never decides that a candidate belongs to a person. It only accepts or refuses the set
 *     and returns a template vector plus the evidence behind it;
 *   - `buildSpeakerTemplate()` is a pure function of its arguments: the input candidates and
 *     their embeddings are never mutated, and the returned vector is a fresh Float32Array.
 *
 * Input shape (the caller's selected candidates):
 *   {id, embedding: Float32Array|number[], durationMs, quality, createdAt?}
 *
 * Validation:
 *   - `candidates` must be a non-empty array; each candidate must be an object with a unique,
 *     non-empty trimmed `id`;
 *   - `embedding` must be a non-empty Float32Array or plain number[] whose members are finite,
 *     whose float32 conversion stays finite, and whose L2 norm is non-zero;
 *   - every candidate must have the same embedding dimension;
 *   - `durationMs` is rounded and must be inside [800, 15000] ms, the same window the candidate
 *     cache uses. Duration is also the weight in the average;
 *   - `quality`, `createdAt` and any extra fields are carried by the caller and ignored here.
 *
 * Consistency and generation:
 *   - every pair is scored with cosine similarity; the default floor is 0.72 (`options.threshold`
 *     overrides it; a non-finite value falls back to 0.72 and a finite one is clamped to [-1, 1]);
 *   - one pair below the floor refuses the set with `{ok:false, reason:'inconsistent',
 *     minPairCosine, outlierIds}` and no vector. `outlierIds` is a diagnostic, not a verdict: it
 *     first names the candidates whose single removal would make the remaining set consistent
 *     (useful when one bad sample spoils a group); when no single removal fixes the set, it falls
 *     back to the union of the endpoints of every failing pair. Removing candidates and retrying
 *     is the caller's decision, never this module's;
 *   - a consistent set produces a duration-weighted average of the raw embeddings, L2-normalized
 *     into a unit vector. Longer utterances therefore influence the template more;
 *   - fewer than two candidates is allowed and marked `confidence:'low-sample'`; the caller
 *     decides whether to use it. With one candidate there is no pair, so `minPairCosine` is 1
 *     (the vacuous minimum) and the vector is the normalized candidate itself.
 *
 * `mergeTemplate(existing, incoming, weight)` is the controlled-strengthening/versioning helper.
 * It accepts a template (`{vector}`), a candidate (`{embedding}`) or a raw vector on either side,
 * normalizes both directions, and blends them as `(1 - weight) * existing + weight * incoming`
 * before normalizing again. `weight` is the incoming share in [0, 1] and defaults to 0.5. The
 * result carries summed `sampleCount`/`totalDurationMs` metadata when the inputs expose it. It
 * never mutates either input. Refusals are `{ok:false, reason}` objects; this module does not
 * throw for caller data.
 *
 * What is intentionally NOT here (host follow-up): user confirmation of the resulting template,
 * writing it into the speaker library, setting `self`, bumping/reverting a template version, and
 * any UI. Those remain explicit host actions.
 */

/** Cosine floor for a consistent candidate set. Matches the candidate cache's grouping floor. */
export const DEFAULT_SPEAKER_TEMPLATE_THRESHOLD = 0.72;

/** Inclusive duration window for one candidate, in milliseconds. */
export const SPEAKER_TEMPLATE_MIN_DURATION_MS = 800;
export const SPEAKER_TEMPLATE_MAX_DURATION_MS = 15000;

/** Fewer samples than this yields `confidence:'low-sample'`; it is not an error. */
export const SPEAKER_TEMPLATE_MIN_SAMPLES = 2;

/** The only two confidence values a successful build can return. */
export const SPEAKER_TEMPLATE_CONFIDENCE = Object.freeze({
  OK: 'ok',
  LOW_SAMPLE: 'low-sample',
});

/** The default incoming share for `mergeTemplate()`. */
export const DEFAULT_SPEAKER_TEMPLATE_MERGE_WEIGHT = 0.5;

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && !ArrayBuffer.isView(value);
}

/**
 * Copy one embedding to a fresh Float32Array after validating it.
 *
 * Rejects non-arrays, an empty vector, non-number/non-finite members, members that overflow
 * float32, and zero vectors. A caller's Float32Array is copied, never aliased or modified.
 *
 * @param {Float32Array|number[]} value
 * @returns {Float32Array|null}
 */
function copyValidVector(value) {
  if (!(value instanceof Float32Array) && !Array.isArray(value)) return null;
  if (value.length === 0) return null;
  const vector = new Float32Array(value.length);
  let sum = 0;
  for (let index = 0; index < value.length; index += 1) {
    const number = value[index];
    if (typeof number !== 'number' || !Number.isFinite(number)) return null;
    const float = Math.fround(number);
    if (!Number.isFinite(float)) return null;
    vector[index] = float;
    sum += float * float;
  }
  if (!Number.isFinite(sum) || !(sum > 0)) return null;
  return vector;
}

/**
 * L2-normalized copy of any finite, non-zero numeric vector, or null.
 *
 * Accumulation happens in doubles and only the final components are stored as float32, so the
 * returned unit vector is not degraded by accumulating rounded intermediate values.
 *
 * @param {Float32Array|Float64Array|number[]} value
 * @returns {Float32Array|null}
 */
function normalizedCopy(value) {
  let sum = 0;
  for (let index = 0; index < value.length; index += 1) {
    const number = value[index];
    if (!Number.isFinite(number)) return null;
    sum += number * number;
  }
  if (!Number.isFinite(sum) || !(sum > 0)) return null;
  const scale = 1 / Math.sqrt(sum);
  const vector = new Float32Array(value.length);
  for (let index = 0; index < value.length; index += 1) {
    const component = value[index] * scale;
    if (!Number.isFinite(component)) return null;
    vector[index] = component;
  }
  return vector;
}

/**
 * Cosine similarity in [-1, 1]. An unusable pair (non-array, empty, dimension mismatch,
 * non-finite member, zero vector) scores 0, the neutral value, so a broken embedding can never
 * look like a match.
 *
 * @param {Float32Array|number[]} left
 * @param {Float32Array|number[]} right
 * @returns {number}
 */
export function cosineSimilarity(left, right) {
  if (!(left instanceof Float32Array) && !Array.isArray(left)) return 0;
  if (!(right instanceof Float32Array) && !Array.isArray(right)) return 0;
  if (left.length === 0 || left.length !== right.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (typeof a !== 'number' || typeof b !== 'number') return 0;
    if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (!(leftNorm > 0) || !(rightNorm > 0)) return 0;
  const score = dot / Math.sqrt(leftNorm * rightNorm);
  return Number.isFinite(score) ? Math.max(-1, Math.min(1, score)) : 0;
}

/** Resolve the cosine floor; a bad value falls back to the default and a valid one is clamped. */
function resolveThreshold(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_SPEAKER_TEMPLATE_THRESHOLD;
  return Math.max(-1, Math.min(1, number));
}

/**
 * Round and range-check one candidate duration. Returns the rounded milliseconds or a reason.
 *
 * @param {unknown} value
 * @returns {{ok: true, durationMs: number}|{ok: false, reason: 'invalid-duration'}}
 */
function prepareDuration(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') {
    return { ok: false, reason: 'invalid-duration' };
  }
  const number = Number(value);
  if (!Number.isFinite(number)) return { ok: false, reason: 'invalid-duration' };
  const durationMs = Math.round(number);
  if (durationMs < SPEAKER_TEMPLATE_MIN_DURATION_MS
    || durationMs > SPEAKER_TEMPLATE_MAX_DURATION_MS) {
    return { ok: false, reason: 'invalid-duration' };
  }
  return { ok: true, durationMs };
}

/** One merge input as a fresh normalized vector; templates, candidates and raw vectors work. */
function mergeVector(value) {
  if (value instanceof Float32Array || Array.isArray(value)) {
    const copied = copyValidVector(value);
    return copied === null ? null : normalizedCopy(copied);
  }
  if (plainObject(value)) {
    const source = value.vector !== undefined ? value.vector : value.embedding;
    const copied = copyValidVector(source);
    return copied === null ? null : normalizedCopy(copied);
  }
  return null;
}

/** Evidence metadata attached to one merge input; a raw vector counts as one sample. */
function evidenceOf(value) {
  if (!plainObject(value)) return { sampleCount: 1, totalDurationMs: 0 };
  const count = Number(value.sampleCount);
  const duration = Number(value.totalDurationMs ?? value.durationMs);
  return {
    sampleCount: Number.isFinite(count) && count >= 0 ? Math.floor(count) : 1,
    totalDurationMs: Number.isFinite(duration) && duration >= 0 ? duration : 0,
  };
}

/** True when every pair in the given entries is at or above the cosine floor. */
function isPairwiseConsistent(entries, threshold) {
  for (let leftIndex = 0; leftIndex < entries.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < entries.length; rightIndex += 1) {
      if (cosineSimilarity(entries[leftIndex].vector, entries[rightIndex].vector) < threshold) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Build one base template from a caller-selected candidate set.
 *
 * @param {{id: string, embedding: Float32Array|number[], durationMs: number}[]} candidates
 * @param {{threshold?: number}} [options]
 * @returns {{ok: true, vector: Float32Array, sampleCount: number, totalDurationMs: number,
 *   minPairCosine: number, confidence: 'ok'|'low-sample'}
 *   |{ok: false, reason: string}}
 */
export function buildSpeakerTemplate(candidates, options = {}) {
  if (!Array.isArray(candidates)) return { ok: false, reason: 'invalid-candidates' };
  if (candidates.length === 0) return { ok: false, reason: 'no-candidates' };
  const threshold = resolveThreshold(
    options !== null && typeof options === 'object' ? options.threshold : undefined,
  );

  const entries = [];
  const seenIds = new Set();
  let dimension = 0;
  for (const candidate of candidates) {
    if (!plainObject(candidate)) return { ok: false, reason: 'invalid-candidate' };
    const id = typeof candidate.id === 'string' ? candidate.id.trim() : '';
    if (id.length === 0) return { ok: false, reason: 'invalid-id' };
    if (seenIds.has(id)) return { ok: false, reason: 'duplicate-id' };
    seenIds.add(id);

    const vector = copyValidVector(candidate.embedding);
    if (vector === null) return { ok: false, reason: 'invalid-embedding' };
    if (dimension === 0) dimension = vector.length;
    else if (vector.length !== dimension) return { ok: false, reason: 'dim-mismatch' };

    const duration = prepareDuration(candidate.durationMs);
    if (!duration.ok) return duration;
    entries.push({ id, vector, durationMs: duration.durationMs });
  }

  // Pairwise consistency first: a bad set must never produce a template.
  let minPairCosine = 1;
  const disagreeingIds = new Set();
  for (let leftIndex = 0; leftIndex < entries.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < entries.length; rightIndex += 1) {
      const score = cosineSimilarity(entries[leftIndex].vector, entries[rightIndex].vector);
      if (score < minPairCosine) minPairCosine = score;
      if (score < threshold) {
        disagreeingIds.add(entries[leftIndex].id);
        disagreeingIds.add(entries[rightIndex].id);
      }
    }
  }
  if (disagreeingIds.size > 0) {
    // Prefer the narrow explanation: one candidate whose removal makes the rest consistent.
    // With only two candidates there is no "rest", so both endpoints remain suspects.
    let outlierIds = entries
      .filter((entry) => disagreeingIds.has(entry.id))
      .map((entry) => entry.id);
    if (entries.length > 2) {
      const removable = entries.filter((_, removedIndex) => {
        const remaining = entries.filter((__, index) => index !== removedIndex);
        return isPairwiseConsistent(remaining, threshold);
      }).map((entry) => entry.id);
      if (removable.length > 0) outlierIds = removable;
    }
    return { ok: false, reason: 'inconsistent', minPairCosine, outlierIds };
  }

  // Duration-weighted average of the raw vectors, then one L2 normalization.
  const totalDurationMs = entries.reduce((sum, entry) => sum + entry.durationMs, 0);
  const accumulator = new Float64Array(dimension);
  for (const entry of entries) {
    for (let index = 0; index < dimension; index += 1) {
      accumulator[index] += entry.vector[index] * entry.durationMs;
    }
  }
  const vector = normalizedCopy(accumulator);
  if (vector === null) return { ok: false, reason: 'zero-vector' };

  return {
    ok: true,
    vector,
    sampleCount: entries.length,
    totalDurationMs,
    minPairCosine,
    confidence: entries.length < SPEAKER_TEMPLATE_MIN_SAMPLES
      ? SPEAKER_TEMPLATE_CONFIDENCE.LOW_SAMPLE
      : SPEAKER_TEMPLATE_CONFIDENCE.OK,
  };
}

/**
 * Blend a stored/base template with new evidence, without touching either input.
 *
 * Both sides are normalized before blending, so `weight` is a share of direction, not of vector
 * magnitude: 0 keeps the existing direction, 1 takes the incoming direction, 0.5 bisects them.
 * This is intended for controlled strengthening or versioning; persisting the result and deciding
 * whether the new version is accepted are host actions outside this module.
 *
 * @param {{vector?: Float32Array|number[], embedding?: Float32Array|number[],
 *   sampleCount?: number, totalDurationMs?: number, durationMs?: number}
 *   |Float32Array|number[]} existing
 * @param {{vector?: Float32Array|number[], embedding?: Float32Array|number[],
 *   sampleCount?: number, totalDurationMs?: number, durationMs?: number}
 *   |Float32Array|number[]} incoming
 * @param {number} [weight=0.5] incoming share in [0, 1]
 * @returns {{ok: true, vector: Float32Array, sampleCount: number, totalDurationMs: number}
 *   |{ok: false, reason: string}}
 */
export function mergeTemplate(existing, incoming, weight = DEFAULT_SPEAKER_TEMPLATE_MERGE_WEIGHT) {
  if (typeof weight !== 'number') return { ok: false, reason: 'invalid-weight' };
  const incomingShare = weight;
  if (!Number.isFinite(incomingShare) || incomingShare < 0 || incomingShare > 1) {
    return { ok: false, reason: 'invalid-weight' };
  }
  const base = mergeVector(existing);
  if (base === null) return { ok: false, reason: 'invalid-existing' };
  const addition = mergeVector(incoming);
  if (addition === null) return { ok: false, reason: 'invalid-incoming' };
  if (base.length !== addition.length) return { ok: false, reason: 'dim-mismatch' };

  const blended = new Float64Array(base.length);
  for (let index = 0; index < base.length; index += 1) {
    blended[index] = base[index] * (1 - incomingShare) + addition[index] * incomingShare;
  }
  const vector = normalizedCopy(blended);
  if (vector === null) return { ok: false, reason: 'zero-vector' };

  const baseEvidence = evidenceOf(existing);
  const incomingEvidence = evidenceOf(incoming);
  return {
    ok: true,
    vector,
    sampleCount: baseEvidence.sampleCount + incomingEvidence.sampleCount,
    totalDurationMs: baseEvidence.totalDurationMs + incomingEvidence.totalDurationMs,
  };
}
