/** pre-step — extracted from index.js; no host entry dependency. */
import { AUTO_MEMORY_DEFAULTS } from './store.js';
import { C2_DEFAULT_FUZZY_DAYS } from '../shared/time.js';
import { C2_DEFAULT_TIME_ZONE } from '../shared/time.js';
import { MEMORY_INJECTION_DEFAULTS } from './memory-injection.js';
import { candidatePersistsLongTerm } from './memory-injection.js';
import { composeInjectionBlock } from './memory-injection.js';
import { composeLayeredInjectionBlock } from './memory-injection.js';
import { composeMemoryStatus } from './memory-injection.js';
import { detectArchiveRange } from '../shared/time.js';
import { displayMessageText } from './store.js';
import { injectionRowRank } from './memory-injection.js';
import { isAssistantMemoryMessage } from '../shared/text.js';
import { memoryInjectionMessage } from '../shared/text.js';
import { memoryQueryText } from '../shared/text.js';
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
  const contextLayers = composed.layerStats ?? null;
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
    // not a hit: `injected` stays false and no id is ever reinforced.
    const completeness = sources.active === 'timeout' || sources.archive === 'timeout'
      ? 'timeout'
      : archiveTruncated ? 'budget-truncated' : 'complete';
    const statusText = composeMemoryStatus({ sources, range, timeZone: tz, complete: completeness });
    const recallPayload = {
      ...meta, hits, injected: false, status: true, completeness,
      injectedChars: 0, requestedChars: composed.requestedChars, records: 0,
    };
    if (now() > deadline || !(await emitWithinBudget('memory.recall', recallPayload))) {
      recallPayload.injected = false;
      recallPayload.reason = 'timeout';
      recallPayload.completeness = 'timeout';
      emitLate('memory.recall', recallPayload);
      observeRecall(recallPayload);
      return {
        text: '', injected: false, reason: 'timeout', sources, archiveReason, hits, completeness: 'timeout',
        injectedChars: 0, requestedChars: composed.requestedChars, injectedIds: [], matchedIds: [], persistIds: [],
        contextLayers: composed.layerStats ?? null,
      };
    }
    observeRecall(recallPayload);
    // The status block still enters the request, but not one prepared row was adopted: the
    // candidate line lists them, the delivered line is empty with adoptRate 0.
    emitItemMarkers(composed);
    return {
      text: statusText, injected: false, reason: 'no-hit', status: true, sources, archiveReason, hits,
      completeness,
      injectedChars: 0, requestedChars: composed.requestedChars, injectedIds: [], matchedIds: [], persistIds: [],
      contextLayers: composed.layerStats ?? null,
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
        contextLayers: composed.layerStats ?? null,
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
      contextLayers: composed.layerStats ?? null,
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
      contextLayers: composed.layerStats ?? null,
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
    contextLayers: composed.layerStats ?? null,
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
  const emitContextBudget = (sessionId, turn, lane, budget, prepared) => {
    try {
      let measured = {};
      if (typeof measureLayers === 'function') {
        try {
          measured = measureLayers({ sessionId, turn, lane, budget }) ?? {};
        } catch {
          measured = {};
        }
      }
      const payload = {
        ...buildContextBudgetPayload({
          lane,
          budget,
          measured,
          memoryLayers: prepared?.contextLayers ?? null,
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
    const layerBudgets = budget.configured === true
      ? {
        // Fixed memories are protected: their cap is the legacy whole-block cap (1200), never the
        // configured `fixed` quota, so a tight fixed quota can never let a relevance hit push a
        // standing constraint out. Only `memory` is narrowed from configuration.
        fixed: MEMORY_INJECTION_DEFAULTS.maxChars,
        memory: budget.memory,
        totalChars: MEMORY_INJECTION_DEFAULTS.maxChars + budget.memory,
      }
      : null;
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
    emitContextBudget(sessionId, turn, lane, budget, result);
    if (result.text.length === 0) return decision;
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
    return {
      ...decision,
      messages: [
        ...(Array.isArray(decision.messages) ? decision.messages : []),
        injected,
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
