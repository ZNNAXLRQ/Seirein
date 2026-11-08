/** motion-controller — extracted from avatarRuntime.js; no host entry dependency. */
import { isMotionProfile } from './motionEvents.js';
import {
  ARBITRATION,
  BREATH,
  CHANNELS,
  LIMITS,
  SPRING_AXES,
  TIMING,
  clamp01,
  clampSigned,
  createSeededRandom,
  finite,
  hash32,
  isBidirectional,
  smoothNoise1,
  smoothstep,
} from './motion-primitives.js';
import {
  AVATAR_STYLE_CHANNEL_RANGES,
  DEFAULT_AVATAR_STYLE,
  coerceAvatarStyle,
  deriveAvatarStyleDimensions,
  normalizeAvatarStyle,
  styleChannelAmplitude,
} from './style.js';
import {
  INTENT_CHANNEL_TARGETS,
  INTENT_IDLE_RATIO,
  INTENT_KINDS,
  INTENT_SETTLE_MS,
  INTENT_VARIANTS,
  MOTION_STATUSES,
  SPEECH_HEAD_DAMP,
  STATUS_MODIFIERS,
  STYLE_DIMENSION_APPLICATION,
  intentChannelsFor,
} from './motion-config.js';
import { composeChannels, normalizeGaze } from './mixer.js';
import { createBlinkState, springParams, stepBlink, stepSpringAxis } from './dynamics.js';

// ---------------------------------------------------------------------------------------------
// Facade — stateful, still I/O free
// ---------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------
// Continuous motion: one posture controller, low-frequency decisions, high-frequency output
// ---------------------------------------------------------------------------------------------

/** Axes the posture controller owns. Gaze is generated here too, but an explicit target wins. */
const MOTION_AXES = Object.freeze(['headX', 'headY', 'headZ', 'bodyX', 'gazeX', 'gazeY']);


/**
 * The idle decision cadence. Decisions are deliberately slow (1 Hz, allowed 0.5–2 Hz): the
 * controller samples its posture at this rate while output is interpolated at `outputHz`
 * (30 Hz by default), so a decision never means a visible step.
 */
export const MOTION_DECISION_HZ = 1;


/**
 * A base posture hold is 6–12 s. A lively persona gets the OPTIONAL 4–8 s variant (see the stage-4
 * allocation below); the hold chance / still chance are untouched, so a short window is still a
 * hold, not a forced re-draw.
 */
export const POSTURE_HOLD_MIN_MS = 10_000;

export const POSTURE_HOLD_MAX_MS = 20_000;


/**
 * Relaxation after a conversation: amplitude/tempo fall smoothly towards a looser baseline.
 * The delay keeps a short inter-sentence pause from being read as "conversation over".
 */
export const RELAXATION = Object.freeze({
  DELAY_MS: 600,
  DURATION_MS: 1800,
  AMPLITUDE_DROP: 0.08,
  TEMPO_DROP: 0.12,
});


/** Trajectory limits for every posture axis: position is C¹ and acceleration is bounded. */
export const MOTION_LIMITS = Object.freeze({
  FOLLOW_PER_SECOND: 1.4,
  MAX_VELOCITY: 0.115,
  MAX_ACCELERATION: 4.0,
});


/**
 * P-139 posture expression. A goal is reached through a planned smootherstep transition, so a
 * visibly different target lands in 1.2–1.8 s instead of the old ~17 s crawl of the 0.115/s
 * hold tracker. `MAX_VELOCITY`/`MAX_ACCELERATION` are the analytic bounds of the smootherstep
 * for the widest possible move (2 normalized units in the shortest 1.2 s): 1.875·2/1.2 and
 * 5.77·2/1.2². The hold tracker below keeps its own much smaller limits between moves.
 */
export const POSTURE_TRANSITION = Object.freeze({
  BASE_MS: 1500,
  MIN_MS: 1200,
  MAX_MS: 1800,
  MAX_VELOCITY: 3.2,
  MAX_ACCELERATION: 8.1,
});


// ---------------------------------------------------------------------------------------------
// P-139 stage 4 — "why each motion happens": the A / B / C allocation
// ---------------------------------------------------------------------------------------------
//
// Nothing here speeds the avatar up as a whole. The three bands are separate allocations, each one
// scoped to a different CAUSE:
//
//   A  hold      a lively persona may hold for 4–8 s; every other persona keeps 6–12 s. The range is
//                per-decision and the still/hold outcomes stay exactly as likely. An explicit host
//                `postureHoldMinMs`/`postureHoldMaxMs` always wins, so a test or a tuning profile
//                can pin the window.
//   B  transition short RESPONSE actions (light nod / conclusion nod / listening micro reply /
//                confused tilt) land in 0.8–1.2 s; an idle posture re-draw keeps 1.2–1.8 s.
//   C  amplitude ONLY the occasional actions (conclusion nod / confused tilt) may reach 12–14°.
//                A normal gesture and the idle posture keep their stage-3 ranges.

/** The liveliness at which the optional 4–8 s hold variant becomes available. */
export const LIVELY_HOLD_THRESHOLD = 0.65;


/** A: the hold windows. `base` is the default for every persona, `lively` is the optional variant. */
export const POSTURE_HOLD_ALLOCATION = Object.freeze({
  base: Object.freeze({ MIN_MS: POSTURE_HOLD_MIN_MS, MAX_MS: POSTURE_HOLD_MAX_MS }),
  lively: Object.freeze({ MIN_MS: 4_000, MAX_MS: 8_000 }),
});


/** B: the short-response transition window (idle re-draws keep POSTURE_TRANSITION). */
export const SHORT_ACTION_TRANSITION = Object.freeze({
  MIN_MS: 800,
  MAX_MS: 1_200,
  BASE_MS: 900,
});


/** Intent kinds that count as a short response (they are the ones that may use B). */
export const SHORT_ACTION_INTENTS = Object.freeze(['nod', 'tilt']);


/** C: the occasional-action ceiling. `AMPLITUDE`/`DURATION` make a conclusion nod slightly larger. */
export const OCCASIONAL_ACTION = Object.freeze({
  MIN_DEGREES: 12,
  MAX_DEGREES: 14,
  /**
   * Headroom kept under the 14° ceiling for the (damped) spring overshoot: the written target is
   * capped at 13.5°, so the POSED angle still stays inside 12–14° instead of overshooting past it.
   */
  CHANNEL_MARGIN_DEGREES: 0.5,
  /** One normalized pose unit is the documented ±30° channel range (the same 30 used by the writer). */
  DEGREES_PER_POSE_UNIT: 30,
  AMPLITUDE: 1.22,
  DURATION: 1.15,
  /**
   * Confusion is a SINGLE raised brow: the side the head tilts towards goes up (1.0 × the envelope,
   * capped at BROW_MAX), the other side goes slightly down (−0.3 ×). Both are already-mapped brow
   * channels; nothing new is invented.
   */
  BROW_RAISED: 1.0,
  BROW_LOWERED: -0.3,
  /** Kept for callers/tests that name the old pair; `BROW_RIGHT` is now the lowered side. */
  BROW_LEFT: 1.0,
  BROW_RIGHT: -0.3,
  BROW_MAX: 0.4,
});


/**
 * Autonomous expression layer (stage 4 continuation). These are NOT new intents and NOT new
 * channels: each one is a bounded envelope generated on the existing 30 Hz tick, folded into the
 * ONE composed pose. They only ever touch channels the writer already had (gaze / brow / body /
 * head); an unmapped channel is skipped like any other write.
 *
 *   thinking      eyes drift up + a small brow lift, 0.9 s (inside the 0.4–1.2 s brief)
 *   listening     eyes return to centre (only when the host has no verified target) plus a small
 *                 forward pitch / body lean, 1.1 s
 *   glance        20–40 s apart: a small gaze drift (≤0.15)
 *   weight-shift  20–40 s apart: a small roll/body shift (roll ≤0.54°, body ≤0.9°)
 *
 * The caps below are the motion budget, applied per expression before anything is added to the
 * pose: head ≤14°, gaze ≤0.7, body ≤10°. They are deliberately far larger than the actual values,
 * so the caps are a guarantee, not a target.
 */
export const EXPRESSION_MOTION = Object.freeze({
  THINKING_MS: 900,
  THINKING_GAZE_Y: 0.12,
  THINKING_BROW_RAISED: 0.2,
  THINKING_BROW_OTHER: 0.12,
  LISTENING_MS: 1100,
  /** A small forward pitch; on models that map FaceAngleY → ParamBodyAngleY the body follows too. */
  LISTENING_HEAD_Y: 0.025,
  LISTENING_BODY_Y: 0.02,
  LISTENING_BODY_X: 0.01,
  OCCASIONAL_MIN_MS: 20_000,
  OCCASIONAL_MAX_MS: 40_000,
  OCCASIONAL_MS: 2200,
  OCCASIONAL_GAZE_X: 0.15,
  OCCASIONAL_HEAD_Z: 0.018,
  OCCASIONAL_BODY_X: 0.03,
  /** Hard caps (one semantic unit is 30°, see OCCASIONAL_ACTION.DEGREES_PER_POSE_UNIT). */
  MAX_HEAD_DEGREES: 14,
  MAX_GAZE: 0.7,
  MAX_BODY_DEGREES: 10,
  /** A phase change fades the previous expression out instead of snapping it back to zero. */
  CANCEL_FADE_MS: 160,
});


/**
 * The 14° head budget in SEMANTIC units (1 unit = 30°). Every head channel shares it; the roll is
 * the one axis whose VTS input range is far wider (±90), so a composed roll could otherwise ask for
 * 30°+ on the wire. It is capped HERE, on the semantic pose, before the writer: the input layer is
 * never used as the clamp.
 */
const HEAD_ROLL_CAP = EXPRESSION_MOTION.MAX_HEAD_DEGREES / OCCASIONAL_ACTION.DEGREES_PER_POSE_UNIT;


/** Clamp a semantic head-roll value to the shared 14° head budget. */
const clampHeadRoll = (value) => Math.max(-HEAD_ROLL_CAP, Math.min(HEAD_ROLL_CAP, finite(value, 0)));


/**
 * Expression RELEASE window — the tail of an autonomous expression. An expression drives channels
 * the idle frame does not own (gaze / brow / body / roll), so dropping them from the write set the
 * moment the envelope ends leaves the VTS input at its LAST non-zero value: the model keeps the
 * "thinking" gaze until something else happens to write that input. The channel therefore stays a
 * write channel after the envelope ends, until the pose is provably back at the baseline:
 *
 *   settled  — `SETTLE_FRAMES` consecutive writes with |value| ≤ ε or |value − idle base| ≤ ε;
 *   timeout  — after `MAX_HOLD_MS` the release writes EXACTLY ONE 0 and lets the channel go, so a
 *              slow spring can never hold a channel forever. The forced write is delivered by the
 *              next frame that really flushes the channel; `PRUNE_MS` is the hard safety net for a
 *              channel whose write never arrives (unmapped/unverified meanwhile), so an entry can
 *              never stay resident.
 *
 * A channel a NEW expression or intent takes over is handed off directly: its release entry is
 * dropped, so nothing is zeroed under the new owner (no dip-then-rise artefact).
 */
export const EXPRESSION_RELEASE = Object.freeze({
  MAX_HOLD_MS: 400,
  /** Hard safety bound for a release whose forced write never reaches the transport. */
  PRUNE_MS: 2400,
  BASELINE_EPSILON: 0.005,
  SETTLE_FRAMES: 3,
});


/**
 * Visible floor for an explicit intent's PRIMARY axis. The persona/restraint/variant scaling may
 * shrink a quiet persona's gesture to a fraction of a degree (a real-machine `tilt` measured
 * amplitude 0.0116 ≈ 0.35°, invisible), so an intent is never allowed to fall under this floor.
 * The values are semantic units: one unit is 30° (the same conversion the writer uses), so
 * 0.12 ≈ 3.6°, 0.2 = 6°, 0.27 ≈ 8.1°. The C ceiling still caps an occasional action's final
 * channel values (see `intentFrame`), and the floor is the ONLY thing that can override restraint.
 */
export const INTENT_VISIBILITY = Object.freeze({
  /** The absolute floor for a plain intent's primary axis: ≈4.0° at the soft floor's bottom. */
  MIN_SEMANTIC: 0.19,
  /** `answer-start` / ordinary nod: headY 4–6°; the soft floor keeps 4.1–6° on a quiet persona. */
  NOD_SEMANTIC: 0.2,
  /** `conclusion` nod: a marked occasional action may use the C band → headY 7.2° (6–8°). */
  CONCLUSION_SEMANTIC: 0.24,
  /** `confused` tilt: headX 8–10°; the roll is capped by C at 14°. */
  CONFUSED_HEADX_SEMANTIC: 0.33,
  /**
   * A hard floor would flatten two quiet personas onto one amplitude (breaking style ordering),
   * so a plain intent's value under the floor is lifted into [RATIO·floor, floor] monotonically:
   * the gesture stays visible, and a gentler persona still moves less than a louder one. An
   * OCCASIONAL profile (conclusion/confused) is an intentional mark and uses the full floor.
   */
  FLOOR_RATIO: 0.7,
});


/**
 * B (expression) — while the voice is actually playing, the pitch channel carries a continuous,
 * low-frequency sway. Its phase is REAL time (so it never restarts per sentence and tempo cannot
 * stretch it); a smoothed gain pauses it for an active gesture and resumes it afterwards. It only
 * ever writes headY (a verified channel); headX/gaze/body/breath are deliberately untouched.
 */
export const SPEECH_MICRO_MOTION = Object.freeze({
  MIN_DEGREES: 1,
  MAX_DEGREES: 2,
  MIN_FREQUENCY_HZ: 0.3,
  MAX_FREQUENCY_HZ: 0.7,
  /** Gain ramp per second: a pause/resume fades in ~250 ms instead of snapping the head. */
  GAIN_PER_SECOND: 4,
});


/**
 * The visible floor, converted from the primary-axis semantics into the intent's own amplitude
 * scalar. A nod's scalar IS its headY amplitude; a tilt's headX is `amplitude × yawRatio`, so the
 * scalar has to be divided by both the variant's yaw ratio and the channel's style scale. Only
 * nod/tilt carry a floor: a gaze look and a surprise were never the invisible case, and their
 * channels have their own verified ranges.
 */
const intentVisibleFloor = (kind, profile, { yawRatio = 1, channelScale = 1 } = {}) => {
  const scale = Math.max(1e-6, finite(channelScale, 1));
  if (kind === 'nod') {
    const semantic = profile === 'conclusion'
      ? INTENT_VISIBILITY.CONCLUSION_SEMANTIC
      : INTENT_VISIBILITY.NOD_SEMANTIC;
    return semantic / scale;
  }
  if (kind === 'tilt') {
    const semantic = profile === 'confused'
      ? INTENT_VISIBILITY.CONFUSED_HEADX_SEMANTIC
      : INTENT_VISIBILITY.MIN_SEMANTIC;
    return semantic / (Math.max(1e-6, finite(yawRatio, 0.5)) * scale);
  }
  return 0;
};


/**
 * Lift an amplitude that fell under its visible floor into `[ratio·floor, floor]` (monotonic in
 * the raw value), instead of replacing it with one flat minimum. A value already at/above the
 * floor is returned unchanged. A ratio of 1 is a hard floor (occasional profiles).
 */
const applyVisibleFloor = (raw, floor, ratio = INTENT_VISIBILITY.FLOOR_RATIO) => {
  const target = finite(floor, 0);
  if (!(target > 0) || raw >= target) return raw;
  const strength = Math.max(0, Math.min(1, finite(ratio, INTENT_VISIBILITY.FLOOR_RATIO)));
  // Squared blend: a very quiet persona sits near the floor's bottom, a just-under-floor persona
  // is almost untouched — that keeps the gentle < restrained < lively ordering intact.
  const blend = clamp01(finite(raw, 0) / target) ** 2;
  return target * (strength + (1 - strength) * blend);
};


/**
 * The tiny drift a hold keeps: one deterministic noise stream per head axis at ~0.05 Hz (a ~20 s
 * lattice) evaluated on the existing 30 Hz tick. No timer, no second generator. It scales with the
 * idle sway, so `idleSwayScale: 0` (an explicit "no idle sway") stays exactly still.
 */
export const HOLD_MICRO_DRIFT = Object.freeze({
  DEGREES: 1,
  FREQUENCY_HZ: 0.05,
});


/** Item 4: conversation-end relax. The posture decays to the base over 2–4 s, never in one step. */
export const RELAX_PLAN = Object.freeze({
  MIN_MS: 2_000,
  MAX_MS: 4_000,
  BASE_MS: 3_000,
});


/** Gain on the idle posture curve with a normal persona (amplitude 1); see advanceGenerators. */
export const POSTURE_REACH = 1.5;


/** C² ease for a planned posture transition: both ends have zero velocity and acceleration. */
const smootherstep = (t) => {
  const u = clamp01(t);
  return u * u * u * (u * (u * 6 - 15) + 10);
};


/**
 * A conclusion nod's envelope: rise → a marked affirmation HOLD → release. `sin(πt)` is the normal
 * one-shot shape; a conclusion instead pauses at the bottom for ~30% of its duration (one visible
 * "yes", not the speech micro-motion repeating). Both ends are smootherstep, so velocity is 0 at
 * the plateau edges and the pose never jerks.
 */
const conclusionEnvelope = (t) => {
  const u = clamp01(t);
  if (u < 0.35) return smootherstep(u / 0.35);
  if (u <= 0.65) return 1;
  return 1 - smootherstep((u - 0.65) / 0.35);
};


