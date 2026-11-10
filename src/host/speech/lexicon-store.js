/**
 * Shared lexicon — stage B3: candidate persistence + the pending area (pure module).
 *
 * The user's fixed rules (2026-11-10):
 *   - an ordinary transcript only ever produces a CANDIDATE; nothing is auto-confirmed;
 *   - only the user's confirm action turns a candidate into an effective word;
 *   - the PUBLIC library is shared: a candidate is never partitioned by speaker, and a missing
 *     voiceprint identity is not a confirmation gate; speakerId is optional provenance there;
 *   - the VOICEPRINT library is personal: an entry belongs to exactly one confirmed self
 *     (`speakerId === selfId`), is written only while that self is confirmed, and never enters
 *     another speaker's active view. Moving it back to public clears the owner;
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
 *       category: string,               // free text; legacy ids still round-trip, '' → 'unknown'
 *       usage: string, reading: string, library: 'public'|'voiceprint',
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
 * Stage B4 (ASR post-processing closed loop): `applyLexiconText()` applies only the elements the
 * caller may hear: the active view (`listActive({speakerId})` → `lexiconHints()`) is the public
 * library plus the current confirmed self's own voiceprint entries. The raw ASR result is never
 * rewritten. `proper-noun` replaces whole words only (never a substring), a
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

/**
 * Legacy shared-lexicon taxonomy. These ids are still valid input and keep their exact stored
 * value (old files must round-trip), but the category field is no longer restricted to them:
 * any non-empty text is accepted, and an empty value is stored as `unknown`.
 */
export const LEXICON_CATEGORIES = Object.freeze([
  'person',
  'character',
  'work',
  'place',
  'term',
  'expression',
  'meme',
  'unknown',
]);

/** Safe default for a missing/blank category. */
export const LEXICON_DEFAULT_CATEGORY = 'unknown';

/**
 * Library slot of one entry:
 *   - `public`: shared, effective for every speaker; `speakerId` is optional provenance only.
 *   - `voiceprint`: personal, owned by `speakerId === selfId`; effective only for that confirmed
 *     self and never for another speaker. A confirmed self is required to create/move into it.
 */
export const LEXICON_LIBRARIES = Object.freeze(['public', 'voiceprint']);
export const LEXICON_DEFAULT_LIBRARY = 'public';

/** User-facing field limits, measured in code points (an emoji counts once). */
export const LEXICON_TEXT_MAX_CHARS = 40;
export const LEXICON_CATEGORY_MAX_CHARS = 40;
/** Space-separated category labels per entry; keeps the stored string bounded. */
export const LEXICON_CATEGORY_MAX_COUNT = 8;

/**
 * Split a free-text category field on ASCII/full-width whitespace. Used by both the store and
 * the recall bonus, so "动画 角色" and "动画　角色" behave the same and a Chinese label is just
 * another token.
 * @param {unknown} value
 * @returns {string[]}
 */
export function splitLexiconCategories(value) {
  if (typeof value !== 'string') return [];
  const seen = new Set();
  const labels = [];
  for (const token of value.split(/[\s\u3000]+/u)) {
    const text = token.trim();
    if (text.length === 0 || seen.has(text)) continue;
    seen.add(text);
    labels.push(text);
  }
  return labels;
}
export const LEXICON_USAGE_MAX_CHARS = 200;
export const LEXICON_READING_MAX_CHARS = 80;

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

/** Code-point length; invalid values count as empty. */
function textLength(value) {
  return typeof value === 'string' ? [...value].length : 0;
}

/**
 * The stored category projection: any trimmed non-empty text within the limit, otherwise
 * `unknown`. Tolerant on purpose (it repairs disk data); mutators use `cleanCategory` to refuse
 * an over-long or non-string value instead of silently rewriting the user's input.
 */
function storedCategory(value) {
  const labels = splitLexiconCategories(value);
  if (labels.length === 0) return LEXICON_DEFAULT_CATEGORY;
  const text = labels.slice(0, LEXICON_CATEGORY_MAX_COUNT).join(' ');
  return textLength(text) <= LEXICON_CATEGORY_MAX_CHARS ? text : LEXICON_DEFAULT_CATEGORY;
}

