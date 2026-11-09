/**
 * Short-lived WAV files for the daily speaker-candidate cache.
 *
 * The companion cache (`speaker-candidates.js`) stores metadata only and never copies or opens the
 * caller's audio. The host therefore owns the tiny audio side: it writes one 16 kHz mono 16-bit
 * PCM WAV per qualifying microphone utterance into `<root>/cache/speaker-candidates/`, passes that
 * path to the store, and lets the store unlink it when the row is evicted/removed. This module
 * never reads the speaker library, never assigns an identity and never calls a model.
 *
 * The file name is derived from a hash of the utterance id, so an utterance id containing `:` or
 * other path characters can never escape the directory. Writes are atomic (temp file in the same
 * directory + rename); a failure throws so the caller can record one reason event and skip the
 * metadata row.
 *
 * `cleanupSpeakerCandidateAudio()` is a best-effort safety net for files the metadata no longer
 * references (a failed add, a crash between the write and the metadata commit, an old temp file).
 * It never throws: missing/unreadable directories simply report zero removals.
 */
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

/** Cache directory relative to the caller-provided root. */
export const SPEAKER_CANDIDATE_AUDIO_DIR = join('cache', 'speaker-candidates');

/** The one sample rate the candidate seam produces (hearing's 16 kHz mono PCM). */
export const SPEAKER_CANDIDATE_SAMPLE_RATE = 16000;

/** Hard cap on one clip; the store refuses rows longer than 15 s anyway. */
export const SPEAKER_CANDIDATE_MAX_SAMPLES = SPEAKER_CANDIDATE_SAMPLE_RATE * 15;

/** Default cleanup bounds: more files than any live cache can reference. */
export const SPEAKER_CANDIDATE_AUDIO_MAX_FILES = 80;

/** Unreferenced audio older than this is removed even when it is not in the orphan set. */
export const SPEAKER_CANDIDATE_AUDIO_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

let writeSeq = 0;

function requireRoot(root) {
  if (typeof root !== 'string' || root.trim().length === 0) {
    throw new TypeError('speaker candidate audio: root is required');
  }
  return root;
}

/** A stable, path-safe stem for one utterance id. */
function safeStem(utteranceId) {
  const text = typeof utteranceId === 'string' ? utteranceId.trim() : '';
  if (text.length === 0) throw new TypeError('speaker candidate audio: utteranceId is required');
  const hash = createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 24);
  return `candidate-${hash}`;
}

/** `<root>/cache/speaker-candidates`; the directory is only created by a write. */
export function speakerCandidateAudioDir(root) {
  return join(requireRoot(root), SPEAKER_CANDIDATE_AUDIO_DIR);
}

/** Absolute destination for one utterance. It does not create the directory. */
export function speakerCandidateAudioPath({ root, utteranceId } = {}) {
  return join(speakerCandidateAudioDir(root), `${safeStem(utteranceId)}.wav`);
}

