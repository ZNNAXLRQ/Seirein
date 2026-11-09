/**
 * Speaker daily candidates — stage 4: a small file-backed cache of recent MIC utterances.
 *
 * This is a cache, not an identity decision. It exists so a later, explicit step can look at
 * "what has this microphone heard today?" before the user ever enrolls a voice. Nothing here
 * creates a speaker template, writes the speaker library, calls a model, uses the network,
 * assigns a speakerId, or claims an earlier transcript. A candidate is always `status:'pending'`
 * until a future layer (not part of this module) decides what to do with it.
 *
 * Storage:
 *   - `<root>/data/speaker-candidates.json` holds metadata only. `root` is passed in, never
 *     inferred. The caller passes `audioPath`; this module never copies, opens or decodes the
 *     audio. It only creates the metadata file and, when a candidate leaves the cache, unlinks the
 *     caller's `audioPath` (best-effort).
 *   - The embedding is a Float32Array serialized as canonical little-endian base64. It is
 *     validated on every read (`base64` shape, byte length multiple of 4, every float finite,
 *     non-zero norm), so a corrupt vector cannot enter a group. A stored row whose embedding is
 *     unusable is skipped rather than crashing the read.
 *
 * Candidate shape (persisted verbatim):
 *   {
 *     id, utteranceId, speakerId: null|string, embedding: base64,
 *     durationMs, at, source: 'mic', quality: 'ok', text,
 *     audioPath, status: 'pending', groupId: null|'group-N'
 *   }
 *
 * Admission rules (`add()`):
 *   - `source` must be `mic` (missing defaults to `mic`); loopback is refused;
 *   - `durationMs` must be within [800, 15000] ms (inclusive);
 *   - `quality` must be `ok` (missing defaults to `ok`); a short/quiet/noisy row is refused;
 *   - `utteranceId` is the de-duplication key: a live row with the same key wins and the new
 *     audio is left untouched;
 *   - `audioPath` is required and the embedding must be a non-empty, finite, non-zero vector;
 *   - an `at` already older than `maxAgeMs` is refused (`too-old`) rather than inserted and
 *     immediately pruned, so a rejected row never causes its caller-owned audio to be unlinked.
 *
 * Bounds are oldest-first (FIFO): at most 40 candidates, 300 s accumulated duration, 64 MiB
 * accumulated bytes and a 7-day lifetime. The byte total follows the audio file size when it
 * exists (`stat` only — the content is never read), otherwise the candidate's serialized JSON
 * size. `add()`, `list()`, `groups()` and the explicit `prune()` apply expiry and all three caps;
 * the removed candidate's audio is unlinked after the metadata write succeeds. `status()` is
 * read-only and reports, among other things, how many rows are already expired.
 *
 * `groups()` is a clustering aid, not identity: candidates are grouped by cosine similarity
 * (default >= 0.72) using complete-link in chronological order — a candidate joins a group only
 * when it is similar to EVERY member. That avoids the A~B~C chain where A and C are not alike.
 * It recomputes groupId for every live candidate, persists it, and never touches speakerId.
 *
 * Writes are atomic (temp file in the same directory + rename) and every public mutator returns
 * `{ok:true,...}` or `{ok:false, reason}` instead of throwing. Reads re-read the file each time,
 * so two stores over one root agree and a restart needs no cache invalidation. Bad/missing JSON
 * yields an empty state; the next write heals the file.
 */
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

/** Metadata path inside the caller-provided root. */
export const SPEAKER_CANDIDATES_PATH = join('data', 'speaker-candidates.json');

/** Persisted schema version. */
export const SPEAKER_CANDIDATES_VERSION = 1;

/** The only admitted source: a candidate is never a loopback/video-bleed row. */
export const SPEAKER_CANDIDATE_SOURCE = 'mic';

/** The only admitted quality: a short/quiet/noisy embedding is not cached. */
export const SPEAKER_CANDIDATE_QUALITY = 'ok';

/** The only status this module writes; promotion is a later layer's job. */
export const SPEAKER_CANDIDATE_STATUS = Object.freeze({ PENDING: 'pending' });

/** Inclusive duration window for one candidate. */
export const SPEAKER_CANDIDATE_MIN_DURATION_MS = 800;
export const SPEAKER_CANDIDATE_MAX_DURATION_MS = 15000;

