/**
 * Bounded, ownership-scoped teardown for the companion plugin.
 *
 * Why this shape (evidence from the packaged DSH runtime):
 *   - `PROCESS_SHUTDOWN_TIMEOUT_MS = 5e3` in `@deepseek-ai/dsh/lib/profile-boot-*.js` arms a
 *     timer around the whole application dispose and then calls `process.exit`. The desktop shell
 *     additionally waits `1e4` ms for the Host process (`lib/main.js` `stop()`), but the Host is
 *     forcibly exits if disposal overruns 5 s. On successful disposal it only sets exitCode and
 *     clears that timer, so other live resources can still delay the desktop's 10 s wait.
 *   - Cordis disposes a fiber's effects with `Promise.all` (`cordis/src/fiber.ts` `_unload`), so
 *     every `ctx.effect` disposer is awaited, but concurrently. The only plugin-facing teardown
 *     hook is therefore the effect disposer; there is no `shutdown`/`onStop`/`lifecycle` hook.
 *   - Nothing may claim a handle is released: an item that never confirms is reported as
 *     `confirmed: false` in `shutdown.item` and `shutdown.summary.unconfirmed`.
 *
 * External programs are never closed by name. The one exception is the GPT-SoVITS API server this
 * plugin spawned itself: its pid was recorded at spawn, so teardown may stop that exact pid and
 * its tree. OBS and VTube Studio belong to the user and are never part of a teardown.
 */

import { spawn } from 'node:child_process';

/** The Host's own dispose budget (`profile-boot` `PROCESS_SHUTDOWN_TIMEOUT_MS`). */
export const HOST_DISPOSE_BUDGET_MS = 5000;
/** 70 % of the Host budget, so the Host can still send `shutdown-complete` inside its 5 s. */
export const SHUTDOWN_DEADLINE_MS = Math.round(HOST_DISPOSE_BUDGET_MS * 0.7);
/** Confirmation window after a forced tree kill; deadline + this must stay under 5 s. */
export const FORCE_CONFIRM_MS = 800;
/** How long a killed child gets to prove it exited before the item is reported unconfirmed. */
export const CHILD_EXIT_CONFIRM_MS = 250;
/** The only external program teardown may stop: the GPT-SoVITS API the plugin spawned itself. */
export const CLOSED_EXTERNAL_NAME = 'app:gptsovits';
/** Bound on releasing a resource the gate caught after closing had already begun. */
const LATE_RELEASE_TIMEOUT_MS = 1000;

const TIMEOUT = Symbol('shutdown-timeout');

const messageOf = (error) => (error instanceof Error ? error.message : String(error));

function runTaskkill(args) {
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn('taskkill', args, { windowsHide: true, stdio: 'ignore' });
    } catch {
      resolvePromise(false);
      return;
    }
    child.once('close', (code) => resolvePromise(code === 0));
    child.once('error', () => resolvePromise(false));
  });
}

/** Terminate one known pid and its tree. Never resolves by process name. */
export function defaultKillTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve(false);
  return runTaskkill(['/PID', String(pid), '/T', '/F']);
}

/** Polite close for an app the plugin spawned: WM_CLOSE on Windows, SIGTERM elsewhere. */
export function defaultCloseApp(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve(false);
  if (process.platform === 'win32') return runTaskkill(['/PID', String(pid), '/T']);
  try {
    process.kill(pid, 'SIGTERM');
    return Promise.resolve(true);
  } catch {
    return Promise.resolve(false);
  }
}

/** Liveness by pid only. EPERM means the process exists but is not ours to signal. */
export function defaultIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/**
 * Which recorded resources may be stopped. Every internal component is collected. Of the external
 * programs only the plugin-spawned GPT-SoVITS API is eligible; OBS and VTube Studio are the user's
 * own programs and are filtered out even when a caller lists them.
 *
 * @param {{internal?: object[], external?: object[]}} plan
 * @returns {object[]}
 */
