/**
 * Silero VAD shadow (round 1): measurement only.
 *
 * The energy VAD in `hearing.js` cannot tell speech from steady room tone — that is exactly why the
 * noise shadow records `voicedRatio` instead of gating on it. This module runs sherpa-onnx's Silero
 * VAD alongside the existing energy meter and reports what *it* heard: speech segments, their
 * span, and the trailing silence. Nothing here filters, reorders or re-thresholds: the caller writes
 * the row after its delivery verdict is already made, and `hearing.vad.shadow` is never read back.
 *
 * The detector is fed the same PCM frames the streaming recognizer gets, in the same callback, so
 * there is no copy of the utterance. Segments are numbered on one continuous sample timeline (the
 * detector is never reset); each utterance is a window on that timeline, which is what makes a word
 * that straddles an endpoint unambiguous.
 *
 * Capture chunks are not VAD windows: they are whatever ffmpeg delivered (320, 1280, 3200, …).
 * Silero consumes exactly one 512-sample window per `acceptWaveform`, so this module re-cuts the
 * stream into fixed windows and keeps the partial tail for the next call.
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** Silero VAD model file name, looked up next to the ASR models. */
export const VAD_MODEL_FILE = 'silero_vad.onnx';

/** Silero runs on 512-sample windows at 16 kHz (32 ms); this is its native window size. */
export const VAD_WINDOW_SIZE = 512;

/** `hearing.vad.window-starved` is a debug row and it is throttled to one per this window. */
export const VAD_STARVED_THROTTLE_MS = 30_000;

/** At most this many segments are reported per utterance (the first ones). */
export const VAD_SEGMENT_LIMIT = 5;

/**
 * Ratio floor for the agreement check. Below it a method says "no speech in this utterance"; at or
 * above it, "speech present". The floor keeps one stray frame from counting as a detected word.
 */
export const VAD_AGREE_MIN_RATIO = 0.05;

/** VAD thresholds: defaults from the sherpa-onnx Silero example, not tuned in this round. */
export const VAD_DEFAULTS = {
  threshold: 0.5,
  minSilenceDuration: 0.25,
  minSpeechDuration: 0.25,
  maxSpeechDuration: 20,
};

/**
 * Resolve a configured Silero threshold: a finite value strictly inside (0, 1) wins, anything else
 * falls back to the shipped default. The shadow records the resolved number, so a row can never
 * claim a threshold the detector was not actually built with.
 *
 * @param {unknown} value `voice.vadThreshold` / `vadThreshold` from the host, or undefined
 * @returns {number} the threshold to hand to sherpa and to report
 */
export function resolveVadThreshold(value) {
  const threshold = Number(value);
  return Number.isFinite(threshold) && threshold > 0 && threshold < 1
    ? threshold
    : VAD_DEFAULTS.threshold;
}

/**
 * First existing VAD model path among the candidates (an explicitly configured path wins).
 * Missing files are not an error here: the caller reports `hearing.vad.unavailable` once.
 */
export function findVadModelPath(candidates = []) {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0 && existsSync(candidate)) return candidate;
  }
  return '';
}

/**
 * Build a real Silero VAD, or return null when the model is missing. The null path is deliberate:
 * the native constructor prints a validation error and returns an unusable handle for a missing
 * file, so callers must be able to degrade without a thrown error.
 *
 * @param {{modelPath: string, sampleRate?: number, numThreads?: number, bufferSeconds?: number,
 *          threshold?: number, minSilenceDuration?: number, minSpeechDuration?: number,
 *          maxSpeechDuration?: number}} options
 * @returns {object|null} the sherpa `Vad`, or null when `modelPath` does not exist
 */
