/**
 * P-187 阶段 5 —— 主动回应仲裁（纯决策层）。
 *
 * 设计文档第十节只把“作品事件 -> 主动候选”作为输入，真正开口前还要过一遍时机与内容概率：
 * 候选未过期、证据仍在、用户没在说话、助手没有待完成回应、不在关键台词上；时机通过后，
 * 再按用户设置的“主动回应通过率”给每个独立候选一次抽签。不再有“每小时几句 / 间隔多少秒”
 * 的固定配额（仍可选覆盖）。第十一节又要求这些观察是短期、有界、可过期的，不能自动写进记忆。
 *
 * 因此本模块只做一件事：判断“现在这一步适不适合开口，如果要开口说哪一条”。
 *   - 不截图、不读文件、不调用模型、不建定时器、不写记忆、不创建对话、不改人设；
 *   - 不推断作品情绪，也不把作品情绪当成用户情绪；`angle` 只是原样保存的反应角度；
 *   - 所有时间都由调用方注入，模块内只比较数字，方便逐条测试。
 *
 * 取舍：
 *   - evaluate() 只读输入、不消费候选；真正开口后必须再调用 spoken() 记账。
 *   - spoken() 会移除同一事件的候选，并在 maxAgeMs 窗口内记住该事件，避免重复说出。
 *   - 候选过期就丢弃，不排队；淘汰/拒绝都只计数，不回报正文。
 *   - 通过率按候选身份只抽一次：抽中/未抽中都持久记录（有界），换措辞不重抽。
 *   - cancelAll() 只清待选池（可再次登记）；cancelFor() 才写取消集；reset() 是隐私/切源的
 *     代次边界，连取消集、抽签记录、最近主题与时机窗口一起清空，但保留累计计数。
 */

/** 默认值：不再有固定配额，只保留有效期、静默期与同时候选数；计时/频率仍可显式覆盖。 */
export const PROACTIVE_DEFAULTS = Object.freeze({
  /**
   * 未显式给出 expiresAt 时的候选有效期（事件发生到可开口）。
   * 显式 expiresAt 优先，且只按该时刻判断：后台理解可能耗时 20–40 秒，登记时事件 `to`
   * 早已超过本窗口，不能让它把刚登记的候选二次判死。
   */
  maxAgeMs: 8_000,
  /** 两次主动之间的最小间隔；0 = 不限制（可选覆盖）。 */
  minGapMs: 0,
  /** 每小时上限；null = 不限制（可选覆盖）。 */
  maxPerHour: null,
  /** 连续未被回应时进入的静默期。 */
  quietAfterIgnoredMs: 120_000,
  /** 同时保留的候选上限。 */
  maxCandidates: 4,
  /** 每个独立候选的通过概率（0–100，默认 100 = 必过）。 */
  rate: 100,
});

/** 每小时按滚动窗口计算，避免整点前后出现两次突发。 */
const HOUR_MS = 3_600_000;

/** status() 里的最近主题只留截断标签，不是候选正文。 */
const TOPIC_LABEL_MAX = 48;

/** 已取消事件 id 只保留近期一段；候选本身寿命很短，无需无限增长。 */
const CANCELED_ID_LIMIT = 256;

/** 通过率抽签结果按候选身份持久保存；有界，防止长会话无限增长。 */
const DRAW_ID_LIMIT = 256;

/** 发言时间只用于滚动一小时计数；硬上限防止异常时钟/重复记账把数组撑大。 */
const SPEAK_TIMES_LIMIT = 2_048;

/** 生命周期原因码只保留短机器码，避免外部文本（路径/正文）混进 status。 */
function reasonLabel(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const text = value.trim();
  if (text.length === 0) return fallback;
  return text.length > 64 ? text.slice(0, 64) : text;
}

