/**
 * Shared teardown for tests that mount the plugin against a fake context.
 *
 * A real Cordis scope runs every `ctx.effect()` disposer when the scope is disposed, in reverse
 * registration order. The fake contexts used here called the effect callback but dropped the
 * returned disposer, so SQLite stores stayed open while `rm()` ran; on Windows that fails with
 * `EBUSY ... memory\profile.db`, and a `.catch(() => {})` hid it, leaving temp roots behind and
 * letting the suite go green.
 *
 * `cleanupRoot` closes that hole: it runs the disposers first (closing databases, stopping
 * timers/processes), then removes the temp root. Nothing is swallowed — a throwing disposer or a
 * still-locked file fails the test instead of leaving a directory to accumulate.
 */
import { rm } from 'node:fs/promises';

/** Retries absorb transient Windows locks (indexer/AV) without hiding a real open handle. */
const RM_OPTIONS = Object.freeze({ recursive: true, force: true, maxRetries: 3, retryDelay: 50 });

/** Run disposers in reverse registration order; return their failures instead of dropping them. */
export async function disposeAll(disposers = []) {
  const failures = [];
  for (const disposer of [...disposers].reverse()) {
    const run = typeof disposer === 'function'
      ? disposer
      : (disposer && typeof disposer.dispose === 'function' ? () => disposer.dispose() : null);
    if (run === null) continue;
    try {
      await run();
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
}

/**
 * Dispose a fake plugin mount, then delete its temp root.
 *
 * @param {string} root temp directory created for the test
 * @param {Array<() => void>} disposers disposers captured from `ctx.effect()`
 */
export async function cleanupRoot(root, disposers = []) {
  const failures = await disposeAll(disposers);
  if (typeof root === 'string' && root.length > 0) {
    try {
      await rm(root, RM_OPTIONS);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, `cleanup failed: ${root}`);
}
