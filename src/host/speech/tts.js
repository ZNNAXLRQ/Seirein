/**
 * TTS providers.
 *
 * Edge TTS (default, zero-install): Microsoft Edge Read Aloud over WebSocket, 24 kHz / 48 kbps
 * mono MP3. Optional GPT-SoVITS: a local HTTP server returns a wav for the user's reference
 * voice; any failure falls back to Edge TTS so the companion never goes silent.
 *
 * Playback prefers ffplay when an ffmpeg build is present (about 0.3 s startup instead of 0.8 s
 * through PowerShell/WPF) and falls back to WPF otherwise. ffplay handles both mp3 and wav.
 * Because the Edge bitrate is fixed, its duration is derivable from the file size.
 */
import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream, existsSync, statSync } from 'node:fs';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform, Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import pkg from 'msedge-tts';

const { MsEdgeTTS } = pkg;

export const DEFAULT_VOICE = 'zh-CN-XiaoxiaoNeural';
/** Edge default per speech language; an explicit `voice` always wins over this table. */
export const DEFAULT_VOICES = Object.freeze({
  zh: 'zh-CN-XiaoxiaoNeural',
  ja: 'ja-JP-NanamiNeural',
  en: 'en-US-AriaNeural',
  ko: 'ko-KR-SunHiNeural',
  yue: 'zh-HK-HiuGaaiNeural',
});
export function voiceForLanguage(lang) {
  return DEFAULT_VOICES[String(lang ?? '').toLowerCase()] ?? DEFAULT_VOICE;
}
export const DEFAULT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';
const BITRATE_KBPS = 48;
/**
 * A cold GPT-SoVITS server loads the weights on the first /tts call, which regularly takes
 * longer than 8 s; the old limit made every first utterance fall back to Edge. 30 s is the
 * default and remains adjustable in settings (`gptSovits.timeoutMs`).
 */
export const DEFAULT_GPT_SOVITS_TIMEOUT_MS = 30_000;
export const GPT_SOVITS_TIMEOUT_MIN_MS = 5000;
export const GPT_SOVITS_TIMEOUT_MAX_MS = 120_000;
const GPT_SOVITS_LOAD_TIMEOUT_MS = 15000;
/** One character per speech language, so a warm-up request is cheap but still valid text. */
const WARMUP_TEXT = Object.freeze({ zh: '啊', ja: 'あ', en: 'a', ko: '아', yue: '啊' });
/** The stock API answers 400 below 3 s and above 10 s ("参考音频在3~10秒范围外"). */
const REFERENCE_MIN_SECONDS = 3;
const REFERENCE_MAX_SECONDS = 10;
const REFERENCE_PROBE_TIMEOUT_MS = 4000;
/** A failed probe may recover (slow disk, tool installed later); retry after this delay. */
const REFERENCE_PROBE_RETRY_MS = 60_000;
/** Same set as the host's langs.speech. */
const TTS_LANGS = new Set(['zh', 'ja', 'en', 'ko', 'yue']);

/**
 * GPT-SoVITS is configured by the host once, so every existing `synthesize()` call site picks
 * up the new engine without changing its own signature. The provider is read per call, which
 * makes settings edits take effect immediately; the failure hook only feeds the event log.
 */
let gptSovitsProvider = null;
let gptSovitsFailureHook = null;
let gptSovitsSkippedHook = null;
let gptSovitsWarningHook = null;
let gptSovitsWarmupFailureHook = null;
/** Additive status stream for the warm-up state machine (`tts.warmup.*`); paths/text never ride it. */
let gptSovitsWarmupEventHook = null;
/** Observation only: a synthesis that had to wait for a slot reports its measured queue wait. */
let ttsSlotWaitHook = null;
/** Observation only: one `voice.tts.request` row per finished synthesis request. */
let ttsRequestHook = null;
let edgeSynthesizeOverride = null;
/**
 * One warm-up record per identity; `null` means the provider generation is unknown. A successful
 * record stays `ready`, a failed one stays `failed` while bounded retries are pending, and a newer
 * identity/configuration supersedes the old record without letting the old completion overwrite it.
 */
let gptSovitsWarmup = null;
/** Default bounded retry: first failure waits 15 s, second 60 s, then the identity stays failed. */
const DEFAULT_WARMUP_RETRY_DELAYS = Object.freeze([15_000, 60_000]);
let warmupRetryDelays = DEFAULT_WARMUP_RETRY_DELAYS;
/** Cold-start observation: the first N requests of this generation, plus the one after a warm-up. */
const TTS_COLD_START_REQUESTS = 3;
let ttsColdStartLimit = TTS_COLD_START_REQUESTS;
let ttsRequestsSinceStart = 0;
let ttsColdAfterWarmup = false;
/** Injected seams: where the audio tools are (host) and how long the clip is (tests). */
let referenceProbeResolver = null;
let referenceProbeOverride = null;
/** path -> { key: `${size}:${mtimeMs}`, at, seconds } so status polling probes once per version. */
const referenceCache = new Map();

export const TTS_AUDIO_MAX_BYTES = 16 * 1024 * 1024;
const SLOT_LIMIT = 32;
/**
 * Monotonic clock for a PROCESS-LOCAL duration (queue wait, provider round trip, ...). Wall time
 * (`Date.now()`) is only used to correlate events (`at`), so a clock adjustment cannot turn a
 * queue wait into provider synthesis time (or the reverse).
 */
export const monotonicNow = () => performance.now();
const abortError = () => new DOMException('Speech cancelled', 'AbortError');
const checkAbort = (signal) => { if (signal?.aborted) throw signal.reason ?? abortError(); };
const audioLimit = () => Object.assign(new Error('TTS audio exceeds byte limit'), { code: 'TTS_AUDIO_LIMIT' });

/**
 * Audio owned by a slot result. Only `file` / `audio` / `files` count: weight-application
 * records also carry `path`, which names model weights and must never be swept as output audio.
 */
function undeliveredAudioFiles(result, files = new Set(), depth = 0) {
  if (result === null || typeof result !== 'object' || depth > 3) return files;
  if (typeof result.file === 'string' && result.file.length > 0) files.add(result.file);
  if (typeof result.audio === 'string') files.add(result.audio);
  else undeliveredAudioFiles(result.audio, files, depth + 1);
  for (const item of Array.isArray(result.files) ? result.files : []) {
    if (typeof item === 'string') files.add(item);
    else undeliveredAudioFiles(item, files, depth + 1);
  }
  return files;
}

/** Test seams: force a failing rm, and report it as an event instead of an error. */
let audioRemover = null;
let audioCleanupFailureHook = null;

/**
 * A result that never reached entry.resolve() is still the producer's: the consumer never saw
 * its path, so it cannot clean up. A cleanup failure must not change the cancellation error.
 */
async function removeUndeliveredAudio(result) {
  for (const file of undeliveredAudioFiles(result)) {
    try {
      await (audioRemover ?? ((target) => rm(target, { force: true })))(file);
    } catch (error) {
      await notifyHook(audioCleanupFailureHook, { file, error: error?.message ?? String(error) });
    }
  }
}

/** Bounded FIFO. Abort removes waiting work immediately; running work retains ownership until cleanup. */
function createSlots() {
  const waiting = [];
  const idle = new Set();
  let active = null;
  const pump = () => {
    if (active === null && waiting.length === 0) {
      for (const resolve of idle) resolve();
      idle.clear();
    }
    if (active !== null || waiting.length === 0) return;
    const entry = waiting.shift();
    active = entry;
    entry.running = true;
    entry.startedAt = monotonicNow();
    void (async () => {
      let result;
      let delivered = false;
      try {
        checkAbort(entry.controller.signal);
        // `slotWaitMs` is enqueue -> run start; `queueDepth` is how many jobs were ahead at
        // enqueue (running + waiting); `running` says whether a job was already in the slot.
        result = await entry.run(entry.controller.signal, {
          slotWaitMs: Math.max(0, entry.startedAt - entry.enqueuedAt),
          queueDepth: entry.queueDepth,
          running: entry.runningWhenQueued,
        });
        checkAbort(entry.controller.signal);
        entry.resolve(result);
        delivered = true;
      } catch (error) {
        // Undelivered: no consumer holds this audio, so the producer deletes it before rejecting.
        if (!delivered) await removeUndeliveredAudio(result);
        entry.reject(entry.controller.signal.aborted ? entry.controller.signal.reason : error);
      } finally {
        entry.off();
        if (active === entry) active = null;
        pump();
      }
    })();
  };
  return {
    run(run, signal, { priority = 0, preemptWarmup = false } = {}) {
      try { checkAbort(signal); } catch (error) { return Promise.reject(error); }
      // Warm-up is the only negative-priority producer. A real request that arrives before it
      // starts cancels it from the waiting list; a warm-up that already owns the slot is never
      // preempted, so a nearly finished load cannot be thrown away by a later utterance.
      if (preemptWarmup === true && priority >= 0) {
        for (let index = waiting.length - 1; index >= 0; index -= 1) {
          const item = waiting[index];
          if (item.priority >= 0) continue;
          waiting.splice(index, 1);
          item.cancel(Object.assign(new Error('Warm-up superseded by speech'), { code: 'TTS_WARMUP_PREEMPTED' }));
        }
      }
      if (waiting.length >= SLOT_LIMIT) return Promise.reject(Object.assign(new Error('TTS queue full'), { code: 'TTS_QUEUE_FULL' }));
      return new Promise((resolve, reject) => {
        const controller = new AbortController();
        const entry = {
          run, resolve, reject, controller, running: false, priority,
          // Slot-queue observations, captured at enqueue: how many jobs (running + waiting) were
          // ahead of this one and whether the slot was already held. Monotonic, so `slotWaitMs`
          // is a real duration and never shares a clock with the provider measurement.
          enqueuedAt: monotonicNow(),
          startedAt: 0,
          queueDepth: waiting.length + (active === null ? 0 : 1),
          runningWhenQueued: active !== null,
          off: () => signal?.removeEventListener('abort', abort),
        };
        const abort = () => {
          controller.abort(signal?.reason ?? abortError());
          if (!entry.running) {
            const index = waiting.indexOf(entry);
            if (index !== -1) waiting.splice(index, 1);
            entry.off();
            reject(controller.signal.reason);
          }
        };
        entry.cancel = (reason = abortError()) => {
          controller.abort(reason);
          if (!entry.running) { entry.off(); reject(controller.signal.reason); }
        };
        signal?.addEventListener('abort', abort, { once: true });
        // P-65: a block of the sentence already playing jumps ahead of queued sentence prefetch;
        // equal priorities stay FIFO, so every existing caller keeps the old order. Warm-up uses
        // a negative priority, so every real request (including priority 0) goes before it.
        const ahead = waiting.findIndex((item) => item.priority < priority);
        const index = ahead === -1 ? waiting.length : ahead;
        waiting.splice(index, 0, entry);
        pump();
      });
    },
    cancel() {
      const hadWork = active !== null || waiting.length > 0;
      const queued = waiting.splice(0);
      for (const entry of queued) entry.cancel();
      active?.cancel();
      return hadWork;
    },
    drain() {
      return active === null && waiting.length === 0 ? Promise.resolve() : new Promise((resolve) => idle.add(resolve));
    },
  };
}
const synthesisSlots = createSlots();
const playbackSlots = createSlots();
const sentenceSlots = createSlots();
let weightsEpoch = 0;
let providerGeneration = 0;

/** Capture before any queue wait. Ordinary edits cannot change later sentences of this reply. */
export function captureTtsSnapshot() {
  const settings = gptSovitsSettings();
  if (settings === null) return Object.freeze({ settings: null, weightsEpoch });
  const copy = structuredClone(settings);
  if (copy.models) Object.freeze(copy.models);
  if (copy.applied) Object.freeze(copy.applied);
  return Object.freeze({ settings: Object.freeze(copy), weightsEpoch });
}

/** Synchronously close both gates; running transports finish their own cleanup before the next slot. */
export function stopTts() {
  const sentences = sentenceSlots.cancel();
  const synthesizing = synthesisSlots.cancel();
  return stopPlayback() || synthesizing || sentences;
}

async function boundedBody(response, { signal, maxBytes }) {
  checkAbort(signal);
  const length = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(length) && length > maxBytes) {
    await response.body?.cancel?.().catch(() => {});
    throw audioLimit();
  }
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const buffers = [];
    let size = 0;
    const abort = () => { void reader.cancel(signal.reason).catch(() => {}); };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      for (;;) {
        checkAbort(signal);
        const { done, value } = await reader.read();
        checkAbort(signal);
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) throw audioLimit();
        buffers.push(Buffer.from(value));
      }
      return Buffer.concat(buffers, size);
    } catch (error) {
      await reader.cancel(error).catch(() => {});
      throw error;
    } finally {
      signal?.removeEventListener('abort', abort);
      reader.releaseLock();
    }
  }
  // Compatibility for existing transport doubles; real fetch responses use the bounded reader.
  const buffer = Buffer.from(await response.arrayBuffer());
  checkAbort(signal);
  if (buffer.length > maxBytes) throw audioLimit();
  return buffer;
}

async function saveAudio(file, buffer, signal) {
  try {
    checkAbort(signal);
    await writeFile(file, buffer, { signal });
    checkAbort(signal);
  } catch (error) {
    await rm(file, { force: true });
    throw error;
  }
}

