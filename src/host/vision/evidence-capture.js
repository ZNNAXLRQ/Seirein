/**
 * P-186 / P-187 阶段 1 —— 持续证据采集（采集 → 按变化取故事板 → 交给宿主登记）。
 *
 * 证据窗口（`evidence-window.js`）只负责“收什么、留多久”；这里负责“什么时候去取”。它自己拥有
 * 一个采集会话（通常是一路故事板 ffmpeg），按固定节奏调用 `session.take({force:false})`：
 * 没有变化就计一次 idle，连续 idle 超过阈值后把节奏放慢到 `idleTickMs`，一有变化立即恢复。
 *
 * 所有副作用都可注入（`start` / `onSheet` / `isBlocked` / `now` / 定时器 / `emit`），所以测试
 * 不需要真实 ffmpeg、屏幕或时间。模块本身不读像素、不碰磁盘、不登记文件路径。
 *
 * 生命周期与代次：
 *   - `start()` 幂等：已在运行（或正在启动）时直接返回状态；
 *   - `stop()` 让当前代次作废、清定时器、有界等待会话退出；
 *   - `restart()` 先停再起，旧会话迟到的 sheet/错误一律丢弃（记 `stale`），绝不交给 `onSheet`；
 *   - `status()` 只含计数/时间/来源，不含任何文件路径。
 */
export const EVIDENCE_CAPTURE_DEFAULTS = Object.freeze({
  /** 取一次变化故事板的间隔。 */
  tickMs: 2000,
  /** 连续无变化多少 tick 后降低取帧频率。 */
  maxIdleTicks: 30,
  /** 空闲时的取帧间隔。 */
  idleTickMs: 6000,
});

/** `stop()` 等待会话退出/在途 tick 的上限；超时只记录事件，不无限挂住调用方。 */
const STOP_TIMEOUT_MS = 5000;

