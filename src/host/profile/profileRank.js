/**
 * ProfileStore step 2: score, adopt, forget and compile persona/profile entries.
 *
 * Everything exported here is a PURE function over plain objects: same input → same output,
 * no database, filesystem, clock, network or randomness. `profileStore.js` owns the rows and
 * only reads evidence / persists the values these functions derive.
 *
 * Lifecycle (the user fixed these rules on 2026-11-06):
 *   - score: S = C × E / 100, with C and E in 0..100;
 *   - a NEW entry enters adoption competition at independentSupports >= 2 AND C >= 60;
 *   - an ADOPTED (`original`) entry leaves competition when C < 40;
 *   - C < 10 is the fifth stage: delete outright, never archive;
 *   - one independent support = one distinct evidence message_id (a discussion's repeated
 *     expressions count once); a new support is C +10 / E +3, a replayed message is a no-op;
 *   - natural decay is C -2 (E unchanged), applied once per round to an entry that was neither
 *     supported/contradicted nor selected, and only when the round brought a new exchange batch
 *     (no exchange, no decay — being switched off must not forget anything); a selected entry is
 *     exempt and is never "decayed then restored";
 *   - occasional/vague contradiction is C -5, sustained clear contradiction is C -10 / E -5;
 *     the resulting drop is final: being selected later in the same round never offsets it;
 *   - a locked entry is exempt from every automatic score/adoption change (only the user's own
 *     edit/reject may still move it). The lock is an additional convenience added during review,
 *     not part of the original design;
 *   - a user edit or reject bypasses every threshold (`ProfileStore.edit` / `reject` apply it
 *     directly); this module never gates a user value.
 *
 * Budgets: every category starts with a base token allowance (default 120); unused allowance
 * is borrowable by other categories, while the total (default 600) is a hard cap. Selection is
 * by S from high to low. An entry that does not fit is left whole — text is never truncated;
 * it is reported as `skippedByBudget` instead. Selected entries become rank `original`, every
 * live unselected entry becomes `new` with its score and evidence untouched, so it can compete
 * again next round.
 */
import { createHash } from 'node:crypto';

/** Section title + category order for each side. */
export const PROFILE_SECTIONS = Object.freeze({
  agent: Object.freeze({
    title: '人设（自动整理）',
    categories: Object.freeze(['性格', '相处', '语言', '形象']),
  }),
  user: Object.freeze({
    title: '用户偏好（自动整理）',
    categories: Object.freeze(['饮食', '运动', '娱乐', '生活习惯']),
  }),
});

/** One budget per category, plus the shared allowance any category may borrow. */
export const PROFILE_RANK_DEFAULTS = Object.freeze({
  // Adoption competition / retirement / forgetting.
  adoptionClarity: 60,
  adoptionSupports: 2,
  retirementClarity: 40,
  forgettingClarity: 10,
  // Score deltas.
  supportClarityGain: 10,
  supportEfficacyGain: 3,
  idleClarityLoss: 2,
  occasionalClarityLoss: 5,
  sustainedClarityLoss: 10,
  sustainedEfficacyLoss: 5,
  // Budgets (approximate tokens, see estimateProfileTokens).
  categoryBudget: 120,
  totalBudget: 600,
  categoryBudgets: Object.freeze({
    性格: 120,
    相处: 120,
    语言: 120,
    形象: 120,
    饮食: 120,
    运动: 120,
    娱乐: 120,
    生活习惯: 120,
  }),
});

const NUMERIC_CONFIG_KEYS = Object.freeze([
  'adoptionClarity',
  'adoptionSupports',
  'retirementClarity',
  'forgettingClarity',
  'supportClarityGain',
  'supportEfficacyGain',
  'idleClarityLoss',
  'occasionalClarityLoss',
  'sustainedClarityLoss',
  'sustainedEfficacyLoss',
  'categoryBudget',
  'totalBudget',
]);

const SIDES = Object.freeze(['agent', 'user']);

/** 0..100 integer score; an absent/invalid value falls back instead of throwing. */
function clampScore(value, fallback = 50) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(100, Math.round(number)));
}

/**
 * Resolve user-supplied overrides against the defaults. Unknown keys are ignored on purpose:
 * a bad config must not make the compiler throw in the middle of a round.
 */
