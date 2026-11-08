/**
 * Speaker-voice shadow — core layer (observation only; it never touches delivery).
 *
 * The assistant already knows "someone spoke"; this layer answers the weaker question "does this
 * utterance sound like a voice we have enrolled before?" using sherpa-onnx's pretrained speaker
 * embedding model. Nothing here filters, reorders, drops or reroutes a transcript: `match()` only
 * scores, `shadow()` only records, and a `mismatch`/`unsure` is evidence, never a verdict on the
 * turn. The host wiring (hearing → speaker.shadow) is deliberately NOT part of this layer yet.
 *
 * Stage 2 classification (shadow only): one row now also says WHAT kind of utterance produced the
 * verdict — `class` (self / other / unknown-identity), `quality` (ok / short / quiet / noisy) and
 * `source` (mic / loopback, i.e. echo or video bleed is a cue, not a verdict). The three-state
 * `decision` stays match / mismatch / unsure, and anything uncertain (a short or quiet clip, a low
 * score, or a best-vs-runner-up margin below `minMargin`) is `unsure` and `unknown-identity`.
 * Classification NEVER feeds a rejection, a mute, an interruption or a memory attribution, and it
 * never retroactively claims an earlier transcript: it only annotates the row it already owns.
 *
 * What is stored: one L2-normalized template vector per speaker plus bookkeeping (label, created
 * time, last match time, enrollment count, enabled flag). Raw audio is never written — the caller
 * hands over an already-computed embedding, and the embedder only reads PCM in memory.
 *
 * Storage follows the existing habit: SQLite via `node:sqlite`, one file per feature, under
 * `<root>/memory`. `store.js` exposes no reusable db factory (each store owns its connection), so
 * this follows `profileStore` instead: an already-open `DatabaseSync` may be injected, otherwise
 * `<root>/memory/speaker.db` is opened and owned by this module.
 *
 * Identity rule: a removed `speakerId` is NEVER reusable. `remove()` writes a tombstone in the same
 * transaction as the delete, and `register()` refuses a retired id, so a stale enrollment can never
 * be silently revived by a later write. Removing a template does not touch history — ownership of
 * past attribution stays with the upper layer.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { nowIso, resolveRoot } from '../memory/store.js';
import { SPEAKER_SHADOW_MIN_MS } from './audio-evidence.js';

const require = createRequire(import.meta.url);

/** The embedding models are trained for 16 kHz mono PCM; no resampling happens here. */
export const SPEAKER_SAMPLE_RATE = 16000;

/**
 * Match defaults.
 *
 * `threshold` is a cosine-similarity floor. 0.4 is the default of sherpa-onnx's own example
 * `python-api-examples/speaker-identification-with-vad-dynamic.py` (`--threshold`), i.e. the value
 * upstream uses when it decides an embedding belongs to a known speaker. It is NOT calibrated for
 * this machine, this microphone or this room — no real-device verification has been done — so it is
 * an empirical starting point and must stay configurable. `unsureMargin` is this layer's own
 * conservative band: a score inside `[threshold - unsureMargin, threshold)` is reported as `unsure`
 * instead of a false `mismatch`, so the shadow can show its uncertainty. `minMargin` is the second
 * half of the stage-2 guard: when the best template and the runner-up are closer than this, the
 * utterance is ambiguous between two enrolled voices and the row must say `unsure` rather than pick
 * one. All three are empirical; nothing below treats them as calibrated.
 */
export const SPEAKER_MATCH_DEFAULTS = Object.freeze({
  threshold: 0.4,
  unsureMargin: 0.08,
  minMargin: 0.05,
});

/**
 * Stage-2 quality defaults (shadow only; the row reports them, nothing gates on them).
 *
 * The measurement is deliberately the one the capture already made — duration, utterance RMS, peak
 * and a speech ratio — never a second analysis of the clip:
 *  - `minSpeechMs`: below the same 600 ms floor the shadow refuses to embed (`too-short`);
 *  - `quietRmsDb` / `quietPeakDb`: a clip at or below either level is too soft for a stable
 *    embedding (the capture gate itself starts at -50 dBFS, so this is the "audible but soft" edge);
 *  - `noisySpeechRatio`: below this share of the window being speech, noise/other audio dominates.
 * The numbers are an empirical starting point, like the match thresholds above.
 */
