/**
 * Spout layer edit mode — fake BrowserWindow + fake ipcMain, no real Electron runtime.
 *
 * The layer window switches between click-through and interactive. These cases pin the contract
 * the host relies on:
 *
 *   1. entering calls `setIgnoreMouseEvents(false)` and reports `spout.edit.enter`;
 *   2. leaving restores `setIgnoreMouseEvents(true, { forward: true })` and reports
 *      `spout.edit.exit` with the final bounds;
 *   3. dragging moves the window and throttles `spout.edit.bounds`, one final report per gesture;
 *   4. resizing clamps to the minimum and sends the exact viewport to the renderer (GL canvas);
 *   5. Escape leaves edit mode through the ordinary exit path;
 *   6. destroying the window while editing exits automatically and releases every IPC listener;
 *   7. the page reports the SCREEN-space drag distance (window-local coordinates would halve it);
 *   8. wheel zoom is edit-mode only, throttled, proportional and clamped to 64..4096;
 *   9. the Electron version policy: >= 28 passes, < 28 refuses with ELECTRON_VERSION_MISMATCH,
 *      an unreadable probe refuses, and a major far above the recommendation only warns.
 *
 * Cases 1 and 2 also drive the host-facing `SpoutLayer.setEditMode()` against a fake layer child,
 * proving the stdin command and the mirrored `spout.edit.*` events/bounds.
 *
 * Run: node --test test/spout-edit.mjs
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { MIN_ELECTRON_MAJOR, PINNED_ELECTRON_VERSION, SpoutLayer } from '../src/host/avatar/spoutLayer.js';

const require = createRequire(import.meta.url);
const { createEditMode } = require('../src/host/avatar/spout-layer/main.js');
const here = dirname(fileURLToPath(import.meta.url));
const rendererSource = readFileSync(join(here, '..', 'src', 'host', 'avatar', 'spout-layer', 'renderer.js'), 'utf8');

/** Fake BrowserWindow: records every mouse-mode change, rectangle and renderer message. */
function makeFakeWindow({ bounds = { x: 100, y: 200, width: 520, height: 800 } } = {}) {
  let current = { ...bounds };
  const mouse = [];
  const sent = [];
  return {
    getBounds: () => ({ ...current }),
    setBounds(next) {
      current = { x: next.x, y: next.y, width: next.width, height: next.height };
    },
    setIgnoreMouseEvents(ignore, options) {
      mouse.push({ ignore, options });
    },
    focus() {},
    setFocusable(enabled) { this.focusable = enabled; },
    setSkipTaskbar(enabled) { this.skipTaskbar = enabled; },
    webContents: {
      send(channel, payload) {
        sent.push({ channel, payload });
      },
    },
    mouse,
    sent,
  };
}

/** One controller wired to a fake window/ipc and a deterministic clock. */
function harness({ throttleMs = 50, start = 1000 } = {}) {
  let clock = start;
  const win = makeFakeWindow();
  const ipc = new EventEmitter();
  const events = [];
  const controller = createEditMode({
    win,
    ipc,
    now: () => clock,
    throttleMs,
    emit: (payload) => events.push(payload),
  });
  return {
    win,
    ipc,
    events,
    controller,
    advance: (ms) => { clock += ms; },
    eventNames: () => events.map((entry) => entry.event),
    of: (name) => events.filter((entry) => entry.event === name),
  };
}

/** Fake layer process: parses the stdin `edit` command and answers with one diagnostic line. */
function makeFakeLayerChild() {
  const child = new EventEmitter();
  child.pid = 424242;
  child.exitCode = null;
  child.signalCode = null;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdinWrites = [];
  child.stdin = {
    on() {},
    write(line) {
      child.stdinWrites.push(String(line));
      const message = JSON.parse(String(line));
      if (message.type !== 'edit') return true;
      const reply = {
        type: 'diagnostic',
        event: `spout.edit.${message.enabled === true ? 'enter' : 'exit'}`,
        bounds: { x: 120, y: 240, width: 500, height: 700 },
      };
      queueMicrotask(() => child.stdout.write(`${JSON.stringify(reply)}\n`));
      return true;
    },
  };
  return child;
}

function hostHarness() {
  const events = [];
  const layer = new SpoutLayer({
    root: 'C:\\fake\\spout-edit-root',
    settings: () => ({}),
    log: { emit: async (type, payload) => events.push({ type, payload }) },
  });
  const child = makeFakeLayerChild();
  layer.child = child;
  layer.attach(child);
  return { layer, child, events, of: (type) => events.filter((entry) => entry.type === type) };
}