/**
 * Clamp `gptSovits.timeoutMs` into the supported range. Missing/invalid values use the 30 s
 * default; a numeric string is accepted because the settings card posts form values.
 */
export function resolveGptSovitsTimeout(settings) {
  const raw = settings?.timeoutMs;
  const value = typeof raw === 'number'
    ? raw
    : (typeof raw === 'string' && raw.trim().length > 0 ? Number(raw) : Number.NaN);
  if (!Number.isFinite(value)) return DEFAULT_GPT_SOVITS_TIMEOUT_MS;
  return Math.min(GPT_SOVITS_TIMEOUT_MAX_MS, Math.max(GPT_SOVITS_TIMEOUT_MIN_MS, Math.round(value)));
}

/**
 * Wire the provider and the event hooks. `resolveProbe` returns an ffmpeg path (ffprobe is
 * preferred when it sits next to it); `probeReference` replaces the whole measurement.
 * `onGptSovitsWarmupEvent` receives `tts.warmup.*` identity/status rows, and `warmupRetryDelays`
 * bounds automatic retries (default: two retries, 15 s then 60 s). `configureTts` also starts a
 * new warm-up generation: the next `warmupGptSovits()` may run.
 */
export function configureTts({
  gptSovits,
  onGptSovitsFailed,
  onGptSovitsSkipped,
  onGptSovitsWarning,
  onGptSovitsWarmupFailed,
  onGptSovitsWarmupEvent,
  warmupRetryDelays: retryDelays,
  onSlotWait,
  onTtsRequest,
  coldStartRequests,
  edgeSynthesize,
  resolveProbe,
  probeReference,
  removeAudioFile,
  onAudioCleanupFailed,
} = {}) {
  providerGeneration++;
  gptSovitsProvider = typeof gptSovits === 'function' ? gptSovits : null;
  gptSovitsFailureHook = typeof onGptSovitsFailed === 'function' ? onGptSovitsFailed : null;
  gptSovitsSkippedHook = typeof onGptSovitsSkipped === 'function' ? onGptSovitsSkipped : null;
  gptSovitsWarningHook = typeof onGptSovitsWarning === 'function' ? onGptSovitsWarning : null;
  gptSovitsWarmupFailureHook = typeof onGptSovitsWarmupFailed === 'function' ? onGptSovitsWarmupFailed : null;
  gptSovitsWarmupEventHook = typeof onGptSovitsWarmupEvent === 'function' ? onGptSovitsWarmupEvent : null;
  warmupRetryDelays = Array.isArray(retryDelays)
    ? Object.freeze(retryDelays
      .filter((value) => Number.isFinite(value) && value >= 0)
      .map((value) => Math.min(120_000, Math.round(value)))
      .slice(0, 5))
    : DEFAULT_WARMUP_RETRY_DELAYS;
  ttsSlotWaitHook = typeof onSlotWait === 'function' ? onSlotWait : null;
  ttsRequestHook = typeof onTtsRequest === 'function' ? onTtsRequest : null;
  // A fresh provider generation is a fresh service start: cold-start counting begins again.
  ttsColdStartLimit = Number.isInteger(coldStartRequests) && coldStartRequests >= 0
    ? coldStartRequests : TTS_COLD_START_REQUESTS;
  ttsRequestsSinceStart = 0;
  ttsColdAfterWarmup = false;
  edgeSynthesizeOverride = typeof edgeSynthesize === 'function' ? edgeSynthesize : null;
  referenceProbeResolver = typeof resolveProbe === 'function' ? resolveProbe : null;
  referenceProbeOverride = typeof probeReference === 'function' ? probeReference : null;
  audioRemover = typeof removeAudioFile === 'function' ? removeAudioFile : null;
  audioCleanupFailureHook = typeof onAudioCleanupFailed === 'function' ? onAudioCleanupFailed : null;
  referenceCache.clear();
  // A new provider generation supersedes every older warm-up. A queued warm-up is removed before
  // it can reach the new server; a running one is allowed to finish (no preemption of started
  // work) but its identity guard marks the completion stale.
  const previousWarmup = gptSovitsWarmup;
  gptSovitsWarmup = null;
  if (previousWarmup !== null) {
    if (previousWarmup.retryTimer !== null) clearTimeout(previousWarmup.retryTimer);
    previousWarmup.retryTimer = null;
    previousWarmup.superseded = true;
    previousWarmup.staleReason = 'generation-changed';
    if (previousWarmup.status === 'queued') {
      previousWarmup.launch?.controller.abort(Object.assign(
        new Error('Warm-up superseded by configuration'), { code: 'TTS_WARMUP_STALE' },
      ));
    }
  }
}

function gptSovitsSettings() {
  if (gptSovitsProvider === null) return null;
  try {
    const settings = gptSovitsProvider();
    return settings !== null && typeof settings === 'object' ? settings : null;
  } catch {
    return null;
  }
}

/** A reference clip is mandatory for the stock API; empty means "cannot serve this voice". */
function hasReference(settings) {
  return String(settings?.refAudioPath ?? '').trim().length > 0;
}

/** Both weight paths exist: some deployments serve /tts without a reference clip then. */
function hasLoadedModels(settings) {
  const models = settings?.models ?? {};
  return String(models.gptModelPath ?? '').trim().length > 0
    && String(models.sovitsModelPath ?? '').trim().length > 0;
}

/**
 * Resolve `text_lang` / `prompt_lang` for one synthesis request.
 *
 * `text_lang` describes the text actually handed to TTS. `textLang` is that language from the
 * call that prepared the line (the speech outlet's `speechLang`): it always wins, because a
 * translation that fell back to Chinese must be synthesized as Chinese even when the settings
 * card pinned `text_lang`. `settings.textLang` only covers a direct caller that did not prepare
 * a line. `prompt_lang` describes the reference clip, so it keeps following the setting (and
 * `langs.speech` when unpinned).
 */
export function resolveGptLangs(settings, speech = 'zh', { textLang = '' } = {}) {
  const wanted = String(speech ?? '').toLowerCase();
  const fallback = TTS_LANGS.has(wanted) ? wanted : 'zh';
  const pick = (value) => {
    const lang = String(value ?? '').trim().toLowerCase();
    return TTS_LANGS.has(lang) ? lang : '';
  };
  return {
    textLang: pick(textLang) || pick(settings?.textLang) || fallback,
    promptLang: pick(settings?.promptLang) || fallback,
  };
}

/** ffprobe next to ffmpeg when the build ships it; `ffmpeg -i` is the fallback reader. */
function resolveProbeExecutable() {
  const ffmpeg = typeof referenceProbeResolver === 'function' ? referenceProbeResolver() : null;
  if (typeof ffmpeg !== 'string' || ffmpeg.length === 0) return null;
  const ffprobe = ffmpeg.replace(/ffmpeg(\.exe)?$/u, (match, ext) => `ffprobe${ext ?? ''}`);
  return existsSync(ffprobe) ? ffprobe : ffmpeg;
}

function ffprobeSeconds(text) {
  const seconds = Number.parseFloat(String(text ?? '').trim());
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

/** `ffmpeg -i` prints `Duration: 00:00:08.40` on stderr and exits non-zero without an output. */
function ffmpegSeconds(stderr) {
  const match = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/u.exec(String(stderr ?? ''));
  if (match === null) return null;
  const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

function probeWithFfmpeg(file, signal) {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const executable = resolveProbeExecutable();
    if (executable === null) {
      resolve(null);
      return;
    }
    const isFfprobe = /ffprobe(\.exe)?$/u.test(executable);
    const args = isFfprobe
      ? ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]
      : ['-hide_banner', '-i', file];
    try {
      let child;
      const abort = () => { try { child?.kill(); } catch { /* callback owns release */ } };
      child = execFile(executable, args, { windowsHide: true, timeout: REFERENCE_PROBE_TIMEOUT_MS }, (_error, stdout, stderr) => {
        signal?.removeEventListener('abort', abort);
        if (signal?.aborted) reject(signal.reason);
        else resolve(isFfprobe ? ffprobeSeconds(stdout) : ffmpegSeconds(stderr));
      });
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    } catch {
      resolve(null);
    }
  });
}

/**
 * Measured reference-clip length in seconds, or null when no tool could read it. Cached per
 * path+mtime+size because /assistant/status asks on every poll.
 */
async function measureReference(file, signal) {
  checkAbort(signal);
  const path = String(file ?? '').trim();
  if (path.length === 0) return { seconds: null, readable: false };
  if (referenceProbeOverride !== null) {
    let measured = null;
    try {
      measured = await referenceProbeOverride(path, { signal });
    } catch {
      /* an injected probe never breaks the guard */
    }
    checkAbort(signal);
    const seconds = Number.isFinite(measured) && measured > 0 ? measured : null;
    return { seconds, readable: seconds !== null };
  }
  let key = '';
  try {
    const info = await stat(path);
    key = `${info.size}:${info.mtimeMs}`;
  } catch {
    return { seconds: null, readable: false };
  }
  const cached = referenceCache.get(path);
  if (cached !== undefined && cached.key === key
    && (cached.seconds !== null || Date.now() - cached.at < REFERENCE_PROBE_RETRY_MS)) {
    return { seconds: cached.seconds, readable: cached.seconds !== null };
  }
  checkAbort(signal);
  const seconds = await probeWithFfmpeg(path, signal);
  checkAbort(signal);
  referenceCache.set(path, { key, at: Date.now(), seconds });
  return { seconds, readable: seconds !== null };
}

/** The stock API only accepts a 3–10 s clip, so anything else is never sent. */
export function referenceRangeOk(seconds) {
  return typeof seconds === 'number' && seconds >= REFERENCE_MIN_SECONDS && seconds <= REFERENCE_MAX_SECONDS;
}

/** Status-card diagnostics for the configured clip; never throws. */
export async function gptSovitsReferenceStatus() {
  const probe = await measureReference(gptSovitsSettings()?.refAudioPath);
  return { seconds: probe.seconds, ok: referenceRangeOk(probe.seconds), readable: probe.readable };
}

const GPT_BODY_LIMIT = 400;

/** Keep the first 400 characters of an error body so the event log can explain a 400. */
function clipGptBody(value) {
  return String(value ?? '').slice(0, GPT_BODY_LIMIT);
}

/** Event hooks are best-effort: a logging failure must never block the Edge fallback. */
async function notifyHook(hook, payload) {
  try {
    await hook?.(payload);
  } catch {
    /* logging must never block the fallback */
  }
}

/** The provider id (`edge-tts`) is recorded as the engine name the log already uses (`edge`). */
function ttsEngineName(value) {
  const name = typeof value === 'string' ? value : '';
  if (name === 'edge-tts') return 'edge';
  if (name === 'gpt-sovits') return 'gpt-sovits';
  return name.length > 0 ? name : null;
}

/**
 * A stable diagnostic code instead of the provider message: that message may echo the spoken text
 * (`error.body` from /tts), and this event must never carry text.
 */
function ttsErrorCode(error) {
  if (error?.name === 'AbortError') return 'TTS_ABORTED';
  const code = typeof error?.code === 'string' ? error.code : '';
  if (code === 'TTS_AUDIO_LIMIT' || code === 'TTS_QUEUE_FULL' || code === 'TTS_TEXT_LIMIT') return code;
  if (Number.isInteger(error?.timeoutMs)) return 'TTS_TIMEOUT';
  if (Number.isInteger(error?.status)) return `TTS_HTTP_${error.status}`;
  return code.length > 0 ? code : 'TTS_FAILED';
}

/**
 * P-46: optional turn attribution, copied from the caller exactly as supplied.
 *
 * Observation only. A request that names no turn keeps `null` on all four fields: the clock is
 * never used to guess one, and no id is derived from the text or from the queue. `speechId` is the
 * host ledger id of the accepted line/block; it is null for a lane that synthesizes before a
 * ledger record exists. Adding these fields changes nothing about slot waiting, synthesis or
 * caching.
 */
function turnAttribution(request) {
  const id = (value) => (typeof value === 'string' && value.length > 0 ? value : null);
  return {
    turn: Number.isInteger(request?.turn) ? request.turn : null,
    deliveryMessageId: id(request?.deliveryMessageId),
    sessionId: id(request?.sessionId),
    speechId: id(request?.speechId),
  };
}

/** The first N requests of this provider generation, or the first one after a successful warm-up. */
function takeTtsColdStart() {
  const cold = ttsColdAfterWarmup === true || ttsRequestsSinceStart < ttsColdStartLimit;
  ttsColdAfterWarmup = false;
  ttsRequestsSinceStart += 1;
  return cold;
}

/**
 * `voice.tts.request`: one debug row per finished synthesis request.
 *
 * Observation only: never awaited (logging cannot delay audio), never throws, and never carries
 * the spoken text — characters, engine and times only. The queue wait and the provider round trip
 * stay separate measurements; `totalMs` is their sum, never a re-measurement of the wall clock.
 * `requestMs` is the clip's synthesis time, except for a streamed request where the provider
 * round trip ends at the FIRST audio byte (`streamed: true`); the rest of a stream is playback.
 * Both `slotWaitMs` and `requestMs` are process-local durations measured with the monotonic clock;
 * wall time is only used for the correlation `at` kept by the caller.
 * Turn attribution (`turn`/`deliveryMessageId`/`sessionId`/`speechId`) is copied from the caller
 * or null.
 */
