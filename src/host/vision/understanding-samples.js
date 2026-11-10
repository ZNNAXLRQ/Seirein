/**
 * P-187 诊断补丁 —— 有界失败样本。
 *
 * 目标：`empty` / `bad-json` 这类失败不再只有一句机器原因，而是能在本地看到“这一次真实请求
 * 长什么样”。样本只服务本地诊断，**不是**理解结果、不进入被动注入、不进入 status/事件正文。
 *
 * 四条边界：
 *
 *   1. 最多 3 条，环形保留最新；读取时顺手清掉过期项，不依赖后台定时器；
 *   2. 每条正文只留 head + tail，UTF-8 合计不超过 2KB；不复制截图、帧对象、文件路径；
 *   3. 默认保留 10 分钟，之后自动过期；本模块只存在内存里，不写盘；
 *   4. `meta` 只接受 image-analyzer 的机器字段白名单，正文/路径/异常 message 一律不进来。
 *
 * 调用方（understanding-runtime）只在失败分支调用 `record()`；隐私/关闭时调用 `clear()`。
 */

/** 失败样本默认预算；对调用方也可以更小，但不会被放大到这些硬上限之外。 */
export const UNDERSTANDING_SAMPLES_DEFAULTS = Object.freeze({
  maxEntries: 3,
  ttlMs: 10 * 60_000,
  maxBodyBytes: 2 * 1024,
});

/** 硬上限：即使调用方传更大的值，也不能突破“最多 3 条 / 每条 2KB”。 */
const HARD_MAX_ENTRIES = 3;
const HARD_MAX_BODY_BYTES = 2 * 1024;
/** 机器码/原因标签上限，与 understanding-runtime 保持一致。 */
const MAX_CODE_CHARS = 80;
const MACHINE_CODE = /^[A-Za-z0-9_.:-]+$/u;
/** provider/model 是路由标识，允许常见分隔符，但拒绝空格、反斜杠和控制字符。 */
const ROUTE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/u;
const MAX_ROUTE_CHARS = 80;
const MAX_BLOCK_TYPES = 8;
const MAX_BLOCK_TYPE_CHARS = 32;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 正数上限；非法值退回默认值。 */
function toLimit(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.max(1, Math.floor(number));
}

/** 原因/错误码：只留短机器码，避免正文或路径混入样本。 */
function safeCode(value, maxChars = MAX_CODE_CHARS) {
  if (typeof value !== 'string') return '';
  const code = value.trim();
  if (code.length === 0 || code.length > maxChars) return '';
  return MACHINE_CODE.test(code) ? code : '';
}

/** 路由标识：比机器码多允许 `/`、`@`、`+`，仍然拒绝空白与反斜杠。 */
function safeRoute(value) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  if (text.length === 0 || text.length > MAX_ROUTE_CHARS) return '';
  return ROUTE_ID.test(text) ? text : '';
}

function safeCount(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  return Math.floor(number);
}

/**
 * 只保留已知机器字段。缺省字段不补空值，避免把“没有这个信息”伪装成一个具体的 0/空串；
 * 调用方拿到的是可安全进入 status/样本的副本。
 */
