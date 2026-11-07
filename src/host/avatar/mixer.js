/** mixer — extracted from avatarRuntime.js; no host entry dependency. */
import { ARBITRATION, LIMITS, clamp01, finite } from './motion-primitives.js';
import { arbitrationFor, clampDomain } from './dynamics.js';

/** Combine base + contribution with the operator the table asks for. */
function combine(spec, baseValue, contribution) {
  if (spec.op === 'add') {
    return clampDomain(baseValue + finite(contribution, 0), spec.domain);
  }
  if (spec.op === 'multiply') {
    return clampDomain(baseValue * finite(contribution, 1), spec.domain);
  }
  return clampDomain(finite(contribution, baseValue), spec.domain);
}


/** Normalise the many accepted gaze shapes into `{x, y}` or null (→ idle drift). */
function normalizeGaze(gaze) {
  if (gaze === null || gaze === undefined || typeof gaze !== 'object') return null;
  if (gaze.active === false) return null;
  const rawX = gaze.x ?? gaze.gazeX;
  const rawY = gaze.y ?? gaze.gazeY;
  const x = Number(rawX);
  const y = Number(rawY);
  if (!Number.isFinite(x) && !Number.isFinite(y)) return null;
  return { x: Number.isFinite(x) ? x : 0, y: Number.isFinite(y) ? y : 0 };
}


/**
 * Compose one Pose from the intent frame and the generator output, following the arbitration
 * table (spec §B): gaze override, head/body/brow add, mouth/breath override, eyes multiply.
 *
 * The eye channels are a *chain*, not a single multiply:
 *
 *   eyeBase = clamp01(expressionEyeOpen × idleEyeBase)
 *   squintBase = clamp01(eyeBase × (1 - squint) × (1 - manualSquint))
 *   if (squint > 0) squintBase = max(min(eyeBase, MIN_EYE_OPEN), squintBase)
 *   eyeOpen = clamp01(squintBase × blinkFactor)
 *
 * The floor therefore protects the squint *baseline* only: blink is the last factor, so a
 * fully closing blink reaches 0 even under the strongest squint.
 *
 * `expressionEyeOpen` (`intent.pose.eyeOpen` / `eyeOpenL` / `eyeOpenR`) is folded into eyeBase
 * *before* the blink factor is applied, which is what makes "expression first, blink second"
 * a structural property of this function: there is no code path where a blink factor can
 * replace the expression value. 0 × factor = 0 therefore holds by construction.
 *
 * Nothing here reads a previous output, so the multiply cannot compound frame over frame.
 *
 * @param {IntentFrame} [intent]
 * @param {Generators} [generators]
 * @param {Record<string, {op?: 'override'|'add'|'multiply', domain?: 'signed'|'unit'}>} [arbitration]
 *   per-channel overrides of ARBITRATION; omitted channels keep the default
 * @returns {Pose}
 */
export function composeChannels(intent = {}, generators = {}, arbitration = ARBITRATION) {
  const frame = intent ?? {};
  const pose = frame.pose ?? {};
  const idle = generators?.idle ?? {};
  const touch = frame.touch ?? {};
  const speaking = frame.speaking === true;
  const blinkFactor = clamp01(finite(generators?.blink?.factor, 1));
  const squint = clamp01(finite(frame.squint, 0));
  const manualSquint = clamp01(finite(pose.eyeSquint, 0));
  const gaze = normalizeGaze(frame.gaze);

  const base = (channel, fallback) => finite(idle[channel], fallback);
  const offset = (...parts) => parts.reduce((sum, value) => sum + finite(value, 0), 0);

  const composed = {
    gazeX: combine(arbitrationFor(arbitration, 'gazeX'), base('gazeX', 0), gaze ? gaze.x : undefined),
    gazeY: combine(arbitrationFor(arbitration, 'gazeY'), base('gazeY', 0), gaze ? gaze.y : undefined),

    headX: combine(arbitrationFor(arbitration, 'headX'), base('headX', 0), offset(pose.headX, touch.headX)),
    headY: combine(arbitrationFor(arbitration, 'headY'), base('headY', 0), offset(pose.headY, touch.headY)),
    headZ: combine(arbitrationFor(arbitration, 'headZ'), base('headZ', 0), offset(pose.headZ, touch.headZ)),

    eyeOpenL: 0,
    eyeOpenR: 0,

    browL: combine(arbitrationFor(arbitration, 'browL'), base('browL', 0), offset(pose.browL, touch.browL)),
    browR: combine(arbitrationFor(arbitration, 'browR'), base('browR', 0), offset(pose.browR, touch.browR)),

    mouth: 0,

    bodyX: combine(arbitrationFor(arbitration, 'bodyX'), base('bodyX', 0), offset(pose.bodyX, touch.bodyX)),
    bodyY: combine(arbitrationFor(arbitration, 'bodyY'), base('bodyY', 0), offset(pose.bodyY, touch.bodyY)),
    bodyZ: combine(arbitrationFor(arbitration, 'bodyZ'), base('bodyZ', 0), offset(pose.bodyZ, touch.bodyZ)),

    breath: 0,
  };

  // ---- eyes: base (expression × idle) first, then the multiply chain ----
  const eyeBase = (idleBase, expressionEye) => clamp01(finite(idleBase, 1) * clamp01(finite(expressionEye, 1)));
  const eyeChain = (channel, idleBase, expressionEye) => {
    const spec = arbitrationFor(arbitration, channel);
    const preBlink = eyeBase(idleBase, expressionEye);
    if (spec.op !== 'multiply') {
      // Custom table: degrade to the generic operator rather than silently ignoring it.
      return combine(spec, preBlink, expressionEye);
    }
    // The 0.2 floor constrains the *squint baseline* only. Blink is applied afterwards, so
    // blinkFactor = 0 always closes the eye completely, whatever the squint value is.
    const squintBase = squint > 0
      ? Math.max(Math.min(preBlink, LIMITS.MIN_EYE_OPEN), preBlink * (1 - squint) * (1 - manualSquint))
      : preBlink * (1 - manualSquint);
    return clamp01(squintBase * blinkFactor);
  };
  const idleEye = generators?.eyeBase ?? {};
  const expressionEyeL = pose.eyeOpenL ?? pose.eyeOpen ?? 1;
  const expressionEyeR = pose.eyeOpenR ?? pose.eyeOpen ?? 1;
  composed.eyeOpenL = eyeChain('eyeOpenL', idleEye.left, expressionEyeL);
  composed.eyeOpenR = eyeChain('eyeOpenR', idleEye.right, expressionEyeR);

  // ---- mouth: speech owns it outright; otherwise the idle mouth curve (normally 0) ----
  const mouthContribution = speaking ? clamp01(finite(frame.mouthLevel, 0)) : base('mouth', 0);
  composed.mouth = combine(arbitrationFor(arbitration, 'mouth'), base('mouth', 0), mouthContribution);

  // ---- breath: override while the breath animation is active, static value otherwise ----
  const breath = generators?.breath ?? {};
  const breathActive = breath.active !== false && Number.isFinite(breath.value);
  composed.breath = combine(
    arbitrationFor(arbitration, 'breath'),
    base('breath', finite(breath.rest, 0.5)),
    breathActive ? breath.value : undefined,
  );

  return composed;
}

export { combine, normalizeGaze };