/** Default cosine-similarity floor for `groups()`. */
export const SPEAKER_CANDIDATE_GROUP_THRESHOLD = 0.72;

/**
 * Default bounds. One candidate at 15 s is 1/20 of the duration budget, so the 40-row cap is the
 * usual first bound; bytes and age are independent safety nets.
 */
export const DEFAULT_SPEAKER_CANDIDATE_LIMITS = Object.freeze({
  maxCandidates: 40,
  maxTotalDurationMs: 300 * 1000,
  maxTotalBytes: 64 * 1024 * 1024,
  maxAgeMs: 7 * 24 * 60 * 60 * 1000,
});

/** Monotonic temp-file suffix, so two stores in one process never share a temp path. */
let writeTmpSeq = 0;

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A trimmed string or ''. */
function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** A JSON-safe deep copy; persisted candidates contain only strings, numbers and nulls. */
function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/** A positive finite limit, falling back per field when the caller supplies garbage. */
export function resolveSpeakerCandidateLimits(input = null) {
  const source = plainObject(input) ? input : {};
  const pick = (key, fallback, integer = false) => {
    const value = Number(source[key]);
    if (!Number.isFinite(value) || value <= 0) return fallback;
    const rounded = integer ? Math.floor(value) : Math.round(value);
    return rounded > 0 ? rounded : fallback;
  };
  return {
    maxCandidates: pick('maxCandidates', DEFAULT_SPEAKER_CANDIDATE_LIMITS.maxCandidates, true),
    maxTotalDurationMs: pick('maxTotalDurationMs', DEFAULT_SPEAKER_CANDIDATE_LIMITS.maxTotalDurationMs),
    maxTotalBytes: pick('maxTotalBytes', DEFAULT_SPEAKER_CANDIDATE_LIMITS.maxTotalBytes),
    maxAgeMs: pick('maxAgeMs', DEFAULT_SPEAKER_CANDIDATE_LIMITS.maxAgeMs),
  };
}

/** One ISO instant, or null when the input cannot name a date. */
function isoInstant(value) {
  try {
    if (value instanceof Date) {
      const ms = value.getTime();
      return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
    }
    if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
    if (typeof value === 'string' && value.trim().length > 0) {
      const ms = Date.parse(value);
      return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
    }
  } catch {
    /* an out-of-range date is "no instant", never a throw */
  }
  return null;
}

/** The injected clock as epoch ms; a broken clock falls back to the wall clock. */
function clockNowMs(clock) {
  try {
    const value = clock();
    const instant = isoInstant(value);
    if (instant !== null) return Date.parse(instant);
  } catch {
    /* fall through to Date.now() */
  }
  return Date.now();
}

/** A duration that is inside the admitted window, or null. */
function admissibleDuration(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const ms = Math.round(number);
  if (ms < SPEAKER_CANDIDATE_MIN_DURATION_MS || ms > SPEAKER_CANDIDATE_MAX_DURATION_MS) return null;
  return ms;
}

/** Admission check with an explainable reason instead of a bare null. */
function prepareDuration(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') {
    return { ok: false, reason: 'invalid-duration' };
  }
  const number = Number(value);
  if (!Number.isFinite(number)) return { ok: false, reason: 'invalid-duration' };
  const ms = Math.round(number);
  if (ms < SPEAKER_CANDIDATE_MIN_DURATION_MS) return { ok: false, reason: 'too-short' };
  if (ms > SPEAKER_CANDIDATE_MAX_DURATION_MS) return { ok: false, reason: 'too-long' };
  return { ok: true, durationMs: ms };
}

/* ----------------------------------------------------------------------------------------- *
 * Embedding serialization
 * ----------------------------------------------------------------------------------------- */

/**
 * Float32Array (or a plain number array) → canonical little-endian base64.
 *
 * Returns null for a non-array, an empty vector, a non-finite member, a member that overflows
 * float32, or a zero vector. The round trip is covered by `decodeEmbedding`.
 *
 * @param {Float32Array|number[]} value
 * @returns {string|null}
 */