function reportTtsRequest(request, { slot = null, slotWaitMs = 0, startedAt = 0, requestMs = null,
  result, error, attempts = [], retryErrorCode = null, streamed = false } = {}) {
  if (ttsRequestHook === null) return;
  const wait = Math.max(0, Math.round(Number(slotWaitMs) || 0));
  const elapsed = requestMs === null
    ? (Number(startedAt) > 0 ? Math.max(0, Math.round(monotonicNow() - Number(startedAt))) : 0)
    : Math.max(0, Math.round(Number(requestMs) || 0));
  const seen = Array.isArray(attempts) ? attempts : [];
  const payload = {
    level: 'debug',
    purpose: String(request?.purpose ?? 'speech'),
    // P-46: which turn/session this synthesis belongs to; null when the caller named none.
    ...turnAttribution(request),
    engine: ttsEngineName(result?.provider ?? seen.at(-1)),
    chars: [...String(request?.text ?? '')].length,
    slotWaitMs: wait,
    requestMs: elapsed,
    totalMs: wait + elapsed,
    ok: error === undefined,
    errorCode: error === undefined ? null : ttsErrorCode(error),
    cached: request?.cached === true,
    chunkIndex: Number.isInteger(request?.chunkIndex) ? request.chunkIndex : null,
    sentenceId: Number.isInteger(request?.sentenceId) ? request.sentenceId : null,
    coldStart: takeTtsColdStart(),
    retried: seen.length > 1,
    retries: Math.max(0, seen.length - 1),
    retryErrorCode: seen.length > 1 ? retryErrorCode : null,
    queueDepth: Math.max(0, Math.round(Number(slot?.queueDepth) || 0)),
    priority: Number(request?.priority) || 0,
    streamed: streamed === true,
  };
  void notifyHook(ttsRequestHook, payload);
}

/**
 * Select the observed `voice.tts.request` rows that describe one FIRST BLOCK.
 *
 * Only a completed (`ok`) `answer` request with `chunkIndex: 0` counts. Optional identity fields
 * narrow the match: when the caller names a turn / delivery / session / sentence, a row with a
 * different value is never used for that observation. Rows are returned oldest-first so a caller
 * can read either the first row of a round (the first sentence's block 0) or the latest row (the
 * request that just finished). `from`/`observedAt` are WALL stamps used only to correlate rows with
 * the call that produced them; the durations inside a row are monotonic.
 *
 * @param {{rows?: Array<{at: number, payload: object}>, purpose?: string, turn?: number|null,
 *   deliveryMessageId?: string|null, sessionId?: string|null, sentenceId?: number|null,
 *   chunkIndex?: number, from?: number, observedAt?: number}} [options]
 * @returns {Array<{at: number, payload: object}>}
 */
export function firstBlockRequestRows({
  rows = [], purpose = 'answer', turn = null, deliveryMessageId = null, sessionId = null,
  sentenceId = null, chunkIndex = 0, from = 0, observedAt = 0,
} = {}) {
  const lower = Number(from);
  const upper = Number(observedAt);
  const wantedTurn = Number.isSafeInteger(turn) ? turn : null;
  const wantedDelivery = typeof deliveryMessageId === 'string' && deliveryMessageId.length > 0
    ? deliveryMessageId : null;
  const wantedSession = typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : null;
  const wantedSentence = Number.isSafeInteger(sentenceId) ? sentenceId : null;
  const wantedChunk = Number.isSafeInteger(chunkIndex) ? chunkIndex : 0;
  const matched = [];
  for (const entry of Array.isArray(rows) ? rows : []) {
    if (entry === null || typeof entry !== 'object') continue;
    const at = Number(entry.at);
    if (!Number.isFinite(at)) continue;
    if (Number.isFinite(lower) && lower > 0 && at < lower) continue;
    if (Number.isFinite(upper) && upper > 0 && at > upper) continue;
    const row = entry.payload;
    if (row === null || typeof row !== 'object') continue;
    if (row.purpose !== purpose || row.ok !== true) continue;
    if (row.chunkIndex !== wantedChunk) continue;
    if (wantedSentence !== null && row.sentenceId !== wantedSentence) continue;
    if (wantedTurn !== null && row.turn !== wantedTurn) continue;
    if (wantedDelivery !== null && row.deliveryMessageId !== wantedDelivery) continue;
    if (wantedSession !== null && row.sessionId !== wantedSession) continue;
    matched.push({ at, payload: row });
  }
  return matched.sort((a, b) => a.at - b.at);
}

/**
 * Resolve ONE unit-sizer sample from the synthesis rows.
 *
 * The value fed to the EWMA is the first block's own `requestMs` (slot acquired -> synthesis end).
 * The host await time is NOT used when a row is present: queued time is queue time, not provider
 * speed. `fallbackMs` (the caller's monotonic await time) is returned with
 * `source: 'fallback-total'` only when no matching row exists, so the old behavior is kept and its
 * lower precision is visible in the event log instead of silently polluting the estimate.
 *
 * A `requestMs` of 0 is a cache hit / no measured synthesis: it is reported as `cache-hit` with
 * `observe: false`, so a free lookup can never claim an infinitely fast provider.
 *
 * @param {object} [options] same row filter as `firstBlockRequestRows`, plus:
 * @param {number} [options.fallbackMs] monotonic host await time, used only when no row matches
 * @param {number} [options.chars] characters of the block that was synthesized
 * @returns {{ms: number, chars: number, source: 'request'|'cache-hit'|'fallback-total',
 *   observe: boolean, slotWaitMs: number|null, requestMs: number|null, cached: boolean|null,
 *   at: number|null}}
 */
export function resolveUnitSizerSample({
  rows = [], purpose = 'answer', turn = null, deliveryMessageId = null, sessionId = null,
  sentenceId = null, chunkIndex = 0, from = 0, observedAt = 0, fallbackMs = 0, chars = 0,
} = {}) {
  const size = Math.max(0, Math.round(Number(chars) || 0));
  const fallback = Math.max(0, Math.round(Number(fallbackMs) || 0));
  const matched = firstBlockRequestRows({
    rows, purpose, turn, deliveryMessageId, sessionId, sentenceId, chunkIndex, from, observedAt,
  });
  for (let index = matched.length - 1; index >= 0; index -= 1) {
    const hit = matched[index];
    const requestMs = Number(hit.payload.requestMs);
    if (!Number.isFinite(requestMs) || requestMs < 0) continue;
    const ms = Math.round(requestMs);
    const cached = hit.payload.cached === true || ms === 0;
    const wait = Number(hit.payload.slotWaitMs);
    return {
      ms,
      chars: size,
      // A 0 ms round trip measured no synthesis cost; feeding it to the EWMA would claim a
      // provider that synthesizes any block instantly. Keep it visible, never observed.
      source: ms === 0 ? 'cache-hit' : 'request',
      observe: ms > 0,
      slotWaitMs: Number.isFinite(wait) && wait >= 0 ? Math.round(wait) : null,
      requestMs: ms,
      cached,
      at: hit.at,
    };
  }
  return {
    ms: fallback,
    chars: size,
    source: 'fallback-total',
    observe: fallback > 0,
    slotWaitMs: null,
    requestMs: null,
    cached: null,
    at: null,
  };
}

/**
 * The first-chunk breakdown of `voice.pipeline.timeline`.
 *
 * Only the reply body's real block 0 counts (`purpose: 'answer'`, `sentenceId: 0`,
 * `chunkIndex: 0`). An ack/progress/tool row and a later block are never read, and several blocks
 * of the same turn are never summed. `firstChunkQueueWaitMs`/`firstChunkTtsMs` are kept for
 * compatibility; `firstChunkSlotWaitMs`/`firstChunkRequestMs` make the same measurements explicit,
 * and `firstChunkAudioReadyMs` is derived from the already-measured first-chunk stage. A stage
 * that was not measured is null, never a fabricated 0.
 *
 * @param {{rows?: Array<{at: number, payload: object}>, streamed?: object|null, origin?: number,
 *   audioReadyMs?: number|null}} [options]
 * @returns {object}
 */
export function buildFirstChunkBreakdown({
  rows = [], streamed = null, origin = 0, audioReadyMs = null,
} = {}) {
  const matched = firstBlockRequestRows({
    rows, purpose: 'answer', sentenceId: 0, chunkIndex: 0, from: origin,
  });
  const request = matched.length > 0 ? matched[0].payload : null;
  const measured = (value) => {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? Math.round(number) : null;
  };
  const translateMs = Number(streamed?.firstTranslateMs);
  return {
    firstChunkQueueWaitMs: request === null ? null : measured(request.slotWaitMs),
    firstChunkTranslateMs: streamed?.firstTranslated === true
      ? (Number.isFinite(translateMs) && translateMs >= 0 ? Math.round(translateMs) : null)
      : (streamed === null ? null : 0),
    firstChunkKanaMs: request === null ? null : 0,
    firstChunkTtsMs: request === null ? null : measured(request.requestMs),
    firstChunkChars: request === null ? null : measured(request.chars),
    ttsColdStart: request === null
      ? null
      : (typeof request.coldStart === 'boolean' ? request.coldStart : null),
    // Explicit identity of the same first block: queue wait and provider round trip stay apart.
    firstChunkSlotWaitMs: request === null ? null : measured(request.slotWaitMs),
    firstChunkRequestMs: request === null ? null : measured(request.requestMs),
    // Derived from the pipeline's own first-chunk stage; null when that boundary was never hit.
    firstChunkAudioReadyMs: measured(audioReadyMs),
  };
}

/** Read sample rate/byte rate straight from the RIFF header — no ffprobe dependency. */
function wavDurationMs(buffer) {
  try {
    if (buffer.length < 44) return null;
    if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') return null;
    let offset = 12;
    let byteRate = 0;
    while (offset + 8 <= buffer.length) {
      const id = buffer.toString('ascii', offset, offset + 4);
      const size = buffer.readUInt32LE(offset + 4);
      if (id === 'fmt ' && offset + 20 <= buffer.length) {
        byteRate = buffer.readUInt32LE(offset + 16);
      } else if (id === 'data') {
        const start = offset + 8;
        const bytes = Math.min(size, buffer.length - start);
        if (byteRate > 0 && bytes > 0) return Math.round((bytes / byteRate) * 1000);
        return null;
      }
      offset += 8 + size + (size % 2);
    }
  } catch {
    /* malformed header: fall back to the text estimate */
  }
  return null;
}

/** Conservative Chinese pacing (~4.5 chars/s) when the wav header cannot be parsed. */
function estimateDurationMs(text) {
  return Math.max(400, Math.round(text.length * 220));
}

/**
 * GPT-SoVITS HTTP API: GET /tts returns one 16-bit PCM wav. Any failure (timeout, non-200,
 * non-RIFF body) is reported and treated as "not available", so synthesize() falls back to Edge.
 */
async function synthesizeGptSovits({ text, dir, speech = 'zh', textLang = '', settings = gptSovitsSettings() ?? {}, signal, maxBytes = TTS_AUDIO_MAX_BYTES }) {
  checkAbort(signal);
  const langs = resolveGptLangs(settings, speech, { textLang });
  const base = String(settings.apiBase ?? '').trim().replace(/\/+$/u, '');
  const timeoutMs = resolveGptSovitsTimeout(settings);
  const params = [
    ['text', text],
    ['text_lang', langs.textLang],
    ['ref_audio_path', String(settings.refAudioPath ?? '')],
    ['prompt_lang', langs.promptLang],
    ['prompt_text', String(settings.promptText ?? '')],
    ['media_type', 'wav'],
  ].map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');

  const startedAt = monotonicNow();
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason ?? abortError());
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let buffer;
  try {
    const response = await fetch(`${base}/tts?${params}`, {
      signal: controller.signal,
      headers: { accept: 'audio/wav, audio/*' },
    });
    if (!response.ok) {
      let body = '';
      try {
        // The local server answers JSON that may carry Chinese without an explicit charset;
        // decode the raw bytes as UTF-8 so the event keeps the readable message.
        const buffer = await boundedBody(response, { signal: controller.signal, maxBytes });
        body = clipGptBody(buffer.toString('utf8'));
      } catch {
        /* the status alone still identifies the failure */
      }
      const error = new Error(`GPT-SoVITS HTTP ${response.status}`);
      error.status = response.status;
      error.body = body;
      throw error;
    }
    buffer = await boundedBody(response, { signal: controller.signal, maxBytes });
  } catch (error) {
    checkAbort(signal);
    if (error?.name === 'AbortError') {
      const elapsedMs = Math.round(monotonicNow() - startedAt);
      // The cold-start load is the real cause: say how long it actually took and what to change.
      const timeout = new Error(
        `GPT-SoVITS 超时（上限 ${timeoutMs} ms，实际耗时 ${elapsedMs} ms；首次调用可能较慢，请重试或调大 gptSovits.timeoutMs）`,
      );
      timeout.timeoutMs = timeoutMs;
      timeout.elapsedMs = elapsedMs;
      timeout.cause = error;
      throw timeout;
    }
    throw error instanceof Error ? error : new Error(String(error));
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }

  if (buffer.length === 0) throw new Error('GPT-SoVITS produced no audio');
  // Some errors still answer 200 with a JSON body; only RIFF counts as audio.
  if (buffer.toString('ascii', 0, 4) !== 'RIFF') {
    const body = clipGptBody(buffer.toString('utf8', 0, Math.min(buffer.length, GPT_BODY_LIMIT)));
    const error = new Error(`GPT-SoVITS 返回非 wav 数据：${body.slice(0, 120)}`);
    error.status = 200;
    error.body = body;
    throw error;
  }

  await mkdir(dir, { recursive: true });
  const file = join(dir, `${randomUUID()}.wav`);
  await saveAudio(file, buffer, signal);
  return {
    file,
    bytes: buffer.length,
    durationMs: wavDurationMs(buffer) ?? estimateDurationMs(text),
    provider: 'gpt-sovits',
  };
}

