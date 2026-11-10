/** motion-controller — extracted from avatarRuntime.js; no host entry dependency. */
import { isMotionProfile } from './motionEvents.js';
import {
  ARBITRATION,
  BREATH,
  CHANNELS,
  IDLE_WRITE_CHANNELS,
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
  avatarExpressionStyleTags,
  coerceAvatarStyle,
  deriveAvatarStyleDimensions,
  normalizeAvatarStyle,
  splitAvatarStyleDimensions,
  styleChannelAmplitude,
} from './style.js';
import {
  INTENT_CHANNEL_TARGETS,
  INTENT_IDLE_RATIO,
  INTENT_KINDS,
  INTENT_SETTLE_MS,
  INTENT_VARIANTS,
  MOTION_STATUSES,
  PRESET_EXECUTION,
  PRESET_GESTURE_GAIN,
  PRESET_NATIVE_CHANNELS,
  PRESET_OPERATION_CHANNELS,
  PRESET_OPERATION_OPTIONAL_CHANNELS,
  SPEECH_HEAD_DAMP,
  STATUS_MODIFIERS,
  STYLE_DIMENSION_APPLICATION,
  intentChannelsFor,
  styleTraitEffects,
} from './motion-config.js';
import { createPresetSelector } from './preset-selector.js';
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


// ---------------------------------------------------------------------------------------------
// Phase 1 posture components — the independent slow layer the preset trajectories ride on
// ---------------------------------------------------------------------------------------------
//
// A component is a SMALL, bounded head posture (natural / lean-left / lean-right / look-back) held
// for one component window. It is folded into the SAME 1 Hz posture scheduler and the SAME
// `state.motion.posture.target` / `startPostureTransition()` path as every other posture goal:
// no second writer, no second timer. The high-frequency controller still interpolates the planned
// transition at `computeHz`, so a component only CHOOSES a goal once per decision.
//
// Only the verified head channels are driven. Gaze / body / breath are deliberately absent: they
// either have no idle write path (gaze/body) or are VTS-native (body/breath), so a component must
// not claim them before a real-VTS probe exists.
export const POSTURE_COMPONENT_CHANNELS = Object.freeze(['headX', 'headY', 'headZ']);

/** A component is held for this window. A persona may stretch/shrink it, always inside the band. */
export const POSTURE_COMPONENT_MIN_MS = 10_000;
export const POSTURE_COMPONENT_MAX_MS = 20_000;

/**
 * Semantic amplitude band of one component. ONE SEMANTIC UNIT = 30° (the writer's documented
 * convention), so 0.15 = 4.5°. The cap is applied to the COMPONENT TARGET after the persona/status
 * gain is known; this layer never multiplies a global "visibility" gain on top.
 */
export const POSTURE_COMPONENT_MIN_AMPLITUDE = 0.10;
export const POSTURE_COMPONENT_MAX_AMPLITUDE = 0.15;

/**
 * The phase-1 component library. `headX/headY/headZ` are normalized shape weights: the selected
 * amplitude (semantic units, ≤0.15) is converted to that axis's own pose unit through the live
 * persona gain, so the target stays semantic-bounded instead of depending on a hard-coded scale.
 */
export const POSTURE_COMPONENTS = Object.freeze([
  Object.freeze({ id: 'natural', label: '自然', headX: 0, headY: 0, headZ: 0 }),
  Object.freeze({ id: 'lean-left', label: '左侧倾', headX: 0.22, headY: 0, headZ: 1 }),
  Object.freeze({ id: 'lean-right', label: '右侧倾', headX: -0.22, headY: 0, headZ: -1 }),
  Object.freeze({ id: 'look-back', label: '偏头/回看', headX: 1, headY: 0.18, headZ: 0.28 }),
]);


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


/**
 * Item 5 — the answer's opening gesture may TAKE OVER a pre-answer action.
 *
 * `answer-start` is bound to the first body clip's REAL start, so it arrives while a thinking /
 * listening / idle draw may still own the pose. Waiting for that action would move the gesture
 * past the moment it belongs to, and cutting it would jump the pose. The opening gesture therefore
 * takes over, but only:
 *   - from an autonomous, pre-answer action (an explicit gesture is never displaced);
 *   - on the channels the two really share — every other channel keeps its current owner;
 *   - through a short cross-fade inside [FADE_MIN_MS, FADE_MAX_MS], so the pose never jumps.
 * An owner outside that class, a transition outside the window or a channel set that cannot be
 * split is a REFUSAL (`takeover-unavailable`): the opening gesture is skipped, never queued.
 */
export const PRESET_TAKEOVER = Object.freeze({
  FADE_MS: 200,
  FADE_MIN_MS: 120,
  /** Hard ceiling: a longer transition is not the "short hand-over" this feature may take. */
  FADE_MAX_MS: 240,
  /** The only action phases that may yield (an autonomous / pre-answer draw). */
  YIELDABLE_EVENTS: Object.freeze([
    'thinking', 'listening', 'user-speaking', 'turn-start', 'idle', 'sentence-gap',
  ]),
  /** Channels written absolutely (a min blend): two owners can never share one, so no takeover. */
  ABSOLUTE_CHANNELS: Object.freeze(['eyeOpenL', 'eyeOpenR']),
});


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
  /**
   * Listening/thinking stays mostly quiet, but it is NOT a structural freeze: hold + still must
   * leave a small legal move chance (see stepPostureDecision). A value of 1 would make `moves`
   * unreachable no matter how long the state lasts.
   */
  postureListenStillChance: 0.55,
  /**
   * Component hold window. The phase-1 band is 10–20 s; a persona tempo/composure factor may
   * stretch the draw inside that band (never outside it). An explicit host value pins the draw.
   */
  postureComponentMinMs: POSTURE_COMPONENT_MIN_MS,
  postureComponentMaxMs: POSTURE_COMPONENT_MAX_MS,
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
  /**
   * Local diagnosis only: whether preset DECISIONS/EXECUTION are also reported as throttled debug
   * events (`avatar.preset.select/skip/commit/start`). It never gates selection/execution/transport
   * — the `status.live2d.runtime.motion.presets` projection is maintained either way.
   */
  presetDebugEvents: true,
  /**
   * Answer-start takeover cross-fade (item 5). Configurable inside [120, 240] ms; a value outside
   * that window makes the takeover unavailable instead of silently clamping it to a snap or a
   * long dissolve.
   */
  presetTakeoverFadeMs: PRESET_TAKEOVER.FADE_MS,
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


// ---------------------------------------------------------------------------------------------
// Motion preset execution — symbolic operations, never the four legacy intents
// ---------------------------------------------------------------------------------------------

/**
 * Which preset event a host state uses at an autonomous idle boundary. `speaking` deliberately
 * has no autonomous draw: `sentence-gap` must follow a REAL playback boundary, so the runtime
 * calls `preset()` from its clip-start/speech-end path instead of sampling one here.
 */
const PRESET_EVENT_BY_STATE = Object.freeze({
  idle: 'idle',
  waiting: 'idle',
  tired: 'idle',
  listening: 'user-speaking',
  thinking: 'thinking',
});

/** Host phase names (motionEvents.js) → preset event vocabulary (presets/catalog.js). */
const PRESET_EVENT_FOR_PHASE = Object.freeze({
  'turn-start': 'user-speaking',
  'user-speaking': 'user-speaking',
  thinking: 'thinking',
  'answer-start': 'answer-start',
  'answer-end': 'answer-end',
  idle: 'idle',
  confused: 'confused',
  conclusion: 'affirm',
});

/**
 * `head-sway` shaping. The primary channel is the head ROLL (headZ), not the yaw (headX): a light
 * body-weight sway reads as the head leaning left/right, while a tiny yaw keeps it from looking like
 * a pure two-dimensional turn. The values are fractions of the sway's own nominal amount.
 */
export const PRESET_SWAY = Object.freeze({
  /** headX companion as a fraction of the headZ primary (the requested 0.2–0.3 band). */
  HEAD_X_RATIO: 0.24,
  /** Fallback when the model verifies no headZ: keep a small yaw-only sway, never the full nominal. */
  YAW_ONLY_SCALE: 0.5,
  /**
   * Planned roll peak. The final semantic pose still has the shared 14° cap; leaving room for the
   * idle micro-motion (same 0.2 arbitration ratio as the occasional roll) keeps the sway smooth
   * instead of flat-topping at the clamp.
   */
  HEAD_BUDGET: HEAD_ROLL_CAP / (1 + INTENT_IDLE_RATIO),
  /** First lean reaches its peak at 42–52 % of the active phase. */
  TURN_AT_MIN: 0.42,
  TURN_AT_SPAN: 0.10,
  /** The crossing ends at the second peak at 78–84 %; the rest settles into the dwell. */
  CROSS_AT_MIN: 0.78,
  CROSS_AT_SPAN: 0.06,
  /** The second side is deliberately not a mirror of the first (asymmetric lean). */
  SECOND_SCALE_MIN: 0.62,
  SECOND_SCALE_SPAN: 0.28,
  /** The dwell keeps 72–90 % of the second lean instead of forcing the pose back to zero. */
  HOLD_LEVEL_MIN: 0.72,
  HOLD_LEVEL_SPAN: 0.18,
  /** Dwell length multiplier for the same reason: two draws must not look identical. */
  HOLD_SCALE_MIN: 0.85,
  HOLD_SCALE_SPAN: 0.35,
});

/**
 * One symbolic operation → the trajectory the executor generates. `amount` is in semantic pose
 * units at persona amplitude 1 (one unit = 30° for head channels); it is scaled by the persona
 * style and the room left in the chosen direction at execution time. Nothing here is a VTS
 * parameter name and nothing asserts a visible minimum.
 */
const PRESET_OPERATION_PROFILE = Object.freeze({
  'head-turn': Object.freeze({ kind: 'move', amount: 0.42, sign: 0, active: 'TURN_ACTIVE_MS' }),
  'head-tilt': Object.freeze({ kind: 'move', amount: 0.34, sign: 0, tilt: true, active: 'TILT_ACTIVE_MS' }),
  'head-lower': Object.freeze({ kind: 'move', amount: -0.30, sign: -1, active: 'TURN_ACTIVE_MS' }),
  'head-lift': Object.freeze({ kind: 'move', amount: 0.30, sign: 1, active: 'TURN_ACTIVE_MS' }),
  'head-center': Object.freeze({ kind: 'center', amount: 0, active: 'TURN_ACTIVE_MS' }),
  // Horizontal-only settle: same duration/amplitude class as `head-center`, but its channel set is
  // headX alone (see the runtime addition below), so a yaw-only model never falls back to roll.
  'head-center-lite': Object.freeze({ kind: 'center', amount: 0, active: 'TURN_ACTIVE_MS' }),
  nod: Object.freeze({ kind: 'nod', amount: -0.30, sign: -1, active: 'NOD_ACTIVE_MS' }),
  'double-nod': Object.freeze({ kind: 'double-nod', amount: -0.30, sign: -1, active: 'DOUBLE_NOD_ACTIVE_MS' }),
  shake: Object.freeze({ kind: 'shake', amount: 0.32, sign: 0, active: 'SHAKE_ACTIVE_MS' }),
  // The idle sway is NOT a slower shake: it has its own `sway` kind, a headZ-led asymmetric lean
  // (left → through the middle → right → dwell), and it never reverses the negation semantics.
  'head-sway': Object.freeze({ kind: 'sway', amount: 0.62, sign: 0, active: 'SWAY_ACTIVE_MS' }),
  'gaze-side': Object.freeze({ kind: 'move', amount: 0.34, sign: 0, gaze: 'away', active: 'GAZE_ACTIVE_MS' }),
  'gaze-up': Object.freeze({ kind: 'move', amount: 0.30, sign: 1, gaze: 'away', active: 'GAZE_ACTIVE_MS' }),
  'gaze-down': Object.freeze({ kind: 'move', amount: -0.30, sign: -1, gaze: 'away', active: 'GAZE_ACTIVE_MS' }),
  'gaze-target': Object.freeze({ kind: 'target', amount: 0, gaze: 'target', active: 'GAZE_ACTIVE_MS' }),
  'gaze-center': Object.freeze({ kind: 'center', amount: 0, gaze: 'center', active: 'GAZE_ACTIVE_MS' }),
  blink: Object.freeze({ kind: 'blink', amount: 0.92, sign: 1, active: 'BLINK_ACTIVE_MS' }),
  'double-blink': Object.freeze({ kind: 'double-blink', amount: 0.92, sign: 1, active: 'DOUBLE_BLINK_ACTIVE_MS' }),
  'brow-lift': Object.freeze({ kind: 'move', amount: 0.30, sign: 1, active: 'BROW_ACTIVE_MS' }),
  'brow-knit': Object.freeze({ kind: 'move', amount: -0.28, sign: -1, active: 'BROW_ACTIVE_MS' }),
  'brow-one': Object.freeze({ kind: 'move', amount: 0.32, sign: 0, browOne: true, active: 'BROW_ACTIVE_MS' }),
  'body-lean': Object.freeze({ kind: 'native', amount: 0 }),
  'body-settle': Object.freeze({ kind: 'native', amount: 0 }),
  'body-tilt': Object.freeze({ kind: 'native', amount: 0 }),
  'breath-cycle': Object.freeze({ kind: 'native', amount: 0 }),
});

/**
 * Runtime channel sets for operations added to the read-only library after the static executor
 * table in `motion-config.js` was written. `head-center-lite` is headX-only BY DEFINITION: it may
 * settle the head to its natural horizontal baseline but must never touch headZ (roll). This is a
 * capability mapping, not a fallback — the selector still hard-filters on the recipe's `requires`.
 */
const PRESET_OPERATION_CHANNEL_ADDITIONS = Object.freeze({
  'head-center-lite': Object.freeze(['headX']),
});

const PRESET_HEAD_CHANNELS = Object.freeze(['headX', 'headY', 'headZ']);
const PRESET_GAZE_CHANNELS = Object.freeze(['gazeX', 'gazeY']);

/**
 * Preset decision observability (read-only). `config.presetDebugEvents` only gates the EVENTS —
 * the projection counters below are always maintained. Selection decisions stay at one per class
 * per second. A commit is throttled to one per second, but never silently dropped: the first and
 * the last acknowledgement of each action are always written (the middle ones are merged into the
 * last), because each commit payload already carries the action's cumulative merge window
 * (`firstAt`/`lastAt`/`firstValue`/`lastValue`) plus two distinct amplitude metrics: `peak` is the
 * whole-action maximum |acknowledged value| over every frame/channel, and `lastAbs` keeps the tail
 * value (max |last acknowledged value per channel|) that the old `peak` field used to report.
 */
const PRESET_DEBUG_THROTTLE_MS = 1000;
const PRESET_COMMIT_THROTTLE_MS = 1000;
/**
 * D: after a real semantic action starts, the autonomous idle boundary stays quiet for this long.
 * This is a separate clock: it never moves `nextDecisionAt`, and it only gates the idle draw —
 * semantic events themselves keep their normal selection/arbitration path.
 */
const PRESET_SEMANTIC_QUIET_MS = 2000;
/** B: the offset channels exposed to the selector (actual − natural), one value per axis. */
const PRESET_POSTURE_OFFSET_CHANNELS = Object.freeze(['headX', 'headY', 'headZ', 'gazeX', 'gazeY', 'bodyX']);
/** Closed vocabulary of "why no preset ran" (`status.live2d.runtime.motion.presets.skips`). */
const PRESET_SKIP_REASONS = Object.freeze(['no-candidate', 'hold', 'channel-unverified', 'throttled', 'busy']);

/**
 * Reasons that mean "the user interrupted us", not "a new generation owns the pose". They take the
 * smooth 240 ms preset fade; every other invalidation (turn/model/channel switch, lock, teardown)
 * keeps the 0 ms hard stop, so no old action can survive into the next generation.
 */
const SMOOTH_INTERRUPT_REASON = /interrupt|barge[-_ ]?in/i;
const SMOOTH_INTERRUPT_FADE_MS = 240;

const presetClamp = (value, limit) => Math.max(-limit, Math.min(limit, finite(value, 0)));

/**
 * Planned amplitude of one stage, read from the executor's OWN already-resolved amounts (never a
 * new physical quantity): the largest |offset| it may ask for on any channel of that stage.
 */
function presetStageAmplitude(stage) {
  let peak = 0;
  for (const map of [stage.channelAmounts, stage.cancelOffsets, stage.targetOffsets]) {
    for (const value of Object.values(map ?? {})) {
      if (Number.isFinite(value)) peak = Math.max(peak, Math.abs(value));
    }
  }
  return peak;
}

/** Plain copy of the planned stages for the start event (the live trace objects mutate later). */
function presetPlannedStages(stages) {
  return stages.map((stage) => ({
    op: stage.op,
    kind: stage.kind,
    channels: [...stage.channels],
    startMs: Math.round(stage.start),
    activeMs: Math.round(stage.activeMs),
    holdMs: Math.round(stage.holdMs),
    exitMs: Math.round(stage.exitMs),
    amplitude: presetStageAmplitude(stage),
  }));
}

/** True when one operation list contains a head roll (the tilt family, used for style bias). */
const hasTiltOperation = (preset) => Array.isArray(preset?.operations)
  && preset.operations.some((operation) => operation === 'head-tilt');

/** Classify a recipe's gaze content for the `gazeHabit` weighting/dwell consumer. */
const gazeKindOf = (preset) => {
  const operations = Array.isArray(preset?.operations) ? preset.operations : [];
  if (operations.includes('gaze-target')) return 'target';
  if (operations.includes('gaze-center')) return 'center';
  if (operations.some((operation) => operation === 'gaze-side'
    || operation === 'gaze-up' || operation === 'gaze-down')) return 'away';
  return null;
};

