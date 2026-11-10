/**
 * Speaker template version store — the one persisted home of the voiceprint version chain.
 *
 * This is deliberately a small, host-only file store above `speaker-template-version.js`:
 *   - the version module decides *what* a new version is (consistency, similarity, blend, bound);
 *   - this store only carries that pure state to disk and back, so restarting the Host does not
 *     forget the chain;
 *   - it never scores, merges, selects or accepts a speaker. It has no clock of its own for
 *     version records and never invents `createdAt`; only `updatedAt` is stamped here.
 *
 * File: `<root>/data/speaker-template-versions.json`; `root` is passed in, never inferred.
 *
 *   {
 *     version: 1,                         // persisted schema version
 *     updatedAt: '' | ISO instant,         // stamped by every successful write
 *     lastVersion: 0 | positive integer,   // highest version number ever issued
 *     currentVersion: null | positive integer,
 *     versions: [{
 *       version,                           // 1..lastVersion, unique, ascending on disk
 *       vector: '<base64>',                // little-endian Float32, canonical base64
 *       sampleCount,                       // accumulated evidence behind this version
 *       totalDurationMs,
 *       createdAt: null | number | string,
 *       reason: 'initial' | 'strengthen' | 'manual' | string,
 *       parentVersion: null | positive integer
 *     }]
 *   }
 *
 * Reading is tolerant: a missing file is an empty version state (and creates nothing); bad JSON,
 * a wrong schema version, a duplicate version, a broken vector or a `currentVersion` that does not
 * exist all yield the empty state plus one `speaker.template.corrupt {file, error}` event. The
 * event is de-duplicated for identical corrupt bytes and reset by a successful read or write.
 *
 * Writing is atomic (temp file in the same directory + rename); a failed write removes the temp
 * file, so a reader never observes a half-written chain. Writes are validated before touching the
 * filesystem, so a malformed state is refused instead of silently dropping records. The store
 * re-reads the file on every `read()`, so two callers over one root agree after a restart.
 *
 * Vectors are persisted as base64 rather than a JSON number array: the chain is bounded at 20
 * records, but each embedding can be hundreds of floats, and base64 keeps the file small without
 * changing the vector type the version module consumes (a fresh Float32Array). Number arrays in an
 * older/hand-written file are accepted on read and rewritten as base64 on the next write.
 */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { decodeEmbedding, encodeEmbedding } from './speaker-candidates.js';
import { createVersion } from './speaker-template-version.js';

/** The path inside the caller-provided root. */
export const SPEAKER_TEMPLATE_VERSIONS_PATH = join('data', 'speaker-template-versions.json');

/** Persisted schema version. */
export const SPEAKER_TEMPLATE_STORE_VERSION = 1;

/** Monotonic temp-file suffix, so two stores in one process never share a temp path. */
let writeTmpSeq = 0;

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && !ArrayBuffer.isView(value);
}

/** Fresh empty state. Reading a missing file returns this and creates nothing. */
export function createEmptySpeakerTemplateStoreState() {
  return { versions: [], currentVersion: null, lastVersion: 0 };
}

/** One ISO instant from the injected clock, falling back to the wall clock. */
function clockInstant(clock) {
  try {
    const value = clock();
    const date = value instanceof Date ? value : new Date(value);
    const ms = date.getTime();
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  } catch {
    /* fall through to the wall clock */
  }
  return new Date().toISOString();
}

/**
 * Validate one persisted record and turn it into the version module's record shape.
 * A string vector is decoded from canonical base64; a number array is accepted for older files.
 *
 * @returns {{ok: true, record: object}|{ok: false}}
 */
function decodeRecord(raw) {
  if (!plainObject(raw)) return { ok: false };
  let vector;
  if (typeof raw.vector === 'string') vector = decodeEmbedding(raw.vector);
  else if (Array.isArray(raw.vector)) vector = raw.vector;
  else return { ok: false };
  if (vector === null) return { ok: false };
  const normalized = createVersion({
    version: raw.version,
    vector,
    sampleCount: raw.sampleCount,
    totalDurationMs: raw.totalDurationMs,
    createdAt: raw.createdAt,
    reason: raw.reason,
    parentVersion: raw.parentVersion,
  });
  if (!normalized.ok) return { ok: false };
  return normalized;
}

/**
 * Parse and strictly validate a whole persisted state.
 *
 * @returns {object|null} fresh state with Float32Array vectors, or null when unusable.
 */
function decodeState(raw) {
  if (!plainObject(raw)) return null;
  if (raw.version !== SPEAKER_TEMPLATE_STORE_VERSION) return null;
  if (!Array.isArray(raw.versions)) return null;

  const records = [];
  const seen = new Set();
  for (const entry of raw.versions) {
    const decoded = decodeRecord(entry);
    if (!decoded.ok) return null;
    const record = decoded.record;
    if (seen.has(record.version)) return null;
    seen.add(record.version);
    records.push(record);
  }
  records.sort((left, right) => left.version - right.version);

  const rawCurrent = raw.currentVersion === undefined ? null : raw.currentVersion;
  if (records.length === 0) {
    if (rawCurrent !== null) return null;
    const lastVersion = raw.lastVersion === undefined ? 0 : raw.lastVersion;
    if (!Number.isSafeInteger(lastVersion) || lastVersion < 0) return null;
    return { versions: [], currentVersion: null, lastVersion };
  }

  if (!Number.isSafeInteger(rawCurrent) || !seen.has(rawCurrent)) return null;
  const highest = records[records.length - 1].version;
  const lastVersion = raw.lastVersion === undefined ? highest : raw.lastVersion;
  if (!Number.isSafeInteger(lastVersion) || lastVersion < highest) return null;
  return { versions: records, currentVersion: rawCurrent, lastVersion };
}

