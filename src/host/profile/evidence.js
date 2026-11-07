/** evidence — extracted from profileMaintain.js; no host entry dependency. */
import { estimateProfileTokens } from './profileRank.js';
import { PROFILE_PROMPT_BUDGET_TOKENS, cleanText, positiveInt, promptKey } from './maintain-config.js';

/** Stored `lines` column → `[{entryId, text}]`; a legacy/corrupt value reads as no mapping. */
function parseSnapshotLines(value) {
  try {
    const parsed = JSON.parse(String(value ?? '[]'));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((line) => line !== null && typeof line === 'object'
        && typeof line.entryId === 'string' && line.entryId.length > 0)
      .map((line) => ({ entryId: line.entryId, text: String(line.text ?? '') }));
  } catch {
    return [];
  }
}


/** True when two mappings hold the same `(entryId, text)` pairs — order and format are ignored. */
function sameMapping(left, right) {
  if (left.length !== right.length) return false;
  const keys = (lines) => lines.map((line) => `${line.entryId}\n${promptKey(line.text)}`).sort();
  const a = keys(left);
  const b = keys(right);
  return a.every((value, index) => value === b[index]);
}


/**
 * The read cursor is a stable `(ts, id)` key, never a bare timestamp: two messages may share a
 * millisecond, and a page limit must not round the boundary in either direction. `id === ''`
 * means a pure time bound (legacy cursor or "nothing after this instant").
 */
function parseCursorValue(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (raw.length === 0) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object'
      && typeof parsed.ts === 'string' && parsed.ts.length > 0) {
      return { ts: parsed.ts, id: typeof parsed.id === 'string' ? parsed.id : '' };
    }
  } catch {
    /* a pre-pagination cursor was a bare ISO timestamp: keep it as a time-only bound */
  }
  return { ts: raw, id: '' };
}


const formatCursor = (ts, id = '') => JSON.stringify({ ts: String(ts), id: String(id ?? '') });


/** Stable order of the read: timestamp first, message id to break ties (matches SQLite TEXT). */
const compareMessageKeys = (left, right) => {
  if (left.ts !== right.ts) return left.ts < right.ts ? -1 : 1;
  if (left.id === right.id) return 0;
  return left.id < right.id ? -1 : 1;
};


/** True when a message is at or before the cursor key (already delivered in an earlier page). */
const atOrBeforeCursor = (cursor, message) => {
  if (cursor === null || cursor === undefined) return false;
  if (message.ts > cursor.ts) return false;
  if (message.ts < cursor.ts) return true;
  if (cursor.id === '') return true;
  return !(message.id > cursor.id);
};


/** One row of the message source → the shape the extractor/prompt sees; invalid rows are null. */
function normalizeMessage(message) {
  if (message === null || typeof message !== 'object') return null;
  const id = typeof message.id === 'string' ? message.id.trim() : '';
  const ts = String(message.ts ?? '');
  if (id.length === 0 || !Number.isFinite(Date.parse(ts))) return null;
  return {
    id,
    role: message.role === 'assistant' ? 'assistant' : 'user',
    text: String(message.text ?? ''),
    ts,
    // Evidence identity is `(session, turn, role)`, never a bare turn: turn ids restart at 1 in
    // every session, and two messages of one turn are one support, not two.
    session: cleanText(message.session_id ?? message.sessionId ?? message.session ?? ''),
    turn: cleanText(message.turn ?? message.turn_id ?? message.turnId ?? ''),
  };
}


/** Candidate ids in every shape a model reasonably emits; empty/invalid ids are removed. */
function candidateMessageIds(candidate) {
  const values = [];
  if (Array.isArray(candidate?.message_ids)) values.push(...candidate.message_ids);
  else if (Array.isArray(candidate?.messageIds)) values.push(...candidate.messageIds);
  for (const key of ['message_id', 'messageId']) {
    if (candidate?.[key] !== undefined) values.push(candidate[key]);
  }
  return [...new Set(
    values
      .map((value) => (typeof value === 'string' ? value.trim() : String(value ?? '').trim()))
      .filter((value) => value.length > 0),
  )];
}


/** The live entry a candidate claims to continue, in either spelling the model uses. */
function candidateEntryId(candidate) {
  return cleanText(candidate?.entryId ?? candidate?.entry_id);
}


function candidateOperation(candidate) {
  const op = cleanText(candidate?.op ?? candidate?.kind ?? 'support').toLowerCase();
  if (['contradict', 'contradiction', 'contra', 'negative', 'refute'].includes(op)) return 'contradict';
  if (['support', 'supports', 'positive'].includes(op)) return 'support';
  return null;
}


function candidateSeverity(value) {
  const severity = cleanText(value).toLowerCase();
  if (severity === 'sustained') return 'sustained';
  if (severity === 'occasional' || severity === 'vague') return severity;
  return 'occasional';
}


/**
 * Loose JSON decoder shared by the extractor and the splitter: accepts a value, a code-fenced
 * JSON text, or a text with a JSON object embedded in it. A payload with no JSON throws.
 */
function parseJsonPayload(value, message) {
  const text = String(value ?? '')
    .replace(/^```(?:json)?/iu, '')
    .replace(/```$/u, '')
    .trim();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error(message);
    return JSON.parse(text.slice(start, end + 1));
  }
}


