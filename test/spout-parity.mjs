/**
 * Spout edit mode = the real VTube Studio window, not the overlay.
 *
 * The contract (the one the user asked for):
 *   edit ON  → stop the display process (confirmed) → put VTS back on screen in its own geometry
 *              → the user drags/resizes VTS itself;
 *   edit OFF → read the VTS rectangle → park VTS off screen → start the display process with
 *              exactly that rectangle, so the model reappears in place with no manual start.
 *
 * The six cases below pin that state machine:
 *
 *   1. edit ON stops the display process and restores VTS; the two never run together;
 *   2. edit OFF runs capture → hide → start, and the start bounds equal the captured rectangle;
 *   3. in-place appearance: VTS {300,200,500,700} → display process bounds {300,200,500,700};
 *   4. the `layerEdit` hotkey toggles the session under backend=spout (also when the display
 *      process is not running yet — the old LAYER_NOT_RUNNING dead end);
 *   5. an unreadable VTS falls back to the saved `layer.spout.bounds` and still starts the display;
 *   6. a failed display start rolls back to the edit session (VTS visible) and reports the error.
 *
 * No real Electron, PowerShell, VTS or `window-move.ps1` is started: the window controller is a
 * recorder, the display process is an EventEmitter that answers the shutdown handshake.
 * Run: `node --test test/spout-parity.mjs`
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { createLayerEditController } from '../src/host/index.js';
import { WPF_OFFSCREEN } from '../src/host/avatar/avatarLayer.js';
import { SpoutLayer } from '../src/host/avatar/spoutLayer.js';
import { VTS_OFFSCREEN } from '../src/host/avatar/spout-layer/vts-window.mjs';

/** The VTS window when Spout takes over; the display process is started in this rectangle. */
const ORIGINAL = { x: 120, y: 80, width: 900, height: 1200 };
const HIDDEN = {
  x: VTS_OFFSCREEN.x,
  y: VTS_OFFSCREEN.y,
  width: ORIGINAL.width,
  height: ORIGINAL.height,
};
/** Stage-0 / last-saved display geometry (settings `bounds`). */
const SAVED = { x: 140, y: 100, width: 600, height: 760 };

/** Recording stand-in for `VtsWindow`: every capture/move is observable, in order. */
function fakeVts({ initial = ORIGINAL } = {}) {
  let current = { ...initial };
  const calls = { capture: 0, move: 0 };
  const moves = [];
  const log = [];
  return {
    calls,
    moves,
    log,
    failCapture: false,
    failMove: false,
    get bounds() {
      return { ...current };
    },
    /** Simulate the user dragging/resizing the real window inside VTube Studio. */
    place(rect) {
      current = { ...rect };
    },
    async capture() {
      calls.capture += 1;
      log.push('capture');
      if (this.failCapture) return { ok: false, code: 'VTS_NOT_RUNNING', message: 'no-vts' };
      return { ok: true, bounds: { ...current } };
    },
    async move(rect) {
      calls.move += 1;
      log.push(['move', { ...rect }]);
      moves.push({ ...rect });
      if (this.failMove) return { ok: false, code: 'VTS_NOT_RUNNING', message: 'no-vts' };
      current = { ...rect };
      return { ok: true, bounds: { ...rect } };
    },
  };
}

/** Fake display process: answers `shutdown` like the real layer (ack, then exit/close). */
function fakeLayerChild() {
  const child = new EventEmitter();
  child.pid = 0;
  child.exitCode = null;
  child.signalCode = null;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdinWrites = [];
  child.exited = false;
  child.stdin = {
    on() {},
    write(line) {
      child.stdinWrites.push(String(line));
      const message = JSON.parse(String(line));
      if (message.type !== 'shutdown') return true;
      queueMicrotask(() => {
        if (child.exitCode !== null) return;
        child.stdout.write(`${JSON.stringify({ type: 'shutdown-ack', seq: message.seq })}\n`);
        child.exitCode = 0;
        child.exited = true;
        child.emit('exit', 0, null);
        child.emit('close', 0);
      });
      return true;
    },
  };
  return child;
}

let nextPid = 500_000;

