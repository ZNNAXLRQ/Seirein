/**
 * Lexicon assistant tool — pure local core (no DSH tool registration, no index wiring).
 *
 * The host may expose this as a model-facing tool later; this file is only the synchronous
 * decision layer between such a tool call and the existing shared-lexicon store. It:
 *   - calls a store-compatible object only through `listConfirmed`, `listCandidates`, `addEntry`,
 *     `updateEntry` and the delete method (`removeEntry`, or `remove` as the file-backed store
 *     names it); `propose` additionally needs a candidate-writing seam (`mergeCandidates` on the
 *     real store, or `addCandidate` on a compatible double);
 *   - never calls a model, the network, a clock or the filesystem itself;
 *   - never returns a stored entry directly: every entry crossing this seam is projected onto the
 *     safe view below, so `wrongForms`, `context`, `sourceIds`, `speakerId`, `embedding`, audio
 *     paths and every other internal field stay inside the store.
 *
 * Authorization is asserted by the caller, not proven here. The host must pass `user-explicit`
 * only when the user's own turn asked for the change, and `assistant-discovered` for anything the
 * assistant inferred. Missing authorization is treated as the least-privileged value.
 *
 * API:
 *
 *   runLexiconTool({store, action, authorization, ...params}) → result
 *   runLexiconTool(store, {action, authorization, ...params}) → result
 *   const tool = createLexiconTool({store});
 *   tool.run({action, ...params}); tool.add({...params}); ...
 *
 * Actions:
 *   - `query`: read-only. By `id` it is an exact lookup; by `text` it is an exact key lookup over
 *     confirmed + pending rows first, then a local recall over confirmed rows
 *     (`recallLexiconCandidates`). Any valid authorization may query.
 *   - `add`: user-explicit only. Delegates validation and the write to `store.addEntry`, so
 *     category/library/length reasons are the store's own (`invalid-category`, `text-too-long`,
 *     ...). A repeat add is `{ok:false, reason:'exists'}`. A duplicate confirmed row whose
 *     meaning (category/usage/reading/library) differs is `needs-revision` with the current safe
 *     entry in `revision`; nothing is overwritten.
 *   - `update`: user-explicit only. With an `id`, `text`/`canonical` are editable display forms
 *     exactly as in `store.updateEntry` (canonical wins when both are given). Without an id,
 *     `text` is an exact-key selector instead and `canonical` is the rename field. Other editable
 *     fields are category/usage/reading; the store validates them and owns the status refusal.
 *   - `remove`: user-explicit only. Accepts `id` or `text`; delegates to `store.remove` /
 *     `store.removeEntry`.
 *   - `propose`: the assistant-discovered write path (user-explicit may use it too). It validates
 *     its own input because the candidate seam has no store validator, refuses a confirmed row
 *     whose meaning conflicts (`needs-revision`), returns `exists` for the same confirmed word,
 *     and otherwise writes only a CANDIDATE through `store.mergeCandidates`/`addCandidate`. It
 *     never confirms a word and never edits an existing confirmed row. Its category/usage/
 *     reading/library values participate only in the conflict check: the candidate row keeps the
 *     store's candidate defaults.
 *
 * Result shape: `{ok, action, entry?, candidates?, reason?, revision?}`.
 *   - `entry`: safe view of the affected/selected entry (add/update/remove, exact query).
 *   - `candidates`: safe views (query/propose).
 *   - `reason`: a stable code (`forbidden`, `exists`, `needs-revision`, `not-found`,
 *     `text-required`, ..., or a store code passed through unchanged).
 *   - `revision`: on `needs-revision`, the safe view of the confirmed row that must be revised.
 *
 * Deliberate gaps (reported as risks, not hidden): confirming an already-pending candidate is the
 * store's `confirm()` action and is outside the interface given to this core, so an `add` of a
 * pending candidate returns `exists`; moving an entry between libraries via `update` is outside
 * `store.updateEntry`, so an update carrying `library` returns `unsupported-field` (`library` is
 * set at add time).
 */
import { lexiconKey } from './lexicon-candidates.js';
import { recallLexiconCandidates } from './lexicon-recall.js';
import {
  LEXICON_CATEGORY_MAX_CHARS,
  LEXICON_DEFAULT_CATEGORY,
  LEXICON_LIBRARIES,
  LEXICON_READING_MAX_CHARS,
  LEXICON_TEXT_MAX_CHARS,
  LEXICON_USAGE_MAX_CHARS,
} from './lexicon-store.js';

