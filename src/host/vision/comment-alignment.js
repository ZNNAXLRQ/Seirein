/**
 * P-186 / P-187 阶段 2 —— 用户评论对齐（纯计算）。
 *
 * 只回答一个问题：用户这句话更可能指向证据窗口里的哪几帧？
 * 这里不截图、不读文件、不调用模型、不启动定时器，也没有任何导入副作用；
 * 宿主把证据窗口的元数据和发言原始时间传进来，换回可直接拼进主请求的帧 id。
 *
 * 为什么要把这层独立出来：
 *   - 时间基准只允许“画面实际采集时间 capturedAt”和“开口/识别完成时间”，
 *     绝不能用识别完成时间反推画面时刻；
 *   - “评论关联片段”和“当前最新画面”必须分开：开口后的新画面只能回答“现在是什么”，
 *     不能倒过来解释“刚才那个”；
 *   - 回溯词 / 当前词 / 冲突词是规则而不是模型猜测，只有做成纯函数才能逐条测清楚。
 *
 * 来源与代次（source / sourceEpoch）不在本模块过滤：证据窗口换代次时已经清空旧证据，
 * 调用方应从当前代次的 evidence 取值。这里只负责时间与文本线索，不替调用方猜来源。
 */

/** 第一版试验参数；不是冻结值，按本机实测再调。 */
export const ALIGNMENT_DEFAULTS = Object.freeze({
  /** 开口前默认搜索范围：一句短评论通常落在最近几秒。 */
  lookbackMs: 8_000,
  /** 评论关联帧上限：主请求只带少量关键帧，避免每轮回复堆图。 */
  maxFrames: 3,
  /** “刚才那个”把搜索范围向前扩到默认回溯的几倍；不是把所有评论固定前移。 */
  retrospectiveFactor: 2,
});

/**
 * 文字轮（typed）没有音频端点，只有 Host 在 pre-step 记录的发送时刻。
 * 窗口向前覆盖发送前 8 秒，向后留 2 秒给“发送后立刻发生”的画面；不是语音端点语义。
 */
export const TYPED_TURN_DEFAULTS = Object.freeze({
  afterMs: 2_000,
});

/**
 * 回溯词：用户明确在说“已经发生过的画面”。
 * 用包含匹配而不是分词：中文口语里的“刚才那个”“刚刚那下”都包含这些词根。
 */
const RETROSPECTIVE_CUES = Object.freeze([
  '刚才', '刚刚', '上一', '之前', '方才', '上回', '那会儿',
]);

/**
 * 当前词：用户明确在说“现在 / 正在 / 画面中的某个位置”。
 * “右边那个”是位置指代，实际要看最新画面，而不是把整句评论向前平移。
 */
const CURRENT_CUES = Object.freeze([
  '现在', '当前', '这时', '此刻', '右边那个', '正在',
]);

/**
 * 只接受数字或数字字符串，null / undefined / 空串 / 布尔值都不算时间。
 * 为什么不用 Number(value) 直接转：Number(null) 是 0，会把“没给时间”误当成有效时间。
 */
