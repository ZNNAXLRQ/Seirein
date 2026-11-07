/** query — extracted from store.js; no host entry dependency. */
import { createHash } from 'node:crypto';

export const CLARITY_LEVELS = ['vivid', 'clear', 'fuzzy', 'trace'];


/** Usage bands: crossing 30% / 60% / 90% of capacity is its own one-shot decay trigger. */
const BAND_CUTOFFS = [0.3, 0.6, 0.9];


/** Water level at or below which the current pressure cycle is released (balance cleared). */
const PRESSURE_RELEASE_RATIO = 0.85;


/** Per-record correction history cap: only the most recent revisions are kept. */
export const MEMORY_REVISION_LIMIT = 10;


/** Durable policy keys in `memory_meta`; the table lives in the same database as the memories. */
const POLICY_KEYS = {
  band: 'policy.lastTriggeredBand',
  pending: 'policy.pendingPressure',
  threshold: 'policy.pressureThreshold',
  /** Pressure cycle id: advanced whenever `maintain()` releases the cycle. */
  epoch: 'policy.pressureEpoch',
  /** Proof that the retired JSON water mark was folded in (value: "<band>@<iso>"). */
  bandMigrated: 'policy.bandMigratedFrom',
  /** Who chose the threshold: `external` (config/API) or `default` (calculated 5% of capacity). */
  thresholdSource: 'policy.pressureThresholdSource',
};


/** Coerce any stored/caller-supplied band into 0..3. */
function normalizeBand(value) {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number)) return 0;
  return Math.min(BAND_CUTOFFS.length, Math.max(0, number));
}


/** The band the current usage ratio actually sits in — never a high-water mark. */
function bandForRatio(ratio) {
  let band = 0;
  for (let index = 0; index < BAND_CUTOFFS.length; index += 1) {
    if (ratio >= BAND_CUTOFFS[index]) band = index + 1;
  }
  return band;
}


/** Default sustained-pressure threshold: roughly 5% of capacity, at least one memory. */
export function defaultPressureThreshold(capacity) {
  return Math.max(1, Math.ceil(capacity * 0.05));
}


/**
 * The capacity default before 2026-11-05. A stored `policy.pressureThreshold` equal to 5% of
 * this value (`100`) and carrying no caller provenance is the old calculated default — not a
 * hand-set number — so it follows the current capacity's 5% instead of pinning the old size.
 */
const LEGACY_DEFAULT_CAPACITY = 2000;


const CJK_RE = /[\u4e00-\u9fff]/u;


/**
 * Split a query into match terms: Latin words stay whole, Chinese becomes 2-char sliding
 * windows ("语音识别" → 语音/音识/识别) so substring overlap is measurable without a tokenizer.
 */
