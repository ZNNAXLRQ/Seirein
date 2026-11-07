/** Microphone/loopback autostart, retries and manual capture toggling. */
/** Short, user-facing label for why a capture session (mic or loopback) could not start. */
export function captureDeferredReason(error) {
  const text = typeof error === 'string' ? error.trim() : '';
  if (text.length === 0) return '启动失败';
  if (/占用|busy|in use|EBUSY|已使用/iu.test(text)) return '设备占用';
  if (/没有检测到回环设备|找不到.*设备|没有可用|no (?:loopback|device)/iu.test(text)) return '找不到设备';
  if (/低配/iu.test(text)) return '低配档';
  if (/ffmpeg/iu.test(text)) return '缺少 ffmpeg';
  if (/模型缺失|ASR 模型/iu.test(text)) return '模型缺失';
  return text;
}

/**
 * One-shot capture autostart with a bounded retry ladder, shared by hearing (mic) and ambient
 * (loopback). Only the recorded event name differs: `<kind>.start.deferred`.
 *
 * The first attempt waits `delayMs` (device enumeration and the Host's own boot work would
 * otherwise race it); a failure records the deferred event and retries at 5 s, 15 s and 30 s.
 * After the last retry the controller goes quiet: no timer, no more events. A manual
 * stop/cancel ends the ladder too, and an already-running session is never started twice.
 *
 * Timers and I/O are injected so `test/ambient-autostart.mjs` and `test/capture-autostart.mjs`
 * can drive the ladder with fake timers and no ffmpeg.
 */
export function createCaptureAutostart({
  kind = 'ambient',
  enabled = () => false,
  isRunning = () => false,
  start = async () => ({ ok: false, error: 'not configured' }),
  log = null,
  delayMs = 1500,
  retryDelaysMs = [5000, 15000, 30000],
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  const event = kind === 'hearing' ? 'hearing.start.deferred' : 'ambient.start.deferred';
  const retries = Array.isArray(retryDelaysMs)
    ? retryDelaysMs.filter((value) => Number.isFinite(value) && value >= 0)
    : [];
  let timer = null;
  let retryIndex = 0;
  let finished = false;
  let deferred = null;

  const clearTimerHandle = () => {
    if (timer === null) return;
    clearTimer(timer);
    timer = null;
  };

  const noteDeferred = async (result) => {
    deferred = {
      reason: captureDeferredReason(result?.error),
      device: typeof result?.device === 'string' ? result.device : '',
      at: Date.now(),
    };
    try {
      await log?.emit?.(event, { reason: deferred.reason, device: deferred.device });
    } catch {
      /* logging must not break the retry ladder */
    }
  };

  const schedule = (waitMs) => {
    if (finished) return;
    clearTimerHandle();
    timer = setTimer(() => {
      timer = null;
      void attempt();
    }, waitMs);
    timer?.unref?.();
  };

  const attempt = async () => {
    if (finished || !enabled()) return;
    if (isRunning()) {
      // The user (or the settings page) already started it: autostart has nothing to add.
      finished = true;
      return;
    }
    let result;
    try {
      result = await start();
    } catch (error) {
      result = { ok: false, device: '', error: error?.message ?? String(error) };
    }
    if (result?.ok === true) {
      deferred = null;
      finished = true;
      return;
    }
    await noteDeferred(result);
    if (retryIndex >= retries.length) {
      finished = true;
      return;
    }
    const waitMs = retries[retryIndex];
    retryIndex += 1;
    schedule(waitMs);
  };

  return {
    /** Arm the ladder once. Repeated calls (a second load) are no-ops. */
    schedule() {
      if (finished || timer !== null) return;
      if (!enabled() || isRunning()) return;
      schedule(delayMs);
    },
    /** End the ladder: a manual stop, or plugin disposal. */
    cancel() {
      finished = true;
      clearTimerHandle();
    },
    clearDeferred() {
      deferred = null;
    },
    get deferred() {
      return deferred;
    },
    get pending() {
      return timer !== null;
    },
  };
}

/** Ambient (loopback) autostart — the original entry point, unchanged timing. */
export function createAmbientAutostart(options = {}) {
  return createCaptureAutostart({ ...options, kind: 'ambient' });
}

/** Microphone autostart — same ladder as ambient, records `hearing.start.deferred`. */
export function createHearingAutostart(options = {}) {
  return createCaptureAutostart({ ...options, kind: 'hearing' });
}

/**
 * Hotkey `/` settings toggle for the ambient session: stop when running, start when not.
 * The outcome is recorded once as `hotkeys.ambient {running}`.
 */
export async function toggleAmbientCapture({ isRunning, start, stop, log = null } = {}) {
  const wasRunning = isRunning?.() === true;
  let running = wasRunning;
  let device = '';
  let error = '';
  if (wasRunning) {
    try {
      await stop?.();
    } catch (caught) {
      error = caught?.message ?? String(caught);
    }
    running = false;
  } else {
    let result;
    try {
      result = await start?.();
    } catch (caught) {
      result = { ok: false, device: '', error: caught?.message ?? String(caught) };
    }
    running = result?.ok === true;
    device = typeof result?.device === 'string' ? result.device : '';
    if (!running) error = result?.error ?? '环境声音启动失败';
  }
  try {
    await log?.emit?.('hotkeys.ambient', { running });
  } catch {
    /* the hotkey must not throw on a logging failure */
  }
  return { running, device, error };
}
