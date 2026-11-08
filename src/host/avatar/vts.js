/**
 * VTube Studio API client.
 *
 * The Host is a Node process with no window, so everything goes through the VTS public
 * WebSocket API on 127.0.0.1:8001: authenticate once (token persisted), then trigger hotkeys,
 * expressions, inject parameters (mouth/eyes) and move the model. InjectParameterDataRequest takes
 * VTS tracking *input* parameters, so listInputParameters() is the only honest source of what can
 * be driven; the user's VTS parameter mapping decides whether the model reacts.
 *
 * Two transports share one socket, because they have opposite needs:
 *
 *   control  — auth, model switch, queries. Serialized, one answer + timeout each, so a request
 *              can never be answered by the wrong caller. Empirical gap: 100 ms (~10/s).
 *   frames   — InjectParameterDataRequest, i.e. lip-sync and future motion. A single
 *              `pendingFrame` slot: if a newer value arrives before the old one left, the old one
 *              is dropped instead of queued. No catch-up playback, no growing backlog.
 *
 * The 33 ms frame gap is an experience-based ceiling (≈30 Hz), NOT a documented VTS limit; it is a
 * constant precisely so it can be tuned without touching the loop.
 */
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import WebSocket from 'ws';

/** Control requests: serialize and keep this gap so query bursts cannot starve the socket. */
const CONTROL_MIN_GAP_MS = 100;
/** Real-time parameter frames: ~30 Hz ceiling. Empirical, not a protocol guarantee. */
const MIN_FRAME_GAP_MS = 33;
/** How long a frame waits for VTS's answer before it settles as "sent but unacknowledged". */
const FRAME_REPLY_TIMEOUT_MS = 400;
/** How many timed-out frame IDs are remembered so a late APIError is still attributable. */
const FRAME_LATE_SLOTS = 64;
/** Ring size for computedHz: ~2 s of frames at 30 Hz. */
const FRAME_RATE_WINDOW = 64;
/**
 * A looping idle animation emits a Start event every loop. Recording one per name per minute is
 * enough to prove the event path works without turning the log into a metronome.
 */
const ANIMATION_START_DEDUPE_MS = 60_000;
/** Bounded history of recorded animation starts (the live value is `animations.current`). */
const ANIMATION_RECORD_LIMIT = 20;
/**
 * A socket that is replaced gets this long to finish its close handshake. VTS keeps counting a
 * plugin until that handshake completes, so dialing before it does is what produced two connections.
 */
const SOCKET_CLOSE_WAIT_MS = 1_000;
/** After terminate(), a short grace period for ws to report the socket closed. */
const SOCKET_TERMINATE_WAIT_MS = 250;
/** readyState → label, used by the vts.socket.replaced event to name what was retired. */
const SOCKET_STATES = ['connecting', 'open', 'closing', 'closed'];
const API_NAME = 'VTubeStudioPublicAPI';
const API_VERSION = '1.0';
const FRAME_PREFIX = 'dsh-frame-';
const REQUEST_PREFIX = 'dsh-';

/**
 * Authorization state machine. The states are deliberately few: "connected but not authorized"
 * is not a state, because a socket that cannot authenticate is not a usable connection.
 *
 *   disconnected → connecting → ready
 *                        ↘ requesting-grant → ready
 *                        ↘ token-invalid    (waits for an explicit retry())
 *                        ↘ error            (transport failure, never disguised as a grant wait)
 *
 * requesting-grant is a *quiet* state: the plugin has asked VTS once and is waiting for the user.
 * No timer, reconnect or concurrent connect() may send a second AuthenticationTokenRequest from it.
 */
export const VTS_AUTH_STATES = Object.freeze([
  'disconnected',
  'connecting',
  'requesting-grant',
  'ready',
  'token-invalid',
  'error',
]);
/** States in which an automatic reconnect is forbidden: a popup is already waiting for the user. */
const AUTH_QUIET_STATES = new Set(['requesting-grant', 'token-invalid']);
/** How long the user is given to answer the VTS authorization popup before it is recorded as slow. */
const AUTH_GRANT_TIMEOUT_MS = 60_000;
/** Backoff defaults used only when autoReconnect is explicitly enabled by the caller. */
const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;
/** Bounded history so status() can explain the last transitions without growing forever. */
const AUTH_TRANSITION_LIMIT = 32;
const AUTH_EVENT_LIMIT = 64;

const normalizeName = (name) => String(name ?? '').trim().toLowerCase();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let tokenTempSeq = 0;

/** VTS answers an unsupported message with messageType=APIError (HTTP 200), so surface it. */
function unwrap(response, messageType) {
  if (response?.messageType === 'APIError') {
    const data = response.data ?? {};
    const detail = data.message ?? data.errorMessage ?? `errorID ${data.errorID ?? 'unknown'}`;
    throw new Error(`${messageType} failed: ${detail}`);
  }
  return response?.data ?? {};
}

/** Same wording as unwrap()'s rejection, for callers that return instead of throw. */
function errorText(response, messageType) {
  try {
    unwrap(response, messageType);
  } catch (error) {
    return error?.message ?? String(error);
  }
  return '';
}

/** Keep a diagnostic copy of a raw VTS answer, small enough to show in a status line. */
function truncateResponse(value, max = 400) {
  let text;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  const raw = String(text ?? '');
  return raw.length > max ? `${raw.slice(0, max)}…` : raw;
}

/**
 * Model parameter names worth probing when Live2DParameterListRequest is unavailable. These are
 * Live2D parameters, not injectable VTS inputs — used only to report what the model has.
 */
const KNOWN_MODEL_PARAMETERS = [
  'ParamAngleX', 'ParamAngleY', 'ParamAngleZ',
  'ParamEyeBallX', 'ParamEyeBallY', 'ParamEyeLOpen', 'ParamEyeROpen',
  'ParamBrowLY', 'ParamBrowRY', 'ParamMouthOpenY', 'ParamMouthForm',
  'ParamBodyAngleX', 'ParamBodyAngleY', 'ParamBodyAngleZ', 'ParamBreath',
  'ParamHairFront', 'ParamHairSide', 'ParamHairBack',
];

/** Tolerate the camelCase / PascalCase spellings older and newer VTS builds use. */
const collectModelParameters = (list) =>
  (Array.isArray(list) ? list : [])
    .map((entry) => ({
      name: String(entry?.name ?? entry?.id ?? ''),
      value: Number(entry?.value ?? 0),
      min: Number(entry?.min ?? 0),
      max: Number(entry?.max ?? 1),
      defaultValue: Number(entry?.defaultValue ?? 0),
    }))
    .filter((entry) => entry.name.length > 0);

