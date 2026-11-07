/** dynamics — extracted from avatarRuntime.js; no host entry dependency. */
import {
  ARBITRATION,
  BLINK,
  LIMITS,
  clamp01,
  clampSigned,
  easeInQuad,
  easeOutQuad,
  finite,
  randomDelayMs,
  randomOpenMs,
} from './motion-primitives.js';

// ---------------------------------------------------------------------------------------------
// Blink — AIRI motion-manager.ts state machine
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {Object} BlinkState
 * @property {'idle'|'closing'|'opening'} phase
 * @property {number} elapsed   ms spent in the current phase
 * @property {number} duration  ms the current phase lasts (0 while idle)
 * @property {number} delayMs   idle wait before the next blink
 * @property {number} baseline  pre-blink eye open value (expression included), 0..1
 */

/**
 * Fresh idle blink state. `random` is injected so tests get deterministic timings.
 *
 * @param {{delayMs?: number, baseline?: number, random?: () => number}} [options]
 * @returns {BlinkState}
 */
export function createBlinkState({ delayMs, baseline = 1, random = Math.random } = {}) {
  return {
    phase: 'idle',
    elapsed: 0,
    duration: 0,
    delayMs: Number.isFinite(delayMs) ? Math.max(0, delayMs) : randomDelayMs(random),
    baseline: clamp01(baseline),
  };
}


/**
 * Advance the blink state machine by one frame.
 *
 * idle → closing → opening → idle
 *   closing: p += dt/75 ms           factor = 1 - easeOutQuad(p)   (1 → 0)
 *   opening: p += dt/openMs ms       factor = easeInQuad(p)        (0 → 1)
 *
 * `baseline` is the *pre-blink* eye value (expression × idle base). While it is ≤ 0.15 no blink
 * is started — AIRI's `BLINK_THRESHOLD`. A blink already in flight is allowed to finish, so a
 * closed-eye expression never leaves the eyes stuck mid-blink.
 *
 * @param {BlinkState} state
 * @param {number} dtSeconds elapsed time for this frame
 * @param {{random?: () => number}} [options] injectable RNG (delay + open duration)
 * @returns {{factor: number, state: BlinkState}} factor is 1 = fully open, 0 = fully shut
 */
export function stepBlink(state, dtSeconds, { random = Math.random } = {}) {
  const source = state !== null && typeof state === 'object' ? state : createBlinkState({ random });
  const baseline = clamp01(finite(source.baseline, 1));
  const deltaMs = Math.max(0, finite(dtSeconds, 0) * 1000);
  const phase = source.phase === 'closing' || source.phase === 'opening' ? source.phase : 'idle';
  const duration = Math.max(0, finite(source.duration, 0));
  const delayMs = Math.max(0, finite(source.delayMs, 0));

  // Suppress *starting* a blink on an eye that an expression already closed.
  if (phase === 'idle' && baseline <= LIMITS.BLINK_THRESHOLD) {
    return { factor: 1, state: { phase, elapsed: 0, duration: 0, delayMs, baseline } };
  }

  let elapsed = Math.max(0, finite(source.elapsed, 0)) + deltaMs;

  if (phase === 'idle') {
    if (elapsed < delayMs) {
      return { factor: 1, state: { phase, elapsed, duration: 0, delayMs, baseline } };
    }
    return stepClosing(elapsed - delayMs, baseline, random);
  }
  if (phase === 'closing') {
    return stepClosing(elapsed, baseline, random, duration || BLINK.CLOSE_MS);
  }

  // opening: factor 0 → 1, then back to idle with a fresh random delay
  const openDuration = duration > 0 ? duration : BLINK.OPEN_MIN_MS;
  if (elapsed >= openDuration) {
    return {
      factor: 1,
      state: { phase: 'idle', elapsed: 0, duration: 0, delayMs: randomDelayMs(random), baseline },
    };
  }
  return {
    factor: easeInQuad(clamp01(elapsed / openDuration)),
    state: { phase: 'opening', elapsed, duration: openDuration, delayMs: 0, baseline },
  };
}


/** One closing step; also handles the closing → opening hand-off (and a huge dt edge case). */
function stepClosing(elapsedMs, baseline, random, duration = BLINK.CLOSE_MS) {
  if (elapsedMs >= duration) {
    const overflow = elapsedMs - duration;
    const openDuration = randomOpenMs(random);
    if (overflow >= openDuration) {
      return {
        factor: 1,
        state: { phase: 'idle', elapsed: 0, duration: 0, delayMs: randomDelayMs(random), baseline },
      };
    }
    return {
      factor: easeInQuad(clamp01(overflow / openDuration)),
      state: { phase: 'opening', elapsed: overflow, duration: openDuration, delayMs: 0, baseline },
    };
  }
  return {
    factor: 1 - easeOutQuad(clamp01(elapsedMs / duration)),
    state: { phase: 'closing', elapsed: elapsedMs, duration, delayMs: 0, baseline },
  };
}


// ---------------------------------------------------------------------------------------------
// Springs — AIRI motion-control-spring.ts (semi-implicit Euler)
// ---------------------------------------------------------------------------------------------

/**
 * Map the two artist-facing knobs onto physical spring parameters.
 *
 *   k = 30 + 190·follow          m = 0.75 + 2.25·inertia
 *   ζ = 1 - 0.75·inertia         c = 2ζ√(k·m)
 *
 * ζ = 1 at inertia 0 (critical damping, no overshoot); ζ = 0.25 at inertia 1.
 *
 * @param {{follow?: number, inertia?: number}} [options]
 * @returns {{stiffness: number, damping: number, mass: number}}
 */
