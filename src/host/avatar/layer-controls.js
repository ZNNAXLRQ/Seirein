/** layer-controls — extracted from index.js; no host entry dependency. */
import { VTS_OFFSCREEN } from './spout-layer/vts-window.mjs';
import { WPF_OFFSCREEN } from './avatarLayer.js';
import { isCaptureRect } from './avatarLayer.js';
import { normalizeGeometry } from '../subtitle/geometry.js';

/**
 * The two transparent-layer backends. `wpf` (PrintWindow mirror) stays the default; `spout`
 * (Electron display process) is an explicit, user-selected alternative.
 */
export const LAYER_BACKENDS = ['wpf', 'spout'];


/** Stored backend choice; anything missing/unknown reads as the default WPF backend. */
export function normalizeLayerBackend(value) {
  return value === 'spout' ? 'spout' : 'wpf';
}


/**
 * Settings handed to `SpoutLayer`. An edit session persists its final rectangle as
 * `layer.spout.bounds` (settings.json); that wins over the stage-0 `spoutLayer.bounds` and the
 * WPF `layerGeometry` fallback, which stays untouched for the WPF backend.
 */
export function spoutLayerSettings({ saved = {}, layer = {}, layerGeometry = null } = {}) {
  const stored = layer?.spout?.bounds ?? null;
  return {
    ...saved,
    ...(stored === null ? {} : { bounds: stored }),
    layerGeometry: saved?.bounds ?? saved?.layerGeometry ?? layerGeometry,
  };
}


/**
 * Bounds an edit result must satisfy to be treated as the user's window: large enough to be the
 * model picture, small enough not to be a corrupted read, and a plausible window aspect ratio.
 * Screen coordinates are NOT part of this: a monitor left of or above the primary has negative
 * x/y and is a perfectly valid place for the layer.
 */
export const EDIT_GEOMETRY_LIMITS = Object.freeze({
  minSize: 200,
  maxSize: 4000,
  minAspect: 0.2,
  maxAspect: 5,
});


/**
 * Validate the VTS client rectangle read back when an edit session ends.
 * A failed/timed-out read has no rectangle and is `GEOMETRY_READ_FAILED`; a rectangle parked at a
 * known capture position is `GEOMETRY_CAPTURE_POSITION` (origin only, like `isCaptureRect`).
 * Returns `{ ok, reason, rect }`, with `rect` in the `{x,y,width,height}` capture/display shape.
 */
export function validateEditGeometry(value, { captureRects = [WPF_OFFSCREEN] } = {}) {
  const normalized = normalizeGeometry(value);
  if (normalized === null) return { ok: false, reason: 'GEOMETRY_READ_FAILED', rect: null };
  const rect = { x: normalized.left, y: normalized.top, width: normalized.width, height: normalized.height };
  const { minSize, maxSize, minAspect, maxAspect } = EDIT_GEOMETRY_LIMITS;
  if (rect.width < minSize || rect.height < minSize || rect.width > maxSize || rect.height > maxSize) {
    return { ok: false, reason: 'GEOMETRY_SIZE_INVALID', rect };
  }
  const aspect = rect.width / rect.height;
  if (aspect < minAspect || aspect > maxAspect) return { ok: false, reason: 'GEOMETRY_ASPECT_INVALID', rect };
  for (const capture of captureRects ?? []) {
    if (isCaptureRect(rect, capture)) return { ok: false, reason: 'GEOMETRY_CAPTURE_POSITION', rect };
  }
  return { ok: true, reason: '', rect };
}


/**
 * Single-owner switch between the two transparent-layer backends.
 *
 * The switch branches on the TARGET state, never on "always settle then re-enter":
 *   edit -> edit   keep VTS visible, hand the open session to the target backend. No display
 *                  process is started, VTS is not parked/hidden (that is the flash the old
 *                  start-then-enter sequence caused).
 *   settle -> settle / edit -> settle
 *                  confirm the old display exited, align VTS for the target, persist
 *                  `layer.backend`, then start the target display at the common rectangle the old
 *                  one occupied (click-through settles again).
 *   settle -> edit
 *                  confirm the old display exited, enter the target's edit session (VTS visible).
 *                  No display process is started just to be stopped again.
 * A failure restores the ORIGINAL backend and the ORIGINAL edit state (never "always settle"),
 * with an explicit code: LAYER_STOP_UNCONFIRMED, LAYER_START_FAILED or LAYER_EDIT_HANDOFF_FAILED.
 * Dependencies are injected so the branching is testable without spawning Electron or PowerShell.
 */
