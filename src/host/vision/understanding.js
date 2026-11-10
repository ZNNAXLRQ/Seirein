/**
 * P-187 阶段 3 —— 连续视听理解的纯计算核心。
 *
 * 这一层不做任何 I/O：不截图、不采音、不读时间线、不调用模型、不设定时器。
 * 它只负责三件事：
 *
 *   1. `buildUnderstandingInput`：把一次后台分析要用的“证据 + 台词 + 上下文”组装好，
 *      只认真实采集时间（`capturedAt` / `audioStartAt` / `audioEndAt`），绝不拿识别完成时间
 *      或 `now` 去猜事件位置；
 *   2. `parseUnderstanding`：校验模型输出（对象或 JSON 字符串），只保留能落到真实证据上的
 *      事件；模型编造的 frame/audio id、越界时间、空描述都会整条丢弃并计数；
 *   3. `advanceUnderstanding`：把一次结果并进有界连续状态（事件与覆盖区间都是环形上限）。
 *
 * 两条硬原则：
 *
 *   - `previousScene` 只用于连续性，不会混进 `frames` / `audioLines`，它不是新证据；
 *   - 输入怎么畸形都不抛错，一律返回 `ok:false` + 机器可读 `reason`。
 *
 * 事件时间取舍：**越界一律丢弃，不夹到边界**。夹取会把模型编出来的时间“修”成看似合法的
 * 证据，也会替模型扩大它真正看到的时间范围；丢弃更保守，调用方还能从 `droppedEvents`
 * 看到模型输出质量。`from > to` 同样丢弃。
 */

import { createHash } from 'node:crypto';

/** 第一版试验参数；条数/字符都有上限，不按“大约”猜。 */
export const UNDERSTANDING_DEFAULTS = Object.freeze({
  /** 一次分析最多看几张。 */
  maxFrames: 8,
  /** 单次输出最多保留几个事件。 */
  maxEvents: 8,
  /** 单个事件描述上限（按 Unicode 码点计）。 */
  maxEventChars: 240,
  /** 单个事件可选反应角度上限（按 Unicode 码点计；提示词要求 ≤60，这里兜底到 80）。 */
  maxReactionChars: 80,
  /** sceneSummary 上限。 */
  maxSceneChars: 600,
  /** unresolved 上限。 */
  maxUnresolvedChars: 400,
  /** 单次分析最多带几句同期台词。 */
  maxAudioLines: 12,
});

/** 相邻两张选中帧的采集间隔超过这个值就记一段覆盖缺口（严格大于）。 */
const GAP_MS = 2_000;
/** 诊断用的未知证据 id 最多保留几个。 */
const MAX_UNKNOWN_IDS = 12;
/** uncertainty 文本上限；数字原样保留。 */
const MAX_UNCERTAINTY_CHARS = 80;
/** advanceUnderstanding 默认的环形长度。 */
const DEFAULT_RING = 32;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function trimmed(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 时间只接受有限、非负的毫秒值。数字字符串按数字处理（模型 JSON 偶尔把时间写成字符串），
 * 布尔值、对象、空串一律视为缺失。
 */
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

/**
 * 按“字符”截断。这里按 Unicode 码点计，而不是 UTF-16 码元：一个 emoji 不会被从中间劈开，
 * 也不会因为占两个码元就提前吃掉预算。
 */
function clipText(value, limit) {
  const text = typeof value === 'string' ? value : '';
  if (text.length === 0) return '';
  const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0;
  if (max === 0) return '';
  if (text.length <= max) return text;
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max).join('');
}

/** 有效区间：`from`、`to` 都是有限非负时间，且 `to >= from`。 */
function normalizeInterval(value) {
  if (!isObject(value)) return null;
  const from = toTime(value.from);
  const to = toTime(value.to);
  if (from === null || to === null || to < from) return null;
  return { from, to };
}

/** 帧/台词 id 集合；非数组/非字符串条目直接忽略（证据窗口与时间线本身已保证类型）。 */
function idSet(value) {
  const set = new Set();
  if (typeof value === 'string') {
    const id = value.trim();
    if (id.length > 0) set.add(id);
    return set;
  }
  if (!Array.isArray(value)) return set;
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const id = entry.trim();
    if (id.length > 0) set.add(id);
  }
  return set;
}

