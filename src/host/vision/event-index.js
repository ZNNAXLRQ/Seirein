/**
 * P0 本地宏观事件索引：故事板负责“发生了什么”，独立原帧队列负责“细节长什么样”。
 *
 * 这一层是纯本地模块：不截图、不读文件、不调用模型、不创建定时器。它只做四件事：
 *
 *   1. `ingest()` 把一次宏观理解成功的事件写成**有界**索引条目。条目只保留
 *      `eventId / startedAt / endedAt / shotId / description / action / keyDialogue /
 *      frameIds[] / audioIds[] / uncertainty / source` 这类标量或短 id 数组；文件路径、
 *      图片字节、整段正文都不会进入索引。
 *   2. `search()` 按 turn 的真实语音/文字时间窗、文本关键词、shotId、frameIds 做本地检索。
 *      文本关键词没有命中时返回空并说明原因，**绝不只凭时间窗强行关联**；上一镜头也只能
 *      显式请求，不能拿当前镜头冒充。
 *   3. 命中事件只返回**原帧引用**（`frameId + capturedAt + shotId`，不含路径）以及前后关键帧；
 *      真正的图片由宿主按 frameId 从原帧队列取。
 *   4. 条目有 TTL、条数上限和 `clear()`；隐私/切源/卸载都走同一条清理路径。
 *
 * 时间取舍与 `understanding.js` 一致：事件时间必须落在真实证据附近；无法证明时间的事件仍然
 * 保留（旧事件/兼容调用），但会显式标成 `unknown`/`low` 并把不确定性写进 uncertainty。
 */

import { stableEventId } from './understanding.js';

/** 第一版边界；都是有界数字，不按“大约”猜。 */
export const EVENT_INDEX_DEFAULTS = Object.freeze({
  /** 事件在索引里的最长寿命；重复观察会按最近一次观察续期。 */
  ttlMs: 10 * 60_000,
  /** 索引最多保留多少条宏观事件。 */
  maxEvents: 200,
  /** 单条事件最多保存多少个原帧引用。 */
  maxFrameIds: 16,
  /** 单条事件最多保存多少句/段音频引用。 */
  maxAudioIds: 16,
  /** 描述/动作上限（按 Unicode 码点计）。 */
  maxDescriptionChars: 240,
  maxActionChars: 240,
  /** keyDialogue 上限；这是台词摘要，不是正文大段。 */
  maxDialogueChars: 120,
  /** uncertainty 上限。 */
  maxUncertaintyChars: 80,
  /** 检索关键词上限。 */
  maxKeywords: 8,
  /** 每次返回的事件数上限。 */
  maxResults: 10,
  /** 默认返回的事件数。 */
  defaultResults: 3,
});

/** id 只接受有界机器标识；路径分隔符/空白/正文一律拒绝。 */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/u;
const SOURCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,31}$/u;
/** 与 understanding.js 相同的证据邻近容差。 */
const EVIDENCE_TOLERANCE_MS = 2_000;
/** 检索窗口边界容差：避免整秒取整把边界事件漏掉。 */
const WINDOW_TOLERANCE_MS = 500;
const TIME_MISMATCH_NOTE = '时间与引用证据不一致';
const TIME_UNKNOWN_NOTE = '时间来源无法由证据证明';

/** 纯功能词/画面指代词：它们不能作为“关键词命中”，否则任何评论都会命中任何事件。 */
const STOPWORDS = new Set([
  '的', '了', '吗', '呢', '啊', '吧', '呀', '哦', '嗯', '是', '在', '有', '个', '和', '就',
  '都', '也', '又', '很', '太', '我', '你', '他', '她', '它', '我们', '你们', '他们',
  '这', '那', '这个', '那个', '这些', '那些', '这里', '那里', '刚才', '现在', '刚刚',
  '什么', '怎么', '怎样', '为什么', '为什', '哪里', '哪个', '是不是', '可以', '帮我',
  '请问', '一下', '看看', '看一下', '看下', '画面', '屏幕', '电视', '视频', '里面', '里',
  '在做什么', '做什么', '干嘛', '发生', '事情', '时候', '进行', '一个', '一种', '然后',
]);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 时间只接受有限、非负毫秒；数字字符串兼容（模型/序列化边界常见）。 */
function toTime(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value === 'string' && value.trim().length > 0) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : null;
  }
  return null;
}

/** 数量上限：非法值退回默认，正数向下取整。 */
function toLimit(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.max(1, Math.floor(number));
}

/** 扁平化控制字符/换行，避免模型文本伪造结构行或写入不可见字符。 */
function flattenText(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** 按 Unicode 码点截断，不劈开代理对；不额外追加省略号，保证严格不超过上限。 */
function clipText(value, limit) {
  const text = typeof value === 'string' ? value : '';
  const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0;
  if (max === 0) return '';
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max).join('');
}

