/**
 * Phase 2 — transparent compositing, frame-rate stability and resize resource discipline.
 *
 * Everything runs against a fake WebGL context, fake VideoFrames and a fake clock; no Electron, no
 * real GPU. Cases 1-7 are the original acceptance list from the migration plan; cases 8-10 pin the
 * framebuffer-allocation state machine (a failed probe must never look like success):
 *
 *   1. a premultiplied semi-transparent edge composites over a bright background without a black
 *      or white fringe (the classic double-premultiply / straight-alpha bugs);
 *   2. the blend is exactly ONE / ONE_MINUS_SRC_ALPHA and the texture upload never premultiplies
 *      again (UNPACK_PREMULTIPLY_ALPHA_WEBGL=false, pass-through shader);
 *   3. fully transparent source pixels stay alpha=0 after compositing (the previous frame is
 *      cleared, not left behind);
 *   4. 60 frames on a 60 Hz fake clock report fps≈60 with dropped=0 and a throttled stage-2
 *      diagnostic;
 *   5. a 10-frame burst is coalesced to its newest frame: dropped>0, one draw, latency does not
 *      grow with the burst size;
 *   6. a sender size change rebuilds the texture, deletes the old texture exactly once and
 *      releases the old framebuffer;
 *   7. with no frames for one second the stage shows a fully transparent placeholder once, never
 *      re-draws the stale frame and never flickers by clearing again.
 *   8. an incomplete framebuffer fails the frame, deletes the probe FBO and its texture and commits
 *      no texture size or framebuffer;
 *   9. a same-size frame after the driver recovers reallocates in full and draws (no stuck state);
 *  10. repeated incomplete allocations never go through texSubImage2D and never grow framesDrawn.
 *
 * Cases 11-13 are the black-background diagnosis (2026-11-06): the received texture is sampled for
 * alpha (0 / partial / 255) at most once a second, the presentation attributes that decide whether
 * that alpha survives to the screen are pinned, and an all-opaque *sampled set* is reported as
 * `spout.alpha.opaque-frame` with `scope:"sampled"` only — this layer has no chroma-key fallback.
 *
 * Cases 14-16 pin read-error handling: a GL error from the read is `unknown` (never transparent),
 * is counted in `alphaReadErrors`, and three consecutive failures disable the probe once while
 * rendering continues. A clean read is still classified normally.
 *
 * Run: node --test test/spout-stage2.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const {
  ALPHA_MODE,
  ALPHA_SAMPLE_STRIDE,
  CONTEXT_ATTRIBUTES,
  FRAGMENT_SHADER,
  VERTEX_SHADER,
  alphaReadWindow,
  classifyAlphaSample,
  countAlphaClasses,
  inferCaptureBackground,
  createFrameReceiver,
  createStage,
} = require('../src/host/avatar/spout-layer/stage.js');
const {
  WINDOW_PRESENTATION,
  WINDOW_WEB_PREFERENCES,
  alphaDiagnostic,
  applyWindowPresentation,
} = require('../src/host/avatar/spout-layer/main.js');

test('material reset cannot turn the transparent window white', () => {
  let background = '#00000000';
  const calls = [];
  applyWindowPresentation({
    setBackgroundMaterial(material) {
      calls.push(['material', material]);
      background = '#FFFFFF';
    },
    setBackgroundColor(color) {
      calls.push(['color', color]);
      background = color;
    },
  });
  assert.deepEqual(calls, [['material', 'none'], ['color', '#00000000']]);
  assert.equal(background, '#00000000');
});

test('unsupported material API still applies a transparent background', () => {
  let background = '#FFFFFF';
  applyWindowPresentation({
    setBackgroundMaterial() { throw new Error('unsupported'); },
    setBackgroundColor(color) { background = color; },
  });
  assert.equal(background, '#00000000');
});

const layerRoot = new URL('../src/host/avatar/spout-layer/', import.meta.url);

/** Deterministic timer queue: `tick(ms)` advances the clock and runs due callbacks. */
function createFakeTimers() {
  let now = 0;
  let sequence = 0;
  const active = new Map();
  const schedule = (fn, delay, interval) => {
    sequence += 1;
    const period = Math.max(0, Math.round(Number(delay) || 0));
    active.set(sequence, { at: now + period, fn, interval, period });
    return sequence;
  };
  return {
    now: () => now,
    setTimeout: (fn, delay) => schedule(fn, delay, false),
    clearTimeout: (id) => active.delete(id),
    setInterval: (fn, delay) => schedule(fn, delay, true),
    clearInterval: (id) => active.delete(id),
    tick(ms) {
      const end = now + Math.max(0, Number(ms) || 0);
      for (;;) {
        let next = null;
        for (const [id, timer] of active) {
          if (timer.at <= end && (next === null || timer.at < next.timer.at)) next = { id, timer };
        }
        if (next === null) break;
        now = next.timer.at;
        if (next.timer.interval) next.timer.at = now + Math.max(1, next.timer.period);
        else active.delete(next.id);
        next.timer.fn();
      }
      now = end;
    },
    activeCount: () => active.size,
  };
}