export const SPEAKER_QUALITY_DEFAULTS = Object.freeze({
  minSpeechMs: SPEAKER_SHADOW_MIN_MS,
  quietRmsDb: -42,
  quietPeakDb: -28,
  noisySpeechRatio: 0.35,
});

/** The closed stage-2 vocabulary; a row never invents a fourth value for these. */
export const SPEAKER_SHADOW_CLASSES = Object.freeze(['self', 'other', 'unknown-identity']);
export const SPEAKER_SHADOW_QUALITIES = Object.freeze(['ok', 'short', 'quiet', 'noisy']);
export const SPEAKER_SHADOW_SOURCES = Object.freeze(['mic', 'loopback']);

/**
 * Identity window default: 4 s, inside the 3–5 s the short-answer rule expects. A window is a
 * fixed snapshot; nothing about ambient noise or a later utterance may extend it (see
 * `identityWindow`).
 */
export const IDENTITY_WINDOW_MS = 4000;

/** Returned by `createSpeakerEmbedder` when the model file is absent (or unusable). */
export const SPEAKER_EMBEDDER_MISSING = null;

const emitSafely = (sink, type, payload) => {
  try {
    sink?.(type, payload);
  } catch {
    /* an event sink must never break the shadow */
  }
};

/** Normalize a caller-supplied speaker id; an empty id is invalid, never "anonymous". */
function normalizeSpeakerId(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** L2-normalized copy of an embedding, or null when the input cannot be a template. */
export function normalizeEmbedding(embedding) {
  if (!(embedding instanceof Float32Array) || embedding.length === 0) return null;
  let sum = 0;
  for (let index = 0; index < embedding.length; index += 1) {
    const value = embedding[index];
    if (!Number.isFinite(value)) return null;
    sum += value * value;
  }
  if (!(sum > 0)) return null;
  const scale = 1 / Math.sqrt(sum);
  const result = new Float32Array(embedding.length);
  for (let index = 0; index < embedding.length; index += 1) result[index] = embedding[index] * scale;
  return result;
}

/**
 * Cosine similarity in [-1, 1]. An unusable pair (null, empty, different dimensions) scores 0, the
 * neutral value, so a broken embedding can never look like a match.
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

/** Resolve `{threshold, unsureMargin, minMargin}` with the documented defaults; a bad value falls back. */
export function resolveMatchOptions({ threshold, unsureMargin, minMargin } = {}) {
  const floor = Number(threshold);
  const margin = Number(unsureMargin);
  const separation = Number(minMargin);
  return {
    threshold: Number.isFinite(floor) ? floor : SPEAKER_MATCH_DEFAULTS.threshold,
    unsureMargin: Number.isFinite(margin) && margin >= 0 ? margin : SPEAKER_MATCH_DEFAULTS.unsureMargin,
    minMargin: Number.isFinite(separation) && separation >= 0 ? separation : SPEAKER_MATCH_DEFAULTS.minMargin,
  };
}

/** Resolve the quality defaults; a bad/partial object falls back per field (null never means 0). */
export function resolveQualityOptions(options = {}) {
  const pick = (value, fallback) => (finiteOrNull(value) ?? fallback);
  return {
    minSpeechMs: pick(options.minSpeechMs, SPEAKER_QUALITY_DEFAULTS.minSpeechMs),
    quietRmsDb: pick(options.quietRmsDb, SPEAKER_QUALITY_DEFAULTS.quietRmsDb),
    quietPeakDb: pick(options.quietPeakDb, SPEAKER_QUALITY_DEFAULTS.quietPeakDb),
    noisySpeechRatio: pick(options.noisySpeechRatio, SPEAKER_QUALITY_DEFAULTS.noisySpeechRatio),
  };
}

/**
 * Map one score onto a decision. Pure and exported so the threshold edge is testable exactly:
 *   score >= threshold            → 'match'
 *   threshold - margin <= score   → 'unsure'   (inclusive lower edge)
 *   score < threshold - margin    → 'mismatch'
 * A non-finite score is 'unsure' (nothing was measured, so nothing is claimed).
 */
export function classifyScore(score, options = {}) {
  const value = Number(score);
  if (!Number.isFinite(value)) return 'unsure';
  const { threshold, unsureMargin } = resolveMatchOptions(options);
  if (value >= threshold) return 'match';
  return value < threshold - unsureMargin ? 'mismatch' : 'unsure';
}

/** A finite number, or null: `null`/`undefined`/''/NaN never collapse to 0 dB or 0 ratio. */
const finiteOrNull = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

/** Round a level for a row: one decimal is enough evidence and stays readable. */
const roundDb = (value) => Math.round(value * 10) / 10;

/**
 * RMS and peak of one utterance's own PCM, in dBFS (0 dBFS = full scale). Null when there is no
 * audio; a silent buffer still reports -100 dB rather than "not measured". The caller usually hands
 * over the capture's own numbers instead — this is for callers that only have samples.
 *
 * @param {Float32Array|null} samples
 * @returns {{rmsDb: number, peakDb: number}|null}
 */
export function measureLevels(samples) {
  if (!(samples instanceof Float32Array) || samples.length === 0) return null;
  let sum = 0;
  let peak = 0;
  let counted = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const value = samples[index];
    if (!Number.isFinite(value)) continue;
    sum += value * value;
    peak = Math.max(peak, Math.abs(value));
    counted += 1;
  }
  if (counted === 0) return null;
  return {
    rmsDb: sum > 0 ? roundDb(20 * Math.log10(Math.sqrt(sum / counted))) : -100,
    peakDb: peak > 0 ? roundDb(20 * Math.log10(peak)) : -100,
  };
}

