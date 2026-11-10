/**
 * P-187 阶段 5 补充 —— 主动候选的两阶段门禁（纯决策 + 本地回查）。
 *
 * 背景：宏观理解产出的候选只带“事件描述 + 证据 id + reaction”。真正开口前还差一步：
 * 这条宏观候选是否已经过时/重复/被用户先讨论，以及（只在需要时）本地事件索引里能不能
 * 找到仍可回看的原帧与台词。这里把这一段独立成纯模块：
 *
 *   - 第一阶段（local）：完全本地、零成本。过期、用户已评论、助手已回应、重复、用户
 *     正在说话/助手忙/待回复、quiet 未结束，任一命中都不进入第二阶段。
 *   - 第二阶段（detail）：只有宏观描述过短、确实需要更多画面/台词依据时才回查
 *     event-index（按理解层事件 id，其次按时间窗）。回查只读本地索引，
 *     不调用模型、不发请求；失败返回 `detail-*` 原因，调用方不得强行开口。
 *
 * 取舍：
 *   - 模块不建定时器、不读文件、不截图、不写记忆、不改仲裁器状态。
 *   - 候选必须带 `sourceEventId` 才可能需要细节：没有索引身份的旧调用方直接使用候选
 *     自己的证据，避免把“没有索引”误判成“细节不足”。
 *   - 复用 `event-index` 的 `get()`/`search()`；索引失败只返回机器原因码与候选自身
 *     证据，不含路径、正文日志或帧内容。
 */

