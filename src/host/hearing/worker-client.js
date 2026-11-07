/** worker-client — extracted from hearing.js; no host entry dependency. */
import { Worker } from 'node:worker_threads';
import { asrTagFields } from './transcript.js';

/**
 * Start the SenseVoice decode thread. `unref()` (called by the client) keeps a lazily started
 * worker from holding the process open; `terminate()` on stop releases the thread and its model.
 */
function defaultAsrWorkerFactory(init) {
  return new Worker(new URL('./asr-worker.js', import.meta.url), { name: 'seirein-asr', workerData: init });
}


/** Rejection names of the worker client, so callers can separate "stopped" from "degraded". */
const ASR_WORKER_STOPPED = 'AsrWorkerStopped';

const ASR_WORKER_DEGRADED = 'AsrWorkerDegraded';

const ASR_WORKER_TIMEOUT = 'AsrWorkerTimeout';

const ASR_WORKER_OVERFLOW = 'AsrWorkerOverflow';


/** Defaults of the worker policy; the host may override them per session. */
export const DEFAULT_ASR_DECODE_TIMEOUT_MS = 8000;

export const MAX_ASR_DECODE_TIMEOUT_MS = 30000;

export const DEFAULT_ASR_QUEUE_LIMIT = 8;

/** 240 s of 16 kHz mono PCM16, the accounting unit of the backlog (`audio.length * 2`). */
export const DEFAULT_ASR_QUEUE_BYTES = 240 * 16000 * 2;

/** The base deadline covers this much audio; longer audio scales it proportionally. */
const TIMEOUT_REFERENCE_AUDIO_MS = 15000;

const TIMEOUT_STREAK_LIMIT = 3;


const asrWorkerError = (name, message) => Object.assign(new Error(message), { name });


const nonNegative = (value, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
};


/**
 * Main-thread half of the ASR worker: turns the blocking offline decode into a queued request that
 * never touches the capture loop. Requests are serialized (one decode in flight), so finals are
 * still delivered in utterance order; the queue is only a backlog, not parallel decoding.
 *
 * Lifecycle: the thread is started by the first request (`started`), detached with `unref()`, and
 * terminated by `stop()`, which also rejects every in-flight and queued request: a stopped session
 * must not deliver a transcript anymore. A crash re-spawns once and re-sends the in-flight request;
 * a second crash degrades the client for the rest of the session, and the caller decodes on this
 * thread instead (`asr.worker.degraded`).
 *
 * A worker that stays alive but never answers is bounded by two mechanisms: every decode gets a
 * deadline (`decodeTimeoutMs`, scaled up for long audio and capped), and the backlog has both a
 * count and an audio-byte cap. The newest request is rejected when the backlog is full (the older
 * requests keep their order, and the caller keeps the streaming text instead of blocking on a
 * synchronous decode); three consecutive timeouts retire the thread for the session.
 *
 * Events (through `onEvent(type, payload)`): `asr.worker.started`, `asr.worker.stopped`,
 * `asr.worker.degraded`, `asr.decode` `{ ms, queued, ok, decodeTaskId, utteranceId }`,
 * `asr.decode.timeout` `{ ms, queued }`, `asr.queue.overflow` `{ dropped, queued }`.
 *
 * @param {{workerFactory: (init: object) => object, init: object,
 *          onEvent?: (type: string, payload: object) => void, maxRestarts?: number,
 *          decodeTimeoutMs?: number, maxDecodeTimeoutMs?: number, queueLimit?: number,
 *          queueBytesLimit?: number, maxConsecutiveTimeouts?: number}} options
 */