export function sanitizeDiagnosticMeta(value) {
  if (!isObject(value)) return null;
  const output = {};

  for (const key of ['provider', 'model']) {
    const raw = value[key];
    if (typeof raw !== 'string') continue;
    const route = safeRoute(raw);
    if (route.length > 0) output[key] = route;
    // 空串表示“这个请求确实没有路由”；非法/过长文本仍然丢弃。
    else if (raw.trim().length === 0) output[key] = '';
  }

  const imageCount = safeCount(value.imageCount);
  if (imageCount !== null) output.imageCount = imageCount;
  const maxTokens = safeCount(value.maxTokens);
  if (maxTokens !== null) output.maxTokens = maxTokens;
  const textChars = safeCount(value.textChars);
  if (textChars !== null) output.textChars = textChars;
  const reasoningChars = safeCount(value.reasoningChars);
  if (reasoningChars !== null) output.reasoningChars = reasoningChars;
  const chunkCount = safeCount(value.chunkCount);
  if (chunkCount !== null) output.chunkCount = chunkCount;
  const durationMs = safeCount(value.durationMs);
  if (durationMs !== null) output.durationMs = durationMs;

  if (Array.isArray(value.contentBlockTypes)) {
    const types = [];
    for (const entry of value.contentBlockTypes) {
      if (types.length >= MAX_BLOCK_TYPES) break;
      if (typeof entry !== 'string') continue;
      const type = entry.trim();
      if (type.length === 0 || type.length > MAX_BLOCK_TYPE_CHARS) continue;
      if (!/^[A-Za-z][A-Za-z0-9_./-]*$/u.test(type)) continue;
      if (!types.includes(type)) types.push(type);
    }
    if (types.length > 0) output.contentBlockTypes = Object.freeze(types);
  }

  for (const key of ['finishKind', 'finishReason', 'errorCode']) {
    const raw = value[key];
    if (typeof raw !== 'string') continue;
    const code = safeCode(raw);
    if (code.length > 0) output[key] = code;
    // 空串是“这一项确实为空”的合法机器值（例如成功请求的 errorCode）；
    // 非法/过长文本仍然丢弃，不把正文伪装成空串。
    else if (raw.trim().length === 0) output[key] = '';
  }
  for (const key of ['timedOut', 'aborted', 'streamOpened']) {
    if (typeof value[key] === 'boolean') output[key] = value[key];
  }

  return Object.keys(output).length > 0 ? Object.freeze(output) : null;
}

/**
 * 路径脱敏：样本允许模型正文，但绝不希望把截图路径一起带进诊断。
 * 只处理 Windows 盘符路径与 UNC；替换成固定 `[path]`，不保留任何路径片段。
 */