/**
 * Stage-2 quality of one utterance: `ok` / `short` / `quiet` / `noisy`.
 *
 * Purely descriptive; nothing downstream gates on it. Order matters: a clip too short to embed is
 * `short` even when it is also quiet, and a soft clip is `quiet` even when noise is present, so the
 * row names the first reason that makes the embedding unreliable. A missing duration and missing
 * audio mean "not measured", reported as `ok` with null evidence — the classifier never invents a
 * too-short clip from absent context.
 *
 * @param {{durationMs?: number, samples?: Float32Array|null, rmsDb?: number|null,
 *          peakDb?: number|null, speechRatio?: number|null}} [input]
 * @param {object} [options] overrides of SPEAKER_QUALITY_DEFAULTS
 * @returns {{quality: 'ok'|'short'|'quiet'|'noisy', reason: string|null,
 *            durationMs: number|null, rmsDb: number|null, peakDb: number|null,
 *            speechRatio: number|null}}
 */
export function classifyQuality(input = {}, options = {}) {
  const settings = resolveQualityOptions(options);
  const samples = input.samples instanceof Float32Array && input.samples.length > 0 ? input.samples : null;
  const measured = measureLevels(samples);
  const explicitMs = finiteOrNull(input.durationMs);
  const durationMs = explicitMs !== null && explicitMs > 0
    ? explicitMs
    : (samples === null ? null : (samples.length / SPEAKER_SAMPLE_RATE) * 1000);
  const rmsDb = finiteOrNull(input.rmsDb) ?? (measured === null ? null : measured.rmsDb);
  const peakDb = finiteOrNull(input.peakDb) ?? (measured === null ? null : measured.peakDb);
  const speechRatio = finiteOrNull(input.speechRatio);
  const evidence = {
    durationMs: durationMs === null ? null : Math.round(durationMs),
    rmsDb,
    peakDb,
    speechRatio,
  };
  if (durationMs !== null && durationMs < settings.minSpeechMs) {
    return { quality: 'short', reason: 'too-short', ...evidence };
  }
  if ((rmsDb !== null && rmsDb <= settings.quietRmsDb) || (peakDb !== null && peakDb <= settings.quietPeakDb)) {
    return { quality: 'quiet', reason: 'quiet', ...evidence };
  }
  if (speechRatio !== null && speechRatio < settings.noisySpeechRatio) {
    return { quality: 'noisy', reason: 'noisy', ...evidence };
  }
  return { quality: 'ok', reason: null, ...evidence };
}

