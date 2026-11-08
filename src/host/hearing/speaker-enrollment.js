/**
 * Speaker enrollment — stage 1: the file-backed enrollment state (pure module).
 *
 * The user's fixed rules (2026-11-08):
 *   - samples are collected and previewed first; a voice is enrolled only after the user's own
 *     explicit confirm;
 *   - an entry with too little audio cannot be confirmed (`insufficient-samples`);
 *   - the module never recognises a speaker, never downloads a model and never decides an
 *     identity: it only records what the user enrolled and what the caller measured;
 *   - it is deliberately NOT wired to rejecting speech, muting or interrupting. No caller-side
 *     enforcement exists here, and no historical transcript is claimed retroactively.
 *
 * The later shadow verification (self / other / short utterance / quiet voice / video bleed /
 * assistant echo, keeping match / mismatch / unsure) consumes this state; "unsure" stays
 * unconfirmed. That judgement is not part of this module.
 *
 * File: `<root>/data/speaker-enrollment.json`; `root` is passed in, never inferred.
 *
 *   {
 *     version: 1,
 *     selfId: '' | string,             // the first explicitly confirmed speaker
 *     updatedAt: '' | ISO instant,     // stamped by every successful write
 *     entries: [{
 *       speakerId, label, status: 'pending'|'confirmed'|'rejected',
 *       samples: [{
 *         id, durationMs, at, source: 'mic'|'loopback',
 *         sampleId?: string,           // caller's source clip id (`sampleRef`)
 *         embeddingRef?: string        // optional caller-owned embedding reference
 *       }],
 *       createdAt, confirmedAt: null|string, modelVersion
 *     }]
 *   }
 *
 * Read is tolerant: a missing file yields a fresh default state (reading never creates it); bad
 * JSON, a bad version or a bad top-level/entry structure yields a fresh default state plus one
 * `speaker.enroll.corrupt {file, error}` event. Identical corrupt bytes are reported once, and a
 * successful read or write resets that guard. Write is atomic (temp file in the same directory +
 * rename); a failed rename removes the temp file, so a reader never observes a half-written file.
 * The store is synchronous and re-reads the file on every call, so two instances over one root
 * agree (restart safety) and there is no cache to invalidate.
 *
 * Sample de-duplication is per speakerId: a sample with a caller reference is the same sample when
 * that reference repeats; a sample without a reference is the same sample when its timestamp
 * repeats. State-changing calls return `{ok:true, ...}` or `{ok:false, reason}`; only `write()`
 * throws (on a malformed state or a filesystem failure), because it is the low-level primitive.
 *
 * Debug events: `speaker.enroll.sample`, `speaker.enroll.confirmed`, `speaker.enroll.rejected`,
 * `speaker.enroll.removed` (all payloads are data only, never an identity decision).
 */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** The path inside the caller-provided root. */
export const SPEAKER_ENROLLMENT_PATH = join('data', 'speaker-enrollment.json');

/** Persisted schema version. */
export const SPEAKER_ENROLLMENT_VERSION = 1;

/** The total sample duration required before the user's confirm can succeed. */
export const MIN_CONFIRM_TOTAL_MS = 3000;

/** Entry statuses. `pending` is the only state that accepts new samples. */
export const ENROLLMENT_STATUS = Object.freeze({
  PENDING: 'pending',
  CONFIRMED: 'confirmed',
  REJECTED: 'rejected',
});

/** Allowed capture sources; `loopback` records system/video bleed, never a self sample by itself. */
export const SAMPLE_SOURCES = Object.freeze(['mic', 'loopback']);

const STATUS_VALUES = new Set(Object.values(ENROLLMENT_STATUS));
const SOURCE_VALUES = new Set(SAMPLE_SOURCES);

/** Monotonic temp-file suffix, so two stores in one process never share a temp path. */
let writeTmpSeq = 0;

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A trimmed string or ''. */
function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** A non-negative whole millisecond duration, or null when the input is unusable. */
function durationOf(value) {
  const number = typeof value === 'number' ? value : (typeof value === 'string' ? Number(value) : Number.NaN);
  if (!Number.isFinite(number) || number <= 0) return null;
  return Math.round(number);
}

