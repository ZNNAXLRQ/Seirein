/**
 * preset-selector — the selection layer above the read-only motion preset library.
 *
 * This module is deliberately standalone and side-effect free at import time: it reads
 * `presets/index.js`, builds in-memory indexes, applies the library's hard filter plus the
 * selector's own intent gate, scores the survivors, and runs a layered weighted roulette.
 * It never writes a VTS parameter, never arms a timer, never emits an event, never touches
 * the database and never mutates the frozen library objects. Wiring into
 * `motion-controller.js` / `avatarRuntime.js` is a separate step.
 *
 * Public surface
 * --------------
 *   createPresetIndex(presets?)  -> index { presets, byId, byState, byEvent, byFamily,
 *                                            byStyle, byRecipe, find(), stats() }
 *   createPresetSelector(opts?)  -> { select, explain, query, candidates, stats, index, overrides }
 *
 * `select(context)` input (state and event are required for a draw; an absent
 * `verifiedChannels` means "nothing verified" and fails closed):
 *   state              host state: idle | listening | thinking | speaking | waiting | tired
 *   event              host semantic event: idle | user-speaking | thinking | sentence-gap |
 *                      answer-start | answer-end | affirm | deny | emphasize | confused |
 *                      surprised | curious | reassure | apologize | amused | uncertain |
 *                      greet | farewell
 *   intent             explicit semantic intent (agreement | disagreement | emphasis | ...).
 *                      `semantic` is accepted as an alias. When absent, an intent event
 *                      (deny/affirm/...) supplies its own intent; an explicit `neutral` intent
 *                      on an intent event is a contradiction and fails closed.
 *   verifiedChannels   channels whose input the current model actually verified. A missing
 *                      required channel excludes the candidate; it is never downgraded.
 *   targetVerified     bool proof that gaze-target has a real target (never inferred)
 *   directionVerified  bool proof that a head-turn has a measured direction
 *   persona            { styles?: string[] | Record<styleId, 0..1>, dimensions?: {
 *                        liveliness, softness, restraint } } — soft affinity, never a ban
 *   recent             { families?: string[] | Record<string,number>,
 *                        actions?:  string[] | Record<string,number> } — newest last
 *   recentWindow       how many newest recent entries to count (default 4)
 *   history            [{ id, at }] recent plays for the frequency constraint
 *   now                ms timestamp used to window `history` (absent = count all)
 *   frequencyWindowMs  history window (default 60000)
 *   family, style, recipe  optional hard narrowing (family id / affinity tag / recipe id)
 *   privacy, disposed  true => no draw at all (hold)
 *   overrides          per-call { disabled:[], disabledFamilies:[], familyPriority:{},
 *                      actionPriority:{} }; falls back to the selector's own overrides
 *   seed               number | string, reproducible; or
 *   rand               () => [0,1) injected random source (wins over seed)
 *
 * `select` output:
 *   { kind: 'preset', presetId, family, recipe, variant, score, probability,
 *     reasons: string[], droppedChannels: string[], timing, operations, requires,
 *     effectiveRequires }
 *   { kind: 'hold', presetId: null, family: null, recipe: null, variant: null,
 *     score: 0, probability: 0, reasons: string[], droppedChannels: [] }
 *
 * Candidate shortage: when fewer than `minFamilies` (default 3) hard-eligible families
 * remain, the soft repeat/frequency penalties are dropped for that draw and the reasons say
 * so. Relaxation only changes weights, never eligibility, so `hold` is returned when the
 * hard-filtered candidate set is empty — an empty set can never be relaxed back to life.
 *
 * Errors: construction validates the catalog and throws TypeError for a malformed catalog.
 * `select`/`query`/`explain` never throw for bad context — privacy, disposal, missing
 * state/event or an unverified channel set all fail closed to a hold (or an empty list),
 * exactly like `queryPresets`.
 */

import { PRESETS, OPERATIONS, STYLES } from './presets/index.js';

// ---------------------------------------------------------------------------------------------
// Constants: scoring, intent vocabulary, optional channels. None of this edits the library.
// ---------------------------------------------------------------------------------------------

const BASE_SCORE = 1;
/** Fixed weight of the "keep the current posture" option; a family with baseline score ≈1
 *  therefore competes with hold at roughly 1:1 before the number of families is counted. */