/**
 * The stage-2 identity class of one row: `self` / `other` / `unknown-identity`.
 *
 * The three-state `decision` is preserved (match / mismatch / unsure) and this function is where an
 * otherwise-positive score is downgraded: a non-`ok` quality, no usable score, or a best-vs-runner-up
 * margin below `minMargin` all become `unknown-identity` + `unsure`. `loopback` only annotates the
 * source — it never forces `other` — because the same lane can carry the user's own voice.
 *
 * @param {{decision?: string, score?: number, speakerId?: string|null, margin?: number|null,
 *          runnerUpScore?: number|null, source?: string, durationMs?: number,
 *          samples?: Float32Array|null, rmsDb?: number|null, peakDb?: number|null,
 *          speechRatio?: number|null}} [input]
 * @param {object} [options] threshold / margin overrides
 * @returns {{class: 'self'|'other'|'unknown-identity', decision: 'match'|'mismatch'|'unsure',
 *            quality: 'ok'|'short'|'quiet'|'noisy', source: 'mic'|'loopback', reason: string}}
 */
export function classifyShadow(input = {}, options = {}) {
  const settings = resolveMatchOptions(options);
  const quality = classifyQuality(input, options);
  const source = input.source === 'loopback' ? 'loopback' : 'mic';
  const base = { quality: quality.quality, source };
  const unsure = (reason) => ({ class: 'unknown-identity', decision: 'unsure', reason, ...base });
  if (quality.quality !== 'ok') return unsure(quality.reason);
  const score = finiteOrNull(input.score);
  const speakerId = normalizeSpeakerId(input.speakerId);
  if (score === null || speakerId === '') return unsure('no-score');
  const margin = finiteOrNull(input.margin)
    ?? (finiteOrNull(input.runnerUpScore) === null
      ? null
      : roundScore(score - finiteOrNull(input.runnerUpScore)));
  if (margin !== null && margin < settings.minMargin) return unsure('low-margin');
  if (input.decision === 'match') {
    return { class: 'self', decision: 'match', reason: source === 'loopback' ? 'loopback-match' : 'match', ...base };
  }
  if (input.decision === 'mismatch' || input.decision === 'no-match') {
    return {
      class: 'other',
      decision: 'mismatch',
      reason: source === 'loopback' ? 'loopback-mismatch' : 'mismatch',
      ...base,
    };
  }
  return unsure('low-score');
}

/** Round a score for events: four decimals is enough evidence and stays readable. */
const roundScore = (value) => Math.round(value * 10000) / 10000;

/** Encode one vector as the BLOB column value (little-endian Float32, no header). */
function encodeVector(vector) {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

/** Decode a stored BLOB back into an independent Float32Array. */
function decodeVector(blob) {
  if (blob === null || blob === undefined) return null;
  const bytes = Buffer.from(blob);
  if (bytes.byteLength === 0 || bytes.byteLength % 4 !== 0) return null;
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4).slice();
}

/**
 * Run `fn` inside a savepoint. Unlike `BEGIN IMMEDIATE`, a savepoint also works when the caller
 * already holds a transaction on the injected connection (e.g. `memory.db`), and it rolls back
 * exactly this unit of work.
 */
function inSavepoint(db, fn) {
  db.exec('SAVEPOINT speaker_voice');
  try {
    const value = fn();
    db.exec('RELEASE speaker_voice');
    return value;
  } catch (error) {
    try {
      db.exec('ROLLBACK TO speaker_voice');
      db.exec('RELEASE speaker_voice');
    } catch {
      /* the connection already unwound it */
    }
    throw error;
  }
}

/**
 * Create a speaker-embedding extractor, or `null` when the pinned model is not on disk.
 *
 * The null path is the contract, not an accident: the native constructor validates the model and
 * throws/crashes for a missing file, so a caller must be able to degrade without a try/catch.
 * A failed session creation, a failed `compute()` or a non-Float32Array result also yields null
 * from `embed()` — the shadow reports "no measurement", never a fake vector.
 *
 * @param {{modelPath: string, numThreads?: number, extractorFactory?: Function|null}} options
 *        `extractorFactory` is a test seam: it replaces the native constructor (a dummy file still
 *        has to exist so the missing-model path stays identical).
 * @returns {{modelPath: string, sampleRate: number, dim: number,
 *            embed: (samples: Float32Array) => Float32Array|null}|null}
 */
