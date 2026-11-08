/**
 * Fast path: a direct LLM conversation for the companion, bypassing the agent loop.
 *
 * It reuses the Harness `llm` service (DESIGN §10.1: `llm` + `credentials`), so the request is
 * routed to DeepSeek with the DSH credential — no second key, no second connection pool.
 * Because it does not open a Session, these turns never appear in Harness session logs; the
 * plugin only persists its own conversation file.
 *
 * The conversation is persisted to `<root>/data/conversation.jsonl` so "审阅" can read it later
 * (the fast path deliberately does not appear in DSH session logs).
 */
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

// The speech cap is shared with every other speaking lane (`voice.speechMaxChars`, 1200 by
// default), so the fast path cannot speak past what the rest of the assistant may speak.
import { DEFAULT_SPEECH_MAX_CHARS, resolveSpeechBudget } from '../../speech/speech-text.js';
import {
  assembleLayerPlan,
  contextLayerStats,
  resolveContextBudget,
} from '../../memory/context-layers.js';

// P-59: the joined prompt is no longer sliced by a single constant. The cap is a per-layer
// budget plan (defaults in `DEFAULT_CONTEXT_BUDGETS.fastpath`, 6000 chars total): persona/fixed
// are protected, and memory/recent/ephemeral are trimmed whole-line inside their own layer. A
// deployment narrows it with `contextBudgets.fastpath`.
// One "turn" is one persisted user/assistant line. Keep this many, and feed all of them
// to the prompt (stored size === prompt window).
const MAX_HISTORY_TURNS = 8;

const SENTENCE_END = '。！？!?；;';
const CLAUSE_END = '，,';

// P-58: the per-turn budget covers generation only. Sentences are handed to the bounded queue
// below; playback is never awaited by the read loop and never charged to this timeout.
const STREAM_TIMEOUT_MS = 45_000;
const SENTENCE_QUEUE_LIMIT = 16;
const QUEUE_DEPTH_THROTTLE_MS = 200;
// P-69: an unchanged domain is reported at most once per window; a changed domain is reported
// immediately, so the event log shows the source without one line per utterance.
const DOMAIN_EVENT_THROTTLE_MS = 60_000;
// P2: the context scope is reported like the domain itself — once per window for an unchanged
// scope, so a steady conversation does not log one scope line per utterance.
const CONTEXT_SCOPE_EVENT_THROTTLE_MS = 60_000;
// Speech text is content, not a realtime frame: a full queue merges its waiting sentences
// instead of overwriting them. A SINGLE sentence longer than `BLOCK_MAX_CHARS` is SPLIT at a
// clause boundary (or at that length) so every character still reaches playback; only the turn's
// total speech budget may cut the tail, and that cut is counted (`truncatedChars`).
const BLOCK_MAX_CHARS = 200;
const SPEECH_SPLIT_PUNCT = '，,、；;：:';
const ZERO_QUEUE_STATS = Object.freeze({ truncatedChars: 0, droppedSentences: 0 });

// A provider hiccup (5xx / "too busy" / a dropped connection) is retried once, because the user
// otherwise just sees the sentence disappear. 800 ms ±20 % is long enough for the provider to
// settle, short enough that a voice turn still feels like a turn; the jitter stops simultaneous
// retries from lining up. Only a turn that has not started speaking may retry (repeating audio
// would be worse than the failure).
const RETRY_DELAY_MS = 800;
const RETRY_JITTER_RATIO = 0.2;
const MAX_ATTEMPTS = 2;
// One generation budget per TURN, not per attempt: the retry spends what is left of the deadline
// the first attempt started with, so a 45 s turn cannot become a ~90 s one. Below this window an
// attempt cannot even open its stream before that deadline fires, so it is not started at all and
// the turn fails as `budget-exhausted` instead of pretending to try.
const MIN_ATTEMPT_MS = 10;
// P-51: a provider can refuse a per-request reasoning effort. That refusal is not a turn failure:
// it is one visible downgrade to the model default (retry once without the control), reported at
// most once per window per (requested, reason) pair so a broken route cannot flood the log.
const REASONING_DOWNGRADE_THROTTLE_MS = 60_000;
const UNSUPPORTED_REASONING_EFFORT = /UNSUPPORTED_REASONING_EFFORT|unsupported reasoning|does not support reasoning/iu;

/** Number carried by a provider/network error, if any (`status`, `statusCode`, `code`). */
function failureStatus(error) {
  for (const source of [error, error?.failure, error?.cause, error?.response, error?.details]) {
    for (const key of ['status', 'statusCode', 'httpStatus', 'code']) {
      const value = Number(source?.[key]);
      if (Number.isInteger(value) && value >= 400 && value <= 599) return value;
    }
  }
  const message = String(error?.message ?? '');
  const explicit = /(?:HTTP|status|code)\s*[:=]?\s*([45]\d{2})\b/iu.exec(message);
  if (explicit !== null) return Number(explicit[1]);
  const bare = /\b([45]\d{2})\b/u.exec(message);
  return bare === null ? null : Number(bare[1]);
}

const RETRYABLE_NETWORK = /timeout|timed out|ETIMEDOUT|ESOCKETTIMEDOUT|ECONNRESET|ECONNREFUSED|ECONNABORTED|ENOTFOUND|EAI_AGAIN|EPIPE|socket hang up|network error|fetch failed|connection (?:reset|refused|closed)/iu;
const RETRYABLE_SERVER = /internal server error|bad gateway|gateway timeout|service unavailable|temporarily unavailable/iu;
const RETRYABLE_BUSY = /too busy|overloaded|temporarily busy/iu;

/**
 * Decide whether one failed fast-path request may be retried, and name the reason for the event
 * log. `cancelled` (the user's own barge-in / stop) and `timedOut` (this turn's local budget) are
 * never retried. Everything else maps to a short, stable reason: `provider-busy`,
 * `server-error`, `network`, `abort`, `http-<status>` or `error`.
 */
export function classifyFastpathFailure(error, { cancelled = false, timedOut = false } = {}) {
  if (cancelled) return { retryable: false, reason: 'cancelled' };
  if (timedOut) return { retryable: false, reason: 'timeout' };
  const status = failureStatus(error);
  const message = String(error?.message ?? error ?? '');
  const name = String(error?.name ?? '');
  if (RETRYABLE_BUSY.test(message)) return { retryable: true, reason: 'provider-busy' };
  if (status !== null && status >= 500 && status <= 599) return { retryable: true, reason: 'server-error' };
  if (RETRYABLE_SERVER.test(message)) return { retryable: true, reason: 'server-error' };
  if (RETRYABLE_NETWORK.test(message)) return { retryable: true, reason: 'network' };
  if (name === 'AbortError' || name === 'TimeoutError') return { retryable: true, reason: 'abort' };
  return { retryable: false, reason: status !== null ? `http-${status}` : 'error' };
}

/** One backoff value: the base ±`jitter` (0.2 = ±20 %), rounded to whole milliseconds. */
export function fastpathRetryDelayMs({ base = RETRY_DELAY_MS, jitter = RETRY_JITTER_RATIO, random = Math.random } = {}) {
  const spread = Math.max(0, Number(jitter) || 0);
  return Math.max(1, Math.round(Number(base) * (1 + (random() * 2 - 1) * spread)));
}

/**
 * P-51: true when the provider refused the requested reasoning effort (error code or message).
 * The chat path and the lightweight channel share this ONE classifier, so a refusal is recognised
 * the same way everywhere.
 */
export function isUnsupportedReasoningEffort(error) {
  const code = String(error?.code ?? '');
  const message = String(error?.message ?? error ?? '');
  return UNSUPPORTED_REASONING_EFFORT.test(code) || UNSUPPORTED_REASONING_EFFORT.test(message);
}

