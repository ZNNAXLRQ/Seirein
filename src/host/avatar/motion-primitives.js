/** motion-primitives — extracted from avatarRuntime.js; no host entry dependency. */


/** Every channel the runtime produces, in a stable order (matches avatarMotion.CHANNEL_ORDER). */
export const CHANNELS = Object.freeze([
  'gazeX',
  'gazeY',
  'headX',
  'headY',
  'headZ',
  'eyeOpenL',
  'eyeOpenR',
  'browL',
  'browR',
  'mouth',
  'bodyX',
  'bodyY',
  'bodyZ',
  'breath',
]);


/**
 * Channels the host may drive as a continuous idle parameter frame: head angles, eye open and
 * gaze. Idle generation itself is not limited to these channels, but the transport only injects
 * what discovery mapped here.
 */
export const IDLE_PARAM_CHANNELS = Object.freeze([
  'gazeX',
  'gazeY',
  'headX',
  'headY',
  'headZ',
  'eyeOpenL',
  'eyeOpenR',
]);


/**
 * Channels the continuous idle frame may actually inject. Gaze is deliberately absent: idle sway
 * lives on the three head axes plus (opt-in) eye-open, so an idle frame never fights a gaze/emotion
 * and — structurally — never writes brows. Brows are written only for an explicit emotional pose.
 */
export const IDLE_WRITE_CHANNELS = Object.freeze([
  'headX',
  'headY',
  'headZ',
  'eyeOpenL',
  'eyeOpenR',
]);


/**
 * Extra channels an explicit one-shot intent may write while it is active (still verified-only).
 * Idle frames never include these; only `intent()` opens them, and only for its settle window.
 */
export const INTENT_WRITE_CHANNELS = Object.freeze([
  'gazeX',
  'gazeY',
  'browL',
  'browR',
  'bodyX',
  'bodyY',
  'bodyZ',
]);


/**
 * Bipolar channels live in [-1, 1] and are expected to be injected into an input whose own
 * range may be anything (-1..1, -30..30, …). Unipolar channels live in [0, 1].
 */
const BIDIRECTIONAL_CHANNELS = new Set([
  'gazeX',
  'gazeY',
  'headX',
  'headY',
  'headZ',
  'browL',
  'browR',
  'bodyX',
  'bodyY',
  'bodyZ',
]);


/** @param {string} channel @returns {boolean} true when the channel is bipolar (-1..1). */
export const isBidirectional = (channel) => BIDIRECTIONAL_CHANNELS.has(channel);


const SPRING_AXES = Object.freeze(['headX', 'headY', 'headZ', 'bodyX', 'bodyY', 'bodyZ']);


// ---------------------------------------------------------------------------------------------
// Constants (all documented against their upstream source)
// ---------------------------------------------------------------------------------------------

/** Blink state machine — AIRI motion-manager.ts, identical numbers. */
export const BLINK = Object.freeze({
  CLOSE_MS: 75,
  OPEN_MIN_MS: 150,
  OPEN_MAX_MS: 300,
  DELAY_MIN_MS: 3000,
  DELAY_MAX_MS: 8000,
});


/** Hard limits / smoothing rules from the arbitration table (spec §B, §C). */
export const LIMITS = Object.freeze({
  /** Long frames must never blow the spring up (AIRI clamps elapsedSeconds to 0.05). */
  MAX_STEP_SECONDS: 0.05,
  /** Internal sub-step for the semi-implicit Euler integration (see stepSpringAxis). */
  SPRING_SUBSTEP_SECONDS: 1 / 240,
  /** AIRI `minimumEyeOpen`: keeps a squint from pushing the eye under the blink threshold. */
  MIN_EYE_OPEN: 0.2,
  /** AIRI `BLINK_THRESHOLD`: below this pre-blink baseline a blink is not started at all. */
  BLINK_THRESHOLD: 0.15,
  /** Light squint falls back at 0.25 / s (it only rises instantly). */
  SQUINT_DECAY_PER_SECOND: 0.25,
  /** Brow slope limit from the arbitration table: ≤ 6 / s. */
  BROW_SLOPE_PER_SECOND: 6,
});


/** Time constants taken from the reference implementations (spec §B, §D, §E). */
export const TIMING = Object.freeze({
  /** LipSync cross-fade length (AIRI `RELEASE_DURATION_MS`). */
  RELEASE_DURATION_MS: 200,
  /** After the fade the mouth is held closed for this long (AIRI `HANDOFF_HOLD_MS`). */
  HANDOFF_HOLD_MS: 500,
  /** One mouth level per 100 ms — index.js samples the envelope at 10 Hz. */
  MOUTH_STEP_MS: 100,
  /** Gaze first-order follow constant (focus-bias.ts `followSeconds`). */
  GAZE_FOLLOW_SECONDS: 0.12,
  /** Gaze weight fade when a target appears / disappears (focus-bias.ts `fadeSeconds`). */
  GAZE_FADE_SECONDS: 0.4,
  /** Breath period range: 3–5 s in EVERY state, so a speaking speed-up can never race the chest. */
  BREATH_PERIOD_MIN_MS: 3000,
  BREATH_PERIOD_MAX_MS: 5000,
  /** Compute at 30 Hz, flush at 10 Hz (spec §E.1, vts.js MIN_GAP_MS = 100). */
  COMPUTE_HZ: 30,
  FLUSH_INTERVAL_MS: 100,
  /** A single inject request must not wait 10 000 ms (spec §E.3). */
  INJECT_TIMEOUT_MS: 800,
});


