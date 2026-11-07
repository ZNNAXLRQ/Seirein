/**
 * Bounded-shutdown regression. Fake processes only: nothing here kills or inspects a real process.
 *
 * Covered:
 *   1. closing is set before any resource is collected; new voice delivery is refused and an
 *      autostart ladder arms no new timer;
 *   2. every internal component is stopped (and each is reported with its own ms);
 *   3. external programs: the plugin-spawned GPT-SoVITS API is always closed by recorded pid;
 *      OBS and VTube Studio are never selected, never closed and their pids are not even read;
 *   4. an item that never exits is force-killed at the deadline, recorded as `shutdown.timeout`
 *      with `confirmed: false` — never reported as released;
 *   5. `shutdown.summary.ok` is true only when every item confirmed;
 *   6. plugin unload (disposer) and a Host shutdown notification both finish inside the bound;
 *   7. a diagnostic log that never resolves cannot stretch the deadline;
 *   8. a start that waited on device enumeration does not spawn after closing began, and a resource
 *      that appeared in the same turn is released and reported as `shutdown.late-resource`;
 *   9. a killed child that does not exit is confirmed:false and enters `unconfirmed`;
 *  10. a stop that returns `{ ok: false }` is a failure, never a success;
 *  11. unloading removes the Host process listeners;
 *  12. an avatar layer that survives its termination request is unconfirmed, a gone pid is confirmed;
 *  13. speech teardown waits for the player transport instead of the immediate cancel call;
 *  14. a player that never ends stays unconfirmed at the shared deadline;
 *  15. the disposer resolves only after `shutdown.begin` and `shutdown.summary` are already in
 *      `events.jsonl` (same file read the moment dispose returns — no sleep, no polling);
 *  16. awaiting every log write keeps the total inside the existing 3500 ms budget.
 *
 * Run: node --test test/shutdown.mjs
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { AvatarLayer } from '../src/host/avatar/avatarLayer.js';
import {
  FORCE_CONFIRM_MS,
  SHUTDOWN_DEADLINE_MS,
  admitSpawn,
  createShutdownManager,
  killChildAndConfirm,
  selectShutdownItems,
  stopAvatarAndConfirm,
  waitForSpeechQuiet,
} from '../src/host/runtime/shutdown.js';
import { EventLog } from '../src/host/memory/store.js';

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

/** EventLog stand-in: records every `emit` call in order. */
const makeLog = () => {
  const events = [];
  return {
    events,
    emit(type, payload) {
      events.push({ type, payload });
      return Promise.resolve();
    },
    of(type) {
      return events.filter((entry) => entry.type === type).map((entry) => entry.payload);
    },
  };
};

const hanging = () => new Promise(() => {});

test('1. closing refuses new work and arms no new autostart timer', async () => {
  const log = makeLog();
  const manager = createShutdownManager({ deadlineMs: 50, log });
  let armed = 0;
  let timerFired = 0;

  assert.equal(manager.canStart(), true);
  assert.equal(manager.whenOpen(() => { armed += 1; timerFired += 0; }), true);
  assert.equal(armed, 1);

  manager.begin('dispose');
  assert.equal(manager.closing, true);
  assert.equal(manager.canStart(), false);
  // A retry ladder that asks the gate before arming gets a refusal and schedules nothing.
  assert.equal(manager.whenOpen(() => { armed += 1; }), false);
  assert.throws(
    () => manager.assertOpen('语音投递'),
    (error) => error?.name === 'AbortError' && /关闭/u.test(error.message),
  );
  await sleep(30);
  assert.equal(armed, 1, 'no new work was admitted after closing');
  assert.equal(timerFired, 0);

  // The same manager still runs exactly one bounded teardown.
  const summary = await manager.run('dispose');
  assert.equal(summary.ok, true);
  assert.equal(log.of('shutdown.begin').length, 1);
});

