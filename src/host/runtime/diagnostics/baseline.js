/**
 * P-47 基线快照构建器：构建 / 模型 / 请求协议 / TTS 的只读投影。
 *
 * 这是一个**纯函数**模块：不读文件、不发网络请求、不读时钟、不写事件、不启动 VTS/OBS。
 * 调用方（`tools/baseline-snapshot.mjs`）负责采集 `status`、`commit`、`env` 与时间，再交给
 * `buildBaselineSnapshot` 归一化。缺字段一律给 `null`（`input.cacheStatsAvailable` 例外，
 * 未知按 `false`），绝不猜测，也绝不把整份 status 透传出去。
 *
 * 输出固定形状（顺序稳定）：
 *
 *   {
 *     commit, version,
 *     model: { provider, id },
 *     protocol,
 *     reasoning: { requested, applied },
 *     input: { tokensAvailable, cacheStatsAvailable },
 *     tts: { backend, voice, weightsCold },
 *     versions: { electron, vts, obs, node, os },
 *     at,
 *   }
 *
 * 字段来源只接受**明确命名**的字段。例如 `status.fastpath.provider/model` 是闲聊快路
 * （辅助通道）的模型，不是本轮助手模型，因此这里刻意不读取它；`status.tts.gptSovits.
 * modelsDirty` 也不等于“权重冷”，只表示配置路径尚未应用，所以不拿它推断 `weightsCold`。
 *
 * 隐私边界：只复制白名单里的短标量。绝对路径、UNC 路径、邮箱、常见 token 前缀以及
 * 控制字符一律拒绝（置 `null`），对话正文、settings、事件正文从不进入输出。
 */

/** 单个标量的最大长度；超出即视为异常值，宁可置空也不截断成看似有效的数据。 */
const MAX_COMMIT = 64;
const MAX_VERSION = 80;
const MAX_PROVIDER = 80;
const MAX_MODEL_ID = 160;
const MAX_PROTOCOL = 80;
const MAX_EFFORT = 40;
const MAX_BACKEND = 40;
const MAX_VOICE = 160;

/** 常见的“未知”写法：不是观测值，归一化为 null。 */
const UNKNOWN_EFFORT = /^(?:unknown|unset|n\/a|not-observed)$/iu;

/** 绝对路径 / UNC / 以斜杠开头的字符串，一律不当作版本、协议或名称。 */
const ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/u;

/** URL（含 `file:///C:/...`）也不是基线标量。 */
const URL_LIKE = /^[a-z][a-z0-9+.-]*:\/\//iu;

/** 明显的凭据前缀；宁可丢掉一个字段，也不把 token 写进基线。 */
const TOKEN_PREFIX = /^(?:sk-|ghp_|gho_|ghu_|ghs_|ghr_|xox[baprs]-)/iu;

/** 只匹配“整串就是邮箱”的值；模型 id 里的 `@`（例如 Cloudflare 路由）不受影响。 */
const EMAIL_LIKE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

/** 控制字符与换行：基线字段是单行标量，出现即视为脏数据。 */
const CONTROL = /[\u0000-\u001f\u007f]/u;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 归一化一个短标量。
 *
 * - 非字符串、空串、超长、含控制字符、绝对/UNC 路径、URL、整串邮箱、明显 token → null；
 * - 反斜杠出现在任何位置都视为 Windows 路径（模型名与声音名不会含反斜杠）；
 * - 正向斜杠保留，`provider/model` 这类合法 id 不受影响。
 */
function scalar(value, max = 120) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text === '' || text.length > max) return null;
  if (CONTROL.test(text)) return null;
  if (ABSOLUTE_PATH.test(text) || URL_LIKE.test(text) || text.includes('\\')) return null;
  if (EMAIL_LIKE.test(text)) return null;
  if (TOKEN_PREFIX.test(text)) return null;
  if (/\b(?:bearer|api[_-]?key|access[_-]?token|authorization)\b\s*[:=]/iu.test(text)) return null;
  return text;
}

/** 布尔或 null；只接受真正的 boolean，`'true'` 这类字符串不猜。 */
function booleanOrNull(value) {
  return typeof value === 'boolean' ? value : null;
}

/** commit 只接受 7–64 位十六进制；统一小写，避免同一构建出现两种写法。 */
function normalizeCommit(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim().toLowerCase();
  return text.length <= MAX_COMMIT && /^[0-9a-f]{7,64}$/u.test(text) ? text : null;
}