export function createSileroVad({
  modelPath,
  sampleRate = 16000,
  numThreads = 1,
  bufferSeconds = 90,
  threshold = VAD_DEFAULTS.threshold,
  minSilenceDuration = VAD_DEFAULTS.minSilenceDuration,
  minSpeechDuration = VAD_DEFAULTS.minSpeechDuration,
  maxSpeechDuration = VAD_DEFAULTS.maxSpeechDuration,
} = {}) {
  if (typeof modelPath !== 'string' || modelPath.length === 0 || !existsSync(modelPath)) {
    return null;
  }
  const resolvedThreshold = resolveVadThreshold(threshold);
  const sherpa = require('sherpa-onnx-node');
  return new sherpa.Vad(
    {
      sileroVad: {
        model: modelPath,
        threshold: resolvedThreshold,
        minSilenceDuration,
        minSpeechDuration,
        // Silero v4/v5 at 16 kHz expects exactly 512 samples per inference (32 ms); sherpa's
        // default matches, but the window is pinned here because `createVadShadow` re-cuts the
        // capture stream to this same size. A different value would silently misalign the two.
        windowSize: VAD_WINDOW_SIZE,
        maxSpeechDuration,
      },
      sampleRate,
      numThreads,
      provider: 'cpu',
      debug: 0,
    },
    bufferSeconds,
  );
}

/**
 * Wrap a VAD instance in the shadow's per-utterance bookkeeping.
 *
 * A detected segment is queued internally by sherpa until `pop()`; the shadow drains them after
 * every frame and keeps their sample positions. `takeUtterance()` then answers with the metrics for
 * the audio fed since the previous call, and advances the window. The detector itself is not reset:
 * its sample counter stays monotonic, so segment positions are always absolute.
 *
 * @param {object} vad a sherpa `Vad` (or a test double with the same surface)
 * @param {{sampleRate?: number, segmentLimit?: number, threshold?: number,
 *          onDiagnostic?: (type: string, payload: object) => void}} [options] `onDiagnostic` is a
 *          safe sink for at most one throttled `hearing.vad.window-starved` debug row. `threshold`
 *          is reported on every row (it does not change anything here: the detector already owns
 *          its threshold).
 * @returns {{feed: (samples: Float32Array) => void,
 *            takeUtterance: (options?: {durationMs?: number, energyVoicedRatio?: number|null}) =>
 *              ({durationMs: number, speechMs: number, speechRatio: number,
 *                segments: Array<{startMs: number, endMs: number}>,
 *                firstSpeechMs: number|null, lastSpeechMs: number|null,
 *                trailingSilenceMs: number, energyVoicedRatio: number|null, agree: boolean,
 *                windowsFed: number, vadFrames: number, threshold: number,
 *                samplesFed: number, chunkSamples: number, chunkPeak: number, chunkRms: number,
 *                zeroRatio: number, maxSilenceRun: number}|null),
 *            reset: () => void, available: boolean}}
 */
