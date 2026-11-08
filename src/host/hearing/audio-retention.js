/**
 * Audio retention — opt-in, short-lived diagnosis clips for a *suspicious* utterance.
 *
 * This is not a recorder. It answers one question the text row cannot: was a strange trigger a
 * device problem (the PCM is silent/clipped), an acoustic echo (the playback is inside the clip),
 * or an ASR hallucination (a word with no speech in it)? The switch is `voice.audioRetention` and it
 * is **off by default**: while it is off `retain()` returns `DISABLED` and nothing is written.
 *
 * Contract:
 *  - only the utterance's own 16 kHz mono 16-bit PCM is kept, one `.wav` per suspicious final;
 *  - storage is `<root>/cache/retention/<timestamp>-<utteranceId>.wav` plus one `index.json`;
 *  - the index is the source of truth (time / utteranceId / rms / vad / text / reason / bytes) and is
 *    validated on every read: a deleted `.wav` is reported as `missing`, never silently dropped;
 *  - `maxClips` / `maxDurationMs` / `maxBytes` bound the store, oldest-first (FIFO); `maxAgeMs`
 *    expires clips. Expiry is *lazy*: `retain()` (after a successful write), `list()` and
 *    `exportPath()` each run one expired+FIFO pass, throttled by `cleanupIntervalMs` (30 s), so a
 *    long-running store expires on its own and a restart (a new store on the same root) cleans on
 *    its first read without any capture hook; `cleanup()` forces a pass at startup;
 *  - a prune writes the debug row `hearing.audio.pruned { count }`; a write the row
 *    `hearing.audio.retained { utteranceId, bytes, reason }`. Neither carries audio;
 *  - privacy is checked at write time: while the privacy lock is on, `retain()` returns `PRIVACY`
 *    and no file, no index entry and no event is created.
 *
 * Every read/write is serialised on one promise chain, so the mic and the loopback lane can share a
 * store without interleaving `index.json`. Nothing here ever throws to its caller: filesystem
 * failures are returned as `{ ok:false, code:'RETENTION_ERROR' }`.
 */
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { isProtectedShortAnswer, noiseSuspects, shadowTextKey } from './audio-evidence.js';

/** Sample rate of the capture lane; the WAV header and every duration derive from it. */
export const RETENTION_SAMPLE_RATE = 16000;
/** Where a plugin root keeps its clips: `<root>/cache/retention`. */
export const RETENTION_SUBDIR = Object.freeze(['cache', 'retention']);
/** How much transcript text one index entry may keep (a clip is diagnosed, not transcribed). */
export const RETENTION_TEXT_MAX = 240;

/**
 * Bound of the store. FIFO: the oldest clip goes first when any one of the three totals is passed.
 * `maxAgeMs` is a separate lifetime bound, applied by the throttled lazy cleanup rather than by a
 * write itself.
 */
export const DEFAULT_RETENTION_LIMITS = Object.freeze({
  maxClips: 20,
  maxDurationMs: 5 * 60 * 1000,
  maxBytes: 50 * 1024 * 1024,
  maxAgeMs: 6 * 60 * 60 * 1000,
});

/**
 * How often a store expires clips on its own. `retain()` / `list()` / `exportPath()` ask "is it
 * time?" and only then scan the index, so a busy capture never stats the store per clip.
 */
export const RETENTION_CLEANUP_INTERVAL_MS = 30 * 1000;

/** Reasons a clip may be kept; each names one diagnosis hypothesis (see `retentionVerdictOf`). */
export const RETENTION_REASONS = Object.freeze(['low-evidence', 'echo', 'noise', 'filtered']);

const finiteOrNull = (value) => (Number.isFinite(value) ? Number(value) : null);

/** A positive finite number, otherwise the shipping default. */
export function resolveRetentionLimits(input = null) {
  const source = input !== null && typeof input === 'object' ? input : {};
  const pick = (key, fallback) => {
    const value = Number(source[key]);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
  };
  return {
    maxClips: pick('maxClips', DEFAULT_RETENTION_LIMITS.maxClips),
    maxDurationMs: pick('maxDurationMs', DEFAULT_RETENTION_LIMITS.maxDurationMs),
    maxBytes: pick('maxBytes', DEFAULT_RETENTION_LIMITS.maxBytes),
    maxAgeMs: pick('maxAgeMs', DEFAULT_RETENTION_LIMITS.maxAgeMs),
  };
}

