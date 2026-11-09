/**
 * VTS auto-connect tick, extracted so its lifetime guards are testable without a socket.
 *
 * VTube Studio may start (or restart) after the plugin, so the host polls a short interval and only
 * dials once the API port answers. The probe is awaited: while it is in flight the user can close
 * the avatar component, re-open it, or unload the plugin. A successful late probe must not connect
 * on behalf of a state that no longer exists.
 *
 * The caller injects every side effect and every gate:
 *   probe()        → Promise<boolean>, true only when the API port answered
 *   connect()      → Promise<{ok?: boolean}>, the real connection attempt
 *   isEnabled()    → component switch (`features.enabled('avatar')`)
 *   revision()     → component transition counter (`features.revision('avatar')`)
 *   mountRevision()→ mount lifetime counter (caller bumps it on unload)
 *   isDisposed()   → plugin teardown (`shutdown.closing`), checked before and after the await
 *   isBusy()       → `client.ready || client.connectPromise !== null`
 *   now()/backoffMs→ the 20 s failure backoff
 *
 * A probe failure never sets a backoff (the next 4 s tick may retry); a reachable port whose
 * connect fails does. A connect success resets the backoff. All guards fail closed.
 */

export const VTS_AUTO_TICK_MS = 4_000;
export const VTS_AUTO_BOOT_MS = 8_000;
export const VTS_AUTO_BACKOFF_MS = 20_000;
/**
 * Host-side cooldown before a quiet authorization state may be retried automatically. The default
 * is 0, i.e. automatic re-authorization is OFF unless the user opts in
 * (`avatar.vtsAuthAutoRetryMs` > 0), so an expired popup never produces another popup on its own.
 */
export const VTS_AUTH_AUTO_RETRY_MS = 0;
/** Even when opted in, one quiet episode may trigger at most this many automatic grants. */
export const VTS_AUTH_AUTO_RETRY_MAX_ATTEMPTS = 1;
/** Hard ceiling for `avatar.vtsAuthAutoRetryMaxAttempts`; more than two is a popup loop. */
export const VTS_AUTH_AUTO_RETRY_MAX_ATTEMPTS_CAP = 2;

/** The two states that wait for a user decision; a dial from either is a no-op (AWAITING_GRANT). */
const VTS_AUTH_AUTO_RETRY_STATES = new Set(['requesting-grant', 'token-invalid']);

/**
 * Decide whether the HOST's cooldown/budget would allow one automatic re-authorization.
 *
 * This is a pure predicate: it never reads the clock, the client or the config. The host passes
 * `lastAuthAt` from `client.authStatus()` (or the host's own in-flight timestamp, whichever is
 * newer) and its `cooldownMs`; every malformed input fails closed so a broken projection can never
 * turn into a popup storm. Callers must still apply their own policy on top: the host refuses
 * `token-invalid` and `grant-timeout` (user action / incomplete authorization), and enforces the
 * attempt budget. A `cooldownMs` of 0 is the default and disables the predicate entirely.
 *
 * @param {{
 *   state?: string,
 *   authorizePending?: boolean,
 *   lastAuthAt?: number,
 *   now?: number,
 *   cooldownMs?: number,
 * }} [options]
 * @returns {boolean} true only for a quiet, non-pending state whose cooldown has elapsed.
 */
export function shouldAutoReauthorize(options = {}) {
  const input = options !== null && typeof options === 'object' ? options : {};
  const cooldownMs = Number(input.cooldownMs ?? VTS_AUTH_AUTO_RETRY_MS);
  // `<= 0` is the documented disable switch, not an immediate retry.
  if (!Number.isFinite(cooldownMs) || cooldownMs <= 0) return false;
  if (!VTS_AUTH_AUTO_RETRY_STATES.has(input.state)) return false;
  if (input.authorizePending === true) return false;
  const lastAuthAt = Number(input.lastAuthAt);
  const now = Number(input.now);
  // 0 means "this process never completed an authorization attempt"; it is not a usable clock.
  if (!Number.isFinite(lastAuthAt) || lastAuthAt <= 0) return false;
  if (!Number.isFinite(now)) return false;
  return now - lastAuthAt >= cooldownMs;
}

