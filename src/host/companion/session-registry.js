/**
 * 文字陪伴（typed companion）显式登记表。
 *
 * 归属规则不再用“没有 coding 标记”反推陪伴：普通文字会话只有被用户明确登记到
 * `settings.companion.typedSessions` 之后，才可以接收画面理解/评论证据。编码、子代理、
 * 后台/压缩/摘要等用途由宿主在判断身份时优先排除——即使 id 出现在登记表里也不会成为陪伴。
 *
 * 这里只负责持久化与校验，不判断 agent 用途，也不读取任何会话内容：
 *   - `companion.typedEnabled` 默认 true，只控制已登记会话的文字能力，关闭不取消登记；
 *   - `companion.typedSessions` 是去重、有界（默认 32）的 session/agent id 数组，最近登记的
 *     排在最前；超出上限时丢弃最旧的；
 *   - 非法 id（空串、超长、含控制字符）不会写入，读取时也会被丢弃。
 *
 * 设置文件由宿主作为唯一写者传入（`writeSettings({ companion: ... })`），本模块不碰磁盘。
 */

/** 有界登记表的上限。一个用户日常不会同时使用几十个文字陪伴会话。 */
export const COMPANION_TYPED_SESSION_LIMIT = 32;
/** 单个 session/agent id 的合理上限；超长值拒绝写入，读取时丢弃。 */
export const COMPANION_TYPED_SESSION_ID_MAX = 256;
/** 默认开关：缺失/非法值都按开启处理，只有显式 false 关闭。 */
export const COMPANION_TYPED_ENABLED_DEFAULT = true;

const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/u;

/** 只接受可安全持久化的 id 文本：去首尾空白、非空、有界、无控制字符。 */
export function normalizeTypedSessionId(value) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  if (text.length === 0 || text.length > COMPANION_TYPED_SESSION_ID_MAX) return '';
  if (CONTROL_CHAR_RE.test(text)) return '';
  return text;
}

/** 读取整份 settings 里的 `companion` 对象；畸形值视为空对象。 */
function companionSettingsOf(settings) {
  const value = settings !== null && typeof settings === 'object' && !Array.isArray(settings)
    ? settings.companion
    : null;
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/**
 * 归一化登记数组：只保留合法字符串、去重、保序，并按上限截断。
 * 读取时也走这里，所以旧文件里的空串/重复/超长值不会让界面出现幽灵条目。
 */
export function normalizeTypedSessions(value, limit = COMPANION_TYPED_SESSION_LIMIT) {
  const cap = Number.isFinite(limit) && limit > 0
    ? Math.max(1, Math.floor(limit))
    : COMPANION_TYPED_SESSION_LIMIT;
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const entry of value) {
    const id = normalizeTypedSessionId(entry);
    if (id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= cap) break;
  }
  return out;
}

/** 整份 settings 里的开关；缺失/非法值按默认 true（历史行为），显式 false 才关闭。 */
export function typedEnabledOf(settings) {
  const value = companionSettingsOf(settings).typedEnabled;
  return typeof value === 'boolean' ? value : COMPANION_TYPED_ENABLED_DEFAULT;
}

/** 整份 settings 里的已登记 id 数组。 */
export function typedSessionsOf(settings, limit = COMPANION_TYPED_SESSION_LIMIT) {
  return normalizeTypedSessions(companionSettingsOf(settings).typedSessions, limit);
}

/**
 * 建立登记表读写接口。`readSettings`/`writeSettings` 由宿主提供；所有写操作合并保留
 * `companion` 下的其它字段，不覆盖整个 settings。
 *
 * @param {{
 *   readSettings: () => object,
 *   writeSettings: (patch: object) => void,
 *   limit?: number,
 * }} options
 */
export function createCompanionSessionRegistry({
  readSettings,
  writeSettings,
  limit = COMPANION_TYPED_SESSION_LIMIT,
} = {}) {
  if (typeof readSettings !== 'function' || typeof writeSettings !== 'function') {
    throw new TypeError('companion session registry requires readSettings/writeSettings');
  }
  const cap = Number.isFinite(limit) && limit > 0
    ? Math.max(1, Math.floor(limit))
    : COMPANION_TYPED_SESSION_LIMIT;

  const settingsOf = () => {
    try {
      return readSettings() ?? {};
    } catch {
      return {};
    }
  };
  const storedCompanion = () => companionSettingsOf(settingsOf());
  const list = () => typedSessionsOf(settingsOf(), cap);
  const typedEnabled = () => typedEnabledOf(settingsOf());
  /** 写回只合并 `companion`，保留同一对象下的其它字段与整份 settings。 */
  const persist = (next) => {
    writeSettings({ companion: { ...storedCompanion(), ...next } });
  };
  const status = () => {
    const typedSessions = list();
    return {
      typedEnabled: typedEnabled(),
      typedSessions,
      registered: typedSessions.length,
      limit: cap,
    };
  };

  const isRegistered = (value) => {
    const id = normalizeTypedSessionId(value);
    return id.length > 0 && list().includes(id);
  };

  /**
   * 显式登记一个会话/agent id。重复登记会把它移到最前（最近使用），超限丢弃最旧。
   * 返回 `{ ok, sessionId, ...status }`；非法 id 返回 `{ ok:false, error }`，不写盘。
   */
  const register = (value) => {
    const id = normalizeTypedSessionId(value);
    if (id.length === 0) {
      return { ok: false, error: '会话 ID 不能为空，且必须是 256 字符以内的普通文本' };
    }
    const next = [id, ...list().filter((entry) => entry !== id)].slice(0, cap);
    persist({ typedSessions: next });
    return { ok: true, sessionId: id, ...status() };
  };

  /** 移除登记；未登记时也返回 ok，`removed` 如实说明是否真的删掉了一条。 */
  const remove = (value) => {
    const id = normalizeTypedSessionId(value);
    if (id.length === 0) {
      return { ok: false, error: '会话 ID 不能为空，且必须是 256 字符以内的普通文本' };
    }
    const current = list();
    const next = current.filter((entry) => entry !== id);
    persist({ typedSessions: next });
    return { ok: true, removed: next.length !== current.length, sessionId: id, ...status() };
  };

  /** 开关只影响已登记会话的文字能力；关闭后登记数组原样保留。 */
  const setEnabled = (value) => {
    if (typeof value !== 'boolean') {
      return { ok: false, error: 'enabled 必须是布尔值' };
    }
    persist({ typedEnabled: value });
    return { ok: true, ...status() };
  };

  return { typedEnabled, typedSessions: list, isRegistered, register, remove, setEnabled, status };
}
