/**
 * P-186 / P-187 阶段 1 —— 有界视听证据窗口（画面一侧）。
 *
 * 这层只保存“什么时候、从哪个来源、哪一代”的一小段画面元数据，不读像素、不截图、不调用模型：
 *
 *   - 采集由宿主负责，这里只接收已经落盘的帧/故事板（`add`）；
 *   - 窗口同时受**时长**（默认 30 s）和**字节**限制，超限先淘汰最旧的未锁定帧；
 *   - 用户一开口就 `lock()` 住“开口前一小段 + 发言期间”，被锁住的帧不会被滚动缓存淘汰
 *     （锁定本身有 TTL 上限，避免锁无限挡路）；`extendLock()` 在发言结束时补上结束时间；
 *   - 每条记录都带 `source` 与 `sourceEpoch`：切源、隐私、采集重启后旧帧永远配不上新一代。
 *
 * 为什么只有元数据：帧文件由宿主创建和删除，`onEvict` / `onClear` 把“该删文件了”交回宿主；
 * 本模块在导入时没有任何副作用，也不碰磁盘。事件是否指向真实帧、时间是否可信，由调用方保证；
 * 这里只负责不丢证据、不越界、不串代次。
 *
 * 当前阶段（最小闭环 ①）只提供“时间对齐 + 有界缓存 + 锁定窗口”；后台事件提炼和主请求的
 * 「评论片段 / 最新画面」区分由后续阶段接在这层之上。
 */

/** 第一版试验参数；不是冻结值，按本机实测再调。 */
export const EVIDENCE_WINDOW_DEFAULTS = Object.freeze({
  /** 滚动窗口时长：与既有观察 TTL 对齐（30 s）。 */
  maxAgeMs: 30_000,
  /** 内存/磁盘占用上限（按文件字节计，不按帧数猜）。 */
  maxBytes: 24 * 1024 * 1024,
  /** 兜底帧数上限：极小的帧也不能无限堆。 */
  maxFrames: 300,
  /** 同一来源、同一代次在这个间隔内的帧视为同一次变化，不重复登记。 */
  minGapMs: 200,
  /** 锁定窗口的最长寿命：没人释放时也不会永久挡住淘汰。 */
  lockTtlMs: 120_000,
  /** 同时存在的锁上限（开口 → 识别完成 → 释放之间通常只有一把）。 */
  maxLocks: 8,
  /** 开口前默认回溯范围（“刚才那个”的搜索起点）。 */
  lockLookbackMs: 8_000,
  /** 被锁住的帧超过窗口两倍时长后允许淘汰：锁定不是无限内存的借口。 */
  pinnedMaxAgeFactor: 2,
});

const KINDS = new Set(['shot', 'storyboard', 'frame']);

function nonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

/** 代次只要可比较即可：数字与字符串都接受，但空值统一记 0。 */
function normalizeEpoch(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') return value.length > 0 ? value : 0;
  return 0;
}

/**
 * 校验并归一化一帧证据。拒绝时给出机器可读原因，调用方只记计数，不写正文。
 * @param {object} input
 * @param {{now?: number}} [options]
 * @returns {{ok: true, frame: object} | {ok: false, reason: string}}
 */
export function normalizeEvidenceFrame(input, { now = Date.now } = {}) {
  if (input === null || typeof input !== 'object') return { ok: false, reason: 'not-an-object' };
  const file = typeof input.file === 'string' ? input.file.trim() : '';
  if (file.length === 0) return { ok: false, reason: 'no-file' };
  const bytes = positive(input.bytes);
  if (bytes === null) return { ok: false, reason: 'no-bytes' };
  const capturedAt = positive(input.capturedAt ?? input.at);
  if (capturedAt === null) return { ok: false, reason: 'no-capture-time' };
  const source = typeof input.source === 'string' && input.source.trim().length > 0
    ? input.source.trim()
    : '';
  if (source.length === 0) return { ok: false, reason: 'no-source' };
  const kind = typeof input.kind === 'string' && KINDS.has(input.kind) ? input.kind : 'frame';
  const clock = positive(now()) ?? Date.now();
  // 未来时间戳不可信（时钟回拨、拼接），但也不丢弃证据：夹到当前时刻并留下原因。
  const future = capturedAt > clock + 1_000;
  return {
    ok: true,
    frame: {
      file,
      bytes,
      capturedAt: future ? clock : capturedAt,
      at: future ? clock : capturedAt,
      source,
      sourceEpoch: normalizeEpoch(input.sourceEpoch),
      kind,
      width: nonNegative(input.width) ?? 0,
      height: nonNegative(input.height) ?? 0,
      // 采集时间与处理时间分开：故事板可能很晚才打包完成。
      processedAt: clock,
      future,
    },
  };
}