/** Fake WebGL1 context with the framebuffer calls the stage's allocation probe uses. */
function createFakeGl({ fbo = true, framebufferStatus = null, readPixels = null, getError = null } = {}) {
  const calls = [];
  const deletedTextures = [];
  const deletedFramebuffers = [];
  const createdFramebuffers = [];
  let sequence = 0;
  const record = (name) => (...args) => {
    calls.push({ name, args });
  };
  const gl = {
    VERTEX_SHADER: 0x8b31,
    FRAGMENT_SHADER: 0x8b30,
    COMPILE_STATUS: 0x8b81,
    LINK_STATUS: 0x8b82,
    ARRAY_BUFFER: 0x8892,
    STATIC_DRAW: 0x88e4,
    FLOAT: 0x1406,
    TRIANGLE_STRIP: 0x0005,
    TEXTURE_2D: 0x0de1,
    RGBA: 0x1908,
    UNSIGNED_BYTE: 0x1401,
    TEXTURE0: 0x84c0,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_MAG_FILTER: 0x2800,
    LINEAR: 0x2601,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    CLAMP_TO_EDGE: 0x812f,
    COLOR_BUFFER_BIT: 0x4000,
    BLEND: 0x0be2,
    DEPTH_TEST: 0x0b71,
    CULL_FACE: 0x0b44,
    ONE: 1,
    ONE_MINUS_SRC_ALPHA: 0x0303,
    SRC_ALPHA: 0x0302,
    UNPACK_FLIP_Y_WEBGL: 0x9240,
    UNPACK_PREMULTIPLY_ALPHA_WEBGL: 0x9241,
    FRAMEBUFFER: 0x8d40,
    COLOR_ATTACHMENT0: 0x8ce0,
    FRAMEBUFFER_COMPLETE: 0x8cd5,
    FRAMEBUFFER_UNSUPPORTED: 0x8cd6,
    NO_ERROR: 0,
    INVALID_OPERATION: 0x0502,
  };
  gl.calls = calls;
  gl.deletedTextures = deletedTextures;
  gl.deletedFramebuffers = deletedFramebuffers;
  gl.createdFramebuffers = createdFramebuffers;
  gl.createShader = (type) => ({ kind: 'shader', type });
  gl.shaderSource = record('shaderSource');
  gl.compileShader = record('compileShader');
  gl.getShaderParameter = () => true;
  gl.getShaderInfoLog = () => '';
  gl.createProgram = () => ({ kind: 'program' });
  gl.attachShader = record('attachShader');
  gl.linkProgram = record('linkProgram');
  gl.getProgramParameter = () => true;
  gl.getProgramInfoLog = () => '';
  gl.getAttribLocation = (_program, name) => (name === 'a_position' ? 0 : 1);
  gl.getUniformLocation = (_program, name) => ({ name });
  gl.createBuffer = () => ({ kind: 'buffer' });
  gl.bindBuffer = record('bindBuffer');
  gl.bufferData = record('bufferData');
  gl.createTexture = () => {
    sequence += 1;
    return { kind: 'texture', id: sequence };
  };
  gl.bindTexture = record('bindTexture');
  gl.texParameteri = record('texParameteri');
  gl.pixelStorei = record('pixelStorei');
  gl.texImage2D = record('texImage2D');
  gl.texSubImage2D = record('texSubImage2D');
  gl.activeTexture = record('activeTexture');
  gl.viewport = record('viewport');
  gl.clearColor = record('clearColor');
  gl.clear = record('clear');
  gl.blendFunc = record('blendFunc');
  gl.enable = record('enable');
  gl.disable = record('disable');
  gl.useProgram = record('useProgram');
  gl.uniform1i = record('uniform1i');
  gl.uniform2f = record('uniform2f');
  gl.uniform3f = record('uniform3f');
  gl.enableVertexAttribArray = record('enableVertexAttribArray');
  gl.vertexAttribPointer = record('vertexAttribPointer');
  gl.drawArrays = record('drawArrays');
  gl.deleteTexture = (texture) => {
    deletedTextures.push(texture);
    calls.push({ name: 'deleteTexture', args: [texture] });
  };
  gl.deleteBuffer = record('deleteBuffer');
  gl.deleteProgram = record('deleteProgram');
  gl.deleteShader = record('deleteShader');
  gl.isContextLost = () => false;
  // Alpha probe read-back. The default fills every channel with 255 (an opaque frame); a test that
  // wants mixed alpha passes its own filler so the counts are exact and independent of the stage.
  gl.readPixels = (x, y, width, height, _format, _type, buffer) => {
    calls.push({ name: 'readPixels', args: [x, y, width, height] });
    if (typeof readPixels === 'function') readPixels(buffer, width, height, { x, y });
    else buffer.fill(255);
  };
  // A driver may only set an error code and leave the buffer untouched; the stage must ask.
  gl.getError = () => (typeof getError === 'function' ? getError() : gl.NO_ERROR);
  if (fbo) {
    gl.createFramebuffer = () => {
      sequence += 1;
      const framebuffer = { kind: 'framebuffer', id: sequence };
      createdFramebuffers.push(framebuffer);
      calls.push({ name: 'createFramebuffer', args: [] });
      return framebuffer;
    };
    gl.bindFramebuffer = record('bindFramebuffer');
    gl.framebufferTexture2D = record('framebufferTexture2D');
    gl.checkFramebufferStatus = () => (
      typeof framebufferStatus === 'function' ? framebufferStatus() : gl.FRAMEBUFFER_COMPLETE
    );
    gl.deleteFramebuffer = (framebuffer) => {
      deletedFramebuffers.push(framebuffer);
      calls.push({ name: 'deleteFramebuffer', args: [framebuffer] });
    };
  }
  return gl;
}

function createFakeFrame(width, height) {
  return {
    displayWidth: width,
    displayHeight: height,
    closed: 0,
    close() {
      this.closed += 1;
    },
  };
}

function createFakeImported(frame) {
  return {
    released: 0,
    getVideoFrame() {
      return frame;
    },
    release() {
      this.released += 1;
    },
  };
}

function createHarness({
  width = 520,
  height = 800,
  fbo = true,
  framebufferStatus = null,
  readPixels = null,
  getError = null,
  schedule = null,
  stage2IntervalMs,
  alphaSampleIntervalMs,
} = {}) {
  const gl = createFakeGl({ fbo, framebufferStatus, readPixels, getError });
  const timers = createFakeTimers();
  const canvas = { width: 0, height: 0 };
  const health = [];
  const stage2 = [];
  const alpha = [];
  const frames = [];
  const stage = createStage({
    gl,
    canvas,
    now: timers.now,
    timers: {
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
    },
    schedule: schedule ?? undefined,
    stage2IntervalMs,
    alphaSampleIntervalMs,
    onHealth: (stats) => health.push(stats),
    onStage2: (payload) => stage2.push(payload),
    onAlpha: (sample) => alpha.push(sample),
    onFrame: (info) => frames.push(info),
  });
  stage.resize(width, height);
  stage.start();
  return { gl, timers, canvas, stage, health, stage2, alpha, frames };
}

const count = (gl, name) => gl.calls.filter((call) => call.name === name).length;
const lastCall = (gl, name) => [...gl.calls].reverse().find((call) => call.name === name) ?? null;

/**
 * CPU model of the fixed compositing contract: premultiplied source over a premultiplied
 * destination (blend ONE, ONE_MINUS_SRC_ALPHA). Values are 0..1.
 */
function premultipliedOver(src, dst) {
  const keep = 1 - src[3];
  return [
    src[0] + dst[0] * keep,
    src[1] + dst[1] * keep,
    src[2] + dst[2] * keep,
    src[3] + dst[3] * keep,
  ];
}

const bytes = (value) => Math.round(value * 255);

test('capture background inference requires uniform fully transparent evidence', () => {
  const buffer = new Uint8Array(16 * 16 * 4);
  for (let i = 0; i < buffer.length; i += 4) buffer.set([255, 0, 255, 0], i);
  assert.deepEqual(inferCaptureBackground(buffer, 16, 16, 1), [1, 0, 1]);
  buffer.fill(0);
  assert.deepEqual(inferCaptureBackground(buffer, 16, 16, 1), [0, 0, 0]);
  for (let i = 0; i < buffer.length; i += 4) buffer.set([255, 0, 255, 255], i);
  assert.deepEqual(inferCaptureBackground(buffer, 16, 16, 1), [0, 0, 0], 'opaque model colours are not evidence');
  for (let i = 0; i < buffer.length; i += 4) buffer.set(i % 8 ? [0, 255, 0, 0] : [255, 0, 255, 0], i);
  assert.deepEqual(inferCaptureBackground(buffer, 16, 16, 1), [0, 0, 0], 'mixed backgrounds are not guessed');
});

test('background subtraction preserves opacity and recovers a contaminated half-transparent edge', () => {
  const recover = (c, bg) => [...c.slice(0, 3).map((v, i) => Math.max(0, Math.min(c[3], v - bg[i] * (1 - c[3])))), c[3]];
  assert.deepEqual(recover([1, 0, 1, 0], [1, 0, 1]), [0, 0, 0, 0]);
  assert.deepEqual(recover([0.75, 0.25, 0.75, 0.5], [1, 0, 1]), [0.25, 0.25, 0.25, 0.5]);
  assert.deepEqual(recover([1, 0, 1, 1], [1, 0, 1]), [1, 0, 1, 1], 'opaque pink clothing survives');
  assert.deepEqual(recover([0.25, 0.25, 0.25, 0.5], [0, 0, 0]), [0.25, 0.25, 0.25, 0.5]);
});