/**
 * Load the model into VRAM before the first real utterance. Fire-and-forget: scheduled by the
 * host after startup, when GPT-SoVITS is first enabled and after its configuration changes. The
 * request is a one-character synthesis through the same /tts path, so it warms exactly what the
 * first real sentence needs.
 *
 * Identity is the backend address + model configuration version + reference-audio version +
 * reference text + resolved language configuration. The same identity shares the in-flight
 * promise and is warmed at most once while it stays `ready`; a changed identity queues a new
 * warm-up and every completion is guarded so an old run can never mark the new identity ready.
 *
 * Warm-up uses a negative synthesis-slot priority: any real request goes before it, and a real
 * request that arrives before the warm-up started removes it from the waiting list. A warm-up
 * that already owns the slot is never preempted; real speech simply waits behind it.
 *
 * A failure only reaches the dedicated warm-up hooks (`tts.warmup.failed` /
 * `tts.gptsovits.warmup.failed`); it never throws, never blocks a real request, and does not mark
 * the provider unusable. At most `warmupRetryDelays.length` automatic retries follow, with the
 * configured backoff, before the identity stays `failed` until it changes.
 *
 * @param {{dir: string, speech?: string, signal?: AbortSignal}} options
 * @returns {Promise<{ok: boolean, skipped?: string, bytes?: number, error?: string,
 *   key?: string, status?: string}>}
 */
export function warmupGptSovits({ dir, speech = 'ja', signal } = {}) {
  const snapshot = captureTtsSnapshot();
  const settings = snapshot.settings;
  if (settings === null || settings.enabled !== true) {
    return Promise.resolve({ ok: false, skipped: 'disabled', status: 'unknown' });
  }
  const identity = buildWarmupIdentity(settings, speech, snapshot.weightsEpoch);
  const same = gptSovitsWarmup !== null
    && gptSovitsWarmup.key === identity.key
    && gptSovitsWarmup.generation === providerGeneration;
  if (same) {
    const current = gptSovitsWarmup;
    if (current.status === 'ready') {
      return Promise.resolve({ ok: true, skipped: 'already-warm', key: current.key, status: 'ready' });
    }
    if (current.status === 'queued' || current.status === 'warming') return current.promise;
    if (current.status === 'failed') {
      if (current.retryTimer !== null) {
        return Promise.resolve({
          ok: false, skipped: 'retry-scheduled', key: current.key, status: 'failed',
          attempts: current.attempts, retryInMs: Math.max(0, current.retryAt - Date.now()),
        });
      }
      if (current.retryable === true && current.attempts > warmupRetryDelays.length) {
        return Promise.resolve({
          ok: false, skipped: 'retry-exhausted', key: current.key, status: 'failed',
          attempts: current.attempts,
        });
      }
      // A manual trigger after a non-retryable skip, or after the last backoff elapsed, starts a
      // fresh attempt for the same identity. Attempts are retained so repeated failures stay capped.
      current.status = 'unknown';
    }
    return startWarmupAttempt(current, { dir, speech, signal, reason: 'manual' });
  }

  const previous = gptSovitsWarmup;
  if (previous !== null) {
    if (previous.retryTimer !== null) clearTimeout(previous.retryTimer);
    previous.retryTimer = null;
    previous.retryAt = 0;
    previous.superseded = true;
    previous.staleReason = 'identity-changed';
    // A warm-up that has not started yet must not hold the slot or reach the new backend. One
    // that is already warming is allowed to finish; its completion is guarded as stale.
    if (previous.status === 'queued') {
      previous.launch?.controller.abort(Object.assign(
        new Error('Warm-up superseded by a new identity'), { code: 'TTS_WARMUP_STALE' },
      ));
    }
  }
  const state = {
    key: identity.key,
    identity,
    generation: providerGeneration,
    snapshot,
    request: { dir, speech },
    status: 'unknown',
    attempts: 0,
    retryable: false,
    lastErrorCode: null,
    retryTimer: null,
    retryAt: 0,
    promise: null,
    launch: null,
    superseded: false,
    staleReason: '',
    startedAt: 0,
    finishedAt: 0,
  };
  gptSovitsWarmup = state;
  return startWarmupAttempt(state, { dir, speech, signal, reason: 'request' });
}

/** A stable identity for the current warm-up inputs; deliberately hash-only for event payloads. */
function buildWarmupIdentity(settings, speech, epoch) {
  const lang = TTS_LANGS.has(String(speech ?? '').toLowerCase())
    ? String(speech).toLowerCase() : 'ja';
  const langs = resolveGptLangs(settings, lang);
  const apiBase = String(settings?.apiBase ?? '').trim().replace(/\/+$/u, '');
  const models = settings?.models ?? {};
  const applied = settings?.applied ?? {};
  const referencePath = String(settings?.refAudioPath ?? '').trim();
  const referenceVersion = (() => {
    if (referencePath.length === 0) return '';
    try {
      const info = statSync(referencePath);
      return `${info.size}:${Math.round(info.mtimeMs)}`;
    } catch {
      return 'missing';
    }
  })();
  const modelVersion = [
    String(models.gptModelPath ?? ''), String(models.sovitsModelPath ?? ''),
    String(applied.gptPath ?? ''), String(applied.sovitsPath ?? ''),
    Number(applied.at) || 0, Number(epoch) || 0,
  ].join('\u0000');
  const parts = [
    apiBase, modelVersion, referencePath, referenceVersion,
    String(settings?.promptText ?? ''), langs.textLang, langs.promptLang, lang,
  ];
  return {
    key: createHash('sha1').update(JSON.stringify(parts)).digest('hex'),
    speech: lang,
    langs,
  };
}

/**
 * Read the warm-up identity without revealing paths or the reference text. The key is a digest of
 * every input that makes a warm-up reusable; tests and diagnostics can compare it across edits.
 */
export function gptSovitsWarmupIdentity(options = {}) {
  const settings = options.settings === undefined ? gptSovitsSettings() : options.settings;
  if (settings === null || typeof settings !== 'object') return null;
  const identity = buildWarmupIdentity(settings, options.speech ?? 'ja', weightsEpoch);
  return {
    key: identity.key,
    generation: providerGeneration,
    speech: identity.speech,
    textLang: identity.langs.textLang,
    promptLang: identity.langs.promptLang,
  };
}

/** Current warm-up state, safe for the event log/status card: no paths, no text, no error bodies. */
export function gptSovitsWarmupStatus() {
  const state = gptSovitsWarmup;
  if (state === null) {
    return {
      status: 'unknown', key: null, generation: providerGeneration, attempts: 0,
      retryInMs: null, lastErrorCode: null, retryable: false,
    };
  }
  return {
    status: state.status,
    key: state.key,
    generation: state.generation,
    attempts: state.attempts,
    retryInMs: state.retryTimer === null ? null : Math.max(0, state.retryAt - Date.now()),
    lastErrorCode: state.lastErrorCode,
    retryable: state.retryable,
    startedAt: state.startedAt > 0 ? state.startedAt : null,
    finishedAt: state.finishedAt > 0 ? state.finishedAt : null,
  };
}

function emitWarmupEvent(event, state, extra = {}) {
  void notifyHook(gptSovitsWarmupEventHook, {
    event,
    type: event,
    key: state.key,
    generation: state.generation,
    status: state.status,
    at: Date.now(),
    ...extra,
  });
}

function warmupStaleReason(state, error) {
  if (state.superseded === true) return state.staleReason || 'superseded';
  if (error?.code === 'TTS_WARMUP_PREEMPTED') return 'preempted';
  if (error?.code === 'TTS_WARMUP_STALE') return 'superseded';
  if (state.generation !== providerGeneration) return 'generation-changed';
  if (state.snapshot.weightsEpoch !== weightsEpoch) return 'weights-changed';
  return 'cancelled';
}

function isCurrentWarmup(state, launch) {
  return gptSovitsWarmup === state
    && state.launch === launch
    && launch.controller.signal.aborted === false
    && state.generation === providerGeneration
    && state.snapshot.weightsEpoch === weightsEpoch;
}

function startWarmupAttempt(state, { dir, speech, signal, reason }) {
  state.status = 'queued';
  state.startedAt = 0;
  state.finishedAt = 0;
  state.lastErrorCode = null;
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(signal?.reason ?? abortError());
  const launch = { controller, started: false };
  state.launch = launch;
  if (signal?.aborted) forwardAbort();
  else signal?.addEventListener('abort', forwardAbort, { once: true });
  emitWarmupEvent('tts.warmup.queued', state, { reason });
  const promise = synthesisSlots.run(async (ownedSignal) => {
    if (!isCurrentWarmup(state, launch)) throw Object.assign(
      new Error('Warm-up superseded'), { code: 'TTS_WARMUP_STALE' },
    );
    launch.started = true;
    state.status = 'warming';
    state.startedAt = Date.now();
    emitWarmupEvent('tts.warmup.started', state);
    const result = await runWarmupSynthesis({
      dir, speech, signal: ownedSignal, settings: state.snapshot.settings, snapshot: state.snapshot,
    });
    return result;
  }, controller.signal, { priority: -1 })
    .then((result) => settleWarmup(state, launch, result))
    .catch((error) => failWarmupAttempt(state, launch, error))
    .finally(() => {
      signal?.removeEventListener('abort', forwardAbort);
      if (state.launch === launch) state.launch = null;
    });
  state.promise = promise;
  return promise;
}

function settleWarmup(state, launch, result) {
  const current = isCurrentWarmup(state, launch);
  if (!current) {
    emitWarmupEvent('tts.warmup.stale', state, { reason: warmupStaleReason(state) });
    return { ok: false, skipped: 'stale', key: state.key, status: state.status };
  }
  if (result?.ok !== true) {
    // A configuration skip is not a transport failure: report it once, but do not back off or
    // blame the server. A later explicit trigger may try again for the same identity.
    state.status = 'failed';
    state.retryable = false;
    state.lastErrorCode = `TTS_WARMUP_${String(result?.skipped ?? 'SKIPPED').toUpperCase().replace(/[^A-Z0-9]+/gu, '_')}`;
    state.finishedAt = Date.now();
    emitWarmupEvent('tts.warmup.failed', state, {
      reason: result?.skipped ?? 'skipped', errorCode: state.lastErrorCode, retryable: false,
    });
    return {
      ok: false, skipped: result?.skipped ?? 'skipped', key: state.key,
      status: 'failed', errorCode: state.lastErrorCode,
    };
  }
  state.status = 'ready';
  state.retryable = false;
  state.lastErrorCode = null;
  state.finishedAt = Date.now();
  // The first real request after a successful warm-up is still reported as cold.
  ttsColdAfterWarmup = true;
  emitWarmupEvent('tts.warmup.succeeded', state, { bytes: result.bytes });
  return { ok: true, bytes: result.bytes, key: state.key, status: 'ready' };
}

function failWarmupAttempt(state, launch, error) {
  const current = gptSovitsWarmup === state && state.launch === launch;
  const aborted = error?.name === 'AbortError'
    || error?.code === 'TTS_WARMUP_PREEMPTED'
    || error?.code === 'TTS_WARMUP_STALE';
  if (!current || aborted) {
    if (current) {
      state.status = 'unknown';
      state.retryable = false;
      state.lastErrorCode = null;
      state.finishedAt = Date.now();
    }
    emitWarmupEvent('tts.warmup.stale', state, { reason: warmupStaleReason(state, error) });
    return {
      ok: false, skipped: error?.code === 'TTS_WARMUP_PREEMPTED' ? 'preempted' : 'stale',
      key: state.key, status: state.status,
    };
  }
  state.attempts += 1;
  state.status = 'failed';
  state.retryable = true;
  state.lastErrorCode = ttsErrorCode(error);
  state.finishedAt = Date.now();
  scheduleWarmupRetry(state);
  emitWarmupEvent('tts.warmup.failed', state, {
    attempt: state.attempts,
    errorCode: state.lastErrorCode,
    retryable: state.retryTimer !== null,
    retryInMs: state.retryTimer === null ? null : Math.max(0, state.retryAt - Date.now()),
  });
  // Existing hook/event name kept for compatibility; it may carry the provider message, while the
  // additive `tts.warmup.*` stream above carries only the stable code.
  void notifyHook(gptSovitsWarmupFailureHook, {
    event: 'tts.warmup.failed',
    type: 'tts.warmup.failed',
    key: state.key,
    status: 'failed',
    attempt: state.attempts,
    errorCode: state.lastErrorCode,
    error: error?.message ?? String(error),
  });
  return {
    ok: false,
    error: error?.message ?? String(error),
    key: state.key,
    status: 'failed',
    attempt: state.attempts,
  };
}

