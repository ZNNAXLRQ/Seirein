/**
 * P-187 阶段 3 —— 连续视听理解运行时编排（可测试纯模块）。
 *
 * 这一层只做“串起来”的工作，不接宿主、不读文件、不直接调用模型、不创建真实设备：
 *
 *   取证据（注入的 framesBetween / audioBetween）
 *     → buildUnderstandingInput（预算与取样）
 *     → buildUnderstandingPrompt（system/user）
 *     → analyze（注入的 async 调用，失败/坏输出都不外抛）
 *     → 解开真实分析器的 `{ok,text,reason,images}` 包装（失败按 reason 记账，不送解析）
 *     → parseUnderstanding（只保留落在真实证据上的事件）
 *     → advanceUnderstanding（并入有界连续状态）
 *     → render（被动注入块）
 *
 * 成功并入状态后可选回调 `onAdvance({ parsed, state })`，供阶段 5 主动候选消费；回调拿到的是
 * 副本，抛错只产生一条 emit 事件，不改变本次运行结果。
 *
 * 四条硬约束：
 *
 *   1. 单在途：调度器触发的 run 与手动 runNow 共用同一个在途标记，任何时刻最多一次 analyze；
 *   2. 代次检查：clear()/stop() 会让旧代次在途结果失效，分析即使晚到也不得写回状态，也不得
 *      触发 onAdvance；
 *   3. 有界与无路径：render() 只输出场景摘要、最近事件、unresolved、覆盖缺口提示，不渲染
 *      文件路径、帧 id、证据数组或任何内部对象；总长严格不超过 maxChars；
 *   4. 任何异常都不抛给调用方：宿主回调、analyze、解析、状态推进各自兜底，返回机器可读
 *      `{ok:false, reason}`。status() 与 emit() 只带计数/原因/时间/安全 meta，不带素材正文；
 *   5. 连续失败退避：连续 N 次失败后进入指数退避（status 暴露 degraded/retryAt/lastError），
 *      退避期保留采集与状态但不再到点请求；失败样本只在内存里保留 3 条/10 分钟/每条正文 2KB，
 *      只通过显式 samples() 读取，隐私 clear/stop 时清空。
 *
 * 状态过期在读取时发生（current()/render()），不会后台定时清理；这样没有真实定时器的测试
 * 也能用假时钟推进验证。
 */

import {
  UNDERSTANDING_DEFAULTS,
  advanceUnderstanding,
  buildUnderstandingInput,
  parseUnderstanding,
} from './understanding.js';
import { buildUnderstandingPrompt } from './understanding-prompt.js';
import { createUnderstandingScheduler } from './understanding-scheduler.js';
import { createUnderstandingSamples, sanitizeDiagnosticMeta } from './understanding-samples.js';

/** 运行时预算；与纯计算/提示词层的默认值相互独立。 */
export const UNDERSTANDING_RUNTIME_DEFAULTS = Object.freeze({
  /** 单次分析最多给分析器几张图。 */
  maxFrames: 3,
  /** 被动块文本上限。 */
  maxChars: 900,
  /** 渲染最近几条事件。 */
  maxEventsShown: 3,
  /** 状态保留上限（超时清空）。 */
  maxAgeMs: 300_000,
});

/** 后台分析最小间隔；比纯调度默认 3s 更保守，避免付费模型过频。 */
const DEFAULT_MIN_INTERVAL_MS = 15_000;
/** 连续失败达到这个次数才退避；少一次失败仍保持正常节奏，避免偶发错误立刻停摆。 */
const DEFAULT_FAILURE_THRESHOLD = 3;
/** 退避首档 60s；之后按 2 的幂增长，上限 10 分钟。绝不继续按 20s 烧请求。 */
const DEFAULT_BACKOFF_BASE_MS = 60_000;
const DEFAULT_BACKOFF_MAX_MS = 600_000;
/** 原因只作为状态标签：单行、限长，避免长文本/控制字符进入 status。 */
const MAX_REASON_CHARS = 80;
/** provider 错误码同样只保留短机器码；正文、路径或空白一律丢弃。 */
const MAX_ERROR_CODE_CHARS = 64;
const MACHINE_CODE = /^[A-Za-z0-9_.:-]+$/u;
/** raw 摘要只保留长度和哈希；原文永不进入事件/status。 */
const MAX_RAW_HASH_CHARS = 64;
/** 定向分析的关注点上限；只作为提示词上下文，不进入状态/status 正文。 */
const MAX_FOCUS_CHARS = 200;
/** 单个描述/场景的渲染预算上限（仍受总 maxChars 兜底）。 */
const MAX_SCENE_CHARS = 320;
const MAX_EVENT_CHARS = 180;
const MAX_UNRESOLVED_CHARS = 240;
const MAX_UNCERTAINTY_CHARS = 60;
/** 渲染时按本轮窗口选事件：窗口边界允许这么点容差，避免整秒取整把边界事件漏掉。 */
const FOCUS_TOLERANCE_MS = 500;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 数量上限：非法值退回默认，正数向下取整。 */
function toLimit(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.max(1, Math.floor(number));
}

/** 允许 0 的计数上限（maxEventsShown 为 0 表示不展示事件）。 */
function toCount(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return fallback;
  return Math.floor(number);
}

/** 允许 0 的时长（maxAgeMs=0 表示读一次就过期）。 */
function toDuration(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return fallback;
  return Math.floor(number);
}

function timeValue(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? value : null;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : null;
  }
  return null;
}

/** 状态标签：扁平化控制字符并限长；不保留任何素材正文。 */
function reasonText(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .trim()
    .slice(0, MAX_REASON_CHARS);
}

/**
 * provider 错误码：只接受短机器码。与 image-analyzer 的透出规则一致，任何可能夹带
 * 正文/路径/空白的值都丢弃，宁可空着也不污染日志或 status。
 */