/** Normalize a per-request effort; a blank value means "omitted" (the model's own default). */
export function normalizeReasoningEffort(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/**
 * One throttled `reasoning.downgraded {requested, fallback, reason}` reporter. Debug-grade: a
 * diagnostic can never throw into a request, and the same downgrade is emitted at most once per
 * window instead of on every auxiliary call.
 */
export function createReasoningDowngradeReporter({
  emit = null,
  now = () => Date.now(),
  throttleMs = REASONING_DOWNGRADE_THROTTLE_MS,
} = {}) {
  const lastByKey = new Map();
  return function reportReasoningDowngraded({ requested, fallback = 'default', reason = 'unsupported' } = {}) {
    const key = `${String(requested)}\u0000${String(fallback)}\u0000${String(reason)}`;
    const at = now();
    const last = lastByKey.get(key);
    if (last !== undefined && at - last < throttleMs) return false;
    lastByKey.set(key, at);
    if (typeof emit === 'function') {
      try {
        const pending = emit('reasoning.downgraded', { requested, fallback, reason });
        if (pending !== null && pending !== undefined && typeof pending.catch === 'function') pending.catch(() => {});
      } catch {
        /* diagnostics are best-effort */
      }
    }
    return true;
  };
}

/**
 * The turn's failure when the SHARED generation budget ran out — deliberately not a provider
 * verdict: `budget-exhausted` says "we did not give the model a usable window", so it can never be
 * confused with a 5xx / network error (and is never retried). The detail carries `budgetMs` (the
 * turn's whole budget) and `attempts` (how many attempts actually ran), like every other failure.
 */
function budgetExhaustedError({ attempt, budgetMs, remainingMs, turn, lastReason = '', delayMs = 0 }) {
  const left = Math.max(0, Math.round(remainingMs));
  const error = new Error(`生成预算已耗尽（剩余 ${left} 毫秒，本轮生成预算 ${budgetMs} 毫秒）`);
  error.fastpathBudgetExhausted = true;
  error.fastpathSpoken = 0;
  error.fastpathFailure = {
    reason: 'budget-exhausted',
    retryable: false,
    attempts: attempt,
    spoken: 0,
    budgetMs,
    remainingMs: left,
    lastReason,
    delayMs,
    turn,
  };
  return error;
}

/** Wait for the retry window; a user cancel during the wait ends the turn without a retry. */
function waitForRetry(delayMs, signal) {
  if (signal === undefined) return new Promise((resolve) => { setTimeout(resolve, delayMs); });
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      finish();
      reject(abortError());
    };
    const timer = setTimeout(() => {
      finish();
      resolve();
    }, delayMs);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** A finish-frame failure keeps its status/code so the retry classifier can read them. */
function modelFailure(failure) {
  const error = new Error(failure?.message ?? '模型返回错误');
  if (failure !== null && typeof failure === 'object') {
    if (failure.status !== undefined) error.status = failure.status;
    if (failure.statusCode !== undefined) error.statusCode = failure.statusCode;
    if (failure.code !== undefined) error.code = failure.code;
    error.failure = failure;
  }
  return error;
}

/** Positive finite override from config, otherwise the code default. */
function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

/** Non-negative finite override from config, otherwise the code default. */
function nonNegativeNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

// P-69 (A plan, user-final 2026-11-07): a turn belongs to the workspace it was spoken in unless
// an explicit domain names a narrower group. A domain is a STABLE identifier — either a memory
// domain (`work`, `movie`) or the workspace ID `ws:<sha256(normalized path)[0..12]>` — never the
// workspace directory name (that is only the `domainLabel` the UI shows) and never an inferred
// topic. `''` / `source='default'` means "not grouped", which stays a legal result.
const DOMAIN_RE = /^[a-z][a-z0-9_-]{0,31}$/u;
const WORKSPACE_DOMAIN_RE = /^ws:[0-9a-f]{12}$/u;
export const UNGROUPED_DOMAIN = '';

/**
 * A domain ID is either a memory-shaped name or a workspace ID. `ws:<hex12>` is deliberately
 * outside `DOMAIN_RE` (':' is not a memory-domain character), so the two are told apart.
 */
export function isTurnDomain(value) {
  return typeof value === 'string' && (DOMAIN_RE.test(value) || WORKSPACE_DOMAIN_RE.test(value));
}

/** Normalize a caller/stored domain: lowercase; anything unusable becomes '' (ungrouped). */
export function normalizeTurnDomain(value) {
  if (typeof value !== 'string') return UNGROUPED_DOMAIN;
  const domain = value.trim().toLowerCase();
  return isTurnDomain(domain) ? domain : UNGROUPED_DOMAIN;
}

/**
 * P2: the domains whose persisted lines may enter ONE prompt. A turn is scoped to its own
 * resolved domain (or an explicit allow-list of the same shape); `''` (ungrouped) is a scope of
 * its own, never merged into a named domain, so another workspace's lines cannot leak into this
 * request. An empty/unusable scope fails closed to ungrouped instead of "everything".
 */
export function promptDomainScope(value) {
  const list = Array.isArray(value) ? value : [value];
  const domains = [];
  for (const item of list) {
    const domain = normalizeTurnDomain(item);
    if (!domains.includes(domain)) domains.push(domain);
  }
  return domains.length > 0 ? domains : [UNGROUPED_DOMAIN];
}

/** A configured allow-list as normalized, de-duplicated domain IDs ('' entries dropped). */
function normalizeDomainList(value) {
  const list = Array.isArray(value) ? value : [];
  const domains = [];
  for (const item of list) {
    const domain = normalizeTurnDomain(item);
    if (domain !== UNGROUPED_DOMAIN && !domains.includes(domain)) domains.push(domain);
  }
  return domains;
}

/**
 * Canonical form of a workspace path: absolute, no trailing separator and case-folded on
 * Windows (the same rule `sameDirectory` in index.js uses). Cosmetic spellings of one directory
 * — `C:\A\B\`, `C:/A/B`, `C:\A\.\B`, different case — therefore hash to the SAME workspace ID.
 */
export function normalizeWorkspacePath(value) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (trimmed.length === 0) return '';
  const absolute = resolve(trimmed);
  const folded = process.platform === 'win32' ? absolute.toLowerCase() : absolute;
  return folded.length > 1 ? folded.replace(/[\\/]+$/u, '') : folded;
}

/** Display label only: the workspace directory name, with its original case. Never a key. */
export function workspaceDomainLabel(value) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (trimmed.length === 0) return '';
  const absolute = resolve(trimmed);
  return basename(absolute.length > 1 ? absolute.replace(/[\\/]+$/u, '') : absolute);
}

/**
 * Stable workspace identifier derived from the PATH, not from the directory name: `ws:` plus the
 * first 12 hex characters of SHA-256 over the normalized path. A rename changes the path (and so
 * the ID); a cosmetic variation of the same path does not.
 */
export function workspaceDomainId(value) {
  const normalized = normalizeWorkspacePath(value);
  if (normalized.length === 0) return UNGROUPED_DOMAIN;
  return `ws:${createHash('sha256').update(normalized).digest('hex').slice(0, 12)}`;
}

/** Accept a path, `{path, label}` or a getter result; the label is display-only. */
function workspaceOf(workspace) {
  if (typeof workspace === 'string') return { path: workspace, label: workspaceDomainLabel(workspace) };
  if (workspace === null || typeof workspace !== 'object') return { path: '', label: '' };
  const path = typeof workspace.path === 'string' ? workspace.path : '';
  const label = typeof workspace.label === 'string' && workspace.label.trim().length > 0
    ? workspace.label.trim()
    : workspaceDomainLabel(path);
  return { path, label };
}

/**
 * The scope that may WRITE or READ a domain: the current workspace ID, `config.defaultDomain`
 * and any explicitly allowed names (`config.allowedDomains` / `allowedDomains`). A caller domain
 * outside this set could name another workspace's group, so it is rejected instead of trusted.
 * `''` (legacy ungrouped) is not a named domain and belongs to no scope; readers keep it visible.
 */