export function createSpeakerEmbedder({ modelPath, numThreads = 1, extractorFactory = null } = {}) {
  if (typeof modelPath !== 'string' || modelPath.length === 0 || !existsSync(modelPath)) {
    return SPEAKER_EMBEDDER_MISSING;
  }
  const threads = Math.max(1, Math.floor(Number(numThreads) || 1));
  let extractor = null;
  try {
    extractor = typeof extractorFactory === 'function'
      ? extractorFactory({ modelPath, numThreads: threads })
      : new (require('sherpa-onnx-node').SpeakerEmbeddingExtractor)({
        model: modelPath,
        numThreads: threads,
        debug: 0,
        provider: 'cpu',
      });
  } catch {
    return SPEAKER_EMBEDDER_MISSING;
  }
  if (extractor === null || typeof extractor?.createStream !== 'function' || typeof extractor?.compute !== 'function') {
    return SPEAKER_EMBEDDER_MISSING;
  }
  return {
    modelPath,
    sampleRate: SPEAKER_SAMPLE_RATE,
    dim: Number(extractor.dim) || 0,
    embed(samples) {
      // One stream per utterance: an extractor stream is consumed by `compute`, so reusing it
      // would blend two utterances into one embedding.
      if (!(samples instanceof Float32Array) || samples.length === 0) return null;
      try {
        const stream = extractor.createStream();
        stream.acceptWaveform({ samples, sampleRate: SPEAKER_SAMPLE_RATE });
        // The upstream example finalizes the input before asking whether enough audio arrived;
        // a stream that never became ready has no embedding to offer.
        stream.inputFinished?.();
        if (typeof extractor.isReady === 'function' && !extractor.isReady(stream)) return null;
        const embedding = extractor.compute(stream);
        return embedding instanceof Float32Array && embedding.length > 0 ? embedding : null;
      } catch {
        return null;
      }
    },
  };
}

/**
 * The short-answer identity window (pure logic).
 *
 * A confirmed speaker counts as "still them" only for a fixed span after the confirmation. The
 * object is a snapshot: `canReuse()` never mutates `lastConfirmedAt`, so ambient noise, a silent
 * stretch or a later partial utterance cannot renew the window — only a NEW confirmation (a new
 * object) can. That is the difference between "the answer arrived a moment later" and "the window
 * silently slid forward forever".
 *
 * @param {{lastConfirmedAt?: number|Date, windowMs?: number}} [input]
 * @returns {{lastConfirmedAt: number, windowMs: number, expiresAt: number,
 *            canReuse: (now?: number|Date) => boolean}}
 */
export function identityWindow({ lastConfirmedAt = 0, windowMs = IDENTITY_WINDOW_MS } = {}) {
  const confirmedAt = lastConfirmedAt instanceof Date ? lastConfirmedAt.getTime() : Number(lastConfirmedAt);
  const hasConfirmation = Number.isFinite(confirmedAt) && confirmedAt > 0;
  const window = Number.isFinite(Number(windowMs)) && Number(windowMs) >= 0
    ? Number(windowMs)
    : IDENTITY_WINDOW_MS;
  return {
    lastConfirmedAt: hasConfirmation ? confirmedAt : 0,
    windowMs: window,
    expiresAt: hasConfirmation ? confirmedAt + window : 0,
    canReuse(now = Date.now()) {
      const at = now instanceof Date ? now.getTime() : Number(now);
      if (!hasConfirmation || !Number.isFinite(at)) return false;
      const elapsed = at - confirmedAt;
      // Clock skew (now before the confirmation) is not evidence of a live window.
      return elapsed >= 0 && elapsed <= window;
    },
  };
}

