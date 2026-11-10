/**
 * P-187 同材料双探针 —— “图片到底有没有被读到 / JSON 链路是否正常”的手动诊断。
 *
 * 这一层只接受调用方已经缓存的帧（`frames()`），不截图、不读全局 ctx、不创建真实定时器。
 * 它**不**参与连续理解，也不会被自动触发：只有显式调用 `run()`（宿主侧是 `vision.probe`
 * action）才会发出两次独立的模型请求。
 *
 * 两次请求刻意分开、分别记账：
 *
 *   A. content —— 要求模型说出图中“特有、可核对”的内容，证明图片真的进入请求；
 *   B. json    —— 同一帧、同一模型，要求输出最小结构 JSON，只证明格式链路正常。
 *
 * B 失败（`bad-json` / `bad-shape` / provider 错误）只记在 `json` 分支，绝不能反推成
 * “模型不支持视觉”。只有 A 自己返回 `no-image-support` 时才把整体原因写成该码。
 *
 * 安全边界：
 *
 *   - 每张结果只保存“受限 head/tail 摘要”（默认总计 ≤800 字符），完整正文不进入 `status()`；
 *   - 结果默认保留 5 分钟，读取时惰性过期，`clear()` 立即清空；
 *   - 手动请求受单在途与最短间隔约束，失败也会进入冷却，不能用来无限烧请求；
 *   - meta 只保留白名单机器字段，provider/model 拒绝空白/路径形状，正文里不复制路径。
 */

/** 手动探针预算；宿主可以收紧间隔/TTL，但不会突破模块内的硬上限。 */
export const VISION_PROBE_DEFAULTS = Object.freeze({
  /** 两次手动双探针之间的最短间隔。 */
  minIntervalMs: 60_000,
  /** 结果摘要的默认保留时间。 */
  ttlMs: 5 * 60_000,
  /** 单次探针最多使用几张缓存帧；同材料对照固定一张。 */
  maxFrames: 1,
  /** 每条摘要 head + tail 的字符预算。 */
  maxSummaryChars: 800,
});

/** 硬上限：任何调用方传入更大的值也不会放大诊断正文的驻留量。 */
const HARD_MAX_SUMMARY_CHARS = 2_000;
const HARD_MAX_TTL_MS = 10 * 60_000;
const HARD_MAX_INTERVAL_MS = 10 * 60_000;

const MAX_CODE_CHARS = 64;
const MAX_ROUTE_CHARS = 80;
const MAX_BLOCK_TYPES = 8;
const MAX_BLOCK_TYPE_CHARS = 32;
const MACHINE_CODE = /^[A-Za-z0-9_.:-]+$/u;
const ROUTE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/u;
const BLOCK_TYPE = /^[A-Za-z][A-Za-z0-9_./-]*$/u;

/**
 * 两次请求的固定提示词。它们与连续理解提示词完全分离：不读取 understanding-prompt，
 * 也不把这里的措辞带回连续理解。A 要求“特有内容”，B 要求最小 JSON。
 */
export const VISION_PROBE_PROMPTS = Object.freeze({
  content: Object.freeze({
    system: '你是视觉输入诊断器。只依据这次请求附带的图片回答，不要使用历史对话，也不要猜测。',
    user: '这是一次同材料诊断。请说出这张图片里 3 个以上“特有、可核对”的具体内容（例如特定文字、数字、窗口标题、界面控件、物品或布局关系），用简短列表回答。不要只写“一个电脑屏幕”“一个人”这类泛泛描述。如果图片无法辨认，只回答“无法辨认”。',
  }),
  json: Object.freeze({
    system: '你是结构化输出诊断器。只输出一个 JSON 对象，不要 Markdown 代码围栏，不要解释。',
    user: '看这张图片，只输出最小 JSON：{"visible": true 或 false, "summary": "不超过 20 字", "confidence": 0 到 1 的小数}。不要输出其他字段。',
  }),
});

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}

