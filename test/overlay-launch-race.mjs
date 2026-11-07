/**
 * Avatar-layer launch race (R14).
 *
 * `start()` spawns the mirror, then awaits a process-metadata query before recording ownership.
 * The mirror may die — or be replaced by a concurrent launch — while that query is in flight.
 * The launch must then report `LAUNCH_EXITED_EARLY` instead of dereferencing a nulled
 * `this.child`, must not overwrite the successor's record, and an unreadable creation time must
 * mark the record `unverified` so `killStale` keeps it alive.
 *
 * Both spawn and the process table are injected: no real PowerShell is started.
 *
 * Run: node --test test/overlay-launch-race.mjs
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { AvatarLayer } from '../src/host/avatar/avatarLayer.js';

const CREATED = '2026-11-05T01:00:00.000Z';

/** One temp root with the real `<root>/cache/avatar-layer` layout. */
async function tempRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-overlay-launch-race-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(() => {}));
  return { root, dir: join(root, 'cache', 'avatar-layer') };
}

function mirrorCommand(stateDir) {
  return `powershell -NoProfile -STA -ExecutionPolicy Bypass -File C:\\app\\transparent.ps1 -StateDir ${stateDir}`;
}

/** A spawn result rich enough for `start`/`stop`/`moveVts`, with an explicit close switch. */
function fakeChild(pid) {
  const events = new EventEmitter();
  const child = {
    pid,
    exitCode: null,
    killed: false,
    stderr: new EventEmitter(),
    once: (...args) => events.once(...args),
    on: (...args) => events.on(...args),
    kill() {
      child.killed = true;
    },
    emitClose(code = 0) {
      if (child.exitCode !== null) return;
      child.exitCode = code;
      events.emit('close', code);
    },
  };
  return child;
}

/** Fake spawner: mirror launches stay open, helper scripts (window move, taskkill) finish at once. */
function harness() {
  const children = [];
  const mirrors = [];
  let nextPid = 6100;
  const spawnProcess = (command, args = []) => {
    const child = fakeChild(nextPid);
    nextPid += 1;
    children.push(child);
    if (command === 'powershell' && args.includes('-StateDir')) {
      mirrors.push(child);
    } else {
      queueMicrotask(() => child.emitClose());
    }
    return child;
  };
  return { children, mirrors, spawnProcess };
}

function mount({ root, dir, spawnProcess, inspect, list = async () => [] }) {
  const events = [];
  const terminated = [];
  const layer = new AvatarLayer({
    dir,
    root,
    scriptPath: 'C:\\app\\transparent.ps1',
    windowScriptPath: 'C:\\app\\window-move.ps1',
    log: { emit: async (type, payload) => events.push({ type, ...payload }) },
    spawnProcess,
    processes: {
      list,
      inspect,
      terminate: async (pid) => {
        terminated.push(pid);
      },
    },
  });
  return { layer, events, terminated };
}

function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function readOwnerRows(dir) {
  try {
    const parsed = JSON.parse(await readFile(join(dir, 'owners.json'), 'utf8'));
    return Array.isArray(parsed?.instances) ? parsed.instances : [];
  } catch {
    return [];
  }
}

test('a mirror that exits while inspect is in flight returns LAUNCH_EXITED_EARLY without throwing', async (t) => {
  const { root, dir } = await tempRoot(t);
  const spawned = harness();

  const { layer } = mount({
    root,
    dir,
    spawnProcess: spawned.spawnProcess,
    inspect: async () => {
      // The process is already gone by the time the CIM query answers.
      const mirror = spawned.mirrors[0];
      mirror.emitClose(1);
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { pid: mirror.pid, createdAt: CREATED };
    },
  });

  // The regression threw `TypeError: Cannot read properties of null (reading 'pid')` here.
  const result = await layer.start();

  assert.equal(result.ok, false);
  assert.equal(result.code, 'LAUNCH_EXITED_EARLY');
  assert.equal(result.pid, spawned.mirrors[0].pid);
  assert.equal(layer.child, null, 'the close handler already cleared the reference');
  assert.equal(layer.running, false);
  assert.deepEqual(await readOwnerRows(dir), [], 'an early-exited launch writes no ownership record');
});

