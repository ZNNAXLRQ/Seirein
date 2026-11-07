/**
 * Spout layer — the real VTS window must stay hidden, and the failure must not be silent.
 *
 * Field symptom: `layer.backend=spout` and the display process running (55 fps, alpha), but the
 * VTS window still on screen (magenta). Code fact: `start()` called `hideVts()` exactly once, and
 * a window that was not up yet (or had no handle) made that single attempt fail with no retry for
 * the rest of the session.
 *
 * These cases pin the fix, with doubles only (no Electron, no PowerShell, no real VTS):
 *
 *   1. first start: hide fails → finite retry → the 2nd attempt succeeds; `retry`/`recovered`
 *      events carry the attempt count, the delays are 300/800/1500, and the display is reported
 *      separately from the VTS window;
 *   2. edit exit (independent path): the same hide + retry + separate report;
 *   3. three retries all fail → no more retries, `spout.vts.hide.failed` carries the code, the
 *      display keeps running, and the status says `vts.hidden=false` explicitly;
 *   4. a state change before the timer fires (edit mode / backend switch / new generation) cancels
 *      the retry — no further window move is ever issued;
 *   5. `snapshot().backend` reports the instance's real backend (`spout`/`wpf`), never a literal.
 *
 * The bug class these last cases pin: the retry validated the world only *before* reading the VTS
 * window, and the read can take hundreds of milliseconds. Cases 6-10 hold the read (or the move)
 * open, change the world while it is pending, and require a `shouldContinue` re-check right before
 * the move: an abandoned move is an `spout.vts.hide.aborted` (never `failed`), and edit entry waits
 * for a move that was already issued instead of interleaving with it.
 *
 * Run: node --test test/spout-vts-hide.mjs
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { SpoutLayer, VTS_HIDE_RETRY_DELAYS_MS } from '../src/host/avatar/spoutLayer.js';

/**
 * Deterministic scheduler: nothing fires until the test asks for it, and every delay that was
 * requested is recorded, so "the intervals grow" is asserted from the real schedule.
 */
function makeTimers() {
  let now = 0;
  const jobs = [];
  return {
    setTimeout(callback, ms) {
      const job = { callback, ms, at: now + ms, done: false };
      jobs.push(job);
      return job;
    },
    clearTimeout(job) {
      if (job) job.done = true;
    },
    pending: () => jobs.filter((job) => !job.done),
    plannedDelays: () => jobs.map((job) => job.ms),
    /** Fire every pending job that is due at or before `now + ms`, oldest first. */
    async advance(ms = 0) {
      now += ms;
      const due = jobs
        .filter((job) => !job.done && job.at <= now)
        .sort((left, right) => left.at - right.at);
      for (const job of due) {
        job.done = true;
        await job.callback();
      }
      return due.map((job) => job.ms);
    },
    /** Fire the next scheduled job regardless of its timer value. */
    async next() {
      const job = jobs.find((entry) => !entry.done);
      if (job === undefined) return null;
      now = Math.max(now, job.at);
      job.done = true;
      await job.callback();
      return job.ms;
    },
  };
}

/**
 * Fake VTS window controller. `captureOk=false` models "VTS not running / no window handle yet";
 * `moveFailures` fails that many moves and then starts working, so one test can show the retry
 * crossing from failure to success with the real `hideVts()`/`moveVts()` path.
 *
 * `captureBarrier` / `moveBarrier` hold one call open (the real read and the real move are async
 * IPC/PowerShell round trips); the test releases them, so "edit arrives while the window is being
 * read" is deterministic instead of a sleep race.
 */