/**
 * 在帧数超过预算时均匀取样：保留首尾、尽量覆盖整个区间，而不是只看最后几张。
 * `limit === 1` 时保留最新一帧（当前状态比起点更有用）。
 */
function sampleEvenly(list, limit) {
  if (list.length <= limit) return list.slice();
  if (limit === 1) return [list[list.length - 1]];
  const picked = [];
  for (let i = 0; i < limit; i += 1) {
    picked.push(list[Math.round((i * (list.length - 1)) / (limit - 1))]);
  }
  return picked;
}

/** 组装失败时也返回完整字段，调用方不需要先判断再解构。 */
function buildFailure(reason, interval = null, previousScene = '', focus = '') {
  return {
    ok: false,
    reason,
    interval,
    frameIds: [],
    frames: [],
    audioLines: [],
    previousScene,
    focus,
    gaps: [],
  };
}

/**
 * 组装一次后台分析的输入（不含提示词模板；提示词由调用方负责）。
 *
 * 帧：只保留 `capturedAt` 落在 `interval` 内的帧，按采集时间升序；同一 `id` 只留最早一条；
 * 超出 `maxFrames` 时均匀取样（首尾必留）。`gaps` 按**实际选中的帧**计算：相邻帧采集间隔
 * 严格大于 2 s 记一段；首帧之前、末帧之后不补外部缺口（那不属于“帧之间的缺口”）。
 *
 * 台词：按音频区间与 `interval` 相交筛选，按 `audioStartAt` 升序；超预算时保留最近
 * `maxAudioLines` 句（更早的内容应由 `previousScene` 承担连续性）。
 *
 * `previousScene` / `focus` 只是上下文，不会出现在 `frames` / `audioLines` / `frameIds` 里。
 *
 * @param {object} [input]
 * @returns {object} 成功或失败的完整结果对象
 */
export function buildUnderstandingInput(input = {}) {
  if (!isObject(input)) return buildFailure('bad-input');

  const previousScene = clipText(trimmed(input.previousScene), UNDERSTANDING_DEFAULTS.maxSceneChars);
  const focus = clipText(trimmed(input.focus), UNDERSTANDING_DEFAULTS.maxSceneChars);
  const interval = normalizeInterval(input.interval);
  if (interval === null) return buildFailure('no-interval', null, previousScene, focus);

  const frameBudget = toLimit(input.maxFrames, UNDERSTANDING_DEFAULTS.maxFrames);
  const audioBudget = toLimit(input.maxAudioLines, UNDERSTANDING_DEFAULTS.maxAudioLines);

  // 帧：时间与 id 必须真实；区间外的帧不参与本次理解。
  const validFrames = [];
  if (Array.isArray(input.frames)) {
    for (const entry of input.frames) {
      if (!isObject(entry)) continue;
      const id = trimmed(entry.id);
      const capturedAt = toTime(entry.capturedAt);
      if (id.length === 0 || capturedAt === null) continue;
      if (capturedAt < interval.from || capturedAt > interval.to) continue;
      validFrames.push({ id, capturedAt });
    }
  }
  validFrames.sort((a, b) => a.capturedAt - b.capturedAt || a.id.localeCompare(b.id));
  const uniqueFrames = [];
  const seenFrames = new Set();
  for (const frame of validFrames) {
    if (seenFrames.has(frame.id)) continue;
    seenFrames.add(frame.id);
    uniqueFrames.push(frame);
  }
  if (uniqueFrames.length === 0) return buildFailure('no-frames', interval, previousScene, focus);

  const frames = sampleEvenly(uniqueFrames, frameBudget);

  const gaps = [];
  for (let i = 1; i < frames.length; i += 1) {
    const previous = frames[i - 1];
    const current = frames[i];
    if (current.capturedAt - previous.capturedAt > GAP_MS) {
      gaps.push({ from: previous.capturedAt, to: current.capturedAt });
    }
  }

  // 台词：保留原始音频区间，只做相交筛选，不把识别完成时间当成发言时间。
  const validAudio = [];
  if (Array.isArray(input.audioLines)) {
    for (const entry of input.audioLines) {
      if (!isObject(entry)) continue;
      const id = trimmed(entry.id);
      const audioStartAt = toTime(entry.audioStartAt);
      const audioEndAt = toTime(entry.audioEndAt);
      if (id.length === 0 || audioStartAt === null || audioEndAt === null || audioEndAt < audioStartAt) continue;
      if (audioEndAt < interval.from || audioStartAt > interval.to) continue;
      const text = trimmed(entry.text);
      if (text.length === 0) continue; // 没有文字就不占一次理解预算
      validAudio.push({ id, audioStartAt, audioEndAt, text });
    }
  }
  validAudio.sort((a, b) => a.audioStartAt - b.audioStartAt
    || a.audioEndAt - b.audioEndAt
    || a.id.localeCompare(b.id));
  const uniqueAudio = [];
  const seenAudio = new Set();
  for (const line of validAudio) {
    if (seenAudio.has(line.id)) continue;
    seenAudio.add(line.id);
    uniqueAudio.push(line);
  }
  const audioLines = uniqueAudio.slice(-audioBudget);

  return {
    ok: true,
    reason: 'ok',
    interval,
    frameIds: frames.map((frame) => frame.id),
    frames,
    audioLines,
    previousScene,
    focus,
    gaps,
  };
}