test('first draw receives the inferred background; failed reads discard it', () => {
  let fail = false;
  const { gl, stage, timers } = createHarness({readPixels(buffer) {
    for (let i = 0; i < buffer.length; i += 4) buffer.set([255, 0, 255, 0], i);
  }, getError: () => fail ? 1282 : 0});
  try {
    stage.drawFrame(createFakeFrame(64, 64), {width:64, height:64});
    assert.deepEqual(stage.stats().captureBackground, [1, 0, 1]);
    const set = gl.calls.findIndex(c => c.name === 'uniform3f');
    assert.deepEqual(gl.calls[set].args.slice(1), [1, 0, 1]);
    assert.ok(set < gl.calls.findIndex(c => c.name === 'drawArrays'));
    fail = true;
    timers.tick(1100);
    stage.drawFrame(createFakeFrame(64, 64), {width:64, height:64});
    assert.deepEqual(stage.stats().captureBackground, [0, 0, 0]);
  } finally { stage.dispose(); }
});

test('1. premultiplied semi-transparent edge composites without a black or white fringe', () => {
  const { gl, stage } = createHarness({ width: 64, height: 64 });
  try {
    const receive = createFrameReceiver({ stage });
    receive(createFakeImported(createFakeFrame(64, 64)), { width: 64, height: 64 });
    assert.equal(count(gl, 'drawArrays'), 1, 'the frame is drawn once');

    // Canvas contract: the compositor treats committed pixels as premultiplied.
    assert.equal(CONTEXT_ATTRIBUTES.alpha, true);
    assert.equal(CONTEXT_ATTRIBUTES.premultipliedAlpha, true);
    assert.equal(ALPHA_MODE, 'premultiplied');

    // VTS texel: straight (128,128,128) at alpha 128/255 → premultiplied (64,64,64,128).
    const texel = [64 / 255, 64 / 255, 64 / 255, 128 / 255];
    // The straight colour must survive: 64/255 / (128/255) = 0.5 → 128 grey.
    assert.equal(bytes(texel[0] / texel[3]), 128);

    // Over an opaque white background: 64 + (255-128) = 191. A double premultiply gives 32 + 127
    // = 159 (the dark fringe); a straight-alpha upload blended with ONE gives 255 (white fringe).
    const overWhite = premultipliedOver(texel, [1, 1, 1, 1]);
    assert.equal(bytes(overWhite[0]), 191, 'expected 191/255 over white');
    assert.notEqual(bytes(overWhite[0]), 159, 'double premultiply would darken the edge');
    assert.notEqual(bytes(overWhite[0]), 255, 'a straight-alpha upload would lighten the edge');

    // Over the transparent canvas the texel is preserved exactly (premultiplied, no fringe).
    const overClear = premultipliedOver(texel, [0, 0, 0, 0]);
    assert.deepEqual(overClear, texel);

    // Black capture background preserves premultiplied pixels without multiplying alpha again.
    assert.match(FRAGMENT_SHADER, /c.rgb - u_background \* \(1.0 - c.a\)/u);
    assert.doesNotMatch(FRAGMENT_SHADER, /\*\s*texture2D|texture2D\([^)]*\)\s*\*/u);
    assert.match(VERTEX_SHADER, /gl_Position\s*=\s*vec4\(a_position \* u_scale \+ u_offset/u);
  } finally {
    stage.dispose();
  }
});

test('2. blend is exactly ONE / ONE_MINUS_SRC_ALPHA and the upload never premultiplies again', () => {
  const { gl, stage } = createHarness({ width: 320, height: 240 });
  try {
    const receive = createFrameReceiver({ stage });
    for (const size of [64, 48, 32]) {
      receive(createFakeImported(createFakeFrame(size, size)), { width: size, height: size });
    }
    const blends = gl.calls.filter((call) => call.name === 'blendFunc');
    assert.ok(blends.length >= 1, 'the stage sets a blend function');
    for (const blend of blends) {
      assert.deepEqual(blend.args, [gl.ONE, gl.ONE_MINUS_SRC_ALPHA]);
      assert.notEqual(blend.args[0], gl.SRC_ALPHA, 'premultiplied input needs ONE, not SRC_ALPHA');
    }
    assert.equal(count(gl, 'blendFuncSeparate'), 0, 'no second alpha-multiplying blend path');

    const stores = gl.calls.filter(
      (call) => call.name === 'pixelStorei' && call.args[0] === gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,
    );
    assert.ok(stores.length >= 1, 'the upload explicitly sets UNPACK_PREMULTIPLY_ALPHA_WEBGL');
    for (const store of stores) assert.equal(store.args[1], false);

    assert.doesNotMatch(FRAGMENT_SHADER, /c.rgb\s*\*\s*c.a/u);
    assert.doesNotMatch(FRAGMENT_SHADER, /u_alpha/u);
    assert.doesNotMatch(FRAGMENT_SHADER, /texture2D\(u_texture, v_uv\)\s*\*/u);
  } finally {
    stage.dispose();
  }
});

test('3. fully transparent pixels stay alpha=0: the previous frame is cleared, not retained', () => {
  const { gl, stage } = createHarness({ width: 320, height: 240 });
  try {
    const receive = createFrameReceiver({ stage });
    receive(createFakeImported(createFakeFrame(64, 64)), { width: 64, height: 64 });
    receive(createFakeImported(createFakeFrame(64, 64)), { width: 64, height: 64 });

    // Every draw pass clears first, with a fully transparent clear colour.
    const names = gl.calls.map((call) => call.name);
    const firstDraw = names.indexOf('drawArrays');
    assert.ok(names.slice(0, firstDraw).includes('clear'), 'clear happens before the quad');
    assert.deepEqual(lastCall(gl, 'clearColor').args, [0, 0, 0, 0]);
    assert.ok(count(gl, 'clear') >= 2, 'each frame starts from a transparent buffer');

    // A stale opaque red previous frame would survive only if the clear were missing.
    const previousFrame = [1, 0, 0, 1];
    const transparentTexel = [0, 0, 0, 0];
    const stale = premultipliedOver(transparentTexel, previousFrame);
    assert.deepEqual(stale, previousFrame, 'without a clear the old pixel remains');
    const cleared = premultipliedOver(transparentTexel, [0, 0, 0, 0]);
    assert.deepEqual(cleared, [0, 0, 0, 0], 'after the clear the transparent pixel stays alpha=0');

    // A larger stage's transparent margin must also compose to zero.
    const margin = premultipliedOver([0, 0, 0, 0], [0, 0, 0, 0]);
    assert.equal(bytes(margin[3]), 0);
    assert.equal(bytes(margin[0]), 0);
  } finally {
    stage.dispose();
  }
});

