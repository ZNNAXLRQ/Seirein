/**
 * Mouse attention source: the user's cursor is the ONE target/bearing a target- or
 * direction-dependent motion may use.
 *
 * The source is deliberately tiny and synchronous per sample:
 *   - Win32 `GetCursorPos` at ~4 Hz through koffi (no native module beyond the existing one);
 *   - the avatar window centre is the origin: the real VTS rectangle when the host knows it,
 *     otherwise the saved layer rectangle, otherwise the screen centre;
 *   - a cursor outside every screen is `null`, never a clamped, invented direction.
 *
 * Nothing is persisted: the source keeps the CURRENT sample only, so there is no coordinate
 * history. Privacy pauses sampling and clears the sample; a read failure is `verified:false`
 * with no coordinates, never a fabricated target.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export const CURSOR_ATTENTION_SOURCE = 'cursor';
/** 4 Hz: enough for an eye/head target, cheap enough for a background plugin. */
export const ATTENTION_SAMPLE_MS = 250;

const SM_XVIRTUALSCREEN = 76;
const SM_YVIRTUALSCREEN = 77;
const SM_CXVIRTUALSCREEN = 78;
const SM_CYVIRTUALSCREEN = 79;
const SM_CXSCREEN = 0;
const SM_CYSCREEN = 1;
/** DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2: physical pixels for cursor and screen. */
const DPI_PER_MONITOR_AWARE_V2 = -4;

const clampSigned = (value) => Math.min(1, Math.max(-1, value));
const round6 = (value) => Math.round(value * 1e6) / 1e6;

let win32 = null;
let win32Loaded = false;

/**
 * Load user32 once. A missing koffi/user32 is not an exception: every reader then returns null,
 * which is exactly the "no cursor available" state the caller must display honestly.
 */
function loadWin32() {
  if (win32Loaded) return win32;
  win32Loaded = true;
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    const point = koffi.struct('SeireinAttentionPoint', { x: 'long', y: 'long' });
    win32 = {
      getCursorPos: user32.func('GetCursorPos', 'bool', [koffi.out(koffi.pointer(point))]),
      getSystemMetrics: user32.func('GetSystemMetrics', 'int', ['int']),
      // Optional: the host usually runs DPI-unaware, while the VTS/layer rectangles are physical.
      setThreadDpi: (() => {
        try {
          return user32.func('SetThreadDpiAwarenessContext', 'intptr_t', ['intptr_t']);
        } catch {
          return null;
        }
      })(),
    };
  } catch {
    win32 = null;
  }
  return win32;
}

/**
 * Run one synchronous Win32 read under a physical-pixel DPI context, then restore the previous
 * context. Restoring immediately keeps this side effect off every other host path.
 */
function withPhysicalDpi(run) {
  const api = loadWin32();
  if (api === null) return run(null);
  let previous = 0;
  if (api.setThreadDpi !== null) {
    try {
      previous = api.setThreadDpi(DPI_PER_MONITOR_AWARE_V2);
    } catch {
      previous = 0;
    }
  }
  try {
    return run(api);
  } finally {
    if (api.setThreadDpi !== null && previous !== 0) {
      try {
        api.setThreadDpi(previous);
      } catch {
        /* the OS call is best effort: a failed restore never breaks a sample */
      }
    }
  }
}

/** Default cursor reader: physical screen pixels, or null on any failure. */
export function readCursorWin32() {
  return withPhysicalDpi((api) => {
    if (api === null) return null;
    try {
      const point = { x: 0, y: 0 };
      if (api.getCursorPos(point) !== true) return null;
      const x = Number(point.x);
      const y = Number(point.y);
      return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
    } catch {
      return null;
    }
  });
}

/** Default screen rectangle: the virtual screen (so a second monitor is still "on screen"). */
export function readScreenWin32() {
  return withPhysicalDpi((api) => {
    if (api === null) return null;
    try {
      const left = Number(api.getSystemMetrics(SM_XVIRTUALSCREEN));
      const top = Number(api.getSystemMetrics(SM_YVIRTUALSCREEN));
      const width = Number(api.getSystemMetrics(SM_CXVIRTUALSCREEN));
      const height = Number(api.getSystemMetrics(SM_CYVIRTUALSCREEN));
      if ([left, top, width, height].every(Number.isFinite) && width > 0 && height > 0) {
        return { x: left, y: top, width, height };
      }
      const primaryWidth = Number(api.getSystemMetrics(SM_CXSCREEN));
      const primaryHeight = Number(api.getSystemMetrics(SM_CYSCREEN));
      if (!(primaryWidth > 0) || !(primaryHeight > 0)) return null;
      return { x: 0, y: 0, width: primaryWidth, height: primaryHeight };
    } catch {
      return null;
    }
  });
}