/**
 * 给 bad-json 诊断用的有界摘要：只保留原始输出的长度与哈希，绝不把正文/画面内容带出去。
 * 哈希用于同一份坏输出在日志里可关联，无法反推出原文。
 */
function rawDiagnostics(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return {};
  return {
    rawChars: raw.length,
    rawHash: createHash('sha1').update(raw).digest('hex').slice(0, 16),
  };
}

/**
 * 解码模型原始输出：支持对象、JSON 字符串、一层 ```json 围栏，以及 JSON 外夹带少量说明
 * 的常见输出。先按整体/围栏解析；仍失败时取第一个 `{` 到最后一个 `}` 再解析。只做位置
 * 容错，不猜测或修补字段；仍失败才是 bad-json。
 */
function decodeRaw(raw) {
  if (raw === null || raw === undefined) return { ok: false, reason: 'not-object' };
  if (typeof raw === 'object') {
    if (Array.isArray(raw)) return { ok: false, reason: 'not-object' };
    return { ok: true, value: raw };
  }
  if (typeof raw !== 'string') return { ok: false, reason: 'not-object' };
  let text = raw.trim();
  if (text.length === 0) return { ok: false, reason: 'bad-json', ...rawDiagnostics(raw) };
  if (text.startsWith('```')) {
    const fenced = text.match(/^```[a-zA-Z0-9_-]*\s*\n?([\s\S]*?)\n?```\s*$/);
    if (fenced !== null) text = fenced[1].trim();
  }
  if (text.length === 0) return { ok: false, reason: 'bad-json', ...rawDiagnostics(raw) };

  let value;
  let parsed = false;
  try {
    value = JSON.parse(text);
    parsed = true;
  } catch {
    parsed = false;
  }
  if (!parsed) {
    // 说明/前后缀夹在 JSON 外：只取第一个 { 到最后一个 }，不做字段级修补。
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        value = JSON.parse(text.slice(start, end + 1));
        parsed = true;
      } catch {
        parsed = false;
      }
    }
  }
  if (!parsed) return { ok: false, reason: 'bad-json', ...rawDiagnostics(raw) };
  if (!isObject(value)) return { ok: false, reason: 'not-object' };
  return { ok: true, value };
}

function parseFailure(reason, interval, diagnostics = {}) {
  const result = {
    ok: false,
    reason,
    interval,
    sceneSummary: '',
    events: [],
    unresolved: '',
    droppedEvents: 0,
    unknownEvidenceIds: [],
  };
  const source = diagnostics !== null && typeof diagnostics === 'object' ? diagnostics : {};
  if (Number.isSafeInteger(source.rawChars) && source.rawChars >= 0) {
    result.rawChars = source.rawChars;
  }
  if (typeof source.rawHash === 'string' && source.rawHash.length > 0) {
    result.rawHash = source.rawHash;
  }
  return result;
}