/**
 * Local speaker library: templates + retirement tombstones, one SQLite file.
 *
 * Columns mirror the documented record: id, label, template vector, created/last-matched time,
 * enrollment count and enabled flag. `activeCount` is the number of enrollments averaged into the
 * stored template (≥ 1), not a match counter — matches are recorded in `lastMatchedAt`.
 */
export class SpeakerLibrary {
  /**
   * @param {{root?: string, db?: import('node:sqlite').DatabaseSync|null,
   *          onEvent?: ((type: string, payload: object) => void)|null,
   *          now?: () => number}} [options]
   */
  constructor({ root = '', db = null, onEvent = null, now = Date.now } = {}) {
    this.root = typeof root === 'string' ? root : '';
    this.injectedDb = db;
    this.db = null;
    this.dir = '';
    this.file = '';
    this.ownsDb = false;
    this.onEvent = typeof onEvent === 'function' ? onEvent : null;
    this.now = typeof now === 'function' ? now : Date.now;
  }

  open() {
    if (this.db !== null) return this.db;
    let db = this.injectedDb;
    if (db === null) {
      const root = resolveRoot({ root: this.root });
      this.dir = join(root, 'memory');
      this.file = join(this.dir, 'speaker.db');
      mkdirSync(this.dir, { recursive: true });
      db = new DatabaseSync(this.file);
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA synchronous = NORMAL');
      this.ownsDb = true;
    }
    db.exec(`CREATE TABLE IF NOT EXISTS speaker_template (
      speaker_id TEXT PRIMARY KEY,
      label TEXT NOT NULL DEFAULT '',
      dim INTEGER NOT NULL,
      embedding BLOB NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_matched_at TEXT,
      active_count INTEGER NOT NULL DEFAULT 1,
      enabled INTEGER NOT NULL DEFAULT 1
    )`);
    // A tombstone is the only thing that survives removal: it is what makes an id one-shot.
    db.exec(`CREATE TABLE IF NOT EXISTS speaker_retired (
      speaker_id TEXT PRIMARY KEY,
      removed_at TEXT NOT NULL
    )`);
    this.db = db;
    return db;
  }

  /** Close only a connection this instance opened; an injected connection stays the caller's. */
  close() {
    if (this.db === null) return;
    if (this.ownsDb) this.db.close();
    this.db = null;
  }

  row(speakerId) {
    return this.open().prepare('SELECT * FROM speaker_template WHERE speaker_id = ?').get(speakerId);
  }

  emit(type, payload) {
    emitSafely(this.onEvent, type, payload);
  }

  /**
   * Enroll one embedding, or fold it into the existing template as a running average.
   *
   * A retired id is refused (`{ok:false, reason:'retired'}`) and never revived. An embedding whose
   * dimension differs from the stored one is refused too (`dim-mismatch`), so two different models
   * can never be mixed into one template.
   *
   * @returns {{ok: true, speakerId: string, created: boolean, activeCount: number}
   *          |{ok: false, reason: string, speakerId?: string}}
   */
  register(speakerId, embedding, { label = '', enabled = true } = {}) {
    const id = normalizeSpeakerId(speakerId);
    if (id === '') return { ok: false, reason: 'invalid-id' };
    const vector = normalizeEmbedding(embedding);
    if (vector === null) return { ok: false, reason: 'invalid-embedding', speakerId: id };
    const db = this.open();
    return inSavepoint(db, () => {
      if (db.prepare('SELECT 1 AS present FROM speaker_retired WHERE speaker_id = ?').get(id) !== undefined) {
        return { ok: false, reason: 'retired', speakerId: id };
      }
      const existing = this.row(id);
      const at = nowIso();
      if (existing === undefined) {
        db.prepare(
          `INSERT INTO speaker_template
             (speaker_id, label, dim, embedding, created_at, updated_at, last_matched_at, active_count, enabled)
           VALUES (?, ?, ?, ?, ?, ?, NULL, 1, ?)`,
        ).run(id, String(label ?? ''), vector.length, encodeVector(vector), at, at, enabled ? 1 : 0);
        this.emit('speaker.template.updated', { speakerId: id, reason: 'register' });
        return { ok: true, speakerId: id, created: true, activeCount: 1 };
      }
      const previous = decodeVector(existing.embedding);
      if (previous === null || previous.length !== vector.length) {
        return { ok: false, reason: 'dim-mismatch', speakerId: id };
      }
      const count = Math.max(1, Math.floor(Number(existing.active_count) || 1)) + 1;
      const merged = new Float32Array(vector.length);
      for (let index = 0; index < vector.length; index += 1) {
        merged[index] = (previous[index] * (count - 1) + vector[index]) / count;
      }
      const averaged = normalizeEmbedding(merged);
      if (averaged === null) return { ok: false, reason: 'invalid-embedding', speakerId: id };
      db.prepare(
        `UPDATE speaker_template
            SET label = ?, embedding = ?, updated_at = ?, active_count = ?, enabled = ?
          WHERE speaker_id = ?`,
      ).run(
        String(label ?? '') || existing.label,
        encodeVector(averaged),
        at,
        count,
        enabled ? 1 : 0,
        id,
      );
      this.emit('speaker.template.updated', { speakerId: id, reason: 'average' });
      return { ok: true, speakerId: id, created: false, activeCount: count };
    });
  }