test('2. every internal component is stopped and each is reported', async () => {
  const log = makeLog();
  const stopped = [];
  const manager = createShutdownManager({ deadlineMs: 100, forceConfirmMs: 50, log, isAlive: () => false });
  manager.setPlan(() => ({
    internal: [
      { name: 'hearing', kind: 'internal', stop: () => { stopped.push('hearing'); return { confirmed: true }; } },
      { name: 'ambient', kind: 'internal', stop: () => { stopped.push('ambient'); return { confirmed: true }; } },
      { name: 'speech', kind: 'internal', stop: () => { stopped.push('speech'); return { confirmed: true }; } },
      { name: 'spoutLayer', kind: 'internal', pid: 987, stop: () => { stopped.push('spoutLayer'); return { confirmed: true }; } },
    ],
    // A user program listed as external is ignored by the selection policy.
    external: [{ name: 'app:obs', kind: 'external', pid: 111 }],
  }));

  const summary = await manager.run('dispose');
  assert.deepEqual(stopped.sort(), ['ambient', 'hearing', 'speech', 'spoutLayer']);
  assert.equal(summary.ok, true);
  assert.equal(summary.items.length, 4, 'an external program is never part of a teardown');
  for (const payload of log.of('shutdown.item')) {
    assert.equal(typeof payload.name, 'string');
    assert.equal(typeof payload.ms, 'number');
    assert.equal(payload.confirmed, true);
  }
  assert.equal(log.of('shutdown.timeout').length, 0);
});

test('3. GPT-SoVITS is always closed by recorded pid; OBS and VTS never are', async () => {
  const internal = [{ name: 'speech', kind: 'internal', stop: () => ({ confirmed: true }) }];
  const external = [
    { name: 'app:gptsovits', kind: 'external', pid: 111 },
    { name: 'app:obs', kind: 'external', pid: 222 },
    { name: 'app:vts', kind: 'external', pid: 333 },
  ];
  assert.deepEqual(selectShutdownItems({ internal, external }), [internal[0], external[0]]);
  assert.deepEqual(
    selectShutdownItems({ internal, external: external.slice(1) }),
    internal,
    'OBS/VTS are not selectable even when listed',
  );

  const closed = [];
  const killed = [];
  const read = [];
  const alive = new Set([111, 222, 333]);
  const manager = createShutdownManager({
    deadlineMs: 80,
    forceConfirmMs: 40,
    log: makeLog(),
    closeApp: async (pid) => { closed.push(pid); return true; },
    killTree: async (pid) => { killed.push(pid); alive.delete(pid); return true; },
    isAlive: (pid) => { read.push(pid); return alive.has(pid); },
  });
  manager.setPlan(() => ({ internal, external }));
  const summary = await manager.run('dispose');

  assert.deepEqual(closed, [111], 'only the plugin-spawned GPT-SoVITS gets the polite close');
  assert.deepEqual(killed, [111], 'only the recorded GPT-SoVITS pid is force-killed');
  assert.ok(read.every((pid) => pid === 111), `OBS/VTS pids are never even checked: ${read.join(',')}`);
  assert.equal(alive.has(222), true, 'OBS is left running');
  assert.equal(alive.has(333), true, 'VTS is left running');
  assert.deepEqual(summary.unconfirmed, []);
  assert.equal(summary.ok, true);
  assert.equal(summary.items.some((row) => row.name === 'app:gptsovits'), true);
});

test('4. a never-exiting item is force-killed at the deadline and never reported released', async () => {
  const log = makeLog();
  const killed = [];
  const deadlineMs = 50;
  const manager = createShutdownManager({
    deadlineMs,
    forceConfirmMs: 40,
    log,
    killTree: async (pid) => { killed.push(pid); return true; },
    isAlive: () => true, // the fake process never goes away, even after taskkill
  });
  manager.setPlan(() => ({
    internal: [{ name: 'stuckChild', kind: 'internal', pid: 4242, stop: hanging }],
  }));

  const started = Date.now();
  const summary = await manager.run('dispose');
  const elapsed = Date.now() - started;

  assert.ok(elapsed >= deadlineMs - 5, `waited for the deadline before forcing (${elapsed} ms)`);
  assert.ok(elapsed < deadlineMs + 40 + 500, `bounded teardown (${elapsed} ms)`);
  assert.deepEqual(killed, [4242]);
  assert.deepEqual(summary.unconfirmed, ['stuckChild']);
  assert.equal(summary.ok, false);
  const row = summary.items.find((entry) => entry.name === 'stuckChild');
  assert.equal(row.confirmed, false);
  assert.equal(row.forced, true);
  const timeouts = log.of('shutdown.timeout');
  assert.equal(timeouts.length, 1);
  assert.equal(timeouts[0].item, 'stuckChild');
  assert.equal(timeouts[0].forced, true);
});