/** Float32 PCM (-1..1) → Int16 PCM. `null` for no audio, never a zero-length clip. */
export function pcm16FromFloat32(samples) {
  if (samples === null || samples === undefined || typeof samples.length !== 'number') return null;
  if (samples.length === 0) return null;
  const pcm = new Int16Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    const value = Number(samples[index]);
    const clamped = Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
    pcm[index] = Math.round(clamped * 32767);
  }
  return pcm;
}

/**
 * Join the capture loop's Float32 chunks into one Int16 clip. `totalSamples` is the buffer's own
 * count (the same number the snapshot reports as `bufferedSamples`), so a chunk list that is shorter
 * than the count still produces a clip of the audio that exists.
 */
export function pcm16FromChunks(chunks, totalSamples = 0) {
  const parts = Array.isArray(chunks) ? chunks : [];
  const counted = parts.reduce((sum, part) => sum + (typeof part?.length === 'number' ? part.length : 0), 0);
  const wanted = Number.isFinite(totalSamples) && totalSamples > 0 ? Math.floor(totalSamples) : counted;
  const total = Math.min(counted, wanted);
  if (total <= 0) return null;
  const pcm = new Int16Array(total);
  let offset = 0;
  for (const part of parts) {
    if (offset >= total) break;
    const length = Math.min(part.length, total - offset);
    for (let index = 0; index < length; index += 1) {
      const value = Number(part[index]);
      const clamped = Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
      pcm[offset + index] = Math.round(clamped * 32767);
    }
    offset += length;
  }
  return pcm;
}

/**
 * One 16-bit mono PCM WAV buffer (44-byte canonical header + little-endian samples).
 * @param {Int16Array|Float32Array} samples
 * @param {{sampleRate?: number}} [options]
 * @returns {Buffer|null}
 */
export function encodeWav16(samples, { sampleRate = RETENTION_SAMPLE_RATE } = {}) {
  const pcm = samples instanceof Int16Array ? samples : pcm16FromFloat32(samples);
  if (pcm === null || pcm.length === 0) return null;
  const rate = Number.isFinite(Number(sampleRate)) && Number(sampleRate) > 0
    ? Math.floor(Number(sampleRate))
    : RETENTION_SAMPLE_RATE;
  const dataBytes = pcm.length * 2;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataBytes, 40);
  return Buffer.concat([header, Buffer.from(pcm.buffer, pcm.byteOffset, dataBytes)]);
}

/**
 * Why (if at all) this final's audio is worth keeping. Pure: no clock, no filesystem, no store.
 *
 * Decision order, so every clip has one explainable reason:
 *  - `echo`: the applied echo gate dropped the final (playback is literally inside the clip);
 *  - `low-evidence`: the low-evidence verdict fired, or a delivered clip had **exactly zero** real
 *    (Silero) speech — the ASR-hallucination shape;
 *  - `noise`: the noise shadow's suspects (`forced-segment`, `short-latin`, `repeat-token`,
 *    `no-voiced`) — the device/acoustic anomaly that is not classified as the two above;
 *  - `filtered`: it produced text but was not delivered (audible/loud gate, tag-only text …);
 *  - `''`: nothing to diagnose; no clip is kept.
 *
 * @returns {{reason: ''|'low-evidence'|'echo'|'noise'|'filtered', suspects: string[]}}
 */