/** 只接受有限数字或有限数字字符串；其它值（含 null / '' / 布尔）都算缺失。 */
function finiteNumber(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const text = typeof value === 'string' ? value.trim() : value;
  if (text === '') return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

/** 时间戳不能是负数；无效时返回 null，由调用方决定回退值。 */
function timestamp(value) {
  const number = finiteNumber(value);
  return number === null || number < 0 ? null : number;
}

/** 配置里的时长：有限且非负；非法时回退默认值。 */
function nonNegative(value, fallback) {
  const number = finiteNumber(value);
  return number === null || number < 0 ? fallback : number;
}

/** 可选的每小时上限：null/Infinity = 不限制；其它有限非负数取整；非法时回退。 */
function optionalLimit(value, fallback) {
  if (value === null || value === Infinity) return null;
  const number = finiteNumber(value);
  if (number === null || number < 0) return fallback;
  return Math.floor(number);
}

/** 通过率：只接受有限数字，夹到 0–100；非法时回退默认值。 */
function rateValue(value, fallback) {
  const number = finiteNumber(value);
  if (number === null) return fallback;
  return Math.min(100, Math.max(0, number));
}

/** 候选身份：显式 eventId 优先；否则回到 id。描述文本永远不参与身份。 */
function candidateIdentity(candidate) {
  return candidate.eventId.length > 0 ? candidate.eventId : candidate.id;
}

/** 候选 id / 证据 id / 取消事件 id 统一成去掉首尾空白的非空字符串。 */
function normalizeId(value) {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

/** 证据 id 列表：非数组视为空；坏项跳过；同 id 只保留一次。 */
function normalizeEvidence(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const ids = [];
  value.forEach((entry) => {
    const id = normalizeId(entry);
    if (id.length === 0 || seen.has(id)) return;
    seen.add(id);
    ids.push(id);
  });
  return ids;
}

/** 最近主题：id + 截断后的描述摘要，长度受限，不保留完整正文。 */
function summarizeTopic(id, description) {
  const raw = description.length > 0 ? `${id}: ${description}` : id;
  const chars = Array.from(raw);
  if (chars.length <= TOPIC_LABEL_MAX) return raw;
  return `${chars.slice(0, TOPIC_LABEL_MAX - 1).join('')}…`;
}

/**
 * 归一化一条候选。返回 { ok, candidate?, reason? } 而不是直接抛错：
 * 后台理解、序列化、来源切换都可能送来残缺项，一条坏候选不该拖垮整个仲裁器。
 */
function normalizeCandidate(input, at, config, canceled, spokenAt) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, reason: 'malformed' };
  }

  const id = normalizeId(input.id);
  if (id.length === 0) return { ok: false, reason: 'malformed' };

  // 身份优先用显式 eventId；没有 eventId 时用 id。描述文本不参与身份。
  const eventId = normalizeId(input.eventId);
  const identity = eventId.length > 0 ? eventId : id;

  if (typeof input.description !== 'string') return { ok: false, reason: 'malformed' };
  const description = input.description.trim();
  if (description.length === 0) return { ok: false, reason: 'malformed' };

  const to = timestamp(input.to);
  if (to === null) return { ok: false, reason: 'malformed' };

  // from 可以省略（视为一个点事件）；一旦给出就必须是合法且不晚于 to 的区间。
  let from = to;
  if (input.from !== undefined && input.from !== null) {
    const parsed = timestamp(input.from);
    if (parsed === null || parsed > to) return { ok: false, reason: 'malformed' };
    from = parsed;
  }

  const evidenceFrameIds = normalizeEvidence(input.evidenceFrameIds);
  const evidenceAudioIds = normalizeEvidence(input.evidenceAudioIds);
  // 证据约束：没有画面也没有音频依据，就只是一句猜测，不能进入主动链。
  if (evidenceFrameIds.length === 0 && evidenceAudioIds.length === 0) {
    return { ok: false, reason: 'malformed' };
  }

  let expiresAt = null;
  if (input.expiresAt !== undefined && input.expiresAt !== null) {
    const parsed = timestamp(input.expiresAt);
    if (parsed === null) return { ok: false, reason: 'malformed' };
    expiresAt = parsed;
  }

  // 有效期语义（两者互斥）：
  //   - 有显式 expiresAt：只按该时刻判断（到点即失效，不留半拍），不再用事件 `to` 的年龄
  //     二次拒绝。理解分析可能耗时 20–40 秒，登记时 `to` 往往早已超过 maxAgeMs，若仍按
  //     `at - to` 判死，候选会一登记就 expired，主动回应永远进不了评估。
  //   - 没有显式 expiresAt：保持原规则，按事件 `to` 的年龄丢弃，错过就放弃、不积压成解说队列。
  if (expiresAt !== null) {
    if (at >= expiresAt) return { ok: false, reason: 'expired' };
  } else if (at - to > config.maxAgeMs) {
    return { ok: false, reason: 'expired' };
  }

  // 用户先评论了同一事件：取消后即使再次送来也不恢复主动。
  if (canceled.has(id) || canceled.has(identity)) return { ok: false, reason: 'canceled' };

  // 重复抑制：同一事件刚说过的 maxAgeMs 内不再接受，避免后台重复理解带来重复开口。
  const spokenAtTime = spokenAt.get(identity);
  if (spokenAtTime !== undefined && at - spokenAtTime <= config.maxAgeMs) {
    return { ok: false, reason: 'duplicate' };
  }

  const priority = finiteNumber(input.priority);
  const angle = typeof input.angle === 'string' ? input.angle.trim() : '';

  return {
    ok: true,
    candidate: Object.freeze({
      id,
      eventId,
      from,
      to,
      description,
      evidenceFrameIds: Object.freeze(evidenceFrameIds),
      evidenceAudioIds: Object.freeze(evidenceAudioIds),
      angle,
      expiresAt,
      priority: priority === null ? 0 : priority,
    }),
  };
}