export const LEXICON_TOOL_ACTIONS = Object.freeze([
  'query',
  'add',
  'update',
  'remove',
  'propose',
]);

export const LEXICON_TOOL_AUTHORIZATIONS = Object.freeze([
  'user-explicit',
  'assistant-discovered',
]);

/** Least privilege: an omitted authorization can only read or propose. */
export const LEXICON_TOOL_DEFAULT_AUTHORIZATION = 'assistant-discovered';

/** The only fields any entry view may carry across this seam. */
export const LEXICON_TOOL_SAFE_FIELDS = Object.freeze([
  'id',
  'text',
  'canonical',
  'category',
  'usage',
  'reading',
  'library',
  'status',
  'version',
]);

/**
 * Minimum store surface every action relies on. The data-model name of the delete method is
 * `removeEntry`; the file-backed store in this checkout exposes the same operation as `remove`,
 * and both names are accepted below.
 */
export const LEXICON_TOOL_REQUIRED_STORE_METHODS = Object.freeze([
  'listConfirmed',
  'listCandidates',
  'addEntry',
  'updateEntry',
  'removeEntry',
]);

/** Names the store may use for the single delete operation. */
export const LEXICON_TOOL_REMOVE_METHODS = Object.freeze(['remove', 'removeEntry']);

/** Query recall defaults mirror the local recall engine's bounds. */
const QUERY_DEFAULT_LIMIT = 3;
const QUERY_MAX_LIMIT = 10;

const ENTRY_STATUSES = new Set(['candidate', 'confirmed', 'rejected']);
const EDITABLE_UPDATE_FIELDS = Object.freeze(['canonical', 'category', 'usage', 'reading']);

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A trimmed string, or '' for every other type. */
function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** Code-point length; invalid values count as empty. */
function codePointLength(value) {
  return typeof value === 'string' ? [...value].length : 0;
}

/** Code-point existence check that does not split a surrogate pair. */
function exceeds(value, maximum) {
  return codePointLength(value) > maximum;
}

function stableReason(result, fallback = 'store-failed') {
  return typeof result?.reason === 'string' && result.reason.length > 0
    ? result.reason
    : fallback;
}

/**
 * Project one stored entry (or a recall hit) onto the safe view. Unknown/absent fields get the
 * same conservative defaults the store itself uses; a custom free-text category is preserved
 * instead of being collapsed to `unknown`; nothing from the store's internal shape is spread into
 * the result.
 *
 * @param {unknown} entry
 * @returns {{id: string, text: string, canonical: string, category: string, usage: string,
 *   reading: string, library: string, status: string, version?: number|string}|null}
 */
function safeEntry(entry) {
  if (!plainObject(entry)) return null;
  const id = typeof entry.id === 'string'
    ? entry.id
    : (typeof entry.id === 'number' && Number.isFinite(entry.id) ? String(entry.id) : '');
  const category = text(entry.category);
  const view = {
    id,
    text: typeof entry.text === 'string' ? entry.text : '',
    canonical: typeof entry.canonical === 'string' ? entry.canonical : '',
    category: category.length > 0 ? category : LEXICON_DEFAULT_CATEGORY,
    usage: typeof entry.usage === 'string' ? entry.usage : '',
    reading: typeof entry.reading === 'string' ? entry.reading : '',
    library: LEXICON_LIBRARIES.includes(entry.library) ? entry.library : 'public',
    status: ENTRY_STATUSES.has(entry.status) ? entry.status : '',
  };
  // `version` is optional; include it only when the stored row actually carries one.
  if (typeof entry.version === 'number' && Number.isFinite(entry.version)) {
    view.version = entry.version;
  } else if (typeof entry.version === 'string' && entry.version.length > 0) {
    view.version = entry.version;
  }
  return view;
}

/** Safe views, dropping any malformed row. */
function safeEntries(entries) {
  const views = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const view = safeEntry(entry);
    if (view !== null) views.push(view);
  }
  return views;
}

function matchesKey(entry, key) {
  if (key.length === 0 || !plainObject(entry)) return false;
  return lexiconKey(entry.text) === key || lexiconKey(entry.canonical) === key;
}

function findByKey(entries, key) {
  if (key.length === 0) return null;
  for (const entry of entries) {
    if (matchesKey(entry, key)) return entry;
  }
  return null;
}

