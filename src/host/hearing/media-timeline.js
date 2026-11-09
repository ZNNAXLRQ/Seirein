/**
 * P-187 阶段 1 —— 连续媒体台词时间线（回环声音一侧）。
 *
 * 回环转写是一条**独立证据流**，不是用户发言：它不创建用户轮次、不写入用户偏好、不触发回复。
 * 这里只把“哪一段时间里媒体说了什么”按时间组织起来，供视觉理解对齐使用：
 *
 *   - 每条都带真实的音频区间 `audioStartAt` / `audioEndAt`（采集时间，不是识别完成时间）；
 *   - 同一片段先 `partial` 后 `final`，用同一个 `id` **更新**，绝不追加成两遍台词；
 *   - 带 `sourceEpoch`：切源、重启、隐私边界之后旧台词不与新台词拼接；
 *   - 有界：按条数与字符数淘汰最旧的台词，不长期落盘。
 *
 * 合并规则保守：只覆盖同一 `id`（同一片段）的 partial→final；不同片段即使相邻也不在这里
 * 猜重复——去重需要重叠证据，那是理解层的职责。
 */

/** 第一版试验参数：时长/条数/字符都设上限，不按“大约”猜。 */
export const MEDIA_TIMELINE_DEFAULTS = Object.freeze({
  /** 媒体台词在缓存里保留多久（5 分钟：比一次评论回溯更长）。 */
  maxAgeMs: 5 * 60_000,
  /** 条数上限。 */
  maxEntries: 400,
  /** 全部条目文本的字符上限。 */
  maxChars: 20_000,
  /** 单条台词保留的字符上限（超长转写截断，保留开头）。 */
  maxEntryChars: 800,
});

const STATUS_RANK = { partial: 0, final: 1 };

