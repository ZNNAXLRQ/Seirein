/**
 * Spout stop identity regressions — doubles only, no real process, no Electron runtime.
 *
 * Windows reuses PIDs immediately. The stop path used to treat `alive(pid)` as proof that a
 * recorded descendant was still running; after the display's main process exited, a system
 * process (csrss/dwm/winlogon/fontdrvhost) could own one of those numbers, so the stop waited the
 * whole budget and returned STOP_FAILED while never restoring VTS.
 *
 * The fix is per-process identity, not "younger/older than the root": every descendant records its
 * own creation time while the layer is running, and both the survivor check and the pre-kill check
 * compare PID + creation time. This file pins that contract:
 *
 *   1. reused PIDs (started earlier *or* later than the root) are ignored: stop succeeds, VTS is
 *      restored, the session/ownership is cleared and edit mode can be entered;
 *   2. a genuinely-owned descendant still alive keeps the stop failed and VTS untouched;
 *   3. an unreadable creation time is unconfirmed: the stop fails and nothing is killed by PID;
 *   4. the ownership scan stores each descendant's own `{pid, created}` and accepts legacy PIDs;
 *   5. a reuse discovered by the second read (between check and kill) skips that PID while a
 *      still-owned descendant is targeted and keeps the stop failed;
 *   6. session cleanup (including a 256-byte record) and the stop event still happen;
 *   7. a provisional root creation time (the start probe failed) is unconfirmed, never a "reuse".
 *
 * Run: node --test test/spout-stale-pids.mjs
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { SpoutLayer } from '../src/host/avatar/spoutLayer.js';

const ROOT_CREATED = '2026-11-09T12:00:00.000Z';
const DESCENDANT_CREATED = '2026-11-09T12:00:01.000Z';
const SECOND_DESCENDANT_CREATED = '2026-11-09T12:00:02.000Z';
const REUSED_EARLIER = '2026-11-09T11:30:00.000Z';
const REUSED_LATER = '2026-11-09T12:30:00.000Z';

/** VTS controller double: records moves, reports a real rectangle. */
function makeVts() {
  const moves = [];
  return {
    moves,
    async capture() {
      return { ok: true, bounds: { x: 10, y: 20, width: 520, height: 800 } };
    },
    async move(bounds, options = {}) {
      moves.push({ bounds: { ...bounds }, options: { ...options } });
      return {
        ok: true,
        bounds: { ...bounds },
        raised: options?.raise === true,
      };
    },
  };
}

/** Layer double with a temp root, an event recorder and a fake VTS controller. */
function makeLayer(t, { vtsWindow = makeVts() } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'spout-stale-pids-'));
  const events = [];
  const layer = new SpoutLayer({
    root,
    settings: () => ({}),
    log: { emit: async (type, payload) => { events.push({ type, payload }); } },
    vtsWindow,
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, layer, events, vts: vtsWindow };
}

function seedSession(layer, extra = {}) {
  mkdirSync(layer.dir, { recursive: true });
  const ownership = layer.ownership;
  const record = {
    root: layer.root,
    instance: layer.instance,
    gen: layer.generation,
    pid: ownership?.pid ?? layer.pid,
    created: layer.created || ownership?.created || '',
    ...extra,
  };
  writeFileSync(layer.sessionFile, JSON.stringify(record, null, 2));
  return layer.sessionFile;
}

function identityOwnership(layer, { rootPid, children, childCreated }) {
  layer.ownership = {
    root: layer.root,
    instance: layer.instance,
    generation: layer.generation,
    pid: rootPid,
    created: layer.created,
    children: [...children],
    childCreated: { ...childCreated },
    capturedAt: Date.now(),
    scans: 2,
  };
  return layer.ownership;
}

/** Minimal normal-branch display double; `exitCode` makes stop() skip the graceful wait. */
function fakeExitedChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = 0;
  child.signalCode = null;
  child.stdin = { write() { return true; }, end() {} };
  return child;
}