export function selectShutdownItems({ internal = [], external = [] } = {}) {
  const selected = (Array.isArray(internal) ? internal : []).filter(Boolean);
  const spawned = (Array.isArray(external) ? external : []).filter(
    (entry) => entry && entry.name === CLOSED_EXTERNAL_NAME && Number.isInteger(entry.pid) && entry.pid > 0,
  );
  return selected.concat(spawned);
}

/**
 * Kill a child the plugin owns and confirm the pid is really gone.
 *
 * `child.kill()` returning is not proof of exit, and a wrapper process (cmd/powershell) can hand
 * its work to a child that outlives the wrapper, so liveness is checked by pid for a bounded
 * window. The returned `pid` lets the manager force the tree when the window expires; `confirmed`
 * stays false in that case, never a claimed success.
 *
 * @param {{pid?: number, kill?: () => void}|null} child
 * @param {{budgetMs?: number, isAlive?: (pid: number) => boolean, now?: () => number,
 *          setTimer?: typeof setTimeout}} [options]
 * @returns {Promise<{pid: number, confirmed: boolean, error?: string}>}
 */
export async function killChildAndConfirm(child, {
  budgetMs = CHILD_EXIT_CONFIRM_MS,
  isAlive = defaultIsAlive,
  now = Date.now,
  setTimer = setTimeout,
} = {}) {
  const pid = Number(child?.pid ?? 0);
  if (!Number.isInteger(pid) || pid <= 0) return { pid: 0, confirmed: true };
  try {
    child.kill();
  } catch {
    /* already gone: the liveness check below decides */
  }
  const alive = () => {
    try {
      return isAlive(pid) === true;
    } catch {
      return false;
    }
  };
  const end = now() + Math.max(0, budgetMs);
  for (;;) {
    if (!alive()) return { pid, confirmed: true };
    const left = end - now();
    if (left <= 0) return { pid, confirmed: false, error: `pid ${pid} 在 ${budgetMs} ms 内没有退出` };
    await new Promise((resolveSleep) => {
      // Referenced on purpose: the confirmation must finish even when nothing else holds the loop.
      setTimer(() => resolveSleep(), Math.min(25, left));
    });
  }
}

/**
 * Stop a controller that reports the pid it actually owned and confirm that pid really exited.
 *
 * `running === false` only means the controller dropped its slot; it does not prove the process
 * left. The controller's own termination request is best effort, so liveness is checked by pid
 * for a bounded window and a still-live pid is reported unconfirmed (the manager then forces it).
 *
 * @param {{stop: () => Promise<{pid?: number}|undefined>, running?: boolean}|null} controller
 * @param {{budgetMs?: number, isAlive?: (pid: number) => boolean}} [options]
 * @returns {Promise<{pid?: number, confirmed: boolean, error?: string}>}
 */
export async function stopAvatarAndConfirm(controller, {
  budgetMs = CHILD_EXIT_CONFIRM_MS,
  isAlive = defaultIsAlive,
} = {}) {
  if (controller === null || controller === undefined) return { confirmed: true };
  const stopped = await controller.stop();
  const pid = Number(stopped?.pid ?? 0);
  if (Number.isInteger(pid) && pid > 0) {
    // The controller already sent the kill; this handle only proves the pid is gone.
    return killChildAndConfirm({ pid, kill: () => {} }, { budgetMs, isAlive });
  }
  return { confirmed: controller.running !== true };
}

/**
 * Wait until a cancelled playback has really ended.
 *
 * `cancelPlayback()` clears the session slot and the clock synchronously, so neither can prove the
 * player left. This waits for the session's completion promise, the transport promise of the player
 * process, and every in-flight speech producer (synthesis/play). The shutdown manager's shared
 * deadline bounds the wait; transport that cannot be observed is reported unconfirmed, never
 * assumed stopped.
 *
 * @param {{session?: object|null, work?: Promise<any>[]}} [options]
 * @returns {Promise<{confirmed: boolean, error?: string}>}
 */
