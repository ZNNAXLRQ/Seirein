import { RECIPES } from './recipes.js';
import { STYLE_BY_ID } from './styles.js';

/** Four temporal arrangements per choreography; deliberately not four amplitude copies. */
export const VARIANTS = Object.freeze([
  Object.freeze({ id: 'flow', label: '连贯接续', onset: 'continuous', pacing: 'connected', hold: 'brief', release: 'blend' }),
  Object.freeze({ id: 'pause', label: '停顿后动作', onset: 'pause-before', pacing: 'connected', hold: 'brief', release: 'blend' }),
  Object.freeze({ id: 'linger', label: '动作后停留', onset: 'continuous', pacing: 'connected', hold: 'lingering', release: 'blend' }),
  Object.freeze({ id: 'spaced', label: '分阶段接续', onset: 'continuous', pacing: 'separated', hold: 'brief', release: 'unhurried' }),
]);

/**
 * Stable ids are independent of display naming and style edits. Styles are affinities, not bans.
 * No Cartesian multiplication by personality: 16 styles share the same choreography vocabulary.
 */
export const PRESETS = Object.freeze(RECIPES.flatMap((recipe, recipeIndex) => VARIANTS.map((variant, variantIndex) => {
  const style = STYLE_BY_ID.get(recipe.styles[0]);
  const number = String(recipeIndex * VARIANTS.length + variantIndex + 1).padStart(4, '0');
  return Object.freeze({
    id: `${recipe.id}.${variant.id}`,
    name: `${style.shortName}-${recipe.semantic}-${recipe.events[0]}-${number}`,
    label: `${recipe.label} · ${variant.label}`,
    family: recipe.family,
    recipeId: recipe.id,
    states: recipe.states, events: recipe.events, semantic: recipe.semantic,
    styles: recipe.styles, requires: recipe.requires,
    requiresTarget: recipe.requiresTarget, requiresDirection: recipe.requiresDirection,
    operations: recipe.operations, timing: variant,
    priority: 50,
    returnPolicy: 'current-natural-posture',
    interruptPolicy: 'blend-from-observed-pose',
  });
})));

const byId = new Map(PRESETS.map(preset => [preset.id, preset]));
const index = key => {
  const result = new Map();
  for (const preset of PRESETS) {
    for (const value of Array.isArray(preset[key]) ? preset[key] : [preset[key]]) {
      if (!result.has(value)) result.set(value, new Set());
      result.get(value).add(preset.id);
    }
  }
  return result;
};
const byState = index('states');
const byEvent = index('events');
const byFamily = index('family');

export const getPreset = id => byId.get(id) ?? null;

/**
 * Pure hard filter, NOT the runtime selector. Invalid/missing context fails closed.
 * `verifiedChannels` must come from current model discovery; names are semantic channels.
 * `targetVerified` and `directionVerified` are proofs supplied by the adapter, never inferred.
 * Snapshot config/context before calling; this function has no capture, timers or parameter I/O.
 */
export function queryPresets({
  state, event, semantic = 'neutral', verifiedChannels = [],
  targetVerified = false, directionVerified = false,
  disabledIds = [], disabledFamilies = [], family,
  privacy = false, disposed = false,
} = {}) {
  if (privacy || disposed) return [];
  const buckets = [byState.get(state), byEvent.get(event)];
  if (family !== undefined) buckets.push(byFamily.get(family));
  if (buckets.some(bucket => bucket === undefined)) return [];
  const smallest = buckets.reduce((a, b) => a.size < b.size ? a : b);
  const channels = new Set(verifiedChannels);
  const disabled = new Set(disabledIds);
  const bannedFamilies = new Set(disabledFamilies);
  return [...smallest].filter(id => buckets.every(bucket => bucket.has(id))).map(id => byId.get(id)).filter(preset =>
    (preset.semantic === 'neutral' || preset.semantic === semantic) &&
    !disabled.has(preset.id) && !bannedFamilies.has(preset.family) &&
    preset.requires.every(channel => channels.has(channel)) &&
    (!preset.requiresTarget || targetVerified === true) &&
    (!preset.requiresDirection || directionVerified === true));
}

export function catalogStats() {
  return {
    recipes: RECIPES.length, variants: VARIANTS.length, presets: PRESETS.length,
    styles: STYLE_BY_ID.size, families: byFamily.size,
    byState: Object.fromEntries([...byState].map(([key, ids]) => [key, ids.size])),
  };
}
