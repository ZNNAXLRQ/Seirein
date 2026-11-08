/**
 * P-59: layered context budgets for the three reply entries (voice / typed / fast path).
 *
 * The budget is spent per LAYER, never by slicing the final joined string:
 *
 *   persona   — persona + the functional constraints every lane must keep
 *   fixed     — fixed memory / standing constraints
 *   memory    — relevance memories for this turn
 *   recent    — recent dialogue / conversation observations
 *   ephemeral — temporary perception (nonverbal cue, environment facts)
 *
 * `persona` and `fixed` are PROTECTED: they are always rendered whole, even when they exceed
 * their own quota. Only `memory` / `recent` / `ephemeral` are trimmed, in that priority order,
 * and the trimming is whole-item (a line/record is either included or dropped — never cut in
 * half). Every dropped item is counted per layer so the caller can report `context.budget`
 * without leaking any body text.
 *
 * A lane's total is the sum of its layer quotas unless `totalChars` is configured. Whatever the
 * protected layers spend is unavailable to the rest, so a very small lane total still yields a
 * valid request containing persona + fixed only.
 *
 * All units are characters (Unicode code units, `String#length`), the same unit the existing
 * dialogue / memory / fast-path caps use.
 */

/** Layer order is also the reporting order. */
export const CONTEXT_LAYER_NAMES = Object.freeze(['persona', 'fixed', 'memory', 'recent', 'ephemeral']);
/** Layers that are never trimmed by a budget. */
export const CONTEXT_PROTECTED_LAYERS = Object.freeze(['persona', 'fixed']);
/** The three reply entries P-59 must cover. */
export const CONTEXT_LANES = Object.freeze(['voice', 'typed', 'fastpath']);

/**
 * Defaults are deliberately loose: they bound a pathological prompt without changing the
 * existing normal-session content. They are the declared quotas; a deployment narrows them with
 * `contextBudgets.{voice,typed,fastpath}`. The fast path keeps its old 6000-character envelope,
 * now as a per-layer plan rather than a final-string slice.
 */
export const DEFAULT_CONTEXT_BUDGETS = Object.freeze({
  voice: Object.freeze({
    persona: 4_000, fixed: 1_200, memory: 1_200, recent: 4_000, ephemeral: 2_000, totalChars: null,
  }),
  typed: Object.freeze({
    persona: 5_000, fixed: 1_200, memory: 1_200, recent: 5_000, ephemeral: 2_000, totalChars: null,
  }),
  fastpath: Object.freeze({
    persona: 1_800, fixed: 800, memory: 900, recent: 2_300, ephemeral: 200, totalChars: 6_000,
  }),
});

const EMPTY_STAT = Object.freeze({ chars: 0, items: 0, dropped: 0, dropReasons: Object.freeze({}) });

/** Positive-or-zero finite override; anything else falls back. */
function nonNegative(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}

/** `String#length` is the one unit every existing context budget in this repo counts. */
export function contextChars(text) {
  return String(text ?? '').length;
}

/** Normalize a lane; an unknown lane is treated as the typed entry. */
export function normalizeContextLane(lane) {
  return CONTEXT_LANES.includes(lane) ? lane : 'typed';
}

/**
 * Resolve one lane's per-layer quotas from `config.contextBudgets[lane]`.
 *
 * `config` may be the plugin config (`{contextBudgets: {...}}`) or an already-selected budget
 * object under `contextBudgets`. Missing/invalid fields fall back to the lane defaults; a
 * configured layer is marked so callers can distinguish "tightened on purpose" from "default".
 *
 * @param {object|null|undefined} config
 * @param {'voice'|'typed'|'fastpath'} lane
 * @returns {{lane: string, persona: number, fixed: number, memory: number, recent: number,
 *            ephemeral: number, totalChars: number, configured: boolean}}
 */
export function resolveContextBudget(config, lane) {
  const normalized = normalizeContextLane(lane);
  const defaults = DEFAULT_CONTEXT_BUDGETS[normalized];
  const table = config?.contextBudgets ?? config;
  const source = table !== null && typeof table === 'object' && table[normalized] !== null
    && typeof table[normalized] === 'object'
    ? table[normalized]
    : null;
  const budget = {
    lane: normalized,
    persona: nonNegative(source?.persona, defaults.persona),
    fixed: nonNegative(source?.fixed, defaults.fixed),
    memory: nonNegative(source?.memory, defaults.memory),
    recent: nonNegative(source?.recent, defaults.recent),
    ephemeral: nonNegative(source?.ephemeral, defaults.ephemeral),
    totalChars: 0,
    configured: source !== null,
  };
  const explicitTotal = source?.totalChars ?? source?.total;
  budget.totalChars = explicitTotal === null || explicitTotal === undefined
    ? (defaults.totalChars === null
      ? budget.persona + budget.fixed + budget.memory + budget.recent + budget.ephemeral
      : nonNegative(defaults.totalChars, 0))
    : nonNegative(explicitTotal, 0);
  return budget;
}