function finiteTime(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function normalizeEpoch(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') return value.length > 0 ? value : 0;
  return 0;
}

function clipText(text, limit) {
  const value = typeof text === 'string' ? text : '';
  if (value.length <= limit) return value;
  return value.slice(0, limit);
}

/**
 * @param {object} [options]
 * @param {() => number} [options.now]
 * @param {number} [options.maxAgeMs]
 * @param {number} [options.maxEntries]
 * @param {number} [options.maxChars]
 * @param {number} [options.maxEntryChars]
 * @param {(entry: object, reason: string) => void} [options.onDrop]
 * @param {(type: string, payload: object) => void} [options.emit]
 */
export function createMediaTimeline({
  now = Date.now,
  maxAgeMs = MEDIA_TIMELINE_DEFAULTS.maxAgeMs,
  maxEntries = MEDIA_TIMELINE_DEFAULTS.maxEntries,
  maxChars = MEDIA_TIMELINE_DEFAULTS.maxChars,
  maxEntryChars = MEDIA_TIMELINE_DEFAULTS.maxEntryChars,
  onDrop = () => {},
  emit = () => {},
} = {}) {
  const clock = () => finiteTime(now()) ?? Date.now();
  const ageLimit = () => (Number.isFinite(maxAgeMs) && maxAgeMs > 0 ? maxAgeMs : MEDIA_TIMELINE_DEFAULTS.maxAgeMs);
  const entryLimit = () => (Number.isFinite(maxEntries) && maxEntries > 0 ? Math.floor(maxEntries) : 1);
  const charLimit = () => (Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : 1);
  const perEntry = () => (Number.isFinite(maxEntryChars) && maxEntryChars > 0
    ? Math.floor(maxEntryChars)
    : MEDIA_TIMELINE_DEFAULTS.maxEntryChars);

  /** 当前代次；`setEpoch` 换代次时旧代次台词直接作废（不跨边界拼接）。 */
  let epoch = 0;
  /** 按 `audioStartAt` 递增的条目。 */
  let entries = [];
  /** `id -> entry`，partial→final 的更新入口。 */
  const byId = new Map();
  let seq = 0;
  const stats = { added: 0, updated: 0, dropped: 0, rejected: 0, epochDropped: 0 };

  const event = (type, payload) => {
    try {
      emit(type, payload);
    } catch {
      /* 观测失败不影响时间线 */
    }
  };

  const drop = (entry, reason) => {
    stats.dropped += 1;
    try {
      onDrop(entry, reason);
    } catch {
      /* 宿主侧清理失败不阻断 */
    }
  };

  function prune(current) {
    const limitMs = ageLimit();
    const kept = [];
    let chars = 0;
    for (const entry of entries) {
      if (current - entry.audioEndAt > limitMs) {
        byId.delete(entry.id);
        drop(entry, 'age');
        continue;
      }
      kept.push(entry);
      chars += entry.text.length;
    }
    entries = kept;
    // 条数/字符超限：从最旧的开始淘汰；partial 与其 final 同 id，删掉即整段消失。
    while (entries.length > entryLimit() || chars > charLimit()) {
      if (entries.length === 0) break;
      const removed = entries.shift();
      chars -= removed.text.length;
      byId.delete(removed.id);
      drop(removed, 'window');
    }
  }

  /** 换代次：旧代次的台词不再属于“现在”，整段作废并记数。 */
  function setEpoch(next) {
    const value = normalizeEpoch(next);
    if (value === epoch) return { ok: true, epoch, dropped: 0 };
    let dropped = 0;
    for (const entry of entries) {
      if (entry.sourceEpoch !== value) {
        byId.delete(entry.id);
        drop(entry, 'epoch');
        dropped += 1;
      }
    }
    entries = entries.filter((entry) => entry.sourceEpoch === value);
    epoch = value;
    stats.epochDropped += dropped;
    event('media.timeline.epoch', { epoch, dropped });
    return { ok: true, epoch, dropped };
  }

  /**
   * 写入/更新一段媒体台词。
   *
   * `id` 是片段身份：同一片段的部分结果与终稿必须复用同一个 id，出现终稿时原地替换文本并
   * 把 `status` 升到 `final`（只升不降）。不同 id 永远是新的一段，哪怕文本相同——角色真的
   * 重复同一句话时要保留。
   *
   * @param {object} input
   * @param {string} input.id
   * @param {number} input.audioStartAt
   * @param {number} input.audioEndAt
   * @param {string} [input.text]
   * @param {'partial'|'final'} [input.status]
   * @param {string} [input.recognition]
   * @param {number|string} [input.sourceEpoch]
   * @returns {object | null}
   */
  function upsert(input) {
    if (input === null || typeof input !== 'object') {
      stats.rejected += 1;
      event('media.timeline.rejected', { reason: 'not-an-object' });
      return null;
    }
    const id = typeof input.id === 'string' ? input.id.trim() : '';
    if (id.length === 0) {
      stats.rejected += 1;
      event('media.timeline.rejected', { reason: 'no-id' });
      return null;
    }
    const audioStartAt = finiteTime(input.audioStartAt);
    const audioEndAt = finiteTime(input.audioEndAt);
    if (audioStartAt === null || audioEndAt === null || audioEndAt < audioStartAt) {
      stats.rejected += 1;
      event('media.timeline.rejected', { reason: 'bad-range' });
      return null;
    }
    const sourceEpoch = input.sourceEpoch === undefined ? epoch : normalizeEpoch(input.sourceEpoch);
    if (sourceEpoch !== epoch) setEpoch(sourceEpoch);
    const status = STATUS_RANK[input.status] !== undefined ? input.status : 'partial';
    const text = clipText((typeof input.text === 'string' ? input.text : '').trim(), perEntry());
    const current = clock();
    const existing = byId.get(id);

    if (existing !== undefined) {
      // 终稿覆盖部分结果；已有的终稿不会被迟到的 partial 降级。空文本永远不擦掉已有台词
      // （终稿为空通常意味着这一段没有可识别内容，保留最后一段有效转写更有用）。
      const nextStatus = STATUS_RANK[status] >= STATUS_RANK[existing.status] ? status : existing.status;
      const incomingWins = STATUS_RANK[status] >= STATUS_RANK[existing.status];
      if (text.length > 0 && (incomingWins || text.length > existing.text.length)) existing.text = text;
      existing.status = nextStatus;
      existing.audioStartAt = Math.min(existing.audioStartAt, audioStartAt);
      existing.audioEndAt = Math.max(existing.audioEndAt, audioEndAt);
      existing.updatedAt = current;
      if (nextStatus === 'final' && existing.finalAt === null) existing.finalAt = current;
      existing.rev += 1;
      stats.updated += 1;
      // 文本变长/变短都可能影响排序与字符预算：重新按开始时间排一次（通常不动）。
      entries.sort((a, b) => a.audioStartAt - b.audioStartAt || a.seq - b.seq);
      prune(current);
      event('media.timeline.updated', {
        id, status: existing.status, chars: existing.text.length, audioStartAt: existing.audioStartAt, audioEndAt: existing.audioEndAt,
      });
      return { ...existing };
    }

    seq += 1;
    const entry = {
      id,
      seq,
      source: typeof input.source === 'string' && input.source.length > 0 ? input.source : 'loopback',
      sourceEpoch,
      audioStartAt,
      audioEndAt,
      text,
      status,
      recognition: typeof input.recognition === 'string' && input.recognition.length > 0
        ? input.recognition
        : 'asr',
      createdAt: current,
      updatedAt: current,
      finalAt: status === 'final' ? current : null,
      rev: 1,
    };
    byId.set(id, entry);
    entries.push(entry);
    entries.sort((a, b) => a.audioStartAt - b.audioStartAt || a.seq - b.seq);
    stats.added += 1;
    prune(current);
    event('media.timeline.added', {
      id, status, chars: entry.text.length, audioStartAt, audioEndAt, sourceEpoch,
    });
    return { ...entry };
  }

  /** 命中 `[from, to]` 的台词（按音频区间相交），按开始时间升序。 */
  function between(from, to, { sourceEpoch = null } = {}) {
    const start = finiteTime(from);
    const end = finiteTime(to);
    if (start === null || end === null || end < start) return [];
    return entries
      .filter((entry) => entry.audioEndAt >= start && entry.audioStartAt <= end
        && (sourceEpoch === null || entry.sourceEpoch === normalizeEpoch(sourceEpoch)))
      .map((entry) => ({ ...entry }));
  }

  /** 离 `at` 最近的一段（优先包含该时刻的片段，其次距离最近的）。 */
  function nearest(at) {
    const point = finiteTime(at);
    if (point === null || entries.length === 0) return null;
    const containing = entries.filter((entry) => entry.audioStartAt <= point && entry.audioEndAt >= point);
    const pool = containing.length > 0 ? containing : entries;
    let best = null;
    let bestDistance = Infinity;
    for (const entry of pool) {
      const distance = point < entry.audioStartAt ? entry.audioStartAt - point : Math.max(0, point - entry.audioEndAt);
      if (distance < bestDistance) {
        best = entry;
        bestDistance = distance;
      }
    }
    return best === null ? null : { ...best };
  }

  function clear(reason = 'clear') {
    const count = entries.length;
    entries = [];
    byId.clear();
    event('media.timeline.cleared', { reason, entries: count });
    return { ok: true, entries: count };
  }

  function state() {
    const chars = entries.reduce((sum, entry) => sum + entry.text.length, 0);
    return {
      epoch,
      entries: entries.length,
      chars,
      finals: entries.filter((entry) => entry.status === 'final').length,
      oldestAt: entries.length === 0 ? null : entries[0].audioStartAt,
      newestAt: entries.length === 0 ? null : entries[entries.length - 1].audioEndAt,
      stats: { ...stats },
    };
  }

  return { upsert, between, nearest, setEpoch, clear, state };
}