/**
 * 生成短句返回后、真正开口前的最后一次纯校验。
 *
 * evaluate() 发生在模型调用之前，而一次短句生成可能持续数秒：期间用户可能关闭主动回应、
 * 取消候选（例如先评论了同一画面）、开始说话，或出现待回复任务。生成结束后必须按“同一条候选”
 * 重新确认全部条件；这里不重新挑选候选，也不消费/修改仲裁器状态。
 *
 * @param {object} [input]
 * @param {string} [input.candidateId] 生成前选中的候选 id。
 * @param {string[]} [input.pendingIds] `proactive.pendingIds()` 的当前结果。
 * @param {boolean} [input.enabled] `proactiveEnabled()` 的当前值。
 * @param {number} [input.generation] 当前的 `proactiveGeneration`。
 * @param {number} [input.expectedGeneration] 生成开始前记录的代次。
 * @param {boolean} [input.aborted] 在途生成是否已被取消。
 * @param {boolean} [input.runtimeActive] 宿主是否仍在运行（`false` = 已卸载/关闭）。
 * @param {boolean} [input.userSpeaking] 用户是否仍在说话（`speechEvidence !== null`）。
 * @param {boolean} [input.assistantBusy] TTS 正在播放或有播放会话。
 * @param {boolean} [input.pendingReply] 是否有已接受/在途的正式回答。
 * @param {boolean} [input.spoken] 该候选是否已经记账为已说（正常路径不会同时待选）。
 * @returns {{ok: boolean, reason: string}} 只返回机器原因码，不含候选正文。
 */