test('5. shutdown.summary.ok is true only when every item confirmed', async () => {
  const log = makeLog();
  const mixed = createShutdownManager({ deadlineMs: 80, forceConfirmMs: 40, log, isAlive: () => false });
  mixed.setPlan(() => ({
    internal: [
      { name: 'ok', kind: 'internal', stop: () => ({ confirmed: true }) },
      { name: 'failed', kind: 'internal', stop: () => { throw new Error('stop failed'); } },
    ],
  }));
  const bad = await mixed.run('dispose');
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.unconfirmed, ['failed']);
  const summaryEvent = log.of('shutdown.summary').at(-1);
  assert.equal(summaryEvent.ok, false);
  assert.deepEqual(summaryEvent.unconfirmed, ['failed']);
  assert.equal(summaryEvent.items.length, 2);

  const clean = createShutdownManager({ deadlineMs: 80, forceConfirmMs: 40, log: makeLog(), isAlive: () => false });
  clean.setPlan(() => ({
    internal: [
      { name: 'a', kind: 'internal', stop: () => ({ confirmed: true }) },
      { name: 'b', kind: 'internal', stop: () => ({ confirmed: true }) },
    ],
  }));
  const good = await clean.run('dispose');
  assert.equal(good.ok, true);
  assert.deepEqual(good.unconfirmed, []);
});

test('6a. plugin unload (disposer) finishes inside the bound', async () => {
  const log = makeLog();
  const stopped = [];
  const disposers = [];
  const ctx = {
    effect(fn) {
      const dispose = fn();
      disposers.push(dispose);
      return dispose;
    },
  };
  const manager = createShutdownManager({ deadlineMs: 80, forceConfirmMs: 40, log, isAlive: () => false });
  manager.setPlan(() => ({
    internal: [
      { name: 'hearing', kind: 'internal', stop: async () => { stopped.push('hearing'); return { confirmed: true }; } },
      { name: 'speech', kind: 'internal', stop: () => { stopped.push('speech'); return { confirmed: true }; } },
    ],
  }));
  manager.attach(ctx);
  assert.equal(disposers.length, 1, 'apply registers exactly one teardown effect');

  const started = Date.now();
  const summary = await disposers[0]();
  const elapsed = Date.now() - started;

  assert.equal(summary.reason, 'plugin-unload');
  assert.equal(summary.ok, true);
  assert.deepEqual(stopped.sort(), ['hearing', 'speech']);
  assert.ok(elapsed < 400, `disposer returned promptly (${elapsed} ms)`);
});

test('6b. a Host shutdown notification starts immediately and stays bounded', async () => {
  const log = makeLog();
  const proc = new EventEmitter();
  proc.connected = true;
  const stopped = [];
  const disposers = [];
  const ctx = {
    effect(fn) {
      const dispose = fn();
      disposers.push(dispose);
      return dispose;
    },
  };
  const deadlineMs = 60;
  const manager = createShutdownManager({ deadlineMs, forceConfirmMs: 40, log, isAlive: () => false });
  manager.setPlan(() => ({
    internal: [
      { name: 'speech', kind: 'internal', stop: () => { stopped.push('speech'); return { confirmed: true }; } },
      { name: 'never', kind: 'internal', stop: hanging },
      { name: 'vision', kind: 'internal', stop: () => { stopped.push('vision'); return { confirmed: true }; } },
    ],
  }));
  manager.attach(ctx);
  manager.bindHostProcess(proc);

  const started = Date.now();
  proc.emit('message', { type: 'shutdown' });
  assert.equal(manager.closing, true, 'closing is synchronous with the notification');
  const summary = await manager.settle();
  const elapsed = Date.now() - started;

  assert.equal(summary.reason, 'host-shutdown');
  assert.equal(summary.ok, false);
  assert.deepEqual(summary.unconfirmed, ['never']);
  assert.ok(elapsed >= deadlineMs - 5, `the never-exiting item got the deadline (${elapsed} ms)`);
  assert.ok(elapsed < deadlineMs + 400, `host teardown bounded (${elapsed} ms)`);
  assert.deepEqual(stopped.sort(), ['speech', 'vision']);
  assert.equal(log.of('shutdown.begin').length, 1, 'dispose after the notification does not start a second run');

  // The fiber disposer still has to return a result (the Host awaits it) and must not re-run stops.
  const viaDisposer = await disposers[0]();
  assert.equal(viaDisposer, summary);
  assert.deepEqual(stopped.sort(), ['speech', 'vision']);
});