  /** Metadata for every live template, oldest first. Vectors are not returned by `list()`. */
  list() {
    return this.open()
      .prepare('SELECT * FROM speaker_template ORDER BY created_at, speaker_id')
      .all()
      .map((row) => this.metadataOf(row));
  }

  /** One template including its Float32Array (needed for scoring and inspection), or null. */
  get(speakerId) {
    const id = normalizeSpeakerId(speakerId);
    if (id === '') return null;
    const row = this.row(id);
    if (row === undefined) return null;
    return { ...this.metadataOf(row), embedding: decodeVector(row.embedding) };
  }

  metadataOf(row) {
    return {
      speakerId: row.speaker_id,
      label: row.label,
      dim: Number(row.dim) || 0,
      createdAt: row.created_at,
      lastMatchedAt: row.last_matched_at ?? null,
      activeCount: Number(row.active_count) || 0,
      enabled: row.enabled === 1,
    };
  }

  /** Toggle whether a template participates in matching. Retirement is NOT undone by this. */
  setEnabled(speakerId, enabled) {
    const id = normalizeSpeakerId(speakerId);
    if (id === '') return { ok: false, reason: 'invalid-id' };
    if (this.row(id) === undefined) return { ok: false, reason: 'missing', speakerId: id };
    this.open().prepare('UPDATE speaker_template SET enabled = ?, updated_at = ? WHERE speaker_id = ?')
      .run(enabled ? 1 : 0, nowIso(), id);
    return { ok: true, speakerId: id, enabled: enabled === true };
  }

  /**
   * Remove one template and retire its id forever. The tombstone and the delete share one
   * savepoint, so there is no instant where the id is neither live nor retired.
   */
  remove(speakerId) {
    const id = normalizeSpeakerId(speakerId);
    if (id === '') return { ok: false, reason: 'invalid-id' };
    const db = this.open();
    if (this.row(id) === undefined) return { ok: false, reason: 'missing', speakerId: id };
    inSavepoint(db, () => {
      db.prepare('INSERT OR IGNORE INTO speaker_retired (speaker_id, removed_at) VALUES (?, ?)')
        .run(id, nowIso());
      db.prepare('DELETE FROM speaker_template WHERE speaker_id = ?').run(id);
    });
    return { ok: true, speakerId: id };
  }