export function retentionVerdictOf({
  text = '',
  durationMs = 0,
  endpointReason = 'other',
  voicedMs = null,
  vadSpeechRatio = null,
  delivered = false,
  echo = null,
  lowEvidence = null,
} = {}) {
  const empty = { reason: '', suspects: [] };
  if (echo?.drop === true) return { reason: 'echo', suspects: [] };
  const ratio = Number.isFinite(vadSpeechRatio) ? Number(vadSpeechRatio) : null;
  if (lowEvidence?.lowEvidence === true) return { reason: 'low-evidence', suspects: [] };
  // Zero measured speech on a delivered clip is the hallucination shape — except for a protected
  // short answer, which every other verdict in this project leaves alone (a real「好」is not noise).
  if (ratio === 0 && delivered === true && shadowTextKey(text) !== '' && !isProtectedShortAnswer(text)) {
    return { reason: 'low-evidence', suspects: [] };
  }
  if (shadowTextKey(text) === '') return empty;
  const suspects = noiseSuspects({ text, durationMs, endpointReason, voicedMs });
  if (suspects.length > 0) return { reason: 'noise', suspects };
  if (delivered !== true) return { reason: 'filtered', suspects: [] };
  return empty;
}

/** Convenience form for callers that only need the reason string. */
export function retentionReasonOf(input = {}) {
  return retentionVerdictOf(input).reason;
}

const stampOf = (ms) => new Date(ms).toISOString().replace(/[-:.]/gu, '');

const safeSegment = (value) => {
  const text = String(value ?? '').replace(/[^A-Za-z0-9_-]/gu, '');
  return text === '' ? '0' : text.slice(0, 40);
};

/** Index entries only ever name a plain file inside the store directory. */
const plainWavName = (name) => typeof name === 'string' && name !== ''
  && name.endsWith('.wav') && basename(name) === name;

/**
 * Create one store. `dir` wins over `root` (tests); production passes the plugin root.
 *
 * @param {{root?: string, dir?: string, limits?: object, cleanupIntervalMs?: number,
 *          now?: () => number, enabled?: boolean|(() => boolean),
 *          isPrivacy?: () => boolean, emit?: (type: string, payload: object) => void}} [config]
 */
