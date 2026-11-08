/**
 * On-demand model downloads.
 *
 * The checkout has no separate download-center module (the dependency downloader lives in the DSH
 * runtime, not here), so this is the shared seam the assistant's own models use: a fixed source,
 * a pinned byte count + sha256, one in-flight download per destination, mirror/retry support, and
 * the `<target>.<taskId>.part` → verify → rename sequence. Callers only observe the `vad.model.*`
 * events and the returned path; a failed download leaves no half file behind, and the only write
 * to the target is the verified atomic rename of a task's own part.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

import { VAD_MODEL_FILE } from '../hearing/vad.js';

/** Pinned Silero VAD model: the exact release asset, byte count and digest. */
export const VAD_MODEL_URL =
  'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx';
export const VAD_MODEL_BYTES = 643854;
export const VAD_MODEL_SHA256 = '9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6';

/**
 * Pinned speaker-embedding model: 3D-Speaker CAM++ (Chinese common), the exact release asset,
 * byte count and digest. It produces a 192-dim embedding from 16 kHz mono PCM and is used only by
 * the voice shadow (enrollment/matching), never to gate a transcript.
 */
export const SPEAKER_MODEL_FILE = '3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx';
export const SPEAKER_MODEL_URL =
  'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx';
export const SPEAKER_MODEL_BYTES = 28281138;
export const SPEAKER_MODEL_SHA256 = 'f682b514c05d947ee3fa91cd6ec6c5c7543479a128373fa29b1faedccd21fd11';

/** One download task per resolved destination, shared by every concurrent caller. */
const inFlight = new Map();

/** Cancellation reasons a caller may name through `signal.reason`. */
const CANCEL_REASONS = new Set([
  'stopped', 'shutdown', 'superseded',
  // The speaker shadow's own subscription lifecycle: the setting/component closed, the plugin
  // unloaded, the Host shut down, or a caller simply left without a more specific reason.
  'disabled', 'unload', 'listener-left',
]);

/** The reason a caller asked for; anything else falls back to `stopped`. */
function cancelReasonOf(signal, fallback = 'stopped') {
  const reason = signal?.reason;
  return typeof reason === 'string' && CANCEL_REASONS.has(reason) ? reason : fallback;
}

const cancelledError = (reason) => Object.assign(new Error(`download cancelled: ${reason}`), {
  name: 'AbortError',
  reason: 'cancelled',
  cancelReason: reason,
});

const isCancellation = (error) => error?.reason === 'cancelled';

/**
 * The half file of exactly one task: `<target>.<taskId>.part`. The task id lives in the name, so
 * a cancelled/superseded task can never address (or remove) another task's work in progress.
 */
const partPathOf = (task) => `${task.targetPath}.${task.id}.part`;

/** Remove only the part this task owns; the stored path is re-checked against its id first. */
async function removeOwnPart(task) {
  const ownPart = partPathOf(task);
  if (task.partPath !== ownPart || !ownPart.endsWith(`.${task.id}.part`)) return;
  await rm(ownPart, { force: true }).catch(() => {});
}

const sha256Of = (buffer) => createHash('sha256').update(buffer).digest('hex');

const downloadError = (reason, message = reason) => Object.assign(new Error(message), { reason });

/** Read one destination's bytes and check both invariants; a missing file is simply not ready. */
async function verifyFile(file, { bytes, sha256 }) {
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size !== bytes) return false;
    return sha256Of(await readFile(file)) === sha256;
  } catch {
    return false;
  }
}

function emit(onEvent, type, payload) {
  try {
    onEvent?.(type, payload);
  } catch {
    /* an event sink must never break the download */
  }
}

/** `<root>/models/silero_vad.onnx`, derived from the existing ASR model directory. */
export function vadModelTarget({ modelDir = '', finalModelDir = '' } = {}) {
  const base = finalModelDir || modelDir;
  if (typeof base !== 'string' || base.length === 0) return '';
  return join(dirname(base), VAD_MODEL_FILE);
}

/** `<root>/models/3dspeaker_…onnx`, the pinned speaker-embedding file, same models directory. */
export function speakerModelTarget({ modelDir = '', finalModelDir = '' } = {}) {
  const base = finalModelDir || modelDir;
  if (typeof base !== 'string' || base.length === 0) return '';
  return join(dirname(base), SPEAKER_MODEL_FILE);
}

