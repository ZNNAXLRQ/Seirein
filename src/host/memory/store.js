/**
 * SQLite memory lifecycle and transactions: record, recall, correct, decay and archive.
 *
 * query.js owns query interpretation, snippets and ranking helpers. The event log and root/domain
 * helpers live in runtime/event-log.js and remain re-exported here for existing callers.
 * Memory still uses one memory.db with domain scopes; this split changes no storage policy.
 */
import { appendFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import { DOMAIN_RE, nowIso } from '../runtime/event-log.js';
export { nowIso, resolveRoot, normalizeDomain, EventLog } from '../runtime/event-log.js';
import {
  CLARITY_LEVELS,
  BAND_CUTOFFS,
  PRESSURE_RELEASE_RATIO,
  MEMORY_REVISION_LIMIT,
  POLICY_KEYS,
  normalizeBand,
  bandForRatio,
  defaultPressureThreshold,
  LEGACY_DEFAULT_CAPACITY,
  tokenizeQuery,
  recencyBoost,
  retrievalTerms,
  escapeLike,
  correctionOperationId,
  ftsProbe,
  trimToBudget,
  AUTO_MEMORY_DEFAULTS,
  CANDIDATE_TTL_MS,
  CANDIDATE_STATES,
  MEMORY_ASSEMBLY,
  MEMORY_LINK_KINDS,
  MEMORY_LINK_CONFIDENCE,
  clipMessageText,
  displayMessageSnippet,
  localMidnight,
  detectRecallIntent,
  UPCOMING_SPAN_DAYS,
  UPCOMING_INJECT,
  upcomingConvention,
  formatRecalledLine,
  UNRESOLVED_MARK,
  scoreImportance,
} from './query.js';
export {
  CLARITY_LEVELS,
  MEMORY_REVISION_LIMIT,
  defaultPressureThreshold,
  tokenizeQuery,
  retrievalTerms,
  AUTO_MEMORY_DEFAULTS,
  normalizeAutoMemory,
  CANDIDATE_TTL_MS,
  CANDIDATE_STATES,
  MEMORY_ASSEMBLY,
  MEMORY_LINK_KINDS,
  MEMORY_LINK_CONFIDENCE,
  clipMessageText,
  displayMessageText,
  displayMessageSnippet,
  isoWeekStart,
  detectTimeRange,
  detectRecallRoles,
  detectRecallIntent,
  UPCOMING_WINDOW,
  UPCOMING_SPAN_DAYS,
  UPCOMING_WEIGHTS,
  UPCOMING_INJECT,
  upcomingConvention,
  formatRecalledLine,
  UNRESOLVED_MARK,
  scoreImportance,
} from './query.js';

/**
 * Serialize the optional stage-3 speaker attribution of a NEW message record.
 *
 * Shape: `{speakerId, assigned, confidence, source:'shadow', at}`. It is written by the auto
 * recorder from the host's `speaker.shadow` decision; an unknown/malformed value becomes `null`
 * (an old row has no value either). `assigned:true` is only ever stored together with a real id
 * and `confidence:'confirmed'`, so a stored row can never claim the user without a confirmed self.
 * Nothing in recall reads this field: it is evidence on the record, not a retrieval key.
 *
 * @param {unknown} value
 * @returns {string|null} JSON text, or null when there is nothing valid to store
 */
function serializeSpeakerAttribution(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const speakerId = typeof value.speakerId === 'string' && value.speakerId.trim().length > 0
    ? value.speakerId.trim()
    : null;
  const assigned = value.assigned === true && speakerId !== null;
  const confidence = assigned
    ? 'confirmed'
    : (value.confidence === 'mismatch' ? 'mismatch' : 'unsure');
  const at = typeof value.at === 'string' && value.at.length > 0 ? value.at : null;
  return JSON.stringify({ speakerId, assigned, confidence, source: 'shadow', at });
}


/**
 * Memory store: one SQLite file, domains as a column.
 *
 * FTS5 with the trigram tokenizer gives substring search that works for Chinese; when the
 * build lacks FTS5, or the query is shorter than 3 characters, we fall back to LIKE.
 *
 * Fading is capacity-driven, never time-driven: a quiet assistant loses nothing. When the
 * active table first crosses 30/60/90% of `capacity`, the lowest-scoring half drops one clarity
 * level; at 90% the oldest trace records move to the archive (kept forever, never injected).
 * While usage stays at the top band, only *new* memories build up pressure: every
 * `pressureThreshold` additions trigger one more single-level pass, so a full table keeps
 * settling instead of freezing at 90% forever. All trigger state is persisted in the database.
 */
export class MemoryStore {
  constructor(root, { capacity = 5000, pressureThreshold, onEvent } = {}) {
    this.dir = join(root, 'memory');
    this.file = join(this.dir, 'memory.db');
    this.capacity = Number.isFinite(capacity) && capacity > 0 ? Math.floor(capacity) : 5000;
    this.db = null;
    this.fts = true;
    this.archiveFts = true;
    /** Last startup FTS verification: {checkedAt, checkMs, rebuilt: [{table, ms}], errors}. */
    this.ftsRepair = null;
    /** Constructor override for the sustained-pressure threshold; loaded/persisted by open(). */
    this.pressureThresholdOption =
      Number.isFinite(pressureThreshold) && pressureThreshold > 0 ? Math.floor(pressureThreshold) : null;
    /** Optional host log hook: `(type, payload) => unknown`, used for migration audit events. */
    this.onEvent = typeof onEvent === 'function' ? onEvent : null;
    /** Highest band whose cross-band fade has already been consumed (0..3). */
    this.lastTriggeredBand = 0;
    /** Additions accumulated since the last capacity response, not yet spent by a fade. */
    this.pendingPressure = 0;
    /** Current pressure cycle: contributions from an older epoch can never be refunded. */
    this.pressureEpoch = 0;
    /** Additions needed to trigger one sustained-pressure fade. Resolved in open(). */
    this.pressureThreshold = null;
    /** Open `BEGIN IMMEDIATE` nesting depth owned by `transact()`. */
    this.txDepth = 0;
  }

  /**
   * Retire the obsolete `pinned` column.
   *
   * `pinned` was a "never fade / never archive" protection flag that no code path ever set, so it
   * is dead weight. A database written by an older build may still carry the column; there is no
   * data worth translating (single-developer store, verified empty before the flag was removed),
   * so the column is simply dropped: no importance floor, no clarity lift, no migration event.
   * A database without the column (every database this build writes) is a no-op. A build whose
   * SQLite cannot drop a column records `memory.pinned.retire-failed` and keeps the legacy column,
   * unread: nothing ever selects from it again.
   *
   * @param {DatabaseSync} db the database being opened, before the instance is usable
   * @returns {{dropped: boolean}}
   */
  retirePinnedColumn(db) {
    const columns = new Set(db.prepare('PRAGMA table_info(memory_event)').all().map((row) => row.name));
    if (!columns.has('pinned')) return { dropped: false };
    try {
      db.exec('ALTER TABLE memory_event DROP COLUMN pinned');
    } catch (error) {
      this.emitEvent('memory.pinned.retire-failed', { error: String(error?.message ?? error) });
      return { dropped: false };
    }
    return { dropped: true };
  }

  open() {
    if (this.db !== null) return this;

    mkdirSync(this.dir, { recursive: true });
    const db = new DatabaseSync(this.file);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec(`CREATE TABLE IF NOT EXISTS memory_event (
      id TEXT PRIMARY KEY,
      ts TEXT NOT NULL,
      domain TEXT NOT NULL,
      kind TEXT NOT NULL,
      text TEXT NOT NULL,
      importance INTEGER NOT NULL DEFAULT 50,
      clarity TEXT NOT NULL DEFAULT 'vivid',
      last_seen TEXT,
      recall_count INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT ''
    )`);
    // Message-level auto memory: additive columns keep older databases readable. `message_id`
    // is the idempotency key, so a replayed/retried message can never be stored twice.
    const columns = new Set(db.prepare('PRAGMA table_info(memory_event)').all().map((row) => row.name));
    for (const [name, type] of [
      ['session_id', 'TEXT'],
      ['turn_id', 'INTEGER'],
      ['message_id', 'TEXT'],
      ['role', 'TEXT'],
      ['truncated', 'INTEGER NOT NULL DEFAULT 0'],
      // Correction bookkeeping. `NOT NULL` columns must carry their DEFAULT inside the type
      // string, because the loop only emits `ALTER TABLE ... ADD COLUMN name type`.
      ['raw_text', 'TEXT'],
      ['tz_used', 'TEXT'],
      ['version', 'INTEGER NOT NULL DEFAULT 1'],
      ['updated_at', 'TEXT'],
      ['unresolved', 'INTEGER NOT NULL DEFAULT 0'],
      ['superseded_by', 'TEXT'],
      // A merged correction statement leaves active memory without losing its audit row:
      // hidden rows are not counted by usage(), are never retrieved, and compact() archives them.
      ['hidden', 'INTEGER NOT NULL DEFAULT 0'],
      // Pressure bookkeeping: which cycle paid this row's one credit, and whether that credit is
      // still refundable (0 means already consumed). Legacy rows default to "already consumed".
      ['pressure_epoch', 'INTEGER NOT NULL DEFAULT 0'],
      ['pressure_contribution', 'INTEGER NOT NULL DEFAULT 0'],
      // Stage 3 (purely additive): the speaker attribution of a NEW voice record, as JSON text.
      // Old rows stay NULL; no query, index or recall path reads it, so compatibility is unchanged.
      ['speaker_attribution', 'TEXT'],
    ]) {
      if (!columns.has(name)) db.exec(`ALTER TABLE memory_event ADD COLUMN ${name} ${type}`);
    }
    // The retired protection flag is removed here, once, before any index or query touches the
    // live table: a fresh database never has it, a legacy one loses the column and keeps its rows
    // untouched (no rewrite, no migration event).
    this.retirePinnedColumn(db);
    db.exec('CREATE INDEX IF NOT EXISTS memory_event_domain ON memory_event(domain)');
    db.exec('CREATE INDEX IF NOT EXISTS memory_event_ts ON memory_event(ts)');
    db.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS memory_event_message ON memory_event(message_id) WHERE message_id IS NOT NULL',
    );
    db.exec('CREATE INDEX IF NOT EXISTS memory_event_session ON memory_event(session_id, turn_id)');
    db.exec('CREATE INDEX IF NOT EXISTS memory_event_superseded ON memory_event(superseded_by)');
    // Correction history: deliberately NOT an FTS content table and NOT counted by usage(),
    // so rewriting a record can never cost capacity pressure or enter recall/fade selection.
    db.exec(`CREATE TABLE IF NOT EXISTS memory_revision (
      id TEXT PRIMARY KEY,
      memory_id TEXT NOT NULL,
      before_text TEXT NOT NULL,
      after_text TEXT NOT NULL,
      source_message_id TEXT,
      operation_id TEXT,
      at TEXT NOT NULL
    )`);
    // Older databases predate operation-scoped idempotency; add the column in place so the
    // upgrade stays incremental (same loop style as memory_event above).
    const revisionColumns = new Set(db.prepare('PRAGMA table_info(memory_revision)').all().map((row) => row.name));
    if (!revisionColumns.has('operation_id')) db.exec('ALTER TABLE memory_revision ADD COLUMN operation_id TEXT');
    db.exec('CREATE INDEX IF NOT EXISTS memory_revision_memory ON memory_revision(memory_id, at)');
    db.exec(`CREATE INDEX IF NOT EXISTS memory_revision_source
      ON memory_revision(source_message_id) WHERE source_message_id IS NOT NULL`);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS memory_revision_operation
      ON memory_revision(operation_id) WHERE operation_id IS NOT NULL`);
    // Stage 3: explicit one-hop links between records. Deliberately NOT an FTS content table and
    // NOT counted by usage()/capacity: a link costs no pressure and never enters retrieval on its
    // own, so it cannot displace a record or inflate the capacity ratio.
    db.exec(`CREATE TABLE IF NOT EXISTS memory_link (
      id TEXT PRIMARY KEY,
      from_id TEXT NOT NULL,
      to_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS memory_link_from ON memory_link(from_id, kind, created_at)');
    db.exec('CREATE INDEX IF NOT EXISTS memory_link_to ON memory_link(to_id, kind)');
    // One edge of a kind exists once: a duplicate turn pairing or a retried link is a no-op.
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS memory_link_edge ON memory_link(from_id, to_id, kind)');
    // Candidate ledger (P-52): extracted candidates stay OUT of `memory_event` until a turn
    // delivers them, so every existing read path simply cannot see one. Deliberately not an FTS
    // content table and not counted by usage()/capacity: a candidate has not been delivered, so
    // it must not displace a real memory or inflate the capacity ratio.
    db.exec(`CREATE TABLE IF NOT EXISTS memory_candidate (
      id TEXT PRIMARY KEY,
      ts TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT '',
      reason TEXT NOT NULL DEFAULT '',
      text TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL DEFAULT 'candidate',
      delivered_turn TEXT,
      delivered_at TEXT,
      delivery_count INTEGER NOT NULL DEFAULT 0,
      persisted_at TEXT,
      memory_id TEXT
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS memory_candidate_state ON memory_candidate(state, ts)');
    // Stage 3.1 (additive): `to_version` is the version of the basis record when the edge was
    // written; when that basis is corrected the edge is retired with `stale = 1` instead of
    // silently keeping an outdated name in the block.
    const linkColumns = new Set(db.prepare('PRAGMA table_info(memory_link)').all().map((row) => row.name));
    for (const [name, type] of [
      ['to_version', 'INTEGER'],
      ['stale', 'INTEGER NOT NULL DEFAULT 0'],
    ]) {
      if (!linkColumns.has(name)) db.exec(`ALTER TABLE memory_link ADD COLUMN ${name} ${type}`);
    }
    // Archive: faded records land here instead of vanishing. Never queried by recall,
    // never injected into the prompt — the escape hatch for "I remember we talked about…".
    db.exec(`CREATE TABLE IF NOT EXISTS memory_archive (
      id TEXT PRIMARY KEY,
      ts TEXT NOT NULL,
      domain TEXT NOT NULL,
      kind TEXT NOT NULL,
      text TEXT NOT NULL,
      importance INTEGER NOT NULL,
      clarity TEXT NOT NULL,
      archived_at TEXT NOT NULL,
      reason TEXT NOT NULL
    )`);
    // Message identity survives archiving: without these columns a replayed message id looked
    // new after its row faded, and the replay was written back into the active table.
    const archiveColumns = new Set(db.prepare('PRAGMA table_info(memory_archive)').all().map((row) => row.name));
    for (const [name, type] of [
      ['message_id', 'TEXT'],
      ['session_id', 'TEXT'],
      ['turn_id', 'INTEGER'],
      ['role', 'TEXT'],
      ['truncated', 'INTEGER NOT NULL DEFAULT 0'],
      // Zone used when the body was written: keeps an absolute date explainable after a config change.
      ['tz_used', 'TEXT'],
      // The pre-normalization wording and the "normalizer could not decide" mark must survive the
      // move to the archive, or compact() silently turns every faded row into a clean-looking fact.
      ['raw_text', 'TEXT'],
      ['unresolved', 'INTEGER NOT NULL DEFAULT 0'],
      // Hidden state must survive archiving: a merged correction statement stays out of archive
      // retrieval after compact() moves it, instead of reappearing as a searchable duplicate.
      ['superseded_by', 'TEXT'],
      ['hidden', 'INTEGER NOT NULL DEFAULT 0'],
      // A row keeps its pressure credit identity across the move, so a later correction can still
      // tell whether that credit belongs to the current cycle.
      ['pressure_epoch', 'INTEGER NOT NULL DEFAULT 0'],
      ['pressure_contribution', 'INTEGER NOT NULL DEFAULT 0'],
      // The stage-3 speaker attribution survives fading: a forgotten record still says whose voice
      // it was (when one was confirmed at write time). Legacy archive rows stay NULL.
      ['speaker_attribution', 'TEXT'],
    ]) {
      if (!archiveColumns.has(name)) db.exec(`ALTER TABLE memory_archive ADD COLUMN ${name} ${type}`);
    }
    db.exec('CREATE INDEX IF NOT EXISTS memory_archive_message ON memory_archive(message_id)');
    // FTS5 external-content tables need all three triggers: without the delete/update
    // mirrors the index keeps rows whose content is gone, and MATCH itself starts throwing
    // "database disk image is malformed" once a stale row is probed.
    try {
      db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS memory_archive_fts USING fts5(
        text, content='memory_archive', content_rowid='rowid', tokenize='trigram'
      )`);
      db.exec(`CREATE TRIGGER IF NOT EXISTS memory_archive_ai AFTER INSERT ON memory_archive BEGIN
        INSERT INTO memory_archive_fts (rowid, text) VALUES (new.rowid, new.text);
      END`);
      db.exec(`CREATE TRIGGER IF NOT EXISTS memory_archive_ad AFTER DELETE ON memory_archive BEGIN
        INSERT INTO memory_archive_fts (memory_archive_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
      END`);
      db.exec(`CREATE TRIGGER IF NOT EXISTS memory_archive_au AFTER UPDATE ON memory_archive BEGIN
        INSERT INTO memory_archive_fts (memory_archive_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
        INSERT INTO memory_archive_fts (rowid, text) VALUES (new.rowid, new.text);
      END`);
    } catch {
      this.archiveFts = false;
    }

    try {
      db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
        text, content='memory_event', content_rowid='rowid', tokenize='trigram'
      )`);
      db.exec(`CREATE TRIGGER IF NOT EXISTS memory_ai AFTER INSERT ON memory_event BEGIN
        INSERT INTO memory_fts (rowid, text) VALUES (new.rowid, new.text);
      END`);
      db.exec(`CREATE TRIGGER IF NOT EXISTS memory_ad AFTER DELETE ON memory_event BEGIN
        INSERT INTO memory_fts (memory_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
      END`);
      db.exec(`CREATE TRIGGER IF NOT EXISTS memory_au AFTER UPDATE ON memory_event BEGIN
        INSERT INTO memory_fts (memory_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
        INSERT INTO memory_fts (rowid, text) VALUES (new.rowid, new.text);
      END`);
    } catch {
      this.fts = false;
    }

    this.db = db;
    // Policy state lives next to the memories so a restart cannot spend the same pressure twice.
    this.loadPolicy();
    // Legacy databases may carry an index written before the delete/update triggers existed;
    // verify once at startup and rebuild only when the index actually disagrees with the table.
    this.repairFts();
    this.migrate();
    // An older build could release a cycle by zeroing `pendingPressure` while leaving the row
    // contributions refundable. Correct that bookkeeping once, after migration and before the
    // store is usable. A failed correction is logged only: a damaged counter must not block startup.
    try {
      this.reconcilePressureCredits();
    } catch (error) {
      this.emitEvent('memory.pressure.reconcile-failed', { error: String(error?.message ?? error) });
    }
    return this;
  }

  /**
   * FTS5 external-content integrity probe. With rank=1 the check also walks the content table,
   * which is what catches rows left in the index after their content row was deleted. The plain
   * `PRAGMA integrity_check` does not surface this mismatch on the current SQLite build.
   */
  ftsConsistent(table) {
    try {
      this.db.exec(`INSERT INTO ${table}(${table}, rank) VALUES('integrity-check', 1)`);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * One-time startup repair. Rebuilds only an index that is actually inconsistent, so a healthy
   * database pays one index scan at open and never a full rebuild.
   * @returns {{checkedAt: string, checkMs: number, rebuilt: {table: string, ms: number}[], errors: string[]}}
   */
  repairFts() {
    const started = Date.now();
    const rebuilt = [];
    const errors = [];
    const tables = [];
    if (this.fts) tables.push('memory_fts');
    if (this.archiveFts) tables.push('memory_archive_fts');
    for (const table of tables) {
      if (this.ftsConsistent(table)) continue;
      const before = Date.now();
      try {
        this.db.exec('BEGIN IMMEDIATE');
        try {
          this.db.exec(`INSERT INTO ${table}(${table}) VALUES('rebuild')`);
          this.db.exec('COMMIT');
        } catch (error) {
          try {
            this.db.exec('ROLLBACK');
          } catch {
            /* already unwound */
          }
          throw error;
        }
        rebuilt.push({ table, ms: Date.now() - before });
      } catch (error) {
        errors.push(`${table}: ${error.message}`);
      }
    }
    this.ftsRepair = { checkedAt: nowIso(), checkMs: Date.now() - started, rebuilt, errors };
    return this.ftsRepair;
  }

  /**
   * Run `fn` inside one `BEGIN IMMEDIATE … COMMIT`, rolling back on any throw. Nested calls join
   * the open transaction (the outermost call owns the commit), so a helper such as
   * `noteNewMemory()` can be called from a caller that already opened one.
   */
  transact(fn) {
    if (this.txDepth > 0) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this.txDepth = 1;
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
    } finally {
      this.txDepth = 0;
    }
  }

  /**
   * Insert one row and charge its growth pressure in the SAME transaction; used by both the
   * public API and the migration path. A failure while writing `policy.pendingPressure` rolls the
   * row back and restores the in-memory counter, so a store can never end up with a memory that
   * has no pressure behind it (or a retry that stores the same memory twice).
   */
  insert(row) {
    const pendingBefore = this.pendingPressure;
    const id = row.id ?? randomUUID();
    try {
      return this.transact(() => {
        const result = this.db
          .prepare(`INSERT OR IGNORE INTO memory_event
            (id, ts, domain, kind, text, importance, clarity, last_seen, recall_count, source,
             session_id, turn_id, message_id, role, truncated, raw_text, unresolved, tz_used,
             pressure_epoch, pressure_contribution, speaker_attribution)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(
            id,
            row.ts ?? nowIso(),
            row.domain,
            row.kind ?? 'fact',
            row.text,
            row.importance ?? 50,
            row.clarity ?? 'vivid',
            row.last_seen ?? row.ts ?? nowIso(),
            row.recall_count ?? 0,
            row.source ?? '',
            row.session_id ?? null,
            row.turn_id ?? null,
            row.message_id ?? null,
            row.role ?? null,
            row.truncated ? 1 : 0,
            row.raw_text ?? null,
            row.unresolved ? 1 : 0,
            row.tz_used ?? null,
            this.pressureEpoch,
            1,
            // A restored archive row already carries the serialized text; a direct object from the
            // public API is normalized here, so every write path stores the same validated shape.
            typeof row.speaker_attribution === 'string'
              ? row.speaker_attribution
              : serializeSpeakerAttribution(row.speaker_attribution),
          );
        // Only the row that actually landed costs pressure: duplicates are ignored by SQLite.
        if (Number(result.changes) > 0) this.noteNewMemory(id);
        return result;
      });
    } catch (error) {
      // The database is back to its old state; drop the half-applied in-memory copy with it.
      this.pendingPressure = pendingBefore;
      throw error;
    }
  }

  /** Create the policy table and restore the trigger state from the database. */
  loadPolicy() {
    this.db.exec(`CREATE TABLE IF NOT EXISTS memory_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);

    const wanted = defaultPressureThreshold(this.capacity);
    const storedThreshold = Number.parseInt(this.readMeta(POLICY_KEYS.threshold) ?? '', 10);
    if (this.pressureThresholdOption !== null) {
      this.pressureThreshold = this.pressureThresholdOption;
      this.writeMeta(POLICY_KEYS.thresholdSource, 'external');
    } else if (Number.isFinite(storedThreshold) && storedThreshold > 0) {
      this.pressureThreshold = storedThreshold;
      // 2026-11-05 capacity change (2000 → 5000): the old table wrote `100` as a *calculated*
      // default, so that exact value follows the current 5% instead of freezing the old size.
      // A value the caller actually set (`external`) is kept even when it happens to be 100.
      // Databases written before the source key existed have no provenance, and are treated as
      // calculated — which is what the old build always wrote.
      const external = this.readMeta(POLICY_KEYS.thresholdSource) === 'external';
      if (
        !external &&
        storedThreshold === defaultPressureThreshold(LEGACY_DEFAULT_CAPACITY) &&
        wanted !== storedThreshold
      ) {
        this.pressureThreshold = wanted;
        this.writeMeta(POLICY_KEYS.thresholdSource, 'default');
        this.emitEvent('memory.capacity.migrated', { from: storedThreshold, to: wanted });
      }
    } else {
      this.pressureThreshold = wanted;
      this.writeMeta(POLICY_KEYS.thresholdSource, 'default');
    }
    this.writeMeta(POLICY_KEYS.threshold, this.pressureThreshold);

    this.lastTriggeredBand = normalizeBand(this.readMeta(POLICY_KEYS.band));
    const storedPending = Number.parseInt(this.readMeta(POLICY_KEYS.pending) ?? '', 10);
    // No ceiling: the counter is a plain integer and the cost of a long run is bounded by
    // "one fade pass per maintain()", not by cutting the balance (which would silently erase
    // thresholds that are still owed a pass).
    this.pendingPressure = Number.isFinite(storedPending) && storedPending > 0 ? storedPending : 0;
    const storedEpoch = Number.parseInt(this.readMeta(POLICY_KEYS.epoch) ?? '', 10);
    this.pressureEpoch = Number.isFinite(storedEpoch) && storedEpoch >= 0 ? storedEpoch : 0;
  }

  /**
   * Fold the retired `data/memory-state.json` water mark into the database, at most once.
   *
   * The database is the only decision source: a database that already recorded a band (or a
   * previous migration) ignores the legacy value entirely. Only a database that never recorded
   * one adopts it, writes it, and keeps `policy.bandMigratedFrom` as the audit trail.
   * @param {number} legacyLastBand band from the old JSON file (0 when absent)
   * @returns {{migrated: boolean, lastTriggeredBand: number, from: number|null}}
   */
  importLegacyBand(legacyLastBand) {
    this.open();
    const from = normalizeBand(legacyLastBand);
    if (this.readMeta(POLICY_KEYS.band) !== undefined || this.readMeta(POLICY_KEYS.bandMigrated) !== undefined) {
      return { migrated: false, lastTriggeredBand: this.lastTriggeredBand, from: null };
    }
    this.lastTriggeredBand = from;
    this.transact(() => {
      this.writeMeta(POLICY_KEYS.band, from);
      this.writeMeta(POLICY_KEYS.bandMigrated, `${from}@${nowIso()}`);
    });
    return { migrated: true, lastTriggeredBand: from, from };
  }

  /** Read one durable policy value, or undefined when it was never written. */
  readMeta(key) {
    try {
      return this.db.prepare('SELECT value FROM memory_meta WHERE key = ?').get(key)?.value;
    } catch {
      return undefined;
    }
  }

  /** Upsert one durable policy value. */
  writeMeta(key, value) {
    this.db
      .prepare(
        `INSERT INTO memory_meta (key, value, updated_at) VALUES (?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, String(value), nowIso());
  }

  /**
   * Fire one policy audit event through the host log when a hook was injected. Logging is
   * best-effort: a missing logger or a rejected write must never fail `open()` or a migration.
   */
  emitEvent(type, payload) {
    if (this.onEvent === null) return;
    try {
      const result = this.onEvent(type, payload);
      if (result !== null && typeof result?.catch === 'function') result.catch(() => {});
    } catch {
      /* the store must not depend on the logger */
    }
  }

  /**
   * One more memory landed: sustained-pressure credit is persisted immediately, uncapped.
   * When `recordId` is supplied, that row is stamped as the owner of this credit in the current
   * cycle (used when a previously consumed row is restored and charged again).
   */
  noteNewMemory(recordId = '') {
    if (this.db === null) return;
    this.pendingPressure += 1;
    this.writeMeta(POLICY_KEYS.pending, this.pendingPressure);
    if (typeof recordId === 'string' && recordId.length > 0) {
      this.db
        .prepare('UPDATE memory_event SET pressure_epoch = ?, pressure_contribution = 1 WHERE id = ?')
        .run(this.pressureEpoch, recordId);
    }
  }

  /** Persist the pending-pressure counter: never negative, otherwise exact. */
  setPendingPressure(value) {
    const next = Math.max(0, Math.floor(Number(value) || 0));
    this.pendingPressure = next;
    this.writeMeta(POLICY_KEYS.pending, this.pendingPressure);
    return this.pendingPressure;
  }

  /**
   * Change how many new memories one sustained-pressure fade costs. Takes effect the next time
   * `maintain()` runs and survives restarts.
   * @param {number} value positive integer
   */
  setPressureThreshold(value) {
    this.open();
    const next = Math.floor(Number(value));
    if (!Number.isFinite(next) || next < 1) throw new RangeError('pressureThreshold must be a positive integer');
    this.pressureThreshold = next;
    this.writeMeta(POLICY_KEYS.threshold, next);
    // A caller-set threshold is a user choice even when it equals the old calculated default;
    // it must survive the capacity migration unchanged.
    this.writeMeta(POLICY_KEYS.thresholdSource, 'external');
    return next;
  }

  /** Snapshot of the durable trigger state (mostly for tests and diagnostics). */
  policyState() {
    this.open();
    return {
      lastTriggeredBand: this.lastTriggeredBand,
      pendingPressure: this.pendingPressure,
      pressureThreshold: this.pressureThreshold,
    };
  }

  /**
   * One-time import of the older layouts:
   *   memory/<domain>/journal.jsonl   (v0 JSONL)
   *   memory/<domain>.db              (one SQLite file per domain)
   * Originals are renamed, never deleted, so a manual rollback stays possible.
   */
  migrate() {
    let entries = [];
    try {
      entries = readdirSync(this.dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const journal = join(this.dir, entry.name, 'journal.jsonl');
      if (!existsSync(journal)) continue;
      try {
        const rows = readFileSync(journal, 'utf8')
          .split('\n')
          .filter((line) => line.trim().length > 0)
          .map((line) => JSON.parse(line));
        for (const row of rows) this.insert({ ...row, domain: entry.name, source: 'journal' });
        renameSync(journal, `${journal}.imported`);
      } catch {
        /* unreadable journal: leave it for a human */
      }
    }

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.db')) continue;
      if (entry.name === 'memory.db') continue;
      const domain = entry.name.slice(0, -3);
      if (!DOMAIN_RE.test(domain)) continue;
      const path = join(this.dir, entry.name);
      let old = null;
      try {
        old = new DatabaseSync(path);
        // Probe before touching memory_event: profile.db and other domain-named databases are
        // not memory stores. Treating them as stores used to throw here and leave the handle open.
        const probe = old.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_event'").get();
        if (probe === undefined) continue;
        const rows = old.prepare('SELECT id, ts, domain, kind, text FROM memory_event').all();
        // Close before writing/renaming: Windows refuses both on an open SQLite handle.
        old.close();
        old = null;
        for (const row of rows) this.insert({ ...row, domain, source: 'migrated' });
        renameSync(path, `${path}.migrated`);
        for (const suffix of ['-wal', '-shm']) {
          const sidecar = `${path}${suffix}`;
          if (existsSync(sidecar)) renameSync(sidecar, `${sidecar}.migrated`);
        }
      } catch {
        /* locked or corrupt: leave it alone and report nothing */
      } finally {
        // Never leak this probe's DatabaseSync handle, not even on the skip/throw paths.
        try {
          old?.close();
        } catch {
          /* already closed */
        }
      }
    }
  }

  /**
   * Store one memory.
   * @param {string} domain scope tag (chat, work, bili, …)
   * @param {string} text the fact itself
   * @param {string} kind preference | habit | fact | event | decision
   * @param {{importance?: number, source?: string, rawText?: string|null,
   *          unresolved?: number, tzUsed?: string|null}} [extra]
   */
  add(domain, text, kind, extra = {}) {
    this.open();
    const record = {
      id: randomUUID(),
      ts: nowIso(),
      domain,
      kind: kind ?? 'fact',
      text,
      importance: extra.importance ?? scoreImportance(text, kind ?? 'fact'),
      source: extra.source ?? '',
      raw_text: extra.rawText ?? null,
      unresolved: extra.unresolved ? 1 : 0,
      tz_used: extra.tzUsed ?? null,
    };
    this.insert({ ...record, clarity: 'vivid', last_seen: record.ts });
    return record;
  }

  /** Column list shared by every message-aware read (camelCase aliases for the public shape). */
  messageColumns(alias = '') {
    const prefix = alias.length > 0 ? `${alias}.` : '';
    return [
      `${prefix}id`, `${prefix}ts`, `${prefix}domain`, `${prefix}kind`, `${prefix}text`,
      `${prefix}importance`, `${prefix}clarity`, `${prefix}role`, `${prefix}source`,
      `${prefix}session_id AS sessionId`, `${prefix}turn_id AS turnId`,
      `${prefix}message_id AS messageId`, `${prefix}truncated`, `${prefix}recall_count`,
      `${prefix}version`, `${prefix}unresolved`,
    ].join(', ');
  }

  /**
   * Record one real message. Idempotent on `messageId` across the active table AND the archive:
   * a replay or retry returns `deduped: true` and costs neither a row nor sustained-pressure
   * credit. The body is stored complete — `maxChars` belongs to recall display, not storage.
   *
   * @param {{role: 'user'|'assistant', sessionId?: string, turnId?: number|null,
   *          messageId: string, ts?: string, text: string, domain?: string,
   *          importance?: number, clarity?: string, source?: string,
   *          minChars?: number, rawText?: string|null, unresolved?: number,
   *          tzUsed?: string|null, speakerAttribution?: object|null}} [message]
   * @returns {{record: object|null, deduped: boolean, skipped: string, chars: number,
   *            truncated: boolean, archived?: boolean}}
   */
  addMessage({
    role,
    sessionId = '',
    turnId = null,
    messageId,
    ts = nowIso(),
    text,
    domain = 'chat',
    importance = 30,
    clarity = 'vivid',
    source = 'auto',
    minChars = AUTO_MEMORY_DEFAULTS.minChars,
    rawText = null,
    unresolved = 0,
    tzUsed = null,
    speakerAttribution = null,
  } = {}) {
    this.open();
    const body = typeof text === 'string' ? text.trim() : '';
    const key = typeof messageId === 'string' ? messageId.trim() : '';
    if ((role !== 'user' && role !== 'assistant') || key.length === 0 || body.length === 0) {
      return { record: null, deduped: false, skipped: 'invalid', chars: body.length, truncated: false };
    }
    const clipped = clipMessageText(body, { minChars });
    if (clipped === null) {
      return { record: null, deduped: false, skipped: 'short', chars: body.length, truncated: false };
    }
    // Idempotency spans both tables: a message the archive already owns is a replay, not new.
    const existing = this.db
      .prepare(`SELECT 'active' AS home, id FROM memory_event WHERE message_id = ?
        UNION ALL
        SELECT 'archive' AS home, id FROM memory_archive WHERE message_id = ? LIMIT 1`)
      .get(key, key);
    if (existing !== undefined) {
      return {
        record: null,
        deduped: true,
        skipped: '',
        archived: existing.home === 'archive',
        chars: body.length,
        truncated: false,
      };
    }
    // A correction that committed before this message reached the recorder already represents
    // it: the target holds the corrected fact and `extraText` (if any) became its own record.
    // Suppressing by the exact source id keeps the pure correction statement from being stored
    // as a second, contradictory memory once the delayed auto write arrives.
    const corrected = this.db
      .prepare('SELECT memory_id FROM memory_revision WHERE source_message_id = ? ORDER BY rowid DESC LIMIT 1')
      .get(key);
    if (corrected !== undefined) {
      return {
        record: null,
        deduped: true,
        skipped: 'superseded',
        correctedId: corrected.memory_id,
        chars: body.length,
        truncated: false,
      };
    }
    const record = {
      id: randomUUID(),
      ts,
      domain,
      kind: 'event',
      text: clipped.text,
      importance: Math.min(100, Math.max(0, Math.floor(Number(importance) || 30))),
      clarity,
      source,
      session_id: sessionId,
      turn_id: turnId === undefined || turnId === null ? null : turnId,
      message_id: key,
      role,
      truncated: 0,
      // Stage-2 normalization audit: the original wording (only when it differs), the zone the
      // relative date was resolved in, and whether anything could not be resolved.
      raw_text: typeof rawText === 'string' && rawText.length > 0 && rawText !== clipped.text ? rawText : null,
      unresolved: unresolved ? 1 : 0,
      tz_used: typeof tzUsed === 'string' && tzUsed.length > 0 ? tzUsed : null,
      // Stage 3 (additive): only a NEW voice record carries one; a typed/assistant record stores
      // NULL and every legacy row stays NULL. Validated once, here at the public boundary.
      speaker_attribution: serializeSpeakerAttribution(speakerAttribution),
    };
    const inserted = this.insert({ ...record, last_seen: record.ts });
    // Stage 3: the turn's other side (if it is already stored) becomes an explicit `turn` link in
    // both directions. Autocommit has completed here, so a link failure cannot invalidate the
    // record; `linkTurnRecord` is itself best-effort.
    if (Number(inserted.changes) > 0) {
      try {
        this.linkTurnRecord(record);
      } catch {
        /* linking is an enhancement, never a condition for storing the message */
      }
    }
    return {
      record: {
        id: record.id,
        ts: record.ts,
        domain: record.domain,
        kind: record.kind,
        text: record.text,
        importance: record.importance,
        clarity: record.clarity,
        source: record.source,
        role: record.role,
        sessionId,
        turnId: record.turn_id,
        messageId: key,
        truncated: 0,
        chars: record.text.length,
        // The validated field exactly as stored (already sanitized), not the caller's object.
        speakerAttribution: record.speaker_attribution === null
          ? null
          : JSON.parse(record.speaker_attribution),
      },
      deduped: false,
      skipped: '',
      chars: record.text.length,
      truncated: false,
    };
  }

  // ---- stage 3: explicit links --------------------------------------------------------------

  /**
   * Insert one link edge. Idempotent on `(from_id, to_id, kind)` through the unique index, which
   * is what makes a replayed turn pair or a retried correction a no-op. Never charges capacity,
   * never writes FTS (this table is not content), and never reinforces a record.
   *
   * `to_version` snapshots the version of the basis record at write time, so a later correction
   * of that record (version + 1) makes the edge provably outdated instead of silently current.
   * @returns {boolean} true when a new row was written
   */
  insertLink(fromId, toId, kind, confidence = MEMORY_LINK_CONFIDENCE[kind], createdAt = nowIso()) {
    if (typeof fromId !== 'string' || fromId.length === 0) return false;
    if (typeof toId !== 'string' || toId.length === 0 || toId === fromId) return false;
    if (!MEMORY_LINK_KINDS.includes(kind)) return false;
    const numeric = Number(confidence);
    const value = Number.isFinite(numeric) ? Math.min(1, Math.max(0, numeric)) : (MEMORY_LINK_CONFIDENCE[kind] ?? 1);
    // A link target is normally an active record; a `correction` target is a revision id and has
    // no version of its own (NULL = no version boundary to enforce).
    const target = this.db.prepare('SELECT version FROM memory_event WHERE id = ?').get(toId);
    const toVersion = target === undefined ? null : Number(target.version ?? 1);
    const result = this.db
      .prepare(`INSERT OR IGNORE INTO memory_link
        (id, from_id, to_id, kind, confidence, to_version, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), fromId, toId, kind, value, toVersion, createdAt);
    return Number(result.changes) > 0;
  }

  /** Public link write (tests/diagnostics); a rejected edge returns false instead of throwing. */
  addLink(fromId, toId, kind, confidence) {
    this.open();
    return this.insertLink(fromId, toId, kind, confidence);
  }

  /**
   * Same-turn pairing: every user/assistant couple already stored for this turn is linked in BOTH
   * directions ("若两者都入库"). Only active rows qualify — a hidden/superseded correction
   * statement is not a conversation partner. Best-effort: a link failure never costs the record.
   */
  linkTurnRecord(record) {
    if (record === null || typeof record !== 'object') return 0;
    const sessionId = record.session_id;
    const turn = Number(record.turn_id);
    if (typeof sessionId !== 'string' || sessionId.length === 0) return 0;
    if (record.turn_id === null || record.turn_id === undefined || !Number.isInteger(turn)) return 0;
    if (record.role !== 'user' && record.role !== 'assistant') return 0;
    if (typeof record.id !== 'string' || record.id.length === 0) return 0;
    const peers = this.db
      .prepare(`SELECT id FROM memory_event
        WHERE session_id = ? AND turn_id = ? AND id <> ? AND role IN ('user', 'assistant')
          AND role <> ? AND hidden = 0 AND superseded_by IS NULL`)
      .all(sessionId, turn, record.id, record.role);
    if (peers.length === 0) return 0;
    let added = 0;
    this.transact(() => {
      for (const peer of peers) {
        if (this.insertLink(record.id, peer.id, 'turn')) added += 1;
        if (this.insertLink(peer.id, record.id, 'turn')) added += 1;
      }
    });
    return added;
  }

  /**
   * One-hop targets of `fromId`, inside every retrieval boundary the caller enforces:
   * domain (scope), role, time window, active-row only `superseded_by IS NULL` / `hidden = 0`.
   * Archived rows are absent by construction (they live in `memory_archive`), so a link can never
   * pull an archived memory back into the prompt. A `referent` edge is also retired the moment
   * its basis is corrected (`stale = 1`) or its recorded `to_version` no longer matches the basis
   * row: a corrected name must not drag the old wording back in. `LIMIT` keeps one node bounded.
   */
  linkedRecords(fromId, { domains = null, roles = null, fromIso = null, toIso = null, limit = 12 } = {}) {
    this.open();
    if (typeof fromId !== 'string' || fromId.length === 0) return [];
    const filters = [
      'l.from_id = ?', 'e.superseded_by IS NULL', 'e.hidden = 0', 'e.id <> l.from_id',
      'COALESCE(l.stale, 0) = 0',
      "(l.kind <> 'referent' OR l.to_version IS NULL OR l.to_version = e.version)",
    ];
    const args = [fromId];
    if (Array.isArray(domains) && domains.length > 0) {
      filters.push(`e.domain IN (${domains.map(() => '?').join(', ')})`);
      args.push(...domains);
    }
    if (Array.isArray(roles) && roles.length > 0) {
      const roleList = roles.filter((role) => role === 'user' || role === 'assistant');
      if (roleList.length === 0) return [];
      filters.push(`e.role IN (${roleList.map(() => '?').join(', ')})`);
      args.push(...roleList);
    }
    if (typeof fromIso === 'string' && fromIso.length > 0) {
      filters.push('e.ts >= ?');
      args.push(fromIso);
    }
    if (typeof toIso === 'string' && toIso.length > 0) {
      filters.push('e.ts < ?');
      args.push(toIso);
    }
    const cap = Math.max(1, Math.floor(Number(limit) || 12));
    return this.db
      .prepare(`SELECT ${this.messageColumns('e')},
          l.kind AS linkKind, l.confidence AS linkConfidence
        FROM memory_link l JOIN memory_event e ON e.id = l.to_id
        WHERE ${filters.join(' AND ')}
        ORDER BY l.created_at ASC, l.rowid ASC LIMIT ?`)
      .all(...args, cap);
  }

  /** Read-only link edges that start at `fromId` (diagnostics/tests, no expansion). */
  linksFrom(fromId) {
    this.open();
    if (typeof fromId !== 'string' || fromId.length === 0) return [];
    return this.db
      .prepare(`SELECT id, from_id AS fromId, to_id AS toId, kind, confidence,
          to_version AS toVersion, stale, created_at AS createdAt
        FROM memory_link WHERE from_id = ? ORDER BY created_at ASC, rowid ASC`)
      .all(fromId);
  }

  /** Ids among `ids` whose own `referent` edge was retired (`stale = 1`). One query per recall. */
  staleReferentSources(ids = []) {
    this.open();
    const list = [...new Set((Array.isArray(ids) ? ids : [])
      .filter((id) => typeof id === 'string' && id.length > 0))];
    if (list.length === 0) return new Set();
    const rows = this.db
      .prepare(`SELECT DISTINCT from_id AS id FROM memory_link
        WHERE kind = 'referent' AND COALESCE(stale, 0) = 1
          AND from_id IN (${list.map(() => '?').join(', ')})`)
      .all(...list);
    return new Set(rows.map((row) => row.id));
  }

  /**
   * Current active record by id, or null. Used after a same-turn correction so a reader can
   * replace a cached older copy with the corrected version instead of showing stale text.
   */
  getActiveById(id) {
    this.open();
    if (typeof id !== 'string' || id.length === 0) return null;
    const row = this.db
      .prepare(`SELECT ${this.messageColumns()} FROM memory_event WHERE id = ?`)
      .get(id);
    return row === undefined ? null : row;
  }

  /** Message-level records, newest first (tests/diagnostics; not a retention change). */
  messageRecords({ sessionId = null, roles = null, limit = 100 } = {}) {
    this.open();
    const filters = ["message_id IS NOT NULL", "role IN ('user', 'assistant')"];
    const args = [];
    if (typeof sessionId === 'string' && sessionId.length > 0) {
      filters.push('session_id = ?');
      args.push(sessionId);
    }
    if (Array.isArray(roles) && roles.length > 0) {
      filters.push(`role IN (${roles.map(() => '?').join(', ')})`);
      args.push(...roles);
    }
    return this.db
      .prepare(`SELECT ${this.messageColumns()} FROM memory_event
        WHERE ${filters.join(' AND ')} ORDER BY ts DESC LIMIT ?`)
      .all(...args, Math.max(1, Math.floor(Number(limit) || 1)));
  }

  /**
   * Stage-3 speaker attribution stored with one message record, or null.
   *
   * Read-only and deliberately outside `messageColumns()`: existing queries keep their exact
   * shape. A legacy row (or a typed/assistant message) has no value and returns null.
   *
   * @param {string} messageId
   * @returns {{speakerId: string|null, assigned: boolean, confidence: string,
   *            source: string, at: string|null}|null}
   */
  messageAttribution(messageId) {
    this.open();
    const key = typeof messageId === 'string' ? messageId.trim() : '';
    if (key.length === 0) return null;
    const row = this.db
      .prepare("SELECT speaker_attribution AS value FROM memory_event WHERE message_id = ?")
      .get(key);
    if (row === undefined || typeof row.value !== 'string' || row.value.length === 0) return null;
    try {
      const parsed = JSON.parse(row.value);
      return parsed !== null && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }

  /**
   * Raise a record that the user has explicitly confirmed as a convention/fact. Auto records
   * start at 30 and are deliberately excluded from `restore()`; this is the one way up, used
   * when a manual `assistant_remember` names the record it confirms.
   */
  promote(id, { importance = 50 } = {}) {
    this.open();
    if (typeof id !== 'string' || id.length === 0) return null;
    const row = this.db.prepare('SELECT importance FROM memory_event WHERE id = ?').get(id);
    if (row === undefined) return null;
    const target = Math.min(100, Math.max(Number(row.importance) || 0, Math.floor(Number(importance) || 50)));
    this.db
      .prepare("UPDATE memory_event SET importance = ?, clarity = 'vivid', last_seen = ? WHERE id = ?")
      .run(target, nowIso(), id);
    return this.db
      .prepare(`SELECT ${this.messageColumns()} FROM memory_event WHERE id = ?`)
      .get(id);
  }

  /** Promote any auto record whose exact text the manual entry restates. Best-effort. */
  promoteByText(text, importance = 50) {
    this.open();
    const body = typeof text === 'string' ? text.trim() : '';
    if (body.length === 0) return [];
    const rows = this.db
      .prepare(`SELECT id FROM memory_event
        WHERE source = 'auto' AND role IS NOT NULL AND superseded_by IS NULL AND text = ?
        ORDER BY ts DESC LIMIT 3`)
      .all(body);
    for (const row of rows) this.promote(row.id, { importance });
    return rows.map((row) => row.id);
  }

  /** One turn before and one turn after `turnId` inside the same session (or fewer at the edges). */
  neighborTurns(sessionId, turnId, window = 1) {
    const turns = new Set();
    const numeric = Number(turnId);
    if (typeof sessionId !== 'string' || sessionId.length === 0 || !Number.isFinite(numeric)) return [];
    turns.add(numeric);
    const previous = this.db.prepare(`SELECT turn_id AS turn FROM memory_event
      WHERE session_id = ? AND role IS NOT NULL AND turn_id IS NOT NULL AND turn_id < ?
      ORDER BY turn_id DESC LIMIT 1`);
    const next = this.db.prepare(`SELECT turn_id AS turn FROM memory_event
      WHERE session_id = ? AND role IS NOT NULL AND turn_id IS NOT NULL AND turn_id > ?
      ORDER BY turn_id ASC LIMIT 1`);
    let cursor = numeric;
    for (let step = 0; step < window; step += 1) {
      const row = previous.get(sessionId, cursor);
      if (row === undefined) break;
      turns.add(Number(row.turn));
      cursor = Number(row.turn);
    }
    cursor = numeric;
    for (let step = 0; step < window; step += 1) {
      const row = next.get(sessionId, cursor);
      if (row === undefined) break;
      turns.add(Number(row.turn));
      cursor = Number(row.turn);
    }
    return [...turns].sort((left, right) => left - right);
  }

  /**
   * Every recorded message of the given turns, in conversational order. The same domain/time
   * boundaries as the link query are applied here: a pair/neighbour is context for a hit, never a
   * way around the scope or the requested window (`domains: ['chat']` must not return a `work`
   * row just because it shares the turn or is one turn away).
   */
  turnMessages(sessionId, turns, { domains = null, fromIso = null, toIso = null } = {}) {
    if (typeof sessionId !== 'string' || sessionId.length === 0 || turns.length === 0) return [];
    const filters = ['session_id = ?', 'role IS NOT NULL', 'superseded_by IS NULL'];
    const args = [sessionId];
    if (Array.isArray(domains) && domains.length > 0) {
      filters.push(`domain IN (${domains.map(() => '?').join(', ')})`);
      args.push(...domains);
    }
    if (typeof fromIso === 'string' && fromIso.length > 0) {
      filters.push('ts >= ?');
      args.push(fromIso);
    }
    if (typeof toIso === 'string' && toIso.length > 0) {
      filters.push('ts < ?');
      args.push(toIso);
    }
    return this.db
      .prepare(`SELECT ${this.messageColumns()} FROM memory_event
        WHERE ${filters.join(' AND ')}
          AND turn_id IN (${turns.map(() => '?').join(', ')})
        ORDER BY turn_id ASC, ts ASC, CASE role WHEN 'user' THEN 0 ELSE 1 END ASC`)
      .all(...args, ...turns);
  }

  /** Recent message-level rows for a role/time question with no useful keywords. */
  recentMessageHits({ domains = null, roles = null, fromIso = null, toIso = null, limit = 12 } = {}) {
    const scoped = Array.isArray(domains) && domains.length > 0;
    const roleList = Array.isArray(roles) && roles.length > 0
      ? roles.filter((role) => role === 'user' || role === 'assistant')
      : null;
    const filters = ["role IN ('user', 'assistant')", "superseded_by IS NULL"];
    const args = [];
    if (scoped) {
      filters.push(`domain IN (${domains.map(() => '?').join(', ')})`);
      args.push(...domains);
    }
    if (roleList !== null) {
      filters.push(`role IN (${roleList.map(() => '?').join(', ')})`);
      args.push(...roleList);
    }
    if (typeof fromIso === 'string' && fromIso.length > 0) {
      filters.push('ts >= ?');
      args.push(fromIso);
    }
    if (typeof toIso === 'string' && toIso.length > 0) {
      filters.push('ts < ?');
      args.push(toIso);
    }
    const where = filters.join(' AND ');
    const scanned = this.db.prepare(`SELECT COUNT(*) AS c FROM memory_event WHERE ${where}`).get(...args).c;
    const hits = this.db
      .prepare(`SELECT ${this.messageColumns()} FROM memory_event WHERE ${where}
        ORDER BY ts DESC LIMIT ?`)
      .all(...args, Math.max(1, Math.floor(Number(limit) || 1)));
    return { hits, scanned };
  }

  /** Current fill level against the configured capacity (hidden audit rows take no space). */
  usage() {
    this.open();
    const row = this.db
      .prepare('SELECT COUNT(*) AS records, COALESCE(SUM(LENGTH(text)), 0) AS chars FROM memory_event WHERE hidden = 0')
      .get();
    const archived = this.db.prepare('SELECT COUNT(*) AS c FROM memory_archive').get().c;
    return {
      records: row.records,
      chars: row.chars,
      archived,
      capacity: this.capacity,
      ratio: row.records / this.capacity,
    };
  }

  /** Clarity counts, for the settings page bar. */
  clarityCounts() {
    this.open();
    const rows = this.db.prepare('SELECT clarity, COUNT(*) AS c FROM memory_event GROUP BY clarity').all();
    const counts = { vivid: 0, clear: 0, fuzzy: 0, trace: 0 };
    for (const row of rows) counts[row.clarity] = row.c;
    return counts;
  }

  /** Recall feedback: one clarity level back (never past vivid) + a freshness bump. */
  restore(ids) {
    if (!Array.isArray(ids) || ids.length === 0) return;
    this.open();
    const read = this.db.prepare('SELECT clarity, recall_count, importance FROM memory_event WHERE id = ?');
    const write = this.db.prepare(
      'UPDATE memory_event SET clarity = ?, last_seen = ?, recall_count = recall_count + 1, importance = MIN(100, importance + 2) WHERE id = ?',
    );
    const stamp = nowIso();
    for (const id of ids) {
      const row = read.get(id);
      if (row === undefined) continue;
      // Only meaningful memories get reinforcement: otherwise routine questions
      // ("几点了") keep pulling their own low-value records back into view.
      if ((row.importance ?? 0) < 50) continue;
      const index = Math.max(0, CLARITY_LEVELS.indexOf(row.clarity) - 1);
      write.run(CLARITY_LEVELS[index] ?? 'vivid', stamp, id);
    }
  }

  /**
   * Drop revisions past `MEMORY_REVISION_LIMIT` for one memory, oldest first. The caller owns the
   * transaction; no FTS/capacity interaction exists because this table is neither content nor
   * a retrieval source.
   */
  trimRevisions(memoryId) {
    const stale = this.db
      .prepare('SELECT rowid AS rid FROM memory_revision WHERE memory_id = ? ORDER BY rowid DESC LIMIT -1 OFFSET ?')
      .all(memoryId, MEMORY_REVISION_LIMIT);
    if (stale.length === 0) return 0;
    const remove = this.db.prepare('DELETE FROM memory_revision WHERE rowid = ?');
    for (const row of stale) remove.run(row.rid);
    return stale.length;
  }

  /**
   * Prove the existing `memory_au` trigger actually moved the index from `beforeText` to
   * `afterText` for this row. Runs inside the caller's transaction, so a desync rolls the whole
   * correction back instead of leaving text and FTS disagreeing.
   */
  assertFtsSynced(id, beforeText, afterText) {
    if (!this.fts) return;
    const row = this.db.prepare('SELECT rowid FROM memory_event WHERE id = ?').get(id);
    if (row === undefined) return;
    // `AND rowid = ?` is not reliable on an external-content FTS table (it can return another
    // row's id together with a match), so match by probe and filter the returned ids here.
    const hits = (probe) =>
      this.db
        .prepare('SELECT rowid FROM memory_fts WHERE memory_fts MATCH ?')
        .all(`"${probe.replaceAll('"', '""')}"`)
        .some((match) => Number(match.rowid) === Number(row.rowid));
    const added = ftsProbe(afterText, beforeText) ?? ftsProbe(afterText);
    if (added !== null && !hits(added)) {
      throw new Error('fts-desync: corrected text is not indexed');
    }
    const removed = ftsProbe(beforeText, afterText);
    if (removed !== null && hits(removed)) {
      throw new Error('fts-desync: replaced text is still indexed');
    }
  }

  /** Read-only correction history (newest first), for audit/diagnostics — not a model tool. */
  revisions(memoryId, { limit = 20 } = {}) {
    this.open();
    if (typeof memoryId !== 'string' || memoryId.length === 0) return [];
    return this.db
      .prepare(`SELECT id, memory_id AS memoryId, before_text AS beforeText,
        after_text AS afterText, source_message_id AS sourceMessageId, at
        FROM memory_revision WHERE memory_id = ? ORDER BY rowid DESC LIMIT ?`)
      .all(memoryId, Math.max(1, Math.floor(Number(limit) || 1)));
  }

  /**
   * Apply one correction as a LOCAL fragment replacement on an existing active record.
   *
   * Everything happens in one transaction: version check → fragment check → UPDATE (saving the
   * pre-rewrite body in `raw_text` on the first rewrite) → revision → merge of the already-stored
   * correction message (hidden + `superseded_by`, pressure refunded) → optional new `extraText`
   * record. A version conflict, an absent/duplicated fragment or an injected failure leaves every
   * one of those untouched. It deliberately does NOT touch the target's
   * importance/clarity/unresolved and never charges `pendingPressure` for the UPDATE itself.
   *
   * Idempotency is per operation (resolved target + pre-version + source + fragments), so a
   * different correction in the same utterance still applies while an exact retry is a no-op.
   *
   * Dependent records are NOT rewritten (no mass rename). The `referent` edges that point AT this
   * record are retired (`stale = 1`) in the same transaction and their dependents are flagged
   * `unresolved = 1`, so recall stops pairing the old wording with the new one; one
   * `memory.link.stale {from, to, reason:'referent-corrected'}` event is emitted per retired edge.
   *
   * Target resolution: `targetId` wins; otherwise `expectedText` must occur in exactly one active
   * record. No unique target returns `needs-target` untouched, with the matching candidates (an
   * empty list when nothing matched) so the caller can retry with an explicit `targetId`.
   *
   * @param {{targetId?: string, expectedVersion: number, expectedText: string,
   *          replacement: string, sourceMessageId?: string, extraText?: string}} [input]
   */
  correct({
    targetId = '',
    expectedVersion,
    expectedText,
    replacement,
    sourceMessageId = '',
    extraText = '',
  } = {}) {
    this.open();
    const source = typeof sourceMessageId === 'string' ? sourceMessageId.trim() : '';
    const fragment = typeof expectedText === 'string' ? expectedText : '';
    const version = Number(expectedVersion);
    const wantedId = typeof targetId === 'string' ? targetId.trim() : '';
    const empty = (error, extra = {}) => ({
      ok: false,
      error,
      id: '',
      version: 0,
      from: '',
      to: '',
      sourceMessageId: source,
      sourceMerged: source.length > 0,
      mergeReason: source.length > 0 ? '' : 'no-source',
      idempotent: false,
      extraId: '',
      revisionId: '',
      supersededId: '',
      currentVersion: 0,
      text: '',
      candidates: [],
      staleLinkIds: [],
      ...extra,
    });
    if (
      fragment.length === 0 ||
      !Number.isInteger(version) ||
      version < 1 ||
      typeof replacement !== 'string'
    ) {
      return empty('invalid-arguments');
    }
    const pendingBefore = this.pendingPressure;
    let result;
    try {
      result = this.transact(() => {
        // Resolve the REAL target first. The operation key may only be derived after this: when
        // the caller omits `targetId`, the old key carried '' and two corrections aimed at
        // different records produced the same id — the second was silently treated as a retry.
        let row;
        if (wantedId.length > 0) {
          row = this.db
            .prepare(`SELECT id, ts, domain, version, text FROM memory_event
              WHERE id = ? AND superseded_by IS NULL AND hidden = 0`)
            .get(wantedId);
          if (row === undefined) {
            const archived = this.db.prepare('SELECT 1 AS hit FROM memory_archive WHERE id = ?').get(wantedId);
            return empty(archived === undefined ? 'needs-target' : 'archived-target');
          }
        } else {
          const rows = this.db
            .prepare(`SELECT id, ts, domain, version, text FROM memory_event
              WHERE superseded_by IS NULL AND hidden = 0 AND text LIKE ? ESCAPE '\\'
              ORDER BY ts DESC LIMIT 20`)
            .all(`%${escapeLike(fragment)}%`);
          if (rows.length !== 1) {
            // No unique target: never guess (not "newest", not "first candidate") and never
            // write a key for an operation that has no record.
            return empty('needs-target', {
              candidates: rows.map((candidate) => ({
                id: candidate.id,
                version: Number(candidate.version ?? 1),
                domain: candidate.domain,
                text: candidate.text,
                ts: candidate.ts,
              })),
            });
          }
          row = rows[0];
        }

        // Key = resolved target + the operation's pre-version + the two fragments. The same
        // replacement on a different record is a different operation; a retry still carries the
        // version fetched before the first success, so it matches and stays idempotent.
        const operationId = correctionOperationId({
          source,
          targetId: row.id,
          version,
          expectedText: fragment,
          replacement,
        });
        // Checked BEFORE the version check: a retry carries the version the caller fetched before
        // the first success, so it must not look stale.
        const prior = this.db
          .prepare('SELECT memory_id FROM memory_revision WHERE operation_id = ? ORDER BY rowid DESC LIMIT 1')
          .get(operationId);
        if (prior !== undefined) {
          const current = this.db.prepare('SELECT version FROM memory_event WHERE id = ?').get(prior.memory_id);
          return empty('', {
            ok: true,
            idempotent: true,
            id: prior.memory_id,
            version: Number(current?.version ?? 0),
          });
        }

        const currentVersion = Number(row.version ?? 1);
        if (currentVersion !== version) {
          return empty('version-conflict', { id: row.id, currentVersion });
        }
        const before = String(row.text ?? '');
        const first = before.indexOf(fragment);
        if (first < 0 || before.indexOf(fragment, first + fragment.length) >= 0) {
          return empty('fragment-mismatch', { id: row.id, currentVersion });
        }
        const after = `${before.slice(0, first)}${replacement}${before.slice(first + fragment.length)}`;
        const stamp = nowIso();
        const updated = this.db
          .prepare(`UPDATE memory_event
            SET raw_text = CASE WHEN raw_text IS NULL OR raw_text = '' THEN text ELSE raw_text END,
                text = ?, version = version + 1, updated_at = ?
            WHERE id = ? AND version = ?`)
          .run(after, stamp, row.id, version);
        if (Number(updated.changes) !== 1) {
          return empty('version-conflict', { id: row.id, currentVersion });
        }
        const revisionId = randomUUID();
        this.db
          .prepare(`INSERT INTO memory_revision
            (id, memory_id, before_text, after_text, source_message_id, operation_id, at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(revisionId, row.id, before, after, source.length > 0 ? source : null, operationId, stamp);
        this.trimRevisions(row.id);
        // Stage 3 correction link: the modified record points at the revision that describes the
        // edit (目标 → 修正记录). It is provenance, not retrieval material: a `memory_revision`
        // id is not an active memory id, so recall's one-hop join can never re-add the corrected
        // text as a duplicate row.
        this.insertLink(row.id, revisionId, 'correction', MEMORY_LINK_CONFIDENCE.correction, stamp);
        // The existing memory_au trigger owns the index update; prove it agrees before commit.
        this.assertFtsSynced(row.id, before, after);
        // A basis record just moved to version + 1: every `referent` edge that was built on the
        // old wording is now outdated. Retire the edge and mark the dependent record as
        // unresolved; the dependent TEXT is deliberately left alone (no mass rename).
        const staled = this.db
          .prepare(`SELECT from_id AS fromId FROM memory_link
            WHERE to_id = ? AND kind = 'referent' AND COALESCE(stale, 0) = 0`)
          .all(row.id);
        for (const edge of staled) {
          this.db
            .prepare(`UPDATE memory_link SET stale = 1
              WHERE from_id = ? AND to_id = ? AND kind = 'referent'`)
            .run(edge.fromId, row.id);
          this.db.prepare('UPDATE memory_event SET unresolved = 1 WHERE id = ?').run(edge.fromId);
        }
        const staleLinkIds = staled.map((edge) => edge.fromId);

        let supersededId = '';
        if (source.length > 0) {
          const auto = this.db
            .prepare(`SELECT id FROM memory_event
              WHERE message_id = ? AND id <> ? AND source = 'auto'
                AND superseded_by IS NULL AND hidden = 0`)
            .get(source, row.id);
          if (auto !== undefined) {
            // The pure correction statement is now fully represented by the corrected target:
            // refund the capacity credit it cost, then mark it hidden (trace + superseded) so
            // usage() stops counting it while the audit row survives until compact() archives it.
            this.withdrawPressureForMessage(source);
            this.db
              .prepare(`UPDATE memory_event
                SET superseded_by = ?, clarity = 'trace', hidden = 1, updated_at = ?
                WHERE id = ?`)
              .run(row.id, stamp, auto.id);
            supersededId = auto.id;
          }
        }

        let extraId = '';
        const extra = typeof extraText === 'string' ? extraText.trim() : '';
        if (extra.length > 0) {
          // Same transaction, but a genuinely NEW record: this one does cost one pressure credit.
          const record = {
            id: randomUUID(),
            ts: stamp,
            domain: row.domain,
            kind: 'event',
            text: extra,
            importance: 30,
            clarity: 'vivid',
            source: 'correction',
            role: 'user',
          };
          this.insert({ ...record, last_seen: stamp });
          extraId = record.id;
        }

        return {
          ok: true,
          error: '',
          id: row.id,
          version: version + 1,
          from: fragment,
          to: replacement,
          sourceMessageId: source,
          sourceMerged: source.length > 0,
          mergeReason: source.length > 0 ? '' : 'no-source',
          idempotent: false,
          extraId,
          revisionId,
          supersededId,
          currentVersion: version + 1,
          text: after,
          candidates: [],
          staleLinkIds,
        };
      });
    } catch (error) {
      // The database rolled back; drop any in-memory pressure credit the extra insert added.
      this.pendingPressure = pendingBefore;
      throw error;
    }
    if (result.ok && result.idempotent !== true) {
      // Fragments only — the event log never needs the whole memory body.
      this.emitEvent('memory.corrected', {
        id: result.id,
        version: result.version,
        from: result.from,
        to: result.to,
        sourceMessageId: result.sourceMessageId,
      });
      // One event per retired dependency: ids + reason only, never the memory body.
      for (const from of result.staleLinkIds ?? []) {
        this.emitEvent('memory.link.stale', { from, to: result.id, reason: 'referent-corrected' });
      }
    }
    return result;
  }

  /**
   * Restore one record to the `before_text` of a specific revision. Writes a new "revert"
   * revision, bumps the version and reuses the same FTS assertion. Store-only: deliberately
   * NOT registered as a model tool.
   */
  revertCorrection(id, revisionId) {
    this.open();
    if (typeof id !== 'string' || typeof revisionId !== 'string' || id.length === 0 || revisionId.length === 0) {
      return { ok: false, error: 'invalid-arguments' };
    }
    const pendingBefore = this.pendingPressure;
    try {
      const result = this.transact(() => {
        const revision = this.db
          .prepare('SELECT before_text, source_message_id FROM memory_revision WHERE id = ? AND memory_id = ?')
          .get(revisionId, id);
        if (revision === undefined) return { ok: false, error: 'revision-not-found' };
        const row = this.db.prepare('SELECT version, text FROM memory_event WHERE id = ?').get(id);
        if (row === undefined) return { ok: false, error: 'not-found' };
        const before = String(row.text ?? '');
        const after = String(revision.before_text ?? '');
        const stamp = nowIso();
        this.db
          .prepare(`UPDATE memory_event
            SET raw_text = CASE WHEN raw_text IS NULL OR raw_text = '' THEN text ELSE raw_text END,
                text = ?, version = version + 1, updated_at = ?
            WHERE id = ?`)
          .run(after, stamp, id);
        const revertRevisionId = randomUUID();
        this.db
          .prepare(`INSERT INTO memory_revision
            (id, memory_id, before_text, after_text, source_message_id, operation_id, at)
            VALUES (?, ?, ?, ?, NULL, NULL, ?)`)
          .run(revertRevisionId, id, before, after, stamp);
        this.trimRevisions(id);
        this.assertFtsSynced(id, before, after);
        // Undoing the correction makes its source statement current again: bring the merged
        // correction record back out of hidden state (and back from the archive after compact)
        // and restore the capacity credit that hiding it refunded.
        let restoredId = '';
        const sourceMessageId = typeof revision.source_message_id === 'string' ? revision.source_message_id : '';
        if (sourceMessageId.length > 0) {
          const hidden = this.db
            .prepare(`SELECT id FROM memory_event
              WHERE message_id = ? AND source = 'auto' AND superseded_by = ? AND hidden = 1
              ORDER BY ts DESC LIMIT 1`)
            .get(sourceMessageId, id);
          if (hidden !== undefined) {
            this.db
              .prepare(`UPDATE memory_event
                SET hidden = 0, superseded_by = NULL, clarity = 'vivid', updated_at = ?
                WHERE id = ?`)
              .run(stamp, hidden.id);
            this.noteNewMemory(hidden.id);
            restoredId = hidden.id;
          } else {
            const archived = this.db
              .prepare(`SELECT * FROM memory_archive
                WHERE message_id = ? AND superseded_by = ? AND hidden = 1
                ORDER BY archived_at DESC LIMIT 1`)
              .get(sourceMessageId, id);
            if (archived !== undefined) {
              this.db.prepare('DELETE FROM memory_archive WHERE id = ?').run(archived.id);
              this.insert({ ...archived, clarity: 'vivid', last_seen: archived.ts });
              restoredId = archived.id;
            }
          }
        }
        return {
          ok: true,
          error: '',
          id,
          version: Number(row.version ?? 1) + 1,
          from: before,
          to: after,
          revisionId: revertRevisionId,
          restoredId,
          text: after,
        };
      });
      return result;
    } catch (error) {
      this.pendingPressure = pendingBefore;
      throw error;
    }
  }

  /**
   * Exact, message-scoped pressure refund, scoped to the cycle that paid the credit.
   *
   * A refund requires three facts, all read from the row itself: it is an auto record with a
   * visible `hidden = 0` row, its `pressure_contribution` is still positive (not consumed), and
   * its `pressure_epoch` equals the current cycle. A row from a released cycle keeps its balance
   * out of the new cycle — otherwise a merge would silently deduct a credit that `maintain()`
   * already returned. The contribution is zeroed in the same statement, so a repeated withdrawal
   * finds nothing to refund even while the row is still visible.
   */
  withdrawPressureForMessage(messageId) {
    this.open();
    const key = typeof messageId === 'string' ? messageId.trim() : '';
    if (key.length === 0) return { withdrawn: false, reason: 'no-message-id', pendingPressure: this.pendingPressure };
    const row = this.db
      .prepare(`SELECT id, pressure_epoch AS epoch, pressure_contribution AS contribution,
          'event' AS home
        FROM memory_event WHERE message_id = ? AND source = 'auto' AND hidden = 0
        UNION ALL
        SELECT id, pressure_epoch AS epoch, pressure_contribution AS contribution,
          'archive' AS home
        FROM memory_archive WHERE message_id = ? AND hidden = 0
        LIMIT 1`)
      .get(key, key);
    if (row === undefined) {
      return { withdrawn: false, reason: 'no-active-row', pendingPressure: this.pendingPressure };
    }
    const table = row.home === 'archive' ? 'memory_archive' : 'memory_event';
    const contribution = Math.max(0, Math.floor(Number(row.contribution) || 0));
    const epoch = Number.isFinite(Number(row.epoch)) ? Number(row.epoch) : 0;
    const consume = () => this.db.prepare(`UPDATE ${table} SET pressure_contribution = 0 WHERE id = ?`).run(row.id);
    if (contribution <= 0) {
      return { withdrawn: false, reason: 'already-consumed', id: row.id, pendingPressure: this.pendingPressure };
    }
    if (epoch !== this.pressureEpoch) {
      // The cycle that paid this credit was released: retire it so no later cycle can refund it.
      consume();
      return {
        withdrawn: false,
        reason: 'stale-epoch',
        id: row.id,
        epoch,
        pendingPressure: this.pendingPressure,
      };
    }
    const next = Math.max(0, this.pendingPressure - contribution);
    consume();
    return {
      withdrawn: true,
      id: row.id,
      epoch,
      contribution,
      pendingPressure: this.setPendingPressure(next),
    };
  }

  /**
   * Spend `amount` units of the current pressure cycle, oldest credit first.
   *
   * The pending counter is an aggregate, but a refund is per message: a fade must therefore
   * consume the individual `pressure_contribution` rows it is paying for, not just the total.
   * Credits are taken in deterministic `(ts, id)` order (oldest first) across the active table
   * and the archive; a row reached by the tail of the charge keeps its remainder, so a later
   * withdrawal refunds exactly what is left. Runs inside the caller's transaction: a failure
   * after the credits were touched rolls them back together with `pendingPressure`.
   * @param {number} amount credits owed by this pass (normally one threshold)
   * @returns {number} credits actually charged (never more than pending)
   */
  consumePressureCredits(amount) {
    const spent = Math.min(this.pendingPressure, Math.max(0, Math.floor(Number(amount) || 0)));
    if (spent > 0) {
      let left = spent;
      const credits = this.db
        .prepare(`SELECT id, ts, 'memory_event' AS home, pressure_contribution AS contribution
            FROM memory_event WHERE pressure_epoch = ? AND pressure_contribution > 0
          UNION ALL
          SELECT id, ts, 'memory_archive' AS home, pressure_contribution AS contribution
            FROM memory_archive WHERE pressure_epoch = ? AND pressure_contribution > 0
          ORDER BY ts ASC, id ASC`)
        .all(this.pressureEpoch, this.pressureEpoch);
      for (const credit of credits) {
        if (left <= 0) break;
        const take = Math.min(left, Math.max(0, Math.floor(Number(credit.contribution) || 0)));
        if (take === 0) continue;
        const table = credit.home === 'memory_archive' ? 'memory_archive' : 'memory_event';
        this.db
          .prepare(`UPDATE ${table} SET pressure_contribution = pressure_contribution - ? WHERE id = ?`)
          .run(take, credit.id);
        left -= take;
      }
    }
    this.setPendingPressure(this.pendingPressure - spent);
    return spent;
  }

  /**
   * One-time load correction for a store written by an older pressure policy.
   *
   * The old build could end a cycle by clearing `pendingPressure` without retiring the rows that
   * still carried a refundable `pressure_contribution`, so a later merge refunded a credit the new
   * balance never held. Reconciliation removes only the excess: when the current cycle's credits
   * exceed the counter, the oldest `(ts, id)` contributions are trimmed until the sum matches. It
   * never raises `pendingPressure`, changes the threshold/ratio/release rule, or invents a credit.
   *
   * Runs in one IMMEDIATE transaction; a throw rolls every write back and propagates so `open()`
   * can log it without failing startup. A consistent database writes nothing and emits nothing.
   *
   * @returns {{reconciled: boolean, creditsBefore: number, creditsAfter: number,
   *            pendingPressure: number}}
   */
  reconcilePressureCredits() {
    this.open();
    const sumCredits = () => {
      const row = this.db
        .prepare(`SELECT
          (SELECT COALESCE(SUM(pressure_contribution), 0) FROM memory_event
            WHERE pressure_epoch = ? AND pressure_contribution > 0) +
          (SELECT COALESCE(SUM(pressure_contribution), 0) FROM memory_archive
            WHERE pressure_epoch = ? AND pressure_contribution > 0) AS credits`)
        .get(this.pressureEpoch, this.pressureEpoch);
      return Math.max(0, Math.floor(Number(row?.credits) || 0));
    };

    let creditsBefore = 0;
    let creditsAfter = 0;
    let reconciled = false;
    this.transact(() => {
      creditsBefore = sumCredits();
      creditsAfter = creditsBefore;
      let excess = creditsBefore - this.pendingPressure;
      if (excess <= 0) return;
      const credits = this.db
        .prepare(`SELECT id, ts, 'memory_event' AS home, pressure_contribution AS contribution
            FROM memory_event WHERE pressure_epoch = ? AND pressure_contribution > 0
          UNION ALL
          SELECT id, ts, 'memory_archive' AS home, pressure_contribution AS contribution
            FROM memory_archive WHERE pressure_epoch = ? AND pressure_contribution > 0
          ORDER BY ts ASC, id ASC`)
        .all(this.pressureEpoch, this.pressureEpoch);
      for (const credit of credits) {
        if (excess <= 0) break;
        const contribution = Math.max(0, Math.floor(Number(credit.contribution) || 0));
        if (contribution === 0) continue;
        const take = Math.min(excess, contribution);
        const table = credit.home === 'memory_archive' ? 'memory_archive' : 'memory_event';
        this.applyPressureCredit(table, take, credit.id);
        excess -= take;
      }
      creditsAfter = sumCredits();
      reconciled = creditsAfter !== creditsBefore;
    });

    if (reconciled) {
      this.emitEvent('memory.pressure.reconciled', {
        creditsBefore,
        creditsAfter,
        pendingPressure: this.pendingPressure,
      });
    }
    return { reconciled, creditsBefore, creditsAfter, pendingPressure: this.pendingPressure };
  }

  /** Trim one row's refundable contribution by `amount` in a single statement. */
  applyPressureCredit(table, amount, id) {
    this.db
      .prepare(`UPDATE ${table} SET pressure_contribution = pressure_contribution - ? WHERE id = ?`)
      .run(amount, id);
  }

  /**
   * One capacity pass: demote the lowest-scoring `ratio` share of the still-demotable records by
   * one level. Everything already at `trace` stays put, so `take` is computed from the rows that
   * can actually move: a table full of trace rows is not a fade candidate and must not be paid
   * for.
   * @param {{ratio?: number}} [options]
   */
  fadePass({ ratio = 0.5 } = {}) {
    this.open();
    const candidates = `clarity <> 'trace' AND hidden = 0`;
    const total = this.db.prepare(`SELECT COUNT(*) AS c FROM memory_event WHERE ${candidates}`).get().c;
    if (total === 0) return { faded: 0, considered: 0 };
    const take = Math.max(1, Math.ceil(total * ratio));
    const rows = this.db
      .prepare(`SELECT id, clarity FROM memory_event WHERE ${candidates}
        ORDER BY (importance + recall_count * 3) ASC, ts ASC LIMIT ?`)
      .all(take);
    const update = this.db.prepare('UPDATE memory_event SET clarity = ? WHERE id = ?');
    let faded = 0;
    for (const row of rows) {
      const index = CLARITY_LEVELS.indexOf(row.clarity);
      const next = Math.min(CLARITY_LEVELS.length - 1, (index < 0 ? 0 : index) + 1);
      if (next === index) continue;
      update.run(CLARITY_LEVELS[next], row.id);
      faded += 1;
    }
    return { faded, considered: total };
  }

  /**
   * Move the weakest *forgotten* records into the archive until usage drops to `targetRatio`.
   *
   * Capacity drives fading, not archiving: only records that already reached the end of the
   * fade path (`clarity = 'trace'`) may leave the active table, ordered by low
   * importance, then oldest. Vivid / clear / fuzzy records are never selected here, and this
   * pass never demotes anything — `fadePass()` owns the decay rhythm.
   *
   * Only the overflow (`before - target`) is moved, at most 50 per batch, so a compact pass can
   * never empty a table that is barely over the line. When there are not enough trace records
   * the pass legitimately stops short of `target`: those rows stay put (`limitedBy: 'trace'`)
   * and the next fade cycle supplies new candidates. Hidden trace rows are moved first — they
   * already cost no active capacity, and their hidden flag must survive into the archive. The
   * whole pass runs in one IMMEDIATE transaction: a failure halfway leaves the table exactly as
   * it was. The archive is append-only and never injected: memory is "forgotten", not destroyed.
   *
   * @param {{targetRatio?: number}} [options]
   * @returns {{moved: number, target: number, before: number, after: number, limitedBy: string|null}}
   */
  compact({ targetRatio = 0.85 } = {}) {
    this.open();
    const target = Math.max(1, Math.floor(this.capacity * targetRatio));
    const before = this.usage().records;
    let moved = 0;
    /** Why the pass could not reach `target`, or null when it did. */
    let limitedBy = null;

    if (before > target) {
      const columns = `id, ts, domain, kind, text, importance, clarity,
        message_id, session_id, turn_id, role, truncated, superseded_by, hidden, tz_used, raw_text,
        unresolved, pressure_epoch, pressure_contribution, speaker_attribution`;
      const selectHidden = this.db.prepare(`SELECT ${columns}
        FROM memory_event WHERE clarity = 'trace' AND hidden = 1
        ORDER BY importance ASC, ts ASC LIMIT ?`);
      const selectVisible = this.db.prepare(`SELECT ${columns}
        FROM memory_event WHERE clarity = 'trace' AND hidden = 0
        ORDER BY importance ASC, ts ASC LIMIT ?`);
      const archive = this.db.prepare(
        `INSERT OR IGNORE INTO memory_archive
          (id, ts, domain, kind, text, importance, clarity, archived_at, reason,
           message_id, session_id, turn_id, role, truncated, superseded_by, hidden, tz_used,
           raw_text, unresolved, pressure_epoch, pressure_contribution, speaker_attribution)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const remove = this.db.prepare('DELETE FROM memory_event WHERE id = ?');

      this.db.exec('BEGIN IMMEDIATE');
      try {
        const move = (row, stamp) => {
          archive.run(
            row.id, row.ts, row.domain, row.kind, row.text, row.importance, row.clarity, stamp, 'capacity',
            row.message_id ?? null, row.session_id ?? null, row.turn_id ?? null, row.role ?? null,
            row.truncated ?? 0, row.superseded_by ?? null, row.hidden ?? 0, row.tz_used ?? null,
            row.raw_text ?? null, row.unresolved ?? 0,
            row.pressure_epoch ?? 0, row.pressure_contribution ?? 0,
            row.speaker_attribution ?? null,
          );
          remove.run(row.id);
          moved += 1;
        };
        // Hidden rows are already inactive (usage() ignores them): archive them first so their
        // hidden flag survives the move, but they never count toward the visible overflow.
        let hiddenLeft = this.db
          .prepare(`SELECT COUNT(*) AS c FROM memory_event WHERE clarity = 'trace' AND hidden = 1`)
          .get().c;
        while (hiddenLeft > 0) {
          const batch = selectHidden.all(Math.min(50, hiddenLeft));
          if (batch.length === 0) break;
          const stamp = nowIso();
          for (const row of batch) move(row, stamp);
          hiddenLeft -= batch.length;
        }
        let remaining = before - target;
        let visibleMoved = 0;
        while (remaining > 0) {
          const batch = selectVisible.all(Math.min(50, remaining));
          if (batch.length === 0) break; // no visible trace records left to forget
          const stamp = nowIso();
          for (const row of batch) {
            move(row, stamp);
            remaining -= 1;
            visibleMoved += 1;
          }
        }
        if (visibleMoved < before - target) limitedBy = 'trace';
        this.db.exec('COMMIT');
      } catch (error) {
        try {
          this.db.exec('ROLLBACK');
        } catch {
          /* transaction already unwound */
        }
        throw error;
      }
    }

    const after = this.usage().records;
    return { moved, target, before, after, limitedBy };
  }

  /**
   * Run the capacity policy.
   *
   * The band always follows the table's real fill level (so deleting or archiving re-arms the
   * policy), while `lastTriggeredBand` records the highest band whose fade has already run. A
   * band above that durable value triggers ONE single-level fade pass. At the top band, staying
   * over 90% keeps decaying too: every `pressureThreshold` newly added memories trigger one more
   * pass, and banked thresholds stay pending — one maintain spends exactly the thresholds it
   * actually executed (0 or 1), so batching the same additions cannot change the total: 250
   * additions at threshold 100 leave 150 after one pass, never `250 % 100 = 50`. The counter is
   * never capped: a 400-addition burst banks all four thresholds and ends with the same pass
   * count and the same remainder as four batches of 100 — only the work per call is limited.
   *
   * Charging and releasing are different things. A pass is charged (at most one threshold, never
   * zeroed) only when it actually demoted a row: `faded === 0` means every candidate was already
   * trace, so the balance is left untouched in BOTH branches. A cross-band observation is
   * recorded separately from the charge: the durable band marker always advances, so a table that
   * cannot fade is checked once instead of on every maintain. The balance is released only by the
   * capacity line (`ratio <= 0.85`): that ends the pressure cycle and deliberately zeroes it. A
   * band drop from 3 to 2 above that line is not a release, and no time or "N consecutive checks"
   * condition is involved. The pass, the charge and the band marker commit together, so a crash
   * cannot leave "faded but uncharged" or "charged but unfaded" behind, and no pressure is ever
   * spent twice — not even across restarts. Releasing also advances `pressureEpoch` (persisted),
   * which retires the old cycle's refundable contributions.
   *
   * At 90% and above, `compact()` then archives trace records toward 85%; when there
   * are not enough trace rows the table legitimately stays over the line (`limitedBy: 'trace'`).
   *
   * @param {{lastBand?: number, pressureThreshold?: number}} [state] `lastBand` is accepted for
   *   call compatibility only and never decides anything: the database owns the band marker.
   * @returns {{band: number, faded: number, moved: number, archived: number, limitedBy: string|null,
   *   pendingPressure: number, pressureThreshold: number, triggeredBy: 'watermark'|'pressure'|null,
   *   before: {records: number, ratio: number}, after: {records: number, ratio: number, archived: number}}}
   */
  maintain({ lastBand = 0, pressureThreshold } = {}) {
    this.open();
    if (pressureThreshold !== undefined) this.setPressureThreshold(pressureThreshold);
    // P-52 cleanup path: undelivered candidates expire after CANDIDATE_TTL_MS. This touches the
    // candidate ledger only — never `memory_event`, its capacity ratio, or its fade policy.
    const prunedCandidates = this.pruneCandidates();

    const usage = this.usage();
    const band = bandForRatio(usage.ratio);

    // Follow the water level downwards: a shrinking table re-arms every band it fell through.
    // `lastBand` is accepted for call compatibility only — the database is the sole decision
    // source, so an outside guess (or a stale JSON file) can never keep a band marked consumed.
    if (band < this.lastTriggeredBand) this.lastTriggeredBand = band;
    const lastTriggeredBand = this.lastTriggeredBand;

    // RELEASE (end of the pressure cycle), not a "charge": at or below the release line the
    // additions that built the balance are gone (deleted/archived), so the whole balance is
    // deliberately cleared — a policy reset, not a lost count. Above the line nothing is reset:
    // a drop from band 3 to band 2 is NOT a release, and 0.85 < ratio < 0.90 keeps the old
    // pressure state. The water level alone decides; there is no time condition and no
    // "N consecutive maintain()" condition.
    const released = usage.ratio <= PRESSURE_RELEASE_RATIO;

    let faded = 0;
    let triggeredBy = null;

    // The fade, the pressure it charges and the band marker commit in ONE transaction, so a
    // crash in between can never persist "faded but uncharged" or "charged but unfaded".
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (band > lastTriggeredBand) {
        // First crossing of this band: one single-level decay pass.
        const pass = this.fadePass();
        faded = pass.faded;
        // Observing the crossing and charging for it are separate facts: the durable marker
        // advances even when nothing could be demoted, so a trace-only table is checked
        // once instead of on every maintain().
        this.lastTriggeredBand = band;
        this.writeMeta(POLICY_KEYS.band, band);
        // CHARGE (one unit of work), never a release: at most one threshold and only when a row
        // actually moved. `faded === 0` leaves the balance exactly as it was (not zeroed).
        if (pass.faded > 0) {
          triggeredBy = 'watermark';
          // Charge the pass and consume the rows it paid for in the same transaction.
          this.consumePressureCredits(this.pressureThreshold);
        }
      } else if (
        !released &&
        band === BAND_CUTOFFS.length &&
        this.pendingPressure >= this.pressureThreshold
      ) {
        // Sustained top band: one maintain fires at most one pass, so it charges exactly the
        // passes it executed (0 or 1). Every complete threshold left over stays banked for the
        // following calls; the formula is subtraction, never a modulo, because a modulo would
        // erase thresholds that are still owed a pass (250 at threshold 100 → 150, not 50).
        const pass = this.fadePass();
        faded = pass.faded;
        this.writeMeta(POLICY_KEYS.band, this.lastTriggeredBand);
        // Same charge rule as the cross-band branch: no demotable row → no work → no charge.
        if (pass.faded > 0) {
          triggeredBy = 'pressure';
          this.consumePressureCredits(this.pressureThreshold);
        }
      } else {
        this.writeMeta(POLICY_KEYS.band, this.lastTriggeredBand);
      }
      // The release is applied after the branches, so it also ends a cycle whose crossing faded
      // nothing; it is a deliberate reset of the whole cycle, not the per-pass charge above.
      // Advancing the epoch retires every refundable contribution of the old cycle: those credits
      // were already released, so a later merge must not deduct them from the new balance.
      if (released) {
        this.pressureEpoch += 1;
        this.writeMeta(POLICY_KEYS.epoch, this.pressureEpoch);
        if (this.pendingPressure !== 0) this.setPendingPressure(0);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* transaction already unwound */
      }
      // The database kept the old values, so drop the half-applied in-memory copy with them.
      this.loadPolicy();
      throw error;
    }

    let moved = 0;
    let limitedBy = null;
    if (usage.ratio >= BAND_CUTOFFS[2]) {
      const compacted = this.compact({ targetRatio: 0.85 });
      moved = compacted.moved;
      limitedBy = compacted.limitedBy;
    }

    const after = this.usage();
    return {
      before: { records: usage.records, ratio: usage.ratio },
      after: { records: after.records, ratio: after.ratio, archived: after.archived },
      band,
      faded,
      moved,
      archived: moved,
      limitedBy,
      pendingPressure: this.pendingPressure,
      pressureThreshold: this.pressureThreshold,
      triggeredBy,
      // Ledger-only cleanup, reported so a maintain run can prove the expiry rule ran.
      candidatesPruned: prunedCandidates.removed,
    };
  }

  /** True when the archive holds at least one row (a LIKE fallback can only help then). */
  archiveHasRows() {
    return this.db.prepare('SELECT 1 AS hit FROM memory_archive LIMIT 1').get() !== undefined;
  }

  /**
   * Archive retrieval shared by `searchArchive()` and `listArchive()`.
   *
   * The trigram index cannot answer a query shorter than 3 characters: MATCH returns zero rows
   * without raising, which used to be indistinguishable from "no such memory". Short queries
   * therefore take the escaped LIKE path directly. Longer queries try FTS first; when it finds
   * nothing although the archive is not empty (or FTS is unavailable), LIKE runs once and the
   * rows are tagged `fallback: 'like'` so a diagnostic can tell the two paths apart.
   *
   * @param {string} query user query
   * @param {{columns: string, orderBy?: string, limit: number, offset?: number, rank?: boolean,
   *          includeHidden?: boolean}} options `includeHidden` is internal (audit only): the
   *   default hides merged correction rows even after they reach the archive.
   * @returns {{rows: object[], fallback: boolean}}
   */
  queryArchive(query, { columns, orderBy = 'a.archived_at DESC', limit, offset = 0, rank = false, includeHidden = false }) {
    const text = typeof query === 'string' ? query : String(query ?? '');
    const visible = includeHidden ? '' : ' AND a.hidden = 0';
    const like = (fallback) => {
      const rows = this.db
        .prepare(`SELECT ${columns} FROM memory_archive a WHERE a.text LIKE ? ESCAPE '\\'${visible}
          ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
        .all(`%${escapeLike(text)}%`, limit, offset);
      return { rows: fallback ? rows.map((row) => ({ ...row, fallback: 'like' })) : rows, fallback };
    };

    if (text.length < 3 || !this.archiveFts) return like(false);
    try {
      const rows = this.db
        .prepare(`SELECT ${columns} FROM memory_archive_fts
          JOIN memory_archive a ON a.rowid = memory_archive_fts.rowid
          WHERE memory_archive_fts MATCH ?${visible} ORDER BY ${rank ? 'memory_archive_fts.rank' : orderBy}
          LIMIT ? OFFSET ?`)
        .all(`"${text.replaceAll('"', '""')}"`, limit, offset);
      if (rows.length > 0 || !this.archiveHasRows()) return { rows, fallback: false };
    } catch {
      /* FTS could not answer: one LIKE fallback below */
    }
    return like(true);
  }

  /** Keyword recall over the archive (explicit user request only; hidden rows opt-in only). */
  searchArchive(query, limit = 5, { includeHidden = false } = {}) {
    this.open();
    return this.queryArchive(query, {
      // Message identity travels with the hit: without `role`/`session_id`/`turn_id` the caller
      // cannot show “who said it, when, in which turn”, only a bare text blob.
      columns: `a.id, a.ts, a.domain, a.text, a.role, a.session_id, a.turn_id, a.message_id,
        a.truncated`,
      limit,
      rank: true,
      includeHidden,
    }).rows;
  }

  /**
   * Browse the archive for manual pruning (newest first).
   *
   * `fromIso`/`toIso` are a half-open time filter on the archived original's `ts`. The C2
   * fallback selects by window FIRST and ranks by the question only afterwards, so the archived
   * text never has to contain the question sentence.
   */
  listArchive({ query = '', limit = 20, offset = 0, includeHidden = false, fromIso = null, toIso = null } = {}) {
    this.open();
    const columns = `a.id, a.ts, a.domain, a.text, a.importance, a.clarity, a.archived_at,
      a.message_id AS messageId, a.session_id AS sessionId, a.turn_id AS turnId, a.role, a.truncated,
      a.message_id, a.session_id, a.turn_id`;
    if (typeof query === 'string' && query.length > 0) {
      return this.queryArchive(query, { columns, limit, offset, includeHidden }).rows;
    }
    const filters = [];
    const args = [];
    if (!includeHidden) filters.push('a.hidden = 0');
    if (typeof fromIso === 'string' && fromIso.length > 0) {
      filters.push('a.ts >= ?');
      args.push(fromIso);
    }
    if (typeof toIso === 'string' && toIso.length > 0) {
      filters.push('a.ts < ?');
      args.push(toIso);
    }
    const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
    return this.db
      .prepare(`SELECT ${columns} FROM memory_archive a ${where} ORDER BY a.archived_at DESC LIMIT ? OFFSET ?`)
      .all(...args, limit, offset);
  }

  /** Permanent removal from the archive — the user's own lever to shrink storage for good. */
  deleteArchived(ids) {
    if (!Array.isArray(ids) || ids.length === 0) return { deleted: 0 };
    this.open();
    const stmt = this.db.prepare('DELETE FROM memory_archive WHERE id = ?');
    let deleted = 0;
    for (const id of ids) {
      stmt.run(id);
      deleted += 1;
    }
    // memory_archive_ad mirrors the delete into memory_archive_fts, so no rebuild is needed here.
    return { deleted };
  }

  /**
   * Recall across domains. `domains: null` searches everything (the common case).
   *
   * Candidates come from FTS/LIKE, then get re-ranked by four signals: how many query terms
   * they actually contain, their importance, how recent they are, and their FTS rank. That
   * lets a fuzzy but highly relevant memory outrank a stale highly-important one.
   *
   * Optional `roles` / `fromIso` / `toIso` narrow the candidate pool for the message-level
   * recall lane ("我说过什么", "刚才"): they are SQL filters, not a re-rank, so a role or time
   * question cannot be outvoted by an unrelated highly important record.
   *
   * @param {{query: string, domains?: string[]|null, limit?: number, roles?: string[]|null,
   *          fromIso?: string|null, toIso?: string|null}} options
   */
  search({ query, domains = null, limit = 5, roles = null, fromIso = null, toIso = null }) {
    this.open();
    const scoped = Array.isArray(domains) && domains.length > 0;
    const roleList = Array.isArray(roles) && roles.length > 0
      ? roles.filter((role) => role === 'user' || role === 'assistant')
      : null;
    // Superseded correction statements are kept for audit but never retrieved: excluding them
    // at the SQL layer also keeps neighbour expansion from pulling them back as context.
    const filters = ['superseded_by IS NULL'];
    const filterArgs = [];
    if (scoped) {
      filters.push(`domain IN (${domains.map(() => '?').join(',')})`);
      filterArgs.push(...domains);
    }
    if (roleList !== null) {
      filters.push(`role IN (${roleList.map(() => '?').join(',')})`);
      filterArgs.push(...roleList);
    }
    if (typeof fromIso === 'string' && fromIso.length > 0) {
      filters.push('ts >= ?');
      filterArgs.push(fromIso);
    }
    if (typeof toIso === 'string' && toIso.length > 0) {
      filters.push('ts < ?');
      filterArgs.push(toIso);
    }
    const where = filters.length > 0 ? ` AND ${filters.join(' AND ')}` : '';

    const countStmt = this.db.prepare(`SELECT COUNT(*) AS c FROM memory_event WHERE 1=1${where}`);
    const scanned = countStmt.get(...filterArgs).c;

    const pool = Math.max(limit * 4, 20);
    let hits = [];

    // Probe with every term instead of the whole sentence: users ask in full sentences,
    // while stored memories are short fragments.
    const probes = retrievalTerms(query);
    const likeProbes = probes.length > 0 ? probes : [query];

    if (this.fts && probes.length > 0) {
      const match = probes.map((term) => `"${term.replaceAll('"', '""')}"`).join(' OR ');
      const aliased = filters.map((filter) => `e.${filter}`).join(' AND ');
      const sql = `SELECT ${this.messageColumns('e')}
        FROM memory_fts JOIN memory_event e ON e.rowid = memory_fts.rowid
        WHERE memory_fts MATCH ?${aliased.length > 0 ? ` AND ${aliased}` : ''}
        ORDER BY memory_fts.rank LIMIT ?`;
      try {
        hits = this.db.prepare(sql).all(match, ...filterArgs, pool);
      } catch {
        hits = [];
      }
    }

    if (hits.length === 0) {
      const likes = likeProbes.map(() => 'text LIKE ?').join(' OR ');
      const likeArgs = likeProbes.map((term) => `%${term}%`);
      const sql = `SELECT ${this.messageColumns()} FROM memory_event WHERE (${likes})${where}
        ORDER BY ts DESC LIMIT ?`;
      hits = this.db.prepare(sql).all(...likeArgs, ...filterArgs, pool);
    }

    const terms = tokenizeQuery(query);
    const scored = hits.map((hit, index) => {
      const text = String(hit.text).toLowerCase();
      let matched = 0;
      for (const term of terms) {
        if (text.includes(term)) matched += 1;
      }
      const score =
        matched * 3 +
        (hit.importance ?? 50) / 25 +
        recencyBoost(hit.ts) +
        (1 - index / (hits.length || 1));
      return { ...hit, matched, score: Math.round(score * 100) / 100 };
    });
    scored.sort((left, right) => right.score - left.score);

    return { hits: scored.slice(0, limit), scanned, terms };
  }

  /**
   * Records whose text names a day inside the three-day window around `now`, found WITHOUT keyword
   * overlap. The probe is deliberately narrow and bounded: the three absolute day stamps of
   * yesterday/today/tomorrow plus the repeat markers (`每周`/`每星期`/`每礼拜`/`周末`/`每月`) are
   * matched with LIKE, the row cap is `UPCOMING_INJECT.scanLimit`, and every candidate is then
   * re-checked by `upcomingConvention` — the LIKE probe only narrows the scan, it never decides.
   * Hidden/superseded rows and an explicit domain scope are honoured like every other read.
   *
   * @param {{now?: Date, domains?: string[]|null, limit?: number, excludeIds?: Set<string>|null}} [options]
   * @returns {object[]} candidate rows in the ordinary recall row shape, newest first
   */
  upcomingCandidates({ now = new Date(), domains = null, limit = UPCOMING_INJECT.scanLimit, excludeIds = null } = {}) {
    this.open();
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) return [];
    const stamp = (offsetDays) => {
      const day = localMidnight(now, offsetDays);
      return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
    };
    const days = [-1, 0, 1].map((offset) => stamp(offset));
    const filters = [
      `(${[
        ...days.map(() => 'text LIKE ?'),
        "text LIKE '%每周%'",
        "text LIKE '%每星期%'",
        "text LIKE '%每礼拜%'",
        "text LIKE '%周末%'",
        "text LIKE '%每月%'",
      ].join(' OR ')})`,
      'hidden = 0',
      'superseded_by IS NULL',
    ];
    const args = days.map((day) => `%${day}%`);
    if (Array.isArray(domains) && domains.length > 0) {
      filters.push(`domain IN (${domains.map(() => '?').join(', ')})`);
      args.push(...domains);
    }
    const cap = Math.max(1, Math.floor(Number(limit) || UPCOMING_INJECT.scanLimit));
    const rows = this.db
      .prepare(`SELECT ${this.messageColumns()} FROM memory_event
        WHERE ${filters.join(' AND ')} ORDER BY ts DESC LIMIT ?`)
      .all(...args, cap);
    const excluded = excludeIds instanceof Set ? excludeIds : new Set();
    return rows.filter((row) => !excluded.has(row.id) && upcomingConvention(row.text, now).matched);
  }

  /**
   * Message-level recall: keyword relevance, an optional time window, an optional speaker
   * filter, then ±one turn of context inside the hit's own session. Numbers are deliberately
   * small: the whole block is bounded by an explicit row/character budget.
   *
   * @param {{query?: string, domains?: string[]|null, limit?: number, budgetChars?: number,
   *          maxRecords?: number, window?: number, now?: Date, displayChars?: number}} [options]
   * @returns {{hits: object[], scanned: number, terms: string[], mode: 'keyword'|'time'|'adjacent',
   *            roles: string[], window: number, range: string, expanded: boolean,
   *            from: string|null, to: string|null, relaxed: boolean, displayChars: number}}
   */
  recall({
    query = '',
    domains = null,
    limit = 6,
    budgetChars = 600,
    maxRecords = 6,
    window = 1,
    now = new Date(),
    displayChars = AUTO_MEMORY_DEFAULTS.maxChars,
    // Stage 3: follow one explicit link from each direct hit. `false` is the pre-link baseline
    // (performance comparison and an escape hatch), never a different retrieval rule.
    links = true,
  } = {}) {
    this.open();
    const text = typeof query === 'string' ? query : '';
    const intent = detectRecallIntent(text, now);
    const mode = intent.adjacent ? 'adjacent' : intent.range !== null ? 'time' : 'keyword';
    const terms = tokenizeQuery(text);
    const wantsHistory = intent.roles !== null || intent.range !== null;

    /** One retrieval attempt against an explicit window; `from`/`to` may be null. */
    const collect = (from, to) => {
      let hits = [];
      let scanned = 0;
      let keywordHits = 0;
      if (terms.length > 0) {
        const found = this.search({
          query: text,
          domains,
          limit: Math.max(limit * 3, 12),
          roles: intent.roles,
          fromIso: from,
          toIso: to,
        });
        hits = found.hits;
        scanned = found.scanned;
        keywordHits = hits.length;
      }
      // A history question ("我说过什么") has no useful keyword overlap at all: list the recent
      // originals in the requested role/time window instead of injecting nothing.
      if (hits.length === 0 && wantsHistory) {
        const listed = this.recentMessageHits({
          domains,
          roles: intent.roles,
          fromIso: from,
          toIso: to,
          limit: Math.max(limit * 3, 12),
        });
        hits = listed.hits;
        scanned = listed.scanned;
      }
      return { hits, scanned, keywordHits };
    };

    // "上次" starts with a wide 90-day window and is widened once when no keyword hit matched;
    // the actual window used is reported below so an event log proves what was searched.
    let usedFrom = intent.range?.fromIso ?? null;
    const usedTo = intent.range?.toIso ?? null;
    let attempt = collect(usedFrom, usedTo);
    let relaxed = false;
    if (attempt.keywordHits === 0 && intent.range?.relaxable === true && usedFrom !== null) {
      usedFrom = null;
      relaxed = true;
      attempt = collect(usedFrom, usedTo);
    }
    const primary = attempt.hits;
    const scanned = attempt.scanned;

    const explicit = intent.range !== null || intent.roles !== null;
    const roleSet = intent.roles !== null ? new Set(intent.roles) : null;
    const scored = primary.map((hit, index) => {
      const body = String(hit.text).toLowerCase();
      let matched = 0;
      for (const term of terms) {
        if (body.includes(term)) matched += 1;
      }
      const roleBonus = roleSet !== null && roleSet.has(hit.role) ? 3 : 0;
      let recency = recencyBoost(hit.ts);
      if (intent.range !== null) {
        const stamp = Date.parse(hit.ts);
        const anchor = usedTo !== null ? Date.parse(usedTo) : now.getTime();
        const ageMinutes = Number.isFinite(stamp) ? Math.max(0, (anchor - stamp) / 60_000) : Infinity;
        recency = ageMinutes <= 30 ? 1.6 : ageMinutes <= 180 ? 1.2 : 1;
      }
      // Source is a secondary factor only: for a keyword query it nudges a close tie toward
      // the distilled record, but an explicit role/time intent never lets it win.
      const autoPenalty = !explicit && hit.source === 'auto' ? 0.2 : 0;
      // Upcoming-convention weight: a graded multiplier by relative day (today ×3, yesterday ×1.5,
      // tomorrow ×1.2, anything else ×1). It only re-ranks rows the query already retrieved, so it
      // can never widen the candidate set, invent a hit, or spend more budget.
      const upcoming = upcomingConvention(hit.text, now);
      const base =
        matched * 3 +
        roleBonus +
        (hit.importance ?? 50) / 25 +
        recency +
        (1 - index / (primary.length || 1)) -
        autoPenalty;
      const score = base * upcoming.weight;
      return {
        ...hit,
        matched,
        upcoming: upcoming.matched,
        upcomingLevel: upcoming.level,
        score: Math.round(score * 100) / 100,
      };
    });
    scored.sort((left, right) => {
      const gap = Math.abs(left.score - right.score);
      if (!explicit && gap <= 0.35 && (left.source === 'auto') !== (right.source === 'auto')) {
        return left.source === 'auto' ? 1 : -1;
      }
      if (right.score !== left.score) return right.score - left.score;
      return (Date.parse(right.ts) || 0) - (Date.parse(left.ts) || 0);
    });
    // One event per recall that actually re-ranked something: how many candidates were raised, the
    // width of the window they were measured against, and the per-level tally (today/prev/next).
    // Zero matches emit nothing (a quiet recall stays quiet), and every number here is a ranking
    // fact, never an injection count.
    const upcomingLevels = { today: 0, prev: 0, next: 0 };
    for (const row of scored) {
      if (row.upcoming !== true) continue;
      if (Object.hasOwn(upcomingLevels, row.upcomingLevel)) upcomingLevels[row.upcomingLevel] += 1;
    }
    const upcomingMatched = upcomingLevels.today + upcomingLevels.prev + upcomingLevels.next;
    if (upcomingMatched > 0) {
      this.emitEvent('memory.upcoming', {
        matched: upcomingMatched,
        windowDays: UPCOMING_SPAN_DAYS,
        levels: upcomingLevels,
      });
    }

    // ---- assembly -----------------------------------------------------------------------
    // Old order was "expand hit #1's whole neighbourhood, then hit #2, then cut at six rows".
    // With a busy neighbourhood the first group consumed every slot, so a second independently
    // relevant (often older) hit never appeared. Assembly is now four explicit passes —
    // independent hits, one explicit link hop, same-turn pairs, then ±window neighbours — and
    // context only spends what the hits left over. Relevance decides which hits are direct; it is
    // not a later add-on. A link is never followed from another link (one hop, no diffusion).
    const rowLimit = Math.min(MEMORY_ASSEMBLY.maxRecords, Math.max(0, Math.floor(Number(maxRecords) || 0)));
    const charLimit = Math.min(MEMORY_ASSEMBLY.maxChars, Math.max(0, Math.floor(Number(budgetChars) || 0)));
    const perRow = Math.max(1, Math.floor(Number(displayChars) || AUTO_MEMORY_DEFAULTS.maxChars));
    const contextual = intent.contextual === true;
    const hitQuota = contextual ? MEMORY_ASSEMBLY.contextualHitQuota : MEMORY_ASSEMBLY.hitQuota;
    const contextQuota = contextual ? MEMORY_ASSEMBLY.contextualContextQuota : MEMORY_ASSEMBLY.contextQuota;
    const turnKeyOf = (row) => (typeof row.sessionId === 'string' && row.sessionId.length > 0
      && row.turnId !== null && row.turnId !== undefined
      ? `${row.sessionId}\u0000${row.turnId}`
      : null);
    const roleOk = (row) => roleSet === null || (typeof row.role === 'string' && roleSet.has(row.role));

    // Bounded "upcoming convention" supplement: a record that names today / yesterday / tomorrow
    // is relevant on that day even when the question shares no keyword with it (a coding question
    // on Saturday must still reach 「每周六一起看动画」). Only keyword-mode recalls supplement, so an
    // explicit history question never grows a stray row. Direct hits are always selected first.
    const upcomingPool = [];
    if (mode === 'keyword' && rowLimit > 0 && terms.length > 0) {
      const directIds = new Set(scored.map((row) => row.id));
      for (const row of this.upcomingCandidates({
        now,
        domains,
        excludeIds: directIds,
        limit: UPCOMING_INJECT.scanLimit,
      })) {
        if (!roleOk(row) || directIds.has(row.id)) continue;
        const graded = upcomingConvention(row.text, now);
        upcomingPool.push({ ...row, kind: 'upcoming', matched: 0, score: 0, upcoming: true, upcomingLevel: graded.level });
        if (upcomingPool.length >= UPCOMING_INJECT.maxRows) break;
      }
    }

    const dropped = [];
    const droppedIds = new Set();
    const drop = (row, reason) => {
      if (row === null || typeof row !== 'object' || droppedIds.has(row.id)) return;
      droppedIds.add(row.id);
      dropped.push({ id: row.id, messageId: row.messageId ?? null, kind: row.kind ?? 'hit', reason });
    };

    // Pass 1 — independent direct hits, one per turn. A turn's second matching line is a pair,
    // not a competing hit, so six paraphrases of one exchange cannot occupy the hit slots.
    const hitPool = [];
    const hitTurns = new Set();
    const duplicateIds = new Set();
    for (const row of scored) {
      if (!roleOk(row)) continue;
      const key = turnKeyOf(row);
      if (key !== null && hitTurns.has(key)) {
        duplicateIds.add(row.id);
        continue;
      }
      if (key !== null) hitTurns.add(key);
      hitPool.push({ ...row, kind: 'hit' });
    }

    const chosen = [];
    const chosenIds = new Set();
    const take = (row) => {
      if (rowLimit === 0 || chosen.length >= rowLimit || chosenIds.has(row.id)) return false;
      chosen.push(row);
      chosenIds.add(row.id);
      return true;
    };
    for (const row of hitPool.slice(0, hitQuota)) take(row);
    // Only the hits that actually won a slot are expansion sources. A linked row is added to
    // `chosen`, so using `chosen` here would let a link of a link be followed (chained diffusion).
    const directHits = [...chosen];
    // The bounded supplement is taken after every direct hit and before context expansion: a due
    // convention outranks an incidental neighbour, and it can never displace a direct hit.
    for (const row of upcomingPool) take(row);

    // Pass 2 — explicit links (stage 3): ONE hop from each direct hit, deduped against the block,
    // filtered by the same scope/role/time boundaries and by `hidden` / `superseded_by`, paid out
    // of the CONTEXT quota (never a hit slot). Rows are marked `kind: 'link'`.
    const linkRows = [];
    if (links !== false && directHits.length > 0) {
      const seenLinks = new Set();
      for (const hit of directHits) {
        for (const row of this.linkedRecords(hit.id, {
          domains,
          roles: intent.roles,
          fromIso: usedFrom,
          toIso: usedTo,
          limit: Math.max(4, contextQuota * 3),
        })) {
          if (chosenIds.has(row.id) || seenLinks.has(row.id) || !roleOk(row)) continue;
          seenLinks.add(row.id);
          linkRows.push({ ...row, kind: 'link', group: hit.id });
        }
      }
    }

    // Pass 3 — same-turn pairing for the hits that won a slot. Pass 4 — the ±window turns,
    // added only for the hits' own turns (the pair pass already covered those). Both are found
    // by conversation order, never `turnId ± 1`, and a row is never reused as its own context —
    // which is also why one neighbour can only be delivered (and reinforced) once.
    const contextIds = new Set();
    const pairs = [];
    const neighbors = [];
    // Same boundaries as the link pass: the pair/neighbour fallback never widens scope or window.
    const turnScope = { domains, fromIso: usedFrom, toIso: usedTo };
    for (const hit of directHits) {
      if (turnKeyOf(hit) === null) continue;
      for (const row of this.turnMessages(hit.sessionId, [Number(hit.turnId)], turnScope)) {
        if (chosenIds.has(row.id) || !roleOk(row)) continue;
        contextIds.add(row.id);
        pairs.push({ ...row, kind: 'pair', group: hit.id });
      }
    }
    for (const hit of directHits) {
      if (turnKeyOf(hit) === null) continue;
      const turns = this.neighborTurns(hit.sessionId, hit.turnId, window)
        .filter((turn) => turn !== Number(hit.turnId));
      if (turns.length === 0) continue;
      for (const row of this.turnMessages(hit.sessionId, turns, turnScope)) {
        if (chosenIds.has(row.id) || contextIds.has(row.id) || !roleOk(row)) continue;
        contextIds.add(row.id);
        neighbors.push({ ...row, kind: 'neighbor', group: hit.id });
      }
    }

    // Links come first inside the context quota: an explicit edge is stronger evidence than an
    // incidental neighbour, and a turn pair that already has a `turn` link is deduped to one row.
    const contextRows = [...linkRows, ...pairs, ...neighbors];
    let contextTaken = 0;
    for (const row of contextRows) {
      if (contextTaken >= contextQuota) break;
      if (take(row)) contextTaken += 1;
    }
    // Soft quotas borrow. Empty slots go to the next-ranked direct hit first (a key hit beats an
    // incidental neighbour), then to context rows; nothing is added just to reach six rows.
    for (const row of hitPool.slice(hitQuota, rowLimit)) take(row);
    for (const row of contextRows) take(row);

    const contextChosen = chosen.filter((row) => row.kind !== 'hit').length;
    const lostReason = (row) => {
      if (duplicateIds.has(row.id)) return 'duplicate';
      // A direct hit that lost while context held a slot lost on ranking (the soft 4+2 split),
      // not on the hard six-row cap: that is exactly the case this rewrite is about.
      if (row.kind === 'hit') return contextChosen > 0 ? 'rank' : 'record-budget';
      return chosen.length >= rowLimit ? 'record-budget' : 'rank';
    };
    for (const row of hitPool) if (!chosenIds.has(row.id)) drop(row, lostReason(row));
    for (const row of contextRows) if (!chosenIds.has(row.id)) drop(row, lostReason(row));
    for (const row of upcomingPool) if (!chosenIds.has(row.id)) drop(row, 'record-budget');
    for (const row of scored) if (duplicateIds.has(row.id) && !chosenIds.has(row.id)) drop(row, 'duplicate');

    // Display budget only: the stored body stays complete. Direct hits spend their share first,
    // the context rows use the reserved rest, then a hit that lost only on the soft split borrows
    // back whatever context did not need. Every row is priced before it is placed — label plus the
    // body the snippet would really deliver — and a row that cannot pay is skipped (`char-budget`)
    // instead of pushing `used` past `charLimit`. A row too long for its window gets one
    // compressed retry inside the room that is left (evidence words, negation, dates kept whole);
    // only a phrase that still does not fit delivers no body (`skippedByBudget`), never fake
    // evidence. The numbers below are what makes `assembly.chars <= charLimit` hold by design.
    const hitShare = contextual ? MEMORY_ASSEMBLY.contextualHitShare : MEMORY_ASSEMBLY.hitShare;
    const selectedHits = chosen.filter((row) => row.kind === 'hit');
    const selectedUpcoming = chosen.filter((row) => row.kind === 'upcoming');
    const selectedLinks = chosen.filter((row) => row.kind === 'link');
    const selectedPairs = chosen.filter((row) => row.kind === 'pair');
    const selectedNeighbors = chosen.filter((row) => row.kind === 'neighbor');
    // The supplement never costs the hits their reserved share: only real context rows do.
    const reserve = chosen.length > selectedHits.length + selectedUpcoming.length
      ? Math.floor(charLimit * (1 - hitShare))
      : 0;
    const label = MEMORY_ASSEMBLY.labelChars;
    // A delivered body is not a confirmed fact when its own record is unresolved or when the
    // `referent` edge it was expanded from has been retired. One indexed query per recall, and
    // the same rule applies to every path (hit, link, pair, neighbour): the marker travels in
    // `text`, so C2 injection and every other renderer show it without a second code path.
    const staleReferentIds = this.staleReferentSources(chosen.map((row) => row.id));
    const unresolvedOf = (row) => staleReferentIds.has(row.id) || Number(row.unresolved) === 1;
    const delivered = new Map();
    const snippetOf = (row, maxChars) => displayMessageSnippet(row.text, { query: text, terms, maxChars });
    let used = 0;
    let truncatedRows = 0;
    const place = (row, capEnd) => {
      if (delivered.has(row.id)) return true;
      const limit = Math.min(capEnd, charLimit);
      const room = limit - used - label;
      if (room <= 0) return false;
      const unresolved = unresolvedOf(row);
      const staleLink = staleReferentIds.has(row.id);
      const mark = unresolved ? `${UNRESOLVED_MARK} ` : '';
      const body = String(row.text ?? '');
      const bodyRoom = room - mark.length;
      if (bodyRoom <= 0) return false;
      let shown = snippetOf(row, Math.min(perRow, bodyRoom));
      // Second chance: the whole segment or its evidence phrase outgrew the per-row window, so
      // compress once into exactly what is left instead of dropping it. Still too long → refuse.
      if (shown.text.length > bodyRoom) shown = snippetOf(row, bodyRoom);
      if (shown.text.length > bodyRoom) return false;
      used += shown.text.length + mark.length + label;
      if (shown.text.length < body.length) truncatedRows += 1;
      delivered.set(row.id, {
        ...row,
        // D2 data layer: this row survived the final budget trim and its body is in the output.
        // `delivered` and `skippedByBudget` come from this one place, so they cannot disagree.
        delivered: true,
        unresolved: unresolved ? 1 : 0,
        staleLink,
        text: `${mark}${shown.text}`,
        displayStart: shown.displayStart,
        displayEnd: shown.displayEnd,
        displayTruncated: shown.displayTruncated,
        containsEvidence: shown.containsEvidence,
        budgetOverflow: shown.budgetOverflow === true || shown.text.length > perRow,
        skippedByBudget: false,
        truncated: shown.displayTruncated ? 1 : row.truncated,
      });
      return true;
    };
    if (charLimit > 0) {
      for (const row of selectedHits) place(row, charLimit - reserve);
      // The supplement is bounded twice: at most two rows were taken, and their bodies together
      // may spend at most UPCOMING_INJECT.maxChars of whatever the hits left over.
      const upcomingEnd = Math.min(charLimit, used + UPCOMING_INJECT.maxChars);
      for (const row of selectedUpcoming) place(row, upcomingEnd);
      for (const row of selectedLinks) if (delivered.has(row.group)) place(row, charLimit);
      for (const row of selectedPairs) if (delivered.has(row.group)) place(row, charLimit);
      for (const row of selectedNeighbors) if (delivered.has(row.group)) place(row, charLimit);
      // Borrow back: a hit skipped under the soft split still fits when context stayed small.
      for (const row of selectedHits) place(row, charLimit);
      for (const row of selectedLinks) if (delivered.has(row.group)) place(row, charLimit);
      for (const row of selectedPairs) if (delivered.has(row.group)) place(row, charLimit);
      for (const row of selectedNeighbors) if (delivered.has(row.group)) place(row, charLimit);
    }

    const rows = [];
    const placeholder = (row) => ({
      ...row,
      // A candidate the character budget refused: in the list for its metadata only, never a body.
      delivered: false,
      unresolved: unresolvedOf(row) ? 1 : 0,
      staleLink: staleReferentIds.has(row.id),
      text: '',
      displayStart: 0,
      displayEnd: 0,
      displayTruncated: true,
      containsEvidence: false,
      budgetOverflow: false,
      skippedByBudget: true,
      truncated: 1,
    });
    const groups = new Map();
    for (const row of [...selectedLinks, ...selectedPairs, ...selectedNeighbors]) {
      const list = groups.get(row.group) ?? [];
      list.push(row);
      groups.set(row.group, list);
    }
    for (const hit of selectedHits) {
      const hitDelivered = delivered.has(hit.id);
      if (hitDelivered) rows.push(delivered.get(hit.id));
      else if (charLimit > 0) rows.push(placeholder(hit));
      if (!hitDelivered) drop(hit, 'char-budget');
      for (const row of groups.get(hit.id) ?? []) {
        if (hitDelivered && delivered.has(row.id)) rows.push(delivered.get(row.id));
        else drop(row, 'char-budget');
      }
    }

    // The supplement is delivered after the hits (and their context), so the block always reads
    // "direct hits first, then the bounded upcoming entry". A row the budget refused is dropped.
    for (const row of selectedUpcoming) {
      if (delivered.has(row.id)) rows.push(delivered.get(row.id));
      else drop(row, 'char-budget');
    }
    const counts = { hit: 0, pair: 0, neighbor: 0, link: 0, upcoming: 0 };
    for (const row of rows) {
      if (row.skippedByBudget === true) continue;
      if (row.kind === 'hit' || row.kind === 'pair' || row.kind === 'neighbor' || row.kind === 'link'
        || row.kind === 'upcoming') {
        counts[row.kind] += 1;
      }
    }
    if (counts.upcoming > 0) this.emitEvent('memory.upcoming.injected', { count: counts.upcoming });
    // One event per expanded source edge that actually survived the budget: counters and the
    // link kind only, never the linked body.
    const expandedLinks = new Map();
    for (const row of rows) {
      if (row.kind !== 'link') continue;
      const key = `${row.group}\u0000${row.linkKind ?? 'link'}`;
      const entry = expandedLinks.get(key) ?? { from: row.group, kind: row.linkKind ?? 'link', added: 0 };
      entry.added += 1;
      expandedLinks.set(key, entry);
    }
    for (const entry of expandedLinks.values()) this.emitEvent('memory.link.expanded', entry);
    // Hard bound, not a hope: `place` never spends past `charLimit`, and the clamp keeps a future
    // regression from reporting a block wider than the budget it claims to respect.
    const chars = Math.min(used, charLimit);
    const skippedByChars = dropped.filter((entry) => entry.reason === 'char-budget').length;
    // D2 data layer: one delivery count, read from the same rows `place()` produced. A row is
    // delivered exactly when it came out of the `delivered` map, so this can never disagree with
    // `skippedByBudget` — and it is the same trimmed list C2 (`skippedByBudget !== true`) injects.
    const deliveredCount = rows.filter((row) => row.delivered === true).length;
    // P-52 statistics split (observability only, no selection change): what retrieval FOUND vs
    // what was actually INJECTED into the block. `candidates` here is retrieval-level (found but
    // no body in the output) and is separate from the extraction ledger in `memory_candidate`.
    const memoryHits = scored.length + upcomingPool.length + linkRows.length + pairs.length
      + neighbors.length;
    // One observability event per recall: which group produced what, how much text was spent
    // (labels included) and how many candidates were dropped, so a regression is visible without
    // re-running the query.
    this.emitEvent('memory.assembly', {
      hits: counts.hit,
      links: counts.link,
      pairs: counts.pair,
      neighbors: counts.neighbor,
      upcoming: counts.upcoming,
      dropped: dropped.length,
      chars,
      mode,
      rowLimit,
      charLimit,
      truncatedRows,
      skippedByChars,
      // P-52: found vs injected, plus the retrieval-level candidate gap. Observability only.
      memoryHits,
      memoryInjected: deliveredCount,
      candidates: Math.max(0, memoryHits - deliveredCount),
    });
    return {
      hits: rows,
      scanned,
      terms,
      mode,
      roles: intent.roles ?? ['user', 'assistant'],
      window,
      range: intent.range?.label ?? '',
      from: usedFrom,
      to: usedTo,
      relaxed,
      displayChars: perRow,
      expanded: selectedLinks.length + selectedPairs.length + selectedNeighbors.length > 0,
      adjacent: selectedLinks.length + selectedPairs.length + selectedNeighbors.length > 0,
      upcoming: { matched: upcomingMatched, windowDays: UPCOMING_SPAN_DAYS, levels: upcomingLevels },
      assembly: {
        hits: counts.hit,
        links: counts.link,
        pairs: counts.pair,
        neighbors: counts.neighbor,
        upcoming: counts.upcoming,
        // D2 data layer (purely additive): how many rows were really handed over, how many the
        // character budget cut, the width spent, and the character cap it was measured against
        // (`chars <= limit` holds by construction; `rowLimit` beside it is the 6-row half).
        delivered: deliveredCount,
        skippedByBudget: skippedByChars,
        // P-52 retrieval/injection split: found >= injected, and the gap is the candidate count.
        memoryHits,
        memoryInjected: deliveredCount,
        candidates: Math.max(0, memoryHits - deliveredCount),
        limit: charLimit,
        chars,
        dropped,
        rowLimit,
        charLimit,
        contextual,
      },
    };
  }

  // ---- P-52 candidate ledger ----------------------------------------------------------------

  /**
   * Stage one extraction candidate. It is stored in `memory_candidate` only, never in
   * `memory_event`, so recall/search/brief/get cannot return it and no delivered/injected count
   * can include it. Staging the same id twice is a no-op (no second event).
   *
   * @param {{id?: string, text?: string, source?: string, reason?: string, ts?: string}} [input]
   * @returns {{id: string, state: string|null, created: boolean}}
   */
  stageCandidate({ id = '', text = '', source = 'auto', reason = 'extracted', ts = nowIso() } = {}) {
    this.open();
    const key = typeof id === 'string' && id.trim().length > 0 ? id.trim() : randomUUID();
    const body = typeof text === 'string' ? text : '';
    const origin = typeof source === 'string' ? source : '';
    const why = typeof reason === 'string' ? reason : '';
    const stamp = typeof ts === 'string' && ts.length > 0 ? ts : nowIso();
    const inserted = this.db
      .prepare(`INSERT OR IGNORE INTO memory_candidate (id, ts, source, reason, text, state)
        VALUES (?, ?, ?, ?, ?, 'candidate')`)
      .run(key, stamp, origin, why, body);
    if (Number(inserted.changes) === 0) {
      return { id: key, state: this.candidateState(key), created: false };
    }
    this.emitEvent('memory.candidate', { id: key, source: origin, reason: why });
    return { id: key, state: 'candidate', created: true };
  }

  /**
   * Mark candidates as delivered into one turn's context. Only `candidate` rows transition, so a
   * second call — same turn or a later one — is a no-op and emits no event: one memory is
   * delivered at most once, and that is what makes "same memory, one turn, one delivery" hold.
   * `count` in the event is that memory's delivery count for the turn (always 1).
   *
   * @param {string[]} ids
   * @param {{turn?: number|string|null}} [options]
   * @returns {{delivered: string[], count: number}}
   */
  deliverCandidates(ids, { turn = null } = {}) {
    this.open();
    const wanted = Array.isArray(ids) ? ids : [];
    const read = this.db.prepare('SELECT state FROM memory_candidate WHERE id = ?');
    const write = this.db.prepare(`UPDATE memory_candidate
      SET state = 'delivered', delivered_turn = ?, delivered_at = ?, delivery_count = 1
      WHERE id = ? AND state = 'candidate'`);
    const delivered = [];
    const seen = new Set();
    const stamp = nowIso();
    const turnKey = turn === null || turn === undefined ? null : String(turn);
    for (const id of wanted) {
      if (typeof id !== 'string' || id.length === 0 || seen.has(id)) continue;
      seen.add(id);
      const row = read.get(id);
      if (row === undefined || row.state !== 'candidate') continue;
      if (Number(write.run(turnKey, stamp, id).changes) > 0) delivered.push(id);
    }
    for (const id of delivered) this.emitEvent('memory.delivered', { id, turn, count: 1 });
    return { delivered, count: delivered.length };
  }

  /**
   * Write a delivered candidate into long-term memory (`memory_event`) and mark it `persisted`.
   * A candidate that was never delivered is refused — it may be a bad extraction, and long-term
   * memory must not be the place that discovers it. Idempotent on an already-persisted id.
   *
   * @param {string} id
   * @param {{domain?: string, kind?: string, importance?: number}} [options]
   * @returns {{persisted: boolean, deduped?: boolean, memoryId?: string|null, reason?: string,
   *            state?: string|null}}
   */
  persistCandidate(id, { domain = 'chat', kind = 'fact', importance } = {}) {
    this.open();
    const key = typeof id === 'string' ? id : '';
    const row = this.db
      .prepare('SELECT state, text, source, memory_id FROM memory_candidate WHERE id = ?')
      .get(key);
    if (row === undefined) return { persisted: false, reason: 'missing' };
    if (row.state === 'persisted') {
      return { persisted: true, deduped: true, memoryId: row.memory_id ?? null };
    }
    if (row.state !== 'delivered') {
      return { persisted: false, reason: 'not-delivered', state: row.state };
    }
    const text = String(row.text ?? '').trim();
    if (text.length === 0) return { persisted: false, reason: 'empty-text', state: row.state };
    const record = this.transact(() => {
      const written = this.add(domain, text, kind, {
        source: row.source.length > 0 ? row.source : 'auto',
        ...(Number.isFinite(Number(importance)) ? { importance: Number(importance) } : {}),
      });
      this.db
        .prepare(`UPDATE memory_candidate SET state = 'persisted', persisted_at = ?, memory_id = ?
          WHERE id = ?`)
        .run(nowIso(), written.id, key);
      return written;
    });
    this.emitEvent('memory.persisted', { id: key });
    return { persisted: true, deduped: false, memoryId: record.id };
  }

  /** Current ledger state (`candidate` / `delivered` / `persisted`), or `null` when unknown. */
  candidateState(id) {
    this.open();
    const key = typeof id === 'string' ? id : '';
    const row = this.db.prepare('SELECT state FROM memory_candidate WHERE id = ?').get(key);
    return row === undefined ? null : row.state;
  }

  /**
   * Three-state tally for the ledger. `delivered` is deliberately its own bucket: a candidate
   * never counts as delivered until `deliverCandidates` moved it.
   */
  deliveryStats() {
    this.open();
    const counts = Object.fromEntries(CANDIDATE_STATES.map((state) => [state, 0]));
    for (const row of this.db.prepare('SELECT state, COUNT(*) AS c FROM memory_candidate GROUP BY state').all()) {
      if (Object.hasOwn(counts, row.state)) counts[row.state] = Number(row.c) || 0;
    }
    return { ...counts, total: counts.candidate + counts.delivered + counts.persisted };
  }

  /**
   * Expire undelivered candidates older than `maxAgeMs` (default 24 h, `CANDIDATE_TTL_MS`).
   * Only `state = 'candidate'` rows are eligible: a delivered or persisted memory is never
   * removed by this path, whatever its age. `ts` is compared as the ISO-8601 text it is stored
   * as, so the rule is a plain, auditable timestamp cutoff.
   *
   * @param {{now?: Date|number|string, maxAgeMs?: number}} [options]
   * @returns {{removed: number, ids: string[]}}
   */
  pruneCandidates({ now = new Date(), maxAgeMs = CANDIDATE_TTL_MS } = {}) {
    this.open();
    const age = Number.isFinite(Number(maxAgeMs)) && Number(maxAgeMs) > 0
      ? Math.floor(Number(maxAgeMs))
      : CANDIDATE_TTL_MS;
    const at = now instanceof Date ? now : new Date(now);
    const base = Number.isFinite(at.getTime()) ? at.getTime() : Date.now();
    const cutoff = new Date(base - age).toISOString();
    const stale = this.db
      .prepare(`SELECT id FROM memory_candidate WHERE state = 'candidate' AND ts <= ?`)
      .all(cutoff);
    const remove = this.db.prepare(`DELETE FROM memory_candidate WHERE id = ? AND state = 'candidate'`);
    const ids = [];
    for (const row of stale) {
      if (Number(remove.run(row.id).changes) > 0) ids.push(row.id);
    }
    if (ids.length > 0) this.emitEvent('memory.candidate.expired', { ids, count: ids.length, maxAgeMs: age });
    return { removed: ids.length, ids };
  }

  /**
   * Retired resident layer (2026-11-06): importance no longer grants every-turn residency.
   *
   * Selecting `importance >= 85` records for injection every turn contradicted the rule that only
   * the user's explicit intent ("记住…，以后一直这样") makes a fact resident. Standing context is
   * now the fixed-memory resource table only; the host renders it as the prompt's fixed section.
   * Importance keeps its two other jobs — decay and recall ranking — and nothing else.
   *
   * The method is kept (returning nothing) because injection, the daily digest and the status
   * snapshot still ask for it: an empty answer is the honest one, and no caller has to change.
   *
   * @returns {object[]} always empty
   */
  fixedMemories() {
    this.open();
    return [];
  }

  /**
   * High-importance records for an EXPLICIT on-demand read (`brief()` / `assistant_memory_brief`).
   *
   * Deliberately NOT the resident layer: these rows are never injected every turn, they are only
   * offered when the model asks for a memory block. Budget-trimmed like the old fixed layer so one
   * oversized landmark cannot flood the answer.
   */
  landmarkMemories({ budgetChars = 600, limit = 12 } = {}) {
    this.open();
    const rows = this.db
      .prepare(`SELECT id, ts, domain, text, importance, version FROM memory_event
        WHERE importance >= 85 AND superseded_by IS NULL
        ORDER BY importance DESC, ts DESC LIMIT ?`)
      .all(limit);
    return trimToBudget(rows, budgetChars);
  }

  /**
   * Records worth carrying into a fresh session: created inside `[fromIso, toIso)` and either
   * important or recent enough to matter. Used by the daily session rollover.
   */
  recentImportant({ fromIso, toIso, minImportance = 50, limit = 20 } = {}) {
    this.open();
    return this.db
      .prepare(`SELECT id, ts, domain, text, importance FROM memory_event
        WHERE ts >= ? AND ts < ? AND importance >= ? AND superseded_by IS NULL
        ORDER BY importance DESC, ts ASC LIMIT ?`)
      .all(fromIso, toIso ?? nowIso(), minImportance, limit);
  }

  /**
   * Compose an ON-DEMAND memory block: high-importance landmark records plus records recalled for
   * the current input. This is the `assistant_memory_brief` tool, never the every-turn injection —
   * importance no longer makes a record resident (see `fixedMemories`). Original utterances/replies
   * keep their own label; distilled records are marked `提炼`, so the model never confuses "what
   * was said" with "what we concluded".
   * @param {{query?: string, fixedBudget?: number, matchBudget?: number, limit?: number,
   *          displayChars?: number}} options
   */
  brief({
    query = '',
    fixedBudget = 600,
    matchBudget = 800,
    limit = 5,
    displayChars = AUTO_MEMORY_DEFAULTS.maxChars,
  } = {}) {
    const fixed = this.landmarkMemories({ budgetChars: fixedBudget });
    const fixedIds = new Set(fixed.map((row) => row.id));
    const matched = [];
    let mode = 'keyword';
    let roles = ['user', 'assistant'];
    let window = 0;
    let from = null;
    let to = null;
    let range = '';
    let relaxed = false;
    if (typeof query === 'string' && query.trim().length > 0) {
      const recalled = this.recall({
        query,
        limit: limit + fixed.length,
        budgetChars: Math.min(matchBudget, 600),
        maxRecords: Math.max(1, limit),
        window: 1,
        displayChars,
      });
      mode = recalled.mode;
      roles = recalled.roles;
      window = recalled.window;
      from = recalled.from;
      to = recalled.to;
      range = recalled.range;
      relaxed = recalled.relaxed;
      // recall() already spent the budget once; re-clipping here would cut delivered evidence
      // while leaving its metadata behind. Only drop placeholder rows and honour the row limit.
      const candidates = recalled.hits.filter(
        (hit) => !fixedIds.has(hit.id) && hit.skippedByBudget !== true,
      );
      matched.push(...candidates.slice(0, limit));
    }
    const lines = [];
    if (fixed.length > 0) {
      lines.push('## 重要记忆（按重要性，仅本次查询参考）');
      for (const row of fixed) lines.push(formatRecalledLine(row));
    }
    if (matched.length > 0) {
      lines.push('## 相关记忆（与本次话题相关，按匹配度排序）');
      for (const row of matched) lines.push(formatRecalledLine(row));
    }
    return {
      text: lines.join('\n'),
      fixed,
      matched,
      terms: tokenizeQuery(query),
      mode,
      roles,
      window,
      range,
      from,
      to,
      relaxed,
    };
  }

  /** Aggregates for the settings page and for the decay job. */
  stats() {
    this.open();
    const rows = this.db.prepare('SELECT domain, COUNT(*) AS c FROM memory_event GROUP BY domain').all();
    return rows;
  }

  close() {
    if (this.db === null) return;
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
    this.db = null;
  }
}
