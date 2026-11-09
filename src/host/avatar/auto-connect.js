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