/** Start a real SpoutLayer against a fake display process and a fake VTS controller. */
async function runningLayer({
  vts = fakeVts(),
  settings = { bounds: { ...SAVED } },
  validate = async () => ({ ok: true, path: 'electron.exe', version: '44.7.0' }),
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'spout-parity-'));
  const events = [];
  const spawned = [];
  const args = [];
  const layer = new SpoutLayer({
    root,
    settings: () => settings,
    log: { emit: async (type, payload) => events.push({ type, payload }) },
    vtsWindow: vts,
  });
  // Keep the launch deterministic and offline: no Electron probe, no WMI ownership query.
  layer.validate = validate;
  layer.cleanupStale = async () => ({ ok: true });
  layer.processCreatedAt = async () => '2026-11-06T00:00:00.000Z';
  layer.descendantPids = async () => [];
  layer.spawnProcess = (_exe, spawnArgs) => {
    const child = fakeLayerChild();
    child.pid = (nextPid += 1);
    spawned.push(child);
    args.push(spawnArgs);
    return child;
  };
  // Count the real stop/mutual-exclusion calls without changing what they do.
  let stopCalls = 0;
  const stop = layer.stop.bind(layer);
  layer.stop = async (options) => {
    stopCalls += 1;
    return stop(options);
  };
  const started = await layer.start();
  return {
    layer,
    vts,
    events,
    spawned,
    args,
    started,
    stopCalls: () => stopCalls,
    of: (type) => events.filter((entry) => entry.type === type),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** `--dsh-bounds=x,y,w,h` from the last spawn, as `{x,y,width,height}` (null when absent). */
function spawnBounds(spawnArgs) {
  const line = (spawnArgs ?? []).find((arg) => String(arg).startsWith('--dsh-bounds='));
  if (line === undefined) return null;
  const [x, y, width, height] = String(line).slice('--dsh-bounds='.length).split(',').map(Number);
  return { x, y, width, height };
}

/** The rectangle the display process was actually asked to occupy. */
function displayBounds(layer) {
  const bounds = layer.snapshot().bounds;
  return bounds === null ? null : { x: bounds.left, y: bounds.top, width: bounds.width, height: bounds.height };
}

test('1. edit ON stops the display process and restores VTS; never both at once', async (t) => {
  const h = await runningLayer();
  t.after(h.cleanup);

  assert.equal(h.started.ok, true);
  assert.equal(h.layer.snapshot().running, true, 'the display process runs before editing');
  assert.equal(h.layer.snapshot().vtsWindow.hidden, true, 'VTS is parked off screen while Spout displays');
  assert.deepEqual(h.vts.bounds, HIDDEN);

  const entered = await h.layer.setEditMode(true);
  assert.equal(entered.ok, true);
  assert.equal(entered.editMode, true);
  assert.equal(h.layer.isEditing(), true);
  assert.equal(h.layer.snapshot().editSession, 'vts');

  // The display process was stopped and confirmed gone before VTS came back.
  assert.ok(h.stopCalls() >= 1, 'setEditMode(true) calls stop()');
  assert.equal(h.layer.snapshot().running, false, 'no display process runs while VTS is editable');
  assert.equal(h.spawned[0].exited, true, 'the first display process really exited');

  // VTS is visible again, at the geometry it had when Spout took over.
  assert.equal(h.layer.snapshot().vtsWindow.hidden, false);
  assert.deepEqual(h.vts.bounds, ORIGINAL, 'VTS is restored to its original rectangle');
  assert.deepEqual(h.of('spout.vts.restored').at(-1).payload, ORIGINAL);
  assert.deepEqual(h.of('spout.edit.enter'), [{
    type: 'spout.edit.enter',
    payload: { backend: 'vts', bounds: ORIGINAL, vts: { ok: true, code: '' } },
  }]);

  // Mutual exclusion is enforced by start() itself: a display process cannot join an edit session.
  const refused = await h.layer.start();
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'EDIT_MODE_ACTIVE');
  assert.equal(h.spawned.length, 1, 'no second display process was spawned');
  assert.equal(h.of('spout.vts.aligned').length, 0, 'edit mode never aligns the VTS window');
  t.diagnostic(`stop() calls=${h.stopCalls()} · running ${true}→${h.layer.snapshot().running} · VTS visible=${!h.layer.snapshot().vtsWindow.hidden} @ ${JSON.stringify(h.vts.bounds)} · start() during edit → ${refused.code}`);
});

