/**
 * P-52 marker layer: the candidate/delivered split as ONE aggregate view per injection.
 *
 * Why a separate layer: `memory.recall` says what retrieval found and `memory.injection` counts
 * the delivered kinds, but neither can say *which* prepared item was adopted and which was left
 * behind. The split is the same fact the injection already computed, exposed once per turn:
 *
 *   - `candidate` — recalled, ranked and prepared, but NOT adopted into this request's context;
 *   - `delivered` — the item's line was actually written into the request context.
 *
 * The two marks are disjoint and their sum is the prepared set, so
 * `adoptRate = delivered / prepared` (0 when nothing was prepared). A plain recall miss prepares
 * nothing and writes neither line — the same quiet-recall rule `memory.assembly` already follows.
 *
 * Everything here is a pure projection over what the caller already prepared: no I/O, no config,
 * no event, no state, and never the body. The caller (`prepareMemoryInjection`) passes the
 * prepared rows plus the ids the block actually rendered; this module decides nothing about
 * memory content, budgets or writes. The old events stay untouched and can be reconciled:
 * `memory.recall.records` equals the delivered item count, and
 * `candidate + delivered = prepared <= memory.recall.hits`.
 *
 * Item shape (metadata only, stable field order, no `text`):
 *   `{ id, kind, source, rank, score, chars, entityKey? }`
 *   - `id`    stable record id (`messageId` fallback for a message-level row);
 *   - `kind`  `fixed` / `hit` / `pair` / `neighbor` / `link` / `upcoming`;
 *   - `source` the record's origin (`manual` / `auto` / …), '' when unknown;
 *   - `rank`  1-based position in the prepared order (the exact order the budget saw);
 *   - `score` the retrieval score, 0 when the lane did not score the row;
 *   - `chars` the rendered width it was (or would have been) charged, labels and separator
 *             included — never the body itself;
 *   - `entityKey` optional; absent unless the row already carries one (entity linking is a
 *             different task, so this layer never invents a key).
 */

/** Event names of the aggregate view. Kept here so the caller cannot misspell them. */
export const MEMORY_ITEM_CANDIDATE_EVENT = 'memory.item.candidate';
export const MEMORY_ITEM_DELIVERED_EVENT = 'memory.item.delivered';

/** Rounded adoption ratio in [0, 1], 0 when nothing was prepared. */
export function memoryAdoptRate(delivered, prepared) {
  const total = Math.floor(Number(prepared));
  if (!Number.isFinite(total) || total <= 0) return 0;
  const adopted = Math.max(0, Math.min(total, Math.floor(Number(delivered)) || 0));
  return Math.round((adopted / total) * 1000) / 1000;
}

/** The stable identity of one row: its record id, else its source message id. */
function rowIdOf(row) {
  if (typeof row?.id === 'string' && row.id.length > 0) return row.id;
  if (typeof row?.messageId === 'string' && row.messageId.length > 0) return row.messageId;
  return '';
}

/**
 * One marked item. `kind` from the caller wins over the row's own `kind` because the fixed layer
 * lives under a domain `kind` (e.g. `fact`) and must still read as `fixed`; `chars` is the width
 * the caller charged, never a re-measure of the body.
 *
 * @param {object} row the prepared row (body ignored)
 * @param {{rank?: number, kind?: string|null, chars?: number}} [mark]
 * @returns {{id: string, kind: string, source: string, rank: number, score: number, chars: number,
 *            entityKey?: string}}
 */
export function memoryItemMarker(row, { rank = 0, kind = null, chars = 0 } = {}) {
  const explicit = typeof kind === 'string' && kind.length > 0 ? kind : null;
  const own = typeof row?.kind === 'string' && row.kind.length > 0 ? row.kind : 'hit';
  const score = Number(row?.score);
  const item = {
    id: rowIdOf(row),
    kind: explicit ?? own,
    source: typeof row?.source === 'string' ? row.source : '',
    rank: Number.isInteger(rank) && rank > 0 ? rank : 0,
    score: Number.isFinite(score) ? Math.round(score * 100) / 100 : 0,
    chars: Math.max(0, Math.floor(Number(chars) || 0)),
  };
  if (typeof row?.entityKey === 'string' && row.entityKey.length > 0) item.entityKey = row.entityKey;
  return item;
}

/**
 * Split one prepared set into its candidate and delivered marks.
 *
 * Duplicate ids are collapsed to their first prepared position (a stable id marks one item once,
 * however many lanes produced it), and `rank` is the 1-based position in that deduped prepared
 * order — so two calls over the same input return the same ids and the same ranks.
 *
 * @param {{turn?: number, prepared?: Array<{row?: object, kind?: string, chars?: number}|object>,
 *          deliveredIds?: string[]}} [input] `prepared` in budget order; `deliveredIds` exactly
 *          the ids the block rendered
 * @returns {{turn: number, prepared: number, candidate: object[], delivered: object[],
 *            adoptRate: number}}
 */
export function composeMemoryItemMarkers({ turn = 0, prepared = [], deliveredIds = [] } = {}) {
  const adopted = new Set(
    (Array.isArray(deliveredIds) ? deliveredIds : [])
      .map((id) => (typeof id === 'string' ? id : ''))
      .filter((id) => id.length > 0),
  );
  const items = [];
  const seen = new Set();
  for (const entry of Array.isArray(prepared) ? prepared : []) {
    const row = entry !== null && typeof entry === 'object' && entry.row !== undefined ? entry.row : entry;
    const item = memoryItemMarker(row, {
      rank: items.length + 1,
      kind: typeof entry?.kind === 'string' ? entry.kind : null,
      chars: Number(entry?.chars) || 0,
    });
    if (item.id.length === 0 || seen.has(item.id)) continue;
    seen.add(item.id);
    items.push(item);
  }
  const delivered = items.filter((item) => adopted.has(item.id));
  const candidate = items.filter((item) => !adopted.has(item.id));
  return {
    turn: Number.isInteger(turn) && turn >= 0 ? turn : 0,
    prepared: items.length,
    candidate,
    delivered,
    adoptRate: memoryAdoptRate(delivered.length, items.length),
  };
}