test('1. PIDs reused by earlier or later unrelated processes are ignored: stop succeeds and edit can enter', async (t) => {
  const { layer, events, vts } = makeLayer(t);
  const rootPid = 2168;
  const children = [2276, 2532, 2928];
  layer.generation = 4;
  layer.child = null;
  layer.pid = 0;
  layer.created = ROOT_CREATED;
  identityOwnership(layer, {
    rootPid,
    children,
    childCreated: {
      2276: DESCENDANT_CREATED,
      2532: SECOND_DESCENDANT_CREATED,
      2928: '2026-11-09T12:00:03.000Z',
    },
  });
  // The real VTS window was parked for capture; a successful stop must put it back.
  layer.vtsOriginal = { x: 120, y: 240, width: 520, height: 800 };
  layer.vtsHidden = true;
  // Every recorded PID is alive, but none of them still has the recorded creation time. Two were
  // started before the root and two after it: a root-relative comparison alone would miss the
  // later ones, which is why the per-process identity is what must decide.
  const actual = new Map([
    [rootPid, REUSED_EARLIER],
    [2276, REUSED_LATER],
    [2532, REUSED_EARLIER],
    [2928, REUSED_LATER],
  ]);
  layer.alive = (pid) => actual.has(Number(pid));
  layer.processCreatedAt = async (pid) => actual.get(Number(pid)) ?? '';
  const sessionFile = seedSession(layer);

  const result = await layer.stop({ deadlineAt: Date.now() + 2000, raiseVts: true });

  assert.equal(result.ok, true);
  assert.equal(result.confirmed, true);
  assert.equal(result.processTreeGone, true);
  assert.deepEqual(result.survivors, [], 'a reused PID is not a survivor');
  assert.deepEqual(result.reused, [rootPid, ...children], 'all four identities were recognized as reused');
  assert.deepEqual(result.unconfirmed, []);
  assert.equal(result.sessionRetained, false);
  assert.equal(existsSync(sessionFile), false, 'the attribution session is removed after the proven stop');
  assert.equal(layer.ownership, null, 'the ownership record is cleared');
  assert.equal(layer.child, null);
  assert.equal(layer.pid, 0);
  assert.equal(layer.created, '');
  assert.equal(layer.vtsHidden, false, 'VTS is no longer parked');
  assert.equal(vts.moves.length, 1, 'exactly the restore move');
  assert.deepEqual(vts.moves[0].bounds, { x: 120, y: 240, width: 520, height: 800 });
  assert.equal(vts.moves[0].options.raise, true, 'edit entry asks for the restore to raise VTS');
  assert.ok(
    events.some((entry) => entry.type === 'spoutLayer.pid.reused' && entry.payload.pid === 2276),
    'each reuse is recorded',
  );

  // The edit session is the point of the stop: it must be enterable after the reused PIDs are gone.
  const movesBefore = vts.moves.length;
  const entered = await layer.setEditMode(true);
  assert.equal(entered.ok, true);
  assert.equal(entered.editMode, true);
  assert.equal(layer.snapshot().editSession, 'vts');
  assert.ok(vts.moves.length > movesBefore, 'the edit entry restores VTS as the editable surface');
});

test('2. a genuinely-owned descendant that is still alive keeps the stop failed and VTS untouched', async (t) => {
  const { layer, vts } = makeLayer(t);
  const rootPid = 3000;
  const realChild = 3001;
  const reusedEarlier = 3002;
  const reusedLater = 3003;
  layer.generation = 5;
  layer.child = null;
  layer.pid = 0;
  layer.created = ROOT_CREATED;
  identityOwnership(layer, {
    rootPid,
    children: [realChild, reusedEarlier, reusedLater],
    childCreated: {
      [realChild]: DESCENDANT_CREATED,
      [reusedEarlier]: DESCENDANT_CREATED,
      [reusedLater]: DESCENDANT_CREATED,
    },
  });
  layer.vtsOriginal = { x: 10, y: 20, width: 520, height: 800 };
  layer.vtsHidden = true;
  const actual = new Map([
    [realChild, DESCENDANT_CREATED],
    [reusedEarlier, REUSED_EARLIER],
    [reusedLater, REUSED_LATER],
  ]);
  layer.alive = (pid) => actual.has(Number(pid));
  layer.processCreatedAt = async (pid) => actual.get(Number(pid)) ?? '';
  let killed = 0;
  layer.killTree = async () => { killed += 1; return false; };
  layer.killPids = async () => { killed += 1; return []; };
  const sessionFile = seedSession(layer);

  const result = await layer.stop({ deadlineAt: Date.now() + 1000, raiseVts: true });

  assert.equal(result.ok, false);
  assert.equal(result.confirmed, false);
  assert.equal(result.processTreeGone, false);
  assert.deepEqual(result.survivors, [realChild], 'only the real descendant is a survivor');
  assert.deepEqual(result.reused, [reusedEarlier, reusedLater]);
  assert.deepEqual(result.unconfirmed, []);
  assert.equal(killed, 0, 'the idle branch never kills, and reused PIDs are not targets anyway');
  assert.notEqual(layer.ownership, null, 'ownership evidence survives an unconfirmed idle stop');
  assert.notEqual(layer.ownership.childCreated?.[realChild], undefined, 'the descendant identity is retained');
  assert.equal(existsSync(sessionFile), true, 'the session is kept while a real descendant lives');
  assert.equal(result.sessionRetained, true);
  assert.equal(vts.moves.length, 0, 'VTS is not restored for a failed stop');
});

