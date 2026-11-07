/**
 * VTS ownership: a controller may restore only a window it actually took over.
 *
 * The regression: `AvatarLayer.stop()` parked the REAL VTS at the WPF default rectangle
 * (120,80 / 900x1200) even when that instance had never started, overriding the rectangle another
 * backend (Spout) was using. The tests below inject fake `moveVts` / `report` so the real VTS
 * window is never touched.
 *
 * The second regression: `stop()` judged the live window against the PRE-TAKEOVER rectangle, but a
 * normal run leaves VTS parked off-screen. Every normal shutdown therefore looked like a foreign
 * move and was skipped. The baseline is now the rectangle this instance itself last applied, so
 * only a window that drifted away from that is treated as someone else's.
 *
 * Run: node --test test/avatar-layer-ownership.mjs
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { AvatarLayer, RESTORE_DRIFT_PX, WPF_ONSCREEN, rectDrifted } from '../src/host/avatar/avatarLayer.js';

const ORIGINAL = { left: 512, top: 640, width: 493, height: 832 };
const OFFSCREEN = { x: -2200, y: -1400, width: 900, height: 1200 };
/** The client rectangle a successful parking move actually leaves behind. */
const PARKED = { left: OFFSCREEN.x, top: OFFSCREEN.y, width: OFFSCREEN.width, height: OFFSCREEN.height };
/** Spout's own rectangle, i.e. what another backend left behind while this instance was idle. */
const SPOUT_RECT = { left: 40, top: 120, width: 493, height: 832 };

/** Spawn result rich enough for start()/stop(): a live mirror plus helper calls. */
function fakeChild(pid) {
  const events = new EventEmitter();
  return {
    pid,
    exitCode: null,
    stderr: new EventEmitter(),
    once: (...args) => events.once(...args),
    on: (...args) => events.on(...args),
    kill() {},
  };
}

/**
 * One isolated layer whose only window I/O is the injected pair: `moves` records every requested
 * rectangle and `reports` answers each `report()` read in order (null = VTS unreadable).
 */
async function makeLayer(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-avatar-owner-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(() => {}));
  const events = [];
  const moves = [];
  const reports = [];
  let reportCalls = 0;
  const layer = new AvatarLayer({
    dir: join(root, 'cache', 'avatar-layer'),
    root,
    scriptPath: 'C:\\app\\transparent.ps1',
    windowScriptPath: 'C:\\app\\window-move.ps1',
    log: { emit: async (type, payload) => events.push({ type, payload }) },
    spawnProcess: () => fakeChild(4242),
    processes: {
      list: async () => [],
      inspect: async (pid) => ({ pid, createdAt: '2026-11-06T00:00:00.000Z' }),
      terminate: async () => {},
    },
  });
  layer.report = async () => {
    reportCalls += 1;
    return reports.shift() ?? null;
  };
  layer.moveVts = async (box) => {
    const rect = { x: box.x ?? box.left, y: box.y ?? box.top, width: box.width, height: box.height };
    moves.push(rect);
    // Mirror the real moveVts contract: a successful move becomes the applied baseline.
    layer.lastAppliedRect = { left: rect.x, top: rect.y, width: rect.width, height: rect.height };
    return { ok: true, actual: { left: rect.x, top: rect.y, width: rect.width, height: rect.height } };
  };
  return {
    layer,
    events,
    moves,
    /** Queue the next report() answer(s); replaces whatever was pending. */
    queueReport(...answers) {
      reports.length = 0;
      reports.push(...answers);
    },
    reportCalls: () => reportCalls,
  };
}

const eventTypes = (events) => events.map((entry) => entry.type);
const eventOf = (events, type) => events.find((entry) => entry.type === type) ?? null;

test('1. a controller that never took VTS over moves nothing on stop and emits nothing', async (t) => {
  const { layer, events, moves, reportCalls } = await makeLayer(t);

  const stopped = await layer.stop();

  assert.equal(moves.length, 0, 'moveVts was never called: the real VTS window is untouched');
  assert.equal(reportCalls(), 0, 'VTS was not even queried: there is nothing to restore');
  assert.deepEqual(eventTypes(events), [], 'no takeover/restore/fallback events');
  assert.equal(layer.vtsTakenOver, false);
  assert.equal(stopped.pid, 0, 'stop still reports the (absent) owned pid');
  t.diagnostic(`moves=${moves.length} reportCalls=${reportCalls()} events=${JSON.stringify(eventTypes(events))}`);
});