export function resolveProfileRankConfig(overrides = {}) {
  const input = overrides !== null && typeof overrides === 'object' ? overrides : {};
  const config = {
    ...PROFILE_RANK_DEFAULTS,
    categoryBudgets: { ...PROFILE_RANK_DEFAULTS.categoryBudgets },
  };
  for (const key of NUMERIC_CONFIG_KEYS) {
    const value = Number(input[key]);
    if (Number.isFinite(value) && value >= 0) config[key] = Math.floor(value);
  }
  if (input.categoryBudgets !== null && typeof input.categoryBudgets === 'object') {
    // `categoryBudget` is the default for every category; an explicit `categoryBudgets` entry
    // still wins for that category.
    if (input.categoryBudget !== undefined) {
      for (const category of Object.keys(config.categoryBudgets)) config.categoryBudgets[category] = config.categoryBudget;
    }
    for (const [category, value] of Object.entries(input.categoryBudgets)) {
      const number = Number(value);
      if (Number.isFinite(number) && number >= 0) config.categoryBudgets[category] = Math.floor(number);
    }
  } else if (input.categoryBudget !== undefined) {
    for (const category of Object.keys(config.categoryBudgets)) config.categoryBudgets[category] = config.categoryBudget;
  }
  return config;
}

/**
 * Deterministic APPROXIMATION, not a tokenizer: every non-ASCII code point costs 1 token and
 * every 4 ASCII characters cost 1 token. It is used only to spread a budget, so the same text
 * always gets the same score on every machine; no model-specific tokenizer is involved.
 */
export function estimateProfileTokens(value) {
  let tokens = 0;
  let ascii = 0;
  for (const char of String(value ?? '')) {
    if (char.codePointAt(0) > 0x7f) {
      if (ascii > 0) {
        tokens += Math.ceil(ascii / 4);
        ascii = 0;
      }
      tokens += 1;
    } else {
      ascii += 1;
    }
  }
  if (ascii > 0) tokens += Math.ceil(ascii / 4);
  return tokens;
}

/** The exact prompt line for one entry. The entry text is always complete (never sliced). */
export function formatProfileLine(entry) {
  const category = String(entry?.category ?? '').trim() || '未分类';
  const clarity = clampScore(entry?.clarity);
  const efficacy = clampScore(entry?.efficacy);
  return `- [${category}] ${String(entry?.text ?? '')}（C=${clarity}, E=${efficacy}）`;
}

/** Token cost of one compiled line; the line itself is the budget unit. */
export function profileLineTokens(entry) {
  return estimateProfileTokens(formatProfileLine(entry));
}

/** S = C × E / 100 (at most two decimals, so a reported score is stable). */
export function profileScore(entry) {
  const clarity = clampScore(entry?.clarity);
  const efficacy = clampScore(entry?.efficacy);
  return Math.round(clarity * efficacy) / 100;
}

/** Distinct supporting message ids; a repeated message id counts once. */
export function independentSupportIds(evidence) {
  const ids = new Set();
  for (const row of Array.isArray(evidence) ? evidence : []) {
    if (row === null || typeof row !== 'object' || row.kind !== 'support') continue;
    const id = row.message_id ?? row.messageId;
    if (id === null || id === undefined || String(id).trim().length === 0) continue;
    ids.add(String(id));
  }
  return [...ids];
}

/**
 * Independent support count. A row without a message id cannot be deduplicated, so it counts
 * as its own occurrence (callers should supply ids); repeated rows with the same id count once.
 */
export function independentSupportCount(evidence) {
  const ids = new Set();
  let anonymous = 0;
  for (const row of Array.isArray(evidence) ? evidence : []) {
    if (row === null || typeof row !== 'object' || row.kind !== 'support') continue;
    const id = row.message_id ?? row.messageId;
    if (id === null || id === undefined || String(id).trim().length === 0) anonymous += 1;
    else ids.add(String(id));
  }
  return ids.size + anonymous;
}

/**
 * Deterministic natural decay for one quiet round: C - `idleClarityLoss` (default 2), E unchanged,
 * clamped at 0. "Quiet" means the round brought a new exchange batch but the entry was neither
 * mentioned with valid evidence nor selected: the caller decides that, this function is the rule.
 */
