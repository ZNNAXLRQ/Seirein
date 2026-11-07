/**
 * Spout display layer control (phase 0).
 *
 * The display window is an independent Electron runtime the user configures explicitly. DSH's
 * own executable is never used as a launcher: its main process is the Harness, not this layer,
 * so falling back to `process.execPath` would start the wrong program (§6.1 of the design doc).
 *
 * Scope of this module, deliberately narrow:
 *   - validate `runtime.spoutLayer.electronExecutable` (absolute, exists, not us, Electron >= 28);
 *   - spawn the layer with an attribution key, an isolated user-data dir and a clean env;
 *   - parse its `ready`/`error` stdout lines into a synchronous snapshot;
 *   - stop it by closing stdin, then kill the tree only after the 3 s grace and only when the
 *     recorded PID + process creation time still identify our own process;
 *   - sweep a previous generation by the same attribution rule (never by image name or command
 *     line: that would kill a layer belonging to another instance).
 *
 * Not here, by design: no Spout texture receiving, no backend switch, no automatic fallback.
 * The WPF transparent layer (`avatarLayer.js`) stays the default backend.
 *
 * Edit mode is a VTS-window session, not an overlay session: entering it stops the display process
 * and puts the real VTube Studio window back on screen (its own geometry), so the user drags and
 * resizes *VTS*. Leaving it reads that window's rectangle, parks VTS off screen and starts the
 * display process in exactly that rectangle. The display process and the visible VTS window are
 * therefore mutually exclusive, and leaving edit mode never requires a manual「启动」.
 */
import { execFile, spawn } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { VTS_OFFSCREEN, VTS_ONSCREEN } from './spout-layer/vts-window.mjs';

/**
 * Recommended / verified Electron major. Not a gate: any major >= MIN_ELECTRON_MAJOR is accepted,
 * and a major far above this one is accepted with a WARN event instead of being refused.
 */
export const PINNED_ELECTRON_MAJOR = 44;
/** Lowest Electron major that still carries every API the layer uses; older runtimes are refused. */
export const MIN_ELECTRON_MAJOR = 28;
/** Recommended / verified Electron version for this phase; it is advisory, never a threshold. */
export const PINNED_ELECTRON_VERSION = '44.7.0';
/** Majors above `PINNED_ELECTRON_MAJOR + this` pass but record `electron.version.unpinned`. */
const UNPINNED_MAJOR_DELTA = 3;
/** Receiver watchdog default when the settings do not override it. */
export const DEFAULT_RECEIVER_TIMEOUT_MS = 5000;
/** Sender default; matches the VTS Spout2 output name in the design doc. */
export const DEFAULT_SENDER = 'VTubeStudioSpout';
/** How long a registered receiver waits for the sender before SENDER_NOT_FOUND. */
export const DEFAULT_SENDER_TIMEOUT_MS = 30_000;
/**
 * Delays before each retry of a failed VTS hide (300 / 800 / 1500 ms). Three attempts is the whole
 * budget: a window that is not there yet usually is within a second, and beyond that the correct
 * behaviour is an explicit failure, not an endless re-park loop.
 */
export const VTS_HIDE_RETRY_DELAYS_MS = Object.freeze([300, 800, 1500]);
/** Keep the last N startup logs: enough to compare a failure with the run before it. */
const DIAGNOSTICS_KEEP = 20;
/**
 * `spoutLayer.info` is a status channel, not an audit trail. The texture loop emits the same two
 * status lines ~60 times a second, and at 38k lines per 10 MB rotation they pushed speech/memory/
 * tool timing out of the event log. Identical messages are therefore recorded once per window.
 */
export const INFO_THROTTLE_MS = 60_000;
/** `info` lines that report a failure are never coalesced: a failure must stay on disk verbatim. */
const INFO_FAILURE_PATTERN = /(?:fail(?:ed|ure)?|error|timed?\s*out|timeout|unavailable)/iu;

const VERSION_TIMEOUT_MS = 3000;
const CREATED_TOLERANCE_MS = 1000;
/**
 * Host dispose budget used when `stop()` is called without an explicit `deadlineAt`: the Host
 * force-exits at 5 s (`PROCESS_SHUTDOWN_TIMEOUT_MS`), leaving 4 s for this item plus its exit
 * path. Never append a per-phase budget on top of this — every phase spends from the same deadline.
 */
export const DEFAULT_STOP_DEADLINE_MS = 4000;
/** Scheduling tolerance for "returned in time"; it never extends the shared deadline itself. */
const STOP_DEADLINE_SLACK_MS = 150;
/** Ack wait inside the remaining budget; if the peer cannot parse `shutdown`, stdin EOF follows. */
const STOP_ACK_WINDOW_MS = 250;
/** Force-kill time reserved *inside* the deadline, so the kill has time to be confirmed. */
const STOP_FORCE_RESERVE_MAX_MS = 1000;
const STOP_FORCE_RESERVE_MIN_MS = 100;
/** Runtime descendant scan (a slow WMI call), deliberately done while the layer is running. */
const OWNERSHIP_SCAN_TIMEOUT_MS = 5000;
/** How long `setEditMode()` waits for the layer's enter/exit diagnostic before reporting a timeout. */
const EDIT_ACK_TIMEOUT_MS = 750;
const DEFAULT_MAIN = fileURLToPath(new URL('./spout-layer/main.js', import.meta.url));

/** `{width,height}` | `"978x844"` | `"978"` → `{width,height}`; invalid → null. */
export function normalizeSize(raw) {
  if (raw === null || raw === undefined) return null;
  let width = 0;
  let height = 0;
  if (typeof raw === 'object') {
    width = Number(raw.width ?? raw.w);
    height = Number(raw.height ?? raw.h);
  } else {
    const match = String(raw).trim().match(/^(\d+)\s*[x×,]\s*(\d+)$/iu);
    if (match !== null) {
      width = Number(match[1]);
      height = Number(match[2]);
    } else {
      const value = Number(raw);
      if (Number.isFinite(value) && value > 0) {
        width = value;
        height = value;
      }
    }
  }
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { width: Math.min(16384, Math.round(width)), height: Math.min(16384, Math.round(height)) };
}