test('7. a log that never returns cannot outrun the deadline', async () => {
  const events = [];
  const log = {
    emit(type, payload) {
      events.push({ type, payload });
      return new Promise(() => {});
    },
  };
  const manager = createShutdownManager({ deadlineMs: 20, forceConfirmMs: 20, log, isAlive: () => false });
  manager.setPlan(() => ({
    internal: [{ name: 'hearing', kind: 'internal', stop: () => ({ confirmed: true }) }],
  }));

  const started = Date.now();
  const summary = await manager.run('dispose');
  const elapsed = Date.now() - started;

  assert.equal(summary.ok, true, 'the hanging log does not change the verdict');
  // Windows timers have ~15.6 ms granularity, so three bounded emits may land on separate ticks.
  // The bound still proves the hanging log cannot stretch teardown indefinitely.
  assert.ok(elapsed <= 4 * 20 + 20, `teardown stayed bounded with a hanging log (${elapsed} ms)`);
  const item = events.find((entry) => entry.type === 'shutdown.item');
  assert.equal(item?.payload.confirmed, true, 'a log timeout never flips confirmed');
  assert.equal(
    events.filter((entry) => entry.type === 'shutdown.summary').length,
    1,
    'shutdown.summary is still produced',
  );
  // A timed-out write is recorded on the summary and teardown continues (never waits forever).
  assert.ok(summary.logTimeouts.includes('shutdown.begin'), `begin timeout recorded: ${summary.logTimeouts.join(',')}`);
  assert.ok(summary.logTimeouts.length >= 1, 'at least one write was recorded as timed out');
});

test('8. a start that waits on device enumeration never crosses the closing boundary', async () => {
  // Closing during the wait: nothing is spawned, and there is no late resource to report.
  const log = makeLog();
  const manager = createShutdownManager({ deadlineMs: 30, forceConfirmMs: 20, log, isAlive: () => false });
  let spawns = 0;
  let commits = 0;
  const refused = await admitSpawn({
    manager,
    log,
    name: 'hearing',
    prepare: async () => {
      manager.begin('unload');
      return { device: 'mic' };
    },
    spawn: () => {
      spawns += 1;
      return { pid: 1234 };
    },
    release: () => {
      throw new Error('nothing was built');
    },
    commit: () => {
      commits += 1;
    },
  });
  assert.equal(refused.started, false);
  assert.equal(refused.reason, 'closing');
  assert.equal(spawns, 0, 'the microphone is not spawned after teardown started');
  assert.equal(commits, 0, 'a refused start never adopts a resource');
  assert.equal(log.of('shutdown.late-resource').length, 0, 'no resource means no late-resource event');

  // Closing in the same turn as the spawn: the resource exists, is reclaimed, and is reported.
  const lateLog = makeLog();
  const lateManager = createShutdownManager({ deadlineMs: 30, forceConfirmMs: 20, log: lateLog, isAlive: () => false });
  let lateSpawns = 0;
  let lateCommits = 0;
  const released = [];
  const late = await admitSpawn({
    manager: lateManager,
    log: lateLog,
    name: 'ambient',
    prepare: async () => 'CABLE Output',
    spawn: () => {
      lateSpawns += 1;
      lateManager.begin('unload-during-spawn');
      return { pid: 4321, device: 'CABLE Output' };
    },
    release: (session) => {
      released.push(session.pid);
    },
    commit: () => {
      lateCommits += 1;
    },
  });
  assert.equal(late.started, false);
  assert.equal(lateSpawns, 1, 'the spawn raced into existence exactly once');
  assert.equal(lateCommits, 0, 'the caller never adopts a resource created after closing');
  assert.deepEqual(released, [4321], 'a resource created after the boundary is reclaimed');
  assert.equal(late.late, true);
  assert.equal(late.released, true);
  const lateEvent = lateLog.of('shutdown.late-resource').at(-1);
  assert.equal(lateEvent.name, 'ambient');
  assert.equal(lateEvent.released, true);

  // Open gate: the resource is adopted inside the gate, before the caller resumes.
  const openManager = createShutdownManager({ deadlineMs: 30, forceConfirmMs: 20, log: makeLog(), isAlive: () => false });
  let adopted = null;
  const admitted = await admitSpawn({
    manager: openManager,
    name: 'hearing',
    prepare: async () => ({ device: 'mic' }),
    spawn: () => ({ pid: 99 }),
    commit: (session) => { adopted = session.pid; },
  });
  assert.equal(admitted.started, true);
  assert.equal(adopted, 99);
});

