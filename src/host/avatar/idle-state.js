/**
 * idle-state — pure helpers for the avatar's waiting→tired→waiting transition.
 *
 * `tired` is a bounded TRIAL, not a latch:
 *
 *   waiting --(idleTimeoutMs of real idle)--> tired --(trial deadline)--> waiting
 *
 * The trial deadline is fixed when tired is entered. Reading status, polling housekeeping or
 * re-writing `tired` while already tired must never extend it: only a new real waiting→tired
 * transition (new supporting evidence) may create a new deadline. User activity (ASR, speech, an
 * explicit state change) ends the trial immediately instead.
 *
 * This module owns no timer, no I/O and no mutable state: every function is a pure judgment so
 * the host can test the thresholds without starting the avatar runtime or VTube Studio.
 */

/** Defaults shared with the host. `tiredTimeoutMs` is a trial validity, not a guaranteed nap. */
export const TIRED_DEFAULTS = Object.freeze({
  idleTimeoutMs: 10 * 60_000,
  tiredTimeoutMs: 30 * 60_000,
});

const isPositiveFinite = (value) => Number.isFinite(value) && value > 0;

/** Tolerate `null`/primitives as malformed input instead of throwing on destructuring. */
const asRecord = (value) => (value !== null && typeof value === 'object' ? value : {});

/**
 * Resolve the configurable trial validity.
 *
 * Precedence: `config.avatar.tiredTimeoutMs` → legacy `config.avatarTiredTimeoutMs` → default.
 * A non-finite or non-positive value (including `0`) falls back to the default: `0` does NOT mean
 * "disabled". To effectively disable the trial, configure a value larger than any real session.
 *
 * @param {object|null|undefined} config
 * @returns {number} positive milliseconds
 */
export function resolveTiredTimeoutMs(config) {
  const input = asRecord(config);
  const nested = asRecord(input.avatar);
  const raw = nested.tiredTimeoutMs ?? input.avatarTiredTimeoutMs ?? TIRED_DEFAULTS.tiredTimeoutMs;
  const value = Number(raw);
  return isPositiveFinite(value) ? value : TIRED_DEFAULTS.tiredTimeoutMs;
}

/**
 * The existing waiting→tired entry predicate. True only for a real `waiting` snapshot whose idle
 * span has reached the threshold; malformed/missing fields are false, never an exception.
 *
 * @param {{status?: string, idleSince?: number, now?: number, timeoutMs?: number}|null} input
 * @returns {boolean}
 */
export function shouldEnterTired(input) {
  const { status, idleSince, now, timeoutMs } = asRecord(input);
  return status === 'waiting'
    && isPositiveFinite(idleSince)
    && Number.isFinite(now)
    && isPositiveFinite(timeoutMs)
    && now - idleSince >= timeoutMs;
}

/**
 * The original fixed-window recovery predicate (retained as a defensive fallback for a tired
 * state without a recorded deadline). `tiredSince` missing/malformed is false.
 *
 * @param {{status?: string, tiredSince?: number, now?: number, timeoutMs?: number}|null} input
 * @returns {boolean}
 */
export function shouldRecoverFromTired(input) {
  const { status, tiredSince, now, timeoutMs } = asRecord(input);
  return status === 'tired'
    && isPositiveFinite(tiredSince)
    && Number.isFinite(now)
    && isPositiveFinite(timeoutMs)
    && now - tiredSince >= timeoutMs;
}

/**
 * Create the one deadline owned by a real tired entry.
 *
 * `evidenceAt` is the start of the idle span that supported the judgment (or `now` when unknown);
 * `expiresAt` starts at the moment tired was entered, so later polling cannot extend it.
 * Invalid `timeoutMs` falls back to the default, matching `resolveTiredTimeoutMs`.
 *
 * @param {{reason?: string, evidenceAt?: number, now?: number, timeoutMs?: number}|null} input
 * @returns {{reason: string, evidenceAt: number, expiresAt: number, timeoutMs: number}|null}
 */
export function createTiredDeadline(input) {
  const { reason, evidenceAt, now, timeoutMs } = asRecord(input);
  const at = Number(now);
  if (!isPositiveFinite(at)) return null;
  const timeout = isPositiveFinite(Number(timeoutMs)) ? Number(timeoutMs) : TIRED_DEFAULTS.tiredTimeoutMs;
  const evidence = isPositiveFinite(Number(evidenceAt)) && Number(evidenceAt) <= at ? Number(evidenceAt) : at;
  return {
    reason: typeof reason === 'string' && reason.trim().length > 0 ? reason.trim() : 'idle-timeout',
    evidenceAt: evidence,
    expiresAt: at + timeout,
    timeoutMs: timeout,
  };
}

/**
 * Has the recorded trial deadline really passed? A missing/invalid deadline is false: the host
 * then falls back to `shouldRecoverFromTired` instead of inventing an expiry.
 *
 * @param {{status?: string, expiresAt?: number, now?: number}|null} input
 * @returns {boolean}
 */
export function shouldExpireTired(input) {
  const { status, expiresAt, now } = asRecord(input);
  return status === 'tired'
    && isPositiveFinite(expiresAt)
    && Number.isFinite(now)
    && now >= expiresAt;
}

/**
 * Numeric measurements for the recovery event. Deliberately returns numbers only (the host adds
 * the one entry-reason label): `afterMs` = how long tired lasted, `evidenceAgeMs` = age of the
 * supporting idle span, `expiresInMs` = remaining trial time (negative when housekeeping ran late).
 *
 * @param {{tiredSince?: number, evidenceAt?: number, expiresAt?: number, now?: number}|null} input
 * @returns {{afterMs: number, evidenceAgeMs: number, expiresInMs: number}}
 */
export function tiredRecoveryEvidence(input) {
  const { tiredSince, evidenceAt, expiresAt, now } = asRecord(input);
  const at = Number.isFinite(Number(now)) ? Number(now) : 0;
  const since = Number(tiredSince);
  const evidence = Number(evidenceAt);
  const expires = Number(expiresAt);
  return {
    afterMs: isPositiveFinite(since) ? Math.max(0, at - since) : 0,
    evidenceAgeMs: isPositiveFinite(evidence) ? Math.max(0, at - evidence) : 0,
    expiresInMs: isPositiveFinite(expires) ? expires - at : 0,
  };
}
