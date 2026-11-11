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
// The HEAD component only claims the verified head channels. Body/arm components are a separate
// layer (see the phase-4 section): they have their own streams, windows and verified gate, so
// neither layer can silently claim the other's channels just because a model happens to map them.
//
// WHICH component is drawn is persona-weighted (see `postureComponentWeights`): the persona is a
// soft probability bias, not a fixed template, and the existing no-repeat rule still applies.
export const POSTURE_COMPONENT_CHANNELS = Object.freeze(['headX', 'headY', 'headZ']);

/** A component is held for this window. A persona may stretch/shrink it, always inside the band. */
export const POSTURE_COMPONENT_MIN_MS = 10_000;
export const POSTURE_COMPONENT_MAX_MS = 20_000;

/**
 * Semantic amplitude band of one component. ONE SEMANTIC UNIT = 30° (the writer's documented
 * convention), so 0.15–0.40 = 4.5–12°. The band is deliberately kept close to the cap: the
 * component target must still be recognisable after the live persona/status gain is folded in.
 * The cap is applied to the COMPONENT TARGET after the gain is known; this layer never multiplies a
 * global "visibility" gain on top of the instant output (base micro-motion stays as light as before).
 */
export const POSTURE_COMPONENT_MIN_AMPLITUDE = 0.15;
export const POSTURE_COMPONENT_MAX_AMPLITUDE = 0.40;

/**
 * Trial degree targets per component axis, BEFORE the live persona gain is cancelled. These are
 * the starting points, not a universal standard: ordinary posture is 5–12°, a deliberate lean or
 * look-back is allowed to sit near the top of that band. headX and headZ deliberately use
 * different values: a yaw turn and a roll lean are not the same physical motion.
 *
 * The per-axis model range is applied separately (`HEAD_CHANNEL_DEGREE_LIMITS`), never by reusing
 * headX's ±30° range for headZ.
 */
export const POSTURE_COMPONENT_DEGREE_BANDS = Object.freeze({
  natural: Object.freeze({
    headX: Object.freeze({ min: 1, max: 2 }),
    headY: Object.freeze({ min: 0, max: 0 }),
    headZ: Object.freeze({ min: 5, max: 8 }),
  }),
  'lean-left': Object.freeze({
    headX: Object.freeze({ min: 1, max: 3 }),
    headY: Object.freeze({ min: 0, max: 0 }),
    headZ: Object.freeze({ min: 8, max: 12 }),
  }),
  'lean-right': Object.freeze({
    headX: Object.freeze({ min: -3, max: -1 }),
    headY: Object.freeze({ min: 0, max: 0 }),
    headZ: Object.freeze({ min: -12, max: -8 }),
  }),
  'look-back': Object.freeze({
    headX: Object.freeze({ min: 8, max: 12 }),
    headY: Object.freeze({ min: 0, max: 3 }),
    headZ: Object.freeze({ min: 2, max: 5 }),
  }),
});

/**
 * Per-axis safety ranges for head angles. headX/headY are the documented ±30° VTS tracking
 * ranges; headZ (FaceAngleZ) is ±90° and must NOT be clamped by the yaw/pitch budget.
 */
export const HEAD_CHANNEL_DEGREE_LIMITS = Object.freeze({
  headX: 30,
  headY: 30,
  headZ: 90,
});

/**
 * A component target is expressed as a pose-unit offset inserted into the SAME `posture.target` the
 * base posture uses. Cancelling a quiet persona's small gain needs a larger offset (semantic target
 * / live gain), so the offset may exceed 1. It is bounded here so a near-zero gain cannot produce an
 * unbounded internal number; the semantic target itself is still capped by
 * POSTURE_COMPONENT_MAX_AMPLITUDE. `POSTURE_COMPONENT_TARGET_LIMIT` is the post-add bound for the
 * combined base + component goal (base stays in ±1, so it only leaves room for the offset).
 */
export const POSTURE_COMPONENT_AXIS_LIMIT = 1024;
export const POSTURE_COMPONENT_TARGET_LIMIT = 1100;

/**
 * The phase-1 component library. `headX/headY/headZ` are normalized shape weights: the selected
 * amplitude (semantic units, ≤0.15) is converted to that axis's own pose unit through the live
 * persona gain, so the target stays semantic-bounded instead of depending on a hard-coded scale.
 * Every non-zero weight is kept well above the old 0.18–0.28 trace range, so an accompanying axis
 * remains a recognisable part of the held pose instead of rounding away to ≈0.2°.
 */
export const POSTURE_COMPONENTS = Object.freeze([
  Object.freeze({ id: 'natural', label: '自然', headX: 0.03, headY: 0, headZ: 0.25 }),
  Object.freeze({ id: 'lean-left', label: '左侧倾', headX: 0.35, headY: 0, headZ: 1 }),
  Object.freeze({ id: 'lean-right', label: '右侧倾', headX: -0.35, headY: 0, headZ: -1 }),
  Object.freeze({ id: 'look-back', label: '偏头/回看', headX: 1, headY: 0.45, headZ: 0.55 }),
]);


// ---------------------------------------------------------------------------------------------
// Phase 3 — a SECOND, independent component: gaze (head posture component + gaze component)
// ---------------------------------------------------------------------------------------------
//
// Scope (explicit, do not over-read this layer):
//   - this is the HEAD + GAZE component layer; body/shoulder/arm components are phase 4 below;
//   - breath stays VTS-native, and the gaze component never writes body/arm channels;
//   - this plugin still does not start/stop VTS's own idle animation, so the native idle may
//     coexist and which one wins visually is unverified;
//   - real visual appearance has NOT been verified on a real VTS model.
//
// A gaze component is held independently of the head component (its own 6–12 s window and its own
// seeded draw), but it is written ONLY when BOTH gazeX and gazeY bindings are `verified` and its
// channel ownership is `plugin`. An explicit channelMap declaration is never proof: the runtime
// facade sets this gate from the verified takeover set, and an unverified/native-possible gaze is
// left to VTS (no write at all).
export const POSTURE_GAZE_COMPONENT_CHANNELS = Object.freeze(['gazeX', 'gazeY']);

/** Independent gaze hold band. A persona may stretch/shrink the draw inside this band only. */
export const POSTURE_GAZE_COMPONENT_MIN_MS = 6_000;
export const POSTURE_GAZE_COMPONENT_MAX_MS = 10_000;

/**
 * Semantic amplitude band of the gaze component, in the SAME 30°-per-unit convention the head
 * component uses: 0.12 = 3.6° EQUIVALENT. This is a semantic cap, not a measured eye rotation:
 * the VTS gaze inputs are normalized (±1), so 0.12 is 12 % of the eye range. The writer's own
 * `intentWriteValue` limit (gaze ±1) is wider, so this component cap is the binding bound.
 */
export const POSTURE_GAZE_COMPONENT_MIN_AMPLITUDE = 0.08;
export const POSTURE_GAZE_COMPONENT_MAX_AMPLITUDE = 0.12;

/**
 * Shape weights of one gaze component. Only the two verified gaze channels are used; a `value` is
 * `weight × amplitude`, clamped per channel to the 0.12 semantic cap, so a shape can never ask for
 * more than the component budget. The four directions are deliberately distinct so two consecutive
 * holds are visibly different; `gaze-center` is a still, zero-value hold that keeps the verified
 * gaze channels owned and written (0), so a previous direction is actively released instead of
 * sticking.
 */
export const POSTURE_GAZE_COMPONENTS = Object.freeze([
  Object.freeze({ id: 'gaze-left', label: '左看', gazeX: -1, gazeY: 0 }),
  Object.freeze({ id: 'gaze-right', label: '右看', gazeX: 1, gazeY: 0 }),
  Object.freeze({ id: 'gaze-up', label: '上看', gazeX: 0, gazeY: 1 }),
  Object.freeze({ id: 'gaze-down', label: '下看', gazeX: 0, gazeY: -1 }),
  // A still centre: the eyes return to the held baseline and stay there. It is a real component
  // shape (own hold window, own anti-repeat slot), not "no component".
  Object.freeze({ id: 'gaze-center', label: '中心/少动', gazeX: 0, gazeY: 0 }),
]);


// ---------------------------------------------------------------------------------------------
// Phase 4 — generic BODY / SHOULDER / ARM / HAND capability
// ---------------------------------------------------------------------------------------------
//
// The three layers every model is offered, independent of whether the current model maps them:
//
//   base       a slow, tiny body + shoulder/arm/hand drift on the SAME 30 Hz tick as breathing
//              and the head sway (no second timer). A channel whose mapping is not verified is
//              simply never written — the generator still exists, the transport refuses the row.
//   component  one independent held pose per CATEGORY (body posture / shoulder posture / arm &
//              hand posture), each with its own window and seeded draw. It rides on the base, so
//              the base keeps moving while a component is held. A gesture yields the component
//              contribution locally (the same INTENT_IDLE_RATIO rule the head layer uses).
//   expression `wave` / `spread` / `shrug` (plus the existing nod/tilt/surprise). Missing the
//              semantic core (an arm for a wave, a shoulder for a shrug) is reported as
//              `unsupported`; a head-only project can never fake a wave with a head roll.
//
// Everything is semantic: 1 unit = 30° for body/arm angles under the writer's documented
// convention, and the writer maps the value through the verified input's own min/max. Direction
// (which sign raises an arm) is model-specific and is therefore TRUE-MACHINE UNVERIFIED; only the
// verified mapping and the clamp/rate limits are proven here.
export const BODY_ARM_CHANNELS = Object.freeze([
  'bodyX',
  'bodyY',
  'bodyZ',
  'shoulderL',
  'shoulderR',
  'armL',
  'armR',
  'handL',
  'handR',
]);

/**
 * Every channel a preset may write, including the body/shoulder/arm layer. The legacy
 * `CHANNELS` table predates that layer, so using it alone here silently excluded arm/hand
 * channels from the post-preset reset — the exact "hand stays raised" symptom.
 */
const PRESET_SETTLE_CHANNELS = new Set([...CHANNELS, ...BODY_ARM_CHANNELS]);

/**
 * Per-channel semantic safety limits. Body angles share the ±30° body-input convention (±1);
 * shoulders and hands are deliberately narrower because their model parameters differ wildly.
 * The writer still applies the input's own min/max, so this is a semantic budget, not a range.
 */
export const BODY_ARM_CHANNEL_LIMITS = Object.freeze({
  bodyX: 1,
  bodyY: 1,
  bodyZ: 1,
  shoulderL: 0.7,
  shoulderR: 0.7,
  armL: 1,
  armR: 1,
  handL: 0.8,
  handR: 0.8,
});

/**
 * Base-activity span in DEGREES for the channels this layer newly drives. bodyX is deliberately 0:
 * the existing posture controller already supplies the bodyX base sway (`bodyAmp × axis('bodyX')`),
 * so adding it again would double the roll. 1 semantic unit = 30°.
 */
export const BODY_ARM_BASE_DEGREES = Object.freeze({
  bodyX: 0,
  bodyY: 0.35,
  bodyZ: 0.55,
  shoulderL: 0.30,
  shoulderR: 0.30,
  armL: 0.45,
  armR: 0.45,
  handL: 0.30,
  handR: 0.30,
});

/** One semantic step a single frame may move a non-spring body/arm channel (≈1.8° at 30 Hz). */
export const BODY_ARM_MAX_STEP = 0.06;

export const BODY_ARM_COMPONENT_MIN_MS = 8_000;
export const BODY_ARM_COMPONENT_MAX_MS = 14_000;
export const BODY_ARM_COMPONENT_MIN_AMPLITUDE = 0.12;
export const BODY_ARM_COMPONENT_MAX_AMPLITUDE = 0.40;

/** Independent component categories: one hold each, never one shared head/body vector. */
export const BODY_ARM_COMPONENT_CATEGORIES = Object.freeze({
  body: Object.freeze(['bodyX', 'bodyY', 'bodyZ']),
  shoulder: Object.freeze(['shoulderL', 'shoulderR']),
  arm: Object.freeze(['armL', 'armR', 'handL', 'handR']),
});

/**
 * Shape library. Weights are normalized semantic ratios inside the drawn amplitude, so the same
 * shape is usable on a model that maps only one of its channels. Missing channels are dropped at
 * draw time; the remaining ones still form a recognisable pose.
 */
export const BODY_ARM_COMPONENTS = Object.freeze({
  body: Object.freeze([
    Object.freeze({ id: 'weight-left', label: '重心左移', bodyX: -0.80, bodyY: 0.10, bodyZ: -0.50 }),
    Object.freeze({ id: 'weight-right', label: '重心右移', bodyX: 0.80, bodyY: 0.10, bodyZ: 0.50 }),
    Object.freeze({ id: 'lean-back', label: '后靠', bodyX: 0, bodyY: -0.80, bodyZ: 0.15 }),
    Object.freeze({ id: 'lean-forward', label: '前倾', bodyX: 0, bodyY: 0.80, bodyZ: -0.10 }),
    Object.freeze({ id: 'side-left', label: '左侧身', bodyX: -0.30, bodyY: 0, bodyZ: 0.90 }),
    Object.freeze({ id: 'side-right', label: '右侧身', bodyX: 0.30, bodyY: 0, bodyZ: -0.90 }),
  ]),
  shoulder: Object.freeze([
    Object.freeze({ id: 'shoulder-drop-left', label: '左肩放松', shoulderL: -0.85, shoulderR: -0.10 }),
    Object.freeze({ id: 'shoulder-drop-right', label: '右肩放松', shoulderL: -0.10, shoulderR: -0.85 }),
    Object.freeze({ id: 'shoulder-raise-left', label: '左肩抬起', shoulderL: 0.85, shoulderR: 0.10 }),
    Object.freeze({ id: 'shoulder-raise-right', label: '右肩抬起', shoulderL: 0.10, shoulderR: 0.85 }),
    Object.freeze({ id: 'shoulder-level', label: '双肩平放', shoulderL: 0, shoulderR: 0 }),
  ]),
  arm: Object.freeze([
    Object.freeze({ id: 'arms-rest', label: '手臂自然下垂', armL: -0.30, armR: -0.30, handL: -0.10, handR: -0.10 }),
    Object.freeze({ id: 'arm-left-open', label: '左臂张开', armL: 0.85, armR: -0.10, handL: 0.40 }),
    Object.freeze({ id: 'arm-right-open', label: '右臂张开', armL: -0.10, armR: 0.85, handL: 0.40 }),
    Object.freeze({ id: 'both-arms-open', label: '双臂张开', armL: 0.70, armR: 0.70, handL: 0.25, handR: 0.25 }),
    Object.freeze({ id: 'hands-fold', label: '手收拢', armL: -0.20, armR: -0.20, handL: -0.50, handR: -0.50 }),
  ]),
});

/**
 * Semantic targets of the body/arm expressions. `core` is the KEY part: without any of it the
 * action is `unsupported` (never silently remapped onto the head). The rest are companions that
 * are simply skipped when unverified — a one-armed model can still wave with that arm.
 */
export const BODY_ARM_INTENT_TARGETS = Object.freeze({
  wave: Object.freeze(['armL', 'armR', 'handL', 'handR', 'shoulderL', 'shoulderR']),
  spread: Object.freeze(['armL', 'armR', 'handL', 'handR', 'shoulderL', 'shoulderR']),
  shrug: Object.freeze(['shoulderL', 'shoulderR', 'armL', 'armR']),
});

export const BODY_ARM_GESTURES = Object.freeze({
  wave: Object.freeze({
    label: '挥手',
    core: Object.freeze(['armL', 'armR']),
    amplitude: 0.55,
    durationMs: 960,
    armGain: 1,
    handGain: 0.9,
    shoulderGain: 0.30,
  }),
  spread: Object.freeze({
    label: '摊手',
    core: Object.freeze(['armL', 'armR']),
    amplitude: 0.50,
    durationMs: 900,
    armGain: 0.9,
    handGain: 0.55,
    shoulderGain: 0.20,
  }),
  shrug: Object.freeze({
    label: '耸肩',
    core: Object.freeze(['shoulderL', 'shoulderR']),
    amplitude: 0.50,
    durationMs: 820,
    armGain: 0.25,
    handGain: 0.10,
    shoulderGain: 1,
  }),
});

/** Delivery variants for the new expressions (same seed discipline as the four legacy kinds). */
export const BODY_ARM_INTENT_VARIANTS = Object.freeze({
  wave: Object.freeze([
    Object.freeze({ id: 'wave-small', amplitude: 0.92, duration: 0.94 }),
    Object.freeze({ id: 'wave-wide', amplitude: 1.10, duration: 1.08 }),
  ]),
  spread: Object.freeze([
    Object.freeze({ id: 'spread-small', amplitude: 0.92, duration: 0.98 }),
    Object.freeze({ id: 'spread-wide', amplitude: 1.08, duration: 1.10 }),
  ]),
  shrug: Object.freeze([
    Object.freeze({ id: 'shrug-light', amplitude: 0.90, duration: 0.94 }),
    Object.freeze({ id: 'shrug-deep', amplitude: 1.08, duration: 1.08 }),
  ]),
});

/** The intent channel table including the body/arm expressions (legacy entries unchanged). */
export const intentTargetsFor = (kind) => INTENT_CHANNEL_TARGETS[String(kind ?? '')]
  ?? BODY_ARM_INTENT_TARGETS[String(kind ?? '')]
  ?? undefined;

/** Channel targets for one intent, profile included (confused brows only apply to the legacy tilt). */
export const intentChannelsForAny = (kind, profile = null) => (
  INTENT_CHANNEL_TARGETS[String(kind ?? '')] === undefined
    ? [...(BODY_ARM_INTENT_TARGETS[String(kind ?? '')] ?? [])]
    : intentChannelsFor(kind, profile)
);


// ---------------------------------------------------------------------------------------------
// Persona → component SELECTION (soft weights, never a fixed template)
// ---------------------------------------------------------------------------------------------
//
// The head/gaze component layers used to sample their shape uniformly and only let the persona
// change duration/transition. That made a shy, a lively and a composed avatar pick the SAME shape
// distribution. The tables below turn the persona dimensions (`state.traits`) and the optional
// behavioural classification (`state.style.expression`) into POSITIVE weights per shape:
//
//   - a weight changes only the next draw's PROBABILITY; it never disables a shape, so a quiet
//     persona can still draw `natural` and a lively one can still draw it (soft floor);
//   - the anti-repeat rule is unchanged: a roll that lands on the current shape is re-drawn among
//     the other shapes, so the weighted result can never be a back-to-back repeat;
//   - weights are multiplicative and every shape keeps a floor, so no persona is a hard template
//     and two similar personas still overlap substantially;
//   - all randomness stays on the controller's existing seeded component streams. The same
//     seed+style reproduces the same trajectory; a different style re-weights the same roll.
//
// A persona dimension or tendency that is absent contributes 0, which is neutral (the factor is
// 1). The tendencies are read from `style.expression` only; they never rewrite the numeric fields.
/** No shape is ever unreachable: every selection weight keeps this positive floor. */
export const COMPONENT_SELECTION_WEIGHT_FLOOR = 0.05;