/** 只接受可检索、可对外展示的机器 id；路径/正文/空白一律丢弃。 */
function safeId(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return ID_PATTERN.test(text) ? text : null;
}

function safeSource(value) {
  if (typeof value !== 'string') return 'understanding';
  const text = value.trim();
  return SOURCE_PATTERN.test(text) ? text : 'understanding';
}

/** 有界去重 id 数组；保留输入顺序，最多 `limit` 个。 */
function idList(value, limit) {
  if (!Array.isArray(value)) return [];
  const ids = [];
  const seen = new Set();
  for (const entry of value) {
    const id = safeId(entry);
    if (id === null || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length >= limit) break;
  }
  return ids;
}

function uniqueRefs(refs, limit) {
  const out = [];
  const seen = new Set();
  for (const ref of refs) {
    if (!isObject(ref)) continue;
    const frameId = safeId(ref.frameId);
    const capturedAt = toTime(ref.capturedAt);
    if (frameId === null || capturedAt === null || seen.has(frameId)) continue;
    seen.add(frameId);
    out.push({
      frameId,
      capturedAt,
      ...(safeId(ref.shotId) === null ? {} : { shotId: safeId(ref.shotId) }),
    });
    if (out.length >= limit) break;
  }
  return out;
}

function publicRef(ref) {
  return {
    frameId: ref.frameId,
    capturedAt: ref.capturedAt,
    ...(typeof ref.shotId === 'string' ? { shotId: ref.shotId } : {}),
  };
}

/** 时间窗与证据范围是否足够近（相交或距离不超过容差）。 */
function nearRange(from, to, range) {
  return range.endedAt + EVIDENCE_TOLERANCE_MS >= from
    && range.startedAt - EVIDENCE_TOLERANCE_MS <= to;
}

/** 证据时间元数据：entry id → 它引用的独立原帧。 */
function frameMapOf(frames, maxFrameIds) {
  const map = new Map();
  if (!Array.isArray(frames)) return map;
  for (const entry of frames) {
    if (!isObject(entry)) continue;
    const entryId = safeId(entry.id);
    if (entryId === null || map.has(entryId)) continue;
    const startedAt = toTime(entry.startedAt) ?? toTime(entry.capturedAt);
    const endedAt = toTime(entry.endedAt) ?? toTime(entry.capturedAt);
    const shotId = safeId(entry.shotId);
    const refs = [];
    if (Array.isArray(entry.cells)) {
      for (const cell of entry.cells) {
        if (!isObject(cell)) continue;
        const frameId = safeId(cell.frameId ?? cell.id);
        const capturedAt = toTime(cell.capturedAt ?? cell.at);
        if (frameId === null || capturedAt === null) continue;
        refs.push({
          frameId,
          capturedAt,
          shotId: safeId(cell.shotId) ?? shotId,
        });
        if (refs.length >= maxFrameIds) break;
      }
    }
    // 没有独立原帧的旧证据（或单帧）退化为证据 entry 自己的 id；仍然只是引用，不含路径。
    if (refs.length === 0) {
      const capturedAt = startedAt ?? endedAt;
      if (capturedAt !== null) refs.push({ frameId: entryId, capturedAt, shotId });
    }
    map.set(entryId, {
      refs: uniqueRefs(refs, maxFrameIds),
      ...(startedAt === null ? {} : { startedAt }),
      ...(endedAt === null ? {} : { endedAt }),
    });
  }
  return map;
}

function audioMapOf(audioLines) {
  const map = new Map();
  if (!Array.isArray(audioLines)) return map;
  for (const entry of audioLines) {
    if (!isObject(entry)) continue;
    const id = safeId(entry.id);
    if (id === null || map.has(id)) continue;
    const startedAt = toTime(entry.audioStartAt) ?? toTime(entry.startedAt);
    const endedAt = toTime(entry.audioEndAt) ?? toTime(entry.endedAt);
    if (startedAt === null || endedAt === null || endedAt < startedAt) continue;
    map.set(id, { id, startedAt, endedAt, text: flattenText(entry.text) });
  }
  return map;
}

/** 文本 → 有界关键词。中文用 bigram，英文/数字按词；纯功能词不产生“命中”。 */
function tokenize(value, into) {
  const text = flattenText(value).toLowerCase();
  if (text.length === 0) return;
  const words = text.match(/[a-z0-9][a-z0-9_-]{1,}/gu) ?? [];
  for (const word of words) {
    if (word.length >= 2 && !STOPWORDS.has(word)) into.add(word);
  }
  const han = text.match(/\p{Script=Han}+/gu) ?? [];
  for (const sequence of han) {
    if (sequence.length <= 1) continue;
    if (sequence.length <= 2) {
      if (!STOPWORDS.has(sequence)) into.add(sequence);
      continue;
    }
    for (let i = 0; i < sequence.length - 1; i += 1) {
      const bigram = sequence.slice(i, i + 2);
      if (!STOPWORDS.has(bigram)) into.add(bigram);
    }
  }
}