test('3. an unreadable creation time is unconfirmed: stop fails and no PID is killed', async (t) => {
  const { layer } = makeLayer(t);
  const rootPid = 3200;
  const childPid = 3201;
  layer.generation = 6;
  layer.child = fakeExitedChild(rootPid);
  layer.pid = rootPid;
  layer.created = ROOT_CREATED;
  identityOwnership(layer, {
    rootPid,
    children: [childPid],
    childCreated: { [childPid]: DESCENDANT_CREATED },
  });
  layer.alive = (pid) => [rootPid, childPid].includes(Number(pid));
  // The OS probe fails (vanished query, access denied, timeout): this is not "gone".
  layer.processCreatedAt = async () => '';
  let treeKills = 0;
  let childKills = 0;
  layer.killTree = async () => { treeKills += 1; return true; };
  layer.killPids = async () => { childKills += 1; return [childPid]; };
  const sessionFile = seedSession(layer);

  const result = await layer.stop({ deadlineAt: Date.now() + 500 });

  assert.equal(result.ok, false);
  assert.equal(result.confirmed, false);
  assert.equal(result.processTreeGone, false);
  assert.deepEqual(result.survivors, [rootPid, childPid], 'unconfirmed is retained, never treated as gone');
  assert.deepEqual(result.unconfirmed, [rootPid, childPid]);
  assert.deepEqual(result.reused, []);
  assert.equal(treeKills, 0, 'a PID alone authorizes no kill');
  assert.equal(childKills, 0, 'a PID alone authorizes no kill');
  assert.equal(existsSync(sessionFile), true);
  assert.notEqual(layer.ownership, null);
});

test('4. the ownership scan stores each descendant\'s own creation time and keeps legacy PIDs', async (t) => {
  const { layer } = makeLayer(t);
  const rootPid = 3300;
  const legacyChild = 3301;
  const freshChild = 3302;
  layer.generation = 2;
  layer.pid = rootPid;
  layer.created = ROOT_CREATED;
  // Legacy record: a bare PID with no creation time. It must survive the merge as unconfirmed,
  // not be dropped (dropping it would let a live descendant escape the stop).
  layer.ownership = {
    root: layer.root,
    instance: layer.instance,
    generation: 2,
    pid: rootPid,
    created: ROOT_CREATED,
    children: [legacyChild],
    capturedAt: Date.now(),
    scans: 0,
  };
  layer.descendantPids = async () => [legacyChild, freshChild];
  layer.processCreatedTimes = async () => ({
    [legacyChild]: SECOND_DESCENDANT_CREATED,
    [freshChild]: '',
  });

  const returned = await layer.refreshOwnership('test');

  assert.deepEqual(returned, [legacyChild, freshChild]);
  assert.deepEqual(layer.ownership.children, [legacyChild, freshChild]);
  assert.equal(layer.ownership.childCreated[legacyChild], SECOND_DESCENDANT_CREATED);
  assert.equal(layer.ownership.childCreated[freshChild], '', 'a failed read is stored as unconfirmed');
  assert.equal(layer.ownership.scans, 1);
  assert.deepEqual(
    layer.attributedIdentities().map((entry) => ({ pid: entry.pid, created: entry.created })),
    [
      { pid: rootPid, created: ROOT_CREATED },
      { pid: legacyChild, created: SECOND_DESCENDANT_CREATED },
      { pid: freshChild, created: '' },
    ],
    'the identities carry the root and every descendant with its own creation time',
  );
});

