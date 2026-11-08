/** ack-warmup — extracted from index.js; no host entry dependency. */


/**
 * Why a warm build must wait, in the order it yields to its owner: sound already coming out of the
 * speaker, synthesis in the TTS slot, a translation request, then a turn that has not ended. `''`
 * means a genuine idle window.
 */
export function ackWarmActivityReason({
  generating = false,
  translating = false,
  synthesizing = false,
  playing = false,
} = {}) {
  if (playing === true) return 'playing';
  if (synthesizing === true) return 'synthesizing';
  if (translating === true) return 'translating';
  if (generating === true) return 'generating';
  return '';
}

/** The four live resources a warm window can yield to; the blocked row names one of them. */
export const ACK_WARM_BLOCKED_BY = Object.freeze(new Set(['playing', 'synthesizing', 'translating', 'generating']));


/**
 * A2 warm scheduling: one cache build per genuine idle window.
 *
 * `activity()` names the live task that owns the voice resources, or `''` when idle. A busy window
 * is skipped and the low-priority timer is re-armed rather than consuming the slot; a build that
 * already started is aborted by `cancel(reason)`, which writes `voice.ack.warm.cancelled {reason}`
 * once. The aborted batch is handed to `discard({reason, result})`, which is observation-only today:
 * the pool's generation guard removes the cancelled batch's own files and leaves every entry that
 * was already valid servable.
 */
export function createAckWarmScheduler({
  idleMs = () => 5000,
  activity = () => '',
  build = async () => null,
  discard = async () => {},
  emit = async () => {},
  delay = (run, ms) => setTimeout(run, ms),
  stopTimer = (handle) => clearTimeout(handle),
} = {}) {
  let timer = null;
  let inflight = null;
  let disposed = false;
  const clearTimer = () => {
    if (timer !== null) {
      stopTimer(timer);
      timer = null;
    }
  };
  const schedule = () => {
    clearTimer();
    if (disposed) return null;
    timer = delay(() => { timer = null; void run(); }, Math.max(0, Number(idleMs()) || 0));
    timer?.unref?.();
    return timer;
  };
  /** Abort the build in flight; returns false when there was nothing to cancel. */
  const cancel = (reason = 'activity') => {
    const current = inflight;
    if (current === null || current.cancelled === true) return false;
    current.cancelled = true;
    current.controller.abort(new DOMException(String(reason), 'AbortError'));
    try {
      void emit('voice.ack.warm.cancelled', { reason: String(reason) });
    } catch {
      /* the event log is best-effort */
    }
    return true;
  };
  const run = async () => {
    clearTimer();
    if (disposed === true) return null;
    // A build already running owns the slot; never start a second one beside it.
    if (inflight !== null) {
      schedule();
      return null;
    }
    const busy = String(activity() ?? '');
    if (busy.length > 0) {
      // Re-arm the same low-priority window instead of treating the seat as idle.
      schedule();
      return null;
    }
    const record = { controller: new AbortController(), cancelled: false, silent: false };
    inflight = record;
    let result = null;
    try {
      result = await build({ signal: record.controller.signal });
    } catch {
      /* the warm pool is best-effort and never speaks on failure */
    }
    // A cancelled batch may have been partially persisted by the pool: discard it before it can
    // be taken. `inflight` stays set until the cleanup finishes, so a new window cannot build
    // beside it.
    if (record.cancelled === true && record.silent !== true) {
      try {
        await discard({ reason: 'warm-cancelled', result });
      } catch {
        /* cleanup is best-effort */
      }
    }
    inflight = null;
    return result;
  };
  /** Teardown: stop the timer and abort quietly (no event, no cleanup racing a remount). */
  const dispose = () => {
    disposed = true;
    clearTimer();
    const current = inflight;
    if (current !== null && current.cancelled !== true) {
      current.cancelled = true;
      current.silent = true;
      current.controller.abort(new DOMException('dispose', 'AbortError'));
    }
  };
  return {
    schedule,
    cancel,
    run,
    dispose,
    status: () => ({ scheduled: timer !== null, building: inflight !== null }),
  };
}


/**
 * The live turns that still own the voice resources, for the A2 warm build.
 *
 * `turn/start` used to add every session id, so a conversation in another workspace (or a
 * delegated child) blocked the assistant's own warm build. Only the assistant's own, non-delegated
 * session is counted here; every row is keyed by (sessionId, turn), so one turn ending removes
 * exactly its own row and never the whole table. The table is bounded (oldest evicted first) and a
 * busy idle window reports `voice.ack.warm.blocked {reason:'busy', activeTurns}` at most once per
 * `throttleMs`.
 *
 * @param {{limit?: number, inScope?: Function, subagent?: Function, emit?: Function,
 *          throttleMs?: number, now?: Function}} options injected seams
 * @returns {{start: Function, end: Function, noteBlocked: Function, size: number, turns: Function}}
 */
