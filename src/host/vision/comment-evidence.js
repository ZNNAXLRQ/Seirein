/**
 * P-186 / P-187 阶段 2 —— 本轮评论证据（纯状态 + 文本渲染）。
 *
 * 阶段 1 的证据窗口保存的是“什么时候、哪个来源、哪一代”的画面元数据，评论对齐
 * (`alignComment`) 只回答“这句话更可能指向哪几帧”。本模块负责把一次终稿到达后的对齐结果
 * 按会话短暂保留，并渲染成主请求可读的中文块：
 *
 *   - 用户开口 / 语音结束（端点） / 评论关联窗口 / 当前最新画面必须分开写；
 *   - 只写采集时间、帧数与可回看帧 id，绝不写文件路径，也不写任何台词或画面正文；
 *   - 这里没有图片，也没有经过后台理解：渲染文案必须明确告诉模型“不要声称已经看见画面内容”；
 *   - 记录有 TTL 与会话数上限，读时清理；`attach` 复制入参，绝不持有调用方的可变引用。
 *
 * 本模块没有任何 I/O、定时器和导入副作用。宿主在麦克风终稿后 `attach`，在
 * `scope.systemPrompt.context` 里按 session `render`，隐私/切源/卸载时 `clearAll`。
 */

/** 第一版试验参数；不是冻结值，按本机实测再调。 */
export const COMMENT_EVIDENCE_DEFAULTS = Object.freeze({
  /** 一条对齐结果只服务“紧接着的这一轮”；超时后主请求不再看到旧评论证据。 */
  ttlMs: 120_000,
  /** 同时保留的会话数：语音通常只有一个陪伴会话，留几个余量给跨日/重连。 */
  maxSessions: 8,
  /** 主请求里的文本上限：只放时间/帧数，超长直接截断，不把整段对齐结果塞进提示词。 */
  maxChars: 400,
});

/** 一组帧 id 的复制上限：对齐结果只用于计数/诊断，不该无限占内存。 */
const MAX_RELATED_IDS = 64;
/** 主请求里最多回看 3 帧（与 assistant_see 的 evidenceFrameIds 上限一致）。 */
const MAX_REVIEW_IDS = 3;

function finiteNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim().length > 0) {
    const number = Number(value.trim());
    return Number.isFinite(number) ? number : null;
  }
  return null;
}

function timestamp(value) {
  const number = finiteNumber(value);
  return number !== null && number >= 0 ? number : null;
}

function nonNegativeInteger(value) {
  const number = finiteNumber(value);
  return number !== null && number >= 0 ? Math.floor(number) : null;
}

/** 会话键：只接受非空字符串/有限数字；其他一律视为“未知会话”，不落库。 */
function sessionKey(value) {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

/** 可选的标识字段：空串/空白/非法值统一为 null，渲染时按“未知”处理。 */
function idText(value) {
  if (typeof value === 'string') {
    const text = value.trim();
    return text.length > 0 ? text : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

/** 一组帧 id：只复制字符串/数字，跳过坏项；有界，避免调用方塞入超长数组。 */
function idList(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const entry of value) {
    const id = idText(entry);
    if (id === null || id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= MAX_RELATED_IDS) break;
  }
  return out;
}

/**
 * 归一化对齐结果：畸形/缺失一律退成“低/未知”，绝不抛错。
 * 只保留渲染需要的字段，`relatedFrameIds` 等数组也复制一份，避免调用方事后改数组。
 */
function copyAlignment(input) {
  const empty = {
    confidence: 'low',
    reason: '',
    window: { from: null, to: null },
    cues: { retrospective: false, current: false },
    relatedFrameIds: [],
    afterSpeechFrameIds: [],
    latestFrameId: null,
  };
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return empty;
  let window = { from: null, to: null };
  try {
    const raw = input.window;
    if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
      window = { from: timestamp(raw.from), to: timestamp(raw.to) };
    }
  } catch {
    window = { from: null, to: null };
  }
  let cues = { retrospective: false, current: false };
  try {
    const raw = input.cues;
    if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
      cues = { retrospective: raw.retrospective === true, current: raw.current === true };
    }
  } catch {
    cues = { retrospective: false, current: false };
  }
  return {
    confidence: input.confidence === 'high' ? 'high' : 'low',
    reason: typeof input.reason === 'string' ? input.reason.trim() : '',
    window,
    cues,
    relatedFrameIds: idList(input.relatedFrameIds),
    afterSpeechFrameIds: idList(input.afterSpeechFrameIds),
    latestFrameId: idText(input.latestFrameId),
  };
}

function cloneAlignment(alignment) {
  return {
    confidence: alignment.confidence,
    reason: alignment.reason,
    window: { ...alignment.window },
    cues: { ...alignment.cues },
    relatedFrameIds: alignment.relatedFrameIds.slice(),
    afterSpeechFrameIds: alignment.afterSpeechFrameIds.slice(),
    latestFrameId: alignment.latestFrameId,
  };
}