function makeVts({ bounds = { x: 120, y: 200, width: 520, height: 800 } } = {}) {
  const state = {
    bounds: { ...bounds },
    captureOk: true,
    moveFailures: 0,
    captures: 0,
    captureStarted: 0,
    captureBarrier: null,
    moveBarrier: null,
    moves: [],
  };
  const controller = {
    async capture() {
      state.captures += 1;
      state.captureStarted += 1;
      const barrier = state.captureBarrier;
      if (barrier !== null) {
        state.captureBarrier = null;
        await barrier.promise;
      }
      if (state.captureOk !== true) {
        return { ok: false, code: 'VTS_NOT_RUNNING', message: 'VTS 窗口不可用（未运行或找不到）' };
      }
      return { ok: true, bounds: { ...state.bounds } };
    },
    async move(rect) {
      state.moves.push({ ...rect });
      const barrier = state.moveBarrier;
      if (barrier !== null) {
        state.moveBarrier = null;
        await barrier.promise;
      }
      if (state.moveFailures > 0) {
        state.moveFailures -= 1;
        return { ok: false, code: 'VTS_WINDOW_MOVE_FAILED', message: 'VTS 窗口移动失败' };
      }
      state.bounds = { ...rect };
      return { ok: true, bounds: { ...rect } };
    },
  };
  return { controller, state };
}

/** A promise the test releases by hand: models one async round trip (read or move) still pending. */
function deferred() {
  let resolvePromise = null;
  const promise = new Promise((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: () => resolvePromise() };
}

/** Wait (real time, bounded) until `check` is true; the fake timers are advanced explicitly. */
async function until(check) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check() === true) return;
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
  }
  throw new Error('condition was never reached');
}

/**
 * Display-process double: real EventEmitter semantics, answers `shutdown` and exits.
 */
function makeChild(pid, alive) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdinWrites = [];
  child.stdinEnds = 0;
  child.stdin = {
    on() {},
    write(line) {
      child.stdinWrites.push(String(line));
      const message = JSON.parse(String(line));
      if (message.type !== 'shutdown') return true;
      setTimeout(() => {
        child.stdout.write(`${JSON.stringify({
          type: 'shutdown-ack',
          seq: message.seq,
          receivedAt: Date.now(),
          stages: { requestReceivedAt: Date.now() },
        })}\n`);
        setTimeout(() => {
          alive.delete(pid);
          child.exitNow(0);
        }, 5);
      }, 0);
      return true;
    },
    end() {
      child.stdinEnds += 1;
    },
  };
  child.exitNow = (code = 0) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.exitCode = code;
    alive.delete(pid);
    child.emit('exit', code, null);
    child.emit('close', code);
  };
  return child;
}