export class VtsClient {
  constructor({
    port = 8001,
    pluginName = 'DSH Companion',
    pluginDeveloper = 'local',
    tokenPath,
    onModelChanged = null,
    onFrameError = null,
    /**
     * Opt-in: subscribe to ModelAnimationEvent on every connect. Off by default so an existing
     * client keeps its single EventSubscriptionRequest (and older VTS builds are untouched).
     */
    animationEvents = false,
    /** true, or a function read on every frame: the `avatar.faceFound` setting. Default false. */
    faceFound = null,
    /**
     * (type, payload) => void — legacy observation events: vts.auth.renew/ok/failed,
     * avatar.animation.*, avatar.inject.*. The new state-machine events are on onAuthEvent.
     */
    onEvent = null,
    /**
     * (type, payload) => void — the authorization state machine's own channel. It is separate from
     * `onEvent` because the legacy auth event contract (renew/ok/failed) is asserted exactly by the
     * existing vts-* suites; mixing the new state/token/requested events into it would silently
     * change that contract. The Host projection subscribes here.
     */
    onAuthEvent = null,
    /** Mirror the state-machine events into `onEvent` too (opt-in; default keeps legacy exact). */
    mirrorAuthEvents = false,
    /** How long the user has to answer VTS's authorization popup before the wait is recorded. */
    grantTimeoutMs = AUTH_GRANT_TIMEOUT_MS,
    /**
     * Automatic reconnect is OFF by default. The Host already retries every minute; a client-side
     * timer would be a second, uncoordinated dialer. When enabled, every attempt is backed off
     * exponentially and is refused entirely while requesting-grant / token-invalid.
     */
    autoReconnect = false,
    reconnectBaseMs = RECONNECT_BASE_MS,
    reconnectMaxMs = RECONNECT_MAX_MS,
  }) {
    this.port = port;
    // Captured once and only changed through setPluginIdentity(): VTS binds a token to this pair,
    // so deriving it per request would silently authorize a different plugin.
    this.plugin = { pluginName: String(pluginName), pluginDeveloper: String(pluginDeveloper) };
    this.tokenPath = tokenPath;
    this.token = '';
    this.socket = null;
    /**
     * Every socket this client owns that has not reported 'close' yet. A socket whose close() was
     * already called still holds a TCP connection on VTS's side until the handshake finishes, so
     * this Set — not `this.socket` — is the truth about whether a new dial is allowed.
     */
    this.sockets = new Set();
    /** Per-socket state listeners, kept so a retired socket can be detached instead of leaking. */
    this.socketHandlers = new Map();
    /** In-flight retirement per socket: close(), then connect() must not close it twice. */
    this.socketRetiring = new Map();
    /** Bumped by close(): an openSocket() that resolves afterwards must not adopt its candidate. */
    this.socketEpoch = 0;
    /** Bumped by close(): an in-flight authenticate() must not overwrite the closed state. */
    this.closeEpoch = 0;
    /** Actual replacements (a leftover socket retired before a new dial), exposed for status. */
    this.socketReconnects = 0;
    this.seq = 0;
    this.pending = new Map();
    this.queue = Promise.resolve();
    this.lastSentAt = 0;
    this.lastError = '';
    this.lastFrameError = '';
    this.lastTokenError = '';
    this.model = null;
    this.modelId = '';
    this.hotkeys = [];
    this.expressions = [];

    // Connection state is three-valued on purpose: an open socket that failed to authenticate is
    // NOT a usable connection, and reporting it as one is what made "已连接" lie.
    this.authenticated = false;
    this.ready = false;
    this.connectPromise = null;
    /** True while this connection is waiting for a token grant / AuthenticationRequest answer. */
    this.authPending = false;
    this.authRenewed = false;
    /** Authorization state machine (see VTS_AUTH_STATES above). */
    this.authState = 'disconnected';
    this.auth = {
      previous: '',
      reason: '',
      changedAt: 0,
      /** AuthenticationTokenRequest sends; the `attempt` carried by vts.auth.requested. */
      attempts: 0,
      /** AuthenticationRequest sends (a grant retry adds one). */
      authentications: 0,
      retries: 0,
      tokenPresent: false,
      /** A token VTS granted in this process was rejected; do not re-ask for another popup. */
      freshTokenRejected: false,
      transitions: [],
      events: [],
      pluginChanged: false,
      pluginChangedAt: 0,
      pluginPrevious: null,
      pluginHistory: [],
    };
    this.grantTimeoutMs = Math.max(1, Number(grantTimeoutMs) || AUTH_GRANT_TIMEOUT_MS);
    this.autoReconnect = autoReconnect === true;
    this.reconnectBaseMs = Math.max(1, Number(reconnectBaseMs) || RECONNECT_BASE_MS);
    this.reconnectMaxMs = Math.max(this.reconnectBaseMs, Number(reconnectMaxMs) || RECONNECT_MAX_MS);
    this.reconnect = {
      attempts: 0,
      timer: null,
      nextAt: 0,
      lastDelayMs: 0,
      scheduled: 0,
      fired: 0,
      lastReason: '',
      delays: [],
    };

    // Real-time frame transport (single slot + single-flight loop).
    this.pendingFrame = null;
    this.frameLoop = null;
    this.frameAwait = new Map();
    this.frameLate = new Map();
    this.frameSentAt = [];
    this.lastFrameAt = 0;
    this.frameEpoch = 0;
    this.frameStats = { sent: 0, dropped: 0, lastSentAt: 0, lastDropReason: '' };

    // Event subscription state. Real VTS only pushes ModelLoadedEvent after an explicit
    // EventSubscriptionRequest, so this is not optional decoration.
    this.eventsSubscribed = false;
    this.subscribedEvents = [];
    this.lastEventError = '';
    /** Why the last subscription was not confirmed, and the raw answer that caused it. */
    this.subscriptionError = '';
    this.subscriptionResponse = '';

    // ModelAnimationEvent state. VTS never sends an End event when the model is unloaded (or the
    // socket dies), so `current` must also be cleared by the model-loaded / disconnect paths.
    this.animationEvents = animationEvents === true;
    this.animationEventsSubscribed = false;
    this.animationSubscribedEvents = [];
    this.animationSubscriptionError = '';
    this.animationSubscriptionResponse = '';
    this.animationStartAt = new Map();
    this.animations = {
      /** {name, durationMs, startedAt, isIdle} of the animation believed to be running, or null. */
      current: null,
      starts: 0,
      ends: 0,
      /** Starts suppressed inside ANIMATION_START_DEDUPE_MS (the idle loop repeats). */
      deduped: 0,
      resets: 0,
      /** One row per recorded (non-deduped) Start, bounded to ANIMATION_RECORD_LIMIT. */
      records: [],
      lastStartAt: 0,
      lastReset: null,
    };

    // faceFound is OFF unless the host setting turns it on; the request shape stays unchanged while
    // it is off, so enabling it is a deliberate, observable act.
    this.faceFound = faceFound === true;
    this.faceFoundProvider = typeof faceFound === 'function' ? faceFound : null;
    this.inject = { faceFound: this.faceFound, requests: 0, faceFoundRequests: 0, lastFaceFoundAt: 0, faceFoundLogged: false };
    /** Host-facing read-only view: `state.animations.current` / `state.inject.faceFound`. */
    this.state = { animations: this.animations, inject: this.inject };

    // Capability cache: what VTS says is injectable, and which input feeds each channel.
    this.injectable = new Map();
    this.inputIndexPromise = null;
    this.channelInputs = {};

    this.onModelChanged = onModelChanged;
    this.onFrameError = onFrameError;
    this.onEvent = typeof onEvent === 'function' ? onEvent : null;
    this.onAuthEvent = typeof onAuthEvent === 'function' ? onAuthEvent : null;
    this.mirrorAuthEvents = mirrorAuthEvents === true;
  }

  /** WebSocket state only. Use `ready` to mean "connected and authenticated". */
  get connected() {
    return this.socket !== null && this.socket.readyState === WebSocket.OPEN;
  }

  /**
   * The exact socket a connect started on is still the one we hold, still open, and still
   * authenticated. Identity matters: a reconnect replaces `this.socket`, so a late answer from the
   * old one must never promote the new connection (or a dead one) to ready.
   */
  isUsableSocket(socket) {
    return socket !== null
      && socket !== undefined
      && this.socket === socket
      && socket.readyState === WebSocket.OPEN
      && this.authenticated === true;
  }

  /** (type, payload) => void for the authorization state machine only. Never throws. */
  emitAuthEvent(type, payload = {}) {
    const event = { type, at: Date.now(), ...payload };
    this.auth.events.push(event);
    while (this.auth.events.length > AUTH_EVENT_LIMIT) this.auth.events.shift();
    try {
      this.onAuthEvent?.(type, payload);
    } catch {
      /* an observer must not be able to break authorization */
    }
    // Opt-in so the legacy vts.auth.renew/ok/failed sequence on `onEvent` stays byte-identical.
    if (this.mirrorAuthEvents === true) this.emitEvent(type, payload);
  }

  /**
   * The only place `authState` changes. Re-entering the same state is not a transition (no event),
   * but the reason is still updated so status() explains why that state is held.
   */
  setAuthState(to, reason = '') {
    if (!VTS_AUTH_STATES.includes(to)) throw new Error(`unknown VTS auth state: ${to}`);
    const from = this.authState;
    const text = String(reason ?? '');
    if (from === to) {
      this.auth.reason = text;
      return from;
    }
    this.authState = to;
    this.auth.previous = from;
    this.auth.reason = text;
    this.auth.changedAt = Date.now();
    this.auth.transitions.push({ from, to, reason: text, at: this.auth.changedAt });
    while (this.auth.transitions.length > AUTH_TRANSITION_LIMIT) this.auth.transitions.shift();
    this.emitAuthEvent('vts.auth.state', { from, to, reason: text });
    return from;
  }

  /** A coded error for the "already waiting for the user" gates (no request is sent). */
  authGateError(code, message) {
    const error = new Error(message);
    error.code = code;
    error.authState = this.authState;
    return error;
  }

  /**
   * Read the persisted token. Missing is a normal first install; a corrupt/unreadable file is a
   * visible token failure (`vts.auth.token {ok:false}`) and both lead to requesting-grant.
   */
  async loadToken() {
    if (this.token.length > 0) {
      this.auth.tokenPresent = true;
      return this.token;
    }
    this.auth.tokenPresent = false;
    try {
      const saved = JSON.parse(await readFile(this.tokenPath, 'utf8'));
      const token = typeof saved?.authenticationToken === 'string' ? saved.authenticationToken.trim() : '';
      this.token = token;
      this.auth.tokenPresent = token.length > 0;
      if (token.length === 0) {
        this.lastTokenError = 'token file has no authenticationToken';
        this.emitAuthEvent('vts.auth.token', { ok: false, error: this.lastTokenError, action: 'read' });
      } else {
        this.lastTokenError = '';
        this.emitAuthEvent('vts.auth.token', { ok: true, action: 'read' });
      }
    } catch (error) {
      this.token = '';
      this.auth.tokenPresent = false;
      if (error?.code === 'ENOENT') {
        // First install: no file is not a failure, only a missing token.
        this.lastTokenError = '';
        this.emitAuthEvent('vts.auth.token', { ok: false, error: 'no token file', action: 'read', missing: true });
      } else {
        this.lastTokenError = `token read failed: ${error?.message ?? String(error)}`;
        this.emitAuthEvent('vts.auth.token', { ok: false, error: this.lastTokenError, action: 'read' });
      }
    }
    return this.token;
  }

  /**
   * Atomic token write: temp file in the same directory, then rename over the target. A partial
   * file can therefore never be read as a token (the failure mode that forced a manual delete).
   */
  async writeTokenFile(value) {
    if (typeof this.tokenPath !== 'string' || this.tokenPath.length === 0) {
      const error = new Error('token write failed: tokenPath is not configured');
      error.code = 'TOKEN_WRITE_FAILED';
      throw error;
    }
    const tempPath = `${this.tokenPath}.tmp-${process.pid}-${++tokenTempSeq}`;
    try {
      await mkdir(dirname(this.tokenPath), { recursive: true });
      await writeFile(tempPath, `${JSON.stringify({ authenticationToken: value }, null, 2)}\n`, 'utf8');
      // Same-directory rename is the atomic replace on NTFS as well as POSIX filesystems.
      await rename(tempPath, this.tokenPath);
    } catch (cause) {
      await unlink(tempPath).catch(() => {});
      const error = new Error(`token write failed: ${cause?.message ?? String(cause)}`);
      error.code = 'TOKEN_WRITE_FAILED';
      error.cause = cause;
      throw error;
    }
  }