function snapshotRecord(record) {
  return {
    sessionId: record.sessionId,
    utteranceId: record.utteranceId,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    alignment: cloneAlignment(record.alignment),
    latestId: record.latestId,
    latestAt: record.latestAt,
    frameCount: record.frameCount,
    at: record.at,
  };
}

/** 本地 `HH:MM:SS`；缺失/非法时间只写“未知”，不拿结束时间硬猜画面时刻。 */
function clockText(value) {
  const at = timestamp(value);
  if (at === null) return '未知';
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return '未知';
  const pad = (number) => String(number).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * 原因只允许 comment-alignment 的机器码（window/retrospective/current/no-window-evidence/
 * no-start）；其他值一律写“未知”。这样畸形/第三方字符串既不会破坏块结构，也不可能把
 * 文件路径或台词正文混进主请求。
 */
const KNOWN_REASONS = new Set(['window', 'retrospective', 'current', 'no-window-evidence', 'no-start']);

function reasonText(value) {
  if (typeof value !== 'string') return '未知';
  const text = value.trim().toLowerCase();
  return KNOWN_REASONS.has(text) ? text : '未知';
}

/**
 * 可回看帧 id：只取关联帧里前 3 个安全 id，去重。
 * id 必须是单段机器标识；含路径分隔符/空白/控制字符的值一律丢弃，保证渲染块
 * 即使拿到畸形 alignment 也不会把文件路径写进主请求。
 */
function reviewFrameIds(alignment) {
  const seen = new Set();
  const out = [];
  for (const id of alignment.relatedFrameIds) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= MAX_REVIEW_IDS) break;
  }
  return out;
}

/**
 * @param {object} [options]
 * @param {() => number} [options.now]
 * @param {number} [options.ttlMs]
 * @param {number} [options.maxSessions]
 * @param {number} [options.maxChars]
 */