test('a concurrent launch that spawns during inspect keeps its own reference and record', async (t) => {
  const { root, dir } = await tempRoot(t);
  const spawned = harness();

  const inspectEntered = deferred();
  const firstListEntered = deferred();
  const releaseFirstInspect = deferred();
  const releaseSecondList = deferred();
  let listCalls = 0;

  const { layer } = mount({
    root,
    dir,
    spawnProcess: spawned.spawnProcess,
    list: async () => {
      listCalls += 1;
      if (listCalls === 1) firstListEntered.resolve();
      // Hold the second launch before it spawns, so the first one reaches inspect first.
      if (listCalls > 1) await releaseSecondList.promise;
      return [];
    },
    inspect: async (pid) => {
      if (spawned.mirrors.length === 1) {
        inspectEntered.resolve();
        await releaseFirstInspect.promise;
      }
      return { pid, createdAt: CREATED };
    },
  });

  const first = layer.start();
  // readOwners() performs asynchronous I/O before list(). Ensure the first request reaches
  // that boundary first; filesystem completion order must not swap the two launch identities.
  await firstListEntered.promise;
  const second = layer.start();

  await inspectEntered.promise;
  releaseSecondList.resolve();
  const secondStarted = await second;
  assert.equal(secondStarted.ok, true);
  assert.equal(layer.owner?.pid, spawned.mirrors[1].pid, 'the second launch recorded itself');

  releaseFirstInspect.resolve();
  const firstResult = await first;

  assert.equal(firstResult.ok, false);
  assert.equal(firstResult.code, 'LAUNCH_EXITED_EARLY');
  assert.equal(firstResult.pid, spawned.mirrors[0].pid);
  assert.equal(layer.child, spawned.mirrors[1], 'the replaced launch does not clobber the successor');
  assert.equal(layer.running, true);
  assert.equal(layer.owner.pid, spawned.mirrors[1].pid, 'the successor owns the layer');
  assert.deepEqual(
    (await readOwnerRows(dir)).map((row) => row.pid),
    [spawned.mirrors[1].pid],
    'only the live process is recorded',
  );
});

test('a late close from the previous process does not clear its successor', async (t) => {
  const { root, dir } = await tempRoot(t);
  const spawned = harness();

  const { layer } = mount({
    root,
    dir,
    spawnProcess: spawned.spawnProcess,
    inspect: async (pid) => ({ pid, createdAt: CREATED }),
  });

  await layer.start();
  const previous = layer.child;
  assert.equal(layer.running, true);

  await layer.stop();
  assert.equal(previous.killed, true);
  assert.equal(layer.running, false);

  await layer.start();
  const successor = layer.child;
  assert.notEqual(successor, previous);
  assert.equal(layer.running, true);

  // The old process' close lands late, after the successor is already installed.
  previous.emitClose(0);

  assert.equal(layer.child, successor, 'the stale close callback is scoped to its own child');
  assert.equal(layer.running, true);
  assert.equal(layer.owner.pid, successor.pid);
});

test('an unreadable creation time yields ownership unverified and killStale leaves it alive', async (t) => {
  const { root, dir } = await tempRoot(t);
  const spawned = harness();
  let candidates = [];

  const { layer, events, terminated } = mount({
    root,
    dir,
    spawnProcess: spawned.spawnProcess,
    list: async () => candidates,
    inspect: async () => {
      throw new Error('CIM query failed');
    },
  });

  const result = await layer.start();

  assert.equal(result.ok, true);
  assert.equal(result.ownership, 'unverified', 'the launch reports that ownership cannot be checked');
  assert.equal(layer.owner.pid, spawned.mirrors[0].pid);
  assert.equal(layer.owner.createdAt, '');
  assert.equal(layer.owner.ownership, 'unverified');
  const persisted = await readOwnerRows(dir);
  assert.equal(persisted.at(-1).pid, spawned.mirrors[0].pid);
  assert.equal(persisted.at(-1).ownership, 'unverified');

  // The process later disappears from the live table while its unverified record remains.
  const pid = layer.child.pid;
  layer.child.emitClose(0);
  candidates = [{ pid, createdAt: CREATED, commandLine: mirrorCommand(dir) }];

  const report = await layer.killStale();

  assert.deepEqual(terminated, [], 'an unverified record must never justify a kill');
  assert.deepEqual(report.killed, []);
  assert.equal(report.unverified, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'avatarLayer.stale.unverified');
  assert.equal(events[0].reason, 'ownership-unverified');
  assert.equal(events[0].pid, pid);
});