/** 路由标识：拒绝空白、反斜杠和控制字符；过长一律留空。 */
function safeRoute(value) {
  const text = nonEmptyString(value);
  if (text.length === 0 || text.length > MAX_ROUTE_CHARS) return '';
  return ROUTE_ID.test(text) ? text : '';
}

/** 机器码：只保留短码，正文/路径永远不进入 meta。 */
function safeCode(value) {
  if (typeof value !== 'string') return '';
  const code = value.trim();
  if (code.length === 0 || code.length > MAX_CODE_CHARS) return '';
  return MACHINE_CODE.test(code) ? code : '';
}

/** 非负整数计数；非法/缺省退回 fallback（默认 0，仍保证字段存在）。 */
function safeCount(value, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return Math.max(0, Math.floor(Number(fallback) || 0));
  return Math.floor(number);
}

function optionalCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : null;
}

function safeBlockTypes(value) {
  if (!Array.isArray(value)) return Object.freeze([]);
  const types = [];
  for (const entry of value) {
    if (types.length >= MAX_BLOCK_TYPES) break;
    if (typeof entry !== 'string') continue;
    const type = entry.trim();
    if (type.length === 0 || type.length > MAX_BLOCK_TYPE_CHARS) continue;
    if (!BLOCK_TYPE.test(type) || types.includes(type)) continue;
    types.push(type);
  }
  return Object.freeze(types);
}

function toLimit(value, fallback, hardMax) {
  const number = Number(value);
  const chosen = Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
  return Math.max(1, Math.min(hardMax, chosen));
}

function toDuration(value, fallback, hardMax) {
  const number = Number(value);
  const chosen = Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
  return Math.max(0, Math.min(hardMax, chosen));
}

/**
 * 把 image-analyzer 的 meta 归一成固定字段。所有键都会出现，方便调用方直接对照；
 * 不在白名单里的正文/路径不会复制。
 */
function normalizeMeta(meta, output, { text, elapsedMs, fallbackBudget }) {
  const source = isObject(meta) ? meta : {};
  const rawBudget = isObject(source.budget) ? source.budget : {};
  const fallback = isObject(fallbackBudget) ? fallbackBudget : {};
  return Object.freeze({
    provider: safeRoute(source.provider),
    model: safeRoute(source.model),
    imageCount: safeCount(source.imageCount, safeCount(output?.images)),
    contentBlockTypes: safeBlockTypes(source.contentBlockTypes),
    maxTokens: safeCount(source.maxTokens, safeCount(fallback.maxTokens)),
    textChars: safeCount(source.textChars, Array.from(typeof text === 'string' ? text : '').length),
    reasoningChars: safeCount(source.reasoningChars),
    finishKind: safeCode(source.finishKind),
    finishReason: safeCode(source.finishReason),
    errorCode: safeCode(source.errorCode) || safeCode(output?.errorCode),
    timedOut: source.timedOut === true,
    aborted: source.aborted === true,
    streamOpened: source.streamOpened === true,
    chunkCount: safeCount(source.chunkCount),
    durationMs: safeCount(source.durationMs, elapsedMs),
    budget: Object.freeze({
      maxImages: optionalCount(rawBudget.maxImages) ?? optionalCount(fallback.maxImages),
      maxTokens: optionalCount(rawBudget.maxTokens)
        ?? optionalCount(fallback.maxTokens)
        ?? optionalCount(source.maxTokens),
      timeoutMs: optionalCount(rawBudget.timeoutMs) ?? optionalCount(fallback.timeoutMs),
    }),
  });
}

/** 按码点截取 head + tail；两段合计不超过 limit。 */
function excerpt(value, limit) {
  const text = typeof value === 'string' ? value : '';
  const chars = Array.from(text);
  const max = Math.max(0, Math.floor(Number(limit) || 0));
  if (chars.length <= max) {
    return Object.freeze({
      head: text,
      tail: '',
      chars: chars.length,
      truncated: false,
    });
  }
  const headLength = Math.ceil(max / 2);
  const tailLength = max - headLength;
  return Object.freeze({
    head: chars.slice(0, headLength).join(''),
    tail: tailLength > 0 ? chars.slice(-tailLength).join('') : '',
    chars: chars.length,
    truncated: true,
  });
}

