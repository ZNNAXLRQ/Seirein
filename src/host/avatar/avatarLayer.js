/**
 * Transparent avatar layer.
 *
 * VTube Studio's own desktop transparency is unreliable on Windows 11, so we mirror it:
 *   - move the VTS window offscreen (its magenta-keyed surface stays renderable),
 *   - transparent.ps1 captures that window with PrintWindow, keys the magenta out and draws
 *     the model in our own transparent, click-through, always-on-top window,
 *   - the host drives geometry/edit mode through a state.json file.
 */
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/**
 * The one capture geometry the WPF mirror can read: off the visible desktop, but still a normal
 * (non-minimized) window PrintWindow can render. The host moves VTS here before every WPF start.
 */
export const WPF_OFFSCREEN = Object.freeze({ x: -2200, y: -1400, width: 900, height: 1200 });
/** Where VTS is put back while the user edits it (WPF edit mode). */
export const WPF_ONSCREEN = Object.freeze({ x: 120, y: 80, width: 900, height: 1200 });

/**
 * Default chroma key of the WPF mirror: VTS's magenta surface (255,0,255) and the tolerance the
 * script has always used. Exported so a caller can inject another key without editing the script;
 * omitting the override keeps the previous behaviour exactly.
 */
export const WPF_KEY = Object.freeze({ r: 255, g: 0, b: 255, tolerance: 60 });

const OFFSCREEN = WPF_OFFSCREEN;
const ONSCREEN = WPF_ONSCREEN;

function clampChannel(value, fallback) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.max(0, Math.min(255, n)) : fallback;
}

/** Normalize an injected key; every missing/invalid field falls back to the magenta default. */
export function normalizeKey(key = WPF_KEY) {
  const tolerance = Math.round(Number(key?.tolerance));
  return Object.freeze({
    r: clampChannel(key?.r, WPF_KEY.r),
    g: clampChannel(key?.g, WPF_KEY.g),
    b: clampChannel(key?.b, WPF_KEY.b),
    tolerance: Number.isFinite(tolerance) ? Math.max(0, Math.min(765, tolerance)) : WPF_KEY.tolerance,
  });
}

/** `transparent.ps1 -Key*` arguments for one key; pure so tests never spawn PowerShell. */
export function keyingArgs(key = WPF_KEY) {
  const k = normalizeKey(key);
  return ['-KeyR', String(k.r), '-KeyG', String(k.g), '-KeyB', String(k.b), '-KeyTolerance', String(k.tolerance)];
}

/** A re-read client rectangle may differ by this many pixels before it is a mismatch. */
export const MOVE_TOLERANCE_PX = 2;
/**
 * How far VTS may drift from the rectangle this layer took over before another backend is assumed
 * to own the window. stop() then leaves it alone instead of dragging it back to a stale position.
 */
export const RESTORE_DRIFT_PX = 32;
/** Identical frames needed before a full-frame (covering) capture is treated as frozen. */
export const FROZEN_FRAME_LIMIT = 3;

/** `{x,y,width,height}` / `{left,top,…}` → `{left,top,width,height}`, or null. */
export function clientRect(value) {
  if (value === null || typeof value !== 'object') return null;
  const left = Number(value.left ?? value.x);
  const top = Number(value.top ?? value.y);
  const width = Number(value.width);
  const height = Number(value.height);
  if (![left, top, width, height].every((part) => Number.isFinite(part))) return null;
  if (width <= 0 || height <= 0) return null;
  return { left: Math.round(left), top: Math.round(top), width: Math.round(width), height: Math.round(height) };
}

/** True when `actual` differs from `expected` by more than `tolerancePx` on any edge or size. */
export function rectDrifted(actual, expected, tolerancePx = RESTORE_DRIFT_PX) {
  const a = clientRect(actual);
  const b = clientRect(expected);
  if (a === null || b === null) return false;
  return ['left', 'top', 'width', 'height'].some((key) => Math.abs(a[key] - b[key]) > tolerancePx);
}

/**
 * True when a rectangle is the off-screen capture corner rather than a user position. The size is
 * ignored: only the origin marks the corner, and any size parked there is still not editable.
 */
export function isCaptureRect(value, capture = WPF_OFFSCREEN, tolerance = MOVE_TOLERANCE_PX) {
  const rect = clientRect(value);
  const corner = clientRect(capture);
  if (rect === null || corner === null) return false;
  return Math.abs(rect.left - corner.left) <= tolerance && Math.abs(rect.top - corner.top) <= tolerance;
}

