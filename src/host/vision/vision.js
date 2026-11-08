/**
 * Vision state machine.
 *
 * Modes, per the user's spec:
 *   privacy  — a plugin-side capture lock: both sources stop, in-flight captures are cancelled and
 *              every agent capture is refused. It never switches an OBS scene; only the user can
 *              leave it, and the previous source/scene is restored on the way out.
 *   watch    — the desktop source (ffmpeg ddagrab / storyboards); never requires OBS.
 *   scene    — the OBS source: continuously watch one selected scene through the virtual camera,
 *              even when that app is in the background.
 *
 * `source` is the model-facing spelling of the non-privacy modes: watch → desktop, scene → obs.
 */
export const VISION_MODES = ['privacy', 'scene', 'watch'];

/** The two watch sources share one capture capability. */
export const VISION_SOURCES = ['desktop', 'obs'];

/** Map a non-privacy mode onto its source. Privacy reports the source it will restore. */
export function sourceOfMode(mode, fallback = 'watch') {
  const value = mode === 'privacy' ? fallback : mode;
  return value === 'scene' ? 'obs' : 'desktop';
}

export class VisionMode {
  constructor({ initial = 'watch', scene = '' } = {}) {
    this.mode = VISION_MODES.includes(initial) ? initial : 'watch';
    // Remember the last scene across restarts so mode=scene can reuse it without an argument.
    this.scene = typeof scene === 'string' ? scene : '';
  }

  /** Agents may enter privacy, but only the user can leave it. */
  canAgentEnter(nextMode) {
    if (this.mode === 'privacy') return false;
    return VISION_MODES.includes(nextMode);
  }

  /** User-initiated switches (hotkey / settings) are always allowed. */
  userSet(nextMode, scene = '') {
    if (!VISION_MODES.includes(nextMode)) throw new Error(`unknown vision mode: ${nextMode}`);
    this.mode = nextMode;
    if (nextMode === 'scene') this.scene = scene;
    return this.snapshot();
  }

  /** Agent-initiated switches. Returns null when the transition is refused. */
  agentSet(nextMode, scene = '') {
    if (!this.canAgentEnter(nextMode)) return null;
    return this.userSet(nextMode, scene);
  }

  snapshot() {
    return { mode: this.mode, scene: this.scene, locked: this.mode === 'privacy' };
  }
}
