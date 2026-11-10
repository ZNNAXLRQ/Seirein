/**
 * Global hotkeys via koffi + user32!GetAsyncKeyState.
 *
 * The Host runs as an ELECTRON_RUN_AS_NODE child process, so Electron's globalShortcut is
 * unavailable and there is no message loop to hook. Polling a handful of virtual-key states
 * at 25 Hz is cheap (microseconds per tick) and needs no native module beyond koffi.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** Virtual-key codes for the keys we accept in a combo. */
const VK = {
  ctrl: 0x11,
  control: 0x11,
  alt: 0x12,
  shift: 0x10,
  win: 0x5b,
  space: 0x20,
  tab: 0x09,
  esc: 0x1b,
  escape: 0x1b,
  enter: 0x0d,
  backspace: 0x08,
  up: 0x26,
  down: 0x28,
  left: 0x25,
  right: 0x27,
  home: 0x24,
  end: 0x23,
  pageup: 0x21,
  pagedown: 0x22,
  insert: 0x2d,
  delete: 0x2e,
  del: 0x2e,
  // Media/volume keys are non-printing, so they are safe as single-key bindings.
  mediastop: 0xb2,
  mediaplaypause: 0xb3,
  medianext: 0xb0,
  mediaprev: 0xb1,
  volumemute: 0xad,
  volumedown: 0xae,
  volumeup: 0xaf,
};
for (let code = 0x41; code <= 0x5a; code += 1) VK[String.fromCharCode(code).toLowerCase()] = code;
for (let digit = 0; digit <= 9; digit += 1) VK[String(digit)] = 0x30 + digit;
for (let index = 1; index <= 24; index += 1) VK[`f${index}`] = 0x6f + index;
// The numpad has its own VK range, so "Ctrl+Num1" (0x61) and "Ctrl+1" (0x31) stay distinct.
// Numpad digits and operators type text just like the main row, so they are in PRINTING_KEYS:
// only a modified combo is allowed, never a bare "Num1". Numpad Enter is the one exception: it
// shares VK_RETURN (0x0d) with the main Enter, and GetAsyncKeyState exposes no per-scancode state,
// so the two cannot be told apart. `numenter` is therefore deliberately not a name; such a
// binding has to be written as `Enter`.
for (let digit = 0; digit <= 9; digit += 1) VK[`num${digit}`] = 0x60 + digit;
Object.assign(VK, {
  nummultiply: 0x6a,
  numadd: 0x6b,
  numsubtract: 0x6d,
  numdecimal: 0x6e,
  numdivide: 0x6f,
});

const MODIFIER_NAMES = new Set(['ctrl', 'control', 'alt', 'shift', 'win']);

/**
 * Keys that insert a printable character: letters, main-row digits, numpad digits/operators and
 * Space. They may only be used with a modifier: a bare one would fire in the middle of ordinary
 * typing, and the numpad types text just like the main row. F1-F24, arrows, Home/End/PgUp/PgDn,
 * Insert/Delete, media/volume keys, Esc, Enter, Tab and Backspace do not print and may stand
 * alone. Numpad Enter is not a separate name because it shares VK_RETURN.
 */
const NUMPAD_OPERATORS = ['nummultiply', 'numadd', 'numsubtract', 'numdecimal', 'numdivide'];
const PRINTING_KEYS = new Set(['space', ...NUMPAD_OPERATORS]);
for (let code = 0x61; code <= 0x7a; code += 1) PRINTING_KEYS.add(String.fromCharCode(code));
for (let digit = 0; digit <= 9; digit += 1) {
  PRINTING_KEYS.add(String(digit));
  PRINTING_KEYS.add(`num${digit}`);
}

/** Default bindings; users override them in config or at runtime through the tool. */
export const DEFAULT_HOTKEYS = {
  mic: 'Ctrl+Alt+M',
  vision: 'Ctrl+Alt+V',
  layerEdit: 'Ctrl+Alt+E',
  ambient: 'Ctrl+Alt+A',
  callMode: 'Ctrl+Alt+C',
};

/** Actions the poller still knows. Anything else in a saved/config table is pruned on load. */
export const HOTKEY_ACTIONS = Object.freeze(Object.keys(DEFAULT_HOTKEYS));

/**
 * Keep only bindings whose action still exists. A table written by an older build may name
 * actions this build no longer ships; those are dropped and reported instead of throwing, so
 * an upgrade never fails to start over a stale hotkey file.
 * @param {unknown} bindings - saved or configured action -> combo table.
 * @returns {{bindings: Record<string, string>, dropped: Array<{action: string, combo: string}>}}
 */