export function domainScope({ config, workspace, allowedDomains } = {}) {
  const ws = workspaceOf(workspace);
  const id = workspaceDomainId(ws.path);
  const configured = normalizeTurnDomain(config?.defaultDomain);
  const allowed = [id, configured, ...normalizeDomainList(config?.allowedDomains), ...normalizeDomainList(allowedDomains)]
    .filter((domain) => domain !== UNGROUPED_DOMAIN)
    .filter((domain, index, all) => all.indexOf(domain) === index);
  return { id, label: ws.label, configured, allowed };
}

/**
 * P-69 (A plan, user-final 2026-11-07) — priority:
 *   explicit caller domain > `config.defaultDomain` > `ws:<hash>` > '' (default / ungrouped).
 * The text and any topic are NOT sources, and a workspace's animation / daily talk / technical
 * discussion all share its one domain: grouping is by workspace, never by topic. `source` names
 * the winning tier (`caller|config|workspace|default`) for `fastpath.domain`. An explicit domain
 * outside the scope's allow-list is rejected (`rejected`) and the turn falls back to its own
 * workspace ID, so it is never filed under — or read from — another scope's group.
 */
export function resolveTurnDomain({ requested, config, workspace, allowedDomains } = {}) {
  const scope = domainScope({ config, workspace, allowedDomains });
  const caller = normalizeTurnDomain(requested);
  if (caller !== UNGROUPED_DOMAIN) {
    // A caller naming its own workspace ID is still the caller's choice, and keeps the label.
    if (scope.allowed.includes(caller)) {
      return { domain: caller, label: caller === scope.id ? scope.label : '', source: 'caller' };
    }
    const fallback = scope.id === UNGROUPED_DOMAIN
      ? { domain: UNGROUPED_DOMAIN, label: '', source: 'default' }
      : { domain: scope.id, label: scope.label, source: 'workspace' };
    return { ...fallback, rejected: { domain: caller, reason: 'out-of-scope' } };
  }
  if (scope.configured !== UNGROUPED_DOMAIN) return { domain: scope.configured, label: '', source: 'config' };
  if (scope.id !== UNGROUPED_DOMAIN) return { domain: scope.id, label: scope.label, source: 'workspace' };
  return { domain: UNGROUPED_DOMAIN, label: '', source: 'default' };
}

/**
 * Group review entries by domain. '' (ungrouped) is a key like any other. Domains appear in
 * first-seen order and entries keep their input order, so the review list stays stable.
 */
export function groupByDomain(entries) {
  const groups = {};
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry === null || typeof entry !== 'object') continue;
    const domain = normalizeTurnDomain(entry.domain);
    if (!Object.hasOwn(groups, domain)) {
      Object.defineProperty(groups, domain, { value: [], enumerable: true, writable: true, configurable: true });
    }
    groups[domain].push(entry);
  }
  return groups;
}

/**
 * A persisted line as a review entry. P-69 legacy policy: lines written before the field existed
 * stay ungrouped ('') on read — they are never rewritten or credited to today's default domain,
 * because the domain at write time is unknown. `domainLabel` is display-only, so it defaults to ''.
 */
function normalizeEntry(entry) {
  if (entry === null || typeof entry !== 'object') return null;
  if (entry.role !== 'user' && entry.role !== 'assistant') return null;
  if (typeof entry.text !== 'string') return null;
  const domain = normalizeTurnDomain(entry.domain);
  const domainLabel = domain === UNGROUPED_DOMAIN
    ? ''
    : (typeof entry.domainLabel === 'string' ? entry.domainLabel.trim() : '');
  return { ...entry, domain, domainLabel };
}

function abortError() {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

/**
 * P-59: split `memory.brief()`'s block at its own relevance heading. The fixed/landmark part is
 * the protected fixed layer; the rest is the relevance (memory) layer. The two halves are pasted
 * back verbatim, so the request text is unchanged — only the budget that admits each half differs.
 */
const MEMORY_MATCHED_HEADING = '\n## 相关记忆（与本次话题相关，按匹配度排序）';

function splitBriefText(text) {
  const source = typeof text === 'string' ? text : '';
  const at = source.indexOf(MEMORY_MATCHED_HEADING);
  if (at < 0) return { fixed: source.trim(), memory: '' };
  return {
    fixed: source.slice(0, at).trim(),
    memory: source.slice(at + 1).trim(),
  };
}

/** Layer items from one rendered block: the first `## …` line is its kept heading. */
function blockLayer(text, { keep = 'head' } = {}) {
  const source = typeof text === 'string' ? text.trim() : '';
  if (source.length === 0) return { heading: '', items: [], separator: '\n', keep };
  const lines = source.split('\n');
  const heading = /^#{1,6}\s/u.test(lines[0]) ? lines.shift() : '';
  return { heading, items: lines, separator: '\n', keep };
}

// A waiting block is one or more generated sentences, kept in order. `lang` is the script bucket
// of its text: a merged block is spoken as ONE line (one language detection / one voice), so two
// sentences in different scripts cannot be merged — that switch is reported, never hidden.
const CJK_SCRIPT = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/u;
const LATIN_SCRIPT = /[A-Za-z]/u;

/** Script bucket of one block; '' (no letters) merges with anything. */
function scriptOf(text) {
  if (CJK_SCRIPT.test(text)) return 'cjk';
  if (LATIN_SCRIPT.test(text)) return 'latin';
  return '';
}

/** Can these two blocks be spoken as one line? */
const canMerge = (older, newer) => older.lang === '' || newer.lang === '' || older.lang === newer.lang;

/**
 * Cut one over-long sentence into chunks that each fit `maxLen`, preferring a clause boundary
 * (，、；：) near the cut. Joining the chunks reproduces `text` exactly: this splitter drops
 * nothing — only the turn's total speech budget may cut the tail, and that is counted elsewhere.
 */
export function splitSpeechText(text, maxLen) {
  const source = String(text ?? '');
  const size = Math.max(1, Math.floor(Number(maxLen) || 1));
  const chunks = [];
  let start = 0;
  while (source.length - start > size) {
    let cut = start + size;
    for (let index = cut; index > start; index -= 1) {
      if (SPEECH_SPLIT_PUNCT.includes(source[index - 1])) {
        cut = index;
        break;
      }
    }
    // A fixed-length cut must not split a surrogate pair: a lone half is not the author's character.
    const tail = source.charCodeAt(cut - 1);
    const next = source.charCodeAt(cut);
    if (cut - start > 1 && tail >= 0xd800 && tail <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) cut -= 1;
    chunks.push(source.slice(start, cut));
    start = cut;
  }
  if (start < source.length) chunks.push(source.slice(start));
  return chunks;
}

/**
 * P-58: ordered, bounded hand-off between the model read loop and playback.
 *
 * `push()` never waits for the consumer, so the stream keeps being read while a sentence is
 * synthesized / played. A full queue is not a reason to lose speech — speech text is content,
 * not a realtime frame — so its two OLDEST waiting blocks are merged into one (text concatenated,
 * order kept). A merge is refused only when the two blocks cannot be spoken as one line (a
 * script / language switch); the queue then drops the oldest block and REPORTS it through
 * `stats().droppedSentences`, so the turn returns `partial:true` instead of silently losing text.
 * A single sentence longer than `maxBlockChars` is split (never cut) into chunks that are spoken
 * in order; the whole turn still shares `maxTotalChars`, and only text past that budget is
 * truncated (recorded in `stats().truncatedChars`, which also makes the turn `partial`).
 * `close()` clears everything that has not started (the block in flight is left alone);
 * `drain()` settles once nothing is pending or running.
 */
function createSentenceQueue({
  limit,
  maxBlockChars = BLOCK_MAX_CHARS,
  maxTotalChars = DEFAULT_SPEECH_MAX_CHARS,
  depthThrottleMs,
  now,
  run,
  onSplit,
  onMerge,
  onTruncate,
  onDrop,
  onDepth,
}) {
  const pending = [];
  const idleWaiters = [];
  let running = false;
  let closed = false;
  let lastDepthAt = Number.NEGATIVE_INFINITY;
  let firstError = null;
  // Content the turn has to report instead of hiding: nothing leaves the queue without a count.
  let truncatedChars = 0;
  let droppedSentences = 0;
  // Speech text admitted to playback this turn; it is what the total speech budget caps.
  let usedChars = 0;

  const report = (callback, ...args) => {
    try {
      callback?.(...args);
    } catch {
      /* diagnostics must never fail a turn */
    }
  };

  const publishDepth = (force = false) => {
    const at = now();
    if (!force && at - lastDepthAt < depthThrottleMs) return;
    lastDepthAt = at;
    report(onDepth, pending.length);
  };

  const settleIdle = () => {
    if (running || pending.length > 0) return;
    while (idleWaiters.length > 0) idleWaiters.shift()();
  };

  const pump = () => {
    if (running || closed) return;
    running = true;
    void (async () => {
      while (!closed && pending.length > 0) {
        const block = pending.shift();
        publishDepth();
        try {
          await run(block.text);
        } catch (error) {
          // A failed sentence must not wedge the queue; the turn still reports the first error.
          if (firstError === null) firstError = error;
        }
      }
      running = false;
      settleIdle();
    })();
  };

  /** Merge two adjacent waiting blocks: text order and every sentence survive. */
  const mergeBlocks = (older, newer) => {
    const merged = {
      text: older.text + newer.text,
      count: older.count + newer.count,
      lang: older.lang === '' ? newer.lang : older.lang,
    };
    report(onMerge, merged.count);
    return merged;
  };

  /**
   * A generated sentence as one or more blocks: an over-long sentence is split at punctuation /
   * fixed length, so its whole text still reaches playback. The turn's total budget is charged as
   * chunks are admitted; the tail that no longer fits is counted, never silently skipped.
   */
  const makeBlocks = (sentence) => {
    const text = String(sentence);
    if (text.length === 0) return [];
    const lang = scriptOf(text);
    const chunkLimit = Math.max(1, Math.min(maxBlockChars, maxTotalChars));
    const chunks = splitSpeechText(text, chunkLimit);
    if (chunks.length > 1) report(onSplit, chunks.length);
    const blocks = [];
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      if (usedChars + chunk.length > maxTotalChars) {
        const removed = text.length - chunks.slice(0, index).join('').length;
        truncatedChars += removed;
        report(onTruncate, removed);
        break;
      }
      usedChars += chunk.length;
      blocks.push({ text: chunk, count: 1, lang });
    }
    return blocks;
  };

  return {
    push(sentence) {
      if (closed) return;
      // One pushed sentence may become several chunks; each keeps its place in the play order.
      for (let block of makeBlocks(sentence)) {
        while (pending.length >= limit) {
          const older = pending.shift();
          const next = pending[0];
          if (next !== undefined && canMerge(older, next)) {
            pending[0] = mergeBlocks(older, next);
          } else if (next === undefined && canMerge(older, block)) {
            // limit === 1: the new sentence is the only thing after it, so appending keeps order.
            block = mergeBlocks(older, block);
          } else {
            // A language switch is the one merge that would speak two lines as one: report the loss.
            droppedSentences += older.count;
            report(onDrop, older.count, 'language-switch');
          }
        }
        pending.push(block);
      }
      publishDepth();
      pump();
    },
    close(reason = 'closed') {
      if (closed) return;
      closed = true;
      const lost = pending.reduce((sum, block) => sum + block.count, 0);
      pending.length = 0;
      if (lost > 0) {
        droppedSentences += lost;
        report(onDrop, lost, reason);
      }
      publishDepth(true);
      settleIdle();
    },
    stats() {
      return { truncatedChars, droppedSentences };
    },
    drain() {
      if (!running && pending.length === 0) return Promise.resolve(firstError);
      return new Promise((resolve) => idleWaiters.push(() => resolve(firstError)));
    },
  };
}

