/**
 * Live2D host runtime: connection epochs, verified channels, transport and lifecycle ownership.
 *
 * motion-controller.js owns the continuous behavior state machine; style.js owns persona style;
 * dynamics.js and mixer.js implement frame math and channel arbitration. This facade re-exports
 * the original public API and binds those components to one VTS transport.
 */

// ---------------------------------------------------------------------------------------------
// Semantic channel space
// ---------------------------------------------------------------------------------------------
import {
  MOTION_EVENTS,
  NEUTRAL_INTENT,
  degradeIntent as degradeMotionIntent,
  intentForEvent,
  isMotionProfile,
  motionProfileFor,
  normalizeIntentTable,
} from './motionEvents.js';

import {
  CHANNELS,
  IDLE_PARAM_CHANNELS,
  IDLE_WRITE_CHANNELS,
  INTENT_WRITE_CHANNELS,
  isBidirectional,
  TIMING,
  finite,
  clamp01,
} from './motion-primitives.js';
export {
  CHANNELS,
  IDLE_PARAM_CHANNELS,
  IDLE_WRITE_CHANNELS,
  INTENT_WRITE_CHANNELS,
  isBidirectional,
  BLINK,
  LIMITS,
  TIMING,
  BREATH,
  ARBITRATION,
  clamp01,
  clampSigned,
  createSeededRandom,
  smoothstep,
} from './motion-primitives.js';
import { AVATAR_STYLE_CHANNEL_RANGES, styleChannelAmplitude } from './style.js';
export {
  AVATAR_STYLE_RANGES,
  AVATAR_STYLE_CHANNEL_RANGES,
  AVATAR_GAZE_HABITS,
  AVATAR_STYLE_FIELDS,
  DEFAULT_AVATAR_STYLE,
  AVATAR_STYLE_DIMENSIONS,
  avatarStyleSeed,
  deriveAvatarStyleDimensions,
  coerceAvatarStyle,
  normalizeAvatarStyle,
  parseAvatarStyle,
  personaStyleVersion,
  buildAvatarStylePrompt,
  createAvatarStyleCache,
} from './style.js';
import {
  IDLE_SPEECH_SCALE,
  INTENT_KINDS,
  INTENT_CHANNEL_TARGETS,
  intentChannelsFor,
  IDLE_ACTION_CHANNELS,
  IDLE_ACTION_INTENTS,
  ALIVE_FALLBACK_GAIN,
} from './motion-config.js';
export {
  MOTION_STATUSES,
  IDLE_SPEECH_SCALE,
  SPEECH_HEAD_DAMP,
  INTENT_KINDS,
  INTENT_CHANNEL_TARGETS,
  intentChannelsFor,
  INTENT_VARIANTS,
  STYLE_DIMENSION_APPLICATION,
  INTENT_IDLE_RATIO,
  IDLE_ACTION_CHANNELS,
  IDLE_ACTION_INTENTS,
  ALIVE_FALLBACK_GAIN,
  CONFUSED_BROW_CHANNELS,
} from './motion-config.js';
import { toHeadInputValue, toInputValue } from './dynamics.js';
export {
  HEAD_DEGREES_PER_POSE_UNIT,
  createBlinkState,
  stepBlink,
  springParams,
  stepSpringAxis,
  toHeadInputValue,
  toInputValue,
} from './dynamics.js';
export { composeChannels } from './mixer.js';
import { DEFAULT_CONFIG, PRESET_EVENT_FOR_PHASE, createBehaviorRuntime } from './motion-controller.js';
export {
  MOTION_DECISION_HZ,
  POSTURE_HOLD_MIN_MS,
  POSTURE_HOLD_MAX_MS,
  RELAXATION,
  MOTION_LIMITS,
  POSTURE_TRANSITION,
  LIVELY_HOLD_THRESHOLD,
  POSTURE_HOLD_ALLOCATION,
  SHORT_ACTION_TRANSITION,
  SHORT_ACTION_INTENTS,
  OCCASIONAL_ACTION,
  EXPRESSION_MOTION,
  EXPRESSION_RELEASE,
  INTENT_VISIBILITY,
  SPEECH_MICRO_MOTION,
  HOLD_MICRO_DRIFT,
  RELAX_PLAN,
  POSTURE_REACH,
  PRESET_TAKEOVER,
  buildSpeechLevels,
  createBehaviorRuntime,
} from './motion-controller.js';


// ---------------------------------------------------------------------------------------------
// Host facade — the wiring surface index.js will use
// ---------------------------------------------------------------------------------------------
//
// `createBehaviorRuntime` above stays the pure/stateful core: no network, legacy string reasons.
// This facade adds only what host wiring needs and deliberately does not import vts.js:
//
//   const avatar = createAvatarRuntime({ transport, now, log, config });
//   await avatar.connect();
//   const seat = avatar.setMouthOwner('speech');
//   await avatar.speak('你好');                  // text envelope, or { envelope } / { live:true }
//   avatar.tick(now);                            // pose + coalesced transport flush
//   avatar.idle(at);                             // idle-intent frame
//   avatar.releaseOwner('speech');
//   avatar.dispose();                            // idempotent teardown
//
// Every expected failure is returned as `{ok:false, code, message}`; transport errors are
// recorded in `snapshot().lastError` and never thrown at the caller.

/** Stable error codes for the host facade. Inner reasons stay as they were for the 40 core tests. */
export const AVATAR_ERROR_CODES = Object.freeze({
  NOT_CONNECTED: 'NOT_CONNECTED',
  UNMAPPED: 'UNMAPPED',
  OWNERSHIP_CONFLICT: 'OWNERSHIP_CONFLICT',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  DISPOSED: 'DISPOSED',
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  CONNECT_FAILED: 'CONNECT_FAILED',
  DISCONNECT_FAILED: 'DISCONNECT_FAILED',
  WRITE_FAILED: 'WRITE_FAILED',
});

/** Legacy inner-runtime reasons → facade error codes (one place, so callers see one vocabulary). */
const INNER_REASON_CODES = Object.freeze({
  'no-session': AVATAR_ERROR_CODES.TOKEN_EXPIRED,
  'stale-token': AVATAR_ERROR_CODES.TOKEN_EXPIRED,
  'stale-write': AVATAR_ERROR_CODES.TOKEN_EXPIRED,
  'mouth-busy': AVATAR_ERROR_CODES.OWNERSHIP_CONFLICT,
  unmapped: AVATAR_ERROR_CODES.UNMAPPED,
  'write-failed': AVATAR_ERROR_CODES.WRITE_FAILED,
  'non-numeric level': AVATAR_ERROR_CODES.INVALID_ARGUMENT,
});

/** Facade-only defaults; everything else is the core runtime's DEFAULT_CONFIG. */
const DEFAULT_HOST_CONFIG = Object.freeze({
  /** 0 disables the internal compute timer; a host normally drives tick() itself. */
  autoTickMs: 0,
  /** Mouth transport writes are coalesced to this rate (matches vts.js MIN_GAP_MS). */
  flushIntervalMs: TIMING.FLUSH_INTERVAL_MS,
  /** Fallback speech duration per non-space character when the caller passes no durationMs. */
  textCharMs: TIMING.MOUTH_STEP_MS,
  /** Idle parameter frames are capped at this rate (4 Hz) instead of one write per tick. */
  idleWriteHz: 4,
  /**
   * Hard ceiling. The configured idle write rate may be 4–8 Hz; style never changes it, because
   * style only tunes amplitude/rhythm/step. The default stays 4 Hz.
   */
  idleWriteHzMax: 8,
  /** Semantic cap per head axis; on a ±30° input range this is ±5.4° (was ±3°). */
  idleAmplitude: 0.18,
  /** Largest semantic change allowed between two consecutive idle-written frames (anti-jitter). */
  idleMaxStep: 0.03,
  /** Eye-open idle writes are opt-in: off by default so blink/idle cannot fight each other. */
  idleEye: false,
  /**
   * Output interpolation rate for the continuous controller. The controller always *computes* at
   * this rate (default 30 Hz, configurable); the legacy idle transport path keeps its own 4 Hz
   * cadence unless `motionWrites` opts into the single-slot 30 Hz output pump.
   */
  motionOutputHz: 30,
  motionOutputHzMax: 60,
  /** Opt-in: send the interpolated pose through the single-slot/single-flight pump below. */
  motionWrites: false,
  /**
   * After this long an unsettled motion send is reported (`avatar.motion.send.timeout`) but the
   * single-flight gate stays CLOSED: a newer frame must never overtake an older physical send.
   */
  motionSendTimeoutMs: 2000,
  /**
   * Without abort support, how long a timed-out send may still settle before its lane is marked
   * abandoned/skipped (`avatar.motion.send.abandoned`). The gate still stays closed.
   */
  motionSendAbandonMs: 2000,
  /**
   * A transport may cancel asynchronously. Wait at most this long for that confirmation; until it
   * arrives (and unless it resolves true) the single-flight gate stays CLOSED.
   */
  motionCancelWaitMs: 500,
  /** A live mouth sender keeps idle suppressed this long after its last write. */
  idleSpeechHoldMs: 500,
  /**
   * How long one discrete action runs. A new action starts only after the running one ends, so
   * one-shot preset animations can never overlap. Speech never shortens or restarts it.
   */
  actionDurationMs: 1200,
  /**
   * How far BEFORE an action's own trigger a Start event may claim to belong to it. A hotkey can
   * fire a few ms before the scheduler samples the tick; anything earlier is the previous action's
   * animation and must never be adopted just because the names match.
   */
  animationLookbackMs: 150,
  /** How far AFTER an action's trigger a Start may still claim to belong to that same action. */
  animationWindowMs: 1500,
  /**
   * Hard ceiling for one discrete action. A looping idle animation re-fires its Start forever, so
   * an event can never be trusted to end an action: this cap force-ends it
   * (`avatar.action.forced-end {reason:'max-duration'}`).
   */
  maxActionMs: 10_000,
  /**
   * Sentence-head window (P-139 stage 2). An event that arrives this soon after a clip start is
   * that clip's sentence-head intent; anything later waits for the next boundary. 0 means every
   * event waits for the next `speechClip('start')`.
   */
  intentHeadWindowMs: 250,
  /** Fade used by the `settle` intent: it is a normal return, not a resource close. */
  intentSettleFadeMs: 240,
});

const errorText = (error) => String(error?.message ?? error ?? 'unknown error');
const asOwner = (value) => (typeof value === 'string' && value.trim().length > 0 ? value.trim() : null);
/**
 * A real animation duration from VTS is trusted only inside these bounds. The fallback
 * (`actionDurationMs`) is separately bounded by the host config; a missing event keeps it and
 * reports `estimated: true` instead of pretending to know the animation length.
 */
const ANIMATION_DURATION_MIN_MS = 200;
const ANIMATION_DURATION_MAX_MS = 60_000;

/** Read a mouth input name from the several shapes discovery returns ('' = not mapped). */
const asInputName = (raw) => {
  if (typeof raw === 'string') return raw.trim();
  if (raw !== null && typeof raw === 'object') {
    return String(raw.input ?? raw.name ?? raw.inputName ?? '').trim();
  }
  return '';
};

/**
 * Normalise the host's idle parameter map into one row per IDLE_PARAM_CHANNEL. A row with an
 * empty `inputName` is "discovered but not mapped": it is skipped and recorded, never guessed.
 * Accepted value shapes: an input name string, or `{inputName, min, max, defaultValue, gain}`.
 */
function normalizeIdleParams(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {};
  return IDLE_PARAM_CHANNELS.map((channel) => {
    const entry = source[channel];
    return {
      channel,
      inputName: asInputName(entry),
      min: Number.isFinite(entry?.min) ? entry.min : undefined,
      max: Number.isFinite(entry?.max) ? entry.max : undefined,
      defaultValue: Number.isFinite(entry?.defaultValue) ? entry.defaultValue : undefined,
      gain: Number.isFinite(entry?.gain) ? entry.gain : null,
    };
  });
}

/**
 * Create the host-facing avatar runtime.
 *
 * @param {{
 *   transport?: {
 *     connect?: () => void|Promise<void>,
 *     disconnect?: () => void|Promise<void>,
 *     write?: (frame: {input: string, value: number}) => unknown,
 *     writeMouth?: (frame: {input: string, value: number}) => unknown,
 *     inject?: (frame: {input: string, value: number}) => unknown,
 *     mouthInput?: string|{inputName?: string}|null,
 *     getMouthInput?: () => string|{inputName?: string}|null,
 *     getAnimation?: () => {name: string, durationMs?: number, startedAt?: number, isIdle?: boolean}|null,
 *     on?: (event: string, handler: Function) => (void|Function),
 *     off?: (event: string, handler: Function) => void,
 *   }|null,
 *   now?: () => number,
 *   log?: ((message: string, data?: object) => void)|{debug?: Function, info?: Function,
 *           warn?: Function, error?: Function, log?: Function}|null,
 *   config?: object,
 * }} [options]
 * @returns {object} the public facade (see the returned object at the bottom of the factory)
 */
