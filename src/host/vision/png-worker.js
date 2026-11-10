/**
 * 原帧 PNG 编码 worker 池。
 *
 * 背景：原帧（1920×1200 rgb24）用同步 `deflateSync` 编码时，最坏（不可压缩画面）
 * 约 136 ms/帧；一张 6 帧故事板会在主线程上连续阻塞约 0.8 s，采集与理解都被拖住。
 * 这里把编码放进 `worker_threads`：
 *
 *   - 并发上限 `concurrency`（默认 2）：同时最多几个 worker 在编码；
 *   - 队列上限 `queueLimit`（默认 16）：等待派发的任务数上限，满了立刻以
 *     `code: 'queue_full'` 拒绝，由调用方降级为“跳过原帧、保留故事板”；
 *   - 单任务超时 `timeoutMs`：卡死的 worker 会被终止并换新，`take()` 不会被永久挂住；
 *   - worker 崩溃/退出会把在途任务以 `worker_error`/`worker_exit` 拒绝，队列继续可用。
 *
 * 该文件同时是 worker 入口和主线程侧池实现：`isMainThread === false` 时只跑编码循环。
 * 输入像素用结构化克隆传递（不 transfer），因为同一份原帧像素还归有界原帧队列所有，
 * 直接 detach 会破坏队列；输出 PNG 也只做克隆，避免 detach 小 Buffer 共享的 8 KB slab。
 *
 * 上限对应的最坏内存：队列里最多 `concurrency + queueLimit` 个任务持有调用方的像素
 * 引用（不复制，像素本来就在原帧队列的 256 MB 预算内）；真正复制进 worker 的只有
 * `concurrency` 帧（2 × 6.9 MB ≈ 14 MB）；PNG 结果边到边写盘，不批量堆积。
 */
import { Worker, isMainThread, parentPort } from 'node:worker_threads';

/** 编码池默认边界。测试与性能基准都从这里取默认值。 */
export const PNG_ENCODER_DEFAULTS = Object.freeze({
  /** 同时编码的 worker 数上限。 */
  concurrency: 2,
  /** 等待派发的任务数上限（不含正在编码的）。 */
  queueLimit: 16,
  /** 单帧编码超时；超时后终止该 worker 并在下次任务时换新。 */
  timeoutMs: 15_000,
  /** PNG deflate 等级：原帧只要看清细节，1 在体积/延迟之间最划算。 */
  level: 1,
});

const MAX_CONCURRENCY = 8;
const MAX_QUEUE_LIMIT = 256;
const MAX_TIMEOUT_MS = 120_000;
const WORKER_URL = new URL(import.meta.url);

/** 错误消息只留有限长度：原因要可观测，但不能成为无界日志。 */
function boundedMessage(value) {
  const text = value instanceof Error ? value.message : String(value ?? '');
  return text.slice(0, 200);
}

function codedError(code, cause) {
  const error = new Error(boundedMessage(cause) || code);
  error.code = code;
  return error;
}

