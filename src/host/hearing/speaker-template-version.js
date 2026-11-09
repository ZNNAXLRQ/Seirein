/**
 * Speaker template versioning — pure, append-only version chain for a voiceprint template.
 *
 * This module is the controlled-strengthening layer above `speaker-template.js`. It answers:
 * "may these new samples become the next template version, and what does that version look like?"
 * It is deliberately not a store and not an identity decision:
 *   - it never reads or writes a file, database or the speaker library; it sets no globals, uses
 *     no network/model, starts no timer and calls no clock. `createdAt` is always supplied by the
 *     caller, so every function is deterministic and testable;
 *   - it never accepts a candidate on its own. A new version only exists after the caller invokes
 *     `nextVersion()` with an explicitly selected sample batch, and `selectVersion()`/`rollback()`
 *     only point `currentVersion` at a version the caller named;
 *   - every function is pure with respect to its arguments: state, version records and sample
 *     embeddings are copied, never mutated. Returned states own fresh vectors, so mutating a
 *     result cannot corrupt an input.
 *
 * State shape (the caller persists it; this module only builds it):
 *   {
 *     versions: VersionRecord[],       // sorted by ascending version, bounded by maxVersions
 *     currentVersion: number | null,   // null only for the empty state
 *     lastVersion: number,             // highest version number ever issued (0 for empty state)
 *   }
 *
 * Version record shape (exactly the contract fields):
 *   {version, vector, sampleCount, totalDurationMs, createdAt, reason, parentVersion}
 *   - `vector` is a fresh L2 unit Float32Array;
 *   - `sampleCount`/`totalDurationMs` are the accumulated evidence behind this version;
 *   - `createdAt` is the caller's timestamp (finite number or non-empty string) or null;
 *   - `reason` is the caller-visible origin (`initial`, `strengthen`, `manual`, ...);
 *   - `parentVersion` is the version this one was derived from (null for a root). It may point at
 *     a version that has since been evicted from the bounded chain.
 *
 * Controlled strengthening (`nextVersion`):
 *   1. the new batch must be an array and must pass `buildSpeakerTemplate()` (pairwise cosine
 *      consistency, valid embeddings/durations/dimension) before anything is merged;
 *   2. the batch size is capped (`maxSamples`, default 8) and its total duration is capped
 *      (`maxDurationMs`, default 60000, measured over the new samples only); a batch below
 *      `minSamples` (default 1) is refused as well;
 *   3. the batch-built vector must have the current template's dimension and a cosine similarity
 *      of at least `minSimilarity` (default 0.72) to the current template;
 *   4. the current and incoming directions are blended by `mergeTemplate()` with `incomingWeight`
 *      (default 0.5, the incoming share), then normalized again;
 *   5. a new record is appended with reason `strengthen` (or a caller-supplied reason) and
 *      parentVersion = the current version. Refusals return `{ok:false, reason, ...}` and produce
 *      no record/state change at all;
 *   6. the chain is bounded by `maxVersions` (default 20). Appending past the bound evicts the
 *      oldest record that is not the new current, so the current version and at least one
 *      rollback target survive. Version numbers are never reused: `lastVersion` keeps counting
 *      even after records are evicted.
 *
 * Rollback and selection:
 *   - `selectVersion(state, n)` points `currentVersion` at an existing record without changing,
 *     rewriting or appending to history. The result is a fresh state;
 *   - `rollback(state, n)` is the same operation with rollback naming and `restoredFrom`; it
 *     refuses a missing version (`version-not-found`), an invalid version number
 *     (`invalid-version`) and a record whose vector is broken (`bad-version-vector`);
 *   - after either call the old current version remains in history, so the caller can select it
 *     again. Nothing is undone or deleted, except by the bounded-chain eviction above.
 *
 * Refusal reasons (all refusals are plain `{ok:false, reason}` objects; caller data never throws):
 *   invalid-state, invalid-version, version-not-found, bad-version-vector,
 *   invalid-samples, insufficient-samples, too-many-samples, duration-cap-exceeded,
 *   invalid-max-samples, invalid-max-duration, invalid-max-versions, invalid-min-samples,
 *   invalid-weight, invalid-min-similarity, invalid-reason, invalid-created-at,
 *   inconsistent, dim-mismatch, low-similarity, version-exhausted,
 *   and whatever `buildSpeakerTemplate()`/`mergeTemplate()` refuse (invalid-embedding,
 *   invalid-duration, zero-vector, ...).
 *
 * What is intentionally NOT here (host follow-up): persisting the state, showing versions in UI,
 * speaker-library migration, automatic candidate acceptance, and any background strengthening.
 * Those are explicit host actions; this module only computes the next pure state.
 */