export function tokenizeQuery(query) {
  const terms = new Set();
  for (const part of String(query ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (part.length === 0) continue;
    if (CJK_RE.test(part)) {
      for (let index = 0; index + 1 < part.length; index += 1) terms.add(part.slice(index, index + 2));
      if (part.length <= 3) terms.add(part);
    } else if (part.length >= 2) {
      terms.add(part);
    }
  }
  return [...terms];
}


/** Recency multiplier: fresh memories outrank old ones when everything else ties. */
function recencyBoost(ts) {
  const ageDays = (Date.now() - Date.parse(ts)) / 86_400_000;
  if (!Number.isFinite(ageDays)) return 0.2;
  if (ageDays <= 7) return 1;
  if (ageDays <= 30) return 0.5;
  return 0.2;
}


/**
 * Terms for candidate retrieval. The trigram index only matches 3+ characters, so Chinese
 * contributes 3-char windows; Latin words pass through whole. A natural sentence
 * ("记忆库放在哪个盘") therefore becomes several independent probes instead of one phrase
 * that would never match.
 */
export function retrievalTerms(query) {
  const terms = new Set();
  for (const part of String(query ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (part.length === 0) continue;
    if (CJK_RE.test(part)) {
      for (let index = 0; index + 3 <= part.length; index += 1) terms.add(part.slice(index, index + 3));
      if (part.length < 3) terms.add(part);
    } else if (part.length >= 3) {
      terms.add(part);
    }
  }
  return [...terms];
}


/** Escape LIKE metacharacters (`\`, `%`, `_`) so a user query matches literally. */
function escapeLike(value) {
  return String(value).replace(/[\\%_]/gu, '\\$&');
}


/**
 * Stable id for one correction operation. The same edit retried is idempotent; a different edit
 * from the same source message is a different operation and must be applied.
 *
 * `targetId` must be the RESOLVED record id (never the caller's empty string), and `version` is
 * the operation's pre-version (the version the caller fetched). A target that has moved on is a
 * different operation, so its key changes.
 */
function correctionOperationId({ source, targetId, version, expectedText, replacement }) {
  return createHash('sha256')
    .update(JSON.stringify([source.length > 0 ? source : 'none', targetId, version, expectedText, replacement]))
    .digest('hex');
}


/**
 * Pick one whitespace-free 3-character probe the trigram FTS can actually match. When `exclude`
 * contains the probe it is skipped: a probe that also exists in the other text cannot prove
 * which generation the index holds. `null` means no discriminating probe exists.
 */
function ftsProbe(value, exclude = '') {
  const text = String(value ?? '');
  const other = String(exclude ?? '');
  for (let index = 0; index + 3 <= text.length; index += 1) {
    const probe = text.slice(index, index + 3);
    if (/\s/u.test(probe)) continue;
    if (other.includes(probe)) continue;
    return probe;
  }
  return null;
}


/**
 * Apply a hard character budget to a list of rows.
 *
 * The old loop let the first row through unconditionally (`kept.length > 0` in the break
 * condition), so one very long memory could overshoot any budget by its whole length. Here a
 * row that crosses the line is cut to exactly what is left and tagged `truncated: true`, then
 * the list ends. The returned text never exceeds the budget (a zero budget returns nothing).
 *
 * @param {object[]} rows rows carrying a `text` field
 * @param {number} budgetChars maximum total character count of the kept texts
 * @param {number} [maxRows] optional row-count ceiling
 */
function trimToBudget(rows, budgetChars, maxRows = Number.POSITIVE_INFINITY) {
  const budget = Math.max(0, Math.floor(Number(budgetChars) || 0));
  const max = Math.max(0, Math.floor(Number(maxRows) || 0));
  if (budget === 0 || max === 0) return [];
  let used = 0;
  const kept = [];
  for (const row of rows) {
    if (kept.length >= max) break;
    const text = String(row.text ?? '');
    const remaining = budget - used;
    if (remaining <= 0) break;
    if (text.length <= remaining) {
      kept.push(row);
      used += text.length;
      continue;
    }
    kept.push({ ...row, text: text.slice(0, remaining), truncated: true });
    used += remaining;
    break;
  }
  return kept;
}


/**
 * Auto-memory defaults. Every real utterance (and, unless disabled, every delivered reply) is
 * recorded at message level. Importance only decides treatment (decay/restore); it never decides
 * whether a message is eligible, so the initial value is a constant 30.
 */
export const AUTO_MEMORY_DEFAULTS = Object.freeze({
  enabled: true,
  minChars: 1,
  // Recall display budget, never a storage limit: the row keeps the whole utterance.
  maxChars: 400,
  includeReply: true,
});


/** Normalize one auto-memory setting block (plugin config and/or data/settings.json). */
export function normalizeAutoMemory(input = {}) {
  const source = input !== null && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const minRaw = Number(source.minChars);
  const maxRaw = Number(source.maxChars);
  return {
    enabled: typeof source.enabled === 'boolean' ? source.enabled : AUTO_MEMORY_DEFAULTS.enabled,
    includeReply: typeof source.includeReply === 'boolean'
      ? source.includeReply
      : AUTO_MEMORY_DEFAULTS.includeReply,
    minChars: Number.isFinite(minRaw)
      ? Math.max(0, Math.floor(minRaw))
      : AUTO_MEMORY_DEFAULTS.minChars,
    maxChars: Number.isFinite(maxRaw) && maxRaw > 0
      ? Math.max(1, Math.floor(maxRaw))
      : AUTO_MEMORY_DEFAULTS.maxChars,
  };
}


/**
 * Candidate ledger (P-52). An extraction candidate is NOT a memory yet: it lives in its own
 * table and is invisible to every `memory_event` read path (search / recall / brief / get), so
 * a candidate can never be used or counted as delivered. Only a turn that actually puts it in
 * front of the model may move it to `delivered`; only then may it be written to `memory_event`
 * (`persisted`). Undelivered candidates expire after this window; delivered/persisted rows are
 * outside both this rule and the capacity/fade lifecycle of `memory_event`.
 */
export const CANDIDATE_TTL_MS = 24 * 60 * 60 * 1000;

export const CANDIDATE_STATES = Object.freeze(['candidate', 'delivered', 'persisted']);


/**
 * Recall assembly contract (2026-11-05): at most six rows and 1200 characters, labels included.
 *
 * The numbers are the shape of the injected block, not of storage. `hitShare` is the only soft
 * split: direct hits get the larger share of the characters and the context rows the rest, and
 * either side borrows what the other left unused. `labelChars` approximates one injected
 * `- [date · 原文·role] ` prefix so a block of six lines cannot silently pass the budget the
 * moment it is rendered with labels and a heading.
 */
export const MEMORY_ASSEMBLY = Object.freeze({
  maxRecords: 6,
  maxChars: 1200,
  hitShare: 2 / 3,
  contextualHitShare: 1 / 2,
  hitQuota: 4,
  contextualHitQuota: 3,
  contextQuota: 2,
  contextualContextQuota: 3,
  labelChars: 24,
});


/**
 * Stage 3 (`memory_link`) kinds. A link is an EXPLICIT relation between two records, never an
 * inferred similarity score: `turn` = the user/assistant pair of one recorded turn, `referent` =
 * the record a stage-2 pronoun was resolved from, `correction` = the target of a correction to the
 * `memory_revision` row that recorded it. Links cost no capacity, are never FTS content, and are
 * followed only ONE hop from a direct hit at recall time.
 */
export const MEMORY_LINK_KINDS = Object.freeze(['turn', 'referent', 'correction']);


/** Confidence per kind (0..1). A shared turn is certain; a resolved pronoun is strong evidence. */
export const MEMORY_LINK_CONFIDENCE = Object.freeze({
  turn: 1,
  referent: 0.8,
  correction: 1,
});


/**
 * Validate one message for storage. Storage is deliberately lossless: `maxChars` is a display
 * budget owned by recall, so a long utterance keeps its whole body here. `null` still means
 * "too short to be worth a record"; the returned text is always the complete body.
 * @param {string} text raw utterance/reply
 * @param {{minChars?: number}} [options]
 * @returns {{text: string, truncated: false}|null}
 */
export function clipMessageText(text, { minChars = AUTO_MEMORY_DEFAULTS.minChars } = {}) {
  const raw = typeof text === 'string' ? text.trim() : '';
  if (raw.length === 0) return null;
  const min = Math.max(0, Math.floor(Number(minChars) || 0));
  if (raw.length < min) return null;
  return { text: raw, truncated: false };
}


/**
 * Clip one remembered message for display/injection only. The stored row is untouched; the
 * caller receives the visible prefix plus `displayTruncated: true` when the body was longer
 * than the per-message display budget.
 * @param {string} text stored body (normally complete)
 * @param {number} [maxChars] per-message display budget
 * @returns {{text: string, displayTruncated: boolean}}
 */
export function displayMessageText(text, maxChars = AUTO_MEMORY_DEFAULTS.maxChars) {
  const raw = typeof text === 'string' ? text : String(text ?? '');
  const max = Math.max(1, Math.floor(Number(maxChars) || AUTO_MEMORY_DEFAULTS.maxChars));
  if (raw.length <= max) return { text: raw, displayTruncated: false };
  return { text: `${raw.slice(0, max - 1)}…`, displayTruncated: true };
}


/**
 * Locate the query (or, when the whole phrase is absent, its most specific token) in `raw`.
 * Only an offset is needed here, so plain string search is enough; the phrase is tried first
 * because it is the strongest signal, then the longest term because it is the least ambiguous.
 * @returns {{index: number, term: string}|null}
 */
function snippetHitIndex(raw, query, terms) {
  const haystack = raw.toLowerCase();
  const direct = String(query ?? '').trim().toLowerCase();
  if (direct.length > 0) {
    const at = haystack.indexOf(direct);
    if (at >= 0) return { index: at, term: direct };
  }
  let best = null;
  for (const term of Array.isArray(terms) ? terms : []) {
    const needle = String(term ?? '').trim().toLowerCase();
    if (needle.length === 0) continue;
    const at = haystack.indexOf(needle);
    if (at < 0) continue;
    if (
      best === null ||
      needle.length > best.term.length ||
      (needle.length === best.term.length && at < best.index)
    ) {
      best = { index: at, term: needle };
    }
  }
  return best;
}


/**
 * Clip one remembered message around the matched term instead of always at the head.
 *
 * A fixed prefix used to hide the answer whenever the query matched the tail (a 3000-char body
 * whose hit sat at char 2900 produced a 400-char prefix without it, so `found:true` came with
 * `containsEvidence:false`). The window opens 120 characters before the hit and keeps 280 after
 * it, `…` marks every truncated side, and the whole rendered string — ellipses included — stays
 * within `maxChars`. The match length is reserved first, so a hit at the tail stays whole instead
 * of being cut into `containsEvidence:true` with no full phrase in the delivered text. Only when
 * `maxChars < matchLen + 2` does the snippet exceed the budget: it then returns the exact matched
 * phrase and flags `budgetOverflow:true` rather than dropping the evidence. A query that matches
 * nothing (a pure time/role recall) keeps the old head clip. The stored body is never modified:
 * `displayStart`/`displayEnd` point into the original and describe the delivered text.
 *
 * @param {string} text stored body (normally complete)
 * @param {{query?: string, terms?: string[], maxChars?: number, before?: number, after?: number}} [options]
 * @returns {{text: string, displayStart: number, displayEnd: number, displayTruncated: boolean,
 *            containsEvidence: boolean, budgetOverflow: boolean}}
 */
export function displayMessageSnippet(text, {
  query = '',
  terms = [],
  maxChars = AUTO_MEMORY_DEFAULTS.maxChars,
  before = 120,
  after = 280,
} = {}) {
  const raw = typeof text === 'string' ? text : String(text ?? '');
  const len = raw.length;
  const max = Math.max(1, Math.floor(Number(maxChars) || AUTO_MEMORY_DEFAULTS.maxChars));
  const hit = snippetHitIndex(raw, query, terms);
  const matchLen = hit === null ? 0 : Math.max(1, hit.term.length);
  const whole = {
    text: raw,
    displayStart: 0,
    displayEnd: len,
    displayTruncated: false,
    containsEvidence: hit !== null,
    budgetOverflow: false,
  };
  if (len <= max) return whole;
  const head = (end) => {
    const cut = Math.max(0, Math.min(len, end));
    const shown = `${raw.slice(0, cut)}…`;
    return {
      text: shown,
      displayStart: 0,
      displayEnd: cut,
      displayTruncated: true,
      containsEvidence: hit !== null && shown.toLowerCase().includes(hit.term),
      budgetOverflow: false,
    };
  };
  // The match itself is never sacrificed. If the budget cannot hold the phrase plus ellipses,
  // deliver that phrase verbatim, mark the overshoot, and never claim evidence that is cut away.
  if (hit !== null && max < matchLen + 2) {
    const start = hit.index;
    const end = hit.index + matchLen;
    return {
      text: raw.slice(start, end),
      displayStart: start,
      displayEnd: end,
      displayTruncated: true,
      containsEvidence: true,
      budgetOverflow: true,
    };
  }
  if (hit === null) return head(max - 1);

  // Reserve the match length first, then split what is left between both ellipses and context,
  // so the hit is always whole even when it sits at the very tail of a long body.
  const budgetForContext = Math.max(0, max - 2 - matchLen);
  const lead = Math.max(0, Math.min(before, budgetForContext));
  const tail = Math.max(0, Math.min(after, Math.max(0, budgetForContext - lead)));
  let start = Math.max(0, hit.index - lead);
  let end = Math.min(len, hit.index + matchLen + tail);
  const room = () => max - (start > 0 ? 1 : 0) - (end < len ? 1 : 0);
  // Spend leftover budget on the side that is still cut, so a head/tail hit still fills the view.
  if (start === 0 && end < len) end = Math.min(len, start + room());
  else if (end === len && start > 0) start = Math.max(0, end - room());
  const prefix = start > 0 ? '…' : '';
  const suffix = end < len ? '…' : '';
  const shown = `${prefix}${raw.slice(start, end)}${suffix}`;
  return {
    text: shown,
    displayStart: start,
    displayEnd: end,
    displayTruncated: prefix.length > 0 || suffix.length > 0,
    // Metadata describes the text actually handed over, never the pre-clip window.
    containsEvidence: hit !== null && shown.toLowerCase().includes(hit.term),
    budgetOverflow: false,
  };
}


/** Local midnight for `now`, optionally shifted by whole days. */
function localMidnight(now, offsetDays = 0) {
  const date = new Date(now.getTime());
  date.setHours(0, 0, 0, 0);
  if (offsetDays !== 0) date.setDate(date.getDate() + offsetDays);
  return date;
}


/** A half-open `[fromIso, toIso)` window with a human label for the event payload. */
function timeWindow(from, to, label, extra = {}) {
  return { fromIso: from.toISOString(), toIso: to.toISOString(), label, ...extra };
}


/** Local midnight of the Monday that starts the ISO week containing `now`. */
export function isoWeekStart(now = new Date()) {
  const start = localMidnight(now);
  const isoDay = ((start.getDay() + 6) % 7) + 1; // Monday 1 … Sunday 7
  start.setDate(start.getDate() - (isoDay - 1));
  return start;
}


/**
 * Map "刚才 / 今天 / 昨天 / 上周 / 上次 …" onto a timestamp window. Returns null for a plain
 * keyword query. Boundaries are local time, matching how the user experiences a day. "上周" is
 * the previous natural ISO week (Monday–Sunday), not a rolling 7–14 days. "上次" keeps a wide
 * 90-day search window and is marked `relaxable`: recall widens it when nothing matched.
 * @param {string} query
 * @param {Date} [now]
 */
export function detectTimeRange(query, now = new Date()) {
  const text = typeof query === 'string' ? query : '';
  const at = (hour, offsetDays = 0) => new Date(localMidnight(now, offsetDays).getTime() + hour * 3_600_000);
  if (/(昨晚|昨天晚上)/u.test(text)) return timeWindow(at(18, -1), at(6, 0), '昨晚');
  if (/(昨天|昨日|昨儿)/u.test(text)) return timeWindow(localMidnight(now, -1), localMidnight(now, 0), '昨天');
  if (/(前天|前日)/u.test(text)) return timeWindow(localMidnight(now, -2), localMidnight(now, -1), '前天');
  if (/(刚才|刚刚|刚说|刚问|刚讲|刚提)/u.test(text)) {
    return timeWindow(new Date(now.getTime() - 60 * 60_000), now, '刚才');
  }
  if (/(今晚|今天晚上)/u.test(text)) return timeWindow(at(18, 0), now, '今晚');
  if (/(今早|今晨|早上|上午)/u.test(text)) return timeWindow(at(5, 0), at(12, 0), '上午');
  if (/(今天|今日|今儿)/u.test(text)) return timeWindow(localMidnight(now, 0), now, '今天');
  if (/(上周|上个星期|上星期)/u.test(text)) {
    const currentStart = isoWeekStart(now);
    const previousStart = new Date(currentStart.getTime());
    previousStart.setDate(previousStart.getDate() - 7);
    return timeWindow(previousStart, currentStart, '上周');
  }
  if (/(下午)/u.test(text)) return timeWindow(at(12, 0), at(18, 0), '下午');
  if (/(晚上)/u.test(text)) return timeWindow(at(18, 0), localMidnight(now, 1), '晚上');
  if (/(上次|上一次|上回|那天|前阵子)/u.test(text)) {
    return timeWindow(new Date(now.getTime() - 90 * 86_400_000), now, '上次', { relaxable: true });
  }
  if (/(最近|这几天|这两天|近期|近来)/u.test(text)) {
    return timeWindow(new Date(now.getTime() - 7 * 86_400_000), now, '最近');
  }
  return null;
}


/**
 * Which speaker a history question asks about: "我说过什么" → user only, "你说过什么" →
 * assistant only, neither → every role.
 */
export function detectRecallRoles(query) {
  const text = typeof query === 'string' ? query : '';
  const roles = [];
  if (/(我说过|我说了什么|我说啥|我的原话|我问过|我问了什么|我刚才说|我刚才问|我刚说|我刚刚说|我上次说|我讲过|我说的是)/u.test(text)) {
    roles.push('user');
  }
  if (/(你说过|你说什么|你说啥|你的原话|你的回答|你回答|你回复|你刚才说|你刚刚说|你上次说|你讲过|你说的)/u.test(text)) {
    roles.push('assistant');
  }
  return roles.length > 0 ? roles : null;
}


/** A question that asks for the surrounding exchange rather than one fact. */
const CONTEXTUAL_RECALL_RE =
  /(前后|上下文|上一句|下一句|接着|然后呢|再看看|再往前|当时|那段对话|刚才那段|刚才聊|聊了什么|说了些什么|说什么来着)/u;


/** Retrieval intent: role filter, time window, and whether context was asked for explicitly. */
export function detectRecallIntent(query, now = new Date()) {
  const text = typeof query === 'string' ? query : '';
  return {
    roles: detectRecallRoles(text),
    range: detectTimeRange(text, now),
    adjacent: /(前后|上下文|上一句|下一句|接着|然后呢|再看看|再往前|当时)/u.test(text),
    contextual: CONTEXTUAL_RECALL_RE.test(text),
  };
}


/**
 * Upcoming-convention recall window: yesterday, today and tomorrow (three calendar days). A record
 * that names one of those days is a convention the user just acted on or is about to act on.
 * This is a RANKING weight only: it never widens the candidate set, never adds a row, and never
 * touches the 6-row / 1200-character assembly budget.
 */
export const UPCOMING_WINDOW = Object.freeze({ lookbackDays: 1, aheadDays: 1 });


/** Total width of the window in calendar days: yesterday + today + tomorrow. */
export const UPCOMING_SPAN_DAYS = 3;


/**
 * Graded weight by relative day, applied to a candidate's base score. Today's convention must lead
 * its neighbourhood, yesterday's is still very likely the referent, and tomorrow is a deliberately
 * weaker "echo" — it is raised, but never above the day that just passed. Any other day is ×1.
 */
export const UPCOMING_WEIGHTS = Object.freeze({ today: 3, prev: 1.5, next: 1.2 });


/**
 * Bounded "upcoming convention" candidate entry (2026-11-06). Grading alone was not enough: asking
 * a coding question on Saturday shares no keyword with 「每周六一起看动画」, so the convention was
 * never retrieved and could not be graded. A record whose text names today / yesterday / tomorrow
 * therefore enters the candidate set even with zero keyword overlap — but strictly bounded: at
 * most two rows, at most 200 characters in total, and only what the existing six-row/1200-character
 * block has left. Direct hits are always selected first.
 */
export const UPCOMING_INJECT = Object.freeze({
  maxRows: 2,
  maxChars: 200,
  /** Hard cap on the LIKE probe, so a big store cannot turn this into a table scan. */
  scanLimit: 12,
});


/** Relative-day name of an offset, or null when the day is outside the three-day window. */
function upcomingLevel(distanceDays) {
  if (distanceDays === 0) return 'today';
  if (distanceDays === -1) return 'prev';
  if (distanceDays === 1) return 'next';
  return null;
}


const WEEKDAY_CHAR = new Map([
  ['一', 1], ['二', 2], ['三', 3], ['四', 4], ['五', 5], ['六', 6], ['日', 0], ['天', 0],
]);

const WEEKLY_RE = /每(?:周|星期|礼拜)([一二三四五六日天])/u;

const WEEKEND_RE = /每个?周(?:六|日|末)|每逢周末/u;

const MONTHLY_RE = /每个?月\s*(\d{1,2})\s*[号日]/u;


/** Local calendar day as a day number, so day arithmetic never drifts across a DST change. */
function localDayNumber(date) {
  return Math.trunc(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000);
}


/**
 * Does `text` name a convention that falls inside the three-day window around `now`?
 *
 * Two shapes are recognised, both written by the normalizer when it turns relative speech into an
 * absolute one:
 *   - an absolute `YYYY-MM-DD` inside `[now - lookbackDays, now + aheadDays]` (yesterday..tomorrow);
 *   - a weekly ("每周六", "每个周末") or monthly ("每月5号") repeat whose next occurrence is today
 *     or tomorrow. A repeat names its next occurrence, so it can only ever be "today" or "next".
 * The result is a ranking weight (`level` + `weight`), not a filter: a record with no date, a date
 * three days out, or a weekday that is not imminent yields `matched: false, weight: 1`.
 *
 * @param {string} text stored record body
 * @param {Date} [now] the moment recall runs against
 * @returns {{matched: boolean, kinds: string[], distanceDays: number|null,
 *            level: 'today'|'prev'|'next'|null, weight: number}}
 */
export function upcomingConvention(text, now = new Date()) {
  const value = typeof text === 'string' ? text : '';
  const none = { matched: false, kinds: [], distanceDays: null, level: null, weight: 1 };
  if (value.length === 0 || !(now instanceof Date) || Number.isNaN(now.getTime())) return none;
  const today = localDayNumber(now);
  const todayWeekday = now.getDay();
  const todayMonthDay = now.getDate();
  const hits = [];

  for (const match of value.matchAll(/(\d{4})-(\d{2})-(\d{2})/gu)) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const stamp = Date.UTC(year, month - 1, day);
    const date = new Date(stamp);
    // Reject 2026-02-31 and friends: Date.UTC would silently roll them into March.
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) continue;
    const offset = Math.round(stamp / 86_400_000) - today;
    if (offset >= -UPCOMING_WINDOW.lookbackDays && offset <= UPCOMING_WINDOW.aheadDays) {
      hits.push({ kind: 'date', distanceDays: offset });
    }
  }

  const weekly = value.match(WEEKLY_RE);
  const weekdays = weekly !== null
    ? [WEEKDAY_CHAR.get(weekly[1])].filter((day) => day !== undefined)
    : WEEKEND_RE.test(value) ? [6, 0] : [];
  for (const weekday of weekdays) {
    const distanceDays = (weekday - todayWeekday + 7) % 7;
    // The next occurrence is forward-only, so a repeat is "today" or "next" within the window.
    if (distanceDays <= UPCOMING_WINDOW.aheadDays) hits.push({ kind: 'weekly', distanceDays });
  }

  const monthly = value.match(MONTHLY_RE);
  if (monthly !== null) {
    const monthDay = Number(monthly[1]);
    if (monthDay >= 1 && monthDay <= 31) {
      const distanceDays = monthDay - todayMonthDay;
      if (distanceDays >= 0 && distanceDays <= UPCOMING_WINDOW.aheadDays) hits.push({ kind: 'monthly', distanceDays });
    }
  }

  if (hits.length === 0) return none;
  // The strongest level wins (today > prev > next), then the closest day.
  const ranked = [];
  for (const hit of hits) {
    const level = upcomingLevel(hit.distanceDays);
    if (level === null) continue;
    ranked.push({ ...hit, level, weight: UPCOMING_WEIGHTS[level] });
  }
  if (ranked.length === 0) return none;
  ranked.sort((left, right) => right.weight - left.weight || Math.abs(left.distanceDays) - Math.abs(right.distanceDays));
  const best = ranked[0];
  return {
    matched: true,
    kinds: [...new Set(hits.map((hit) => hit.kind))],
    distanceDays: best.distanceDays,
    level: best.level,
    weight: best.weight,
  };
}