/**
 * B 分支的 JSON 判定。允许单一 Markdown 围栏（模型常见行为），但围栏内必须是可解析对象；
 * `parseOk` 证明语法，`shapeOk` 证明最小字段。两者分开记录，绝不把语法失败说成“不支持视觉”。
 */
function parseProbeJson(text) {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return { parseOk: false, shapeOk: false, reason: 'empty' };
  }
  let value = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(value);
  if (fenced !== null) value = fenced[1].trim();
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    return { parseOk: false, shapeOk: false, reason: 'bad-json' };
  }
  if (!isObject(parsed)) return { parseOk: false, shapeOk: false, reason: 'bad-json' };
  const shapeOk = typeof parsed.visible === 'boolean'
    && typeof parsed.summary === 'string'
    && (parsed.confidence === undefined
      || (typeof parsed.confidence === 'number'
        && Number.isFinite(parsed.confidence)
        && parsed.confidence >= 0
        && parsed.confidence <= 1));
  return { parseOk: true, shapeOk, reason: shapeOk ? 'ok' : 'bad-shape' };
}

/** 整体原因：B 的失败只产生 json-*；只有 A 自己声明 unsupported 才写 no-image-support。 */
function overallReason(content, json) {
  if (content.ok && json.ok) return 'ok';
  if (content.reason === 'no-image-support') return 'no-image-support';
  if (content.ok) {
    if (json.reason === 'bad-json' || json.reason === 'bad-shape') return 'json-invalid';
    return 'json-failed';
  }
  if (json.ok) return 'content-failed';
  return 'both-failed';
}

function selectFrames(frames, limit) {
  const source = Array.isArray(frames) ? frames : [];
  const selected = [];
  for (const frame of source) {
    if (selected.length >= limit) break;
    if (!isObject(frame)) continue;
    const file = nonEmptyString(frame.file);
    if (file.length === 0) continue;
    selected.push(frame);
  }
  return selected;
}

/**
 * @param {object} [options]
 * @param {(input: object) => Promise<object|string>|object|string} [options.analyze]
 *   真实 image-analyzer.analyze 或同形状测试替身；缺失时 run() 返回 `not-configured`。
 * @param {() => object[] | Promise<object[]>} [options.frames]
 *   只返回**已经缓存**的帧；探针绝不截图。帧只需 `file` 字段。
 * @param {() => boolean} [options.isBlocked] 隐私/卸载等外部门禁。
 * @param {() => number} [options.now]
 * @param {number} [options.minIntervalMs]
 * @param {number} [options.ttlMs]
 * @param {number} [options.maxFrames]
 * @param {number} [options.maxSummaryChars]
 * @param {object} [options.budget] 注入分析器未带 meta.budget 时的安全兜底。
 */