/**
 * @param {object} [options]
 * @param {() => number} [options.now]
 * @param {number} [options.maxAgeMs]
 * @param {number} [options.maxBytes]
 * @param {number} [options.maxFrames]
 * @param {number} [options.minGapMs]
 * @param {number} [options.lockTtlMs]
 * @param {number} [options.maxLocks]
 * @param {number} [options.lockLookbackMs]
 * @param {(entry: object, reason: string) => void} [options.onEvict]
 * @param {(reason: string) => void} [options.onClear]
 * @param {(type: string, payload: object) => void} [options.emit]
 */
export function createEvidenceWindow({
  now = Date.now,
  maxAgeMs = EVIDENCE_WINDOW_DEFAULTS.maxAgeMs,
  maxBytes = EVIDENCE_WINDOW_DEFAULTS.maxBytes,
  maxFrames = EVIDENCE_WINDOW_DEFAULTS.maxFrames,
  minGapMs = EVIDENCE_WINDOW_DEFAULTS.minGapMs,
  lockTtlMs = EVIDENCE_WINDOW_DEFAULTS.lockTtlMs,
  maxLocks = EVIDENCE_WINDOW_DEFAULTS.maxLocks,
  lockLookbackMs = EVIDENCE_WINDOW_DEFAULTS.lockLookbackMs,
  pinnedMaxAgeFactor = EVIDENCE_WINDOW_DEFAULTS.pinnedMaxAgeFactor,
  onEvict = () => {},
  onClear = () => {},
  emit = () => {},
} = {}) {
  const clock = () => positive(now()) ?? Date.now();
  const ageLimit = () => (Number.isFinite(maxAgeMs) && maxAgeMs > 0 ? maxAgeMs : EVIDENCE_WINDOW_DEFAULTS.maxAgeMs);
  const byteLimit = () => (Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : EVIDENCE_WINDOW_DEFAULTS.maxBytes);
  const frameLimit = () => (Number.isFinite(maxFrames) && maxFrames > 0 ? maxFrames : EVIDENCE_WINDOW_DEFAULTS.maxFrames);
  const gapLimit = () => (Number.isFinite(minGapMs) && minGapMs >= 0 ? minGapMs : 0);
  const ttl = () => (Number.isFinite(lockTtlMs) && lockTtlMs > 0 ? lockTtlMs : EVIDENCE_WINDOW_DEFAULTS.lockTtlMs);
  const locksLimit = () => (Number.isFinite(maxLocks) && maxLocks > 0 ? maxLocks : 1);
  const pinFactor = () => (Number.isFinite(pinnedMaxAgeFactor) && pinnedMaxAgeFactor > 0 ? pinnedMaxAgeFactor : 2);

  /** 本代次登记的全部证据，按采集时间递增（后到的旧帧也会插到正确位置）。 */
  let frames = [];
  /** 活跃锁定窗口：`id -> lock`；按创建顺序保存，便于淘汰最旧的锁。 */
  const locks = new Map();
  let seq = 0;
  let lockSeq = 0;
  /** 代次：`clear()` 加一，诊断与调用方可以据此判断结果是否已作废。 */
  let generation = 0;
  const stats = { added: 0, deduped: 0, evicted: 0, rejected: 0, pinnedDropped: 0, locks: 0 };

  const event = (type, payload) => {
    try {
      emit(type, payload);
    } catch {
      /* 观测失败不能影响证据窗口本身 */
    }
  };

  const safeEvict = (entry, reason) => {
    stats.evicted += 1;
    try {
      onEvict(entry, reason);
    } catch {
      /* 文件删除由宿主负责，失败只记在宿主侧 */
    }
  };

  /** 某帧是否被任一活跃锁覆盖（来源/代次一致才算）。 */
  function pinnedBy(entry) {
    const current = clock();
    for (const lock of locks.values()) {
      if (current >= lock.expiresAt) continue;
      if (lock.source !== null && lock.source !== entry.source) continue;
      if (lock.sourceEpoch !== null && lock.sourceEpoch !== entry.sourceEpoch) continue;
      if (entry.capturedAt >= lock.from && entry.capturedAt <= lock.to + 500) return lock;
    }
    return null;
  }

  function expireLocks(current) {
    let expired = 0;
    for (const [id, lock] of locks) {
      if (current >= lock.expiresAt) {
        locks.delete(id);
        expired += 1;
      }
    }
    if (expired > 0) event('vision.evidence.lock.expired', { count: expired });
    return expired;
  }

  function prune(current) {
    expireLocks(current);
    const limitMs = ageLimit();
    const hardLimit = limitMs * pinFactor();
    const kept = [];
    let bytes = 0;
    // 先按时间淘汰：超过硬上限的帧即使被锁也保留不住（锁定不是无限内存的借口）。
    for (const entry of frames) {
      const age = Math.max(0, current - entry.capturedAt);
      if (age > hardLimit) {
        safeEvict(entry, 'age');
        continue;
      }
      kept.push(entry);
      bytes += entry.bytes;
    }
    frames = kept;

    // 再按字节/帧数从最旧的未锁定帧开始淘汰；全被锁时才动最旧的锁定帧。
    while (frames.length > 0) {
      const overBytes = bytes > byteLimit();
      const overFrames = frames.length > frameLimit();
      const overAge = Math.max(0, current - frames[0].capturedAt) > limitMs;
      if (!overBytes && !overFrames && !overAge) break;
      let target = -1;
      for (let i = 0; i < frames.length; i += 1) {
        if (pinnedBy(frames[i]) === null) { target = i; break; }
      }
      if (target < 0) {
        // 全是锁定帧：只有真的超过字节/帧数上限才牺牲最旧的锁定帧。
        if (!overBytes && !overFrames) break;
        target = 0;
        stats.pinnedDropped += 1;
      }
      const [dropped] = frames.splice(target, 1);
      bytes -= dropped.bytes;
      safeEvict(dropped, pinnedBy(dropped) === null ? 'window' : 'pinned-window');
    }
  }

  /**
   * 登记一帧画面。去重只针对“同一来源 + 同一代次 + 极短间隔”，避免同一变化被重复喂给理解层；
   * 不同时间点的帧（哪怕画面相同）都要保留，动作回看依赖它们的先后顺序。
   * @returns {object | null} 归一化后的记录；被拒绝/去重时返回 null。
   */
  function add(input) {
    const checked = normalizeEvidenceFrame(input, { now: clock });
    if (!checked.ok) {
      stats.rejected += 1;
      event('vision.evidence.rejected', { reason: checked.reason });
      return null;
    }
    const frame = checked.frame;
    const current = clock();
    const lastSame = [...frames].reverse().find((entry) => entry.source === frame.source
      && entry.sourceEpoch === frame.sourceEpoch
      && entry.file === frame.file);
    if (lastSame !== undefined) return null; // 同一个文件只登记一次
    const previous = frames[frames.length - 1];
    if (previous !== undefined
      && previous.source === frame.source
      && previous.sourceEpoch === frame.sourceEpoch
      && Math.abs(frame.capturedAt - previous.capturedAt) < gapLimit()) {
      stats.deduped += 1;
      return null;
    }
    const entry = { ...frame, id: `ev-${++seq}`, generation };
    // 插入到按采集时间排序的位置：迟到的旧帧（打包比采集晚）不能排到队尾。
    let position = frames.length;
    while (position > 0 && frames[position - 1].capturedAt > entry.capturedAt) position -= 1;
    frames.splice(position, 0, entry);
    stats.added += 1;
    prune(current);
    event('vision.evidence.added', {
      id: entry.id, source: entry.source, sourceEpoch: entry.sourceEpoch, kind: entry.kind, bytes: entry.bytes,
    });
    return entry;
  }

  /**
   * 用户开口：立即锁住“开口前 `lookbackMs` 到开口时刻”的窗口，不让滚动缓存把候选证据淘汰。
   * 只记录元数据时间范围；真正取帧发生在识别完成、确定评论指向之后。
   * @param {{at?: number, from?: number, to?: number, source?: string|null, sourceEpoch?: number|string|null, reason?: string}} [options]
   */
  function lock({ at, from, to, source = null, sourceEpoch = null, reason = 'speech-start' } = {}) {
    const current = clock();
    const anchor = positive(at) ?? current;
    const windowFrom = positive(from) ?? Math.max(0, anchor - lockLookbackMs);
    const windowTo = positive(to) ?? anchor;
    if (windowTo < windowFrom) return null;
    expireLocks(current);
    while (locks.size >= locksLimit()) {
      const oldest = locks.keys().next().value;
      if (oldest === undefined) break;
      locks.delete(oldest);
    }
    lockSeq += 1;
    const id = `lk-${lockSeq}`;
    const record = {
      id,
      from: windowFrom,
      to: windowTo,
      at: anchor,
      source: typeof source === 'string' && source.length > 0 ? source : null,
      sourceEpoch: sourceEpoch === null || sourceEpoch === undefined ? null : normalizeEpoch(sourceEpoch),
      reason: String(reason || 'speech-start'),
      createdAt: current,
      expiresAt: current + ttl(),
      generation,
    };
    locks.set(id, record);
    stats.locks += 1;
    event('vision.evidence.lock', {
      id, from: record.from, to: record.to, reason: record.reason, generation,
    });
    return { ...record };
  }

  /** 发言结束：把锁窗的结束点推到识别完成时刻，发言期间到达的帧也被覆盖。 */
  function extendLock(id, { to, now: at } = {}) {
    const record = locks.get(id);
    if (record === undefined) return null;
    const current = positive(at) ?? clock();
    const nextTo = positive(to) ?? current;
    record.to = Math.max(record.to, nextTo);
    record.expiresAt = Math.max(record.expiresAt, current + ttl());
    event('vision.evidence.lock.extended', { id, to: record.to });
    return { ...record };
  }

  function releaseLock(id) {
    const record = locks.get(id);
    if (record === undefined) return null;
    locks.delete(id);
    event('vision.evidence.lock.released', { id, from: record.from, to: record.to });
    return { ...record };
  }

  function clear(reason = 'clear') {
    const current = clock();
    const count = frames.length;
    const bytes = frames.reduce((sum, entry) => sum + entry.bytes, 0);
    frames = [];
    locks.clear();
    generation += 1;
    try {
      onClear(reason);
    } catch {
      /* 宿主清理失败不阻断窗口重置 */
    }
    event('vision.evidence.cleared', { reason, frames: count, bytes, generation });
    return { ok: true, frames: count, bytes, generation };
  }

  /** 命中 `[from, to]` 的证据（含边界），按采集时间升序；来源/代次可过滤。 */
  function between(from, to, { source = null, sourceEpoch = null } = {}) {
    const start = Number(from);
    const end = Number(to);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return [];
    return frames.filter((entry) => entry.capturedAt >= start
      && entry.capturedAt <= end
      && (source === null || entry.source === source)
      && (sourceEpoch === null || entry.sourceEpoch === sourceEpoch))
      .map((entry) => ({ ...entry }));
  }

  /** 满足条件的最新一帧（`current state` 用）。 */
  function latest({ source = null, sourceEpoch = null } = {}) {
    for (let i = frames.length - 1; i >= 0; i -= 1) {
      const entry = frames[i];
      if (source !== null && entry.source !== source) continue;
      if (sourceEpoch !== null && entry.sourceEpoch !== sourceEpoch) continue;
      return { ...entry };
    }
    return null;
  }

  function state() {
    const current = clock();
    const activeLocks = [...locks.values()].filter((lock) => current < lock.expiresAt);
    const bytes = frames.reduce((sum, entry) => sum + entry.bytes, 0);
    const pinned = frames.filter((entry) => pinnedBy(entry) !== null);
    return {
      generation,
      frames: frames.length,
      bytes,
      pinnedFrames: pinned.length,
      pinnedBytes: pinned.reduce((sum, entry) => sum + entry.bytes, 0),
      oldestAt: frames.length === 0 ? null : frames[0].capturedAt,
      newestAt: frames.length === 0 ? null : frames[frames.length - 1].capturedAt,
      locks: activeLocks.map((lock) => ({ ...lock })),
      stats: { ...stats },
    };
  }

  return { add, lock, extendLock, releaseLock, clear, between, latest, state };
}
