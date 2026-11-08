/** Settings actions for Live2D, transparent backends and geometry editing. */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { OPERATIONS, PRESETS, STYLES } from './presets/index.js';

// ---------------------------------------------------------------------------------------------
// Motion preset overrides — user-owned state persisted under `<root>/data`, never in the source
// tree. The shape is exactly the selector's `overrides` input so wiring the selector later needs
// no translation: { version, disabled, disabledFamilies, familyPriority, actionPriority }.
// ---------------------------------------------------------------------------------------------

export const MOTION_PRESET_DEFAULT_PRIORITY = 50;
export const MOTION_PRESET_VERSION = 1;

const MOTION_PRIORITY_MIN = 0;
const MOTION_PRIORITY_MAX = 100;

const PRESET_BY_ID = new Map(PRESETS.map(preset => [preset.id, preset]));
const FAMILY_IDS = [...new Set(PRESETS.map(preset => preset.family))].sort();
const FAMILY_SET = new Set(FAMILY_IDS);
const PRESETS_BY_FAMILY = new Map(FAMILY_IDS.map(family => [family, PRESETS.filter(preset => preset.family === family)]));
const STYLE_LABELS = new Map(STYLES.map(style => [style.id, style.shortName]));

const FAMILY_LABELS = Object.freeze({
  attention: '注意', posture: '姿态', settle: '回正', blink: '眨眼',
  'body-posture': '身体姿态', 'body-settle': '身体落定', breath: '呼吸', thought: '思考',
  'speech-beat': '语流节拍', rest: '休息', affirmation: '肯定', negation: '否定',
  emphasis: '强调', confusion: '困惑', surprise: '惊讶', curiosity: '好奇',
  reassurance: '安抚', apology: '致歉', amusement: '有趣', uncertainty: '不确定',
  greeting: '问候', farewell: '告别',
});

const STATE_LABELS = Object.freeze({
  idle: '待机', listening: '聆听', thinking: '思考', speaking: '说话', waiting: '等待', tired: '疲倦',
});

const EVENT_LABELS = Object.freeze({
  idle: '空闲', 'user-speaking': '用户说话', thinking: '思考中', 'sentence-gap': '句间',
  'answer-start': '开口', 'answer-end': '说完', affirm: '肯定', deny: '否定',
  emphasize: '强调', confused: '困惑', surprised: '惊讶', curious: '好奇',
  reassure: '安抚', apologize: '致歉', amused: '有趣', uncertain: '不确定',
  greet: '问候', farewell: '告别',
});

const SEMANTIC_LABELS = Object.freeze({
  neutral: '中性', agreement: '肯定', disagreement: '否定', emphasis: '强调',
  confusion: '困惑', surprise: '惊讶', curiosity: '好奇', reassurance: '安抚',
  apology: '致歉', amusement: '有趣', uncertainty: '不确定', greeting: '问候', farewell: '告别',
});

const LOCK_REASON_LABELS = Object.freeze({
  privacy: '隐私锁定', disconnect: 'VTS 连接断开', 'component-disabled': '形象组件已关闭',
  'model-changed': '模型切换中',
});

const labelOf = (map, id) => map[id] ?? String(id ?? '');

/** An empty override set; each call returns a fresh object so callers can mutate their copy. */
export function createDefaultMotionPresetOverrides() {
  return {
    version: MOTION_PRESET_VERSION,
    disabled: [],
    disabledFamilies: [],
    familyPriority: {},
    actionPriority: {},
  };
}

const priorityOrNull = (value) => {
  if (typeof value === 'string' && value.trim().length === 0) return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.min(MOTION_PRIORITY_MAX, Math.max(MOTION_PRIORITY_MIN, Math.round(number)));
};

const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

const uniqueStrings = (value) => {
  if (!Array.isArray(value)) return null;
  const out = [];
  for (const entry of value) {
    if (typeof entry === 'string' && entry.length > 0 && !out.includes(entry)) out.push(entry);
  }
  return out;
};

const priorityMap = (value) => {
  if (!plainObject(value)) return null;
  const out = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof key !== 'string' || key.length === 0) continue;
    const priority = priorityOrNull(raw);
    if (priority !== null) out[key] = priority;
  }
  return out;
};

