/**
 * Phase 1 — fixed-size texture ingest (fake GL, fake texture, fake clock).
 *
 * The six acceptance cases from the migration plan:
 *   1. a delivered frame is uploaded once and drawn once;
 *   2. premultiplied alpha is correct: ONE / ONE_MINUS_SRC_ALPHA, no second alpha multiply,
 *      UNPACK_PREMULTIPLY_ALPHA_WEBGL=false;
 *   3. no sender → a fully transparent placeholder and no exception;
 *   4. sender size change → the old texture is deleted and a new one allocated;
 *   5. stop → texture/program/shaders/buffers deleted and both timers gone;
 *   6. 60 frames through a fake clock → a plausible fps report.
 *
 * Run: node --test test/spout-stage1.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

import { SpoutLayer } from '../src/host/avatar/spoutLayer.js';

const require = createRequire(import.meta.url);
const {
  CONTEXT_ATTRIBUTES,
  FRAGMENT_SHADER,
  VERTEX_SHADER,
  createFrameReceiver,
  createStage,
} = require('../src/host/avatar/spout-layer/stage.js');

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

/** Fake WebGL1 context: records every call the stage makes, returns plausible objects. */
function createFakeGl() {
  const calls = [];
  const deletedTextures = [];
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
  };
  gl.calls = calls;
  gl.deletedTextures = deletedTextures;
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

function createHarness({ width = 520, height = 800 } = {}) {
  const gl = createFakeGl();
  const timers = createFakeTimers();
  const canvas = { width: 0, height: 0 };
  const health = [];
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
    onHealth: (stats) => health.push(stats),
  });
  stage.resize(width, height);
  stage.start();
  return { gl, timers, canvas, stage, health };
}

const count = (gl, name) => gl.calls.filter((call) => call.name === name).length;
const lastCall = (gl, name) => [...gl.calls].reverse().find((call) => call.name === name) ?? null;

test('1. a texture frame arrives: one upload, one draw, frame closed, imported reference released', () => {
  const { gl, stage } = createHarness();
  try {
    const frame = createFakeFrame(64, 48);
    const imported = createFakeImported(frame);
    const received = [];
    const receive = createFrameReceiver({ stage, onFrame: (info) => received.push(info) });

    const result = receive(imported, { width: 64, height: 48, stableWidth: 64, stableHeight: 48 });

    assert.equal(result.ok, true, 'the frame is consumed');
    assert.equal(result.drawn, true, 'the frame is drawn');
    assert.equal(count(gl, 'texImage2D'), 1, 'first frame allocates + uploads the texture');
    assert.equal(count(gl, 'texSubImage2D'), 0, 'a new texture uses texImage2D, not texSubImage2D');
    assert.equal(count(gl, 'drawArrays'), 1, 'the quad is drawn exactly once');
    assert.equal(frame.closed, 1, 'the VideoFrame is closed exactly once');
    assert.equal(imported.released, 1, "the main process's imported reference is released exactly once");
    assert.equal(received.length, 1, 'the frame callback fires once');
    assert.equal(stage.stats().drawn, 1);
    assert.equal(stage.stats().textureWidth, 64);
    assert.equal(stage.stats().textureHeight, 48);
  } finally {
    stage.dispose();
  }
});

test('1b. a broken imported frame is released and never throws out of the receiver', () => {
  const { gl, stage } = createHarness();
  try {
    const imported = {
      released: 0,
      getVideoFrame() {
        throw new Error('native frame expired');
      },
      release() {
        this.released += 1;
      },
    };
    const receive = createFrameReceiver({ stage });
    const result = receive(imported, { width: 64, height: 48 });
    assert.equal(result.ok, false);
    assert.match(result.error, /native frame expired/u);
    assert.equal(imported.released, 1, 'the reference is still released on failure');
    assert.equal(count(gl, 'drawArrays'), 0);
  } finally {
    stage.dispose();
  }
});