/** One ISO instant from an explicit value, falling back to the clock for an unusable value. */
function instantOf(value, fallback) {
  if (value instanceof Date) {
    const ms = value.getTime();
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value === 'string' && value.trim().length > 0) {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  return fallback;
}

/** One ISO instant from the injected clock, falling back to the wall clock when it misbehaves. */
function clockInstant(clock) {
  try {
    return instantOf(clock(), new Date().toISOString());
  } catch {
    return new Date().toISOString();
  }
}

/** A JSON-safe deep copy, so callers never receive a mutable view of the store's own objects. */
function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/** Fresh default state. Reading a missing file returns this and creates nothing. */
export function createSpeakerEnrollmentState() {
  return { version: SPEAKER_ENROLLMENT_VERSION, selfId: '', updatedAt: '', entries: [] };
}

/** A stored sample, or null when its required fields are unusable. */
function normalizeStoredSample(raw) {
  if (!plainObject(raw)) return null;
  const id = text(raw.id);
  const durationMs = durationOf(raw.durationMs);
  const at = text(raw.at);
  const source = text(raw.source);
  if (id.length === 0 || durationMs === null || at.length === 0 || !SOURCE_VALUES.has(source)) return null;
  const sample = { id, durationMs, at, source };
  const sampleId = text(raw.sampleId);
  const embeddingRef = text(raw.embeddingRef);
  if (sampleId.length > 0) sample.sampleId = sampleId;
  if (embeddingRef.length > 0) sample.embeddingRef = embeddingRef;
  return sample;
}

/** A stored entry, or null when required fields are unusable. Optional fields get defaults. */
function normalizeStoredEntry(raw) {
  if (!plainObject(raw)) return null;
  const speakerId = text(raw.speakerId);
  const status = text(raw.status);
  if (speakerId.length === 0 || !STATUS_VALUES.has(status)) return null;
  if (!Array.isArray(raw.samples)) return null;
  const samples = [];
  const seenIds = new Set();
  for (const rawSample of raw.samples) {
    const sample = normalizeStoredSample(rawSample);
    if (sample === null || seenIds.has(sample.id)) return null;
    seenIds.add(sample.id);
    samples.push(sample);
  }
  return {
    speakerId,
    label: text(raw.label),
    status,
    samples,
    createdAt: text(raw.createdAt),
    confirmedAt: typeof raw.confirmedAt === 'string' && raw.confirmedAt.length > 0 ? raw.confirmedAt : null,
    modelVersion: text(raw.modelVersion),
  };
}

/**
 * Strict persisted-shape check. `null` means "this is not a version-1 enrollment file", which
 * makes `read()` fall back to the default and record `speaker.enroll.corrupt`.
 */
function normalizeStoredState(raw) {
  if (!plainObject(raw)) return null;
  if (raw.version !== SPEAKER_ENROLLMENT_VERSION) return null;
  if (!Array.isArray(raw.entries)) return null;
  const entries = [];
  const seenSpeakers = new Set();
  for (const rawEntry of raw.entries) {
    const entry = normalizeStoredEntry(rawEntry);
    if (entry === null || seenSpeakers.has(entry.speakerId)) return null;
    seenSpeakers.add(entry.speakerId);
    entries.push(entry);
  }
  return {
    version: SPEAKER_ENROLLMENT_VERSION,
    selfId: text(raw.selfId),
    updatedAt: text(raw.updatedAt),
    entries,
  };
}

/** The entry for one speakerId, or undefined. */
function entryOf(state, speakerId) {
  return state.entries.find((entry) => entry.speakerId === speakerId);
}

/** Find a sample matching either the generated id or the caller's reference. */
function sampleOf(entry, sampleId) {
  return entry.samples.find((sample) => sample.id === sampleId
    || sample.sampleId === sampleId
    || sample.embeddingRef === sampleId);
}

/**
 * Duplicate detection for one speaker. With a reference the reference is the identity (so the same
 * clip added twice is skipped); without one the timestamp is the identity. Different references at
 * the same timestamp are distinct samples.
 */
function duplicateOf(entry, sampleRef, at) {
  if (sampleRef.length > 0) {
    return entry.samples.find((sample) => sample.sampleId === sampleRef
      || sample.embeddingRef === sampleRef) ?? null;
  }
  return entry.samples.find((sample) => sample.at === at) ?? null;
}

/** Allocate the next `smp-N` id inside one entry without relying on a persisted counter. */
function nextSampleId(samples) {
  let highest = 0;
  for (const sample of samples) {
    const match = /^smp-(\d+)$/u.exec(sample.id);
    if (match !== null) highest = Math.max(highest, Number(match[1]));
  }
  return `smp-${highest + 1}`;
}

/** Validate and normalize one sample input; no state is touched. */
function prepareSample(raw, fallbackAt) {
  const options = plainObject(raw) ? raw : {};
  const durationMs = durationOf(options.durationMs);
  if (durationMs === null) return { ok: false, reason: 'invalid-duration' };
  const source = text(options.source).length > 0 ? text(options.source) : 'mic';
  if (!SOURCE_VALUES.has(source)) return { ok: false, reason: 'invalid-source' };
  const sampleRef = text(options.sampleRef) || text(options.sampleId);
  const embeddingRef = text(options.embeddingRef);
  const at = instantOf(options.at, fallbackAt);
  return { ok: true, durationMs, source, sampleRef, embeddingRef, at };
}

/** Append one prepared sample to an entry and return the stored row. */
function appendSample(entry, prepared) {
  const sample = {
    id: nextSampleId(entry.samples),
    durationMs: prepared.durationMs,
    at: prepared.at,
    source: prepared.source,
  };
  if (prepared.sampleRef.length > 0) sample.sampleId = prepared.sampleRef;
  if (prepared.embeddingRef.length > 0) sample.embeddingRef = prepared.embeddingRef;
  entry.samples.push(sample);
  return sample;
}

/** Summary used by stats() and confirm(). */
function sampleSummary(samples) {
  const sources = { mic: 0, loopback: 0 };
  let totalDurationMs = 0;
  for (const sample of samples) {
    totalDurationMs += sample.durationMs;
    if (sample.source in sources) sources[sample.source] += 1;
  }
  return { sampleCount: samples.length, totalDurationMs, sources };
}

/**
 * Create the file-backed speaker-enrollment store for one root.
 *
 * @param {object} options
 * @param {string} options.root the caller-owned root; the file is `<root>/data/speaker-enrollment.json`.
 * @param {() => (Date|number|string)} [options.clock] injected time source.
 * @param {{emit?: (event: string, payload: object) => unknown}|null} [options.log] debug sink; only
 *   the `speaker.enroll.*` events documented at the top are emitted.
 * @returns {Readonly<object>} the store API described in the module header.
 */
export function createSpeakerEnrollmentStore({ root, clock = () => new Date(), log = null } = {}) {
  if (typeof root !== 'string' || root.trim().length === 0) {
    throw new TypeError('speaker enrollment: root is required');
  }
  if (typeof clock !== 'function') {
    throw new TypeError('speaker enrollment: clock must be a function');
  }
  const file = join(root, SPEAKER_ENROLLMENT_PATH);
  let lastCorruption = '';

  const emit = (event, payload) => {
    // Debug logging must never change what the store does, so errors and rejections are swallowed.
    try {
      void log?.emit?.(event, payload)?.catch?.(() => {});
    } catch {
      /* ignore a throwing or absent logger */
    }
  };

  const corrupt = (error, rawText = '') => {
    const message = error?.message ?? String(error);
    const signature = `${message}\u0000${rawText}`;
    if (signature === lastCorruption) return;
    lastCorruption = signature;
    emit('speaker.enroll.corrupt', { file, error: message });
  };

  /** Read the file. Missing → fresh default; unreadable/malformed → fresh default + corrupt event. */
  const read = () => {
    let rawText;
    try {
      rawText = readFileSync(file, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') corrupt(error);
      return createSpeakerEnrollmentState();
    }
    try {
      const state = normalizeStoredState(JSON.parse(rawText));
      if (state === null) throw new TypeError('不是有效的声纹登记 v1 文件');
      lastCorruption = '';
      return clone(state);
    } catch (error) {
      corrupt(error, rawText);
      return createSpeakerEnrollmentState();
    }
  };

  /** Atomic write without an event; mutators emit their own operation event afterwards. */
  const save = (state) => {
    const normalized = normalizeStoredState(state);
    if (normalized === null) {
      throw new TypeError('speaker enrollment: refusing to write a malformed state');
    }
    normalized.updatedAt = clockInstant(clock);
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
   * Public low-level write. Validates, stamps `updatedAt` and writes atomically. A failure throws
   * and leaves the previous file byte-identical.
   *
   * @param {object} state a complete version-1 state
   * @returns {object} the normalized state that was written
   */
  const write = (state) => save(state);

  /**
   * Add one pending sample for a speaker. This NEVER confirms an identity; a new entry starts
   * `pending`. A rejected or already-confirmed entry refuses new samples so a user's decision is
   * not silently overwritten.
   *
   * @param {{speakerId: string, label?: string, durationMs: number, source?: 'mic'|'loopback',
   *   sampleRef?: string, sampleId?: string, embeddingRef?: string, at?: string,
   *   modelVersion?: string}} options
   * @returns {{ok: true, added: boolean, sample?: object, duplicate?: boolean, reason?: string}
   *   | {ok: false, reason: string}}
   */
  const beginSample = ({
    speakerId,
    label = '',
    durationMs,
    source = 'mic',
    sampleRef = '',
    sampleId = '',
    embeddingRef = '',
    at = undefined,
    modelVersion = '',
  } = {}) => {
    const id = text(speakerId);
    if (id.length === 0) return { ok: false, reason: 'speaker-required' };
    const prepared = prepareSample({ durationMs, source, sampleRef, sampleId, embeddingRef, at }, clockInstant(clock));
    if (prepared.ok !== true) return prepared;

    const state = read();
    let entry = entryOf(state, id);
    if (entry?.status === ENROLLMENT_STATUS.REJECTED) return { ok: false, reason: 'rejected' };
    if (entry?.status === ENROLLMENT_STATUS.CONFIRMED) return { ok: false, reason: 'already-confirmed' };
    if (entry !== undefined) {
      const duplicate = duplicateOf(entry, prepared.sampleRef, prepared.at);
      if (duplicate !== null) {
        return { ok: true, added: false, duplicate: true, reason: 'duplicate-sample', sample: clone(duplicate) };
      }
    }
    if (entry === undefined) {
      entry = {
        speakerId: id,
        label: text(label).length > 0 ? text(label) : id,
        status: ENROLLMENT_STATUS.PENDING,
        samples: [],
        createdAt: prepared.at,
        confirmedAt: null,
        modelVersion: text(modelVersion),
      };
      state.entries.push(entry);
    }
    const sample = appendSample(entry, prepared);
    save(state);
    emit('speaker.enroll.sample', {
      speakerId: id,
      sampleId: sample.id,
      durationMs: sample.durationMs,
      source: sample.source,
    });
    return { ok: true, added: true, duplicate: false, sample: clone(sample) };
  };

  /**
   * Add a batch of pending samples for one speaker with a single write. Invalid rows are skipped
   * and reported in the counts; they never block the valid rows.
   *
   * @param {{speakerId: string, samples?: object[]}} [options]
   * @returns {{ok: true, speakerId: string, added: number, skipped: number, duplicates: number,
   *   invalid: number, samples: object[]}|{ok: false, reason: string, added?: number,
   *   skipped?: number}}
   */
  const mergeSamples = ({ speakerId, samples = [] } = {}) => {
    const id = text(speakerId);
    if (id.length === 0) return { ok: false, reason: 'speaker-required', added: 0, skipped: 0 };
    if (!Array.isArray(samples)) return { ok: false, reason: 'invalid-samples', added: 0, skipped: 0 };
    const state = read();
    let entry = entryOf(state, id);
    if (entry?.status === ENROLLMENT_STATUS.REJECTED) {
      return { ok: false, reason: 'rejected', added: 0, skipped: samples.length };
    }
    if (entry?.status === ENROLLMENT_STATUS.CONFIRMED) {
      return { ok: false, reason: 'already-confirmed', added: 0, skipped: samples.length };
    }
    const fallbackAt = clockInstant(clock);
    const added = [];
    let duplicates = 0;
    let invalid = 0;
    for (const raw of samples) {
      const prepared = prepareSample(raw, fallbackAt);
      if (prepared.ok !== true) {
        invalid += 1;
        continue;
      }
      if (entry !== undefined && duplicateOf(entry, prepared.sampleRef, prepared.at) !== null) {
        duplicates += 1;
        continue;
      }
      if (entry === undefined) {
        const options = plainObject(raw) ? raw : {};
        entry = {
          speakerId: id,
          label: text(options.label).length > 0 ? text(options.label) : id,
          status: ENROLLMENT_STATUS.PENDING,
          samples: [],
          createdAt: fallbackAt,
          confirmedAt: null,
          modelVersion: text(options.modelVersion),
        };
        state.entries.push(entry);
      }
      added.push(appendSample(entry, prepared));
    }
    if (added.length > 0) {
      save(state);
      for (const sample of added) {
        emit('speaker.enroll.sample', {
          speakerId: id,
          sampleId: sample.id,
          durationMs: sample.durationMs,
          source: sample.source,
        });
      }
    }
    return {
      ok: true,
      speakerId: id,
      added: added.length,
      skipped: duplicates + invalid,
      duplicates,
      invalid,
      samples: clone(added),
    };
  };

  /**
   * The user's explicit confirmation. This is the ONLY path that sets `status:'confirmed'`.
   * It refuses a speaker with no entry, a rejected entry and an entry whose sample total is below
   * `MIN_CONFIRM_TOTAL_MS`. The first confirmed speaker becomes `selfId`; later confirmations do
   * not silently replace an already-confirmed self.
   *
   * @param {{speakerId: string}} [options]
   * @returns {{ok: true, entry: object, totalDurationMs: number}
   *   | {ok: false, reason: string, sampleCount?: number, totalDurationMs?: number,
   *   requiredMs?: number}}
   */
  const confirm = ({ speakerId } = {}) => {
    const id = text(speakerId);
    if (id.length === 0) return { ok: false, reason: 'speaker-required' };
    const state = read();
    const entry = entryOf(state, id);
    if (entry === undefined) return { ok: false, reason: 'not-found' };
    if (entry.status === ENROLLMENT_STATUS.REJECTED) return { ok: false, reason: 'rejected' };
    const summary = sampleSummary(entry.samples);
    if (summary.totalDurationMs < MIN_CONFIRM_TOTAL_MS) {
      return {
        ok: false,
        reason: 'insufficient-samples',
        sampleCount: summary.sampleCount,
        totalDurationMs: summary.totalDurationMs,
        requiredMs: MIN_CONFIRM_TOTAL_MS,
      };
    }
    entry.status = ENROLLMENT_STATUS.CONFIRMED;
    entry.confirmedAt = clockInstant(clock);
    const currentSelf = state.selfId.length > 0 ? entryOf(state, state.selfId) : undefined;
    if (state.selfId.length === 0 || currentSelf?.status !== ENROLLMENT_STATUS.CONFIRMED) {
      state.selfId = id;
    }
    save(state);
    emit('speaker.enroll.confirmed', {
      speakerId: id,
      sampleCount: summary.sampleCount,
      totalDurationMs: summary.totalDurationMs,
    });
    return { ok: true, entry: clone(entry), totalDurationMs: summary.totalDurationMs };
  };

  /**
   * The user's explicit rejection. The entry stays on disk as a tombstone (with its samples) so a
   * later sample batch cannot silently revive it, and it is removed from the confirmed view.
   * Rejecting the current self clears `selfId`.
   *
   * @param {{speakerId: string}} [options]
   * @returns {{ok: true, entry: object}|{ok: false, reason: string}}
   */
  const reject = ({ speakerId } = {}) => {
    const id = text(speakerId);
    if (id.length === 0) return { ok: false, reason: 'speaker-required' };
    const state = read();
    const entry = entryOf(state, id);
    if (entry === undefined) return { ok: false, reason: 'not-found' };
    entry.status = ENROLLMENT_STATUS.REJECTED;
    entry.confirmedAt = null;
    if (state.selfId === id) state.selfId = '';
    save(state);
    emit('speaker.enroll.rejected', { speakerId: id });
    return { ok: true, entry: clone(entry) };
  };

  /**
   * Delete one sample from one speaker. The entry (and its status) stays; deleting the last sample
   * leaves an empty pending entry, which `removeEntry` can delete entirely. A confirmed voice keeps
   * its status when a sample reference is pruned — use `reject()` to revoke it. The sampleId may be
   * the generated `sample.id`, the caller's `sampleRef` or the `embeddingRef`.
   *
   * @param {{speakerId: string, sampleId: string}} [options]
   * @returns {{ok: true, sample: object, entry: object}|{ok: false, reason: string}}
   */
  const removeSample = ({ speakerId, sampleId } = {}) => {
    const id = text(speakerId);
    const wanted = text(sampleId);
    if (id.length === 0) return { ok: false, reason: 'speaker-required' };
    if (wanted.length === 0) return { ok: false, reason: 'sample-required' };
    const state = read();
    const entry = entryOf(state, id);
    if (entry === undefined) return { ok: false, reason: 'not-found' };
    const sample = sampleOf(entry, wanted);
    if (sample === undefined) return { ok: false, reason: 'sample-not-found' };
    entry.samples = entry.samples.filter((item) => item !== sample);
    save(state);
    emit('speaker.enroll.removed', { speakerId: id, kind: 'sample', sampleId: sample.id });
    return { ok: true, sample: clone(sample), entry: clone(entry) };
  };

  /**
   * Delete one whole entry, including its samples. If it was the confirmed self, `selfId` is
   * cleared so `getConfirmedSelf()` cannot return a deleted identity.
   *
   * @param {{speakerId: string}} [options]
   * @returns {{ok: true, entry: object}|{ok: false, reason: string}}
   */
  const removeEntry = ({ speakerId } = {}) => {
    const id = text(speakerId);
    if (id.length === 0) return { ok: false, reason: 'speaker-required' };
    const state = read();
    const entry = entryOf(state, id);
    if (entry === undefined) return { ok: false, reason: 'not-found' };
    state.entries = state.entries.filter((item) => item !== entry);
    if (state.selfId === id) state.selfId = '';
    save(state);
    emit('speaker.enroll.removed', { speakerId: id, kind: 'entry' });
    return { ok: true, entry: clone(entry) };
  };

  /**
   * Entries, optionally filtered by status, sorted by creation time then speakerId. A rejected row
   * is a persisted tombstone but never appears by default: it is visible only through the explicit
   * `{status:'rejected'}` data view, and never as a confirmed identity.
   *
   * @param {{status?: 'pending'|'confirmed'|'rejected'}} [options]
   * @returns {object[]}
   */
  const list = ({ status } = {}) => {
    const state = read();
    let entries = state.entries;
    if (status === undefined || status === null) {
      entries = entries.filter((entry) => entry.status !== ENROLLMENT_STATUS.REJECTED);
    } else {
      const wanted = text(status);
      if (!STATUS_VALUES.has(wanted)) return [];
      entries = entries.filter((entry) => entry.status === wanted);
    }
    return clone(entries).sort((left, right) => {
      if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? -1 : 1;
      if (left.speakerId === right.speakerId) return 0;
      return left.speakerId < right.speakerId ? -1 : 1;
    });
  };

  /**
   * The confirmed self entry, or null. It returns data only: an "unsure" or unconfirmed speaker is
   * never promoted here, and no transcript is claimed retroactively.
   *
   * @returns {object|null}
   */
  const getConfirmedSelf = () => {
    const state = read();
    if (state.selfId.length === 0) return null;
    const entry = entryOf(state, state.selfId);
    if (entry === undefined || entry.status !== ENROLLMENT_STATUS.CONFIRMED) return null;
    return clone(entry);
  };

  /**
   * Sample count, total duration and source distribution for one speaker. An unknown speaker
   * returns zeroed counts with `found:false` instead of throwing.
   *
   * @param {{speakerId: string}} [options]
   * @returns {{speakerId: string, found: boolean, label: string, status: string|null,
   *   sampleCount: number, totalDurationMs: number, sources: {mic: number, loopback: number}}}
   */
  const stats = ({ speakerId } = {}) => {
    const id = text(speakerId);
    const state = read();
    const entry = id.length > 0 ? entryOf(state, id) : undefined;
    if (entry === undefined) {
      return {
        speakerId: id,
        found: false,
        label: '',
        status: null,
        sampleCount: 0,
        totalDurationMs: 0,
        sources: { mic: 0, loopback: 0 },
      };
    }
    return {
      speakerId: entry.speakerId,
      found: true,
      label: entry.label,
      status: entry.status,
      ...sampleSummary(entry.samples),
    };
  };

  return Object.freeze({
    file,
    read,
    write,
    beginSample,
    mergeSamples,
    confirm,
    reject,
    removeSample,
    removeEntry,
    list,
    getConfirmedSelf,
    stats,
  });
}