export function createCommentEvidence({
  now = Date.now,
  ttlMs = COMMENT_EVIDENCE_DEFAULTS.ttlMs,
  maxSessions = COMMENT_EVIDENCE_DEFAULTS.maxSessions,
  maxChars = COMMENT_EVIDENCE_DEFAULTS.maxChars,
} = {}) {
  const clock = () => {
    try {
      const value = Number(now());
      return Number.isFinite(value) && value >= 0 ? value : Date.now();
    } catch {
      return Date.now();
    }
  };
  const ttl = () => (Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : COMMENT_EVIDENCE_DEFAULTS.ttlMs);
  const sessionLimit = () => (Number.isFinite(maxSessions) && maxSessions > 0
    ? Math.max(1, Math.floor(maxSessions))
    : COMMENT_EVIDENCE_DEFAULTS.maxSessions);
  const charLimit = () => (Number.isFinite(maxChars) && maxChars > 0
    ? Math.floor(maxChars)
    : COMMENT_EVIDENCE_DEFAULTS.maxChars);

  /** 按 attach 顺序保存；重新 attach 同一会话会移到队尾（最近使用）。 */
  const records = new Map();
  /** 只做计数，不含任何正文；status 只读这个投影。 */
  const stats = { attached: 0, expired: 0, evicted: 0 };

  /** TTL 读时清理：take/render/state/attach 都会先走这里。 */
  function sweep(current) {
    for (const [key, record] of records) {
      if (current - record.at >= ttl()) {
        records.delete(key);
        stats.expired += 1;
      }
    }
  }

  /**
   * 覆盖该 session 的最近一条。入参（包括 alignment 里的对象/数组）全部复制；空 session 不落库。
   * 畸形 alignment 不抛错，只按“低/未知”渲染。
   * @returns {object|null} 归一化后的快照；session 非法时 null。
   */
  function attach(input) {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) return null;
    const sessionId = sessionKey(input.sessionId);
    if (sessionId.length === 0) return null;
    const current = clock();
    sweep(current);
    const alignment = copyAlignment(input.alignment);
    const relatedCount = alignment.relatedFrameIds.length;
    const declaredFrames = nonNegativeInteger(input.frameCount);
    const record = {
      sessionId,
      utteranceId: idText(input.utteranceId) ?? '',
      startedAt: timestamp(input.startedAt),
      endedAt: timestamp(input.endedAt),
      alignment,
      latestId: idText(input.latestId) ?? alignment.latestFrameId,
      // 宿主可选提供最新帧的采集时间；没有就诚实渲染“采集时间未知”。
      latestAt: timestamp(input.latestAt),
      frameCount: declaredFrames ?? relatedCount,
      at: current,
    };
    // 覆盖同一会话并移到队尾，让 maxSessions 淘汰的总是“最久没更新的会话”。
    records.delete(sessionId);
    records.set(sessionId, record);
    stats.attached += 1;
    while (records.size > sessionLimit()) {
      const oldest = records.keys().next().value;
      if (oldest === undefined) break;
      records.delete(oldest);
      stats.evicted += 1;
    }
    return snapshotRecord(record);
  }

  /** 当前有效记录；过期/未知返回 null。返回副本，调用方改不到内部状态。 */
  function take(sessionId) {
    const key = sessionKey(sessionId);
    if (key.length === 0) return null;
    const current = clock();
    sweep(current);
    const record = records.get(key);
    return record === undefined ? null : snapshotRecord(record);
  }

  /**
   * 主请求用的中文块：只含时间、帧数、把握、可回看帧 id 与“尚无画面理解”的边界说明。
   * 无记录/过期返回 ''，宿主注册的 context 因此不会产生空块。
   */
  function render(sessionId) {
    const key = sessionKey(sessionId);
    if (key.length === 0) return '';
    const current = clock();
    sweep(current);
    const record = records.get(key);
    if (record === undefined) return '';

    const alignment = record.alignment;
    const windowFrom = alignment.window.from ?? record.startedAt;
    const windowTo = alignment.window.to ?? record.endedAt;
    const confidence = alignment.confidence === 'high' ? '高' : '低';
    const reason = reasonText(alignment.reason);
    const frameCount = Number.isInteger(record.frameCount) && record.frameCount > 0
      ? record.frameCount
      : 0;
    // 窗口内全部证据帧 vs 真正参与解释评论的关联帧：两个数分开给，避免把“窗口里有几帧”
    // 误读成“模型能看几帧”。
    const relatedCount = alignment.relatedFrameIds.length;
    // 模型要回看时必须拿到真实 id；只给前 3 个，且不把路径/超长字符串带进提示词。
    const reviewIds = reviewFrameIds(alignment);
    const reviewLine = reviewIds.length > 0
      ? `- 可回看帧：${reviewIds.join(', ')}（最多 3 个，调用 assistant_see 的 evidenceFrameIds）`
      : '- 可回看帧：本次没有可回看的关联帧';

    let latestLine;
    if (record.latestAt !== null) {
      // 没有开口时间就不假装比较先后；有开口时间才说“晚于/不晚于”。
      const relation = record.startedAt === null
        ? '只能回答“现在”，不能倒过来解释评论'
        : (record.latestAt > record.startedAt
          ? '晚于开口，只能回答“现在”，不能倒过来解释评论'
          : '不晚于开口，仍不能替代评论关联窗口');
      latestLine = `- 当前最新画面：${clockText(record.latestAt)} 采集（${relation}）`;
    } else if (record.latestId !== null) {
      latestLine = '- 当前最新画面：最新帧已登记，采集时间未知（只能回答“现在”，不能倒过来解释评论）';
    } else {
      latestLine = '- 当前最新画面：无已登记画面（不能声称已经看见画面内容）';
    }

    const lines = [
      '【视听证据｜本轮评论对齐】',
      // end 来自 hearing 的 audioEndAt：它是语音端点，不是“识别完成”时刻；旧文案会误导。
      `- 用户开口：${clockText(record.startedAt)}；语音结束（端点）：${clockText(record.endedAt)}`,
      `- 评论关联窗口：${clockText(windowFrom)}–${clockText(windowTo)}（窗口内 ${frameCount} 帧，关联 ${relatedCount} 帧）`,
      latestLine,
      `- 关联把握：${confidence}（原因：${reason}）`,
      reviewLine,
      '- 说明：画面内容尚未经过后台理解；这里只有采集时间与帧数，不要声称已经看见画面内容。如需回看关联帧，可调用 assistant_see 并传入 evidenceFrameIds（最多 3 个）。',
    ];
    return lines.join('\n').slice(0, charLimit());
  }

  /** 会话边界：只清这一条，不碰其他会话。 */
  function clear(sessionId) {
    const key = sessionKey(sessionId);
    if (key.length === 0) return false;
    return records.delete(key);
  }

  /** 隐私/切源/卸载：整代评论证据一起作废；计数保留用于诊断。 */
  function clearAll() {
    records.clear();
  }

  /** status 投影：只有会话数、最近一次 attach 时间和计数，不含正文。 */
  function state() {
    const current = clock();
    sweep(current);
    let latestAt = null;
    for (const record of records.values()) {
      if (latestAt === null || record.at > latestAt) latestAt = record.at;
    }
    return {
      sessions: records.size,
      latestAt,
      attached: stats.attached,
      expired: stats.expired,
      evicted: stats.evicted,
    };
  }

  return { attach, take, render, clear, clearAll, state };
}
