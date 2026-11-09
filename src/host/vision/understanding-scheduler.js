/**
 * P-187 阶段 3 —— 后台连续视听理解的节奏调度（纯模块）。
 *
 * 这里不采集、不调用模型，只负责回答一个问题：什么时候可以把下一条“分析一次”交给调用方
 * 注入的 `run()`。四条硬规则：
 *
 *   1. 单在途：`run()` 未结算前绝不并发启动第二个；期间的 `note` 只能与在途窗口合并（被完全
 *      覆盖时）或进入有界队列；
 *   2. 节奏下限：两次 run 的**开始时间**至少相隔 `minIntervalMs`，`priority` 也不能突破；
 *      它只让队列里的优先窗口占用下一个可用执行槽，从而比排在前面的普通窗口更早被分析；
 *   3. 有界队列：`maxPending` 是硬上限；优先窗口在 `priorityHoldMs` 内受保护，超限时优先丢
 *      最旧的非优先窗口，只有全是受保护窗口时才丢最旧的优先窗口；
 *   4. 可停止：`stop()` 清定时器、清队列并拒绝后续触发；在途 `run()` 不被打断，但其结果不再
 *      触发新的分析。
 *
 * 所有时间来源（now/setTimer/clearTimer）都由调用方注入；模块内部不使用真实等待，测试可用假
 * 时钟手动推进。status() 只暴露计数、时间与原因，不含任何素材正文或文件路径。
 */

/** 第一版调度参数；运行时可覆盖 minIntervalMs / maxPending。 */
export const SCHEDULER_DEFAULTS = Object.freeze({
  /** 两次 run 开始时间的最小间隔。 */
  minIntervalMs: 3000,
  /** 等待执行的窗口上限（含在途窗口之后的排队项）。 */
  maxPending: 8,
  /** 优先窗口在队列里受保护的时长；超过后按普通窗口参与淘汰。 */
  priorityHoldMs: 15000,
});

/** 原因只作为状态标签：单行、限长，避免调用方意外把长文本/控制字符带进 status。 */
const MAX_REASON_CHARS = 80;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function toDelay(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return fallback;
  return Math.floor(number);
}

function toLimit(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.max(1, Math.floor(number));
}

