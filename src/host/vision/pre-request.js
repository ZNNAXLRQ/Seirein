/**
 * P-48 · visual preparation reuses one pre-request channel.
 *
 * A turn starts at `agent/pre-step`. The preparation establishes ONE turn scope (and, when the
 * user actually asked to look, one capture) before the first model request; every visual read in
 * that turn — `assistant_see`, `assistant_watch take`, and the frame a future vision-memory lane
 * needs — asks this channel first. A snapshot is reused only while ALL of these hold:
 *
 *   - it belongs to the current turn scope (a new turn starts a miss, never a silent reuse);
 *   - its source/scene equals the caller's current source/scene;
 *   - it is younger than `ttlMs` (wall-clock, the same freshness rule as an observation).
 *
 * Privacy (or a mode change) clears the channel; a cleared channel is a miss and is never read
 * as a fallback. Reuse only returns the existing shot object: the file, size, source label and
 * delivery path stay exactly the ones the capture produced. Nothing here starts a timer; the
 * channel is turn-scoped state and lazy inspection.
 */
import { readObservation } from './sight.js';

/** Default freshness window shared with one-shot observations. */
export const PRE_REQUEST_TTL_MS = 30_000;

/**
 * @param {object} [options]
 * @param {() => number} [options.now]
 * @param {number|(() => number)} [options.ttlMs]
 * @param {() => boolean} [options.isBlocked] - privacy / mode transition / disposal
 * @param {(type: string, payload: object) => void} [options.emit]
 * @param {(context: object) => Promise<object|null>} [options.capture] - default capture hook
 */