function makeHarness({ backend = 'spout', settings = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'spout-vts-hide-'));
  const timers = makeTimers();
  const events = [];
  const { controller, state } = makeVts();
  const alive = new Set();
  const children = [];
  let nextPid = 900100;
  const layer = new SpoutLayer({
    root,
    settings: () => ({ ...settings }),
    log: { emit: async (type, payload) => events.push({ type, payload }) },
    vtsWindow: controller,
    backend,
    timers,
    spawnProcess: () => {
      nextPid += 1;
      alive.add(nextPid);
      const child = makeChild(nextPid, alive);
      children.push(child);
      return child;
    },
  });
  // Keep the launch offline and deterministic: no Electron probe, no WMI, no real window helper.
  layer.validate = async () => ({ ok: true, path: 'electron.exe', version: '44.7.0' });
  layer.cleanupStale = async () => ({ ok: true });
  layer.processCreatedAt = async () => '2026-11-06T00:00:00.000Z';
  layer.descendantPids = async () => [];
  layer.alive = (id) => alive.has(Number(id));
  layer.killTree = async () => false;
  layer.killPids = async () => [];
  return {
    layer,
    state,
    timers,
    children,
    alive,
    events,
    of: (type) => events.filter((entry) => entry.type === type),
    cleanup: () => {
      for (const child of children) child.exitNow(0);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('1. a first start whose hide fails retries exactly once and reports the two outcomes apart', async (t) => {
  const h = makeHarness();
  t.after(h.cleanup);
  assert.deepEqual([...VTS_HIDE_RETRY_DELAYS_MS], [300, 800, 1500], 'the production schedule is finite');

  // VTS is not up (or has no handle) at the instant the display starts: the hide really fails.
  h.state.captureOk = false;
  const started = await h.layer.start();
  assert.equal(started.ok, true, 'the display started');
  assert.equal(started.display.ok, true, 'display is reported on its own');
  assert.equal(started.display.running, true);
  assert.equal(h.layer.snapshot().running, true);
  assert.equal(started.vts.ok, false, 'a failed hide does NOT ride on display success');
  assert.equal(started.vts.hidden, false);
  assert.equal(started.vts.retrying, true);
  assert.equal(started.vts.code, 'VTS_NOT_RUNNING', 'the reason is the window being unavailable, not the display');
  assert.equal(h.layer.snapshot().vtsWindow.hidden, false);
  assert.equal(started.vts.attempts, 1);

  // The spawn event carries both conclusions too: it can no longer be read as "all good".
  const spawned = h.of('spoutLayer.spawned');
  assert.equal(spawned.length, 1);
  assert.deepEqual(spawned[0].payload.display, { ok: true, running: true });
  assert.deepEqual(
    { hidden: spawned[0].payload.vts.hidden, ok: spawned[0].payload.vts.ok, code: spawned[0].payload.vts.code },
    { hidden: false, ok: false, code: 'VTS_NOT_RUNNING' },
  );

  // One retry event for the first failure, carrying the code and the delay that was scheduled.
  const retries = h.of('spout.vts.hide.retry');
  assert.equal(retries.length, 1, 'exactly one retry announced');
  assert.equal(retries[0].payload.attempt, 1);
  assert.equal(retries[0].payload.code, 'VTS_NOT_RUNNING');
  assert.equal(retries[0].payload.delayMs, 300);
  assert.deepEqual(h.timers.plannedDelays(), [300]);
  assert.equal(h.of('spout.vts.hide.recovered').length, 0);

  // The window becomes available, then the scheduled retry runs: second hide attempt succeeds.
  h.state.captureOk = true;
  const delays = await h.timers.advance(300);
  assert.deepEqual(delays, [300], 'the retry ran at 300 ms');

  const recovered = h.of('spout.vts.hide.recovered');
  assert.equal(recovered.length, 1, 'the recovery is recorded');
  assert.equal(recovered[0].payload.attempts, 1, 'one retry was enough');
  assert.equal(h.of('spout.vts.hide.retry').length, 1, 'no extra retry was scheduled');
  assert.equal(h.layer.snapshot().vtsWindow.hidden, true, 'VTS is really parked now');
  assert.equal(h.layer.snapshot().vtsHide.failure, null);
  assert.deepEqual(h.timers.pending(), [], 'the chain is finished');
  assert.deepEqual(h.state.bounds, { x: -2200, y: -1400, width: 520, height: 800 }, 'VTS moved off screen');
  t.diagnostic(`display=${JSON.stringify(started.display)} · vts(before)=${JSON.stringify(started.vts)} · retry=${JSON.stringify(retries[0].payload)} · recovered=${JSON.stringify(recovered[0].payload)}`);
});

test('2. leaving edit mode runs the same hide + retry + separate report', async (t) => {
  const h = makeHarness();
  t.after(h.cleanup);

  const first = await h.layer.start();
  assert.equal(first.ok, true);
  assert.equal(h.layer.snapshot().vtsWindow.hidden, true, 'the first start parked VTS');

  const entered = await h.layer.setEditMode(true);
  assert.equal(entered.ok, true, 'edit mode is the VTS session');
  assert.equal(h.layer.editing, true);
  assert.equal(h.layer.snapshot().vtsWindow.hidden, false, 'VTS is back on screen for editing');
  assert.equal(h.children[0].exitCode, 0, 'the display really stopped');

  // The user leaves VTS at a new rectangle, then the window refuses the parking move once.
  const LEFT_AT = { x: 300, y: 200, width: 500, height: 700 };
  h.state.bounds = { ...LEFT_AT };
  h.state.moveFailures = 1;

  const exited = await h.layer.setEditMode(false);
  assert.equal(exited.ok, true, 'the display restarted in place');
  assert.equal(exited.display.ok, true);
  assert.equal(exited.display.running, true);
  assert.equal(exited.vts.ok, false, 'the edit-exit hide failure is reported separately');
  assert.equal(exited.vts.hidden, false);
  assert.equal(exited.vts.retrying, true);
  assert.equal(exited.vts.code, 'VTS_WINDOW_MOVE_FAILED');

  const retries = h.of('spout.vts.hide.retry');
  assert.equal(retries.length, 1);
  assert.equal(retries[0].payload.attempt, 1);
  assert.equal(retries[0].payload.reason, 'edit-exit', 'the retry belongs to the edit-exit path');
  assert.equal(retries[0].payload.code, 'VTS_WINDOW_MOVE_FAILED');
  assert.deepEqual(h.timers.plannedDelays(), [300]);

  h.state.captureOk = true;
  const delays = await h.timers.advance(300);
  assert.deepEqual(delays, [300]);
  const recovered = h.of('spout.vts.hide.recovered');
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].payload.attempts, 1);
  assert.equal(recovered[0].payload.reason, 'edit-exit');
  assert.equal(h.layer.snapshot().vtsWindow.hidden, true, 'VTS is parked after the edit exit retry');
  assert.deepEqual(h.state.bounds, { x: -2200, y: -1400, width: 500, height: 700 });
  assert.equal(h.layer.snapshot().running, true);
  t.diagnostic(`exit.display=${JSON.stringify(exited.display)} · exit.vts=${JSON.stringify(exited.vts)} · recovered=${JSON.stringify(recovered[0].payload)} · VTS=${JSON.stringify(h.state.bounds)}`);
});