/**
 * One per-layer input as `{heading, items, separator, keep, text, headingLines}`; a bare string is
 * one item. `text` is the already-joined form (recent/observation blocks): it is trimmed by line so
 * `headingLines` can protect a leading header exactly like the old one-layer helper.
 */
function normalizeLayer(value) {
  if (typeof value === 'string') return { heading: '', items: value.length > 0 ? [value] : [], separator: '\n', keep: 'head', text: undefined, headingLines: 0 };
  if (Array.isArray(value)) return { heading: '', items: value, separator: '\n', keep: 'head', text: undefined, headingLines: 0 };
  if (value === null || typeof value !== 'object') return { heading: '', items: [], separator: '\n', keep: 'head', text: undefined, headingLines: 0 };
  return {
    heading: typeof value.heading === 'string' ? value.heading : '',
    items: Array.isArray(value.items) ? value.items : [],
    separator: typeof value.separator === 'string' ? value.separator : '\n',
    keep: value.keep === 'tail' ? 'tail' : 'head',
    text: typeof value.text === 'string' ? value.text : undefined,
    headingLines: Math.max(0, Math.floor(Number(value.headingLines) || 0)),
  };
}

/** An item is a string or `{text}`; empty text is skipped and never counted. */
function itemText(item) {
  if (typeof item === 'string') return item;
  return typeof item?.text === 'string' ? item.text : '';
}

function bump(counts, reason) {
  counts[reason] = (counts[reason] ?? 0) + 1;
}

function emptyStat() {
  return { chars: 0, items: 0, dropped: 0, dropReasons: {} };
}

/**
 * Trim ONE layer to `allowedChars` whole items. The heading is kept when it fits; a layer with no
 * room (or whose heading alone does not fit) renders empty and reports every item as dropped.
 * `keep: 'tail'` keeps the newest items (recent dialogue); the default keeps the highest-priority
 * items (memory).
 *
 * @param {{layer?: string, text?: string, heading?: string, items?: Array<string|{text: string}>,
 *          separator?: string, keep?: 'head'|'tail', headingLines?: number}} input
 * @param {number} allowedChars
 * @returns {{text: string, chars: number, items: number, dropped: number,
 *            dropReasons: Record<string, number>, budget: number}}
 */
export function trimLayerText(input = {}, allowedChars = 0) {
  const allowed = Math.max(0, Math.floor(Number(allowedChars) || 0));
  // Untouched fast path: a text that already fits is returned verbatim (byte-identical, no empty
  // lines collapsed), so context observation budgets never rewrite a request that is in budget.
  if (typeof input.text === 'string' && input.text.length <= allowed) {
    return {
      text: input.text,
      chars: input.text.length,
      items: input.text.length === 0 ? 0 : input.text.split('\n').filter((line) => line.length > 0).length,
      dropped: 0,
      dropReasons: {},
      budget: allowed,
    };
  }
  const separator = typeof input.separator === 'string' ? input.separator : '\n';
  let heading = typeof input.heading === 'string' ? input.heading : '';
  let items;
  if (typeof input.text === 'string') {
    const lines = input.text.split('\n');
    const headingLines = Math.max(0, Math.floor(Number(input.headingLines) || 0));
    heading = headingLines > 0 ? lines.slice(0, headingLines).join('\n') : heading;
    items = lines.slice(headingLines);
  } else {
    items = Array.isArray(input.items) ? input.items : [];
  }
  items = items.map(itemText).filter((text) => text.length > 0);
  if (items.length === 0 && heading.length === 0) return { ...emptyStat(), text: '', budget: allowed };
  if (allowed <= 0 || heading.length > allowed) {
    const dropReasons = {};
    if (items.length > 0) bump(dropReasons, 'no-budget');
    const dropped = items.length;
    return { text: '', chars: 0, items: 0, dropped, dropReasons, budget: allowed };
  }
  const chosen = new Array(items.length).fill(false);
  const dropReasons = {};
  let used = heading.length;
  let dropped = 0;
  const order = input.keep === 'tail'
    ? items.map((_item, index) => index).reverse()
    : items.map((_item, index) => index);
  for (const index of order) {
    // A heading already occupies the layer, so the first kept item still needs one separator.
    const hasPrefix = heading.length > 0 || chosen.some((value) => value === true);
    const need = (hasPrefix ? separator.length : 0) + items[index].length;
    if (used + need <= allowed) {
      chosen[index] = true;
      used += need;
      continue;
    }
    dropped += 1;
    bump(dropReasons, 'layer-budget');
  }
  const kept = items.filter((_item, index) => chosen[index]);
  const text = heading.length === 0 ? kept.join(separator) : [heading, ...kept].join(separator);
  return { text, chars: text.length, items: kept.length, dropped, dropReasons, budget: allowed };
}

