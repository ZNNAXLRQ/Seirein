/** style — extracted from avatarRuntime.js; no host entry dependency. */
import { clamp01, finite, hash32 } from './motion-primitives.js';

// ---------------------------------------------------------------------------------------------
// Persona-driven motion style
// ---------------------------------------------------------------------------------------------
//
// The persona is converted ONCE, in the background, into this small structured style. Chat and
// tick only ever read the cached object: no model call, no persona parse, no extra wait. Every
// field is clamped to its range and every unknown field is ignored, so a hallucinated value can
// never become a parameter. Omitted fields keep the previous value (`normalizeAvatarStyle` merges
// over `base`), which is what makes a partial style refresh lazy instead of a full re-randomize.

/** Closed range + default for every numeric style field. */
export const AVATAR_STYLE_RANGES = Object.freeze({
  amplitude: Object.freeze({ min: 0.2, max: 1.5, default: 1 }),
  tempo: Object.freeze({ min: 0.6, max: 1.6, default: 1 }),
  expressiveness: Object.freeze({ min: 0.3, max: 1.5, default: 1 }),
  nodAmplitude: Object.freeze({ min: 0.2, max: 1.5, default: 1 }),
  nodDurationMs: Object.freeze({ min: 250, max: 900, default: 450 }),
  tiltChance: Object.freeze({ min: 0, max: 0.5, default: 0.15 }),
});


/**
 * Per-channel amplitude range. A channel the persona does not mention keeps the global
 * `amplitude`; an unknown channel name is ignored. Only taken-over (controlled+verified)
 * channels are ever written, so this table never enables a channel by itself.
 */
export const AVATAR_STYLE_CHANNEL_RANGES = Object.freeze({
  headX: Object.freeze({ min: 0.2, max: 1.5 }),
  headY: Object.freeze({ min: 0.2, max: 1.5 }),
  headZ: Object.freeze({ min: 0.2, max: 1.5 }),
  eyeOpenL: Object.freeze({ min: 0.05, max: 1 }),
  eyeOpenR: Object.freeze({ min: 0.05, max: 1 }),
  gazeX: Object.freeze({ min: 0.2, max: 1.5 }),
  gazeY: Object.freeze({ min: 0.2, max: 1.5 }),
  bodyX: Object.freeze({ min: 0.2, max: 1.5 }),
  breath: Object.freeze({ min: 0.2, max: 1.5 }),
});


/** Gaze habits a persona may select. */
export const AVATAR_GAZE_HABITS = Object.freeze(['steady', 'wandering', 'direct']);


/** Every accepted style field (numbers, the gaze enum and the per-channel overrides). */
export const AVATAR_STYLE_FIELDS = Object.freeze([
  'amplitude',
  'tempo',
  'gazeHabit',
  'expressiveness',
  'nodAmplitude',
  'nodDurationMs',
  'tiltChance',
  'channels',
]);


/** Default style: neutral amplitude/tempo, steady gaze, no channel override. */
export const DEFAULT_AVATAR_STYLE = Object.freeze({
  amplitude: 1,
  tempo: 1,
  gazeHabit: 'steady',
  expressiveness: 1,
  nodAmplitude: 1,
  nodDurationMs: 450,
  tiltChance: 0.15,
  channels: Object.freeze({}),
});


const clampStyleNumber = (key, value, fallback) => {
  const range = AVATAR_STYLE_RANGES[key];
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(range.max, Math.max(range.min, number));
};


/** Clamp one channel amplitude; `null` means "not a number, keep the previous value". */
const clampChannelAmplitude = (channel, value) => {
  const range = AVATAR_STYLE_CHANNEL_RANGES[channel];
  const number = Number(value);
  if (range === undefined || !Number.isFinite(number)) return null;
  return Math.min(range.max, Math.max(range.min, number));
};


/** Copy/merge the per-channel override map, dropping unknown channels and invalid values. */
const coerceStyleChannels = (input, prior = {}) => {
  const out = {};
  const copy = (source) => {
    if (source === null || typeof source !== 'object' || Array.isArray(source)) return;
    for (const [channel, spec] of Object.entries(source)) {
      if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) continue;
      const amplitude = clampChannelAmplitude(channel, spec.amplitude);
      if (amplitude !== null) out[channel] = { amplitude };
    }
  };
  copy(prior);
  copy(input);
  return out;
};


