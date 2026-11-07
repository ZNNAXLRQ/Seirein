/**
 * Spout display layer — phase 0.
 *
 * One transparent, click-through, always-on-top BrowserWindow, started as an independent
 * Electron runtime by the host (never by DSH's own executable). Phase 0 proves the launch path,
 * the renderer pipeline and the two facts the design doc calls out separately:
 *
 *   - the native bridge (`@napolab/texture-bridge`) really loads in *this* Electron runtime,
 *     with its version and the actual `.node` path recorded (not merely resolved);
 *   - a real `TextureReceiver` is registered for the configured sender (default
 *     `VTubeStudioSpout`) and the renderer only reports `ready(receiver)` after that registration.
 *
 * Geometry comes from the host (`--dsh-bounds=left,top,width,height`), with a centred 520×800
 * fallback whose provenance is reported (`boundsSource:"fallback"`). The window is sized before
 * it is shown and mouse interaction is disabled.
 *
 * Lifetime is bound to the host's stdin (EOF = quit), so a killed host leaves no orphan.
 *
 * stdout protocol: one JSON object per line.
 *   {"type":"ready","phase":"control","versions":{electron,chrome,node,bridge,bridgeNative,...},
 *    "display":{...},"window":{requested,bounds,boundsSource}}
 *   {"type":"ready","phase":"waiting-sender","registered":true,"sender":"VTubeStudioSpout",...}
 *   {"type":"ready","phase":"receiver","registered":true,"sender":"...","surface":{...}}
 *   {"type":"diagnostic","event":"spout.stage2","fps":59.9,"dropped":0,"resized":0,"alphaMode":"premultiplied"}
 *   {"type":"error","code":"BRIDGE_LOAD_FAILED|SENDER_NOT_FOUND|...","message":"..."}
 *   {"type":"info"|"exit",...}
 * Anything else on stdout is a diagnostic; the host keeps a short tail and ignores the rest.
 */
const { fstatSync, mkdirSync, read, readFileSync, readdirSync, writeSync } = require('node:fs');
const { dirname, join } = require('node:path');

/**
 * Electron APIs are only present in the real display runtime. Unit tests import this module under
 * plain Node to exercise the stdin shutdown protocol, so the require is guarded and the pure
 * protocol helpers below are exported; production behaviour is unchanged.
 */
let electron = null;
try {
  electron = require('electron');
} catch {
  electron = null;
}
const inElectron = electron !== null && typeof process.versions?.electron === 'string';
const app = electron?.app;
const BrowserWindow = electron?.BrowserWindow;
const ipcMain = electron?.ipcMain ?? { handle() {}, on() {} };
const screen = electron?.screen;
const sharedTexture = electron?.sharedTexture;

const LAYER_ROOT = __dirname;
const WINDOW_SIZE = { width: 520, height: 800 };
/**
 * Presentation contract of the display window (the display half of the black-background report).
 * `transparent:true` + a zero-alpha background colour is what lets the compositor keep the
 * canvas's alpha; `backgroundMaterial:'none'` stops a system-drawn backdrop (Windows 11
 * Mica/acrylic) from painting behind that transparent surface. The page itself paints nothing
 * behind the WebGL canvas (index.html).
 */
const WINDOW_PRESENTATION = Object.freeze({
  transparent: true,
  backgroundColor: '#00000000',
  frame: false,
  hasShadow: false,
  backgroundMaterial: 'none',
});

/** Material changes can reset the backing colour on Windows. Set alpha LAST. */
function applyWindowPresentation(win) {
  try {
    win.setBackgroundMaterial?.('none');
  } catch {
    /* Older runtimes may not implement the material API. */
  }
  try {
    win.setBackgroundColor('#00000000');
  } catch {
    /* The constructor's transparent background remains the fallback. */
  }
}
/**
 * Web-preferences half. There is no `transparent` web preference: the canvas alpha comes from the
 * WebGL context attributes (stage.js CONTEXT_ATTRIBUTES), so nothing here may paint a background.
 */
const WINDOW_WEB_PREFERENCES = Object.freeze({
  contextIsolation: true,
  nodeIntegration: false,
  // The stage lives beside the preload (`stage.js`) and is required from it. A sandboxed preload
  // can only `require('electron')` and built-ins, so the sandbox must be off for the WebGL stage to
  // load. The page is local, CSP-restricted and context-isolated; no Node globals are exposed to it.
  sandbox: false,
  // An attached-but-backgrounded layer must still paint: receiver-ready is our proof.
  backgroundThrottling: false,
});
const DEFAULT_SENDER = 'VTubeStudioSpout';
const DEFAULT_RECEIVER_TIMEOUT_MS = 5000;
const MIN_RECEIVER_TIMEOUT_MS = 1000;
const MAX_RECEIVER_TIMEOUT_MS = 120_000;
const DEFAULT_SENDER_TIMEOUT_MS = 30_000;
const MIN_SENDER_TIMEOUT_MS = 1000;
const MAX_SENDER_TIMEOUT_MS = 120_000;
/** Show the window by ourselves if neither ready-to-show nor did-finish-load arrives. */
const SHOW_FALLBACK_MS = 1500;
const startedAt = Date.now();

let mainWindow = null;
let controlReported = false;
let receiverReported = false;
let quitting = false;
let receiverTimer = null;
let framesDrawn = 0;
let readyToShow = false;
let didFinishLoad = false;
let windowShown = false;
let activeBounds = null;
let boundsSource = '';
/** Registered native receiver: `{ name, instance, registeredAt, platform }`. */
let receiver = null;
let senderTimer = null;
let senderTimedOut = false;
/**
 * Shared-texture delivery state (main → renderer). `setSharedTextureReceiver` runs in the renderer;
 * `textureRegistered` is the IPC acknowledgement, `sharedTextureRegistered` becomes true only after
 * a delivery succeeds. `textureTimeouts` counts Electron's 1000 ms "no receiver" rejection.
 */
let textureRegistered = false;
let sharedTextureRegistered = false;
let textureTimeouts = 0;
let textureSends = 0;
let textureFrames = 0;
let lastTextureSendMs = 0;
let lastTextureSendAt = 0;
let lastTextureError = '';
let textureSendInFlight = false;
let texturePush = 'not-attached';
/** The selftest opens and closes throwaway windows before the layer window exists. */
let textureSelfTestActive = false;
/** Layer-internal edit mode for the one display window; `null` before the window exists. */
let editController = null;

/**
 * Same-message `info` coalescing. The texture loop produced two status lines per frame (~120/s),
 * which flooded both the host's stdout diagnostics and its `spoutLayer.info` event stream; at the
 * host's 10 MB rotation only ~40 minutes of speech/memory/tool timing survived. A window keeps the
 * first line of each message and reports how many repeats it swallowed on the next recorded line.
 */
const INFO_THROTTLE_MS = 60_000;
const INFO_FAILURE_PATTERN = /(?:fail(?:ed|ure)?|error|timed?\s*out|timeout|unavailable)/iu;
const infoThrottle = new Map();
let infoThrottled = 0;

/**
 * Coalesce one `info` line. Returns the payload to write, or null when this repeat is suppressed.
 * `now` is injectable so the protocol test can advance the window without sleeping for a minute.
 */
function throttleInfo(payload, now = Date.now()) {
  const message = String(payload?.message ?? '');
  if (INFO_FAILURE_PATTERN.test(message)) return payload;
  const previous = infoThrottle.get(message);
  if (previous !== undefined && now - previous.at < INFO_THROTTLE_MS) {
    previous.suppressed += 1;
    infoThrottled += 1;
    return null;
  }
  const throttled = previous === undefined ? 0 : previous.suppressed;
  if (infoThrottle.size >= 64) {
    for (const key of infoThrottle.keys()) {
      if (infoThrottle.size < 32) break;
      infoThrottle.delete(key);
    }
  }
  infoThrottle.set(message, { at: now, suppressed: 0 });
  return { ...payload, throttled };
}

/** One stdout line. A closed pipe means the host is gone; stdin EOF will follow. */
function emit(payload) {
  const line = payload?.type === 'info' ? throttleInfo(payload) : payload;
  if (line === null) return;
  try {
    process.stdout.write(`${JSON.stringify(line)}\n`);
  } catch {
    /* the reader disappeared; nothing left to report to */
  }
}

/** Final stdout line before `process.exit`: pipe writes in `emit` are queued, this one is not. */
function emitSync(payload) {
  try {
    writeSync(1, `${JSON.stringify(payload)}\n`);
  } catch {
    /* nobody is reading */
  }
}