/** 时间统一为 ISO 字符串；日期无效或缺失给 null，绝不读当前时钟。 */
function normalizeAt(value) {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  }
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text === '' || text.length > 64 || CONTROL.test(text)) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** 插件版本：status 的 `version` 是 `/assistant/status` 的权威字段。 */
function pluginVersion(status) {
  if (!isPlainObject(status)) return null;
  return scalar(status.version, MAX_VERSION) ?? scalar(status.pluginVersion, MAX_VERSION);
}

/**
 * 模型身份：显式参数优先，其次 `status.model`。
 * 只接受 `{ provider, id }`（兼容 `model` / `modelId` 两个既有命名），不解析字符串。
 */
function modelIdentity(status, explicit) {
  const fromStatus = isPlainObject(status?.model) ? status.model : null;
  const fromExplicit = isPlainObject(explicit) ? explicit : null;
  const pick = (key, alias, max) => {
    const value = fromExplicit?.[key] ?? fromExplicit?.[alias];
    if (value !== undefined) return scalar(value, max);
    return scalar(fromStatus?.[key] ?? fromStatus?.[alias], max);
  };
  return {
    provider: pick('provider', 'providerId', MAX_PROVIDER),
    id: pick('id', 'model', MAX_MODEL_ID),
  };
}

/**
 * 请求协议：只从 status 中明确叫 protocol 的字段读取。
 * 支持字符串，以及 `{ name }` / `{ id }` 这两种对象投影；其余形状一律 null。
 */
function requestProtocol(status) {
  if (!isPlainObject(status)) return null;
  const candidates = [
    status.protocol,
    status.requestProtocol,
    status.model?.protocol,
    status.inference?.protocol,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string') {
      const text = scalar(candidate, MAX_PROTOCOL);
      if (text !== null) return text;
      continue;
    }
    if (isPlainObject(candidate)) {
      const text = scalar(candidate.name, MAX_PROTOCOL) ?? scalar(candidate.id, MAX_PROTOCOL);
      if (text !== null) return text;
    }
  }
  return null;
}

/** `reasoning.requested/applied`：只接受短字符串；`unknown` 等占位值归一化为 null。 */
function reasoningState(status) {
  const fromStatus = isPlainObject(status?.reasoning) ? status.reasoning : null;
  const effort = (value) => {
    const text = scalar(value, MAX_EFFORT);
    return text === null || UNKNOWN_EFFORT.test(text) ? null : text;
  };
  return {
    requested: effort(fromStatus?.requested ?? status?.reasoningRequested),
    applied: effort(fromStatus?.applied ?? status?.reasoningApplied),
  };
}

/**
 * 输入侧可观测性。这里只回答“能不能拿到”，不报告任何 token 数。
 * `tokensAvailable` 未知为 null；`cacheStatsAvailable` 未知按 false（明确不可假设为可用）。
 */
function inputAvailability(status) {
  const fromStatus = isPlainObject(status?.input) ? status.input : null;
  const available = (key) => booleanOrNull(fromStatus?.[key]);
  return {
    tokensAvailable: available('tokensAvailable'),
    cacheStatsAvailable: available('cacheStatsAvailable') ?? false,
  };
}

/**
 * TTS 投影。
 *
 * - `backend`：显式值 → `status.tts.backend` → 由 `gptSovits.enabled` 推出的主机规则
 *   （true = gpt-sovits，false = edge-tts）。这是现有代码里的唯一选择规则，不是猜测。
 * - `voice`：只读明确的声音字段；**不读** `refAudioPath`，因为那是路径（且可能含用户目录）。
 * - `weightsCold`：只认明确字段。`modelsDirty` 只说明配置尚未应用，不能证明冷/热。
 */
function ttsState(status, explicit) {
  const fromExplicit = isPlainObject(explicit) ? explicit : null;
  const fromStatus = isPlainObject(status?.tts) ? status.tts : null;
  const gpt = isPlainObject(fromStatus?.gptSovits) ? fromStatus.gptSovits : null;
  const backend = scalar(fromExplicit?.backend, MAX_BACKEND)
    ?? scalar(fromStatus?.backend, MAX_BACKEND)
    ?? (gpt?.enabled === true ? 'gpt-sovits' : gpt?.enabled === false ? 'edge-tts' : null);
  return {
    backend,
    voice: scalar(fromExplicit?.voice, MAX_VOICE)
      ?? scalar(fromStatus?.voice, MAX_VOICE)
      ?? scalar(gpt?.voice, MAX_VOICE),
    weightsCold: booleanOrNull(fromExplicit?.weightsCold)
      ?? booleanOrNull(fromStatus?.weightsCold)
      ?? booleanOrNull(gpt?.weightsCold),
  };
}