export function createPreRequestVision({
  now = Date.now,
  ttlMs = PRE_REQUEST_TTL_MS,
  isBlocked = () => false,
  emit = () => {},
  capture = null,
} = {}) {
  const clock = () => {
    const value = Number(now());
    return Number.isFinite(value) ? value : Date.now();
  };
  const windowMs = () => {
    const value = Number(typeof ttlMs === 'function' ? ttlMs() : ttlMs);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : PRE_REQUEST_TTL_MS;
  };
  const blocked = () => {
    try {
      return isBlocked() === true;
    } catch {
      return true; // an unreadable lock fails closed
    }
  };
  const event = (type, payload) => {
    try {
      emit(type, payload);
    } catch {
      /* observation only: a broken emitter never breaks a read or a turn */
    }
  };
  const miss = (reason) => event('vision.pre-request.miss', { reason });

  /** Current turn scope. `key` is the identity used for "same turn". */
  let active = null;
  /** The one snapshot this channel currently offers. */
  let snapshot = null;
  /** Turn whose preparation failed; a read then falls through to its own capture. */
  let failedKey = null;

  /**
   * Mark the turn that is about to build its first request.
   * Repeating the same (session, turn) is a no-op; a new turn keeps the old snapshot only long
   * enough for `take()` to report `turn-changed` and then discard it.
   */
  function beginTurn({ turn, sessionId = '', source = 'desktop', scene = '' } = {}) {
    const turnValue = Number.isSafeInteger(turn) ? turn : -1;
    const key = `${sessionId}\u0000${turnValue}`;
    if (active !== null && active.key === key) {
      active.source = source;
      active.scene = scene;
      return active;
    }
    active = { key, turn: turnValue, sessionId, source, scene };
    failedKey = null;
    return active;
  }

  /** Fresh snapshot for this exact scope, or null. Does not emit or mutate. */
  function peek({ source = 'desktop', scene = '' } = {}) {
    if (snapshot === null || active === null) return null;
    if (snapshot.turnKey !== active.key) return null;
    if (snapshot.source !== source) return null;
    if ((snapshot.scene ?? '') !== (scene ?? '')) return null;
    const capturedAt = Number(snapshot.capturedAt);
    if (!Number.isFinite(capturedAt) || capturedAt <= 0) return null;
    const ageMs = clock() - capturedAt;
    if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs >= windowMs()) return null;
    return { shot: snapshot.shot, ageMs };
  }

  /**
   * Reuse the prepared frame when every condition holds. A miss is reported with its reason and
   * leaves the caller to capture normally; a miss never deletes a file that is still in flight.
   */
  function take({ source = 'desktop', scene = '' } = {}) {
    if (blocked()) {
      snapshot = null;
      miss('privacy');
      return null;
    }
    if (active === null) {
      miss('no-turn');
      return null;
    }
    if (failedKey === active.key && snapshot === null) {
      miss('prepare-failed');
      return null;
    }
    if (snapshot === null) {
      miss('no-snapshot');
      return null;
    }
    if (snapshot.turnKey !== active.key) {
      snapshot = null;
      miss('turn-changed');
      return null;
    }
    if (snapshot.source !== source) {
      snapshot = null;
      miss('source-changed');
      return null;
    }
    if ((snapshot.scene ?? '') !== (scene ?? '')) {
      snapshot = null;
      miss('scene-changed');
      return null;
    }
    const capturedAt = Number(snapshot.capturedAt);
    const freshness = readObservation(
      { at: capturedAt, capturedAt },
      { now: clock(), ttlMs: windowMs() },
    );
    const ageMs = Number.isFinite(capturedAt) && capturedAt > 0 ? clock() - capturedAt : null;
    if (freshness.stale === true || ageMs === null || ageMs < 0) {
      snapshot = null;
      miss('expired');
      return null;
    }
    event('vision.pre-request.reused', {
      turn: active.turn,
      ageMs: Math.round(ageMs),
      source,
      scene: scene ?? '',
    });
    return snapshot.shot;
  }

  /**
   * Capture the turn's preparation once. Any failure is swallowed (fail-open): the turn keeps
   * running and the first visual read falls back to its normal capture path.
   */
  async function prepare({
    turn, sessionId = '', source = 'desktop', scene = '', signal = null, capture: runCapture = capture,
  } = {}) {
    beginTurn({ turn, sessionId, source, scene });
    if (blocked()) {
      snapshot = null;
      miss('privacy');
      return null;
    }
    const cached = peek({ source, scene });
    if (cached !== null) return cached.shot;
    if (typeof runCapture !== 'function') {
      failedKey = active.key;
      miss('prepare-failed');
      return null;
    }
    try {
      const shot = await runCapture({ turn: active.turn, sessionId, source, scene, signal });
      if (shot === null || shot === undefined) {
        failedKey = active.key;
        miss('prepare-failed');
        return null;
      }
      remember(shot, { source, scene, kind: 'shot' });
      return shot;
    } catch {
      snapshot = null;
      failedKey = active?.key ?? null;
      miss('prepare-failed');
      return null;
    }
  }

  /**
   * Publish one real capture as this turn's snapshot. Only a scope established by `beginTurn`
   * (or `prepare`) may hold a snapshot: a tool-only flow without a pre-step stays uncached, which
   * keeps every existing "each look is a new capture" contract intact.
   */
  function remember(shot, { source = 'desktop', scene = '', kind = 'shot' } = {}) {
    if (active === null || shot === null || shot === undefined) return null;
    const capturedAt = Number(shot.capturedAt ?? shot.at);
    snapshot = {
      shot,
      turnKey: active.key,
      turn: active.turn,
      source,
      scene: scene ?? '',
      capturedAt: Number.isFinite(capturedAt) && capturedAt > 0 ? capturedAt : clock(),
      kind,
    };
    failedKey = null;
    return snapshot;
  }

  /** Drop the snapshot when its file is deleted (failed delivery, cleanup, cancellation). */
  function forget(file) {
    if (snapshot !== null && snapshot.shot?.file === file) snapshot = null;
  }

  /** Privacy, a source/scene switch or teardown: no snapshot may survive across the boundary. */
  function clear() {
    snapshot = null;
    active = null;
    failedKey = null;
  }

  /** Diagnostic view (tests and future status projection); never exposes pixel bytes. */
  function state() {
    return {
      active: active === null ? null : { turn: active.turn, sessionId: active.sessionId, source: active.source, scene: active.scene },
      snapshot: snapshot === null ? null : {
        turn: snapshot.turn,
        source: snapshot.source,
        scene: snapshot.scene,
        capturedAt: snapshot.capturedAt,
        kind: snapshot.kind,
      },
    };
  }

  return { beginTurn, prepare, take, peek, remember, forget, clear, state };
}