/**
 * 校验一次模型输出。`events` 中任意一条只要满足以下任一条就整条丢弃并计入 `droppedEvents`：
 *
 *   - 不是对象；
 *   - `description` 为空/纯空白（或不是字符串）；
 *   - `from` / `to` 不是有限时间，或 `from > to`；
 *   - 时间不在本次 `interval` 内（含 `from`/`to` 边界，越界**不夹取**）；
 *   - `evidenceFrameIds` / `evidenceAudioIds` 不是数组，或引用了 `frameIds` / `audioIds`
 *     里不存在的 id；
 *   - 两个证据数组都为空：事件必须指向原始帧/台词，纯推断只能写进 `sceneSummary` /
 *     `unresolved`，不能当事件进入共享状态。
 *
 * `uncertainty` 只是线索，字符串按 80 字符截断、数字原样保留。`reaction` 是可选的反应角度：
 * 非空字符串 trim 后截到 80 字符并保留；空白、非字符串或缺失时不写该字段（不写空串占位），
 * 也不因此丢弃事件。
 *
 * @param {object} [input]
 * @returns {object}
 */
export function parseUnderstanding(input = {}) {
  if (!isObject(input)) return parseFailure('bad-input', null);
  const interval = normalizeInterval(input.interval);
  if (interval === null) return parseFailure('no-interval', null);

  const decoded = decodeRaw(input.raw);
  if (!decoded.ok) return parseFailure(decoded.reason, interval, decoded);
  const value = decoded.value;

  const sceneSummary = clipText(trimmed(value.sceneSummary), UNDERSTANDING_DEFAULTS.maxSceneChars);
  if (sceneSummary.length === 0) return parseFailure('no-scene', interval);

  let eventSource;
  if (value.events === undefined || value.events === null) eventSource = [];
  else if (Array.isArray(value.events)) eventSource = value.events;
  else return parseFailure('bad-events', interval);

  const frameSet = idSet(input.frameIds);
  const audioSet = idSet(input.audioIds);
  const unknownEvidenceIds = [];
  const unknownSeen = new Set();
  const noteUnknown = (value) => {
    if (unknownEvidenceIds.length >= MAX_UNKNOWN_IDS) return;
    let label;
    try {
      label = String(value ?? '(invalid)');
    } catch {
      label = '(invalid)';
    }
    const id = clipText(label.trim() || '(invalid)', 80);
    if (unknownSeen.has(id)) return;
    unknownSeen.add(id);
    unknownEvidenceIds.push(id);
  };

  /** 证据数组：合法 id 去重；任何未知/非字符串条目都会让整条事件作废。 */
  function readEvidence(raw, known) {
    if (raw === undefined || raw === null) return { ok: true, ids: [] };
    if (!Array.isArray(raw)) return { ok: false, ids: [] };
    const ids = [];
    let ok = true;
    for (const entry of raw) {
      if (typeof entry !== 'string' || entry.trim().length === 0) {
        ok = false;
        noteUnknown(entry);
        continue;
      }
      const id = entry.trim();
      if (!ids.includes(id)) ids.push(id);
      if (!known.has(id)) {
        ok = false;
        noteUnknown(id);
      }
    }
    return { ok, ids };
  }

  const events = [];
  let droppedEvents = 0;
  for (const rawEvent of eventSource) {
    if (!isObject(rawEvent)) {
      droppedEvents += 1;
      continue;
    }
    const description = clipText(trimmed(rawEvent.description), UNDERSTANDING_DEFAULTS.maxEventChars);
    if (description.length === 0) {
      droppedEvents += 1;
      continue;
    }
    const from = toTime(rawEvent.from);
    const to = toTime(rawEvent.to);
    if (from === null || to === null || from > to) {
      droppedEvents += 1;
      continue;
    }
    if (from < interval.from || to > interval.to) {
      droppedEvents += 1;
      continue;
    }
    const frameEvidence = readEvidence(rawEvent.evidenceFrameIds, frameSet);
    const audioEvidence = readEvidence(rawEvent.evidenceAudioIds, audioSet);
    if (!frameEvidence.ok || !audioEvidence.ok) {
      droppedEvents += 1;
      continue;
    }
    // 没有真实证据的事件只是推断，不能挤进共享的事件状态；推断交给 sceneSummary / unresolved。
    if (frameEvidence.ids.length === 0 && audioEvidence.ids.length === 0) {
      droppedEvents += 1;
      continue;
    }
    const reaction = clipText(trimmed(rawEvent.reaction), UNDERSTANDING_DEFAULTS.maxReactionChars);
    const parsedEvent = {
      from,
      to,
      description,
      evidenceFrameIds: frameEvidence.ids,
      evidenceAudioIds: audioEvidence.ids,
      uncertainty: normalizeUncertainty(rawEvent.uncertainty),
    };
    // reaction 只是可选的角度；空白/畸形当作“没有”，绝不写空串占位。
    if (reaction.length > 0) parsedEvent.reaction = reaction;
    events.push(parsedEvent);
  }

  const eventBudget = toLimit(input.maxEvents, UNDERSTANDING_DEFAULTS.maxEvents);
  const unresolved = clipText(trimmed(value.unresolved), UNDERSTANDING_DEFAULTS.maxUnresolvedChars);

  return {
    ok: true,
    reason: 'ok',
    interval,
    sceneSummary,
    events: events.slice(0, eventBudget),
    unresolved,
    droppedEvents,
    unknownEvidenceIds,
  };
}