import {
  buildSpeakerTemplate,
  cosineSimilarity,
  mergeTemplate,
} from './speaker-template.js';

/** Maximum number of version records kept in one chain. */
export const DEFAULT_MAX_VERSIONS = 20;

/** Maximum number of new samples merged by one strengthening call. */
export const DEFAULT_MAX_SAMPLES_PER_STRENGTHEN = 8;

/** Maximum total duration (ms) of the new samples merged by one strengthening call. */
export const DEFAULT_MAX_DURATION_MS_PER_STRENGTHEN = 60000;

/** Default incoming (new-sample) share for a strengthening blend. */
export const DEFAULT_INCOMING_WEIGHT = 0.5;

/** Minimum cosine similarity between the current template and the new batch. */
export const DEFAULT_MIN_SIMILARITY = 0.72;

/** Minimum number of new samples per strengthening call (empty batches are always refused). */
export const DEFAULT_MIN_SAMPLES_PER_STRENGTHEN = 1;

/** Pairwise consistency floor forwarded to `buildSpeakerTemplate()`. */
export const DEFAULT_CONSISTENCY_THRESHOLD = 0.72;

/** Version numbers are always positive safe integers. */
const MAX_SAFE_VERSION = Number.MAX_SAFE_INTEGER;

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && !ArrayBuffer.isView(value);
}

function failure(reason, extra = {}) {
  return { ok: false, reason, ...extra };
}

/**
 * Copy and validate one vector. Rejects empty, non-finite, float32-overflowing and zero vectors.
 * The returned Float32Array is always a fresh copy.
 *
 * @param {Float32Array|number[]} value
 * @returns {Float32Array|null}
 */
function copyVector(value) {
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
 * L2-normalize any usable vector into a fresh Float32Array, or return null.
 * Accumulation is done in doubles; only final components are stored as float32.
 *
 * @param {Float32Array|number[]} value
 * @returns {Float32Array|null}
 */
function normalizedVector(value) {
  const copied = copyVector(value);
  if (copied === null) return null;
  let sum = 0;
  for (let index = 0; index < copied.length; index += 1) {
    sum += copied[index] * copied[index];
  }
  if (!Number.isFinite(sum) || !(sum > 0)) return null;
  const scale = 1 / Math.sqrt(sum);
  const vector = new Float32Array(copied.length);
  for (let index = 0; index < copied.length; index += 1) {
    const component = copied[index] * scale;
    if (!Number.isFinite(component)) return null;
    vector[index] = component;
  }
  return vector;
}

/**
 * Normalize a caller timestamp: absent/null becomes null, a finite number or non-empty string is
 * carried as-is. The module never calls the clock.
 *
 * @param {unknown} value
 * @returns {{ok: true, value: number|string|null}|{ok: false}}
 */
function normalizeCreatedAt(value) {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value === 'number' && Number.isFinite(value)) return { ok: true, value };
  if (typeof value === 'string' && value.trim().length > 0) return { ok: true, value };
  return { ok: false };
}

/**
 * Validate one version record and return a fresh copy.
 *
 * Metadata defaults are only for the standalone `createVersion()`/`createVersionState()` entry
 * points; records carried by a state are expected to be complete but defaults are still applied
 * leniently so an older serialized shape does not explode.
 *
 * @param {unknown} record
 * @param {{normalize?: boolean, defaultVersion?: number, defaultReason?: string}} [options]
 * @returns {{ok: true, record: object}|{ok: false, reason: string, version: number|null}}
 */
