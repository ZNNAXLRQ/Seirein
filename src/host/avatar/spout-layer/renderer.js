/**
 * Phase 1 renderer: start the WebGL stage, then register the real Spout receiver.
 *
 * The WebGL context, texture and quad live in the preload's isolated world (see preload.js):
 * Electron's shared-texture callback hands over a `VideoFrame`, which can only be consumed where
 * the renderer `electron` module is available. The page owns the control sequence and reports
 * readiness only after both halves exist: the Electron texture receiver and the native Spout
 * receiver. With no sender the stage keeps painting a fully transparent placeholder and this page
 * reports `waiting-sender` instead of failing.
 */
(() => {
  const canvas = document.getElementById('stage');
  if (canvas === null) {
    window.spoutLayer?.reportError({ code: 'WINDOW_FAILED', message: 'canvas #stage missing' });
    return;
  }

  let reported = false;
  let polling = false;

  // Presentation contract, display half: nothing behind the WebGL canvas may paint. index.html
  // already declares the document transparent; asserting it here keeps the contract true if the
  // document is ever replaced and makes it checkable from a fake DOM.
  for (const element of [document.documentElement, document.body, canvas]) {
    if (element === null || element === undefined || element.style === undefined) continue;
    element.style.background = 'transparent';
    element.style.backgroundColor = 'transparent';
  }

  const stageStats = () => {
    try {
      return window.spoutLayer?.stageStats?.() ?? null;
    } catch {
      return null;
    }
  };

  const resize = () => {
    window.spoutLayer?.resizeStage?.(
      Math.max(1, Math.round(window.innerWidth || 1)),
      Math.max(1, Math.round(window.innerHeight || 1)),
    );
  };

  const reportReady = (extra) => {
    if (reported) return;
    reported = true;
    const stats = stageStats();
    window.spoutLayer?.reportReady({
      // `drawn` now means "a real texture frame was drawn", not "a test canvas painted".
      drawn: Number(stats?.drawn ?? 0) > 0,
      frames: Number(stats?.drawn ?? 0),
      fps: Number(stats?.fps ?? 0),
      width: Number(stats?.width ?? canvas.width),
      height: Number(stats?.height ?? canvas.height),
      textureWidth: Number(stats?.textureWidth ?? 0),
      textureHeight: Number(stats?.textureHeight ?? 0),
      // Ready is only ever reported after `setSharedTextureReceiver` succeeded; the main process
      // rejects any ready report that claims this without the matching IPC acknowledgement.
      sharedTextureRegistered: true,
      ...extra,
    });
  };

  const fail = (code, message) => {
    window.spoutLayer?.reportError({ code, message });
  };

  /** Keep polling the native receiver status until it sees the sender or the budget expires. */
  const poll = async () => {
    if (polling) return;
    polling = true;
    for (;;) {
      let status = null;
      try {
        status = await window.spoutLayer?.receiverStatus();
      } catch (error) {
        fail('RECEIVER_NOT_READY', `receiver status failed: ${error?.message ?? error}`);
        return;
      }
      if (status?.connected === true) {
        reportReady({
          phase: 'receiver',
          registered: true,
          connected: true,
          sender: status.sender,
          surface: status.surface,
        });
        return;
      }
      if (status?.timedOut === true || status?.registered === false) return;
      await new Promise((done) => setTimeout(done, 400));
    }
  };

  const register = async () => {
    // Step 1: WebGL stage + Electron's renderer-side texture receiver. Registering the native
    // Spout receiver without this would make every `sendSharedTexture` time out at 1000 ms.
    let texture = null;
    try {
      texture = await window.spoutLayer?.startStage?.();
    } catch (error) {
      fail('SHARED_TEXTURE_REGISTER_FAILED', `shared texture receiver failed: ${error?.message ?? error}`);
      return;
    }
    if (texture?.ok !== true) {
      fail(
        String(texture?.code ?? 'SHARED_TEXTURE_REGISTER_FAILED'),
        String(texture?.error ?? 'shared texture receiver registration failed'),
      );
      return;
    }

    // Step 2: the native Spout receiver (main process).
    let status = null;
    try {
      // The receiver itself is a native object in the main process (N-API + main-only shared
      // texture APIs); the renderer owns the phase transition and reports it, not the canvas.
      status = await window.spoutLayer?.registerReceiver({});
    } catch (error) {
      fail('RECEIVER_NOT_READY', `receiver registration failed: ${error?.message ?? error}`);
      return;
    }
    if (status?.ok !== true || status?.registered !== true) {
      fail(String(status?.code ?? 'RECEIVER_NOT_READY'), String(status?.message ?? 'receiver registration failed'));
      return;
    }
    if (status.connected === true) {
      reportReady({
        phase: 'receiver',
        registered: true,
        connected: true,
        sender: status.sender,
        surface: status.surface,
      });
      return;
    }
    reportReady({
      phase: 'waiting-sender',
      registered: true,
      connected: false,
      waiting: true,
      sender: status.sender,
      surface: status.surface,
      senderTimeoutMs: status.senderTimeoutMs,
    });
    void poll();
  };

  window.addEventListener('resize', () => {
    resize();
  });

  // ---- edit mode (layer-internal) --------------------------------------------------------
  // The main process switches the window from click-through to interactive. This page only
  // reports pointer deltas and draws the corner affordance; it never moves the window itself and
  // never touches the stage, so rendering/fps accounting stays exactly the same.
  let editing = false;
  let gesture = null;
  const handle = document.createElement('div');
  handle.id = 'edit-handle';
  handle.style.cssText = 'position:fixed;right:0;bottom:0;width:24px;height:24px;z-index:10;'
    + 'cursor:nwse-resize;display:none;background:rgba(90,170,255,0.25);border-top-left-radius:6px;';
  document.body.appendChild(handle);

  // Screen coordinates, never `clientX/clientY`: the window itself moves under the pointer while
  // dragging, so client coordinates measure the cursor against the window it is moving and the
  // window would only travel half the distance the mouse really did.
  const point = (event) => ({ x: Number(event.screenX) || 0, y: Number(event.screenY) || 0 });
  const sendDelta = (mode, dx, dy, done = false) => {
    const send = mode === 'resize' ? window.spoutLayer?.editResize : window.spoutLayer?.editDrag;
    send?.(dx, dy, done);
  };
  const endGesture = () => {
    if (gesture === null) return;
    const mode = gesture.mode;
    gesture = null;
    sendDelta(mode, 0, 0, true);
  };

  // ---- wheel zoom (edit mode only) -------------------------------------------------------
  // The main process is the only place a rectangle is applied, so the wheel becomes a size delta
  // on the existing resize channel: proportional, clamped to the same 64..4096 range the host
  // accepts, and coalesced to one message (and one throttled bounds report) per interval.
  const SCALE_MIN = 64;
  const SCALE_MAX = 4096;
  const WHEEL_THROTTLE_MS = 50;
  let wheelTimer = null;
  let wheelFactor = 1;
  const resetWheel = () => {
    if (wheelTimer !== null) clearTimeout(wheelTimer);
    wheelTimer = null;
    wheelFactor = 1;
  };
  const flushWheel = () => {
    wheelTimer = null;
    const factor = wheelFactor;
    wheelFactor = 1;
    if (!editing || factor === 1) return;
    const width = Math.max(1, Math.round(window.innerWidth || 1));
    const height = Math.max(1, Math.round(window.innerHeight || 1));
    const targetWidth = Math.min(SCALE_MAX, Math.max(SCALE_MIN, Math.round(width * factor)));
    const targetHeight = Math.min(SCALE_MAX, Math.max(SCALE_MIN, Math.round(height * factor)));
    if (targetWidth === width && targetHeight === height) return;
    sendDelta('resize', targetWidth - width, targetHeight - height);
  };

  window.spoutLayer?.onEditMode?.((state) => {
    editing = state?.editMode === true;
    document.body.style.cursor = editing ? 'move' : '';
    handle.style.display = editing ? 'block' : 'none';
    if (!editing) {
      endGesture();
      resetWheel();
    }
  });
  window.addEventListener('wheel', (event) => {
    if (!editing) return;
    event.preventDefault?.();
    const deltaY = Number(event.deltaY);
    if (!Number.isFinite(deltaY) || deltaY === 0) return;
    // ~10% per 100 px of wheel travel; a single event can never more than halve or double the size.
    wheelFactor *= Math.min(2, Math.max(0.5, Math.exp(-deltaY * 0.001)));
    if (wheelTimer === null) wheelTimer = setTimeout(flushWheel, WHEEL_THROTTLE_MS);
  }, { passive: false });

  document.addEventListener('pointerdown', (event) => {
    if (!editing || event.button !== 0) return;
    gesture = { mode: event.target === handle ? 'resize' : 'drag', last: point(event) };
    try {
      // Keep receiving moves even if the pointer leaves the (moving) window mid-gesture.
      document.body.setPointerCapture?.(event.pointerId);
    } catch {
      /* capture is best effort */
    }
    event.preventDefault();
  });
  window.addEventListener('pointermove', (event) => {
    if (gesture === null) return;
    const now = point(event);
    const dx = now.x - gesture.last.x;
    const dy = now.y - gesture.last.y;
    if (dx === 0 && dy === 0) return;
    gesture.last = now;
    sendDelta(gesture.mode, dx, dy);
  });
  window.addEventListener('pointerup', endGesture);
  window.addEventListener('pointercancel', endGesture);
  window.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !editing) return;
    event.preventDefault();
    window.spoutLayer?.exitEdit?.();
  });

  window.addEventListener('error', (event) => {
    window.spoutLayer?.reportError({
      code: 'WINDOW_FAILED',
      message: `${event.message || 'renderer error'} @${event.filename || '?'}:${event.lineno || 0}`,
    });
  });

  resize();
  // The stage paints its transparent placeholder from `start()`; registration starts on the next
  // turn so the canvas has its final drawing-buffer size.
  requestAnimationFrame(() => {
    void register();
  });
})();