/** Effective amplitude of one channel: its own override when present, else the global value. */
const styleChannelAmplitude = (style, channel) => {
  const override = style?.channels?.[channel]?.amplitude;
  return Number.isFinite(override) ? override : finite(style?.amplitude, DEFAULT_AVATAR_STYLE.amplitude);
};


// ---------------------------------------------------------------------------------------------
// P-139 stage 3 — persona-derived style dimensions (expression only, never intent selection)
// ---------------------------------------------------------------------------------------------
//
// The dimensions are a *view* of the already-cached style, NOT another model call and NOT
// another random draw. Same persona text → same `styleVersion` → same style → same dimensions,
// and the numeric seed is the persona hash (falling back to the canonical style when no version
// was supplied). A dimension only scales amplitude / duration / hold / variant choice / attention
// later; it never enters the event → intent table in `motionEvents.js`.
//
// The first three names are the original stage-3 contract and stay frozen for compatibility
// (`avatar-style` asserts their exact shape on the snapshot). The four added names complete the
// PLAN vocabulary:
//
//   liveliness     活力      bigger and quicker motion
//   softness       柔和      (legacy) longer, gentler motion
//   restraint      克制      caps gesture size
//   expressiveness 表达强度  larger/clearer emphasis, deeper variants
//   attention      注意方式  how readily attention/head direction reorients (0 = steady, 1 = scanning)
//   composure      从容      slower tempo, longer holds and smoother transitions
//   texture        质感      how much consecutive gestures vary (variant spread / micro-variation)
//
// None of them selects an intent: `motionEvents.js` still owns event → intent, and the selector
// maps them onto soft weights only.

/** Dimension names; every value is a unit interval (0..1). */
export const AVATAR_STYLE_DIMENSIONS = Object.freeze([
  'liveliness',
  'softness',
  'restraint',
  'expressiveness',
  'attention',
  'composure',
  'texture',
]);

/** The original three dimensions, kept as an exact compatibility subset for existing snapshots. */
export const AVATAR_STYLE_LEGACY_DIMENSIONS = Object.freeze(['liveliness', 'softness', 'restraint']);

/** Human-readable labels (documentation / diagnostics only; never a selector key). */
export const AVATAR_STYLE_DIMENSION_LABELS = Object.freeze({
  liveliness: '活力',
  softness: '柔和',
  restraint: '克制',
  expressiveness: '表达强度',
  attention: '注意方式',
  composure: '从容',
  texture: '质感',
});


/** Map one style value onto its configured range (0..1). */
const styleUnit = (value, range) => {
  const span = range.max - range.min;
  return span <= 0 ? 0 : clamp01((finite(value, range.default) - range.min) / span);
};


const roundDimension = (value) => Math.round(clamp01(value) * 10_000) / 10_000;


/** Canonical style text used for the seed when no persona version is available. */
const canonicalStyleBasis = (style) => {
  const source = style !== null && typeof style === 'object' ? style : DEFAULT_AVATAR_STYLE;
  const channels = Object.keys(source.channels ?? {}).sort()
    .map((channel) => `${channel}=${finite(source.channels[channel]?.amplitude, 0)}`)
    .join(',');
  return [
    finite(source.amplitude, DEFAULT_AVATAR_STYLE.amplitude),
    finite(source.tempo, DEFAULT_AVATAR_STYLE.tempo),
    String(source.gazeHabit ?? DEFAULT_AVATAR_STYLE.gazeHabit),
    finite(source.expressiveness, DEFAULT_AVATAR_STYLE.expressiveness),
    finite(source.nodAmplitude, DEFAULT_AVATAR_STYLE.nodAmplitude),
    finite(source.nodDurationMs, DEFAULT_AVATAR_STYLE.nodDurationMs),
    finite(source.tiltChance, DEFAULT_AVATAR_STYLE.tiltChance),
    channels,
  ].join('|');
};


/**
 * Fixed 32-bit seed for one persona's dimensions. `styleVersion` is the stable persona hash
 * (`personaStyleVersion`), so two initialisations of the same persona produce the same seed even
 * when the style object is rebuilt; without a version the canonical style itself is hashed.
 */
export function avatarStyleSeed(style, { styleVersion = '' } = {}) {
  const version = String(styleVersion ?? '').trim();
  return hash32(0, `avatar-style-dimensions:${version.length > 0 ? version : canonicalStyleBasis(style)}`);
}