function normalizeVersionRecord(record, options = {}) {
  if (!plainObject(record)) return { ok: false, reason: 'invalid-record', version: null };
  const rawVersion = record.version;
  const version = rawVersion === undefined ? (options.defaultVersion ?? 1) : rawVersion;
  if (!Number.isSafeInteger(version) || version < 1) {
    return { ok: false, reason: 'invalid-version', version: null };
  }

  const vector = options.normalize === true
    ? normalizedVector(record.vector)
    : copyVector(record.vector);
  if (vector === null) return { ok: false, reason: 'invalid-vector', version };

  const sampleCount = record.sampleCount === undefined ? 0 : record.sampleCount;
  if (!Number.isSafeInteger(sampleCount) || sampleCount < 0) {
    return { ok: false, reason: 'invalid-sample-count', version };
  }

  const totalDurationMs = record.totalDurationMs === undefined ? 0 : record.totalDurationMs;
  if (typeof totalDurationMs !== 'number' || !Number.isFinite(totalDurationMs)
    || totalDurationMs < 0) {
    return { ok: false, reason: 'invalid-total-duration', version };
  }

  const reason = record.reason === undefined
    ? (options.defaultReason ?? 'manual')
    : record.reason;
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    return { ok: false, reason: 'invalid-reason', version };
  }

  const parentVersion = record.parentVersion === undefined ? null : record.parentVersion;
  if (parentVersion !== null
    && (!Number.isSafeInteger(parentVersion) || parentVersion < 1)) {
    return { ok: false, reason: 'invalid-parent-version', version };
  }

  const createdAt = normalizeCreatedAt(record.createdAt);
  if (!createdAt.ok) return { ok: false, reason: 'invalid-created-at', version };

  return {
    ok: true,
    record: {
      version,
      vector,
      sampleCount,
      totalDurationMs,
      createdAt: createdAt.value,
      reason,
      parentVersion,
    },
  };
}

/**
 * Validate a whole state and return a fresh copy (records and vectors copied).
 *
 * Structural problems fail as `invalid-state`; the `kind` and offending `version` are included so
 * callers (notably rollback) can explain which record was broken.
 *
 * @param {unknown} state
 * @returns {{ok: true, state: object}|{ok: false, reason: 'invalid-state', kind: string,
 *   version: number|null}}
 */
function normalizeState(state) {
  if (state === undefined || state === null) {
    return { ok: true, state: { versions: [], currentVersion: null, lastVersion: 0 } };
  }
  if (!plainObject(state)) {
    return { ok: false, reason: 'invalid-state', kind: 'not-an-object', version: null };
  }
  if (!Array.isArray(state.versions)) {
    return { ok: false, reason: 'invalid-state', kind: 'versions', version: null };
  }

  const records = [];
  const seen = new Set();
  for (const raw of state.versions) {
    const normalized = normalizeVersionRecord(raw);
    if (!normalized.ok) {
      return {
        ok: false,
        reason: 'invalid-state',
        kind: normalized.reason,
        version: normalized.version,
      };
    }
    if (seen.has(normalized.record.version)) {
      return {
        ok: false,
        reason: 'invalid-state',
        kind: 'duplicate-version',
        version: normalized.record.version,
      };
    }
    seen.add(normalized.record.version);
    records.push(normalized.record);
  }
  records.sort((left, right) => left.version - right.version);

  const currentVersion = state.currentVersion === undefined ? null : state.currentVersion;
  if (records.length === 0) {
    if (currentVersion !== null) {
      return {
        ok: false, reason: 'invalid-state', kind: 'current-without-versions', version: null,
      };
    }
    const lastVersion = state.lastVersion === undefined ? 0 : state.lastVersion;
    if (!Number.isSafeInteger(lastVersion) || lastVersion < 0) {
      return { ok: false, reason: 'invalid-state', kind: 'last-version', version: null };
    }
    return {
      ok: true,
      state: { versions: [], currentVersion: null, lastVersion },
    };
  }

  if (currentVersion === null || !seen.has(currentVersion)) {
    return {
      ok: false, reason: 'invalid-state', kind: 'current-missing', version: null,
    };
  }
  const highestVersion = records[records.length - 1].version;
  const lastVersion = state.lastVersion === undefined ? highestVersion : state.lastVersion;
  if (!Number.isSafeInteger(lastVersion) || lastVersion < highestVersion) {
    return { ok: false, reason: 'invalid-state', kind: 'last-version', version: null };
  }
  return {
    ok: true,
    state: { versions: records, currentVersion, lastVersion },
  };
}