test('1. entering edit mode enables interaction and reports spout.edit.enter', async () => {
  const h = harness();
  const result = h.controller.setEditMode(true);
  assert.equal(h.win.focusable, true);
  assert.equal(h.win.skipTaskbar, false);

  assert.equal(result.ok, true);
  assert.equal(result.editMode, true);
  const mouse = h.win.mouse.at(-1);
  assert.equal(mouse.ignore, false, 'setIgnoreMouseEvents(false) makes the window interactive');
  assert.equal(h.of('spout.edit.enter').length, 1, 'exactly one enter event');
  assert.deepEqual(h.of('spout.edit.enter')[0].bounds, { x: 100, y: 200, width: 520, height: 800 });
  assert.ok(h.win.sent.some((entry) => entry.channel === 'layer:edit:mode' && entry.payload.editMode === true));

  // Host-facing API: the command goes over stdin and the mirrored event is logged.
  const host = hostHarness();
  const entered = await host.layer.setEditMode(true);
  assert.equal(host.child.stdinWrites.length, 1);
  assert.deepEqual(JSON.parse(host.child.stdinWrites[0]), { type: 'edit', enabled: true, seq: 1 });
  assert.equal(entered.ok, true);
  assert.equal(entered.editMode, true);
  assert.equal(host.layer.snapshot().editMode, true);
  assert.equal(host.of('spout.edit.enter').length, 1);
});

test('2. leaving edit mode restores click-through and reports spout.edit.exit with bounds', async () => {
  const h = harness();
  h.controller.setEditMode(true);
  h.advance(10);
  h.controller.dragBy(30, 40);
  const result = h.controller.setEditMode(false);
  assert.equal(h.win.focusable, false);
  assert.equal(h.win.skipTaskbar, true);

  const mouse = h.win.mouse.at(-1);
  assert.equal(mouse.ignore, true);
  assert.deepEqual(mouse.options, { forward: true });
  const exits = h.of('spout.edit.exit');
  assert.equal(exits.length, 1);
  assert.deepEqual(exits[0].bounds, { x: 130, y: 240, width: 520, height: 800 });
  assert.deepEqual(result.bounds, { x: 130, y: 240, width: 520, height: 800 });

  const host = hostHarness();
  await host.layer.setEditMode(true);
  const exited = await host.layer.setEditMode(false);
  assert.equal(exited.ok, true);
  assert.deepEqual(exited.bounds, { x: 120, y: 240, width: 500, height: 700 }, 'the final rectangle is returned');
  assert.equal(host.layer.snapshot().editMode, false);
  assert.deepEqual(host.layer.snapshot().editBounds, { x: 120, y: 240, width: 500, height: 700 });
  const hostExit = host.of('spout.edit.exit');
  assert.equal(hostExit.length, 1);
  assert.deepEqual(hostExit[0].payload.bounds, { x: 120, y: 240, width: 500, height: 700 });
});

test('3. dragging moves the window and throttles spout.edit.bounds', () => {
  const h = harness();
  h.controller.setEditMode(true);

  h.advance(10);
  h.controller.dragBy(10, 5);
  h.advance(10);
  h.controller.dragBy(10, 5);
  h.advance(10);
  h.controller.dragBy(10, 5);

  assert.deepEqual(h.win.getBounds(), { x: 130, y: 215, width: 520, height: 800 }, 'the window really moved');
  assert.equal(h.of('spout.edit.bounds').length, 1, 'three moves inside 50 ms coalesce into one report');

  h.controller.finish();
  const reports = h.of('spout.edit.bounds');
  assert.equal(reports.length, 2, 'the gesture end adds exactly one unthrottled report');
  assert.deepEqual(reports[0].bounds, { x: 110, y: 205, width: 520, height: 800 });
  assert.deepEqual(reports[1].bounds, { x: 130, y: 215, width: 520, height: 800 });
});

