/**
 * ProfileStore: the persona (agent) and user profile (user) as independently maintainable
 * entries, one tendency per row.
 *
 * Why a separate store:
 *  - The four `profile_*` tables are independent of `memory_event`. They may live in the same
 *    SQLite file (the Host passes `memory.db`), but they are never counted by
 *    `MemoryStore.usage()` / `capacity()` and are never recalled as memories. The profile
 *    library has its own fixed budget: `adoptionQuota × 4` stages (default 24 → 96 entries).
 *  - The fifth stage does not archive. When `used` exceeds `cap`, the lowest-clarity entries
 *    are deleted outright, so the library can never grow past its budget. Locked entries are
 *    evicted last (never while an unlocked entry is left), because the cap is still a hard
 *    limit.
 *
 * This step owns the schema, the edit API and the import of text the agent has already split
 * into items; the host itself never splits persona/profile text. Scoring, selection and prompt
 * compilation are pure functions in `profileRank.js` (step 2) — this class only reads evidence
 * and persists the values they derive.
 *
 * Every mutation runs in one `BEGIN IMMEDIATE` transaction. When the caller already opened a
 * transaction on the same connection (e.g. a MemoryStore transaction), the store joins it and
 * leaves the commit/rollback to the owner — a partial failure still never commits.
 *
 * Evidence identity is persistent: `profile_evidence_identity` records `(entry, session, turn,
 * role)` or the message-id fallback, so a restart cannot count the same exchange twice. Explicit
 * removals write `deleted_persona` evidence boundaries; merges are previewed read-only first and
 * applied under a library-version check.
 */
import { createHash, randomUUID } from 'node:crypto';

import {
  applyRankEvent,
  independentSupportCount,
  independentSupportIds,
  profileScore,
  rankAndCompile,
  resolveProfileRankConfig,
  selectProfileEntries,
} from './profileRank.js';

/** Which profile a row belongs to. */
export const PROFILE_SIDES = Object.freeze(['agent', 'user']);

/**
 * Life stages. `original` is the imported baseline (原订); the other three are the later
 * adoption stages. Stage promotion is step 2's scoring/budget compiler — step 1 only reports
 * and filters by the stored value.
 */
export const PROFILE_RANKS = Object.freeze(['original', 'new', 'candidate', 'sinking']);

/** Revision authors. `import` covers the agent-split baseline import and upsert refreshes. */
export const PROFILE_SOURCES = Object.freeze(['user', 'agent', 'import']);

/** Default adoption quota: 24 adopted entries per stage, four stages → cap 96. */
export const PROFILE_DEFAULT_ADOPTION_QUOTA = 24;

/** Neutral scores for a first write; a later scoring pass overwrites them. */
export const PROFILE_DEFAULT_CLARITY = 50;
export const PROFILE_DEFAULT_EFFICACY = 50;

/** A user edit reaches the adoption line immediately; it never lowers an already higher C. */
export const PROFILE_USER_EDIT_CLARITY = 60;

/** Fields an edit may touch, in a stable order (the diff and its revision follow it). */
const EDITABLE_FIELDS = Object.freeze(['category', 'tags', 'text', 'clarity', 'efficacy', 'rank']);

const nowIso = () => new Date().toISOString();

const cleanText = (value) => String(value ?? '').trim();

/** 0..100 integer score; an absent/invalid value falls back instead of throwing. */
const clampScore = (value, fallback) => {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(100, Math.round(number)));
};

/** Tags are stored as a comma-separated string so one row stays a plain SQLite value. */
const normalizeTags = (value) => {
  const parts = Array.isArray(value) ? value : String(value ?? '').split(',');
  return parts
    .map((part) => String(part ?? '').trim())
    .filter((part) => part.length > 0)
    .join(',');
};

const normalizeRank = (value, fallback) => {
  if (value === undefined || value === null || value === '') return fallback;
  if (!PROFILE_RANKS.includes(value)) throw new Error(`unknown profile rank: ${String(value)}`);
  return value;
};

/**
 * Normalize one editable field for the diff. An absent value keeps the current one, so a patch
 * that only mentions `clarity` can never blank out `tags`.
 */
const normalizeEditable = (field, value, current) => {
  if (value === undefined) return current;
  switch (field) {
    case 'clarity':
    case 'efficacy':
      return clampScore(value, current);
    case 'rank':
      return normalizeRank(value, current);
    case 'tags':
      return normalizeTags(value);
    default:
      return cleanText(value);
  }
};

/**
 * Identity of a tendency: side + whitespace/case-normalized text. The same sentence re-imported
 * after a reject must map to the same fingerprint, so the tombstone can refuse it.
 */
export function profileFingerprint(side, text) {
  const normalized = cleanText(text).replace(/\s+/gu, ' ').toLowerCase();
  return createHash('sha256').update(`${side}\n${normalized}`).digest('hex').slice(0, 32);
}

/**
 * Persistent evidence identity. A reliable turn identity is `(session, turn, role)`; when any
 * part is missing the message id is the fallback. The string is also what the deletion ledger
 * stores, so a later backlog read can ask "was this exact evidence deleted?".
 */
export function profileEvidenceKey(evidence = {}) {
  if (evidence === null || typeof evidence !== 'object') return null;
  const sessionId = cleanText(evidence.sessionId ?? evidence.session_id);
  const turnId = cleanText(evidence.turnId ?? evidence.turn_id);
  const role = cleanText(evidence.role);
  if (sessionId.length > 0 && turnId.length > 0 && role.length > 0) {
    return `session:${sessionId}\nturn:${turnId}\nrole:${role}`;
  }
  const messageId = evidence.messageId ?? evidence.message_id;
  if (messageId !== null && messageId !== undefined && String(messageId).trim().length > 0) {
    return `message:${String(messageId)}`;
  }
  return null;
}

/** One evidence sample as the store records it (snake_case and camelCase inputs both work). */
const normalizeEvidence = (evidence) => {
  const input = evidence !== null && typeof evidence === 'object' ? evidence : {};
  const kind = input.kind ?? 'support';
  if (kind !== 'support' && kind !== 'contra') throw new Error(`unknown evidence kind: ${String(kind)}`);
  const sessionId = cleanText(input.sessionId ?? input.session_id);
  const turnId = cleanText(input.turnId ?? input.turn_id);
  const role = cleanText(input.role);
  const messageId = input.messageId ?? input.message_id ?? null;
  return {
    kind,
    sessionId,
    turnId,
    role,
    messageId: messageId === null || messageId === undefined || String(messageId).trim().length === 0
      ? null
      : String(messageId),
    hasTurn: sessionId.length > 0 && turnId.length > 0 && role.length > 0,
    at: input.at ?? nowIso(),
    note: String(input.note ?? ''),
  };
};

/** 0 when absent/non-numeric; a negative number means a contradiction. */
const deltaNumber = (delta, key) => {
  if (delta === null || typeof delta !== 'object') return 0;
  const value = delta[key] ?? delta[`${key}Delta`];
  if (value === undefined || value === null || value === '') return 0;
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
};