export const PROACTIVE_DETAIL_DEFAULTS = Object.freeze({
  /** 宏观描述短于该码点数时，认为需要回查细节；更长的描述直接用候选证据。 */
  detailNeedChars: 28,
  /** 证据 id 上限（与仲裁器/事件索引同一量级，防止异常输入撑大）。 */
  maxEvidenceIds: 16,
  /** 已处理事件身份上限；候选寿命很短，256 足够覆盖重复分析窗口。 */
  maxSeenEvents: 256,
  /** 原因码长度上限。 */
  maxReasonChars: 64,
});

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeId(value) {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function clipText(value, limit) {
  if (typeof value !== 'string') return '';
  const chars = Array.from(value.trim());
  return chars.length <= limit ? value.trim() : chars.slice(0, limit).join('');
}

function reasonLabel(value, fallback) {
  const text = clipText(value, PROACTIVE_DETAIL_DEFAULTS.maxReasonChars);
  return text.length === 0 ? fallback : text;
}

function evidenceIdsOf(candidate) {
  const source = Array.isArray(candidate?.evidenceFrameIds) ? candidate.evidenceFrameIds : [];
  const ids = [];
  const seen = new Set();
  for (const entry of source) {
    const id = normalizeId(entry);
    if (id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length >= PROACTIVE_DETAIL_DEFAULTS.maxEvidenceIds) break;
  }
  return ids;
}

/** 候选自身已经有的证据：detail 不额外付费时的兜底返回。 */
function candidateEvidence(candidate) {
  return {
    source: 'candidate',
    eventId: normalizeId(candidate?.sourceEventId),
    frameIds: evidenceIdsOf(candidate),
    description: clipText(candidate?.description, 240),
    keyDialogue: '',
    startedAt: Number.isFinite(Number(candidate?.from)) ? Number(candidate.from) : null,
    endedAt: Number.isFinite(Number(candidate?.to)) ? Number(candidate.to) : null,
  };
}

/**
 * 是否需要第二阶段回查。
 *
 * 只有“带理解层事件 id + 有画面证据 + 描述很短”的候选才需要：这是宏观描述不足以
 * 支撑一句具体回应的典型情况。没有 `sourceEventId` 的旧调用方（例如测试 double）
 * 直接用候选自己的证据，不额外查询。
 */
export function needsProactiveDetail(candidate, options = {}) {
  if (!isObject(candidate)) return false;
  const sourceEventId = normalizeId(candidate.sourceEventId);
  if (sourceEventId.length === 0) return false;
  if (evidenceIdsOf(candidate).length === 0) return false;
  const threshold = Number.isFinite(Number(options.detailNeedChars))
    ? Math.max(0, Math.floor(Number(options.detailNeedChars)))
    : PROACTIVE_DETAIL_DEFAULTS.detailNeedChars;
  const description = typeof candidate.description === 'string' ? candidate.description.trim() : '';
  return Array.from(description).length < threshold;
}

function eventPublicEvidence(event) {
  if (!isObject(event)) return null;
  const frameIds = [];
  const seen = new Set();
  const source = Array.isArray(event.frameIds) ? event.frameIds : [];
  for (const entry of source) {
    const id = normalizeId(entry);
    if (id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    frameIds.push(id);
    if (frameIds.length >= PROACTIVE_DETAIL_DEFAULTS.maxEvidenceIds) break;
  }
  return {
    source: 'event-index',
    eventId: normalizeId(event.eventId),
    frameIds,
    description: clipText(event.description, 240),
    keyDialogue: clipText(event.keyDialogue, 120),
    startedAt: Number.isFinite(Number(event.startedAt)) ? Number(event.startedAt) : null,
    endedAt: Number.isFinite(Number(event.endedAt)) ? Number(event.endedAt) : null,
  };
}

/**
 * 第二阶段：本地回查细节。不调用模型、不截图、不发网络请求。
 *
 * @param {object} [input]
 * @param {object} [input.candidate] 仲裁器归一化后的候选。
 * @param {object} [input.eventIndex] `createEventIndex()`；缺失时返回 detail-unavailable。
 * @param {(frameIds: string[], candidate: object) => boolean} [input.evidenceAvailable]
 *   可选：原帧是否仍可回看；第二个参数是候选，供调用方按候选自身证据判断。
 * @param {number} [input.detailNeedChars] 覆盖“描述多短才需要细节”。
 * @returns {{ok:boolean, reason:string, stage:string, detailCalls:number, modelCalls:number,
 *   evidence?:object, candidateEvidence?:object}}
 */
export function resolveProactiveDetail(input = {}) {
  const source = isObject(input) ? input : {};
  const candidate = isObject(source.candidate) ? source.candidate : null;
  if (candidate === null) {
    return {
      ok: false,
      reason: 'detail-malformed',
      stage: 'detail',
      detailCalls: 0,
      modelCalls: 0,
    };
  }

  if (!needsProactiveDetail(candidate, source)) {
    return {
      ok: true,
      reason: 'detail-not-needed',
      stage: 'local',
      detailCalls: 0,
      modelCalls: 0,
      evidence: candidateEvidence(candidate),
    };
  }

  const index = source.eventIndex;
  const canGet = isObject(index) && typeof index.get === 'function';
  const canSearch = isObject(index) && typeof index.search === 'function';
  if (!canGet && !canSearch) {
    return {
      ok: false,
      reason: 'detail-unavailable',
      stage: 'detail',
      detailCalls: 1,
      modelCalls: 0,
      candidateEvidence: candidateEvidence(candidate),
    };
  }

  const sourceEventId = normalizeId(candidate.sourceEventId);
  let event = null;
  let searchReason = '';
  try {
    if (canGet && sourceEventId.length > 0) {
      event = index.get(sourceEventId);
    }
  } catch {
    event = null;
  }
  if (!isObject(event) && canSearch) {
    const candidateFrames = evidenceIdsOf(candidate);
    let result = null;
    try {
      // Do NOT fall back to timeOnly here. A different event in the same time window is not the
      // candidate's detail. The fallback must prove identity or share an original-frame id.
      result = index.search({
        frameIds: candidateFrames,
        limit: 4,
      });
    } catch {
      result = null;
    }
    if (isObject(result)) {
      searchReason = typeof result.reason === 'string' ? result.reason : '';
      if (Array.isArray(result.events) && result.events.length > 0) {
        const frameSet = new Set(candidateFrames);
        event = result.events.find((entry) => isObject(entry)
          && (normalizeId(entry.eventId) === sourceEventId
            || (Array.isArray(entry.frameIds) && entry.frameIds.some((id) => frameSet.has(id)))))
          ?? null;
      }
    }
  }

  if (!isObject(event)) {
    return {
      ok: false,
      reason: searchReason === 'no-index' ? 'detail-index-empty' : 'detail-event-missing',
      stage: 'detail',
      detailCalls: 1,
      modelCalls: 0,
      candidateEvidence: candidateEvidence(candidate),
    };
  }

  const evidence = eventPublicEvidence(event);
  if (evidence === null || evidence.frameIds.length === 0) {
    return {
      ok: false,
      reason: 'detail-no-evidence',
      stage: 'detail',
      detailCalls: 1,
      modelCalls: 0,
      candidateEvidence: candidateEvidence(candidate),
    };
  }
  if (typeof source.evidenceAvailable === 'function') {
    let available = false;
    try {
      // 第二个参数保留完整候选：故事板的 cells 展开后，细节帧 id 与候选自身证据 id
      // 可能不是同一层；调用方可以按候选证据作为“仍可回看”的最终口径。
      available = source.evidenceAvailable(evidence.frameIds, candidate) === true;
    } catch {
      available = false;
    }
    if (!available) {
      return {
        ok: false,
        reason: 'detail-evidence-expired',
        stage: 'detail',
        detailCalls: 1,
        modelCalls: 0,
        candidateEvidence: candidateEvidence(candidate),
      };
    }
  }

  return {
    ok: true,
    reason: 'detail-ok',
    stage: 'detail',
    detailCalls: 1,
    modelCalls: 0,
    evidence,
  };
}

/**
 * 创建一个两阶段门禁实例。
 *
 * @param {object} [options]
 * @param {Function|number} [options.now] 时钟；测试可注入固定值。
 * @param {object} [options.eventIndex] 本地宏观事件索引（第二阶段使用）。
 * @param {(frameIds: string[], candidate: object) => boolean} [options.evidenceAvailable]
 *   原帧回看检查；第二个参数是候选。
 * @param {(candidate: object, context: object) => object} [options.detail]
 *   完全替换第二阶段；默认调用 `resolveProactiveDetail()`。
 * @param {number} [options.detailNeedChars] 描述多短才需要细节。
 */
export function createProactiveTwoStageGate(options = {}) {
  const source = isObject(options) ? options : {};
  const clock = typeof source.now === 'function'
    ? source.now
    : (Number.isFinite(Number(source.now)) ? () => Number(source.now) : Date.now);
  const detail = typeof source.detail === 'function'
    ? source.detail
    : (candidate) => resolveProactiveDetail({
      candidate,
      eventIndex: source.eventIndex,
      evidenceAvailable: source.evidenceAvailable,
      detailNeedChars: source.detailNeedChars,
    });

  const seen = new Map();
  const stats = {
    considered: 0,
    localRejected: 0,
    detailCalls: 0,
    detailRejected: 0,
    passed: 0,
    modelCalls: 0,
  };

  function currentTime() {
    try {
      const value = Number(clock());
      return Number.isFinite(value) && value >= 0 ? value : Date.now();
    } catch {
      return Date.now();
    }
  }

  function identityOf(candidate) {
    const eventId = normalizeId(candidate?.eventId);
    if (eventId.length > 0) return eventId;
    return normalizeId(candidate?.id);
  }

  function remember(identity) {
    if (identity.length === 0) return;
    seen.delete(identity);
    seen.set(identity, currentTime());
    while (seen.size > PROACTIVE_DETAIL_DEFAULTS.maxSeenEvents) {
      seen.delete(seen.keys().next().value);
    }
  }

  function reject(stage, reason, extra = {}) {
    return {
      ok: false,
      stage,
      reason: reasonLabel(reason, 'rejected'),
      detailCalls: 0,
      modelCalls: 0,
      ...extra,
    };
  }

  return {
    /**
     * 先本地过滤，再按需回查细节。
     *
     * @param {object} candidate 仲裁器归一化后的候选。
     * @param {object} [context]
     * @param {number} [context.userCommentAt] 最近用户评论时刻。
     * @param {number} [context.assistantReplyAt] 最近助手回应时刻。
     * @param {boolean} [context.userSpeaking]
     * @param {boolean} [context.assistantBusy]
     * @param {boolean} [context.pendingReply]
     * @param {number|null} [context.quietUntil]
     * @returns {{ok:boolean, stage:string, reason:string, detailCalls:number, modelCalls:number}}
     */
    consider(candidate, context = {}) {
      stats.considered += 1;
      const at = currentTime();
      const state = isObject(context) ? context : {};
      if (!isObject(candidate)) return reject('local', 'malformed');

      // 只有显式数值 expiresAt 才参与本地过期判断；null/缺失留给仲裁器/复核层。
      const expiresAt = candidate.expiresAt === null || candidate.expiresAt === undefined
        ? NaN
        : Number(candidate.expiresAt);
      if (Number.isFinite(expiresAt) && at >= expiresAt) {
        stats.localRejected += 1;
        return reject('local', 'expired');
      }

      const identity = identityOf(candidate);
      if (identity.length === 0) return reject('local', 'malformed');

      const occurredAt = Number(candidate.occurredAt);
      const userCommentAt = Number(state.userCommentAt);
      if (Number.isFinite(occurredAt) && Number.isFinite(userCommentAt)
        && occurredAt < userCommentAt) {
        stats.localRejected += 1;
        return reject('local', 'user-commented', { passive: true, cancel: true });
      }
      const assistantReplyAt = Number(state.assistantReplyAt);
      if (Number.isFinite(occurredAt) && Number.isFinite(assistantReplyAt)
        && occurredAt < assistantReplyAt) {
        stats.localRejected += 1;
        return reject('local', 'assistant-replied', { passive: true });
      }
      if (seen.has(identity)) {
        stats.localRejected += 1;
        return reject('local', 'duplicate');
      }
      if (state.userSpeaking === true) {
        stats.localRejected += 1;
        return reject('local', 'user-speaking');
      }
      if (state.assistantBusy === true) {
        stats.localRejected += 1;
        return reject('local', 'assistant-busy');
      }
      if (state.pendingReply === true) {
        stats.localRejected += 1;
        return reject('local', 'pending-reply');
      }
      const quietUntil = Number(state.quietUntil);
      if (Number.isFinite(quietUntil) && at < quietUntil) {
        stats.localRejected += 1;
        return reject('local', 'quiet');
      }

      if (!needsProactiveDetail(candidate, source)) {
        remember(identity);
        stats.passed += 1;
        return {
          ok: true,
          stage: 'local',
          reason: 'local-sufficient',
          detailCalls: 0,
          modelCalls: 0,
          evidence: candidateEvidence(candidate),
        };
      }

      let result;
      try {
        result = detail(candidate, state);
      } catch {
        result = { ok: false, reason: 'detail-error' };
      }
      stats.detailCalls += 1;
      if (!isObject(result) || result.ok !== true) {
        stats.detailRejected += 1;
        return {
          ok: false,
          stage: 'detail',
          reason: reasonLabel(result?.reason, 'detail-missing'),
          detailCalls: 1,
          modelCalls: 0,
          candidateEvidence: candidateEvidence(candidate),
        };
      }
      remember(identity);
      stats.passed += 1;
      return {
        ok: true,
        stage: 'detail',
        reason: 'detail-ok',
        detailCalls: 1,
        modelCalls: 0,
        evidence: isObject(result.evidence) ? result.evidence : candidateEvidence(candidate),
      };
    },

    /** 只读诊断：计数全部有界，不含正文/路径/帧 id。 */
    status() {
      return {
        considered: stats.considered,
        localRejected: stats.localRejected,
        detailCalls: stats.detailCalls,
        detailRejected: stats.detailRejected,
        passed: stats.passed,
        modelCalls: 0,
        seen: seen.size,
      };
    },

    /** 代次边界：只清“已处理”集合；累计计数与仲裁器一样保留。 */
    reset() {
      seen.clear();
    },
  };
}