  /**
   * Persist a grant. A failed write is recorded and moves the machine to `error`: reporting ready
   * on a token that only exists in memory would make the next launch ask for authorization again.
   */
  async saveToken(token) {
    const value = String(token ?? '');
    try {
      await this.writeTokenFile(value);
    } catch (error) {
      this.lastTokenError = error.message;
      this.setAuthState('error', 'token-write-failed');
      this.emitAuthEvent('vts.auth.token', { ok: false, error: error.message, action: 'write' });
      throw error;
    }
    this.token = value;
    this.auth.tokenPresent = value.length > 0;
    this.lastTokenError = '';
    this.emitAuthEvent('vts.auth.token', { ok: true, action: 'write' });
    return value;
  }

  /** Drop a rejected token from memory and disk so the next run cannot replay it. */
  async clearToken() {
    this.token = '';
    this.auth.tokenPresent = false;
    try {
      await this.writeTokenFile('');
    } catch (error) {
      this.lastTokenError = error.message;
      this.setAuthState('error', 'token-clear-failed');
      this.emitAuthEvent('vts.auth.token', { ok: false, error: error.message, action: 'clear' });
      throw error;
    }
    this.emitAuthEvent('vts.auth.token', { ok: true, action: 'clear' });
  }

  /** Read-only auth projection for the Host: state/tokenPresent/pluginName/attempts/lastError. */
  status() {
    return {
      state: this.authState,
      tokenPresent: this.auth.tokenPresent === true,
      pluginName: this.plugin.pluginName,
      pluginDeveloper: this.plugin.pluginDeveloper,
      attempts: this.auth.attempts,
      lastError: this.lastError,
      reason: this.auth.reason,
      previous: this.auth.previous,
      changedAt: this.auth.changedAt,
      socketOpen: this.connected,
      authenticated: this.authenticated === true,
      ready: this.ready === true,
      grantInFlight: this.authPending === true,
      authAttempts: this.auth.authentications,
      retries: this.auth.retries,
      tokenError: this.lastTokenError,
      pluginChanged: this.auth.pluginChanged === true,
      pluginChangedAt: this.auth.pluginChangedAt,
      pluginPrevious: this.auth.pluginPrevious === null ? null : { ...this.auth.pluginPrevious },
      autoReconnectAllowed: this.autoReconnectAllowed(),
      reconnect: {
        attempts: this.reconnect.attempts,
        nextAt: this.reconnect.nextAt,
        lastDelayMs: this.reconnect.lastDelayMs,
        scheduled: this.reconnect.scheduled,
        fired: this.reconnect.fired,
        lastReason: this.reconnect.lastReason,
        delays: [...this.reconnect.delays],
      },
      transitions: this.auth.transitions.map((entry) => ({ ...entry })),
    };
  }

  /** Copy of the bounded auth event log (the same events `onAuthEvent` receives). */
  getAuthEvents() {
    return this.auth.events.map((entry) => ({ ...entry }));
  }

  /** requesting-grant / token-invalid must never be dialed automatically. */
  autoReconnectAllowed() {
    return !AUTH_QUIET_STATES.has(this.authState);
  }

  /**
   * Change the plugin identity. It is deliberately NOT a reason to clear the token or request a
   * new one: VTS decides whether the stored token still matches, and a name change is visible in
   * status() (`pluginChanged` / `pluginPrevious`) instead of silently triggering a popup.
   */
  setPluginIdentity({ pluginName = this.plugin.pluginName, pluginDeveloper = this.plugin.pluginDeveloper } = {}) {
    const next = { pluginName: String(pluginName), pluginDeveloper: String(pluginDeveloper) };
    const from = { ...this.plugin };
    if (next.pluginName === from.pluginName && next.pluginDeveloper === from.pluginDeveloper) {
      return { ok: true, changed: false, plugin: { ...this.plugin } };
    }
    this.plugin = next;
    this.auth.pluginChanged = true;
    this.auth.pluginChangedAt = Date.now();
    this.auth.pluginPrevious = from;
    this.auth.pluginHistory.push({ from, to: { ...next }, at: this.auth.pluginChangedAt });
    while (this.auth.pluginHistory.length > 8) this.auth.pluginHistory.shift();
    this.emitAuthEvent('vts.auth.identity', { ...next, previous: from });
    return { ok: true, changed: true, plugin: { ...next }, previous: from };
  }

  /** Exponential backoff, capped: attempt 1 = base, attempt 2 = 2×base, … */
  reconnectDelayMs(attempt) {
    const exponent = Math.max(0, Number(attempt) - 1);
    return Math.min(this.reconnectMaxMs, this.reconnectBaseMs * (2 ** exponent));
  }

  /** Schedule one backed-off reconnect. Never schedules while requesting-grant / token-invalid. */
  scheduleReconnect(reason = 'auth-failed') {
    if (this.autoReconnect !== true) return null;
    if (!this.autoReconnectAllowed()) return null;
    if (this.reconnect.timer !== null) return this.reconnect.timer;
    const attempt = this.reconnect.attempts + 1;
    const delay = this.reconnectDelayMs(attempt);
    this.reconnect.attempts = attempt;
    this.reconnect.lastDelayMs = delay;
    this.reconnect.nextAt = Date.now() + delay;
    this.reconnect.lastReason = String(reason);
    this.reconnect.scheduled += 1;
    this.reconnect.delays.push(delay);
    while (this.reconnect.delays.length > 8) this.reconnect.delays.shift();
    this.emitAuthEvent('vts.auth.reconnect', { reason: this.reconnect.lastReason, attempt, delayMs: delay });
    const timer = setTimeout(() => {
      this.reconnect.timer = null;
      this.reconnect.fired += 1;
      this.reconnect.nextAt = 0;
      void this.startConnect({ reason: 'auto-reconnect', auto: true }).catch(() => {});
    }, delay);
    timer.unref?.();
    this.reconnect.timer = timer;
    return timer;
  }

  clearReconnect(reason = '') {
    if (this.reconnect.timer !== null) {
      clearTimeout(this.reconnect.timer);
      this.reconnect.timer = null;
    }
    this.reconnect.nextAt = 0;
    if (reason.length > 0) this.reconnect.lastReason = String(reason);
  }

  resetReconnect() {
    this.clearReconnect();
    this.reconnect.attempts = 0;
    this.reconnect.lastDelayMs = 0;
    this.reconnect.delays = [];
  }

  readyResult() {
    return { ok: true, model: this.model, modelId: this.modelId, hotkeys: this.hotkeys.length, state: this.authState };
  }

  /**
   * Connect + authenticate + refresh. Concurrent callers share one promise. A stale gate state is
   * respected: normal connect() cannot leave requesting-grant / token-invalid (only retry() can),
   * which is what stops a repeated popup while the user has not answered or has denied.
   */
  connect() {
    return this.startConnect({ reason: 'connect' });
  }

  startConnect({ reason = 'connect', force = false, auto = false } = {}) {
    if (this.connectPromise !== null) return this.connectPromise;
    if (this.ready) return Promise.resolve(this.readyResult());
    if (!force) {
      if (this.authState === 'token-invalid') {
        return Promise.reject(this.authGateError(
          'TOKEN_INVALID',
          'VTS authorization is token-invalid; call retry() to ask VTS for a new grant',
        ));
      }
      if (this.authState === 'requesting-grant') {
        return Promise.reject(this.authGateError(
          'AWAITING_GRANT',
          'VTS authorization is waiting for the user; no new grant is requested while it waits',
        ));
      }
    }
    if (auto === true && !this.autoReconnectAllowed()) {
      return Promise.reject(this.authGateError(
        'AUTO_RECONNECT_BLOCKED',
        'automatic reconnect is disabled while authorization is waiting for the user',
      ));
    }
    this.clearReconnect(reason);
    const run = this.authenticate({ reason });
    const shared = run.finally(() => {
      this.connectPromise = null;
    });
    this.connectPromise = shared;
    return shared;
  }

  /**
   * Explicit user retry. The only path allowed to leave token-invalid, and the only path that emits
   * vts.auth.retry. It never races an in-flight connect (that promise is shared instead).
   */
  retry({ reason = 'user' } = {}) {
    const why = typeof reason === 'string' && reason.length > 0 ? reason : 'user';
    this.auth.retries += 1;
    this.emitAuthEvent('vts.auth.retry', { reason: why, from: this.authState, attempt: this.auth.attempts + 1 });
    if (this.connectPromise !== null) return this.connectPromise;
    if (this.ready) return Promise.resolve(this.readyResult());
    return this.startConnect({ reason: 'retry', force: true });
  }