export function applyNaturalDecay(entry, { config: overrides } = {}) {
  const config = resolveProfileRankConfig(overrides);
  const clarity = clampScore(entry?.clarity);
  const efficacy = clampScore(entry?.efficacy);
  const nextClarity = Math.max(0, clarity - config.idleClarityLoss);
  return {
    clarity: nextClarity,
    efficacy,
    score: profileScore({ clarity: nextClarity, efficacy }),
    delta: { clarity: nextClarity - clarity, efficacy: 0 },
  };
}

/**
 * Apply one score event. This is the single scoring rulebook; `ProfileStore` only supplies the
 * already-seen message ids (for dedupe) and persists the returned clarity/efficacy.
 *
 * Events:
 *   { type: 'support', messageId }
 *   { type: 'idle', hasNewExchange }            // no new exchange batch → unchanged
 *   { type: 'contradiction', severity }         // 'occasional' (also accepts 'vague') | 'sustained'
 *
 * @returns {{clarity: number, efficacy: number, score: number, applied: boolean, reason: string,
 *            delta: {clarity: number, efficacy: number}}}
 */
export function applyRankEvent(entry, event = {}, { config: overrides, seenMessageIds = [] } = {}) {
  const config = resolveProfileRankConfig(overrides);
  const beforeClarity = clampScore(entry?.clarity);
  const beforeEfficacy = clampScore(entry?.efficacy);
  const seen = new Set(
    (Array.isArray(seenMessageIds) ? seenMessageIds : [])
      .map((id) => (id === null || id === undefined ? '' : String(id)))
      .filter((id) => id.length > 0),
  );
  const finish = (clarity, efficacy, applied, reason) => {
    const nextClarity = Math.max(0, Math.min(100, clarity));
    const nextEfficacy = Math.max(0, Math.min(100, efficacy));
    return {
      clarity: nextClarity,
      efficacy: nextEfficacy,
      score: profileScore({ clarity: nextClarity, efficacy: nextEfficacy }),
      applied,
      reason,
      delta: { clarity: nextClarity - beforeClarity, efficacy: nextEfficacy - beforeEfficacy },
    };
  };

  const type = event?.type;
  const messageId = event?.messageId;
  const replayed = messageId !== null && messageId !== undefined && String(messageId).length > 0
    && seen.has(String(messageId));
  if (type === 'support') {
    if (replayed) return finish(beforeClarity, beforeEfficacy, false, 'duplicate');
    return finish(
      beforeClarity + config.supportClarityGain,
      beforeEfficacy + config.supportEfficacyGain,
      true,
      'support',
    );
  }
  if (type === 'idle') {
    const batch = event?.hasNewExchange === true
      || (Array.isArray(event?.messages) && event.messages.length > 0);
    if (!batch) return finish(beforeClarity, beforeEfficacy, false, 'no-new-exchange');
    const decay = applyNaturalDecay(entry, { config });
    return finish(decay.clarity, decay.efficacy, true, 'idle');
  }
  if (type === 'contradiction') {
    if (replayed) return finish(beforeClarity, beforeEfficacy, false, 'duplicate');
    const severity = event?.severity ?? 'occasional';
    if (severity === 'sustained') {
      return finish(
        beforeClarity - config.sustainedClarityLoss,
        beforeEfficacy - config.sustainedEfficacyLoss,
        true,
        'sustained-contradiction',
      );
    }
    if (severity === 'occasional' || severity === 'vague') {
      return finish(beforeClarity - config.occasionalClarityLoss, beforeEfficacy, true, 'occasional-contradiction');
    }
    throw new Error(`unknown contradiction severity: ${String(severity)}`);
  }
  throw new Error(`unknown profile rank event: ${String(type)}`);
}

/**
 * Derived state of one entry: current scores, S, support count and whether it may be adopted.
 * `original` entries only need to stay at/above the retirement line; every other live entry
 * must meet the full adoption gate (support count + clarity). A user edit promotes the entry to
 * `original` in ProfileStore, so the user's explicit intent bypasses the support gate — budget
 * still applies, and the entry may still be retired by later contradictions.
 */
export function describeEntryRank(entry, { supportCount = 0, config: overrides } = {}) {
  const config = resolveProfileRankConfig(overrides);
  const clarity = clampScore(entry?.clarity);
  const efficacy = clampScore(entry?.efficacy);
  const supports = Math.max(0, Math.floor(Number(supportCount)) || 0);
  const original = entry?.rank === 'original';
  const forgotten = clarity < config.forgettingClarity;
  const eligible = !forgotten
    && (original
      ? clarity >= config.retirementClarity
      : clarity >= config.adoptionClarity && supports >= config.adoptionSupports);
  return {
    clarity,
    efficacy,
    score: profileScore({ clarity, efficacy }),
    supportCount: supports,
    original,
    forgotten,
    eligible,
  };
}