test('2. edit OFF runs capture → hide → start, with the captured rectangle as display bounds', async (t) => {
  const h = await runningLayer();
  t.after(h.cleanup);

  await h.layer.setEditMode(true);
  // The user drags/resizes the real VTS window inside VTube Studio.
  const CAPTURED = { x: 160, y: 240, width: 640, height: 900 };
  h.vts.place(CAPTURED);
  const from = h.vts.log.length;

  const exited = await h.layer.setEditMode(false);
  assert.equal(exited.ok, true);
  assert.equal(exited.editMode, false);
  assert.equal(h.layer.isEditing(), false);

  const sequence = h.vts.log.slice(from).map((entry) => (entry === 'capture' ? 'capture' : entry[0]));
  assert.deepEqual(sequence, ['capture', 'move'], 'the rectangle is read BEFORE VTS is parked');
  assert.deepEqual(h.vts.log.slice(from)[1][1], {
    x: VTS_OFFSCREEN.x,
    y: VTS_OFFSCREEN.y,
    width: 640,
    height: 900,
  }, 'VTS is hidden at the size the user left it');

  assert.equal(h.spawned.length, 2, 'the display process started automatically — no manual 启动');
  assert.deepEqual(spawnBounds(h.args.at(-1)), { x: 160, y: 240, width: 640, height: 900 });
  assert.deepEqual(displayBounds(h.layer), { x: 160, y: 240, width: 640, height: 900 });
  assert.equal(h.layer.snapshot().boundsSource, 'edit', 'the rectangle came from the edit session');
  assert.equal(h.layer.snapshot().running, true);
  assert.equal(h.layer.snapshot().vtsWindow.hidden, true, 'VTS is off screen once Spout displays');

  assert.deepEqual(h.of('spout.edit.exit').at(-1).payload, {
    backend: 'vts',
    bounds: { x: 160, y: 240, width: 640, height: 900 },
    fallback: false,
    vts: { ok: true, code: '' },
  });
  assert.deepEqual(h.of('spout.display.autostarted').at(-1).payload, {
    bounds: { x: 160, y: 240, width: 640, height: 900 },
    pid: h.spawned.at(-1).pid,
    fallback: false,
  });
  t.diagnostic(`VTS order=${sequence.join('→')} · captured=${JSON.stringify(CAPTURED)} · --dsh-bounds=${JSON.stringify(spawnBounds(h.args.at(-1)))} · equal=${JSON.stringify(displayBounds(h.layer)) === JSON.stringify(CAPTURED)} · spawns=${h.spawned.length}`);
});

test('3. in-place appearance: VTS {300,200,500,700} → display bounds are exactly the same', async (t) => {
  const h = await runningLayer();
  t.after(h.cleanup);

  await h.layer.setEditMode(true);
  const LEFT_AT = { x: 300, y: 200, width: 500, height: 700 };
  h.vts.place(LEFT_AT);

  const exited = await h.layer.setEditMode(false);
  assert.equal(exited.ok, true);

  // What the host read from VTS is what it asked Electron to occupy: same x, y, width, height.
  assert.deepEqual(exited.bounds, LEFT_AT, 'the session reports the VTS rectangle it read');
  assert.deepEqual(spawnBounds(h.args.at(-1)), LEFT_AT, 'the --dsh-bounds argument is identical');
  assert.deepEqual(displayBounds(h.layer), LEFT_AT);
  assert.deepEqual(h.of('spout.display.autostarted').at(-1).payload.bounds, LEFT_AT);
  assert.equal(h.layer.snapshot().vtsWindow.hidden, true, 'VTS is gone, so the model flashes in place');
  t.diagnostic(`VTS left at=${JSON.stringify(LEFT_AT)} · --dsh-bounds=${JSON.stringify(spawnBounds(h.args.at(-1)))} · display.bounds=${JSON.stringify(displayBounds(h.layer))} · identical=${JSON.stringify(spawnBounds(h.args.at(-1))) === JSON.stringify(LEFT_AT)}`);
});