  async authenticate({ reason = 'connect' } = {}) {
    const epoch = this.closeEpoch;
    this.authPending = true;
    this.authRenewed = false;
    this.lastError = '';
    this.setAuthState('connecting', reason);
    let socket = null;
    try {
      await this.loadToken();
      const hadToken = this.token.length > 0;
      // Dial first: a refusal to connect is a transport failure (error), not a grant wait. The
      // requesting-grant state is only entered once there is a socket that can carry the request.
      if (!this.connected) await this.openSocket();
      // The socket this connect started on. A reconnect replaces `this.socket`, so readiness stays
      // tied to this exact instance instead of "whatever socket happens to be current".
      socket = this.socket;

      if (!hadToken) {
        // No token is the first-install / corrupt-file / revoked-file path: ask once, then wait.
        this.setAuthState('requesting-grant', 'no-token');
        await this.requestGrant('no-token');
        // The grant arrived: authentication is now a normal connecting-step, so a socket failure
        // during it is error — only the popup wait itself is allowed to hold requesting-grant.
        this.setAuthState('connecting', 'grant-received');

        const first = await this.attemptAuth();
        if (first.ok !== true) {
          // A brand-new token refused by VTS is a failed authorization, not a user-revocable token:
          // keeping it out of token-invalid leaves an explicit connect() able to try again.
          this.auth.freshTokenRejected = true;
          this.setAuthState('error', 'token-rejected-fresh');
          throw this.authFailure(first, 'AUTH_FAILED', { authorizationRequested: true });
        }
      } else {
        let first;
        try {
          first = await this.attemptAuth();
        } catch (error) {
          // A timeout / socket failure is not evidence the token is invalid.
          throw this.authFailure(error, 'AUTH_FAILED', { authorizationRequested: false });
        }
        if (first.ok !== true) {
          // A token granted in this process that VTS already rejected must not trigger another
          // popup on every later connect: the user has to retry explicitly.
          if (this.auth.freshTokenRejected === true) {
            this.setAuthState('token-invalid', 'fresh-token-rejected');
            throw this.authFailure(first, 'AUTH_RETRY_FAILED', {
              previousReason: first.reason,
              authorizationRequested: false,
              renewal: false,
            });
          }
          // The one legitimate re-request: a stored token VTS says is invalid/revoked. The old
          // token is cleared before the popup so a denial cannot replay a token VTS already killed.
          this.setAuthState('requesting-grant', 'token-rejected');
          this.emitAuth('vts.auth.renew', { reason: first.reason });
          await this.clearToken();
          await this.requestGrant('token-rejected');
          this.setAuthState('connecting', 'grant-received');
          const retry = await this.attemptAuth();
          if (retry.ok !== true) {
            this.setAuthState('token-invalid', 'token-rejected');
            throw this.authFailure(retry, 'AUTH_RETRY_FAILED', {
              previousReason: first.reason,
              authorizationRequested: true,
              renewal: true,
            });
          }
          this.authRenewed = true;
          this.emitAuth('vts.auth.ok', { renewed: true });
        }
      }

      // Authentication succeeded: leave requesting-grant before refresh/subscription, so a socket
      // that dies during those steps is reported as a connection failure, not as a grant wait.
      this.setAuthState('connecting', 'authenticated-pending-ready');
      this.authenticated = true;
      await this.refresh();
      // A server-side rejection costs model-change push, not the connection. A subscription request
      // that dies with its socket is different: that is the connection failing, so connect() must
      // fail instead of promoting a dead socket to ready (the bug this guards against).
      const subscription = await this.subscribeEvents(socket);
      if (subscription.fatal === true) {
        throw new Error(`VTS connection lost during event subscription: ${subscription.error}`);
      }
      // Animation events are a second, optional subscription: a server-side rejection costs only
      // the animation timing (non-fatal), but losing the socket here is the same connection failure.
      if (this.animationEvents === true) {
        const animationSubscription = await this.subscribeAnimationEvents(socket);
        if (animationSubscription.fatal === true) {
          throw new Error(`VTS connection lost during animation event subscription: ${animationSubscription.error}`);
        }
      }
      // Never report ready unless the socket that authenticated is still the current one, open, and
      // authenticated. This also catches a disconnect that lands after the subscription answered.
      if (!this.isUsableSocket(socket)) {
        throw new Error('VTS connection closed before it became ready');
      }
      this.ready = true;
      // The active token is accepted: a previous "fresh token rejected" episode is over.
      this.auth.freshTokenRejected = false;
      this.setAuthState('ready', 'authenticated');
      this.resetReconnect();
      return this.readyResult();
    } catch (error) {
      // A close() during this connect owns the final state; a late failure must not overwrite it.
      if (epoch === this.closeEpoch) {
        this.lastError = error?.message ?? String(error);
        if (this.authState === 'requesting-grant') {
          // A slow popup is not a failure: keep the state quiet and the socket for an explicit retry.
        } else if (this.authState === 'token-invalid') {
          this.close({ keepAuthState: true });
        } else {
          if (this.authState !== 'error') this.setAuthState('error', 'auth-failed');
          this.close({ keepAuthState: true });
        }
        // A slow grant is recorded by vts.auth.timeout; it is not an auth failure event.
        if (error?.code !== 'AWAITING_GRANT') {
          this.emitAuth('vts.auth.failed', { code: error?.code ?? 'AUTH_FAILED' });
        }
        if (this.autoReconnect === true && this.autoReconnectAllowed() && this.authState === 'error'
          && error?.code !== 'AWAITING_GRANT' && error?.code !== 'TOKEN_WRITE_FAILED') {
          this.scheduleReconnect('auth-failed');
        }
      }
      throw error;
    } finally {
      this.authPending = false;
    }
  }

  /** One authorization request + persistence, with every outcome mapped to an honest state. */
  async requestToken(reason = 'grant') {
    const epoch = this.closeEpoch;
    this.setAuthState('requesting-grant', reason);
    const attempt = this.auth.attempts + 1;
    this.auth.attempts = attempt;
    this.emitAuthEvent('vts.auth.requested', { attempt });
    let response;
    try {
      response = await this.request('AuthenticationTokenRequest', { ...this.plugin }, this.grantTimeoutMs);
    } catch (cause) {
      if (epoch !== this.closeEpoch) {
        const error = new Error('VTube Studio authorization was cancelled by close()');
        error.code = 'AUTH_CANCELLED';
        error.cause = cause;
        throw error;
      }
      if (/timed out/iu.test(String(cause?.message ?? ''))) {
        const error = new Error(`VTube Studio authorization timed out after ${this.grantTimeoutMs}ms`);
        error.code = 'AWAITING_GRANT';
        error.cause = cause;
        this.lastError = error.message;
        // Timeout is an observation, not a reason to re-request: the state stays requesting-grant.
        this.emitAuthEvent('vts.auth.timeout', {
          attempt,
          state: this.authState,
          timeoutMs: this.grantTimeoutMs,
        });
        throw error;
      }
      const error = new Error(`VTube Studio authorization request failed: ${cause?.message ?? String(cause)}`);
      error.code = 'GRANT_SOCKET_LOST';
      error.cause = cause;
      this.setAuthState('error', 'grant-socket-lost');
      throw error;
    }
    let granted;
    try {
      granted = unwrap(response, 'AuthenticationTokenRequest');
    } catch (cause) {
      // VTS answered APIError, i.e. the user refused (or VTS denied) the grant.
      if (epoch !== this.closeEpoch) {
        const error = new Error('VTube Studio authorization was cancelled by close()');
        error.code = 'AUTH_CANCELLED';
        error.cause = cause;
        throw error;
      }
      const error = new Error(cause?.message ?? String(cause));
      error.code = 'TOKEN_INVALID';
      this.setAuthState('token-invalid', 'grant-denied');
      throw error;
    }
    const token = String(granted.authenticationToken ?? '');
    if (token.length === 0) {
      const error = new Error('VTube Studio did not grant a token (the plugin grant was refused)');
      error.code = 'TOKEN_INVALID';
      if (epoch === this.closeEpoch) this.setAuthState('token-invalid', 'grant-denied');
      throw error;
    }
    await this.saveToken(token);
    return token;
  }

  /** Wrap grant failures for connect() while keeping the state transitions intact. */
  async requestGrant(reason) {
    try {
      return await this.requestToken(reason);
    } catch (error) {
      if (error?.code === 'TOKEN_WRITE_FAILED' || error?.code === 'AWAITING_GRANT') throw error;
      throw this.authFailure(error, 'AUTH_TOKEN_FAILED', { authorizationRequested: true });
    }
  }

  /**
   * One AuthenticationRequest. Rejection is returned as data instead of thrown text so the caller
   * can tell an unusable token (APIError or authenticated:false) from a transport failure.
   */
  async attemptAuth() {
    this.auth.authentications += 1;
    const response = await this.request('AuthenticationRequest', {
      ...this.plugin,
      authenticationToken: this.token,
    }, 10_000);
    if (response?.messageType === 'APIError') {
      const data = response.data ?? {};
      return {
        ok: false,
        reason: String(data.message ?? data.errorMessage ?? `errorID ${data.errorID ?? 'unknown'}`),
        code: data.errorID ?? null,
      };
    }
    const data = response?.data ?? {};
    if (data.authenticated === true) return { ok: true, reason: '', code: null };
    return {
      ok: false,
      reason: String(data.reason ?? data.message ?? data.errorMessage ?? 'authenticated is not true'),
      code: data.errorID ?? null,
    };
  }

  /** One clear, coded error that also records whether the authorization popup was triggered. */
  authFailure(cause, errorCode, { previousReason = '', authorizationRequested = false, renewal = false } = {}) {
    const detail = typeof cause === 'string'
      ? cause
      : String(cause?.reason ?? cause?.message ?? 'unknown');
    const notes = [];
    if (previousReason.length > 0) notes.push(`previous token rejected: ${previousReason}`);
    notes.push(authorizationRequested
      ? 'VTS authorization was requested (AuthenticationTokenRequest)'
      : 'VTS authorization was not requested');
    if (renewal) notes.push('retry after re-authorization failed; no further retry');
    const error = new Error(`VTS auth failed: ${detail} [${errorCode}] (${notes.join('; ')})`);
    error.code = errorCode;
    if (cause?.code !== undefined && cause?.code !== null) error.vtsErrorID = cause.code;
    return error;
  }

  /** Observation events are observation only: a broken listener must never break the connection. */
  emitEvent(type, payload = {}) {
    try {
      this.onEvent?.(type, payload);
    } catch {
      /* the host must not be able to break the socket */
    }
  }

  emitAuth(type, payload = {}) {
    this.emitEvent(type, payload);
  }