function scheduleWarmupRetry(state) {
  if (state.retryTimer !== null) return;
  if (state.attempts > warmupRetryDelays.length) return;
  const delay = warmupRetryDelays[state.attempts - 1] ?? warmupRetryDelays.at(-1) ?? 0;
  state.retryAt = Date.now() + delay;
  state.retryTimer = setTimeout(() => {
    state.retryTimer = null;
    state.retryAt = 0;
    if (gptSovitsWarmup !== state || state.status !== 'failed') return;
    state.status = 'unknown';
    void warmupGptSovits(state.request).catch(() => {});
  }, delay);
  state.retryTimer.unref?.();
}

/**
 * The slot-owned half of a warm-up. It only synthesizes: playback is never opened. The clip is
 * deleted before the promise settles, including after an abort or a stale completion.
 */
async function runWarmupSynthesis({ dir, speech, signal, settings, snapshot }) {
  checkAbort(signal);
  if (snapshot.weightsEpoch !== weightsEpoch) throw abortError();
  if (settings?.enabled !== true) return { ok: false, skipped: 'disabled' };
  if (!hasReference(settings) && !hasLoadedModels(settings)) return { ok: false, skipped: 'no-reference' };
  if (typeof dir !== 'string' || dir.trim().length === 0) return { ok: false, skipped: 'no-dir' };
  if (hasReference(settings)) {
    // Mirror the normal guard: a clip the stock API rejects must not produce a noise failure.
    const probe = await measureReference(settings.refAudioPath, signal);
    if (probe.seconds !== null && !referenceRangeOk(probe.seconds)) {
      return { ok: false, skipped: 'reference-duration' };
    }
    if (String(settings.promptText ?? '').trim().length === 0 && !hasLoadedModels(settings)) {
      return { ok: false, skipped: 'no-prompt-text' };
    }
  }
  const lang = TTS_LANGS.has(String(speech ?? '').toLowerCase()) ? String(speech).toLowerCase() : 'ja';
  let result = null;
  try {
    result = await synthesizeGptSovits({
      text: WARMUP_TEXT[lang] ?? 'あ', dir, speech: lang, settings, signal,
    });
    checkAbort(signal);
    if (snapshot.weightsEpoch !== weightsEpoch) throw abortError();
    return { ok: true, bytes: result.bytes, durationMs: result.durationMs };
  } finally {
    // The tiny clip only exists to load the model; do not leave it in the cache, and do not leave
    // it behind when the run turned stale or was aborted.
    if (result?.file) await rm(result.file, { force: true }).catch(() => {});
  }
}

/**
 * Point the local GPT-SoVITS server at the saved gpt/sovits weights. Both endpoints are the
 * ones the official api server exposes; a server without them (or with the paths left empty)
 * just keeps the paths saved, so the caller only logs the outcome. Never throws.
 *
 * @returns {Promise<{ok: boolean, loaded: string[], skipped: string[], kind: string, error: string}>}
 */
export function loadGptSovitsModels() {
  const snapshot = captureTtsSnapshot();
  weightsEpoch++;
  stopTts();
  return synthesisSlots.run(async (signal) => {
    await playbackSlots.drain();
    checkAbort(signal);
    return loadGptSovitsModelsNow(snapshot.settings, signal);
  }, undefined, { preemptWarmup: true });
}

async function loadGptSovitsModelsNow(settings, signal) {
  checkAbort(signal);
  const base = String(settings?.apiBase ?? '').trim().replace(/\/+$/u, '');
  if (base.length === 0) return { ok: false, loaded: [], skipped: [], kind: '', error: '缺少 GPT-SoVITS API 地址' };
  const models = settings?.models ?? {};
  const targets = [
    ['gpt', 'set_gpt_weights', String(models.gptModelPath ?? '').trim()],
    ['sovits', 'set_sovits_weights', String(models.sovitsModelPath ?? '').trim()],
  ];
  const loaded = [];
  const skipped = [];
  for (const [kind, endpoint, path] of targets) {
    checkAbort(signal);
    if (path.length === 0) {
      skipped.push(kind);
      continue;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GPT_SOVITS_LOAD_TIMEOUT_MS);
    try {
      const response = await fetch(`${base}/${endpoint}?weights_path=${encodeURIComponent(path)}`, {
        signal: AbortSignal.any([signal, controller.signal]),
        headers: { accept: 'application/json, text/plain, */*' },
      });
      checkAbort(signal);
      // A failed switch is not fatal: the path stays saved and the card explains the fallback.
      if (!response.ok) return { ok: false, loaded, skipped, kind, error: `HTTP ${response.status}` };
      loaded.push(kind);
    } catch (error) {
      checkAbort(signal);
      const message = error?.name === 'AbortError'
        ? `超时（${GPT_SOVITS_LOAD_TIMEOUT_MS} ms）`
        : (error?.message ?? String(error));
      return { ok: false, loaded, skipped, kind, error: message };
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: true, loaded, skipped, kind: '', error: '' };
}

/** Edge TTS path: 24 kHz / 48 kbps mono MP3 (kept as the default and the fallback). */
async function synthesizeEdge({ text, voice, dir, signal, maxBytes = TTS_AUDIO_MAX_BYTES }) {
  checkAbort(signal);
  await mkdir(dir, { recursive: true });
  const tts = new MsEdgeTTS();
  const file = join(dir, `${randomUUID()}.mp3`);
  const close = () => { try { tts.close(); } catch { /* already closed */ } };
  signal?.addEventListener('abort', close, { once: true });
  let audioStream;
  try {
    await tts.setMetadata(voice, DEFAULT_FORMAT);
    checkAbort(signal);
    ({ audioStream } = await tts.toStream(text));
    // close() may destroy the stream before pipeline attaches its error handler.
    audioStream.on('error', () => {});
    checkAbort(signal);
    let bytes = 0;
    const limit = new Transform({ transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      callback(bytes > maxBytes ? audioLimit() : null, chunk);
    } });
    await pipeline(audioStream, limit, createWriteStream(file), { signal });
    checkAbort(signal);
    if (bytes === 0) throw new Error('TTS produced no audio');
    return { file, bytes, durationMs: Math.round((bytes * 8) / BITRATE_KBPS), provider: 'edge-tts' };
  } catch (error) {
    audioStream?.destroy();
    await rm(file, { force: true });
    checkAbort(signal);
    throw error;
  } finally {
    signal?.removeEventListener('abort', close);
    close();
  }
}

/**
 * Synthesize text to a file. Tries GPT-SoVITS when enabled, then always falls back to Edge TTS
 * on any failure so the companion never goes silent because the local server is down.
 *
 * `lang` is the speech language (`langs.speech`); it picks the Edge default voice. When the
 * caller also passes `textLang` (the language of the line it prepared), that value is `text_lang`:
 * a translation that fell back to the source language must be synthesized in that language, not
 * relabelled from the settings. `prompt_lang` still follows the settings/reference clip. An
 * explicit `voice` (config `ttsVoice`) still wins. A GPT-SoVITS server without a usable reference
 * clip is never called blindly: the stock API answers HTTP 400 for a missing clip, a clip outside
 * 3–10 s, or empty prompt text, so those cases skip straight to Edge.
 *
 * P-46: `turn`, `deliveryMessageId`, `sessionId` and `speechId` are optional turn attribution. They
 * are only carried on the `voice.tts.request` row (null when omitted); they never affect which
 * engine runs, how long a slot is held, or whether a clip is cached.
 *
 * @param {{text: string, voice?: string, lang?: string, textLang?: string, dir: string,
 *   purpose?: string, turn?: number|null, deliveryMessageId?: string|null, sessionId?: string|null,
 *   speechId?: string|null, sentenceId?: number, chunkIndex?: number}} options
 * @returns {Promise<{file: string, bytes: number, durationMs: number, provider: string}>}
 */
export function synthesize(options) {
  const request = { ...options, snapshot: options.snapshot ?? captureTtsSnapshot() };
  const purpose = String(request.purpose ?? 'speech');
  // Observation only: which engines were tried, so the automatic Edge fallback is reported as one
  // retry instead of being folded into a single opaque duration.
  const observation = { attempts: [], retryErrorCode: null };
  return synthesisSlots.run(
    async (signal, slot) => {
      // Round first: a sub-millisecond enqueue->start gap is an immediate slot, not a queue wait.
      const slotWaitMs = Math.max(0, Math.round(Number(slot?.slotWaitMs) || 0));
      // Throttle: a slot that started immediately is not reported; only a real queue wait is.
      if (slotWaitMs > 0) {
        void notifyHook(ttsSlotWaitHook, {
          purpose,
          slotWaitMs: Math.round(slotWaitMs),
          queueDepth: Number(slot?.queueDepth) || 0,
          running: slot?.running === true,
        });
      }
      // The monotonic clock starts when this request owns the slot, so `requestMs` excludes the
      // queue wait and cannot be altered by a wall-clock adjustment.
      const startedAt = monotonicNow();
      let result;
      try {
        result = await synthesizeNow({ ...request, signal, observation });
      } catch (error) {
        reportTtsRequest(request, { slot, slotWaitMs, startedAt, error, ...observation });
        throw error;
      }
      reportTtsRequest(request, { slot, slotWaitMs, startedAt, result, ...observation });
      // Returned so the caller can put the wait beside the clip: `voice.latency.ttsSlotWaitMs`.
      return { ...result, slotWaitMs };
    },
    request.signal,
    { priority: Number(request.priority) || 0, preemptWarmup: true },
  );
}

/**
 * The slot-owned half of a synthesis. It reads only what the provider needs, so the P-46 turn
 * attribution rides along in the request object untouched and is reported by `synthesize()`
 * (this function never writes the request row).
 */
async function synthesizeNow({ text, voice, lang = 'zh', textLang = '', dir, signal, snapshot, maxBytes = TTS_AUDIO_MAX_BYTES, observation = null }) {
  checkAbort(signal);
  if (snapshot.weightsEpoch !== weightsEpoch) throw abortError();
  const resolvedVoice = typeof voice === 'string' && voice.trim().length > 0 ? voice : voiceForLanguage(lang);
  const settings = snapshot.settings;
  let gptUsable = settings !== null
    && settings.enabled === true
    && typeof settings.apiBase === 'string'
    && settings.apiBase.trim().length > 0;
  if (gptUsable && !hasReference(settings) && !hasLoadedModels(settings)) {
    gptUsable = false;
    await notifyHook(gptSovitsSkippedHook, { reason: 'no-reference' });
  } else if (gptUsable && hasReference(settings)) {
    // A stock server rejects these two cases with HTTP 400, so the request is never sent.
    const probe = await measureReference(settings.refAudioPath, signal);
    if (probe.seconds === null) {
      await notifyHook(gptSovitsWarningHook, { reason: 'reference-unreadable' });
    } else if (!referenceRangeOk(probe.seconds)) {
      gptUsable = false;
      await notifyHook(gptSovitsSkippedHook, {
        reason: 'reference-duration',
        seconds: Math.round(probe.seconds * 10) / 10,
      });
    }
    if (gptUsable && String(settings.promptText ?? '').trim().length === 0) {
      gptUsable = false;
      await notifyHook(gptSovitsSkippedHook, { reason: 'no-prompt-text' });
    }
  }
  if (gptUsable) {
    observation?.attempts.push('gpt-sovits');
    try {
      checkAbort(signal);
      return await synthesizeGptSovits({ text, dir, speech: lang, textLang, settings, signal, maxBytes });
    } catch (error) {
      checkAbort(signal);
      if (error?.code === 'TTS_AUDIO_LIMIT') throw error;
      if (observation !== null && observation.retryErrorCode === null) observation.retryErrorCode = ttsErrorCode(error);
      const payload = { error: error?.message ?? String(error) };
      if (Number.isInteger(error?.status)) payload.status = error.status;
      if (typeof error?.body === 'string') payload.body = error.body;
      // Timeouts carry the measured wait so the event log explains a cold start without log math.
      if (Number.isInteger(error?.elapsedMs)) payload.elapsedMs = error.elapsedMs;
      if (Number.isInteger(error?.timeoutMs)) payload.timeoutMs = error.timeoutMs;
      await notifyHook(gptSovitsFailureHook, payload);
    }
  }
  checkAbort(signal);
  observation?.attempts.push('edge');
  const result = await (edgeSynthesizeOverride ?? synthesizeEdge)({ text, voice: resolvedVoice, dir, signal, maxBytes });
  if (signal?.aborted) {
    if (result?.file) await rm(result.file, { force: true });
    checkAbort(signal);
  }
  return result;
}

/** Cancel the active player AND its queued predecessors/successors. Cleanup retains the slot. */
export function stopPlayback() {
  return playbackSlots.cancel();
}