/**
 * The Host's quiet-authorization policy, pure and side-effect free. It decides what one auto tick
 * should do with a non-ready auth projection:
 *
 *  - `not-quiet`: keep the normal probe/connect path (an ordinary disconnect may use its token);
 *  - `auth-pending`: a popup is still open, never ask again;
 *  - `auth-incomplete`: the last grant timed out; show it, never re-request from a cooldown;
 *  - `auth-user-action-required`: token-invalid / needs-user; only the user's button may retry;
 *  - `auto-retry-disabled`: the default (cooldown 0) or an explicit <= 0 override;
 *  - `auth-retry-exhausted`: the quiet-episode budget is spent;
 *  - `auth-cooldown`: opted in, but the cooldown has not elapsed;
 *  - `auth-retry`: exactly one automatic grant may now be sent.
 *
 * @param {{
 *   status?: object,
 *   cooldownMs?: number,
 *   attempts?: number,
 *   maxAttempts?: number,
 *   inFlight?: boolean,
 *   lastAuthAt?: number,
 *   now?: number,
 * }} [options]
 * @returns {{handled: boolean, reason: string, authorize: boolean}}
 */
export function planVtsQuietAuth(options = {}) {
  const input = options !== null && typeof options === 'object' ? options : {};
  const status = input.status !== null && typeof input.status === 'object' ? input.status : {};
  const quiet = status.state === 'requesting-grant' || status.state === 'token-invalid';
  if (!quiet) return { handled: false, reason: 'not-quiet', authorize: false };
  // A popup that still exists is the evidence that asking again would be a duplicate request.
  if (status.authorizePending === true) return { handled: true, reason: 'auth-pending', authorize: false };
  // A timeout is not a denial and not a reason to pop again when the cooldown expires.
  if (status.authError === 'grant-timeout') return { handled: true, reason: 'auth-incomplete', authorize: false };
  if (status.state === 'token-invalid' || status.needsAuth === true) {
    return { handled: true, reason: 'auth-user-action-required', authorize: false };
  }
  const cooldownMs = Number(input.cooldownMs ?? VTS_AUTH_AUTO_RETRY_MS);
  if (!Number.isFinite(cooldownMs) || cooldownMs <= 0) {
    return { handled: true, reason: 'auto-retry-disabled', authorize: false };
  }
  if (input.inFlight === true) return { handled: true, reason: 'auth-retry-in-flight', authorize: false };
  const requestedMax = Math.floor(Number(input.maxAttempts));
  const maxAttempts = Number.isFinite(requestedMax)
    ? Math.min(VTS_AUTH_AUTO_RETRY_MAX_ATTEMPTS_CAP, Math.max(1, requestedMax))
    : VTS_AUTH_AUTO_RETRY_MAX_ATTEMPTS;
  const requestedAttempts = Math.floor(Number(input.attempts));
  const attempts = Number.isFinite(requestedAttempts) ? Math.max(0, requestedAttempts) : 0;
  if (attempts >= maxAttempts) return { handled: true, reason: 'auth-retry-exhausted', authorize: false };
  const now = Number(input.now);
  const lastAuthAt = Math.max(
    Number(input.lastAuthAt ?? status.lastAuthAt) || 0,
    Number(input.hostRetryAt) || 0,
  );
  if (!shouldAutoReauthorize({
    state: status.state,
    authorizePending: status.authorizePending,
    lastAuthAt,
    now,
    cooldownMs,
  })) {
    return { handled: true, reason: 'auth-cooldown', authorize: false };
  }
  return { handled: true, reason: 'auth-retry', authorize: true };
}

/**
 * The Host-facing authorization phase. This keeps three stories apart that used to collapse into
 * "not connected": an ordinary disconnect may reconnect with the saved token, a rejected token
 * needs a deliberate user click, and a timed-out popup is an incomplete authorization that must
 * never be re-requested by a cooldown. Pure: it only reads the auth projection.
 *
 * @param {{
 *   state?: string,
 *   authenticated?: boolean,
 *   needsAuth?: boolean,
 *   authError?: string,
 *   authorizePending?: boolean,
 * }} [status]
 * @returns {'ready'|'authorization-incomplete'|'needs-reauthorization'|'authorization-pending'
 *          |'reconnecting'|'connecting'|'unknown'}
 */
export function vtsAuthPhase(status = {}) {
  const input = status !== null && typeof status === 'object' ? status : {};
  if (input.state === 'ready' || input.authenticated === true) return 'ready';
  // A timeout is an observation, not a re-request: show it as incomplete, never as "denied".
  if (input.authError === 'grant-timeout') return 'authorization-incomplete';
  if (input.state === 'token-invalid' || input.needsAuth === true) return 'needs-reauthorization';
  if (input.authorizePending === true) return 'authorization-pending';
  if (input.state === 'error' || input.state === 'disconnected') return 'reconnecting';
  if (input.state === 'connecting' || input.state === 'requesting-grant') return 'connecting';
  return 'unknown';
}