test('4. 60 fps on a fake clock: fps≈60, dropped=0, stage-2 diagnostic throttled to 1 Hz', () => {
  const { gl, stage, timers, stage2 } = createHarness({ width: 520, height: 800 });
  try {
    const receive = createFrameReceiver({ stage });
    const interval = 1000 / 60;
    for (let index = 0; index < 60; index += 1) {
      receive(createFakeImported(createFakeFrame(64, 64)), { width: 64, height: 64 });
      timers.tick(interval);
    }
    // 60 × 16.666… = 999.96 ms: cross the 1 s boundary so the 1 Hz report definitely ran.
    timers.tick(interval);

    const stats = stage.stats();
    assert.ok(stats.fps >= 55 && stats.fps <= 65, `fps should be ~60, got ${stats.fps}`);
    assert.ok(stats.fpsMin >= 55 && stats.fpsMin <= 65, `fpsMin should be ~60, got ${stats.fpsMin}`);
    assert.ok(stats.fpsMax >= 55 && stats.fpsMax <= 65, `fpsMax should be ~60, got ${stats.fpsMax}`);
    assert.ok(stats.fpsMin <= stats.fps && stats.fps <= stats.fpsMax);
    assert.equal(stats.drawn, 60);
    assert.equal(stats.dropped, 0, 'a steady 60 Hz feed drops nothing');
    assert.equal(stats.resized, 0);
    assert.equal(stats.alphaMode, 'premultiplied');

    assert.equal(stage2.length, 1, 'exactly one stage-2 report in the first second');
    const report = stage2[0];
    assert.deepEqual(
      Object.keys(report).sort(),
      ['alphaMode', 'at', 'dropped', 'fps', 'framebufferErrors', 'resized'],
    );
    assert.equal(report.alphaMode, 'premultiplied');
    assert.equal(report.dropped, 0);
    assert.equal(report.resized, 0);
    assert.ok(report.fps >= 55 && report.fps <= 65, `stage2 fps ~60, got ${report.fps}`);

    // A second request inside the same second is throttled; after the window it reports again.
    assert.equal(stage.stage2Report(), null, 'the throttle suppresses a second report');
    timers.tick(1000);
    assert.equal(stage2.length, 2, 'the next second reports again');
  } finally {
    stage.dispose();
  }
});

test('5. a 10-frame burst draws only the newest frame: dropped>0, one draw, latency flat', () => {
  const scheduled = [];
  const { gl, stage, timers, frames } = createHarness({
    width: 520,
    height: 800,
    schedule: (fn) => scheduled.push(fn),
  });
  try {
    const opened = [];
    const received = [];
    const receive = createFrameReceiver({
      stage,
      coalesce: true,
      onFrame: (info) => frames.push(info),
    });
    for (let id = 0; id < 10; id += 1) {
      const frame = createFakeFrame(64, 64);
      opened.push(frame);
      const imported = createFakeImported(frame);
      received.push(imported);
      const result = receive(imported, { width: 64, height: 64, id });
      assert.equal(result.ok, true);
      assert.equal(result.queued, true, 'the frame waits for the next drain');
      assert.equal(result.drawn, false);
    }
    assert.equal(count(gl, 'drawArrays'), 0, 'nothing is drawn before the drain');
    assert.equal(scheduled.length, 1, 'ten deliveries schedule one drain, not ten');
    assert.equal(stage.stats().dropped, 9, 'nine frames were superseded');
    assert.equal(stage.stats().pending, true);
    assert.equal(opened.filter((frame) => frame.closed === 0).length, 1, 'only the newest frame is open');

    scheduled.shift()();
    assert.equal(count(gl, 'drawArrays'), 1, 'the whole burst becomes one draw');
    assert.equal(stage.stats().drawn, 1);
    assert.equal(frames.at(-1).meta.id, 9, 'the newest frame is the one drawn');
    assert.equal(stage.stats().pending, false);
    assert.equal(stage.stats().lastLatencyMs, 0, 'the drain is immediate, not delayed by the burst');
    assert.equal(frames.at(-1).meta.width, 64);
    assert.equal(opened[9].closed, 1, 'the drawn frame is released after the upload');
    assert.ok(opened.every((frame) => frame.closed === 1), 'every superseded frame is released once');
    assert.ok(received.every((imported) => imported.released === 1), 'every imported reference is released once');

    // A second burst one frame later behaves the same, and latency does not grow with the backlog.
    timers.tick(1000 / 60);
    for (let id = 10; id < 20; id += 1) {
      const frame = createFakeFrame(64, 64);
      opened.push(frame);
      received.push(createFakeImported(frame));
      receive(received.at(-1), { width: 64, height: 64, id });
    }
    assert.equal(scheduled.length, 1, 'still one pending drain');
    assert.equal(stage.stats().dropped, 18);
    scheduled.shift()();
    assert.equal(count(gl, 'drawArrays'), 2);
    assert.equal(frames.at(-1).meta.id, 19);
    assert.ok(stage.stats().lastLatencyMs <= 17, `latency stayed bounded, got ${stage.stats().lastLatencyMs}`);
    assert.ok(stage.stats().maxLatencyMs <= 17, `max latency stayed bounded, got ${stage.stats().maxLatencyMs}`);
    assert.ok(opened.every((frame) => frame.closed === 1));
    assert.ok(received.every((imported) => imported.released === 1));
  } finally {
    stage.dispose();
  }
});

test('6. sender resize rebuilds the texture, deletes it once and releases the old framebuffer', () => {
  const { gl, stage } = createHarness({ width: 520, height: 800, fbo: true });
  try {
    const receive = createFrameReceiver({ stage });
    receive(createFakeImported(createFakeFrame(64, 64)), { width: 64, height: 64 });
    const firstTexture = stage.texture;
    const firstFramebuffer = stage.framebuffer;
    assert.ok(firstTexture !== null);
    assert.ok(firstFramebuffer !== null, 'the upload probe framebuffer exists');
    assert.equal(count(gl, 'createFramebuffer'), 1);
    assert.equal(count(gl, 'deleteTexture'), 0);
    assert.equal(count(gl, 'deleteFramebuffer'), 0);

    // Sender changes size: the old texture AND the framebuffer attached to it must be released
    // before the replacement is allocated.
    receive(createFakeImported(createFakeFrame(48, 40)), { width: 48, height: 40 });
    assert.equal(count(gl, 'texImage2D'), 2, 'a size change reallocates with texImage2D');
    assert.equal(count(gl, 'deleteTexture'), 1, 'the old texture is deleted exactly once');
    assert.equal(gl.deletedTextures[0], firstTexture);
    assert.equal(count(gl, 'deleteFramebuffer'), 1, 'the old framebuffer is released');
    assert.equal(gl.deletedFramebuffers[0], firstFramebuffer);
    const names = gl.calls.map((call) => call.name);
    assert.ok(
      names.indexOf('deleteFramebuffer') < names.lastIndexOf('deleteTexture'),
      'the framebuffer is detached before its texture is deleted',
    );
    assert.ok(names.indexOf('deleteTexture') < names.lastIndexOf('texImage2D'));
    assert.notEqual(stage.texture, firstTexture);
    assert.notEqual(stage.framebuffer, firstFramebuffer);
    assert.equal(count(gl, 'createFramebuffer'), 2);
    assert.equal(stage.stats().reallocations, 2);
    assert.equal(stage.stats().resized, 1, 'one resize after the initial allocation');
    assert.equal(stage.stats().textureWidth, 48);
    assert.equal(stage.stats().textureHeight, 40);

    const report = stage.stage2Report({ force: true });
    assert.equal(report.resized, 1);
    assert.equal(report.alphaMode, 'premultiplied');

    // Same size again: a cheap texSubImage2D upload, no objects recreated.
    receive(createFakeImported(createFakeFrame(48, 40)), { width: 48, height: 40 });
    assert.equal(count(gl, 'texSubImage2D'), 1);
    assert.equal(count(gl, 'deleteTexture'), 1);
    assert.equal(count(gl, 'deleteFramebuffer'), 1);
    assert.equal(count(gl, 'texImage2D'), 2);
  } finally {
    stage.dispose();
    assert.equal(count(gl, 'deleteFramebuffer'), 2, 'dispose releases the current framebuffer too');
    assert.equal(count(gl, 'deleteTexture'), 2, 'dispose releases the current texture too');
  }
});