export function createLayerBackendSwitch({
  read = () => ({}),
  write = () => {},
  probeSpout = async () => ({ ok: true }),
  // The user-view edit state, read BEFORE the old backend is touched.
  isEditing = () => false,
  /**
   * Leave the old session. `options.keepVts` is true for an edit -> edit handover: VTS must stay
   * exactly where it is (a hiding/parking exit would make the window flash).
   */
  stopEdit = async () => ({ confirmed: true }),
  // Open the user's edit session on the NEW backend (settle -> edit).
  enterEdit = async () => ({ ok: true }),
  /**
   * Hand an already-open session to the target backend (edit -> edit): adopt `bounds`, do not
   * move VTS and do not start a display. Falls back to `enterEdit` when not injected.
   */
  handoffEdit = null,
  /** The running display's on-screen rectangle, so the target starts where the old one was. */
  boundsOf = null,
  stopWpf = async () => ({ confirmed: true }),
  startWpf = async () => ({ ok: true }),
  stopSpout = async () => ({ confirmed: true }),
  startSpout = async () => ({ ok: true }),
  // Step: move/restore the real VTS window for the target backend. `vts.move(rect)` is the WPF
  // capture corner; `vts.hide()` is Spout's own hide (it captures the rectangle to restore later).
  vts = null,
  wpfOffscreen = WPF_OFFSCREEN,
  spoutOffscreen = VTS_OFFSCREEN,
  alignVts = null,
} = {}) {
  let busy = null;
  const backend = () => normalizeLayerBackend(read()?.layer?.backend);
  const switching = () => busy !== null;
  const stopOf = (which) => (which === 'spout' ? stopSpout : stopWpf);
  const startOf = (which) => (which === 'spout' ? startSpout : startWpf);
  const label = (which) => (which === 'spout' ? 'Spout' : 'WPF');
  const writeBackend = (which) => write({ layer: { ...(read()?.layer ?? {}), backend: which } });

  /** Step: align VTS for the target. Never throws: a missing VTS is reported, never fatal. */
  async function alignFor(target, bounds = null) {
    if (typeof alignVts === 'function') {
      try {
        return await alignVts(target, bounds);
      } catch (error) {
        return { ok: false, code: 'VTS_ALIGN_FAILED', error: error?.message ?? String(error) };
      }
    }
    if (vts === null) return { ok: true, skipped: true };
    try {
      if (target === 'wpf') return await vts.move({ ...wpfOffscreen,
        ...(bounds ? { width: bounds.width, height: bounds.height } : {}),
      });
      if (typeof vts.hide === 'function') return await vts.hide();
      return await vts.move({ ...spoutOffscreen });
    } catch (error) {
      return { ok: false, code: 'VTS_ALIGN_FAILED', error: error?.message ?? String(error) };
    }
  }

  /**
   * Put the ORIGINAL backend back into the state the user had before this switch: an open edit
   * session stays an edit session, a settled layer stays settled. Best effort: the result says
   * what was really restored.
   */
  async function restoreOriginal(which, wasEditing, { handoff = false } = {}) {
    if (wasEditing !== true) {
      let started;
      try {
        started = await startOf(which)({});
      } catch (error) {
        started = { ok: false, error: error?.message ?? String(error) };
      }
      return { ok: started?.ok === true, editMode: false, error: started?.error ?? '' };
    }
    let entered;
    try {
      entered = handoff === true && typeof handoffEdit === 'function'
        ? await handoffEdit(which, null)
        : await enterEdit(which);
    } catch (error) {
      entered = { ok: false, error: error?.message ?? String(error) };
    }
    return { ok: entered?.ok === true, editMode: entered?.ok === true, error: entered?.error ?? '' };
  }

  async function set(target) {
    if (!LAYER_BACKENDS.includes(target)) {
      return {
        ok: false,
        code: 'LAYER_BACKEND_INVALID',
        error: `未知透明层后端：${String(target)}`,
        backend: backend(),
        switching: false,
      };
    }
    // Claim the slot synchronously, BEFORE the first await: two concurrent requests must not both
    // pause on the Spout probe and then both stop/start a backend. `finally` releases it on every
    // path (success, refusal, throw).
    if (busy !== null) {
      return {
        ok: false,
        code: 'LAYER_SWITCH_IN_PROGRESS',
        error: '正在切换，请稍候',
        backend: backend(),
        switching: true,
      };
    }
    const current = backend();
    if (target === current) {
      return { ok: true, already: true, backend: current, switching: false, editMode: isEditing() === true };
    }
    busy = target;
    // The user's edit state survives a backend change: record it before the probe or the old
    // backend's session is touched, so the target state is the target state.
    const wasEditing = isEditing() === true;
    const targetEditing = wasEditing;
    try {
      // Availability first: the old backend keeps running when the target cannot be used.
      if (target === 'spout') {
        let probe;
        try {
          probe = await probeSpout();
        } catch (error) {
          probe = { ok: false, code: 'SPOUT_PROBE_FAILED', message: error?.message ?? String(error) };
        }
        if (probe?.ok !== true) {
          return {
            ok: false,
            code: probe?.code ?? 'SPOUT_UNAVAILABLE',
            error: `Spout 未就绪：${probe?.message ?? '不可用'}`,
            backend: current,
            switching: false,
            editMode: wasEditing,
            unavailable: true,
          };
        }
      }
      // The running display's rectangle, read BEFORE the stop: a settled switch presents the new
      // display at the same place instead of at that backend's stale saved rectangle.
      let common = null;
      if (typeof boundsOf === 'function') {
        try {
          common = await boundsOf(current);
        } catch {
          common = null;
        }
      }
      // 1a. Leave edit mode FIRST: a still-interactive old window must not be killed mid-session.
      //     In a handover the exit keeps VTS visible; it never autostarts a display either.
      let exited = { confirmed: true, skipped: true };
      try {
        exited = await stopEdit(current, { keepVts: targetEditing });
      } catch (error) {
        exited = { confirmed: false, error: error?.message ?? String(error) };
      }
      // 1b. Stop the old backend and require an observed exit, not just a stop request.
      let stopped;
      try {
        stopped = await stopOf(current)();
      } catch (error) {
        stopped = { confirmed: false, error: error?.message ?? String(error) };
      }
      if (stopped?.confirmed !== true) {
        // The original edit state is restored too: a failed switch is never "always settle".
        const restored = await restoreOriginal(current, wasEditing);
        return {
          ok: false,
          code: 'LAYER_STOP_UNCONFIRMED',
          error: `旧后端（${label(current)}）未能确认退出，已恢复原模式`,
          backend: current,
          switching: false,
          editMode: restored.editMode,
          restored: restored.ok,
        };
      }
      // 2. edit -> edit: hand the session over. No alignment (parking VTS would hide the window
      //    being edited), no display start, no hide/restore flash.
      if (targetEditing === true) {
        const bounds = exited?.bounds ?? common ?? null;
        writeBackend(target);
        let handed;
        try {
          handed = typeof handoffEdit === 'function'
            ? await handoffEdit(target, bounds)
            : await enterEdit(target);
        } catch (error) {
          handed = { ok: false, code: 'EDIT_HANDOFF_FAILED', error: error?.message ?? String(error) };
        }
        if (handed?.ok !== true) {
          writeBackend(current);
          const restored = await restoreOriginal(current, true, { handoff: true });
          return {
            ok: false,
            code: 'LAYER_EDIT_HANDOFF_FAILED',
            error: `未能把编辑会话交给 ${label(target)}：${handed?.error ?? handed?.code ?? '未知错误'}`,
            backend: current,
            switching: false,
            editMode: restored.editMode,
            restored: restored.ok,
            handedOff: false,
          };
        }
        return {
          ok: true,
          backend: target,
          editMode: true,
          editBackend: target,
          switching: false,
          handedOff: true,
          bounds: handed.bounds ?? bounds,
          vts: { ok: true, skipped: true, keptVisible: true, bounds },
        };
      }
      // 3. Settled target: align VTS, persist, start the target display at the common rectangle.
      const aligned = await alignFor(target, common);
      writeBackend(target);
      let started;
      try {
        started = await startOf(target)({ bounds: common });
      } catch (error) {
        started = { ok: false, code: 'LAYER_START_FAILED', error: error?.message ?? String(error) };
      }
      if (started?.ok !== true) {
        // The new backend could not run: restore the ORIGINAL backend and its original edit state.
        writeBackend(current);
        const restored = await restoreOriginal(current, wasEditing);
        return {
          ok: false,
          code: started?.code ?? 'LAYER_START_FAILED',
          error: `启用 ${label(target)} 失败：${started?.error ?? '未知错误'}`,
          backend: current,
          switching: false,
          editMode: restored.editMode,
          restored: restored.ok,
          rollback: restored.ok === true,
          vts: aligned,
        };
      }
      return {
        ...started,
        ok: true,
        backend: target,
        editMode: false,
        editBackend: null,
        switching: false,
        bounds: common,
        vts: aligned,
      };
    } finally {
      busy = null;
    }
  }

  return { set, backend, switching };
}