export function revalidateProactiveCandidate(input = {}) {
  const state = input !== null && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const fail = (reason) => ({ ok: false, reason });

  if (state.runtimeActive === false) return fail('disposed');
  if (state.enabled !== true) return fail('disabled');
  if (state.generation !== state.expectedGeneration) return fail('generation-changed');

  const id = normalizeId(state.candidateId);
  const pendingIds = Array.isArray(state.pendingIds) ? state.pendingIds.map(normalizeId) : [];
  const stillPending = id.length > 0 && pendingIds.includes(id);
  // 已取消与已说都会让候选离开待选池；spoken 优先给出更精确的原因。
  if (state.spoken === true) return fail('spoken');
  if (!stillPending) return fail('candidate-missing');
  // 取消信号本身不是候选池变化：放在“候选是否仍待选”之后，先让已移除的候选报告真实原因。
  if (state.aborted === true) return fail('aborted');

  if (state.userSpeaking === true) return fail('user-speaking');
  if (state.assistantBusy === true) return fail('assistant-busy');
  if (state.pendingReply === true) return fail('pending-reply');
  return { ok: true, reason: 'ok' };
}

/**
 * 创建一个主动回应仲裁器。
 *
 * @param {object} [options]
 * @param {Function|number} [options.now] 时钟：默认 Date.now；测试可注入固定值。
 * @param {Function} [options.draw] 通过率随机源：默认 Math.random；测试可注入固定值。
 * @param {object} [options.defaults] 覆盖 PROACTIVE_DEFAULTS 中的部分或全部参数。
 */