/**
 * One injection line. Original utterances/replies stay visibly separate from a distilled
 * manual memory, so the model can tell "what was actually said" from "what we concluded".
 */
export function formatRecalledLine(row) {
  const role = row?.role === 'user' ? 'user' : row?.role === 'assistant' ? 'assistant' : '';
  const label = role.length > 0 ? `原文·${role}` : '提炼';
  const mark = row?.clarity === undefined || row.clarity === 'vivid' || row.clarity === 'clear'
    ? ''
    : '（记忆模糊）';
  return `- [${label}] ${String(row?.text ?? '').trim()}${mark}`;
}


/**
 * Prefix carried by the body of a recall row whose referent dependency was retired. The wording
 * is still the stored text (no mass rename), but it must not read as a confirmed fact: the marker
 * rides in `text`, so the C2 injection block, `brief()`/voice lines and the recall tool all show
 * it without a second renderer.
 */
export const UNRESOLVED_MARK = '[待核验]';


/** Heuristic importance — deterministic, no model call, easy to explain and to test. */
export function scoreImportance(text, kind = 'fact') {
  const value = typeof text === 'string' ? text : '';
  let score = 8;

  if (kind === 'preference') score += 20;
  else if (kind === 'decision') score += 16;
  else if (kind === 'habit') score += 12;
  else if (kind === 'event') score += 8;

  if (/(答应|约定|说好|以后|下次|记得|不要忘|发誓)/u.test(value)) score += 16;
  if (/(第一次|初次|头一次|最早|刚认识|纪念日)/u.test(value)) score += 30;
  if (/(吵架|生气|道歉|对不起|和好|误会|冷战)/u.test(value)) score += 14;
  if (/(我喜欢|我是|我的)/u.test(value)) score += 5;

  const strong = value.match(/(喜欢|想念|难过|委屈|哭|抱抱|谢谢|陪我|永远)/gu);
  const mild = value.match(/(开心|高兴|讨厌|累|烦|期待)/gu);
  score += Math.min(24, (strong?.length ?? 0) * 8 + (mild?.length ?? 0) * 3);

  if (value.replace(/\s/gu, '').length < 6) score -= 12;
  return Math.min(100, Math.max(1, score));
}

export {
  BAND_CUTOFFS,
  PRESSURE_RELEASE_RATIO,
  POLICY_KEYS,
  normalizeBand,
  bandForRatio,
  LEGACY_DEFAULT_CAPACITY,
  CJK_RE,
  recencyBoost,
  escapeLike,
  correctionOperationId,
  ftsProbe,
  trimToBudget,
  snippetHitIndex,
  localMidnight,
  timeWindow,
  CONTEXTUAL_RECALL_RE,
  upcomingLevel,
  WEEKDAY_CHAR,
  WEEKLY_RE,
  WEEKEND_RE,
  MONTHLY_RE,
  localDayNumber,
};