/**
 * Strict validation for a persisted file. `null` means "this is not a v1 override file" and the
 * caller falls back to defaults (and records `motion.presets.corrupt`). Unknown ids are kept:
 * they may become valid after a library upgrade, and losing a user's choice is worse than
 * carrying one stale id the selector ignores.
 */
function normalizeMotionPresetOverrides(raw) {
  if (!plainObject(raw) || raw.version !== MOTION_PRESET_VERSION) return null;
  const disabled = uniqueStrings(raw.disabled);
  const disabledFamilies = uniqueStrings(raw.disabledFamilies);
  const familyPriority = priorityMap(raw.familyPriority);
  const actionPriority = priorityMap(raw.actionPriority);
  if (disabled === null || disabledFamilies === null || familyPriority === null || actionPriority === null) {
    return null;
  }
  return {
    version: MOTION_PRESET_VERSION,
    disabled,
    disabledFamilies,
    familyPriority,
    actionPriority,
  };
}

/**
 * File-backed override store. Reads are tolerant (a corrupt file never breaks the settings page)
 * and writes are atomic (tmp file + rename). The store is deliberately synchronous: the file is
 * tiny and every settings action already runs in the host's async handler.
 */
export function createMotionPresetOverridesStore({ file, log = null } = {}) {
  if (typeof file !== 'string' || file.length === 0) {
    throw new TypeError('motion preset store: file path is required');
  }
  let lastCorruption = '';

  const corrupt = (error, text = '') => {
    const message = error?.message ?? String(error);
    const signature = `${message}\u0000${text}`;
    if (signature === lastCorruption) return;
    lastCorruption = signature;
    try {
      void log?.emit?.('motion.presets.corrupt', { file, error: message })?.catch?.(() => {});
    } catch {
      /* logging must never hide the fallback */
    }
  };

  const read = () => {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') corrupt(error);
      return createDefaultMotionPresetOverrides();
    }
    try {
      const normalized = normalizeMotionPresetOverrides(JSON.parse(text));
      if (normalized === null) throw new TypeError('不是有效的 motion-presets v1 文件');
      lastCorruption = '';
      return normalized;
    } catch (error) {
      corrupt(error, text);
      return createDefaultMotionPresetOverrides();
    }
  };

  const write = (state) => {
    const normalized = normalizeMotionPresetOverrides(state);
    if (normalized === null) {
      throw new TypeError('motion preset store: refusing to write a malformed override set');
    }
    mkdirSync(dirname(file), { recursive: true });
    const temporary = `${file}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
    renameSync(temporary, file);
    return normalized;
  };

  return Object.freeze({ file, read, write });
}

/** Hard channel gap, matching the selector's only optional operation (`brow-one` → browR). */
function unverifiedChannels(preset, verified) {
  for (const operation of preset.operations) {
    const channels = OPERATIONS[operation] ?? [];
    const absent = channels.filter(channel => !verified.has(channel));
    if (absent.length === 0) continue;
    const optional = operation === 'brow-one' ? new Set(['browR']) : null;
    const hard = optional === null ? absent : absent.filter(channel => !optional.has(channel));
    if (hard.length > 0) return hard;
  }
  return [];
}

const stylesOf = styles => styles.map(style => STYLE_LABELS.get(style) ?? style);

export const ACTIONS = Object.freeze([
  'avatarLayer.start',
  'layer.edit.enter',
  'avatarLayer.adjust.start',
  'layer.edit.exit',
  'avatarLayer.adjust.finish',
  'avatarLayer.stop',
  'avatarLayer.edit',
  'avatarLayer.set',
  'spoutLayer.start',
  'spoutLayer.stop',
  'spoutLayer.status',
  'layer.backend',
  'live2d.connect',
  'live2d.hotkey',
  'live2d.expression',
  'avatar.capabilities.refresh',
  'motion.presets.list',
  'motion.presets.override',
  'motion.presets.reset',
  'transparent.start',
  'transparent.stop',
]);

/** Push saved overrides into a live runtime; a missing/stale runtime must not fail the write. */
const syncMotionOverrides = (services, overrides) => {
  try {
    services.ensureAvatarRuntime?.()?.setPresetOverrides?.(overrides);
  } catch {
    /* settings write already succeeded; a dead runtime is rebuilt on demand */
  }
};

export function createAvatarSettingsActions(services) {
  const emit = async (type, payload) => {
    try {
      await services.log?.emit?.(type, payload);
    } catch {
      /* logging never blocks a settings action */
    }
  };

  let fallbackMotionStore = null;
  const motionStoreOrNull = () => {
    const store = services.motionPresetStore;
    if (store !== null && store !== undefined
      && typeof store.read === 'function' && typeof store.write === 'function') {
      return store;
    }
    // Standalone tests/hosts may pass only `root`; still use the same data/ path.
    if (fallbackMotionStore === null && typeof services.root === 'string' && services.root.length > 0) {
      fallbackMotionStore = createMotionPresetOverridesStore({
        file: join(services.root, 'data', 'motion-presets.json'),
        log: services.log,
      });
    }
    return fallbackMotionStore;
  };

  /** Privacy and every other hard motion gate make the whole catalog temporarily unavailable. */
  const motionLockReasons = (body) => {
    const reasons = new Set();
    if (body.privacy === true) reasons.add('privacy');
    for (const reason of Array.isArray(services.avatarMotionLockReasons) ? services.avatarMotionLockReasons : []) {
      if (typeof reason === 'string' && reason.length > 0) reasons.add(reason);
    }
    if (services.vision?.mode === 'privacy') reasons.add('privacy');
    return [...reasons];
  };

  const listMotionPresets = async (body = {}) => {
    const store = motionStoreOrNull();
    if (store === null) return { ok: false, error: '动作预设存储不可用' };
    const overrides = store.read();
    const capability = typeof services.avatarCapabilitiesStatus === 'function'
      ? (services.avatarCapabilitiesStatus() ?? {})
      : {};
    const verifiedChannels = Array.isArray(body.verifiedChannels)
      ? body.verifiedChannels.filter(channel => typeof channel === 'string' && channel.length > 0)
      : (Array.isArray(capability.verified) ? capability.verified : []);
    const verified = new Set(verifiedChannels);
    const targetVerified = body.targetVerified === true;
    const directionVerified = body.directionVerified === true;
    const locks = motionLockReasons(body);
    const lockText = locks.length === 0
      ? ''
      : `动作已锁定：${locks.map(reason => labelOf(LOCK_REASON_LABELS, reason)).join('、')}`;

    const items = PRESETS.map((preset) => {
      const reasons = [];
      if (lockText.length > 0) {
        reasons.push(lockText);
      } else {
        const missing = unverifiedChannels(preset, verified);
        if (missing.length > 0) reasons.push(`能力未验证：${missing.join('、')}`);
        if (preset.requiresTarget && targetVerified !== true) reasons.push('需要目标：当前未提供注视目标');
        if (preset.requiresDirection && directionVerified !== true) reasons.push('需要方向：当前未提供声源方向');
      }
      return {
        presetId: preset.id,
        family: preset.family,
        familyLabel: labelOf(FAMILY_LABELS, preset.family),
        recipe: preset.recipeId,
        variant: preset.timing?.id ?? preset.id.split('.').pop(),
        name: preset.label,
        description: `${labelOf(SEMANTIC_LABELS, preset.semantic)}语义 · `
          + `${preset.states.map(state => labelOf(STATE_LABELS, state)).join('/')} · `
          + `${preset.events.map(event => labelOf(EVENT_LABELS, event)).join('/')}`,
        states: [...preset.states],
        stateLabels: preset.states.map(state => labelOf(STATE_LABELS, state)),
        events: [...preset.events],
        eventLabels: preset.events.map(event => labelOf(EVENT_LABELS, event)),
        styles: [...preset.styles],
        styleLabels: stylesOf(preset.styles),
        semantic: preset.semantic,
        requires: [...preset.requires],
        requiresTarget: preset.requiresTarget === true,
        requiresDirection: preset.requiresDirection === true,
        available: reasons.length === 0,
        reason: reasons.join('；'),
      };
    });

    const disabled = new Set(overrides.disabled);
    const disabledFamilies = new Set(overrides.disabledFamilies);
    const families = FAMILY_IDS.map((family) => {
      const members = PRESETS_BY_FAMILY.get(family) ?? [];
      const styleIds = [...new Set(members.flatMap(preset => preset.styles))];
      return {
        family,
        label: labelOf(FAMILY_LABELS, family),
        count: members.length,
        enabled: !disabledFamilies.has(family),
        priority: overrides.familyPriority[family] ?? MOTION_PRESET_DEFAULT_PRIORITY,
        disabledActions: members.filter(preset => disabled.has(preset.id)).length,
        styles: styleIds,
        styleLabels: stylesOf(styleIds),
      };
    });

    return {
      ok: true,
      items,
      families,
      overrides,
      defaultPriority: MOTION_PRESET_DEFAULT_PRIORITY,
      verifiedChannels,
      targetVerified,
      directionVerified,
      locked: locks.length > 0,
      lockReasons: locks,
    };
  };

  const overrideMotionPreset = async (body = {}) => {
    const store = motionStoreOrNull();
    if (store === null) return { ok: false, error: '动作预设存储不可用' };
    const kind = body.kind === 'action' || body.kind === 'family' ? body.kind : '';
    const id = typeof body.id === 'string' ? body.id.trim() : '';
    if (kind.length === 0 || id.length === 0) return { ok: false, error: 'kind 与 id 必填' };
    const hasEnabled = body.enabled === true || body.enabled === false;
    const hasPriority = body.priority !== undefined && body.priority !== null;
    const priority = hasPriority ? priorityOrNull(body.priority) : null;
    if (hasPriority && priority === null) return { ok: false, error: 'priority 必须是 0–100 的数字' };
    if (!hasEnabled && !hasPriority) return { ok: false, error: '没有可应用的更改' };

    const state = store.read();
    if (kind === 'action') {
      if (!PRESET_BY_ID.has(id)) return { ok: false, error: '未知动作预设' };
      if (hasEnabled) {
        state.disabled = body.enabled === true
          ? state.disabled.filter(entry => entry !== id)
          : (state.disabled.includes(id) ? state.disabled : [...state.disabled, id]);
      }
      if (hasPriority) state.actionPriority = { ...state.actionPriority, [id]: priority };
    } else {
      if (!FAMILY_SET.has(id)) return { ok: false, error: '未知动作家族' };
      if (hasEnabled) {
        state.disabledFamilies = body.enabled === true
          ? state.disabledFamilies.filter(entry => entry !== id)
          : (state.disabledFamilies.includes(id) ? state.disabledFamilies : [...state.disabledFamilies, id]);
      }
      if (hasPriority) state.familyPriority = { ...state.familyPriority, [id]: priority };
    }

    const saved = store.write(state);
syncMotionOverrides(services, saved);
    const preset = PRESET_BY_ID.get(id);
    const enabled = kind === 'action'
      ? !saved.disabled.includes(id) && !(preset !== undefined && saved.disabledFamilies.includes(preset.family))
      : !saved.disabledFamilies.includes(id);
    const effectivePriority = kind === 'action'
      ? (saved.actionPriority[id] ?? (preset === undefined ? undefined : saved.familyPriority[preset.family]) ?? MOTION_PRESET_DEFAULT_PRIORITY)
      : (saved.familyPriority[id] ?? MOTION_PRESET_DEFAULT_PRIORITY);
    await emit('motion.presets.changed', { kind, id, enabled, priority: effectivePriority });
    return { ok: true, overrides: saved };
  };

  const resetMotionPresets = async (body = {}) => {
    const store = motionStoreOrNull();
    if (store === null) return { ok: false, error: '动作预设存储不可用' };

    if (body.all === true) {
      const saved = store.write(createDefaultMotionPresetOverrides());
syncMotionOverrides(services, saved);
      await emit('motion.presets.changed', {
        kind: 'all',
        id: '',
        enabled: true,
        priority: MOTION_PRESET_DEFAULT_PRIORITY,
      });
      return { ok: true, overrides: saved };
    }

    const id = typeof body.id === 'string' ? body.id.trim() : '';
    if (id.length === 0) return { ok: false, error: 'reset 需要 id 或 all:true' };
    const state = store.read();
    const kind = body.kind === 'family' || body.kind === 'action'
      ? body.kind
      : (FAMILY_SET.has(id) || state.disabledFamilies.includes(id)
        || Object.prototype.hasOwnProperty.call(state.familyPriority, id))
        ? 'family'
        : (PRESET_BY_ID.has(id) || state.disabled.includes(id)
          || Object.prototype.hasOwnProperty.call(state.actionPriority, id))
          ? 'action'
          : '';
    if (kind.length === 0) return { ok: false, error: '未知动作或家族' };

    if (kind === 'action') {
      state.disabled = state.disabled.filter(entry => entry !== id);
      delete state.actionPriority[id];
    } else {
      state.disabledFamilies = state.disabledFamilies.filter(entry => entry !== id);
      delete state.familyPriority[id];
    }

    const saved = store.write(state);
syncMotionOverrides(services, saved);
    const preset = PRESET_BY_ID.get(id);
    const enabled = kind === 'action'
      ? !saved.disabled.includes(id) && !(preset !== undefined && saved.disabledFamilies.includes(preset.family))
      : !saved.disabledFamilies.includes(id);
    const priority = kind === 'action'
      ? (saved.actionPriority[id] ?? (preset === undefined ? undefined : saved.familyPriority[preset.family]) ?? MOTION_PRESET_DEFAULT_PRIORITY)
      : (saved.familyPriority[id] ?? MOTION_PRESET_DEFAULT_PRIORITY);
    await emit('motion.presets.changed', { kind, id, enabled, priority });
    return { ok: true, overrides: saved };
  };

  const motionAction = async (fn, body) => {
    try {
      return await fn(body);
    } catch (error) {
      return { ok: false, error: error?.message ?? String(error) };
    }
  };

  const handler = async (body) => {
    switch (body.action) {
      case 'avatarLayer.start': {
        const opened = await (0, services.ensureComponent)('avatar', 'avatarLayer.start');
        if (!opened.ok) return { ok: false, code: 'FEATURE_DISABLED', feature: 'avatar', error: opened.error ?? '形象组件无法启用' };
        const layer = (0, services.ensureAvatarLayer)();
        const result = await layer.start();
        await services.log.emit('avatarLayer.start', result);
        return { ok: result.ok, ...layer.snapshot() };
      }
      case 'layer.edit.enter':
      case 'avatarLayer.adjust.start': {
        const opened = await (0, services.ensureComponent)('avatar', 'layer.edit.enter');
        if (!opened.ok) return { ok: false, code: 'FEATURE_DISABLED', feature: 'avatar', error: opened.error ?? '形象组件无法启用' };
        return await services.layerEdit.enter();
      }
      case 'layer.edit.exit':
      case 'avatarLayer.adjust.finish': {
        return await services.layerEdit.exit();
      }
      case 'avatarLayer.stop': {
        await services.avatarLayerController?.stop();
        await services.log.emit('avatarLayer.stop', {});
        if (services.transparentChild === null && services.spoutLayer.snapshot().running !== true) (0, services.keepAvatarGeometry)();
        return { ok: true };
      }
      case 'avatarLayer.edit': {
        const opened = await (0, services.ensureComponent)('avatar', 'avatarLayer.edit');
        if (!opened.ok) return { ok: false, code: 'FEATURE_DISABLED', feature: 'avatar', error: opened.error ?? '形象组件无法启用' };
        const layer = (0, services.ensureAvatarLayer)();
        const snapshot = await layer.setEditMode(body.enabled === true);
        if (snapshot?.geometry) {
          if (snapshot.editMode === true) (0, services.publishEditGeometry)(snapshot.geometry);
          else if (snapshot.running === true) services.subtitleGeometry.set(snapshot.geometry, 'wpf');
        }
        return { ok: true, ...snapshot };
      }
      case 'avatarLayer.set': {
        const opened = await (0, services.ensureComponent)('avatar', 'avatarLayer.set');
        if (!opened.ok) return { ok: false, code: 'FEATURE_DISABLED', feature: 'avatar', error: opened.error ?? '形象组件无法启用' };
        const layer = (0, services.ensureAvatarLayer)();
        const snapshot = await layer.setGeometry(body.geometry ?? {});
        if (snapshot?.running === true && snapshot.geometry) services.subtitleGeometry.set(snapshot.geometry, 'wpf');
        return { ok: true, ...snapshot };
      }
      case 'spoutLayer.start': {
        const opened = await (0, services.ensureComponent)('avatar', 'spoutLayer.start');
        if (!opened.ok) return { ok: false, code: 'FEATURE_DISABLED', feature: 'avatar', error: opened.error ?? '形象组件无法启用' };
        // Optional path from the settings card: persist first so a restart keeps the choice.
        const exe = typeof body.electronExecutable === 'string' ? body.electronExecutable.trim() : '';
        if (exe.length > 0) {
          services.runtime.spoutLayer = { ...(services.runtime.spoutLayer ?? {}), electronExecutable: exe };
          (0, services.writeSettings)({ spoutLayer: services.runtime.spoutLayer });
        }
        // The receiver watchdog is a latency budget, not a constant: persist an override when the
        // caller supplies one (ms), and let spoutLayer clamp it.
        const receiverTimeoutMs = Number(body.receiverTimeoutMs);
        if (Number.isFinite(receiverTimeoutMs) && receiverTimeoutMs >= 1000 && receiverTimeoutMs <= 120_000) {
          services.runtime.spoutLayer = { ...(services.runtime.spoutLayer ?? {}), receiverTimeoutMs: Math.round(receiverTimeoutMs) };
          (0, services.writeSettings)({ spoutLayer: services.runtime.spoutLayer });
        }
        const result = await services.spoutLayer.start();
        await services.log.emit('spoutLayer.start', {
          ok: result.ok,
          code: result.code ?? '',
          pid: result.pid ?? 0,
          phase: result.readyPhase ?? '',
        });
        // Spout publishes the same unified record as WPF; the bubble never depends on WPF here.
        if (result.ok === true) (0, services.observeAvatarGeometry)({ editing: false });
        return result;
      }
      case 'spoutLayer.stop': {
        // An editing session leaves edit mode first, so its final rectangle is not lost. The
        // display is not autostarted: it is about to be stopped.
        await (0, services.leaveSpoutEditForStop)();
        const result = await services.spoutLayer.stop();
        await services.log.emit('spoutLayer.stop', {
          stopped: result.stopped === true,
          killed: result.killed === true,
          how: result.how ?? '',
          elapsedMs: result.elapsedMs ?? 0,
        });
        (0, services.keepAvatarGeometry)();
        return result;
      }
      case 'spoutLayer.status': {
        // "检测" button: persist the typed path, then run the full check (含 --version 探活).
        // Read-only for the running process: this never starts or stops the layer.
        const exe = typeof body.electronExecutable === 'string' ? body.electronExecutable.trim() : '';
        if (exe.length > 0) {
          services.runtime.spoutLayer = { ...(services.runtime.spoutLayer ?? {}), electronExecutable: exe };
          (0, services.writeSettings)({ spoutLayer: services.runtime.spoutLayer });
        }
        const probe = await services.spoutLayer.validateConfigured();
        return { ok: true, probe, ...services.spoutLayer.snapshot() };
      }
      case 'layer.backend': {
        const opened = await (0, services.ensureComponent)('avatar', 'layer.backend');
        if (!opened.ok) return { ok: false, code: 'FEATURE_DISABLED', feature: 'avatar', error: opened.error ?? '形象组件无法启用' };
        // Persist a typed Spout path first (same rule as spoutLayer.start/status), then switch
        // with single ownership: availability check → stop old → confirmed exit → start new.
        const exe = typeof body.electronExecutable === 'string' ? body.electronExecutable.trim() : '';
        if (exe.length > 0) {
          services.runtime.spoutLayer = { ...(services.runtime.spoutLayer ?? {}), electronExecutable: exe };
          (0, services.writeSettings)({ spoutLayer: services.runtime.spoutLayer });
        }
        const result = await services.layerSwitch.set(body.backend);
        await services.log.emit('layer.backend', {
          ok: result.ok === true,
          backend: result.backend ?? '',
          code: result.code ?? '',
          error: result.error ?? '',
        });
        return result;
      }
      case 'live2d.connect': {
        const opened = await (0, services.ensureComponent)('avatar', 'live2d.connect');
        if (!opened.ok) return { ok: false, code: 'FEATURE_DISABLED', feature: 'avatar', error: opened.error ?? '形象组件无法启用' };
        const result = await (0, services.vtsConnect)();
        return {
          ok: result.ok === true,
          ready: services.vts?.ready === true,
          socketOpen: services.vts?.connected === true,
          model: services.vts?.model?.modelName ?? '',
          modelId: services.vts?.modelId ?? '',
          hotkeys: (services.vts?.hotkeys ?? []).map((entry) => entry.name),
          expressions: (services.vts?.expressions ?? []).map((entry) => entry.name),
          error: result.error ?? '',
        };
      }
      case 'live2d.hotkey': {
        try {
          const opened = await (0, services.ensureComponent)('avatar', 'live2d.hotkey');
          if (!opened.ok) return { ok: false, code: 'FEATURE_DISABLED', feature: 'avatar', error: opened.error ?? '形象组件无法启用' };
          const client = (0, services.vtsClient)();
          if (!client.ready) await (0, services.vtsConnect)();
          const name = await client.triggerHotkey(body.name ?? '');
          await services.log.emit('live2d.action', { action: 'hotkey', name, source: 'settings' });
          return { ok: true, name };
        } catch (error) {
          return { ok: false, error: error?.message ?? String(error) };
        }
      }
      case 'live2d.expression': {
        try {
          const opened = await (0, services.ensureComponent)('avatar', 'live2d.expression');
          if (!opened.ok) return { ok: false, code: 'FEATURE_DISABLED', feature: 'avatar', error: opened.error ?? '形象组件无法启用' };
          const client = (0, services.vtsClient)();
          if (!client.ready) await (0, services.vtsConnect)();
          const name = await client.triggerExpression(body.name ?? '');
          await services.log.emit('live2d.action', { action: 'expression', name, source: 'settings' });
          return { ok: true, name };
        } catch (error) {
          return { ok: false, error: error?.message ?? String(error) };
        }
      }
      case 'avatar.capabilities.refresh': {
        // Re-probe VTS: which input parameters exist decides which channels can be driven at all.
        // Kept gated (not auto-enabled): this is a host diagnostic, so a disabled component gets
        // a machine-readable refusal instead of silently turning itself on.
        if (!services.features.enabled('avatar')) {
          return { ok: false, code: 'FEATURE_DISABLED', feature: 'avatar', error: '形象组件已关闭：请先在「组件开关」里启用形象' };
        }
        const client = (0, services.vtsClient)();
        if (!client.ready) {
          const connected = await (0, services.vtsConnect)();
          if (!connected.ok) return { ok: false, error: connected.error ?? '未连接 VTube Studio' };
        }
        const result = await (0, services.discoverAvatarCapabilities)({ force: true, reason: 'settings' });
        return {
          ok: result.ok === true,
          mapped: result.mapped ?? [],
          verified: result.verified ?? [],
          unmapped: result.unmapped ?? [],
          channels: result.channels ?? [],
          inputs: result.inputs ?? {},
          model: result.model ?? null,
          error: result.error ?? '',
        };
      }
      case 'motion.presets.list': {
        return motionAction(listMotionPresets, body);
      }
      case 'motion.presets.override': {
        return motionAction(overrideMotionPreset, body);
      }
      case 'motion.presets.reset': {
        return motionAction(resetMotionPresets, body);
      }
      case 'transparent.start': {
        const opened = await (0, services.ensureComponent)('avatar', 'transparent.start');
        if (!opened.ok) return { ok: false, code: 'FEATURE_DISABLED', feature: 'avatar', error: opened.error ?? '形象组件无法启用' };
        const result = await (0, services.startTransparentLayer)({
          left: body.left,
          top: body.top,
          width: body.width,
          height: body.height,
        });
        return { ok: true, ...result };
      }
      case 'transparent.stop':
        await (0, services.stopTransparentLayer)();
        return { ok: true, running: false };
  }
};
  return handler;
}