/** One 44-byte canonical PCM WAV header + clamped int16 samples. */
function encodeWav(samples) {
  const pcm = Buffer.allocUnsafe(samples.length * 2);
  let peak = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const raw = Number(samples[index]);
    const value = Number.isFinite(raw) ? Math.max(-1, Math.min(1, raw)) : 0;
    peak = Math.max(peak, Math.abs(value));
    pcm.writeInt16LE(Math.round(value < 0 ? value * 32768 : value * 32767), index * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // format = PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SPEAKER_CANDIDATE_SAMPLE_RATE, 24);
  header.writeUInt32LE(SPEAKER_CANDIDATE_SAMPLE_RATE * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return { bytes: Buffer.concat([header, pcm]), peak };
}

/**
 * Write one candidate WAV.
 *
 * @param {object} options
 * @param {string} options.root caller-owned root (`<root>/cache/speaker-candidates/<safe>.wav`).
 * @param {string} options.utteranceId the store's de-duplication key.
 * @param {Float32Array|number[]} options.samples 16 kHz mono PCM in [-1, 1].
 * @returns {{path: string, bytes: number, durationMs: number, peak: number}}
 */
export function writeSpeakerCandidateWav({ root, utteranceId, samples } = {}) {
  if (!(samples instanceof Float32Array) && !Array.isArray(samples)) {
    throw new TypeError('speaker candidate audio: samples must be Float32Array or number[]');
  }
  if (samples.length === 0) throw new TypeError('speaker candidate audio: samples are empty');
  const usable = samples.length > SPEAKER_CANDIDATE_MAX_SAMPLES
    ? (Array.isArray(samples)
      ? samples.slice(0, SPEAKER_CANDIDATE_MAX_SAMPLES)
      : samples.subarray(0, SPEAKER_CANDIDATE_MAX_SAMPLES))
    : samples;
  const { bytes, peak } = encodeWav(usable);
  const directory = speakerCandidateAudioDir(root);
  const path = speakerCandidateAudioPath({ root, utteranceId });
  mkdirSync(directory, { recursive: true });
  writeSeq += 1;
  const temporary = `${path}.${process.pid}.${writeSeq}.tmp`;
  try {
    writeFileSync(temporary, bytes);
    renameSync(temporary, path);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      /* the temp file may never have been created */
    }
    throw error;
  }
  return {
    path,
    bytes: bytes.length,
    durationMs: Math.round((usable.length / SPEAKER_CANDIDATE_SAMPLE_RATE) * 1000),
    peak,
  };
}

/** Case-insensitive path key on Windows, exact elsewhere. */
function pathKey(path) {
  const absolute = resolve(path);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

/**
 * Best-effort cleanup of the candidate audio directory.
 *
 * Removes files that are neither in `keepPaths` nor recent (`maxAgeMs`), then the oldest files
 * above `maxFiles` (default 80). A missing directory, permission error or `stat` failure only
 * counts as a failure; it never throws and never touches a path outside the candidate directory.
 *
 * @param {{root: string, keepPaths?: string[], maxFiles?: number, maxAgeMs?: number,
 *   now?: number}} options
 * @returns {{ok: true, removed: number, failed: number, kept: number}}
 */
export function cleanupSpeakerCandidateAudio({
  root,
  keepPaths = [],
  maxFiles = SPEAKER_CANDIDATE_AUDIO_MAX_FILES,
  maxAgeMs = SPEAKER_CANDIDATE_AUDIO_MAX_AGE_MS,
  now = Date.now(),
} = {}) {
  let directory;
  try {
    directory = speakerCandidateAudioDir(root);
  } catch {
    return { ok: true, removed: 0, failed: 0, kept: 0 };
  }
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return { ok: true, removed: 0, failed: 0, kept: 0 };
  }
  const keep = new Set();
  for (const path of Array.isArray(keepPaths) ? keepPaths : []) {
    if (typeof path === 'string' && path.length > 0) keep.add(pathKey(path));
  }
  const fileLimit = Number.isFinite(Number(maxFiles)) && Number(maxFiles) > 0
    ? Math.floor(Number(maxFiles))
    : SPEAKER_CANDIDATE_AUDIO_MAX_FILES;
  const ageLimit = Number.isFinite(Number(maxAgeMs)) && Number(maxAgeMs) > 0
    ? Number(maxAgeMs)
    : SPEAKER_CANDIDATE_AUDIO_MAX_AGE_MS;
  const nowMs = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const survivors = [];
  let removed = 0;
  let failed = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(directory, entry.name);
    const temporary = entry.name.endsWith('.tmp');
    if (!entry.name.endsWith('.wav') && !temporary) continue;
    let info;
    try {
      info = statSync(path);
    } catch {
      failed += 1;
      continue;
    }
    const stale = nowMs - info.mtimeMs > ageLimit;
    // A temp file is never referenced by metadata; give an in-flight write a short grace period.
    const unreferenced = temporary
      ? nowMs - info.mtimeMs > 60_000
      : !keep.has(pathKey(path));
    if (stale || unreferenced) {
      try {
        unlinkSync(path);
        removed += 1;
      } catch {
        failed += 1;
      }
      continue;
    }
    if (!temporary) survivors.push({ path, mtimeMs: info.mtimeMs });
  }
  if (survivors.length > fileLimit) {
    survivors.sort((left, right) => left.mtimeMs - right.mtimeMs || (left.path < right.path ? -1 : 1));
    for (const entry of survivors.slice(0, survivors.length - fileLimit)) {
      try {
        unlinkSync(entry.path);
        removed += 1;
      } catch {
        failed += 1;
      }
    }
  }
  const kept = Math.max(0, Math.min(survivors.length, fileLimit));
  return { ok: true, removed, failed, kept };
}