test('4. the layerEdit hotkey toggles the session under backend=spout (even with no display running)', async (t) => {
  const h = await runningLayer();
  t.after(h.cleanup);

  const stored = [];
  const calls = [];
  const wpfCalls = [];
  const edit = createLayerEditController({
    read: () => ({ layer: { backend: 'spout' } }),
    write: (patch) => stored.push(patch),
    log: { emit: async () => {} },
    layers: {
      wpf: {
        editing: () => false,
        setEditMode: async (enabled) => {
          wpfCalls.push(enabled);
          return { ok: true, editMode: enabled, bounds: null };
        },
      },
      spout: {
        editing: () => h.layer.isEditing(),
        setEditMode: async (enabled) => {
          calls.push(enabled);
          return h.layer.setEditMode(enabled);
        },
      },
    },
  });

  const entered = await edit.toggle();
  assert.equal(entered.ok, true);
  assert.deepEqual(calls, [true], 'the hotkey called setEditMode(true) on the Spout layer');
  const afterEnter = h.layer.snapshot().running;
  assert.equal(h.layer.isEditing(), true);
  assert.equal(afterEnter, false);
  assert.equal(wpfCalls.length, 0, 'the WPF backend received nothing');

  h.vts.place({ x: 200, y: 260, width: 560, height: 820 });
  const exited = await edit.toggle();
  assert.equal(exited.ok, true);
  assert.deepEqual(calls, [true, false], 'the same hotkey called setEditMode(false)');
  const afterExit = h.layer.snapshot().running;
  assert.equal(h.layer.isEditing(), false);
  assert.equal(afterExit, true);
  assert.deepEqual(spawnBounds(h.args.at(-1)), { x: 200, y: 260, width: 560, height: 820 });
  assert.deepEqual(stored.at(-1).layer.spout.bounds, { x: 200, y: 260, width: 560, height: 820 });

  // The old dead end: the display process was never started (backend=spout at boot, no manual
  // start). The hotkey must still enter edit mode (show VTS) and autostart the display on exit.
  const idle = await runningLayer();
  t.after(idle.cleanup);
  await idle.layer.stop(); // back to "no display process", VTS on screen
  idle.vts.place({ x: 90, y: 70, width: 880, height: 1180 });
  const coldEnter = await idle.layer.setEditMode(true);
  assert.equal(coldEnter.ok, true, 'edit mode no longer requires a running display process');
  assert.equal(idle.layer.isEditing(), true);
  assert.equal(idle.layer.snapshot().running, false);

  idle.vts.place({ x: 260, y: 180, width: 520, height: 760 });
  const coldExit = await idle.layer.setEditMode(false);
  assert.equal(coldExit.ok, true, 'leaving edit mode autostarts the display process');
  assert.deepEqual(spawnBounds(idle.args.at(-1)), { x: 260, y: 180, width: 520, height: 760 });
  assert.equal(idle.layer.snapshot().running, true);
  t.diagnostic(`hotkey calls=${JSON.stringify(calls)} · running after enter=${afterEnter} → after exit=${afterExit} · VTS {200,260,560,820} → --dsh-bounds=${JSON.stringify(spawnBounds(h.args.at(-1)))} · cold enter without a display=${coldEnter.ok} · cold exit bounds=${JSON.stringify(spawnBounds(idle.args.at(-1)))}`);
});

test('5. an unreadable VTS falls back to layer.spout.bounds and still starts the display', async (t) => {
  // Mutable settings: the last persisted session bounds (layer.spout.bounds) are what the
  // fallback must use, not the stale rectangle the display process was originally started with.
  const settings = { bounds: { ...SAVED } };
  const h = await runningLayer({ settings });
  t.after(h.cleanup);

  await h.layer.setEditMode(true);
  settings.bounds = { x: 210, y: 130, width: 480, height: 720 }; // an older edit session's result
  h.vts.failCapture = true;

  const exited = await h.layer.setEditMode(false);
  assert.equal(exited.ok, true, 'a missing VTS never blocks leaving edit mode');
  assert.equal(exited.fallback, true);
  assert.deepEqual(exited.bounds, { x: 210, y: 130, width: 480, height: 720 });
  assert.deepEqual(spawnBounds(h.args.at(-1)), { x: 210, y: 130, width: 480, height: 720 });
  assert.deepEqual(displayBounds(h.layer), { x: 210, y: 130, width: 480, height: 720 });
  assert.equal(h.layer.snapshot().running, true);

  const fallbackEvents = h.of('spout.edit.exit.fallback');
  assert.equal(fallbackEvents.length, 1);
  assert.equal(fallbackEvents[0].payload.code, 'VTS_NOT_RUNNING');
  assert.deepEqual(fallbackEvents[0].payload.bounds, { x: 210, y: 130, width: 480, height: 720 });
  assert.deepEqual(h.of('spout.display.autostarted').at(-1).payload.bounds, {
    x: 210,
    y: 130,
    width: 480,
    height: 720,
  });
  t.diagnostic(`capture failed (${fallbackEvents[0].payload.code}) · fallback=${JSON.stringify(exited.bounds)} · --dsh-bounds=${JSON.stringify(spawnBounds(h.args.at(-1)))} · running=${h.layer.snapshot().running}`);
});