/** How readily each gaze habit reorients attention (0 = steady, 1 = scanning). */
const GAZE_ATTENTION = Object.freeze({ steady: 0.25, direct: 0.65, wandering: 0.95 });


/**
 * Derive every style dimension from the persona style. The first three values are byte-for-byte
 * the original stage-3 formulas (existing tests pin their ordering and event shape); the four
 * additional dimensions reuse the same normalised inputs so one style produces one deterministic
 * set.
 *
 *   liveliness     larger amplitude / faster rhythm / bigger gestures → bigger, quicker motion
 *   softness       slow tempo / small amplitude / low expression     → longer, gentler transitions
 *   restraint      small amplitude / low expression / rare tilt      → caps the gesture size
 *   expressiveness strong expression / bigger nods                   → larger emphasis, deeper variants
 *   attention      outward gaze habit / more tilt                    → more attention reorientation
 *   composure      slow tempo / small amplitude                      → longer holds, calmer transitions
 *   texture        expressive, detailed, quicker style               → more variant spread
 *
 * A quiet persona therefore lands high on `restraint`/`composure` (and low on `liveliness`); a
 * lively persona is the opposite. The values are deterministic in the style and the seed is
 * deterministic in the persona version, which is exactly what the stage-3 tests compare.
 *
 * @param {object} style persona style (partial accepted)
 * @param {{styleVersion?: string}} [options]
 * @returns {{liveliness: number, softness: number, restraint: number, expressiveness: number,
 *            attention: number, composure: number, texture: number, seed: number}}
 */
export function deriveAvatarStyleDimensions(style, { styleVersion = '' } = {}) {
  const source = coerceAvatarStyle(style);
  const amplitude = styleUnit(source.amplitude, AVATAR_STYLE_RANGES.amplitude);
  const tempo = styleUnit(source.tempo, AVATAR_STYLE_RANGES.tempo);
  const nod = styleUnit(source.nodAmplitude, AVATAR_STYLE_RANGES.nodAmplitude);
  const expression = styleUnit(source.expressiveness, AVATAR_STYLE_RANGES.expressiveness);
  const tilt = styleUnit(source.tiltChance, AVATAR_STYLE_RANGES.tiltChance);
  // A short nodDuration is a *faster* gesture, so it contributes positively to liveliness.
  const speed = 1 - styleUnit(source.nodDurationMs, AVATAR_STYLE_RANGES.nodDurationMs);
  const liveliness = 0.28 * amplitude + 0.22 * tempo + 0.18 * nod
    + 0.12 * expression + 0.10 * tilt + 0.10 * speed;
  const restraint = 1 - (0.45 * amplitude + 0.25 * expression + 0.15 * tilt + 0.15 * nod);
  const softness = 0.50 * (1 - tempo) + 0.30 * (1 - amplitude) + 0.20 * (1 - expression);

  // Added dimensions: all derived from the same normalised style values, never from a persona id.
  const gazeAttention = GAZE_ATTENTION[source.gazeHabit] ?? GAZE_ATTENTION.steady;
  // A channel override is an explicit request for per-channel detail → part of the motion texture.
  const channelDetail = Math.min(1, Object.keys(source.channels ?? {}).length / 4);
  const expressiveness = 0.60 * expression + 0.25 * nod + 0.15 * amplitude;
  const attention = 0.55 * gazeAttention + 0.30 * tilt + 0.15 * liveliness;
  const composure = 0.45 * (1 - tempo) + 0.25 * (1 - amplitude)
    + 0.20 * (1 - liveliness) + 0.10 * (1 - expression);
  const texture = 0.35 * expression + 0.25 * (1 - softness)
    + 0.20 * channelDetail + 0.20 * tempo;

  return {
    liveliness: roundDimension(liveliness),
    softness: roundDimension(softness),
    restraint: roundDimension(restraint),
    expressiveness: roundDimension(expressiveness),
    attention: roundDimension(attention),
    composure: roundDimension(composure),
    texture: roundDimension(texture),
    seed: avatarStyleSeed(source, { styleVersion }),
  };
}