test('4. resizing clamps and sends the exact viewport to the renderer', () => {
  const h = harness();
  h.controller.setEditMode(true);

  const grown = h.controller.resizeBy(40, 60);
  assert.deepEqual(grown.bounds, { x: 100, y: 200, width: 560, height: 860 });
  assert.deepEqual(h.win.getBounds(), { x: 100, y: 200, width: 560, height: 860 });
  const viewports = h.win.sent.filter((entry) => entry.channel === 'layer:edit:viewport');
  assert.equal(viewports.length, 1);
  assert.deepEqual(viewports[0].payload, { width: 560, height: 860 }, 'canvas/GL viewport follows the window');

  h.controller.resizeBy(-1000, -1000);
  assert.deepEqual(h.win.getBounds(), { x: 100, y: 200, width: 64, height: 64 }, 'minimum interactive size');
  assert.deepEqual(
    h.win.sent.filter((entry) => entry.channel === 'layer:edit:viewport').at(-1).payload,
    { width: 64, height: 64 },
  );
});

test('5. Escape leaves edit mode through the ordinary exit path', () => {
  const h = harness();
  h.controller.setEditMode(true);
  h.advance(10);
  h.controller.dragBy(5, 5);

  h.ipc.emit('layer:edit:escape', {}, {});

  assert.equal(h.controller.editMode, false);
  assert.equal(h.win.mouse.at(-1).ignore, true, 'click-through is restored by Escape');
  assert.deepEqual(h.win.mouse.at(-1).options, { forward: true });
  assert.equal(h.of('spout.edit.exit').length, 1);
  assert.equal(h.of('spout.edit.enter').length, 1);
});

test('6. destroying the window while editing exits and releases every IPC listener', () => {
  const h = harness();
  h.controller.setEditMode(true);
  assert.equal(h.ipc.listenerCount('layer:edit:drag'), 1);
  assert.equal(h.ipc.listenerCount('layer:edit:resize'), 1);
  assert.equal(h.ipc.listenerCount('layer:edit:escape'), 1);

  h.controller.dispose();

  assert.equal(h.controller.editMode, false);
  assert.equal(h.win.mouse.at(-1).ignore, true, 'dispose restores click-through');
  assert.equal(h.of('spout.edit.exit').length, 1, 'the final bounds are reported before teardown');
  assert.equal(h.ipc.listenerCount('layer:edit:drag'), 0);
  assert.equal(h.ipc.listenerCount('layer:edit:resize'), 0);
  assert.equal(h.ipc.listenerCount('layer:edit:escape'), 0);
  assert.doesNotThrow(() => h.controller.dispose(), 'dispose is idempotent');
});

/**
 * The shipped layer page, evaluated against a fake DOM. The page is an IIFE that only talks to the
 * outside world through `window.spoutLayer`; recording those calls is enough to prove which
 * coordinates and wheel deltas it sends, without launching Electron.
 */