/**
 * Route the `layerEdit` hotkey to the ACTIVE backend only.
 *
 * The binding is per backend and mutually exclusive:
 *   Spout: edit ↔ display process   (enter stops it and shows VTS; exit reads VTS, hides it and
 *                                    starts the display process in that rectangle)
 *   WPF:   edit ↔ transparent layer (enter stops it and shows VTS; exit hides VTS and starts the
 *                                    mirror from the capture corner)
 *
 * Exactly one layer may hold the edit session. The adapter is selected from `read().layer.backend`
 * on EVERY call — never from the other side's state — so backend=spout can never start WPF. The
 * inactive one is never messaged and never subscribed: this controller registers no listener at
 * all. Leaving Spout edit mode persists the final rectangle as `layer.spout.bounds`; the WPF
 * backend keeps its own `layerGeometry` key. `layers` is injected as
 * `{ wpf: { editing, enter, exit }, spout: { editing, enter, exit } }` (a `setEditMode(bool)`
 * adapter is still accepted so older callers keep working) and is fully testable without spawning
 * PowerShell or Electron.
 */
export function createLayerEditController({ read = () => ({}), write = () => {}, log = null, layers = {} } = {}) {
  let editBackend = null;
  const backend = () => normalizeLayerBackend(read()?.layer?.backend);
  const layerOf = (which) => layers[which] ?? null;
  const editingOf = (which) => {
    const layer = layerOf(which);
    if (layer === null) return false;
    if (typeof layer.editing === 'function') return layer.editing() === true;
    return layer.editMode === true;
  };
  /** The backend that really holds a session, whichever one the settings currently name. */
  const liveBackend = () => LAYER_BACKENDS.find((which) => editingOf(which)) ?? null;

  /** Which backend really holds the session (the layer's own state, never the other side). */
  const status = () => {
    const which = backend();
    const editMode = editingOf(which);
    return { editMode, editBackend: editMode ? which : null };
  };

  /** `{x,y,width,height}` → `layer.spout.bounds`; a useless rectangle is not written. */
  const persistSpoutBounds = (bounds) => {
    const rect = {
      x: Number(bounds?.x),
      y: Number(bounds?.y),
      width: Number(bounds?.width),
      height: Number(bounds?.height),
    };
    if (!Object.values(rect).every(Number.isFinite) || rect.width < 1 || rect.height < 1) return null;
    const rounded = {
      x: Math.round(rect.x), y: Math.round(rect.y),
      width: Math.round(rect.width), height: Math.round(rect.height),
    };
    const layer = { ...(read()?.layer ?? {}) };
    layer.spout = { ...(layer.spout ?? {}), bounds: rounded };
    write({ layer });
    return rounded;
  };

  async function enterLayer(layer) {
    if (typeof layer.enter === 'function') return layer.enter();
    return layer.setEditMode(true);
  }

  async function exitLayer(layer, options = {}) {
    if (typeof layer.exit === 'function') return layer.exit(options);
    return layer.setEditMode(false, options);
  }

  async function doEnter() {
    const which = backend();
    const layer = layerOf(which);
    if (layer === null) {
      return { ok: false, code: 'LAYER_NOT_AVAILABLE', backend: which, editMode: false, editBackend: null };
    }
    // Strict single ownership: a session left open by the other backend is a conflict, never a
    // reason to start a second display. The switch path is the one that closes it first.
    const other = liveBackend();
    if (other !== null && other !== which) {
      return {
        ok: false,
        code: 'LAYER_CONFLICT',
        error: `${other === 'wpf' ? 'WPF' : 'Spout'} 仍在编辑模式，请先退出`,
        backend: which,
        editMode: true,
        editBackend: other,
      };
    }
    let result;
    try {
      result = await enterLayer(layer);
    } catch (error) {
      result = { ok: false, code: 'EDIT_FAILED', error: error?.message ?? String(error) };
    }
    if (result?.ok !== true) {
      return { ok: false, code: result?.code ?? 'EDIT_ENTER_FAILED', backend: which, editMode: false, editBackend: null };
    }
    editBackend = which;
    await log?.emit?.('layer.edit.enter', { backend: which });
    return { ok: true, backend: which, editMode: true, editBackend: which };
  }

  /** Leave edit mode and report the final rectangle. Idle is a no-op. */
  async function doExit(options = {}) {
    const which = editBackend ?? liveBackend();
    if (which === null) {
      return { ok: true, skipped: true, backend: backend(), editMode: false, editBackend: null };
    }
    editBackend = null;
    const layer = layerOf(which);
    let result = { ok: false };
    if (layer !== null) {
      try {
        result = await exitLayer(layer, options);
      } catch (error) {
        result = { ok: false, code: 'EDIT_FAILED', error: error?.message ?? String(error) };
      }
    }
    // A backend that validated + committed its own rectangle reports `geometryCommitted`; the
    // legacy Spout persistence is only the fallback for callers that do not run the host commit.
    // A handover (`keepVts`) never writes geometry: the target backend adopts the session instead.
    const handover = options?.keepVts === true;
    const bounds = result?.geometryCommitted === true
      ? (result?.bounds ?? null)
      : ((handover !== true && which === 'spout' ? persistSpoutBounds(result?.bounds) : null) ?? result?.bounds ?? null);
    await log?.emit?.('layer.edit.exit', { backend: which, bounds });
    return {
      ok: result?.ok === true,
      code: result?.code,
      error: result?.error,
      backend: which,
      editMode: false,
      editBackend: null,
      bounds,
      geometryRejected: result?.geometryRejected === true,
    };
  }

  // One operation of EACH kind at a time, serialized in call order. Duplicate enters (double
  // hotkey) and duplicate exits (shutdown `Promise.all`) share their own in-flight promise, but an
  // enter and an exit never reuse each other: a close during a pending enter must wait for the
  // enter and then really exit. Reusing the enter promise returned "done" while the layer was
  // still interactive.
  let entering = null;
  let exiting = null;
  let queue = Promise.resolve();
  const run = (kind, work) => {
    const running = kind === 'enter' ? entering : exiting;
    if (running !== null) return running;
    // Clear the slot INSIDE the chained work, before `tracked` settles: a caller that awaits it
    // (or a close that arrives right after) always sees a free slot and never a stale promise.
    const tracked = queue.then(async () => {
      try {
        return await work();
      } finally {
        if (kind === 'enter') entering = null;
        else exiting = null;
      }
    });
    queue = tracked.catch(() => {});
    if (kind === 'enter') entering = tracked;
    else exiting = tracked;
    return tracked;
  };
  const enter = () => run('enter', doEnter);
  const exit = (options = {}) => run('exit', () => doExit(options));

  return { toggle: async () => (status().editMode ? exit() : enter()), enter, exit, close: exit, status };
}