function tokensOf({ text, keywords }, limit) {
  const tokens = new Set();
  tokenize(text, tokens);
  if (Array.isArray(keywords)) {
    for (const keyword of keywords) tokenize(keyword, tokens);
  } else if (typeof keywords === 'string') {
    tokenize(keywords, tokens);
  }
  return [...tokens].slice(0, limit);
}

function textScoreOf(entry, tokens) {
  if (tokens.length === 0) return { score: 0, hits: 0 };
  const haystack = `${entry.description} ${entry.action ?? ''} ${entry.keyDialogue}`.toLowerCase();
  let score = 0;
  let hits = 0;
  for (const token of tokens) {
    if (haystack.includes(token)) {
      score += 2;
      hits += 1;
    }
  }
  return { score, hits };
}

function withTimeNotes(uncertainty, { mismatch, unknown }) {
  let text = clipText(flattenText(uncertainty), EVENT_INDEX_DEFAULTS.maxUncertaintyChars);
  if (unknown && !text.includes(TIME_UNKNOWN_NOTE)) {
    text = clipText(
      text.length === 0 ? TIME_UNKNOWN_NOTE : `${text}；${TIME_UNKNOWN_NOTE}`,
      EVENT_INDEX_DEFAULTS.maxUncertaintyChars,
    );
  }
  if (mismatch && !text.includes(TIME_MISMATCH_NOTE)) {
    text = clipText(
      text.length === 0 ? TIME_MISMATCH_NOTE : `${text}；${TIME_MISMATCH_NOTE}`,
      EVENT_INDEX_DEFAULTS.maxUncertaintyChars,
    );
  }
  return text;
}