export function createAsrWorkerClient({
  workerFactory,
  init,
  onEvent,
  maxRestarts = 1,
  decodeTimeoutMs = DEFAULT_ASR_DECODE_TIMEOUT_MS,
  maxDecodeTimeoutMs = MAX_ASR_DECODE_TIMEOUT_MS,
  queueLimit = DEFAULT_ASR_QUEUE_LIMIT,
  queueBytesLimit = DEFAULT_ASR_QUEUE_BYTES,
  maxConsecutiveTimeouts = TIMEOUT_STREAK_LIMIT,
} = {}) {
  const baseDecodeTimeoutMs = nonNegative(decodeTimeoutMs, DEFAULT_ASR_DECODE_TIMEOUT_MS);
  const hardDecodeTimeoutMs = Math.max(baseDecodeTimeoutMs, nonNegative(maxDecodeTimeoutMs, MAX_ASR_DECODE_TIMEOUT_MS));
  const maxQueued = Math.floor(nonNegative(queueLimit, DEFAULT_ASR_QUEUE_LIMIT));
  const maxQueuedBytes = Math.floor(nonNegative(queueBytesLimit, DEFAULT_ASR_QUEUE_BYTES));
  const timeoutStreakLimit = Math.max(1, Math.floor(nonNegative(maxConsecutiveTimeouts, TIMEOUT_STREAK_LIMIT)));
  let worker = null;
  let generation = 0;
  let state = 'idle'; // idle (not spawned yet) | running | degraded | stopped
  let restarts = 0;
  let spawns = 0;
  let inflight = null;
  const queue = [];
  let queuedBytes = 0;
  let seq = 0;
  let decodes = 0;
  let crashes = 0;
  let timeouts = 0;
  let consecutiveTimeouts = 0;
  let droppedRequests = 0;
  let lastTimeoutMs = 0;
  let lastFailure = '';

  const emit = (type, payload) => {
    try {
      onEvent?.(type, payload);
    } catch {
      /* an event sink must never break capture */
    }
  };

  const dispose = () => {
    const dead = worker;
    worker = null;
    try {
      dead?.terminate?.();
    } catch {
      /* already gone */
    }
  };

  /** Timeout for this request: proportional to the audio, never above the hard cap. */
  const deadlineFor = (audio, sampleRate) => {
    if (!(baseDecodeTimeoutMs > 0)) return 0;
    const rate = Number(sampleRate) > 0 ? Number(sampleRate) : 16000;
    const samples = Number(audio?.length) || 0;
    const audioMs = (samples / rate) * 1000;
    // The base deadline is quoted for one reference utterance; a longer one scales linearly.
    const scaled = baseDecodeTimeoutMs * Math.max(1, audioMs / TIMEOUT_REFERENCE_AUDIO_MS);
    return Math.min(hardDecodeTimeoutMs, Math.max(baseDecodeTimeoutMs, Math.round(scaled)));
  };

  const clearDeadline = (item) => {
    if (item?.timer == null) return;
    clearTimeout(item.timer);
    item.timer = null;
  };

  const pump = () => {
    if (state !== 'running' || inflight !== null || queue.length === 0) return;
    const item = queue.shift();
    queuedBytes = Math.max(0, queuedBytes - item.bytes);
    inflight = item;
    item.startedAt = Date.now();
    item.deadlineMs = deadlineFor(item.audio, item.sampleRate);
    // Arm the deadline before posting: a stub that answers synchronously clears it again.
    if (item.deadlineMs > 0) {
      item.timer = setTimeout(() => onDecodeTimeout(item), item.deadlineMs);
      try {
        item.timer?.unref?.();
      } catch {
        /* a fake timer need not support unref */
      }
    }
    try {
      // The audio is copied, not transferred: a retry must be able to send it again.
      worker.postMessage({
        type: 'decode',
        id: item.id,
        audio: item.audio,
        sampleRate: item.sampleRate,
        language: item.language,
        // The thread scopes its per-piece ids with this, and echoes it back with the result.
        utteranceId: item.utteranceId ?? null,
      });
    } catch (error) {
      lost(`asr worker post failed: ${error?.message ?? error}`);
    }
  };

  const spawn = () => {
    generation += 1;
    const gen = generation;
    const started = workerFactory(init);
    worker = started;
    spawns += 1;
    started?.on?.('message', (message) => {
      if (gen === generation) handleMessage(message);
    });
    started?.on?.('error', (error) => {
      if (gen === generation) lost(`asr worker error: ${error?.message ?? error}`);
    });
    started?.on?.('exit', (code) => {
      if (gen === generation) lost(`asr worker exited (${code})`);
    });
    try {
      started?.unref?.();
    } catch {
      /* optional on a stub */
    }
    state = 'running';
    emit('asr.worker.started', { attempt: spawns });
  };

  const degrade = (reason) => {
    if (state === 'stopped' || state === 'degraded') return;
    state = 'degraded';
    // Invalidate the callbacks before terminating: a `terminate()` that reports 'exit' must not
    // look like a lost thread and respawn a fourth worker after the circuit breaker tripped.
    generation += 1;
    dispose();
    const dropped = queue.splice(0, queue.length);
    queuedBytes = 0;
    for (const item of dropped) item.reject(asrWorkerError(ASR_WORKER_DEGRADED, reason));
    emit('asr.worker.degraded', { reason, restarts, crashes, timeouts });
  };

  const lost = (reason) => {
    // A degraded session already retired the thread on purpose: its 'exit' is not a crash and must
    // not enter the restart path.
    if (state === 'stopped' || state === 'degraded') return;
    // Invalidate the dead worker first: its late 'exit'/'message' must not be handled twice.
    generation += 1;
    crashes += 1;
    // A crash is not a timeout: it breaks the "consecutive timeouts" streak.
    consecutiveTimeouts = 0;
    lastFailure = reason;
    dispose();
    const failed = inflight;
    inflight = null;
    if (failed !== null) clearDeadline(failed);
    if (restarts < maxRestarts) {
      restarts += 1;
      if (failed !== null) {
        queue.unshift(failed);
        queuedBytes += failed.bytes;
      }
      try {
        spawn();
      } catch (error) {
        const detail = `${reason}; respawn failed: ${error?.message ?? error}`;
        if (failed !== null) failed.reject(asrWorkerError(ASR_WORKER_DEGRADED, detail));
        degrade(detail);
        return;
      }
      pump();
      return;
    }
    if (failed !== null) failed.reject(asrWorkerError(ASR_WORKER_DEGRADED, reason));
    degrade(reason);
  };

  /**
   * A thread that is alive but silent: fail this request (the caller decodes it once on this
   * thread), replace the possibly-wedged thread for the backlog, and retire it after a streak.
   */
  const onDecodeTimeout = (item) => {
    if (state !== 'running' || inflight !== item) return;
    clearDeadline(item);
    inflight = null;
    timeouts += 1;
    consecutiveTimeouts += 1;
    lastTimeoutMs = item.deadlineMs;
    lastFailure = `decode timed out after ${item.deadlineMs} ms`;
    emit('asr.decode.timeout', { ms: item.deadlineMs, queued: queue.length });
    item.reject(asrWorkerError(ASR_WORKER_TIMEOUT, lastFailure));
    if (consecutiveTimeouts >= timeoutStreakLimit) {
      // Retire the worker for the rest of the session; the caller uses the synchronous path.
      degrade('decode-timeout');
      return;
    }
    // The abandoned decode may still occupy the thread, so give the backlog a fresh one.
    generation += 1;
    dispose();
    try {
      spawn();
    } catch {
      degrade('decode-timeout');
      return;
    }
    pump();
  };

  const handleMessage = (message) => {
    if (message?.type !== 'result' && message?.type !== 'error') return;
    const item = inflight;
    // A duplicate result (`inflight` already cleared) or a late one from a previous request is
    // dropped here: one utterance can only ever resolve once.
    if (item === null || message.id !== item.id) return;
    inflight = null;
    clearDeadline(item);
    // The thread answered, so the timeout streak (whatever the answer) is over.
    consecutiveTimeouts = 0;
    const ms = Math.max(0, Date.now() - item.startedAt);
    const ok = message.type === 'result';
    if (ok) decodes += 1;
    // `decodeTaskId` identifies this request for the rest of its life; `utteranceId` is the caller's
    // identity, so one transcript can be followed from the capture loop to the thread and back.
    emit('asr.decode', {
      ms, queued: queue.length, ok, decodeTaskId: item.id, utteranceId: item.utteranceId ?? null,
    });
    if (ok) {
      item.resolve({
        text: typeof message.text === 'string' ? message.text : '',
        joinFallback: message.joinFallback === true,
        decodeTaskId: item.id,
        // Per-piece ids computed by the thread's own `decodeSegmented`; a thread that does not
        // report them leaves the list empty rather than letting this side invent ids.
        segmentIds: Array.isArray(message.segmentIds)
          ? message.segmentIds.filter((id) => typeof id === 'string')
          : [],
        ...asrTagFields(message),
      });
    } else {
      item.reject(asrWorkerError('AsrWorkerDecode', String(message.error ?? 'decode failed')));
    }
    pump();
  };

  /**
   * `utteranceId` is the caller's identity for the utterance; it is carried through the queue and
   * into the thread message, so the decode result and the shadow row can name the same utterance.
   */
  const decode = (audio, { sampleRate = 16000, language = 'auto', utteranceId = null } = {}) => new Promise((resolve, reject) => {
    if (state === 'stopped') {
      reject(asrWorkerError(ASR_WORKER_STOPPED, 'hearing stopped'));
      return;
    }
    if (state === 'degraded') {
      reject(asrWorkerError(ASR_WORKER_DEGRADED, lastFailure || 'asr worker degraded'));
      return;
    }
    // Backlog policy: reject the NEWEST request (never evict an older one), so the delivered
    // transcripts keep their utterance order and an overload never triggers a sync decode storm.
    // Bytes use the PCM16 accounting unit (`samples * 2`), matching the configured cap.
    const bytes = Math.max(0, (Number(audio?.length) || 0) * 2);
    const overCount = queue.length >= maxQueued;
    const overBytes = queuedBytes + bytes > maxQueuedBytes;
    if (overCount || overBytes) {
      droppedRequests += 1;
      const reason = overCount ? 'count' : 'bytes';
      emit('asr.queue.overflow', {
        dropped: 1,
        droppedTotal: droppedRequests,
        queued: queue.length,
        bytes: queuedBytes,
        reason,
      });
      reject(asrWorkerError(
        ASR_WORKER_OVERFLOW,
        `asr queue ${reason} limit reached (${queue.length}/${maxQueued} requests, ${queuedBytes}/${maxQueuedBytes} B)`,
      ));
      return;
    }
    seq += 1;
    queue.push({
      id: seq, audio, sampleRate, language, utteranceId, bytes, startedAt: 0, timer: null, deadlineMs: 0, resolve, reject,
    });
    queuedBytes += bytes;
    if (state === 'idle') {
      try {
        spawn();
      } catch (error) {
        const reason = `asr worker start failed: ${error?.message ?? error}`;
        lastFailure = reason;
        // Nothing was posted yet: `degrade()` rejects the queued request with the rest.
        degrade(reason);
        return;
      }
    }
    pump();
  });

  const stop = () => {
    if (state === 'stopped') return;
    const wasRunning = worker !== null;
    state = 'stopped';
    generation += 1;
    dispose();
    const dropped = queue.splice(0, queue.length);
    queuedBytes = 0;
    for (const item of dropped) item.reject(asrWorkerError(ASR_WORKER_STOPPED, 'hearing stopped'));
    if (inflight !== null) {
      const item = inflight;
      inflight = null;
      clearDeadline(item);
      item.reject(asrWorkerError(ASR_WORKER_STOPPED, 'hearing stopped'));
    }
    if (wasRunning) emit('asr.worker.stopped', { decodes, restarts, crashes, timeouts, dropped: droppedRequests });
  };

  return {
    decode,
    stop,
    status: () => ({
      state,
      restarts,
      crashes,
      decodes,
      timeouts,
      consecutiveTimeouts,
      dropped: droppedRequests,
      lastTimeoutMs,
      decodeTimeoutMs: baseDecodeTimeoutMs,
      queued: queue.length,
      queuedBytes,
      inflight: inflight !== null,
    }),
  };
}

export {
  defaultAsrWorkerFactory,
  ASR_WORKER_STOPPED,
  ASR_WORKER_DEGRADED,
  ASR_WORKER_TIMEOUT,
  ASR_WORKER_OVERFLOW,
  TIMEOUT_REFERENCE_AUDIO_MS,
  TIMEOUT_STREAK_LIMIT,
  asrWorkerError,
  nonNegative,
};