/**
 * Parse the extractor output. Accepts an array, `{candidates: []}`, or JSON text (code fences
 * included). A malformed payload throws: the round then fails without touching the snapshot.
 */
export function parseExtractCandidates(value) {
  if (Array.isArray(value)) return value;
  if (value !== null && typeof value === 'object') {
    if (Array.isArray(value.candidates)) return value.candidates;
    return [];
  }
  const parsed = parseJsonPayload(value, 'profile maintain: extractor returned non-JSON text');
  if (Array.isArray(parsed)) return parsed;
  if (parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.candidates)) return parsed.candidates;
  return [];
}


/**
 * Compose the profile block injected into the system prompt. This is the single size gate: an
 * over-budget snapshot is skipped whole (a compiled line is never sliced), and an absent/empty
 * snapshot renders nothing so the existing persona section remains the fallback.
 */
export function formatProfilePrompt(text, { budget = PROFILE_PROMPT_BUDGET_TOKENS } = {}) {
  const body = cleanText(text);
  if (body.length === 0) return { text: '', entries: 0, tokens: 0, skipped: null };
  const tokens = estimateProfileTokens(body);
  const ceiling = positiveInt(budget, PROFILE_PROMPT_BUDGET_TOKENS);
  if (tokens > ceiling) return { text: '', entries: 0, tokens, skipped: 'over-budget' };
  const entries = body.split('\n').filter((line) => line.startsWith('- [')).length;
  return { text: body, entries, tokens, skipped: null };
}


/**
 * The prompt the default extractor sends. Message ids are carried verbatim so the host can
 * verify them; scores are explicitly the host's job, so no number can be smuggled in by text.
 */
export function buildExtractPrompt({ messages = [], existing = [] } = {}) {
  const transcript = (Array.isArray(messages) ? messages : [])
    .map((message) => {
      // Assistant lines stay in the prompt as context only; they are never evidence.
      const role = message.role === 'assistant' ? 'assistant（仅背景，不能作为证据）' : 'user';
      return `[${String(message.id)}] ${role}: ${String(message.text ?? '')}`;
    })
    .join('\n');
  const known = (Array.isArray(existing) ? existing : [])
    .slice(0, 120)
    .map((entry) => `- [${entry.id}] (${entry.side}/${cleanText(entry.category) || '未分类'}) ${String(entry.text ?? '')}`)
    .join('\n');
  return [
    '阅读下面的新增交流，提取值得长期保留的助手人设倾向（side=agent）和用户偏好（side=user）。',
    '分类口径（写死，不得因为话题不是在“聊人”就跳过；聊书、聊作品、聊工具时提到的偏好同样要提取）：',
    '- user：用户自身的事实、习惯、经历与生活事实——喜欢的作品/风格/食物/运动/娱乐、审美倾向，以及用户对自己言行的澄清。',
    '  例：「我喜欢这种细腻的作品」→ side=user，category=娱乐；「说某角色可爱只是观剧时的即时反应，不代表…」→ side=user，category=娱乐。',
    '- agent：用户对「角色/助手该怎么表现」的偏好（性格、说话方式、互动方式、处事方式），以及用户明确对助手提出的长期要求（「以后都这样」）。',
    '  例：「用户喜欢温婉可爱的角色」→ side=agent，category=人设参考；「以后说话都温柔点」→ side=agent。',
    '- 不得把用户自述/澄清改写成「你不要…」这类助手规则；「这次简短点」这类当次指令不是长期偏好，不要输出候选。',
    '- 归属不明时不要输出候选：不迁移、不强化。',
    '- 口吻：side=agent 一律第二人称「你……」，不得用「用户」指代；side=user 一律第三人称「用户……」，不得出现「我/我们/我的/咱/咱们」；引号里的原话保持原样。',
    '- 一句话同时含两类信息时拆成两条候选，不要合并。',
    '只输出一个 JSON 对象：{"candidates":[...]}。',
    '每个候选：{"side","category","text","message_ids","op","entryId"?,"target_text"?,"severity"?}。',
    'side 只能是 agent 或 user；text 是一句完整、可独立理解的倾向；category 由你判断：agent 侧优先用 人设参考/相处方式/说话方式/形象，user 侧优先用 饮食/运动/娱乐/生活习惯，也可以自拟中文类别。',
    '若候选是在强化已有条目（同一倾向），带 "entryId" 并原样引用已有条目方括号里的 id；无法确认是同一倾向时不要带 entryId，由宿主按新候选处理。',
    'message_ids 必须是下方 user 行方括号里的消息 ID，至少一个；assistant 行只用于理解上下文，不能作为证据。op 取 "support"（新增或再次支持）或 "contradict"（与已有条目矛盾，此时 target_text 填已有条目原文）。',
    '不要输出任何分数、C/E、置信度或 0-100 的数值；评分与去重全部由宿主完成。',
    known.length > 0 ? `已有条目（同义候选请带对应 entryId；矛盾请引用原文作为 target_text）：\n${known}` : '已有条目：无。',
    `新增交流：\n${transcript}`,
  ].join('\n');
}

export {
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
  parseJsonPayload,
};