/** True when a captured background pixel is close enough to the configured key. */
export function keyMatches(corner, key = WPF_KEY) {
  if (corner === null || corner === undefined) return null;
  const channels = [corner.r, corner.g, corner.b].map((part) => Math.round(Number(part)));
  if (!channels.every((part) => Number.isFinite(part) && part >= 0 && part <= 255)) return null;
  const k = normalizeKey(key);
  const distance = Math.abs(channels[0] - k.r) + Math.abs(channels[1] - k.g) + Math.abs(channels[2] - k.b);
  return distance <= k.tolerance;
}

/**
 * Whether one captured frame may replace the displayed one. Coverage alone never decides this: a
 * black background frames the whole client area, so "opaque everywhere" is a legitimate picture.
 * Only a frame that stays pixel-identical across several ticks *and* covers the whole frame is
 * treated as frozen (a static full-frame picture is visually unchanged by keeping the last one).
 * Mirrored by the tick handler in `transparent.ps1` (keep the two in sync).
 */
export function evaluateFrame({ bounds, clientWidth, clientHeight, identicalFrames = 1, visible = true } = {}) {
  const width = Math.max(0, Math.round(Number(clientWidth) || 0));
  const height = Math.max(0, Math.round(Number(clientHeight) || 0));
  if (visible !== true) return { accept: false, reason: 'window-invisible' };
  if (width === 0 || height === 0) return { accept: false, reason: 'client-size-zero' };
  const area = Math.max(0, Number(bounds?.width) || 0) * Math.max(0, Number(bounds?.height) || 0);
  const covering = area >= width * height * 0.95;
  if (covering && Number(identicalFrames) >= FROZEN_FRAME_LIMIT) {
    return { accept: false, reason: 'frozen-covering-frame' };
  }
  return { accept: true, reason: 'ok' };
}

/** Corner sample `transparent.ps1` leaves in `<dir>/capture.json`, or null when absent/malformed. */
export async function readCaptureCornersFrom(dir) {
  try {
    const raw = JSON.parse(await readFile(join(dir, 'capture.json'), 'utf8'));
    const parse = (value) => {
      const r = Math.round(Number(value?.r));
      const g = Math.round(Number(value?.g));
      const b = Math.round(Number(value?.b));
      return [r, g, b].every((n) => Number.isFinite(n) && n >= 0 && n <= 255) ? { r, g, b } : null;
    };
    const topLeft = parse(raw?.topLeft);
    const bottomRight = parse(raw?.bottomRight);
    return topLeft === null || bottomRight === null ? null : { topLeft, bottomRight };
  } catch {
    return null;
  }
}

/**
 * One-time correction of a configuration an earlier version polluted: the off-screen capture
 * corner saved as the user position. Returns the settings patch plus `{key, oldValue, newValue}`
 * records, so the caller can log exactly what changed (no silent rewrite).
 */
export function sanitizeStoredGeometry(saved, { capture = WPF_OFFSCREEN, fallback = WPF_ONSCREEN } = {}) {
  const corner = clientRect(capture);
  const base = clientRect(fallback);
  const layer = { ...(saved?.layer ?? {}) };
  const patch = {};
  const fixes = [];
  if (isCaptureRect(saved?.layerGeometry, capture)) {
    patch.layerGeometry = { left: base.left, top: base.top, width: base.width, height: base.height };
    fixes.push({ key: 'layerGeometry', oldValue: { ...saved.layerGeometry }, newValue: { ...patch.layerGeometry } });
  }
  if (isCaptureRect(layer?.spout?.bounds, capture)) {
    const target = patch.layerGeometry ?? clientRect(saved?.layerGeometry) ?? base;
    patch.layer = {
      ...layer,
      spout: {
        ...(layer.spout ?? {}),
        bounds: { x: target.left, y: target.top, width: target.width, height: target.height },
      },
    };
    fixes.push({
      key: 'layer.spout.bounds',
      oldValue: { ...layer.spout.bounds },
      newValue: { ...patch.layer.spout.bounds },
    });
  }
  return {
    fixes,
    patch,
    captureRect: corner === null ? null : { x: corner.left, y: corner.top, width: corner.width, height: corner.height },
  };
}

/** `{left,top,…}` → the `{x,y,width,height}` shape `window.raised` and the layer events use. */
function asBounds(rect) {
  return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
}

/**
 * Wrap a VTS window controller so `move()` reports the client rectangle the window really has.
 * The move is re-read through `capture()`, `window.move.mismatch` fires past `tolerancePx`, and the
 * caller gets the actual rectangle instead of the request it passed in.
 */