/**
 * Repair the manual fields on one entry read from disk (or about to be written by `write`).
 * Old lexicon files have none of these fields, so they must still read as usable public words.
 * Mutators validate their input strictly; this tolerant pass only guarantees the persisted shape.
 */
function normalizeEntryExtras(entry) {
  entry.category = storedCategory(entry.category);
  if (typeof entry.usage !== 'string') entry.usage = '';
  if (typeof entry.reading !== 'string') entry.reading = '';
  if (!LEXICON_LIBRARIES.includes(entry.library)) entry.library = LEXICON_DEFAULT_LIBRARY;
}

/**
 * Validate a category argument. Free text is accepted (trimmed, at most
 * `LEXICON_CATEGORY_MAX_CHARS` code points); `undefined`/`null`/blank mean `unknown`.
 * `null` means "invalid" (non-string or too long).
 */
function cleanCategory(value) {
  if (value === undefined || value === null) return LEXICON_DEFAULT_CATEGORY;
  if (typeof value !== 'string') return null;
  const labels = splitLexiconCategories(value);
  if (labels.length === 0) return LEXICON_DEFAULT_CATEGORY;
  if (labels.length > LEXICON_CATEGORY_MAX_COUNT) return null;
  const text = labels.join(' ');
  return textLength(text) <= LEXICON_CATEGORY_MAX_CHARS ? text : null;
}

function cleanUsage(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (textLength(text) > LEXICON_USAGE_MAX_CHARS) return null;
  return text;
}

function cleanReading(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (textLength(text) > LEXICON_READING_MAX_CHARS) return null;
  return text;
}

function cleanLibrary(value) {
  if (value === undefined || value === null) return LEXICON_DEFAULT_LIBRARY;
  return typeof value === 'string' && LEXICON_LIBRARIES.includes(value) ? value : null;
}

/**
 * Normalize the optional confirmed-self source. A function is asked lazily (the enrollment store
 * may confirm the self after this store was created); a fixed string is a convenience for tests
 * and embedded hosts. Anything else means "no confirmed self".
 */
function normalizeSelfIdSource(value) {
  if (typeof value === 'function') return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const fixed = value.trim();
    return () => fixed;
  }
  return () => '';
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
 * Allocate the next stable `lex-N` id for a manually added entry. This mirrors the model's own
 * allocator (not exported by lexicon-candidates) and updates `state.nextId`, so ids stay unique
 * across candidate merges and manual adds in either order.
 */
function allocateEntryId(state) {
  let highest = 0;
  for (const entry of state.entries) {
    const match = /^lex-(\d+)$/u.exec(String(entry?.id ?? ''));
    if (match !== null) highest = Math.max(highest, Number(match[1]));
  }
  const next = Math.max(Number.isSafeInteger(state.nextId) ? state.nextId : 1, highest + 1);
  state.nextId = next + 1;
  return `lex-${next}`;
}

/**
 * Create the file-backed lexicon store for one root.
 *
 * @param {object} options
 * @param {string} options.root the caller-owned root; the file is `<root>/data/lexicon.json`.
 * @param {{emit?: (event: string, payload: object) => unknown}|null} [options.log] event sink;
 *   only `lexicon.store.corrupt` and `lexicon.store.changed` are emitted.
 * @param {() => (Date|number|string)} [options.clock] injected time source.
 * @param {string|(() => string)} [options.selfId] the confirmed self identity
 *   (`enrollment.getConfirmedSelf().speakerId`). A function is re-read on every write/list call, so
 *   a later confirmation takes effect without recreating the store.
 * @returns {Readonly<{
 *   file: string,
 *   read: () => object,
 *   write: (state: object) => object,
 *   mergeCandidates: (candidates: object|object[]) => {added: number, merged: number, skipped: number},
 *   addEntry: (options: object) => {ok: boolean, entry?: object, reason?: string},
 *   updateEntry: (options: object) => {ok: boolean, entry?: object, reason?: string},
 *   moveEntry: (options: object) => {ok: boolean, entry?: object, reason?: string},
 *   confirm: (options: object) => {ok: boolean, entry?: object, reason?: string},
 *   edit: (options: object) => {ok: boolean, entry?: object, reason?: string},
 *   reject: (options: object) => {ok: boolean, entry?: object, reason?: string},
 *   remove: (options: object) => {ok: boolean, entry?: object, reason?: string},
 *   list: () => object[],
 *   listCandidates: () => object[],
 *   listUnassigned: () => object[],
 *   listConfirmed: () => object[],
 *   listActive: (options?: {speakerId?: string}) => object[],
 * }>}
 */