/**
 * Stable identity of a tendency. This MUST stay byte-identical to
 * `ProfileStore.profileFingerprint` (same side + whitespace/case normalization, same hash), so
 * an entry merged here is merged there too. Kept local only to avoid a circular import.
 */
function tendencyFingerprint(side, text) {
  const normalized = String(text ?? '').trim().replace(/\s+/gu, ' ').toLowerCase();
  return createHash('sha256').update(`${side}\n${normalized}`).digest('hex').slice(0, 32);
}

function fingerprintOf(entry) {
  if (typeof entry?.fingerprint === 'string' && entry.fingerprint.length > 0) return entry.fingerprint;
  return tendencyFingerprint(entry?.side, entry?.text);
}

/** S descending, then oldest first, then id — deterministic for equal scores. */
function compareCandidates(left, right) {
  if (right.score !== left.score) return right.score - left.score;
  const leftAt = String(left.created_at ?? left.createdAt ?? '');
  const rightAt = String(right.created_at ?? right.createdAt ?? '');
  if (leftAt !== rightAt) return leftAt < rightAt ? -1 : 1;
  return String(left.id).localeCompare(String(right.id));
}

function supportCountFor(entry, supportCounts) {
  if (supportCounts !== null && typeof supportCounts === 'object') {
    const hasMapApi = typeof supportCounts.get === 'function' && typeof supportCounts.has === 'function';
    if (hasMapApi && supportCounts.has(entry.id)) {
      return Math.max(0, Math.floor(Number(supportCounts.get(entry.id)) || 0));
    }
    if (Object.prototype.hasOwnProperty.call(supportCounts, entry.id)) {
      return Math.max(0, Math.floor(Number(supportCounts[entry.id]) || 0));
    }
  }
  const explicit = entry.supportCount ?? entry.independentSupports;
  if (explicit !== undefined && Number.isFinite(Number(explicit))) {
    return Math.max(0, Math.floor(Number(explicit)));
  }
  if (Array.isArray(entry.supports)) {
    const ids = new Set();
    for (const id of entry.supports) {
      if (id !== null && id !== undefined && String(id).trim().length > 0) ids.add(String(id));
    }
    return ids.size;
  }
  if (Array.isArray(entry.evidence)) return independentSupportCount(entry.evidence);
  return 0;
}

function orderedCategories(side, present) {
  const fixed = PROFILE_SECTIONS[side].categories;
  const extra = [...present]
    .filter((category) => !fixed.includes(category))
    .sort((left, right) => left.localeCompare(right, 'zh'));
  return [...fixed.filter((category) => present.has(category)), ...extra];
}

/**
 * Token cost the compiled block adds on top of its entry lines: one `## …` heading per present
 * side. The newline that joins a heading to its first line is absorbed by that line's leading
 * ASCII run (`\n- [` and `- [` cost the same one token), so the whole body is exactly
 * `sum(line tokens) + sum(heading tokens)` for the two sides. Selection reserves this before
 * spending the total budget, so `usedTokens` (the whole compiled text, see compileProfilePrompt)
 * can never pass the same ceiling the injection gate checks. Estimating it from the eligible
 * sides is a conservative superset: a side whose entries are all skipped still counts a heading.
 */
export function profilePromptOverheadTokens(sides) {
  let tokens = 0;
  for (const side of SIDES) {
    if (sides?.has?.(side) !== true) continue;
    tokens += estimateProfileTokens(`## ${PROFILE_SECTIONS[side].title}`);
  }
  return tokens;
}

/**
 * Choose the entries that fit the prompt budget.
 *
 * Pass 1 walks every eligible entry in global S order and lets each `(side, category)` spend
 * its base allowance (default 120). Pass 2 spends the remaining total capacity (default 600)
 * on the deferred entries in global S order, which is exactly how an unused category allowance
 * is borrowed. The heading overhead is reserved before either pass, so the compiled body fits
 * the same ceiling the injection gate checks. An entry that still does not fit is reported as
 * `skippedByBudget`; it is never shortened.
 *
 * @param {Array<object>} entries live entries (`id`, `side`, `category`, `text`, `clarity`,
 *   `efficacy`, `rank`, optional `supportCount`/`supports`/`evidence`)
 * @param {{supportCounts?: object|Map, config?: object}} [options]
 * @returns {{selected: object[], skipped: object[], forgotten: object[], ranks: object,
 *            usedTokens: number, budget: number, categoryUsed: object}}
 */
