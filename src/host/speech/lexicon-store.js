/**
 * Shared lexicon — stage B3: candidate persistence + the pending area (pure module).
 *
 * The user's fixed rules (2026-11-10):
 *   - an ordinary transcript only ever produces a CANDIDATE; nothing is auto-confirmed;
 *   - only the user's confirm action turns a candidate into an effective word;
 *   - the lexicon is SHARED: a candidate is never partitioned by speaker, and a missing voiceprint
 *     identity is not a confirmation gate; speakerId is optional provenance when it is known;
 *   - a confirmed word can be listed, modified and deleted;
 *   - import/export is a v2 feature and is deliberately absent here.
 *
 * This file is only the file-backed state layer. It does not import the host, has no UI/tool
 * wiring and no message/ASR/TTS access: the caller passes `root`, the candidates and the
 * confirmation. The candidate/identity judgement itself lives in `lexicon-candidates.js` and is
 * reused (createLexiconState / mergeCandidates / confirmCandidate / rejectCandidate /
 * removeEntry / listEntries / listUnassigned) instead of being re-implemented.
 *
 * File: `<root>/data/lexicon.json`; `root` is passed in, never inferred.
 *
 *   {
 *     version: 1,
 *     nextId: 2,                        // model bookkeeping: stable lex-N ids across restarts
 *     entries: [{
 *       id, key, text, canonical, wrongForms: [],
 *       kind: 'proper-noun'|'correction',
 *       status: 'candidate'|'confirmed'|'rejected',
 *       speakerId: null|string, assigned: boolean,
 *       context: {before, after}|null,
 *       sourceIds: [], ambiguous: boolean,
 *       at, confirmedAt, rejectedAt, editedAt
 *     }]
 *   }
 *
 * Every field the B3 contract names is always present. `key`, `ambiguous` and `nextId` are the
 * model's own fields and stay on disk: without them the ambiguous-target veto would disappear and
 * id continuity would depend on scanning the file.
 *
 * Read is tolerant: a missing file yields a fresh default state (reading never creates the file);
 * bad JSON, a bad version or a bad top-level structure yields a fresh default state plus one
 * `lexicon.store.corrupt {error}` event (consecutive identical corrupt content is reported once,
 * and a successful write resets that guard). Write is atomic: a temp file in the same directory
 * followed by a rename, and a failed rename removes the temp file, so a reader never observes a
 * half-written lexicon. The store is synchronous and re-reads the file on every call, so two
 * instances over the same root agree (restart safety) and there is no cache to invalidate.
 *
 * Every mutation is read → model call → write → `lexicon.store.changed {op, id}`. A refused model
 * call returns `{ok:false, reason}` and leaves the file untouched. `edit()` is the only way to
 * change a stored spelling: it can set canonical/wrongForms/context and stamps `editedAt`, and it
 * ignores id/kind/status so those can never be rewritten by an edit call.
 *
 * Stage B4 (ASR post-processing closed loop): `applyLexiconText()` applies only the CONFIRMED
 * entries (`listConfirmed()` → `lexiconHints()`) to the text that is delivered/subtitled. The raw
 * ASR result is never rewritten. `proper-noun` replaces whole words only (never a substring), a
 * `correction` is applied only where its stored context matches, and a failing store/rule leaves
 * the input byte-for-byte unchanged (fail-open). Each applied hit is reported as
 * `lexicon.applied {utteranceId, id, from, to, kind}` with truncated texts (debug only).
 */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  LEXICON_STATE_VERSION,
  LEXICON_STATUS,
  confirmCandidate,
  createLexiconState,
  lexiconKey,
  listCandidates,
  listEntries,
  listUnassigned,
  mergeCandidates as mergeStateCandidates,
  rejectCandidate,
  removeEntry,
} from './lexicon-candidates.js';

/** The path inside the caller-provided root. */
export const LEXICON_STORE_PATH = join('data', 'lexicon.json');

/** One stored context side never carries more than this many characters. */
const CONTEXT_MAX_CHARS = 16;

/** Monotonic temp-file suffix, so two stores in one process never share a temp path. */
let writeTmpSeq = 0;

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Strict persisted-shape check. `null` means "this is not a version-1 lexicon file", which makes
 * the caller fall back to the default and record `lexicon.store.corrupt`. Entry field defaults
 * (status/canonical/wrongForms/...) are repaired afterwards by the model's own normalizer, which
 * `read()` triggers with an empty merge, so that logic is not duplicated here.
 */
