/**
 * Speaker-candidate actions — the safe, read-forward seam a settings action or UI calls next.
 *
 * The candidate cache (`speaker-candidates.js`) owns the metadata and raw audio paths; the
 * template builder (`speaker-template.js`) owns the pure consistency/vector decision. This module
 * is the small glue between them, and deliberately nothing else:
 *   - it never writes the speaker library, never sets `self`, never assigns a speakerId, never
 *     calls a model or the network;
 *   - its only filesystem access is reading candidate audio (stat + read) for `audio()`, plus the
 *     existence check behind the `audioAvailable` flag;
 *   - `preview()` decodes candidate embeddings internally, calls `buildTemplate`, and returns only
 *     decision evidence. It does not return the template vector unless the caller explicitly asks
 *     for it with `includeVector:true`, which is a host-only opt-in, not a UI shape;
 *   - no absolute audio path appears in any returned value, including error results.
 *
 * API (`createSpeakerCandidateActions({store, buildTemplate})`):
 *   - `list()` → `{ok:true, count, candidates}` where every candidate is exactly
 *     `{id, utteranceId, durationMs, at, text, speakerId, groupId, audioAvailable}`. The stored
 *     embedding, `audioPath`, `source`, `quality` and `status` never cross this seam.
 *   - `audio(id)` → `{ok:true, mime:'audio/wav', base64, bytes}` for one file of at most 1 MiB.
 *     Failures: `id-required`, `not-found`, `audio-missing`, `audio-too-large`, `audio-unreadable`.
 *   - `remove(id)` → `{ok:true, id, removed:1, audioDeleted, audioFailed}`; delegates to
 *     `store.remove()` and never echoes the removed row (it carries the path/embedding).
 *   - `clear()` → `{ok:true, removed, audioDeleted, audioFailed}`; delegates to `store.clear()`.
 *   - `preview(ids, {threshold?, includeVector?})` → on success
 *     `{ok:true, sampleCount, totalDurationMs, minPairCosine, confidence, dimension}` (plus
 *     `vector` as a plain number array only when `includeVector:true`); an inconsistent set
 *     returns `{ok:false, reason:'inconsistent', minPairCosine, outlierIds, ...}` and no vector.
 *     IDs are trimmed and de-duplicated; an empty list, a non-string/blank id or more than 20
 *     unique ids is refused before the store is read.
 *
 * The actions are thin: store failures become `{ok:false, reason:'store-failed'}` instead of
 * throws, and a throwing/invalid injected `buildTemplate` becomes
 * `{ok:false, reason:'template-failed'}`. Success never persists anything.
 */
import { readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

import { decodeEmbedding } from './speaker-candidates.js';
import { buildSpeakerTemplate } from './speaker-template.js';

/** Hard cap on one audio response; base64 makes the wire value ~1.33× larger. */
export const SPEAKER_CANDIDATE_MAX_AUDIO_BYTES = 1024 * 1024;

/** Maximum number of unique candidates one preview may combine. */
export const SPEAKER_CANDIDATE_PREVIEW_MAX_IDS = 20;

/** The only fields `list()` exposes for one candidate. */
export const SPEAKER_CANDIDATE_SAFE_VIEW_FIELDS = Object.freeze([
  'id',
  'utteranceId',
  'durationMs',
  'at',
  'text',
  'speakerId',
  'groupId',
  'audioAvailable',
]);

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}

/** Safe fields only; the caller supplies whether the file exists. */
function candidateView(candidate, audioAvailable) {
  return {
    id: text(candidate?.id),
    utteranceId: text(candidate?.utteranceId),
    durationMs: Number.isFinite(Number(candidate?.durationMs))
      ? Math.round(Number(candidate.durationMs))
      : 0,
    at: text(candidate?.at),
    text: typeof candidate?.text === 'string' ? candidate.text : '',
    speakerId: candidate?.speakerId === null || candidate?.speakerId === undefined
      ? null
      : (text(candidate.speakerId).length > 0 ? text(candidate.speakerId) : null),
    groupId: candidate?.groupId === null || candidate?.groupId === undefined
      ? null
      : (text(candidate.groupId).length > 0 ? text(candidate.groupId) : null),
    audioAvailable: audioAvailable === true,
  };
}

/** One non-empty id, or an error result. Shared by audio/remove. */
function prepareId(value) {
  const id = text(value);
  if (id.length === 0) return { ok: false, reason: 'id-required' };
  return { ok: true, id };
}

/**
 * Trim, validate and de-duplicate preview ids while preserving request order.
 * The 20-id cap applies after de-duplication.
 */