test('5. a reuse discovered by the pre-kill recheck is skipped; the still-owned descendant keeps the stop failed', async (t) => {
  const { layer, events } = makeLayer(t);
  const rootPid = 3400;
  const racedPid = 3401;
  const realPid = 3402;
  layer.generation = 7;
  layer.child = fakeExitedChild(rootPid);
  layer.pid = rootPid;
  layer.created = ROOT_CREATED;
  identityOwnership(layer, {
    rootPid,
    children: [racedPid, realPid],
    childCreated: {
      [racedPid]: DESCENDANT_CREATED,
      [realPid]: SECOND_DESCENDANT_CREATED,
    },
  });
  layer.alive = (pid) => [rootPid, racedPid, realPid].includes(Number(pid));
  let racedReads = 0;
  layer.processCreatedAt = async (pid) => {
    if (Number(pid) === rootPid) return REUSED_LATER; // the root PID already belongs to someone else
    if (Number(pid) === racedPid) {
      racedReads += 1;
      // First read (survivor check) matches; second read (pre-kill recheck) sees a reused PID.
      return racedReads === 1 ? DESCENDANT_CREATED : REUSED_EARLIER;
    }
    if (Number(pid) === realPid) return SECOND_DESCENDANT_CREATED;
    return '';
  };
  const killCalls = [];
  layer.killTree = async (pid) => { killCalls.push(['tree', Number(pid)]); return false; };
  layer.killPids = async (ids) => { killCalls.push(['pids', ...ids.map(Number)]); return []; };
  const sessionFile = seedSession(layer);

  const result = await layer.stop({ deadlineAt: Date.now() + 300 });

  assert.deepEqual(killCalls, [['pids', realPid]], 'the raced PID is never passed to taskkill');
  assert.ok(result.reused.includes(racedPid), 'the second read reclassified it as reused');
  assert.ok(result.reused.includes(rootPid), 'a reused root PID is never tree-killed');
  assert.deepEqual(result.survivors, [realPid]);
  assert.equal(result.ok, false);
  assert.equal(result.confirmed, false);
  assert.equal(result.processTreeGone, false);
  assert.deepEqual(result.killSkipped, [{ pid: racedPid, reason: 'reused' }]);
  assert.ok(
    events.some((entry) => entry.type === 'spoutLayer.kill.skipped' && entry.payload.pid === racedPid),
    'the skipped kill is recorded',
  );
  assert.equal(existsSync(sessionFile), true, 'the session is retained for the real leftover');
});

test('7. a provisional root creation time is unconfirmed, never reinterpreted as a reuse', async (t) => {
  const { layer } = makeLayer(t);
  const rootPid = 3600;
  layer.generation = 9;
  layer.child = fakeExitedChild(rootPid);
  layer.pid = rootPid;
  // The start probe failed, so `created` is the host-side spawn clock, not the OS StartTime.
  layer.created = '2026-11-09T12:00:00.900Z';
  layer.createdProvisional = true;
  identityOwnership(layer, { rootPid, children: [], childCreated: {} });
  layer.alive = (pid) => Number(pid) === rootPid;
  // A later probe succeeds and returns the real StartTime. Comparing it with the spawn clock would
  // look like a different process, but the estimate is not an identity at all.
  layer.processCreatedAt = async () => ROOT_CREATED;
  let killed = 0;
  layer.killTree = async () => { killed += 1; return true; };
  layer.killPids = async () => { killed += 1; return []; };
  const sessionFile = seedSession(layer);

  const result = await layer.stop({ deadlineAt: Date.now() + 500 });

  assert.equal(result.ok, false);
  assert.deepEqual(result.survivors, [rootPid], 'the root is unconfirmed, not "reused"');
  assert.deepEqual(result.unconfirmed, [rootPid]);
  assert.deepEqual(result.reused, []);
  assert.equal(killed, 0, 'an estimated creation time authorizes no kill');
  assert.equal(existsSync(sessionFile), true);
});

test('6. a 256-byte session record is still cleared and the stop event is intact', async (t) => {
  const { layer, events } = makeLayer(t);
  const rootPid = 3500;
  layer.generation = 8;
  layer.child = null;
  layer.pid = 0;
  layer.created = ROOT_CREATED;
  identityOwnership(layer, {
    rootPid,
    children: [],
    childCreated: {},
  });
  layer.alive = (pid) => Number(pid) === rootPid;
  layer.processCreatedAt = async () => REUSED_LATER;
  const sessionFile = seedSession(layer, { note: 'x'.repeat(256) });

  const result = await layer.stop({ deadlineAt: Date.now() + 1000 });

  assert.equal(result.ok, true);
  assert.equal(existsSync(sessionFile), false, 'a 256-byte session record is cleared like any other');
  const stopped = events.find((entry) => entry.type === 'spoutLayer.stopped');
  assert.ok(stopped, 'the success event is emitted');
  assert.equal(stopped.payload.confirmed, true);
  assert.equal(stopped.payload.processTreeGone, true);
  assert.deepEqual(stopped.payload.reused, [rootPid]);
  assert.deepEqual(stopped.payload.unconfirmed, []);
  assert.ok(JSON.stringify(stopped.payload).length >= 256, 'the evidence payload is not collapsed to a stub');
});