/**
 * The breath generator's own shape. It is a slow, small cycle in every state: idle keeps the
 * configured period, speaking shortens it by at most 1.1× (3600 ms → ~3273 ms), and the effective
 * period is always clamped into the 3–5 s window above. Speech micro-motion lives on headY, breath
 * on its own channel, so the two never overwrite each other.
 */
export const BREATH = Object.freeze({
  /** Speaking may shorten the cycle by this factor, never more (period stays inside 3–5 s). */
  SPEAKING_SPEED: 1.1,
  /** Peak excursion around the 0.5 rest value before the style amplitude is applied. */
  AMPLITUDE: 0.35,
});


/**
 * Channel arbitration table (spec §B). `op` is how the intent layer combines with the base
 * (generator) value; `domain` says which clamp applies. Eye channels use `multiply`, but their
 * combination is a *chain* (base × blink × (1-squint)), implemented by composeChannels.
 */
export const ARBITRATION = Object.freeze({
  gazeX: Object.freeze({ domain: 'signed', op: 'override' }),
  gazeY: Object.freeze({ domain: 'signed', op: 'override' }),
  headX: Object.freeze({ domain: 'signed', op: 'add' }),
  headY: Object.freeze({ domain: 'signed', op: 'add' }),
  headZ: Object.freeze({ domain: 'signed', op: 'add' }),
  eyeOpenL: Object.freeze({ domain: 'unit', op: 'multiply' }),
  eyeOpenR: Object.freeze({ domain: 'unit', op: 'multiply' }),
  browL: Object.freeze({ domain: 'signed', op: 'add' }),
  browR: Object.freeze({ domain: 'signed', op: 'add' }),
  mouth: Object.freeze({ domain: 'unit', op: 'override' }),
  bodyX: Object.freeze({ domain: 'signed', op: 'add' }),
  bodyY: Object.freeze({ domain: 'signed', op: 'add' }),
  bodyZ: Object.freeze({ domain: 'signed', op: 'add' }),
  breath: Object.freeze({ domain: 'unit', op: 'override' }),
});


// ---------------------------------------------------------------------------------------------
// Small numeric helpers (exported only where a caller/test genuinely needs them)
// ---------------------------------------------------------------------------------------------

const finite = (value, fallback) => (Number.isFinite(value) ? value : fallback);


/** Clamp into [0, 1]; NaN falls back to 0. */
export const clamp01 = (value) => (value <= 0 ? 0 : value >= 1 ? 1 : finite(value, 0));


/** Clamp into [-1, 1]; NaN falls back to 0. */
export const clampSigned = (value) => (value <= -1 ? -1 : value >= 1 ? 1 : finite(value, 0));


/**
 * Deterministic PRNG (mulberry32). A fixed `config.seed` makes every random choice — blink
 * timing, posture draws, idle-action candidates — reproducible, which is what lets a test
 * assert one trajectory twice. The returned function is a drop-in `random()` in [0, 1).
 */
export function createSeededRandom(seed) {
  let h = 2166136261 >>> 0;
  const text = String(seed ?? '');
  for (let index = 0; index < text.length; index += 1) {
    h ^= text.charCodeAt(index);
    h = Math.imul(h, 16777619) >>> 0;
  }
  let state = h >>> 0;
  return function seededRandom() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}


/** Stable 32-bit hash, used to give each motion axis its own deterministic noise stream. */
const hash32 = (seed, salt) => {
  let h = (2166136261 ^ (seed >>> 0)) >>> 0;
  const text = String(salt ?? '');
  for (let index = 0; index < text.length; index += 1) {
    h ^= text.charCodeAt(index);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
};


/** Deterministic value in [0, 1) from a seed and an integer lattice point. */
const latticeValue = (seed, index) => {
  let t = (seed + Math.imul(index | 0, 0x9e3779b1)) >>> 0;
  t = Math.imul(t ^ (t >>> 16), 0x7feb352d) >>> 0;
  t = Math.imul(t ^ (t >>> 15), 0x846ca68b) >>> 0;
  return ((t ^ (t >>> 16)) >>> 0) / 4294967296;
};


/**
 * One-dimensional smooth value noise in [-1, 1]. Cubic smoothing makes both value and slope
 * continuous, so a sampled trajectory has no positional or velocity discontinuity at a lattice
 * knot; the caller's rate/acceleration limiter bounds the second derivative.
 */
const smoothNoise1 = (seed, x) => {
  const base = Math.floor(x);
  const f = x - base;
  const a = latticeValue(seed, base);
  const b = latticeValue(seed, base + 1);
  const u = f * f * (3 - 2 * f);
  return (a + (b - a) * u) * 2 - 1;
};


/** AIRI idle blink easing. */
const easeOutQuad = (t) => 1 - (1 - t) * (1 - t);

const easeInQuad = (t) => t * t;


/** `smoothstep(t) = t²(3-2t)` — AIRI lip-sync release curve. */
export const smoothstep = (t) => {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
};


const randomDelayMs = (random) => {
  const u = clamp01(finite(random(), 0));
  return BLINK.DELAY_MIN_MS + u * (BLINK.DELAY_MAX_MS - BLINK.DELAY_MIN_MS);
};


const randomOpenMs = (random) => {
  const u = clamp01(finite(random(), 0));
  return BLINK.OPEN_MIN_MS + u * (BLINK.OPEN_MAX_MS - BLINK.OPEN_MIN_MS);
};

export {
  BIDIRECTIONAL_CHANNELS,
  SPRING_AXES,
  finite,
  hash32,
  latticeValue,
  smoothNoise1,
  easeOutQuad,
  easeInQuad,
  randomDelayMs,
  randomOpenMs,
};