/**
 * Split a derived object into the frozen legacy snapshot shape and the full trait set. Hosts and
 * older consumers keep `style.dimensions` exactly as it was; the stage-3 behaviours read
 * `style.traits`, which additionally carries the four new dimensions.
 *
 * @param {ReturnType<typeof deriveAvatarStyleDimensions>} derived
 * @returns {{dimensions: object, traits: object}} fresh plain objects
 */
export function splitAvatarStyleDimensions(derived) {
  const source = derived !== null && typeof derived === 'object' ? derived : {};
  const dimensions = {};
  for (const name of AVATAR_STYLE_LEGACY_DIMENSIONS) dimensions[name] = finite(source[name], 0);
  dimensions.seed = finite(source.seed, 0);
  const traits = {};
  for (const name of AVATAR_STYLE_DIMENSIONS) traits[name] = finite(source[name], 0);
  traits.seed = finite(source.seed, 0);
  return { dimensions, traits };
}


/**
 * Merge a partial style over a base style. Only mentioned fields change; every numeric value is
 * clamped and every enum is validated. An invalid value keeps the base value (never NaN).
 *
 * @param {object|null|undefined} input partial style (already-parsed JSON)
 * @param {{base?: object}} [options]
 * @returns {object} a complete, clamped style
 */
export function coerceAvatarStyle(input, { base = DEFAULT_AVATAR_STYLE } = {}) {
  const prior = base !== null && typeof base === 'object' ? base : DEFAULT_AVATAR_STYLE;
  const style = {
    amplitude: clampStyleNumber('amplitude', prior.amplitude, DEFAULT_AVATAR_STYLE.amplitude),
    tempo: clampStyleNumber('tempo', prior.tempo, DEFAULT_AVATAR_STYLE.tempo),
    gazeHabit: AVATAR_GAZE_HABITS.includes(prior.gazeHabit)
      ? prior.gazeHabit : DEFAULT_AVATAR_STYLE.gazeHabit,
    expressiveness: clampStyleNumber('expressiveness', prior.expressiveness, DEFAULT_AVATAR_STYLE.expressiveness),
    nodAmplitude: clampStyleNumber('nodAmplitude', prior.nodAmplitude, DEFAULT_AVATAR_STYLE.nodAmplitude),
    nodDurationMs: clampStyleNumber('nodDurationMs', prior.nodDurationMs, DEFAULT_AVATAR_STYLE.nodDurationMs),
    tiltChance: clampStyleNumber('tiltChance', prior.tiltChance, DEFAULT_AVATAR_STYLE.tiltChance),
    channels: coerceStyleChannels(prior.channels),
  };
  if (input === null || input === undefined || typeof input !== 'object' || Array.isArray(input)) {
    return style;
  }
  for (const [key, value] of Object.entries(input)) {
    if (!AVATAR_STYLE_FIELDS.includes(key)) continue;
    if (key === 'gazeHabit') {
      if (AVATAR_GAZE_HABITS.includes(value)) style.gazeHabit = value;
      continue;
    }
    if (key === 'channels') {
      style.channels = coerceStyleChannels(value, style.channels);
      continue;
    }
    style[key] = clampStyleNumber(key, value, style[key]);
  }
  return style;
}


/**
 * Normalize a partial style and report what changed / what was ignored. This is the lazy merge
 * used by both a direct `runtime.setStyle()` and the background generator: unmentioned fields
 * keep their previous value, unknown keys are ignored, invalid values keep the old value.
 *
 * @param {object} input
 * @param {{base?: object}} [options]
 * @returns {{ok: boolean, style: object, changed: string[], ignored: string[], invalid: string[],
 *            error?: string}}
 */