/**
 * Stage timestamps of a graceful shutdown. They are written into every shutdown event and into the
 * final `exit` line, so a stop that stalls can be located at one exact phase.
 */
const shutdownTimeline = {
  requestReceivedAt: 0,
  receiverCleanupStartedAt: 0,
  receiverCleanupFinishedAt: 0,
  /** The instant `app.exit()` is requested; not an exit yet. */
  exitRequestedAt: 0,
  /** Historical name for the same instant as `exitRequestedAt` (kept for existing readers). */
  appExitCalledAt: 0,
  /** Set only by the process `exit` hook: the process is actually terminating. */
  mainExitAt: 0,
};

let quitReason = '';
let mainExitHookInstalled = false;

/**
 * "Exit requested" is not "exited". The only in-process evidence of the real exit is the `exit`
 * event, which runs after `app.exit()` has committed. Writing that final stage synchronously lets
 * the host tell "stuck inside app.exit" from "stuck after main exit" instead of reading the
 * request timestamp as an exit timestamp.
 */
function installMainExitStage() {
  if (mainExitHookInstalled) return;
  mainExitHookInstalled = true;
  process.once('exit', () => {
    // Plain-Node imports (unit tests) must never write stage lines into the harness output.
    if (!inElectron) return;
    const mainExitAt = Date.now();
    shutdownTimeline.mainExitAt = mainExitAt;
    emitSync({
      type: 'shutdown-stage',
      stage: 'main-exit',
      atMs: mainExitAt,
      at: new Date(mainExitAt).toISOString(),
      reason: quitReason,
      stages: { mainExitAt, exitRequestedAt: shutdownTimeline.exitRequestedAt },
    });
  });
}

/**
 * Line-oriented stdin protocol. The old watcher drained stdin and discarded it; the host now sends
 * `{"type":"shutdown",...}` and expects a real `shutdown-ack`, with EOF kept as the host-death
 * fallback. Chunks are buffered, so a message split across reads is still parsed.
 */
function createStdinParser({ onMessage, onLine } = {}) {
  let buffer = '';
  const dispatch = (line) => {
    if (line.length === 0) return null;
    let message = null;
    try {
      message = JSON.parse(line);
    } catch {
      onLine?.(line);
      return null;
    }
    onMessage?.(message, line);
    return message;
  };
  return {
    feed(chunk) {
      buffer += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      let at = buffer.indexOf('\n');
      while (at !== -1) {
        const line = buffer.slice(0, at).trim();
        buffer = buffer.slice(at + 1);
        dispatch(line);
        at = buffer.indexOf('\n');
      }
      return buffer;
    },
    flush() {
      const line = buffer.trim();
      buffer = '';
      return dispatch(line);
    },
    get buffered() { return buffer; },
  };
}

/**
 * The main-process half of the shutdown exchange: parse the request, acknowledge it immediately
 * (before a native receiver cleanup that may block), then call the real graceful quit path.
 */
function createShutdownReceiver({ emit: emitLine, quit: quitFn, now = Date.now, timeline = shutdownTimeline } = {}) {
  let handled = false;
  const receive = (message) => {
    if (message === null || typeof message !== 'object' || String(message.type) !== 'shutdown') {
      return { ok: false, reason: 'ignored' };
    }
    if (handled) return { ok: false, reason: 'duplicate' };
    handled = true;
    timeline.requestReceivedAt = now();
    timeline.deadlineAt = Number(message.deadlineAt) || 0;
    timeline.seq = Number(message.seq) || 0;
    timeline.reason = String(message.reason ?? 'shutdown');
    emitLine?.({
      type: 'shutdown-ack',
      seq: timeline.seq,
      receivedAt: timeline.requestReceivedAt,
      deadlineAt: timeline.deadlineAt,
      pid: process.pid,
      stages: { requestReceivedAt: timeline.requestReceivedAt },
    });
    quitFn?.('shutdown');
    return { ok: true, timeline };
  };
  return {
    receive,
    timeline,
    get handled() { return handled; },
  };
}

/** Read `--name=value` from the whole argv, wherever Chromium left it. */
function argValue(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((arg) => typeof arg === 'string' && arg.startsWith(prefix));
  return hit === undefined ? '' : hit.slice(prefix.length);
}

/**
 * Receiver registration watchdog: how long the host waits for *a first frame report* at all.
 * This is not the sender budget: registration itself is expected within seconds.
 */
function receiverTimeoutMs() {
  const raw = argValue('dsh-receiver-timeout-ms') || process.env.DSH_SPOUT_RECEIVER_TIMEOUT_MS || '';
  const value = Number(raw);
  if (!Number.isFinite(value)) return DEFAULT_RECEIVER_TIMEOUT_MS;
  return Math.min(MAX_RECEIVER_TIMEOUT_MS, Math.max(MIN_RECEIVER_TIMEOUT_MS, Math.round(value)));
}

/** How long `waiting-sender` keeps the window alive before reporting SENDER_NOT_FOUND. */
function senderTimeoutMs() {
  const raw = argValue('dsh-sender-timeout-ms') || process.env.DSH_SPOUT_SENDER_TIMEOUT_MS || '';
  const value = Number(raw);
  if (!Number.isFinite(value)) return DEFAULT_SENDER_TIMEOUT_MS;
  return Math.min(MAX_SENDER_TIMEOUT_MS, Math.max(MIN_SENDER_TIMEOUT_MS, Math.round(value)));
}

const RECEIVER_TIMEOUT_MS = receiverTimeoutMs();
const SENDER_TIMEOUT_MS = senderTimeoutMs();
const CONFIGURED_SENDER = (argValue('dsh-sender') || DEFAULT_SENDER).trim() || DEFAULT_SENDER;
/** Optional stable presentation size (`--dsh-size=WxH`); absent = follow the sender's size. */
const CONFIGURED_SIZE = parseSize(argValue('dsh-size'));

/** `978x844` → `{width:978,height:844}`; anything invalid → null (meaning "sender size"). */
function parseSize(raw) {
  const text = String(raw ?? '').trim();
  if (text.length === 0) return null;
  const match = text.match(/^(\d+)\s*[x×]\s*(\d+)$/iu);
  if (match === null) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return null;
  if (width > 16384 || height > 16384) return null;
  return { width, height };
}

/** Last source size the sender published, how often it changed, and the stable delivery size. */
let srcSize = { width: 0, height: 0 };
let srcChanges = 0;
let stableSize = CONFIGURED_SIZE === null
  ? { width: 0, height: 0, source: 'sender' }
  : { width: CONFIGURED_SIZE.width, height: CONFIGURED_SIZE.height, source: 'configured' };
/** Last renderer 1 Hz health report; forwarded to the host as a `health` line. */
let health = null;
/** Last stage-2 renderer diagnostic (fps / dropped / resized / alphaMode), throttled to 1 Hz. */
let stage2 = null;
/** Last receiver-side alpha diagnostic: a counts sample, a read-error or the one-shot disabled line. */
let alphaSample = null;

/** `left,top,width,height` → `{left,top,width,height}` or null. */
function parseBounds(raw) {
  const text = String(raw ?? '').trim();
  if (text.length === 0) return null;
  const values = text.split(',').map((part) => Number(part.trim()));
  if (values.length !== 4 || !values.every((value) => Number.isFinite(value))) return null;
  const [left, top, width, height] = values.map((value) => Math.round(value));
  if (width <= 0 || height <= 0) return null;
  return { left, top, width, height };
}

/** Accept both `{left,top,width,height}` and `{x,y,w,h}` (action / settings shapes). */
function parseBoundsObject(value) {
  if (value === null || typeof value !== 'object') return null;
  const left = Number(value.left ?? value.x);
  const top = Number(value.top ?? value.y);
  const width = Number(value.width ?? value.w);
  const height = Number(value.height ?? value.h);
  if (![left, top, width, height].every((part) => Number.isFinite(part))) return null;
  if (width <= 0 || height <= 0) return null;
  return { left: Math.round(left), top: Math.round(top), width: Math.round(width), height: Math.round(height) };
}

const initialBounds = parseBounds(argValue('dsh-bounds'));

/** Attribution key handed down by the host: root=…;instance=…;gen=… */
function parseLayerKey(raw) {
  const key = { root: '', instance: '', gen: '' };
  for (const part of String(raw).split(';')) {
    const at = part.indexOf('=');
    if (at <= 0) continue;
    const field = part.slice(0, at).trim();
    if (Object.prototype.hasOwnProperty.call(key, field)) key[field] = part.slice(at + 1).trim();
  }
  return key;
}

const layerKey = parseLayerKey(argValue('dsh-layer-key'));