export function createLexiconStore({ root, log = null, clock = () => new Date(), selfId = null } = {}) {
  if (typeof root !== 'string' || root.trim().length === 0) {
    throw new TypeError('lexicon store: root is required');
  }
  if (typeof clock !== 'function') {
    throw new TypeError('lexicon store: clock must be a function');
  }
  const file = join(root, LEXICON_STORE_PATH);
  const selfIdSource = normalizeSelfIdSource(selfId);
  let lastCorruption = '';

  /** The store's currently confirmed self, or '' when none is confirmed. Never throws. */
  const confirmedSelfId = () => {
    try {
      const value = selfIdSource();
      return typeof value === 'string' ? value.trim() : '';
    } catch {
      return '';
    }
  };

  /**
   * Resolve the identity a library operation/list may use. A configured confirmed self is
   * authoritative: an explicit different id is NOT that self and therefore gets no voiceprint
   * access. Without a configured self, an explicit caller-supplied id is the caller's assertion of
   * the confirmed self (the Host always passes `enrollment.selfId`).
   */
  const speakerFor = (speakerId) => {
    const requested = typeof speakerId === 'string' ? speakerId.trim() : '';
    const configured = confirmedSelfId();
    if (configured !== '') return requested === '' || requested === configured ? configured : '';
    return requested;
  };

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
      const extra = stored !== undefined && stored !== null && typeof stored === 'object'
        ? {
            category: storedCategory(stored.category),
            usage: typeof stored.usage === 'string' ? stored.usage : '',
            reading: typeof stored.reading === 'string' ? stored.reading : '',
            library: LEXICON_LIBRARIES.includes(stored.library) ? stored.library : LEXICON_DEFAULT_LIBRARY,
          }
        : { category: LEXICON_DEFAULT_CATEGORY, usage: '', reading: '', library: LEXICON_DEFAULT_LIBRARY };
      return { ...view, ...extra, editedAt };
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
      for (const entry of state.entries) normalizeEntryExtras(entry);
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
      normalizeEntryExtras(entry);
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
   * Manually add one word. It is confirmed immediately (the user typed it, so there is no
   * candidate to confirm). A `public` entry carries no speaker identity; a `voiceprint` entry is
   * only allowed while a confirmed self exists and is written with `speakerId = selfId`.
   *
   * A duplicate key/canonical returns exactly `{ok:false, reason:'exists'}` and writes nothing.
   *
   * `category` is free text (trimmed, up to `LEXICON_CATEGORY_MAX_CHARS` code points). The legacy
   * ids in `LEXICON_CATEGORIES` keep working; blank/missing becomes `unknown`.
   *
   * @param {{text?: string, canonical?: string, category?: string, usage?: string|null,
   *   reading?: string|null, library?: string, speakerId?: string}} [options]
   * @returns {{ok: true, entry: object}|{ok: false, reason: string}}
   */
  const addEntry = ({
    text = undefined,
    canonical = undefined,
    category = undefined,
    usage = undefined,
    reading = undefined,
    library = undefined,
    speakerId = undefined,
  } = {}) => {
    const raw = canonical !== undefined ? canonical : text;
    const display = typeof raw === 'string' ? raw.trim() : '';
    if (display.length === 0) return { ok: false, reason: 'text-required' };
    if (textLength(display) > LEXICON_TEXT_MAX_CHARS) return { ok: false, reason: 'text-too-long' };
    const categoryValue = cleanCategory(category);
    if (categoryValue === null) return { ok: false, reason: 'invalid-category' };
    const usageValue = cleanUsage(usage);
    if (usageValue === null) return { ok: false, reason: 'invalid-usage' };
    const readingValue = cleanReading(reading);
    if (readingValue === null) return { ok: false, reason: 'invalid-reading' };
    const libraryValue = cleanLibrary(library);
    if (libraryValue === null) return { ok: false, reason: 'invalid-library' };
    const key = lexiconKey(display);
    const state = read();
    // A duplicate is refused before the ownership gate: no write happens either way, and the
    // caller keeps the useful `exists` answer even for a voiceprint add whose self is missing.
    const duplicate = state.entries.find((entry) => entry?.key === key
      || (typeof entry?.canonical === 'string' && entry.canonical.length > 0 && lexiconKey(entry.canonical) === key));
    if (duplicate !== undefined) return { ok: false, reason: 'exists' };
    const owner = libraryValue === 'voiceprint' ? speakerFor(speakerId) : '';
    if (libraryValue === 'voiceprint' && owner === '') {
      return { ok: false, reason: 'self-required' };
    }
    const at = clockInstant(clock);
    const entry = {
      id: allocateEntryId(state),
      key,
      text: display,
      canonical: display,
      kind: 'proper-noun',
      category: categoryValue,
      usage: usageValue,
      reading: readingValue,
      library: libraryValue,
      status: LEXICON_STATUS.CONFIRMED,
      wrongForms: [],
      sourceIds: [],
      context: null,
      ambiguous: false,
      speakerId: libraryValue === 'voiceprint' ? owner : null,
      assigned: true,
      at,
      confirmedAt: at,
      rejectedAt: '',
      editedAt: '',
    };
    state.entries.push(entry);
    save(state);
    emit('lexicon.store.changed', { op: 'add', id: entry.id });
    return { ok: true, entry: viewOf(state, entry.id) };
  };

  /**
   * Edit a manually managed entry's identity text / category / usage / reading, and optionally
   * its library. The entry's status, kind, wrongForms and identity (id) are never rewritten here;
   * in particular an update cannot confirm, reject or un-reject an entry. Renaming to another
   * entry's key is refused with `exists` so the store keeps one row per normalized form.
   *
   * A `library` change follows the same ownership rules as `moveEntry`: moving into `voiceprint`
   * requires a confirmed self and reserves the entry for it, while moving back to `public` clears
   * `speakerId`.
   *
   * `text` and `canonical` are two names for the same display form; when both are supplied
   * `canonical` wins. Changing it updates `text`, `canonical` and the normalized `key` together.
   * `category` follows the same free-text rule as `addEntry` (blank → `unknown`).
   *
   * @param {{id?: string, text?: string, canonical?: string, category?: string,
   *   usage?: string|null, reading?: string|null, library?: string,
   *   speakerId?: string}} [options]
   * @returns {{ok: true, entry: object}|{ok: false, reason: string}}
   */
  const updateEntry = ({
    id = undefined,
    text = undefined,
    canonical = undefined,
    category = undefined,
    usage = undefined,
    reading = undefined,
    library = undefined,
    speakerId = undefined,
  } = {}) => {
    if (id === undefined || id === null) return { ok: false, reason: 'id-required' };
    if (text === undefined && canonical === undefined && category === undefined
      && usage === undefined && reading === undefined && library === undefined) {
      return { ok: false, reason: 'no-editable-field' };
    }
    let display;
    if (text !== undefined || canonical !== undefined) {
      const raw = canonical !== undefined ? canonical : text;
      display = typeof raw === 'string' ? raw.trim() : '';
      if (display.length === 0) return { ok: false, reason: 'text-required' };
      if (textLength(display) > LEXICON_TEXT_MAX_CHARS) return { ok: false, reason: 'text-too-long' };
    }
    let categoryValue;
    if (category !== undefined) {
      categoryValue = cleanCategory(category);
      if (categoryValue === null) return { ok: false, reason: 'invalid-category' };
    }
    let usageValue;
    if (usage !== undefined) {
      usageValue = cleanUsage(usage);
      if (usageValue === null) return { ok: false, reason: 'invalid-usage' };
    }
    let readingValue;
    if (reading !== undefined) {
      readingValue = cleanReading(reading);
      if (readingValue === null) return { ok: false, reason: 'invalid-reading' };
    }
    let libraryValue;
    if (library !== undefined) {
      libraryValue = cleanLibrary(library);
      if (libraryValue === null) return { ok: false, reason: 'invalid-library' };
    }
    const state = read();
    const entry = state.entries.find((item) => item?.id === String(id));
    if (entry === undefined) return { ok: false, reason: 'not-found' };
    if (entry.status === LEXICON_STATUS.REJECTED) return { ok: false, reason: 'rejected' };
    if (display !== undefined) {
      const key = lexiconKey(display);
      const duplicate = state.entries.find((item) => item !== entry && (item?.key === key
        || (typeof item?.canonical === 'string' && item.canonical.length > 0 && lexiconKey(item.canonical) === key)));
      if (duplicate !== undefined) return { ok: false, reason: 'exists' };
      entry.text = display;
      entry.canonical = display;
      entry.key = key;
    }
    if (categoryValue !== undefined) entry.category = categoryValue;
    if (usageValue !== undefined) entry.usage = usageValue;
    if (readingValue !== undefined) entry.reading = readingValue;
    if (libraryValue !== undefined) {
      const owner = speakerFor(speakerId);
      if (libraryValue === 'voiceprint') {
        if (owner === '') return { ok: false, reason: 'self-required' };
        // A private row that already belongs to another self cannot be absorbed by this one.
        // Moving it back to public is still allowed: that only releases the owner.
        if (entry.library === 'voiceprint' && typeof entry.speakerId === 'string'
          && entry.speakerId.length > 0 && entry.speakerId !== owner) {
          return { ok: false, reason: 'not-owned' };
        }
        entry.library = 'voiceprint';
        entry.speakerId = owner;
      } else {
        entry.library = 'public';
        entry.speakerId = null;
      }
    }
    entry.editedAt = clockInstant(clock);
    save(state);
    emit('lexicon.store.changed', { op: 'update', id: entry.id });
    return { ok: true, entry: viewOf(state, entry.id) };
  };

  /**
   * Move one entry between the public library and the voiceprint library. Moving into
   * `voiceprint` requires a confirmed self; the entry is then reserved for it
   * (`speakerId = selfId`). Moving back to `public` clears the owner so no stale identity filters
   * the now-shared word. Moving another self's private row INTO this self's voiceprint slot is
   * refused with `not-owned`: one self can never absorb another self's private word (releasing it
   * back to public remains possible).
   *
   * @param {{id?: string, library?: string, speakerId?: string}} [options]
   * @returns {{ok: true, entry: object}|{ok: false, reason: string}}
   */
  const moveEntry = ({ id = undefined, library = undefined, speakerId = undefined } = {}) => {
    if (id === undefined || id === null) return { ok: false, reason: 'id-required' };
    if (library === undefined) return { ok: false, reason: 'invalid-library' };
    const libraryValue = cleanLibrary(library);
    if (libraryValue === null) return { ok: false, reason: 'invalid-library' };
    const state = read();
    const entry = state.entries.find((item) => item?.id === String(id));
    if (entry === undefined) return { ok: false, reason: 'not-found' };
    if (entry.status === LEXICON_STATUS.REJECTED) return { ok: false, reason: 'rejected' };
    const owner = speakerFor(speakerId);
    if (libraryValue === 'voiceprint') {
      if (owner === '') return { ok: false, reason: 'self-required' };
      // A private row that already belongs to another self cannot be absorbed by this one.
      // Moving it back to public is still allowed: that only releases the owner.
      if (entry.library === 'voiceprint' && typeof entry.speakerId === 'string'
        && entry.speakerId.length > 0 && entry.speakerId !== owner) {
        return { ok: false, reason: 'not-owned' };
      }
      entry.library = 'voiceprint';
      entry.speakerId = owner;
    } else {
      entry.library = 'public';
      entry.speakerId = null;
    }
    save(state);
    emit('lexicon.store.changed', { op: 'move', id: entry.id });
    return { ok: true, entry: viewOf(state, entry.id) };
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
    // A voiceprint row's owner is its self, not whatever optional provenance a caller supplies.
    // Confirming such a row keeps (or claims an unowned row for) that self and refuses another
    // self's private row.
    const wantedId = id === undefined || id === null ? '' : String(id);
    const wantedKey = lexiconKey(text);
    const target = state.entries.find((entry) => {
      if (wantedId !== '') return entry?.id === wantedId;
      if (typeof entry?.key === 'string' && entry.key === wantedKey) return true;
      return typeof entry?.canonical === 'string' && entry.canonical.length > 0
        && lexiconKey(entry.canonical) === wantedKey;
    });
    if (target?.library === 'voiceprint') {
      const owner = speakerFor(speakerId);
      if (owner === '') return { ok: false, reason: 'self-required' };
      if (typeof target.speakerId === 'string' && target.speakerId.length > 0 && target.speakerId !== owner) {
        return { ok: false, reason: 'not-owned' };
      }
      speakerId = owner;
    }
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
   * `listConfirmed()` is the administration view (every confirmed row, including every
   * voiceprint owner); `listActive()` is the effective view for one speaker; `listUnassigned()` is
   * the pending candidate view.
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
    addEntry,
    updateEntry,
    moveEntry,
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
    /** Every confirmed row for administration; this is NOT the recognition view. */
    listConfirmed: () => {
      const state = read();
      return decorate(state, listEntries(state));
    },
    /**
     * The effective confirmed words for one speaker: every `public` entry plus only the
     * `voiceprint` entries owned by that same confirmed self. With no self id at all (no
     * configured self and no explicit `speakerId`) the result is the public library only; a
     * configured self that does not match an explicit `speakerId` also yields public only.
     * Another self's private words never enter this list, and nothing is deleted or merged by
     * reading it.
     *
     * @param {{speakerId?: string}} [options] the confirmed self id (enrollment.selfId)
     * @returns {object[]}
     */
    listActive: ({ speakerId = undefined } = {}) => {
      const state = read();
      const views = decorate(state, listEntries(state));
      const speaker = speakerFor(speakerId);
      return views.filter((entry) => {
        if (entry.library !== 'voiceprint') return true;
        return speaker !== '' && entry.speakerId === speaker;
      });
    },
  });
}