test('7. no frames for 1 s: transparent placeholder once, no stale redraw, no flicker', () => {
  const { gl, stage, timers } = createHarness({ width: 520, height: 800 });
  try {
    const receive = createFrameReceiver({ stage });
    receive(createFakeImported(createFakeFrame(64, 64)), { width: 64, height: 64 });
    const drawnAfterFrame = count(gl, 'drawArrays');
    assert.equal(drawnAfterFrame, 1);
    assert.equal(stage.stats().placeholder, false, 'a live frame replaced the placeholder');

    // Just under the stall threshold: the frame stays on screen, the placeholder does not flicker.
    timers.tick(999);
    assert.equal(stage.stats().placeholder, false, '999 ms without a frame is not a stall');
    const clearsBeforeStall = count(gl, 'clear');

    // One millisecond later the stage has been without frames for 1 s: show transparent.
    timers.tick(1);
    const stalled = stage.stats();
    assert.equal(stalled.placeholder, true, 'the transparent placeholder is showing');
    assert.equal(stalled.error, '', 'the stall path reports no error');
    assert.deepEqual(lastCall(gl, 'clearColor').args, [0, 0, 0, 0]);
    assert.equal(stage.stats().placeholderDrawn >= 2, true, 'the start placeholder plus the stall clear');
    assert.equal(count(gl, 'clear'), clearsBeforeStall + 1, 'the stall clears exactly once');
    assert.equal(count(gl, 'drawArrays'), drawnAfterFrame, 'the old frame is never re-drawn');

    // Staying stalled does not clear repeatedly: that would be the visible flicker.
    timers.tick(1000);
    assert.equal(count(gl, 'clear'), clearsBeforeStall + 1, 'no repeated clearing while stalled');
    assert.equal(count(gl, 'drawArrays'), drawnAfterFrame, 'still no stale frame');
    assert.equal(stage.stats().placeholder, true);
    assert.equal(stage.stats().lastFrameAgeMs >= 2000, true);

    // A new frame after the stall takes over without another placeholder clear.
    receive(createFakeImported(createFakeFrame(64, 64)), { width: 64, height: 64 });
    assert.equal(stage.stats().placeholder, false);
    assert.equal(count(gl, 'drawArrays'), drawnAfterFrame + 1);
    assert.equal(stage.stats().error, '');
  } finally {
    stage.dispose();
  }
});

test('8. incomplete framebuffer fails the frame, reclaims FBO + texture and commits nothing', () => {
  let status = 0x8cd6; // FRAMEBUFFER_UNSUPPORTED: the fake driver cannot allocate the surface.
  const { gl, stage, frames } = createHarness({
    width: 520,
    height: 800,
    framebufferStatus: () => status,
  });
  try {
    const receive = createFrameReceiver({ stage });
    const result = receive(createFakeImported(createFakeFrame(64, 64)), { width: 64, height: 64 });

    assert.equal(result.ok, true, 'the receiver hands the frame over without throwing');
    assert.equal(result.drawn, false, 'the incomplete frame is not drawn');
    const stats = stage.stats();
    assert.equal(stats.drawn, 0, 'framesDrawn did not grow');
    assert.equal(stats.framebufferErrors, 1, 'the failed probe is counted');
    assert.equal(stats.dropped, 1, 'the frame is reported as a dropped frame');
    assert.equal(stats.textureWidth, 0, 'the texture size is not committed before the probe');
    assert.equal(stats.textureHeight, 0);
    assert.equal(stats.reallocations, 0, 'a failed allocation is not a reallocation');
    assert.equal(count(gl, 'drawArrays'), 0, 'no draw pass ran');
    assert.equal(stage.framebuffer, null, 'no incomplete framebuffer stays committed');
    assert.equal(stage.texture, null, 'the rejected texture is not kept');

    assert.equal(gl.createdFramebuffers.length, 1);
    assert.equal(count(gl, 'deleteFramebuffer'), 1, 'the incomplete framebuffer is deleted');
    assert.equal(gl.deletedFramebuffers[0], gl.createdFramebuffers[0]);
    assert.equal(count(gl, 'deleteTexture'), 1, 'the candidate texture is deleted');
    assert.equal(frames.length, 0, 'no success event is emitted for a failed frame');
    assert.equal(stage.stage2Report({ force: true }).framebufferErrors, 1);
  } finally {
    stage.dispose();
  }
});

test('9. a same-size frame after recovery reallocates fully instead of using texSubImage2D', () => {
  let status = 0x8cd6;
  const { gl, stage, frames } = createHarness({
    width: 520,
    height: 800,
    framebufferStatus: () => status,
  });
  try {
    const receive = createFrameReceiver({ stage });
    receive(createFakeImported(createFakeFrame(64, 64)), { width: 64, height: 64 });
    assert.equal(stage.stats().drawn, 0);
    assert.equal(stage.stats().framebufferErrors, 1);

    status = gl.FRAMEBUFFER_COMPLETE;
    receive(createFakeImported(createFakeFrame(64, 64)), { width: 64, height: 64 });

    const stats = stage.stats();
    assert.equal(count(gl, 'texImage2D'), 2, 'the same size allocates again, it does not update');
    assert.equal(count(gl, 'texSubImage2D'), 0, 'a null framebuffer never takes the cheap update path');
    assert.equal(count(gl, 'createFramebuffer'), 2);
    assert.equal(count(gl, 'deleteTexture'), 1, 'only the rejected candidate was deleted');
    assert.equal(count(gl, 'drawArrays'), 1);
    assert.equal(stats.drawn, 1, 'the recovered frame is a real success');
    assert.equal(stats.framebufferErrors, 1);
    assert.equal(stats.reallocations, 1);
    assert.equal(stats.textureWidth, 64);
    assert.equal(stats.textureHeight, 64);
    assert.ok(stage.framebuffer !== null, 'the recovered framebuffer is committed');
    assert.ok(stage.texture !== null);
    assert.equal(frames.length, 1);
    assert.equal(frames[0].drawn, true);
    assert.equal(frames[0].framebufferErrors, 1, 'the success event carries the failure count');
    assert.equal(stage.stage2Report({ force: true }).framebufferErrors, 1);
  } finally {
    stage.dispose();
  }
});