function errorCodeText(value) {
  if (typeof value !== 'string') return '';
  const code = value.trim();
  if (code.length === 0 || code.length > MAX_ERROR_CODE_CHARS) return '';
  if (!MACHINE_CODE.test(code)) return '';
  return code;
}

/**
 * 失败样本正文只看分析器显式挂载的非枚举诊断字段；`ok:false` 包装里的 `text` 不信任，
 * 避免把测试替身/失败占位文本误当模型输出。成功但解析失败（bad-json）则由调用方传入 raw。
 */
function diagnosticTextOf(output) {
  if (!isObject(output)) return '';
  try {
    if (typeof output.diagnosticText === 'string') return output.diagnosticText;
    if (typeof output.sampleText === 'string') return output.sampleText;
  } catch {
    /* 诊断字段的 getter 抛错时按“没有正文”处理 */
  }
  return '';
}

/** meta 来自可注入的 analyze；getter/代理抛错也不能让整次运行变成未处理拒绝。 */
function safeDiagnosticMeta(value) {
  try {
    return sanitizeDiagnosticMeta(value);
  } catch {
    return null;
  }
}

/** bad-json 诊断：长度与哈希；原文只在这里被摘要，绝不返回。 */
function rawDiagnostics(diagnostics) {
  const source = isObject(diagnostics) ? diagnostics : {};
  const chars = Number(source.rawChars);
  const hash = typeof source.rawHash === 'string' ? source.rawHash.trim() : '';
  return {
    rawChars: Number.isSafeInteger(chars) && chars >= 0 ? chars : 0,
    rawHash: hash.length > 0 && hash.length <= MAX_RAW_HASH_CHARS ? hash : '',
  };
}

