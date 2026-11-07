/** maintain-config — extracted from profileMaintain.js; no host entry dependency. */
import { PROFILE_RANK_DEFAULTS } from './profileRank.js';

/** Default period between rounds. */
export const PROFILE_MAINTAIN_INTERVAL_DAYS = 7;

export const PROFILE_MAINTAIN_INTERVAL_MS = PROFILE_MAINTAIN_INTERVAL_DAYS * 24 * 60 * 60 * 1000;


/** After a failure, retry no sooner than this (a failed round keeps the old snapshot). */
export const PROFILE_MAINTAIN_RETRY_MS = 60 * 60 * 1000;


/** How often the scheduler checks whether the round is due. */
export const PROFILE_MAINTAIN_TICK_MS = 10 * 60 * 1000;


/** A chat turn older than this is stale bookkeeping, never an active round. */
export const PROFILE_MAINTAIN_TURN_STALE_MS = 30 * 60 * 1000;


/** Upper bound on one extraction batch, so a long absence cannot build an unbounded prompt. */
export const PROFILE_MAINTAIN_MESSAGE_LIMIT = 400;


/** One page of the message read; a round walks pages until it runs out or reaches the limit. */
export const PROFILE_MAINTAIN_PAGE_SIZE = 200;


/** Event names written through the host event log. */
export const PROFILE_MAINTAIN_EVENTS = Object.freeze({
  started: 'profile.maintain.started',
  progress: 'profile.maintain.progress',
  summary: 'profile.maintain.summary',
  failed: 'profile.maintain.failed',
  aborted: 'profile.maintain.aborted',
  skipped: 'profile.maintain.skipped',
  // A deferred/queued round carries the concrete reason and the state that caused it.
  busy: 'profile.maintain.busy',
});


/** The compiled profile block that rides in the real system prompt. */
export const PROFILE_PROMPT_TITLE = '## 人设与偏好（自动整理）';


/** Approximate-token ceiling; reuses the rank compiler's existing total budget (default 600). */
export const PROFILE_PROMPT_BUDGET_TOKENS = PROFILE_RANK_DEFAULTS.totalBudget;


/** Prompt-section outcome events (one read per request, emitted best-effort). */
export const PROFILE_PROMPT_EVENTS = Object.freeze({
  injected: 'profile.prompt.injected',
  skipped: 'profile.prompt.skipped',
});


/** One-time legacy persona import events (kept for the seed report, no model split any more). */
export const PROFILE_IMPORT_EVENTS = Object.freeze({
  done: 'profile.import.done',
  failed: 'profile.import.failed',
});


/** Difference reconciliation of the settings-box prompt (replaces the one-time model split). */
export const PROFILE_RECONCILE_EVENTS = Object.freeze({
  reconciled: 'profile.reconcile',
  failed: 'profile.reconcile.failed',
});


/** Minimum 0..1 similarity for a changed line to count as "the same line, edited". */
export const PROFILE_RECONCILE_SIMILARITY = 0.72;


/** A genuinely new prompt line with no original entry on its side starts neutral. */
export const PROFILE_RECONCILE_DEFAULT_CLARITY = 50;

export const PROFILE_RECONCILE_DEFAULT_EFFICACY = 50;


/**
 * Save path: persist the two box texts ONLY. No split, no library write, no rewrite — the box is
 * a trial area and stays pending until an explicit organize round imports it.
 */
export const PROFILE_SAVE_EVENT = 'profile.save';


/** Internal split step (used by the organize round, never by the save path). */
export const PROFILE_SPLIT_EVENTS = Object.freeze({
  split: 'profile.split',
  failed: 'profile.split.failed',
  // A split result that lost the race against a newer user save; it is never committed.
  aborted: 'profile.split.aborted',
  // One fragment the model moved from the other box: the revision record carries fromSide/toSide.
  moved: 'profile.split.moved',
});


/** Writeback: the composed prompt is written back into the box and persisted (no split). */
export const PROFILE_WRITEBACK_EVENT = 'profile.writeback';


/** Writeback skipped because the user edited the box while the round was waiting. */
export const PROFILE_WRITEBACK_SKIPPED_EVENT = 'profile.writeback.skipped';


/** A side's mapping/synced text was not written because a newer save owns that side. */
export const PROFILE_WRITEBACK_MAPPING_SKIPPED_EVENT = 'profile.writeback.mapping-skipped';


/**
 * A box (settings JSON) and the library (SQLite) are not one transaction: when the box write or the
 * final commit fails, the mismatch is REPORTED (event + round error), never silently skipped.
 */
export const PROFILE_WRITEBACK_FAILED_EVENT = 'profile.writeback.failed';


/** Compose: the agent rewrites the selected fragments into one natural injectable prompt. */
export const PROFILE_COMPOSE_EVENTS = Object.freeze({
  composed: 'profile.compose',
  failed: 'profile.compose.failed',
  // The deterministic compiled section replaced the failed rewrite and was written back.
  fallback: 'profile.compose.fallback',
  overBudget: 'profile.compose.over-budget',
  // The rewrite failed a host quality gate; the source sentences are written instead.
  rejected: 'profile.compose.rejected',
  // Debug-level record of one duplicate pair that WAS merged; throttled, never the prompt text.
  merge: 'profile.compose.merge',
});


