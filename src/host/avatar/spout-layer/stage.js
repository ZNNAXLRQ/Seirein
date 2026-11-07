/**
 * Spout layer stage — the GPU half of the display window (phase 1 + phase 2).
 *
 * This module owns one WebGL1 context on the layer canvas, one texture, one full-screen quad and
 * the frame-rate/health counters. It is deliberately free of Electron and DOM specifics so the
 * same code runs in the preload (which owns `sharedTexture.setSharedTextureReceiver`) and under
 * the Node test harness with a fake GL.
 *
 * Phase 2 adds the stability half: a 1 s sliding-window fps meter (min/avg/max), a latest-wins
 * input slot that coalesces bursts instead of queuing them, a transparent placeholder after one
 * stale second, and a completeness-checked framebuffer that is rebuilt with the texture on a
 * sender resize.
 *
 * Compositing contract (design doc §1.3/§4, fixed constants — do not "improve" them):
 *   canvas context   premultipliedAlpha:true   (the canvas commits premultiplied pixels)
 *   texture upload   UNPACK_PREMULTIPLY_ALPHA_WEBGL:false  (the source is already premultiplied)
 *   blend            ONE / ONE_MINUS_SRC_ALPHA
 *   shader           subtract the observed transparent background contribution; preserve alpha
 *
 * With transparent capture, VTS can retain its background RGB even at alpha=0. Its colour buffer
 * then contains foreground*a + background*(1-a). Recover premultiplied foreground by subtracting
 * the uniform background observed in fully transparent pixels. Black backgrounds remain unchanged;
 * opaque pixels are never colour-keyed. Multiplying RGB by alpha again would darken valid edges.
 */
'use strict';

/** WebGL context attributes used by the layer canvas; the test asserts these are the constants. */
const CONTEXT_ATTRIBUTES = Object.freeze({
  alpha: true,
  premultipliedAlpha: true,
  antialias: false,
  depth: false,
  stencil: false,
  preserveDrawingBuffer: false,
  desynchronized: true,
});

/**
 * One quad in clip space. UVs put source row 0 on the top edge of the window: WebGL's texture
 * origin is bottom-left while video-style sources upload row 0 first, so the flip is in the UVs
 * (no UNPACK_FLIP_Y_WEBGL pixel-store state to keep in sync with the premultiply flag).
 */
const QUAD_VERTICES = Object.freeze([
  // x,    y,   u, v
  -1, -1, 0, 1,
  1, -1, 1, 1,
  -1, 1, 0, 0,
  1, 1, 1, 0,
]);

const VERTEX_SHADER = [
  'attribute vec2 a_position;',
  'attribute vec2 a_uv;',
  'uniform vec2 u_scale;',
  'uniform vec2 u_offset;',
  'varying vec2 v_uv;',
  'void main() {',
  '  v_uv = a_uv;',
  '  gl_Position = vec4(a_position * u_scale + u_offset, 0.0, 1.0);',
  '}',
].join('\n');

const FRAGMENT_SHADER = [
  'precision mediump float;',
  'uniform sampler2D u_texture;',
  'uniform vec3 u_background;',
  'varying vec2 v_uv;',
  'void main() {',
  '  vec4 c = texture2D(u_texture, v_uv);',
  '  gl_FragColor = vec4(clamp(c.rgb - u_background * (1.0 - c.a), 0.0, c.a), c.a);',
  '}',
].join('\n');

const DEFAULT_FPS_WINDOW_MS = 1000;
const DEFAULT_HEALTH_INTERVAL_MS = 1000;
const DEFAULT_PLACEHOLDER_AFTER_MS = 1000;
const PLACEHOLDER_POLL_MS = 250;
/** Stage-2 diagnostics are throttled to one line per second (the health timer is also 1 Hz). */
const DEFAULT_STAGE2_INTERVAL_MS = 1000;
/**
 * Alpha diagnostics. The received texture is read back through the framebuffer that already
 * references it, at most once per second, and only every `ALPHA_SAMPLE_STRIDE`-th pixel of that
 * read is counted — the black-background question needs a distribution, not every pixel.
 */
const ALPHA_SAMPLE_STRIDE = 8;
const DEFAULT_ALPHA_SAMPLE_INTERVAL_MS = 1000;
/** `gl.getError()` value meaning "no error"; WebGL1 fixes NO_ERROR at 0. */
const GL_NO_ERROR = 0;
/**
 * Consecutive failures of the once-per-second read-back. Read failures are not transparent frames:
 * after this many in a row the probe is switched off instead of reporting more unknown samples.
 */
const ALPHA_MAX_CONSECUTIVE_READ_ERRORS = 3;
/** One readPixels transfer budget; a sender larger than this is read from a centred window. */
const ALPHA_MAX_READ_PIXELS = 4_000_000;
/** The one compositing mode this stage implements; reported verbatim in `spout.stage2`. */
const ALPHA_MODE = 'premultiplied';