/**
 * Trim an ORDERED list of temporary blocks against ONE shared allowance.
 *
 * Voice/typed render several independent observation sections (environment facts, nonverbal cue,
 * …); they may not each spend the full `ephemeral` quota. They share it here,
 * in rendering order: each block is trimmed whole-line against what the previous blocks left, and
 * every block (including the empty ones) is returned under its stable `name`, so the section
 * callbacks place exactly the text this allocation measured.
 *
 * @param {Array<{name?: string, text?: string, heading?: string, items?: Array, separator?: string,
 *                keep?: 'head'|'tail', headingLines?: number}>} blocks
 * @param {number} allowedChars
 * @returns {{blocks: Record<string, string>, chars: number, items: number, dropped: number,
 *            dropReasons: Record<string, number>, budget: number}}
 */
export function trimTemporaryBlocks(blocks = [], allowedChars = 0) {
  const allowed = Math.max(0, Math.floor(Number(allowedChars) || 0));
  let remaining = allowed;
  const out = {};
  const dropReasons = {};
  let chars = 0;
  let items = 0;
  let dropped = 0;
  const list = Array.isArray(blocks) ? blocks : [];
  for (const [index, block] of list.entries()) {
    const name = typeof block?.name === 'string' && block.name.length > 0 ? block.name : `block${index}`;
    const trimmed = trimLayerText({
      text: typeof block?.text === 'string' ? block.text : undefined,
      heading: block?.heading,
      items: block?.items,
      separator: block?.separator,
      keep: block?.keep,
      headingLines: block?.headingLines,
      layer: 'ephemeral',
    }, remaining);
    out[name] = trimmed.text;
    chars += trimmed.chars;
    items += trimmed.items;
    dropped += trimmed.dropped;
    for (const [reason, count] of Object.entries(trimmed.dropReasons)) {
      dropReasons[reason] = (dropReasons[reason] ?? 0) + count;
    }
    remaining = Math.max(0, remaining - trimmed.chars);
  }
  return { blocks: out, chars, items, dropped, dropReasons, budget: allowed };
}

/** Normalize `trimLayerText` / a prepared layer stat into the four observable fields. */
function normalizeStat(stat) {
  if (stat === null || stat === undefined || typeof stat !== 'object') return { ...EMPTY_STAT, dropReasons: {} };
  return {
    chars: nonNegative(stat.chars, 0),
    items: nonNegative(stat.items, 0),
    dropped: nonNegative(stat.dropped, 0),
    dropReasons: stat.dropReasons !== null && typeof stat.dropReasons === 'object'
      ? { ...stat.dropReasons }
      : {},
  };
}

/** Merge two stat sources (e.g. the fixed-memory section + C2's fixed rows). */
function mergeStats(left, right) {
  const first = normalizeStat(left);
  const second = normalizeStat(right);
  const dropReasons = { ...first.dropReasons };
  for (const [reason, count] of Object.entries(second.dropReasons)) {
    dropReasons[reason] = (dropReasons[reason] ?? 0) + count;
  }
  return {
    chars: first.chars + second.chars,
    items: first.items + second.items,
    dropped: first.dropped + second.dropped,
    dropReasons,
  };
}

function layerCount(text, separator = '\n') {
  const value = String(text ?? '');
  return value.length === 0 ? 0 : value.split(separator).filter((line) => line.length > 0).length;
}

/**
 * Allocate one lane's five layers.
 *
 * persona/fixed are included whole first (`protected`), then memory -> recent -> ephemeral each
 * get `min(quota, remaining)`. A layer that cannot use its full allowance leaves the remainder
 * to the next layer; dropped items are reported per layer with a reason.
 *
 * Voice/typed prepare their memory block in a different event than the prompt sections, so they
 * pass `reserveMemory: true`: the memory layer only RESERVES min(quota, remaining), and recent /
 * ephemeral may spend only what is left after that reservation. The pre-step then caps the actual
 * injected memory block at that reservation, so one allocation covers both events.
 *
 * `layers.ephemeralBlocks` is an ordered list of temporary sections (environment facts, nonverbal
 * cue, …). They share the ONE ephemeral allowance (see `trimTemporaryBlocks`); `plan.temporary`
 * maps each block name to the exact text it may render.
 *
 * @param {{lane?: string, layers?: object, budget?: object|null, reserveMemory?: boolean}} options
 * @returns {{lane: string, budget: object, totalChars: number, totalBudget: number,
 *            truncated: boolean, protectedOverflow: boolean, text: string,
 *            blocks: Record<string, string>, temporary: Record<string, string>|null,
 *            layers: Record<string, object>}}
 */