/**
 * Whether a path is the shared `<root>/models` location. Relative paths and arbitrary directories
 * are never auto-downloaded: tests and callers that point at a fixture keep their own handling.
 */
export function isSharedModelTarget(targetPath) {
  if (typeof targetPath !== 'string' || targetPath.length === 0 || !isAbsolute(targetPath)) return false;
  return basename(dirname(resolve(targetPath))) === 'models';
}

/** Fetch one source into memory with a bounded wait; an external abort ends it immediately. */
async function fetchBuffer(url, { fetchImpl, timeoutMs, signal }) {
  if (typeof fetchImpl !== 'function') throw downloadError('fetch-unavailable');
  if (signal?.aborted) throw cancelledError(cancelReasonOf(signal));
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller !== null && timeoutMs > 0
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null;
  // Forward the task's cancellation into this attempt's own timeout controller.
  const forwardAbort = () => controller?.abort();
  signal?.addEventListener?.('abort', forwardAbort, { once: true });
  try {
    timer?.unref?.();
  } catch {
    /* a fake timer need not support unref */
  }
  try {
    const response = await fetchImpl(url, controller === null ? undefined : { signal: controller.signal });
    if (response?.ok !== true) throw downloadError(`http-${response?.status ?? 'error'}`);
    return Buffer.from(await response.arrayBuffer());
  } catch (error) {
    // A cancelled task is a cancellation, never a network failure.
    if (signal?.aborted) throw cancelledError(cancelReasonOf(signal));
    throw error?.reason === undefined ? downloadError('network', error?.message ?? String(error)) : error;
  } finally {
    if (timer !== null) clearTimeout(timer);
    signal?.removeEventListener?.('abort', forwardAbort);
  }
}

/**
 * Bind one caller to a shared task; that caller's abort only unbinds itself. `onDetach` observes
 * this caller's own departure with the number of callers still waiting (0 means the download layer
 * cancels the shared task and removes its own `.part`); it never runs for a normal completion.
 */
function subscribeTask(task, signal, fallbackReason, onDetach) {
  return new Promise((resolve, reject) => {
    const entry = {
      signal, fallbackReason, onAbort: null, settled: false, settle: null, resolve, reject,
    };
    const detach = () => {
      if (entry.onAbort === null) return;
      signal?.removeEventListener?.('abort', entry.onAbort);
      entry.onAbort = null;
    };
    entry.settle = (fn, value) => {
      if (entry.settled) return;
      entry.settled = true;
      detach();
      task.subscribers.delete(entry);
      fn(value);
    };
    const abortEntry = () => {
      const reason = cancelReasonOf(signal, entry.fallbackReason);
      entry.settle(reject, cancelledError(reason));
      // The task belongs to every caller: only the last one leaving cancels the download.
      const remaining = task.subscribers.size;
      try {
        onDetach?.(remaining, reason);
      } catch {
        /* an observer must never break the download */
      }
      if (remaining === 0) cancelTask(task, reason);
    };
    task.subscribers.add(entry);
    if (signal === null || signal === undefined) return;
    if (signal.aborted) abortEntry();
    else {
      entry.onAbort = abortEntry;
      signal.addEventListener('abort', entry.onAbort, { once: true });
    }
  });
}

/** Cancel the underlying task once; its own `.part` is removed before the one cancelled event. */
function cancelTask(task, reason) {
  if (task.finalized) return;
  task.cancelReason = reason;
  try {
    task.controller?.abort(reason);
  } catch {
    /* already aborted */
  }
  void finalizeTask(task, { kind: 'cancelled', reason }).catch(() => {});
}

/** Settle the task exactly once: one event, and every still-attached caller gets the outcome. */
async function finalizeTask(task, outcome) {
  if (task.finalized) return;
  task.finalized = true;
  if (inFlight.get(task.key) === task) inFlight.delete(task.key);
  // Own part only: never a shared/fixed `.part` that a newer task may now be writing.
  if (outcome.kind !== 'ok') await removeOwnPart(task);
  if (outcome.kind === 'ok') {
    for (const entry of [...task.subscribers]) entry.settle(entry.resolve, outcome.result);
    return;
  }
  if (outcome.kind === 'cancelled') {
    emit(task.onEvent, `${task.eventPrefix}.cancelled`, { reason: outcome.reason });
  } else {
    emit(task.onEvent, `${task.eventPrefix}.failed`, { reason: outcome.reason });
  }
  for (const entry of [...task.subscribers]) entry.settle(entry.reject, outcome.error);
}