const HOLD_WEIGHT = 1;
const DEFAULT_PRIORITY = 50;
const PRIORITY_MIN = 0;
const PRIORITY_MAX = 100;
const PRIORITY_LOW = 0.25;
const PRIORITY_SPAN = 1.75;
/** Fewer eligible families than this counts as "candidate shortage" and relaxes soft penalties. */
const MIN_FAMILIES = 3;
const DEFAULT_RECENT_WINDOW = 4;
const DEFAULT_FREQUENCY_WINDOW_MS = 60_000;
/** Persona affinity maps onto [0.6, 1.4]; a missing persona is exactly 1.0 (neutral). */
const PERSONA_BASE = 0.6;
const PERSONA_SPAN = 0.8;
const STATE_SPECIFIC_BONUS = 1.12;
const EVENT_SPECIFIC_BONUS = 1.12;
const FAMILY_REPEAT_WEIGHT = 0.55;
const ACTION_REPEAT_WEIGHT = 1;
const FREQUENCY_WEIGHT = 0.8;

/** Event names that carry an explicit communicative intent (README, "筛选、概率与保持不动"). */
const INTENT_EVENT_SEMANTIC = Object.freeze({
  affirm: 'agreement',
  deny: 'disagreement',
  emphasize: 'emphasis',
  confused: 'confusion',
  surprised: 'surprise',
  curious: 'curiosity',
  reassure: 'reassurance',
  apologize: 'apology',
  amused: 'amusement',
  uncertain: 'uncertainty',
  greet: 'greeting',
  farewell: 'farewell',
});

const INTENT_SEMANTICS = new Set(Object.values(INTENT_EVENT_SEMANTIC));

/**
 * Channels an operation can still express without one of its channels. `brow-one` is by
 * definition a ONE-SIDED brow change (README: "单侧眉变化，按实际绑定确定方向"), so a single
 * verified brow channel is enough and the unverified side is merely dropped. Every other
 * operation needs all of its channels; in particular `head-center` never degrades to one axis.
 */
const OPTIONAL_OPERATION_CHANNELS = Object.freeze({
  'brow-one': Object.freeze(['browR']),
});

/**
 * Adapter-side heuristic: where each affinity tag sits on the three persona style dimensions
 * that `deriveAvatarStyleDimensions` already produces. This is selector data, not preset data,
 * and it only ever produces a soft multiplier.
 */
const STYLE_DIMENSION_PROFILES = Object.freeze({
  common: Object.freeze([0.5, 0.5, 0.5]),
  gentle: Object.freeze([0.35, 0.85, 0.55]),
  lively: Object.freeze([0.85, 0.35, 0.2]),
  reserved: Object.freeze([0.2, 0.5, 0.85]),
  composed: Object.freeze([0.4, 0.6, 0.7]),
  playful: Object.freeze([0.8, 0.4, 0.25]),
  shy: Object.freeze([0.3, 0.7, 0.7]),
  confident: Object.freeze([0.75, 0.4, 0.25]),
  elegant: Object.freeze([0.4, 0.75, 0.6]),
  curious: Object.freeze([0.7, 0.45, 0.3]),
  rational: Object.freeze([0.45, 0.5, 0.7]),
  warm: Object.freeze([0.65, 0.65, 0.35]),
  dreamy: Object.freeze([0.25, 0.85, 0.6]),
  earnest: Object.freeze([0.55, 0.55, 0.45]),
  cool: Object.freeze([0.25, 0.4, 0.75]),
  cheerful: Object.freeze([0.85, 0.55, 0.2]),
});
const STYLE_DIMENSION_NAMES = Object.freeze(['liveliness', 'softness', 'restraint']);
const KNOWN_STYLE_IDS = new Set(STYLES.map(style => style.id));

// ---------------------------------------------------------------------------------------------
// Small numeric / random helpers
// ---------------------------------------------------------------------------------------------

const clamp01 = value => Math.max(0, Math.min(1, value));
const round = (value, digits = 3) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};
const finite = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);

const hashString = (text) => {
  let hash = 2166136261 >>> 0;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
};