function normalizeStoredState(raw) {
  if (!plainObject(raw)) return null;
  if (raw.version !== LEXICON_STATE_VERSION) return null;
  if (!Array.isArray(raw.entries)) return null;
  for (const entry of raw.entries) {
    if (!plainObject(entry)) return null;
    if (typeof entry.id !== 'string' || entry.id.length === 0) return null;
    if (typeof entry.text !== 'string' || entry.text.trim().length === 0) return null;
  }
  return raw;
}

/** A stored replacement context, or `null` for "no context"; mirrors the model's shape. */
function cleanContext(value) {
  if (value === null) return null;
  if (!plainObject(value)) return null;
  const before = typeof value.before === 'string'
    ? [...value.before].slice(-CONTEXT_MAX_CHARS).join('')
    : '';
  const after = typeof value.after === 'string'
    ? [...value.after].slice(0, CONTEXT_MAX_CHARS).join('')
    : '';
  if (before.length === 0 && after.length === 0) return null;
  return { before, after };
}

/** De-duplicated misrecognised forms; the same form in full/half width is one form. */
function normalizeWrongForms(value) {
  if (!Array.isArray(value)) return null;
  const seen = new Set();
  const forms = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const form = item.trim();
    const key = lexiconKey(form);
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    forms.push(form);
  }
  return forms;
}

/** One ISO instant from the injected clock, falling back to now when the clock misbehaves. */
function clockInstant(clock) {
  try {
    const value = clock();
    if (value instanceof Date) {
      const ms = value.getTime();
      if (Number.isFinite(ms)) return new Date(ms).toISOString();
    }
    if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
    if (typeof value === 'string') {
      const ms = Date.parse(value);
      if (Number.isFinite(ms)) return new Date(ms).toISOString();
    }
  } catch {
    /* a broken clock must not break a write; fall through to the wall clock */
  }
  return new Date().toISOString();
}

/**
 * Create the file-backed lexicon store for one root.
 *
 * @param {object} options
 * @param {string} options.root the caller-owned root; the file is `<root>/data/lexicon.json`.
 * @param {{emit?: (event: string, payload: object) => unknown}|null} [options.log] event sink;
 *   only `lexicon.store.corrupt` and `lexicon.store.changed` are emitted.
 * @param {() => (Date|number|string)} [options.clock] injected time source.
 * @returns {Readonly<{
 *   file: string,
 *   read: () => object,
 *   write: (state: object) => object,
 *   mergeCandidates: (candidates: object|object[]) => {added: number, merged: number, skipped: number},
 *   confirm: (options: object) => {ok: boolean, entry?: object, reason?: string},
 *   edit: (options: object) => {ok: boolean, entry?: object, reason?: string},
 *   reject: (options: object) => {ok: boolean, entry?: object, reason?: string},
 *   remove: (options: object) => {ok: boolean, entry?: object, reason?: string},
 *   list: () => object[],
 *   listCandidates: () => object[],
 *   listUnassigned: () => object[],
 *   listConfirmed: () => object[],
 * }>}
 */