/** Find a record in an already-normalized state. */
function recordOf(state, version) {
  return state.versions.find((record) => record.version === version) ?? null;
}

/** Validate a version-number argument. */
function validVersionNumber(value) {
  return Number.isSafeInteger(value) && value >= 1;
}

/** Read a positive safe integer option; null means "invalid". */
function positiveIntegerOption(value, fallback, minimum) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) return null;
  return value;
}

/**
 * Resolve and validate `nextVersion()` options. Invalid configuration is refused rather than
 * silently defaulted, so a caller cannot believe it set a cap that was actually ignored.
 *
 * @param {unknown} options
 * @returns {{ok: true, config: object}|{ok: false, reason: string}}
 */
function resolveOptions(options) {
  const source = plainObject(options) ? options : {};

  const incomingWeight = source.incomingWeight === undefined
    ? DEFAULT_INCOMING_WEIGHT
    : source.incomingWeight;
  if (typeof incomingWeight !== 'number' || !Number.isFinite(incomingWeight)
    || incomingWeight < 0 || incomingWeight > 1) {
    return failure('invalid-weight');
  }

  const maxSamples = positiveIntegerOption(
    source.maxSamples,
    DEFAULT_MAX_SAMPLES_PER_STRENGTHEN,
    1,
  );
  if (maxSamples === null) return failure('invalid-max-samples');

  const maxDurationMs = source.maxDurationMs === undefined
    ? DEFAULT_MAX_DURATION_MS_PER_STRENGTHEN
    : source.maxDurationMs;
  if (typeof maxDurationMs !== 'number' || !Number.isFinite(maxDurationMs)
    || maxDurationMs <= 0) {
    return failure('invalid-max-duration');
  }

  const maxVersions = positiveIntegerOption(source.maxVersions, DEFAULT_MAX_VERSIONS, 2);
  if (maxVersions === null) return failure('invalid-max-versions');

  const minSamples = positiveIntegerOption(
    source.minSamples,
    DEFAULT_MIN_SAMPLES_PER_STRENGTHEN,
    1,
  );
  if (minSamples === null || minSamples > maxSamples) return failure('invalid-min-samples');

  let minSimilarity = DEFAULT_MIN_SIMILARITY;
  if (source.minSimilarity !== undefined) {
    if (typeof source.minSimilarity !== 'number'
      || !Number.isFinite(source.minSimilarity)) {
      return failure('invalid-min-similarity');
    }
    minSimilarity = Math.max(-1, Math.min(1, source.minSimilarity));
  }

  let reason = 'strengthen';
  if (source.reason !== undefined) {
    if (typeof source.reason !== 'string' || source.reason.trim().length === 0) {
      return failure('invalid-reason');
    }
    reason = source.reason;
  }

  let createdAt = null;
  if (source.createdAt !== undefined) {
    const normalized = normalizeCreatedAt(source.createdAt);
    if (!normalized.ok) return failure('invalid-created-at');
    createdAt = normalized.value;
  }

  return {
    ok: true,
    config: {
      incomingWeight,
      maxSamples,
      maxDurationMs,
      maxVersions,
      minSamples,
      minSimilarity,
      consistencyThreshold: source.threshold !== undefined
        ? source.threshold
        : DEFAULT_CONSISTENCY_THRESHOLD,
      reason,
      createdAt,
    },
  };
}

/**
 * Append one record, then evict the oldest non-current records until the chain fits.
 * The new record is always current, so in practice this drops the oldest version overall; the
 * explicit non-current rule also keeps this safe if the helper is reused after a rollback.
 *
 * @param {object} baseState normalized state
 * @param {object} record fresh record to append
 * @param {number} maxVersions
 * @returns {{ok: true, state: object, version: number}}
 */
function commitVersion(baseState, record, maxVersions) {
  const versions = [...baseState.versions, record];
  versions.sort((left, right) => left.version - right.version);
  while (versions.length > maxVersions) {
    const evictIndex = versions.findIndex((entry) => entry.version !== record.version);
    if (evictIndex === -1) break;
    versions.splice(evictIndex, 1);
  }
  return {
    ok: true,
    state: {
      versions,
      currentVersion: record.version,
      lastVersion: record.version,
    },
    version: record.version,
  };
}