test('2. a normal stop restores the parked window to the pre-takeover rectangle (never skipped)', async (t) => {
  const { layer, events, moves, queueReport } = await makeLayer(t);

  queueReport(ORIGINAL); // what VTS really had before start() parked it
  const started = await layer.start();
  assert.equal(started.ok, true);
  assert.equal(layer.vtsTakenOver, true);
  assert.deepEqual(layer.preTakeoverRect, ORIGINAL);
  assert.deepEqual(moves, [{ x: OFFSCREEN.x, y: OFFSCREEN.y, width: OFFSCREEN.width, height: OFFSCREEN.height }]);
  assert.deepEqual(layer.lastAppliedRect, PARKED, 'the parking move is the last rectangle this instance applied');
  assert.deepEqual(eventOf(events, 'avatar.vts.takeover')?.payload, {
    rect: { x: ORIGINAL.left, y: ORIGINAL.top, width: ORIGINAL.width, height: ORIGINAL.height },
  });

  // The real timing the old test hid: by stop() VTS is still parked off-screen, i.e. nowhere near
  // the pre-takeover rectangle. Comparing against that stale target would report rect-changed.
  assert.equal(rectDrifted(PARKED, ORIGINAL), true, `parked differs from pre-takeover by more than ${RESTORE_DRIFT_PX} px`);
  assert.equal(rectDrifted(PARKED, layer.lastAppliedRect), false, 'the window is still where this instance left it');
  queueReport(PARKED); // exactly what the successful parking move applied
  await layer.stop();

  assert.equal(eventOf(events, 'avatar.vts.restore.skipped'), null, 'a normal stop is not a foreign move');
  assert.equal(moves.length, 2, 'one parking move + one restore move');
  assert.deepEqual(moves.at(-1), { x: 512, y: 640, width: 493, height: 832 }, 'restored the real client rect');
  assert.notDeepEqual(moves.at(-1), { x: 120, y: 80, width: 900, height: 1200 }, 'never the WPF default');
  assert.deepEqual(eventOf(events, 'avatar.vts.restore')?.payload, {
    rect: { x: 512, y: 640, width: 493, height: 832 },
    source: 'pre-takeover',
  });
  assert.equal(eventOf(events, 'avatar.vts.restore.fallback'), null, 'no fallback was needed');
  assert.equal(layer.vtsTakenOver, false, 'ownership is released after stop');
  assert.equal(layer.preTakeoverRect, null);
  assert.equal(layer.lastAppliedRect, null, 'the applied baseline is cleared after a successful restore');
  t.diagnostic(`moves=${moves.length} lastMove=${JSON.stringify(moves.at(-1))} baseline=${JSON.stringify(PARKED)} restore=${JSON.stringify(eventOf(events, 'avatar.vts.restore')?.payload)}`);
});

test('3. a takeover with no readable pre-takeover rect falls back to the on-screen corner', async (t) => {
  const { layer, events, moves, queueReport } = await makeLayer(t);

  queueReport(null); // start() cannot read where VTS was
  await layer.start();
  assert.equal(layer.vtsTakenOver, true);
  assert.equal(layer.preTakeoverRect, null, 'an unreadable rect is not guessed');
  assert.deepEqual(eventOf(events, 'avatar.vts.takeover')?.payload, { rect: null });

  queueReport(null); // stop() cannot read the current rect either
  await layer.stop();

  assert.deepEqual(moves.at(-1), { x: WPF_ONSCREEN.x, y: WPF_ONSCREEN.y, width: WPF_ONSCREEN.width, height: WPF_ONSCREEN.height });
  assert.deepEqual(eventOf(events, 'avatar.vts.restore.fallback')?.payload, {
    rect: { x: 120, y: 80, width: 900, height: 1200 },
    reason: 'pre-takeover-unreadable',
  });
  assert.deepEqual(eventOf(events, 'avatar.vts.restore')?.payload, {
    rect: { x: 120, y: 80, width: 900, height: 1200 },
    source: 'fallback',
  });
  t.diagnostic(`moves=${moves.length} lastMove=${JSON.stringify(moves.at(-1))} fallback=${JSON.stringify(eventOf(events, 'avatar.vts.restore.fallback')?.payload)}`);
});

test('4. a takeover whose window was moved since (Spout) is skipped and reported', async (t) => {
  const { layer, events, moves, queueReport } = await makeLayer(t);

  queueReport(ORIGINAL);
  await layer.start();
  const parkedBaseline = layer.lastAppliedRect;
  assert.deepEqual(parkedBaseline, PARKED, 'parking established the applied baseline');
  moves.length = 0; // ignore the parking move

  queueReport(SPOUT_RECT); // another backend changed the rectangle while parked
  assert.equal(rectDrifted(SPOUT_RECT, parkedBaseline), true, 'the current rect no longer matches what this instance applied');
  await layer.stop();

  assert.equal(moves.length, 0, 'VTS was not moved back: Spout owns its current rectangle');
  assert.deepEqual(eventOf(events, 'avatar.vts.restore.skipped')?.payload, {
    reason: 'rect-changed',
    expected: { x: -2200, y: -1400, width: 900, height: 1200 },
    actual: { x: 40, y: 120, width: 493, height: 832 },
  });
  assert.equal(eventOf(events, 'avatar.vts.restore'), null, 'no restore was reported');
  assert.equal(layer.vtsTakenOver, false, 'the stale ownership is dropped, not retried');
  assert.equal(layer.preTakeoverRect, null);
  assert.equal(layer.lastAppliedRect, null, 'the applied baseline is dropped with the ownership');
  t.diagnostic(`moves=${moves.length} baseline=${JSON.stringify(parkedBaseline)} skipped=${JSON.stringify(eventOf(events, 'avatar.vts.restore.skipped')?.payload)}`);
});