const mulberry32 = (seed) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** One RNG per call: an injected `rand` wins, otherwise a seed is reproducible. */
function createRandom({ seed, rand } = {}) {
  if (typeof rand === 'function') {
    return () => {
      const value = Number(rand());
      if (!Number.isFinite(value)) return 0;
      return Math.min(0.999999999, Math.max(0, value));
    };
  }
  if (seed === undefined || seed === null) return Math.random;
  const numeric = typeof seed === 'number' && Number.isFinite(seed) ? seed >>> 0 : hashString(String(seed));
  return mulberry32(numeric);
}

// ---------------------------------------------------------------------------------------------
// In-memory index (no database)
// ---------------------------------------------------------------------------------------------

const bucket = (map, key, id) => {
  if (!map.has(key)) map.set(key, new Set());
  map.get(key).add(id);
};

function assertCatalog(presets) {
  if (!Array.isArray(presets) || presets.length === 0) {
    throw new TypeError('preset-selector: catalog must be a non-empty array of presets');
  }
  const seen = new Set();
  for (const preset of presets) {
    if (preset === null || typeof preset !== 'object') {
      throw new TypeError('preset-selector: every preset must be an object');
    }
    const missing = ['id', 'family', 'recipeId', 'semantic']
      .filter(key => typeof preset[key] !== 'string' || preset[key].length === 0);
    const arrays = ['states', 'events', 'styles', 'requires', 'operations'];
    for (const key of arrays) if (!Array.isArray(preset[key])) missing.push(key);
    if (missing.length > 0) {
      throw new TypeError(`preset-selector: preset ${String(preset.id)} is missing ${missing.join(', ')}`);
    }
    if (seen.has(preset.id)) throw new TypeError(`preset-selector: duplicate preset id ${preset.id}`);
    seen.add(preset.id);
  }
}

/**
 * Build the read-only in-memory index. Every bucket is a Set of stable preset ids, so a
 * lookup is O(1) and a query intersects the smallest bucket first.
 */
export function createPresetIndex(presets = PRESETS) {
  assertCatalog(presets);
  const byId = new Map();
  const byState = new Map();
  const byEvent = new Map();
  const byFamily = new Map();
  const byStyle = new Map();
  const byRecipe = new Map();
  for (const preset of presets) {
    byId.set(preset.id, preset);
    for (const state of preset.states) bucket(byState, state, preset.id);
    for (const event of preset.events) bucket(byEvent, event, preset.id);
    for (const style of preset.styles) bucket(byStyle, style, preset.id);
    bucket(byFamily, preset.family, preset.id);
    bucket(byRecipe, preset.recipeId, preset.id);
  }

  const find = ({ state, event, family, style, recipe } = {}) => {
    const filters = [];
    if (state !== undefined) filters.push(byState.get(state));
    if (event !== undefined) filters.push(byEvent.get(event));
    if (family !== undefined) filters.push(byFamily.get(family));
    if (style !== undefined) filters.push(byStyle.get(style));
    if (recipe !== undefined) filters.push(byRecipe.get(recipe));
    if (filters.length === 0) return [...presets];
    if (filters.some(bucketSet => bucketSet === undefined)) return [];
    const smallest = filters.reduce((a, b) => (a.size <= b.size ? a : b));
    const ids = [...smallest].filter(id => filters.every(bucketSet => bucketSet.has(id)));
    return presets.filter(preset => ids.includes(preset.id));
  };

  const stats = () => ({
    recipes: new Set(presets.map(preset => preset.recipeId)).size,
    presets: presets.length,
    variants: new Set(presets.map(preset => preset.timing?.id ?? preset.id.split('.').pop())).size,
    styles: byStyle.size,
    families: byFamily.size,
    byState: Object.fromEntries([...byState].map(([key, ids]) => [key, ids.size])),
    byEvent: Object.fromEntries([...byEvent].map(([key, ids]) => [key, ids.size])),
  });

  return Object.freeze({
    presets,
    byId,
    byState,
    byEvent,
    byFamily,
    byStyle,
    byRecipe,
    find,
    stats,
  });
}

// ---------------------------------------------------------------------------------------------
// Input normalisation — fail closed, never infer a proof
// ---------------------------------------------------------------------------------------------