function normalizeUncertainty(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : '';
  return clipText(trimmed(value), MAX_UNCERTAINTY_CHARS);
}

/** 归一化一个 `{from,to}` 覆盖区间；畸形条目直接忽略。 */
function normalizeSpan(value) {
  if (!isObject(value)) return null;
  const from = toTime(value.from);
  const to = toTime(value.to);
  if (from === null || to === null || to < from) return null;
  return { from, to };
}

function normalizeSpans(value) {
  if (!Array.isArray(value)) return [];
  const spans = [];
  for (const entry of value) {
    const span = normalizeSpan(entry);
    if (span !== null) spans.push(span);
  }
  return spans;
}

/** 合并重叠或首尾相接的区间，按开始时间升序；结果不共享输入对象。 */
function mergeSpans(spans) {
  const sorted = spans
    .map((span) => ({ from: span.from, to: span.to }))
    .sort((a, b) => a.from - b.from || a.to - b.to);
  const merged = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && span.from <= last.to) {
      last.to = Math.max(last.to, span.to);
      continue;
    }
    merged.push(span);
  }
  return merged;
}

/** 用缺口列表从区间里减出真正覆盖的片段（缺口先与区间求交）。 */
function subtractGaps(interval, gaps) {
  const covered = [];
  let cursor = interval.from;
  for (const gap of mergeSpans(gaps)) {
    const from = Math.max(interval.from, gap.from);
    const to = Math.min(interval.to, gap.to);
    if (to < from) continue;
    if (from > cursor) covered.push({ from: cursor, to: from });
    if (to > cursor) cursor = to;
  }
  if (cursor < interval.to) covered.push({ from: cursor, to: interval.to });
  return covered;
}

/**
 * 从一次更新里得到“真正覆盖”的时间片段：
 *
 *   - 显式 `coverage` 优先（调用方已经算好覆盖片段）；
 *   - 否则用 `interval - gaps`：这是与 `buildUnderstandingInput().gaps` 对接的方式，
 *     缺口会真实保留在状态里，不会被当成“全程看懂”；
 *   - 两者都没有时，才把整个 `interval` 视为已覆盖。
 *
 * 显式字段畸形（存在但不是数组）时返回空，宁可记成“没覆盖”，也不虚报覆盖。
 */