test('3. three failed retries give up: no more retries, explicit code, display still running', async (t) => {
  const h = makeHarness();
  t.after(h.cleanup);

  h.state.captureOk = false; // VTS never shows up
  const started = await h.layer.start();
  assert.equal(started.ok, true);
  assert.equal(started.vts.retrying, true);
  const movesAfterStart = h.state.moves.length;

  const fired = [];
  for (const step of [300, 800, 1500]) {
    fired.push(...(await h.timers.advance(step)));
  }
  assert.deepEqual(fired, [300, 800, 1500], 'the schedule grows: 300 → 800 → 1500');
  assert.deepEqual(h.timers.pending(), [], 'nothing is left scheduled');

  const retryEvents = h.of('spout.vts.hide.retry');
  assert.deepEqual(retryEvents.map((entry) => entry.payload.attempt), [1, 2, 3], 'one event per retry');
  assert.deepEqual(retryEvents.map((entry) => entry.payload.code), Array(3).fill('VTS_NOT_RUNNING'));

  const failed = h.of('spout.vts.hide.failed');
  assert.equal(failed.length, 1, 'the give-up is explicit');
  assert.equal(failed[0].payload.attempts, 3, 'three retries, then stop');
  assert.equal(failed[0].payload.code, 'VTS_NOT_RUNNING');
  assert.match(failed[0].payload.message, /VTS 窗口不可用/u);
  assert.equal(h.of('spout.vts.hide.recovered').length, 0);

  // No endless loop and no permanent move: hide calls stopped at the budget.
  assert.equal(h.state.moves.length, movesAfterStart, 'no move was ever possible, and none was invented');
  assert.equal(h.timers.plannedDelays().length, 3);

  // The display keeps running; the status says out loud that VTS is NOT hidden.
  const snap = h.layer.snapshot();
  assert.equal(snap.running, true);
  assert.equal(snap.vtsWindow.hidden, false);
  assert.equal(snap.vtsHide.hidden, false);
  assert.equal(snap.vtsHide.retrying, false);
  assert.equal(snap.vtsHide.failure.code, 'VTS_NOT_RUNNING');
  assert.equal(snap.vtsHide.failure.attempts, 3);
  t.diagnostic(`attempts=${snap.vtsHide.failure.attempts} · delays=${JSON.stringify(fired)} · failure=${JSON.stringify(snap.vtsHide.failure)} · running=${snap.running}`);
});