/**
 * Download one model atomically.
 *
 * Sources are tried in order (`url` then mirrors) and the whole list is retried `retries` more
 * times. Every attempt writes its own `<target>.<taskId>.part`, verifies that part's size + sha256,
 * and only then renames it over the target; a mismatch keeps the task's part for the next attempt
 * and moves on. If the target appears and verifies before the rename (another task finished
 * first), the target is reused, this task's part is removed, and `downloaded` is `false`.
 * Concurrent calls for the same resolved target share one task, but each caller stays independently
 * cancellable: its own `signal` only unbinds that caller, and the shared download is aborted (once,
 * and only its own part removed) when the last caller leaves. Events: `<eventPrefix>.download {bytes, ms}`,
 * `<eventPrefix>.ready {path}`, `<eventPrefix>.failed {reason}`, and
 * `<eventPrefix>.cancelled {reason}` for `stopped`/`shutdown`/`superseded` (the default prefix is
 * `vad.model`, so the existing VAD events keep their names; the speaker model passes its own).
 * `onDetach(remaining, reason)` reports this caller's own departure only (never a completion): it is
 * the hook a subscriber uses to tell "I left while others still wait" from "the task was cancelled".
 *
 * @param {{targetPath: string, url?: string, mirrors?: string[], bytes: number, sha256: string,
 *          fetchImpl?: Function, retries?: number, timeoutMs?: number, eventPrefix?: string,
 *          signal?: AbortSignal, cancelReason?: 'stopped'|'shutdown'|'superseded'|'disabled'|'unload'|'listener-left',
 *          onDetach?: (remaining: number, reason: string) => void,
 *          onEvent?: (type: string, payload: object) => void, now?: () => number}} options
 * @returns {Promise<{ok: true, path: string, downloaded: boolean, bytes: number, ms: number}>}
 */