function findById(entries, id) {
  const wanted = typeof id === 'string' ? id : String(id);
  for (const entry of entries) {
    if (plainObject(entry) && String(entry.id) === wanted) return entry;
  }
  return null;
}

/** The store's delete method: the file-backed store calls it `remove`, the model `removeEntry`. */
function removeMethodOf(store) {
  for (const method of LEXICON_TOOL_REMOVE_METHODS) {
    if (typeof store[method] === 'function') return method;
  }
  return null;
}

/** Read one list from a compatible store without letting a throw escape. */
function readList(store, method) {
  let value;
  try {
    value = store[method]();
  } catch {
    return {ok: false, reason: 'store-failed'};
  }
  if (!Array.isArray(value)) return {ok: false, reason: 'store-failed'};
  return {ok: true, entries: value.filter((entry) => plainObject(entry))};
}

function readBoth(store) {
  const confirmed = readList(store, 'listConfirmed');
  if (confirmed.ok !== true) return confirmed;
  const candidates = readList(store, 'listCandidates');
  if (candidates.ok !== true) return candidates;
  return {ok: true, confirmed: confirmed.entries, candidates: candidates.entries};
}

/** Invoke one mutating store method; store throws become `store-failed`. */
function callStore(store, method, params) {
  let result;
  try {
    result = store[method](params);
  } catch {
    return {ok: false, reason: 'store-failed'};
  }
  if (!plainObject(result)) return {ok: false, reason: 'store-failed'};
  return result;
}

function failure(action, result) {
  return {ok: false, action, reason: stableReason(result)};
}

function successEntry(action, result) {
  const resultObject = {ok: true, action};
  const view = safeEntry(result.entry);
  if (view !== null) resultObject.entry = view;
  return resultObject;
}

/** The display form the caller asked for; mirrors the store (`canonical` wins over `text`). */
function requestedDisplay(call) {
  const raw = call.canonical !== undefined ? call.canonical : call.text;
  return typeof raw === 'string' ? raw.trim() : '';
}

function comparable(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Which explicitly requested fields disagree with a confirmed row. Undefined means "the caller
 * did not assert this field"; a supplied value (including an empty string/null) is compared.
 * The spelling itself is compared by `lexiconKey` before this is called, so formatting variants
 * are the same word rather than a meaning conflict.
 */
function meaningConflicts(entry, call) {
  const conflicts = [];
  if (call.category !== undefined && call.category !== entry.category) {
    conflicts.push('category');
  }
  if (call.usage !== undefined && comparable(call.usage) !== comparable(entry.usage)) {
    conflicts.push('usage');
  }
  if (call.reading !== undefined && comparable(call.reading) !== comparable(entry.reading)) {
    conflicts.push('reading');
  }
  if (call.library !== undefined) {
    // The store treats a null library as its default ("public").
    const requestedLibrary = call.library === null ? 'public' : call.library;
    if (requestedLibrary !== entry.library) conflicts.push('library');
  }
  return conflicts;
}

/**
 * Resolve the store's `exists` answer into `exists` (same meaning) or `needs-revision` (a
 * confirmed row disagrees). The store has already validated the request and refused to write.
 */
function duplicateResult(action, call, store) {
  const read = readBoth(store);
  if (read.ok !== true) return {ok: false, action, reason: 'exists'};
  const key = lexiconKey(requestedDisplay(call));

  const confirmed = findByKey(read.confirmed, key);
  if (confirmed !== null) {
    if (meaningConflicts(confirmed, call).length > 0) {
      const revision = safeEntry(confirmed);
      return revision === null
        ? {ok: false, action, reason: 'needs-revision'}
        : {ok: false, action, reason: 'needs-revision', revision};
    }
    const entry = safeEntry(confirmed);
    return entry === null
      ? {ok: false, action, reason: 'exists'}
      : {ok: false, action, reason: 'exists', entry};
  }

  const candidate = findByKey(read.candidates, key);
  if (candidate !== null) {
    const entry = safeEntry(candidate);
    return entry === null
      ? {ok: false, action, reason: 'exists'}
      : {ok: false, action, reason: 'exists', entry};
  }
  return {ok: false, action, reason: 'exists'};
}

function queryLimit(value) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    return QUERY_DEFAULT_LIMIT;
  }
  return Math.min(value, QUERY_MAX_LIMIT);
}

