/**
 * Personal lexicon — stage B3: candidate persistence + the unassigned area (pure module).
 *
 * The user's fixed rules (2026-11-08):
 *   - an ordinary transcript only ever produces a CANDIDATE; nothing is auto-confirmed;
 *   - only the user's confirm action turns a candidate into an effective word;
 *   - a candidate whose speaker identity is not confirmed stays in the unassigned area and is
 *     NOT part of the personal lexicon;
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
   * The user's explicit confirm action. A candidate becomes an effective word only here, and only
   * with a speaker identity: no speakerId → `{ok:false, reason:'speaker-required'}` and the entry
   * keeps `assigned:false, speakerId:null`. `canonical` edits the correct spelling and `context`
   * (optional) its replacement window.
   *
   * @param {{text?: string, id?: string, speakerId?: string, canonical?: string,
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
   * `listConfirmed()` is the personal lexicon; `listUnassigned()` is the unassigned area.
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