const componentTrait = (traits, name) => clamp01(finite(traits?.[name], 0.5));

const readComponentExpression = (expression) => {
  const source = expression !== null && typeof expression === 'object' ? expression : {};
  return {
    tender: clamp01(finite(source.tender, 0)),
    playful: clamp01(finite(source.playful, 0)),
    shy: clamp01(finite(source.shy, 0)),
    composed: clamp01(finite(source.composed, 0)),
  };
};

const floorComponentWeight = (value) => Math.max(COMPONENT_SELECTION_WEIGHT_FLOOR, value);

/**
 * Soft selection weights for the four head components.
 *
 *   lively / playful   leans + look-back up, natural down
 *   soft / tender      natural + look-back up (and a gentler amplitude/hold bias below)
 *   shy                look-back strongly up, a side lean up, natural still present
 *   composed           natural/lean up, look-back down (plus a longer hold, so it switches less)
 *
 * Every returned weight is > 0. The caller multiplies nothing else: the persona biases the DRAW,
 * while the existing semantic/axis caps and the preset arbitration remain the hard bounds.
 *
 * @param {object} [traits] `state.traits`
 * @param {object|null} [expression] `state.style.expression`
 * @returns {{natural: number, 'lean-left': number, 'lean-right': number, 'look-back': number}}
 */
export function postureComponentWeights(traits, expression) {
  const liveliness = componentTrait(traits, 'liveliness');
  const softness = componentTrait(traits, 'softness');
  const restraint = componentTrait(traits, 'restraint');
  const expressiveness = componentTrait(traits, 'expressiveness');
  const attention = componentTrait(traits, 'attention');
  const composure = componentTrait(traits, 'composure');
  const texture = componentTrait(traits, 'texture');
  const { tender, playful, shy, composed } = readComponentExpression(expression);
  const natural = 1
    * (1 - 0.55 * liveliness)
    * (1 + 0.85 * softness)
    * (1 + 0.30 * restraint)
    * (1 - 0.20 * expressiveness)
    * (1 + 0.15 * attention)
    * (1 + 0.20 * composure)
    * (1 - 0.10 * texture)
    * (1 + 0.85 * tender)
    * (1 - 0.55 * playful)
    * (1 + 0.10 * shy)
    * (1 + 0.40 * composed);
  const lean = 1
    * (1 + 0.90 * liveliness)
    * (1 - 0.10 * softness)
    * (1 - 0.10 * restraint)
    * (1 + 0.20 * expressiveness)
    * (1 + 0.35 * attention)
    * (1 + 0.25 * composure)
    * (1 + 0.10 * texture)
    * (1 + 0.15 * tender)
    * (1 + 0.60 * playful)
    * (1 + 0.30 * shy)
    * (1 + 0.40 * composed);
  const lookBack = 1
    * (1 + 0.55 * liveliness)
    * (1 + 0.60 * softness)
    * (1 - 0.20 * restraint)
    * (1 + 0.30 * expressiveness)
    * (1 + 0.55 * attention)
    * (1 - 0.35 * composure)
    * (1 + 0.30 * texture)
    * (1 + 0.50 * tender)
    * (1 + 0.70 * playful)
    * (1 + 2.00 * shy)
    * (1 - 0.50 * composed);
  return Object.freeze({
    natural: floorComponentWeight(natural),
    'lean-left': floorComponentWeight(lean),
    'lean-right': floorComponentWeight(lean),
    'look-back': floorComponentWeight(lookBack),
  });
}

/**
 * Soft selection weights for the gaze components. `gaze-center` is the restful option, not a
 * disabled direction: shy/playful can still look away, and composed can still glance.
 *
 *   attention high     side/up up, down/centre down => more eye movement
 *   shy                down + side up, up down, centre kept available
 *   playful            up + side up
 *   composed / tender  centre/down up, hold longer and amplitude biased lower => less movement
 *
 * @param {object} [traits] `state.traits`
 * @param {object|null} [expression] `state.style.expression`
 * @returns {{'gaze-left': number, 'gaze-right': number, 'gaze-up': number, 'gaze-down': number,
 *            'gaze-center': number}}
 */
export function gazeComponentWeights(traits, expression) {
  const liveliness = componentTrait(traits, 'liveliness');
  const softness = componentTrait(traits, 'softness');
  const restraint = componentTrait(traits, 'restraint');
  const attention = componentTrait(traits, 'attention');
  const composure = componentTrait(traits, 'composure');
  const texture = componentTrait(traits, 'texture');
  const { tender, playful, shy, composed } = readComponentExpression(expression);
  const side = 1
    * (1 + 0.30 * liveliness)
    * (1 + 0.60 * attention)
    * (1 - 0.20 * composure)
    * (1 - 0.10 * restraint)
    * (1 + 0.10 * texture)
    * (1 + 0.15 * tender)
    * (1 + 0.50 * playful)
    * (1 + 0.35 * shy)
    * (1 + 0.10 * composed);
  const up = 1
    * (1 + 0.35 * liveliness)
    * (1 + 0.45 * attention)
    * (1 - 0.30 * softness)
    * (1 - 0.25 * composure)
    * (1 + 0.10 * texture)
    * (1 + 0.85 * playful)
    * (1 - 0.25 * shy)
    * (1 - 0.20 * composed);
  const down = 1
    * (1 + 0.45 * softness)
    * (1 - 0.15 * attention)
    * (1 + 0.15 * composure)
    * (1 - 0.35 * liveliness)
    * (1 + 0.35 * tender)
    * (1 - 0.40 * playful)
    * (1 + 0.55 * shy)
    * (1 + 0.10 * composed);
  const center = 1
    * (1 - 0.30 * liveliness)
    * (1 + 0.15 * softness)
    * (1 + 0.30 * composure)
    * (1 - 0.15 * attention)
    * (1 + 0.10 * tender)
    * (1 - 0.30 * playful)
    * (1 - 0.10 * shy)
    * (1 + 0.35 * composed);
  return Object.freeze({
    'gaze-left': floorComponentWeight(side),
    'gaze-right': floorComponentWeight(side),
    'gaze-up': floorComponentWeight(up),
    'gaze-down': floorComponentWeight(down),
    'gaze-center': floorComponentWeight(center),
  });
}

/**
 * The persona's amplitude/hold bias for a component draw. It is deliberately separate from the
 * SELECTION weights: selection chooses which shape, this chooses how strong/long that shape is.
 * `amplitudeExponent` shapes the existing uniform [MIN, MAX] draw (1 = unchanged, >1 = gentler,
 * <1 = more emphatic); `holdFactor` stretches the existing hold inside the band. Both are soft and
 * bounded, and neither touches base micro-motion.
 *
 * @param {object} [traits]
 * @param {object|null} [expression]
 * @returns {{amplitudeExponent: number, holdFactor: number}}
 */
export function personaComponentBias(traits, expression) {
  const liveliness = componentTrait(traits, 'liveliness');
  const softness = componentTrait(traits, 'softness');
  const composure = componentTrait(traits, 'composure');
  const { tender, playful, shy, composed } = readComponentExpression(expression);
  const gentle = 0.55 * (softness - 0.5) + 0.45 * tender + 0.30 * composed + 0.20 * shy;
  const dynamic = 0.55 * (liveliness - 0.5) + 0.45 * playful;
  return Object.freeze({
    amplitudeExponent: Math.max(0.55, Math.min(2.4, 1 + 1.5 * gentle - 1.1 * dynamic)),
    holdFactor: Math.max(0.70, Math.min(1.35,
      1 + 0.22 * (composure - 0.5) + 0.14 * (softness - 0.5) - 0.12 * (liveliness - 0.5)
        + 0.18 * composed + 0.10 * tender + 0.06 * shy - 0.12 * playful)),
  });
}

/**
 * Draw one shape from a positive weight map. The first roll is over the FULL pool, so the same
 * seed/persona maps a roll to a shape as directly as possible. Only when that roll lands on the
 * shape that is already held does a second weighted roll pick among the other shapes: the existing
 * "no two consecutive identical holds" contract is kept without changing every non-repeat draw.
 */
function weightedComponentEntry(entries, rand) {
  let total = 0;
  for (const entry of entries) total += entry.weight;
  let roll = Math.max(0, Math.min(0.999999999999, finite(rand(), 0))) * total;
  for (const entry of entries) {
    if (roll < entry.weight) return entry.item;
    roll -= entry.weight;
  }
  return entries[entries.length - 1].item;
}

function drawWeightedComponent({ pool, weights, currentId, rand }) {
  const entries = pool.map((item) => ({
    item,
    weight: Math.max(COMPONENT_SELECTION_WEIGHT_FLOOR, finite(weights?.[item.id], 1)),
  }));
  const first = weightedComponentEntry(entries, rand);
  if (currentId === null || first.id !== currentId) return first;
  // A back-to-back repeat is not a new hold: re-draw among the other shapes, preserving the
  // weighted preference and the existing seeded stream (one extra roll, as before).
  const others = entries.filter((entry) => entry.item.id !== currentId);
  return others.length > 0 ? weightedComponentEntry(others, rand) : first;
}


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
 * Phase 2 base activity: one head-channel change below this (pose units, 1 = 30°) is not counted as
 * "the head really moved". 1e-6 ≈ 0.00003°, well under one rendered pixel of head rotation, but
 * above floating-point noise on a held/zero curve. It is deliberately small enough that the slow
 * continuous drift counts as real base activity in status.
 */
const HEAD_ACTIVITY_EPSILON = 1e-6;

/**
 * Phase 2 scope (explicit): this observability block only REPORTS the activity that already exists
 * and the channel ownership. The phase-4 body/arm writer is a separate, verified-only layer; it
 * never turns this evidence into a second writer. VTS's own idle animation stays ON: this plugin
 * never calls Start/StopIdleAnimation, so a native blink/breath/head/arm motion can coexist with
 * these writes and which one wins visually is unproven until a real-VTS check.
 */


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
 * The head-roll safety bound in SEMANTIC units (1 unit = 30°). This is the model's own ±90° roll
 * range, deliberately separate from the 14° expression budget: a preset lean may use the roll's
 * real range while an expression stays small. It is capped HERE, on the semantic pose, before the
 * writer: the input layer is never used as the clamp.
 */
const HEAD_ROLL_CAP = HEAD_CHANNEL_DEGREE_LIMITS.headZ / OCCASIONAL_ACTION.DEGREES_PER_POSE_UNIT;


/** Clamp a semantic head-roll value to the model's ±90° roll range. */
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
 * A channel `add` below this semantic size (0.05 = 1.5°) is an autonomous micro-expression
 * (thinking nod / gaze drift / weight shift), not a gesture. The same-channel yield rule
 * (`INTENT_IDLE_RATIO`) is meant for a GESTURE: applying it to a 0.1° expression erased the whole
 * idle base and a deliberately held 10° component for the expression window (the observed "idle
 * collapses to ~0" case), so a micro-expression is added instead of replacing the idle layer.
 * Plain intents are floored at ≥4°, presets at ≥10°, so only autonomous micro-motion lands here.
 */
export const IDLE_YIELD_MIN_GESTURE = 0.05;


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
  DEGREES: 1.1,
  FREQUENCY_HZ: 0.04,
});


/** Item 4: conversation-end relax. The posture decays to the base over 2–4 s, never in one step. */
export const RELAX_PLAN = Object.freeze({
  MIN_MS: 2_000,
  MAX_MS: 4_000,
  BASE_MS: 3_000,
});


/** Gain on the idle posture curve with a normal persona (amplitude 1); see advanceGenerators. */
export const POSTURE_REACH = 1.5;


/**
 * BASE ACTIVITY — the idle layer's OWN amplitude, in DEGREES (peak from the posture centre at
 * status `idle`, persona amplitude 1 and `idleSwayScale` 1). This is deliberately separate from
 * the component target degrees (`POSTURE_COMPONENT_DEGREE_BANDS`): a held component asks for its
 * own 5–12°, while the base sway keeps its much smaller span underneath it. One layer must never
 * be derived from the other, and neither is a "global visibility gain".
 *
 * The span is what a normal persona should visibly do while idle: headX ≈ 1.8° p2p, headY ≈ 3°
 * p2p, headZ ≈ 2° p2p once the hold drift is added. These are trial values, not measured angles
 * (the writer's convention is 1 semantic unit = 30°).
 */
export const BASE_ACTIVITY_DEGREES = Object.freeze({
  headX: 1.35,
  headY: 1.6,
  headZ: 1.4,
});

/**
 * Persona amplitude (0.2–1.5) → base-activity multiplier. The base layer is not a gesture: a
 * quiet persona must still move visibly, and a lively one may move a little more. The mapping is
 * applied ONCE (the old chain multiplied the persona amplitude twice, so a 0.45 persona kept only
 * 0.2 of its base sway). Ordering is preserved: quiet < normal < lively.
 */
export const BASE_ACTIVITY_PERSONA_SCALE = Object.freeze({ MIN: 0.8, MAX: 1.0 });


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

/**
 * Post-preset settle (autonomous action tail).
 *
 * A completed/cancelled preset used to leave its channels to the release window or to the held
 * posture component the moment the trajectory left the active list. The visible result was "the
 * gesture ended, but the avatar stayed in that pose". This tail changes only the TEMPORARY offset,
 * never the natural baseline:
 *
 *   - it is created only for channels the finished action really wrote (`item.written`) and the
 *     capability proof marked verified; native channels and absolute eye-open are never included;
 *   - the channel task cancels the action's OWN temporary contribution, captured before the item
 *     leaves the active list. The dynamic base (breath, micro-motion, blink, idle sway) keeps
 *     running and the final output is the natural baseline — eyes are never driven to 0;
 *   - the curve is a quintic Hermite from (offset, velocity) to (0, 0): it continues from the
 *     pose AND velocity that really existed, decelerates first, and lands with zero velocity, so
 *     it never reverses on the last frame;
 *   - 500–1000 ms covers a short action; a larger offset / velocity extends the window under the
 *     explicit distance and deceleration bounds (`MAX_MS`), never by a hidden amplitude gain;
 *   - a held posture component whose axes the action wrote is released to the natural stance over
 *     the same window, while the base activity continues;
 *   - a new preset/intent/expression on a channel starts a short `TAKEOVER_FADE_MS` blend from the
 *     CURRENT actual offset, and the old settle is then removed. It can never overwrite the new
 *     action later.
 */
export const PRESET_SETTLE = Object.freeze({
  MIN_MS: 500,
  DEFAULT_MS: 720,
  /** Upper bound only for a LARGE offset/speed; a short action stays inside 500–1000 ms. */
  MAX_MS: 2400,
  /** Distance / speed limits used to extend the short window (semantic units). */
  DISTANCE_SPEED: 0.6,
  VELOCITY_DECEL: 2.0,
  /** Cross-fade when a newer owner claims a channel mid-settle. */
  TAKEOVER_FADE_MS: 180,
});


const DEFAULT_CONFIG = Object.freeze({
  computeHz: TIMING.COMPUTE_HZ,
  flushIntervalMs: TIMING.FLUSH_INTERVAL_MS,
  injectTimeoutMs: TIMING.INJECT_TIMEOUT_MS,
  mouthStepMs: TIMING.MOUTH_STEP_MS,
  // Text envelopes are already shaped low by buildSpeechLevels; explicit audio/lip-sync levels
  // keep their raw 0..1 value, so this gain stays neutral for callers that supply levels.
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
  /**
   * Phase 3 gaze component hold window (6–12 s), independently configurable. It is deliberately
   * shorter than the head component so the eyes can move on while the head keeps its lean.
   */
  postureGazeComponentMinMs: POSTURE_GAZE_COMPONENT_MIN_MS,
  postureGazeComponentMaxMs: POSTURE_GAZE_COMPONENT_MAX_MS,
  /**
   * Seed/config gate for the gaze component. The pure controller defaults to FALSE: a caller that
   * does not know the verified takeover set must not silently write gaze. The avatar-runtime facade
   * sets it through `setComponentGazeVerified()` from `gazeX`+`gazeY` verified bindings only.
   */
  componentGazeVerified: false,
  /**
   * Verified body/arm channels (bodyX/Y/Z, shoulderL/R, armL/R, handL/R). Empty by default: a pure
   * controller must not claim a body/arm channel before the facade has proved the mapping. The
   * runtime sets this from its verified takeover set on every mapping change.
   */
  bodyArmVerified: null,
  /** Independent body / shoulder / arm component hold windows (own band, not the head band). */
  bodyComponentMinMs: BODY_ARM_COMPONENT_MIN_MS,
  bodyComponentMaxMs: BODY_ARM_COMPONENT_MAX_MS,
  /** Per-frame semantic step for the non-spring body/arm channels (position/velocity bound). */
  bodyArmMaxStep: BODY_ARM_MAX_STEP,
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
  /** User-editable catalog loaded from `<root>/avatar/presets/presets.json`; null = built-ins. */
  presetCatalog: null,
  /**
   * Answer-start takeover cross-fade (item 5). Configurable inside [120, 240] ms; a value outside
   * that window makes the takeover unavailable instead of silently clamping it to a snap or a
   * long dissolve.
   */
  presetTakeoverFadeMs: PRESET_TAKEOVER.FADE_MS,
  /**
   * Short-action post-preset window (500–1000 ms); a large offset/velocity extends it under the
   * explicit distance/velocity bounds up to `PRESET_SETTLE.MAX_MS`. 0 disables the tail.
   */
  presetSettleMs: PRESET_SETTLE.DEFAULT_MS,
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
   * Planned roll peak. The final semantic pose still has the ±90° roll safety bound; leaving room for the
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
 * Human-visible degree targets for complete head operations. These are TRIAL starting points,
 * not a universal standard: an ordinary preset lands in 10–20°, while a lean / look-back /
 * expressive operation is allowed a larger, per-operation band instead of one shared 45° figure.
 * `headX` and `headZ` are separate axes with separate safety ranges; the executor still applies
 * model headroom and records the final target it could really plan.
 */
export const PRESET_OPERATION_DEGREE_RANGES = Object.freeze({
  'head-turn': Object.freeze({ min: 14, max: 20 }),
  'head-tilt': Object.freeze({ min: 13, max: 18 }),
  'head-lower': Object.freeze({ min: 13, max: 18 }),
  'head-lift': Object.freeze({ min: 13, max: 18 }),
  nod: Object.freeze({ min: 13, max: 18 }),
  'double-nod': Object.freeze({ min: 13, max: 18 }),
  shake: Object.freeze({ min: 14, max: 22 }),
  /** A deliberate lean: larger than ordinary, still bounded by the roll's own range. */
  'head-sway': Object.freeze({ min: 18, max: 28 }),
});

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

/**
 * Mouth chunk continuity. A TTS chunk boundary is a DECODE boundary, not a pause: a new envelope
 * that starts within this window of the previous chunk's end is appended to the SAME envelope
 * clock instead of resetting `startedAt`/the level index. A real pause (longer than this) still
 * takes the normal release path, which lets the mouth close; explicit cancel always closes at once.
 * No extra smoothing is added here — the existing 200 ms release cross-fade stays the only tail.
 */
const MOUTH_CHUNK_CONTINUITY_MS = 150;

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
    /** Planned signed target angles; headX/headZ use their own ranges. */
    targetDegrees: { ...(stage.degreeTargets ?? {}) },
    degreeClamps: Object.fromEntries(Object.entries(stage.degreeClamps ?? {})
      .map(([channel, entry]) => [channel, { ...entry }])),
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
        targetDegrees: { ...(stage.targetDegrees ?? {}) },
        degreeClamps: Object.fromEntries(Object.entries(stage.degreeClamps ?? {})
          .map(([channel, entry]) => [channel, { ...entry }])),
      })),
      channels: [...(trace.output?.channels ?? [])],
      droppedChannels: [...(trace.output?.droppedChannels ?? [])],
      samples: (trace.output?.samples ?? []).map((sample) => ({
        ...sample,
        channels: { ...(sample.channels ?? {}) },
      })),
      /** The controller's own pose (never a commit) and the rows the sender really built. */
      computed: { ...(trace.output?.computed ?? {}) },
      computedDegrees: { ...(trace.output?.computedDegrees ?? {}) },
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
  if (chars.length === 0) return Array.from({ length: count }, () => 0);
  let previous = 0.12;
  return Array.from({ length: count }, (_, index) => {
    const ch = chars[Math.min(chars.length - 1, Math.floor((index * chars.length) / count))];
    const raw = mouthOpenness(ch);
    // A 100 ms slice is short enough that a hard jump reads as a mechanical flap. Ease toward the
    // new vowel/consonant instead of resetting the visible aperture every slice.
    previous = raw * 0.68 + previous * 0.32;
    return clamp01(previous);
  });
}

