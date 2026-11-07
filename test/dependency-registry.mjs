/**
 * Dependency registry invariants (P2 fixes):
 *   1. acquire always re-probes before reusing a cached "running" dependency, so a program the
 *      user started and then quit is launched again on the next component open;
 *   2. start / stop / acquire are serialized per dependency: an acquire issued while a stop is
 *      running waits for it, then probes and restarts, so `users` and the real process agree.
 *
 * Run: node --test test/dependency-registry.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createDependencyRegistry } from '../src/host/index.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('1. 依赖缓存失效：探测未运行 → acquire 重新启动一次，running 真实', async () => {
  const registry = createDependencyRegistry();
  let probeRunning = true; // the user already had OBS open (adopted as "running", never owned)
  let starts = 0;
  let stops = 0;
  registry.register('obs', {
    probe: async () => probeRunning,
    configured: () => true,
    start: async () => {
      starts += 1;
      probeRunning = true;
      return { started: true, running: true, owned: true };
    },
    stop: async () => {
      stops += 1;
      probeRunning = false;
    },
  });

  const reused = await registry.acquire('vision', 'obs');
  assert.equal(reused.started, false);
  assert.equal(reused.owned, false);
  assert.equal(starts, 0, 'a live user-started process is reused, never adopted');
  assert.equal(registry.isRunning('obs'), true);

  await registry.release('vision', 'obs', { autoClose: true });
  assert.equal(stops, 0, 'a process we did not spawn is never closed');

  // The user quits OBS while the component is closed: the cached running flag is now stale.
  probeRunning = false;
  const restarted = await registry.acquire('vision', 'obs');
  assert.equal(starts, 1, 'the next acquire probes, sees nothing, and starts exactly once');
  assert.equal(restarted.running, true);
  assert.equal(restarted.started, true);
  assert.equal(registry.isRunning('obs'), true, 'running reflects this plugin’s real start now');
  assert.equal(registry.isOwned('obs'), true);
  console.log('[deps] cached-running→probe=false → starts=1 running=true owned=true');
});

test('2. 停止屏障：stop 中的 acquire 等 stop 结束再探测/启动，最终 users 与进程一致', async () => {
  const registry = createDependencyRegistry();
  let processRunning = false;
  let starts = 0;
  let stops = 0;
  const order = [];
  let releaseStop;
  const stopGate = new Promise((resolve) => { releaseStop = resolve; });
  registry.register('dep', {
    probe: async () => {
      order.push('probe');
      return processRunning;
    },
    configured: () => true,
    start: async () => {
      order.push('start');
      starts += 1;
      processRunning = true;
      return { started: true, running: true, owned: true };
    },
    stop: async () => {
      order.push('stop:begin');
      stops += 1;
      await stopGate;
      processRunning = false;
      order.push('stop:end');
    },
  });

  await registry.acquire('old', 'dep');
  assert.equal(starts, 1);
  assert.equal(processRunning, true);

  // Old user leaves: the stop starts and blocks inside the adapter.
  const releasing = registry.release('old', 'dep', { autoClose: true });
  await tick();
  assert.ok(order.includes('stop:begin'), 'stop really began');

  // New user arrives while the stop is in flight: it must queue behind that stop.
  const acquiring = registry.acquire('new', 'dep');
  await tick();
  assert.equal(order.filter((step) => step === 'probe').length, 1, 'no probe while stop is in flight');

  releaseStop();
  const [, acquired] = await Promise.all([releasing, acquiring]);
  assert.equal(stops, 1, 'the old stop ran once');
  assert.equal(starts, 2, 'the new acquire probed after the stop and restarted');
  assert.equal(acquired.started, true);
  assert.deepEqual(registry.usersOf('dep'), ['new']);
  assert.equal(processRunning, true, 'the program is running for the new user');
  assert.equal(registry.isRunning('dep'), processRunning, 'users and process agree');

  const leftovers = await registry.release('new', 'dep', { autoClose: true });
  assert.equal(leftovers.closed, true);
  assert.equal(processRunning, false);
  assert.deepEqual(registry.usersOf('dep'), [], 'no user remains after the program exits');
  console.log('[deps] stop-barrier starts=2 stops=1 users=[new] processRunning=true→false');
});

test('3. 已排队的 stop 不会被迟到的 acquire 取消：stop → 探测 → 重启，最终一致', async () => {
  const registry = createDependencyRegistry();
  let processRunning = false;
  let starts = 0;
  let stops = 0;
  const order = [];
  registry.register('dep', {
    probe: async () => processRunning,
    configured: () => true,
    start: async () => {
      order.push('start');
      starts += 1;
      processRunning = true;
      return { started: true, running: true, owned: true };
    },
    stop: async () => {
      order.push('stop');
      stops += 1;
      processRunning = false;
    },
  });

  await registry.acquire('old', 'dep');
  const releasing = registry.release('old', 'dep', { autoClose: true });
  // The acquire is queued behind the stop even though it arrives before the stop begins.
  const acquiring = registry.acquire('new', 'dep');
  const [, acquired] = await Promise.all([releasing, acquiring]);

  assert.deepEqual(order, ['start', 'stop', 'start'], 'the decided stop completes before the restart');
  assert.equal(stops, 1);
  assert.equal(starts, 2);
  assert.equal(acquired.started, true);
  assert.deepEqual(registry.usersOf('dep'), ['new']);
  assert.equal(processRunning, true);
  assert.equal(registry.isRunning('dep'), processRunning);
  await registry.release('new', 'dep', { autoClose: true });
  console.log('[deps] queued-stop order=start,stop,start starts=2 stops=1');
});

test('4. start 在途时 release 再 acquire：不加入将被 stop 的 start，最终进程与 users 一致', async () => {
  const registry = createDependencyRegistry();
  let processRunning = false;
  let starts = 0;
  let stops = 0;
  let releaseStart;
  const startGate = new Promise((resolve) => { releaseStart = resolve; });
  registry.register('dep', {
    probe: async () => processRunning,
    configured: () => true,
    start: async () => {
      starts += 1;
      await startGate;
      processRunning = true;
      return { started: true, running: true, owned: true };
    },
    stop: async () => {
      stops += 1;
      processRunning = false;
    },
  });

  const first = registry.acquire('old', 'dep'); // start S1 is in flight (gated)
  const releasing = registry.release('old', 'dep', { autoClose: true }); // queues stop behind S1
  const second = registry.acquire('new', 'dep'); // must NOT join S1 (it is about to be stopped)
  releaseStart();
  const [, , restarted] = await Promise.all([first, releasing, second]);

  assert.equal(starts, 2, 'the new acquire queues its own start behind the stop');
  assert.equal(stops, 1, 'the stop closes the late S1 process exactly once');
  assert.equal(restarted.started, true, 'the new acquire really restarted the program');
  assert.deepEqual(registry.usersOf('dep'), ['new']);
  assert.equal(processRunning, true);
  assert.equal(registry.isRunning('dep'), processRunning, 'users and process agree');
  await registry.release('new', 'dep', { autoClose: true });
  console.log('[deps] in-flight-start race starts=2 stops=1 users=[new] processRunning=true→false');
});