/** 渲染前扁平化：换行/控制字符不参与结构，避免模型文本伪造小节。 */
function flattenText(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 归一化可选关注点：非字符串忽略；换行/控制字符压成单行空格；按 UTF-16 长度截到
 * MAX_FOCUS_CHARS（用 clipText，超限时留省略号，结果 length 不超过上限）。
 * 它只是提示词上下文，不写入状态，也不进入 status 正文。
 */
function focusText(value) {
  if (typeof value !== 'string') return '';
  return clipText(flattenText(value), MAX_FOCUS_CHARS);
}

/**
 * 按 UTF-16 长度截断并留出省略号位置，保证返回值 length 不超过 limit；
 * 不会从代理对中间劈开。limit 为 0 时返回空串。
 */
function clipText(value, limit) {
  const text = typeof value === 'string' ? value : '';
  const max = Math.max(0, Math.floor(Number(limit) || 0));
  if (max === 0) return '';
  if (text.length <= max) return text;
  let cut = max - 1;
  if (cut > 0 && /[\uD800-\uDBFF]/.test(text[cut - 1])) cut -= 1;
  return `${text.slice(0, Math.max(0, cut))}…`;
}

/** 本地 HH:MM:SS；无效时间保留格式但不猜时间。 */
function clockText(value) {
  const at = timeValue(value);
  if (at === null) return '--:--:--';
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return '--:--:--';
  const pad = (number) => String(number).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** 把 runNow 的窗口归一成有限、非负、from<=to；缺省时退化为“此刻”的零宽窗口。 */
function windowOf(request, at) {
  const source = isObject(request) ? request : {};
  const from = timeValue(source.from);
  const to = timeValue(source.to);
  if (from === null && to === null) return { from: at, to: at };
  if (from === null) return { from: to, to };
  if (to === null) return { from, to: from };
  return from <= to ? { from, to } : { from: to, to: from };
}

function uncertaintyText(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  return flattenText(value);
}

function cloneEvent(event) {
  const copy = {
    from: event.from,
    to: event.to,
    description: event.description,
    evidenceFrameIds: Array.isArray(event.evidenceFrameIds) ? event.evidenceFrameIds.slice() : [],
    evidenceAudioIds: Array.isArray(event.evidenceAudioIds) ? event.evidenceAudioIds.slice() : [],
    uncertainty: event.uncertainty,
  };
  // 时间来源/镜头/证据可用性/稳定 id 都是事件契约的一部分：保留，但不补空串。
  if (typeof event.id === 'string' && event.id.length > 0) copy.id = event.id;
  if (typeof event.shotId === 'string' && event.shotId.length > 0) copy.shotId = event.shotId;
  if (typeof event.timeSource === 'string' && event.timeSource.length > 0) copy.timeSource = event.timeSource;
  if (typeof event.timeConfidence === 'string' && event.timeConfidence.length > 0) {
    copy.timeConfidence = event.timeConfidence;
  }
  if (typeof event.evidenceAvailable === 'boolean') copy.evidenceAvailable = event.evidenceAvailable;
  // reaction 是可选字段；保留它，但绝不把空串补成字段。
  if (typeof event.reaction === 'string' && event.reaction.length > 0) copy.reaction = event.reaction;
  return copy;
}

function cloneSpan(span) {
  return { from: span.from, to: span.to };
}

function cloneSummary(summary) {
  const copy = { text: summary.text };
  if (typeof summary.from === 'number' && Number.isFinite(summary.from)) copy.from = summary.from;
  if (typeof summary.to === 'number' && Number.isFinite(summary.to)) copy.to = summary.to;
  if (typeof summary.shotId === 'string' && summary.shotId.length > 0) copy.shotId = summary.shotId;
  return copy;
}

/** 给 onAdvance 的 parsed 副本：调用方改不到本次运行的返回值和内部状态。 */
function cloneParsed(parsed) {
  if (!isObject(parsed)) return parsed;
  return {
    ...parsed,
    interval: isObject(parsed.interval) ? { ...parsed.interval } : parsed.interval,
    events: Array.isArray(parsed.events) ? parsed.events.map((event) => cloneEvent(event)) : [],
    unknownEvidenceIds: Array.isArray(parsed.unknownEvidenceIds)
      ? parsed.unknownEvidenceIds.slice()
      : [],
  };
}

/** 给 onAdvance 的 state 副本：与 current() 一样不暴露内部对象引用。 */
function cloneState(state) {
  const copy = {
    sceneSummary: state.sceneSummary,
    events: Array.isArray(state.events) ? state.events.map((event) => cloneEvent(event)) : [],
    unresolved: state.unresolved,
    coverage: Array.isArray(state.coverage) ? state.coverage.map(cloneSpan) : [],
  };
  if (Array.isArray(state.summaries) && state.summaries.length > 0) {
    copy.summaries = state.summaries.map(cloneSummary);
  }
  if (state.updatedAt !== undefined) copy.updatedAt = state.updatedAt;
  return copy;
}

function stateHasContent(state) {
  if (state === null) return false;
  return (
    (typeof state.sceneSummary === 'string' && state.sceneSummary.length > 0)
    || (Array.isArray(state.events) && state.events.length > 0)
    || (typeof state.unresolved === 'string' && state.unresolved.length > 0)
    || (Array.isArray(state.coverage) && state.coverage.length > 0)
  );
}

/**
 * 本轮检索焦点：窗口（from/to）或镜头 id，二者至少有一个。渲染只接受简单值，
 * 不把调用方对象带进状态；不可解析时退化为“无焦点”（旧的最近 N 条行为）。
 */
function normalizeFocus(value) {
  const source = isObject(value) ? value : null;
  if (source === null) return null;
  const from = timeValue(source.from);
  const to = timeValue(source.to);
  let window = null;
  if (from !== null || to !== null) {
    if (from !== null && to !== null) window = from <= to ? { from, to } : { from: to, to: from };
    else window = from !== null ? { from, to: from } : { from: to, to };
  }
  const shotId = typeof source.shotId === 'string' && source.shotId.trim().length > 0
    ? source.shotId.trim().slice(0, 64)
    : '';
  if (window === null && shotId.length === 0) return null;
  return {
    window,
    shotId,
    retrospective: source.retrospective === true,
    current: source.current === true,
  };
}

function eventInFocus(event, focus) {
  if (focus.window !== null) {
    const from = timeValue(event.from);
    const to = timeValue(event.to);
    if (from !== null && to !== null
      && to >= focus.window.from - FOCUS_TOLERANCE_MS
      && from <= focus.window.to + FOCUS_TOLERANCE_MS) return true;
  }
  return focus.shotId.length > 0 && event.shotId === focus.shotId;
}

/**
 * 按本轮窗口/镜头选事件。不按“最后 N 条”全局截断：
 *   - 给定镜头且窗口内确有该镜头事件：优先该镜头（旧镜头的“刚才”不会被当前镜头挤掉）；
 *   - 否则只看窗口：回溯（“刚才”）取更早的，当前/无 cue 取更接近现在的。
 */
function selectEventsForFocus(events, focus, limit) {
  if (limit <= 0) return [];
  if (focus === null) return events.slice(-limit);
  const matched = events.filter((event) => eventInFocus(event, focus));
  if (matched.length === 0) return [];
  const shotMatched = focus.shotId.length > 0
    ? matched.filter((event) => event.shotId === focus.shotId)
    : [];
  const pool = shotMatched.length > 0 ? shotMatched : matched;
  const ordered = pool.slice().sort((left, right) => {
    const leftFrom = timeValue(left.from) ?? 0;
    const rightFrom = timeValue(right.from) ?? 0;
    return leftFrom - rightFrom;
  });
  return focus.retrospective ? ordered.slice(0, limit) : ordered.slice(-limit);
}

function summaryInFocus(summary, focus) {
  if (focus.window !== null
    && typeof summary.from === 'number' && typeof summary.to === 'number'
    && summary.to >= focus.window.from - FOCUS_TOLERANCE_MS
    && summary.from <= focus.window.to + FOCUS_TOLERANCE_MS) return true;
  return focus.shotId.length > 0 && summary.shotId === focus.shotId;
}

/**
 * 创建运行时编排器。
 *
 * `analyze` / `framesBetween` / `audioBetween` 由调用方注入；缺失时 runNow 返回
 * `{ok:false, reason:'not-configured'}`，而不是在构造期抛错（隐私/故障路径上更安全）。
 *
 * @param {object} [options]
 * @param {(input: {system:string,user:string,frames:object[],audioLines:object[],interval:{from:number,to:number},signal:AbortSignal|undefined}) => Promise<string|object>|string|object} [options.analyze]
 *   真实分析器返回 `{ok:true,text,reason:'ok',images}` 或 `{ok:false,text:'',reason,images}`：
 *   失败直接按 `reason` 记失败，成功只把 `text` 交给解析器。为了兼容测试与自定义分析器，
 *   返回值不是该包装形状（裸字符串 / 裸对象）时仍原样作为 `raw` 解析。
 * @param {(from:number,to:number) => object[]} [options.framesBetween]
 * @param {(from:number,to:number) => object[]} [options.audioBetween]
 * @param {(event: object) => boolean} [options.isEvidenceAvailable]
 *   可选：渲染时检查事件引用的证据是否仍可回看；只用来加“证据已过期”提示，不改变状态。
 * @param {() => boolean} [options.isBlocked]
 * @param {() => number} [options.now]
 * @param {(fn: () => void, delay: number) => any} [options.setTimer]
 * @param {(handle: any) => void} [options.clearTimer]
 * @param {number} [options.minIntervalMs]
 * @param {number} [options.maxFrames]
 * @param {number} [options.maxChars]
 * @param {number} [options.maxEventsShown]
 * @param {number} [options.maxAgeMs]
 * @param {(payload: {parsed: object, state: object}) => void|Promise<void>} [options.onAdvance]
 *   成功并入状态后调用一次；`parsed`/`state` 是副本。回调抛错只 emit 一条
 *   `understanding-advance-callback-error`，不影响本次运行结果。
 * @param {(event: {type:string,ok:boolean,reason:string,eventCount:number,droppedEvents:number,at:number|null}) => void} [options.emit]
 */
export function createUnderstandingRuntime(options = {}) {
  const source = isObject(options) ? options : {};
  const analyze = typeof source.analyze === 'function' ? source.analyze : null;
  const framesBetween = typeof source.framesBetween === 'function' ? source.framesBetween : null;
  const audioBetween = typeof source.audioBetween === 'function' ? source.audioBetween : null;
  const isEvidenceAvailable = typeof source.isEvidenceAvailable === 'function'
    ? source.isEvidenceAvailable
    : null;
  const isBlocked = typeof source.isBlocked === 'function' ? source.isBlocked : () => false;
  const nowSource = typeof source.now === 'function' ? source.now : Date.now;
  const setTimer = typeof source.setTimer === 'function' ? source.setTimer : setTimeout;
  const clearTimer = typeof source.clearTimer === 'function' ? source.clearTimer : clearTimeout;
  const emit = typeof source.emit === 'function' ? source.emit : null;
  const onAdvance = typeof source.onAdvance === 'function' ? source.onAdvance : null;

  const minIntervalMs = toDuration(source.minIntervalMs, DEFAULT_MIN_INTERVAL_MS);
  const maxFrames = toLimit(source.maxFrames, UNDERSTANDING_RUNTIME_DEFAULTS.maxFrames);
  const maxChars = toLimit(source.maxChars, UNDERSTANDING_RUNTIME_DEFAULTS.maxChars);
  const maxEventsShown = toCount(source.maxEventsShown, UNDERSTANDING_RUNTIME_DEFAULTS.maxEventsShown);
  const maxAgeMs = toDuration(source.maxAgeMs, UNDERSTANDING_RUNTIME_DEFAULTS.maxAgeMs);

  // 连续失败退避：阈值、首档和上限都可注入，方便用假时钟测试；生产默认 3 次 / 60s / 10min。
  const failureThreshold = toLimit(source.failureThreshold, DEFAULT_FAILURE_THRESHOLD);
  const backoffBaseMs = toLimit(source.backoffBaseMs, DEFAULT_BACKOFF_BASE_MS);
  const backoffMaxMs = Math.max(
    backoffBaseMs,
    toLimit(source.backoffMaxMs, DEFAULT_BACKOFF_MAX_MS),
  );
  // 手动 runNow 可以绕过一次退避；测试需要锁死时传 false。
  const manualBackoffBypassEnabled = source.manualBackoffBypass !== false;

  /** 当前连续状态；只通过 current()/render() 暴露副本。 */
  let state = null;
  /** clear/stop 递增；在途结果必须与开始时同代次才能写回。 */
  let generation = 0;
  let stopped = false;
  /** 运行时自己的单在途锁（调度器与手动 runNow 共用）。 */
  let busy = false;
  let activeController = null;

  let runs = 0;
  let failures = 0;
  let droppedEvents = 0;
  let lastEventCount = 0;
  let lastReason = '';
  /** provider 的错误码（仅短机器码）；没有错误码时为空串。 */
  let lastErrorCode = '';
  /** status 的 `lastError`：优先 provider 错误码，其次原因码；永远是机器码。 */
  let lastError = '';
  /** 最近一次真实请求的机器元数据；不含正文/路径，供 empty/bad-json 对照。 */
  let lastMeta = null;
  let lastMetaAt = null;
  /** bad-json 的诊断：只记长度和哈希，不记原始文本/画面内容。 */
  let lastRawChars = 0;
  let lastRawHash = '';
  let lastAt = null;
  let lastWindowReason = '';
  let lastClearReason = '';
  /** 最近一次进入执行的分析请求的 focus 长度；只留长度，不留正文。 */
  let lastFocusChars = 0;

  /** 连续失败/退避状态；成功、clear、stop 后归零。 */
  let failureStreak = 0;
  let degraded = false;
  let retryAt = null;
  let backoffMs = 0;
  let manualBypassAvailable = false;

  const clock = () => {
    try {
      const value = Number(nowSource());
      if (Number.isFinite(value) && value >= 0) return value;
    } catch {
      /* 调用方时钟失败时退回真实时钟，不让编排崩溃 */
    }
    return Date.now();
  };

  /** 有界失败样本：只在失败分支写入，最多 3 条、10 分钟、每条正文 2KB。 */
  const failureSamples = createUnderstandingSamples({
    now: () => clock(),
    maxEntries: source.sampleMaxEntries,
    ttlMs: source.sampleTtlMs,
    maxBodyBytes: source.sampleMaxBodyBytes,
  });

  function resetBackoff() {
    failureStreak = 0;
    degraded = false;
    retryAt = null;
    backoffMs = 0;
    manualBypassAvailable = false;
    lastError = '';
  }

  function noteFailureForBackoff(at, reason) {
    failureStreak += 1;
    // lastError 只承载机器码：provider 错误码优先，其次原因码；两者都不合法时给稳定兜底。
    lastError = lastErrorCode || errorCodeText(reason) || 'error';
    if (failureStreak < failureThreshold) return;
    const wasDegraded = degraded;
    const exponent = Math.min(20, failureStreak - failureThreshold);
    const delay = Math.min(backoffMaxMs, backoffBaseMs * (2 ** exponent));
    degraded = true;
    backoffMs = delay;
    retryAt = at + delay;
    // 只在“刚进入退避”时发放一次手动绕过；手动请求再失败也不会无限续期绕过。
    if (!wasDegraded) manualBypassAvailable = manualBackoffBypassEnabled;
  }

  function emitEvent(payload) {
    if (emit === null) return;
    try {
      const result = emit(payload);
      // 异步订阅方失败同样不能变成未处理拒绝；这里只吞掉，不影响 orchestration。
      if (result !== null && typeof result === 'object' && typeof result.catch === 'function') {
        result.catch(() => {});
      }
    } catch {
      /* 订阅方失败不能影响状态推进 */
    }
  }

  function emitOutcome(outcome) {
    emitEvent({
      type: 'understanding-run',
      ok: outcome.ok === true,
      reason: outcome.reason,
      eventCount: outcome.eventCount ?? 0,
      droppedEvents: outcome.droppedEvents ?? 0,
      // 失败诊断只带机器字段：provider 错误码、bad-json 长度/哈希、请求 meta，绝无正文或路径。
      errorCode: lastErrorCode,
      lastError,
      meta: lastMeta,
      degraded,
      retryAt,
      failureStreak,
      rawChars: lastRawChars,
      rawHash: lastRawHash,
      at: lastAt,
    });
  }

  /** onAdvance 失败只留下一条诊断事件；不改计数、不改变本次运行结果。 */
  function emitAdvanceCallbackError() {
    emitEvent({
      type: 'understanding-advance-callback-error',
      ok: false,
      reason: 'callback-error',
      eventCount: 0,
      droppedEvents: 0,
      at: clock(),
    });
  }

  function recordSkip(reason) {
    const label = reasonText(reason) || 'skipped';
    lastReason = label;
    lastErrorCode = '';
    lastError = '';
    lastMeta = null;
    lastMetaAt = null;
    lastRawChars = 0;
    lastRawHash = '';
    lastAt = clock();
    emitOutcome({ ok: false, reason: label, eventCount: 0, droppedEvents: 0 });
    return { ok: false, reason: label };
  }

  /**
   * 连续失败退避期间真正挡住一次运行。它是“跳过”而不是新的失败：不增加 failures、不写样本、
   * 不改变 lastError/meta；事件只带机器码、计数和 retryAt。
   */
  function recordBackoffSkip() {
    lastReason = 'backoff';
    lastAt = clock();
    emitOutcome({ ok: false, reason: 'backoff', eventCount: 0, droppedEvents: 0 });
    return {
      ok: false,
      reason: 'backoff',
      retryAt,
      lastError,
      degraded: true,
    };
  }

  function recordFailure(reason, dropped = 0, diagnostics = {}) {
    const label = reasonText(reason) || 'error';
    const droppedCount = Number.isFinite(dropped) && dropped > 0 ? Math.floor(dropped) : 0;
    // 诊断对象来自可注入的 analyze：逐项兜底，任何 getter/代理异常都不能让 runNow 拒绝。
    let raw = { rawChars: 0, rawHash: '' };
    let meta = null;
    let sampleText = '';
    let errorCode = '';
    try {
      raw = rawDiagnostics(diagnostics);
      errorCode = errorCodeText(diagnostics?.errorCode);
      sampleText = typeof diagnostics?.text === 'string' ? diagnostics.text : '';
      meta = safeDiagnosticMeta(diagnostics?.meta);
    } catch {
      /* 诊断读取失败时保留空诊断，真实失败 reason 仍然记账 */
    }
    failures += 1;
    lastEventCount = 0;
    droppedEvents += droppedCount;
    lastReason = label;
    lastErrorCode = errorCode;
    lastError = '';
    lastRawChars = raw.rawChars;
    lastRawHash = raw.rawHash;
    lastMeta = meta;
    lastAt = clock();
    lastMetaAt = lastAt;
    noteFailureForBackoff(lastAt, label);
    try {
      failureSamples.record({
        reason: label,
        errorCode: lastErrorCode,
        meta,
        text: sampleText,
        at: lastAt,
      });
    } catch {
      /* 样本是诊断旁路：写入失败不能改变失败结果的记账 */
    }
    emitOutcome({ ok: false, reason: label, eventCount: 0, droppedEvents: droppedCount });
    return {
      ok: false,
      reason: label,
      droppedEvents: droppedCount,
      errorCode: lastErrorCode,
      rawChars: lastRawChars,
      rawHash: lastRawHash,
    };
  }

  function staleOutcome() {
    return { ok: false, reason: stopped ? 'stopped' : 'stale', droppedEvents: 0 };
  }

  function isStale(runGeneration) {
    return stopped || runGeneration !== generation;
  }

  /**
   * 读取状态并按 maxAgeMs 做过期清空。过期只清状态，不递增代次：正在执行的（新）分析
   * 仍然可以写回结果；只有 clear/stop 才让旧在途失效。
   */
  function liveState() {
    if (state === null) return null;
    const updatedAt = timeValue(state.updatedAt);
    if (updatedAt !== null && clock() - updatedAt > maxAgeMs) {
      state = null;
      return null;
    }
    return state;
  }

  /** 用本次实际选中的帧 id 回查原始帧，保留 file/source 等适配器需要的字段。 */
  function framesForAnalyzer(selected, rawFrames) {
    const byId = new Map();
    for (const frame of rawFrames) {
      if (!isObject(frame)) continue;
      const id = typeof frame.id === 'string' ? frame.id.trim() : '';
      if (id.length === 0 || byId.has(id)) continue;
      byId.set(id, frame);
    }
    return selected.map((frame) => {
      const raw = byId.get(frame.id);
      if (raw === undefined) return { id: frame.id, capturedAt: frame.capturedAt };
      return { ...raw, id: frame.id, capturedAt: frame.capturedAt };
    });
  }

  async function performRun({ window, reason, focus, runGeneration, signal }) {
    if (isStale(runGeneration) || signal?.aborted) return staleOutcome();

    // 过期状态不参与 previousScene；过期清空不改变代次，故先于取证据执行。
    const previousScene = liveState()?.sceneSummary ?? '';

    let rawFrames;
    try {
      rawFrames = await framesBetween(window.from, window.to);
    } catch {
      return recordFailure('frames-error');
    }
    const frameList = Array.isArray(rawFrames) ? rawFrames : [];
    if (frameList.length === 0) return recordSkip('no-frames');

    let rawAudio;
    try {
      rawAudio = await audioBetween(window.from, window.to);
    } catch {
      // 台词是辅助证据；取不到时退化为纯画面理解，不放弃整次分析。
      rawAudio = [];
    }

    let built;
    try {
      built = buildUnderstandingInput({
        interval: window,
        frames: frameList,
        audioLines: Array.isArray(rawAudio) ? rawAudio : [],
        previousScene,
        focus,
        maxFrames,
        maxAudioLines: UNDERSTANDING_DEFAULTS.maxAudioLines,
      });
    } catch {
      return recordFailure('build-error');
    }

    if (!built.ok) {
      if (built.reason === 'no-frames') return recordSkip('no-frames');
      return recordFailure(built.reason || 'build-error');
    }

    let prompt;
    try {
      prompt = buildUnderstandingPrompt(built);
    } catch {
      return recordFailure('prompt-error');
    }
    if (!prompt.ok) return recordFailure(prompt.reason || 'prompt-error');

    if (isStale(runGeneration) || signal?.aborted) return staleOutcome();

    runs += 1;
    let rawOutput;
    try {
      rawOutput = await analyze({
        system: prompt.system,
        user: prompt.user,
        frames: framesForAnalyzer(built.frames, frameList),
        audioLines: built.audioLines,
        interval: built.interval,
        signal,
      });
    } catch {
      // 被 clear/stop 中止属于预期路径，不计失败；其它异常只保留标签，不暴露错误正文。
      if (isStale(runGeneration) || signal?.aborted) return staleOutcome();
      return recordFailure('analyze-error');
    }

    if (isStale(runGeneration) || signal?.aborted) return staleOutcome();

    // image-analyzer.analyze 的契约形状：成功 `{ok:true,text,reason:'ok',images}`，
    // 失败 `{ok:false,text:'',reason,images}`。失败必须先按真实 reason 记账：把整个包装
    // 对象交给解析器只会得到 no-scene，把 no-image-support / read-failed / timeout 吞掉。
    // 裸字符串 / 裸对象不是该包装形状（测试与自定义 analyze），保持原样作为 raw。
    const analyzerMeta = isObject(rawOutput)
      ? safeDiagnosticMeta(rawOutput.meta)
      : null;
    if (isObject(rawOutput) && rawOutput.ok === false) {
      const failureReason = typeof rawOutput.reason === 'string'
        && rawOutput.reason.trim().length > 0
        ? rawOutput.reason
        : 'analyze-failed';
      // 只透传 provider 的短错误码和请求 meta；错误正文/路径永远不进入事件或 status。
      // `diagnosticText` 只给有界样本，样本不会进入 render/status/事件正文。
      return recordFailure(failureReason, 0, {
        errorCode: rawOutput.errorCode,
        meta: analyzerMeta,
        text: diagnosticTextOf(rawOutput),
      });
    }
    const rawEvidence = isObject(rawOutput) && typeof rawOutput.text === 'string'
      ? rawOutput.text
      : rawOutput;

    let parsed;
    try {
      parsed = parseUnderstanding({
        raw: rawEvidence,
        interval: built.interval,
        frameIds: built.frameIds,
        audioIds: built.audioLines.map((line) => line.id),
        // 原始证据带真实可见范围/镜头；解析器据此校验“事件时间靠近所引用证据”，
        // 但文件名/路径永远不会写进事件。
        frames: frameList,
        audioLines: Array.isArray(rawAudio) ? rawAudio : [],
      });
    } catch {
      return recordFailure('parse-error');
    }

    if (!parsed.ok) {
      lastEventCount = 0;
      // bad-json 带 rawChars/rawHash（parseUnderstanding 生成）；请求 meta 与原始输出只交给
      // 有界样本。empty/bad-json 因此能对照真实 finish/chunk 元数据，而不会被误判为“不支持图片”。
      return recordFailure(parsed.reason || 'parse-error', parsed.droppedEvents || 0, {
        rawChars: parsed.rawChars,
        rawHash: parsed.rawHash,
        meta: analyzerMeta,
        text: typeof rawEvidence === 'string' ? rawEvidence : '',
      });
    }

    // 解析后、写回前再查一次代次：clear/stop 可能发生在 await 与解析之间。
    if (isStale(runGeneration) || signal?.aborted) return staleOutcome();

    let nextState;
    try {
      nextState = advanceUnderstanding(
        state,
        {
          ...parsed,
          interval: built.interval,
          // 本次主要镜头：供旧镜头摘要/事件按镜头检索，不进入提示词正文。
          shotId: built.shotId ?? null,
          // 把真实帧间缺口带进状态，render 才能给出“未覆盖”提示。
          gaps: built.gaps,
        },
        { now: clock },
      );
    } catch {
      return recordFailure('advance-error');
    }

    state = nextState;
    lastEventCount = parsed.events.length;
    droppedEvents += parsed.droppedEvents;
    lastReason = 'ok';
    lastErrorCode = '';
    lastRawChars = 0;
    lastRawHash = '';
    lastMeta = analyzerMeta;
    lastMetaAt = clock();
    lastWindowReason = reason;
    lastAt = clock();
    // 成功重置连续失败/退避：下一轮重新按正常 20s 限速，不继承旧 retryAt。
    resetBackoff();
    emitOutcome({
      ok: true,
      reason: 'ok',
      eventCount: lastEventCount,
      droppedEvents: parsed.droppedEvents,
    });

    // 到这里状态已经写回且本次运行仍属当前代次（同步执行，没有 await 可插入 clear/stop）。
    // 回调只看副本，失败也只 emit 诊断，绝不影响 runNow 的成功结果。
    if (onAdvance !== null) {
      try {
        const callbackResult = onAdvance({
          parsed: cloneParsed(parsed),
          state: cloneState(nextState),
        });
        if (
          callbackResult !== null
          && typeof callbackResult === 'object'
          && typeof callbackResult.catch === 'function'
        ) {
          callbackResult.catch(() => emitAdvanceCallbackError());
        }
      } catch {
        emitAdvanceCallbackError();
      }
    }

    return { ok: true, parsed };
  }

  /**
   * 立即分析一个窗口（测试/手动入口）。仍受单在途与 isBlocked 约束；返回的 Promise 永远
   * resolve，不会 reject。
   *
   * 可选 `focus` 是一次定向分析的具体问题：非字符串忽略，换行压平，截到 200 字符，只随
   * 本次请求进入提示词的【本次关注点】；不会写进连续状态，`status()` 只记录其长度。
   */
  function runNow(request = {}) {
    // 手动入口：退避期内允许绕过一次；绕过是显式消费，不会无限续期。
    return runInternal(request, true);
  }

  /** 调度器入口：退避期内不绕过；到 retryAt 后才允许探测。 */
  function runInternal(request = {}, manual = false) {
    if (stopped) return Promise.resolve({ ok: false, reason: 'stopped' });

    let blocked;
    try {
      blocked = Boolean(isBlocked());
    } catch {
      // 隐私检查本身出错时按“被挡住”处理，宁可少分析也不越权。
      blocked = true;
    }
    if (blocked) {
      recordSkip('blocked');
      return Promise.resolve({ ok: false, reason: 'blocked' });
    }

    if (busy) return Promise.resolve({ ok: false, reason: 'in-flight' });

    if (analyze === null || framesBetween === null || audioBetween === null) {
      recordSkip('not-configured');
      return Promise.resolve({ ok: false, reason: 'not-configured' });
    }

    // 连续失败退避：保留采集与状态，只是不再到点就发请求。到 retryAt 后放行一次探测；
    // 手动 runNow 额外拥有一次绕过机会，成功即重置，失败则继续指数退避。
    if (degraded && (retryAt === null || clock() < retryAt)) {
      if (!(manual && manualBypassAvailable)) return Promise.resolve(recordBackoffSkip());
      manualBypassAvailable = false;
    }

    const at = clock();
    const window = windowOf(request, at);
    const reason = reasonText(isObject(request) ? request.reason : '');
    const focus = focusText(isObject(request) ? request.focus : '');
    const runGeneration = generation;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    activeController = controller;
    busy = true;
    lastFocusChars = focus.length;

    const work = (async () => {
      try {
        return await performRun({
          window,
          reason,
          focus,
          runGeneration,
          signal: controller === null ? undefined : controller.signal,
        });
      } catch {
        // performRun 已逐段兜底；这里再兜最后一层，保证任何异常都不外抛。
        if (isStale(runGeneration) || controller?.signal?.aborted) return staleOutcome();
        return recordFailure('internal-error');
      } finally {
        if (activeController === controller) activeController = null;
        busy = false;
      }
    })();

    return work;
  }

  function makeScheduler() {
    return createUnderstandingScheduler({
      now: nowSource,
      setTimer,
      clearTimer,
      run: (window) => runInternal(window, false),
      minIntervalMs,
    });
  }

  let scheduler = makeScheduler();

  /** 有变化 → 交给内部调度器排队（priority 透传，仍受 minInterval 约束）。 */
  function noteChange(request = {}) {
    if (stopped) return status();
    // 退避期间照常保留采集，但不再排队；到 retryAt 后的第一份新材料才重新尝试。
    if (degraded && (retryAt === null || clock() < retryAt)) {
      const scheduled = scheduler.status();
      return {
        ...scheduled,
        accepted: false,
        reason: 'backoff',
        degraded: true,
        retryAt,
        lastError,
      };
    }
    const source = isObject(request) ? request : {};
    return scheduler.note({
      from: source.from,
      to: source.to,
      reason: source.reason,
      priority: source.priority === true,
    });
  }

  /** 当前状态副本；过期/无状态返回 null。事件里的证据 id 数组保留，其余内部字段不暴露。 */
  function current() {
    const live = liveState();
    if (live === null) return null;
    const view = {
      sceneSummary: live.sceneSummary,
      events: live.events.map(cloneEvent),
      unresolved: live.unresolved,
      coverage: live.coverage.map(cloneSpan),
      updatedAt: timeValue(live.updatedAt),
    };
    if (Array.isArray(live.summaries) && live.summaries.length > 0) {
      view.summaries = live.summaries.map(cloneSummary);
    }
    return view;
  }

  /** 事件证据是否仍可回看：只影响“证据已过期”提示，不修改状态、不输出 id。 */
  function evidenceStillAvailable(event) {
    if (isEvidenceAvailable === null) return event.evidenceAvailable !== false;
    try {
      return isEvidenceAvailable(event) !== false;
    } catch {
      return event.evidenceAvailable !== false;
    }
  }

  /**
   * 被动注入块。只展示：场景摘要、本轮相关事件（时间 + 描述 + uncertainty）、
   * unresolved、覆盖缺口提示。不输出文件路径、帧 id、证据数组或调度器信息。
   *
   * 可传入 `focus`（`{from,to,shotId,retrospective,current}`）：按本轮窗口/镜头选摘要与
   * 事件；旧镜头事件只要命中窗口/镜头就仍然可选，而不是被“最新 3 条”挤掉。
   */
  function render(focus = null) {
    const live = liveState();
    if (!stateHasContent(live)) return '';

    const sceneBudget = Math.min(MAX_SCENE_CHARS, Math.max(8, Math.floor(maxChars * 0.4)));
    const eventBudget = Math.min(MAX_EVENT_CHARS, Math.max(8, Math.floor(maxChars * 0.25)));
    const unresolvedBudget = Math.min(MAX_UNRESOLVED_CHARS, Math.max(8, Math.floor(maxChars * 0.25)));
    const lines = [];
    const selection = normalizeFocus(focus);

    let scene = flattenText(live.sceneSummary);
    let sceneLabel = '场景';
    if (selection !== null && Array.isArray(live.summaries) && live.summaries.length > 0) {
      // 镜头命中优先于“窗口里也有”：切镜后的 16 秒窗口仍应显示上一镜头摘要。
      const shotMatched = selection.shotId.length > 0
        ? live.summaries.filter((summary) => summary.shotId === selection.shotId)
        : [];
      const windowMatched = live.summaries.filter((summary) => summaryInFocus(summary, selection));
      const matching = shotMatched.length > 0 ? shotMatched : windowMatched;
      const chosen = matching.length > 0
        ? matching[matching.length - 1]
        : live.summaries[live.summaries.length - 1];
      if (chosen !== undefined) {
        scene = flattenText(chosen.text);
        sceneLabel = matching.length > 0 ? '场景（本轮窗口）' : '最近场景（可能不在本轮窗口）';
      }
    }
    if (scene.length > 0) lines.push(`【${sceneLabel}】${clipText(scene, sceneBudget)}`);

    const events = selectEventsForFocus(live.events, selection, maxEventsShown);
    for (const event of events) {
      const description = flattenText(event.description);
      if (description.length === 0) continue;
      const uncertainty = clipText(uncertaintyText(event.uncertainty), MAX_UNCERTAINTY_CHARS);
      const suffix = uncertainty.length > 0 ? `（不确定：${uncertainty}）` : '';
      const availability = evidenceStillAvailable(event) ? '' : '（证据已过期，不可回看）';
      lines.push(
        `- ${clockText(event.from)}–${clockText(event.to)} ${clipText(description, eventBudget)}${suffix}${availability}`,
      );
    }

    const unresolved = flattenText(live.unresolved);
    if (unresolved.length > 0) lines.push(`【未解决】${clipText(unresolved, unresolvedBudget)}`);

    const coverage = live.coverage;
    if (coverage.length === 0) {
      lines.push('【覆盖】暂无有效覆盖记录');
    } else {
      const gaps = [];
      for (let i = 1; i < coverage.length; i += 1) {
        if (coverage[i].from > coverage[i - 1].to) {
          gaps.push({ from: coverage[i - 1].to, to: coverage[i].from });
        }
      }
      if (gaps.length > 0) {
        const shown = gaps
          .slice(0, 2)
          .map((gap) => `${clockText(gap.from)}–${clockText(gap.to)}`)
          .join('，');
        const more = gaps.length > 2 ? `（另 ${gaps.length - 2} 段）` : '';
        lines.push(`【覆盖缺口】${shown}${more}`);
      } else {
        lines.push(`【覆盖】${clockText(coverage[0].from)}–${clockText(coverage[coverage.length - 1].to)}（无缺口）`);
      }
    }

    return clipText(lines.join('\n'), maxChars);
  }

  /** 隐私/切源：清状态、让旧在途失效并清空调度器队列；不结束运行（之后还能继续用）。 */
  function clear(reason = '') {
    generation += 1;
    state = null;
    lastEventCount = 0;
    lastClearReason = reasonText(reason);
    lastWindowReason = '';
    lastReason = 'cleared';
    lastErrorCode = '';
    lastError = '';
    lastMeta = null;
    lastMetaAt = null;
    lastRawChars = 0;
    lastRawHash = '';
    lastAt = clock();
    // 隐私/切源是本地诊断样本的明确清空点；同时结束旧退避，重新开始计数。
    failureSamples.clear();
    resetBackoff();
    if (activeController !== null) {
      try {
        activeController.abort();
      } catch {
        /* 已结束或平台不支持 abort */
      }
    }
    scheduler.stop();
    if (!stopped) scheduler = makeScheduler();
    return status();
  }

  /** 停止：清定时器/队列，拒绝后续触发；在途结果因代次检查不会写回。 */
  function stop() {
    if (stopped) return;
    stopped = true;
    generation += 1;
    lastReason = 'stopped';
    lastErrorCode = '';
    lastError = '';
    lastMeta = null;
    lastMetaAt = null;
    lastRawChars = 0;
    lastRawHash = '';
    lastAt = clock();
    // 关闭/卸载时清空样本与退避；不把任何正文留在内存里。
    failureSamples.clear();
    resetBackoff();
    if (activeController !== null) {
      try {
        activeController.abort();
      } catch {
        /* 已结束或平台不支持 abort */
      }
    }
    scheduler.stop();
  }

  /** 只读诊断：调度器状态 + 运行时分析计数；不含素材正文（focus 只给长度）。 */
  function status() {
    const scheduled = scheduler.status();
    const reason = lastReason || scheduled.lastReason;
    return {
      ...scheduled,
      running: scheduled.running === true || busy,
      lastReason: reason,
      // 机器原因码与 lastReason 同源；lastErrorCode 只承载 provider 错误码（没有则空）。
      lastReasonCode: reason,
      lastErrorCode,
      // lastError 是 status 的稳定机器标签：优先 provider 错误码，其次原因码。
      lastError,
      // 真实请求 meta（provider/model/计数/finish/耗时），不含正文或路径。
      lastMeta,
      lastMetaAt,
      // 连续失败退避：degraded/retryAt/lastError 是给设置页和日志的稳定诊断字段。
      degraded,
      retryAt: degraded ? retryAt : null,
      failureStreak,
      backoffMs: degraded ? backoffMs : 0,
      // 样本正文不进入 status；这里只给条数，完整样本走显式的 samples() 诊断入口。
      sampleCount: failureSamples.count(),
      // bad-json 诊断：只给长度和哈希，原文本/画面永不进入 status。
      rawChars: lastRawChars,
      rawHash: lastRawHash,
      lastWindowReason: lastWindowReason || scheduled.lastReason,
      lastAt: lastAt ?? scheduled.lastAt,
      runs,
      failures,
      droppedEvents,
      lastEventCount,
      lastFocusChars,
      lastClearReason,
      stopped,
      hasState: state !== null,
      updatedAt: state !== null ? timeValue(state.updatedAt) : null,
    };
  }

  return {
    noteChange,
    runNow,
    current,
    render,
    clear,
    status,
    stop,
    /** 本地诊断入口：返回失败样本 head+tail；绝不进入 render/事件/status 正文。 */
    samples() {
      return failureSamples.list();
    },
    /** 样本边界（条数/上限/TTL），不含正文。 */
    sampleStatus() {
      return failureSamples.status();
    },
    get scheduler() {
      return scheduler;
    },
  };
}
