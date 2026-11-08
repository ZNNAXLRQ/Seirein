/** motion-config — extracted from avatarRuntime.js; no host entry dependency. */


// ---------------------------------------------------------------------------------------------
// State + intent vocabulary
// ---------------------------------------------------------------------------------------------

/** Host-driven states. They TEMPORARILY scale the persona style; they never rewrite it. */
export const MOTION_STATUSES = Object.freeze(['idle', 'listening', 'thinking', 'speaking', 'waiting', 'tired']);


/**
 * Per-state multipliers applied on top of the persona baseline. Style stays the baseline; a state
 * can only make the motion smaller/slower for as long as it lasts.
 */
const STATUS_MODIFIERS = Object.freeze({
  idle: Object.freeze({ amplitude: 1, tempo: 1, gazeDrift: 1, microNod: 0 }),
  listening: Object.freeze({ amplitude: 0.85, tempo: 0.95, gazeDrift: 0.3, microNod: 0 }),
  thinking: Object.freeze({ amplitude: 0.9, tempo: 0.9, gazeDrift: 0.6, microNod: 0.4 }),
  speaking: Object.freeze({ amplitude: 0.9, tempo: 1, gazeDrift: 1, microNod: 0 }),
  waiting: Object.freeze({ amplitude: 0.75, tempo: 0.85, gazeDrift: 0.9, microNod: 0 }),
  tired: Object.freeze({ amplitude: 0.55, tempo: 0.7, gazeDrift: 0.7, microNod: 0 }),
});


/**
 * Speech owns the mouth, never the body: while a mouth is active the continuous idle parameter
 * frame KEEPS being written, only scaled by this factor (the existing `speaking` status modifier).
 * This is the amplitude the facade applies per frame; it never becomes 0 because of speech.
 */
export const IDLE_SPEECH_SCALE = STATUS_MODIFIERS.speaking.amplitude;


/** Speaking additionally damps the generated head sway to this fraction (independent of the mouth). */
export const SPEECH_HEAD_DAMP = 0.6;


/** One-shot intents an agent may request through `runtime.intent(kind)`. */
export const INTENT_KINDS = Object.freeze(['nod', 'lookAtUser', 'tilt', 'surprise']);


/**
 * Channels each intent wants to drive. A host must intersect this with the VERIFIED channel set:
 * an unadapted channel is skipped and recorded, never written with a guessed input name.
 *
 * Channel semantics (VTS `FaceAngle*` is a *tracking input*, not a Live2D parameter):
 *   nod        → headY (pitch) with a trace of headZ roll; headX is a left/right TURN, never a nod
 *   tilt       → headX (yaw) / headZ (roll)
 *   lookAtUser → gazeX / gazeY (only when the gaze channels are taken over)
 *   surprise   → eyeOpenL/eyeOpenR (eyes wide) + headZ (roll)
 * Only taken-over (controlled + verified) channels are ever written; the rest are recorded skip.
 */
export const INTENT_CHANNEL_TARGETS = Object.freeze({
  nod: Object.freeze(['headY', 'headZ']),
  lookAtUser: Object.freeze(['gazeX', 'gazeY']),
  tilt: Object.freeze(['headX', 'headZ']),
  surprise: Object.freeze(['eyeOpenL', 'eyeOpenR', 'headZ']),
});


/**
 * The channels one intent may drive, profile included. A profile may EXTEND the selected intent
 * with an already-mapped channel (the confused tilt adds the brows); it can never change which
 * intent the event table selected, and it never invents a channel→input mapping.
 *
 * @param {string} kind intent name
 * @param {string|null} profile profile id from `motionEvents.js`, or null
 * @returns {string[]} channel names (the intent's own targets first)
 */
export function intentChannelsFor(kind, profile = null) {
  const base = INTENT_CHANNEL_TARGETS[String(kind ?? '')] ?? [];
  const extra = String(profile ?? '') === 'confused' ? CONFUSED_BROW_CHANNELS : [];
  return [...base, ...extra];
}


/**
 * P-139 stage 3 — replacement variants for one intent. A variant changes ONLY expression:
 * `amplitude` / `duration` scale the gesture and `headX` / `headZ` are the axis ratios used by
 * `intentFrame` (a nod still never touches headX, so its variant carries headZ only). The intent
 * name, its channel targets and therefore the event → intent selection stay untouched.
 *
 * Selection is a seeded draw over this list and the previous variant of the SAME intent is skipped,
 * so two identical intents in a row never look mechanically identical.
 */
