/**
 * Hearing: microphone → ffmpeg (dshow) → sherpa-onnx.
 *
 * Two passes:
 *  - streaming 14M transducer gives live partials and endpoint detection;
 *  - on endpoint the buffered utterance is re-decoded by SenseVoice (offline, much more
 *    accurate, punctuation-aware) and that becomes the final text.
 *
 * It is the "fast channel / accurate channel" split from the design doc, applied to audio.
 *
 * Alongside the transcript it writes one `hearing.noise.shadow` row per final judgment (see the
 * "Noise shadow" block below). That row is evidence for a later decision, not one itself: this
 * round filters nothing and changes no threshold.
 *
 * Round 1 audio diagnostics add a second shadow: when a Silero VAD model can be loaded (it is
 * downloaded on demand when the shared copy is missing), the same PCM frames are also fed to it and
 * one `hearing.vad.shadow` row reports its speech segments next to the existing energy ratio. It is
 * observation only — no delivery path reads it.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Worker } from 'node:worker_threads';

import {
  VAD_MODEL_FILE,
  createSileroVad,
  createVadShadow,
  findVadModelPath,
  resolveVadThreshold,
} from './vad.js';
import {
  SPEAKER_MODEL_FILE,
  ensureSpeakerModel,
  ensureVadModel,
  isSharedModelTarget,
  speakerModelTarget,
  vadModelTarget,
} from '../platform/modelDownload.js';
import { createSpeakerEmbedder, createSpeakerLibrary } from './speakerVoice.js';
import { createDialogueContext } from '../session/conversation/dialogueContext.js';

import { finalModelReady, createFinalRecognizer, createRecognizer } from './models.js';
export {
  modelReady,
  finalModelReady,
  createFinalRecognizer,
  resolveEndpointRules,
  createRecognizer,
} from './models.js';
import { isLoopbackDevice } from './devices.js';
export { listDevices, isLoopbackDevice, selectMicrophoneDevice } from './devices.js';
import {
  sanitize,
  splitAsrTags,
  asrTagFields,
  DEFAULT_SEGMENT_OVERLAP_MS,
  segmentOverlapSamples,
  offlineLimitedNote,
  decodeSegmented,
} from './transcript.js';
export {
  splitAsrTags,
  asrTagFields,
  joinSegmentTexts,
  DEFAULT_SEGMENT_OVERLAP_MS,
  segmentOverlapSamples,
  planSegmentedDecodes,
  alignJointTexts,
  joinSegmentedTexts,
  mergeJoinFallback,
  joinDetailFields,
  truncationNotice,
  offlineLimitedNote,
  annotateTranscript,
  decodeSegmented,
} from './transcript.js';
import {
  defaultAsrWorkerFactory,
  ASR_WORKER_STOPPED,
  ASR_WORKER_OVERFLOW,
  DEFAULT_ASR_DECODE_TIMEOUT_MS,
  MAX_ASR_DECODE_TIMEOUT_MS,
  DEFAULT_ASR_QUEUE_LIMIT,
  DEFAULT_ASR_QUEUE_BYTES,
  createAsrWorkerClient,
} from './worker-client.js';
export {
  DEFAULT_ASR_DECODE_TIMEOUT_MS,
  MAX_ASR_DECODE_TIMEOUT_MS,
  DEFAULT_ASR_QUEUE_LIMIT,
  DEFAULT_ASR_QUEUE_BYTES,
  createAsrWorkerClient,
} from './worker-client.js';
import {
  ENDPOINT_MAX_UTTERANCE_SEC,
  SHADOW_SUPPRESS_WINDOW_MS,
  SPEAKER_SHADOW_MIN_SAMPLES,
  VOICED_FRAME_MS,
  endpointReasonOf,
  segmentEndReasonOf,
  DEFAULT_GROUP_COMMIT_MS,
  DEFAULT_GROUP_RESUME_GRACE_MS,
  GROUP_RESUME_MIN_VOICE_MS,
  shadowTextKey,
  voicedMetrics,
  wouldDropVerdict,
  noiseSuspects,
  onlineOfflineAgree,
  ASR_OBSERVE_WINDOW_MS,
  ASR_OBSERVE_MAX_ROWS,
} from './audio-evidence.js';
export {
  ENDPOINT_MAX_UTTERANCE_SEC,
  DEFAULT_ENDPOINT_RULES,
  FORCED_CUT_GRID_MS,
  SHADOW_SUPPRESS_WINDOW_MS,
  SPEAKER_SHADOW_MIN_MS,
  SPEAKER_SHADOW_MIN_SAMPLES,
  SHORT_LATIN_MAX_CHARS,
  VOICED_FRAME_MS,
  VOICED_DYNAMIC_RANGE_DB,
  VOICED_FLOOR_DB,
  endpointReasonOf,
  segmentEndReasonOf,
  DEFAULT_GROUP_COMMIT_MS,
  DEFAULT_GROUP_RESUME_GRACE_MS,
  GROUP_RESUME_MIN_VOICE_MS,
  onFixedCutGrid,
  shadowTextKey,
  voicedMetrics,
  LOW_VAD_SPEECH_MAX_RATIO,
  PLAYBACK_ECHO_MAX_RATIO,
  DROP_SHORT_TEXT_MAX_CHARS,
  DROP_SHORT_LATIN_MAX_CHARS,
  PROTECTED_SHORT_ANSWERS,
  isProtectedShortAnswer,
  wouldDropVerdict,
  noiseSuspects,
  onlineOfflineAgree,
  ASR_OBSERVE_WINDOW_MS,
  ASR_OBSERVE_MAX_ROWS,
} from './audio-evidence.js';
import {
  DIALOGUE_LAST_CAPTURE,
  hostDialogueVerdict,
  resolveDialogueBuffer,
  createDialogueCapture,
} from './dialogue-capture.js';
export {
  DIALOGUE_IDLE_MS,
  DIALOGUE_REPEAT_WINDOW_MS,
  DIALOGUE_IDLE_CHECK_MS,
  createDialogueCapture,
} from './dialogue-capture.js';


/**
 * Start streaming recognition.
 * @param {{ffmpegPath: string, modelDir: string, finalModelDir?: string, device: string,
 *          gainDb?: number, streamThreads?: number, finalThreads?: number, decodeCapSec?: number,
 *          endpointRules?: {rule1MinTrailingSilence?: number, rule2MinTrailingSilence?: number,
 *                           rule3MinUtteranceLength?: number},
 *          asrSegmentOverlapMs?: number, maxUtteranceSec?: number,
 *          asrGroupCommitMs?: number, resumeGraceMs?: number,
 *          onUpdate?: (event: {partial?: string, final?: string, refined?: boolean,
 *                              durationMs?: number, truncated?: boolean, joinFallback?: boolean,
 *                              offlineLimited?: boolean, note?: string, event?: string|null,
 *                              eventClean?: string|null, utteranceId?: number,
 *                              source?: 'mic'|'loopback'|'unknown'}) =>
 *                               void|boolean|{accepted?: boolean, reason?: string},
 *          onEvent?: (type: string, payload: object) => void,
 *          asrWorkerEnabled?: boolean, asrWorkerFactory?: (init: object) => object,
 *          asrWorkerLanguage?: string,
 *          asrDecodeTimeoutMs?: number, asrDecodeTimeoutMaxMs?: number,
 *          asrQueueLimit?: number, asrQueueBytesLimit?: number,
 *          isVoicePlaying?: () => boolean,
 *          dialogueContext?: object|null, dialogueFactory?: () => object|null, now?: Function}} options
 */