export async function waitForSpeechQuiet({ session = null, work = [] } = {}) {
  const pending = [];
  if (session !== null && typeof session?.done?.then === 'function') pending.push(session.done);
  if (session !== null && typeof session?.transport?.then === 'function') pending.push(session.transport);
  for (const item of Array.isArray(work) ? work : []) {
    if (typeof item?.then === 'function') pending.push(item);
  }
  await Promise.allSettled(pending);
  // A streamed clip has no observable player handle once its chunks are piped: awaiting its
  // producer promise does not prove the player process exited.
  if (session !== null && session?.transportKnown === false) {
    return { confirmed: false, error: '播放器进程没有可观测的退出凭据' };
  }
  return { confirmed: true };
}

/**
 * Admit a spawn that follows an asynchronous wait.
 *
 * The capture sessions enumerate devices (and the loopback path also stops its predecessor) before
 * they spawn; teardown can start during that wait. `prepare` performs the wait, the gate is re-read
 * immediately before `spawn`, and nothing is started once closing began. A resource that `spawn`
 * still managed to create (teardown started in the same turn) is released here and recorded as
 * `shutdown.late-resource`; the caller never receives it, so it cannot be forgotten. A release that
 * does not finish is left to the manager to report as unconfirmed.
 *
 * @param {object} spec
 * @param {object} spec.manager shutdown manager (`canStart`)
 * @param {object|null} [spec.log] EventLog-like `{ emit(type, payload) }`
 * @param {string} [spec.name] resource name used in `shutdown.late-resource`
 * @param {() => any} [spec.prepare] the awaited preparation; its result is passed to `spawn`
 * @param {(prepared: any) => any} [spec.spawn] the actual spawn (sync or async)
 * @param {(value: any) => any} [spec.release] stop for a resource that must not survive
 * @param {(value: any) => void} [spec.commit] synchronous adoption of an admitted resource; it runs
 *        inside the gate, so no microtask can interleave between the open check and the assignment
 * @returns {Promise<{started: boolean, reason?: string, value?: any, prepared?: any,
 *                    late?: boolean, released?: boolean}>}
 */