function startPlayer(command, args, { signal, piped = false, onStart = null } = {}) {
  checkAbort(signal);
  // Evidence bounds of the file transport: `spawnAt` is taken immediately before the child is
  // created and `playerReadyAt` on the child's `spawn` event. Both only prove the PLAYER PROCESS
  // is up — not decoded PCM, a submitted buffer or speaker sound — so this path reports
  // `firstPcmAt`/`firstAudibleAt` as null (unknown) instead of reusing the spawn instant.
  const spawnAt = Date.now();
  const child = spawn(command, args, { windowsHide: true, stdio: piped ? ['pipe', 'ignore', 'ignore'] : 'ignore' });
  let started = false;
  let failure = null;
  const abort = () => { try { child.kill(); } catch { /* already closed */ } };
  const done = new Promise((resolve, reject) => {
    const finish = (error) => {
      signal?.removeEventListener('abort', abort);
      if (signal?.aborted) reject(signal.reason ?? abortError());
      else if (error) reject(error);
      else resolve();
    };
    child.once('spawn', () => {
      started = true;
      if (!signal?.aborted) {
        const playerReadyAt = Date.now();
        try {
          onStart?.({
            startedAt: playerReadyAt,
            spawnAt,
            playerReadyAt,
            playerReadyMs: Math.max(0, playerReadyAt - spawnAt),
            firstPcmAt: null,
            firstAudibleAt: null,
          });
        } catch { /* diagnostic hook */ }
      }
    });
    child.once('error', (error) => {
      failure = error;
      if (!started) finish(error); // failed spawn has no live process to wait for
      else abort();
    });
    child.once('close', (code) => finish(failure ?? (code ? new Error(`Audio player exit ${code}`) : null)));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
  // A stream can fail before the caller awaits process closure. Always observe that rejection.
  done.catch(() => {});
  child.stdin?.on('error', () => {});
  return { child, done, spawnAt };
}

/**
 * Synthesize and play in one pass: audio chunks go to ffplay's stdin as they arrive, while a
 * copy is written to disk (needed for duration, subtitles and replay). This can begin feeding
 * the player before the file completes; actual speaker first audio is not measured here.
 *
 * Falls back to `synthesize()` when no ffplay is available.
 *
 * `onStart` is optional and additive: it fires once, when the player is first handed audio data,
 * with transport anchors only — `firstDataAt`/`firstDataMs` (data arrival, `firstDataIsAudible:
 * false`) and `playerReadyAt`/`playerReadyMs` (process ready). Data arrival is not decoded PCM and
 * not speaker sound, so `firstPcmAt`/`firstAudibleAt` stay null. This matters because this promise
 * only resolves when the whole clip has been piped — long before it stops playing.
 * `onTransport` is optional too: it reports the player's real end (`{exit, via}`), which is what a
 * caller must prefer over its own duration estimate.
 *
 * @param {{text: string, voice?: string, lang?: string, dir: string, ffplayPath?: string|null, onStart?: Function|null, onTransport?: Function|null,
 *   turn?: number|null, deliveryMessageId?: string|null, sessionId?: string|null, speechId?: string|null,
 *   sentenceId?: number, chunkIndex?: number}} options
 * @returns {Promise<{file: string, bytes: number, durationMs: number, firstChunkMs: number|null, via: string}>}
 */
export async function speakStreaming({ text, voice, lang = 'zh', textLang = '', dir, ffplayPath = null, onStart = null,
  onTransport = null, purpose = 'speech', turn = null, deliveryMessageId = null, sessionId = null,
  speechId = null, sentenceId = null, chunkIndex = null, signal, snapshot = captureTtsSnapshot(),
  maxBytes = TTS_AUDIO_MAX_BYTES }) {
  checkAbort(signal);
  const resolvedVoice = typeof voice === 'string' && voice.trim().length > 0 ? voice : voiceForLanguage(lang);
  if (snapshot.settings?.enabled === true || !ffplayPath) {
    // P-46: the fallback path reports through `synthesize()`, so the attribution must ride along.
    const result = await synthesize({
      text, voice: resolvedVoice, lang, textLang, dir, purpose, turn, deliveryMessageId, sessionId,
      speechId, sentenceId, chunkIndex, signal, snapshot, maxBytes,
    });
    try {
      checkAbort(signal);
    } catch (error) {
      // Synthesis produced the clip but the caller never receives it: the producer still owns it.
      await removeUndeliveredAudio(result);
      throw error;
    }
    const playback = play(result.file, { ffplayPath, signal, onStart });
    playback.catch(() => {});
    // This player's exit is the real end; the caller may also play the file without this helper.
    try { onTransport?.({ exit: playback, via: 'file' }); } catch { /* diagnostic hook */ }
    return { ...result, firstChunkMs: null, via: 'file' };
  }
  // Public result settles when the file is complete; playback ownership lasts until child close.
  return new Promise((resolve, reject) => {
    // Observation only: the inline Edge stream owns a slot directly, so it reports its own request
    // row (the file path above already reported one through `synthesize()`). P-46 attribution is
    // copied here too, so a streamed sentence is attributable to its turn without a time window.
    const streamRequest = {
      text, purpose: String(purpose ?? 'speech'), turn, deliveryMessageId, sessionId, speechId,
      sentenceId, chunkIndex,
    };
    // Always acquire synthesis before playback, like the model-application barrier. The legacy
    // pipe path conservatively retains synthesis ownership until player cleanup; sentence-file
    // prefetch below releases synthesis independently and still overlaps with playback.
    void synthesisSlots.run(async (synthSignal, synthSlot) => {
      const slotWaitMs = Math.max(0, Number(synthSlot?.slotWaitMs) || 0);
      return playbackSlots.run(async (playSignal) => {
        // The provider round trip is timed from the instant both seats are owned, so the playback
        // seat wait never becomes synthesis time (the request row keeps its clocks separate).
        const requestStartedAt = monotonicNow();
        let player;
        /** Process-ready instant from the internal spawn hook; 0 until the child's `spawn` fires. */
        let playerReadyAt = 0;
        const controller = new AbortController();
        const streamSignal = AbortSignal.any([synthSignal, playSignal, controller.signal]);
        checkAbort(streamSignal);
        if (snapshot.weightsEpoch !== weightsEpoch) throw abortError();
        await mkdir(dir, { recursive: true });
        checkAbort(streamSignal);
        const tts = new MsEdgeTTS();
        const file = join(dir, `${randomUUID()}.mp3`);
        let audioStream;
        let published = false;
        const close = () => { try { tts.close(); } catch { /* already closed */ } };
        streamSignal.addEventListener('abort', close, { once: true });
        try {
          await tts.setMetadata(resolvedVoice, DEFAULT_FORMAT);
          checkAbort(streamSignal);
          ({ audioStream } = await tts.toStream(text));
          audioStream.on('error', () => {});
          checkAbort(streamSignal);
          player = startPlayer(ffplayPath, ['-nodisp', '-autoexit', '-loglevel', 'quiet', '-i', 'pipe:0'], {
            signal: playSignal,
            piped: true,
            // Internal: stamp process readiness. The caller's own `onStart` fires on first DATA.
            onStart: (info) => { playerReadyAt = Number(info?.playerReadyAt) || 0; },
          });
          // The child's close is the real playback end; piping done is not.
          try { onTransport?.({ exit: player.done, via: 'ffplay-stream' }); } catch { /* diagnostic hook */ }
          const fileStream = createWriteStream(file);
          let piped = false;
          void player.done.then(() => {
            if (!piped) controller.abort(new Error('Player closed during synthesis'));
          }, (error) => controller.abort(error));
          let bytes = 0;
          let firstChunkMs = null;
          /** Transport arrival of the first audio byte: where a streamed provider round trip ends. */
          let firstDataAt = 0;
          /** Monotonic first-byte instant; only the DURATION is taken from it, never a wall anchor. */
          let firstDataMono = 0;
          const startedAt = monotonicNow();
          const sink = new Writable({ write(chunk, _encoding, callback) {
            bytes += chunk.length;
            if (bytes > maxBytes) { callback(audioLimit()); return; }
            if (firstChunkMs === null) {
              firstDataMono = monotonicNow();
              firstChunkMs = Math.max(0, Math.round(firstDataMono - startedAt));
              // The first audio DATA handed to the player: transport arrival, not decoded audio and
              // not speaker sound. `firstDataIsAudible` is false without a read-back; the PCM and
              // audible instants are never inferred from it.
              firstDataAt = Date.now();
              const spawnAt = Number(player?.spawnAt) || 0;
              try {
                onStart?.({
                  startedAt: firstDataAt,
                  spawnAt,
                  playerReadyAt: playerReadyAt > 0 ? playerReadyAt : null,
                  playerReadyMs: playerReadyAt > 0 && spawnAt > 0
                    ? Math.max(0, playerReadyAt - spawnAt) : null,
                  firstDataAt,
                  firstDataMs: spawnAt > 0 ? Math.max(0, firstDataAt - spawnAt) : null,
                  firstDataIsAudible: false,
                  firstPcmAt: null,
                  firstAudibleAt: null,
                });
              } catch { /* diagnostic hook */ }
            }
            // Both writes must finish before accepting another chunk: bounded tee, no unbounded data listener.
            fileStream.write(chunk, (error) => {
              if (error) { callback(error); return; }
              if (player.child.stdin.destroyed) { callback(new Error('Player closed during synthesis')); return; }
              player.child.stdin.write(chunk, callback);
            });
          }, final(callback) {
            // All chunk writes have completed; a player may exit immediately after stdin EOF.
            piped = true;
            fileStream.end(callback);
            player.child.stdin.end();
          }, destroy(error, callback) {
            fileStream.destroy();
            if (error) player.child.stdin.destroy();
            callback(error);
          } });
          fileStream.on('error', (error) => sink.destroy(error));
          try {
            await pipeline(audioStream, sink, { signal: streamSignal });
            checkAbort(streamSignal);
            if (bytes === 0) throw new Error('TTS produced no audio');
          } finally {
            fileStream.destroy();
            if (!fileStream.closed) await new Promise((done) => fileStream.once('close', done));
          }
          checkAbort(streamSignal);
          // One debug row per streamed request: the provider round trip ends at the first audio
          // byte; the rest of the pipe runs at playback rate and is not synthesis time.
          reportTtsRequest(streamRequest, {
            slot: synthSlot,
            slotWaitMs,
            startedAt: requestStartedAt,
            requestMs: firstDataMono > 0 ? firstDataMono - requestStartedAt : null,
            result: { provider: 'edge-tts' },
            attempts: ['edge'],
            streamed: true,
          });
          published = true;
          resolve({ file, bytes, durationMs: Math.round((bytes * 8) / BITRATE_KBPS), firstChunkMs, via: 'ffplay-stream', provider: 'edge-tts' });
          await player.done;
        } catch (error) {
          // A failure after the clip was delivered is a playback failure, not a second request row.
          if (!published) {
            reportTtsRequest(streamRequest, { slot: synthSlot, slotWaitMs, startedAt: requestStartedAt, error, attempts: ['edge'], streamed: true });
          }
          audioStream?.destroy();
          if (player) {
            try { player.child.kill(); } catch { /* already gone */ }
            await player.done.catch(() => {});
          }
          if (!published) await rm(file, { force: true });
          checkAbort(streamSignal);
          throw error;
        } finally {
          streamSignal.removeEventListener('abort', close);
          close();
        }
      }, synthSignal);
    }, signal, { preemptWarmup: true }).catch(reject);
  });
}

/**
 * Play an audio file (mp3 or wav). Prefers ffplay (≈0.3 s startup) and falls back to
 * PowerShell/WPF (≈0.8 s). Calls are serialized: the returned promise resolves when this
 * clip finishes.
 *
 * @param {string} file - absolute audio path.
 * @param {{ffplayPath?: string|null}} [options]
 * @returns {Promise<void>}
 */
export function play(file, { ffplayPath = null, signal, onStart = null } = {}) {
  return playbackSlots.run(async (ownedSignal) => {
    if (ffplayPath) {
      try {
        await startPlayer(ffplayPath, ['-nodisp', '-autoexit', '-loglevel', 'quiet', '-i', file], { signal: ownedSignal, onStart }).done;
        return;
      } catch (error) {
        checkAbort(ownedSignal);
        // Only a failed launch falls back. A nonzero exit after audio started is a playback failure.
        if (!['ENOENT', 'EACCES'].includes(error?.code)) throw error;
      }
    }
    checkAbort(ownedSignal);
    await wpfPlay(file, { signal: ownedSignal, onStart });
  }, signal);
}

/** A bounded producer: scans without copying the whole input into a sentence array. */
export function* speechSentences(text, { maxTextChars = 4096, maxSentenceChars = 1024 } = {}) {
  if (typeof text !== 'string') throw new TypeError('Speech text must be a string');
  let count = 0;
  for (const _char of text) {
    if (++count > maxTextChars) throw Object.assign(new Error('Speech text exceeds queue limit'), { code: 'TTS_TEXT_LIMIT' });
  }
  let sentence = '';
  let chars = 0;
  for (const char of text) {
    sentence += char;
    if (++chars > maxSentenceChars) throw Object.assign(new Error('Speech sentence exceeds limit'), { code: 'TTS_TEXT_LIMIT' });
    if (/[。！？!?\n]/u.test(char)) {
      if (sentence.trim()) yield sentence.trim();
      sentence = '';
      chars = 0;
    }
  }
  if (sentence.trim()) yield sentence.trim();
}

/** B: comma/顿号/semicolon pauses that may end a chunk, and the pairs a cut must never enter. */
const CHUNK_PAUSES = new Set(['，', '、', '；', ',', ';']);
const CHUNK_OPENERS = new Map([['（', '）'], ['(', ')'], ['【', '】'], ['[', ']'], ['《', '》'], ['〈', '〉'], ['{', '}'], ['「', '」'], ['『', '』']]);
const CHUNK_CLOSERS = new Set([...CHUNK_OPENERS.values()]);
const CHUNK_QUOTES = new Map([['“', '”'], ['‘', '’'], ['"', '"'], ["'", "'"]]);
/** B/C: the smallest chunk a long sentence may be cut into (characters). */
export const DEFAULT_CHUNK_MIN_CHARS = 8;
export const CHUNK_MIN_CHARS_MIN = 2;
export const CHUNK_MIN_CHARS_MAX = 80;

/** Clamp `voice.chunkMinChars`; a missing/invalid value keeps the default 8. */
export function resolveChunkMinChars(value, fallback = DEFAULT_CHUNK_MIN_CHARS) {
  const numeric = typeof value === 'number'
    ? value
    : (typeof value === 'string' && value.trim().length > 0 ? Number(value) : Number.NaN);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(CHUNK_MIN_CHARS_MAX, Math.max(CHUNK_MIN_CHARS_MIN, Math.round(numeric)));
}

/**
 * Split one already-prepared speech line at comma-level pauses. A cut is made only outside
 * brackets and quotes, and only once the pending chunk reached `minChars`, so a short sentence
 * stays whole and no chunk is a single character. The pause stays on the chunk it closed and the
 * join is exactly the trimmed input — every character is spoken once, in order.
 */
export function splitSpeechChunks(text, { minChars = DEFAULT_CHUNK_MIN_CHARS } = {}) {
  const source = typeof text === 'string' ? text.trim() : '';
  if (source.length === 0) return [];
  const minimum = resolveChunkMinChars(minChars);
  const chunks = [];
  let pending = '';
  let chars = 0;
  let depth = 0;
  let quote = '';
  for (const char of source) {
    pending += char;
    chars += 1;
    if (quote !== '') {
      if (char === quote) quote = '';
      continue;
    }
    if (CHUNK_OPENERS.has(char)) { depth += 1; continue; }
    if (CHUNK_CLOSERS.has(char)) { depth = Math.max(0, depth - 1); continue; }
    const closing = CHUNK_QUOTES.get(char);
    if (closing !== undefined) { quote = closing; continue; }
    if (depth === 0 && chars >= minimum && CHUNK_PAUSES.has(char)) {
      chunks.push(pending);
      pending = '';
      chars = 0;
    }
  }
  if (pending.length > 0) chunks.push(pending);
  return chunks;
}

/**
 * B: the chunk list for one speech line. `chunking === false` keeps the sentence whole — the
 * documented switch back to one clip per sentence.
 */
export function speechChunkTexts(text, { chunking = true, minChars = DEFAULT_CHUNK_MIN_CHARS } = {}) {
  const source = typeof text === 'string' ? text.trim() : '';
  if (source.length === 0) return [];
  return chunking === false ? [source] : splitSpeechChunks(source, { minChars });
}

/**
 * P-148: the first semantic unit's OPENING block targets about one second of audio instead of the
 * whole unit. The character budget is either configured (`voice.firstBlockTargetChars`), derived
 * from a target duration and the MEASURED synthesis cost (`voice.firstBlockTargetMs`), or — before
 * any measurement exists — the ~30-character default. A guessed rate never sizes the first block.
 */
export const DEFAULT_FIRST_BLOCK_TARGET_CHARS = 30;
export const DEFAULT_FIRST_BLOCK_TARGET_MS = 1200;
export const FIRST_BLOCK_TARGET_CHARS_MIN = 4;
export const FIRST_BLOCK_TARGET_CHARS_MAX = 120;
/** A unit at or below this size is synthesized whole (the old, unsplit path). */
export const DEFAULT_FIRST_BLOCK_SHORT_CHARS = 40;

/** Resolve the first-block character budget: explicit chars > measured ms/char > 30 chars. */
export function resolveFirstBlockTarget({ targetChars, targetMs, msPerChar, measured = false } = {}) {
  const ms = Number(targetMs) > 0 ? Math.round(Number(targetMs)) : DEFAULT_FIRST_BLOCK_TARGET_MS;
  const rate = Number(msPerChar);
  const sized = measured === true && Number.isFinite(rate) && rate > 0
    ? ms / rate
    : DEFAULT_FIRST_BLOCK_TARGET_CHARS;
  const explicit = Number(targetChars);
  const chosen = Number.isFinite(explicit) && explicit > 0 ? explicit : sized;
  return {
    targetChars: Math.min(FIRST_BLOCK_TARGET_CHARS_MAX, Math.max(FIRST_BLOCK_TARGET_CHARS_MIN, Math.round(chosen))),
    targetMs: ms,
  };
}

/**
 * P-148: cut the opening block of one semantic unit near the target size.
 *
 * Only the first block is cut: the rest of the unit stays ONE later block, so the whole block list
 * is a lossless partition of the trimmed input (join === input, no character repeated or dropped).
 * A cut happens only after a comma-level pause outside brackets/quotes, and only when both sides
 * stay speakable; a short unit, or one whose first usable pause lies beyond the target window,
 * stays whole rather than being cut inside a word.
 *
 * @returns {{blocks: string[], chars: number, chunked: boolean, firstBlockChars: number,
 *   targetChars: number, targetMs: number}}
 */
export function splitFirstBlockChunks(text, {
  targetChars, targetMs, msPerChar, measured = false,
  minChars = DEFAULT_CHUNK_MIN_CHARS, shortChars = DEFAULT_FIRST_BLOCK_SHORT_CHARS,
} = {}) {
  const source = typeof text === 'string' ? text.trim() : '';
  const target = resolveFirstBlockTarget({ targetChars, targetMs, msPerChar, measured });
  const points = [...source];
  const minimum = resolveChunkMinChars(minChars);
  const slack = Math.max(minimum, Math.round(target.targetChars / 4));
  const window = target.targetChars + slack;
  const summary = {
    blocks: source.length === 0 ? [] : [source],
    chars: points.length,
    chunked: false,
    firstBlockChars: points.length,
    ...target,
  };
  // A short unit is never cut, and a cut only happens when its pause fits the target window.
  if (points.length <= Math.max(DEFAULT_FIRST_BLOCK_SHORT_CHARS, window)) return summary;
  let depth = 0;
  let quote = '';
  let cut = 0;
  for (let index = 0; index < points.length; index += 1) {
    const char = points[index];
    if (quote !== '') { if (char === quote) quote = ''; continue; }
    if (CHUNK_OPENERS.has(char)) { depth += 1; continue; }
    if (CHUNK_CLOSERS.has(char)) { depth = Math.max(0, depth - 1); continue; }
    const closing = CHUNK_QUOTES.get(char);
    if (closing !== undefined) { quote = closing; continue; }
    if (depth !== 0 || !CHUNK_PAUSES.has(char)) continue;
    let end = index + 1;
    while (end < points.length && /\s/u.test(points[end])) end += 1;
    // Neither side may become a stub, and the opening block must stay inside the target window.
    if (index + 1 < minimum || points.length - end < minimum || index + 1 > window) continue;
    cut = end;
  }
  if (cut <= 0) return summary;
  return {
    ...summary,
    blocks: [points.slice(0, cut).join(''), points.slice(cut).join('')],
    chunked: true,
    firstBlockChars: cut,
  };
}

/**
 * Pull-based, one playing + one synthesizing/ready. The caller must supply a bounded iterable,
 * not an event callback spawning unbounded push promises. Only this invocation's files are removed.
 *
 * P-46: `turn`/`deliveryMessageId`/`sessionId` are optional attribution forwarded to every
 * sentence's `synthesize()` call; omitting them keeps the old row unchanged.
 */
export function speakSentences(sentences, options = {}) {
  const request = { ...options, snapshot: options.snapshot ?? captureTtsSnapshot() };
  return sentenceSlots.run((signal) => speakSentencesNow(sentences, { ...request, signal }), request.signal);
}

async function speakSentencesNow(sentences, { voice, lang = 'zh', dir, ffplayPath = null,
  turn = null, deliveryMessageId = null, sessionId = null,
  signal, snapshot = captureTtsSnapshot(), onEvent = null, maxSentenceChars = 1024 } = {}) {
  checkAbort(signal);
  const controller = new AbortController();
  const ownedSignal = controller.signal;
  const abort = () => controller.abort(signal.reason ?? abortError());
  signal?.addEventListener('abort', abort, { once: true });
  const iterator = sentences[Symbol.asyncIterator]?.() ?? sentences[Symbol.iterator]?.();
  if (!iterator) { signal?.removeEventListener('abort', abort); throw new TypeError('Sentences must be iterable'); }
  let seq = 0;
  let current = null;
  let next = null;
  let firstStartedAt = null;
  let status = 'completed';
  const notify = (type, data = {}) => {
    try { onEvent?.({ type, ...data }); } catch { /* observation cannot break cancellation */ }
  };
  const remove = async (entry) => { if (entry?.audio?.file) await rm(entry.audio.file, { force: true }); };
  const prepare = async () => {
    checkAbort(ownedSignal);
    const item = await iterator.next();
    checkAbort(ownedSignal);
    if (item.done) return null;
    const text = String(item.value ?? '').trim();
    if (text.length === 0 || [...text].length > maxSentenceChars) {
      throw Object.assign(new Error('Invalid or overlong speech sentence'), { code: 'TTS_TEXT_LIMIT' });
    }
    const entry = { seq: seq++, text, queuedAt: performance.now(), audio: null };
    notify('synth-start', { seq: entry.seq, chars: [...text].length });
    entry.audio = await synthesize({
      text, voice, lang, dir, turn, deliveryMessageId, sessionId,
      signal: ownedSignal, snapshot, maxBytes: TTS_AUDIO_MAX_BYTES,
    });
    if (ownedSignal.aborted) { await remove(entry); checkAbort(ownedSignal); }
    entry.readyAt = performance.now();
    notify('ready', { seq: entry.seq, bytes: entry.audio.bytes, synthMs: entry.readyAt - entry.queuedAt });
    return entry;
  };
  try {
    current = await prepare();
    while (current !== null) {
      checkAbort(ownedSignal);
      const entry = current;
      // Resolve/reject into a value immediately: a failed prefetch cannot become an unhandled rejection.
      next = prepare().then((value) => ({ value }), (error) => {
        controller.abort(error);
        return { error };
      });
      notify('play-queued', { seq: entry.seq, audio: entry.audio, text: entry.text });
      await play(entry.audio.file, { ffplayPath, signal: ownedSignal, onStart: (info) => {
        if (ownedSignal.aborted) return;
        firstStartedAt ??= info.startedAt;
        notify('play-start', { seq: entry.seq, audio: entry.audio, text: entry.text,
          startedAt: info.startedAt, queueMs: performance.now() - entry.readyAt });
      } });
      notify('play-end', { seq: entry.seq });
      await remove(entry);
      current = null;
      const prepared = await next;
      next = null;
      if (prepared.error) throw prepared.error;
      current = prepared.value;
    }
    return { status, sentences: seq, playerStartedAt: firstStartedAt, firstAudioAt: null };
  } catch (error) {
    status = signal?.aborted || error?.name === 'AbortError' ? 'cancelled' : 'failed';
    controller.abort(error);
    notify(status, { error: String(error?.message ?? error), code: error?.code ?? '' });
    throw error;
  } finally {
    controller.abort(abortError());
    signal?.removeEventListener('abort', abort);
    try {
      await remove(current);
      if (next) {
        const prepared = await next;
        await remove(prepared.value);
      }
    } finally {
      await iterator.return?.();
      notify('end', { status, sentences: seq });
    }
  }
}

/**
 * B/C: speak one sentence as comma-sized blocks.
 *
 * The first block is played as soon as it is synthesized; the next block is synthesized while the
 * current one plays (one-block lookahead, the same bound the sentence prefetch uses). Playback is
 * strictly serial and ordered, so a block is never replayed, reordered or silently skipped, and
 * `chunkId` (`${sentenceId}:${index}`) ties every block of a sentence together in the event log.
 *
 * `first` is audio the caller already synthesized for block 0 (the sentence prefetch); the driver
 * deletes only blocks it synthesized itself that never reached the player. `signal` cancels the
 * sounding block and every block that has not started — a cancelled block can never play later.
 *
 * @returns {Promise<{status: string, chunks: number, texts: string[], chunkIds: string[],
 *   playedChunks: number, skipped: number, playedText: string, firstAudioAt: number,
 *   lastAudioAt: number, firstStarted: object|null}>}
 */
export async function speakChunks({
  text = '', chunks = null, sentenceId = 0, first = null,
  synthesize = null, play = null, signal = undefined,
  chunking = true, minChars = DEFAULT_CHUNK_MIN_CHARS,
  onStart = null, onEvent = null,
} = {}) {
  const list = (Array.isArray(chunks) ? chunks : speechChunkTexts(text, { chunking, minChars }))
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry) => entry.length > 0);
  const chunkIds = list.map((_, index) => `${sentenceId}:${index}`);
  const summary = {
    status: list.length === 0 ? 'empty' : 'completed',
    chunks: list.length,
    texts: list,
    chunkIds,
    playedChunks: 0,
    skipped: 0,
    playedText: '',
    firstAudioAt: 0,
    lastAudioAt: 0,
    firstStarted: null,
  };
  if (list.length === 0) return summary;
  if (typeof play !== 'function') throw new TypeError('speakChunks needs a play seam');
  if ((list.length > 1 || first === null) && typeof synthesize !== 'function') {
    throw new TypeError('speakChunks needs a synthesize seam');
  }
  const controller = new AbortController();
  const lane = signal === undefined || signal === null ? controller.signal : AbortSignal.any([signal, controller.signal]);
  const notify = (phase, data = {}) => {
    try { onEvent?.({ type: 'voice.chunk', phase, sentenceId, ...data }); } catch { /* observation only */ }
  };
  const remove = async (audio) => {
    const file = typeof audio?.file === 'string' ? audio.file : '';
    if (file.length === 0) return;
    await rm(file, { force: true }).catch(() => {});
  };
  const synthAt = (index) => {
    const task = Promise.resolve().then(() => {
      checkAbort(lane);
      notify('synth-start', { chunkId: chunkIds[index], index, count: list.length });
      return synthesize({ text: list[index], chunkId: chunkIds[index], index, count: list.length, signal: lane });
    });
    // A cancelled lane may reject before the loop awaits it; never leave that unobserved.
    task.catch(() => {});
    return task;
  };
  /** A cancelled block settles with a stable code; a player may never settle its `done` at all. */
  const abortedBlock = () => Object.defineProperty(
    new DOMException('Speech chunk cancelled', 'AbortError'),
    'code', { value: 'TTS_ABORTED', enumerable: true },
  );
  /**
   * Wait for the sounding block, but never past the lane: cancel / replacement / teardown ends
   * this wait at once instead of pinning the driver on a `done` the player may never settle. A
   * settlement that arrives later is consumed here and can never resume the queue, play a later
   * block, or write a block the cancellation already abandoned.
   */
  const waitBlock = (started) => {
    const done = started?.done;
    if (done === undefined || done === null) return Promise.resolve();
    if (lane.aborted) return Promise.reject(abortedBlock());
    return new Promise((resolve, reject) => {
      const onAbort = () => { lane.removeEventListener('abort', onAbort); reject(abortedBlock()); };
      lane.addEventListener('abort', onAbort, { once: true });
      Promise.resolve(done).then(
        (value) => { lane.removeEventListener('abort', onAbort); resolve(value); },
        (error) => { lane.removeEventListener('abort', onAbort); reject(error); },
      );
    });
  };
  let audio = null;
  let ownsAudio = false;
  let pending = null;
  let delivered = false;
  try {
    checkAbort(lane);
    if (first !== null && first !== undefined) {
      audio = first;
    } else {
      audio = await synthAt(0);
      ownsAudio = true;
    }
    notify('synth-ready', { chunkId: chunkIds[0], index: 0, count: list.length });
    for (let index = 0; index < list.length; index += 1) {
      if (index > 0) {
        audio = await pending;
        ownsAudio = true;
        pending = null;
        notify('synth-ready', { chunkId: chunkIds[index], index, count: list.length });
      }
      checkAbort(lane);
      delivered = false;
      // Start the next block BEFORE this one plays: synthesis overlaps playback, never the gap.
      pending = index + 1 < list.length ? synthAt(index + 1) : null;
      const started = await play({
        audio, text: list[index], chunkId: chunkIds[index], index, count: list.length, signal: lane,
      });
      if (started?.skipped === true) {
        summary.skipped += 1;
        notify('skip', { chunkId: chunkIds[index], index, count: list.length });
        await remove(audio);
        ownsAudio = false;
        continue;
      }
      delivered = true;
      const audioStartedAt = Number(started?.audioStartedAt) || 0;
      if (summary.firstStarted === null) summary.firstStarted = started;
      if (audioStartedAt > 0) {
        if (summary.firstAudioAt === 0) summary.firstAudioAt = audioStartedAt;
        summary.lastAudioAt = audioStartedAt;
        // A block that never reported a start (audioStartedAt 0) did not play: it must not count,
        // exactly like a sentence whose player never confirmed its first audio.
        summary.playedChunks += 1;
        summary.playedText += list[index];
      }
      notify('play', {
        chunkId: chunkIds[index], index, count: list.length,
        chars: [...list[index]].length, audioStartedAt,
      });
      try { onStart?.({ index, chunkId: chunkIds[index], count: list.length, started }); } catch { /* observation only */ }
      await waitBlock(started);
      // A barge-in during this block does not change the fact that it reached the player: stop the
      // queue and let the caller count it, exactly like a sentence whose tail was cut.
      if (lane.aborted) {
        summary.status = 'cancelled';
        notify('cancel', {
          status: 'cancelled', chunkId: chunkIds[index], index, count: list.length,
          playedChunks: summary.playedChunks,
        });
        return summary;
      }
      notify('end', { chunkId: chunkIds[index], index, count: list.length });
    }
    return summary;
  } catch (error) {
    controller.abort(error);
    summary.status = signal?.aborted === true || error?.name === 'AbortError' ? 'cancelled' : 'failed';
    notify(summary.status === 'cancelled' ? 'cancel' : 'fail', {
      status: summary.status, error: String(error?.message ?? error), playedChunks: summary.playedChunks,
    });
    // Only a block that never reached the player is still the producer's to delete.
    if (ownsAudio === true && delivered !== true) await remove(audio);
    throw error;
  } finally {
    // A prefetched block that will never play must not leak its file.
    if (pending !== null) {
      try { await remove(await pending); } catch { /* an aborted synthesis owns nothing */ }
    }
  }
}