test('6. a failed display start returns to edit mode with VTS visible and reports the error', async (t) => {
  const h = await runningLayer();
  t.after(h.cleanup);

  await h.layer.setEditMode(true);
  const LEFT_AT = { x: 240, y: 160, width: 620, height: 860 };
  h.vts.place(LEFT_AT);
  h.layer.validate = async () => ({ ok: false, code: 'ELECTRON_EXE_UNSET', message: '未配置 Electron 路径' });

  const exited = await h.layer.setEditMode(false);
  assert.equal(exited.ok, false);
  assert.equal(exited.code, 'ELECTRON_EXE_UNSET');
  assert.equal(h.layer.isEditing(), true, 'the edit session survives a failed start');
  assert.equal(h.layer.snapshot().running, false, 'no display process is running');
  assert.equal(h.layer.snapshot().vtsWindow.hidden, false, 'VTS is back on screen — no blank state');
  assert.deepEqual(h.vts.bounds, LEFT_AT, 'and it is back at the rectangle the user left');
  assert.equal(h.spawned.length, 1, 'nothing new was spawned');

  assert.equal(h.of('spout.edit.exit').length, 0, 'a failed exit is not reported as a success');
  const failed = h.of('spout.edit.exit.start-failed');
  assert.equal(failed.length, 1);
  assert.equal(failed[0].payload.code, 'ELECTRON_EXE_UNSET');
  assert.deepEqual(failed[0].payload.bounds, LEFT_AT);
  const afterFailure = {
    editing: h.layer.isEditing(),
    visible: !h.layer.snapshot().vtsWindow.hidden,
    vts: { ...h.vts.bounds },
    spawns: h.spawned.length,
  };

  // A retry after the runtime is fixed really leaves edit mode and starts in place.
  h.layer.validate = async () => ({ ok: true, path: 'electron.exe', version: '44.7.0' });
  const retried = await h.layer.setEditMode(false);
  assert.equal(retried.ok, true);
  assert.equal(h.layer.isEditing(), false);
  assert.deepEqual(spawnBounds(h.args.at(-1)), LEFT_AT);
  t.diagnostic(`start failure=${failed[0].payload.code} · editing after failure=${afterFailure.editing} · VTS visible=${afterFailure.visible} @ ${JSON.stringify(afterFailure.vts)} · spawns at failure=${afterFailure.spawns} · retry running=${h.layer.snapshot().running} bounds=${JSON.stringify(spawnBounds(h.args.at(-1)))}`);
});

test('7. VTS parked at the WPF capture corner restores to an editable rectangle', async (t) => {
  // The switch moves VTS to the WPF OFFSCREEN geometry before starting WPF (that is the only spot
  // PrintWindow can capture). When Spout takes over again, the remembered "where VTS was" must be
  // an editable rectangle, not the capture corner, or entering edit mode would show nothing.
  assert.deepEqual(WPF_OFFSCREEN, VTS_OFFSCREEN, 'both backends use the same capture corner');
  assert.deepEqual(WPF_OFFSCREEN, { x: -2200, y: -1400, width: 900, height: 1200 });

  const vts = fakeVts({ initial: { ...WPF_OFFSCREEN } });
  const h = await runningLayer({ vts, settings: { bounds: { ...SAVED } } });
  t.after(h.cleanup);

  // VTS was captured while parked in the corner; that rectangle is not a valid restore target, so
  // the saved visible geometry is remembered instead.
  assert.deepEqual(h.layer.vtsSnapshot().original, SAVED, 'the capture corner is not remembered');
  assert.deepEqual(h.vts.bounds, {
    x: VTS_OFFSCREEN.x,
    y: VTS_OFFSCREEN.y,
    width: SAVED.width,
    height: SAVED.height,
  }, 'VTS is hidden at the editable size');

  const entered = await h.layer.setEditMode(true);
  assert.equal(entered.ok, true);
  assert.equal(h.layer.isEditing(), true);
  assert.deepEqual(h.vts.bounds, SAVED, 'edit mode brings VTS back to a visible rectangle');
  t.diagnostic(`WPF corner=${JSON.stringify(WPF_OFFSCREEN)} · Spout corner=${JSON.stringify(VTS_OFFSCREEN)} · editable restore=${JSON.stringify(h.vts.bounds)}`);
});