/**
 * Confirmed entries as recognition post-processing HINTS. This is data only: `wrongForms` are the
 * misrecognised forms and `canonical` the spelling the user confirmed, but nothing here rewrites a
 * transcript. A `correction` row is applicable only where its stored `context` still matches
 * (`replaceable`), so the caller must use `applyCorrection` rather than a whole-text replacement.
 *
 * @param {object[]} entries confirmed entry views (`listActive()` / `listConfirmed()` output)
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

/**
 * The entries a recognition pass may use. The real store exposes `listActive({speakerId})`; a
 * legacy/compatible store that only has `listConfirmed()` is still accepted (its result is treated
 * as already-scoped by that caller), so old doubles and embedded callers keep working.
 *
 * @param {object|null} store
 * @param {string} [speakerId] the confirmed self id (enrollment.selfId)
 * @returns {object[]}
 */
function activeEntriesOf(store, speakerId = undefined) {
  if (store === null || store === undefined) return [];
  if (typeof store.listActive === 'function') return store.listActive({ speakerId });
  if (typeof store.listConfirmed === 'function') return store.listConfirmed();
  return [];
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
 * The recognition post-processing point: apply the effective lexicon for this speaker (public +
 * their own voiceprint entries, via `listActive`) to the text used for delivery and subtitles, and
 * report each hit as a debug `lexicon.applied` row.
 *
 * Fail-open: a missing/throwing store, a corrupt entry or a hint-building error returns the input
 * unchanged, so ASR delivery never depends on the lexicon. The raw ASR result is never rewritten
 * here; callers keep it as the archive/`rawText`.
 *
 * @param {unknown} text the delivered transcript (not the raw archive copy)
 * @param {{store?: {listActive?: (options: {speakerId?: string}) => object[],
 *   listConfirmed?: () => object[]}|null, log?: object|null, utteranceId?: string,
 *   speakerId?: string}} [options] `speakerId` is the confirmed self id; other speakers' private
 *   voiceprint rows are never applied.
 * @returns {string} the post-processed text, or `text` unchanged on any failure/no hit
 */
export function applyLexiconText(text, {
  store = null,
  log = null,
  utteranceId = '',
  speakerId = undefined,
} = {}) {
  const source = typeof text === 'string' ? text : '';
  const id = typeof utteranceId === 'string' ? utteranceId : '';
  let result;
  try {
    if (store === null || (typeof store.listActive !== 'function'
      && typeof store.listConfirmed !== 'function')) return source;
    result = applyLexiconHints(source, lexiconHints(activeEntriesOf(store, speakerId)));
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
