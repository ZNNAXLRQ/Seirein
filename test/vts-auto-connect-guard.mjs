/**
 * P2-B regression: a probe that returns after the component was closed (or the plugin unloaded)
 * must not connect. `vtsAutoTick` awaited `probePort()`, then only re-checked `client.ready` /
 * `connectPromise`; the component switch and the mount lifecycle were never re-read, so a late
 * probe still called `vtsConnect()` once.
 *
 * The tick is now an injectable factory (`src/host/avatar/auto-connect.js`); this suite drives a
 * deferred probe to hold the await open and changes the guards while it is in flight. No socket,
 * VTube Studio or timer is started here.
 *
 * Run: node --test test/vts-auto-connect-guard.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createVtsAutoConnect } from '../src/host/avatar/auto-connect.js';

const BACKOFF_MS = 20_000;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

/**
 * One controllable auto-connect app. Every probe is deferred so the test decides exactly when the
 * await returns; connect records how many times it was reached.
 */
function makeApp(overrides = {}) {
  const state = {
    enabled: true,
    disposed: false,
    revision: 0,
    mountRevision: 0,
    busy: false,
    now: 1_000,
    connectCalls: 0,
    connectResult: { ok: true },
  };
  const probes = [];
  const app = createVtsAutoConnect({
    probe: () => {
      const pending = deferred();
      probes.push(pending);
      return pending.promise;
    },
    connect: async () => {
      state.connectCalls += 1;
      return state.connectResult;
    },
    isEnabled: () => state.enabled,
    revision: () => state.revision,
    mountRevision: () => state.mountRevision,
    isDisposed: () => state.disposed,
    isBusy: () => state.busy,
    now: () => state.now,
    backoffMs: BACKOFF_MS,
    ...overrides,
  });
  return { app, state, probes };
}

/** Let the tick reach its await and the test's mutation land before the probe resolves. */
const flush = async () => {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
};

test('1. 正常：探测成功 → 恰好一次 connect', async () => {
  const { app, state, probes } = makeApp();
  const task = app.tick();
  await flush();
  assert.equal(probes.length, 1, 'the tick probed once');
  probes[0].resolve(true);
  const outcome = await task;
  assert.equal(state.connectCalls, 1, 'a reachable port connects exactly once');
  assert.equal(outcome.connected, true);
  assert.equal(app.nextAttemptAt(), 0, 'a successful connect resets the backoff');
});

test('2. 探测在途时关闭组件 → 0 次 connect', async () => {
  const { app, state, probes } = makeApp();
  const task = app.tick();
  await flush();
  state.enabled = false;
  probes[0].resolve(true);
  await task;
  assert.equal(state.connectCalls, 0, 'closing the component invalidates the in-flight probe');
});

test('3. 探测在途时卸载/dispose → 0 次 connect', async () => {
  const disposedApp = makeApp();
  const disposedTask = disposedApp.app.tick();
  await flush();
  disposedApp.state.disposed = true;
  disposedApp.probes[0].resolve(true);
  await disposedTask;
  assert.equal(disposedApp.state.connectCalls, 0, 'plugin dispose invalidates the in-flight probe');

  const unmountedApp = makeApp();
  const unmountedTask = unmountedApp.app.tick();
  await flush();
  unmountedApp.state.mountRevision += 1;
  unmountedApp.probes[0].resolve(true);
  await unmountedTask;
  assert.equal(unmountedApp.state.connectCalls, 0, 'an unmounted plugin invalidates the in-flight probe');
});

test('4. 探测在途时关闭后重新启用 → 旧任务 0 次，下一次 tick 正常连接', async () => {
  const { app, state, probes } = makeApp();
  const task = app.tick();
  await flush();
  state.enabled = false;
  state.revision += 1; // set(avatar,false) bumps the component revision
  state.enabled = true;
  state.revision += 1; // set(avatar,true) bumps it again: this probe belongs to the old switch
  probes[0].resolve(true);
  await task;
  assert.equal(state.connectCalls, 0, 'off→on does not resurrect the stale probe');

  const next = app.tick();
  await flush();
  assert.equal(probes.length, 2, 'the next tick probes under the new revision');
  probes[1].resolve(true);
  await next;
  assert.equal(state.connectCalls, 1, 'the new tick connects normally');
});

test('5. 探测不通不连接；探测失败不设退避，连接失败按现有 20 秒退避', async () => {
  const { app, state, probes } = makeApp();
  const unreachable = app.tick();
  await flush();
  probes[0].resolve(false);
  await unreachable;
  assert.equal(state.connectCalls, 0, 'an unreachable port never connects');
  assert.equal(app.nextAttemptAt(), 0, 'a probe failure keeps the short 4-second retry (no backoff)');

  const retried = app.tick();
  await flush();
  assert.equal(probes.length, 2, 'the next tick probes again immediately');
  state.connectResult = { ok: false, error: 'auth' };
  probes[1].resolve(true);
  await retried;
  assert.equal(state.connectCalls, 1, 'the reachable port attempted one connect');
  assert.equal(app.nextAttemptAt(), state.now + BACKOFF_MS, 'a failed connect sets the 20-second backoff');

  const skipped = app.tick();
  await flush();
  assert.equal(probes.length, 2, 'a tick inside the backoff window does not probe');
  await skipped;

  state.now += BACKOFF_MS;
  state.connectResult = { ok: true };
  const resumed = app.tick();
  await flush();
  assert.equal(probes.length, 3, 'the tick after the backoff probes again');
  probes[2].resolve(true);
  await resumed;
  assert.equal(state.connectCalls, 2, 'the retry after the backoff connects');
  assert.equal(app.nextAttemptAt(), 0, 'success resets the backoff');
});

test('6. run() 并发只跑一次；成功 tick 后关闭/重开守卫仍然生效', async () => {
  const { app, state, probes } = makeApp();
  const first = app.run();
  const second = app.run();
  assert.equal(await second, null, 'a concurrent timer callback is a no-op');
  await flush();
  assert.equal(probes.length, 1, 'the concurrent run did not start a second probe');
  probes[0].resolve(true);
  const outcome = await first;
  assert.equal(outcome.connected, true);
  assert.equal(state.connectCalls, 1, 'normal success still connects exactly once');
  assert.equal(app.nextAttemptAt(), 0, 'normal success still resets the backoff');

  // The auth preflight lives in the Host, not in this factory: a closed component must still drop a
  // successful late probe exactly as before.
  const closed = makeApp();
  const closedTask = closed.app.tick();
  await flush();
  closed.state.enabled = false;
  closed.probes[0].resolve(true);
  await closedTask;
  assert.equal(closed.state.connectCalls, 0, 'closing the component still blocks the late probe');
});
