/**
 * ProfileStore step 3: incremental background maintenance.
 *
 * The seven-day round is deliberately NOT a chat turn: a timer wakes up, checks `isBusy`, and
 * only then reads what happened since the last round. A missed round is caught up once on the
 * next idle wake-up (the due check is a boolean, never a loop over missed weeks), busy is
 * deferred, and a manual `profile.maintain.now` runs the same flow without waiting for the
 * schedule.
 *
 * Flow (one transaction for every write):
 *   save path — write the two text boxes only and mark the changed sides pending; no model call,
 *   no library row, no rewrite. The saved text is injected immediately (a trial area);
 *   organize path (manual「立刻整理」) — ONE agent call reads BOTH boxes and splits them into
 *   categorized fragments, and the model itself decides each fragment's side by semantics (not by
 *   the box it was typed in): a persona-behaviour preference is agent material, while the user's
 *   own facts/habits/experiences and self-clarifications are user material (a self-description is
 *   never rewritten into an assistant rule). A fragment routed to the other side is MOVED —
 *   dropped from the source box and written into the target box — so a sentence is never kept on
 *   both sides. The model may also reuse/rename/add/drop categories of the `profile_category`
 *   stack, under host validation. The organize path also reads the new exchange, diffs both
 *   against the saved `(entryId, text)` mapping, applies every library change in ONE transaction,
 *   compiles, then has the agent rewrite the CHANGED sides into 1–3 natural paragraphs of complete
 *   sentences and writes them back (auto-saved); an unchanged box keeps its original text. The
 *   boxes must read as prose, never as a per-item list: list markers are rejected, the final text is
 *   plain-ified, and a failed/rejected rewrite falls back to the SOURCE SENTENCES (never to a bullet
 *   list) and still writes back; the sides are then no longer pending. Keyword coverage is only an
 *   omission HINT; any real wording change (beyond whitespace/punctuation) is deterministically
 *   checked for reverse attitudes/conditions and then ALWAYS sent to the lightweight semantic
 *   cross-check. A rejected, thrown or unavailable check writes the source sentences instead.
 *   A side the one-time seed imported stays
 *   marked `seededButUnorganized` until such a writeback succeeds, so a failed first split is
 *   retried instead of being skipped as synced;
 *   round path — the 7-day schedule only reads messages page by page with a stable `(ts, id)`
 *   cursor (200 per page, ≤ the round limit); a pending box is never auto-imported.
 *   → model extracts candidates (message ids, no numbers)
 *   → host validates evidence (the id must exist in the increment AND belong to a user message)
 *   → merge same-tendency candidates → apply support/contradiction evidence
 *   → fix the selected set (score/threshold/budget), decay only the unselected & unmentioned
 *   → profileRank rank persistence/forgetting → compileRank prompt → write the snapshot
 *   → the agent rewrites the selected fragments into natural prose paragraphs and writes them back
 *     into the boxes (auto-saved, never re-split), so the boxes are the authoritative injected
 *     prompt. A box and the library are not one transaction: a failed box write or commit is
 *     reported (`profile.writeback.failed`) and the side is marked pending again, never silent.
 *
 * A locked entry is exempt from every automatic step: no score change, no adoption change.
 *
 * Bookkeeping tables are owned here (`profile_snapshot`, `profile_maintain_state`,
 * `profile_category`); the four `profile_*` tables stay in profileStore.js. A version check runs
 * inside the transaction just before the first write: a user edit that landed while the model was
 * thinking aborts the round and leaves the previously compiled snapshot untouched.
 */
import { createHash, randomUUID } from 'node:crypto';

import {
  PROFILE_RANK_DEFAULTS,
  PROFILE_SECTIONS,
  estimateProfileTokens,
  profilePromptOverheadTokens,
  resolveProfileRankConfig,
} from './profileRank.js';

import {
  PROFILE_MAINTAIN_INTERVAL_MS,
  PROFILE_MAINTAIN_RETRY_MS,
  PROFILE_MAINTAIN_TICK_MS,
  PROFILE_MAINTAIN_MESSAGE_LIMIT,
  PROFILE_MAINTAIN_PAGE_SIZE,
  PROFILE_MAINTAIN_EVENTS,
  PROFILE_PROMPT_BUDGET_TOKENS,
  PROFILE_PROMPT_EVENTS,
  PROFILE_IMPORT_EVENTS,
  PROFILE_RECONCILE_EVENTS,
  PROFILE_RECONCILE_SIMILARITY,
  PROFILE_RECONCILE_DEFAULT_CLARITY,
  PROFILE_RECONCILE_DEFAULT_EFFICACY,
  PROFILE_SAVE_EVENT,
  PROFILE_SPLIT_EVENTS,
  PROFILE_WRITEBACK_EVENT,
  PROFILE_WRITEBACK_SKIPPED_EVENT,
  PROFILE_WRITEBACK_MAPPING_SKIPPED_EVENT,
  PROFILE_WRITEBACK_FAILED_EVENT,
  PROFILE_COMPOSE_EVENTS,
  PROFILE_EXTRACT_EVENT,
  PROFILE_EXTRACT_MISMATCH_EVENT,
  PROFILE_EVIDENCE_DELETED_EVENT,
  PROFILE_MODEL_EVENTS,
  PROFILE_TONE_EVENTS,
  SPLIT_SYSTEM,
  RECLASSIFY_SYSTEM,
  TONE_REPAIR_SYSTEM,
  ASSIST_PHASES,
  PROFILE_CATEGORY_PRESETS,
  PROFILE_CATEGORY_MAX_NAME,
  PROFILE_CATEGORY_MAX_DESCRIPTION,
  PROFILE_CATEGORY_EVENTS,
  PROFILE_ENTRY_EVENTS,
  PROFILE_ENTRY_EDIT_SOURCE,
  PROFILE_ENTRY_DELETE_SOURCE,
  PROFILE_CATEGORY_USER_SOURCE,
  PROFILE_RECLASSIFY_EVENTS,
  PROFILE_RECLASSIFY_SOURCE,
  PROFILE_CLEANUP_SOURCE,
  PROFILE_CLEANUP_EVENT,
  categoryKey,
  COMPOSE_SYSTEM,
  SIDES,
  ZERO_SUMMARY,
  EXTRACT_SYSTEM,
  SCHEMA,
  cleanText,
  normalizedText,
  positiveInt,
  MODEL_REASONING_FRAME,
  promptKey,
} from './maintain-config.js';
export {
  PROFILE_MAINTAIN_INTERVAL_DAYS,
  PROFILE_MAINTAIN_INTERVAL_MS,
  PROFILE_MAINTAIN_RETRY_MS,
  PROFILE_MAINTAIN_TICK_MS,
  PROFILE_MAINTAIN_TURN_STALE_MS,
  PROFILE_MAINTAIN_MESSAGE_LIMIT,
  PROFILE_MAINTAIN_PAGE_SIZE,
  PROFILE_MAINTAIN_EVENTS,
  PROFILE_PROMPT_TITLE,
  PROFILE_PROMPT_BUDGET_TOKENS,
  PROFILE_PROMPT_EVENTS,
  PROFILE_IMPORT_EVENTS,
  PROFILE_RECONCILE_EVENTS,
  PROFILE_RECONCILE_SIMILARITY,
  PROFILE_RECONCILE_DEFAULT_CLARITY,
  PROFILE_RECONCILE_DEFAULT_EFFICACY,
  PROFILE_SAVE_EVENT,
  PROFILE_SPLIT_EVENTS,
  PROFILE_WRITEBACK_EVENT,
  PROFILE_WRITEBACK_SKIPPED_EVENT,
  PROFILE_WRITEBACK_MAPPING_SKIPPED_EVENT,
  PROFILE_WRITEBACK_FAILED_EVENT,
  PROFILE_COMPOSE_EVENTS,
  PROFILE_EXTRACT_EVENT,
  PROFILE_EXTRACT_MISMATCH_EVENT,
  PROFILE_EVIDENCE_DELETED_EVENT,
  PROFILE_MODEL_EVENTS,
  PROFILE_TONE_EVENTS,
  PROFILE_CATEGORY_PRESETS,
  PROFILE_CATEGORY_MAX_NAME,
  PROFILE_CATEGORY_MAX_DESCRIPTION,
  PROFILE_CATEGORY_EVENTS,
  PROFILE_ENTRY_EVENTS,
  PROFILE_ENTRY_EDIT_SOURCE,
  PROFILE_ENTRY_DELETE_SOURCE,
  PROFILE_CATEGORY_USER_SOURCE,
  PROFILE_RECLASSIFY_EVENTS,
  PROFILE_RECLASSIFY_SOURCE,
  PROFILE_CLEANUP_SOURCE,
  PROFILE_CLEANUP_EVENT,
  categoryKey,
} from './maintain-config.js';
import {
  PROFILE_MAINTAIN_DEFAULT_MAX_TOKENS,
  modelTruncatedFinish,
  modelFinishCompleted,
  modelRetryMaxTokens,
  modelChunkFinish,
  modelChunkText,
  modelDetails,
  modelEmptyError,
  modelIncompleteError,
  strictModelSystem,
} from './model-response.js';
export { PROFILE_MAINTAIN_DEFAULT_MAX_TOKENS } from './model-response.js';
import { normalizeBusySnapshot, busyReasonOf } from './maintain-busy.js';
export { createProfileMaintainBusyTracker } from './maintain-busy.js';
import {
  parseReconcileLines,
  promptSimilarity,
  reconcilePromptLines,
  stripFramingWords,
  parseSplitPayload,
  parseSplitEntries,
  normalizeSplitEntries,
  buildSplitPrompt,
  buildReclassifyPrompt,
  parseReclassifyPayload,
} from './prompt-splitting.js';
export {
  parsePromptLine,
  parseReconcileLines,
  promptSimilarity,
  reconcilePromptLines,
  stripFramingWords,
  parseSplitPayload,
  parseSplitEntries,
  normalizeSplitEntries,
  buildSplitPrompt,
  buildReclassifyPrompt,
  parseReclassifyPayload,
} from './prompt-splitting.js';
import {
  normalizeReclassifyText,
  restoreUserStatement,
  noiseReason,
  classifyProfileEntrySide,
} from './classification.js';
export {
  normalizeReclassifyText,
  PROFILE_PERSONA_CATEGORY,
  isUserSelfDescription,
  isExplicitLongTermRequest,
  isOneOffInstruction,
  isMisplacedAgentRule,
  restoreUserStatement,
  noiseReason,
  isPersonaReferencePreference,
  classifyProfileEntrySide,
} from './classification.js';
import {
  PROFILE_COMPOSE_MERGE_THROTTLE_MS,
  PROFILE_COMPOSE_MERGE_LOG_LIMIT,
  composeKey,
  composeReworded,
  composeFactVerdict,
  dedupeComposeEntries,
  validateComposeText,
  composeFallbackText,
  ensurePlainProse,
  buildComposePrompt,
  COMPOSE_VERIFY_SYSTEM,
  buildComposeVerifyPrompt,
  parseComposeVerify,
  parseComposeText,
} from './compose.js';
export {
  PROFILE_COMPOSE_LENGTH_RATIO,
  PROFILE_COMPOSE_SHORT_ENTRY_SLACK,
  PROFILE_COMPOSE_DUPLICATE_SIMILARITY,
  PROFILE_COMPOSE_MERGE_THROTTLE_MS,
  PROFILE_COMPOSE_MERGE_LOG_LIMIT,
  PROFILE_COMPOSE_MAX_PARAGRAPHS,
  PROFILE_COMPOSE_TOTAL_RATIO,
  PROFILE_COMPOSE_COVERAGE_MIN_CHARS,
  PROFILE_COMPOSE_KEYWORD_MAX,
  PROFILE_COMPOSE_FILLER_RULES,
  composeSimilarity,
  composeKeywords,
  composeFidelityVerdict,
  composeAntonymVerdict,
  composeReworded,
  composeFactVerdict,
  composeSameFact,
  dedupeComposeEntries,
  validateComposeText,
  composeFallbackText,
  ensurePlainProse,
  buildComposePrompt,
  buildComposeVerifyPrompt,
  parseComposeVerify,
  parseComposeText,
} from './compose.js';
import {
  checkProfileTone,
  fallbackToneText,
  buildToneRepairPrompt,
  parseToneRepair,
  replaceToneSentences,
} from './tone.js';
export {
  PROFILE_TONE_FIRST_PERSON,
  PROFILE_TONE_USER_TOKEN,
  checkProfileTone,
  fallbackToneText,
  buildToneRepairPrompt,
  parseToneRepair,
} from './tone.js';
import {
  parseSnapshotLines,
  sameMapping,
  parseCursorValue,
  formatCursor,
  compareMessageKeys,
  atOrBeforeCursor,
  normalizeMessage,
  candidateMessageIds,
  candidateEntryId,
  candidateOperation,
  candidateSeverity,
  parseExtractCandidates,
  formatProfilePrompt,
  buildExtractPrompt,
} from './evidence.js';
export { parseExtractCandidates, formatProfilePrompt, buildExtractPrompt } from './evidence.js';
import {
  PERSONA_QUIZ_QUESTIONS,
  PERSONA_QUIZ_MIN_ANSWERED,
  PERSONA_QUIZ_HINT,
  PERSONA_QUIZ_ERRORS,
  PERSONA_QUIZ_EVENTS,
  PERSONA_QUIZ_PROMPT_BUDGET_TOKENS,
  PERSONA_QUIZ_SYSTEM,
  normalizePersonaQuizAnswers,
  buildPersonaQuizPrompt,
  parsePersonaQuizDraft,
  stripPersonaUserProfileBlocks,
  enforcePersonaQuizTone,
} from './persona-quiz.js';
export {
  PERSONA_QUIZ_QUESTIONS,
  PERSONA_QUIZ_MIN_ANSWERED,
  PERSONA_QUIZ_HINT,
  PERSONA_QUIZ_ERRORS,
  PERSONA_QUIZ_EVENTS,
  PERSONA_QUIZ_PROMPT_BUDGET_TOKENS,
  splitPersonaQuizAnswer,
  classifyPersonaQuizSegment,
  normalizePersonaQuizAnswers,
  buildPersonaQuizPrompt,
  parsePersonaQuizDraft,
  enforcePersonaQuizTone,
} from './persona-quiz.js';


/**
 * Read-only per-side pending flags before the organizer instance exists (after a restart):
 * an explicit `pending`/`seededButUnorganized` marker or box text that differs from `syncedText`.
 * Never instantiates.
 */