test('9. a killed child that does not exit is confirmed:false and enters unconfirmed', async () => {
  let killCalls = 0;
  const fake = { pid: 777, kill() { killCalls += 1; } };
  const proof = await killChildAndConfirm(fake, { budgetMs: 25, isAlive: () => true });
  assert.equal(proof.pid, 777);
  assert.equal(proof.confirmed, false, 'kill() returning is not proof of exit');
  assert.equal(killCalls, 1);
  assert.match(proof.error, /777/u);

  const log = makeLog();
  const killed = [];
  const manager = createShutdownManager({
    deadlineMs: 80,
    forceConfirmMs: 30,
    log,
    killTree: async (pid) => { killed.push(pid); return true; },
    isAlive: () => true,
  });
  manager.setPlan(() => ({
    internal: [{
      name: 'transparent',
      kind: 'internal',
      stop: () => killChildAndConfirm({ pid: 777, kill() {} }, { budgetMs: 20, isAlive: () => true }),
    }],
  }));
  const summary = await manager.run('dispose');

  assert.equal(summary.ok, false);
  assert.deepEqual(summary.unconfirmed, ['transparent']);
  const row = summary.items.find((entry) => entry.name === 'transparent');
  assert.equal(row.confirmed, false);
  assert.equal(row.forced, true, 'the manager forces the pid tree after a failed proof');
  assert.deepEqual(killed, [777], 'the pid reported by the stop is force-killed');
  const timeouts = log.of('shutdown.timeout');
  assert.equal(timeouts.length, 1);
  assert.equal(timeouts[0].item, 'transparent');
});

test('10. a stop that reports {ok:false} is never counted as success', async () => {
  const log = makeLog();
  const manager = createShutdownManager({ deadlineMs: 60, forceConfirmMs: 20, log, isAlive: () => false });
  manager.setPlan(() => ({
    internal: [
      { name: 'speech', kind: 'internal', stop: () => ({ ok: false, error: '播放未停止' }) },
      { name: 'subtitle', kind: 'internal', stop: async () => ({ ok: false }) },
      { name: 'avatarLayer', kind: 'internal', stop: () => ({ confirmed: true }) },
    ],
  }));
  const summary = await manager.run('dispose');

  assert.equal(summary.ok, false);
  assert.deepEqual(summary.unconfirmed.sort(), ['speech', 'subtitle']);
  assert.equal(summary.items.find((entry) => entry.name === 'speech').confirmed, false);
  assert.equal(summary.items.find((entry) => entry.name === 'subtitle').confirmed, false);
  assert.equal(summary.items.find((entry) => entry.name === 'avatarLayer').confirmed, true);
  const timeout = log.of('shutdown.timeout').find((entry) => entry.item === 'speech');
  assert.match(timeout.error, /播放未停止/u);
});