/** Collect `.node` files under a package directory (bounded depth; never loads them). */
function findNativeFiles(dir, found = [], depth = 0) {
  if (depth > 3) return found;
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) findNativeFiles(full, found, depth + 1);
    else if (entry.name.endsWith('.node')) found.push(full);
  }
  return found;
}

/** Walk up from the resolved module to the package manifest (pnpm links included). */
function findManifest(startDir) {
  let dir = startDir;
  for (let depth = 0; depth < 6 && dir.length > 0; depth += 1) {
    const candidate = join(dir, 'package.json');
    try {
      const manifest = JSON.parse(readFileSync(candidate, 'utf8'));
      if (manifest?.name === '@napolab/texture-bridge') {
        return { path: candidate, dir, manifest };
      }
    } catch {
      /* not this directory / not readable: keep walking */
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Actually load the native bridge and record what was loaded.
 *
 * Resolution alone is not enough: a `.node` inside an asar, a missing platform package or a
 * mismatched N-API build all resolve fine and fail at `dlopen`. The require happens here, at
 * startup, and the exact file passed to `process.dlopen` is captured. A failure is returned with
 * the original error code/message so the caller can emit BRIDGE_LOAD_FAILED with the raw
 * `MODULE_NOT_FOUND` / `ERR_DLOPEN_FAILED` text instead of guessing.
 */
function loadBridge() {
  const moduleId = argValue('dsh-bridge-module') || '@napolab/texture-bridge';
  const probe = {
    module: moduleId,
    version: '',
    path: '',
    packageDir: '',
    native: '',
    nativeFiles: [],
    platform: '',
    senders: [],
    errorCode: '',
    errorMessage: '',
  };
  let modulePath = '';
  try {
    modulePath = require.resolve(moduleId, { paths: [LAYER_ROOT] });
  } catch (error) {
    probe.errorCode = String(error?.code ?? 'MODULE_NOT_FOUND');
    probe.errorMessage = String(error?.message ?? error);
    return { probe, instance: null };
  }

  const manifest = findManifest(dirname(modulePath));
  if (manifest !== null) {
    probe.path = manifest.path;
    probe.packageDir = manifest.dir;
    probe.version = String(manifest.manifest.version ?? '');
    probe.nativeFiles = findNativeFiles(manifest.dir);
    // napi-rs keeps the addon in a platform-optional package; include that path even though it
    // lives outside the JS glue directory (pnpm's store link resolves outside `packageDir`).
    for (const name of Object.keys(manifest.manifest.optionalDependencies ?? {})) {
      try {
        const resolved = require.resolve(name, { paths: [manifest.dir] });
        if (resolved.endsWith('.node') && !probe.nativeFiles.includes(resolved)) probe.nativeFiles.push(resolved);
      } catch {
        /* platform package for another OS: expected to be absent */
      }
    }
  }

  let loadedNative = '';
  const originalDlopen = process.dlopen;
  process.dlopen = function patchedDlopen(module, filename, flags) {
    try {
      loadedNative = String(filename);
    } catch {
      /* never let bookkeeping break the load */
    }
    return originalDlopen.call(this, module, filename, flags);
  };
  let instance = null;
  try {
    instance = require(modulePath);
  } catch (error) {
    probe.errorCode = String(error?.code ?? 'BRIDGE_LOAD_FAILED');
    probe.errorMessage = String(error?.message ?? error);
    return { probe, instance: null };
  } finally {
    process.dlopen = originalDlopen;
  }

  probe.native = loadedNative || probe.nativeFiles[0] || '';
  try {
    probe.platform = String(instance.getPlatform());
  } catch (error) {
    probe.errorCode = String(error?.code ?? 'BRIDGE_LOAD_FAILED');
    probe.errorMessage = `getPlatform failed: ${error?.message ?? error}`;
  }
  try {
    probe.senders = instance.listSenders().map((entry) => String(entry?.name ?? '')).filter((name) => name.length > 0);
  } catch {
    /* sender enumeration is diagnostic only */
  }
  if (typeof instance.TextureReceiver !== 'function') {
    probe.errorCode = 'BRIDGE_LOAD_FAILED';
    probe.errorMessage = 'loaded module has no TextureReceiver export';
    instance = null;
  }
  return { probe, instance };
}

const bridgeLoad = inElectron
  ? loadBridge()
  : {
    probe: {
      module: '',
      version: '',
      path: '',
      packageDir: '',
      native: '',
      nativeFiles: [],
      platform: '',
      senders: [],
      errorCode: '',
      errorMessage: '',
    },
    instance: null,
  };
const bridge = bridgeLoad.probe;
const bridgeInstance = bridgeLoad.instance;

/** Quit once, with a hard fallback: a composited transparent window can refuse to close. */
function quit(reason) {
  if (quitting) return;
  quitting = true;
  // Stop accepting interaction and restore the normal (off) state before the window goes away.
  try {
    editController?.dispose();
  } catch {
    /* the window may already be destroyed */
  }
  editController = null;
  if (receiverTimer !== null) clearTimeout(receiverTimer);
  if (senderTimer !== null) clearTimeout(senderTimer);
  // Explicit, deterministic shutdown. `app.quit()` waits for the transparent window to close and
  // can keep the process alive for seconds (and the fallback timer does not fire while Chromium's
  // shutdown loop runs), which is exactly the >3 s stop latency the host saw. Stop the native
  // receiver, tell the page to release its GL objects, write the final line and exit the process;
  // the window is owned by this process and closes with it.
  try {
    mainWindow?.webContents?.send?.('layer:stop');
  } catch {
    /* the renderer may already be gone */
  }
  // Stage timestamps make a stalled stop locatable: request received (ack), cleanup started,
  // cleanup finished, app.exit called, main process exiting. The host records the child exit.
  const cleanupStartedAt = Date.now();
  shutdownTimeline.receiverCleanupStartedAt = cleanupStartedAt;
  emitSync({
    type: 'shutdown-stage',
    stage: 'receiver-cleanup-start',
    atMs: cleanupStartedAt,
    at: new Date(cleanupStartedAt).toISOString(),
    reason,
    stages: { receiverCleanupStartedAt: cleanupStartedAt },
  });
  if (receiver !== null) {
    try {
      receiver.instance.stop();
    } catch {
      /* terminal native cleanup is idempotent in the bridge */
    }
    receiver = null;
  }
  const cleanupFinishedAt = Date.now();
  shutdownTimeline.receiverCleanupFinishedAt = cleanupFinishedAt;
  emitSync({
    type: 'shutdown-stage',
    stage: 'receiver-cleanup-done',
    atMs: cleanupFinishedAt,
    at: new Date(cleanupFinishedAt).toISOString(),
    reason,
    stages: { receiverCleanupFinishedAt: cleanupFinishedAt },
  });
  // Leave the BrowserWindow to process teardown: `win.destroy()` waits for the compositor/GPU to
  // release a transparent textured window (observed >6 s here), which is exactly the stop latency
  // the host measured. The process owns the window; exiting closes it. The renderer gets the
  // `layer:stop` line first (best effort) to release its GL objects.
  const exitRequestedAt = Date.now();
  shutdownTimeline.exitRequestedAt = exitRequestedAt;
  // Legacy alias for the same instant; `mainExitAt` stays unset until the process really exits.
  shutdownTimeline.appExitCalledAt = exitRequestedAt;
  emitSync({
    type: 'shutdown-stage',
    stage: 'app-exit',
    atMs: exitRequestedAt,
    at: new Date(exitRequestedAt).toISOString(),
    reason,
    stages: {
      receiverCleanupFinishedAt: cleanupFinishedAt,
      exitRequestedAt,
      appExitCalledAt: exitRequestedAt,
      mainExitAt: shutdownTimeline.mainExitAt,
    },
  });
  emitSync({
    type: 'exit',
    reason,
    pid: process.pid,
    at: new Date(exitRequestedAt).toISOString(),
    stages: { ...shutdownTimeline },
  });
  quitReason = reason;
  installMainExitStage();
  app.exit(0);
}

/** Main-process shutdown receiver; `shutdown` messages from stdin land here. */
const shutdownReceiver = createShutdownReceiver({
  emit: (payload) => emitSync(payload),
  quit: (reason) => quit(reason),
  timeline: shutdownTimeline,
});

function displayInfo() {
  const display = screen.getPrimaryDisplay();
  return {
    scaleFactor: display.scaleFactor,
    workArea: display.workArea,
    bounds: mainWindow === null ? null : mainWindow.getBounds(),
  };
}

/** Geometry provenance: what the host asked for vs. what the window actually is. */
function windowInfo() {
  return {
    requested: activeBounds,
    bounds: mainWindow === null || mainWindow.isDestroyed() ? null : mainWindow.getBounds(),
    boundsSource,
    size: WINDOW_SIZE,
  };
}

/** ready(control): the window and the IPC channel exist; the page may still be loading. */
function reportControlReady() {
  if (controlReported) return;
  controlReported = true;
  emit({
    type: 'ready',
    phase: 'control',
    versions: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      bridge: bridge.version,
      bridgePath: bridge.path,
      bridgeNative: bridge.native,
      bridgeNativeFiles: bridge.nativeFiles,
      bridgeModule: bridge.module,
      bridgePlatform: bridge.platform,
      bridgeSenders: bridge.senders,
      bridgeError: bridge.errorCode === '' ? '' : `${bridge.errorCode}: ${bridge.errorMessage}`,
      bridgeErrorCode: bridge.errorCode,
    },
    display: displayInfo(),
    window: windowInfo(),
    layerKey,
    pid: process.pid,
    elapsedMs: Date.now() - startedAt,
    ...textureStats(),
    at: new Date().toISOString(),
  });
}

function reportRendererError(code, message) {
  emit({ type: 'error', code, message, at: new Date().toISOString() });
  quit('renderer-error');
}

function applyBounds(requested, source) {
  if (mainWindow === null || mainWindow.isDestroyed()) return null;
  mainWindow.setBounds({ x: requested.left, y: requested.top, width: requested.width, height: requested.height });
  activeBounds = { ...requested };
  boundsSource = source;
  emit({ type: 'info', message: 'bounds applied', bounds: activeBounds, boundsSource: source });
  return windowInfo();
}

/** Interactive edit mode: window interaction only; the texture stage and fps are never touched. */
const EDIT_MIN_SIZE = { width: 64, height: 64 };
/** At most one `spout.edit.bounds` diagnostic per gesture interval. */
const EDIT_BOUNDS_THROTTLE_MS = 50;

/**
 * Layer-internal edit mode. Owns mouse pass-through, drag/resize, Escape and bounds reporting for
 * the one window. It references no stage, texture or health state, so toggling it cannot change
 * rendering or the frame-rate accounting. Exported for the fake-window tests.
 */
function createEditMode({
  win,
  ipc = ipcMain,
  emit: emitLine = emit,
  now = Date.now,
  throttleMs = EDIT_BOUNDS_THROTTLE_MS,
  onBounds = null,
} = {}) {
  let active = false;
  let disposed = false;
  let bounds = null;
  let lastBoundsAt = -Infinity;
  const handlers = [];

  const read = () => {
    let raw = null;
    try {
      raw = win.getBounds();
    } catch {
      raw = null;
    }
    if (raw === null || typeof raw !== 'object') raw = bounds ?? { x: 0, y: 0, ...WINDOW_SIZE };
    bounds = {
      x: Math.round(Number(raw.x) || 0),
      y: Math.round(Number(raw.y) || 0),
      width: Math.max(1, Math.round(Number(raw.width) || WINDOW_SIZE.width)),
      height: Math.max(1, Math.round(Number(raw.height) || WINDOW_SIZE.height)),
    };
    return { ...bounds };
  };

  const send = (channel, payload) => {
    try {
      win.webContents?.send?.(channel, payload);
    } catch {
      /* the page may be gone; the window rectangle is still correct */
    }
  };

  const publish = (event, extra = {}) => {
    emitLine({ type: 'diagnostic', event: `spout.edit.${event}`, ...extra, at: new Date().toISOString() });
  };

  const publishBounds = (force = false) => {
    const at = now();
    if (!force && at - lastBoundsAt < throttleMs) return false;
    lastBoundsAt = at;
    const next = read();
    onBounds?.(next);
    publish('bounds', { bounds: next, ...next });
    return true;
  };

  const apply = (next) => {
    try {
      win.setBounds({ x: next.x, y: next.y, width: next.width, height: next.height });
    } catch {
      return false;
    }
    onBounds?.(next);
    // The canvas/GL viewport must follow the window exactly; a drag can coalesce `resize` events,
    // so the new drawing-buffer size is sent explicitly after every applied rectangle.
    send('layer:edit:viewport', { width: next.width, height: next.height });
    return true;
  };

  const dragBy = (dx, dy) => {
    if (!active) return { ok: false, bounds: read() };
    const base = read();
    const next = {
      x: base.x + Math.round(Number(dx) || 0),
      y: base.y + Math.round(Number(dy) || 0),
      width: base.width,
      height: base.height,
    };
    if (!apply(next)) return { ok: false, bounds: base };
    publishBounds();
    return { ok: true, bounds: { ...next } };
  };

  const resizeBy = (dw, dh) => {
    if (!active) return { ok: false, bounds: read() };
    const base = read();
    const next = {
      x: base.x,
      y: base.y,
      width: Math.max(EDIT_MIN_SIZE.width, base.width + Math.round(Number(dw) || 0)),
      height: Math.max(EDIT_MIN_SIZE.height, base.height + Math.round(Number(dh) || 0)),
    };
    if (!apply(next)) return { ok: false, bounds: base };
    publishBounds();
    return { ok: true, bounds: { ...next } };
  };

  /** End of a drag/resize gesture: one unthrottled report so the final rectangle is never lost. */
  const finish = () => {
    const next = read();
    onBounds?.(next);
    lastBoundsAt = now();
    publish('bounds', { bounds: next, ...next });
    return { ok: true, bounds: { ...next } };
  };

  const setEditMode = (enabled) => {
    const on = enabled === true;
    if (on === active) return { ok: true, editMode: active, bounds: read() };
    active = on;
    win.setFocusable?.(on);
    win.setSkipTaskbar?.(!on);
    if (on) {
      try {
        win.setIgnoreMouseEvents(false);
      } catch {
        /* the window is already gone */
      }
      try {
        win.focus?.();
      } catch {
        /* focus is best effort; clicks still work */
      }
      publish('enter', { bounds: read() });
    } else {
      const next = finish().bounds;
      try {
        win.setIgnoreMouseEvents(true, { forward: true });
      } catch {
        /* the window is already gone */
      }
      publish('exit', { bounds: next });
      lastBoundsAt = -Infinity;
    }
    send('layer:edit:mode', { editMode: active, bounds: read() });
    return { ok: true, editMode: active, bounds: read() };
  };

  const bind = (channel, handler) => {
    if (typeof ipc?.on !== 'function') return;
    ipc.on(channel, handler);
    handlers.push({ channel, handler });
  };
  bind('layer:edit:drag', (_event, payload) => {
    if (payload?.done === true) finish();
    else dragBy(payload?.dx, payload?.dy);
  });
  bind('layer:edit:resize', (_event, payload) => {
    if (payload?.done === true) finish();
    else resizeBy(payload?.dx, payload?.dy);
  });
  bind('layer:edit:escape', () => setEditMode(false));

  /** Leave edit mode (restoring click-through) and release every IPC listener. Idempotent. */
  const dispose = () => {
    if (disposed) return { ok: true, editMode: false, bounds: read() };
    disposed = true;
    let final = read();
    if (active) final = setEditMode(false).bounds;
    for (const entry of handlers) {
      try {
        ipc?.removeListener?.(entry.channel, entry.handler);
      } catch {
        /* ipc is already gone */
      }
    }
    handlers.length = 0;
    return { ok: true, editMode: false, bounds: { ...final } };
  };

  return {
    setEditMode,
    dragBy,
    resizeBy,
    finish,
    dispose,
    read,
    get editMode() { return active; },
    get bounds() { return bounds === null ? null : { ...bounds }; },
  };
}

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  activeBounds = initialBounds !== null
    ? { ...initialBounds }
    : {
      left: Math.round(workArea.x + (workArea.width - WINDOW_SIZE.width) / 2),
      top: Math.round(workArea.y + (workArea.height - WINDOW_SIZE.height) / 2),
      width: WINDOW_SIZE.width,
      height: WINDOW_SIZE.height,
    };
  boundsSource = initialBounds !== null ? 'argument' : 'fallback';

  const win = new BrowserWindow({
    x: activeBounds.left,
    y: activeBounds.top,
    width: activeBounds.width,
    height: activeBounds.height,
    show: false,
    ...WINDOW_PRESENTATION,
    resizable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    fullscreenable: false,
    minimizable: false,
    maximizable: false,
    webPreferences: {
      preload: join(LAYER_ROOT, 'preload.js'),
      ...WINDOW_WEB_PREFERENCES,
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  // The window options above are the contract; re-assert the two that a compositor can quietly
  // recompute at creation time (a material backdrop would paint behind the transparent surface).
  applyWindowPresentation(win);
  // Geometry first, then show: showing at the default size and resizing afterwards would flash.
  win.setBounds({ x: activeBounds.left, y: activeBounds.top, width: activeBounds.width, height: activeBounds.height });
  win.setIgnoreMouseEvents(true, { forward: true });
  // Edit mode is layer-internal: the host toggles it over stdin and mirrors the diagnostics.
  // It changes only window interaction/bounds; the stage and its frame accounting are untouched.
  editController = createEditMode({
    win,
    ipc: ipcMain,
    emit,
    onBounds: (next) => {
      activeBounds = { left: next.x, top: next.y, width: next.width, height: next.height };
    },
  });

  // `show: false` until the geometry is in place, then a focus-free show: the layer must never
  // steal focus from whatever the user is doing.
  //
  // Do NOT make the reveal depend only on `ready-to-show`: on a compositor that never commits the
  // offscreen first paint that event can be late or absent, and the renderer report (which needs
  // an animation frame) would then never arrive. `did-finish-load` and a short fallback both
  // reveal the geometry-correct window, so the renderer always gets a chance to paint.
  const reveal = (reason) => {
    if (win.isDestroyed()) return;
    const visible = win.isVisible();
    if (!visible) {
      win.showInactive();
      windowShown = true;
    }
    if (!visible) {
      emit({ type: 'info', message: 'window shown', reason, elapsedMs: Date.now() - startedAt });
    }
  };
  win.once('ready-to-show', () => {
    readyToShow = true;
    reveal('ready-to-show');
  });
  win.webContents.once('did-finish-load', () => {
    didFinishLoad = true;
    reveal('did-finish-load');
  });
  const showFallback = setTimeout(() => reveal('show-fallback'), SHOW_FALLBACK_MS);
  showFallback.unref?.();

  win.once('closed', () => {
    // The window is gone: leave edit mode (restoring nothing) and drop the IPC listeners so a
    // later window cannot receive this one's drag/resize/escape messages.
    try {
      editController?.dispose();
    } catch {
      /* already torn down */
    }
    editController = null;
    clearTimeout(showFallback);
    mainWindow = null;
    quit('window-closed');
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    reportRendererError('WINDOW_FAILED', `renderer gone: ${details?.reason ?? 'unknown'}`);
  });
  win.webContents.on('preload-error', (_event, preloadPath, error) => {
    reportRendererError('WINDOW_FAILED', `preload failed: ${preloadPath}: ${error?.message ?? error}`);
  });
  win.webContents.on('did-fail-load', (_event, code, description) => {
    reportRendererError('WINDOW_FAILED', `did-fail-load ${code} ${description}`);
  });

  win.loadFile(join(LAYER_ROOT, 'index.html')).then(() => reveal('loadFile')).catch((error) => {
    reportRendererError('WINDOW_FAILED', `loadFile: ${error?.message ?? error}`);
  });

  return win;
}

// ---- shared texture delivery (main → renderer) ----------------------------------------------
// `sharedTexture.sendSharedTexture` is main-process only and has a hard 1000 ms budget when the
// renderer has not registered a receiver. That timeout is an *expected* boot state (the first
// frames can arrive before the page calls `setSharedTextureReceiver`), so it is counted and the
// layer stays alive; it must never look like a crash or a dead display.

function textureStats() {
  return {
    sharedTextureRegistered,
    textureTimeouts,
    textureSends,
    textureFrames,
    lastTextureSendMs,
    lastTextureSendAt: lastTextureSendAt > 0 ? new Date(lastTextureSendAt).toISOString() : '',
    lastTextureError,
    texturePush,
    /** `{width,height}` of the last delivered frame, and the stable delivery size. */
    srcSize: { width: srcSize.width, height: srcSize.height },
    stableSize: { width: stableSize.width, height: stableSize.height, source: stableSize.source },
    configuredSize: CONFIGURED_SIZE,
    srcChanges,
    health,
    stage2,
    alphaSample,
  };
}

/** Native bridge frame → Electron `SharedTextureImportTextureInfo`. */
function frameTextureInfo(frame) {
  return {
    pixelFormat: String(frame.pixelFormat ?? 'bgra'),
    codedSize: { width: Number(frame.width) || 0, height: Number(frame.height) || 0 },
    handle: process.platform === 'darwin' ? { ioSurface: frame.handle } : { ntHandle: frame.handle },
  };
}

/**
 * Deliver one imported texture to `frame` inside Electron's own 1000 ms budget, recording success
 * or timeout. Never throws: a missed frame must not take the display process down.
 */
async function sendImportedTexture(imported, frame, meta = {}) {
  if (sharedTexture === undefined) {
    return { ok: false, ms: 0, timeout: false, error: 'sharedTexture API unavailable' };
  }
  if (frame === undefined || frame === null) {
    return { ok: false, ms: 0, timeout: false, error: 'no target frame' };
  }
  const begin = Date.now();
  try {
    await sharedTexture.sendSharedTexture({ frame, importedSharedTexture: imported }, meta);
    const ms = Date.now() - begin;
    textureSends += 1;
    textureFrames += 1;
    lastTextureSendMs = ms;
    lastTextureSendAt = Date.now();
    lastTextureError = '';
    sharedTextureRegistered = true;
    emit({
      type: 'info',
      message: 'shared texture delivered',
      ms,
      width: meta.width ?? null,
      height: meta.height ?? null,
      textureTimeouts,
      sharedTextureRegistered,
      at: new Date().toISOString(),
    });
    return { ok: true, ms, timeout: false, error: '' };
  } catch (error) {
    const ms = Date.now() - begin;
    const message = String(error?.message ?? error);
    const timeout = /timed out|timeout/iu.test(message);
    lastTextureSendMs = ms;
    lastTextureSendAt = Date.now();
    lastTextureError = message;
    if (timeout) textureTimeouts += 1;
    emit({
      type: 'info',
      message: timeout ? 'shared texture send timed out' : 'shared texture send failed',
      ms,
      timeout,
      width: meta.width ?? null,
      height: meta.height ?? null,
      textureTimeouts,
      sharedTextureRegistered,
      error: message,
      at: new Date().toISOString(),
    });
    return { ok: false, ms, timeout, error: message };
  }
}

/** Import a native bridge frame and deliver it; the bridge handle is closed exactly once. */
async function deliverNativeFrame(frame) {
  if (frame === null || frame === undefined) return null;
  const width = Math.max(0, Math.round(Number(frame.width) || 0));
  const height = Math.max(0, Math.round(Number(frame.height) || 0));
  if (width > 0 && height > 0 && (width !== srcSize.width || height !== srcSize.height)) {
    srcSize = { width, height };
    srcChanges += 1;
    emit({
      type: 'info',
      message: 'source size changed',
      width,
      height,
      srcChanges,
      at: new Date().toISOString(),
    });
  }
  // Stable delivery size: the configured size when present, otherwise the sender's current size.
  // The renderer allocates its texture by the actual frame size and maps the quad by this one.
  stableSize = CONFIGURED_SIZE === null
    ? { width: width || stableSize.width, height: height || stableSize.height, source: 'sender' }
    : { width: CONFIGURED_SIZE.width, height: CONFIGURED_SIZE.height, source: 'configured' };
  const meta = {
    width,
    height,
    stableWidth: stableSize.width,
    stableHeight: stableSize.height,
    sizeSource: stableSize.source,
    srcChanges,
  };
  const closeHandle = () => {
    try {
      bridgeInstance?.closeNativeHandle(frame.handle);
    } catch {
      /* already closed */
    }
  };
  if (sharedTexture === undefined) {
    closeHandle();
    return null;
  }
  if (mainWindow === null || mainWindow.isDestroyed()) {
    closeHandle();
    return null;
  }
  if (textureSendInFlight) {
    // One send at a time; a frame that arrives meanwhile is dropped, not queued forever.
    closeHandle();
    return { ok: false, ms: 0, timeout: false, error: 'send-in-flight' };
  }
  textureSendInFlight = true;
  let imported = null;
  try {
    try {
      imported = sharedTexture.importSharedTexture({ textureInfo: frameTextureInfo(frame) });
    } catch (error) {
      lastTextureError = `import: ${error?.message ?? error}`;
      emit({
        type: 'info',
        message: 'shared texture import failed',
        error: lastTextureError,
        at: new Date().toISOString(),
      });
      return { ok: false, ms: 0, timeout: false, error: lastTextureError };
    } finally {
      closeHandle();
    }
    return await sendImportedTexture(imported, mainWindow.webContents.mainFrame, meta);
  } finally {
    try {
      imported?.release?.();
    } catch {
      /* the renderer may already have released its reference */
    }
    textureSendInFlight = false;
  }
}

/** Subscribe the bridge's pushed frames once the native receiver exists. */
function attachTexturePush() {
  if (receiver === null || bridgeInstance === null) return;
  try {
    if (typeof receiver.instance.onSharedTexture !== 'function') {
      throw new Error('onSharedTexture unavailable');
    }
    receiver.instance.onSharedTexture((frame) => {
      void deliverNativeFrame(frame);
    });
    texturePush = 'push';
    emit({ type: 'info', message: 'shared texture push subscribed', sender: receiver.name });
  } catch (error) {
    texturePush = 'unavailable';
    emit({
      type: 'info',
      message: 'shared texture push unavailable',
      error: String(error?.message ?? error),
    });
  }
}

/**
 * Test-only acceptance for the negative path: before the layer's page can register, import an
 * Electron offscreen shared texture and try to deliver it. The expected result is Electron's
 * 1000 ms timeout, counted in `textureTimeouts`; it proves the failure is non-fatal. Gated by
 * `--dsh-texture-selftest=1`, so production never pays for the extra windows.
 */
async function runTextureSelfTest() {
  if (sharedTexture === undefined || typeof sharedTexture.importSharedTexture !== 'function') {
    emit({ type: 'info', message: 'texture selftest skipped', reason: 'sharedTexture unavailable' });
    return null;
  }
  let source = null;
  let target = null;
  let texture = null;
  let imported = null;
  textureSelfTestActive = true;
  try {
    source = new BrowserWindow({
      show: false,
      width: 64,
      height: 64,
      webPreferences: { offscreen: { useSharedTexture: true } },
    });
    const painted = new Promise((resolvePromise) => {
      const timer = setTimeout(() => resolvePromise(null), 5000);
      timer.unref?.();
      source.webContents.once('paint', (event) => {
        clearTimeout(timer);
        resolvePromise(event.texture ?? null);
      });
    });
    await source.loadURL('data:text/html,<body style="background:#204060">texture selftest</body>');
    source.webContents.setFrameRate(5);
    texture = await painted;
    if (texture === null) {
      emit({ type: 'info', message: 'texture selftest skipped', reason: 'no offscreen shared texture' });
      return null;
    }
    // A blank renderer with no preload: nobody called setSharedTextureReceiver, so the send must
    // reject with Electron's 1000 ms timeout instead of crashing.
    target = new BrowserWindow({ show: false, width: 64, height: 64 });
    await target.loadURL('about:blank');
    imported = sharedTexture.importSharedTexture({ textureInfo: texture.textureInfo });
    const result = await sendImportedTexture(imported, target.webContents.mainFrame, {
      width: texture.textureInfo?.codedSize?.width ?? 64,
      height: texture.textureInfo?.codedSize?.height ?? 64,
    });
    emit({
      type: 'info',
      message: 'texture selftest finished',
      ok: result.ok,
      timeout: result.timeout === true,
      ms: result.ms,
      textureTimeouts,
      at: new Date().toISOString(),
    });
    return result;
  } catch (error) {
    emit({ type: 'info', message: 'texture selftest failed', error: String(error?.message ?? error) });
    return null;
  } finally {
    try {
      imported?.release?.();
    } catch {
      /* released with the source texture */
    }
    try {
      texture?.release?.();
    } catch {
      /* already released */
    }
    try {
      target?.destroy();
    } catch {
      /* window already gone */
    }
    try {
      source?.destroy();
    } catch {
      /* window already gone */
    }
  }
}

// ---- receiver registry (main process) ------------------------------------------------------
// The bridge is a N-API addon and Electron's shared-texture API is main-process only, so the
// native `TextureReceiver` must live here. The renderer drives it through preload IPC and only
// reports `ready(receiver)` after this function returns a registered receiver.

function receiverStatus() {
  if (receiver === null) {
    return {
      ok: false,
      registered: false,
      code: 'RECEIVER_NOT_READY',
      message: 'receiver has not been registered',
      sender: CONFIGURED_SENDER,
      surface: { width: 0, height: 0, platform: bridge.platform },
      waitedMs: 0,
      timedOut: senderTimedOut,
    };
  }
  let connected = false;
  let width = 0;
  let height = 0;
  let probeError = '';
  let listed = false;
  let frameAvailable = false;
  try {
    // Enumerating senders is the authoritative "is my sender published?" check.
    try {
      listed = bridgeInstance.listSenders().some((entry) => String(entry?.name ?? '') === receiver.name);
    } catch {
      /* fall back to the receiver's own connection probe */
    }
    width = Math.max(0, Number(receiver.instance.getWidth()) || 0);
    height = Math.max(0, Number(receiver.instance.getHeight()) || 0);
    frameAvailable = receiver.instance.hasNewFrame() === true;
    // `hasNewFrame` alone is not sender evidence (the Spout receiver reports true even for a name
    // nobody publishes), so connection is: sender listed by Spout, or a real surface/connection.
    connected = listed
      || receiver.instance.isConnected() === true
      || (width > 0 && height > 0);
  } catch (error) {
    probeError = String(error?.message ?? error);
  }
  if (connected) {
    if (senderTimer !== null) {
      clearTimeout(senderTimer);
      senderTimer = null;
    }
    senderTimedOut = false;
  }
  return {
    ok: true,
    registered: true,
    sender: receiver.name,
    connected,
    listed,
    frameAvailable,
    surface: { width, height, platform: receiver.platform },
    waitedMs: Date.now() - receiver.registeredAt,
    senderTimeoutMs: SENDER_TIMEOUT_MS,
    timedOut: senderTimedOut,
    error: probeError,
  };
}

function registerReceiver(requestedSender) {
  if (bridgeInstance === null) {
    return {
      ok: false,
      registered: false,
      code: 'BRIDGE_LOAD_FAILED',
      message: bridge.errorCode === '' ? 'bridge is not loaded' : `${bridge.errorCode}: ${bridge.errorMessage}`,
      sender: CONFIGURED_SENDER,
    };
  }
  if (receiver !== null) return receiverStatus();

  const name = String(requestedSender ?? '').trim() || CONFIGURED_SENDER;
  let instance = null;
  try {
    instance = new bridgeInstance.TextureReceiver(name);
  } catch (error) {
    return {
      ok: false,
      registered: false,
      code: 'RECEIVER_NOT_READY',
      message: `TextureReceiver("${name}") failed: ${error?.message ?? error}`,
      sender: name,
    };
  }
  receiver = {
    name,
    instance,
    registeredAt: Date.now(),
    platform: String(bridge.platform ?? ''),
  };
  senderTimedOut = false;
  attachTexturePush();
  senderTimer = setTimeout(() => {
    senderTimer = null;
    if (receiver === null) return;
    const status = receiverStatus();
    if (status.connected === true) return;
    senderTimedOut = true;
    // The window stays alive: phase 0 reports the missing sender instead of turning a "VTS not
    // started yet" situation into a dead layer.
    emit({
      type: 'error',
      code: 'SENDER_NOT_FOUND',
      message: `sender "${name}" not found within ${SENDER_TIMEOUT_MS} ms (receiver registered, window kept alive)`,
      sender: name,
      waitedMs: status.waitedMs,
      at: new Date().toISOString(),
    });
  }, SENDER_TIMEOUT_MS);
  senderTimer.unref?.();
  emit({
    type: 'info',
    message: 'receiver registered',
    sender: name,
    platform: receiver.platform,
    native: bridge.native,
    at: new Date().toISOString(),
  });
  return receiverStatus();
}

ipcMain.handle('layer:receiver:register', (_event, info) => registerReceiver(info?.sender));

ipcMain.handle('layer:receiver:status', () => receiverStatus());

// The renderer calls `sharedTexture.setSharedTextureReceiver` first and only then asks the main
// process to acknowledge the registration. `ready(receiver)` is refused until this has happened,
// so "receiver ready" always means both the native Spout receiver and Electron's texture receiver.
ipcMain.handle('layer:texture:receiver-ready', () => {
  textureRegistered = true;
  sharedTextureRegistered = true;
  emit({
    type: 'info',
    message: 'renderer shared texture receiver registered',
    sharedTextureRegistered,
    textureTimeouts,
    lastTextureSendMs,
    at: new Date().toISOString(),
  });
  return { ok: true, registered: true, ...textureStats() };
});

ipcMain.on('layer:texture:frame', (_event, info) => {
  emit({
    type: 'info',
    message: 'shared texture frame received by renderer',
    frames: Number(info?.frames ?? 0),
    drawn: info?.drawn === true,
    width: Number(info?.width ?? 0),
    height: Number(info?.height ?? 0),
    at: new Date().toISOString(),
  });
});

// 1 Hz renderer health: actual draw fps + sizes. Forwarded verbatim (one short JSON line) so the
// host snapshot carries a real fps, not a guess derived from send attempts.
ipcMain.on('layer:texture:stats', (_event, payload) => {
  const fpsValue = Number(payload?.fps);
  const fpsMinValue = Number(payload?.fpsMin);
  const fpsMaxValue = Number(payload?.fpsMax);
  health = {
    fps: Number.isFinite(fpsValue) ? Math.round(fpsValue * 10) / 10 : 0,
    fpsMin: Number.isFinite(fpsMinValue) ? Math.round(fpsMinValue * 10) / 10 : 0,
    fpsMax: Number.isFinite(fpsMaxValue) ? Math.round(fpsMaxValue * 10) / 10 : 0,
    width: Math.max(0, Math.round(Number(payload?.width) || 0)),
    height: Math.max(0, Math.round(Number(payload?.height) || 0)),
    textureWidth: Math.max(0, Math.round(Number(payload?.textureWidth) || 0)),
    textureHeight: Math.max(0, Math.round(Number(payload?.textureHeight) || 0)),
    stableWidth: Math.max(0, Math.round(Number(payload?.stableWidth) || 0)),
    stableHeight: Math.max(0, Math.round(Number(payload?.stableHeight) || 0)),
    drawn: Math.max(0, Math.round(Number(payload?.drawn) || 0)),
    placeholder: payload?.placeholder === true,
    at: Date.now(),
  };
  emit({ type: 'health', ...health, at: new Date(health.at).toISOString() });
});

/**
 * Classify one renderer alpha message. This is the receiver-side evidence for a black background:
 * `alphaZero > 0` (or any partial pixel) means transparent data really arrived, so a black screen
 * is a presentation problem. `opaque` means every receiver-side *sampled point* is alpha 255
 * (`scope:"sampled"`), not that the whole sender frame is opaque; the hint only lists what to check
 * and never asserts that the VTS configuration is wrong. A read-back that set a GL error is not
 * evidence at all: it is its own `spout.alpha.read-error` event with no counts, so it can never be
 * classified as transparent. Returns `null` for counts that cannot describe one frame (so a
 * malformed line is never logged as evidence).
 */
function alphaDiagnostic(payload) {
  // The disabled report is checked first: it also carries the read-error cause.
  if (payload?.event === 'spout.alpha.disabled') {
    return {
      event: 'spout.alpha.disabled',
      opaque: false,
      payload: {
        error: payload?.error ?? 'unknown',
        alphaReadErrors: Math.max(0, Math.round(Number(payload?.alphaReadErrors) || 0)),
      },
    };
  }
  if (payload?.reason === 'read-error') {
    return {
      event: 'spout.alpha.read-error',
      opaque: false,
      payload: { error: payload?.error ?? 'unknown' },
    };
  }
  const total = Math.max(0, Math.round(Number(payload?.total) || 0));
  const alphaZero = Math.max(0, Math.round(Number(payload?.alphaZero) || 0));
  const alphaOpaque = Math.max(0, Math.round(Number(payload?.alphaOpaque) || 0));
  const alphaPartial = Math.max(0, Math.round(Number(payload?.alphaPartial) || 0));
  if (total <= 0 || alphaZero + alphaOpaque + alphaPartial !== total) return null;
  const opaque = alphaOpaque === total;
  return {
    event: opaque ? 'spout.alpha.opaque-frame' : 'spout.alpha.sample',
    opaque,
    payload: {
      total,
      alphaZero,
      alphaOpaque,
      alphaPartial,
      verdict: opaque ? 'opaque' : (alphaZero > 0 ? 'transparent' : 'partial'),
      scope: 'sampled',
      width: Math.max(0, Math.round(Number(payload?.width) || 0)),
      height: Math.max(0, Math.round(Number(payload?.height) || 0)),
      ...(opaque
        ? { hint: '采样点全为不透明，可能是 VTS Spout 背景设置或接收转换；请核对 VTS 背景 = TRANSPARENT BLACK' }
        : {}),
    },
  };
}

// Receiver-side alpha evidence at most once a second. A fully opaque *sample set* is reported as
// its own event with the scope and the settings to check; a failed read is reported as a read error
// with no counts. Neither changes rendering, because keying an opaque frame is exactly the fallback
// this layer refuses.
ipcMain.on('layer:texture:alpha', (_event, payload) => {
  const diagnostic = alphaDiagnostic(payload);
  if (diagnostic === null) {
    emit({ type: 'info', message: 'alpha sample ignored: inconsistent counts', sample: payload ?? null });
    return;
  }
  alphaSample = { event: diagnostic.event, ...diagnostic.payload, at: Date.now() };
  emit({
    type: 'diagnostic',
    event: diagnostic.event,
    ...diagnostic.payload,
    at: new Date(alphaSample.at).toISOString(),
  });
});

// Stage-2 diagnostics: the renderer already throttles to <= 1 Hz; forward exactly one structured
// line so the host can log `spout.stage2` without guessing from health deltas.
ipcMain.on('layer:texture:stage2', (_event, payload) => {
  const fpsValue = Number(payload?.fps);
  const alphaMode = String(payload?.alphaMode ?? '');
  stage2 = {
    fps: Number.isFinite(fpsValue) ? Math.round(fpsValue * 10) / 10 : 0,
    dropped: Math.max(0, Math.round(Number(payload?.dropped) || 0)),
    resized: Math.max(0, Math.round(Number(payload?.resized) || 0)),
    framebufferErrors: Math.max(0, Math.round(Number(payload?.framebufferErrors) || 0)),
    alphaMode: alphaMode === 'premultiplied' ? alphaMode : '',
    at: Date.now(),
  };
  emit({
    type: 'diagnostic',
    event: 'spout.stage2',
    fps: stage2.fps,
    dropped: stage2.dropped,
    resized: stage2.resized,
    framebufferErrors: stage2.framebufferErrors,
    alphaMode: stage2.alphaMode,
    at: new Date(stage2.at).toISOString(),
  });
});

ipcMain.on('layer:texture:error', (_event, payload) => {
  // A bad frame is a dropped frame, not a dead layer: count it and keep the window alive.
  emit({
    type: 'info',
    message: 'texture frame dropped',
    code: String(payload?.code ?? ''),
    error: String(payload?.error ?? ''),
    at: new Date().toISOString(),
  });
});

ipcMain.on('layer:set-bounds', (_event, payload) => {
  const next = parseBoundsObject(payload?.bounds ?? payload);
  if (next === null) {
    emit({ type: 'info', message: 'set-bounds ignored: invalid bounds', payload: String(payload) });
    return;
  }
  applyBounds(next, 'action');
});

// The renderer reports only after it has a registered receiver. A legacy marker-canvas report
// (no `registered:true`) is deliberately ignored: a painted test canvas is not a receiver.
ipcMain.on('layer:ready', (_event, info) => {
  const payload = info ?? {};
  if (payload.registered !== true) {
    emit({ type: 'info', message: 'ignored ready without registered receiver', drawn: payload.drawn === true, frames: payload.frames ?? 0 });
    return;
  }
  if (payload.sharedTextureRegistered !== true || textureRegistered !== true) {
    reportRendererError(
      'SHARED_TEXTURE_NOT_REGISTERED',
      `ready(${String(payload.phase ?? '')}) before setSharedTextureReceiver was acknowledged`,
    );
    return;
  }
  if (receiver === null) {
    reportRendererError('RECEIVER_NOT_READY', 'renderer reported a receiver before it was registered');
    return;
  }
  const frames = Number(payload.frames ?? 0);
  if (Number.isFinite(frames) && frames > framesDrawn) framesDrawn = frames;
  const status = receiverStatus();
  if (status.connected !== true) {
    if (receiverTimer !== null) {
      clearTimeout(receiverTimer);
      receiverTimer = null;
    }
    if (receiverReported) return;
    emit({
      type: 'ready',
      phase: 'waiting-sender',
      registered: true,
      connected: false,
      sender: status.sender,
      surface: status.surface,
      listed: status.listed === true,
      frameAvailable: status.frameAvailable === true,
      waitedMs: status.waitedMs,
      senderTimeoutMs: SENDER_TIMEOUT_MS,
      drawn: payload.drawn === true,
      frames: framesDrawn,
      elapsedMs: Date.now() - startedAt,
      window: { visible: mainWindow !== null && mainWindow.isVisible(), readyToShow, didFinishLoad, windowShown },
      display: displayInfo(),
      layerKey,
      pid: process.pid,
      ...textureStats(),
      at: new Date().toISOString(),
    });
    return;
  }
  if (receiverReported) return;
  receiverReported = true;
  if (receiverTimer !== null) {
    clearTimeout(receiverTimer);
    receiverTimer = null;
  }
  if (senderTimer !== null) {
    clearTimeout(senderTimer);
    senderTimer = null;
  }
  emit({
    type: 'ready',
    phase: 'receiver',
    registered: true,
    connected: true,
    sender: status.sender,
    surface: status.surface,
    listed: status.listed === true,
    frameAvailable: status.frameAvailable === true,
    waitedMs: status.waitedMs,
    drawn: payload.drawn === true,
    frames: framesDrawn,
    elapsedMs: Date.now() - startedAt,
    window: { visible: mainWindow !== null && mainWindow.isVisible(), readyToShow, didFinishLoad, windowShown },
    display: displayInfo(),
    layerKey,
    pid: process.pid,
    ...textureStats(),
    at: new Date().toISOString(),
  });
});

ipcMain.on('layer:error', (_event, payload) => {
  reportRendererError(String(payload?.code ?? 'WINDOW_FAILED'), String(payload?.message ?? ''));
});

/**
 * Lifetime: the host owns our stdin. When it closes the write end (host exit, plugin reload,
 * hard kill) we quit, so a dead host can never leave an orphan window behind.
 *
 * Chromium's `process.stdin` stream is unusable here: in an Electron main process on Windows it
 * reports EOF immediately even while the pipe is still open, which would quit the layer at boot.
 * Read the descriptor directly instead — `fs.read` parks in the libuv pool and completes only
 * when the peer really closes, or with 0 bytes for a genuinely closed/null stdin.
 *
 * A null/console/file descriptor is not a lifetime channel at all. Reading it returns 0
 * immediately, and quitting on that would destroy the window before it loads — the observed
 * "never reached ready(receiver), final state stopped" failure. A real POSIX pipe is a FIFO and
 * an inherited socket is a socket; a Windows anonymous pipe (`spawn(..., stdio: 'pipe')`) has no
 * POSIX type, while NUL/console/file are character devices or regular files.
 */
function hasStdinLifetimeChannel() {
  try {
    const stats = fstatSync(0);
    if (stats.isFIFO() || stats.isSocket()) return true;
    if (stats.isCharacterDevice() || stats.isFile() || stats.isBlockDevice()) return false;
    return true;
  } catch {
    return false;
  }
}

function watchParentStdin({
  hasChannel = hasStdinLifetimeChannel,
  readStdin = read,
  isStopping = () => quitting,
  receive = (message) => shutdownReceiver.receive(message),
} = {}) {
  if (!hasChannel()) {
    emit({
      type: 'info',
      message: 'stdin is not a pipe; host-lifetime watch disabled',
      stdin: 'non-pipe',
    });
    return;
  }
  const buffer = Buffer.alloc(4096);
  // Parse real data instead of discarding it: the host sends one `shutdown` JSON line and waits
  // for the ack. EOF remains the fallback for a host that died without saying goodbye.
  const parser = createStdinParser({
    onMessage: (message) => {
      if (message?.type === 'shutdown') receive(message);
      // Edit-mode toggle from the host: enable/disable interaction only. The layer answers with
      // `spout.edit.enter|exit` diagnostics, which the host mirrors into its snapshot/events.
      else if (message?.type === 'edit') editController?.setEditMode(message.enabled === true);
    },
    onLine: (line) => emit({ type: 'info', message: 'stdin line ignored', line: String(line).slice(0, 200) }),
  });
  const pump = () => {
    if (isStopping()) return;
    readStdin(0, buffer, 0, buffer.length, null, (error, bytes) => {
      if (error) {
        quit('stdin-error');
        return;
      }
      if (bytes === 0) {
        parser.flush();
        shutdownTimeline.eofAt = Date.now();
        quit('stdin-end');
        return;
      }
      parser.feed(buffer.subarray(0, bytes));
      // app.exit() schedules teardown but returns to this callback. Starting another blocking
      // fs.read here keeps a libuv worker parked on the still-open host pipe; Electron reaches
      // its process exit hook but cannot finish until the host force-kills it. Once shutdown
      // was accepted, leave the pipe idle rather than scheduling any more reads.
      if (!isStopping()) pump();
    });
  };
  try {
    pump();
  } catch {
    emit({ type: 'info', message: 'stdin watch unavailable; continuing without lifetime signal', stdin: 'unavailable' });
  }
}
if (inElectron) watchParentStdin();

// Chromium already honours these, but applying them here keeps a hand-run window identical to
// a host-launched one (same scale, same isolated profile, no stale cache).
app?.commandLine?.appendSwitch?.('force-device-scale-factor', '1');
const userDataOverride = argValue('user-data-dir');
if (inElectron && userDataOverride.length > 0) {
  try {
    mkdirSync(userDataOverride, { recursive: true });
    app.setPath('userData', userDataOverride);
  } catch {
    /* a locked profile path is not fatal: Chromium falls back to its default location */
  }
}

if (bridge.errorCode !== '') {
  // Never silently degrade: the host must see the raw dlopen/module failure, not a window that
  // later fails to receive anything.
  emit({
    type: 'error',
    code: 'BRIDGE_LOAD_FAILED',
    message: `${bridge.errorCode}: ${bridge.errorMessage}`,
    bridge: {
      module: bridge.module,
      errorCode: bridge.errorCode,
      errorMessage: bridge.errorMessage,
      packagePath: bridge.path,
      nativeFiles: bridge.nativeFiles,
    },
    at: new Date().toISOString(),
  });
  setTimeout(() => process.exit(1), 600);
}

if (inElectron) {
  app.whenReady().then(async () => {
    if (bridge.errorCode !== '') {
      quit('bridge-load-failed');
      return;
    }
    // The selftest must run before the page loads: it needs an unregistered renderer target so the
    // delivery hits Electron's 1000 ms timeout, and only then is the result observable in control.
    if (argValue('dsh-texture-selftest') === '1') await runTextureSelfTest();
    mainWindow = createWindow();
    textureSelfTestActive = false;
    reportControlReady();
    // A renderer that never registers a receiver is a failure the host must see, not a silent
    // half-start. The message carries the state that distinguishes the causes.
    receiverTimer = setTimeout(() => {
      if (receiverReported) return;
      const visible = mainWindow !== null && !mainWindow.isDestroyed() && mainWindow.isVisible();
      reportRendererError(
        'RECEIVER_NOT_READY',
        `no registered receiver within ${RECEIVER_TIMEOUT_MS} ms (elapsedMs=${Date.now() - startedAt}, framesDrawn=${framesDrawn}, visible=${visible}, readyToShow=${readyToShow}, didFinishLoad=${didFinishLoad}, windowShown=${windowShown}, sender="${CONFIGURED_SENDER}")`,
      );
    }, RECEIVER_TIMEOUT_MS);
    receiverTimer.unref?.();
    emit({
      type: 'info',
      message: 'layer started',
      layerKey,
      window: WINDOW_SIZE,
      bounds: activeBounds,
      boundsSource,
      sender: CONFIGURED_SENDER,
      size: CONFIGURED_SIZE,
      receiverTimeoutMs: RECEIVER_TIMEOUT_MS,
      senderTimeoutMs: SENDER_TIMEOUT_MS,
    });
  });

  app.on('window-all-closed', () => {
    // The texture selftest intentionally opens/closes throwaway windows before the layer window
    // exists; that transient zero-window moment is not "the user closed the layer".
    if (textureSelfTestActive) return;
    quit('window-all-closed');
  });
  app.on('before-quit', () => {
    if (receiverTimer !== null) clearTimeout(receiverTimer);
    if (senderTimer !== null) clearTimeout(senderTimer);
    if (receiver !== null) {
      try {
        receiver.instance.stop();
      } catch {
        /* terminal native cleanup is idempotent in the bridge */
      }
      receiver = null;
    }
  });
}

// Test hooks only: plain Node imports this module to exercise the stdin shutdown protocol. Under
// Electron the same functions are used by `watchParentStdin`; exporting them changes no behaviour.
module.exports = {
  applyWindowPresentation,
  createStdinParser,
  createShutdownReceiver,
  createEditMode,
  watchParentStdin,
  alphaDiagnostic,
  shutdownTimeline,
  throttleInfo,
  resetInfoThrottle: () => {
    infoThrottle.clear();
    infoThrottled = 0;
  },
  INFO_THROTTLE_MS,
  WINDOW_PRESENTATION,
  WINDOW_WEB_PREFERENCES,
};