export function normalizeAvatarStyle(input, { base = DEFAULT_AVATAR_STYLE } = {}) {
  const style = coerceAvatarStyle({}, { base });
  if (input === null || input === undefined) {
    return { ok: true, style, changed: [], ignored: [], invalid: [] };
  }
  if (typeof input !== 'object' || Array.isArray(input)) {
    return {
      ok: false,
      style: { ...DEFAULT_AVATAR_STYLE },
      changed: [],
      ignored: [],
      invalid: ['*'],
      error: 'style must be a JSON object',
    };
  }
  const changed = [];
  const ignored = [];
  const invalid = [];
  for (const [key, value] of Object.entries(input)) {
    if (!AVATAR_STYLE_FIELDS.includes(key)) {
      ignored.push(key);
      continue;
    }
    if (key === 'gazeHabit') {
      if (!AVATAR_GAZE_HABITS.includes(value)) {
        invalid.push(key);
        continue;
      }
      if (style[key] !== value) {
        style[key] = value;
        changed.push(key);
      }
      continue;
    }
    if (key === 'channels') {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        invalid.push('channels');
        continue;
      }
      for (const [channel, spec] of Object.entries(value)) {
        if (AVATAR_STYLE_CHANNEL_RANGES[channel] === undefined) {
          ignored.push(`channels.${channel}`);
          continue;
        }
        if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
          invalid.push(`channels.${channel}`);
          continue;
        }
        for (const nested of Object.keys(spec)) {
          if (nested !== 'amplitude') ignored.push(`channels.${channel}.${nested}`);
        }
        if (!Object.hasOwn(spec, 'amplitude')) continue;
        const next = clampChannelAmplitude(channel, spec.amplitude);
        if (next === null) {
          invalid.push(`channels.${channel}.amplitude`);
          continue;
        }
        if (style.channels[channel]?.amplitude !== next) {
          style.channels[channel] = { amplitude: next };
          changed.push(`channels.${channel}`);
        }
      }
      continue;
    }
    const number = Number(value);
    if (!Number.isFinite(number)) {
      invalid.push(key);
      continue;
    }
    const next = clampStyleNumber(key, number, style[key]);
    if (style[key] !== next) {
      style[key] = next;
      changed.push(key);
    }
  }
  return { ok: true, style, changed, ignored, invalid };
}


/**
 * Parse a model answer into a style patch. On any parse failure the DEFAULT style is returned
 * (never a half-parsed object) together with `ok:false`; the caller records the event and keeps
 * chatting without waiting.
 *
 * @param {string} text model output, possibly wrapped in a code fence
 * @param {{base?: object}} [options]
 */
