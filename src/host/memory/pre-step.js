/** pre-step — extracted from index.js; no host entry dependency. */
import { AUTO_MEMORY_DEFAULTS } from './store.js';
import { C2_DEFAULT_FUZZY_DAYS } from '../shared/time.js';
import { C2_DEFAULT_TIME_ZONE } from '../shared/time.js';
import { MEMORY_INJECTION_DEFAULTS } from './memory-injection.js';
import { candidatePersistsLongTerm } from './memory-injection.js';
import { composeInjectionBlock } from './memory-injection.js';
import { composeLayeredInjectionBlock } from './memory-injection.js';
import { composeMemoryStatus } from './memory-injection.js';
import { composeMemoryLexiconRefs } from './lexicon-links.js';
import { detectArchiveRange } from '../shared/time.js';
import { displayMessageText } from './store.js';
import { injectionRowRank } from './memory-injection.js';
import { isAssistantMemoryMessage } from '../shared/text.js';
import { memoryInjectionMessage } from '../shared/text.js';
import { memoryQueryText } from '../shared/text.js';
import { recallLexiconCandidates } from '../speech/lexicon-recall.js';
import { MEMORY_ITEM_CANDIDATE_EVENT, MEMORY_ITEM_DELIVERED_EVENT, composeMemoryItemMarkers } from './markers.js';
import { resolveC2TimeZone } from '../shared/time.js';
import { tokenizeQuery } from './store.js';
import { buildContextBudgetPayload } from './context-layers.js';
import { resolveContextBudget } from './context-layers.js';
import { PRE_STEP_TIMEOUT } from '../speech/typed-reply.js';

/**
 * Run one bounded slice against the shared deadline. SQLite is synchronous, so a slice cannot be
 * preempted mid-statement; slices are kept small (SQL LIMIT) and the timer abandons async work.
 * A slice that returns after the deadline is treated exactly like an abandoned one: its result is
 * late, and a late result must never modify this request.
 */
async function runSlicedTask(task, { deadline, now }) {
  const remaining = deadline - now();
  if (remaining <= 0) return { status: 'timeout' };
  let timer = null;
  let settled = false;
  const work = Promise.resolve().then(task);
  const timed = new Promise((resolveTimed) => {
    timer = setTimeout(() => resolveTimed(PRE_STEP_TIMEOUT), remaining);
    timer.unref?.();
    // Windows timers coalesce to ~15.6 ms, which is too coarse for a short budget. Below one
    // timer tick, an immediate heartbeat enforces the deadline at ~1 ms resolution instead.
    if (remaining <= 60) {
      const poll = () => {
        if (settled) return;
        if (now() >= deadline) resolveTimed(PRE_STEP_TIMEOUT);
        else setImmediate(poll);
      };
      setImmediate(poll);
    }
  });
  let outcome;
  try {
    outcome = await Promise.race([
      work.then((value) => ({ status: 'ok', value }), (error) => ({ status: 'error', error })),
      timed,
    ]);
  } finally {
    settled = true;
    if (timer !== null) clearTimeout(timer);
  }
  if (outcome === PRE_STEP_TIMEOUT) {
    work.catch(() => {}); // the late result is dropped, never surfaced as an unhandled rejection
    return { status: 'timeout' };
  }
  if (now() > deadline) return { status: 'timeout' };
  return outcome;
}


/**
 * Archive lookup, paginated so it can stop at the deadline instead of formatting 200 rows at once.
 * Only the remaining budget is spent: the deadline is shared with the active lookup. Candidates
 * are selected by the resolved TIME WINDOW first; the question's wording is only a ranking hint
 * afterwards, so an archived original never has to contain the question sentence.
 * @returns {Promise<{status: 'ok'|'timeout', rows: object[]}>}
 */
async function readArchiveCandidates({ memory, fromIso, toIso, deadline, now, limits, isAborted }) {
  if (typeof memory?.listArchive !== 'function') return { status: 'ok', rows: [], truncated: false };
  const limitTotal = Math.max(0, Math.floor(Number(limits.archiveCandidates) || 0));
  const pageSize = Math.max(1, Math.floor(Number(limits.archivePage) || 1));
  const rows = [];
  let offset = 0;
  while (rows.length < limitTotal) {
    if (isAborted()) return { status: 'timeout', rows, truncated: true };
    const want = Math.min(pageSize, limitTotal - rows.length);
    const page = await runSlicedTask(
      () => memory.listArchive({ fromIso, toIso, limit: want, offset }),
      { deadline, now },
    );
    if (page.status === 'timeout') return { status: 'timeout', rows, truncated: true };
    if (page.status !== 'ok') return { status: 'ok', rows, truncated: rows.length >= limitTotal };
    const pageRows = Array.isArray(page.value) ? page.value : [];
    rows.push(...pageRows);
    if (pageRows.length < want) break;
    offset += pageRows.length;
    // Yield a full macrotask between pages so the deadline timer can actually fire.
    await new Promise((resolveYield) => setImmediate(resolveYield));
  }
  return { status: 'ok', rows, truncated: rows.length >= limitTotal && limitTotal > 0 };
}


/** Rank archive candidates: term overlap first, then importance, then recency. */
function rankArchiveRows(rows, query, limit) {
  const terms = tokenizeQuery(query);
  const scored = rows.map((row) => {
    const body = String(row?.text ?? '').toLowerCase();
    let matched = 0;
    for (const term of terms) {
      if (term.length > 0 && body.includes(term)) matched += 1;
    }
    return { row, matched };
  });
  scored.sort((left, right) => {
    if (right.matched !== left.matched) return right.matched - left.matched;
    const leftImportance = Number(left.row?.importance) || 0;
    const rightImportance = Number(right.row?.importance) || 0;
    if (rightImportance !== leftImportance) return rightImportance - leftImportance;
    return (Date.parse(right.row?.ts) || 0) - (Date.parse(left.row?.ts) || 0);
  });
  return scored.slice(0, Math.max(0, limit)).map((item) => item.row);
}


/**
 * Per-turn memory ledger shared by C2 and the memory tools.
 *
 * Three jobs, one key space `(sessionId, turn)`:
 *  - query reuse: a tool asking the same `(query, range, limit, domain)` that C2 just ran gets the
 *    C2 result back instead of hitting the database again;
 *  - reinforcement accounting: `(sessionId, turn, memoryId)` is strengthened at most once, no
 *    matter how many lanes delivered it;
 *  - correction invalidation: a correction during the turn drops every cached query of that turn
 *    (an empty result has no version to compare), so the next read re-queries and shows the new
 *    body; the `strengthened` ledger survives, so nothing is reinforced twice.
 */