test('10. repeated incomplete allocations retry in full and never report a false success', () => {
  const { gl, stage, frames } = createHarness({
    width: 520,
    height: 800,
    framebufferStatus: () => 0x8cd6,
  });
  try {
    const receive = createFrameReceiver({ stage });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = receive(createFakeImported(createFakeFrame(64, 64)), { width: 64, height: 64 });
      assert.equal(result.drawn, false, `attempt ${attempt + 1} is not a success`);
      assert.equal(stage.stats().drawn, 0, 'framesDrawn never grows on failure');
      assert.equal(stage.framebuffer, null, 'no framebuffer is committed while the probe fails');
      assert.equal(count(gl, 'texSubImage2D'), 0, 'the update path is never used for a null framebuffer');
    }

    const stats = stage.stats();
    assert.equal(stats.drawn, 0);
    assert.equal(stats.framebufferErrors, 3, 'every failed probe is counted');
    assert.equal(stats.dropped, 3);
    assert.equal(stats.reallocations, 0);
    assert.equal(stats.textureWidth, 0);
    assert.equal(count(gl, 'texImage2D'), 3, 'each retry performs a full texImage2D allocation');
    assert.equal(count(gl, 'createFramebuffer'), 3);
    assert.equal(count(gl, 'deleteFramebuffer'), 3);
    assert.equal(count(gl, 'deleteTexture'), 3);
    assert.equal(count(gl, 'drawArrays'), 0);
    assert.equal(frames.length, 0, 'no success event is emitted');
  } finally {
    stage.dispose();
  }
});

/** Paint only the alpha bytes of an RGBA buffer from a per-pixel function. */
function paintAlpha(rgba, width, height, alphaAt) {
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) rgba[(y * width + x) * 4 + 3] = alphaAt(x, y);
  }
}

const ALPHA_PATTERN = (x) => (x % 3 === 0 ? 0 : (x % 3 === 1 ? 128 : 255));

test('11. receiver alpha sampling: 0/128/255 counts, downsampling, one probe per second', () => {
  // Pure counting: an exact synthetic frame with all three classes.
  const width = 16;
  const height = 16;
  const rgba = new Uint8Array(width * height * 4);
  paintAlpha(rgba, width, height, ALPHA_PATTERN);
  assert.deepEqual(
    countAlphaClasses(rgba, width, height, 1),
    { total: 256, alphaZero: 96, alphaOpaque: 80, alphaPartial: 80 },
    'every pixel counted at stride 1: 6 transparent columns, 5 partial, 5 opaque',
  );
  assert.deepEqual(
    countAlphaClasses(rgba, width, height, 4),
    { total: 16, alphaZero: 8, alphaOpaque: 4, alphaPartial: 4 },
    'stride 4 samples x=0,4,8,12 only',
  );
  assert.deepEqual(
    countAlphaClasses(rgba, 0, 0),
    { total: 0, alphaZero: 0, alphaOpaque: 0, alphaPartial: 0 },
    'an empty region samples nothing',
  );
  assert.deepEqual(countAlphaClasses(null, 16, 16), { total: 0, alphaZero: 0, alphaOpaque: 0, alphaPartial: 0 });

  // Verdicts are exactly the black-background taxonomy.
  assert.equal(classifyAlphaSample({ total: 4, alphaZero: 4, alphaOpaque: 0, alphaPartial: 0 }), 'transparent');
  assert.equal(classifyAlphaSample({ total: 4, alphaZero: 1, alphaOpaque: 2, alphaPartial: 1 }), 'transparent');
  assert.equal(classifyAlphaSample({ total: 4, alphaZero: 0, alphaOpaque: 4, alphaPartial: 0 }), 'opaque');
  assert.equal(classifyAlphaSample({ total: 4, alphaZero: 0, alphaOpaque: 3, alphaPartial: 1 }), 'partial');
  assert.equal(classifyAlphaSample({ total: 0, alphaZero: 0, alphaOpaque: 0, alphaPartial: 0 }), 'unknown');
  assert.equal(classifyAlphaSample(null), 'unknown');

  // A 4K/8K sender is read from a bounded centred window, not at full size.
  const full = alphaReadWindow(1148, 1292);
  assert.deepEqual(full, { x: 0, y: 0, width: 1148, height: 1292 });
  const bounded = alphaReadWindow(4096, 4096, 1_000_000);
  assert.ok(bounded.width * bounded.height <= 1_000_000, 'the read stays inside its budget');
  assert.equal(bounded.x, Math.floor((4096 - bounded.width) / 2), 'the window is centred');
  assert.equal(bounded.y, Math.floor((4096 - bounded.height) / 2));

  // Through the stage: the pixels read back from the received texture produce the same counts.
  const { gl, stage, alpha, timers } = createHarness({
    width: 64,
    height: 48,
    readPixels: (buffer, w, h) => paintAlpha(buffer, w, h, ALPHA_PATTERN),
  });
  try {
    const receive = createFrameReceiver({ stage });
    receive(createFakeImported(createFakeFrame(64, 48)), { width: 64, height: 48 });

    assert.equal(count(gl, 'readPixels'), 1, 'the texture is read back once, not per frame');
    assert.equal(alpha.length, 1);
    assert.deepEqual(
      {
        total: alpha[0].total,
        alphaZero: alpha[0].alphaZero,
        alphaOpaque: alpha[0].alphaOpaque,
        alphaPartial: alpha[0].alphaPartial,
      },
      { total: 48, alphaZero: 18, alphaOpaque: 18, alphaPartial: 12 },
      'sampled x=0,8,16,24,32,40,48,56 and y=0,8,16,24,32,40',
    );
    assert.equal(alpha[0].verdict, 'transparent');
    assert.equal(alpha[0].width, 64);
    assert.equal(alpha[0].height, 48);
    assert.equal(alpha[0].sampledWidth, 64);
    assert.equal(alpha[0].sampledHeight, 48);
    assert.equal(ALPHA_SAMPLE_STRIDE, 8);
    assert.equal(stage.stats().alphaReadErrors, 0, 'a clean read records no read error');
    assert.deepEqual(stage.stats().alphaSample, alpha[0], 'the sample is part of the 1 Hz stats');

    // Another frame inside the same second is throttled; the next second samples again.
    receive(createFakeImported(createFakeFrame(64, 48)), { width: 64, height: 48 });
    assert.equal(alpha.length, 1, 'at most one probe per second');
    assert.equal(count(gl, 'readPixels'), 1);
    timers.tick(1000);
    receive(createFakeImported(createFakeFrame(64, 48)), { width: 64, height: 48 });
    assert.equal(alpha.length, 2, 'the next second samples again');
    assert.equal(count(gl, 'readPixels'), 2);
  } finally {
    stage.dispose();
  }
});

/** Minimal fake page for running renderer.js outside Electron. */
function createFakeDocument() {
  const canvas = { id: 'stage', width: 0, height: 0, clientWidth: 420, clientHeight: 520, style: {} };
  const body = {
    style: {},
    appendChild() {},
    setPointerCapture() {},
  };
  const documentElement = { style: {} };
  const document = {
    documentElement,
    body,
    getElementById: (id) => (id === 'stage' ? canvas : null),
    createElement: () => ({ id: '', style: {} }),
    addEventListener() {},
  };
  return { canvas, body, documentElement, document };
}