/** Exact id → exact text → local recall over the confirmed rows. */
function query({store, call}) {
  if (call.id !== undefined && call.id !== null) {
    const read = readBoth(store);
    if (read.ok !== true) return failure('query', read);
    const entry = findById(read.confirmed, call.id) ?? findById(read.candidates, call.id);
    if (entry === null) return {ok: false, action: 'query', reason: 'not-found'};
    const view = safeEntry(entry);
    if (view === null) return {ok: false, action: 'query', reason: 'not-found'};
    return {ok: true, action: 'query', entry: view, candidates: [view]};
  }

  const source = text(call.text ?? call.query);
  if (source.length === 0) return {ok: false, action: 'query', reason: 'text-required'};

  const read = readBoth(store);
  if (read.ok !== true) return failure('query', read);
  const limit = queryLimit(call.limit);
  const key = lexiconKey(source);

  if (key.length > 0) {
    const exact = [
      ...read.confirmed.filter((entry) => matchesKey(entry, key)),
      ...read.candidates.filter((entry) => matchesKey(entry, key)),
    ].slice(0, limit);
    if (exact.length > 0) {
      const views = safeEntries(exact);
      if (views.length > 0) {
        return {
          ok: true,
          action: 'query',
          entry: views[0],
          candidates: views,
        };
      }
    }
  }

  const recalled = recallLexiconCandidates({
    entries: read.confirmed,
    text: source,
    limit,
  });
  const candidates = [];
  for (const hit of recalled.entries) {
    const stored = hit.id === null || hit.id === undefined
      ? null
      : findById(read.confirmed, hit.id);
    const view = safeEntry(stored ?? {...hit, status: 'confirmed'});
    if (view !== null) candidates.push(view);
  }
  return {
    ok: true,
    action: 'query',
    candidates,
    ambiguous: recalled.ambiguous === true,
  };
}

/** User-explicit add; all field validation and the write are the store's. */
function add({store, call}) {
  const params = {};
  for (const field of ['text', 'canonical', 'category', 'usage', 'reading', 'library']) {
    if (call[field] !== undefined) params[field] = call[field];
  }
  const result = callStore(store, 'addEntry', params);
  if (result.ok === true) return successEntry('add', result);
  if (result.reason === 'exists') return duplicateResult('add', call, store);
  return failure('add', result);
}

/** User-explicit update; validation (and the refusal to touch status) is the store's. */
function update({store, call}) {
  // `library` is deliberately add-only: the given store interface has no moveEntry seam here.
  if (call.library !== undefined) {
    return {ok: false, action: 'update', reason: 'unsupported-field'};
  }
  const fields = {};
  for (const field of EDITABLE_UPDATE_FIELDS) {
    if (call[field] !== undefined) fields[field] = call[field];
  }

  let id = call.id;
  const hasId = id !== undefined && id !== null;
  if (hasId && call.text !== undefined) {
    // Store semantics: an id-addressed update may rename via `text` (canonical still wins).
    fields.text = call.text;
  }
  if (!hasId) {
    const selector = text(call.text);
    if (selector.length === 0) return {ok: false, action: 'update', reason: 'id-required'};
    const read = readBoth(store);
    if (read.ok !== true) return failure('update', read);
    const key = lexiconKey(selector);
    const target = findByKey(read.confirmed, key) ?? findByKey(read.candidates, key);
    if (target === null) return {ok: false, action: 'update', reason: 'not-found'};
    id = target.id;
  }

  const result = callStore(store, 'updateEntry', {id, ...fields});
  if (result.ok === true) return successEntry('update', result);
  return failure('update', result);
}

/** User-explicit remove; the store owns id/text resolution and the delete. */
function remove({store, call}) {
  const method = removeMethodOf(store);
  if (method === null) return {ok: false, action: 'remove', reason: 'invalid-store'};
  const params = {};
  if (call.id !== undefined) params.id = call.id;
  if (call.text !== undefined) params.text = call.text;

  // A text-addressed store.remove() returns the row after it was spliced out, so its manual
  // fields degrade to defaults. Capture the pre-delete view by id for an accurate safe view.
  const read = readBoth(store);
  const before = read.ok === true ? [...read.confirmed, ...read.candidates] : [];

  const result = callStore(store, method, params);
  if (result.ok === true) {
    const removedId = result.entry?.id;
    const captured = removedId === undefined || removedId === null
      ? null
      : findById(before, removedId);
    return successEntry('remove', captured === null ? result : {ok: true, entry: captured});
  }
  return failure('remove', result);
}

