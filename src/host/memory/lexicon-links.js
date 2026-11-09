/**
 * Memory ↔ shared-lexicon links (pure module, no persistence).
 *
 * A memory record may carry `lexiconIds: string[]`: stable lexicon entry ids the record is
 * ABOUT. The record never stores a copy of the entry's spelling/explanation — the lexicon stays
 * the single source of truth, and this module only answers "which current entries are linked?".
 *
 * Rules:
 *   - an id is a non-empty string after trimming; everything else (numbers, null, objects,
 *     empty/whitespace strings) is dropped, not coerced;
 *   - ids are de-duplicated while preserving first-seen order, and one record keeps at most
 *     `MEMORY_LEXICON_MAX_IDS` ids;
 *   - merging is a set union (existing first, then new ids), de-duplicated, order-preserving and
 *     capped at the same limit;
 *   - composition maps ids to a SAFE VIEW of the current entry: `id/text/canonical/category/
 *     usage` only. Internal fields (`status`, `wrongForms`, `sourceIds`, `reading`, ...) never
 *     leave this module.
 *
 * Pure: every function is synchronous, performs no I/O, calls no model, writes no memory and
 * never mutates its arguments. Missing ids and deleted/non-confirmed entries are simply skipped;
 * a broken input can only produce `[]`, never an exception.
 */

/** One record's association list is bounded, so a memory row cannot carry an unbounded link set. */
export const MEMORY_LEXICON_MAX_IDS = 8;

/** A plain non-array object; maps and arrays are handled explicitly by their callers. */
function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * One id in canonical form, or `null` when the value is not a usable id.
 * @param {unknown} value
 * @returns {string|null}
 */
function cleanId(value) {
  if (typeof value !== 'string') return null;
  const id = value.trim();
  return id.length === 0 ? null : id;
}

/**
 * Normalize one record's `lexiconIds` value.
 *
 * Only an array is accepted. Each item must be a non-empty string after trimming; bad items are
 * dropped. Duplicates keep their first position, and the result is capped at
 * `MEMORY_LEXICON_MAX_IDS` in input order.
 *
 * @param {unknown} value raw `lexiconIds` (or any untrusted value)
 * @returns {string[]} a fresh array; never the input
 */
export function normalizeLexiconIds(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const ids = [];
  for (const item of value) {
    const id = cleanId(item);
    if (id === null || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length >= MEMORY_LEXICON_MAX_IDS) break;
  }
  return ids;
}

/**
 * Union two association lists. Existing ids keep their order, new ids are appended in their own
 * order, duplicates collapse to the first occurrence and the union stops at the limit.
 *
 * @param {unknown} existing current `lexiconIds`
 * @param {unknown} incoming ids to add
 * @returns {string[]} a fresh array
 */
export function mergeLexiconIds(existing, incoming) {
  // Normalizing each side first is safe: anything beyond the per-record cap could never fit in
  // the capped union either, because existing ids always win.
  return normalizeLexiconIds([
    ...normalizeLexiconIds(existing),
    ...normalizeLexiconIds(incoming),
  ]);
}

/**
 * Remove every occurrence of one id. The target is trimmed like stored ids; an unusable target
 * leaves a normalized copy untouched.
 *
 * @param {unknown} ids current `lexiconIds`
 * @param {unknown} id id to remove
 * @returns {string[]} a fresh array
 */
export function removeLexiconId(ids, id) {
  const dropped = cleanId(id);
  if (dropped === null) return normalizeLexiconIds(ids);
  if (!Array.isArray(ids)) return [];
  // Remove first, then normalize: a pre-existing over-limit list must not lose an unrelated id
  // merely because the removed one happened to sit inside the first eight positions.
  return normalizeLexiconIds(ids.filter((item) => cleanId(item) !== dropped));
}

/**
 * Whether one record is linked to `id`, using the same normalization as storage. A record with a
 * missing or malformed `lexiconIds` field is not linked; the record itself is never changed.
 *
 * @param {unknown} record memory record
 * @param {unknown} id lexicon entry id
 * @returns {boolean}
 */
export function recordHasLexicon(record, id) {
  const wanted = cleanId(id);
  if (wanted === null || !plainObject(record)) return false;
  return normalizeLexiconIds(record.lexiconIds).includes(wanted);
}

/**
 * Read one entry from a `Map` or a plain object keyed by id. A prototype property is never a hit,
 * and a malformed container reads as "no entries".
 *
 * @param {unknown} entriesById
 * @param {string} id
 * @returns {unknown}
 */
function lookupEntry(entriesById, id) {
  if (entriesById instanceof Map) return entriesById.get(id);
  if (plainObject(entriesById) && Object.hasOwn(entriesById, id)) return entriesById[id];
  return undefined;
}

/**
 * The public, safe projection of one current entry, or `null` when the row is not a usable entry.
 * Exactly five fields are copied; the entry is not modified and no field is inferred beyond the
 * documented defaults for missing/ill-typed values.
 *
 * @param {unknown} entry
 * @param {string} id the id the record linked to
 * @returns {{id: string, text: string, canonical: string, category: string, usage: string}|null}
 */
function safeEntryView(entry, id) {
  if (!plainObject(entry)) return null;
  if (entry.deleted === true) return null;
  // A lookup map built from the public store only carries current entries. When an entry still
  // exposes status, anything but `confirmed` is not an effective word (candidate/rejected).
  if (typeof entry.status === 'string' && entry.status.length > 0 && entry.status !== 'confirmed') {
    return null;
  }
  if (typeof entry.id === 'string' && entry.id.length > 0 && entry.id !== id) return null;

  const text = typeof entry.text === 'string' ? entry.text : '';
  const canonical = typeof entry.canonical === 'string' ? entry.canonical : '';
  if (text.trim().length === 0 && canonical.trim().length === 0) return null;

  return {
    id,
    text,
    canonical,
    category: typeof entry.category === 'string' && entry.category.length > 0 ? entry.category : 'unknown',
    usage: typeof entry.usage === 'string' ? entry.usage : '',
  };
}

/**
 * Collect the safe views of the current lexicon entries linked from a set of memories.
 *
 * Ids are gathered in memory order, then record order; each id is looked up once and each entry
 * appears once even when several memories link it. A missing id (including a deleted entry) or a
 * non-current/malformed entry is skipped. Records and the lookup container are never modified.
 *
 * @param {unknown} records memory records (each may carry `lexiconIds`)
 * @param {unknown} entriesById `Map` or plain object of current entries keyed by id
 * @returns {Array<{id: string, text: string, canonical: string, category: string, usage: string}>}
 */
export function composeMemoryLexiconRefs(records, entriesById) {
  if (!Array.isArray(records)) return [];
  const seen = new Set();
  const refs = [];
  for (const record of records) {
    if (!plainObject(record)) continue;
    for (const id of normalizeLexiconIds(record.lexiconIds)) {
      if (seen.has(id)) continue;
      seen.add(id);
      const view = safeEntryView(lookupEntry(entriesById, id), id);
      if (view !== null) refs.push(view);
    }
  }
  return refs;
}