export function verifiedVtsWindow(controller, { onMismatch = null, tolerancePx = MOVE_TOLERANCE_PX } = {}) {
  return {
    capture: () => controller.capture(),
    /**
     * `options.raise` is forwarded to the controller: only the edit-recovery move asks for it,
     * every other move (parking VTS, starting a display) keeps the previous no-z-order behaviour.
     */
    async move(rect, options = {}) {
      const requested = clientRect(rect);
      const moved = await controller.move(rect, { raise: options?.raise === true });
      if (moved?.ok !== true || requested === null) return moved;
      const read = await controller.capture();
      const actual = read?.ok === true ? clientRect(read.bounds) : (clientRect(moved.bounds) ?? requested);
      const delta = {
        left: actual.left - requested.left,
        top: actual.top - requested.top,
        width: actual.width - requested.width,
        height: actual.height - requested.height,
      };
      const mismatch = Object.values(delta).some((value) => Math.abs(value) > tolerancePx);
      const result = { ...moved, requested, actual, bounds: actual, delta, mismatch };
      if (mismatch && typeof onMismatch === 'function') {
        try {
          await onMismatch(result);
        } catch {
          /* telemetry must never break a window move */
        }
      }
      return result;
    },
  };
}

/**
 * Top-left and bottom-right pixels of one captured frame. `pixels` is a 4-byte-per-pixel buffer in
 * `channelOrder` ('rgba' by default, 'bgra' for PrintWindow's Bitmap); 1 px each, as the black-frame
 * diagnosis needs the real VTS background and nothing else.
 */
export function frameCorners(frame) {
  const width = Math.max(0, Math.trunc(Number(frame?.width) || 0));
  const height = Math.max(0, Math.trunc(Number(frame?.height) || 0));
  const pixels = frame?.pixels;
  if (width === 0 || height === 0 || !pixels || pixels.length < width * height * 4) return null;
  const bgra = frame?.channelOrder === 'bgra';
  const at = (x, y) => {
    const i = (y * width + x) * 4;
    return bgra
      ? { r: pixels[i + 2], g: pixels[i + 1], b: pixels[i] }
      : { r: pixels[i], g: pixels[i + 1], b: pixels[i + 2] };
  };
  return { topLeft: at(0, 0), bottomRight: at(width - 1, height - 1) };
}

/** Ownership records of the mirror processes this layer directory launched (newest last). */
const OWNERS_FILE = 'owners.json';
const OWNER_HISTORY = 16;

/** Normalize a CIM `CreationDate` (`/Date(…)/`, ISO, or locale text) to one comparable string. */
export function normalizeCreationDate(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  const stamp = /\/Date\((\d+)(?:[+-]\d+)?\)\//u.exec(text);
  if (stamp !== null) return new Date(Number(stamp[1])).toISOString();
  return text;
}

/** `-StateDir` argument of a mirror command line, '' when absent. */
export function stateDirFromCommand(commandLine) {
  const match = /-StateDir\s+(?:"([^"]+)"|(\S+))/u.exec(typeof commandLine === 'string' ? commandLine : '');
  return (match?.[1] ?? match?.[2] ?? '').trim();
}

async function readOwners(dir) {
  try {
    const parsed = JSON.parse(await readFile(join(dir, OWNERS_FILE), 'utf8'));
    const rows = Array.isArray(parsed?.instances) ? parsed.instances : [];
    return rows.filter((row) => row !== null && typeof row === 'object');
  } catch {
    return [];
  }
}

async function writeOwners(dir, owners) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, OWNERS_FILE), JSON.stringify({ instances: owners.slice(-OWNER_HISTORY) }, null, 2), 'utf8');
}

/** Every powershell process currently running a transparent.ps1 mirror. */
function listMirrorProcesses() {
  const script = "Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*transparent.ps1*' } | Select-Object ProcessId,CreationDate,CommandLine | ConvertTo-Json -Compress";
  return new Promise((resolveList) => {
    let text = '';
    const child = spawn('powershell', ['-NoProfile', '-Command', script], { windowsHide: true });
    child.stdout.on('data', (chunk) => {
      text += chunk.toString('utf8');
    });
    child.once('close', () => {
      try {
        const parsed = JSON.parse(text.trim() || '[]');
        const rows = Array.isArray(parsed) ? parsed : [parsed];
        resolveList(
          rows
            .map((row) => ({
              pid: Number(row?.ProcessId),
              createdAt: normalizeCreationDate(`${row?.CreationDate ?? ''}`),
              commandLine: `${row?.CommandLine ?? ''}`,
            }))
            .filter((row) => Number.isInteger(row.pid) && row.pid > 0),
        );
      } catch {
        resolveList([]);
      }
    });
    child.once('error', () => resolveList([]));
  });
}