/** Extraction: one round's agent-extracted candidates, split by side. */
export const PROFILE_EXTRACT_EVENT = 'profile.extract';


/**
 * Extraction cited an `entryId` that does not exist, is rejected, belongs to the other side, or
 * whose stored tendency the host cannot confirm as the same fact. The candidate is then filed as a
 * new candidate; the claimed entry is never strengthened blindly.
 */
export const PROFILE_EXTRACT_MISMATCH_EVENT = 'profile.extract.entry-mismatch';


/**
 * Evidence was refused because its identity is inside a `deleted_persona` boundary. This is the
 * store boundary speaking, not a permanent ban: a newly expressed tendency may still be filed.
 */
export const PROFILE_EVIDENCE_DELETED_EVENT = 'profile.evidence.deleted';


/**
 * Low-level model-stream outcomes. A truncated answer is retried once (an empty one too); each
 * rejected attempt reports the scene (`finish`, character counts), and the retry itself reports
 * why and how far the ceiling moved (`{phase, reason, from, to}`) so support can count truncated
 * retries. Neither event ever stores the generated text.
 */
export const PROFILE_MODEL_EVENTS = Object.freeze({
  empty: 'profile.model.empty',
  retry: 'profile.model.retry',
});


/** Tone repair: one extra completion over the violating sentences only (never the whole text). */
export const PROFILE_TONE_EVENTS = Object.freeze({
  repair: 'profile.tone.repair',
  fallback: 'profile.tone.fallback',
  // A sentence the host could not classify safely: it is kept verbatim rather than rewritten.
  unresolved: 'profile.tone.unresolved',
});


const SPLIT_SYSTEM = '你是人设/画像拆分器。只输出约定的 JSON，不解释，不输出分数、C/E、rank 或任何 0-100 的数值。';


const RECLASSIFY_SYSTEM = '你是人设/画像分类复核器。只输出约定的 JSON，不解释，不输出分数、C/E、rank 或任何 0-100 的数值。';


const TONE_REPAIR_SYSTEM = '你是人设/画像口吻修复器。只输出约定的 JSON 数组，不解释，不新增或删除任何约束。';


/**
 * The auxiliary completions that use the lightweight `assist` purpose: same shared completion
 * contract (budget, completeness retry, stats), but the request goes through the fast path's
 * assist seam with an explicit non-reasoning policy. Structured organization (extract / split /
 * reclassify) keeps the shared completion and its current reasoning policy: only these four
 * phases switch, and `compose` is the persona rewrite.
 */
const ASSIST_PHASES = Object.freeze({
  tone: 'tone-repair',
  compose: 'persona-rewrite',
  persona: 'persona-quiz',
  'avatar-style': 'motion-style',
});


/**
 * The category stack (`profile_category`) is seeded with these presets on first launch and then
 * maintained by the organizer: the model may reuse, add, retitle or drop a category, but only the
 * host decides what is accepted (see `planCategoryOps`).
 */
export const PROFILE_CATEGORY_PRESETS = Object.freeze([
  Object.freeze({ name: '人设参考', parent: 'agent', description: '助手可以借鉴的角色设定、气质与自我定位' }),
  Object.freeze({ name: '相处方式', parent: 'agent', description: '助手和用户相处时的态度、分寸与边界' }),
  Object.freeze({ name: '说话方式', parent: 'agent', description: '助手的语气、节奏、长度与用词习惯' }),
  Object.freeze({ name: '形象', parent: 'agent', description: '助手的身份、外貌与外在设定' }),
  Object.freeze({ name: '饮食', parent: 'user', description: '用户吃喝相关的偏好与习惯' }),
  Object.freeze({ name: '运动', parent: 'user', description: '用户运动与身体活动相关的事实' }),
  Object.freeze({ name: '娱乐', parent: 'user', description: '用户喜欢的作品、游戏、音乐与消遣方式' }),
  Object.freeze({ name: '生活习惯', parent: 'user', description: '用户的作息、作息环境与日常安排' }),
]);


/** Host limits for a model-proposed category (a name is short, a description is one sentence). */
export const PROFILE_CATEGORY_MAX_NAME = 20;

export const PROFILE_CATEGORY_MAX_DESCRIPTION = 60;


/** Category-stack events: what the host accepted, changed or refused. */
export const PROFILE_CATEGORY_EVENTS = Object.freeze({
  added: 'profile.category.added',
  updated: 'profile.category.updated',
  rejected: 'profile.category.rejected',
  // A user-created category: `{name, parent}` (the model's own op uses `added`).
  created: 'profile.category.created',
});


/** 「库编辑」events: one entry's text/category was edited, or the entry was deleted. */
export const PROFILE_ENTRY_EVENTS = Object.freeze({
  updated: 'profile.entry.updated',
  deleted: 'profile.entry.deleted',
});


