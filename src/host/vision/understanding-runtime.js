/**
 * P-187 阶段 3 —— 连续视听理解运行时编排（可测试纯模块）。
 *
 * 这一层只做“串起来”的工作，不接宿主、不读文件、不直接调用模型、不创建真实设备：
 *
 *   取证据（注入的 framesBetween / audioBetween）
 *     → buildUnderstandingInput（预算与取样）
 *     → buildUnderstandingPrompt（system/user）
 *     → analyze（注入的 async 调用，失败/坏输出都不外抛）
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
 *      `{ok:false, reason}`。status() 与 emit() 只带计数/原因/时间，不带素材正文。
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
/** 原因只作为状态标签：单行、限长，避免长文本/控制字符进入 status。 */
const MAX_REASON_CHARS = 80;
/** 定向分析的关注点上限；只作为提示词上下文，不进入状态/status 正文。 */
const MAX_FOCUS_CHARS = 200;
/** 单个描述/场景的渲染预算上限（仍受总 maxChars 兜底）。 */
const MAX_SCENE_CHARS = 320;
const MAX_EVENT_CHARS = 180;
const MAX_UNRESOLVED_CHARS = 240;
const MAX_UNCERTAINTY_CHARS = 60;

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
  // reaction 是可选字段；保留它，但绝不把空串补成字段。
  if (typeof event.reaction === 'string' && event.reaction.length > 0) copy.reaction = event.reaction;
  return copy;
}

function cloneSpan(span) {
  return { from: span.from, to: span.to };
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
 * 创建运行时编排器。
 *
 * `analyze` / `framesBetween` / `audioBetween` 由调用方注入；缺失时 runNow 返回
 * `{ok:false, reason:'not-configured'}`，而不是在构造期抛错（隐私/故障路径上更安全）。
 *
 * @param {object} [options]
 * @param {(input: {system:string,user:string,frames:object[],audioLines:object[],interval:{from:number,to:number},signal:AbortSignal|undefined}) => Promise<string>|string} [options.analyze]
 * @param {(from:number,to:number) => object[]} [options.framesBetween]
 * @param {(from:number,to:number) => object[]} [options.audioBetween]
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
  let lastAt = null;
  let lastWindowReason = '';
  let lastClearReason = '';
  /** 最近一次进入执行的分析请求的 focus 长度；只留长度，不留正文。 */
  let lastFocusChars = 0;

  const clock = () => {
    try {
      const value = Number(nowSource());
      if (Number.isFinite(value) && value >= 0) return value;
    } catch {
      /* 调用方时钟失败时退回真实时钟，不让编排崩溃 */
    }
    return Date.now();
  };

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
    lastAt = clock();
    emitOutcome({ ok: false, reason: label, eventCount: 0, droppedEvents: 0 });
    return { ok: false, reason: label };
  }

  function recordFailure(reason, dropped = 0) {
    const label = reasonText(reason) || 'error';
    const droppedCount = Number.isFinite(dropped) && dropped > 0 ? Math.floor(dropped) : 0;
    failures += 1;
    lastEventCount = 0;
    droppedEvents += droppedCount;
    lastReason = label;
    lastAt = clock();
    emitOutcome({ ok: false, reason: label, eventCount: 0, droppedEvents: droppedCount });
    return { ok: false, reason: label, droppedEvents: droppedCount };
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

    let parsed;
    try {
      parsed = parseUnderstanding({
        raw: rawOutput,
        interval: built.interval,
        frameIds: built.frameIds,
        audioIds: built.audioLines.map((line) => line.id),
      });
    } catch {
      return recordFailure('parse-error');
    }

    if (!parsed.ok) {
      lastEventCount = 0;
      return recordFailure(parsed.reason || 'parse-error', parsed.droppedEvents || 0);
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
    lastWindowReason = reason;
    lastAt = clock();
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
      run: (window) => runNow(window),
      minIntervalMs,
    });
  }

  let scheduler = makeScheduler();

  /** 有变化 → 交给内部调度器排队（priority 透传，仍受 minInterval 约束）。 */
  function noteChange(request = {}) {
    if (stopped) return status();
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
    return {
      sceneSummary: live.sceneSummary,
      events: live.events.map(cloneEvent),
      unresolved: live.unresolved,
      coverage: live.coverage.map(cloneSpan),
      updatedAt: timeValue(live.updatedAt),
    };
  }

  /**
   * 被动注入块。只展示：场景摘要、最近 maxEventsShown 条事件（时间 + 描述 + uncertainty）、
   * unresolved、覆盖缺口提示。不输出文件路径、帧 id、证据数组或调度器信息。
   */
  function render() {
    const live = liveState();
    if (!stateHasContent(live)) return '';

    const sceneBudget = Math.min(MAX_SCENE_CHARS, Math.max(8, Math.floor(maxChars * 0.4)));
    const eventBudget = Math.min(MAX_EVENT_CHARS, Math.max(8, Math.floor(maxChars * 0.25)));
    const unresolvedBudget = Math.min(MAX_UNRESOLVED_CHARS, Math.max(8, Math.floor(maxChars * 0.25)));
    const lines = [];

    const scene = flattenText(live.sceneSummary);
    if (scene.length > 0) lines.push(`【场景】${clipText(scene, sceneBudget)}`);

    const events = maxEventsShown > 0 ? live.events.slice(-maxEventsShown) : [];
    for (const event of events) {
      const description = flattenText(event.description);
      if (description.length === 0) continue;
      const uncertainty = clipText(uncertaintyText(event.uncertainty), MAX_UNCERTAINTY_CHARS);
      const suffix = uncertainty.length > 0 ? `（不确定：${uncertainty}）` : '';
      lines.push(
        `- ${clockText(event.from)}–${clockText(event.to)} ${clipText(description, eventBudget)}${suffix}`,
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
    lastAt = clock();
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
    lastAt = clock();
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
    return {
      ...scheduled,
      running: scheduled.running === true || busy,
      lastReason: lastReason || scheduled.lastReason,
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
    get scheduler() {
      return scheduler;
    },
  };
}