test('12. display side: transparent window, alpha canvas, zero clear colour, transparent DOM', async () => {
  // Window: a transparent BrowserWindow with a zero-alpha background and no system backdrop.
  assert.equal(WINDOW_PRESENTATION.transparent, true);
  assert.equal(WINDOW_PRESENTATION.backgroundColor, '#00000000');
  assert.equal(WINDOW_PRESENTATION.frame, false);
  assert.equal(WINDOW_PRESENTATION.hasShadow, false);
  assert.equal(WINDOW_PRESENTATION.backgroundMaterial, 'none', 'no Mica/acrylic backdrop behind the layer');
  assert.equal(WINDOW_WEB_PREFERENCES.backgroundThrottling, false, 'a hidden layer must still paint');
  assert.equal(WINDOW_WEB_PREFERENCES.sandbox, false, 'the WebGL stage is required from the preload');

  // Canvas: the context keeps its alpha and the compositor is told the pixels are premultiplied.
  assert.equal(CONTEXT_ATTRIBUTES.alpha, true);
  assert.equal(CONTEXT_ATTRIBUTES.premultipliedAlpha, true);
  assert.equal(CONTEXT_ATTRIBUTES.preserveDrawingBuffer, false);

  // Clear colour is fully transparent on every clear, and the clear precedes the quad.
  const { gl, stage } = createHarness({ width: 320, height: 240 });
  try {
    const receive = createFrameReceiver({ stage });
    receive(createFakeImported(createFakeFrame(64, 64)), { width: 64, height: 64 });
    stage.drawPlaceholder();
    const clears = gl.calls.filter((call) => call.name === 'clearColor');
    assert.ok(clears.length >= 3, 'start placeholder, frame pass, stall placeholder');
    for (const call of clears) assert.deepEqual(call.args, [0, 0, 0, 0]);
    const names = gl.calls.map((call) => call.name);
    assert.ok(names.indexOf('clear') < names.indexOf('drawArrays'), 'each frame starts from transparent');
    assert.ok(names.includes('viewport'), 'the canvas drawing buffer has an explicit viewport');
  } finally {
    stage.dispose();
  }

  // The page paints nothing behind the canvas: run renderer.js against a fake DOM.
  const fake = createFakeDocument();
  const ready = [];
  const errors = [];
  const sandbox = {
    document: fake.document,
    window: {
      innerWidth: 420,
      innerHeight: 520,
      addEventListener() {},
      spoutLayer: {
        resizeStage: () => ({ ok: true }),
        stageStats: () => ({ drawn: 0, fps: 0 }),
        startStage: async () => ({ ok: true, registered: true }),
        registerReceiver: async () => ({
          ok: true,
          registered: true,
          connected: true,
          sender: 'VTubeStudioSpout',
          surface: { width: 1148, height: 1292 },
        }),
        reportReady: (info) => ready.push(info),
        reportError: (info) => errors.push(info),
        onEditMode: () => () => {},
        editDrag() {},
        editResize() {},
        exitEdit() {},
      },
    },
    requestAnimationFrame: (fn) => fn(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
    console,
  };
  vm.runInNewContext(readFileSync(new URL('renderer.js', layerRoot), 'utf8'), sandbox, { filename: 'renderer.js' });
  await new Promise((done) => setImmediate(done));

  assert.equal(fake.documentElement.style.background, 'transparent');
  assert.equal(fake.documentElement.style.backgroundColor, 'transparent');
  assert.equal(fake.body.style.backgroundColor, 'transparent');
  assert.equal(fake.canvas.style.backgroundColor, 'transparent', 'the canvas itself never paints a background');
  assert.equal(errors.length, 0, `renderer reported no error: ${JSON.stringify(errors)}`);
  assert.equal(ready.length, 1);
  assert.equal(ready[0].sharedTextureRegistered, true);
  assert.equal(ready[0].phase, 'receiver');
  assert.equal(ready[0].registered, true);

  // index.html declares the same contract (it is not a file this diagnose-and-fix task edits):
  // html/body transparent, and the canvas rule has no background at all.
  const html = readFileSync(new URL('index.html', layerRoot), 'utf8');
  const rootRule = html.match(/html,\s*body\s*\{([^}]*)\}/u);
  assert.ok(rootRule !== null, 'the document background rule exists');
  assert.match(rootRule[1], /background:\s*transparent/u);
  const stageRule = html.match(/#stage\s*\{([^}]*)\}/u);
  assert.ok(stageRule !== null);
  assert.doesNotMatch(stageRule[1], /background/u);
});

test('13. an all-opaque sample set reports scope:"sampled" and never asserts a VTS misconfiguration', () => {
  // Every receiver-side sampled point is alpha 255: that describes the sampled grid, not the frame.
  const opaque = alphaDiagnostic({ total: 100, alphaZero: 0, alphaOpaque: 100, alphaPartial: 0, width: 1148, height: 1292 });
  assert.equal(opaque.event, 'spout.alpha.opaque-frame');
  assert.equal(opaque.opaque, true);
  assert.equal(opaque.payload.verdict, 'opaque');
  assert.equal(opaque.payload.scope, 'sampled', 'the verdict is scoped to the sampled points');
  assert.match(opaque.payload.hint, /采样点全为不透明/u);
  assert.match(opaque.payload.hint, /VTS Spout 背景设置或接收转换/u);
  assert.match(opaque.payload.hint, /TRANSPARENT BLACK/u);
  assert.doesNotMatch(
    opaque.payload.hint,
    /配置错误|配置有误|设置错误|misconfigur/iu,
    'the hint asks to verify; it never asserts that VTS is configured wrongly',
  );
  assert.deepEqual(
    Object.keys(opaque.payload).sort(),
    ['alphaOpaque', 'alphaPartial', 'alphaZero', 'height', 'hint', 'scope', 'total', 'verdict', 'width'],
    'an opaque sample carries counts, a sampled scope, a verdict, a size and the setting hint',
  );

  // Transparent data present: reported as a sample, no hint, no action.
  const mixed = alphaDiagnostic({ total: 100, alphaZero: 60, alphaOpaque: 36, alphaPartial: 4 });
  assert.equal(mixed.event, 'spout.alpha.sample');
  assert.equal(mixed.opaque, false);
  assert.equal(mixed.payload.verdict, 'transparent');
  assert.equal(mixed.payload.scope, 'sampled');
  assert.equal(Object.hasOwn(mixed.payload, 'hint'), false);
  const partialOnly = alphaDiagnostic({ total: 8, alphaZero: 0, alphaOpaque: 4, alphaPartial: 4 });
  assert.equal(partialOnly.event, 'spout.alpha.sample');
  assert.equal(partialOnly.payload.verdict, 'partial');
  assert.equal(alphaDiagnostic({ total: 10, alphaZero: 1, alphaOpaque: 1, alphaPartial: 1 }), null, 'inconsistent counts are not evidence');
  assert.equal(alphaDiagnostic({ total: 0, alphaZero: 0, alphaOpaque: 0, alphaPartial: 0 }), null);
  assert.equal(alphaDiagnostic(null), null);

  // An all-255 texture goes through exactly the normal draw: one upload, one blend, one quad.
  const { gl, stage, alpha } = createHarness({ width: 320, height: 240 }); // default readPixels = 255
  try {
    const receive = createFrameReceiver({ stage });
    receive(createFakeImported(createFakeFrame(64, 64)), { width: 64, height: 64 });
    assert.equal(alpha.length, 1);
    assert.equal(alpha[0].verdict, 'opaque');
    assert.equal(alpha[0].alphaZero, 0);
    assert.equal(alpha[0].alphaPartial, 0);
    assert.equal(alpha[0].alphaOpaque, alpha[0].total);
    assert.equal(count(gl, 'drawArrays'), 1, 'an opaque frame is drawn, never keyed');
    assert.equal(count(gl, 'blendFunc'), 1);
    assert.equal(count(gl, 'texImage2D'), 1);
    assert.equal(count(gl, 'texSubImage2D'), 0);
    assert.equal(count(gl, 'readPixels'), 1, 'the sample only reads back');
    assert.equal(stage.stats().alphaMode, 'premultiplied');
    assert.equal(stage.stats().drawn, 1);
    assert.equal(stage.stats().dropped, 0);
  } finally {
    stage.dispose();
  }

  // No chroma-key implementation anywhere in the layer that this task owns.
  for (const name of ['main.js', 'preload.js', 'renderer.js', 'stage.js']) {
    const source = readFileSync(new URL(name, layerRoot), 'utf8');
    assert.doesNotMatch(source, /keyColor|chromaKey|colorToAlpha|u_key|magenta|洋红|品红/u, `${name} has no keying path`);
  }
  assert.doesNotMatch(`${VERTEX_SHADER}\n${FRAGMENT_SHADER}`, /key|chroma|magenta/iu);
});

test('14. gl.getError() failure is unknown, counted, and never a transparent conclusion', () => {
  // The driver sets INVALID_OPERATION and leaves the freshly allocated buffer untouched (all zero).
  // Those zeros are exactly what must not be mistaken for an all-transparent frame.
  const { gl, stage, alpha } = createHarness({
    width: 64,
    height: 48,
    getError: () => 0x0502, // INVALID_OPERATION
    readPixels: () => {}, // intentionally writes nothing
  });
  try {
    const receive = createFrameReceiver({ stage });
    receive(createFakeImported(createFakeFrame(64, 48)), { width: 64, height: 48 });

    assert.equal(alpha.length, 1, 'one diagnostic is emitted for the failed read');
    assert.deepEqual(alpha[0], {
      ok: false,
      reason: 'read-error',
      error: 0x0502,
      total: 0,
      alphaZero: 0,
      alphaOpaque: 0,
      alphaPartial: 0,
      verdict: 'unknown',
    }, 'a read error carries unknown, never zero-alpha counts');
    assert.equal(stage.stats().alphaReadErrors, 1);
    assert.equal(stage.stats().alphaSamples, 0);
    assert.equal(stage.stats().alphaSample.verdict, 'unknown');
    assert.equal(count(gl, 'drawArrays'), 1, 'the frame itself was already drawn; the probe cannot fail it');

    const diagnostic = alphaDiagnostic(alpha[0]);
    assert.equal(diagnostic.event, 'spout.alpha.read-error', 'the read failure has its own event');
    assert.equal(diagnostic.opaque, false);
    assert.deepEqual(diagnostic.payload, { error: 0x0502 });
    assert.notEqual(diagnostic.event, 'spout.alpha.sample');
    assert.notEqual(diagnostic.event, 'spout.alpha.opaque-frame');
  } finally {
    stage.dispose();
  }
});

test('15. a clean read still classifies the frame and keeps alphaReadErrors at 0', () => {
  const { gl, stage, alpha } = createHarness({
    width: 64,
    height: 48,
    readPixels: (buffer, width, height) => paintAlpha(buffer, width, height, ALPHA_PATTERN),
  });
  try {
    const receive = createFrameReceiver({ stage });
    receive(createFakeImported(createFakeFrame(64, 48)), { width: 64, height: 48 });

    assert.equal(alpha.length, 1);
    assert.equal(alpha[0].ok, undefined, 'a clean sample is not a failure payload');
    assert.equal(alpha[0].verdict, 'transparent');
    assert.deepEqual(
      {
        total: alpha[0].total,
        alphaZero: alpha[0].alphaZero,
        alphaOpaque: alpha[0].alphaOpaque,
        alphaPartial: alpha[0].alphaPartial,
      },
      { total: 48, alphaZero: 18, alphaOpaque: 18, alphaPartial: 12 },
    );
    assert.equal(stage.stats().alphaReadErrors, 0, 'a clean read leaves the error counter at zero');
    assert.equal(stage.stats().alphaSamples, 1);
    assert.equal(count(gl, 'readPixels'), 1);
    const diagnostic = alphaDiagnostic(alpha[0]);
    assert.equal(diagnostic.event, 'spout.alpha.sample');
    assert.equal(diagnostic.payload.verdict, 'transparent');
    assert.equal(diagnostic.payload.scope, 'sampled');
  } finally {
    stage.dispose();
  }
});

test('16. three consecutive read failures disable sampling once and never disturb rendering', () => {
  const { gl, stage, alpha, timers } = createHarness({
    width: 64,
    height: 48,
    getError: () => 0x0502,
    readPixels: () => {},
  });
  try {
    const receive = createFrameReceiver({ stage });
    for (let index = 0; index < 3; index += 1) {
      receive(createFakeImported(createFakeFrame(64, 48)), { width: 64, height: 48 });
      assert.equal(count(gl, 'drawArrays'), index + 1, `frame ${index + 1} is drawn despite the probe error`);
      timers.tick(1000);
    }

    assert.equal(alpha.filter((entry) => entry.reason === 'read-error').length, 3, 'one read-error per second');
    const disabled = alpha.filter((entry) => entry.event === 'spout.alpha.disabled');
    assert.equal(disabled.length, 1, 'the disable is reported exactly once');
    assert.equal(disabled[0].alphaReadErrors, 3);
    assert.equal(stage.stats().alphaReadErrors, 3);
    assert.equal(stage.stats().alphaSamples, 0, 'the disabled probe reports no samples');

    // Further frames are still uploaded/drawn; no further probe and no further event.
    receive(createFakeImported(createFakeFrame(64, 48)), { width: 64, height: 48 });
    timers.tick(1000);
    receive(createFakeImported(createFakeFrame(64, 48)), { width: 64, height: 48 });
    assert.equal(alpha.length, 4, 'three read errors plus one disabled line, nothing more');
    assert.equal(count(gl, 'readPixels'), 3, 'the probe is off, so readPixels is not called again');
    assert.equal(count(gl, 'drawArrays'), 5, 'all five frames were drawn');
    assert.equal(stage.stats().drawn, 5);
    assert.equal(stage.stats().dropped, 0);

    const diagnostic = alphaDiagnostic(disabled[0]);
    assert.equal(diagnostic.event, 'spout.alpha.disabled');
    assert.equal(diagnostic.opaque, false);
    assert.equal(diagnostic.payload.alphaReadErrors, 3);
    assert.equal(diagnostic.payload.error, 0x0502);
  } finally {
    stage.dispose();
  }
});