/** Optional local validation for the proposal path (the candidate seam has no validator). */
function proposal(call) {
  const display = requestedDisplay(call);
  if (display.length === 0) return {ok: false, reason: 'text-required'};
  if (exceeds(display, LEXICON_TEXT_MAX_CHARS)) return {ok: false, reason: 'text-too-long'};
  if (call.category !== undefined && call.category !== null) {
    if (typeof call.category !== 'string'
      || exceeds(call.category.trim(), LEXICON_CATEGORY_MAX_CHARS)) {
      return {ok: false, reason: 'invalid-category'};
    }
  }
  if (call.library !== undefined && call.library !== null
    && (typeof call.library !== 'string' || !LEXICON_LIBRARIES.includes(call.library))) {
    return {ok: false, reason: 'invalid-library'};
  }

  if (call.usage !== undefined && call.usage !== null) {
    if (typeof call.usage !== 'string' || exceeds(call.usage.trim(), LEXICON_USAGE_MAX_CHARS)) {
      return {ok: false, reason: 'invalid-usage'};
    }
  }

  if (call.reading !== undefined && call.reading !== null) {
    if (typeof call.reading !== 'string'
      || exceeds(call.reading.trim(), LEXICON_READING_MAX_CHARS)) {
      return {ok: false, reason: 'invalid-reading'};
    }
  }

  return {ok: true, display};
}

/**
 * Write one CANDIDATE. The real store's `mergeCandidates` is preferred; an alternative
 * `addCandidate(candidate)` seam is accepted for a compatible double. Neither can confirm a row.
 */
function writeCandidate(store, candidate) {
  if (typeof store.mergeCandidates === 'function') {
    let result;
    try {
      result = store.mergeCandidates([candidate]);
    } catch {
      return {ok: false, reason: 'store-failed'};
    }
    if (!plainObject(result)) return {ok: false, reason: 'store-failed'};
    if (result.ok === false) return {ok: false, reason: stableReason(result)};
    return {ok: true, result};
  }
  if (typeof store.addCandidate === 'function') {
    let result;
    try {
      result = store.addCandidate(candidate);
    } catch {
      return {ok: false, reason: 'store-failed'};
    }
    if (plainObject(result) && result.ok === false) {
      return {ok: false, reason: stableReason(result)};
    }
    return {ok: true, result: plainObject(result) ? result : {}};
  }
  return {ok: false, reason: 'unsupported-store'};
}