export function createAvatarRuntime({ transport = null, now = null, log = null, config = {} } = {}) {
  const userConfig = config ?? {};
  /**
   * Preset execution is opt-in at the facade: the legacy four-intent path stays byte-identical
   * unless the host asks for the preset library. `inner` receives the same flag through the
   * `...userConfig` spread below, so there is still exactly one decision point.
   */
  let presetExecution = userConfig.presetExecution === true;
  /**
   * Target/direction proofs are separate from the gaze MAPPING: a verified cursor target proves a
   * real target exists even when the model has no gaze input. Preset channels still filter, so a
   * gaze-target recipe cannot run without verified gaze inputs.
   */
  let attentionTargetVerified = false;
  let attentionDirectionVerified = false;
  const host = {
    autoTickMs: Number.isFinite(userConfig.autoTickMs) ? userConfig.autoTickMs : DEFAULT_HOST_CONFIG.autoTickMs,
    flushIntervalMs: Number.isFinite(userConfig.flushIntervalMs) && userConfig.flushIntervalMs > 0
      ? userConfig.flushIntervalMs
      : DEFAULT_HOST_CONFIG.flushIntervalMs,
    textCharMs: Number.isFinite(userConfig.textCharMs) && userConfig.textCharMs > 0
      ? userConfig.textCharMs
      : DEFAULT_HOST_CONFIG.textCharMs,
    /** Gain on the idle curve before it becomes an input value (amplitude knob for the host). */
    idleParamGain: Number.isFinite(userConfig.idleParamGain) ? userConfig.idleParamGain : 1,
    /** Idle write tuning: rate cap, amplitude cap, per-frame step cap, optional eye channel. */
    idleWriteHz: Math.min(
      DEFAULT_HOST_CONFIG.idleWriteHzMax,
      Number.isFinite(userConfig.idleWriteHz) && userConfig.idleWriteHz > 0
        ? userConfig.idleWriteHz : DEFAULT_HOST_CONFIG.idleWriteHz,
    ),
    idleAmplitude: Number.isFinite(userConfig.idleAmplitude) && userConfig.idleAmplitude >= 0
      ? userConfig.idleAmplitude : DEFAULT_HOST_CONFIG.idleAmplitude,
    idleMaxStep: Number.isFinite(userConfig.idleMaxStep) && userConfig.idleMaxStep >= 0
      ? userConfig.idleMaxStep : DEFAULT_HOST_CONFIG.idleMaxStep,
    /** Effective idle swing multiplier; 0 is an explicit "no idle sway" opt-out. */
    idleSwayScale: Number.isFinite(userConfig.idleSwayScale) && userConfig.idleSwayScale >= 0
      ? userConfig.idleSwayScale : DEFAULT_CONFIG.idleSwayScale,
    idleEye: userConfig.idleEye === true,
    /** Interpolated output rate (default 30 Hz) and optional high-rate transport path. */
    motionOutputHz: Math.min(
      DEFAULT_HOST_CONFIG.motionOutputHzMax,
      Number.isFinite(userConfig.motionOutputHz) && userConfig.motionOutputHz > 0
        ? userConfig.motionOutputHz : DEFAULT_HOST_CONFIG.motionOutputHz,
    ),
    motionWrites: userConfig.motionWrites === true,
    /** Watchdog for one physically unsettled send; 0 disables it (tests may shorten it). */
    motionSendTimeoutMs: Number.isFinite(userConfig.motionSendTimeoutMs) && userConfig.motionSendTimeoutMs > 0
      ? Math.min(30_000, userConfig.motionSendTimeoutMs)
      : DEFAULT_HOST_CONFIG.motionSendTimeoutMs,
    motionSendAbandonMs: Number.isFinite(userConfig.motionSendAbandonMs) && userConfig.motionSendAbandonMs >= 0
      ? Math.min(30_000, userConfig.motionSendAbandonMs)
      : DEFAULT_HOST_CONFIG.motionSendAbandonMs,
    /** Upper bound for an asynchronous abort confirmation; on expiry the cancel is unconfirmed. */
    motionCancelWaitMs: Number.isFinite(userConfig.motionCancelWaitMs) && userConfig.motionCancelWaitMs >= 0
      ? Math.min(30_000, userConfig.motionCancelWaitMs)
      : DEFAULT_HOST_CONFIG.motionCancelWaitMs,
    idleSpeechHoldMs: Number.isFinite(userConfig.idleSpeechHoldMs) && userConfig.idleSpeechHoldMs >= 0
      ? userConfig.idleSpeechHoldMs : DEFAULT_HOST_CONFIG.idleSpeechHoldMs,
    /** One discrete action at a time: the next candidate waits for the running one to end. */
    actionDurationMs: Number.isFinite(userConfig.actionDurationMs) && userConfig.actionDurationMs > 0
      ? Math.min(10000, Math.max(200, userConfig.actionDurationMs))
      : DEFAULT_HOST_CONFIG.actionDurationMs,
    /** Event-association lookback: how far before an action's trigger a Start may still be its own. */
    animationLookbackMs: Number.isFinite(userConfig.animationLookbackMs) && userConfig.animationLookbackMs >= 0
      ? Math.min(2000, userConfig.animationLookbackMs)
      : DEFAULT_HOST_CONFIG.animationLookbackMs,
    animationWindowMs: Number.isFinite(userConfig.animationWindowMs) && userConfig.animationWindowMs >= 0
      ? Math.min(10_000, userConfig.animationWindowMs)
      : DEFAULT_HOST_CONFIG.animationWindowMs,
    /** No single action outlives this, whatever a looping idle animation keeps declaring. */
    maxActionMs: Number.isFinite(userConfig.maxActionMs) && userConfig.maxActionMs > 0
      ? Math.min(ANIMATION_DURATION_MAX_MS, Math.max(ANIMATION_DURATION_MIN_MS, userConfig.maxActionMs))
      : DEFAULT_HOST_CONFIG.maxActionMs,
    /** Communication-event tuning: sentence-head window and the settle fade (P-139 stage 2). */
    intentHeadWindowMs: Number.isFinite(userConfig.intentHeadWindowMs) && userConfig.intentHeadWindowMs >= 0
      ? Math.min(2000, userConfig.intentHeadWindowMs)
      : DEFAULT_HOST_CONFIG.intentHeadWindowMs,
    intentSettleFadeMs: Number.isFinite(userConfig.intentSettleFadeMs) && userConfig.intentSettleFadeMs >= 0
      ? Math.min(2000, userConfig.intentSettleFadeMs)
      : DEFAULT_HOST_CONFIG.intentSettleFadeMs,
  };
  /**
   * Optional host probe: does this model really expose a hotkey/preset for the idle action? With a
   * probe, a complete action stays on the host path ONLY when the probe confirms it; otherwise the
   * runtime runs its parameter equivalent itself instead of asking for a hotkey that may not exist.
   */
  const hostHotkeyProbe = typeof userConfig.hasHotkey === 'function' ? userConfig.hasHotkey : null;

  const state = {
    connected: false,
    disposed: false,
    /** Connection generation: increments on every successful connect, never on disconnect. */
    generation: 0,
    /**
     * Connection-attempt generation. Every connect() claims a fresh value and every disconnect()
     * / dispose() bumps it, so an `await transport.connect()` that settles late can prove it was
     * invalidated and must not resurrect the runtime.
     */
    connectionGeneration: 0,
    owner: null,
    /** Monotonic owner seat token; every acquire/release/takeover invalidates the previous one. */
    ownerToken: 0,
    mouth: 0,
    mouthInput: null,
    lastError: null,
    lastErrorCode: null,
    errorCount: 0,
    connectedAt: null,
    lastActivityAt: null,
    idleSince: null,
  };

  /**
   * The single output slot for the continuous controller. It holds only the NEWEST frame:
   * submitting while a send is in flight overwrites the slot (counted as dropped) and the slow
   * send is never followed by a burst of replayed frames. Two independent concepts own the output:
   * `inFlight` is the physical send and is released by that send's own promise; `token` only marks
   * which frame generation a RESULT belongs to, so an epoch change can never leave the gate closed.
   * A timeout never frees the gate unless the transport can really cancel the old transfer; every
   * started send also carries a monotonic `seq` so a late completion cannot overwrite a newer one.
   */
  const motionPump = {
    slot: null,
    inFlight: false,
    /** Identity of the physical send that owns `inFlight`; a late settle cannot free a newer one. */
    sendId: 0,
    /** Physical send currently owning the gate: identity, sequence and an optional abort handle. */
    active: null,
    /** Monotonic ids: every started send, and the highest sequence whose result was applied. */
    sendSeq: 0,
    appliedSeq: 0,
    /** Highest sequence that already settled, so a late completion is recognisable. */
    settledSeq: 0,
    /** Watchdog of the current physical send, cleared by whichever side closes the gate first. */
    watchdog: null,
    /** Frame adoption generation: a bump makes an older send's result stale, never its lock. */
    token: 0,
    sent: 0,
    dropped: 0,
    stale: 0,
    timeouts: 0,
    /** A timed-out send that still never settled: its lane is skipped, no new value is written. */
    abandoned: 0,
    /** Watchdog cancels: confirmed means the old transfer provably cannot act after the abort. */
    cancelConfirmed: 0,
    cancelUnconfirmed: 0,
    outOfOrder: 0,
    skipped: false,
    frames: 0,
    writes: 0,
    errors: 0,
    lastFrameAt: null,
    lastSentAt: Number.NEGATIVE_INFINITY,
    lastAttemptAt: Number.NEGATIVE_INFINITY,
  };
  /**
   * Sender-side transport evidence. These FIVE phases are separate by construction and may never
   * masquerade as each other:
   *
   *   prepared   a frame's parameter rows were assembled (per frame) — nothing was sent yet;
   *   attempted  a transport call really started for those rows — still no acknowledgement;
   *   committed  the transport answered `ok:true` AND the send still belonged to its own connection
   *              generation/epoch and preset action identity — carries the payload rows and `at`;
   *   failed     `ok:false` or a thrown send (`failed`, with `errorCode`) — never a commit;
   *   stale      a result discarded because its generation/action changed before it settled.
   *
   * This is transport-level evidence only: it never claims the VTS pixels or the rendered model
   * were verified (`visible.verifiable` stays false).
   */
  const transportEvidence = {
    prepared: 0,
    preparedRows: 0,
    attempted: 0,
    attemptedRows: 0,
    committed: 0,
    committedRows: 0,
    failed: 0,
    failedRows: 0,
    stale: 0,
    staleRows: 0,
    lastPreparedAt: null,
    lastAttemptedAt: null,
    lastCommittedAt: null,
    lastFailedAt: null,
    lastStaleAt: null,
    lastError: null,
    lastErrorCode: null,
    lastStaleReason: '',
  };
  /** Output generation: bumped by lock/disconnect/close, so a queued old frame can never send. */
  let motionEpoch = 0;
  let motionLocked = false;
  let motionLockReason = '';

  // The core reads `inputs` at write time, so this object can be mutated after connect() when a
  // transport discovers the model's input map. `mouthInput` itself is always null here; the
  // facade owns the mapping and keeps the core's "never guess ParamMouthOpenY" rule intact.
  const innerInputs = { ...(userConfig.inputs ?? {}) };
  let mouthInputOverride = null;
  let timer = null;
  let unsubscribers = [];
  let flushing = false;
  let lastFlushAt = Number.NEGATIVE_INFINITY;
  /** Continuous idle parameter frame state (single-writer transport, own 4 Hz cadence). */
  let idleParamMap = normalizeIdleParams(null);
  let flushingIdle = false;
  /** Gate timestamp of the last idle attempt; `lastIdleFrameAt` is the last real frame sent. */
  let lastIdleWriteAt = Number.NEGATIVE_INFINITY;
  let lastIdleFrameAt = null;
  let lastIdleSuppressedAt = Number.NEGATIVE_INFINITY;
  let lastIdleSuppressedLogAt = Number.NEGATIVE_INFINITY;
  let lastIdleReducedLogAt = Number.NEGATIVE_INFINITY;
  let lastMouthActivityAt = Number.NEGATIVE_INFINITY;
  let idleTunedLogged = false;
  const idleSkipAt = new Map();
  /** Last semantic value written per channel: the per-frame step limiter starts from here. */
  const idleLastValue = new Map();
  /**
   * Motion floor ("never frozen"): consecutive idle sampling periods whose channels all repeated
   * their previous value. After IDLE_FLOOR_QUIET_CYCLES of them ONE head channel receives a
   * minimal breathing nudge, still bounded by idleMaxStep, so a still curve never looks dead.
   */
  const idleFloor = {
    quietCycles: 0,
    changed: false,
    target: null,
    sign: 1,
    injected: 0,
    loggedAt: Number.NEGATIVE_INFINITY,
    /** Step actually injected this frame, already bounded by remaining amplitude and idleMaxStep. */
    step: 0,
    /** The channel's semantic amplitude cap, for observability (`avatar.idle.motion-floor`). */
    amplitude: 0,
    reason: 'still',
    /** Frames where a non-zero floor was due but the channel is zero-amplitude (stationary). */
    skipped: 0,
    skippedAt: Number.NEGATIVE_INFINITY,
  };
  const idleEvents = [];
  const idleStats = {
    frames: 0,
    writes: 0,
    skipped: 0,
    /** Frames that arrived while a previous idle send was still in flight (single-slot drop). */
    dropped: 0,
    /** Writes that settled after the generation changed; they never touch the current frame. */
    stale: 0,
    /** Frames written while a mouth was active: REDUCED, never suppressed. */
    reducedBySpeech: 0,
    /** Frames skipped because the host explicitly paused idle motion (`flags.idle === false`). */
    suppressedByIdleOff: 0,
  };
  /**
   * Discrete action scheduler (facade-owned). ONE action at a time, each runs its own duration;
   * speech is deliberately absent from this state, so a new sentence can neither restart nor cut
   * a running action. `waiting` holds at most one candidate so a paced burst cannot replay.
   */
  const actionState = {
    current: null,
    waiting: [],
    delivered: [],
    seq: 0,
    started: 0,
    ended: 0,
    interrupted: 0,
    dropped: 0,
    /** Matching Starts refused because they were idle-loop or outside the action's window. */
    ignored: 0,
  };
  /**
   * Sentence-level action timing. A clip currently playing holds the single waiting candidate;
   * only a `speechClip('start')` (the real audio start of the next sentence) releases it, so an
   * action never begins in the middle of a sentence. `speechEnd()` closes the session and lets the
   * post-speech pose resume its own rhythm. Both are calls into the runtime, not timers.
   */
  const clipState = {
    /** A speech session (one or more clips) is open. */
    session: false,
    /** A clip is audibly playing right now. */
    active: false,
    /** The last clip ended and the next sentence boundary has not arrived yet. */
    awaitingStart: false,
    /** 0-based index of the clip that last started (the sentence index the host reported). */
    index: -1,
    startedAt: null,
    endedAt: null,
    /**
     * Where `startedAt` came from (P-139 stage 2 P1): `player-ready` for the file transport's
     * process-spawn anchor, `first-data` for the streamed transport's first chunk handed to the
     * player, or `fallback` when the transport never reported a start. It is a diagnostic, never
     * a claim of a measured speaker sample.
     */
    anchor: null,
    starts: 0,
    ends: 0,
    /** Waiting CANDIDATE started at a clip start (legacy `timed`; never an intent release). */
    timed: 0,
    /** Waiting candidate started on a normal tick (not a clip boundary). */
    candidateOther: 0,
  };
  /**
   * Communication events → sentence-level intents (P-139 stage 2). The event table decides WHICH
   * intent a phase selects; this state decides WHEN it may run: one staged intent at a time, one
   * intent per clip, and a generation that makes every pending/running intent of an old turn
   * unreleasable. `generation` is the P-139 identity for intents: a turn/session switch, lock,
   * disconnect, model switch or dispose bumps it, so a late boundary never revives an old action.
   */
  const intentTableConfig = normalizeIntentTable(userConfig.intentTable);
  const intentState = {
    table: intentTableConfig.table,
    tableInvalid: [...intentTableConfig.invalid],
    tableIgnored: [...intentTableConfig.ignored],
    /** Ticket ids are the `actionId` a staged intent will carry when it starts. */
    seq: 0,
    /** The single staged intent: `{ticket, event, intent, mapped, degraded, reason, generation, …}`. */
    pending: null,
    pendingSince: null,
    generation: 0,
    /** Conversation identity: `intentEvent({sessionId, turnId})` replaces it (turn switch). */
    sessionId: 0,
    turnId: 0,
    /**
     * P-139 stage 2 P1: the reply that owns this intent generation. The host opens one reply for
     * the user's accepted input (a voice final or a typed turn) and shares that id with the
     * pre-turn phase and the later Harness `turn/start`; only then may a turn change be a soft
     * continuation instead of a hard switch. `null` means "no reply identity supplied" and keeps
     * the historical hard turn/session switch.
     */
    replyId: null,
    /**
     * How many times `interrupt()` cut the pose. A reply continuation refuses to keep an action
     * whose `interruptSeq` predates the last interrupt (a real barge-in must never be softened).
     */
    interruptSeq: 0,
    /** Set by `interrupt()`; the next turn claim is hard instead of a same-reply continuation. */
    afterInterrupt: false,
    /** Clip index that already started an intent: at most one intent per sentence. */
    servedClip: -1,
    staged: 0,
    started: 0,
    dropped: 0,
    degraded: 0,
    settled: 0,
    /**
     * Release-path split (evidence only, never a selector): a real gesture released at a clip-start
     * boundary vs every other path (an action-busy deferral, `speechEnd`, the no-session tick, or a
     * phase event with no clip playing). The neutral `settle` keeps its own `settled` counter.
     */
    releasedAtClipStart: 0,
    releasedOther: 0,
    lastEvent: '',
    lastIntent: '',
    lastActionId: null,
    /**
     * Stage 4: the profile of the LAST released intent, used to keep two conclusions from landing
     * back-to-back. Any other released intent (or a generation switch) clears it.
     */
    lastIntentProfile: null,
    /** Stage 4: `markConclusion()` admissions and the ones refused as a repeat. */
    conclusionMarks: 0,
    conclusionDeduped: 0,
  };
  /**
   * Discrete idle pool: only actions the parameter engine can actually animate are sampled.
   * `plans` maps a name to its degraded/dropped disposition; it stays empty on the host hotkey
   * path (`filtered:false`), where no channel filtering is possible or wanted.
   */
  let idlePool = {
    available: [],
    dropped: [],
    degraded: [],
    plans: new Map(),
    fallback: false,
    aliveFallback: false,
    aliveChannel: null,
    filtered: false,
  };
  let idlePoolSignature = '';
  /** The pool exactly as the host configured it (index.js may narrow this array in place). */
  const sourceIdleActions = Array.isArray(userConfig.idleActions)
    ? userConfig.idleActions
    : DEFAULT_CONFIG.idleActions;
  /**
   * Last animation the transport reported, as `{name, durationMs, startedAt, isIdle}`. The host
   * forwards VTS ModelAnimationEvent Start/End (or exposes `transport.getAnimation()`); a matching
   * name replaces the configured action duration with the REAL one. Reset by the host on model
   * switch/disconnect, because VTS never sends an End event for an unloaded model.
   */
  let animationInfo = null;
  /**
   * The ONE animation observation an action already adopted, as `{actionId, name, startedAt}`.
   * A later action must never reuse it: an event whose `startedAt` is not newer than this still
   * belongs to the action that consumed it, so the previous action's length cannot leak forward.
   */
  let animationBinding = null;
  /** Last stale observation reported, so a lingering event is logged once per action, not per tick. */
  let staleAnimationKey = null;
  /** Action id whose ONE ignored-event record was already written (null/0 = none yet). */
  let ignoredAnimationActionId = 0;

  /** Read a VTS animation row from the several shapes the host/transport may hand over. */
  function normalizeAnimation(raw) {
    if (raw === null || raw === undefined) return null;
    const name = String(raw.name ?? raw.animationName ?? '').trim();
    if (name.length === 0) return null;
    const durationMs = Number(raw.durationMs ?? raw.duration ?? 0);
    return {
      name,
      durationMs: Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0,
      startedAt: Number.isFinite(raw.startedAt) ? raw.startedAt : null,
      isIdle: raw.isIdle === true || raw.isIdleAnimation === true,
    };
  }

  /** `transport.getAnimation()` is read at tick time so a push event needs no host callback. */
  function currentAnimation() {
    if (typeof transport?.getAnimation === 'function') {
      try {
        animationInfo = normalizeAnimation(transport.getAnimation());
      } catch {
        // A failing observation must never break the scheduler: keep the last known value.
      }
    }
    return animationInfo;
  }

  /** Action names and animation names are matched case-insensitively, allowing a decorated name. */
  function animationMatches(actionName, info) {
    const action = String(actionName ?? '').trim().toLowerCase();
    const animation = String(info?.name ?? '').trim().toLowerCase();
    if (action.length === 0 || animation.length === 0) return false;
    return action === animation || action.includes(animation) || animation.includes(action);
  }

  const boundedAnimationDuration = (durationMs) =>
    Math.max(ANIMATION_DURATION_MIN_MS, Math.min(ANIMATION_DURATION_MAX_MS, durationMs));

  /** Stable key for one observation, used to report a lingering event once instead of every tick. */
  const animationKey = (info) => `${String(info?.name ?? '').toLowerCase()}|${info?.startedAt ?? ''}`;

  /** The action ends on its own `endsAt` when known, never on `startedAt + durationMs` computed later. */
  const actionEndsAt = (action) =>
    Number.isFinite(action?.endsAt) ? action.endsAt : (action?.startedAt ?? 0) + (action?.durationMs ?? 0);

  /**
   * Clamp one action to the hard per-action ceiling. `capped:true` means the ceiling truncated it,
   * so the scheduler reports `avatar.action.forced-end {reason:'max-duration'}` instead of a normal
   * end: a looping idle Start can never extend an action past `maxActionMs`.
   */
  function applyActionCap(action) {
    const capAt = (action?.startedAt ?? 0) + host.maxActionMs;
    const endsAt = actionEndsAt(action);
    action.capped = endsAt > capAt;
    if (action.capped) action.endsAt = capAt;
    return action;
  }

  /**
   * True when `info` is an observation a DIFFERENT (previous) action already consumed. Its
   * `startedAt` is not newer than the bound one, so it describes the earlier animation: adopting it
   * would replay that action's length and re-time the current one to a stale start.
   */
  function animationIsStale(action, info) {
    const startedAt = info?.startedAt;
    if (animationBinding === null || !Number.isFinite(startedAt)) return false;
    if (animationBinding.actionId === action.actionId) return false;
    return !Number.isFinite(animationBinding.startedAt) || startedAt <= animationBinding.startedAt;
  }

  /**
   * A Start belongs to the running action only inside `[startedAt - lookback, startedAt + window]`:
   * the animation must have begun around the action's own trigger. Earlier is the PREVIOUS
   * animation, later is a different moment entirely (a looping/restarted preset): same name alone
   * is never proof.
   */
  function animationBelongsToAction(action, info) {
    const startedAt = info?.startedAt;
    if (!Number.isFinite(startedAt)) {
      return action.animationStartedAt === null || action.animationStartedAt === undefined;
    }
    return startedAt >= action.startedAt - host.animationLookbackMs
      && startedAt <= action.startedAt + host.animationWindowMs;
  }

  /** True when the Start began AFTER the action's binding window: too late to be this action's. */
  function animationIsAfterWindow(action, info) {
    return Number.isFinite(info?.startedAt) && info.startedAt > action.startedAt + host.animationWindowMs;
  }

  /** Report one refused observation once per action/event, never once per tick. */
  function noteStaleAnimation(action, info) {
    if (staleAnimationKey === animationKey(info)) return;
    staleAnimationKey = animationKey(info);
    recordIdleEvent('avatar.action.event-stale', {
      actionId: action.actionId,
      name: info?.name ?? '',
      startedAt: info?.startedAt ?? null,
      actionStartedAt: action.startedAt,
      boundStartedAt: animationBinding?.startedAt ?? null,
    });
  }

  /**
   * A matching Start refused because of its own kind/timing (looping idle or outside the window)
   * is reported ONCE per action: the same observation is re-read on every tick.
   */
  function noteIgnoredAnimation(action, info, reason) {
    if (ignoredAnimationActionId === action.actionId) return;
    ignoredAnimationActionId = action.actionId;
    actionState.ignored += 1;
    recordIdleEvent('avatar.action.event-ignored', {
      actionId: action.actionId,
      name: info?.name ?? '',
      startedAt: info?.startedAt ?? null,
      actionStartedAt: action.startedAt,
      isIdle: info?.isIdle === true,
      reason,
    });
  }

  /**
   * Bind ONE animation observation to the running action. `durationSource:'animation'` adopts both
   * the real length AND the real start: `endsAt = animation.startedAt + durationMs`, clamped to
   * `maxActionMs`. Refused (never adopted, so `endsAt` never moves):
   *   - `isIdle` Starts: a looping idle re-fires forever and is not this action's animation
   *     (`avatar.action.event-ignored {reason:'idle-loop'}`);
   *   - anything outside the binding window (`reason:'outside-window'`, or `event-stale` when it
   *     began before the action and belongs to the previous one);
   *   - a replay at/behind the already bound start.
   * A LATER Start of the SAME action inside the window rebinds it and recomputes `endsAt`
   * (`avatar.action.event-rebound`).
   */
  function adoptAnimation(info) {
    const current = actionState.current;
    if (current === null || info === null || info.durationMs <= 0) return false;
    if (!animationMatches(current.name, info)) return false;
    if (info.isIdle === true) {
      noteIgnoredAnimation(current, info, 'idle-loop');
      return false;
    }
    if (animationIsStale(current, info)) {
      noteStaleAnimation(current, info);
      return false;
    }
    if (!animationBelongsToAction(current, info)) {
      if (animationIsAfterWindow(current, info)) noteIgnoredAnimation(current, info, 'outside-window');
      else noteStaleAnimation(current, info);
      return false;
    }
    const durationMs = boundedAnimationDuration(info.durationMs);
    const animationStartedAt = Number.isFinite(info.startedAt) ? info.startedAt : current.startedAt;
    const bound = Number.isFinite(current.animationStartedAt) ? current.animationStartedAt : null;
    // Only a strictly later Start is a new animation; an equal/older one is a replay or the binding.
    if (bound !== null && animationStartedAt <= bound) return false;
    const oldEndsAt = actionEndsAt(current);
    current.durationMs = durationMs;
    current.animationStartedAt = animationStartedAt;
    current.endsAt = animationStartedAt + durationMs;
    current.estimated = false;
    current.durationSource = 'animation';
    applyActionCap(current);
    animationBinding = { actionId: current.actionId, name: info.name, startedAt: animationStartedAt };
    staleAnimationKey = null;
    if (bound !== null) {
      recordIdleEvent('avatar.action.event-rebound', {
        actionId: current.actionId,
        oldEndsAt,
        newEndsAt: actionEndsAt(current),
      });
    }
    return true;
  }

  /**
   * Channel takeover bookkeeping. A channel is only `controlled` when its mapping was verified:
   * the discovery result itself says `verified:true` for an injectable `inputName` (injectable
   * alone is a candidate, never proof), or an explicit `channel → inputName` mapping passed a live
   * probe that VTS acknowledged. Unmapped channels stay `skipped`; candidates and explicit
   * mappings that failed verification stay `unverified` and are never written.
   */
  const channelState = {
    initialized: false,
    bindings: new Map(),
    skipped: [],
    unverified: [],
  };
  const channelEventAt = new Map();
  let pendingChannelConfig = null;
  const IDLE_SUPPRESSED_LOG_MS = 5000;
  /** Quiet sampling periods before the motion floor nudges a channel ("never frozen"). */
  const IDLE_FLOOR_QUIET_CYCLES = 2;
  /** Minimal breathing nudge as a fraction of idleAmplitude; idleMaxStep still caps it. */
  const IDLE_FLOOR_STEP_RATIO = 0.15;
  /** A repeated written value is "still" only below this semantic delta. */
  const IDLE_FLOOR_EPSILON = 1e-6;
  const IDLE_FLOOR_LOG_MS = 10_000;
  /** Only head axes carry the floor: the opt-in eye must stay free for blink/expressions. */
  const IDLE_FLOOR_CHANNELS = new Set(['headX', 'headY', 'headZ']);
  /** The one connect attempt in flight; concurrent connect() callers share its promise. */
  let inFlightConnect = null;
  /** Attempt id that owns the physical connection; only its owner may release a late connection. */
  let connectionOwner = 0;
  /**
   * P2 barrier: the disconnect() currently closing the socket, as `{promise}`; null when idle.
   * `connected` stays true until that close settles, so connect() must wait on this barrier
   * instead of trusting `connected` — otherwise it short-circuits to `alreadyConnected:true`
   * and the stale close leaves the runtime disconnected.
   */
  let disconnectBarrier = null;
  /** Resolves once dispose() runs, so a connect() parked on the barrier can give up at once. */
  let signalDisposed = null;
  const disposedGate = new Promise((resolve) => {
    signalDisposed = resolve;
  });

  const injectedNow = typeof now === 'function'
    ? now
    : typeof userConfig.now === 'function'
      ? userConfig.now
      : () => Date.now();
  const clockNow = () => {
    const value = Number(injectedNow());
    return Number.isFinite(value) ? value : (state.lastActivityAt ?? 0);
  };

  const inner = createBehaviorRuntime({
    config: {
      ...userConfig,
      mouthInput: null,
      inputs: innerInputs,
      now: clockNow,
      writer: writeThroughTransport,
      /**
       * Preset decisions are also written to the host's debug event log (the controller throttles
       * them to one per class per second and only when `config.presetDebugEvents` is on). This is
       * a log sink only: the controller never reads it back, so no motion decision can change.
       */
      debugEvent: (type, data) => appendLog('debug', type, data),
    },
  });

  // ---- logging / errors ------------------------------------------------------------------
  function appendLog(level, message, data = {}) {
    try {
      if (typeof log === 'function') {
        log(message, { level, ...data });
        return;
      }
      if (log && typeof log[level] === 'function') {
        log[level](message, data);
        return;
      }
      if (log && typeof log.log === 'function') log.log(message, { level, ...data });
    } catch {
      // Logging is diagnostic only: it must never break a frame.
    }
  }

  function recordError(code, message, data = {}) {
    state.errorCount += 1;
    state.lastError = String(message);
    state.lastErrorCode = code;
    appendLog('warn', state.lastError, { code, ...data });
  }

  function fail(code, message, extra = {}, { record = true } = {}) {
    if (record) recordError(code, message, extra);
    return { ok: false, code, message: String(message), ...extra };
  }

  const disposedResult = () => fail(
    AVATAR_ERROR_CODES.DISPOSED,
    'avatar runtime has been disposed',
    {},
    { record: false },
  );

  function codeForReason(reason) {
    return INNER_REASON_CODES[reason] ?? AVATAR_ERROR_CODES.WRITE_FAILED;
  }

  function messageForReason(reason) {
    switch (reason) {
      case 'unmapped':
        return 'mouth input is not mapped (discover it from InputParameterListRequest)';
      case 'write-failed':
        return inner.snapshot().lastError || 'transport write failed';
      case 'mouth-busy':
        return `mouth is already owned by ${inner.snapshot().mouth.owner ?? 'another sender'}`;
      case 'stale-token':
      case 'no-session':
      case 'stale-write':
        return 'mouth session token is no longer valid';
      case 'non-numeric level':
        return 'mouth level must be a finite number';
      default:
        return String(reason ?? 'mouth write failed');
    }
  }

  // ---- transport boundary ----------------------------------------------------------------
  function writeThroughTransport(frame) {
    const payload = { input: frame.input, value: frame.value };
    if (frame.channel !== undefined) payload.channel = frame.channel;
    if (frame.probe === true) payload.probe = true;
    if (typeof transport?.write === 'function') return transport.write(payload);
    if (typeof transport?.writeMouth === 'function') return transport.writeMouth(payload);
    if (typeof transport?.inject === 'function') return transport.inject(payload);
    if (typeof userConfig.writer === 'function') return userConfig.writer(payload);
    return { ok: true, skipped: true };
  }

  // ---- single-slot / single-flight motion output -----------------------------------------
  /**
   * Invalidate every staged frame and make any send that settles afterwards stale. This is the
   * "cancel ≠ resource close" boundary: a normal action fades, but a privacy lock, disconnect,
   * close or model switch stops the old generation immediately.
   */
  function bumpMotionEpoch(reason) {
    motionEpoch += 1;
    // This invalidates RESULTS only. `inFlight` belongs to the send's own promise, so a lock
    // during a slow send can never leave the single-flight gate closed forever.
    motionPump.token += 1;
    if (motionPump.slot !== null) {
      motionPump.slot = null;
      motionPump.dropped += 1;
    }
    recordIdleEvent('avatar.motion.reset', { reason: String(reason ?? ''), epoch: motionEpoch });
  }

  function motionAlive(frame) {
    return motionLocked !== true
      && state.disposed !== true
      && state.connected === true
      && frame.epoch === motionEpoch
      && frame.generation === state.generation
      && frame.connectionGeneration === state.connectionGeneration;
  }

  /**
   * Build the input rows for one interpolated pose. This uses the same verified map, the same
   * mouth-priority rule and the same intent/idle limiters as the legacy idle flush, so switching
   * output paths can never introduce a second writer for one input.
   */
  function motionEntries(pose, at, snap) {
    const entries = [];
    const written = new Set();
    const speaking = mouthActiveForIdle(at, snap);
    const speechScale = speaking ? IDLE_SPEECH_SCALE : 1;
    const writeScale = postureWriteScale(snap);
    const intentChannels = new Set(snap.intents?.channels ?? []);
    for (const item of idleParamMap) {
      if (!IDLE_WRITE_CHANNELS.includes(item.channel)) continue;
      if (speaking && isMouthOwnedInput(item.inputName)) continue;
      if (host.idleEye !== true && (item.channel === 'eyeOpenL' || item.channel === 'eyeOpenR')
        && intentChannels.has(item.channel) !== true) continue;
      if (item.inputName === '' || written.has(item.inputName)) continue;
      const raw = pose[item.channel];
      if (!Number.isFinite(raw)) continue;
      const value = intentChannels.has(item.channel)
        ? intentWriteValue(item.channel, raw)
        : idleWriteValue(item, raw, speechScale, { writeScale });
      entries.push({
        input: item.inputName,
        value: writeInputValue(item, item.channel, value),
        channel: item.channel,
      });
      written.add(item.inputName);
    }
    for (const channel of intentChannels) {
      if (IDLE_WRITE_CHANNELS.includes(channel) || !INTENT_WRITE_CHANNELS.includes(channel)) continue;
      const binding = channelState.bindings.get(channel);
      if (binding?.verified !== true || written.has(binding.inputName)) continue;
      if (speaking && isMouthOwnedInput(binding.inputName)) continue;
      const raw = pose[channel];
      if (!Number.isFinite(raw)) continue;
      entries.push({
        input: binding.inputName,
        value: writeInputValue(binding, channel, intentWriteValue(channel, raw)),
        channel,
      });
      written.add(binding.inputName);
    }
    // Breath rides the same single-slot frame; with no verified channel it adds nothing.
    const breath = breathEntry(pose.breath, at);
    if (breath !== null && !written.has(breath.input)) entries.push(breath);
    return entries;
  }

  /**
   * Close the single-flight gate for exactly the physical send that owns it. This is owned by the
   * send, NOT by the frame token: an invalidated frame still ends its own send and advances the
   * pump, so a lock during a slow write can never deadlock the output.
   */
  function releaseMotionSend(sendId) {
    if (motionPump.sendId !== sendId) return false;
    if (motionPump.watchdog !== null) {
      clearTimeout(motionPump.watchdog);
      motionPump.watchdog = null;
    }
    const abandoned = motionPump.active?.abandonTimer;
    if (abandoned) {
      clearTimeout(abandoned);
      motionPump.active.abandonTimer = null;
    }
    stopMotionCancel(motionPump.active);
    motionPump.inFlight = false;
    motionPump.active = null;
    // A skipped lane reopens only when its unresolved old send finally settles: the newest frame
    // then goes out, and no older one can follow it.
    motionPump.skipped = false;
    motionPump.sendId += 1;
    return true;
  }

  /**
   * Record one completion event against the send sequence. A completion that is not newer than
   * what already settled is late by definition: it must never be adopted, or an aborted send
   * could overwrite a frame that was applied after it.
   */
  function admitMotionSettle(send) {
    send.settled = true;
    if (send.seq < motionPump.appliedSeq || send.seq <= motionPump.settledSeq) {
      motionPump.outOfOrder += 1;
      recordIdleEvent('avatar.motion.send.out-of-order', {
        sendId: send.sendId, seq: send.seq, appliedSeq: motionPump.appliedSeq, epoch: motionEpoch,
      });
      return false;
    }
    motionPump.settledSeq = send.seq;
    return true;
  }

  /** Ask the transport to cancel one physical send; the raw answer may be a Promise. */
  function requestMotionAbort(send) {
    try {
      if (typeof transport?.abortMotion === 'function') {
        return transport.abortMotion({ sendId: send.sendId, seq: send.seq, at: send.at });
      }
      const handle = send.handle;
      if (handle !== null && typeof handle === 'object' && typeof handle.then !== 'function') {
        for (const method of ['abort', 'cancel', 'terminate']) {
          if (typeof handle[method] === 'function') return handle[method]();
        }
      }
    } catch {
      // An abort that throws is a refusal: the gate must stay closed.
    }
    return false;
  }

  /** Stop waiting for an async cancel; the send's own lifecycle owns the gate from here. */
  function stopMotionCancel(send) {
    if (send === null || send === undefined || send.cancelDone === true) return false;
    send.cancelDone = true;
    if (send.cancelTimer !== null) {
      clearTimeout(send.cancelTimer);
      send.cancelTimer = null;
    }
    return true;
  }

  /** Record one cancel outcome; `ms` is how long an async confirmation was waited for. */
  function recordMotionCancel(send, mode, ms, confirmed) {
    if (confirmed) motionPump.cancelConfirmed += 1;
    else motionPump.cancelUnconfirmed += 1;
    recordIdleEvent('avatar.motion.send.cancel', { sendId: send.sendId, mode, ms, confirmed });
  }

  /**
   * Wait for an asynchronous abort to confirm, bounded by `motionCancelWaitMs`. Only a resolved
   * value other than `false` counts as cancelled; resolve false, reject and timeout all leave the
   * gate CLOSED on the abandoned path, because a newer frame must never overtake an old sender.
   */
  function awaitMotionAbort(send, pending) {
    const startedAt = clockNow();
    const finish = (confirmed) => {
      if (stopMotionCancel(send) !== true) return;
      recordMotionCancel(send, 'async', Math.max(0, Math.round(clockNow() - startedAt)), confirmed);
      if (motionPump.sendId !== send.sendId || send.settled) return;
      if (confirmed) {
        send.aborted = true;
        if (releaseMotionSend(send.sendId)) pumpMotion();
        return;
      }
      armMotionAbandon(send);
    };
    send.cancelTimer = setTimeout(() => finish(false), host.motionCancelWaitMs);
    if (typeof send.cancelTimer?.unref === 'function') send.cancelTimer.unref();
    Promise.resolve(pending).then((value) => finish(value !== false), () => finish(false));
  }

  /** Keep the gate CLOSED; if the old send still has not settled, mark its lane abandoned. */
  function armMotionAbandon(send) {
    if (send.abandonTimer !== null) return;
    send.abandonTimer = setTimeout(() => {
      send.abandonTimer = null;
      if (motionPump.sendId !== send.sendId || send.settled) return;
      motionPump.abandoned += 1;
      motionPump.skipped = true;
      recordIdleEvent('avatar.motion.send.abandoned', {
        sendId: send.sendId, seq: send.seq, epoch: motionEpoch, timeoutMs: host.motionSendTimeoutMs,
      });
    }, host.motionSendAbandonMs);
    if (typeof send.abandonTimer?.unref === 'function') send.abandonTimer.unref();
  }

  /**
   * Report an unsettled send without handing the model to a newer frame. The old transfer is
   * cancelled first — synchronously, or by awaiting the transport's confirmation — so it provably
   * cannot act on the model afterwards. Until that confirmation the gate stays CLOSED: a timeout
   * must never create two live senders (that is exactly how frames apply out of order).
   */
  function armMotionWatchdog(send) {
    const timeoutMs = host.motionSendTimeoutMs;
    if (!(timeoutMs > 0)) return;
    const handle = setTimeout(() => {
      motionPump.watchdog = null;
      if (motionPump.sendId !== send.sendId || send.settled) return;
      motionPump.timeouts += 1;
      recordIdleEvent('avatar.motion.send.timeout', {
        sendId: send.sendId, seq: send.seq, epoch: motionEpoch, timeoutMs,
      });
      const answer = requestMotionAbort(send);
      const asyncAnswer = answer !== null
        && (typeof answer === 'object' || typeof answer === 'function')
        && typeof answer.then === 'function';
      if (asyncAnswer) {
        awaitMotionAbort(send, answer);
        return;
      }
      // true/undefined = cancelled; false = refused (or no abort support at all).
      const confirmed = answer !== false;
      recordMotionCancel(send, 'sync', 0, confirmed);
      if (confirmed) {
        send.aborted = true;
        if (releaseMotionSend(send.sendId)) pumpMotion();
        return;
      }
      armMotionAbandon(send);
    }, timeoutMs);
    if (typeof handle?.unref === 'function') handle.unref();
    motionPump.watchdog = handle;
  }

  /** Send the one staged frame. A slow send is skipped; the newest frame waits in the slot. */
  function pumpMotion() {
    if (motionPump.inFlight || motionPump.skipped || motionLocked || state.disposed || state.connected !== true) return;
    const frame = motionPump.slot;
    if (frame === null) return;
    motionPump.slot = null;
    if (motionAlive(frame) !== true) {
      motionPump.stale += 1;
      return;
    }
    const snap = inner.snapshot();
    const entries = motionEntries(frame.pose, frame.at, snap);
    // `prepared` only: the rows this frame assembled. Nothing here proves a send happened.
    const ticket = beginTransportEvidence(entries, snap, {
      valueOf: (channel) => frame.pose[channel],
      speaking: mouthActiveForIdle(frame.at, snap),
      writtenInputs: new Set(entries.map((entry) => entry.input)),
      at: frame.at,
    });
    if (entries.length === 0) return;
    // The token records which frame generation this RESULT belongs to; sendId owns the gate and
    // seq proves whether a completion is newer than one already applied.
    const token = motionPump.token;
    const sendId = (motionPump.sendId += 1);
    const send = {
      sendId,
      seq: (motionPump.sendSeq += 1),
      token,
      frame,
      at: frame.at,
      handle: null,
      settled: false,
      aborted: false,
      abandonTimer: null,
      cancelTimer: null,
      cancelDone: false,
    };
    motionPump.inFlight = true;
    motionPump.active = send;
    armMotionWatchdog(send);
    const payload = {
      at: frame.at,
      generation: frame.generation,
      epoch: frame.epoch,
      pose: { ...frame.pose },
      entries,
    };
    const writer = typeof transport?.writeMotion === 'function'
      ? () => transport.writeMotion(payload)
      : typeof transport?.writeFrame === 'function'
        ? () => transport.writeFrame(entries)
        : null;
    if (writer === null) {
      releaseMotionSend(sendId);
      return;
    }
    // `attempted`: the transport call really starts here; the outcome is still unknown.
    noteTransportAttempted(ticket, entries, frame.at);
    let sent;
    try {
      sent = writer();
    } catch (error) {
      noteTransportFailed(ticket, entries, error, clockNow());
      releaseMotionSend(sendId);
      motionPump.errors += 1;
      recordError(AVATAR_ERROR_CODES.WRITE_FAILED, `motion frame failed: ${errorText(error)}`, {
        source: 'motion-frame',
      });
      return;
    }
    if (sent === null) {
      releaseMotionSend(sendId);
      return;
    }
    send.handle = sent;
    Promise.resolve(sent)
      .then((result) => {
        if (admitMotionSettle(send) !== true) {
          noteTransportStale(ticket, entries, 'out-of-order', clockNow());
          return;
        }
        // A send the transport really cancelled never acts on the model: do not adopt its result.
        if (send.aborted === true) {
          noteTransportStale(ticket, entries, 'aborted', clockNow());
          return;
        }
        if (result !== null && typeof result === 'object' && result.ok === false) {
          throw transportRejection(result, 'motion frame rejected');
        }
        // Adoption is decided by the token + frame validity; neither touches `inFlight`.
        if (motionPump.token !== token || motionAlive(frame) !== true) {
          motionPump.stale += 1;
          noteTransportStale(ticket, entries, 'generation', clockNow());
          return;
        }
        // `committed` only now: the transport said ok AND the send still belongs to this generation
        // and this preset action. A late result is discarded, never counted as a commit.
        noteTransportCommitted(ticket, entries, clockNow());
        motionPump.sent += 1;
        motionPump.writes += entries.length;
        countBreathEntries(entries, frame.at);
        motionPump.appliedSeq = send.seq;
        motionPump.lastSentAt = clockNow();
      })
      .catch((error) => {
        if (send.settled !== true && admitMotionSettle(send) !== true) {
          noteTransportStale(ticket, entries, 'out-of-order', clockNow());
          return;
        }
        if (send.aborted === true) {
          noteTransportStale(ticket, entries, 'aborted', clockNow());
          return;
        }
        // `failed`: ok:false or a thrown send. Never a commit, whatever the gate state is.
        noteTransportFailed(ticket, entries, error, clockNow());
        if (motionPump.sendId !== sendId) return;
        motionPump.errors += 1;
        recordError(AVATAR_ERROR_CODES.WRITE_FAILED, `motion frame failed: ${errorText(error)}`, {
          source: 'motion-frame',
        });
      })
      .finally(() => {
        // The send's own promise closes the gate, then the newest queued frame goes straight out.
        if (releaseMotionSend(sendId)) pumpMotion();
      });
  }

  /** Stage the newest pose. An existing unsent slot is overwritten and counted as dropped. */
  function submitMotionFrame(pose, at) {
    if (host.motionWrites !== true || motionLocked || state.disposed || state.connected !== true) return;
    // Interpolation rate: the host may tick faster than the configured output cadence, but the
    // transport sees at most `motionOutputHz` attempts. 1 ms of tolerance keeps exact 30 Hz grids
    // from being halved by floating-point jitter.
    const interval = 1000 / Math.max(1, host.motionOutputHz);
    if (at - motionPump.lastAttemptAt < interval - 1) return;
    motionPump.lastAttemptAt = at;
    motionPump.frames += 1;
    motionPump.lastFrameAt = at;
    if (motionPump.slot !== null) motionPump.dropped += 1;
    motionPump.slot = {
      pose: { ...pose },
      at,
      generation: state.generation,
      connectionGeneration: state.connectionGeneration,
      epoch: motionEpoch,
    };
    pumpMotion();
  }

  /** Opt-out/opt-in gate for the continuous writer (privacy lock, component close, model switch). */
  function setMotionEnabled(enabled, { reason = 'component' } = {}) {
    if (state.disposed) return disposedResult();
    if (enabled === false) {
      motionLocked = true;
      motionLockReason = String(reason ?? 'component');
      bumpMotionEpoch(`lock:${motionLockReason}`);
      // A component close / privacy lock stops the old generation's intents immediately: neither a
      // staged intent nor a running action may resume when the gate opens again.
      invalidateIntents(`lock:${motionLockReason}`, { interrupted: false });
      lastIdleWriteAt = Number.NEGATIVE_INFINITY;
      motionPump.lastAttemptAt = Number.NEGATIVE_INFINITY;
      recordIdleEvent('avatar.motion.locked', { reason: motionLockReason });
      return { ok: true, code: null, locked: true, reason: motionLockReason, epoch: motionEpoch };
    }
    motionLocked = false;
    motionLockReason = '';
    lastIdleWriteAt = Number.NEGATIVE_INFINITY;
    motionPump.lastAttemptAt = Number.NEGATIVE_INFINITY;
    recordIdleEvent('avatar.motion.unlocked', { epoch: motionEpoch });
    return { ok: true, code: null, locked: false, epoch: motionEpoch };
  }

  function readTransportMouthInput() {
    const direct = asInputName(transport?.mouthInput);
    if (direct !== '') return direct;
    if (typeof transport?.getMouthInput === 'function') {
      try {
        return asInputName(transport.getMouthInput());
      } catch (error) {
        recordError(AVATAR_ERROR_CODES.WRITE_FAILED, `mouth discovery failed: ${errorText(error)}`);
      }
    }
    return '';
  }

  /** Priority: explicit setter > caller config > transport discovery > previous value. */
  function syncMouthInput() {
    const name = mouthInputOverride
      || asInputName(userConfig.mouthInput)
      || asInputName(userConfig.inputs?.mouth)
      || readTransportMouthInput()
      || state.mouthInput
      || null;
    if (name) {
      state.mouthInput = name;
      innerInputs.mouth = { inputName: name };
    } else {
      innerInputs.mouth = null;
    }
    return name;
  }

  function setMouthInput(input) {
    if (state.disposed) return disposedResult();
    const name = asInputName(input);
    if (name === '') return fail(AVATAR_ERROR_CODES.INVALID_ARGUMENT, 'mouth input name must be a non-empty string');
    mouthInputOverride = name;
    state.mouthInput = name;
    innerInputs.mouth = { inputName: name };
    // A mouth name that came from discovery is a verified mapping; keep the status view honest.
    channelState.bindings.set('mouth', {
      channel: 'mouth', inputName: name, inputSource: 'discovery', injectable: true, verified: true,
    });
    return { ok: true, code: null, mouthInput: name };
  }

  // ---- channel takeover: verified input mappings only ------------------------------------
  /**
   * Takeover view plus the amplitude actually in force on every taken-over style channel.
   * A channel that is not controlled+verified is never listed, so it cannot silently receive a
   * persona style: it stays with VTS. `mouth` is controlled but not style-driven.
   */
  const statusChannels = () => {
    const controlled = CHANNELS.filter((channel) => channelState.bindings.get(channel)?.verified === true);
    const effective = inner.snapshot().style?.effective ?? {};
    const effectiveAmplitude = {};
    for (const channel of controlled) {
      if (AVATAR_STYLE_CHANNEL_RANGES[channel] === undefined) continue;
      const own = effective.channels?.[channel]?.amplitude;
      effectiveAmplitude[channel] = Number.isFinite(own) ? own : effective.amplitude;
    }
    return {
      controlled,
      skipped: [...channelState.skipped],
      unverified: [...channelState.unverified],
      effectiveAmplitude,
    };
  };

  /**
   * Publish the executor's capability proof. Only verified channels are sent; the core filters
   * the body/breath channels it leaves to VTS native animation.
   */
  function refreshPresetCapabilities() {
    const controlled = statusChannels().controlled;
    inner.setPresetCapabilities({
      channels: controlled,
      targetVerified: attentionTargetVerified === true,
      // A cursor bearing is a real direction even without a gaze channel: head-turn presets may
      // use it while the gaze-target channel filter still keeps unusable channels out.
      directionVerified: attentionDirectionVerified === true,
    });
  }

  /** One structured diagnostic per channel/reason per window; repeated frames cannot flood it. */
  function noteChannelEvent(type, channel, reason, data = {}) {
    const key = `${type}\u0000${channel}\u0000${reason}`;
    const at = clockNow();
    if (at - (channelEventAt.get(key) ?? Number.NEGATIVE_INFINITY) < 5000) return;
    channelEventAt.set(key, at);
    appendLog('debug', `${type}: ${channel}`, { event: type, channel, reason, ...data });
  }

  /** Normalise one discovery/config row; a row is usable only with an explicit input name. */
  const channelBinding = (channel, entry) => {
    const inputName = asInputName(entry);
    if (inputName === '') return null;
    return {
      channel,
      inputName,
      inputSource: String(entry?.inputSource ?? ''),
      min: Number.isFinite(entry?.min) ? entry.min : undefined,
      max: Number.isFinite(entry?.max) ? entry.max : undefined,
      defaultValue: Number.isFinite(entry?.defaultValue) ? entry.defaultValue : undefined,
      gain: Number.isFinite(entry?.gain) ? entry.gain : null,
      // Keep the discovery verdict: injectable only means the input exists, not that it drives
      // this channel. A row without `verified:true` stays a candidate.
      verified: entry?.verified === true,
    };
  };

  /**
   * Index a discovery result by channel. Usability starts at "the discovery result has an
   * `inputName` and `injectable:true`" — a model parameter name never qualifies — but control
   * additionally requires the row's own `verified:true`.
   */
  function discoveredChannelIndex(rawChannels) {
    const index = new Map();
    const add = (channel, entry) => {
      if (!CHANNELS.includes(channel) || entry === null || entry === undefined) return;
      if (entry.injectable !== true) return;
      const binding = channelBinding(channel, entry);
      if (binding !== null) index.set(channel, binding);
    };
    if (Array.isArray(rawChannels)) {
      for (const entry of rawChannels) add(String(entry?.channel ?? ''), entry);
    } else if (rawChannels !== null && typeof rawChannels === 'object') {
      for (const [channel, entry] of Object.entries(rawChannels)) add(channel, entry);
    }
    // Hosts may advertise the mouth mapping through the transport instead of the channel list.
    const mouthName = readTransportMouthInput();
    if (!index.has('mouth') && mouthName !== '') {
      const binding = channelBinding('mouth', { inputName: mouthName, inputSource: 'transport' });
      if (binding !== null) index.set('mouth', binding);
    }
    return index;
  }

  /** Config `inputs`/`idleParams` are the only mappings the runtime may be told about directly. */
  function configuredChannelConfig() {
    const channels = [];
    for (const [channel, entry] of Object.entries(userConfig.inputs ?? {})) {
      if (!CHANNELS.includes(channel) || entry === null || entry === undefined) continue;
      const binding = channelBinding(channel, entry);
      if (binding === null) continue;
      channels.push({ ...binding, inputSource: 'config-input', injectable: entry?.injectable !== false });
    }
    const channelMap = { ...(userConfig.channelMap ?? {}) };
    for (const [channel, entry] of Object.entries(userConfig.idleParams ?? {})) {
      if (!CHANNELS.includes(channel) || entry === null || entry === undefined) continue;
      const binding = channelBinding(channel, entry);
      if (binding === null) continue;
      if (asInputName(channelMap[channel]) === '') channelMap[channel] = binding.inputName;
      if (!channels.some((candidate) => candidate.channel === channel)) {
        channels.push({ ...binding, injectable: true });
      }
    }
    return { channels, channelMap };
  }

  /** The idle writer sees verified bindings only; every other row stays an empty, skipped row. */
  function refreshIdleParamMap() {
    idleParamMap = IDLE_PARAM_CHANNELS.map((channel) => {
      const binding = channelState.bindings.get(channel);
      return binding?.verified === true
        ? {
            channel,
            inputName: binding.inputName,
            min: binding.min,
            max: binding.max,
            defaultValue: binding.defaultValue,
            gain: binding.gain ?? null,
          }
        : { channel, inputName: '' };
    });
    idleSkipAt.clear();
  }

  /** A mouth binding is only used by the writer while it is controlled; unverified stays closed. */
  function syncChannelMouth() {
    if (channelState.initialized !== true) return;
    const binding = channelState.bindings.get('mouth');
    if (binding?.verified === true) {
      state.mouthInput = binding.inputName;
      innerInputs.mouth = { inputName: binding.inputName };
    } else {
      state.mouthInput = null;
      innerInputs.mouth = null;
    }
  }

  /**
   * Inject exactly one neutral probe and require proof that VTS accepted it. A transport that
   * reports the frame lifecycle must also report `acknowledged:true`: `sent:true` alone means the
   * frame left the socket (the 400 ms answer window may have expired), which is not evidence that
   * the input drives the model. Legacy transports without frame-state fields keep their `{ok:true}`
   * contract.
   */
  async function probeChannelBinding(binding) {
    const fallback = binding.channel === 'eyeOpenL' || binding.channel === 'eyeOpenR' ? 1 : 0;
    const value = Number.isFinite(binding.defaultValue) && binding.defaultValue !== 0
      ? binding.defaultValue : fallback;
    try {
      const result = await writeThroughTransport({
        input: binding.inputName,
        value,
        channel: binding.channel,
        probe: true,
      });
      if (result !== null && typeof result === 'object' && (result.ok === false || result.skipped === true)) {
        return { ok: false, reason: String(result.reason ?? 'probe-rejected') };
      }
      // Only an explicit acknowledgement turns the probe into proof; a missing ack is a failure.
      const reportsFrameState = result !== null && typeof result === 'object'
        && (result.acknowledged !== undefined || result.sent !== undefined || result.superseded !== undefined);
      if (reportsFrameState && result.acknowledged !== true) {
        return { ok: false, reason: 'no-acknowledgement' };
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: errorText(error) };
    }
  }

  let channelApplySeq = 0;
  /**
   * Replace the takeover set. A discovery row is controlled only when its own `verified:true`
   * says the input drives the channel — `injectable:true` alone is a candidate and stays
   * unverified. An explicit `channel → inputName` row is probed first and is controlled only when
   * VTS acknowledged the probe. Unmapped rows are skipped and recorded; everything else is
   * recorded as unverified and never written — no model parameter name is ever used as a fallback.
   */
  async function applyChannelMappings(rawChannels, channelMap = {}) {
    const seq = (channelApplySeq += 1);
    // A new model/component mapping is a new output generation: old queued frames are dropped.
    bumpMotionEpoch('channel-mappings');
    // The model changed: an intent staged for the old mappings must never be released on the new
    // model. Running actions are ended here; a reconnect re-stages whatever the host reports next.
    invalidateIntents('channel-mappings', { interrupted: false });
    const discovered = discoveredChannelIndex(rawChannels);
    const explicit = channelMap !== null && typeof channelMap === 'object' ? channelMap : {};
    const next = new Map();
    const skipped = [];
    const unverified = [];
    const pending = [];
    for (const channel of CHANNELS) {
      const explicitName = asInputName(explicit[channel]);
      const candidate = discovered.get(channel) ?? null;
      if (explicitName !== '') {
        if (candidate === null
          || candidate.inputName.toLowerCase() !== explicitName.toLowerCase()) {
          unverified.push(channel);
          noteChannelEvent('avatar.channel.unverified', channel,
            candidate === null ? 'not-injectable' : 'mismatch', { input: explicitName });
          continue;
        }
        const binding = { ...candidate, explicit: true, verified: false };
        next.set(channel, binding);
        pending.push(binding);
        continue;
      }
      if (candidate !== null) {
        // The discovery result is the only authority here: `injectable:true` without
        // `verified:true` is a candidate, so it is recorded but never controlled or written.
        const verified = candidate.verified === true;
        next.set(channel, { ...candidate, explicit: false, verified });
        if (!verified) {
          unverified.push(channel);
          noteChannelEvent('avatar.channel.unverified', channel, 'not-verified', { input: candidate.inputName });
        }
      } else {
        skipped.push(channel);
        noteChannelEvent('avatar.channel.skipped', channel, 'unmapped');
      }
    }
    for (const binding of pending) {
      const outcome = await probeChannelBinding(binding);
      if (seq !== channelApplySeq) return { ok: true, code: null, channels: statusChannels() };
      if (outcome.ok === true) {
        binding.verified = true;
        noteChannelEvent('avatar.channel.verified', binding.channel, 'probe-accepted', { input: binding.inputName });
      } else {
        unverified.push(binding.channel);
        noteChannelEvent('avatar.channel.unverified', binding.channel, outcome.reason, { input: binding.inputName });
      }
    }
    channelState.bindings = next;
    channelState.skipped = CHANNELS.filter((channel) => skipped.includes(channel));
    channelState.unverified = CHANNELS.filter((channel) => unverified.includes(channel));
    channelState.initialized = true;
    refreshIdleParamMap();
    syncChannelMouth();
    // The discrete pool depends on the verified set: recompute it (and record it once) here.
    refreshIdleActionPool('channels');
    refreshPresetCapabilities();
    return { ok: true, code: null, channels: statusChannels() };
  }

  /** Public setter: applies immediately when connected, otherwise at the next successful connect. */
  async function setChannelMappings(channels, { channelMap = userConfig.channelMap ?? {} } = {}) {
    if (state.disposed) return disposedResult();
    pendingChannelConfig = {
      channels: Array.isArray(channels) ? channels : (channels ?? []),
      channelMap: channelMap ?? {},
    };
    if (state.connected !== true) {
      return { ok: true, code: null, connected: false, channels: statusChannels() };
    }
    return applyChannelMappings(pendingChannelConfig.channels, pendingChannelConfig.channelMap);
  }

  // ---- listeners + timer -----------------------------------------------------------------
  function detachTransportListeners() {
    for (const off of unsubscribers) {
      try {
        off();
      } catch {
        // An unsubscribe that throws must not block teardown.
      }
    }
    unsubscribers = [];
  }

  function handleTransportClose() {
    if (state.disposed || state.connected !== true) return;
    state.connected = false;
    bumpMotionEpoch('transport-close');
    stopAutoTick();
    detachTransportListeners();
    resetMouthState('transport-close');
    recordError(AVATAR_ERROR_CODES.NOT_CONNECTED, 'transport closed', { source: 'listener' });
  }

  function attachTransportListeners() {
    detachTransportListeners();
    if (typeof transport?.on !== 'function') return;
    const subscribe = (event, handler) => {
      let off;
      try {
        off = transport.on(event, handler);
      } catch (error) {
        recordError(AVATAR_ERROR_CODES.WRITE_FAILED, `transport listener failed: ${errorText(error)}`);
        return;
      }
      if (typeof off === 'function') {
        unsubscribers.push(off);
      } else if (typeof transport.off === 'function') {
        unsubscribers.push(() => transport.off(event, handler));
      }
    };
    subscribe('close', handleTransportClose);
    subscribe('disconnect', handleTransportClose);
    subscribe('error', (error) => {
      recordError(AVATAR_ERROR_CODES.WRITE_FAILED, errorText(error), { source: 'transport-event' });
    });
  }

  function stopAutoTick() {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  function startAutoTick() {
    stopAutoTick();
    if (!(host.autoTickMs > 0) || typeof setInterval !== 'function') return;
    timer = setInterval(() => {
      try {
        tick();
      } catch (error) {
        recordError(AVATAR_ERROR_CODES.WRITE_FAILED, errorText(error), { source: 'auto-tick' });
      }
    }, host.autoTickMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  function resetChannelState() {
    channelApplySeq += 1;
    channelState.initialized = false;
    channelState.bindings.clear();
    channelState.skipped = [];
    channelState.unverified = [];
    channelEventAt.clear();
    // A disconnected runtime controls nothing; a reconnect re-verifies the mappings it is given.
    idleParamMap = normalizeIdleParams(null);
    idleSkipAt.clear();
    // No verified channels = no channel filtering: restore the host's own pool (hotkey path).
    refreshIdleActionPool('reset');
  }

  function resetMouthState(reason) {
    // A privacy lock / disconnect / model switch must stop the old output generation NOW: no
    // queued frame is drained and no in-flight settle is allowed to extend the old generation.
    bumpMotionEpoch(reason);
    // A teardown stops the running action, but that is not an interruption: no interrupted event.
    // The intent generation is bumped here too: a staged intent of the old generation can never
    // start after a disconnect / model switch / component close.
    invalidateIntents(reason, { interrupted: false, clearClip: true });
    actionState.delivered.length = 0;
    // interrupt() releases the mouth session, zeroes the level and publishes the rest pose.
    try {
      inner.interrupt({ reason });
    } catch (error) {
      recordError(AVATAR_ERROR_CODES.WRITE_FAILED, `reset failed: ${errorText(error)}`);
    }
    resetChannelState();
    // The animation that was running died with the transport/model: neither its duration nor its
    // observation identity may leak into a later action of the same name on the next connection.
    animationInfo = null;
    animationBinding = null;
    staleAnimationKey = null;
    state.owner = null;
    state.ownerToken += 1;
    state.mouth = 0;
  }

  // ---- ownership seat --------------------------------------------------------------------
  function ensureOwnership(owner, { token, takeover = false } = {}) {
    const name = asOwner(owner) ?? 'speech';
    if (state.owner === null && Number.isFinite(token)) {
      return fail(
        AVATAR_ERROR_CODES.TOKEN_EXPIRED,
        'mouth owner token has expired',
        { token, current: state.ownerToken },
        { record: false },
      );
    }
    if (state.owner !== null && Number.isFinite(token) && token !== state.ownerToken) {
      return fail(
        AVATAR_ERROR_CODES.TOKEN_EXPIRED,
        'mouth owner token has expired',
        { token, current: state.ownerToken },
        { record: false },
      );
    }
    if (state.owner !== null && state.owner !== name && takeover !== true) {
      return fail(
        AVATAR_ERROR_CODES.OWNERSHIP_CONFLICT,
        `mouth is already owned by ${state.owner}`,
        { owner: state.owner, requested: name, current: state.ownerToken },
        { record: false },
      );
    }

    if (state.owner === name) {
      // Same owner: keep the seat (and its token). Reopen a live session only if the core lost it.
      const snap = inner.snapshot();
      if (snap.mouth.active !== true) {
        const opened = inner.startSpeech({ owner: name, live: true, startedAt: clockNow() });
        if (opened.ok !== true) {
          return fail(codeForReason(opened.reason), messageForReason(opened.reason), {
            reason: opened.reason, owner: name,
          });
        }
      }
      return { ok: true, code: null, owner: name, token: state.ownerToken, reused: true };
    }

    const previous = state.owner;
    const previousToken = state.ownerToken;
    state.owner = name;
    state.ownerToken += 1;
    state.mouth = 0;
    let opened;
    try {
      opened = inner.startSpeech({
        owner: name,
        live: true,
        startedAt: clockNow(),
        takeover: previous !== null,
      });
    } catch (error) {
      state.owner = previous;
      state.ownerToken = previousToken;
      return fail(AVATAR_ERROR_CODES.WRITE_FAILED, `speech session failed: ${errorText(error)}`);
    }
    if (opened.ok !== true) {
      state.owner = previous;
      state.ownerToken = previousToken;
      return fail(codeForReason(opened.reason), messageForReason(opened.reason), {
        reason: opened.reason, owner: previous,
      });
    }
    return {
      ok: true,
      code: null,
      owner: name,
      token: state.ownerToken,
      generation: state.generation,
      replaced: previous,
    };
  }

  // ---- transport flush -------------------------------------------------------------------
  function noteInnerFailure(result, source) {
    if (!result || result.ok === true) return;
    // A coalesced frame that lost its session during `await` is expected, not an error.
    if (result.reason === 'stale-write') return;
    recordError(codeForReason(result.reason), messageForReason(result.reason), {
      source,
      reason: result.reason,
    });
  }

  /**
   * Where the current idle motion comes from:
   *   param  — discovered head/eye/gaze inputs are driven by this runtime's frames;
   *   hotkey — no parameter mapping; the host's light hotkey/expression fallback is all there is;
   *   none   — neither is configured.
   * A hotkey fallback is deliberately NOT reported as a continuous behavior engine.
   */
  function currentIdleSource() {
    const writable = idleParamMap.some((entry) => entry.inputName !== ''
      && IDLE_WRITE_CHANNELS.includes(entry.channel)
      && (host.idleEye === true || !entry.channel.startsWith('eyeOpen')));
    if (writable) return 'param';
    return installedIdleActions().length > 0 ? 'hotkey' : 'none';
  }

  /**
   * The names actually installed on the sampler. On the hotkey path this is the host's own array
   * (index.js narrows it in place), so a live read is required.
   */
  const installedIdleActions = () => (
    idlePool.filtered === true ? idlePool.available : sourceIdleActions
  );

  /** Idle channels the continuous writer can address right now (same rule as currentIdleSource). */
  const writableIdleChannels = (controlled) => controlled.filter((channel) => (
    IDLE_WRITE_CHANNELS.includes(channel)
    && (host.idleEye === true || !channel.startsWith('eyeOpen'))
  ));

  /** Does the host itself own a hotkey/preset for this action? Only an explicit probe is proof. */
  function hostPlaysAction(name) {
    if (hostHotkeyProbe === null) return false;
    try {
      return hostHotkeyProbe(name) === true;
    } catch {
      // A throwing probe means "unknown": the runtime runs the gesture itself instead of skipping it.
      return false;
    }
  }

  /**
   * The host's pool is its own capability claim: index.js narrows `idleActions` to the names the
   * model exposes as hotkeys/expressions. A strict subset of the built-in pool therefore means the
   * host has already adapted those actions (a hosted preset exists); the untouched default pool
   * proves nothing about a hotkey.
   */
  function hostAdaptedPool() {
    const builtin = DEFAULT_CONFIG.idleActions;
    return sourceIdleActions.length > 0 && sourceIdleActions.length < builtin.length
      && sourceIdleActions.every((name) => builtin.includes(name));
  }

  /**
   * Narrow the discrete action pool to what the parameter engine can actually animate. A complete
   * action the host can really play keeps the host hotkey path; a one-channel gesture (or a partial
   * mapping) is run HERE as an equivalent intent gesture; an action with nothing mapped leaves the
   * pool for good. The pool event and the one summary skip are recorded once per change — never
   * once per interval.
   */
  function refreshIdleActionPool(reason = 'mapping') {
    if (state.disposed === true) return idlePool;
    const controlled = statusChannels().controlled;
    const filtered = currentIdleSource() === 'param';
    const hostAdapted = hostAdaptedPool();
    const available = [];
    const dropped = [];
    const degraded = [];
    const plans = new Map();
    for (const name of sourceIdleActions) {
      const spec = IDLE_ACTION_CHANNELS[name];
      if (filtered !== true || spec === undefined) {
        available.push(name);
        continue;
      }
      const complete = spec.required.every((channel) => controlled.includes(channel));
      // Host path: a probe-confirmed hotkey, or (without a probe) a multi-channel preset, or an
      // action the host itself narrowed into the pool. Anything else the param engine can express is
      // executed HERE — waiting for a hotkey this model may not have is what skipped these actions.
      const hostPath = complete && (hostHotkeyProbe !== null
        ? hostPlaysAction(name)
        : spec.required.length > 1 || hostAdapted);
      if (hostPath) {
        available.push(name);
        continue;
      }
      const channel = spec.degraded.find((candidate) => controlled.includes(candidate));
      const intentKind = channel === undefined ? undefined
        : (IDLE_ACTION_INTENTS[name] ?? []).find((kind) => (INTENT_CHANNEL_TARGETS[kind] ?? []).includes(channel));
      if (intentKind === undefined) {
        if (complete === true) {
          // Nothing to substitute: keep a fully mapped action on the host path, never drop it.
          available.push(name);
          continue;
        }
        dropped.push(name);
        plans.set(name, { mode: 'dropped' });
        continue;
      }
      available.push(name);
      degraded.push(name);
      plans.set(name, { mode: 'degraded', channel, intentKind });
    }
    const writable = writableIdleChannels(controlled);
    const aliveFallback = writable.length === 1;
    idlePool = {
      available,
      dropped,
      degraded,
      plans,
      fallback: degraded.length > 0,
      aliveFallback,
      aliveChannel: aliveFallback ? writable[0] : null,
      filtered,
    };
    inner.setIdleActions(installedIdleActions());
    const signature = `${available.join(',')}|${dropped.join(',')}|${aliveFallback ? 'alive' : ''}`;
    if (signature === idlePoolSignature) return idlePool;
    idlePoolSignature = signature;
    recordIdleEvent('avatar.idle.actions.pool', {
      available: [...available],
      dropped: [...dropped],
      fallback: degraded.length > 0,
      reason: String(reason ?? 'mapping'),
    });
    // ONE summary per pool change. A skipped action is no longer re-sampled every interval, so the
    // old "channel.skipped every 9 s" stream (which made the avatar look frozen) cannot repeat.
    if (dropped.length > 0) {
      const channels = [...new Set(dropped.flatMap((name) => IDLE_ACTION_CHANNELS[name]?.required ?? []))];
      recordIdleEvent('avatar.channel.skipped', {
        channel: dropped[0],
        reason: 'idle-action-unmapped',
        actions: [...dropped],
        channels,
      });
    }
    return idlePool;
  }

  /** One skip line per channel/reason per window: a 10 Hz frame must not flood the event log. */
  function noteIdleSkip(channel, reason) {
    idleStats.skipped += 1;
    const key = `${channel}\u0000${reason}`;
    const now = clockNow();
    if (now - (idleSkipAt.get(key) ?? Number.NEGATIVE_INFINITY) < 5000) return;
    idleSkipAt.set(key, now);
    appendLog('debug', `idle channel skipped: ${channel}`, {
      event: 'avatar.channel.skipped',
      channel,
      reason,
    });
  }

  /**
   * Legacy adopter: a bare `channel → inputName` map is treated as an explicit mapping, so every
   * name must pass the same live probe before it can be written. The discovery path calls
   * `setChannelMappings()` with the full rows instead.
   */
  async function setIdleParams(map) {
    if (state.disposed) return disposedResult();
    return setChannelMappings([], { channelMap: map ?? {} });
  }

  /** Idle write cadence: configured Hz, but never faster than the transport flush interval. */
  const idleWriteIntervalMs = () => Math.max(
    host.flushIntervalMs,
    Math.ceil(1000 / Math.max(0.1, host.idleWriteHz)),
  );

  /** Apply a persona style (lazy merge inside the core); the host calls this after a background build. */
  function setStyle(style, { styleVersion } = {}) {
    if (state.disposed) return disposedResult();
    const result = inner.setStyle(style, { styleVersion });
    if (result.ok === true) {
      appendLog('debug', 'avatar style applied', {
        event: 'avatar.style.set',
        styleVersion: result.styleVersion,
        changed: result.changed,
      });
    }
    return result;
  }

  /** Host event → temporary state. Never rewrites the persona baseline. */
  function setStatus(status, options = {}) {
    if (state.disposed) return disposedResult();
    // A status change may scale amplitude (STATUS_MODIFIERS) but never restarts the idle rhythm,
    // re-samples an action or clears a queue: speaking only shapes the mouth and the style scale.
    return inner.setStatus(status, options);
  }

  /**
   * Opt into (or out of) the read-only preset library as the action executor. A hold draw is a
   * legal outcome and writes nothing. Enabling also publishes the verified capability proof.
   */
  function setPresetExecution(enabled, { at = null } = {}) {
    if (state.disposed) return disposedResult();
    presetExecution = enabled === true;
    const result = inner.setPresetExecution(presetExecution, {
      at: Number.isFinite(at) ? at : clockNow(),
    });
    if (presetExecution === true) refreshPresetCapabilities();
    return result;
  }

  /** Replace the user override set (same shape as `<root>/data/motion-presets.json`). */
  function setPresetOverrides(overrides) {
    if (state.disposed) return disposedResult();
    return inner.setPresetOverrides(overrides);
  }

  /** Dry-run selection with the current capability proof and style. */
  function selectPreset(context = {}) {
    if (state.disposed) return disposedResult();
    return inner.selectPreset(context);
  }

  /** Select + execute one action boundary (a hold returns `started:false`, writing nothing). */
  function preset(context = {}) {
    if (state.disposed) return disposedResult();
    return inner.preset(context);
  }

  /** Smooth exit for the active preset trajectory (a cancel, not a resource close). */
  function cancelPreset(options = {}) {
    if (state.disposed) return disposedResult();
    return inner.cancelPreset(options);
  }

  /** Patch the intent (gaze/pose/flags). Observation + writes only; no scheduler side effect. */
  function setIntent(patch = {}) {
    if (state.disposed) return disposedResult();
    const result = inner.setIntent(patch);
    // Let the next tick carry the new intent instead of waiting out the idle interval.
    lastIdleWriteAt = Number.NEGATIVE_INFINITY;
    return result;
  }

  /**
   * Explicit barge-in / cancel: the running action is cut and recorded as interrupted, the
   * waiting candidate is dropped, and the pose falls back to rest. Only this path (or a
   * teardown) ever ends an action before its duration; speech NEVER does.
   */
  function interrupt({ reason = 'interrupt' } = {}) {
    if (state.disposed) return disposedResult();
    const at = clockNow();
    // A real interruption is never a same-reply continuation: the next turn claim must stay hard
    // until a new user input opens the next reply (`turn-start` / `user-speaking`).
    intentState.interruptSeq += 1;
    intentState.afterInterrupt = true;
    // A barge-in is a soft stop: the action fades (interrupted), but the output epoch is not
    // bumped. The pending intent of this generation is dropped with a recorded reason.
    const cut = actionState.current !== null;
    invalidateIntents(reason, { at, interrupted: true, clearClip: true });
    actionState.delivered.length = 0;
    const result = inner.interrupt({ reason });
    state.mouth = 0;
    appendLog('debug', 'avatar runtime interrupted', { reason, interruptedAction: cut });
    return {
      ok: true,
      code: null,
      reason: String(reason),
      interruptedAction: cut,
      token: result.token,
      turnId: result.turnId,
    };
  }

  /** True when the transport has an animation whose name matches the running action's duration. */
  function animationSnapshot() {
    const info = animationInfo;
    return {
      current: info === null ? null : { ...info },
      matchedAction: actionState.current !== null && info !== null
        && animationMatches(actionState.current.name, info),
    };
  }

  /**
   * Feed one VTS ModelAnimationEvent observation to the scheduler. `info` is
   * `{name, durationMs, startedAt, isIdle}`; `null` clears it (End / model switch / disconnect).
   * A matching animation retimes the running action from ITS OWN start (`startedAt + durationMs`)
   * and is refused when it still belongs to the previous action.
   * Hosts that expose `transport.getAnimation()` do not need to call this.
   */
  function setAnimation(info, { reason = 'event' } = {}) {
    if (state.disposed) return disposedResult();
    const previous = animationInfo;
    animationInfo = normalizeAnimation(info);
    if (animationInfo !== null && adoptAnimation(animationInfo) === true) {
      const current = actionState.current;
      // A Start that arrived late may already be over. Its real end is authoritative: end the action
      // NOW instead of granting it a fresh duration that would extend the animation.
      if (current !== null && actionEndsAt(current) <= clockNow()) {
        endAction(clockNow(), { interrupted: false });
      }
    }
    if (previous?.name !== animationInfo?.name || previous?.durationMs !== animationInfo?.durationMs) {
      appendLog('debug', 'avatar animation observed', {
        event: 'avatar.animation.observed',
        reason: String(reason ?? 'event'),
        name: animationInfo?.name ?? '',
        durationMs: animationInfo?.durationMs ?? 0,
        isIdle: animationInfo?.isIdle === true,
      });
    }
    return { ok: true, code: null, animation: animationSnapshot() };
  }

  /**
   * Ask for one named gesture. Only channels verified by discovery / an accepted probe participate;
   * an intent whose channels are all unadapted is refused and recorded (never guessed or injected).
   * The gesture is folded into the ONE composed frame — it is not a second writer.
   *
   * Stage 4: `profile` ('conclusion' | 'confused') is expression only — it may extend the gesture
   * with the already-mapped brow channels (confused), and `response: true` marks a short reply that
   * may use the 0.8–1.2 s posture transition (B).
   */
  function intent(action, { channels, at, profile = null, response = false } = {}) {
    if (state.disposed) return disposedResult();
    if (state.connected !== true) {
      return fail(AVATAR_ERROR_CODES.NOT_CONNECTED, 'avatar runtime is not connected');
    }
    const kind = String(action ?? '');
    const time = Number.isFinite(at) ? at : undefined;
    if (INTENT_CHANNEL_TARGETS[kind] === undefined) {
      return fail(
        AVATAR_ERROR_CODES.INVALID_ARGUMENT,
        `unknown intent: ${kind}`,
        { supported: [...INTENT_KINDS] },
        { record: false },
      );
    }
    const gestureProfile = isMotionProfile(profile) ? String(profile) : null;
    const targets = intentChannelsFor(kind, gestureProfile);
    const controlled = statusChannels().controlled;
    const requested = Array.isArray(channels) && channels.length > 0 ? channels : [...targets];
    const available = targets.filter((channel) => requested.includes(channel) && controlled.includes(channel));
    const skipped = targets.filter((channel) => !available.includes(channel));
    if (available.length === 0) {
      recordIdleEvent('avatar.intent.skipped', { kind, reason: 'unmapped', channels: skipped });
      return fail(
        AVATAR_ERROR_CODES.UNMAPPED,
        `intent ${kind} has no verified channel`,
        { kind, skipped },
        { record: false },
      );
    }
    if (skipped.length > 0) recordIdleEvent('avatar.intent.channel-skipped', { kind, channels: skipped });
    // `at` anchors the gesture to the sentence boundary that released it, not to a later tick.
    const result = inner.intent(kind, {
      channels: available,
      at: time,
      generation: intentState.generation,
      profile: gestureProfile,
      response: response === true,
    });
    if (result.ok === true) {
      // Let the NEXT tick write the first intent frame instead of waiting out the current idle
      // interval. This is one prompt, not a new frequency: style never changes the write rate.
      lastIdleWriteAt = Number.NEGATIVE_INFINITY;
      appendLog('debug', 'avatar intent started', {
        event: 'avatar.intent.start',
        kind,
        durationMs: result.durationMs,
        amplitude: result.amplitude,
        channels: result.channels,
      });
    }
    return result;
  }

  /**
   * Item 4 — conversation-end relax. Decays the posture amplitude to the base over 2–4 s (a planned
   * transition, no jump) and lets the effective style relax in the same window. It never cuts an
   * action, never re-rolls the hold window and starts no timer: the 30 Hz tick drives it.
   */
  function relax(options = {}) {
    if (state.disposed) return disposedResult();
    const at = Number.isFinite(options?.at) ? options.at : clockNow();
    const result = inner.relax({
      at,
      durationMs: Number.isFinite(options?.durationMs) ? options.durationMs : undefined,
    });
    if (result.ok === true) {
      appendLog('debug', 'avatar relax', {
        event: 'avatar.motion.relax',
        at: result.at,
        durationMs: result.durationMs,
        transitionMs: result.transitionMs,
      });
    }
    return { ...result, code: null };
  }

  /**
   * Cancel a running gesture with a short fade (a normal cancel, not a resource close). The action
   * slot is freed immediately, but its pose contribution leaves continuously.
   */
  function cancelAction(kind = null, { fadeMs = 240 } = {}) {
    if (state.disposed) return disposedResult();
    const cut = endAction(clockNow(), { interrupted: false, by: 'cancel' });
    actionState.waiting.length = 0;
    const result = inner.cancelIntent(kind, { fadeMs });
    if (result.ok === true) {
      recordIdleEvent('avatar.action.cancelled', { kind: kind ?? '*', fadeMs: result.fadeMs });
    }
    return { ...result, code: null, action: cut };
  }

  /**
   * Publish (or clear) the verified attention target/direction. Without a proof flag this only
   * records the preset neutral direction; `lookAtUser` never invents a target from random drift.
   * A finite, verified target also proves a DIRECTION, even when the model has no gaze channel.
   */
  function setAttention(target, { verified = false, source = 'host', at = null, record = true } = {}) {
    if (state.disposed) return disposedResult();
    const x = Number(target?.x);
    const y = Number(target?.y);
    const provenTarget = verified === true && Number.isFinite(x) && Number.isFinite(y);
    attentionTargetVerified = provenTarget;
    attentionDirectionVerified = provenTarget;
    // A gaze target additionally needs a verified gaze channel. Without one the controller keeps
    // its neutral attention pose, but the cursor bearing above still proves a direction.
    const controlled = statusChannels().controlled;
    const hasGaze = controlled.includes('gazeX') || controlled.includes('gazeY');
    const supplied = provenTarget && Number.isFinite(at) ? { ...target, at } : target;
    const attention = inner.setAttention(supplied, { verified: provenTarget && hasGaze, source });
    refreshPresetCapabilities();
    // A 4 Hz cursor sample is live state, not history: the host asks for `record:false` so no
    // coordinate trail accumulates in the idle-event buffer.
    if (record !== false) recordIdleEvent('avatar.attention', { ...attention });
    return { ok: true, code: null, attention };
  }

  /** Hard output gate (privacy lock / component close / model switch): old frames are dropped. */
  function lock(reason = 'privacy') {
    return setMotionEnabled(false, { reason });
  }

  function unlock() {
    return setMotionEnabled(true, { reason: 'unlock' });
  }

  /**
   * True while a mouth is actually moving. An envelope speech keeps `turn.speaking` true for the
   * whole line (+release); a live sender only counts within `idleSpeechHoldMs` of its last write,
   * so a single static mouth value does not freeze the body forever.
   */
  function mouthActiveForIdle(at, snap) {
    const mouth = snap.mouth ?? {};
    if (snap.turn?.speaking === true && mouth.mode === 'envelope') return true;
    return mouth.active === true && mouth.mode === 'live'
      && at - lastMouthActivityAt < host.idleSpeechHoldMs;
  }

  /**
   * True when the mouth writer owns `input` right now: while speaking, no idle/intent entry may
   * also write that input, so one input is never written twice in one frame (the mouth wins).
   */
  function isMouthOwnedInput(input) {
    if (state.mouthInput === null) return false;
    return String(input ?? '').toLowerCase() === String(state.mouthInput).toLowerCase();
  }

  /** Head angles share the "1 semantic unit = 30°" convention; all other channels stay normalized. */
  const HEAD_ANGLE_CHANNELS = new Set(['headX', 'headY', 'headZ']);

  /**
   * ONE semantic → input conversion for every writer. A head angle is converted through its own
   * range (degrees first), so a ±30 input is byte-identical to before while FaceAngleZ's real ±90
   * range no longer amplifies the roll 3×. Gaze / brow / eye / mouth / body keep `toInputValue`.
   */
  function writeInputValue(entry, channel, value) {
    return HEAD_ANGLE_CHANNELS.has(channel)
      ? toHeadInputValue(entry, value)
      : toInputValue(entry, value, { bidirectional: isBidirectional(channel) });
  }

  /**
   * The floor is opt-out, not opt-in: `idleSwayScale: 0`, `idleAmplitude: 0` or `idleMaxStep: 0`
   * each mean "this runtime must not move on its own". A channel whose own `gain` or style
   * amplitude is zero is equally off: zero amplitude IS a legal stationary pose, never "frozen".
   */
  function idleFloorEnabled(item = null, snap = null) {
    if (!(host.idleAmplitude > 0 && host.idleMaxStep > 0 && host.idleSwayScale > 0)) return false;
    if (item === null) return true;
    const gain = item.gain === null ? host.idleParamGain : item.gain;
    if (!(gain > 0)) return false;
    return styleChannelAmplitude(snap?.style?.effective ?? null, item.channel) > 0;
  }

  /** Semantic cap this head channel is allowed to reach (the same cap idleWriteValue clamps to). */
  function idleFloorCap(item) {
    const alive = idlePool.aliveChannel === item.channel ? ALIVE_FALLBACK_GAIN : 1;
    return host.idleAmplitude * alive;
  }

  /**
   * One minimal nudge, never larger than what is left before the channel cap and never larger
   * than `idleMaxStep`. A channel already on its cap has zero remaining amplitude: no nudge.
   */
  function idleFloorStepFor(item) {
    const previous = Math.abs(idleLastValue.get(item.channel) ?? 0);
    const remaining = Math.max(0, idleFloorCap(item) - previous);
    return Math.min(host.idleMaxStep, IDLE_FLOOR_STEP_RATIO * host.idleAmplitude, remaining);
  }

  /**
   * True while the controller is explicitly holding a posture. In that window the floor may only
   * fine-tune by IDLE_FLOOR_STEP_RATIO (15%) of the channel amplitude, which is exactly the step
   * bound above; a hold is never replaced by a floor value.
   */
  function postureHoldActive(at, snap) {
    const motion = snap?.motion ?? {};
    return Number.isFinite(motion.holdUntil) && motion.holdUntil > at
      && Number.isFinite(motion.postureHolds) && motion.postureHolds > 0;
  }

  /** Report a floor that was due but skipped because the channel has no amplitude (throttled). */
  function noteIdleFloorSkipped(reason, channel, at) {
    idleFloor.skipped += 1;
    if (at - idleFloor.skippedAt < IDLE_FLOOR_LOG_MS) return;
    idleFloor.skippedAt = at;
    recordIdleEvent('avatar.idle.motion-floor.skipped', { reason, channel, amplitude: 0 });
  }

  /**
   * Style-scaled write cap for the P-139 posture. At the normal persona (amplitude ≤ 1) this is
   * exactly 1, so the configured idleAmplitude/idleMaxStep stay unchanged. A lively persona may
   * reach the larger posture it drew; without this the old ±5.4° cap would truncate the goal.
   */
  function postureWriteScale(snap) {
    const amplitude = Math.max(0.2, Math.min(1.5, finite(snap?.style?.baseline?.amplitude, 1)));
    return amplitude <= 1 ? 1 : Math.min(2.5, amplitude * amplitude * 1.08);
  }

  /**
   * Clamp one idle channel to its amplitude cap, then rate-limit it against the previous frame.
   * `scale` is the speech factor (1 when no mouth is active): speech reduces the amplitude, so the
   * amplitude cap and the idleMaxStep limiter still bound the written value exactly as before.
   * `writeScale` only widens both bounds for a lively posture goal (see postureWriteScale).
   */
  function idleWriteValue(item, raw, scale = 1, { allowFloor = false, writeScale = 1 } = {}) {
    const eye = item.channel === 'eyeOpenL' || item.channel === 'eyeOpenR';
    const gain = item.gain === null ? host.idleParamGain : item.gain;
    const grow = Math.max(1, finite(writeScale, 1));
    // Single taken-over channel: raise the micro-motion to a perceptible amplitude. The gain is
    // applied BEFORE the cap and the idleMaxStep limiter, so the motion grows, the jitter does not.
    const alive = idlePool.aliveChannel === item.channel ? ALIVE_FALLBACK_GAIN : 1;
    const amplitude = (eye
      ? Math.min(0.05, host.idleAmplitude / 4)
      : host.idleAmplitude * grow) * alive;
    const speechScale = Math.max(0, Math.min(1, finite(scale, 1)));
    let next = raw * gain * alive * speechScale;
    // Motion floor: replace a completely still curve with previous ± one minimal nudge. The step
    // was already bounded by the channel's remaining amplitude and idleMaxStep, and ONLY the
    // legacy idle path may apply it: the 30 Hz controller must be unaffected.
    if (allowFloor === true && idleFloor.target === item.channel) {
      const base = idleLastValue.get(item.channel) ?? (eye ? 1 : 0);
      next = base + idleFloor.sign * idleFloor.step;
    }
    const beforeCap = next;
    next = eye
      ? Math.min(1, Math.max(1 - amplitude, next))
      : Math.max(-amplitude, Math.min(amplitude, next));
    const previous = idleLastValue.get(item.channel) ?? (eye ? 1 : 0);
    const step = host.idleMaxStep * (eye ? 1 : grow);
    const bounded = step > 0
      ? previous + Math.max(-step, Math.min(step, next - previous))
      : next;
    if (Math.abs(bounded - previous) > IDLE_FLOOR_EPSILON) idleFloor.changed = true;
    idleLastValue.set(item.channel, bounded);
    // Evidence only: the value above IS the write, already capped and speech-scaled.
    noteActionWrite(item.channel, bounded, { speechScaled: speechScale < 1, limitHit: next !== beforeCap });
    return bounded;
  }

  /**
   * Intent channels are allowed a larger excursion than the idle amplitude cap (a nod must be
   * visible), but still a rate limit: one controller produces one final value per channel/frame.
   * Eye channels are unipolar ([0,1], 1 = fully open): they keep their full range and their neutral
   * baseline of 1, so a surprise can widen the eye instead of accidentally drooping it.
   */
  function intentWriteValue(channel, raw) {
    const eye = channel === 'eyeOpenL' || channel === 'eyeOpenR';
    const limit = channel === 'gazeX' || channel === 'gazeY' ? 1 : 0.8;
    const rawValue = finite(raw, eye ? 1 : 0);
    const next = eye
      ? clamp01(rawValue)
      : Math.max(-limit, Math.min(limit, rawValue));
    const previous = idleLastValue.get(channel) ?? (eye ? 1 : 0);
    const step = Math.max(host.idleMaxStep, 0.2);
    const bounded = previous + Math.max(-step, Math.min(step, next - previous));
    // An explicit gesture already moves the frame: it also counts as motion for the floor.
    if (Math.abs(bounded - previous) > IDLE_FLOOR_EPSILON) idleFloor.changed = true;
    const value = eye ? clamp01(bounded) : bounded;
    // Expression release: the inner runtime records the value this frame really sends and decides
    // whether the channel is back at the baseline; a timed-out release replaces it with one forced 0.
    const written = inner.settleReleaseWrite(channel, value);
    if (written !== value) idleFloor.changed = true;
    idleLastValue.set(channel, eye ? clamp01(written) : written);
    // Evidence only: this is the semantic value the transport receives (the ±0.8 / ±1 cap applied).
    noteActionWrite(channel, written, { limitHit: next !== rawValue });
    return written;
  }

  /** Channels the active preset trajectories asked the ONE writer to flush this frame. */
  function presetRequestedChannels(snap) {
    const channels = [];
    for (const item of snap?.motion?.presets?.active ?? []) {
      for (const channel of item.channels ?? []) {
        if (!channels.includes(channel)) channels.push(channel);
      }
    }
    return channels;
  }

  /**
   * Why a requested preset channel did not become a transport row. The sender owns this verdict:
   * an unmapped/unverified binding, a mouth-owned input, or the one-writer-per-input rule.
   */
  function transportSkipReason(channel, { valueOf, speaking = false, writtenInputs = null }) {
    const idleOwned = IDLE_WRITE_CHANNELS.includes(channel);
    const intentOwned = INTENT_WRITE_CHANNELS.includes(channel);
    if (!idleOwned && !intentOwned) return 'not-in-write-set';
    if (!Number.isFinite(valueOf(channel))) return 'no-frame-value';
    const row = idleOwned ? idleParamMap.find((item) => item.channel === channel) : undefined;
    const binding = intentOwned ? channelState.bindings.get(channel) : undefined;
    const inputName = idleOwned ? (row?.inputName ?? '') : (binding?.inputName ?? '');
    if (idleOwned) {
      if (inputName === '') return channelState.unverified.includes(channel) ? 'unverified' : 'unmapped';
    } else if (binding?.verified !== true) {
      return binding === undefined ? 'unmapped' : 'unverified';
    }
    if (speaking && isMouthOwnedInput(inputName)) return 'mouth-owned';
    if (writtenInputs !== null && inputName !== '' && writtenInputs.has(inputName)) return 'shared-input';
    return 'not-written';
  }

  /**
   * Capture one send's identity and record `prepared` BEFORE the transport is called. The ticket
   * carries the connection generation/epoch and the preset action identity at assembly time, so a
   * later settle can be checked against exactly the send it belongs to. `prepared` is parameters
   * only: nothing here proves anything left the process.
   */
  function beginTransportEvidence(entries, snap, {
    valueOf, speaking = false, writtenInputs = null, at = null,
  } = {}) {
    const frameAt = Number.isFinite(at) ? at : clockNow();
    const ticket = {
      rows: entries.length,
      generation: state.generation,
      connectionGeneration: state.connectionGeneration,
      epoch: motionEpoch,
      at: frameAt,
      owners: null,
      presetChannels: null,
    };
    if (entries.length > 0) {
      transportEvidence.prepared += 1;
      transportEvidence.preparedRows += entries.length;
      transportEvidence.lastPreparedAt = frameAt;
    }
    const requested = presetRequestedChannels(snap);
    if (requested.length === 0) return ticket;
    const wanted = new Set(requested);
    const rows = [];
    const built = new Set();
    for (const entry of entries) {
      if (typeof entry?.channel !== 'string' || wanted.has(entry.channel) !== true) continue;
      if (!Number.isFinite(entry.value)) continue;
      rows.push({ channel: entry.channel, value: entry.value });
      built.add(entry.channel);
    }
    const skipped = [];
    for (const channel of requested) {
      if (built.has(channel)) continue;
      skipped.push({
        channel,
        reason: transportSkipReason(channel, { valueOf, speaking, writtenInputs }),
      });
    }
    ticket.presetChannels = wanted;
    // The action identity a late result is matched against: the live trajectory's start sequence
    // (its stable action id), its action generation, and the preset id it was drawn for.
    ticket.owners = (snap?.motion?.presets?.active ?? [])
      .filter((item) => (item.channels ?? []).some((channel) => wanted.has(channel)))
      .map((item) => ({ seq: item.seq, generation: item.generation, presetId: item.presetId }));
    inner.notePresetTransport({ phase: 'prepared', rows, skipped, at: frameAt });
    return ticket;
  }

  /** The subset of one send's rows that a preset actually asked for (empty = no preset evidence). */
  function presetRowsFor(ticket, rows) {
    const channels = ticket?.presetChannels;
    if (channels === null || channels === undefined) return [];
    const matched = [];
    for (const entry of Array.isArray(rows) ? rows : []) {
      if (typeof entry?.channel !== 'string' || channels.has(entry.channel) !== true) continue;
      if (!Number.isFinite(entry.value)) continue;
      matched.push({ channel: entry.channel, value: entry.value });
    }
    return matched;
  }

  /** True while the send's own connection generation/epoch is still the current one. */
  function sendStillCurrent(ticket) {
    return ticket !== null
      && state.disposed !== true
      && state.connected === true
      && state.generation === ticket.generation
      && state.connectionGeneration === ticket.connectionGeneration
      && motionEpoch === ticket.epoch;
  }

  /** The transport refused with `ok:false`; keep the transport code so `failed` names a cause. */
  function transportRejection(result, fallback) {
    const error = new Error(String(result?.reason ?? fallback));
    error.code = String(result?.code ?? AVATAR_ERROR_CODES.WRITE_FAILED);
    return error;
  }

  /** `attempted`: the transport call really started for these rows. Not an acknowledgement. */
  function noteTransportAttempted(ticket, rows = null, at = null) {
    if (ticket === null) return false;
    const sentRows = Array.isArray(rows) ? rows : [];
    if (sentRows.length === 0) return false;
    const now = Number.isFinite(at) ? at : clockNow();
    transportEvidence.attempted += 1;
    transportEvidence.attemptedRows += sentRows.length;
    transportEvidence.lastAttemptedAt = now;
    const presetRows = presetRowsFor(ticket, sentRows);
    if (presetRows.length > 0) {
      inner.notePresetTransport({
        phase: 'attempted', rows: presetRows, at: now, owners: ticket.owners,
      });
    }
    return true;
  }

  /**
   * `committed`: only after `ok:true`, and only while the send still belongs to its own connection
   * generation/epoch AND its preset action identity. A late result is discarded as stale and never
   * booked to the current (or any newer) action.
   */
  function noteTransportCommitted(ticket, rows = null, at = null) {
    if (ticket === null) return false;
    const sentRows = Array.isArray(rows) ? rows : [];
    const now = Number.isFinite(at) ? at : clockNow();
    if (sendStillCurrent(ticket) !== true) {
      noteTransportStale(ticket, sentRows, 'generation', now);
      return false;
    }
    const presetRows = presetRowsFor(ticket, sentRows);
    if (presetRows.length > 0) {
      const verdict = inner.notePresetTransport({
        phase: 'committed', rows: presetRows, at: now, owners: ticket.owners,
      });
      if (verdict?.stale === true) {
        // The controller already recorded the stale verdict for its trace; count it here as well.
        noteTransportStale(ticket, sentRows, verdict.reason || 'action-changed', now, { notifyPreset: false });
        return false;
      }
    }
    transportEvidence.committed += 1;
    transportEvidence.committedRows += sentRows.length;
    transportEvidence.lastCommittedAt = now;
    return true;
  }

  /** `failed`: `ok:false` or a thrown send. Never a commit, always carries the error code. */
  function noteTransportFailed(ticket, rows = null, error = null, at = null) {
    const sentRows = Array.isArray(rows) ? rows : [];
    const now = Number.isFinite(at) ? at : clockNow();
    const code = String(error?.code ?? error?.errorCode ?? AVATAR_ERROR_CODES.WRITE_FAILED);
    transportEvidence.failed += 1;
    transportEvidence.failedRows += sentRows.length;
    transportEvidence.lastFailedAt = now;
    transportEvidence.lastError = errorText(error);
    transportEvidence.lastErrorCode = code;
    const presetRows = presetRowsFor(ticket, sentRows);
    if (presetRows.length > 0) {
      inner.notePresetTransport({
        phase: 'failed',
        rows: presetRows,
        at: now,
        owners: ticket?.owners ?? null,
        error: { code, message: transportEvidence.lastError },
      });
    }
    return false;
  }

  /** `stale`: the result was discarded because its generation/action identity moved on. */
  function noteTransportStale(ticket, rows = null, reason = 'stale', at = null, { notifyPreset = true } = {}) {
    const sentRows = Array.isArray(rows) ? rows : [];
    const now = Number.isFinite(at) ? at : clockNow();
    transportEvidence.stale += 1;
    transportEvidence.staleRows += sentRows.length;
    transportEvidence.lastStaleAt = now;
    transportEvidence.lastStaleReason = String(reason ?? 'stale');
    if (notifyPreset !== true) return false;
    const presetRows = presetRowsFor(ticket, sentRows);
    if (presetRows.length > 0) {
      inner.notePresetTransport({
        phase: 'stale',
        rows: presetRows,
        at: now,
        owners: ticket?.owners ?? null,
        reason: transportEvidence.lastStaleReason,
      });
    }
    return false;
  }

  function recordIdleEvent(type, data = {}) {
    idleEvents.push({ type, at: clockNow(), ...data });
    while (idleEvents.length > 20) idleEvents.shift();
    appendLog('debug', type, { event: type, ...data });
  }

  // ---- per-action trace: evidence only, never a second writer ------------------------------
  /**
   * ONE `avatar.action.trace` per action, emitted only when the action ends. It chains the path by
   * `actionId` (the same id `avatar.action.start/end` carry) and reports the value this runtime
   * REALLY wrote on the action's own channels — taken after `idleWriteValue()`/`intentWriteValue()`,
   * so the amplitude cap, the eye clamp and the speech scale are already folded in.
   *
   *   channels    names actually written during the action (headX/headY/headZ/gazeX/gazeY/
   *               bodyX/bodyY/bodyZ/browL/browR)
   *   final       the value per channel the action actually REACHED (largest |written|, post
   *               limit/speech scale) — visibility evidence, immune to the 4 Hz flush sampling
   *   last        the literal last value written per channel (post limit / speech scale)
   *   amplitude   peak |semantic value| written, post-scale too (0 when nothing was written)
   *   suppressed  'none' | 'action-busy' | 'speech-damping' | 'limit' | 'mixed' (one per cause)
   *
   * Budgeted by action cadence (one per ended action), never per frame. This is bookkeeping only:
   * the writer path is untouched, so no amplitude/hold/transition behaviour can change here.
   */
  const TRACE_CHANNELS = Object.freeze([
    'headX', 'headY', 'headZ', 'gazeX', 'gazeY', 'bodyX', 'bodyY', 'bodyZ', 'browL', 'browR',
  ]);
  const TRACE_LIMIT = 5;
  const traceState = { current: null, recent: [] };

  /** The action's own channels: its gesture channels, else the idle-action targets it triggers. */
  function traceChannelsFor(name, info) {
    const declared = Array.isArray(info?.channels) ? info.channels : [];
    const fromInfo = declared.filter((channel) => TRACE_CHANNELS.includes(channel));
    if (fromInfo.length > 0) return fromInfo;
    const required = IDLE_ACTION_CHANNELS[String(name ?? '')]?.required ?? [];
    return required.filter((channel) => TRACE_CHANNELS.includes(channel));
  }

  /** Open the record for the action starting now; `release` carries its intent→boundary lineage. */
  function beginActionTrace(action, { release = null, info = null } = {}) {
    const trace = {
      channels: traceChannelsFor(action.name, info),
      written: new Set(),
      final: Object.create(null),
      last: Object.create(null),
      peak: 0,
      reasons: new Set(),
      event: String(release?.event ?? ''),
      stagedAt: Number.isFinite(release?.stagedAt) ? release.stagedAt : null,
      releasedBy: String(release?.releasedBy ?? 'candidate'),
      releasedAt: Number.isFinite(release?.releasedAt) ? release.releasedAt : action.startedAt,
    };
    if (release?.actionBusy === true) trace.reasons.add('action-busy');
    action.trace = trace;
    traceState.current = trace;
    return trace;
  }

  /** Remember what the ONE writer just put on the transport: no write happens here. */
  function noteActionWrite(channel, value, { speechScaled = false, limitHit = false } = {}) {
    const trace = traceState.current;
    if (trace === null || trace.channels.includes(channel) !== true) return;
    if (!Number.isFinite(value)) return;
    trace.written.add(channel);
    // `last` is the literal last write; `final` keeps the value the action actually REACHED (the
    // largest |value| written this action). The 4 Hz idle flush can sample only the shoulders of
    // the envelope, so the literal last write of a fading gesture is tiny and would understate a
    // perfectly visible motion. Keeping the extreme makes the trace usable as visibility evidence.
    trace.last[channel] = value;
    if (Math.abs(value) >= Math.abs(finite(trace.final[channel], 0))) trace.final[channel] = value;
    trace.peak = Math.max(trace.peak, Math.abs(value));
    if (speechScaled) trace.reasons.add('speech-damping');
    if (limitHit) trace.reasons.add('limit');
  }

  /** Close the record, emit the one event, and keep the last 5 for the read-only status view. */
  function finishActionTrace(action, at) {
    const trace = action?.trace ?? null;
    if (trace === null || trace === undefined) return null;
    if (traceState.current === trace) traceState.current = null;
    const reasons = [...trace.reasons];
    const record = {
      actionId: action.actionId,
      intent: action.name,
      event: trace.event,
      stagedAt: trace.stagedAt,
      releasedBy: trace.releasedBy,
      releasedAt: trace.releasedAt,
      startedAt: action.startedAt,
      durationMs: action.durationMs,
      amplitude: trace.peak,
      channels: TRACE_CHANNELS.filter((channel) => trace.written.has(channel)),
      final: { ...trace.final },
      last: { ...trace.last },
      suppressed: reasons.length === 0 ? 'none' : reasons.length === 1 ? reasons[0] : 'mixed',
    };
    traceState.recent.push(record);
    while (traceState.recent.length > TRACE_LIMIT) traceState.recent.shift();
    recordIdleEvent('avatar.action.trace', { ...record, at });
    return record;
  }

  // ---- discrete actions: serial, speech-neutral ------------------------------------------
  /** Start one candidate. The caller has already proved that no action is running. */
  function startAction(item, at, {
    deliver = true, actionId = null, intentDurationMs = null, intentInfo = null, release = null,
  } = {}) {
    actionState.seq += 1;
    // A staged communication intent already reserved its ticket, so its action carries that id.
    const id = Number.isInteger(actionId) ? actionId : actionState.seq;
    const timed = Number.isFinite(intentDurationMs) && intentDurationMs > 0;
    const actionDuration = timed ? intentDurationMs : host.actionDurationMs;
    // A fresh action samples no observation of its own: id, scheduling time and the bounded
    // fallback are facts; only a still-running matching animation may retime it from its own clock.
    actionState.current = {
      actionId: id,
      name: item.name,
      seq: actionState.seq,
      startedAt: at,
      durationMs: actionDuration,
      endsAt: at + actionDuration,
      estimated: true,
      durationSource: timed ? 'intent' : 'fallback',
      animationStartedAt: null,
      capped: false,
      /** P-139 identity: the interrupt counter in force when this action began. */
      interruptSeq: intentState.interruptSeq,
      replyId: null,
    };
    beginActionTrace(actionState.current, { release, info: intentInfo });
    applyActionCap(actionState.current);
    staleAnimationKey = null;
    ignoredAnimationActionId = 0;
    // The Start event normally lands just AFTER the host triggered the hotkey. Prefer that REAL
    // length and start when it is still running; `adoptAnimation` refuses one that began before
    // this action's trigger (the previous action's animation) and records it as stale.
    const animation = currentAnimation();
    if (animation !== null && animation.durationMs > 0 && animationMatches(item.name, animation)) {
      const animationStartedAt = Number.isFinite(animation.startedAt) ? animation.startedAt : at;
      if (animationStartedAt + boundedAnimationDuration(animation.durationMs) > at) {
        adoptAnimation(animation);
      }
    }
    const durationMs = actionState.current.durationMs;
    const estimated = actionState.current.estimated !== false;
    const durationSource = actionState.current.durationSource;
    // One delivery record per STARTED action: the host triggers the preset exactly once. A degraded
    // action is executed by this runtime (single channel), so the host is never asked for it.
    if (deliver === true) {
      actionState.delivered.push({
        name: item.name,
        actionId: id,
        at: Number.isFinite(item.at) ? item.at : at,
        startedAt: at,
        endsAt: actionState.current.endsAt,
        durationMs,
        estimated,
        durationSource,
        seq: id,
      });
      while (actionState.delivered.length > 8) actionState.delivered.shift();
    }
    actionState.started += 1;
    recordIdleEvent('avatar.action.start', {
      name: item.name,
      action: item.action ?? item.name,
      degraded: item.degraded === true,
      seq: id,
      actionId: id,
      startedAt: at,
      endsAt: actionState.current.endsAt,
      durationMs,
      estimated,
      durationSource,
      at,
    });
  }

  /** End the running action. `avatar.action.interrupted` is only ever recorded for a real cut. */
  function endAction(at, { interrupted = false, by = '' } = {}) {
    const current = actionState.current;
    if (current === null) return false;
    actionState.current = null;
    actionState.ended += 1;
    recordIdleEvent('avatar.action.end', { name: current.name, actionId: current.actionId, interrupted, by, at });
    // Exactly one trace per ended action, after the writer has already settled this action's frame.
    finishActionTrace(current, at);
    if (interrupted === true) {
      actionState.interrupted += 1;
      recordIdleEvent('avatar.action.interrupted', { by: String(by ?? 'interrupt'), at });
    }
    return true;
  }

  /**
   * Advance the serial scheduler. Speaking is intentionally NOT consulted: speech only drives the
   * mouth (and a temporary style scale), never the action rhythm. A candidate picked by the core
   * waits in the single slot until the running action ends, then starts at that moment — unless a
   * clip is playing, in which case it waits for the next sentence boundary reported by
   * `speechClip('start')` and is never dropped into the middle of a sentence.
   */
  function stepActions(at) {
    for (const item of inner.takeActions()) {
      const plan = idlePool.plans.get(item.name) ?? { mode: 'complete' };
      // A mapping change can remove an action between sampling and this frame; never replay it.
      if (plan.mode === 'dropped') continue;
      actionState.waiting.push(plan.mode === 'degraded'
        ? { ...item, action: item.name, name: plan.intentKind, channel: plan.channel, degraded: true }
        : item);
      if (actionState.waiting.length > 1) {
        actionState.waiting.shift();
        actionState.dropped += 1;
      }
    }
    if (actionState.current !== null) {
      // Keep polling the transport while the action runs: a host that only exposes
      // `getAnimation()` may publish a Start after the estimate was adopted, and a LATER Start of
      // the same action must recompute `endsAt` instead of being ignored as "already bound".
      adoptAnimation(currentAnimation());
      const current = actionState.current;
      if (at < actionEndsAt(current)) return;
      // The ceiling was hit before the declared end: the action is force-ended, not extended.
      if (current.capped === true) {
        recordIdleEvent('avatar.action.forced-end', {
          actionId: current.actionId,
          name: current.name,
          reason: 'max-duration',
          startedAt: current.startedAt,
          endsAt: actionEndsAt(current),
          maxActionMs: host.maxActionMs,
          at,
        });
      }
      endAction(at, { interrupted: false });
    }
    // No open speech session means there is no boundary left to wait for: a staged event that was
    // waiting for the next clip starts now instead of being stranded when the host stops reporting.
    // The answer's opening intent is the exception: without a clip there is no "first body start",
    // so its moment is gone and it is reported as expired, never started outside the answer.
    // This runs AFTER the action-end check above, so an ending action does not defer it by a tick.
    if (intentState.pending !== null && clipState.session !== true) {
      if (intentState.pending.event === 'answer-start') {
        dropPendingIntent('expired', { by: 'no-session', at, intentLabel: 'answer-start' });
      } else {
        releaseIntent(at, 'no-session');
      }
    }
    // Mid-sentence or between clips: keep the single waiting candidate; a clip start releases it.
    if (clipState.active === true || clipState.awaitingStart === true) return;
    // A released communication intent already owns the one action slot; never start a second.
    if (actionState.current !== null) return;
    startWaitingCandidate(at);
  }

  /** Record the sentence-boundary time point for the action that just started. */
  function recordActionTimed(at) {
    const current = actionState.current;
    if (current === null) return;
    clipState.timed += 1;
    recordIdleEvent('avatar.action.timed', {
      actionId: current.actionId,
      at,
      clipIndex: clipState.index,
      reason: 'sentence-start',
    });
  }

  /**
   * Start the one waiting candidate. `at` is the time point the action is anchored to: the tick
   * clock for a normal idle start, or the clip start for a sentence boundary. The action's own
   * clock always advances from that same point.
   *
   * The candidate counters are separate from the staged-intent ones: `recordActionTimed` counts a
   * candidate released at a clip start (`candidate.timed`, legacy `speech.clip.timed`), and every
   * other waiting-candidate start counts `candidate.other`. Neither ever counts an intent release.
   */
  function startWaitingCandidate(at, { timed = false } = {}) {
    if (actionState.waiting.length === 0) return null;
    const next = actionState.waiting.shift();
    const release = { releasedBy: 'candidate', releasedAt: at };
    let started = false;
    if (next.degraded !== true) {
      startAction(next, at, { release });
      started = true;
    } else if (state.connected === true) {
      // Partial channels: run the equivalent single-channel gesture HERE instead of asking the host
      // for a hotkey this model may not have (that request used to be skipped every interval).
      const submitted = intent(next.name, { channels: [next.channel] });
      if (submitted.ok === true) {
        startAction(next, at, { deliver: false, intentInfo: submitted, release });
        started = true;
      }
    }
    if (timed === true && started === true) recordActionTimed(at);
    else if (started === true) clipState.candidateOther += 1;
    return started ? actionState.current : null;
  }

  // ---- breath: verified-only, never a guessed parameter ------------------------------------
  /**
   * Breath has no dedicated idle channel on purpose: it is an independent generator, and the
   * runtime writes it only when discovery (or an acknowledged explicit probe) verified a mapping.
   * With no verified channel NOTHING is written — the frame stays exactly as before and the skip is
   * reported once per window instead of pretending the model breathes.
   */
  const breathStats = { writes: 0, skipped: 0, lastAt: null, lastSkipAt: Number.NEGATIVE_INFINITY };
  function breathBinding() {
    const binding = channelState.bindings.get('breath');
    return binding?.verified === true && binding.inputName !== '' ? binding : null;
  }
  /** `avatar.breath.skipped` is throttled: an idle tick must not flood the event stream. */
  function noteBreathChannel(at) {
    if (breathBinding() !== null) return false;
    if (at - breathStats.lastSkipAt < 5000) return false;
    breathStats.lastSkipAt = at;
    breathStats.skipped += 1;
    recordIdleEvent('avatar.breath.skipped', { reason: 'no-verified-channel', at });
    return true;
  }
  /** One breath row for the current frame, or null when breath has no verified channel. */
  function breathEntry(raw, at) {
    const binding = breathBinding();
    if (binding === null || isMouthOwnedInput(binding.inputName)) return null;
    const value = clamp01(Number.isFinite(Number(raw)) ? Number(raw) : 0.5);
    return {
      input: binding.inputName,
      value: toInputValue(binding, value, { bidirectional: false }),
      channel: 'breath',
    };
  }
  /** Count a breath row only when its frame really settled, so the counter means "writes sent". */
  function countBreathEntries(entries, at) {
    if (!entries.some((entry) => entry.channel === 'breath')) return;
    breathStats.writes += 1;
    breathStats.lastAt = at;
  }

  // ---- sentence-level action timing ---------------------------------------------------------
  /**
   * Report one playback clip boundary. This is the ONLY time source for a sentence-level action
   * timing: the host forwards the real audio start/end of each spoken sentence instead of the
   * runtime starting a timer and guessing where the sentence boundaries are.
   *
   * `start` is also the one moment a held action may begin. While a clip is active, the single
   * waiting candidate is kept (never queued) and released at the next start; `end` only marks the
   * pause, so no action is dropped into the middle of a sentence.
   */
  function speechClip(event, { index = null, at = null, anchor = null } = {}) {
    if (state.disposed) return disposedResult();
    const phase = String(event ?? '');
    const time = Number.isFinite(at) ? at : clockNow();
    if (phase === 'start') {
      // A new speech session restarts the sentence identity: a host may reuse clip index 0 for the
      // next reply, so the previous reply's "already served" clip must not block its head intent.
      const newSession = clipState.session !== true;
      if (newSession === true) intentState.servedClip = -1;
      clipState.session = true;
      clipState.active = true;
      clipState.awaitingStart = false;
      clipState.starts += 1;
      clipState.index = Number.isInteger(index) ? index : clipState.index + 1;
      clipState.startedAt = time;
      // P-139 stage 2 P1: the anchor is the transport's real start callback. `first-data` is the
      // closest evidence the streamed transport can give; neither it nor `player-ready` is a
      // measured speaker sample, so the source is recorded instead of pretending precision.
      clipState.anchor = typeof anchor === 'string' && anchor.length > 0 ? anchor : null;
      recordIdleEvent('avatar.speech.anchor', {
        index: clipState.index, at: time, anchor: clipState.anchor,
      });
      // The sentence boundary is the ONE release point for a staged communication intent. At most
      // one intent starts per clip, and an action still running simply defers it to the next clip —
      // EXCEPT the answer's opening intent, which was staged for THIS boundary and never waits.
      const opening = intentState.pending !== null && intentState.pending.event === 'answer-start'
        && intentState.pending.holdForClipStart === true;
      if (opening === true) releaseAnswerStartAtClipStart(time);
      else if (intentState.servedClip !== clipState.index) releaseIntent(time, 'sentence-start');
      // A sentence gap is a REAL playback boundary: only here may the executor draw a
      // `sentence-gap` preset. It is skipped when a staged intent already owns this boundary or an
      // action is still running, so two gestures never overlap.
      if (presetExecution === true && intentState.pending === null && actionState.current === null
        && clipState.starts > 1) {
        const controlled = statusChannels().controlled;
        const attention = inner.snapshot().motion?.attention ?? null;
        const drawn = inner.preset({
          state: 'speaking',
          event: 'sentence-gap',
          at: time,
          verifiedChannels: controlled,
          targetVerified: attention?.verified === true && attention?.mode === 'user',
          directionVerified: attentionDirectionVerified === true,
          seed: `gap:${clipState.index}:${clipState.starts}`,
        });
        if (drawn.started === true) {
          startAction({ name: drawn.presetId }, time, {
            deliver: false,
            intentDurationMs: drawn.durationMs,
            intentInfo: drawn,
            release: { event: 'sentence-gap', releasedBy: 'sentence-start', releasedAt: time },
          });
          Object.assign(actionState.current, {
            event: 'sentence-gap',
            presetId: drawn.presetId,
            /** Controller-side identity of the live trajectory (takeover lookup). */
            presetActionId: drawn.actionId ?? null,
            presetOperations: [...drawn.operations],
          });
          recordIdleEvent('avatar.preset.action', {
            presetId: drawn.presetId, event: 'sentence-gap', operations: [...drawn.operations], at: time,
          });
        }
      }
      // Sentence boundary: release the held candidate exactly here, never on a mid-sentence tick.
      if (actionState.current === null) startWaitingCandidate(time, { timed: true });
      return {
        ok: true,
        code: null,
        phase,
        active: true,
        clipIndex: clipState.index,
        at: time,
        anchor: clipState.anchor,
        actionId: actionState.current?.actionId ?? null,
      };
    }
    if (phase === 'end') {
      clipState.active = false;
      clipState.awaitingStart = clipState.session === true;
      clipState.ends += 1;
      clipState.endedAt = time;
      return { ok: true, code: null, phase, active: false, clipIndex: clipState.index, at: time, anchor: clipState.anchor };
    }
    return {
      ok: false,
      code: 'INVALID_ARGUMENT',
      reason: 'speechClip() needs "start" or "end"',
      phase,
    };
  }

  /**
   * Close the speech session. A clip end alone only proves an inter-sentence pause, so the host
   * calls this when the whole reply/clip queue is finished; the next tick resumes the idle rhythm.
   */
  function speechEnd({ at = null } = {}) {
    if (state.disposed) return disposedResult();
    const time = Number.isFinite(at) ? at : clockNow();
    const wasOpen = clipState.session;
    // The end of the queue is still a boundary: a staged intent may start there before the
    // session closes (answer-end's `settle` lands here when no further clip follows). A missed
    // answer-start is the exception: speech end is NOT its boundary, and the host has already
    // moved the status out of `speaking`, so it is expired here instead of executed in the wrong
    // state (that delayed release was the reported `no-candidate`).
    if (intentState.pending !== null && intentState.pending.event === 'answer-start') {
      dropPendingIntent('expired', { by: 'speech-end', at: time, intentLabel: 'answer-start' });
    } else if (intentState.pending !== null) {
      releaseIntent(time, 'speech-end');
    }
    clipState.session = false;
    clipState.active = false;
    clipState.awaitingStart = false;
    clipState.anchor = null;
    // The next reply starts a fresh sentence identity (its first clip may reuse index 0).
    intentState.servedClip = -1;
    return {
      ok: true,
      code: null,
      wasOpen,
      at: time,
      clips: { starts: clipState.starts, ends: clipState.ends, timed: clipState.timed },
    };
  }

  // ---- communication events → sentence-level intents (P-139 stage 2) -----------------------
  /** Drop the one staged intent with an explicit reason; nothing is ever silently forgotten. */
  function dropPendingIntent(reason, { by = '', at = clockNow(), intentLabel = null } = {}) {
    const pending = intentState.pending;
    if (pending === null) return null;
    intentState.pending = null;
    intentState.pendingSince = null;
    intentState.dropped += 1;
    recordIdleEvent('avatar.intent.dropped', {
      reason,
      event: pending.event,
      /** The mapped gesture (`nod`); the timing contract can name the phase instead. */
      intent: intentLabel ?? pending.intent,
      mapped: pending.intent,
      actionId: pending.ticket,
      generation: pending.generation,
      by,
      at,
    });
    return pending;
  }

  /**
   * The takeover request for the answer's opening gesture, or `null` when nothing owns the pose.
   *
   * Item 5: a pre-answer action (thinking / listening / idle draw) may still own the pose at the
   * first body clip's start. Waiting for it would move the gesture past its own moment, so the
   * request is handed to the executor, which decides IMMEDIATELY — it never waits for that action
   * to end. The executor refuses an explicit owner, a transition outside the short window or a
   * channel set it cannot split; the caller then drops the opening gesture with
   * `takeover-unavailable` and nothing is queued.
   */
  function answerStartTakeover() {
    const current = actionState.current;
    if (current === null) return null;
    return {
      /** Controller-side identity of the live trajectory this action was started from. */
      actionId: current.presetActionId ?? null,
      action: current.presetId ?? current.name,
      /** `null` marks a non-preset action: an explicit gesture the executor must never displace. */
      preset: current.presetId ?? null,
      event: String(current.event ?? ''),
    };
  }

  /**
   * Release the opening intent of an answer at the first body clip's real start. The generic
   * boundary release may defer a busy action or skip an already-served clip index, which used to
   * leave the intent pending until `speechEnd` — after the host had already moved the status out
   * of `speaking`, so every answer-start recipe (states=speaking) held with `no-candidate`.
   * This boundary owns the intent: it starts here or it is dropped here, never later.
   */
  function releaseAnswerStartAtClipStart(at) {
    const pending = intentState.pending;
    if (pending === null || pending.event !== 'answer-start') return null;
    pending.holdForClipStart = false;
    if (pending.generation !== intentState.generation) {
      dropPendingIntent('expired', { by: 'clip-start', at, intentLabel: 'answer-start' });
      return { ok: false, code: null, released: false, dropped: true, reason: 'expired' };
    }
    // Without preset execution there is no channel arbitration to run: a busy boundary stays the
    // legacy miss, byte for byte. With it, the opening gesture may take over instead (item 5).
    const takeover = presetExecution === true ? answerStartTakeover() : null;
    if (takeover === null && actionState.current !== null) {
      dropPendingIntent('missed', { by: 'clip-start', at, intentLabel: 'answer-start' });
      return { ok: false, code: null, released: false, dropped: true, reason: 'missed' };
    }
    const released = releaseIntent(at, 'sentence-start', { takeover });
    if (released.released !== true && released.dropped !== true) {
      // It stayed pending (an unexpected gate): never let it wait for speechEnd.
      dropPendingIntent('missed', { by: 'clip-start', at, intentLabel: 'answer-start' });
      return { ok: false, code: null, released: false, dropped: true, reason: 'missed' };
    }
    return released;
  }

  /**
   * Drop the answer's opening intent without a boundary (the first body clip was cancelled, its
   * turn expired or its clip start never arrived). Reported once; never retried at speechEnd.
   */
  function dropAnswerStart(reason = 'cancelled', { at = null } = {}) {
    if (state.disposed) return disposedResult();
    const time = Number.isFinite(at) ? at : clockNow();
    const why = reason === 'missed' || reason === 'expired' ? reason : 'cancelled';
    const pending = intentState.pending;
    if (pending === null || pending.event !== 'answer-start') {
      recordIdleEvent('avatar.intent.dropped', {
        intent: 'answer-start', event: 'answer-start', reason: why, by: 'host', at: time,
      });
      return { ok: true, dropped: false, reason: why };
    }
    pending.holdForClipStart = false;
    dropPendingIntent(why, { by: 'host', at: time, intentLabel: 'answer-start' });
    return { ok: true, dropped: true, reason: why };
  }

  /**
   * Stop every intent of the current generation. A turn/session switch, lock, disconnect, model
   * switch and dispose all pass through here, so no staged intent can be released later and no
   * running action survives into the next generation. `clearClip` additionally forgets the old
   * turn's sentence boundaries; a soft barge-in keeps them (the host may still report the next one).
   * The core's one-shot trajectories are stopped HERE, not left running out their remaining time:
   * an old tilt must not keep adding to the same axis target as a new gesture of the next one.
   */
  function invalidateIntents(reason, { at = clockNow(), interrupted = false, clearClip = false, hard = false, endRunning = true } = {}) {
    const staleGeneration = intentState.generation;
    // A turn/session switch expires the answer's opening intent (its boundary belongs to the old
    // answer); every other staged phase keeps the historical `stale-generation` reason.
    if (intentState.pending?.event === 'answer-start') {
      dropPendingIntent('expired', { by: reason, at, intentLabel: 'answer-start' });
    } else {
      dropPendingIntent('stale-generation', { by: reason, at });
    }
    intentState.generation += 1;
    intentState.servedClip = -1;
    // A generation switch breaks any run of conclusions: the next turn may mark its own.
    intentState.lastIntentProfile = null;
    // Only the generation that is being replaced is cleared; anything started after this call is
    // tagged with the new generation and is never touched by this invalidation.
    inner.clearIntents({ reason, throughGeneration: staleGeneration, at });
    // A same-reply turn continuation keeps the running gesture (it is this reply's gesture) and
    // only advances the generation, so the old staged intent can never start later. Every real
    // switch still ends it here.
    if (endRunning !== false && actionState.current !== null) endAction(at, { interrupted, by: reason });
    actionState.waiting.length = 0;
    if (clearClip === true) {
      clipState.session = false;
      clipState.active = false;
      clipState.awaitingStart = false;
      clipState.anchor = null;
    }
    // A turn/session switch must stop the old generation's writes NOW, not at the next fade: the
    // output epoch invalidates every staged/slow frame, exactly like a lock or model switch.
    if (hard === true) bumpMotionEpoch(`intent:${reason}`);
  }

  /**
   * Release the staged intent. This is the ONE place a communication intent becomes an action, so
   * the generation check and the one-action rule are not duplicated per event. It runs only at a
   * sentence boundary (clip start / head window / speech end); an action already running defers the
   * intent to the next boundary instead of cutting it.
   */
  function releaseIntent(at, reason = 'sentence-start', { takeover = null } = {}) {
    const pending = intentState.pending;
    if (pending === null) return { ok: true, code: null, released: false, dropped: false };
    if (pending.generation !== intentState.generation) {
      dropPendingIntent('stale-generation', { by: reason, at });
      return { ok: false, code: 'STALE_INTENT', released: false, dropped: true, reason: 'stale-generation' };
    }
    if (actionState.current !== null && takeover === null) {
      // A deferral is a RELEASE PATH that did not release: count it as "other", remember it on the
      // staged intent so the eventual action's trace can name `action-busy`, and keep the ticket.
      intentState.releasedOther += 1;
      pending.deferredByActionBusy = true;
      return { ok: true, code: null, released: false, dropped: false, deferred: true, reason: 'action-busy' };
    }
    intentState.pending = null;
    intentState.pendingSince = null;
    // At most one intent per sentence: a second event inside the same clip waits for the next one.
    intentState.servedClip = clipState.index;
    const actionId = pending.ticket;
    intentState.lastIntent = pending.intent;
    intentState.lastActionId = actionId;
    // ---- preset execution branch -------------------------------------------------------
    // The preset library is executed as its own symbolic trajectory. The four legacy intents are
    // NOT consulted here: the event name picks the preset event and the executor consumes the
    // selected operation list in order.
    if (presetExecution === true) {
      const presetEvent = PRESET_EVENT_FOR_PHASE[pending.event] ?? pending.event;
      const snap = inner.snapshot();
      const presetState = pending.event === 'answer-end' || pending.event === 'idle'
        ? 'idle' : (snap.status ?? 'idle');
      const controlled = statusChannels().controlled;
      const attention = snap.motion?.attention ?? null;
      const targetVerified = attention?.verified === true && attention?.mode === 'user'
        && (controlled.includes('gazeX') || controlled.includes('gazeY'));
      // One preset trajectory at a time: an autonomous idle draw already in flight owns the pose
      // until it ends, so this boundary holds instead of stacking a second choreography. A
      // TAKEOVER is exactly the other case: the executor arbitrates the conflict itself, so this
      // boundary must not hold — waiting here would delay the gesture past its own moment.
      const presetBusy = takeover === null && (snap.motion?.presets?.active?.length ?? 0) > 0;
      // Observability only: the host itself decided this boundary holds (another preset owns the
      // pose). It reports the skip through the controller and draws nothing.
      if (presetBusy) inner.notePresetSkip('busy', { event: presetEvent, at });
      const drawn = presetBusy
        ? { started: false, trace: { output: { reason: 'preset-busy' }, selection: { reasons: ['preset-busy'] } } }
        : inner.preset({
          state: presetState,
          event: presetEvent,
          at,
          verifiedChannels: controlled,
          targetVerified,
          directionVerified: attentionDirectionVerified === true,
          generation: pending.generation,
          seed: `intent:${pending.ticket}:${pending.event}`,
          takeover,
        });
      if (takeover !== null && drawn.started !== true && drawn.reason === 'takeover-unavailable') {
        // Arbitration refused: nothing was displaced and nothing is queued. The opening gesture is
        // dropped HERE, at its own boundary, and can never be made up later.
        intentState.dropped += 1;
        recordIdleEvent('avatar.intent.dropped', {
          reason: 'takeover-unavailable',
          event: pending.event,
          /** The boundary contract names the phase, exactly like `dropPendingIntent`. */
          intent: pending.event === 'answer-start' ? 'answer-start' : pending.intent,
          mapped: pending.intent,
          actionId,
          generation: pending.generation,
          by: reason,
          takeover: drawn.takeover ?? null,
          at,
        });
        return {
          ok: false, code: null, intent: pending.intent, actionId, released: false, dropped: true,
          reason: 'takeover-unavailable', takeover: drawn.takeover ?? null,
        };
      }
      // Release-path evidence is identical for a preset: a real gesture released at a clip start
      // is a clip-start release, every other path is "other". An unselected hold is neither.
      if (reason === 'sentence-start' && clipState.active === true) intentState.releasedAtClipStart += 1;
      else intentState.releasedOther += 1;
      if (drawn.started === true) {
        intentState.lastIntent = drawn.presetId;
        intentState.started += 1;
        intentState.lastIntentProfile = null;
        // A successful takeover hands the serial slot over: the displaced action's record ends WITH
        // a reason, while its motion is not cut — the executor keeps its kept channels and
        // cross-fades the shared ones out over the takeover window.
        if (takeover !== null && drawn.takeover?.ok === true && actionState.current !== null) {
          endAction(at, {
            interrupted: (drawn.takeover.yieldedChannels ?? []).length > 0,
            by: 'takeover',
          });
        }
        startAction({ name: drawn.presetId }, at, {
          deliver: false,
          actionId,
          intentDurationMs: drawn.durationMs,
          intentInfo: drawn,
          release: {
            event: pending.event,
            stagedAt: Number.isFinite(pending.pendingSince) ? pending.pendingSince : pending.at,
            releasedBy: reason,
            releasedAt: at,
            actionBusy: pending.deferredByActionBusy === true,
          },
        });
        Object.assign(actionState.current, {
          intentGeneration: pending.generation,
          sessionId: pending.sessionId,
          turnId: pending.turnId,
          replyId: pending.replyId ?? null,
          event: pending.event,
          profile: null,
          presetId: drawn.presetId,
          /** Controller-side identity of the live trajectory (the takeover lookup uses it). */
          presetActionId: drawn.actionId ?? null,
          presetOperations: [...drawn.operations],
        });
        recordIdleEvent('avatar.preset.action', {
          actionId,
          presetId: drawn.presetId,
          operations: [...drawn.operations],
          channels: [...drawn.channels],
          event: pending.event,
          at,
        });
        return {
          ok: true, code: null, intent: 'preset', presetId: drawn.presetId, actionId,
          released: true, dropped: false, durationMs: drawn.durationMs,
          channels: [...drawn.channels], operations: [...drawn.operations],
          takeover: drawn.takeover ?? null,
        };
      }
      // The selector held: keep the current posture, write no preset channel, and say why.
      intentState.lastIntent = 'hold';
      recordIdleEvent('avatar.preset.hold', {
        actionId,
        event: pending.event,
        reason: drawn.trace?.output?.reason ?? 'hold',
        trace: drawn.trace?.selection?.reasons ?? [],
        at,
      });
      return {
        ok: true, code: null, intent: 'hold', actionId, released: true, dropped: false,
        reason: 'preset-hold', trace: drawn.trace,
      };
    }
    if (pending.intent === NEUTRAL_INTENT) {
      // `settle` is not a gesture: fade the current action and let the idle posture resume.
      const cancelled = inner.cancelIntent(null, { fadeMs: host.intentSettleFadeMs, at });
      actionState.waiting.length = 0;
      intentState.settled += 1;
      // A settle is not a gesture, so it breaks a run of conclusions: the next one may land.
      intentState.lastIntentProfile = null;
      recordIdleEvent('avatar.intent.settled', {
        event: pending.event, actionId, cancelled: cancelled.cancelled ?? 0, reason, at,
      });
      return { ok: true, code: null, intent: NEUTRAL_INTENT, actionId, released: true, dropped: false };
    }
    // Stage 4: the profile is expression only (`conclusion` → a slightly bigger nod; `confused` →
    // the tilt plus brows); `response:true` lets a short reply land its posture in 0.8–1.2 s (B).
    const played = intent(pending.intent, {
      at,
      profile: pending.profile ?? null,
      response: true,
    });
    if (played.ok !== true) {
      intentState.dropped += 1;
      const why = String(played.reason ?? played.code ?? 'unmapped');
      recordIdleEvent('avatar.intent.dropped', {
        reason: why, event: pending.event, intent: pending.intent, actionId, by: reason, at,
      });
      return {
        ok: false, code: played.code ?? AVATAR_ERROR_CODES.UNMAPPED,
        intent: pending.intent, actionId, released: false, dropped: true, reason: why,
      };
    }
    // The action id is the ticket reserved at staging time, so `avatar.intent.staged` and
    // `avatar.action.start` name the same intent. The runtime's own intent drives the parameters;
    // the host is not asked for a hotkey it may not expose (deliver:false).
    // Release-path evidence: only a real gesture released while a clip is playing is a clip-start
    // release; a speech-end / no-session release is "other". Both are evidence, never a selector.
    if (reason === 'sentence-start' && clipState.active === true) intentState.releasedAtClipStart += 1;
    else intentState.releasedOther += 1;
    startAction({ name: pending.intent }, at, {
      deliver: false,
      actionId,
      intentDurationMs: played.durationMs,
      intentInfo: played,
      release: {
        event: pending.event,
        stagedAt: Number.isFinite(pending.pendingSince) ? pending.pendingSince : pending.at,
        releasedBy: reason,
        releasedAt: at,
        actionBusy: pending.deferredByActionBusy === true,
      },
    });
    // The action carries its full identity (P-139 hard constraint): session/turn/generation plus the
    // ticket that is already its actionId. A later generation can never mistake it for its own.
    Object.assign(actionState.current, {
      intentGeneration: pending.generation,
      sessionId: pending.sessionId,
      turnId: pending.turnId,
      replyId: pending.replyId ?? null,
      event: pending.event,
      profile: pending.profile ?? null,
    });
    intentState.started += 1;
    intentState.lastIntentProfile = pending.profile ?? null;
    return {
      ok: true, code: null, intent: pending.intent, actionId, released: true, dropped: false,
      durationMs: played.durationMs, profile: pending.profile ?? null,
    };
  }

  /**
   * Stage one sentence-level intent. Shared by `intentEvent()` (a phase) and `markConclusion()` (a
   * judged conclusion sentence): the turn/session check, the single slot, the degradation rule and
   * the sentence-boundary release are identical, only the source of the intent differs.
   */
  function stageIntent({ event, mapped, profile = null, at = null, sessionId = null, turnId = null,
    holdForClipStart = false, replyId = null, continuation = false }) {
    const name = String(event ?? '');
    const time = Number.isFinite(at) ? at : clockNow();
    const nextSession = Number.isInteger(sessionId) ? sessionId : intentState.sessionId;
    const nextTurn = Number.isInteger(turnId) ? turnId : intentState.turnId;
    const nextReply = Number.isInteger(replyId) ? replyId : intentState.replyId;
    // A new user input (`turn-start` / `user-speaking`) opens a fresh reply: a barge-in from the
    // previous reply must not force the next reply's own turn claim to stay hard.
    if (name === 'turn-start' || name === 'user-speaking') intentState.afterInterrupt = false;
    const sessionSwitch = nextSession !== intentState.sessionId;
    const turnSwitch = nextTurn !== intentState.turnId;
    if (sessionSwitch || turnSwitch) {
      // P-139 stage 2 P1: a voice turn reports its pre-turn phase with the PREVIOUS turn id and
      // the Harness `turn/start` then names the new one. That is the SAME reply, not a real turn
      // switch: the running gesture must not be hard-cleared at 0 ms. It is soft only when the
      // host explicitly marks the claim as a continuation of the same reply, the session did not
      // change, no interrupt cut the pose since the action started, and the action belongs to
      // that reply. Everything else keeps the historical immediate hard stop.
      const current = actionState.current;
      const sameReply = continuation === true
        && sessionSwitch !== true
        && turnSwitch === true
        && intentState.afterInterrupt !== true
        && (current === null || (current.sessionId === nextSession
          && current.interruptSeq === intentState.interruptSeq
          && (nextReply === null || current.replyId == null || current.replyId === nextReply)));
      recordIdleEvent('avatar.intent.turn', {
        mode: sameReply === true ? 'continued' : 'hard',
        fromSession: intentState.sessionId,
        fromTurn: intentState.turnId,
        sessionId: nextSession,
        turnId: nextTurn,
        replyId: nextReply,
        previousReplyId: intentState.replyId,
        actionId: current?.actionId ?? null,
        at: time,
      });
      if (sameReply === true) {
        // Same reply: advance the generation and drop the old staged intent (late writes and a
        // deferred ticket can never start), but let the reply's own running gesture finish and
        // keep the clip identity the next sentence still belongs to.
        invalidateIntents('turn-continued', {
          at: time, interrupted: false, clearClip: false, hard: false, endRunning: false,
        });
      } else {
        // A real turn/session switch: the old generation stops NOW (hard epoch, interrupted end).
        invalidateIntents('turn-switch', { at: time, interrupted: true, clearClip: true, hard: true });
        intentState.afterInterrupt = false;
      }
      intentState.sessionId = nextSession;
      intentState.turnId = nextTurn;
      intentState.replyId = nextReply;
    } else if (Number.isInteger(replyId)) {
      // Same turn, new reply: a new utterance may start before its Harness turn id is known. The
      // action of the next reply must carry the new reply id so the later turn claim can match it.
      intentState.replyId = replyId;
    }
    // Existing rule: only a real target with a verified gaze mapping may be called "looking at
    // the user"; otherwise the event degrades to the neutral `settle` and is recorded.
    const attention = inner.snapshot().motion?.attention ?? null;
    const controlled = statusChannels().controlled;
    const gazeMapped = controlled.includes('gazeX') || controlled.includes('gazeY');
    const targetVerified = attention?.verified === true && attention?.mode === 'user' && gazeMapped === true;
    const decision = degradeMotionIntent(mapped, { targetVerified });
    intentState.seq += 1;
    const next = {
      ticket: intentState.seq,
      event: name,
      intent: decision.intent,
      mapped,
      /** Stage 4 expression profile carried to the action ('conclusion' | 'confused' | null). */
      profile: isMotionProfile(profile) ? String(profile) : null,
      degraded: decision.degraded,
      degradeReason: decision.reason,
      generation: intentState.generation,
      sessionId: intentState.sessionId,
      turnId: intentState.turnId,
      replyId: nextReply,
      at: time,
      /** The host staged this for a clip start it is about to report: that boundary releases it. */
      holdForClipStart: holdForClipStart === true,
    };
    // Single slot: a newer phase supersedes a still-waiting intent (the older one is reported).
    if (intentState.pending !== null) dropPendingIntent('superseded', { by: name, at: time });
    intentState.pending = next;
    intentState.pendingSince = time;
    intentState.staged += 1;
    intentState.lastEvent = name;
    if (decision.degraded === true) {
      intentState.degraded += 1;
      recordIdleEvent('avatar.intent.degraded', {
        event: name, intent: mapped, to: next.intent, reason: decision.reason, actionId: next.ticket, at: time,
      });
    }
    recordIdleEvent('avatar.intent.staged', {
      event: name,
      intent: next.intent,
      actionId: next.ticket,
      mapped,
      profile: next.profile,
      degraded: decision.degraded,
      generation: next.generation,
      sessionId: next.sessionId,
      turnId: next.turnId,
      replyId: next.replyId,
      continuation: continuation === true,
      at: time,
    });
    // Sentence-level release: a `holdForClipStart` admission waits for the boundary the host is
    // about to report (staging must never execute the gesture before the real start); the head
    // window of an already-started clip releases now; a later event waits for the next clip start;
    // no speech session means there is no boundary to wait for.
    if (holdForClipStart === true) {
      return {
        ok: true, code: null, event: name, intent: next.intent, actionId: next.ticket,
        staged: true, released: false, dropped: false, degraded: decision.degraded === true,
        profile: next.profile, reason: 'awaiting-clip-start',
      };
    }
    const headOfSentence = clipState.active === true
      && Number.isFinite(clipState.startedAt)
      && time - clipState.startedAt <= host.intentHeadWindowMs
      && intentState.servedClip !== clipState.index;
    if (clipState.session !== true || headOfSentence === true) {
      const released = releaseIntent(time, 'sentence-start');
      return {
        ok: released.ok === true,
        code: released.code ?? null,
        event: name,
        intent: next.intent,
        actionId: next.ticket,
        staged: true,
        released: released.released === true,
        dropped: released.dropped === true,
        degraded: decision.degraded === true,
        profile: next.profile,
        reason: released.reason ?? decision.reason,
      };
    }
    return {
      ok: true, code: null, event: name, intent: next.intent, actionId: next.ticket,
      staged: true, released: false, dropped: false, degraded: decision.degraded === true,
      profile: next.profile,
    };
  }

  /**
   * Report one communication phase. The event is mapped through the configured table, degraded to
   * neutral when a `lookAtUser` has no real target, and staged in the single slot. It starts only
   * at a sentence boundary: the head window of the clip that just started, the next
   * `speechClip('start')`, or — when the host reports no speech session at all — immediately.
   *
   * `sessionId` / `turnId` identify the conversation generation: passing a new value is a turn
   * switch, which invalidates the previous generation before this event is staged.
   */
  function intentEvent(event, {
    at = null, sessionId = null, turnId = null, holdForClipStart = false, replyId = null,
    continuation = false,
  } = {}) {
    if (state.disposed) return disposedResult();
    const name = String(event ?? '');
    if (!MOTION_EVENTS.includes(name)) {
      recordIdleEvent('avatar.intent.invalid', { event: name, supported: [...MOTION_EVENTS] });
      return fail(AVATAR_ERROR_CODES.INVALID_ARGUMENT, `unknown communication event: ${name}`,
        { supported: [...MOTION_EVENTS] }, { record: false });
    }
    const mapped = intentForEvent(intentState.table, name);
    if (mapped === null) {
      intentState.dropped += 1;
      recordIdleEvent('avatar.intent.dropped', {
        reason: 'unmapped-event', event: name, at: Number.isFinite(at) ? at : clockNow(),
      });
      return { ok: false, code: AVATAR_ERROR_CODES.INVALID_ARGUMENT, event: name, intent: '', staged: false, dropped: true, reason: 'unmapped-event' };
    }
    const time = Number.isFinite(at) ? at : clockNow();
    const result = stageIntent({
      event: name,
      mapped,
      profile: motionProfileFor(name),
      at: time,
      sessionId,
      turnId,
      holdForClipStart,
      replyId,
      continuation,
    });
    // The autonomous expression layer follows the same phase edge. It runs AFTER staging because a
    // turn/session switch invalidates (and clears) the old generation's expressions inside
    // stageIntent; an expression started before that would be wiped by its own event.
    if (name === 'thinking') {
      inner.expression('thinking', time);
    } else if (name === 'user-speaking' || name === 'turn-start') {
      // Fastpath reports `user-speaking`; the normal agent path reports `turn-start`. Both mean
      // "the user just spoke", so both recentre the eyes and add the small forward lean.
      inner.fadeExpression('thinking', time);
      inner.expression('listening', time);
    } else if (name === 'answer-start' || name === 'answer-end' || name === 'idle') {
      inner.fadeExpression('thinking', time);
      if (name !== 'answer-start') inner.fadeExpression('listening', time);
    }
    return result;
  }

  /**
   * Mark one sentence as a conclusion: the answer's key result. This is the "why" of that nod — a
   * slightly larger, slightly longer nod than the ordinary `answer-start` one, still a gesture the
   * table chose (`nod`), never a new intent and never a new channel.
   *
   * The host may pass the sentence text (accepted, only used for the diagnostic) or `{at}`. One
   * conclusion per sentence (the normal boundary rule) and never two in a row: a second mark while
   * the last released intent is still a conclusion is refused and recorded.
   */
  function markConclusion(input = null, { at = null, sessionId = null, turnId = null } = {}) {
    if (state.disposed) return disposedResult();
    const text = typeof input === 'string' ? input.trim().slice(0, 80) : '';
    const time = Number.isFinite(input?.at) ? input.at : Number.isFinite(at) ? at : clockNow();
    if (intentState.lastIntentProfile === 'conclusion') {
      intentState.conclusionDeduped += 1;
      recordIdleEvent('avatar.conclusion.deduped', { reason: 'conclusion-repeat', text, at: time });
      return {
        ok: false, code: null, event: 'conclusion', intent: 'nod',
        staged: false, released: false, dropped: true, reason: 'conclusion-repeat',
      };
    }
    if (intentState.pending !== null && intentState.pending.event === 'conclusion') {
      // The host may mark the same conclusion more than once while the sentence streams: keep ONE.
      intentState.conclusionDeduped += 1;
      recordIdleEvent('avatar.conclusion.deduped', {
        reason: 'conclusion-staged', actionId: intentState.pending.ticket, text, at: time,
      });
      return {
        ok: true, code: null, event: 'conclusion', intent: 'nod',
        actionId: intentState.pending.ticket, staged: true, released: false, dropped: false,
        reason: 'conclusion-staged',
      };
    }
    intentState.conclusionMarks += 1;
    const result = stageIntent({ event: 'conclusion', mapped: 'nod', profile: 'conclusion', at: time, sessionId, turnId });
    recordIdleEvent('avatar.conclusion.marked', {
      text, actionId: result.actionId ?? null, released: result.released === true, at: time,
    });
    return result;
  }

  /** Replace the event → intent table at runtime; the next event uses it (never the old table). */
  function setIntentTable(raw) {
    if (state.disposed) return disposedResult();
    // Merge over the table currently in force: an invalid entry keeps the previous valid mapping
    // instead of silently reverting to the shipped default.
    const normalized = normalizeIntentTable(raw, { base: intentState.table });
    intentState.table = normalized.table;
    intentState.tableInvalid = [...normalized.invalid];
    intentState.tableIgnored = [...normalized.ignored];
    recordIdleEvent('avatar.intent.table', {
      table: { ...normalized.table },
      invalid: [...normalized.invalid],
      ignored: [...normalized.ignored],
    });
    return {
      ok: true, code: null,
      table: { ...normalized.table },
      invalid: [...normalized.invalid],
      ignored: [...normalized.ignored],
    };
  }

  /**
   * Take the pending pose and write the mapped idle channels through the ONE transport writer.
   * Only head axes (and opt-in eye-open) are written, at most `idleWriteHz`. A mouth never stops
   * this frame: speech only scales its amplitude (IDLE_SPEECH_SCALE). The one full pause is an
   * explicit `flags.idle === false`. Unmapped channels are skipped (and recorded); when nothing is
   * mapped the runtime writes nothing at all and reports `idleSource: 'hotkey' | 'none'` instead.
   */
  function maybeFlushIdleParams(at) {
    if (state.disposed === true || state.connected !== true || motionLocked) return;
    // Single-flight: a frame that comes due while the previous send is unsettled is discarded,
    // not queued. The next tick stages the newest pose, so a slow transport can never backlog.
    if (flushingIdle) {
      idleStats.dropped += 1;
      return;
    }
    const interval = idleWriteIntervalMs();
    if (at - lastIdleWriteAt < interval) return;
    const idleSource = currentIdleSource();
    // A one-shot intent may need a channel outside the idle write set (gaze/brow/body). The same
    // snapshot is reused for the idle-frame decision, so a param runtime still pays one read.
    const early = idleSource === 'param' ? null : inner.snapshot();
    const snap = early ?? inner.snapshot();
    const intentChannels = new Set(snap.intents?.channels ?? []);
    // Breath is written on its own verified row even when no idle channel or intent is active.
    if (idleSource !== 'param' && intentChannels.size === 0 && breathBinding() === null) return;
    // The ONLY full pause: an explicit `flags.idle === false` still skips every idle frame.
    if (snap.intent?.flags?.idle === false) {
      if (at - lastIdleSuppressedAt >= interval) {
        lastIdleSuppressedAt = at;
        idleStats.suppressedByIdleOff += 1;
        if (at - lastIdleSuppressedLogAt >= IDLE_SUPPRESSED_LOG_MS) {
          lastIdleSuppressedLogAt = at;
          recordIdleEvent('avatar.idle.suppressed', { reason: 'idle-off' });
        }
      }
      return;
    }
    // Speech NEVER pauses this frame: the mouth owns only its own input, the body keeps moving.
    const speaking = mouthActiveForIdle(at, snap);
    const speechScale = speaking ? IDLE_SPEECH_SCALE : 1;
    const writeScale = postureWriteScale(snap);
    lastIdleWriteAt = at;
    lastIdleSuppressedAt = Number.NEGATIVE_INFINITY;
    const frame = inner.takePendingFrame();
    if (frame.size === 0) return;
    const entries = [];
    const writtenInputs = new Set();
    idleFloor.changed = false;
    idleFloor.target = null;
    // Motion floor ("never frozen"): two completely still sampling periods mean the curve has
    // nothing left to show, so ONE idle-owned head channel may be nudged. Zero amplitude is a
    // legal stationary pose: a zero-gain/zero-style/zero-tuning channel injects nothing and the
    // skip is reported (throttled). A mouth owner / explicit gesture keeps its channel.
    if (idleFloor.quietCycles >= IDLE_FLOOR_QUIET_CYCLES) {
      const candidate = idleParamMap.find((item) => IDLE_FLOOR_CHANNELS.has(item.channel)
        && IDLE_WRITE_CHANNELS.includes(item.channel)
        && item.inputName !== ''
        && intentChannels.has(item.channel) !== true
        && !(speaking && isMouthOwnedInput(item.inputName)));
      if (candidate !== undefined) {
        if (!idleFloorEnabled(candidate, snap)) {
          noteIdleFloorSkipped('zero-amplitude', candidate.channel, at);
        } else {
          const step = idleFloorStepFor(candidate);
          if (step > IDLE_FLOOR_EPSILON) {
            idleFloor.target = candidate.channel;
            idleFloor.step = step;
            idleFloor.amplitude = idleFloorCap(candidate);
            idleFloor.reason = postureHoldActive(at, snap) ? 'hold' : 'still';
          }
        }
      }
    }
    for (const item of idleParamMap) {
      if (!IDLE_WRITE_CHANNELS.includes(item.channel)) continue;
      // Mouth priority: while speaking, the mouth writer owns its input outright.
      if (speaking && isMouthOwnedInput(item.inputName)) continue;
      // Eye writes are opt-in for the idle frame, but a live surprise intent that verified the eye
      // channel may widen it for its own window; only taken-over channels reach this list.
      if (host.idleEye !== true && (item.channel === 'eyeOpenL' || item.channel === 'eyeOpenR')
        && intentChannels.has(item.channel) !== true) continue;
      if (item.inputName === '') {
        noteIdleSkip(item.channel, channelState.unverified.includes(item.channel) ? 'unverified' : 'unmapped');
        continue;
      }
      // One writer per input per frame: the first channel in the stable order owns it.
      if (writtenInputs.has(item.inputName)) continue;
      const raw = frame.get(item.channel);
      if (!Number.isFinite(raw)) {
        noteIdleSkip(item.channel, 'idle-param-no-value');
        continue;
      }
      const value = intentChannels.has(item.channel)
        ? intentWriteValue(item.channel, raw)
        : idleWriteValue(item, raw, speechScale, { allowFloor: true, writeScale });
      entries.push({
        input: item.inputName,
        value: writeInputValue(item, item.channel, value),
        channel: item.channel,
      });
      writtenInputs.add(item.inputName);
    }
    // Intent-only channels: written only while the intent is active/settling AND the channel was
    // verified by discovery or an accepted probe. Unmapped channels are recorded, never guessed.
    for (const channel of intentChannels) {
      if (IDLE_WRITE_CHANNELS.includes(channel)) continue;
      if (!INTENT_WRITE_CHANNELS.includes(channel)) continue;
      const binding = channelState.bindings.get(channel);
      if (binding?.verified !== true) {
        noteIdleSkip(channel, binding === undefined ? 'unmapped' : 'unverified');
        continue;
      }
      if (writtenInputs.has(binding.inputName)) continue;
      if (speaking && isMouthOwnedInput(binding.inputName)) continue;
      const raw = frame.get(channel);
      if (!Number.isFinite(raw)) continue;
      const value = intentWriteValue(channel, raw);
      entries.push({
        input: binding.inputName,
        value: writeInputValue(binding, channel, value),
        channel,
      });
      writtenInputs.add(binding.inputName);
    }
    // Breath is appended last: it never owns another channel's input and never replaces an idle row.
    const breath = breathEntry(frame.get('breath'), at);
    if (breath !== null && !writtenInputs.has(breath.input)) {
      entries.push(breath);
      writtenInputs.add(breath.input);
    }
    // `prepared` evidence is taken from the rows this flush really built, never from the pose: a
    // skipped channel is reported with the reason and cannot masquerade as committed.
    const ticket = beginTransportEvidence(entries, snap, {
      valueOf: (channel) => frame.get(channel),
      speaking,
      writtenInputs,
      at,
    });
    if (entries.length === 0) return;
    lastIdleFrameAt = at;
    if (idleFloor.target !== null) {
      // Only a channel that really made it into this frame counts as an injection. The alternating
      // sign keeps the floor a small oscillation instead of a drift.
      const wroteFloor = entries.some((entry) => entry.channel === idleFloor.target);
      if (wroteFloor) {
        idleFloor.injected += 1;
        idleFloor.sign = -idleFloor.sign;
        idleFloor.quietCycles = 0;
        if (at - idleFloor.loggedAt >= IDLE_FLOOR_LOG_MS) {
          idleFloor.loggedAt = at;
          recordIdleEvent('avatar.idle.motion-floor', {
            channel: idleFloor.target,
            step: idleFloor.step,
            amplitude: idleFloor.amplitude,
            reason: idleFloor.reason,
            quietCycles: IDLE_FLOOR_QUIET_CYCLES,
            injected: idleFloor.injected,
          });
        }
      } else {
        idleFloor.target = null;
        idleFloor.quietCycles = idleFloor.changed ? 0 : idleFloor.quietCycles + 1;
      }
    } else {
      idleFloor.quietCycles = idleFloor.changed ? 0 : idleFloor.quietCycles + 1;
    }
    if (speaking) {
      idleStats.reducedBySpeech += 1;
      if (at - lastIdleReducedLogAt >= IDLE_SUPPRESSED_LOG_MS) {
        lastIdleReducedLogAt = at;
        recordIdleEvent('avatar.idle.reduced', { reason: 'speech', scale: IDLE_SPEECH_SCALE });
      }
    }
    flushingIdle = true;
    idleStats.frames += 1;
    const sentGeneration = state.generation;
    const sentConnection = state.connectionGeneration;
    const sentEpoch = motionEpoch;
    const stillCurrent = () => state.disposed !== true
      && state.connected === true
      && state.generation === sentGeneration
      && state.connectionGeneration === sentConnection
      && motionEpoch === sentEpoch;
    // One frame is either one coalesced `writeFrame` call or one call per row. Both paths record
    // `attempted` only when the call really starts and `committed` only after `ok:true`.
    const buildIdleSend = () => {
      if (typeof transport?.writeFrame === 'function') {
        noteTransportAttempted(ticket, entries, at);
        return Promise.resolve(transport.writeFrame(entries)).then((result) => {
          if (result !== null && typeof result === 'object' && result.ok === false) {
            throw transportRejection(result, 'idle frame rejected');
          }
          if (stillCurrent() !== true) {
            // A lock/disconnect/model switch landed while the send was in flight: this frame belongs
            // to the old generation and must not update the live counters or become a commit.
            idleStats.stale += entries.length;
            noteTransportStale(ticket, entries, 'generation', clockNow());
            return;
          }
          idleStats.writes += entries.length;
          noteTransportCommitted(ticket, entries, clockNow());
          countBreathEntries(entries, at);
        });
      }
      return entries.reduce((chain, entry) => chain.then(async () => {
        if (stillCurrent() !== true) {
          idleStats.stale += 1;
          noteTransportStale(ticket, [entry], 'generation', clockNow());
          return;
        }
        noteTransportAttempted(ticket, [entry], at);
        let result;
        try {
          result = await writeThroughTransport(entry);
        } catch (error) {
          error.evidenceRows = [entry];
          throw error;
        }
        if (result !== null && typeof result === 'object' && result.ok === false) {
          throw transportRejection(result, 'idle write rejected');
        }
        if (stillCurrent() !== true) {
          idleStats.stale += 1;
          noteTransportStale(ticket, [entry], 'generation', clockNow());
          return;
        }
        idleStats.writes += 1;
        noteTransportCommitted(ticket, [entry], clockNow());
        if (entry.channel === 'breath') {
          breathStats.writes += 1;
          breathStats.lastAt = at;
        }
      }), Promise.resolve());
    };
    let sent;
    try {
      sent = buildIdleSend();
    } catch (error) {
      // A synchronous throw from the transport is still one failed send: never a commit.
      sent = Promise.reject(error);
    }
    sent
      .catch((error) => {
        noteTransportFailed(ticket, error?.evidenceRows ?? entries, error, clockNow());
        idleStats.skipped += entries.length;
        recordError(AVATAR_ERROR_CODES.WRITE_FAILED, `idle frame failed: ${errorText(error)}`, {
          source: 'idle-frame',
        });
      })
      .finally(() => {
        flushingIdle = false;
      });
  }

  function maybeFlushMouth(pose, at) {
    if (state.connected !== true || flushing) return;
    const snap = inner.snapshot();
    if (snap.mouth.active !== true || snap.mouth.mode !== 'envelope') return;
    if (at - lastFlushAt < host.flushIntervalMs) return;
    flushing = true;
    lastFlushAt = at;
    const owner = snap.mouth.owner;
    const sessionToken = snap.mouth.token;
    Promise.resolve(inner.writeMouth({ value: pose.mouth, token: sessionToken, owner }))
      .then((result) => noteInnerFailure(result, 'flush'))
      .catch((error) => recordError(AVATAR_ERROR_CODES.WRITE_FAILED, errorText(error), { source: 'flush' }))
      .finally(() => {
        flushing = false;
      });
  }

  // ---- lifecycle -------------------------------------------------------------------------
  /**
   * Release the socket opened by a connect attempt that was invalidated while its
   * `transport.connect()` was still in flight. Only the attempt that owns the physical connection
   * may do this: when a newer connect() has already claimed the transport, a stale result must
   * leave that newer connection alone. The runtime never wired listeners or the auto-tick for a
   * late attempt, so there is nothing else to unwind here.
   */
  function releaseLateConnection(record) {
    if (connectionOwner !== record.attempt) return;
    connectionOwner = 0;
    if (typeof transport?.disconnect !== 'function') return;
    try {
      const result = transport.disconnect();
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch {
      // Releasing a late connection never throws at the caller.
    }
  }

  /** Result for a connect() whose attempt was invalidated while the transport was connecting. */
  function invalidatedConnectResult() {
    return {
      ok: false,
      code: AVATAR_ERROR_CODES.DISPOSED,
      message: 'connect finished after the runtime was disposed or disconnected',
      connected: false,
      generation: state.generation,
      connectionGeneration: state.connectionGeneration,
    };
  }

  /** True once disconnect()/dispose() or a newer attempt has invalidated `record`. */
  function isAttemptInvalidated(record) {
    return state.disposed === true
      || record.cancelled === true
      || state.connectionGeneration !== record.attempt;
  }

  /** Clear the shared slot while it still points at this attempt. */
  function settleConnectAttempt(record) {
    if (inFlightConnect === record) inFlightConnect = null;
  }

  /**
   * The single transport dial shared by every concurrent connect(). Listeners and the auto-tick
   * are wired only after the post-await generation check, so an invalidated attempt never
   * resurrects the runtime and never tears down a connection a newer attempt owns.
   */
  async function runConnectAttempt(record) {
    try {
      if (typeof transport?.connect === 'function') await transport.connect();
    } catch (error) {
      settleConnectAttempt(record);
      // A dispose/disconnect during the failed attempt still wins over CONNECT_FAILED.
      if (isAttemptInvalidated(record)) {
        releaseLateConnection(record);
        return invalidatedConnectResult();
      }
      if (connectionOwner === record.attempt) connectionOwner = 0;
      return fail(AVATAR_ERROR_CODES.CONNECT_FAILED, `connect failed: ${errorText(error)}`, {
        cause: errorText(error),
      });
    }
    if (isAttemptInvalidated(record)) {
      settleConnectAttempt(record);
      releaseLateConnection(record);
      return invalidatedConnectResult();
    }
    settleConnectAttempt(record);
    connectionOwner = 0;
    state.connected = true;
    state.generation += 1;
    bumpMotionEpoch('connect');
    state.connectedAt = clockNow();
    syncMouthInput();
    attachTransportListeners();
    // Explicit channel mappings are verified against the live transport before any frame is sent.
    const configured = pendingChannelConfig ?? configuredChannelConfig();
    pendingChannelConfig = null;
    if (configured.channels.length > 0 || Object.keys(configured.channelMap ?? {}).length > 0) {
      await applyChannelMappings(configured.channels, configured.channelMap);
    }
    startAutoTick();
    // Publish the discrete pool this model can run: once at startup, then once per change.
    refreshIdleActionPool('connect');
    // Once per runtime start: publish the idle write tuning actually in effect.
    if (idleTunedLogged !== true) {
      idleTunedLogged = true;
      recordIdleEvent('avatar.idle.tuned', { writeHz: host.idleWriteHz, amplitude: host.idleAmplitude });
    }
    appendLog('info', 'avatar runtime connected', { generation: state.generation });
    return {
      ok: true,
      code: null,
      connected: true,
      generation: state.generation,
      mouthInput: state.mouthInput,
    };
  }

  async function connect() {
    if (state.disposed) return disposedResult();
    // P2: while disconnect() is still closing the socket the runtime is NOT "already connected".
    // Wait for that close (or for disposal) before deciding, so the connect really re-dials and
    // the old close can never leave a freshly reported connection down.
    while (disconnectBarrier !== null) {
      await Promise.race([disconnectBarrier.promise, disposedGate]);
      if (state.disposed) return disposedResult();
    }
    if (state.connected === true) {
      return {
        ok: true,
        code: null,
        connected: true,
        generation: state.generation,
        alreadyConnected: true,
      };
    }
    // One dial at a time: a concurrent caller reuses the attempt that is already in flight
    // instead of opening a second transport connection.
    if (inFlightConnect !== null) return inFlightConnect.promise;
    syncMouthInput();
    // Claim a fresh attempt. disconnect() / dispose() advance the same counter and set the
    // attempt's cancel flag, so a transport that settles afterwards is provably stale.
    const attempt = (state.connectionGeneration += 1);
    const record = { attempt, cancelled: false, promise: null };
    connectionOwner = attempt;
    inFlightConnect = record;
    record.promise = runConnectAttempt(record);
    return record.promise;
  }

  /**
   * Close the transport. `disconnecting` is observable from the first instant until the physical
   * close settles (success or failure); connect() waits on that same barrier, so a connect issued
   * mid-close cannot short-circuit to `alreadyConnected:true` (P2).
   */
  async function disconnect() {
    if (state.disposed) return disposedResult();
    // One physical close at a time: a concurrent disconnect() joins the one already in flight.
    if (disconnectBarrier !== null) return disconnectBarrier.promise;
    // Invalidate any connect() still awaiting its transport: its late resolution must not mark
    // the runtime connected or start the tick.
    state.connectionGeneration += 1;
    const pending = inFlightConnect;
    if (pending !== null) {
      pending.cancelled = true;
      inFlightConnect = null;
    }
    const record = { promise: null };
    disconnectBarrier = record;
    record.promise = runDisconnect(record);
    return record.promise;
  }

  /**
   * The single physical close shared by every concurrent disconnect(). The barrier is cleared in
   * `finally`, so a throwing transport can never leave the runtime permanently "disconnecting".
   */
  async function runDisconnect(record) {
    const wasConnected = state.connected === true;
    stopAutoTick();
    detachTransportListeners();
    let failure = null;
    try {
      if (wasConnected && typeof transport?.disconnect === 'function') {
        connectionOwner = 0;
        try {
          await transport.disconnect();
        } catch (error) {
          failure = error;
          recordError(AVATAR_ERROR_CODES.DISCONNECT_FAILED, `disconnect failed: ${errorText(error)}`);
        }
      }
    } finally {
      // P2: a successful close and a failed one both mean the socket is not ours any more, so
      // `connected` is cleared before the barrier opens — never connected=true with a dead socket.
      state.connected = false;
      if (disconnectBarrier === record) disconnectBarrier = null;
      resetMouthState('disconnect');
    }
    if (failure === null) appendLog('info', 'avatar runtime disconnected', {});
    return {
      ok: true,
      code: null,
      connected: false,
      generation: state.generation,
      alreadyDisconnected: wasConnected !== true,
    };
  }

  /**
   * Tear the runtime down. Idempotent and synchronous: listeners are detached, the auto-tick
   * timer cleared, the mouth reset to 0 and the transport asked to disconnect (failures ignored).
   */
  function dispose() {
    if (state.disposed === true) {
      return { ok: true, code: null, disposed: true, alreadyDisposed: true, generation: state.generation };
    }
    state.disposed = true;
    // Teardown is terminal: leave neither a watchdog nor a stale gate behind for a late settle.
    if (motionPump.watchdog !== null) {
      clearTimeout(motionPump.watchdog);
      motionPump.watchdog = null;
    }
    if (motionPump.active?.abandonTimer) clearTimeout(motionPump.active.abandonTimer);
    stopMotionCancel(motionPump.active);
    motionPump.active = null;
    motionPump.inFlight = false;
    motionPump.skipped = false;
    motionPump.sendId += 1;
    // Release a connect() parked on the disconnect barrier (P2): it must answer DISPOSED now,
    // without waiting for a socket close that may never settle.
    signalDisposed();
    // Invalidate a connect() that is still awaiting its transport.
    state.connectionGeneration += 1;
    const pending = inFlightConnect;
    if (pending !== null) {
      pending.cancelled = true;
      inFlightConnect = null;
    }
    stopAutoTick();
    detachTransportListeners();
    state.connected = false;
    resetMouthState('dispose');
    // A disconnect already in flight owns the physical close: asking again here would close the
    // transport twice. A cancelled attempt still waiting on transport.connect() owns the socket
    // it is about to open and releases it exactly once when it settles; everything else closes here.
    if (disconnectBarrier === null && (pending === null || connectionOwner !== pending.attempt)) {
      connectionOwner = 0;
      if (typeof transport?.disconnect === 'function') {
        try {
          const result = transport.disconnect();
          if (result && typeof result.catch === 'function') result.catch(() => {});
        } catch {
          // Teardown never throws, even when the transport is already gone.
        }
      }
    }
    appendLog('info', 'avatar runtime disposed', { generation: state.generation });
    return { ok: true, code: null, disposed: true, alreadyDisposed: false, generation: state.generation };
  }

  // ---- frame driving ---------------------------------------------------------------------
  function tick(nowMs) {
    if (state.disposed) return disposedResult();
    const at = Number.isFinite(nowMs) ? nowMs : clockNow();
    const pose = inner.tick(at);
    state.mouth = pose.mouth;
    state.lastActivityAt = at;
    const snap = inner.snapshot();
    if (snap.turn.speaking === true) state.idleSince = null;
    else if (state.idleSince === null) state.idleSince = at;
    // A lock is a hard output gate, not a fade: no mouth frame and no motion frame leaves while
    // it is active, and every staged old-generation frame was dropped by bumpMotionEpoch().
    if (motionLocked) return pose;
    maybeFlushMouth(pose, at);
    // Breath has no verified channel: report the skip (throttled) and write nothing at all.
    if (state.connected === true) noteBreathChannel(at);
    if (host.motionWrites === true) {
      // The interpolated pose is the ONE writer on this path; the legacy 4 Hz idle flush is not
      // also run, so one input can never receive two final values in one frame.
      submitMotionFrame(pose, at);
    } else {
      maybeFlushIdleParams(at);
    }
    // Actions advance on their own serial rhythm AFTER the mouth frame: the mouth always wins the
    // transport, and nothing here reads `speaking`, so a new sentence cannot restart an action.
    stepActions(at);
    return pose;
  }

  /** Drive an idle-intent frame at `at` (the speech envelope, if any, still wins for the mouth). */
  function idle(at) {
    if (state.disposed) return disposedResult();
    inner.setIntent({ flags: { idle: true } });
    return tick(at);
  }

  // ---- speech + mouth --------------------------------------------------------------------
  function normalizeSpeech(input, options) {
    const opts = options !== null && typeof options === 'object' ? options : {};
    let spec;
    if (typeof input === 'string') {
      spec = { text: input };
    } else if (input !== null && typeof input === 'object') {
      const envelope = input.envelope;
      if (Array.isArray(envelope)) spec = { ...input, levels: envelope };
      else if (envelope !== null && typeof envelope === 'object') {
        spec = {
          ...input,
          ...envelope,
          levels: envelope.levels ?? envelope.values ?? input.levels,
        };
      } else spec = { ...input };
    } else {
      return { error: 'speak() needs a text string, a levels array, or an { envelope } object' };
    }
    spec = { ...spec, ...opts };

    const owner = asOwner(spec.owner) ?? 'speech';
    const levels = Array.isArray(spec.levels) && spec.levels.length > 0 ? spec.levels : null;
    const text = spec.text === null || spec.text === undefined ? '' : String(spec.text);
    const live = spec.live === true;
    if (live !== true && levels === null && text.trim() === '') {
      return { error: 'speak() needs a text string, a levels array, or a { envelope } object' };
    }

    const stepMs = Number.isFinite(spec.stepMs) && spec.stepMs > 0
      ? spec.stepMs
      : (Number.isFinite(userConfig.mouthStepMs) && userConfig.mouthStepMs > 0
        ? userConfig.mouthStepMs
        : TIMING.MOUTH_STEP_MS);
    let durationMs = Number.isFinite(spec.durationMs) && spec.durationMs > 0 ? spec.durationMs : 0;
    if (durationMs === 0) {
      const chars = Array.from(text.replace(/\s+/gu, '')).length;
      durationMs = levels !== null ? levels.length * stepMs : Math.max(stepMs, chars * host.textCharMs);
    }
    return {
      owner,
      live,
      text,
      levels,
      stepMs,
      durationMs,
      startedAt: Number.isFinite(spec.startedAt) ? spec.startedAt : undefined,
      token: spec.token,
      takeover: spec.takeover === true,
    };
  }

  /**
   * Unified speech/mouth entry: a text string, `{ text, durationMs }`, `{ envelope: [...] }`,
   * `{ envelope: { levels, stepMs, durationMs } }` or `{ live: true }` for push-based lip-sync.
   * `{ owner, token, takeover }` may be supplied in either the object or the second argument.
   */
  async function speak(input, options = {}) {
    if (state.disposed) return disposedResult();
    if (state.connected !== true) {
      return fail(AVATAR_ERROR_CODES.NOT_CONNECTED, 'avatar runtime is not connected');
    }
    const spec = normalizeSpeech(input, options);
    if (spec.error) return fail(AVATAR_ERROR_CODES.INVALID_ARGUMENT, spec.error);

    const seat = ensureOwnership(spec.owner, { token: spec.token, takeover: spec.takeover });
    if (seat.ok !== true) return seat;

    const startedAt = Number.isFinite(spec.startedAt) ? spec.startedAt : clockNow();
    let result;
    try {
      result = inner.startSpeech({
        text: spec.text,
        levels: spec.levels ?? undefined,
        stepMs: spec.stepMs,
        durationMs: spec.durationMs,
        startedAt,
        owner: seat.owner,
        live: spec.live,
        takeover: false,
      });
    } catch (error) {
      return fail(AVATAR_ERROR_CODES.WRITE_FAILED, `speech failed: ${errorText(error)}`);
    }
    if (result.ok !== true) {
      return fail(codeForReason(result.reason), messageForReason(result.reason), {
        reason: result.reason,
        owner: seat.owner,
        token: state.ownerToken,
      });
    }
    state.mouth = 0;
    state.lastActivityAt = startedAt;
    state.idleSince = null;
    lastMouthActivityAt = startedAt;
    appendLog('debug', 'avatar speech started', {
      owner: seat.owner, mode: result.mode, frames: result.frames,
    });
    return {
      ok: true,
      code: null,
      owner: seat.owner,
      token: state.ownerToken,
      generation: state.generation,
      mode: result.mode,
      frames: result.frames,
      durationMs: result.durationMs,
      startedAt: result.startedAt,
    };
  }

  /** Push one speaker level into the owned mouth session (live lip-sync path). */
  async function writeMouth(value, { owner, token, takeover } = {}) {
    if (state.disposed) return disposedResult();
    if (state.connected !== true) {
      return fail(AVATAR_ERROR_CODES.NOT_CONNECTED, 'avatar runtime is not connected');
    }
    const level = Number(value);
    if (!Number.isFinite(level)) {
      return fail(AVATAR_ERROR_CODES.INVALID_ARGUMENT, 'mouth level must be a finite number');
    }
    const seat = ensureOwnership(owner ?? state.owner ?? 'speech', { token, takeover });
    if (seat.ok !== true) return seat;

    let snap = inner.snapshot();
    if (snap.mouth.active !== true || snap.mouth.mode !== 'live') {
      let opened;
      try {
        opened = inner.startSpeech({
          owner: seat.owner,
          live: true,
          startedAt: clockNow(),
          takeover: snap.mouth.active === true,
        });
      } catch (error) {
        return fail(AVATAR_ERROR_CODES.WRITE_FAILED, `speech session failed: ${errorText(error)}`);
      }
      if (opened.ok !== true) {
        return fail(codeForReason(opened.reason), messageForReason(opened.reason), {
          reason: opened.reason, owner: seat.owner,
        });
      }
      snap = inner.snapshot();
    }

    let result;
    try {
      result = await inner.writeMouth({
        value: level,
        token: snap.mouth.token,
        owner: seat.owner,
      });
    } catch (error) {
      return fail(AVATAR_ERROR_CODES.WRITE_FAILED, `mouth write failed: ${errorText(error)}`);
    }
    if (result.ok !== true) {
      return fail(codeForReason(result.reason), messageForReason(result.reason), {
        reason: result.reason,
        owner: seat.owner,
        token: state.ownerToken,
      });
    }
    state.mouth = result.value;
    state.lastActivityAt = clockNow();
    lastFlushAt = state.lastActivityAt;
    // A live sender's recent write marks the mouth input as owned: the idle frame keeps running,
    // but its values are scaled and it never writes that same input in the same frame.
    lastMouthActivityAt = state.lastActivityAt;
    return {
      ok: true,
      code: null,
      owner: seat.owner,
      token: state.ownerToken,
      generation: state.generation,
      value: result.value,
      writes: result.writes,
    };
  }

  /** Claim the single mouth seat. Re-claiming the same owner with its token is idempotent. */
  function setMouthOwner(owner, { token, takeover = false } = {}) {
    if (state.disposed) return disposedResult();
    if (state.connected !== true) {
      return fail(AVATAR_ERROR_CODES.NOT_CONNECTED, 'avatar runtime is not connected');
    }
    const name = asOwner(owner);
    if (name === null) {
      return fail(AVATAR_ERROR_CODES.INVALID_ARGUMENT, 'owner must be a non-empty string');
    }
    const seat = ensureOwnership(name, { token, takeover });
    if (seat.ok !== true) return seat;
    return { ...seat, generation: state.generation };
  }

  /** Release the mouth seat and invalidate every token issued for it. */
  function releaseOwner(owner) {
    if (state.disposed) return disposedResult();
    const current = state.owner;
    if (current === null) {
      return {
        ok: true, code: null, released: false, owner: null,
        token: state.ownerToken, generation: state.generation,
      };
    }
    const name = asOwner(owner) ?? current;
    if (name !== current) {
      return fail(
        AVATAR_ERROR_CODES.OWNERSHIP_CONFLICT,
        `mouth is owned by ${current}, not ${name}`,
        { owner: current, requested: name },
        { record: false },
      );
    }
    try {
      inner.endSpeech({ token: inner.snapshot().mouth.token });
    } catch (error) {
      recordError(AVATAR_ERROR_CODES.WRITE_FAILED, `release failed: ${errorText(error)}`);
    }
    state.owner = null;
    state.ownerToken += 1;
    state.mouth = 0;
    appendLog('debug', 'avatar mouth owner released', { owner: current });
    return {
      ok: true, code: null, released: true, previous: current, owner: null,
      token: state.ownerToken, generation: state.generation,
    };
  }

  // ---- observation -----------------------------------------------------------------------
  function snapshot() {
    const innerSnap = inner.snapshot();
    const speaking = innerSnap.turn.speaking === true;
    return {
      connected: state.connected,
      /** True from the start of disconnect() until its transport close settles (success or failure). */
      disconnecting: disconnectBarrier !== null,
      owner: state.owner,
      generation: state.generation,
      connectionGeneration: state.connectionGeneration,
      mouth: state.mouth,
      idle: speaking !== true,
      lastError: state.lastError,
      // Diagnostics the host may show without reaching into `inner`.
      disposed: state.disposed,
      ownerToken: state.ownerToken,
      lastErrorCode: state.lastErrorCode,
      errorCount: state.errorCount,
      mouthInput: state.mouthInput,
      connectedAt: state.connectedAt,
      lastActivityAt: state.lastActivityAt,
      idleSince: state.idleSince,
      /**
       * Idle motion provenance. 'param' means this runtime's continuous frames drive mapped
       * head/eye/gaze inputs; 'hotkey' is only the host's discrete fallback, never the engine.
       */
      idleSource: currentIdleSource(),
      /** Cached persona style (baseline + current-state effective + P-139 dimensions). */
      style: innerSnap.style,
      /** Current intent patch, including `lastVariant` from the stage-3 replacement draw. */
      intent: innerSnap.intent,
      status: innerSnap.status,
      intents: innerSnap.intents,
      /** Takeover view: only verified mappings are controlled; nothing else is ever injected. */
      channels: statusChannels(),
      idleParams: {
        mapped: idleParamMap.filter((entry) => entry.inputName !== '').map((entry) => entry.channel),
        unmapped: idleParamMap.filter((entry) => entry.inputName === '').map((entry) => entry.channel),
        frames: idleStats.frames,
        writes: idleStats.writes,
        skipped: idleStats.skipped,
        writeHz: host.idleWriteHz,
        amplitude: host.idleAmplitude,
        maxStep: host.idleMaxStep,
        swayScale: host.idleSwayScale,
        /** Motion floor telemetry: how often a still curve had to be nudged back to life. */
        motionFloor: {
          injected: idleFloor.injected,
          quietCycles: idleFloor.quietCycles,
          skipped: idleFloor.skipped,
        },
        eye: host.idleEye,
        lastFrameAt: lastIdleFrameAt,
        /** Speech keeps the idle frame running: frames written while the mouth moved. */
        reducedBySpeech: idleStats.reducedBySpeech,
        /** Amplitude multiplier applied to those frames (STATUS_MODIFIERS.speaking). */
        speechScale: IDLE_SPEECH_SCALE,
        /** Frames skipped because the host explicitly paused idle motion (`flags.idle === false`). */
        suppressedByIdleOff: idleStats.suppressedByIdleOff,
        /**
         * Legacy field kept for the index.js status probe. Speech no longer suppresses a frame, so
         * it stays 0; the live counters are `reducedBySpeech` / `suppressedByIdleOff`.
         */
        suppressedBySpeech: 0,
        /** Single-flight drops: a due frame discarded because the previous send was unsettled. */
        dropped: idleStats.dropped,
        /** Writes that settled after a lock/disconnect/model switch (old generation). */
        stale: idleStats.stale,
      },
      /**
       * Breath output state. `mapped` is proof of a verified channel; while it is false the runtime
       * writes nothing and reports `avatar.breath.skipped {reason:'no-verified-channel'}`.
       */
      breath: {
        mapped: breathBinding() !== null,
        input: breathBinding()?.inputName ?? '',
        writes: breathStats.writes,
        skipped: breathStats.skipped,
        lastAt: breathStats.lastAt,
      },
      /**
       * Continuous motion output: interpolation rate, output generation, single-slot/single-flight
       * counters and the controller state the pose was built from.
       */
      motion: {
        outputHz: host.motionOutputHz,
        writes: host.motionWrites,
        locked: motionLocked,
        lockReason: motionLockReason,
        epoch: motionEpoch,
        outputFrames: motionPump.frames,
        sent: motionPump.sent,
        writesDone: motionPump.writes,
        dropped: motionPump.dropped,
        stale: motionPump.stale,
        timeouts: motionPump.timeouts,
        abandoned: motionPump.abandoned,
        cancelConfirmed: motionPump.cancelConfirmed,
        cancelUnconfirmed: motionPump.cancelUnconfirmed,
        outOfOrder: motionPump.outOfOrder,
        sendSeq: motionPump.sendSeq,
        appliedSeq: motionPump.appliedSeq,
        skipped: motionPump.skipped,
        errors: motionPump.errors,
        inFlight: motionPump.inFlight,
        pending: motionPump.slot !== null,
        lastFrameAt: motionPump.lastFrameAt,
        lastSentAt: motionPump.lastSentAt,
        ...innerSnap.motion,
        /**
         * Sender evidence, five phases kept apart: a prepared frame is not an attempted send, an
         * attempted send is not a commit, and failed/stale results are never commits. Transport
         * level only — it never claims the rendered model or the VTS pixels were verified.
         */
        transport: {
          prepared: transportEvidence.prepared,
          preparedRows: transportEvidence.preparedRows,
          attempted: transportEvidence.attempted,
          attemptedRows: transportEvidence.attemptedRows,
          committed: transportEvidence.committed,
          committedRows: transportEvidence.committedRows,
          failed: transportEvidence.failed,
          failedRows: transportEvidence.failedRows,
          stale: transportEvidence.stale,
          staleRows: transportEvidence.staleRows,
          lastPreparedAt: transportEvidence.lastPreparedAt,
          lastAttemptedAt: transportEvidence.lastAttemptedAt,
          lastCommittedAt: transportEvidence.lastCommittedAt,
          lastFailedAt: transportEvidence.lastFailedAt,
          lastStaleAt: transportEvidence.lastStaleAt,
          lastError: transportEvidence.lastError,
          lastErrorCode: transportEvidence.lastErrorCode,
          lastStaleReason: transportEvidence.lastStaleReason,
        },
        /**
         * Evidence only: the last 5 ended-action traces (`avatar.action.trace`), newest last.
         * Read-only copies so a caller can never mutate the runtime's records.
         */
        actionTrace: traceState.recent.map((record) => ({
          ...record, channels: [...record.channels], final: { ...record.final },
        })),
      },
      /** Discrete idle pool actually sampled, plus the fallback mode currently in force. */
      idleActions: {
        pool: [...installedIdleActions()],
        dropped: [...idlePool.dropped],
        degraded: [...idlePool.degraded],
        fallback: idlePool.fallback,
        /** True when ONE writable channel carries the idle motion at ALIVE_FALLBACK_GAIN. */
        aliveFallback: idlePool.aliveFallback,
        filtered: idlePool.filtered,
      },
      timerActive: timer !== null,
      /**
       * Serialized discrete actions. `started/ended` count real lifecycle transitions; `waiting`
       * is at most one candidate and `dropped` counts candidates a paced burst had to discard.
       */
      actions: {
        current: actionState.current === null ? null : {
          /** Stable id of THIS action; an animation event is never attributed across ids. */
          actionId: actionState.current.actionId,
          name: actionState.current.name,
          seq: actionState.current.seq,
          /** Communication-intent identity; null for a plain idle/host action. */
          intentGeneration: actionState.current.intentGeneration ?? null,
          sessionId: actionState.current.sessionId ?? null,
          turnId: actionState.current.turnId ?? null,
          /** P-139 reply identity carried by the intent that started this action. */
          replyId: actionState.current.replyId ?? null,
          /** Interrupt counter at action start; a later cut moves it. */
          interruptSeq: actionState.current.interruptSeq ?? null,
          event: actionState.current.event ?? '',
          /** Stage 4: the expression profile the action carries ('conclusion' | 'confused' | null). */
          profile: actionState.current.profile ?? null,
          /** Preset execution: the stable preset id and the ordered symbolic operations in flight. */
          presetId: actionState.current.presetId ?? null,
          /** Controller-side live-trajectory id; the answer-start takeover lookup uses it. */
          presetActionId: actionState.current.presetActionId ?? null,
          presetOperations: [...(actionState.current.presetOperations ?? [])],
          /** Scheduling time (when the scheduler started the action), not the animation's start. */
          startedAt: actionState.current.startedAt,
          /** Authoritative end: `startedAt + durationMs` for the fallback, `animation.startedAt + durationMs` when real. */
          endsAt: actionEndsAt(actionState.current),
          durationMs: actionState.current.durationMs,
          /** false only when the duration came from a matching VTS ModelAnimationEvent. */
          estimated: actionState.current.estimated !== false,
          durationSource: actionState.current.durationSource ?? 'fallback',
          remainingMs: Math.max(0, actionEndsAt(actionState.current) - clockNow()),
        },
        waiting: actionState.waiting.length,
        started: actionState.started,
        ended: actionState.ended,
        interrupted: actionState.interrupted,
        dropped: actionState.dropped,
        /** Matching Starts refused as idle-loop/outside-window, one record per action. */
        ignored: actionState.ignored,
      },
      /**
       * Last animation observed from VTS. `current` mirrors the ModelAnimationEvent the scheduler
       * is using; `null` means no live animation is known (End, model switch or disconnect).
       */
      animations: animationSnapshot(),
      speech: {
        speaking,
        mode: innerSnap.mouth.mode,
        active: innerSnap.mouth.active,
        owner: innerSnap.mouth.owner,
        token: innerSnap.mouth.token,
        /** Sentence-level action timing: the clip boundaries reported by the host, not a timer. */
        clip: {
          session: clipState.session,
          active: clipState.active,
          awaitingStart: clipState.awaitingStart,
          index: clipState.index,
          startedAt: clipState.startedAt,
          endedAt: clipState.endedAt,
          /**
           * P-139 stage 2 P1: where `startedAt` came from (`player-ready` / `first-data` /
           * `fallback`). The host reports the player's real start callback, never the pre-spawn
           * scheduling instant.
           */
          anchor: clipState.anchor,
          starts: clipState.starts,
          ends: clipState.ends,
          /**
           * LEGACY NAME, corrected meaning: incremented ONLY by a WAITING CANDIDATE started at a
           * clip start (`startWaitingCandidate(..., {timed:true})`). A `speechClip('start')` that
           * releases a staged communication intent does NOT increment it — that release is counted
           * in `intentEvents.releasedAtClipStart`. Kept so existing probes keep reading a number.
           */
          timed: clipState.timed,
          /** Explicit split: `timed` is the candidate-at-clip-start count; everything else is `other`. */
          candidate: { timed: clipState.timed, other: clipState.candidateOther },
        },
      },
      /**
       * Communication-event state (P-139 stage 2): the table in force, the staged intent (at most
       * one), the generation, and counters. `staged` counts admissions, `started` counts intents
       * that really became an action, `dropped` counts every refused/expired one with a reason.
       */
      intentEvents: {
        table: { ...intentState.table },
        tableInvalid: [...intentState.tableInvalid],
        tableIgnored: [...intentState.tableIgnored],
        generation: intentState.generation,
        sessionId: intentState.sessionId,
        turnId: intentState.turnId,
        /** P-139 reply identity of the current intent generation (null = not supplied). */
        replyId: intentState.replyId,
        /** Real interruptions seen; a same-reply continuation never crosses one. */
        interruptSeq: intentState.interruptSeq,
        pending: intentState.pending === null ? null : {
          event: intentState.pending.event,
          intent: intentState.pending.intent,
          mapped: intentState.pending.mapped,
          actionId: intentState.pending.ticket,
          generation: intentState.pending.generation,
          replyId: intentState.pending.replyId ?? null,
          since: intentState.pendingSince,
        },
        servedClip: intentState.servedClip,
        staged: intentState.staged,
        started: intentState.started,
        dropped: intentState.dropped,
        degraded: intentState.degraded,
        settled: intentState.settled,
        /**
         * Release-path evidence (never a selector, never a write): a real gesture released at a
         * clip-start boundary vs a release through any other path (action-busy deferral,
         * `speechEnd`, the no-session tick). The neutral `settle` is counted by `settled`.
         */
        releasedAtClipStart: intentState.releasedAtClipStart,
        releasedOther: intentState.releasedOther,
        lastEvent: intentState.lastEvent,
        lastIntent: intentState.lastIntent,
        lastActionId: intentState.lastActionId,
        /** Stage 4: the profile of the last released intent, so a repeat is provable. */
        lastProfile: intentState.lastIntentProfile,
        /** Stage 4: `markConclusion()` admissions and the ones refused as a back-to-back repeat. */
        conclusions: {
          marked: intentState.conclusionMarks,
          deduped: intentState.conclusionDeduped,
        },
      },
      inner: innerSnap,
    };
  }

  return {
    connect,
    disconnect,
    dispose,
    setMouthOwner,
    releaseOwner,
    speak,
    writeMouth,
    setMouthInput,
    setIdleParams,
    setChannelMappings,
    setStyle,
    setStatus,
    setIntent,
    // Motion preset execution (read-only library; symbolic operations, never the four intents).
    setPresetExecution,
    setPresetOverrides,
    selectPreset,
    preset,
    cancelPreset,
    setAnimation,
    interrupt,
    cancelAction,
    setAttention,
    lock,
    unlock,
    setMotionEnabled,
    intent,
    idle,
    tick,
    snapshot,
    /** Report one real playback clip boundary (sentence start/end); no timer is started. */
    speechClip,
    /** Close the speech session so the idle action rhythm can resume after the last clip. */
    speechEnd,
    /** Report one communication phase (turn-start / user-speaking / thinking / answer-* / idle / confused). */
    intentEvent,
    /** Drop the answer's opening intent (first body clip cancelled / expired) once, never retried. */
    dropAnswerStart,
    /** Mark one answer sentence as a conclusion: one slightly larger nod, never back-to-back. */
    markConclusion,
    /** Conversation-end relax: decay the posture to the base over 2–4 s, no jump. */
    relax,
    /** Replace the event → intent table without restarting the runtime. */
    setIntentTable,
    // Exposed for hosts that flush themselves instead of using tick()'s coalesced flush.
    takePendingFrame: () => (state.disposed ? new Map() : inner.takePendingFrame()),
    // Runtime events (mouth lifecycle, idle tuning/suppression) in one bounded stream.
    takeEvents: () => {
      const buffered = idleEvents.splice(0, idleEvents.length);
      return [...buffered, ...inner.takeEvents()];
    },
    /**
     * Preset animations the host should trigger NOW: one entry per STARTED action (never a burst
     * of overlapping ones). The runtime has already paced and serialized them.
     */
    takeActions: () => {
      if (state.disposed) return [];
      const list = actionState.delivered.slice();
      actionState.delivered.length = 0;
      return list;
    },
    get pendingFrame() {
      return state.disposed ? new Map() : inner.pendingFrame;
    },
    config: { ...host },
  };
}