test('11. unloading removes the host process listeners', async () => {
  const proc = new EventEmitter();
  proc.connected = true;
  const manager = createShutdownManager({ deadlineMs: 30, forceConfirmMs: 20, log: makeLog(), isAlive: () => false });
  manager.setPlan(() => ({ internal: [] }));

  const disposers = [];
  const ctx = {
    effect(fn) {
      const dispose = fn();
      disposers.push(dispose);
      return dispose;
    },
  };
  // Exactly what apply() does: the teardown effect plus the host-listener disposer.
  manager.attach(ctx);
  const unbind = manager.bindHostProcess(proc);
  ctx.effect(() => unbind);

  assert.equal(proc.listenerCount('message'), 1);
  assert.equal(proc.listenerCount('disconnect'), 1);
  assert.equal(disposers.length, 2);
  disposers[1]();

  assert.equal(proc.listenerCount('message'), 0, 'the message listener is gone after unload');
  assert.equal(proc.listenerCount('disconnect'), 0, 'the disconnect listener is gone after unload');
});

test('constants stay inside the Host 5 s dispose budget', () => {
  assert.ok(SHUTDOWN_DEADLINE_MS <= 5_000 * 0.7, `${SHUTDOWN_DEADLINE_MS} ms keeps a 30 % margin`);
  assert.ok(SHUTDOWN_DEADLINE_MS + FORCE_CONFIRM_MS < 5_000, 'deadline + force confirmation fits the Host budget');
  // A generous configured deadline is clamped, so a settings mistake cannot outrun the Host.
  const clamped = createShutdownManager({ deadlineMs: 60_000, forceConfirmMs: 500 });
  assert.ok(clamped.deadlineMs <= 4_500, `configured deadline clamped to ${clamped.deadlineMs} ms`);
});

/** Tiny stand-in for a spawned PowerShell: only close/error are needed by the layer. */
const fakeChild = (pid) => {
  const child = new EventEmitter();
  child.pid = pid;
  child.kill = () => {};
  process.nextTick(() => child.emit('close', 0));
  return child;
};

const makeAvatarLayer = (dir, pid, spawnProcess) => {
  const layer = new AvatarLayer({
    dir,
    scriptPath: 'mirror.ps1',
    windowScriptPath: 'window.ps1',
    root: dir,
    spawnProcess,
  });
  layer.child = fakeChild(pid);
  return layer;
};

