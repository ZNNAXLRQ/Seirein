/**
 * The `layerEdit` hotkey and the backend switch are two strict, mutually exclusive bindings:
 *
 *   Spout: edit <-> display process
 *     enter -> stop the display process, put VTS back on screen
 *     exit  -> read the VTS rectangle, hide VTS, start the display process in that rectangle
 *
 *   WPF:   edit <-> transparent layer
 *     enter -> stop the mirror, put VTS back on screen
 *     exit  -> read VTS, hide it in the capture corner, start the mirror there
 *
 * The routing is exercised through the shipped `createLayerEditController` and
 * `createLayerBackendSwitch` (the exact helpers the hotkey and `/assistant/action` use). The Spout
 * side is a real `SpoutLayer` wired to a fake display process and a recording VTS window
 * controller; the WPF side records its enter/exit and display start/stop. The cases below are
 * the user-confirmed contract:
 *
 *   1. backend=spout + hotkey -> only Spout enter; WPF starts 0 times
 *   2. backend=wpf   + hotkey -> only WPF enter; Spout display starts 0 times
 *   3. spout->wpf switch order: exit-edit(spout) -> stop(spout) -> move VTS to WPF OFFSCREEN -> start(wpf)
 *   4. wpf->spout switch order: exit-edit(wpf) -> stop(wpf) -> hide VTS -> start(spout)
 *   5. switching while editing exits the old session first; two display processes never coexist
 *   6. the WPF start only happens after VTS sits exactly at (-2200,-1400,900x1200)
 *   7. host entry (`apply` → `/assistant/action`): a failed VTS raise is NOT an edit session; the
 *      stopped mirror is started again and `wpf.edit.enter.failed { code }` is recorded
 *
 * Run: `node --test test/layer-hotkey.mjs`
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { PassThrough, Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  apply,
  createLayerBackendSwitch,
  createLayerEditController,
  spoutLayerSettings,
} from '../src/host/index.js';
import { WPF_OFFSCREEN, WPF_ONSCREEN } from '../src/host/avatar/avatarLayer.js';
import { SpoutLayer } from '../src/host/avatar/spoutLayer.js';
import { VTS_OFFSCREEN } from '../src/host/avatar/spout-layer/vts-window.mjs';

/** Where the user leaves the VTS window when a Spout edit session ends. */
const EDIT_RECT = { x: 140, y: 260, width: 480, height: 720 };
/** The VTS rectangle when the display process took over. */
const VTS_ORIGINAL = { x: 120, y: 80, width: 900, height: 1200 };
const WPF_CAPTURE = { x: -2200, y: -1400, width: 900, height: 1200 };

/** Real settings.json round-trip; `read` is fresh on every call like the host's. */
async function settingsFile(initial) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-layer-hotkey-'));
  const file = join(root, 'settings.json');
  writeFileSync(file, `${JSON.stringify(initial, null, 2)}\n`, 'utf8');
  const read = () => JSON.parse(readFileSync(file, 'utf8'));
  const write = (patch) => writeFileSync(file, `${JSON.stringify({ ...read(), ...patch }, null, 2)}\n`, 'utf8');
  return { root, file, read, write };
}