/** Infer a uniform capture background only from alpha=0 pixels, never from model colours. */
function inferCaptureBackground(rgba, width, height, stride = ALPHA_SAMPLE_STRIDE) {
  let candidate = null;
  let total = 0;
  let matching = 0;
  for (let y = 0; y < height; y += stride) {
    for (let x = 0; x < width; x += stride) {
      const i = (y * width + x) * 4;
      if (rgba[i + 3] !== 0) continue;
      const rgb = [rgba[i], rgba[i + 1], rgba[i + 2]];
      candidate ??= rgb;
      total += 1;
      if (rgb.every((value, channel) => Math.abs(value - candidate[channel]) <= 2)) matching += 1;
    }
  }
  return total >= 8 && matching / total >= 0.98 ? candidate.map((value) => value / 255) : [0, 0, 0];
}
/**
 * Browser timer functions are methods of `window`: storing them on a plain object and calling
 * `timers.setInterval(...)` loses the receiver and throws "Illegal invocation" in the renderer.
 * Wrap them once so the stage works identically in the preload and under Node.
 */
const DEFAULT_TIMERS = Object.freeze({
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (id) => clearInterval(id),
});

/** Sliding-window draw-rate meter. Pure, so tests can drive it with a fake clock. */
function createFpsMeter({ now = Date.now, windowMs = DEFAULT_FPS_WINDOW_MS, capacity = 240 } = {}) {
  const times = [];
  const prune = (at) => {
    while (times.length > 0 && at - times[0] > windowMs) times.shift();
  };
  return {
    record(at = now()) {
      times.push(Number(at));
      while (times.length > capacity) times.shift();
    },
    value(at = now()) {
      prune(at);
      if (times.length < 2) return 0;
      const span = times[times.length - 1] - times[0];
      if (!(span > 0)) return 0;
      return ((times.length - 1) * 1000) / span;
    },
    /**
     * Sliding-window min/avg/max. `avg` is draw count / observed span, `min`/`max` come from the
     * individual frame intervals, so a stall or a burst is visible instead of averaged away.
     */
    stats(at = now()) {
      prune(at);
      if (times.length < 2) return { avg: 0, min: 0, max: 0, samples: times.length };
      let min = Number.POSITIVE_INFINITY;
      let max = 0;
      for (let index = 1; index < times.length; index += 1) {
        const gap = times[index] - times[index - 1];
        if (!(gap > 0)) continue;
        const rate = 1000 / gap;
        if (rate < min) min = rate;
        if (rate > max) max = rate;
      }
      const span = times[times.length - 1] - times[0];
      const avg = span > 0 ? ((times.length - 1) * 1000) / span : 0;
      return { avg, min: Number.isFinite(min) ? min : 0, max, samples: times.length };
    },
    reset() {
      times.length = 0;
    },
    get samples() {
      return times.length;
    },
  };
}

/** One decimal is what the 1 Hz health line shows; keep test values and logging identical. */
function round1(value) {
  return Math.round(Number(value) * 10) / 10;
}

/**
 * Count alpha classes on a downsampled grid of an RGBA byte buffer (readPixels order: byte 3 is
 * alpha). `total` is the number of sampled pixels, not the frame's pixel count.
 *
 * Pure so the test can feed a synthetic 0/128/255 frame and check the counts exactly; the stage
 * calls the same function on the pixels it reads back from the received texture.
 */
function countAlphaClasses(rgba, width, height, stride = ALPHA_SAMPLE_STRIDE) {
  const step = Math.max(1, Math.round(Number(stride) || ALPHA_SAMPLE_STRIDE));
  const w = Math.max(0, Math.round(Number(width) || 0));
  const h = Math.max(0, Math.round(Number(height) || 0));
  const counts = { total: 0, alphaZero: 0, alphaOpaque: 0, alphaPartial: 0 };
  if (rgba === null || rgba === undefined || w === 0 || h === 0) return counts;
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const alpha = rgba[(y * w + x) * 4 + 3];
      counts.total += 1;
      if (alpha === 0) counts.alphaZero += 1;
      else if (alpha === 255) counts.alphaOpaque += 1;
      else counts.alphaPartial += 1;
    }
  }
  return counts;
}

/**
 * The region a single readPixels may transfer. Normally the whole texture; a sender above the
 * budget is sampled from a centred window of the same aspect ratio, so the once-per-second read
 * stays bounded instead of scaling with a 4K/8K sender.
 */
function alphaReadWindow(width, height, budget = ALPHA_MAX_READ_PIXELS) {
  const w = Math.max(0, Math.round(Number(width) || 0));
  const h = Math.max(0, Math.round(Number(height) || 0));
  if (w === 0 || h === 0) return null;
  const cap = Math.max(1, Math.round(Number(budget) || ALPHA_MAX_READ_PIXELS));
  if (w * h <= cap) return { x: 0, y: 0, width: w, height: h };
  const factor = Math.sqrt(cap / (w * h));
  const windowWidth = Math.max(1, Math.floor(w * factor));
  const windowHeight = Math.max(1, Math.floor(h * factor));
  return {
    x: Math.floor((w - windowWidth) / 2),
    y: Math.floor((h - windowHeight) / 2),
    width: windowWidth,
    height: windowHeight,
  };
}