test('12. avatarLayer stop reports its pid and only a gone pid is confirmed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-shutdown-avatar-'));
  let nextPid = 9000;
  const fakeSpawn = () => fakeChild(++nextPid);
  try {
    // stop() must name the process it owned; its cleared `running` slot proves nothing.
    const direct = makeAvatarLayer(dir, 31337, fakeSpawn);
    const stopped = await direct.stop();
    assert.equal(stopped.pid, 31337, 'stop returns the pid captured before the slot was cleared');
    assert.equal(direct.running, false);

    // The fake process survives the termination request: no success may be reported.
    const aliveLayer = makeAvatarLayer(dir, 31338, fakeSpawn);
    const aliveManager = createShutdownManager({
      deadlineMs: 200,
      forceConfirmMs: 40,
      log: makeLog(),
      isAlive: () => true,
      killTree: async () => true,
    });
    aliveManager.setPlan(() => ({
      internal: [{
        name: 'avatarLayer',
        kind: 'internal',
        stop: () => stopAvatarAndConfirm(aliveLayer, { budgetMs: 40, isAlive: () => true }),
      }],
    }));
    const aliveSummary = await aliveManager.run('dispose');
    assert.equal(aliveSummary.ok, false, 'a live layer never confirms');
    assert.deepEqual(aliveSummary.unconfirmed, ['avatarLayer']);
    assert.equal(aliveSummary.items.find((row) => row.name === 'avatarLayer').confirmed, false);

    // The fake process is gone: the same item confirms the exit.
    const goneLayer = makeAvatarLayer(dir, 31339, fakeSpawn);
    const goneManager = createShutdownManager({
      deadlineMs: 200,
      forceConfirmMs: 40,
      log: makeLog(),
      isAlive: () => false,
      killTree: async () => true,
    });
    goneManager.setPlan(() => ({
      internal: [{
        name: 'avatarLayer',
        kind: 'internal',
        stop: () => stopAvatarAndConfirm(goneLayer, { budgetMs: 40, isAlive: () => false }),
      }],
    }));
    const goneSummary = await goneManager.run('dispose');
    assert.equal(goneSummary.ok, true);
    assert.deepEqual(goneSummary.unconfirmed, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('13. speech shutdown waits for the real player end, not the cancel call', async () => {
  let finishPlayer = null;
  const player = new Promise((resolvePromise) => { finishPlayer = resolvePromise; });
  // The cancel path returns immediately; only the transport settles 200 ms later.
  setTimeout(() => finishPlayer(), 200);
  const session = { done: Promise.resolve(), transport: player, transportKnown: true };
  const deadlineMs = 600;
  const manager = createShutdownManager({
    deadlineMs,
    forceConfirmMs: 50,
    log: makeLog(),
    isAlive: () => false,
  });
  manager.setPlan(() => ({
    internal: [{
      name: 'speech',
      kind: 'internal',
      stop: () => waitForSpeechQuiet({ session }),
    }],
  }));

  const started = Date.now();
  const summary = await manager.run('dispose');
  const elapsed = Date.now() - started;

  assert.equal(summary.ok, true);
  assert.deepEqual(summary.unconfirmed, []);
  assert.equal(summary.items.find((row) => row.name === 'speech').confirmed, true);
  assert.ok(elapsed >= 190, `waited for the player to exit (${elapsed} ms)`);
  assert.ok(elapsed < deadlineMs, `finished inside the deadline (${elapsed} ms)`);
});

test('14. speech shutdown stays confirmed:false when the player never ends', async () => {
  const session = { done: Promise.resolve(), transport: hanging(), transportKnown: true };
  const deadlineMs = 120;
  const log = makeLog();
  const manager = createShutdownManager({
    deadlineMs,
    forceConfirmMs: 40,
    log,
    isAlive: () => false,
  });
  manager.setPlan(() => ({
    internal: [{
      name: 'speech',
      kind: 'internal',
      stop: () => waitForSpeechQuiet({ session }),
    }],
  }));

  const started = Date.now();
  const summary = await manager.run('dispose');
  const elapsed = Date.now() - started;

  assert.equal(summary.ok, false);
  assert.deepEqual(summary.unconfirmed, ['speech']);
  assert.equal(summary.items.find((row) => row.name === 'speech').confirmed, false);
  assert.ok(elapsed >= deadlineMs - 5, `gave the player the full deadline (${elapsed} ms)`);
  assert.ok(elapsed < deadlineMs + 200, `bounded teardown (${elapsed} ms)`);
  assert.equal(log.of('shutdown.timeout').some((entry) => entry.item === 'speech'), true);
});

/** Read the real event log with no wait: the assertion is that the bytes are already on disk. */
const readEvents = (root) => readFileSync(join(root, 'data', 'events.jsonl'), 'utf8')
  .split('\n')
  .filter((line) => line.length > 0)
  .map((line) => JSON.parse(line));

test('15. dispose resolves only after shutdown.begin and shutdown.summary are in events.jsonl', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-shutdown-log-'));
  const eventLog = new EventLog(root);
  const disposers = [];
  const ctx = {
    effect(fn) {
      const dispose = fn();
      disposers.push(dispose);
      return dispose;
    },
  };
  try {
    const manager = createShutdownManager({ deadlineMs: 1000, forceConfirmMs: 100, log: eventLog, isAlive: () => false });
    manager.setPlan(() => ({
      internal: [
        { name: 'hearing', kind: 'internal', stop: async () => { await sleep(25); return { confirmed: true }; } },
        { name: 'speech', kind: 'internal', stop: () => ({ confirmed: true }) },
      ],
    }));
    manager.attach(ctx);

    const started = Date.now();
    const summary = await disposers[0]();
    const elapsed = Date.now() - started;

    assert.equal(summary.reason, 'plugin-unload');
    assert.equal(summary.ok, true);
    assert.deepEqual(summary.logTimeouts, [], 'every awaited write finished inside the budget');

    // Same file, first read after the disposer resolved: nothing is polled and nothing is slept on.
    const written = readEvents(root);
    const types = written.map((entry) => entry.type);
    assert.ok(types.includes('shutdown.begin'), `shutdown.begin already flushed: ${types.join(',')}`);
    assert.ok(types.includes('shutdown.summary'), `shutdown.summary already flushed: ${types.join(',')}`);
    assert.ok(types.indexOf('shutdown.begin') < types.indexOf('shutdown.summary'), 'begin precedes summary');
    const begin = written.find((entry) => entry.type === 'shutdown.begin');
    assert.equal(begin.payload.reason, 'plugin-unload');
    assert.deepEqual(begin.payload.items, ['hearing', 'speech']);
    assert.equal(written.filter((entry) => entry.type === 'shutdown.item').length, 2);
    console.log(`[shutdown 15] elapsed=${elapsed}ms file=${types.join(',')}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('16. awaiting every log write keeps the total inside the existing 3500 ms budget', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-shutdown-budget-'));
  const eventLog = new EventLog(root);
  let writes = 0;
  // A slow-but-bounded log: each write costs 10 ms, so every awaited emit is measurable.
  const slowLog = {
    emit(type, payload) {
      writes += 1;
      return sleep(10).then(() => eventLog.emit(type, payload));
    },
  };
  try {
    const manager = createShutdownManager({ log: slowLog, isAlive: () => false }); // default budget
    assert.equal(manager.deadlineMs, SHUTDOWN_DEADLINE_MS, 'the default deadline is unchanged');
    manager.setPlan(() => ({
      internal: Array.from({ length: 5 }, (_, index) => ({
        name: `item-${index}`,
        kind: 'internal',
        stop: async () => { await sleep(50); return { confirmed: true }; },
      })),
    }));

    const started = Date.now();
    const summary = await manager.run('dispose');
    const elapsed = Date.now() - started;

    assert.equal(summary.ok, true);
    assert.ok(elapsed < 3500, `total teardown < 3500 ms (${elapsed} ms)`);
    assert.ok(elapsed < manager.deadlineMs, `inside the configured deadline (${elapsed} ms)`);
    assert.deepEqual(summary.logTimeouts, []);
    // 1 begin + 5 items + 1 summary; every write is still awaited before teardown returns.
    assert.equal(writes, 7, `every write was awaited (${writes})`);
    const written = readEvents(root);
    assert.equal(written.filter((entry) => entry.type === 'shutdown.item').length, 5);
    assert.ok(written.some((entry) => entry.type === 'shutdown.summary'));
    console.log(`[shutdown 16] elapsed=${elapsed}ms writes=${writes} budget=${manager.deadlineMs}ms`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('17. a hanging begin log never delays resource cleanup (they run in parallel)', async () => {
  const events = [];
  const log = {
    emit(type, payload) {
      events.push({ type, payload });
      return new Promise(() => {});
    },
  };
  const deadlineMs = 60;
  const manager = createShutdownManager({ deadlineMs, forceConfirmMs: 20, log, isAlive: () => false });
  const started = Date.now();
  let stopStartDelay = -1;
  let stopFinished = false;
  manager.setPlan(() => ({
    internal: [{
      name: 'hearing',
      kind: 'internal',
      stop: async () => {
        stopStartDelay = Date.now() - started;
        await sleep(10);
        stopFinished = true;
        return { confirmed: true };
      },
    }],
  }));

  const summary = await manager.run('dispose');
  const elapsed = Date.now() - started;

  assert.equal(stopFinished, true, 'the 10 ms cleanup really completed');
  assert.ok(stopStartDelay >= 0 && stopStartDelay <= 15, `stop() starts immediately (${stopStartDelay} ms)`);
  assert.equal(summary.ok, true, 'the hanging log does not change the cleanup verdict');
  assert.deepEqual(summary.unconfirmed, []);
  assert.equal(summary.items.find((row) => row.name === 'hearing').confirmed, true);
  assert.ok(
    summary.logTimeouts.includes('shutdown.begin'),
    `the begin timeout is recorded: ${summary.logTimeouts.join(',')}`,
  );
  assert.ok(elapsed <= deadlineMs + 200, `the shared deadline still bounds teardown (${elapsed} ms)`);
  console.log(`[shutdown 17] stopStart=${stopStartDelay}ms elapsed=${elapsed}ms logTimeouts=${summary.logTimeouts.join(',')}`);
});