export function pruneHotkeyBindings(bindings) {
  const kept = {};
  const dropped = [];
  if (bindings === null || typeof bindings !== 'object' || Array.isArray(bindings)) {
    return { bindings: kept, dropped };
  }
  for (const [action, combo] of Object.entries(bindings)) {
    if (!HOTKEY_ACTIONS.includes(action)) {
      dropped.push({ action, combo: typeof combo === 'string' ? combo : String(combo) });
      continue;
    }
    kept[action] = combo;
  }
  return { bindings: kept, dropped };
}

/**
 * Parse "Ctrl+Alt+V" into modifier virtual keys plus one trigger key.
 *
 * A modifier is optional only for non-printing keys (F1-F24, arrows, Home/End/PgUp/PgDn,
 * Insert/Delete, media/volume keys, Esc, ...): a bare letter/digit/symbol or numpad key would
 * fire while the user is typing.
 *
 * @param {string} combo - human-readable combination.
 * @returns {{combo: string, mods: number[], vk: number}}
 */
export function parseBinding(combo) {
  if (typeof combo !== 'string' || combo.trim().length === 0) throw new Error('empty hotkey');
  const parts = combo
    .split('+')
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0);
  if (parts.length === 0) throw new Error(`invalid hotkey: ${combo}`);

  const key = parts[parts.length - 1];
  const mods = parts.slice(0, -1);
  for (const mod of mods) {
    if (!MODIFIER_NAMES.has(mod)) {
      throw new Error(`unknown modifier "${mod}" in ${combo}: use Ctrl, Alt, Shift or Win`);
    }
  }
  if (!(key in VK)) {
    throw new Error(
      `unknown key "${key}" in ${combo}: use A-Z, 0-9, F1-F24, numpad names like Num1, or Enter/Esc/arrows/Home/End/PgUp/PgDn/Insert/Delete/media keys`,
    );
  }
  if (MODIFIER_NAMES.has(key)) throw new Error(`hotkey must end with a key, not a modifier: ${combo}`);
  if (mods.length === 0 && PRINTING_KEYS.has(key)) {
    throw new Error(
      `hotkey "${key}" 需要修饰键 (needs a modifier): a bare letter, digit, symbol or numpad key would fire while typing (小键盘数字也会打字). Use "Ctrl+${key.toUpperCase()}", or a single non-printing key such as "F9" or a media/volume key (媒体键)`,
    );
  }

  return {
    combo,
    mods: mods.map((mod) => VK[mod]),
    vk: VK[key],
  };
}

/**
 * Group actions whose combos resolve to the same key + modifier set. Both bindings stay active
 * (the poller keeps firing each action, exactly as before); the overlap is reported so the user
 * can fix it. Numpad Enter is indistinguishable from Enter (same VK_RETURN), so such a pair looks
 * identical here too.
 * @param {unknown} bindings - action -> combo table.
 * @returns {Array<{action: string, conflictWith: string, combo: string}>}
 */
export function findHotkeyConflicts(bindings) {
  if (bindings === null || typeof bindings !== 'object' || Array.isArray(bindings)) return [];
  const groups = new Map();
  for (const [action, combo] of Object.entries(bindings)) {
    let parsed;
    try {
      parsed = parseBinding(combo);
    } catch {
      continue; // an invalid binding is already reported separately
    }
    const signature = `${parsed.vk}:${[...parsed.mods].sort((a, b) => a - b).join(',')}`;
    const group = groups.get(signature);
    if (group === undefined) groups.set(signature, { combo: parsed.combo, actions: [action] });
    else group.actions.push(action);
  }
  const conflicts = [];
  for (const group of groups.values()) {
    if (group.actions.length < 2) continue;
    const actions = [...group.actions].sort();
    for (let first = 0; first < actions.length; first += 1) {
      for (let second = first + 1; second < actions.length; second += 1) {
        conflicts.push({ action: actions[first], conflictWith: actions[second], combo: group.combo });
      }
    }
  }
  return conflicts;
}

/**
 * Actions whose stored binding fires for a synthesized combo. Simulation holds `combo`'s keys
 * down, so a binding fires when its trigger key matches and every one of its modifiers is held —
 * a combo with EXTRA modifiers still reaches a less-modified binding (Ctrl+Alt+Shift+V reaches a
 * Ctrl+Alt+V binding), which is why set-inclusion rather than equality is used.
 *
 * @param {unknown} bindings - action -> combo table.
 * @param {string} combo - combo that is about to be synthesized.
 * @returns {string[]} matching action names.
 */
export function hotkeyActionsForCombo(bindings, combo) {
  let target;
  try {
    target = parseBinding(combo);
  } catch {
    return [];
  }
  if (bindings === null || typeof bindings !== 'object' || Array.isArray(bindings)) return [];
  const actions = [];
  for (const [action, stored] of Object.entries(bindings)) {
    let parsed;
    try {
      parsed = parseBinding(stored);
    } catch {
      continue; // an invalid saved binding can never fire
    }
    if (parsed.vk !== target.vk) continue;
    if (parsed.mods.every((vk) => target.mods.includes(vk))) actions.push(action);
  }
  return actions;
}