export function createLexiconStore({ root, log = null, clock = () => new Date() } = {}) {
  if (typeof root !== 'string' || root.trim().length === 0) {
    throw new TypeError('lexicon store: root is required');
  }
  if (typeof clock !== 'function') {
    throw new TypeError('lexicon store: clock must be a function');
  }
  const file = join(root, LEXICON_STORE_PATH);
  let lastCorruption = '';

  const emit = (event, payload) => {
    // Debug logging must never change what the store does, so errors and rejections are swallowed.
    try {
      void log?.emit?.(event, payload)?.catch?.(() => {});
    } catch {
      /* ignore a throwing or absent logger */
    }
  };

  const corrupt = (error, text = '') => {
    const message = error?.message ?? String(error);
    const signature = `${message}\u0000${text}`;
    if (signature === lastCorruption) return;
    lastCorruption = signature;
    emit('lexicon.store.corrupt', { file, error: message });
  };

  /** Every public view, in the model's own order groups; `decorate` adds `editedAt`. */
  const allViews = (state) => [
    ...listEntries(state),
    ...listCandidates(state, { status: LEXICON_STATUS.CANDIDATE }),
    ...listCandidates(state, { status: LEXICON_STATUS.REJECTED }),
  ];

  const decorate = (state, views) => {
    const byId = new Map();
    for (const entry of state.entries) {
      if (entry !== null && typeof entry === 'object' && typeof entry.id === 'string') {
        byId.set(entry.id, entry);
      }
    }
    return views.map((view) => {
      const stored = byId.get(view.id);
      const editedAt = stored !== undefined && typeof stored.editedAt === 'string' ? stored.editedAt : '';
      return { ...view, editedAt };
    });
  };

  const viewOf = (state, id) => {
    const wanted = String(id);
    for (const view of decorate(state, allViews(state))) {
      if (view.id === wanted) return view;
    }
    return null;
  };

  /**
   * Read the file. Missing → fresh default; unreadable/malformed → fresh default + corrupt event.
   * @returns {object} a mutable model state owned by this one call.
   */
  const read = () => {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') corrupt(error);
      return createLexiconState();
    }
    try {
      const state = normalizeStoredState(JSON.parse(text));
      if (state === null) throw new TypeError('不是有效的 lexicon v1 文件');
      // Reuse the model's own entry normalizer instead of re-deriving field defaults here.
      const repaired = mergeStateCandidates(state, []);
      if (repaired.ok !== true) throw new TypeError(`无法修复 lexicon 状态: ${repaired.reason}`);
      lastCorruption = '';
      return state;
    } catch (error) {
      corrupt(error, text);
      return createLexiconState();
    }
  };

  /** Atomic write without the `changed` event (mutators emit their own op instead). */
  const save = (state) => {
    const normalized = normalizeStoredState(state);
    if (normalized === null) {
      throw new TypeError('lexicon store: refusing to write a malformed state');
    }
    // The persisted entry surface always carries every field the B3 contract names; the model
    // creates fresh entries without `editedAt`, so it is filled at this boundary.
    for (const entry of normalized.entries) {
      if (typeof entry.editedAt !== 'string') entry.editedAt = '';
    }
    mkdirSync(dirname(file), { recursive: true });
    // A unique temp name keeps two stores over one root from publishing each other's bytes.
    writeTmpSeq += 1;
    const temporary = `${file}.${process.pid}.${writeTmpSeq}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
      renameSync(temporary, file);
    } catch (error) {
      try {
        unlinkSync(temporary);
      } catch {
        /* the temp file may never have been created */
      }
      throw error;
    }
    lastCorruption = '';
    return normalized;
  };

  /** Public low-level write: validates, writes atomically, reports `op: 'write'`. */
  const write = (state) => {
    const normalized = save(state);
    emit('lexicon.store.changed', { op: 'write', id: null });
    return normalized;
  };

  /**
   * Merge extraction output into the stored state (read → merge → write). Candidates only: this
   * never confirms anything. A rejected key is skipped by the model's tombstone rule.
   *
   * @param {object|object[]} candidates `extractLexiconCandidates` output
   * @returns {{added: number, merged: number, skipped: number}} how many entries were added,
   *   merged with an existing entry, or blocked by a rejected tombstone
   */
  const merge = (candidates) => {
    const state = read();
    const beforeIds = new Set(state.entries.map((entry) => entry?.id));
    const result = mergeStateCandidates(state, candidates ?? []);
    if (result.ok !== true) {
      return { added: 0, merged: 0, skipped: 0, ok: false, reason: result.reason };
    }
    const counts = { added: result.added, merged: result.merged, skipped: result.skipped };
    if (counts.added + counts.merged === 0) return counts;
    save(state);
    const firstAdded = state.entries.find((entry) => !beforeIds.has(entry?.id));
    emit('lexicon.store.changed', { op: 'merge', id: typeof firstAdded?.id === 'string' ? firstAdded.id : null });
    return counts;
  };

  /**
   * The user's explicit confirm action. A candidate becomes an effective shared word only here.
   * `speakerId` is optional provenance: a supplied value is recorded, an absent/blank one leaves
   * the entry `speakerId:null`; either way the confirmation succeeds with `assigned:true`.
   * `canonical` edits the correct spelling and `context` (optional) its replacement window.
   *
   * @param {{text?: string, id?: string, speakerId?: string|null, canonical?: string,
   *   context?: {before?: string, after?: string}|null}} [options]
   * @returns {{ok: true, entry: object}|{ok: false, reason: string}}
   */
  const confirm = ({ text = '', id = undefined, speakerId = null, canonical = '', context = undefined } = {}) => {
    if (context !== undefined && context !== null && !plainObject(context)) {
      return { ok: false, reason: 'invalid-context' };
    }
    const state = read();
    const result = confirmCandidate(state, { text, id, speakerId, canonical, now: clockInstant(clock) });
    if (result.ok !== true) return result;
    if (context !== undefined) {
      const entry = state.entries.find((item) => item?.id === result.entry.id);
      if (entry !== undefined) entry.context = cleanContext(context);
    }
    save(state);
    emit('lexicon.store.changed', { op: 'confirm', id: result.entry.id });
    return { ok: true, entry: viewOf(state, result.entry.id) ?? result.entry };
  };

  /**
   * Edit a stored spelling/misrecognised form/context by stable id and stamp `editedAt`.
   * `id`, `kind` and `status` are never read from the options, so an edit cannot rewrite the
   * entry's identity or move it between candidate/confirmed/rejected. A rejected tombstone is
   * refused (`reason:'rejected'`); an empty canonical is refused so a confirmed word cannot lose
   * its spelling. Candidate rows are editable too (canonical/wrongForms are candidate data), but
   * the product rule "confirmed words can be viewed/modified/deleted" only exposes this in the UI
   * after confirmation — editing a candidate never confirms it.
   *
   * @param {{id: string, canonical?: string, wrongForms?: string[],
   *   context?: {before?: string, after?: string}|null}} options
   * @returns {{ok: true, entry: object}|{ok: false, reason: string}}
   */
  const edit = ({ id = undefined, canonical = undefined, wrongForms = undefined, context = undefined } = {}) => {
    if (id === undefined || id === null) return { ok: false, reason: 'id-required' };
    if (canonical === undefined && wrongForms === undefined && context === undefined) {
      return { ok: false, reason: 'no-editable-field' };
    }
    let display;
    if (canonical !== undefined) {
      display = typeof canonical === 'string' ? canonical.trim() : '';
      if (display.length === 0) return { ok: false, reason: 'canonical-empty' };
    }
    let forms;
    if (wrongForms !== undefined) {
      forms = normalizeWrongForms(wrongForms);
      if (forms === null) return { ok: false, reason: 'invalid-wrong-forms' };
    }
    if (context !== undefined && context !== null && !plainObject(context)) {
      return { ok: false, reason: 'invalid-context' };
    }
    const state = read();
    const entry = state.entries.find((item) => item?.id === String(id));
    if (entry === undefined) return { ok: false, reason: 'not-found' };
    if (entry.status === LEXICON_STATUS.REJECTED) return { ok: false, reason: 'rejected' };
    // id / kind / status are never read from the options: an edit can never rewrite identity.
    if (display !== undefined) {
      entry.canonical = display;
      if (typeof entry.text !== 'string' || entry.text.length === 0) entry.text = display;
    }
    if (forms !== undefined) entry.wrongForms = forms;
    if (context !== undefined) entry.context = cleanContext(context);
    entry.editedAt = clockInstant(clock);
    save(state);
    emit('lexicon.store.changed', { op: 'edit', id: entry.id });
    return { ok: true, entry: viewOf(state, entry.id) };
  };

  /**
   * Reject a pending candidate: it leaves the candidate/unassigned lists but stays on disk as a
   * tombstone so re-extraction cannot silently resurrect it.
   *
   * @param {{text?: string, id?: string}} [options]
   * @returns {{ok: true, entry: object}|{ok: false, reason: string}}
   */
  const reject = ({ text = '', id = undefined } = {}) => {
    const state = read();
    const result = rejectCandidate(state, { text, id, now: clockInstant(clock) });
    if (result.ok !== true) return result;
    save(state);
    emit('lexicon.store.changed', { op: 'reject', id: result.entry.id });
    return { ok: true, entry: viewOf(state, result.entry.id) ?? result.entry };
  };

  /**
   * Delete one entry (candidate, tombstone or confirmed word) from the file.
   *
   * @param {{text?: string, id?: string}} [options]
   * @returns {{ok: true, entry: object}|{ok: false, reason: string}}
   */
  const remove = ({ text = '', id = undefined } = {}) => {
    const state = read();
    // Capture the public view before deletion so the caller still sees the removed row.
    const view = id === undefined || id === null ? null : viewOf(state, id);
    const result = removeEntry(state, { text, id });
    if (result.ok !== true) return result;
    save(state);
    emit('lexicon.store.changed', { op: 'remove', id: result.entry.id });
    return { ok: true, entry: view ?? decorate(state, [result.entry])[0] };
  };

  /**
   * Every stored entry (candidate, confirmed and rejected tombstones), sorted by `at`.
   * `listConfirmed()` is the shared lexicon; `listUnassigned()` is the pending candidate view.
   */
  const list = () => {
    const state = read();
    const views = decorate(state, allViews(state));
    return views.sort((left, right) => {
      if (left.at !== right.at) return left.at < right.at ? -1 : 1;
      if (left.id === right.id) return 0;
      return left.id < right.id ? -1 : 1;
    });
  };

  return Object.freeze({
    file,
    read,
    write,
    mergeCandidates: merge,
    confirm,
    edit,
    reject,
    remove,
    list,
    /** Pending candidates from the conversation lane, including assigned-but-unconfirmed ones. */
    listCandidates: () => {
      const state = read();
      return decorate(state, listCandidates(state));
    },
    listUnassigned: () => {
      const state = read();
      return decorate(state, listUnassigned(state));
    },
    listConfirmed: () => {
      const state = read();
      return decorate(state, listEntries(state));
    },
  });
}

/**
 * Confirmed entries as recognition post-processing HINTS. This is data only: `wrongForms` are the
 * misrecognised forms and `canonical` the spelling the user confirmed, but nothing here rewrites a
 * transcript. A `correction` row is applicable only where its stored `context` still matches
 * (`replaceable`), so the caller must use `applyCorrection` rather than a whole-text replacement.
 *
 * @param {object[]} entries `listConfirmed()` output (or any confirmed entry views)
 * @returns {Array<{id: string, kind: 'proper-noun'|'correction', canonical: string,
 *   wrongForms: string[], context: {before: string, after: string}|null, replaceable: boolean}>}
 */
export function lexiconHints(entries = []) {
  const list = Array.isArray(entries) ? entries : [];
  return list
    .filter((entry) => entry !== null && typeof entry === 'object' && entry.status === 'confirmed')
    .map((entry) => {
      const canonical = typeof entry.canonical === 'string' && entry.canonical.length > 0
        ? entry.canonical
        : (typeof entry.text === 'string' ? entry.text : '');
      const wrongForms = Array.isArray(entry.wrongForms) ? [...entry.wrongForms] : [];
      const context = entry.context ?? null;
      const kind = entry.kind === 'correction' ? 'correction' : 'proper-noun';
      return {
        id: typeof entry.id === 'string' ? entry.id : '',
        kind,
        canonical,
        wrongForms,
        context,
        // Only a correction WITH a stored context is a replacement rule; everything else is a
        // recognizer hint, never a global find/replace.
        replaceable: kind === 'correction' && context !== null && wrongForms.length > 0 && canonical.length > 0,
      };
    })
    .filter((hint) => hint.canonical.length > 0 && hint.wrongForms.length > 0);
}

// ---------------------------------------------------------------------------
// Stage B4: apply CONFIRMED words to the delivered transcript (pure + fail-open wrapper)
// ---------------------------------------------------------------------------

/** How many stored context characters must match on each side; mirrors lexicon-candidates. */
const APPLY_CONTEXT_WINDOW = 4;

/** A Latin/digit token continues through these, so a neighbour here means a partial match. */
const ASCII_WORD_RE = /[A-Za-z0-9_]/u;

/** Han edges are decided by ICU, except for these: 小满子/小满儿 is a longer word, not a bare name. */
const HAN_CONTINUATION = new Set([...'子儿女们家氏仔哥姐弟妹叔姨婆爷总']);

const HAN_EDGE_RE = /[\p{Script=Han}]/u;

/** ICU is part of Node; without it a Han-edge hit stays conservative (no replacement). */
const APPLY_SEGMENTER = typeof Intl?.Segmenter === 'function'
  ? new Intl.Segmenter('zh-CN', { granularity: 'word' })
  : null;

/** Debug texts are clipped by code points, so an event never splits an emoji either. */
const APPLIED_TEXT_MAX = 24;

/** One clipped debug value; never throws, never splits a surrogate pair. */
function clipped(value) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  const chars = [...text];
  return chars.length <= APPLIED_TEXT_MAX ? text : `${chars.slice(0, APPLIED_TEXT_MAX).join('')}…`;
}

/** Word-like segment boundaries for `text`, or null when ICU is unavailable / unhappy. */
function segmentBounds(text) {
  if (APPLY_SEGMENTER === null) return null;
  const starts = new Set();
  const ends = new Set();
  try {
    for (const part of APPLY_SEGMENTER.segment(text)) {
      if (part.isWordLike !== true) continue;
      starts.add(part.index);
      ends.add(part.index + part.segment.length);
    }
  } catch {
    return null;
  }
  return { starts, ends };
}

/**
 * Is `[start, end)` a complete word (not a substring of a longer token)?
 *
 * Latin/digit neighbours (`GPT4x`, `xGPT4`) always mean a partial match. Han has no spaces, so a
 * Han neighbour is normal word order (叫|小满|来了) and ICU word segmentation decides; a name
 * continuation (小满|子) is rejected by the small suffix guard instead. Emoji/punctuation
 * neighbours are delimiters and match, and the cut itself is always a whole UTF-16 span.
 */
function wholeWordAt(text, start, end, bounds) {
  const left = start > 0 ? text[start - 1] : '';
  const right = end < text.length ? text[end] : '';
  if (left !== '' && ASCII_WORD_RE.test(left)) return false;
  if (right !== '' && ASCII_WORD_RE.test(right)) return false;
  const hanEdge = HAN_EDGE_RE.test(text[start]) || HAN_EDGE_RE.test(text[end - 1]);
  if (hanEdge !== true) return true;
  if (right !== '' && HAN_CONTINUATION.has(right)) return false;
  return bounds !== null && bounds.starts.has(start) && bounds.ends.has(end);
}

/** Quote one wrong form for a combined literal alternation. */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/** A stored correction context cropped to the applied window, or null when it is unusable. */
function usableContext(value) {
  if (value === null || typeof value !== 'object') return null;
  const before = typeof value.before === 'string'
    ? [...value.before].slice(-APPLY_CONTEXT_WINDOW).join('')
    : '';
  const after = typeof value.after === 'string'
    ? [...value.after].slice(0, APPLY_CONTEXT_WINDOW).join('')
    : '';
  if (before.length === 0 && after.length === 0) return null;
  return { before, after };
}

/** Does the stored context still surround this span? */
function contextMatches(source, start, end, context) {
  const beforeOk = context.before.length === 0 || source.slice(0, start).endsWith(context.before);
  const afterOk = context.after.length === 0 || source.slice(end).startsWith(context.after);
  return beforeOk && afterOk;
}

/**
 * Apply confirmed lexicon rules to one ASR text, purely (no I/O, no clock, no state).
 *
 * - `proper-noun`: every WHOLE-WORD occurrence of a `wrongForm` becomes `canonical`; a substring
 *   inside a longer word is never touched;
 * - `correction`: applied only where the stored `context` (before/after) still matches; a row
 *   without context is refused (there is deliberately no global replacement);
 * - all rules compete on the same spans and the longest match at a position wins.
 *
 * Work is bounded: one text scan per rule, so an utterance scans at most as many times as there
 * are confirmed entries (`scans` reports the exact count). Every replacement covers whole UTF-16
 * spans, so emoji and other astral characters are never split. No hit → the exact input string.
 *
 * @param {unknown} text
 * @param {object[]} [hints] `lexiconHints()` output (confirmed entries only)
 * @returns {{text: string, applied: Array<{id: string, kind: string, from: string, to: string}>,
 *   scans: number}}
 */
export function applyLexiconHints(text, hints = []) {
  const source = typeof text === 'string' ? text : '';
  const rules = (Array.isArray(hints) ? hints : []).filter((hint) => hint !== null
    && typeof hint === 'object'
    && typeof hint.canonical === 'string'
    && hint.canonical.length > 0
    && Array.isArray(hint.wrongForms)
    && hint.wrongForms.length > 0);
  const result = { text: source, applied: [], scans: 0 };
  if (source.length === 0 || rules.length === 0) return result;
  const bounds = segmentBounds(source);
  const spans = [];
  for (const hint of rules) {
    result.scans += 1;
    const kind = hint.kind === 'correction' ? 'correction' : 'proper-noun';
    const context = kind === 'correction' ? usableContext(hint.context) : null;
    if (kind === 'correction' && context === null) continue;
    // One combined literal pattern per entry = ONE text scan per confirmed entry, with the
    // longest form first so 小满子 wins over 小满 at the same position.
    const forms = [];
    for (const raw of hint.wrongForms) {
      const form = typeof raw === 'string' ? raw.trim() : '';
      if (form.length === 0 || form === hint.canonical || forms.includes(form)) continue;
      if (typeof form.isWellFormed === 'function' && form.isWellFormed() !== true) continue;
      forms.push(form);
    }
    if (forms.length === 0) continue;
    forms.sort((left, right) => right.length - left.length);
    let pattern;
    try {
      pattern = new RegExp(forms.map(escapeRegExp).join('|'), 'giu');
    } catch {
      continue; // a form the engine refuses must never break the scan
    }
    for (const match of source.matchAll(pattern)) {
      const start = match.index;
      const end = start + match[0].length;
      const contextOk = context === null || contextMatches(source, start, end, context);
      const wordOk = kind !== 'proper-noun' || wholeWordAt(source, start, end, bounds);
      if (contextOk && wordOk) {
        spans.push({ start, end, id: hint.id, kind, from: source.slice(start, end), to: hint.canonical });
      }
    }
  }
  // Longest match first at the same start; an earlier span wins over a later overlapping one.
  spans.sort((left, right) => left.start - right.start
    || (right.end - right.start) - (left.end - left.start)
    || (left.kind === 'proper-noun' ? -1 : 1));
  let cursor = 0;
  let output = '';
  for (const span of spans) {
    if (span.start < cursor) continue;
    output += source.slice(cursor, span.start) + span.to;
    cursor = span.end;
    result.applied.push({ id: span.id, kind: span.kind, from: span.from, to: span.to });
  }
  if (result.applied.length === 0) return result;
  result.text = output + source.slice(cursor);
  return result;
}

/** Debug logging for the applied/failed rows; a throwing or absent logger never breaks delivery. */
function emitApplyEvent(log, event, payload) {
  try {
    void log?.emit?.(event, payload)?.catch?.(() => {});
  } catch {
    /* ignore a throwing logger */
  }
}

/**
 * The recognition post-processing point: apply the CONFIRMED shared lexicon to the text used
 * for delivery and subtitles, and report each hit as a debug `lexicon.applied` row.
 *
 * Fail-open: a missing/throwing store, a corrupt entry or a hint-building error returns the input
 * unchanged, so ASR delivery never depends on the lexicon. The raw ASR result is never rewritten
 * here; callers keep it as the archive/`rawText`.
 *
 * @param {unknown} text the delivered transcript (not the raw archive copy)
 * @param {{store?: {listConfirmed?: () => object[]}|null, log?: object|null,
 *   utteranceId?: string}} [options]
 * @returns {string} the post-processed text, or `text` unchanged on any failure/no hit
 */
export function applyLexiconText(text, { store = null, log = null, utteranceId = '' } = {}) {
  const source = typeof text === 'string' ? text : '';
  const id = typeof utteranceId === 'string' ? utteranceId : '';
  let result;
  try {
    if (store === null || typeof store.listConfirmed !== 'function') return source;
    result = applyLexiconHints(source, lexiconHints(store.listConfirmed()));
  } catch (error) {
    emitApplyEvent(log, 'lexicon.apply.failed', { utteranceId: id, error: error?.message ?? String(error) });
    return source;
  }
  for (const hit of result.applied) {
    emitApplyEvent(log, 'lexicon.applied', {
      utteranceId: id,
      id: hit.id,
      from: clipped(hit.from),
      to: clipped(hit.to),
      kind: hit.kind,
    });
  }
  return result.text;
}