export function parseAvatarStyle(text, { base = DEFAULT_AVATAR_STYLE } = {}) {
  const failure = (error) => ({
    ok: false,
    style: { ...DEFAULT_AVATAR_STYLE },
    changed: [],
    ignored: [],
    invalid: [],
    error,
  });
  const raw = String(text ?? '').trim();
  if (raw.length === 0) return failure('empty style output');
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first < 0 || last <= first) return failure('no JSON object in style output');
  let parsed;
  try {
    parsed = JSON.parse(raw.slice(first, last + 1));
  } catch (error) {
    return failure(`invalid JSON: ${String(error?.message ?? error)}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return failure('style output must be a JSON object');
  }
  const normalized = normalizeAvatarStyle(parsed, { base });
  return normalized.ok === true ? normalized : failure(normalized.error ?? 'invalid style');
}


/**
 * Deterministic persona-text version. Hashing the text (not a timestamp) is what lets the
 * background job prove "persona unchanged → the cached style is still valid" with zero model calls.
 *
 * @param {string} text
 * @returns {string} stable `v1-<hash>-<length>` key
 */
export function personaStyleVersion(text) {
  const source = String(text ?? '');
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `v1-${hash.toString(16).padStart(8, '0')}-${source.length}`;
}


const AVATAR_STYLE_SYSTEM = [
  'You translate a companion persona into Live2D motion-style parameters.',
  'Answer with ONE JSON object and nothing else: no prose, no code fence.',
  'Only include fields you are changing; every omitted field keeps its current value.',
  'Allowed fields and ranges:',
  '- amplitude: 0.2..1.5 (overall motion size)',
  '- tempo: 0.6..1.6 (rhythm speed)',
  '- gazeHabit: "steady" | "wandering" | "direct"',
  '- expressiveness: 0.3..1.5 (surprise / emphatic gestures)',
  '- nodAmplitude: 0.2..1.5',
  '- nodDurationMs: 250..900',
  '- tiltChance: 0..0.5',
  '- channels: optional per-channel overrides, e.g. {"headX":{"amplitude":0.6},"eyeOpenL":{"amplitude":0.3}}.',
  '  Channel keys: headX/headY/headZ (0.2..1.5), eyeOpenL/eyeOpenR (0.05..1), gazeX/gazeY/bodyX/breath (0.2..1.5).',
  '  A channel you do not mention keeps the global amplitude; omit channels you do not want to tune.',
  'A gentle/reserved persona → small amplitude, slow tempo, steady gaze.',
  'A lively persona → larger amplitude, faster tempo, wandering gaze.',
].join('\n');


/**
 * Build the one background model request that turns persona text into a style patch. The current
 * style is included so the model can return only the fields the persona actually implies.
 */
export function buildAvatarStylePrompt({ personaText = '', currentStyle = DEFAULT_AVATAR_STYLE } = {}) {
  const style = coerceAvatarStyle(currentStyle);
  const persona = String(personaText ?? '').trim();
  const clipped = persona.length > 6000 ? `${persona.slice(0, 6000)}\n…（已截断）` : persona;
  return {
    system: AVATAR_STYLE_SYSTEM,
    prompt: [
      `当前风格（未提及的字段保持这些值）：${JSON.stringify(style)}`,
      '字段范围：amplitude 0.2..1.5, tempo 0.6..1.6, gazeHabit steady|wandering|direct,',
      'expressiveness 0.3..1.5, nodAmplitude 0.2..1.5, nodDurationMs 250..900, tiltChance 0..0.5。',
      '可选 channels：{"headX":{"amplitude":0.2..1.5}, "eyeOpenL":{"amplitude":0.05..1}, "gazeX"|"gazeY"|"bodyX"|"breath":0.2..1.5}；未提及的通道沿用全局 amplitude。',
      persona.length > 0 ? `人设文本：\n${clipped}` : '人设文本为空：输出 {}。',
      '只输出一个 JSON 对象。',
    ].join('\n'),
  };
}


/**
 * Version-keyed style cache. `refresh(personaText)` is the ONLY entry point that may call the
 * model: an unchanged persona returns the cached style without a new call (the total `modelCalls`
 * counter stays the same), a changed persona regenerates once, and a parse failure falls back to
 * the default style with an event. Nothing here is on a chat path; the host calls it from a
 * background timer / after a persona write.
 *
 * ## Version race (P2)
 *
 * Every generation is stamped with the persona version it was started for. A newer `refresh()`
 * records the newest target version; the older generation may still settle, but its result is
 * discarded before any commit — no `style` write, no `persist`, no `avatar.style.applied`. That is
 * emitted as `avatar.style.dropped {reason:'stale-persona'}`. Same-version concurrent refreshes
 * share one in-flight generation (one model call). A result whose version is no longer the newest
 * target is dropped even if it settles last, so a late answer can never overwrite a newer persona.
 *
 * @param {{
 *   generate: (input: {personaText: string, currentStyle: object, version: string}) =>
 *     string|Promise<string>,
 *   initial?: {style?: object, styleVersion?: string, personaVersion?: string},
 *   persist?: (state: {style: object, styleVersion: string, personaVersion: string}) => void,
 *   onEvent?: (type: string, payload: object) => void,
 *   now?: () => number,
 * }} options
 */
export function createAvatarStyleCache({ generate, initial = null, persist = null, onEvent = null, now = null } = {}) {
  if (typeof generate !== 'function') throw new TypeError('createAvatarStyleCache 需要 generate 函数');
  const clock = typeof now === 'function' ? now : () => Date.now();
  const seed = initial !== null && typeof initial === 'object' ? initial : {};
  let style = coerceAvatarStyle(seed.style ?? {});
  let styleVersion = typeof seed.styleVersion === 'string' ? seed.styleVersion : '';
  let personaVersion = typeof seed.personaVersion === 'string' ? seed.personaVersion : '';
  /** Newest target persona version: the version the host last asked for (not yet necessarily made). */
  let targetVersion = personaVersion;
  /** In-flight generations per persona version, so a same-version request never pays twice. */
  const inFlight = new Map();
  const stats = { modelCalls: 0, failures: 0, dropped: 0, lastError: '', lastGeneratedAt: null, persistCalls: 0 };

  const emit = (type, payload = {}) => {
    try {
      onEvent?.(type, payload);
    } catch {
      // Diagnostics must never break the cache.
    }
  };
  const snapshotWith = (extra = {}) => ({
    style: { ...style },
    styleVersion,
    personaVersion,
    /** The newest version the host asked for; differs from `personaVersion` while stale. */
    targetVersion,
    modelCalls: stats.modelCalls,
    failures: stats.failures,
    dropped: stats.dropped,
    lastError: stats.lastError,
    lastGeneratedAt: stats.lastGeneratedAt,
    persistCalls: stats.persistCalls,
    generating: inFlight.size > 0,
    ...extra,
  });
  const persistState = () => {
    if (typeof persist !== 'function') return;
    try {
      persist({ style: { ...style }, styleVersion, personaVersion });
      stats.persistCalls += 1;
    } catch {
      // The next persona change retries; a bookkeeping failure never blocks the avatar.
    }
  };

  async function refresh(personaText, { force = false } = {}) {
    const source = String(personaText ?? '');
    const version = personaStyleVersion(source);
    // Record the newest target FIRST: any older generation still in flight must drop on commit.
    targetVersion = version;
    if (force !== true && version === personaVersion && styleVersion.length > 0) {
      return snapshotWith({
        ok: true,
        cached: true,
        generated: false,
        callModelCalls: 0,
        changed: [],
        ignored: [],
        invalid: [],
      });
    }
    // Same version already generating: share it instead of paying for a second model call.
    if (inFlight.has(version)) return inFlight.get(version);
    const run = (async () => {
      let output;
      try {
        output = await generate({ personaText: source, currentStyle: { ...style }, version });
      } catch (error) {
        stats.failures += 1;
        stats.lastError = String(error?.message ?? error);
        emit('avatar.style.unavailable', { error: stats.lastError, version, styleVersion });
        // Transient model failure: keep the last good style and leave `personaVersion` alone so the
        // next background tick retries instead of pinning the default forever.
        return snapshotWith({
          ok: false,
          cached: false,
          generated: false,
          callModelCalls: 0,
          error: stats.lastError,
          changed: [],
          ignored: [],
          invalid: [],
        });
      }
      stats.modelCalls += 1;
      // Commit guard: re-check the target version right before installing. A persona change during
      // the await makes this result obsolete — drop it without touching style/disk.
      if (version !== targetVersion) {
        stats.dropped += 1;
        stats.lastGeneratedAt = clock();
        emit('avatar.style.dropped', {
          reason: 'stale-persona',
          version,
          targetVersion,
          personaVersion,
          styleVersion,
        });
        return snapshotWith({
          ok: false,
          cached: true,
          generated: false,
          dropped: true,
          reason: 'stale-persona',
          callModelCalls: 1,
          changed: [],
          ignored: [],
          invalid: [],
        });
      }
      stats.lastGeneratedAt = clock();
      const parsed = parseAvatarStyle(output, { base: style });
      if (parsed.ok !== true) {
        style = { ...DEFAULT_AVATAR_STYLE };
        styleVersion = `${version}:default`;
        personaVersion = version;
        stats.failures += 1;
        stats.lastError = parsed.error;
        emit('avatar.style.parse-failed', { error: parsed.error, version, styleVersion });
      } else {
        style = parsed.style;
        styleVersion = version;
        personaVersion = version;
        stats.lastError = '';
        emit('avatar.style.applied', {
          styleVersion,
          changed: parsed.changed,
          ignored: parsed.ignored,
          invalid: parsed.invalid,
        });
      }
      persistState();
      return snapshotWith({
        ok: parsed.ok === true,
        cached: false,
        generated: true,
        callModelCalls: 1,
        changed: parsed.changed,
        ignored: parsed.ignored,
        invalid: parsed.invalid,
        error: parsed.error ?? '',
      });
    })();
    inFlight.set(version, run);
    try {
      return await run;
    } finally {
      // Only clear the entry this call started; a newer request may own the same version already.
      if (inFlight.get(version) === run) inFlight.delete(version);
    }
  }

  /** Load a persisted style without generating anything (restart path). */
  function hydrate(next = {}) {
    if (next.style !== undefined) style = coerceAvatarStyle(next.style);
    if (typeof next.styleVersion === 'string') styleVersion = next.styleVersion;
    if (typeof next.personaVersion === 'string') {
      personaVersion = next.personaVersion;
      targetVersion = next.personaVersion;
    }
    return snapshotWith();
  }

  return {
    refresh,
    hydrate,
    snapshot: snapshotWith,
    get style() {
      return { ...style };
    },
  };
}

export {
  clampStyleNumber,
  clampChannelAmplitude,
  coerceStyleChannels,
  styleChannelAmplitude,
  styleUnit,
  roundDimension,
  canonicalStyleBasis,
  AVATAR_STYLE_SYSTEM,
};