function loadRenderer({ width = 520, height = 800 } = {}) {
  const listeners = new Map();
  const calls = { drag: [], resize: [], errors: [] };
  let editModeListener = null;
  const record = (bucket) => (type, handler) => {
    const key = `${bucket}:${type}`;
    const list = listeners.get(key) ?? [];
    list.push(handler);
    listeners.set(key, list);
  };
  const body = { style: {}, appendChild() {}, setPointerCapture() {} };
  const handle = { id: '', style: {}, appendChild() {} };
  const document = {
    getElementById: () => ({ width, height }),
    createElement: () => handle,
    body,
    addEventListener: record('document'),
  };
  const win = {
    innerWidth: width,
    innerHeight: height,
    addEventListener: record('window'),
    spoutLayer: {
      reportReady: () => {},
      reportError: (payload) => calls.errors.push(payload),
      stageStats: () => null,
      resizeStage: () => ({ ok: true }),
      startStage: async () => ({ ok: false, code: 'SHARED_TEXTURE_UNAVAILABLE' }),
      registerReceiver: async () => ({ ok: false }),
      receiverStatus: async () => ({ registered: false }),
      onEditMode: (callback) => {
        editModeListener = callback;
        return () => { editModeListener = null; };
      },
      editDrag: (dx, dy, done) => calls.drag.push({ dx, dy, done }),
      editResize: (dx, dy, done) => calls.resize.push({ dx, dy, done }),
      exitEdit: () => {},
    },
  };
  // The page is a classic script, not a module: evaluating it with the globals it expects is the
  // closest thing to a BrowserWindow without starting one.
  new Function(
    'window', 'document', 'requestAnimationFrame', 'setTimeout', 'clearTimeout',
    rendererSource,
  )(win, document, () => 0, setTimeout, clearTimeout);
  return {
    calls,
    handle,
    setEditing: (editMode) => editModeListener?.({ editMode }),
    fire: (bucket, type, event = {}) => {
      for (const handler of listeners.get(`${bucket}:${type}`) ?? []) handler(event);
    },
  };
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

test('7. dragging reports the screen-space distance, not the window-local one', () => {
  const r = loadRenderer();
  r.setEditing(true);
  const down = {
    button: 0,
    target: {},
    pointerId: 1,
    screenX: 200,
    screenY: 300,
    clientX: 200,
    clientY: 300,
    preventDefault() {},
  };
  r.fire('document', 'pointerdown', down);

  // The cursor travelled 40 px on screen. The window moved with it, so the window-local client
  // coordinates barely change: only screen coordinates can report the real distance.
  r.fire('window', 'pointermove', { screenX: 240, screenY: 340, clientX: 200, clientY: 300 });
  assert.deepEqual(r.calls.drag, [{ dx: 40, dy: 40, done: false }], 'the delta equals the screen travel');

  // A second move continues from the last screen position.
  r.fire('window', 'pointermove', { screenX: 250, screenY: 355, clientX: 200, clientY: 300 });
  assert.deepEqual(r.calls.drag.at(-1), { dx: 10, dy: 15, done: false });

  r.fire('window', 'pointerup');
  assert.deepEqual(r.calls.drag.at(-1), { dx: 0, dy: 0, done: true }, 'one final done frame per gesture');
});

test('8. wheel zoom is edit-mode only, proportional, throttled and clamped to 64..4096', async () => {
  // A. Proportional growth: three notches inside one throttle window become one resize message.
  const growing = loadRenderer({ width: 520, height: 800 });
  growing.setEditing(true);
  for (let notch = 0; notch < 3; notch += 1) {
    growing.fire('window', 'wheel', { deltaY: -100, preventDefault() {} });
  }
  await sleep(80);
  assert.equal(growing.calls.resize.length, 1, 'three wheel events are coalesced into one message');
  const factor = Math.exp(0.1) ** 3;
  const grownWidth = Math.round(520 * factor);
  const grownHeight = Math.round(800 * factor);
  assert.deepEqual(growing.calls.resize[0], {
    dx: grownWidth - 520,
    dy: grownHeight - 800,
    done: false,
  }, 'the size change is proportional to the window');

  // The delta really resizes the window through the shipped main-process path, and the bounds
  // report stays throttled to one per interval.
  const h = harness({ throttleMs: 50 });
  h.controller.setEditMode(true);
  h.ipc.emit('layer:edit:resize', {}, { dx: grownWidth - 520, dy: grownHeight - 800 });
  assert.deepEqual(h.win.getBounds(), { x: 100, y: 200, width: grownWidth, height: grownHeight });
  assert.equal(h.of('spout.edit.bounds').length, 1, 'one throttled bounds report for the change');
  h.ipc.emit('layer:edit:resize', {}, { dx: 1, dy: 1 });
  assert.equal(h.of('spout.edit.bounds').length, 1, 'a second change inside 50 ms stays throttled');
  h.advance(60);
  h.ipc.emit('layer:edit:resize', {}, { dx: 1, dy: 1 });
  assert.equal(h.of('spout.edit.bounds').length, 2, 'the next interval reports again');

  // B. A click-through (non-edit) window ignores the wheel entirely.
  const idle = loadRenderer();
  idle.fire('window', 'wheel', { deltaY: -100 });
  await sleep(80);
  assert.equal(idle.calls.resize.length, 0, 'the wheel does nothing outside edit mode');

  // C. Shrinking clamps at the 64 px floor (4 notches of 0.5× would reach 33/50 px).
  const shrinking = loadRenderer();
  shrinking.setEditing(true);
  for (let notch = 0; notch < 4; notch += 1) {
    shrinking.fire('window', 'wheel', { deltaY: 4000, preventDefault() {} });
  }
  await sleep(80);
  assert.deepEqual(shrinking.calls.resize[0], { dx: 64 - 520, dy: 64 - 800, done: false });

  // D. Growing clamps at the 4096 px ceiling (3 notches of 2× would reach 4160/6400 px).
  const huge = loadRenderer();
  huge.setEditing(true);
  for (let notch = 0; notch < 3; notch += 1) {
    huge.fire('window', 'wheel', { deltaY: -4000, preventDefault() {} });
  }
  await sleep(80);
  assert.deepEqual(huge.calls.resize[0], { dx: 4096 - 520, dy: 4096 - 800, done: false });

  // E. Leaving edit mode cancels a pending flush.
  const leaving = loadRenderer();
  leaving.setEditing(true);
  leaving.fire('window', 'wheel', { deltaY: -100 });
  leaving.setEditing(false);
  await sleep(80);
  assert.equal(leaving.calls.resize.length, 0, 'a flush scheduled before exit is discarded');
});

// ---- Electron version policy -------------------------------------------------------------
// The layer only uses stable Electron APIs, so the major is a *minimum* plus a warning band, not
// a pin. `run()` is stubbed: validation is exercised without launching a real runtime.

/** A real file tree that passes `looksLikeElectron()`; the probe is whatever the case needs. */
function versionHarness({ output = '', failure = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'spout-version-'));
  const exe = join(dir, 'electron.exe');
  writeFileSync(exe, 'stub');
  writeFileSync(join(dir, 'chrome_100_percent.pak'), '');
  const events = [];
  const layer = new SpoutLayer({
    root: join(dir, 'root'),
    settings: () => ({}),
    log: { emit: async (type, payload) => events.push({ type, payload }) },
  });
  layer.run = async () => {
    if (failure !== null) throw failure;
    return output;
  };
  return {
    dir,
    exe,
    layer,
    events,
    of: (type) => events.filter((entry) => entry.type === type),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('9. Electron 45.2.3 passes with no error and no warning', async (t) => {
  const h = versionHarness({ output: 'v45.2.3\n' });
  t.after(h.cleanup);

  const result = await h.layer.validate(h.exe);
  assert.equal(result.ok, true);
  assert.equal(result.code, '');
  assert.equal(result.version, '45.2.3');
  assert.equal(h.events.length, 0, 'a newer-than-recommended major inside +3 does not warn');
});

test('10. Electron 28.0.0, the lower bound, passes', async (t) => {
  assert.equal(MIN_ELECTRON_MAJOR, 28);
  const h = versionHarness({ output: 'Electron 28.0.0\n' });
  t.after(h.cleanup);

  const result = await h.layer.validate(h.exe);
  assert.equal(result.ok, true);
  assert.equal(result.code, '');
  assert.equal(result.version, '28.0.0');
  assert.equal(h.events.length, 0);
});

test('11. Electron 27.x is refused with ELECTRON_VERSION_MISMATCH', async (t) => {
  const h = versionHarness({ output: 'v27.3.11\n' });
  t.after(h.cleanup);

  const result = await h.layer.validate(h.exe);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'ELECTRON_VERSION_MISMATCH');
  assert.equal(result.version, '27.3.11');
  assert.match(result.message, new RegExp(`需要 >= ${MIN_ELECTRON_MAJOR}`, 'u'));
  assert.equal(h.events.length, 0, 'a refusal is not a warning');
});

test('12. an unreadable version is refused instead of accepted', async (t) => {
  const failure = Object.assign(new Error('spawn EACCES'), { code: 'EACCES' });
  const broken = versionHarness({ failure });
  t.after(broken.cleanup);

  const result = await broken.layer.validate(broken.exe);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'ELECTRON_VERSION_UNREADABLE');
  assert.match(result.message, /无法读取版本/u);

  // A probe that exits 0 but prints nothing parseable is unreadable too, not "unknown major".
  const garbage = versionHarness({ output: 'definitely not a version' });
  t.after(garbage.cleanup);
  const second = await garbage.layer.validate(garbage.exe);
  assert.equal(second.ok, false);
  assert.equal(second.code, 'ELECTRON_VERSION_UNREADABLE');
  assert.match(second.message, /无法读取版本/u);
});

test('13. a major far above the recommendation passes and records electron.version.unpinned', async (t) => {
  const h = versionHarness({ output: 'v48.0.0\n' });
  t.after(h.cleanup);

  const result = await h.layer.validate(h.exe);
  assert.equal(result.ok, true);
  assert.equal(result.code, '');
  assert.equal(result.version, '48.0.0');
  const warnings = h.of('electron.version.unpinned');
  assert.equal(warnings.length, 1, 'exactly one WARN event');
  assert.deepEqual(warnings[0].payload, {
    actual: '48.0.0',
    recommended: PINNED_ELECTRON_VERSION,
  });

  // Recommended + 3 is still inside the verified band.
  const edge = versionHarness({ output: 'v47.0.0\n' });
  t.after(edge.cleanup);
  const accepted = await edge.layer.validate(edge.exe);
  assert.equal(accepted.ok, true);
  assert.equal(edge.events.length, 0, 'recommended+3 does not warn');
});