/**
 * Validate a state supplied by the version module before serializing it.
 * The records are copied by `createVersion()`, so the caller's state is never mutated.
 *
 * @returns {object|null} normalized state, or null when malformed.
 */
function validateState(raw) {
  if (raw === undefined || raw === null) return createEmptySpeakerTemplateStoreState();
  if (!plainObject(raw) || !Array.isArray(raw.versions)) return null;
  const records = [];
  const seen = new Set();
  for (const entry of raw.versions) {
    if (!plainObject(entry)) return null;
    const normalized = createVersion({
      version: entry.version,
      vector: entry.vector,
      sampleCount: entry.sampleCount,
      totalDurationMs: entry.totalDurationMs,
      createdAt: entry.createdAt,
      reason: entry.reason,
      parentVersion: entry.parentVersion,
    });
    if (!normalized.ok) return null;
    if (seen.has(normalized.record.version)) return null;
    seen.add(normalized.record.version);
    records.push(normalized.record);
  }
  records.sort((left, right) => left.version - right.version);

  if (records.length === 0) {
    const currentVersion = raw.currentVersion === undefined ? null : raw.currentVersion;
    if (currentVersion !== null) return null;
    const lastVersion = raw.lastVersion === undefined ? 0 : raw.lastVersion;
    if (!Number.isSafeInteger(lastVersion) || lastVersion < 0) return null;
    return { versions: [], currentVersion: null, lastVersion };
  }

  const currentVersion = raw.currentVersion;
  if (!Number.isSafeInteger(currentVersion) || !seen.has(currentVersion)) return null;
  const highest = records[records.length - 1].version;
  const lastVersion = raw.lastVersion === undefined ? highest : raw.lastVersion;
  if (!Number.isSafeInteger(lastVersion) || lastVersion < highest) return null;
  return { versions: records, currentVersion, lastVersion };
}

/**
 * Create the file-backed speaker-template version store for one root.
 *
 * @param {object} options
 * @param {string} options.root caller-owned root; the file is
 *   `<root>/data/speaker-template-versions.json`.
 * @param {() => (Date|number|string)} [options.clock] injected time source for `updatedAt`.
 * @param {{emit?: (event: string, payload: object) => unknown}|null} [options.log] diagnostic sink;
 *   only `speaker.template.corrupt` is emitted.
 * @returns {Readonly<{file: string, read: Function, write: Function}>}
 */
export function createSpeakerTemplateStore({ root, clock = () => new Date(), log = null } = {}) {
  if (typeof root !== 'string' || root.trim().length === 0) {
    throw new TypeError('speaker template store: root is required');
  }
  if (typeof clock !== 'function') {
    throw new TypeError('speaker template store: clock must be a function');
  }
  const file = join(root, SPEAKER_TEMPLATE_VERSIONS_PATH);
  let lastCorruption = '';

  const emit = (event, payload) => {
    try {
      void log?.emit?.(event, payload)?.catch?.(() => {});
    } catch {
      /* a diagnostic sink must never change the store's behavior */
    }
  };

  const corrupt = (error, rawText = '') => {
    const message = error?.message ?? String(error);
    const signature = `${message}\u0000${rawText}`;
    if (signature === lastCorruption) return;
    lastCorruption = signature;
    emit('speaker.template.corrupt', { file, error: message });
  };

  /** Read the current state. Missing → empty; malformed → empty + one corrupt event. */
  const read = () => {
    let rawText;
    try {
      rawText = readFileSync(file, 'utf8');
    } catch (error) {
      // A missing file is the normal first-run state, not corruption.
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') corrupt(error);
      return createEmptySpeakerTemplateStoreState();
    }
    try {
      const state = decodeState(JSON.parse(rawText));
      if (state === null) throw new TypeError('不是有效的声纹模板版本 v1 文件');
      lastCorruption = '';
      return state;
    } catch (error) {
      corrupt(error, rawText);
      return createEmptySpeakerTemplateStoreState();
    }
  };

  /**
   * Atomically persist a complete version state. The state is validated first; a malformed one
   * throws `TypeError` before any filesystem change. A failed write leaves the previous file
   * byte-identical and removes its temp file.
   *
   * @param {object} state version-module state
   * @returns {object} the normalized state that was written
   */
  const write = (state) => {
    const normalized = validateState(state);
    if (normalized === null) {
      throw new TypeError('speaker template store: refusing to write a malformed state');
    }
    const persisted = {
      version: SPEAKER_TEMPLATE_STORE_VERSION,
      updatedAt: clockInstant(clock),
      lastVersion: normalized.lastVersion,
      currentVersion: normalized.currentVersion,
      versions: normalized.versions.map((record) => ({
        version: record.version,
        vector: encodeEmbedding(record.vector),
        sampleCount: record.sampleCount,
        totalDurationMs: record.totalDurationMs,
        createdAt: record.createdAt,
        reason: record.reason,
        parentVersion: record.parentVersion,
      })),
    };
    if (persisted.versions.some((record) => record.vector === null)) {
      throw new TypeError('speaker template store: refusing to write an unencodable vector');
    }

    mkdirSync(dirname(file), { recursive: true });
    writeTmpSeq += 1;
    const temporary = `${file}.${process.pid}.${writeTmpSeq}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(persisted, null, 2)}\n`, 'utf8');
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

  return Object.freeze({ file, read, write });
}