test('4. a state change before the timer fires cancels the retry and never moves the window', async (t) => {
  // 4a. Edit mode: VTS is the editable surface, so a pending hide must not fight it.
  const editing = makeHarness();
  editing.state.captureOk = false;
  await editing.layer.start();
  assert.equal(editing.timers.pending().length, 1, 'a retry is armed');
  editing.layer.editing = true; // the state an open VTS edit session sets
  const fired = await editing.timers.next();
  assert.equal(fired, 300);
  const cancelled = editing.of('spout.vts.hide.retry.cancelled');
  assert.equal(cancelled.length, 1, 'the retry is cancelled, not silently dropped');
  assert.equal(cancelled[0].payload.reason, 'editing');
  assert.equal(editing.state.moves.length, 0, 'no window move was issued');
  assert.equal(editing.layer.snapshot().vtsWindow.hidden, false, 'VTS stays visible for editing');
  assert.equal(editing.layer.snapshot().vtsHide.retrying, false);
  assert.equal(editing.layer.snapshot().vtsHide.failure, null, 'a cancellation is not a failure');
  assert.deepEqual(editing.timers.pending(), []);
  t.after(editing.cleanup);

  // 4b. Backend ownership: the chain belongs to the backend that hid the window.
  const switched = makeHarness();
  switched.state.captureOk = false;
  await switched.layer.start();
  assert.equal(switched.layer.snapshot().backend, 'spout');
  await switched.layer.setBackend('wpf');
  assert.equal(switched.layer.snapshot().backend, 'wpf', 'the snapshot follows the real backend');
  assert.equal(switched.of('spout.vts.hide.retry.cancelled').at(-1)?.payload.reason, 'backend-changed');
  assert.deepEqual(switched.timers.pending(), [], 'the timer was cleared');
  await switched.timers.next();
  assert.equal(switched.state.moves.length, 0);
  t.after(switched.cleanup);

  // 4c. Generation: a retry armed for generation N must not run for generation N+1.
  const generation = makeHarness();
  generation.state.captureOk = false;
  await generation.layer.start();
  generation.layer.generation += 1;
  await generation.timers.next();
  assert.equal(
    generation.of('spout.vts.hide.retry.cancelled').at(-1)?.payload.reason,
    'generation-changed',
  );
  assert.equal(generation.state.moves.length, 0);
  t.after(generation.cleanup);
});

test('5. snapshot().backend reports the real backend for a spout and a wpf instance', async (t) => {
  const spout = makeHarness();
  t.after(spout.cleanup);
  assert.equal(spout.layer.snapshot().backend, 'spout');

  const wpf = makeHarness({ backend: 'wpf' });
  t.after(wpf.cleanup);
  assert.equal(wpf.layer.snapshot().backend, 'wpf', 'a wpf instance never claims to be spout');

  // And it is the field, not a copy: a backend change is visible immediately.
  const moved = makeHarness();
  t.after(moved.cleanup);
  await moved.layer.setBackend('wpf');
  assert.equal(moved.layer.snapshot().backend, 'wpf');
  await moved.layer.setBackend('spout');
  assert.equal(moved.layer.snapshot().backend, 'spout');
});