/**
 * What a received frame proves, in the terms the black-background diagnosis uses:
 *   `transparent` — some sampled pixels are alpha 0: transparent data reached the receiver;
 *   `opaque`      — every sampled pixel is alpha 255: the sender published an opaque frame;
 *   `partial`     — only semi-transparent pixels, no fully transparent one;
 *   `unknown`     — nothing was sampled.
 */
function classifyAlphaSample(sample) {
  if (sample === null || sample === undefined) return 'unknown';
  const total = Number(sample.total);
  if (!(total > 0)) return 'unknown';
  if (Number(sample.alphaOpaque) === total) return 'opaque';
  if (Number(sample.alphaZero) > 0) return 'transparent';
  if (Number(sample.alphaPartial) > 0) return 'partial';
  return 'unknown';
}

/** A GL failure that is reported with a stable code instead of an opaque TypeError. */
function stageError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = String(gl.getShaderInfoLog?.(shader) ?? '').trim();
    throw stageError('GPU_INIT_FAILED', `shader compile failed: ${log}`);
  }
  return shader;
}

/**
 * @param {object} options
 * @param {WebGLRenderingContext} options.gl
 * @param {{width:number,height:number}} [options.canvas]
 * @param {() => number} [options.now]
 * @param {{setTimeout:Function,clearTimeout:Function,setInterval:Function,clearInterval:Function}} [options.timers]
 * @param {(stats: object) => void} [options.onHealth] - 1 Hz stats callback.
 * @param {(payload: object) => void} [options.onStage2] - throttled `{fps,dropped,resized,alphaMode}`.
 * @param {(sample: object) => void} [options.onAlpha] - throttled receiver-side alpha sample.
 * @param {number} [options.alphaSampleIntervalMs] - alpha sample throttle window (default 1000 ms).
 * @param {(fn: () => void) => void} [options.schedule] - next-turn drain for coalesced frames.
 * @param {number} [options.stage2IntervalMs] - diagnostics throttle window (default 1000 ms).
 * @param {(info: object) => void} [options.onFrame] - optional per-frame callback (diagnostics).
 * @param {'contain'|'fill'} [options.fit]
 * @param {'left'|'center'|'right'} [options.anchorX]
 * @param {'top'|'center'|'bottom'} [options.anchorY]
 * @param {number} [options.zoom]
 */