function integerWithin(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

/*
 * Worker 入口。Node 的 ESM worker 支持顶层 await；这里只加载编码器、串行处理消息。
 * 每个 worker 同一时刻只会收到一个任务（池侧保证），所以同步 encode 不会互相插队。
 */
if (!isMainThread && parentPort !== null) {
  const { encodePng } = await import('dsh-see-now/png');
  parentPort.on('message', (message) => {
    if (message === null || typeof message !== 'object' || message.type !== 'encode') return;
    try {
      const png = encodePng(message.rgb, message.width, message.height, { level: message.level });
      parentPort.postMessage({ type: 'encoded', id: message.id, png });
    } catch (error) {
      parentPort.postMessage({
        type: 'failed',
        id: message.id,
        code: 'encode_failed',
        message: boundedMessage(error),
      });
    }
  });
}

/**
 * 创建一个有界 PNG 编码池。worker 懒启动：第一次 encode 才 spawn，空闲时不占 CPU；
 * 空闲 worker 会被 unref，不会单独吊住 Node 进程。`close()` 终止全部线程。
 *
 * @param {object} [options]
 * @param {number} [options.concurrency]
 * @param {number} [options.queueLimit]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.level]
 */
export function createPngEncoderPool(options = {}) {
  const concurrency = integerWithin(
    options.concurrency,
    PNG_ENCODER_DEFAULTS.concurrency,
    1,
    MAX_CONCURRENCY,
  );
  const queueLimit = integerWithin(options.queueLimit, PNG_ENCODER_DEFAULTS.queueLimit, 0, MAX_QUEUE_LIMIT);
  const timeoutMs = integerWithin(options.timeoutMs, PNG_ENCODER_DEFAULTS.timeoutMs, 1, MAX_TIMEOUT_MS);
  const level = integerWithin(options.level, PNG_ENCODER_DEFAULTS.level, 0, 9);

  /** @type {{worker: Worker, current: object|null, dead: boolean}[]} */
  const workers = [];
  /** @type {object[]} */
  let queue = [];
  let closed = false;
  let closePromise = null;
  let sequence = 0;
  const counts = { completed: 0, failed: 0, dropped: 0 };

  const removeSlot = (slot) => {
    const index = workers.indexOf(slot);
    if (index >= 0) workers.splice(index, 1);
  };

  /** 结算一个任务（只一次）：清定时器/abort 监听、释放像素引用、resolve/reject。 */
  const settle = (job, error, png) => {
    if (job.settled) return;
    job.settled = true;
    if (job.timer !== null) {
      clearTimeout(job.timer);
      job.timer = null;
    }
    if (job.signal !== null && job.onAbort !== null) {
      job.signal.removeEventListener('abort', job.onAbort);
    }
    job.rgb = null;
    if (error === null) {
      counts.completed += 1;
      job.resolve(png);
    } else {
      counts.failed += 1;
      job.reject(error);
    }
  };

  /**
   * 让一个 worker 退出服务：拒绝它在跑的任务，终止线程，并在仍有序号时补一个新 worker。
   * 用于 worker error/exit、超时和 abort；必须幂等（error 后通常还会再收到 exit）。
   */
  const failSlot = (slot, code, cause) => {
    if (slot.dead) return;
    slot.dead = true;
    removeSlot(slot);
    const job = slot.current;
    slot.current = null;
    if (job !== null) settle(job, codedError(code, cause));
    slot.worker.terminate().catch(() => {});
    if (!closed) pump();
  };

  function spawn() {
    let worker;
    try {
      worker = new Worker(WORKER_URL);
    } catch {
      // 线程都起不来（资源耗尽/入口缺失）：让 pump 把队列里等着的任务直接判失败，
      // 而不是把异常抛给消息回调。
      return null;
    }
    // 空闲 worker 不吊住进程；派发任务时再 ref（见 dispatch）。
    worker.unref();
    const slot = { worker, current: null, dead: false };
    worker.on('message', (message) => {
      if (slot.dead || slot.current === null) return;
      const job = slot.current;
      if (message === null || typeof message !== 'object' || message.id !== job.id) return;
      slot.current = null;
      worker.unref();
      if (message.type === 'encoded') settle(job, null, message.png);
      else settle(job, codedError(message.code ?? 'encode_failed', message.message));
      pump();
    });
    worker.on('error', (error) => failSlot(slot, 'worker_error', error));
    worker.on('exit', (code) => {
      if (slot.dead) return;
      slot.dead = true;
      removeSlot(slot);
      const job = slot.current;
      slot.current = null;
      if (job !== null) settle(job, codedError('worker_exit', `worker exited (${code})`));
      if (!closed) pump();
    });
    workers.push(slot);
    return slot;
  }

  const dispatch = (slot, job) => {
    slot.current = job;
    job.slot = slot;
    // worker 在处理任务期间必须保持进程存活（空闲时才 unref）。
    slot.worker.ref();
    job.timer = setTimeout(() => {
      if (job.settled || slot.dead || slot.current !== job) return;
      slot.current = null;
      settle(job, codedError('encode_timeout', `encoding exceeded ${timeoutMs} ms`));
      slot.dead = true;
      removeSlot(slot);
      slot.worker.terminate().catch(() => {});
      if (!closed) pump();
    }, timeoutMs);
    job.timer.unref?.();
    try {
      // 不 transfer：像素仍归原帧队列，detach 会让后续 take 拿到空数据。
      slot.worker.postMessage({
        type: 'encode',
        id: job.id,
        rgb: job.rgb,
        width: job.width,
        height: job.height,
        level: job.level,
      });
    } catch (error) {
      slot.current = null;
      settle(job, codedError('worker_error', error));
      slot.dead = true;
      removeSlot(slot);
      slot.worker.terminate().catch(() => {});
    }
  };

  function pump() {
    if (closed) return;
    while (queue.length > 0) {
      let slot = workers.find((entry) => !entry.dead && entry.current === null);
      if (slot === undefined) {
        if (workers.length >= concurrency) return;
        slot = spawn();
        if (slot === null) {
          for (const job of queue.splice(0)) {
            settle(job, codedError('worker_error', 'failed to start encoder worker'));
          }
          return;
        }
      }
      const job = queue.shift();
      if (job.settled) continue;
      dispatch(slot, job);
    }
  }

  /** 队列还有没有位置：空闲 worker、可新建 worker，或等待队列未满。 */
  const canAccept = () => {
    if (workers.some((slot) => !slot.dead && slot.current === null)) return true;
    if (workers.length < concurrency) return true;
    return queue.length < queueLimit;
  };

  /**
   * 提交一帧编码。队列满时立刻以 `code: 'queue_full'` 拒绝（不排队、不阻塞调用方）；
   * 其余失败以 `encode_failed` / `encode_timeout` / `worker_error` / `closed` 拒绝。
   * @param {{rgb: Buffer|Uint8Array, width: number, height: number, level?: number, signal?: AbortSignal}} input
   * @returns {Promise<Buffer|Uint8Array>}
   */
  function encode(input = {}) {
    return new Promise((resolve, reject) => {
      if (closed) {
        reject(codedError('closed', 'encoder pool closed'));
        return;
      }
      const signal = input.signal ?? null;
      if (signal !== null && signal.aborted) {
        reject(signal.reason ?? codedError('aborted', 'aborted'));
        return;
      }
      if (!canAccept()) {
        counts.dropped += 1;
        reject(codedError('queue_full', `queue full (queueLimit=${queueLimit})`));
        return;
      }
      const job = {
        id: ++sequence,
        rgb: input.rgb,
        width: input.width,
        height: input.height,
        level: integerWithin(input.level, level, 0, 9),
        signal,
        onAbort: null,
        timer: null,
        slot: null,
        settled: false,
        resolve,
        reject,
      };
      if (signal !== null && typeof signal.addEventListener === 'function') {
        job.onAbort = () => {
          if (job.settled) return;
          const reason = signal.reason ?? codedError('aborted', 'aborted');
          const index = queue.indexOf(job);
          if (index >= 0) {
            queue.splice(index, 1);
            settle(job, reason);
            return;
          }
          if (job.slot !== null && job.slot.current === job) {
            failSlot(job.slot, 'aborted', reason);
            return;
          }
          settle(job, reason);
        };
        signal.addEventListener('abort', job.onAbort, { once: true });
      }
      queue.push(job);
      pump();
    });
  }

  function state() {
    let active = 0;
    for (const slot of workers) if (slot.current !== null) active += 1;
    return {
      concurrency,
      queueLimit,
      workers: workers.length,
      active,
      queued: queue.length,
      completed: counts.completed,
      failed: counts.failed,
      dropped: counts.dropped,
      closed,
    };
  }

  function close() {
    if (closePromise !== null) return closePromise;
    closed = true;
    const pending = queue;
    queue = [];
    for (const job of pending) settle(job, codedError('closed', 'encoder pool closed'));
    const terminations = [];
    for (const slot of workers.splice(0)) {
      slot.dead = true;
      const job = slot.current;
      slot.current = null;
      if (job !== null) settle(job, codedError('closed', 'encoder pool closed'));
      terminations.push(slot.worker.terminate().catch(() => {}));
    }
    closePromise = Promise.all(terminations).then(() => undefined);
    return closePromise;
  }

  return { encode, close, state };
}