export function springParams({ follow = 1, inertia = 0 } = {}) {
  const f = clamp01(finite(follow, 0));
  const i = clamp01(finite(inertia, 0));
  const stiffness = 30 + 190 * f;
  const mass = 0.75 + 2.25 * i;
  const zeta = 1 - 0.75 * i;
  const damping = 2 * zeta * Math.sqrt(stiffness * mass);
  return { stiffness, damping, mass };
}


/**
 * One axis of a damped spring, integrated with semi-implicit Euler exactly like AIRI:
 *
 *   a = (-k·(x - target) - c·v) / m
 *   v += a·dt
 *   x += v·dt
 *
 * `dt` is clamped to 50 ms. On top of that the clamped frame is split into internal
 * sub-steps (1/240 s) so a critical spring stays monotone at the 30 Hz tick rate — a single
 * 50 ms Euler step with k = 220 / m = 0.75 does overshoot, which would show up as head jitter.
 *
 * @param {{current?: number, target?: number, velocity?: number, dt?: number,
 *          stiffness?: number, damping?: number, mass?: number}} [axis]
 * @returns {{current: number, velocity: number}}
 */
export function stepSpringAxis({
  current = 0,
  target = 0,
  velocity = 0,
  dt = 0,
  stiffness = 30,
  damping = 0,
  mass = 1,
} = {}) {
  const x0 = finite(current, 0);
  const v0 = finite(velocity, 0);
  const goal = finite(target, 0);
  const k = Math.max(0, finite(stiffness, 0));
  const c = Math.max(0, finite(damping, 0));
  const m = Math.max(1e-6, finite(mass, 1));
  const frame = Math.min(Math.max(finite(dt, 0), 0), LIMITS.MAX_STEP_SECONDS);
  if (frame <= 0) return { current: x0, velocity: v0 };

  const steps = Math.max(1, Math.ceil(frame / LIMITS.SPRING_SUBSTEP_SECONDS));
  const h = frame / steps;
  let x = x0;
  let v = v0;
  for (let index = 0; index < steps; index += 1) {
    const acceleration = (-k * (x - goal) - c * v) / m;
    v += acceleration * h;
    x += v * h;
  }
  return { current: x, velocity: v };
}


// ---------------------------------------------------------------------------------------------
// Quantisation — semantic value → that input's own min/max (spec §C.1)
// ---------------------------------------------------------------------------------------------

/**
 * Map a semantic value onto a VTS input's own range. The range always comes from
 * InputParameterListRequest — never hard-code `-1..1` / `0..1`.
 *
 *   unipolar   v = min + clamp01(u)·(max - min)
 *   bipolar    v = min + (clamp(u, -1, 1) + 1)/2·(max - min)
 *
 * A degenerate range (`max <= min`) cannot be interpolated, so the entry's own neutral value is
 * used: `entry.defaultValue ?? entry.min` (falling back to the raw min when even that is absent).
 *
 * @param {{min?: number, max?: number, defaultValue?: number}|null} entry
 * @param {number} u semantic value
 * @param {{bidirectional?: boolean}} [options]
 * @returns {number}
 */
export function toInputValue(entry, u, { bidirectional = false } = {}) {
  const min = Number(entry?.min ?? 0);
  const max = Number(entry?.max ?? 1);
  if (!(max > min)) {
    const fallback = entry?.defaultValue;
    const value = fallback === undefined || fallback === null ? min : Number(fallback);
    return Number.isFinite(value) ? value : min;
  }
  const t = bidirectional
    ? (Math.max(-1, Math.min(1, finite(u, 0))) + 1) / 2
    : clamp01(finite(u, 0));
  return min + t * (max - min);
}


// ---------------------------------------------------------------------------------------------
// Composition — the arbitration table, in the float domain
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {{ [channel: string]: number }} Pose
 * Semantic pose: bipolar channels ∈ [-1, 1], unipolar channels ∈ [0, 1].
 */

/**
 * @typedef {Object} IntentFrame
 * @property {number} [turnId]
 * @property {boolean} [speaking]       speech envelope owns the mouth
 * @property {number} [mouthLevel]      0..1
 * @property {{x?: number, y?: number, active?: boolean}|null} [gaze]
 *   explicit gaze target; `active: false` (or null) falls back to the idle drift
 * @property {Pose} [pose]              expression / manual pose (eyeOpen, headX, browL, …)
 * @property {number} [squint]          0..1 ambient "light squint"
 * @property {{headX?: number, headY?: number, headZ?: number, browL?: number, browR?: number,
 *             bodyX?: number, bodyY?: number, bodyZ?: number}} [touch]
 *   additive touch/hit offsets (spec §A.3 step 12: addParameterValueById semantics)
 * @property {{idle?: boolean, breathing?: boolean}} [flags]
 *   `idle: false` removes every idle-generated component (gaze drift, head/body sway); breathing
 *   stays available because it is a separate generator (`breathing: false` disables it)
 */

/**
 * @typedef {Object} Generators
 * @property {{factor?: number, baseline?: number}} [blink]  from stepBlink
 * @property {{left?: number, right?: number}} [eyeBase]      idle eye base (1.0 normally)
 * @property {Pose} [idle]                                   idle curve we generated ourselves
 * @property {{active?: boolean, value?: number, rest?: number}} [breath]
 */

const arbitrationFor = (arbitration, channel) => {
  const spec = arbitration?.[channel] ?? ARBITRATION[channel];
  if (spec === null || typeof spec !== 'object') return { op: 'override', domain: 'signed' };
  return { op: spec.op ?? 'override', domain: spec.domain ?? 'signed' };
};


const clampDomain = (value, domain) => (domain === 'unit' ? clamp01(value) : clampSigned(value));

export { stepClosing, arbitrationFor, clampDomain };