function createStage(options = {}) {
  const gl = options.gl;
  if (gl === null || typeof gl !== 'object') {
    throw stageError('GPU_INIT_FAILED', 'createStage requires a WebGL context');
  }
  const canvas = options.canvas ?? null;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const timers = options.timers ?? DEFAULT_TIMERS;
  const onHealth = typeof options.onHealth === 'function' ? options.onHealth : () => {};
  const onFrame = typeof options.onFrame === 'function' ? options.onFrame : () => {};
  const onStage2 = typeof options.onStage2 === 'function' ? options.onStage2 : () => {};
  const onAlpha = typeof options.onAlpha === 'function' ? options.onAlpha : () => {};
  // With a scheduler the stage coalesces: at most one frame sits pending, a newer frame replaces
  // it. Without one `submitFrame` draws immediately, which keeps phase-1 callers synchronous.
  const schedule = typeof options.schedule === 'function' ? options.schedule : null;
  const stage2IntervalMs = Number(options.stage2IntervalMs) > 0
    ? Number(options.stage2IntervalMs)
    : DEFAULT_STAGE2_INTERVAL_MS;
  const alphaSampleIntervalMs = Number(options.alphaSampleIntervalMs) > 0
    ? Number(options.alphaSampleIntervalMs)
    : DEFAULT_ALPHA_SAMPLE_INTERVAL_MS;
  const fit = options.fit === 'fill' ? 'fill' : 'contain';
  const anchorX = options.anchorX ?? 'center';
  const anchorY = options.anchorY ?? 'bottom';
  const zoom = Number.isFinite(Number(options.zoom)) && Number(options.zoom) > 0 ? Number(options.zoom) : 1;
  const healthIntervalMs = Number(options.healthIntervalMs) > 0 ? Number(options.healthIntervalMs) : DEFAULT_HEALTH_INTERVAL_MS;
  const placeholderAfterMs = Number(options.placeholderAfterMs) > 0
    ? Number(options.placeholderAfterMs)
    : DEFAULT_PLACEHOLDER_AFTER_MS;
  const fps = createFpsMeter({ now, windowMs: options.fpsWindowMs ?? DEFAULT_FPS_WINDOW_MS });
  // A framebuffer attached to the upload texture is the allocation probe: it verifies completeness
  // after every (re)allocation and is rebuilt (old one deleted) with the texture. The phase-1 fake
  // GL does not implement FBOs, so this is capability-gated rather than unconditional.
  const fboSupported = typeof gl.createFramebuffer === 'function'
    && typeof gl.bindFramebuffer === 'function'
    && typeof gl.framebufferTexture2D === 'function'
    && typeof gl.checkFramebufferStatus === 'function'
    && typeof gl.deleteFramebuffer === 'function';

  let program = null;
  let vertexShader = null;
  let fragmentShader = null;
  let quadBuffer = null;
  let aPosition = -1;
  let aUv = -1;
  let uScale = null;
  let uOffset = null;
  let uTexture = null;
  let uBackground = null;
  let captureBackground = [0, 0, 0];

  let texture = null;
  let textureWidth = 0;
  let textureHeight = 0;
  /** Framebuffer attached to `texture`; rebuilt with it so no stale attachment survives a resize. */
  let framebuffer = null;

  let viewportWidth = 0;
  let viewportHeight = 0;
  let stableWidth = 0;
  let stableHeight = 0;
  let scale = [1, 1];
  let offset = [0, 0];

  let framesDrawn = 0;
  let uploads = 0;
  let reallocations = 0;
  /** Failed framebuffer-completeness probes; each one failed its frame and was fully reclaimed. */
  let framebufferErrors = 0;
  /** Texture reallocations after the first one: the sender's size actually changed. */
  let resized = 0;
  let dropped = 0;
  let placeholderDrawn = 0;
  let showingPlaceholder = true;
  let lastFrameAt = 0;
  /** Latest-wins input slot: at most one queued frame, so a burst can never form a backlog. */
  let pending = null;
  let drainScheduled = false;
  let lastLatencyMs = 0;
  let maxLatencyMs = 0;
  let lastStage2At = Number.NEGATIVE_INFINITY;
  /** Alpha diagnostics: the framebuffer + readPixels pair is the probe, so both must exist. */
  let alphaSupported = fboSupported && typeof gl.readPixels === 'function';
  let lastAlphaSample = null;
  let lastAlphaSampleAt = Number.NEGATIVE_INFINITY;
  let alphaSamples = 0;
  let alphaReadErrors = 0;
  /** Consecutive read failures; a successful read resets it. */
  let alphaConsecutiveReadErrors = 0;
  /** The one-shot `spout.alpha.disabled` report; the probe never reports it twice. */
  let alphaDisabledReported = false;
  let lastError = '';
  let healthTimer = null;
  let placeholderTimer = null;
  let started = false;
  let disposed = false;
  let lost = false;

  function initGl() {
    if (program !== null) return;
    if (typeof gl.isContextLost === 'function' && gl.isContextLost()) {
      lost = true;
      throw stageError('GPU_CONTEXT_LOST', 'WebGL context is lost');
    }
    vertexShader = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
    fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = String(gl.getProgramInfoLog?.(program) ?? '').trim();
      throw stageError('GPU_INIT_FAILED', `program link failed: ${log}`);
    }
    aPosition = gl.getAttribLocation(program, 'a_position');
    aUv = gl.getAttribLocation(program, 'a_uv');
    uScale = gl.getUniformLocation(program, 'u_scale');
    uOffset = gl.getUniformLocation(program, 'u_offset');
    uTexture = gl.getUniformLocation(program, 'u_texture');
    uBackground = gl.getUniformLocation(program, 'u_background');

    quadBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(QUAD_VERTICES), gl.STATIC_DRAW);
  }

  function recomputeMapping() {
    const srcW = stableWidth > 0 ? stableWidth : textureWidth;
    const srcH = stableHeight > 0 ? stableHeight : textureHeight;
    if (!(viewportWidth > 0 && viewportHeight > 0 && srcW > 0 && srcH > 0)) {
      scale = [1, 1];
      offset = [0, 0];
      return;
    }
    let drawWidth = viewportWidth;
    let drawHeight = viewportHeight;
    if (fit === 'contain') {
      const factor = Math.min(viewportWidth / srcW, viewportHeight / srcH) * zoom;
      drawWidth = srcW * factor;
      drawHeight = srcH * factor;
    }
    let drawX = 0;
    let drawY = 0;
    if (anchorX === 'center') drawX = (viewportWidth - drawWidth) / 2;
    else if (anchorX === 'right') drawX = viewportWidth - drawWidth;
    if (anchorY === 'center') drawY = (viewportHeight - drawHeight) / 2;
    else if (anchorY === 'bottom') drawY = viewportHeight - drawHeight;
    scale = [drawWidth / viewportWidth, drawHeight / viewportHeight];
    // Canvas y grows downwards; clip-space y grows upwards, so the centre is flipped here.
    offset = [
      (2 * (drawX + drawWidth / 2)) / viewportWidth - 1,
      1 - (2 * (drawY + drawHeight / 2)) / viewportHeight,
    ];
  }

  function drawQuad() {
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    // ONE / ONE_MINUS_SRC_ALPHA is the premultiplied-alpha blend. Never SRC_ALPHA here: the
    // shader already receives premultiplied RGB.
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(uTexture, 0);
    gl.uniform3f(uBackground, ...captureBackground);
    gl.uniform2f(uScale, scale[0], scale[1]);
    gl.uniform2f(uOffset, offset[0], offset[1]);
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
    if (aPosition >= 0) {
      gl.enableVertexAttribArray(aPosition);
      gl.vertexAttribPointer(aPosition, 2, gl.FLOAT, false, 16, 0);
    }
    if (aUv >= 0) {
      gl.enableVertexAttribArray(aUv);
      gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 16, 8);
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /** Detach + delete the framebuffer that references the current texture. Idempotent. */
  function releaseFramebuffer() {
    if (framebuffer === null) return false;
    try {
      gl.deleteFramebuffer(framebuffer);
    } catch {
      /* a lost context may already have freed it */
    }
    framebuffer = null;
    return true;
  }

  /**
   * Attach the candidate texture to a new framebuffer and require completeness. A driver that
   * cannot allocate a too-large sender surface fails here (`GPU_TEXTURE_INCOMPLETE` → counted as a
   * dropped frame) instead of silently sampling black for the rest of the session. The incomplete
   * framebuffer is deleted here and the caller must not commit any of its state.
   */
  function createCompleteFramebuffer(candidate, width, height) {
    if (!fboSupported) return null;
    const fbo = gl.createFramebuffer();
    let status = null;
    try {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, candidate, 0);
      status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    } catch (error) {
      try {
        gl.deleteFramebuffer(fbo);
      } catch {
        /* already gone */
      }
      throw error;
    } finally {
      // Leave the default framebuffer bound for the draw pass.
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      try {
        gl.deleteFramebuffer(fbo);
      } catch {
        /* already gone */
      }
      framebufferErrors += 1;
      throw stageError(
        'GPU_TEXTURE_INCOMPLETE',
        `texture framebuffer ${width}x${height} is incomplete: 0x${Number(status).toString(16)}`,
      );
    }
    return fbo;
  }

  function uploadFrame(source, width, height) {
    const changed = texture === null || width !== textureWidth || height !== textureHeight;
    if (changed) {
      captureBackground = [0, 0, 0];
      lastAlphaSampleAt = Number.NEGATIVE_INFINITY;
      // Release the framebuffer first: it references the texture that is about to be deleted.
      releaseFramebuffer();
      if (texture !== null) {
        // The old texture is deleted before the replacement is created: a sender resize must not
        // leave the previous allocation (or its framebuffer) alive for the lifetime of the window.
        resized += 1;
        gl.deleteTexture(texture);
        texture = null;
      }
      // Build the replacement off to the side and probe it first: nothing is committed until the
      // allocation is proven complete, so a failure is retried in full by the next frame.
      const nextTexture = gl.createTexture();
      let nextFramebuffer = null;
      try {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, nextTexture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
        nextFramebuffer = createCompleteFramebuffer(nextTexture, width, height);
      } catch (error) {
        try {
          gl.deleteTexture(nextTexture);
        } catch {
          /* a lost context may already have freed it */
        }
        throw error;
      }
      texture = nextTexture;
      framebuffer = nextFramebuffer;
      textureWidth = width;
      textureHeight = height;
      reallocations += 1;
    } else {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, source);
    }
    uploads += 1;
  }

  /**
   * Read and clear the GL error flag. No getError (the phase-1 fake GL) means NO_ERROR; a throwing
   * getError is itself a failed read (-1) rather than an uncaught diagnostics error.
   */
  function readGlError() {
    if (typeof gl.getError !== 'function') return GL_NO_ERROR;
    try {
      return Number(gl.getError()) || GL_NO_ERROR;
    } catch {
      return -1;
    }
  }

  function emitAlpha(payload) {
    try {
      onAlpha({ ...payload });
    } catch {
      /* a diagnostics consumer must never take the renderer down */
    }
  }

  /**
   * A read-back that set an error is `unknown`, never transparent. The counts stay explicit zeros
   * so no consumer can mistake them for an all-transparent frame. Three failures in a row disable
   * the probe once (rendering continues); a success resets the consecutive count.
   */
  function failAlphaRead(errorCode) {
    captureBackground = [0, 0, 0];
    alphaReadErrors += 1;
    alphaConsecutiveReadErrors += 1;
    const failure = {
      ok: false,
      reason: 'read-error',
      error: errorCode,
      total: 0,
      alphaZero: 0,
      alphaOpaque: 0,
      alphaPartial: 0,
      verdict: 'unknown',
    };
    lastAlphaSample = failure;
    emitAlpha(failure);
    if (alphaConsecutiveReadErrors >= ALPHA_MAX_CONSECUTIVE_READ_ERRORS && !alphaDisabledReported) {
      alphaDisabledReported = true;
      alphaSupported = false;
      alphaSamples = 0;
      emitAlpha({
        event: 'spout.alpha.disabled',
        cause: 'read-error',
        error: errorCode,
        alphaReadErrors,
      });
    }
    return failure;
  }

  /**
   * Receiver-side alpha evidence, at most once per `alphaSampleIntervalMs`. The uploaded texture is
   * read back through the framebuffer that already references it (no second copy, no intermediate
   * canvas), and only a downsampled grid is counted. `gl.getError()` is sampled before and after the
   * read: an error means the bytes are not evidence, so it becomes an `unknown` read-error and never
   * participates in the transparent/opaque classification.
   */
  function sampleAlphaTexture() {
    if (disposed || !alphaSupported || framebuffer === null) return null;
    if (textureWidth <= 0 || textureHeight <= 0) return null;
    const at = now();
    if (at - lastAlphaSampleAt < alphaSampleIntervalMs) return null;
    // Stamp before the read: a driver that rejects readPixels must not retry on every frame.
    lastAlphaSampleAt = at;
    const window = alphaReadWindow(textureWidth, textureHeight);
    if (window === null) return null;
    let pixels = null;
    let before = GL_NO_ERROR;
    let readError = GL_NO_ERROR;
    let readFailed = false;
    try {
      pixels = new Uint8Array(window.width * window.height * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      before = readGlError();
      gl.readPixels(window.x, window.y, window.width, window.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      const after = readGlError();
      if (before !== GL_NO_ERROR) {
        readFailed = true;
        readError = before;
      } else if (after !== GL_NO_ERROR) {
        readFailed = true;
        readError = after;
      }
    } catch (error) {
      readFailed = true;
      readError = before !== GL_NO_ERROR ? before : String(error?.code ?? 'READ_PIXELS_FAILED');
    } finally {
      try {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      } catch {
        /* the context is already lost */
      }
    }
    if (readFailed) return failAlphaRead(readError);
    captureBackground = inferCaptureBackground(pixels, window.width, window.height);
    const sample = {
      ...countAlphaClasses(pixels, window.width, window.height),
      width: textureWidth,
      height: textureHeight,
      sampledWidth: window.width,
      sampledHeight: window.height,
      at,
    };
    sample.verdict = classifyAlphaSample(sample);
    alphaConsecutiveReadErrors = 0;
    alphaSamples += 1;
    lastAlphaSample = sample;
    emitAlpha(sample);
    return sample;
  }

  /**
   * Release a frame that was handed to the queue (used when it is superseded or the stage stops).
   * The receiver hands over ownership so the VideoFrame stays readable until it is actually drawn.
   */
  function releaseHandoff(handoff) {
    if (handoff === null || handoff === undefined) return;
    try {
      handoff.release?.();
    } catch {
      /* the frame was already closed */
    }
  }

  /** Draw the one pending frame, if any, and release its handoff exactly once. */
  function drainPending() {
    if (pending === null) return false;
    const item = pending;
    pending = null;
    const latency = Math.max(0, now() - item.at);
    lastLatencyMs = latency;
    if (latency > maxLatencyMs) maxLatencyMs = latency;
    let drawn = false;
    try {
      drawn = drawFrame(item.source, item.meta) === true;
    } finally {
      releaseHandoff(item.handoff);
    }
    return drawn;
  }

  function scheduleDrain() {
    if (drainScheduled) return;
    if (schedule === null) {
      drainPending();
      return;
    }
    drainScheduled = true;
    try {
      schedule(() => {
        drainScheduled = false;
        drainPending();
      });
    } catch (error) {
      // A broken scheduler must not strand the latest frame: draw it now instead.
      drainScheduled = false;
      lastError = String(error?.message ?? error);
      drainPending();
    }
  }

  /**
   * Latest-wins ingestion for the renderer path. One slot only: while a frame is waiting for the
   * next drain, a newer frame replaces it (the old one is released and counted as dropped). A
   * burst of N frames therefore costs one upload/draw, not N, and latency cannot grow with N.
   */
  function submitFrame(source, meta = {}, handoff = null) {
    if (disposed) {
      releaseHandoff(handoff);
      return { queued: false, drawn: false, dropped: true };
    }
    if (pending !== null) {
      dropped += 1;
      releaseHandoff(pending.handoff);
    }
    pending = { source, meta: meta ?? {}, handoff, at: now() };
    const before = framesDrawn;
    scheduleDrain();
    return { queued: true, drawn: framesDrawn > before, dropped: false };
  }

  /**
   * Upload one VideoFrame-like source and draw the quad. `meta` is what the main process sent:
   * `{ width, height, stableWidth, stableHeight }`; source dimensions are the fallback.
   */
  function drawFrame(source, meta = {}) {
    if (disposed) return false;
    try {
      initGl();
      const width = Math.max(
        0,
        Math.round(Number(meta?.width ?? source?.displayWidth ?? source?.codedWidth ?? source?.width) || 0),
      );
      const height = Math.max(
        0,
        Math.round(Number(meta?.height ?? source?.displayHeight ?? source?.codedHeight ?? source?.height) || 0),
      );
      if (width <= 0 || height <= 0 || source === null || source === undefined) {
        dropped += 1;
        return false;
      }
      const nextStableWidth = Math.max(0, Math.round(Number(meta?.stableWidth) || width));
      const nextStableHeight = Math.max(0, Math.round(Number(meta?.stableHeight) || height));
      if (nextStableWidth !== stableWidth || nextStableHeight !== stableHeight) {
        stableWidth = nextStableWidth;
        stableHeight = nextStableHeight;
        recomputeMapping();
      }
      uploadFrame(source, width, height);
      // Read the first frame before drawing so background RGB never flashes on the desktop.
      sampleAlphaTexture();
      drawQuad();
      framesDrawn += 1;
      lastFrameAt = now();
      showingPlaceholder = false;
      fps.record(lastFrameAt);
      onFrame({
        drawn: true,
        width,
        height,
        stableWidth,
        stableHeight,
        drawnCount: framesDrawn,
        framebufferErrors,
        meta,
      });
      return true;
    } catch (error) {
      lastError = String(error?.message ?? error);
      dropped += 1;
      return false;
    }
  }

  /** Clear the canvas to fully transparent pixels. Safe with no sender and with no GL resources. */
  function drawPlaceholder() {
    if (disposed) return false;
    try {
      initGl();
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      placeholderDrawn += 1;
      showingPlaceholder = true;
      return true;
    } catch (error) {
      lastError = String(error?.message ?? error);
      return false;
    }
  }

  function resize(width, height) {
    if (disposed) return;
    const nextWidth = Math.max(1, Math.round(Number(width) || 0));
    const nextHeight = Math.max(1, Math.round(Number(height) || 0));
    if (canvas !== null) {
      if (canvas.width !== nextWidth) canvas.width = nextWidth;
      if (canvas.height !== nextHeight) canvas.height = nextHeight;
    }
    if (nextWidth === viewportWidth && nextHeight === viewportHeight) return;
    viewportWidth = nextWidth;
    viewportHeight = nextHeight;
    if (typeof gl.viewport === 'function') gl.viewport(0, 0, viewportWidth, viewportHeight);
    recomputeMapping();
  }

  function stats() {
    const rate = fps.stats(now());
    return {
      fps: round1(rate.avg),
      fpsMin: round1(rate.min),
      fpsMax: round1(rate.max),
      fpsSamples: rate.samples,
      width: viewportWidth,
      height: viewportHeight,
      textureWidth,
      textureHeight,
      stableWidth,
      stableHeight,
      drawn: framesDrawn,
      uploads,
      reallocations,
      /** Texture rebuilds caused by a sender size change (the first allocation is not a resize). */
      resized,
      dropped,
      /** Allocation probes that failed completeness; the frame failed and was fully reclaimed. */
      framebufferErrors,
      pending: pending !== null,
      lastLatencyMs,
      maxLatencyMs,
      alphaMode: ALPHA_MODE,
      placeholder: showingPlaceholder,
      placeholderDrawn,
      /** Last receiver-side alpha sample (null until the first throttled read). */
      alphaSample: lastAlphaSample,
      captureBackground: [...captureBackground],
      alphaSamples,
      alphaReadErrors,
      lastFrameAgeMs: framesDrawn > 0 ? Math.max(0, Math.round(now() - lastFrameAt)) : -1,
      error: lastError,
      contextLost: lost,
    };
  }

  /**
   * The `spout.stage2` payload, throttled to one report per `stage2IntervalMs` (default 1 s).
   * Returns `null` when the throttle window has not elapsed; `{ force: true }` bypasses it.
   */
  function stage2Report(reportOptions = {}) {
    if (disposed) return null;
    const force = reportOptions === true || reportOptions?.force === true;
    const at = now();
    if (!force && at - lastStage2At < stage2IntervalMs) return null;
    lastStage2At = at;
    const snapshot = stats();
    return {
      fps: snapshot.fps,
      dropped: snapshot.dropped,
      resized: snapshot.resized,
      framebufferErrors: snapshot.framebufferErrors,
      alphaMode: ALPHA_MODE,
      at,
    };
  }

  function checkPlaceholder() {
    if (disposed || showingPlaceholder) return;
    // `framesDrawn`, not `lastFrameAt > 0`: the first frame can legitimately land at t=0.
    if (framesDrawn > 0 && now() - lastFrameAt >= placeholderAfterMs) {
      drawPlaceholder();
    }
  }

  function start() {
    if (disposed || started) return false;
    // Compile/link here, not inside a caught placeholder draw: a GPU that cannot build the
    // program must surface as GPU_INIT_FAILED from startStage, not as a silently empty window.
    initGl();
    started = true;
    drawPlaceholder();
    healthTimer = timers.setInterval(() => {
      try {
        const report = stage2Report();
        if (report !== null) onStage2(report);
      } catch {
        /* a diagnostics consumer must never take the renderer down */
      }
      try {
        onHealth(stats());
      } catch {
        /* a health consumer must never take the renderer down */
      }
    }, healthIntervalMs);
    placeholderTimer = timers.setInterval(checkPlaceholder, PLACEHOLDER_POLL_MS);
    healthTimer?.unref?.();
    placeholderTimer?.unref?.();
    return true;
  }

  /** Release every GL object and stop both timers; idempotent. */
  function dispose() {
    if (disposed) return false;
    disposed = true;
    if (healthTimer !== null) {
      timers.clearInterval(healthTimer);
      healthTimer = null;
    }
    if (placeholderTimer !== null) {
      timers.clearInterval(placeholderTimer);
      placeholderTimer = null;
    }
    // A frame still waiting for its drain is released now: nobody will ever draw it.
    if (pending !== null) {
      releaseHandoff(pending.handoff);
      pending = null;
    }
    try {
      releaseFramebuffer();
      if (texture !== null) gl.deleteTexture(texture);
      if (quadBuffer !== null) gl.deleteBuffer(quadBuffer);
      if (program !== null) gl.deleteProgram(program);
      if (vertexShader !== null) gl.deleteShader(vertexShader);
      if (fragmentShader !== null) gl.deleteShader(fragmentShader);
      // Ask the GPU process to drop the context as well; deleting objects is not enough for the
      // compositor to release its backing surface on every driver.
      gl.getExtension?.('WEBGL_lose_context')?.loseContext?.();
    } catch {
      /* a lost context may already have freed everything */
    }
    texture = null;
    quadBuffer = null;
    program = null;
    vertexShader = null;
    fragmentShader = null;
    fps.reset();
    return true;
  }

  return {
    drawFrame,
    submitFrame,
    drawPlaceholder,
    resize,
    start,
    dispose,
    stats,
    stage2Report,
    get disposed() {
      return disposed;
    },
    get texture() {
      return texture;
    },
    get framebuffer() {
      return framebuffer;
    },
  };
}

/**
 * Consume one `importedSharedTexture` delivered by `sharedTexture.setSharedTextureReceiver`.
 *
 * The renderer owns the `VideoFrame` (`getVideoFrame()` → upload → `close()`), and the main
 * process's duplicated reference (`release()`). Both happen exactly once, even when the upload
 * throws, so a bad frame can never leak a handle.
 *
 * With `coalesce:true` the frame is handed to the stage's latest-wins slot instead of being drawn
 * synchronously. Ownership moves with it: the stage releases the frame after the drain, or
 * immediately when a newer frame supersedes it. Nothing is ever left queued.
 */
function createFrameReceiver({ stage, onFrame, onError, coalesce = false } = {}) {
  if (stage === null || typeof stage?.drawFrame !== 'function') {
    throw stageError('GPU_INIT_FAILED', 'createFrameReceiver requires a stage');
  }
  const canCoalesce = coalesce === true && typeof stage?.submitFrame === 'function';
  let received = 0;
  return function receiveFrame(imported, meta = {}) {
    received += 1;
    let frame = null;
    let handedOff = false;
    const release = () => {
      try {
        frame?.close?.();
      } catch {
        /* frame already closed */
      }
      try {
        imported?.release?.();
      } catch {
        /* main already released its reference */
      }
    };
    try {
      if (imported === null || imported === undefined || typeof imported.getVideoFrame !== 'function') {
        throw stageError('IMPORT_INVALID', 'imported shared texture has no getVideoFrame()');
      }
      frame = imported.getVideoFrame();
      if (frame === null || frame === undefined) {
        throw stageError('IMPORT_INVALID', 'getVideoFrame() returned no frame');
      }
      if (canCoalesce) {
        const submitted = stage.submitFrame(frame, meta, { release });
        handedOff = true;
        onFrame?.({ received, drawn: submitted?.drawn === true, queued: submitted?.queued === true, meta });
        return { ok: true, drawn: submitted?.drawn === true, queued: submitted?.queued === true };
      }
      const drawn = stage.drawFrame(frame, meta) === true;
      onFrame?.({ received, drawn, meta });
      return { ok: true, drawn };
    } catch (error) {
      if (typeof onError === 'function') {
        try {
          onError(error, meta);
        } catch {
          /* an error reporter must not mask the original failure */
        }
      }
      return { ok: false, error: String(error?.message ?? error), code: String(error?.code ?? '') };
    } finally {
      if (!handedOff) release();
    }
  };
}

module.exports = {
  ALPHA_MODE,
  ALPHA_SAMPLE_STRIDE,
  CONTEXT_ATTRIBUTES,
  QUAD_VERTICES,
  VERTEX_SHADER,
  FRAGMENT_SHADER,
  alphaReadWindow,
  classifyAlphaSample,
  countAlphaClasses,
  inferCaptureBackground,
  createFpsMeter,
  createStage,
  createFrameReceiver,
};