export function selectProfileEntries(entries, { supportCounts = null, config: overrides } = {}) {
  const config = resolveProfileRankConfig(overrides);
  const list = Array.isArray(entries) ? entries : [];
  const live = [];
  const forgotten = [];
  const skippedReasons = new Map();
  const seenIds = new Set();

  for (const raw of list) {
    if (raw === null || typeof raw !== 'object') continue;
    if (raw.rejected === true) continue;
    if (raw.id === undefined || raw.id === null) throw new Error('profile entry 缺少 id');
    const id = String(raw.id);
    if (seenIds.has(id)) continue;
    seenIds.add(id);
    if (!SIDES.includes(raw.side)) throw new Error(`unknown profile side: ${String(raw.side)}`);
    const supportCount = supportCountFor(raw, supportCounts);
    const state = describeEntryRank(raw, { supportCount, config });
    const locked = raw.locked === true;
    const base = {
      ...raw,
      id,
      clarity: state.clarity,
      efficacy: state.efficacy,
      score: state.score,
      supportCount,
    };
    // A locked entry is exempt from every automatic adjustment (an additional convenience added
    // during review, not an original design mechanism): it is never forgotten and its adoption
    // state never changes. An already-adopted (original) lock is still compiled, because the user
    // pinned exactly that line; a locked `new` entry is not auto-promoted.
    if (!locked && state.forgotten) {
      forgotten.push({ ...base, reason: 'forgotten' });
      continue;
    }
    const candidate = { ...base, tokens: profileLineTokens(base) };
    const eligible = locked ? raw.rank === 'original' : state.eligible;
    if (!eligible) {
      skippedReasons.set(id, locked ? 'locked' : 'threshold');
      continue;
    }
    live.push(candidate);
  }

  // Same fingerprint = one tendency. Keep the highest S and report the other as merged.
  const byFingerprint = new Map();
  for (const candidate of live) {
    const key = fingerprintOf(candidate);
    const current = byFingerprint.get(key);
    if (current === undefined) {
      byFingerprint.set(key, candidate);
      continue;
    }
    const winner = compareCandidates(candidate, current) < 0 ? candidate : current;
    const loser = winner === candidate ? current : candidate;
    byFingerprint.set(key, winner);
    skippedReasons.set(loser.id, 'duplicate');
  }

  const selected = [];
  const deferred = [];
  const categoryUsed = {};
  let usedTokens = 0;
  // Headings/separators are part of the injected block: reserve them up front so "the compile
  // fits 600" and "the injection is not skipped over 600" are the same statement.
  const overhead = profilePromptOverheadTokens(new Set([...byFingerprint.values()].map((entry) => entry.side)));
  const lineBudget = Math.max(0, config.totalBudget - overhead);

  // Pass 1: every eligible entry in global S order; a category may spend only its own base
  // allowance, so a category full of high-S items cannot starve another category's base.
  for (const candidate of [...byFingerprint.values()].sort(compareCandidates)) {
    const category = String(candidate.category ?? '').trim();
    const key = `${candidate.side}:${category}`;
    const base = Object.prototype.hasOwnProperty.call(config.categoryBudgets, category)
      ? config.categoryBudgets[category]
      : config.categoryBudget;
    const categorySpent = categoryUsed[key] ?? 0;
    if (categorySpent + candidate.tokens <= base && usedTokens + candidate.tokens <= lineBudget) {
      selected.push(candidate);
      usedTokens += candidate.tokens;
      categoryUsed[key] = categorySpent + candidate.tokens;
    } else {
      deferred.push(candidate);
    }
  }

  // Pass 2: borrow unused category allowance, highest S first, under the total cap.
  const stillDeferred = [...deferred].sort(compareCandidates);
  for (const candidate of stillDeferred) {
    if (usedTokens + candidate.tokens <= lineBudget) {
      selected.push(candidate);
      usedTokens += candidate.tokens;
      const key = `${candidate.side}:${String(candidate.category ?? '').trim()}`;
      categoryUsed[key] = (categoryUsed[key] ?? 0) + candidate.tokens;
    } else {
      skippedReasons.set(candidate.id, 'skippedByBudget');
    }
  }

  // Every live entry not selected falls back to `new`; scores/evidence are left untouched.
  const selectedIds = new Set(selected.map((entry) => entry.id));
  const ranks = {};
  for (const raw of list) {
    if (raw === null || typeof raw !== 'object' || raw.rejected === true) continue;
    const id = String(raw.id);
    if (!seenIds.has(id)) continue;
    if (forgotten.some((entry) => entry.id === id)) continue;
    if (raw.locked === true) {
      // Locking freezes the adoption state too: original stays original, new stays new.
      ranks[id] = typeof raw.rank === 'string' && raw.rank.length > 0 ? raw.rank : 'new';
      continue;
    }
    ranks[id] = selectedIds.has(id) ? 'original' : 'new';
  }

  const skipped = [];
  for (const raw of list) {
    if (raw === null || typeof raw !== 'object' || raw.rejected === true) continue;
    const id = String(raw.id);
    if (!skippedReasons.has(id)) continue;
    skipped.push({ id, reason: skippedReasons.get(id) });
  }

  return {
    selected,
    skipped,
    forgotten,
    ranks,
    usedTokens,
    budget: config.totalBudget,
    categoryUsed,
  };
}