/** `{x,y,w,h}` / `{left,top,width,height}` → `{x,y,width,height}`, or null. */
export function normalizeAttentionRect(value) {
  if (value === null || typeof value !== 'object') return null;
  const x = Number(value.x ?? value.left);
  const y = Number(value.y ?? value.top);
  const width = Number(value.width ?? value.w);
  const height = Number(value.height ?? value.h);
  if (![x, y, width, height].every(Number.isFinite)) return null;
  if (width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

/**
 * Project a cursor point into the avatar's normalized target space.
 *
 * `anchor` is the avatar window/drawing rectangle; its centre is (0,0) and its half extent is
 * ±1. Without an anchor the whole screen is the frame. A cursor outside `screen` returns null:
 * an off-screen pointer must never become a clamped edge direction.
 *
 * @param {{x:number,y:number}|null} cursor
 * @param {{x?:number,left?:number,y?:number,top?:number,width:number,height:number}|null} anchor
 * @param {{x?:number,left?:number,y?:number,top?:number,width:number,height:number}|null} screen
 * @returns {{x:number,y:number}|null}
 */
export function projectCursorTarget(cursor, anchor, screen = null) {
  const pointX = Number(cursor?.x);
  const pointY = Number(cursor?.y);
  if (!Number.isFinite(pointX) || !Number.isFinite(pointY)) return null;
  const screenRect = normalizeAttentionRect(screen);
  if (screenRect !== null) {
    const outside = pointX < screenRect.x
      || pointX > screenRect.x + screenRect.width
      || pointY < screenRect.y
      || pointY > screenRect.y + screenRect.height;
    if (outside) return null;
  }
  const origin = normalizeAttentionRect(anchor) ?? screenRect;
  if (origin === null) return null;
  const halfWidth = origin.width / 2;
  const halfHeight = origin.height / 2;
  if (!(halfWidth > 0) || !(halfHeight > 0)) return null;
  const centreX = origin.x + halfWidth;
  const centreY = origin.y + halfHeight;
  // Screen y grows downward; the motion space uses +y = up (looking toward the cursor).
  return {
    x: round6(clampSigned((pointX - centreX) / halfWidth)),
    y: round6(clampSigned((centreY - pointY) / halfHeight)),
  };
}

const EMPTY_ATTENTION = Object.freeze({
  source: CURSOR_ATTENTION_SOURCE,
  x: null,
  y: null,
  at: null,
  verified: false,
});

const copyAttention = (value) => ({
  source: value.source,
  x: value.x,
  y: value.y,
  at: value.at,
  verified: value.verified,
});

/**
 * Create the cursor attention source.
 *
 * @param {object} [options]
 * @param {() => ({x:number,y:number}|null)} [options.readCursor] - native reader (fake in tests)
 * @param {() => ({x:number,y:number,width:number,height:number}|null)} [options.readScreen]
 * @param {(() => ({x:number,y:number,width:number,height:number}|null))|null} [options.readAnchor]
 * @param {number} [options.intervalMs] - sample period, default 4 Hz
 * @param {() => number} [options.now]
 * @param {(sample: {source:string,x:number|null,y:number|null,at:number|null,verified:boolean}) => void} [options.onSample]
 */
export function createCursorAttentionSource(options = {}) {
  const {
    readCursor = options.getCursorPos ?? readCursorWin32,
    readScreen = options.getScreen ?? readScreenWin32,
    readAnchor = options.getAnchor ?? null,
    intervalMs = ATTENTION_SAMPLE_MS,
    now = Date.now,
    onSample = null,
  } = options;
  const period = Number.isFinite(intervalMs) && intervalMs > 0
    ? Math.max(50, Math.round(intervalMs))
    : ATTENTION_SAMPLE_MS;
  const clock = typeof now === 'function' ? now : Date.now;
  let timer = null;
  let privacy = false;
  let anchorOverride = null;
  let current = copyAttention(EMPTY_ATTENTION);

  const call = (reader) => {
    if (typeof reader !== 'function') return null;
    try {
      return reader();
    } catch {
      return null;
    }
  };

  const publish = (next) => {
    current = copyAttention(next);
    if (typeof onSample === 'function') {
      try {
        onSample(copyAttention(current));
      } catch {
        /* a throwing consumer must never stop sampling */
      }
    }
    return copyAttention(current);
  };

  /** One synchronous read. Privacy returns the frozen empty sample and never asks the OS. */
  function sample() {
    if (privacy) return copyAttention(current);
    const at = Number(clock());
    const cursor = call(readCursor);
    if (cursor === null || cursor === undefined) {
      return publish({ ...EMPTY_ATTENTION, at });
    }
    const screen = normalizeAttentionRect(call(readScreen));
    const anchor = anchorOverride ?? normalizeAttentionRect(call(readAnchor));
    const target = projectCursorTarget(cursor, anchor, screen);
    if (target === null) return publish({ ...EMPTY_ATTENTION, at });
    return publish({
      source: CURSOR_ATTENTION_SOURCE,
      x: target.x,
      y: target.y,
      at: Number.isFinite(at) ? at : null,
      verified: true,
    });
  }

  function stop() {
    if (timer !== null) clearInterval(timer);
    timer = null;
  }

  function start() {
    if (privacy) return snapshot();
    if (timer !== null) return snapshot();
    sample();
    timer = setInterval(sample, period);
    timer.unref?.();
    return snapshot();
  }

  function snapshot() {
    return copyAttention(current);
  }

  /**
   * Privacy pauses the source: no timer, no read, and the current target is cleared. Actions are
   * not touched (the host's avatar runtime keeps ticking); only the target stops being updated.
   */
  function setPrivacy(on) {
    const next = on === true;
    if (next === privacy && (next === false ? timer !== null : timer === null)) return snapshot();
    privacy = next;
    if (privacy) {
      stop();
      publish(EMPTY_ATTENTION);
    } else {
      start();
    }
    return snapshot();
  }

  /** Cache the avatar rectangle the host read from the real window. */
  function setAnchor(rect) {
    anchorOverride = normalizeAttentionRect(rect);
    return snapshot();
  }

  return {
    start,
    stop,
    sample,
    snapshot,
    setPrivacy,
    setAnchor,
    get running() {
      return timer !== null;
    },
    get privacy() {
      return privacy;
    },
  };
}

export const createAttentionSource = createCursorAttentionSource;