function delayOf(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function idleLimitOf(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : EVIDENCE_CAPTURE_DEFAULTS.maxIdleTicks;
}

function reasonOf(error) {
  return error?.message ?? String(error);
}

/**
 * @param {object} options
 * @param {(context: {source: string}) => Promise<object>} options.start
 *   创建采集会话：`{take({force}), stop(), done, engine, sourceKind}`。
 * @param {(sheet: object) => Promise<void>|void} options.onSheet
 *   宿主登记一次真实变化（复制/核代次由宿主完成）。
 * @param {() => boolean} [options.isBlocked] - 隐私 / 切源 / 卸载中：跳过本次取帧。
 * @param {() => number} [options.now]
 * @param {typeof setTimeout} [options.setTimer]
 * @param {typeof clearTimeout} [options.clearTimer]
 * @param {number} [options.tickMs]
 * @param {number} [options.idleTickMs]
 * @param {number} [options.maxIdleTicks]
 * @param {(type: string, payload: object) => void} [options.emit]
 */
export function createEvidenceCapture({
  start: startSession,
  onSheet,
  isBlocked = () => false,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  tickMs = EVIDENCE_CAPTURE_DEFAULTS.tickMs,
  idleTickMs = EVIDENCE_CAPTURE_DEFAULTS.idleTickMs,
  maxIdleTicks = EVIDENCE_CAPTURE_DEFAULTS.maxIdleTicks,
  emit = () => {},
} = {}) {
  if (typeof startSession !== 'function') throw new TypeError('createEvidenceCapture: start 必须是函数');
  if (typeof onSheet !== 'function') throw new TypeError('createEvidenceCapture: onSheet 必须是函数');

  const clock = () => {
    const value = Number(now());
    return Number.isFinite(value) ? value : Date.now();
  };
  const activeDelay = delayOf(tickMs, EVIDENCE_CAPTURE_DEFAULTS.tickMs);
  const idleDelay = delayOf(idleTickMs, EVIDENCE_CAPTURE_DEFAULTS.idleTickMs);
  const idleLimit = idleLimitOf(maxIdleTicks);
  const event = (type, payload) => {
    try {
      emit(type, payload);
    } catch {
      /* 观测失败不影响采集循环 */
    }
  };
  const blocked = () => {
    try {
      return isBlocked() === true;
    } catch {
      return true; // 读不到锁就当作被挡住，绝不越界采集
    }
  };

  /** 一个采集代次：start/stop/restart 都让它作废，迟到的结果据此丢弃。 */
  let epoch = 0;
  let running = false;
  /** 启动中/停止中的串行句柄，避免并发 start/stop 抢同一个会话。 */
  let starting = null;
  let stopping = null;
  /** 调用方是否还想要采集：启动完成后据此决定是否保留刚建好的会话。 */
  let wanted = false;

  let session = null;
  let timer = null;
  let inFlight = null;
  let startedAt = null;
  let ticks = 0;
  let sheets = 0;
  let idleTicks = 0;
  let source = '';
  let engine = '';

  /** 每次运行一个 done；stop 后 resolve，重新 start 会换一个新的。 */
  let donePromise = null;
  let resolveDone = null;
  const newDone = () => {
    donePromise = new Promise((resolve) => {
      resolveDone = resolve;
    });
  };
  const settleDone = () => {
    const resolve = resolveDone;
    resolveDone = null;
    try { resolve?.(); } catch { /* already settled */ }
  };
  newDone();

  const status = () => ({
    running,
    startedAt,
    ticks,
    sheets,
    idleTicks,
    source,
    engine,
  });

  const clearTimerNow = () => {
    if (timer === null) return;
    try { clearTimer(timer); } catch { /* already fired/cleared */ }
    timer = null;
  };

  const nextDelay = () => (idleTicks > idleLimit ? idleDelay : activeDelay);

  function schedule(delay = nextDelay()) {
    if (!running || timer !== null) return;
    const runEpoch = epoch;
    const handle = setTimer(() => {
      if (timer === handle) timer = null;
      if (!running || runEpoch !== epoch) return;
      const work = tick(runEpoch);
      inFlight = work;
      void work.finally(() => {
        if (inFlight === work) inFlight = null;
      }).catch(() => {});
    }, delay);
    timer = handle;
    handle?.unref?.();
  }

  /**
   * 一个 tick 只做一件事：被挡住就跳过；否则取一次“不强制”的故事板。
   * `take` 或 `onSheet` 失败只记事件，循环继续。
   */
  async function tick(runEpoch) {
    ticks += 1;
    try {
      if (!running || runEpoch !== epoch) return;
      const owner = session;
      if (owner === null) return;
      if (blocked()) return;
      let sheet;
      try {
        sheet = await owner.take({ force: false });
      } catch (error) {
        if (!running || runEpoch !== epoch) {
          event('vision.evidence.capture.stale', { reason: 'take-error' });
          return;
        }
        event('vision.evidence.capture.failed', { reason: reasonOf(error) });
        return;
      }
      // stop/restart 之后到货的 sheet 一律丢弃，且不调用 onSheet。
      if (!running || runEpoch !== epoch) {
        if (sheet !== null && sheet !== undefined) {
          event('vision.evidence.capture.stale', { reason: 'sheet' });
        }
        return;
      }
      if (sheet === null || sheet === undefined) {
        idleTicks += 1;
        return;
      }
      idleTicks = 0;
      sheets += 1;
      try {
        await onSheet(sheet);
      } catch (error) {
        event('vision.evidence.capture.failed', { stage: 'on-sheet', reason: reasonOf(error) });
      }
    } finally {
      if (running && runEpoch === epoch) schedule();
    }
  }

  /**
   * 启动采集。幂等：已在运行或正在启动时返回当前状态，不重复开会话。
   * 启动失败会记录 `vision.evidence.capture.failed` 后继续抛出，让宿主决定是否重试。
   */
  async function start({ source: requestedSource = '' } = {}) {
    if (running) return status();
    if (stopping !== null) await stopping.catch(() => {});
    if (running) return status();
    // 只有“还想要的启动”才共享；被 stop 放弃（可能已超时）的旧启动不挡住新一代。
    if (starting !== null && wanted === true) return starting;

    newDone();
    const runEpoch = ++epoch;
    wanted = true;
    ticks = 0;
    sheets = 0;
    idleTicks = 0;
    startedAt = null;
    engine = '';
    source = typeof requestedSource === 'string' ? requestedSource : '';

    const task = (async () => {
      const created = await startSession({ source: requestedSource });
      // 启动期间被 stop/restart 抢先：不保留这个会话，也不登记它的任何结果。
      if (runEpoch !== epoch || wanted !== true || running) {
        try { created?.stop?.(); } catch { /* session teardown is best effort */ }
        await Promise.resolve(created?.done).catch(() => {});
        return status();
      }
      if (created === null || created === undefined) throw new Error('证据采集启动未返回会话');
      session = created;
      engine = typeof created.engine === 'string' ? created.engine : '';
      if (typeof created.sourceKind === 'string' && created.sourceKind.length > 0) {
        source = created.sourceKind;
      }
      running = true;
      startedAt = clock();
      schedule();
      event('vision.evidence.capture.start', { source, engine });
      return status();
    })();

    starting = task;
    try {
      return await task;
    } catch (error) {
      if (runEpoch === epoch) {
        running = false;
        wanted = false;
        session = null;
        clearTimerNow();
        settleDone();
        event('vision.evidence.capture.failed', { stage: 'start', reason: reasonOf(error) });
      }
      throw error;
    } finally {
      if (starting === task) starting = null;
    }
  }

  /**
   * 停止采集：作废当前代次、清定时器、停会话，并有界等待在途 tick/会话退出。
   * 可重复调用；并发的 stop 共享同一个任务。
   */
  async function stop(reason = 'stop') {
    if (stopping !== null) return stopping;
    if (!running && session === null && starting === null) {
      wanted = false;
      settleDone();
      return status();
    }

    const task = (async () => {
      const stoppedSession = session;
      const startTask = starting;
      running = false;
      wanted = false;
      ++epoch;
      clearTimerNow();
      session = null;
      let stopResult = null;
      try { stopResult = stoppedSession?.stop?.(); } catch (error) {
        event('vision.evidence.capture.failed', { stage: 'stop', reason: reasonOf(error) });
      }

      let timedOut = false;
      let timeoutTimer = null;
      const timeout = new Promise((resolve) => {
        timeoutTimer = setTimer(() => {
          timedOut = true;
          event('vision.evidence.capture.stop-timeout', { reason });
          resolve();
        }, STOP_TIMEOUT_MS);
        timeoutTimer?.unref?.();
      });

      const waits = [];
      if (startTask !== null) waits.push(Promise.resolve(startTask).catch(() => {}));
      if (inFlight !== null) waits.push(Promise.resolve(inFlight).catch(() => {}));
      if (stopResult !== null && stopResult !== undefined && typeof stopResult.then === 'function') {
        waits.push(Promise.resolve(stopResult).catch(() => {}));
      }
      if (stoppedSession !== null && stoppedSession !== undefined) {
        waits.push(Promise.resolve(stoppedSession.done).catch(() => {}));
      }
      await Promise.race([Promise.all(waits), timeout]);
      if (timeoutTimer !== null) {
        try { clearTimer(timeoutTimer); } catch { /* already fired */ }
        timeoutTimer = null;
      }
      if (!timedOut) event('vision.evidence.capture.stop', { reason });
      settleDone();
      return status();
    })();

    stopping = task;
    try {
      return await task;
    } finally {
      if (stopping === task) stopping = null;
    }
  }

  async function restart({ source: requestedSource = '' } = {}) {
    await stop('restart');
    return start({ source: requestedSource });
  }

  return {
    start,
    stop,
    restart,
    status,
    get done() { return donePromise; },
  };
}