/** Keep a diagnostic string short enough to live inside /assistant/status. */
function clipText(value, max = 400) {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

/** `spout.edit.*` payload → `{x,y,width,height}` (the `layer.spout.bounds` shape), or null. */
function editRectFrom(payload) {
  const value = payload?.bounds ?? payload;
  if (value === null || typeof value !== 'object') return null;
  const x = Number(value.x ?? value.left);
  const y = Number(value.y ?? value.top);
  const width = Number(value.width);
  const height = Number(value.height);
  if (![x, y, width, height].every((part) => Number.isFinite(part))) return null;
  if (width <= 0 || height <= 0) return null;
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}

/** Normalize a VTS window rectangle; accepts both `{x,y}` and `{left,top}`, null when invalid. */
function vtsRect(value) {
  if (value === null || typeof value !== 'object') return null;
  return editRectFrom(value);
}

/**
 * A rectangle the user can actually see. Both backends park VTS at the same far corner
 * (`VTS_OFFSCREEN` / `WPF_OFFSCREEN` = -2200,-1400); that origin is the "not editable" marker.
 * Only that corner is treated as hidden — an ordinary negative coordinate can be a monitor to the
 * left of the primary one and must stay a valid restore target.
 */
function visibleVtsRect(value) {
  const rect = vtsRect(value);
  if (rect === null) return null;
  const parked = rect.x <= -2000 && rect.y <= -1200;
  return parked ? null : rect;
}

/** `v44.7.0` / `Electron 44.7.0` / `44.7.0` → `44.7.0`; anything else → ''. */
function normalizeVersion(raw) {
  const text = String(raw ?? '');
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  for (const line of lines.reverse()) {
    const match = line.match(/(\d+)\.(\d+)\.(\d+)/u);
    if (match !== null) return `${match[1]}.${match[2]}.${match[3]}`;
  }
  return '';
}

/** Two ISO timestamps are the same process when they agree within the attribution tolerance. */
function sameInstant(left, right, toleranceMs = CREATED_TOLERANCE_MS) {
  const a = Date.parse(String(left));
  const b = Date.parse(String(right));
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return Math.abs(a - b) <= toleranceMs;
}

export class SpoutLayer {
  /**
   * @param {object} options
   * @param {string} options.root - plugin instance root.
   * @param {() => object} options.settings - reads `runtime.spoutLayer`.
   * @param {object} [options.log] - EventLog-like `{ emit }`.
   * @param {string} [options.mainPath] - layer entry; overridable for tests.
   * @param {{capture:Function, move:Function}|null} [options.vtsWindow] - real VTS window controller;
   *   production injects `VtsWindow`, tests inject a recorder, `null` disables window control.
   *   With a controller, edit mode is the VTS-window session described in the module header: the
   *   display process is stopped and VTS is the editable surface. Without one, nothing can move
   *   VTS, so the display window keeps its own drag/resize edit mode instead.
   * @param {number} [options.infoThrottleMs] - same-message `info` window (default 60 s); tests use
   *   a short window to observe the coalesced count without waiting a minute.
   * @param {'spout'|'wpf'} [options.backend] - the backend this instance belongs to, as reported by
   *   `snapshot().backend`. Defaults to `spout`; a WPF instance is only ever constructed with an
   *   explicit `backend`, so status can never claim one backend while the other is running.
   * @param {number[]} [options.vtsHideRetryDelays] - finite retry budget after a failed hide; the
   *   defaults (300/800/1500 ms) are the production schedule, tests pass a compressed one.
   * @param {{setTimeout:Function, clearTimeout:Function}} [options.timers] - scheduler override for
   *   deterministic tests; production uses the globals.
   */
  constructor({
    root,
    settings,
    log = null,
    mainPath = DEFAULT_MAIN,
    spawnProcess = spawn,
    vtsWindow = null,
    infoThrottleMs = INFO_THROTTLE_MS,
    backend = 'spout',
    vtsHideRetryDelays = VTS_HIDE_RETRY_DELAYS_MS,
    timers = null,
  }) {
    this.root = root;
    this.readSettings = typeof settings === 'function' ? settings : () => ({});
    this.log = log;
    this.mainPath = mainPath;
    this.spawnProcess = spawnProcess;
    this.vtsWindow = vtsWindow;
    /** What this instance really is; `snapshot().backend` reads it instead of a literal. */
    this.backend = backend === 'wpf' ? 'wpf' : 'spout';
    const delays = Array.isArray(vtsHideRetryDelays)
      ? vtsHideRetryDelays.map((value) => Math.round(Number(value))).filter((value) => Number.isFinite(value) && value >= 0)
      : [];
    /** Retry schedule after a failed hide; finite by design — no endless re-parking. */
    this.vtsRetryDelays = delays.length > 0 ? delays : [...VTS_HIDE_RETRY_DELAYS_MS];
    this.setTimeoutFn = typeof timers?.setTimeout === 'function'
      ? timers.setTimeout
      : (callback, ms) => setTimeout(callback, ms);
    this.clearTimeoutFn = typeof timers?.clearTimeout === 'function'
      ? timers.clearTimeout
      : (handle) => clearTimeout(handle);

    this.dir = join(root, 'cache', 'spout-layer');
    this.userDataDir = join(this.dir, 'user-data');
    this.sessionFile = join(this.dir, 'session.json');
    this.diagnosticsDir = join(this.dir, 'diagnostics');
    // Stable per-root instance id: two instances sharing a data root would fight over one window,
    // so the attribution key must not depend on the host PID (which changes on every restart).
    this.instance = createHash('sha1').update(String(root)).digest('hex').slice(0, 8);

    this.child = null;
    this.pid = 0;
    this.lastPid = 0;
    this.created = '';
    this.startedAt = 0;
    this.stoppedAt = 0;
    this.readyPhase = '';
    this.lastReportAt = 0;
    this.versions = null;
    this.display = null;
    this.error = null;
    this.stderr = '';
    this.tail = [];
    this.lastExit = null;
    this.generation = 0;
    /** A stop that could not confirm the process tree is gone; the record must stay on disk. */
    this.stopFailed = false;
    /**
     * Ownership captured *while the layer is running*: pid + OS creation time + root name + the
     * descendant snapshot. `stop()` reads this record instead of starting a cold WMI query at
     * shutdown (which alone cost up to 5.5 s on Windows).
     */
    this.ownership = null;
    this.ownershipScan = null;
    /** True while `stop()` is awaiting the exit; `attach`'s close handler must not erase the pid. */
    this.stopping = false;
    /** Stage timestamps for the current stop (merged into `stop()`'s result and events). */
    this.stopStages = null;
    this.shutdownAck = null;
    this.shutdownReport = null;
    this.pendingAck = null;
    this.stopSeq = 0;
    this.cleanup = null;
    this.receiverMs = 0;
    this.diagnosticsFile = '';
    /** Geometry asked of the display process, and where it came from (`argument`/`fallback`/`action`). */
    this.bounds = null;
    this.boundsSource = '';
    this.windowBounds = null;
    /** Last receiver report: `{ registered, connected, sender, surface, platform, at }`. */
    this.receiver = null;
    this.sender = '';
    this.senderWaitMs = 0;
    /** Renderer-side Electron shared-texture receiver + delivery counters (from ready lines). */
    this.sharedTextureRegistered = false;
    this.textureTimeouts = 0;
    this.lastTextureSendMs = 0;
    this.textureFrames = 0;
    this.texturePush = '';
    /** Last frame size reported by the display process and the stable (presentation) size. */
    this.textureSize = null;
    this.srcChanges = 0;
    /** Last 1 Hz renderer health line: `{ fps, width, height, drawn, placeholder, at }`. */
    this.health = null;
    /** Last stage-2 diagnostic from the display process:
     * `{ fps, dropped, resized, alphaMode, at }` (throttled to <= 1 Hz in the renderer).
     */
    this.stage2 = null;
    /** Last receiver-side alpha sample (`{total,alphaZero,alphaOpaque,alphaPartial,verdict}`). */
    this.alphaSample = null;
    /** Layer-internal edit mode, mirrored from `spout.edit.*` diagnostics. */
    this.editMode = false;
    /**
     * Host-side edit session (VTS is the editable surface, the display process is stopped). Kept
     * apart from `editMode` above, which is the layer's own drag/resize mode. At most one of the
     * two, and at most one display process, is ever active.
     */
    this.editing = false;
    /**
     * Start the display process when the edit session ends. The host clears it only around a stop
     * it is about to perform (shutdown / manual stop), so no display is spawned just to be killed.
     */
    this.autostartOnEditExit = true;
    /** Last edit-mode rectangle in the `layer.spout.bounds` shape (`{x,y,width,height}`). */
    this.editRect = null;
    this.editSeq = 0;
    /**
     * Where VTS was moved to be captured (the shared off-screen corner). Kept apart from every
     * user-facing rectangle: it is never returned as `bounds` and never written to settings.
     */
    this.captureRect = null;
    /** Pending `setEditMode()` request: `{ enabled, resolve, timer }`. */
    this.pendingEdit = null;
    /** Geometry of the real VTS window before Spout hid it. */
    this.vtsOriginal = null;
    this.vtsHidden = false;
    this.vtsError = null;
    /**
     * VTS-hide convergence. `start()` and an edit exit each hide the real window once; VTS may not
     * have been up yet (or had no handle), and before this chain that single failure was final for
     * the whole session. The pending record is `{ generation, reason, attempts, armed, timer }`.
     */
    this.vtsHidePending = null;
    /** The chain that used up its retries: `{ code, message, attempts, reason, at }`, or null. */
    this.vtsHideFailure = null;
    /** Hide attempts in the current cycle, including the failed first one. */
    this.vtsHideAttempts = 0;
    /** Last checked hide abandoned before its move: `{reason, at}`. An abort is never a failure. */
    this.lastVtsHideAbort = null;
    /**
     * Serial chain shared by a hide retry and edit entry. A retry that has already issued its move
     * is awaited here, so an edit restore can never interleave with it; a retry that is still
     * waiting for its timer is invalidated by `registerEditRequest()` instead.
     */
    this.vtsSerial = Promise.resolve();
    /**
     * Edit entry registered synchronously (before its first await). While it is set, no hide may
     * move the window — even though `editing` only flips once the display process is confirmed
     * stopped and VTS is back on screen.
     */
    this.editRequest = null;
    this.editRequestSeq = 0;
    /**
     * Same-message `info` coalescing state: message → `{ at, suppressed }`. `infoThrottled` is the
     * cumulative count, exposed in the snapshot and carried on the next recorded line.
     */
    const throttleMs = Number(infoThrottleMs);
    this.infoThrottleMs = Number.isFinite(throttleMs) && throttleMs >= 0 ? throttleMs : INFO_THROTTLE_MS;
    this.infoThrottle = new Map();
    this.infoThrottled = 0;
  }

  /**
   * Configured stable texture size. Accepts `{width,height}` or `"978x844"` under `size` (the
   * existing spoutLayer namespace), `textureSize`, or a nested `spout.size`; `null` means "use the
   * sender's published size".
   */
  size() {
    const saved = this.readSettings() ?? {};
    return normalizeSize(saved?.size ?? saved?.textureSize ?? saved?.spout?.size);
  }

  /** The configured receiver timeout, or the default; clamped to a sane range. */
  receiverTimeout() {
    const saved = this.readSettings() ?? {};
    const raw = Number(saved?.receiverTimeoutMs);
    if (!Number.isFinite(raw)) return DEFAULT_RECEIVER_TIMEOUT_MS;
    return Math.min(120_000, Math.max(1000, Math.round(raw)));
  }

  /** Configured sender name; defaults to `VTubeStudioSpout`. */
  senderName() {
    const saved = this.readSettings() ?? {};
    const value = typeof saved?.sender === 'string' ? saved.sender.trim() : '';
    return value.length > 0 ? value : DEFAULT_SENDER;
  }

  /** Sender budget; 30 s by default, clamped like the receiver watchdog. */
  senderTimeout() {
    const saved = this.readSettings() ?? {};
    const raw = Number(saved?.senderTimeoutMs);
    if (!Number.isFinite(raw)) return DEFAULT_SENDER_TIMEOUT_MS;
    return Math.min(120_000, Math.max(1000, Math.round(raw)));
  }

  /**
   * The host-owned rectangle. `bounds` is the stage-0/2 contract; `layerGeometry` is accepted too
   * so the existing WPF field can be reused once index.js wires it into this settings function.
   */
  requestedBounds() {
    const saved = this.readSettings() ?? {};
    const value = saved?.bounds ?? saved?.layerGeometry;
    if (value === null || typeof value !== 'object') return null;
    const left = Number(value.left ?? value.x);
    const top = Number(value.top ?? value.y);
    const width = Number(value.width ?? value.w);
    const height = Number(value.height ?? value.h);
    if (![left, top, width, height].every((part) => Number.isFinite(part))) return null;
    if (width <= 0 || height <= 0) return null;
    return {
      left: Math.round(left),
      top: Math.round(top),
      width: Math.round(width),
      height: Math.round(height),
    };
  }

  /** Current rectangle in the settings shape (`{x,y,width,height}`); null before any geometry. */
  editBounds() {
    if (this.editRect !== null) return { ...this.editRect };
    const saved = this.bounds;
    return saved === null ? null : { x: saved.left, y: saved.top, width: saved.width, height: saved.height };
  }

  /** True while either edit session (VTS-window session or layer-internal drag) is open. */
  isEditing() {
    return this.editing === true || this.editMode === true;
  }

  /**
   * Last known good rectangle for a VTS window that cannot be read: the persisted
   * `layer.spout.bounds` (or stage-0 `bounds`) first, then the last rectangle the display process
   * was placed at, then the on-screen default. This is what makes edit-exit never block.
   */
  fallbackBounds() {
    const requested = this.requestedBounds();
    if (requested !== null) {
      return { x: requested.left, y: requested.top, width: requested.width, height: requested.height };
    }
    const saved = this.bounds;
    if (saved !== null) return { x: saved.left, y: saved.top, width: saved.width, height: saved.height };
    return { ...VTS_ONSCREEN };
  }

  /** Window-controller state for status: what this backend did to the real VTS window. */
  vtsSnapshot() {
    return {
      hidden: this.vtsHidden === true,
      original: this.vtsOriginal === null ? null : { ...this.vtsOriginal },
      captureRect: this.captureRect === null ? null : { ...this.captureRect },
      error: this.vtsError === null ? null : { ...this.vtsError },
    };
  }

  /** Record a window-controller failure without throwing: callers get a code, the log gets an event. */
  vtsFailure(code, message = '') {
    const error = {
      code: String(code || 'VTS_WINDOW_FAILED'),
      message: clipText(message, 240),
      at: Date.now(),
    };
    this.vtsError = error;
    void this.emitEvent('spout.vts.error', { ...error });
    return { ok: false, ...error };
  }

  /** Read the VTS client rectangle through the same helper `AvatarLayer.report()` uses. */
  async captureVts() {
    if (this.vtsWindow === null) {
      return this.vtsFailure('VTS_WINDOW_UNAVAILABLE', 'Spout 模式未注入 VTS 窗口控制器');
    }
    try {
      const result = await this.vtsWindow.capture();
      const bounds = vtsRect(result?.bounds ?? result);
      if (result?.ok === true && bounds !== null) return { ok: true, bounds };
      return this.vtsFailure(result?.code ?? 'VTS_NOT_RUNNING', result?.message ?? 'VTS 窗口不可用（未运行或找不到）');
    } catch (error) {
      return this.vtsFailure('VTS_WINDOW_FAILED', error?.message ?? String(error));
    }
  }

  /**
   * Move the real VTS window; success clears the previous window-controller error.
   *
   * `options.raise` is reserved for the edit-recovery move (VTS must come back in front of the
   * editor). Parking VTS for capture and starting a display never pass it, so those transitions
   * never steal the foreground. A window that is positioned but cannot be raised is reported as
   * `VTS_RAISE_FAILED` (with a `window.raised` event), not as a successful restore.
   */
  async moveVts(bounds, options = {}) {
    const rect = vtsRect(bounds);
    if (rect === null) return this.vtsFailure('VTS_BOUNDS_INVALID', 'VTS 窗口矩形无效');
    if (this.vtsWindow === null) {
      return this.vtsFailure('VTS_WINDOW_UNAVAILABLE', 'Spout 模式未注入 VTS 窗口控制器');
    }
    const raise = options?.raise === true;
    try {
      const result = await this.vtsWindow.move(rect, { raise });
      if (result?.ok === true) {
        // The controller re-reads the client rectangle; a plain one reports its request back.
        const actual = vtsRect(result.bounds) ?? rect;
        const raised = raise === true && result.raised !== false;
        if (raise === true) {
          await this.emitEvent('window.raised', {
            target: 'vts',
            ok: raised,
            rect: { ...actual },
            ...(raised ? {} : { code: result.raiseCode || 'VTS_RAISE_FAILED' }),
          });
        }
        if (raise === true && raised !== true) {
          return {
            ...this.vtsFailure(result.raiseCode || 'VTS_RAISE_FAILED', 'VTS 窗口已就位，但未能前置'),
            bounds: { ...actual },
            requested: rect,
          };
        }
        this.vtsError = null;
        return { ok: true, bounds: actual, requested: rect, mismatch: result.mismatch === true, raised };
      }
      const failed = this.vtsFailure(result?.code ?? 'VTS_MOVE_FAILED', result?.message ?? 'VTS 窗口移动失败');
      if (raise === true) {
        await this.emitEvent('window.raised', {
          target: 'vts',
          ok: false,
          rect: { ...rect },
          code: failed.code,
        });
      }
      return failed;
    } catch (error) {
      const failed = this.vtsFailure('VTS_MOVE_FAILED', error?.message ?? String(error));
      if (raise === true) {
        await this.emitEvent('window.raised', { target: 'vts', ok: false, rect: { ...rect }, code: failed.code });
      }
      return failed;
    }
  }

  /**
   * Park the real VTS window out of the visible area, remembering the rectangle it had.
   * The WPF mirror does this through `window-move.ps1` too, so both backends use one method.
   * A missing VTS is reported (`code: VTS_NOT_RUNNING`) but does not abort the display process.
   * Calling it twice is a no-op: leaving edit mode hides VTS and then `start()` runs.
   *
   * `options.force` ignores that no-op shortcut: the convergence check uses it because it has
   * already observed a visible window, while `vtsHidden` still describes the state this instance
   * left behind (the remembered `original` rectangle is kept — it is the edit restore target).
   * `options.shouldContinue` (the retry chain) returns '' while the hide is still valid; it is
   * checked on entry and again after the async window read, before the move. An abort moves nothing
   * and returns `{ aborted: true, reason }`.
   */
  async hideVts(original = null, options = {}) {
    const force = options?.force === true;
    // A caller that owns the hide (the retry chain) passes its liveness contract. The same check
    // runs again after the async window read, right before the move: a read that finishes late
    // must not park VTS after edit mode already took over.
    const shouldContinue = typeof options?.shouldContinue === 'function' ? options.shouldContinue : null;
    const early = shouldContinue === null ? '' : String(shouldContinue() ?? '');
    if (early !== '') return this.vtsHideAborted(early);
    if (force !== true && this.vtsHidden === true && this.vtsOriginal !== null) {
      return {
        ok: true,
        already: true,
        bounds: {
          x: VTS_OFFSCREEN.x,
          y: VTS_OFFSCREEN.y,
          width: this.vtsOriginal.width,
          height: this.vtsOriginal.height,
        },
        original: { ...this.vtsOriginal },
      };
    }
    // A caller switching in from the WPF backend knows where the user had VTS; use that instead of
    // the capture-corner rectangle the other backend parked it at.
    const remembered = vtsRect(original);
    if (remembered !== null) this.vtsOriginal = remembered;
    if (this.vtsOriginal === null) {
      const captured = await this.captureVts();
      if (captured.ok !== true) return captured;
      // VTS may already be parked at the WPF capture corner: that is not where edit mode should
      // restore it, so remember the last editable rectangle instead.
      this.vtsOriginal = visibleVtsRect(captured.bounds) ?? this.fallbackBounds();
    }
    if (visibleVtsRect(this.vtsOriginal) === null) this.vtsOriginal = this.fallbackBounds();
    const hidden = {
      x: VTS_OFFSCREEN.x,
      y: VTS_OFFSCREEN.y,
      width: this.vtsOriginal.width,
      height: this.vtsOriginal.height,
    };
    // Re-validate AFTER the (async) window read: edit entry, a generation change, a stopped display
    // or a cancelled retry may have happened while `captureVts()` was pending. Moving the window
    // then is wrong, and an abandoned move is an abort — never a hide failure.
    const blocked = shouldContinue === null ? '' : String(shouldContinue() ?? '');
    if (blocked !== '') return this.vtsHideAborted(blocked);
    const moved = await this.moveVts(hidden, { raise: false });
    if (moved.ok !== true) return moved;
    this.vtsHidden = true;
    // The capture position is recorded on its own; it must never become the user's rectangle.
    this.captureRect = { ...(moved.bounds ?? hidden) };
    await this.emitEvent('spout.vts.hidden', { ...hidden, captureRect: { ...this.captureRect }, original: { ...this.vtsOriginal } });
    return { ok: true, bounds: { ...hidden }, captureRect: { ...this.captureRect }, original: { ...this.vtsOriginal } };
  }

  /**
   * Refuse a checked hide without moving the window. Recorded apart from `vtsHideFailure`: an edit
   * request, a generation change or a cancelled chain cancels the attempt; it does not fail to hide
   * the window, and it must never be reported as `spout.vts.hide.failed`.
   */
  async vtsHideAborted(reason, extra = {}) {
    const aborted = { reason: String(reason || 'cancelled'), at: Date.now() };
    this.lastVtsHideAbort = aborted;
    await this.emitEvent('spout.vts.hide.aborted', { ...aborted, ...extra });
    return { ok: false, aborted: true, cancelled: true, code: '', message: '', reason: aborted.reason, ...extra };
  }

  /**
   * Put VTS back on screen: the rectangle it had when Spout took over, or an explicit fallback
   * passed by the caller (edit mode uses the saved `layer.spout.bounds` so a fresh session still
   * has a visible window). Without either, this is a no-op, so leaving Spout can never move a VTS
   * window this backend never touched.
   *
   * `options.raise` belongs to the edit-recovery restore only: it restores a minimized VTS and
   * brings it in front of the editor. Leaving Spout (stop/shutdown) omits it on purpose.
   */
  async restoreVts(fallback = null, options = {}) {
    const original = visibleVtsRect(this.vtsOriginal)
      ?? (fallback === null ? null : visibleVtsRect(fallback));
    if (original === null) return { ok: true, skipped: true, code: '', bounds: null };
    const raised = options?.raise === true;
    const moved = await this.moveVts(original, { raise: raised });
    if (moved.ok !== true) {
      // A positioned-but-not-raised window is still the edit surface; keep `restored` accurate so
      // the caller can tell "never moved" from "moved, but could not come to the front".
      if (raised === true && moved.bounds !== undefined) return { ...moved, restored: true };
      return moved;
    }
    this.vtsOriginal = null;
    this.vtsHidden = false;
    await this.emitEvent('spout.vts.restored', { ...original });
    return { ok: true, restored: true, raised, bounds: { ...original } };
  }

  // ---- VTS window convergence --------------------------------------------------------------
  // The hide is one attempt against a window the plugin does not own: VTS may not be started yet,
  // or its handle may not be ready at that instant. The old code made that single attempt, so a
  // failure left the real window visible in front of the display for the whole session. The fix
  // is a *finite* chain of retries, not an endless loop and not a periodic re-park: each retry
  // re-validates the world (display still running, same generation, not editing, backend still
  // spout) and gives up with a code after the budget. The display state and the VTS state are
  // reported separately, so "the display started" can never be read as "VTS is hidden".

  /**
   * Hide VTS for a display that is about to run, and report the two outcomes separately.
   * A failure records the reason and, only when a retry can still be meaningful, defers the chain
   * to `armPendingVtsHide()` (called once the display is confirmed running, so the generation the
   * chain belongs to is the one that will actually be showing).
   */
  async hideVtsForDisplay(reason = 'display') {
    const hide = await this.hideVts();
    if (hide.ok === true) {
      this.vtsHideAttempts = 0;
      this.vtsHideFailure = null;
      return this.vtsHideReport(hide, { retrying: false, attempts: 0 });
    }
    return this.deferVtsHideRetry(hide, reason);
  }

  /** Normalized VTS half of a start/exit result: `{ ok, hidden, code, message, ... }`. */
  vtsHideReport(result, extra = {}) {
    const ok = result?.ok === true;
    const aborted = result?.aborted === true;
    return {
      ok,
      hidden: ok === true && this.vtsHidden === true,
      aborted,
      code: ok || aborted ? '' : String(result?.code ?? 'VTS_HIDE_FAILED'),
      message: ok || aborted ? '' : clipText(result?.message ?? '', 240),
      reason: aborted ? String(result?.reason ?? '') : '',
      ...extra,
    };
  }

  /** The VTS half of the report as last observed: hidden, retrying, or the give-up reason. */
  currentVtsReport(extra = {}) {
    if (this.vtsHidden === true) return { ok: true, hidden: true, code: '', message: '', ...extra };
    if (this.vtsHidePending !== null) {
      return {
        ok: false,
        hidden: false,
        retrying: true,
        code: this.vtsHidePending.lastCode,
        message: this.vtsHidePending.lastMessage,
        ...extra,
      };
    }
    if (this.vtsHideFailure !== null) {
      return {
        ok: false,
        hidden: false,
        retrying: false,
        code: this.vtsHideFailure.code,
        message: this.vtsHideFailure.message,
        ...extra,
      };
    }
    return { ok: false, hidden: false, retrying: false, code: 'VTS_NOT_HIDDEN', message: 'VTS 窗口尚未隐藏', ...extra };
  }

  /**
   * The display will not run, so a retry has nothing to protect. Cancelling is not a failure, but
   * the last code/message is still reported: the caller never has to guess why VTS stayed visible.
   */
  async abortPendingVtsHide(reason = 'display-failed') {
    const pending = this.vtsHidePending;
    if (pending === null) return this.currentVtsReport();
    const report = {
      ok: false,
      hidden: false,
      retrying: false,
      code: pending.lastCode,
      message: pending.lastMessage,
    };
    await this.cancelVtsHideRetry(reason);
    return report;
  }

  /**
   * Remember a failed hide and log the retry that is about to be attempted. The timer is armed
   * later, by `armPendingVtsHide()`, because the retry is only valid for a running display.
   */
  async deferVtsHideRetry(result, reason = 'display') {
    this.cancelVtsHideRetry('superseded');
    const code = String(result?.code ?? 'VTS_HIDE_FAILED');
    const message = clipText(result?.message ?? '', 240);
    const pending = {
      generation: null,
      reason: String(reason),
      attempts: 0,
      armed: false,
      timer: null,
      lastCode: code,
      lastMessage: message,
    };
    this.vtsHidePending = pending;
    this.vtsHideAttempts = 1;
    this.vtsHideFailure = null;
    await this.emitEvent('spout.vts.hide.retry', {
      attempt: 1,
      code,
      message,
      delayMs: this.vtsRetryDelays[0],
      reason: pending.reason,
    });
    return this.vtsHideReport(result, { retrying: true, attempts: 1, nextDelayMs: this.vtsRetryDelays[0] });
  }

  /**
   * Arm the pending chain for the display generation that is now running. A retry that cannot be
   * meaningful (no running display, edit mode, another backend) is finalized as a failure instead
   * of being scheduled.
   */
  async armPendingVtsHide(generation = this.generation) {
    const pending = this.vtsHidePending;
    if (pending === null || pending.armed === true) return null;
    pending.generation = generation;
    const blocked = this.vtsHideRetryBlocker(pending);
    if (blocked !== '') return this.finalizeVtsHideFailure(pending, blocked);
    pending.armed = true;
    this.scheduleVtsHideRetry(pending);
    return this.vtsHideReport(null, {
      ok: false,
      hidden: false,
      retrying: true,
      attempts: pending.attempts + 1,
      nextDelayMs: this.vtsRetryDelays[pending.attempts],
      code: pending.lastCode,
      message: pending.lastMessage,
    });
  }

  /**
   * Why the pending retry is no longer worth running, or '' when it still is. Every condition is a
   * state change that makes moving the window wrong: a stopped display, a new generation, edit mode
   * (VTS is the editable surface there), or a backend that is no longer spout.
   */
  vtsHideRetryBlocker(pending) {
    return this.vtsHideAbortReason(pending);
  }

  /**
   * One predicate for both the retry schedule and the post-read `shouldContinue` check of a hide.
   * `editRequest` covers the window between "the edit entry was registered" and "`editing` flipped":
   * without it, a hide reading the window at that instant would still park VTS. A chain that is no
   * longer the current one is reported as `cancelled` last, so a more specific reason wins.
   */
  vtsHideAbortReason(pending = null) {
    if (this.backend !== 'spout') return 'backend-changed';
    if (this.vtsWindow === null) return 'no-window-controller';
    if (this.stopping === true) return 'stopping';
    if (pending !== null && pending.generation !== null && pending.generation !== this.generation) {
      return 'generation-changed';
    }
    if (this.child === null || this.child.exitCode !== null) return 'display-stopped';
    if (this.isEditing() === true || this.editRequest !== null) return 'editing';
    if (pending !== null && this.vtsHidePending !== pending) return 'cancelled';
    return '';
  }

  scheduleVtsHideRetry(pending) {
    if (this.vtsHidePending !== pending) return false;
    const delay = this.vtsRetryDelays[pending.attempts];
    if (delay === undefined) return false;
    const timer = this.setTimeoutFn(() => this.runVtsHideRetry(pending), delay);
    timer?.unref?.();
    pending.timer = timer;
    return true;
  }

  /** Drop a pending chain (state changed, or a newer hide superseded it). Not a failure. */
  cancelVtsHideRetry(reason = 'cancelled') {
    const pending = this.vtsHidePending;
    if (pending === null) return { ok: true, cancelled: false };
    this.vtsHidePending = null;
    if (pending.timer !== null) this.clearTimeoutFn(pending.timer);
    pending.timer = null;
    pending.armed = false;
    void this.emitEvent('spout.vts.hide.retry.cancelled', {
      reason: String(reason),
      attempts: pending.attempts,
    });
    return { ok: true, cancelled: true, reason: String(reason), attempts: pending.attempts };
  }

  /** One retry: re-validate, hide again, and either recover, schedule the next, or give up. */
  async runVtsHideRetry(pending) {
    if (this.vtsHidePending !== pending) return { ok: true, cancelled: true };
    pending.timer = null;
    const blocked = this.vtsHideRetryBlocker(pending);
    if (blocked !== '') {
      await this.cancelVtsHideRetry(blocked);
      return { ok: true, cancelled: true, reason: blocked };
    }
    pending.attempts += 1;
    // Edit entry shares this serial chain: a move that was already issued finishes first, and an
    // edit request registered while this attempt reads the window aborts the move (see hideVts).
    const result = await this.withVtsSerial(() => this.hideVts(null, {
      force: true,
      shouldContinue: () => this.vtsHideAbortReason(pending),
    }));
    if (result.aborted === true) {
      if (this.vtsHidePending === pending) await this.cancelVtsHideRetry(result.reason ?? 'aborted');
      return { ok: true, cancelled: true, aborted: true, reason: result.reason ?? 'aborted' };
    }
    if (this.vtsHidePending !== pending) return { ok: true, cancelled: true };
    if (result.ok === true) {
      const attempts = pending.attempts;
      this.vtsHidePending = null;
      this.vtsHideFailure = null;
      this.vtsHideAttempts = attempts + 1;
      await this.emitEvent('spout.vts.hide.recovered', { attempts, reason: pending.reason });
      return this.vtsHideReport(result, { retrying: false, attempts, recovered: true });
    }
    pending.lastCode = String(result.code ?? 'VTS_HIDE_FAILED');
    pending.lastMessage = clipText(result.message ?? '', 240);
    if (pending.attempts >= this.vtsRetryDelays.length) {
      return this.finalizeVtsHideFailure(pending, 'exhausted');
    }
    const delay = this.vtsRetryDelays[pending.attempts];
    await this.emitEvent('spout.vts.hide.retry', {
      attempt: pending.attempts + 1,
      code: pending.lastCode,
      message: pending.lastMessage,
      delayMs: delay,
      reason: pending.reason,
    });
    if (this.vtsHidePending !== pending) return { ok: true, cancelled: true };
    this.scheduleVtsHideRetry(pending);
    return this.vtsHideReport(result, {
      retrying: true,
      attempts: pending.attempts + 1,
      nextDelayMs: delay,
    });
  }

  /** The budget is spent: keep the code/message on the record and in the status, stop retrying. */
  async finalizeVtsHideFailure(pending, reason = 'exhausted') {
    if (this.vtsHidePending === pending) this.vtsHidePending = null;
    if (pending.timer !== null) this.clearTimeoutFn(pending.timer);
    pending.timer = null;
    pending.armed = false;
    const failure = {
      code: pending.lastCode || 'VTS_HIDE_FAILED',
      message: pending.lastMessage || '',
      attempts: pending.attempts,
      reason: String(reason),
      at: Date.now(),
    };
    this.vtsHideFailure = failure;
    this.vtsHideAttempts = pending.attempts + 1;
    await this.emitEvent('spout.vts.hide.failed', { ...failure });
    return {
      ok: false,
      hidden: false,
      retrying: false,
      recovered: false,
      attempts: pending.attempts,
      code: failure.code,
      message: failure.message,
      reason: failure.reason,
    };
  }

  /** Status view of the convergence: hidden now, retry state, and the last give-up reason. */
  vtsHideSnapshot() {
    return {
      hidden: this.vtsHidden === true,
      retrying: this.vtsHidePending !== null,
      armed: this.vtsHidePending?.armed === true,
      attempts: this.vtsHideAttempts,
      retries: this.vtsRetryDelays.length,
      failure: this.vtsHideFailure === null ? null : { ...this.vtsHideFailure },
      /** Last checked hide abandoned before moving: a cancellation, never counted as a failure. */
      aborted: this.lastVtsHideAbort === null ? null : { ...this.lastVtsHideAbort },
    };
  }

  /**
   * Report/retarget the backend this instance serves. A change cancels any pending hide retry:
   * the chain belongs to the backend that hid the window.
   */
  async setBackend(value) {
    const next = value === 'wpf' ? 'wpf' : 'spout';
    const changed = next !== this.backend;
    this.backend = next;
    if (changed === true) await this.cancelVtsHideRetry('backend-changed');
    return this.backend;
  }

  clearPendingEdit() {
    const pending = this.pendingEdit;
    this.pendingEdit = null;
    if (pending !== null) clearTimeout(pending.timer);
    pending?.resolve?.(null);
  }

  /**
   * Run `task` after every previously queued VTS transition. The chain never rejects, so one
   * aborted or failed transition cannot wedge the next; the task's own result is returned as-is.
   */
  async withVtsSerial(task) {
    const previous = this.vtsSerial;
    let release = null;
    this.vtsSerial = new Promise((resolvePromise) => { release = resolvePromise; });
    await previous;
    try {
      return await task();
    } finally {
      if (release !== null) release();
    }
  }

  /**
   * Register an edit entry synchronously, before its first await. From this instant on a hide is
   * invalid: a retry still waiting for its timer is cancelled here, and one that is already reading
   * the window aborts at the pre-move check (`editRequest` is visible even before `editing` flips).
   */
  registerEditRequest() {
    this.editRequestSeq += 1;
    const request = { seq: this.editRequestSeq, at: Date.now() };
    this.editRequest = request;
    this.cancelVtsHideRetry('editing');
    return request;
  }

  /** Drop the registration once the entry settled (`editing`/`failure` is the durable state then). */
  endEditRequest(request) {
    if (this.editRequest === request) this.editRequest = null;
  }

  /**
   * Enter/leave edit mode. With a VTS window controller this is the VTS session: the display
   * process is stopped (mutual exclusion), VTS comes back on screen and the user edits it there.
   * Without one, nothing can move VTS, so the layer's own drag/resize mode is the only editing.
   */
  async setEditMode(enabled, options = {}) {
    const on = enabled === true;
    if (this.vtsWindow === null) return this.setLayerEditMode(on);
    return on ? this.enterVtsEdit() : this.exitVtsEdit(options);
  }

  /**
   * Take over an edit session that is already open on another backend: VTS is visible, the display
   * process is stopped, and nothing moves. The rectangle the user left VTS at becomes this
   * backend's session rectangle, so a backend switch is a pure hand-over (no start/hide/restore).
   */
  async adoptEdit(rect) {
    const bounds = vtsRect(rect);
    if (bounds === null) return this.vtsFailure('VTS_BOUNDS_INVALID', '编辑会话矩形无效');
    // The editable surface is VTS now: no hide retry may fight the handover.
    const request = this.registerEditRequest();
    try {
      return await this.withVtsSerial(() => this.adoptEditSession(bounds));
    } finally {
      this.endEditRequest(request);
    }
  }

  async adoptEditSession(bounds) {
    // A handover only happens once the old display is gone; a stale process of this backend must
    // not stay visible over the editable VTS window.
    if (this.child !== null && this.child.exitCode === null) {
      const stopped = await this.stop();
      if (stopped.ok !== true) {
        return this.vtsFailure('EDIT_DISPLAY_RUNNING', stopped.error ?? '显示进程未能退出，未接管编辑会话');
      }
    }
    this.editing = true;
    this.editMode = false;
    this.editRect = { ...bounds };
    this.bounds = { left: bounds.x, top: bounds.y, width: bounds.width, height: bounds.height };
    this.boundsSource = 'edit';
    this.vtsHidden = false;
    this.vtsOriginal = null;
    this.vtsError = null;
    this.captureRect = null;
    await this.emitEvent('spout.edit.enter', { backend: 'vts', handedOff: true, bounds: { ...bounds } });
    return { ok: true, editMode: true, handedOff: true, bounds: { ...bounds } };
  }

  /**
   * Edit ON: stop the display process (confirmed), then bring VTS back on screen in the geometry it
   * had before Spout hid it (saved geometry, or the on-screen default on a first run). The two are
   * never up together: enter fails when the process cannot be confirmed gone.
   *
   * The request is registered synchronously, then the session runs on the VTS serial chain: a hide
   * that already issued its move finishes first (edit entry waits, it never interleaves), while a
   * hide that is only waiting or still reading the window is aborted before it can move anything.
   */
  async enterVtsEdit() {
    if (this.editing === true) {
      return { ok: true, already: true, editMode: true, bounds: this.editBounds() };
    }
    const request = this.registerEditRequest();
    try {
      return await this.withVtsSerial(() => this.enterVtsEditSession());
    } finally {
      this.endEditRequest(request);
    }
  }

  async enterVtsEditSession() {
    // A second entry queued behind the first one adopts the session it already opened.
    if (this.editing === true) {
      return { ok: true, already: true, editMode: true, bounds: this.editBounds() };
    }
    // Resolve the restore target BEFORE the stop: stop() restores and clears `vtsOriginal`.
    const target = visibleVtsRect(this.vtsOriginal) ?? this.fallbackBounds();
    // The display state to roll back to when VTS cannot be shown: the user must never be left
    // with neither surface.
    const wasRunning = this.child !== null && this.child.exitCode === null;
    const beforeBounds = this.bounds === null
      ? null
      : { x: this.bounds.left, y: this.bounds.top, width: this.bounds.width, height: this.bounds.height };
    const stopped = await this.stop({ raiseVts: true });
    if (stopped.ok !== true) {
      return {
        ok: false,
        code: stopped.code ?? 'EDIT_STOP_FAILED',
        error: stopped.error ?? '显示进程未能确认退出，未进入编辑模式',
        editMode: false,
        bounds: target,
      };
    }
    // stop() already restored VTS to its original rectangle in the normal path; a fresh session
    // (or a failed restore) still needs the explicit fallback. This is the one restore that must
    // raise: without it VTS can come back behind the DSH window and look like nothing happened.
    const stopVts = stopped.vts ?? null;
    const restoredByStop = stopVts?.ok === true && stopVts?.restored === true;
    // A stop that positioned VTS but could not raise it is reported, not retried in place: the
    // retry would perform the same failed transition once more.
    const positionedButNotRaised = stopVts?.restored === true && stopVts?.ok !== true;
    const shown = restoredByStop || positionedButNotRaised ? stopVts : await this.restoreVts(target, { raise: true });
    if (shown?.ok !== true) {
      // No VTS window means no editable surface: entering edit mode would only have killed the
      // display process. Roll the display process back to the state it had before edit was asked.
      this.editing = false;
      this.editMode = false;
      this.clearPendingEdit();
      let rollback = { ok: true, skipped: !wasRunning };
      if (wasRunning) {
        // The edit entry is abandoned here: the rollback start owns the hide chain again, so its
        // retry must not be blocked by a request that no longer exists.
        this.editRequest = null;
        const restarted = await this.start(beforeBounds === null ? {} : { bounds: beforeBounds });
        rollback = restarted.ok === true
          ? { ok: true, pid: restarted.pid ?? 0, running: true }
          : { ok: false, code: 'EDIT_ROLLBACK_FAILED', error: restarted.error ?? restarted.code ?? '' };
      }
      const code = rollback.ok === true ? 'EDIT_VTS_UNAVAILABLE' : 'EDIT_ROLLBACK_FAILED';
      const error = shown.message ?? shown.error ?? 'VTS 窗口不可用，无法进入编辑模式';
      await this.emitEvent('spout.edit.enter.failed', {
        backend: 'vts',
        code,
        vtsCode: shown.code ?? 'VTS_NOT_RUNNING',
        error,
        bounds: { ...target },
        rollback,
      });
      return {
        ok: false,
        code,
        error,
        editMode: false,
        bounds: { ...target },
        vts: this.vtsSnapshot(),
        rollback,
      };
    }
    this.editing = true;
    this.editRect = shown?.ok === true && vtsRect(shown.bounds) !== null ? { ...vtsRect(shown.bounds) } : { ...target };
    await this.emitEvent('spout.edit.enter', {
      backend: 'vts',
      bounds: { ...this.editRect },
      vts: { ok: shown?.ok === true, code: shown?.code ?? '' },
    });
    return { ok: true, editMode: true, bounds: { ...this.editRect }, vts: shown ?? null };
  }

  /**
   * Edit OFF: read the VTS rectangle the user left, park VTS off screen and start the display
   * process in exactly that rectangle, so the model reappears in place with no manual start.
   * An unreadable VTS falls back to the saved `layer.spout.bounds` and never blocks. A failed
   * start rolls back to the edit session (VTS visible) instead of leaving neither surface.
   */
  async exitVtsEdit(options = {}) {
    if (this.editing !== true) {
      return { ok: true, already: true, editMode: this.isEditing(), bounds: this.editBounds() };
    }
    // `closeOnly`: the caller has no rectangle that is safe to present (no saved geometry and no
    // usable VTS read). Close the session and touch NOTHING: no read, no park, no start, no
    // remembered restore target. The caller reports the failure; VTS stays where the user left it.
    if (options?.closeOnly === true) {
      this.editing = false;
      this.vtsHidden = false;
      this.vtsOriginal = null;
      await this.emitEvent('spout.edit.exit', {
        backend: 'vts',
        bounds: null,
        closeOnly: true,
        moved: false,
        vts: { ok: false, code: String(options.code ?? 'VTS_GEOMETRY_UNUSABLE') },
      });
      return { ok: true, editMode: false, closedOnly: true, moved: false, bounds: null };
    }
    // 1. The rectangle the user left VTS at is the rectangle the display process must occupy.
    // `options.bounds` (own property) means the host already read it: a rectangle is used as-is,
    // `null` means that read failed and the saved fallback is used. Either way this one read
    // decides parking, starting and saving - the layer never reads a second, unvalidated value.
    const hostRead = options !== null && typeof options === 'object'
      && Object.prototype.hasOwnProperty.call(options, 'bounds');
    const provided = hostRead ? vtsRect(options.bounds) : null;
    const captured = hostRead
      ? (provided === null
        ? { ok: false, code: String(options.code || 'VTS_READ_FAILED') }
        : { ok: true, bounds: provided })
      : await this.captureVts();
    let rect = captured.ok === true ? captured.bounds : null;
    const keepVts = options?.keepVts === true;
    // A capture-corner reading means VTS was never on screen: adopting it would write the
    // off-screen collection position into `layer.spout.bounds`. Fall back instead.
    if (rect !== null && visibleVtsRect(rect) === null) rect = null;
    let fallback = false;
    if (rect === null) {
      fallback = true;
      rect = this.fallbackBounds();
      await this.emitEvent('spout.edit.exit.fallback', {
        code: captured.code ?? 'VTS_NOT_RUNNING',
        bounds: { ...rect },
      });
    }
    // Hand-over: VTS is already visible and stays exactly where it is. Close the session without
    // hiding it or starting a display - the target backend is about to adopt the same rectangle.
    if (keepVts === true) {
      this.editing = false;
      this.editRect = { ...rect };
      this.vtsHidden = false;
      this.vtsOriginal = null;
      await this.emitEvent('spout.edit.exit', {
        backend: 'vts',
        bounds: { ...rect },
        fallback,
        handedOff: true,
        keepVts: true,
        vts: { ok: captured.ok === true, code: captured.code ?? '' },
      });
      return { ok: true, editMode: false, handedOff: true, bounds: { ...rect }, running: this.child !== null };
    }
    // 2. Park VTS first, in the captured rectangle, so the display window appears where it was.
    // A host read that failed has no rectangle: remember the fallback instead of reading again.
    // This is the edit-exit hide: the same finite retry chain and the same separate reporting as a
    // cold start, because "VTS did not hide" must not be absorbed by "the display started".
    if (fallback !== true) this.vtsOriginal = { ...rect };
    else if (hostRead === true && this.vtsOriginal === null) this.vtsOriginal = { ...rect };
    const hidden = await this.hideVtsForDisplay('edit-exit');
    // 3. Start the display process in the same rectangle (the guard in start() needs edit closed).
    this.editing = false;
    this.editRect = { ...rect };
    if (this.autostartOnEditExit !== true) {
      // The caller is about to stop this backend: leave the session, but do not spawn a display
      // process (and its WMI probe) only to kill it immediately afterwards.
      await this.abortPendingVtsHide('display-skipped');
      await this.emitEvent('spout.edit.exit', {
        backend: 'vts',
        bounds: { ...rect },
        fallback,
        autostart: false,
        vts: { ok: hidden.ok === true, code: hidden.code ?? '' },
      });
      await this.emitEvent('spout.display.autostart-skipped', { bounds: { ...rect }, reason: 'backend-stopping' });
      return {
        ok: true,
        skippedAutostart: true,
        editMode: false,
        running: false,
        bounds: { ...rect },
        vts: this.vtsSnapshot(),
      };
    }
    const started = await this.start({ bounds: rect, vtsHideHandled: true });
    if (started.ok !== true) {
      // No blank state: VTS comes back on screen and the session stays in edit mode for a retry.
      this.editing = true;
      this.editRect = { ...rect };
      // A hide retry has no display to protect if the start failed at validation, before it could
      // abort the chain itself.
      await this.abortPendingVtsHide('display-failed');
      // Still an edit-recovery restore: VTS is the editable surface the user returns to.
      if (this.vtsOriginal !== null || this.vtsHidden === true) await this.restoreVts(rect, { raise: true });
      await this.emitEvent('spout.edit.exit.start-failed', {
        code: started.code ?? 'START_FAILED',
        bounds: { ...rect },
        error: started.error ?? '',
      });
      return {
        ok: false,
        code: started.code ?? 'START_FAILED',
        error: started.error ?? '',
        editMode: true,
        bounds: { ...rect },
        vts: this.vtsSnapshot(),
      };
    }
    this.editRect = { ...rect };
    await this.emitEvent('spout.edit.exit', {
      backend: 'vts',
      bounds: { ...rect },
      fallback,
      vts: { ok: hidden.ok === true, code: hidden.code ?? '' },
    });
    await this.emitEvent('spout.display.autostarted', {
      bounds: { ...rect },
      pid: started.pid ?? 0,
      fallback,
    });
    return { ...started, ok: true, editMode: false, bounds: { ...rect }, fallback };
  }

  /**
   * Layer-internal edit mode (drag/resize/Escape): used only when no VTS window controller exists,
   * because then the display window is the only surface that can be edited. The layer changes only
   * its window interaction and bounds; the host mirrors the outcome and returns the final rectangle.
   */
  async setLayerEditMode(enabled) {
    const on = enabled === true;
    const child = this.child;
    if (child === null || child.exitCode !== null || typeof child.stdin?.write !== 'function') {
      return { ok: false, code: 'LAYER_NOT_RUNNING', editMode: false, bounds: this.editBounds() };
    }
    if (this.editMode === on) {
      return { ok: true, editMode: on, bounds: this.editBounds() };
    }
    this.editSeq += 1;
    const ack = new Promise((resolvePromise) => {
      const timer = setTimeout(() => {
        if (this.pendingEdit?.resolve === resolvePromise) this.pendingEdit = null;
        resolvePromise(null);
      }, EDIT_ACK_TIMEOUT_MS);
      timer.unref?.();
      this.pendingEdit = { enabled: on, resolve: resolvePromise, timer };
    });
    try {
      child.stdin.write(`${JSON.stringify({ type: 'edit', enabled: on, seq: this.editSeq })}\n`);
    } catch (error) {
      this.clearPendingEdit();
      return {
        ok: false,
        code: 'EDIT_SEND_FAILED',
        error: String(error?.message ?? error),
        editMode: this.editMode === true,
        bounds: this.editBounds(),
      };
    }
    const report = await ack;
    if (report === null) {
      return { ok: false, code: 'EDIT_TIMEOUT', editMode: this.editMode === true, bounds: this.editBounds() };
    }
    return { ok: true, editMode: this.editMode === true, bounds: this.editBounds() };
  }

  settleEdit(pending, report) {
    if (this.pendingEdit === pending) this.pendingEdit = null;
    clearTimeout(pending.timer);
    pending.resolve(report);
  }

  // ---- startup diagnostics ---------------------------------------------------------------
  // Every start leaves a raw log beside the session: exit code, full stderr, every stdout line.
  // Without it a "receiver never arrived" report can only be guessed at.

  openDiagnostics({ gen, executable, version, args }) {
    this.diagnosticsFile = '';
    try {
      mkdirSync(this.diagnosticsDir, { recursive: true });
      this.pruneDiagnostics();
      const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
      this.diagnosticsFile = join(this.diagnosticsDir, `start-${stamp}-g${gen}.log`);
      const header = [
        `# spout layer start ${new Date().toISOString()}`,
        `root=${this.root}`,
        `instance=${this.instance}`,
        `generation=${gen}`,
        `electron=${executable}`,
        `version=${version}`,
        `main=${this.mainPath}`,
        `cwd=${this.dir}`,
        `userDataDir=${this.userDataDir}`,
        `receiverTimeoutMs=${this.receiverTimeout()}`,
        `sender=${this.senderName()}`,
        `senderTimeoutMs=${this.senderTimeout()}`,
        `size=${JSON.stringify(this.size())}`,
        `bounds=${JSON.stringify(this.requestedBounds())}`,
        `args=${JSON.stringify(args)}`,
        '',
      ].join('\n');
      writeFileSync(this.diagnosticsFile, header, 'utf8');
    } catch {
      this.diagnosticsFile = '';
    }
    return this.diagnosticsFile;
  }

  /** Keep the directory bounded; a failed run and the run before it are what matter. */
  pruneDiagnostics() {
    try {
      const files = readdirSync(this.diagnosticsDir)
        .filter((name) => name.endsWith('.log'))
        .sort();
      for (const name of files.slice(0, Math.max(0, files.length - DIAGNOSTICS_KEEP + 1))) {
        try {
          unlinkSync(join(this.diagnosticsDir, name));
        } catch {
          /* another instance is still writing it */
        }
      }
    } catch {
      /* diagnostics are best-effort and never block startup */
    }
  }

  appendDiagnostics(text) {
    if (this.diagnosticsFile === '') return;
    try {
      appendFileSync(this.diagnosticsFile, text.endsWith('\n') ? text : `${text}\n`, 'utf8');
    } catch {
      /* disk full/removed: never break the display lifecycle for a log line */
    }
  }

  /** The configured Electron path, or '' when the user never set one. */
  executable() {
    const saved = this.readSettings() ?? {};
    const value = saved?.electronExecutable;
    return typeof value === 'string' ? value.trim() : '';
  }

  /** Clean environment for every child process: the known Electron trap is inherited. */
  childEnv() {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.NODE_OPTIONS;
    return env;
  }

  /** Run a helper executable and return trimmed stdout (rejects on non-zero or timeout). */
  run(command, args, timeoutMs = VERSION_TIMEOUT_MS) {
    return new Promise((resolvePromise, reject) => {
      execFile(
        command,
        args,
        { timeout: timeoutMs, windowsHide: true, env: this.childEnv(), encoding: 'utf8' },
        (error, stdout) => {
          if (error) {
            reject(error);
            return;
          }
          resolvePromise(`${stdout ?? ''}`.trim());
        },
      );
    });
  }

  /** Validate the configured launcher. Returns `{ ok, code, message, version, path }`. */
  async validate(rawPath) {
    const target = String(rawPath ?? '').trim();
    if (target.length === 0) {
      return {
        ok: false,
        code: 'ELECTRON_EXE_UNSET',
        message: '未配置 Electron 路径（runtime.spoutLayer.electronExecutable）；不会回退到 DSH 自身进程',
        version: '',
        path: '',
      };
    }
    if (!isAbsolute(target)) {
      return { ok: false, code: 'ELECTRON_EXE_INVALID', message: '路径必须是绝对路径', version: '', path: target };
    }
    const absolute = resolve(target);
    let stats = null;
    try {
      stats = statSync(absolute);
    } catch {
      return { ok: false, code: 'ELECTRON_EXE_INVALID', message: '文件不存在', version: '', path: absolute };
    }
    if (!stats.isFile()) {
      return { ok: false, code: 'ELECTRON_EXE_INVALID', message: '路径不是文件', version: '', path: absolute };
    }
    const selfPath = String(process.execPath ?? '').toLowerCase();
    if (selfPath.length > 0 && absolute.toLowerCase() === selfPath) {
      return {
        ok: false,
        code: 'ELECTRON_EXE_INVALID',
        message: '不能指向 DSH 自身的可执行文件：需要独立的 Electron 运行时',
        version: '',
        path: absolute,
      };
    }
    if (!this.looksLikeElectron(absolute)) {
      return {
        ok: false,
        code: 'ELECTRON_EXE_INVALID',
        message: '同目录缺少 Electron 运行时文件（resources/ 或 chrome_100_percent.pak）',
        version: '',
        path: absolute,
      };
    }

    let versionText = '';
    try {
      versionText = await this.run(absolute, ['--version'], VERSION_TIMEOUT_MS);
    } catch (error) {
      // A locked/unreadable binary can still be identified by the `version` file Electron ships.
      const fromFile = this.readVersionFile(absolute);
      if (fromFile === '') {
        return {
          ok: false,
          // A vanished binary is still an invalid path; a probe that ran but could not report a
          // version is a distinct failure, never a "below minimum" mismatch.
          code: error?.code === 'ENOENT' ? 'ELECTRON_EXE_INVALID' : 'ELECTRON_VERSION_UNREADABLE',
          message: `无法读取版本：${error?.message ?? String(error)}`,
          version: '',
          path: absolute,
        };
      }
      versionText = fromFile;
    }

    const version = normalizeVersion(versionText);
    const major = Number.parseInt(version.split('.')[0] ?? '', 10);
    if (version === '' || !Number.isInteger(major)) {
      return {
        ok: false,
        code: 'ELECTRON_VERSION_UNREADABLE',
        message: `无法读取版本：输出为 ${clipText(versionText, 120) || '(空)'}`,
        version: '',
        path: absolute,
      };
    }
    if (major < MIN_ELECTRON_MAJOR) {
      return {
        ok: false,
        code: 'ELECTRON_VERSION_MISMATCH',
        message: `Electron 主版本过低：需要 >= ${MIN_ELECTRON_MAJOR}（推荐 ${PINNED_ELECTRON_VERSION}），实际 ${version}`,
        version,
        path: absolute,
      };
    }
    // The layer only uses stable APIs: a newer major is allowed, but a large jump is recorded as a
    // WARN event rather than silently treated as "verified". The event name is spelled as specified.
    if (major > PINNED_ELECTRON_MAJOR + UNPINNED_MAJOR_DELTA) {
      await this.emitEvent('electron.version.unpinned', {
        actual: version,
        recommended: PINNED_ELECTRON_VERSION,
      });
    }
    return { ok: true, code: '', message: '', version, path: absolute };
  }

  /** Validate whatever is currently configured (used by the settings "检测" button). */
  async validateConfigured() {
    return this.validate(this.executable());
  }

  looksLikeElectron(exePath) {
    if (basename(exePath).toLowerCase() === 'electron.exe') return true;
    const dir = dirname(exePath);
    return (
      existsSync(join(dir, 'resources'))
      || existsSync(join(dir, 'chrome_100_percent.pak'))
      || existsSync(join(dir, 'icudtl.dat'))
    );
  }

  readVersionFile(exePath) {
    try {
      const text = readFileSync(join(dirname(exePath), 'version'), 'utf8').trim();
      return normalizeVersion(text);
    } catch {
      return '';
    }
  }

  /** OS-reported creation time of a process, ISO-8601; '' when the PID is gone. */
  async processCreatedAt(pid, timeoutMs = 5000) {
    const id = Number(pid);
    if (!Number.isInteger(id) || id <= 0) return '';
    const script = `try { [System.Diagnostics.Process]::GetProcessById(${id}).StartTime.ToUniversalTime().ToString('o') } catch { '' }`;
    try {
      const output = await this.run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], timeoutMs);
      return output.trim();
    } catch {
      return '';
    }
  }

  /** Resolve with the promise's value, or `null` when it does not settle within `timeoutMs`. */
  async awaitWithin(promise, timeoutMs) {
    let timer = null;
    try {
      return await Promise.race([
        Promise.resolve(promise).catch(() => null),
        new Promise((resolvePromise) => {
          // A zero budget still lets an already-settled promise win: timers run after microtasks.
          timer = setTimeout(() => resolvePromise(null), Math.max(0, Number(timeoutMs) || 0));
        }),
      ]);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  /**
   * Capture descendant ownership *while the layer is running* (one WMI call, best effort).
   * `stop()` must never start this query: on a cold Windows box it costs 1.5–5.5 s by itself.
   */
  refreshOwnership(reason = 'runtime') {
    const ownership = this.ownership;
    if (ownership === null || ownership.pid !== this.pid || ownership.pid <= 0) return Promise.resolve(null);
    if (this.ownershipScan !== null) return this.ownershipScan;
    this.ownershipScan = this.descendantPids(ownership.pid, OWNERSHIP_SCAN_TIMEOUT_MS)
      .then((pids) => {
        if (this.ownership !== ownership) return null;
        const merged = new Set([...(ownership.children ?? []), ...pids]);
        merged.delete(ownership.pid);
        ownership.children = [...merged].filter((id) => Number.isInteger(id) && id > 0);
        ownership.scannedAt = Date.now();
        ownership.scans = (ownership.scans ?? 0) + 1;
        this.appendDiagnostics(
          `[ownership] scan=${reason} pid=${ownership.pid} children=${ownership.children.join(',')}`,
        );
        return ownership.children;
      })
      .catch(() => null)
      .finally(() => {
        if (this.ownershipScan !== null) this.ownershipScan = null;
      });
    return this.ownershipScan;
  }

  /** The recorded, already-attributed descendants of the current root. No query, no wait. */
  ownedChildren() {
    const ownership = this.ownership;
    if (ownership === null || ownership.pid !== this.pid) return [];
    return [...new Set((ownership.children ?? []).map((value) => Number(value)))]
      .filter((id) => Number.isInteger(id) && id > 0 && id !== ownership.pid);
  }

  /**
   * Every PID this controller attributed at runtime, even after the close handler cleared
   * `child`/`pid`. The ownership record is the only evidence left when the main process exits
   * first; an empty child slot must never be read as "the whole tree is gone".
   */
  attributedPids() {
    const ownership = this.ownership;
    if (ownership === null) return [];
    return [...new Set([ownership.pid, ...(ownership.children ?? [])].map((value) => Number(value)))]
      .filter((id) => Number.isInteger(id) && id > 0);
  }

  /** Merge stage timestamps reported by the display process into the active stop record. */
  mergeStopStages(source) {
    if (this.stopStages === null || source === null || typeof source !== 'object') return;
    for (const [key, raw] of Object.entries(source)) {
      const value = Number(raw);
      if (Number.isFinite(value) && value > 0) this.stopStages[key] = value;
    }
  }

  alive(pid) {
    const id = Number(pid);
    if (!Number.isInteger(id) || id <= 0) return false;
    try {
      process.kill(id, 0);
      return true;
    } catch (error) {
      return error?.code === 'EPERM';
    }
  }

  /** Wait until every PID is gone or the absolute deadline; returns the survivors. */
  async waitForPidsGone(pids, deadlineAt) {
    const ids = [...new Set((pids ?? []).map((value) => Number(value)))]
      .filter((value) => Number.isInteger(value) && value > 0);
    if (ids.length === 0) return [];
    for (;;) {
      const remaining = ids.filter((id) => this.alive(id));
      if (remaining.length === 0) return [];
      const left = Number(deadlineAt) - Date.now();
      if (!(left > 0)) return remaining;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, Math.min(50, left)));
    }
  }

  /** Compatibility helper: wait for a captured tree using a relative budget. */
  async waitForTreeExit(pids, timeoutMs) {
    return this.waitForPidsGone(pids, Date.now() + Math.max(0, Number(timeoutMs) || 0));
  }

  /**
   * Live descendant PIDs of `pid` (Electron's GPU/renderer/utility children), best effort.
   * Captured in one `Get-CimInstance Win32_Process` query and walked in JS: the previous version
   * issued one filtered WMI query per process level, which cost multiple seconds on a cold
   * Windows box and (because `stop()` awaited it before closing stdin) delayed every stop.
   * A tree that cannot be captured in `timeoutMs` returns `[]`; `/T` still covers the kill path.
   */
  async descendantPids(pid, timeoutMs = 5000) {
    const id = Number(pid);
    if (!Number.isInteger(id) || id <= 0) return [];
    const script = [
      '$rows = Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId -ErrorAction SilentlyContinue;',
      '@($rows | Select-Object ProcessId,ParentProcessId) | ConvertTo-Json -Compress',
    ].join(' ');
    try {
      const output = await this.run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], timeoutMs);
      const parsed = JSON.parse(output);
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      const childrenByParent = new Map();
      for (const row of rows) {
        const childId = Number(row?.ProcessId);
        const parentId = Number(row?.ParentProcessId);
        if (!Number.isInteger(childId) || !Number.isInteger(parentId)) continue;
        if (!childrenByParent.has(parentId)) childrenByParent.set(parentId, []);
        childrenByParent.get(parentId).push(childId);
      }
      const descendants = [];
      const seen = new Set([id]);
      const queue = [id];
      while (queue.length > 0) {
        const parent = queue.shift();
        for (const childId of childrenByParent.get(parent) ?? []) {
          if (seen.has(childId)) continue;
          seen.add(childId);
          descendants.push(childId);
          queue.push(childId);
        }
      }
      return descendants;
    } catch {
      return [];
    }
  }

  /** Wait until every captured PID is gone; returns the ones still alive. */
  async waitForTreeExit(pids, timeoutMs) {
    const ids = [...new Set(pids.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0))];
    if (ids.length === 0) return [];
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const remaining = ids.filter((id) => this.alive(id));
      if (remaining.length === 0) return [];
      if (Date.now() >= deadline) return remaining;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
  }

  /** Kill a recorded PID *and its tree*; never matched by image name. */
  async killTree(pid, timeoutMs = 2500) {
    const id = Number(pid);
    if (!Number.isInteger(id) || id <= 0) return false;
    return this.runTaskkill([id], timeoutMs);
  }

  /**
   * Force-kill a set of already-attributed PIDs (one `taskkill /T /F` per PID).
   *
   * Used for the descendant snapshot after the root exited: `process.kill(pid, 0)` can report
   * ESRCH while Windows is still tearing the process object down, so gating the cleanup on that
   * check leaks a GPU/renderer child for several seconds. The snapshot names the processes; kill
   * them unconditionally (a missing PID is a harmless nonzero exit). Every taskkill shares one
   * deadline, so N children never add N fixed budgets to a stop.
   */
  async killPids(pids, timeoutMs = 2500) {
    const ids = [...new Set((pids ?? []).map((value) => Number(value)))].filter(
      (value) => Number.isInteger(value) && value > 0,
    );
    if (ids.length === 0) return [];
    const deadlineAt = Date.now() + Math.max(0, Number(timeoutMs) || 0);
    // One `taskkill` per PID: `/PID` is documented as a single-value option, and a rejected
    // multi-PID command line would silently kill nothing (the exact leftover this guards against).
    const results = await Promise.all(
      ids.map((id) => this.runTaskkill([id], Math.max(0, deadlineAt - Date.now()))),
    );
    return ids.filter((_id, index) => results[index] === true);
  }

  /**
   * Run `taskkill /PID … /T /F` with a hard timeout. `taskkill` can block for many seconds on a
   * Chromium process tree that is already tearing down; the stop path cannot inherit that.
   */
  runTaskkill(ids, timeoutMs = 2500) {
    return new Promise((resolvePromise) => {
      if (!(Number(timeoutMs) > 0)) {
        resolvePromise(false);
        return;
      }
      const args = [];
      for (const id of ids) args.push('/PID', String(id));
      args.push('/T', '/F');
      const child = spawn('taskkill', args, {
        windowsHide: true,
        stdio: 'ignore',
        env: this.childEnv(),
      });
      let settled = false;
      let timer = null;
      const settle = (value) => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        resolvePromise(value);
      };
      timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* already gone */
        }
        settle(false);
      }, timeoutMs);
      child.once('close', (code) => settle(code === 0));
      child.once('error', () => settle(false));
    });
  }

  // ---- session file (attribution evidence) -------------------------------------------------

  readSession() {
    try {
      return JSON.parse(readFileSync(this.sessionFile, 'utf8'));
    } catch {
      return null;
    }
  }

  writeSession(patch) {
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(this.sessionFile, `${JSON.stringify(patch, null, 2)}\n`, 'utf8');
      return true;
    } catch {
      return false;
    }
  }

  clearSession() {
    try {
      rmSync(this.sessionFile, { force: true });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Why the on-disk record may not be this controller's: the first mismatching field, or ''.
   * Generation, PID and creation time are all required: a hot reload's next generation can share
   * root+instance, and only these three prove the record still names *our* process.
   */
  sessionMismatch(session, expected = {}) {
    if (session === null || typeof session !== 'object') return 'no-session';
    const generation = expected.generation !== undefined ? expected.generation : this.generation;
    const pid = expected.pid !== undefined ? expected.pid : this.pid;
    const created = expected.created !== undefined ? expected.created : this.created;
    if (String(session.root ?? '') !== String(this.root)) return 'root';
    // The record has always used `instance`/`gen`; accept the long names too so an older or
    // externally written record is compared, not mistaken for a foreign one.
    if (String(session.instance ?? session.instanceId ?? '') !== this.instance) return 'instance';
    if (Number(session.gen ?? session.generation ?? 0) !== Number(generation)) return 'generation';
    if (Number(pid) <= 0 || Number(session.pid ?? 0) !== Number(pid)) return 'pid';
    if (String(session.created ?? '') !== String(created)) return 'created';
    return '';
  }

  /**
   * Remove `session.json` only when it still names the process this controller started. A hot
   * reload can leave the previous controller finishing a timed-out stop after the next generation
   * wrote its record; deleting by filename alone would erase the new generation's attribution.
   * A mismatch keeps the file and is reported as `spoutLayer.session.foreign`.
   */
  async releaseSession(reason = 'stop', expected = {}, deadlineAt = 0) {
    const session = this.readSession();
    if (session === null) return { ok: true, cleared: false, reason: 'no-session' };
    const mismatch = this.sessionMismatch(session, expected);
    if (mismatch !== '') {
      this.appendDiagnostics(
        `[session] foreign reason=${reason} mismatch=${mismatch} pid=${String(session.pid ?? '')} gen=${String(session.gen ?? '')}`,
      );
      await this.emitEventWithin('spoutLayer.session.foreign', {
        reason,
        mismatch,
        expected: {
          root: this.root,
          instance: this.instance,
          generation: Number(expected.generation !== undefined ? expected.generation : this.generation),
          pid: Number(expected.pid !== undefined ? expected.pid : this.pid),
          created: String(expected.created !== undefined ? expected.created : this.created),
        },
        actual: {
          root: String(session.root ?? ''),
          instance: String(session.instance ?? session.instanceId ?? ''),
          generation: Number(session.gen ?? session.generation ?? 0),
          pid: Number(session.pid ?? 0),
          created: String(session.created ?? ''),
        },
      }, deadlineAt);
      return { ok: false, cleared: false, code: 'SESSION_FOREIGN', mismatch };
    }
    const cleared = this.clearSession();
    return { ok: cleared, cleared, reason: cleared ? reason : 'unlink-failed' };
  }

  async emitEvent(type, payload) {
    if (typeof this.log?.emit !== 'function') return;
    try {
      await this.log.emit(type, payload);
    } catch {
      /* logging must never break the display process lifecycle */
    }
  }

  /**
   * `emitEvent` bounded by the stop's shared deadline, with the same semantics as `shutdown.js`:
   * past the deadline the diagnostic is still attempted, but the caller never waits for it. A log
   * that stalls therefore cannot stretch `stop()` past its budget, and its timeout never changes
   * an item's verdict.
   */
  emitEventWithin(type, payload, deadlineAt = 0) {
    if (typeof this.log?.emit !== 'function') return Promise.resolve(null);
    const absolute = Number(deadlineAt);
    const left = Number.isFinite(absolute) && absolute > 0 ? absolute - Date.now() : Number.POSITIVE_INFINITY;
    if (left <= 0) {
      // The budget is spent: record the event best-effort, but do not make the stop wait for it.
      try {
        void Promise.resolve(this.log.emit(type, payload)).catch(() => {});
      } catch {
        /* a diagnostic log must not fail the stop */
      }
      return Promise.resolve(null);
    }
    const attempt = Promise.resolve().then(() => this.log.emit(type, payload)).then(() => true, () => true);
    if (!Number.isFinite(left)) return attempt;
    return this.awaitWithin(attempt, left);
  }

  // ---- lifecycle ---------------------------------------------------------------------------

  /**
   * Remove a previous generation that is provably ours: same attribution key AND a process
   * creation time matching the recorded one within 1 s. Anything else is left alone and reported
   * as ORPHAN_UNVERIFIED, because a PID alone can be reused after a reboot.
   */
  async cleanupStale() {
    const session = this.readSession();
    if (session === null) return { ok: true, killed: false, reason: 'no-session' };

    const sameOwner = String(session.root ?? '') === String(this.root)
      && String(session.instance ?? '') === this.instance;
    if (!sameOwner) {
      return { ok: false, killed: false, code: 'ORPHAN_UNVERIFIED', reason: 'owner-mismatch' };
    }
    const pid = Number(session.pid ?? 0);
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) {
      return { ok: true, killed: false, reason: 'bad-pid' };
    }
    if (!this.alive(pid)) {
      this.clearSession();
      return { ok: true, killed: false, reason: 'already-gone', pid };
    }
    const recorded = String(session.created ?? '');
    const actual = await this.processCreatedAt(pid);
    if (recorded === '' || actual === '') {
      return { ok: false, killed: false, code: 'ORPHAN_UNVERIFIED', reason: 'no-created-time', pid };
    }
    if (!sameInstant(actual, recorded)) {
      return {
        ok: false,
        killed: false,
        code: 'ORPHAN_UNVERIFIED',
        reason: 'created-mismatch',
        pid,
        recorded,
        actual,
      };
    }
    const killed = await this.killTree(pid);
    await this.emitEvent('spoutLayer.orphan.killed', { pid, created: actual });
    return { ok: true, killed, reason: killed ? 'attributed-kill' : 'kill-failed', pid };
  }

  /**
   * Start the display process. Never spawns when the launcher fails validation.
   * `options.bounds` (`{x,y,width,height}`) wins over the stored geometry: leaving edit mode passes
   * the rectangle VTS was left at, so the model reappears exactly in place.
   */
  async start(options = {}) {
    const override = editRectFrom(options?.bounds ?? null);
    // Mutual exclusion: a visible VTS window is the editable surface, so no display process may
    // run while an edit session is open (leaving edit mode closes the session before calling this).
    if (this.editing === true) {
      return {
        ...this.snapshot(),
        ok: false,
        code: 'EDIT_MODE_ACTIVE',
        error: '编辑模式进行中：显示进程不会启动',
        running: false,
        display: { ok: false, running: false },
        vts: this.currentVtsReport(),
      };
    }
    if (this.child !== null && this.child.exitCode === null) {
      // A display is already up: the hide result of THIS call is unchanged, but a retry chain left
      // pending by the call that started it must still be armed against the running generation.
      const armed = await this.armPendingVtsHide(this.generation);
      return {
        ...this.snapshot(),
        ok: true,
        already: true,
        running: true,
        display: { ok: true, running: true },
        vts: armed ?? this.currentVtsReport(),
      };
    }

    const validated = await this.validate(this.executable());
    if (!validated.ok) {
      this.error = { code: validated.code, message: validated.message, at: Date.now() };
      this.readyPhase = 'failed';
      await this.emitEvent('spoutLayer.start.failed', {
        code: validated.code,
        message: validated.message,
        executable: validated.path,
      });
      return {
        ...this.snapshot(),
        ok: false,
        code: validated.code,
        error: validated.message,
        display: { ok: false, running: false },
        vts: null,
      };
    }

    this.cleanup = await this.cleanupStale();

    // Entering Spout must not leave the real VTS window in front of the overlay. The hide has its
    // own finite retry chain and its own report: `display.ok` never implies `vts.hidden`.
    // `options.vtsHideHandled` is set by an edit exit, which already ran that first attempt.
    let vts = options?.vtsHideHandled === true
      ? this.currentVtsReport()
      : await this.hideVtsForDisplay('start');

    const generation = this.generation + 1;
    mkdirSync(this.dir, { recursive: true });
    mkdirSync(this.userDataDir, { recursive: true });
    const key = `root=${this.root};instance=${this.instance};gen=${generation}`;
    // `electron [options] [path]`: switches first, the layer entry last.
    const receiverTimeoutMs = this.receiverTimeout();
    const senderTimeoutMs = this.senderTimeout();
    const sender = this.senderName();
    const size = this.size();
    const requested = this.requestedBounds();
    const bounds = override === null
      ? requested
      : { left: override.x, top: override.y, width: override.width, height: override.height };
    const args = [
      '--force-device-scale-factor=1',
      `--user-data-dir=${this.userDataDir}`,
      `--dsh-receiver-timeout-ms=${receiverTimeoutMs}`,
      `--dsh-sender-timeout-ms=${senderTimeoutMs}`,
      `--dsh-sender=${sender}`,
      `--dsh-layer-key=${key}`,
    ];
    // A stable presentation size: absent means the display process latches the sender's published
    // size. The window rectangle is independent of both (design §3.1).
    if (size !== null) args.push(`--dsh-size=${size.width}x${size.height}`);
    // The display process is the only place the window rectangle is applied. No bounds means the
    // layer falls back to a centred 520×800 and reports `boundsSource:"fallback"`.
    if (bounds !== null) {
      args.push(`--dsh-bounds=${bounds.left},${bounds.top},${bounds.width},${bounds.height}`);
    }
    // Acceptance only: exercise Electron's 1000 ms "no receiver yet" path before the page loads.
    if (this.readSettings()?.textureSelfTest === true) args.push('--dsh-texture-selftest=1');
    args.push(this.mainPath);

    let child = null;
    try {
      child = this.spawnProcess(validated.path, args, {
        cwd: this.dir,
        env: this.childEnv(),
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      this.error = { code: 'WINDOW_FAILED', message: `spawn: ${error?.message ?? error}`, at: Date.now() };
      this.readyPhase = 'failed';
      // The display process never started: do not leave VTS hidden for a backend that is not up.
      await this.restoreVts();
      const failedVts = await this.abortPendingVtsHide('display-failed');
      return {
        ...this.snapshot(),
        ok: false,
        code: 'WINDOW_FAILED',
        error: this.error.message,
        display: { ok: false, running: false },
        vts: failedVts,
      };
    }

    this.child = child;
    this.generation = generation;
    this.pid = child.pid ?? 0;
    const spawnedPid = this.pid;
    this.lastPid = this.pid;
    this.startedAt = Date.now();
    this.stoppedAt = 0;
    this.readyPhase = 'starting';
    this.error = null;
    this.versions = null;
    this.display = null;
    this.stderr = '';
    this.tail = [];
    this.lastExit = null;
    this.stopFailed = false;
    this.stopping = false;
    this.stopStages = null;
    this.shutdownAck = null;
    this.shutdownReport = null;
    this.pendingAck = null;
    this.ownership = null;
    this.ownershipScan = null;
    this.created = '';
    this.receiverMs = 0;
    this.receiver = null;
    this.sharedTextureRegistered = false;
    this.textureTimeouts = 0;
    this.lastTextureSendMs = 0;
    this.textureFrames = 0;
    this.texturePush = '';
    this.textureSize = null;
    this.srcChanges = 0;
    this.health = null;
    this.stage2 = null;
    this.clearPendingEdit();
    this.editMode = false;
    this.editRect = null;
    this.bounds = bounds;
    this.boundsSource = override !== null ? 'edit' : (bounds === null ? 'fallback' : 'argument');
    this.windowBounds = null;
    this.sender = sender;
    this.senderWaitMs = senderTimeoutMs;

    // Open the evidence file before attaching the pipes: a failure during boot must be on disk.
    this.openDiagnostics({ gen: generation, executable: validated.path, version: validated.version, args });
    // Retain the actual spawn identity before any async probe: close can clear this.pid while
    // processCreatedAt is pending. Never write a pid=0 session or call that a successful launch.
    this.created = new Date(this.startedAt).toISOString();
    this.ownership = {
      root: this.root,
      instance: this.instance,
      generation,
      pid: spawnedPid,
      created: this.created,
      children: [],
      capturedAt: Date.now(),
      scans: 0,
    };
    this.attach(child);
    const actualCreated = spawnedPid > 0 ? await this.processCreatedAt(spawnedPid) : '';
    if (actualCreated !== '') {
      this.created = actualCreated;
      this.ownership.created = actualCreated;
    }
    if (spawnedPid <= 0 || this.child !== child || child.exitCode !== null
      || child.signalCode !== null || this.readyPhase === 'failed') {
      if (spawnedPid <= 0 && this.child === child) this.child = null;
      const code = spawnedPid > 0 ? 'LAUNCH_EXITED_EARLY' : 'WINDOW_FAILED';
      const message = `display launch failed (pid=${spawnedPid}, exit=${this.lastExit?.code ?? child.exitCode ?? 'unknown'}, signal=${this.lastExit?.signal ?? child.signalCode ?? ''})`;
      this.error = { code, message, at: Date.now() };
      this.readyPhase = 'failed';
      await this.emitEvent('spoutLayer.start.failed', {
        code, message, pid: spawnedPid, generation, lastExit: this.lastExit,
        diagnostics: this.diagnosticsFile,
      });
      // A launch that died before it could display must not leave the VTS window off-screen.
      await this.restoreVts();
      const failedVts = await this.abortPendingVtsHide('display-failed');
      return {
        ...this.snapshot(),
        ok: false,
        code,
        error: message,
        display: { ok: false, running: false },
        vts: failedVts,
      };
    }
    void this.refreshOwnership('spawn');

    this.writeSession({
      root: this.root,
      instance: this.instance,
      gen: generation,
      pid: this.pid,
      created: this.created,
      electronExecutable: validated.path,
      electronVersion: validated.version,
      main: this.mainPath,
      cwd: this.dir,
      userDataDir: this.userDataDir,
      sender,
      size: size ?? null,
      bounds: bounds ?? null,
      spawnedAt: new Date(this.startedAt).toISOString(),
    });

    await this.emitEvent('spoutLayer.spawned', {
      pid: this.pid,
      gen: generation,
      electron: validated.path,
      version: validated.version,
      cwd: this.dir,
      // Two independent conclusions: the display is up, and the real VTS window is (or is not)
      // hidden. A retrying/failed hide stays visible here instead of being absorbed by the spawn.
      display: { ok: true, running: true },
      vts: { hidden: this.vtsHidden === true, ok: vts.ok === true, code: vts.code ?? '' },
    });

    // The display is confirmed up and its generation is known: a hide that failed before the spawn
    // is now retried against exactly this generation, never against the one it started in.
    const armed = await this.armPendingVtsHide(generation);
    if (armed !== null) vts = armed;
    return {
      ok: true,
      code: '',
      running: true,
      ...this.snapshot(),
      display: { ok: true, running: true },
      vts,
    };
  }

  /**
   * Stop within the host's shared deadline.
   *
   * One clock for the whole operation: `stop({ deadlineAt })` spends the *remaining* time on the
   * graceful `shutdown` exchange, the force kill, and the confirmation. There are no per-phase
   * budgets added on top, and no cold WMI query at close time: the descendant snapshot was taken
   * while the layer was running (`ownership`).
   *
   * A successful `taskkill` is not evidence that the process exited. `confirmed`/`processTreeGone`
   * are true only after every recorded PID is observed gone; otherwise `{ ok: false,
   * confirmed: false }` is returned and the ownership record + `session.json` stay on disk.
   */
  async stop(options = {}) {
    const child = this.child;
    const generation = this.generation;
    const requestedAt = Date.now();
    // The retry chain protects a displaying window; a stop is exactly when it must go away. The
    // recorded failure is cleared too: after the restore, "hide failed" is no longer the state.
    this.cancelVtsHideRetry('stopping');
    this.vtsHideAttempts = 0;
    this.vtsHideFailure = null;
    const requestedDeadline = Number(options?.deadlineAt);
    const deadlineAt = Number.isFinite(requestedDeadline) && requestedDeadline > 0
      ? Math.max(requestedAt, Math.round(requestedDeadline))
      : requestedAt + DEFAULT_STOP_DEADLINE_MS;
    const budgetMs = Math.max(0, deadlineAt - requestedAt);
    // `exitRequestedAt` records the request; `mainExitAt`/`childExitAt` stay null until an exit is
    // actually observed. A wait timeout must never look like a completed exit.
    const stages = {
      requestedAt,
      deadlineAt,
      exitRequestedAt: null,
      mainExitAt: null,
      childExitAt: null,
    };
    this.stopStages = stages;
    void this.emitEvent('spoutLayer.stop.begin', { pid: this.pid, generation, deadlineAt, budgetMs });

    if (child === null) {
      // The close handler clears `child`/`pid` as soon as the main process exits, so an empty slot
      // is not evidence that the tree is gone. Verify the runtime-recorded ownership PIDs instead;
      // a live one keeps the stop unconfirmed and keeps the attribution record on disk.
      const survivors = this.attributedPids().filter((id) => this.alive(id));
      stages.confirmedAt = Date.now();
      if (survivors.length > 0) {
        this.stopFailed = true;
        this.stoppedAt = Date.now();
        this.readyPhase = 'stop-failed';
        const finalStages = { ...stages };
        this.stopStages = null;
        const elapsedMs = Date.now() - requestedAt;
        void this.emitEvent('spoutLayer.stop.failed', {
          pid: this.ownership?.pid ?? 0,
          generation,
          how: 'idle',
          killed: false,
          elapsedMs,
          deadlineAt,
          budgetMs,
          confirmed: false,
          processTreeGone: false,
          survivors,
          stages: finalStages,
          ownership: this.ownership,
        });
        return {
          ...this.snapshot(),
          ok: false,
          confirmed: false,
          processTreeGone: false,
          hostTeardownFinished: elapsedMs <= budgetMs + STOP_DEADLINE_SLACK_MS,
          code: 'STOP_FAILED',
          error: `进程树仍在运行（pid=${survivors.join(',')}）`,
          stopped: false,
          killed: false,
          how: 'idle',
          elapsedMs,
          deadlineAt,
          deadlineMs: budgetMs,
          stages: finalStages,
          ackReceived: false,
          running: false,
          stopFailed: true,
          sessionRetained: true,
          survivors,
          ownership: this.ownership,
        };
      }
      // Every recorded PID is gone: only now may the evidence file go, still inside the deadline.
      const ownership = this.ownership;
      const expected = ownership === null
        ? {}
        : { generation: ownership.generation, pid: ownership.pid, created: ownership.created };
      const released = await this.releaseSession('stop-idle', expected, deadlineAt);
      const elapsedMs = Date.now() - requestedAt;
      stages.confirmedAt = Date.now();
      this.child = null;
      this.pid = 0;
      this.created = '';
      this.ownership = null;
      this.stoppedAt = Date.now();
      this.readyPhase = 'stopped';
      this.stopFailed = false;
      this.editMode = false;
      this.editing = false;
      this.clearPendingEdit();
      // Leaving Spout restores the real VTS window to the rectangle captured on entry. Entering
      // edit mode asks for `raiseVts`: this restore is the editable surface coming back.
      const vts = await this.restoreVts(null, { raise: options?.raiseVts === true });
      const finalStages = { ...stages };
      this.stopStages = null;
      return {
        ...this.snapshot(),
        ok: true,
        confirmed: true,
        processTreeGone: true,
        hostTeardownFinished: elapsedMs <= budgetMs + STOP_DEADLINE_SLACK_MS,
        stopped: false,
        killed: false,
        running: false,
        elapsedMs,
        deadlineAt,
        deadlineMs: budgetMs,
        stages: finalStages,
        ackReceived: false,
        sessionRetained: released.cleared !== true && released.reason !== 'no-session',
        vts,
      };
    }

    const pid = this.pid;
    const created = this.created;
    const owned = this.ownedChildren();
    const ackPromise = new Promise((resolvePromise) => {
      this.pendingAck = resolvePromise;
    });
    let sent = false;
    let killed = false;
    let how = '';
    this.stopping = true;
    try {
      // 1. Explicit shutdown request. The peer parses stdin (not just EOF) and answers
      //    `shutdown-ack`, so the graceful path is observable instead of inferring it from exit.
      this.stopSeq += 1;
      const line = `${JSON.stringify({
        type: 'shutdown',
        seq: this.stopSeq,
        generation,
        reason: 'host-stop',
        deadlineAt,
        requestedAt,
      })}\n`;
      try {
        if (typeof child.stdin?.write === 'function') {
          child.stdin.write(line);
          sent = true;
        }
      } catch {
        sent = false;
      }
      stages.shutdownSentAt = Date.now();
      if (sent) {
        // Bounded ack wait inside the budget. A peer that ignores the message gets stdin EOF as
        // the old fallback, so a stop against an older layer still terminates.
        const ackWindow = Math.min(
          STOP_ACK_WINDOW_MS,
          Math.max(25, Math.round(budgetMs * 0.1)),
          Math.max(0, deadlineAt - Date.now()),
        );
        const ack = await this.awaitWithin(ackPromise, ackWindow);
        if (ack !== null) {
          stages.ackReceivedAt = Date.now();
        } else {
          try {
            child.stdin?.end?.();
          } catch {
            /* stdin already closed by the peer */
          }
          stages.eofFallbackAt = Date.now();
        }
      } else {
        try {
          child.stdin?.end?.();
        } catch {
          /* stdin already closed by the peer */
        }
        stages.eofFallbackAt = Date.now();
      }
      this.pendingAck = null;

      // 2. Graceful wait. The force-kill reserve comes *from* the deadline, never after it.
      const forceReserveMs = Math.min(
        STOP_FORCE_RESERVE_MAX_MS,
        Math.max(STOP_FORCE_RESERVE_MIN_MS, Math.round(budgetMs * 0.25)),
        Math.floor(budgetMs / 2),
      );
      const gracefulDeadlineAt = Math.max(requestedAt, deadlineAt - Math.max(0, forceReserveMs));
      const outcome = await this.waitForChildExit(child, gracefulDeadlineAt);
      how = outcome.how;
      // A timeout is not an exit: leave childExitAt null until liveness confirms the process gone.
      if (['exit', 'close', 'already-exited'].includes(outcome.how)) stages.childExitAt = outcome.at;

      // 3. Force kill only with the time that is actually left. A recorded tree that is still
      //    alive is a failure even when the root itself is gone.
      let survivors = [pid, ...owned].filter((id) => this.alive(id));
      if (survivors.length > 0 && Date.now() < deadlineAt) {
        stages.forceKillAt = Date.now();
        const killBudgetMs = Math.max(0, deadlineAt - Date.now());
        const rootTarget = survivors.includes(pid) ? pid : 0;
        const childTargets = survivors.filter((id) => id !== pid);
        const work = [];
        if (rootTarget > 0) {
          work.push(this.killTree(rootTarget, killBudgetMs).then(
            (value) => { if (value === true) killed = true; return value; },
            () => false,
          ));
        }
        if (childTargets.length > 0) {
          work.push(this.killPids(childTargets, killBudgetMs).then(
            (ids) => { if (Array.isArray(ids) && ids.length > 0) killed = true; return ids; },
            () => [],
          ));
        }
        // A wedged taskkill must not consume the confirmation time.
        await this.awaitWithin(Promise.all(work), Math.max(0, deadlineAt - Date.now()));
        stages.forceKillDoneAt = Date.now();
      }

      // 4. Confirmation by liveness only. `taskkill` success is deliberately not enough.
      survivors = await this.waitForPidsGone([pid, ...owned], deadlineAt);
      const processTreeGone = survivors.length === 0;
      // If the graceful wait timed out but the forced kill then landed, the confirmed liveness is
      // the exit evidence. A still-unconfirmed tree keeps childExitAt null.
      if (processTreeGone && !(Number(stages.childExitAt) > 0)) stages.childExitAt = Date.now();
      stages.confirmedAt = Date.now();
      const elapsedMs = Date.now() - requestedAt;
      const hostTeardownFinished = elapsedMs <= budgetMs + STOP_DEADLINE_SLACK_MS;
      const ackReceived = Number(stages.ackReceivedAt ?? 0) > 0;
      this.appendDiagnostics(
        `[stop] how=${how} killed=${String(killed)} confirmed=${String(processTreeGone)} elapsedMs=${elapsedMs} budgetMs=${budgetMs} owned=${owned.join(',')} survivors=${survivors.join(',')} stages=${JSON.stringify(stages)}`,
      );

      if (!processTreeGone) {
        // Keep child/pid/created, ownership and session.json. A later attribution sweep can deal
        // with the survivors; this call must never forge a success.
        this.stoppedAt = Date.now();
        this.stopFailed = true;
        this.readyPhase = 'stop-failed';
        const finalStages = { ...stages };
        this.stopStages = null;
        const error = `进程树仍在运行（pid=${survivors.join(',') || pid}）`;
        void this.emitEvent('spoutLayer.stop.failed', {
          pid,
          generation,
          created,
          how,
          killed,
          elapsedMs,
          deadlineAt,
          budgetMs,
          confirmed: false,
          processTreeGone: false,
          hostTeardownFinished,
          survivors,
          stages: finalStages,
          ownership: this.ownership,
        });
        return {
          ...this.snapshot(),
          ok: false,
          confirmed: false,
          processTreeGone: false,
          hostTeardownFinished,
          code: 'STOP_FAILED',
          error,
          stopped: false,
          killed,
          how,
          elapsedMs,
          deadlineAt,
          deadlineMs: budgetMs,
          stages: finalStages,
          ackReceived,
          running: true,
          stopFailed: true,
          sessionRetained: true,
          ownership: this.ownership,
        };
      }

      // Only now may the evidence file go, and only if it still names this run.
      const released = await this.releaseSession('stop', { generation, pid, created }, deadlineAt);
      this.child = null;
      this.pid = 0;
      this.created = '';
      this.ownership = null;
      this.stoppedAt = Date.now();
      this.readyPhase = 'stopped';
      this.stopFailed = false;
      this.editMode = false;
      this.editing = false;
      this.clearPendingEdit();
      // Leaving Spout restores the real VTS window to the rectangle captured on entry. Entering
      // edit mode asks for `raiseVts`: this restore is the editable surface coming back.
      const vts = await this.restoreVts(null, { raise: options?.raiseVts === true });
      const finalElapsedMs = Date.now() - requestedAt;
      const finalStages = { ...stages };
      this.stopStages = null;
      const finalHostTeardownFinished = finalElapsedMs <= budgetMs + STOP_DEADLINE_SLACK_MS;
      void this.emitEvent('spoutLayer.stopped', {
        pid,
        how,
        killed,
        elapsedMs: finalElapsedMs,
        deadlineAt,
        budgetMs,
        confirmed: true,
        processTreeGone: true,
        hostTeardownFinished: finalHostTeardownFinished,
        stages: finalStages,
      });
      return {
        ...this.snapshot(),
        ok: true,
        confirmed: true,
        processTreeGone: true,
        hostTeardownFinished: finalHostTeardownFinished,
        stopped: true,
        killed,
        how,
        elapsedMs: finalElapsedMs,
        deadlineAt,
        deadlineMs: budgetMs,
        stages: finalStages,
        ackReceived,
        running: false,
        sessionRetained: released.cleared !== true && released.reason !== 'no-session',
        vts,
      };
    } finally {
      this.pendingAck = null;
      this.stopping = false;
    }
  }

  /**
   * Resolve when the child reports exit/close/error, or at `deadlineAt` with `how:"timeout"`.
   * Listeners are removed on every path so a timed-out stop does not leak handlers.
   */
  waitForChildExit(child, deadlineAt) {
    if (child.exitCode !== null || child.signalCode !== null) {
      return Promise.resolve({ how: 'already-exited', at: Date.now() });
    }
    return new Promise((resolvePromise) => {
      let settled = false;
      let timer = null;
      const cleanup = () => {
        if (timer !== null) clearTimeout(timer);
        child.off?.('exit', onExit);
        child.off?.('close', onClose);
        child.off?.('error', onError);
      };
      const settle = (how) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolvePromise({ how, at: Date.now() });
      };
      const onExit = () => settle('exit');
      const onClose = () => settle('close');
      const onError = () => settle('error');
      child.once('exit', onExit);
      child.once('close', onClose);
      child.once('error', onError);
      timer = setTimeout(() => settle('timeout'), Math.max(0, deadlineAt - Date.now()));
    });
  }

  // ---- stdout protocol ---------------------------------------------------------------------

  attach(child) {
    child.stdout?.setEncoding('utf8');
    let buffer = '';
    child.stdout?.on('data', (chunk) => {
      buffer += chunk;
      let at = buffer.indexOf('\n');
      while (at !== -1) {
        const line = buffer.slice(0, at).trim();
        buffer = buffer.slice(at + 1);
        this.appendDiagnostics(`[stdout] ${line}`);
        if (line.length > 0) this.handleLine(line);
        at = buffer.indexOf('\n');
      }
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk) => {
      // Keep the full text on disk (the snapshot only carries a clipped tail); Chromium starts
      // printing GPU/cache warnings long before the first frame, and they are the evidence.
      this.appendDiagnostics(`[stderr] ${String(chunk)}`);
      this.stderr = clipText(`${this.stderr}${chunk}`, 1000);
    });
    // A renderer that never reads closes the pipe; that EPIPE must not crash the host.
    child.stdin?.on('error', () => {});

    child.on('error', (error) => {
      this.error = { code: 'WINDOW_FAILED', message: `spawn: ${error?.message ?? error}`, at: Date.now() };
      this.readyPhase = 'failed';
      this.appendDiagnostics(`[spawn-error] ${error?.code ?? ''} ${error?.message ?? error}`);
    });
    child.on('exit', (code, signal) => {
      this.lastExit = { code, signal, at: Date.now() };
      this.appendDiagnostics(`[exit] code=${String(code)} signal=${String(signal)} phase=${this.readyPhase} receiverMs=${this.receiverMs}`);
    });
    child.on('close', (code) => {
      const phaseBeforeExit = this.readyPhase;
      if (this.child !== child) return;
      // The layer window is gone; edit mode cannot still be interactive.
      this.editMode = false;
      this.clearPendingEdit();
      // While a stop is in flight the pid/created/ownership record must survive until stop()
      // decides. Clearing it here would erase the only evidence for a still-live descendant.
      if (this.stopping !== true) {
        // The layer process died on its own: do not leave VTS parked off-screen for a mode that
        // is no longer running. A normal stop restores in `stop()` instead (stopping === true).
        this.cancelVtsHideRetry('display-closed');
        void this.restoreVts();
        this.child = null;
        this.pid = 0;
      }
      if (this.readyPhase !== 'failed') this.readyPhase = 'stopped';
      if (buffer.length > 0) this.appendDiagnostics(`[stdout:partial] ${buffer}`);
      this.appendDiagnostics(
        `[close] code=${String(code)} phaseBeforeExit=${phaseBeforeExit} phase=${this.readyPhase} receiverMs=${this.receiverMs} diagnostics=${this.diagnosticsFile}`,
      );
      // The phase at exit is the diagnosis: overwriting it with "stopped" hid whether the child
      // died while starting, while loading the page, or after the receiver was already up.
      void this.emitEvent('spoutLayer.exited', {
        code,
        phase: phaseBeforeExit,
        phaseAfter: this.readyPhase,
        receiverMs: this.receiverMs,
        diagnostics: this.diagnosticsFile,
      });
    });
  }

  handleLine(line) {
    let payload = null;
    try {
      payload = JSON.parse(line);
    } catch {
      this.tail = [...this.tail.slice(-19), clipText(line, 200)];
      return;
    }
    const type = String(payload?.type ?? '');

    if (type === 'shutdown-ack') {
      const receivedAt = Date.now();
      this.shutdownAck = { ...payload, receivedAt };
      this.mergeStopStages(payload?.stages);
      const resolveAck = this.pendingAck;
      this.pendingAck = null;
      if (typeof resolveAck === 'function') resolveAck(this.shutdownAck);
      void this.emitEvent('spoutLayer.shutdown.ack', {
        seq: Number(payload?.seq ?? 0),
        receivedAt,
        deadlineAt: Number(payload?.deadlineAt ?? 0),
        stages: { ...(this.stopStages ?? {}) },
      });
      return;
    }

    if (type === 'shutdown-stage') {
      const stage = String(payload?.stage ?? '');
      const at = Number(payload?.at ?? 0) || Number(payload?.atMs ?? 0) || Date.now();
      this.mergeStopStages(payload?.stages ?? { [stage]: at });
      void this.emitEvent('spoutLayer.shutdown.stage', {
        stage,
        at,
        reason: String(payload?.reason ?? ''),
        stages: { ...(this.stopStages ?? {}) },
      });
      return;
    }

    if (
      type === 'diagnostic'
      && (String(payload?.event ?? '') === 'spout.alpha.sample' || String(payload?.event ?? '') === 'spout.alpha.opaque-frame')
    ) {
      // Receiver-side alpha evidence: the display process already classified the frame; the host
      // records it so a white/black background can be located from data instead of guessed.
      const total = Math.max(0, Math.round(Number(payload?.total) || 0));
      this.alphaSample = {
        event: String(payload.event),
        total,
        alphaZero: Math.max(0, Math.round(Number(payload?.alphaZero) || 0)),
        alphaOpaque: Math.max(0, Math.round(Number(payload?.alphaOpaque) || 0)),
        alphaPartial: Math.max(0, Math.round(Number(payload?.alphaPartial) || 0)),
        verdict: String(payload?.verdict ?? ''),
        width: Math.max(0, Math.round(Number(payload?.width) || 0)),
        height: Math.max(0, Math.round(Number(payload?.height) || 0)),
        at: Date.now(),
      };
      void this.emitEvent('spout.alpha.sample', { ...this.alphaSample });
      return;
    }

    if (type === 'diagnostic' && String(payload?.event ?? '') === 'spout.stage2') {
      // Stage-2 line from the display process; other diagnostic events still land in the tail.
      const fpsValue = Number(payload?.fps);
      this.stage2 = {
        fps: Number.isFinite(fpsValue) ? Math.round(fpsValue * 10) / 10 : 0,
        dropped: Math.max(0, Math.round(Number(payload?.dropped) || 0)),
        resized: Math.max(0, Math.round(Number(payload?.resized) || 0)),
        framebufferErrors: Math.max(0, Math.round(Number(payload?.framebufferErrors) || 0)),
        alphaMode: String(payload?.alphaMode ?? ''),
        at: Date.now(),
      };
      void this.emitEvent('spout.stage2', { ...this.stage2 });
      return;
    }

    if (type === 'diagnostic' && String(payload?.event ?? '').startsWith('spout.edit.')) {
      const event = String(payload.event);
      const rect = editRectFrom(payload);
      if (rect !== null) {
        this.editRect = rect;
        // The edit rectangle is the same host-owned geometry the layer was started with.
        this.bounds = { left: rect.x, top: rect.y, width: rect.width, height: rect.height };
        this.boundsSource = 'edit';
      }
      const entering = event === 'spout.edit.enter';
      if (entering || event === 'spout.edit.exit') {
        this.editMode = entering;
        const pending = this.pendingEdit;
        if (pending !== null && pending.enabled === entering) this.settleEdit(pending, payload);
      }
      // Edit mode drives the overlay window only. VTS stays parked off-screen for the whole
      // Spout session, so a drag or resize can never bring the two windows on screen together.
      this.tail = [...this.tail.slice(-19), clipText(line, 200)];
      void this.emitEvent(event, {
        bounds: this.editBounds(),
        ...(rect ?? {}),
        at: new Date().toISOString(),
      });
      return;
    }

    if (type === 'health') {
      const fpsValue = Number(payload.fps);
      const fpsMinValue = Number(payload.fpsMin);
      const fpsMaxValue = Number(payload.fpsMax);
      const width = Math.max(0, Math.round(Number(payload.width) || 0));
      const height = Math.max(0, Math.round(Number(payload.height) || 0));
      const textureWidth = Math.max(0, Math.round(Number(payload.textureWidth) || 0));
      const textureHeight = Math.max(0, Math.round(Number(payload.textureHeight) || 0));
      this.health = {
        fps: Number.isFinite(fpsValue) ? Math.round(fpsValue * 10) / 10 : 0,
        fpsMin: Number.isFinite(fpsMinValue) ? Math.round(fpsMinValue * 10) / 10 : 0,
        fpsMax: Number.isFinite(fpsMaxValue) ? Math.round(fpsMaxValue * 10) / 10 : 0,
        width,
        height,
        textureWidth,
        textureHeight,
        stableWidth: Math.max(0, Math.round(Number(payload.stableWidth) || 0)),
        stableHeight: Math.max(0, Math.round(Number(payload.stableHeight) || 0)),
        drawn: Math.max(0, Math.round(Number(payload.drawn) || 0)),
        placeholder: payload.placeholder === true,
        at: Date.now(),
      };
      // The texture size is the source frame, not the (fixed) canvas: VTS is 563×880 inside a
      // 520×800 window here. Fall back to the canvas only if no frame has arrived yet.
      if (textureWidth > 0 && textureHeight > 0) {
        this.textureSize = {
          width: textureWidth,
          height: textureHeight,
          stableWidth: this.health.stableWidth || textureWidth,
          stableHeight: this.health.stableHeight || textureHeight,
        };
        this.textureFrames = Math.max(this.textureFrames, this.health.drawn);
      } else if (width > 0 && height > 0) {
        this.textureSize = {
          width,
          height,
          stableWidth: this.health.stableWidth || width,
          stableHeight: this.health.stableHeight || height,
        };
      }
      return;
    }

    if (type === 'ready') {
      const phase = String(payload.phase ?? '');
      if (payload.versions !== undefined) this.versions = payload.versions;
      if (payload.display !== undefined) this.display = payload.display;
      // Shared-texture acceptance evidence: the renderer registered Electron's receiver and the
      // main process recorded every 1000 ms delivery timeout instead of faking a dead layer.
      if (payload.sharedTextureRegistered === true) this.sharedTextureRegistered = true;
      if (Number.isFinite(Number(payload.textureTimeouts))) {
        this.textureTimeouts = Math.max(0, Math.round(Number(payload.textureTimeouts)));
      }
      if (Number.isFinite(Number(payload.lastTextureSendMs))) {
        this.lastTextureSendMs = Math.max(0, Math.round(Number(payload.lastTextureSendMs)));
      }
      if (Number.isFinite(Number(payload.textureFrames))) {
        this.textureFrames = Math.max(0, Math.round(Number(payload.textureFrames)));
      }
      if (typeof payload.texturePush === 'string' && payload.texturePush.length > 0) {
        this.texturePush = payload.texturePush;
      }
      if (payload.srcSize !== undefined && payload.srcSize !== null) {
        const width = Math.max(0, Math.round(Number(payload.srcSize.width) || 0));
        const height = Math.max(0, Math.round(Number(payload.srcSize.height) || 0));
        if (width > 0 && height > 0) {
          this.textureSize = {
            width,
            height,
            stableWidth: Math.max(0, Math.round(Number(payload.stableSize?.width) || width)),
            stableHeight: Math.max(0, Math.round(Number(payload.stableSize?.height) || height)),
          };
        }
      }
      if (Number.isFinite(Number(payload.srcChanges))) {
        this.srcChanges = Math.max(0, Math.round(Number(payload.srcChanges)));
      }
      if (payload.window !== undefined) {
        if (payload.window?.requested || payload.window?.boundsSource) {
          this.windowBounds = payload.window;
          if (payload.window?.requested) this.bounds = { ...payload.window.requested };
          if (typeof payload.window?.boundsSource === 'string') this.boundsSource = payload.window.boundsSource;
        } else {
          // Later ready phases carry visibility flags only; keep the geometry evidence from
          // the control report instead of overwriting it.
          this.windowBounds = { ...(this.windowBounds ?? {}), ...payload.window };
        }
      }
      this.readyPhase = phase;
      this.lastReportAt = Date.now();
      // If VTS was not running when Spout started, the receiver phase proves the display is up:
      // give the hide the same finite retry chain instead of a single fire-and-forget attempt.
      // It also runs during edit, where the overlay is interactive but VTS must stay off-screen.
      if (phase === 'receiver' && this.vtsWindow !== null && this.vtsHidden !== true
        && this.vtsHidePending === null && this.isEditing() !== true) {
        void (async () => {
          await this.hideVtsForDisplay('receiver');
          await this.armPendingVtsHide(this.generation);
        })();
      }
      // Capture descendants while the layer is running: the GPU/renderer children exist once the
      // control window is up. Never defer this to stop(), where the same query blocks shutdown.
      if (phase === 'control' || phase === 'receiver') void this.refreshOwnership(phase);
      const elapsedMs = Number(payload.elapsedMs);
      if (phase === 'receiver' && Number.isFinite(elapsedMs)) this.receiverMs = Math.max(0, Math.round(elapsedMs));
      if (phase === 'receiver' || phase === 'waiting-sender') {
        if (payload.registered !== true) {
          // A painted test canvas is no longer accepted as receiver evidence.
          this.error = {
            code: 'RECEIVER_NOT_READY',
            message: `${phase} report without registered:true`,
            at: Date.now(),
          };
        } else {
          this.receiver = {
            registered: true,
            connected: payload.connected === true,
            sender: String(payload.sender ?? ''),
            surface: payload.surface ?? null,
            platform: String(payload.surface?.platform ?? ''),
            listed: payload.listed === true,
            frameAvailable: payload.frameAvailable === true,
            waitedMs: Number(payload.waitedMs ?? 0),
            at: Date.now(),
          };
        }
      }
      // The elapsed time is the fact a timeout decision needs: "receiver took 4.8 s" is actionable,
      // "timeout" alone is not.
      this.appendDiagnostics(
        `[ready] phase=${phase} registered=${String(payload.registered === true)} sender=${String(payload.sender ?? '')} drawn=${String(payload.drawn === true)} frames=${String(payload.frames ?? '')} elapsedMs=${String(payload.elapsedMs ?? '')}`,
      );
      this.appendDiagnostics(
        `[texture] registered=${String(this.sharedTextureRegistered)} timeouts=${this.textureTimeouts} lastSendMs=${this.lastTextureSendMs} frames=${this.textureFrames} push=${this.texturePush || 'unknown'}`,
      );
      void this.emitEvent('spoutLayer.ready', {
        phase,
        registered: payload.registered === true,
        connected: payload.connected === true,
        sender: String(payload.sender ?? ''),
        surface: payload.surface ?? null,
        drawn: payload.drawn === true,
        frames: Number(payload.frames ?? 0),
        elapsedMs: Number.isFinite(elapsedMs) ? elapsedMs : null,
        versions: payload.versions ?? null,
        display: payload.display ?? null,
      });
      return;
    }

    if (type === 'error') {
      const code = String(payload.code ?? 'PROTOCOL_ERROR');
      this.error = {
        code,
        message: clipText(payload.message ?? '', 300),
        at: Date.now(),
      };
      if (code === 'SENDER_NOT_FOUND') {
        // The window is intentionally still alive in waiting-sender; keep that phase visible so
        // status shows both "process running" and "sender missing".
        if (this.receiver !== null) this.receiver.timedOut = true;
        if (this.readyPhase === '') this.readyPhase = 'waiting-sender';
      } else {
        this.readyPhase = 'failed';
      }
      this.appendDiagnostics(`[error] code=${code} message=${clipText(payload.message ?? '', 300)}`);
      void this.emitEvent('spoutLayer.error', this.error);
      return;
    }

    if (type === 'exit') {
      this.shutdownReport = payload;
      this.mergeStopStages(payload?.stages);
      this.tail = [...this.tail.slice(-19), `exit:${String(payload.reason ?? '')}`];
      void this.emitEvent('spoutLayer.exit.reported', {
        reason: String(payload?.reason ?? ''),
        stages: { ...(this.stopStages ?? {}) },
      });
      return;
    }

    if (type === 'info') {
      this.tail = [...this.tail.slice(-19), clipText(line, 200)];
      this.recordInfo(String(payload.message ?? ''), Number(payload.throttled) || 0);
      return;
    }

    this.tail = [...this.tail.slice(-19), clipText(line, 200)];
  }

  /**
   * Record one `info` line, coalescing identical messages inside the throttle window. The count of
   * repeats that were not written rides on the next recorded line as `throttled`, so the ratio is
   * still auditable from the event log. Failure reports bypass this gate entirely.
   */
  recordInfo(message, sourceThrottled = 0) {
    if (INFO_FAILURE_PATTERN.test(message)) {
      void this.emitEvent('spoutLayer.info', { message });
      return;
    }
    const now = Date.now();
    const previous = this.infoThrottle.get(message);
    if (previous !== undefined && now - previous.at < this.infoThrottleMs) {
      previous.suppressed += 1;
      this.infoThrottled += 1;
      return;
    }
    // The child also coalesces, so its suppressed count must survive the host gate; otherwise the
    // line that finally reaches the event log would report `throttled: 0` and hide the real ratio.
    const throttled = (previous === undefined ? 0 : previous.suppressed) + sourceThrottled;
    if (this.infoThrottle.size >= 64) {
      for (const key of this.infoThrottle.keys()) {
        if (this.infoThrottle.size < 32) break;
        this.infoThrottle.delete(key);
      }
    }
    this.infoThrottle.set(message, { at: now, suppressed: 0 });
    void this.emitEvent('spoutLayer.info', { message, throttled });
  }

  // ---- snapshot ----------------------------------------------------------------------------

  /** Synchronous view for /assistant/status (no awaits, no probes). */
  snapshot() {
    const running = this.child !== null && this.child.exitCode === null;
    const executable = this.executable();
    return {
      /** The backend this instance really is; never a literal, so status cannot mislabel it. */
      backend: this.backend,
      running,
      pid: running ? this.pid : 0,
      lastPid: this.lastPid,
      configured: executable.length > 0,
      electronExecutable: executable,
      created: this.created,
      readyPhase: this.readyPhase,
      lastReportAt: this.lastReportAt > 0 ? new Date(this.lastReportAt).toISOString() : '',
      receiverMs: this.receiverMs,
      receiverTimeoutMs: this.receiverTimeout(),
      sender: this.senderName(),
      senderTimeoutMs: this.senderTimeout(),
      /** Last native receiver report; `null` before registration. */
      receiver: this.receiver,
      /** Electron shared-texture receiver + delivery evidence. */
      sharedTextureRegistered: this.sharedTextureRegistered === true,
      textureTimeouts: this.textureTimeouts,
      lastTextureSendMs: this.lastTextureSendMs,
      textureFrames: this.textureFrames,
      texturePush: this.texturePush,
      /** Stable presentation size (configured) and the last frame size reported by the display. */
      configuredSize: this.size(),
      textureSize: this.textureSize,
      srcChanges: this.srcChanges,
      /** Last 1 Hz renderer health report (fps + size); `null` before the first report. */
      health: this.health,
      /** Last stage-2 diagnostic (`fps`, `dropped`, `resized`, `alphaMode`). */
      stage2: this.stage2,
      /** Last receiver-side alpha sample; the evidence for a white/black display background. */
      alphaSample: this.alphaSample === null ? null : { ...this.alphaSample },
      /** Requested rectangle and its provenance; `windowBounds` is the OS-reported rectangle. */
      bounds: this.bounds,
      boundsSource: this.boundsSource,
      windowBounds: this.windowBounds,
      /**
       * Edit session state. `editMode` answers "is a session open" for any surface; `editSession`
       * says which one (`vts` = real window visible, display process stopped; `layer` = the
       * display window itself is being dragged, only when no VTS window controller exists).
       */
      editMode: this.isEditing(),
      editSession: this.editing === true ? 'vts' : (this.editMode === true ? 'layer' : ''),
      editBounds: this.editBounds(),
      /**
       * The off-screen rectangle VTS is parked at for Spout capture. It is deliberately separate
       * from `bounds`/`editBounds` (the user's rectangle) and is never persisted as geometry.
       */
      captureRect: this.captureRect === null ? null : { ...this.captureRect },
      /** Real VTS window state (hidden/original/error) driven by the shared WPF window helper. */
      vtsWindow: this.vtsSnapshot(),
      /**
       * VTS-hide convergence, kept separate from `running`: `hidden` is false whenever the real
       * window is not parked, `failure` names the code/message when the retry budget was spent.
       */
      vtsHide: this.vtsHideSnapshot(),
      diagnostics: this.diagnosticsFile,
      error: this.error === null
        ? null
        : { code: this.error.code, message: this.error.message, at: this.error.at },
      versions: this.versions,
      display: this.display,
      lastExit: this.lastExit,
      /** True when the last stop could not confirm the process tree is gone. */
      stopFailed: this.stopFailed === true,
      /** Ownership captured during the run; retained while a stop is unconfirmed. */
      ownership: this.ownership === null
        ? null
        : {
          pid: this.ownership.pid,
          created: this.ownership.created,
          root: this.ownership.root,
          children: [...(this.ownership.children ?? [])],
          capturedAt: this.ownership.capturedAt,
        },
      lastCleanup: this.cleanup,
      startedAt: this.startedAt,
      stoppedAt: this.stoppedAt,
      stderr: clipText(this.stderr, 300),
      /** Cumulative `info` lines coalesced by the throttle (the event log keeps 1 per window). */
      infoThrottled: this.infoThrottled,
      stdoutTail: [...this.tail.slice(-5)],
      pinnedMajor: PINNED_ELECTRON_MAJOR,
      pinnedVersion: PINNED_ELECTRON_VERSION,
    };
  }
}