test('2. premultiplied alpha: ONE / ONE_MINUS_SRC_ALPHA, no second alpha multiply, no UNPACK premultiply', () => {
  const { gl, stage } = createHarness();
  try {
    const frame = createFakeFrame(64, 64);
    const receive = createFrameReceiver({ stage });
    receive(createFakeImported(frame), { width: 64, height: 64 });

    // Canvas output convention: the compositor treats our canvas pixels as premultiplied.
    assert.equal(CONTEXT_ATTRIBUTES.premultipliedAlpha, true);
    assert.equal(CONTEXT_ATTRIBUTES.alpha, true);

    // Blending must be the premultiplied pair, exactly once, and never SRC_ALPHA.
    const blends = gl.calls.filter((call) => call.name === 'blendFunc');
    assert.ok(blends.length >= 1, 'the stage sets a blend function');
    for (const blend of blends) {
      assert.deepEqual(blend.args, [gl.ONE, gl.ONE_MINUS_SRC_ALPHA]);
      assert.notEqual(blend.args[0], gl.SRC_ALPHA);
    }

    // The source is already premultiplied: WebGL must not premultiply it again at upload.
    const stores = gl.calls.filter(
      (call) => call.name === 'pixelStorei' && call.args[0] === gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,
    );
    assert.ok(stores.length >= 1, 'the upload explicitly sets UNPACK_PREMULTIPLY_ALPHA_WEBGL');
    for (const store of stores) assert.equal(store.args[1], false);

    // Remove observed background contribution without multiplying foreground RGB by alpha again.
    assert.match(FRAGMENT_SHADER, /c.rgb - u_background \* \(1.0 - c.a\)/u);
    assert.doesNotMatch(FRAGMENT_SHADER, /c.rgb\s*\*\s*c.a/u);
    assert.doesNotMatch(FRAGMENT_SHADER, /\*\s*texture2D/u);
    assert.match(VERTEX_SHADER, /gl_Position\s*=\s*vec4\(a_position \* u_scale \+ u_offset/u);
  } finally {
    stage.dispose();
  }
});

test('3. no sender: transparent placeholder, health still reports size, no exception', () => {
  const gl = createFakeGl();
  const timers = createFakeTimers();
  const health = [];
  const stage = createStage({
    gl,
    now: timers.now,
    timers: {
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
    },
    onHealth: (stats) => health.push(stats),
  });
  try {
    stage.resize(520, 800);
    assert.doesNotThrow(() => stage.start());
    const stats = stage.stats();
    assert.equal(stats.placeholder, true, 'the transparent placeholder is showing');
    assert.equal(stats.drawn, 0, 'no texture frame has been drawn');
    assert.equal(stats.textureWidth, 0);
    assert.deepEqual(lastCall(gl, 'clearColor').args, [0, 0, 0, 0]);
    assert.ok(count(gl, 'clear') >= 1, 'the canvas is cleared to transparent');
    assert.equal(count(gl, 'drawArrays'), 0, 'the placeholder does not sample a texture');

    timers.tick(1000);
    assert.equal(health.length, 1, 'the 1 Hz health report fires');
    assert.equal(health[0].fps, 0);
    assert.equal(health[0].placeholder, true);
    assert.equal(health[0].width, 520);
    assert.equal(health[0].height, 800);
  } finally {
    stage.dispose();
  }
});

test('4. source size change: the old texture is deleted, the new one is allocated', () => {
  const { gl, stage } = createHarness();
  try {
    const receive = createFrameReceiver({ stage });
    receive(createFakeImported(createFakeFrame(64, 64)), { width: 64, height: 64 });
    const firstTexture = stage.texture;
    assert.equal(count(gl, 'texImage2D'), 1);

    receive(createFakeImported(createFakeFrame(32, 32)), { width: 32, height: 32 });
    const secondTexture = stage.texture;
    assert.equal(count(gl, 'texImage2D'), 2, 'a size change reallocates with texImage2D');
    assert.equal(count(gl, 'deleteTexture'), 1, 'the old texture is deleted, not leaked');
    assert.equal(gl.deletedTextures.length, 1);
    assert.equal(gl.deletedTextures[0], firstTexture);
    assert.notEqual(secondTexture, firstTexture);
    assert.equal(stage.stats().reallocations, 2);
    assert.equal(stage.stats().textureWidth, 32);

    // Same size again: no reallocation, just a cheap texSubImage2D upload.
    receive(createFakeImported(createFakeFrame(32, 32)), { width: 32, height: 32 });
    assert.equal(count(gl, 'texImage2D'), 2);
    assert.equal(count(gl, 'texSubImage2D'), 1);
    assert.equal(count(gl, 'deleteTexture'), 1);
  } finally {
    stage.dispose();
  }
});

test('5. stop releases the texture, program, shaders and buffers and leaves no timer behind', () => {
  const gl = createFakeGl();
  const timers = createFakeTimers();
  const stage = createStage({
    gl,
    now: timers.now,
    timers: {
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
    },
  });
  const receive = createFrameReceiver({ stage });
  stage.resize(320, 240);
  stage.start();
  receive(createFakeImported(createFakeFrame(64, 64)), { width: 64, height: 64 });
  assert.equal(timers.activeCount(), 2, 'health + placeholder timers are running');

  const texture = stage.texture;
  const disposed = stage.dispose();

  assert.equal(disposed, true);
  assert.equal(timers.activeCount(), 0, 'both timers are cleared');
  assert.ok(gl.deletedTextures.includes(texture), 'the texture is deleted');
  assert.equal(count(gl, 'deleteBuffer'), 1);
  assert.equal(count(gl, 'deleteProgram'), 1);
  assert.equal(count(gl, 'deleteShader'), 2);
  assert.equal(stage.dispose(), false, 'dispose is idempotent');
  assert.equal(count(gl, 'deleteProgram'), 1, 'a second dispose deletes nothing again');
  assert.equal(receive(createFakeImported(createFakeFrame(64, 64)), { width: 64, height: 64 }).drawn, false);
});

test('6. 60 frames at 60 Hz on a fake clock report a plausible fps', () => {
  const { timers, stage, health } = createHarness();
  try {
    const receive = createFrameReceiver({ stage });
    const frame = createFakeFrame(64, 64);
    const interval = 1000 / 60;
    for (let index = 0; index < 60; index += 1) {
      receive(createFakeImported(frame), { width: 64, height: 64 });
      timers.tick(interval);
    }
    // 60 × 16.666… = 999.96 ms: cross the 1 s boundary explicitly so the 1 Hz health report runs.
    timers.tick(interval);
    const stats = stage.stats();
    assert.ok(stats.fps >= 55 && stats.fps <= 65, `fps should be ~60, got ${stats.fps}`);
    assert.equal(stats.drawn, 60);
    assert.ok(health.length >= 1, 'health was reported during the second');
    const reported = health[health.length - 1];
    assert.ok(reported.fps >= 55 && reported.fps <= 65, `health fps should be ~60, got ${reported.fps}`);
  } finally {
    stage.dispose();
  }
});

test('7. the stable size comes from spout.size / size, or stays null for sender size', () => {
  const layer = new SpoutLayer({
    root: 'C:\\scratch\\spout-size-root',
    settings: () => ({ size: '978x844', electronExecutable: 'C:\\electron\\electron.exe' }),
  });
  assert.deepEqual(layer.size(), { width: 978, height: 844 });
  assert.deepEqual(layer.snapshot().configuredSize, { width: 978, height: 844 });

  const nested = new SpoutLayer({
    root: 'C:\\scratch\\spout-size-root-2',
    settings: () => ({ spout: { size: { width: 640, height: 480 } } }),
  });
  assert.deepEqual(nested.size(), { width: 640, height: 480 });

  const none = new SpoutLayer({ root: 'C:\\scratch\\spout-size-root-3', settings: () => ({}) });
  assert.equal(none.size(), null, 'no size means the sender size is used');
});