export function ensureModel({
  targetPath,
  url,
  mirrors = [],
  bytes,
  sha256,
  fetchImpl = globalThis.fetch,
  retries = 1,
  timeoutMs = 60_000,
  eventPrefix = 'vad.model',
  signal = null,
  cancelReason = 'stopped',
  onDetach,
  onEvent,
  now = Date.now,
} = {}) {
  if (typeof targetPath !== 'string' || targetPath.length === 0) {
    return Promise.reject(downloadError('invalid-target'));
  }
  if (!Number.isFinite(Number(bytes)) || Number(bytes) <= 0 || typeof sha256 !== 'string' || sha256.length === 0) {
    return Promise.reject(downloadError('invalid-definition'));
  }
  if (typeof url !== 'string' || url.length === 0) {
    return Promise.reject(downloadError('invalid-source'));
  }
  const key = resolve(targetPath);
  const running = inFlight.get(key);
  if (running !== undefined) return subscribeTask(running, signal, cancelReason, onDetach);

  const definition = { bytes: Number(bytes), sha256 };
  const sources = [...new Set([url, ...(Array.isArray(mirrors) ? mirrors : [])]
    .filter((source) => typeof source === 'string' && source.length > 0))];
  const task = {
    key,
    id: randomUUID().replace(/-/g, ''),
    targetPath,
    eventPrefix,
    onEvent,
    controller: typeof AbortController === 'function' ? new AbortController() : null,
    subscribers: new Set(),
    finalized: false,
    cancelReason: '',
  };
  task.partPath = partPathOf(task);
  inFlight.set(key, task);

  const runTask = async () => {
    const startedAt = now();
    const part = task.partPath;
    try {
      if (task.finalized) return;
      if (await verifyFile(targetPath, definition)) {
        await finalizeTask(task, {
          kind: 'ok',
          result: { ok: true, path: targetPath, downloaded: false, bytes: definition.bytes, ms: 0 },
        });
        return;
      }
      if (task.finalized) return;
      // An unverified target is never trusted or deleted: it is replaced only by the verified
      // rename below, so this task can never delete a target another task just finished.
      let reason = 'download-failed';
      for (let round = 0; round <= Math.max(0, Math.floor(Number(retries) || 0)); round += 1) {
        for (const source of sources) {
          if (task.finalized) return;
          try {
            const buffer = await fetchBuffer(source, {
              fetchImpl, timeoutMs, signal: task.controller?.signal,
            });
            if (task.finalized) return;
            await mkdir(dirname(targetPath), { recursive: true });
            if (task.finalized) return;
            // Write first, verify the file that is actually on disk, then rename: a torn write or a
            // wrong body can never become the model.
            await writeFile(part, buffer);
            if (task.finalized) return;
            if (!(await verifyFile(part, definition))) {
              reason = buffer.length !== definition.bytes ? 'size-mismatch' : 'checksum-mismatch';
              continue;
            }
            if (task.finalized) return;
            // Another task may have finished first: reuse its verified target and drop our own part.
            let reused = await verifyFile(targetPath, definition);
            if (task.finalized) return;
            if (!reused) {
              try {
                await rename(part, targetPath);
              } catch (error) {
                // On a platform that refuses to replace a target, the winner is still reusable.
                if (!(await verifyFile(targetPath, definition))) throw error;
                reused = true;
              }
            }
            if (task.finalized) return;
            if (reused) {
              await removeOwnPart(task);
              if (task.finalized) return;
              await finalizeTask(task, {
                kind: 'ok',
                result: { ok: true, path: targetPath, downloaded: false, bytes: definition.bytes, ms: 0 },
              });
              return;
            }
            const ms = Math.max(0, now() - startedAt);
            emit(onEvent, `${eventPrefix}.download`, { bytes: buffer.length, ms });
            emit(onEvent, `${eventPrefix}.ready`, { path: targetPath });
            await finalizeTask(task, {
              kind: 'ok',
              result: { ok: true, path: targetPath, downloaded: true, bytes: buffer.length, ms },
            });
            return;
          } catch (error) {
            if (task.finalized || isCancellation(error)) return;
            reason = typeof error?.reason === 'string' ? error.reason : 'network';
          }
        }
      }
      if (task.finalized) return;
      // Failure/cancel cleanup touches this task's own half file only; the target may already be
      // another task's verified model, so it is never removed here.
      await finalizeTask(task, { kind: 'failed', reason, error: downloadError(reason) });
    } catch (error) {
      if (task.finalized) return;
      const reason = typeof error?.reason === 'string' ? error.reason : 'network';
      await finalizeTask(task, { kind: 'failed', reason, error: downloadError(reason) });
    } finally {
      // Every exit removes only the half file carrying this task's own id.
      await removeOwnPart(task);
    }
  };

  const promise = subscribeTask(task, signal, cancelReason, onDetach);
  if (!task.finalized) void runTask().catch(() => {});
  return promise;
}

/** The pinned Silero VAD download, at the fixed `models/silero_vad.onnx` destination. */
export function ensureVadModel({
  targetPath, mirrors, fetchImpl, retries, timeoutMs, signal, cancelReason, onDetach, onEvent, now,
} = {}) {
  return ensureModel({
    targetPath,
    url: VAD_MODEL_URL,
    mirrors,
    bytes: VAD_MODEL_BYTES,
    sha256: VAD_MODEL_SHA256,
    fetchImpl,
    retries,
    timeoutMs,
    signal,
    cancelReason,
    onDetach,
    onEvent,
    now,
  });
}

/** The pinned CAM++ speaker-embedding download, at the fixed `models/` destination. */
export function ensureSpeakerModel({
  targetPath, mirrors, fetchImpl, retries, timeoutMs, signal, cancelReason, onDetach, onEvent, now,
} = {}) {
  return ensureModel({
    targetPath,
    url: SPEAKER_MODEL_URL,
    mirrors,
    bytes: SPEAKER_MODEL_BYTES,
    sha256: SPEAKER_MODEL_SHA256,
    eventPrefix: 'speaker.model',
    fetchImpl,
    retries,
    timeoutMs,
    signal,
    cancelReason,
    onDetach,
    onEvent,
    now,
  });
}