/**
 * Compile the chosen entries into prompt sections. Entries are grouped by side and category,
 * same-fingerprint duplicates collapse to the highest S, and text is emitted whole.
 * `usedTokens` estimates the whole returned text (group headings included), the same unit
 * `formatProfilePrompt` gates on.
 */
export function compileProfilePrompt(selection, { config: overrides } = {}) {
  const config = resolveProfileRankConfig(overrides);
  const chosen = Array.isArray(selection?.selected) ? selection.selected : [];

  // Defensive merge: selection already merges, but compiling raw entries must obey the rule too.
  const byFingerprint = new Map();
  for (const entry of chosen) {
    const key = fingerprintOf(entry);
    const current = byFingerprint.get(key);
    if (current === undefined) {
      byFingerprint.set(key, entry);
      continue;
    }
    const currentScore = profileScore(current);
    const nextScore = profileScore(entry);
    if (nextScore > currentScore
      || (nextScore === currentScore && String(entry.id) < String(current.id))) {
      byFingerprint.set(key, entry);
    }
  }

  const sections = [];
  for (const side of SIDES) {
    const sideEntries = [...byFingerprint.values()].filter((entry) => entry.side === side);
    if (sideEntries.length === 0) continue;
    const grouped = new Map();
    for (const entry of sideEntries) {
      const category = String(entry.category ?? '').trim();
      if (!grouped.has(category)) grouped.set(category, []);
      grouped.get(category).push(entry);
    }
    const lines = [];
    const entries = [];
    for (const category of orderedCategories(side, new Set(grouped.keys()))) {
      for (const entry of [...grouped.get(category)].sort(compareCandidates)) {
        lines.push(formatProfileLine(entry));
        entries.push(entry);
      }
    }
    const heading = `## ${PROFILE_SECTIONS[side].title}`;
    sections.push({
      side,
      title: PROFILE_SECTIONS[side].title,
      heading,
      lines,
      text: `${heading}\n${lines.join('\n')}`,
      entries,
    });
  }

  const selectedTokens = estimateProfileTokens(sections.map((section) => section.text).join('\n'));
  const budget = Number.isFinite(Number(selection?.budget))
    ? Number(selection.budget)
    : config.totalBudget;
  return {
    sections,
    text: sections.map((section) => section.text).join('\n'),
    usedTokens: selectedTokens,
    budget,
    skipped: Array.isArray(selection?.skipped) ? selection.skipped : [],
    forgotten: Array.isArray(selection?.forgotten) ? selection.forgotten : [],
    ranks: selection?.ranks ?? {},
  };
}

/** Select and compile in one pure call (the shape `ProfileStore.compileRank` returns). */
export function rankAndCompile(entries, options = {}) {
  const selection = selectProfileEntries(entries, options);
  const compiled = compileProfilePrompt(selection, { config: options.config });
  return { ...selection, ...compiled };
}