function clockText(value) {
  const at = toTime(value);
  if (at === null) return '--:--:--';
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return '--:--:--';
  const pad = (number) => String(number).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** 空的检索结果也包含稳定原因与人类可读说明：调用方不必猜“为什么没有”。 */
function emptyResult(reason, message, query = {}) {
  return {
    ok: true,
    reason,
    message,
    events: [],
    count: 0,
    query,
  };
}

/**
 * 创建本地宏观事件索引。
 *
 * @param {object} [options]
 * @param {() => number} [options.now]
 * @param {number} [options.ttlMs]
 * @param {number} [options.maxEvents]
 * @param {number} [options.maxFrameIds]
 * @param {number} [options.maxAudioIds]
 * @param {(entry: object, reason: string) => void} [options.onEvict]
 * @param {(reason: string, count: number) => void} [options.onClear]
 * @param {(type: string, payload: object) => void} [options.emit]
 */
export function createEventIndex(options = {}) {
  const source = isObject(options) ? options : {};
  const nowSource = typeof source.now === 'function' ? source.now : Date.now;
  const onEvict = typeof source.onEvict === 'function' ? source.onEvict : null;
  const onClear = typeof source.onClear === 'function' ? source.onClear : null;
  const emit = typeof source.emit === 'function' ? source.emit : null;

  const ttlMs = toLimit(source.ttlMs, EVENT_INDEX_DEFAULTS.ttlMs);
  const maxEvents = toLimit(source.maxEvents, EVENT_INDEX_DEFAULTS.maxEvents);
  const maxFrameIds = toLimit(source.maxFrameIds, EVENT_INDEX_DEFAULTS.maxFrameIds);
  const maxAudioIds = toLimit(source.maxAudioIds, EVENT_INDEX_DEFAULTS.maxAudioIds);
  const defaultResults = toLimit(source.defaultResults, EVENT_INDEX_DEFAULTS.defaultResults);
  const maxResults = Math.max(defaultResults, toLimit(source.maxResults, EVENT_INDEX_DEFAULTS.maxResults));

  const clock = () => {
    try {
      const value = Number(nowSource());
      if (Number.isFinite(value) && value >= 0) return value;
    } catch {
      /* 调用方时钟失败时退回真实时钟 */
    }
    return Date.now();
  };

  /** 按写入顺序保存事件；检索时再排序，避免读取时依赖内部顺序。 */
  let entries = [];
  const byEventId = new Map();
  const stats = { added: 0, merged: 0, skipped: 0, evicted: 0, cleared: 0 };
  let lastAddedAt = null;
  let lastClearReason = '';

  const event = (type, payload) => {
    if (emit === null) return;
    try {
      emit(type, payload);
    } catch {
      /* 观测失败不能影响索引本身 */
    }
  };

  const safeEvict = (entry, reason) => {
    stats.evicted += 1;
    if (onEvict === null) return;
    try {
      onEvict(entry, reason);
    } catch {
      /* 观测失败不能影响索引本身 */
    }
  };

  function prune() {
    const current = clock();
    const kept = [];
    for (const entry of entries) {
      const anchor = Math.max(entry.endedAt, entry.updatedAt ?? entry.endedAt);
      if (current - anchor > ttlMs) {
        byEventId.delete(entry.eventId);
        safeEvict(entry, 'age');
        continue;
      }
      kept.push(entry);
    }
    entries = kept;
    // 容量超限：淘汰最早发生的事件；同一时刻用写入顺序兜底，绝不随机丢最新事件。
    while (entries.length > maxEvents) {
      let oldest = 0;
      for (let i = 1; i < entries.length; i += 1) {
        if (entries[i].startedAt < entries[oldest].startedAt
          || (entries[i].startedAt === entries[oldest].startedAt
            && entries[i].addedAt < entries[oldest].addedAt)) {
          oldest = i;
        }
      }
      const [dropped] = entries.splice(oldest, 1);
      byEventId.delete(dropped.eventId);
      safeEvict(dropped, 'capacity');
    }
    return entries.length;
  }

  /** 事件证据展开：entry id → 独立原帧引用；音频 id 直接保留时间线 id。 */
  function frameRefsFor(event, frameMap) {
    const refs = [];
    const ranges = [];
    const evidenceIds = idList(event.evidenceFrameIds, maxFrameIds);
    let known = false;
    for (const evidenceId of evidenceIds) {
      const record = frameMap.get(evidenceId);
      if (record === undefined) {
        // 兼容：事件已经直接引用原帧 id（例如手工/工具写入）。没有真实采集时间可证明，
        // 只为展示保留一个时间点，不把它当成“证据时间”。
        const capturedAt = toTime(event.from);
        if (capturedAt !== null) refs.push({ frameId: evidenceId, capturedAt });
        continue;
      }
      known = true;
      for (const ref of record.refs) refs.push(ref);
      if (record.startedAt !== undefined && record.endedAt !== undefined) {
        ranges.push({ startedAt: record.startedAt, endedAt: record.endedAt });
      }
      if (refs.length >= maxFrameIds) break;
    }
    return { refs: uniqueRefs(refs, maxFrameIds), ranges, known };
  }

  /**
   * 写入一批宏观理解事件。
   *
   * @param {object} input
   * @param {object[]} [input.events] `parseUnderstanding()` 的事件数组
   * @param {{from:number,to:number}} [input.interval]
   * @param {object[]} [input.frames] 本次理解实际使用的原始证据（含可选 `cells`）
   * @param {object[]} [input.audioLines] 本次理解实际使用的台词（媒体时间线条目）
   * @param {string|null} [input.shotId] 本次主要镜头
   * @param {string} [input.source] 来源机器标签
   * @param {number} [input.at]
   * @returns {{ok:boolean, reason:string, added:number, merged:number, skipped:number}}
   */
  function ingest(input = {}) {
    if (!isObject(input)) return { ok: false, reason: 'bad-input', added: 0, merged: 0, skipped: 0 };
    const events = Array.isArray(input.events) ? input.events : [];
    if (events.length === 0) {
      prune();
      return { ok: true, reason: 'no-events', added: 0, merged: 0, skipped: 0 };
    }

    prune();
    const frameMap = frameMapOf(input.frames, maxFrameIds);
    const audioMap = audioMapOf(input.audioLines);
    const dominantShotId = safeId(input.shotId);
    const sourceLabel = safeSource(input.source);
    const at = toTime(input.at) ?? clock();

    let added = 0;
    let merged = 0;
    let skipped = 0;

    for (const raw of events) {
      if (!isObject(raw)) {
        skipped += 1;
        continue;
      }
      const description = clipText(
        flattenText(raw.description),
        EVENT_INDEX_DEFAULTS.maxDescriptionChars,
      );
      const action = clipText(flattenText(raw.action), EVENT_INDEX_DEFAULTS.maxActionChars);
      if (description.length === 0 && action.length === 0) {
        skipped += 1;
        continue;
      }
      const startedAt = toTime(raw.from) ?? toTime(raw.startedAt);
      const endedAt = toTime(raw.to) ?? toTime(raw.endedAt);
      if (startedAt === null || endedAt === null || endedAt < startedAt) {
        skipped += 1;
        continue;
      }
      const { refs, ranges: frameRanges, known: framesKnown } = frameRefsFor(raw, frameMap);
      const audioIds = idList(raw.evidenceAudioIds, maxAudioIds);
      if (refs.length === 0 && audioIds.length === 0) {
        // 没有原始证据的纯推断不能进入共享索引；推断留给 sceneSummary/unresolved。
        skipped += 1;
        continue;
      }

      // 原帧证据范围与音频范围：事件时间必须与至少一段证据邻近；不能证明时保留但降级。
      const evidenceRanges = [...frameRanges];
      for (const audioId of audioIds) {
        const audio = audioMap.get(audioId);
        if (audio !== undefined) evidenceRanges.push({ startedAt: audio.startedAt, endedAt: audio.endedAt });
      }
      const evidenceNear = evidenceRanges.some((range) => nearRange(startedAt, endedAt, range));
      const timingUnknown = evidenceRanges.length === 0;
      const timingMismatch = !timingUnknown && !evidenceNear;
      const parsedConfidence = typeof raw.timeConfidence === 'string' ? raw.timeConfidence : '';
      const timeConfidence = timingMismatch
        ? 'low'
        : (timingUnknown ? 'unknown' : (parsedConfidence || 'high'));
      let uncertainty = withTimeNotes(raw.uncertainty, { mismatch: timingMismatch, unknown: timingUnknown });
      if (framesKnown && evidenceNear === false && timingUnknown === false) {
        uncertainty = withTimeNotes(uncertainty, { mismatch: true, unknown: false });
      }

      // keyDialogue：优先事件显式引用的台词；否则取与事件窗口相交的最近台词。只保留摘要。
      const dialogueParts = [];
      for (const audioId of audioIds) {
        const audio = audioMap.get(audioId);
        if (audio === undefined || audio.text.length === 0) continue;
        dialogueParts.push(audio.text);
      }
      if (dialogueParts.length === 0 && audioMap.size > 0) {
        const overlapping = [...audioMap.values()]
          .filter((audio) => audio.endedAt >= startedAt && audio.startedAt <= endedAt && audio.text.length > 0)
          .sort((left, right) => left.startedAt - right.startedAt);
        for (const audio of overlapping) dialogueParts.push(audio.text);
      }
      const keyDialogue = clipText(
        clipText(flattenText(dialogueParts.join(' / ')), EVENT_INDEX_DEFAULTS.maxDialogueChars),
        EVENT_INDEX_DEFAULTS.maxDialogueChars,
      );

      const shotId = safeId(raw.shotId)
        ?? refs.find((ref) => typeof ref.shotId === 'string')?.shotId
        ?? dominantShotId;
      const eventId = safeId(raw.id) ?? stableEventId(
        description,
        refs.map((ref) => ref.frameId),
        audioIds,
        shotId ?? null,
      );

      const entry = {
        eventId,
        startedAt,
        endedAt,
        ...(shotId === null ? {} : { shotId }),
        description: description.length > 0 ? description : action,
        ...(action.length > 0 ? { action } : {}),
        ...(keyDialogue.length > 0 ? { keyDialogue } : {}),
        frameIds: refs.map((ref) => ref.frameId),
        audioIds,
        uncertainty,
        source: sourceLabel,
        timeConfidence,
        addedAt: at,
        updatedAt: at,
        /** 内部原帧引用；公共视图只给 frameIds/frames。 */
        _frameRefs: refs,
      };

      const existing = byEventId.get(eventId);
      if (existing !== undefined) {
        // 同一事件在重叠窗口里被再次分析：扩展真实时间范围、合并证据，不追加第二条。
        existing.startedAt = Math.min(existing.startedAt, entry.startedAt);
        existing.endedAt = Math.max(existing.endedAt, entry.endedAt);
        existing.frameIds = [...new Set([...existing.frameIds, ...entry.frameIds])].slice(0, maxFrameIds);
        existing.audioIds = [...new Set([...existing.audioIds, ...entry.audioIds])].slice(0, maxAudioIds);
        existing._frameRefs = uniqueRefs([...existing._frameRefs, ...entry._frameRefs], maxFrameIds);
        if (!existing.description && entry.description) existing.description = entry.description;
        if (!existing.action && entry.action) existing.action = entry.action;
        if (!existing.keyDialogue && entry.keyDialogue) existing.keyDialogue = entry.keyDialogue;
        if (!existing.uncertainty && entry.uncertainty) existing.uncertainty = entry.uncertainty;
        if (entry.timeConfidence === 'high') existing.timeConfidence = 'high';
        existing.updatedAt = at;
        stats.merged += 1;
        merged += 1;
        continue;
      }

      entries.push(entry);
      byEventId.set(eventId, entry);
      stats.added += 1;
      added += 1;
    }

    lastAddedAt = added > 0 || merged > 0 ? at : lastAddedAt;
    prune();
    if (added > 0) event('vision.eventIndex.added', { added, merged, entries: entries.length });
    return { ok: true, reason: 'ok', added, merged, skipped };
  }

  function resolveTargetShot(query) {
    if (typeof query.previousShot === 'string') return safeId(query.previousShot);
    if (query.previousShot === true) {
      // 上一镜头：优先取“本轮窗口开始之前结束的最近事件”的镜头；切镜后的 8/16 秒窗口
      // 仍能命中旧镜头。没有当前镜头时也一样，只是不排除任何镜头。
      const baseTime = query.from ?? clock();
      let best = null;
      for (const entry of entries) {
        if (typeof entry.shotId !== 'string') continue;
        if (query.shotId !== null && entry.shotId === query.shotId) continue;
        if (entry.endedAt > baseTime + WINDOW_TOLERANCE_MS) continue;
        if (best === null || entry.endedAt > best.endedAt) best = entry;
      }
      if (best === null) {
        // 窗口里没有更早的事件时，退回“索引里最近一条有镜头的事件”，但仍不允许当前镜头。
        for (const entry of entries) {
          if (typeof entry.shotId !== 'string') continue;
          if (query.shotId !== null && entry.shotId === query.shotId) continue;
          if (best === null || entry.endedAt > best.endedAt) best = entry;
        }
      }
      return best === null ? null : best.shotId;
    }
    return query.shotId;
  }

  function normalizeQuery(raw) {
    const value = isObject(raw) ? raw : {};
    const window = isObject(value.window) ? value.window : value;
    let from = toTime(window.from) ?? toTime(value.from);
    let to = toTime(window.to) ?? toTime(value.to);
    if (from !== null && to === null) to = from;
    if (to !== null && from === null) from = to;
    if (from !== null && to !== null && from > to) [from, to] = [to, from];

    const requestedFrameIds = idList(value.frameIds, 32);
    const keywords = tokensOf(
      { text: value.text, keywords: value.keywords },
      EVENT_INDEX_DEFAULTS.maxKeywords,
    );
    let previousShot = value.previousShot;
    if (typeof previousShot === 'string') {
      previousShot = safeId(previousShot);
    } else if (previousShot !== true) {
      previousShot = null;
    }
    return {
      from,
      to: to ?? from,
      shotId: safeId(value.shotId),
      requestedFrameIds,
      tokens: keywords,
      previousShot,
      retrospective: value.retrospective === true,
      limit: Math.min(maxResults, toLimit(value.limit, defaultResults)),
      timeOnly: value.timeOnly === true || value.allowTimeOnly === true,
    };
  }

  function keyFramesFor(entry) {
    const inside = [];
    const refs = [...entry._frameRefs].sort((left, right) => left.capturedAt - right.capturedAt);
    if (refs.length > 0) {
      const middle = refs[Math.floor((refs.length - 1) / 2)];
      for (const candidate of [refs[0], middle, refs[refs.length - 1]]) {
        if (!inside.some((ref) => ref.frameId === candidate.frameId)) inside.push(candidate);
      }
    }
    let before = null;
    let after = null;
    // 前后关键帧必须是“事件之外”的帧：事件自己的证据不能冒充前/后画面。
    const ownFrames = new Set(entry.frameIds);
    for (const other of entries) {
      for (const ref of other._frameRefs) {
        if (ownFrames.has(ref.frameId)) continue;
        if (ref.capturedAt < entry.startedAt
          && (before === null || ref.capturedAt > before.capturedAt)) before = ref;
        if (ref.capturedAt > entry.endedAt
          && (after === null || ref.capturedAt < after.capturedAt)) after = ref;
      }
    }
    return {
      before: before === null ? null : publicRef(before),
      inside: inside.map(publicRef),
      after: after === null ? null : publicRef(after),
    };
  }

  function publicEvent(entry, match = null) {
    const frames = entry._frameRefs.map(publicRef);
    return {
      eventId: entry.eventId,
      startedAt: entry.startedAt,
      endedAt: entry.endedAt,
      ...(typeof entry.shotId === 'string' ? { shotId: entry.shotId } : {}),
      description: entry.description,
      ...(typeof entry.action === 'string' ? { action: entry.action } : {}),
      ...(typeof entry.keyDialogue === 'string' ? { keyDialogue: entry.keyDialogue } : {}),
      frameIds: entry.frameIds.slice(),
      audioIds: entry.audioIds.slice(),
      uncertainty: entry.uncertainty,
      source: entry.source,
      timeConfidence: entry.timeConfidence,
      frames,
      keyFrames: keyFramesFor(entry),
      ...(match === null ? {} : { match }),
    };
  }

  /**
   * 本地检索。
   *
   * 输入：`{from,to,text,keywords,shotId,frameIds,previousShot,retrospective,limit,timeOnly}`。
   * 文本关键词存在却一个都没命中时返回空（`no-keyword-match`），不会仅凭时间窗硬关联；
   * `previousShot` 显式请求时才找上一镜头，找不到就返回空并说明原因。
   */
  function search(query = {}) {
    prune();
    const q = normalizeQuery(query);
    const hasWindow = q.from !== null && q.to !== null;
    const hasCriteria = hasWindow || q.shotId !== null || q.requestedFrameIds.length > 0
      || q.tokens.length > 0 || q.previousShot !== null;
    if (!hasCriteria) {
      return emptyResult('no-query', '没有提供时间窗、关键词、镜头或原帧；不做强行关联。');
    }
    if (entries.length === 0) {
      return emptyResult('no-index', '事件索引为空；没有可关联的宏观事件。');
    }

    const targetShot = resolveTargetShot(q);
    if (q.previousShot === true && targetShot === null) {
      return emptyResult('no-previous-shot', '找不到上一镜头；不用当前镜头替代。');
    }
    // 只有原帧、没有其他条件时，原帧是硬过滤；与时间/镜头/文本一起用时作为强信号加分。
    const frameOnly = q.requestedFrameIds.length > 0
      && !hasWindow && q.shotId === null && q.previousShot === null && q.tokens.length === 0;

    const frameSet = new Set(q.requestedFrameIds);
    let pool = entries.filter((entry) => {
      if (targetShot !== null && entry.shotId !== targetShot) return false;
      if (frameOnly && !entry.frameIds.some((frameId) => frameSet.has(frameId))) return false;
      if (hasWindow && (entry.endedAt < q.from - WINDOW_TOLERANCE_MS
        || entry.startedAt > q.to + WINDOW_TOLERANCE_MS)) return false;
      return true;
    });
    if (targetShot !== null && pool.length === 0) {
      return emptyResult('no-shot-match', '指定镜头没有已索引事件；不用其他镜头替代。', {
        shotId: targetShot,
      });
    }
    if (frameOnly && pool.length === 0) {
      return emptyResult('no-frame-match', '指定原帧没有命中已索引事件。');
    }

    const scored = [];
    const keywordRequired = q.tokens.length > 0 && !q.timeOnly;
    for (const entry of pool) {
      const text = textScoreOf(entry, q.tokens);
      const frameHits = entry.frameIds.filter((frameId) => frameSet.has(frameId)).length;
      if (keywordRequired && text.hits === 0) continue;
      let score = text.score;
      if (targetShot !== null) score += 4;
      if (frameHits > 0) score += 4 * Math.min(3, frameHits);
      if (hasWindow) {
        const overlap = Math.min(entry.endedAt, q.to) - Math.max(entry.startedAt, q.from);
        score += overlap >= 0 ? 2 : 0;
      }
      scored.push({
        entry,
        score,
        match: {
          time: hasWindow,
          keyword: text.hits > 0,
          shot: targetShot !== null,
          frame: frameHits > 0,
        },
      });
    }

    if (scored.length === 0) {
      if (q.tokens.length > 0 && !q.timeOnly) {
        return emptyResult('no-keyword-match', '文本关键词没有命中任何已索引事件；不按时间强行关联。');
      }
      return emptyResult('no-match', '索引中没有符合本轮条件的宏观事件；不强行关联。');
    }

    let selected;
    if (q.tokens.length > 0) {
      selected = scored
        .slice()
        .sort((left, right) => right.score - left.score
          || right.entry.endedAt - left.entry.endedAt
          || left.entry.eventId.localeCompare(right.entry.eventId))
        .slice(0, q.limit);
    } else if (q.retrospective) {
      selected = scored
        .slice()
        .sort((left, right) => left.entry.startedAt - right.entry.startedAt
          || left.entry.eventId.localeCompare(right.entry.eventId))
        .slice(0, q.limit);
    } else {
      selected = scored
        .slice()
        .sort((left, right) => right.entry.startedAt - left.entry.startedAt
          || left.entry.eventId.localeCompare(right.entry.eventId))
        .slice(0, q.limit);
    }
    // 返回按时间升序，便于渲染“事件 + 时间”的自然阅读顺序。
    selected.sort((left, right) => left.entry.startedAt - right.entry.startedAt
      || left.entry.eventId.localeCompare(right.entry.eventId));

    return {
      ok: true,
      reason: 'ok',
      message: '',
      events: selected.map((item) => publicEvent(item.entry, item.match)),
      count: selected.length,
      query: {
        from: q.from,
        to: q.to,
        shotId: targetShot,
        keywordCount: q.tokens.length,
        originalCount: q.requestedFrameIds.length,
      },
    };
  }

  function get(eventId) {
    prune();
    const id = safeId(eventId);
    if (id === null) return null;
    const entry = byEventId.get(id);
    return entry === undefined ? null : publicEvent(entry);
  }

  function list({ limit = maxEvents } = {}) {
    prune();
    const count = toLimit(limit, maxEvents);
    return entries
      .slice()
      .sort((left, right) => left.startedAt - right.startedAt)
      .slice(-count)
      .map((entry) => publicEvent(entry));
  }

  function clear(reason = 'clear') {
    const count = entries.length;
    entries = [];
    byEventId.clear();
    stats.cleared += 1;
    // clear 原因只保留短机器标签：状态可读，但绝不把路径/正文写进 status。
    const label = flattenText(String(reason ?? 'clear')).trim();
    lastClearReason = SOURCE_PATTERN.test(label) ? label : 'clear';
    if (onClear !== null) {
      try {
        onClear(lastClearReason, count);
      } catch {
        /* 清理观测失败不能影响索引本身 */
      }
    }
    event('vision.eventIndex.cleared', { reason: lastClearReason, count });
    return { ok: true, cleared: count };
  }

  /** 只读状态：只有计数/时间/边界，不含正文、路径、帧 id 或音频 id。 */
  function status() {
    prune();
    const shots = new Set();
    let originalRefs = 0;
    let audioRefs = 0;
    for (const entry of entries) {
      if (typeof entry.shotId === 'string') shots.add(entry.shotId);
      originalRefs += entry.frameIds.length;
      audioRefs += entry.audioIds.length;
    }
    return {
      entries: entries.length,
      capacity: maxEvents,
      ttlMs,
      shots: shots.size,
      originalRefs,
      audioRefs,
      oldestAt: entries.length === 0 ? null : Math.min(...entries.map((entry) => entry.startedAt)),
      newestAt: entries.length === 0 ? null : Math.max(...entries.map((entry) => entry.endedAt)),
      lastAddedAt,
      added: stats.added,
      merged: stats.merged,
      skipped: stats.skipped,
      evicted: stats.evicted,
      cleared: stats.cleared,
      lastClearReason,
    };
  }

  return {
    ingest,
    /** 语义别名：事件索引只接收一次宏观理解的事件。 */
    add: ingest,
    search,
    /** 语义别名：检索不是模型调用，只是本地索引查询。 */
    retrieve: search,
    get,
    list,
    prune,
    clear,
    status,
  };
}

/**
 * 把一次检索结果渲染成被动上下文片段：宏观事件 + 时间 + 关键台词 + 相关原帧引用。
 * 空结果返回空串（不产生“没有相关事件”的噪音）；总长严格不超过 `maxChars`。
 *
 * @param {object} result `search()` 的返回值
 * @param {object} [options]
 * @param {number} [options.maxEvents]
 * @param {number} [options.maxChars]
 * @param {number} [options.maxDescriptionChars]
 * @param {number} [options.maxDialogueChars]
 * @returns {string}
 */
export function renderEventOverview(result, options = {}) {
  if (!isObject(result) || !Array.isArray(result.events) || result.events.length === 0) return '';
  const source = isObject(options) ? options : {};
  const maxEvents = toLimit(source.maxEvents, 2);
  const maxChars = toLimit(source.maxChars, 280);
  const maxDescriptionChars = toLimit(source.maxDescriptionChars, 90);
  const maxDialogueChars = toLimit(source.maxDialogueChars, 48);
  const lines = ['【画面事件｜本地索引】'];
  for (const event of result.events.slice(0, maxEvents)) {
    if (!isObject(event)) continue;
    const description = clipText(flattenText(event.description), maxDescriptionChars);
    if (description.length === 0) continue;
    const uncertainty = clipText(flattenText(event.uncertainty), 40);
    const suffix = uncertainty.length > 0 ? `（不确定：${uncertainty}）` : '';
    let line = `- ${clockText(event.startedAt)}–${clockText(event.endedAt)} ${description}${suffix}`;
    const dialogue = clipText(flattenText(event.keyDialogue), maxDialogueChars);
    if (dialogue.length > 0) line += `｜台词“${dialogue}”`;
    const refs = Array.isArray(event.frameIds)
      ? event.frameIds.filter((id) => safeId(id) !== null).slice(0, 3)
      : [];
    if (refs.length > 0) line += `｜原帧 ${refs.join('、')}`;
    lines.push(line);
  }
  if (lines.length <= 1) return '';
  return clipText(lines.join('\n'), maxChars);
}
