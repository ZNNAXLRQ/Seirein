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
 * Ownership (P2-1). A scope is `(sessionId, turn)` plus an epoch bumped by every `beginTurn`, and
 * both a published frame and a failed preparation are keyed by the scope that produced them. A
 * capture that lands after the turn moved on is DISCARDED (`vision.pre-request.stale`), so a slow
 * turn can never overwrite a newer turn's frame; a late failure clears only its own entry. Scopes
 * are per session, so two sessions preparing concurrently never share or evict each other's frame.
 * `take()`/`peek()` accept the caller's `{sessionId, turn}`; a mismatch is a miss
 * (`session-changed` / `turn-changed`) and returns null. `index` names that owner for both visual
 * tools, so a late tool call cannot borrow a newer turn's frame. A caller that passes no ownership
 * still reads the scope opened by the last `beginTurn` (the legacy tool-only fallback).
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

  /**
   * Open turn scopes, one per session: `sessionId -> {key, turn, sessionId, source, scene, epoch}`.
   * The epoch is bumped by every `beginTurn`, so a capture can prove it still owns the very scope
   * it started for even when that same turn is prepared twice.
   */
  const scopes = new Map();
  /** Published frames keyed by owner scope key; a write keeps at most one per session. */
  const snapshots = new Map();
  /** Turns whose preparation failed; a read there falls through to its own capture. */
  const failed = new Set();
  let epochSeq = 0;
  /** Scope opened by the last `beginTurn`: the fallback for callers that pass no ownership. */
  let active = null;

  /** Caller attribution: an absent pair means "the last scope opened by `beginTurn`". */
  const attributionOf = (sessionId, turn) => ({
    hasSession: typeof sessionId === 'string' && sessionId.length > 0,
    hasTurn: Number.isSafeInteger(turn) && turn >= 0,
  });

  /**
   * Mark the turn that is about to build its first request. Every call opens a NEW epoch for that
   * session: repeating the same (session, turn) supersedes a preparation of it that is still in
   * flight, while a new turn keeps the old snapshot only long enough for `take()` to report
   * `turn-changed` and then discard it.
   */
  function beginTurn({ turn, sessionId = '', source = 'desktop', scene = '' } = {}) {
    const turnValue = Number.isSafeInteger(turn) ? turn : -1;
    const key = `${sessionId}\u0000${turnValue}`;
    const previous = scopes.get(sessionId);
    if (previous !== undefined && previous.key !== key) failed.delete(previous.key);
    const scope = { key, turn: turnValue, sessionId, source, scene, epoch: ++epochSeq };
    scopes.set(sessionId, scope);
    active = scope;
    return scope;
  }

  /**
   * The scope the caller means: its own `(sessionId, turn)` when given, otherwise the last scope
   * opened by `beginTurn`. `null` when that scope is unknown or its turn already moved on.
   */
  function resolveScope({ sessionId = '', turn } = {}) {
    const { hasSession, hasTurn } = attributionOf(sessionId, turn);
    if (!hasSession && !hasTurn) return active;
    if (hasSession) {
      const scope = scopes.get(sessionId);
      if (scope === undefined) return null;
      if (hasTurn && scope.turn !== turn) return null;
      return scope;
    }
    return active !== null && active.turn === turn ? active : null;
  }

  /** Publish only while the entrance epoch still owns its scope (see `prepare`). */
  function isCurrent(scope) {
    const live = scopes.get(scope.sessionId);
    return live !== undefined && live.key === scope.key && live.epoch === scope.epoch;
  }

  /** A result that arrived after its turn moved on: report why, never publish it. */
  function stale(scope) {
    const live = scopes.get(scope.sessionId);
    const reason = live === undefined
      ? 'cleared'
      : live.key !== scope.key ? 'turn-changed' : 'superseded';
    event('vision.pre-request.stale', {
      reason,
      turn: scope.turn,
      sessionId: scope.sessionId,
    });
  }

  /**
   * Resolve a write's owner: a scope handed back by `beginTurn`/`prepare`, a caller attribution
   * `{sessionId, turn}`, or (no owner) the last scope opened by `beginTurn`. `null` means the
   * write has no live scope and is refused.
   */
  function scopeOf(owner) {
    if (owner === null || owner === undefined) return active;
    const scope = typeof owner.key === 'string' ? owner : resolveScope(owner);
    return scope !== null && scope !== undefined && isCurrent(scope) ? scope : null;
  }

  /** Drop any frame this session published for another turn; reports whether one existed. */
  function dropOtherTurns(sessionId, keepKey) {
    let dropped = false;
    for (const [key, entry] of snapshots) {
      if (key !== keepKey && entry.sessionId === sessionId) {
        snapshots.delete(key);
        dropped = true;
      }
    }
    return dropped;
  }

  /** Whether the channel still offers a frame that belongs to a DIFFERENT session. */
  function hasOtherSession(sessionId) {
    for (const entry of snapshots.values()) {
      if (entry.sessionId !== sessionId) return true;
    }
    return false;
  }

  /** Fresh frame for this exact scope, or null. Does not emit or mutate. */
  function peek({ sessionId = '', turn, source = 'desktop', scene = '', kind = null } = {}) {
    const scope = resolveScope({ sessionId, turn });
    if (scope === null) return null;
    const entry = snapshots.get(scope.key);
    if (entry === undefined) return null;
    if (kind !== null && entry.kind !== kind) return null;
    if (entry.source !== source) return null;
    if ((entry.scene ?? '') !== (scene ?? '')) return null;
    const capturedAt = Number(entry.capturedAt);
    if (!Number.isFinite(capturedAt) || capturedAt <= 0) return null;
    const ageMs = clock() - capturedAt;
    if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs >= windowMs()) return null;
    return { shot: entry.shot, ageMs };
  }

  /**
   * Reuse the prepared frame when every condition holds. A miss is reported with its reason and
   * leaves the caller to capture normally; a miss never deletes a file that is still in flight.
   *
   * `sessionId`/`turn` are the CALLER's ownership. When given, a frame published for another
   * session or another turn is never served: the read is a miss (`session-changed` /
   * `turn-changed`). Without them the last scope opened by `beginTurn` is used, which is the
   * pre-wiring behavior. `kind` filters the product: `shot` is the one-shot frame `assistant_see`
   * reuses, `storyboard` is a packed time sequence; asking for the other kind is a
   * `kind-mismatch` miss and never a silent substitute.
   */
  function take({ sessionId = '', turn, source = 'desktop', scene = '', kind = null } = {}) {
    if (blocked()) {
      snapshots.clear();
      miss('privacy');
      return null;
    }
    const { hasSession, hasTurn } = attributionOf(sessionId, turn);
    let scope = active;
    if (hasSession || hasTurn) {
      if (hasSession) {
        const own = scopes.get(sessionId);
        if (own === undefined) {
          // This session never opened a turn: another session's frame is not its answer.
          miss(hasOtherSession(sessionId) ? 'session-changed' : 'no-turn');
          return null;
        }
        if (hasTurn && own.turn !== turn) {
          miss('turn-changed');
          return null;
        }
        scope = own;
      } else {
        if (active === null) {
          miss('no-turn');
          return null;
        }
        if (active.turn !== turn) {
          miss('turn-changed');
          return null;
        }
        scope = active;
      }
    }
    if (scope === null) {
      miss('no-turn');
      return null;
    }
    const entry = snapshots.get(scope.key);
    if (entry === undefined) {
      if (failed.has(scope.key)) {
        miss('prepare-failed');
        return null;
      }
      if (dropOtherTurns(scope.sessionId, scope.key)) {
        miss('turn-changed');
        return null;
      }
      miss('no-snapshot');
      return null;
    }
    // A one-shot frame and a storyboard are different products: a caller that asks for one kind
    // never gets the other (watch must pack a real time sequence, see must get one frame).
    if (kind !== null && entry.kind !== kind) {
      miss('kind-mismatch');
      return null;
    }
    if (entry.source !== source) {
      snapshots.delete(scope.key);
      miss('source-changed');
      return null;
    }
    if ((entry.scene ?? '') !== (scene ?? '')) {
      snapshots.delete(scope.key);
      miss('scene-changed');
      return null;
    }
    const capturedAt = Number(entry.capturedAt);
    const freshness = readObservation(
      { at: capturedAt, capturedAt },
      { now: clock(), ttlMs: windowMs() },
    );
    const ageMs = Number.isFinite(capturedAt) && capturedAt > 0 ? clock() - capturedAt : null;
    if (freshness.stale === true || ageMs === null || ageMs < 0) {
      snapshots.delete(scope.key);
      miss('expired');
      return null;
    }
    event('vision.pre-request.reused', {
      turn: scope.turn,
      sessionId: scope.sessionId,
      ageMs: Math.round(ageMs),
      source,
      scene: scene ?? '',
    });
    return entry.shot;
  }

  /**
   * Capture the turn's preparation once. Any failure is swallowed (fail-open): the turn keeps
   * running and the first visual read falls back to its normal capture path.
   *
   * The capture, its publication and its failure cleanup all belong to the entrance scope captured
   * here (session + turn + epoch). If the turn moved on while the capture ran, the result is
   * dropped (`vision.pre-request.stale`) and the newer turn's frame is left untouched.
   */
  async function prepare({
    turn, sessionId = '', source = 'desktop', scene = '', signal = null, capture: runCapture = capture,
  } = {}) {
    const scope = beginTurn({ turn, sessionId, source, scene });
    if (blocked()) {
      snapshots.delete(scope.key);
      miss('privacy');
      return null;
    }
    const cached = peek({ sessionId, turn: scope.turn, source, scene, kind: 'shot' });
    if (cached !== null) return cached.shot;
    if (typeof runCapture !== 'function') {
      failed.add(scope.key);
      miss('prepare-failed');
      return null;
    }
    try {
      const shot = await runCapture({ turn: scope.turn, sessionId, source, scene, signal });
      if (!isCurrent(scope)) {
        // A slow turn must never publish over the turn that replaced it.
        stale(scope);
        return null;
      }
      if (shot === null || shot === undefined) {
        failed.add(scope.key);
        miss('prepare-failed');
        return null;
      }
      remember(shot, { source, scene, kind: 'shot', owner: scope });
      return shot;
    } catch {
      // A late failure clears ONLY its own entry; the newer turn's frame survives.
      snapshots.delete(scope.key);
      if (!isCurrent(scope)) {
        stale(scope);
        return null;
      }
      failed.add(scope.key);
      miss('prepare-failed');
      return null;
    }
  }

  /**
   * Publish one real capture as this turn's snapshot. Only a scope established by `beginTurn`
   * (or `prepare`) may hold a snapshot: a tool-only flow without a pre-step stays uncached, which
   * keeps every existing "each look is a new capture" contract intact.
   *
   * `owner` binds the write to the scope the frame was captured for; a caller `{sessionId, turn}`
   * is resolved through the live scope, and a stale one is refused, so nothing can resurrect an
   * old turn. Without `owner` the write belongs to the last scope opened by `beginTurn` (legacy).
   */
  function remember(shot, { source = 'desktop', scene = '', kind = 'shot', owner = null } = {}) {
    const scope = scopeOf(owner);
    if (scope === null || shot === null || shot === undefined) return null;
    const capturedAt = Number(shot.capturedAt ?? shot.at);
    const entry = {
      shot,
      key: scope.key,
      // The scope's identity is snapshotted too: a frame can never be read by another session
      // even while it waits in the store.
      sessionId: scope.sessionId,
      turn: scope.turn,
      source,
      scene: scene ?? '',
      capturedAt: Number.isFinite(capturedAt) && capturedAt > 0 ? capturedAt : clock(),
      kind,
    };
    snapshots.set(scope.key, entry);
    failed.delete(scope.key);
    dropOtherTurns(scope.sessionId, scope.key);
    return entry;
  }

  /** Drop the snapshot when its file is deleted (failed delivery, cleanup, cancellation). */
  function forget(file) {
    for (const [key, entry] of snapshots) {
      if (entry.shot?.file === file) snapshots.delete(key);
    }
  }

  /** Privacy, a source/scene switch or teardown: no snapshot may survive across the boundary. */
  function clear() {
    scopes.clear();
    snapshots.clear();
    failed.clear();
    active = null;
  }

  /** Diagnostic view (tests and future status projection); never exposes pixel bytes. */
  function state() {
    const entry = active === null ? null : (snapshots.get(active.key) ?? null);
    return {
      active: active === null ? null : {
        turn: active.turn,
        sessionId: active.sessionId,
        source: active.source,
        scene: active.scene,
        epoch: active.epoch,
      },
      snapshot: entry === null ? null : {
        turn: entry.turn,
        source: entry.source,
        scene: entry.scene,
        capturedAt: entry.capturedAt,
        kind: entry.kind,
      },
    };
  }

  return { beginTurn, prepare, take, peek, remember, forget, clear, state };
}