function prepareIds(value) {
  if (!Array.isArray(value)) return { ok: false, reason: 'invalid-ids' };
  const ids = [];
  const seen = new Set();
  for (const raw of value) {
    if (typeof raw !== 'string') return { ok: false, reason: 'invalid-id' };
    const id = raw.trim();
    if (id.length === 0) return { ok: false, reason: 'invalid-id' };
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length > SPEAKER_CANDIDATE_PREVIEW_MAX_IDS) {
      return { ok: false, reason: 'too-many-ids', max: SPEAKER_CANDIDATE_PREVIEW_MAX_IDS };
    }
  }
  if (ids.length === 0) return { ok: false, reason: 'no-ids' };
  return { ok: true, ids };
}

/** One candidate's audio path as an absolute path; never returned to the caller. */
function resolveAudioPath(candidate, root) {
  const audioPath = text(candidate?.audioPath);
  if (audioPath.length === 0) return '';
  if (isAbsolute(audioPath)) {
    try {
      return resolve(audioPath);
    } catch {
      return '';
    }
  }
  if (root.length === 0) return '';
  try {
    return resolve(root, audioPath);
  } catch {
    return '';
  }
}

/** The store's file is `<root>/data/speaker-candidates.json`; also accept a direct root. */
function resolveRoot(store, explicitRoot) {
  const requested = text(explicitRoot);
  if (requested.length > 0) return resolve(requested);
  const direct = text(store?.root);
  if (direct.length > 0) return resolve(direct);
  const file = text(store?.file);
  if (file.length > 0) return dirname(dirname(resolve(file)));
  return '';
}

function audioExists(path) {
  if (path.length === 0) return false;
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** A readable audio file's bytes, or an explainable failure that never names the path. */
function readAudioFile(path, id) {
  if (path.length === 0) return { ok: false, reason: 'audio-missing', id };
  let info;
  try {
    info = statSync(path);
  } catch (error) {
    return {
      ok: false,
      reason: error?.code === 'ENOENT' || error?.code === 'ENOTDIR'
        ? 'audio-missing'
        : 'audio-unreadable',
      id,
    };
  }
  if (!info.isFile()) return { ok: false, reason: 'audio-missing', id };
  if (info.size > SPEAKER_CANDIDATE_MAX_AUDIO_BYTES) {
    return {
      ok: false,
      reason: 'audio-too-large',
      id,
      bytes: info.size,
      maxBytes: SPEAKER_CANDIDATE_MAX_AUDIO_BYTES,
    };
  }
  let bytes;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    return {
      ok: false,
      reason: error?.code === 'ENOENT' || error?.code === 'ENOTDIR'
        ? 'audio-missing'
        : 'audio-unreadable',
      id,
    };
  }
  // A file that grew between stat and read is still refused rather than truncated.
  if (bytes.length > SPEAKER_CANDIDATE_MAX_AUDIO_BYTES) {
    return {
      ok: false,
      reason: 'audio-too-large',
      id,
      bytes: bytes.length,
      maxBytes: SPEAKER_CANDIDATE_MAX_AUDIO_BYTES,
    };
  }
  return { ok: true, mime: 'audio/wav', base64: bytes.toString('base64'), bytes: bytes.length };
}

/**
 * Create the safe candidate action set for one store.
 *
 * @param {object} options
 * @param {{file?: string, root?: string, list: Function, remove: Function, clear: Function}} options.store
 *   the candidate cache (or a compatible test double).
 * @param {Function} [options.buildTemplate] defaults to `buildSpeakerTemplate`.
 * @param {string} [options.root] explicit store root for relative `audioPath`s; otherwise derived
 *   from `store.root` or `<dirname(dirname(store.file))>`.
 * @returns {Readonly<{list: Function, audio: Function, remove: Function, clear: Function,
 *   preview: Function}>}
 */