export function encodeEmbedding(value) {
  if (!(value instanceof Float32Array) && !Array.isArray(value)) return null;
  if (value.length === 0) return null;
  const bytes = Buffer.allocUnsafe(value.length * 4);
  let sum = 0;
  for (let index = 0; index < value.length; index += 1) {
    const number = Number(value[index]);
    if (!Number.isFinite(number)) return null;
    const float = Math.fround(number);
    if (!Number.isFinite(float)) return null;
    bytes.writeFloatLE(float, index * 4);
    sum += float * float;
  }
  if (!Number.isFinite(sum) || !(sum > 0)) return null;
  return bytes.toString('base64');
}

/**
 * Canonical little-endian base64 → a fresh Float32Array, or null when the value is unusable.
 *
 * Validation is deliberately strict: canonical base64 padding, a byte length divisible by 4,
 * every decoded float finite, a non-zero norm. A bad vector can therefore never score a match.
 *
 * @param {unknown} value
 * @returns {Float32Array|null}
 */
export function decodeEmbedding(value) {
  if (typeof value !== 'string') return null;
  const encoded = value.trim();
  if (encoded.length === 0 || encoded.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) return null;
  let bytes;
  try {
    bytes = Buffer.from(encoded, 'base64');
  } catch {
    return null;
  }
  if (bytes.length === 0 || bytes.length % 4 !== 0) return null;
  if (bytes.toString('base64') !== encoded) return null;
  const vector = new Float32Array(bytes.length / 4);
  let sum = 0;
  for (let index = 0; index < vector.length; index += 1) {
    const float = bytes.readFloatLE(index * 4);
    if (!Number.isFinite(float)) return null;
    vector[index] = float;
    sum += float * float;
  }
  if (!Number.isFinite(sum) || !(sum > 0)) return null;
  return vector;
}

/**
 * Cosine similarity in [-1, 1]. An unusable pair (non-Float32Array, empty, dimension mismatch)
 * scores 0, the neutral value, so a broken vector cannot look like a match.
 *
 * @param {Float32Array} left
 * @param {Float32Array} right
 * @returns {number}
 */