test('6. a window read that finishes after edit entry must not park VTS', async (t) => {
  const h = makeHarness();
  t.after(h.cleanup);

  // The first hide fails (VTS has no handle yet), so the retry chain is armed while the display runs.
  h.state.captureOk = false;
  const started = await h.layer.start();
  assert.equal(started.vts.retrying, true);
  assert.equal(h.state.captures, 1);
  const VISIBLE = { x: 120, y: 200, width: 520, height: 800 };
  assert.deepEqual(h.state.bounds, VISIBLE, 'VTS is still where it was before the retry');
  assert.deepEqual(h.state.moves, [], 'the failed hide never issued a move');

  // The retry starts reading the window; the read is held open for the 300 ms window.
  h.state.captureOk = true;
  const readGate = deferred();
  h.state.captureBarrier = readGate;
  const retryRun = h.timers.advance(300);
  await until(() => h.state.captureStarted === 2);

  // Edit entry is requested while the read is pending. It registers synchronously and then waits
  // for the in-flight retry on the serial chain instead of racing it.
  const entering = h.layer.setEditMode(true);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 300)); // the read's 300 ms
  readGate.resolve();
  const entered = await entering;
  await retryRun;

  assert.equal(entered.ok, true, 'edit mode did enter');
  assert.equal(h.layer.editing, true);
  // The move was abandoned before it was issued: VTS was never parked at (-2200,-1400).
  assert.deepEqual(h.state.moves.filter((rect) => rect.x <= -2000), [], 'the late read never parked VTS');
  assert.deepEqual(h.state.bounds, VISIBLE, 'VTS coordinates are unchanged');
  const aborted = h.of('spout.vts.hide.aborted');
  assert.equal(aborted.length, 1, 'the abandoned move is recorded');
  assert.equal(aborted[0].payload.reason, 'editing');
  assert.equal(h.of('spout.vts.hide.failed').length, 0, 'an abort is not a hide failure');
  assert.equal(h.layer.snapshot().vtsHide.failure, null);
  assert.deepEqual(h.layer.snapshot().vtsHide.aborted.reason, 'editing');
  t.diagnostic(`read=300ms · edit entered during read=${entered.ok} · aborted=${JSON.stringify(aborted[0].payload)} · VTS=${JSON.stringify(h.state.bounds)} · moves=${JSON.stringify(h.state.moves)}`);
});

test('7. a normal retry still hides: the post-read check does not break the happy path', async (t) => {
  const h = makeHarness();
  t.after(h.cleanup);

  h.state.captureOk = false;
  await h.layer.start();
  h.state.captureOk = true;
  const VISIBLE = { x: 120, y: 200, width: 520, height: 800 };

  const readGate = deferred();
  h.state.captureBarrier = readGate;
  const retryRun = h.timers.advance(300);
  await until(() => h.state.captureStarted === 2);
  readGate.resolve();
  await retryRun;

  assert.equal(h.of('spout.vts.hide.aborted').length, 0, 'nothing aborted');
  const recovered = h.of('spout.vts.hide.recovered');
  assert.equal(recovered.length, 1, 'the retry recovered');
  assert.equal(recovered[0].payload.attempts, 1);
  assert.deepEqual(h.state.bounds, { x: -2200, y: -1400, width: VISIBLE.width, height: VISIBLE.height },
    'VTS is parked off screen');
  const snap = h.layer.snapshot();
  assert.equal(snap.vtsWindow.hidden, true);
  assert.equal(snap.vtsHide.failure, null);
  assert.equal(snap.vtsHide.aborted, null);
  t.diagnostic(`recovered=${JSON.stringify(recovered[0].payload)} · VTS=${JSON.stringify(h.state.bounds)} · hidden=${snap.vtsWindow.hidden}`);
});

test('8. an edit request registered first invalidates a hide that arrives later', async (t) => {
  const h = makeHarness();
  t.after(h.cleanup);

  h.state.captureOk = false;
  await h.layer.start();
  h.state.captureOk = true;
  const VISIBLE = { x: 120, y: 200, width: 520, height: 800 };
  const capturesBefore = h.state.captures;
  const movesBefore = h.state.moves.length;

  // The edit request is registered synchronously, before its own first await.
  const entering = h.layer.setEditMode(true);
  assert.notEqual(h.layer.editRequest, null, 'the edit request is visible before `editing` flips');

  // A hide arrives now (the same checked flow the retry uses): it is invalidated at the entry check.
  const late = await h.layer.hideVts(null, {
    shouldContinue: () => h.layer.vtsHideAbortReason(null),
  });
  assert.equal(late.ok, false);
  assert.equal(late.aborted, true);
  assert.equal(late.reason, 'editing');
  assert.equal(h.state.captures, capturesBefore, 'the window was not even read');
  assert.equal(h.state.moves.length, movesBefore, 'no window move was issued');
  assert.deepEqual(h.state.bounds, VISIBLE, 'VTS stays visible for editing');
  assert.equal(h.of('spout.vts.hide.aborted').at(-1)?.payload.reason, 'editing');
  assert.equal(h.of('spout.vts.hide.failed').length, 0);
  assert.equal(h.layer.snapshot().vtsHide.failure, null);

  const entered = await entering;
  assert.equal(entered.ok, true, 'the edit session still opens');
  assert.equal(h.layer.editing, true);
  t.diagnostic(`aborted=${late.reason} · reads=${capturesBefore}->${h.state.captures} · moves=${movesBefore}->${h.state.moves.length} · editing=${h.layer.editing}`);
});