export function startHearing({
  ffmpegPath,
  modelDir,
  finalModelDir = '',
  device,
  gainDb = 0,
  streamThreads = 2,
  finalThreads = 2,
  /** Endpoint-rule override (test/config seam); omitted keeps DEFAULT_ENDPOINT_RULES. */
  endpointRules = null,
  decodeCapSec = 15,
  /** Shared audio between neighbouring offline pieces; 0 restores the old hard cut. */
  asrSegmentOverlapMs = DEFAULT_SEGMENT_OVERLAP_MS,
  /** Hard bound on the audio kept for the accurate pass; older audio is dropped and flagged. */
  maxUtteranceSec = 90,
  /**
   * Commit buffer of one utterance group: after a natural endpoint the speaker gets at most this
   * long to continue before the merged text is delivered once. It is shared with the existing
   * decode budget (a decode that is still running absorbs it; no extra wait is added).
   */
  asrGroupCommitMs = DEFAULT_GROUP_COMMIT_MS,
  /**
   * Recovery window of the group commit buffer: after a confirmed continuation cancels the timer,
   * the buffer is re-armed as soon as this long passes without another confirmation. `0` re-arms on
   * the next tick; invalid values keep the shipping 500 ms.
   */
  resumeGraceMs = DEFAULT_GROUP_RESUME_GRACE_MS,
  minRmsDb = -50,
  onUpdate,
  /**
   * Lifecycle sink for `asr.worker.*`, `asr.decode`, `asr.decode.timeout`, `asr.queue.overflow`,
   * `asr.delivery.order` `{ seq, delivered, skipped }` (worker sessions only), and the noise shadow
   * (`hearing.noise.shadow` / `.suppressed`, worker sessions only). The host wires it to its event
   * log; without it the worker still runs, only its telemetry is dropped.
   */
  onEvent,
  /** Off-thread SenseVoice: on by default; a test can disable it or inject a fake thread. */
  asrWorkerEnabled = true,
  asrWorkerFactory = null,
  asrWorkerLanguage = 'auto',
  /**
   * Hardware/backpressure policy of the decode thread, mirroring the `asr.*` config block:
   * `asr.decodeTimeoutMs` (default 8000) fails a silent decode, `asr.queueLimit` (default 8) and the
   * 240 s / ~7.7 MB audio cap bound the backlog. Values are per session; `0` disables the deadline.
   */
  asrDecodeTimeoutMs = DEFAULT_ASR_DECODE_TIMEOUT_MS,
  asrDecodeTimeoutMaxMs = MAX_ASR_DECODE_TIMEOUT_MS,
  asrQueueLimit = DEFAULT_ASR_QUEUE_LIMIT,
  asrQueueBytesLimit = DEFAULT_ASR_QUEUE_BYTES,
  /**
   * Barge-in is decided by the host, so the delivery observation and the shadow row can only report
   * what this probe answers. Optional: without it `hearing.delivery.bargein` and the shadow's
   * `playing` are both `false`, never a guess.
   */
  isVoicePlaying = null,
  /**
   * Round-1 VAD shadow (worker sessions only). `vadModelPath` defaults to a `silero_vad.onnx`
   * next to the ASR models; when the shared `<root>/models` copy is missing it is downloaded on
   * demand (one task, checksum-pinned), and a failed download reports
   * `hearing.vad.unavailable {reason:'download-failed'}` while capture continues on energy only.
   * `vadFactory` is a test seam for a fake detector; `vadModelDownloader` replaces the download
   * step in tests (production never passes it). The shadow never feeds a synchronous session's
   * event log (same contract as `hearing.asr.*`).
   */
  vadModelPath = '',
  vadFactory = null,
  vadModelDownloader = null,
  vadModelMirrors = [],
  vadNumThreads = 1,
  vadEnabled = true,
  /**
   * Silero speech threshold the shadow detector is built with (default 0.5, the sherpa example
   * value). The host maps `voice.vadThreshold` here; the resolved number is recorded on every
   * `hearing.vad.shadow` row. Only the shadow reads it — delivery, grouping and gates never do.
   */
  vadThreshold = 0.5,
  /**
   * Speaker-voice shadow (worker sessions only; default OFF, mirroring `voice.speakerShadow`).
   * A delivered utterance is embedded and scored against the local speaker library, then one
   * `speaker.shadow` row is written. Nothing reads that row: delivery text, gates and order stay
   * untouched. `speakerModelPath`, `speakerEmbedderFactory`, `speakerLibrary`,
   * `speakerLibraryFactory`, `speakerModelDownloader` and `speakerModelMirrors` are seams exactly
   * like their VAD counterparts; `speakerLibraryRoot` is the library root (`<root>/memory`).
   */
  speakerShadow = false,
  speakerModelPath = '',
  speakerEmbedderFactory = null,
  speakerLibrary = null,
  speakerLibraryFactory = createSpeakerLibrary,
  speakerLibraryRoot = '',
  speakerModelDownloader = null,
  speakerModelMirrors = [],
  /**
   * Continuous dialogue capture (capture + boundary only; the rendered context is not injected).
   * `dialogueContext` is an instance the host may keep across capture sessions and `dialogueFactory`
   * is the test seam — it may return that same shared instance, or `null` to disable capture.
   * Omitted, each session gets one fresh buffer. `now` is the capture clock the dialogue timestamps
   * and the idle boundary read (test seam; the default is `Date.now`).
   */
  dialogueContext = null,
  dialogueFactory = createDialogueContext,
  now = Date.now,
  /** Test seams: production never passes these, so the real models and ffmpeg are used. */
  recognizer: recognizerOverride,
  finalRecognizer: finalRecognizerOverride,
  finalRecognizerFactory = createFinalRecognizer,
  spawnProcess = spawn,
}) {
  const recognizer = recognizerOverride ?? createRecognizer(modelDir, {
    numThreads: streamThreads,
    endpoint: endpointRules ?? {},
  });
  const stream = recognizer.createStream();
  /**
   * What this session records: a real microphone, a loopback of what the speakers play, or an
   * unnamed input. The host needs it because a tag heard on a loopback may be a video, not the user.
   */
  const inputSource = typeof device === 'string' && device.length > 0
    ? (isLoopbackDevice(device) ? 'loopback' : 'mic')
    : 'unknown';

  let lastError = null;
  // Final pass is optional: a missing model just means "use the streaming text".
  let finalRecognizer = null;
  /** An explicit `null` override means "no accurate pass"; it is never re-created lazily. */
  let finalRecognizerUnavailable = finalRecognizerOverride === null;
  const asrWorkerRequested = finalRecognizerOverride === undefined
    && (asrWorkerFactory !== null || (asrWorkerEnabled && finalModelReady(finalModelDir)));
  if (finalRecognizerOverride !== undefined) {
    finalRecognizer = finalRecognizerOverride;
  } else if (asrWorkerRequested) {
    // The SenseVoice model lives in the worker thread; this thread loads it only after a degrade.
  } else if (finalModelReady(finalModelDir)) {
    try {
      finalRecognizer = createFinalRecognizer(finalModelDir, { numThreads: finalThreads });
    } catch (error) {
      lastError = `final recognizer unavailable: ${error?.message ?? error}`;
    }
  }

  /** Set once the capture loop is over; a late VAD download must not attach to a dead session. */
  let stopped = false;

  /**
   * Continuous dialogue capture: the buffer this session pushes delivered finals into. Event rows
   * follow the `hearing.asr.*` contract (worker sessions only); the buffer itself always fills.
   */
  const dialogueBuffer = resolveDialogueBuffer(dialogueContext, dialogueFactory, inputSource, device);
  const dialogue = createDialogueCapture({
    context: dialogueBuffer, source: inputSource, now, emit: asrWorkerRequested ? onEvent : null,
  });
  const captureNow = typeof now === 'function' ? now : Date.now;
  // A continued buffer is a segment boundary on restart; a changed capture always is.
  const previousCapture = dialogueBuffer === null ? null : (DIALOGUE_LAST_CAPTURE.get(dialogueBuffer) ?? null);
  const restartReason = previousCapture !== null && previousCapture.source !== dialogue.source
    ? 'source-switch'
    : (previousCapture !== null && previousCapture.device !== '' && previousCapture.device !== device
      ? 'device-switch'
      : (dialogue.hasOpenSentence() ? 'start' : ''));
  if (restartReason !== '') {
    // A restart that really changed the capture names both sides; a same-source restart does not.
    const crossing = restartReason === 'source-switch' && previousCapture !== null;
    dialogue.markBoundary(restartReason, crossing
      ? { from: previousCapture.source, to: dialogue.source }
      : {});
  }
  if (dialogueBuffer !== null) DIALOGUE_LAST_CAPTURE.set(dialogueBuffer, { source: dialogue.source, device });

  /** This session's on-demand VAD download; stop aborts it, and a mounted VAD is left untouched. */
  let vadDownloadController = null;
  /** The one resolved threshold: handed to the detector and stamped on every shadow row. */
  const vadThresholdValue = resolveVadThreshold(vadThreshold);
  const abortVadDownload = (reason) => {
    const controller = vadDownloadController;
    vadDownloadController = null;
    if (controller !== null && controller.signal.aborted !== true) controller.abort(reason);
  };

  /**
   * VAD shadow, set up once per session before the first frame. Worker sessions only: the
   * synchronous fallback keeps its event log empty, exactly like `hearing.asr.*`.
   *
   * The detector is built only from a verified model file. When the shared `<root>/models` copy is
   * missing, the session downloads it on demand in the background; until it is ready (or after a
   * failed download) the shadow stays off and capture continues unchanged. One failure — download,
   * setup or the first frame — is reported once and disables the shadow; it never fails the session
   * or repeats the row.
   */
  let vadShadow = null;
  const vadState = {
    available: false,
    reason: vadEnabled === false ? 'disabled' : '',
    modelPath: '',
    download: vadEnabled === false ? 'disabled' : 'idle',
  };
  let vadUnavailableNotified = false;
  const reportVadUnavailable = (reason) => {
    vadState.available = false;
    vadState.reason = reason;
    if (vadUnavailableNotified) return;
    vadUnavailableNotified = true;
    try {
      onEvent?.('hearing.vad.unavailable', { level: 'debug', reason });
    } catch {
      /* an event sink must never break capture */
    }
  };
  /** Build the detector once a model path is known; null from the factory means "unavailable". */
  const attachVad = (modelPath) => {
    try {
      // A test double needs no model file; the production factory returns null when it is missing.
      const build = typeof vadFactory === 'function' ? vadFactory : createSileroVad;
      const detector = build({
        modelPath,
        sampleRate: 16000,
        numThreads: Math.max(1, Math.floor(Number(vadNumThreads) || 1)),
        threshold: vadThresholdValue,
      });
      if (detector === null || detector === undefined) {
        throw new Error(`${VAD_MODEL_FILE} 不可用: ${modelPath || '(未配置)'}`);
      }
      // The shadow reports a starved window (samples in, no complete VAD window) through the same
      // safe debug outlet as its rows; `onEvent` may be absent and must never break capture.
      const onDiagnostic = (type, payload) => {
        try {
          onEvent?.(type, payload);
        } catch {
          /* a diagnostic sink must never break capture */
        }
      };
      vadShadow = createVadShadow(detector, {
        sampleRate: 16000,
        threshold: vadThresholdValue,
        onDiagnostic,
      });
      vadState.available = true;
      vadState.modelPath = modelPath;
      vadState.download = 'ready';
      vadState.reason = '';
      return true;
    } catch (error) {
      vadShadow = null;
      reportVadUnavailable(String(error?.message ?? error));
      return false;
    }
  };
  if (asrWorkerRequested && vadEnabled !== false) {
    const candidates = [
      vadModelPath,
      finalModelDir === '' ? '' : join(finalModelDir, VAD_MODEL_FILE),
      modelDir === '' ? '' : join(modelDir, VAD_MODEL_FILE),
      finalModelDir === '' && modelDir === '' ? '' : join(dirname(finalModelDir || modelDir), VAD_MODEL_FILE),
    ];
    const resolvedModel = findVadModelPath(candidates);
    // Only the shared `<root>/models` destination is downloaded; an explicitly configured missing
    // path keeps the old "report unavailable" behavior instead of writing somewhere else.
    const downloadTarget = vadModelPath === '' ? vadModelTarget({ modelDir, finalModelDir }) : '';
    const canDownload = downloadTarget !== '' && (typeof vadModelDownloader === 'function'
      || (typeof vadFactory !== 'function' && isSharedModelTarget(downloadTarget)));
    if (resolvedModel !== '') {
      attachVad(resolvedModel);
    } else if (canDownload) {
      // On demand, never at startup and never for a disabled/absent component: this block runs only
      // for an enabled VAD inside a worker session. The download module shares one task per path.
      vadState.download = 'downloading';
      vadState.reason = 'downloading';
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      vadDownloadController = controller;
      const startDownload = typeof vadModelDownloader === 'function' ? vadModelDownloader : ensureVadModel;
      const clearDownload = () => {
        if (vadDownloadController === controller) vadDownloadController = null;
      };
      void Promise.resolve()
        .then(() => startDownload({
          targetPath: downloadTarget,
          mirrors: vadModelMirrors,
          signal: controller?.signal,
          onEvent,
        }))
        .then((result) => {
          clearDownload();
          if (stopped) return;
          if (result?.ok === false || typeof result?.path !== 'string' || result.path.length === 0) {
            throw new Error(result?.reason ?? 'download-failed');
          }
          attachVad(result.path);
        })
        .catch((error) => {
          clearDownload();
          // Stopped or cancelled is not a download failure: the download module already reported
          // `vad.model.cancelled`, and this session is ending anyway.
          if (stopped || error?.name === 'AbortError' || error?.reason === 'cancelled') {
            vadState.download = 'cancelled';
            vadState.reason = 'cancelled';
            return;
          }
          vadState.download = 'failed';
          reportVadUnavailable('download-failed');
        });
    } else if (typeof vadFactory === 'function') {
      // A test double needs no model file; production never takes this branch.
      attachVad('');
    } else {
      const searched = candidates.filter((candidate) => typeof candidate === 'string' && candidate.length > 0);
      reportVadUnavailable(`未找到 ${VAD_MODEL_FILE}（查找: ${searched.join('; ') || '(无候选路径)'}）`);
    }
  }

  // ---- Speaker-voice shadow: score a DELIVERED utterance; never gate, reorder or rewrite it. ----
  const speakerShadowOn = asrWorkerRequested && (speakerShadow === true
    || (speakerShadow !== null && typeof speakerShadow === 'object' && speakerShadow.enabled === true));
  let speakerEmbedder = null;
  let speakerEmbedderState = 'idle'; // idle → downloading/ready/failed; one attempt per session
  let speakerLibraryInstance = speakerLibrary ?? null;
  let speakerLibraryTried = speakerLibraryInstance !== null;
  let speakerLibraryOwned = false;
  let speakerDownloadController = null;
  let speakerFailureReported = false;
  const speakerModelCandidates = [
    speakerModelPath,
    finalModelDir === '' ? '' : join(finalModelDir, SPEAKER_MODEL_FILE),
    modelDir === '' ? '' : join(modelDir, SPEAKER_MODEL_FILE),
    finalModelDir === '' && modelDir === ''
      ? ''
      : join(dirname(finalModelDir || modelDir), SPEAKER_MODEL_FILE),
  ];
  const speakerModelResolved = speakerModelCandidates.find(
    (candidate) => typeof candidate === 'string' && candidate.length > 0 && existsSync(candidate),
  ) ?? '';
  const speakerDownloadTarget = speakerModelPath === ''
    ? speakerModelTarget({ modelDir, finalModelDir })
    : '';
  const speakerCanDownload = speakerDownloadTarget !== ''
    && (typeof speakerModelDownloader === 'function'
      || (typeof speakerEmbedderFactory !== 'function' && isSharedModelTarget(speakerDownloadTarget)));

  /** One failure row per session; a later utterance must not repeat it. */
  const reportSpeakerFailure = (reason) => {
    if (!speakerShadowOn || speakerFailureReported) return;
    speakerFailureReported = true;
    try {
      onEvent?.('speaker.model.failed', { reason });
    } catch {
      /* an event sink must never break capture */
    }
  };
  /** Runtime failures are debug-only (`speaker.shadow.debug`), never a model failure or a gate. */
  const noteSpeakerDebug = (reason, error) => {
    try {
      onEvent?.('speaker.shadow.debug', { level: 'debug', reason, message: String(error?.message ?? error) });
    } catch {
      /* an event sink must never break capture */
    }
  };
  const abortSpeakerDownload = (reason) => {
    const controller = speakerDownloadController;
    speakerDownloadController = null;
    if (controller !== null && controller.signal.aborted !== true) controller.abort(reason);
  };
  /** Build the embedder from a ready model; a null/unusable one is a failure, not a throw. */
  const attachSpeaker = (modelPath) => {
    try {
      const build = typeof speakerEmbedderFactory === 'function' ? speakerEmbedderFactory : createSpeakerEmbedder;
      const embedder = build({ modelPath });
      if (embedder === null || typeof embedder?.embed !== 'function') {
        throw new Error(`speaker model unavailable: ${modelPath || '(missing)'}`);
      }
      speakerEmbedder = embedder;
      speakerEmbedderState = 'ready';
    } catch {
      speakerEmbedderState = 'failed';
      reportSpeakerFailure('unavailable');
    }
    return speakerEmbedder;
  };
  /**
   * Lazily load the embedder on the first long, delivered utterance. A missing model goes through
   * the pinned on-demand download; while it runs (and after a failure) the shadow stays silent.
   */
  const ensureSpeakerEmbedder = () => {
    if (speakerEmbedderState === 'ready') return speakerEmbedder;
    if (speakerEmbedderState !== 'idle') return null;
    if (typeof speakerEmbedderFactory === 'function') return attachSpeaker(speakerModelResolved);
    if (speakerModelResolved !== '') return attachSpeaker(speakerModelResolved);
    if (!speakerCanDownload) {
      speakerEmbedderState = 'failed';
      reportSpeakerFailure('missing');
      return null;
    }
    speakerEmbedderState = 'downloading';
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    speakerDownloadController = controller;
    const startDownload = typeof speakerModelDownloader === 'function' ? speakerModelDownloader : ensureSpeakerModel;
    void Promise.resolve()
      .then(() => startDownload({
        targetPath: speakerDownloadTarget,
        mirrors: speakerModelMirrors,
        signal: controller?.signal,
      }))
      .then((result) => {
        if (speakerDownloadController === controller) speakerDownloadController = null;
        if (stopped) return;
        if (result?.ok === false || typeof result?.path !== 'string' || result.path.length === 0) {
          const reason = typeof result?.reason === 'string' ? result.reason : 'download-failed';
          throw Object.assign(new Error(reason), { reason });
        }
        attachSpeaker(result.path);
      })
      .catch((error) => {
        if (speakerDownloadController === controller) speakerDownloadController = null;
        if (stopped || error?.name === 'AbortError' || error?.reason === 'cancelled') {
          speakerEmbedderState = 'failed';
          return;
        }
        speakerEmbedderState = 'failed';
        reportSpeakerFailure(typeof error?.reason === 'string' ? error.reason : 'download-failed');
      });
    return null;
  };
  const ensureSpeakerLibrary = () => {
    if (speakerLibraryInstance !== null) return speakerLibraryInstance;
    if (speakerLibraryTried) return null;
    speakerLibraryTried = true;
    try {
      const build = typeof speakerLibraryFactory === 'function' ? speakerLibraryFactory : createSpeakerLibrary;
      speakerLibraryInstance = build({ root: speakerLibraryRoot }) ?? null;
      speakerLibraryOwned = speakerLibraryInstance !== null;
    } catch (error) {
      noteSpeakerDebug('library-failed', error);
    }
    return speakerLibraryInstance;
  };
  /** Close only a library this session opened; an injected instance stays the caller's. */
  const closeSpeakerLibrary = () => {
    if (!speakerLibraryOwned) return;
    speakerLibraryOwned = false;
    try {
      speakerLibraryInstance?.close?.();
    } catch {
      /* already closed */
    }
    speakerLibraryInstance = null;
  };
  const emitSpeakerShadow = (payload) => {
    try {
      onEvent?.('speaker.shadow', payload);
    } catch {
      /* a diagnostic row must never break delivery */
    }
  };
  /** Score one utterance against the library. Runs after delivery and never touches its update. */
  const runSpeakerShadow = (snapshot) => {
    if (stopped) return;
    try {
      const embedder = ensureSpeakerEmbedder();
      if (embedder === null) return;
      const library = ensureSpeakerLibrary();
      if (library === null) return;
      if (library.list().filter((speaker) => speaker.enabled !== false).length === 0) {
        emitSpeakerShadow({ decision: 'no-speakers' });
        return;
      }
      const embedding = embedder.embed(snapshot.speakerSamples);
      if (!(embedding instanceof Float32Array) || embedding.length === 0) {
        emitSpeakerShadow({ decision: 'unsure', reason: 'no-embedding', utteranceId: snapshot.id });
        return;
      }
      const startedAt = Date.now();
      const result = library.match(embedding);
      const ms = Math.max(0, Math.round(Date.now() - startedAt));
      emitSpeakerShadow({
        decision: result.decision,
        score: result.score,
        speakerId: result.speakerId,
        ms,
        utteranceId: snapshot.id,
      });
    } catch (error) {
      noteSpeakerDebug('shadow-failed', error);
    }
  };
  /** Called only from the delivered branch: too-short is recorded without loading/computing. */
  const maybeSpeakerShadow = (snapshot) => {
    if (!speakerShadowOn || stopped) return;
    const samples = snapshot.speakerSamples;
    if (!(samples instanceof Float32Array) || samples.length < SPEAKER_SHADOW_MIN_SAMPLES) {
      emitSpeakerShadow({ decision: 'unsure', reason: 'too-short' });
      return;
    }
    setImmediate(() => runSpeakerShadow(snapshot));
  };

  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'dshow',
    '-i',
    `audio=${device}`,
    '-ac',
    '1',
    '-ar',
    '16000',
  ];
  if (gainDb !== 0) args.push('-af', `volume=${gainDb}dB,highpass=f=80`);
  args.push('-f', 's16le', '-');

  const child = spawnProcess(ffmpegPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

  let resolveDone;
  let rejectDone;
  const done = new Promise((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  // Callers that only read stats never await `done`; keep a failed spawn from becoming an
  // unhandled rejection while `await hearing.done` still receives the error.
  done.catch(() => {});
  let workerClient = null;
  child.on('close', (code, signal) => {
    // The capture loop is over for good: no pending decode may still deliver a transcript.
    stopped = true;
    // A buffered group dies with the capture session; it is never delivered late.
    dropGroup('stopped');
    // The last dialogue segment is closed too, so a later session cannot splice onto it.
    dialogue.close('stop');
    abortVadDownload('shutdown');
    abortSpeakerDownload('shutdown');
    closeSpeakerLibrary();
    closeDeliveries();
    workerClient?.stop();
    resolveDone({ code, signal, error: lastError });
  });
  child.on('error', (error) => {
    lastError = `ffmpeg 启动失败: ${error?.message ?? error}`;
    rejectDone(error);
  });

  let pending = Buffer.alloc(0);
  let partial = '';
  let frames = 0;
  let finals = 0;
  let rms = 0;
  let peak = 0;
  /**
   * Audio of the current utterance, kept for the final-pass decoder. Buffering is hard-capped:
   * `utteranceSamples` never exceeds `MAX_UTTERANCE`, while `utteranceSeenSamples` keeps counting
   * so the reported duration is the complete utterance length even when the tail is dropped.
   */
  let utterance = [];
  let utteranceSamples = 0;
  let utteranceSeenSamples = 0;
  /** Peak of the current utterance (reset at every endpoint; the shadow row reports it). */
  let utterancePeak = 0;
  let truncated = false;
  let dropped = 0;
  let hallucination = 0;
  let truncations = 0;
  /** Debug rows (`hearing.asr.*`, `hearing.delivery`): throttled and never allowed to break capture. */
  let observeRows = 0;
  let observeWindowAt = 0;
  const observe = (type, payload) => {
    // The synchronous fallback keeps its event log empty, exactly like `asr.delivery.order`.
    if (!asrWorkerRequested) return;
    const at = Date.now();
    if (at - observeWindowAt >= ASR_OBSERVE_WINDOW_MS) {
      observeWindowAt = at;
      observeRows = 0;
    }
    if (observeRows >= ASR_OBSERVE_MAX_ROWS) return;
    observeRows += 1;
    try {
      onEvent?.(type, { level: 'debug', ...payload });
    } catch {
      /* an event sink must never break capture */
    }
  };
  /**
   * Round-1 diagnostics. These are counters over decisions this session already made; no delivery
   * path reads them. `stats().diagnostics` is the queryable form, and the same summary is written
   * as one debug row at most once a minute (lazy, on the frame path that already ticks — no timer).
   *
   * `dropAtBoundaryCount` aggregates the existing per-final edge flags: `joinFallback` (a cut whose
   * overlap could not be verified, so a head/tail word may be duplicated or lost) and `truncated`
   * (the accurate pass lost the tail past its cap). It is a summary of what the session already
   * reported, not a new measurement.
   */
  let noiseTriggerCount = 0;
  let shortAnswerCount = 0;
  let dropAtBoundaryCount = 0;
  const DELIVER_LATENCY_MAX_SAMPLES = 240;
  const deliverLatencySamples = [];
  const DIAGNOSTICS_SAMPLE_MS = 60_000;
  let diagnosticsSampledAt = 0;
  let heapUsedMb = 0;
  /** Nearest-rank percentile over an ascending copy; null when nothing was sampled. */
  const percentileOf = (values, fraction) => {
    if (values.length === 0) return null;
    const sorted = [...values].sort((left, right) => left - right);
    const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
    return sorted[rank];
  };
  const deliverLatencySummary = () => ({
    count: deliverLatencySamples.length,
    p50Ms: percentileOf(deliverLatencySamples, 0.5),
    p95Ms: percentileOf(deliverLatencySamples, 0.95),
    maxMs: deliverLatencySamples.length === 0 ? null : Math.max(...deliverLatencySamples),
  });
  /** Decode queue + delivery slot backlog: work already accepted but not yet delivered. */
  const queueBacklogNow = () => (workerClient === null ? 0 : workerClient.status().queued)
    + pendingDeliveries.size;
  const diagnosticsSummary = () => ({
    noiseTriggerCount,
    shortAnswerCount,
    dropAtBoundaryCount,
    deliverLatency: deliverLatencySummary(),
    queueBacklog: queueBacklogNow(),
    queuedBytes: workerClient === null ? 0 : workerClient.status().queuedBytes,
    heapUsedMb,
    sampledAt: diagnosticsSampledAt,
    vad: {
      available: vadState.available,
      reason: vadState.reason,
      enabled: vadEnabled !== false,
      modelPath: vadState.modelPath,
      download: vadState.download,
    },
  });
  /** Lazy minute sample: one heap reading, one debug row. Never a new timer. */
  const sampleDiagnostics = () => {
    const at = Date.now();
    if (at - diagnosticsSampledAt < DIAGNOSTICS_SAMPLE_MS) return;
    diagnosticsSampledAt = at;
    try {
      heapUsedMb = Math.round((process.memoryUsage().heapUsed / (1024 * 1024)) * 10) / 10;
    } catch {
      heapUsedMb = 0;
    }
    const summary = diagnosticsSummary();
    observe('hearing.diagnostics', {
      heapUsedMb: summary.heapUsedMb,
      queueBacklog: summary.queueBacklog,
      queuedBytes: summary.queuedBytes,
      noiseTriggerCount: summary.noiseTriggerCount,
      shortAnswerCount: summary.shortAnswerCount,
      dropAtBoundaryCount: summary.dropAtBoundaryCount,
      deliverLatencyP50Ms: summary.deliverLatency.p50Ms,
      deliverLatencyP95Ms: summary.deliverLatency.p95Ms,
    });
  };
  /** Barge-in is the host's decision: this only forwards what the optional probe saw. */
  const voiceSounding = () => {
    if (typeof isVoicePlaying !== 'function') return false;
    try {
      return isVoicePlaying() === true;
    } catch {
      return false;
    }
  };
  /**
   * Noise-shadow rows already written. The throttle only decides whether a *log* row is written:
   * no delivery path reads this list, and a suppressed row changes nothing about `text`.
   */
  const shadowRows = [];
  /** Same words once tags/punctuation/space are gone — "similar text" for the shadow throttle. */
  const similarShadowText = (left, right) => left === right
    || (left.length >= 2 && right.length >= 2 && (left.includes(right) || right.includes(left)));
  /**
   * Record one `hearing.noise.shadow` row for a final whose verdict is already made.
   *
   * Round 1 is a shadow: the row is written *after* `finishUtterance` decided, nothing here is read
   * back, and `text` is delivered exactly as before. Whether a later round filters on any of this
   * depends on the comparison data collected from these rows.
   *
   * Payload: `{ utteranceId, segmentIds, decodeTaskId, deliveryId, endpointReason, durationMs,
   * maxDurationMs, voicedMs, voicedRatio, vadSpeechMs, vadSpeechRatio, vadRatioSource,
   * energyVoicedRatio, energySource, onlineText, offlineText, onlineOfflineAgree, playing,
   * device, rmsDb, peakDb, tags, suspect, text, delivered, wouldDrop, wouldDropReason }`.
   *  - `voicedMs`/`voicedRatio` are the energy meter's row from round 1; `energyVoicedRatio` is the
   *    same number under the name that says which method produced it. `vadSpeechRatio` is the real
   *    VAD (Silero) and `vadRatioSource` is `'silero'` or `null` (not measured) — the two are never
   *    merged and neither ever stands in for the other.
   *  - `wouldDrop` computes what a later round *would* filter; `delivered` above is already final
   *    and no branch reads it back. `wouldDropReason` explains the verdict (see
   *    `wouldDropVerdict`), and every protected short answer stays `false`.
   *  - `deliveryId` is the utterance's delivery slot: worker sessions deliver strictly in utterance
   *    order, so it is the same number `asr.delivery.order.seq` reports.
   *  - `maxDurationMs` is the endpoint's maximum-utterance-length rule — the cap whose hit
   *    `endpointReason: 'max-duration'` reports. The accurate-pass buffer cap (`maxUtteranceSec`)
   *    is a different bound and is surfaced by `truncated` on the delivery update.
   *  - a repeated suspect + similar text within `SHADOW_SUPPRESS_WINDOW_MS` writes one
   *    `hearing.noise.shadow.suppressed { count }` instead of a second full row.
   */
  const noteNoiseShadow = (snapshot, outcome, delivered) => {
    try {
      // Same contract as `hearing.asr.*`: the synchronous fallback keeps its event log empty.
      if (!asrWorkerRequested) return;
      // A text-less judgment is ordinary room tone (one endpoint every few seconds on an idle mic):
      // recording it would flood the log without adding evidence.
      if (outcome.text.length === 0) return;
      const at = Date.now();
      for (let index = shadowRows.length - 1; index >= 0; index -= 1) {
        if (at - shadowRows[index].at >= SHADOW_SUPPRESS_WINDOW_MS) shadowRows.splice(index, 1);
      }
      const suspects = noiseSuspects({
        text: outcome.text,
        durationMs: snapshot.durationMs,
        endpointReason: snapshot.endpointReason,
        voicedMs: snapshot.voicedMs,
      });
      // Diagnostics: one suspicious judgment per call, whether or not the row is throttled below.
      if (suspects.length > 0) noiseTriggerCount += 1;
      const suspectKey = suspects.join(',');
      const textKey = shadowTextKey(outcome.text);
      const known = shadowRows.find(
        (row) => row.suspects === suspectKey && similarShadowText(row.text, textKey),
      );
      if (known !== undefined) {
        known.count += 1;
        onEvent?.('hearing.noise.shadow.suppressed', { level: 'debug', count: known.count });
        return;
      }
      shadowRows.push({ at, suspects: suspectKey, text: textKey, count: 0 });
      if (shadowRows.length > 64) shadowRows.shift();
      const offlineText = typeof outcome.offlineText === 'string' ? outcome.offlineText : '';
      const playing = voiceSounding();
      const agree = onlineOfflineAgree(snapshot.onlineText, offlineText);
      // Record only: `delivered` is already final above and nothing reads this verdict back.
      const { wouldDrop, wouldDropReason } = wouldDropVerdict({
        vadSpeechRatio: snapshot.vadSpeechRatio ?? null,
        energyVoicedRatio: snapshot.voicedRatio,
        text: outcome.text,
        durationMs: snapshot.durationMs,
        endpointReason: snapshot.endpointReason,
        playing,
        onlineOfflineAgree: agree,
      });
      onEvent?.('hearing.noise.shadow', {
        level: 'debug',
        utteranceId: snapshot.id,
        segmentIds: Array.isArray(outcome.segmentIds) ? outcome.segmentIds : [],
        decodeTaskId: outcome.decodeTaskId ?? null,
        deliveryId: snapshot.id,
        endpointReason: snapshot.endpointReason,
        durationMs: snapshot.durationMs,
        maxDurationMs: snapshot.maxDurationMs,
        voicedMs: snapshot.voicedMs,
        voicedRatio: snapshot.voicedRatio,
        // Two measurements, two names, two sources: real VAD next to the volume/energy meter.
        vadSpeechMs: snapshot.vadSpeechMs ?? null,
        vadSpeechRatio: snapshot.vadSpeechRatio ?? null,
        vadRatioSource: snapshot.vadRatioSource ?? null,
        energyVoicedRatio: snapshot.voicedRatio,
        energySource: 'energy',
        onlineText: snapshot.onlineText,
        offlineText,
        onlineOfflineAgree: agree,
        playing,
        device,
        rmsDb: snapshot.rmsDb,
        peakDb: snapshot.peakDb,
        tags: { lang: outcome.lang ?? null, emotion: outcome.emotion ?? null, event: outcome.event ?? null },
        suspect: suspects,
        text: outcome.text,
        delivered,
        wouldDrop,
        wouldDropReason,
      });
    } catch {
      /* a diagnostic row must never break capture or delivery */
    }
  };
  /**
   * VAD-shadow rows already written. Like the noise shadow, this list only decides whether a log
   * row is written: `hearing.vad.shadow` is emitted after the utterance's audio window closed and
   * is never read by a delivery path.
   */
  const vadRows = [];
  /**
   * Record one `hearing.vad.shadow` row for an utterance whose energy metrics are already measured.
   *
   * Payload: `{ utteranceId, device, source, durationMs, speechMs, speechRatio, segments,
   * firstSpeechMs, lastSpeechMs, trailingSilenceMs, energyVoicedRatio, agree, windowsFed, vadFrames,
   * threshold, samplesFed, chunkSamples, chunkPeak, chunkRms, zeroRatio, maxSilenceRun }`.
   *  - `segments` are the first `VAD_SEGMENT_LIMIT` detected speech ranges, relative to the
   *    utterance window; `speechMs`/`speechRatio` summarize every detected segment.
   *  - `source` is this capture's lane (`mic` / `loopback`): the same number on the mic and the
   *    loopback lane means something different, so a row must say which one it measured.
   *  - `samplesFed`/`chunkSamples`/`chunkPeak`/`chunkRms`/`zeroRatio`/`maxSilenceRun` describe the
   *    PCM the detector was actually fed (`chunkSamples` is the last capture chunk; peak/RMS are
   *    linear 0..1 over the whole window, the rest also covers the window). `speechMs: 0` next to
   *    `zeroRatio: 1` is a silent capture, not a detector failure; `maxSilenceRun` is the longest
   *    run of exact-zero samples, in ms.
   *  - `threshold` is the resolved Silero speech threshold the detector was built with.
   *  - `agree` compares the VAD verdict with the existing energy verdict at
   *    `VAD_AGREE_MIN_RATIO`: same side of "speech present", not a new threshold.
   *  - a repeated utterance with similar streaming text within `SHADOW_SUPPRESS_WINDOW_MS` writes
   *    one `hearing.vad.shadow.suppressed { count }` instead of a second full row.
   *
   * @returns the metrics (used to stamp delivery latency) or null when the shadow is off.
   */
  const noteVadShadow = (snapshot, voiced) => {
    if (vadShadow === null) return null;
    let metrics = null;
    try {
      metrics = vadShadow.takeUtterance({
        durationMs: snapshot.durationMs,
        energyVoicedRatio: voiced === null ? null : voiced.voicedRatio,
      });
    } catch (error) {
      vadShadow = null;
      reportVadUnavailable(`VAD 运行失败: ${error?.message ?? error}`);
      return null;
    }
    if (metrics === null) return null;
    try {
      const at = Date.now();
      for (let index = vadRows.length - 1; index >= 0; index -= 1) {
        if (at - vadRows[index].at >= SHADOW_SUPPRESS_WINDOW_MS) vadRows.splice(index, 1);
      }
      const textKey = shadowTextKey(snapshot.onlineText);
      const known = vadRows.find(
        (row) => row.device === device && similarShadowText(row.text, textKey),
      );
      if (known !== undefined) {
        known.count += 1;
        onEvent?.('hearing.vad.shadow.suppressed', { level: 'debug', count: known.count });
        return metrics;
      }
      vadRows.push({ at, device, text: textKey, count: 0 });
      if (vadRows.length > 64) vadRows.shift();
      onEvent?.('hearing.vad.shadow', {
        level: 'debug',
        utteranceId: snapshot.id,
        device,
        // Which capture this window came from. The two lanes run the same shadow, so without
        // `source` a silent mic row and a silent loopback row would be indistinguishable.
        source: dialogue.source,
        ...metrics,
      });
    } catch {
      /* a diagnostic row must never break capture or delivery */
    }
    return metrics;
  };
  /** Size of one offline decode piece; short utterances stay a single piece. */
  const SEGMENT_SAMPLES = Math.floor(16000 * Math.max(1, decodeCapSec));
  /**
   * Shared audio on both sides of every cut, so a word that straddles it is fully inside both
   * neighbours; the joint audio is decoded once more and used as the trim anchor.
   */
  const SEGMENT_OVERLAP_SAMPLES = segmentOverlapSamples(asrSegmentOverlapMs);
  /** Memory hard cap for the accurate pass (~90 s of 16 kHz float32 by default). */
  const MAX_UTTERANCE_SECONDS = Math.max(1, Math.round(Number(maxUtteranceSec)));
  const MAX_UTTERANCE = Math.max(1, Math.floor(16000 * Math.max(1, maxUtteranceSec)));
  /**
   * The endpoint's own maximum utterance length (rule 3), in milliseconds: the cap whose hit the
   * shadow row reports as `endpointReason: 'max-duration'`. It is not the accurate-pass buffer cap
   * (`maxUtteranceSec`, reported through `truncated`), and it is not a filter either.
   */
  const MAX_ENDPOINT_MS = ENDPOINT_MAX_UTTERANCE_SEC * 1000;
  /**
   * The only duration-based rejection: below this a clip is a click, a key blip or a breath, and it
   * cannot hold a word. 600 ms is deliberately *not* a threshold anymore — a clear "好"/"不"/"停"
   * is often only 300 ms. Above this floor the text decides whether the utterance was speech.
   */
  const MIN_AUDIO_MS = 150;
  /** Below this the segment is silence; SenseVoice likes to invent text for silence. */
  const MIN_RMS_DB = Number.isFinite(minRmsDb) ? minRmsDb : -50;
  /** Resolved commit buffer: invalid/negative config falls back to the shipping 300 ms. */
  const GROUP_COMMIT_MS = Number.isFinite(Number(asrGroupCommitMs)) && Number(asrGroupCommitMs) >= 0
    ? Math.min(Number(asrGroupCommitMs), 5_000)
    : DEFAULT_GROUP_COMMIT_MS;
  const RESUME_GRACE_MS = Number.isFinite(Number(resumeGraceMs)) && Number(resumeGraceMs) >= 0
    ? Math.min(Number(resumeGraceMs), 10_000)
    : DEFAULT_GROUP_RESUME_GRACE_MS;
  /** Resume evidence is measured on the same 20 ms frames as the energy VAD. */
  const GROUP_FRAME_SAMPLES = Math.max(1, Math.round((16000 * VOICED_FRAME_MS) / 1000));

  /**
   * The synchronous SenseVoice recognizer is a fallback, not the normal path: with the worker on,
   * the model is built on this thread only after the thread had to be given up on
   * (`asr.worker.degraded`). The offline result is the same function either way.
   */
  const syncFinalRecognizer = () => {
    if (finalRecognizer !== null) return finalRecognizer;
    if (finalRecognizerUnavailable || finalModelDir === '') return null;
    try {
      finalRecognizer = finalRecognizerFactory(finalModelDir, { numThreads: finalThreads });
      return finalRecognizer;
    } catch (error) {
      finalRecognizerUnavailable = true;
      lastError = `final recognizer unavailable: ${error?.message ?? error}`;
      return null;
    }
  };

  /** Lazily start the decode thread: an utterance that never finalizes never spawns it. */
  const ensureWorker = () => {
    if (workerClient === null) {
      workerClient = createAsrWorkerClient({
        workerFactory: asrWorkerFactory ?? defaultAsrWorkerFactory,
        init: {
          modelDir: finalModelDir,
          numThreads: finalThreads,
          segmentSamples: SEGMENT_SAMPLES,
          overlapSamples: SEGMENT_OVERLAP_SAMPLES,
          language: asrWorkerLanguage,
        },
        onEvent,
        decodeTimeoutMs: asrDecodeTimeoutMs,
        maxDecodeTimeoutMs: asrDecodeTimeoutMaxMs,
        queueLimit: asrQueueLimit,
        queueBytesLimit: asrQueueBytesLimit,
      });
    }
    return workerClient;
  };

  /** Utterances whose delivery already ran; a worker result must never deliver one twice. */
  const deliveredUtterances = new Set();
  let utteranceSeq = 0;
  const markDelivered = (id) => {
    deliveredUtterances.add(id);
    if (deliveredUtterances.size > 64) {
      const oldest = deliveredUtterances.values().next().value;
      deliveredUtterances.delete(oldest);
    }
  };

  /** Pick the offline text when it is usable; otherwise keep the streaming text. */
  const adoptOffline = (snapshot, pass) => {
    const better = typeof pass?.text === 'string' ? pass.text : '';
    // The offline pass only sees the buffered prefix. When the utterance was truncated, a nonempty
    // streaming text already covers the dropped tail, so it stays authoritative.
    const offlineCoversLess = snapshot.truncated && snapshot.onlineText.length > 0;
    // The tags are only meaningful when the refined text is adopted; every other outcome reports
    // them as null and says where they would have come from (`sync` = this thread decoded it).
    const tagSource = pass === null || pass === undefined
      ? 'none'
      : (pass.tagSource === 'sync' ? 'sync' : 'worker');
    /**
     * Identity of the decode that produced this verdict, carried for the shadow row only: the raw
     * offline text (recorded even when it is not adopted, so both passes can be compared) plus the
     * decode request and its per-piece ids.
     */
    const decoded = {
      offlineText: better,
      decodeTaskId: pass?.decodeTaskId ?? null,
      segmentIds: Array.isArray(pass?.segmentIds) ? pass.segmentIds : [],
    };
    if (better.length > 0 && !offlineCoversLess) {
      return {
        text: better,
        refined: true,
        joinFallback: pass?.joinFallback === true,
        ...decoded,
        ...asrTagFields(pass),
        tagSource,
      };
    }
    return {
      text: snapshot.onlineText,
      refined: false,
      joinFallback: false,
      ...decoded,
      ...asrTagFields(null),
      tagSource,
    };
  };

  /** Only the worker decode uploads the SenseVoice side-channel tags this round. */
  const syncPass = (pass) => ({ ...pass, ...asrTagFields(null), tagSource: 'sync' });

  /**
   * Deliver one utterance's result. The gates, counters and truncation/join flags are exactly the
   * ones the synchronous implementation used; only the moment can be later, because a worker
   * decode resolves after the capture loop already moved on to the next utterance.
   *
   * @returns {boolean} true when a final update was handed to `onUpdate`.
   */
  const finishUtterance = (snapshot, outcome) => {
    if (deliveredUtterances.has(snapshot.id)) return false;
    markDelivered(snapshot.id);
    const { onlineText, audible, loudEnough } = snapshot;
    // Observation only: the decoder text as-is and what a tag strip would leave. `outcome.text`
    // stays the value delivered below, so a tag never changes delivery in this round.
    if (outcome.text.length > 0) {
      const split = splitAsrTags(outcome.text);
      observe('hearing.asr.raw', { id: snapshot.id, raw: outcome.text, chars: outcome.text.length });
      observe('hearing.asr.cleaned', {
        id: snapshot.id, cleaned: split.cleaned, tags: split.tags, stripped: split.stripped,
        lang: outcome.lang ?? null, langClean: outcome.langClean ?? null,
        emotion: outcome.emotion ?? null, emotionClean: outcome.emotionClean ?? null,
        event: outcome.event ?? null, eventClean: outcome.eventClean ?? null,
        refined: outcome.refined === true, tagSource: outcome.tagSource ?? 'none',
      });
    }
    // Gate 3: punctuation-only output is noise, not an utterance.
    const meaningful = outcome.text.replace(/[\s.,!?;:'"…—、。，！？；：（）()\-]/gu, '');
    // The verdict is final here. The shadow row is written *after* it and is never read back by it.
    const delivered = audible && loudEnough && meaningful.length > 0;
    noteNoiseShadow(snapshot, outcome, delivered);
    // The text decides a short utterance, not its duration: "好" at 300 ms is speech, an equally
    // loud click at 300 ms carries no text. `audible` keeps the minimum-valid-audio floor (a click
    // below it is never delivered, even if a decoder invented a character for it).
    if (delivered) {
      finals += 1;
      // Diagnostics only (nothing reads these counters back): a delivered answer of at most three
      // characters, a boundary/tail degradation, and speech-end → delivery latency. Without VAD the
      // endpoint stamp is the only speech-end time; with it the measured trailing silence is removed.
      const deliveredAt = Date.now();
      if ([...outcome.text.trim()].length <= 3) shortAnswerCount += 1;
      if (outcome.joinFallback === true || snapshot.truncated === true) dropAtBoundaryCount += 1;
      const trailingSilenceMs = Number.isFinite(snapshot.vadTrailingSilenceMs)
        ? snapshot.vadTrailingSilenceMs
        : 0;
      deliverLatencySamples.push(Math.max(0, deliveredAt - (snapshot.endpointAt - trailingSilenceMs)));
      if (deliverLatencySamples.length > DELIVER_LATENCY_MAX_SAMPLES) deliverLatencySamples.shift();
      const update = {
        final: outcome.text,
        refined: outcome.refined === true,
        durationMs: snapshot.durationMs,
        bufferedSamples: snapshot.bufferedSamples,
        endpointAt: snapshot.endpointAt,
        // SenseVoice side-channel tag and the input it came from: observation only, the host may
        // use a `Laughter` tag as a timed nonverbal cue; none of it changes the delivered text.
        event: outcome.event ?? null,
        eventClean: outcome.eventClean ?? null,
        utteranceId: snapshot.id,
        source: inputSource,
      };
      // The join detail describes the joined text, so it only applies when that text is delivered.
      if (outcome.joinFallback === true && outcome.refined === true) update.joinFallback = true;
      if (snapshot.truncated) {
        update.maxUtteranceSec = snapshot.maxUtteranceSec;
        // The streaming pass decodes every sample, so a nonempty online text already covers the
        // dropped tail: only the accurate pass was limited. Say so without a truncation note.
        const offlineLimited = outcome.refined === false && onlineText.length > 0;
        if (offlineLimited) {
          update.truncated = false;
          update.offlineLimited = true;
          update.note = offlineLimitedNote(update.maxUtteranceSec);
        } else {
          update.truncated = true;
          update.truncations = snapshot.truncations;
        }
      }
      observe('hearing.delivery', {
        id: snapshot.id,
        text: outcome.text,
        durationMs: snapshot.durationMs,
        rmsDb: snapshot.rmsDb,
        bargein: voiceSounding(),
      });
      // The host may refuse an utterance it was handed (a playback echo, a filler, a duplicate).
      // Its verdict now also gates the dialogue buffer; without one, the condition that delivered
      // this text above is the gate. Delivery itself is unchanged either way.
      const hostVerdict = hostDialogueVerdict(onUpdate?.(update));
      if (hostVerdict === null || hostVerdict.accepted) {
        // Capture side only: the text that was just delivered joins the continuous dialogue buffer,
        // stamped with the moment the audio ended and carrying the capture it came from. Delivery
        // above is final and is never changed here.
        dialogue.push({
          text: update.final,
          at: snapshot.endpointAt,
          utteranceId: String(snapshot.id),
          source: dialogue.source,
        });
      } else {
        observe('hearing.dialogue.gated', {
          reason: hostVerdict.reason,
          utteranceId: String(snapshot.id),
          source: dialogue.source,
        });
      }
      // A merged group keeps each fragment's own PCM, so every fragment is scored on its own audio.
      const shadowTargets = Array.isArray(snapshot.groupSegments) ? snapshot.groupSegments : null;
      if (shadowTargets === null) maybeSpeakerShadow(snapshot);
      else for (const entry of shadowTargets) maybeSpeakerShadow(entry.snapshot);
      return true;
    }
    if (!audible || !loudEnough) {
      dropped += 1;
    } else {
      hallucination += 1;
    }
    // A lost *candidate* is reported with its duration, so a dropped short word is diagnosable;
    // pure room tone (silent, no text at all) only bumps the counter, or an idle microphone would
    // write a row every few seconds.
    if (loudEnough || meaningful.length > 0 || onlineText.length > 0) {
      try {
        onEvent?.('hearing.filtered', {
          reason: audible ? 'no-text' : 'too-short',
          ms: snapshot.durationMs,
        });
      } catch {
        /* an event sink must never break capture */
      }
    }
    return false;
  };

  /**
   * Strict utterance-order delivery. A worker result, a timeout fallback and an overflow fallback
   * all settle at their own moment, so none of them may reach `onUpdate` before every earlier
   * utterance settled: a later transcript jumping over a pending one reads as words spoken out of
   * order. Each utterance owns one slot; `skipDelivery` settles a slot that will never produce a
   * result, and the queue only ever advances past a slot that is settled.
   */
  let nextUtteranceSeq = 1;
  /** seq -> { snapshot, outcome } for a delivery, or null for a skipped slot. */
  const pendingDeliveries = new Map();
  let deliveriesClosed = false;

  const emitDeliveryOrder = (seq, delivered, skipped) => {
    // The synchronous path delivers inline (already in order) and keeps its event log empty.
    if (!asrWorkerRequested) return;
    try {
      onEvent?.('asr.delivery.order', { seq, delivered, skipped });
    } catch {
      /* an event sink must never break capture */
    }
  };

  const flushDeliveries = () => {
    while (!deliveriesClosed && pendingDeliveries.has(nextUtteranceSeq)) {
      const seq = nextUtteranceSeq;
      const delivery = pendingDeliveries.get(seq);
      pendingDeliveries.delete(seq);
      nextUtteranceSeq += 1;
      if (delivery === null) {
        emitDeliveryOrder(seq, false, true);
        continue;
      }
      let delivered = false;
      try {
        delivered = finishUtterance(delivery.snapshot, delivery.outcome);
      } catch (error) {
        // This runs outside the stream callback, so a throwing `onUpdate` would otherwise become
        // an unhandled rejection instead of a capture error.
        lastError = `final delivery failed: ${error?.message ?? error}`;
      }
      // A gated utterance (too short, silent, punctuation only) produced no transcript; its slot
      // is still settled so the next utterance may follow it.
      emitDeliveryOrder(seq, delivered, !delivered);
    }
  };

  /** Settle one utterance's slot with a result, delivering as soon as its turn comes. */
  const enqueueDelivery = (snapshot, outcome) => {
    if (deliveriesClosed) return;
    // Its id already left the slot queue through a group: filter it standalone, never reorder it.
    if (snapshot.id < nextUtteranceSeq) { finishUtterance(snapshot, outcome); return; }
    pendingDeliveries.set(snapshot.id, { snapshot, outcome });
    flushDeliveries();
  };

  /** `seq` produced no result at all: release its slot so later utterances are not blocked. */
  const skipDelivery = (seq) => {
    if (deliveriesClosed || seq < nextUtteranceSeq) return;
    pendingDeliveries.set(seq, null);
    flushDeliveries();
  };

  /** End of session: no pending utterance may be delivered, now or later. */
  const closeDeliveries = () => {
    deliveriesClosed = true;
    pendingDeliveries.clear();
  };

  /**
   * -------------------------------------------------------------------------------------------
   * Utterance groups (batch 1: delivery-side grouping only).
   *
   * A natural-silence endpoint opens a commit buffer of `asrGroupCommitMs`; a *confirmed* audio or
   * streaming continuation inside it is the same turn, so the timer is cancelled and the next
   * fragment joins the open group. Audio is only confirmed by a sustained run (≥120 ms above the
   * existing RMS floor) — a single frame or a short blip never cancels the timer. When a confirmed
   * cancellation is followed by `resumeGraceMs` of no further confirmation, the commit timer is
   * re-armed and the collected text is delivered without waiting for the next endpoint.
   * Internal cuts (`max-duration`, offline segmentation, capture anomalies) never deliver on their
   * own: they keep collecting. The merged text is the fragments' text concatenated in capture order
   * — no punctuation, connector or similarity filter is applied. The buffer is the only wait added
   * here; a decode still in flight absorbs it instead of stacking.
   * -------------------------------------------------------------------------------------------
   */
  let groupSeq = 0;
  let deliverySeq = 0;
  let activeGroup = null;
  let lastGroup = null;

  const groupView = (group) => (group === null ? null : {
    id: group.id,
    state: group.state,
    segmentIds: [...group.segmentIds],
    taskIds: [...group.taskIds],
    deliveryId: group.deliveryId,
    chars: group.chars,
    bufferedMs: group.state === 'buffering'
      ? Math.max(0, Date.now() - group.bufferStartedAt)
      : group.bufferedMs,
  });

  const clearGroupTimer = (group) => {
    if (group.timer !== null) clearTimeout(group.timer);
    group.timer = null;
  };

  /** The bounded recovery timer of a cancelled buffer (at most one per group). */
  const clearResumeTimer = (group) => {
    if (group.resumeTimer !== null) clearTimeout(group.resumeTimer);
    group.resumeTimer = null;
  };

  const cancelGroupBuffer = (group) => {
    clearGroupTimer(group);
    if (group.state === 'buffering') group.state = 'collecting';
    group.commitDue = false;
    group.bufferStartedAt = 0;
    group.voiceRunMs = 0;
  };

  /**
   * A confirmed continuation cancels the commit buffer, and the cancellation itself stays bounded:
   * if no *further* confirmation (a new partial or another sustained voiced run) arrives within
   * `RESUME_GRACE_MS`, the buffer is re-armed so the collected text is delivered on its own.
   */
  const noteGroupContinuation = () => {
    const group = activeGroup;
    if (group === null) return;
    // Inside the grace window a further confirmation validates the earlier cancellation.
    if (group.resumeTimer !== null) {
      clearResumeTimer(group);
      return;
    }
    if (group.state !== 'buffering') return;
    group.continuations += 1;
    cancelGroupBuffer(group);
    group.resumeStartedAt = Date.now();
    group.resumeTimer = setTimeout(() => {
      group.resumeTimer = null;
      if (group !== activeGroup || group.state !== 'collecting') return;
      observe('hearing.group.resume-cancelled', {
        reason: 'unconfirmed',
        afterMs: Math.max(0, Date.now() - group.resumeStartedAt),
      });
      // No next endpoint is needed: the re-armed timer commits the text already collected.
      armGroupBuffer(group);
      observe('hearing.group.rearmed', {
        groupId: group.id, chars: group.chars, reason: 'unconfirmed-resume',
      });
    }, RESUME_GRACE_MS);
    group.resumeTimer.unref?.();
  };

  /**
   * Audio continuation evidence: only a sustained run above the existing RMS floor confirms a
   * resume. A short run reports `reason: 'blip'` and never touches the commit timer.
   * @param {object} group open group the sample belongs to
   * @param {number} voicedMs duration of this frame's voiced part; 0 when it is below the floor
   */
  const noteGroupAudio = (group, voicedMs) => {
    if (group === null) return;
    if (voicedMs <= 0) {
      // The run just ended. A sub-threshold run was a blip, not a continuation.
      if (group.voiceRunMs > 0 && group.voiceRunMs < GROUP_RESUME_MIN_VOICE_MS
        && group.state === 'buffering') {
        observe('hearing.group.resume-cancelled', {
          reason: 'blip',
          afterMs: Math.max(0, Date.now() - group.bufferStartedAt),
        });
      }
      group.voiceRunMs = 0;
      return;
    }
    group.voiceRunMs += voicedMs;
    if (group.voiceRunMs < GROUP_RESUME_MIN_VOICE_MS) return;
    group.voiceRunMs = 0;
    noteGroupContinuation();
  };

  const armGroupBuffer = (group) => {
    clearGroupTimer(group);
    clearResumeTimer(group);
    group.voiceRunMs = 0;
    group.state = 'buffering';
    group.commitDue = false;
    group.bufferStartedAt = Date.now();
    group.timer = setTimeout(() => {
      group.timer = null;
      group.commitDue = true;
      maybeCommitGroup(group);
    }, GROUP_COMMIT_MS);
    group.timer.unref?.();
  };

  /** One fragment joined the open group (created on demand). Returns its entry, or null if ignored. */
  const beginGroupSegment = (snapshot) => {
    snapshot.endReason = segmentEndReasonOf(snapshot);
    // Grouping belongs to the worker delivery path, like every `hearing.*.shadow` observation; the
    // synchronous fallback keeps its historical inline delivery and its empty event log.
    if (!asrWorkerRequested) return null;
    // `asrGroupCommitMs: 0` opts out of grouping entirely (per-segment delivery), which the
    // worker-order suites and any caller needing the old path rely on.
    if (GROUP_COMMIT_MS === 0) return null;
    const candidate = snapshot.audible === true && snapshot.loudEnough === true;
    if (activeGroup === null && !candidate) return null;
    if (activeGroup === null) {
      activeGroup = {
        id: `ug-${groupSeq += 1}`,
        segmentIds: [],
        taskIds: [],
        deliveryId: null,
        segments: [],
        chars: 0,
        state: 'collecting',
        commitDue: false,
        bufferStartedAt: 0,
        bufferedMs: 0,
        continuations: 0,
        /** Consecutive ms of audio above the existing floor, for the resume confirmation. */
        voiceRunMs: 0,
        /** Grace timer of a cancelled buffer; bounded recovery, never the delivery itself. */
        resumeTimer: null,
        resumeStartedAt: 0,
        timer: null,
      };
      lastGroup = activeGroup;
    }
    const group = activeGroup;
    // A second endpoint inside the buffer is the continuation the buffer was waiting for.
    if (group.state === 'buffering') cancelGroupBuffer(group);
    // The fragment itself is the continuation the grace window was waiting for.
    clearResumeTimer(group);
    group.voiceRunMs = 0;
    const entry = { group, snapshot, outcome: null, settled: false };
    // A group owns its delivery, so these ids never enter the per-utterance slot queue.
    while (nextUtteranceSeq <= snapshot.id) nextUtteranceSeq += 1;
    flushDeliveries();
    const formsGroup = group.segments.length === 0;
    group.segments.push(entry);
    group.segmentIds.push(snapshot.segmentId);
    snapshot.groupId = group.id;
    if (formsGroup) {
      observe('hearing.group.formed', {
        groupId: group.id, segmentIds: [snapshot.segmentId], chars: snapshot.onlineText.length,
      });
    }
    if (snapshot.endReason === 'silence') armGroupBuffer(group);
    return entry;
  };

  const settleGroupSegment = (entry, outcome) => {
    const group = entry?.group;
    if (entry === null || entry.settled || group === null) return;
    if (group.state !== 'collecting' && group.state !== 'buffering') return;
    entry.settled = true;
    entry.outcome = outcome;
    if (outcome?.decodeTaskId !== null && outcome?.decodeTaskId !== undefined) {
      group.taskIds.push(outcome.decodeTaskId);
    }
    group.chars = group.segments.reduce((sum, item) => sum
      + (typeof item.outcome?.text === 'string' ? item.outcome.text.length : 0), 0);
    maybeCommitGroup(group);
  };

  /** The merge keeps capture order; nothing is deleted or reordered. */
  const mergeGroup = (group) => {
    const entries = group.segments;
    if (entries.length === 1) {
      // A one-fragment group is delivered byte-for-byte like before; only the group tag is added.
      return { snapshot: { ...entries[0].snapshot, groupSegments: entries }, outcome: entries[0].outcome };
    }
    const snapshots = entries.map((entry) => entry.snapshot);
    const outcomes = entries.map((entry) => entry.outcome);
    const base = snapshots[0];
    const last = snapshots[snapshots.length - 1];
    const lastText = (key) => {
      for (let index = outcomes.length - 1; index >= 0; index -= 1) {
        if (outcomes[index]?.[key] !== null && outcomes[index]?.[key] !== undefined) return outcomes[index][key];
      }
      return null;
    };
    const maxOf = (key) => Math.max(...snapshots.map((item) => (Number.isFinite(item[key]) ? item[key] : -100)));
    const sumOf = (key) => {
      const values = snapshots.map((item) => item[key]).filter((value) => Number.isFinite(value));
      return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0);
    };
    const durationMs = snapshots.reduce((sum, item) => sum + item.durationMs, 0);
    const text = outcomes.map((item) => item.text).join('');
    const voicedMs = sumOf('voicedMs');
    const vadSpeechMs = sumOf('vadSpeechMs');
    return {
      snapshot: {
        ...base,
        endpointAt: last.endpointAt,
        onlineText: snapshots.map((item) => item.onlineText).join(''),
        audible: snapshots.some((item) => item.audible === true),
        loudEnough: snapshots.some((item) => item.loudEnough === true),
        rmsDb: maxOf('rmsDb'),
        peakDb: maxOf('peakDb'),
        truncated: snapshots.some((item) => item.truncated === true),
        truncations: last.truncations,
        durationMs,
        bufferedSamples: snapshots.reduce((sum, item) => sum + item.bufferedSamples, 0),
        maxUtteranceSec: last.maxUtteranceSec,
        maxDurationMs: last.maxDurationMs,
        endpointReason: last.endpointReason,
        voicedMs,
        voicedRatio: voicedMs === null || durationMs === 0 ? null : voicedMs / durationMs,
        vadTrailingSilenceMs: last.vadTrailingSilenceMs,
        vadSpeechMs,
        vadSpeechRatio: vadSpeechMs === null || durationMs === 0 ? null : vadSpeechMs / durationMs,
        vadRatioSource: last.vadRatioSource ?? null,
        speakerSamples: null,
        groupSegments: entries,
      },
      outcome: {
        text,
        refined: outcomes.every((item) => item.refined === true),
        joinFallback: outcomes.some((item) => item.joinFallback === true),
        lang: lastText('lang'),
        langClean: lastText('langClean'),
        emotion: lastText('emotion'),
        emotionClean: lastText('emotionClean'),
        event: lastText('event'),
        eventClean: lastText('eventClean'),
        tagSource: outcomes[outcomes.length - 1].tagSource ?? 'none',
        decodeTaskId: outcomes.find((item) => item.decodeTaskId !== null && item.decodeTaskId !== undefined)?.decodeTaskId ?? null,
        segmentIds: outcomes.flatMap((item) => (Array.isArray(item.segmentIds) ? item.segmentIds : [])),
        offlineText: outcomes.map((item) => item.offlineText ?? '').join(''),
      },
    };
  };

  const commitGroup = (group) => {
    if (group !== activeGroup || group.state === 'committed' || group.state === 'dropped') return;
    if (!group.segments.every((entry) => entry.settled)) return;
    clearGroupTimer(group);
    clearResumeTimer(group);
    activeGroup = null;
    group.state = 'committed';
    group.deliveryId = deliverySeq += 1;
    group.bufferedMs = group.bufferStartedAt === 0 ? 0 : Math.max(0, Date.now() - group.bufferStartedAt);
    const merged = mergeGroup(group);
    group.chars = merged.outcome.text.length;
    observe('hearing.group.committed', {
      groupId: group.id, chars: group.chars, bufferedMs: group.bufferedMs, reason: 'silence',
    });
    let delivered = false;
    try {
      delivered = finishUtterance(merged.snapshot, merged.outcome);
    } catch (error) {
      lastError = `final delivery failed: ${error?.message ?? error}`;
    }
    for (const entry of group.segments) markDelivered(entry.snapshot.id);
    emitDeliveryOrder(group.deliveryId, delivered, !delivered);
  };

  const maybeCommitGroup = (group) => {
    if (group !== activeGroup || group.state !== 'buffering' || group.commitDue !== true) return;
    if (!group.segments.every((entry) => entry.settled)) return;
    commitGroup(group);
  };

  /** A fragment result: grouped fragments wait for the group; noise-only ones keep the old filter. */
  const routeOutcome = (snapshot, outcome, segment) => {
    if (segment !== null) { settleGroupSegment(segment, outcome); return; }
    if (asrWorkerRequested) enqueueDelivery(snapshot, outcome);
    else finishUtterance(snapshot, outcome);
  };

  /** Cancellation/stop/session-switch: the buffered text is dropped, never delivered late. */
  const dropGroup = (reason) => {
    const group = activeGroup;
    if (group === null) return false;
    activeGroup = null;
    group.state = 'dropped';
    clearGroupTimer(group);
    clearResumeTimer(group);
    group.commitDue = false;
    observe('hearing.group.dropped', {
      groupId: group.id,
      reason: reason === 'cancelled' || reason === 'session-switch' ? reason : 'stopped',
    });
    return true;
  };

  child.stderr.on('data', (chunk) => {
    lastError = `${chunk}`.trim().slice(-400);
  });

  const processChunk = (chunk) => {
    frames += 1;
    // Lazy idle boundary: the frame that already ticks is the clock, so no timer is introduced.
    dialogue.idleCheck();
    sampleDiagnostics();
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    const usable = pending.length - (pending.length % 2);
    if (usable === 0) return;
    const samples = new Float32Array(usable / 2);
    for (let index = 0; index < samples.length; index += 1) {
      samples[index] = pending.readInt16LE(index * 2) / 32768;
    }
    pending = pending.subarray(usable);

    // Cheap level meter: tells the user whether the device is actually picking anything up.
    let sumSquares = 0;
    let chunkPeak = 0;
    for (const sample of samples) {
      sumSquares += sample * sample;
      const magnitude = Math.abs(sample);
      if (magnitude > chunkPeak) chunkPeak = magnitude;
    }
    // Continuation signal #1, audio: judged frame by frame (20 ms at 16 kHz), not per capture
    // chunk, so a short blip inside one large chunk cannot pose as sustained speech. Only a run
    // that stays above the existing floor for `GROUP_RESUME_MIN_VOICE_MS` confirms a resume.
    if (activeGroup !== null && (activeGroup.state === 'buffering' || activeGroup.resumeTimer !== null)) {
      for (let offset = 0; offset < samples.length; offset += GROUP_FRAME_SAMPLES) {
        const frame = samples.subarray(offset, Math.min(samples.length, offset + GROUP_FRAME_SAMPLES));
        let frameSquares = 0;
        for (const sample of frame) frameSquares += sample * sample;
        const voiced = frameSquares > 0
          && 20 * Math.log10(Math.sqrt(frameSquares / frame.length)) >= MIN_RMS_DB;
        noteGroupAudio(activeGroup, voiced ? (frame.length * 1000) / 16000 : 0);
      }
    }
    if (samples.length > 0) {
      rms = rms === 0 ? Math.sqrt(sumSquares / samples.length) : rms * 0.9 + Math.sqrt(sumSquares / samples.length) * 0.1;
    }
    if (chunkPeak > peak) peak = chunkPeak;
    if (chunkPeak > utterancePeak) utterancePeak = chunkPeak;

    // Keep the raw samples of this utterance for the accurate pass, up to the hard cap.
    utteranceSeenSamples += samples.length;
    const room = MAX_UTTERANCE - utteranceSamples;
    if (room > 0) {
      const kept = samples.length <= room ? samples : samples.slice(0, room);
      utterance.push(kept);
      utteranceSamples += kept.length;
    }
    if (!truncated && utteranceSeenSamples > MAX_UTTERANCE) {
      // Explicit truncation policy: the tail beyond the cap is not decoded, and the final
      // update carries `truncated: true` so callers can see the answer is partial.
      truncated = true;
      truncations += 1;
    }

    stream.acceptWaveform({ sampleRate: 16000, samples });
    while (recognizer.isReady(stream)) recognizer.decode(stream);

    const result = recognizer.getResult(stream);
    const clean = sanitize(result.text);
    if (clean !== partial) {
      partial = clean;
      onUpdate?.({ partial });
      // Continuation signal #2, streaming: new words after the endpoint (not the offline final).
      if (clean.length > 0) noteGroupContinuation();
    }

    // Round-1 VAD shadow: the same frame goes to the detector after the streaming pass consumed
    // it, interleaved in this callback (no queue, no copy, no thread). The recognition input and
    // its order are unchanged; a runtime failure disables the shadow once and touches nothing else.
    if (vadShadow !== null) {
      try {
        vadShadow.feed(samples);
      } catch (error) {
        vadShadow = null;
        reportVadUnavailable(`VAD 运行失败: ${error?.message ?? error}`);
      }
    }
    if (recognizer.isEndpoint(stream)) {
      // The streaming pass heard the whole utterance; keep it separately because a truncated
      // offline pass must never replace a more complete online text.
      // Stamp the silence endpoint before the accurate pass so callers can measure ASR latency
      // (endpoint -> final text) without re-deriving it from wall-clock guesses.
      const endpointAt = captureNow();
      const onlineText = clean.trim();

      // Duration is a candidate signal, never a verdict: under the floor a click or a breath
      // cannot be a word; above it, the recognized text decides whether this was real speech.
      const durationMs = Math.round(utteranceSeenSamples / 16);
      const audible = durationMs >= MIN_AUDIO_MS;

      // Gate 2: silence decodes into junk ("I.", "."), so require a real level. It is measured for
      // every utterance: computing it only for "long" audio made every short clip "not loud" by
      // construction, which is how a 300 ms "好" used to be dropped twice over.
      let utteranceRms = 0;
      if (utteranceSamples > 0) {
        let sumSquares = 0;
        for (const part of utterance) {
          for (const sample of part) sumSquares += sample * sample;
        }
        utteranceRms = Math.sqrt(sumSquares / utteranceSamples);
      }
      const loudEnough = utteranceRms > 0 && 20 * Math.log10(utteranceRms) >= MIN_RMS_DB;
      // Energy VAD over the buffered audio, for the shadow row only: null when there is no audio to
      // measure, and an energy measurement — not a voice/speech classifier.
      const voiced = voicedMetrics(utterance, { sampleRate: 16000 });

      /** Everything delivery needs, frozen before the streaming state is recycled. */
      utteranceSeq += 1;
      const snapshot = {
        id: utteranceSeq,
        /** Stable id of this ASR fragment, carried by the group and endpoint observations. */
        segmentId: `seg-${utteranceSeq}`,
        endpointAt,
        onlineText,
        audible,
        loudEnough,
        /** Measured level of this utterance, for the delivery observation only (never a gate). */
        rmsDb: utteranceRms > 0 ? Math.round(20 * Math.log10(utteranceRms)) : -100,
        /** This utterance's own peak (the session-wide `peak` is a different meter). */
        peakDb: utterancePeak > 0 ? Math.round(20 * Math.log10(utterancePeak)) : -100,
        truncated,
        truncations,
        // 16 kHz mono → 16 samples per millisecond; the ledger uses this as ASR audio time.
        // The duration is the complete utterance, not the buffered (possibly capped) prefix.
        durationMs,
        bufferedSamples: utteranceSamples,
        maxUtteranceSec: MAX_UTTERANCE_SECONDS,
        maxDurationMs: MAX_ENDPOINT_MS,
        endpointReason: endpointReasonOf(durationMs, {
          maxEndpointMs: MAX_ENDPOINT_MS,
          hasOnlineText: onlineText.length > 0,
        }),
        /** The accurate pass had to split this fragment internally (long audio), not a user end. */
        offlineSplit: utteranceSeenSamples > SEGMENT_SAMPLES,
        voicedMs: voiced === null ? null : voiced.voicedMs,
        voicedRatio: voiced === null ? null : voiced.voicedRatio,
        /** This utterance's own 16 kHz PCM, for the speaker shadow only (null when it is off). */
        speakerSamples: null,
      };

      // VAD shadow: measured over the same window, after the snapshot is frozen and before the
      // accurate pass. Observation only; it still advances the detector when its row is throttled.
      // `vadTrailingSilenceMs` keeps the speech-end stamp for the diagnostics latency sample.
      const vadMetrics = noteVadShadow(snapshot, voiced);
      snapshot.vadTrailingSilenceMs = vadMetrics === null ? null : vadMetrics.trailingSilenceMs;
      // Real VAD, carried under its own name and source: `null` (never 0) when it was not measured,
      // so a reader can tell "no speech" from "not measured". The energy meter stays separate.
      snapshot.vadSpeechMs = vadMetrics === null ? null : vadMetrics.speechMs;
      snapshot.vadSpeechRatio = vadMetrics === null ? null : vadMetrics.speechRatio;
      snapshot.vadRatioSource = vadMetrics === null ? null : 'silero';

      // Grouping starts before delivery: a natural end opens the commit buffer, an internal cut
      // just keeps collecting. `segment` is null only for a noise-only fragment with no open group.
      const segment = beginGroupSegment(snapshot);
      observe('hearing.endpoint.detail', {
        utteranceId: snapshot.id,
        endpointReason: snapshot.endReason,
        audioMs: snapshot.durationMs,
        // The VAD shadow is the one measured trailing silence. Without it the value is null — the
        // energy meter cannot derive it, and an unmeasured silence must never be reported as 0.
        trailingSilenceMs: Number.isFinite(snapshot.vadTrailingSilenceMs) ? snapshot.vadTrailingSilenceMs : null,
        segmentId: snapshot.segmentId,
        groupId: segment === null ? null : segment.group.id,
        // The accurate pass had to split this fragment internally (long audio); an orthogonal fact
        // to why the streaming endpoint fired, so a 20 s cut can be both max-duration and split.
        offlineSplit: snapshot.offlineSplit === true,
      });

      // A short but audible clip still gets the accurate pass: SenseVoice is exactly what recovers
      // a 300 ms "好" the streaming transducer may render loosely. Duration no longer gates it.
      const needsAccuratePass = audible && loudEnough && (asrWorkerRequested || finalRecognizer !== null);
      let merged = null;
      if (needsAccuratePass) {
        merged = new Float32Array(utteranceSamples);
        let offset = 0;
        for (const part of utterance) {
          merged.set(part, offset);
          offset += part.length;
        }
        if (speakerShadowOn) snapshot.speakerSamples = merged;
      }

      // Release the streaming state before the accurate pass: with the worker it runs off-thread,
      // so the next utterance has to be captured immediately (the audio was copied above).
      utterance = [];
      utteranceSamples = 0;
      utteranceSeenSamples = 0;
      utterancePeak = 0;
      truncated = false;
      recognizer.reset(stream);
      partial = '';

      if (merged === null) {
        const outcome = {
          text: onlineText, refined: false, ...asrTagFields(null), tagSource: 'none',
        };
        // Grouped fragments wait for the commit; noise-only ones keep the old filter path.
        routeOutcome(snapshot, outcome, segment);
        return;
      }

      if (!asrWorkerRequested) {
        // Synchronous path: the accurate pass is injected (tests) or was built eagerly above.
        let pass = null;
        try {
          // Decode overlapping pieces and join them by the referee anchor: a long utterance keeps
          // its tail instead of being cut at the first cap, a short one is still a single decode,
          // and no word is ever split at a cut point.
          pass = syncPass(decodeSegmented(
            finalRecognizer, merged, SEGMENT_SAMPLES, SEGMENT_OVERLAP_SAMPLES, 16000, { utteranceId: snapshot.id },
          ));
        } catch (error) {
          lastError = `final pass failed: ${error?.message ?? error}`;
        }
        routeOutcome(snapshot, adoptOffline(snapshot, pass), segment);
        return;
      }

      // Worker path: this handler returns without waiting for the decode, so partials, barge-in and
      // the next utterance keep flowing. The transcript is routed when the thread answers; a stop
      // or a stale result is dropped instead of reviving the utterance.
      const client = ensureWorker();
      void (async () => {
        let pass = null;
        try {
          pass = await client.decode(merged, {
            sampleRate: 16000,
            language: asrWorkerLanguage,
            // Stamped on the request so the thread's per-piece ids and the shadow row agree.
            utteranceId: snapshot.id,
          });
        } catch (error) {
          // Stopped: the session already closed the queue. A request abandoned for any other
          // reason can no longer produce a result, so release its slot without blocking later ones.
          if (error?.name === ASR_WORKER_STOPPED) {
            if (!stopped) {
              // The group still owns the fragment: settle it with the streaming text so the
              // buffer is not blocked forever; a noise-only fragment keeps the old slot release.
              if (segment !== null) settleGroupSegment(segment, adoptOffline(snapshot, null));
              else skipDelivery(snapshot.id);
            }
            return;
          }
          // Full backlog: the accurate pass is dropped for this utterance and the streaming text
          // stays authoritative. Decoding it here would serialize a sync storm on the capture thread.
          if (error?.name === ASR_WORKER_OVERFLOW) {
            lastError = `asr queue overflow: ${error?.message ?? error}`;
          } else {
            lastError = `asr worker decode failed: ${error?.message ?? error}`;
            // Degraded, timed out (exactly once) or a single failed decode: decode on this thread.
            const fallback = syncFinalRecognizer();
            if (fallback !== null) {
              try {
                pass = syncPass(decodeSegmented(
                  fallback, merged, SEGMENT_SAMPLES, SEGMENT_OVERLAP_SAMPLES, 16000, { utteranceId: snapshot.id },
                ));
              } catch (decodeError) {
                lastError = `final pass failed: ${decodeError?.message ?? decodeError}`;
              }
            }
          }
        }
        if (stopped) return;
        // Grouped fragments wait for the commit buffer; noise-only ones keep the old slot queue.
        routeOutcome(snapshot, adoptOffline(snapshot, pass), segment);
      })();
    }
  };

  child.stdout.on('data', processChunk);

  return {
    device,
    /**
     * Force the current utterance to finalize: feed just enough silence to satisfy the
     * endpoint rule, so a caller can hand over the held utterance without waiting.
     */
    flush() {
      try {
        processChunk(Buffer.alloc(16000 * 2 * 1.6));
      } catch {
        /* nothing to flush */
      }
    },
    stats: () => ({
      frames,
      finals,
      dropped,
      hallucination,
      truncations,
      bufferedSamples: utteranceSamples,
      device,
      lastError,
      rms,
      peak,
      rmsDb: rms > 0 ? Math.round(20 * Math.log10(rms)) : -100,
      peakDb: peak > 0 ? Math.round(20 * Math.log10(peak)) : -100,
      asrWorker: workerClient === null ? null : workerClient.status(),
      delivery: { next: nextUtteranceSeq, pending: pendingDeliveries.size, closed: deliveriesClosed },
      /** The open group (or the last one committed/dropped): ids and buffered text size. */
      group: groupView(activeGroup ?? lastGroup),
      // Queryable round-1 diagnostics; a lazy minute sample may be taken here as well.
      diagnostics: (() => {
        sampleDiagnostics();
        return diagnosticsSummary();
      })(),
    }),
    /**
     * Read-only view of the continuous dialogue buffer: what the upper layer would render, whether
     * a rolling summary is due, and the coordinates a summary request must carry back. This round
     * the host does not inject it; the text is still delivered exactly as before.
     */
    dialogueSnapshot: () => dialogue.snapshot(),
    stop(reason = 'stopped') {
      // Terminal for this session: an in-flight worker decode must not deliver a transcript after
      // the user stopped listening, and the thread is terminated right away.
      stopped = true;
      // Explicit cancel / mute / session switch drops the buffered group; no late delivery follows.
      dropGroup(reason);
      // The capture is over: close the last dialogue segment, so no later session continues it.
      dialogue.close('stop');
      // The VAD download is bound to this session's lifetime: abort its network request/retry loop.
      abortVadDownload('stopped');
      abortSpeakerDownload('stopped');
      closeSpeakerLibrary();
      closeDeliveries();
      workerClient?.stop();
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    },
    done,
  };
}

/**
 * Bind a hearing session to the host's `hearing` slot. The session always settles: a normal
 * exit resolves `{ code, signal, error }`, a spawn failure rejects, and both become one exit
 * report. `isCurrent()` keeps a late exit from a session that was already replaced (or stopped
 * on purpose and cleared first) from clearing its successor and from double-reporting.
 *
 * @param {{done: Promise<{code: number|null, signal: string|null, error: string|null}>}} session
 * @param {{isCurrent?: () => boolean, onExit?: (exit: object) => void}} [handlers]
 * @returns {Promise<{code: *, signal: *, error: *}|null>} exit info, or null when the slot moved on
 */
export function watchHearingExit(session, { isCurrent = () => true, onExit } = {}) {
  const report = (exit) => {
    if (!isCurrent()) return null;
    onExit?.(exit);
    return exit;
  };
  return session.done.then(
    (exit) => report({ code: exit?.code ?? null, signal: exit?.signal ?? null, error: exit?.error ?? null }),
    (error) => report({ code: null, signal: null, error: error?.message ?? String(error) }),
  );
}