/** Load koffi and bind the user32 entry points we need. */
function loadUser32() {
  const koffi = require('koffi');
  const user32 = koffi.load('user32.dll');
  return {
    getAsyncKeyState: user32.func('GetAsyncKeyState', 'int16_t', ['int']),
    keybdEvent: user32.func('keybd_event', 'void', ['uint8', 'uint8', 'uint32', 'uintptr_t']),
  };
}

const KEYEVENTF_KEYUP = 0x0002;

/** Poll a set of parsed bindings and fire once per press (edge-triggered). */
export class HotkeyPoller {
  /**
   * @param {{bindings: Record<string, string>, onTrigger: (action: string, combo: string) => void, onConflict?: (conflict: {action: string, conflictWith: string, combo: string}) => void, intervalMs?: number, debounceMs?: number}} options
   */
  constructor({ bindings, onTrigger, onRelease = null, onConflict = null, intervalMs = 40, debounceMs = 300 }) {
    this.bindings = bindings;
    this.onTrigger = onTrigger;
    this.onRelease = onRelease;
    this.onConflict = onConflict;
    this.intervalMs = intervalMs;
    this.debounceMs = debounceMs;
    this.timer = null;
    this.api = null;
    this.parsed = new Map();
    this.down = new Set();
    this.lastFired = new Map();
    this.reportedConflicts = new Set();
    this.error = null;
    // Report conflicts at mount time too: a table that already overlaps is worth flagging even
    // if the native module later fails and the poller never starts.
    this.refresh(bindings);
  }

  get running() {
    return this.timer !== null;
  }

  /** Rebuild the parsed binding table; invalid entries are skipped and reported. */
  refresh(bindings) {
    this.bindings = bindings;
    this.parsed.clear();
    const skipped = [];
    for (const [action, combo] of Object.entries(bindings)) {
      try {
        this.parsed.set(action, parseBinding(combo));
      } catch (error) {
        skipped.push({ action, combo, error: error.message });
      }
    }
    // Both actions stay bound (existing behavior); only the overlap is reported, once per pair.
    const active = new Set();
    for (const conflict of findHotkeyConflicts(bindings)) {
      const key = `${conflict.action}|${conflict.conflictWith}|${conflict.combo}`;
      active.add(key);
      if (this.reportedConflicts.has(key)) continue;
      this.reportedConflicts.add(key);
      try {
        this.onConflict?.(conflict);
      } catch {
        /* a throwing reporter must not break a binding reload */
      }
    }
    for (const key of this.reportedConflicts) {
      if (!active.has(key)) this.reportedConflicts.delete(key);
    }
    return skipped;
  }

  async start() {
    if (this.timer !== null) return;
    try {
      this.api = loadUser32();
    } catch (error) {
      this.error = error?.message ?? String(error);
      throw error;
    }
    this.refresh(this.bindings);
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.timer.unref?.();
    this.error = null;
  }

  stop() {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.down.clear();
  }

  tick() {
    if (this.api === null) return;
    const now = Date.now();
    for (const [action, binding] of this.parsed) {
      const active = binding.mods.every((vk) => this.isDown(vk)) && this.isDown(binding.vk);
      if (!active) {
        if (this.down.delete(action) && this.onRelease !== null) {
          // Release matters for hold-style bindings (push-to-talk).
          try {
            this.onRelease(action, binding.combo);
          } catch {
            /* a throwing handler must not kill the poller */
          }
        }
        continue;
      }
      if (this.down.has(action)) continue; // held: fire once per press
      const last = this.lastFired.get(action) ?? 0;
      if (now - last < this.debounceMs) continue;
      this.down.add(action);
      this.lastFired.set(action, now);
      try {
        this.onTrigger(action, binding.combo);
      } catch {
        /* a throwing handler must not kill the poller */
      }
    }
  }

  isDown(vk) {
    return (this.api.getAsyncKeyState(vk) & 0x8000) !== 0;
  }

  /**
   * Synthesize a combo so the loop can be tested without a human pressing keys.
   * The keys are held for a few poll intervals: a press/release inside one 40 ms tick
   * would never be observed by GetAsyncKeyState.
   */
  async simulate(combo, holdMs = 120) {
    if (this.api === null) throw new Error('hotkey poller is not running');
    const binding = parseBinding(combo);
    const press = (vk) => this.api.keybdEvent(vk, 0, 0, 0);
    const release = (vk) => this.api.keybdEvent(vk, 0, KEYEVENTF_KEYUP, 0);
    for (const mod of binding.mods) press(mod);
    press(binding.vk);
    await new Promise((resolve) => setTimeout(resolve, holdMs));
    release(binding.vk);
    for (const mod of [...binding.mods].reverse()) release(mod);
    await new Promise((resolve) => setTimeout(resolve, holdMs));
  }
}