/**
 * Create an empty version state. Passing null/undefined as the state to `nextVersion()` has the
 * same meaning; this helper exists so a host can persist an explicit empty value.
 *
 * @returns {{versions: [], currentVersion: null, lastVersion: 0}}
 */
export function createEmptyVersionState() {
  return { versions: [], currentVersion: null, lastVersion: 0 };
}

/**
 * Create one validated, normalized version record without adding it to any chain.
 *
 * This is for a caller that already has a template vector (for example the speaker library's
 * existing base template) and wants a record to seed a state with `createVersionState()`.
 * Calling it does not accept anything: only the caller can pass the record into a state.
 *
 * @param {{version?: number, vector: Float32Array|number[], sampleCount?: number,
 *   totalDurationMs?: number, createdAt?: number|string|null, reason?: string,
 *   parentVersion?: number|null}} input
 * @returns {{ok: true, record: object}|{ok: false, reason: string}}
 */
export function createVersion(input) {
  const normalized = normalizeVersionRecord(input, {
    normalize: true,
    defaultVersion: 1,
    defaultReason: 'manual',
  });
  if (!normalized.ok) return failure(normalized.reason);
  return { ok: true, record: normalized.record };
}

/**
 * Seed a version state from one record (typically from `createVersion()`).
 *
 * @param {object} record
 * @returns {{ok: true, state: object}|{ok: false, reason: string}}
 */
export function createVersionState(record) {
  const normalized = normalizeVersionRecord(record, {
    normalize: true,
    defaultVersion: 1,
    defaultReason: 'manual',
  });
  if (!normalized.ok) return failure(normalized.reason);
  const version = normalized.record.version;
  return {
    ok: true,
    state: {
      versions: [normalized.record],
      currentVersion: version,
      lastVersion: version,
    },
  };
}

/**
 * Add one controlled-strengthened version, or start the chain when the state is empty.
 *
 * The new sample batch is validated by `buildSpeakerTemplate()` first. For an existing chain the
 * batch vector must match the current dimension and the similarity floor, then `mergeTemplate()`
 * blends it with `incomingWeight` (the incoming share). Any refusal returns before a version is
 * created; the input state and samples are never modified.
 *
 * @param {object|null|undefined} state
 * @param {object[]} samples selected candidates `{id, embedding, durationMs, ...}`
 * @param {{incomingWeight?: number, maxSamples?: number, maxDurationMs?: number,
 *   maxVersions?: number, minSamples?: number, minSimilarity?: number, threshold?: number,
 *   reason?: string, createdAt?: number|string|null}} [options]
 * @returns {{ok: true, state: object, version: number}|{ok: false, reason: string}}
 */