/** Revision author of a direct user edit (text/category); allow-listed by the migration below. */
export const PROFILE_ENTRY_EDIT_SOURCE = 'user-edit';


/** Revision author of a direct user deletion; allow-listed by the migration below. */
export const PROFILE_ENTRY_DELETE_SOURCE = 'user-delete';


/** Origin written for a category the user creates by hand (model categories keep `model`). */
export const PROFILE_CATEGORY_USER_SOURCE = 'user';


/**
 * One-shot legacy-library reclassification: preview first, then an explicitly confirmed apply.
 * The event payload is only `{count}`; scores/evidence are never part of this path.
 */
export const PROFILE_RECLASSIFY_EVENTS = Object.freeze({
  // One preview is computed for the current library: `{total, noise, inBoxOnly}`.
  preview: 'profile.reclassify.preview',
  // A per-row selection was committed: `{moved, deleted}` (no score/evidence payload).
  applied: 'profile.reclassify.applied',
  // The defence moved a user self-description that had been rewritten as a 「你不要…」 rule.
  misplaced: 'profile.reclassify.misplaced',
});


/** Revision author of an applied reclassification (also allow-listed in the revision table). */
export const PROFILE_RECLASSIFY_SOURCE = 'reclassify';


/** Revision author of an explicitly confirmed noise cleanup (also allow-listed). */
export const PROFILE_CLEANUP_SOURCE = 'cleanup';


/** One confirmed noise cleanup event: `{entryId, reason, source:'cleanup'}`. */
export const PROFILE_CLEANUP_EVENT = 'profile.cleanup';


/**
 * Formatting-insensitive identity of a category name: full-width/half-width forms (NFKC), case
 * and inner spaces never matter, so 「ＡＢＣ」 and 「abc」 are the same name.
 */
export const categoryKey = (value) => cleanText(value).normalize('NFKC').replace(/\s+/gu, '').toLowerCase();


const COMPOSE_SYSTEM = '你是人设提示词撰写者。只输出重写后的提示词正文：1-3 个自然段的通顺句子，不逐条列举，不解释，不输出分数、C/E、分类标签或项目符号。';


/**
 * Framing phrases the splitter drops before a fragment is stored. The model is told to remove
 * them, but the host enforces it too: 「你是一名妹系美少女角色」 must never become an entry with
 * the frame still attached.
 */
const SPLIT_FRAMING = Object.freeze({
  agent: Object.freeze([
    /^你的?人设(?:是|为)?/u,
    /^你(?:是|为)(?:一名|一个|一位|一只|个)?/u,
    /^(?:一名|一个|一位|一只|个)\s*/u,
  ]),
  user: Object.freeze([
    /^用户(?:的画像)?(?:是|为)?/u,
    /^我的画像(?:是|为)?/u,
    /^我(?:是|为)(?:一名|一个|一位)?/u,
    /^(?:一名|一个|一位|一只|个)\s*/u,
  ]),
});


const SIDES = Object.freeze(['agent', 'user']);

const ZERO_SUMMARY = Object.freeze({
  added: 0,
  updated: 0,
  adopted: 0,
  dropped: 0,
  decayed: 0,
  forgotten: 0,
  tokens: 0,
});


const EXTRACT_SYSTEM = '你是人设/偏好整理器。只输出约定的 JSON，不解释，不输出分数、C/E 或任何 0-100 数值。';


const SCHEMA = Object.freeze([
  `CREATE TABLE IF NOT EXISTS profile_snapshot (
    id TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    tokens INTEGER NOT NULL,
    version INTEGER NOT NULL,
    lines TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS profile_maintain_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  // The category stack: one row per category, owned by the organizer (presets, then model edits).
  `CREATE TABLE IF NOT EXISTS profile_category (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    parent TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'preset',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
]);


const cleanText = (value) => String(value ?? '').trim();


const normalizedText = (value) => cleanText(value).replace(/\s+/gu, ' ').toLowerCase();


const positiveInt = (value, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
};


/** Private-reasoning frames: counted for diagnostics, never appended to the answer body. */
const MODEL_REASONING_FRAME = /^(reasoning|thinking|thought|analysis|redacted)/u;


/**
 * Formatting-insensitive identity of one prompt line. Bullets, `[分类]` markers, a trailing
 * `（C=…, E=…）` decoration and whitespace belong to the display, never to the tendency, so a
 * pure format/order change can never create or delete an entry.
 */
const promptKey = (value) => cleanText(value).replace(/\s+/gu, ' ').toLowerCase();

export {
  SPLIT_SYSTEM,
  RECLASSIFY_SYSTEM,
  TONE_REPAIR_SYSTEM,
  ASSIST_PHASES,
  COMPOSE_SYSTEM,
  SPLIT_FRAMING,
  SIDES,
  ZERO_SUMMARY,
  EXTRACT_SYSTEM,
  SCHEMA,
  cleanText,
  normalizedText,
  positiveInt,
  MODEL_REASONING_FRAME,
  promptKey,
};