export function createMemoryTurnLedger() {
  const turns = new Map();
  const latest = new Map();
  const stateFor = (sessionId, turn) => {
    const sid = typeof sessionId === 'string' ? sessionId : '';
    const tid = Number.isInteger(turn) && turn >= 0 ? turn : 0;
    const key = `${sid}\u0000${tid}`;
    let state = turns.get(key);
    if (state === undefined) {
      state = { queries: new Map(), strengthened: new Set(), corrected: new Map() };
      turns.set(key, state);
    }
    latest.set(sid, tid);
    return state;
  };
  const queryKey = ({ sessionId, turn, kind = 'recall', query = '', fromIso = null, toIso = null, limit = 0, domains = null }) => JSON.stringify([
    kind,
    String(query),
    fromIso ?? null,
    toIso ?? null,
    Number(limit) || 0,
    Array.isArray(domains) ? domains.map(String).sort() : null,
  ]);
  const scopeOf = ({ sessionId, turn }) => stateFor(sessionId, turn);
  return {
    /** Key used by `memory.query.reused`; the same shape as the internal lookup key. */
    key: queryKey,
    latestTurn(sessionId) {
      return latest.has(sessionId) ? latest.get(sessionId) : null;
    },
    /** Store one result C2 already paid for. Only C2 writes; tools only read. */
    remember({
      sessionId, turn, kind = 'recall', query, fromIso = null, toIso = null, limit = 0,
      domains = null, value, versions = {},
    }) {
      const state = scopeOf({ sessionId, turn });
      const key = queryKey({ kind, query, fromIso, toIso, limit, domains });
      state.queries.set(key, {
        kind,
        query: String(query),
        fromIso,
        toIso,
        limit: Number(limit) || 0,
        domains: Array.isArray(domains) ? domains.map(String).sort() : null,
        value,
        versions: { ...versions },
      });
      latest.set(sessionId, Number.isInteger(turn) ? turn : 0);
    },
    /** Same query (or a smaller page of it) from this turn, or null to force a real lookup. */
    lookup({ sessionId, turn, kind = 'recall', query = '', fromIso = null, toIso = null, limit = 0, domains = null }) {
      const state = scopeOf({ sessionId, turn });
      const wanted = queryKey({ kind, query, fromIso, toIso, limit, domains });
      const normalizedDomains = Array.isArray(domains) ? domains.map(String).sort() : null;
      const fresh = (entry) => {
        for (const [id, version] of state.corrected) {
          if (Object.hasOwn(entry.versions, id) && Number(entry.versions[id]) < Number(version)) return false;
        }
        return true;
      };
      const exact = state.queries.get(wanted);
      if (exact !== undefined && fresh(exact)) return exact.value;
      // A smaller page of the same lookup is still the same query; a deeper page is not.
      const wantedLimit = Number(limit) || 0;
      for (const entry of state.queries.values()) {
        if (entry.kind !== kind) continue;
        if (entry.query !== String(query)) continue;
        if ((entry.fromIso ?? null) !== (fromIso ?? null)) continue;
        if ((entry.toIso ?? null) !== (toIso ?? null)) continue;
        const entryDomains = entry.domains ?? null;
        if (JSON.stringify(entryDomains) !== JSON.stringify(normalizedDomains)) continue;
        if (entry.limit >= wantedLimit && fresh(entry)) return entry.value;
      }
      return null;
    },
    /** Drop every cached query for one turn; the once-per-turn `strengthened` ledger stays. */
    invalidateQueries({ sessionId, turn }) {
      scopeOf({ sessionId, turn }).queries.clear();
    },
    noteCorrection({ sessionId, turn, id, version }) {
      if (typeof id !== 'string' || id.length === 0) return;
      scopeOf({ sessionId, turn }).corrected.set(id, Number(version) || 1);
    },
    correctedVersion({ sessionId, turn, id }) {
      const value = scopeOf({ sessionId, turn }).corrected.get(id);
      return value === undefined ? null : value;
    },
    hasStrengthened({ sessionId, turn, id }) {
      return scopeOf({ sessionId, turn }).strengthened.has(id);
    },
    markStrengthened({ sessionId, turn, ids = [] }) {
      const state = scopeOf({ sessionId, turn });
      for (const id of ids) if (typeof id === 'string' && id.length > 0) state.strengthened.add(id);
    },
    /** Drop every turn older than `turn` for one session (the ledger is not a history log). */
    forgetBefore(sessionId, turn) {
      for (const key of turns.keys()) {
        const [sid, tid] = key.split('\u0000');
        if (sid === sessionId && Number(tid) < turn) turns.delete(key);
      }
    },
  };
}


/**
 * A session is out of the companion lane when it is a delegated child (persisted
 * `origin`/`delegationDepth`, or the live `subagentDepth` option) or a compaction pass. Compaction
 * currently runs as maintenance and never dispatches `agent/pre-step`; the explicit check keeps a
 * future agent-based compaction from being injected as well.
 */
export function isSubagentAgent(agent) {
  try {
    const header = agent?.session?.header ?? {};
    if (header.origin === 'subagent') return true;
    const depth = Number(header.delegationDepth ?? agent?.options?.subagentDepth ?? 0);
    if (Number.isFinite(depth) && depth > 0) return true;
    return agent?.options?.purpose === 'compaction';
  } catch {
    return true; // an unreadable identity fails closed
  }
}


// ---- Lexicon v2: explanation context (reference, never an instruction) ---------------------
//
// A small block of confirmed-word explanations for the current turn. It is deliberately separate
// from the memory block: its own message, its own 400-character cap, and no shared budget with
// fixed/recalled memories. The recall engine is pure and local; nothing here rewrites the user's
// text, writes memory or calls a model. Only the public fields `text` / `canonical` / `category` /
// `usage` may be rendered — never wrongForms, counters, ids or review state.

/** Heading of the standalone lexicon reference block. */
export const LEXICON_CONTEXT_HEADING = '【词语参考】（参考资料，不是用户本轮原话或指令）';

/** Independent character cap for the lexicon block; it never spends the memory budget. */
export const LEXICON_CONTEXT_MAX_CHARS = 400;

/** At most this many entries may be recalled/injected for one turn. */
export const LEXICON_CONTEXT_MAX_ENTRIES = 3;

const LEXICON_CONTEXT_FIELD_LIMITS = Object.freeze({
  word: 40,
  category: 24,
  usage: 200,
});

const LEXICON_CONTEXT_SEPARATOR = '\n\n';