function redactPaths(text) {
  return text
    .replace(/[A-Za-z]:\\[^\s"'<>|]*/gu, '[path]')
    .replace(/\\\\[^\\\s"'<>|]+\\[^\s"'<>|]*/gu, '[path]');
}

/** 按 UTF-8 字节从头部截取，不劈开代理对/多字节字符。 */
function takeHead(text, maxBytes) {
  let output = '';
  let bytes = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char, 'utf8');
    if (bytes + size > maxBytes) break;
    output += char;
    bytes += size;
  }
  return { text: output, bytes };
}

/** 按 UTF-8 字节从尾部截取，不劈开代理对/多字节字符；不复制整个字符串数组。 */
function takeTail(text, maxBytes) {
  let output = '';
  let bytes = 0;
  let end = text.length;
  while (end > 0) {
    // 从后往前找到完整码点：低代理项必须连同前面的高代理项一起取。
    let start = end - 1;
    const code = text.charCodeAt(start);
    if (code >= 0xDC00 && code <= 0xDFFF && start > 0) {
      const high = text.charCodeAt(start - 1);
      if (high >= 0xD800 && high <= 0xDBFF) start -= 1;
    }
    const char = text.slice(start, end);
    const size = Buffer.byteLength(char, 'utf8');
    if (bytes + size > maxBytes) break;
    output = char + output;
    bytes += size;
    end = start;
  }
  return { text: output, bytes };
}

/**
 * 把一次正文裁成 head + tail。短正文整段放进 head，tail 为空；长正文按预算对半分，
 * 两段 UTF-8 字节数之和严格不超过 `maxBodyBytes`。
 */
function excerpt(text, maxBodyBytes) {
  const source = typeof text === 'string' ? text : '';
  const totalBytes = Buffer.byteLength(source, 'utf8');
  if (totalBytes <= maxBodyBytes) {
    return {
      head: source,
      tail: '',
      headBytes: totalBytes,
      tailBytes: 0,
      bodyBytes: totalBytes,
      truncated: false,
    };
  }
  const headBudget = Math.ceil(maxBodyBytes / 2);
  const tailBudget = maxBodyBytes - headBudget;
  const head = takeHead(source, headBudget);
  const tail = takeTail(source, tailBudget);
  return {
    head: head.text,
    tail: tail.text,
    headBytes: head.bytes,
    tailBytes: tail.bytes,
    bodyBytes: head.bytes + tail.bytes,
    truncated: true,
  };
}

function cloneMeta(meta) {
  if (!isObject(meta)) return null;
  const copy = {};
  for (const [key, value] of Object.entries(meta)) {
    copy[key] = Array.isArray(value) ? value.slice() : value;
  }
  return Object.freeze(copy);
}

/**
 * 创建有界失败样本存储。
 *
 * @param {object} [options]
 * @param {() => number} [options.now] 可注入假时钟。
 * @param {number} [options.maxEntries] 最多条数；硬上限 3。
 * @param {number} [options.ttlMs] 保留时长；默认 10 分钟。
 * @param {number} [options.maxBodyBytes] 每条 head+tail 的 UTF-8 预算；硬上限 2KB。
 * @returns {{record: Function, list: Function, count: Function, clear: Function, status: Function}}
 */
export function createUnderstandingSamples({
  now = Date.now,
  maxEntries,
  ttlMs,
  maxBodyBytes,
} = {}) {
  const capacity = Math.min(HARD_MAX_ENTRIES, toLimit(maxEntries, UNDERSTANDING_SAMPLES_DEFAULTS.maxEntries));
  const ttl = toLimit(ttlMs, UNDERSTANDING_SAMPLES_DEFAULTS.ttlMs);
  const bodyBudget = Math.min(
    HARD_MAX_BODY_BYTES,
    toLimit(maxBodyBytes, UNDERSTANDING_SAMPLES_DEFAULTS.maxBodyBytes),
  );
  const entries = [];

  const clock = () => {
    try {
      const value = Number(now());
      if (Number.isFinite(value) && value >= 0) return Math.floor(value);
    } catch {
      /* 时钟失败退回真实时间，不让诊断存储把运行时代崩 */
    }
    return Date.now();
  };

  function purge() {
    const at = clock();
    while (entries.length > 0 && at - entries[0].at > ttl) entries.shift();
    while (entries.length > capacity) entries.shift();
  }

  function publicEntry(entry) {
    return Object.freeze({
      at: entry.at,
      expiresAt: entry.at + ttl,
      reason: entry.reason,
      errorCode: entry.errorCode,
      meta: cloneMeta(entry.meta),
      head: entry.head,
      tail: entry.tail,
      headBytes: entry.headBytes,
      tailBytes: entry.tailBytes,
      bodyBytes: entry.bodyBytes,
      truncated: entry.truncated,
      redacted: entry.redacted,
    });
  }

  return {
    /**
     * 记录一条失败样本。`text` 是可选的模型原始输出/解析失败原文；只留 head+tail。
     * 不接收帧对象、路径或截图，调用方也不应该把 `meta` 之外的请求对象塞进来。
     */
    record({ reason, errorCode, meta, text, at } = {}) {
      purge();
      // 调用方可以给一个已经取好的时刻（与 status.lastAt 对齐）；缺省才读时钟。
      const explicitAt = Number(at);
      const recordedAt = Number.isFinite(explicitAt) && explicitAt >= 0
        ? Math.floor(explicitAt)
        : clock();
      const redactedText = redactPaths(typeof text === 'string' ? text : '');
      const body = excerpt(redactedText, bodyBudget);
      const entry = {
        at: recordedAt,
        reason: safeCode(reason) || 'error',
        errorCode: safeCode(errorCode),
        meta: sanitizeDiagnosticMeta(meta),
        head: body.head,
        tail: body.tail,
        headBytes: body.headBytes,
        tailBytes: body.tailBytes,
        bodyBytes: body.bodyBytes,
        truncated: body.truncated,
        redacted: redactedText !== (typeof text === 'string' ? text : ''),
      };
      entries.push(entry);
      while (entries.length > capacity) entries.shift();
      return publicEntry(entry);
    },

    /** 读取样本副本；读取时清除过期项。正文只在这里按需返回，不进 status/事件。 */
    list() {
      purge();
      return entries.map(publicEntry);
    },

    /** 只读计数；status 用它，不返回任何正文。 */
    count() {
      purge();
      return entries.length;
    },

    /** 隐私/关闭时清空；句柄保留，之后仍可继续记录。 */
    clear() {
      entries.length = 0;
    },

    /** 只读边界信息，便于诊断测试确认硬上限。 */
    status() {
      purge();
      return {
        count: entries.length,
        maxEntries: capacity,
        ttlMs: ttl,
        maxBodyBytes: bodyBudget,
      };
    },
  };
}