const normalizeIdList = (value) => {
  const input = Array.isArray(value) ? value : [value];
  const ids = [];
  const seen = new Set();
  for (const item of input) {
    const id = cleanText(item);
    if (id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
};

const parseStringArray = (value) => {
  try {
    const parsed = JSON.parse(String(value ?? '[]'));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
};

/** Merge target = highest S, then oldest, then lowest id (same deterministic order as rank). */
const compareMergeCandidates = (left, right) => {
  const scoreDiff = profileScore(right) - profileScore(left);
  if (scoreDiff !== 0) return scoreDiff;
  const leftAt = String(left.created_at ?? left.createdAt ?? '');
  const rightAt = String(right.created_at ?? right.createdAt ?? '');
  if (leftAt !== rightAt) return leftAt < rightAt ? -1 : 1;
  return String(left.id).localeCompare(String(right.id));
};

const deletedIdentity = (identity) => {
  if (typeof identity === 'string') return identity;
  if (identity === null || typeof identity !== 'object') return '';
  if (typeof identity.identity === 'string') return identity.identity;
  if (typeof identity.fingerprint === 'string') return identity.fingerprint;
  if (typeof identity.side === 'string' && typeof identity.text === 'string') {
    return profileFingerprint(identity.side, identity.text);
  }
  return '';
};

/** Revisions store a partial-field diff as JSON; a corrupt/legacy value reads as "no fields". */
const parseDiff = (value) => {
  try {
    const parsed = JSON.parse(value);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

/** One `profile_entry` row as the JS API exposes it (booleans instead of 0/1). */
const toEntry = (row) => {
  if (row === undefined) return null;
  return { ...row, locked: row.locked === 1, rejected: row.rejected === 1 };
};

/**
 * Schema. Every statement is idempotent: a store may be constructed repeatedly against the
 * same file (the Host creates it lazily, tests reopen it).
 */
const SCHEMA = Object.freeze([
  `CREATE TABLE IF NOT EXISTS profile_entry (
    id TEXT PRIMARY KEY,
    side TEXT NOT NULL CHECK (side IN ('agent', 'user')),
    category TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '',
    text TEXT NOT NULL,
    clarity INTEGER NOT NULL DEFAULT 50,
    efficacy INTEGER NOT NULL DEFAULT 50,
    rank TEXT NOT NULL DEFAULT 'new' CHECK (rank IN ('original', 'new', 'candidate', 'sinking')),
    evidence_count INTEGER NOT NULL DEFAULT 0,
    version INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL,
    locked INTEGER NOT NULL DEFAULT 0,
    rejected INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS profile_entry_side_category ON profile_entry(side, category)',
  'CREATE INDEX IF NOT EXISTS profile_entry_rejected ON profile_entry(rejected)',
  `CREATE TABLE IF NOT EXISTS profile_evidence (
    id TEXT PRIMARY KEY,
    entry_id TEXT NOT NULL,
    message_id TEXT,
    kind TEXT NOT NULL CHECK (kind IN ('support', 'contra')),
    at TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT ''
  )`,
  'CREATE INDEX IF NOT EXISTS profile_evidence_entry ON profile_evidence(entry_id)',
  // Persistent evidence identity. The ledger is the dedupe authority; `profile_evidence` stays the
  // row the ranking functions read. The partial indexes make the same (entry, session, turn, role)
  // and the message-id fallback unique at the storage layer, not only in JS.
  `CREATE TABLE IF NOT EXISTS profile_evidence_identity (
    id TEXT PRIMARY KEY,
    entry_id TEXT NOT NULL,
    tendency TEXT NOT NULL,
    session_id TEXT NOT NULL DEFAULT '',
    turn_id TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL DEFAULT '',
    message_id TEXT,
    evidence_id TEXT,
    kind TEXT NOT NULL CHECK (kind IN ('support', 'contra')),
    source TEXT NOT NULL DEFAULT 'evidence',
    created_at TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS profile_evidence_identity_entry ON profile_evidence_identity(entry_id)',
  `CREATE UNIQUE INDEX IF NOT EXISTS profile_evidence_identity_turn
     ON profile_evidence_identity(entry_id, session_id, turn_id, role)
     WHERE session_id <> '' AND turn_id <> '' AND role <> ''`,
  `CREATE UNIQUE INDEX IF NOT EXISTS profile_evidence_identity_message
     ON profile_evidence_identity(entry_id, message_id)
     WHERE message_id IS NOT NULL AND message_id <> ''`,
  // Explicit deletion boundary. Not a permanent ban and never auto-purged; `purgeDeleted` is the
  // only cleanup path.
  `CREATE TABLE IF NOT EXISTS deleted_persona (
    id TEXT PRIMARY KEY,
    identity TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    side TEXT NOT NULL DEFAULT '',
    entry_id TEXT NOT NULL DEFAULT '',
    deleted_at TEXT NOT NULL,
    evidence_ids TEXT NOT NULL DEFAULT '[]'
  )`,
  'CREATE INDEX IF NOT EXISTS deleted_persona_identity ON deleted_persona(identity)',
  'CREATE INDEX IF NOT EXISTS deleted_persona_deleted_at ON deleted_persona(deleted_at)',
  `CREATE TABLE IF NOT EXISTS profile_revision (
    id TEXT PRIMARY KEY,
    entry_id TEXT NOT NULL,
    before TEXT NOT NULL,
    after TEXT NOT NULL,
    at TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('user', 'agent', 'import'))
  )`,
  'CREATE INDEX IF NOT EXISTS profile_revision_entry ON profile_revision(entry_id, at)',
  // One tombstone per fingerprint: a rejected tendency can never be regenerated from old
  // evidence, even if the same text arrives with a different message id.
  `CREATE TABLE IF NOT EXISTS profile_reject (
    id TEXT PRIMARY KEY,
    fingerprint TEXT NOT NULL,
    text TEXT NOT NULL,
    at TEXT NOT NULL
  )`,
  'CREATE UNIQUE INDEX IF NOT EXISTS profile_reject_fingerprint ON profile_reject(fingerprint)',
]);

export class ProfileStore {
  /**
   * @param {object} options
   * @param {import('node:sqlite').DatabaseSync} options.db already-open connection (the store
   *   never opens or closes it — the Host shares `memory.db`, tests own their own file).
   * @param {number} [options.capacity] total cap override; defaults to `adoptionQuota * 4`.
   * @param {number} [options.adoptionQuota] per-stage adoption quota; default 24.
   * @param {(type: string, payload: object) => void|Promise} [options.emit] diagnostics sink; the
   *   maintainer attaches its own through `attachEmitter`, tests may pass one directly.
   */
  constructor({ db, capacity, adoptionQuota, emit } = {}) {
    if (db === null || typeof db !== 'object' || typeof db.prepare !== 'function' || typeof db.exec !== 'function') {
      throw new TypeError('createProfileStore 需要调用方传入已打开的 node:sqlite DatabaseSync（db）');
    }
    const quota = Number.isFinite(Number(adoptionQuota)) && Number(adoptionQuota) > 0
      ? Math.floor(Number(adoptionQuota))
      : PROFILE_DEFAULT_ADOPTION_QUOTA;
    const cap = Number.isFinite(Number(capacity)) && Number(capacity) > 0
      ? Math.floor(Number(capacity))
      : quota * 4;
    this.db = db;
    this.adoptionQuota = quota;
    this.cap = cap;
    this.eventSink = typeof emit === 'function' ? emit : null;
    for (const statement of SCHEMA) this.db.exec(statement);
  }

  /** Attach/replace the diagnostics sink without changing how the store behaves. */
  attachEmitter(emit) {
    this.eventSink = typeof emit === 'function' ? emit : null;
    return this;
  }

  /**
   * A locked entry is exempt from every automatic score/adoption change. The skip is reported so
   * a settings-page audit can show why an automatic round touched nothing.
   */
  reportLocked(entry, event) {
    try {
      const pending = this.eventSink?.('profile.locked.exempt', { entryId: entry.id, event });
      if (pending !== null && typeof pending === 'object' && typeof pending.catch === 'function') {
        pending.catch(() => {});
      }
    } catch {
      /* diagnostics are best-effort */
    }
  }

  /** Join the caller's open transaction, or own one `BEGIN IMMEDIATE … COMMIT`. */
  transact(fn) {
    if (this.db.isTransaction) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* transaction already unwound */
      }
      throw error;
    }
  }

  /** Public helper so callers can pre-compute the tombstone key without importing the hash. */
  fingerprint(side, text) {
    return profileFingerprint(side, text);
  }

  /** Canonical evidence identity: reliable `(session, turn, role)`, else the message id. */
  evidenceKey(evidence) {
    return profileEvidenceKey(evidence);
  }

  /**
   * Stable signature of the live library. `applyMerge` checks it inside its transaction so a
   * preview cannot be applied after an edit/delete/evidence write changed the entries.
   */
  libraryVersion() {
    const rows = this.db
      .prepare('SELECT id, version, evidence_count, updated_at FROM profile_entry ORDER BY id')
      .all();
    return createHash('sha256').update(JSON.stringify(rows)).digest('hex').slice(0, 16);
  }

  get(id) {
    return toEntry(this.db.prepare('SELECT * FROM profile_entry WHERE id = ?').get(id));
  }

  /**
   * List live entries, optionally filtered. Order follows the stage pipeline, then the
   * strongest clarity, so the settings page can render it as-is.
   */
  list({ side, category, rank } = {}) {
    const where = ['rejected = 0'];
    const args = [];
    if (side !== undefined) {
      if (!PROFILE_SIDES.includes(side)) throw new Error(`unknown profile side: ${String(side)}`);
      where.push('side = ?');
      args.push(side);
    }
    if (category !== undefined) {
      where.push('category = ?');
      args.push(cleanText(category));
    }
    if (rank !== undefined) {
      if (!PROFILE_RANKS.includes(rank)) throw new Error(`unknown profile rank: ${String(rank)}`);
      where.push('rank = ?');
      args.push(rank);
    }
    return this.db
      .prepare(
        `SELECT * FROM profile_entry WHERE ${where.join(' AND ')}
          ORDER BY CASE rank
                     WHEN 'original' THEN 0 WHEN 'new' THEN 1
                     WHEN 'candidate' THEN 2 ELSE 3 END,
                   clarity DESC, created_at ASC, id ASC`,
      )
      .all(...args)
      .map(toEntry);
  }

  /**
   * Insert one entry, or refresh an existing `(side, text)` entry. Idempotent: replaying the
   * same import never produces a second row. A tombstoned fingerprint returns `null`.
   *
   * @returns {{entry: object, removed: object[]} | null} `removed` lists entries evicted by the
   *   fifth stage during this write; `entry` is `null` only when the new row itself was the
   *   lowest-clarity victim.
   */
  upsert(input = {}) {
    const side = input.side;
    if (!PROFILE_SIDES.includes(side)) throw new Error(`unknown profile side: ${String(side)}`);
    const text = cleanText(input.text);
    if (text.length === 0) throw new Error('profile text 不能为空');
    const fingerprint = profileFingerprint(side, text);
    return this.transact(() => {
      // A rejected tendency stays dead: old evidence must not resurrect it.
      const tombstone = this.db.prepare('SELECT id FROM profile_reject WHERE fingerprint = ?').get(fingerprint);
      if (tombstone !== undefined) return null;

      const existing = this.db.prepare('SELECT * FROM profile_entry WHERE side = ? AND text = ?').get(side, text);
      if (existing !== undefined) {
        // Same tendency: refresh only what the caller actually supplied. `applyDiff` writes a
        // revision only when a value really changes, and it refuses to touch a locked entry
        // (an upsert is agent-driven, never a user edit).
        const patch = {};
        for (const field of ['category', 'tags', 'clarity', 'efficacy', 'rank']) {
          if (Object.prototype.hasOwnProperty.call(input, field)) patch[field] = input[field];
        }
        if (Object.keys(patch).length > 0) {
          const updated = this.applyDiff(existing.id, patch, 'import', { allowLocked: false });
          if (updated !== null && updated.entry !== null) return { entry: updated.entry, removed: [] };
        }
        return { entry: this.get(existing.id), removed: [] };
      }

      const id = typeof input.id === 'string' && input.id.trim().length > 0 ? input.id.trim() : randomUUID();
      const at = nowIso();
      const rank = normalizeRank(input.rank, 'new');
      const clarity = clampScore(input.clarity, PROFILE_DEFAULT_CLARITY);
      const efficacy = clampScore(input.efficacy, PROFILE_DEFAULT_EFFICACY);
      const evidenceCount = Math.max(0, Math.floor(Number(input.evidence_count ?? input.evidenceCount ?? 0)) || 0);
      this.db
        .prepare(
          `INSERT INTO profile_entry
            (id, side, category, tags, text, clarity, efficacy, rank, evidence_count,
             version, updated_at, locked, rejected, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 0, 0, ?)`,
        )
        .run(
          id,
          side,
          cleanText(input.category),
          normalizeTags(input.tags),
          text,
          clarity,
          efficacy,
          rank,
          evidenceCount,
          at,
          at,
        );
      // Chatty imports cannot push the library past its budget: the fifth stage deletes here,
      // not on a later maintenance pass.
      const removed = this.trim();
      return { entry: this.get(id), removed };
    });
  }

  /**
   * User edit. The user's own value is the baseline: on success the entry is adopted immediately
   * (`rank = 'original'`, `clarity = max(clarity, 60)`) because an explicit edit outranks the
   * statistical adoption gate. It is NOT a support event — no evidence row, no support count, no
   * +10 — and it does not freeze the entry: later support/contradiction/idle events still apply.
   * A user edit is always allowed (and may still raise a locked entry), because the lock only
   * restrains automatic organization.
   */
  edit(id, patch, { source = 'user' } = {}) {
    if (!PROFILE_SOURCES.includes(source)) throw new Error(`unknown profile source: ${String(source)}`);
    if (source !== 'user') return this.applyDiff(id, patch, source, { allowLocked: false });
    const current = this.get(id);
    if (current === null) return null;
    const input = patch !== null && typeof patch === 'object' ? { ...patch } : {};
    input.rank = 'original';
    // `clampScore` falls back to the current value when the patch omits clarity, then the floor
    // lifts a lower value to the adoption line without ever lowering a higher one.
    input.clarity = Math.max(clampScore(input.clarity, current.clarity), PROFILE_USER_EDIT_CLARITY);
    return this.applyDiff(id, input, 'user', { allowLocked: true });
  }

  /**
   * Automatic (agent) edit: refused for locked entries. Returns `null` when nothing may change,
   * so a caller cannot mistake a refusal for a successful write.
   */
  editFromAgent(id, patch) {
    return this.applyDiff(id, patch, 'agent', { allowLocked: false });
  }

  /**
   * Prompt reconciliation: the user edited a line of the settings prompt. Only `text` (and an
   * optional `category`) may change — rank, C/E and support evidence stay exactly as they were.
   * This is NOT a support event: no evidence row, no score, no adoption change. It is allowed on
   * a locked entry because the user's own prompt edit is not automatic organization.
   */
  reconcileEdit(id, patch = {}) {
    const input = {};
    if (patch !== null && typeof patch === 'object' && patch.text !== undefined) input.text = patch.text;
    if (patch !== null && typeof patch === 'object' && patch.category !== undefined) input.category = patch.category;
    if (Object.keys(input).length === 0) return null;
    return this.applyDiff(id, input, 'user', { allowLocked: true });
  }

  /** The shared diff path: compare → UPDATE the changed columns → one `profile_revision` row. */
  applyDiff(id, patch, source, { allowLocked }) {
    return this.transact(() => {
      const row = this.db.prepare('SELECT * FROM profile_entry WHERE id = ?').get(id);
      if (row === undefined) return null;
      if (row.locked === 1 && !allowLocked) return null;
      const current = toEntry(row);
      const input = patch !== null && typeof patch === 'object' ? patch : {};
      const before = {};
      const after = {};
      const changed = [];
      for (const field of EDITABLE_FIELDS) {
        if (!Object.prototype.hasOwnProperty.call(input, field)) continue;
        const next = normalizeEditable(field, input[field], current[field]);
        if (field === 'text' && next.length === 0) throw new Error('profile text 不能为空');
        if (next === current[field]) continue;
        if (field === 'text') {
          // Text is the identity of a tendency; two live entries may never carry the same one.
          const clash = this.db
            .prepare('SELECT id FROM profile_entry WHERE side = ? AND text = ? AND id <> ?')
            .get(current.side, next, id);
          if (clash !== undefined) throw new Error('profile entry with the same text already exists');
        }
        before[field] = current[field];
        after[field] = next;
        changed.push(field);
      }
      if (changed.length === 0) return { entry: current, revision: null, changed };
      const at = nowIso();
      const assignments = changed.map((field) => `${field} = ?`).join(', ');
      this.db
        .prepare(`UPDATE profile_entry SET ${assignments}, version = version + 1, updated_at = ? WHERE id = ?`)
        .run(...changed.map((field) => after[field]), at, id);
      const revisionId = randomUUID();
      this.db
        .prepare('INSERT INTO profile_revision (id, entry_id, before, after, at, source) VALUES (?, ?, ?, ?, ?, ?)')
        .run(revisionId, id, JSON.stringify(before), JSON.stringify(after), at, source);
      return {
        entry: this.get(id),
        revision: { id: revisionId, entry_id: id, before, after, at, source },
        changed,
      };
    });
  }

  /** Pin/unpin against automatic organization. Locking is not a content change: no revision. */
  lock(id, on = true) {
    return this.transact(() => {
      const row = this.db.prepare('SELECT * FROM profile_entry WHERE id = ?').get(id);
      if (row === undefined) return null;
      const next = on === false ? 0 : 1;
      if (row.locked !== next) {
        this.db.prepare('UPDATE profile_entry SET locked = ?, updated_at = ? WHERE id = ?').run(next, nowIso(), id);
      }
      return this.get(id);
    });
  }

  /**
   * Reject a tendency: its fingerprint becomes a permanent tombstone and the row (with its
   * evidence and revisions) is removed. Later imports of the same text return `null`.
   *
   * @returns {boolean} whether an entry was rejected.
   */
  reject(id) {
    return this.transact(() => {
      const row = this.db.prepare('SELECT * FROM profile_entry WHERE id = ?').get(id);
      if (row === undefined) return false;
      const at = nowIso();
      this.db
        .prepare(
          `INSERT INTO profile_reject (id, fingerprint, text, at) VALUES (?, ?, ?, ?)
            ON CONFLICT(fingerprint) DO UPDATE SET text = excluded.text, at = excluded.at`,
        )
        .run(randomUUID(), profileFingerprint(row.side, row.text), row.text, at);
      this.deleteEntryRows(id);
      return true;
    });
  }

  /**
   * Explicit hard removal. Unlike the automatic fifth-stage trim (which calls `deleteEntryRows`
   * directly), this writes a `deleted_persona` evidence boundary first, so a later backlog read
   * can tell which evidence existed at deletion time. The record is NOT a permanent ban and is
   * NOT auto-cleaned; only `purgeDeleted` removes it.
   */
  remove(id, options = {}) {
    return this.transact(() => {
      const row = this.db.prepare('SELECT * FROM profile_entry WHERE id = ?').get(id);
      if (row === undefined) return false;
      this.recordDeletedPersona(row, options);
      return this.deleteEntryRows(id) > 0;
    });
  }

  /** Alias that makes the evidence-boundary semantics explicit for callers and tests. */
  deletePersona(id, options = {}) {
    return this.remove(id, options);
  }

  /**
   * Write one deletion boundary row. Captures every evidence identity attached to the entry
   * (turn key and message id) before `deleteEntryRows` removes the live rows.
   */
  recordDeletedPersona(entry, { description, at } = {}) {
    if (entry === null || entry === undefined || typeof entry.id !== 'string') return null;
    const identity = profileFingerprint(entry.side, entry.text);
    const evidenceIds = new Set();
    for (const row of this.db.prepare('SELECT * FROM profile_evidence_identity WHERE entry_id = ?').all(entry.id)) {
      const key = profileEvidenceKey(row);
      if (key !== null) evidenceIds.add(key);
      if (row.message_id !== null && row.message_id !== undefined && String(row.message_id).length > 0) {
        evidenceIds.add(String(row.message_id));
      }
    }
    for (const row of this.db.prepare('SELECT * FROM profile_evidence WHERE entry_id = ?').all(entry.id)) {
      if (row.message_id === null || row.message_id === undefined || String(row.message_id).length === 0) continue;
      evidenceIds.add(`message:${String(row.message_id)}`);
      evidenceIds.add(String(row.message_id));
    }
    const id = randomUUID();
    const deletedAt = at ?? nowIso();
    const text = cleanText(description ?? entry.text);
    this.db
      .prepare(
        `INSERT INTO deleted_persona (id, identity, description, side, entry_id, deleted_at, evidence_ids)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, identity, text, entry.side, entry.id, deletedAt, JSON.stringify([...evidenceIds]));
    return {
      id,
      identity,
      description: text,
      side: entry.side,
      entry_id: entry.id,
      deleted_at: deletedAt,
      evidence_ids: [...evidenceIds],
    };
  }

  /** Deletion boundaries, newest first. `evidence_ids` is returned as a parsed array. */
  listDeleted() {
    return this.db
      .prepare('SELECT * FROM deleted_persona ORDER BY deleted_at DESC, rowid DESC')
      .all()
      .map((row) => ({ ...row, evidence_ids: parseStringArray(row.evidence_ids) }));
  }

  /**
   * True when the evidence key existed in the boundary of this deleted tendency. `identity` may
   * be a fingerprint, an entry id, or `{side, text}`; `evidenceKey` may be the canonical string,
   * an evidence object, or a bare message id.
   */
  isDeletedEvidence(identity, evidenceKey) {
    const keyValue = deletedIdentity(identity);
    const wanted = new Set();
    if (typeof evidenceKey === 'string') {
      wanted.add(evidenceKey);
      wanted.add(`message:${evidenceKey}`);
    } else if (evidenceKey !== null && typeof evidenceKey === 'object') {
      const key = profileEvidenceKey(evidenceKey);
      if (key !== null) wanted.add(key);
      const messageId = evidenceKey.messageId ?? evidenceKey.message_id;
      if (messageId !== null && messageId !== undefined && String(messageId).trim().length > 0) {
        wanted.add(String(messageId));
        wanted.add(`message:${String(messageId)}`);
      }
    }
    if (keyValue.length === 0 || wanted.size === 0) return false;
    const rows = this.db
      .prepare('SELECT evidence_ids FROM deleted_persona WHERE identity = ? OR entry_id = ?')
      .all(keyValue, keyValue);
    return rows.some((row) => parseStringArray(row.evidence_ids).some((item) => wanted.has(item)));
  }

  /**
   * Explicit cleanup of deletion boundaries (the ONLY cleanup path; there is no automatic purge).
   * `olderThanDays = 0` removes every existing boundary; omitted also means 0. After a purge,
   * `isDeletedEvidence` honestly stops matching the cleaned evidence.
   */
  purgeDeleted({ olderThanDays = 0 } = {}) {
    const days = Number(olderThanDays);
    if (!Number.isFinite(days) || days < 0) {
      throw new Error(`olderThanDays 必须是非负数: ${String(olderThanDays)}`);
    }
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const removed = this.db.prepare('DELETE FROM deleted_persona WHERE deleted_at <= ?').run(cutoff).changes;
    return { removed, cutoff, olderThanDays: days };
  }

  /** Revisions for one entry, newest first (same-timestamp writes fall back to insertion order). */
  revision(entryId) {
    return this.db
      .prepare('SELECT * FROM profile_revision WHERE entry_id = ? ORDER BY at DESC, rowid DESC')
      .all(entryId)
      .map((row) => ({
        id: row.id,
        entry_id: row.entry_id,
        before: parseDiff(row.before),
        after: parseDiff(row.after),
        at: row.at,
        source: row.source,
      }));
  }

  /**
   * Undo one revision: restore the fields it changed to their `before` values. A new revision
   * records the undo itself (source `user`) and the version is bumped again, so history stays
   * linear and the revert is itself revertible.
   *
   * @returns {{entry: object, revision: object, changed: string[]} | null}
   */
  revert(revisionId) {
    return this.transact(() => {
      const revision = this.db.prepare('SELECT * FROM profile_revision WHERE id = ?').get(revisionId);
      if (revision === undefined) return null;
      const entry = this.db.prepare('SELECT * FROM profile_entry WHERE id = ?').get(revision.entry_id);
      if (entry === undefined) return null;
      return this.applyDiff(entry.id, parseDiff(revision.before), 'user', { allowLocked: true });
    });
  }

  /**
   * Current fill level and stage counts. If `used` exceeds `cap` (only possible when rows were
   * written outside this API), the fifth stage deletes the lowest-clarity entries here too.
   *
   * @returns {{used: number, cap: number, stages: Record<string, number>, removed: object[]}}
   */
  capacity() {
    return this.transact(() => {
      const removed = this.trim();
      const used = this.db.prepare('SELECT COUNT(*) AS c FROM profile_entry').get().c;
      const stages = { original: 0, new: 0, candidate: 0, sinking: 0 };
      for (const row of this.db.prepare('SELECT rank AS stage, COUNT(*) AS c FROM profile_entry GROUP BY rank').all()) {
        if (Object.prototype.hasOwnProperty.call(stages, row.stage)) stages[row.stage] = row.c;
      }
      return { used, cap: this.cap, stages, removed };
    });
  }

  /**
   * Fifth stage: delete `used - cap` entries, lowest clarity first (then lowest efficacy, then
   * oldest). Locked entries sort last, so the cap still holds when every row is locked.
   *
   * @returns {object[]} the deleted entries.
   */
  trim() {
    const used = this.db.prepare('SELECT COUNT(*) AS c FROM profile_entry').get().c;
    const overflow = used - this.cap;
    if (overflow <= 0) return [];
    const victims = this.db
      .prepare(
        `SELECT * FROM profile_entry
          ORDER BY locked ASC, clarity ASC, efficacy ASC, created_at ASC, id ASC
          LIMIT ?`,
      )
      .all(overflow);
    for (const row of victims) this.deleteEntryRows(row.id);
    return victims.map(toEntry);
  }

  /**
   * Import the agent-split baseline of one profile. The Host does NOT split text: `items` must
   * already be one tendency per item. Each item lands as `original` (原订) with its supplied
   * C/E values (defaults when absent); `text` is kept as the import's provenance only.
   *
   * @param {{side: 'agent'|'user', text?: string, items: Array<object>}} input
   * @returns {{side: string, sourceText: string, imported: object[], skipped: object[], removed: object[]}}
   */
  importText({ side, text = '', items } = {}) {
    if (!PROFILE_SIDES.includes(side)) throw new Error(`unknown profile side: ${String(side)}`);
    if (!Array.isArray(items) || items.length === 0) {
      throw new Error('importText 需要 agent 拆分好的 items（宿主不自行拆分人设文本）');
    }
    return this.transact(() => {
      const imported = [];
      const skipped = [];
      const removed = [];
      for (const item of items) {
        const result = this.upsert({
          side,
          text: item?.text,
          category: item?.category,
          tags: item?.tags,
          clarity: item?.clarity,
          efficacy: item?.efficacy,
          rank: 'original',
          evidence_count: item?.evidence_count,
        });
        if (result === null || result.entry === null) {
          skipped.push({ text: cleanText(item?.text), fingerprint: profileFingerprint(side, cleanText(item?.text)) });
          continue;
        }
        imported.push(result.entry);
        removed.push(...result.removed);
      }
      return { side, sourceText: String(text ?? ''), imported, skipped, removed };
    });
  }

  /**
   * Evidence row + score change + dedupe ledger in ONE transaction (the caller's transaction is
   * joined when already open). `delta` is a CHANGE: `{clarity: 10, efficacy: 3}` for one support,
   * negative numbers for a contradiction; missing keys mean zero.
   *
   * Identity order: `(entry, session, turn, role)` first, then the message id. A replay writes
   * nothing and returns `{applied:false, duplicate:true}`; a missing entry returns `null`.
   */
  applyEvidence(entryId, evidence = {}, delta = {}) {
    return this.transact(() => {
      const entry = this.db.prepare('SELECT * FROM profile_entry WHERE id = ?').get(entryId);
      if (entry === undefined) return null;
      const record = normalizeEvidence(evidence);
      const duplicate = this.findEvidenceIdentity(entryId, record);
      if (duplicate !== null) {
        return {
          applied: false,
          duplicate: true,
          reason: 'duplicate',
          evidence: null,
          identity: duplicate,
          entry: toEntry(entry),
          score: profileScore(entry),
        };
      }
      const evidenceId = randomUUID();
      this.db
        .prepare('INSERT INTO profile_evidence (id, entry_id, message_id, kind, at, note) VALUES (?, ?, ?, ?, ?, ?)')
        .run(evidenceId, entryId, record.messageId, record.kind, record.at, record.note);
      this.db
        .prepare('UPDATE profile_entry SET evidence_count = evidence_count + 1, updated_at = ? WHERE id = ?')
        .run(record.at, entryId);
      const clarity = clampScore(Number(entry.clarity) + deltaNumber(delta, 'clarity'), entry.clarity);
      const efficacy = clampScore(Number(entry.efficacy) + deltaNumber(delta, 'efficacy'), entry.efficacy);
      // Score update happens before the ledger write on purpose: a throw here rolls the evidence
      // row and the evidence_count increment back, so a failed score never leaves evidence behind.
      this.writeRankScores(entryId, clarity, efficacy);
      const identity = this.insertEvidenceIdentity(
        entry,
        { id: evidenceId, message_id: record.messageId, kind: record.kind },
        record,
        'evidence',
      );
      return {
        applied: true,
        duplicate: false,
        reason: 'applied',
        evidence: {
          id: evidenceId,
          entry_id: entryId,
          message_id: record.messageId,
          kind: record.kind,
          at: record.at,
          note: record.note,
        },
        identity,
        entry: this.get(entryId),
        score: profileScore({ clarity, efficacy }),
      };
    });
  }

  /**
   * Record one supporting/contradicting message without changing the score. The same persistent
   * identity as `applyEvidence` applies, so a replay is a no-op instead of a second row.
   */
  addEvidence(entryId, options = {}) {
    const result = this.applyEvidence(entryId, { kind: 'support', ...(options ?? {}) }, {});
    return result === null || result.duplicate ? null : result.evidence;
  }

  /** The persistent evidence ledger for one entry, oldest first. */
  evidenceLedger(entryId) {
    return this.db
      .prepare('SELECT * FROM profile_evidence_identity WHERE entry_id = ? ORDER BY created_at ASC, rowid ASC')
      .all(entryId);
  }

  /** Evidence rows for one entry, newest first. */
  evidence(entryId) {
    return this.db.prepare('SELECT * FROM profile_evidence WHERE entry_id = ? ORDER BY at DESC, rowid DESC').all(entryId);
  }

  /**
   * Persistent dedupe lookup. The ledger is authoritative; if a pre-upgrade evidence row has no
   * ledger entry yet, the fallback message-id match backfills one so the next replay is persistent.
   */
  findEvidenceIdentity(entryId, record) {
    if (record.hasTurn) {
      const row = this.db
        .prepare(
          `SELECT * FROM profile_evidence_identity
            WHERE entry_id = ? AND session_id = ? AND turn_id = ? AND role = ? LIMIT 1`,
        )
        .get(entryId, record.sessionId, record.turnId, record.role);
      if (row !== undefined) return row;
    }
    if (record.messageId === null) return null;
    const ledger = this.db
      .prepare('SELECT * FROM profile_evidence_identity WHERE entry_id = ? AND message_id = ? ORDER BY rowid ASC LIMIT 1')
      .get(entryId, record.messageId);
    if (ledger !== undefined) return ledger;
    const legacy = this.db
      .prepare('SELECT * FROM profile_evidence WHERE entry_id = ? AND message_id = ? ORDER BY rowid ASC LIMIT 1')
      .get(entryId, record.messageId);
    if (legacy === undefined) return null;
    const entry = this.db.prepare('SELECT * FROM profile_entry WHERE id = ?').get(entryId);
    return this.insertEvidenceIdentity(
      entry,
      legacy,
      { sessionId: '', turnId: '', role: '', at: legacy.at },
      'backfill',
    );
  }

  /** Insert one ledger row; kept as one helper so every evidence path writes the same columns. */
  insertEvidenceIdentity(entry, evidenceRow, record = {}, source = 'evidence') {
    const id = randomUUID();
    const at = record.at ?? nowIso();
    this.db
      .prepare(
        `INSERT INTO profile_evidence_identity
          (id, entry_id, tendency, session_id, turn_id, role, message_id, evidence_id, kind, source, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        entry.id,
        profileFingerprint(entry.side, entry.text),
        record.sessionId ?? '',
        record.turnId ?? '',
        record.role ?? '',
        evidenceRow.message_id ?? null,
        evidenceRow.id ?? null,
        evidenceRow.kind ?? 'support',
        source,
        at,
      );
    return this.db.prepare('SELECT * FROM profile_evidence_identity WHERE id = ?').get(id);
  }

  /** Delete one entry and everything attached to it; returns the number of entry rows removed. */
  deleteEntryRows(id) {
    this.db.prepare('DELETE FROM profile_evidence WHERE entry_id = ?').run(id);
    this.db.prepare('DELETE FROM profile_evidence_identity WHERE entry_id = ?').run(id);
    this.db.prepare('DELETE FROM profile_revision WHERE entry_id = ?').run(id);
    return this.db.prepare('DELETE FROM profile_entry WHERE id = ?').run(id).changes;
  }

  // ---- step 2: rank pipeline (rules live in profileRank.js) --------------------------------

  /**
   * Read-only rank inputs for one entry: distinct supporting message ids, current S and the
   * entry itself. This joins rows only; every threshold/delta is in profileRank.js.
   *
   * @returns {{entry: object, supportCount: number, supportMessageIds: string[], score: number}|null}
   */
  rankState(id) {
    const entry = this.get(id);
    if (entry === null) return null;
    const evidence = this.evidence(id);
    return {
      entry,
      supportCount: independentSupportCount(evidence),
      supportMessageIds: independentSupportIds(evidence),
      score: profileScore(entry),
    };
  }

  /** How many independent supports (distinct evidence message ids) the entry has right now. */
  supportCount(id) {
    return independentSupportCount(this.evidence(id));
  }

  /**
   * Record one independent support. The persistent identity is `(entry, session, turn, role)`
   * when supplied, else the message id, so replaying the same exchange after a restart changes
   * no score and inserts no second row. A new identity adds C +10 / E +3 (capped at 100).
   *
   * @returns {{entry: object, evidence: object|null, duplicate: boolean, applied: boolean,
   *            reason: string, delta?: object, score: number}|null} null when the entry is gone.
   */
  recordSupport(entryId, { messageId = null, sessionId = '', turnId = '', role = '', note = '', at } = {}) {
    return this.transact(() => {
      const entry = this.get(entryId);
      if (entry === null) return null;
      if (entry.locked) {
        this.reportLocked(entry, 'support');
        return { entry, evidence: null, duplicate: false, applied: false, reason: 'locked', score: profileScore(entry) };
      }
      const seen = this.evidence(entryId)
        .map((row) => row.message_id)
        .filter((id) => id !== null && id !== undefined && String(id).length > 0)
        .map(String);
      const update = applyRankEvent(entry, { type: 'support', messageId }, { seenMessageIds: seen });
      if (!update.applied) {
        return { entry, evidence: null, duplicate: true, applied: false, reason: update.reason, score: update.score };
      }
      const applied = this.applyEvidence(
        entryId,
        { messageId, sessionId, turnId, role, kind: 'support', note, at },
        update.delta,
      );
      if (applied === null) return null;
      if (applied.duplicate) {
        return {
          entry: applied.entry,
          evidence: null,
          duplicate: true,
          applied: false,
          reason: 'duplicate',
          score: profileScore(applied.entry),
        };
      }
      return {
        entry: applied.entry,
        evidence: applied.evidence,
        duplicate: false,
        applied: true,
        reason: update.reason,
        delta: update.delta,
        score: applied.score,
      };
    });
  }

  /**
   * Apply one exchange round that produced no support for this entry. `hasNewExchange` may be
   * a boolean or the batch's message list; without a new batch nothing is applied, so a host
   * that is switched off does not decay the profile.
   */
  recordIdle(entryId, { hasNewExchange = false } = {}) {
    return this.transact(() => {
      const entry = this.get(entryId);
      if (entry === null) return null;
      if (entry.locked) {
        this.reportLocked(entry, 'idle');
        return { entry, applied: false, reason: 'locked', delta: { clarity: 0, efficacy: 0 }, score: profileScore(entry) };
      }
      const batch = Array.isArray(hasNewExchange) ? hasNewExchange.length > 0 : hasNewExchange === true;
      const update = applyRankEvent(entry, { type: 'idle', hasNewExchange: batch });
      if (update.applied) this.writeRankScores(entryId, update.clarity, update.efficacy);
      return {
        entry: this.get(entryId),
        applied: update.applied,
        reason: update.reason,
        delta: update.delta,
        score: update.score,
      };
    });
  }

  /**
   * Record one contradiction. `severity` is `occasional`/`vague` (C -5) or `sustained`
   * (C -10 / E -5). The persistent evidence identity is deduplicated exactly like a support:
   * replaying the same exchange never stacks the penalty.
   */
  recordContradiction(entryId, { severity = 'occasional', messageId = null, sessionId = '', turnId = '', role = '', note = '', at } = {}) {
    return this.transact(() => {
      const entry = this.get(entryId);
      if (entry === null) return null;
      if (entry.locked) {
        this.reportLocked(entry, 'contradiction');
        return { entry, evidence: null, duplicate: false, applied: false, reason: 'locked', score: profileScore(entry) };
      }
      const seen = this.evidence(entryId)
        .map((row) => row.message_id)
        .filter((id) => id !== null && id !== undefined && String(id).length > 0)
        .map(String);
      const update = applyRankEvent(
        entry,
        { type: 'contradiction', severity, messageId },
        { seenMessageIds: seen },
      );
      if (!update.applied) {
        return { entry, evidence: null, duplicate: true, applied: false, reason: update.reason, score: update.score };
      }
      const applied = this.applyEvidence(
        entryId,
        { messageId, sessionId, turnId, role, kind: 'contra', note, at },
        update.delta,
      );
      if (applied === null) return null;
      if (applied.duplicate) {
        return {
          entry: applied.entry,
          evidence: null,
          duplicate: true,
          applied: false,
          reason: 'duplicate',
          score: profileScore(applied.entry),
        };
      }
      return {
        entry: applied.entry,
        evidence: applied.evidence,
        duplicate: false,
        applied: true,
        reason: update.reason,
        delta: update.delta,
        score: applied.score,
      };
    });
  }

  // ---- evidence identity ledger + merge (data layer only) -----------------------------------

  /** Read-only evidence view used by both merge preview and apply (ledger + legacy fallback). */
  mergeEvidenceItems(entryIds) {
    const byEntry = new Map();
    for (const entryId of entryIds) {
      const ledgerByEvidence = new Map(
        this.evidenceLedger(entryId)
          .filter((row) => row.evidence_id !== null && row.evidence_id !== undefined)
          .map((row) => [String(row.evidence_id), row]),
      );
      const items = this.evidence(entryId).map((row) => {
        const ledger = ledgerByEvidence.get(String(row.id)) ?? null;
        const key = ledger !== null ? profileEvidenceKey(ledger) : (row.message_id ? `message:${String(row.message_id)}` : null);
        return {
          evidenceId: row.id,
          ledgerId: ledger?.id ?? null,
          key,
          messageId: row.message_id ?? null,
          kind: row.kind,
          at: row.at,
        };
      });
      byEntry.set(entryId, items);
    }
    return byEntry;
  }

  /**
   * Read-only merge preview. The target is the highest-S entry; the preview lists each entry's
   * evidence and the independently counted set after the merge. It never writes, and its
   * `proposed` scores are the target's own scores — never a sum of the merged entries.
   */
  planMerge(entryIds) {
    const ids = normalizeIdList(entryIds);
    if (ids.length === 0) throw new Error('planMerge 需要至少一个 entryId');
    const entries = [];
    const missing = [];
    for (const id of ids) {
      const entry = this.get(id);
      if (entry === null) missing.push(id);
      else entries.push(entry);
    }
    if (missing.length > 0) {
      const error = new Error(`profile entry missing: ${missing.join(',')}`);
      error.code = 'PROFILE_MERGE_MISSING';
      error.missing = missing;
      throw error;
    }
    const target = [...entries].sort(compareMergeCandidates)[0];
    const sources = entries.filter((entry) => entry.id !== target.id).sort(compareMergeCandidates);
    const evidenceByEntry = this.mergeEvidenceItems(entries.map((entry) => entry.id));
    const mergedEvidence = [];
    const duplicateEvidence = [];
    const seenKeys = new Set();
    const seenMessages = new Set();
    for (const entry of [target, ...sources]) {
      for (const item of evidenceByEntry.get(entry.id) ?? []) {
        const duplicate = (item.key !== null && seenKeys.has(item.key))
          || (item.messageId !== null && item.messageId !== undefined && seenMessages.has(String(item.messageId)));
        if (duplicate) {
          duplicateEvidence.push({ ...item, entryId: entry.id });
          continue;
        }
        if (item.key !== null) seenKeys.add(item.key);
        if (item.messageId !== null && item.messageId !== undefined) seenMessages.add(String(item.messageId));
        mergedEvidence.push({ ...item, entryId: entry.id });
      }
    }
    const supportKeys = new Set();
    for (const item of mergedEvidence) {
      if (item.kind === 'support') supportKeys.add(item.key ?? `evidence:${item.evidenceId}`);
    }
    return {
      readOnly: true,
      entryIds: ids,
      targetId: target.id,
      sourceIds: sources.map((entry) => entry.id),
      entries: entries.map((entry) => ({
        id: entry.id,
        side: entry.side,
        text: entry.text,
        clarity: entry.clarity,
        efficacy: entry.efficacy,
        score: profileScore(entry),
        rank: entry.rank,
      })),
      evidenceByEntry: Object.fromEntries(
        [...evidenceByEntry.entries()].map(([id, items]) => [id, items.map((item) => ({ ...item }))]),
      ),
      mergedEvidence,
      duplicateEvidence,
      supportCount: supportKeys.size,
      proposed: {
        clarity: target.clarity,
        efficacy: target.efficacy,
        score: profileScore(target),
        rank: target.rank,
      },
      notes: [
        `目标条目 ${target.id} 保留原评分 C=${target.clarity}, E=${target.efficacy}；合并不叠加评分。`,
        `合并后证据独立重新计数：保留 ${mergedEvidence.length} 条，去重 ${duplicateEvidence.length} 条。`,
        `采纳状态保持 ${target.rank}；合并不自动采纳。`,
      ],
      version: this.libraryVersion(),
    };
  }

  /**
   * Apply a `planMerge` result in one transaction. Version is checked first (default
   * `plan.version`), then every source evidence row is moved to the target once — a duplicate
   * identity is dropped, never counted twice. Scores are NOT summed: the target keeps its own
   * larger score and its current adoption rank. No deletion boundary is written (a merge is not
   * a user deletion).
   */
  applyMerge(plan, { expectedVersion } = {}) {
    if (plan === null || typeof plan !== 'object' || !Array.isArray(plan.entryIds)) {
      throw new Error('applyMerge 需要 planMerge 返回的合并计划');
    }
    const expected = expectedVersion === undefined ? plan.version : expectedVersion;
    return this.transact(() => {
      const currentVersion = this.libraryVersion();
      if (expected !== undefined && expected !== null && String(expected) !== currentVersion) {
        const error = new Error('profile library version mismatch');
        error.code = 'PROFILE_VERSION_MISMATCH';
        error.expected = expected;
        error.current = currentVersion;
        throw error;
      }
      const ids = normalizeIdList(plan.entryIds);
      const entries = [];
      for (const id of ids) {
        const entry = this.get(id);
        if (entry === null) {
          const error = new Error(`merge entry missing: ${id}`);
          error.code = 'PROFILE_MERGE_MISSING';
          error.missing = [id];
          throw error;
        }
        entries.push(entry);
      }
      if (entries.length <= 1) {
        const only = entries[0] ?? null;
        return {
          applied: false,
          reason: 'noop',
          targetId: only?.id ?? null,
          mergedIds: [],
          movedEvidence: [],
          removedEvidence: [],
          entry: only,
          notes: ['只有一个条目，无需合并。'],
          version: currentVersion,
        };
      }
      const computed = [...entries].sort(compareMergeCandidates)[0];
      const target = plan.targetId !== undefined && entries.some((entry) => entry.id === plan.targetId)
        ? entries.find((entry) => entry.id === plan.targetId)
        : computed;
      const sources = entries.filter((entry) => entry.id !== target.id);
      const evidenceByEntry = this.mergeEvidenceItems(entries.map((entry) => entry.id));
      const seenKeys = new Set();
      const seenMessages = new Set();
      for (const item of evidenceByEntry.get(target.id) ?? []) {
        if (item.key !== null) seenKeys.add(item.key);
        if (item.messageId !== null && item.messageId !== undefined) seenMessages.add(String(item.messageId));
      }
      const movedEvidence = [];
      const removedEvidence = [];
      for (const source of sources) {
        for (const item of evidenceByEntry.get(source.id) ?? []) {
          const duplicate = (item.key !== null && seenKeys.has(item.key))
            || (item.messageId !== null && item.messageId !== undefined && seenMessages.has(String(item.messageId)));
          if (duplicate) {
            this.db.prepare('DELETE FROM profile_evidence WHERE id = ?').run(item.evidenceId);
            if (item.ledgerId !== null) {
              this.db.prepare('DELETE FROM profile_evidence_identity WHERE id = ?').run(item.ledgerId);
            }
            removedEvidence.push({ ...item, from: source.id });
            continue;
          }
          this.db.prepare('UPDATE profile_evidence SET entry_id = ? WHERE id = ?').run(target.id, item.evidenceId);
          if (item.ledgerId !== null) {
            this.db
              .prepare('UPDATE profile_evidence_identity SET entry_id = ?, tendency = ? WHERE id = ?')
              .run(target.id, profileFingerprint(target.side, target.text), item.ledgerId);
          } else {
            this.insertEvidenceIdentity(
              target,
              { id: item.evidenceId, message_id: item.messageId, kind: item.kind },
              { sessionId: '', turnId: '', role: '', at: item.at },
              'merge',
            );
          }
          if (item.key !== null) seenKeys.add(item.key);
          if (item.messageId !== null && item.messageId !== undefined) seenMessages.add(String(item.messageId));
          movedEvidence.push({ ...item, from: source.id, to: target.id });
        }
      }
      for (const source of sources) this.deleteEntryRows(source.id);
      const evidenceCount = this.db
        .prepare('SELECT COUNT(*) AS c FROM profile_evidence WHERE entry_id = ?')
        .get(target.id).c;
      this.db
        .prepare('UPDATE profile_entry SET evidence_count = ?, version = version + 1, updated_at = ? WHERE id = ?')
        .run(evidenceCount, nowIso(), target.id);
      return {
        applied: true,
        targetId: target.id,
        mergedIds: sources.map((entry) => entry.id),
        movedEvidence,
        removedEvidence,
        evidenceCount,
        entry: this.get(target.id),
        proposed: {
          clarity: target.clarity,
          efficacy: target.efficacy,
          score: profileScore(target),
          rank: target.rank,
        },
        notes: [
          `目标条目 ${target.id} 保留原评分 C=${target.clarity}, E=${target.efficacy}；合并不叠加评分。`,
          `证据独立重新计数：移动 ${movedEvidence.length} 条，去重 ${removedEvidence.length} 条。`,
          `采纳状态保持 ${target.rank}；合并不自动采纳。`,
        ],
        version: this.libraryVersion(),
      };
    });
  }

  /**
   * Persist scores derived by `applyRankEvent`. This is derived metadata, not a content edit:
   * no revision row and no version bump (the user's text/category history stays clean).
   */
  writeRankScores(id, clarity, efficacy) {
    this.db
      .prepare('UPDATE profile_entry SET clarity = ?, efficacy = ?, updated_at = ? WHERE id = ?')
      .run(
        clampScore(clarity, PROFILE_DEFAULT_CLARITY),
        clampScore(efficacy, PROFILE_DEFAULT_EFFICACY),
        nowIso(),
        id,
      );
  }

  /**
   * Read-only selection preview: applies the same score/threshold/budget rules as `compileRank`
   * but writes nothing. The maintainer uses it to learn this round's selected set before applying
   * natural decay to the entries that were neither selected nor mentioned.
   */
  rankPlan({ config } = {}) {
    const settings = resolveProfileRankConfig(config);
    const entries = this.list();
    const supportCounts = {};
    for (const entry of entries) supportCounts[entry.id] = independentSupportCount(this.evidence(entry.id));
    return selectProfileEntries(entries, { supportCounts, config: settings });
  }

  /**
   * Select, persist and compile in one transaction:
   *  - C < 10 entries are deleted outright (fifth stage, no archive);
   *  - fitted entries become `original`; every other live entry becomes `new`, keeping its
   *    score and evidence so it can compete again next round;
   *  - a locked entry keeps its adoption state unchanged (lock is a full automatic exemption);
   *  - the prompt is grouped by side/category and never truncated.
   *
   * `persist:false` only compiles a preview and writes nothing.
   *
   * @param {{config?: object, persist?: boolean}} [options]
   * @returns {object} `rankAndCompile` output plus `applied: {removed, reranked}`.
   */
  compileRank({ config, persist = true } = {}) {
    const settings = resolveProfileRankConfig(config);
    return this.transact(() => {
      const entries = this.list();
      const supportCounts = {};
      for (const entry of entries) supportCounts[entry.id] = independentSupportCount(this.evidence(entry.id));
      const result = rankAndCompile(entries, { supportCounts, config: settings });
      const removed = [];
      const reranked = [];
      if (persist) {
        const forgottenIds = new Set(result.forgotten.map((item) => item.id));
        for (const item of result.forgotten) {
          this.deleteEntryRows(item.id);
          removed.push(item.id);
        }
        const at = nowIso();
        for (const entry of entries) {
          if (forgottenIds.has(entry.id)) continue;
          if (entry.locked) continue; // the lock freezes the adoption state as well as the scores
          const next = result.ranks[entry.id];
          if (next === undefined || next === entry.rank) continue;
          this.db
            .prepare('UPDATE profile_entry SET rank = ?, updated_at = ? WHERE id = ?')
            .run(next, at, entry.id);
          reranked.push({ id: entry.id, from: entry.rank, to: next });
        }
      }
      return { ...result, applied: { removed, reranked } };
    });
  }
}

/**
 * Create a profile store on an existing connection and make sure its tables exist.
 * @param {{db: import('node:sqlite').DatabaseSync, capacity?: number, adoptionQuota?: number}} options
 * @returns {ProfileStore}
 */
export function createProfileStore(options = {}) {
  return new ProfileStore(options);
}