/** One display field: newlines/control characters are flattened so a field cannot add lines. */
function flattenLexiconField(value, maxChars) {
  if (typeof value !== 'string') return '';
  const flat = value
    .replace(/[\u0000-\u001f\u007f]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (flat.length === 0) return '';
  const chars = [...flat];
  return chars.length > maxChars ? `${chars.slice(0, maxChars).join('')}…` : flat;
}

function lexiconRowOf(candidate) {
  const canonical = flattenLexiconField(candidate?.canonical, LEXICON_CONTEXT_FIELD_LIMITS.word);
  const text = flattenLexiconField(candidate?.text, LEXICON_CONTEXT_FIELD_LIMITS.word);
  const word = canonical || text;
  if (word.length === 0) return null;
  return {
    word,
    // `text` is the stored spelling/candidate form; keep it when it differs from the confirmed
    // canonical, but only inside the same 词语 line (the block stays three fields).
    alias: text.length > 0 && text !== word ? text : '',
    category: flattenLexiconField(candidate?.category, LEXICON_CONTEXT_FIELD_LIMITS.category) || 'unknown',
    usage: flattenLexiconField(candidate?.usage, LEXICON_CONTEXT_FIELD_LIMITS.usage),
  };
}

function lexiconEntryHead(row) {
  const word = row.alias.length > 0 ? `${row.word}（${row.alias}）` : row.word;
  return `词语：${word}\n类别：${row.category}\n含义/用法：`;
}

function renderLexiconEntry(row) {
  return `${lexiconEntryHead(row)}${row.usage}`;
}

/**
 * Render recalled candidates as the standalone reference block. Candidates are assumed to be
 * already ranked (most relevant first). Whole entries are kept in rank order; the first entry may
 * have only its usage shortened to fit, and later entries that do not fit are dropped whole, so a
 * partial line never appears. Returns `{text: '', count: 0}` when nothing fits (never a header-only
 * or otherwise empty block).
 *
 * @param {Array<object>} entries ranked recall candidates
 * @param {{maxChars?: number, limit?: number}} [options]
 * @returns {{text: string, count: number}}
 */
export function composeLexiconContext(entries, { maxChars = LEXICON_CONTEXT_MAX_CHARS, limit = LEXICON_CONTEXT_MAX_ENTRIES } = {}) {
  const numericBudget = Number(maxChars);
  const budget = Number.isFinite(numericBudget)
    ? Math.max(0, Math.floor(numericBudget))
    : LEXICON_CONTEXT_MAX_CHARS;
  const numericLimit = Number(limit);
  const wanted = Number.isFinite(numericLimit)
    ? Math.max(0, Math.min(LEXICON_CONTEXT_MAX_ENTRIES, Math.floor(numericLimit)))
    : LEXICON_CONTEXT_MAX_ENTRIES;
  if (budget <= 0 || wanted === 0 || !Array.isArray(entries)) return {text: '', count: 0};

  const rows = [];
  const seen = new Set();
  for (const candidate of entries) {
    if (rows.length >= wanted) break;
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const row = lexiconRowOf(candidate);
    if (row === null) continue;
    // The same word is injected at most once per turn; identity is never rendered.
    const key = row.word.normalize('NFKC').toLowerCase().replace(/\s+/gu, '');
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(row);
  }
  if (rows.length === 0) return {text: '', count: 0};

  let text = LEXICON_CONTEXT_HEADING;
  let count = 0;
  for (const row of rows) {
    const separator = count === 0 ? '\n' : LEXICON_CONTEXT_SEPARATOR;
    const room = budget - text.length - separator.length;
    if (room <= 0) break;
    const full = renderLexiconEntry(row);
    if (full.length <= room) {
      text += separator + full;
      count += 1;
      continue;
    }
    if (count === 0) {
      // Keep the most relevant word even when its usage alone would overflow: shorten only the
      // usage, still rendering all three fields, and stop there (the budget is then spent).
      const head = lexiconEntryHead(row);
      const usageRoom = room - head.length;
      if (usageRoom >= 0) {
        const chars = [...row.usage];
        const keep = Math.max(0, usageRoom - 1);
        const usage = keep < chars.length ? `${chars.slice(0, keep).join('')}…` : row.usage;
        text += separator + head + usage;
        count = 1;
      }
    }
    break;
  }
  return count > 0 ? {text, count} : {text: '', count: 0};
}

/**
 * Recall at most `limit` CONFIRMED entries for one turn's text and render them as the standalone
 * lexicon block. Non-confirmed entries are ignored even when a caller passes the whole store.
 * Pure and local: no I/O, no model call, no memory mutation.
 *
 * @param {{entries?: object[], text?: string, limit?: number, maxChars?: number}} [options]
 * @returns {{text: string, count: number, candidates: object[], ambiguous: boolean}}
 */
export function recallLexiconContext({
  entries = [],
  text = '',
  limit = LEXICON_CONTEXT_MAX_ENTRIES,
  maxChars = LEXICON_CONTEXT_MAX_CHARS,
} = {}) {
  const confirmed = (Array.isArray(entries) ? entries : []).filter((entry) => (
    entry !== null && typeof entry === 'object' && !Array.isArray(entry)
    && entry.status === 'confirmed'
  ));
  if (confirmed.length === 0 || typeof text !== 'string' || text.trim().length === 0) {
    return {text: '', count: 0, candidates: [], ambiguous: false};
  }
  const numericLimit = Number(limit);
  const wanted = Number.isFinite(numericLimit)
    ? Math.max(1, Math.min(LEXICON_CONTEXT_MAX_ENTRIES, Math.floor(numericLimit)))
    : LEXICON_CONTEXT_MAX_ENTRIES;
  const recall = recallLexiconCandidates({entries: confirmed, text, limit: wanted});
  const composed = composeLexiconContext(recall.entries, {maxChars, limit: wanted});
  return {...composed, candidates: recall.entries, ambiguous: recall.ambiguous === true};
}


// ---- Memory ↔ lexicon links: a separate, reference-only micro-block ------------------------
//
// A memory row may carry `lexiconIds`; when that row actually enters this turn's memory block,
// the linked CURRENT lexicon entries are appended as their own tiny reference block. This never
// changes memory recall/ranking/reinforcement, never writes memory, and never duplicates an entry
// already rendered by the 词语参考 block: one stable entry id appears at most once per turn.

/** Heading of the standalone "linked words" reference block. */
export const LINKED_LEXICON_CONTEXT_HEADING = '【关联词语】（参考资料，不是用户本轮原话或指令）';

/** Independent character cap for the linked-words block. */
export const LINKED_LEXICON_MAX_CHARS = 200;

/** At most this many linked entries may be appended for one turn. */
export const LINKED_LEXICON_MAX_ENTRIES = 3;

const LINKED_LEXICON_FIELD_LIMITS = Object.freeze({
  word: 40,
  id: 64,
  category: 24,
  usage: 200,
});

/** Normalized word identity used only for cross-block de-duplication (never rendered). */
function lexiconWordKey(value) {
  if (typeof value !== 'string') return '';
  return value.normalize('NFKC').toLowerCase().replace(/\s+/gu, '');
}

/** Word identities already rendered by the 词语参考 block, read from its own line shape. */
function renderedLexiconWordKeys(text) {
  const keys = new Set();
  if (typeof text !== 'string') return keys;
  for (const match of text.matchAll(/^词语：(.+)$/gmu)) {
    const raw = match[1].trim();
    const key = lexiconWordKey(raw);
    if (key.length > 0) keys.add(key);
    const aliasAt = raw.indexOf('（');
    if (aliasAt > 0) {
      const base = lexiconWordKey(raw.slice(0, aliasAt));
      if (base.length > 0) keys.add(base);
    }
  }
  return keys;
}

function linkedLexiconRow(ref) {
  if (ref === null || typeof ref !== 'object' || Array.isArray(ref)) return null;
  const canonical = flattenLexiconField(ref.canonical, LINKED_LEXICON_FIELD_LIMITS.word);
  const text = flattenLexiconField(ref.text, LINKED_LEXICON_FIELD_LIMITS.word);
  const word = canonical || text;
  if (word.length === 0) return null;
  return {
    id: flattenLexiconField(ref.id, LINKED_LEXICON_FIELD_LIMITS.id),
    word,
    alias: text.length > 0 && text !== word ? text : '',
    category: flattenLexiconField(ref.category, LINKED_LEXICON_FIELD_LIMITS.category) || 'unknown',
    usage: flattenLexiconField(ref.usage, LINKED_LEXICON_FIELD_LIMITS.usage),
  };
}

function linkedLexiconEntryHead(row) {
  const word = row.alias.length > 0 ? `${row.word}（${row.alias}）` : row.word;
  const lines = [`词语：${word}`];
  if (row.id.length > 0) lines.push(`编号：${row.id}`);
  lines.push(`类别：${row.category}`, '含义/用法：');
  return lines.join('\n');
}

function renderLinkedLexiconEntry(row) {
  return `${linkedLexiconEntryHead(row)}${row.usage}`;
}

/**
 * Render the linked entries as a standalone reference micro-block.
 *
 * Entries already rendered by `renderedText` (the 词语参考 block) are skipped, later duplicates
 * collapse, and at most `limit`/`maxChars` are kept. A whole entry is never split across the
 * budget: an entry that does not fit is skipped (later shorter entries may still fit), and a
 * block that fits nothing stays empty instead of emitting a header-only fragment.
 * Pure: no I/O, no memory write, no model call, never mutates the input refs.
 *
 * @param {unknown} refs safe entry views from `composeMemoryLexiconRefs`
 * @param {{renderedText?: string, maxChars?: number, limit?: number}} [options]
 * @returns {{text: string, count: number}}
 */
export function composeLinkedLexiconContext(refs, {
  renderedText = '',
  maxChars = LINKED_LEXICON_MAX_CHARS,
  limit = LINKED_LEXICON_MAX_ENTRIES,
} = {}) {
  const numericBudget = Number(maxChars);
  const budget = Number.isFinite(numericBudget)
    ? Math.max(0, Math.floor(numericBudget))
    : LINKED_LEXICON_MAX_CHARS;
  const numericLimit = Number(limit);
  const wanted = Number.isFinite(numericLimit)
    ? Math.max(0, Math.min(LINKED_LEXICON_MAX_ENTRIES, Math.floor(numericLimit)))
    : LINKED_LEXICON_MAX_ENTRIES;
  if (budget <= 0 || wanted === 0 || !Array.isArray(refs)) return {text: '', count: 0};

  const excluded = renderedLexiconWordKeys(renderedText);
  const rows = [];
  const seen = new Set();
  for (const ref of refs) {
    const row = linkedLexiconRow(ref);
    if (row === null) continue;
    const keys = [lexiconWordKey(row.word), lexiconWordKey(row.alias)].filter((key) => key.length > 0);
    if (keys.some((key) => excluded.has(key))) continue;
    const identity = row.id.length > 0 ? `id:${row.id}` : `word:${lexiconWordKey(row.word)}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    rows.push(row);
  }
  if (rows.length === 0) return {text: '', count: 0};

  let text = LINKED_LEXICON_CONTEXT_HEADING;
  let count = 0;
  for (const row of rows) {
    if (count >= wanted) break;
    const separator = count === 0 ? '\n' : '\n\n';
    const room = budget - text.length - separator.length;
    if (room <= 0) break;
    const full = renderLinkedLexiconEntry(row);
    // Whole entries only: a word whose key fields/usage do not fit is skipped, never truncated,
    // so the model never receives a partial definition or a cut-off condition. A later shorter
    // entry may still fit inside the same 200-char budget.
    if (full.length > room) continue;
    text += separator + full;
    count += 1;
  }
  return count > 0 ? {text, count} : {text: '', count: 0};
}


/**
 * One whole preparation under a single time budget: fixed layer → active recall → (only for a
 * time-range question with no active hit) one paginated archive pass. Sources that did not finish
 * are reported, never silently treated as "no memories".
 *
 * @param {{memory: object, log?: object, sessionId?: string, turn?: number, query?: string,
 *          inScope?: boolean, enabled?: boolean, subagent?: boolean, budgetMs?: number,
 *          now?: () => number, isAborted?: () => boolean, limits?: object,
 *          displayChars?: number, timeZone?: string, fuzzyDays?: number,
 *          layerBudgets?: {fixed?: number, memory?: number, totalChars?: number}|null}} options
 */
export async function prepareMemoryInjection({
  memory,
  log = null,
  sessionId = '',
  turn = 0,
  query = '',
  inScope = true,
  enabled = true,
  subagent = false,
  budgetMs = MEMORY_INJECTION_DEFAULTS.prepareBudgetMs,
  now = () => Date.now(),
  isAborted = () => false,
  limits = MEMORY_INJECTION_DEFAULTS,
  displayChars = AUTO_MEMORY_DEFAULTS.maxChars,
  timeZone = C2_DEFAULT_TIME_ZONE,
  fuzzyDays = C2_DEFAULT_FUZZY_DAYS,
  ledger = null,
  onRecall = null,
  layerBudgets = null,
  lexiconEntries = null,
} = {}) {
  const caps = {
    ...MEMORY_INJECTION_DEFAULTS,
    ...(limits !== null && typeof limits === 'object' ? limits : {}),
  };
  const sources = { active: 'ok', archive: 'not-run' };
  const skipped = (reason) => ({
    text: '', injected: false, reason, sources, archiveReason: null,
    hits: 0, injectedChars: 0, requestedChars: 0, injectedIds: [], matchedIds: [], persistIds: [],
    contextLayers: null,
  });
  const text = typeof query === 'string' ? query.trim() : '';
  if (enabled !== true) return skipped('disabled');
  if (inScope !== true) return skipped('out-of-scope');
  if (subagent === true) return skipped('subagent');
  if (text.length === 0) return skipped('empty-query');
  if (isAborted()) return skipped('aborted');
  if (memory === null || typeof memory !== 'object') return skipped('no-memory');

  const budget = Math.max(0, Number(budgetMs) || 0);
  const deadline = now() + budget;
  const chars = Number(displayChars) > 0 ? Math.floor(Number(displayChars)) : AUTO_MEMORY_DEFAULTS.maxChars;
  const tz = resolveC2TimeZone(timeZone);

  // Fixed layer first: it is bounded and its records win the shared budget below.
  let fixed = [];
  const fixedSlice = await runSlicedTask(
    () => (typeof memory.fixedMemories === 'function'
      ? memory.fixedMemories({ budgetChars: caps.maxChars, limit: caps.maxRecords })
      : []),
    { deadline, now },
  );
  if (fixedSlice.status === 'timeout') sources.active = 'timeout';
  else if (fixedSlice.status === 'ok' && Array.isArray(fixedSlice.value)) fixed = fixedSlice.value;

  let recallMeta = {};
  let matched = [];
  if (sources.active === 'ok' && !isAborted()) {
    const activeSlice = await runSlicedTask(
      () => (typeof memory.recall === 'function'
        ? memory.recall({
          query: text,
          limit: Math.max(1, Number(caps.maxRecords) + 2),
          budgetChars: caps.maxChars,
          maxRecords: caps.maxRecords,
          window: 1,
          now: new Date(now()),
          displayChars: chars,
        })
        : { hits: [], mode: 'keyword' }),
      { deadline, now },
    );
    if (activeSlice.status === 'timeout') sources.active = 'timeout';
    else if (activeSlice.status === 'ok' && activeSlice.value !== null && typeof activeSlice.value === 'object') {
      recallMeta = activeSlice.value;
      const fixedIds = new Set(fixed.map((row) => row?.id).filter((id) => typeof id === 'string'));
      // The store returns `hit①, its context, hit②, …`; the injection budget must not be spent
      // in that order or hit①'s context can push hit② out. Direct hits are selected and paid for
      // first, then pairs, then neighbours (the row cap also applies after this reordering).
      matched = (Array.isArray(recallMeta.hits) ? recallMeta.hits : [])
        .map((row, index) => ({ row, index }))
        .filter(({ row }) => row !== null && typeof row === 'object'
          && row.skippedByBudget !== true
          && String(row.text ?? '').trim().length > 0
          && !fixedIds.has(row.id))
        .sort((left, right) => injectionRowRank(left.row) - injectionRowRank(right.row) || left.index - right.index)
        .map((entry) => entry.row)
        .slice(0, Number(caps.maxRecords) || 0);
    }
  }

  // Archive is a fallback, not a second parallel pass: only a past-time question with no active
  // hit spends the remaining budget on it. The window is resolved first; the question wording is
  // never required to appear in the archived original.
  const range = detectArchiveRange(text, { now, timeZone: tz, fuzzyDays });
  let archiveReason = range === null ? 'no-range' : null;
  let archiveRows = [];
  let archiveTruncated = false;
  if (range !== null && matched.length === 0 && sources.active === 'ok' && !isAborted()) {
    const archive = await readArchiveCandidates({
      memory, fromIso: range.fromIso, toIso: range.toIso, deadline, now, limits: caps, isAborted,
    });
    sources.archive = archive.status;
    archiveRows = archive.rows;
    archiveTruncated = archive.truncated === true;
    archiveReason = 'queried';
  } else if (range !== null && archiveReason === null) {
    archiveReason = matched.length > 0 ? 'active-hit' : `active-${sources.active}`;
  }
  // Cancelled while the lookup was still running: nothing may reach the request or memory.
  if (isAborted()) return skipped('aborted');

  // E: a record corrected during this turn must never be served from an older cached copy; if
  // the store can hand back the current revision, use it and flag the line as updated.
  const annotateCorrected = (row) => {
    if (ledger === null || typeof ledger?.correctedVersion !== 'function') return row;
    const corrected = ledger.correctedVersion({ sessionId, turn, id: row?.id });
    if (corrected === null) return row;
    let next = row;
    if ((Number(row?.version) || 1) < Number(corrected) && typeof memory.getActiveById === 'function') {
      try {
        const current = memory.getActiveById(row.id);
        if (current !== null && typeof current === 'object') next = { ...row, ...current };
      } catch {
        /* keep the row we have; the flag below still says it is stale */
      }
    }
    return { ...next, turnUpdated: true };
  };
  const fixedRows = fixed.map((row) => annotateCorrected({ ...row, text: displayMessageText(row?.text, chars).text }));
  const archived = rankArchiveRows(archiveRows, text, Math.max(0, Number(caps.maxRecords) - fixedRows.length))
    .map((row) => annotateCorrected({ ...row, text: displayMessageText(row?.text, chars).text }));
  const matchedRows = matched.map((row) => annotateCorrected({ ...row }));

  // C: publish what this preparation already paid for. Tools with the same key read it instead
  // of querying again; only a correction (or a different/deeper query) forces a fresh lookup.
  if (ledger !== null && typeof ledger?.remember === 'function') {
    const versionsOf = (rows) => {
      const versions = {};
      for (const row of rows) {
        if (typeof row?.id === 'string' && row.id.length > 0) versions[row.id] = Number(row.version) || 1;
      }
      return versions;
    };
    if (sources.active === 'ok') {
      ledger.remember({
        sessionId,
        turn,
        kind: 'recall',
        query: text,
        fromIso: range?.fromIso ?? null,
        toIso: range?.toIso ?? null,
        limit: Number(caps.maxRecords) || 0,
        value: {
          ...recallMeta,
          hits: matched.map((row) => ({ ...row })),
          scanned: Number(recallMeta.scanned) || 0,
          mode: typeof recallMeta.mode === 'string' ? recallMeta.mode : 'keyword',
          roles: Array.isArray(recallMeta.roles) ? recallMeta.roles : ['user', 'assistant'],
          window: Number.isFinite(recallMeta.window) ? recallMeta.window : 0,
        },
        versions: versionsOf(matched),
      });
    }
    if (sources.archive === 'ok') {
      ledger.remember({
        sessionId,
        turn,
        kind: 'archive',
        query: text,
        fromIso: range?.fromIso ?? null,
        toIso: range?.toIso ?? null,
        limit: Math.max(1, Number(caps.maxRecords) || 0),
        value: { rows: archiveRows.map((row) => ({ ...row })), truncated: archiveTruncated },
        versions: versionsOf(archiveRows),
      });
    }
  }

  const notes = [];
  if (sources.active === 'timeout') notes.push('活跃记忆库检索超时，本轮只含已完成的部分');
  if (sources.archive === 'timeout') notes.push('归档检索超时，本轮只含已完成的部分');
  const layering = layerBudgets !== null && typeof layerBudgets === 'object';
  const composed = layering
    ? composeLayeredInjectionBlock({
      fixed: fixedRows,
      matched: [...matchedRows, ...archived],
      notes,
      limits: {
        ...caps,
        maxChars: Number.isFinite(Number(layerBudgets.totalChars))
          ? Math.max(0, Math.floor(Number(layerBudgets.totalChars)))
          : caps.maxChars,
      },
      fixedBudget: layerBudgets.fixed ?? caps.maxChars,
      memoryBudget: layerBudgets.memory ?? caps.maxChars,
      timeZone: tz,
      query: text,
      terms: Array.isArray(recallMeta.terms) ? recallMeta.terms : [],
    })
    : composeInjectionBlock({
      fixed: fixedRows,
      matched: [...matchedRows, ...archived],
      notes,
      limits: caps,
      timeZone: tz,
      query: text,
      terms: Array.isArray(recallMeta.terms) ? recallMeta.terms : [],
    });
  // Linked-reference source rows: only memories whose line actually rendered in this block can
  // contribute their current lexicon links. Composing them is read-only and never touches the
  // hit/rank/reinforcement state of the memory block itself.
  const injectedRowIds = new Set(Array.isArray(composed.injectedIds) ? composed.injectedIds : []);
  const linkedSourceRows = injectedRowIds.size === 0
    ? []
    : [...fixedRows, ...matchedRows, ...archived].filter((row) => (
      row !== null && typeof row === 'object'
      && injectedRowIds.has(row.id)
      && Array.isArray(row.lexiconIds) && row.lexiconIds.length > 0
    ));
  let linkedLexiconRefs = [];
  if (linkedSourceRows.length > 0) {
    try {
      const entries = typeof lexiconEntries === 'function' ? lexiconEntries() : lexiconEntries;
      if (Array.isArray(entries)) {
        const entriesById = new Map();
        for (const entry of entries) {
          if (entry !== null && typeof entry === 'object'
            && typeof entry.id === 'string' && entry.id.length > 0) {
            entriesById.set(entry.id, entry);
          }
        }
        linkedLexiconRefs = composeMemoryLexiconRefs(linkedSourceRows, entriesById);
      }
    } catch {
      linkedLexiconRefs = []; // reference material must never break the memory block
    }
  }
  // `total` is the rendered block length (heading/footer/notes included), so the debug row can
  // report the characters actually placed in the request, not only the content-line estimate.
  const contextLayers = composed.layerStats === null || composed.layerStats === undefined
    ? null
    : { ...composed.layerStats, total: composed.text.length };
  const hits = fixedRows.length + matchedRows.length + archived.length;
  // P-52 wiring: a candidate may move to `delivered` only if this block actually rendered its
  // row; the long-term subset is decided by the existing manual-lane rule, never by delivery.
  const rowById = new Map([...fixedRows, ...matchedRows, ...archived].map((row) => [row.id, row]));
  const persistIds = composed.injectedIds.filter((id) => candidatePersistsLongTerm(rowById.get(id)));
  const rangeMeta = range === null
    ? null
    : { from: range.fromIso, to: range.toIso, label: range.label };

  // Every await — including the log write — shares the same deadline. A late result must never
  // modify this request, and the last check before returning re-reads the clock.
  const emitWithinBudget = async (type, payload) => {
    if (typeof log?.emit !== 'function') return now() <= deadline;
    const outcome = await runSlicedTask(() => log.emit(type, payload), { deadline, now });
    return outcome.status !== 'timeout' && now() <= deadline;
  };
  // The budget is gone but the outcome must still be observable. This write is not awaited, so
  // it cannot extend the turn past the deadline; the caller already gets the timeout result.
  const emitLate = (type, payload) => {
    if (typeof log?.emit !== 'function') return;
    try {
      Promise.resolve(log.emit(type, payload)).catch(() => {});
    } catch {
      /* logging is best-effort */
    }
  };
  // Observation only: hands back the exact `memory.recall` payload this preparation wrote, so a
  // join event (`voice.injected`) can reuse its hits/injected instead of guessing them.
  const observeRecall = (payload) => {
    if (typeof onRecall !== 'function') return;
    try {
      onRecall(payload);
    } catch {
      /* an observer must never break the injection */
    }
  };
  // P-52: one aggregate candidate/delivered line per injection. Debug only: fire-and-forget, so a
  // marker can never extend the deadline or change what this turn injected. A quiet recall writes
  // neither line. `memory.recall.records` is the same delivered count these items report.
  const emitItemMarkers = (block) => {
    const marks = composeMemoryItemMarkers({ turn, prepared: block.prepared, deliveredIds: block.injectedIds });
    if (marks.prepared === 0) return;
    emitLate(MEMORY_ITEM_CANDIDATE_EVENT, { turn: marks.turn, items: marks.candidate });
    emitLate(MEMORY_ITEM_DELIVERED_EVENT, { turn: marks.turn, items: marks.delivered, adoptRate: marks.adoptRate });
  };
  const meta = {
    phase: 'pre-step',
    sessionId,
    turn,
    query: text,
    mode: typeof recallMeta.mode === 'string' ? recallMeta.mode : 'keyword',
    roles: Array.isArray(recallMeta.roles) ? recallMeta.roles : ['user', 'assistant'],
    window: Number.isFinite(recallMeta.window) ? recallMeta.window : 0,
    from: range?.fromIso ?? (typeof recallMeta.from === 'string' ? recallMeta.from : null),
    to: range?.toIso ?? (typeof recallMeta.to === 'string' ? recallMeta.to : null),
    timeRange: rangeMeta,
    archiveReason,
    relaxed: recallMeta.relaxed === true,
    sources,
    budgetMs: budget,
  };

  if (composed.text.length === 0) {
    // A miss still tells the model that a search happened and found nothing. It is a status line,
    // not a hit: `injected` stays false and no id is ever reinforced. A lane that allocated no
    // memory room must stay empty: the status row is memory content too, so it may not bypass the
    // total budget (e.g. `totalChars: 0`).
    const memoryRoom = layering
      ? Math.max(0, Math.floor(Number(layerBudgets.memory) || 0))
      : Number.POSITIVE_INFINITY;
    const completeness = sources.active === 'timeout' || sources.archive === 'timeout'
      ? 'timeout'
      : archiveTruncated ? 'budget-truncated' : 'complete';
    // 检索状态块也是要放进请求的记忆内容：它必须整块计入 memory 额度，否则只剩 1 字额度时，
    // 一份约 80 字的状态会从总预算之外溜进去。放不下就整块不注入（状态不能截断后冒充完整），
    // 刚好等于额度是允许的边界。
    const statusCandidate = memoryRoom === 0
      ? ''
      : composeMemoryStatus({ sources, range, timeZone: tz, complete: completeness });
    const statusText = statusCandidate.length <= memoryRoom ? statusCandidate : '';
    const statusChars = statusText.length;
    // 只有真正注入的状态块才写进日志：命中路径的 contextLayers/文本口径保持原样。
    const missLayers = statusChars === 0 || contextLayers === null
      ? contextLayers
      : {
        ...contextLayers,
        memory: {
          ...(contextLayers.memory ?? {}),
          chars: (Number(contextLayers.memory?.chars) || 0) + statusChars,
        },
        total: (Number(contextLayers.total) || 0) + statusChars,
      };
    const recallPayload = {
      ...meta, hits, injected: false, status: true, completeness,
      injectedChars: 0, statusChars, requestedChars: composed.requestedChars, records: 0,
    };
    if (now() > deadline || !(await emitWithinBudget('memory.recall', recallPayload))) {
      recallPayload.injected = false;
      recallPayload.reason = 'timeout';
      recallPayload.completeness = 'timeout';
      recallPayload.statusChars = 0; // 请求里不会出现状态块，日志也不再声称它被注入
      emitLate('memory.recall', recallPayload);
      observeRecall(recallPayload);
      return {
        text: '', injected: false, reason: 'timeout', sources, archiveReason, hits, completeness: 'timeout',
        injectedChars: 0, statusChars: 0, requestedChars: composed.requestedChars, injectedIds: [], matchedIds: [], persistIds: [],
        contextLayers,
      };
    }
    observeRecall(recallPayload);
    // The status block still enters the request, but not one prepared row was adopted: the
    // candidate line lists them, the delivered line is empty with adoptRate 0.
    emitItemMarkers(composed);
    return {
      text: statusText, injected: false, reason: 'no-hit', status: true, sources, archiveReason, hits,
      completeness, statusChars,
      injectedChars: 0, requestedChars: composed.requestedChars, injectedIds: [], matchedIds: [], persistIds: [],
      contextLayers: missLayers,
    };
  }

  // Reinforcement is deliberately NOT performed here: only the pre-step handler, after it has
  // actually put the message into the decision, knows the records entered this turn's request.
  const recallPayload = {
    ...meta, hits, injected: true,
    injectedChars: composed.injectedChars,
    requestedChars: composed.requestedChars,
    records: composed.injectedRecords,
    fixedRecords: fixedRows.filter((row) => composed.injectedIds.includes(row.id)).length,
    archiveRecords: archived.filter((row) => composed.injectedIds.includes(row.id)).length,
  };
  if (composed.overflow) {
    const overflowOk = await emitWithinBudget('memory.budget.overflow', {
      requestedChars: composed.requestedChars,
      injectedChars: composed.injectedChars,
      requestedRecords: composed.requestedRecords,
      injectedRecords: composed.injectedRecords,
      sessionId,
      turn,
    });
    if (!overflowOk || now() > deadline) {
      recallPayload.injected = false;
      recallPayload.reason = 'timeout';
      recallPayload.completeness = 'timeout';
      emitLate('memory.recall', recallPayload);
      observeRecall(recallPayload);
      return {
        text: '', injected: false, reason: 'timeout', sources, archiveReason, hits,
        injectedChars: 0, requestedChars: composed.requestedChars, injectedIds: [], matchedIds: [], persistIds: [],
        contextLayers,
      };
    }
  }
  // What actually entered the request, next to what assembly thought it spent. `assembly.chars`
  // is the store's label-inclusive estimate for its own rows (no heading/footer, no fixed layer),
  // so the gap is the honest overhead of rendering the final block.
  const injectionEvent = {
    injectedChars: composed.injectedChars,
    assemblyChars: Number(recallMeta?.assembly?.chars) || 0,
    hits: composed.injectedKinds.hit,
    links: composed.injectedKinds.link,
    pairs: composed.injectedKinds.pair,
    neighbors: composed.injectedKinds.neighbor,
    unresolvedRows: composed.unresolvedRows,
    skippedByChars: composed.skippedByChars,
    sessionId,
    turn,
  };
  if (!(await emitWithinBudget('memory.injection', injectionEvent)) || now() > deadline) {
    recallPayload.injected = false;
    recallPayload.reason = 'timeout';
    recallPayload.completeness = 'timeout';
    emitLate('memory.recall', recallPayload);
    return {
      text: '', injected: false, reason: 'timeout', sources, archiveReason, hits,
      injectedChars: 0, requestedChars: composed.requestedChars, injectedIds: [], matchedIds: [], persistIds: [],
      contextLayers,
    };
  }
  if (!(await emitWithinBudget('memory.recall', recallPayload)) || now() > deadline) {
    recallPayload.injected = false;
    recallPayload.reason = 'timeout';
    recallPayload.completeness = 'timeout';
    emitLate('memory.recall', recallPayload);
    observeRecall(recallPayload);
    return {
      text: '', injected: false, reason: 'timeout', sources, archiveReason, hits,
      injectedChars: 0, requestedChars: composed.requestedChars, injectedIds: [], matchedIds: [], persistIds: [],
      contextLayers,
    };
  }
  observeRecall(recallPayload);
  // P-52: exactly one candidate line and one delivered line for this injection (never per item).
  emitItemMarkers(composed);
  return {
    text: composed.text,
    injected: true,
    reason: 'injected',
    sources,
    archiveReason,
    hits,
    injectedChars: composed.injectedChars,
    requestedChars: composed.requestedChars,
    injectedIds: composed.injectedIds,
    matchedIds: composed.matchedIds,
    persistIds,
    contextLayers,
    linkedLexiconRefs,
  };
}


/**
 * Wire the preparation into `agent/pre-step`: wait for the host's own decision, then append one
 * message to it. Nothing is rebuilt, a `reject` is returned untouched, and only the first step of
 * a turn is considered. A per-turn key makes a retry/multi-step call a no-op.
 */
export function createMemoryPreStep({
  memory,
  log = null,
  settings = () => ({}),
  inScope = () => true,
  isSubagent = () => false,
  featureEnabled = () => true,
  now = () => Date.now(),
  budgetMs = null,
  displayChars = AUTO_MEMORY_DEFAULTS.maxChars,
  ledger = null,
  onRecall = null,
  contextBudgets = () => null,
  laneForSession = () => 'typed',
  measureLayers = null,
  onContextBudget = null,
  lexiconEntries = null,
} = {}) {
  const seen = new Map();
  const instances = new WeakMap();
  let instanceSeq = 0;
  const readConfig = () => {
    try {
      const value = typeof settings === 'function' ? settings() : settings;
      return value !== null && typeof value === 'object' ? value : {};
    } catch {
      return {};
    }
  };
  const readContextBudgets = () => {
    try {
      const value = typeof contextBudgets === 'function' ? contextBudgets() : contextBudgets;
      return value !== null && typeof value === 'object' ? value : null;
    } catch {
      return null;
    }
  };
  const laneOf = (sessionId) => {
    try {
      return laneForSession(sessionId) === 'voice' ? 'voice' : 'typed';
    } catch {
      return 'typed';
    }
  };
  /**
   * P-59: one debug row per prepared turn. It is fire-and-forget so observation can never extend
   * the preparation budget, and it carries counts only (never any body text). `configured` says
   * whether this round's per-layer caps came from `contextBudgets` or from the built-in defaults.
   */
  const emitContextBudget = (sessionId, turn, lane, budget, prepared, measured, plan) => {
    try {
      const payload = {
        ...buildContextBudgetPayload({
          lane,
          budget,
          measured,
          memoryLayers: prepared?.contextLayers ?? null,
          plan,
        }),
        source: budget.configured === true ? 'config' : 'default',
        sessionId,
        turn,
      };
      if (typeof onContextBudget === 'function') {
        try {
          onContextBudget(payload);
        } catch {
          /* an observer must never break preparation */
        }
      }
      if (typeof log?.emit === 'function') {
        const pending = log.emit('context.budget', { level: 'debug', ...payload });
        if (pending !== null && pending !== undefined && typeof pending.catch === 'function') {
          pending.catch(() => {});
        }
      }
    } catch {
      /* diagnostics are best-effort */
    }
  };
  const configuredBudget = () => {
    // `null`/`undefined` mean "not overridden"; `Number(null)` is 0 and must not become a budget.
    const explicit = budgetMs === null || budgetMs === undefined ? NaN : Number(budgetMs);
    if (Number.isFinite(explicit)) return Math.max(0, explicit);
    const saved = Number(readConfig().prepareBudgetMs);
    return Number.isFinite(saved) && saved >= 0 ? saved : MEMORY_INJECTION_DEFAULTS.prepareBudgetMs;
  };
  const configuredTimeZone = () => resolveC2TimeZone(readConfig().timeZone);
  const configuredFuzzyDays = () => {
    const saved = Number(readConfig().fuzzyDays);
    return Number.isFinite(saved) && saved >= 1 ? Math.floor(saved) : C2_DEFAULT_FUZZY_DAYS;
  };
  /** Records the decision appended but the host has not logged yet: ids + the turn to reinforce. */
  const pendingDelivery = new Map();
  const chars = () => {
    const value = typeof displayChars === 'function' ? displayChars() : displayChars;
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : AUTO_MEMORY_DEFAULTS.maxChars;
  };
  /**
   * Confirmed lexicon entries for this turn. A missing/broken store is a plain "no words": the
   * lexicon block is optional reference material and must never break the turn.
   */
  const readLexiconEntries = () => {
    try {
      const value = typeof lexiconEntries === 'function' ? lexiconEntries() : lexiconEntries;
      return Array.isArray(value) ? value : [];
    } catch {
      return [];
    }
  };
  const instanceOf = (agent) => {
    if (agent === null || typeof agent !== 'object') return 'none';
    let value = instances.get(agent);
    if (value === undefined) {
      instanceSeq += 1;
      value = instanceSeq;
      instances.set(agent, value);
    }
    return String(value);
  };

  const handle = async (payload, next) => {
    const decision = await next();
    if (decision === null || typeof decision !== 'object') return decision;
    // Never append to a refusal: the host must see exactly the rejection its waterfall produced.
    if (decision.kind === 'reject') return decision;
    if (Number(payload?.step) !== 1) return decision;
    const agent = payload?.agent;
    const session = agent?.session;
    const sessionId = typeof session?.id === 'string' ? session.id : '';
    const turn = Number.isInteger(payload?.turn) ? payload.turn : -1;
    if (sessionId.length === 0 || turn < 0) return decision;
    const query = memoryQueryText(payload?.messages);
    if (query.length === 0) return decision;
    let on = false;
    try {
      on = featureEnabled() === true;
    } catch {
      on = false;
    }
    if (!on) return decision;
    let scoped = false;
    try {
      scoped = inScope(agent) === true;
    } catch {
      scoped = false;
    }
    if (!scoped) return decision;
    let child = true;
    try {
      child = isSubagent(agent) === true;
    } catch {
      child = true;
    }
    if (child) return decision;
    const signal = payload?.signal;
    const aborted = () => signal?.aborted === true;
    if (aborted()) return decision;
    // Dedup identity: one injection per (session, turn, agent instance). A resumed/rebuilt agent
    // is a new instance and may inject again; a retry of the same instance may not.
    const key = `${sessionId}\u0000${turn}\u0000${instanceOf(agent)}`;
    if (seen.has(key)) return decision;
    seen.set(key, { sessionId, turn });
    // P-59: the lane is decided per session, never per text: the dated companion session is the
    // voice entry, every other in-scope session is the typed entry. Per-layer caps only replace the
    // legacy single block cap when `contextBudgets` is configured; defaults stay advisory.
    const lane = laneOf(sessionId);
    const budget = resolveContextBudget(readContextBudgets(), lane);
    // The prompt assembled before this pre-step has already allocated the whole lane. Read that
    // one plan (or measure it here when no prompt service rendered) so memory may only spend what
    // the plan reserved for it: the total budget covers prompt + injected memory, not two caps.
    let measured = {};
    let layerPlan = null;
    if (typeof measureLayers === 'function') {
      try {
        measured = measureLayers({ sessionId, turn, lane, budget, agent }) ?? {};
        layerPlan = measured?.plan ?? null;
      } catch {
        measured = {};
        layerPlan = null;
      }
    }
    const memoryAllowance = layerPlan !== null && Number.isFinite(layerPlan?.layers?.memory?.chars)
      ? Math.max(0, Math.floor(layerPlan.layers.memory.chars))
      : null;
    const layerBudgets = budget.configured === true
      ? {
        // Fixed memories are protected: their cap is the legacy whole-block cap (1200), never the
        // configured `fixed` quota, so a tight fixed quota can never let a relevance hit push a
        // standing constraint out. Only `memory` is narrowed here by the lane total plan.
        fixed: MEMORY_INJECTION_DEFAULTS.maxChars,
        memory: memoryAllowance ?? budget.memory,
        totalChars: MEMORY_INJECTION_DEFAULTS.maxChars + (memoryAllowance ?? budget.memory),
      }
      : null;
    // One read of the current lexicon for this turn: the memory-linked composition (only when a
    // rendered memory carries links) and the 词语参考 recall share it, so a turn reads it once.
    let lexiconCache = null;
    const entriesForTurn = () => {
      if (lexiconCache === null) lexiconCache = readLexiconEntries();
      return lexiconCache;
    };
    let result;
    try {
      result = await prepareMemoryInjection({
        memory,
        log,
        sessionId,
        turn,
        query,
        budgetMs: configuredBudget(),
        now,
        isAborted: aborted,
        limits: MEMORY_INJECTION_DEFAULTS,
        displayChars: chars(),
        timeZone: configuredTimeZone(),
        fuzzyDays: configuredFuzzyDays(),
        ledger,
        onRecall,
        layerBudgets,
        lexiconEntries: entriesForTurn,
      });
    } catch (error) {
      seen.delete(key); // a failed preparation must not poison a retry
      if (typeof log?.emit === 'function') {
        try {
          await log.emit('memory.recall.failed', {
            phase: 'pre-step', sessionId, turn, error: error?.message ?? String(error),
          });
        } catch {
          /* logging is best-effort */
        }
      }
      return decision;
    }
    if (aborted()) return decision;
    // P-59: one `context.budget` row for the round that actually prepared (a miss included), so
    // the P-46 timeline and P-52 candidate/delivered rows can be reconciled with what was placed.
    emitContextBudget(sessionId, turn, lane, budget, result, measured, layerPlan);
    const outgoing = [];
    if (result.text.length > 0) {
      const injected = memoryInjectionMessage(result.text);
      // The message is only in a decision the host may still drop or replace. Candidate delivery
      // and reinforcement both wait for the observable `user/message` write (see `observe`).
      const candidateIds = Array.isArray(result.injectedIds) ? result.injectedIds : [];
      if (candidateIds.length > 0 || result.matchedIds.length > 0) {
        pendingDelivery.set(injected.id, {
          sessionId,
          turn,
          ids: [...result.matchedIds],
          candidateIds: [...candidateIds],
          persistIds: Array.isArray(result.persistIds) ? [...result.persistIds] : [],
        });
        if (pendingDelivery.size > 64) {
          // A previous delivery whose event never arrived must not grow this map forever.
          const oldest = pendingDelivery.keys().next().value;
          if (oldest !== injected.id) pendingDelivery.delete(oldest);
        }
      }
      outgoing.push(injected);
    }
    // Lexicon v2: a separate reference message with its own cap. It never joins the memory block,
    // never shares its budget, and is not registered in `pendingDelivery`, so writing it cannot
    // reinforce a memory record. Only confirmed entries are considered (see recallLexiconContext).
    let lexiconText = '';
    try {
      lexiconText = recallLexiconContext({entries: entriesForTurn(), text: query}).text;
    } catch {
      lexiconText = ''; // reference material must never fail the turn
    }
    // Memory-linked words: an independent micro-block AFTER the memory block. The 词语参考 block
    // owns the words it already rendered this turn, so the linked block skips those same entries;
    // one stable entry id therefore appears at most once. It is reference-only: no memory write,
    // no reinforcement, and no candidate registration (see `observe`).
    let linkedText = '';
    try {
      linkedText = composeLinkedLexiconContext(
        Array.isArray(result.linkedLexiconRefs) ? result.linkedLexiconRefs : [],
        { renderedText: lexiconText },
      ).text;
    } catch {
      linkedText = ''; // reference material must never fail the turn
    }
    if (linkedText.length > 0) outgoing.push(memoryInjectionMessage(linkedText));
    if (lexiconText.length > 0) outgoing.push(memoryInjectionMessage(lexiconText));
    if (outgoing.length === 0) return decision;
    return {
      ...decision,
      messages: [
        ...(Array.isArray(decision.messages) ? decision.messages : []),
        ...outgoing,
      ],
    };
  };

  /**
   * Host-side bookkeeping, the ONLY reinforcement point, and the P-52 delivery point.
   *
   * The pre-step hook returns a message the host may still replace or cancel, so candidate
   * delivery and `restore()` are deferred until the injected message is actually written to the
   * session. A turn that ends without that write drops its pending ids and delivers nothing; a
   * duplicate event for an already-delivered message is a no-op. The store owns the
   * `memory.candidate` / `memory.delivered` / `memory.persisted` events — the host emits none.
   */
  const observe = (session, event) => {
    let delivered = null;
    try {
      const sessionId = typeof session?.id === 'string' ? session.id : '';
      if (sessionId.length === 0 || event === null || typeof event !== 'object') return undefined;
      const turn = Number.isInteger(event.data?.turn) ? event.data.turn : null;
      if (event.type === 'turn/end') {
        for (const [key, value] of seen) {
          if (value.sessionId === sessionId && (turn === null || value.turn === turn)) seen.delete(key);
        }
        for (const [messageId, entry] of pendingDelivery) {
          if (entry.sessionId === sessionId && (turn === null || entry.turn === turn)) {
            pendingDelivery.delete(messageId);
          }
        }
      } else if (event.type === 'turn/start' && turn !== null) {
        for (const [key, value] of seen) {
          if (value.sessionId === sessionId && value.turn < turn) seen.delete(key);
        }
        for (const [messageId, entry] of pendingDelivery) {
          if (entry.sessionId === sessionId && entry.turn < turn) pendingDelivery.delete(messageId);
        }
      } else if (event.type === 'user/message' && isAssistantMemoryMessage(event.data)) {
        const messageId = event.data?.id;
        const entry = typeof messageId === 'string' ? pendingDelivery.get(messageId) : undefined;
        if (entry !== undefined) {
          pendingDelivery.delete(messageId);
          // D: one turn + one memory id is strengthened once across every lane. C2 was first
          // here, so an id it already delivered is not reinforced again by a later tool.
          const ids = entry.ids.filter((id) => ledger === null || typeof ledger?.hasStrengthened !== 'function'
            || !ledger.hasStrengthened({ sessionId, turn: entry.turn, id }));
          if (ids.length > 0) {
            try {
              memory.restore?.(ids);
              if (ledger !== null && typeof ledger?.markStrengthened === 'function') {
                ledger.markStrengthened({ sessionId, turn: entry.turn, ids });
              }
            } catch {
              /* a broken memory database must not swallow the turn */
            }
            delivered = { ids: [...ids], turn: entry.turn };
          }
          // P-52: the block is in the session now, so exactly the ids it rendered are delivered.
          // `deliverCandidates` is idempotent, so a replay moves nothing and emits no second event.
          const candidates = Array.isArray(entry.candidateIds) ? entry.candidateIds : [];
          if (candidates.length > 0 && typeof memory.deliverCandidates === 'function') {
            const moved = memory.deliverCandidates(candidates, { turn: entry.turn });
            const done = new Set(Array.isArray(moved?.delivered) ? moved.delivered : []);
            for (const id of Array.isArray(entry.persistIds) ? entry.persistIds : []) {
              if (done.has(id) && typeof memory.persistCandidate === 'function') memory.persistCandidate(id);
            }
          }
        }
      }
    } catch {
      /* bookkeeping only */
    }
    if (delivered === null) return undefined;
    try {
      return Promise.resolve(log?.emit?.('memory.restore.delivered', delivered)).catch(() => {});
    } catch {
      return undefined;
    }
  };

  return {
    handle,
    observe,
    /** Diagnostic: keys still waiting for their turn to end. */
    seenCount: () => seen.size,
  };
}

export { runSlicedTask, readArchiveCandidates, rankArchiveRows };