export function cosineSimilarity(left, right) {
  if (!(left instanceof Float32Array) || !(right instanceof Float32Array)) return 0;
  if (left.length === 0 || left.length !== right.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  if (!(leftNorm > 0) || !(rightNorm > 0)) return 0;
  const score = dot / Math.sqrt(leftNorm * rightNorm);
  return Number.isFinite(score) ? Math.max(-1, Math.min(1, score)) : 0;
}

/* ----------------------------------------------------------------------------------------- *
 * Persisted shape
 * ----------------------------------------------------------------------------------------- */

function freshState() {
  return { version: SPEAKER_CANDIDATES_VERSION, updatedAt: '', candidates: [] };
}

/** One normalized stored candidate, or null when any required field is unusable. */
function normalizeCandidate(raw) {
  if (!plainObject(raw)) return null;
  const id = text(raw.id);
  const utteranceId = text(raw.utteranceId);
  const audioPath = text(raw.audioPath);
  if (id.length === 0 || utteranceId.length === 0 || audioPath.length === 0) return null;
  if (text(raw.source) !== SPEAKER_CANDIDATE_SOURCE) return null;
  if (text(raw.quality) !== SPEAKER_CANDIDATE_QUALITY) return null;
  if (text(raw.status) !== SPEAKER_CANDIDATE_STATUS.PENDING) return null;
  const durationMs = admissibleDuration(raw.durationMs);
  if (durationMs === null) return null;
  const at = isoInstant(raw.at);
  if (at === null) return null;
  const embedding = decodeEmbedding(raw.embedding);
  if (embedding === null) return null;
  const speakerId = raw.speakerId === null || raw.speakerId === undefined
    ? null
    : (text(raw.speakerId).length > 0 ? text(raw.speakerId) : null);
  const groupId = raw.groupId === null || raw.groupId === undefined
    ? null
    : (text(raw.groupId).length > 0 ? text(raw.groupId) : null);
  return {
    id,
    utteranceId,
    speakerId,
    embedding: text(raw.embedding),
    durationMs,
    at,
    source: SPEAKER_CANDIDATE_SOURCE,
    quality: SPEAKER_CANDIDATE_QUALITY,
    text: typeof raw.text === 'string' ? raw.text.trim() : '',
    audioPath,
    status: SPEAKER_CANDIDATE_STATUS.PENDING,
    groupId,
  };
}

/**
 * Strict top-level v1 shape, tolerant per row: a bad row is skipped, duplicate ids/utteranceIds
 * keep the first occurrence. `null` means the file is not a v1 store at all.
 */
function normalizeState(raw) {
  if (!plainObject(raw)) return null;
  if (raw.version !== SPEAKER_CANDIDATES_VERSION) return null;
  if (!Array.isArray(raw.candidates)) return null;
  const candidates = [];
  const ids = new Set();
  const utterances = new Set();
  for (const rawCandidate of raw.candidates) {
    const candidate = normalizeCandidate(rawCandidate);
    if (candidate === null) continue;
    if (ids.has(candidate.id) || utterances.has(candidate.utteranceId)) continue;
    ids.add(candidate.id);
    utterances.add(candidate.utteranceId);
    candidates.push(candidate);
  }
  return {
    version: SPEAKER_CANDIDATES_VERSION,
    updatedAt: text(raw.updatedAt),
    candidates,
  };
}

/** Chronological (then id) order used by FIFO eviction and `list()`. */
function compareOldest(left, right) {
  const leftMs = Date.parse(left.at);
  const rightMs = Date.parse(right.at);
  if (leftMs !== rightMs) return leftMs - rightMs;
  if (left.id === right.id) return 0;
  return left.id < right.id ? -1 : 1;
}

/** Allocate the next `spc-N` id without relying on a persisted counter. */
function nextCandidateId(candidates) {
  let highest = 0;
  for (const candidate of candidates) {
    const match = /^spc-(\d+)$/u.exec(candidate.id);
    if (match !== null) highest = Math.max(highest, Number(match[1]));
  }
  return `spc-${highest + 1}`;
}

/** Sum duration and byte cost over the given candidates. */
function totalsOf(candidates, byteSizeOf) {
  let totalDurationMs = 0;
  let totalBytes = 0;
  for (const candidate of candidates) {
    totalDurationMs += candidate.durationMs;
    totalBytes += byteSizeOf(candidate);
  }
  return { count: candidates.length, totalDurationMs, totalBytes };
}

/**
 * Create the file-backed candidate cache for one root.
 *
 * @param {object} options
 * @param {string} options.root caller-owned root; metadata lives at
 *   `<root>/data/speaker-candidates.json`.
 * @param {() => (Date|number|string)} [options.clock] injected time source.
 * @param {object|null} [options.limits] partial limit overrides (tests / host policy).
 * @param {{emit?: (event: string, payload: object) => unknown}|null} [options.log] optional debug
 *   sink; the only event is `speaker.candidates.corrupt {file, error}`.
 * @returns {Readonly<object>} `{file, add, list, groups, remove, clear, prune, status}`.
 */
export function createSpeakerCandidatesStore({
  root,
  clock = () => new Date(),
  limits = null,
  log = null,
} = {}) {
  if (typeof root !== 'string' || root.trim().length === 0) {
    throw new TypeError('speaker candidates: root is required');
  }
  if (typeof clock !== 'function') {
    throw new TypeError('speaker candidates: clock must be a function');
  }
  const file = join(root, SPEAKER_CANDIDATES_PATH);
  const rootPath = resolve(root);
  const nextLimits = resolveSpeakerCandidateLimits(limits);
  let lastCorruption = '';

  const emit = (event, payload) => {
    try {
      void log?.emit?.(event, payload)?.catch?.(() => {});
    } catch {
      /* a debug sink must never change cache behaviour */
    }
  };

  const corrupt = (error, rawText = '') => {
    const message = error?.message ?? String(error);
    const signature = `${message}\u0000${rawText}`;
    if (signature === lastCorruption) return;
    lastCorruption = signature;
    emit('speaker.candidates.corrupt', { file, error: message });
  };

  /** Resolve a caller audioPath for stat/unlink; relative paths are rooted at the store root. */
  const audioPathOf = (candidate) => {
    const value = text(candidate?.audioPath);
    if (value.length === 0) return '';
    return isAbsolute(value) ? value : resolve(rootPath, value);
  };

  const samePath = (left, right) => {
    if (process.platform === 'win32') return left.toLowerCase() === right.toLowerCase();
    return left === right;
  };

  /**
   * Best-effort unlink of one candidate's audio. Never deletes the metadata file, a directory or
   * a missing path; every filesystem failure is swallowed and reported as `false`.
   */
  const deleteAudioFile = (candidate) => {
    const target = audioPathOf(candidate);
    if (target.length === 0) return false;
    if (samePath(resolve(target), resolve(file))) return false;
    try {
      if (!statSync(target).isFile()) return false;
      unlinkSync(target);
      return true;
    } catch {
      return false;
    }
  };

  const deleteAudioFor = (candidates) => {
    const seen = new Set();
    let audioDeleted = 0;
    let audioFailed = 0;
    for (const candidate of candidates) {
      const target = audioPathOf(candidate);
      if (target.length === 0 || seen.has(target)) continue;
      seen.add(target);
      if (deleteAudioFile(candidate)) audioDeleted += 1;
      else audioFailed += 1;
    }
    return { audioDeleted, audioFailed };
  };

  /**
   * Byte cost of one candidate: the audio file size when it exists (stat only), otherwise the
   * serialized JSON size. The module never opens the audio content.
   */
  const byteSizeOf = (candidate) => {
    const target = audioPathOf(candidate);
    if (target.length > 0) {
      try {
        const info = statSync(target);
        if (info.isFile()) return info.size;
      } catch {
        /* missing/unreadable audio falls back to the metadata footprint */
      }
    }
    return Buffer.byteLength(JSON.stringify(candidate), 'utf8');
  };

  /** Read the file; missing → empty, unreadable/malformed → empty plus one corrupt event. */
  const read = () => {
    let rawText;
    try {
      rawText = readFileSync(file, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') corrupt(error);
      return freshState();
    }
    try {
      const state = normalizeState(JSON.parse(rawText));
      if (state === null) throw new TypeError('不是有效的声纹日常候选 v1 文件');
      lastCorruption = '';
      return state;
    } catch (error) {
      corrupt(error, rawText);
      return freshState();
    }
  };

  /** Atomic write; the returned state is the normalized state that actually landed. */
  const save = (state) => {
    const normalized = normalizeState(state);
    if (normalized === null) throw new TypeError('speaker candidates: refusing to write a malformed state');
    normalized.updatedAt = isoInstant(clockNowMs(clock)) ?? new Date().toISOString();
    mkdirSync(dirname(file), { recursive: true });
    writeTmpSeq += 1;
    const temporary = `${file}.${process.pid}.${writeTmpSeq}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
      renameSync(temporary, file);
    } catch (error) {
      try {
        unlinkSync(temporary);
      } catch {
        /* the temp file may never have been created */
      }
      throw error;
    }
    lastCorruption = '';
    return normalized;
  };

  /**
   * Expire rows older than `maxAgeMs`, then evict oldest-first until all three totals fit.
   * Mutates `state.candidates` and returns the removed rows split by reason.
   */
  const pruneState = (state, nowMs) => {
    const expired = [];
    const kept = [];
    for (const candidate of state.candidates) {
      const atMs = Date.parse(candidate.at);
      if (!Number.isFinite(atMs) || nowMs - atMs > nextLimits.maxAgeMs) expired.push(candidate);
      else kept.push(candidate);
    }
    state.candidates = kept;
    const entries = kept.map((candidate) => ({ candidate, bytes: byteSizeOf(candidate) }));
    let count = entries.length;
    let totalDurationMs = entries.reduce((sum, entry) => sum + entry.candidate.durationMs, 0);
    let totalBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
    const evicted = [];
    if (count > nextLimits.maxCandidates
      || totalDurationMs > nextLimits.maxTotalDurationMs
      || totalBytes > nextLimits.maxTotalBytes) {
      const ordered = [...entries].sort((left, right) => compareOldest(left.candidate, right.candidate));
      for (const entry of ordered) {
        if (count <= nextLimits.maxCandidates
          && totalDurationMs <= nextLimits.maxTotalDurationMs
          && totalBytes <= nextLimits.maxTotalBytes) break;
        evicted.push(entry.candidate);
        count -= 1;
        totalDurationMs -= entry.candidate.durationMs;
        totalBytes -= entry.bytes;
      }
      if (evicted.length > 0) {
        const removed = new Set(evicted);
        state.candidates = kept.filter((candidate) => !removed.has(candidate));
      }
    }
    return { expired, evicted, removed: [...expired, ...evicted] };
  };

  /** Save metadata first, then unlink audio; a failed save leaves every audio file untouched. */
  const commitRemoved = (state, removed) => {
    if (removed.length === 0) return { ok: true, audioDeleted: 0, audioFailed: 0 };
    try {
      save(state);
    } catch (error) {
      return { ok: false, reason: 'write-failed', error: error?.message ?? String(error) };
    }
    return { ok: true, ...deleteAudioFor(removed) };
  };

  /** One metadata admission pass; no state is touched. */
  const prepareCandidate = (input, nowIso) => {
    const options = plainObject(input) ? input : {};
    const utteranceId = text(options.utteranceId);
    if (utteranceId.length === 0) return { ok: false, reason: 'utterance-id-required' };
    const source = options.source === undefined || options.source === null
      ? SPEAKER_CANDIDATE_SOURCE
      : text(options.source);
    if (source !== SPEAKER_CANDIDATE_SOURCE) return { ok: false, reason: 'invalid-source' };
    const quality = options.quality === undefined || options.quality === null
      ? SPEAKER_CANDIDATE_QUALITY
      : text(options.quality);
    if (quality !== SPEAKER_CANDIDATE_QUALITY) return { ok: false, reason: 'invalid-quality' };
    const duration = prepareDuration(options.durationMs);
    if (duration.ok !== true) return duration;
    const audioPath = text(options.audioPath);
    if (audioPath.length === 0) return { ok: false, reason: 'audio-path-required' };
    const embedding = encodeEmbedding(options.embedding);
    if (embedding === null) return { ok: false, reason: 'invalid-embedding' };
    const at = isoInstant(options.at) ?? nowIso;
    const speakerId = options.speakerId === null || options.speakerId === undefined
      ? null
      : (text(options.speakerId).length > 0 ? text(options.speakerId) : null);
    return {
      ok: true,
      candidate: {
        id: '',
        utteranceId,
        speakerId,
        embedding,
        durationMs: duration.durationMs,
        at,
        source: SPEAKER_CANDIDATE_SOURCE,
        quality: SPEAKER_CANDIDATE_QUALITY,
        text: typeof options.text === 'string' ? options.text.trim() : '',
        audioPath,
        status: SPEAKER_CANDIDATE_STATUS.PENDING,
        groupId: null,
      },
    };
  };

  /**
   * Admit one recent mic utterance.
   *
   * @param {{utteranceId: string, embedding: Float32Array|number[], durationMs: number,
   *   audioPath: string, at?: string|number|Date, text?: string,
   *   speakerId?: string|null, source?: 'mic', quality?: 'ok'}} input
   * @returns {{ok: true, added: true, candidate: object, pruned: number, removedIds: string[],
   *   audioDeleted: number, audioFailed: number, totals: object}
   *   | {ok: true, added: false, duplicate: true, reason: 'duplicate-utterance',
   *      candidate: object, pruned: number}
   *   | {ok: false, reason: string}}
   */
  const add = (input = {}) => {
    const nowMs = clockNowMs(clock);
    const nowIso = isoInstant(nowMs) ?? new Date().toISOString();
    const prepared = prepareCandidate(input, nowIso);
    if (prepared.ok !== true) return prepared;
    // A row that is already past the retention window cannot enter the cache; rejecting it also
    // means its caller-owned audio is never unlinked by an immediate prune.
    if (nowMs - Date.parse(prepared.candidate.at) > nextLimits.maxAgeMs) {
      return { ok: false, reason: 'too-old' };
    }

    const state = read();
    const first = pruneState(state, nowMs);
    const duplicate = state.candidates.find(
      (candidate) => candidate.utteranceId === prepared.candidate.utteranceId,
    );
    if (duplicate !== undefined) {
      const commit = commitRemoved(state, first.removed);
      if (commit.ok !== true) return commit;
      return {
        ok: true,
        added: false,
        duplicate: true,
        reason: 'duplicate-utterance',
        candidate: clone(duplicate),
        pruned: first.removed.length,
      };
    }

    const newBytes = byteSizeOf(prepared.candidate);
    if (prepared.candidate.durationMs > nextLimits.maxTotalDurationMs
      || newBytes > nextLimits.maxTotalBytes) {
      const commit = commitRemoved(state, first.removed);
      if (commit.ok !== true) return commit;
      return {
        ok: false,
        reason: 'over-limit',
        durationMs: prepared.candidate.durationMs,
        bytes: newBytes,
        pruned: first.removed.length,
      };
    }

    prepared.candidate.id = nextCandidateId(state.candidates);
    state.candidates.push(prepared.candidate);
    const second = pruneState(state, nowMs);
    const removed = [...first.removed, ...second.removed];
    let saved;
    try {
      saved = save(state);
    } catch (error) {
      return { ok: false, reason: 'write-failed', error: error?.message ?? String(error) };
    }
    const deletion = deleteAudioFor(removed);
    const stored = saved.candidates.find((candidate) => candidate.id === prepared.candidate.id);
    return {
      ok: true,
      added: stored !== undefined,
      duplicate: false,
      candidate: stored === undefined ? null : clone(stored),
      pruned: removed.length,
      removedIds: removed.map((candidate) => candidate.id),
      ...deletion,
      totals: totalsOf(saved.candidates, byteSizeOf),
    };
  };

  /**
   * Live candidates, oldest-first. Expiry and the three caps are applied first (and their audio
   * removed after the metadata write), so a read never exposes a stale row.
   *
   * @returns {object[]}
   */
  const list = () => {
    const state = read();
    const pruned = pruneState(state, clockNowMs(clock));
    if (pruned.removed.length > 0) commitRemoved(state, pruned.removed);
    return clone(state.candidates).sort(compareOldest);
  };

  /**
   * Cluster live candidates by cosine similarity. Complete-link, chronological seeding, and
   * `groupId` values `group-1`, `group-2`, ...; grouping never writes `speakerId`.
   *
   * @param {{threshold?: number}} [options]
   * @returns {{groupId: string, size: number, candidateIds: string[], candidates: object[],
   *   totalDurationMs: number, averageDurationMs: number, from: string, to: string}[]}
   */
  const groups = ({ threshold = SPEAKER_CANDIDATE_GROUP_THRESHOLD } = {}) => {
    const state = read();
    const pruned = pruneState(state, clockNowMs(clock));
    if (pruned.removed.length > 0) commitRemoved(state, pruned.removed);
    const floorValue = Number(threshold);
    const floor = Number.isFinite(floorValue)
      ? Math.max(-1, Math.min(1, floorValue))
      : SPEAKER_CANDIDATE_GROUP_THRESHOLD;
    const ordered = [...state.candidates].sort(compareOldest);
    const clusters = [];
    for (const candidate of ordered) {
      const vector = decodeEmbedding(candidate.embedding);
      let target = null;
      if (vector !== null) {
        target = clusters.find((cluster) => cluster.members.every(
          (member) => cosineSimilarity(member.vector, vector) >= floor,
        )) ?? null;
      }
      if (target === null) {
        target = { members: [] };
        clusters.push(target);
      }
      target.members.push({ candidate, vector });
    }
    let changed = false;
    const result = clusters.map((cluster, index) => {
      const groupId = `group-${index + 1}`;
      for (const member of cluster.members) {
        if (member.candidate.groupId !== groupId) {
          member.candidate.groupId = groupId;
          changed = true;
        }
      }
      const candidates = cluster.members.map((member) => clone(member.candidate));
      const totalDurationMs = cluster.members.reduce(
        (sum, member) => sum + member.candidate.durationMs,
        0,
      );
      return {
        groupId,
        size: candidates.length,
        candidateIds: candidates.map((candidate) => candidate.id),
        candidates,
        totalDurationMs,
        averageDurationMs: Math.round(totalDurationMs / candidates.length),
        from: candidates[0].at,
        to: candidates[candidates.length - 1].at,
      };
    });
    if (changed) {
      try {
        save(state);
      } catch {
        /* the grouping view is still valid; groupId persistence is best-effort */
      }
    }
    return result;
  };

  /**
   * Remove one candidate by id and unlink its audio after the metadata write.
   *
   * @param {string} id
   * @returns {{ok: true, candidate: object, audioDeleted: boolean, audioFailed: boolean}
   *   | {ok: false, reason: string}}
   */
  const remove = (id) => {
    const wanted = text(id);
    if (wanted.length === 0) return { ok: false, reason: 'id-required' };
    const state = read();
    const index = state.candidates.findIndex((candidate) => candidate.id === wanted);
    if (index < 0) return { ok: false, reason: 'not-found' };
    const [candidate] = state.candidates.splice(index, 1);
    try {
      save(state);
    } catch (error) {
      return { ok: false, reason: 'write-failed', error: error?.message ?? String(error) };
    }
    const deletion = deleteAudioFor([candidate]);
    return {
      ok: true,
      candidate: clone(candidate),
      audioDeleted: deletion.audioDeleted > 0,
      audioFailed: deletion.audioFailed > 0,
    };
  };

  /**
   * Remove every candidate and unlink every audio file. Metadata is cleared first; a failed write
   * deletes nothing. Missing audio is best-effort and never turns `clear()` into a failure.
   *
   * @returns {{ok: true, removed: number, audioDeleted: number, audioFailed: number}
   *   | {ok: false, reason: string}}
   */
  const clear = () => {
    const state = read();
    const removed = [...state.candidates];
    state.candidates = [];
    try {
      save(state);
    } catch (error) {
      return { ok: false, reason: 'write-failed', error: error?.message ?? String(error) };
    }
    return { ok: true, removed: removed.length, ...deleteAudioFor(removed) };
  };

  /**
   * Apply expiry and all caps explicitly. Removed audio is unlinked only after the metadata write.
   *
   * @returns {{ok: true, removed: number, expired: number, evicted: number,
   *   removedIds: string[], audioDeleted: number, audioFailed: number,
   *   remaining: object} | {ok: false, reason: string}}
   */
  const prune = () => {
    const state = read();
    const pruned = pruneState(state, clockNowMs(clock));
    const commit = commitRemoved(state, pruned.removed);
    if (commit.ok !== true) return commit;
    return {
      ok: true,
      removed: pruned.removed.length,
      expired: pruned.expired.length,
      evicted: pruned.evicted.length,
      removedIds: pruned.removed.map((candidate) => candidate.id),
      audioDeleted: commit.audioDeleted,
      audioFailed: commit.audioFailed,
      remaining: totalsOf(state.candidates, byteSizeOf),
    };
  };

  /**
   * Read-only snapshot for diagnostics. Does not prune or delete anything; `expired` counts the
   * rows that the next add/list/groups/prune pass will drop.
   *
   * @returns {{file: string, count: number, totalDurationMs: number, totalBytes: number,
   *   oldestAt: string|null, newestAt: string|null, groupCount: number, pending: number,
   *   expired: number, withinLimits: boolean, limits: object}}
   */
  const status = () => {
    const state = read();
    const nowMs = clockNowMs(clock);
    const totals = totalsOf(state.candidates, byteSizeOf);
    const sorted = [...state.candidates].sort(compareOldest);
    const expired = state.candidates.filter((candidate) => {
      const atMs = Date.parse(candidate.at);
      return !Number.isFinite(atMs) || nowMs - atMs > nextLimits.maxAgeMs;
    }).length;
    const groupCount = new Set(
      state.candidates.map((candidate) => candidate.groupId).filter((groupId) => groupId !== null),
    ).size;
    return {
      file,
      count: totals.count,
      totalDurationMs: totals.totalDurationMs,
      totalBytes: totals.totalBytes,
      oldestAt: sorted.length > 0 ? sorted[0].at : null,
      newestAt: sorted.length > 0 ? sorted[sorted.length - 1].at : null,
      groupCount,
      pending: state.candidates.filter(
        (candidate) => candidate.status === SPEAKER_CANDIDATE_STATUS.PENDING,
      ).length,
      expired,
      withinLimits: totals.count <= nextLimits.maxCandidates
        && totals.totalDurationMs <= nextLimits.maxTotalDurationMs
        && totals.totalBytes <= nextLimits.maxTotalBytes
        && expired === 0,
      limits: { ...nextLimits },
    };
  };

  return Object.freeze({ file, add, list, groups, remove, clear, prune, status });
}