test('9. a generation change during the window read aborts the move', async (t) => {
  const h = makeHarness();
  t.after(h.cleanup);

  h.state.captureOk = false;
  await h.layer.start();
  h.state.captureOk = true;
  const VISIBLE = { x: 120, y: 200, width: 520, height: 800 };

  const readGate = deferred();
  h.state.captureBarrier = readGate;
  const retryRun = h.timers.advance(300);
  await until(() => h.state.captureStarted === 2);
  // A new display generation took over while the read was pending: the retry belongs to the old one.
  h.layer.generation += 1;
  readGate.resolve();
  await retryRun;

  assert.deepEqual(h.state.bounds, VISIBLE, 'VTS was not moved');
  assert.deepEqual(h.state.moves, [], 'not a single move was issued');
  const aborted = h.of('spout.vts.hide.aborted');
  assert.equal(aborted.length, 1);
  assert.equal(aborted[0].payload.reason, 'generation-changed');
  assert.equal(h.of('spout.vts.hide.failed').length, 0, 'aborted is not failed');
  assert.equal(h.layer.snapshot().vtsHide.failure, null);
  assert.equal(h.layer.snapshot().vtsHide.retrying, false, 'the stale chain is gone');
  assert.equal(h.of('spout.vts.hide.retry.cancelled').at(-1)?.payload.reason, 'generation-changed');
  t.diagnostic(`aborted=${JSON.stringify(aborted[0].payload)} · VTS=${JSON.stringify(h.state.bounds)} · moves=${h.state.moves.length} · retrying=${h.layer.snapshot().vtsHide.retrying}`);
});

test('10. an already-issued move is awaited by edit entry; the restore never interleaves with it', async (t) => {
  const h = makeHarness();
  t.after(h.cleanup);

  h.state.captureOk = false;
  await h.layer.start();
  h.state.captureOk = true;
  const VISIBLE = { x: 120, y: 200, width: 520, height: 800 };

  // The retry reads the window, passes the pre-move check, and issues the off-screen move; the move
  // itself is held open (a slow window helper).
  const moveGate = deferred();
  h.state.moveBarrier = moveGate;
  const retryRun = h.timers.advance(300);
  await until(() => h.state.moves.length === 1);
  assert.deepEqual(h.state.moves[0], { x: -2200, y: -1400, width: VISIBLE.width, height: VISIBLE.height });

  // Edit entry is requested now. The move was already issued, so edit waits for it (never
  // interleaves): no restore move is issued while the hide move is still in flight.
  const entering = h.layer.setEditMode(true);
  await until(() => h.layer.editRequest !== null);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  assert.equal(h.layer.editing, false, 'edit entry waits for the in-flight move');
  assert.equal(h.state.moves.length, 1, 'no restore move while the hide move is pending');

  moveGate.resolve();
  await retryRun;
  const entered = await entering;

  assert.equal(entered.ok, true);
  assert.equal(h.layer.editing, true);
  assert.equal(h.state.moves.length, 2, 'exactly one restore move followed the completed hide move');
  assert.equal(h.state.moves[0].x, -2200, 'the issued move really completed');
  assert.deepEqual(h.state.moves[1], VISIBLE, 'the restore is ordered after it');
  assert.deepEqual(h.state.bounds, VISIBLE, 'VTS ends visible for edit mode');
  assert.equal(h.of('spout.vts.hide.failed').length, 0);
  t.diagnostic(`moves=${JSON.stringify(h.state.moves)} · editing=${h.layer.editing} · VTS=${JSON.stringify(h.state.bounds)}`);
});