/** PowerShell + WPF MediaPlayer fallback; resolves when the clip ends or the player dies. */
function wpfPlay(file, { signal, onStart }) {
      const uri = pathToFileURL(file).href;
      const script = [
        'Add-Type -AssemblyName PresentationCore;',
        '$p = New-Object System.Windows.Media.MediaPlayer;',
        `$p.Open([uri]'${uri}');`,
        '$p.Play();',
        'Start-Sleep -Milliseconds 400;',
        'if ($p.NaturalDuration.HasTimeSpan) {',
        '  while ($p.Position.TotalMilliseconds -lt $p.NaturalDuration.TimeSpan.TotalMilliseconds) { Start-Sleep -Milliseconds 100 }',
        '} else { Start-Sleep -Seconds 8 }',
        '$p.Close()',
      ].join(' ');
      return startPlayer('powershell', ['-NoProfile', '-STA', '-Command', script], { signal, onStart }).done;
}

// ---- explicit 「应用模型」 ---------------------------------------------------
// Saving a weight path only marks it dirty; this is the one place that pushes the paths into
// the local server. Additive on purpose: it reuses the provider/hooks above without touching
// synthesize(), the configurable synthesis timeout, or the startup warm-up (owned elsewhere).

/** Both weight switches and the following warm-up get this cap, independently of `timeoutMs`. */
const APPLY_WEIGHTS_TIMEOUT_MS = 30_000;
const APPLY_WARMUP_TIMEOUT_MS = 30_000;
/** One hiragana is enough to make the server load the freshly switched weights. */
const APPLY_WARMUP_TEXT = 'あ';