export function assembleLayerPlan({ lane = 'typed', layers = {}, budget = null, reserveMemory = false } = {}) {
  const normalizedLane = normalizeContextLane(lane);
  const resolved = budget ?? resolveContextBudget(null, normalizedLane);
  const plan = { lane: normalizedLane, budget: resolved, blocks: {}, layers: {}, temporary: null };
  let total = 0;

  // Protected layers: rendered whole, never trimmed.
  for (const name of ['persona', 'fixed']) {
    const layer = normalizeLayer(layers?.[name]);
    const items = layer.items.map(itemText).filter((text) => text.length > 0);
    const text = [layer.heading, ...items].filter((part) => part.length > 0).join(layer.separator);
    plan.blocks[name] = text;
    plan.layers[name] = {
      chars: text.length,
      items: items.length,
      dropped: 0,
      dropReasons: {},
      budget: nonNegative(resolved?.[name], 0),
      protected: true,
      overBudget: text.length > nonNegative(resolved?.[name], 0),
    };
    total += text.length;
  }

  let remaining = Math.max(0, nonNegative(resolved?.totalChars, total) - total);
  for (const name of ['memory', 'recent', 'ephemeral']) {
    const layer = normalizeLayer(layers?.[name]);
    const quota = nonNegative(resolved?.[name], 0);
    const allowed = Math.min(quota, remaining);
    if (name === 'memory' && reserveMemory === true) {
      // The real memory text is composed by the pre-step; this event only reserves its room. It
      // is not a rendered block, so it must never be counted as injected text.
      plan.blocks.memory = '';
      plan.layers.memory = {
        chars: allowed,
        items: 0,
        dropped: 0,
        dropReasons: {},
        budget: quota,
        reserved: true,
      };
      remaining = Math.max(0, remaining - allowed);
      continue;
    }
    if (name === 'ephemeral' && Array.isArray(layers?.ephemeralBlocks)) {
      // Every temporary observation block draws from this one allowance, in rendering order.
      const shared = trimTemporaryBlocks(layers.ephemeralBlocks, allowed);
      plan.temporary = shared.blocks;
      plan.blocks.ephemeral = Object.values(shared.blocks).filter((text) => text.length > 0).join('\n\n');
      plan.layers.ephemeral = {
        chars: shared.chars,
        items: shared.items,
        dropped: shared.dropped,
        dropReasons: shared.dropReasons,
        budget: quota,
      };
      remaining = Math.max(0, remaining - shared.chars);
      total += shared.chars;
      continue;
    }
    const trimmed = trimLayerText({
      text: layer.text,
      heading: layer.heading,
      items: layer.items,
      separator: layer.separator,
      keep: layer.keep,
      headingLines: layer.headingLines,
      layer: name,
    }, allowed);
    plan.blocks[name] = trimmed.text;
    plan.layers[name] = {
      chars: trimmed.chars,
      items: trimmed.items,
      dropped: trimmed.dropped,
      dropReasons: trimmed.dropReasons,
      budget: quota,
    };
    remaining = Math.max(0, remaining - trimmed.chars);
    total += trimmed.chars;
  }

  const blocks = CONTEXT_LAYER_NAMES.map((name) => plan.blocks[name]).filter((text) => text.length > 0);
  plan.text = blocks.join('\n\n');
  plan.totalChars = plan.text.length;
  plan.totalBudget = nonNegative(resolved?.totalChars, 0);
  const protectedChars = plan.layers.persona.chars + plan.layers.fixed.chars;
  plan.protectedOverflow = plan.layers.persona.overBudget === true
    || plan.layers.fixed.overBudget === true
    || protectedChars > plan.totalBudget;
  plan.truncated = CONTEXT_LAYER_NAMES.some((name) => plan.layers[name].dropped > 0);
  return plan;
}