  /**
   * Open a socket only when no earlier one can still be alive. A socket we no longer hold (one
   * whose close() was called while CLOSING, or a half-open one) still counts in VTS until its close
   * handshake finishes, so it is retired — close, wait, terminate — BEFORE this dial.
   */
  async openSocket() {
    const epoch = this.socketEpoch;
    const retired = await this.retireSockets();
    if (retired.had === true) {
      // Only a real replacement is recorded; an ordinary reconnect after a clean close is not.
      this.socketReconnects += 1;
      this.emitEvent('vts.socket.replaced', { previous: retired.previous, ms: retired.ms });
      this.emitEvent('vts.socket.stale-closed', { confirmed: retired.confirmed === true });
    }
    if (epoch !== this.socketEpoch) throw new Error('VTube Studio connect was cancelled by close()');
    const candidate = await new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${this.port}`);
      this.sockets.add(socket);
      // Bookkeeping only: this listener may fire long after the socket stopped being current.
      socket.on('close', () => this.sockets.delete(socket));
      const settle = (fn, value) => {
        socket.off('open', onOpen);
        socket.off('error', onError);
        socket.off('close', onClose);
        fn(value);
      };
      const onOpen = () => settle(resolve, socket);
      const onError = (error) => { this.sockets.delete(socket); settle(reject, error); };
      const onClose = () => {
        this.sockets.delete(socket);
        settle(reject, new Error('VTube Studio connection closed before it opened'));
      };
      socket.once('open', onOpen);
      socket.once('error', onError);
      socket.once('close', onClose);
    });
    if (epoch !== this.socketEpoch) {
      // close() ran while this candidate was still opening: it must never become the connection.
      await this.retireSockets();
      throw new Error('VTube Studio connect was cancelled by close()');
    }
    this.socket = candidate;
    this.attachSocket(candidate);
    return candidate;
  }

  /** Wire the state listeners for the socket that becomes current. */
  attachSocket(socket) {
    const handlers = {
      message: (raw) => this.handleMessage(raw),
      close: () => this.handleSocketClose(socket),
      error: (error) => { this.lastError = error?.message ?? String(error); },
    };
    this.socketHandlers.set(socket, handlers);
    socket.on('message', handlers.message);
    socket.on('close', handlers.close);
    socket.on('error', handlers.error);
  }

  /** Stop a retiring socket from mutating state; its late 'error' is absorbed, not left unhandled. */
  detachSocket(socket) {
    const handlers = this.socketHandlers.get(socket);
    this.socketHandlers.delete(socket);
    if (handlers === undefined) return;
    socket.off('message', handlers.message);
    socket.off('close', handlers.close);
    socket.off('error', handlers.error);
    socket.on('error', () => {});
  }

  /** The current socket went away. A replaced socket is ignored, so it cannot clear a newer one. */
  handleSocketClose(socket) {
    this.detachSocket(socket);
    this.sockets.delete(socket);
    if (this.socket !== socket) return;
    this.socket = null;
    this.authenticated = false;
    this.ready = false;
    this.eventsSubscribed = false;
    this.subscribedEvents = [];
    this.subscriptionError = '';
    this.subscriptionResponse = '';
    this.animationEventsSubscribed = false;
    this.animationSubscribedEvents = [];
    this.animationSubscriptionError = '';
    this.animationSubscriptionResponse = '';
    // No End event will arrive for an animation that was running when the socket died.
    this.resetAnimations('disconnected');
    // A reconnect gets a new socket: any frame still waiting belongs to the old one.
    this.frameEpoch += 1;
    this.failPending(new Error('VTube Studio connection closed'));

    // A socket lost while the user is deciding is NOT a reason to reconnect (that would reopen the
    // popup path). The quiet gate stays in place; only retry() may leave it.
    if (this.authState === 'requesting-grant' || this.authState === 'token-invalid') {
      this.setAuthState(this.authState, this.authState === 'requesting-grant'
        ? 'socket-lost-while-waiting'
        : 'socket-lost-after-invalid');
      return;
    }
    // `error` is already the honest state of a failed connection; a late close must not hide it.
    if (this.authState === 'disconnected' || this.authState === 'error') return;
    this.setAuthState('disconnected', 'socket-closed');
    if (this.autoReconnect === true && this.autoReconnectAllowed()) {
      this.scheduleReconnect('socket-closed');
    }
  }

  /**
   * Retire every socket this client still owns and report whether anything was actually replaced.
   * Concurrent callers (close() and the next connect()) share one retirement per socket, so a
   * socket is closed and terminated exactly once.
   */
  async retireSockets() {
    const stale = [...this.sockets];
    if (stale.length === 0) return { had: false, previous: '', ms: 0, confirmed: true };
    const previous = SOCKET_STATES[stale[0]?.readyState] ?? 'unknown';
    const startedAt = Date.now();
    let confirmed = true;
    for (const socket of stale) {
      if (this.socket === socket) this.socket = null;
      this.detachSocket(socket);
      if ((await this.retireSocket(socket)) !== true) confirmed = false;
    }
    return { had: true, previous, ms: Date.now() - startedAt, confirmed };
  }

  retireSocket(socket) {
    const running = this.socketRetiring.get(socket);
    if (running !== undefined) return running;
    const run = this.closeSocket(socket).finally(() => {
      this.socketRetiring.delete(socket);
    });
    this.socketRetiring.set(socket, run);
    return run;
  }

  /** Close, wait (bounded) for the peer's close handshake, then terminate whatever is left. */
  async closeSocket(socket) {
    if (socket.readyState === WebSocket.CLOSED) return true;
    const closed = this.waitForClose(socket, SOCKET_CLOSE_WAIT_MS);
    try {
      socket.close();
    } catch {
      /* already closing or closed */
    }
    if ((await closed) === true) return true;
    // A peer that never answers the close handshake leaves a TCP connection VTS still counts.
    try {
      socket.terminate?.();
    } catch {
      /* already gone */
    }
    return (await this.waitForClose(socket, SOCKET_TERMINATE_WAIT_MS)) === true;
  }

  /** Resolve true when the socket reports 'close' (or already has) inside `timeoutMs`. */
  waitForClose(socket, timeoutMs) {
    if (socket.readyState === WebSocket.CLOSED) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (closed) => {
        if (settled === true) return;
        settled = true;
        clearTimeout(timer);
        socket.off('close', onClose);
        resolve(closed);
      };
      const onClose = () => finish(true);
      const timer = setTimeout(() => finish(false), timeoutMs);
      timer.unref?.();
      socket.once('close', onClose);
    });
  }

  /** Reject every control request still waiting when the socket goes away. */
  failPending(error) {
    for (const [requestID, waiter] of this.pending) {
      this.pending.delete(requestID);
      waiter.reject(error);
    }
    for (const [requestID, frame] of this.frameAwait) {
      this.frameAwait.delete(requestID);
      this.settleFrame(frame, { ok: false, error: error?.message ?? String(error), sent: false });
    }
    this.frameLate.clear();
    this.dropPendingFrame('connection-closed');
  }

  handleMessage(raw) {
    let message;
    try {
      message = JSON.parse(String(raw));
    } catch {
      return;
    }
    const requestID = typeof message?.requestID === 'string' ? message.requestID : '';

    // Events carry no requestID. ModelLoadedEvent is the one that invalidates everything cached.
    if (message?.messageType === 'ModelLoadedEvent') {
      this.handleModelLoaded(message.data ?? {});
      return;
    }
    // ModelAnimationEvent carries Start/End (and, if not ignored, every Live2D item — never used).
    if (message?.messageType === 'ModelAnimationEvent') {
      this.handleModelAnimation(message.data ?? {});
      return;
    }
    if (requestID.length === 0) return;

    if (requestID.startsWith(FRAME_PREFIX)) {
      const frame = this.frameAwait.get(requestID);
      if (frame === undefined) {
        // The 400 ms window already settled this frame. A late APIError is still the only
        // evidence that the value was rejected, so record it instead of discarding the answer.
        const late = this.frameLate.get(requestID);
        if (late === undefined) return;
        this.frameLate.delete(requestID);
        if (message.messageType === 'APIError') {
          const error = errorText(message, late.messageType);
          this.lastFrameError = error;
          try {
            this.onFrameError?.(error, late);
          } catch {
            /* a broken hook must not break the socket */
          }
        }
        return;
      }
      this.frameAwait.delete(requestID);
      if (message.messageType === 'APIError') {
        const error = errorText(message, frame.messageType);
        this.lastFrameError = error;
        this.settleFrame(frame, { ok: false, error, sent: true, acknowledged: true });
        try {
          this.onFrameError?.(error, frame);
        } catch {
          /* a broken hook must not break the socket */
        }
        return;
      }
      this.settleFrame(frame, { ok: true, sent: true, acknowledged: true });
      return;
    }

    const waiter = this.pending.get(requestID);
    if (waiter !== undefined) {
      this.pending.delete(requestID);
      waiter.resolve(message);
    }
  }

  /**
   * The model changed under us: every discovered input, hotkey and expression belongs to the old
   * model. Drop the caches, kill any queued frame, and let the host re-discover.
   */
  handleModelLoaded(data) {
    // VTS sends no animation End event when the model is unloaded or replaced, so the animation
    // that was running is cleaned here — even when the model id did not change.
    this.resetAnimations('model-loaded');
    const event = data?.modelLoadedEvent ?? data ?? {};
    const loaded = event.modelLoaded ?? data.modelLoaded;
    const modelId = String(event.modelID ?? event.modelId ?? data.modelID ?? '');
    this.model = loaded === false
      ? null
      : {
          modelName: String(event.modelName ?? data.modelName ?? this.model?.modelName ?? ''),
          modelID: modelId,
          modelLoaded: loaded !== false,
        };
    const previous = this.modelId;
    const next = loaded === false ? '' : modelId;
    this.modelId = next;
    if (previous === next) return;
    this.injectable.clear();
    this.channelInputs = {};
    this.hotkeys = [];
    this.expressions = [];
    this.frameEpoch += 1;
    this.dropPendingFrame('model-changed');
    const info = { modelId: next, modelName: this.model?.modelName ?? '', previous };
    try {
      this.onModelChanged?.(info);
    } catch {
      /* the host must not be able to break the socket handler */
    }
    void this.refresh().catch(() => {});
  }

  /**
   * One ModelAnimationEvent. Only the four fields this client needs are read: the event may also
   * carry every Live2D item, which is deliberately ignored (and not requested) — those are the
   * model's own animation data, not something the Host can use.
   *
   * `animationLength` is seconds in the VTS protocol; 0 means "not reported", which leaves the
   * runtime on its bounded estimate instead of inventing a duration.
   */
  handleModelAnimation(data) {
    const event = data?.modelAnimationEvent ?? data ?? {};
    const name = String(event.animationName ?? '').trim();
    if (name.length === 0) return;
    const length = Number(event.animationLength);
    const durationMs = Number.isFinite(length) && length > 0 ? Math.round(length * 1000) : 0;
    const isIdle = event.isIdleAnimation === true;
    const kind = String(event.animationEventType ?? '').toLowerCase();
    if (kind === 'end') {
      const previous = this.animations.current;
      const matched = previous !== null && normalizeName(previous.name) === normalizeName(name);
      // An End for another animation must not clear the one currently believed to be running.
      if (matched) this.animations.current = null;
      this.animations.ends += 1;
      this.emitEvent('avatar.animation.end', {
        name,
        durationMs: durationMs > 0 ? durationMs : (matched ? previous.durationMs : 0),
        isIdle,
      });
      return;
    }
    if (kind !== 'start') return;

    const startedAt = Date.now();
    this.animations.starts += 1;
    // The live value is refreshed on EVERY Start, including a deduped idle loop: the runtime needs
    // the current loop's timing, only the log entry is deduplicated.
    this.animations.current = { name, durationMs, startedAt, isIdle };
    this.animations.lastStartAt = startedAt;
    const key = normalizeName(name);
    const last = this.animationStartAt.get(key) ?? 0;
    if (startedAt - last < ANIMATION_START_DEDUPE_MS) {
      this.animations.deduped += 1;
      return;
    }
    this.animationStartAt.set(key, startedAt);
    this.animations.records.push({ name, durationMs, startedAt, isIdle });
    while (this.animations.records.length > ANIMATION_RECORD_LIMIT) this.animations.records.shift();
    this.emitEvent('avatar.animation.start', { name, durationMs, isIdle });
  }

  /**
   * Clear the animation belief when no End event can be expected (model loaded, socket closed).
   * Always recorded with an explicit reason so a stale `current` is explainable after the fact.
   */
  resetAnimations(reason = 'disconnected') {
    this.animations.current = null;
    // A new connection/model is a new session: the first Start must be recorded again.
    this.animationStartAt.clear();
    this.animations.resets += 1;
    this.animations.lastReset = { reason: String(reason), at: Date.now() };
    this.emitEvent('avatar.animation.reset', { reason: String(reason) });
  }

  /** Serialize control requests and respect the empirical ~10 requests/s budget. */
  request(messageType, data = {}, timeoutMs = 10_000) {
    const run = async () => {
      if (!this.connected) throw new Error('VTube Studio is not connected');
      const gap = Date.now() - (this.lastSentAt ?? 0);
      if (gap < CONTROL_MIN_GAP_MS) await sleep(CONTROL_MIN_GAP_MS - gap);
      this.lastSentAt = Date.now();
      const requestID = `${REQUEST_PREFIX}${++this.seq}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(requestID);
          reject(new Error(`${messageType} timed out`));
        }, timeoutMs);
        this.pending.set(requestID, {
          resolve: (message) => {
            clearTimeout(timer);
            resolve(message);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        });
        try {
          this.socket.send(JSON.stringify({ apiName: API_NAME, apiVersion: API_VERSION, requestID, messageType, data }));
        } catch (error) {
          this.pending.delete(requestID);
          clearTimeout(timer);
          reject(error);
        }
      });
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => {});
    return result;
  }

  async refresh() {
    const current = unwrap(await this.request('CurrentModelRequest', {}), 'CurrentModelRequest');
    this.model = current ?? null;
    this.modelId = String(current?.modelID ?? current?.modelId ?? '');
    const keys = await this.request('HotkeysInCurrentModelRequest', {});
    this.hotkeys = keys.data?.availableHotkeys ?? [];
    const exprs = await this.request('ExpressionStateRequest', { details: true });
    this.expressions = exprs.data?.expressions ?? [];
    return { model: this.model, modelId: this.modelId, hotkeys: this.hotkeys, expressions: this.expressions };
  }

  /**
   * Real VTS pushes only the events the client subscribed to. Without this, handleModelLoaded()
   * is unreachable dead code and a model switch inside VTS leaves every cached capability stale.
   * Runs after authentication and after every reconnect.
   *
   * Two failures are deliberately not the same thing:
   *   - a server-side rejection (APIError, or a reply without ModelLoadedEvent) is non-fatal:
   *     the connection is still usable, so it is recorded in subscriptionError and returned;
   *   - losing the connection that carried the request (socket replaced, closed, or no longer
   *     authenticated) is a connection failure: the result carries `fatal:true` and the caller —
   *     connect() — must fail instead of reporting a ready client on a dead socket.
   *
   * `expectedSocket` is the socket the caller authenticated on. Only the connect path passes it;
   * direct callers (tests, re-subscription probes) keep the old "record and return" contract.
   *
   * The protocol distinguishes subscribe / unsubscribe with `subscribe: true`, so omitting it is a
   * silent unsubscribe. The confirmation is strict too: only an explicit ModelLoadedEvent in
   * `subscribedEvents` counts — a nonzero `subscribedEventCount` may describe other events.
   */
  async subscribeEvents(expectedSocket = null) {
    this.eventsSubscribed = false;
    this.subscribedEvents = [];
    this.subscriptionError = '';
    this.subscriptionResponse = '';
    const watchingConnection = expectedSocket !== null && expectedSocket !== undefined;
    if (watchingConnection && !this.isUsableSocket(expectedSocket)) {
      return this.failSubscriptionConnection('VTube Studio connection was not open and authenticated');
    }
    try {
      const response = await this.request(
        'EventSubscriptionRequest',
        { eventName: 'ModelLoadedEvent', subscribe: true, config: {} },
        10_000,
      );
      // The answer is only meaningful on the socket that asked. A disconnect during the request
      // already made this stale, so treat it as a lost connection rather than a confirmed state.
      if (watchingConnection && !this.isUsableSocket(expectedSocket)) {
        return this.failSubscriptionConnection('VTube Studio connection closed while subscribing to ModelLoadedEvent');
      }
      this.subscriptionResponse = truncateResponse(response);
      if (response?.messageType === 'APIError') {
        return this.recordSubscriptionFailure(errorText(response, 'EventSubscriptionRequest'));
      }
      const data = response?.data ?? {};
      const events = Array.isArray(data.subscribedEvents)
        ? data.subscribedEvents.map((entry) => String(entry))
        : [];
      this.subscribedEvents = events;
      if (!events.includes('ModelLoadedEvent')) {
        const reason = events.length === 0
          ? 'VTS did not confirm ModelLoadedEvent (subscribedEvents is empty)'
          : `VTS confirmed ${events.join(', ')} but not ModelLoadedEvent`;
        return this.recordSubscriptionFailure(reason);
      }
      this.lastEventError = '';
      this.eventsSubscribed = true;
      return { ok: true, events, error: '' };
    } catch (error) {
      const reason = error?.message ?? String(error);
      if (watchingConnection && !this.isUsableSocket(expectedSocket)) {
        return this.failSubscriptionConnection(reason);
      }
      return this.recordSubscriptionFailure(reason);
    }
  }

  /** A rejected subscription costs model-change push, not the connection: record it and return. */
  recordSubscriptionFailure(reason) {
    const text = String(reason ?? '');
    this.eventsSubscribed = false;
    this.subscriptionError = text;
    this.lastEventError = text;
    return { ok: false, events: [...this.subscribedEvents], error: text };
  }

  /**
   * The subscription request died with the connection it was sent on. This is NOT a rejected
   * subscription: `fatal` tells authenticate() to close the socket and fail the connect, so the
   * client can never report `ready:true` while `connected` is false.
   */
  failSubscriptionConnection(reason) {
    const text = String(reason ?? '');
    this.eventsSubscribed = false;
    this.subscribedEvents = [];
    this.subscriptionError = text;
    this.lastEventError = text;
    return { ok: false, fatal: true, events: [], error: text };
  }

  /**
   * Opt-in subscription to ModelAnimationEvent. Kept separate from subscribeEvents() on purpose:
   * `eventsSubscribed` / `subscribedEvents` keep meaning "ModelLoadedEvent", which the model-change
   * path and the status view already depend on. `ignoreLive2DItems` asks VTS not to send the
   * per-frame animation data; only Start/End timing is used here.
   */
  async subscribeAnimationEvents(expectedSocket = null) {
    this.animationEventsSubscribed = false;
    this.animationSubscribedEvents = [];
    this.animationSubscriptionError = '';
    this.animationSubscriptionResponse = '';
    const watchingConnection = expectedSocket !== null && expectedSocket !== undefined;
    if (watchingConnection && !this.isUsableSocket(expectedSocket)) {
      return this.failAnimationSubscriptionConnection('VTube Studio connection was not open and authenticated');
    }
    try {
      const response = await this.request(
        'EventSubscriptionRequest',
        { eventName: 'ModelAnimationEvent', subscribe: true, config: { ignoreLive2DItems: true } },
        10_000,
      );
      if (watchingConnection && !this.isUsableSocket(expectedSocket)) {
        return this.failAnimationSubscriptionConnection('VTube Studio connection closed while subscribing to ModelAnimationEvent');
      }
      this.animationSubscriptionResponse = truncateResponse(response);
      if (response?.messageType === 'APIError') {
        return this.recordAnimationSubscriptionFailure(errorText(response, 'EventSubscriptionRequest'));
      }
      const data = response?.data ?? {};
      const events = Array.isArray(data.subscribedEvents) ? data.subscribedEvents.map((entry) => String(entry)) : [];
      this.animationSubscribedEvents = events;
      if (!events.includes('ModelAnimationEvent')) {
        const reason = events.length === 0
          ? 'VTS did not confirm ModelAnimationEvent (subscribedEvents is empty)'
          : `VTS confirmed ${events.join(', ')} but not ModelAnimationEvent`;
        return this.recordAnimationSubscriptionFailure(reason);
      }
      this.animationEventsSubscribed = true;
      return { ok: true, events, error: '' };
    } catch (error) {
      const reason = error?.message ?? String(error);
      if (watchingConnection && !this.isUsableSocket(expectedSocket)) {
        return this.failAnimationSubscriptionConnection(reason);
      }
      return this.recordAnimationSubscriptionFailure(reason);
    }
  }

  /** A rejected animation subscription costs timing only: record it, keep the connection usable. */
  recordAnimationSubscriptionFailure(reason) {
    const text = String(reason ?? '');
    this.animationEventsSubscribed = false;
    this.animationSubscriptionError = text;
    return { ok: false, events: [...this.animationSubscribedEvents], error: text };
  }

  /** The animation subscription request died with its socket: connect() must fail, not fake ready. */
  failAnimationSubscriptionConnection(reason) {
    const text = String(reason ?? '');
    this.animationEventsSubscribed = false;
    this.animationSubscribedEvents = [];
    this.animationSubscriptionError = text;
    return { ok: false, fatal: true, events: [], error: text };
  }

  async triggerHotkey(nameOrId) {
    const needle = String(nameOrId ?? '').toLowerCase();
    const key =
      this.hotkeys.find((entry) => entry.hotkeyID === nameOrId) ??
      this.hotkeys.find((entry) => entry.name.toLowerCase() === needle) ??
      this.hotkeys.find((entry) => entry.name.toLowerCase().includes(needle));
    if (!key) throw new Error(`hotkey not found: ${nameOrId}`);
    await this.request('HotkeyTriggerRequest', { hotkeyID: key.hotkeyID });
    return key.name;
  }

  async triggerExpression(name) {
    const needle = String(name ?? '').toLowerCase();
    const expression =
      this.expressions.find((entry) => entry.name.toLowerCase() === needle) ??
      this.expressions.find((entry) => entry.name.toLowerCase().includes(needle));
    if (!expression) throw new Error(`expression not found: ${name}`);
    await this.request('ExpressionTriggerRequest', { name: expression.name });
    return expression.name;
  }

  // ---- real-time parameter frames ----------------------------------------
  /**
   * Queue one parameter frame. Newest wins: if a frame is still waiting for its turn, the previous
   * one is dropped instead of being sent late, so a slow socket can never build a playback queue.
   */
  queueFrame(messageType, data) {
    const frame = { requestID: `${FRAME_PREFIX}${++this.seq}`, messageType, data, epoch: this.frameEpoch };
    const outcome = new Promise((resolve) => {
      frame.settle = resolve;
    });
    const previous = this.pendingFrame;
    this.pendingFrame = frame;
    if (previous !== null) {
      this.noteFrameDrop('superseded');
      this.settleFrame(previous, { ok: true, superseded: true, sent: false });
    }
    void this.pumpFrames();
    return outcome;
  }

  settleFrame(frame, result) {
    if (frame.settled === true) return;
    frame.settled = true;
    frame.settle?.({ ...result });
  }

  /** Count one dropped frame and remember why (stale / superseded / disconnected / …). */
  noteFrameDrop(reason) {
    this.frameStats.dropped += 1;
    this.frameStats.lastDropReason = reason;
  }

  /** Single-flight sender for the frame slot; never runs two frames in parallel. */
  pumpFrames() {
    if (this.frameLoop !== null) return this.frameLoop;
    const loop = this.runFrameLoop();
    this.frameLoop = loop;
    // The loop can finish in the same tick it started, so the slot is released in a microtask and
    // a frame that arrived in that window gets its own turn instead of being stranded.
    void loop
      .catch(() => {})
      .then(() => {
        this.frameLoop = null;
        if (this.pendingFrame !== null) void this.pumpFrames();
      });
    return loop;
  }

  async runFrameLoop() {
    while (this.pendingFrame !== null) {
      const frame = this.pendingFrame;
      this.pendingFrame = null;
      if (frame.epoch !== this.frameEpoch) {
        // Queued against the previous model: its inputs are gone, so the value is meaningless.
        this.noteFrameDrop('stale');
        this.settleFrame(frame, { ok: false, error: 'frame dropped: model changed', sent: false });
        continue;
      }
      if (!this.connected) {
        this.noteFrameDrop('disconnected');
        this.settleFrame(frame, { ok: false, error: 'VTube Studio is not connected', sent: false });
        continue;
      }
      const gap = Date.now() - this.lastFrameAt;
      if (gap < MIN_FRAME_GAP_MS) await sleep(MIN_FRAME_GAP_MS - gap);
      // The model can switch during that wait (the event arrives on the same socket), so the epoch
      // must be re-checked here as well: sending now would push the old model's input one last time.
      if (frame.epoch !== this.frameEpoch) {
        this.noteFrameDrop('stale');
        this.settleFrame(frame, { ok: false, error: 'frame dropped: model changed', sent: false });
        continue;
      }
      // A fresher value arrived while we waited: sending the stale frame now would only add a
      // step nobody hears, so it is dropped and the loop takes the new one.
      if (this.pendingFrame !== null) {
        this.noteFrameDrop('superseded');
        this.settleFrame(frame, { ok: true, superseded: true, sent: false });
        continue;
      }
      if (!this.connected) {
        this.noteFrameDrop('disconnected');
        this.settleFrame(frame, { ok: false, error: 'VTube Studio is not connected', sent: false });
        continue;
      }
      try {
        this.socket.send(JSON.stringify({
          apiName: API_NAME,
          apiVersion: API_VERSION,
          requestID: frame.requestID,
          messageType: frame.messageType,
          data: frame.data,
        }));
      } catch (error) {
        this.settleFrame(frame, { ok: false, error: error?.message ?? String(error), sent: false });
        continue;
      }
      this.lastFrameAt = Date.now();
      this.frameStats.sent += 1;
      this.frameStats.lastSentAt = this.lastFrameAt;
      this.frameSentAt.push(this.lastFrameAt);
      if (this.frameSentAt.length > FRAME_RATE_WINDOW) this.frameSentAt.shift();
      this.frameAwait.set(frame.requestID, frame);
      // VTS answers every request, but a frame must never hold a slot open waiting for it. A
      // missing answer is not evidence of success: `ok` means "sent", `acknowledged` is separate.
      const timer = setTimeout(() => {
        if (this.frameAwait.get(frame.requestID) !== frame) return;
        this.frameAwait.delete(frame.requestID);
        this.frameLate.set(frame.requestID, frame);
        while (this.frameLate.size > FRAME_LATE_SLOTS) {
          const oldest = this.frameLate.keys().next().value;
          this.frameLate.delete(oldest);
        }
        this.settleFrame(frame, { ok: true, sent: true, acknowledged: false });
      }, FRAME_REPLY_TIMEOUT_MS);
      timer.unref?.();
    }
  }

  /** Forget the frame that never left: used when the model or the token changed under it. */
  dropPendingFrame(reason = 'dropped') {
    const frame = this.pendingFrame;
    if (frame === null) return false;
    this.pendingFrame = null;
    this.noteFrameDrop(reason);
    this.settleFrame(frame, { ok: false, error: `frame dropped: ${reason}`, sent: false });
    return true;
  }

  getTransportStats() {
    const times = this.frameSentAt;
    let computedHz = 0;
    if (times.length >= 2) {
      const span = times[times.length - 1] - times[0];
      if (span > 0) computedHz = Math.round((((times.length - 1) * 1000) / span) * 10) / 10;
    }
    return {
      sent: this.frameStats.sent,
      dropped: this.frameStats.dropped,
      lastSentAt: this.frameStats.lastSentAt,
      lastDropReason: this.frameStats.lastDropReason ?? '',
      computedHz,
      /** Actual socket replacements and how many sockets this client still owns (status evidence). */
      socketReconnects: this.socketReconnects,
      liveSockets: this.sockets.size,
    };
  }

  // ---- capability-driven injection ---------------------------------------

  /**
   * What InjectParameterDataRequest can actually address: VTS *tracking input* parameters
   * (FaceAngleX, MouthOpen, …) and user-defined custom inputs. Model parameters such as
   * ParamAngleX are not injectable, so any control must start from this list.
   * Throws when VTS rejects the request or returns nothing.
   */
  async listInputParameters() {
    const data = unwrap(await this.request('InputParameterListRequest', {}), 'InputParameterListRequest');
    const collect = (list, source) =>
      (Array.isArray(list) ? list : [])
        .map((entry) => ({
          name: String(entry?.name ?? ''),
          min: Number(entry?.min ?? 0),
          max: Number(entry?.max ?? 1),
          defaultValue: Number(entry?.defaultValue ?? 0),
          source,
        }))
        .filter((entry) => entry.name.length > 0);
    const result = {
      defaultParameters: collect(data.defaultParameters, 'default'),
      customParameters: collect(data.customParameters, 'custom'),
    };
    this.injectable.clear();
    for (const entry of [...result.defaultParameters, ...result.customParameters]) {
      const key = normalizeName(entry.name);
      if (!this.injectable.has(key)) this.injectable.set(key, entry);
    }
    if (result.defaultParameters.length === 0 && result.customParameters.length === 0) {
      throw new Error('VTS returned no injectable input parameters');
    }
    return result;
  }

  /** Adopt the channel → input names from capability discovery (used by setMouth and, later, motion). */
  setChannelInputs(inputs) {
    const next = {};
    for (const [channel, entry] of Object.entries(inputs ?? {})) {
      const name = typeof entry === 'string' ? entry : String(entry?.inputName ?? '');
      if (name.length > 0) next[channel] = name;
    }
    this.channelInputs = next;
    return next;
  }

  /**
   * The injectable input list is fetched once and shared: a burst of injectInputs() calls must not
   * turn into a queue of identical InputParameterListRequests (the control path is serialized).
   */
  ensureInputIndex() {
    if (this.injectable.size > 0) return Promise.resolve(this.injectable);
    if (this.inputIndexPromise === null) {
      this.inputIndexPromise = this.listInputParameters().finally(() => {
        this.inputIndexPromise = null;
      });
    }
    return this.inputIndexPromise.then(() => this.injectable);
  }

  /**
   * The one way values reach VTS. Every entry is checked against the current capability list
   * before anything is sent: a name VTS did not advertise is rejected with a reason instead of
   * being sent hopefully. The frame itself is fire-and-forget on the transport, but VTS's answer
   * is still inspected (APIError → `ok:false`), so a broken mapping is visible.
   *
   * @param {{name: string, value: number, weight?: number}[]} entries
   * @param {{faceFound?: boolean}} [options] per-frame override of the avatar.faceFound setting
   * @returns {Promise<{ok: boolean, error: string, rejected: string[], sent: boolean, superseded: boolean}>}
   */
  async injectInputs(entries, options = {}) {
    const list = (Array.isArray(entries) ? entries : [entries])
      .map((entry) => ({
        name: String(entry?.name ?? ''),
        value: Number(entry?.value),
        weight: entry?.weight === undefined || entry?.weight === null ? null : Number(entry.weight),
      }))
      .filter((entry) => entry.name.length > 0 && Number.isFinite(entry.value));
    if (list.length === 0) {
      return { ok: false, error: '没有可注入的输入（需要 name 与数值 value）', rejected: [], sent: false, superseded: false };
    }

    let index;
    try {
      index = await this.ensureInputIndex();
    } catch (error) {
      return {
        ok: false,
        error: `无法读取可注入输入列表：${error?.message ?? String(error)}`,
        rejected: list.map((entry) => entry.name),
        sent: false,
        superseded: false,
      };
    }

    const rejected = [];
    const values = [];
    for (const entry of list) {
      const hit = index.get(normalizeName(entry.name));
      if (hit === undefined) {
        rejected.push(entry.name);
        continue;
      }
      const min = Number.isFinite(hit.min) ? hit.min : 0;
      const max = Number.isFinite(hit.max) ? hit.max : 1;
      const value = {
        id: hit.name,
        value: Math.min(max, Math.max(min, entry.value)),
      };
      if (entry.weight !== null && Number.isFinite(entry.weight)) {
        value.weight = Math.max(0, Math.min(1, entry.weight));
      }
      values.push(value);
    }
    if (values.length === 0) {
      return { ok: false, error: `输入不在可注入列表：${rejected.join('、')}`, rejected, sent: false, superseded: false };
    }

    const frameData = { parameterValues: values, mode: 'set' };
    // OFF by default: the request shape stays exactly as before unless the setting (or a per-call
    // override) turns it on. It is never enabled implicitly or globally.
    const faceFound = options?.faceFound === true
      ? true
      : options?.faceFound === false ? false : this.faceFoundEnabled();
    if (faceFound === true) {
      frameData.faceFound = true;
      this.noteFaceFoundEnabled();
    }
    const outcome = await this.queueFrame('InjectParameterDataRequest', frameData);
    this.inject.requests += 1;
    if (faceFound === true) this.inject.faceFoundRequests += 1;
    return {
      ok: outcome.ok !== false,
      error: outcome.error ?? '',
      rejected,
      sent: outcome.sent === true,
      superseded: outcome.superseded === true,
      acknowledged: outcome.acknowledged === true,
    };
  }

  /**
   * The `avatar.faceFound` setting, read live when the host passed a function. Kept in `inject`
   * so the status view can show what the next frame will send.
   */
  faceFoundEnabled() {
    if (this.faceFoundProvider !== null) {
      try {
        this.faceFound = this.faceFoundProvider() === true;
      } catch {
        /* a broken setting reader keeps the previous value */
      }
    }
    const enabled = this.faceFound === true;
    this.inject.faceFound = enabled;
    if (enabled !== true) this.inject.faceFoundLogged = false;
    return enabled;
  }

  /** Turn the controlled faceFound flag on/off (host setting path). False is the default. */
  setFaceFound(enabled) {
    this.faceFound = enabled === true;
    this.inject.faceFound = this.faceFound;
    if (this.faceFound === true) this.noteFaceFoundEnabled();
    else this.inject.faceFoundLogged = false;
    return { ok: true, faceFound: this.faceFound };
  }

  /** One `avatar.inject.faceFound` record per on-period, not one per 30 Hz frame. */
  noteFaceFoundEnabled() {
    this.inject.lastFaceFoundAt = Date.now();
    if (this.inject.faceFoundLogged === true) return;
    this.inject.faceFoundLogged = true;
    this.emitEvent('avatar.inject.faceFound', { enabled: true });
  }

  /** Read-only snapshot of the injection state (`inject.faceFound` lives here too). */
  getInjectionState() {
    return { ...this.inject };
  }

  /** Read-only snapshot of the animation state, with a copied `current`. */
  getAnimationState() {
    return {
      ...this.animations,
      current: this.animations.current === null ? null : { ...this.animations.current },
      records: this.animations.records.map((entry) => ({ ...entry })),
      subscribed: this.animationEventsSubscribed,
      subscriptionError: this.animationSubscriptionError,
      subscribedEvents: [...this.animationSubscribedEvents],
    };
  }

  /**
   * Mouth/lip-sync value in 0..1, sent through the discovered `mouth` input. There is no guessed
   * fallback: without a mapped channel nothing is sent, and the caller is told why.
   */
  async setMouth(value) {
    const v = Math.max(0, Math.min(1, Number(value) || 0));
    const name = String(this.channelInputs.mouth ?? '');
    if (name.length === 0) {
      return {
        ok: false,
        error: 'mouth channel not mapped',
        rejected: [],
        sent: false,
        superseded: false,
        acknowledged: false,
        input: '',
        fallback: true,
      };
    }
    const result = await this.injectInputs([{ name, value: v }]);
    return { ...result, input: name, fallback: false };
  }

  /**
   * The current model's Live2D parameters. Informational only: whether an input drives them is
   * decided by the user's parameter mapping inside VTS, not by the API.
   * Never throws — the caller treats a failure as "not adapted".
   */
  async listModelParameters({ names = [] } = {}) {
    let firstError = '';
    try {
      const data = unwrap(await this.request('Live2DParameterListRequest', {}), 'Live2DParameterListRequest');
      const parameters = collectModelParameters(
        data.live2DModelParameters ?? data.live2DParameters ?? data.parameters,
      );
      if (parameters.length > 0) {
        return { ok: true, source: 'Live2DParameterListRequest', parameters, error: '' };
      }
      firstError = 'Live2DParameterListRequest returned no parameters';
    } catch (error) {
      firstError = error?.message ?? String(error);
    }
    // Older VTS builds: ask for the values of the parameters we already know about.
    const probe = (Array.isArray(names) && names.length > 0 ? names : KNOWN_MODEL_PARAMETERS)
      .filter((name) => typeof name === 'string' && name.length > 0);
    try {
      const data = unwrap(
        await this.request('GetParameterValues', { parameterNames: probe }),
        'GetParameterValues',
      );
      const parameters = collectModelParameters(
        data.parameterValues ?? data.parameters ?? data.live2DModelParameters,
      );
      if (parameters.length > 0) {
        return { ok: true, source: 'GetParameterValues', parameters, error: '' };
      }
      return {
        ok: false,
        source: '',
        parameters: [],
        error: firstError || 'GetParameterValues returned no parameters',
      };
    } catch (error) {
      return {
        ok: false,
        source: '',
        parameters: [],
        error: firstError || (error?.message ?? String(error)),
      };
    }
  }

  async moveModel({ x, y, rotation, size }) {
    const data = {};
    if (typeof x === 'number') data.positionX = x;
    if (typeof y === 'number') data.positionY = y;
    if (typeof rotation === 'number') data.rotation = rotation;
    if (typeof size === 'number') data.size = size;
    await this.request('MoveModelRequest', data);
  }

  /**
   * Drop the socket and every per-connection cache. A deliberate close returns the machine to
   * disconnected so the next explicit connect() starts clean; `keepAuthState` is used by the auth
   * failure paths, where the failure state (error / token-invalid / requesting-grant) must survive
   * the socket teardown.
   */
  close({ keepAuthState = false } = {}) {
    // Bumped first: a connect() whose socket is still opening must not adopt it after this close.
    this.socketEpoch += 1;
    this.closeEpoch += 1;
    this.authenticated = false;
    this.ready = false;
    this.eventsSubscribed = false;
    this.subscribedEvents = [];
    this.subscriptionError = '';
    this.subscriptionResponse = '';
    this.animationEventsSubscribed = false;
    this.animationSubscribedEvents = [];
    this.animationSubscriptionError = '';
    this.animationSubscriptionResponse = '';
    // The socket is closed before its own 'close' handler can record this, so clean up here too.
    if (this.animations.current !== null) this.resetAnimations('disconnected');
    else this.animationStartAt.clear();
    // Frames queued before the close must never wake up and reach a later connection.
    this.frameEpoch += 1;
    this.failPending(new Error('VTube Studio connection closed'));
    this.clearReconnect('closed');
    if (keepAuthState !== true) this.setAuthState('disconnected', 'closed');
    const socket = this.socket;
    this.socket = null;
    if (socket !== null) {
      // Detach before closing: a late message from this socket must not reach a later connection.
      this.detachSocket(socket);
      this.sockets.add(socket);
    }
    // Retire in the background; the next connect() awaits the same retirement before it dials.
    void this.retireSockets().catch(() => {});
  }
}