function reasonText(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .trim()
    .slice(0, MAX_REASON_CHARS);
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

/** `{from,to}` 统一成有限、非负、from<=to；缺省/非法一律落成无窗口的 `{0,0}`。 */
function windowOf(from, to) {
  const start = timeValue(from);
  const end = timeValue(to);
  if (start === null && end === null) return { from: 0, to: 0 };
  if (start === null) return { from: end, to: end };
  if (end === null) return { from: start, to: start };
  return start <= end ? { from: start, to: end } : { from: end, to: start };
}

function isGenericWindow(window) {
  return window.from === 0 && window.to === 0;
}

/** 两个窗口重叠或接触即视为同一段变化；无窗口的 note 愿意并入任何窗口。 */
function windowsOverlap(a, b) {
  if (isGenericWindow(a) || isGenericWindow(b)) return true;
  return a.from <= b.to && b.from <= a.to;
}

function unionWindow(a, b) {
  if (isGenericWindow(a)) return { from: b.from, to: b.to };
  if (isGenericWindow(b)) return { from: a.from, to: a.to };
  return { from: Math.min(a.from, b.from), to: Math.max(a.to, b.to) };
}

/** 在途窗口是否已经完全覆盖这次 note；无窗口的 note 视为被在途快照覆盖。 */
function coveredBy(active, note) {
  if (isGenericWindow(note)) return true;
  if (isGenericWindow(active)) return false;
  return note.from >= active.from && note.to <= active.to;
}

/**
 * @param {object} options
 * @param {() => number} [options.now]
 * @param {(fn: () => void, delay: number) => any} [options.setTimer]
 * @param {(handle: any) => void} [options.clearTimer]
 * @param {(window: {from:number,to:number,reason:string,priority:boolean}) => Promise<any>|any} options.run
 * @param {number} [options.minIntervalMs]
 * @param {number} [options.maxPending]
 */
export function createUnderstandingScheduler({
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  run,
  minIntervalMs = SCHEDULER_DEFAULTS.minIntervalMs,
  maxPending = SCHEDULER_DEFAULTS.maxPending,
} = {}) {
  if (typeof run !== 'function') {
    throw new TypeError('createUnderstandingScheduler: run 必须是函数');
  }

  const interval = toDelay(minIntervalMs, SCHEDULER_DEFAULTS.minIntervalMs);
  const pendingLimit = toLimit(maxPending, SCHEDULER_DEFAULTS.maxPending);
  const priorityHold = SCHEDULER_DEFAULTS.priorityHoldMs;

  const clock = () => {
    try {
      const value = Number(now());
      return Number.isFinite(value) && value >= 0 ? value : Date.now();
    } catch {
      return Date.now();
    }
  };

  /** 待分析窗口；按到达顺序保存，择取时优先窗口会插队。 */
  const queue = [];
  /** 在途窗口；只用于判断新 note 是否已经被这次分析完全覆盖。 */
  let activeWindow = null;
  let inFlight = null;
  let stopped = false;
  /** 定时器句柄与身份令牌分开：setTimer 同步回调时也不会在 TDZ 里引用 handle。 */
  let timer = null;
  let timerToken = null;
  /** 当前定时器对应的到期时刻；仅用于避免 note 反复重置更早的倒计时。 */
  let timerDueAt = null;

  let lastAt = null;
  let lastReason = '';
  let runs = 0;
  let failures = 0;
  let dropped = 0;
  let merged = 0;

  function status() {
    return {
      running: inFlight !== null,
      pending: queue.length,
      lastAt,
      lastReason,
      runs,
      failures,
      dropped,
      merged,
    };
  }

  function isProtected(entry, at) {
    if (entry.priority !== true) return false;
    return at - entry.priorityAt <= priorityHold;
  }

  function clearScheduled() {
    if (timerToken === null) return;
    timerToken = null;
    const handle = timer;
    timer = null;
    try {
      clearTimer(handle);
    } catch {
      /* 已经触发或已被调用方清掉 */
    }
  }

  function scheduleNext() {
    if (stopped || inFlight !== null || queue.length === 0) return;
    const at = clock();
    const due = lastAt === null ? at : lastAt + interval;
    const delay = Math.max(0, due - at);
    const dueAt = at + delay;
    // 已有更早（或同样早）的定时器就沿用，避免每次 note 都重置倒计时。
    if (timerToken !== null) {
      if (timerDueAt !== null && timerDueAt <= dueAt) return;
      clearScheduled();
    }

    const token = {};
    timerToken = token;
    timerDueAt = dueAt;
    let handle;
    try {
      handle = setTimer(() => {
        if (timerToken !== token) return;
        timerToken = null;
        timerDueAt = null;
        timer = null;
        if (stopped) return;
        void flush();
      }, delay);
    } catch {
      if (timerToken === token) {
        timerToken = null;
        timerDueAt = null;
        timer = null;
      }
      return;
    }
    // 定时器可能被同步触发（测试替身）；那时 token 已失效，不再保存句柄。
    if (timerToken === token) {
      timer = handle;
      handle?.unref?.();
    }
  }

  function absorb(target, incoming) {
    const wasProtected = isProtected(target, clock());
    const mergedWindow = unionWindow(target, incoming);
    target.from = mergedWindow.from;
    target.to = mergedWindow.to;
    if (incoming.priority === true && !wasProtected) target.priorityAt = incoming.priorityAt;
    target.priority = target.priority === true || incoming.priority === true;
    if (incoming.reason.length > 0) target.reason = incoming.reason;
  }

  /**
   * 合并到队列里的重叠窗口；返回是否发生了合并。一次 note 可能把多段首尾相连的窗口串起来，
   * 每吸收一段就记一次 merged，status 能看出合并工作量。
   */
  function mergeIntoQueue(item) {
    let index = queue.findIndex((entry) => windowsOverlap(entry, item));
    if (index === -1) return false;
    absorb(queue[index], item);
    merged += 1;
    // 并集可能又接上后面的窗口，继续收敛到不再重叠。
    let next = queue.findIndex((entry, at) => at !== index && windowsOverlap(entry, queue[index]));
    while (next !== -1) {
      absorb(queue[index], queue[next]);
      queue.splice(next, 1);
      merged += 1;
      if (next < index) index -= 1;
      next = queue.findIndex((entry, at) => at !== index && windowsOverlap(entry, queue[index]));
    }
    return true;
  }

  /** 超限时优先丢最旧的非优先窗口；全是受保护窗口时才丢最旧的优先窗口。 */
  function enforceLimit(at) {
    while (queue.length > pendingLimit) {
      let index = queue.findIndex((entry) => !isProtected(entry, at));
      if (index === -1) index = 0;
      queue.splice(index, 1);
      dropped += 1;
    }
  }

  /**
   * 登记一次“有变化”。窗口重叠的 note 会并进已有排队项；在途窗口已完全覆盖时直接合并，
   * 不再排队。返回登记后的 status 快照，调用方无需自己推算 pending。
   */
  function note(options = {}) {
    if (stopped) return status();
    const request = isObject(options) ? options : {};
    const window = windowOf(request.from, request.to);
    const at = clock();
    const item = {
      from: window.from,
      to: window.to,
      reason: reasonText(request.reason),
      priority: request.priority === true,
      priorityAt: at,
      at,
    };

    // 在途分析已经完整覆盖：这次变化不需要再排一次。
    if (activeWindow !== null && coveredBy(activeWindow, item)) {
      merged += 1;
      return status();
    }

    if (mergeIntoQueue(item)) {
      scheduleNext();
      return status();
    }

    queue.push(item);
    enforceLimit(at);
    scheduleNext();
    return status();
  }

  function takeNext() {
    const at = clock();
    let index = queue.findIndex((entry) => isProtected(entry, at));
    if (index === -1) index = 0;
    return queue.splice(index, 1)[0];
  }

  function finishRun(active, value, error) {
    if (error !== null) failures += 1;
    if (activeWindow === active) activeWindow = null;
    inFlight = null;
    if (!stopped) scheduleNext();
    return error === null ? value : null;
  }

  function startRun(item) {
    if (stopped) return Promise.resolve(null);
    if (inFlight !== null) return inFlight;
    clearScheduled();

    const startedAt = clock();
    lastAt = startedAt;
    lastReason = item.reason;
    runs += 1;
    const active = {
      from: item.from,
      to: item.to,
      reason: item.reason,
      priority: item.priority,
    };
    activeWindow = active;

    let result;
    try {
      result = run({
        from: item.from,
        to: item.to,
        reason: item.reason,
        priority: item.priority,
      });
    } catch (error) {
      result = Promise.reject(error);
    }

    const work = Promise.resolve(result).then(
      (value) => finishRun(active, value, null),
      (error) => finishRun(active, null, error),
    );
    inFlight = work;
    return work;
  }

  /**
   * 定时器回调 / 测试手动触发。空闲且队列非空、且已过 minInterval 时启动一次 run，返回
   * run 的结果；否则返回 null（例如还在冷却、队列为空、stop 之后）。run 抛错/拒绝时计入
   * failures 并 resolve(null)，不会把错误抛给定时器或 flush 调用方。
   */
  function flush() {
    if (stopped) return Promise.resolve(null);
    if (inFlight !== null) return inFlight;
    if (queue.length === 0) {
      clearScheduled();
      return Promise.resolve(null);
    }
    const at = clock();
    if (lastAt !== null && at < lastAt + interval) {
      scheduleNext();
      return Promise.resolve(null);
    }
    const item = takeNext();
    if (item === undefined) return Promise.resolve(null);
    return startRun(item);
  }

  /** 清定时器、清等待队列并拒绝后续触发；在途 run 让它自然结束，不再级联新 run。 */
  function stop() {
    if (stopped) return;
    stopped = true;
    clearScheduled();
    queue.length = 0;
  }

  return { note, flush, status, stop };
}