/**
 * The one debug payload of a lane round: `context.budget`.
 *
 * It never carries body text — only per-layer counts plus the lane totals. `memoryLayers` is
 * what the memory preparation actually rendered (fixed/memory). When the prompt path passes the
 * `plan` it rendered, the payload is read straight from that plan (one allocation, no second
 * trimming); otherwise `measured` raw text is trimmed here as a fallback for a pre-step that ran
 * without a prompt assembly.
 *
 * @param {{lane?: string, budget?: object|null, measured?: object, memoryLayers?: object|null,
 *          plan?: object|null}} options
 */
export function buildContextBudgetPayload({
  lane = 'typed', budget = null, measured = {}, memoryLayers = null, plan = null,
} = {}) {
  const normalizedLane = normalizeContextLane(lane);
  const resolved = budget ?? resolveContextBudget(null, normalizedLane);
  const empty = () => ({ chars: 0, items: 0, dropped: 0, dropReasons: {} });
  if (plan !== null && plan !== undefined && plan.layers !== null && typeof plan.layers === 'object') {
    const persona = normalizeStat(plan.layers.persona);
    // Fixed is protected but has two sources: the resident resource section and C2's fixed rows.
    const fixed = mergeStats(plan.layers.fixed, memoryLayers?.fixed);
    // A reserved prompt layer is not injected text: only what the pre-step actually composed counts.
    const memory = memoryLayers !== null && memoryLayers !== undefined
      ? {
        ...normalizeStat(memoryLayers.memory),
        // `total` is the whole rendered block (frame included); fall back to content lines when an
        // older/other composer did not provide it.
        chars: Number.isFinite(Number(memoryLayers.total)) && Number(memoryLayers.total) >= 0
          ? Math.floor(Number(memoryLayers.total))
          : normalizeStat(memoryLayers.memory).chars,
      }
      : empty();
    const recent = normalizeStat(plan.layers.recent);
    const ephemeral = normalizeStat(plan.layers.ephemeral);
    const layers = { persona, fixed, memory, recent, ephemeral };
    const totalBudget = nonNegative(resolved?.totalChars, 0);
    return {
      lane: normalizedLane,
      layers,
      totalChars: CONTEXT_LAYER_NAMES.reduce((sum, name) => sum + layers[name].chars, 0),
      truncated: plan.truncated === true
        || CONTEXT_LAYER_NAMES.some((name) => layers[name].dropped > 0),
      totalBudget,
      protectedOverflow: plan.protectedOverflow === true
        || fixed.chars > nonNegative(resolved?.fixed, 0)
        || persona.chars + fixed.chars > totalBudget,
    };
  }
  const measuredText = (name) => {
    const value = measured?.[name];
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(itemText).filter((text) => text.length > 0).join('\n');
    return '';
  };
  const personaText = measuredText('persona');
  const persona = {
    chars: personaText.length,
    items: layerCount(personaText),
    dropped: 0,
    dropReasons: {},
  };
  // Fixed is protected but has two sources: the resident resource section and C2's fixed rows.
  const fixedSection = measuredText('fixed');
  const fixed = mergeStats({
    chars: fixedSection.length,
    items: layerCount(fixedSection),
    dropped: 0,
    dropReasons: {},
  }, memoryLayers?.fixed);
  const memory = normalizeStat(memoryLayers?.memory);
  const recent = trimLayerText({
    text: measuredText('recent'),
    headingLines: 1,
    keep: 'tail',
    layer: 'recent',
  }, nonNegative(resolved?.recent, 0));
  const ephemeral = trimLayerText({
    text: measuredText('ephemeral'),
    keep: 'head',
    layer: 'ephemeral',
  }, nonNegative(resolved?.ephemeral, 0));
  const layers = {
    persona,
    fixed,
    memory,
    recent: { chars: recent.chars, items: recent.items, dropped: recent.dropped, dropReasons: recent.dropReasons },
    ephemeral: { chars: ephemeral.chars, items: ephemeral.items, dropped: ephemeral.dropped, dropReasons: ephemeral.dropReasons },
  };
  const totalChars = CONTEXT_LAYER_NAMES.reduce((sum, name) => sum + layers[name].chars, 0);
  return {
    lane: normalizedLane,
    layers,
    totalChars,
    truncated: CONTEXT_LAYER_NAMES.some((name) => layers[name].dropped > 0),
    totalBudget: nonNegative(resolved?.totalChars, 0),
    protectedOverflow: persona.chars > nonNegative(resolved?.persona, 0)
      || fixed.chars > nonNegative(resolved?.fixed, 0),
  };
}

/** Merge per-layer exact bytes of one prepared slice (for reusing a plan in another event). */
export function contextLayerStats(plan) {
  const layers = {};
  for (const name of CONTEXT_LAYER_NAMES) {
    const stat = normalizeStat(plan?.layers?.[name]);
    layers[name] = stat;
  }
  return layers;
}
