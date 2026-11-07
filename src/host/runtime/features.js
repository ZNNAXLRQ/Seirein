/**
 * Feature registry — the switchboard behind "每个能力是一个可独立关闭的组件".
 *
 * The Harness plugin manager sees one bundle; inside it, capabilities are separate features
 * with their own on/off state. Each feature is a descriptor plus optional lifecycle hooks, so
 * a later module can register another component without touching the settings UI:
 *
 *   features.register({ id: 'tts', label: '语音合成', description: '…', default: true,
 *                       onEnable() {}, onDisable() {} });
 *
 * State persists in `<root>/data/features.json`; a missing file means "all defaults".
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_FEATURES = [
  {
    id: 'hearing',
    label: '听觉',
    description: '麦克风采集与语音识别（双通道）。关闭后不占麦克风。',
    default: true,
  },
  {
    id: 'ambient',
    label: '环境声音',
    description: '通过虚拟声卡单独采集电脑声音，只做上下文，不触发回复。',
    default: true,
  },
  {
    id: 'voice',
    label: '语音合成',
    description: '让助手出声（Edge TTS）。关闭后只输出文字。',
    default: true,
  },
  {
    id: 'vision',
    label: '视觉',
    description: '屏幕快照与故事板采集。关闭后不截图。',
    default: true,
  },
  {
    id: 'subtitle',
    label: '字幕显示',
    description: '把助手说的话显示在屏幕上（浏览器叠加页）。',
    default: true,
  },
  {
    id: 'avatar',
    label: '形象',
    description: 'VTubeStudio 表情与口型控制。',
    default: true,
  },
  {
    id: 'memory',
    label: '记忆',
    description: '分域记忆的读写与检索。关闭后不读不写。',
    default: true,
  },
  {
    id: 'fastpath',
    label: '闲聊模式',
    description: '纯闲聊模式（会绕过助手工具流程）：关闭时语音进入助手 agent 理解并调用工具，开启后语音直接走闲聊 LLM。默认关闭。',
    default: false,
  },
];

export class FeatureStore {
  constructor(root) {
    this.file = join(root, 'data', 'features.json');
    this.registry = new Map();
    this.hooks = new Map();
    for (const entry of DEFAULT_FEATURES) this.registry.set(entry.id, { ...entry });
    this.state = this.#load();
  }

  #load() {
    const state = {};
    for (const entry of this.registry.values()) state[entry.id] = entry.default !== false;
    try {
      const saved = JSON.parse(readFileSync(this.file, 'utf8'));
      for (const [id, value] of Object.entries(saved)) {
        // The registry is the source of truth: ids retired from an older build are ignored.
        if (id in state && typeof value === 'boolean') state[id] = value;
      }
    } catch {
      /* first run: defaults */
    }
    return state;
  }

  #save() {
    mkdirSync(join(this.file, '..'), { recursive: true });
    writeFileSync(this.file, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
  }

  /**
   * Extension point: another module can add its own component, or attach lifecycle hooks to a
   * built-in one. An existing descriptor (label/description/default) is preserved, so wiring
   * hooks never erases what the settings card shows.
   */
  register(entry) {
    if (typeof entry?.id !== 'string' || entry.id.length === 0) throw new Error('feature id required');
    const existing = this.registry.get(entry.id);
    this.registry.set(entry.id, {
      ...(existing ?? {}),
      ...entry,
      default: entry.default !== undefined ? entry.default !== false : existing?.default !== false,
    });
    if (!(entry.id in this.state)) {
      this.state[entry.id] = entry.default !== false;
      this.#save();
    }
    if (entry.onEnable || entry.onDisable) this.hooks.set(entry.id, entry);
    return () => {
      this.hooks.delete(entry.id);
      if (existing === undefined) this.registry.delete(entry.id);
      else this.registry.set(entry.id, existing);
    };
  }

  enabled(id) {
    return this.state[id] === true;
  }

  list() {
    return [...this.registry.values()].map((entry) => ({
      id: entry.id,
      label: entry.label,
      description: entry.description,
      enabled: this.state[entry.id] === true,
    }));
  }

  /**
   * Flip one component. `reason` is carried to the lifecycle hook and into the host log; the
   * persisted state is written before the hook runs, so a hook that stops resources can never let
   * a new task slip in through `enabled()` while it is cleaning up.
   *
   * The hook's thrown error is kept in `lastHookError` instead of being swallowed: a half-applied
   * transition stays visible to the caller. `set()` itself does not reject, because the component
   * state must stay off even when one stop step failed.
   */
  async set(id, enabled, { reason = '' } = {}) {
    if (!this.registry.has(id)) throw new Error(`unknown feature: ${id}`);
    const next = enabled === true;
    if (this.state[id] === next) return next;
    this.state[id] = next;
    this.#save();
    const hook = this.hooks.get(id);
    const lifecycle = next ? hook?.onEnable : hook?.onDisable;
    if (typeof lifecycle !== 'function') return next;
    try {
      await lifecycle({ reason, id, enabled: next });
      this.lastHookError = null;
    } catch (error) {
      this.lastHookError = { id, enabled: next, reason, error: error?.message ?? String(error) };
    }
    return next;
  }

  /** Last failed lifecycle hook, or null after the next successful transition. */
  lastHookError = null;
}