function normalizeOverrides(input = {}) {
  const source = input !== null && typeof input === 'object' ? input : {};
  const disabled = new Set();
  for (const id of Array.isArray(source.disabled) ? source.disabled : []) {
    if (typeof id === 'string' && id.length > 0) disabled.add(id);
  }
  const disabledFamilies = new Set();
  for (const family of Array.isArray(source.disabledFamilies) ? source.disabledFamilies : []) {
    if (typeof family === 'string' && family.length > 0) disabledFamilies.add(family);
  }
  const priorities = (value) => {
    const out = new Map();
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return out;
    for (const [key, raw] of Object.entries(value)) {
      const number = Number(raw);
      if (!Number.isFinite(number)) continue;
      out.set(key, Math.min(PRIORITY_MAX, Math.max(PRIORITY_MIN, number)));
    }
    return out;
  };
  return Object.freeze({
    disabled,
    disabledFamilies,
    familyPriority: priorities(source.familyPriority),
    actionPriority: priorities(source.actionPriority),
  });
}

/** Priority lookup: exact variant id, then recipe id, then family, then the default 50. */
function priorityFor(preset, overrides) {
  for (const key of [preset.id, preset.recipeId]) {
    const value = overrides.actionPriority.get(key);
    if (value !== undefined) return value;
  }
  const family = overrides.familyPriority.get(preset.family);
  return family === undefined ? DEFAULT_PRIORITY : family;
}

const priorityMultiplier = priority => PRIORITY_LOW + PRIORITY_SPAN * (priority / PRIORITY_MAX);

/** Persona affinity map: explicit tags, else a projection of the three style dimensions. */
function normalizePersona(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return null;
  const tags = input.styles ?? input.tags;
  const affinity = new Map();
  if (Array.isArray(tags)) {
    for (const tag of tags) {
      if (typeof tag === 'string' && KNOWN_STYLE_IDS.has(tag)) affinity.set(tag, 1);
    }
  } else if (tags !== null && typeof tags === 'object') {
    for (const [tag, raw] of Object.entries(tags)) {
      if (!KNOWN_STYLE_IDS.has(tag)) continue;
      const value = Number(raw);
      affinity.set(tag, clamp01(Number.isFinite(value) ? value : 0));
    }
  }
  if (affinity.size > 0) return affinity;
  const dimensions = input.dimensions;
  if (dimensions === null || typeof dimensions !== 'object' || Array.isArray(dimensions)) return null;
  const normalized = {};
  let count = 0;
  for (const name of STYLE_DIMENSION_NAMES) {
    const value = Number(dimensions[name]);
    if (!Number.isFinite(value)) continue;
    normalized[name] = clamp01(value);
    count += 1;
  }
  if (count === 0) return null;
  for (const [style, profile] of Object.entries(STYLE_DIMENSION_PROFILES)) {
    let distance = 0;
    let seen = 0;
    STYLE_DIMENSION_NAMES.forEach((name, index) => {
      if (normalized[name] === undefined) return;
      distance += Math.abs(normalized[name] - profile[index]);
      seen += 1;
    });
    if (seen > 0) affinity.set(style, clamp01(1 - 1.5 * (distance / seen)));
  }
  return affinity.size > 0 ? affinity : null;
}

/** Recent-list input becomes a count map. Arrays are newest-last; maps are counts already. */
function recentCounts(input, window) {
  const counts = new Map();
  if (Array.isArray(input)) {
    const entries = input.filter(value => typeof value === 'string' && value.length > 0).slice(-window);
    for (const entry of entries) counts.set(entry, (counts.get(entry) ?? 0) + 1);
    return counts;
  }
  if (input !== null && typeof input === 'object') {
    for (const [key, raw] of Object.entries(input)) {
      const count = Number(raw);
      if (!Number.isFinite(count) || count <= 0) continue;
      counts.set(key, count);
    }
  }
  return counts;
}

