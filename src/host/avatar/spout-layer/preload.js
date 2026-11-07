/**
 * Spout layer preload — the whole renderer surface, deliberately narrow.
 *
 * The layer page is not allowed to call `require('electron')` (contextIsolation stays on). That
 * matters for phase 1 because the textured frame arrives as a `VideoFrame` owned by
 * `sharedTexture.setSharedTextureReceiver`, which is only callable where Electron's renderer
 * module is available. The preload therefore hosts the WebGL stage itself (an isolated world
 * still shares the DOM with the page), and the page drives the lifecycle through this bridge.
 *
 * Frame ownership is exact and testable (`stage.js#createFrameReceiver`): the preload calls
 * `getVideoFrame()`, uploads it, closes the frame, and releases the main-process reference once.
 * The stage never receives pixels over IPC; only names, numbers and control lines cross.
 */
const { contextBridge, ipcRenderer, sharedTexture } = require('electron');
const { CONTEXT_ATTRIBUTES, createStage, createFrameReceiver } = require('./stage.js');

let textureReceiverRegistered = false;
let textureFrames = 0;
/** The WebGL stage and the one-shot frame consumer; both live for the window's lifetime. */
let stage = null;
let receiveFrame = null;
let stopping = false;
let startupError = '';

function stageStats() {
  if (stage === null) return null;
  try {
    return stage.stats();
  } catch {
    return null;
  }
}

function disposeStage() {
  if (stage !== null) {
    try {
      stage.dispose();
    } catch {
      /* a lost context may already have released everything */
    }
    stage = null;
  }
  receiveFrame = null;
}

/** Create the stage once the page's canvas exists. Returns `{ ok, registered, code?, error? }`. */
async function startStage() {
  if (stopping) return { ok: false, registered: false, code: 'WINDOW_FAILED', error: 'window is stopping' };
  if (stage !== null) {
    return { ok: true, registered: textureReceiverRegistered, stats: stageStats() };
  }
  if (typeof sharedTexture?.setSharedTextureReceiver !== 'function') {
    return {
      ok: false,
      registered: false,
      code: 'SHARED_TEXTURE_UNAVAILABLE',
      error: 'sharedTexture.setSharedTextureReceiver is not available in this runtime',
    };
  }
  const canvas = typeof document === 'undefined' ? null : document.getElementById('stage');
  if (canvas === null) {
    return { ok: false, registered: false, code: 'WINDOW_FAILED', error: 'canvas #stage missing' };
  }
  let gl = null;
  try {
    // premultipliedAlpha:true is part of the fixed compositing contract (see stage.js).
    gl = canvas.getContext('webgl', CONTEXT_ATTRIBUTES)
      ?? canvas.getContext('experimental-webgl', CONTEXT_ATTRIBUTES);
  } catch (error) {
    startupError = String(error?.message ?? error);
  }
  if (gl === null) {
    return {
      ok: false,
      registered: false,
      code: 'GPU_INIT_FAILED',
      error: startupError || 'WebGL context unavailable',
    };
  }
  try {
    // Frames are drained on the next animation frame and only the newest one is kept: a burst of
    // deliveries becomes one upload/draw, so a slow compositor can never accumulate latency.
    // The timer is a watchdog only: if rAF is throttled (occluded window) the newest frame still
    // reaches the GPU instead of freezing the last image forever.
    const schedule = (fn) => {
      let ran = false;
      const run = () => {
        if (ran) return;
        ran = true;
        fn();
      };
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
      setTimeout(run, 250);
    };
    stage = createStage({
      gl,
      canvas,
      now: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
      schedule,
      // Stage-2 diagnostics: fps/dropped/resized/alphaMode, already throttled to <= 1 Hz inside
      // the stage. The main process forwards one structured `spout.stage2` line per report.
      onStage2: (payload) => {
        if (!stopping) ipcRenderer.send('layer:texture:stage2', payload);
      },
      // Receiver-side alpha sample: `{total,alphaZero,alphaOpaque,alphaPartial}` plus the frame
      // size, already throttled to <= 1 Hz inside the stage. The main process turns an all-opaque
      // sample into `spout.alpha.opaque-frame` and forwards everything else as `spout.alpha.sample`.
      onAlpha: (sample) => {
        if (!stopping) ipcRenderer.send('layer:texture:alpha', sample);
      },
      onHealth: (stats) => {
        if (!stopping) ipcRenderer.send('layer:texture:stats', stats);
      },
      onFrame: () => {},
    });
    stage.resize(
      Math.max(1, Math.round(canvas.clientWidth || window.innerWidth || 1)),
      Math.max(1, Math.round(canvas.clientHeight || window.innerHeight || 1)),
    );
    stage.start();
    receiveFrame = createFrameReceiver({
      stage,
      // Latest-wins: the frame is closed by the stage after the drain (or when superseded).
      coalesce: true,
      onError: (error, meta) => {
        if (stopping) return;
        // A bad frame is dropped and counted; it must not turn into layer:error (which quits).
        ipcRenderer.send('layer:texture:error', {
          code: String(error?.code ?? 'TEXTURE_UPLOAD_FAILED'),
          error: String(error?.message ?? error),
          width: Number(meta?.width ?? 0),
          height: Number(meta?.height ?? 0),
        });
      },
    });
  } catch (error) {
    disposeStage();
    return {
      ok: false,
      registered: false,
      code: String(error?.code ?? 'GPU_INIT_FAILED'),
      error: String(error?.message ?? error),
    };
  }

  try {
    sharedTexture.setSharedTextureReceiver(async (data, meta) => {
      if (stopping || stage === null || receiveFrame === null) {
        try {
          data?.importedSharedTexture?.release?.();
        } catch {
          /* nothing left to release */
        }
        return;
      }
      textureFrames += 1;
      const result = receiveFrame(data?.importedSharedTexture, meta ?? {});
      ipcRenderer.send('layer:texture:frame', {
        frames: textureFrames,
        drawn: result?.drawn === true,
        queued: result?.queued === true,
        width: Number(meta?.width ?? 0),
        height: Number(meta?.height ?? 0),
        at: Date.now(),
      });
    });
  } catch (error) {
    disposeStage();
    return {
      ok: false,
      registered: false,
      code: 'SHARED_TEXTURE_REGISTER_FAILED',
      error: String(error?.message ?? error),
    };
  }

  textureReceiverRegistered = true;
  try {
    const ack = await ipcRenderer.invoke('layer:texture:receiver-ready', { frames: textureFrames });
    return { ok: ack?.ok === true, registered: true, code: ack?.code ?? '', stats: stageStats() };
  } catch (error) {
    return {
      ok: false,
      registered: true,
      code: 'SHARED_TEXTURE_REGISTER_FAILED',
      error: String(error?.message ?? error),
    };
  }
}