export function createVisionProbe(options = {}) {
  const source = isObject(options) ? options : {};
  const analyze = typeof source.analyze === 'function' ? source.analyze : null;
  const frames = typeof source.frames === 'function' ? source.frames : null;
  const isBlocked = typeof source.isBlocked === 'function' ? source.isBlocked : () => false;
  const nowSource = typeof source.now === 'function' ? source.now : Date.now;
  const fallbackBudget = isObject(source.budget) ? source.budget : null;

  const minIntervalMs = toDuration(
    source.minIntervalMs,
    VISION_PROBE_DEFAULTS.minIntervalMs,
    HARD_MAX_INTERVAL_MS,
  );
  const ttlMs = toDuration(source.ttlMs, VISION_PROBE_DEFAULTS.ttlMs, HARD_MAX_TTL_MS);
  const maxFrames = toLimit(source.maxFrames, VISION_PROBE_DEFAULTS.maxFrames, 8);
  const maxSummaryChars = toLimit(
    source.maxSummaryChars,
    VISION_PROBE_DEFAULTS.maxSummaryChars,
    HARD_MAX_SUMMARY_CHARS,
  );

  /** 最近一次完整结果（正文只留在内存，对外的 view 只给摘要）。 */
  let last = null;
  let lastExpired = false;
  let busy = false;
  let stopped = false;
  /** clear/stop 递增；在途结果即使晚到也不能跨过隐私/切源写回摘要。 */
  let generation = 0;
  let runs = 0;
  let failures = 0;
  let lastReason = '';
  let nextAllowedAt = 0;

  const clock = () => {
    try {
      const value = Number(nowSource());
      if (Number.isFinite(value) && value >= 0) return Math.floor(value);
    } catch {
      /* 时钟失败退回真实时间，不让诊断字段把探针弄崩 */
    }
    return Date.now();
  };

  function liveLast() {
    if (last === null) return null;
    if (clock() - last.at > ttlMs) {
      last = null;
      lastExpired = true;
      return null;
    }
    return last;
  }

  function blockedNow() {
    try {
      return isBlocked() === true;
    } catch {
      // 门禁本身出错按“被挡住”处理：宁可少请求，也不越权。
      return true;
    }
  }

  function staleOutcome() {
    return Object.freeze({
      ok: false,
      reason: stopped ? 'stopped' : 'stale',
      at: clock(),
      expiresAt: null,
      content: null,
      json: null,
    });
  }

  function publicProbe(entry) {
    return Object.freeze({
      ok: entry.ok === true,
      reason: entry.reason,
      parseOk: entry.parseOk === true,
      shapeOk: entry.shapeOk === true,
      meta: entry.meta,
      summary: excerpt(entry.text, maxSummaryChars),
    });
  }

  function publicView(entry) {
    return Object.freeze({
      ok: entry.ok === true,
      reason: entry.reason,
      at: entry.at,
      expiresAt: entry.expiresAt,
      content: publicProbe(entry.content),
      json: publicProbe(entry.json),
    });
  }

  function status() {
    const live = liveLast();
    const at = clock();
    return Object.freeze({
      running: busy,
      runs,
      failures,
      lastReason,
      lastAt: live === null ? null : live.at,
      expiresAt: live === null ? null : live.expiresAt,
      hasResult: live !== null,
      ttlMs,
      minIntervalMs,
      retryAt: nextAllowedAt > at ? nextAllowedAt : null,
      stopped,
      last: live === null
        ? null
        : Object.freeze({
          ok: live.ok,
          reason: live.reason,
          content: Object.freeze({
            ok: live.content.ok,
            reason: live.content.reason,
            meta: live.content.meta,
          }),
          json: Object.freeze({
            ok: live.json.ok,
            reason: live.json.reason,
            parseOk: live.json.parseOk,
            shapeOk: live.json.shapeOk,
            meta: live.json.meta,
          }),
        }),
    });
  }

  /** 一次独立请求；任何异常都收敛成机器原因，不抛给 action/调用方。 */
  async function requestOne(kind, frame) {
    const prompt = kind === 'content' ? VISION_PROBE_PROMPTS.content : VISION_PROBE_PROMPTS.json;
    const startedAt = clock();
    let output;
    try {
      output = await analyze({
        system: prompt.system,
        user: prompt.user,
        frames: [frame],
      });
    } catch {
      output = null;
    }
    const elapsedMs = Math.max(0, clock() - startedAt);
    if (typeof output === 'string') output = { ok: true, text: output };
    if (!isObject(output)) {
      return {
        ok: false,
        reason: 'analyze-error',
        text: '',
        meta: normalizeMeta(null, null, { text: '', elapsedMs, fallbackBudget }),
        parseOk: false,
        shapeOk: false,
      };
    }

    const text = typeof output.text === 'string' ? output.text : '';
    const meta = normalizeMeta(output.meta, output, { text, elapsedMs, fallbackBudget });
    if (output.ok !== true) {
      return {
        ok: false,
        reason: nonEmptyString(output.reason) || 'analyze-error',
        text,
        meta,
        parseOk: false,
        shapeOk: false,
      };
    }
    if (text.trim().length === 0) {
      return {
        ok: false,
        reason: 'empty',
        text,
        meta,
        parseOk: false,
        shapeOk: false,
      };
    }
    if (kind !== 'json') {
      return {
        ok: true,
        reason: 'ok',
        text,
        meta,
        parseOk: false,
        shapeOk: false,
      };
    }

    const parsed = parseProbeJson(text);
    return {
      ok: parsed.parseOk && parsed.shapeOk,
      reason: parsed.reason,
      text,
      meta,
      parseOk: parsed.parseOk,
      shapeOk: parsed.shapeOk,
    };
  }

  /**
   * 手动跑一次同材料双探针。永远 resolve；只有真正发出 model 请求时才占用冷却。
   */
  async function run() {
    const at = clock();
    if (stopped) {
      return Object.freeze({ ok: false, reason: 'stopped', at, expiresAt: null, content: null, json: null });
    }
    if (busy) {
      return Object.freeze({ ok: false, reason: 'in-flight', at, expiresAt: null, content: null, json: null });
    }
    if (blockedNow()) {
      lastReason = 'blocked';
      return Object.freeze({ ok: false, reason: 'blocked', at, expiresAt: null, content: null, json: null });
    }
    if (nextAllowedAt > at) {
      return Object.freeze({
        ok: false,
        reason: 'rate-limited',
        retryAt: nextAllowedAt,
        at,
        expiresAt: null,
        content: null,
        json: null,
      });
    }
    if (analyze === null) {
      lastReason = 'not-configured';
      return Object.freeze({ ok: false, reason: 'not-configured', at, expiresAt: null, content: null, json: null });
    }

    const runGeneration = generation;
    const isStale = () => stopped || runGeneration !== generation;
    // 先占单在途再读缓存：两次同步调用也不能都进入 await frames() 的缝隙。
    // 冷却只在真正准备发模型请求时写入；no-frames 不占用限速。
    busy = true;
    try {
      let cached = [];
      try {
        cached = frames === null ? [] : await frames();
      } catch {
        cached = [];
      }
      if (isStale()) return staleOutcome();
      const selected = selectFrames(cached, maxFrames);
      if (selected.length === 0) {
        lastReason = 'no-frames';
        return Object.freeze({ ok: false, reason: 'no-frames', at, expiresAt: null, content: null, json: null });
      }

      nextAllowedAt = at + minIntervalMs;
      const content = await requestOne('content', selected[0]);
      if (isStale()) return staleOutcome();
      const json = await requestOne('json', selected[0]);
      if (isStale()) return staleOutcome();
      const reason = overallReason(content, json);
      const completedAt = clock();
      const entry = {
        ok: reason === 'ok',
        reason,
        at: completedAt,
        expiresAt: completedAt + ttlMs,
        content,
        json,
      };
      last = entry;
      lastExpired = false;
      runs += 1;
      if (!entry.ok) failures += 1;
      lastReason = reason;
      return publicView(entry);
    } finally {
      busy = false;
    }
  }

  return {
    run,
    /** 读最近结果（含受限 head/tail）；过期后返回 expired/empty，绝不自动重跑。 */
    view() {
      const live = liveLast();
      if (live === null) {
        return Object.freeze({
          ok: false,
          reason: lastExpired ? 'expired' : 'empty',
          at: null,
          expiresAt: null,
          content: null,
          json: null,
        });
      }
      return publicView(live);
    },
    /** 只读机器状态；不返回正文，供 `/assistant/status` 投影。 */
    status,
    /** 用户清除：只清结果与摘要，不重置最短间隔（避免 clear+run 绕过限速）。 */
    clear() {
      generation += 1;
      last = null;
      lastExpired = false;
      lastReason = '';
      return { ...status(), ok: true, cleared: true };
    },
    stop() {
      stopped = true;
      generation += 1;
      last = null;
      lastExpired = false;
      lastReason = 'stopped';
    },
  };
}