/**
 * @param {{
 *   probe?: () => Promise<boolean>|boolean,
 *   connect?: () => Promise<{ok?: boolean}>|{ok?: boolean},
 *   isEnabled?: () => boolean,
 *   revision?: () => number,
 *   mountRevision?: () => number,
 *   isDisposed?: () => boolean,
 *   isBusy?: () => boolean,
 *   now?: () => number,
 *   backoffMs?: number,
 * }} [options]
 * @returns {{tick: () => Promise<object>, run: () => Promise<object|null>,
 *            nextAttemptAt: () => number, running: () => boolean}}
 */
export function createVtsAutoConnect(options = {}) {
  const settings = options !== null && typeof options === 'object' ? options : {};
  const probe = typeof settings.probe === 'function' ? settings.probe : null;
  const connect = typeof settings.connect === 'function' ? settings.connect : null;
  const isEnabled = typeof settings.isEnabled === 'function' ? settings.isEnabled : () => false;
  const revision = typeof settings.revision === 'function' ? settings.revision : () => 0;
  const mountRevision = typeof settings.mountRevision === 'function' ? settings.mountRevision : () => 0;
  const isDisposed = typeof settings.isDisposed === 'function' ? settings.isDisposed : () => false;
  const isBusy = typeof settings.isBusy === 'function' ? settings.isBusy : () => false;
  const now = typeof settings.now === 'function' ? settings.now : () => Date.now();
  const backoffMs = Number.isFinite(Number(settings.backoffMs)) && Number(settings.backoffMs) >= 0
    ? Math.floor(Number(settings.backoffMs))
    : VTS_AUTO_BACKOFF_MS;

  let nextAt = 0;
  let running = false;

  /** Fail closed: an unreadable gate must block a side effect, never permit one. */
  const read = (gate, fallback) => {
    try {
      return gate();
    } catch {
      return fallback;
    }
  };
  const enabledNow = () => read(isEnabled, false) === true;
  const disposedNow = () => read(isDisposed, true) === true;
  const busyNow = () => read(isBusy, true) === true;
  const revisionNow = () => {
    const value = read(revision, null);
    return Number.isFinite(value) ? value : null;
  };
  const mountNow = () => {
    const value = read(mountRevision, null);
    return Number.isFinite(value) ? value : null;
  };
  const clockNow = () => {
    const value = Number(read(now, Number.NaN));
    return Number.isFinite(value) ? value : Date.now();
  };

  const tick = async () => {
    if (!enabledNow()) return { connected: false, reason: 'disabled' };
    if (disposedNow()) return { connected: false, reason: 'disposed' };
    if (busyNow()) return { connected: false, reason: 'busy' };
    if (clockNow() < nextAt) return { connected: false, reason: 'backoff' };

    // Record both generations BEFORE the await; any transition during the probe invalidates it.
    const revisionAtProbe = revisionNow();
    const mountAtProbe = mountNow();
    if (revisionAtProbe === null || mountAtProbe === null) {
      return { connected: false, reason: 'unreadable-generation' };
    }

    let reachable = false;
    if (probe !== null) {
      try {
        reachable = (await probe()) === true;
      } catch {
        reachable = false;
      }
    }

    // The probe awaited: re-read every gate before the connect side effect.
    if (!enabledNow()) return { connected: false, reason: 'disabled-after-probe' };
    if (disposedNow()) return { connected: false, reason: 'disposed-after-probe' };
    if (revisionNow() !== revisionAtProbe) return { connected: false, reason: 'revision-changed' };
    if (mountNow() !== mountAtProbe) return { connected: false, reason: 'unmounted' };
    if (busyNow()) return { connected: false, reason: 'busy-after-probe' };
    if (reachable !== true) return { connected: false, reason: 'unreachable' };

    let result = { ok: false };
    if (connect !== null) {
      try {
        result = await connect();
      } catch (error) {
        result = { ok: false, error: error?.message ?? String(error) };
      }
    }
    const ok = result?.ok === true;
    nextAt = ok ? 0 : clockNow() + backoffMs;
    return { connected: ok, result, reason: ok ? '' : 'connect-failed' };
  };

  /** Timer-safe entry: one tick at a time; a concurrent timer callback is a no-op. */
  const run = () => {
    if (running) return Promise.resolve(null);
    running = true;
    return tick()
      .catch(() => null)
      .finally(() => { running = false; });
  };

  return {
    tick,
    run,
    nextAttemptAt: () => nextAt,
    running: () => running,
  };
}