export function createSpeakerCandidateActions({
  store,
  buildTemplate = buildSpeakerTemplate,
  root = '',
} = {}) {
  if (!plainObject(store)) throw new TypeError('speaker candidate actions: store is required');
  for (const method of ['list', 'remove', 'clear']) {
    if (typeof store[method] !== 'function') {
      throw new TypeError(`speaker candidate actions: store.${method} must be a function`);
    }
  }
  if (typeof buildTemplate !== 'function') {
    throw new TypeError('speaker candidate actions: buildTemplate must be a function');
  }
  const rootPath = resolveRoot(store, root);

  const readCandidates = () => {
    try {
      const candidates = store.list();
      return Array.isArray(candidates) ? { ok: true, candidates } : { ok: false, reason: 'store-failed' };
    } catch {
      return { ok: false, reason: 'store-failed' };
    }
  };

  /** Safe metadata for every live candidate; audio availability is a stat only. */
  const list = () => {
    const read = readCandidates();
    if (read.ok !== true) return read;
    const candidates = read.candidates.map((candidate) => candidateView(
      candidate,
      audioExists(resolveAudioPath(candidate, rootPath)),
    ));
    return { ok: true, count: candidates.length, candidates };
  };

  /** One candidate's WAV as base64, capped at 1 MiB. */
  const audio = (id) => {
    const prepared = prepareId(id);
    if (prepared.ok !== true) return prepared;
    const read = readCandidates();
    if (read.ok !== true) return read;
    const candidate = read.candidates.find((entry) => text(entry?.id) === prepared.id);
    if (candidate === undefined) return { ok: false, reason: 'not-found', id: prepared.id };
    const path = resolveAudioPath(candidate, rootPath);
    return readAudioFile(path, prepared.id);
  };

  /** Remove one candidate; the store owns metadata + audio deletion. */
  const remove = (id) => {
    const prepared = prepareId(id);
    if (prepared.ok !== true) return prepared;
    let result;
    try {
      result = store.remove(prepared.id);
    } catch {
      return { ok: false, reason: 'store-failed' };
    }
    if (result?.ok !== true) {
      return {
        ok: false,
        reason: typeof result?.reason === 'string' && result.reason.length > 0
          ? result.reason
          : 'remove-failed',
      };
    }
    return {
      ok: true,
      id: prepared.id,
      removed: 1,
      audioDeleted: result.audioDeleted === true,
      audioFailed: result.audioFailed === true,
    };
  };

  /** Remove every candidate; the store owns metadata + audio deletion. */
  const clear = () => {
    let result;
    try {
      result = store.clear();
    } catch {
      return { ok: false, reason: 'store-failed' };
    }
    if (result?.ok !== true) {
      return {
        ok: false,
        reason: typeof result?.reason === 'string' && result.reason.length > 0
          ? result.reason
          : 'clear-failed',
      };
    }
    return {
      ok: true,
      removed: positiveInteger(result.removed),
      audioDeleted: positiveInteger(result.audioDeleted),
      audioFailed: positiveInteger(result.audioFailed),
    };
  };

  /**
   * Consistency/template preview for a caller-selected candidate set. Decodes embeddings only in
   * this closure and hands `buildTemplate` fresh Float32Arrays; the result omits the vector unless
   * `includeVector:true`. No library/state write happens on success or failure.
   */
  const preview = (ids, options = {}) => {
    const prepared = prepareIds(ids);
    if (prepared.ok !== true) return prepared;
    const read = readCandidates();
    if (read.ok !== true) return read;

    const byId = new Map();
    for (const entry of read.candidates) {
      const id = text(entry?.id);
      if (id.length > 0 && !byId.has(id)) byId.set(id, entry);
    }

    const selected = [];
    let totalDurationMs = 0;
    for (const id of prepared.ids) {
      const candidate = byId.get(id);
      if (candidate === undefined) return { ok: false, reason: 'candidate-not-found', id };
      const encoded = text(candidate.embedding);
      if (encoded.length === 0) return { ok: false, reason: 'missing-embedding', id };
      const embedding = decodeEmbedding(encoded);
      if (embedding === null) return { ok: false, reason: 'invalid-embedding', id };
      const durationMs = Math.round(Number(candidate.durationMs));
      selected.push({ id, embedding, durationMs });
      totalDurationMs += Number.isFinite(durationMs) ? durationMs : 0;
    }
    if (selected.length === 0) return { ok: false, reason: 'no-ids' };
    const dimension = selected[0].embedding.length;
    const settings = plainObject(options) ? options : {};
    const templateOptions = {};
    if (settings.threshold !== undefined) templateOptions.threshold = settings.threshold;

    let built;
    try {
      built = buildTemplate(selected, templateOptions);
    } catch {
      return { ok: false, reason: 'template-failed' };
    }
    if (built?.ok !== true) {
      const failure = {
        ok: false,
        reason: typeof built?.reason === 'string' && built.reason.length > 0
          ? built.reason
          : 'template-failed',
        sampleCount: selected.length,
        totalDurationMs,
        dimension,
      };
      if (Number.isFinite(Number(built?.minPairCosine))) {
        failure.minPairCosine = Number(built.minPairCosine);
      }
      if (Array.isArray(built?.outlierIds)) {
        failure.outlierIds = built.outlierIds.filter((id) => typeof id === 'string');
      }
      return failure;
    }

    const sampleCount = Number.isFinite(Number(built.sampleCount))
      ? Math.max(0, Math.floor(Number(built.sampleCount)))
      : selected.length;
    const builtDuration = Number(built.totalDurationMs);
    const minPairCosine = Number(built.minPairCosine);
    const result = {
      ok: true,
      sampleCount,
      totalDurationMs: Number.isFinite(builtDuration) ? builtDuration : totalDurationMs,
      minPairCosine: Number.isFinite(minPairCosine) ? minPairCosine : 1,
      confidence: built.confidence === 'low-sample' ? 'low-sample' : 'ok',
      dimension,
    };
    if (settings.includeVector === true) {
      const vector = built.vector;
      if (vector instanceof Float32Array || Array.isArray(vector)) {
        const values = Array.from(vector);
        if (values.length === dimension && values.every((value) => Number.isFinite(value))) {
          result.vector = values;
        }
      }
    }
    return result;
  };

  return Object.freeze({ list, audio, remove, clear, preview });
}