/** Release GL objects and both stage timers. Called by the page or by main's stop line. */
function stopStage() {
  if (stopping) return { ok: true, stopped: false };
  stopping = true;
  disposeStage();
  textureReceiverRegistered = false;
  return { ok: true, stopped: true };
}

function resizeStage(width, height) {
  if (stage === null || stopping) return { ok: false };
  stage.resize(width, height);
  return { ok: true, stats: stageStats() };
}

contextBridge.exposeInMainWorld('spoutLayer', {
  /** Report readiness. Phase 0/1 require `registered:true` for waiting-sender/receiver reports. */
  reportReady: (info) => ipcRenderer.send('layer:ready', info ?? {}),
  /** Report a renderer-side failure; main prints an error line and exits. */
  reportError: (payload) => ipcRenderer.send('layer:error', payload ?? {}),
  /** Register the native Spout receiver (main process); resolves with its status. */
  registerReceiver: (info) => ipcRenderer.invoke('layer:receiver:register', info ?? {}),
  /** Poll whether the registered receiver has found its sender / surface size. */
  receiverStatus: () => ipcRenderer.invoke('layer:receiver:status'),
  /** Create the WebGL stage and register Electron's renderer-side shared-texture receiver. */
  startStage,
  /** Kept for phase-0 callers: starting the stage is what registers the texture receiver now. */
  registerSharedTextureReceiver: startStage,
  /** Release the texture, program, shaders and timers. */
  stopStage,
  /** Match the canvas drawing buffer to the fixed window. */
  resizeStage,
  /** Last fps/size snapshot (no textures, no pixels). */
  stageStats: () => stageStats(),
  /** Phase-2 edit mode will use this; the main process already owns the single setBounds path. */
  setBounds: (bounds) => ipcRenderer.send('layer:set-bounds', bounds ?? {}),
  /** Edit-mode pointer deltas; the main process applies them to the one setBounds path. */
  editDrag: (dx, dy, done = false) => ipcRenderer.send('layer:edit:drag', { dx, dy, done: done === true }),
  editResize: (dx, dy, done = false) => ipcRenderer.send('layer:edit:resize', { dx, dy, done: done === true }),
  /** Escape leaves edit mode (the window returns to click-through). */
  exitEdit: () => ipcRenderer.send('layer:edit:escape'),
  /** Subscribe to edit-mode changes; returns an unsubscribe function. */
  onEditMode: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, payload) => callback(payload ?? {});
    ipcRenderer.on('layer:edit:mode', listener);
    return () => ipcRenderer.removeListener('layer:edit:mode', listener);
  },
});

// Edit mode: the main process applies the window rectangle and reports its exact new size. The
// canvas drawing buffer and GL viewport follow it, so a resized window never stretches the frame.
ipcRenderer.on('layer:edit:viewport', (_event, payload) => {
  const width = Math.max(1, Math.round(Number(payload?.width) || 0));
  const height = Math.max(1, Math.round(Number(payload?.height) || 0));
  if (width > 0 && height > 0) resizeStage(width, height);
});
// Explicit release on unload. The renderer's `beforeunload` cannot call back into the isolated
// world reliably, so the preload owns the final `dispose()`.
window.addEventListener('beforeunload', stopStage);
window.addEventListener('pagehide', stopStage);
ipcRenderer.on('layer:stop', stopStage);