function countOf(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** The assistant-discovered path: candidate only, no confirmation and no confirmed-row edit. */
function propose({store, call}) {
  const prepared = proposal(call);
  if (prepared.ok !== true) {
    return {ok: false, action: 'propose', reason: prepared.reason};
  }

  const read = readBoth(store);
  if (read.ok !== true) return failure('propose', read);
  const key = lexiconKey(prepared.display);
  const confirmed = findByKey(read.confirmed, key);
  if (confirmed !== null) {
    if (meaningConflicts(confirmed, call).length > 0) {
      const revision = safeEntry(confirmed);
      return revision === null
        ? {ok: false, action: 'propose', reason: 'needs-revision'}
        : {ok: false, action: 'propose', reason: 'needs-revision', revision};
    }
    const entry = safeEntry(confirmed);
    return entry === null
      ? {ok: false, action: 'propose', reason: 'exists'}
      : {ok: false, action: 'propose', reason: 'exists', entry};
  }

  const candidate = {
    text: prepared.display,
    kind: call.kind === 'correction' ? 'correction' : 'proper-noun',
    sourceIds: Array.isArray(call.sourceIds) ? call.sourceIds : [],
  };
  if (candidate.kind === 'correction') {
    candidate.wrongForms = Array.isArray(call.wrongForms) ? call.wrongForms : [];
    if (call.context !== undefined) candidate.context = call.context;
    if (call.speakerId !== undefined) candidate.speakerId = call.speakerId;
    candidate.ambiguous = call.ambiguous === true;
  }
  if (call.at !== undefined) candidate.at = call.at;

  const written = writeCandidate(store, candidate);
  if (written.ok !== true) return {ok: false, action: 'propose', reason: written.reason};

  const added = countOf(written.result.added);
  const merged = countOf(written.result.merged);
  const skipped = countOf(written.result.skipped);
  if (skipped > 0 && added + merged === 0) {
    return {ok: false, action: 'propose', reason: 'rejected'};
  }

  const listed = readList(store, 'listCandidates');
  if (listed.ok === true) {
    const views = safeEntries(listed.entries.filter((entry) => matchesKey(entry, key)));
    if (views.length > 0) return {ok: true, action: 'propose', candidates: views};
  }
  const direct = safeEntry(written.result.entry);
  if (direct !== null) return {ok: true, action: 'propose', candidates: [direct]};
  // The write reported success but no candidate is visible: do not claim a verified proposal.
  return {ok: false, action: 'propose', reason: 'store-failed'};
}

/** One plain-object call, with an optional nested `params` object flattened underneath. */
function normalizeCall(value) {
  if (!plainObject(value)) return {};
  if (!plainObject(value.params)) return value;
  return {...value.params, ...value};
}

function actionOf(value) {
  const action = text(value?.action);
  return action.length > 0 ? action : null;
}

/**
 * Create the action set for one store. Throws `TypeError` when the store is missing one of the
 * five required methods; per-call store failures are returned as `store-failed` instead.
 *
 * @param {{store: object}} options
 * @returns {Readonly<{run: Function, query: Function, add: Function, update: Function,
 *   remove: Function, propose: Function}>}
 */
export function createLexiconTool({store} = {}) {
  if (!plainObject(store)) throw new TypeError('lexicon tool: store is required');
  for (const method of LEXICON_TOOL_REQUIRED_STORE_METHODS) {
    if (method === 'removeEntry' && removeMethodOf(store) !== null) continue;
    if (typeof store[method] !== 'function') {
      throw new TypeError(`lexicon tool: store.${method} must be a function`);
    }
  }

  const run = (value = {}) => {
    const call = normalizeCall(value);
    const action = actionOf(call);
    if (action === null || !LEXICON_TOOL_ACTIONS.includes(action)) {
      return {ok: false, action, reason: 'invalid-action'};
    }
    const authorization = call.authorization === undefined
      ? LEXICON_TOOL_DEFAULT_AUTHORIZATION
      : text(call.authorization);
    if (!LEXICON_TOOL_AUTHORIZATIONS.includes(authorization)) {
      return {ok: false, action, reason: 'invalid-authorization'};
    }
    // Discovery may read and propose; only an explicit user request may add/update/remove.
    if (authorization === 'assistant-discovered' && action !== 'query' && action !== 'propose') {
      return {ok: false, action, reason: 'forbidden'};
    }

    switch (action) {
      case 'query':
        return query({store, call});
      case 'add':
        return add({store, call});
      case 'update':
        return update({store, call});
      case 'remove':
        return remove({store, call});
      case 'propose':
        return propose({store, call});
      default:
        return {ok: false, action, reason: 'invalid-action'};
    }
  };

  const bound = (action) => (params = {}) => run({...params, action});
  return Object.freeze({
    run,
    query: bound('query'),
    add: bound('add'),
    update: bound('update'),
    remove: bound('remove'),
    propose: bound('propose'),
  });
}

/**
 * One-shot convenience entry point. Accepts either the options object
 * `{store, action, authorization, ...params}` or `(store, {action, ...params})`.
 *
 * @param {unknown} input
 * @param {unknown} [callArg]
 * @returns {{ok: boolean, action: string|null, entry?: object, candidates?: object[],
 *   reason?: string, revision?: object, ambiguous?: boolean}}
 */
export function runLexiconTool(input, callArg) {
  let store;
  let call;
  if (plainObject(input) && Object.prototype.hasOwnProperty.call(input, 'store')) {
    store = input.store;
    call = normalizeCall(input);
  } else if (plainObject(input) && (LEXICON_TOOL_REQUIRED_STORE_METHODS
    .some((method) => typeof input[method] === 'function') || removeMethodOf(input) !== null)) {
    store = input;
    call = normalizeCall(callArg);
  } else {
    store = null;
    call = plainObject(callArg) ? normalizeCall(callArg) : normalizeCall(input);
  }

  const action = actionOf(call);
  if (!plainObject(store)) return {ok: false, action, reason: 'invalid-store'};
  let tool;
  try {
    tool = createLexiconTool({store});
  } catch (error) {
    if (error instanceof TypeError) return {ok: false, action, reason: 'invalid-store'};
    throw error;
  }
  return tool.run(call);
}

export default runLexiconTool;