export const INTENT_VARIANTS = Object.freeze({
  nod: Object.freeze([
    Object.freeze({ id: 'nod-small', amplitude: 0.92, duration: 0.94, headZ: 0.13 }),
    Object.freeze({ id: 'nod-deep', amplitude: 1.08, duration: 1.10, headZ: 0.23 }),
    Object.freeze({ id: 'nod-quick', amplitude: 1.00, duration: 0.82, headZ: 0.18 }),
  ]),
  tilt: Object.freeze([
    Object.freeze({ id: 'tilt-narrow', amplitude: 0.92, duration: 0.96, headX: 0.42, headZ: 0.90 }),
    Object.freeze({ id: 'tilt-wide', amplitude: 1.08, duration: 1.12, headX: 0.58, headZ: 1.10 }),
    Object.freeze({ id: 'tilt-quick', amplitude: 1.00, duration: 0.82, headX: 0.50, headZ: 0.96 }),
  ]),
  surprise: Object.freeze([
    Object.freeze({ id: 'surprise-light', amplitude: 0.90, duration: 0.92, headZ: 0.28 }),
    Object.freeze({ id: 'surprise-wide', amplitude: 1.10, duration: 1.12, headZ: 0.42 }),
    Object.freeze({ id: 'surprise-quick', amplitude: 1.00, duration: 0.80, headZ: 0.35 }),
  ]),
  lookAtUser: Object.freeze([
    Object.freeze({ id: 'gaze-short', amplitude: 0.92, duration: 0.86 }),
    Object.freeze({ id: 'gaze-hold', amplitude: 1.06, duration: 1.14 }),
    Object.freeze({ id: 'gaze-soft', amplitude: 1.00, duration: 1.00 }),
  ]),
});


/** Dimension → expression multipliers. Kept as named constants so the tests can name the bounds. */
export const STYLE_DIMENSION_APPLICATION = Object.freeze({
  amplitudeBase: 0.85,
  amplitudeSpan: 0.30,
  restraintCap: 0.15,
  durationBase: 0.70,
  durationSpan: 0.60,
  livelinessTempo: 0.20,
});


/** How long an ended intent keeps its channels flushed while the pose settles back to baseline. */
const INTENT_SETTLE_MS = 1600;


/**
 * Same-frame priority: while an explicit gesture drives a channel, the idle micro-motion on that
 * channel may only contribute this fraction of the gesture magnitude. The gesture itself is added
 * after that limit, so an action can never be cancelled or diluted by the idle curve. Written as a
 * constant so the bound is visible to hosts and tests (never an inline magic number).
 */
export const INTENT_IDLE_RATIO = 0.2;


/**
 * What a discrete idle action needs from the parameter engine: `required` is the full gesture,
 * `degraded` the ordered single-channel substitutes allowed when only part of it is taken over.
 * An action with none of these mapped leaves the pool entirely and is never sampled again.
 */
export const IDLE_ACTION_CHANNELS = Object.freeze({
  nod: Object.freeze({
    required: Object.freeze(['headY', 'headZ']),
    degraded: Object.freeze(['headY', 'headZ', 'headX']),
  }),
  glance: Object.freeze({
    required: Object.freeze(['gazeX', 'gazeY']),
    degraded: Object.freeze(['gazeX', 'gazeY']),
  }),
  tilt: Object.freeze({ required: Object.freeze(['headX']), degraded: Object.freeze(['headX', 'headZ']) }),
  sway: Object.freeze({ required: Object.freeze(['headX']), degraded: Object.freeze(['headX', 'headZ']) }),
});


/** Equivalent one-shot intents for a degraded action: the first with a mapped channel wins. */
export const IDLE_ACTION_INTENTS = Object.freeze({
  nod: Object.freeze(['nod', 'tilt']),
  glance: Object.freeze(['lookAtUser']),
  tilt: Object.freeze(['tilt']),
  sway: Object.freeze(['tilt']),
});


/**
 * Micro-motion gain when exactly ONE idle channel is taken over: one small channel still has to
 * read as "alive". It multiplies before the amplitude cap and before the per-frame idleMaxStep
 * limiter, so the motion grows without becoming jittery.
 */
export const ALIVE_FALLBACK_GAIN = 1.5;


/** The confused gesture's extra channels: already-mapped brow channels, never a new mapping. */
export const CONFUSED_BROW_CHANNELS = Object.freeze(['browL', 'browR']);


// ---------------------------------------------------------------------------------------------
// Motion preset execution (presets/README.md protocol → the ONE 30 Hz controller)
// ---------------------------------------------------------------------------------------------