export async function admitSpawn({
  manager,
  log = null,
  name = 'resource',
  prepare,
  spawn: launch,
  release,
  commit,
} = {}) {
  const prepared = typeof prepare === 'function' ? await prepare() : undefined;
  if (manager?.canStart?.() !== true) return { started: false, reason: 'closing', prepared };
  const value = typeof launch === 'function' ? await launch(prepared) : undefined;
  if (manager?.canStart?.() === true) {
    if (typeof commit === 'function') commit(value);
    return { started: true, value, prepared };
  }

  let released = false;
  if (typeof release === 'function' && value !== undefined && value !== null) {
    let timer = null;
    const timeout = new Promise((resolveTimeout) => {
      timer = setTimeout(() => resolveTimeout(TIMEOUT), LATE_RELEASE_TIMEOUT_MS);
    });
    try {
      released = (await Promise.race([Promise.resolve().then(() => release(value)), timeout])) !== TIMEOUT;
    } catch {
      released = false;
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }
  // Diagnostic only: the caller already knows the start was refused, and a log must not decide it.
  try {
    if (typeof log?.emit === 'function') {
      void Promise.resolve(log.emit('shutdown.late-resource', { name, released })).catch(() => {});
    }
  } catch {
    /* a diagnostic log must not change the outcome */
  }
  return { started: false, reason: 'closing', value, prepared, late: true, released };
}

/**
 * @param {object} [options]
 * @param {number} [options.deadlineMs] shared budget for normal stopping
 * @param {number} [options.forceConfirmMs] budget for confirming a forced kill
 * @param {object|null} [options.log] EventLog-like `{ emit(type, payload) }`
 * @param {object|null} [options.diagnostics] Non-awaited observation hooks; never decide success.
 * @param {() => number} [options.now]
 * @param {(pid: number) => Promise<boolean>} [options.killTree]
 * @param {(pid: number) => Promise<boolean>} [options.closeApp]
 * @param {(pid: number) => boolean} [options.isAlive]
 */
export function createShutdownManager(options = {}) {
  const forceConfirmMs = Number.isFinite(options.forceConfirmMs) && options.forceConfirmMs >= 0
    ? Math.round(options.forceConfirmMs)
    : FORCE_CONFIRM_MS;
  // A configured deadline may shorten the budget but never break it: the Host force-exits at 5 s.
  const requestedDeadline = Number.isFinite(options.deadlineMs) && options.deadlineMs > 0
    ? Math.round(options.deadlineMs)
    : SHUTDOWN_DEADLINE_MS;
  const deadlineMs = Math.min(requestedDeadline, HOST_DISPOSE_BUDGET_MS - forceConfirmMs);
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const killTree = typeof options.killTree === 'function' ? options.killTree : defaultKillTree;
  const closeApp = typeof options.closeApp === 'function' ? options.closeApp : defaultCloseApp;
  const isAlive = typeof options.isAlive === 'function' ? options.isAlive : defaultIsAlive;
  const log = options.log ?? null;
  const diagnostics = options.diagnostics ?? null;
  const diagnose = (method, ...args) => {
    try {
      const result = diagnostics?.[method]?.(...args);
      if (typeof result?.catch === 'function') result.catch(() => {});
    } catch {
      /* Evidence must never change teardown's verdict or become an awaited dependency. */
    }
  };
  const clock = { setTimer: options.setTimer ?? setTimeout, clearTimer: options.clearTimer ?? clearTimeout };

  let closing = false;
  let closingReason = '';
  let plan = () => ({});
  let pending = null;
  let startedAt = 0;
  /** Events whose bounded write overran the deadline. Reported in the summary, never awaited twice. */
  const logTimeouts = [];
  const controller = new AbortController();

  /**
   * A diagnostic log is part of the bounded teardown: it is attempted, but a log that never returns
   * cannot delay the deadline, and its outcome never changes an item's `confirmed` verdict. A
   * timeout is recorded (and surfaced in the summary) and teardown continues.
   */
  const emit = async (type, payload, deadlineAt = null) => {
    if (log === null || typeof log?.emit !== 'function') return;
    const left = deadlineAt === null ? Number.POSITIVE_INFINITY : deadlineAt - now();
    if (left <= 0) {
      // The budget is spent: the event is still recorded, but the log gets no chance to run over.
      logTimeouts.push(type);
      try {
        void Promise.resolve(log.emit(type, payload)).catch(() => {});
      } catch {
        /* a diagnostic log must not fail teardown */
      }
      return TIMEOUT;
    }
    const attempt = Promise.resolve().then(() => log.emit(type, payload)).then(() => true, () => true);
    const outcome = deadlineAt === null ? await attempt : await raceTimeout(attempt, left);
    if (outcome === TIMEOUT) logTimeouts.push(type);
    return outcome;
  };

  // These timers are deliberately referenced: the teardown must finish and report even when the
  // Host has nothing else keeping the event loop alive.
  const sleep = (ms) => new Promise((resolvePromise) => {
    clock.setTimer(resolvePromise, Math.max(0, ms));
  });

  const raceTimeout = async (promise, ms) => {
    let timer = null;
    const timeout = new Promise((resolvePromise) => {
      timer = clock.setTimer(() => resolvePromise(TIMEOUT), Math.max(0, ms));
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer !== null) clock.clearTimer(timer);
    }
  };

  const alive = (pid) => {
    try {
      return isAlive(pid) === true;
    } catch {
      return false;
    }
  };

  const waitGone = async (pid, budgetMs) => {
    const end = now() + Math.max(0, budgetMs);
    for (;;) {
      if (!alive(pid)) return true;
      const left = end - now();
      if (left <= 0) return false;
      await sleep(Math.min(50, left));
    }
  };

  const markClosing = (reason) => {
    if (closing) return false;
    closing = true;
    closingReason = reason;
    try {
      controller.abort(new Error(`插件正在关闭（${reason}）`));
    } catch {
      /* an already-aborted controller is fine */
    }
    return true;
  };

  /**
   * One item. A pid-bearing item is confirmed by liveness; an in-process item by its stop promise.
   * A stop that returns `{ ok: false }` reported failure and is never counted as success. Reaching
   * the shared deadline escalates a pid item to a forced tree kill, then re-checks.
   */
  const runItem = async (item, deadlineAt) => {
    const name = typeof item?.name === 'string' && item.name.length > 0 ? item.name : 'unnamed';
    const kind = item?.kind === 'external' ? 'external' : 'internal';
    /** The stop may report the pid it actually owned (e.g. the transparent layer's child). */
    let pid = Number.isInteger(item?.pid) ? item.pid : 0;
    diagnose('noteOwnedPid', name, pid);
    const itemStarted = now();
    let confirmed = false;
    let forced = false;
    let error = '';

    let stopSettled;
    try {
      stopSettled = Promise.resolve(typeof item?.stop === 'function' ? item.stop() : undefined).then(
        (value) => ({ ok: true, value }),
        (reason) => ({ ok: false, error: reason }),
      );
    } catch (reason) {
      stopSettled = Promise.resolve({ ok: false, error: reason });
    }
    const left = () => Math.max(0, deadlineAt - now());

    if (kind === 'external' && pid > 0) {
      // Owned instance: ask it to close, give it a bounded polite window, then force the tree.
      try {
        await raceTimeout(Promise.resolve().then(() => closeApp(pid)).then(() => true, () => false), Math.min(500, left()));
      } catch {
        /* the polite close is best effort; liveness decides */
      }
      confirmed = await waitGone(pid, Math.min(500, left()));
    } else {
      const outcome = await raceTimeout(stopSettled, left());
      if (outcome === TIMEOUT) {
        confirmed = false;
      } else if (outcome.ok !== true) {
        error = messageOf(outcome.error);
        confirmed = false;
      } else {
        const value = outcome.value;
        if (Number.isInteger(value?.pid) && value.pid > 0) pid = value.pid;
        diagnose('noteOwnedPid', name, pid);
        if (value !== null && typeof value === 'object' && value.ok === false) {
          // A stop that reports `{ ok: false }` failed; calling it success would be a lie.
          error = error.length > 0 ? error : messageOf(value.error ?? 'stop 返回 ok:false');
          confirmed = false;
        } else {
          confirmed = !(value !== null && typeof value === 'object' && value.confirmed === false);
          if (confirmed === false && error.length === 0 && value?.error !== undefined) error = messageOf(value.error);
        }
        if (confirmed && pid > 0) confirmed = await waitGone(pid, Math.min(200, left()));
      }
    }

    if (!confirmed && pid > 0) {
      forced = true;
      const forceStarted = now();
      // Bound the kill itself: a wedged taskkill must not consume the confirmation budget.
      try {
        await raceTimeout(Promise.resolve().then(() => killTree(pid)).then(() => true, () => false), Math.min(forceConfirmMs, 500));
      } catch (reason) {
        error = error.length > 0 ? error : messageOf(reason);
      }
      confirmed = await waitGone(pid, Math.max(0, forceConfirmMs - (now() - forceStarted)));
    }

    const ms = Math.max(0, now() - itemStarted);
    await emit('shutdown.item', { name, kind, ms, confirmed }, deadlineAt);
    if (!confirmed) {
      await emit('shutdown.timeout', { item: name, ms, forced, error }, deadlineAt);
    }
    return { name, kind, ms, confirmed, forced };
  };

  const run = (reason = 'manual') => {
    if (pending !== null) return pending;

    const reasonText = String(reason);
    markClosing(reasonText);
    startedAt = now();
    const deadlineAt = startedAt + deadlineMs;

    // Everything below is awaited: when the disposer resolves, `events.jsonl` already holds the
    // begin/summary records — no fixed sleep, no fire-and-forget. Each write is still raced against
    // the shared deadline, so a wedged log is recorded in `logTimeouts` and teardown continues.
    const work = (async () => {
      let selected = [];
      try {
        const selectedPlan = plan() ?? {};
        selected = Array.isArray(selectedPlan) ? selectedPlan.filter(Boolean) : selectShutdownItems(selectedPlan);
      } catch (error) {
        selected = [];
        await emit('shutdown.plan.failed', { error: messageOf(error) }, deadlineAt);
      }

      for (const item of selected) diagnose('noteOwnedPid', item.name, item.pid);
      diagnose('begin', reasonText);
      // Start the begin write and the resource stops in the same turn: a wedged log must not delay
      // cleanup, and the write is only awaited inside whatever budget is left.
      const beginLogged = emit('shutdown.begin', {
        reason: reasonText,
        deadlineMs,
        items: selected.map((entry) => (typeof entry?.name === 'string' ? entry.name : 'unnamed')),
      }, deadlineAt);

      try {
        const rows = await Promise.all(selected.map((item) => runItem(item, deadlineAt)));
        await beginLogged; // bounded by the same deadline; a timeout is recorded, never decisive
        const unconfirmed = rows.filter((row) => row.confirmed !== true).map((row) => row.name);
        const summary = {
          reason: reasonText,
          ok: unconfirmed.length === 0,
          items: rows,
          unconfirmed,
          elapsedMs: Math.max(0, now() - startedAt),
          logTimeouts: [...logTimeouts],
        };
        await emit('shutdown.summary', {
          ok: summary.ok,
          items: rows,
          unconfirmed,
        }, deadlineAt);
        return summary;
      } catch (error) {
        await emit('shutdown.summary', { ok: false, items: [], unconfirmed: [], error: messageOf(error) }, deadlineAt);
        return {
          reason: reasonText,
          ok: false,
          items: [],
          unconfirmed: [],
          elapsedMs: Math.max(0, now() - startedAt),
          error: messageOf(error),
          logTimeouts: [...logTimeouts],
        };
      }
    })();

    pending = work.then((summary) => {
      diagnose('complete', summary);
      return summary;
    });
    return pending;
  };

  return {
    get closing() { return closing; },
    get reason() { return closingReason; },
    get signal() { return controller.signal; },
    get deadlineMs() { return deadlineMs; },
    get forceConfirmMs() { return forceConfirmMs; },
    get pending() { return pending; },
    /** Whether new work (autostart, spawn, delivery) may still be admitted. */
    canStart() { return !closing; },
    /** Admit a side effect only while open; returns whether it ran. */
    whenOpen(fn) {
      if (closing) return false;
      fn();
      return true;
    },
    /** Throw an AbortError once teardown started: the caller refuses new work. */
    assertOpen(what = '操作') {
      if (closing) throw new DOMException(`插件正在关闭，拒绝${what}`, 'AbortError');
    },
    /** Freeze admission without waiting for the plan (used by a Host signal). */
    begin(reason = 'manual') { markClosing(String(reason)); },
    setPlan(fn) { if (typeof fn === 'function') plan = fn; },
    /** Register the single awaited plugin teardown hook; returns the disposer for tests. */
    attach(ctx) {
      const dispose = () => run('plugin-unload');
      if (ctx === null || typeof ctx?.effect !== 'function') return dispose;
      ctx.effect(() => dispose);
      return dispose;
    },
    /**
     * The desktop shell sends `{type:"shutdown"}` over the Host's IPC before it awaits disposal.
     * Listening makes `closing` true a tick earlier and lets teardown start in parallel; the
     * fiber disposer still returns the same summary. No-op without an IPC channel.
     */
    bindHostProcess(proc = process) {
      if (proc === null || typeof proc?.on !== 'function' || proc.connected !== true) return () => {};
      const onMessage = (message) => {
        if (message !== null && typeof message === 'object' && message.type === 'shutdown') run('host-shutdown');
      };
      const onDisconnect = () => run('host-disconnect');
      proc.on('message', onMessage);
      proc.once('disconnect', onDisconnect);
      return () => {
        proc.off?.('message', onMessage);
        proc.off?.('disconnect', onDisconnect);
      };
    },
    /** Wait for the running teardown, or resolve immediately when none started. */
    async settle() { return pending ?? null; },
    run,
  };
}