/** Creation time of one process, or null when it is already gone. */
function inspectProcessCreation(pid) {
  const script = `Get-CimInstance Win32_Process -Filter "ProcessId = ${Number(pid)}" | Select-Object ProcessId,CreationDate | ConvertTo-Json -Compress`;
  return new Promise((resolveInspect) => {
    let text = '';
    const child = spawn('powershell', ['-NoProfile', '-Command', script], { windowsHide: true });
    child.stdout.on('data', (chunk) => {
      text += chunk.toString('utf8');
    });
    child.once('close', () => {
      try {
        const parsed = JSON.parse(text.trim() || 'null');
        if (parsed === null) return resolveInspect(null);
        const createdAt = normalizeCreationDate(`${parsed.CreationDate ?? ''}`);
        return resolveInspect(createdAt.length > 0 ? { pid: Number(parsed.ProcessId), createdAt } : null);
      } catch {
        return resolveInspect(null);
      }
    });
    child.once('error', () => resolveInspect(null));
  });
}

function terminateProcess(pid) {
  return new Promise((resolveKill) => {
    const child = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    child.once('close', resolveKill);
    child.once('error', resolveKill);
  });
}

const DEFAULT_PROCESSES = { list: listMirrorProcesses, inspect: inspectProcessCreation, terminate: terminateProcess };

export class AvatarLayer {
  constructor({ dir, scriptPath, windowScriptPath, root, log = null, processes = null, spawnProcess = null, key = WPF_KEY }) {
    this.dir = dir;
    this.scriptPath = scriptPath;
    this.windowScriptPath = windowScriptPath;
    this.root = root ?? resolve(dir, '..', '..');
    this.log = log;
    this.processes = processes ?? DEFAULT_PROCESSES;
    // Tests inject a fake spawner; production falls back to node:child_process.
    this.spawnProcess = typeof spawnProcess === 'function' ? spawnProcess : spawn;
    this.key = normalizeKey(key);
    this.child = null;
    this.owner = null;
    this.events = [];
    this.geometry = { left: 80, top: 260, width: 420, height: 700 };
    /** Where VTS is parked for PrintWindow; never a user position (kept out of `geometry`). */
    this.captureRect = null;
    /** Last `window-move.ps1` result: `{ requested, actual, delta, mismatch }`. */
    this.lastMove = null;
    /** Set only when start() really parked VTS: stop() must never move a window it did not take. */
    this.vtsTakenOver = false;
    /** Real client rectangle VTS had before that takeover; null when it could not be read. */
    this.preTakeoverRect = null;
    /** Rectangle this instance last applied successfully: the baseline for judging a foreign move. */
    this.lastAppliedRect = null;
    /** Set when the captured background does not match the configured key. */
    this.keyMismatch = null;
    this.editMode = false;
    this.adjusting = false;
    this.lastError = '';
  }

  get running() {
    return this.child !== null;
  }