/** Read an error/ack body whether the fetch stub exposes text() or only arrayBuffer(). */
async function readResponseBodyText(response) {
  try {
    if (typeof response?.text === 'function') return await response.text();
    if (typeof response?.arrayBuffer === 'function') {
      return Buffer.from(await response.arrayBuffer()).toString('utf8');
    }
  } catch {
    /* the status alone still identifies the failure */
  }
  return '';
}

/** One `/set_*_weights` call: 30 s cap, never throws, always reports status/body/elapsed. */
async function applyOneWeight({ base, endpoint, path, signal }) {
  checkAbort(signal);
  const record = { ok: false, status: 0, body: '', elapsedMs: 0, path };
  if (path.length === 0) {
    record.body = '模型路径为空';
    return record;
  }
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), APPLY_WEIGHTS_TIMEOUT_MS);
  try {
    const response = await fetch(`${base}/${endpoint}?weights_path=${encodeURIComponent(path)}`, {
      signal: AbortSignal.any([signal, controller.signal]),
      headers: { accept: 'application/json, text/plain, */*' },
    });
    record.status = Number.isInteger(response?.status) ? response.status : 0;
    record.ok = response?.ok === true;
    record.body = clipGptBody(await readResponseBodyText(response));
    checkAbort(signal);
  } catch (error) {
    checkAbort(signal);
    record.body = error?.name === 'AbortError'
      ? `超时（${APPLY_WEIGHTS_TIMEOUT_MS} ms）`
      : String(error?.message ?? error);
  } finally {
    clearTimeout(timer);
    record.elapsedMs = Date.now() - startedAt;
  }
  return record;
}

/** One tiny /tts request so the server pays the model-load cost now, not on the first reply. */
async function warmupAppliedWeights(base, settings, signal) {
  checkAbort(signal);
  const { textLang, promptLang } = resolveGptLangs(settings, 'ja');
  const params = [
    ['text', APPLY_WARMUP_TEXT],
    ['text_lang', textLang],
    ['ref_audio_path', String(settings?.refAudioPath ?? '')],
    ['prompt_lang', promptLang],
    ['prompt_text', String(settings?.promptText ?? '')],
    ['media_type', 'wav'],
  ].map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), APPLY_WARMUP_TIMEOUT_MS);
  const combined = AbortSignal.any([signal, controller.signal]);
  const elapsed = () => Date.now() - startedAt;
  try {
    const response = await fetch(`${base}/tts?${params}`, {
      signal: combined,
      headers: { accept: 'audio/wav, audio/*' },
    });
    if (response?.ok !== true) {
      return { warmupMs: elapsed(), warmupError: `HTTP ${response?.status ?? 0}` };
    }
    const audio = await boundedBody(response, { signal: combined, maxBytes: TTS_AUDIO_MAX_BYTES });
    // A 200 carrying JSON is still a warm-up failure; only RIFF counts as audio.
    if (audio.length === 0 || audio.toString('ascii', 0, 4) !== 'RIFF') {
      return { warmupMs: elapsed(), warmupError: '返回非 wav 数据' };
    }
    return { warmupMs: elapsed(), warmupError: '' };
  } catch (error) {
    checkAbort(signal);
    return {
      warmupMs: elapsed(),
      warmupError: error?.name === 'AbortError'
        ? `超时（${APPLY_WARMUP_TIMEOUT_MS} ms）`
        : String(error?.message ?? error),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 「应用模型」: switch the local server to the saved gpt/sovits weights, then warm the new
 * weights with one very short synthesis. Only the settings-card button calls this; a path edit
 * never loads anything by itself. A failed warm-up is reported but does not fail the load.
 *
 * @returns {Promise<{ok: boolean, stage: string, error: string, gpt: object, sovits: object, warmupMs: number|null, warmupError: string}>}
 */
export function applyGptSovitsModels() {
  const settings = captureTtsSnapshot().settings ?? {};
  weightsEpoch++;
  stopTts();
  return synthesisSlots.run(async (signal) => {
    await playbackSlots.drain();
    checkAbort(signal);
    return applyGptSovitsModelsNow(settings, signal);
  }, undefined, { preemptWarmup: true });
}

async function applyGptSovitsModelsNow(settings, signal) {
  checkAbort(signal);
  const base = String(settings.apiBase ?? '').trim().replace(/\/+$/u, '');
  const models = settings.models ?? {};
  const gptPath = String(models.gptModelPath ?? '').trim();
  const sovitsPath = String(models.sovitsModelPath ?? '').trim();
  if (base.length === 0) {
    const record = { ok: false, status: 0, body: '缺少 GPT-SoVITS API 地址', elapsedMs: 0 };
    return {
      ok: false,
      stage: 'gpt',
      error: '缺少 GPT-SoVITS API 地址',
      gpt: { ...record, path: gptPath },
      sovits: { ...record, path: sovitsPath },
      warmupMs: null,
      warmupError: '',
    };
  }
  // Both endpoints are called in order even when the first one fails, so the result records
  // the real state of each weight instead of guessing from the first error.
  const gpt = await applyOneWeight({ base, endpoint: 'set_gpt_weights', path: gptPath, signal });
  const sovits = await applyOneWeight({ base, endpoint: 'set_sovits_weights', path: sovitsPath, signal });
  const describe = (record) => (record.status === 0
    ? record.body
    : `HTTP ${record.status}${record.body.length > 0 ? ` ${record.body.slice(0, 120)}` : ''}`);
  if (!gpt.ok) {
    return { ok: false, stage: 'gpt', error: describe(gpt), gpt, sovits, warmupMs: null, warmupError: '' };
  }
  if (!sovits.ok) {
    return { ok: false, stage: 'sovits', error: describe(sovits), gpt, sovits, warmupMs: null, warmupError: '' };
  }
  const warm = await warmupAppliedWeights(base, settings, signal);
  return { ok: true, stage: '', error: '', gpt, sovits, ...warm };
}
