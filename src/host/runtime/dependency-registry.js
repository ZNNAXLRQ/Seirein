/** Owned external dependency lifecycle shared by component users. */
/**
 * Ref-counted external dependency registry.
 *
 * Components are the users, dependencies are the services (OBS / VTube Studio / GPT-SoVITS).
 * Only the last user releasing a dependency stops it, and only when this plugin actually spawned
 * it — a program the user started is "running" but never "owned", so it can never be closed from
 * here. Concurrent acquires share one queued start, and every acquire re-probes before reusing:
 * the cached flag may describe a process the user has since exited.
 *
 * Every start / stop / acquire for one dependency goes through that dependency's serial queue, so
 * a new acquire can never race an in-flight stop (it waits, then probes and restarts if needed).
 *
 * Tests inject simple adapters so no real process is needed:
 *   { probe(): Promise<boolean>, configured?(): boolean,
 *     start(): Promise<{ started?, running?, owned? }>, stop?(): Promise<unknown> }
 */
export function createDependencyRegistry() {
  const adapters = new Map();
  const users = new Map();
  const owned = new Set();
  const running = new Map();
  const starting = new Map();
  /** One serial queue per dependency name (tail promise): start/stop/acquire never interleave. */
  const queues = new Map();
  /** Bumped before a stop is queued: an acquire may only join a start issued before that stop. */
  const stopEpoch = new Map();

  const usersOf = (name) => [...(users.get(name) ?? new Set())];
  const isOwned = (name) => owned.has(name) === true;
  const isRunning = (name) => running.get(name) === true || isOwned(name);

  /** Append `task` to the dependency's queue; resolved with the task's own result. */
  const enqueue = (name, task) => {
    const previous = queues.get(name) ?? Promise.resolve();
    const run = previous.then(() => task(), () => task());
    const tail = run.then(() => {}, () => {});
    queues.set(name, tail);
    // Drop an idle tail so a long-lived process does not grow one entry per stopped dependency.
    void tail.then(() => {
      if (queues.get(name) === tail) queues.delete(name);
    });
    return run;
  };

  const stopNow = async (name) => {
    const adapter = adapters.get(name);
    let result;
    try {
      result = await adapter?.stop?.({ name });
    } catch (error) {
      // A failed close is not a release: ownership stays recorded so a later retry (component
      // reopen or DSH exit) can still close the exact pid.
      return { ok: false, closed: false, name, code: 'DEPENDENCY_STOP_FAILED', error: error?.message ?? String(error) };
    }
    if (result?.ok === false) {
      return {
        ok: false,
        closed: false,
        name,
        code: result.code ?? 'DEPENDENCY_STOP_FAILED',
        error: result.error ?? 'dependency stop reported failure',
      };
    }
    owned.delete(name);
    running.delete(name);
    return { ok: true, closed: true, name };
  };

  const startNow = async (name) => {
    const adapter = adapters.get(name);
    if (adapter === undefined) return { ok: false, started: false, running: false, error: `unknown dependency: ${name}` };
    // Probe on every acquire: `running` is only a cache, and a user-started process may exit while
    // a component is closed. An adapter without a probe keeps the cache as its only evidence.
    let alreadyRunning;
    if (typeof adapter.probe === 'function') {
      try {
        alreadyRunning = (await adapter.probe()) === true;
      } catch {
        alreadyRunning = false;
      }
    } else {
      alreadyRunning = running.get(name) === true;
    }
    if (alreadyRunning) {
      // Reused, never adopted: a process we did not spawn is not ours to close.
      running.set(name, true);
      return { ok: true, started: false, running: true, owned: isOwned(name) };
    }
    // The probe is the truth: a cached "running" must not survive a failed probe.
    running.delete(name);
    if (typeof adapter.configured === 'function' && adapter.configured() !== true) {
      return { ok: true, started: false, running: false, skipped: 'unconfigured' };
    }
    try {
      const result = (await adapter.start()) ?? {};
      running.set(name, result.running !== false);
      if (result.owned === true) owned.add(name);
      return {
        ok: result.ok !== false,
        started: result.started === true,
        running: result.running !== false,
        owned: isOwned(name),
        ...result,
      };
    } catch (error) {
      return { ok: false, started: false, running: false, error: error?.message ?? String(error) };
    }
  };

  /** Queue a stop: a concurrent acquire's queued start can only run after it settles. */
  const stop = (name) => enqueue(name, () => stopNow(name));

  return {
    register(name, adapter) {
      if (typeof name !== 'string' || name.length === 0) throw new Error('dependency name required');
      adapters.set(name, adapter ?? {});
      return () => adapters.delete(name);
    },
    /**
     * Add `owner` as a user and queue a start. Concurrent acquires share the queued start, but a
     * start issued before a later stop is not joined: that start's process is about to be closed,
     * so the acquire queues its own probe/start behind the stop instead of returning a dead state.
     */
    acquire(owner, name) {
      if (!users.has(name)) users.set(name, new Set());
      users.get(name).add(owner);
      const epoch = stopEpoch.get(name) ?? 0;
      const inFlight = starting.get(name);
      if (inFlight !== undefined && inFlight.epoch === epoch) return inFlight.promise;
      const task = enqueue(name, () => startNow(name));
      starting.set(name, { promise: task, epoch });
      void task.finally(() => {
        if (starting.get(name)?.promise === task) starting.delete(name);
      });
      return task;
    },
    /** Drop one user. The last user releases the process only when autoClose says so. */
    async release(owner, name, { autoClose = true } = {}) {
      const set = users.get(name);
      set?.delete(owner);
      if (set !== undefined && set.size > 0) return { ok: true, closed: false, retained: true, name };
      users.delete(name);
      // Stop is never cancelled by a late acquire: bump the epoch so a new acquire cannot join a
      // start that this stop will close, then decide under the dependency's queue (an in-flight
      // start settles first; an acquire queued behind probes/starts again).
      stopEpoch.set(name, (stopEpoch.get(name) ?? 0) + 1);
      return enqueue(name, () => {
        if (!isOwned(name)) return { ok: true, closed: false, notOwned: true, name };
        if (autoClose !== true) return { ok: true, closed: false, retained: true, name };
        return stopNow(name);
      });
    },
    /** Dependency names this owner currently holds (owner → dependency lookup). */
    dependenciesOf(owner) {
      return [...users.keys()].filter((name) => users.get(name)?.has(owner) === true);
    },
    /** Drop every dependency relation this component holds (used on component disable). */
    async releaseAll(owner, { autoClose = true } = {}) {
      const results = [];
      for (const name of this.dependenciesOf(owner)) {
        results.push(await this.release(owner, name, { autoClose }));
      }
      return results;
    },
    /** Shutdown closes every plugin-owned dependency, regardless of a now-cleared switch. */
    async shutdown() {
      const results = [];
      for (const name of [...owned]) {
        stopEpoch.set(name, (stopEpoch.get(name) ?? 0) + 1);
        const first = await stop(name);
        results.push(first);
        // One retry for a close that failed: ownership is still recorded, so the pid is not lost.
        if (first.ok !== true && isOwned(name)) results.push(await stop(name));
      }
      users.clear();
      return results;
    },
    usersOf,
    isOwned,
    isRunning,
  };
}