export function createAudioRetention({
  root = '',
  dir = '',
  limits = null,
  cleanupIntervalMs = RETENTION_CLEANUP_INTERVAL_MS,
  now = Date.now,
  enabled = () => true,
  isPrivacy = () => false,
  emit = null,
} = {}) {
  const baseDir = typeof dir === 'string' && dir !== ''
    ? dir
    : join(typeof root === 'string' ? root : '', RETENTION_SUBDIR[0], RETENTION_SUBDIR[1]);
  const indexFile = join(baseDir, 'index.json');
  const cap = resolveRetentionLimits(limits);
  const cleanupEveryMs = Number.isFinite(Number(cleanupIntervalMs)) && Number(cleanupIntervalMs) > 0
    ? Math.floor(Number(cleanupIntervalMs))
    : RETENTION_CLEANUP_INTERVAL_MS;
  const clock = typeof now === 'function' ? now : Date.now;

  let gate = typeof enabled === 'function' ? enabled : () => enabled === true;
  let privacyGate = typeof isPrivacy === 'function' ? isPrivacy : () => false;
  let sink = typeof emit === 'function' ? emit : null;
  /** Set by the settings action: the switch just persisted is the value in force here. */
  let override = null;
  let index = null;
  let chain = Promise.resolve();
  /** When the last expired+FIFO pass ran; `-Infinity` makes the first call after creation due. */
  let lastCleanupAt = Number.NEGATIVE_INFINITY;

  const isEnabled = () => {
    if (override !== null) return override;
    try {
      return gate() === true;
    } catch {
      return false;
    }
  };
  const privacyNow = () => {
    try {
      return privacyGate() === true;
    } catch {
      return true; // an unreadable privacy state fails closed: no audio is written
    }
  };
  const emitEvent = (type, payload) => {
    try {
      sink?.(type, payload);
    } catch {
      /* a diagnostic sink must never break the store */
    }
  };
  const pathOf = (item) => join(baseDir, item.file);
  const fileExists = async (path) => {
    try {
      return (await stat(path)).isFile();
    } catch {
      return false;
    }
  };
  const removeFile = async (path) => {
    try {
      await unlink(path);
    } catch {
      /* already gone (or never written): the index is still the authority */
    }
  };

  const loadIndex = async () => {
    if (index !== null) return index;
    let parsed = null;
    try {
      parsed = JSON.parse(await readFile(indexFile, 'utf8'));
    } catch {
      parsed = null;
    }
    const items = parsed !== null && Array.isArray(parsed.items) ? parsed.items : [];
    index = {
      version: 1,
      items: items
        .filter((item) => item !== null && typeof item === 'object' && plainWavName(item.file))
        .map((item) => ({
          ...item,
          createdAtMs: Number.isFinite(item.createdAtMs)
            ? item.createdAtMs
            : (Number.isFinite(Date.parse(item.createdAt)) ? Date.parse(item.createdAt) : 0),
        }))
        .sort((left, right) => left.createdAtMs - right.createdAtMs),
    };
    return index;
  };

  const saveIndex = async () => {
    await mkdir(baseDir, { recursive: true });
    const temp = `${indexFile}.tmp`;
    const payload = {
      version: 1,
      updatedAt: new Date(clock()).toISOString(),
      items: index.items,
    };
    await writeFile(temp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    await rename(temp, indexFile);
  };

  /**
   * Drop missing files (the index is validated, not trusted) and then apply the FIFO caps.
   * `expired` additionally drops clips older than `maxAgeMs` — the startup/lazy cleanup.
   * `dropMissing:false` keeps the read-side contract (a deleted `.wav` is reported as `missing`).
   * Returns the removed entries; the caller saves the index once.
   */
  const pruneLocked = async ({ expired = false, dropMissing = true } = {}) => {
    const at = clock();
    const kept = [];
    const removed = [];
    for (const item of index.items) {
      const tooOld = expired && cap.maxAgeMs > 0 && at - Number(item.createdAtMs ?? 0) >= cap.maxAgeMs;
      if (tooOld || (dropMissing && !(await fileExists(pathOf(item))))) {
        removed.push(item);
        continue;
      }
      kept.push(item);
    }
    index.items = kept;
    let bytes = kept.reduce((sum, item) => sum + (Number(item.bytes) || 0), 0);
    let ms = kept.reduce((sum, item) => sum + (Number(item.durationMs) || 0), 0);
    while (index.items.length > 0
      && (index.items.length > cap.maxClips || bytes > cap.maxBytes || ms > cap.maxDurationMs)) {
      const oldest = index.items.shift();
      bytes -= Number(oldest.bytes) || 0;
      ms -= Number(oldest.durationMs) || 0;
      removed.push(oldest);
    }
    for (const item of removed) await removeFile(pathOf(item));
    return removed;
  };

  /** Serialise every operation: one index.json, no interleaved reads/writes. */
  const run = (task) => {
    const next = chain.then(task, task);
    chain = next.then(() => undefined, () => undefined);
    return next.catch((error) => ({ ok: false, code: 'RETENTION_ERROR', error: error?.message ?? String(error) }));
  };

  /** Throttle gate: one expired+FIFO pass per `cleanupEveryMs`; the first call is always due. */
  const cleanupDue = () => clock() - lastCleanupAt >= cleanupEveryMs;

  /**
   * Read-side hygiene: expire old clips before answering a read, so a long-running store (or a
   * restart's first `list()`) never shows a clip past `maxAgeMs`. A store that was never written
   * stays untouched (no directory, no index), and a `.wav` deleted outside the store is still
   * reported as `missing` — only `cleanup()` forgets those.
   */
  const lazyCleanupLocked = async () => {
    if (!cleanupDue()) return 0;
    lastCleanupAt = clock();
    if (index === null && !(await fileExists(indexFile))) return 0;
    await loadIndex();
    const removed = await pruneLocked({ expired: true, dropMissing: false });
    if (removed.length === 0) return 0;
    await saveIndex();
    emitEvent('hearing.audio.pruned', { level: 'debug', count: removed.length });
    return removed.length;
  };

  /** Accept Int16 (hearing converts once), Float32 (a caller/test) or capture chunks. */
  const pcm16Of = (samples) => {
    if (samples instanceof Int16Array) return samples.length > 0 ? samples : null;
    if (samples instanceof Float32Array) return pcm16FromFloat32(samples);
    if (Array.isArray(samples)) return pcm16FromChunks(samples);
    return null;
  };

  const retain = (input = {}) => run(async () => {
    if (!isEnabled()) return { ok: false, code: 'DISABLED' };
    if (privacyNow()) return { ok: false, code: 'PRIVACY' };
    const pcm = pcm16Of(input.samples);
    if (pcm === null) return { ok: false, code: 'NO_AUDIO' };
    await loadIndex();
    const createdAtMs = clock();
    const expiredDue = cleanupDue();
    if (expiredDue) lastCleanupAt = createdAtMs;
    const seed = `${stampOf(createdAtMs)}-${safeSegment(input.utteranceId)}`;
    let id = seed;
    for (let seq = 2; index.items.some((entry) => entry.id === id); seq += 1) id = `${seed}-${seq}`;
    const wav = encodeWav16(pcm);
    const item = {
      id,
      file: `${id}.wav`,
      createdAt: new Date(createdAtMs).toISOString(),
      createdAtMs,
      utteranceId: input.utteranceId ?? null,
      reason: typeof input.reason === 'string' && input.reason !== '' ? input.reason : 'unknown',
      bytes: wav.length,
      durationMs: Math.round((pcm.length * 1000) / RETENTION_SAMPLE_RATE),
      rmsDb: finiteOrNull(input.rmsDb),
      peakDb: finiteOrNull(input.peakDb),
      vadRatio: finiteOrNull(input.vadRatio),
      vadSource: typeof input.vadSource === 'string' ? input.vadSource : null,
      text: typeof input.text === 'string' ? input.text.slice(0, RETENTION_TEXT_MAX) : '',
      source: typeof input.source === 'string' ? input.source : '',
      device: typeof input.device === 'string' ? input.device : '',
      suspects: Array.isArray(input.suspects) ? input.suspects.slice(0, 8) : [],
    };
    await mkdir(baseDir, { recursive: true });
    await writeFile(pathOf(item), wav);
    index.items.push(item);
    // The write itself is a lazy-cleanup trigger: when the interval elapsed, the FIFO prune below
    // also expires old clips (one save, one `pruned` row). `retain` is never awaited by delivery.
    const pruned = await pruneLocked({ expired: expiredDue });
    await saveIndex();
    if (pruned.length > 0) emitEvent('hearing.audio.pruned', { level: 'debug', count: pruned.length });
    // The clip itself can be the oldest-and-only entry when a cap is smaller than one clip.
    if (!index.items.some((entry) => entry.id === item.id)) return { ok: false, code: 'OVER_LIMIT', id };
    emitEvent('hearing.audio.retained', {
      utteranceId: item.utteranceId,
      bytes: item.bytes,
      reason: item.reason,
    });
    return {
      ok: true,
      id: item.id,
      path: pathOf(item),
      bytes: item.bytes,
      durationMs: item.durationMs,
      reason: item.reason,
    };
  });

  const list = () => run(async () => {
    await lazyCleanupLocked();
    await loadIndex();
    const items = [];
    for (const item of index.items) {
      const path = pathOf(item);
      // Validation on read: a deleted file stays listed as `missing`, it is never silently dropped.
      items.push({ ...item, path, missing: !(await fileExists(path)) });
    }
    return {
      ok: true,
      dir: baseDir,
      count: items.length,
      missing: items.filter((item) => item.missing).length,
      totalBytes: items.reduce((sum, item) => sum + (Number(item.bytes) || 0), 0),
      totalDurationMs: items.reduce((sum, item) => sum + (Number(item.durationMs) || 0), 0),
      limits: { ...cap },
      items,
    };
  });

  const findItem = (id) => {
    const wanted = String(id ?? '');
    return index.items.find((item) => item.id === wanted || item.file === wanted) ?? null;
  };

  const deleteOne = (id) => run(async () => {
    await loadIndex();
    const item = findItem(id);
    if (item === null) return { ok: false, code: 'NOT_FOUND', id: String(id ?? '') };
    index.items = index.items.filter((entry) => entry !== item);
    await removeFile(pathOf(item));
    await saveIndex();
    return { ok: true, id: item.id, removed: 1, bytes: Number(item.bytes) || 0 };
  });

  const deleteAll = () => run(async () => {
    await loadIndex();
    const items = index.items;
    index.items = [];
    for (const item of items) await removeFile(pathOf(item));
    // A `.wav` whose index entry never landed is still the user's audio: "all" clears it too.
    try {
      for (const name of await readdir(baseDir)) {
        if (name.endsWith('.wav')) await removeFile(join(baseDir, name));
      }
    } catch {
      /* no store directory yet: nothing to clear */
    }
    await saveIndex();
    return {
      ok: true,
      removed: items.length,
      bytes: items.reduce((sum, item) => sum + (Number(item.bytes) || 0), 0),
    };
  });

  const exportPath = (id) => run(async () => {
    // Expire first: an expired clip must answer NOT_FOUND, not a path to a deleted file.
    await lazyCleanupLocked();
    await loadIndex();
    const item = findItem(id);
    if (item === null) return { ok: false, code: 'NOT_FOUND', id: String(id ?? '') };
    const path = pathOf(item);
    if (!(await fileExists(path))) return { ok: false, code: 'MISSING', id: item.id, path };
    return {
      ok: true,
      id: item.id,
      path,
      bytes: Number(item.bytes) || 0,
      durationMs: Number(item.durationMs) || 0,
      reason: item.reason ?? '',
      createdAt: item.createdAt ?? null,
    };
  });

  const cleanup = () => {
    // A forced pass counts as the last cleanup, so the lazy triggers stay quiet for one interval.
    lastCleanupAt = clock();
    return run(async () => {
      // The switch being off does not block hygiene, but a store that was never written must not be
      // created by a cleanup either (the default-off path stays byte-for-byte silent).
      if (!(await fileExists(indexFile))) return { ok: true, removed: 0 };
      await loadIndex();
      const removed = await pruneLocked({ expired: true });
      if (removed.length > 0) await saveIndex();
      if (removed.length > 0) emitEvent('hearing.audio.pruned', { level: 'debug', count: removed.length });
      return { ok: true, removed: removed.length };
    });
  };

  /**
   * Capture-start hygiene. Repeatable but throttled: within `cleanupIntervalMs` it answers
   * `skipped` without touching the disk, so a restart (new session, same root) re-checks instead
   * of a one-shot flag that could never clean again. `cleanup()` stays the forced pass.
   */
  const cleanupOnce = () => {
    if (!cleanupDue()) return Promise.resolve({ ok: true, removed: 0, skipped: true });
    return cleanup();
  };

  /** Let a long-lived store follow a settings toggle without a restart. */
  const setEnabled = (value) => {
    override = value === true;
    return override;
  };

  const configure = (next = {}) => {
    if (typeof next.enabled === 'function') gate = next.enabled;
    else if (typeof next.enabled === 'boolean') gate = () => next.enabled === true;
    if (typeof next.isPrivacy === 'function') privacyGate = next.isPrivacy;
    if (typeof next.emit === 'function') sink = next.emit;
    return { enabled: isEnabled(), privacy: privacyNow() };
  };

  return {
    dir: baseDir,
    indexFile,
    limits: { ...cap },
    retain,
    list,
    deleteOne,
    deleteAll,
    exportPath,
    cleanup,
    cleanupOnce,
    flush: () => chain,
    status: () => ({
      ok: true,
      dir: baseDir,
      indexFile,
      enabled: isEnabled(),
      privacy: privacyNow(),
      limits: { ...cap },
      count: index === null ? null : index.items.length,
    }),
    isEnabled,
    isPrivacy: privacyNow,
    setEnabled,
    configure,
  };
}

/**
 * One store per directory. A capture session must never open a second `index.json` writer, so the
 * mic and loopback lanes (and a restart) resolve to the same instance; the newest call re-binds the
 * live getters, which all describe the same plugin settings.
 */
const sharedStores = new Map();

export function openAudioRetention(config = {}) {
  const dir = typeof config.dir === 'string' && config.dir !== ''
    ? config.dir
    : join(typeof config.root === 'string' ? config.root : '', RETENTION_SUBDIR[0], RETENTION_SUBDIR[1]);
  const known = sharedStores.get(dir);
  if (known !== undefined) {
    known.configure(config);
    return known;
  }
  const store = createAudioRetention({ ...config, dir });
  sharedStores.set(dir, store);
  return store;
}

/** Test/teardown seam: forget the shared store for one directory (the files are kept). */
export function closeAudioRetention(dir) {
  return sharedStores.delete(dir);
}
