/**
 * P-187 阶段 6：视听证据的只读数字投影。
 *
 * 把已经存在的证据窗口、媒体台词、评论证据、后台理解和主动候选状态汇总成可评估的数字，
 * 供 `/assistant/status` 与诊断脚本使用。本模块是纯函数：不读文件、不发网络请求、不写日志、
 * 不抛错；输出只包含白名单里的计数/布尔/速率字段，绝不携带场景正文、事件描述、文件路径
 * 或证据帧 id。
 */

/** 安全整数的上界；异常大的计数不应把 JSON 数字变成 Infinity。 */
const MAX_SAFE_COUNT = Number.MAX_SAFE_INTEGER;

/**
 * 只接受真实数字：缺失、字符串、NaN、Infinity、负数都按 0 处理。
 * 小数为防御性输入向下取整（计数只能是整数），避免下游按“条”统计时出现 1.5。
 */
function toCount(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Math.floor(value), MAX_SAFE_COUNT);
}

/** 缺失/畸形布尔一律按 false；只有明确的 true 才算开启。 */
function toBoolean(value) {
  return value === true;
}

/**
 * 可选时间戳：只有有限正数才保留，否则 null。
 * 不给 `at` 时投影保持纯函数，速率只依赖调用方传入的 `uptimeMs`。
 */
function toTimestamp(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return value;
}

/** 对象字段的安全读取：null、数组、原始值都当作“没有这个对象”。 */
function toObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

/**
 * 第一次出现的“有效数字”字段：兼容现有状态形状的多种嵌套方式。
 * 只有 `typeof number` 才算命中，避免 `0` 被 `||` 误判；两者都缺失时返回 0。
 */
function pickCount(primary, fallback) {
  if (typeof primary === 'number') return toCount(primary);
  return toCount(fallback);
}

/**
 * 单位时间速率。`uptimeMs` 无效/<=0 时无法定义窗口，返回 null 而不是 0。
 * 取舍：
 *   - 每分钟理解调用量通常很小（常在 0~5 之间），保留 1 位小数；
 *   - 每小时主动开口量通常更大，直接四舍五入为整数，读数更稳。
 * 两者的分母不同（60_000 / 3_600_000），但都要求 uptime 为宿主挂载至今的毫秒数。
 */
function ratePer(total, uptimeMs, unitMs, { decimals = 0 } = {}) {
  if (typeof uptimeMs !== 'number' || !Number.isFinite(uptimeMs) || uptimeMs <= 0) return null;
  const rate = total / (uptimeMs / unitMs);
  if (!Number.isFinite(rate)) return null;
  const factor = 10 ** decimals;
  return Math.round(rate * factor) / factor;
}

/**
 * @param {object} [input]
 * @param {object} [input.evidence] `evidenceWindow.state()`：frames/bytes/pinnedFrames。
 * @param {object} [input.media] `mediaTimeline.state()`：entries/chars/finals。
 * @param {object} [input.comment] `commentEvidence.state()`：sessions/attached/expired。
 * @param {object} [input.understanding] `understandingStatusView()`：runs/failures/
 *   droppedEvents/state.{events,sceneChars,hasState}，也兼容顶层 eventCount/sceneChars/hasState。
 * @param {object} [input.proactive] `proactive.status()`（可再带 enabled）：pending、
 *   counts.{spoken,ignored}（兼容顶层 spoken/ignored）、quietUntil。
 * @param {number|null} [input.uptimeMs] 宿主从 apply 挂载到现在的毫秒数；缺失/<=0 时 rates 为 null。
 * @param {number|null} [input.at] 可选观察时间；不传则输出 `at: null`，保持纯函数。
 * @returns {{
 *   at: number|null,
 *   cache: { frames: number, bytes: number, pinnedFrames: number },
 *   media: { entries: number, chars: number, finals: number },
 *   comment: { sessions: number, attached: number, expired: number },
 *   understanding: {
 *     runs: number, failures: number, droppedEvents: number,
 *     eventCount: number, sceneChars: number, hasState: boolean,
 *   },
 *   proactive: {
 *     enabled: boolean, pending: number, spoken: number, ignored: number, quiet: boolean,
 *   },
 *   rates: { understandingPerMinute: number|null, proactivePerHour: number|null },
 * }}
 */
export function summarizeAudiovisual({
  evidence,
  media,
  comment,
  understanding,
  proactive,
  uptimeMs = null,
  at = null,
} = {}) {
  const cacheSource = toObject(evidence);
  const mediaSource = toObject(media);
  const commentSource = toObject(comment);
  const understandingSource = toObject(understanding);
  const understandingState = toObject(understandingSource.state);
  const proactiveSource = toObject(proactive);
  const proactiveCounts = toObject(proactiveSource.counts);

  const cache = {
    frames: toCount(cacheSource.frames),
    bytes: toCount(cacheSource.bytes),
    pinnedFrames: toCount(cacheSource.pinnedFrames),
  };

  const mediaView = {
    entries: toCount(mediaSource.entries),
    chars: toCount(mediaSource.chars),
    finals: toCount(mediaSource.finals),
  };

  const commentView = {
    sessions: toCount(commentSource.sessions),
    attached: toCount(commentSource.attached),
    expired: toCount(commentSource.expired),
  };

  const understandingView = {
    runs: toCount(understandingSource.runs),
    failures: toCount(understandingSource.failures),
    droppedEvents: toCount(understandingSource.droppedEvents),
    // 现有理解状态把“事件数”放在 state.events；兼容直接给 eventCount 的调用方。
    eventCount: pickCount(understandingState.events, understandingSource.eventCount),
    sceneChars: pickCount(understandingState.sceneChars, understandingSource.sceneChars),
    // 现有运行时把 hasState 放在顶层；旧形状/测试也可放在 state.hasState。
    hasState: toBoolean(understandingSource.hasState) || toBoolean(understandingState.hasState),
  };

  const spoken = pickCount(proactiveCounts.spoken, proactiveSource.spoken);
  const ignored = pickCount(proactiveCounts.ignored, proactiveSource.ignored);
  // quietUntil 是现有 status 字段；没给 `at` 时只能判断“是否已排定静默窗”。
  // 给了 `at` 就判断此刻是否仍在窗内，避免把已经结束的静默误报为当前静默。
  const quietUntil = proactiveSource.quietUntil;
  let quiet = false;
  if (typeof proactiveSource.quiet === 'boolean') {
    quiet = proactiveSource.quiet;
  } else if (typeof quietUntil === 'number' && Number.isFinite(quietUntil) && quietUntil > 0) {
    const observedAt = toTimestamp(at);
    quiet = observedAt === null ? true : quietUntil > observedAt;
  }

  return {
    at: toTimestamp(at),
    cache,
    media: mediaView,
    comment: commentView,
    understanding: understandingView,
    proactive: {
      enabled: toBoolean(proactiveSource.enabled),
      pending: toCount(proactiveSource.pending),
      spoken,
      ignored,
      quiet,
    },
    rates: {
      understandingPerMinute: ratePer(understandingView.runs, uptimeMs, 60_000, { decimals: 1 }),
      proactivePerHour: ratePer(spoken, uptimeMs, 3_600_000, { decimals: 0 }),
    },
  };
}