export function createProactiveArbiter(options = {}) {
  const opts = options !== null && typeof options === 'object' && !Array.isArray(options)
    ? options
    : {};

  const base = PROACTIVE_DEFAULTS;
  const source = opts.defaults !== null && typeof opts.defaults === 'object' && !Array.isArray(opts.defaults)
    ? opts.defaults
    : {};
  const config = {
    maxAgeMs: nonNegative(source.maxAgeMs, base.maxAgeMs),
    minGapMs: nonNegative(source.minGapMs, base.minGapMs),
    maxPerHour: optionalLimit(source.maxPerHour, base.maxPerHour),
    quietAfterIgnoredMs: nonNegative(source.quietAfterIgnoredMs, base.quietAfterIgnoredMs),
    maxCandidates: Math.max(1, Math.floor(nonNegative(source.maxCandidates, base.maxCandidates))),
    rate: rateValue(source.rate, base.rate),
  };

  const clock = typeof opts.now === 'function'
    ? opts.now
    : (timestamp(opts.now) !== null ? () => opts.now : Date.now);

  // 通过率抽签的随机源：默认 Math.random；测试可注入固定序列。
  const draw = typeof opts.draw === 'function' ? opts.draw : Math.random;

  function currentTime() {
    try {
      const value = clock();
      const number = timestamp(value);
      return number === null ? Date.now() : number;
    } catch {
      // 时钟被外部替换成会抛错的函数时也不能让仲裁器崩掉。
      return Date.now();
    }
  }

  /** 抽一次随机数；坏值/抛错按 0 处理，绝不让随机源拖垮仲裁器。 */
  function drawOnce() {
    try {
      const value = Number(draw());
      if (!Number.isFinite(value)) return 0;
      return Math.min(1, Math.max(0, value));
    } catch {
      return 0;
    }
  }

  /** 候选本身的有效性：未过期、未被取消、不在“刚说过”的重复窗口里。 */
  function isUsable(candidate, at) {
    // 与 normalizeCandidate 同一有效期语义：显式 expiresAt 只按该时刻判断；没有时才看 `to`
    // 的年龄。evaluate/pendingIds/prune 都经过这里，否则会出现“propose 成功但评估时又被
    // to 年龄丢掉”的半修复状态。
    if (candidate.expiresAt !== null) {
      if (at >= candidate.expiresAt) return false;
    } else if (at - candidate.to > config.maxAgeMs) {
      return false;
    }
    if (canceled.has(candidate.id) || canceled.has(candidateIdentity(candidate))) return false;
    const spokenAtTime = spokenAt.get(candidateIdentity(candidate));
    if (spokenAtTime !== undefined && at - spokenAtTime <= config.maxAgeMs) return false;
    return true;
  }

  /** 取优先级最高者；同优先级取 to 更晚者；再同则取更晚登记的一条。 */
  function selectCandidate(at) {
    let chosen = null;
    candidates.forEach((candidate, index) => {
      if (!isUsable(candidate, at)) return;
      if (chosen === null) {
        chosen = { candidate, index };
        return;
      }
      const better = candidate.priority > chosen.candidate.priority
        || (candidate.priority === chosen.candidate.priority
          && (candidate.to > chosen.candidate.to
            || (candidate.to === chosen.candidate.to && index > chosen.index)));
      if (better) chosen = { candidate, index };
    });
    return chosen === null ? null : chosen.candidate;
  }

  /** 只保留近期发言时间，滚动窗口用于每小时上限。 */
  function recentSpeakCount(at) {
    return speakTimes.filter((time) => at - time < HOUR_MS).length;
  }

  /** 清理过期候选与过期“刚说过”记录；只动内部状态，不涉及输入。 */
  function prune(now) {
    for (let i = candidates.length - 1; i >= 0; i -= 1) {
      if (!isUsable(candidates[i], now)) candidates.splice(i, 1);
    }
    for (const [id, time] of spokenAt) {
      if (now - time > config.maxAgeMs) spokenAt.delete(id);
    }
  }

  /** 读每轮 settings：只认明确的 false / 合法数值；畸形字段逐个忽略。 */
  function resolveSettings(settings) {
    const resolved = {
      enabled: true,
      maxPerHour: config.maxPerHour,
      minGapMs: config.minGapMs,
      rate: config.rate,
    };
    if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
      return resolved;
    }
    if (settings.enabled === false) resolved.enabled = false;
    // null / Infinity 是“显式不限制”，不能被当成非法值回退成默认上限。
    if (settings.maxPerHour === null || settings.maxPerHour === Infinity) {
      resolved.maxPerHour = null;
    } else {
      const maxPerHour = finiteNumber(settings.maxPerHour);
      if (maxPerHour !== null && maxPerHour >= 0) resolved.maxPerHour = Math.floor(maxPerHour);
    }
    const minGapMs = finiteNumber(settings.minGapMs);
    if (minGapMs !== null && minGapMs >= 0) resolved.minGapMs = minGapMs;
    const rate = finiteNumber(settings.rate);
    if (rate !== null) resolved.rate = Math.min(100, Math.max(0, rate));
    return resolved;
  }

  /** 记录一次抽签结果；超过上限先丢最旧的身份。 */
  function rememberDraw(identity, passed) {
    draws.delete(identity);
    draws.set(identity, passed);
    while (draws.size > DRAW_ID_LIMIT) {
      const oldest = draws.keys().next().value;
      draws.delete(oldest);
    }
  }

  /**
   * 通过率判定：每个独立候选身份只判定一次，结果持久记录。
   * 0 = 直接不开口；100 = 直接必过；中间值才调用一次注入的随机源。
   * 已记录的身份不重抽——即使同一事件换了措辞、id 或描述。
   */
  function decideRate(candidate, rate) {
    const identity = candidateIdentity(candidate);
    if (rate <= 0) {
      if (!draws.has(identity)) {
        rememberDraw(identity, false);
        drawn += 1;
      }
      return { pass: false, reason: 'rate-zero' };
    }
    const recorded = draws.get(identity);
    if (recorded !== undefined) return { pass: recorded, reason: recorded ? 'rate-hit' : 'rate-miss' };

    const pass = rate >= 100 ? true : drawOnce() * 100 < rate;
    rememberDraw(identity, pass);
    drawn += 1;
    if (pass) passed += 1;
    return { pass, reason: pass ? 'rate-hit' : 'rate-miss' };
  }

  // ---- 内部状态 -----------------------------------------------------------
  const candidates = [];
  const canceled = new Map();
  const spokenAt = new Map();
  const draws = new Map();
  const speakTimes = [];
  let proposed = 0;
  let rejected = 0;
  let expired = 0;
  let evicted = 0;
  let duplicate = 0;
  let canceledCandidates = 0;
  let spokenCount = 0;
  let ignoredCount = 0;
  let drawn = 0;
  let passed = 0;
  let consecutiveIgnored = 0;
  let lastSpokenAt = null;
  let quietUntil = null;
  let lastRate = config.rate;
  let lastTopic = null;
  let lastReason = null;

  return {
    /**
     * 登记一个主动候选。
     * @returns 归一化候选（冻结对象），证据缺失/过期/畸形/已取消/重复时返回 null。
     */
    propose(input) {
      const at = currentTime();
      prune(at);

      const result = normalizeCandidate(input, at, config, canceled, spokenAt);
      if (!result.ok) {
        rejected += 1;
        if (result.reason === 'expired') expired += 1;
        if (result.reason === 'duplicate') duplicate += 1;
        return null;
      }

      const candidate = result.candidate;
      // 同身份（eventId 优先，否则 id）去重：后到的版本替换旧版本，并视为最新登记；
      // 同一事件换措辞不会变成两条候选，也不会多一次抽签。
      const identity = candidateIdentity(candidate);
      const existing = candidates.findIndex((entry) => candidateIdentity(entry) === identity);
      if (existing >= 0) candidates.splice(existing, 1);
      candidates.push(candidate);
      proposed += 1;

      // 最多保留 maxCandidates 条：新的进来，旧的淘汰并计数。
      while (candidates.length > config.maxCandidates) {
        candidates.shift();
        evicted += 1;
      }
      return candidate;
    },

    /**
     * 判断现在是否适合开口；不消费候选，但会按候选身份记录一次通过率抽签。
     *
     * 顺序固定：先看开关与时机（用户说话/助手忙/待回复/关键台词/too-soon/可选小时上限）；
     * 任何时机抑制都直接返回，不选候选、不抽签。时机通过后才做候选有效性选择与通过率判定。
     * 成功时 reason 为 'rate-hit'，candidate 为本次应说的那一条；概率未过为 'rate-miss'，
     * 通过率为 0 时为 'rate-zero'，被时机抑制时 candidate 为 null。
     */
    evaluate(input = {}) {
      const at = currentTime();
      const state = input !== null && typeof input === 'object' && !Array.isArray(input) ? input : {};
      const settings = resolveSettings(state.settings);
      lastRate = settings.rate;
      lastReason = null;

      if (!settings.enabled) {
        lastReason = 'disabled';
        return { speak: false, candidate: null, reason: 'disabled', suppressed: ['disabled'] };
      }

      const suppressed = [];
      if (state.userSpeaking) suppressed.push('user-speaking');
      if (state.assistantBusy) suppressed.push('assistant-busy');
      if (state.pendingReply) suppressed.push('pending-reply');
      if (state.keyDialogue) suppressed.push('key-dialogue');

      // quiet 期还没结束，或距上次开口不足（连续 ignored 时按倍数放大），都算 too-soon。
      // minGapMs 默认 0：只有显式覆盖成非零值时，这个间隔才生效。
      const quiet = quietUntil !== null && at < quietUntil;
      const lastGap = lastSpokenAt === null ? null : at - lastSpokenAt;
      const tooSoon = quiet || (lastGap !== null && settings.minGapMs > 0
        && lastGap < settings.minGapMs * (consecutiveIgnored > 0 ? consecutiveIgnored + 1 : 1));
      if (tooSoon) suppressed.push('too-soon');

      // maxPerHour 默认 null：不限制；只有显式设置数字时才检查滚动窗口。
      if (settings.maxPerHour !== null && recentSpeakCount(at) >= settings.maxPerHour) {
        suppressed.push('hourly-limit');
      }

      // 时机失败不抽签：先返回，不选候选、不消耗任何随机性/身份记录。
      if (suppressed.length > 0) {
        const reason = suppressed[0];
        lastReason = reason;
        return { speak: false, candidate: null, reason, suppressed };
      }

      const candidate = selectCandidate(at);
      if (candidate === null) {
        lastReason = 'no-candidate';
        return { speak: false, candidate: null, reason: 'no-candidate', suppressed: ['no-candidate'] };
      }

      const decision = decideRate(candidate, settings.rate);
      lastReason = decision.reason;
      if (!decision.pass) {
        return {
          speak: false,
          candidate: null,
          reason: decision.reason,
          suppressed: [decision.reason],
        };
      }
      return {
        speak: true,
        candidate,
        reason: decision.reason,
        suppressed: [],
      };
    },

    /**
     * 开口成功后记账：最近发言时间、最近主题、计数、频率窗口。
     * @param {object} candidate evaluate 返回的候选（至少要有 id）
     * @param {{ now?: number }} [options] 显式指定开口时刻
     * @returns {boolean} 是否记录了一条有效候选
     */
    spoken(candidate, options = {}) {
      if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
        return false;
      }
      const id = normalizeId(candidate.id);
      if (id.length === 0) return false;
      // 重复抑制按身份记账：同一事件换 id/描述后仍然算“说过”。
      const eventId = normalizeId(candidate.eventId);
      const identity = eventId.length > 0 ? eventId : id;

      const at = timestamp(options !== null && typeof options === 'object' ? options.now : null)
        ?? currentTime();

      prune(at);
      lastSpokenAt = at;
      speakTimes.push(at);
      // 从后往前删，既清掉一小时前的记录，也不依赖数组始终按时间递增。
      for (let i = speakTimes.length - 1; i >= 0; i -= 1) {
        if (at - speakTimes[i] >= HOUR_MS) speakTimes.splice(i, 1);
      }
      if (speakTimes.length > SPEAK_TIMES_LIMIT) {
        speakTimes.splice(0, speakTimes.length - SPEAK_TIMES_LIMIT);
      }

      const description = typeof candidate.description === 'string'
        ? candidate.description.trim()
        : '';
      lastTopic = { id, label: summarizeTopic(id, description) };
      spokenAt.set(identity, at);
      spokenCount += 1;

      // 同一事件已经说过：从待选池移除，防止紧接着再次被选中。
      for (let i = candidates.length - 1; i >= 0; i -= 1) {
        if (candidateIdentity(candidates[i]) === identity) candidates.splice(i, 1);
      }

      consecutiveIgnored = 0;
      quietUntil = null;
      lastReason = 'spoken';
      return true;
    },

    /**
     * 用户先评论了同一事件：取消这些主动候选，转入被动讨论。
     * 取消是持久的（有界保留），之后同 id / 同 eventId 再送来也不会恢复。
     * @returns {number} 本次移除的候选数
     */
    cancelFor(eventIds) {
      const values = Array.isArray(eventIds) ? eventIds : [eventIds];
      const at = currentTime();
      let removed = 0;
      const rememberCanceled = (cancelId) => {
        // 重新取消时刷新顺序，超过上限先丢掉最旧的取消记录。
        canceled.delete(cancelId);
        canceled.set(cancelId, at);
        while (canceled.size > CANCELED_ID_LIMIT) {
          const oldest = canceled.keys().next().value;
          canceled.delete(oldest);
        }
      };
      values.forEach((value) => {
        const id = normalizeId(value);
        if (id.length === 0) return;
        rememberCanceled(id);
        for (let i = candidates.length - 1; i >= 0; i -= 1) {
          const identity = candidateIdentity(candidates[i]);
          if (candidates[i].id !== id && identity !== id) continue;
          // 按任意一个 id 取消时，把事件身份也记进取消集，换 id 的同一事件不会复活。
          if (identity !== id) rememberCanceled(identity);
          candidates.splice(i, 1);
          removed += 1;
        }
      });
      canceledCandidates += removed;
      return removed;
    },

    /**
     * 整体取消当前候选（隐私/切源/用户先评论/卸载）。
     *
     * 与 cancelFor 的区别：不把任何 id 写进取消集，所以下一次事件仍可正常登记；只清空当前
     * 待选池、累计“取消”计数，并让 status().lastReason 记录原因。频率/静默窗口不因此重置。
     *
     * @param {string} [reason] 机器原因码；畸形/空值回退为 'cancel-all'。
     * @returns {number} 本次清掉的候选数
     */
    cancelAll(reason = 'cancel-all') {
      const removed = candidates.length;
      candidates.length = 0;
      canceledCandidates += removed;
      lastReason = reasonLabel(reason, 'cancel-all');
      return removed;
    },

    /**
     * 代次边界（隐私/切源/卸载）：清空候选、取消集、抽签记录、最近主题与所有时机窗口。
     *
     * 取舍：累计计数（proposed/rejected/expired/evicted/duplicate/canceled/spoken/ignored）
     * **保留**，因为它们描述的是这个仲裁器实例的整个生命周期，清理窗口不应让诊断数字归零；
     * `ignoredCount` 本身是累计值，也保留，但连续 ignored、quiet 截止和最近发言时间会清空，
     * 让新代次从“没有历史反压”的状态重新开始。取消集清空意味着旧代次的事件 id 不再被永久
     * 拒绝——代次已经换了，旧事件本就不该再送进来。
     *
     * @param {string} [reason] 机器原因码；畸形/空值回退为 'reset'。
     * @returns {number} 本次清掉的候选数
     */
    reset(reason = 'reset') {
      const removed = candidates.length;
      candidates.length = 0;
      canceled.clear();
      spokenAt.clear();
      draws.clear();
      speakTimes.length = 0;
      lastSpokenAt = null;
      consecutiveIgnored = 0;
      quietUntil = null;
      lastTopic = null;
      lastReason = reasonLabel(reason, 'reset');
      return removed;
    },

    /**
     * 当前有效候选 id 的只读副本（新数组；调用方增删/排序不影响内部状态）。
     * 与 status().valid 同一口径：已过期、已取消、刚说过的候选不在结果里。
     */
    pendingIds() {
      const at = currentTime();
      return candidates
        .filter((candidate) => isUsable(candidate, at))
        .map((candidate) => candidate.id);
    },

    /** 用户没有回应上一次主动：降低频率并进入 quiet 期。 */
    ignored() {
      ignoredCount += 1;
      consecutiveIgnored += 1;
      quietUntil = currentTime() + config.quietAfterIgnoredMs;
      lastReason = 'ignored';
    },

    /** 计数 / 最近时间 / 最近原因；不含候选描述正文，lastTopic 只是截断标签。 */
    status() {
      const at = currentTime();
      const valid = candidates.reduce((count, candidate) => (isUsable(candidate, at) ? count + 1 : count), 0);
      return {
        pending: candidates.length,
        valid,
        // 只读诊断：最近一次 evaluate 的通过率，以及按身份记录的抽签计数。
        // drawn = 已记录结果的候选身份数（含 0/100 的确定性结果）；passed = 其中通过数。
        rate: lastRate,
        drawn,
        passed,
        counts: {
          proposed,
          rejected,
          expired,
          evicted,
          duplicate,
          canceled: canceledCandidates,
          spoken: spokenCount,
          ignored: ignoredCount,
        },
        canceledEvents: canceled.size,
        spokenLastHour: recentSpeakCount(at),
        consecutiveIgnored,
        quietUntil,
        lastSpokenAt,
        lastTopicId: lastTopic === null ? null : lastTopic.id,
        lastTopic: lastTopic === null ? null : lastTopic.label,
        lastReason,
      };
    },
  };
}
