/**
 * Vision mode state machine.
 *
 * Three modes, per the user's spec:
 *   privacy  — OBS is switched to the privacy scene (black). Agents may enter, never leave.
 *   scene    — agents switch OBS scenes to "take a look" at one app, even when it is in the
 *              background; frames come from the OBS virtual camera.
 *   watch    — long-context viewing (movies, books, games) via ffmpeg ddagrab, never OBS.
 */
export const VISION_MODES = ['privacy', 'scene', 'watch'];

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