const DEFAULT_CONFIG = Object.freeze({
  computeHz: TIMING.COMPUTE_HZ,
  flushIntervalMs: TIMING.FLUSH_INTERVAL_MS,
  injectTimeoutMs: TIMING.INJECT_TIMEOUT_MS,
  mouthStepMs: TIMING.MOUTH_STEP_MS,
  speechGain: 1,
  breathPeriodMs: 3600,
  gazeFollowMs: TIMING.GAZE_FOLLOW_SECONDS * 1000,
  gazeFadeMs: TIMING.GAZE_FADE_SECONDS * 1000,
  /** Default spring feel: fairly tight follow, moderate inertia. */
  spring: { follow: 0.7, inertia: 0.35 },
  /**
   * Tracking input the mouth writer addresses, as discovered for this model (`mouthInput`, or
   * `inputs.mouth` from discoverCapabilities). There is deliberately **no** default: a model
   * without a mapped mouth input must refuse the write instead of guessing `ParamMouthOpenY`
   * (spec §C.1 — the mapping always comes from InputParameterListRequest).
   */
  mouthInput: null,
  /** Discovered channel → input map (`avatarMotion` capabilities); only `mouth` is read here. */
  inputs: null,
  /** Idle actions: one candidate per interval, the same action blocked for the dedupe window. */
  idleActions: Object.freeze(['sway', 'tilt', 'glance', 'nod']),
  /** One candidate per 7 s: a perceptible rhythm that is still slower than speech. */
  idleActionIntervalMs: 7000,
  idleActionDedupeMs: 20000,
  /**
   * Continuous idle parameter map (channel → discovered `{inputName, min?, max?, gain?}` or an
   * input name). When present the facade writes the idle pose through the single transport
   * writer; no default, because only discovery may name a model's inputs.
   */
  idleParams: null,
  /** Extra gain applied to the idle curve before it is converted into an input value. */
  idleParamGain: 1,
  /** Multiplier on the generated gaze/head/body idle swing; keep it small, expose it for tuning. */
  idleSwayScale: 1.2,
  /** Persona-derived baseline style (read-only at tick time; see `setStyle`). */
  style: DEFAULT_AVATAR_STYLE,
  /** Version of the cached style, for status/tests; never used to gate motion. */
  styleVersion: '',
  /** P-139: how far a drawn posture may reach (amplitude 1 persona). Quiet personas stay small. */
  postureReach: POSTURE_REACH,
  /** A decision may choose NOT to move: the target is drawn at the current pose. */
  postureStillChance: 0.25,
  /** Listening/thinking keeps its attention direction: most decisions hold or barely move. */
  postureListenStillChance: 0.85,
  /** Base planned transition length; divided by persona tempo, then clamped to 1.2–1.8 s. */
  postureTransitionMs: POSTURE_TRANSITION.BASE_MS,
  /** Host-driven state (listening/thinking/speaking/waiting/tired); scales, never rewrites, style. */
  status: 'idle',
  /** Optional transport write hook `({input, value}) => void|{ok:false}`; throws are isolated. */
  writer: null,
  /** Mapped channels, used only to report `snapshot().channels` (transport owns discovery). */
  channels: null,
  /**
   * Determinism: every random choice uses this sequence when `seed` is finite. Without a seed the
   * legacy `random` function is kept, so the existing host contract is unchanged.
   */
  seed: undefined,
  /** Decision cadence (0.5–2 Hz) and the posture hold range. */
  decisionHz: MOTION_DECISION_HZ,
  postureHoldMinMs: POSTURE_HOLD_MIN_MS,
  postureHoldMaxMs: POSTURE_HOLD_MAX_MS,
  /** Probability that the next decision simply keeps the current posture (a legal hold). */
  postureHoldChance: 0.35,
  /** Continuous controller: follow strength, velocity and acceleration bounds. */
  motionFollow: MOTION_LIMITS.FOLLOW_PER_SECOND,
  motionMaxVelocity: MOTION_LIMITS.MAX_VELOCITY,
  motionMaxAcceleration: MOTION_LIMITS.MAX_ACCELERATION,
  /** Conversation-end relaxation (see RELAXATION). */
  relaxDelayMs: RELAXATION.DELAY_MS,
  relaxDurationMs: RELAXATION.DURATION_MS,
  relaxAmplitudeDrop: RELAXATION.AMPLITUDE_DROP,
  relaxTempoDrop: RELAXATION.TEMPO_DROP,
  random: Math.random,
  now: null,
});


const neutralPose = () => {
  const pose = {};
  for (const channel of CHANNELS) pose[channel] = isBidirectional(channel) ? 0 : channel === 'eyeOpenL' || channel === 'eyeOpenR' ? 1 : 0;
  pose.breath = 0.5;
  return pose;
};


/** Resolve the next mouth level index for a 100 ms-per-level envelope. */
const levelIndex = (elapsedMs, stepMs, length) => {
  const raw = Math.floor(Math.max(0, elapsedMs) / stepMs);
  return Math.max(0, Math.min(length - 1, raw));
};


/**
 * Deterministic text → mouth envelope, one level per `stepMs` slice (100 ms by default).
 *
 * The runtime never reads audio, so `startSpeech({text, durationMs})` derives a plausible
 * time-sliced envelope from the text itself: punctuation becomes a short close and every other
 * character maps onto a stable amplitude. The same text always yields the same envelope, which
 * keeps tests reproducible; real lip-sync callers may pass an explicit `levels` array instead.
 *
 * @param {string} text
 * @param {number} durationMs
 * @param {number} [stepMs]
 * @returns {number[]} levels in [0, 1], one per `stepMs`
 */
export function buildSpeechLevels(text, durationMs, stepMs = TIMING.MOUTH_STEP_MS) {
  const chars = Array.from(String(text ?? '').replace(/\s+/gu, ''));
  const step = Math.max(1, finite(stepMs, TIMING.MOUTH_STEP_MS));
  const count = Math.max(1, Math.ceil(Math.max(0, finite(durationMs, 0)) / step));
  return Array.from({ length: count }, (_, index) => {
    if (chars.length === 0) return 0;
    const ch = chars[Math.min(chars.length - 1, Math.floor((index * chars.length) / count))];
    if (/[，。！？、；：,.!?;:]/u.test(ch)) return 0.05;
    const base = 0.2 + 0.75 * ((ch.codePointAt(0) % 89) / 88);
    return clamp01(base * (0.85 + 0.15 * Math.sin(index * 1.7)));
  });
}


/**
 * Create the stateful behavior runtime.
 *
 * It owns: turnId / playbackToken, the single mouth sender + its per-session token, idle action
 * scheduling, the last composed Pose, one spring state per head/body axis, the blink state
 * machine, the squint decay, the speech envelope + release, and transport counters. It performs
 * **no** flush and **no** network call: every tick leaves the semantic Pose in
 * `runtime.pendingFrame` (a Map of channel → semantic value) for the transport stage to take,
 * quantise with `toInputValue` and coalesce.
 *
 * @param {{config?: Partial<typeof DEFAULT_CONFIG>}} [options]
 * @returns {{
 *   pendingFrame: Map<string, number>,
 *   tick: (nowMs?: number) => Pose,
 *   beginTurn: (options?: {reason?: string}) => {turnId: number, token: number},
 *   getPlaybackToken: () => number,
 *   interrupt: (options?: {reason?: string}) => {token: number, turnId: number, reason: string},
 *   setSpeech: (options: {turnId?: number, token?: number, levels?: number[], level?: number,
 *                         startedAt?: number, durationMs?: number, stepMs?: number}) => object,
 *   startSpeech: (options?: object) => object,
 *   endSpeech: (options?: {token?: number}) => object,
 *   writeMouth: (options: {value: number, token: number, owner?: string}) => Promise<object>,
 *   setIntent: (patch?: object) => object,
 *   takePendingFrame: () => Map<string, number>,
 *   takeEvents: () => object[],
 *   takeActions: () => object[],
 *   snapshot: () => object,
 * }}
 */