/** Clone one trace into a bounded, caller-safe shape (snapshot / return values). */
function clonePresetTrace(trace) {
  if (trace === null || typeof trace !== 'object') return null;
  return {
    at: trace.at,
    selection: {
      ...trace.selection,
      reasons: [...(trace.selection?.reasons ?? [])],
      droppedChannels: [...(trace.selection?.droppedChannels ?? [])],
      effectiveRequires: [...(trace.selection?.effectiveRequires ?? [])],
      operations: [...(trace.selection?.operations ?? [])],
      verifiedChannels: [...(trace.selection?.verifiedChannels ?? [])],
    },
    output: {
      ...trace.output,
      stages: (trace.output?.stages ?? []).map((stage) => ({
        ...stage,
        channels: [...(stage.channels ?? [])],
        phases: [...(stage.phases ?? [])],
      })),
      channels: [...(trace.output?.channels ?? [])],
      droppedChannels: [...(trace.output?.droppedChannels ?? [])],
      samples: (trace.output?.samples ?? []).map((sample) => ({
        ...sample,
        channels: { ...(sample.channels ?? {}) },
      })),
      /** The controller's own pose (never a commit) and the rows the sender really built. */
      computed: { ...(trace.output?.computed ?? {}) },
      /**
       * Sender evidence, FIVE phases that may never masquerade as each other:
       * prepared → assembled, attempted → transport call started, committed → `ok:true` acknowledged,
       * failed → rejected/thrown, stale → result discarded because its generation/action moved on.
       */
      prepared: { ...(trace.output?.prepared ?? {}) },
      preparedFrames: trace.output?.preparedFrames ?? 0,
      attempted: { ...(trace.output?.attempted ?? {}) },
      attemptedFrames: trace.output?.attemptedFrames ?? 0,
      committed: { ...(trace.output?.committed ?? {}) },
      committedAt: { ...(trace.output?.committedAt ?? {}) },
      failed: {
        count: trace.output?.failed?.count ?? 0,
        at: trace.output?.failed?.at ?? null,
        codes: { ...(trace.output?.failed?.codes ?? {}) },
        lastCode: trace.output?.failed?.lastCode ?? '',
      },
      stale: {
        count: trace.output?.stale?.count ?? 0,
        at: trace.output?.stale?.at ?? null,
        reasons: { ...(trace.output?.stale?.reasons ?? {}) },
        lastReason: trace.output?.stale?.lastReason ?? '',
      },
      skippedByTransport: { ...(trace.output?.skippedByTransport ?? {}) },
      reason: trace.output?.reason ?? '',
    },
    visible: { ...(trace.visible ?? {}) },
    interrupt: trace.interrupt === undefined ? null : trace.interrupt,
  };
}


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
  // The posture-component draw has its own seeded stream. Adding the layer must not shift the
  // existing posture/base draw sequence a recorded idle curve or a test already pins.
  const componentRandom = createSeededRandom(
    `${cfg.seed === undefined ? 'default' : String(cfg.seed)}:posture-component`,
  );
  const postureHoldMinMs = Math.max(1000, finite(cfg.postureHoldMinMs, DEFAULT_CONFIG.postureHoldMinMs));
  const postureHoldMaxMs = Math.max(postureHoldMinMs, finite(cfg.postureHoldMaxMs, DEFAULT_CONFIG.postureHoldMaxMs));
  // P-139 stage 4 (A): an explicitly configured window is authority; only an unconfigured runtime
  // picks the lively 4–8 s variant. This keeps a tuning profile / test deterministic.
  const postureHoldConfigured = Object.prototype.hasOwnProperty.call(supplied, 'postureHoldMinMs')
    || Object.prototype.hasOwnProperty.call(supplied, 'postureHoldMaxMs');
  const postureComponentMinMs = Math.max(
    POSTURE_COMPONENT_MIN_MS,
    Math.min(POSTURE_COMPONENT_MAX_MS, finite(cfg.postureComponentMinMs, POSTURE_COMPONENT_MIN_MS)),
  );
  const postureComponentMaxMs = Math.max(
    postureComponentMinMs,
    Math.min(POSTURE_COMPONENT_MAX_MS, finite(cfg.postureComponentMaxMs, POSTURE_COMPONENT_MAX_MS)),
  );
  const decisionIntervalMs = 1000 / Math.max(0.1, Math.min(8, finite(cfg.decisionHz, DEFAULT_CONFIG.decisionHz)));
  const motionFollow = Math.max(0.05, finite(cfg.motionFollow, MOTION_LIMITS.FOLLOW_PER_SECOND));
  const motionMaxVelocity = Math.max(0.001, finite(cfg.motionMaxVelocity, MOTION_LIMITS.MAX_VELOCITY));
  const motionMaxAcceleration = Math.max(0.001, finite(cfg.motionMaxAcceleration, MOTION_LIMITS.MAX_ACCELERATION));
  // P-139 stage 3: the persona dimensions and the variant stream are decided ONCE per runtime.
  // The variant seed follows `cfg.seed` (not the style) so two personas of the same runtime source
  // still draw the same replacement sequence; the dimension seed follows the persona version.
  const initialStyle = coerceAvatarStyle(cfg.style);
  const initialStyleVersion = String(cfg.styleVersion ?? '');
  const initialDerived = deriveAvatarStyleDimensions(initialStyle, { styleVersion: initialStyleVersion });
  const initialSplit = splitAvatarStyleDimensions(initialDerived);
  const initialDimensions = initialSplit.dimensions;
  const initialTraits = initialSplit.traits;
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
        /**
         * Phase 1 posture component: the independent slow pose the preset gestures ride on.
         * `axes` are posture-target offsets (same units as `target`); `semantic` is the bounded
         * 30°-unit value recorded at draw time. It is cleared by interrupt/relax and never copied
         * from a preset's last frame.
         */
        component: null,
        componentTransitions: 0,
        lastComponentTransition: null,
        componentHistory: [],
        /** Set by relax/interrupt so a cleared component cannot silently revive mid-transition. */
        componentPaused: false,
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
    /** P-139 stage 3: persona-derived expression dimensions (legacy three-field shape). */
    dimensions: initialDimensions,
    /**
     * P-139 stage 3: the full PLAN dimension set. `dimensions` stays a compatibility subset so
     * older consumers (and the stage-3 snapshot contract) keep their exact shape; every new
     * behaviour reads `traits` through `styleTraitEffects`.
     */
    traits: initialTraits,
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
    /**
     * Motion preset execution (presets/README.md). Selection lives in the same low-frequency
     * controller as the idle posture; the active trajectories below are folded into the ONE 30 Hz
     * pose through `presetFrame()`, never through the four legacy intents.
     */
    presets: {
      enabled: supplied.presetExecution === true,
      capabilities: {
        channels: Array.isArray(supplied.presetChannels) ? [...supplied.presetChannels] : [],
        targetVerified: supplied.presetTargetVerified === true,
        directionVerified: supplied.presetDirectionVerified === true,
      },
      overrides: null,
      selector: null,
      selectorKey: '',
      active: [],
      seq: 0,
      /** Monotonic draw counter: `presetSelect#N` links one select to the action it may start. */
      selectSeq: 0,
      generation: 0,
      starts: 0,
      /** Answer-start takeovers that really displaced part (or all) of a pre-answer action. */
      takeovers: 0,
      holds: 0,
      selected: 0,
      dropped: 0,
      nextDecisionAt: null,
      /**
       * D: timestamp of the last REAL semantic start (`context.event !== 'idle'`). The idle
       * boundary reads it as a separate quiet-window clock; it never shares `nextDecisionAt`.
       */
      lastSemanticAt: null,
      lastSelection: null,
      lastTrace: null,
      /**
       * Read-only observability for "did the idle preset really run, and what filtered it out".
       * Decisions/skips/last* are ALWAYS maintained; `enabled` only silences the debug EVENTS.
       * `gate` remembers the last blocking episode so a 30 Hz tick reports it once, not 30×/s.
       */
      debug: {
        enabled: cfg.presetDebugEvents !== false,
        decisions: 0,
        skips: 0,
        lastPresetId: null,
        lastEvent: '',
        lastAt: null,
        gate: '',
        lastEmitAt: Object.create(null),
        /** Lightweight rollup of the LAST action only (no history): commits merged by actionId. */
        byAction: { lastActionId: null, lastCommitCount: 0, lastEvent: '' },
      },
      recent: [],
      history: [],
      recentFamilies: [],
      recentActions: [],
      /** Recipe ids of the same recent starts (bounded); recipe-level anti-repeat memory. */
      recentRecipes: [],
      /** Observability only: preset actions that contain a blink operation (never a second layer). */
      blinkStarts: 0,
      lastSign: Object.create(null),
      random: createSeededRandom(`preset:${cfg.seed === undefined ? 'default' : String(cfg.seed)}`),
      /**
       * Sender evidence counters across the whole controller life. Five phases, separate by
       * construction: a prepared frame is not a sent one, a sent one is not an acknowledged one,
       * and a stale/failed result is never counted as committed.
       */
      transport: {
        prepared: 0,
        attempted: 0,
        committed: 0,
        failed: 0,
        stale: 0,
        lastAt: null,
        lastError: '',
        lastErrorCode: '',
        lastStaleReason: '',
      },
    },
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

  /** The one dimension → motion projection for this persona (never intent selection). */
  function traitEffects() {
    return styleTraitEffects(state.traits);
  }

  /**
   * The ONE idle gain chain (idleSwayScale × postureReach × persona amplitude, or a per-channel
   * override). `advanceGenerators` and the posture-component target both read it, so a component
   * can never invent a second amplitude convention.
   */
  function idleChannelSway(channel) {
    const eff = state.effective ?? state.style;
    const idleSwayScale = Math.max(0, finite(cfg.idleSwayScale, DEFAULT_CONFIG.idleSwayScale));
    if (state.style.channels[channel]?.amplitude !== undefined) {
      return idleSwayScale * styleChannelAmplitude(eff, channel);
    }
    const personaAmplitude = Math.max(0.2, Math.min(1.5, finite(state.style.amplitude, 1)));
    const postureReach = Math.max(0, finite(cfg.postureReach, DEFAULT_CONFIG.postureReach));
    return idleSwayScale * postureReach * styleChannelAmplitude(eff, channel) * personaAmplitude;
  }

  /** Semantic head units produced by ONE pose unit of `channel` under the current persona. */
  function headSemanticGain(channel) {
    const sway = idleChannelSway(channel);
    const base = channel === 'headZ' ? 0.075 : channel === 'headY' ? 0.09 * 0.7 : 0.09;
    return Math.max(0, base * sway);
  }

  /** Re-derive both views from the current baseline style + version. */
  function applyDerivedDimensions() {
    const split = splitAvatarStyleDimensions(
      deriveAvatarStyleDimensions(state.style, { styleVersion: state.styleVersion }),
    );
    state.dimensions = split.dimensions;
    state.traits = split.traits;
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
    const effects = traitEffects();
    // Composure/softness stretch the stay inside the SAME allocation band; the band itself is the
    // stage-4 A allocation, so this never turns a lively persona into a 20 s statue.
    const stay = Math.max(0.8, Math.min(1.5, (1 / tempo) * effects.hold));
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
   * Fold one component's axis offsets into a raw posture goal. Components never replace the idle
   * draw or the preset layer: they are a bounded head offset inside the ONE `posture.target`.
   */
  function targetWithComponent(base, component = null) {
    const next = {};
    for (const axis of MOTION_AXES) {
      const offset = component?.axes?.[axis] ?? 0;
      next[axis] = clampMotion(finite(base?.[axis], 0) + offset, 1);
    }
    return next;
  }

  /** One component draw: shape × semantic amplitude, converted through the live head gain. */
  function drawPostureComponent(now) {
    const pool = POSTURE_COMPONENTS;
    const current = state.motion.posture.component;
    let index = Math.floor(componentRandom() * pool.length) % pool.length;
    if (current !== null && pool.length > 1 && pool[index].id === current.id) {
      // A back-to-back repeat is not a new component hold: move to a different shape.
      index = (index + 1 + Math.floor(componentRandom() * (pool.length - 1))) % pool.length;
    }
    const spec = pool[index];
    const amplitude = POSTURE_COMPONENT_MIN_AMPLITUDE
      + (POSTURE_COMPONENT_MAX_AMPLITUDE - POSTURE_COMPONENT_MIN_AMPLITUDE) * componentRandom();
    const drawMs = postureComponentMinMs
      + (postureComponentMaxMs - postureComponentMinMs) * componentRandom();
    // A persona tempo/composure may stretch or shrink the hold, but the 10–20 s band is the
    // contract: a slow persona never turns a component into a statue, a lively one never flickers.
    const influenced = drawMs * Math.max(0.8, Math.min(1.2, (1 / postureTempo()) * traitEffects().hold));
    const holdMs = Math.max(postureComponentMinMs, Math.min(postureComponentMaxMs, influenced));
    const axes = {};
    const semantic = {};
    for (const channel of POSTURE_COMPONENT_CHANNELS) {
      const gain = headSemanticGain(channel);
      const shape = finite(spec[channel], 0);
      const axis = gain > 1e-9 ? (shape * amplitude) / gain : 0;
      axes[channel] = clampMotion(axis, 1);
      // Record the semantic target AFTER the clamp as well: a clamped axis must not be reported as
      // an amplitude it never reaches.
      semantic[channel] = axes[channel] * gain;
    }
    return {
      id: spec.id,
      label: spec.label,
      startedAt: now,
      holdUntil: now + holdMs,
      durationMs: holdMs,
      amplitude,
      channels: [...POSTURE_COMPONENT_CHANNELS],
      axes,
      semantic,
      /** Filled every output frame by advanceGenerators (target/mixed/pose evidence). */
      observed: null,
    };
  }

  function recordPostureComponent(component) {
    const history = state.motion.posture.componentHistory;
    history.push({
      id: component.id,
      label: component.label,
      startedAt: component.startedAt,
      durationMs: component.durationMs,
      amplitude: component.amplitude,
    });
    while (history.length > 8) history.shift();
  }

  /** Select and install one component. `initial` only seeds the goal; every later swap is planned. */
  function installPostureComponent(now, { initial = false } = {}) {
    const motion = state.motion;
    const component = drawPostureComponent(now);
    motion.posture.component = component;
    motion.posture.componentPaused = false;
    recordPostureComponent(component);
    const next = targetWithComponent(motion.posture.base, component);
    if (initial) motion.posture.target = { ...next };
    else startPostureTransition(next, now, { kind: 'component' });
    return component;
  }

  /**
   * The planned-transition window for one cause (B / item 4): an idle re-draw keeps 1.2–1.8 s, a
   * short response action lands in 0.8–1.2 s, a conversation-end relax decays over 2–4 s. A
   * component swap uses the same idle window; it is a slow posture decision, never a new writer.
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
    else if (kind === 'component') motion.posture.componentTransitions += 1;
    else motion.posture.transitions += 1;
    if (axes.length === 0) {
      motion.transition = null;
      return null;
    }
    const window = transitionWindow(kind);
    // Composure lengthens the planned transition, liveliness shortens it; the window of the
    // original CAUSE still clamps the result, so the stage-1/2 continuity bounds are unchanged.
    const transitionScale = traitEffects().transition;
    const planned = durationMs === null
      ? (finite(cfg.postureTransitionMs, POSTURE_TRANSITION.BASE_MS) * transitionScale) / postureTempo()
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
    const next = targetWithComponent(motion.posture.base);
    for (const [axis, value] of Object.entries(delta)) {
      next[axis] = clampMotion(finite(next[axis], 0) + value, 1);
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
    const component = motion.posture.component;
    const base = {};
    const target = {};
    for (const axis of MOTION_AXES) {
      // The observed axis already contains the component. Store the RAW base (observed − component)
      // so the component is not applied twice when the next target is assembled.
      const observed = finite(motion.axes[axis].current, 0) + (motionRandom() * 2 - 1) * 0.02;
      const offset = component?.axes?.[axis] ?? 0;
      base[axis] = clampMotion(observed - offset, 1);
      target[axis] = clampMotion(base[axis] + offset, 1);
    }
    motion.posture.base = base;
    motion.posture.target = target;
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
      motion.posture.base = { ...initial };
      // The first component is seeded into the same goal; it is not a transition.
      installPostureComponent(now, { initial: true });
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
    // A conversation-end relax owns the pose until its planned transition ends: a component swap
    // must not overwrite that decay (the next normal move resumes the component layer).
    if (motion.transition?.kind === 'relax') return;
    // Never overwrite a planned transition mid-flight: the from-position is continuous but the
    // velocity would step, and a component swap landing on top of an idle/short move is exactly
    // the "no jump when actions are triggered back-to-back" case. The next 1 Hz gate retries.
    if (motion.transition !== null) return;
    // Component lifetime is checked on the SAME 1 Hz decision gate, BEFORE the posture-hold gate:
    // a 60 s posture hold must not turn a 10–20 s component into a statue. `componentPaused` is
    // set by relax/interrupt so a cleared component cannot silently revive mid-decay.
    if (motion.posture.componentPaused !== true) {
      const component = motion.posture.component;
      if (component === null || now >= component.holdUntil) {
        motion.postureDecisions += 1;
        motion.lastDecisionAt = now;
        motion.posture.lastDecision = 'component';
        installPostureComponent(now);
        return;
      }
    }
    if (now < motion.holdUntil) return;
    motion.postureDecisions += 1;
    motion.lastDecisionAt = now;
    const listening = state.status === 'listening' || state.status === 'thinking';
    const configuredHold = clamp01(finite(cfg.postureHoldChance, DEFAULT_CONFIG.postureHoldChance));
    // No artificial hold floor: the old `max(hold, .55)` combined with a large still chance made
    // the move branch unreachable. Listening stays quiet because hold + still are high, not because
    // a legal move is impossible.
    const holdChance = configuredHold;
    const rawStill = listening
      ? clamp01(finite(cfg.postureListenStillChance, DEFAULT_CONFIG.postureListenStillChance))
      : clamp01(finite(cfg.postureStillChance, DEFAULT_CONFIG.postureStillChance));
    // Keep a small legal move branch even with a maximal still setting (listening/thinking only):
    // standing still is still the likely outcome, but a long state is not structurally frozen.
    const stillChance = listening ? Math.min(rawStill, Math.max(0, 0.9 - holdChance)) : rawStill;
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
    // A move is the one place the component layer resumes after relax/interrupt.
    if (motion.posture.componentPaused === true || motion.posture.component === null) {
      motion.posture.component = drawPostureComponent(now);
      recordPostureComponent(motion.posture.component);
      motion.posture.componentPaused = false;
    }
    const next = drawPostureTarget({ listening });
    motion.posture.base = { ...next };
    rollPostureHold(now);
    startPostureTransition(targetWithComponent(next), now);
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
      const completed = {
        kind: transition.kind ?? 'idle',
        startedAt: transition.startedAt,
        durationMs: transition.durationMs,
        endedAt: now,
        actualMs: now - transition.startedAt,
        maxVelocity: transition.maxVelocity,
        maxAcceleration: transition.maxAcceleration,
        axes: [...transition.axes],
      };
      // A component swap is its own cause and must not masquerade as an idle re-draw: the public
      // `lastTransition` stays the idle/short/relax record existing consumers already read.
      if (completed.kind === 'component') motion.posture.lastComponentTransition = completed;
      else motion.posture.lastTransition = completed;
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
    // A relax clears the component: the explicit decay owns the pose until it ends, and a cleared
    // component is not revived behind the decay. A later normal move may select a fresh one.
    motion.posture.component = null;
    motion.posture.componentPaused = true;
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
  // them without waiting for a style refresh. The legacy event keeps its exact shape; the new
  // `traits` event carries the full PLAN dimension set.
  recordEvent('avatar.style.dimensions', { ...state.dimensions });
  recordEvent('avatar.style.traits', { ...state.traits });

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
    // With preset execution enabled, the discrete idle pool is replaced by the preset selection
    // boundary. The legacy action queue must stay empty, otherwise two schedulers would write.
    if (state.presets.enabled === true) {
      state.idleAction.accMs = 0;
      return;
    }
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
      /** Selection-only classification: passed through verbatim, never scaled by status/relax. */
      expression: base.expression === null || base.expression === undefined
        ? null : { ...base.expression },
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
    applyDerivedDimensions();
    recordEvent('avatar.style.set', {
      styleVersion: state.styleVersion,
      changed: normalized.changed,
      ignored: normalized.ignored,
      invalid: normalized.invalid,
    });
    // Dimensions are a pure projection of the new style: re-derive and publish them in the same
    // transition, so a listener never sees a style newer than its dimensions. The legacy event
    // and the full trait event are both current before this call returns.
    recordEvent('avatar.style.dimensions', { ...state.dimensions });
    recordEvent('avatar.style.traits', { ...state.traits });
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

  // ---- motion preset execution (selection + symbolic trajectory) -------------------------
  const presetNative = new Set(PRESET_NATIVE_CHANNELS);

  function normalizePresetOverridesValue(raw) {
    const source = raw !== null && typeof raw === 'object' ? raw : {};
    const strings = (value) => {
      const out = [];
      for (const entry of Array.isArray(value) ? value : []) {
        if (typeof entry === 'string' && entry.length > 0 && !out.includes(entry)) out.push(entry);
      }
      return out;
    };
    const priorities = (value) => {
      const out = {};
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return out;
      for (const [key, entry] of Object.entries(value)) {
        const number = Number(entry);
        if (!Number.isFinite(number)) continue;
        out[key] = Math.min(100, Math.max(0, Math.round(number)));
      }
      return out;
    };
    return {
      disabled: strings(source.disabled),
      disabledFamilies: strings(source.disabledFamilies),
      familyPriority: priorities(source.familyPriority),
      actionPriority: priorities(source.actionPriority),
    };
  }

  function presetOverridesValue() {
    if (state.presets.overrides === null) {
      state.presets.overrides = normalizePresetOverridesValue(
        supplied.presetOverrides ?? supplied.motionPresets ?? {},
      );
    }
    return state.presets.overrides;
  }

  /** Replace the user override set (shape matches `<root>/data/motion-presets.json`). */
  function setPresetOverrides(raw) {
    state.presets.overrides = normalizePresetOverridesValue(raw);
    state.presets.selector = null;
    state.presets.selectorKey = '';
    recordEvent('avatar.preset.overrides', {
      disabled: state.presets.overrides.disabled.length,
      disabledFamilies: state.presets.overrides.disabledFamilies.length,
    });
    return { ok: true, overrides: JSON.parse(JSON.stringify(state.presets.overrides)) };
  }

  /** Verified channels the preset executor may drive: body/breath stay VTS-native. */
  function presetCapabilityChannels() {
    const raw = Array.isArray(state.presets.capabilities.channels)
      ? state.presets.capabilities.channels : [];
    return [...new Set(raw.filter((channel) => !presetNative.has(channel)))];
  }

  /** Host reports the verified channel set and the two target/direction proofs. */
  function setPresetCapabilities({ channels = null, targetVerified = undefined, directionVerified = undefined } = {}) {
    if (Array.isArray(channels)) state.presets.capabilities.channels = [...new Set(channels)];
    if (targetVerified !== undefined) state.presets.capabilities.targetVerified = targetVerified === true;
    if (directionVerified !== undefined) state.presets.capabilities.directionVerified = directionVerified === true;
    return { ok: true, capabilities: { ...state.presets.capabilities, channels: [...state.presets.capabilities.channels] } };
  }

  function setPresetExecution(enabled, { at = undefined } = {}) {
    state.presets.enabled = enabled === true;
    if (state.presets.enabled !== true) {
      clearPresets('preset-disabled', { fadeMs: 0, at });
      state.presets.nextDecisionAt = null;
    } else {
      // Enabling the preset executor replaces the discrete idle pool. Clear anything already
      // queued by the old pool: an action sampled BEFORE the switch must never start afterwards.
      state.idleAction.queue.length = 0;
      state.idleAction.accMs = 0;
      state.presets.nextDecisionAt = (Number.isFinite(at) ? at : clockNow())
        + PRESET_EXECUTION.DECISION_MIN_MS;
    }
    recordEvent('avatar.preset.enabled', { enabled: state.presets.enabled });
    return { ok: true, enabled: state.presets.enabled };
  }

  function presetSelector() {
    const overrides = presetOverridesValue();
    const key = JSON.stringify(overrides);
    if (state.presets.selector === null || state.presets.selectorKey !== key) {
      state.presets.selector = createPresetSelector({ overrides });
      state.presets.selectorKey = key;
    }
    return state.presets.selector;
  }

  /**
   * Soft persona tags for the selector: tiltChance / gazeHabit have real, named consumers, and
   * the optional `expression` tendencies add a SELECTION-only bias. Tags merge by `max`, so a
   * tendency can raise a tag but never overwrite an existing tag or a higher user priority, and
   * it never changes amplitude / tempo / the numeric dimensions.
   */
  function presetPersona() {
    const style = state.effective ?? state.style;
    const tilt = clamp01(finite(style?.tiltChance, DEFAULT_AVATAR_STYLE.tiltChance) / 0.5);
    const gazeHabit = ['steady', 'wandering', 'direct'].includes(style?.gazeHabit)
      ? style.gazeHabit : 'steady';
    const styles = {};
    const add = (id, weight) => { styles[id] = Math.max(styles[id] ?? 0, clamp01(weight)); };
    if (tilt > 0.45) {
      add('playful', tilt);
      add('curious', tilt * 0.85);
      add('gentle', tilt * 0.6);
    } else if (tilt < 0.3) {
      add('reserved', 1 - tilt * 2);
      add('composed', (1 - tilt * 2) * 0.9);
      add('cool', (1 - tilt * 2) * 0.7);
    }
    if (gazeHabit === 'wandering') {
      add('dreamy', 0.9);
      add('curious', 0.75);
      add('shy', 0.6);
    } else if (gazeHabit === 'direct') {
      add('warm', 0.85);
      add('earnest', 0.85);
      add('confident', 0.7);
      add('composed', 0.6);
    }
    // Concrete-expression tendencies: soft style tags only (0.7×), max-merged with the tags above.
    for (const [id, weight] of Object.entries(avatarExpressionStyleTags(style))) {
      add(id, weight);
    }
    return {
      styles,
      /** Full PLAN dimension set (the legacy three plus expression/attention/composure/texture). */
      dimensions: state.traits,
      tiltChance: tilt,
      gazeHabit,
    };
  }

  /**
   * Style → recipe priority. `tiltChance` reweights the head-roll (偏头) recipes and
   * `gazeHabit` reweights look-at / look-back / look-away recipes; user priorities always win.
   */
  function presetSelectionOverrides() {
    const base = presetOverridesValue();
    const actionPriority = { ...base.actionPriority };
    const selector = presetSelector();
    const tilt = clamp01(finite((state.effective ?? state.style)?.tiltChance, DEFAULT_AVATAR_STYLE.tiltChance) / 0.5);
    const gazeHabit = (state.effective ?? state.style)?.gazeHabit ?? 'steady';
    // P-139 stage 3: "注意方式" directly reweights attention/head-turn recipes. `attentionChance`
    // is 0..1 and already derived from the persona (gaze habit × tilt × liveliness), so this is
    // not a persona-name lookup. It is a priority (soft) — never a hard enable/disable.
    const attentionShift = (traitEffects().attentionChance - 0.5) * 2;
    const gazePriority = gazeHabit === 'direct'
      ? { target: 82 + 8 * attentionShift, center: 74, away: 24 - 10 * attentionShift }
      : gazeHabit === 'wandering'
        ? { target: 24 + 10 * attentionShift, center: 30, away: 82 + 8 * attentionShift }
        : {
            target: 55 + 8 * attentionShift,
            center: 55,
            away: 55 + 14 * attentionShift,
          };
    const tiltPriority = Math.round(50 + (tilt - 0.5) * 70 + attentionShift * 18);
    const untouched = (preset) => {
      for (const key of [preset.id, preset.recipeId]) {
        if (Object.prototype.hasOwnProperty.call(base.actionPriority, key)) return false;
      }
      return true;
    };
    for (const preset of selector.index.presets) {
      if (!untouched(preset)) continue;
      if (hasTiltOperation(preset)) actionPriority[preset.recipeId] = tiltPriority;
      const gazeKind = gazeKindOf(preset);
      if (gazeKind !== null) actionPriority[preset.recipeId] = gazePriority[gazeKind];
    }
    return {
      disabled: [...base.disabled],
      disabledFamilies: [...base.disabledFamilies],
      familyPriority: { ...base.familyPriority },
      actionPriority,
    };
  }

  /**
   * B: per-axis actual − natural posture offset, in the same normalised pose units the executor
   * uses. Missing pose/baseline data yields `null` (UNKNOWN) — never a fabricated 0 that would look
   * like "near baseline". Only axes that exist on both sides are included.
   */
  function presetPostureOffset() {
    const actual = state.lastPose;
    const natural = state.idle;
    if (actual === null || actual === undefined || natural === null || natural === undefined) return null;
    const offset = {};
    let count = 0;
    for (const channel of PRESET_POSTURE_OFFSET_CHANNELS) {
      if (!Number.isFinite(actual[channel]) || !Number.isFinite(natural[channel])) continue;
      offset[channel] = clampSigned(actual[channel] - natural[channel]);
      count += 1;
    }
    return count > 0 ? offset : null;
  }

  /**
   * "Legal posture hold" for the selector: an explicit choose-not-to-move decision. An ordinary
   * hold window is not enough to block a settle request; a caller can always override with
   * `postureHeld` / `recenterRequested` in its own select context.
   */
  function presetPostureHeld() {
    return state.motion?.posture?.lastDecision === 'still';
  }

  /** Normalise one selection request into the selector's context shape. */
  function presetContext(raw = {}) {
    const source = raw !== null && typeof raw === 'object' ? raw : {};
    const stateName = MOTION_STATUSES.includes(source.state) ? source.state : state.status;
    const event = typeof source.event === 'string' && source.event.length > 0
      ? source.event
      : (PRESET_EVENT_BY_STATE[stateName] ?? 'idle');
    const rawChannels = Array.isArray(source.verifiedChannels)
      ? source.verifiedChannels
      : presetCapabilityChannels();
    const nativeDropped = rawChannels.filter((channel) => presetNative.has(channel));
    const verifiedChannels = [...new Set(rawChannels.filter((channel) => !presetNative.has(channel)))];
    const attention = state.motion.attention;
    const targetVerified = source.targetVerified !== undefined
      ? source.targetVerified === true
      : (state.presets.capabilities.targetVerified === true
        || (attention.verified === true && attention.mode === 'user'));
    const directionVerified = source.directionVerified !== undefined
      ? source.directionVerified === true
      : state.presets.capabilities.directionVerified === true;
    return {
      state: stateName,
      event,
      intent: source.intent,
      privacy: source.privacy === true,
      disposed: source.disposed === true,
      verifiedChannels,
      nativeDropped,
      targetVerified,
      directionVerified,
      family: source.family,
      style: source.style,
      recipe: source.recipe,
      persona: source.persona ?? presetPersona(),
      /** B: per-axis actual − natural pose; `null` when no valid pose/baseline exists yet. */
      postureOffset: presetPostureOffset(),
      postureHeld: source.postureHeld !== undefined ? source.postureHeld === true : presetPostureHeld(),
      /** Explicit "return to baseline" request bypasses the idle settle gate. */
      recenterRequested: source.recenterRequested === true,
      recent: {
        families: state.presets.recentFamilies,
        actions: state.presets.recentActions,
        recipes: state.presets.recentRecipes,
      },
      history: state.presets.history,
      now: Number.isFinite(source.now) ? source.now : (state.lastAt ?? clockNow()),
      frequencyWindowMs: source.frequencyWindowMs,
      seed: source.seed,
      rand: source.rand,
      overrides: presetSelectionOverrides(),
    };
  }

  function holdSelection(reasons) {
    return {
      kind: 'hold',
      presetId: null,
      family: null,
      recipe: null,
      variant: null,
      score: 0,
      probability: 0,
      reasons: ['hold', ...reasons],
      droppedChannels: [],
      timing: null,
      operations: [],
      requires: [],
      effectiveRequires: [],
    };
  }

  // ---- preset decision observability (read-only; it never selects, executes or writes) -----
  /**
   * Record ONE preset decision for diagnosis. The projection counters and `last*` values are
   * updated for every decision, so they stay truthful even with `config.presetDebugEvents:false`;
   * the debug EVENT itself (`state.events` + the host log sink) is throttled to one per class per
   * second. Commits keep their own per-action trail (first + last, see `noteCommitEvent`).
   * Nothing here is read back by selection, the pose or the transport.
   */
  function notePresetDebugEvent(type, payload = {}, at = null) {
    const debug = state.presets.debug;
    const now = Number.isFinite(at) ? at : clockNow();
    debug.lastAt = now;
    if (type === 'avatar.preset.select') {
      debug.lastPresetId = payload.presetId ?? null;
      debug.lastEvent = payload.event ?? '';
    } else if (type === 'avatar.preset.skip') {
      debug.skips += 1;
      if (typeof payload.event === 'string' && payload.event.length > 0) debug.lastEvent = payload.event;
    } else if (type === 'avatar.preset.start') {
      // A new action begins: the rollup moves to it and its commit trail restarts at 0.
      // `debug.lastEvent`/`lastPresetId` keep their existing select/skip semantics.
      debug.byAction.lastActionId = payload.actionId ?? null;
      debug.byAction.lastCommitCount = 0;
      debug.byAction.lastEvent = typeof payload.event === 'string' ? payload.event : '';
    } else if (type === 'avatar.preset.commit') {
      debug.lastPresetId = payload.presetId ?? debug.lastPresetId;
      if (payload.actionId !== undefined) debug.byAction.lastActionId = payload.actionId;
      if (Number.isFinite(payload.commitCount)) debug.byAction.lastCommitCount = payload.commitCount;
      if (typeof payload.event === 'string') debug.byAction.lastEvent = payload.event;
    }
    if (debug.enabled !== true) return false;
    if (type === 'avatar.preset.commit') return noteCommitEvent(payload, now);
    const last = debug.lastEmitAt[type];
    // Select/skip keep the 1 s decision budget; a start opens the next action's commit trail.
    if (Number.isFinite(last) && now - last < PRESET_DEBUG_THROTTLE_MS) return false;
    debug.lastEmitAt[type] = now;
    writePresetDebugEvent(type, payload);
    return true;
  }

  /**
   * One action's commit trail: `{actionId, pending, timer, lastEmitAt}`. The first acknowledged
   * send is written at once, the middle ones are coalesced inside the 1 s window (the newest
   * replaces the older ones), and the trail's last one is written when the action changes or 1 s
   * after the last acknowledgement. Each commit payload is already the cumulative merge window of
   * its action, so first + last keep the evidence and drop the per-250 ms flood.
   */
  let commitTrail = null;

  /** Write one already-throttled debug event to the ring buffer and the host log sink. */
  function writePresetDebugEvent(type, payload) {
    recordEvent(type, payload);
    if (typeof cfg.debugEvent === 'function') {
      try {
        cfg.debugEvent(type, payload);
      } catch {
        // Diagnostics must never break a tick.
      }
    }
  }

  /** Write the newest acknowledged commit a throttled action left pending, if any. */
  function flushCommitTrail() {
    const trail = commitTrail;
    if (trail === null) return false;
    if (trail.timer !== null) {
      clearTimeout(trail.timer);
      trail.timer = null;
    }
    const pending = trail.pending;
    trail.pending = null;
    if (pending === null || state.presets.debug.enabled !== true) return false;
    trail.lastEmitAt = Number.isFinite(pending.lastAt) ? pending.lastAt : trail.lastEmitAt;
    state.presets.debug.lastEmitAt['avatar.preset.commit'] = trail.lastEmitAt;
    writePresetDebugEvent('avatar.preset.commit', pending);
    return true;
  }

  /** Apply the 1 s per-action commit throttle, keeping the first and last acknowledgement. */
  function noteCommitEvent(payload, now) {
    const actionId = payload.actionId ?? null;
    if (commitTrail === null || commitTrail.actionId !== actionId) {
      // A new action: the previous one's last acknowledgement must still arrive, then this first.
      flushCommitTrail();
      commitTrail = { actionId, pending: null, timer: null, lastEmitAt: now };
      state.presets.debug.lastEmitAt['avatar.preset.commit'] = now;
      writePresetDebugEvent('avatar.preset.commit', payload);
      return true;
    }
    if (commitTrail.pending === null && now - commitTrail.lastEmitAt >= PRESET_COMMIT_THROTTLE_MS) {
      // Sparse acknowledgements (>= 1 s apart) are written immediately, at most one per second.
      commitTrail.lastEmitAt = now;
      state.presets.debug.lastEmitAt['avatar.preset.commit'] = now;
      writePresetDebugEvent('avatar.preset.commit', payload);
      return true;
    }
    commitTrail.pending = payload;
    if (commitTrail.timer !== null) clearTimeout(commitTrail.timer);
    commitTrail.timer = setTimeout(() => {
      if (commitTrail !== null) commitTrail.timer = null;
      flushCommitTrail();
    }, PRESET_COMMIT_THROTTLE_MS);
    commitTrail.timer?.unref?.();
    return false;
  }

  /** Most specific `skip.reason` for a selection/executor hold (closed vocabulary, spec order). */
  function presetSkipReason(selection, context) {
    const reasons = Array.isArray(selection?.reasons) ? selection.reasons : [];
    const has = (name) => reasons.some((reason) => (
      reason === name || String(reason).startsWith(`${name}:`)
    ));
    const verified = Array.isArray(context?.verifiedChannels) ? context.verifiedChannels : null;
    if (verified !== null && verified.length === 0) return 'channel-unverified';
    if (has('invalid-channels') || has('channel-unverified') || has('no-executable-operations')
      || reasons.includes('native-owned')) {
      return 'channel-unverified';
    }
    if (has('no-candidates') || has('candidate-shortage')) return 'no-candidate';
    return 'hold';
  }

  /** One debug skip per blocking episode (the same gate is not repeated on every 30 Hz tick). */
  function notePresetGateSkip(reason, key, event, at) {
    const debug = state.presets.debug;
    if (debug.gate === key) return;
    debug.gate = key;
    notePresetDebugEvent('avatar.preset.skip', {
      reason, event, state: state.status, reasons: [], droppedChannels: [],
      /** No draw happened here, so neither identifier exists yet. */
      selectionId: null, actionId: null,
    }, at);
  }

  /**
   * Report a decision that never reached the selector (the host refused the boundary itself, e.g.
   * `busy`: one preset already owns the pose). Read-only; it selects, executes and writes nothing.
   */
  function notePresetSkip(reason, { event = '', reasons = null, droppedChannels = [], at = null } = {}) {
    const why = PRESET_SKIP_REASONS.includes(reason) ? reason : 'hold';
    notePresetDebugEvent('avatar.preset.skip', {
      reason: why,
      event: typeof event === 'string' ? event : '',
      state: state.status,
      reasons: Array.isArray(reasons) ? [...reasons] : [],
      droppedChannels: [...(Array.isArray(droppedChannels) ? droppedChannels : [])],
      /** The host refused the boundary before a draw: no selection and no action exist. */
      selectionId: null, actionId: null,
    }, at);
    return { ok: true, reason: why };
  }

  /**
   * Selection boundary. A missing target never degrades into a guessed gaze; the candidate is
   * excluded (the selector already hard-filters) and the trace records why the draw held.
   */
  function selectPreset(raw = {}) {
    const context = presetContext(raw);
    state.presets.selectSeq += 1;
    const selectionId = `presetSelect#${state.presets.selectSeq}`;
    let selection;
    try {
      selection = presetSelector().select(context);
    } catch (error) {
      selection = holdSelection([`selector-error:${String(error?.message ?? error)}`]);
    }
    const reasons = [...selection.reasons];
    reasons.push(`state:${context.state}`, `event:${context.event}`);
    if (context.nativeDropped.length > 0) {
      reasons.push(`native-owned:${[...new Set(context.nativeDropped)].join(',')}`);
    }
    if (context.targetVerified !== true) reasons.push('target-unverified');
    if (context.directionVerified !== true) reasons.push('direction-unverified');
    // An explicitly requested targeted recipe that held has a concrete reason, not a silent skip.
    if (selection.kind !== 'preset' && typeof context.recipe === 'string') {
      const explicitlyTargeted = presetSelector().index.presets.some((preset) => (
        preset.recipeId === context.recipe && preset.requiresTarget === true
      ));
      if (explicitlyTargeted && context.targetVerified !== true) reasons.push('requires-target');
      const explicitlyDirected = presetSelector().index.presets.some((preset) => (
        preset.recipeId === context.recipe && preset.requiresDirection === true
      ));
      if (explicitlyDirected && context.directionVerified !== true) reasons.push('requires-direction');
    }
    const normalized = {
      ...selection,
      /** Correlation id of THIS draw; `startPreset` copies it, then adds the action id. */
      selectionId,
      reasons: [...new Set(reasons)],
      /** Proof fields the trace can quote without re-reading the runtime. */
      targetVerified: context.targetVerified === true,
      directionVerified: context.directionVerified === true,
      verifiedChannels: [...context.verifiedChannels],
      context: {
        state: context.state,
        event: context.event,
        targetVerified: context.targetVerified === true,
        directionVerified: context.directionVerified === true,
        tiltChance: context.persona?.tiltChance ?? null,
        gazeHabit: context.persona?.gazeHabit ?? 'steady',
      },
    };
    if (normalized.kind === 'preset') {
      const chosen = presetSelector().index.byId.get(normalized.presetId);
      if (chosen !== undefined) {
        normalized.requiresTarget = chosen.requiresTarget === true;
        normalized.requiresDirection = chosen.requiresDirection === true;
        normalized.states = [...chosen.states];
        normalized.events = [...chosen.events];
        normalized.semantic = chosen.semantic;
      }
    }
    state.presets.lastSelection = {
      selectionId,
      kind: normalized.kind,
      presetId: normalized.presetId ?? null,
      family: normalized.family ?? null,
      recipe: normalized.recipe ?? null,
      variant: normalized.variant ?? null,
      actionVariant: normalized.actionVariant ?? null,
      actionVariantKey: normalized.actionVariantKey ?? null,
      reasons: [...normalized.reasons],
      droppedChannels: [...(normalized.droppedChannels ?? [])],
      targetVerified: normalized.targetVerified,
      directionVerified: normalized.directionVerified,
    };
    if (normalized.kind === 'preset') state.presets.selected += 1;
    else state.presets.holds += 1;
    // Observability only: the decision already happened above; this cannot feed back into it.
    state.presets.debug.decisions += 1;
    state.presets.debug.gate = '';
    if (normalized.kind === 'preset') {
      notePresetDebugEvent('avatar.preset.select', {
        selectionId,
        presetId: normalized.presetId,
        family: normalized.family ?? null,
        recipe: normalized.recipe ?? null,
        variant: normalized.variant ?? null,
        event: context.event,
        score: finite(normalized.score, 0),
        channels: [...(normalized.effectiveRequires ?? normalized.requires ?? [])],
      }, context.now);
    } else {
      notePresetDebugEvent('avatar.preset.skip', {
        reason: presetSkipReason(normalized, context),
        event: context.event,
        /** Payload-only diagnosis: the selector's own reasons plus the state/verified set. */
        state: context.state,
        verifiedChannels: [...(normalized.verifiedChannels ?? [])],
        reasons: [...normalized.reasons],
        droppedChannels: [...(normalized.droppedChannels ?? [])],
        /** The draw exists even when it held; no action was started for it. */
        selectionId, actionId: null,
      }, context.now);
    }
    return normalized;
  }

  function presetTraceBase(selection, at) {
    return {
      at,
      selection: {
        kind: selection.kind,
        presetId: selection.presetId ?? null,
        family: selection.family ?? null,
        recipe: selection.recipe ?? null,
        variant: selection.variant ?? null,
        actionVariant: selection.actionVariant ?? null,
        actionVariantKey: selection.actionVariantKey ?? null,
        probability: finite(selection.probability, 0),
        reasons: [...(selection.reasons ?? [])],
        operations: [...(selection.operations ?? [])],
        droppedChannels: [...(selection.droppedChannels ?? [])],
        effectiveRequires: [...(selection.effectiveRequires ?? [])],
        verifiedChannels: [...(selection.verifiedChannels ?? [])],
        targetVerified: selection.targetVerified === true,
        directionVerified: selection.directionVerified === true,
        requiresTarget: selection.requiresTarget === true,
        requiresDirection: selection.requiresDirection === true,
        context: { ...(selection.context ?? {}) },
      },
      output: {
        startedAt: null,
        endedAt: null,
        durationMs: 0,
        stages: [],
        channels: [],
        droppedChannels: [],
        samples: [],
        /** Controller-computed pose only; it is NEVER copied into `committed`. */
        computed: {},
        /** Rows this frame assembled for the preset: parameters, NOT evidence of a send. */
        prepared: {},
        preparedFrames: 0,
        /** Rows really handed to the transport; still no acknowledgement. */
        attempted: {},
        attemptedFrames: 0,
        /** Values the transport acknowledged with `ok:true`, plus the time of that acknowledgement. */
        committed: {},
        committedAt: {},
        /** Rejected/thrown sends (`ok:false` or an exception), never a commit. */
        failed: { count: 0, at: null, codes: {}, lastCode: '' },
        /** Results discarded because their connection generation or preset identity moved on. */
        stale: { count: 0, at: null, reasons: {}, lastReason: '' },
        /** Requested channels the sender refused, with its reason (e.g. `shared-input`). */
        skippedByTransport: {},
        peak: 0,
        reason: '',
      },
      visible: {
        verifiable: false,
        reason: 'render-not-observable',
        note: '插件只能证明提交到传输层的通道/参数；渲染像素与模型绑定结果不可验证。',
      },
      interrupt: null,
    };
  }

  function recordPresetHoldTrace(selection, at, reason = 'hold') {
    const trace = presetTraceBase(selection, at);
    trace.output.reason = `${reason}:${(selection.reasons ?? []).filter((entry) => entry !== 'hold').join('|') || 'no-candidates'}`;
    state.presets.lastTrace = clonePresetTrace(trace);
    state.presets.recent.push(clonePresetTrace(trace));
    while (state.presets.recent.length > PRESET_EXECUTION.TRACE_LIMIT) state.presets.recent.shift();
    recordEvent('avatar.preset.trace', {
      presetId: null,
      kind: 'hold',
      reason: trace.output.reason,
      at,
    });
    return trace;
  }

  function actualPresetPose(channel) {
    const last = state.lastPose?.[channel];
    if (Number.isFinite(last)) return last;
    return finite(state.motion?.axes?.[channel]?.current, 0);
  }

  function naturalPresetPose(channel) {
    return finite(state.idle?.[channel], 0);
  }

  /** Pick a direction from the CURRENT pose: never keep crowding the same limit. */
  function choosePresetSign(op, profile, channel) {
    if (profile.sign !== 0) return profile.sign;
    const random = state.presets.random;
    const actual = actualPresetPose(channel);
    const offset = actual - naturalPresetPose(channel);
    let sign;
    if (offset > 0.3) sign = -1;
    else if (offset < -0.3) sign = 1;
    else sign = random() < 0.5 ? -1 : 1;
    const last = state.presets.lastSign[channel];
    if (last !== undefined && last === sign && random() < 0.65) sign = -sign;
    state.presets.lastSign[channel] = sign;
    return sign;
  }

  /** One seeded asymmetric sway plan: which side first, when the crossing happens, how big the
   * second side is and how much of it the dwell keeps. Nothing here is shared with `shake`. */
  function planSway(random, sign) {
    const pick = (min, span) => min + span * clamp01(random());
    const first = sign >= 0 ? 1 : -1;
    return {
      first,
      second: -first,
      turnAt: pick(PRESET_SWAY.TURN_AT_MIN, PRESET_SWAY.TURN_AT_SPAN),
      crossAt: pick(PRESET_SWAY.CROSS_AT_MIN, PRESET_SWAY.CROSS_AT_SPAN),
      secondScale: pick(PRESET_SWAY.SECOND_SCALE_MIN, PRESET_SWAY.SECOND_SCALE_SPAN),
      holdLevel: pick(PRESET_SWAY.HOLD_LEVEL_MIN, PRESET_SWAY.HOLD_LEVEL_SPAN),
      holdScale: pick(PRESET_SWAY.HOLD_SCALE_MIN, PRESET_SWAY.HOLD_SCALE_SPAN),
    };
  }

  /** The dwell's signed level: the second lean, reduced but never forced back to zero. */
  function swayHoldWave(plan) {
    return plan.second * plan.secondScale * plan.holdLevel;
  }

  /**
   * Active-phase shape: zero → first lean (full) → through the middle → second lean (asymmetric)
   * → settle into the dwell level. Every segment is a smootherstep, so the pose never jerks.
   */
  function swayActiveWave(p, plan) {
    const u = clamp01(p);
    const secondPeak = plan.second * plan.secondScale;
    if (u <= 0) return 0;
    if (u < plan.turnAt) return plan.first * smootherstep(u / Math.max(1e-6, plan.turnAt));
    if (u < plan.crossAt) {
      const cross = smootherstep((u - plan.turnAt) / Math.max(1e-6, plan.crossAt - plan.turnAt));
      return plan.first * (1 - cross) + secondPeak * cross;
    }
    const settle = smootherstep((u - plan.crossAt) / Math.max(1e-6, 1 - plan.crossAt));
    return secondPeak * (1 - settle) + swayHoldWave(plan) * settle;
  }

  function presetOperationChannels(op, selection, context) {
    const required = Array.isArray(selection.effectiveRequires) && selection.effectiveRequires.length > 0
      ? selection.effectiveRequires
      : (Array.isArray(selection.requires) ? selection.requires : []);
    const optional = PRESET_OPERATION_OPTIONAL_CHANNELS[op] ?? [];
    const verified = new Set(Array.isArray(context?.verifiedChannels) ? context.verifiedChannels : []);
    const operationChannels = PRESET_OPERATION_CHANNEL_ADDITIONS[op]
      ?? PRESET_OPERATION_CHANNELS[op] ?? [];
    return operationChannels.filter((channel) => (
      !presetNative.has(channel)
      && (required.includes(channel) || optional.includes(channel))
      && (verified.size === 0 || verified.has(channel))
    ));
  }

  function buildPresetTrajectory(selection, context, now) {
    const timing = selection.timing ?? {};
    const style = state.effective ?? state.style;
    const dims = state.dimensions ?? {};
    const effects = traitEffects();
    const liveliness = clamp01(finite(dims.liveliness, 0));
    const restraint = clamp01(finite(dims.restraint, 0));
    const tilt = clamp01(finite(context?.persona?.tiltChance, finite(style?.tiltChance, 0.15) / 0.5));
    const gazeHabit = context?.persona?.gazeHabit ?? style?.gazeHabit ?? 'steady';
    // The selector picked the replacement delivery for THIS recipe; the executor only applies its
    // amount/duration/hold multipliers. A custom catalog without variants defaults to 1.
    const actionVariant = selection.actionVariantProfile ?? null;
    const variantAmount = Math.max(0.5, Math.min(1.5, finite(actionVariant?.amount, 1)));
    const variantDuration = Math.max(0.5, Math.min(1.5, finite(actionVariant?.duration, 1)));
    const variantHold = Math.max(0.5, Math.min(1.5, finite(actionVariant?.hold, 1)));
    const tempo = Math.max(0.2, finite(style?.tempo, 1) * effects.tempo);
    const amplitudeScale = (STYLE_DIMENSION_APPLICATION.amplitudeBase
      + STYLE_DIMENSION_APPLICATION.amplitudeSpan * liveliness)
      * (1 - STYLE_DIMENSION_APPLICATION.restraintCap * restraint)
      * effects.amplitude * variantAmount;
    const unstable = timing.release === 'unhurried';
    const holdScale = (timing.hold === 'lingering' ? PRESET_EXECUTION.HOLD_LINGER_MS : PRESET_EXECUTION.HOLD_MIN_MS)
      * effects.hold * variantHold;
    const separated = timing.pacing === 'separated';
    const stages = [];
    const droppedOps = [];
    const nativeOps = [];
    let cursor = timing.onset === 'pause-before' ? PRESET_EXECUTION.PAUSE_BEFORE_MS / tempo : 0;
    for (const op of Array.isArray(selection.operations) ? selection.operations : []) {
      const profile = PRESET_OPERATION_PROFILE[op];
      if (profile === undefined) { droppedOps.push(op); continue; }
      if (profile.kind === 'native') { nativeOps.push(op); continue; }
      const channels = presetOperationChannels(op, selection, context);
      if (channels.length === 0) { droppedOps.push(op); continue; }
      const channelAmounts = {};
      const cancelOffsets = {};
      const targetOffsets = {};
      const channel = channels[0];
      const sign = choosePresetSign(op, profile, channel === 'eyeOpenL' ? 'headY' : channel);
      // Experimental global gain: gestures only, never the gaze operations (eye movement is tuned
      // separately) and never another layer's amount.
      const gestureGain = profile.gaze === undefined
        ? Math.max(0, finite(cfg.presetGestureGain, PRESET_GESTURE_GAIN))
        : 1;
      // Texture widens the existing seeded jitter band; it never adds another random source.
      const jitterBand = 0.12 * (0.5 + effects.variantSpread);
      const jitter = 0.94 + state.presets.random() * jitterBand;
      const durationJitter = 0.94 + state.presets.random() * jitterBand;
      const activeMs = Math.max(80, (PRESET_EXECUTION[profile.active] ?? PRESET_EXECUTION.BROW_ACTIVE_MS)
        / tempo * durationJitter * variantDuration);
      const prepareMs = Math.max(60, PRESET_EXECUTION.PREPARE_MS / tempo);
      let holdMs = holdScale / tempo;
      let exitMs = (unstable ? PRESET_EXECUTION.UNHURRIED_EXIT_MS : PRESET_EXECUTION.EXIT_MS)
        / tempo * variantDuration;
      // The sway owns an asymmetric lean/dwell plan; its dwell length is part of that plan, so two
      // draws differ in both direction and how long the second side is held.
      const swayPlan = profile.kind === 'sway' ? planSway(state.presets.random, sign) : null;
      if (swayPlan !== null) holdMs *= swayPlan.holdScale;
      if (profile.tilt === true) {
        holdMs *= 0.8 + 0.6 * tilt;
        if (tilt > 0.4) exitMs *= 1.12;
      }
      if (profile.gaze === 'target') holdMs *= gazeHabit === 'direct' ? 1.35 : gazeHabit === 'wandering' ? 0.65 : 1;
      else if (profile.gaze === 'away') {
        holdMs *= gazeHabit === 'wandering' ? 1.6 : gazeHabit === 'direct' ? 0.55 : 1;
        exitMs *= gazeHabit === 'wandering' ? 1.25 : 1;
      } else if (profile.gaze === 'center') {
        exitMs *= gazeHabit === 'direct' ? 0.8 : 1;
      }
      for (const target of channels) {
        const global = Math.max(1e-6, finite(style?.amplitude, DEFAULT_AVATAR_STYLE.amplitude));
        const channelScale = styleChannelAmplitude(style, target) / global;
        // A sway's nominal amount is its headZ primary; headX only follows at a small ratio. When
        // the model has no verified headZ, the yaw-only fallback is deliberately smaller than the
        // nominal so a missing roll never turns into a full-strength head turn.
        const swayRatio = profile.kind !== 'sway' || target !== 'headX'
          ? 1
          : (channels.includes('headZ') ? PRESET_SWAY.HEAD_X_RATIO : PRESET_SWAY.YAW_ONLY_SCALE);
        let amount = profile.amount * swayRatio * gestureGain
          * global * amplitudeScale * channelScale * jitter;
        if (profile.tilt === true) amount *= 0.75 + 0.55 * tilt;
        if (profile.kind === 'center') {
          // A centre's offset is LIVE (state.idle − the current pose), evaluated on every output
          // frame: freezing it at build time made a later start overshoot when another trajectory
          // kept moving. `cancelOffsets` stays as an empty compatibility map.
        } else if (profile.kind === 'target') {
          const attention = state.motion.attention;
          const targetValue = attention.mode === 'user' && attention.verified === true
            ? (target === 'gazeX' ? attention.target.x : attention.target.y)
            : naturalPresetPose(target);
          targetOffsets[target] = targetValue - naturalPresetPose(target);
        } else if (profile.kind === 'blink' || profile.kind === 'double-blink') {
          // Eye closure is an absolute eye-open value, not an additive pose offset.
          channelAmounts[target] = clamp01(profile.amount);
        } else if (profile.browOne === true) {
          const hasLeft = channels.includes('browL');
          const hasRight = channels.includes('browR');
          // A one-sided brow is one-sided by definition: when only one side is verified, THAT side
          // is the raised one (never the lowered side of an unavailable pair).
          const raised = hasLeft && hasRight ? (sign >= 0 ? 'browL' : 'browR') : (hasLeft ? 'browL' : 'browR');
          const lowered = raised === 'browL' ? 'browR' : 'browL';
          channelAmounts[target] = target === raised ? amount : target === lowered ? -0.3 * amount : amount;
        } else {
          const actual = actualPresetPose(target);
          const room = sign > 0
            ? 1 - actual - PRESET_EXECUTION.HEADROOM_MARGIN
            : 1 + actual - PRESET_EXECUTION.HEADROOM_MARGIN;
          const headroom = Math.max(0.12, Math.min(1, room));
          channelAmounts[target] = amount * sign * headroom;
        }
      }
      // The sway's planned roll is kept under the shared head budget BEFORE it reaches the frame.
      // Scaling both channels together preserves the headX:headZ ratio; the final 14° clamp stays
      // in place as the hard guarantee.
      if (profile.kind === 'sway' && Number.isFinite(channelAmounts.headZ)) {
        const peak = Math.abs(channelAmounts.headZ);
        if (peak > PRESET_SWAY.HEAD_BUDGET) {
          const scale = PRESET_SWAY.HEAD_BUDGET / peak;
          for (const key of Object.keys(channelAmounts)) channelAmounts[key] *= scale;
        }
      }
      const start = Math.max(0, cursor);
      const end = start + prepareMs + activeMs + holdMs + exitMs;
      const stage = {
        index: stages.length,
        op,
        kind: profile.kind,
        channels,
        sign,
        start,
        prepareMs,
        activeMs,
        holdMs,
        exitMs,
        end,
        phase: 'pending',
        phases: [],
        firstWriteAt: null,
        lastWriteAt: null,
        peak: 0,
        channelAmounts,
        cancelOffsets,
        targetOffsets,
        sway: swayPlan,
      };
      stages.push(stage);
      const gap = separated ? PRESET_EXECUTION.SEPARATED_GAP_MS / tempo : 0;
      const overlap = separated ? 0 : exitMs * PRESET_EXECUTION.CONNECTED_OVERLAP_RATIO;
      cursor = end + gap - overlap;
    }
    const durationMs = stages.reduce((max, stage) => Math.max(max, stage.end), 0);
    return { stages, durationMs, droppedOps, nativeOps, timing, holdScale, gazeHabit, tilt };
  }

  function presetStageEnvelope(stage, elapsed) {
    const local = elapsed - stage.start;
    if (local < 0) return null;
    if (local < stage.prepareMs) {
      // The sway starts directly with its first lean (no opposite wind-up), so its prepare leg is
      // a quiet zero-length hold rather than a small shake in the wrong direction.
      if (stage.kind === 'sway') return { phase: 'prepare', wave: 0 };
      const u = local / Math.max(1, stage.prepareMs);
      return { phase: 'prepare', wave: -PRESET_EXECUTION.PREPARE_RATIO * Math.sin(Math.PI * u) };
    }
    const activeStart = stage.prepareMs;
    if (local < activeStart + stage.activeMs) {
      const p = clamp01((local - activeStart) / Math.max(1, stage.activeMs));
      if (stage.kind === 'sway') {
        return { phase: 'active', wave: swayActiveWave(p, stage.sway), signed: true };
      }
      if (stage.kind === 'nod') return { phase: 'active', wave: Math.sin(Math.PI * p) };
      if (stage.kind === 'double-nod') {
        return {
          phase: 'active',
          wave: p < 0.5 ? Math.sin(Math.PI * (p * 2)) : 0.6 * Math.sin(Math.PI * ((p - 0.5) * 2)),
        };
      }
      if (stage.kind === 'shake') return { phase: 'active', wave: Math.sin(Math.PI * 2 * p), signed: true };
      if (stage.kind === 'double-blink') {
        return {
          phase: 'active',
          wave: p < 0.5 ? Math.sin(Math.PI * (p * 2)) : Math.sin(Math.PI * ((p - 0.5) * 2)),
        };
      }
      if (stage.kind === 'blink') return { phase: 'active', wave: Math.sin(Math.PI * p) };
      return { phase: 'active', wave: smootherstep(p) };
    }
    const holdEnd = activeStart + stage.activeMs + stage.holdMs;
    if (local < holdEnd) {
      // The sway dwell keeps the second lean; every other signed/one-shot action returns to zero.
      if (stage.kind === 'sway') return { phase: 'hold', wave: swayHoldWave(stage.sway) };
      return { phase: 'hold', wave: (stage.kind === 'nod' || stage.kind === 'double-nod'
        || stage.kind === 'shake' || stage.kind === 'blink' || stage.kind === 'double-blink') ? 0 : 1 };
    }
    if (local < holdEnd + stage.exitMs) {
      const u = smootherstep((local - holdEnd) / Math.max(1, stage.exitMs));
      // The sway exits from its dwell level back to the natural baseline, not from a forced zero.
      if (stage.kind === 'sway') return { phase: 'exit', wave: swayHoldWave(stage.sway) * (1 - u) };
      const base = (stage.kind === 'nod' || stage.kind === 'double-nod'
        || stage.kind === 'shake' || stage.kind === 'blink' || stage.kind === 'double-blink') ? 0 : 1;
      return { phase: 'exit', wave: base * (1 - u) };
    }
    return null;
  }

  function presetStageValues(stage, wave) {
    const values = {};
    if (stage.kind === 'blink' || stage.kind === 'double-blink') {
      const closure = clamp01(stage.channelAmounts.eyeOpenL ?? 0) * clamp01(Math.max(0, wave));
      for (const channel of stage.channels) values[channel] = clamp01(1 - closure);
      return values;
    }
    if (stage.kind === 'center') {
      // LIVE offset: the correction is re-evaluated from the current natural baseline and the
      // current pose on every frame. It is evidence only; the centre is applied as a bounded
      // blend after arbitration (see presetFrame/tick) so the idle-base contribution is never
      // double-counted or overshot.
      const liveWave = clamp01(wave);
      for (const channel of stage.channels) {
        values[channel] = (naturalPresetPose(channel) - actualPresetPose(channel)) * liveWave;
      }
      return values;
    }
    if (stage.kind === 'target') {
      for (const channel of stage.channels) values[channel] = finite(stage.targetOffsets[channel], 0) * wave;
      return values;
    }
    const signed = stage.kind === 'shake' || stage.kind === 'sway' ? wave : Math.max(0, wave);
    for (const channel of stage.channels) values[channel] = finite(stage.channelAmounts[channel], 0) * signed;
    return values;
  }

  function notePresetStage(item, stage, phase, values, now) {
    const trace = item.trace;
    if (trace.output.stages.length <= stage.index) {
      trace.output.stages[stage.index] = {
        op: stage.op,
        kind: stage.kind,
        channels: [...stage.channels],
        startMs: Math.round(stage.start),
        activeMs: Math.round(stage.activeMs),
        holdMs: Math.round(stage.holdMs),
        exitMs: Math.round(stage.exitMs),
        phases: [],
        firstWriteAt: null,
        lastWriteAt: null,
        peak: 0,
      };
    }
    const record = trace.output.stages[stage.index];
    if (stage.phase !== phase) {
      stage.phase = phase;
      record.phase = phase;
      if (!record.phases.includes(phase)) record.phases.push(phase);
      if (!stage.phases.includes(phase)) stage.phases.push(phase);
      trace.output.samples.push({
        at: Math.round(now - item.startedAt),
        op: stage.op,
        phase,
        channels: { ...values },
      });
      while (trace.output.samples.length > PRESET_EXECUTION.SAMPLE_LIMIT) trace.output.samples.shift();
    }
    let peak = 0;
    for (const [channel, value] of Object.entries(values)) {
      if (Math.abs(value) > Math.abs(peak)) peak = value;
      if (Math.abs(value) > 1e-4) {
        if (!item.written.has(channel)) item.written.add(channel);
        if (!trace.output.channels.includes(channel)) trace.output.channels.push(channel);
        if (record.firstWriteAt === null) {
          record.firstWriteAt = Math.round(now - item.startedAt);
          trace.output.samples.push({
            at: record.firstWriteAt,
            op: stage.op,
            phase,
            channels: { ...values },
          });
          while (trace.output.samples.length > PRESET_EXECUTION.SAMPLE_LIMIT) trace.output.samples.shift();
        }
        record.lastWriteAt = Math.round(now - item.startedAt);
      }
    }
    if (Math.abs(peak) > Math.abs(record.peak)) record.peak = peak;
    trace.output.peak = Math.max(trace.output.peak, Math.abs(peak));
  }

  function finishPresetTrace(item, now, { interrupted = false } = {}) {
    const trace = item.trace;
    trace.output.endedAt = now;
    trace.output.durationMs = Math.max(0, Math.round(now - item.startedAt));
    trace.output.channels = [...trace.output.channels];
    trace.output.reason = interrupted ? 'interrupted' : 'completed';
    state.presets.lastTrace = clonePresetTrace(trace);
    state.presets.recent.push(clonePresetTrace(trace));
    while (state.presets.recent.length > PRESET_EXECUTION.TRACE_LIMIT) state.presets.recent.shift();
    recordEvent('avatar.preset.trace', {
      presetId: item.presetId,
      kind: interrupted ? 'interrupted' : 'completed',
      channels: [...trace.output.channels],
      peak: trace.output.peak,
      at: now,
    });
    return trace;
  }

  /**
   * Keep a finished preset's channels in the ONE write set until the pose is back at its idle
   * baseline. This reuses the expression release window (settle → settled or one forced 0). Only
   * channels the idle frame does NOT already own are released: head/eye are always written, while
   * gaze/brow would otherwise freeze at their last value on the VTS input. Body/breath are never
   * part of a trajectory (VTS-native), so they are never released either.
   */
  function markPresetRelease(item, atMs) {
    if (item.written.size === 0) return;
    for (const channel of item.channels) {
      if (IDLE_WRITE_CHANNELS.includes(channel)) continue;
      if (state.releases.has(channel)) continue;
      const owned = state.presets.active.some((other) => other !== item && other.channels.includes(channel))
        || state.expressions.some((other) => other.channels.includes(channel))
        || state.intents.some((other) => other.channels.includes(channel));
      if (owned) continue;
      state.releases.set(channel, { kind: `preset:${item.presetId}`, atMs, frames: 0, last: null });
    }
  }

  function removePresetItem(item, now, { interrupted = false } = {}) {
    const index = state.presets.active.indexOf(item);
    if (index >= 0) state.presets.active.splice(index, 1);
    item.done = true;
    // The trajectory stopped contributing, but its last value is still on the input: hand the
    // channels to the release window so the pose returns smoothly instead of sticking there.
    markPresetRelease(item, now);
    return finishPresetTrace(item, now, { interrupted });
  }

  // ---- answer-start takeover (item 5) ----------------------------------------------------
  /**
   * The takeover cross-fade in force, or `null` when the configured value is outside the short
   * window. A `null` answer is a REFUSAL, never a silent clamp to a snap or a long dissolve.
   */
  function resolveTakeoverFadeMs() {
    const raw = finite(cfg.presetTakeoverFadeMs, PRESET_TAKEOVER.FADE_MS);
    return raw >= PRESET_TAKEOVER.FADE_MIN_MS && raw <= PRESET_TAKEOVER.FADE_MAX_MS
      ? Math.round(raw) : null;
  }

  /**
   * Arbitrate an opening gesture against the action that owns the pose. This is a PURE decision:
   * nothing is written, displaced or delayed here, so a refusal leaves the running action intact
   * and the caller can report `takeover-unavailable` immediately.
   */
  function planTakeover(request, channels) {
    const fadeMs = resolveTakeoverFadeMs();
    const plan = {
      fromAction: String(request.action ?? ''),
      fromActionId: String(request.actionId ?? ''),
      fromPreset: request.preset ?? null,
      toChannels: [...channels],
      yieldedChannels: [],
      keptChannels: [],
      fadeMs,
    };
    // A transition outside the short window can never be a safe hand-over.
    if (fadeMs === null) return { ...plan, ok: false, reason: 'transition-out-of-window' };
    const item = state.presets.active
      .find((entry) => String(entry.actionId) === String(request.actionId ?? '')) ?? null;
    // No live trajectory: either the old action already finished its motion (nothing to yield) or
    // it is not a preset action at all (an explicit gesture is never displaced).
    if (item === null) {
      return request.preset === null || request.preset === undefined
        ? { ...plan, ok: false, reason: 'explicit-action' }
        : { ...plan, ok: true, item: null };
    }
    if (!PRESET_TAKEOVER.YIELDABLE_EVENTS.includes(String(item.event ?? request.event ?? ''))) {
      return { ...plan, ok: false, reason: 'explicit-action' };
    }
    const yielded = item.channels.filter((channel) => channels.includes(channel));
    const kept = item.channels.filter((channel) => !channels.includes(channel));
    // An absolute channel (eye-open) has no blend: two owners cannot share it even for 200 ms.
    if (yielded.some((channel) => PRESET_TAKEOVER.ABSOLUTE_CHANNELS.includes(channel))) {
      return { ...plan, ok: false, reason: 'channel-not-separable', yieldedChannels: yielded, keptChannels: kept };
    }
    return { ...plan, ok: true, item, yieldedChannels: yielded, keptChannels: kept };
  }

  /** Start the cross-fade on the CONFLICT channels only; every kept channel keeps its owner. */
  function applyTakeover(plan, toItem, at) {
    const from = plan.item;
    if (plan.yieldedChannels.length > 0) {
      from.yieldAt = at;
      from.yieldFadeMs = plan.fadeMs;
      for (const channel of plan.yieldedChannels) from.yieldChannels.add(channel);
      from.trace.interrupt = {
        reason: 'takeover', at, fadeMs: plan.fadeMs, by: plan.fromAction, toPreset: toItem.presetId,
      };
    }
    state.presets.takeovers += 1;
    // `fromAction` is the displaced action (its preset id), `toPreset` the opening gesture; the
    // channel lists say exactly what moved and what stayed with the old owner.
    recordEvent('avatar.preset.takeover', {
      fromAction: plan.fromAction,
      fromActionId: plan.fromActionId,
      fromPreset: from.presetId,
      toPreset: toItem.presetId,
      toActionId: toItem.actionId,
      yieldedChannels: [...plan.yieldedChannels],
      keptChannels: [...plan.keptChannels],
      fadeMs: plan.fadeMs,
      at,
    });
    return plan;
  }

  /**
   * The fade is over: the yielded channels leave the old owner entirely, so exactly ONE action
   * owns each of them from here on. An action with nothing left simply ends (its kept channels —
   * if any — keep running to their own natural end).
   */
  function completeTakeoverYield(item, now) {
    const yielded = [...item.yieldChannels];
    item.yieldAt = null;
    item.yieldFadeMs = 0;
    item.yieldChannels.clear();
    item.channels = item.channels.filter((channel) => !yielded.includes(channel));
    item.yieldedReleased.push(...yielded);
    recordEvent('avatar.preset.takeover.done', {
      actionId: item.actionId, presetId: item.presetId, channels: yielded, at: now,
    });
    if (item.channels.length === 0) removePresetItem(item, now, { interrupted: true });
  }

  /**
   * Execute one already-selected preset through the ONE controller. The operations keep their
   * order and channels; a failed capability check is a hold, never a silent partial gesture.
   */
  function startPreset(selection, options = {}) {
    const at = Number.isFinite(options.at) ? options.at : clockNow();
    const context = selection?.context !== undefined && options.context === undefined
      ? { ...presetContext({}), ...selection.context }
      : presetContext(options.context ?? {});
    // A selection carries the exact verified set / proofs it was drawn with; execution must not
    // quietly widen it to whatever the runtime happens to know later.
    if (Array.isArray(selection?.verifiedChannels)) context.verifiedChannels = [...selection.verifiedChannels];
    if (selection?.targetVerified !== undefined) context.targetVerified = selection.targetVerified === true;
    if (selection?.directionVerified !== undefined) context.directionVerified = selection.directionVerified === true;
    if (selection === null || selection === undefined || selection.kind !== 'preset') {
      const hold = selection ?? holdSelection(['no-selection']);
      recordPresetHoldTrace({ ...hold, verifiedChannels: context.verifiedChannels }, at, 'hold');
      notePresetDebugEvent('avatar.preset.skip', {
        reason: presetSkipReason(hold, context),
        event: context.event,
        state: context.state,
        verifiedChannels: [...(context.verifiedChannels ?? [])],
        reasons: [...(hold.reasons ?? [])],
        droppedChannels: [...(hold.droppedChannels ?? [])],
        /** The draw this execution refused (null only when no selection was passed at all). */
        selectionId: selection?.selectionId ?? null, actionId: null,
      }, at);
      return { ok: true, started: false, kind: 'hold', selection: hold, trace: clonePresetTrace(state.presets.lastTrace) };
    }
    const built = buildPresetTrajectory(selection, context, at);
    if (built.stages.length === 0) {
      const reason = built.nativeOps.length > 0 ? 'native-owned' : 'no-executable-operations';
      const hold = holdSelection([...selection.reasons, reason]);
      recordPresetHoldTrace({ ...hold, verifiedChannels: context.verifiedChannels }, at, reason);
      notePresetDebugEvent('avatar.preset.skip', {
        reason: presetSkipReason(hold, context),
        event: context.event,
        state: context.state,
        verifiedChannels: [...(context.verifiedChannels ?? [])],
        reasons: [...(hold.reasons ?? [])],
        droppedChannels: [...(hold.droppedChannels ?? [])],
        /** The draw this execution refused (null only when no selection was passed at all). */
        selectionId: selection?.selectionId ?? null, actionId: null,
      }, at);
      return { ok: true, started: false, kind: 'hold', reason, selection: hold, trace: clonePresetTrace(state.presets.lastTrace) };
    }
    // Answer-start takeover (item 5): decided BEFORE anything is written or displaced. A refusal
    // returns here, so the running action is untouched and the caller can drop the opening gesture
    // at once instead of waiting for that action to end.
    const toChannels = [...new Set(built.stages.flatMap((stage) => stage.channels))];
    const takeover = options.takeover ? planTakeover(options.takeover, toChannels) : null;
    if (takeover !== null && takeover.ok !== true) {
      return {
        ok: true, started: false, kind: 'hold', reason: 'takeover-unavailable', takeover,
        trace: clonePresetTrace(state.presets.lastTrace),
      };
    }
    const trace = presetTraceBase({
      ...selection,
      verifiedChannels: context.verifiedChannels,
      targetVerified: context.targetVerified,
      directionVerified: context.directionVerified,
      context: context.presetTraceContext ?? selection.context,
    }, at);
    trace.output.startedAt = at;
    trace.output.stages = built.stages.map((stage) => ({
      op: stage.op,
      kind: stage.kind,
      channels: [...stage.channels],
      startMs: Math.round(stage.start),
      activeMs: Math.round(stage.activeMs),
      holdMs: Math.round(stage.holdMs),
      exitMs: Math.round(stage.exitMs),
      phases: [],
      firstWriteAt: null,
      lastWriteAt: null,
      peak: 0,
    }));
    trace.output.droppedChannels = [...(selection.droppedChannels ?? [])];
    trace.output.reason = 'running';
    // A started action is observable immediately: `lastTrace` is the newest trace, whether it is
    // still running (also available as `currentTrace`) or already finished. Cancellation/eviction
    // later overwrites it with the completed/interrupted trace, exactly as before.
    state.presets.lastTrace = clonePresetTrace(trace);
    if (built.nativeOps.length > 0) trace.output.nativeOwned = [...built.nativeOps];
    if (built.droppedOps.length > 0) trace.output.skippedOperations = [...built.droppedOps];
    state.presets.seq += 1;
    // Unique per STARTED trajectory, so its several commits can be merged by action id. The
    // select id of the draw it executed is kept too (selection → action association).
    const actionId = `presetAction#${state.presets.seq}`;
    const item = {
      seq: state.presets.seq,
      actionId,
      selectionId: selection.selectionId ?? null,
      /** The context.event this action was started for (`idle` vs a dialogue phase). */
      event: context.event ?? '',
      presetId: selection.presetId,
      family: selection.family,
      recipe: selection.recipe,
      variant: selection.variant,
      actionVariant: selection.actionVariant ?? null,
      actionVariantKey: selection.actionVariantKey ?? null,
      operations: [...(selection.operations ?? [])],
      channels: [...new Set(built.stages.flatMap((stage) => stage.channels))],
      stages: built.stages,
      durationMs: built.durationMs,
      startedAt: at,
      generation: Number.isInteger(options.generation) ? options.generation : state.presets.generation,
      cancelledAt: null,
      cancelFadeMs: 0,
      done: false,
      written: new Set(),
      /** First acknowledged value per channel, for commit evidence only (`{at, values}`). */
      firstCommitted: null,
      /**
       * Whole-life maximum of every ACKNOWLEDGED |value|, not the last frame's value: `abs` is the
       * overall peak, `byChannel` the per-channel peaks. `avatar.preset.commit.peak` reports `abs`
       * so a trajectory that goes large early and returns to rest is still measured at its real
       * excursion; the tail value is reported separately as `lastAbs`.
       */
      committedPeak: { abs: 0, byChannel: Object.create(null) },
      /** Acknowledgements merged by this action id; never a per-frame counter. */
      commitCount: 0,
      /** Takeover state: the channels fading OUT to a newer owner, and when that fade began. */
      yieldChannels: new Set(),
      yieldAt: null,
      yieldFadeMs: 0,
      /** Channels already handed over after the fade completed (evidence only). */
      yieldedReleased: [],
      trace,
    };
    state.presets.active.push(item);
    while (state.presets.active.length > 2) {
      const evicted = state.presets.active.shift();
      evicted.done = true;
      markPresetRelease(evicted, at);
      finishPresetTrace(evicted, at, { interrupted: true });
    }
    handOffReleases(item.channels);
    if (takeover !== null && takeover.ok === true && takeover.item !== null) {
      applyTakeover(takeover, item, at);
    }
    state.presets.starts += 1;
    state.presets.lastSign = state.presets.lastSign ?? Object.create(null);
    // Selection memory is written ONLY here, after a trajectory really started. A hold draw, a
    // refused capability check, a takeover refusal and a later cancellation never enter it.
    const historyEntry = {
      id: selection.presetId,
      recipe: typeof selection.recipe === 'string' ? selection.recipe : null,
      family: typeof selection.family === 'string' ? selection.family : null,
      at,
    };
    state.presets.history.push(historyEntry);
    while (state.presets.history.length > 32) state.presets.history.shift();
    if (typeof selection.family === 'string' && selection.family.length > 0) {
      state.presets.recentFamilies.push(selection.family);
      while (state.presets.recentFamilies.length > 8) state.presets.recentFamilies.shift();
    }
    // Push BOTH ids: the selector counts recipe repetition (same recipe, any variant) and exact
    // preset repetition separately. Old preset-only entries are completed through the catalog.
    if (typeof selection.recipe === 'string' && selection.recipe.length > 0) {
      state.presets.recentRecipes.push(selection.recipe);
      while (state.presets.recentRecipes.length > 8) state.presets.recentRecipes.shift();
      state.presets.recentActions.push(selection.recipe);
    }
    state.presets.recentActions.push(selection.presetId);
    while (state.presets.recentActions.length > 8) state.presets.recentActions.shift();
    // D: a semantic action (answer-start / confused / …) starts the idle quiet window. Only a real
    // start reaches this point; an idle action never moves the semantic clock.
    if (typeof context.event === 'string' && context.event.length > 0 && context.event !== 'idle') {
      state.presets.lastSemanticAt = at;
    }
    if ((selection.operations ?? []).some((operation) => operation === 'blink' || operation === 'double-blink')) {
      state.presets.blinkStarts += 1;
    }
    // Observability only: the executor already resolved these amounts; the event publishes them so
    // "it started" can be judged together with "how large / how long" (and reaches the host log).
    const plannedStages = presetPlannedStages(built.stages);
    const plannedAmplitude = plannedStages.reduce((max, stage) => Math.max(max, stage.amplitude), 0);
    notePresetDebugEvent('avatar.preset.start', {
      actionId,
      selectionId: selection.selectionId ?? null,
      presetId: selection.presetId,
      family: selection.family,
      recipe: selection.recipe,
      variant: selection.variant,
      actionVariant: selection.actionVariant ?? null,
      actionVariantKey: selection.actionVariantKey ?? null,
      event: context.event ?? '',
      operations: [...(selection.operations ?? [])],
      channels: [...item.channels],
      amplitude: plannedAmplitude,
      durationMs: built.durationMs,
      stages: plannedStages,
      at,
    });
    return {
      ok: true,
      started: true,
      kind: 'preset',
      actionId,
      /** Item 5: the arbitration that let this action replace a pre-answer one (null = none). */
      takeover: takeover !== null && takeover.ok === true
        ? {
            ok: true,
            fromAction: takeover.fromAction,
            fromActionId: takeover.fromActionId,
            fromPreset: takeover.fromPreset,
            toChannels: [...takeover.toChannels],
            yieldedChannels: [...takeover.yieldedChannels],
            keptChannels: [...takeover.keptChannels],
            fadeMs: takeover.fadeMs,
          }
        : null,
      event: item.event,
      selectionId: item.selectionId,
      presetId: selection.presetId,
      family: selection.family,
      recipe: selection.recipe,
      variant: selection.variant,
      actionVariant: selection.actionVariant ?? null,
      actionVariantKey: selection.actionVariantKey ?? null,
      operations: [...item.operations],
      channels: [...item.channels],
      droppedChannels: [...(selection.droppedChannels ?? [])],
      durationMs: built.durationMs,
      stages: trace.output.stages,
      trace: clonePresetTrace(trace),
    };
  }

  /** One action boundary: select, then execute. A hold draw writes no preset channel at all. */
  function preset(context = {}) {
    const selection = selectPreset(context);
    if (selection.kind !== 'preset') {
      const trace = recordPresetHoldTrace(selection, Number.isFinite(context.at) ? context.at : clockNow());
      return { ok: true, started: false, kind: 'hold', selection, trace: clonePresetTrace(trace) };
    }
    return startPreset(selection, {
      at: Number.isFinite(context.at) ? context.at : clockNow(),
      generation: context.generation,
      context,
      /** Item 5: the opening gesture arbitrated against the action that owns the pose. */
      takeover: context.takeover ?? null,
    });
  }

  /**
   * Fold every active preset into the same additive pose frame the legacy intents use. Returns
   * additions only; the caller (intentFrame) still owns the single arbitration/compose path.
   *
   * `centers` is the one non-additive exception: a centre operation is a bounded blend back to the
   * CURRENT natural baseline (`state.idle`, the active posture component included), applied after
   * arbitration so the idle-base contribution is never double-counted/overshot. It is suppressed
   * while another active preset owns the same channel: an old settle may never overwrite a newer
   * action, and the newer action's exit→0 remains its own release.
   */
  function presetFrame(now) {
    const adds = { headX: 0, headY: 0, headZ: 0, browL: 0, browR: 0, bodyX: 0, bodyY: 0, bodyZ: 0 };
    const gaze = { x: 0, y: 0 };
    const centers = Object.create(null);
    let eye = null;
    if (state.presets.active.length === 0) return { adds, gaze, eye, centers, active: 0 };
    for (let index = state.presets.active.length - 1; index >= 0; index -= 1) {
      const item = state.presets.active[index];
      const elapsed = now - item.startedAt;
      if (elapsed < 0) continue;
      // A finished takeover fade releases the yielded channels to the new owner (and ends an
      // action that has nothing left to drive) before this frame contributes anything.
      if (item.yieldAt !== null && now - item.yieldAt >= Math.max(1, item.yieldFadeMs)) {
        completeTakeoverYield(item, now);
        if (item.done === true) continue;
      }
      let fade = 1;
      if (item.cancelledAt !== null) {
        const cancelElapsed = now - item.cancelledAt;
        if (cancelElapsed >= Math.max(1, item.cancelFadeMs)) {
          removePresetItem(item, now, { interrupted: true });
          continue;
        }
        fade = 1 - smootherstep(cancelElapsed / Math.max(1, item.cancelFadeMs));
      }
      // A takeover scales ONLY the channels the newer action needs; every kept channel keeps its
      // full contribution until the old action's own end.
      const yieldFade = item.yieldAt === null
        ? 1 : 1 - smootherstep((now - item.yieldAt) / Math.max(1, item.yieldFadeMs));
      if (elapsed >= item.durationMs) {
        removePresetItem(item, now, { interrupted: item.cancelledAt !== null });
        continue;
      }
      let contributed = false;
      for (const stage of item.stages) {
        const envelope = presetStageEnvelope(stage, elapsed);
        if (envelope === null) continue;
        const values = presetStageValues(stage, envelope.wave);
        let any = false;
        if (stage.kind === 'center') {
          // Centre: evidence is the LIVE natural-baseline correction; the actual blend happens
          // after arbitration (see tick). A same-channel newer owner suppresses it completely.
          for (const channel of Object.keys(values)) {
            if (!item.channels.includes(channel)) continue;
            const ownedByOther = state.presets.active.some((other) => other !== item
              && other.done !== true && other.channels.includes(channel));
            if (ownedByOther) {
              values[channel] = 0;
              continue;
            }
            let wave = clamp01(envelope.wave) * fade;
            if (item.yieldChannels.has(channel)) wave *= yieldFade;
            const target = naturalPresetPose(channel);
            values[channel] = (target - actualPresetPose(channel)) * wave;
            centers[channel] = { target, wave, presetId: item.presetId, actionId: item.actionId };
            if (Math.abs(values[channel]) > 1e-4) any = true;
          }
          notePresetStage(item, stage, envelope.phase, values, now);
          if (any) contributed = true;
          continue;
        }
        for (const [channel, value] of Object.entries(values)) {
          // Ownership: a channel this action already handed over is no longer its to write.
          if (!item.channels.includes(channel)) continue;
          let scaled = finite(value, 0) * fade;
          if (item.yieldChannels.has(channel)) scaled *= yieldFade;
          if (!Number.isFinite(scaled)) continue;
          if (PRESET_HEAD_CHANNELS.includes(channel) || channel === 'bodyX' || channel === 'bodyY' || channel === 'bodyZ') {
            adds[channel] += scaled;
          } else if (channel === 'browL' || channel === 'browR') {
            adds[channel] += scaled;
          } else if (channel === 'gazeX' || channel === 'gazeY') {
            gaze[channel === 'gazeX' ? 'x' : 'y'] += scaled;
          } else if (channel === 'eyeOpenL' || channel === 'eyeOpenR') {
            if (eye === null) eye = { left: 1, right: 1 };
            if (channel === 'eyeOpenL') eye.left = Math.min(eye.left, scaled);
            else eye.right = Math.min(eye.right, scaled);
          }
          if (Math.abs(scaled) > 1e-4) any = true;
        }
        notePresetStage(item, stage, envelope.phase, values, now);
        if (any) contributed = true;
      }
      if (!contributed && item.cancelledAt === null && elapsed >= item.durationMs) {
        removePresetItem(item, now, { interrupted: false });
      }
    }
    adds.headX = presetClamp(adds.headX, 0.95);
    adds.headY = presetClamp(adds.headY, 0.95);
    adds.headZ = presetClamp(adds.headZ, HEAD_ROLL_CAP);
    adds.browL = presetClamp(adds.browL, 0.6);
    adds.browR = presetClamp(adds.browR, 0.6);
    gaze.x = presetClamp(gaze.x, EXPRESSION_MOTION.MAX_GAZE);
    gaze.y = presetClamp(gaze.y, EXPRESSION_MOTION.MAX_GAZE);
    return { adds, gaze, eye, centers, active: state.presets.active.length };
  }

  /**
   * Evidence only: record the pose the controller COMPUTED for the active preset channels. This is
   * deliberately not `committed` — only the transport sender may report a commit (see
   * `notePresetTransport`), so a computed value can never be mistaken for a sent one.
   */
  function notePresetComputed(pose) {
    for (const item of state.presets.active) {
      for (const channel of item.channels) {
        if (!Number.isFinite(pose[channel])) continue;
        item.trace.output.computed[channel] = pose[channel];
      }
    }
  }

  /**
   * Sender evidence for the ONE transport write path, in five phases that never masquerade:
   *
   *   prepared   rows this frame assembled (`output.prepared`, `preparedFrames`). A computed frame
   *              is not a send: nothing left the process yet.
   *   attempted  rows really handed to the transport (`output.attempted`, `attemptedFrames`). The
   *              call started; the transport has NOT acknowledged anything yet.
   *   committed  only after an `ok:true` answer, with the acknowledgement time (`committedAt`) and
   *              the payload value. Requires every captured `owners` identity to still be the live
   *              trajectory: a late success from an old preset may never land on the current one.
   *   failed     `ok:false` or a thrown send (`failed.count`, `failed.codes`, `failed.lastCode`).
   *              A failed send is never a commit.
   *   stale      a result discarded because its connection generation or its preset identity moved
   *              on before it settled (`stale.count`, `stale.reasons`). Never a commit either.
   *
   * `owners` is the active preset identity captured when the rows were built (`{seq, generation}`);
   * a live item only receives evidence when its own identity is in that captured set.
   */
  function notePresetTransport({
    phase = 'prepared', rows = [], skipped = [], at = null, owners = null,
    error = null, reason = '',
  } = {}) {
    const now = Number.isFinite(at) ? at : clockNow();
    const stats = state.presets.transport;
    if (phase === 'prepared') {
      if (state.presets.active.length === 0) return { committed: false, stale: false, reason: '' };
      const values = presetRowValues(rows);
      const reasons = presetRowReasons(skipped);
      for (const item of state.presets.active) {
        const output = item.trace.output;
        for (const channel of item.channels) {
          if (values.has(channel)) output.prepared[channel] = values.get(channel);
          else if (reasons.has(channel)) output.skippedByTransport[channel] = reasons.get(channel);
        }
        output.preparedFrames += 1;
      }
      stats.prepared += 1;
      stats.lastAt = now;
      return { committed: false, stale: false, reason: '' };
    }
    if (phase === 'attempted') {
      if (state.presets.active.length === 0) return { committed: false, stale: false, reason: '' };
      const values = presetRowValues(rows);
      const allow = presetOwnerSet(owners);
      for (const item of state.presets.active) {
        if (allow !== null && allow.has(presetOwnerKey(item)) !== true) continue;
        const output = item.trace.output;
        for (const channel of item.channels) {
          if (values.has(channel)) output.attempted[channel] = values.get(channel);
        }
        output.attemptedFrames += 1;
      }
      stats.attempted += 1;
      stats.lastAt = now;
      return { committed: false, stale: false, reason: '' };
    }
    if (phase === 'committed') {
      // A late/foreign result never becomes a commit: the captured action must still be current.
      if (presetOwnersCurrent(owners) !== true) {
        markPresetStale('action-changed', now, owners);
        return { committed: false, stale: true, reason: 'action-changed' };
      }
      const values = presetRowValues(rows);
      const allow = presetOwnerSet(owners);
      let committed = 0;
      for (const item of state.presets.active) {
        if (allow !== null && allow.has(presetOwnerKey(item)) !== true) continue;
        const output = item.trace.output;
        for (const channel of item.channels) {
          const value = values.get(channel);
          if (!Number.isFinite(value)) continue;
          output.committed[channel] = value;
          output.committedAt[channel] = now;
          // Whole-life evidence: keep the largest |value| this channel ever acknowledged, so the
          // reported peak cannot collapse to the value of the last frame.
          const magnitude = Math.abs(value);
          if (magnitude > item.committedPeak.abs) item.committedPeak.abs = magnitude;
          const channelPeak = item.committedPeak.byChannel[channel] ?? 0;
          if (magnitude > channelPeak) item.committedPeak.byChannel[channel] = magnitude;
          committed += 1;
        }
      }
      stats.committed += 1;
      stats.lastAt = now;
      // Observability only: report the acknowledged channels of the trajectory that really
      // committed. The values are the trace's own commit evidence; nothing is re-sent here.
      const committedItem = state.presets.active.find((item) => (
        (allow === null || allow.has(presetOwnerKey(item)) === true)
        && Object.keys(item.trace.output.committed).length > 0
      ));
      if (committedItem !== undefined) {
        const output = committedItem.trace.output;
        const lastValue = { ...output.committed };
        if (committedItem.firstCommitted === null) {
          committedItem.firstCommitted = { at: now, values: {} };
        }
        const firstValue = committedItem.firstCommitted.values;
        for (const [channel, value] of Object.entries(lastValue)) {
          if (!Object.prototype.hasOwnProperty.call(firstValue, channel)) firstValue[channel] = value;
        }
        // The tail evidence: the last acknowledged value of each channel, as before.
        const lastAbs = Object.values(lastValue).reduce((max, value) => (
          Number.isFinite(value) ? Math.max(max, Math.abs(value)) : max
        ), 0);
        committedItem.commitCount += 1;
        notePresetDebugEvent('avatar.preset.commit', {
          /** Identity of the action this acknowledgement belongs to (merge several by it). */
          actionId: committedItem.actionId,
          selectionId: committedItem.selectionId ?? null,
          event: committedItem.event ?? '',
          commitCount: committedItem.commitCount,
          presetId: committedItem.presetId,
          channels: [...committedItem.channels],
          committed: Object.keys(output.committed),
          skippedByTransport: { ...output.skippedByTransport },
          /**
           * All values below are the ACKNOWLEDGED values, never a new physical quantity.
           * `peak` is the whole-action maximum |value| over every frame and channel; `lastAbs` is
           * the tail value (max |last acknowledged value per channel|), the old `peak` meaning.
           */
          peak: committedItem.committedPeak.abs,
          peakByChannel: { ...committedItem.committedPeak.byChannel },
          lastAbs,
          firstValue: { ...firstValue },
          lastValue,
          /** first acknowledgement of this action → this one: the merge window. */
          firstAt: committedItem.firstCommitted.at,
          lastAt: now,
          spanMs: Math.max(0, now - committedItem.firstCommitted.at),
        }, now);
      }
      return { committed: committed > 0, stale: false, reason: '' };
    }
    if (phase === 'failed') {
      const code = String(error?.code ?? error?.errorCode ?? 'WRITE_FAILED');
      stats.failed += 1;
      stats.lastAt = now;
      stats.lastErrorCode = code;
      stats.lastError = String(error?.message ?? error ?? '');
      const allow = presetOwnerSet(owners);
      for (const item of state.presets.active) {
        if (allow !== null && allow.has(presetOwnerKey(item)) !== true) continue;
        const output = item.trace.output;
        output.failed.count += 1;
        output.failed.at = now;
        output.failed.codes[code] = (output.failed.codes[code] ?? 0) + 1;
        output.failed.lastCode = code;
      }
      return { committed: false, stale: false, reason: '' };
    }
    if (phase === 'stale') {
      markPresetStale(String(reason ?? 'stale'), now, owners);
      return { committed: false, stale: true, reason: String(reason ?? 'stale') };
    }
    return { committed: false, stale: false, reason: '' };
  }

  /** Map `{channel, value}` rows to finite values only; anything else is not evidence. */
  function presetRowValues(rows) {
    const values = new Map();
    for (const entry of Array.isArray(rows) ? rows : []) {
      if (entry === null || typeof entry !== 'object' || typeof entry.channel !== 'string') continue;
      if (!Number.isFinite(entry.value)) continue;
      values.set(entry.channel, entry.value);
    }
    return values;
  }

  function presetRowReasons(skipped) {
    const reasons = new Map();
    for (const entry of Array.isArray(skipped) ? skipped : []) {
      if (entry === null || typeof entry !== 'object' || typeof entry.channel !== 'string') continue;
      reasons.set(entry.channel, String(entry.reason ?? 'skipped'));
    }
    return reasons;
  }

  /** Identity of one preset trajectory: its monotonic start sequence plus its action generation. */
  function presetOwnerKey(item) {
    return `${item?.seq}:${item?.generation ?? ''}`;
  }

  function presetOwnerSet(owners) {
    if (Array.isArray(owners) !== true || owners.length === 0) return null;
    return new Set(owners.map(presetOwnerKey));
  }

  /** Every captured owner must still be the live trajectory, or the result is stale. */
  function presetOwnersCurrent(owners) {
    if (Array.isArray(owners) !== true || owners.length === 0) return false;
    const live = new Set(state.presets.active.map(presetOwnerKey));
    return owners.every((owner) => live.has(presetOwnerKey(owner)));
  }

  /** Discard one result: counted as stale, never as committed; the trace keeps it separated. */
  function markPresetStale(reason, at, owners = null) {
    const stats = state.presets.transport;
    const label = String(reason ?? 'stale');
    stats.stale += 1;
    stats.lastAt = at;
    stats.lastStaleReason = label;
    const allow = presetOwnerSet(owners);
    for (const item of state.presets.active) {
      if (allow !== null && allow.has(presetOwnerKey(item)) !== true) continue;
      const output = item.trace.output;
      output.stale.count += 1;
      output.stale.at = at;
      output.stale.reasons[label] = (output.stale.reasons[label] ?? 0) + 1;
      output.stale.lastReason = label;
    }
    recordEvent('avatar.preset.transport.stale', { reason: label, at });
    return 0;
  }

  /** Low-frequency autonomous idle boundary. Never samples a sentence gap without playback. */
  function maybeAutoPreset(now) {
    if (state.presets.enabled !== true) return null;
    // Observability only: the gates below are the real filtering points of the idle draw. Each
    // blocking episode is reported ONCE (see `notePresetGateSkip`), never per 30 Hz tick.
    const event = PRESET_EVENT_BY_STATE[state.status] ?? 'idle';
    if (state.presets.active.length > 0) {
      notePresetGateSkip('busy', `busy:preset:${state.presets.seq}`, event, now);
      return null;
    }
    if (state.status === 'speaking') {
      notePresetGateSkip('busy', 'busy:speaking', event, now);
      return null;
    }
    if (state.intents.some((item) => item.done !== true)) {
      notePresetGateSkip('busy', `busy:intent:${state.intentSeq}`, event, now);
      return null;
    }
    // D: semantic actions and the autonomous idle draw have separate clocks. A real semantic
    // start keeps the idle boundary quiet for a short window WITHOUT moving `nextDecisionAt`; the
    // semantic action itself already went through the normal selection/arbitration path.
    if (Number.isFinite(state.presets.lastSemanticAt)
      && now - state.presets.lastSemanticAt < PRESET_SEMANTIC_QUIET_MS) {
      notePresetGateSkip('busy', `semantic-recent:${state.presets.lastSemanticAt}`, event, now);
      return null;
    }
    if (state.presets.nextDecisionAt === null) {
      state.presets.nextDecisionAt = now + PRESET_EXECUTION.DECISION_MIN_MS
        + (PRESET_EXECUTION.DECISION_MAX_MS - PRESET_EXECUTION.DECISION_MIN_MS) * state.presets.random();
      return null;
    }
    if (now < state.presets.nextDecisionAt) {
      notePresetGateSkip('throttled', `throttled:${state.presets.nextDecisionAt}`, event, now);
      return null;
    }
    const result = preset({
      state: state.status,
      event,
      at: now,
      generation: state.presets.generation,
      seed: Math.floor(state.presets.random() * 0x1_0000_0000),
    });
    const wait = PRESET_EXECUTION.DECISION_MIN_MS
      + (PRESET_EXECUTION.DECISION_MAX_MS - PRESET_EXECUTION.DECISION_MIN_MS) * state.presets.random();
    state.presets.nextDecisionAt = now + wait + (result.started === true ? result.durationMs : 0);
    return result;
  }

  function cancelPreset({ fadeMs = 240, at = undefined, reason = 'cancel' } = {}) {
    const now = Number.isFinite(at) ? at : clockNow();
    if (state.presets.active.length === 0) {
      return { ok: false, reason: 'no-active-preset', cancelled: 0, at: now };
    }
    const fade = Math.max(1, Math.min(2000, finite(fadeMs, 240)));
    let cancelled = 0;
    for (const item of state.presets.active) {
      if (item.cancelledAt !== null) continue;
      item.cancelledAt = now;
      item.cancelFadeMs = fade;
      item.trace.interrupt = { reason: String(reason), at: now, fadeMs: fade };
      cancelled += 1;
    }
    if (cancelled > 0) recordEvent('avatar.preset.cancel', { reason: String(reason), fadeMs: fade, count: cancelled });
    return { ok: cancelled > 0, cancelled, fadeMs: fade, at: now };
  }

  function clearPresets(reason = 'clear', { fadeMs = 0, at = undefined, throughGeneration = null } = {}) {
    const now = Number.isFinite(at) ? at : clockNow();
    const fade = Math.max(0, finite(fadeMs, 0));
    let removed = 0;
    let faded = 0;
    for (let index = state.presets.active.length - 1; index >= 0; index -= 1) {
      const item = state.presets.active[index];
      if (throughGeneration !== null && Number.isInteger(item.generation)
        && item.generation > throughGeneration) continue;
      if (fade > 0) {
        if (item.cancelledAt === null) {
          item.cancelledAt = now;
          item.cancelFadeMs = fade;
          item.trace.interrupt = { reason: String(reason), at: now, fadeMs: fade };
          faded += 1;
        }
        continue;
      }
      state.presets.active.splice(index, 1);
      item.done = true;
      finishPresetTrace(item, now, { interrupted: true });
      removed += 1;
    }
    state.presets.generation += 1;
    if (removed > 0 || faded > 0) {
      recordEvent('avatar.preset.cleared', {
        reason: String(reason), removed, faded, throughGeneration, at: now,
      });
    }
    return { ok: true, removed, faded, at: now };
  }

  function presetsSnapshot() {
    // One clone shared by lastTrace/currentTrace: a status snapshot must not copy a live trace twice.
    const livePresetTrace = state.presets.active.length === 0
      ? null
      : clonePresetTrace(state.presets.active[state.presets.active.length - 1].trace);
    return {
      enabled: state.presets.enabled,
      starts: state.presets.starts,
      takeovers: state.presets.takeovers,
      holds: state.presets.holds,
      selected: state.presets.selected,
      dropped: state.presets.dropped,
      generation: state.presets.generation,
      capabilities: {
        channels: presetCapabilityChannels(),
        nativeOwned: [...PRESET_NATIVE_CHANNELS],
        targetVerified: state.presets.capabilities.targetVerified,
        directionVerified: state.presets.capabilities.directionVerified,
      },
      overrides: JSON.parse(JSON.stringify(presetOverridesValue())),
      active: state.presets.active.map((item) => ({
        /** Identity of THIS trajectory: a late send result is matched against it, never adoption. */
        seq: item.seq,
        generation: item.generation,
        presetId: item.presetId,
        family: item.family,
        recipe: item.recipe,
        variant: item.variant,
        /** The phase this action was started for (`thinking` / `idle` / `answer-start` / …). */
        event: item.event,
        operations: [...item.operations],
        channels: [...item.channels],
        /** Answer-start takeover: what this action is fading out, and what it still owns. */
        yieldedChannels: [...item.yieldChannels],
        keptChannels: item.channels.filter((channel) => !item.yieldChannels.has(channel)),
        yieldFadeMs: item.yieldFadeMs,
        releasedChannels: [...item.yieldedReleased],
        startedAt: item.startedAt,
        durationMs: item.durationMs,
        remainingMs: Math.max(0, item.durationMs - ((state.lastAt ?? 0) - item.startedAt)),
        cancelled: item.cancelledAt !== null,
      })),
      /**
       * Sender evidence across the controller life. The five phases stay separate: only an
       * acknowledged, still-current send increments `committed`.
       */
      transport: {
        prepared: state.presets.transport.prepared,
        attempted: state.presets.transport.attempted,
        committed: state.presets.transport.committed,
        failed: state.presets.transport.failed,
        stale: state.presets.transport.stale,
        lastAt: state.presets.transport.lastAt,
        lastError: state.presets.transport.lastError,
        lastErrorCode: state.presets.transport.lastErrorCode,
        lastStaleReason: state.presets.transport.lastStaleReason,
      },
      lastSelection: state.presets.lastSelection === null
        ? null : JSON.parse(JSON.stringify(state.presets.lastSelection)),
      /**
       * The newest trace: while an action is still running this is its LIVE trace (the same object
       * also exposed as `currentTrace`), otherwise the last completed/hold trace. Older tests and
       * the host read this field after a short window, so a running action must never look empty.
       */
      lastTrace: livePresetTrace ?? clonePresetTrace(state.presets.lastTrace),
      /** The live three-layer trace while a preset is still executing (null when idle). */
      currentTrace: livePresetTrace,
      /** Channels still being written by the release window after a preset ended/cancelled. */
      releasing: [...state.releases]
        .filter(([, entry]) => String(entry.kind).startsWith('preset:'))
        .map(([channel, entry]) => ({
          channel, kind: entry.kind, atMs: entry.atMs, frames: entry.frames,
        })),
      /**
       * Decision projection (status.live2d.runtime.motion.presets): the last select/skip/commit
       * and the counters that answer "did the idle preset really run, and what filtered it out".
       * `config.presetDebugEvents:false` silences the EVENTS only; this object is always maintained.
       */
      debug: {
        enabled: state.presets.enabled,
        decisions: state.presets.debug.decisions,
        holds: state.presets.holds,
        skips: state.presets.debug.skips,
        lastPresetId: state.presets.debug.lastPresetId,
        lastEvent: state.presets.debug.lastEvent,
        lastAt: state.presets.debug.lastAt,
        selectorKey: state.presets.selectorKey,
        /** Last action only: `{lastActionId, lastCommitCount, lastEvent}` (no full history). */
        byAction: {
          lastActionId: state.presets.debug.byAction.lastActionId,
          lastCommitCount: state.presets.debug.byAction.lastCommitCount,
          lastEvent: state.presets.debug.byAction.lastEvent,
        },
      },
      recent: state.presets.recent.map((trace) => clonePresetTrace(trace)),
      /** D: timestamp of the last real semantic start (read-only; the idle quiet window uses it). */
      lastSemanticAt: state.presets.lastSemanticAt,
      /**
       * Selection memory is bounded and read-only here. Only a started trajectory appends; hold,
       * refusal and cancellation never do. `history` completes legacy entries through the catalog
       * inside the selector (unknown ids stay unknown).
       */
      selectionMemory: {
        history: state.presets.history.map((entry) => ({ ...entry })),
        recentFamilies: [...state.presets.recentFamilies],
        recentActions: [...state.presets.recentActions],
        recentRecipes: [...state.presets.recentRecipes],
      },
      /**
       * Blink ownership is reported, not changed: the continuous base blink layer keeps running
       * and a preset blink is a second writer on the same eye channels. This evidence is NOT part
       * of the idle-diversity count.
       */
      blinkLayers: {
        baseline: { active: true, note: 'continuous base blink layer' },
        preset: {
          starts: state.presets.blinkStarts,
          active: state.presets.active.some((item) => (
            (item.operations ?? []).some((operation) => operation === 'blink' || operation === 'double-blink')
          )),
        },
        dualDrive: state.presets.active.some((item) => (
          (item.operations ?? []).some((operation) => operation === 'blink' || operation === 'double-blink')
        )),
      },
    };
  }


  /**
   * Stage-3 dimension preference for one intent variant. Texture/expressiveness favour the
   * replacements that differ most from the neutral middle; restraint favours the small one;
   * composure favours the longer delivery. Weights only, never a different intent.
   */
  function intentVariantWeight(item, traits) {
    if (traits === null || traits === undefined) return 1;
    const texture = clamp01(finite(traits.texture, 0.5));
    const expression = clamp01(finite(traits.expressiveness, 0.5));
    const restraint = clamp01(finite(traits.restraint, 0.5));
    const liveliness = clamp01(finite(traits.liveliness, 0.5));
    const composure = clamp01(finite(traits.composure, 0.5));
    const size = Math.abs(finite(item.amplitude, 1) - 1) / 0.15;
    const speed = Math.abs(finite(item.duration, 1) - 1) / 0.2;
    const amplitudeBias = (finite(item.amplitude, 1) - 1) * 8;
    const durationBias = (finite(item.duration, 1) - 1) * 4;
    const weight = 1
      + 0.32 * texture * Math.min(1, size + speed)
      + 0.24 * expression * amplitudeBias
      - 0.20 * restraint * amplitudeBias
      + 0.18 * liveliness * speed
      + 0.14 * composure * durationBias;
    return Math.max(0.05, weight);
  }

  function pickWeightedVariant(list, weightOf, randomValue) {
    const weights = list.map(item => Math.max(0, weightOf(item)));
    const total = weights.reduce((sum, value) => sum + value, 0);
    if (!(total > 0)) return list[list.length - 1];
    let threshold = clamp01(finite(randomValue, 0)) * total;
    for (let index = 0; index < list.length; index += 1) {
      threshold -= weights[index];
      if (threshold < 0) return list[index];
    }
    return list[list.length - 1];
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
    const traits = state.traits ?? null;
    const previous = state.variant.last[kind];
    // A repeat is impossible back-to-back: the previous variant's weight is zeroed, so the seeded
    // draw is still reproducible but can never return the same replacement twice in a row.
    const variant = pickWeightedVariant(
      list,
      item => (list.length > 1 && item.id === previous ? 0 : intentVariantWeight(item, traits)),
      clamp01(finite(stream(), 0)),
    );
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
    const effects = traitEffects();
    const occasional = gestureProfile !== null;
    const variant = pickIntentVariant(action, { deep: occasional });
    const application = STYLE_DIMENSION_APPLICATION;
    const baseDurationMs = action === 'surprise'
      ? Math.round(520 / scaled.tempo)
      : Math.round(scaled.nodDurationMs / scaled.tempo);
    // All six PLAN dimensions reach the gesture through `effects`: expression/composure lengthen
    // or shorten the active phase, and the seeded variant adds its own delivery difference.
    const durationScale = (application.durationBase + application.durationSpan * dims.softness)
      * (1 + application.livelinessTempo - 2 * application.livelinessTempo * dims.liveliness)
      * effects.duration
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
      * effects.amplitude
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
   *
   * `keepActive` is the ONE non-destructive mode: a same-reply turn continuation has already
   * retired the staged/expired intent at the host layer (generation + pending slot), and the
   * trajectories still running belong to that reply's own gesture. They, and the expression layer
   * driving the same pose, are kept and finish naturally; no clearance event is emitted. Every
   * real stop (interrupt/barge-in, lock, model switch, disconnect, teardown) keeps the default.
   */
  function clearIntents({
    reason = 'invalidate', throughGeneration = null, at = undefined, keepActive = false,
  } = {}) {
    const now = Number.isFinite(at) ? at : clockNow();
    if (keepActive === true) {
      const keptIntents = state.intents.filter((item) => item.done !== true).length;
      const keptPresets = state.presets.active.filter((item) => item.done !== true).length;
      const axes = [];
      for (const item of state.intents) {
        if (item.done === true) continue;
        for (const channel of item.channels) if (!axes.includes(channel)) axes.push(channel);
      }
      for (const item of state.presets.active) {
        if (item.done === true) continue;
        for (const channel of item.channels) if (!axes.includes(channel)) axes.push(channel);
      }
      axes.sort((left, right) => CHANNELS.indexOf(left) - CHANNELS.indexOf(right));
      recordEvent('avatar.intent.trajectory.kept', {
        reason: String(reason ?? 'invalidate'),
        keptIntents,
        keptPresets,
        presetClear: { removed: 0, faded: 0 },
        axes,
        at: now,
      });
      return {
        ok: true,
        cleared: 0,
        kept: keptIntents,
        presetActive: keptPresets,
        presets: { removed: 0, faded: 0 },
        axes,
        remainingMs: 0,
        at: now,
      };
    }
    // A generation switch also drops the autonomous expression layer: no old gaze/brow offset may
    // survive onto the pose of the next turn.
    clearExpressions(`intents:${String(reason ?? 'invalidate')}`);
    // A barge-in is a smooth exit; a model/lock/generation switch is a hard stop. Neither may ever
    // let a late trajectory contribute to the next turn (the preset list is the only owner). The
    // host names a user interruption both `interrupt` and `barge-in`, and both must fade: a bare
    // `barge-in` used to be removed in one frame because only the word "interrupt" matched.
    const presetFade = SMOOTH_INTERRUPT_REASON.test(String(reason)) ? SMOOTH_INTERRUPT_FADE_MS : 0;
    clearPresets(reason, { fadeMs: presetFade, at: now });
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
    // Motion presets ride the SAME write set as explicit intents: the executor computes their
    // trajectory on the one pose, so while a trajectory is active its channels must be flushable.
    // Without this the preset is computed (and used to be reported as committed) but never sent.
    for (const item of state.presets.active) {
      if (now < item.startedAt) continue;
      if (item.cancelledAt !== null && now - item.cancelledAt >= Math.max(1, item.cancelFadeMs)) continue;
      for (const channel of item.channels) set.add(channel);
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
    // Motion presets are symbolic trajectories on the SAME additive fold. They are never rewritten
    // into nod/tilt/lookAtUser intents: the operations keep their own order, channels and timing.
    const preset = presetFrame(now);
    for (const channel of Object.keys(adds)) adds[channel] += finite(preset.adds[channel], 0);
    return {
      adds,
      gaze,
      eyeOpen,
      eyeClose: preset.eye,
      /** Non-additive centre blends, applied after arbitration in tick(). */
      centers: preset.centers,
      expressionGaze: {
        x: finite(expression.gaze.x, 0) + finite(preset.gaze.x, 0),
        y: finite(expression.gaze.y, 0) + finite(preset.gaze.y, 0),
      },
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
    const headXAmp = idleEnabled ? 0.09 * idleChannelSway('headX') * speakingHead : 0;
    const headYAmp = idleEnabled ? 0.09 * idleChannelSway('headY') * 0.7 * speakingHead : 0;
    const headZAmp = idleEnabled ? 0.075 * idleChannelSway('headZ') : 0;
    const bodyAmp = idleEnabled ? 0.03 * idleChannelSway('bodyX') * (frame.speaking ? 0.8 : 1) : 0;
    const gazeXAmp = 0.03 * idleChannelSway('gazeX') * gazeDrift;
    const gazeYAmp = 0.02 * idleChannelSway('gazeY') * gazeDrift;
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
        ? gazeXAmp * axis('gazeX') + (thinking ? 0.05 * idleChannelSway('gazeX') : 0) + finite(expressionGaze.x, 0)
        : 0,
      gazeY: idleEnabled
        ? gazeYAmp * axis('gazeY') + (thinking ? -0.02 * idleChannelSway('gazeY') : 0) + finite(expressionGaze.y, 0)
        : 0,
      // A thinking pause adds a shallow micro-nod; it is part of the same idle base, not a write.
      headX: headXAmp * axis('headX')
        + (thinking ? 0.02 * idleChannelSway('headX') * smoothNoise1(hash32(motionSeed, 'think'), t * 0.8) : 0)
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
    const activeComponent = motion.posture.component;
    if (activeComponent !== null) {
      // Evidence for the component layer: the pose-unit target, the semantic 30°-unit target, and
      // the mixed head contribution after the persona/status gain (before the writer's own cap).
      // The final published pose is attached by tick() after the spring, so this can be compared
      // with the actual transport rows.
      activeComponent.observed = {
        at: state.lastAt,
        target: { ...activeComponent.axes },
        semantic: { ...activeComponent.semantic },
        mixed: {
          headX: headXAmp * finite(activeComponent.axes.headX, 0),
          headY: headYAmp * finite(activeComponent.axes.headY, 0),
          headZ: headZAmp * finite(activeComponent.axes.headZ, 0),
        },
      };
    }

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
    // Autonomous preset boundary: the low-frequency idle draw. A hold result writes nothing.
    maybeAutoPreset(now);
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
    // A preset blink writes the eye-open value itself; it is applied after the surprise widening
    // so a preset closure always wins, while the blink machine still applies its own factor.
    if (intent.eyeClose !== null && intent.eyeClose !== undefined) {
      if (Number.isFinite(intent.eyeClose.left)) frame.pose.eyeOpenL = clamp01(intent.eyeClose.left);
      if (Number.isFinite(intent.eyeClose.right)) frame.pose.eyeOpenR = clamp01(intent.eyeClose.right);
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
    // Centre operations are a bounded blend to the CURRENT natural baseline (the active posture
    // component included), applied AFTER the idle arbitration. Applying a frozen/live additive
    // here instead would subtract the idle base twice and overshoot when another trajectory moved.
    for (const [channel, entry] of Object.entries(intent.centers ?? {})) {
      const wave = clamp01(finite(entry.wave, 0));
      if (wave <= 0) continue;
      const base = finite(composed[channel], 0);
      const target = finite(entry.target, base);
      const next = base + (target - base) * wave;
      composed[channel] = isBidirectional(channel) ? clampSigned(next) : clamp01(next);
    }
    // The roll is held to the same 14° head budget as the other head channels on the SEMANTIC
    // pose, before the spring and long before the input value: the target itself is capped, so the
    // gesture keeps its smooth shape instead of being truncated on the wire.
    composed.headZ = clampHeadRoll(composed.headZ);
    const pose = applyDynamics(composed, frame, dt);
    publish(pose);
    const activeComponent = state.motion.posture.component;
    if (activeComponent?.observed) {
      activeComponent.observed.idle = {
        headX: state.idle.headX,
        headY: state.idle.headY,
        headZ: state.idle.headZ,
      };
      activeComponent.observed.pose = {
        headX: pose.headX,
        headY: pose.headY,
        headZ: pose.headZ,
      };
    }
    notePresetComputed(pose);
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
    // A barge-in clears the posture component as well as the pose it was riding on. The target/base
    // are reset so the old component goal cannot re-converge on the next tick; a later moved
    // decision may select a fresh component, never resume the old one.
    const motion = state.motion;
    motion.posture.component = null;
    motion.posture.componentPaused = true;
    motion.posture.target = Object.fromEntries(MOTION_AXES.map((axis) => [axis, 0]));
    motion.posture.base = Object.fromEntries(MOTION_AXES.map((axis) => [axis, 0]));
    motion.transition = null;

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
  function postureComponentSnapshot() {
    const component = state.motion.posture.component;
    if (component === null) return null;
    return {
      id: component.id,
      label: component.label,
      startedAt: component.startedAt,
      holdUntil: component.holdUntil,
      durationMs: component.durationMs,
      remainingMs: Math.max(0, component.holdUntil - (state.lastAt ?? 0)),
      amplitude: component.amplitude,
      channels: [...component.channels],
      target: { ...component.axes },
      semantic: { ...component.semantic },
      observed: component.observed === null ? null : {
        at: component.observed.at,
        target: { ...(component.observed.target ?? {}) },
        semantic: { ...(component.observed.semantic ?? {}) },
        mixed: { ...(component.observed.mixed ?? {}) },
        idle: component.observed.idle === undefined ? null : { ...component.observed.idle },
        pose: component.observed.pose === undefined ? null : { ...component.observed.pose },
      },
    };
  }

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
        /** P-139 stage 3: legacy expression dimensions (exact shape kept for older consumers). */
        dimensions: { ...state.dimensions },
        /**
         * P-139 stage 3: the full PLAN dimension set (liveliness / softness / restraint /
         * expressiveness / attention / composure / texture) and the derived effect multipliers.
         * Read-only projection; it never feeds back into the style itself.
         */
        traits: { ...state.traits },
        effects: { ...traitEffects() },
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
          componentTransitions: state.motion.posture.componentTransitions,
          stills: state.motion.posture.stills,
          lastDecision: state.motion.posture.lastDecision,
          lastTransition: state.motion.posture.lastTransition === null
            ? null : { ...state.motion.posture.lastTransition, axes: [...state.motion.posture.lastTransition.axes] },
          component: postureComponentSnapshot(),
          componentPaused: state.motion.posture.componentPaused,
          componentHistory: state.motion.posture.componentHistory.map((entry) => ({ ...entry })),
          lastComponentTransition: state.motion.posture.lastComponentTransition === null
            ? null : {
                ...state.motion.posture.lastComponentTransition,
                axes: [...state.motion.posture.lastComponentTransition.axes],
              },
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
        /**
         * Motion preset execution: selection evidence, the bounded three-layer trace, active
         * symbolic trajectories and the user overrides in force. See presets/README.md.
         */
        presets: presetsSnapshot(),
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
    // Motion preset execution: selection, execution, interruption and the proof-bearing state.
    selectPreset,
    startPreset,
    preset,
    cancelPreset,
    clearPresets,
    setPresetExecution,
    setPresetCapabilities,
    setPresetOverrides,
    presetsSnapshot,
    /** Read-only: report a boundary the host skipped itself (e.g. `busy`); nothing is drawn. */
    notePresetSkip,
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
    /** Sender acknowledgement: the rows it really built / the channels it refused, with reasons. */
    notePresetTransport: (report) => notePresetTransport(report),
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
  PRESET_EXECUTION,
  PRESET_GESTURE_GAIN,
  PRESET_EVENT_BY_STATE,
  PRESET_EVENT_FOR_PHASE,
  PRESET_OPERATION_PROFILE,
};