test('8. an unavailable VTS on edit ON rolls the display process back', async (t) => {
  const h = await runningLayer();
  t.after(h.cleanup);
  // VTS cannot be moved back on screen: restoring it fails with VTS_NOT_RUNNING.
  h.vts.failMove = true;
  let startCalls = 0;
  const realStart = h.layer.start.bind(h.layer);
  h.layer.start = async (options) => {
    startCalls += 1;
    return realStart(options);
  };

  const entered = await h.layer.setEditMode(true);

  assert.equal(entered.ok, false, 'entering edit mode is a failure when VTS cannot be shown');
  assert.equal(entered.code, 'EDIT_VTS_UNAVAILABLE');
  assert.equal(entered.editMode, false);
  assert.equal(h.layer.isEditing(), false, 'no edit session is open without a VTS window');
  assert.equal(entered.vts.error?.code, 'VTS_NOT_RUNNING', 'the VTS cause is not hidden');
  assert.equal(startCalls, 1, 'the display process is restarted exactly once');
  assert.equal(h.spawned.length, 2, 'the stopped display process was replaced');
  assert.equal(h.layer.snapshot().running, true, 'the pre-edit surface is back');
  assert.deepEqual(spawnBounds(h.args.at(-1)), SAVED, 'it comes back in its previous rectangle');
  assert.equal(h.of('spout.edit.enter').length, 0, 'a failure is never reported as a successful enter');
  const failed = h.of('spout.edit.enter.failed').at(-1);
  assert.equal(failed.payload.code, 'EDIT_VTS_UNAVAILABLE');
  assert.equal(failed.payload.vtsCode, 'VTS_NOT_RUNNING');
  assert.equal(failed.payload.rollback.ok, true);
  t.diagnostic(`enter=${entered.code} · editMode=${entered.editMode} · start calls=${startCalls} · running=${h.layer.snapshot().running} · bounds=${JSON.stringify(spawnBounds(h.args.at(-1)))}`);
});

test('9. a failed display rollback reports EDIT_ROLLBACK_FAILED with no edit session', async (t) => {
  const h = await runningLayer();
  t.after(h.cleanup);
  h.vts.failMove = true;
  // The rollback cannot spawn: the configured runtime is gone.
  h.layer.validate = async () => ({ ok: false, code: 'ELECTRON_EXE_UNSET', message: '未配置 Electron 路径' });
  let startCalls = 0;
  const realStart = h.layer.start.bind(h.layer);
  h.layer.start = async (options) => {
    startCalls += 1;
    return realStart(options);
  };

  const entered = await h.layer.setEditMode(true);

  assert.equal(entered.ok, false);
  assert.equal(entered.code, 'EDIT_ROLLBACK_FAILED');
  assert.equal(entered.editMode, false);
  assert.equal(h.layer.isEditing(), false);
  assert.equal(h.layer.snapshot().editMode, false);
  assert.equal(startCalls, 1, 'the rollback was attempted');
  assert.equal(h.spawned.length, 1, 'the failed rollback started no display process');
  assert.equal(h.layer.snapshot().running, false);
  assert.equal(entered.rollback.ok, false);
  assert.equal(h.of('spout.edit.enter').length, 0);
  t.diagnostic(`enter=${entered.code} · rollback=${entered.rollback.code} · editMode=${entered.editMode} · start calls=${startCalls} · running=${h.layer.snapshot().running}`);
});