/** Private-reasoning frames: counted for diagnostics, never appended to the assist body. */
const ASSIST_REASONING_FRAME = /^(reasoning|thinking|thought|analysis|redacted)/u;

/** Body text of one stream chunk across the delta shapes the adapters use. */
function assistantChunkText(chunk) {
  if (typeof chunk === 'string') return chunk;
  for (const key of ['text', 'delta', 'content']) {
    if (typeof chunk?.[key] === 'string') return chunk[key];
  }
  return '';
}

/** Split complete sentences out of a streaming buffer; the tail stays for the next chunk. */
export function splitSentences(buffer, { flush = false, maxLen = 60 } = {}) {
  const parts = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    const ch = buffer[index];
    const isEnd = SENTENCE_END.includes(ch) || ch === '\n';
    const isLongClause = index - start >= maxLen && CLAUSE_END.includes(ch);
    if (!isEnd && !isLongClause) continue;
    const sentence = buffer.slice(start, index + 1).trim();
    if (sentence.length > 0) parts.push(sentence);
    start = index + 1;
  }
  const tail = buffer.slice(start);
  if (flush && tail.trim().length > 0) parts.push(tail.trim());
  return { parts, rest: flush ? '' : tail };
}

/**
 * The ONE reasoning control every auxiliary (non-chat) task sends. It lives beside the request
 * builders so the lightweight channel (`assist`) and a direct task stream (the spoken rewrite)
 * cannot drift apart again: `'off'` makes the DeepSeek adapter serialize
 * `thinking: {type: 'disabled'}`, so the rewrite cannot re-introduce the reasoning wait.
 */
export const AUXILIARY_REASONING_EFFORT = 'off';

/**
 * Build the GenerateOptions of one direct auxiliary request. `reasoningEffort: null` means the
 * route proved it has no `off` effort, so the control is omitted instead of being refused.
 */
export function auxiliaryRequestOptions({
  provider,
  model,
  system,
  messages,
  maxTokens,
  signal,
  reasoningEffort = AUXILIARY_REASONING_EFFORT,
} = {}) {
  return {
    provider,
    model,
    system,
    messages,
    maxTokens,
    signal,
    ...reasoningEffort === null || reasoningEffort === undefined ? {} : { reasoningEffort },
  };
}

export class FastPath {
  /**
   * @param {{root: string, getLlm: () => any, getSelection: () => any, persona: any,
   *          memory: any, log: any, config?: any, workspace?: string|{path: string, label?: string}|(() => any),
   *          now?: () => number}} options
   *   P-69 (A): `workspace` is the session's workspace — a path, `{path, label}`, or a getter
   *   returning either. Its path decides the stable `ws:<hash>` domain; its directory name is
   *   only the display label. A missing workspace leaves the turn in the default (ungrouped) bucket.
   */
  constructor({ root, getLlm, getSelection, persona, memory, log, config = {}, workspace = null, now = () => Date.now() }) {
    this.root = root;
    this.getLlm = getLlm;
    this.getSelection = getSelection;
    this.persona = persona;
    this.memory = memory;
    this.log = log;
    this.config = config;
    this.workspace = workspace;
    this.lastDomainEvent = null;
    this.lastContextScopeEvent = null;
    this.now = typeof now === 'function' ? now : () => Date.now();
    // P-51: one throttled downgrade reporter per fast path. A refusal is visibility, not failure.
    this.reportReasoningDowngraded = createReasoningDowngradeReporter({
      emit: (type, payload) => this.emitQuiet(type, payload),
      now: this.now,
    });
    this.file = join(root, 'data', 'conversation.jsonl');
    this.history = this.loadHistory();
    this.busy = false;
  }

  /** The live workspace scope (path + display label); a failing getter means "unknown". */
  currentWorkspace() {
    try {
      const value = typeof this.workspace === 'function' ? this.workspace() : this.workspace;
      return value ?? null;
    } catch {
      return null;
    }
  }