/**
 * Channels a preset operation may drive. A preset is executed as a sequence of symbolic
 * operations, never mapped back to the four legacy intents: each entry is the operation's own
 * channel set, and the executor drops a channel only when the operation itself is one-sided
 * (`brow-one` without `browR`).
 */
export const PRESET_OPERATION_CHANNELS = Object.freeze({
  'head-turn': Object.freeze(['headX']),
  'head-lower': Object.freeze(['headY']),
  'head-lift': Object.freeze(['headY']),
  'head-tilt': Object.freeze(['headZ']),
  'head-center': Object.freeze(['headX', 'headZ']),
  nod: Object.freeze(['headY']),
  'double-nod': Object.freeze(['headY']),
  shake: Object.freeze(['headX']),
  'gaze-side': Object.freeze(['gazeX']),
  'gaze-down': Object.freeze(['gazeY']),
  'gaze-up': Object.freeze(['gazeY']),
  'gaze-target': Object.freeze(['gazeX', 'gazeY']),
  'gaze-center': Object.freeze(['gazeX', 'gazeY']),
  blink: Object.freeze(['eyeOpenL', 'eyeOpenR']),
  'double-blink': Object.freeze(['eyeOpenL', 'eyeOpenR']),
  'brow-lift': Object.freeze(['browL', 'browR']),
  'brow-knit': Object.freeze(['browL', 'browR']),
  'brow-one': Object.freeze(['browL', 'browR']),
  'body-lean': Object.freeze(['bodyX']),
  'body-settle': Object.freeze(['bodyY']),
  'body-tilt': Object.freeze(['bodyZ']),
  'breath-cycle': Object.freeze(['breath']),
});

/** One-sided operations: the unverified side is dropped, the verified side still executes. */
export const PRESET_OPTIONAL_OPERATION_CHANNELS = Object.freeze({
  'brow-one': Object.freeze(['browR']),
});

/**
 * Body and breath keep VTS's own native animation ownership. The preset executor NEVER writes
 * them, so a preset that needs one is not a legal candidate at all — it is filtered out before
 * scoring instead of being silently executed as a partial gesture.
 */
export const PRESET_NATIVE_CHANNELS = Object.freeze(['bodyX', 'bodyY', 'bodyZ', 'breath']);

/**
 * Qualitative timing vocabulary from the library. Durations are resolved by the executor from
 * the persona tempo and the current posture; the numbers here are the only tuning surface.
 * There is deliberately NO visible-amplitude floor: a quiet persona may execute a smaller
 * gesture, and standing still (a hold draw) is a first-class outcome.
 */
export const PRESET_EXECUTION = Object.freeze({
  /** Cross-fade into the first operation and out of the last one (ms at tempo 1). */
  ENTER_MS: 180,
  EXIT_MS: 240,
  /** `release: 'unhurried'` stretches the exit. */
  UNHURRIED_EXIT_MS: 460,
  /** `pause-before`: the quiet beat before the first active motion. */
  PAUSE_BEFORE_MS: 320,
  /** `separated`: the gap between two operations; `connected` overlaps their exit/entry. */
  SEPARATED_GAP_MS: 180,
  CONNECTED_OVERLAP_RATIO: 0.55,
  /** The prepare leg is a small opposite-direction wind-up, as seen by the current pose. */
  PREPARE_RATIO: 0.18,
  PREPARE_MS: 140,
  /** `hold: 'brief'` / `'lingering'` after an operation's active phase. */
  HOLD_MIN_MS: 160,
  HOLD_LINGER_MS: 720,
  /** Per-operation active durations (tempo-scaled); one unit = 30° for head channels. */
  TURN_ACTIVE_MS: 620,
  TILT_ACTIVE_MS: 640,
  NOD_ACTIVE_MS: 430,
  DOUBLE_NOD_ACTIVE_MS: 780,
  SHAKE_ACTIVE_MS: 620,
  GAZE_ACTIVE_MS: 540,
  BLINK_ACTIVE_MS: 170,
  DOUBLE_BLINK_ACTIVE_MS: 380,
  BROW_ACTIVE_MS: 430,
  /** Headroom kept under the hardest pose limit; a direction with less room is not chosen. */
  HEADROOM_MARGIN: 0.08,
  /** A long run of draws without a legal candidate must not spin every frame. */
  DECISION_MIN_MS: 2_000,
  DECISION_MAX_MS: 9_000,
  /** Bounded trace history/samples: evidence, never another writer. */
  TRACE_LIMIT: 8,
  SAMPLE_LIMIT: 96,
});

export { STATUS_MODIFIERS, INTENT_SETTLE_MS };