function coverageFromUpdate(update) {
  if (!isObject(update)) return [];
  if (Array.isArray(update.coverage)) return normalizeSpans(update.coverage);
  if ('coverage' in update) return [];
  const interval = normalizeInterval(update.interval);
  if (interval === null) return [];
  if (Array.isArray(update.gaps)) return subtractGaps(interval, normalizeSpans(update.gaps));
  if ('gaps' in update) return [];
  return [interval];
}

function cloneEvent(event) {
  if (!isObject(event)) return null;
  const copy = { ...event };
  if (Array.isArray(event.evidenceFrameIds)) {
    copy.evidenceFrameIds = event.evidenceFrameIds.filter((id) => typeof id === 'string');
  }
  if (Array.isArray(event.evidenceAudioIds)) {
    copy.evidenceAudioIds = event.evidenceAudioIds.filter((id) => typeof id === 'string');
  }
  return copy;
}

function resolveUpdatedAt(options) {
  const source = options.now;
  if (typeof source === 'function') {
    try {
      const value = toTime(source());
      if (value !== null) return value;
    } catch {
      /* 调用方的时钟失败不影响状态推进 */
    }
    return null;
  }
  if (source === undefined) return null;
  return toTime(source);
}

/**
 * 把新结果并入连续状态。返回对象只包含状态字段，不修改 `previous` / `update`：
 *
 *   - `sceneSummary`：新结果非空则替换，否则沿用上一段（摘要负责连续性）；
 *   - `events`：按到达顺序追加，默认最多保留最近 32 条（环形淘汰最旧）；事件对象整体浅拷贝，
 *     所以 `reaction` 等可选字段原样保留（证据 id 数组仍会复制）；
 *   - `unresolved`：新结果非空则替换，否则沿用上一段；始终截断到上限；
 *   - `coverage`：把本次覆盖片段与历史合并（重叠/相接的区间合并），默认最多 32 段。
 *     `update.gaps` 会从 `update.interval` 中扣除，所以缺口不会被虚报成覆盖；
 *   - `updatedAt`：只在 `opts.now`（数字或函数且可解析）时出现；不会复用 `previous.updatedAt`，
 *     避免把旧时间戳写得像“刚刚更新过”。它只是状态簿记，从不用于推断事件位置。
 *
 * @param {object} [previous]
 * @param {object} [update]
 * @param {{maxEvents?: number, maxCoverage?: number, now?: number|(() => number)}} [options]
 * @returns {{sceneSummary: string, events: object[], unresolved: string, coverage: {from:number,to:number}[], updatedAt?: number}}
 */
export function advanceUnderstanding(previous, update, options = {}) {
  const base = isObject(previous) ? previous : {};
  const next = isObject(update) ? update : {};
  const opts = isObject(options) ? options : {};
  const eventLimit = toLimit(opts.maxEvents, DEFAULT_RING);
  const coverageLimit = toLimit(opts.maxCoverage, DEFAULT_RING);

  const previousEvents = Array.isArray(base.events) ? base.events : [];
  const nextEvents = Array.isArray(next.events) ? next.events : [];
  const events = [...previousEvents, ...nextEvents]
    .map(cloneEvent)
    .filter((event) => event !== null)
    .slice(-eventLimit);

  const previousScene = typeof base.sceneSummary === 'string' ? base.sceneSummary : '';
  const nextScene = trimmed(next.sceneSummary);
  const sceneSummary = clipText(
    nextScene.length > 0 ? nextScene : previousScene,
    UNDERSTANDING_DEFAULTS.maxSceneChars,
  );

  const previousUnresolved = typeof base.unresolved === 'string' ? base.unresolved : '';
  const nextUnresolved = trimmed(next.unresolved);
  const unresolved = clipText(
    nextUnresolved.length > 0 ? nextUnresolved : previousUnresolved,
    UNDERSTANDING_DEFAULTS.maxUnresolvedChars,
  );

  const coverage = mergeSpans([
    ...normalizeSpans(base.coverage),
    ...coverageFromUpdate(next),
  ]).slice(-coverageLimit);

  const result = { sceneSummary, events, unresolved, coverage };
  const updatedAt = resolveUpdatedAt(opts);
  if (updatedAt !== null) result.updatedAt = updatedAt;
  return result;
}