test('10. the off-screen capture rectangle is recorded apart from the user rectangle', async (t) => {
  const h = await runningLayer({ settings: { bounds: { ...SAVED } } });
  t.after(h.cleanup);

  const snapshot = h.layer.snapshot();
  assert.deepEqual(snapshot.bounds, { left: SAVED.x, top: SAVED.y, width: SAVED.width, height: SAVED.height },
    'the display bounds stay the user rectangle');
  assert.deepEqual(snapshot.captureRect, { x: VTS_OFFSCREEN.x, y: VTS_OFFSCREEN.y, width: ORIGINAL.width, height: ORIGINAL.height },
    'the parking position is its own record');
  assert.deepEqual(snapshot.vtsWindow.captureRect, snapshot.captureRect, 'the VTS snapshot carries the same capture rect');
  assert.notDeepEqual(snapshot.captureRect, { x: SAVED.x, y: SAVED.y, width: SAVED.width, height: SAVED.height },
    'the capture rect is never reported as the user rectangle');
  assert.notDeepEqual(snapshot.editBounds, { x: snapshot.captureRect.x, y: snapshot.captureRect.y, width: snapshot.captureRect.width, height: snapshot.captureRect.height },
    'edit geometry never falls back to the capture position');
  t.diagnostic(`user bounds=${JSON.stringify(displayBounds(h.layer))} · captureRect=${JSON.stringify(snapshot.captureRect)} · editBounds=${JSON.stringify(snapshot.editBounds)}`);
});

test('11. an edit handover adopts the session without starting a display or moving VTS', async (t) => {
  const h = await runningLayer();
  t.after(h.cleanup);
  // The sequence the switch produces: the Spout session is closed with VTS kept visible, then the
  // target backend (or, here, this same one) adopts the rectangle the user left.
  const entered = await h.layer.setEditMode(true);
  assert.equal(entered.ok, true);
  const left = { x: 300, y: 200, width: 500, height: 700 };
  h.vts.place(left);
  const closed = await h.layer.setEditMode(false, { keepVts: true });
  assert.equal(closed.handedOff, true);
  const movesBefore = h.vts.moves.length;
  const spawnsBefore = h.spawned.length;

  const adopted = await h.layer.adoptEdit(left);

  assert.equal(adopted.ok, true);
  assert.equal(adopted.handedOff, true);
  assert.equal(h.layer.isEditing(), true, 'the target backend now owns the session');
  assert.equal(h.layer.snapshot().running, false, 'the display process is not started for a handover');
  assert.equal(h.spawned.length, spawnsBefore, 'no extra display process was spawned');
  assert.equal(h.vts.moves.length, movesBefore, 'the VTS window is not moved');
  assert.deepEqual(h.layer.snapshot().editBounds, left, 'the handed-over rectangle is the session rectangle');
  assert.equal(h.of('spout.edit.enter').at(-1).payload.handedOff, true);
  t.diagnostic(`adopted=${JSON.stringify(adopted.bounds)} · running=${h.layer.snapshot().running} · spawns=${spawnsBefore}->${h.spawned.length} · moves=${movesBefore}->${h.vts.moves.length}`);
});

test('12. a keepVts exit closes the session without parking the window or starting the display', async (t) => {
  const h = await runningLayer();
  t.after(h.cleanup);
  const entered = await h.layer.setEditMode(true);
  assert.equal(entered.ok, true);
  h.vts.place({ x: 260, y: 180, width: 520, height: 760 });
  const movesBefore = h.vts.moves.length;
  const spawnsBefore = h.spawned.length;

  const exited = await h.layer.setEditMode(false, { keepVts: true });

  assert.equal(exited.ok, true);
  assert.equal(exited.handedOff, true);
  assert.equal(h.layer.isEditing(), false);
  assert.equal(h.vts.moves.length, movesBefore, 'VTS stays exactly where the user left it');
  assert.deepEqual(h.vts.bounds, { x: 260, y: 180, width: 520, height: 760 }, 'VTS is still visible');
  assert.equal(h.spawned.length, spawnsBefore, 'no display autostart during a handover');
  assert.deepEqual(exited.bounds, { x: 260, y: 180, width: 520, height: 760 });
  t.diagnostic(`exit=${exited.code ?? 'ok'} handedOff=${exited.handedOff} · moves=${movesBefore}->${h.vts.moves.length} · VTS=${JSON.stringify(h.vts.bounds)} · spawns=${h.spawned.length}`);
});