function normalizeContext(context) {
  if (context === null || typeof context !== 'object' || Array.isArray(context)) {
    return { ok: false, reason: 'invalid-context' };
  }
  if (context.privacy === true) return { ok: false, reason: 'privacy' };
  if (context.disposed === true) return { ok: false, reason: 'disposed' };
  const state = typeof context.state === 'string' ? context.state.trim() : '';
  const event = typeof context.event === 'string' ? context.event.trim() : '';
  if (state.length === 0 || event.length === 0) return { ok: false, reason: 'invalid-context' };
  const verified = context.verifiedChannels;
  if (verified !== undefined && !Array.isArray(verified)) {
    return { ok: false, reason: 'invalid-channels' };
  }
  const verifiedChannels = [...new Set((verified ?? []).filter(name => typeof name === 'string' && name.length > 0))];
  const providedIntent = typeof context.intent === 'string'
    ? context.intent
    : (typeof context.semantic === 'string' ? context.semantic : undefined);
  const intent = providedIntent === undefined || providedIntent.length === 0
    ? undefined
    : (providedIntent === 'neutral' ? null : providedIntent);
  const window = Number.isInteger(context.recentWindow) && context.recentWindow > 0
    ? context.recentWindow
    : DEFAULT_RECENT_WINDOW;
  return {
    ok: true,
    context: {
      state,
      event,
      intent,
      verifiedChannels,
      family: typeof context.family === 'string' && context.family.length > 0 ? context.family : null,
      style: typeof context.style === 'string' && context.style.length > 0 ? context.style : null,
      recipe: typeof context.recipe === 'string' && context.recipe.length > 0 ? context.recipe : null,
      targetVerified: context.targetVerified === true,
      directionVerified: context.directionVerified === true,
      personaAffinity: normalizePersona(context.persona),
      recentFamilies: recentCounts(context.recent?.families, window),
      recentActions: recentCounts(context.recent?.actions, window),
      history: Array.isArray(context.history) ? context.history : [],
      now: Number.isFinite(context.now) ? context.now : null,
      frequencyWindowMs: Number.isFinite(context.frequencyWindowMs) && context.frequencyWindowMs > 0
        ? context.frequencyWindowMs
        : DEFAULT_FREQUENCY_WINDOW_MS,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// HARD FILTER — every constraint here is checked before any score exists, and none of these
// constraints is ever relaxed. Order: safety, state/event, intent, proof, channels, overrides.
// ---------------------------------------------------------------------------------------------

function effectiveIntent(context) {
  if (context.intent !== undefined) return context.intent;
  return INTENT_EVENT_SEMANTIC[context.event] ?? null;
}

function semanticAllowed(preset, { state, event, intent }) {
  if (preset.semantic === 'neutral') return true;
  // An idle state can never carry a communicative gesture, even if an event claims one.
  if (state === 'idle') return false;
  if (intent === null || !INTENT_SEMANTICS.has(intent)) return false;
  const eventIntent = INTENT_EVENT_SEMANTIC[event];
  // An intent event must agree with the preset AND with an explicitly supplied intent.
  if (eventIntent !== undefined) return eventIntent === preset.semantic && intent === preset.semantic;
  return intent === preset.semantic;
}

/**
 * Channel check without single-channel downgrade: every channel is required except the
 * explicitly one-sided `brow-one`, which may drop its unverified side and reports it.
 */
function channelCheck(preset, verified) {
  const droppedChannels = [];
  for (const operation of preset.operations) {
    const channels = OPERATIONS[operation] ?? [];
    const missing = channels.filter(channel => !verified.has(channel));
    if (missing.length === 0) continue;
    const optional = new Set(OPTIONAL_OPERATION_CHANNELS[operation] ?? []);
    const hardMissing = missing.filter(channel => !optional.has(channel));
    if (hardMissing.length > 0) return { ok: false, droppedChannels: [] };
    if (channels.length - missing.length === 0) return { ok: false, droppedChannels: [] };
    droppedChannels.push(...missing);
  }
  return { ok: true, droppedChannels };
}

/** Hard filter. Returns `{ stateIds }` etc. inside one pass; no software penalty is applied. */
function collectCandidates(context, overrides, index) {
  if (context.privacy === true || context.disposed === true) return [];
  const stateIds = index.byState.get(context.state);
  const eventIds = index.byEvent.get(context.event);
  if (stateIds === undefined || eventIds === undefined) return [];
  const [small, large] = stateIds.size <= eventIds.size ? [stateIds, eventIds] : [eventIds, stateIds];
  const verified = new Set(context.verifiedChannels);
  const intent = effectiveIntent(context);
  const candidates = [];
  for (const id of small) {
    if (!large.has(id)) continue;
    const preset = index.byId.get(id);
    if (preset === undefined) continue;
    if (overrides.disabled.has(preset.id) || overrides.disabledFamilies.has(preset.family)) continue;
    if (context.family !== null && preset.family !== context.family) continue;
    if (context.style !== null && !preset.styles.includes(context.style)) continue;
    if (context.recipe !== null && preset.recipeId !== context.recipe) continue;
    if (!semanticAllowed(preset, { state: context.state, event: context.event, intent })) continue;
    if (preset.requiresTarget && context.targetVerified !== true) continue;
    if (preset.requiresDirection && context.directionVerified !== true) continue;
    const channels = channelCheck(preset, verified);
    if (!channels.ok) continue;
    candidates.push({ preset, droppedChannels: channels.droppedChannels });
  }
  return candidates;
}

// ---------------------------------------------------------------------------------------------
// SOFT SCORING — persona × state × event × recent-family/action × frequency × user priority.
// Every factor is a multiplier, so a candidate can be made very unlikely but never illegal.
// ---------------------------------------------------------------------------------------------

function personaFit(preset, affinity) {
  if (affinity === null) return 1;
  let best = 0;
  for (const tag of preset.styles) {
    const value = affinity.get(tag);
    if (value !== undefined && value > best) best = value;
  }
  return PERSONA_BASE + PERSONA_SPAN * best;
}

// A recipe offered for fewer states/events is the more specific fit for this moment; the bonus
// is small (1.12×) and soft, so a broadly applicable blink/breath is not buried.
const stateFit = preset => (preset.states.length === 1 ? STATE_SPECIFIC_BONUS : 1);
const eventFit = preset => (preset.events.length === 1 ? EVENT_SPECIFIC_BONUS : 1);

function repeatPenalty(preset, context) {
  const familyCount = context.recentFamilies.get(preset.family) ?? 0;
  const actionCount = Math.max(
    context.recentActions.get(preset.id) ?? 0,
    context.recentActions.get(preset.recipeId) ?? 0,
  );
  return 1 / (1 + FAMILY_REPEAT_WEIGHT * familyCount + ACTION_REPEAT_WEIGHT * actionCount);
}

function frequencyPenalty(preset, context) {
  if (context.history.length === 0) return 1;
  let count = 0;
  for (const entry of context.history) {
    const id = typeof entry === 'string' ? entry : entry?.id ?? entry?.presetId;
    if (id !== preset.id) continue;
    const at = typeof entry === 'object' && entry !== null ? Number(entry.at) : NaN;
    if (context.now !== null && Number.isFinite(at) && context.now - at > context.frequencyWindowMs) continue;
    count += 1;
  }
  return 1 / (1 + FREQUENCY_WEIGHT * count);
}

function scoreCandidate(entry, context, overrides, relaxed) {
  const { preset } = entry;
  const persona = personaFit(preset, context.personaAffinity);
  const repeat = relaxed ? 1 : repeatPenalty(preset, context);
  const frequency = relaxed ? 1 : frequencyPenalty(preset, context);
  const priority = priorityFor(preset, overrides);
  const multiplier = priorityMultiplier(priority);
  const weight = BASE_SCORE * stateFit(preset) * eventFit(preset) * persona * repeat * frequency * multiplier;
  return {
    preset,
    droppedChannels: entry.droppedChannels,
    weight,
    factors: {
      stateFit: stateFit(preset),
      eventFit: eventFit(preset),
      personaFit: persona,
      repeat,
      frequency,
      priority,
      priorityMultiplier: multiplier,
    },
  };
}

/**
 * Layered grouping. A recipe is as strong as its strongest timing variant, and a family is as
 * strong as its strongest recipe — so neither four timings nor a large recipe count can inflate
 * a family's probability. Variant weights are kept for the final (conditional) draw.
 */
function groupWeights(scored) {
  const families = new Map();
  for (const candidate of scored) {
    const { preset } = candidate;
    if (!families.has(preset.family)) {
      families.set(preset.family, { family: preset.family, weight: 0, recipes: new Map() });
    }
    const family = families.get(preset.family);
    if (!family.recipes.has(preset.recipeId)) {
      family.recipes.set(preset.recipeId, { recipe: preset.recipeId, weight: 0, variants: [] });
    }
    const recipe = family.recipes.get(preset.recipeId);
    recipe.variants.push({
      presetId: preset.id,
      variant: preset.timing?.id ?? preset.id.split('.').pop(),
      weight: candidate.weight,
      candidate,
    });
    recipe.weight = Math.max(recipe.weight, candidate.weight);
    family.weight = Math.max(family.weight, candidate.weight);
  }
  const ordered = [...families.values()].sort((a, b) => (a.family < b.family ? -1 : 1));
  for (const family of ordered) {
    family.recipes = [...family.recipes.values()].sort((a, b) => (a.recipe < b.recipe ? -1 : 1));
    for (const recipe of family.recipes) {
      recipe.variants.sort((a, b) => (a.presetId < b.presetId ? -1 : 1));
    }
  }
  return ordered;
}

function pickWeighted(options, weightOf, rand) {
  const total = options.reduce((sum, option) => sum + Math.max(0, weightOf(option)), 0);
  if (!(total > 0)) return null;
  let threshold = rand() * total;
  for (const option of options) {
    threshold -= Math.max(0, weightOf(option));
    if (threshold < 0) return option;
  }
  return options[options.length - 1];
}

// ---------------------------------------------------------------------------------------------
// Public selector
// ---------------------------------------------------------------------------------------------

const holdResult = (reason, extraReasons = []) => ({
  kind: 'hold',
  presetId: null,
  family: null,
  recipe: null,
  variant: null,
  score: 0,
  probability: 0,
  reasons: ['hold', ...new Set([reason, ...extraReasons])],
  droppedChannels: [],
});

function evaluate(context, overrides, index, relaxed) {
  const entries = collectCandidates(context, overrides, index);
  if (entries.length === 0) return { entries, families: [] };
  const scored = entries.map(entry => scoreCandidate(entry, context, overrides, relaxed));
  return { entries, families: groupWeights(scored) };
}

/**
 * @param {{presets?: Array, catalog?: ReturnType<typeof createPresetIndex>,
 *          minFamilies?: number,
 *          overrides?: {disabled?: string[], disabledFamilies?: string[],
 *                      familyPriority?: Record<string, number>,
 *                      actionPriority?: Record<string, number>}}} [options]
 */
export function createPresetSelector({
  presets = PRESETS,
  catalog = null,
  overrides = {},
  minFamilies = MIN_FAMILIES,
} = {}) {
  const index = catalog ?? createPresetIndex(presets);
  if (index === null || typeof index !== 'object' || !Array.isArray(index.presets)) {
    throw new TypeError('preset-selector: catalog must come from createPresetIndex');
  }
  if (!Number.isInteger(minFamilies) || minFamilies < 1) {
    throw new TypeError('preset-selector: minFamilies must be a positive integer');
  }
  const baseOverrides = normalizeOverrides(overrides);

  const resolve = (context) => {
    const normalized = normalizeContext(context);
    if (!normalized.ok) return { ok: false, reason: normalized.reason };
    const callOverrides = context.overrides === undefined
      ? baseOverrides
      : normalizeOverrides(context.overrides);
    return { ok: true, context: normalized.context, overrides: callOverrides };
  };

  const query = (context = {}) => {
    const resolved = resolve(context);
    if (!resolved.ok) return [];
    return collectCandidates(resolved.context, resolved.overrides, index).map(entry => entry.preset);
  };

  const candidates = (context = {}) => {
    const resolved = resolve(context);
    if (!resolved.ok) return [];
    return collectCandidates(resolved.context, resolved.overrides, index);
  };

  const explain = (context = {}) => {
    const resolved = resolve(context);
    if (!resolved.ok) {
      return { ok: false, reason: resolved.reason, candidates: [], families: [], hold: { weight: HOLD_WEIGHT } };
    }
    let relaxed = false;
    let evaluation = evaluate(resolved.context, resolved.overrides, index, false);
    if (evaluation.families.length < minFamilies && evaluation.families.length > 0) {
      relaxed = true;
      evaluation = evaluate(resolved.context, resolved.overrides, index, true);
    }
    const total = evaluation.families.reduce((sum, family) => sum + family.weight, 0) + HOLD_WEIGHT;
    return {
      ok: true,
      candidates: evaluation.entries,
      families: evaluation.families.map(family => {
        const recipeSum = family.recipes.reduce((sum, recipe) => sum + recipe.weight, 0);
        return {
          family: family.family,
          weight: family.weight,
          probability: family.weight / total,
          recipes: family.recipes.map(recipe => {
            const variantSum = recipe.variants.reduce((sum, variant) => sum + variant.weight, 0);
            return {
              recipe: recipe.recipe,
              weight: recipe.weight,
              probability: recipe.weight / recipeSum,
              variants: recipe.variants.map(variant => ({
                presetId: variant.presetId,
                variant: variant.variant,
                weight: variant.weight,
                probability: variant.weight / variantSum,
              })),
            };
          }),
        };
      }),
      hold: { weight: HOLD_WEIGHT, probability: HOLD_WEIGHT / total },
      relaxed,
    };
  };

  const select = (context = {}) => {
    const resolved = resolve(context);
    if (!resolved.ok) return holdResult(resolved.reason);
    const { context: ctx, overrides: callOverrides } = resolved;
    let relaxed = false;
    let evaluation = evaluate(ctx, callOverrides, index, false);
    if (evaluation.families.length === 0) return holdResult('no-candidates');
    let relaxReasons = [];
    if (evaluation.families.length < minFamilies) {
      relaxed = true;
      evaluation = evaluate(ctx, callOverrides, index, true);
      relaxReasons = ['candidate-shortage', 'relaxed-soft-penalties'];
    }
    if (evaluation.families.length === 0) {
      return holdResult('no-candidates', relaxReasons);
    }
    const total = evaluation.families.reduce((sum, family) => sum + family.weight, 0) + HOLD_WEIGHT;
    const rand = createRandom({
      seed: context?.seed,
      rand: context?.rand,
    });
    const options = [...evaluation.families.map(family => ({ kind: 'family', family })), { kind: 'hold' }];
    const picked = pickWeighted(
      options,
      option => (option.kind === 'hold' ? HOLD_WEIGHT : option.family.weight),
      rand,
    );
    if (picked === null || picked.kind === 'hold') {
      return holdResult(
        evaluation.families.length < minFamilies ? 'candidate-shortage' : 'hold-draw',
        relaxReasons,
      );
    }
    const family = picked.family;
    const recipe = pickWeighted(family.recipes, item => item.weight, rand);
    if (recipe === null) return holdResult('hold-draw', relaxReasons);
    const variant = pickWeighted(recipe.variants, item => item.weight, rand);
    if (variant === null) return holdResult('hold-draw', relaxReasons);
    const chosen = variant.candidate;
    // Probability actually used by the three roulette stages above (hold shares the first stage).
    const recipeSum = family.recipes.reduce((sum, item) => sum + item.weight, 0);
    const variantSum = recipe.variants.reduce((sum, item) => sum + item.weight, 0);
    const probability = (family.weight / total) * (recipe.weight / recipeSum) * (variant.weight / variantSum);
    const factors = chosen.factors;
    const reasons = [
      `state-fit:${round(factors.stateFit)}`,
      `event-fit:${round(factors.eventFit)}`,
      `persona-fit:${round(factors.personaFit)}`,
      `repeat:${round(factors.repeat)}`,
      `frequency:${round(factors.frequency)}`,
      `priority:${factors.priority}`,
      `priority-multiplier:${round(factors.priorityMultiplier)}`,
      `family-weight:${round(family.weight)}`,
      `probability:${round(probability, 4)}`,
      ...relaxReasons,
    ];
    if (chosen.droppedChannels.length > 0) {
      reasons.push(`dropped-channels:${chosen.droppedChannels.join(',')}`);
    }
    return {
      kind: 'preset',
      presetId: chosen.preset.id,
      family: chosen.preset.family,
      recipe: chosen.preset.recipeId,
      variant: variant.variant,
      score: chosen.weight,
      probability,
      relaxed,
      reasons,
      droppedChannels: [...chosen.droppedChannels],
      timing: chosen.preset.timing,
      operations: chosen.preset.operations,
      requires: chosen.preset.requires,
      effectiveRequires: chosen.preset.requires.filter(channel => !chosen.droppedChannels.includes(channel)),
    };
  };

  const stats = () => index.stats();

  return Object.freeze({ select, explain, query, candidates, stats, index, overrides: baseOverrides });
}

export const PRESET_SELECTOR_CONSTANTS = Object.freeze({
  HOLD_WEIGHT,
  MIN_FAMILIES,
  DEFAULT_PRIORITY,
  DEFAULT_RECENT_WINDOW,
  DEFAULT_FREQUENCY_WINDOW_MS,
  INTENT_EVENT_SEMANTIC,
  OPTIONAL_OPERATION_CHANNELS,
});