  /**
   * Move the real VTS window; `options.raise` is the edit-recovery transition (restore if
   * minimized, then bring it in front of the editor). Every other move omits it, so parking VTS
   * for capture or leaving the layer never steals the foreground. A raise that could not be
   * performed is a failure code, not a silent success.
   */
  async moveVts(box, options = {}) {
    const raise = options?.raise === true;
    const requested = clientRect(box);
    if (requested === null) return { ok: false, code: 'MOVE_BOUNDS_INVALID', requested: null };
    const args = [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', this.windowScriptPath,
      '-X', String(requested.left), '-Y', String(requested.top),
      '-W', String(requested.width), '-H', String(requested.height),
    ];
    if (raise) args.push('-Raise');
    const output = await new Promise((resolve) => {
      let text = '';
      const child = this.spawnProcess(
        'powershell',
        args,
        { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
      );
      child.stdout?.on('data', (chunk) => {
        text += `${chunk}`;
      });
      child.once('close', () => resolve(text));
      child.once('error', () => resolve(''));
    });
    // The helper prints the client rectangle it re-read after SetWindowPos: never trust the request.
    if (`${output}`.includes('no-vts')) {
      this.lastMove = { ok: false, requested, actual: null, mismatch: false };
      if (raise) {
        await this.emitEvent('window.raised', { target: 'vts', ok: false, rect: asBounds(requested), code: 'VTS_NOT_RUNNING' });
      }
      return { ok: false, code: 'VTS_NOT_RUNNING', requested };
    }
    const lines = `${output}`.trim().split(/\r?\n/u).filter((line) => line.length > 0);
    let parsed = null;
    try {
      parsed = JSON.parse(lines.at(-1) ?? '');
    } catch {
      parsed = null;
    }
    const actual = clientRect(parsed);
    if (actual === null) {
      this.lastMove = { ok: false, requested, actual: null, mismatch: false };
      return { ok: false, code: 'MOVE_UNREADABLE', requested };
    }
    const delta = {
      left: actual.left - requested.left,
      top: actual.top - requested.top,
      width: actual.width - requested.width,
      height: actual.height - requested.height,
    };
    const mismatch = Object.values(delta).some((value) => Math.abs(value) > MOVE_TOLERANCE_PX);
    if (raise && (parsed?.ok === false || parsed?.raised === false)) {
      const code = parsed?.code || parsed?.raiseCode || 'VTS_RAISE_FAILED';
      this.lastMove = { ok: false, requested, actual, delta, mismatch };
      await this.emitEvent('window.raised', { target: 'vts', ok: false, rect: asBounds(actual), code });
      return { ok: false, code, requested, actual };
    }
    this.lastMove = { ok: true, requested, actual, delta, mismatch };
    this.lastAppliedRect = { ...actual };
    if (mismatch) await this.emitEvent('window.move.mismatch', { requested, actual, delta });
    if (raise) await this.emitEvent('window.raised', { target: 'vts', ok: true, rect: asBounds(actual) });
    return { ok: true, requested, actual, delta, mismatch };
  }

  async writeState() {
    await mkdir(this.dir, { recursive: true });
    const state = { ...this.geometry, editMode: this.editMode };
    await writeFile(join(this.dir, 'state.json'), JSON.stringify(state), 'utf8');
  }

  /** Record one telemetry event; a missing log sink must never break teardown. */
  async emitEvent(type, payload) {
    this.events.push({ type, ...payload });
    if (this.events.length > 50) this.events.shift();
    if (typeof this.log?.emit !== 'function') return;
    try {
      await this.log.emit(type, payload);
    } catch {
      /* best effort only */
    }
  }

  async noteUnverified(report, pid, reason) {
    report.unverified += 1;
    await this.emitEvent('avatarLayer.stale.unverified', { pid, reason, root: this.root, stateDir: this.dir });
  }

  /** Corner sample transparent.ps1 writes for the last captured frame, or null when absent. */
  async readCaptureCorners() {
    return readCaptureCornersFrom(this.dir);
  }

  /**
   * Compare the captured background with the configured key. A background that is not near the
   * key means the mirror cannot be transparent: say so instead of pretending it is keyed out.
   */
  async checkKey(corners) {
    const corner = corners?.topLeft ?? null;
    const matches = keyMatches(corner, this.key);
    this.keyMismatch = matches === false ? { cornerColor: { ...corner }, keyColor: { ...this.key } } : null;
    if (matches === false) {
      await this.emitEvent('wpf.key.mismatch', { cornerColor: { ...corner }, keyColor: { ...this.key } });
    }
    return matches;
  }

  /** Emit one `wpf.capture.corner` per corner, naming which pixel the RGB came from. */
  async emitCaptureCorners(corners) {
    if (corners === null || corners === undefined) return null;
    for (const [corner, rgb] of [['top-left', corners.topLeft], ['bottom-right', corners.bottomRight]]) {
      if (rgb === null || rgb === undefined) continue;
      await this.emitEvent('wpf.capture.corner', { corner, r: rgb.r, g: rgb.g, b: rgb.b });
    }
    return corners;
  }

  /**
   * Kill only mirrors this layer directory provably owns — never processes matched by name.
   * Ownership is the launch record (pid + process creation time + root); a candidate is killed
   * only when its `-StateDir` is ours and one of our records matches pid *and* creation time.
   * Anything else (another root's instance, a recycled pid, a record we do not have) stays alive
   * and is reported as `avatarLayer.stale.unverified`.
   */
  async killStale() {
    const persisted = await readOwners(this.dir);
    const owners =
      this.owner === null
        ? persisted
        : [...persisted.filter((entry) => Number(entry.pid) !== Number(this.owner.pid)), this.owner];
    const candidates = await this.processes.list();
    // Capture the current process id once: an in-flight launch may replace `this.child` while
    // the loop awaits, and comparing against a later value would exempt the wrong pid.
    const selfPid = this.child === null ? null : Number(this.child.pid);
    const report = { checked: candidates.length, killed: [], skipped: 0, unverified: 0 };
    for (const candidate of candidates) {
      const stateDir = stateDirFromCommand(candidate.commandLine ?? '');
      if (stateDir === '') {
        await this.noteUnverified(report, candidate.pid, 'no-state-dir');
        continue;
      }
      if (resolve(stateDir) !== resolve(this.dir)) {
        // Same script, different root: a legitimate instance of another profile. Not ours to touch.
        report.skipped += 1;
        continue;
      }
      if (selfPid !== null && Number(candidate.pid) === selfPid) {
        report.skipped += 1;
        continue;
      }
      const owner = owners.find((entry) => Number(entry.pid) === Number(candidate.pid));
      if (owner === undefined) {
        await this.noteUnverified(report, candidate.pid, 'no-owner-record');
        continue;
      }
      if (typeof owner.root === 'string' && owner.root.length > 0 && resolve(owner.root) !== resolve(this.root)) {
        await this.noteUnverified(report, candidate.pid, 'root-mismatch');
        continue;
      }
      const recordedCreation = normalizeCreationDate(`${owner.createdAt ?? ''}`);
      // A record whose creation time could not be read cannot be matched to a live process;
      // killing it could hit a recycled pid, so it is reported and left alive.
      if (owner.ownership === 'unverified' || recordedCreation === '') {
        await this.noteUnverified(report, candidate.pid, 'ownership-unverified');
        continue;
      }
      if (recordedCreation !== candidate.createdAt) {
        await this.noteUnverified(report, candidate.pid, 'creation-time-mismatch');
        continue;
      }
      await this.processes.terminate(candidate.pid);
      report.killed.push(candidate.pid);
    }
    return report;
  }

  async start() {
    if (this.child !== null) return { ok: true };
    await this.killStale();
    // A previous session may have been interrupted mid-adjust; a fresh start is never in
    // edit/adjust mode, otherwise the overlay would come up non-click-through.
    this.editMode = false;
    this.adjusting = false;
    this.keyMismatch = null;
    await mkdir(this.dir, { recursive: true });
    await this.writeState();
    // A previous launch's corner sample must not masquerade as this frame's diagnosis.
    await rm(join(this.dir, 'capture.json'), { force: true }).catch(() => {});
    // Read the real client rectangle *before* parking VTS: it is the only rectangle a later stop
    // may restore, and a failed read is not a position (preTakeoverRect stays null).
    const before = this.vtsTakenOver === true ? null : await this.readVtsRect();
    const parked = await this.moveVts(OFFSCREEN);
    // The capture position is its own record; it must never overwrite the user's geometry.
    this.captureRect = parked?.actual ?? { ...OFFSCREEN };
    // Only a move that really happened makes this instance the window's owner.
    if (parked?.ok === true) await this.noteTakeover(before);
    // Keep this launch's process in a local: `this.child` may be nulled by its own close
    // handler (or replaced by a concurrent launch) while `inspect` is in flight.
    const child = this.spawnProcess(
      'powershell',
      ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', this.scriptPath,
        '-StateDir', this.dir, ...keyingArgs(this.key)],
      { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] },
    );
    const pid = child.pid;
    this.child = child;
    child.stderr.on('data', (chunk) => {
      this.lastError = `${chunk}`.trim().slice(-300);
    });
    // Instance-checked: a late close from a previous process must not clear its successor.
    child.once('close', () => {
      if (this.child === child) this.child = null;
    });
    // Ownership metadata lets this directory's next instance verify (and only then kill) the
    // process it is replacing; without it, stale processes are never killed by name.
    let creation = null;
    try {
      creation = await this.processes.inspect(pid);
    } catch {
      /* unreadable process metadata: record the launch anyway, unverifiable afterwards */
    }
    if (this.child !== child || child.exitCode !== null) {
      // The mirror died (or was replaced) before its creation time could be read. Do not
      // overwrite the successor's ownership record, and do not throw.
      return { ok: false, code: 'LAUNCH_EXITED_EARLY', pid };
    }
    const createdAt = normalizeCreationDate(`${creation?.createdAt ?? ''}`);
    const ownership = createdAt === '' ? 'unverified' : 'verified';
    const owner = {
      pid,
      createdAt,
      ownership,
      root: this.root,
      stateDir: this.dir,
      startedAt: new Date().toISOString(),
    };
    this.owner = owner;
    try {
      const persisted = (await readOwners(this.dir)).filter((entry) => Number(entry.pid) !== Number(pid));
      await writeOwners(this.dir, [...persisted, owner]);
    } catch {
      /* the mirror still works without the ownership record */
    }
    await new Promise((resolve) => setTimeout(resolve, 1200));
    if (this.child !== child || child.exitCode !== null) {
      return { ok: false, code: 'LAUNCH_EXITED_EARLY', pid, ownership };
    }
    // First frame has been captured by now; record the true background colour and check the key
    // premise (a black VTS background is not magenta, so the mirror must say it cannot key it).
    const corners = await this.readCaptureCorners();
    await this.checkKey(corners);
    await this.emitCaptureCorners(corners);
    return { ok: true, pid, ownership };
  }

  /** Drop this instance's ownership record (the process it names is gone). */
  async forgetOwner() {
    if (this.owner === null) return;
    const pid = Number(this.owner.pid);
    this.owner = null;
    try {
      const kept = (await readOwners(this.dir)).filter((entry) => Number(entry.pid) !== pid);
      await writeOwners(this.dir, kept);
    } catch {
      /* the file is advisory; a missing record only makes the next killStale more cautious */
    }
  }

  async setGeometry(patch) {
    for (const key of ['left', 'top', 'width', 'height']) {
      if (typeof patch[key] === 'number' && Number.isFinite(patch[key])) {
        this.geometry[key] = Math.round(patch[key]);
      }
    }
    await this.writeState();
    return this.snapshot();
  }

  async setEditMode(enabled) {
    // Leaving edit mode: the window saved its final geometry, so read it back before the host
    // writes state again — otherwise the drag would be overwritten by the stale default.
    if (enabled !== true) await this.syncFromDisk();
    this.editMode = enabled === true;
    await this.writeState();
    return this.snapshot();
  }

  async syncFromDisk() {
    try {
      const raw = await readFile(join(this.dir, 'state.json'), 'utf8');
      const state = JSON.parse(raw);
      for (const key of ['left', 'top', 'width', 'height']) {
        if (typeof state[key] === 'number' && Number.isFinite(state[key])) {
          this.geometry[key] = Math.round(state[key]);
        }
      }
    } catch {
      /* no state yet: keep the current geometry */
    }
  }

  snapshot() {
    return {
      running: this.running,
      editMode: this.editMode,
      adjusting: this.adjusting === true,
      geometry: this.geometry,
      captureRect: this.captureRect,
      keyMismatch: this.keyMismatch,
      error: this.lastError,
    };
  }

  /** Read the VTS client rectangle (screen pixels) via the window helper. */
  async report() {
    const output = await new Promise((resolve) => {
      let text = '';
      const child = this.spawnProcess(
        'powershell',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', this.windowScriptPath, '-Report'],
        { windowsHide: true },
      );
      child.stdout?.on?.('data', (chunk) => {
        text += chunk.toString('utf8');
      });
      child.once('close', () => resolve(text));
      child.once('error', () => resolve(''));
    });
    try {
      const rect = JSON.parse(output.trim().split('\n').pop() ?? '');
      if (rect.width > 0 && rect.height > 0) return rect;
    } catch {
      /* fall through */
    }
    return null;
  }

  /**
   * Adjustment mode: take the mirror down and let the user drag/resize the real VTS window.
   * The magenta background is visible during this, which is the accepted tradeoff.
   */
  async beginAdjust() {
    const child = this.child;
    if (child !== null) {
      const pid = child.pid;
      try {
        this.spawnProcess('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      } catch {
        /* already gone */
      }
      if (this.child === child) this.child = null;
      await this.forgetOwner();
    }
    // Any other mirror (e.g. left over from a plugin reload) would show a stale or black
    // frame on top while the user is editing, so clear the whole set first.
    await this.killStale();
    this.editMode = true;
    this.adjusting = true;
    const shown = await this.moveVts({
      x: Math.max(60, this.geometry.left),
      y: Math.max(60, this.geometry.top),
      width: this.geometry.width,
      height: this.geometry.height,
    }, { raise: true });
    // Adopt the client rectangle VTS really has, not the one asked for: the user's position is the
    // client area, so a border/DPI adjustment must be visible to the next write.
    if (shown?.ok === true) {
      this.geometry = {
        left: shown.actual.left,
        top: shown.actual.top,
        width: shown.actual.width,
        height: shown.actual.height,
      };
      await this.writeState();
    }
    return { ok: true, adjusting: true, geometry: this.geometry };
  }

  /** Finish: adopt the VTS client rect as the layer geometry, hide VTS again, restart mirror. */
  async finishAdjust() {
    const rect = await this.report();
    // A capture-corner reading means VTS never made it back on screen: keep the last user
    // geometry instead of saving the off-screen parking position as the user's rectangle.
    if (rect !== null && !isCaptureRect(rect)) {
      this.geometry = {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      };
    }
    this.editMode = false;
    this.adjusting = false;
    await this.writeState();
    const parked = await this.moveVts(OFFSCREEN);
    this.captureRect = parked?.actual ?? { ...OFFSCREEN };
    const started = await this.start();
    return { ok: started.ok, adjusting: false, geometry: this.geometry };
  }

  /** VTS's current client rectangle, or null when the helper cannot read it. */
  async readVtsRect() {
    try {
      return clientRect(await this.report());
    } catch {
      return null;
    }
  }

  /** Record the first takeover of this instance: only this makes stop() responsible for VTS. */
  async noteTakeover(before) {
    if (this.vtsTakenOver === true) return;
    this.vtsTakenOver = true;
    this.preTakeoverRect = clientRect(before);
    await this.emitEvent('avatar.vts.takeover', {
      rect: this.preTakeoverRect === null ? null : asBounds(this.preTakeoverRect),
    });
  }

  /**
   * Put back a VTS this instance really took over. The recorded pre-takeover client rectangle is
   * the only restore target; the on-screen corner is a last resort, and a window another backend
   * moved since the takeover is left alone (restoring would steal its geometry).
   */
  async restoreTakenVts() {
    const applied = clientRect(this.lastAppliedRect);
    const expected = clientRect(this.preTakeoverRect);
    const actual = await this.readVtsRect();
    this.vtsTakenOver = false;
    this.preTakeoverRect = null;
    // A normal run leaves VTS where this instance parked it (off-screen), so only a window that
    // drifted away from *our own last applied* rectangle was moved by someone else since.
    const baseline = applied ?? expected;
    if (baseline !== null && actual !== null && rectDrifted(actual, baseline)) {
      await this.emitEvent('avatar.vts.restore.skipped', {
        reason: 'rect-changed',
        expected: asBounds(baseline),
        actual: asBounds(actual),
      });
      this.lastAppliedRect = null;
      return { ok: true, skipped: true, source: 'skipped', rect: asBounds(actual) };
    }
    let target = expected;
    let source = 'pre-takeover';
    if (target === null) {
      // No recorded rectangle: fall back to the on-screen origin, but keep the live client size so
      // another backend's window is never overwritten with the WPF default size.
      const size = clientRect(actual);
      target = {
        left: ONSCREEN.x,
        top: ONSCREEN.y,
        width: size?.width ?? ONSCREEN.width,
        height: size?.height ?? ONSCREEN.height,
      };
      source = 'fallback';
      await this.emitEvent('avatar.vts.restore.fallback', { rect: asBounds(target), reason: 'pre-takeover-unreadable' });
    }
    const moved = await this.moveVts(target);
    const rect = asBounds(moved?.actual ?? target);
    if (moved?.ok === true) {
      this.lastAppliedRect = null;
      await this.emitEvent('avatar.vts.restore', { rect, source });
    }
    return { ok: moved?.ok === true, skipped: false, source, rect };
  }

  async stop() {
    // Take this launch's process before the first await: a close callback may null `this.child`
    // while the geometry is being read, and reading `this.child.pid` afterwards would throw.
    const child = this.child;
    // The pid is the only evidence that the process existed: report it after the slot is cleared
    // so the caller can confirm the exit instead of reading `running === false`.
    const ownedPid = Number.isInteger(child?.pid) ? child.pid : 0;
    // Read the geometry the user left behind *before* tearing the layer down.
    await this.syncFromDisk();
    if (child !== null) {
      const pid = child.pid;
      try {
        // PowerShell hosts the WPF window in this process; /T also takes its tree down.
        this.spawnProcess('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      } catch {
        /* already gone */
      }
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      if (this.child === child) this.child = null;
    }
    await this.forgetOwner();
    this.editMode = false;
    this.adjusting = false;
    await rm(join(this.dir, 'state.json'), { force: true }).catch(() => {});
    // Only a start that really parked VTS makes this layer responsible for it: a controller that
    // never took the window over must not move it (Spout may own its rectangle right now).
    if (this.vtsTakenOver === true) await this.restoreTakenVts();
    // The termination request is not a result: the caller confirms this pid (or reports it missing).
    return { pid: ownedPid };
  }
}