test('13. the receiver alpha sample is recorded from the layer diagnostics (evidence, not a guess)', async (t) => {
  const h = await runningLayer();
  t.after(h.cleanup);
  const sample = {
    type: 'diagnostic',
    event: 'spout.alpha.sample',
    total: 23328,
    alphaZero: 15802,
    alphaOpaque: 7266,
    alphaPartial: 260,
    verdict: 'transparent',
    width: 1148,
    height: 1292,
  };
  h.spawned[0].stdout.write(`${JSON.stringify(sample)}\n`);
  await new Promise((done) => setTimeout(done, 25));

  const recorded = h.layer.snapshot().alphaSample;
  assert.equal(recorded.event, 'spout.alpha.sample');
  assert.equal(recorded.total, 23328);
  assert.equal(recorded.alphaZero, 15802);
  assert.equal(recorded.alphaOpaque, 7266);
  assert.equal(recorded.alphaPartial, 260);
  assert.equal(recorded.verdict, 'transparent');
  assert.equal(h.of('spout.alpha.sample').at(-1).payload.alphaZero, 15802, 'the sample reaches the host log');

  // An all-opaque frame is its own event, so the VTS setting to check is named explicitly.
  h.spawned[0].stdout.write(`${JSON.stringify({ ...sample, event: 'spout.alpha.opaque-frame', alphaZero: 0, alphaOpaque: 23328, alphaPartial: 0, verdict: 'opaque' })}\n`);
  await new Promise((done) => setTimeout(done, 25));
  assert.equal(h.layer.snapshot().alphaSample.verdict, 'opaque');
  t.diagnostic(`alphaZero=${recorded.alphaZero} alphaOpaque=${recorded.alphaOpaque} alphaPartial=${recorded.alphaPartial} verdict=${recorded.verdict}`);
});

test('14. an explicit host-read rectangle is parked and started as-is; the layer never reads again', async (t) => {
  const h = await runningLayer();
  t.after(h.cleanup);
  await h.layer.setEditMode(true);
  const HOST_READ = { x: 300, y: 200, width: 500, height: 700 };
  // A second read would answer this rejected rectangle: the explicit bounds must win.
  h.vts.place({ x: 10, y: 10, width: 150, height: 150 });
  const readsBefore = h.vts.calls.capture;

  const exited = await h.layer.setEditMode(false, { bounds: HOST_READ });

  assert.equal(h.vts.calls.capture, readsBefore, 'the layer does not read the window again');
  assert.equal(exited.ok, true);
  assert.deepEqual(exited.bounds, HOST_READ);
  assert.deepEqual(spawnBounds(h.args.at(-1)), HOST_READ, 'the display starts in the host rectangle');
  const hostStart = spawnBounds(h.args.at(-1));
  assert.deepEqual(displayBounds(h.layer), HOST_READ);
  assert.deepEqual(h.of('spout.display.autostarted').at(-1).payload.bounds, HOST_READ);
  assert.deepEqual(h.vts.bounds, { x: VTS_OFFSCREEN.x, y: VTS_OFFSCREEN.y, width: 500, height: 700 },
    'VTS is parked at the validated size, not at the second read');

  // `bounds: null` = the host read failed: saved geometry, and still no second read.
  await h.layer.setEditMode(true);
  h.vts.failCapture = true;
  const fallbackReads = h.vts.calls.capture;
  const fallback = await h.layer.setEditMode(false, { bounds: null });
  assert.equal(h.vts.calls.capture, fallbackReads, 'a failed host read is not retried by the layer');
  assert.equal(fallback.ok, true);
  assert.equal(fallback.fallback, true);
  assert.deepEqual(fallback.bounds, SAVED);
  assert.deepEqual(spawnBounds(h.args.at(-1)), SAVED);
  t.diagnostic(`host read=${JSON.stringify(HOST_READ)} → --dsh-bounds=${JSON.stringify(hostStart)} · extra reads=0 · bounds null → fallback ${JSON.stringify(fallback.bounds)}`);
});