/** Recording VTS controller: capture/move are observable and the rectangle can be "dragged". */
function fakeVts({ initial = VTS_ORIGINAL } = {}) {
  let current = { ...initial };
  const calls = { capture: 0, move: 0 };
  const log = [];
  return {
    calls,
    log,
    get bounds() { return { ...current }; },
    place(rect) { current = { ...rect }; },
    async capture() {
      calls.capture += 1;
      log.push('capture');
      return { ok: true, bounds: { ...current } };
    },
    async move(rect) {
      calls.move += 1;
      log.push(['move', { ...rect }]);
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

let nextPid = 700_000;

/** Real SpoutLayer + fake display process + the shared recording VTS window controller. */
function hostSpout(root, vts) {
  const events = [];
  const spawned = [];
  const args = [];
  const layer = new SpoutLayer({
    root,
    settings: () => ({}),
    log: { emit: async (type, payload) => events.push({ type, payload }) },
    vtsWindow: vts,
  });
  // Keep the launch deterministic and offline: no Electron probe, no WMI ownership query.
  layer.validate = async () => ({ ok: true, path: 'electron.exe', version: '44.7.0' });
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
  return { layer, spawned, args, events, of: (type) => events.filter((entry) => entry.type === type) };
}

/**
 * One host-shaped wiring: real SpoutLayer, recording WPF backend, the shipped hotkey controller
 * and the shipped switch. `calls` is a single ordered log of every observable transition.
 */
async function mount({ backend = 'wpf', wpfRunning = false, spoutRunning = false } = {}) {
  const store = await settingsFile({ layer: { backend } });
  const vts = fakeVts();
  const spout = hostSpout(store.root, vts);
  const wpf = { editing: false, running: wpfRunning === true, enters: 0, exits: 0, starts: 0, stops: 0, handoffs: 0 };
  const calls = [];
  const log = { emit: async (type) => calls.push(`event:${type}`) };
  const state = {
    /** What VTS looked like at the instant `start:wpf` ran (test 6). */
    wpfStartVts: null,
    /** Display state at each start (test 5: never two at once). */
    runningAtStartWpf: null,
    runningAtStartSpout: null,
    /** The rectangle each settled start was asked to occupy (the common position). */
    startBoundsWpf: null,
    startBoundsSpout: null,
  };
  const COMMON = { x: 1400, y: 320, width: 480, height: 720 };

  const edit = createLayerEditController({
    read: store.read,
    write: store.write,
    log,
    layers: {
      wpf: {
        editing: () => wpf.editing === true,
        enter: async () => {
          calls.push('wpf:enter');
          wpf.enters += 1;
          wpf.running = false; // enter stops the mirror: VTS is the editable surface
          wpf.editing = true;
          return { ok: true, editMode: true, bounds: { ...WPF_ONSCREEN } };
        },
        exit: async () => {
          calls.push('wpf:exit');
          wpf.exits += 1;
          wpf.editing = false;
          return { ok: true, editMode: false, bounds: { ...WPF_ONSCREEN } };
        },
      },
      spout: {
        editing: () => spout.layer.isEditing(),
        enter: async () => {
          calls.push('spout:enter');
          return spout.layer.setEditMode(true);
        },
        exit: async () => {
          calls.push('spout:exit');
          return spout.layer.setEditMode(false);
        },
      },
    },
  });

  // The exact "leave edit for a stop" rule the host uses: no display autostart. `keepVts` is the
  // edit -> edit handover: the Spout session closes without parking the window.
  const leaveSpout = async (options = {}) => {
    const autostart = spout.layer.autostartOnEditExit;
    spout.layer.autostartOnEditExit = false;
    try {
      return await edit.exit({ keepVts: options?.keepVts === true });
    } finally {
      spout.layer.autostartOnEditExit = autostart;
    }
  };
  const leaveWpf = async () => edit.exit();
  /** edit -> edit handover: adopt the session, start nothing and move nothing. */
  const handoffWpf = async (bounds) => {
    calls.push('wpf:handoff');
    wpf.handoffs += 1;
    wpf.running = false;
    wpf.editing = true;
    return { ok: true, editMode: true, handedOff: true, bounds: { ...(bounds ?? vts.bounds) } };
  };
  const handoffSpout = async (bounds) => {
    calls.push('spout:handoff');
    const adopted = await spout.layer.adoptEdit(bounds ?? vts.bounds);
    return { ...adopted, ok: adopted.ok === true };
  };

  const layerSwitch = createLayerBackendSwitch({
    read: store.read,
    write: store.write,
    probeSpout: async () => {
      calls.push('probe:spout');
      return { ok: true };
    },
    // The user's edit session follows them across the switch, exactly like the host wiring: in a
    // handover the target adopts the open session, in a settled switch the display starts at the
    // rectangle the old one occupied.
    isEditing: () => edit.status().editMode,
    enterEdit: () => edit.enter(),
    handoffEdit: (which, bounds) => (which === 'wpf' ? handoffWpf(bounds) : handoffSpout(bounds)),
    boundsOf: () => ({ ...COMMON }),
    stopEdit: (which, options = {}) => {
      calls.push(`exit-edit:${which}`);
      return which === 'wpf' ? leaveWpf() : leaveSpout(options);
    },
    stopWpf: async () => {
      calls.push('stop:wpf');
      wpf.stops += 1;
      wpf.running = false;
      wpf.editing = false;
      return { confirmed: true };
    },
    startWpf: async (options) => {
      state.startBoundsWpf = options?.bounds ?? null;
      state.wpfStartVts = { ...vts.bounds };
      state.runningAtStartWpf = { wpf: wpf.running, spout: spout.layer.snapshot().running };
      calls.push('start:wpf');
      wpf.starts += 1;
      wpf.running = true;
      wpf.editing = false;
      return { ok: true };
    },
    stopSpout: async () => {
      calls.push('stop:spout');
      const result = await spout.layer.stop();
      return { confirmed: result.ok === true };
    },
    startSpout: async (options) => {
      state.startBoundsSpout = options?.bounds ?? null;
      state.runningAtStartSpout = { wpf: wpf.running, spout: spout.layer.snapshot().running };
      calls.push('start:spout');
      const result = await spout.layer.start(options?.bounds ? { bounds: options.bounds } : {});
      return { ...result, ok: result.ok === true };
    },
    vts: {
      move: async (rect) => {
        calls.push(`move:${rect.x},${rect.y},${rect.width}x${rect.height}`);
        return vts.move(rect);
      },
      hide: async () => {
        calls.push('hide:vts');
        return spout.layer.hideVts();
      },
    },
  });

  if (spoutRunning === true) await spout.layer.start();

  return { ...store, vts, spout, wpf, calls, edit, layerSwitch, state, of: spout.of };
}

const transitionCalls = (calls) => calls.filter((entry) => !entry.startsWith('event:'));

test('1. backend=spout: the hotkey only enters Spout; the WPF layer starts 0 times', async (t) => {
  const h = await mount({ backend: 'spout', spoutRunning: true });
  const spawnsBefore = h.spout.spawned.length;

  const entered = await h.edit.toggle();

  assert.equal(entered.ok, true);
  assert.deepEqual(transitionCalls(h.calls), ['spout:enter']);
  assert.equal(h.wpf.enters, 0, 'WPF enter called 0 times');
  assert.equal(h.wpf.starts, 0, 'WPF display start called 0 times');
  assert.equal(h.wpf.running, false, 'the WPF transparent layer never runs');
  assert.equal(h.spout.layer.isEditing(), true);
  assert.equal(h.spout.layer.snapshot().running, false, 'the Spout display process was stopped');
  assert.equal(h.spout.spawned.length, spawnsBefore, 'no extra display process was spawned');
  assert.deepEqual(h.vts.bounds, VTS_ORIGINAL, 'VTS is back on screen for editing');
  assert.deepEqual(h.edit.status(), { editMode: true, editBackend: 'spout' });
  t.diagnostic(`backend=spout · WPF enter=${h.wpf.enters} start=${h.wpf.starts} · Spout display starts=${spawnsBefore}->${h.spout.spawned.length} running=${h.spout.layer.snapshot().running} · VTS=${JSON.stringify(h.vts.bounds)}`);
});

test('2. backend=wpf: the hotkey only enters WPF; the Spout display starts 0 times', async (t) => {
  const h = await mount({ backend: 'wpf', wpfRunning: true });

  const entered = await h.edit.toggle();

  assert.equal(entered.ok, true);
  assert.deepEqual(transitionCalls(h.calls), ['wpf:enter']);
  assert.equal(h.wpf.enters, 1);
  assert.equal(h.wpf.running, false, 'WPF enter stopped the mirror');
  assert.equal(h.spout.spawned.length, 0, 'the Spout display never started');
  assert.equal(h.vts.calls.move, 0, 'and VTS was not touched through the Spout backend');
  assert.deepEqual(h.edit.status(), { editMode: true, editBackend: 'wpf' });
  t.diagnostic(`backend=wpf · WPF enter=${h.wpf.enters} running=${h.wpf.running} · Spout display starts=${h.spout.spawned.length} · VTS moves=${h.vts.calls.move}`);
});

test('3. spout->wpf switch order: exit-edit -> stop spout -> move VTS offscreen -> start wpf', async (t) => {
  const h = await mount({ backend: 'spout', spoutRunning: true });
  const spawnsBefore = h.spout.spawned.length;
  h.calls.length = 0;

  const result = await h.layerSwitch.set('wpf');

  assert.equal(result.ok, true);
  assert.equal(result.backend, 'wpf');
  assert.deepEqual(transitionCalls(h.calls), [
    'exit-edit:spout',
    'stop:spout',
    'move:-2200,-1400,480x720',
    'start:wpf',
  ], 'the switch follows the exact exit -> stop -> align -> start order');
  assert.deepEqual(h.vts.bounds, { ...WPF_CAPTURE, width:480, height:720 }, 'capture corner preserves display dimensions');
  assert.deepEqual(h.vts.bounds, { ...WPF_OFFSCREEN, width:480, height:720 });
  assert.equal(h.spout.spawned.length, spawnsBefore, 'the stopped display was not restarted');
  assert.equal(h.spout.layer.snapshot().running, false);
  assert.equal(h.wpf.starts, 1);
  assert.equal(h.wpf.running, true);
  assert.equal(h.read().layer.backend, 'wpf', 'the new backend is persisted');
  assert.deepEqual(h.edit.status(), { editMode: false, editBackend: null });
  t.diagnostic(`order=${transitionCalls(h.calls).join(' > ')} · Spout starts=${spawnsBefore}->${h.spout.spawned.length} · WPF start=${h.wpf.starts} running=${h.wpf.running} · VTS=${JSON.stringify(h.vts.bounds)}`);
});

test('4. wpf->spout switch order: exit-edit -> stop wpf -> hide VTS -> start spout', async (t) => {
  const h = await mount({ backend: 'wpf', wpfRunning: true });
  h.calls.length = 0;

  const result = await h.layerSwitch.set('spout');

  assert.equal(result.ok, true);
  assert.equal(result.backend, 'spout');
  assert.deepEqual(transitionCalls(h.calls), [
    'probe:spout',
    'exit-edit:wpf',
    'stop:wpf',
    'hide:vts',
    'start:spout',
  ], 'after the preflight probe, the required order is exactly exit -> stop -> hide -> start');
  assert.equal(h.wpf.running, false, 'the WPF mirror really stopped');
  assert.equal(h.spout.layer.snapshot().running, true, 'Spout is the only running backend');
  assert.equal(h.spout.spawned.length, 1);
  assert.deepEqual(h.vts.bounds, {
    x: VTS_OFFSCREEN.x,
    y: VTS_OFFSCREEN.y,
    width: VTS_ORIGINAL.width,
    height: VTS_ORIGINAL.height,
  }, 'VTS is hidden in the Spout corner');
  assert.equal(h.read().layer.backend, 'spout');
  t.diagnostic(`order=${transitionCalls(h.calls).join(' > ')} · WPF stops=${h.wpf.stops} running=${h.wpf.running} · Spout starts=${h.spout.spawned.length} running=${h.spout.layer.snapshot().running} · VTS=${JSON.stringify(h.vts.bounds)}`);
});

test('5. switching while editing: the open session is handed over; nothing starts and VTS stays put', async (t) => {
  // A. Spout is editing (display already stopped) -> switch to WPF, which must also be editing.
  const a = await mount({ backend: 'spout', spoutRunning: true });
  await a.edit.toggle();
  a.vts.place(EDIT_RECT);
  a.calls.length = 0;
  const spawnsBefore = a.spout.spawned.length;

  const toWpf = await a.layerSwitch.set('wpf');
  assert.equal(toWpf.ok, true);
  assert.equal(toWpf.handedOff, true);
  assert.deepEqual(transitionCalls(a.calls), [
    'exit-edit:spout',
    'spout:exit',
    'stop:spout',
    'wpf:handoff',
  ], 'the Spout session closes (VTS stays visible) and WPF adopts it — no start, no move');
  assert.equal(a.calls.includes('hide:vts'), false, 'the handover never parks VTS');
  assert.equal(a.spout.layer.snapshot().running, false);
  assert.equal(a.spout.spawned.length, spawnsBefore, 'no display was started for the handover');
  assert.equal(a.wpf.starts, 0, 'no mirror window is started for an edit handover');
  assert.equal(a.wpf.handoffs, 1);
  assert.deepEqual(a.vts.bounds, EDIT_RECT, 'VTS stays exactly where the user left it');
  assert.equal(transitionCalls(a.calls).some((entry) => entry.startsWith('move:')), false, 'the handover does not touch the VTS window');
  assert.equal(a.wpf.enters, 0, 'a handover is not a stop/start enter');
  assert.equal(a.wpf.running, false, 'WPF edit keeps the mirror stopped');
  assert.deepEqual(a.edit.status(), { editMode: true, editBackend: 'wpf' }, 'the user is still editing after the switch');

  // B. WPF is editing (mirror already stopped) -> switch to Spout, which must also be editing.
  const b = await mount({ backend: 'wpf', wpfRunning: true });
  await b.edit.toggle();
  b.calls.length = 0;
  const toSpout = await b.layerSwitch.set('spout');
  assert.equal(toSpout.ok, true);
  assert.equal(toSpout.handedOff, true);
  assert.deepEqual(transitionCalls(b.calls), [
    'probe:spout',
    'exit-edit:wpf',
    'wpf:exit',
    'stop:wpf',
    'spout:handoff',
  ], 'the WPF session closes, then Spout adopts it — no hide, no display start');
  assert.equal(b.calls.includes('hide:vts'), false);
  assert.equal(b.state.startBoundsSpout, null, 'the Spout display is not started for a handover');
  assert.equal(b.wpf.running, false);
  assert.equal(b.spout.layer.snapshot().running, false, 'Spout edit stops the display process');
  assert.equal(b.spout.layer.isEditing(), true, 'VTS is the editable surface');
  assert.deepEqual(b.vts.bounds, VTS_ORIGINAL, 'VTS is not moved by the handover');
  assert.deepEqual(b.edit.status(), { editMode: true, editBackend: 'spout' }, 'the user is still editing after the switch');
  t.diagnostic(`spout->wpf=${transitionCalls(a.calls).join(' > ')} edit=${JSON.stringify(a.edit.status())} VTS=${JSON.stringify(a.vts.bounds)} · wpf->spout=${transitionCalls(b.calls).join(' > ')} edit=${JSON.stringify(b.edit.status())} running=${b.spout.layer.snapshot().running} VTS=${JSON.stringify(b.vts.bounds)}`);
});

test('6. WPF starts only after VTS is exactly at the WPF OFFSCREEN geometry', async (t) => {
  const h = await mount({ backend: 'spout', spoutRunning: true });
  h.calls.length = 0;

  const result = await h.layerSwitch.set('wpf');

  assert.equal(result.ok, true);
  const move = transitionCalls(h.calls).find((entry) => entry.startsWith('move:'));
  assert.equal(move, 'move:-2200,-1400,480x720', 'capture size stays equal to the display size');
  assert.ok(
    transitionCalls(h.calls).indexOf(move) < transitionCalls(h.calls).indexOf('start:wpf'),
    'the move precedes the start',
  );
  assert.deepEqual(h.state.wpfStartVts, { ...WPF_CAPTURE, width:480, height:720 }, 'at start time VTS is already in the corner at the preserved size');
  assert.deepEqual(result.vts.bounds, { ...WPF_CAPTURE, width:480, height:720 });
  t.diagnostic(`move=${move} · VTS at start:wpf=${JSON.stringify(h.state.wpfStartVts)} · WPF start=${h.wpf.starts} · order=${transitionCalls(h.calls).join(' > ')}`);
});

test('7. leaving Spout edit persists layer.spout.bounds and the next start initializes from it', async () => {
  const h = await mount({ backend: 'spout', spoutRunning: true });
  await h.edit.toggle();
  assert.equal(h.read().layer.spout, undefined, 'entering edit mode writes nothing');
  h.vts.place(EDIT_RECT);

  const exited = await h.edit.toggle();

  assert.equal(exited.ok, true);
  assert.deepEqual(exited.bounds, EDIT_RECT);
  const stored = h.read();
  assert.deepEqual(stored.layer.spout.bounds, EDIT_RECT);
  assert.equal(stored.layer.backend, 'spout');

  const next = new SpoutLayer({
    root: h.root,
    settings: () => spoutLayerSettings({
      saved: stored.spoutLayer ?? {},
      layer: stored.layer,
      layerGeometry: stored.layerGeometry ?? null,
    }),
  });
  assert.deepEqual(next.requestedBounds(), {
    left: EDIT_RECT.x,
    top: EDIT_RECT.y,
    width: EDIT_RECT.width,
    height: EDIT_RECT.height,
  });
});

test('8. closing the plugin while editing exits without spawning a doomed Spout display', async () => {
  const h = await mount({ backend: 'spout', spoutRunning: true });
  await h.edit.toggle();
  h.vts.place(EDIT_RECT);
  const spawnsBefore = h.spout.spawned.length;
  h.spout.layer.autostartOnEditExit = false;

  const [first, second] = await Promise.all([h.edit.close(), h.edit.close()]);
  assert.equal(first, second, 'concurrent closes share one in-flight exit');

  assert.equal(h.spout.layer.isEditing(), false);
  assert.deepEqual(h.read().layer.spout.bounds, EDIT_RECT);
  assert.equal(h.spout.spawned.length, spawnsBefore);
  assert.equal(h.wpf.starts, 0);
  assert.equal(h.spout.of('spout.display.autostart-skipped').length, 1);
});

test('9. a close during a pending enter waits for the enter and then really exits', async () => {
  let release = null;
  const gate = new Promise((resolve) => { release = resolve; });
  let editing = false;
  const calls = [];
  const edit = createLayerEditController({
    read: () => ({ layer: { backend: 'spout' } }),
    write: () => {},
    log: { emit: async () => {} },
    layers: {
      wpf: { editing: () => false, enter: async () => ({ ok: true }), exit: async () => ({ ok: true }) },
      spout: {
        editing: () => editing,
        enter: async () => {
          calls.push(true);
          await gate;
          editing = true;
          return { ok: true, editMode: true, bounds: null };
        },
        exit: async () => {
          calls.push(false);
          editing = false;
          return { ok: true, editMode: false, bounds: null };
        },
      },
    },
  });

  const entering = edit.enter();
  await new Promise((done) => setTimeout(done, 5));
  assert.equal(editing, false, 'the enter is still in flight');

  const closing = edit.close();
  assert.notEqual(closing, entering, 'close is its own operation, never the pending enter');
  release();
  const [entered, closed] = await Promise.all([entering, closing]);

  assert.equal(entered.ok, true);
  assert.equal(closed.ok, true);
  assert.equal(editing, false, 'the layer really left the edit session');
  assert.deepEqual(calls, [true, false], 'exactly one enter + one exit, in order');
  await edit.close();
  assert.deepEqual(calls, [true, false], 'a further close is a no-op');
});

test('10. a stale session on the other backend is refused, never started over', async () => {
  let wpfEditing = true;
  let spoutEnters = 0;
  const edit = createLayerEditController({
    read: () => ({ layer: { backend: 'spout' } }),
    write: () => {},
    log: { emit: async () => {} },
    layers: {
      wpf: { editing: () => wpfEditing, enter: async () => ({ ok: true }), exit: async () => ({ ok: true }) },
      spout: {
        editing: () => false,
        enter: async () => {
          spoutEnters += 1;
          return { ok: true, editMode: true, bounds: null };
        },
        exit: async () => ({ ok: true }),
      },
    },
  });

  const refused = await edit.enter();

  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'LAYER_CONFLICT', 'the active backend refuses to start over a stale session');
  assert.equal(refused.editBackend, 'wpf');
  assert.equal(spoutEnters, 0, 'the Spout backend was not started');
  assert.deepEqual(edit.status(), { editMode: false, editBackend: null }, 'status stays on the active backend');
});

// ---- host entry: the real `apply` → `/assistant/action` wiring ------------------------------

/** Minimal stand-in for the DSH context: enough for `apply()` to mount and register routes. */
function makeHostContext() {
  const routes = new Map();
  const disposers = [];
  const effect = (fn) => {
    const result = fn();
    disposers.push(result);
    return result;
  };
  const services = {
    systemPrompt: { section: () => ({ dispose() {} }) },
    webServer: {
      register: (route) => {
        routes.set(route.path, route.handler);
        return { dispose() {} };
      },
    },
  };
  const scopeOf = (names) => {
    const target = { effect };
    for (const service of names) target[service] = services[service];
    return new Proxy(target, { get: (inner, key) => (key in inner ? inner[key] : () => ({ dispose() {} })) });
  };
  const ctx = {
    effect,
    tools: { register: () => () => {} },
    get: () => undefined,
    inject: (names, fn) => fn(scopeOf(names)),
  };
  return {
    ctx,
    routes,
    dispose: () => {
      for (const entry of disposers.reverse()) {
        try {
          if (typeof entry === 'function') entry();
          else entry?.dispose?.();
        } catch {
          /* teardown is best-effort */
        }
      }
    },
  };
}

/** One `/assistant/action` or `/assistant/status` call, exactly like the page makes it. */
async function callRoute(routes, path, body) {
  const handler = routes.get(path);
  if (handler === undefined) throw new Error(`route not registered: ${path}`);
  const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
  req.method = body === undefined ? 'GET' : 'POST';
  const res = {
    statusCode: 0,
    body: '',
    writeHead(code) { this.statusCode = code; },
    end(text) { this.body = String(text ?? ''); },
  };
  await handler(req, res);
  return JSON.parse(res.body);
}

/** The host's append-only event log. */
function readHostEvents(root) {
  const file = join(root, 'data', 'events.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

/** Poll until `predicate` is true: spawned children are observable only after they start. */
async function until(predicate, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((done) => setTimeout(done, 40));
  }
  return predicate();
}

const psQuote = (value) => `'${String(value).replace(/'/gu, "''")}'`;

/**
 * A fake `powershell.exe` placed first on PATH. The host spawns `powershell` for two programs: the
 * WPF mirror (`transparent.ps1`, kept alive until stopped) and the VTS window helper
 * (`window-move.ps1`). A `-Raise` move answers `VTS_RAISE_FAILED`, which is the one lower-layer
 * failure that cannot be produced on demand with a real helper, and a `-Report`/plain move answers
 * a normal rectangle. Every invocation is appended to `calls.log` for ordering evidence.
 */
async function fakePowerShell(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-fake-powershell-'));
  const log = join(dir, 'calls.log');
  const source = join(dir, 'fake-powershell.cs');
  const exe = join(dir, 'powershell.exe');
  t.after(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });
  writeFileSync(source, String.raw`
using System;
using System.IO;
using System.Threading;
public class FakePowerShell {
  public static int Main(string[] args) {
    string all = string.Join(" ", args);
    string log = Environment.GetEnvironmentVariable("DSH_FAKE_POWERSHELL_LOG");
    if (log != null && log.Length > 0) {
      try { File.AppendAllText(log, all + "\n"); } catch { }
    }
    if (all.Contains("-Raise")) {
      Console.WriteLine("{\"ok\":false,\"raised\":false,\"raiseCode\":\"VTS_RAISE_FAILED\"}");
      return 2;
    }
    if (all.Contains("-Seconds")) {
      Thread.Sleep(120000);
      return 0;
    }
    Console.WriteLine("{\"ok\":true,\"raised\":false,\"left\":100,\"top\":100,\"width\":900,\"height\":1200}");
    return 0;
  }
}
`, 'utf8');
  execFileSync('powershell', [
    '-NoProfile', '-NonInteractive', '-Command',
    `Add-Type -TypeDefinition ([IO.File]::ReadAllText(${psQuote(source)})) -OutputAssembly ${psQuote(exe)} -OutputType ConsoleApplication`,
  ], { windowsHide: true, timeout: 60_000 });
  const calls = () => (existsSync(log)
    ? readFileSync(log, 'utf8').split(/\r?\n/u).filter((line) => line.trim().length > 0)
    : []);
  return {
    dir,
    log,
    calls,
    mirrorStarts: () => calls().filter((line) => line.includes('transparent.ps1')),
    raiseMoves: () => calls().filter((line) => line.includes('-Raise')),
  };
}

test('11. host: WPF enter with a failed VTS raise is not an edit session; the mirror is started again', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const shim = await fakePowerShell(t);
  const root = await mkdtemp(join(tmpdir(), 'dsh-layer-hotkey-host-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });
  const pathBefore = process.env.PATH;
  const logBefore = process.env.DSH_FAKE_POWERSHELL_LOG;
  process.env.PATH = `${shim.dir};${pathBefore ?? ''}`;
  process.env.DSH_FAKE_POWERSHELL_LOG = shim.log;
  const mounted = makeHostContext();
  t.after(() => {
    mounted.dispose();
    if (pathBefore === undefined) delete process.env.PATH;
    else process.env.PATH = pathBefore;
    if (logBefore === undefined) delete process.env.DSH_FAKE_POWERSHELL_LOG;
    else process.env.DSH_FAKE_POWERSHELL_LOG = logBefore;
  });
  apply(mounted.ctx, { root, defaultDomain: 'chat', enabled: true, dependencyBootDelayMs: 600000 });

  // The WPF mirror is running: entering edit mode must stop it and put VTS back on screen.
  const display = await callRoute(mounted.routes, '/assistant/action', {
    action: 'transparent.start', left: 140, top: 260, width: 480, height: 720,
  });
  assert.equal(display.ok, true);
  assert.equal(display.running, true);
  assert.ok(await until(() => shim.mirrorStarts().length === 1), 'the mirror really started before the enter');
  const startsBefore = shim.mirrorStarts().length;

  const entered = await callRoute(mounted.routes, '/assistant/action', { action: 'layer.edit.enter' });

  assert.equal(entered.ok, false, 'the host reports the failure instead of success');
  assert.equal(entered.code, 'VTS_RAISE_FAILED', 'the lower-layer code is reported verbatim');
  assert.equal(entered.editMode, false, 'a failed raise never enters edit mode');
  assert.equal(entered.editBackend, null);

  const status = await callRoute(mounted.routes, '/assistant/status');
  assert.equal(status.layer.editMode, false, 'status stays out of edit mode');
  assert.equal(status.layer.editBackend, null);
  assert.equal(status.layer.running, true, 'the stopped mirror is running again');
  assert.equal(status.layer.wpf.running, true);

  assert.ok(await until(() => shim.mirrorStarts().length === startsBefore + 1),
    'the stopped display layer is started again exactly once');
  const calls = shim.calls();
  const raiseIndex = calls.findIndex((line) => line.includes('-Raise'));
  const restoreIndex = calls.lastIndexOf(shim.mirrorStarts().at(-1) ?? '');
  assert.ok(raiseIndex >= 0, 'the raise move was attempted');
  assert.ok(restoreIndex > raiseIndex, 'the mirror was restarted after the failed raise');

  const events = readHostEvents(root);
  const failed = events.filter((event) => event.type === 'wpf.edit.enter.failed');
  assert.equal(failed.length, 1, 'the failure is recorded as an event');
  assert.equal(failed[0].payload.code, 'VTS_RAISE_FAILED');
  assert.equal(events.filter((event) => event.type === 'wpf.edit.enter').length, 0, 'no false success event');
  assert.equal(events.filter((event) => event.type === 'transparent.start').length, 2,
    'both mirror starts are logged (initial + restore)');

  // The failed enter must not be remembered as "already editing".
  const again = await callRoute(mounted.routes, '/assistant/action', { action: 'layer.edit.enter' });
  assert.equal(again.ok, false, 'still not editing on a retry');
  assert.equal(again.editMode, false, 'and still no edit session');

  t.diagnostic(`host ok=${entered.ok} code=${entered.code} editMode=${entered.editMode} · status editMode=${status.layer.editMode} running=${status.layer.running} · mirror starts=${startsBefore}->${shim.mirrorStarts().length} raiseCalls=${shim.raiseMoves().length} · events=${failed.length}`);
});