  /**
   * Score one embedding against every enabled template.
   *
   * Pure scoring: no event, no bookkeeping. `speakerId` is the best-scoring candidate whenever any
   * comparison happened (null when nothing could be scored) and is NOT an attribution by itself —
   * `decision` is. A missing/degenerate embedding, an empty library or a dimension mismatch all
   * yield `{decision:'unsure', score:0, speakerId:null}` rather than a throw. `runnerUpScore` /
   * `margin` are the second-best candidate and the best-vs-second gap (null when only one template
   * could be compared): the shadow uses them to refuse a winner that is too close to a rival.
   *
   * @param {Float32Array|null} embedding
   * @param {{threshold?: number, unsureMargin?: number, minMargin?: number}} [options]
   * @returns {{decision: 'match'|'mismatch'|'unsure', speakerId: string|null, score: number,
   *            runnerUpScore: number|null, margin: number|null}}
   */
  match(embedding, options = {}) {
    const settings = resolveMatchOptions(options);
    const empty = { decision: 'unsure', speakerId: null, score: 0, runnerUpScore: null, margin: null };
    const query = embedding instanceof Float32Array ? embedding : null;
    if (query === null || query.length === 0) return empty;
    const rows = this.open()
      .prepare('SELECT speaker_id, embedding FROM speaker_template WHERE enabled = 1')
      .all();
    if (rows.length === 0) return empty;
    let best = null;
    let runnerUp = null;
    for (const row of rows) {
      const template = decodeVector(row.embedding);
      if (template === null || template.length !== query.length) continue;
      const score = cosineSimilarity(query, template);
      if (best === null || score > best.score) {
        runnerUp = best;
        best = { speakerId: row.speaker_id, score };
      } else if (runnerUp === null || score > runnerUp.score) {
        runnerUp = { speakerId: row.speaker_id, score };
      }
    }
    if (best === null) return empty;
    const score = roundScore(best.score);
    const runnerUpScore = runnerUp === null ? null : roundScore(runnerUp.score);
    return {
      decision: classifyScore(score, settings),
      speakerId: best.speakerId,
      score,
      runnerUpScore,
      margin: runnerUpScore === null ? null : roundScore(score - runnerUpScore),
    };
  }

  /**
   * The shadow: score, classify, record, emit. Never gates anything.
   *
   * On a `self` row the template's `lastMatchedAt` is stamped (a use is only a confident match).
   * One `speaker.shadow` row is emitted with the legacy fields (`decision/score/speakerId/ms`) plus
   * the stage-2 annotation (`class/quality/source/reason`); quality/source context is passed in
   * `options` and defaults to "not measured" / `mic`. The return value adds the annotated verdict
   * and the measured `ms` to `match()`'s result.
   *
   * @param {Float32Array|null} embedding
   * @param {{threshold?: number, unsureMargin?: number, minMargin?: number, durationMs?: number,
   *          samples?: Float32Array|null, rmsDb?: number|null, peakDb?: number|null,
   *          speechRatio?: number|null, source?: 'mic'|'loopback'}} [options]
   */
  shadow(embedding, options = {}) {
    const startedAt = this.now();
    const result = this.match(embedding, options);
    const verdict = classifyShadow({
      decision: result.decision,
      score: result.score,
      speakerId: result.speakerId,
      margin: result.margin,
      runnerUpScore: result.runnerUpScore,
      durationMs: options.durationMs,
      samples: options.samples,
      rmsDb: options.rmsDb,
      peakDb: options.peakDb,
      speechRatio: options.speechRatio,
      source: options.source,
    }, options);
    const ms = Math.max(0, Math.round(this.now() - startedAt));
    if (verdict.class === 'self' && result.speakerId !== null) {
      this.open().prepare('UPDATE speaker_template SET last_matched_at = ? WHERE speaker_id = ?')
        .run(nowIso(), result.speakerId);
    }
    this.emit('speaker.shadow', {
      decision: verdict.decision,
      score: result.score,
      speakerId: result.speakerId,
      ms,
      class: verdict.class,
      quality: verdict.quality,
      source: verdict.source,
      reason: verdict.reason,
    });
    return {
      decision: verdict.decision,
      speakerId: result.speakerId,
      score: result.score,
      class: verdict.class,
      quality: verdict.quality,
      source: verdict.source,
      reason: verdict.reason,
      ms,
    };
  }
}

/**
 * Create a speaker library. `db` may be an already-open connection (e.g. `memory.db`, as
 * `createProfileStore` expects); otherwise `<root>/memory/speaker.db` is opened on first use.
 *
 * @param {{root?: string, db?: import('node:sqlite').DatabaseSync|null,
 *          onEvent?: ((type: string, payload: object) => void)|null,
 *          now?: () => number}} [options]
 * @returns {SpeakerLibrary}
 */
export function createSpeakerLibrary(options = {}) {
  return new SpeakerLibrary(options);
}