export function readPendingSides(db, texts = {}) {
  const read = (key) => {
    try {
      const row = db.prepare('SELECT value FROM profile_maintain_state WHERE key = ?').get(key);
      return row?.value;
    } catch {
      return undefined;
    }
  };
  const parse = (raw) => {
    try {
      const value = JSON.parse(String(raw ?? ''));
      return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch {
      return {};
    }
  };
  const flags = parse(read('pending'));
  const seeded = parse(read('seededButUnorganized'));
  const synced = parse(read('syncedText'));
  return {
    agent: flags.agent === true || seeded.agent === true
      || cleanText(texts.agent) !== (typeof synced.agent === 'string' ? synced.agent : ''),
    user: flags.user === true || seeded.user === true
      || cleanText(texts.user) !== (typeof synced.user === 'string' ? synced.user : ''),
  };
}

/**
 * Read-only: the persona text currently in effect for prompt injection — the compiled profile
 * snapshot when one exists, otherwise ''. Callers that still have the settings-box persona text
 * fall back to it. Used by the background avatar-style builder; never calls a model and never
 * runs on a chat path.
 */
export function readEffectivePersonaText(db) {
  try {
    const row = db.prepare('SELECT text FROM profile_snapshot WHERE id = ?').get('current');
    return String(row?.text ?? '').trim();
  } catch {
    return '';
  }
}

/**
 * Read-only trial marker from the metadata table. Used by `/assistant/status` before the
 * organizer instance exists (after a restart), so the "trial" badge survives a reload.
 */
export function readPersonaTrialState(db) {
  const inactive = { active: false, text: '', backup: '', at: null };
  try {
    const row = db.prepare("SELECT value FROM profile_maintain_state WHERE key = 'personaTrial'").get();
    if (row === undefined) return inactive;
    const parsed = JSON.parse(String(row.value));
    if (parsed === null || typeof parsed !== 'object' || parsed.active !== true) return inactive;
    return {
      active: true,
      text: String(parsed.text ?? ''),
      backup: String(parsed.backup ?? ''),
      boxesAuthoritative: parsed.boxesAuthoritative === true,
      syncedText: parsed.syncedText ?? null,
      legacyImportAt: typeof parsed.legacyImportAt === 'string' ? parsed.legacyImportAt : null,
      at: parsed.at ?? null,
    };
  } catch {
    return inactive;
  }
}

export class ProfileMaintainer {
  /**
   * @param {object} options
   * @param {import('./profileStore.js').ProfileStore} options.profile store that owns the entries
   * @param {import('node:sqlite').DatabaseSync} [options.db] defaults to `profile.db`
   * @param {(input: {since: string|null, until: string, limit: number}) => Array|Promise<Array>} [options.readMessages]
   * @param {(input: object) => Array|object|string|Promise} [options.extract] fully injectable extractor
   * @param {(input: object) => string|Promise<string>} [options.complete] injectable model completion
   * @param {(input: {side: string, sentences: string[], signal?: AbortSignal}) => string|Array|Promise}
   *   [options.repairTone] injectable tone-repair completion (only the offending sentences)
   * @param {() => object} [options.getLlm] Harness llm service (only needed for the default extractor)
   * @param {() => object} [options.getSelection] Harness default-model service
   * @param {(type: string, payload: object) => Promise|void} [options.emit] event sink
   * @param {() => (Date|number)} [options.now] clock
   * @param {() => boolean} [options.isBusy] true while a chat/voice turn is active
   * @param {() => boolean} [options.isVoiceBusy] legacy voice-only probe (a `busySnapshot` wins)
   * @param {() => object} [options.busySnapshot] structured busy state:
   *   `{activeChatTurns:[{sessionId,turnId,startedAt,workspace}], playback, pendingVoice, fastPath, voiceTurn}`
   * @param {object} [options.config] `{intervalDays, intervalMs, retryMs, tickMs, maxMessages, timeoutMs, maxTokens, queuePollMs, profileRank}`
   */
  constructor(options = {}) {
    const profile = options.profile;
    if (profile === null || typeof profile !== 'object'
      || typeof profile.transact !== 'function' || typeof profile.compileRank !== 'function') {
      throw new TypeError('createProfileMaintainer 需要 ProfileStore（profile）');
    }
    const db = options.db ?? profile.db;
    if (db === null || typeof db !== 'object' || typeof db.exec !== 'function') {
      throw new TypeError('createProfileMaintainer 需要已打开的 node:sqlite DatabaseSync（db）');
    }
    this.profile = profile;
    this.db = db;
    const config = options.config !== null && typeof options.config === 'object' ? options.config : {};
    const intervalMs = Number(config.intervalMs);
    const intervalDays = Number(config.intervalDays);
    this.intervalMs = positiveInt(intervalMs, positiveInt(intervalDays * 24 * 60 * 60 * 1000, PROFILE_MAINTAIN_INTERVAL_MS));
    this.retryMs = positiveInt(config.retryMs, PROFILE_MAINTAIN_RETRY_MS);
    this.tickMs = positiveInt(config.tickMs, PROFILE_MAINTAIN_TICK_MS);
    this.maxMessages = positiveInt(config.maxMessages, PROFILE_MAINTAIN_MESSAGE_LIMIT);
    this.timeoutMs = positiveInt(config.timeoutMs, 120_000);
    this.maxTokens = positiveInt(config.maxTokens, PROFILE_MAINTAIN_DEFAULT_MAX_TOKENS);
    // Scene of the last default completion, used only to enrich an empty/parse failure.
    this.lastCompletionStats = null;
    // Debug-level compose-merge log window (a long round must not flood the event log).
    this.composeMergeAt = 0;
    // The category stack the last default split proposed (a side channel like lastCompletionStats:
    // `splitWithModel` returns the plain entry list the public API expects).
    this.lastSplitCategories = null;
    this.rankConfig = config.profileRank !== null && typeof config.profileRank === 'object' ? config.profileRank : {};
    const similarity = Number(config.reconcileSimilarity);
    this.reconcileSimilarity = Number.isFinite(similarity) && similarity > 0 && similarity <= 1
      ? similarity
      : PROFILE_RECONCILE_SIMILARITY;
    this.clock = typeof options.now === 'function' ? options.now : () => Date.now();
    this.emit = typeof options.emit === 'function'
      ? options.emit
      : (typeof options.log?.emit === 'function' ? (type, payload) => options.log.emit(type, payload) : () => {});
    this.getLlm = typeof options.getLlm === 'function' ? options.getLlm : () => undefined;
    this.getSelection = typeof options.getSelection === 'function' ? options.getSelection : () => undefined;
    // Auxiliary completions may use the fast path's assist purpose (see ASSIST_PHASES); every
    // other phase keeps the shared completion exactly as before.
    this.assist = typeof options.assist === 'function' ? options.assist : null;
    this.complete = typeof options.complete === 'function'
      ? options.complete
      : (input) => this.completeWithLlm(input);
    this.extract = typeof options.extract === 'function'
      ? options.extract
      : (input) => this.extractWithModel(input);
    // The save path: one model call reads BOTH boxes and returns `{entries, categories}` (or a
    // plain entry list). Injectable so tests never call a real model; a failing split aborts the
    // save before any write. A legacy injected splitter (`{side, text}`) is detected and called
    // once per changed box instead — the default model splitter always reads both boxes at once.
    this.splitInjected = typeof options.split === 'function';
    this.splitter = this.splitInjected
      ? options.split
      : (input) => this.splitWithModel(input);
    // The writeback step: the agent rewrites the selected fragments into one natural prompt.
    this.composer = typeof options.compose === 'function'
      ? options.compose
      : (input) => this.composeWithModel(input);
    // Semantic cross-check of a rewrite (one lightweight call). Injectable so tests never call a
    // real model; it runs only when the host has the lightweight channel (or a verifier was
    // injected), so a deterministic-only host keeps the deterministic result.
    this.verifyInjected = typeof options.verifyCompose === 'function';
    this.composeVerifier = this.verifyInjected
      ? options.verifyCompose
      : (input) => this.verifyComposeWithModel(input);
    // P-116 generation is its own request: no chat turn, no history, no memory, no tools.
    this.personaQuizGenerator = typeof options.generatePersona === 'function'
      ? options.generatePersona
      : (input) => this.completeWithLlm({
        system: input.system, prompt: input.prompt, phase: 'persona', signal: input.signal,
      });
    // Tone repair: one extra completion over the violating sentences only. Injectable so tests
    // never call a real model; a throw/empty answer falls back deterministically.
    this.toneRepairer = typeof options.repairTone === 'function'
      ? options.repairTone
      : (input) => this.repairToneWithModel(input);
    // One-shot reclassification preview: injectable so tests never call a real model.
    this.reclassifier = typeof options.reclassify === 'function'
      ? options.reclassify
      : (input) => this.reclassifyWithModel(input);
    this.writePersona = typeof options.writePersona === 'function' ? options.writePersona : null;
    this.readMessages = typeof options.readMessages === 'function'
      ? options.readMessages
      : (input) => this.readMessagesFromMemory(input);
    // The settings-box prompt (agent/user persona text). Optional: without a source the
    // reconciler never runs, so a bare maintainer (tests, diagnostics) cannot wipe a mapping.
    this.personaSource = typeof options.readPersona === 'function';
    this.readPersona = this.personaSource ? options.readPersona : () => ({ agent: '', user: '' });
    this.isBusy = typeof options.isBusy === 'function' ? options.isBusy : () => false;
    this.isVoiceBusy = typeof options.isVoiceBusy === 'function' ? options.isVoiceBusy : null;
    this.busySnapshot = typeof options.busySnapshot === 'function' ? options.busySnapshot : null;
    this.queuePollMs = positiveInt(config.queuePollMs, 1000);
    // One active round plus at most one queued manual request (single-task limit).
    this.queue = null;
    this.queueTimer = null;
    this.taskSeq = 0;
    this.lastTask = null;
    this.activeQueuedTask = null;
    this.idleWaiters = [];
    // Lock exemptions are reported from inside ProfileStore; forward them through the same sink.
    if (typeof profile.attachEmitter === 'function') {
      profile.attachEmitter((type, payload) => this.emit(type, payload));
    }
    this.running = null;
    this.timer = null;
    this.startTimer = null;
    this.lastNotDueAt = 0;
    this.activeController = null;
    this.promptCache = null;
    for (const statement of SCHEMA) this.db.exec(statement);
    this.ensureSnapshotColumns();
    this.state = this.readState();
    // The category stack exists from the first launch: the presets are written once, never reset.
    this.seedCategories();
    // Older revision tables only allow user/agent/import; add the reclassify author in place.
    this.ensureReclassifyRevisionSource();
  }

  /** Older databases predate the `lines` mapping column; add it in place, never drop data. */
  ensureSnapshotColumns() {
    try {
      const columns = this.db.prepare('PRAGMA table_info(profile_snapshot)').all().map((row) => row.name);
      if (!columns.includes('lines')) {
        this.db.exec("ALTER TABLE profile_snapshot ADD COLUMN lines TEXT NOT NULL DEFAULT '[]'");
      }
    } catch {
      /* a read-only/blocked schema read leaves the existing table untouched */
    }
  }

  /**
   * ProfileStore's revision table pins `source` to user/agent/import. Reclassification, noise
   * cleanup and the direct library editor write the additional allow-listed authors, so an older
   * table is rebuilt once, preserving every row and the entry index. A table that already allows
   * every author (or a database without the table) is left untouched; a failed migration is
   * non-fatal.
   */
  ensureReclassifyRevisionSource() {
    try {
      const row = this.db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'profile_revision'")
        .get();
      if (row === undefined) return false;
      const sql = String(row.sql ?? '');
      if (sql.includes("'reclassify'") && sql.includes("'cleanup'")
        && sql.includes("'user-edit'") && sql.includes("'user-delete'")) return false;
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.exec('ALTER TABLE profile_revision RENAME TO profile_revision_legacy');
        this.db.exec('DROP INDEX IF EXISTS profile_revision_entry');
        this.db.exec(`CREATE TABLE profile_revision (
          id TEXT PRIMARY KEY,
          entry_id TEXT NOT NULL,
          before TEXT NOT NULL,
          after TEXT NOT NULL,
          at TEXT NOT NULL,
          source TEXT NOT NULL CHECK (source IN ('user', 'agent', 'import', 'reclassify', 'cleanup', 'user-edit', 'user-delete'))
        )`);
        this.db.exec(`INSERT INTO profile_revision (id, entry_id, before, after, at, source)
          SELECT id, entry_id, before, after, at, source FROM profile_revision_legacy`);
        this.db.exec('DROP TABLE profile_revision_legacy');
        this.db.exec('CREATE INDEX IF NOT EXISTS profile_revision_entry ON profile_revision(entry_id, at)');
        this.db.exec('COMMIT');
      } catch (error) {
        try {
          this.db.exec('ROLLBACK');
        } catch {
          /* transaction already unwound */
        }
        throw error;
      }
      return true;
    } catch {
      return false;
    }
  }

  /** Current instant from the injectable clock. */
  at() {
    const value = this.clock();
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) throw new Error('profile maintain: invalid clock');
    return date;
  }

  /**
   * Write the preset category stack once. An existing stack is never reset: a category the user or
   * the model retitled/removed must not come back on every restart.
   */
  seedCategories() {
    try {
      const count = Number(this.db.prepare('SELECT COUNT(*) AS c FROM profile_category').get()?.c ?? 0);
      if (count > 0) return false;
      const at = this.at().toISOString();
      const insert = this.db.prepare(
        `INSERT INTO profile_category (id, name, parent, description, source, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'preset', ?, ?)`,
      );
      for (const preset of PROFILE_CATEGORY_PRESETS) {
        insert.run(randomUUID(), preset.name, preset.parent, preset.description, at, at);
      }
      return true;
    } catch {
      return false;
    }
  }

  /** Every category row: agent side first, presets/creation order inside one parent. */
  categories() {
    try {
      return this.db
        .prepare(`SELECT id, name, parent, description, source, created_at, updated_at
          FROM profile_category ORDER BY parent, created_at, rowid`)
        .all()
        .map((row) => ({
          id: String(row.id),
          name: String(row.name),
          parent: String(row.parent),
          description: String(row.description ?? ''),
          source: String(row.source ?? 'preset'),
          createdAt: String(row.created_at ?? ''),
          updatedAt: String(row.updated_at ?? ''),
        }));
    } catch {
      return [];
    }
  }

  /** How many live entries are currently filed under one category name (case/space insensitive). */
  categoryUsage(name) {
    const key = categoryKey(name);
    if (key.length === 0) return 0;
    try {
      return this.profile.list().filter((entry) => categoryKey(entry.category) === key).length;
    } catch {
      return 0;
    }
  }

  /** `[{name, parent, count}]` for the settings page / status route. */
  categorySummary() {
    const counts = new Map();
    try {
      for (const entry of this.profile.list()) {
        const key = categoryKey(entry.category);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    } catch {
      /* an unreadable library renders every count as zero */
    }
    return this.categories().map((row) => ({
      name: row.name,
      parent: row.parent,
      count: counts.get(categoryKey(row.name)) ?? 0,
    }));
  }

  /**
   * 「分类管理」list: every category with its live entry count and origin. Read-only; the
   * settings card renders exactly these four fields next to each row.
   */
  categoryManageList() {
    const counts = new Map();
    try {
      for (const entry of this.profile.list()) {
        const key = categoryKey(entry.category);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    } catch {
      /* an unreadable library renders every count as zero */
    }
    return this.categories().map((row) => ({
      name: row.name,
      parent: row.parent,
      count: counts.get(categoryKey(row.name)) ?? 0,
      source: row.source === 'model' ? 'model' : row.source === PROFILE_CATEGORY_USER_SOURCE ? 'user' : 'preset',
    }));
  }

  /** 「分类管理」rename: one transaction; a conflict leaves the stack and every entry untouched. */
  renameCategory({ name, next } = {}) {
    const from = cleanText(name);
    const to = cleanText(next);
    if (from.length === 0 || to.length === 0) return { ok: false, error: '分类名称不能为空' };
    if ([...to].length > PROFILE_CATEGORY_MAX_NAME) {
      return { ok: false, error: `分类名称最多 ${PROFILE_CATEGORY_MAX_NAME} 字` };
    }
    const rows = this.categories();
    const row = rows.find((item) => categoryKey(item.name) === categoryKey(from));
    if (row === undefined) return { ok: false, error: '分类不存在' };
    const nextKey = categoryKey(to);
    if (nextKey !== categoryKey(row.name) && rows.some((item) => categoryKey(item.name) === nextKey)) {
      return { ok: false, error: '名称已存在' };
    }
    return this.profile.transact(() => {
      // Entries move to the new name in the same transaction: none is left on a vanished name.
      this.db.prepare('UPDATE profile_category SET name = ?, updated_at = ? WHERE id = ?')
        .run(to, this.at().toISOString(), row.id);
      this.repointEntryCategories(row.name, to);
      return { ok: true };
    });
  }

  /** 「分类管理」merge: move every entry of `from` to `into` (same side only), then drop `from`. */
  mergeCategories({ from, into } = {}) {
    const source = cleanText(from);
    const target = cleanText(into);
    if (source.length === 0 || target.length === 0) return { ok: false, error: '请选择来源与目标分类' };
    const rows = this.categories();
    const row = rows.find((item) => categoryKey(item.name) === categoryKey(source));
    const intoRow = rows.find((item) => categoryKey(item.name) === categoryKey(target));
    if (row === undefined) return { ok: false, error: '分类不存在' };
    if (intoRow === undefined) return { ok: false, error: '目标分类不存在' };
    if (categoryKey(row.name) === categoryKey(intoRow.name)) return { ok: false, error: '不能合并到自身' };
    if (row.parent !== intoRow.parent) return { ok: false, error: '只能合并同一侧的分类' };
    return this.profile.transact(() => {
      const moved = this.repointEntryCategories(row.name, intoRow.name);
      this.db.prepare('DELETE FROM profile_category WHERE id = ?').run(row.id);
      return { ok: true, moved };
    });
  }

  /**
   * 「分类管理」delete: only the category relation is dropped. Its entries are re-pointed to the
   * nearest remaining category of the same side (the split's own fallback rule), never deleted;
   * a side's last category is refused so no entry is ever left without one.
   */
  deleteCategory({ name } = {}) {
    const target = cleanText(name);
    if (target.length === 0) return { ok: false, error: '分类名称不能为空' };
    const rows = this.categories();
    const row = rows.find((item) => categoryKey(item.name) === categoryKey(target));
    if (row === undefined) return { ok: false, error: '分类不存在' };
    if (rows.filter((item) => item.parent === row.parent).length <= 1) {
      return { ok: false, code: 'CATEGORY_LAST', error: '同一侧至少保留一个分类' };
    }
    const remaining = rows.filter((item) => item.id !== row.id);
    const stack = new Map(remaining.map((item) => [categoryKey(item.name), item]));
    const fallback = this.resolveCategory(row.name, row.parent, stack).name;
    return this.profile.transact(() => {
      const reassigned = this.repointEntryCategories(row.name, fallback);
      this.db.prepare('DELETE FROM profile_category WHERE id = ?').run(row.id);
      return { ok: true, reassigned, fallback };
    });
  }

  /**
   * 「新建分类」: the user supplies the name and the parent side. Names compare after NFKC/case/
   * inner-space normalization, so a duplicate (even full-width) is refused instead of creating a
   * second row for the same name. The new row lands in that side's list immediately.
   */
  createCategory({ name, parent } = {}) {
    const cleanName = cleanText(name);
    const side = cleanText(parent).toLowerCase();
    if (cleanName.length === 0) return { ok: false, reason: 'invalid-name', error: '分类名称不能为空' };
    if ([...cleanName].length > PROFILE_CATEGORY_MAX_NAME) {
      return { ok: false, reason: 'invalid-name', error: `分类名称最多 ${PROFILE_CATEGORY_MAX_NAME} 字` };
    }
    if (!SIDES.includes(side)) {
      return { ok: false, reason: 'invalid-parent', error: '父级必须是 agent 或 user' };
    }
    const at = this.at().toISOString();
    const outcome = this.profile.transact(() => {
      // Checked inside the transaction too: a concurrent create must not duplicate the name.
      const key = categoryKey(cleanName);
      if (this.categories().some((row) => categoryKey(row.name) === key)) {
        return { ok: false, reason: 'duplicate-name', error: '名称已存在' };
      }
      this.db.prepare(
        `INSERT INTO profile_category (id, name, parent, description, source, created_at, updated_at)
          VALUES (?, ?, ?, '', ?, ?, ?)`,
      ).run(randomUUID(), cleanName, side, PROFILE_CATEGORY_USER_SOURCE, at, at);
      return { ok: true };
    });
    if (outcome.ok !== true) return outcome;
    this.emitNow(PROFILE_CATEGORY_EVENTS.created, { name: cleanName, parent: side });
    return {
      ok: true,
      category: { name: cleanName, parent: side },
      categories: this.categoryManageList(),
    };
  }

  /**
   * Host validation of the model's category suggestions, read-only. Returns the accepted ops
   * (applied inside the split transaction), the events to report after it, and the projected stack
   * every fragment's category is resolved against. Nothing here writes or throws.
   */
  planCategoryOps(suggestions = []) {
    const rows = this.categories();
    const byKey = new Map(rows.map((row) => [categoryKey(row.name), { ...row }]));
    const ops = [];
    const events = [];
    const reject = (reason, payload = {}) => events.push({
      type: PROFILE_CATEGORY_EVENTS.rejected,
      payload: { reason, ...payload },
    });
    const sizeOfSide = (parent) => [...byKey.values()].filter((row) => row.parent === parent).length;
    for (const item of Array.isArray(suggestions) ? suggestions : []) {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) {
        reject('invalid');
        continue;
      }
      const op = cleanText(item.op ?? item.kind ?? 'add').toLowerCase();
      const name = cleanText(item.name ?? item.target);
      const existing = byKey.get(categoryKey(name));
      if (op === 'add') {
        const parent = cleanText(item.parent).toLowerCase();
        const description = cleanText(item.description).slice(0, PROFILE_CATEGORY_MAX_DESCRIPTION);
        if (name.length === 0 || [...name].length > PROFILE_CATEGORY_MAX_NAME) {
          reject('invalid-name', { name, parent });
          continue;
        }
        if (!SIDES.includes(parent)) {
          reject('invalid-parent', { name, parent });
          continue;
        }
        if (existing !== undefined) {
          // Same name (case/space ignored) already owns this category: reuse it, never duplicate.
          reject('duplicate', { name, parent });
          continue;
        }
        ops.push({ kind: 'add', name, parent, description });
        byKey.set(categoryKey(name), { id: null, name, parent, description, source: 'model' });
        events.push({ type: PROFILE_CATEGORY_EVENTS.added, payload: { name, parent, source: 'model' } });
        continue;
      }
      if (existing === undefined || existing.id === null) {
        // An unknown name (or a row added earlier in this same batch, which has no id yet) cannot
        // be updated/deleted: refuse instead of recording an event for a change that never lands.
        reject('missing', { name, op });
        continue;
      }
      const into = cleanText(item.mergeInto ?? item.into);
      if (op === 'delete' || op === 'merge' || into.length > 0) {
        const target = into.length > 0 ? byKey.get(categoryKey(into)) : undefined;
        if (into.length > 0 && categoryKey(into) === categoryKey(existing.name)) {
          reject('merge-self', { name: existing.name, into });
          continue;
        }
        if (into.length > 0 && target === undefined) {
          reject('merge-target-missing', { name: existing.name, into });
          continue;
        }
        if (target !== undefined && target.parent !== existing.parent) {
          reject('merge-parent-mismatch', { name: existing.name, into });
          continue;
        }
        if (this.categoryUsage(existing.name) > 0 && target === undefined) {
          // Still referenced: a delete would orphan live entries. Refuse and ask for a merge.
          reject('in-use', { name: existing.name, parent: existing.parent });
          continue;
        }
        if (sizeOfSide(existing.parent) <= 1) {
          reject('last-of-side', { name: existing.name, parent: existing.parent });
          continue;
        }
        ops.push(target === undefined
          ? { kind: 'delete', id: existing.id, name: existing.name }
          : { kind: 'merge', id: existing.id, name: existing.name, into: target.name });
        byKey.delete(categoryKey(existing.name));
        events.push({
          type: PROFILE_CATEGORY_EVENTS.updated,
          payload: target === undefined
            ? { name: existing.name, op: 'delete' }
            : { name: target.name, from: existing.name },
        });
        continue;
      }
      const renameTo = cleanText(item.rename ?? item.renameTo ?? item.newName);
      const description = typeof item.description === 'string'
        ? cleanText(item.description).slice(0, PROFILE_CATEGORY_MAX_DESCRIPTION)
        : '';
      if (renameTo.length === 0 && description.length === 0) {
        reject('empty-update', { name: existing.name });
        continue;
      }
      if (renameTo.length > 0 && [...renameTo].length > PROFILE_CATEGORY_MAX_NAME) {
        reject('invalid-name', { name: renameTo });
        continue;
      }
      const nextKey = categoryKey(renameTo);
      if (renameTo.length > 0 && nextKey !== categoryKey(existing.name) && byKey.has(nextKey)) {
        reject('duplicate', { name: renameTo });
        continue;
      }
      ops.push({ kind: 'update', id: existing.id, name: existing.name, renameTo, description });
      if (renameTo.length > 0) {
        const row = byKey.get(categoryKey(existing.name));
        byKey.delete(categoryKey(existing.name));
        byKey.set(nextKey, { ...row, name: renameTo, description: description.length > 0 ? description : row.description });
      }
      events.push({ type: PROFILE_CATEGORY_EVENTS.updated, payload: { name: renameTo.length > 0 ? renameTo : existing.name } });
    }
    return { rows, byKey, ops, events };
  }

  /** Apply accepted category ops inside the caller's transaction (no validation, no events). */
  applyCategoryOps(ops = []) {
    const at = this.at().toISOString();
    for (const op of Array.isArray(ops) ? ops : []) {
      if (op.kind === 'add') {
        this.db.prepare(
          `INSERT INTO profile_category (id, name, parent, description, source, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'model', ?, ?)`,
        ).run(randomUUID(), op.name, op.parent, op.description, at, at);
        continue;
      }
      const row = op.id === null || op.id === undefined
        ? undefined
        : this.db.prepare('SELECT * FROM profile_category WHERE id = ?').get(op.id);
      if (row === undefined) continue;
      if (op.kind === 'update') {
        const name = op.renameTo.length > 0 ? op.renameTo : String(row.name);
        const description = op.description.length > 0 ? op.description : String(row.description ?? '');
        this.db.prepare('UPDATE profile_category SET name = ?, description = ?, updated_at = ? WHERE id = ?')
          .run(name, description, at, row.id);
        if (op.renameTo.length > 0) this.repointEntryCategories(row.name, name);
        continue;
      }
      if (op.kind === 'merge') {
        this.repointEntryCategories(row.name, op.into);
        this.db.prepare('DELETE FROM profile_category WHERE id = ?').run(row.id);
        continue;
      }
      if (op.kind === 'delete') {
        this.db.prepare('DELETE FROM profile_category WHERE id = ?').run(row.id);
      }
    }
  }

  /** Move every entry filed under `from` to `to` so a rename/merge leaves no orphan category. */
  repointEntryCategories(from, to) {
    const key = categoryKey(from);
    let moved = 0;
    try {
      for (const entry of this.profile.list()) {
        if (categoryKey(entry.category) !== key) continue;
        const edited = this.profile.reconcileEdit(entry.id, { category: to });
        if (edited !== null && Array.isArray(edited.changed) && edited.changed.length > 0) moved += 1;
      }
    } catch {
      /* an unreadable library keeps its old category text; the next organize repairs it */
    }
    return moved;
  }

  /**
   * One fragment's category → a name that exists in the projected stack and belongs to that
   * fragment's side. An unknown name (or a name from the other side) falls back to the nearest
   * category of its own side, so no entry is ever lost or left without a category.
   */
  resolveCategory(name, side, stack = null) {
    const byKey = stack instanceof Map
      ? stack
      : new Map(this.categories().map((row) => [categoryKey(row.name), row]));
    const clean = cleanText(name);
    const hit = byKey.get(categoryKey(clean));
    if (hit !== undefined && hit.parent === side) return { name: hit.name, matched: true, fallback: false, requested: clean };
    const pool = [...byKey.values()].filter((row) => row.parent === side);
    let best = null;
    let bestScore = -1;
    for (const row of pool) {
      const score = clean.length === 0 ? 1 : promptSimilarity(clean, row.name);
      if (score > bestScore) {
        best = row;
        bestScore = score;
      }
    }
    if (best === null) {
      const preset = PROFILE_CATEGORY_PRESETS.find((row) => row.parent === side);
      return { name: preset.name, matched: false, fallback: true, requested: clean };
    }
    return { name: best.name, matched: false, fallback: true, requested: clean, score: bestScore };
  }

  /**
   * One-shot reclassification PREVIEW (read-only, no scores, no writes). Every live entry's text,
   * current side and current category is handed to the model together with the existing category
   * stack; the model may only propose an existing category (whose parent owns the side). The host
   * filters suggestions down to real changes and returns them with the library version the plan
   * was computed against.
   *
   * The `items` list is the per-row contract the settings card renders: every live entry appears
   * once, with `inBox` (currently represented by the settings box), `kind` (normal/noise), and
   * `suggested` (move/keep/delete). A noise row is always a delete suggestion, never a move.
   * `changes` stays as the model's move subset for the legacy one-shot apply path.
   *
   * @returns {Promise<{ok: boolean, version?: string, changes?: object[], items?: object[],
   *   total?: number, noise?: number, inBoxOnly?: number, error?: string, modelCalls?: number}>}
   */
  async planReclassify({ signal } = {}) {
    let entries;
    try {
      entries = this.profile.list().map((entry) => ({
        id: entry.id,
        side: entry.side,
        category: entry.category,
        text: entry.text,
      }));
    } catch (error) {
      return {
        ok: false, error: String(error?.message ?? error), changes: [], items: [], total: 0, noise: 0, inBoxOnly: 0, modelCalls: 0,
      };
    }
    const version = this.librarySignature();
    if (entries.length === 0) {
      return {
        ok: true, version, changes: [], items: [], total: 0, noise: 0, inBoxOnly: 0, modelCalls: 0,
      };
    }
    const categories = this.categories();
    try {
      const raw = await this.reclassifier({ entries, categories, signal });
      if (signal?.aborted) {
        return {
          ok: false, error: 'profile reclassify: cancelled', changes: [], items: [], version, total: entries.length, noise: 0, inBoxOnly: 0, modelCalls: 1,
        };
      }
      const changes = this.normalizeReclassifyChanges(raw, entries, categories);
      const items = this.buildReclassifyItems(entries, changes);
      const noise = items.filter((item) => item.kind === 'noise').length;
      const inBoxOnly = items.filter((item) => item.inBox !== true).length;
      this.emitNow(PROFILE_RECLASSIFY_EVENTS.preview, { total: items.length, noise, inBoxOnly });
      return {
        ok: true, version, changes, items, total: items.length, noise, inBoxOnly, modelCalls: 1,
      };
    } catch (error) {
      return {
        ok: false,
        error: String(error?.message ?? error),
        changes: [],
        items: [],
        total: entries.length,
        noise: 0,
        inBoxOnly: 0,
        modelCalls: 1,
      };
    }
  }

  /** Settings-card name for the same read-only preview; the host contract is `planReclassify`. */
  previewReclassify(options = {}) {
    return this.planReclassify(options);
  }

  /**
   * 「库编辑」entry list: every live entry with the exact fields the editor renders. `inBox` says
   * whether that entry's CURRENT text is visible in the settings box: the saved mapping is trusted
   * only while the box still equals its synced text AND the mapped text is still the entry text,
   * so a library text edit immediately shows as 仅库 until the next organize rewrites the box.
   */
  entryList() {
    const boxes = this.readBoxes();
    const synced = this.syncedTexts();
    const mapping = new Map(this.snapshotLines().map((line) => [line.entryId, line.text]));
    return this.profile.list().map((entry) => ({
      id: entry.id,
      text: entry.text,
      side: entry.side,
      category: entry.category,
      inBox: this.entryInBox(entry, { boxes, synced, mapping }),
    }));
  }

  /** One entry → whether its current text is represented by its own settings box. */
  entryInBox(entry, { boxes, synced, mapping }) {
    const sideText = cleanText(boxes?.[entry.side] ?? '');
    if (sideText.length === 0) return false;
    const boxKey = composeKey(sideText);
    const ownKey = composeKey(entry.text);
    if (ownKey.length > 0 && boxKey.includes(ownKey)) return true;
    const mapped = mapping?.get?.(entry.id);
    return mapped !== undefined
      && sideText === cleanText(synced?.[entry.side] ?? '')
      && composeKey(mapped) === ownKey;
  }

  /**
   * Every live entry → one preview row. A noise row (testing/temporary behaviour) always suggests
   * DELETE and never a move; a validated model change suggests MOVE; everything else suggests
   * KEEP. `inBox` reads the saved `(entryId, text)` mapping and, for a not-yet-reconciled box, a
   * punctuation-insensitive match of the entry's own text, so 库有框无 is visible as 仅库.
   */
  buildReclassifyItems(entries, changes) {
    const boxes = this.readBoxes();
    const synced = this.syncedTexts();
    const mapping = new Map(this.snapshotLines().map((line) => [line.entryId, line.text]));
    const moves = new Map((Array.isArray(changes) ? changes : []).map((change) => [change.entryId, change]));
    return (Array.isArray(entries) ? entries : []).map((entry) => {
      const sideText = cleanText(boxes[entry.side] ?? '');
      const boxKey = composeKey(sideText);
      const ownKey = composeKey(entry.text);
      // The mapping is only trusted while the box still equals the text it was synchronized with;
      // a user-edited box falls back to a punctuation-insensitive match of the entry text.
      const syncedSame = sideText.length > 0 && sideText === cleanText(synced[entry.side] ?? '');
      const inBox = boxKey.length > 0
        && ((syncedSame && mapping.has(entry.id)) || (ownKey.length > 0 && boxKey.includes(ownKey)));
      const from = { side: entry.side, category: entry.category };
      const reason = noiseReason(entry.text);
      if (reason !== null) {
        return {
          entryId: entry.id,
          text: entry.text,
          side: entry.side,
          category: entry.category,
          from,
          to: null,
          inBox,
          kind: 'noise',
          suggested: 'delete',
          reason,
        };
      }
      const move = moves.get(entry.id);
      if (move !== undefined) {
        return {
          entryId: entry.id,
          text: entry.text,
          side: entry.side,
          category: entry.category,
          from,
          to: { side: move.to.side, category: move.to.category },
          inBox,
          kind: 'normal',
          suggested: 'move',
          reason: move.reason ?? '',
        };
      }
      return {
        entryId: entry.id,
        text: entry.text,
        side: entry.side,
        category: entry.category,
        from,
        to: { side: entry.side, category: entry.category },
        inBox,
        kind: 'normal',
        suggested: 'keep',
        reason: '',
      };
    });
  }

  /**
   * Host validation of one model change list. Only a real side/category difference survives; the
   * category must exist in the stack and its parent owns the target side (a suggestion naming a
   * category of the other side is inconsistent and is dropped instead of guessed).
   */
  normalizeReclassifyChanges(raw, entries, categories) {
    const list = parseReclassifyPayload(raw);
    const byId = new Map((Array.isArray(entries) ? entries : []).map((entry) => [entry.id, entry]));
    const stack = new Map((Array.isArray(categories) ? categories : [])
      .map((row) => [categoryKey(row.name), row]));
    const seen = new Set();
    const changes = [];
    for (const item of Array.isArray(list) ? list : []) {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
      const entryId = cleanText(item.entryId ?? item.entry_id ?? item.id);
      const entry = byId.get(entryId);
      if (entry === undefined || seen.has(entryId)) continue;
      const target = item.to !== null && typeof item.to === 'object' ? item.to : item;
      const row = stack.get(categoryKey(target.category ?? item.category));
      if (row === undefined) continue;
      const requested = cleanText(target.side ?? item.side).toLowerCase();
      if (SIDES.includes(requested) && requested !== row.parent) continue;
      if (row.parent === entry.side && categoryKey(row.name) === categoryKey(entry.category)) continue;
      seen.add(entryId);
      changes.push({
        entryId,
        text: entry.text,
        from: { side: entry.side, category: entry.category },
        to: { side: row.parent, category: row.name },
        reason: cleanText(item.reason ?? target.reason),
      });
    }
    return changes;
  }

  /**
   * Apply a confirmed preview. One transaction:
   *  - first re-reads the library; a plan whose entries were changed since the preview aborts
   *    (`aborted:true`, reason `version-conflict`) before any write;
   *  - an already-satisfied plan is a no-op (`applied:0`), so the same plan can be applied twice;
   *  - only `side`, `category` and the cross-side pronoun prefix are written. Clarity, efficacy,
   *    rank, support/evidence rows and the origin rank (`original`) are never touched;
   *  - one revision row (`source:'reclassify'`) records exactly the changed fields.
   * The `profile.reclassify.applied {moved, deleted}` event is emitted after the commit only.
   */
  async applyReclassify(plan, { expectedVersion = null } = {}) {
    const changes = Array.isArray(plan) ? plan : (Array.isArray(plan?.changes) ? plan.changes : []);
    const expected = expectedVersion ?? plan?.version ?? null;
    const at = this.at().toISOString();
    let outcome;
    try {
      outcome = this.profile.transact(() => this.commitReclassify(changes, expected, at));
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error), applied: 0, changes: [] };
    }
    if (outcome.aborted === true) {
      return { ok: false, aborted: true, reason: outcome.reason, applied: 0, changes: [] };
    }
    if (outcome.applied > 0) {
      this.emitNow(PROFILE_RECLASSIFY_EVENTS.applied, { moved: outcome.applied, deleted: 0 });
    }
    return {
      ok: true,
      applied: outcome.applied,
      idempotent: outcome.applied === 0,
      changes: outcome.changes,
      version: this.librarySignature(),
    };
  }

  /** Transaction body of `applyReclassify`: no validation of the model, only of the current DB. */
  commitReclassify(changes, expectedVersion, at) {
    const rows = new Map(
      this.db.prepare('SELECT * FROM profile_entry ORDER BY id').all().map((row) => [String(row.id), row]),
    );
    const stack = new Map(this.categories().map((row) => [categoryKey(row.name), row]));
    const pending = [];
    for (const change of Array.isArray(changes) ? changes : []) {
      const row = rows.get(cleanText(change?.entryId));
      if (row === undefined || row.rejected === 1) continue;
      const category = stack.get(categoryKey(change?.to?.category));
      if (category === undefined) continue;
      if (row.side === category.parent && categoryKey(row.category) === categoryKey(category.name)) continue;
      pending.push({
        row,
        side: category.parent,
        category: category.name,
        // A misplaced-rule fix carries the restored user sentence; a plain reclassify does not.
        targetText: cleanText(change?.targetText),
      });
    }
    // An already-satisfied plan is idempotent, even though the library version moved after the
    // first apply: there is nothing left to write, so there is nothing to conflict with.
    if (pending.length === 0) return { aborted: false, applied: 0, changes: [] };
    if (expectedVersion !== null && expectedVersion !== undefined
      && String(expectedVersion) !== this.librarySignature()) {
      return { aborted: true, reason: 'version-conflict', applied: 0, changes: [] };
    }
    let applied = 0;
    const written = [];
    for (const item of pending) {
      let text = String(item.row.text ?? '');
      let textChanged = false;
      if (item.side !== item.row.side) {
        const normalized = item.targetText.length > 0
          ? item.targetText
          : normalizeReclassifyText(text, item.side);
        if (normalized.length > 0 && normalized !== text) {
          const clash = this.db
            .prepare('SELECT id FROM profile_entry WHERE side = ? AND text = ? AND id <> ?')
            .get(item.side, normalized, item.row.id);
          // A tone-normalized text that collides with a live entry keeps the original wording;
          // the category/side change itself is still safe and idempotent.
          if (clash === undefined) {
            text = normalized;
            textChanged = true;
          }
        }
      }
      const before = { side: item.row.side, category: item.row.category };
      const after = { side: item.side, category: item.category };
      if (textChanged) {
        before.text = item.row.text;
        after.text = text;
      }
      this.db
        .prepare('UPDATE profile_entry SET side = ?, category = ?, text = ?, version = version + 1, updated_at = ? WHERE id = ?')
        .run(item.side, item.category, text, at, item.row.id);
      this.insertReclassifyRevision(item.row.id, before, after, at);
      applied += 1;
      written.push({
        entryId: item.row.id,
        text,
        from: { side: item.row.side, category: item.row.category },
        to: { side: item.side, category: item.category },
      });
    }
    return { aborted: false, applied, changes: written };
  }

  /**
   * Per-row selection from the preview: `{moves:[{id, side, category}], deletes:[id...]}`.
   * Only the selected rows are written; every unselected row stays byte-identical. A move reuses
   * the existing reclassify transaction (side/category, plus the cross-side pronoun prefix), so
   * evidence, scores, rank and identity are untouched. A delete writes one `reclassify` revision
   * and removes the evidence rows and the entry, behind the same deletion boundary as a cleanup.
   * An id that no longer exists (or an already-deleted/satisfied row) is counted in `skipped`
   * instead of throwing.
   *
   * @returns {Promise<{ok: boolean, moved: number, deleted: number, skipped: number,
   *   version?: string, aborted?: boolean, reason?: string, error?: string}>}
   */
  async applyReclassifySelection(selection = {}, { expectedVersion = null } = {}) {
    const moves = Array.isArray(selection?.moves) ? selection.moves : [];
    const deletes = Array.isArray(selection?.deletes) ? selection.deletes : [];
    let outcome;
    try {
      outcome = this.profile.transact(() => this.commitReclassifySelection(
        moves,
        deletes,
        expectedVersion,
        this.at().toISOString(),
      ));
    } catch (error) {
      return {
        ok: false, error: String(error?.message ?? error), moved: 0, deleted: 0, skipped: 0,
      };
    }
    if (outcome.aborted === true) {
      return {
        ok: false, aborted: true, reason: outcome.reason, moved: 0, deleted: 0, skipped: 0,
      };
    }
    if (outcome.moved > 0 || outcome.deleted > 0) {
      this.emitNow(PROFILE_RECLASSIFY_EVENTS.applied, { moved: outcome.moved, deleted: outcome.deleted });
    }
    return {
      ok: true,
      moved: outcome.moved,
      deleted: outcome.deleted,
      skipped: outcome.skipped,
      version: this.librarySignature(),
    };
  }

  /** Transaction body of `applyReclassifySelection`: validate ids, then write only what was selected. */
  commitReclassifySelection(moves, deletes, expectedVersion, at) {
    const rows = new Map(
      this.db.prepare('SELECT * FROM profile_entry ORDER BY id').all().map((row) => [String(row.id), row]),
    );
    const stack = new Map(this.categories().map((row) => [categoryKey(row.name), row]));
    const handled = new Set();
    const validMoves = [];
    const validDeletes = [];
    let skipped = 0;
    const idOf = (value) => cleanText(typeof value === 'string' ? value : (value?.id ?? value?.entryId));
    for (const raw of Array.isArray(moves) ? moves : []) {
      const id = idOf(raw);
      const row = rows.get(id);
      if (id.length === 0 || handled.has(id) || row === undefined || row.rejected === 1) {
        skipped += 1;
        continue;
      }
      handled.add(id);
      const side = cleanText(raw?.side ?? raw?.to?.side).toLowerCase();
      const category = stack.get(categoryKey(raw?.category ?? raw?.to?.category));
      if (!SIDES.includes(side) || category === undefined || category.parent !== side) {
        skipped += 1;
        continue;
      }
      // An already-satisfied move is a no-op, never a second revision.
      if (row.side === side && categoryKey(row.category) === categoryKey(category.name)) {
        skipped += 1;
        continue;
      }
      validMoves.push({ entryId: id, to: { side, category: category.name } });
    }
    for (const raw of Array.isArray(deletes) ? deletes : []) {
      const id = idOf(raw);
      const row = rows.get(id);
      if (id.length === 0 || handled.has(id) || row === undefined || row.rejected === 1) {
        skipped += 1;
        continue;
      }
      handled.add(id);
      validDeletes.push(id);
    }
    if (validMoves.length === 0 && validDeletes.length === 0) {
      return { aborted: false, moved: 0, deleted: 0, skipped };
    }
    // The preview's version is still enforced for the selection, so a library edit that landed
    // while the list was open cannot be overwritten silently.
    if (expectedVersion !== null && expectedVersion !== undefined
      && String(expectedVersion) !== this.librarySignature()) {
      return { aborted: true, reason: 'version-conflict', moved: 0, deleted: 0, skipped: 0 };
    }
    const movedOutcome = this.commitReclassify(validMoves, null, at);
    let moved = movedOutcome.applied;
    skipped += validMoves.length - moved;
    let deleted = 0;
    for (const id of validDeletes) {
      const entry = this.profile.get(id);
      if (entry === null) {
        skipped += 1;
        continue;
      }
      this.recordDeletion(id);
      this.db
        .prepare('INSERT INTO profile_revision (id, entry_id, before, after, at, source) VALUES (?, ?, ?, ?, ?, ?)')
        .run(
          randomUUID(),
          id,
          JSON.stringify({ side: entry.side, category: entry.category, text: entry.text }),
          JSON.stringify({ removed: true }),
          at,
          PROFILE_RECLASSIFY_SOURCE,
        );
      // The revision row stays: delete only the evidence and the entry itself.
      this.db.prepare('DELETE FROM profile_evidence WHERE entry_id = ?').run(id);
      this.db.prepare('DELETE FROM profile_entry WHERE id = ?').run(id);
      deleted += 1;
    }
    if (deleted > 0) {
      const previous = this.snapshot();
      if (previous !== null) {
        const lines = previous.lines.filter((line) => this.profile.get(line.entryId) !== null);
        const compiled = this.profile.compileRank({ config: this.rankConfig });
        const version = (Number(previous.version) || 0) + 1;
        this.writeSnapshot(compiled.text, Number(compiled.usedTokens) || 0, version, at, lines);
        this.setState({ snapshotVersion: version, snapshotAt: at, snapshotTrigger: 'reclassify' });
      }
    }
    return { aborted: false, moved, deleted, skipped };
  }

  /** One reclassification revision; `source` is the dedicated allow-listed author. */
  insertReclassifyRevision(entryId, before, after, at) {
    this.db
      .prepare('INSERT INTO profile_revision (id, entry_id, before, after, at, source) VALUES (?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), entryId, JSON.stringify(before), JSON.stringify(after), at, PROFILE_RECLASSIFY_SOURCE);
  }

  /**
   * 「库编辑」edit one entry's TEXT only. The id, evidence rows, support count, clarity/efficacy,
   * rank and category are untouched: this is a direct user edit, never a support event, so it does
   * NOT strengthen or re-score the entry. One revision records the before/after text with the
   * allow-listed `user-edit` author. The settings boxes are not rewritten here (库=存，框=用).
   */
  updateEntryText({ id, text } = {}) {
    const entryId = cleanText(id);
    const next = cleanText(text);
    if (entryId.length === 0) return { ok: false, reason: 'unknown-entry' };
    if (next.length === 0) return { ok: false, reason: 'empty-text', error: '条目内容不能为空' };
    const at = this.at().toISOString();
    const outcome = this.profile.transact(() => {
      const entry = this.profile.get(entryId);
      if (entry === null) return { ok: false, reason: 'unknown-entry' };
      if (entry.text === next) return { ok: true, changed: false, entry };
      const clash = this.db
        .prepare('SELECT id FROM profile_entry WHERE side = ? AND text = ? AND id <> ?')
        .get(entry.side, next, entryId);
      if (clash !== undefined) {
        return { ok: false, reason: 'duplicate-text', error: '同一侧已有相同内容的条目' };
      }
      this.db
        .prepare('UPDATE profile_entry SET text = ?, version = version + 1, updated_at = ? WHERE id = ?')
        .run(next, at, entryId);
      const revisionId = randomUUID();
      const before = { text: entry.text };
      const after = { text: next };
      this.db
        .prepare('INSERT INTO profile_revision (id, entry_id, before, after, at, source) VALUES (?, ?, ?, ?, ?, ?)')
        .run(revisionId, entryId, JSON.stringify(before), JSON.stringify(after), at, PROFILE_ENTRY_EDIT_SOURCE);
      return {
        ok: true,
        changed: true,
        entry: this.profile.get(entryId),
        revision: { id: revisionId, entry_id: entryId, before, after, at, source: PROFILE_ENTRY_EDIT_SOURCE },
      };
    });
    if (outcome.ok === true && outcome.changed === true) {
      this.emitNow(PROFILE_ENTRY_EVENTS.updated, { id: entryId, field: 'text' });
    }
    return outcome;
  }

  /**
   * 「库编辑」re-file one entry into an existing category. The category owns its parent side, so a
   * cross-parent pick changes `side` together with `category` (the UI never asks for a side). The
   * existing reclassify transaction's guarantees hold: id, evidence/identity, clarity/efficacy and
   * rank are untouched; only one `user-edit` revision is written. Unknown category → refusal with
   * `reason:'unknown-category'`. The text is left exactly as the user typed it.
   */
  setEntryCategory({ id, category } = {}) {
    const entryId = cleanText(id);
    if (entryId.length === 0) return { ok: false, reason: 'unknown-entry' };
    const wanted = cleanText(category);
    const at = this.at().toISOString();
    const outcome = this.profile.transact(() => {
      const entry = this.profile.get(entryId);
      if (entry === null) return { ok: false, reason: 'unknown-entry' };
      const target = this.categories().find((row) => categoryKey(row.name) === categoryKey(wanted));
      if (target === undefined) return { ok: false, reason: 'unknown-category' };
      if (entry.side === target.parent && categoryKey(entry.category) === categoryKey(target.name)) {
        return { ok: true, changed: false, entry };
      }
      const before = { side: entry.side, category: entry.category };
      const after = { side: target.parent, category: target.name };
      this.db
        .prepare('UPDATE profile_entry SET side = ?, category = ?, version = version + 1, updated_at = ? WHERE id = ?')
        .run(target.parent, target.name, at, entryId);
      const revisionId = randomUUID();
      this.db
        .prepare('INSERT INTO profile_revision (id, entry_id, before, after, at, source) VALUES (?, ?, ?, ?, ?, ?)')
        .run(revisionId, entryId, JSON.stringify(before), JSON.stringify(after), at, PROFILE_ENTRY_EDIT_SOURCE);
      return {
        ok: true,
        changed: true,
        entry: this.profile.get(entryId),
        revision: { id: revisionId, entry_id: entryId, before, after, at, source: PROFILE_ENTRY_EDIT_SOURCE },
      };
    });
    if (outcome.ok === true && outcome.changed === true) {
      this.emitNow(PROFILE_ENTRY_EVENTS.updated, { id: entryId, field: 'category' });
    }
    return outcome;
  }

  /**
   * 「库编辑」hard delete. It reuses the existing deletion path: the evidence boundary is recorded
   * first (`recordDeletion`), one `user-delete` revision keeps the removed row for audit, then only
   * the evidence rows and the entry itself are deleted (the revision survives). The snapshot and
   * its mapping are compacted in the same transaction, exactly like a confirmed reclassify delete.
   */
  deleteEntry({ id } = {}) {
    const entryId = cleanText(id);
    if (entryId.length === 0) return { ok: false, reason: 'unknown-entry' };
    const at = this.at().toISOString();
    const outcome = this.profile.transact(() => {
      const entry = this.profile.get(entryId);
      if (entry === null) return { ok: false, reason: 'unknown-entry' };
      this.recordDeletion(entryId);
      this.db
        .prepare('INSERT INTO profile_revision (id, entry_id, before, after, at, source) VALUES (?, ?, ?, ?, ?, ?)')
        .run(
          randomUUID(),
          entryId,
          JSON.stringify({ side: entry.side, category: entry.category, text: entry.text }),
          JSON.stringify({ removed: true }),
          at,
          PROFILE_ENTRY_DELETE_SOURCE,
        );
      // The revision row stays: delete only the evidence and the entry itself.
      this.db.prepare('DELETE FROM profile_evidence WHERE entry_id = ?').run(entryId);
      this.db.prepare('DELETE FROM profile_entry WHERE id = ?').run(entryId);
      const previous = this.snapshot();
      if (previous !== null) {
        const lines = previous.lines.filter((line) => this.profile.get(line.entryId) !== null);
        const compiled = this.profile.compileRank({ config: this.rankConfig });
        const version = (Number(previous.version) || 0) + 1;
        this.writeSnapshot(compiled.text, Number(compiled.usedTokens) || 0, version, at, lines);
        this.setState({ snapshotVersion: version, snapshotAt: at, snapshotTrigger: 'user-delete' });
      }
      return { ok: true, removed: true, id: entryId, entry };
    });
    if (outcome.ok === true && outcome.removed === true) {
      this.emitNow(PROFILE_ENTRY_EVENTS.deleted, { id: entryId });
    }
    return outcome;
  }

  /**
   * The user-side sentence an agent entry was moved away from: the newest revision whose `after`
   * is the agent side and whose `before` was the user side. It recovers the original wording
   * instead of inventing a paraphrase; null when no such revision exists.
   */
  lastUserSideRevision(entryId) {
    try {
      const revision = this.profile.revision(entryId)
        .find((row) => row.after?.side === 'agent' && row.before?.side === 'user');
      return revision?.before ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Read-only preview of the defence: agent entries that are really a user self-description
   * rewritten as a 「你不要…」 rule. The returned change list is directly applicable through the
   * existing `applyReclassify` transaction; nothing is written here.
   */
  previewFixMisplaced() {
    const categories = this.categories();
    const stack = new Map(categories.map((row) => [categoryKey(row.name), row]));
    const changes = [];
    let total = 0;
    for (const entry of this.profile.list()) {
      total += 1;
      if (entry.side !== 'agent') continue;
      const decision = classifyProfileEntrySide(
        { text: entry.text, side: entry.side, category: entry.category },
        categories,
      );
      if (decision === null || decision.drop === true || decision.side !== 'user') continue;
      // Only the defence (a user self-description rewritten as a rule) belongs to this preview;
      // a plain category-parent repair is not a side move and must not be mixed in.
      if (decision.reason !== 'misplaced-rule') continue;
      const original = this.lastUserSideRevision(entry.id);
      const originalCategory = cleanText(original?.category);
      const categoryForSide = originalCategory.length > 0
        && stack.get(categoryKey(originalCategory))?.parent === 'user'
        ? stack.get(categoryKey(originalCategory)).name
        : decision.category;
      const text = cleanText(original?.text) || decision.text || restoreUserStatement(entry.text);
      changes.push({
        entryId: entry.id,
        text,
        targetText: text,
        from: { side: entry.side, category: entry.category },
        to: { side: 'user', category: categoryForSide },
        reason: decision.reason ?? 'user-self-description',
      });
    }
    return { ok: true, version: this.librarySignature(), total, changes };
  }

  /**
   * Read-only preview of "temporary testing behaviour" rows (测试功能 / 更换语音合成 / 让助手多说
   * 几句). It only names candidates; `removeNoise()` is the explicit confirmation that deletes them.
   */
  previewNoise() {
    const candidates = [];
    let total = 0;
    for (const entry of this.profile.list()) {
      total += 1;
      const reason = noiseReason(entry.text);
      if (reason === null) continue;
      candidates.push({
        entryId: entry.id,
        side: entry.side,
        category: entry.category,
        text: entry.text,
        reason,
      });
    }
    return { ok: true, version: this.librarySignature(), total, candidates };
  }

  /**
   * Explicitly confirmed noise removal. Only an id that still matches the noise signature may be
   * removed, so this path can never delete an arbitrary entry by id. One transaction: a `cleanup`
   * revision records the removed row (the revision rows are kept for audit), then the entry and
   * its evidence are deleted. No tombstone/ban is created; the existing bounded deletion boundary
   * only stops old messages from rebuilding the same temporary behaviour.
   */
  removeNoise(ids, { confirm = true } = {}) {
    if (confirm !== true) return { ok: false, error: 'confirmation-required', removed: 0, entries: [] };
    const wanted = [...new Set((Array.isArray(ids) ? ids : [ids]).map(cleanText).filter((id) => id.length > 0))];
    if (wanted.length === 0) return { ok: true, removed: 0, entries: [], version: this.librarySignature() };
    let removed = [];
    try {
      removed = this.profile.transact(() => {
        const at = this.at().toISOString();
        const rows = [];
        for (const id of wanted) {
          const entry = this.profile.get(id);
          if (entry === null) continue;
          const reason = noiseReason(entry.text);
          if (reason === null) continue;
          this.recordDeletion(id);
          this.db
            .prepare('INSERT INTO profile_revision (id, entry_id, before, after, at, source) VALUES (?, ?, ?, ?, ?, ?)')
            .run(
              randomUUID(),
              id,
              JSON.stringify({ side: entry.side, category: entry.category, text: entry.text }),
              JSON.stringify({ removed: true }),
              at,
              PROFILE_CLEANUP_SOURCE,
            );
          // The revision row stays: delete only the evidence and the entry itself.
          this.db.prepare('DELETE FROM profile_evidence WHERE entry_id = ?').run(id);
          this.db.prepare('DELETE FROM profile_entry WHERE id = ?').run(id);
          rows.push({ entryId: id, side: entry.side, category: entry.category, text: entry.text, reason });
        }
        if (rows.length > 0) {
          const previous = this.snapshot();
          if (previous !== null) {
            const lines = previous.lines.filter((line) => this.profile.get(line.entryId) !== null);
            const compiled = this.profile.compileRank({ config: this.rankConfig });
            const version = (Number(previous.version) || 0) + 1;
            this.writeSnapshot(compiled.text, Number(compiled.usedTokens) || 0, version, at, lines);
            this.setState({ snapshotVersion: version, snapshotAt: at, snapshotTrigger: 'cleanup' });
          }
          this.setState({ lastCleanup: { at, ids: rows.map((row) => row.entryId) } });
        }
        return rows;
      });
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error), removed: 0, entries: [] };
    }
    for (const row of removed) {
      this.emitNow(PROFILE_CLEANUP_EVENT, {
        entryId: row.entryId,
        reason: row.reason,
        source: PROFILE_CLEANUP_SOURCE,
      });
    }
    return { ok: true, removed: removed.length, entries: removed, version: this.librarySignature() };
  }

  /** Default reclassification model step (no tools, no conversation injection). */
  async reclassifyWithModel({ entries = [], categories = [], signal } = {}) {
    return this.complete({
      system: RECLASSIFY_SYSTEM,
      prompt: buildReclassifyPrompt({ entries, categories }),
      phase: 'reclassify',
      signal,
    });
  }

  readState() {
    const state = {};
    try {
      for (const row of this.db.prepare('SELECT key, value FROM profile_maintain_state').all()) {
        if (row.key === 'lastSummary') {
          try {
            state.lastSummary = JSON.parse(row.value);
          } catch {
            state.lastSummary = null;
          }
        } else {
          state[row.key] = row.value;
        }
      }
    } catch {
      /* an unreadable metadata row is treated as an empty state */
    }
    return state;
  }

  /** Stable `(ts, id)` key of the last delivered message (null before the first round). */
  readCursor() {
    return parseCursorValue(this.state.cursor);
  }

  /** Persist metadata. Called inside profile.transact while committing, directly otherwise. */
  setState(patch) {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      if (value === null) {
        this.db.prepare('DELETE FROM profile_maintain_state WHERE key = ?').run(key);
      } else {
        const stored = typeof value === 'string' ? value : JSON.stringify(value);
        this.db.prepare(
          `INSERT INTO profile_maintain_state (key, value) VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        ).run(key, stored);
      }
    }
    this.state = this.readState();
  }

  /** Best-effort metadata write: a bookkeeping failure never changes the outcome. */
  writeStateSafe(patch) {
    try {
      if (this.db.isTransaction) this.setState(patch);
      else this.profile.transact(() => this.setState(patch));
    } catch {
      /* the round result is reported through its return value/event */
    }
  }

  /**
   * The compiled prompt plus the settings-box mapping: `lines` is the `[{entryId, text}]` order
   * the settings box shows and the next reconcile diffs against. It is not derived from `text`.
   */
  snapshot() {
    const row = this.db.prepare('SELECT * FROM profile_snapshot WHERE id = ?').get('current');
    return row === undefined ? null : { ...row, lines: parseSnapshotLines(row.lines) };
  }

  /** The saved `(entryId, text)` mapping; an absent snapshot reads as an empty mapping. */
  snapshotLines() {
    const lines = this.snapshot()?.lines;
    return Array.isArray(lines) ? lines : [];
  }

  /**
   * The text last synchronized into the library, per side. It is written by a split save (the
   * text the model just split) and by a writeback (the composed prompt). A box whose text equals
   * its synced text has no pending user edit, so the line-level reconcile must not re-import it
   * (after a writeback that would delete every entry the compile did not select).
   */
  syncedTexts() {
    const raw = this.state.syncedText;
    let parsed = null;
    try {
      parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
      parsed = null;
    }
    const sides = {};
    if (parsed !== null && typeof parsed === 'object') {
      if (typeof parsed.agent === 'string') sides.agent = parsed.agent;
      if (typeof parsed.user === 'string') sides.user = parsed.user;
    }
    return sides;
  }

  /** The two settings boxes, read through the injected persona source (never throws). */
  readBoxes() {
    if (this.personaSource !== true) return { agent: '', user: '' };
    try {
      const stored = this.readPersona() ?? {};
      return {
        agent: typeof stored.agent === 'string' ? stored.agent : '',
        user: typeof stored.user === 'string' ? stored.user : '',
      };
    } catch {
      return { agent: '', user: '' };
    }
  }

  /** True once the boxes (not the snapshot) are the authoritative prompt for injection. */
  boxesAuthoritative() {
    return this.state.boxesAuthoritative === '1';
  }

  /** A UI save / organize wrote the boxes: injections must follow them from now on. */
  markBoxesAuthoritative() {
    this.writeStateSafe({ boxesAuthoritative: '1' });
  }

  /** Read one per-side flag map from `profile_maintain_state`; only explicit `true` counts. */
  readSideFlags(key) {
    let parsed = null;
    try {
      parsed = JSON.parse(String(this.state[key] ?? '{}'));
    } catch {
      parsed = null;
    }
    const flags = { agent: false, user: false };
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      if (parsed.agent === true) flags.agent = true;
      if (parsed.user === true) flags.user = true;
    }
    return flags;
  }

  /** Explicit still-to-be-imported flags written by `save` (a text box change is pending). */
  pendingFlags() {
    return this.readSideFlags('pending');
  }

  /**
   * A side the one-time seed imported into the library but no organize round has rewritten yet.
   * Persisted so a failed first split is retried after a restart instead of looking synced.
   */
  seededButUnorganizedFlags() {
    return this.readSideFlags('seededButUnorganized');
  }

  /** Mark a side the seed imported but not yet organized; cleared only by a successful writeback. */
  markSeededButUnorganized(sides = []) {
    const flags = this.seededButUnorganizedFlags();
    for (const side of SIDES) if (sides.includes(side)) flags[side] = true;
    this.writeStateSafe({ seededButUnorganized: flags });
    return flags;
  }

  /** Mark sides as saved-but-not-in-library. Returns the whole flag map. */
  markPending(sides = []) {
    const flags = this.pendingFlags();
    for (const side of SIDES) if (sides.includes(side)) flags[side] = true;
    this.writeStateSafe({ pending: flags });
    return flags;
  }

  /** Clear sides once a round has written them into the library and persisted the rewrite. */
  clearPending(sides = []) {
    const flags = this.pendingFlags();
    for (const side of SIDES) if (sides.includes(side)) flags[side] = false;
    this.writeStateSafe({ pending: flags });
    return flags;
  }

  /**
   * 「保存」: write the two boxes and nothing else. A side is explicitly marked pending, so the
   * next「立刻整理」imports it. No model call, no library row, no rewrite; a write failure restores
   * the previous box text.
   */
  save({ agent, user, trigger = 'settings' } = {}) {
    if (this.writePersona === null) return { ok: false, error: 'profile save: persona source unavailable' };
    const previous = this.readBoxes();
    const writes = [];
    try {
      for (const side of SIDES) {
        const text = side === 'agent' ? agent : user;
        if (typeof text !== 'string') continue;
        this.writePersona(side, text);
        writes.push(side);
      }
    } catch (error) {
      for (const side of writes) {
        try {
          this.writePersona(side, previous[side]);
        } catch {
          /* the original error is the one reported */
        }
      }
      return { ok: false, error: String(error?.message ?? error) };
    }
    const synced = this.syncedTexts();
    const changed = writes.filter((side) => cleanText(side === 'agent' ? agent : user) !== (synced[side] ?? ''));
    const pending = changed.length > 0 ? this.markPending(changed) : this.pendingFlags();
    this.markBoxesAuthoritative();
    this.emitNow(PROFILE_SAVE_EVENT, {
      sides: writes,
      chars: writes.reduce((sum, side) => sum + (side === 'agent' ? agent : user).length, 0),
      pending,
      trigger,
    });
    return { ok: true, saved: writes, pending: { agent: pending.agent, user: pending.user } };
  }

  /** Monotonic user-operation sequence; persisted in `profile_maintain_state`. */
  saveSeq() {
    const value = Number(this.state.saveSeq);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  }

  /**
   * Claim the next save sequence. Every save (and every organize request that first saves the
   * boxes) takes one, so a late model result can prove it still owns the newest user operation.
   */
  nextSaveSeq() {
    const value = this.saveSeq() + 1;
    this.writeStateSafe({ saveSeq: String(value) });
    return value;
  }

  /** True when a newer user operation landed after `seq` was claimed. */
  superseded(seq) {
    return this.saveSeq() !== seq;
  }

  /** Sides whose box text differs from the last synced text (an unsynced user edit). */
  pendingSides() {
    const boxes = this.readBoxes();
    const synced = this.syncedTexts();
    const flags = this.pendingFlags();
    const seeded = this.seededButUnorganizedFlags();
    const agent = flags.agent === true || seeded.agent === true
      || cleanText(boxes.agent) !== (synced.agent ?? '');
    const user = flags.user === true || seeded.user === true
      || cleanText(boxes.user) !== (synced.user ?? '');
    return { agent, user, boxes, synced };
  }

  /**
   * One cheap row read per prompt request, then an in-memory cache keyed by `(version, text)`:
   * the version bump written by every compile invalidates it. `text` guards a same-version
   * rewrite, so a stale block can never survive a changed snapshot.
   */
  readSnapshotCached() {
    let row;
    try {
      row = this.db.prepare('SELECT version, text FROM profile_snapshot WHERE id = ?').get('current');
    } catch {
      row = undefined;
    }
    if (row === undefined) {
      this.promptCache = null;
      return { version: 0, text: '' };
    }
    const version = Number(row.version) || 0;
    const text = String(row.text ?? '');
    if (this.promptCache !== null && this.promptCache.version === version && this.promptCache.text === text) {
      return this.promptCache;
    }
    this.promptCache = { version, text };
    return this.promptCache;
  }

  /** Event emission from a synchronous prompt render: never throws, never awaits. */
  emitNow(type, payload) {
    try {
      const pending = this.emit(type, payload);
      if (pending !== null && typeof pending === 'object' && typeof pending.catch === 'function') {
        pending.catch(() => {});
      }
    } catch {
      /* the event log is best-effort */
    }
  }

  /**
   * The block the system prompt's `assistant:profile` section renders. Once a save or a writeback
   * has made the boxes authoritative, the persona section already carries exactly those boxes, so
   * this section stays empty and the snapshot is used only as the `(entryId, text)` mapping. Before
   * that (legacy database, or a directly seeded snapshot) the compiled snapshot is injected as
   * before. Reports `profile.prompt.injected` / `profile.prompt.skipped`.
   */
  promptSection({ budget = PROFILE_PROMPT_BUDGET_TOKENS } = {}) {
    const snapshot = this.readSnapshotCached();
    if (this.boxesAuthoritative() && this.personaSource === true) {
      return { text: '', entries: 0, tokens: 0, skipped: null, version: snapshot.version };
    }
    const formatted = formatProfilePrompt(snapshot.text, { budget });
    if (formatted.skipped !== null) {
      this.emitNow(PROFILE_PROMPT_EVENTS.skipped, {
        reason: formatted.skipped,
        tokens: formatted.tokens,
        version: snapshot.version,
      });
    } else if (formatted.text.length > 0) {
      this.emitNow(PROFILE_PROMPT_EVENTS.injected, {
        entries: formatted.entries,
        tokens: formatted.tokens,
        version: snapshot.version,
      });
    }
    return { ...formatted, version: snapshot.version };
  }

  /**
   * Recompile immediately after a library mutation (edit / remove / revert / reject) and persist
   * the snapshot in the caller's transaction, so the next request already sees the new block.
   */
  compileNow({ trigger = 'manual' } = {}) {
    const at = this.at().toISOString();
    return this.profile.transact(() => {
      const previous = this.snapshot();
      const compiled = this.profile.compileRank({ config: this.rankConfig });
      const version = (Number(previous?.version) || 0) + 1;
      const tokens = Number(compiled.usedTokens) || 0;
      // A manual edit/remove must not rewrite the settings-box mapping: the line diff owns it.
      this.writeSnapshot(compiled.text, tokens, version, at, previous?.lines ?? []);
      this.setState({ snapshotVersion: version, snapshotAt: at, snapshotTrigger: String(trigger) });
      this.promptCache = null;
      return {
        version,
        tokens,
        entries: Array.isArray(compiled.selected) ? compiled.selected.length : 0,
      };
    });
  }

  /**
   * Version of the editable library. A user edit bumps `version`, a lock toggles `locked`, a
   * rejection adds a tombstone; any of those between read and commit aborts the round.
   */
  librarySignature() {
    const rows = this.db
      .prepare('SELECT id, version, locked, rejected, rank, clarity, efficacy FROM profile_entry ORDER BY id')
      .all();
    const rejects = this.db.prepare('SELECT COUNT(*) AS c FROM profile_reject').get().c;
    return createHash('sha256').update(JSON.stringify({ rows, rejects })).digest('hex').slice(0, 16);
  }

  /** Read-only state for the settings page / diagnostics. */
  status() {
    const at = this.at();
    const pending = this.pendingSides();
    return {
      running: this.running !== null,
      taskId: this.running?.taskId ?? this.queue?.taskId ?? null,
      queued: this.queue !== null,
      queue: this.queue === null ? null : {
        taskId: this.queue.taskId,
        trigger: this.queue.trigger,
        reason: this.queue.reason,
        requestedAt: this.queue.requestedAt,
      },
      lastTask: this.lastTask,
      due: this.isDue(at),
      intervalDays: Math.round((this.intervalMs / (24 * 60 * 60 * 1000)) * 100) / 100,
      lastRunAt: this.state.lastRunAt ?? null,
      lastStatus: this.state.lastStatus ?? null,
      lastSummary: this.state.lastSummary ?? null,
      lastError: this.state.lastError ?? null,
      cursor: this.state.cursor ?? null,
      retryAt: this.state.retryAt ?? null,
      saveSeq: this.saveSeq(),
      version: this.librarySignature(),
      // Box text that was saved but not yet imported/rewritten by an organize round.
      pending: { agent: pending.agent, user: pending.user },
      // The category stack with its live entry count (name/parent/count).
      categories: this.categorySummary(),
      snapshot: this.snapshot(),
      trial: this.personaTrialState(),
    };
  }

  isDue(at = this.at()) {
    const instant = at.getTime();
    // A failed/aborted round backs off even when no successful round exists yet.
    const retry = Date.parse(this.state.retryAt ?? '');
    if (Number.isFinite(retry) && instant < retry) return false;
    const last = Date.parse(this.state.lastRunAt ?? '');
    if (!Number.isFinite(last)) return true;
    // Boolean, not a count: a launch after three missed weeks catches up once, then waits.
    return instant >= last + this.intervalMs;
  }

  async busy() {
    return (await this.busyState()).busy;
  }

  /**
   * One structured busy read: `{busy, reason, snapshot}`. The injectable snapshot wins; the legacy
   * boolean `isBusy` can only report a generic `active-turn`. `organizing` is this maintainer's own
   * single-task lock, so a second manual click queues instead of racing.
   */
  async busyState() {
    // A queued manual request is this maintainer's own pending work: the schedule must not jump
    // ahead of it, and a second manual click is rejected by the single queue slot.
    const organizing = this.running !== null || this.queue !== null;
    let raw = null;
    if (this.busySnapshot !== null) {
      try {
        raw = await this.busySnapshot();
      } catch {
        raw = null;
      }
    }
    if (raw !== null && typeof raw === 'object') {
      const snapshot = normalizeBusySnapshot(raw);
      const reason = organizing ? 'organizing' : busyReasonOf(snapshot);
      return { busy: reason !== null, reason, snapshot: { ...snapshot, organizing } };
    }
    let flag = false;
    try {
      flag = (await this.isBusy()) === true;
    } catch {
      flag = false;
    }
    return {
      busy: flag || organizing,
      reason: organizing ? 'organizing' : (flag ? 'active-turn' : null),
      snapshot: {
        activeChatTurns: [],
        playback: null,
        voiceTurn: null,
        playing: false,
        pendingVoice: { size: 0, cancelledOnly: false },
        fastPath: false,
        organizing,
      },
    };
  }

  /** Legacy voice-only probe; the structured snapshot is the primary source. */
  async voiceBusy() {
    if (this.isVoiceBusy !== null) {
      try {
        return (await this.isVoiceBusy()) === true;
      } catch {
        return false;
      }
    }
    const state = await this.busyState();
    return state.snapshot.playback !== null
      || state.snapshot.voiceTurn !== null
      || state.snapshot.pendingVoice.size > 0;
  }

  /**
   * A manual round can run beside a chat/fast-path turn (they do not write the profile tables),
   * but not beside another organizing round, playback, or a queued voice line.
   */
  canRunAlongside(state) {
    return this.running === null
      && state.snapshot.playback === null
      && state.snapshot.voiceTurn === null
      && state.snapshot.pendingVoice.size === 0;
  }

  nextTaskId() {
    this.taskSeq += 1;
    return `pm-${Date.now().toString(36)}-${this.taskSeq}`;
  }

  /** Start the one-shot queue poll; the timer is unref'd so it never keeps the process alive. */
  ensureQueueTimer() {
    if (this.queueTimer !== null) return;
    this.queueTimer = setInterval(() => {
      void this.drainQueue();
    }, this.queuePollMs);
    this.queueTimer.unref?.();
  }

  clearQueueTimer() {
    if (this.queueTimer !== null) clearInterval(this.queueTimer);
    this.queueTimer = null;
  }

  /** Queue one manual request; a second queued request is rejected (single-task limit). */
  queueManual({ trigger, expectedVersion, writeBack, full, reason, snapshot }) {
    if (this.queue !== null) {
      return {
        ok: false,
        status: 'rejected',
        reason: 'queue-full',
        busy: snapshot,
        queuedTaskId: this.queue.taskId,
      };
    }
    const taskId = this.nextTaskId();
    this.queue = {
      taskId,
      trigger,
      expectedVersion,
      writeBack,
      full,
      status: 'queued',
      reason,
      requestedAt: this.at().toISOString(),
      snapshot,
    };
    this.ensureQueueTimer();
    return { ok: true, status: 'queued', taskId, ran: false, deferred: true, reason, busy: snapshot };
  }

  /**
   * Run the queued request once the blocker clears. Called from a `run()` completion and by the
   * queue poll; it re-reads the busy snapshot, so a voice queue that is still playing keeps it
   * queued instead of starting a competing round.
   */
  async drainQueue() {
    if (this.queue === null || this.running !== null) return null;
    const state = await this.busyState();
    // A concurrent drain (run completion + queue poll) may have taken the slot while we awaited.
    if (this.queue === null || this.running !== null) return null;
    if (!this.canRunAlongside(state)) {
      this.ensureQueueTimer();
      return null;
    }
    const task = this.queue;
    this.queue = null;
    this.clearQueueTimer();
    task.status = 'running';
    task.startedAt = this.at().toISOString();
    this.lastTask = task;
    this.activeQueuedTask = task;
    void this.run({
      trigger: task.trigger,
      expectedVersion: task.expectedVersion,
      writeBack: task.writeBack,
      full: task.full,
      taskId: task.taskId,
    }).then((result) => {
      task.result = result;
      task.status = result?.reason === 'cancelled'
        ? 'cancelled'
        : (result?.ok === false ? 'failed' : 'completed');
    }).catch((error) => {
      task.status = 'failed';
      task.error = String(error?.message ?? error);
    }).finally(() => {
      if (this.activeQueuedTask === task) this.activeQueuedTask = null;
      task.finishedAt = this.at().toISOString();
      this.notifyIdle();
    });
    return task;
  }

  /** Cancel a queued or currently running task. The run path settles as `cancelled`. */
  cancel(taskId) {
    const id = cleanText(taskId);
    if (id.length === 0) return { ok: false, status: 'rejected', reason: 'missing-task' };
    if (this.queue !== null && this.queue.taskId === id) {
      const task = this.queue;
      this.queue = null;
      this.clearQueueTimer();
      task.status = 'cancelled';
      task.finishedAt = this.at().toISOString();
      this.lastTask = task;
      this.notifyIdle();
      return { ok: true, status: 'cancelled', taskId: id };
    }
    if (this.running !== null && this.running.taskId === id) {
      this.activeController?.abort();
      return { ok: true, status: 'cancelled', taskId: id, running: true };
    }
    return { ok: false, status: 'rejected', reason: 'unknown-task' };
  }

  /** Resolves when no round is running and no request is queued (tests, settings page). */
  waitForIdle() {
    if (this.running === null && this.queue === null) return Promise.resolve();
    return new Promise((resolve) => {
      this.idleWaiters.push(resolve);
    });
  }

  notifyIdle() {
    if (this.running !== null || this.queue !== null) return;
    const waiters = this.idleWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  async emitSafe(type, payload) {
    try {
      await this.emit(type, payload);
    } catch {
      /* the event log is best-effort */
    }
  }

  /**
   * `profile.compose.merge {left, right, reason}` at debug level: which pair was merged and why
   * (`identical` / `same-condition` / `no-condition`), so a wrong merge can be audited afterwards.
   * Throttled to one window per instance and a few rows per window; never carries prompt text.
   */
  async logComposeMerges(side, merges) {
    const rows = (Array.isArray(merges) ? merges : [])
      .filter((merge) => merge !== null && typeof merge === 'object');
    if (rows.length === 0) return;
    const at = this.at().getTime();
    if (at - this.composeMergeAt < PROFILE_COMPOSE_MERGE_THROTTLE_MS) return;
    this.composeMergeAt = at;
    for (const merge of rows.slice(0, PROFILE_COMPOSE_MERGE_LOG_LIMIT)) {
      await this.emitSafe(PROFILE_COMPOSE_EVENTS.merge, {
        level: 'debug',
        side,
        left: cleanText(merge.left),
        right: cleanText(merge.right),
        reason: cleanText(merge.reason),
      });
    }
  }

  /** Start the periodic, unref'd idle check. Safe to call more than once. */
  start({ tickMs = this.tickMs, runOnStart = true, startDelayMs = 15_000 } = {}) {
    if (this.timer !== null) return this;
    this.timer = setInterval(() => {
      void this.tick();
    }, positiveInt(tickMs, this.tickMs));
    this.timer.unref?.();
    if (runOnStart) {
      this.startTimer = setTimeout(() => {
        this.startTimer = null;
        void this.tick();
      }, Math.max(0, Number(startDelayMs) || 0));
      this.startTimer.unref?.();
    }
    return this;
  }

  dispose() {
    if (this.timer !== null) clearInterval(this.timer);
    if (this.startTimer !== null) clearTimeout(this.startTimer);
    this.timer = null;
    this.startTimer = null;
    this.clearQueueTimer();
    if (this.queue !== null) {
      this.queue.status = 'cancelled';
      this.queue.finishedAt = this.at().toISOString();
      this.lastTask = this.queue;
      this.queue = null;
    }
    this.activeController?.abort();
    this.activeController = null;
    this.notifyIdle();
  }

  /**
   * Scheduled wake-up: skip while a turn runs, defer while busy, and run once when due.
   * A catch-up is one round; afterwards `lastRunAt` moves to now, so missed weeks are not replayed.
   */
  async tick() {
    if (this.running !== null) return { ok: false, ran: false, reason: 'running' };
    const at = this.at();
    if (!this.isDue(at)) {
      // A once-an-hour audit line keeps a 10-minute poller from flooding the event log.
      if (at.getTime() - this.lastNotDueAt >= 60 * 60 * 1000) {
        this.lastNotDueAt = at.getTime();
        await this.emitSafe(PROFILE_MAINTAIN_EVENTS.skipped, { trigger: 'schedule', reason: 'not-due' });
      }
      return { ok: true, ran: false, reason: 'not-due' };
    }
    const state = await this.busyState();
    if (state.busy) {
      const reason = state.reason ?? 'active-turn';
      if (this.state.deferredAt === undefined || this.state.deferredAt === null
        || this.state.busyReason !== reason) {
        this.writeStateSafe({ deferredAt: at.toISOString(), lastStatus: 'deferred', busyReason: reason });
        await this.emitSafe(PROFILE_MAINTAIN_EVENTS.busy, {
          trigger: 'schedule',
          reason,
          snapshot: state.snapshot,
        });
      }
      return { ok: true, ran: false, deferred: true, reason, busy: state.snapshot };
    }
    return this.run({ trigger: 'schedule' });
  }

  /**
   * Manual "organize now": accepted immediately. A chat/fast-path turn does not share the profile
   * tables, so the round runs beside it; another organizing round, playback, or a queued voice line
   * makes it wait in the single queue slot instead of racing. A second queued click is rejected.
   */
  async now({ trigger = 'manual', expectedVersion = null, writeBack = false, full = null } = {}) {
    const state = await this.busyState();
    if (this.queue !== null) {
      await this.emitSafe(PROFILE_MAINTAIN_EVENTS.busy, {
        trigger,
        reason: 'organizing',
        snapshot: state.snapshot,
        queued: false,
        queueFull: true,
      });
      return this.queueManual({
        trigger,
        expectedVersion,
        writeBack,
        full,
        reason: 'organizing',
        snapshot: state.snapshot,
      });
    }
    if (!this.canRunAlongside(state)) {
      const reason = state.reason === 'organizing'
        ? 'organizing'
        : ((state.snapshot.playback !== null || state.snapshot.voiceTurn !== null) ? 'playing' : 'pending-voice');
      await this.emitSafe(PROFILE_MAINTAIN_EVENTS.busy, {
        trigger,
        reason,
        snapshot: state.snapshot,
        queued: this.queue === null,
        queueFull: this.queue !== null,
      });
      return this.queueManual({ trigger, expectedVersion, writeBack, full, reason, snapshot: state.snapshot });
    }
    const taskId = this.nextTaskId();
    const result = await this.run({ trigger, expectedVersion, writeBack, full, taskId });
    if (result?.reason === 'running') {
      // A simultaneous click won the lock: this request queues rather than disappearing.
      return this.queueManual({
        trigger,
        expectedVersion,
        writeBack,
        full,
        reason: 'organizing',
        snapshot: state.snapshot,
      });
    }
    return { ...result, status: 'running', taskId };
  }

  /**
   * Entry point for both round kinds. A manual「立刻整理」on a wired box runs the complete
   * organize flow (split → library → compile → rewrite → write back); the 7-day schedule only
   * consumes new conversation and never imports a pending box.
   */
  async run({ trigger = 'schedule', expectedVersion = null, writeBack = false, full = null, taskId = null } = {}) {
    if (trigger !== 'schedule' && this.personaSource === true && full !== false) {
      return this.organize({ trigger, expectedVersion, taskId });
    }
    return this.runIncremental({ trigger, expectedVersion, writeBack, taskId });
  }

  async runIncremental({ trigger = 'schedule', expectedVersion = null, writeBack = false, taskId = null } = {}) {
    if (this.running !== null) return { ok: false, ran: false, reason: 'running' };
    const at = this.at();
    const until = at.toISOString();
    let signature = this.librarySignature();
    if (expectedVersion !== null && expectedVersion !== undefined && String(expectedVersion) !== signature) {
      await this.emitSafe(PROFILE_MAINTAIN_EVENTS.aborted, { trigger, reason: 'user-edited' });
      return { ok: false, ran: false, aborted: true, reason: 'user-edited' };
    }
    this.running = { trigger, startedAt: until, taskId };
    const controller = new AbortController();
    this.activeController = controller;
    const signal = controller.signal;
    // A pause/unload aborts the controller; every async boundary re-checks before writing anything.
    const cancelled = async () => {
      await this.emitSafe(PROFILE_MAINTAIN_EVENTS.aborted, { trigger, reason: 'cancelled' });
      return { ok: false, ran: false, reason: 'cancelled' };
    };
    try {
      await this.emitSafe(PROFILE_MAINTAIN_EVENTS.started, { trigger, at: until });
      // First boot folds the existing settings-box text into the library line by line (no model
      // split). A periodic round then reads new conversation only: a pending box edit belongs to
      // an explicit「立刻整理」and must never be auto-imported here.
      const seeded = this.ensureSeeded({ signal });
      if (signal.aborted) return await cancelled();
      signature = this.librarySignature();
      // Text the round began with. A save during extraction changes it, so the writeback can tell
      // that the newer user operation owns the box and must not be overwritten.
      const roundBoxes = this.readBoxes();
      const cursor = this.readCursor();
      const messages = await this.readBatch({ cursor, until, signal });
      if (signal.aborted) return await cancelled();
      if (messages.length === 0) {
        const skipped = await this.skipCycle({ until, trigger, reason: 'no-new-content' });
        return { ...skipped, import: seeded.imported ?? 0 };
      }

      await this.emitSafe(PROFILE_MAINTAIN_EVENTS.progress, { trigger, stage: 'extract', messages: messages.length });
      const extracted = await this.extract({
        messages,
        existing: this.existingSummaries(),
        since: cursor?.ts ?? null,
        until,
        signal,
      });
      if (signal.aborted) return await cancelled();
      const candidates = parseExtractCandidates(extracted);
      await this.emitSafe(PROFILE_MAINTAIN_EVENTS.progress, {
        trigger,
        stage: 'validate',
        candidates: candidates.length,
      });
      if (signal.aborted) return await cancelled();
      // A candidate is a model output too: a copied 「我」 (user side) or 「用户」 (agent side) is
      // repaired once, or fallen back, before it can become a library entry.
      const tonedCandidates = await this.enforceExtractTone({ candidates, signal });
      if (signal.aborted) return await cancelled();
      // A round with a new exchange still runs the rank/decay pipeline even when the extractor
      // found nothing to add: unmentioned, unselected entries decay once, selected ones do not.
      const result = this.commit({ candidates: tonedCandidates, messages, until, trigger, signature });
      for (const move of result.splitMoves ?? []) {
        if (move.moved !== true) continue;
        this.emitNow(PROFILE_SPLIT_EVENTS.moved, {
          text: move.text,
          category: move.category,
          fromSide: move.fromSide,
          toSide: move.toSide,
          moved: true,
        });
      }
      await this.emitSafe(PROFILE_EXTRACT_EVENT, {
        agentEntries: result.sideCounts.agent,
        userEntries: result.sideCounts.user,
        modelCalls: 1,
      });
      await this.emitSafe(PROFILE_MAINTAIN_EVENTS.summary, { trigger, at: until, ...result.summary });
      // A real exchange round always writes the composed prompt back into the boxes.
      await this.writeBack({ trigger, sections: result.sections, signal, startBoxes: roundBoxes });
      return {
        ok: true,
        ran: true,
        reason: 'new-content',
        summary: result.summary,
        snapshotVersion: result.snapshotVersion,
        version: result.version,
        import: seeded.imported ?? 0,
      };
    } catch (error) {
      if (signal.aborted) return await cancelled();
      if (error?.code === 'PROFILE_USER_EDITED') {
        this.writeStateSafe({
          lastStatus: 'aborted',
          lastError: 'user-edited',
          retryAt: new Date(at.getTime() + this.retryMs).toISOString(),
          deferredAt: null,
        });
        await this.emitSafe(PROFILE_MAINTAIN_EVENTS.aborted, { trigger, reason: 'user-edited' });
        return { ok: false, ran: false, aborted: true, reason: 'user-edited' };
      }
      const message = String(error?.message ?? error);
      this.writeStateSafe({
        lastStatus: 'failed',
        lastError: message,
        retryAt: new Date(at.getTime() + this.retryMs).toISOString(),
        deferredAt: null,
      });
      await this.emitSafe(PROFILE_MAINTAIN_EVENTS.failed, { trigger, error: message });
      return { ok: false, ran: false, error: message };
    } finally {
      const queuedRun = this.activeQueuedTask !== null;
      this.running = null;
      this.activeController = null;
      // A queued manual request starts only after this round has released the lock.
      if (this.queue !== null) queueMicrotask(() => { void this.drainQueue(); });
      else if (!queuedRun) this.notifyIdle();
      // A queued run's own completion handler notifies once its task record is final.
    }
  }

  /**
   * Complete organize round for the settings card:
   *   box text → agent split → library update → compile → agent rewrite → write back + save.
   * Every model call happens BEFORE the one write transaction, so a split/extract failure leaves
   * the library, the boxes and the snapshot untouched. A failed rewrite is NOT a failure: the
   * deterministic compiled section is written back instead (`profile.compose.failed`). A pending
   * side is only marked synced once the writeback has persisted the rewritten text.
   */
  async organize({ trigger = 'settings', expectedVersion = null, taskId = null } = {}) {
    if (this.running !== null) return { ok: false, ran: false, reason: 'running' };
    const at = this.at();
    const until = at.toISOString();
    const signature = this.librarySignature();
    if (expectedVersion !== null && expectedVersion !== undefined && String(expectedVersion) !== signature) {
      await this.emitSafe(PROFILE_MAINTAIN_EVENTS.aborted, { trigger, reason: 'user-edited' });
      return { ok: false, ran: false, aborted: true, reason: 'user-edited' };
    }
    this.running = { trigger, startedAt: until, taskId };
    const controller = new AbortController();
    this.activeController = controller;
    const signal = controller.signal;
    const cancelled = async () => {
      await this.emitSafe(PROFILE_MAINTAIN_EVENTS.aborted, { trigger, reason: 'cancelled' });
      return { ok: false, ran: false, reason: 'cancelled' };
    };
    try {
      await this.emitSafe(PROFILE_MAINTAIN_EVENTS.started, { trigger, at: until });
      // The one-time seed below may import this text into an empty library and mark it synced,
      // which `pendingSides()` alone would then call unchanged. The persisted marker keeps it
      // unorganized until the writeback below succeeds.
      const seeded = this.ensureSeeded({ signal });
      if (signal.aborted) return await cancelled();
      const startBoxes = this.readBoxes();
      const pending = this.pendingSides();
      // A library this round just created from the box is not a synced box: the seeded sides are
      // still unorganized content, so the first「立刻整理」must split → library → rewrite → write back.
      // The marker also covers an earlier failed first round, and survives a restart.
      const seededSides = this.seededButUnorganizedFlags();
      const changed = {
        agent: pending.agent === true || seededSides.agent,
        user: pending.user === true || seededSides.user,
      };
      const boxChanged = changed.agent || changed.user;
      // Phase 1 — both model steps first; nothing is written while they wait.
      let plan = null;
      if (boxChanged) {
        // Both boxes are read and handed to the model together; the model routes by semantics.
        plan = await this.planSplit({
          agent: startBoxes.agent,
          user: startBoxes.user,
          changed,
          trigger,
          signal,
        });
        if (signal.aborted) return await cancelled();
        if (plan.ok !== true) return { ...plan.result, ran: false, reason: plan.result.reason ?? 'split-failed' };
      }
      const cursor = this.readCursor();
      const messages = await this.readBatch({ cursor, until, signal });
      if (signal.aborted) return await cancelled();
      let tonedCandidates = [];
      if (messages.length > 0) {
        await this.emitSafe(PROFILE_MAINTAIN_EVENTS.progress, { trigger, stage: 'extract', messages: messages.length });
        const extracted = await this.extract({
          messages,
          existing: this.existingSummaries(),
          since: cursor?.ts ?? null,
          until,
          signal,
        });
        if (signal.aborted) return await cancelled();
        const candidates = parseExtractCandidates(extracted);
        await this.emitSafe(PROFILE_MAINTAIN_EVENTS.progress, {
          trigger,
          stage: 'validate',
          candidates: candidates.length,
        });
        tonedCandidates = await this.enforceExtractTone({ candidates, signal });
        if (signal.aborted) return await cancelled();
      }
      if (!boxChanged && messages.length === 0) {
        const skipped = await this.skipCycle({ until, trigger, reason: 'no-new-content' });
        return { ...skipped, import: seeded.imported ?? 0 };
      }
      // Phase 2 — one transaction for every library/snapshot write. A throw rolls all of it back,
      // and the boxes were not touched yet, so the round leaves no half-organized state.
      let splitOutcome = null;
      let roundOutcome = null;
      let secondMoves = [];
      try {
        this.profile.transact(() => {
          if (plan !== null && this.superseded(plan.saveSeq)) {
            const error = new Error('profile organize superseded');
            error.code = 'PROFILE_SUPERSEDED';
            throw error;
          }
          if (plan !== null) {
            splitOutcome = this.commitSplit({
              planned: plan.planned,
              trigger,
              categoryOps: plan.categoryOps,
              moves: plan.moves,
            });
          }
          if (messages.length > 0) {
            roundOutcome = this.commit({
              candidates: tonedCandidates,
              messages,
              until,
              trigger,
              signature: this.librarySignature(),
            });
            secondMoves = roundOutcome.splitMoves ?? [];
          } else if (plan !== null) {
            // No exchange: the second side pass still runs before the compile below, inside the
            // same transaction as the split write.
            secondMoves = this.applySecondSplit();
          }
        });
      } catch (error) {
        if (error?.code === 'PROFILE_SUPERSEDED') {
          await this.emitSafe(PROFILE_SPLIT_EVENTS.aborted, { trigger, reason: 'superseded' });
          return { ok: false, ran: false, aborted: true, reason: 'superseded' };
        }
        throw error;
      }
      if (signal.aborted) return await cancelled();
      // The category/move record is reported only after the transaction above committed.
      if (plan !== null) {
        for (const event of plan.categoryEvents) this.emitNow(event.type, event.payload);
        for (const move of plan.moves) this.emitNow(PROFILE_SPLIT_EVENTS.moved, move);
      }
      for (const move of secondMoves) {
        if (move.moved !== true) continue;
        this.emitNow(PROFILE_SPLIT_EVENTS.moved, {
          text: move.text,
          category: move.category,
          fromSide: move.fromSide,
          toSide: move.toSide,
          moved: true,
        });
        if (move.reason === 'misplaced-rule') {
          this.emitNow(PROFILE_RECLASSIFY_EVENTS.misplaced, {
            entryId: move.entryId,
            fromSide: move.fromSide,
            toSide: move.toSide,
            reason: 'user-self-description',
          });
        }
      }
      // Phase 3 — compile sections, rewrite, write back and persist. The planned box text is the
      // tone reference; the disk text is still the pre-round one, so a newer save is detected.
      const sections = roundOutcome !== null
        ? roundOutcome.sections
        : (splitOutcome !== null ? this.previewSections() : []);
      const plannedTexts = {};
      if (plan !== null) for (const item of plan.planned) plannedTexts[item.side] = item.text;
      const touchedAfter = plan !== null ? { ...plan.touched } : { agent: false, user: false };
      // New conversation content (a new/updated entry, or a cross-side move) is a real change even
      // when the user never touched the box: rewrite that side so the new fact is visible.
      for (const side of roundOutcome !== null ? (roundOutcome.changedSides ?? []) : []) {
        touchedAfter[side] = true;
      }
      for (const move of secondMoves) {
        touchedAfter[move.fromSide] = true;
        touchedAfter[move.toSide] = true;
      }
      const written = await this.writeBack({
        trigger,
        sections,
        signal,
        startBoxes: startBoxes,
        effectiveBoxes: {
          agent: plannedTexts.agent ?? startBoxes.agent,
          user: plannedTexts.user ?? startBoxes.user,
        },
        // Only the sides this round really changed are rewritten; an unchanged box keeps its
        // original text verbatim (a side nobody touched is `pending: true` = skipped).
        pendingOverride: {
          agent: touchedAfter.agent !== true,
          user: touchedAfter.user !== true,
        },
      });
      if (signal.aborted) return await cancelled();
      if (messages.length === 0) {
        const reason = boxChanged
          ? ((seededSides.agent || seededSides.user) ? 'initial' : 'box-changed')
          : 'no-new-content';
        const cycle = await this.skipCycle({ until, trigger, reason, ran: boxChanged, emit: false });
        return { ...cycle, import: seeded.imported ?? 0, split: splitOutcome, writeback: written };
      }
      await this.emitSafe(PROFILE_EXTRACT_EVENT, {
        agentEntries: roundOutcome.sideCounts.agent,
        userEntries: roundOutcome.sideCounts.user,
        modelCalls: 1,
      });
      await this.emitSafe(PROFILE_MAINTAIN_EVENTS.summary, { trigger, at: until, ...roundOutcome.summary });
      return {
        ok: true,
        ran: true,
        reason: boxChanged ? 'both' : 'new-content',
        summary: roundOutcome.summary,
        snapshotVersion: roundOutcome.snapshotVersion,
        version: roundOutcome.version,
        import: seeded.imported ?? 0,
        split: splitOutcome,
        writeback: written,
      };
    } catch (error) {
      if (signal.aborted) return await cancelled();
      if (error?.code === 'PROFILE_USER_EDITED') {
        this.writeStateSafe({
          lastStatus: 'aborted',
          lastError: 'user-edited',
          retryAt: new Date(at.getTime() + this.retryMs).toISOString(),
          deferredAt: null,
        });
        await this.emitSafe(PROFILE_MAINTAIN_EVENTS.aborted, { trigger, reason: 'user-edited' });
        return { ok: false, ran: false, aborted: true, reason: 'user-edited' };
      }
      const message = String(error?.message ?? error);
      this.writeStateSafe({
        lastStatus: 'failed',
        lastError: message,
        retryAt: new Date(at.getTime() + this.retryMs).toISOString(),
        deferredAt: null,
      });
      await this.emitSafe(PROFILE_MAINTAIN_EVENTS.failed, { trigger, error: message });
      return { ok: false, ran: false, reason: 'commit-failed', error: message };
    } finally {
      const queuedRun = this.activeQueuedTask !== null;
      this.running = null;
      this.activeController = null;
      if (this.queue !== null) queueMicrotask(() => { void this.drainQueue(); });
      else if (!queuedRun) this.notifyIdle();
    }
  }

  /**
   * Read one round's messages page by page. The probe's `after` key is the stable `(ts, id)`
   * boundary, so a page limit can never lose a message that shares the boundary millisecond and
   * the message after the limit is read on the next round. A source that ignores `after` is
   * handled defensively: ids already collected are dropped and a page with no new row ends it.
   */
  async readBatch({ cursor = null, until, signal } = {}) {
    const limit = positiveInt(this.maxMessages, PROFILE_MAINTAIN_MESSAGE_LIMIT);
    const pageSize = Math.max(1, Math.min(PROFILE_MAINTAIN_PAGE_SIZE, limit));
    const collected = [];
    const seen = new Set();
    let after = cursor;
    while (collected.length < limit) {
      const want = Math.min(pageSize, limit - collected.length);
      const rawPage = await this.readMessages({ since: cursor?.ts ?? null, until, limit: want, after });
      if (signal?.aborted) return collected;
      const page = (Array.isArray(rawPage) ? rawPage : [])
        .map(normalizeMessage)
        .filter((message) => message !== null)
        .sort(compareMessageKeys);
      let fresh = 0;
      for (const message of page) {
        if (seen.has(message.id) || atOrBeforeCursor(after, message)) continue;
        seen.add(message.id);
        collected.push(message);
        fresh += 1;
        if (collected.length >= limit) break;
      }
      const last = page.length > 0 ? page[page.length - 1] : null;
      if (last !== null) after = { ts: last.ts, id: last.id };
      if (fresh === 0 || page.length < want) break;
    }
    return collected;
  }

  /** Complete a cycle with no message work: move the cursor/period but do not touch the snapshot. */
  async skipCycle({ until, trigger, reason, ran = false, emit = true }) {
    this.writeStateSafe({
      lastRunAt: until,
      cursor: formatCursor(until),
      lastStatus: ran ? 'ok' : 'skipped',
      lastSummary: ZERO_SUMMARY,
      lastError: null,
      retryAt: null,
      deferredAt: null,
    });
    if (emit) await this.emitSafe(PROFILE_MAINTAIN_EVENTS.skipped, { trigger, reason });
    return { ok: true, ran, reason };
  }

  existingSummaries() {
    try {
      return this.profile.list().map((entry) => ({
        id: entry.id,
        side: entry.side,
        category: entry.category,
        text: entry.text,
      }));
    } catch {
      return [];
    }
  }

  /**
   * One-time seed on first launch (or first organizing round): when the library is empty and the
   * existing settings-box text is not, reconcile that text line by line and mark the new lines as
   * `original`. This replaces the old model split: no prompt is resent to a model, and nothing
   * here becomes support evidence.
   */
  ensureSeeded({ signal } = {}) {
    if (typeof this.state.legacyImportAt === 'string' && this.state.legacyImportAt.length > 0) {
      return { imported: 0, skipped: 'already-imported' };
    }
    let existing = [];
    try {
      existing = this.profile.list();
    } catch {
      return { imported: 0, skipped: 'unavailable' };
    }
    if (existing.length > 0) return { imported: 0, skipped: 'non-empty' };
    let stored;
    try {
      stored = this.readPersona() ?? {};
    } catch {
      return { imported: 0, skipped: 'unavailable' };
    }
    const agent = cleanText(stored.agent);
    const user = cleanText(stored.user);
    if (agent.length === 0 && user.length === 0) return { imported: 0, skipped: 'no-text' };
    // A side the user explicitly saved but has not organized yet is pending, never legacy seed
    // material: importing it here would bypass the split/rewrite flow.
    const pending = this.pendingFlags();
    if (pending.agent && pending.user) return { imported: 0, skipped: 'pending' };
    if (signal?.aborted) return { imported: 0, skipped: 'cancelled' };
    const result = this.reconcile({
      agent: pending.agent ? undefined : agent,
      user: pending.user ? undefined : user,
      trigger: 'seed',
    });
    if (result.ok !== true) return { imported: 0, failed: result.reason ?? result.error ?? 'reconcile-failed' };
    this.writeStateSafe({ legacyImportAt: this.at().toISOString() });
    if ((result.added ?? 0) > 0) {
      const seeded = SIDES.filter((side) => {
        const isPending = side === 'agent' ? pending.agent : pending.user;
        return isPending !== true && (side === 'agent' ? agent : user).length > 0;
      });
      if (seeded.length > 0) this.markSeededButUnorganized(seeded);
      this.emitNow(PROFILE_IMPORT_EVENTS.done, {
        source: 'reconcile',
        imported: result.added,
        snapshotVersion: result.snapshotVersion,
      });
    }
    return { imported: result.added ?? 0, version: result.snapshotVersion, added: result.added ?? 0 };
  }

  /** Apply the user's edits in the two settings boxes before the automatic part of a round. */
  reconcileFromSettings({ trigger = 'schedule' } = {}) {
    const empty = { added: 0, updated: 0, removed: 0, unchanged: 0, ignored: 0 };
    if (this.personaSource !== true) return { ok: true, ran: false, skipped: 'no-source', ...empty };
    let stored;
    try {
      stored = this.readPersona() ?? {};
    } catch {
      return { ok: false, ran: false, reason: 'persona-unavailable', ...empty };
    }
    try {
      return this.reconcile({
        agent: typeof stored.agent === 'string' ? stored.agent : '',
        user: typeof stored.user === 'string' ? stored.user : '',
        trigger,
      });
    } catch (error) {
      const message = String(error?.message ?? error);
      this.emitNow(PROFILE_RECONCILE_EVENTS.failed, { error: message });
      return { ok: false, ran: false, error: message, ...empty };
    }
  }

  /**
   * Baseline C/E for a newly added line: the average of the same side's current `original`
   * entries, taken before this save's additions/edits/removals touch the library. Average (not
   * max) keeps a single high outlier from inflating every future line: (60,40)+(90,80) → (75,60).
   */
  originalAverage(side) {
    let clarity = 0;
    let efficacy = 0;
    let count = 0;
    try {
      for (const entry of this.profile.list({ side })) {
        if (entry.rank !== 'original') continue;
        clarity += entry.clarity;
        efficacy += entry.efficacy;
        count += 1;
      }
    } catch {
      /* an unreadable library falls back to the neutral score */
    }
    if (count === 0) {
      return { clarity: PROFILE_RECONCILE_DEFAULT_CLARITY, efficacy: PROFILE_RECONCILE_DEFAULT_EFFICACY };
    }
    return { clarity: Math.round(clarity / count), efficacy: Math.round(efficacy / count) };
  }

  /**
   * Evidence boundaries of deleted tendencies, keyed by `ProfileStore.fingerprint`. A boundary is
   * not a permanent ban (no `profile_reject` tombstone): it only says which messages existed when
   * the user deleted that tendency, so a backlog read after the delete cannot rebuild it. A message
   * created after the boundary still counts. The map is capped so years of deletes cannot grow the
   * state row without limit; evicting an old boundary only weakens that one old tendency.
   */
  deletionBoundaries() {
    let parsed = null;
    try {
      parsed = JSON.parse(String(this.state.deletions ?? '{}'));
    } catch {
      parsed = null;
    }
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  }

  /** Record the evidence boundary of one entry, then delete it (the store owns the hard delete). */
  removeEntry(entryId) {
    return this.profile.transact(() => {
      this.recordDeletion(entryId);
      return this.profile.remove(entryId);
    });
  }

  /** Capture `(deletedAt, supporting message ids)` for one live entry before it is removed. */
  recordDeletion(entryId) {
    try {
      const entry = this.profile.get(entryId);
      if (entry === null) return;
      const at = this.at().toISOString();
      let evidenceIds = [];
      try {
        evidenceIds = this.profile.evidence(entryId)
          .map((row) => row.message_id)
          .filter((id) => id !== null && id !== undefined && String(id).length > 0)
          .map(String);
      } catch {
        /* an unreadable evidence table still leaves the time boundary */
      }
      const boundary = this.deletionBoundaries();
      const key = this.profile.fingerprint(entry.side, entry.text);
      const previous = boundary[key];
      boundary[key] = {
        at,
        ids: [...new Set([...(Array.isArray(previous?.ids) ? previous.ids : []), ...evidenceIds])],
      };
      const kept = Object.entries(boundary)
        .sort((left, right) => String(right[1]?.at ?? '').localeCompare(String(left[1]?.at ?? '')))
        .slice(0, 128);
      this.writeStateSafe({ deletions: Object.fromEntries(kept) });
    } catch {
      /* deleting the entry must still work when the boundary cannot be persisted */
    }
  }

  /** True when this message existed at/before the delete, so it must not rebuild that tendency. */
  blockedByDeletion(message, boundary) {
    if (boundary === null || boundary === undefined) return false;
    if (Array.isArray(boundary.ids) && boundary.ids.includes(String(message.id))) return true;
    const deletedAt = Date.parse(boundary.at ?? '');
    const messageAt = Date.parse(message.ts ?? '');
    return Number.isFinite(deletedAt) && Number.isFinite(messageAt) && messageAt <= deletedAt;
  }

  /**
   * Difference reconciliation between the settings boxes and the saved `(entryId, text)` mapping:
   *   same text (format/order ignored) → keep entry, scores and evidence untouched;
   *   a line within the similarity threshold → update only the entry text, keep rank/C/E/supports;
   *   a new line → a new `original` entry at the same-side original maxima (default 50/50);
   *   a missing line → delete the entry outright (no tombstone, so new evidence can rebuild it).
   * No line ever becomes support evidence and no prompt text is written into the memory tables.
   * When nothing but the mapping changes (first adoption), only the mapping/snapshot is written.
   *
   * @returns {{ok: boolean, ran: boolean, added: number, updated: number, removed: number,
   *            unchanged: number, ignored: number, snapshotVersion?: number, aborted?: boolean}}
   */
  reconcile({ agent, user, trigger = 'settings', expectedVersion = null, signal } = {}) {
    const empty = { added: 0, updated: 0, removed: 0, unchanged: 0, ignored: 0 };
    if (signal?.aborted) return { ok: false, ran: false, reason: 'cancelled', ...empty };
    // A side already saved through the model split owns its own fragments: line-diffing the prose
    // against them would destroy the split. Only never-split sides keep the deterministic path.
    // A side whose box text equals the last synced text has no pending user edit: re-importing it
    // would delete every entry the last compile did not select. Only changed sides are reconciled.
    const synced = this.syncedTexts();
    const inputs = [];
    if (typeof agent === 'string' && cleanText(agent) !== (synced.agent ?? '')) {
      inputs.push({ side: 'agent', text: agent });
    }
    if (typeof user === 'string' && cleanText(user) !== (synced.user ?? '')) {
      inputs.push({ side: 'user', text: user });
    }
    if (inputs.length === 0) return { ok: true, ran: false, skipped: 'synced', ...empty };
    // Reuse the round's user-edited guard: a library change between the settings read and this
    // commit means the user edit already won; abandon the stale prompt instead of overwriting it.
    if (expectedVersion !== null && expectedVersion !== undefined
      && String(expectedVersion) !== this.librarySignature()) {
      return { ok: false, aborted: true, ran: false, reason: 'user-edited', ...empty };
    }
    const previous = this.snapshotLines();
    const sideOf = new Map();
    for (const line of previous) {
      const entry = this.profile.get(line.entryId);
      if (entry !== null) sideOf.set(line.entryId, entry.side);
    }
    const plans = inputs.map((input) => {
      const parsed = parseReconcileLines(input.text);
      const saved = previous
        .filter((line) => sideOf.get(line.entryId) === input.side)
        .map((line) => ({ entryId: line.entryId, text: line.text }));
      return {
        side: input.side,
        parsed,
        diff: reconcilePromptLines(parsed.lines, saved, this.reconcileSimilarity),
      };
    });

    let compiledSections = [];
    const syncedNext = { ...synced };
    const pendingNext = { ...this.pendingFlags() };
    for (const input of inputs) {
      syncedNext[input.side] = cleanText(input.text);
      pendingNext[input.side] = false;
    }
    const outcome = this.profile.transact(() => {
      const counts = { ...empty };
      const mappedBySide = { agent: [], user: [] };
      const provided = new Set(plans.map((plan) => plan.side));
      // Baseline is captured before any removal/edit/addition of this save (see originalAverage).
      const baselines = new Map(plans.map((plan) => [plan.side, this.originalAverage(plan.side)]));
      for (const line of previous) {
        const side = sideOf.get(line.entryId);
        if (side !== undefined && !provided.has(side)) mappedBySide[side].push({ entryId: line.entryId, text: line.text });
      }
      for (const plan of plans) {
        counts.ignored += plan.parsed.ignored;
        for (const saved of plan.diff.removed) {
          if (this.removeEntry(saved.entryId)) counts.removed += 1;
          else counts.ignored += 1;
        }
      }
      for (const plan of plans) {
        const average = baselines.get(plan.side) ?? this.originalAverage(plan.side);
        const ids = new Array(plan.parsed.lines.length).fill(null);
        for (const pair of plan.diff.unchanged) {
          ids[pair.index] = pair.entryId;
          counts.unchanged += 1;
        }
        for (const pair of plan.diff.updated) {
          const clash = this.findEntry(plan.side, pair.text);
          if (clash !== null && clash.id !== pair.entryId) {
            counts.ignored += 1;
            continue;
          }
          const patch = { text: pair.text };
          if (pair.category.length > 0) patch.category = pair.category;
          const edited = this.profile.reconcileEdit(pair.entryId, patch);
          if (edited === null || edited.changed.length === 0) {
            counts.ignored += 1;
            continue;
          }
          ids[pair.index] = pair.entryId;
          counts.updated += 1;
        }
        for (const pair of plan.diff.added) {
          // The library already owns this tendency (e.g. an extractor entry). The user typing it
          // into the box is an explicit choice: adopt it outright (rank original) instead of
          // leaving a `new` candidate with an empty prompt.
          const existing = this.findEntry(plan.side, pair.text);
          if (existing !== null && !ids.includes(existing.id)) {
            this.profile.edit(existing.id, {});
            ids[pair.index] = existing.id;
            counts.unchanged += 1;
            continue;
          }
          if (existing !== null) {
            counts.ignored += 1;
            continue;
          }
          const created = this.profile.upsert({
            side: plan.side,
            category: pair.category,
            text: pair.text,
            clarity: average.clarity,
            efficacy: average.efficacy,
            rank: 'original',
          });
          if (created === null || created.entry === null) {
            counts.ignored += 1;
            continue;
          }
          ids[pair.index] = created.entry.id;
          counts.added += 1;
        }
        for (let index = 0; index < ids.length; index += 1) {
          if (ids[index] === null) continue;
          mappedBySide[plan.side].push({ entryId: ids[index], text: cleanText(plan.parsed.lines[index].text) });
        }
      }

      const nextLines = [...mappedBySide.agent, ...mappedBySide.user];
      const changed = counts.added + counts.updated + counts.removed;
      if (changed === 0 && sameMapping(previous, nextLines)) {
        this.setState({ syncedText: syncedNext, pending: pendingNext });
        return { ok: true, ran: false, ...counts, snapshotVersion: this.snapshot()?.version ?? 0 };
      }
      const before = this.snapshot();
      const compiled = this.profile.compileRank({ config: this.rankConfig });
      compiledSections = Array.isArray(compiled.sections) ? compiled.sections : [];
      // The compile may forget a low-C entry: the mapping must never point at a dead row.
      const live = new Set(this.profile.list().map((entry) => entry.id));
      const lines = nextLines.filter((line) => live.has(line.entryId));
      const at = this.at().toISOString();
      const version = (Number(before?.version) || 0) + 1;
      this.writeSnapshot(compiled.text, Number(compiled.usedTokens) || 0, version, at, lines);
      this.setState({
        snapshotVersion: version,
        snapshotAt: at,
        snapshotTrigger: `reconcile:${trigger}`,
        syncedText: syncedNext,
        pending: pendingNext,
      });
      this.promptCache = null;
      return { ok: true, ran: true, ...counts, snapshotVersion: version };
    });
    if (outcome.added + outcome.updated + outcome.removed + outcome.unchanged + outcome.ignored > 0) {
      this.emitNow(PROFILE_RECONCILE_EVENTS.reconciled, {
        added: outcome.added,
        updated: outcome.updated,
        removed: outcome.removed,
        unchanged: outcome.unchanged,
        ignored: outcome.ignored,
      });
    }
    return { ...outcome, sections: compiledSections };
  }

  /**
   * Read one fragment's source box: the box whose line (framing words stripped) matches it, or
   * whose text contains it. The box the fragment is routed AWAY from is checked first, so a line
   * that also exists in the target box is still traceable as a cross-side move.
   */
  inferSplitSource(text, texts, side = 'agent') {
    const key = promptKey(text);
    if (key.length === 0) return side;
    const order = [SIDES.find((which) => which !== side) ?? side, side];
    for (const which of order) {
      const lines = parseReconcileLines(texts[which]).lines;
      if (lines.some((line) => promptKey(line.text) === key
        || promptKey(stripFramingWords(line.text, which)) === key)) return which;
    }
    for (const which of order) {
      const body = promptKey(texts[which]);
      if (body.length > 0 && body.includes(key)) return which;
    }
    return side;
  }

  /**
   * Host routing of one split batch: every fragment gets its target `side` and the `fromSide` box
   * it was typed in. A fragment whose side equals its source box and whose box did not change is
   * context only (it stays exactly as saved); everything else is routed, so the same sentence can
   * never be kept on both sides.
   */
  routeSplitEntries({ entries = [], texts = {}, sides = {} } = {}) {
    const onlyChanged = SIDES.filter((side) => sides[side] === true);
    const defaultSide = onlyChanged.length === 1 ? onlyChanged[0] : 'agent';
    const normalized = normalizeSplitEntries(entries, defaultSide);
    const routed = [];
    for (const entry of normalized.entries) {
      const side = SIDES.includes(entry.side) ? entry.side : defaultSide;
      const fromSide = entry.fromSide.length > 0
        ? entry.fromSide
        : this.inferSplitSource(entry.text, texts, side);
      if (side === fromSide && sides[side] !== true) continue;
      routed.push({ ...entry, side, fromSide });
    }
    return { entries: routed, ignored: normalized.ignored };
  }

  /**
   * The entries of a side that was NOT edited by the user but is involved in a move: its saved
   * lines stay as they are, the lines that moved away are dropped and the moved-in ones added. A
   * side nobody touched is never re-derived, so an unchanged box keeps its own wording.
   */
  keepSideEntries(side, movedIn = [], movedOut = []) {
    const lines = [];
    for (const line of this.snapshotLines()) {
      const entry = this.profile.get(line.entryId);
      if (entry === null || entry.side !== side) continue;
      lines.push({ text: line.text, category: entry.category });
    }
    const dropped = new Set();
    for (const item of movedOut) {
      const index = lines.findIndex((line, at) => !dropped.has(at)
        && (promptKey(line.text) === promptKey(item.text)
          || promptSimilarity(line.text, item.text) >= this.reconcileSimilarity));
      if (index >= 0) dropped.add(index);
    }
    const kept = lines.filter((line, index) => !dropped.has(index));
    for (const item of movedIn) {
      if (kept.some((line) => promptKey(line.text) === promptKey(item.text))) continue;
      kept.push({ text: item.text, category: item.category });
    }
    return kept;
  }

  /** Box text plus the fragments that moved into it, one per line, never duplicated. */
  appendedSplitText(base, lines = []) {
    const body = cleanText(base);
    const seen = new Set(body.split(/\r?\n/u).map((line) => promptKey(line)).filter((key) => key.length > 0));
    const extra = [];
    for (const line of lines) {
      const key = promptKey(line);
      if (key.length === 0 || seen.has(key)) continue;
      seen.add(key);
      extra.push(cleanText(line));
    }
    if (extra.length === 0) return body;
    return [...(body.length > 0 ? [body] : []), ...extra].join('\n');
  }

  /**
   * Internal model step of the organize round (never called by「保存」): ONE completion reads BOTH
   * boxes and says, per fragment, which side it belongs to (semantics, not the box it was typed
   * in). The host routes the fragments, validates the proposed categories and applies the tone
   * gate. It writes nothing; the caller commits `planned` in the same transaction as every other
   * write, so a failure leaves the library, the boxes and the category stack untouched.
   */
  async planSplit({ agent, user, changed = null, trigger = 'settings', expectedVersion = null, signal } = {}) {
    const empty = { added: 0, updated: 0, removed: 0, unchanged: 0, ignored: 0, modelCalls: 0 };
    const fail = (result) => ({ ok: false, result: { ran: false, ...empty, ...result } });
    if (signal?.aborted) return fail({ ok: false, reason: 'cancelled' });
    // Both boxes are read on every organize: the model routes by semantics, not by the box.
    const texts = {
      agent: typeof agent === 'string' ? agent : '',
      user: typeof user === 'string' ? user : '',
    };
    const sides = changed !== null && typeof changed === 'object'
      ? { agent: changed.agent === true, user: changed.user === true }
      : { agent: typeof agent === 'string', user: typeof user === 'string' };
    if (!sides.agent && !sides.user) {
      return { ok: true, planned: [], moves: [], categoryOps: [], categoryEvents: [], touched: { ...sides }, modelCalls: 0, saveSeq: null };
    }
    if (expectedVersion !== null && expectedVersion !== undefined
      && String(expectedVersion) !== this.librarySignature()) {
      return fail({ ok: false, aborted: true, reason: 'user-edited' });
    }
    // Newest operation wins: a later save claims a higher seq, and this result is discarded
    // before it can touch the library or the boxes.
    const saveSeq = this.nextSaveSeq();
    const lostRace = async (modelCalls) => {
      await this.emitSafe(PROFILE_SPLIT_EVENTS.aborted, {
        trigger,
        reason: 'superseded',
        saveSeq,
        current: this.saveSeq(),
      });
      return fail({ ok: false, aborted: true, reason: 'superseded', saveSeq, modelCalls });
    };

    // Phase 1 — model. Nothing is written here, so one failure leaves the old library untouched.
    let planned = [];
    let moves = [];
    let category = { ops: [], events: [], byKey: new Map() };
    let modelCalls = 0;
    try {
      const sending = SIDES.filter((side) => sides[side] && cleanText(texts[side]).length > 0);
      let split = { entries: [], categories: [] };
      if (sending.length > 0) {
        const primary = sending[0];
        modelCalls += 1;
        this.lastSplitCategories = null;
        // ONE request with both boxes. `side`/`text` of the primary box ride along so a legacy
        // injected splitter (which only knows one box) still answers; the default model splitter
        // ignores them and reads `agent`/`user` together.
        const raw = await this.splitter({
          agent: texts.agent,
          user: texts.user,
          side: primary,
          text: texts[primary],
          signal,
        });
        if (signal?.aborted) return fail({ ok: false, reason: 'cancelled', modelCalls });
        if (this.superseded(saveSeq)) return lostRace(modelCalls);
        const payload = parseSplitPayload(raw);
        split = {
          entries: payload.entries,
          categories: Array.isArray(raw) ? (this.lastSplitCategories ?? []) : payload.categories,
        };
        // Unlabelled fragments mean a legacy `{side, text}` double: they belong to the primary
        // box, and the remaining changed box (if any) needs its own call. The default model
        // splitter labels every fragment, so it is never called twice.
        const labelled = split.entries.every((item) => SIDES.includes(cleanText(item?.side)));
        if (this.splitInjected === true && split.entries.length > 0 && labelled === false) {
          split.entries = split.entries.map((item) => ({ ...item, side: primary }));
          for (const side of sending.slice(1)) {
            modelCalls += 1;
            const single = await this.splitter({ side, text: texts[side], signal });
            if (signal?.aborted) return fail({ ok: false, reason: 'cancelled', modelCalls });
            if (this.superseded(saveSeq)) return lostRace(modelCalls);
            let list = [];
            try {
              list = parseSplitEntries(single);
            } catch {
              list = [];
            }
            split.entries.push(...(Array.isArray(list) ? list : []).map((item) => ({
              ...(item !== null && typeof item === 'object' && !Array.isArray(item) ? item : { text: item }),
              side,
            })));
          }
        }
      }
      // Phase 1b — host routing, category validation and the tone gate. Still read-only.
      const routed = this.routeSplitEntries({ entries: split.entries, texts, sides });
      category = this.planCategoryOps(split.categories);
      const entries = routed.entries;
      const touched = { agent: false, user: false };
      for (const side of SIDES) {
        const own = entries.filter((entry) => entry.side === side);
        const leaving = entries.filter((entry) => entry.fromSide === side && entry.side !== side);
        touched[side] = sides[side] === true || own.some((entry) => entry.fromSide !== side) || leaving.length > 0;
      }
      for (const side of SIDES) {
        const mine = entries.filter((entry) => entry.side === side);
        if (mine.length === 0) continue;
        const toned = await this.enforceToneBatch({ side, texts: mine.map((entry) => entry.text), signal });
        modelCalls += toned.repairCalls;
        if (signal?.aborted) return fail({ ok: false, reason: 'cancelled', modelCalls });
        if (this.superseded(saveSeq)) return lostRace(modelCalls);
        mine.forEach((entry, index) => { entry.text = toned.texts[index] ?? entry.text; });
      }
      // Every fragment must land on an existing (or just-added) category of its own side.
      for (const entry of entries) {
        const resolved = this.resolveCategory(entry.category, entry.side, category.byKey);
        entry.category = resolved.name;
        if (resolved.fallback === true) {
          category.events.push({
            type: PROFILE_CATEGORY_EVENTS.rejected,
            payload: { reason: 'category-fallback', name: resolved.requested, parent: entry.side, fallback: resolved.name },
          });
        }
      }
      // Phase 1c — the plans. A side edited by the user is fully re-derived from its fragments; a
      // side that only received/lost a moved fragment keeps its saved lines and gains the move; a
      // side nobody touched is not planned at all, so its box keeps its original text.
      planned = SIDES.filter((side) => touched[side]).map((side) => {
        const base = cleanText(texts[side]);
        const incoming = entries.filter((entry) => entry.side === side && entry.fromSide !== side);
        const leaving = entries.filter((entry) => entry.fromSide === side && entry.side !== side);
        const kept = sides[side] === true
          ? entries.filter((entry) => entry.side === side)
          : this.keepSideEntries(side, incoming, leaving);
        // An edited box that also moves fragments is rewritten from the routed fragments, so the
        // moved sentence really leaves this box; otherwise the box text is kept as written.
        const moved = incoming.length > 0 || leaving.length > 0;
        return {
          side,
          text: sides[side] === true && moved
            ? kept.map((entry) => entry.text).join('\n')
            : this.appendedSplitText(base, incoming.map((entry) => entry.text)),
          entries: kept.map((entry) => ({ text: entry.text, category: entry.category })),
          ignored: 0,
          cleared: sides[side] === true && base.length === 0,
        };
      });
      if (planned.length > 0) planned[0].ignored = routed.ignored;
      moves = entries
        .filter((entry) => entry.fromSide !== entry.side)
        .map((entry) => ({
          text: entry.text,
          category: entry.category,
          fromSide: entry.fromSide,
          toSide: entry.side,
          moved: true,
        }));
    } catch (error) {
      const message = String(error?.message ?? error);
      const scene = error?.details !== null && typeof error?.details === 'object' ? error.details : {};
      await this.emitSafe(PROFILE_SPLIT_EVENTS.failed, { trigger, error: message, modelCalls, ...scene });
      return fail({ ok: false, error: message, modelCalls });
    }
    if (signal?.aborted) return fail({ ok: false, reason: 'cancelled', modelCalls });
    // Re-check after the last model call, immediately before the synchronous commit.
    if (this.superseded(saveSeq)) return lostRace(modelCalls);
    return {
      ok: true,
      planned,
      moves,
      categoryOps: category.ops,
      categoryEvents: category.events,
      touched: {
        agent: planned.some((plan) => plan.side === 'agent'),
        user: planned.some((plan) => plan.side === 'user'),
      },
      modelCalls,
      saveSeq,
    };
  }

  /**
   * Public split step used by tests/diagnostics: plan, commit and persist the box text. The
   * settings「立刻整理」round calls `planSplit` + `commitSplit` itself so the writeback and the
   * box persistence can be one flow.
   *
   * @returns {Promise<{ok: boolean, ran?: boolean, added?: number, updated?: number,
   *   removed?: number, unchanged?: number, ignored?: number, modelCalls?: number,
   *   error?: string, snapshotVersion?: number}>}
   */
  async split({ agent, user, trigger = 'settings', expectedVersion = null, signal } = {}) {
    const planned = await this.planSplit({ agent, user, trigger, expectedVersion, signal });
    if (planned.ok !== true) return planned.result;
    let outcome;
    try {
      outcome = this.commitSplit({
        planned: planned.planned,
        trigger,
        categoryOps: planned.categoryOps,
        moves: planned.moves,
      });
    } catch (error) {
      const message = String(error?.message ?? error);
      await this.emitSafe(PROFILE_SPLIT_EVENTS.failed, { trigger, error: message, modelCalls: planned.modelCalls });
      return {
        ok: false, ran: false, error: message,
        added: 0, updated: 0, removed: 0, unchanged: 0, ignored: 0,
        modelCalls: planned.modelCalls,
      };
    }
    // Persist the box text only after the split succeeded (a failure never overwrites it).
    if (this.writePersona !== null) {
      for (const plan of planned.planned) {
        try {
          this.writePersona(plan.side, plan.text);
        } catch {
          /* the library already reflects the text; a persona-file write is best-effort */
        }
      }
    }
    for (const event of planned.categoryEvents) this.emitNow(event.type, event.payload);
    for (const move of planned.moves) this.emitNow(PROFILE_SPLIT_EVENTS.moved, move);
    const counters = {
      added: outcome.added,
      updated: outcome.updated,
      removed: outcome.removed,
      unchanged: outcome.unchanged,
      ignored: outcome.ignored,
      modelCalls: planned.modelCalls,
    };
    // A cross-side move is part of the revision record; a round without one keeps the old shape.
    if (planned.moves.length > 0) counters.moves = planned.moves;
    await this.emitSafe(PROFILE_SPLIT_EVENTS.split, counters);
    return { ok: true, ran: outcome.ran, ...counters, saveSeq: planned.saveSeq, snapshotVersion: outcome.snapshotVersion };
  }

  /**
   * Write one save's plan. The mapping follows the box order. Baselines are captured before the
   * save's own removals/edits, then entries are removed first so the mapping never points at a
   * dead row; an existing library tendency is promoted to `original` (the user typed it).
   */
  commitSplit({ planned = [], trigger = 'settings', categoryOps = [], moves = [] } = {}) {
    const previous = this.snapshotLines();
    let sections = [];
    const sideOf = new Map();
    for (const line of previous) {
      const entry = this.profile.get(line.entryId);
      if (entry !== null) sideOf.set(line.entryId, entry.side);
    }
    const plans = planned.map((plan) => {
      const saved = previous
        .filter((line) => sideOf.get(line.entryId) === plan.side)
        .map((line) => ({ entryId: line.entryId, text: line.text }));
      return {
        ...plan,
        saved,
        diff: plan.cleared
          ? { unchanged: [], updated: [], added: [], removed: saved }
          : reconcilePromptLines(plan.entries, saved, this.reconcileSimilarity),
      };
    });
    return this.profile.transact(() => {
      // The category stack first: a new/renamed category must exist before any entry points at it.
      this.applyCategoryOps(categoryOps);
      const counts = { added: 0, updated: 0, removed: 0, unchanged: 0, ignored: 0 };
      let recategorized = 0;
      const mappedBySide = { agent: [], user: [] };
      const provided = new Set(plans.map((plan) => plan.side));
      const baselines = new Map(plans.map((plan) => [plan.side, this.originalAverage(plan.side)]));
      for (const line of previous) {
        const side = sideOf.get(line.entryId);
        if (side !== undefined && !provided.has(side)) mappedBySide[side].push({ entryId: line.entryId, text: line.text });
      }
      for (const plan of plans) {
        counts.ignored += plan.ignored;
        // An explicitly emptied box clears the whole side, including rows the mapping never saw.
        const doomed = plan.cleared
          ? this.profile.list({ side: plan.side }).map((entry) => entry.id)
          : plan.diff.removed.map((line) => line.entryId);
        for (const entryId of new Set(doomed)) {
          if (this.removeEntry(entryId)) counts.removed += 1;
        }
      }
      for (const plan of plans) {
        const average = baselines.get(plan.side) ?? this.originalAverage(plan.side);
        const ids = new Array(plan.entries.length).fill(null);
        for (const pair of plan.diff.unchanged) {
          ids[pair.index] = pair.entryId;
          counts.unchanged += 1;
          // The stack is normative: an unchanged text still adopts the category the model chose
          // (a seeded line has none, and a re-organize may have found a better one).
          if (pair.category.length > 0) {
            const entry = this.profile.get(pair.entryId);
            if (entry !== null && categoryKey(entry.category) !== categoryKey(pair.category)) {
              const edited = this.profile.reconcileEdit(pair.entryId, { category: pair.category });
              if (edited !== null && Array.isArray(edited.changed) && edited.changed.length > 0) recategorized += 1;
            }
          }
        }
        for (const pair of plan.diff.updated) {
          const clash = this.findEntry(plan.side, pair.text);
          if (clash !== null && clash.id !== pair.entryId) {
            counts.ignored += 1;
            continue;
          }
          const patch = { text: pair.text };
          if (pair.category.length > 0) patch.category = pair.category;
          const edited = this.profile.reconcileEdit(pair.entryId, patch);
          if (edited === null || edited.changed.length === 0) {
            counts.ignored += 1;
            continue;
          }
          ids[pair.index] = pair.entryId;
          counts.updated += 1;
        }
        for (const pair of plan.diff.added) {
          // The library already owns this tendency (an extractor entry): the user typing it into
          // the box promotes it to `original` outright, never a duplicate and never a candidate.
          const existing = this.findEntry(plan.side, pair.text);
          if (existing !== null && !ids.includes(existing.id)) {
            this.profile.edit(existing.id, {});
            ids[pair.index] = existing.id;
            counts.unchanged += 1;
            continue;
          }
          if (existing !== null) {
            counts.ignored += 1;
            continue;
          }
          const created = this.profile.upsert({
            side: plan.side,
            category: pair.category,
            text: pair.text,
            clarity: average.clarity,
            efficacy: average.efficacy,
            rank: 'original',
          });
          if (created === null || created.entry === null) {
            counts.ignored += 1;
            continue;
          }
          ids[pair.index] = created.entry.id;
          counts.added += 1;
        }
        for (let index = 0; index < ids.length; index += 1) {
          if (ids[index] === null) continue;
          mappedBySide[plan.side].push({ entryId: ids[index], text: cleanText(plan.entries[index].text) });
        }
      }

      const managed = { ...this.syncedTexts() };
      for (const plan of plans) managed[plan.side] = cleanText(plan.text);
      const pendingNext = { ...this.pendingFlags() };
      for (const plan of plans) pendingNext[plan.side] = false;
      const nextLines = [...mappedBySide.agent, ...mappedBySide.user];
      const changed = counts.added + counts.updated + counts.removed + recategorized;
      if (changed === 0 && sameMapping(previous, nextLines)) {
        this.setState({ syncedText: managed, pending: pendingNext, boxesAuthoritative: '1' });
        return {
          ok: true, ran: false, ...counts, moves, sections: [], snapshotVersion: this.snapshot()?.version ?? 0,
        };
      }
      const before = this.snapshot();
      const compiled = this.profile.compileRank({ config: this.rankConfig });
      sections = Array.isArray(compiled.sections) ? compiled.sections : [];
      const live = new Set(this.profile.list().map((entry) => entry.id));
      const lines = nextLines.filter((line) => live.has(line.entryId));
      const at = this.at().toISOString();
      const version = (Number(before?.version) || 0) + 1;
      this.writeSnapshot(compiled.text, Number(compiled.usedTokens) || 0, version, at, lines);
      this.setState({
        snapshotVersion: version,
        snapshotAt: at,
        snapshotTrigger: `split:${trigger}`,
        syncedText: managed,
        pending: pendingNext,
        boxesAuthoritative: '1',
      });
      this.promptCache = null;
      return { ok: true, ran: true, ...counts, moves, sections, snapshotVersion: version };
    });
  }

  /**
   * Default splitter: ONE model completion over both boxes. The model labels every fragment with
   * its side and may propose category-stack changes; the entry list is returned (the category
   * proposals travel through `lastSplitCategories`, exactly like `lastCompletionStats`).
   */
  async splitWithModel({ agent, user, side = null, text = '', signal } = {}) {
    const batch = typeof agent === 'string' || typeof user === 'string';
    const output = await this.complete({
      system: SPLIT_SYSTEM,
      prompt: buildSplitPrompt(batch
        ? { agent: agent ?? '', user: user ?? '', categories: this.categories() }
        : { side, text, categories: this.categories() }),
      phase: 'split',
      signal,
    });
    const payload = parseSplitPayload(output);
    this.lastSplitCategories = payload.categories;
    return payload.entries;
  }

  /** Default composer: the agent rewrites the selected fragments into one natural prompt. */
  async composeWithModel({ side, entries, tone, maxChars, signal }) {
    this.lastCompletionStats = null;
    const output = await this.complete({
      system: COMPOSE_SYSTEM,
      prompt: buildComposePrompt({ side, entries, tone, maxChars }),
      phase: 'compose',
      signal,
    });
    return parseComposeText(output, this.lastCompletionStats);
  }

  /**
   * Default semantic cross-check: the rewrite and its source entries go back to the model once, on
   * the lightweight assist channel (phase `compose`, so the persona-rewrite task is reused). It
   * only answers ok/issues — it never edits text. A throw or an unparseable answer is `ok: null`
   * (uncertain), and the caller writes the source sentences instead.
   */
  async verifyComposeWithModel({ side, entries, text, signal }) {
    const output = await this.complete({
      system: COMPOSE_VERIFY_SYSTEM,
      prompt: buildComposeVerifyPrompt({ side, entries, text }),
      phase: 'compose',
      signal,
    });
    return parseComposeVerify(output);
  }

  /** Default tone repairer: one completion over the violating sentences only. */
  async repairToneWithModel({ side, sentences, signal }) {
    const output = await this.complete({
      system: TONE_REPAIR_SYSTEM,
      prompt: buildToneRepairPrompt({ side, sentences }),
      phase: 'tone',
      signal,
    });
    return parseToneRepair(output);
  }

  /**
   * Tone gate for one batch of model-produced sentences. The pure check runs first; only the
   * violating sentences go back to the model ONCE. Anything still violating is replaced
   * deterministically (`fallbackToneText`), so the caller may persist the result without a
   * second model round. Quoted speech is never a violation and is copied verbatim. A sentence the
   * host cannot classify safely (an ambiguous 「用户」, a rewrite that still violates) is never
   * guessed at: it keeps its original wording and is reported as `profile.tone.unresolved`.
   *
   * @returns {Promise<{texts: string[], violations: number, repairCalls: number, fallback: number,
   *                    unresolved: number}>}
   */
  async enforceToneBatch({ side, texts = [], signal } = {}) {
    const which = side === 'agent' ? 'agent' : 'user';
    const list = (Array.isArray(texts) ? texts : []).map((text) => String(text ?? ''));
    const offenders = [];
    for (let index = 0; index < list.length; index += 1) {
      for (const violation of checkProfileTone(list[index], which).violations) {
        offenders.push({ index, ...violation });
      }
    }
    const result = { texts: [...list], violations: offenders.length, repairCalls: 0, fallback: 0, unresolved: 0 };
    if (offenders.length === 0) {
      result.unresolved = list.reduce((count, text) => count + checkProfileTone(text, which).unresolved.length, 0);
      if (result.unresolved > 0) {
        await this.emitSafe(PROFILE_TONE_EVENTS.unresolved, { side: which, count: result.unresolved });
      }
      return result;
    }
    let repaired = list;
    result.repairCalls = 1;
    await this.emitSafe(PROFILE_TONE_EVENTS.repair, {
      side: which,
      violations: offenders.map((item) => item.text),
    });
    try {
      const output = await this.toneRepairer({
        side: which,
        sentences: offenders.map((item) => item.text),
        signal,
      });
      const replacements = parseToneRepair(output);
      if (replacements.length === offenders.length) {
        repaired = [...list];
        let cursor = 0;
        for (let index = 0; index < list.length; index += 1) {
          const own = offenders.filter((item) => item.index === index);
          if (own.length === 0) continue;
          repaired[index] = replaceToneSentences(list[index], own, replacements.slice(cursor, cursor + own.length));
          cursor += own.length;
        }
      }
    } catch {
      repaired = list;
    }
    result.texts = repaired.map((text) => {
      const failed = checkProfileTone(text, which);
      if (failed.ok) return text;
      result.fallback += failed.violations.length;
      const rewritten = replaceToneSentences(
        text,
        failed.violations,
        failed.violations.map((item) => fallbackToneText(item.text, which)),
      );
      // The deterministic rewrite is re-validated: a rewrite that still violates (or that the
      // boundary rules refuse to touch) is never persisted. The sentence keeps its original
      // wording and the case is reported as unresolved instead of silently changing the meaning.
      const second = checkProfileTone(rewritten, which);
      if (!second.ok) {
        result.unresolved += second.violations.length;
        return text;
      }
      return rewritten;
    });
    if (result.fallback > 0) {
      await this.emitSafe(PROFILE_TONE_EVENTS.fallback, { side: which, count: result.fallback });
    }
    // Ambiguous occurrences the host deliberately kept (e.g. a mid-clause 「用户」): visible in the
    // log, never rewritten, and counted so a regression shows up instead of staying silent.
    result.unresolved += result.texts
      .reduce((count, text) => count + checkProfileTone(text, which).unresolved.length, 0);
    if (result.unresolved > 0) {
      await this.emitSafe(PROFILE_TONE_EVENTS.unresolved, { side: which, count: result.unresolved });
    }
    return result;
  }

  /**
   * Extraction site: enforce tone on support candidates before they reach the library. A
   * contradiction's `target_text` is a lookup key of an existing entry, never a new sentence.
   */
  async enforceExtractTone({ candidates = [], signal } = {}) {
    const list = Array.isArray(candidates) ? candidates : [];
    const groups = { agent: [], user: [] };
    for (const candidate of list) {
      if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
      if (candidateOperation(candidate) !== 'support') continue;
      const side = SIDES.includes(candidate.side) ? candidate.side : null;
      const text = cleanText(candidate.text);
      if (side === null || text.length === 0) continue;
      groups[side].push({ candidate, text });
    }
    const replacements = new Map();
    for (const side of SIDES) {
      if (groups[side].length === 0 || signal?.aborted === true) continue;
      const toned = await this.enforceToneBatch({
        side,
        texts: groups[side].map((item) => item.text),
        signal,
      });
      groups[side].forEach((item, index) => replacements.set(item.candidate, toned.texts[index]));
    }
    return list.map((candidate) => (replacements.has(candidate)
      ? { ...candidate, text: replacements.get(candidate) }
      : candidate));
  }

  /**
   * Deterministic second side pass, run on the ORIGINAL box-mapped entries after the split/commit
   * writes and BEFORE the compile: every entry is judged again with the existing category stack
   * and the content rule 「与人有关的偏好（角色/说话/互动/处事方式）→ agent」. A cross-side move
   * updates only side/category (pronoun prefix normalized) and writes one revision in the caller's
   * transaction, keeping source rank, evidence and C/E untouched; box, mapping and sync state are
   * committed by the same version-checked write-back. No model call.
   *
   * @returns {object[]} moves carrying `moved:true, fromSide, toSide` (category-only repairs use
   *   `moved:false`).
   */
  applySecondSplit() {
    const categories = this.categories();
    const moves = [];
    for (const line of this.snapshotLines()) {
      const row = this.profile.get(line.entryId);
      if (row === null || row.rejected === true) continue;
      const decision = classifyProfileEntrySide(
        { text: row.text, side: row.side, category: row.category },
        categories,
      );
      if (decision === null || decision.drop === true) continue;
      if (decision.side === row.side && categoryKey(decision.category) === categoryKey(row.category)) continue;
      // A misplaced rule carries its restored user sentence; any other move only normalizes pronouns.
      const text = decision.side === row.side
        ? row.text
        : (cleanText(decision.text) || normalizeReclassifyText(row.text, decision.side));
      const clash = this.db
        .prepare('SELECT id FROM profile_entry WHERE side = ? AND text = ? AND id <> ?')
        .get(decision.side, text, row.id);
      if (clash !== undefined) continue;
      const at = this.at().toISOString();
      const before = { side: row.side, category: row.category };
      const cross = decision.side !== row.side;
      const after = cross
        ? { side: decision.side, category: decision.category, text, moved: true, fromSide: row.side, toSide: decision.side }
        : { side: row.side, category: decision.category };
      if (text !== row.text) before.text = row.text;
      this.db
        .prepare('UPDATE profile_entry SET side = ?, category = ?, text = ?, version = version + 1, updated_at = ? WHERE id = ?')
        .run(decision.side, decision.category, text, at, row.id);
      this.db
        .prepare('INSERT INTO profile_revision (id, entry_id, before, after, at, source) VALUES (?, ?, ?, ?, ?, ?)')
        .run(randomUUID(), row.id, JSON.stringify(before), JSON.stringify(after), at, 'agent');
      moves.push({
        entryId: row.id,
        text,
        category: decision.category,
        fromSide: row.side,
        toSide: decision.side,
        moved: cross,
        reason: decision.reason ?? null,
      });
    }
    return moves;
  }

  /**
   * Write the composed prompt back into the two boxes and persist it (an automatic save that never
   * triggers a split, so writeback → split → writeback cannot loop). Only a side whose box text is
   * already synced with the library is written: an unsynced user edit is never overwritten, and the
   * box is re-read right before the write, so an edit made while the model was composing wins.
   *
   * The two sides consume ONE total token budget (default 600): the heading/newline/separator
   * overhead is reserved first, the remainder is split by entry count, and the combined result is
   * measured again before anything is persisted. An over-budget combination falls back to the
   * deterministic compiled sections, so the boxes can never leave the ceiling.
   *
   * Text, mapping and `syncedText` are the same version: each side records its `saveSeq` when its
   * text lands, and the final transaction skips any side whose sequence moved since (a newer save
   * owns that side), keeping the newer mapping and sync state.
   */
  async writeBack({
    trigger = 'manual', sections = null, signal, startBoxes = null,
    effectiveBoxes = null, pendingOverride = null,
  } = {}) {
    if (this.writePersona === null || this.personaSource !== true) return [];
    if (signal?.aborted) return [];
    this.markBoxesAuthoritative();
    // `startBoxes` is the text the round began with. Comparing against it (not against the
    // freshly read box) is what makes a save during extraction visible here. `effectiveBoxes`
    // lets the organize round compose from the just-split text before it lands on disk.
    const diskStart = startBoxes !== null && typeof startBoxes === 'object' ? startBoxes : this.readBoxes();
    const boxes = effectiveBoxes !== null && typeof effectiveBoxes === 'object' ? effectiveBoxes : diskStart;
    const pending = { ...(pendingOverride ?? this.pendingSides()) };
    const list = Array.isArray(sections) && sections.length > 0 ? sections : this.previewSections();
    const rankConfig = resolveProfileRankConfig(this.rankConfig);
    const totalBudget = positiveInt(rankConfig.totalBudget, PROFILE_PROMPT_BUDGET_TOKENS);
    const sideInputs = new Map();
    for (const side of SIDES) {
      const section = list.find((item) => item.side === side);
      sideInputs.set(side, {
        entries: Array.isArray(section?.entries) ? section.entries : [],
        deterministic: cleanText(section?.text ?? ''),
      });
    }
    // Shared budget accounting first: every composed side reserves its heading plus the newline
    // joining it to the body, and one separator joins the two sections. The remainder is split by
    // entry count; the persona side takes the rounding remainder, so the user side never gets it.
    const composing = SIDES.filter((side) => pending[side] === false && sideInputs.get(side).entries.length > 0);
    const overhead = profilePromptOverheadTokens(new Set(composing))
      + composing.length + Math.max(0, composing.length - 1);
    const lineBudget = Math.max(0, totalBudget - overhead);
    const weights = new Map(composing.map((side) => [side, sideInputs.get(side).entries.length]));
    const totalWeight = composing.reduce((sum, side) => sum + weights.get(side), 0);
    const shares = new Map();
    let assigned = 0;
    for (const side of composing) {
      const share = Math.floor((lineBudget * weights.get(side)) / Math.max(1, totalWeight));
      shares.set(side, share);
      assigned += share;
    }
    if (composing.length > 0) shares.set(composing[0], shares.get(composing[0]) + (lineBudget - assigned));

    const plans = [];
    // Box writes that failed: the box (settings JSON) and the library (SQLite) are NOT one
    // transaction, so a failure is persisted as a mismatch and reported to the round, never skipped.
    const writeFailures = [];
    for (const side of SIDES) {
      if (signal?.aborted) break;
      // Pending side = the user changed the box and it was not imported yet: do not overwrite it.
      if (pending[side] !== false) continue;
      const { entries, deterministic } = sideInputs.get(side);
      let text = '';
      let modelCalls = 0;
      let fallback = false;
      // An empty selection never runs the composer: the compiled result is empty, and the empty
      // text is written back (the side really has no adopted entry any more).
      if (entries.length > 0) {
        modelCalls = 1;
        // Duplicate facts are merged before the model sees them; the mapping still keeps every
        // selected entry, so the next save's diff stays exact. Each merge is logged (debug,
        // throttled) because an unconfirmed condition must never be merged silently.
        const deduped = dedupeComposeEntries(entries);
        const composeEntries = deduped.entries;
        await this.logComposeMerges(side, deduped.merges);
        try {
          text = cleanText(await this.composer({
            side, entries: composeEntries, tone: boxes[side], signal, maxChars: shares.get(side) ?? 0,
          }));
          if (text.length === 0) {
            const scene = this.lastCompletionStats;
            const error = new Error(scene !== null && typeof scene === 'object'
              ? `profile compose: model returned no text (EMPTY_TEXT) ${JSON.stringify(scene)}`
              : 'profile compose: model returned no text (EMPTY_TEXT)');
            error.code = 'EMPTY_TEXT';
            if (scene !== null && typeof scene === 'object') error.details = scene;
            throw error;
          }
          // The rewrite is a model output: enforce the side's tone before the budget gate, so a
          // violating composition is never written back. One targeted repair at most.
          const toned = await this.enforceToneBatch({ side, texts: [text], signal });
          text = toned.texts[0] ?? text;
          modelCalls += toned.repairCalls;
          // Host quality gate over the selected DEDUPED originals: filler/opposite-tendency/cross-
          // side/length anomalies reject the whole rewrite and the originals are written instead.
          const checked = validateComposeText({
            text,
            entries: composeEntries,
            side,
            otherEntries: sideInputs.get(side === 'agent' ? 'user' : 'agent').entries,
          });
          await this.logComposeMerges(side, checked.merges);
          if (checked.ok !== true) {
            text = composeFallbackText(composeEntries, side);
            fallback = true;
            await this.emitSafe(PROFILE_COMPOSE_EVENTS.rejected, {
              side,
              reason: checked.reason,
              detail: checked.detail,
              dropped: checked.dropped.length,
              maxRatio: Number(Number(checked.maxRatio).toFixed(2)),
            });
            await this.emitSafe(PROFILE_COMPOSE_EVENTS.fallback, {
              side,
              reason: 'compose-rejected',
              detail: checked.reason,
            });
          } else {
            text = checked.text;
            // The keyword table is only an omission HINT now; it never proves fidelity. Whether a
            // rewrite happened is decided by the text: any wording change beyond whitespace and
            // punctuation must pass the semantic check. With no lightweight channel, or with a
            // rejected/thrown/unparseable check, the source sentences are written instead.
            const reworded = composeReworded(composeEntries, text);
            const canVerify = this.verifyInjected === true || this.assist !== null;
            let verdict = { ok: null, issues: [] };
            if (reworded === true) {
              if (canVerify) {
                modelCalls += 1;
                try {
                  verdict = await this.composeVerifier({ side, entries: composeEntries, text, signal });
                } catch (error) {
                  verdict = { ok: null, issues: [], error: String(error?.message ?? error) };
                }
              }
              if (canVerify !== true || verdict?.ok !== true) {
                // A changed wording the host cannot confirm is never written: no channel is
                // reported as unverified/no-channel, an uncertain verdict as verify-failed.
                const rejected = canVerify !== true
                  ? { reason: 'unverified', detail: 'no-channel' }
                  : (verdict?.ok === false
                    ? { reason: 'semantic', detail: 'semantic' }
                    : { reason: 'unverified', detail: 'verify-failed' });
                text = composeFallbackText(composeEntries, side);
                fallback = true;
                await this.emitSafe(PROFILE_COMPOSE_EVENTS.rejected, {
                  side,
                  ...rejected,
                  risk: checked.risk === true,
                  omitted: (checked.omitted ?? []).length,
                  issues: Array.isArray(verdict?.issues) ? verdict.issues.length : 0,
                });
                await this.emitSafe(PROFILE_COMPOSE_EVENTS.fallback, { side, ...rejected });
              }
            }
          }
        } catch (error) {
          fallback = true;
          // A failed rewrite still writes SENTENCES (the source entries), never the compiled
          // bullet list: the boxes must keep reading as prose even when the model is offline.
          text = composeFallbackText(composeEntries, side);
          const scene = error?.details !== null && typeof error?.details === 'object' ? error.details : {};
          await this.emitSafe(PROFILE_COMPOSE_EVENTS.failed, {
            side,
            error: String(error?.message ?? error),
            ...scene,
          });
          await this.emitSafe(PROFILE_COMPOSE_EVENTS.fallback, {
            side,
            reason: 'compose-failed',
            error: String(error?.message ?? error),
            ...scene,
          });
        }
      }
      // The final text is written back as PLAIN PROSE: an existing box's `- `/`* `/`1. ` markers and
      // inline `**`/backticks are removed (content kept and completed into sentences, merged into
      // paragraphs), so a legacy list never survives the rewrite.
      text = ensurePlainProse(text);
      // A cancelled round must not write a half-finished composition back into the boxes.
      if (signal?.aborted) break;
      // The text the round started with no longer matches: a newer user save already owns the box.
      const current = this.readBoxes()[side];
      if (current !== diskStart[side]) {
        await this.emitSafe(PROFILE_WRITEBACK_SKIPPED_EVENT, { side, reason: 'user-edited' });
        continue;
      }
      let didWrite = false;
      if (cleanText(current) !== text) {
        try {
          this.writePersona(side, text);
        } catch (error) {
          writeFailures.push({ side, stage: 'box-write', error: String(error?.message ?? error) });
          continue;
        }
        didWrite = true;
      }
      // The version this side's text was just persisted under. A later save bumps the sequence,
      // so this side's mapping/synced text must not overwrite that newer save's version.
      plans.push({
        side, entries, deterministic, text, fallback, modelCalls, didWrite, seq: this.saveSeq(),
      });
    }

    // A side whose box changed while the other side was composing is owned by that newer save:
    // it must not enter the budget measurement, the mapping or the synced state. The transaction
    // below re-checks the sequence for every remaining side.
    for (const plan of plans) {
      if (cleanText(this.readBoxes()[plan.side]) !== plan.text) plan.superseded = true;
    }

    // Shared-budget gate. A composed side still needs its heading in the compiled shape; a
    // deterministic section already carries one, so it is measured as-is. If the combination is
    // over budget, fall back the largest composition first (the one saving the most tokens) and
    // re-measure; the deterministic compile itself is guaranteed to fit. No awaits in here: the
    // boxes must not change between this check and the version-checked commit below.
    const shapeOf = (plan) => (plan.entries.length === 0
      ? ''
      : plan.fallback ? plan.text : `## ${PROFILE_SECTIONS[plan.side].title}\n${plan.text}`);
    const measure = () => estimateProfileTokens(plans
      .filter((plan) => plan.superseded !== true)
      .map(shapeOf)
      .filter((part) => part.length > 0)
      .join('\n'));
    const budgetFallbacks = [];
    if (measure() > totalBudget) {
      const candidates = plans
        .filter((plan) => plan.superseded !== true && plan.entries.length > 0 && plan.fallback === false)
        .sort((left, right) => estimateProfileTokens(right.text) - estimateProfileTokens(left.text)
          || SIDES.indexOf(left.side) - SIDES.indexOf(right.side));
      for (const plan of candidates) {
        const overTokens = estimateProfileTokens(plan.text);
        plan.fallback = true;
        plan.text = ensurePlainProse(plan.deterministic);
        try {
          this.writePersona(plan.side, plan.text);
        } catch (error) {
          // The over-budget composition could not be replaced: drop this side from the writeback
          // and let the remaining candidates (or the hard ceiling below) decide.
          writeFailures.push({ side: plan.side, stage: 'budget-fallback', error: String(error?.message ?? error) });
          plan.superseded = true;
          continue;
        }
        plan.didWrite = true;
        budgetFallbacks.push({ side: plan.side, tokens: overTokens, budget: totalBudget });
        if (measure() <= totalBudget) break;
      }
    }
    // Hard ceiling: a writeback that would still overflow is a bug, never a silent over-budget box.
    const finalTokens = measure();
    if (finalTokens > totalBudget) {
      throw new Error(`profile writeback: combined prompt ${finalTokens} > ${totalBudget} tokens`);
    }

    const written = [];
    const writtenSynced = {};
    const mappedSides = new Map();
    const sideSeqs = new Map();
    for (const plan of plans) {
      if (plan.superseded === true) continue;
      if (cleanText(this.readBoxes()[plan.side]) !== plan.text) {
        plan.superseded = true;
        continue;
      }
      if (plan.didWrite) written.push({ side: plan.side, chars: plan.text.length, autoSaved: true });
      writtenSynced[plan.side] = plan.text;
      sideSeqs.set(plan.side, plan.seq);
      // The box now represents exactly these selected entries; keep the `(entryId, text)` mapping
      // in step so a later save's diff recognises the auto-adopted entries instead of re-adding them.
      mappedSides.set(plan.side, plan.entries.map((entry) => ({ entryId: entry.id, text: String(entry.text ?? '') })));
    }

    // fromCompile: this writeback is a compile-sourced write and never enters split(), so the
    // writeback → split → writeback cycle is structurally impossible. `syncedText` is merged onto
    // the value read now, never the one read at round start: a skipped side keeps the newer save.
    // The save sequence is re-read in the same transaction that writes the mapping, so text,
    // mapping and synced state are persisted as one version.
    const mappingSkipped = [];
    try {
      this.profile.transact(() => {
        const current = this.saveSeq();
        for (const plan of plans) {
          if (!mappedSides.has(plan.side)) {
            if (plan.seq !== current) mappingSkipped.push({ side: plan.side, reason: 'superseded' });
            continue;
          }
          if (sideSeqs.get(plan.side) === current) continue;
          mappingSkipped.push({ side: plan.side, reason: 'superseded' });
          mappedSides.delete(plan.side);
          delete writtenSynced[plan.side];
        }
        const pendingNext = { ...this.pendingFlags() };
        for (const side of mappedSides.keys()) pendingNext[side] = false;
        // A successful writeback is the organize step: the seeded side is no longer unorganized.
        const seededNext = { ...this.seededButUnorganizedFlags() };
        for (const side of mappedSides.keys()) seededNext[side] = false;
        const state = {
          syncedText: { ...this.syncedTexts(), ...writtenSynced },
          pending: pendingNext,
          seededButUnorganized: seededNext,
          boxesAuthoritative: '1',
          writeback: {
            fromCompile: true,
            trigger,
            at: this.at().toISOString(),
            sides: written.map((item) => item.side),
          },
        };
        // The second side pass was already persisted before the compile (same round transaction);
        // this write-back transaction persists only the box mapping and the sync state.
        const snapshot = mappedSides.size > 0 ? this.snapshot() : null;
        if (snapshot === null) {
          this.setState(state);
          return;
        }
        const group = { agent: [], user: [] };
        for (const line of snapshot.lines) {
          const entry = this.profile.get(line.entryId);
          if (entry !== null && group[entry.side] !== undefined) {
            group[entry.side].push({ entryId: line.entryId, text: line.text });
          }
        }
        for (const [side, lines] of mappedSides) group[side] = lines;
        // Mapping-only write: the prompt text/version are unchanged, so the prompt cache stays valid.
        this.writeSnapshot(snapshot.text, snapshot.tokens, snapshot.version, snapshot.updated_at, [
          ...group.agent,
          ...group.user,
        ]);
        this.setState(state);
      });
    } catch (error) {
      // The boxes may already carry the new text while the library rolled the mapping back: the
      // version-checked commit could not finish, so the mismatch is reported, never hidden.
      const sides = plans.filter((plan) => plan.didWrite === true).map((plan) => plan.side);
      await this.emitSafe(PROFILE_WRITEBACK_FAILED_EVENT, {
        reason: 'commit-failed',
        sides,
        error: String(error?.message ?? error),
      });
      throw error;
    }
    for (const payload of budgetFallbacks) {
      await this.emitSafe(PROFILE_COMPOSE_EVENTS.overBudget, payload);
      await this.emitSafe(PROFILE_COMPOSE_EVENTS.fallback, {
        side: payload.side,
        reason: 'over-budget',
        tokens: payload.tokens,
      });
    }
    for (const plan of plans) {
      if (plan.entries.length === 0) continue;
      await this.emitSafe(PROFILE_COMPOSE_EVENTS.composed, {
        side: plan.side,
        entries: plan.entries.length,
        modelCalls: plan.modelCalls,
        fallback: plan.fallback,
      });
    }
    for (const payload of mappingSkipped) {
      await this.emitSafe(PROFILE_WRITEBACK_MAPPING_SKIPPED_EVENT, payload);
    }
    for (const payload of written) this.emitNow(PROFILE_WRITEBACK_EVENT, payload);
    if (writeFailures.length > 0) {
      // The box did not take the text: the library keeps the old mapping for that side and the
      // round reports the failure instead of returning a writeback it did not really perform. The
      // failed side is marked pending again, so the next organize retries it instead of assuming
      // the library and the box are in sync.
      const failedSides = [...new Set(writeFailures.map((item) => item.side))]
        .filter((side) => SIDES.includes(side));
      if (failedSides.length > 0) {
        try {
          this.markPending(failedSides);
        } catch {
          /* recovery bookkeeping is best-effort; the failure below is the reported result */
        }
      }
      for (const failure of writeFailures) await this.emitSafe(PROFILE_WRITEBACK_FAILED_EVENT, failure);
      const error = new Error(`profile writeback: box write failed for ${writeFailures.map((item) => item.side).join(',')}`);
      error.code = 'WRITEBACK_FAILED';
      error.details = writeFailures;
      throw error;
    }
    return written;
  }

  /** A persist:false compile, used when a writeback needs sections without touching the snapshot. */
  previewSections() {
    try {
      const compiled = this.profile.compileRank({ config: this.rankConfig, persist: false });
      return Array.isArray(compiled.sections) ? compiled.sections : [];
    } catch {
      return [];
    }
  }

  /**
   * All writes of one round. The version check runs first inside the transaction: an edit made
   * during extraction rolls back everything, including a snapshot this round was about to write.
   */
  commit({ candidates, messages, until, trigger, signature }) {
    const messageIndex = new Map(messages.map((message) => [message.id, message]));
    let sections = [];
    let splitMoves = [];
    const outcome = this.profile.transact(() => {
      if (this.librarySignature() !== signature) {
        const error = new Error('profile library changed while organizing');
        error.code = 'PROFILE_USER_EDITED';
        throw error;
      }
      const counts = this.applyCandidates(candidates, messageIndex);
      // Every library write above is done; the deterministic second side pass runs on the
      // original box-mapped entries BEFORE the compile, so the compile/rewrite below already see
      // the final side/category and a moved sentence is never rewritten into the wrong box.
      splitMoves = this.applySecondSplit();
      // "New content" is a union: an extraction added/updated an entry, or this round moved one
      // across sides. Those sides must be rewritten even when their text box was never edited.
      const changedSides = new Set(counts.changedSides instanceof Set ? counts.changedSides : []);
      for (const move of splitMoves) {
        if (move.moved !== true) continue;
        changedSides.add(move.fromSide);
        changedSides.add(move.toSide);
      }
      // Persist the claimed (entry, exchange) identities inside the same transaction as the
      // evidence rows: the next batch sees them and cannot count the same turn a second time.
      if (Array.isArray(counts.seenExchanges) && counts.seenExchanges.length > 0) {
        const merged = [...new Set([...this.seenExchangeEntries(), ...counts.seenExchanges])].slice(-500);
        this.setState({ seenExchanges: merged });
      }
      const touched = counts.touched instanceof Set ? counts.touched : new Set(counts.touched ?? []);
      // Rule order: evidence is applied first, then the selected set is fixed by score/threshold/
      // budget, and only then do the entries that were neither mentioned nor selected decay once.
      // A selected entry is exempt outright (never "decay then restore"), and a contradiction's
      // drop is already in the score before the selection, so being selected can never offset it.
      const plan = this.profile.rankPlan({ config: this.rankConfig });
      const selectedIds = new Set((plan?.selected ?? []).map((entry) => entry.id));
      const forgottenIds = new Set((plan?.forgotten ?? []).map((entry) => entry.id));
      let decayed = 0;
      for (const entry of this.profile.list()) {
        if (selectedIds.has(entry.id) || touched.has(entry.id) || forgottenIds.has(entry.id)) continue;
        if (entry.locked) continue; // locked entries are exempt from automatic decay too
        const idle = this.profile.recordIdle(entry.id, { hasNewExchange: true });
        if (idle?.applied === true) decayed += 1;
      }
      const compiled = this.profile.compileRank({ config: this.rankConfig });
      sections = Array.isArray(compiled.sections) ? compiled.sections : [];
      const summary = {
        added: counts.added,
        updated: counts.updated,
        adopted: Array.isArray(compiled.selected) ? compiled.selected.length : 0,
        dropped: counts.dropped,
        decayed,
        forgotten: Array.isArray(compiled.applied?.removed) ? compiled.applied.removed.length : 0,
        tokens: Number(compiled.usedTokens) || 0,
      };
      const last = messages[messages.length - 1];
      const previous = this.snapshot();
      const snapshotVersion = (Number(previous?.version) || 0) + 1;
      // The message round keeps the settings-box mapping: only the reconcile line diff owns it.
      this.writeSnapshot(compiled.text, summary.tokens, snapshotVersion, until, previous?.lines ?? []);
      this.setState({
        lastRunAt: until,
        cursor: last === undefined ? formatCursor(until) : formatCursor(last.ts, last.id),
        lastStatus: 'ok',
        lastSummary: summary,
        lastError: null,
        retryAt: null,
        deferredAt: null,
        snapshotVersion,
        lastTrigger: trigger,
      });
      return {
        summary,
        snapshotVersion,
        version: this.librarySignature(),
        splitMoves,
        changedSides: [...changedSides],
        sideCounts: {
          agent: counts.sideIds?.agent?.size ?? 0,
          user: counts.sideIds?.user?.size ?? 0,
        },
        extractEvents: Array.isArray(counts.extractEvents) ? counts.extractEvents : [],
      };
    });
    // Reported only after the transaction returned: a rollback must not leave a stale mismatch or
    // deleted-evidence event behind for a write that never landed.
    for (const event of outcome.extractEvents ?? []) this.emitNow(event.type, event.payload);
    return { ...outcome, sections };
  }

  /**
   * Validate / merge / apply candidates. The model never supplies numbers: a new entry starts
   * neutral and only `recordSupport` (C+10/E+3 per distinct entry/exchange identity) moves it. A
   * candidate without a verifiable message id is dropped and counted. A verified `entryId` reuses
   * exactly that entry; otherwise the conservative `composeFactVerdict` decides whether a live
   * entry states the same fact (subject/object/polarity/condition). Similarity is only a prefilter
   * and never merges a pair on its own; different or unconfirmed conditions stay separate.
   */
  applyCandidates(candidates, messageIndex) {
    const counts = { added: 0, updated: 0, dropped: 0 };
    const updatedIds = new Set();
    const touchedIds = new Set();
    // Sides whose content really changed this round: a new entry, an updated entry or a support /
    // contradiction. The organize write-back rewrites exactly these sides, even when the user did
    // not edit their text box.
    const changedSides = new Set();
    const categories = this.categories();
    // The persistent evidence ledger is the only dedupe authority now. `seenExchanges` is still
    // written for backward-compatible readers, but it is never consulted before a score changes.
    const newPairs = [];
    const newPairSet = new Set();
    const extractEvents = [];
    // Per-side ids touched by this extraction, reported as `profile.extract`.
    const sideIds = { agent: new Set(), user: new Set() };
    const supports = [];
    const contradictions = new Map();
    for (const candidate of Array.isArray(candidates) ? candidates : []) {
      if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
        counts.dropped += 1;
        continue;
      }
      const side = SIDES.includes(candidate.side) ? candidate.side : null;
      const op = candidateOperation(candidate);
      const evidence = this.evidenceMessages(candidateMessageIds(candidate), messageIndex);
      if (evidence.length === 0 || op === null) {
        counts.dropped += 1;
        continue;
      }
      if (op === 'contradict') {
        const target = cleanText(candidate.target_text ?? candidate.targetText
          ?? candidate.target_id ?? candidate.targetId ?? candidate.target ?? candidateEntryId(candidate));
        if (target.length === 0) {
          counts.dropped += 1;
          continue;
        }
        const key = `${side ?? ''}\n${normalizedText(target)}`;
        const group = contradictions.get(key) ?? {
          side, target, evidence: new Map(), sustained: false,
        };
        if (candidateSeverity(candidate.severity) === 'sustained') group.sustained = true;
        for (const message of evidence) group.evidence.set(message.id, message);
        contradictions.set(key, group);
        continue;
      }
      const text = cleanText(candidate.text);
      if (side === null || text.length === 0) {
        counts.dropped += 1;
        continue;
      }
      // A new candidate is routed by the same side/category rule as an existing entry BEFORE it
      // enters the library: 「角色/说话/互动/处事类偏好」 belongs to the agent side, life
      // preferences stay on the user side. The extracted side is only the fallback.
      const decision = classifyProfileEntrySide(
        { text, side, category: cleanText(candidate.category) },
        categories,
      );
      // A one-off instruction ("这次简短点") is not a lasting tendency: drop it, add no entry.
      if (decision?.drop === true) {
        counts.dropped += 1;
        continue;
      }
      const targetSide = decision?.side ?? side;
      const targetText = cleanText(decision?.text)
        || (targetSide === side ? text : normalizeReclassifyText(text, targetSide));
      // `entryId` is a CLAIM, not a write target: the host verifies the row exists, is live, is on
      // the final side and states the same fact (subject/object/polarity/condition). A failed
      // claim is reported and then handled as a new candidate; the claimed entry is untouched.
      const claimedEntryId = candidateEntryId(candidate);
      let claimedEntry = null;
      if (claimedEntryId.length > 0) {
        const claimed = this.profile.get(claimedEntryId);
        let reason = null;
        if (claimed === null) reason = 'missing';
        else if (claimed.rejected === true) reason = 'rejected';
        else if (claimed.side !== targetSide) reason = 'side';
        else if (!this.sameTendency(claimed.text, targetText)) reason = 'tendency';
        if (reason !== null) {
          extractEvents.push({
            type: PROFILE_EXTRACT_MISMATCH_EVENT,
            payload: { entryId: claimedEntryId, side: targetSide, reason },
          });
        } else {
          claimedEntry = claimed;
        }
      }
      // Without a verified claim, reuse a live entry stating the same fact. Similarity is only the
      // compose verdict's prefilter; it never merges a pair on its own, and an unconfirmed condition
      // keeps the candidate independent (it never silently strengthens the other tendency).
      const targetEntry = claimedEntry !== null
        ? claimedEntry
        : (claimedEntryId.length === 0 ? this.findTendencyEntry(targetSide, targetText) : null);
      let group = targetEntry !== null
        ? supports.find((item) => item.entryId === targetEntry.id)
        : supports.find((item) => item.entryId === null
          && item.side === targetSide
          && this.sameTendency(item.text, targetText));
      if (group === undefined) {
        group = targetEntry !== null
          ? {
            side: targetEntry.side,
            category: targetEntry.category,
            text: targetEntry.text,
            entryId: targetEntry.id,
            evidence: new Map(),
          }
          : {
            side: targetSide,
            category: decision?.category ?? '',
            text: targetText,
            entryId: null,
            evidence: new Map(),
          };
        supports.push(group);
      }
      if (group.category.length === 0) {
        group.category = cleanText(decision?.category) || cleanText(candidate.category);
      }
      for (const message of evidence) group.evidence.set(message.id, message);
    }

    for (const group of supports) {
      // A deleted tendency gets only evidence newer than its delete boundary; a backlog read
      // after the delete therefore cannot recreate it.
      const boundary = this.deletionBoundaryFor(group.side, group.text);
      // Store-level deletion boundary: replaying evidence that existed at deletion time is refused
      // even when the legacy in-state boundary was evicted. A newly created message is not in the
      // boundary, so a genuinely new expression may still become a fresh candidate (new scores).
      const surviving = [];
      for (const message of group.evidence.values()) {
        if (this.deletedEvidenceHit(group.side, group.text, message)) {
          extractEvents.push({
            type: PROFILE_EVIDENCE_DELETED_EVENT,
            payload: {
              side: group.side,
              entryId: group.entryId,
              messageId: message.id,
              identity: this.exchangeIdentity(message),
            },
          });
          continue;
        }
        surviving.push(message);
      }
      const evidence = this.uniqueEvidence(surviving, boundary);
      if (evidence.length === 0) {
        counts.dropped += 1;
        continue;
      }
      const existing = group.entryId !== null ? this.profile.get(group.entryId) : this.findEntry(group.side, group.text);
      let entryId = existing?.id ?? null;
      if (entryId === null) {
        const created = this.profile.upsert({
          side: group.side,
          category: group.category,
          text: group.text,
        });
        if (created === null || created.entry === null) {
          counts.dropped += 1;
          continue;
        }
        counts.added += 1;
        changedSides.add(group.side);
        entryId = created.entry.id;
      }
      let touched = false;
      for (const message of evidence) {
        const identity = this.evidenceIdentity(message);
        // Identity is `(entry, session, turn, role)`; the store falls back to the message id when
        // the turn is incomplete. A replay is a ledger no-op, never a second C+10 / E+3.
        const result = this.profile.recordSupport(entryId, {
          messageId: identity.messageId,
          sessionId: identity.sessionId,
          turnId: identity.turnId,
          role: identity.role,
          note: 'profile.maintain',
        });
        if (result === null) break;
        if (result.applied === true) {
          touched = true;
          const pair = `${entryId}\n${this.exchangeIdentity(message)}`;
          if (!newPairSet.has(pair)) {
            newPairSet.add(pair);
            newPairs.push(pair);
          }
        }
      }
      if (touched) {
        touchedIds.add(entryId);
        sideIds[group.side].add(entryId);
        changedSides.add(group.side);
        if (existing !== null) updatedIds.add(entryId);
      }
    }

    for (const item of contradictions.values()) {
      const target = this.findEntry(item.side, item.target);
      if (target === null) {
        counts.dropped += 1;
        continue;
      }
      const boundary = this.deletionBoundaryFor(target.side, target.text);
      const surviving = [];
      for (const message of item.evidence.values()) {
        if (this.deletedEvidenceHit(target.side, target.text, message)) {
          extractEvents.push({
            type: PROFILE_EVIDENCE_DELETED_EVENT,
            payload: {
              side: target.side,
              entryId: target.id,
              messageId: message.id,
              identity: this.exchangeIdentity(message),
            },
          });
          continue;
        }
        surviving.push(message);
      }
      const evidence = this.uniqueEvidence(surviving, boundary);
      if (evidence.length === 0) {
        counts.dropped += 1;
        continue;
      }
      let touched = false;
      for (const message of evidence) {
        const identity = this.evidenceIdentity(message);
        const result = this.profile.recordContradiction(target.id, {
          severity: item.sustained ? 'sustained' : 'occasional',
          messageId: identity.messageId,
          sessionId: identity.sessionId,
          turnId: identity.turnId,
          role: identity.role,
          note: 'profile.maintain',
        });
        if (result === null) break;
        if (result.applied === true) {
          touched = true;
          const pair = `${target.id}\n${this.exchangeIdentity(message)}`;
          if (!newPairSet.has(pair)) {
            newPairSet.add(pair);
            newPairs.push(pair);
          }
        }
      }
      if (touched) {
        touchedIds.add(target.id);
        sideIds[target.side].add(target.id);
        changedSides.add(target.side);
        updatedIds.add(target.id);
      }
    }
    counts.updated = updatedIds.size;
    counts.touched = touchedIds;
    counts.sideIds = sideIds;
    counts.changedSides = changedSides;
    counts.seenExchanges = newPairs;
    counts.extractEvents = extractEvents;
    return counts;
  }

  /**
   * User messages among the cited ids. Only a `user` message is a support/contradiction anchor;
   * the assistant's reply is context. Identity is `(session, turn, role)` — a bare turn collapses
   * unrelated sessions whose turn ids both start at 1.
   */
  evidenceMessages(rawIds, messageIndex) {
    const messages = [];
    for (const id of Array.isArray(rawIds) ? rawIds : []) {
      const message = messageIndex.get(id);
      if (message === undefined || message.role !== 'user') continue;
      messages.push(message);
    }
    return messages;
  }

  /** Evidence identity of one message: `(session, turn, role)`; no turn falls back to the id. */
  exchangeIdentity(message) {
    return message.turn.length > 0
      ? `${message.session}\n${message.turn}\n${message.role}`
      : `id\n${message.id}`;
  }

  /** The identity fields `ProfileStore.recordSupport/recordContradiction` accept. */
  evidenceIdentity(message) {
    return {
      messageId: message.id,
      sessionId: message.session,
      turnId: message.turn,
      role: message.role,
    };
  }

  /**
   * Same-tendency verdict of two tendency texts. Exact whitespace/case-normalized text is always
   * the same tendency (it is the storage identity); otherwise the conservative compose verdict
   * decides on subject / object / polarity / condition. Similarity is only that verdict's
   * prefilter, never a merge reason on its own; a different or unconfirmed condition is no merge.
   */
  sameTendencyVerdict(left, right) {
    const leftKey = normalizedText(left);
    if (leftKey.length > 0 && leftKey === normalizedText(right)) {
      return { same: true, reason: 'identical' };
    }
    return composeFactVerdict(left, right);
  }

  sameTendency(left, right) {
    return this.sameTendencyVerdict(left, right).same === true;
  }

  /**
   * The live entry on `side` that already states this tendency, or null. Used only when the model
   * supplied no `entryId`; a deterministic highest-clarity pick keeps the choice stable.
   */
  findTendencyEntry(side, text) {
    let entries = [];
    try {
      entries = this.profile.list({ side });
    } catch {
      return null;
    }
    let best = null;
    for (const entry of entries) {
      if (entry.rejected === true) continue;
      if (!this.sameTendency(entry.text, text)) continue;
      if (best === null
        || Number(entry.clarity) > Number(best.clarity)
        || (Number(entry.clarity) === Number(best.clarity) && String(entry.id) < String(best.id))) {
        best = entry;
      }
    }
    return best;
  }

  /**
   * True when this message's identity is inside a `deleted_persona` boundary. Checked against the
   * candidate tendency first and then every stored boundary, so a reworded replay of deleted
   * evidence is refused too (the identity of the evidence is what was deleted, not the new wording).
   */
  deletedEvidenceHit(side, text, message) {
    const identity = this.evidenceIdentity(message);
    try {
      if (this.profile.isDeletedEvidence(this.profile.fingerprint(side, text), identity) === true) return true;
      for (const row of this.profile.listDeleted()) {
        if (this.profile.isDeletedEvidence(row.identity, identity) === true) return true;
      }
    } catch {
      return false;
    }
    return false;
  }

  /** One evidence sample per `(session, turn, role)`; a message without a turn falls back to id. */
  uniqueEvidence(messages, boundary = null) {
    const seen = new Set();
    const kept = [];
    for (const message of messages) {
      if (this.blockedByDeletion(message, boundary)) continue;
      const identity = this.exchangeIdentity(message);
      if (seen.has(identity)) continue;
      seen.add(identity);
      kept.push(message);
    }
    return kept;
  }

  /**
   * Persisted `(entryId, exchange)` pairs already counted. Exact duplicate evidence is possible
   * even in one round when the messages arrive in pages separated by successive batches: the
   * `(session, turn, role)` identity, not the message id, is what must stay unique.
   */
  seenExchangeEntries() {
    let parsed = null;
    try {
      parsed = JSON.parse(String(this.state.seenExchanges ?? '[]'));
    } catch {
      parsed = null;
    }
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((pair) => typeof pair === 'string' && pair.includes('\n'));
  }

  /** Evidence boundary of one tendency, or null when it was never deleted. */
  deletionBoundaryFor(side, text) {
    try {
      return this.deletionBoundaries()[this.profile.fingerprint(side, text)] ?? null;
    } catch {
      return null;
    }
  }

  /** Find a live entry by id-then-tendency; a missing side searches both libraries. */
  findEntry(side, target) {
    const byId = typeof this.profile.get === 'function' ? this.profile.get(target) : null;
    if (byId !== null && byId !== undefined && (side === null || side === undefined || byId.side === side)) {
      return byId;
    }
    try {
      for (const candidateSide of side === null || side === undefined ? SIDES : [side]) {
        for (const entry of this.profile.list({ side: candidateSide })) {
          if (normalizedText(entry.text) === normalizedText(target)) return entry;
        }
      }
    } catch {
      return null;
    }
    return null;
  }

  /**
   * Persist the compiled text together with the settings-box mapping. `lines` is the exact
   * `[{entryId, text}]` order the next reconcile diffs against; it is never recomputed from `text`.
   */
  writeSnapshot(text, tokens, version, at, lines = []) {
    const mapping = (Array.isArray(lines) ? lines : [])
      .filter((line) => line !== null && typeof line === 'object'
        && typeof line.entryId === 'string' && line.entryId.length > 0)
      .map((line) => ({ entryId: line.entryId, text: String(line.text ?? '') }));
    this.db.prepare(
      `INSERT INTO profile_snapshot (id, text, tokens, version, lines, updated_at) VALUES ('current', ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET text = excluded.text, tokens = excluded.tokens,
          version = excluded.version, lines = excluded.lines, updated_at = excluded.updated_at`,
    ).run(String(text ?? ''), Math.max(0, Math.floor(Number(tokens) || 0)), version, JSON.stringify(mapping), at);
  }

  /**
   * Default evidence source: message-level rows the auto-memory lane already persisted.
   * Ordering is `(ts, message_id)` and a present cursor key is honoured as a stable page boundary,
   * so two rows in the same millisecond can never be lost or delivered twice.
   */
  readMessagesFromMemory({ since = null, until, limit = this.maxMessages, after = null } = {}) {
    const cursor = after !== null && typeof after === 'object' && typeof after.ts === 'string' ? after : null;
    const args = [until];
    let where = "message_id IS NOT NULL AND role IN ('user', 'assistant') AND ts <= ?";
    if (cursor !== null && cursor.id !== '') {
      where += ' AND (ts > ? OR (ts = ? AND message_id > ?))';
      args.push(cursor.ts, cursor.ts, cursor.id);
    } else {
      where += ' AND ts > ?';
      args.push(cursor?.ts ?? since ?? '');
    }
    return this.db
      .prepare(
        `SELECT message_id AS id, role, session_id AS session, turn_id AS turn,
                CASE WHEN raw_text IS NOT NULL AND raw_text <> '' THEN raw_text ELSE text END AS text,
                ts
           FROM memory_event
          WHERE ${where}
          ORDER BY ts ASC, message_id ASC LIMIT ?`,
      )
      .all(...args, positiveInt(limit, this.maxMessages));
  }

  // ---- P-116 questionnaire, draft, trial, adoption ---------------------------------------
  // These are additive entry points. The questionnaire never creates memory events or profile
  // evidence, never touches the user profile, and never overwrites the persona until the user
  // presses「应用试用」; only「正式采用」 reuses the existing reconcile path to sync entries.

  /** Raw persisted `syncedText` object (null when the key is absent/corrupt). */
  rawSyncedText() {
    const raw = this.state.syncedText;
    if (typeof raw !== 'string') return null;
    try {
      const parsed = JSON.parse(raw);
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  /** Write only the persona side: the quiz has no business touching the user profile. */
  writeAgentText(text) {
    if (typeof this.writePersona !== 'function') {
      throw new Error('persona quiz: persona write is unavailable');
    }
    this.writePersona('agent', String(text ?? ''));
  }

  /** The live draft shown in the dialog (not injected, not in the library). */
  personaQuizDraft() {
    const raw = this.state.personaQuizDraft;
    if (typeof raw !== 'string' || raw.length === 0) return null;
    try {
      const parsed = JSON.parse(raw);
      if (parsed === null || typeof parsed !== 'object' || typeof parsed.text !== 'string') return null;
      return parsed;
    } catch {
      return null;
    }
  }

  /** Monotonic quiz operation number; a late result whose number is old is discarded. */
  personaQuizRevision() {
    const value = Number(this.state.personaQuizRevision);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  }

  /** Claim the next quiz operation; every start / generate / apply / adopt / discard bumps it. */
  nextPersonaQuizRevision() {
    const value = this.personaQuizRevision() + 1;
    this.writeStateSafe({ personaQuizRevision: String(value) });
    return value;
  }

  /** Trial marker, persisted in `profile_maintain_state` and readable before the instance exists. */
  personaTrialState() {
    return readPersonaTrialState(this.db);
  }

  /** Open the questionnaire: ten fixed questions, a fresh revision and the current trial marker. */
  startPersonaQuiz() {
    const revision = this.nextPersonaQuizRevision();
    this.writeStateSafe({ personaQuizDraft: null });
    this.emitNow(PERSONA_QUIZ_EVENTS.started, { revision });
    return {
      ok: true,
      questions: PERSONA_QUIZ_QUESTIONS,
      hint: PERSONA_QUIZ_HINT,
      minAnswers: PERSONA_QUIZ_MIN_ANSWERED,
      revision,
      trial: this.personaTrialState(),
    };
  }

  /**
   * One independent completion over the answered scenarios. All-skipped refuses before the model
   * is called; a result that loses the revision race never becomes the displayed draft.
   */
  async generatePersonaQuiz({ answers = [], revision = null, signal } = {}) {
    const normalized = normalizePersonaQuizAnswers(answers);
    if (normalized.answered < PERSONA_QUIZ_MIN_ANSWERED) {
      return {
        ok: false,
        code: PERSONA_QUIZ_ERRORS.empty,
        error: '至少回答一题才能生成',
        answered: 0,
        questions: PERSONA_QUIZ_QUESTIONS,
        revision: this.personaQuizRevision(),
      };
    }
    // The request revision is advisory: every generate claims a NEW operation number below, and
    // the completion check is what discards a late result. Not rejecting an older request keeps a
    // retry after a model failure possible (the failed attempt also advanced the number).
    const seq = this.nextPersonaQuizRevision();
    const budget = PERSONA_QUIZ_PROMPT_BUDGET_TOKENS;
    const existingAgent = this.readBoxes().agent;
    const prompt = buildPersonaQuizPrompt({ answers: normalized.answers, existingAgent, budget });
    let raw;
    try {
      raw = await this.personaQuizGenerator({
        system: PERSONA_QUIZ_SYSTEM,
        prompt,
        answers: normalized.answers,
        budget,
        signal,
      });
    } catch (error) {
      if (this.personaQuizRevision() !== seq) {
        return { ok: false, code: PERSONA_QUIZ_ERRORS.stale, stale: true, error: '草案已过期，请重新生成' };
      }
      return { ok: false, error: error?.message ?? String(error) };
    }
    if (this.personaQuizRevision() !== seq) {
      return { ok: false, code: PERSONA_QUIZ_ERRORS.stale, stale: true, error: '草案已过期，请重新生成' };
    }
    let text;
    try {
      text = parsePersonaQuizDraft(raw);
    } catch (error) {
      return { ok: false, error: error?.message ?? String(error) };
    }
    text = enforcePersonaQuizTone(stripPersonaUserProfileBlocks(text));
    const tokens = estimateProfileTokens(text);
    if (tokens > budget) {
      return {
        ok: false,
        code: PERSONA_QUIZ_ERRORS.overBudget,
        error: `草案超出提示词预算（${tokens}/${budget} tokens）`,
        tokens,
        budget,
      };
    }
    this.writeStateSafe({
      personaQuizDraft: {
        text,
        at: this.at().toISOString(),
        revision: seq,
      },
    });
    await this.emitSafe(PERSONA_QUIZ_EVENTS.drafted, {
      chars: text.length,
      tokens,
      answered: normalized.answered,
      revision: seq,
    });
    return {
      ok: true,
      draft: text,
      text,
      tokens,
      budget,
      revision: seq,
      answered: normalized.answered,
      skipped: normalized.skipped,
      questions: PERSONA_QUIZ_QUESTIONS,
      trial: this.personaTrialState(),
    };
  }

  /**
   * Apply the editable draft as a TRIAL: the persona box is replaced and injected, the previous
   * text is saved for「放弃试用」, and the library/evidence are deliberately untouched.
   */
  applyPersonaQuizTrial({ text = null, revision = null } = {}) {
    const draft = this.personaQuizDraft();
    const next = cleanText(text ?? draft?.text ?? '');
    if (next.length === 0) {
      return { ok: false, code: PERSONA_QUIZ_ERRORS.empty, error: '草案为空，无法应用试用' };
    }
    if (revision !== null && revision !== undefined && Number(revision) !== this.personaQuizRevision()) {
      return { ok: false, code: PERSONA_QUIZ_ERRORS.stale, stale: true, error: '草案已过期，请重新生成' };
    }
    const previous = this.personaTrialState();
    const boxes = this.readBoxes();
    const legacyImportAt = previous.active === true
      ? previous.legacyImportAt ?? null
      : (typeof this.state.legacyImportAt === 'string' ? this.state.legacyImportAt : null);
    const at = this.at().toISOString();
    const trial = {
      active: true,
      text: next,
      backup: previous.active === true ? previous.backup : boxes.agent,
      boxesAuthoritative: previous.active === true ? previous.boxesAuthoritative === true : this.boxesAuthoritative(),
      syncedText: previous.active === true ? previous.syncedText ?? null : this.rawSyncedText(),
      legacyImportAt,
      at,
    };
    try {
      this.writeAgentText(next);
    } catch (error) {
      return { ok: false, error: error?.message ?? String(error) };
    }
    this.markBoxesAuthoritative();
    // Mark the trial text as "already synced" ONLY while trialing: the scheduled reconcile then
    // sees no pending agent edit and cannot turn the temporary text into library entries.
    this.writeStateSafe({
      personaTrial: trial,
      syncedText: { ...this.syncedTexts(), agent: next },
      personaQuizDraft: null,
      // The first-launch seed must not import the temporary text either; discard restores the
      // pre-trial marker so the old persona can still be seeded later.
      ...(legacyImportAt === null ? { legacyImportAt: at } : {}),
    });
    const currentRevision = this.nextPersonaQuizRevision();
    this.emitNow(PERSONA_QUIZ_EVENTS.applied, { chars: next.length, revision: currentRevision });
    return { ok: true, trial: this.personaTrialState(), text: next, revision: currentRevision };
  }

  /** Trial-time edit: the current injected text changes; the library still does not. */
  updatePersonaQuizTrialText({ text = '' } = {}) {
    const trial = this.personaTrialState();
    if (trial.active !== true) {
      return { ok: false, code: PERSONA_QUIZ_ERRORS.noTrial, error: '当前没有试用中的文本' };
    }
    const next = cleanText(text);
    this.writeAgentText(next);
    this.writeStateSafe({
      personaTrial: { ...trial, text: next },
      syncedText: { ...this.syncedTexts(), agent: next },
    });
    const revision = this.nextPersonaQuizRevision();
    return { ok: true, trial: this.personaTrialState(), text: next, revision };
  }

  /** Formal adoption: restore the pre-trial sync marker, then reuse the existing reconcile path. */
  adoptPersonaQuizTrial({ text = null } = {}) {
    const trial = this.personaTrialState();
    if (trial.active !== true) {
      return { ok: false, code: PERSONA_QUIZ_ERRORS.noTrial, error: '还没有应用试用' };
    }
    const finalText = cleanText(text ?? trial.text ?? this.readBoxes().agent);
    if (finalText.length === 0) {
      return { ok: false, code: PERSONA_QUIZ_ERRORS.empty, error: '试用文本为空，无法正式采用' };
    }
    this.writeAgentText(finalText);
    // Reconcile is a user-edit path: make it see the text as changed relative to the last sync.
    this.writeStateSafe({ syncedText: trial.syncedText ?? null });
    const result = this.reconcile({ agent: finalText, trigger: 'quiz-adopt' });
    if (result?.ok !== true) {
      // Keep the trial alive and re-arm the no-auto-import guard.
      this.writeStateSafe({ syncedText: { ...this.syncedTexts(), agent: finalText } });
      return result ?? { ok: false, error: '同步人设库失败' };
    }
    this.writeStateSafe({ personaTrial: null, personaQuizDraft: null, boxesAuthoritative: '1' });
    const revision = this.nextPersonaQuizRevision();
    this.emitNow(PERSONA_QUIZ_EVENTS.adopted, {
      added: result.added ?? 0,
      updated: result.updated ?? 0,
      removed: result.removed ?? 0,
      revision,
    });
    return { ...result, ok: true, trial: this.personaTrialState(), text: finalText, revision };
  }

  /** Abandon the trial: restore the pre-trial persona text and the pre-trial sync marker. */
  discardPersonaQuizTrial() {
    const trial = this.personaTrialState();
    if (trial.active !== true) {
      return { ok: true, restored: false, trial: this.personaTrialState() };
    }
    const backup = trial.backup ?? '';
    this.writeAgentText(backup);
    this.writeStateSafe({
      syncedText: trial.syncedText ?? null,
      boxesAuthoritative: trial.boxesAuthoritative === true ? '1' : null,
      legacyImportAt: trial.legacyImportAt ?? null,
      personaTrial: null,
      personaQuizDraft: null,
    });
    const revision = this.nextPersonaQuizRevision();
    this.emitNow(PERSONA_QUIZ_EVENTS.discarded, { restored: true, revision });
    return { ok: true, restored: true, text: backup, trial: this.personaTrialState(), revision };
  }

  async extractWithModel({ messages, existing, signal }) {
    const text = await this.complete({
      system: EXTRACT_SYSTEM,
      prompt: buildExtractPrompt({ messages, existing }),
      phase: 'extract',
      signal,
    });
    return parseExtractCandidates(text);
  }

  /**
   * Default completion over the Harness llm stream (no tools, no conversation injection).
   *
   * Provider streams differ: the body may arrive in `text`, `delta` or `content` frames, and some
   * streams only emit private reasoning. Reasoning is counted but never becomes the answer. Only a
   * normal finish (stop/completed/end, no truncated flag) proves the whole body arrived, so a
   * partial body is never returned. An empty answer is retried once with a stricter instruction
   * and a raised ceiling — a `max-tokens` truncation raises it much further and forbids the
   * reasoning outright; any other unfinished answer fails at once with the stream scene
   * (finish / frame count / character counts — never the generated text itself).
   */
  async completeWithLlm({ system, prompt, phase = null, signal } = {}) {
    const service = this.getSelection();
    const selection = typeof service?.currentSelection === 'function' ? service.currentSelection() : service;
    const provider = String(selection?.provider ?? '');
    const model = String(selection?.model ?? '');
    if (provider.length === 0 || model.length === 0) {
      throw new Error('profile maintain: no default model is selected');
    }
    const llm = this.getLlm();
    if (llm === undefined || llm === null || typeof llm.stream !== 'function') {
      throw new Error('profile maintain: llm service is unavailable');
    }
    this.lastCompletionStats = null;
    const sceneOf = (state) => modelDetails({
      finish: state.finish,
      chunks: state.chunks,
      text: state.text,
      reasoningChars: state.reasoningChars,
      model,
      provider,
    });
    // One attempt: fresh timeout, body collected from any delta field, reasoning only counted.
    const attempt = async (attemptSystem, maxTokens) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      timer.unref?.();
      const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      const state = { text: '', finish: '', chunks: 0, reasoningChars: 0, truncated: false };
      try {
        const assistTask = ASSIST_PHASES[String(phase ?? '')];
        if (assistTask !== undefined && this.assist !== null) {
          // The assist purpose owns the request shape (explicit no-reasoning, fast-path context);
          // this completion still owns its budget, timer and completeness retry.
          const assisted = await this.assist({
            task: assistTask,
            system: attemptSystem,
            prompt,
            maxTokens,
            signal: combined,
            timeoutMs: this.timeoutMs,
            phase,
          });
          state.chunks = 1;
          state.text = typeof assisted === 'string'
            ? assisted
            : (typeof assisted?.text === 'string' ? assisted.text : '');
          state.reasoningChars = Number(assisted?.reasoningChars) || 0;
          state.truncated = assisted?.truncated === true;
          state.finish = String(assisted?.finishKind ?? (assisted?.complete === true ? 'stop' : 'end'));
        } else {
          const stream = llm.stream({
            provider,
            model,
            system: attemptSystem,
            messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
            maxTokens,
            signal: combined,
          });
          for await (const chunk of stream) {
            state.chunks += 1;
            if (typeof chunk === 'string') {
              state.text += chunk;
              continue;
            }
            if (chunk?.truncated === true || chunk?.finish?.truncated === true) state.truncated = true;
            const type = String(chunk?.type ?? '').toLowerCase();
            if (MODEL_REASONING_FRAME.test(type)) {
              state.reasoningChars += modelChunkText(chunk).length;
              continue;
            }
            const finish = modelChunkFinish(chunk);
            if (finish.length > 0) state.finish = finish;
            state.text += modelChunkText(chunk);
          }
        }
      } catch (error) {
        // A user/model cancel keeps its own error; anything else carries the stream scene.
        if (signal?.aborted === true) throw error;
        const scene = sceneOf({ ...state, finish: state.finish || 'error' });
        const wrapped = new Error(`profile maintain: model stream failed ${JSON.stringify(scene)}: ${error?.message ?? error}`);
        wrapped.code = 'MODEL_STREAM_ERROR';
        wrapped.cause = error;
        wrapped.details = scene;
        throw wrapped;
      } finally {
        clearTimeout(timer);
      }
      if (state.finish.length === 0) state.finish = 'end';
      this.lastCompletionStats = sceneOf(state);
      return state;
    };

    const first = await attempt(system, this.maxTokens);
    const firstCompleted = modelFinishCompleted(first.finish, first.truncated);
    if (firstCompleted && first.text.trim().length > 0) return first.text;
    await this.emitSafe(PROFILE_MODEL_EVENTS.empty, {
      phase,
      finish: first.finish,
      textChars: first.text.length,
      reasoningChars: first.reasoningChars,
    });
    if (signal?.aborted === true) {
      const error = new Error('profile maintain: model call aborted');
      error.code = 'ABORTED';
      throw error;
    }
    const truncated = first.truncated === true || modelTruncatedFinish(first.finish);
    // A failed/aborted answer is not retryable: its partial body must never be accepted, and a
    // second call would only repeat the same failure. Only a budget truncation gets the one retry.
    if (!firstCompleted && !truncated) throw modelIncompleteError(sceneOf(first));
    // A truncated answer means the budget was consumed by reasoning: raise it far beyond the
    // first attempt and tell the model to answer directly. This retry happens at most once.
    const retryMaxTokens = modelRetryMaxTokens(this.maxTokens, truncated);
    await this.emitSafe(PROFILE_MODEL_EVENTS.retry, {
      phase,
      reason: truncated ? 'max-tokens' : 'empty',
      from: this.maxTokens,
      to: retryMaxTokens,
    });
    const retry = await attempt(
      strictModelSystem(phase, system, { truncated }),
      retryMaxTokens,
    );
    const retryCompleted = modelFinishCompleted(retry.finish, retry.truncated);
    if (retryCompleted && retry.text.trim().length > 0) return retry.text;
    await this.emitSafe(PROFILE_MODEL_EVENTS.empty, {
      phase,
      finish: retry.finish,
      textChars: retry.text.length,
      reasoningChars: retry.reasoningChars,
    });
    // A non-empty body on an unfinished retry is still a failure: EMPTY_TEXT is only for no text.
    throw retry.text.trim().length > 0 && !retryCompleted
      ? modelIncompleteError(sceneOf(retry))
      : modelEmptyError(sceneOf(retry));
  }
}

/**
 * Create the incremental organizer. Every dependency (clock, message source, extractor, busy
 * probe, event sink) is injectable, so tests never call a real model.
 */
export function createProfileMaintainer(options = {}) {
  return new ProfileMaintainer(options);
}