export function createAckWarmTurnMeter({
  limit = 64,
  inScope = () => true,
  subagent = () => false,
  emit = async () => {},
  throttleMs = 30_000,
  now = () => Date.now(),
} = {}) {
  const cap = Math.max(1, Math.floor(Number(limit) || 64));
  /** `${sessionId}\0${turn}` -> {sessionId, turn}; Map insertion order is the eviction order. */
  const active = new Map();
  let blockedAt = 0;
  const keyOf = (sessionId, turn) => `${String(sessionId ?? '')}\u0000${String(turn)}`;
  /**
   * One throttled row per busy window: the assistant's own live turns are still generating. The
   * same reason the scheduler saw is reported as `blockedBy`, so a deferred window names the live
   * resource that held it (`playing` / `synthesizing` / `translating` / `generating`) instead of
   * only a generic "busy".
   */
  const noteBlocked = (blockedBy = 'generating') => {
    const at = now();
    if (at - blockedAt < throttleMs) return false;
    blockedAt = at;
    const reason = ACK_WARM_BLOCKED_BY.has(String(blockedBy)) ? String(blockedBy) : 'generating';
    try {
      void Promise.resolve(emit('voice.ack.warm.blocked', {
        reason: 'busy',
        blockedBy: reason,
        activeTurns: active.size,
      }))
        .catch(() => {});
    } catch {
      /* the event log is best-effort */
    }
    return true;
  };
  return {
    /** A turn started: counted only for the assistant's own, non-delegated session. */
    start({ session = null, sessionId = '', turn = null } = {}) {
      const id = typeof sessionId === 'string' ? sessionId : '';
      if (id.length === 0 || !Number.isInteger(turn)) return false;
      let own = false;
      try {
        own = subagent(session) !== true && inScope(session) === true;
      } catch {
        own = false; // an unreadable identity never blocks the assistant's own warm build
      }
      if (own !== true) return false;
      const key = keyOf(id, turn);
      if (active.has(key)) return false;
      active.set(key, { sessionId: id, turn });
      while (active.size > cap) active.delete(active.keys().next().value);
      return true;
    },
    /** The same (sessionId, turn) ended: removes only its own row. */
    end({ sessionId = '', turn = null } = {}) {
      const key = keyOf(sessionId, turn);
      if (active.has(key) !== true) return false;
      active.delete(key);
      return true;
    },
    noteBlocked,
    get size() {
      return active.size;
    },
    /** Read-only snapshot used by diagnostics and tests. */
    turns: () => [...active.values()],
  };
}


/**
 * One warm batch, generation-guarded from build to persist.
 *
 * The pool's abort checks only cover the synthesis loop; `persist()` still ran at the end of a
 * cancelled batch, creating the cache directory and `manifest.json` after `dispose()` or a newer
 * turn. Every build here runs under a fresh generation and owns the pool's write seams: once the
 * generation is cancelled, `makeDir`/`writeTextFile` refuse, so a discarded batch reaches neither
 * the directory nor the manifest. The drop is reported as
 * `voice.ack.warm.discarded {reason:'disposed'|'cancelled'}`. Cancelling never clears the whole
 * pool: valid entries stay, and a late result cannot re-enter it.
 *
 * @param {{emit?: Function}} options injected seams
 * @returns {{bind: Function, makeDir: Function, writeTextFile: Function, cancel: Function,
 *            dispose: Function, build: Function}}
 */
export function createAckWarmRunGate({ emit = async () => {} } = {}) {
  let generation = 0;
  let run = null;
  const log = async (type, payload) => {
    try {
      await emit(type, payload);
    } catch {
      /* the event log is best-effort */
    }
  };
  const open = () => run === null || (run.cancelled !== true && run.generation === generation);
  /** Wrap one pool write seam; `touched` records that persist() was entered before the abort. */
  const guard = (write) => async (...args) => {
    if (run !== null) run.touched = true;
    if (open() !== true) {
      const error = new Error('ack-warm-cancelled');
      error.code = 'ACKWARM_CANCELLED';
      throw error;
    }
    return write(...args);
  };
  const drop = (reason) => {
    if (run === null || run.cancelled === true) return false;
    run.cancelled = true;
    run.reason = reason === 'disposed' ? 'disposed' : 'cancelled';
    return true;
  };
  return {
    /** Kept for the host's old wiring; cancellation no longer resets the whole pool. */
    bind() { /* a cancelled batch is dropped by the pool itself, never by clearing the pool */ },
    makeDir: (write) => guard(write),
    writeTextFile: (write) => guard(write),
    /** A new activity aborted the batch: the result is dropped, never persisted. */
    cancel: () => drop('cancelled'),
    /** Teardown aborted the batch: the same drop, reported with its own reason. */
    dispose: () => drop('disposed'),
    /** Run one pool build under a fresh generation. */
    async build(runBuild, { signal = null } = {}) {
      const current = { generation: ++generation, cancelled: false, reason: 'cancelled', touched: false };
      run = current;
      let result = null;
      try {
        result = await runBuild({ signal });
      } catch {
        /* a guarded write refuses a cancelled batch; a failed warm build is silence anyway */
      } finally {
        run = null;
        if (current.cancelled === true || current.generation !== generation) {
          // A cancelled batch's own files are removed by the pool's generation-guarded cleanup.
          // Valid entries that already existed stay in the pool: cancellation is not a cache clear,
          // and a late result (even one whose clip finished) never re-enters it. The pool already
          // reported its own drop in that case; never write a second row for the same batch.
          if (typeof result?.discarded !== 'string' || result.discarded.length === 0) {
            await log('voice.ack.warm.discarded', { reason: current.reason });
          }
          result = null;
        }
      }
      return result;
    },
  };
}