/**
 * 版本矩阵：显式参数优先，其次 status 的明确字段，最后是调用方提供的环境事实。
 *
 * - Electron：Spout 子进程的 `versions.electron`（status 中已有真实值）。
 * - VTS：只认应用版本字段；不把 VTS 握手里的 `apiVersion` 当应用版本。
 * - OBS：status 未提供版本时保持 null；本模块不探测、不启动 OBS。
 * - Node / OS：用 CLI 的进程事实；Spout 子进程的 `versions.node` 是子进程内置 Node，
 *   不是宿主 Node，因此刻意不拿它冒充基线里的 `node`。
 */
function versionMatrix(status, env, explicit) {
  const fromStatus = isPlainObject(status?.versions) ? status.versions : null;
  const fromSpout = isPlainObject(status?.live2d?.spoutLayer?.versions)
    ? status.live2d.spoutLayer.versions
    : isPlainObject(status?.layer?.spout?.versions)
      ? status.layer.spout.versions
      : null;
  const fromEnv = isPlainObject(env) ? env : null;
  const fromExplicit = isPlainObject(explicit) ? explicit : null;
  const pick = (...values) => {
    for (const value of values) {
      const text = scalar(value, MAX_VERSION);
      if (text !== null) return text;
    }
    return null;
  };
  return {
    electron: pick(
      fromExplicit?.electron,
      fromStatus?.electron,
      fromSpout?.electron,
      fromEnv?.electron,
    ),
    vts: pick(
      fromExplicit?.vts,
      fromStatus?.vts,
      status?.vtsVersion,
      status?.live2d?.appVersion,
    ),
    obs: pick(
      fromExplicit?.obs,
      fromStatus?.obs,
      status?.obsVersion,
      status?.vision?.obsVersion,
      status?.autostart?.obs?.version,
    ),
    node: pick(
      fromExplicit?.node,
      fromStatus?.node,
      fromEnv?.node,
    ),
    os: pick(
      fromExplicit?.os,
      fromStatus?.os,
      fromEnv?.os,
    ),
  };
}

/**
 * 构建一条基线快照。
 *
 * @param {object} [options]
 * @param {string|null} [options.commit]   `git rev-parse HEAD` 或显式 commit；非十六进制置 null。
 * @param {object|null} [options.status]   `/assistant/status` 的 JSON 对象（只读）。
 * @param {object|null} [options.env]      CLI 环境事实 `{ electron, node, os }`。
 * @param {object|null} [options.versions] 显式版本覆盖 `{ electron, vts, obs, node, os }`。
 * @param {object|null} [options.model]    显式模型覆盖 `{ provider, id }`。
 * @param {object|null} [options.tts]      显式 TTS 覆盖 `{ backend, voice, weightsCold }`。
 * @param {string|Date|null} [options.at]  采集时间；缺失为 null（本函数不读时钟）。
 * @returns {{
 *   commit: string|null,
 *   version: string|null,
 *   model: { provider: string|null, id: string|null },
 *   protocol: string|null,
 *   reasoning: { requested: string|null, applied: string|null },
 *   input: { tokensAvailable: boolean|null, cacheStatsAvailable: boolean },
 *   tts: { backend: string|null, voice: string|null, weightsCold: boolean|null },
 *   versions: { electron: string|null, vts: string|null, obs: string|null, node: string|null, os: string|null },
 *   at: string|null,
 * }}
 */
export function buildBaselineSnapshot(options = {}) {
  const {
    commit = null,
    status = null,
    env = null,
    versions = null,
    model = null,
    tts = null,
    at = null,
  } = options ?? {};
  const safeStatus = isPlainObject(status) ? status : null;
  return {
    commit: normalizeCommit(commit),
    version: pluginVersion(safeStatus),
    model: modelIdentity(safeStatus, model),
    protocol: requestProtocol(safeStatus),
    reasoning: reasoningState(safeStatus),
    input: inputAvailability(safeStatus),
    tts: ttsState(safeStatus, tts),
    versions: versionMatrix(safeStatus, env, versions),
    at: normalizeAt(at),
  };
}