/** Kana/Latin/Han openness buckets; no pinyin dependency is generated here. */
function mouthOpenness(ch) {
  if (typeof ch !== 'string' || ch.length === 0) return 0;
  if (/[，。！？、；：,.!?;:…—-]/u.test(ch)) return 0.025;
  const cp = ch.codePointAt(0) ?? 0;
  // Japanese kana: use the vowel row as a cheap, deterministic mouth-open cue.
  const rows = [
    ['あかさたなはまやらわがざだばぱぁゃ', 0.58],
    ['いきしちにひみりぎじぢびぴぃ', 0.28],
    ['うくすつぬふむゆるぐずづぶぷぅゅ', 0.38],
    ['えけせてねへめれげぜでべぺぇ', 0.44],
    ['おこそとのほもよろをごぞどぼぽぉょ', 0.52],
  ];
  for (const [row, level] of rows) if (row.includes(ch)) return level;
  // Latin vowels/consonants: only the vowel carries a wide aperture.
  const lower = ch.toLowerCase();
  if ('aæɑ'.includes(lower)) return 0.52;
  if ('eɛ'.includes(lower)) return 0.38;
  if ('iɪ'.includes(lower)) return 0.25;
  if ('oɔ'.includes(lower)) return 0.48;
  if ('uʊ'.includes(lower)) return 0.34;
  if (/^[a-z]$/u.test(lower)) return 0.18;
  // Han: without a pinyin/audio dependency there is no true final, so keep the range narrow and
  // low instead of turning every character into a nearly-full open mouth.
  if (cp >= 0x3400 && cp <= 0x9fff) return 0.22 + ((cp % 19) / 18) * 0.18;
  // Emoji/other symbols are not speech; hold a small neutral aperture.
  return 0.16;
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
  // The phase-3 gaze component has its OWN stream too: adding the second component must not shift
  // the head component / base-posture sequence a recorded trajectory already pins.
  const gazeComponentRandom = createSeededRandom(
    `${cfg.seed === undefined ? 'default' : String(cfg.seed)}:gaze-component`,
  );
  // Body / shoulder / arm components keep INDEPENDENT streams: adding a third component layer must
  // not shift the head/gaze trajectory (or the base posture) an existing recording already pins.
  const bodyComponentRandom = Object.freeze({
    body: createSeededRandom(`${cfg.seed === undefined ? 'default' : String(cfg.seed)}:body-component`),
    shoulder: createSeededRandom(`${cfg.seed === undefined ? 'default' : String(cfg.seed)}:shoulder-component`),
    arm: createSeededRandom(`${cfg.seed === undefined ? 'default' : String(cfg.seed)}:arm-component`),
  });
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
  const postureGazeComponentMinMs = Math.max(
    POSTURE_GAZE_COMPONENT_MIN_MS,
    Math.min(POSTURE_GAZE_COMPONENT_MAX_MS, finite(
      cfg.postureGazeComponentMinMs,
      POSTURE_GAZE_COMPONENT_MIN_MS,
    )),
  );
  const postureGazeComponentMaxMs = Math.max(
    postureGazeComponentMinMs,
    Math.min(POSTURE_GAZE_COMPONENT_MAX_MS, finite(
      cfg.postureGazeComponentMaxMs,
      POSTURE_GAZE_COMPONENT_MAX_MS,
    )),
  );
  const bodyComponentMinMs = Math.max(
    BODY_ARM_COMPONENT_MIN_MS,
    Math.min(BODY_ARM_COMPONENT_MAX_MS, finite(
      cfg.bodyComponentMinMs,
      BODY_ARM_COMPONENT_MIN_MS,
    )),
  );
  const bodyComponentMaxMs = Math.max(
    bodyComponentMinMs,
    Math.min(BODY_ARM_COMPONENT_MAX_MS, finite(
      cfg.bodyComponentMaxMs,
      BODY_ARM_COMPONENT_MAX_MS,
    )),
  );
  const bodyArmMaxStep = Math.max(0.001, finite(cfg.bodyArmMaxStep, BODY_ARM_MAX_STEP));
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
    /**
     * Last envelope kept for ONE short post-end window. A chunk boundary that arrives after the
     * previous chunk's end tick can still append to the same clock instead of resetting; an
     * explicit end/interrupt clears it, and a real pause beyond the window lets it expire.
     */
    speechContinuity: null,
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
     * Phase 2 base activity — READ-ONLY evidence advanced by the SAME frame loop as the generators.
     * There is no extra timer and nothing is persisted: a restart starts at zero. The counters mean
     * exactly:
     *   blinkCount    a real blink cycle STARTED (blink machine idle → closing, never a suppressed
     *                 blink on an already-closed eye);
     *   breathCycles  a breath phase wrapped past 2π while breathing was enabled;
     *   headMotionMs  accumulated dt (ms) of frames in which at least one idle head channel really
     *                 changed (by more than HEAD_ACTIVITY_EPSILON);
     *   lastAt        timestamp of the last frame that was allowed to advance the counters;
     *   state         'running' | 'paused' (generators deliberately still) | 'stopped' (host gate);
     *   enabled       host gate; a privacy lock / disconnect / disposed runtime sets it false so a
     *                 still-computed pose can never keep the activity counters moving.
     * `presetHeld` is projected in snapshot() from the last preset selection; a hold / no-candidate
     * decision never pauses these counters (the base layer keeps running through a held preset).
     */
    baseActivity: {
      blinkCount: 0,
      breathCycles: 0,
      headMotionMs: 0,
      lastAt: null,
      state: 'stopped',
      enabled: true,
      /** Previous tick's idle head values; internal only, never exposed. */
      previousHead: null,
    },
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
        /**
         * Phase 3 gaze component: a second, independent hold that contributes to the gaze base only.
         * `value` is semantic (±0.12, 1 unit = 30° equivalent), never a posture-target offset. It is
         * cleared by interrupt/relax and written only while `componentGazeVerified` is true.
         */
        gazeComponent: null,
        gazeComponentTransitions: 0,
        gazeComponentHistory: [],
        gazeComponentPaused: false,
        /** Verified + ownership gate. False by default; the facade sets it from verified bindings. */
        componentGazeVerified: cfg.componentGazeVerified === true,
        /**
         * Phase 4: the generic body/shoulder/arm/hand layer. `verified` is the ONLY gate; the
         * generators always exist, but a channel outside this set contributes 0 and is never
         * sent. The three components are independent holds with their own streams and windows.
         */
        bodyArms: {
          verified: new Set(
            (Array.isArray(cfg.bodyArmVerified) ? cfg.bodyArmVerified : [])
              .map((channel) => String(channel))
              .filter((channel) => BODY_ARM_CHANNELS.includes(channel)),
          ),
          components: { body: null, shoulder: null, arm: null },
          transitions: { body: 0, shoulder: 0, arm: 0 },
          history: { body: [], shoulder: [], arm: [] },
          lastTransition: { body: null, shoulder: null, arm: null },
          paused: false,
          /** Per-frame evidence: base / component / mixed / clamped values (read-only). */
          base: {},
          component: {},
          mixed: {},
          clamped: {},
          /** Last expression refused for a missing semantic core, and the session count. */
          lastUnsupported: null,
          unsupported: 0,
        },
      },
      /**
       * Phase 3 unified arbitration evidence (read-only). The newest values describe the last frame
       * where a same-channel conflict was really arbitrated. `componentYield` is the fraction of the
       * head/gaze component contribution that survived after a preset took the channel: 1 means no
       * conflict, 0.2 is the INTENT_IDLE_RATIO floor. It is evidence, never a target.
       */
      arbitration: {
        at: null,
        presetActive: 0,
        head: [],
        gaze: [],
      },
      /** Phase 3: old preset EXIT/cancel tails suppressed by a newer owner on the same channel. */
      presetArbitration: { at: null, suppressed: [] },
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
      /** Adjacent TTS chunks appended to the SAME envelope clock (no reset at the chunk edge). */
      continuations: 0,
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
      /**
       * Post-preset settle-to-center. One bounded entry per channel the finished action really
       * wrote (see PRESET_SETTLE): it is overlaid on the natural base for at most one window, then
       * the base/component takes the channel back. `entries` is bounded by the pose channel table.
       */
      settle: {
        entries: new Map(),
        /**
         * The one posture-component release owned by the tail: the component axes the finished
         * action wrote are walked back to the natural stance while the base keeps running.
         */
        componentRelease: null,
        starts: 0,
        completed: 0,
        /** Channels handed to a newer preset/intent/expression before the window ended. */
        takeovers: 0,
        componentReleases: 0,
        lastStartedAt: null,
        lastCompletedAt: null,
        lastTakeoverAt: null,
        lastComponentReleaseAt: null,
      },
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

  /**
   * One per-axis pose clamp. headX/headY stay in the documented ±30° range, headZ uses its own
   * ±90° range, and every other bipolar channel keeps ±1. This is applied wherever the composed
   * pose is finalised, so a preset lean is not truncated by the yaw budget.
   */
  const clampHeadAxis = (channel, value) => {
    const limit = HEAD_CHANNEL_DEGREE_LIMITS[channel] === undefined
      ? 1
      : HEAD_CHANNEL_DEGREE_LIMITS[channel] / OCCASIONAL_ACTION.DEGREES_PER_POSE_UNIT;
    return clampMotion(value, limit);
  };
  const clampBipolarChannel = (channel, value) => (HEAD_CHANNEL_DEGREE_LIMITS[channel] === undefined
    ? clampSigned(value)
    : clampHeadAxis(channel, value));

  /** Semantic clamp for one body/arm channel; an unknown channel falls back to the signed range. */
  const clampBodyArm = (channel, value) => clampMotion(
    value,
    BODY_ARM_CHANNEL_LIMITS[channel] ?? 1,
  );
  /** True for the new body/arm channels (bipolar in VTS's semantic space). */
  const isBodyArmChannel = (channel) => BODY_ARM_CHANNEL_LIMITS[channel] !== undefined;
  /** One final semantic clamp shared by every writer path. */
  const clampSemanticChannel = (channel, value) => {
    if (isBodyArmChannel(channel)) return clampBodyArm(channel, value);
    return isBidirectional(channel) ? clampBipolarChannel(channel, value) : clamp01(value);
  };
  const bodyArmVerified = (channel) => state.motion.posture.bodyArms.verified.has(channel);
  /**
   * The automatic body/arm layer is opt-out, exactly like the head idle writer: zero sway scale
   * (`idleSwayScale: 0`) or zero idle amplitude (`idleAmplitude: 0`) means "this runtime must not
   * move on its own". Explicit intents (wave/spread/shrug) do NOT consult this gate: they are added
   * by `intentFrame()` after the base mix and stay fully executable.
   */
  function bodyArmAutomaticEnabled() {
    const sway = Math.max(0, finite(cfg.idleSwayScale, DEFAULT_CONFIG.idleSwayScale));
    const amplitude = finite(cfg.idleAmplitude, 1);
    return sway > 0 && amplitude > 0;
  }

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
   * The ONE balanced base-activity multiplier: the host's `idleSwayScale`, the persona amplitude
   * (mapped ONCE into a gentle 0.8–1.0 visibility band), the configured `postureReach` (still a
   * host knob, normalised by its default) and the status/relax scale exactly once. There is no
   * second `style.amplitude` factor here: the old chain multiplied the persona amplitude twice and
   * a 0.45 persona ended with 0.2 of the base span.
   *
   * This function NEVER carries a component target: `headBaseSemantic()` supplies the base span,
   * and the component target is its own explicit degree value on the component draw.
   */
  function idleChannelSway(channel) {
    const idleSwayScale = Math.max(0, finite(cfg.idleSwayScale, DEFAULT_CONFIG.idleSwayScale));
    const reach = Math.max(0, finite(cfg.postureReach, DEFAULT_CONFIG.postureReach))
      / Math.max(1e-6, POSTURE_REACH);
    const baseline = styleChannelAmplitude(state.style, channel);
    const amplitude = Math.max(0.2, Math.min(1.5, finite(baseline, 1)));
    const personaT = clamp01((amplitude - 0.2) / 1.3);
    const persona = BASE_ACTIVITY_PERSONA_SCALE.MIN
      + (BASE_ACTIVITY_PERSONA_SCALE.MAX - BASE_ACTIVITY_PERSONA_SCALE.MIN) * personaT;
    // Status/relax enter ONCE through the effective style: effective = baseline × modifier × relax.
    const effective = styleChannelAmplitude(state.effective ?? state.style, channel);
    const stateScale = baseline > 1e-9 ? clamp01(effective / baseline) : 1;
    return idleSwayScale * reach * persona * stateScale;
  }

  /**
   * The base activity span of one head axis in SEMANTIC units (1 = 30°). This is the generated
   * sway amplitude, NOT a component target: a component's 5–12° requirement is expressed directly
   * in degrees on its own draw and never multiplies this value to change its size.
   */
  function headBaseSemantic(channel) {
    const degrees = BASE_ACTIVITY_DEGREES[channel] ?? 0;
    return (degrees / OCCASIONAL_ACTION.DEGREES_PER_POSE_UNIT) * idleChannelSway(channel);
  }

  /**
   * Pose-unit offset that makes ONE component target ride the shared posture-axis trajectory.
   * This is a CANCELLATION of the base gain, not a second amplitude convention: the component's
   * own target stays the explicit semantic degree value. A later gain/status change is bounded by
   * the per-frame semantic cap in `advanceGenerators`; the explicit degree value remains the
   * target of record.
   */
  function componentPoseOffset(channel, targetSemantic) {
    const gain = headBaseSemantic(channel);
    if (!(gain > 1e-9)) return 0;
    return finite(targetSemantic, 0) / gain;
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
   *
   * `component === undefined` means "the component currently held": a base posture re-draw or a
   * short response action must ride ON TOP of the held component, not silently wipe it from the
   * target (the component lifetime owns its own 10–20 s window). Passing an explicit component
   * (including `null`) still overrides, which is how a fresh draw installs itself.
   */
  function targetWithComponent(base, component = undefined) {
    const active = component === undefined ? state.motion.posture.component : component;
    const next = {};
    for (const axis of MOTION_AXES) {
      const offset = active?.axes?.[axis] ?? 0;
      // The component offset may exceed one pose unit when it cancels a quiet persona's tiny
      // per-axis gain; the semantic cap is applied later to the contribution, not to this internal
      // offset. The base itself is still drawn inside ±1.
      next[axis] = clampMotion(finite(base?.[axis], 0) + offset, POSTURE_COMPONENT_TARGET_LIMIT);
    }
    return next;
  }

  /** One component draw: persona-weighted shape × persona-shaped semantic amplitude. */
  function drawPostureComponent(now) {
    const current = state.motion.posture.component;
    const weights = postureComponentWeights(state.traits, state.style.expression);
    const spec = drawWeightedComponent({
      pool: POSTURE_COMPONENTS,
      weights,
      currentId: current?.id ?? null,
      rand: componentRandom,
    });
    const bias = personaComponentBias(state.traits, state.style.expression);
    // The exponent only biases WHERE inside the explicit band the draw lands (a soft/tender/
    // composed persona leans low, a lively/playful one high). Quiet never drops below the band's
    // visible floor, and lively is still allowed to be visibly larger.
    const personaPosition = clamp01(0.5 + (1 - bias.amplitudeExponent) * 0.45);
    const degreeJitter = (componentRandom() - 0.5) * 0.08;
    const position = clamp01(personaPosition + degreeJitter);
    const drawMs = postureComponentMinMs
      + (postureComponentMaxMs - postureComponentMinMs) * componentRandom();
    // A persona tempo/composure may stretch or shrink the hold, but the 10–20 s band is the
    // contract: a slow persona never turns a component into a statue, a lively one never flickers.
    const influenced = drawMs * Math.max(0.8, Math.min(1.2,
      (1 / postureTempo()) * traitEffects().hold * bias.holdFactor));
    const holdMs = Math.max(postureComponentMinMs, Math.min(postureComponentMaxMs, influenced));
    const bands = POSTURE_COMPONENT_DEGREE_BANDS[spec.id] ?? {};
    const axes = {};
    const semantic = {};
    const targetDegrees = {};
    const saturated = {};
    let amplitude = 0;
    for (const channel of POSTURE_COMPONENT_CHANNELS) {
      const band = bands[channel] ?? { min: 0, max: 0 };
      const channelLimit = HEAD_CHANNEL_DEGREE_LIMITS[channel];
      // A negative band (right lean) must shrink in MAGNITUDE for a quiet persona: interpolate
      // from its smaller magnitude end (-8°) toward its larger one (-12°), not from -12° to -8°.
      const bandDegrees = band.min < 0
        ? band.max + (band.min - band.max) * position
        : band.min + (band.max - band.min) * position;
      const desiredDegrees = Math.max(-channelLimit, Math.min(channelLimit, bandDegrees));
      // The component's AMPLITUDE is this explicit semantic target; it is never re-derived from
      // the base sway gain. The pose-unit offset only lets the target ride the shared posture
      // transition (a cancellation of the base gain), so a quiet persona no longer needs an
      // enormous offset and a loud one is not amplified past its declared degrees.
      const targetSemantic = desiredDegrees / OCCASIONAL_ACTION.DEGREES_PER_POSE_UNIT;
      const requested = componentPoseOffset(channel, targetSemantic);
      axes[channel] = clampMotion(requested, POSTURE_COMPONENT_AXIS_LIMIT);
      saturated[channel] = Math.abs(requested) > POSTURE_COMPONENT_AXIS_LIMIT + 1e-9;
      // The published target is the component's own semantic value, after the explicit degree
      // band clamp. The live gain is cancelled by the pose-unit offset, and a later gain/status
      // change is bounded by the per-frame semantic cap in advanceGenerators (never by an
      // arbitrary global multiplier here).
      semantic[channel] = clampMotion(targetSemantic,
        POSTURE_COMPONENT_MAX_AMPLITUDE);
      // The writer's documented head convention is 1 semantic unit = 30°. This is the semantic
      // target angle BEFORE any transport-specific normalisation (the facade annotates the verified
      // input range separately and marks it unknown when no verified mapping exists).
      targetDegrees[channel] = semantic[channel] * OCCASIONAL_ACTION.DEGREES_PER_POSE_UNIT;
      amplitude = Math.max(amplitude, Math.abs(semantic[channel]));
    }
    amplitude = Math.min(POSTURE_COMPONENT_MAX_AMPLITUDE, amplitude);
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
      targetSemantic: { ...semantic },
      targetDegrees,
      targetDegreesBasis: 'semantic-30deg-per-unit (mapping-unverified)',
      /** The explicit trial bands this draw used, for status/evidence readers. */
      degreeBands: bands,
      axisLimit: POSTURE_COMPONENT_AXIS_LIMIT,
      saturated,
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
    // The initial draw must ALSO arrive through the 1.2–1.8 s planned path. Setting the target
    // directly would leave the rate-limited hold tracker (0.115/s) to crawl toward a multi-axis
    // component offset for tens of seconds — the exact "component looks frozen" case.
    startPostureTransition(next, now, { kind: 'component' });
    return component;
  }

  /**
   * One gaze-component draw. The gaze component does NOT feed `posture.target` (a head target must
   * never carry an eye value); it contributes to the gaze base only. Its amplitude is bounded in the
   * semantic 30°-unit convention and clamped per channel, so the component can never exceed 0.12.
   */
  function drawGazeComponent(now) {
    const current = state.motion.posture.gazeComponent;
    const weights = gazeComponentWeights(state.traits, state.style.expression);
    const spec = drawWeightedComponent({
      pool: POSTURE_GAZE_COMPONENTS,
      weights,
      currentId: current?.id ?? null,
      rand: gazeComponentRandom,
    });
    const bias = personaComponentBias(state.traits, state.style.expression);
    const drawnAmplitude = POSTURE_GAZE_COMPONENT_MIN_AMPLITUDE
      + (POSTURE_GAZE_COMPONENT_MAX_AMPLITUDE - POSTURE_GAZE_COMPONENT_MIN_AMPLITUDE)
        * Math.pow(gazeComponentRandom(), bias.amplitudeExponent);
    // The still centre has no amplitude: its semantic value is exactly 0. The normal directions
    // keep the drawn amplitude inside the 0.08–0.12 band.
    const amplitude = spec.id === 'gaze-center' ? 0 : drawnAmplitude;
    const drawMs = postureGazeComponentMinMs
      + (postureGazeComponentMaxMs - postureGazeComponentMinMs) * gazeComponentRandom();
    // The gaze hold stays inside its own 6–12 s band; persona tempo may stretch/shrink it there.
    const influenced = drawMs * Math.max(0.8, Math.min(1.2,
      (1 / postureTempo()) * traitEffects().hold * bias.holdFactor));
    const holdMs = Math.max(
      postureGazeComponentMinMs,
      Math.min(postureGazeComponentMaxMs, influenced),
    );
    const value = {};
    const degrees = {};
    for (const channel of POSTURE_GAZE_COMPONENT_CHANNELS) {
      const semantic = clampMotion(
        finite(spec[channel], 0) * amplitude,
        POSTURE_GAZE_COMPONENT_MAX_AMPLITUDE,
      );
      value[channel] = semantic;
      // 1 semantic unit = 30° (the same convention as the head component). This is an EQUIVALENT
      // angle, not a measured eye rotation; the VTS gaze input itself is normalized (±1).
      degrees[channel] = semantic * OCCASIONAL_ACTION.DEGREES_PER_POSE_UNIT;
    }
    return {
      id: spec.id,
      label: spec.label,
      startedAt: now,
      holdUntil: now + holdMs,
      durationMs: holdMs,
      amplitude,
      channels: [...POSTURE_GAZE_COMPONENT_CHANNELS],
      value,
      semantic: { ...value },
      degrees,
      /** Filled every output frame by advanceGenerators (component/gesture/yield evidence). */
      observed: null,
    };
  }

  function recordGazeComponent(component) {
    const history = state.motion.posture.gazeComponentHistory;
    history.push({
      id: component.id,
      label: component.label,
      startedAt: component.startedAt,
      durationMs: component.durationMs,
      amplitude: component.amplitude,
    });
    while (history.length > 8) history.shift();
  }

  /** Install one gaze component. It has no posture transition: the gaze follow itself smooths it. */
  function installGazeComponent(now) {
    const motion = state.motion;
    const component = drawGazeComponent(now);
    motion.posture.gazeComponent = component;
    motion.posture.gazeComponentPaused = false;
    recordGazeComponent(component);
    // A component now owns gaze: any old preset/expression release entry on those channels must be
    // handed off, otherwise a timed-out release could force a 0 over the new component.
    handOffReleases(POSTURE_GAZE_COMPONENT_CHANNELS);
    return component;
  }

  /**
   * Gaze component lifetime — checked on EVERY frame (not the 1 Hz head decision gate) so the two
   * components keep independent 6–12 s / 10–20 s windows even while a head transition is in flight.
   * There is still no extra timer and no second writer.
   */
  function stepGazeComponent(now) {
    const posture = state.motion.posture;
    if (posture.componentGazeVerified !== true) {
      if (posture.gazeComponent !== null) posture.gazeComponent = null;
      return null;
    }
    if (posture.gazeComponentPaused === true) return null;
    const component = posture.gazeComponent;
    if (component !== null && now < component.holdUntil) return component;
    const fresh = installGazeComponent(now);
    if (component !== null) posture.gazeComponentTransitions += 1;
    return fresh;
  }

  /** Drop both components (interrupt / relax) and freeze them until a later normal move resumes. */
  function pausePostureComponents() {
    const posture = state.motion.posture;
    posture.component = null;
    posture.componentPaused = true;
    posture.gazeComponent = null;
    posture.gazeComponentPaused = true;
    pauseBodyArmComponents();
  }

  // ---- phase 4: body / shoulder / arm components and base activity ------------------------
  /** Channels of one category that the facade has proved injectable AND verified. */
  function bodyArmCategoryChannels(category) {
    return BODY_ARM_COMPONENT_CATEGORIES[category].filter(bodyArmVerified);
  }

  /**
   * Draw one held body/shoulder/arm component. A category with no verified channel draws nothing
   * (the layer exists, but there is no honest target). Missing individual channels are dropped,
   * so a one-armed model still gets a one-armed pose instead of an unsupported whole category.
   */
  function drawBodyArmComponent(category, now) {
    const allowed = bodyArmCategoryChannels(category);
    if (allowed.length === 0) return null;
    const gate = state.motion.posture.bodyArms;
    const current = gate.components[category] ?? null;
    const stream = bodyComponentRandom[category];
    const spec = drawWeightedComponent({
      pool: BODY_ARM_COMPONENTS[category],
      weights: null,
      currentId: current === null ? null : current.id,
      rand: stream,
    });
    const bias = personaComponentBias(state.traits, state.style.expression);
    const drawnAmplitude = BODY_ARM_COMPONENT_MIN_AMPLITUDE
      + (BODY_ARM_COMPONENT_MAX_AMPLITUDE - BODY_ARM_COMPONENT_MIN_AMPLITUDE)
      * Math.pow(stream(), bias.amplitudeExponent);
    const drawMs = bodyComponentMinMs + (bodyComponentMaxMs - bodyComponentMinMs) * stream();
    const influenced = drawMs * (0.82 + 0.18 * bias.holdFactor);
    const holdMs = Math.max(bodyComponentMinMs, Math.min(bodyComponentMaxMs, influenced));
    const semantic = {};
    const targetDegrees = {};
    const saturated = {};
    const channels = [];
    for (const channel of allowed) {
      const weight = finite(spec[channel], 0);
      const raw = weight * drawnAmplitude;
      const value = clampBodyArm(channel, raw);
      semantic[channel] = value;
      targetDegrees[channel] = value * OCCASIONAL_ACTION.DEGREES_PER_POSE_UNIT;
      saturated[channel] = Math.abs(raw) > (BODY_ARM_CHANNEL_LIMITS[channel] ?? 1) + 1e-9;
      channels.push(channel);
    }
    const amplitude = channels.reduce(
      (max, channel) => Math.max(max, Math.abs(semantic[channel])),
      0,
    );
    return {
      category,
      id: spec.id,
      label: spec.label,
      startedAt: now,
      holdUntil: now + holdMs,
      durationMs: holdMs,
      amplitudeChart: drawnAmplitude,
      amplitude,
      channels,
      semantic,
      targetDegrees,
      targetDegreesBasis: 'semantic-30deg-per-unit (verified-channel-only)',
      saturated,
      observed: null,
    };
  }

  function recordBodyArmComponent(category, component) {
    const gate = state.motion.posture.bodyArms;
    gate.history[category].push({
      id: component.id,
      label: component.label,
      startedAt: component.startedAt,
      durationMs: component.durationMs,
      amplitude: component.amplitude,
      channels: [...component.channels],
    });
    if (gate.history[category].length > 8) gate.history[category].shift();
  }

  /** Install one category component; the rate limiter below is the natural hand-off. */
  function installBodyArmComponent(category, now) {
    const gate = state.motion.posture.bodyArms;
    // A runtime with zero idle sway/amplitude never draws an automatic body-arm pose. Explicit
    // gestures do not need this layer, so they are unaffected.
    if (!bodyArmAutomaticEnabled()) {
      gate.components[category] = null;
      return null;
    }
    const previous = gate.components[category];
    const component = drawBodyArmComponent(category, now);
    gate.components[category] = component;
    if (component === null) return null;
    recordBodyArmComponent(category, component);
    if (previous !== null) {
      gate.transitions[category] += 1;
      const from = { ...previous.semantic };
      const to = { ...component.semantic };
      let maxDelta = 0;
      for (const channel of BODY_ARM_COMPONENT_CATEGORIES[category]) {
        maxDelta = Math.max(maxDelta, Math.abs(finite(to[channel], 0) - finite(from[channel], 0)));
      }
      gate.lastTransition[category] = {
        at: now,
        from,
        to,
        maxDelta,
        maxStep: bodyArmMaxStep,
        /** Frames needed by the writer-side rate limiter for the largest component axis. */
        expectedFrames: maxDelta <= 0 ? 0 : Math.ceil(maxDelta / bodyArmMaxStep),
      };
    }
    return component;
  }

  /**
   * Component lifetime on EVERY frame (independent of the 1 Hz head decision gate). Each category
   * keeps its own 8–16 s hold; a hold never freezes the base layer because base is generated
   * separately below.
   */
  function stepBodyArmComponents(now) {
    const gate = state.motion.posture.bodyArms;
    // Global automatic-motion opt-out (idleSwayScale:0 / idleAmplitude:0): no base micro-motion,
    // no component hold, no component transition. The explicit intent path is untouched.
    if (!bodyArmAutomaticEnabled()) {
      for (const category of Object.keys(BODY_ARM_COMPONENT_CATEGORIES)) {
        gate.components[category] = null;
      }
      gate.base = {};
      gate.component = {};
      gate.mixed = {};
      gate.clamped = {};
      return;
    }
    if (gate.paused === true) return;
    for (const category of Object.keys(BODY_ARM_COMPONENT_CATEGORIES)) {
      const component = gate.components[category];
      if (component !== null && now < component.holdUntil) continue;
      installBodyArmComponent(category, now);
    }
  }

  /** Drop every body/arm component (interrupt / relax) and freeze the layer until a normal move. */
  function pauseBodyArmComponents() {
    const gate = state.motion.posture.bodyArms;
    gate.components = { body: null, shoulder: null, arm: null };
    gate.paused = true;
    gate.component = {};
    gate.mixed = {};
  }

  function resumeBodyArmComponents() {
    state.motion.posture.bodyArms.paused = false;
  }

  /**
   * The tiny continuous base movement of one verified body/arm channel. It is a deterministic
   * noise lattice (same style clock as the head sway), never a new timer; a channel outside the
   * verified set contributes exactly 0.
   */
  function bodyArmBaseSemantic(channel, t) {
    if (!bodyArmVerified(channel)) return 0;
    const degrees = finite(BODY_ARM_BASE_DEGREES[channel], 0);
    if (!(degrees > 0)) return 0;
    const seed = hash32(motionSeed, `body-arm:${channel}`);
    const frequency = 0.030 + (seed % 61) / 1000; // 0.030–0.090 Hz: a slow sway, no jitter
    const phase = ((seed % 360) / 180) * Math.PI;
    const drift = smoothNoise1(seed, t * frequency + 1.7);
    const tremor = Math.sin(Math.PI * 2 * (0.10 + (seed % 7) / 100) * t + phase);
    return (degrees / OCCASIONAL_ACTION.DEGREES_PER_POSE_UNIT) * (0.72 * drift + 0.28 * tremor);
  }

  /**
   * Compose the base + held component values for every body/arm channel. The result is the idle
   * BASE the existing expresssion arbitration yields against; it is never a second writer.
   */
  function composeBodyArmLayer(t, { idleEnabled, speaking, modifier, idleSwayScale }) {
    const gate = state.motion.posture.bodyArms;
    const base = {};
    const component = {};
    const mixed = {};
    const clamped = {};
    for (const channel of BODY_ARM_CHANNELS) {
      if (!bodyArmVerified(channel) || idleEnabled !== true || !bodyArmAutomaticEnabled()) {
        base[channel] = 0;
        component[channel] = 0;
        mixed[channel] = 0;
        clamped[channel] = false;
        continue;
      }
      const speakingScale = speaking ? 0.8 : 1;
      const rawBase = bodyArmBaseSemantic(channel, t)
        * Math.max(0, idleSwayScale) * finite(modifier?.amplitude, 1) * speakingScale;
      let componentValue = 0;
      for (const category of Object.keys(BODY_ARM_COMPONENT_CATEGORIES)) {
        const held = gate.components[category];
        if (held === null) continue;
        componentValue += finite(held.semantic[channel], 0);
      }
      const raw = rawBase + componentValue;
      base[channel] = rawBase;
      component[channel] = componentValue;
      mixed[channel] = clampBodyArm(channel, raw);
      clamped[channel] = Math.abs(mixed[channel] - raw) > 1e-9;
    }
    gate.base = base;
    gate.component = component;
    gate.mixed = mixed;
    gate.clamped = clamped;
    for (const category of Object.keys(BODY_ARM_COMPONENT_CATEGORIES)) {
      const held = gate.components[category];
      if (held === null) continue;
      held.observed = {
        at: state.lastAt,
        category,
        semantic: { ...held.semantic },
        mixed: Object.fromEntries(held.channels.map((channel) => [channel, mixed[channel]])),
        base: Object.fromEntries(held.channels.map((channel) => [channel, base[channel]])),
        clamped: Object.fromEntries(held.channels.map((channel) => [channel, clamped[channel]])),
      };
    }
    return { base, component, mixed, clamped };
  }

  /** True while either independent component owns the channel (release/ownership arbitration). */
  function componentOwnsChannel(channel) {
    const posture = state.motion.posture;
    if (POSTURE_COMPONENT_CHANNELS.includes(channel) && posture.component !== null) return true;
    if (POSTURE_GAZE_COMPONENT_CHANNELS.includes(channel)
      && posture.componentGazeVerified === true
      && posture.gazeComponent !== null) return true;
    // Phase 4: a verified body/arm channel is owned by the continuous base/component layer. An old
    // expression release must not force a 0 over it when its envelope ends; the next base frame is
    // already the correct baseline.
    return BODY_ARM_CHANNELS.includes(channel) && bodyArmVerified(channel);
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
      target[axis] = clampMotion(base[axis] + offset, POSTURE_COMPONENT_TARGET_LIMIT);
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
      motion.posture.lastDecision = 'initial';
      return;
    }
    // A post-preset component release owns its axes and target until its window ends: no 1 Hz
    // posture decision may overwrite the returning goal (or swap the component mid-release).
    if (state.presets.settle.componentRelease !== null) return;
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
    // The gaze component resumes on the same normal move (never immediately after interrupt/relax)
    // and only when the verified gate is open. `stepGazeComponent` then owns its own expiry.
    if (motion.posture.componentGazeVerified === true && motion.posture.gazeComponentPaused === true) {
      installGazeComponent(now);
    }
    // A normal move is also the one place the body/shoulder/arm component layer resumes after an
    // interrupt/relax (it never revives inside the decay window).
    if (motion.posture.bodyArms.paused === true) resumeBodyArmComponents();
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

  /**
   * The natural base part of one posture axis: the slow amplitude drift + continuous micro-noise
   * WITHOUT the held component offset. Keeping this as its own function lets the post-preset
   * component release walk the axe back to the live natural stance, not to a frozen centre.
   */
  function motionBaseTarget(axis, tSeconds) {
    const base = finite(state.motion.posture.base[axis], 0);
    const salt = hash32(motionSeed, axis);
    const slow = 0.82 + 0.18 * smoothNoise1(salt, tSeconds * 0.07 + 1.7);
    const micro = 0.10 * smoothNoise1(salt, tSeconds * 0.55 + 3.1);
    return base * slow + micro;
  }

  /**
   * Target = held posture + slow amplitude drift + continuous micro-noise (no fixed sine).
   *
   * The slow drift and the micro-noise belong to the BASE activity layer only. They multiply the
   * base goal, never the component offset: the component target is already an explicit semantic
   * value, and multiplying its (typically much larger) pose-unit offset by the same ±18% drift
   * used to turn one 10° lean into a ~1–2° mechanical wander while the real base sway stayed
   * invisible. Keeping the offset out of the multiplier is what makes `idle − component` a
   * truthful base-activity measurement.
   */
  function motionTarget(axis, tSeconds) {
    const held = finite(state.motion.posture.target[axis], 0);
    const base = finite(state.motion.posture.base[axis], 0);
    const componentOffset = held - base;
    return componentOffset + motionBaseTarget(axis, tSeconds);
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
    // Phase 3: the gaze component owns its own 6–12 s lifetime on every frame, independently of
    // the 1 Hz head decision/hold gate and of any in-flight head transition.
    stepGazeComponent(now);
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
    // Post-preset component release writes its own axes directly (live natural base + decaying
    // offset); every other axis keeps the normal planned-transition / hold tracker below.
    stepPresetSettleComponentAxes(dt, now, t);
    const releasingComponentAxes = state.presets.settle.componentRelease === null
      ? null : state.presets.settle.componentRelease.axes;
    for (const axis of MOTION_AXES) {
      if (releasingComponentAxes !== null
        && Object.prototype.hasOwnProperty.call(releasingComponentAxes, axis)) continue;
      advanceMotionAxis(axis, dt, now, t);
    }
    const transition = motion.transition;
    if (transition !== null && now - transition.startedAt >= transition.durationMs) {
      for (const axis of transition.axes) {
        // A release owns its axis; a queued transition must not overwrite that returning pose.
        if (releasingComponentAxes !== null
          && Object.prototype.hasOwnProperty.call(releasingComponentAxes, axis)) continue;
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
    // A relax clears both phase-3 components: the explicit decay owns the pose until it ends, and a
    // cleared component is not revived behind the decay. A later normal move may select fresh ones.
    pausePostureComponents();
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
    state.speechContinuity = null;
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
    state.speechContinuity = null;
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
      const catalog = Array.isArray(cfg.presetCatalog) && cfg.presetCatalog.length > 0
        ? cfg.presetCatalog : undefined;
      state.presets.selector = createPresetSelector({ overrides, ...(catalog === undefined ? {} : { presets: catalog }) });
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
        /** The same controller pose in the writer's 30°-per-semantic-unit convention. */
        computedDegrees: {},
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
        /** Peak of the controller's planned stage values, converted to the 30°-unit convention. */
        peakDegrees: 0,
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
    // Persona position inside an explicit degree band. 0.55 is the quiet floor of the existing
    // amplitude chain and 1.35 the lively top, so a quiet persona sits near the band's visible
    // minimum while a lively one approaches the maximum. This is a position, not a hidden global
    // gain: the actual angle stays inside the per-operation band below.
    const degreePosition = clamp01((amplitudeScale - 0.55) / 0.80);
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
      const degreeTargets = {};
      const degreeClamps = {};
      const cancelOffsets = {};
      const targetOffsets = {};
      const channel = channels[0];
      const sign = choosePresetSign(op, profile, channel === 'eyeOpenL' ? 'headY' : channel);
      const degreeRange = PRESET_OPERATION_DEGREE_RANGES[op] ?? null;
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
        // Head operations use the explicit degree band, never one shared semantic scalar. headX
        // and headZ keep their own model ranges (30° vs 90°); the headroom check records a real
        // per-channel clamp instead of silently shrinking the whole gesture.
        if (degreeRange !== null && HEAD_CHANNEL_DEGREE_LIMITS[target] !== undefined) {
          const channelLimit = HEAD_CHANNEL_DEGREE_LIMITS[target];
          const position = clamp01(degreePosition * channelScale);
          let desiredDegrees = degreeRange.min
            + (degreeRange.max - degreeRange.min) * position;
          if (profile.tilt === true) desiredDegrees *= 0.75 + 0.55 * tilt;
          desiredDegrees *= jitter * swayRatio;
          desiredDegrees = Math.max(degreeRange.min * swayRatio,
            Math.min(degreeRange.max * swayRatio, desiredDegrees));
          const actualDegrees = actualPresetPose(target) * OCCASIONAL_ACTION.DEGREES_PER_POSE_UNIT;
          const availableDegrees = Math.max(0, sign > 0
            ? channelLimit - actualDegrees
            : channelLimit + actualDegrees);
          const plannedDegrees = Math.min(desiredDegrees, availableDegrees);
          channelAmounts[target] = sign * (plannedDegrees / OCCASIONAL_ACTION.DEGREES_PER_POSE_UNIT);
          degreeTargets[target] = sign * plannedDegrees;
          if (plannedDegrees + 1e-9 < desiredDegrees) {
            degreeClamps[target] = {
              desiredDegrees: sign * desiredDegrees,
              plannedDegrees: sign * plannedDegrees,
              channelLimit,
              actualDegrees,
              reason: availableDegrees <= 1e-9 ? 'no-headroom' : 'model-headroom',
            };
          }
          continue;
        }
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
        /** Planned signed head targets in degrees (separate headX/headZ ranges). */
        degreeTargets,
        /** Per-channel headroom/model-range clamps, or empty when the band was fully planned. */
        degreeClamps,
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
        peakDegrees: 0,
        targetDegrees: { ...(stage.degreeTargets ?? {}) },
        degreeClamps: Object.fromEntries(Object.entries(stage.degreeClamps ?? {})
          .map(([channel, entry]) => [channel, { ...entry }])),
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
    record.peakDegrees = Math.abs(record.peak) * OCCASIONAL_ACTION.DEGREES_PER_POSE_UNIT;
    trace.output.peak = Math.max(trace.output.peak, Math.abs(peak));
    trace.output.peakDegrees = trace.output.peak * OCCASIONAL_ACTION.DEGREES_PER_POSE_UNIT;
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
      peakDegrees: trace.output.peakDegrees,
      at: now,
    });
    return trace;
  }

  /** Configured baseline window (0 disables the tail entirely); clamped into the supported band. */
  function presetSettleBaseMs() {
    const raw = finite(cfg.presetSettleMs, PRESET_SETTLE.DEFAULT_MS);
    if (raw <= 0) return 0;
    return Math.round(Math.max(PRESET_SETTLE.MIN_MS, Math.min(PRESET_SETTLE.MAX_MS, raw)));
  }

  /**
   * Short action → the configured 500–1000 ms window; a larger temporary offset and/or a faster
   * current pose extends it under explicit distance/deceleration bounds. No hidden gain: this only
   * decides how long the SAME offset is allowed to travel.
   */
  function presetSettleDurationMs(offset, velocity) {
    const base = presetSettleBaseMs();
    if (base <= 0) return 0;
    const distanceMs = (Math.abs(finite(offset, 0)) / PRESET_SETTLE.DISTANCE_SPEED) * 1000;
    const speedMs = (Math.abs(finite(velocity, 0)) / PRESET_SETTLE.VELOCITY_DECEL) * 1000;
    return Math.round(Math.min(PRESET_SETTLE.MAX_MS, base + distanceMs + speedMs));
  }

  /**
   * Quintic Hermite (offset, velocity) → (0, 0) with zero end velocity AND acceleration. It follows
   * the pose/velocity that really existed at the boundary (so it decelerates first instead of
   * reversing in one frame) and lands exactly on the live natural base at the end.
   */
  function presetSettleCurve(offset, velocity, durationMs, elapsedMs) {
    if (!(durationMs > 0)) return 0;
    const u = clamp01(elapsedMs / durationMs);
    const u3 = u * u * u;
    const u4 = u3 * u;
    const u5 = u4 * u;
    const h00 = 1 - 10 * u3 + 15 * u4 - 6 * u5;
    const h10 = u - 6 * u3 + 8 * u4 - 3 * u5;
    return finite(offset, 0) * h00 + finite(velocity, 0) * (durationMs / 1000) * h10;
  }

  /**
   * The live owner (other than the finished preset) of one channel. Base/component/idle layers are
   * NOT owners here: they are exactly the natural baseline the settle hands the channel back to.
   * Only a newer explicit preset, intent or expression counts.
   */
  function presetSettleOwner(channel, now) {
    for (const item of state.presets.active) {
      if (item.done !== true && item.channels.includes(channel)) return `preset:${item.presetId}`;
    }
    for (const item of state.intents) {
      if (item.done === true || item.channels.includes(channel) !== true) continue;
      const elapsed = now - item.startedAt;
      if (elapsed >= 0 && elapsed < item.durationMs) return `intent:${item.kind}`;
    }
    for (const item of state.expressions) {
      if (item.channels.includes(channel) !== true) continue;
      if (now < expressionDoneAt(item)) return `expression:${item.kind}`;
    }
    return null;
  }

  /** Stop the component release on channels a newer owner claimed (never late-overwrite it). */
  function takeOverPresetSettleComponent(channels, at, by) {
    const settle = state.presets.settle;
    const release = settle.componentRelease;
    if (release === null) return;
    const taken = [];
    for (const channel of Array.isArray(channels) ? channels : []) {
      if (!Object.prototype.hasOwnProperty.call(release.axes, channel)) continue;
      delete release.axes[channel];
      taken.push(channel);
    }
    if (taken.length === 0) return;
    recordEvent('avatar.preset.settle.component', {
      phase: 'takeover',
      presetId: release.presetId,
      actionId: release.actionId,
      axes: taken,
      by: String(by ?? 'new-owner'),
      at: Number.isFinite(at) ? at : clockNow(),
    });
    if (Object.keys(release.axes).length === 0) {
      completePresetSettleComponent(release, Number.isFinite(at) ? at : clockNow(), 'taken-over');
    }
  }

  /** Start the short cross-fade from the settle tail to a newer owner of the same channel. */
  function handOffPresetSettles(channels, at, by) {
    const now = Number.isFinite(at) ? at : clockNow();
    const settle = state.presets.settle;
    for (const channel of Array.isArray(channels) ? channels : []) {
      const entry = settle.entries.get(channel);
      if (entry === undefined || entry.handoffAt !== null) continue;
      entry.handoffAt = now;
      entry.handoffMs = PRESET_SETTLE.TAKEOVER_FADE_MS;
      entry.handoffBy = String(by ?? 'new-owner');
      settle.takeovers += 1;
      settle.lastTakeoverAt = now;
      recordEvent('avatar.preset.settle.takeover', {
        channel,
        presetId: entry.presetId,
        actionId: entry.actionId,
        by: entry.handoffBy,
        fadeMs: entry.handoffMs,
        at: now,
      });
    }
    // A new action also takes over the component release of the axes it drives.
    takeOverPresetSettleComponent(channels, now, by);
  }

  /** Detect a newer owner this frame (an intent/expression may start without calling handoff). */
  function syncPresetSettleOwners(now) {
    if (state.presets.settle.entries.size === 0) return;
    for (const channel of [...state.presets.settle.entries.keys()]) {
      const owner = presetSettleOwner(channel, now);
      if (owner !== null) handOffPresetSettles([channel], now, owner);
    }
  }

  function completePresetSettle(entry, now, outcome) {
    const removed = state.presets.settle.entries.delete(entry.channel);
    if (removed !== true) return;
    if (outcome === 'completed') {
      state.presets.settle.completed += 1;
      state.presets.settle.lastCompletedAt = now;
    }
    recordEvent('avatar.preset.settle.done', {
      channel: entry.channel,
      presetId: entry.presetId,
      actionId: entry.actionId,
      outcome,
      durationMs: Math.max(0, Math.round(now - entry.startedAt)),
      at: now,
    });
  }

  /** Remove settled axes from a planned transition so it can never snap them when the tail ends. */
  function yieldTransitionAxes(axes) {
    const transition = state.motion.transition;
    if (transition === null) return;
    transition.axes = transition.axes.filter(
      (axis) => !Object.prototype.hasOwnProperty.call(axes, axis),
    );
    if (transition.axes.length === 0) state.motion.transition = null;
  }

  function completePresetSettleComponent(release, now, outcome) {
    if (state.presets.settle.componentRelease !== release) return;
    // The transition may have been queued by a newer action while the release still owned an axis:
    // drop that axis from it BEFORE clearing the release, so the axis loop cannot jump afterwards.
    yieldTransitionAxes(release.axes);
    state.presets.settle.componentRelease = null;
    state.presets.settle.componentReleases += 1;
    state.presets.settle.lastComponentReleaseAt = now;
    recordEvent('avatar.preset.settle.component', {
      phase: 'done',
      presetId: release.presetId,
      actionId: release.actionId,
      axes: Object.keys(release.initial),
      outcome,
      durationMs: Math.max(0, Math.round(now - release.startedAt)),
      at: now,
    });
  }

  /**
   * Release the held posture component on the head axes this action wrote. The axis is walked
   * back to the LIVE natural stance (base drift + micro-noise, component removed) with the same
   * velocity-aware quintic as the channel offset; the base activity keeps running.
   */
  function startPresetSettleComponent(item, startedChannels, now, reason) {
    const settle = state.presets.settle;
    const posture = state.motion.posture;
    const component = posture.component;
    // The idle posture component belongs to the ENABLED preset pipeline: a low-level direct
    // execution (preset execution off, used only by callers/tests that inspect the executor) must
    // not disturb the idle component it was merely riding on.
    if (component === null || state.presets.enabled !== true) return;
    const t = state.styleClockMs / 1000;
    const axes = {};
    let maxSemanticOffset = 0;
    let maxSemanticVelocity = 0;
    for (const axis of POSTURE_COMPONENT_CHANNELS) {
      if (startedChannels.includes(axis) !== true) continue;
      const natural = motionBaseTarget(axis, t);
      const current = finite(state.motion.axes?.[axis]?.current, natural);
      const offset = current - natural;
      if (Math.abs(offset) <= 1e-5) continue;
      const gain = Math.abs(headBaseSemantic(axis));
      const velocity = finite(state.motion.axes?.[axis]?.velocity, 0);
      axes[axis] = { offset, velocity };
      maxSemanticOffset = Math.max(maxSemanticOffset, Math.abs(offset) * gain);
      maxSemanticVelocity = Math.max(maxSemanticVelocity, Math.abs(velocity) * gain);
    }
    if (Object.keys(axes).length === 0) return;
    const durationMs = presetSettleDurationMs(maxSemanticOffset, maxSemanticVelocity);
    if (durationMs <= 0) return;
    // A close follow-up action may need a fresh release: stop the old curve at its CURRENT pose and
    // start the new one from there, so no axis ever jumps or gets a stale target later.
    if (settle.componentRelease !== null) {
      completePresetSettleComponent(settle.componentRelease, now, 'restarted');
    }
    const release = {
      presetId: item.presetId,
      actionId: item.actionId,
      reason,
      startedAt: now,
      durationMs,
      componentId: component.id,
      /** Axis → { offset, velocity } in posture-axis units at the release boundary. */
      axes: { ...axes },
      initial: Object.fromEntries(Object.entries(axes).map(([axis, entry]) => [axis, entry.offset])),
      /** Axis → offset still owed (evidence / snapshot). */
      targetOffset: Object.fromEntries(Object.entries(axes).map(([axis, entry]) => [axis, entry.offset])),
    };
    settle.componentRelease = release;
    // A transition may still be in flight from the action itself; its released axes are now owned
    // by the tail, so it must not later snap them to a stale target.
    yieldTransitionAxes(release.axes);
    recordEvent('avatar.preset.settle.component', {
      phase: 'start',
      presetId: item.presetId,
      actionId: item.actionId,
      reason,
      axes: Object.keys(axes),
      from: { ...release.targetOffset },
      durationMs,
      at: now,
    });
  }

  /**
   * One frame of the component release. The released axis is written directly as
   * `naturalBase(t) + quintic(offset, velocity → 0)`, so position AND velocity stay continuous and
   * the base sway keeps running. Only the released axes are touched; the normal posture tracker
   * advances every other axis.
   */
  function stepPresetSettleComponentAxes(dt, now, tSeconds) {
    const settle = state.presets.settle;
    const release = settle.componentRelease;
    if (release === null) return;
    const posture = state.motion.posture;
    const component = posture.component;
    if (component === null || component.id !== release.componentId) {
      completePresetSettleComponent(release, now, 'owner-changed');
      return;
    }
    const elapsed = Math.max(0, now - release.startedAt);
    const u = clamp01(elapsed / Math.max(1, release.durationMs));
    for (const [axis, entry] of Object.entries(release.axes)) {
      const axisState = state.motion.axes[axis];
      if (axisState === undefined) continue;
      const natural = motionBaseTarget(axis, tSeconds);
      const owed = presetSettleCurve(entry.offset, entry.velocity, release.durationMs, elapsed);
      const previous = axisState.current;
      axisState.current = clampMotion(natural + owed, POSTURE_COMPONENT_TARGET_LIMIT);
      axisState.velocity = dt > 0 ? (axisState.current - previous) / dt : 0;
      release.targetOffset[axis] = owed;
      // Keep the planner's target equal to the STILL-OWED offset: if a new action stops the release
      // early, the normal tracker holds this pose instead of crawling toward a stale neutral.
      posture.target[axis] = clampMotion(
        finite(posture.base?.[axis], 0) + owed,
        POSTURE_COMPONENT_TARGET_LIMIT,
      );
      component.axes[axis] = owed;
    }
    if (u >= 1) {
      // Land EXACTLY on the live natural stance and hand the component back at zero offset.
      for (const axis of Object.keys(release.axes)) {
        const axisState = state.motion.axes[axis];
        if (axisState === undefined) continue;
        axisState.current = motionBaseTarget(axis, tSeconds);
        axisState.velocity = 0;
        posture.target[axis] = clampMotion(finite(posture.base?.[axis], 0), POSTURE_COMPONENT_TARGET_LIMIT);
        component.axes[axis] = 0;
      }
      completePresetSettleComponent(release, now, 'completed');
    }
  }

  /** Drop every settle task (hard generation switch): nothing of the old action may write later. */
  function clearPresetSettles(reason, now) {
    const settle = state.presets.settle;
    const channels = [...settle.entries.keys()];
    if (channels.length === 0 && settle.componentRelease === null) return;
    for (const channel of channels) {
      const entry = settle.entries.get(channel);
      if (entry !== undefined) completePresetSettle(entry, now, 'cleared');
    }
    const release = settle.componentRelease;
    if (release !== null) completePresetSettleComponent(release, now, 'cleared');
    recordEvent('avatar.preset.settle.cleared', {
      reason: String(reason ?? 'clear'),
      channels,
      componentAxes: release === null ? [] : Object.keys(release.initial),
      at: now,
    });
  }

  /**
   * Begin the post-preset tail for the channels this action really wrote. Eligibility is exactly:
   * computed non-zero (`item.written`), part of the verified capability set, not a VTS-native
   * channel and not an absolute eye-open value. A channel a newer owner already drives is skipped
   * instead of being zeroed under it.
   */
  function startPresetSettle(item, now, reason) {
    if (presetSettleBaseMs() <= 0 || item.written.size === 0) return [];
    const verified = item.verifiedChannels instanceof Set ? item.verifiedChannels : null;
    const contribution = item.frameContribution ?? {};
    const contributionVelocity = item.contributionVelocity ?? {};
    const started = [];
    for (const channel of item.written) {
      if (!PRESET_SETTLE_CHANNELS.has(channel)) continue;
      // `PRESET_NATIVE_CHANNELS` only says who normally owns body/breath; it must not exempt a
      // channel the finished action REALLY wrote. Body/shoulder/arm rows need the same reset as
      // head rows. Breath and absolute eye-open are never part of this tail.
      if (channel === 'breath' || channel === 'eyeOpenL' || channel === 'eyeOpenR') continue;
      if (PRESET_TAKEOVER.ABSOLUTE_CHANNELS.includes(channel)) continue;
      if (verified !== null && verified.size > 0 && verified.has(channel) !== true) continue;
      if (presetSettleOwner(channel, now) !== null) continue;
      // The settle cancels exactly the action's OWN temporary offset (never the spring lag or the
      // live base). A normal exit already reached 0; a cancel/eviction is where it is non-zero.
      // The settle starts from the pose that really reached the output, not only from the action's
      // internal contribution. A completed stage exits its contribution to ~0, but the spring/base
      // may still hold a visible offset; using that offset is what makes the return continuous
      // instead of a snap back to the component baseline.
      const actionOffset = finite(contribution[channel], 0);
      const naturalNow = finite(state.idle?.[channel], 0);
      const actualNow = finite(state.lastPose?.[channel], naturalNow);
      const visibleOffset = actualNow - naturalNow;
      const offset = Math.abs(visibleOffset) > 1e-4 ? visibleOffset : actionOffset;
      // A COMPLETED action already ran its stage exit to zero, so the last active frame carries a
      // near-zero offset plus a possibly large exit velocity. Feeding that velocity into the
      // quintic asks it to travel a near-zero distance at high speed, which visibly swings the
      // channel past the baseline before landing (observed as a ~3° headZ overshoot after an
      // idle-sway). The exit IS the deceleration; a completed tail starts from rest. A real
      // cancel/interrupt still keeps the velocity that physically existed at the cut.
      const velocity = reason === 'completed' ? 0 : finite(contributionVelocity[channel], 0);
      const durationMs = presetSettleDurationMs(offset, velocity);
      if (durationMs <= 0) continue;
      // The settle owns the channel now: an old expression release must not force a second 0 tail.
      state.releases.delete(channel);
      state.presets.settle.entries.set(channel, {
        channel,
        presetId: item.presetId,
        actionId: item.actionId,
        reason,
        startedAt: now,
        durationMs,
        /** Captured action contribution and its velocity at the boundary. */
        from: offset,
        velocity,
        handoffAt: null,
        handoffMs: 0,
        handoffBy: null,
        lastOffset: offset,
        lastNatural: finite(state.idle?.[channel], 0),
      });
      state.presets.settle.starts += 1;
      started.push(channel);
    }
    if (started.length > 0) {
      state.presets.settle.lastStartedAt = now;
      recordEvent('avatar.preset.settle.start', {
        presetId: item.presetId,
        actionId: item.actionId,
        reason,
        channels: started,
        offsets: Object.fromEntries(started.map((channel) => [
          channel, finite(state.presets.settle.entries.get(channel)?.from, 0),
        ])),
        durationMs: Math.max(0, ...started.map((channel) => (
          finite(state.presets.settle.entries.get(channel)?.durationMs, 0)
        ))),
        at: now,
      });
      startPresetSettleComponent(item, started, now, reason);
    }
    return started;
  }

  /**
   * Apply the settle offset to the natural base BEFORE composition. Only the finished action's
   * channels are touched; every other channel and the base generator keep running.
   */
  function applyPresetSettles(generators, frame, now) {
    const settle = state.presets.settle;
    if (settle.entries.size === 0) return;
    syncPresetSettleOwners(now);
    for (const [channel, entry] of settle.entries) {
      // A handoff/completion inside sync may have removed this entry already.
      if (settle.entries.get(channel) !== entry) continue;
      const elapsed = now - entry.startedAt;
      if (elapsed < 0) continue;
      // An explicit attention target owns the eyes; never force a centre over a real look-at and
      // never leave an idle-gaze task behind: the existing target simply takes the channel over.
      if ((channel === 'gazeX' || channel === 'gazeY') && frame.gaze !== null) {
        handOffPresetSettles([channel], now, 'attention');
        completePresetSettle(entry, now, 'taken-over');
        continue;
      }
      const natural = finite(generators.idle?.[channel], 0);
      let offset = presetSettleCurve(entry.from, entry.velocity, entry.durationMs, elapsed);
      if (entry.handoffAt !== null) {
        const blend = smootherstep((now - entry.handoffAt) / Math.max(1, entry.handoffMs));
        offset *= 1 - blend;
        entry.lastOffset = offset;
        entry.lastNatural = natural;
        if (blend >= 1) {
          completePresetSettle(entry, now, 'taken-over');
          continue;
        }
      } else if (elapsed >= entry.durationMs) {
        // The curve lands at exactly 0 offset; the new frame is the untouched natural base.
        completePresetSettle(entry, now, 'completed');
        continue;
      } else {
        entry.lastOffset = offset;
        entry.lastNatural = natural;
      }
      generators.idle[channel] = clampSemanticChannel(channel, natural + offset);
    }
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
      // The settle tail owns this channel already; a second release/forced-zero would fight it.
      if (state.presets.settle.entries.has(channel)) continue;
      if (state.releases.has(channel)) continue;
      const owned = state.presets.active.some((other) => other !== item && other.channels.includes(channel))
        || state.expressions.some((other) => other.channels.includes(channel))
        || state.intents.some((other) => other.channels.includes(channel))
        // Phase 3: an independent gaze component owns gazeX/gazeY. An old preset's release must
        // never be allowed to force a 0 over the component (and no channel is double-owned).
        || componentOwnsChannel(channel);
      if (owned) continue;
      state.releases.set(channel, { kind: `preset:${item.presetId}`, atMs, frames: 0, last: null });
    }
  }

  function removePresetItem(item, now, { interrupted = false } = {}) {
    const index = state.presets.active.indexOf(item);
    if (index >= 0) state.presets.active.splice(index, 1);
    item.done = true;
    // The trajectory stopped contributing, but what it left on the channel is still visible: the
    // post-preset settle-to-center now owns the channels it really wrote. This is a bounded tail
    // that hands them back to the base/component, not a second gesture.
    startPresetSettle(item, now, interrupted
      ? (item.cancelledAt !== null ? 'cancelled' : 'interrupted')
      : 'completed');
    // Channels not covered by the settle keep the legacy release window (e.g. an unverified or
    // absolute channel), so a last non-zero value can still never freeze on the VTS input.
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
      peakDegrees: 0,
      targetDegrees: { ...(stage.degreeTargets ?? {}) },
      degreeClamps: Object.fromEntries(Object.entries(stage.degreeClamps ?? {})
        .map(([channel, entry]) => [channel, { ...entry }])),
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
      /**
       * The capability proof this trajectory was started with. The post-preset settle may only
       * overwrite a channel the host really verified for this action (never a candidate row).
       */
      verifiedChannels: new Set(Array.isArray(context.verifiedChannels) ? context.verifiedChannels : []),
      /**
       * The action's OWN additive contribution on the last frame, per channel, plus its rate of
       * change. The settle tail cancels exactly this temporary offset (never the spring lag or the
       * live base): at a normal exit it is already 0, so the natural base simply continues.
       */
      frameContribution: Object.create(null),
      contributionVelocity: Object.create(null),
      contributionAt: null,
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
      // Route the eviction through the same finish path as a real end: the settle tail starts for
      // whatever the evicted action wrote, unless the newer action already owns that channel.
      removePresetItem(evicted, at, { interrupted: true });
    }
    handOffReleases(item.channels);
    // A newer preset owns its channels from here: an old settle tail must blend out, never zero
    // the channel underneath the new action.
    handOffPresetSettles(item.channels, at, `preset:${item.presetId}`);
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
    if (state.presets.active.length === 0) {
      state.motion.presetArbitration = { at: now, suppressed: [] };
      return { adds, gaze, eye, centers, active: 0 };
    }
    // Channels a NEWER trajectory already owns. Iterating newest → oldest lets an older action's
    // EXIT (or cancel fade) hand the channel over instead of dragging the new action back with a
    // stale tail. This is the same rule takeover/centre already use, applied to the whole stack:
    // a new owner is never overwritten by an old preset's closing frames.
    const newerChannels = new Set();
    const suppressedExits = [];
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
      /** This action's own additive contribution on this frame (the settle's cancellation source). */
      const contribution = Object.create(null);
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
          // An older action in its closing phase must not overwrite the newer owner of the same
          // channel. Its active/hold contribution is left untouched (two actions may legitimately
          // overlap); only the exit/cancel tail is dropped once a newer action really owns it.
          const superseded = newerChannels.has(channel)
            && (envelope.phase === 'exit' || item.cancelledAt !== null);
          if (superseded) {
            scaled = 0;
            suppressedExits.push({
              channel, presetId: item.presetId, phase: envelope.phase,
              reason: item.cancelledAt !== null ? 'cancel-fade' : 'exit',
            });
          }
          if (!Number.isFinite(scaled)) continue;
          if (PRESET_HEAD_CHANNELS.includes(channel) || channel === 'bodyX' || channel === 'bodyY' || channel === 'bodyZ') {
            adds[channel] += scaled;
            contribution[channel] = (contribution[channel] ?? 0) + scaled;
          } else if (channel === 'browL' || channel === 'browR') {
            adds[channel] += scaled;
            contribution[channel] = (contribution[channel] ?? 0) + scaled;
          } else if (channel === 'gazeX' || channel === 'gazeY') {
            gaze[channel === 'gazeX' ? 'x' : 'y'] += scaled;
            contribution[channel] = (contribution[channel] ?? 0) + scaled;
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
      // Keep the action's own offset and its rate of change for a later settle. This is NOT the
      // published pose: spring lag / the live base belong to the natural baseline and are never
      // cancelled by the tail.
      if (item.done !== true) {
        const previousContribution = item.frameContribution ?? {};
        const elapsedContribution = item.contributionAt === null ? 0 : now - item.contributionAt;
        if (elapsedContribution > 0) {
          for (const channel of new Set([
            ...Object.keys(previousContribution), ...Object.keys(contribution),
          ])) {
            item.contributionVelocity[channel] = (
              (contribution[channel] ?? 0) - (previousContribution[channel] ?? 0)
            ) / (elapsedContribution / 1000);
          }
        }
        item.frameContribution = contribution;
        item.contributionAt = now;
      }
      if (!contributed && item.cancelledAt === null && elapsed >= item.durationMs) {
        removePresetItem(item, now, { interrupted: false });
      }
      // Only a still-live newer trajectory may claim the channel for the next (older) iteration.
      if (item.done !== true) {
        for (const channel of item.channels) newerChannels.add(channel);
      }
    }
    adds.headX = presetClamp(adds.headX, 0.95);
    adds.headY = presetClamp(adds.headY, 0.95);
    adds.headZ = presetClamp(adds.headZ, HEAD_ROLL_CAP);
    adds.browL = presetClamp(adds.browL, 0.6);
    adds.browR = presetClamp(adds.browR, 0.6);
    gaze.x = presetClamp(gaze.x, EXPRESSION_MOTION.MAX_GAZE);
    gaze.y = presetClamp(gaze.y, EXPRESSION_MOTION.MAX_GAZE);
    state.motion.presetArbitration = { at: now, suppressed: suppressedExits };
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
        if (HEAD_CHANNEL_DEGREE_LIMITS[channel] !== undefined || channel.startsWith('gaze')) {
          item.trace.output.computedDegrees = item.trace.output.computedDegrees ?? {};
          item.trace.output.computedDegrees[channel] = pose[channel]
            * OCCASIONAL_ACTION.DEGREES_PER_POSE_UNIT;
        }
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
    // A hard generation stop (model/lock/teardown/disable) also drops every settle task: nothing
    // of the old action may keep writing (or release a component) into the next generation.
    if (fade <= 0) clearPresetSettles(reason, now);
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
       * Post-preset settle-to-center projection (bounded by the pose channel table). `active` lists
       * exactly the channels currently owned by the tail; `starts/completed/takeovers` are lifetime
       * counters. A settle is only created for a channel the finished action really wrote and the
       * capability proof verified.
       */
      settle: (() => {
        const now = state.lastAt ?? clockNow();
        const release = state.presets.settle.componentRelease;
        return {
          active: [...state.presets.settle.entries.values()].map((entry) => {
            const elapsedMs = Math.max(0, now - entry.startedAt);
            return {
              channel: entry.channel,
              presetId: entry.presetId,
              actionId: entry.actionId,
              reason: entry.reason,
              startedAt: entry.startedAt,
              durationMs: entry.durationMs,
              elapsedMs,
              remainingMs: Math.max(0, entry.durationMs - elapsedMs),
              phase: entry.handoffAt !== null ? 'takeover' : 'settling',
              /** The TEMPORARY action offset at the boundary, and the part still owed now. */
              from: entry.from,
              velocity: entry.velocity,
              offset: finite(entry.lastOffset, entry.from),
              natural: finite(entry.lastNatural, 0),
              handoff: entry.handoffAt === null ? null : {
                at: entry.handoffAt,
                by: entry.handoffBy,
                fadeMs: entry.handoffMs,
                elapsedMs: Math.max(0, now - entry.handoffAt),
              },
            };
          }),
          channels: [...state.presets.settle.entries.keys()],
          component: release === null ? null : {
            presetId: release.presetId,
            actionId: release.actionId,
            reason: release.reason,
            startedAt: release.startedAt,
            durationMs: release.durationMs,
            elapsedMs: Math.max(0, now - release.startedAt),
            remainingMs: Math.max(0, release.durationMs - (now - release.startedAt)),
            axes: Object.keys(release.axes),
            from: { ...release.initial },
            remaining: { ...release.targetOffset },
          },
          starts: state.presets.settle.starts,
          completed: state.presets.settle.completed,
          takeovers: state.presets.settle.takeovers,
          componentReleases: state.presets.settle.componentReleases,
          lastStartedAt: state.presets.settle.lastStartedAt,
          lastCompletedAt: state.presets.settle.lastCompletedAt,
          lastTakeoverAt: state.presets.settle.lastTakeoverAt,
          lastComponentReleaseAt: state.presets.settle.lastComponentReleaseAt,
        };
      })(),
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
    const list = INTENT_VARIANTS[kind] ?? BODY_ARM_INTENT_VARIANTS[kind] ?? INTENT_VARIANTS.nod;
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
    const targets = intentTargetsFor(action);
    if (targets === undefined) {
      recordEvent('avatar.intent.invalid', { kind: action });
      return {
        ok: false,
        reason: 'unknown-intent',
        kind: action,
        supported: [...INTENT_KINDS, ...Object.keys(BODY_ARM_INTENT_TARGETS)],
      };
    }
    const gestureProfile = isMotionProfile(profile) ? String(profile) : null;
    const wanted = intentChannelsForAny(action, gestureProfile);
    const bodyGesture = BODY_ARM_GESTURES[action] ?? null;
    const allowed = Array.isArray(channels) && channels.length > 0
      ? wanted.filter((channel) => channels.includes(channel))
      : [...wanted];
    // A body/arm expression needs its semantic CORE. Without any of it the action is refused as
    // `unsupported`; it is never silently replaced by a head gesture that happens to be mapped.
    if (bodyGesture !== null) {
      const coreAvailable = bodyGesture.core.filter((channel) => allowed.includes(channel));
      if (coreAvailable.length === 0) {
        const missing = bodyGesture.core.filter((channel) => !allowed.includes(channel));
        state.motion.posture.bodyArms.unsupported += 1;
        state.motion.posture.bodyArms.lastUnsupported = {
          kind: action,
          at: Number.isFinite(at) ? at : clockNow(),
          reason: 'missing-core',
          missingChannels: [...missing],
          availableChannels: [...allowed],
        };
        recordEvent('avatar.intent.unsupported', {
          kind: action,
          reason: 'missing-core',
          missingChannels: missing,
          availableChannels: allowed,
        });
        return {
          ok: false,
          reason: 'unsupported',
          kind: action,
          supported: false,
          missingChannels: [...missing],
          availableChannels: [...allowed],
          skipped: wanted.filter((channel) => !allowed.includes(channel)),
        };
      }
    }
    if (allowed.length === 0) {
      const reason = bodyGesture === null ? 'unmapped' : 'unsupported';
      recordEvent('avatar.intent.skipped', { kind: action, reason, channels: [...wanted] });
      return { ok: false, reason, kind: action, skipped: [...wanted] };
    }
    const partial = bodyGesture !== null
      ? wanted.some((channel) => bodyGesture.core.includes(channel) && !allowed.includes(channel))
        || wanted.some((channel) => !allowed.includes(channel))
      : false;
    const missingChannels = bodyGesture === null
      ? []
      : wanted.filter((channel) => !allowed.includes(channel));
    const now = Number.isFinite(at) ? at : clockNow();
    const scaled = effectiveStyle();
    const dims = state.dimensions;
    const effects = traitEffects();
    const occasional = gestureProfile !== null;
    const variant = pickIntentVariant(action, { deep: occasional });
    const application = STYLE_DIMENSION_APPLICATION;
    const baseDurationMs = bodyGesture !== null
      ? Math.round(bodyGesture.durationMs / scaled.tempo)
      : action === 'surprise'
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
    const baseAmplitude = bodyGesture !== null
      ? bodyGesture.amplitude * scaled.amplitude
      : action === 'nod'
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
    // Same rule for a post-preset settle tail: blend it out, never force 0 under the new gesture.
    handOffPresetSettles(allowed, now, `intent:${action}`);
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
      /** Body/arm expression evidence: a partial mapping still runs, never claims full support. */
      supported: bodyGesture !== null,
      partial,
      missingChannels,
      semanticCore: bodyGesture === null ? [] : [...bodyGesture.core],
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
        || state.intents.some((other) => other.channels.includes(channel))
        // The independent gaze component is a real owner too: no old expression release may zero it.
        || componentOwnsChannel(channel);
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
    // A new autonomous expression also takes its channels from an old preset settle tail.
    handOffPresetSettles(item.channels, time, `expression:${kind}`);
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
    // Post-preset settle: an intent-only channel must keep being flushed while its tail walks the
    // pose back to center; the idle-written head channels are already in the set by construction.
    for (const channel of state.presets.settle.entries.keys()) set.add(channel);
    // Motion presets ride the SAME write set as explicit intents: the executor computes their
    // trajectory on the one pose, so while a trajectory is active its channels must be flushable.
    // Without this the preset is computed (and used to be reported as committed) but never sent.
    for (const item of state.presets.active) {
      if (now < item.startedAt) continue;
      if (item.cancelledAt !== null && now - item.cancelledAt >= Math.max(1, item.cancelFadeMs)) continue;
      for (const channel of item.channels) set.add(channel);
    }
    // Phase 3: the gaze component is an independent owner of gazeX/gazeY, but only while its
    // verified+plugin gate is open and the master idle switch is on. It never adds a channel to the
    // write set when unverified/native-possible, and body channels are never added here. The
    // component owns the channels even when its target is the still centre (0): that is what
    // releases a previous direction instead of leaving the last non-zero eye value on the wire.
    const posture = state.motion.posture;
    if (posture.componentGazeVerified === true && posture.gazeComponent !== null
      && state.intent.flags?.idle !== false) {
      for (const channel of POSTURE_GAZE_COMPONENT_CHANNELS) set.add(channel);
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
    const adds = {
      headX: 0, headY: 0, headZ: 0, browL: 0, browR: 0, bodyX: 0, bodyY: 0, bodyZ: 0,
      shoulderL: 0, shoulderR: 0, armL: 0, armR: 0, handL: 0, handR: 0,
    };
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
      } else if (BODY_ARM_GESTURES[item.kind] !== undefined) {
        // Body/arm expression on the SAME additive fold. Only the mapped channels participate;
        // the semantic core was already checked in intent(), so this branch never turns a missing
        // arm into a head motion. Direction is model-specific (true machine unverified).
        const spec = BODY_ARM_GESTURES[item.kind];
        const side = item.sign >= 0 ? 'R' : 'L';
        // A wave always RAISES the chosen arm (the side itself comes from the sign); a two-sided
        // spread/shrug alternates its whole direction, so the second repeat is not identical.
        const direction = item.kind === 'wave' ? 1 : item.sign;
        const addArm = (channel, ratio) => {
          if (!has(channel)) return;
          adds[channel] += clampBodyArm(channel, amount * ratio * direction * channelScale(channel));
        };
        if (item.kind === 'wave') {
          addArm(`arm${side}`, spec.armGain);
          // Two clear hand oscillations inside the envelope: a wave is not a static raise.
          const wavePhase = Math.sin(progress * Math.PI * 4);
          addArm(`hand${side}`, spec.handGain * wavePhase);
          addArm(`shoulder${side}`, spec.shoulderGain * 0.5);
        } else if (item.kind === 'spread') {
          addArm('armL', spec.armGain);
          addArm('armR', spec.armGain);
          addArm('handL', spec.handGain * (0.4 + 0.6 * envelope));
          addArm('handR', spec.handGain * (0.4 + 0.6 * envelope));
          addArm('shoulderL', spec.shoulderGain);
          addArm('shoulderR', spec.shoulderGain);
        } else if (item.kind === 'shrug') {
          addArm('shoulderL', spec.shoulderGain);
          addArm('shoulderR', spec.shoulderGain);
          addArm('armL', spec.armGain);
          addArm('armR', spec.armGain);
        }
      }
    }
    // Autonomous expressions ride the same additive fold, after the explicit gestures. Their gaze
    // offset stays separate: it is added to the idle base, so an explicit attention target wins.
    const expression = expressionFrame(now);
    for (const channel of Object.keys(adds)) adds[channel] += finite(expression.adds[channel], 0);
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
        // Keep the just-ended envelope briefly: a following TTS chunk may arrive one tick after the
        // end, and appending to the same clock is still a decode boundary, not a pause.
        state.speechContinuity = { ...speech };
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
        state.speechContinuity = null;
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
    // A real blink starts exactly on the idle → closing edge. Counting the edge (not the factor)
    // keeps a suppressed blink (baseline ≤ BLINK_THRESHOLD) and a mid-cycle frame from counting.
    const blinkWasIdle = state.blink.phase === 'idle';
    const blinkResult = stepBlink(state.blink, dt, { random });
    state.blink = blinkResult.state;
    state.blinkFactor = blinkResult.factor;
    if (state.baseActivity.enabled && blinkWasIdle && blinkResult.state.phase === 'closing') {
      state.baseActivity.blinkCount += 1;
    }

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
    const breathPhaseBefore = state.breathPhase;
    state.breathPhase = (state.breathPhase + (Math.PI * 2 / periodSeconds) * dt) % (Math.PI * 2);
    // One completed cycle per wrap; the phase is modulo 2π and dt is clamped to 50 ms, so at most
    // one wrap can happen in a frame. A disabled breathing flag still advances the phase but is not
    // counted as a breath the avatar took.
    if (state.baseActivity.enabled && breathing && state.breathPhase < breathPhaseBefore) {
      state.baseActivity.breathCycles += 1;
    }

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
    // Head base swing: the base activity span is its OWN explicit degree target (see
    // BASE_ACTIVITY_DEGREES), not a component-derived gain. Speech damps the base sway, while the
    // held component keeps its own degrees via the per-frame correction below.
    const headXAmp = idleEnabled ? headBaseSemantic('headX') * speakingHead : 0;
    const headYAmp = idleEnabled ? headBaseSemantic('headY') * speakingHead : 0;
    const headZAmp = idleEnabled ? headBaseSemantic('headZ') : 0;
    const bodyAmp = idleEnabled ? 0.05 * idleChannelSway('bodyX') * (frame.speaking ? 0.8 : 1) : 0;
    const gazeXAmp = 0.05 * idleChannelSway('gazeX') * gazeDrift;
    const gazeYAmp = 0.035 * idleChannelSway('gazeY') * gazeDrift;
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
    const drift = (name) => driftUnit * (name === 'headZ' ? 1 : speakingHead)
      * smoothNoise1(hash32(motionSeed, `drift:${name}`), t * HOLD_MICRO_DRIFT.FREQUENCY_HZ + 1.3);
    motion.holdDrift = { headX: drift('headX'), headY: drift('headY'), headZ: drift('headZ') };
    // Expression gaze (thinking looks up, listening recentres) is part of the idle base: an
    // explicit attention target still overrides it in applyDynamics.
    const expressionGaze = state.expressionGaze ?? { x: 0, y: 0 };
    const gazeComponent = motion.posture.componentGazeVerified === true
      ? motion.posture.gazeComponent : null;
    // Same-channel arbitration for the gaze component: a preset/expression gaze is the EXPRESSION
    // and keeps its full value; only the component target yields. It is clamped to the same
    // INTENT_IDLE_RATIO window the head idle base uses, so a small gesture does not get buried under
    // a held gaze and a large gesture leaves the component a visible tail. The head/gaze caps are
    // applied per channel BEFORE this fold, so the sum can never exceed each component's budget.
    const yieldGaze = (componentValue, gestureValue) => {
      const gesture = finite(gestureValue, 0);
      if (gesture === 0) return finite(componentValue, 0);
      const cap = INTENT_IDLE_RATIO * Math.abs(gesture);
      return Math.max(-cap, Math.min(cap, finite(componentValue, 0)));
    };
    const componentGazeX = yieldGaze(gazeComponent?.value?.gazeX, expressionGaze.x);
    const componentGazeY = yieldGaze(gazeComponent?.value?.gazeY, expressionGaze.y);
    // The component's own semantic target is fixed at draw time. The posture axis carries it as a
    // cancellation offset, so the delivered share is `headAmp × offset`; cap that share at the
    // component budget. The correction is subtracted from the idle base, so base drift is
    // preserved while the component never exceeds its budget. `mixed` records the share really
    // delivered; the explicit target degrees stay available on the component itself.
    const headComponentAxes = motion.posture.component?.axes ?? null;
    const componentHeadRaw = {
      headX: headXAmp * finite(headComponentAxes?.headX, 0),
      headY: headYAmp * finite(headComponentAxes?.headY, 0),
      headZ: headZAmp * finite(headComponentAxes?.headZ, 0),
    };
    const componentHeadCapped = {
      headX: Math.max(-POSTURE_COMPONENT_MAX_AMPLITUDE,
        Math.min(POSTURE_COMPONENT_MAX_AMPLITUDE, componentHeadRaw.headX)),
      headY: Math.max(-POSTURE_COMPONENT_MAX_AMPLITUDE,
        Math.min(POSTURE_COMPONENT_MAX_AMPLITUDE, componentHeadRaw.headY)),
      headZ: Math.max(-POSTURE_COMPONENT_MAX_AMPLITUDE,
        Math.min(POSTURE_COMPONENT_MAX_AMPLITUDE, componentHeadRaw.headZ)),
    };
    const componentHeadAdjust = {
      headX: componentHeadCapped.headX - componentHeadRaw.headX,
      headY: componentHeadCapped.headY - componentHeadRaw.headY,
      headZ: componentHeadCapped.headZ - componentHeadRaw.headZ,
    };
    // Phase 4 base + held body/shoulder/arm components. `bodyX` deliberately keeps the existing
    // posture base below; this layer contributes its component on top (its own base span is 0).
    const bodyArmLayer = composeBodyArmLayer(t, {
      idleEnabled,
      speaking: frame.speaking === true,
      modifier,
      idleSwayScale,
    });
    const idle = {
      ...neutralPose(),
      gazeX: idleEnabled
        ? gazeXAmp * axis('gazeX') + (thinking ? 0.05 * idleChannelSway('gazeX') : 0)
          + componentGazeX + finite(expressionGaze.x, 0)
        : 0,
      gazeY: idleEnabled
        ? gazeYAmp * axis('gazeY') + (thinking ? -0.02 * idleChannelSway('gazeY') : 0)
          + componentGazeY + finite(expressionGaze.y, 0)
        : 0,
      // A thinking pause adds a shallow micro-nod; it is part of the same idle base, not a write.
      headX: headXAmp * axis('headX')
        + (thinking ? 0.02 * idleChannelSway('headX') * smoothNoise1(hash32(motionSeed, 'think'), t * 0.8) : 0)
        + motion.holdDrift.headX + componentHeadAdjust.headX,
      headY: headYAmp * axis('headY') + motion.holdDrift.headY + speechMicro
        + componentHeadAdjust.headY,
      headZ: headZAmp * axis('headZ') + motion.holdDrift.headZ + componentHeadAdjust.headZ,
      browL: 0,
      browR: 0,
      mouth: 0,
      bodyX: bodyAmp * axis('bodyX') + finite(bodyArmLayer.mixed.bodyX, 0),
      bodyY: finite(bodyArmLayer.mixed.bodyY, 0),
      bodyZ: finite(bodyArmLayer.mixed.bodyZ, 0),
      shoulderL: finite(bodyArmLayer.mixed.shoulderL, 0),
      shoulderR: finite(bodyArmLayer.mixed.shoulderR, 0),
      armL: finite(bodyArmLayer.mixed.armL, 0),
      armR: finite(bodyArmLayer.mixed.armR, 0),
      handL: finite(bodyArmLayer.mixed.handL, 0),
      handR: finite(bodyArmLayer.mixed.handR, 0),
      breath: 0.5,
    };
    state.idle = idle;
    // Head activity is judged on the IDLE BASE (the posture baseline), not the final pose: a
    // preset/gesture offset belongs to another layer and must not be reported as "base activity".
    // A hold still changes the drift/noise, so a held preset keeps accumulating — that is the point:
    // the base layer never stops just because a preset is holding.
    const previousHead = state.baseActivity.previousHead;
    if (state.baseActivity.enabled && previousHead !== null
      && (Math.abs(idle.headX - previousHead.headX) > HEAD_ACTIVITY_EPSILON
        || Math.abs(idle.headY - previousHead.headY) > HEAD_ACTIVITY_EPSILON
        || Math.abs(idle.headZ - previousHead.headZ) > HEAD_ACTIVITY_EPSILON)) {
      state.baseActivity.headMotionMs += dt * 1000;
    }
    state.baseActivity.previousHead = {
      headX: idle.headX,
      headY: idle.headY,
      headZ: idle.headZ,
    };
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
        targetSemantic: { ...activeComponent.semantic },
        targetDegrees: { ...activeComponent.targetDegrees },
        targetDegreesBasis: activeComponent.targetDegreesBasis,
        mixed: {
          headX: componentHeadCapped.headX,
          headY: componentHeadCapped.headY,
          headZ: componentHeadCapped.headZ,
        },
        mixedBasis: 'head-contribution-after-live-gain-and-semantic-cap',
        /** The un-capped contribution the live gain asked for (evidence of the per-frame cap). */
        uncapped: {
          headX: componentHeadRaw.headX,
          headY: componentHeadRaw.headY,
          headZ: componentHeadRaw.headZ,
        },
      };
    }
    if (gazeComponent !== null) {
      const gesture = {
        gazeX: finite(expressionGaze.x, 0),
        gazeY: finite(expressionGaze.y, 0),
      };
      gazeComponent.observed = {
        at: state.lastAt,
        target: { ...gazeComponent.value },
        semantic: { ...gazeComponent.semantic },
        degrees: { ...gazeComponent.degrees },
        /** The component share that survived same-channel arbitration (≤0.12 per channel). */
        mixed: { gazeX: componentGazeX, gazeY: componentGazeY },
        gesture,
        /** 1 = component untouched, INTENT_IDLE_RATIO floor = a gesture took the channel. */
        yieldScale: {
          gazeX: Math.abs(gazeComponent.value.gazeX) > 1e-9
            ? Math.abs(componentGazeX) / Math.abs(gazeComponent.value.gazeX) : 1,
          gazeY: Math.abs(gazeComponent.value.gazeY) > 1e-9
            ? Math.abs(componentGazeY) / Math.abs(gazeComponent.value.gazeY) : 1,
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
        target: clampHeadAxis(axis, finite(pose[axis], 0)),
        dt,
        ...params,
      });
      state.springs[axis] = next;
      pose[axis] = clampHeadAxis(axis, next.current);
    }
    // A damped spring can still overshoot its (already capped) target by a fraction of a degree;
    // the 14° roll guarantee is enforced on the semantic pose, never by truncating the input value.
    pose.headZ = clampHeadRoll(pose.headZ);

    // Body/shoulder/arm: a semantic clamp on EVERY channel, plus a per-frame position step for the
    // channels that have no spring. The step is the layer's velocity bound; a component swap can
    // therefore never snap (a full 0.40 semantic move takes ≈7 frames at 30 Hz, ≈230 ms).
    for (const channel of BODY_ARM_CHANNELS) {
      if (SPRING_AXES.includes(channel)) {
        pose[channel] = clampBodyArm(channel, finite(pose[channel], 0));
        continue;
      }

      pose[channel] = approachBounded(
        finite(prev?.[channel], 0),
        clampBodyArm(channel, finite(pose[channel], 0)),
        bodyArmMaxStep,
      );
    }

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
    // The one host gate for the phase-2 counters. `state` is deliberately about the OBSERVATION
    // source, not about a preset: a held/no-candidate preset keeps the base layer running.
    if (state.baseActivity.enabled) {
      const flags = state.intent.flags ?? {};
      state.baseActivity.state = flags.idle === false && flags.breathing === false ? 'paused' : 'running';
      state.baseActivity.lastAt = now;
    } else {
      state.baseActivity.state = 'stopped';
    }
    // ONE effective style for this whole frame: state scaling, idle curve, intents and the mouth
    // all read it, so the same channel can never receive two different final values.
    state.effective = effectiveStyle();

    // The rare micro-action is decided on the same tick, never by a new timer.
    maybeScheduleOccasional(now);
    // Autonomous preset boundary: the low-frequency idle draw. A hold result writes nothing.
    maybeAutoPreset(now);
    // Phase 4: body/shoulder/arm component lifetime runs on every frame (own windows, own streams);
    // its hold never pauses the base layer generated in advanceGenerators().
    stepBodyArmComponents(now);
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
    // The component-release target is applied inside advanceMotion, on the same axis trajectory.
    const generators = advanceGenerators(dt, frame);
    // Post-preset settle: apply ONLY the finished action's temporary offset on top of the live
    // natural base. The base generator above already ran, so breathing, blink, posture and every
    // other channel keep moving through the tail.
    applyPresetSettles(generators, frame, now);
    const composed = composeChannels(frame, generators, ARBITRATION);
    // Body/shoulder/arm channels outside the legacy CHANNELS table are part of the SAME composed
    // pose (and therefore the same spring/rate limiter and the same single writer below).
    for (const channel of BODY_ARM_CHANNELS) {
      if (CHANNELS.includes(channel)) continue;
      composed[channel] = finite(generators.idle?.[channel], 0);
    }

    // Explicit action priority (same-frame, not a plain sum): on a channel an active gesture
    // drives, the idle micro-motion may only contribute INTENT_IDLE_RATIO of the gesture
    // magnitude. The gesture is added AFTER that limit, so it is never cancelled or diluted;
    // everything that is not idle micro-motion (manual pose / touch) is preserved unchanged.
    //
    // Phase 3 records the same decision as evidence: the independent head component rides the idle
    // base, so its contribution is reduced by exactly the same factor while the preset keeps its own
    // full value. After the preset exits the component goal was never rewritten, so it recovers.
    const headComponent = state.motion.posture.component;
    const headConflicts = [];
    for (const [channel, value] of Object.entries(intent.adds)) {
      if (value === 0) continue;
      const idleBase = finite(generators.idle?.[channel], 0);
      const componentBefore = finite(headComponent?.observed?.mixed?.[channel], 0);
      const presetIds = state.presets.active
        .filter((item) => item.done !== true && item.channels.includes(channel))
        .map((item) => item.presetId);
      // An autonomous micro-expression (no preset owner) never invokes the gesture yield rule. A
      // preset's ramp edge is still a GESTURE: it keeps the existing INTENT_IDLE_RATIO contract.
      if (Math.abs(value) < IDLE_YIELD_MIN_GESTURE && presetIds.length === 0) {
        // Micro-expression only: it is ADDED to the live idle base (and held component). It must
        // not invoke the gesture yield rule, which would replace the whole base with 0.2×0.1°.
        const microNext = finite(composed[channel], 0) + value;
        composed[channel] = clampSemanticChannel(channel, microNext);
        if (componentBefore !== 0) {
          headConflicts.push({
            channel,
            gesture: value,
            idleBase,
            componentBefore,
            componentAfter: componentBefore,
            yieldScale: 1,
            idleScale: 1,
            micro: true,
            presetIds,
          });
        }
        continue;
      }
      const cap = INTENT_IDLE_RATIO * Math.abs(value);
      const idlePart = Math.max(-cap, Math.min(cap, idleBase));
      const next = finite(composed[channel], 0) - idleBase + idlePart + value;
      composed[channel] = clampSemanticChannel(channel, next);
      if (componentBefore !== 0) {
        const retained = Math.abs(idleBase) > 1e-12 ? idlePart / idleBase : 0;
        // The arbitration replaces the WHOLE idle contribution (base swing + component) with one
        // bounded share. The component's surviving share is therefore bounded by the same cap; the
        // old proportional attribution could report more than the cap when the base opposed the
        // component. Keep `idleScale` as the raw whole-idle ratio for diagnostics.
        const componentAfter = Math.max(-cap, Math.min(cap, componentBefore));
        headConflicts.push({
          channel,
          gesture: value,
          idleBase,
          componentBefore,
          componentAfter,
          yieldScale: Math.abs(componentBefore) > 1e-12
            ? Math.abs(componentAfter) / Math.abs(componentBefore) : retained,
          idleScale: retained,
          presetIds: state.presets.active
            .filter((item) => item.done !== true && item.channels.includes(channel))
            .map((item) => item.presetId),
        });
      }
    }
    // The gaze component is arbitrated inside advanceGenerators (it is part of the idle gaze base);
    // copy that evidence into the same read-only record so status/tests see ONE arbitration table.
    const gazeComponent = state.motion.posture.gazeComponent;
    const gazeConflicts = [];
    if (gazeComponent?.observed !== null && gazeComponent?.observed !== undefined) {
      for (const channel of POSTURE_GAZE_COMPONENT_CHANNELS) {
        const before = finite(gazeComponent.value?.[channel], 0);
        const gesture = finite(gazeComponent.observed.gesture?.[channel], 0);
        if (gesture === 0) continue;
        const after = finite(gazeComponent.observed.mixed?.[channel], 0);
        gazeConflicts.push({
          channel,
          gesture,
          idleBase: before,
          componentBefore: before,
          componentAfter: after,
          yieldScale: Math.abs(before) > 1e-9 ? Math.abs(after) / Math.abs(before) : 1,
          presetIds: state.presets.active
            .filter((item) => item.done !== true && item.channels.includes(channel))
            .map((item) => item.presetId),
        });
      }
    }
    state.motion.arbitration = {
      at: now,
      presetActive: state.presets.active.filter((item) => item.done !== true).length,
      head: headConflicts,
      gaze: gazeConflicts,
      suppressedExits: state.motion.presetArbitration.suppressed.map((entry) => ({ ...entry })),
    };
    // Centre operations are a bounded blend to the CURRENT natural baseline (the active posture
    // component included), applied AFTER the idle arbitration. Applying a frozen/live additive
    // here instead would subtract the idle base twice and overshoot when another trajectory moved.
    for (const [channel, entry] of Object.entries(intent.centers ?? {})) {
      const wave = clamp01(finite(entry.wave, 0));
      if (wave <= 0) continue;
      const base = finite(composed[channel], 0);
      const target = finite(entry.target, base);
      const next = base + (target - base) * wave;
      composed[channel] = clampSemanticChannel(channel, next);
    }
    // The roll is held to the model's own ±90° range on the SEMANTIC pose, before the spring and
    // long before the input value: headX/headY keep their ±30° range, so a lean cannot be truncated
    // by the yaw budget while still never exceeding the roll input's real range.
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
    // A barge-in clears BOTH posture components (head + gaze) as well as the pose they ride on. The
    // target/base are reset so the old component goal cannot re-converge on the next tick; a later
    // moved decision may select fresh components, never resume the old ones.
    const motion = state.motion;
    pausePostureComponents();
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
    // A hard stop publishes an explicit rest value on the body/arm channels instead of letting the
    // rate limiter drift the old gesture out (the old generation is invalidated by the facade).
    for (const channel of BODY_ARM_CHANNELS) pose[channel] = 0;
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
    state.speechContinuity = null;
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
    const requestedStart = Number.isFinite(startedAt) ? startedAt : clockNow();
    if (live === true) {
      const seat = acquireMouth(who, { takeover });
      if (seat.ok !== true) return seat;
      state.mouth.live = true;
      return { ...seat, mode: 'live', frames: 0 };
    }
    const step = Number.isFinite(stepMs) && stepMs > 0 ? stepMs : Math.max(1, finite(cfg.mouthStepMs, TIMING.MOUTH_STEP_MS));
    const source = Array.isArray(levels) && levels.length > 0
      ? levels.map((value) => Number(value))
      : buildSpeechLevels(text, durationMs, step);
    if (source.some((value) => !Number.isFinite(value))) {
      const seat = acquireMouth(who, { takeover });
      if (seat.ok !== true) return seat;
      releaseMouth('invalid-levels');
      return { ok: false, reason: 'non-numeric level', token: state.mouth.token, owner: who };
    }
    const list = source.map((value) => clamp01(value));
    const duration = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : list.length * step;
    const start = requestedStart;
    // Chunk continuity: a new chunk that starts inside (or just after) the current envelope is
    // appended to the SAME clock, so the level index never resets at a decode boundary. This is
    // the only special case; a real pause or any explicit cancel still takes the normal path.
    const speech = state.speech !== null
      ? state.speech
      : (state.speechContinuity !== null
        && start <= state.speechContinuity.startedAt
          + state.speechContinuity.durationMs + MOUTH_CHUNK_CONTINUITY_MS
        ? state.speechContinuity : null);
    const mouth = state.mouth;
    const canContinue = takeover !== true
      && speech !== null
      && mouth.active === true
      && mouth.owner === who
      && mouth.live !== true
      && Math.abs(step - speech.stepMs) < 1e-9
      && start >= speech.startedAt - 1
      && start <= speech.startedAt + speech.durationMs + MOUTH_CHUNK_CONTINUITY_MS;
    if (canContinue) {
      // A small decode gap is filled with CLOSED levels (a real pause is allowed to shut the
      // mouth); a contiguous chunk starts exactly at the old level count, so nothing is inserted.
      const offsetMs = Math.max(0, start - speech.startedAt);
      const offsetIndex = Math.round(offsetMs / speech.stepMs);
      const merged = speech.levels.slice(0, offsetIndex);
      while (merged.length < offsetIndex) merged.push(0);
      merged.push(...list);
      const mergedDuration = Math.max(speech.durationMs, offsetMs + duration);
      // Re-activate the same envelope clock. This also works when the previous chunk already
      // entered its release window: the new chunk appends to the clock instead of resetting it.
      state.speech = { ...speech, levels: merged, durationMs: mergedDuration };
      state.speechContinuity = null;
      state.release = null;
      mouth.continuations += 1;
      recordEvent('avatar.mouth.continued', {
        owner: who,
        offsetMs,
        appended: list.length,
        frames: merged.length,
        durationMs: mergedDuration,
        startedAt: state.speech.startedAt,
      });
      return {
        ok: true,
        token: mouth.token,
        sessionId: mouth.seq,
        owner: who,
        mode: 'envelope',
        startedAt: state.speech.startedAt,
        durationMs: mergedDuration,
        frames: merged.length,
        continued: true,
        appended: list.length,
      };
    }
    const seat = acquireMouth(who, { takeover });
    if (seat.ok !== true) return seat;
    const currentMouth = state.mouth;
    currentMouth.live = false;
    state.speech = {
      token: currentMouth.token,
      turnId: state.turnId,
      levels: list,
      stepMs: step,
      startedAt: start,
      durationMs: duration,
    };
    state.release = null;
    return {
      ...seat, mode: 'envelope', startedAt: start, durationMs: duration, frames: list.length,
    };
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
      /** Named target view: semantic units (1 = 30° under the writer's documented convention). */
      targetSemantic: { ...(component.targetSemantic ?? component.semantic ?? {}) },
      /** Semantic target angle before transport normalisation; the facade adds the verified range. */
      targetDegrees: { ...(component.targetDegrees ?? {}) },
      targetDegreesBasis: component.targetDegreesBasis ?? 'semantic-30deg-per-unit (mapping-unverified)',
      axisLimit: component.axisLimit ?? POSTURE_COMPONENT_AXIS_LIMIT,
      /** True when the live persona gain forced the internal offset to its safety bound. */
      saturated: { ...(component.saturated ?? {}) },
      observed: component.observed === null ? null : {
        at: component.observed.at,
        target: { ...(component.observed.target ?? {}) },
        semantic: { ...(component.observed.semantic ?? {}) },
        targetSemantic: { ...(component.observed.targetSemantic ?? {}) },
        targetDegrees: { ...(component.observed.targetDegrees ?? {}) },
        targetDegreesBasis: component.observed.targetDegreesBasis ?? null,
        mixed: { ...(component.observed.mixed ?? {}) },
        mixedBasis: component.observed.mixedBasis ?? null,
        uncapped: { ...(component.observed.uncapped ?? {}) },
        idle: component.observed.idle === undefined ? null : { ...component.observed.idle },
        pose: component.observed.pose === undefined ? null : { ...component.observed.pose },
      },
    };
  }

  /** One body/shoulder/arm component as a read-only view (independent per category). */
  function bodyArmComponentSnapshot(category) {
    const gate = state.motion.posture.bodyArms;
    const component = gate.components[category];
    if (component === null) return null;
    return {
      category,
      id: component.id,
      label: component.label,
      startedAt: component.startedAt,
      holdUntil: component.holdUntil,
      durationMs: component.durationMs,
      remainingMs: Math.max(0, component.holdUntil - (state.lastAt ?? 0)),
      amplitude: component.amplitude,
      channels: [...component.channels],
      semantic: { ...component.semantic },
      targetSemantic: { ...component.semantic },
      targetDegrees: { ...component.targetDegrees },
      targetDegreesBasis: component.targetDegreesBasis,
      saturated: { ...component.saturated },
      observed: component.observed === null ? null : {
        at: component.observed.at,
        category: component.observed.category,
        semantic: { ...component.observed.semantic },
        mixed: { ...component.observed.mixed },
        base: { ...component.observed.base },
        clamped: { ...component.observed.clamped },
      },
    };
  }

  /**
   * Phase 3 gaze-component snapshot. `value`/`semantic` are the bounded semantic target; `degrees`
   * is the 30°-equivalent annotation (NOT a measured eye rotation); `mixed` is the share that
   * survived same-channel arbitration. `verified` is the gate that allowed the draw at all.
   */
  function gazeComponentSnapshot() {
    const posture = state.motion.posture;
    const component = posture.gazeComponent;
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
      value: { ...component.value },
      semantic: { ...component.semantic },
      degrees: { ...component.degrees },
      verified: posture.componentGazeVerified === true,
      observed: component.observed === null ? null : {
        at: component.observed.at,
        target: { ...(component.observed.target ?? {}) },
        semantic: { ...(component.observed.semantic ?? {}) },
        degrees: { ...(component.observed.degrees ?? {}) },
        mixed: { ...(component.observed.mixed ?? {}) },
        gesture: { ...(component.observed.gesture ?? {}) },
        yieldScale: { ...(component.observed.yieldScale ?? {}) },
      },
    };
  }

  /**
   * Phase 2 host gate. The pose keeps being computed while `enabled:false` (so unlock/resume is
   * continuous), but the base-activity counters, `lastAt` and `state` freeze at their last values.
   * Used by the facade for privacy lock / disconnect / disposed generation; there is no timer here.
   */
  function setBaseActivityEnabled(enabled) {
    state.baseActivity.enabled = enabled !== false;
    if (!state.baseActivity.enabled) state.baseActivity.state = 'stopped';
    return { enabled: state.baseActivity.enabled };
  }

  /**
   * Phase 3 gaze-component gate. The caller must pass `true` ONLY when BOTH gazeX and gazeY are
   * verified plugin-owned channels (never for a declaration, a native-possible candidate or a
   * single verified axis). On false the current component is dropped immediately and no gaze is
   * added to the write set; on true the next frame draws a fresh component (unless a relax/interrupt
   * pause is still in force, which only a later normal move clears).
   */
  function setComponentGazeVerified(verified) {
    const next = verified === true;
    const posture = state.motion.posture;
    const changed = posture.componentGazeVerified !== next;
    posture.componentGazeVerified = next;
    if (!next) posture.gazeComponent = null;
    recordEvent('avatar.motion.component.gaze-gate', { verified: next, changed });
    return { verified: next, changed, component: posture.gazeComponent !== null };
  }

  /**
   * Phase 4 body/arm gate. The facade passes exactly the channels whose mapping it has verified
   * (never a candidate). On a narrowing gate every component that lost all its channels is
   * dropped immediately; the next frame re-draws only what the new model can really drive.
   */
  function setBodyArmVerified(channels) {
    const gate = state.motion.posture.bodyArms;
    const next = new Set(
      (Array.isArray(channels) ? channels : [])
        .map((channel) => String(channel))
        .filter((channel) => BODY_ARM_CHANNELS.includes(channel)),
    );
    let changed = next.size !== gate.verified.size;
    if (!changed) {
      for (const channel of next) {
        if (!gate.verified.has(channel)) { changed = true; break; }
      }
    }
    gate.verified = next;
    if (changed) {
      for (const category of Object.keys(BODY_ARM_COMPONENT_CATEGORIES)) {
        const component = gate.components[category];
        if (component === null) continue;
        const kept = component.channels.filter((channel) => next.has(channel));
        if (kept.length === 0) {
          gate.components[category] = null;
          continue;
        }
        if (kept.length !== component.channels.length) {
          // Keep the still-verified part of the pose; a channel that lost its proof is removed from
          // the component itself, not only zeroed at mix time.
          for (const channel of component.channels) {
            if (next.has(channel)) continue;
            delete component.semantic[channel];
            delete component.targetDegrees[channel];
            delete component.saturated[channel];
          }
          component.channels = kept;
          component.amplitude = kept.reduce(
            (max, channel) => Math.max(max, Math.abs(finite(component.semantic[channel], 0))),
            0,
          );
        }
      }
      if (gate.paused === false) {
        for (const category of Object.keys(BODY_ARM_COMPONENT_CATEGORIES)) {
          const component = gate.components[category];
          if (component === null) installBodyArmComponent(category, state.lastAt ?? 0);
        }
      }
    }
    recordEvent('avatar.motion.body-arm-gate', {
      verified: [...next],
      changed,
      channels: [...BODY_ARM_CHANNELS],
    });
    return {
      verified: [...next],
      changed,
      components: Object.fromEntries(Object.keys(BODY_ARM_COMPONENT_CATEGORIES)
        .map((category) => [category, gate.components[category]?.id ?? null])),
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
        continuations: state.mouth.continuations,
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
        /**
         * Phase 2 base activity (observation only, no persistence). See the state comment for the
         * exact counting rules; `presetHeld` is true while the LAST selector decision was a legal
         * hold / no-candidate and no preset action is running (the base layer still accumulates).
         */
        baseActivity: {
          blinkCount: state.baseActivity.blinkCount,
          breathCycles: state.baseActivity.breathCycles,
          headMotionMs: state.baseActivity.headMotionMs,
          lastAt: state.baseActivity.lastAt,
          state: state.baseActivity.state,
          presetHeld: state.presets.enabled === true
            && state.presets.active.length === 0
            && state.presets.lastSelection?.kind === 'hold',
        },
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
          /** Phase 3: the independent gaze component, its verified gate and its own hold. */
          gazeComponent: gazeComponentSnapshot(),
          gazeComponentPaused: state.motion.posture.gazeComponentPaused,
          gazeComponentTransitions: state.motion.posture.gazeComponentTransitions,
          gazeComponentHistory: state.motion.posture.gazeComponentHistory.map((entry) => ({ ...entry })),
          componentGazeVerified: state.motion.posture.componentGazeVerified === true,
          componentGazeOwnership: state.motion.posture.componentGazeVerified === true
            ? 'plugin' : 'vts-native',
          componentCaps: {
            headSemantic: POSTURE_COMPONENT_MAX_AMPLITUDE,
            headSemanticMin: POSTURE_COMPONENT_MIN_AMPLITUDE,
            headSemanticMax: POSTURE_COMPONENT_MAX_AMPLITUDE,
            headAxisLimit: POSTURE_COMPONENT_AXIS_LIMIT,
            headTargetLimit: POSTURE_COMPONENT_TARGET_LIMIT,
            headMinMs: postureComponentMinMs,
            headMaxMs: postureComponentMaxMs,
            gazeSemantic: POSTURE_GAZE_COMPONENT_MAX_AMPLITUDE,
            gazeDegreesEquivalent: POSTURE_GAZE_COMPONENT_MAX_AMPLITUDE
              * OCCASIONAL_ACTION.DEGREES_PER_POSE_UNIT,
            gazeMinMs: postureGazeComponentMinMs,
            gazeMaxMs: postureGazeComponentMaxMs,
            bodyArmSemanticMin: BODY_ARM_COMPONENT_MIN_AMPLITUDE,
            bodyArmSemanticMax: BODY_ARM_COMPONENT_MAX_AMPLITUDE,
            bodyArmMinMs: bodyComponentMinMs,
            bodyArmMaxMs: bodyComponentMaxMs,
            bodyArmMaxStep,
          },
          /**
           * Phase 4 generic body/shoulder/arm layer: the verified channel gate, the three
           * independent component holds, the base/component/mixed per-frame evidence and the last
           * unsupported expression. `verified` is the only channel set this layer may write.
           */
          bodyArms: {
            channels: [...BODY_ARM_CHANNELS],
            verified: [...state.motion.posture.bodyArms.verified],
            base: { ...state.motion.posture.bodyArms.base },
            component: { ...state.motion.posture.bodyArms.component },
            mixed: { ...state.motion.posture.bodyArms.mixed },
            clamped: { ...state.motion.posture.bodyArms.clamped },
            components: {
              body: bodyArmComponentSnapshot('body'),
              shoulder: bodyArmComponentSnapshot('shoulder'),
              arm: bodyArmComponentSnapshot('arm'),
            },
            paused: state.motion.posture.bodyArms.paused === true,
            transitions: { ...state.motion.posture.bodyArms.transitions },
            history: {
              body: state.motion.posture.bodyArms.history.body.map((entry) => ({ ...entry })),
              shoulder: state.motion.posture.bodyArms.history.shoulder.map((entry) => ({ ...entry })),
              arm: state.motion.posture.bodyArms.history.arm.map((entry) => ({ ...entry })),
            },
            lastTransition: {
              body: state.motion.posture.bodyArms.lastTransition.body === null
                ? null : { ...state.motion.posture.bodyArms.lastTransition.body },
              shoulder: state.motion.posture.bodyArms.lastTransition.shoulder === null
                ? null : { ...state.motion.posture.bodyArms.lastTransition.shoulder },
              arm: state.motion.posture.bodyArms.lastTransition.arm === null
                ? null : { ...state.motion.posture.bodyArms.lastTransition.arm },
            },
            unsupported: state.motion.posture.bodyArms.unsupported,
            lastUnsupported: state.motion.posture.bodyArms.lastUnsupported === null
              ? null : {
                  ...state.motion.posture.bodyArms.lastUnsupported,
                  missingChannels: [...(state.motion.posture.bodyArms.lastUnsupported.missingChannels ?? [])],
                  availableChannels: [...(state.motion.posture.bodyArms.lastUnsupported.availableChannels ?? [])],
                },
            limits: { ...BODY_ARM_CHANNEL_LIMITS },
            baseDegrees: { ...BODY_ARM_BASE_DEGREES },
            /** Real VTS arm direction/visual result has NOT been verified on a machine. */
            visualVerified: false,
            directionBasis: 'semantic positive = raise/open; which VTS sign raises a given arm is TRUE-MACHINE UNVERIFIED',
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
         * Phase 3 unified arbitration evidence (one table for head AND gaze). `componentAfter`
         * is the component share that really survives; `yieldScale` is its factor (1 = no
         * conflict, INTENT_IDLE_RATIO floor = a gesture took the channel). It never rewrites a
         * component target, so the component recovers when the preset exits.
         */
        arbitration: {
          at: state.motion.arbitration.at,
          presetActive: state.motion.arbitration.presetActive,
          head: state.motion.arbitration.head.map((entry) => ({
            ...entry,
            presetIds: [...entry.presetIds],
          })),
          gaze: state.motion.arbitration.gaze.map((entry) => ({
            ...entry,
            presetIds: [...entry.presetIds],
          })),
          /** Newer-owner evidence: an old preset's EXIT/cancel tail that was NOT allowed to write. */
          suppressedExits: (state.motion.arbitration.suppressedExits ?? []).map((entry) => ({ ...entry })),
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
    /** Phase 2: gate the base-activity counters only (privacy lock / disconnect / disposed). */
    setBaseActivityEnabled,
    /** Phase 3: verified+plugin gate for the gaze component (both gazeX and gazeY). */
    setComponentGazeVerified,
    /** Phase 4: the verified body/arm channel gate (bodyX/Y/Z, shoulder/arm/hand L/R). */
    setBodyArmVerified,
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