export function createVadShadow(vad, {
  sampleRate = 16000,
  segmentLimit = VAD_SEGMENT_LIMIT,
  threshold = VAD_DEFAULTS.threshold,
  onDiagnostic = null,
} = {}) {
  if (vad === null || typeof vad !== 'object' || typeof vad.acceptWaveform !== 'function') {
    throw new Error('VAD 实例缺少 acceptWaveform');
  }
  const rate = Number(sampleRate) > 0 ? Number(sampleRate) : 16000;
  const reportedThreshold = resolveVadThreshold(threshold);
  /** Samples fed since creation: the absolute position of the next frame. */
  let fedSamples = 0;
  /** Absolute sample where the current utterance began. */
  let windowStart = 0;
  /** Detected segments not yet accounted for, as absolute sample ranges. */
  let pending = [];
  /**
   * Incomplete tail below one VAD window. Silero consumes exactly `VAD_WINDOW_SIZE` samples per
   * call; feeding an arbitrary capture chunk makes it see (and use) only part of the audio, which
   * is how a loud, voiced utterance used to measure `speechMs: 0`. Dropped on reset, never leak.
   */
  let residual = new Float32Array(0);
  /** Complete windows handed to the detector in the current utterance window (diagnostics). */
  let windowsFed = 0;
  /** Segments the detector closed in the current utterance window (diagnostics). */
  let vadFrames = 0;
  /** Wall clock of the last `window-starved` row, for the throttle. */
  let lastStarvedAt = 0;
  /**
   * Signal diagnostics of the PCM fed in the current utterance window. They answer the question the
   * VAD row cannot: was the audio the detector heard actually audio, or digital silence? Nothing
   * downstream reads them — they are written to the shadow row and nowhere else.
   *
   * `silenceRun`/`maxSilenceRun` are exact-zero runs (a float slot that holds 0.0), so a muted or
   * disconnected capture shows a long run while ordinary room tone does not.
   */
  const signal = {
    chunkSamples: 0,
    peak: 0,
    sumSquares: 0,
    samples: 0,
    zeros: 0,
    silenceRun: 0,
    maxSilenceRun: 0,
  };
  const resetSignal = () => {
    signal.chunkSamples = 0;
    signal.peak = 0;
    signal.sumSquares = 0;
    signal.samples = 0;
    signal.zeros = 0;
    signal.silenceRun = 0;
    signal.maxSilenceRun = 0;
  };

  /** One throttled debug row when samples arrived but not a single window was assembled. */
  const noteWindowStarved = (pendingSamples) => {
    if (typeof onDiagnostic !== 'function') return;
    const at = Date.now();
    if (at - lastStarvedAt < VAD_STARVED_THROTTLE_MS) return;
    lastStarvedAt = at;
    try {
      onDiagnostic('hearing.vad.window-starved', { level: 'debug', pendingSamples });
    } catch {
      /* a diagnostic sink must never break capture */
    }
  };

  const drain = () => {
    if (typeof vad.isEmpty !== 'function' || typeof vad.front !== 'function') return;
    let guard = 0;
    while (!vad.isEmpty() && guard < 256) {
      guard += 1;
      // `false` = let the addon allocate an owned array. With the default (`true`) sherpa returns a
      // Float32Array backed by an EXTERNAL ArrayBuffer, and Electron's V8 rejects it with
      // "External buffers are not allowed" — the throw killed the whole shadow on the first real
      // speech segment in production, while plain Node (the test runtime) accepted it.
      const segment = vad.front(false);
      const start = Number(segment?.start);
      const length = Number(segment?.samples?.length);
      if (Number.isFinite(start) && Number.isFinite(length) && length > 0) {
        pending.push({ startSample: start, endSample: start + length });
        vadFrames += 1;
      }
      if (typeof vad.pop !== 'function') break;
      vad.pop();
    }
    // One utterance never needs more than this; bounding the list keeps a long session flat.
    if (pending.length > 512) pending = pending.slice(-512);
  };

  const toMs = (samples) => Math.round((samples * 1000) / rate);

  return {
    available: true,
    feed(samples) {
      if (!(samples instanceof Float32Array) || samples.length === 0) return;
      // Signal diagnostics of exactly what this session was given, before any re-cutting: a capture
      // that delivers zeros (muted mic, dead loopback) must be visible next to `speechMs: 0`.
      signal.chunkSamples = samples.length;
      for (const sample of samples) {
        const magnitude = Math.abs(sample);
        if (magnitude > signal.peak) signal.peak = magnitude;
        signal.sumSquares += sample * sample;
        if (sample === 0) {
          signal.zeros += 1;
          signal.silenceRun += 1;
          if (signal.silenceRun > signal.maxSilenceRun) signal.maxSilenceRun = signal.silenceRun;
        } else {
          signal.silenceRun = 0;
        }
      }
      signal.samples += samples.length;
      // Re-cut the capture chunk into exact 512-sample windows; a chunk of 320/1280/3200 samples
      // must never reach `acceptWaveform` as-is. `merged` owns its memory (sherpa-onnx rejects a
      // view into foreign/external buffers — "External buffers are not allowed" on the device).
      const merged = new Float32Array(residual.length + samples.length);
      merged.set(residual);
      merged.set(samples, residual.length);
      let offset = 0;
      while (merged.length - offset >= VAD_WINDOW_SIZE) {
        vad.acceptWaveform(merged.slice(offset, offset + VAD_WINDOW_SIZE));
        offset += VAD_WINDOW_SIZE;
        windowsFed += 1;
      }
      residual = merged.slice(offset);
      fedSamples += samples.length;
      drain();
    },
    takeUtterance({ durationMs = 0, energyVoicedRatio = null } = {}) {
      drain();
      const duration = Math.max(0, Math.round(Number(durationMs) || 0));
      const received = fedSamples - windowStart;
      const measuredWindows = windowsFed;
      const measuredFrames = vadFrames;
      windowsFed = 0;
      vadFrames = 0;
      // Snapshot the signal diagnostics of this window and start a fresh window: a row describes
      // exactly the samples that were fed since the previous endpoint, never a mixed window.
      const measuredSignal = {
        samplesFed: received,
        chunkSamples: signal.chunkSamples,
        chunkPeak: Math.round(signal.peak * 1e6) / 1e6,
        chunkRms: signal.samples === 0 ? 0 : Math.round(Math.sqrt(signal.sumSquares / signal.samples) * 1e6) / 1e6,
        zeroRatio: signal.samples === 0 ? 0 : Math.round((signal.zeros / signal.samples) * 1000) / 1000,
        // Longest run of exact-zero samples, in milliseconds: a muted capture reads as the whole
        // window, room tone as a few samples (or none).
        maxSilenceRun: toMs(signal.maxSilenceRun),
      };
      resetSignal();
      if (duration <= 0 || fedSamples <= windowStart) {
        windowStart = fedSamples;
        pending = [];
        return null;
      }
      if (received > 0 && measuredWindows === 0) {
        // Samples arrived but no complete window was assembled: the window glue is broken, which
        // is exactly the failure that used to read as `speechMs: 0`. Report the stuck tail once.
        noteWindowStarved(residual.length);
      }
      const windowBase = windowStart;
      const windowEnd = fedSamples;
      const clipped = [];
      for (const segment of pending) {
        const startSample = Math.max(segment.startSample, windowBase);
        const endSample = Math.min(segment.endSample, windowEnd);
        if (endSample > startSample) clipped.push({ startSample, endSample });
      }
      // A segment still open past this endpoint belongs to the next window; nothing is invented.
      pending = pending.filter((segment) => segment.endSample > windowEnd);
      windowStart = windowEnd;

      const durationSamples = Math.max(1, Math.round((duration / 1000) * rate));
      const speechSamples = clipped.reduce((sum, segment) => sum + (segment.endSample - segment.startSample), 0);
      const speechRatio = Math.round((speechSamples / durationSamples) * 1000) / 1000;
      const firstSample = clipped.length === 0 ? null : Math.min(...clipped.map((s) => s.startSample));
      const lastSample = clipped.length === 0 ? null : Math.max(...clipped.map((s) => s.endSample));
      const firstSpeechMs = firstSample === null ? null : Math.max(0, toMs(firstSample - windowBase));
      const lastSpeechMs = lastSample === null ? null : Math.min(duration, toMs(lastSample - windowBase));
      const energy = Number.isFinite(energyVoicedRatio) ? energyVoicedRatio : null;
      const vadSaysSpeech = speechRatio >= VAD_AGREE_MIN_RATIO;
      const energySaysSpeech = energy !== null && energy >= VAD_AGREE_MIN_RATIO;
      return {
        durationMs: duration,
        // Clamp to the reported duration: the capture chunk can end a frame past the endpoint.
        speechMs: Math.min(duration, toMs(speechSamples)),
        speechRatio: Math.min(1, speechRatio),
        segments: clipped.slice(0, Math.max(1, segmentLimit)).map((segment) => ({
          startMs: Math.max(0, toMs(segment.startSample - windowBase)),
          endMs: Math.min(duration, toMs(segment.endSample - windowBase)),
        })),
        firstSpeechMs,
        lastSpeechMs,
        trailingSilenceMs: lastSpeechMs === null ? duration : Math.max(0, duration - lastSpeechMs),
        energyVoicedRatio: energy,
        // Agreement means both methods put this utterance on the same side of "speech present".
        // It is a comparison of the two verdicts, not a new gate.
        agree: vadSaysSpeech === energySaysSpeech,
        // Diagnostic counters: complete 512-sample windows actually handed to the detector in this
        // window, and the speech segments it closed. `windowsFed: 0` next to a non-zero duration is
        // the window-glue bug; `vadFrames: 0` is a detector that heard no speech.
        windowsFed: measuredWindows,
        vadFrames: measuredFrames,
        // The threshold the detector was built with, so a row can never be read against the wrong
        // operating point when `voice.vadThreshold` is configured.
        threshold: reportedThreshold,
        // What the detector was actually fed in this window: level, exact-zero share, and the
        // longest zero run. `speechMs: 0` next to `zeroRatio: 1` is silence, not a detector bug.
        ...measuredSignal,
      };
    },
    reset() {
      if (typeof vad.reset === 'function') vad.reset();
      fedSamples = 0;
      windowStart = 0;
      pending = [];
      residual = new Float32Array(0);
      windowsFed = 0;
      vadFrames = 0;
      lastStarvedAt = 0;
      resetSignal();
    },
  };
}