export function createBehaviorRuntime({ config = {} } = {}) {
  const supplied = config ?? {};
  const seeded = supplied.seed !== undefined && supplied.seed !== null
    ? createSeededRandom(supplied.seed)
    : null;
  const cfg = {
    ...DEFAULT_CONFIG,
    ...supplied,
    spring: { ...DEFAULT_CONFIG.spring, ...(supplied.spring ?? {}) },
    random: seeded ?? (typeof supplied.random === 'function' ? supplied.random : Math.random),
    now: typeof supplied.now === 'function' ? supplied.now : null,
  };
  const random = cfg.random;
  // Motion uses its own deterministic stream when a seed is given; without one it stays on a
  // fixed lattice so the default idle curve is reproducible (the visible host motion has always
  // been stable across runs, and the style/ratio tests rely on that).
  const motionSeed = hash32(
    typeof cfg.seed === 'number' && Number.isFinite(cfg.seed) ? cfg.seed : 0,
    `${cfg.seed === undefined ? 'default' : String(cfg.seed)}:motion`,
  );
  const motionRandom = seeded ?? createSeededRandom('dsh-motion-default');
  // The occasional micro-action has its own seeded stream: adding it must not shift the blink /
  // posture / variant sequences a test (or the recorded default idle curve) already pins.
  const expressionRandom = createSeededRandom(
    `${cfg.seed === undefined ? 'default' : String(cfg.seed)}:expression`,
  );
  const postureHoldMinMs = Math.max(1000, finite(cfg.postureHoldMinMs, DEFAULT_CONFIG.postureHoldMinMs));
  const postureHoldMaxMs = Math.max(postureHoldMinMs, finite(cfg.postureHoldMaxMs, DEFAULT_CONFIG.postureHoldMaxMs));
  // P-139 stage 4 (A): an explicitly configured window is authority; only an unconfigured runtime
  // picks the lively 4–8 s variant. This keeps a tuning profile / test deterministic.
  const postureHoldConfigured = Object.prototype.hasOwnProperty.call(supplied, 'postureHoldMinMs')
    || Object.prototype.hasOwnProperty.call(supplied, 'postureHoldMaxMs');
  const decisionIntervalMs = 1000 / Math.max(0.1, Math.min(8, finite(cfg.decisionHz, DEFAULT_CONFIG.decisionHz)));
  const motionFollow = Math.max(0.05, finite(cfg.motionFollow, MOTION_LIMITS.FOLLOW_PER_SECOND));
  const motionMaxVelocity = Math.max(0.001, finite(cfg.motionMaxVelocity, MOTION_LIMITS.MAX_VELOCITY));
  const motionMaxAcceleration = Math.max(0.001, finite(cfg.motionMaxAcceleration, MOTION_LIMITS.MAX_ACCELERATION));
  // P-139 stage 3: the persona dimensions and the variant stream are decided ONCE per runtime.
  // The variant seed follows `cfg.seed` (not the style) so two personas of the same runtime source
  // still draw the same replacement sequence; the dimension seed follows the persona version.
  const initialStyle = coerceAvatarStyle(cfg.style);
  const initialStyleVersion = String(cfg.styleVersion ?? '');
  const initialDimensions = deriveAvatarStyleDimensions(initialStyle, { styleVersion: initialStyleVersion });
  const variantSeed = hash32(
    typeof cfg.seed === 'number' && Number.isFinite(cfg.seed) ? cfg.seed : 0,
    `${cfg.seed === undefined ? 'default' : String(cfg.seed)}:variant`,
  );

  const state = {
    turnId: 0,
    playbackToken: 0,
    lastTurnReason: '',
    turnStartedAt: 0,
    intent: { gaze: null, pose: {}, squint: 0, touch: null, flags: { idle: true, breathing: true } },
    speech: null,
    release: null,
    squint: 0,
    blink: createBlinkState({ random, baseline: 1 }),
    blinkFactor: 1,
    springs: Object.fromEntries(SPRING_AXES.map((axis) => [axis, { current: 0, velocity: 0 }])),
    gaze: { x: 0, y: 0, weight: 0 },
    idle: neutralPose(),
    breathPhase: 0,
    idleMs: 0,
    /**
     * The ONE continuous posture controller. It owns the slow natural posture every layer is
     * mixed on top of: decision state, per-axis position/velocity, hold window, relaxation and
     * the attention basis. Nothing else writes these axes.
     */
    motion: {
      initialized: false,
      decisionAccMs: 0,
      lastDecisionAt: null,
      nextDecisionAt: 0,
      /**
       * The held goal, the hold window and the observable transition count. `target` is the goal
       * the pose is converging on; `remainingMs` is time left in the current hold (observation only).
       */
      posture: {
        target: Object.fromEntries(MOTION_AXES.map((axis) => [axis, 0])),
        /** The last IDLE-drawn goal. A short action nudges from HERE, so nudges never accumulate. */
        base: Object.fromEntries(MOTION_AXES.map((axis) => [axis, 0])),
        heldSince: 0,
        remainingMs: 0,
        transitions: 0,
        /** B: posture landings caused by a short response action (not idle re-draws). */
        shortTransitions: 0,
        /** Item 4: posture decays planned by `relax()` (2–4 s each). */
        relaxTransitions: 0,
        stills: 0,
        lastDecision: null,
        lastTransition: null,
      },
      /** The one active planned transition (null while holding / drifting). */
      transition: null,
      axes: Object.fromEntries(MOTION_AXES.map((axis) => [axis, { current: 0, velocity: 0 }])),
      postureSwitches: 0,
      postureHolds: 0,
      postureDecisions: 0,
      holdUntil: 0,
      holdMs: 0,
      /** A: which allocation produced the current window ('lively' | 'base' | 'config'). */
      holdVariant: 'base',
      /** The tiny hold drift, in normalized pose units (≤1° per head axis). */
      holdDrift: { headX: 0, headY: 0, headZ: 0 },
      /** B: the last short response action that nudged the posture (observation only). */
      shortAction: null,
      relax: 0,
      relaxStartedAt: null,
      /** Item 4: the explicit 2–4 s decay started by `relax()` (`{startedAt, durationMs, from}`). */
      relaxPlan: null,
      wasSpeaking: false,
      frames: 0,
      lastFrameAt: null,
      /** Attention is neutral unless a caller proves a verified user target exists. */
      attention: { mode: 'neutral', target: { x: 0, y: 0 }, verified: false, source: 'default' },
    },
    /** Persona style is the BASELINE; `effective` is the temporary per-state scaling of it. */
    style: initialStyle,
    styleVersion: initialStyleVersion,
    /** P-139 stage 3: persona-derived expression dimensions (never an intent selector). */
    dimensions: initialDimensions,
    status: MOTION_STATUSES.includes(cfg.status) ? cfg.status : 'idle',
    statusChangedAt: 0,
    effective: null,
    /** A separate time base advanced by style tempo, so rhythm never changes the real clock. */
    styleClockMs: 0,
    /** Smoothed 0..1 gain of the speaking pitch sway (paused by an active gesture, resumed after). */
    speechMicroGain: 0,
    /** Active + settling one-shot intents (see `intent()` / `intentFrame()`). */
    intents: [],
    intentSeq: 0,
    /**
     * Autonomous expression layer: short status gestures (`thinking`, `listening`) and the rare
     * `glance` / `weight-shift` micro-action. Same tick, same writer, no extra timer; every record
     * is a bounded envelope (see EXPRESSION_MOTION).
     */
    expressions: [],
    expressionGaze: { x: 0, y: 0 },
    /**
     * Channels an expression stopped driving that are still being written until the pose is back
     * at the baseline: channel → `{ kind, atMs, frames, last }`. See EXPRESSION_RELEASE.
     */
    releases: new Map(),
    /** 20–40 s seeded schedule for the occasional micro-action (never a random jitter stream). */
    occasional: { nextAt: null, starts: 0, lastAt: null, lastKind: '' },
    /** The additive axis target of the LAST tick's intents (observation only; 0 = idle base). */
    lastIntentFrame: null,
    /**
     * P-139 stage 3 variant selection: one seeded stream per intent kind, the last variant of each
     * kind (so a repeat is impossible back-to-back) and the last choice exposed in the snapshot.
     */
    variant: { seed: variantSeed, streams: new Map(), last: Object.create(null), lastInfo: null },
    lastAt: null,
    lastPose: null,
    pendingFrame: new Map(),
    counters: { computed: 0, taken: 0, overwritten: 0, dropped: 0 },
    lastSpeech: { index: -1, level: 0, speaking: false },
    /**
     * Mouth ownership: exactly one sender at a time. `token` is allocated once per session and
     * every older token dies on the next acquire / release, so late frames cannot write.
     */
    mouth: {
      active: false,
      owner: null,
      token: 0,
      seq: 0,
      live: false,
      level: 0,
      writes: 0,
      rejected: 0,
      failed: 0,
      unmapped: 0,
      /** `avatar.mouth.unmapped` is diagnostic noise if repeated per frame: log once per session. */
      unmappedLogged: false,
      /** Late writes that lost ownership during `await`: one `avatar.mouth.stale` per reason/session. */
      stale: 0,
      staleLogged: new Set(),
      busy: 0,
      takeovers: 0,
      ended: 0,
    },
    /** Idle action scheduler: one candidate per interval, deduped per action name. */
    idleAction: { accMs: 0, emitted: 0, suppressed: 0, last: null, queue: [], seen: new Map() },
    /** Bounded diagnostic log — transport failures and lifecycle decisions land here. */
    events: [],
    errors: 0,
    interrupts: 0,
    lastInterruptReason: '',
    lastError: '',
  };

  const clockNow = () => {
    if (cfg.now !== null) {
      const value = Number(cfg.now());
      if (Number.isFinite(value)) return value;
    }
    return state.lastAt ?? 0;
  };

  // The initial dimensions are emitted once the diagnostics buffer exists (see EVENTS_MAX).

  // ---- unified continuous posture controller --------------------------------------------
  const clampMotion = (value, limit) => Math.max(-limit, Math.min(limit, finite(value, 0)));

  /** Current persona tempo (baseline × state modifier): the rhythm used for hold/transition. */
  function postureTempo() {
    const effective = state.effective ?? state.style;
    return Math.max(0.2, finite(effective?.tempo, finite(state.style?.tempo, 1)));
  }

  /**
   * The hold window in force (A). An explicit host config always wins; otherwise the lively persona
   * gets the optional 4–8 s variant and every other persona keeps the 6–12 s base.
   */
  function postureHoldBounds() {
    if (postureHoldConfigured) return { min: postureHoldMinMs, max: postureHoldMaxMs };
    return state.dimensions.liveliness >= LIVELY_HOLD_THRESHOLD
      ? { min: POSTURE_HOLD_ALLOCATION.lively.MIN_MS, max: POSTURE_HOLD_ALLOCATION.lively.MAX_MS }
      : { min: POSTURE_HOLD_ALLOCATION.base.MIN_MS, max: POSTURE_HOLD_ALLOCATION.base.MAX_MS };
  }

  /**
   * Start one hold window. A slower persona still stretches the window inside its allocation, but A
   * never leaves the band: a lively persona lands in 4–8 s, everyone else in 6–12 s. Nothing here
   * forces a change at expiry; the still/hold outcomes are untouched.
   */
  function rollPostureHold(now) {
    const motion = state.motion;
    const bounds = postureHoldBounds();
    motion.holdVariant = postureHoldConfigured
      ? 'config'
      : bounds.min === POSTURE_HOLD_ALLOCATION.lively.MIN_MS ? 'lively' : 'base';
    const tempo = postureTempo();
    const stay = Math.max(0.8, Math.min(1.5, 1 / tempo));
    const base = bounds.min + (bounds.max - bounds.min) * clamp01(motionRandom());
    motion.holdMs = Math.max(1000, Math.min(bounds.max, Math.max(bounds.min, base * stay)));
    motion.holdUntil = now + motion.holdMs;
    motion.nextDecisionAt = now + motion.holdMs;
    motion.posture.heldSince = now;
    motion.posture.remainingMs = motion.holdMs;
  }

  /**
   * Draw one natural posture. Each axis gets its own level so two goals are recognisably
   * different (full turn vs small turn, shallow vs deep tilt). A listening/thinking pause keeps
   * the attention direction and only moves a fraction of the way from the current pose.
   */
  function drawPostureTarget({ listening = false } = {}) {
    const sign = () => (motionRandom() < 0.5 ? -1 : 1);
    const level = (min, span) => sign() * (min + span * motionRandom());
    const next = {
      headX: sign(), // yaw: a full turn so left vs right is unmistakable
      headY: level(0.25, 0.7), // pitch
      headZ: level(0.35, 0.65), // tilt
      bodyX: level(0.35, 0.5),
      gazeX: level(0.2, 0.4) * 0.6,
      gazeY: level(0.2, 0.35) * 0.4,
    };
    if (listening) {
      for (const axis of MOTION_AXES) {
        const current = finite(state.motion.axes[axis].current, 0);
        next[axis] = current + (next[axis] - current) * 0.35;
      }
    }
    return next;
  }

  /**
   * The planned-transition window for one cause (B / item 4): an idle re-draw keeps 1.2–1.8 s, a
   * short response action lands in 0.8–1.2 s, a conversation-end relax decays over 2–4 s.
   */
  function transitionWindow(kind) {
    if (kind === 'short') {
      return { min: SHORT_ACTION_TRANSITION.MIN_MS, max: SHORT_ACTION_TRANSITION.MAX_MS };
    }
    if (kind === 'relax') return { min: RELAX_PLAN.MIN_MS, max: RELAX_PLAN.MAX_MS };
    return { min: POSTURE_TRANSITION.MIN_MS, max: POSTURE_TRANSITION.MAX_MS };
  }

  /**
   * Plan the one transition into a new goal. Duration is persona-tempo scaled and clamped into the
   * window of its CAUSE (`kind`); the smootherstep bounds are exposed so a test can check frame steps
   * and duration. `transitions` only counts idle re-draws; B and the relax have their own counters.
   */
  function startPostureTransition(next, now, { kind = 'idle', durationMs = null } = {}) {
    const motion = state.motion;
    let maxDelta = 0;
    const axes = [];
    for (const axis of MOTION_AXES) {
      const delta = Math.abs(finite(next[axis], 0) - finite(motion.axes[axis].current, 0));
      if (delta > 1e-6) axes.push(axis);
      maxDelta = Math.max(maxDelta, delta);
    }
    motion.posture.target = { ...next };
    if (kind === 'short') motion.posture.shortTransitions += 1;
    else if (kind === 'relax') motion.posture.relaxTransitions += 1;
    else motion.posture.transitions += 1;
    if (axes.length === 0) {
      motion.transition = null;
      return null;
    }
    const window = transitionWindow(kind);
    const planned = durationMs === null
      ? finite(cfg.postureTransitionMs, POSTURE_TRANSITION.BASE_MS) / postureTempo()
      : finite(durationMs, window.min);
    const plannedMs = Math.max(window.min, Math.min(window.max, planned));
    const seconds = plannedMs / 1000;
    motion.transition = {
      kind,
      startedAt: now,
      durationMs: plannedMs,
      from: Object.fromEntries(MOTION_AXES.map((axis) => [axis, finite(motion.axes[axis].current, 0)])),
      to: { ...next },
      axes,
      maxDelta,
      maxVelocity: (1.875 * maxDelta) / Math.max(0.001, seconds),
      maxAcceleration: (5.77 * maxDelta) / Math.max(0.001, seconds * seconds),
    };
    return motion.transition;
  }

  /**
   * B — a short RESPONSE action is a posture event too: the body takes a small step towards the
   * gesture and lands there in 0.8–1.2 s, faster than an idle re-draw. The step is anchored on the
   * last IDLE-drawn goal (`posture.base`), so repeated nods never accumulate a drift, and the hold
   * window is NOT re-rolled: nothing about the idle rhythm is accelerated.
   */
  function planShortAction(kind, now, sign) {
    const motion = state.motion;
    const persona = Math.max(0.2, Math.min(1.5, finite(state.style?.amplitude, 1)));
    const direction = sign === -1 ? -1 : 1;
    // A light nod settles the pitch; a confused tilt settles the yaw/roll. Both are tiny and are the
    // B band only — the C band is the gesture itself.
    const delta = kind === 'tilt'
      ? { headX: 0.05 * persona * direction, headZ: 0.06 * persona * direction }
      : { headY: 0.045 * persona * direction, headZ: 0.015 * persona * direction };
    const next = { ...motion.posture.base };
    for (const [axis, value] of Object.entries(delta)) {
      next[axis] = clampMotion(finite(motion.posture.base[axis], 0) + value, 1);
    }
    const transition = startPostureTransition(next, now, {
      kind: 'short',
      durationMs: SHORT_ACTION_TRANSITION.BASE_MS / postureTempo(),
    });
    motion.shortAction = {
      kind,
      startedAt: now,
      durationMs: transition === null ? 0 : transition.durationMs,
      delta,
    };
    return motion.shortAction;
  }

  /** Keep every axis where it is for a new window: this is the explicit "choose not to move". */
  function chooseStillPosture(now) {
    const motion = state.motion;
    const current = {};
    for (const axis of MOTION_AXES) {
      current[axis] = finite(motion.axes[axis].current, 0) + (motionRandom() * 2 - 1) * 0.02;
    }
    motion.posture.target = current;
    motion.posture.base = { ...current };
    motion.posture.stills += 1;
    motion.postureHolds += 1;
    motion.posture.lastDecision = 'still';
    rollPostureHold(now);
  }

  /**
   * Low-frequency decision: at most one posture decision per decision tick, and a new posture
   * only when the hold has expired. Keeping still is a first-class outcome, not a missed timer.
   */
  function stepPostureDecision(dt, now) {
    const motion = state.motion;
    if (motion.initialized !== true) {
      motion.initialized = true;
      motion.lastDecisionAt = now;
      const initial = drawPostureTarget();
      motion.posture.target = { ...initial };
      motion.posture.base = { ...initial };
      rollPostureHold(now);
      // The first draw keeps the original slow tracker: a fresh avatar is never limp, and the
      // hold window starts before it arrives. Planned 1.2–1.8 s transitions apply to every LATER
      // re-draw, so "initial" is not counted as a transition.
      motion.transition = null;
      motion.posture.lastDecision = 'initial';
      return;
    }
    motion.posture.remainingMs = Math.max(0, motion.holdUntil - now);
    motion.decisionAccMs += Math.max(0, dt) * 1000;
    if (motion.decisionAccMs < decisionIntervalMs) return;
    // A long frame is one decision, never a burst of catch-up decisions.
    motion.decisionAccMs = Math.min(decisionIntervalMs, motion.decisionAccMs - decisionIntervalMs);
    if (now < motion.holdUntil) return;
    motion.postureDecisions += 1;
    motion.lastDecisionAt = now;
    const listening = state.status === 'listening' || state.status === 'thinking';
    const configuredHold = clamp01(finite(cfg.postureHoldChance, DEFAULT_CONFIG.postureHoldChance));
    const holdChance = listening ? Math.max(configuredHold, 0.55) : configuredHold;
    const stillChance = listening
      ? clamp01(finite(cfg.postureListenStillChance, DEFAULT_CONFIG.postureListenStillChance))
      : clamp01(finite(cfg.postureStillChance, DEFAULT_CONFIG.postureStillChance));
    const roll = motionRandom();
    if (roll < holdChance) {
      // Hold the SAME target for another full window: not every decision is a re-draw.
      motion.postureHolds += 1;
      motion.posture.lastDecision = 'held';
      rollPostureHold(now);
      return;
    }
    if (roll < holdChance + stillChance) {
      chooseStillPosture(now);
      return;
    }
    motion.postureSwitches += 1;
    motion.posture.lastDecision = 'moved';
    const next = drawPostureTarget({ listening });
    motion.posture.base = { ...next };
    rollPostureHold(now);
    startPostureTransition(next, now);
  }

  /**
   * One bounded trajectory step. Velocity is capped directly and acceleration is capped on the
   * velocity change, so position and velocity are continuous and the second difference is bounded
   * even when the posture target jumps by a full unit.
   */
  function stepMotionAxis(axis, target, dt) {
    const desiredVelocity = (target - axis.current) * motionFollow;
    const boundedVelocity = clampMotion(desiredVelocity, motionMaxVelocity);
    const maxDelta = motionMaxAcceleration * Math.max(0, dt);
    // The acceleration limit is applied to the velocity change, so velocity itself is continuous
    // (a snap-to-target shortcut would create a velocity step and break the C¹ guarantee).
    axis.velocity += clampMotion(boundedVelocity - axis.velocity, maxDelta);
    axis.current += axis.velocity * dt;
    return axis.current;
  }

  /** Target = held posture + slow amplitude drift + continuous micro-noise (no fixed sine). */
  function motionTarget(axis, tSeconds) {
    const held = finite(state.motion.posture.target[axis], 0);
    const salt = hash32(motionSeed, axis);
    const slow = 0.82 + 0.18 * smoothNoise1(salt, tSeconds * 0.07 + 1.7);
    const micro = 0.09 * smoothNoise1(salt, tSeconds * 0.55 + 3.1);
    return held * slow + micro;
  }

  /**
   * One axis for one frame: while a planned transition is active the axis follows the
   * smootherstep path exactly (so its duration and bounds are real), otherwise it keeps the
   * original rate-limited hold drift.
   */
  function advanceMotionAxis(axis, dt, now, tSeconds) {
    const motion = state.motion;
    const axisState = motion.axes[axis];
    const transition = motion.transition;
    if (transition !== null && transition.axes.includes(axis)) {
      const u = clamp01((now - transition.startedAt) / Math.max(1, transition.durationMs));
      const from = finite(transition.from[axis], 0);
      const to = finite(transition.to[axis], 0);
      const previous = axisState.current;
      axisState.current = from + (to - from) * smootherstep(u);
      axisState.velocity = dt > 0 ? (axisState.current - previous) / dt : 0;
      return axisState.current;
    }
    return stepMotionAxis(axisState, motionTarget(axis, tSeconds), dt);
  }

  /** Update relaxation and every posture axis once per output frame. */
  function advanceMotion(dt, frame) {
    const motion = state.motion;
    const now = state.lastAt ?? 0;
    stepPostureDecision(dt, now);
    // Conversation end: a short delay keeps inter-sentence gaps from triggering the loose pose.
    const speakingNow = state.speech !== null || state.release !== null
      || (state.mouth.active === true && state.mouth.live === true);
    if (speakingNow) {
      motion.relax = 0;
      motion.relaxStartedAt = null;
      // A new speech re-energises the body: an explicit conversation-end decay is cancelled, not
      // left to fight the new turn.
      motion.relaxPlan = null;
    } else if (motion.wasSpeaking) {
      motion.relaxStartedAt = now;
    }
    motion.wasSpeaking = speakingNow;
    if (speakingNow !== true && motion.relaxStartedAt !== null) {
      const delay = Math.max(0, finite(cfg.relaxDelayMs, RELAXATION.DELAY_MS));
      const duration = Math.max(1, finite(cfg.relaxDurationMs, RELAXATION.DURATION_MS));
      motion.relax = clamp01(((now - motion.relaxStartedAt) - delay) / duration);
    }
    // Item 4 — an explicit `relax()` decays over 2–4 s from WHATEVER factor was in force, so the
    // effective amplitude falls monotonically even when the avatar was already partly relaxed.
    if (speakingNow !== true && motion.relaxPlan !== null) {
      const plan = motion.relaxPlan;
      const progress = clamp01((now - plan.startedAt) / Math.max(1, plan.durationMs));
      motion.relax = plan.from + (1 - plan.from) * smootherstep(progress);
      if (progress >= 1) motion.relaxPlan = null;
    }
    const t = state.styleClockMs / 1000;
    for (const axis of MOTION_AXES) {
      advanceMotionAxis(axis, dt, now, t);
    }
    const transition = motion.transition;
    if (transition !== null && now - transition.startedAt >= transition.durationMs) {
      for (const axis of transition.axes) {
        motion.axes[axis].current = finite(transition.to[axis], 0);
        motion.axes[axis].velocity = 0;
      }
      motion.posture.lastTransition = {
        kind: transition.kind ?? 'idle',
        startedAt: transition.startedAt,
        durationMs: transition.durationMs,
        endedAt: now,
        actualMs: now - transition.startedAt,
        maxVelocity: transition.maxVelocity,
        maxAcceleration: transition.maxAcceleration,
        axes: [...transition.axes],
      };
      motion.transition = null;
    }
    motion.frames += 1;
    motion.lastFrameAt = now;
    return motion;
  }

  /**
   * Item 4 — conversation-end relax. Over 2–4 s the posture amplitude decays to the base (a planned
   * transition from the current pose to neutral, zero velocity at both ends) and the effective style
   * relaxes in the same window. The hold window and the action slot are untouched: this is a longer
   * transition, never a jump and never a new rhythm.
   *
   * A second call while a plan is running continues from the CURRENT relaxation factor, so the
   * amplitude still falls monotonically.
   */
  function relax({ at = undefined, durationMs = undefined } = {}) {
    const motion = state.motion;
    const now = Number.isFinite(at) ? at : clockNow();
    const duration = Math.max(RELAX_PLAN.MIN_MS, Math.min(RELAX_PLAN.MAX_MS,
      finite(durationMs, RELAX_PLAN.BASE_MS)));
    const from = Object.fromEntries(MOTION_AXES.map((axis) => [axis, finite(motion.axes[axis].current, 0)]));
    const base = Object.fromEntries(MOTION_AXES.map((axis) => [axis, 0]));
    motion.relaxPlan = { startedAt: now, durationMs: duration, from: clamp01(motion.relax) };
    motion.posture.base = { ...base };
    // The explicit relax owns the decay from here on: the implicit speech-end ramp must not fight it.
    motion.relaxStartedAt = null;
    const transition = startPostureTransition(base, now, { kind: 'relax', durationMs: duration });
    recordEvent('avatar.motion.relax', { at: now, durationMs: duration, planned: transition !== null });
    return {
      ok: true,
      at: now,
      durationMs: duration,
      from,
      to: base,
      transitionMs: transition === null ? 0 : transition.durationMs,
    };
  }

  /**
   * The only entrance for a verified "look at the user" direction. Without `verified:true` the
   * controller keeps the preset neutral attention direction; no random eye position is ever
   * reported as looking at the user.
   */
  function setAttention(target = null, { verified = false, source = 'caller' } = {}) {
    const x = Number(target?.x ?? target?.gazeX);
    const y = Number(target?.y ?? target?.gazeY);
    const usable = verified === true && Number.isFinite(x) && Number.isFinite(y);
    state.motion.attention = usable
      ? { mode: 'user', target: { x: clampSigned(x), y: clampSigned(y) }, verified: true, source: String(source) }
      : { mode: 'neutral', target: { x: 0, y: 0 }, verified: false, source: String(source) };
    return { ...state.motion.attention, target: { ...state.motion.attention.target } };
  }

  // ---- frame output ---------------------------------------------------------------------
  function publish(pose) {
    // Coalescing is the transport stage's job, but the *pending slot* lives here so the upper
    // layer can take one frame and the next tick simply overwrites it (never queues).
    if (state.pendingFrame.size > 0) state.counters.overwritten += 1;
    const frame = new Map();
    for (const channel of CHANNELS) frame.set(channel, pose[channel]);
    state.pendingFrame = frame;
    state.lastPose = pose;
  }

  /** Optional helper: take the pending frame and clear the slot (mirrors vts.js coalescing). */
  function takePendingFrame() {
    const frame = state.pendingFrame;
    state.pendingFrame = new Map();
    if (frame.size > 0) state.counters.taken += 1;
    return frame;
  }

  // ---- diagnostics + isolated transport write --------------------------------------------
  const EVENTS_MAX = 100;

  // The initial dimensions are observable before the first tick, so a host (or a test) can show
  // them without waiting for a style refresh.
  recordEvent('avatar.style.dimensions', { ...state.dimensions });

  function recordEvent(type, data = {}) {
    state.events.push({ type, at: state.lastAt ?? clockNow(), ...data });
    while (state.events.length > EVENTS_MAX) state.events.shift();
  }

  function takeEvents() {
    const list = state.events.slice();
    state.events.length = 0;
    return list;
  }

  /**
   * Resolve the discovered mouth input name. Accepts an explicit `mouthInput` (string, or a
   * `{input|name|inputName}` entry) and, failing that, the discovered `inputs.mouth` entry.
   * Nothing is guessed when neither is present: null means "unmapped".
   */
  function resolveMouthInput() {
    const nameOf = (raw) => {
      if (typeof raw === 'string') return raw.trim();
      if (raw !== null && typeof raw === 'object') {
        return String(raw.input ?? raw.name ?? raw.inputName ?? '').trim();
      }
      return '';
    };
    return nameOf(cfg.mouthInput) || nameOf(cfg.inputs?.mouth) || null;
  }

  /**
   * Route one write to the optional transport hook. A missing hook is a no-op; a thrown error, a
   * rejected promise or a resolved `{ok:false}` all become an event + counter, and never
   * propagate to the caller.
   */
  async function emitWrite(input, value) {
    if (typeof cfg.writer !== 'function') return { ok: true, skipped: true };
    try {
      const result = await cfg.writer({ input, value });
      if (result !== null && typeof result === 'object' && result.ok === false) {
        throw new Error(String(result.reason ?? 'write rejected'));
      }
      return { ok: true };
    } catch (error) {
      state.errors += 1;
      state.lastError = String(error?.message ?? error);
      recordEvent('avatar.write.error', { input, value, message: state.lastError });
      return { ok: false, reason: 'write-failed' };
    }
  }

  // ---- mouth ownership: one sender, one fresh token per session ---------------------------
  function acquireMouth(owner, { takeover = false } = {}) {
    const mouth = state.mouth;
    const previous = mouth.active === true ? mouth.owner : null;
    if (previous !== null && previous !== owner) {
      if (takeover !== true) {
        mouth.busy += 1;
        recordEvent('avatar.mouth.busy', { owner, active: previous, token: mouth.token });
        return { ok: false, reason: 'mouth-busy', owner: previous, token: mouth.token };
      }
      mouth.takeovers += 1;
      recordEvent('avatar.mouth.takeover', { from: previous, owner });
    }
    if (previous !== null) mouth.ended += 1;
    mouth.token += 1;
    mouth.seq += 1;
    mouth.active = true;
    mouth.owner = owner;
    mouth.live = false;
    mouth.level = 0;
    mouth.unmappedLogged = false;
    mouth.staleLogged.clear();
    state.speech = null;
    state.release = null;
    state.lastSpeech = { index: -1, level: 0, speaking: false };
    // The previous sender must be visibly released before its replacement can write.
    if (previous !== null && state.lastPose !== null) publish({ ...state.lastPose, mouth: 0 });
    return { ok: true, token: mouth.token, sessionId: mouth.seq, owner, replaced: previous };
  }

  function releaseMouth(reason, { publishMouth = false } = {}) {
    const mouth = state.mouth;
    if (mouth.active === true) mouth.ended += 1;
    mouth.active = false;
    mouth.live = false;
    mouth.level = 0;
    mouth.token += 1; // every token issued so far is dead from here on
    state.speech = null;
    state.release = null;
    state.lastSpeech = { index: -1, level: 0, speaking: false };
    if (publishMouth === true && state.lastPose !== null) publish({ ...state.lastPose, mouth: 0 });
    return { ok: true, token: mouth.token, reason: String(reason ?? 'released') };
  }

  // ---- idle actions: candidates on a timer, same action deduped inside a window -----------
  function pickIdleAction(now) {
    const pool = Array.isArray(cfg.idleActions) ? cfg.idleActions : [];
    if (pool.length === 0) return null;
    const dedupeMs = Math.max(0, finite(cfg.idleActionDedupeMs, DEFAULT_CONFIG.idleActionDedupeMs));
    const start = Math.min(pool.length - 1, Math.floor(clamp01(finite(random(), 0)) * pool.length));
    for (let step = 0; step < pool.length; step += 1) {
      const name = pool[(start + step) % pool.length];
      const seenAt = state.idleAction.seen.get(name);
      if (!Number.isFinite(seenAt) || now - seenAt >= dedupeMs) return name;
    }
    return null;
  }

  /**
   * Replace the sampler's candidate names. The host narrows this to the actions the model can
   * actually animate, so an unusable action is never a candidate in the first place.
   */
  function setIdleActions(names) {
    cfg.idleActions = Array.isArray(names) ? names : [];
    return { ok: true, actions: [...cfg.idleActions] };
  }

  function stepIdleActions(frame, dt, now) {
    const idle = state.idleAction;
    // Only an explicit `flags.idle === false` pauses the scheduler. SPEECH NEVER PAUSES IT: a new
    // sentence must not zero the rhythm, re-sample a candidate or empty the queue (voice = mouth).
    if (frame.flags.idle === false) {
      idle.accMs = 0;
      return;
    }
    idle.accMs += Math.max(0, finite(dt, 0)) * 1000;
    const interval = Math.max(1, finite(cfg.idleActionIntervalMs, DEFAULT_CONFIG.idleActionIntervalMs));
    if (idle.accMs < interval) return;
    idle.accMs = 0;
    const name = pickIdleAction(now);
    if (name === null) {
      idle.suppressed += 1;
      recordEvent('avatar.idleAction.suppressed', { at: now });
      return;
    }
    const action = { name, at: now };
    idle.seen.set(name, now);
    idle.last = action;
    idle.emitted += 1;
    idle.queue.push(action);
    if (idle.queue.length > 16) idle.queue.shift();
    recordEvent('avatar.idleAction', { name, at: now });
  }

  function takeActions() {
    const list = state.idleAction.queue.slice();
    state.idleAction.queue.length = 0;
    return list;
  }

  // ---- persona style + host state + one-shot intents -------------------------------------
  /**
   * Baseline style × current-state modifier. The result is TEMPORARY: it is recomputed every tick
   * and never written back to `state.style`, so a long listening/waiting period cannot turn a
   * lively persona permanently small.
   */
  function effectiveStyle() {
    const base = state.style;
    const modifier = STATUS_MODIFIERS[state.status] ?? STATUS_MODIFIERS.idle;
    // Conversation-end relaxation is temporary, exactly like the status modifier: it never writes
    // back to the persona baseline. Both amplitude and tempo fall monotonically to the loose pose.
    const relax = clamp01(state.motion?.relax ?? 0);
    const amplitudeScale = 1 - Math.max(0, finite(cfg.relaxAmplitudeDrop, RELAXATION.AMPLITUDE_DROP)) * relax;
    const tempoScale = 1 - Math.max(0, finite(cfg.relaxTempoDrop, RELAXATION.TEMPO_DROP)) * relax;
    const channels = {};
    for (const [channel, spec] of Object.entries(base.channels ?? {})) {
      const range = AVATAR_STYLE_CHANNEL_RANGES[channel];
      if (range === undefined) continue;
      channels[channel] = {
        amplitude: Math.max(0.05, Math.min(range.max, spec.amplitude * modifier.amplitude * amplitudeScale)),
      };
    }
    return {
      amplitude: Math.max(0.05, base.amplitude * modifier.amplitude * amplitudeScale),
      tempo: Math.max(0.1, base.tempo * modifier.tempo * tempoScale),
      gazeHabit: state.status === 'listening' ? 'steady' : base.gazeHabit,
      expressiveness: base.expressiveness,
      nodAmplitude: base.nodAmplitude,
      nodDurationMs: base.nodDurationMs,
      tiltChance: base.tiltChance,
      channels,
    };
  }

  /** Merge a partial style over the current baseline (unmentioned fields keep their value). */
  function setStyle(stylePatch, { styleVersion } = {}) {
    const normalized = normalizeAvatarStyle(stylePatch, { base: state.style });
    if (normalized.ok !== true) {
      recordEvent('avatar.style.invalid', { error: normalized.error });
      return { ok: false, reason: 'invalid-style', style: { ...state.style } };
    }
    state.style = normalized.style;
    state.effective = null;
    if (typeof styleVersion === 'string' && styleVersion.length > 0) state.styleVersion = styleVersion;
    state.dimensions = deriveAvatarStyleDimensions(state.style, { styleVersion: state.styleVersion });
    recordEvent('avatar.style.set', {
      styleVersion: state.styleVersion,
      changed: normalized.changed,
      ignored: normalized.ignored,
      invalid: normalized.invalid,
    });
    // Dimensions are a pure projection of the new style: re-derive and publish them in the same
    // transition, so a listener never sees a style newer than its dimensions.
    recordEvent('avatar.style.dimensions', { ...state.dimensions });
    return {
      ok: true,
      style: { ...state.style },
      styleVersion: state.styleVersion,
      changed: normalized.changed,
      ignored: normalized.ignored,
      invalid: normalized.invalid,
    };
  }

  /** Change the host-driven state. An unknown state is refused, never guessed. */
  function setStatus(status, { reason = '' } = {}) {
    if (!MOTION_STATUSES.includes(status)) {
      recordEvent('avatar.state.invalid', { status: String(status) });
      return { ok: false, reason: 'invalid-status', status: state.status, allowed: [...MOTION_STATUSES] };
    }
    const previous = state.status;
    if (previous === status) return { ok: true, changed: false, status, previous };
    state.status = status;
    state.statusChangedAt = state.lastAt ?? clockNow();
    state.effective = null;
    recordEvent('avatar.state', { status, previous, reason: String(reason ?? '') });
    return { ok: true, changed: true, status, previous };
  }

  /**
   * Draw one variant for `kind` from that intent's own seeded stream. The previous variant of the
   * SAME intent is skipped, so a run of identical gestures never draws the same replacement twice
   * in a row. The stream is stable for one runtime seed, which keeps the sequence reproducible.
   *
   * Stage 4: an OCCASIONAL action (`deep`) takes the intent's deepest variant deterministically —
   * a conclusion is a deep nod, a confusion a wide tilt — so its "slightly larger than a normal
   * nod" relationship is a property of the profile, not of a lucky draw. Plain gestures keep the
   * seeded draw unchanged.
   */
  function pickIntentVariant(kind, { deep = false } = {}) {
    const list = INTENT_VARIANTS[kind] ?? INTENT_VARIANTS.nod;
    if (deep === true) {
      const chosen = list.reduce((best, item) => (item.amplitude > best.amplitude ? item : best), list[0]);
      state.variant.last[kind] = chosen.id;
      state.variant.lastInfo = { intent: kind, variant: chosen.id, seed: state.variant.seed, deep: true };
      return chosen;
    }
    let stream = state.variant.streams.get(kind);
    if (stream === undefined) {
      stream = createSeededRandom(`${state.variant.seed}:${kind}`);
      state.variant.streams.set(kind, stream);
    }
    let index = Math.min(list.length - 1, Math.floor(clamp01(finite(stream(), 0)) * list.length));
    if (list.length > 1 && list[index].id === state.variant.last[kind]) {
      index = (index + 1) % list.length;
    }
    const variant = list[index];
    state.variant.last[kind] = variant.id;
    state.variant.lastInfo = { intent: kind, variant: variant.id, seed: state.variant.seed };
    return variant;
  }

  /**
   * Run one shot of a named intent, using the CURRENT effective style for its amplitude and
   * duration. `channels` is the host's verified-channel intersection; without it the intent uses
   * every channel it names (the pure core has no transport knowledge).
   *
   * P-139 stage 3: the persona dimensions scale expression only (`liveliness` → bigger, quicker;
   * `softness` → longer; `restraint` → capped) and the seeded variant adds a small amplitude /
   * duration / head-axis difference. The intent name and its channel targets never change.
   *
   * P-139 stage 4: `profile` ('conclusion' | 'confused') marks an OCCASIONAL action — it may use
   * the C band (up to 14°) and, for `confused`, the already-mapped brow channels. `response` marks a
   * short reply to the user, which is what may use the B transition (0.8–1.2 s).
   */
  function intent(kind, { channels = null, at = undefined, generation = null, profile = null, response = false } = {}) {
    const action = String(kind ?? '');
    const targets = INTENT_CHANNEL_TARGETS[action];
    if (targets === undefined) {
      recordEvent('avatar.intent.invalid', { kind: action });
      return { ok: false, reason: 'unknown-intent', kind: action, supported: [...INTENT_KINDS] };
    }
    const gestureProfile = isMotionProfile(profile) ? String(profile) : null;
    const wanted = intentChannelsFor(action, gestureProfile);
    const allowed = Array.isArray(channels) && channels.length > 0
      ? wanted.filter((channel) => channels.includes(channel))
      : [...wanted];
    if (allowed.length === 0) {
      recordEvent('avatar.intent.skipped', { kind: action, reason: 'unmapped', channels: [...wanted] });
      return { ok: false, reason: 'unmapped', kind: action, skipped: [...wanted] };
    }
    const now = Number.isFinite(at) ? at : clockNow();
    const scaled = effectiveStyle();
    const dims = state.dimensions;
    const occasional = gestureProfile !== null;
    const variant = pickIntentVariant(action, { deep: occasional });
    const application = STYLE_DIMENSION_APPLICATION;
    const baseDurationMs = action === 'surprise'
      ? Math.round(520 / scaled.tempo)
      : Math.round(scaled.nodDurationMs / scaled.tempo);
    const durationScale = (application.durationBase + application.durationSpan * dims.softness)
      * (1 + application.livelinessTempo - 2 * application.livelinessTempo * dims.liveliness)
      * variant.duration
      * (occasional ? OCCASIONAL_ACTION.DURATION : 1);
    // `durationMs` is the planned gesture length; a conclusion keeps a floor so its affirmation
    // HOLD is really visible (30% of the envelope), even on a quick persona whose base is 300 ms.
    const plannedDurationMs = Math.min(1600, Math.max(300, Math.round(baseDurationMs * durationScale)));
    const durationMs = gestureProfile === 'conclusion'
      ? Math.max(plannedDurationMs, 640)
      : plannedDurationMs;
    const baseAmplitude = action === 'nod'
      ? 0.35 * scaled.nodAmplitude * scaled.amplitude
      : action === 'tilt'
        ? 0.24 * scaled.nodAmplitude * scaled.amplitude
        : action === 'surprise'
          ? 0.55 * scaled.expressiveness
          : 0.16 * scaled.amplitude;
    const amplitudeScale = (application.amplitudeBase + application.amplitudeSpan * dims.liveliness)
      * (1 - application.restraintCap * dims.restraint)
      * variant.amplitude
      * (occasional ? OCCASIONAL_ACTION.AMPLITUDE : 1);
    // C: only an occasional action is capped at the 12–14° band, and the cap is applied AFTER the
    // restraint/variant scaling, so restraint can still shrink it. A normal gesture keeps its range.
    const axisRatio = action === 'tilt'
      ? Math.max(1, finite(variant.headX, 0.5), finite(variant.headZ, 0.9))
      : Math.max(1, finite(variant.headZ, 0.18));
    const amplitudeCap = occasional
      ? (OCCASIONAL_ACTION.MAX_DEGREES / OCCASIONAL_ACTION.DEGREES_PER_POSE_UNIT) / axisRatio
      : 1;
    const scaledAmplitude = Math.max(0.01, Math.min(1, amplitudeCap, baseAmplitude * amplitudeScale));
    // Visible floor (see INTENT_VISIBILITY): a quiet persona's intent may no longer collapse to
    // 0.35°. The floor is converted through the variant's yaw ratio and the channel's style scale,
    // so the PRIMARY axis really reaches the documented semantic value. It is allowed to exceed
    // the occasional scalar cap because intentFrame caps each written channel at the C ceiling.
    const globalAmplitude = Math.max(1e-6, finite(scaled.amplitude, DEFAULT_AVATAR_STYLE.amplitude));
    const primaryChannel = action === 'tilt' ? 'headX' : 'headY';
    const visibleFloor = intentVisibleFloor(action, gestureProfile, {
      yawRatio: finite(variant.headX, 0.5),
      channelScale: styleChannelAmplitude(scaled, primaryChannel) / globalAmplitude,
    });
    const amplitude = visibleFloor > 0
      ? Math.max(0.01, Math.min(1, applyVisibleFloor(
        scaledAmplitude,
        visibleFloor,
        occasional ? 1 : INTENT_VISIBILITY.FLOOR_RATIO,
      )))
      : scaledAmplitude;
    state.intentSeq += 1;
    const item = {
      seq: state.intentSeq,
      kind: action,
      /** Stage 4: the occasional profile this shot carries (null for a plain gesture). */
      profile: gestureProfile,
      startedAt: now,
      durationMs,
      settleMs: INTENT_SETTLE_MS,
      channels: allowed,
      /** Generation that started this trajectory; a generation switch stops exactly the old ones. */
      generation: Number.isInteger(generation) ? generation : null,
      amplitude,
      // Alternating direction keeps repeated nods/tilts from looking mechanical.
      sign: state.intentSeq % 2 === 1 ? 1 : -1,
      gazeHabit: scaled.gazeHabit,
      variant: variant.id,
      variantHeadX: variant.headX,
      variantHeadZ: variant.headZ,
      done: false,
    };
    state.intents.push(item);
    // An explicit gesture takes the channel over immediately: drop any expression release entry so
    // the returning pose never zeroes a channel the new owner is already driving.
    handOffReleases(allowed);
    while (state.intents.length > 4) state.intents.shift();
    // B: a short RESPONSE action (light nod / conclusion nod / listening micro reply / confused
    // tilt) also lands its posture in 0.8–1.2 s. Nothing about the idle rhythm changes.
    if (response === true && SHORT_ACTION_INTENTS.includes(action)) {
      planShortAction(action, now, item.sign);
    }
    // The C ceiling bounds the occasional action's actual peak channel value (intentFrame caps
    // headX/headZ per axis), so the recorded peak is the capped one, never 15°+.
    const peakDegrees = Math.round((occasional
      ? Math.min(OCCASIONAL_ACTION.MAX_DEGREES, item.amplitude * axisRatio * OCCASIONAL_ACTION.DEGREES_PER_POSE_UNIT)
      : item.amplitude * axisRatio * OCCASIONAL_ACTION.DEGREES_PER_POSE_UNIT) * 100) / 100;
    recordEvent('avatar.intent.start', {
      kind: action,
      variant: variant.id,
      durationMs,
      amplitude: item.amplitude,
      channels: allowed,
      styleVersion: state.styleVersion,
      profile: gestureProfile,
      occasional,
      peakDegrees,
    });
    recordEvent('avatar.intent.variant', {
      intent: action,
      variant: variant.id,
      seed: state.variant.seed,
    });
    return {
      ok: true,
      kind: action,
      variant: variant.id,
      variantSeed: state.variant.seed,
      durationMs,
      amplitude: item.amplitude,
      profile: gestureProfile,
      occasional,
      peakDegrees,
      maxDegrees: occasional ? OCCASIONAL_ACTION.MAX_DEGREES : null,
      shortAction: state.motion.shortAction,
      channels: allowed,
      styleVersion: state.styleVersion,
      startedAt: now,
    };
  }

  /**
   * Cancel one one-shot gesture (or every active gesture) with a short FADE, not a resource close.
   * The pose therefore returns to the current natural posture continuously; nothing snaps to zero.
   */
  function cancelIntent(kind = null, { fadeMs = 240, at = undefined } = {}) {
    const now = Number.isFinite(at) ? at : clockNow();
    const fade = Math.max(1, Math.min(2000, finite(fadeMs, 240)));
    const name = kind === null || kind === undefined ? null : String(kind);
    let cancelled = 0;
    for (const item of state.intents) {
      if (item.done === true) continue;
      if (name !== null && item.kind !== name) continue;
      item.cancelledAt = now;
      item.cancelFadeMs = fade;
      cancelled += 1;
    }
    if (cancelled > 0) {
      recordEvent('avatar.intent.cancel', { kind: name ?? '*', fadeMs: fade, count: cancelled });
    }
    return { ok: cancelled > 0, cancelled, fadeMs: fade, at: now };
  }

  /**
   * Stop one-shot trajectories AT ONCE (a generation switch, not a normal cancel): the items leave
   * `state.intents`, so on the next tick they contribute NOTHING to the axis targets instead of
   * running out their remaining duration. With `throughGeneration` only trajectories started by
   * that generation (or an untagged/core-created one) are stopped; a newer generation is untouched.
   * `remainingMs` is the largest duration those trajectories had left when they were cleared, so a
   * caller can prove the actual motion was cancelled rather than only some bookkeeping.
   */
  function clearIntents({ reason = 'invalidate', throughGeneration = null, at = undefined } = {}) {
    const now = Number.isFinite(at) ? at : clockNow();
    // A generation switch also drops the autonomous expression layer: no old gaze/brow offset may
    // survive onto the pose of the next turn.
    clearExpressions(`intents:${String(reason ?? 'invalidate')}`);
    const removed = [];
    for (let index = state.intents.length - 1; index >= 0; index -= 1) {
      const item = state.intents[index];
      const generation = Number.isInteger(item.generation) ? item.generation : 0;
      if (throughGeneration !== null && generation > throughGeneration) continue;
      removed.push(item);
      state.intents.splice(index, 1);
    }
    const axes = [];
    let remainingMs = 0;
    for (const item of removed) {
      for (const channel of item.channels) if (!axes.includes(channel)) axes.push(channel);
      if (item.done !== true) {
        remainingMs = Math.max(remainingMs, Math.max(0, item.startedAt + item.durationMs - now));
      }
    }
    axes.sort((left, right) => CHANNELS.indexOf(left) - CHANNELS.indexOf(right));
    if (removed.length > 0) {
      recordEvent('avatar.intent.trajectory.cleared', {
        reason: String(reason ?? 'invalidate'),
        axes,
        remainingMs: Math.round(remainingMs),
      });
    }
    return { ok: true, cleared: removed.length, axes, remainingMs, at: now };
  }

  // ---- autonomous expression layer: short status gestures + rare micro-actions ---------------
  const EXPRESSION_CHANNELS = Object.freeze({
    thinking: Object.freeze(['gazeY', 'browL', 'browR']),
    listening: Object.freeze(['headY', 'bodyX', 'bodyY']),
    glance: Object.freeze(['gazeX']),
    'weight-shift': Object.freeze(['headZ', 'bodyX']),
  });

  /** The peak semantic offsets for one expression kind (full envelope); null for an unknown kind. */
  function expressionDefinition(kind) {
    switch (kind) {
      case 'thinking':
        return {
          durationMs: EXPRESSION_MOTION.THINKING_MS,
          channels: EXPRESSION_CHANNELS.thinking,
          gazeY: EXPRESSION_MOTION.THINKING_GAZE_Y,
          browL: EXPRESSION_MOTION.THINKING_BROW_RAISED,
          browR: EXPRESSION_MOTION.THINKING_BROW_OTHER,
        };
      case 'listening':
        return {
          durationMs: EXPRESSION_MOTION.LISTENING_MS,
          channels: EXPRESSION_CHANNELS.listening,
          headY: EXPRESSION_MOTION.LISTENING_HEAD_Y,
          bodyY: EXPRESSION_MOTION.LISTENING_BODY_Y,
          bodyX: EXPRESSION_MOTION.LISTENING_BODY_X,
          centerGaze: true,
        };
      case 'glance':
        return {
          durationMs: EXPRESSION_MOTION.OCCASIONAL_MS,
          channels: EXPRESSION_CHANNELS.glance,
          gazeX: EXPRESSION_MOTION.OCCASIONAL_GAZE_X,
        };
      case 'weight-shift':
        return {
          durationMs: EXPRESSION_MOTION.OCCASIONAL_MS,
          channels: EXPRESSION_CHANNELS['weight-shift'],
          headZ: EXPRESSION_MOTION.OCCASIONAL_HEAD_Z,
          bodyX: EXPRESSION_MOTION.OCCASIONAL_BODY_X,
        };
      default:
        return null;
    }
  }

  /** When an expression really stops contributing (early when a phase faded it out). */
  function expressionDoneAt(item) {
    const base = item.startedAt + item.durationMs;
    return item.fadedAt === null ? base : Math.min(base, item.fadedAt + EXPRESSION_MOTION.CANCEL_FADE_MS);
  }

  /**
   * Register the channels an expression just stopped driving (unless another owner already has
   * them) so they keep being written until the pose is back at the baseline. `atMs` is the exact
   * instant the envelope reached 0 (or the takeover instant), so the hold window is measured from
   * the expression's own end, not from whichever tick happens to notice it.
   */
  function markExpressionRelease(item, atMs) {
    for (const channel of item.channels) {
      if (state.releases.has(channel)) continue;
      // A NEW expression or intent already drives this channel: direct handoff, never a zeroing.
      const owned = state.expressions.some((other) => other !== item && other.channels.includes(channel))
        || state.intents.some((other) => other.channels.includes(channel));
      if (owned) continue;
      state.releases.set(channel, { kind: item.kind, atMs, frames: 0, last: null });
    }
  }

  /** Drop the release entries of channels a new owner takes over (handoff, no dip to 0). */
  function handOffReleases(channels) {
    for (const channel of channels) state.releases.delete(channel);
  }

  /**
   * Record the value about to be written on `channel` and decide whether its expression release is
   * over. Returns the value to write: `value` normally, or exactly 0 when the hold window timed out
   * (one forced write, then the channel is freed — a channel is never reserved forever).
   */
  function settleReleaseWrite(channel, value) {
    const entry = state.releases.get(channel);
    if (entry === undefined) return value;
    const now = state.lastAt ?? clockNow();
    const elapsed = now - entry.atMs;
    if (elapsed >= EXPRESSION_RELEASE.MAX_HOLD_MS) {
      state.releases.delete(channel);
      recordEvent('avatar.expression.release', {
        channel, atMs: entry.atMs, settled: 'timeout', forced: true, kind: entry.kind,
      });
      return 0;
    }
    const baseline = finite(state.idle?.[channel], 0);
    const near = Math.abs(value) <= EXPRESSION_RELEASE.BASELINE_EPSILON
      || Math.abs(value - baseline) <= EXPRESSION_RELEASE.BASELINE_EPSILON;
    entry.frames = near ? entry.frames + 1 : 0;
    entry.last = value;
    if (entry.frames >= EXPRESSION_RELEASE.SETTLE_FRAMES) {
      state.releases.delete(channel);
      recordEvent('avatar.expression.release', {
        channel, atMs: entry.atMs, settled: true, value, kind: entry.kind,
        releaseMs: Math.round(elapsed),
      });
    }
    return value;
  }

  /** Start one bounded expression; restarting the same kind replaces it instead of stacking. */
  function startExpression(kind, at) {
    const definition = expressionDefinition(kind);
    if (definition === null) return null;
    const time = Number.isFinite(at) ? at : clockNow();
    // Replacing the same kind (or evicting the oldest slot) is a takeover: the new envelope owns
    // those channels from here, so their release window is dropped instead of finishing under it.
    const replaced = state.expressions.filter((item) => item.kind === kind);
    state.expressions = state.expressions.filter((item) => item.kind !== kind);
    for (const item of replaced) markExpressionRelease(item, time);
    // Size follows the persona's expressiveness inside a narrow band: a quiet persona's gesture is
    // still visible, a loud one never reaches the hard caps.
    const expressive = Math.max(0.3, Math.min(1.5, finite(
      state.effective?.expressiveness ?? state.style?.expressiveness,
      DEFAULT_AVATAR_STYLE.expressiveness,
    )));
    const scale = 0.85 + 0.15 * expressive;
    const item = {
      kind,
      startedAt: time,
      durationMs: definition.durationMs,
      channels: [...definition.channels],
      centerGaze: definition.centerGaze === true,
      fadedAt: null,
      headX: finite(definition.headX, 0) * scale,
      headY: finite(definition.headY, 0) * scale,
      headZ: finite(definition.headZ, 0) * scale,
      bodyX: finite(definition.bodyX, 0) * scale,
      bodyY: finite(definition.bodyY, 0) * scale,
      bodyZ: finite(definition.bodyZ, 0) * scale,
      browL: clampSigned(finite(definition.browL, 0) * scale),
      browR: clampSigned(finite(definition.browR, 0) * scale),
      gazeX: finite(definition.gazeX, 0) * scale,
      gazeY: finite(definition.gazeY, 0) * scale,
    };
    state.expressions.push(item);
    while (state.expressions.length > 3) {
      const evicted = state.expressions.shift();
      markExpressionRelease(evicted, time);
    }
    handOffReleases(item.channels);
    recordEvent('avatar.expression.start', {
      kind,
      durationMs: item.durationMs,
      channels: [...item.channels],
      at: time,
    });
    return item;
  }

  /** Fade one expression kind out (a phase moved on); an unknown/inactive kind is a no-op. */
  function fadeExpression(kind, at) {
    const time = Number.isFinite(at) ? at : clockNow();
    let faded = 0;
    for (const item of state.expressions) {
      if (item.kind !== kind || item.fadedAt !== null) continue;
      item.fadedAt = time;
      faded += 1;
    }
    return faded;
  }

  /** Drop every expression immediately (generation switch / interrupt); no fade is possible then. */
  function clearExpressions(reason) {
    // A hard generation stop also drops any pending release: nothing of the old expression may
    // keep being written onto the next turn's pose.
    const released = state.releases.size;
    state.releases.clear();
    if (state.expressions.length === 0) return 0;
    const cleared = state.expressions.length;
    state.expressions = [];
    state.expressionGaze = { x: 0, y: 0 };
    recordEvent('avatar.expression.cleared', { reason: String(reason ?? ''), cleared, released });
    return cleared;
  }

  /**
   * Advance the expression layer for one tick: expire/fade and fold every active envelope into
   * additive offsets plus an idle-gaze offset. The motion budget (head 14°, gaze 0.7, body 10°) is
   * applied HERE, before an offset can ever reach the pose.
   */
  function expressionFrame(now) {
    const adds = { headX: 0, headY: 0, headZ: 0, browL: 0, browR: 0, bodyX: 0, bodyY: 0, bodyZ: 0 };
    const gaze = { x: 0, y: 0 };
    let centerGaze = false;
    for (let index = state.expressions.length - 1; index >= 0; index -= 1) {
      const item = state.expressions[index];
      const elapsed = now - item.startedAt;
      if (elapsed < 0) {
        // A future-dated expression (started ahead of the tick that sees it) never contributed, so
        // there is no residual pose to unwind: it is dropped without a release.
        state.expressions.splice(index, 1);
        continue;
      }
      if (now >= expressionDoneAt(item)) {
        // The envelope is 0 from this instant on: keep the channel written until the composed pose
        // really returned to the baseline, then let it go (see EXPRESSION_RELEASE).
        markExpressionRelease(item, expressionDoneAt(item));
        state.expressions.splice(index, 1);
        continue;
      }
      let envelope = Math.sin(Math.PI * clamp01(elapsed / item.durationMs));
      if (item.fadedAt !== null) {
        envelope *= 1 - smoothstep((now - item.fadedAt) / EXPRESSION_MOTION.CANCEL_FADE_MS);
      }
      const headCap = EXPRESSION_MOTION.MAX_HEAD_DEGREES / OCCASIONAL_ACTION.DEGREES_PER_POSE_UNIT;
      const bodyCap = EXPRESSION_MOTION.MAX_BODY_DEGREES / OCCASIONAL_ACTION.DEGREES_PER_POSE_UNIT;
      const add = (channel, cap) => {
        const value = adds[channel] + finite(item[channel], 0) * envelope;
        adds[channel] = Math.max(-cap, Math.min(cap, value));
      };
      add('headX', headCap);
      add('headY', headCap);
      add('headZ', headCap);
      add('bodyX', bodyCap);
      add('bodyY', bodyCap);
      add('bodyZ', bodyCap);
      adds.browL = clampSigned(adds.browL + item.browL * envelope);
      adds.browR = clampSigned(adds.browR + item.browR * envelope);
      gaze.x += item.gazeX * envelope;
      gaze.y += item.gazeY * envelope;
      if (item.centerGaze === true) centerGaze = true;
    }
    gaze.x = Math.max(-EXPRESSION_MOTION.MAX_GAZE, Math.min(EXPRESSION_MOTION.MAX_GAZE, gaze.x));
    gaze.y = Math.max(-EXPRESSION_MOTION.MAX_GAZE, Math.min(EXPRESSION_MOTION.MAX_GAZE, gaze.y));
    return { adds, gaze, centerGaze };
  }

  /** 20–40 s seeded schedule; a busy pose defers (does not consume) the slot. */
  function maybeScheduleOccasional(now) {
    const slot = state.occasional;
    const draw = () => EXPRESSION_MOTION.OCCASIONAL_MIN_MS
      + (EXPRESSION_MOTION.OCCASIONAL_MAX_MS - EXPRESSION_MOTION.OCCASIONAL_MIN_MS) * clamp01(expressionRandom());
    if (slot.nextAt === null) {
      slot.nextAt = now + draw();
      return null;
    }
    if (now < slot.nextAt) return null;
    if (state.intent.flags?.idle === false) return null;
    // Never stack on a gesture (or another expression): the slot stays due and fires when clear.
    if (state.expressions.length > 0) return null;
    if (state.intents.some((item) => item.done !== true)) return null;
    const kind = expressionRandom() < 0.5 ? 'glance' : 'weight-shift';
    slot.nextAt = now + draw();
    slot.starts += 1;
    slot.lastAt = now;
    slot.lastKind = kind;
    const item = startExpression(kind, now);
    recordEvent('avatar.expression.occasional', {
      kind,
      starts: slot.starts,
      nextAt: slot.nextAt,
      at: now,
    });
    return item;
  }

  /** Channels that are active or still settling: the host flushes these (plus idle channels). */
  function intentChannels(now = state.lastAt ?? clockNow()) {
    const set = new Set();
    for (const item of state.intents) {
      if (now <= item.startedAt + item.durationMs + item.settleMs) {
        for (const channel of item.channels) set.add(channel);
      }
    }
    // The autonomous expression layer rides the same channel flush for its own short window.
    for (const item of state.expressions) {
      if (now < expressionDoneAt(item)) for (const channel of item.channels) set.add(channel);
    }
    // A channel an expression just stopped driving stays a write channel until its pose is
    // provably back at the baseline (or the hold window timed out): otherwise the last non-zero
    // value would remain on the VTS input and the model would keep the expression's gaze/roll.
    for (const [channel, entry] of state.releases) {
      if (now - entry.atMs <= EXPRESSION_RELEASE.PRUNE_MS) {
        set.add(channel);
      } else {
        // No write ever reached it (unmapped/unverified during the window): free it, report it.
        state.releases.delete(channel);
        recordEvent('avatar.expression.release', {
          channel, atMs: entry.atMs, settled: 'timeout', forced: false, kind: entry.kind,
        });
      }
    }
    return [...set];
  }

  /**
   * Fold every active intent into additive offsets (head/body/brow), an optional gaze target and
   * an optional "eyes wide" flag. The envelope is `sin(π·progress)`: it starts and ends at exactly
   * 0, so the pose returns to the baseline without a jump — except a `conclusion` nod, which uses
   * `conclusionEnvelope` (rise → a marked affirmation HOLD → release). After `durationMs` the item
   * stops contributing but stays in the list for `settleMs`, so the host keeps flushing its
   * channels while the springs settle. The autonomous expression layer is folded in at the end.
   *
   * Axis mapping (the whole point of this table):
   *   nod        → headY additive (pitch) + a trace of headZ; headX is NEVER touched by a nod
   *   tilt       → headX (yaw, half strength) + headZ (roll)
   *   surprise   → eyeOpenL/R forced fully open before the blink chain + headZ roll
   *   lookAtUser → gaze override only; no head axis is invented
   */
  function intentFrame(now) {
    const adds = { headX: 0, headY: 0, headZ: 0, browL: 0, browR: 0, bodyX: 0, bodyY: 0, bodyZ: 0 };
    let gaze = null;
    let eyeOpen = null;
    const eff = state.effective ?? effectiveStyle();
    const globalAmplitude = Math.max(1e-6, finite(eff.amplitude, DEFAULT_AVATAR_STYLE.amplitude));
    // A channel override replaces the global amplitude, so an intent keeps the same relative
    // gesture on every channel while each channel keeps its own size.
    const channelScale = (channel) => styleChannelAmplitude(eff, channel) / globalAmplitude;
    for (let index = state.intents.length - 1; index >= 0; index -= 1) {
      const item = state.intents[index];
      const elapsed = now - item.startedAt;
      if (elapsed < 0) continue;
      // A cancel fades the remaining gesture out instead of cutting it: the pose stays continuous
      // and returns to the current natural posture, never to zero.
      const cancelledAt = Number.isFinite(item.cancelledAt) ? item.cancelledAt : null;
      const fadeMs = Math.max(1, finite(item.cancelFadeMs, 1));
      const cancelElapsed = cancelledAt === null ? 0 : now - cancelledAt;
      const doneAt = cancelledAt === null
        ? item.durationMs + item.settleMs
        : Math.min(item.durationMs, cancelledAt - item.startedAt + fadeMs) + item.settleMs;
      if (elapsed >= doneAt || (cancelledAt !== null && cancelElapsed >= fadeMs + item.settleMs)) {
        if (item.done !== true) {
          item.done = true;
          recordEvent('avatar.intent.done', {
            kind: item.kind,
            durationMs: item.durationMs,
            cancelled: cancelledAt !== null,
          });
        }
        state.intents.splice(index, 1);
        continue;
      }
      if (elapsed >= item.durationMs) {
        if (item.done !== true) {
          item.done = true;
          recordEvent('avatar.intent.done', { kind: item.kind, durationMs: item.durationMs });
        }
        continue;
      }
      const progress = clamp01(elapsed / item.durationMs);
      // A conclusion nod keeps its marked affirmation pause; every other shot is the plain sin(πt).
      const envelope = (item.profile === 'conclusion' && item.kind === 'nod'
        ? conclusionEnvelope(progress)
        : Math.sin(Math.PI * progress))
        * (cancelledAt === null ? 1 : 1 - smoothstep(cancelElapsed / fadeMs));
      const amount = item.amplitude * envelope;
      const has = (channel) => item.channels.includes(channel);
      // C ceiling, applied per HEAD CHANNEL after the style scale: an occasional action's peak
      // angle stays in 12–14° on every axis. The PRIMARY axis keeps the plain ceiling (a conclusion
      // nod must still reach 13°); a non-primary ROLL axis is divided by (1 + INTENT_IDLE_RATIO) so
      // the arbitration's allowed idle micro-motion cannot push the composed pose past 14°.
      const occasionalCap = (OCCASIONAL_ACTION.MAX_DEGREES - OCCASIONAL_ACTION.CHANNEL_MARGIN_DEGREES)
        / OCCASIONAL_ACTION.DEGREES_PER_POSE_UNIT;
      const occasionalRollCap = occasionalCap / (1 + INTENT_IDLE_RATIO);
      const primaryChannel = item.kind === 'tilt' ? 'headX' : 'headY';
      const headValue = (value, channel) => (item.profile === null
        ? value
        : Math.max(
          -(channel === primaryChannel ? occasionalCap : occasionalRollCap),
          Math.min(channel === primaryChannel ? occasionalCap : occasionalRollCap, value),
        ));
      // P-139 stage 3: the variant only shifts axis ratios; the intent name never changes and a
      // nod still never writes headX (its variant carries a roll ratio, not a yaw).
      const rollRatio = Number.isFinite(item.variantHeadZ) ? item.variantHeadZ : 0.18;
      if (item.kind === 'nod') {
        // Pitch = headY. FaceAngleX is a left/right turn, so a nod must not write it.
        if (has('headY')) adds.headY += headValue(amount * item.sign * channelScale('headY'), 'headY');
        if (has('headZ')) adds.headZ += headValue(amount * rollRatio * item.sign * channelScale('headZ'), 'headZ');
      } else if (item.kind === 'tilt') {
        // Tilt keeps the sideways head turn (headX) and adds the roll (headZ).
        const yawRatio = Number.isFinite(item.variantHeadX) ? item.variantHeadX : 0.5;
        if (has('headX')) adds.headX += headValue(amount * yawRatio * item.sign * channelScale('headX'), 'headX');
        if (has('headZ')) adds.headZ += headValue(amount * rollRatio * item.sign * channelScale('headZ'), 'headZ');
        // Confusion: ONE brow goes up (the side the head tilts towards), the other goes slightly
        // down. Both are the already-mapped brow channels; the envelope is the tilt's own.
        if (item.profile === 'confused') {
          const browMax = OCCASIONAL_ACTION.BROW_MAX;
          const raised = item.sign >= 0 ? 'browL' : 'browR';
          const lowered = item.sign >= 0 ? 'browR' : 'browL';
          if (has(raised)) adds[raised] += Math.min(browMax, amount * OCCASIONAL_ACTION.BROW_RAISED);
          if (has(lowered)) adds[lowered] += Math.max(-browMax, amount * OCCASIONAL_ACTION.BROW_LOWERED);
        }
      } else if (item.kind === 'surprise') {
        // Eyes wide: raise the expression eye baseline before the blink chain, so a blink can still
        // close them (0 × factor = 0). The head rolls instead of turning.
        if (has('eyeOpenL') || has('eyeOpenR')) {
          eyeOpen = { left: has('eyeOpenL'), right: has('eyeOpenR') };
        }
        if (has('headZ')) adds.headZ -= amount * rollRatio * item.sign * channelScale('headZ');
      } else if (item.kind === 'lookAtUser') {
        // Only a VERIFIED user target may be called "looking at the user". Without one this is the
        // preset neutral attention direction (0, 0), never a random eye position.
        if (has('gazeX') || has('gazeY')) {
          gaze = state.motion.attention.mode === 'user'
            ? { ...state.motion.attention.target }
            : { x: 0, y: 0 };
        }
      }
    }
    // Autonomous expressions ride the same additive fold, after the explicit gestures. Their gaze
    // offset stays separate: it is added to the idle base, so an explicit attention target wins.
    const expression = expressionFrame(now);
    for (const channel of Object.keys(adds)) adds[channel] += expression.adds[channel];
    return {
      adds,
      gaze,
      eyeOpen,
      expressionGaze: expression.gaze,
      centerGaze: expression.centerGaze,
    };
  }

  // ---- 2. sample intent -----------------------------------------------------------------
  function sampleIntent(now, dt) {
    const intent = state.intent;
    const frame = {
      turnId: state.turnId,
      playbackToken: state.playbackToken,
      gaze: intent.gaze,
      pose: { ...intent.pose },
      squint: 0,
      touch: intent.touch,
      speaking: false,
      mouthLevel: 0,
      flags: {
        idle: intent.flags?.idle !== false,
        breathing: intent.flags?.breathing !== false,
      },
    };

    // Light squint rises instantly and decays at 0.25 / s (spec §B eye row).
    const targetSquint = clamp01(finite(intent.squint, 0));
    state.squint = targetSquint >= state.squint
      ? targetSquint
      : Math.max(targetSquint, state.squint - LIMITS.SQUINT_DECAY_PER_SECOND * dt);
    frame.squint = state.squint;

    // A live session (lip-sync) owns the mouth outright; it is the only writer whose token
    // matches, so no time-based envelope runs in parallel.
    if (state.mouth.active === true && state.mouth.live === true) {
      frame.speaking = true;
      frame.mouthLevel = clamp01(state.mouth.level);
      state.lastSpeech = { index: -1, level: frame.mouthLevel, speaking: true };
    }

    // Speech envelope: level index from (now - startedAt), then 200 ms fade + 500 ms hold.
    const speech = state.speech;
    if (speech !== null) {
      const elapsed = now - speech.startedAt;
      if (elapsed >= speech.durationMs) {
        const index = levelIndex(elapsed, speech.stepMs, speech.levels.length);
        // Freeze the mouth closed for the hand-off, starting exactly at the scheduled end so
        // the fade is not stretched by a late tick.
        state.release = { startedAt: speech.startedAt + speech.durationMs, level: speech.levels[index] ?? 0 };
        state.speech = null;
        state.lastSpeech = { index, level: state.release.level, speaking: false };
      } else {
        const index = levelIndex(elapsed, speech.stepMs, speech.levels.length);
        frame.speaking = true;
        frame.mouthLevel = clamp01(speech.levels[index]) * clamp01(finite(cfg.speechGain, 1));
        state.lastSpeech = { index, level: frame.mouthLevel, speaking: true };
      }
    }

    if (state.speech === null && state.release !== null) {
      const elapsed = now - state.release.startedAt;
      if (elapsed < TIMING.RELEASE_DURATION_MS) {
        // smoothstep cross-fade: the speech owner still holds the mouth during the fade.
        frame.speaking = true;
        frame.mouthLevel = clamp01(state.release.level) *
          (1 - smoothstep(elapsed / TIMING.RELEASE_DURATION_MS));
      } else if (elapsed < TIMING.RELEASE_DURATION_MS + TIMING.HANDOFF_HOLD_MS) {
        frame.speaking = true;
        frame.mouthLevel = 0;
      } else {
        state.release = null;
        state.lastSpeech = { index: -1, level: 0, speaking: false };
      }
    }

    return frame;
  }

  // ---- 3./4. generators (pre stage: pure functions of time) ------------------------------
  function advanceGenerators(dt, frame) {
    // The expression value is the *baseline* the blink machine sees: it is recorded before any
    // blink factor touches the eye, which is the AIRI `preBlink` idea (§C.2 pitfall 1).
    const expressionEye = clamp01(finite(frame.pose.eyeOpenL ?? frame.pose.eyeOpen, 1));
    state.blink = { ...state.blink, baseline: expressionEye };
    const blinkResult = stepBlink(state.blink, dt, { random });
    state.blink = blinkResult.state;
    state.blinkFactor = blinkResult.factor;

    const breathing = frame.flags.breathing !== false;
    // A slow cycle in EVERY state: speaking only shortens it by the bounded factor, and the
    // effective period is clamped into 3–5 s, so the chest never races the voice.
    const configuredPeriodMs = Math.max(1, finite(cfg.breathPeriodMs, 3600));
    const speed = frame.speaking ? BREATH.SPEAKING_SPEED : 1;
    const periodMs = Math.min(
      TIMING.BREATH_PERIOD_MAX_MS,
      Math.max(TIMING.BREATH_PERIOD_MIN_MS, configuredPeriodMs / speed),
    );
    const periodSeconds = periodMs / 1000;
    state.breathPhase = (state.breathPhase + (Math.PI * 2 / periodSeconds) * dt) % (Math.PI * 2);

    // Our own idle base: one posture controller (held target + smooth drift + micro-noise) feeds
    // EVERY layer below. There is no second idle generator and no fixed-period sine. Speaking
    // damps head sway to 0.6× and body to 0.8×; `flags.idle === false` removes every idle
    // component (breathing stays a separate generator).
    const idleEnabled = frame.flags.idle !== false;
    // Style tempo only advances a SEPARATE time base: the real clock, the update rate and every
    // smoothing constant stay untouched. Style amplitude scales the same curves.
    const eff = state.effective ?? effectiveStyle();
    const modifier = STATUS_MODIFIERS[state.status] ?? STATUS_MODIFIERS.idle;
    state.styleClockMs += dt * 1000 * eff.tempo;
    const t = state.styleClockMs / 1000;
    const motion = advanceMotion(dt, frame);
    const axis = (name) => motion.axes[name]?.current ?? 0;
    const gazeHabit = eff.gazeHabit === 'wandering' ? 1.5 : eff.gazeHabit === 'direct' ? 0.7 : 0.35;
    const gazeDrift = gazeHabit * modifier.gazeDrift;
    // Amplitude is tunable (`idleSwayScale`): these curves become real parameter values, so a
    // host can keep the motion small without changing the arbitration rules. Each channel reads
    // its own override, so head/eye/gaze/body can be tuned independently. `postureReach` and the
    // persona's baseline amplitude raise the *goal* a posture may reach; a quiet persona (0.5)
    // still lands far below a lively one (1.4), while the status modifier keeps its own scale.
    const idleSwayScale = Math.max(0, finite(cfg.idleSwayScale, DEFAULT_CONFIG.idleSwayScale));
    const personaAmplitude = Math.max(0.2, Math.min(1.5, finite(state.style.amplitude, 1)));
    const postureReach = Math.max(0, finite(cfg.postureReach, DEFAULT_CONFIG.postureReach));
    // A per-channel override is an ABSOLUTE amplitude (it already replaces the global one), so it
    // keeps its old linear meaning. An unmentioned channel gets the P-139 reach and persona gain.
    const channelSway = (channel) => idleSwayScale * (state.style.channels[channel]?.amplitude !== undefined
      ? styleChannelAmplitude(eff, channel)
      : postureReach * styleChannelAmplitude(eff, channel) * personaAmplitude);
    const speakingHead = frame.speaking ? SPEECH_HEAD_DAMP : 1;
    // B — speaking micro-motion: a continuous low-frequency pitch sway while the voice plays. The
    // phase uses REAL time (`idleMs`), NOT the tempo-scaled style clock, so persona tempo cannot
    // push it past 0.7 Hz; it is continuous across sentences (never restarted per clip). A smoothed
    // gain pauses it while an explicit gesture runs and resumes it afterwards; only headY is
    // written (headX/gaze/body/breath stay untouched).
    const liveliness = clamp01(finite(state.dimensions?.liveliness, 0));
    const microDegrees = SPEECH_MICRO_MOTION.MIN_DEGREES
      + (SPEECH_MICRO_MOTION.MAX_DEGREES - SPEECH_MICRO_MOTION.MIN_DEGREES) * liveliness;
    const microHz = SPEECH_MICRO_MOTION.MIN_FREQUENCY_HZ
      + (SPEECH_MICRO_MOTION.MAX_FREQUENCY_HZ - SPEECH_MICRO_MOTION.MIN_FREQUENCY_HZ) * liveliness;
    const gestureRunning = state.intents.some((item) => {
      if (item.done === true) return false;
      const elapsed = (state.lastAt ?? 0) - item.startedAt;
      return elapsed >= 0 && elapsed < item.durationMs;
    });
    const microTarget = idleEnabled && frame.speaking === true && gestureRunning !== true ? 1 : 0;
    state.speechMicroGain = approachBounded(
      state.speechMicroGain,
      microTarget,
      SPEECH_MICRO_MOTION.GAIN_PER_SECOND * dt,
    );
    const speechMicro = (microDegrees / OCCASIONAL_ACTION.DEGREES_PER_POSE_UNIT)
      * state.speechMicroGain * Math.sin(Math.PI * 2 * microHz * (state.idleMs / 1000));
    // Head base swing: the posture gain is 0.09 × sway × reach (≈±5° normal, ≈±10° lively).
    const headXAmp = idleEnabled ? 0.09 * channelSway('headX') * speakingHead : 0;
    const headYAmp = idleEnabled ? 0.09 * channelSway('headY') * 0.7 * speakingHead : 0;
    const headZAmp = idleEnabled ? 0.075 * channelSway('headZ') : 0;
    const bodyAmp = idleEnabled ? 0.03 * channelSway('bodyX') * (frame.speaking ? 0.8 : 1) : 0;
    const gazeXAmp = 0.03 * channelSway('gazeX') * gazeDrift;
    const gazeYAmp = 0.02 * channelSway('gazeY') * gazeDrift;
    // Eye-open idle micro-motion is opt-in: `idleEye` (the switch that lets the eye channel be
    // written) or an explicit eye channel override. Otherwise the eye base stays exactly 1, so
    // expressions and blink tests keep their exact values.
    const eyeTuned = cfg.idleEye === true
      || state.style.channels.eyeOpenL !== undefined
      || state.style.channels.eyeOpenR !== undefined;
    const eyeDroop = eyeTuned ? 0.02 * (0.5 + 0.5 * smoothNoise1(hash32(motionSeed, 'eye'), t * 0.31 + 1.1)) : 0;
    const eyeBase = {
      left: clamp01(1 - eyeDroop * styleChannelAmplitude(eff, 'eyeOpenL')),
      right: clamp01(1 - eyeDroop * styleChannelAmplitude(eff, 'eyeOpenR')),
    };
    const breathAmplitude = styleChannelAmplitude(eff, 'breath');
    const thinking = state.status === 'thinking';
    // The tiny drift a hold keeps: ≤1° on the PITCH and ROLL axes on the SAME 30 Hz tick (no timer,
    // no second generator). It is part of the idle sway: it scales with the status modifier (and,
    // on the pitch axis, with the speech head damp) exactly like the head swing, and an explicit
    // `idleSwayScale: 0` stays exactly still. Yaw (headX) is deliberately NOT drifted: it is the
    // attention direction the posture already holds, so a hold never reads as "looking away".
    const driftUnit = idleEnabled ? HOLD_MICRO_DRIFT.DEGREES / OCCASIONAL_ACTION.DEGREES_PER_POSE_UNIT
      * Math.min(1, idleSwayScale) * modifier.amplitude : 0;
    const drift = (name) => (name === 'headX' ? 0 : driftUnit * (name === 'headZ' ? 1 : speakingHead)
      * smoothNoise1(hash32(motionSeed, `drift:${name}`), t * HOLD_MICRO_DRIFT.FREQUENCY_HZ + 1.3));
    motion.holdDrift = { headX: drift('headX'), headY: drift('headY'), headZ: drift('headZ') };
    // Expression gaze (thinking looks up, listening recentres) is part of the idle base: an
    // explicit attention target still overrides it in applyDynamics.
    const expressionGaze = state.expressionGaze ?? { x: 0, y: 0 };
    const idle = {
      ...neutralPose(),
      gazeX: idleEnabled
        ? gazeXAmp * axis('gazeX') + (thinking ? 0.05 * channelSway('gazeX') : 0) + finite(expressionGaze.x, 0)
        : 0,
      gazeY: idleEnabled
        ? gazeYAmp * axis('gazeY') + (thinking ? -0.02 * channelSway('gazeY') : 0) + finite(expressionGaze.y, 0)
        : 0,
      // A thinking pause adds a shallow micro-nod; it is part of the same idle base, not a write.
      headX: headXAmp * axis('headX')
        + (thinking ? 0.02 * channelSway('headX') * smoothNoise1(hash32(motionSeed, 'think'), t * 0.8) : 0)
        + motion.holdDrift.headX,
      headY: headYAmp * axis('headY') + motion.holdDrift.headY + speechMicro,
      headZ: headZAmp * axis('headZ') + motion.holdDrift.headZ,
      browL: 0,
      browR: 0,
      mouth: 0,
      bodyX: bodyAmp * axis('bodyX'),
      bodyY: 0,
      bodyZ: 0,
      breath: 0.5,
    };
    state.idle = idle;

    return {
      blink: { factor: blinkResult.factor, baseline: expressionEye },
      eyeBase,
      idle,
      breath: {
        active: breathing,
        value: clamp01(0.5 + BREATH.AMPLITUDE * breathAmplitude * Math.sin(state.breathPhase)),
        rest: 0.5,
      },
    };
  }

  // ---- 6..13. dynamics: springs, gaze follow, brow slope, clamps -------------------------
  function applyDynamics(composed, frame, dt) {
    const pose = { ...composed };
    const idle = state.idle;
    const prev = state.lastPose;

    // Gaze: explicit target wins, but it fades in / out over 0.4 s (focus-bias fadeSeconds) and
    // follows with a 0.12 s first-order lag (followSeconds). No target → back to idle drift.
    const explicit = normalizeGaze(frame.gaze);
    const weightStep = dt / Math.max(0.001, finite(cfg.gazeFadeMs, 400) / 1000);
    state.gaze.weight = explicit
      ? Math.min(1, state.gaze.weight + weightStep)
      : Math.max(0, state.gaze.weight - weightStep);
    const idleGazeX = finite(idle.gazeX, 0);
    const idleGazeY = finite(idle.gazeY, 0);
    const targetX = explicit ? idleGazeX + (clampSigned(explicit.x) - idleGazeX) * state.gaze.weight : idleGazeX;
    const targetY = explicit ? idleGazeY + (clampSigned(explicit.y) - idleGazeY) * state.gaze.weight : idleGazeY;
    const follow = 1 - Math.exp(-dt / Math.max(0.001, finite(cfg.gazeFollowMs, 120) / 1000));
    state.gaze.x += (targetX - state.gaze.x) * follow;
    state.gaze.y += (targetY - state.gaze.y) * follow;
    pose.gazeX = clampSigned(state.gaze.x);
    pose.gazeY = clampSigned(state.gaze.y);

    // Head / body: add, then spring (k = 30+190·follow, ζ from inertia), then clamp.
    const params = springParams(cfg.spring ?? {});
    for (const axis of SPRING_AXES) {
      const next = stepSpringAxis({
        current: state.springs[axis].current,
        velocity: state.springs[axis].velocity,
        target: clampSigned(finite(pose[axis], 0)),
        dt,
        ...params,
      });
      state.springs[axis] = next;
      pose[axis] = clampSigned(next.current);
    }
    // A damped spring can still overshoot its (already capped) target by a fraction of a degree;
    // the 14° roll guarantee is enforced on the semantic pose, never by truncating the input value.
    pose.headZ = clampHeadRoll(pose.headZ);

    // Brows: slope limit ≤ 6 / s, so an emotion cannot snap them.
    const browStep = LIMITS.BROW_SLOPE_PER_SECOND * dt;
    pose.browL = clampSigned(approachBounded(prev?.browL, pose.browL, browStep));
    pose.browR = clampSigned(approachBounded(prev?.browR, pose.browR, browStep));

    pose.eyeOpenL = clamp01(pose.eyeOpenL);
    pose.eyeOpenR = clamp01(pose.eyeOpenR);
    pose.mouth = clamp01(pose.mouth);
    pose.breath = clamp01(pose.breath);
    return pose;
  }

  /** Move `next` towards `prev` no faster than `maxDelta`; a missing prev means "no limit yet". */
  function approachBounded(prev, next, maxDelta) {
    if (!Number.isFinite(prev)) return next;
    if (!Number.isFinite(next)) return prev;
    if (next > prev + maxDelta) return prev + maxDelta;
    if (next < prev - maxDelta) return prev - maxDelta;
    return next;
  }

  // ---- 1./14./15. one tick ---------------------------------------------------------------
  function resolveNow(nowMs) {
    if (Number.isFinite(nowMs)) return nowMs;
    if (cfg.now !== null) {
      const value = Number(cfg.now());
      if (Number.isFinite(value)) return value;
    }
    return (state.lastAt ?? 0) + 1000 / Math.max(1, finite(cfg.computeHz, 30));
  }

  /**
   * Compute one frame. The first frame uses dt = 1/computeHz (spec §A.3 step 1) and every later
   * frame is clamped to 50 ms. Quantisation and flushing are deliberately absent.
   *
   * @param {number} [nowMs] monotonic milliseconds
   * @returns {Pose} the semantic pose that was published to `pendingFrame`
   */
  function tick(nowMs) {
    const now = resolveNow(nowMs);
    const dt = state.lastAt === null
      ? 1 / Math.max(1, finite(cfg.computeHz, 30))
      : Math.min(Math.max((now - state.lastAt) / 1000, 0), LIMITS.MAX_STEP_SECONDS);
    state.lastAt = now;
    state.idleMs += dt * 1000;
    // ONE effective style for this whole frame: state scaling, idle curve, intents and the mouth
    // all read it, so the same channel can never receive two different final values.
    state.effective = effectiveStyle();

    // The rare micro-action is decided on the same tick, never by a new timer.
    maybeScheduleOccasional(now);
    const intent = intentFrame(now);
    state.lastIntentFrame = intent;
    state.expressionGaze = intent.expressionGaze ?? { x: 0, y: 0 };
    const frame = sampleIntent(now, dt);
    if (intent.gaze !== null) frame.gaze = intent.gaze;
    // Eyes return to centre only when the host has NOT published a verified target AND the gaze is
    // actually off-centre: a real "look at the user" is never overridden, and a centred eye is
    // never written just to write it (an idle frame without a target writes no gaze at all).
    else if (intent.centerGaze === true
      && (Math.abs(state.gaze.x) > 0.03 || Math.abs(state.gaze.y) > 0.03)) {
      frame.gaze = { x: 0, y: 0 };
    }
    // Surprise widens the eyes by raising the expression baseline BEFORE the eye chain is composed,
    // so the blink factor still applies afterwards (the "0 × factor = 0" invariant is untouched).
    if (intent.eyeOpen !== null) {
      if (intent.eyeOpen.left === true) frame.pose.eyeOpenL = 1;
      if (intent.eyeOpen.right === true) frame.pose.eyeOpenR = 1;
    }
    const generators = advanceGenerators(dt, frame);
    const composed = composeChannels(frame, generators, ARBITRATION);
    // Explicit action priority (same-frame, not a plain sum): on a channel an active gesture
    // drives, the idle micro-motion may only contribute INTENT_IDLE_RATIO of the gesture
    // magnitude. The gesture is added AFTER that limit, so it is never cancelled or diluted;
    // everything that is not idle micro-motion (manual pose / touch) is preserved unchanged.
    for (const [channel, value] of Object.entries(intent.adds)) {
      if (value === 0) continue;
      const idleBase = finite(generators.idle?.[channel], 0);
      const cap = INTENT_IDLE_RATIO * Math.abs(value);
      const idlePart = Math.max(-cap, Math.min(cap, idleBase));
      const next = finite(composed[channel], 0) - idleBase + idlePart + value;
      composed[channel] = isBidirectional(channel) ? clampSigned(next) : clamp01(next);
    }
    // The roll is held to the same 14° head budget as the other head channels on the SEMANTIC
    // pose, before the spring and long before the input value: the target itself is capped, so the
    // gesture keeps its smooth shape instead of being truncated on the wire.
    composed.headZ = clampHeadRoll(composed.headZ);
    const pose = applyDynamics(composed, frame, dt);
    publish(pose);
    stepIdleActions(frame, dt, now);
    state.counters.computed += 1;
    return pose;
  }

  // ---- lifecycle ------------------------------------------------------------------------
  /**
   * Start a new turn. turnId and playbackToken both advance, so every writer that captured the
   * old token (mouth producer, subtitle timer, motion sequence) is invalidated on its next write
   * without needing an abort event (spec §D.1).
   */
  function beginTurn({ reason = 'turn' } = {}) {
    state.turnId += 1;
    state.playbackToken += 1;
    state.lastTurnReason = String(reason);
    state.turnStartedAt = clockNow();
    // A new turn owns speech from here on: the previous sender and its token die with it.
    releaseMouth('turn');
    return { turnId: state.turnId, token: state.playbackToken, startedAt: state.turnStartedAt };
  }

  /**
   * Read the current playback token. A producer should capture it *before* it starts decoding and
   * submit it back with `setSpeech({ token, … })`, so an interrupt in between invalidates the
   * decode that is still in flight.
   */
  function getPlaybackToken() {
    return state.playbackToken;
  }

  /**
   * Barge-in: invalidate the token, drop the speech envelope, close the mouth immediately and
   * let the pose fall back to rest (spec §D.1/D.2). The rest pose is published synchronously so
   * the very next flush carries an open-eyed, closed-mouth frame.
   */
  function interrupt({ reason = 'interrupt' } = {}) {
    state.playbackToken += 1;
    state.interrupts += 1;
    state.lastInterruptReason = String(reason);
    // Barge-in also kills the mouth session: its token is revoked and the level is zeroed before
    // the rest pose is published, so no late frame can replay the interrupted line.
    releaseMouth('interrupt');
    state.idleAction.accMs = 0;
    // A barge-in invalidates the queued idle actions too: the pose is being reset to rest, so a
    // pre-interrupt `look-away` must not be taken (and applied) after the reset.
    state.idleAction.queue.length = 0;
    state.intent = { gaze: null, pose: {}, squint: 0, touch: null, flags: { ...(state.intent.flags ?? {}) } };
    // A barge-in also cancels in-flight one-shot gestures: a pre-interrupt nod must not land on
    // the reset pose (its channels are no longer flushed either). This is a hard generation stop,
    // so the remaining trajectory is dropped here instead of fading out over its old duration.
    clearIntents({ reason: `interrupt:${state.lastInterruptReason}`, at: clockNow() });
    state.squint = 0;
    state.speechMicroGain = 0;
    state.blink = createBlinkState({ random, baseline: 1 });
    state.blinkFactor = 1;
    // Pose falls back to rest: springs snap to neutral so nothing keeps pushing the head.
    for (const axis of SPRING_AXES) state.springs[axis] = { current: 0, velocity: 0 };
    state.gaze = { x: 0, y: 0, weight: 0 };
    state.lastSpeech = { index: -1, level: 0, speaking: false };

    if (state.pendingFrame.size > 0) state.counters.dropped += 1;
    const restFrame = {
      speaking: false,
      mouthLevel: 0,
      pose: {},
      gaze: null,
      squint: 0,
      touch: null,
      flags: state.intent.flags,
    };
    const restGenerators = {
      blink: { factor: 1, baseline: 1 },
      eyeBase: { left: 1, right: 1 },
      idle: neutralPose(),
      breath: { active: state.intent.flags?.breathing !== false, value: 0.5, rest: 0.5 },
    };
    const pose = composeChannels(restFrame, restGenerators, ARBITRATION);
    state.idle = restGenerators.idle;
    publish(pose);
    return { token: state.playbackToken, turnId: state.turnId, reason: state.lastInterruptReason };
  }

  /**
   * Hand the speech envelope to the runtime. `levels` is a 10 Hz envelope (one entry per 100 ms,
   * index.js:442 `step = 1600` samples at 16 kHz); `level` accepts a single value for a
   * non-array caller.
   *
   * `token` is the playback token the producer captured from `beginTurn()` / `getPlaybackToken()`
   * before decoding. `interrupt()` advances the token without changing the turn number, so the
   * token is the only reliable way to reject a mouth frame that was decoded for the pre-interrupt
   * audio: a mismatching token is refused with `{ok: false, reason: 'stale-token'}`. Callers that
   * still omit `token` fall back to the legacy turnId-only check.
   */
  function setSpeech({ turnId, token, levels, level, startedAt, durationMs, stepMs } = {}) {
    if (Number.isFinite(token) && token !== state.playbackToken) {
      return { ok: false, reason: 'stale-token', turnId: state.turnId, token: state.playbackToken };
    }
    if (Number.isFinite(turnId) && turnId !== state.turnId) {
      return { ok: false, reason: 'stale turn', turnId: state.turnId, token: state.playbackToken };
    }
    const raw = Array.isArray(levels) ? levels : Number.isFinite(levels) ? [levels] : Number.isFinite(level) ? [level] : null;
    if (raw === null || raw.length === 0) {
      return { ok: false, reason: 'empty levels', turnId: state.turnId, token: state.playbackToken };
    }
    const list = raw.map((value) => clamp01(Number(value)));
    if (list.some((value) => !Number.isFinite(value))) {
      return { ok: false, reason: 'non-numeric level', turnId: state.turnId, token: state.playbackToken };
    }
    const step = Number.isFinite(stepMs) && stepMs > 0 ? stepMs : Math.max(1, finite(cfg.mouthStepMs, 100));
    const start = Number.isFinite(startedAt) ? startedAt : clockNow();
    const duration = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : list.length * step;
    const seat = acquireMouth('speech');
    if (seat.ok !== true) {
      return { ok: false, reason: 'mouth-busy', turnId: state.turnId, token: state.playbackToken };
    }
    state.speech = {
      token: state.playbackToken,
      turnId: state.turnId,
      levels: list,
      stepMs: step,
      startedAt: start,
      durationMs: duration,
    };
    state.release = null;
    return {
      ok: true,
      turnId: state.turnId,
      token: state.playbackToken,
      mouthToken: seat.token,
      startedAt: start,
      durationMs: duration,
      frames: list.length,
    };
  }

  /**
   * Open a mouth session for one sender. `live: true` means the sender pushes levels with
   * `writeMouth` (lip-sync); otherwise the envelope is taken from `levels`, or built from
   * `text` + `durationMs` (one level per `mouthStepMs` slice) and advanced by the tick clock.
   *
   * Only one sender may own the mouth. A different owner is refused with `mouth-busy` unless it
   * passes `takeover: true`, which releases (and visibly closes) the previous sender first.
   * Every session gets a fresh token; tokens from earlier sessions are dead on arrival.
   *
   * @param {{text?: string, durationMs?: number, levels?: number[], stepMs?: number,
   *          startedAt?: number, owner?: string, live?: boolean, takeover?: boolean}} [options]
   * @returns {{ok: boolean, token?: number, sessionId?: number, owner?: string,
   *            mode?: 'envelope'|'live', startedAt?: number, durationMs?: number,
   *            frames?: number, reason?: string}}
   */
  function startSpeech({ text = '', durationMs = 0, levels, stepMs, startedAt, owner, live = false, takeover = false } = {}) {
    const who = typeof owner === 'string' && owner.length > 0 ? owner : 'speech';
    const seat = acquireMouth(who, { takeover });
    if (seat.ok !== true) return seat;
    const mouth = state.mouth;
    if (live === true) {
      mouth.live = true;
      return { ...seat, mode: 'live', frames: 0 };
    }
    const step = Number.isFinite(stepMs) && stepMs > 0 ? stepMs : Math.max(1, finite(cfg.mouthStepMs, TIMING.MOUTH_STEP_MS));
    const source = Array.isArray(levels) && levels.length > 0
      ? levels.map((value) => Number(value))
      : buildSpeechLevels(text, durationMs, step);
    if (source.some((value) => !Number.isFinite(value))) {
      releaseMouth('invalid-levels');
      return { ok: false, reason: 'non-numeric level', token: mouth.token, owner: who };
    }
    const list = source.map((value) => clamp01(value));
    const duration = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : list.length * step;
    const start = Number.isFinite(startedAt) ? startedAt : clockNow();
    mouth.live = false;
    state.speech = { token: mouth.token, turnId: state.turnId, levels: list, stepMs: step, startedAt: start, durationMs: duration };
    state.release = null;
    return { ...seat, mode: 'envelope', startedAt: start, durationMs: duration, frames: list.length };
  }

  /**
   * End the current mouth session synchronously: the mouth is published closed and the session
   * token is revoked, so late frames of the same line are rejected. A stale `token` is refused
   * rather than ending someone else's session.
   */
  function endSpeech({ token } = {}) {
    const mouth = state.mouth;
    if (mouth.active !== true) {
      return { ok: false, reason: 'no-session', token: mouth.token, mouth: mouth.level };
    }
    if (Number.isFinite(token) && token !== mouth.token) {
      mouth.rejected += 1;
      recordEvent('avatar.mouth.stale-end', { token, current: mouth.token });
      return { ok: false, reason: 'stale-token', token: mouth.token, mouth: mouth.level };
    }
    const ended = { token: mouth.token, owner: mouth.owner };
    releaseMouth('ended', { publishMouth: true });
    recordEvent('avatar.mouth.ended', ended);
    return { ok: true, token: ended.token, mouth: 0 };
  }

  /**
   * The only write path a sender may use. A finite token matching the live session is mandatory,
   * so two senders can never interleave their levels; a mismatched token (or no session) is
   * rejected and counted. The input name comes from the discovered mapping — an unmapped mouth
   * is refused with `unmapped` and never reaches the writer. Transport failures (sync throw,
   * async rejection or a resolved `{ok:false}`) are reported as events, never thrown here. A
   * write whose transport settles after its session was interrupted, ended or taken over is
   * dropped as `stale-write` before it can touch the current frame.
   */
  async function writeMouth({ value, token, owner } = {}) {
    const mouth = state.mouth;
    const level = Number(value);
    const owns = mouth.active === true && Number.isFinite(token) && token === mouth.token;
    if (owns !== true || (typeof owner === 'string' && owner.length > 0 && owner !== mouth.owner)) {
      mouth.rejected += 1;
      const reason = mouth.active === true ? 'stale-token' : 'no-session';
      recordEvent('avatar.mouth.rejected', { reason, token: Number.isFinite(token) ? token : null, current: mouth.token });
      return { ok: false, reason, token: mouth.token, writes: mouth.writes, rejected: mouth.rejected };
    }
    if (!Number.isFinite(level)) return { ok: false, reason: 'non-numeric level', token: mouth.token };
    // Capture the seat the write was issued for; everything below re-validates against it.
    const seatToken = mouth.token;
    const seatOwner = mouth.owner;
    const seatGeneration = state.playbackToken;
    const input = resolveMouthInput();
    if (input === null) {
      mouth.unmapped += 1;
      if (mouth.unmappedLogged !== true) {
        mouth.unmappedLogged = true;
        recordEvent('avatar.mouth.unmapped', { token: mouth.token, owner: mouth.owner });
      }
      return { ok: false, reason: 'unmapped', token: mouth.token, writes: mouth.writes };
    }
    const routed = await emitWrite(input, clamp01(level));
    if (routed.ok !== true) {
      mouth.failed += 1;
      return { ok: false, reason: 'write-failed', token: mouth.token, errors: state.errors };
    }
    // The transport may settle long after `await`: an interrupt, an `endSpeech` or a takeover can
    // have killed this session in the meantime. Re-validate ownership and only then touch the
    // frame — a late successful write must never reopen the mouth (P1 stale-write).
    if (mouth.token !== seatToken || mouth.owner !== seatOwner || mouth.active !== true
      || state.playbackToken !== seatGeneration) {
      mouth.stale += 1;
      if (mouth.staleLogged.has('stale-write') !== true) {
        mouth.staleLogged.add('stale-write');
        recordEvent('avatar.mouth.stale', {
          reason: 'stale-write', token: seatToken, owner: seatOwner,
          current: mouth.token, active: mouth.active, generation: seatGeneration,
        });
      }
      return { ok: false, reason: 'stale-write', token: mouth.token, writes: mouth.writes };
    }
    mouth.level = clamp01(level);
    mouth.writes += 1;
    publish({ ...(state.lastPose ?? neutralPose()), mouth: mouth.level });
    return { ok: true, token: mouth.token, value: mouth.level, writes: mouth.writes, sessionId: mouth.seq };
  }

  /**
   * Patch the intent. Only the provided keys change; `null` clears a group. This is the single
   * entry point for controllers / emotion / manual pose / touch offsets.
   */
  function setIntent(patch = {}) {
    if (patch === null || typeof patch !== 'object') return currentIntent();
    const intent = state.intent;
    if ('gaze' in patch) intent.gaze = normalizeGaze(patch.gaze);
    if ('pose' in patch) {
      intent.pose = patch.pose === null || patch.pose === undefined ? {} : { ...intent.pose, ...numericOnly(patch.pose) };
    }
    if ('squint' in patch) intent.squint = clamp01(finite(patch.squint, 0));
    if ('touch' in patch) {
      intent.touch = patch.touch === null || patch.touch === undefined ? null : numericOnly(patch.touch);
    }
    if ('flags' in patch) {
      intent.flags = {
        ...intent.flags,
        ...(patch.flags === null ? {} : patch.flags),
      };
    }
    return currentIntent();
  }

  function numericOnly(source) {
    const out = {};
    for (const [key, value] of Object.entries(source ?? {})) {
      if (Number.isFinite(value)) out[key] = value;
    }
    return out;
  }

  function currentIntent() {
    return {
      gaze: state.intent.gaze ? { ...state.intent.gaze } : null,
      pose: { ...state.intent.pose },
      squint: state.intent.squint,
      touch: state.intent.touch ? { ...state.intent.touch } : null,
      flags: { ...state.intent.flags },
      /** P-139 stage 3: the last replacement actually drawn (null until the first gesture). */
      lastVariant: state.variant.lastInfo === null ? null : { ...state.variant.lastInfo },
    };
  }

  // ---- observation (spec §E.4) ----------------------------------------------------------
  function snapshot() {
    const mapped = (Array.isArray(cfg.channels) ? cfg.channels : []).filter((channel) => CHANNELS.includes(channel));
    return {
      fps: {
        compute: finite(cfg.computeHz, 30),
        flush: Math.max(1, Math.round(1000 / Math.max(1, finite(cfg.flushIntervalMs, 100)))),
      },
      frames: {
        computed: state.counters.computed,
        taken: state.counters.taken,
        coalesced: state.counters.taken + state.counters.overwritten,
        overwritten: state.counters.overwritten,
        dropped: state.counters.dropped,
        pending: state.pendingFrame.size > 0 ? 1 : 0,
      },
      channels: { mapped, unmapped: CHANNELS.filter((channel) => !mapped.includes(channel)) },
      turn: {
        turnId: state.turnId,
        token: state.playbackToken,
        reason: state.lastTurnReason,
        speaking: state.speech !== null || state.release !== null
          || (state.mouth.active === true && state.mouth.live === true),
        mouthLevel: state.lastSpeech.level,
        speechIndex: state.lastSpeech.index,
        elapsedMs: state.lastAt === null ? 0 : Math.max(0, state.lastAt - state.turnStartedAt),
      },
      blink: {
        phase: state.blink.phase,
        factor: state.blinkFactor,
        baseline: state.blink.baseline,
        delayMs: state.blink.delayMs,
        durationMs: state.blink.duration,
      },
      squint: state.squint,
      /** Current intent patch (gaze/pose/flags): observation only, speech never rewrites it. */
      intent: currentIntent(),
      /** Persona style is the baseline; effective is baseline × the current state modifier. */
      style: {
        baseline: { ...state.style },
        effective: { ...(state.effective ?? effectiveStyle()) },
        version: state.styleVersion,
        /** P-139 stage 3: expression dimensions derived from the baseline persona style. */
        dimensions: { ...state.dimensions },
      },
      status: state.status,
      intents: {
        active: state.intents.filter((item) => item.done !== true).map((item) => ({
          kind: item.kind,
          channels: [...item.channels],
          remainingMs: Math.max(0, item.durationMs - ((state.lastAt ?? 0) - item.startedAt)),
        })),
        settling: state.intents.filter((item) => item.done === true).length,
        channels: intentChannels(),
        last: state.intents.length > 0 ? state.intents[state.intents.length - 1].kind : '',
        /**
         * The additive axis target the ACTIVE intents produced on the last tick (all zero = the
         * pure idle base). A cleared generation leaves no residual value here.
         */
        target: state.lastIntentFrame === null ? null : {
          ...state.lastIntentFrame.adds,
          gaze: state.lastIntentFrame.gaze === null ? null : { ...state.lastIntentFrame.gaze },
        },
      },
      gaze: { x: state.gaze.x, y: state.gaze.y, weight: state.gaze.weight },
      springs: Object.fromEntries(
        SPRING_AXES.map((axis) => [axis, { ...state.springs[axis] }]),
      ),
      pose: state.lastPose === null ? neutralPose() : { ...state.lastPose },
      mouth: {
        active: state.mouth.active,
        owner: state.mouth.owner,
        token: state.mouth.token,
        sessions: state.mouth.seq,
        mode: state.mouth.active === true ? (state.mouth.live === true ? 'live' : 'envelope') : null,
        value: state.mouth.level,
        writes: state.mouth.writes,
        rejected: state.mouth.rejected,
        failed: state.mouth.failed,
        stale: state.mouth.stale,
        unmapped: state.mouth.unmapped,
        busy: state.mouth.busy,
        takeovers: state.mouth.takeovers,
        ended: state.mouth.ended,
      },
      idleActions: {
        intervalMs: finite(cfg.idleActionIntervalMs, DEFAULT_CONFIG.idleActionIntervalMs),
        dedupeMs: finite(cfg.idleActionDedupeMs, DEFAULT_CONFIG.idleActionDedupeMs),
        emitted: state.idleAction.emitted,
        suppressed: state.idleAction.suppressed,
        queued: state.idleAction.queue.length,
        last: state.idleAction.last,
      },
      /**
       * Continuous motion controller: the held posture, how often it was re-drawn (vs held),
       * the relaxation factor and the per-axis trajectory state. This is the ONE place all layers
       * read their slow baseline from.
       */
      motion: {
        seed: cfg.seed === undefined ? null : cfg.seed,
        decisionHz: finite(cfg.decisionHz, MOTION_DECISION_HZ),
        posture: {
          target: { ...state.motion.posture.target },
          /** The last IDLE-drawn goal a short action nudges from (B). */
          base: { ...state.motion.posture.base },
          heldSince: state.motion.posture.heldSince,
          remainingMs: Math.max(0, state.motion.holdUntil - (state.lastAt ?? 0)),
          transitions: state.motion.posture.transitions,
          shortTransitions: state.motion.posture.shortTransitions,
          relaxTransitions: state.motion.posture.relaxTransitions,
          stills: state.motion.posture.stills,
          lastDecision: state.motion.posture.lastDecision,
          lastTransition: state.motion.posture.lastTransition === null
            ? null : { ...state.motion.posture.lastTransition, axes: [...state.motion.posture.lastTransition.axes] },
        },
        transition: state.motion.transition === null ? null : {
          ...state.motion.transition,
          from: { ...state.motion.transition.from },
          to: { ...state.motion.transition.to },
          axes: [...state.motion.transition.axes],
        },
        axes: Object.fromEntries(MOTION_AXES.map((axis) => [axis, { ...state.motion.axes[axis] }])),
        postureDecisions: state.motion.postureDecisions,
        postureSwitches: state.motion.postureSwitches,
        postureHolds: state.motion.postureHolds,
        holdUntil: state.motion.holdUntil,
        holdMs: state.motion.holdMs,
        /** A: which hold allocation this window came from ('lively' | 'base' | 'config'). */
        holdVariant: state.motion.holdVariant,
        /** The hold drift, in pose units (≤ HOLD_MICRO_DRIFT.DEGREES per head axis). */
        holdDrift: { ...state.motion.holdDrift, maxDegrees: HOLD_MICRO_DRIFT.DEGREES },
        /** B: the last short response action that landed its posture (observation only). */
        shortAction: state.motion.shortAction === null ? null : {
          ...state.motion.shortAction,
          delta: { ...state.motion.shortAction.delta },
        },
        lastDecisionAt: state.motion.lastDecisionAt,
        relaxation: state.motion.relax,
        /** Item 4: the active (or last) explicit 2–4 s relax plan. */
        relaxPlan: state.motion.relaxPlan === null ? null : { ...state.motion.relaxPlan },
        frames: state.motion.frames,
        lastFrameAt: state.motion.lastFrameAt,
        attention: {
          ...state.motion.attention,
          target: { ...state.motion.attention.target },
        },
        limits: {
          // The larger bound belongs to the planned posture transition; the hold tracker below
          // still uses `motionMaxVelocity` / `motionMaxAcceleration` for its own steps.
          maxVelocity: Math.max(motionMaxVelocity, POSTURE_TRANSITION.MAX_VELOCITY),
          maxAcceleration: Math.max(motionMaxAcceleration, POSTURE_TRANSITION.MAX_ACCELERATION),
          follow: motionFollow,
        },
        /**
         * Autonomous expression layer: which bounded envelopes are active, plus the 20–40 s
         * occasional schedule. Read-only copies; the caps are the motion budget, never a target.
         */
        expressions: {
          active: state.expressions.map((item) => ({
            kind: item.kind,
            startedAt: item.startedAt,
            durationMs: item.durationMs,
            channels: [...item.channels],
            faded: item.fadedAt !== null,
          })),
          occasional: {
            starts: state.occasional.starts,
            lastAt: state.occasional.lastAt,
            lastKind: state.occasional.lastKind,
            nextAt: state.occasional.nextAt,
          },
          /**
           * Channels that are only still being written to finish their return to the baseline
           * after their expression ended (see EXPRESSION_RELEASE). Empty in the steady state.
           */
          releasing: [...state.releases].map(([channel, entry]) => ({
            channel, atMs: entry.atMs, frames: entry.frames, kind: entry.kind,
          })),
          caps: {
            headDegrees: EXPRESSION_MOTION.MAX_HEAD_DEGREES,
            gaze: EXPRESSION_MOTION.MAX_GAZE,
            bodyDegrees: EXPRESSION_MOTION.MAX_BODY_DEGREES,
          },
        },
      },
      errors: state.errors,
      events: state.events.slice(-8),
      lastError: state.lastError,
    };
  }

  return {
    tick,
    beginTurn,
    getPlaybackToken,
    interrupt,
    setSpeech,
    startSpeech,
    endSpeech,
    writeMouth,
    setIntent,
    setStyle,
    setStatus,
    setIdleActions,
    intent,
    /**
     * Autonomous expression layer entry points (thinking / listening / occasional). The facade
     * calls these on a communication phase edge; they start one bounded envelope on the same tick.
     */
    expression: (kind, at) => startExpression(kind, at),
    fadeExpression: (kind, at) => fadeExpression(kind, at),
    clearExpressions: (reason) => clearExpressions(reason),
    /**
     * Expression release: called by the ONE writer with the value it is about to send, so the
     * release is judged on the REAL written value. Returns that value, or 0 for the one forced
     * write of a timed-out release.
     */
    settleReleaseWrite: (channel, value) => settleReleaseWrite(channel, value),
    /** Item 4: decay the posture amplitude to the base over 2–4 s (conversation end). */
    relax,
    cancelIntent,
    clearIntents,
    setAttention,
    takePendingFrame,
    takeEvents,
    takeActions,
    snapshot,
    // The pending slot is read through a getter so a caller can never hold a stale Map
    // thinking it is the live one.
    get pendingFrame() {
      return state.pendingFrame;
    },
    config: { ...cfg },
  };
}

export {
  MOTION_AXES,
  intentVisibleFloor,
  applyVisibleFloor,
  smootherstep,
  conclusionEnvelope,
  DEFAULT_CONFIG,
  neutralPose,
  levelIndex,
};