export function nextVersion(state, samples, options = {}) {
  const resolved = resolveOptions(options);
  if (!resolved.ok) return resolved;
  const config = resolved.config;

  const normalized = normalizeState(state);
  if (!normalized.ok) {
    return failure(normalized.reason, {
      detail: normalized.kind,
      version: normalized.version,
    });
  }
  const baseState = normalized.state;

  if (!Array.isArray(samples)) return failure('invalid-samples');
  if (samples.length < config.minSamples) {
    return failure('insufficient-samples', {
      sampleCount: samples.length,
      minSamples: config.minSamples,
    });
  }
  if (samples.length > config.maxSamples) {
    return failure('too-many-samples', {
      sampleCount: samples.length,
      maxSamples: config.maxSamples,
    });
  }

  // Mandatory gate: the batch must be internally consistent before it can touch the template.
  const built = buildSpeakerTemplate(samples, {
    threshold: config.consistencyThreshold,
  });
  if (!built.ok) {
    const refused = failure(built.reason);
    if (built.minPairCosine !== undefined) refused.minPairCosine = built.minPairCosine;
    if (built.outlierIds !== undefined) refused.outlierIds = [...built.outlierIds];
    return refused;
  }
  if (built.totalDurationMs > config.maxDurationMs) {
    return failure('duration-cap-exceeded', {
      totalDurationMs: built.totalDurationMs,
      maxDurationMs: config.maxDurationMs,
    });
  }

  const version = baseState.lastVersion + 1;
  if (!Number.isSafeInteger(version) || version > MAX_SAFE_VERSION) {
    return failure('version-exhausted');
  }

  // Root of the chain: the batch itself becomes version 1, with no parent.
  if (baseState.currentVersion === null) {
    const record = {
      version,
      vector: built.vector,
      sampleCount: built.sampleCount,
      totalDurationMs: built.totalDurationMs,
      createdAt: config.createdAt,
      reason: 'initial',
      parentVersion: null,
    };
    return commitVersion(baseState, record, config.maxVersions);
  }

  const current = recordOf(baseState, baseState.currentVersion);
  if (current === null) {
    // normalizeState already guarantees this cannot happen; kept as a defensive refusal.
    return failure('invalid-state', { detail: 'current-missing', version: null });
  }
  if (current.vector.length !== built.vector.length) {
    return failure('dim-mismatch', {
      expectedDimension: current.vector.length,
      actualDimension: built.vector.length,
    });
  }

  const similarity = cosineSimilarity(current.vector, built.vector);
  if (!(similarity >= config.minSimilarity)) {
    return failure('low-similarity', {
      similarity,
      minSimilarity: config.minSimilarity,
    });
  }

  const merged = mergeTemplate(current, built, config.incomingWeight);
  if (!merged.ok) return failure(merged.reason);

  const record = {
    version,
    vector: merged.vector,
    sampleCount: merged.sampleCount,
    totalDurationMs: merged.totalDurationMs,
    createdAt: config.createdAt,
    reason: config.reason,
    parentVersion: current.version,
  };
  return commitVersion(baseState, record, config.maxVersions);
}

/**
 * Explicitly select an existing version as current. History is copied, not rewritten or appended.
 *
 * @param {object} state
 * @param {number} version existing version number
 * @returns {{ok: true, state: object, currentVersion: number, previousVersion: number,
 *   changed: boolean}|{ok: false, reason: string}}
 */
export function selectVersion(state, version) {
  if (!validVersionNumber(version)) return failure('invalid-version');
  const normalized = normalizeState(state);
  if (!normalized.ok) {
    if (normalized.kind === 'invalid-vector' && normalized.version === version) {
      return failure('bad-version-vector', { version });
    }
    return failure(normalized.reason, {
      detail: normalized.kind,
      version: normalized.version,
    });
  }
  const current = normalized.state;
  const target = recordOf(current, version);
  if (target === null) return failure('version-not-found', { version });

  const previousVersion = current.currentVersion;
  return {
    ok: true,
    state: {
      versions: current.versions,
      currentVersion: target.version,
      lastVersion: current.lastVersion,
    },
    currentVersion: target.version,
    previousVersion,
    changed: target.version !== previousVersion,
  };
}

/**
 * Roll the current pointer back to a historical version without rewriting history.
 *
 * This never creates a version and never deletes one; the previous current remains selectable
 * (unless it had already been evicted by the bounded chain). Missing versions and broken vectors
 * are refused.
 *
 * @param {object} state
 * @param {number} version historical version number
 * @returns {{ok: true, state: object, currentVersion: number, restoredFrom: number,
 *   changed: boolean}|{ok: false, reason: string}}
 */
export function rollback(state, version) {
  const selected = selectVersion(state, version);
  if (!selected.ok) return selected;
  return {
    ok: true,
    state: selected.state,
    currentVersion: selected.currentVersion,
    restoredFrom: selected.previousVersion,
    changed: selected.changed,
  };
}

/**
 * Read the current version record (a fresh copy), or null for the empty state.
 *
 * @param {object|null|undefined} state
 * @returns {{ok: true, record: object|null}|{ok: false, reason: string}}
 */
export function getCurrentVersion(state) {
  const normalized = normalizeState(state);
  if (!normalized.ok) {
    return failure(normalized.reason, {
      detail: normalized.kind,
      version: normalized.version,
    });
  }
  if (normalized.state.currentVersion === null) return { ok: true, record: null };
  const record = recordOf(normalized.state, normalized.state.currentVersion);
  if (record === null) {
    return failure('invalid-state', { detail: 'current-missing', version: null });
  }
  return { ok: true, record };
}