  loadHistory() {
    try {
      const lines = readFileSync(this.file, 'utf8').split('\n').filter(Boolean);
      const turns = [];
      for (const line of lines.slice(-60)) {
        try {
          const entry = JSON.parse(line);
          if (entry && (entry.role === 'user' || entry.role === 'assistant') && typeof entry.text === 'string') {
            const domain = normalizeTurnDomain(entry.domain);
            const domainLabel = domain === UNGROUPED_DOMAIN
              ? ''
              : (typeof entry.domainLabel === 'string' ? entry.domainLabel.trim() : '');
            turns.push({ role: entry.role, text: entry.text, ts: entry.ts, domain, domainLabel });
          }
        } catch {
          /* skip a torn write */
        }
      }
      // The store keeps the last MAX_HISTORY_TURNS lines across domains; the prompt only reads
      // the current domain's rows out of that window (see systemPrompt).
      return turns.slice(-MAX_HISTORY_TURNS);
    } catch {
      return [];
    }
  }

  append(role, text, meta = {}) {
    // New fields are additive: the conversation line keeps ts/role/text/... and gains
    // `domain` (the stable ID) and `domainLabel` (the display name; '' when the domain has none).
    const { domain: rawDomain, domainLabel: rawLabel, ...rest } = meta ?? {};
    const domain = normalizeTurnDomain(rawDomain);
    const domainLabel = domain === UNGROUPED_DOMAIN || typeof rawLabel !== 'string' ? '' : rawLabel.trim();
    const entry = { ts: Date.now(), role, text, ...rest, domain, domainLabel };
    try {
      mkdirSync(join(this.root, 'data'), { recursive: true });
      appendFileSync(this.file, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch {
      /* history is a convenience; never fail a reply for it */
    }
    this.history.push({ role, text, ts: entry.ts, domain, domainLabel });
    // The store keeps the newest MAX_HISTORY_TURNS lines across domains; the prompt reads only
    // this turn's domain out of that window (see systemPrompt), so nothing is duplicated.
    while (this.history.length > MAX_HISTORY_TURNS) this.history.shift();
  }

  /** Every persisted turn (for the review dialog), newest last. Legacy lines stay ungrouped (''). */
  readAll() {
    try {
      return readFileSync(this.file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          try {
            return normalizeEntry(JSON.parse(line));
          } catch {
            return null;
          }
        })
        .filter((entry) => entry !== null);
    } catch {
      return [];
    }
  }

  /** Filtered review list, newest first. */
  list({ query = '', limit = 100 } = {}) {
    const needle = String(query).trim().toLowerCase();
    const items = this.readAll().filter(
      (entry) => needle.length === 0 || entry.text.toLowerCase().includes(needle),
    );
    return items
      .slice(-Math.max(1, Math.min(500, Number(limit) || 100)))
      .reverse()
      .map((entry) => ({
        ts: Number(entry.ts ?? 0),
        role: entry.role,
        text: entry.text,
        provider: typeof entry.provider === 'string' ? entry.provider : '',
        model: typeof entry.model === 'string' ? entry.model : '',
        ms: Number(entry.ms ?? 0),
        domain: entry.domain,
        domainLabel: entry.domainLabel ?? '',
      }));
  }

  /** Delete one turn by (ts, role); rewrites the JSONL. Returns how many lines were removed. */
  remove({ ts, role } = {}) {
    const all = this.readAll();
    const kept = all.filter((entry) => !(entry.ts === ts && entry.role === role));
    if (kept.length === all.length) return 0;
    try {
      writeFileSync(this.file, kept.map((entry) => JSON.stringify(entry)).join('\n') + (kept.length > 0 ? '\n' : ''), 'utf8');
    } catch {
      return 0;
    }
    this.history = this.history.filter((entry) => !(entry.ts === ts && entry.role === role));
    return all.length - kept.length;
  }

  /** Current provider/model from the Harness default-model service. */
  selection() {
    try {
      const service = this.getSelection?.();
      const value = service?.currentSelection?.() ?? null;
      const provider = value?.provider ?? value?.route?.provider ?? '';
      const model = value?.model ?? value?.route?.model ?? '';
      return { provider: String(provider), model: String(model) };
    } catch {
      return { provider: '', model: '' };
    }
  }

  /**
   * P-51: a main chat/tool request's effort is decided PER REQUEST. The caller's explicit value
   * wins; otherwise the configured default applies; with neither, the control is omitted so the
   * model's own default is used. Auxiliary tasks never consult this (they pin their own effort).
   */
  requestedReasoningEffort(explicit = undefined) {
    const requestValue = normalizeReasoningEffort(explicit);
    if (requestValue !== null) return requestValue;
    return normalizeReasoningEffort(this.config?.reasoningEffort);
  }

  available() {
    try {
      const service = this.getLlm?.();
      if (service === undefined || service === null) return false;
      return typeof service.stream === 'function';
    } catch {
      return false;
    }
  }

  /** Fire-and-forget diagnostic event: queue telemetry must never slow down or fail a turn. */
  emitQuiet(type, payload) {
    try {
      const pending = this.log?.emit?.(type, payload);
      if (pending !== null && pending !== undefined && typeof pending.catch === 'function') {
        pending.catch(() => {});
      }
    } catch {
      /* diagnostics are best-effort */
    }
  }

  /** P-69: report one rejected explicit domain before the turn falls back to its workspace ID. */
  emitDomainRejected(rejected) {
    this.emitQuiet('fastpath.domain.rejected', { domain: rejected.domain, reason: rejected.reason });
  }

  /** P-69: report the resolved domain + label, throttled for an unchanged domain (60 s). */
  emitTurnDomain({ domain, label, source }) {
    const now = this.now();
    const last = this.lastDomainEvent;
    if (last !== null && last.domain === domain && now - last.at < DOMAIN_EVENT_THROTTLE_MS) return;
    this.lastDomainEvent = { domain, at: now };
    this.emitQuiet('fastpath.domain', { domain, label, source });
  }

  /**
   * P2: report the scope a prompt was built from — `rowsIncluded` are this scope's rows placed in
   * the recent-dialogue block, `rowsExcluded` the rows of the stored window kept out of it.
   * Throttled for an unchanged scope (60 s); a changed scope is reported immediately.
   */
  emitContextScope({ domains, rowsIncluded, rowsExcluded }) {
    const key = domains.join('\u0000');
    const now = this.now();
    const last = this.lastContextScopeEvent;
    if (last !== null && last.key === key && now - last.at < CONTEXT_SCOPE_EVENT_THROTTLE_MS) return;
    this.lastContextScopeEvent = { key, at: now };
    const domain = domains.length === 1 ? domains[0] : [...domains];
    this.emitQuiet('fastpath.context.scope', { domain, rowsIncluded, rowsExcluded });
  }

  /**
   * Persona + profile + relevant memory + recent turns, hard-capped.
   *
   * P2: the recent-dialogue block is SCOPED. `domain` is the turn's resolved domain (or an
   * explicit allow-list) — the same allow set the write path validated. Omitted, the instance's
   * own default domain (config > workspace > ungrouped) is used. `''` (ungrouped) is a scope of
   * its own: a named domain never reads ungrouped lines and ungrouped never reads a named one, so
   * one workspace's dialogue cannot pollute another's request.
   */
  systemPrompt(utterance, { domain, lane = 'fastpath' } = {}) {
    const domains = domain === undefined
      ? [resolveTurnDomain({ config: this.config, workspace: this.currentWorkspace() }).domain]
      : promptDomainScope(domain);
    const personaText = typeof this.persona?.read === 'function' ? this.persona.read('agent') : '';
    const profile = typeof this.persona?.read === 'function' ? this.persona.read('user') : '';
    let brief = null;
    try {
      if (this.memory !== null && this.memory !== undefined) {
        brief = this.memory.brief({ query: utterance, fixedBudget: 400, matchBudget: 500, limit: 4 });
      }
    } catch {
      brief = null;
    }
    const memoryParts = splitBriefText(brief?.text ?? '');
    // Only rows of this scope may enter the prompt: the window is the stored cap, the block is the
    // subset whose stored domain is inside the same allow set (legacy/missing = ungrouped).
    const window = this.history.slice(-MAX_HISTORY_TURNS);
    const scoped = window.filter((turn) => domains.includes(normalizeTurnDomain(turn.domain)));
    const history = scoped.map((turn) => `${turn.role === 'user' ? '用户' : '你'}：${turn.text}`);
    this.emitContextScope({ domains, rowsIncluded: scoped.length, rowsExcluded: window.length - scoped.length });
    const personaBlocks = [
      '你是运行在用户 Windows 电脑上的伴生助手。用中文回答，口语化、简短直接；第一句不超过 15 个字；没有工具，不要假装能操作电脑。',
      personaText.trim().length > 0 ? `## 人设\n${personaText.trim()}` : '',
      profile.trim().length > 0 ? `## 用户画像\n${profile.trim()}` : '',
    ].filter((part) => part.length > 0);
    const plan = assembleLayerPlan({
      lane,
      budget: resolveContextBudget(
        this.config?.contextBudgets ? { contextBudgets: this.config.contextBudgets } : null,
        lane === 'fastpath' ? 'fastpath' : lane,
      ),
      layers: {
        // Protected: persona and its functional constraints are never trimmed.
        persona: { items: personaBlocks, separator: '\n\n' },
        fixed: {
          heading: memoryParts.fixed.length > 0 || memoryParts.memory.length > 0 ? '## 相关记忆' : '',
          items: memoryParts.fixed.length > 0 ? [memoryParts.fixed] : [],
          separator: '\n',
        },
        memory: blockLayer(memoryParts.memory),
        recent: {
          heading: history.length > 0 ? '## 最近对话' : '',
          items: history,
          separator: '\n',
          keep: 'tail',
        },
        ephemeral: { items: [], separator: '\n' },
      },
    });
    // P-59: one debug row per fast-path prompt. Counts only — no utterance, persona, memory or
    // dialogue text ever enters the event.
    this.emitQuiet('context.budget', {
      level: 'debug',
      lane: plan.lane,
      layers: contextLayerStats(plan),
      totalChars: plan.totalChars,
      truncated: plan.truncated,
      totalBudget: plan.totalBudget,
      protectedOverflow: plan.protectedOverflow,
    });
    return plan.text;
  }

  /**
   * Ask the model once.
   *
   * P-58: sentences are pushed into a bounded queue and `onSentence` is run by that queue, so the
   * model stream keeps being read while a sentence is synthesized / played. The 45 s budget below
   * covers generation only: it is cleared before the queue is awaited, and it never aborts a
   * sentence that already started. `askStream` still resolves after the queue drained, which keeps
   * the caller's turn ownership (one voice at a time) unchanged. A full queue merges waiting
   * sentences, an over-long sentence is split instead of cut, and the turn's shared speech budget
   * only cuts what lies past it; every lost sentence or character is reported
   * (`partial`, `droppedSentences`, `truncatedChars`) instead of the body looking complete while
   * speech text was silently skipped.
   * A retryable failure (5xx, "too busy", a network/abort error) is retried ONCE with a jittered
   * 800 ms backoff, reusing the same turn: the user line is appended once and the retry repeats
   * the model request, not the history. The retry only happens while NOTHING has been handed to
   * playback — repeating a sentence the user already heard would be worse than the failure.
   * The retry does NOT get a fresh budget: one deadline is fixed before the first attempt and
   * every attempt (and the backoff wait itself) spends what is left of it. When the remainder can
   * no longer hold a usable attempt the retry is abandoned and the turn fails as
   * `budget-exhausted` — a turn can never stretch its generation budget by the retry factor.
   * @param {string} utterance
   * @param {{signal?: AbortSignal, onSentence?: (sentence: string) => Promise<void>|void,
   *          domain?: string, turn?: number}} options `turn` is the caller's turn identity; it is
   *   carried unchanged by the retry and by the failure the caller reports.
   */
  async askStream(utterance, {
    signal, onSentence, domain, turn: turnId = 0, reasoningEffort: explicitReasoningEffort = undefined,
  } = {}) {
    if (this.busy) throw new Error('快路正在回答上一句，请稍等');
    if (!this.available()) throw new Error('DSH llm 服务不可用（插件未拿到 llm）');
    const { provider, model } = this.selection();
    if (provider.length === 0 || model.length === 0) throw new Error('没有可用的默认模型');

    const service = this.getLlm();
    // P-69 (A): caller > config.defaultDomain > ws:<hash of the workspace path> > '' (default).
    // An out-of-scope caller domain is rejected here; the turn still falls back to its workspace
    // ID, so nothing is ever written into — or read from — another scope's group.
    const turn = resolveTurnDomain({
      requested: domain,
      config: this.config,
      workspace: this.currentWorkspace(),
    });
    if (turn.rejected !== undefined) this.emitDomainRejected(turn.rejected);
    this.emitTurnDomain(turn);
    const timeoutMs = nonNegativeNumber(this.config?.fastpathStreamTimeoutMs, STREAM_TIMEOUT_MS);
    const queueLimit = Math.max(1, Math.floor(positiveNumber(this.config?.fastpathSentenceQueueLimit, SENTENCE_QUEUE_LIMIT)));
    const depthThrottleMs = nonNegativeNumber(this.config?.fastpathQueueDepthThrottleMs, QUEUE_DEPTH_THROTTLE_MS);
    // The one speech cap every lane shares; `0` (or Infinity) means "speak it all", as elsewhere.
    const speechBudget = resolveSpeechBudget({ maxChars: this.config?.voice?.speechMaxChars });
    const retryBaseMs = positiveNumber(this.config?.fastpathRetryDelayMs, RETRY_DELAY_MS);
    const retryJitter = nonNegativeNumber(this.config?.fastpathRetryJitter, RETRY_JITTER_RATIO);
    const turnIdValue = Number.isInteger(turnId) && turnId >= 0 ? turnId : 0;
    const startedAt = Date.now();
    this.busy = true;
    try {
      // Build history from previous turns only: the current utterance reaches the model once,
      // through `messages` below, and is persisted right after the prompt snapshot is taken. The
      // snapshot is scoped to the domain resolved above (including a post-rejection fallback) and
      // is deliberately built ONCE, so a retry reuses the same turn instead of growing history.
      const system = this.systemPrompt(utterance, { domain: turn.domain });
      this.append('user', utterance, { domain: turn.domain, domainLabel: turn.label });
      // ONE generation deadline for the whole turn, fixed before the retry loop: a retry gets
      // `deadlineAt - now()`, never a fresh `timeoutMs`. The backoff wait is inside this window
      // too (the remainder is measured after it), while playback stays outside it.
      const deadlineAt = Date.now() + timeoutMs;
      const remainingBudgetMs = () => Math.max(0, deadlineAt - Date.now());
      // P-51: the effort is turn-local state, never a global switch. A provider refusal downgrades
      // this turn to "no control" exactly once; a later retry never re-introduces it.
      let activeReasoning = this.requestedReasoningEffort(explicitReasoningEffort);
      let reasoningDowngraded = false;
      let retry = null;
      for (let attempt = 1; ; attempt += 1) {
        // The first attempt owns the whole window; every later one only what the shared deadline
        // still allows. Below MIN_ATTEMPT_MS there is nothing to run: fail with a budget verdict
        // instead of opening a stream whose own timer would fire first.
        const remainingMs = attempt === 1 ? timeoutMs : remainingBudgetMs();
        if (remainingMs < MIN_ATTEMPT_MS) {
          throw budgetExhaustedError({
            attempt,
            budgetMs: timeoutMs,
            remainingMs,
            turn: turnIdValue,
            lastReason: retry?.reason ?? '',
            delayMs: retry?.delayMs ?? 0,
          });
        }
        if (retry !== null) {
          // Announced only when the attempt is really going to run, so `remainingMs` is the window
          // that attempt gets — the truthful number after the backoff was charged.
          this.emitQuiet('fastpath.retry', {
            attempt,
            reason: retry.reason,
            delayMs: retry.delayMs,
            remainingMs,
            budgetMs: timeoutMs,
            turn: turnIdValue,
          });
        }
        try {
          return await this.runFastAttempt({
            utterance,
            system,
            service,
            provider,
            model,
            turn,
            timeoutMs: remainingMs,
            budgetMs: timeoutMs,
            queueLimit,
            depthThrottleMs,
            speechBudget,
            signal,
            onSentence,
            startedAt,
            attempt,
            reasoningEffort: activeReasoning,
          });
        } catch (rawError) {
          // Keep a non-Error throw's status/code: the retry classifier reads them.
          const error = rawError instanceof Error
            ? rawError
            : Object.assign(new Error(rawError?.message ?? String(rawError)), rawError);
          const cancelled = signal !== undefined && signal.aborted === true;
          const spoken = Number(error.fastpathSpoken) || 0;
          const failure = classifyFastpathFailure(error, {
            cancelled,
            timedOut: error.fastpathTimedOut === true,
          });
          // The user's own barge-in / stop is not a failure: no retry, no visible prompt.
          if (cancelled) throw abortError();
          // P-51: a provider refusing the effort is not a failure. Retry ONCE without the control
          // (same turn/deadline, nothing spoken yet) and report the downgrade; the flag keeps a
          // second refusal from looping.
          if (
            !reasoningDowngraded
            && attempt < MAX_ATTEMPTS
            && spoken === 0
            && activeReasoning !== null
            && isUnsupportedReasoningEffort(error)
          ) {
            this.reportReasoningDowngraded({ requested: activeReasoning, fallback: 'default', reason: 'unsupported' });
            reasoningDowngraded = true;
            activeReasoning = null;
            continue;
          }
          // One retry, and only while nothing has been heard: a repeat would be worse than a miss.
          const canRetry = failure.retryable && attempt < MAX_ATTEMPTS && spoken === 0;
          if (!canRetry) {
            error.fastpathFailure = {
              ...failure,
              attempts: attempt,
              spoken,
              turn: turnIdValue,
              budgetMs: timeoutMs,
              remainingMs: remainingBudgetMs(),
            };
            throw error;
          }
          const delayMs = fastpathRetryDelayMs({ base: retryBaseMs, jitter: retryJitter });
          // The backoff is charged to the SAME budget: when the wait plus a minimally useful
          // attempt no longer fits, the retry is abandoned and the turn fails as budget-exhausted.
          const afterWaitMs = remainingBudgetMs() - delayMs;
          if (afterWaitMs < MIN_ATTEMPT_MS) {
            throw budgetExhaustedError({
              attempt,
              budgetMs: timeoutMs,
              remainingMs: afterWaitMs,
              turn: turnIdValue,
              lastReason: failure.reason,
              delayMs,
            });
          }
          retry = { reason: failure.reason, delayMs };
          await waitForRetry(delayMs, signal);
        }
      }
    } finally {
      this.busy = false;
    }
  }

  /**
   * One model attempt inside one fast-path turn. The caller owns `busy`, history, the shared
   * generation deadline and the retry decision; this method owns only the stream, the sentence
   * queue, THIS attempt's window (`timeoutMs`) and the playback drain, so a retry can start from a
   * clean queue with the same prompt and whatever budget the deadline still allows. `budgetMs` is
   * the turn's whole budget, carried for the timeout diagnostics only.
   */
  async runFastAttempt({
    utterance, system, service, provider, model, turn, timeoutMs, budgetMs, queueLimit,
    depthThrottleMs, speechBudget, signal, onSentence, startedAt, attempt, reasoningEffort = null,
  }) {
    const controller = new AbortController();
    let timedOut = false;
    let generationDone = false;
    // Sentences handed to playback (or about to be): a retry is only legal while this is 0.
    let spoken = 0;
    let queue = null;
    let onExternalAbort = null;
    const timer = setTimeout(() => {
      // The stream may have finished between the timer being queued and this callback running.
      if (generationDone) return;
      timedOut = true;
      // `phase` stays 'generate': playback is deliberately outside the budget, so this timer can
      // only expire while generation is running ('play' remains a reserved value of the event).
      // `ms` is THIS attempt's window, `budgetMs` the turn's whole generation budget, so a short
      // retry window (what was left of the deadline) is never mistaken for a small configuration.
      this.emitQuiet('fastpath.stream.timeout', { phase: 'generate', ms: timeoutMs, budgetMs, attempt });
      controller.abort();
    }, timeoutMs);
    const merged = signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal]);
    try {
      let text = '';
      let finish = null;
      const stream = service.stream({
        provider,
        model,
        system,
        messages: [{ role: 'user', content: [{ type: 'text', text: utterance }] }],
        maxTokens: Number(this.config?.fastpathMaxTokens ?? 512),
        signal: merged,
        ...reasoningEffort === null ? {} : { reasoningEffort },
      });
      if (typeof onSentence === 'function') {
        queue = createSentenceQueue({
          limit: queueLimit,
          maxTotalChars: speechBudget.unbounded ? Infinity : speechBudget.maxChars,
          depthThrottleMs,
          now: this.now,
          run: async (sentence) => {
            // Counted before the hand-off: a sentence that may already be audible must never be
            // repeated by a retry, even when the playback call itself then throws.
            spoken += 1;
            await onSentence(sentence);
          },
          onSplit: (chunks) => this.emitQuiet('fastpath.queue.split', { chunks }),
          onMerge: (count) => this.emitQuiet('fastpath.queue.merged', { count }),
          onTruncate: (chars) => this.emitQuiet('fastpath.queue.truncated', { chars, partial: true }),
          onDrop: (count, reason) => this.emitQuiet('fastpath.queue.dropped', { count, reason }),
          onDepth: (depth) => this.emitQuiet('fastpath.queue.depth', { depth }),
        });
        if (signal !== undefined) {
          // New turn / barge-in: drop every sentence that has not started and stop the read loop.
          // The sentence in flight is left to the caller's own abort signal; played audio is
          // never rewound.
          onExternalAbort = () => queue.close('barge-in');
          if (signal.aborted) onExternalAbort();
          else signal.addEventListener('abort', onExternalAbort, { once: true });
        }
      }
      let pending = '';
      const emitSentences = async (flush) => {
        const { parts, rest } = splitSentences(pending, { flush });
        pending = rest;
        for (const sentence of parts) {
          if (merged.aborted) throw abortError();
          queue.push(sentence);
        }
      };
      for await (const chunk of stream) {
        if (merged.aborted) throw abortError();
        if (chunk.type === 'text-delta') {
          text += chunk.text;
          if (queue !== null) {
            pending += chunk.text;
            await emitSentences(false);
          }
        } else if (chunk.type === 'finish') finish = chunk.reason;
      }
      if (queue !== null) await emitSentences(true);
      // Generation (including the flushed tail) is over: stop the budget BEFORE waiting for
      // playback, so a long reply can never be timed out by its own playback duration.
      generationDone = true;
      clearTimeout(timer);
      if (finish !== null && finish.kind === 'error') throw modelFailure(finish.failure);
      if ((finish !== null && finish.kind === 'aborted') || merged.aborted) {
        throw abortError();
      }
      const reply = text.trim();
      if (reply.length === 0) throw new Error('模型没有返回文本');

      // Playback is outside the timeout. `drain()` settles when every queued sentence finished;
      // it is the one place the turn still waits for audio, so single-voice ownership holds.
      const queueError = queue === null ? null : await queue.drain();
      if (merged.aborted) throw abortError();
      if (queueError !== null) throw queueError;
      const ms = Date.now() - startedAt;
      // The queue is the only place speech text can be lost: report it instead of hiding it.
      const { truncatedChars, droppedSentences } = queue === null ? ZERO_QUEUE_STATS : queue.stats();
      this.append('assistant', reply, { provider, model, ms, domain: turn.domain, domainLabel: turn.label });
      await this.log.emit('fastpath.turn', {
        provider,
        model,
        chars: reply.length,
        ms,
        attempts: attempt,
      });
      return {
        reply,
        provider,
        model,
        ms,
        attempts: attempt,
        // The body is complete; `partial` speaks only about the audio: a sentence the queue could
        // not keep (`droppedSentences`) or speech text cut by the total budget (`truncatedChars`).
        partial: droppedSentences > 0 || truncatedChars > 0,
        droppedSentences,
        truncatedChars,
      };
    } catch (rawError) {
      const error = rawError instanceof Error
        ? rawError
        : Object.assign(new Error(rawError?.message ?? String(rawError)), rawError);
      error.fastpathSpoken = spoken;
      if (timedOut) {
        // Never cut a sentence that is already playing: play out what was generated, then report
        // the timeout. A barge-in during that drain still wins over the timeout error.
        if (queue !== null) await queue.drain();
        if (signal !== undefined && signal.aborted) throw abortError();
        const timeoutError = new Error(`模型生成超时（本次尝试 ${timeoutMs} 毫秒，本轮预算 ${budgetMs} 毫秒）`);
        timeoutError.fastpathTimedOut = true;
        timeoutError.fastpathSpoken = spoken;
        throw timeoutError;
      }
      if (queue !== null) queue.close();
      throw error;
    } finally {
      clearTimeout(timer);
      if (queue !== null) {
        if (signal !== undefined && onExternalAbort !== null) {
          signal.removeEventListener('abort', onExternalAbort);
        }
        queue.close();
      }
    }
  }

  /**
   * The `assist` purpose: one call over the SAME selected model, the SAME `llm` service and the
   * SAME context assembly as chat (`systemPrompt`: persona, profile, relevant memory and recent
   * dialogue, scoped to this instance's current domain). Only the task constraints are appended.
   * It never writes chat history or memory and never hands deltas to a sentence callback, so it
   * cannot start chat playback.
   *
   * `reasoningEffort` is the one per-request reasoning control the Harness contract exposes
   * (`GenerateOptions.reasoningEffort`); `'off'` makes the DeepSeek adapter serialize
   * `thinking: {type: 'disabled'}`. Callers pass `null` only after the capability declaration
   * proved the model has no `off` effort.
   */
  async assist({
    task = 'assist',
    system = '',
    user = '',
    maxTokens = 512,
    signal = undefined,
    reasoningEffort = AUXILIARY_REASONING_EFFORT,
    instruction = '',
  } = {}) {
    if (!this.available()) throw new Error('DSH llm 服务不可用（插件未拿到 llm）');
    const { provider, model } = this.selection();
    if (provider.length === 0 || model.length === 0) throw new Error('没有可用的默认模型');
    // Identical context assembly to the chat purpose; the task prompt comes after it so the last
    // instruction the model reads is the task's own constraint.
    const context = this.systemPrompt(String(user ?? ''));
    const systemText = [context, String(system ?? ''), String(instruction ?? '')]
      .filter((part) => part.trim().length > 0)
      .join('\n\n');
    const service = this.getLlm();
    const startedAt = this.now();
    let text = '';
    let reasoningChars = 0;
    let firstDeltaMs = null;
    let finishKind = '';
    let finish = null;
    let truncated = false;
    const options = auxiliaryRequestOptions({
      provider,
      model,
      system: systemText,
      messages: [{ role: 'user', content: [{ type: 'text', text: String(user ?? '') }] }],
      maxTokens,
      signal,
      reasoningEffort,
    });
    for await (const chunk of service.stream(options)) {
      if (typeof chunk === 'string') {
        text += chunk;
        if (firstDeltaMs === null) firstDeltaMs = Math.max(0, this.now() - startedAt);
        continue;
      }
      const type = String(chunk?.type ?? '').toLowerCase();
      if (ASSIST_REASONING_FRAME.test(type)) {
        reasoningChars += assistantChunkText(chunk).length;
        continue;
      }
      if (chunk?.truncated === true || chunk?.finish?.truncated === true) truncated = true;
      if (type === 'finish') {
        const reason = chunk?.reason;
        finishKind = String(reason?.kind ?? reason ?? '');
        if (reason?.failure !== undefined && reason.failure !== null) finish = reason.failure;
        if (finishKind === 'max-tokens') truncated = true;
        continue;
      }
      const delta = assistantChunkText(chunk);
      if (delta.length === 0) continue;
      text += delta;
      if (firstDeltaMs === null) firstDeltaMs = Math.max(0, this.now() - startedAt);
    }
    return {
      task,
      text,
      provider,
      model,
      // The exact context block this request carried, so a caller can enforce a task boundary
      // (a translation that also translated the context is rejected, never cached).
      context,
      contextChars: [...context].length,
      reasoning: reasoningEffort === null || reasoningEffort === undefined ? 'unsupported' : String(reasoningEffort),
      reasoningChars,
      firstDeltaMs,
      doneMs: Math.max(0, this.now() - startedAt),
      finishKind,
      finish,
      truncated,
      complete: finishKind === 'stop' && !truncated,
    };
  }

  /**
   * The STREAM form of an auxiliary task: the same route, the same direct (context-free) request
   * and the same shared reasoning policy as `assist`, but the raw provider stream is returned so
   * the caller can consume deltas while the model is still writing (the spoken rewrite). It never
   * assembles the chat context, so no memory or history can enter a task prompt.
   *
   * The caller owns the deadline and the cancellation (`signal`); this method only builds the
   * request. `reasoningEffort` defaults to the shared `'off'` policy above. If the provider refuses
   * it before any delta is handed out, the stream is restarted ONCE without the control and the
   * downgrade is reported (`reasoning.downgraded`).
   */
  taskStream({
    system = '',
    user = '',
    maxTokens = 512,
    signal = undefined,
    reasoningEffort = AUXILIARY_REASONING_EFFORT,
  } = {}) {
    if (!this.available()) throw new Error('DSH llm 服务不可用（插件未拿到 llm）');
    const { provider, model } = this.selection();
    if (provider.length === 0 || model.length === 0) throw new Error('没有可用的默认模型');
    const start = (effort) => this.getLlm().stream(auxiliaryRequestOptions({
      provider,
      model,
      system: String(system ?? ''),
      messages: [{ role: 'user', content: [{ type: 'text', text: String(user ?? '') }] }],
      maxTokens,
      signal,
      reasoningEffort: effort,
    }));
    const requestedEffort = normalizeReasoningEffort(reasoningEffort);
    if (requestedEffort === null) return start(null);
    return this.streamWithReasoningFallback(requestedEffort, start);
  }

  /**
   * P-51: restart a task stream without a refused effort — only when nothing was yielded yet, so
   * no text can be duplicated. Exactly one fallback, then the provider error is the real failure.
   */
  async *streamWithReasoningFallback(requestedEffort, start) {
    let yielded = false;
    try {
      for await (const chunk of start(requestedEffort)) {
        yielded = true;
        yield chunk;
      }
      return;
    } catch (error) {
      if (yielded || !isUnsupportedReasoningEffort(error)) throw error;
    }
    this.reportReasoningDowngraded({ requested: requestedEffort, fallback: 'default', reason: 'unsupported' });
    for await (const chunk of start(null)) yield chunk;
  }

  /**
   * Capability declaration for the current route: does the adapter advertise this reasoning
   * effort? `null` means the service cannot answer before dispatch (the caller then tries once
   * and reacts to `UNSUPPORTED_REASONING_EFFORT`).
   */
  async supportsReasoning(effort = 'off', signal = undefined) {
    const service = this.getLlm();
    if (service === undefined || service === null || typeof service.resolveModelInfo !== 'function') return null;
    const { provider, model } = this.selection();
    if (provider.length === 0 || model.length === 0) return false;
    const info = await service.resolveModelInfo(provider, model, signal);
    const efforts = Array.isArray(info?.reasoning?.efforts) ? info.reasoning.efforts : null;
    if (efforts === null) return false;
    return efforts.some((entry) => String(entry?.id ?? '') === effort);
  }

  /** Text-only convenience wrapper (settings test button). */
  ask(utterance, options = {}) {
    return this.askStream(utterance, options);
  }
}