function finiteNumber(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const text = typeof value === 'string' ? value.trim() : value;
  if (text === '') return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

/** 解析当前时刻：测试可传函数，也允许直接传数字；异常时退回真实时钟。 */
function resolveClock(now) {
  try {
    const value = typeof now === 'function' ? now() : now;
    const number = finiteNumber(value);
    return number === null ? Date.now() : number;
  } catch {
    return Date.now();
  }
}

/**
 * 归一化证据元数据：只保留能参与对齐的 id + capturedAt。
 * 非法记录直接跳过而不抛错，因为证据窗口淘汰、来源切换或序列化都可能留下残缺项；
 * 一条坏记录不该让整句评论失去对齐能力。同一 id 只保留第一次出现的记录。
 */
function collectFrames(evidence) {
  if (!Array.isArray(evidence)) return [];
  const seen = new Set();
  const frames = [];
  evidence.forEach((entry, index) => {
    if (entry === null || typeof entry !== 'object') return;
    const rawId = entry.id;
    const id = typeof rawId === 'string' || typeof rawId === 'number'
      ? String(rawId).trim()
      : '';
    if (id.length === 0 || seen.has(id)) return;
    const capturedAt = finiteNumber(entry.capturedAt);
    if (capturedAt === null || capturedAt < 0) return;
    seen.add(id);
    // index 只用于同一采集时刻的稳定排序，不参与任何时间计算。
    frames.push({ id, capturedAt, index });
  });
  frames.sort((left, right) => left.capturedAt - right.capturedAt || left.index - right.index);
  return frames;
}

/** 显式传入的 latestId 只接受非空字符串或有限数字；空值退回证据里的最新帧。 */
function explicitId(value) {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

/**
 * 均匀取帧：首 / 中 / 尾优先，最多 limit 帧，保持采集时间升序。
 * 为什么不用“取最近的 N 帧”：评论可能指向窗口开头那一幕，均匀覆盖整段比只取尾部更稳；
 * 为什么按位置取而不是按时间取：帧间隔本来就不均匀，按位置能保证每段都有代表帧。
 * 索引可能因四舍五入重复，重复的只保留一次；因此实际取到的帧只会更少、不会超上限。
 */
function pickEvenly(frames, limit) {
  const count = Math.min(limit, frames.length);
  if (count <= 0) return [];
  if (count === frames.length) return frames.slice();
  const picked = [];
  for (let i = 0; i < count; i += 1) {
    const position = count === 1
      ? 0
      : Math.round((i * (frames.length - 1)) / (count - 1));
    const frame = frames[position];
    if (picked.length === 0 || picked[picked.length - 1] !== frame) picked.push(frame);
  }
  return picked;
}

/** 文本线索只做包含匹配；非字符串按“没有线索”处理，避免 String(null) 之类误判。 */
function detectCues(text) {
  const body = typeof text === 'string' ? text : '';
  return {
    retrospective: RETROSPECTIVE_CUES.some((word) => body.includes(word)),
    current: CURRENT_CUES.some((word) => body.includes(word)),
  };
}

/**
 * 把一句用户评论对齐到证据窗口。
 *
 * 默认窗口是 `[startedAt - lookbackMs, endedAt]`：
 *   - 开口前一小段用于解释“刚才/这个”；
 *   - 发言期间到识别完成用于覆盖边说边发生的画面。
 * 回溯词把窗口向前扩到 `startedAt - lookbackMs * retrospectiveFactor`；
 * 当前词不改变窗口（“现在”不能凭空把旧画面删掉），只把 reason 标成 current，
 * 调用方应优先使用始终返回的 latestFrameId。
 * 冲突词（同时回溯 + 当前）不猜：保留默认窗口，related 仍按规则给出，但 confidence=low。
 *
 * @param {object} [options]
 * @param {string} [options.text] 用户评论文本
 * @param {number|null} [options.startedAt] 用户开口时刻（必填才可对齐）
 * @param {number|null} [options.endedAt] 本轮窗口结束（语音轮是 hearing 的 audioEndAt 端点，不是识别完成时刻）
 * @param {Array<{id: string, capturedAt: number}>} [options.evidence] 证据窗口元数据
 * @param {string|number|null} [options.latestId] 已知的当前最新画面 id
 * @param {() => number} [options.now] 当前时刻函数
 * @param {number} [options.lookbackMs] 覆盖默认回溯范围
 * @param {number} [options.maxFrames] 覆盖评论关联帧上限
 */
export function alignComment({
  text = '',
  startedAt = null,
  endedAt = null,
  evidence = [],
  latestId = null,
  now = Date.now,
  lookbackMs,
  maxFrames,
} = {}) {
  const cues = detectCues(text);
  const frames = collectFrames(evidence);
  // 最新画面永远从全量证据取，不受搜索窗口影响：它回答“现在是什么”，不解释评论。
  const requestedLatest = explicitId(latestId);
  const latestFrameId = requestedLatest.length > 0
    ? requestedLatest
    : (frames.length === 0 ? null : frames[frames.length - 1].id);

  const start = finiteNumber(startedAt);
  if (start === null || start < 0) {
    // 没有开口时刻就无法判断“开口前/开口后”，宁可不给结论，也不拿识别完成时间硬猜。
    return {
      ok: false,
      window: { from: null, to: null },
      relatedFrameIds: [],
      latestFrameId,
      afterSpeechFrameIds: [],
      confidence: 'low',
      reason: 'no-start',
      cues,
    };
  }

  const lookbackValue = finiteNumber(lookbackMs);
  const lookback = lookbackValue !== null && lookbackValue > 0
    ? lookbackValue
    : ALIGNMENT_DEFAULTS.lookbackMs;
  const limitValue = finiteNumber(maxFrames);
  const frameLimit = limitValue !== null && limitValue >= 1
    ? Math.floor(limitValue)
    : ALIGNMENT_DEFAULTS.maxFrames;

  const endValue = finiteNumber(endedAt);
  // endedAt < startedAt 视为没有结束时间（时钟回拨、重试、异常），改用 now。
  const end = endValue !== null && endValue >= start ? endValue : resolveClock(now);
  const expanded = cues.retrospective && !cues.current;
  const from = start - lookback * (expanded ? ALIGNMENT_DEFAULTS.retrospectiveFactor : 1);
  // 极端的时钟异常也不能让窗口反向；正常路径下 to 就是 endedAt 或 now。
  const to = Math.max(end, from);

  let reason = 'window';
  if (cues.retrospective && cues.current) reason = 'window';
  else if (expanded) reason = 'retrospective';
  else if (cues.current) reason = 'current';

  const inWindow = frames.filter((frame) => frame.capturedAt >= from && frame.capturedAt <= to);
  // 严格大于开口时刻才算“开口之后”：正好在开口时刻采集的帧仍可作为评论依据。
  const beforeSpeech = inWindow.filter((frame) => frame.capturedAt <= start);
  const afterSpeech = inWindow.filter((frame) => frame.capturedAt > start);
  const related = pickEvenly(beforeSpeech, frameLimit);

  let confidence = 'high';
  if (inWindow.length === 0) {
    // 窗口里一帧都没有：保留 latestId 作为“现在”，但不假装能解释评论。
    reason = 'no-window-evidence';
    confidence = 'low';
  } else if (cues.retrospective && cues.current) {
    // 同时出现“刚才”和“现在”：规则不猜，只把候选交给调用方确认。
    confidence = 'low';
  } else if (related.length === 0) {
    // 窗口里只有开口后采集的帧：它们只能作为“现在”，无法倒过来解释评论。
    confidence = 'low';
  }

  return {
    ok: true,
    window: { from, to },
    relatedFrameIds: related.map((frame) => frame.id),
    latestFrameId,
    afterSpeechFrameIds: afterSpeech.map((frame) => frame.id),
    confidence,
    reason,
    cues,
  };
}

/**
 * 文字轮的时间窗口：`[sentAt - lookbackMs, sentAt + afterMs]`。
 * 没有发送时刻返回 null；绝不拿“上一条麦克风终稿”或转写完成时间替代。
 *
 * @param {object} [options]
 * @param {number|null} [options.sentAt] Host 在 typed pre-step 记录的发送时刻
 * @param {number} [options.lookbackMs] 发送前的搜索范围
 * @param {number} [options.afterMs] 发送后的宽限
 * @returns {{from:number,to:number,sentAt:number,timeSource:'typed-sent'}|null}
 */
export function typedTurnWindow({ sentAt = null, lookbackMs, afterMs } = {}) {
  const start = finiteNumber(sentAt);
  if (start === null || start < 0) return null;
  const lookbackValue = finiteNumber(lookbackMs);
  const lookback = lookbackValue !== null && lookbackValue > 0
    ? lookbackValue
    : ALIGNMENT_DEFAULTS.lookbackMs;
  const afterValue = finiteNumber(afterMs);
  const after = afterValue !== null && afterValue >= 0
    ? afterValue
    : TYPED_TURN_DEFAULTS.afterMs;
  return {
    from: Math.max(0, start - lookback),
    to: start + after,
    sentAt: start,
    timeSource: 'typed-sent',
  };
}

/**
 * 把一条 typed 消息对齐到它自己的发送窗口。
 *
 * 与语音轮共用 `alignComment` 的线索/相关帧规则，但 `startedAt` 一定是 `sentAt`，
 * `endedAt` 是发送后的宽限点；没有音频、没有 partial、也没有识别完成时间参与。
 * 返回的 `window` 是最终（可能因“刚才”扩到 16 秒）的可检索窗口，宿主据此选理解事件。
 *
 * @param {object} [options]
 * @param {string} [options.text] 用户这条文字消息
 * @param {number|null} [options.sentAt] Host 记录的发送时刻
 * @param {Array<{id:string,capturedAt:number}>} [options.evidence] 证据窗口元数据
 * @param {string|number|null} [options.latestId] 已知当前最新画面 id
 * @param {() => number} [options.now] 当前时刻函数
 * @param {number} [options.lookbackMs]
 * @param {number} [options.afterMs]
 * @param {number} [options.maxFrames]
 */
export function alignTypedTurn({
  text = '',
  sentAt = null,
  evidence = [],
  latestId = null,
  now = Date.now,
  lookbackMs,
  afterMs,
  maxFrames,
} = {}) {
  const cues = detectCues(text);
  const typed = typedTurnWindow({ sentAt, lookbackMs, afterMs });
  if (typed === null) {
    const frames = collectFrames(evidence);
    const requestedLatest = explicitId(latestId);
    return {
      ok: false,
      window: { from: null, to: null },
      relatedFrameIds: [],
      latestFrameId: requestedLatest.length > 0
        ? requestedLatest
        : (frames.length === 0 ? null : frames[frames.length - 1].id),
      afterSpeechFrameIds: [],
      confidence: 'low',
      reason: 'no-sent',
      cues,
      timeSource: 'typed-sent',
      sentAt: null,
    };
  }
  const aligned = alignComment({
    text,
    startedAt: typed.sentAt,
    endedAt: typed.to,
    evidence,
    latestId,
    now,
    lookbackMs,
    maxFrames,
  });
  return {
    ...aligned,
    timeSource: 'typed-sent',
    sentAt: typed.sentAt,
    sentAtWindow: { ...typed },
  };
}
